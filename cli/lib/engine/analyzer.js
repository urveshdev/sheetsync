'use strict';

/**
 * Deterministic sheet analyzer — the "Analyze" behind one-click setup.
 *
 * Given a snapshot and the project's existing Firestore state, proposes the
 * full sync config (target collection + key column) with a confidence score
 * and human-readable reasons. The user's job collapses to reviewing one
 * proposal and clicking Confirm.
 *
 * Gemini slots in behind this SAME interface later for messy sheets
 * (title rows, merged headers, ambiguous matches): it may replace the
 * proposal, but proposals — from heuristics or AI — only ever reach the
 * database through the deterministic planner/validators.
 */

const BLANK = (v) => v === null || v === undefined || String(v).trim() === '';

const KEY_NAME_HINTS = /^(sku|id|uid|key|code|slug|ref|email|.*[_-]id)$/i;

const normalizeName = (s) => String(s).trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
function toCamel(s) {
  const parts = String(s).trim().toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (!parts.length) return 'field';
  return parts.map((p, i) => (i === 0 ? p : p[0].toUpperCase() + p.slice(1))).join('');
}

/**
 * Deterministic column→field mapping. Matches each sheet header to a field that
 * already exists in the target collection (exact-normalized, then fuzzy token
 * containment); unmatched columns get a clean camelCase field name and are
 * flagged so the AI step (if enabled) or the user can refine them.
 * @returns {{map: object, unmatched: string[]}}
 */
function proposeFieldMap(headers, existingFieldNames) {
  const existNorm = new Map();
  for (const f of existingFieldNames) if (f && f !== '_sheetSync') existNorm.set(normalizeName(f), f);
  const map = {};
  const unmatched = [];
  for (const h of headers) {
    if (h === '_sheetSyncId') continue;
    const n = normalizeName(h);
    if (existNorm.has(n)) { map[h] = { field: existNorm.get(n), excluded: false, source: 'matched' }; continue; }
    let hit = null;
    for (const [en, orig] of existNorm) {
      if (en.length >= 3 && (n.includes(en) || en.includes(n))) { hit = orig; break; }
    }
    if (hit) map[h] = { field: hit, excluded: false, source: 'matched' };
    else { map[h] = { field: toCamel(h), excluded: false, source: 'normalized' }; unmatched.push(h); }
  }
  return { map, unmatched };
}

/** Score every column as a candidate primary key. */
function scoreKeyColumns(headers, rows) {
  return headers.map((header) => {
    const values = rows.map((r) => r.values[header]);
    const nonBlank = values.filter((v) => !BLANK(v));
    const unique = new Set(nonBlank.map(String));
    const uniqueness = nonBlank.length ? unique.size / nonBlank.length : 0;
    const coverage = values.length ? nonBlank.length / values.length : 0;
    const nameHint = KEY_NAME_HINTS.test(header.trim()) ? 1 : 0;
    return {
      header,
      uniqueness,
      coverage,
      nameHint,
      score: uniqueness * 0.55 + coverage * 0.25 + nameHint * 0.2,
      viable: uniqueness === 1 && coverage === 1, // planner will block anything less anyway
    };
  }).sort((a, b) => b.score - a.score);
}

/** Compare sheet headers against a sample of an existing collection's fields. */
function fieldOverlap(headers, sampleDocs) {
  if (sampleDocs.length === 0) return 0;
  const fields = new Set();
  for (const d of sampleDocs) Object.keys(d).filter((k) => k !== '_sheetSync').forEach((k) => fields.add(k));
  if (fields.size === 0) return 0;
  const hits = headers.filter((h) => fields.has(h)).length;
  return hits / headers.length;
}

/**
 * @param {object} snapshot {tabName, headers, rows}
 * @param {Array<{name: string, sampleDocs: object[], docIds: string[]}>} collections existing state
 * @param {string[]} allowedCollections optional allowlist ([] = all)
 */
function analyze(snapshot, collections, allowedCollections = []) {
  const reasons = [];
  const { headers, rows, tabName } = snapshot;

  // --- key column ---
  const keyScores = scoreKeyColumns(headers, rows);
  const viableKeys = keyScores.filter((k) => k.viable);
  const keyColumn = (viableKeys[0] || keyScores[0] || { header: null }).header;
  const keyViable = viableKeys.length > 0;
  if (keyViable) {
    reasons.push(`key column "${keyColumn}": every row has a unique, non-blank value` +
      (keyScores[0].nameHint ? ' and the name looks like an identifier' : ''));
  } else {
    reasons.push(`no column is fully unique and non-blank; best candidate "${keyColumn}" would leave some rows blocked`);
  }

  // --- target collection ---
  const candidates = collections
    .filter((c) => !c.name.startsWith('_sheetSync'))
    .filter((c) => allowedCollections.length === 0 || allowedCollections.includes(c.name))
    .map((c) => {
      const overlap = fieldOverlap(headers, c.sampleDocs);
      const keyValues = rows.map((r) => String(r.values[keyColumn] ?? ''));
      const idSet = new Set(c.docIds);
      const idMatches = keyValues.filter((v) => idSet.has(v)).length;
      const idMatchRatio = keyValues.length ? idMatches / keyValues.length : 0;
      return { name: c.name, overlap, idMatchRatio, score: overlap * 0.6 + idMatchRatio * 0.4 };
    })
    .sort((a, b) => b.score - a.score);

  let targetCollection;
  let matchedExisting = false;
  const best = candidates[0];
  const runnerUp = candidates[1];

  if (best && best.overlap >= 0.5) {
    targetCollection = best.name;
    matchedExisting = true;
    reasons.push(`existing collection "/${best.name}" matches: ${Math.round(best.overlap * 100)}% of sheet columns are fields there` +
      (best.idMatchRatio > 0 ? `, and ${Math.round(best.idMatchRatio * 100)}% of key values match existing document IDs` : ''));
  } else {
    targetCollection = tabName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'sheet_data';
    reasons.push(`no existing collection matches this sheet; proposing new collection "/${targetCollection}" from the tab name "${tabName}"`);
  }

  // Ambiguity: two existing collections both plausibly match → user must choose.
  const ambiguous = Boolean(matchedExisting && runnerUp && runnerUp.overlap >= 0.5 && (best.score - runnerUp.score) < 0.15);
  if (ambiguous) reasons.push(`"/${runnerUp.name}" also matches — pick the right target`);

  // --- mode: fall back to Raw Mirror when no column is a safe key ---
  // Instead of blocking a messy sheet, propose mirror mode (durable row id as
  // docId) so ANY sheet can sync safely. Table mode stays the default when a
  // real key exists.
  const mode = keyViable ? 'table' : 'mirror';
  if (mode === 'mirror') {
    reasons.push('no column is a safe unique key → proposing Raw Mirror mode (each row mirrored by its durable row id); switch to table mode if you pick a key');
  }

  // --- confidence (drives auto-confirm vs review, per the brief's risk scoring) ---
  let confidence;
  if (mode === 'mirror') confidence = matchedExisting ? 'medium' : 'high'; // mirror is always safe to auto-apply on a NEW collection
  else if (keyViable && !ambiguous && (matchedExisting ? best.overlap >= 0.75 : true)) confidence = 'high';
  else if (keyViable || matchedExisting) confidence = 'medium';
  else confidence = 'low';

  // Column→field mapping against the chosen collection's existing fields.
  const chosen = collections.find((c) => c.name === targetCollection);
  const existingFields = chosen
    ? [...new Set(chosen.sampleDocs.flatMap((d) => Object.keys(d || {})))]
    : [];
  const { map: fieldMap, unmatched } = proposeFieldMap(snapshot.headers, existingFields);
  if (unmatched.length) reasons.push(`${unmatched.length} column(s) had no existing field match — proposed a name; review in the mapping editor: ${unmatched.join(', ')}`);

  return {
    proposal: { mode, targetCollection, keyColumn: mode === 'table' ? keyColumn : null, fieldMap },
    fieldMap,
    unmatched,
    confidence,
    matchedExisting,
    ambiguous,
    reasons,
    alternatives: {
      keyColumns: keyScores.slice(0, 3).map((k) => ({ header: k.header, unique: k.viable })),
      collections: candidates.slice(0, 3).map((c) => ({ name: c.name, overlap: Number(c.overlap.toFixed(2)) })),
    },
  };
}

module.exports = { analyze, proposeFieldMap };
