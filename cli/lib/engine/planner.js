'use strict';

/**
 * Deterministic sync planner + validators.
 *
 * Modes:
 *   - table  (default): rows keyed by a unique key column → docId = key value.
 *   - mirror ("Raw Mirror"): any sheet, no key needed → docId = durable row id
 *     (_sheetSyncId). For messy sheets where no column is a safe key.
 *
 * Per-row diff: a row only produces a write op if it is new or its managed
 * fields actually changed vs Firestore — unchanged rows are counted, not
 * rewritten. Deletes are only ever *planned* here (as delete ops) when the
 * connection has allowDeletes=true; execution still requires typed
 * confirmation at apply time. Default stays flag-only.
 *
 * AI (analyzer/Gemini) only ever PROPOSES config; this planner and its
 * validators are the sole gate before writes.
 */

const BLANK = (v) => v === null || v === undefined || String(v).trim() === '';

function inferType(existingValues) {
  const nonBlank = existingValues.filter((v) => v !== null && v !== undefined && v !== '');
  if (nonBlank.length === 0) return 'unknown';
  if (nonBlank.every((v) => typeof v === 'number')) return 'number';
  if (nonBlank.every((v) => typeof v === 'boolean')) return 'boolean';
  return 'string';
}

function coerce(raw, type) {
  if (BLANK(raw)) return { ok: true, value: null };
  if (type === 'number') {
    const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/,/g, ''));
    if (Number.isFinite(n)) return { ok: true, value: n };
    return { ok: false, error: `expected number, got "${raw}"` };
  }
  if (type === 'boolean') {
    if (typeof raw === 'boolean') return { ok: true, value: raw };
    const s = String(raw).trim().toLowerCase();
    if (s === 'true' || s === 'yes') return { ok: true, value: true };
    if (s === 'false' || s === 'no') return { ok: true, value: false };
    return { ok: false, error: `expected boolean, got "${raw}"` };
  }
  return { ok: true, value: typeof raw === 'string' ? raw : raw };
}

const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** True if the fields we would write are all already present and equal in the existing doc. */
function unchangedVsExisting(fields, existing) {
  if (!existing) return false;
  return Object.keys(fields).every((k) => deepEqual(existing[k], fields[k]));
}

/** Resolve a sheet header to its target field via the (optional) field map. */
function resolveField(header, fieldMap) {
  if (fieldMap && fieldMap[header]) {
    const m = fieldMap[header];
    return { field: m.field || header, excluded: Boolean(m.excluded) };
  }
  return { field: header, excluded: false }; // no map → 1:1 (backward compatible)
}

/** Set a possibly-dotted path ("price.amount") into an object, creating nesting. */
function setPath(obj, path, value) {
  const parts = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}
const topKey = (field) => String(field).split('.')[0];

function targetGuards(config, allowedCollections) {
  if (config.targetCollection.startsWith('_sheetSync') || config.targetCollection.startsWith('_sheetMirror')) {
    return `target collection may not be inside a reserved namespace`;
  }
  if (allowedCollections.length > 0 && !allowedCollections.includes(config.targetCollection)) {
    return `target collection "${config.targetCollection}" is not in the allowlist`;
  }
  return null;
}

/**
 * @param {object} args
 * @param {object} args.config {mode, targetCollection, keyColumn, allowBlankOverwrite, allowDeletes}
 * @param {object} args.snapshot {headers, rows:[{sid, values}]}
 * @param {Map<string,object>} args.existingByDocId existing Firestore docs keyed by docId
 * @param {Set<string>} args.knownSids sids present in the last applied snapshot
 * @param {string[]} args.allowedCollections optional allowlist
 */
function buildPlan({ config, snapshot, existingByDocId, knownSids, allowedCollections }) {
  const mode = config.mode || 'table';
  const errors = [];
  const ops = [];
  let unchanged = 0;

  const fatal = targetGuards(config, allowedCollections);
  if (fatal) return { fatal, ops: [], errors: [], possiblyDeleted: [], unchanged: 0 };
  if (mode === 'table' && !snapshot.headers.includes(config.keyColumn)) {
    return { fatal: `key column "${config.keyColumn}" not found in sheet headers`, ops: [], errors: [], possiblyDeleted: [], unchanged: 0 };
  }

  // Resolve each header → target field (rename / exclude / nest) via the map.
  const fieldMap = config.fieldMap || null;
  const resolved = {};
  for (const header of snapshot.headers) resolved[header] = resolveField(header, fieldMap);

  // Infer a type per column from existing Firestore data at the MAPPED field.
  const fieldTypes = {};
  for (const header of snapshot.headers) {
    if (resolved[header].excluded) continue;
    const tk = topKey(resolved[header].field);
    fieldTypes[header] = inferType([...existingByDocId.values()].map((d) => d && d[tk]));
  }

  // sid → docId map, so delete planning can resolve removed rows to their docs.
  const sidToDocId = new Map();
  const seenKeys = new Map();

  for (const row of snapshot.rows) {
    let docId;
    if (mode === 'mirror') {
      docId = row.sid; // durable row id; no key column needed
    } else {
      const key = row.values[config.keyColumn];
      if (BLANK(key)) { errors.push({ sid: row.sid, error: 'blank key column value' }); continue; }
      docId = String(key);
      if (seenKeys.has(docId)) {
        errors.push({ sid: row.sid, error: `duplicate key "${docId}" (also on row ${seenKeys.get(docId)})` });
        continue;
      }
      seenKeys.set(docId, row.sid);
    }

    const existing = existingByDocId.get(docId);
    const fields = {};
    const rowErrors = [];
    const blockedFields = [];

    for (const header of snapshot.headers) {
      const { field, excluded } = resolved[header];
      if (excluded || header === '_sheetSyncId') continue; // dropped columns / internal id
      const typed = coerce(row.values[header], fieldTypes[header]);
      if (!typed.ok) { rowErrors.push(`${header}: ${typed.error}`); continue; }
      if (typed.value === null) {
        if (existing && !BLANK(existing[topKey(field)]) && !config.allowBlankOverwrite) blockedFields.push(field);
        continue; // blanks never written
      }
      setPath(fields, field, typed.value); // rename + nest via dotted field name
    }

    if (rowErrors.length > 0) { errors.push({ sid: row.sid, error: rowErrors.join('; ') }); continue; }
    sidToDocId.set(row.sid, docId);

    // Per-row diff: unchanged existing rows are skipped (unless a blank was blocked,
    // which we still surface). New rows and changed rows produce ops.
    if (existing && blockedFields.length === 0 && unchangedVsExisting(fields, existing)) {
      unchanged++;
      continue;
    }
    ops.push({ sid: row.sid, docId, action: existing ? 'update' : 'create', fields, blockedFields });
  }

  // Delete planning: rows present last time but gone now.
  const currentSids = new Set(snapshot.rows.map((r) => r.sid));
  const possiblyDeleted = [...knownSids].filter((sid) => !currentSids.has(sid));
  if (config.allowDeletes) {
    for (const sid of possiblyDeleted) {
      // In mirror mode the docId is the sid; in table mode we only know the doc
      // if it still resolves — the extension passes a sid→docId map from the
      // last apply via knownSidDocIds.
      const docId = mode === 'mirror' ? sid : (config.knownSidDocIds && config.knownSidDocIds[sid]);
      if (docId) ops.push({ sid, docId, action: 'delete' });
    }
  }

  return { fatal: null, ops, errors, possiblyDeleted, unchanged, sidToDocId: Object.fromEntries(sidToDocId) };
}

function summarize(plan) {
  return {
    creates: plan.ops.filter((o) => o.action === 'create').length,
    updates: plan.ops.filter((o) => o.action === 'update').length,
    deletes: plan.ops.filter((o) => o.action === 'delete').length,
    unchanged: plan.unchanged || 0,
    blockedRows: plan.errors.length,
    blankOverwritesBlocked: plan.ops.reduce((n, o) => n + (o.blockedFields ? o.blockedFields.length : 0), 0),
    possiblyDeleted: plan.possiblyDeleted.length,
    deletesPlanned: plan.ops.filter((o) => o.action === 'delete').length,
  };
}

module.exports = { buildPlan, summarize };
