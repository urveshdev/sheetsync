'use strict';

const crypto = require('node:crypto');
// Reuse the SAME deterministic engine the extension uses (resolver handles the
// dev-vs-public repo layout).
const { buildPlan, summarize } = require('./engine').planner;

const CHUNK = 400;
const stateRef = (db, key) => db.collection('_sheetSync').doc('cliState').collection('sheets').doc(key);
const contentHash = (v) => crypto.createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 16);

/** Give each row a stable identity: the key value (table) or a content hash (mirror). */
function assignIdentity(snapshot, config) {
  const rows = snapshot.rows.map((r) => {
    const sid = config.mode === 'mirror'
      ? `mir_${contentHash(r.values)}`
      : String(r.values[config.keyColumn] != null ? r.values[config.keyColumn] : '');
    return { ...r, sid };
  });
  return { ...snapshot, rows };
}

async function loadExisting(db, targetCollection) {
  const snap = await db.collection(targetCollection).get();
  const m = new Map();
  snap.forEach((d) => m.set(d.id, d.data()));
  return m;
}

async function loadState(db, key) {
  const doc = await stateRef(db, key).get();
  return doc.exists ? doc.data() : { knownSids: [], knownSidDocIds: {} };
}

/** Build a dry-run plan + preview. Writes nothing. */
async function plan(db, config, rawSnapshot, key) {
  const snapshot = assignIdentity(rawSnapshot, config);
  const existing = await loadExisting(db, config.targetCollection);
  const state = await loadState(db, key);
  const p = buildPlan({
    config: { ...config, knownSidDocIds: state.knownSidDocIds || {} },
    snapshot,
    existingByDocId: existing,
    knownSids: new Set(state.knownSids || []),
    allowedCollections: [],
  });
  return { plan: p, preview: summarize(p), snapshot };
}

/** Apply a plan: snapshot each touched doc first (for rollback), then write/delete in batches. */
async function apply(db, config, built, key, { confirmDeletes = false } = {}) {
  const { plan: p, snapshot } = built;
  if (p.fatal) return { error: p.fatal };
  const hasDeletes = p.ops.some((o) => o.action === 'delete');
  if (hasDeletes && !confirmDeletes) return { needsDeleteConfirm: true, deletes: p.preview ? p.preview.deletes : undefined };

  const target = db.collection(config.targetCollection);
  const jobId = `job_${contentHash({ key, v: snapshot.snapshotVersion, t: p.ops.length })}_${p.ops.length}`;
  const snapCol = db.collection('_sheetSync').doc('cliJobs').collection(key).doc(jobId).collection('snap');

  // pre-write snapshots
  for (let i = 0; i < p.ops.length; i += CHUNK) {
    const chunk = p.ops.slice(i, i + CHUNK);
    const reads = await Promise.all(chunk.map((o) => target.doc(o.docId).get()));
    const batch = db.batch();
    chunk.forEach((o, j) => batch.set(snapCol.doc(o.docId), {
      existedBefore: reads[j].exists, data: reads[j].exists ? reads[j].data() : null,
    }));
    await batch.commit();
  }
  // writes + deletes
  let written = 0; let deleted = 0;
  for (let i = 0; i < p.ops.length; i += CHUNK) {
    const batch = db.batch();
    for (const o of p.ops.slice(i, i + CHUNK)) {
      if (o.action === 'delete') { batch.delete(target.doc(o.docId)); deleted++; }
      else { batch.set(target.doc(o.docId), { ...o.fields, _sheetSync: { syncedAt: Date.now() } }, { merge: true }); written++; }
    }
    await batch.commit();
  }
  // state for next-run delete detection
  const deletedSids = new Set(p.ops.filter((o) => o.action === 'delete').map((o) => o.sid));
  const state = await loadState(db, key);
  await stateRef(db, key).set({
    knownSids: (snapshot.rows.map((r) => r.sid)).filter((s) => !deletedSids.has(s)),
    knownSidDocIds: { ...(state.knownSidDocIds || {}), ...(p.sidToDocId || {}) },
    lastJobId: jobId, updatedAt: Date.now(),
  }, { merge: true });

  return { jobId, written, deleted };
}

/** Restore every doc touched by a job to its pre-write state. */
async function rollback(db, config, key, jobId) {
  const snapCol = db.collection('_sheetSync').doc('cliJobs').collection(key).doc(jobId).collection('snap');
  const target = db.collection(config.targetCollection);
  const snaps = await snapCol.get();
  let restored = 0;
  const docs = snaps.docs;
  for (let i = 0; i < docs.length; i += CHUNK) {
    const batch = db.batch();
    for (const s of docs.slice(i, i + CHUNK)) {
      const { existedBefore, data } = s.data();
      if (existedBefore) batch.set(target.doc(s.id), data); else batch.delete(target.doc(s.id));
      restored++;
    }
    await batch.commit();
  }
  return { restored };
}

module.exports = { plan, apply, rollback, assignIdentity, loadExisting, loadState };
