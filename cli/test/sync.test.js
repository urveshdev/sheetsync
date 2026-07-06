'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const admin = require('firebase-admin');
const sync = require('../lib/sync');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('run via npm test (emulator wrapper)'); process.exit(1);
}
admin.initializeApp({ projectId: 'demo-sheetsync' });
const db = admin.firestore();
test.after(async () => { await db.terminate(); });

const snap = (rows, headers = ['sku', 'name', 'price']) => ({
  spreadsheetId: 'ss', tabName: 'Data', snapshotVersion: Date.now(),
  headers, rows: rows.map((values, i) => ({ sid: `r${i}`, rowIndex: i, values })),
});
const cfg = (over = {}) => ({ mode: 'table', targetCollection: 'p', keyColumn: 'sku', allowDeletes: false, allowBlankOverwrite: false, ...over });

test('plan + apply writes docs directly to Firestore', async () => {
  const c = cfg({ targetCollection: 'p1' });
  const built = await sync.plan(db, c, snap([{ sku: 'A', name: 'Alpha', price: 1 }, { sku: 'B', name: 'Beta', price: 2 }]), 'k1');
  assert.equal(built.preview.creates, 2);
  assert.equal((await db.collection('p1').get()).size, 0, 'plan writes nothing');
  const res = await sync.apply(db, c, built, 'k1', { confirmDeletes: false });
  assert.equal(res.written, 2);
  assert.equal((await db.collection('p1').doc('A').get()).data().name, 'Alpha');
});

test('per-row diff: only changed rows on the second run', async () => {
  const c = cfg({ targetCollection: 'p2' });
  const rows = [{ sku: 'A', name: 'Alpha', price: 1 }, { sku: 'B', name: 'Beta', price: 2 }];
  await sync.apply(db, c, await sync.plan(db, c, snap(rows), 'k2'), 'k2');
  const changed = [{ sku: 'A', name: 'Alpha', price: 1 }, { sku: 'B', name: 'Beta-EDIT', price: 2 }];
  const built = await sync.plan(db, c, snap(changed), 'k2');
  assert.equal(built.preview.updates, 1);
  assert.equal(built.preview.unchanged, 1);
});

test('delete detection + confirmation + rollback (direct-write path)', async () => {
  const c = cfg({ targetCollection: 'p3', allowDeletes: true });
  await sync.apply(db, c, await sync.plan(db, c, snap([{ sku: 'A', name: 'Keep', price: 1 }, { sku: 'B', name: 'Gone', price: 2 }]), 'k3'), 'k3');
  const built = await sync.plan(db, c, snap([{ sku: 'A', name: 'Keep', price: 1 }]), 'k3');
  assert.equal(built.preview.deletes, 1);
  // without confirm → refused
  const refused = await sync.apply(db, c, built, 'k3', { confirmDeletes: false });
  assert.equal(refused.needsDeleteConfirm, true);
  assert.equal((await db.collection('p3').doc('B').get()).exists, true);
  // with confirm → deleted
  const done = await sync.apply(db, c, built, 'k3', { confirmDeletes: true });
  assert.equal(done.deleted, 1);
  assert.equal((await db.collection('p3').doc('B').get()).exists, false);
  // rollback restores it
  await sync.rollback(db, c, 'k3', done.jobId);
  assert.equal((await db.collection('p3').doc('B').get()).exists, true);
});

test('mirror mode syncs a keyless sheet by content id (direct-write path)', async () => {
  const c = cfg({ mode: 'mirror', targetCollection: 'p5', keyColumn: undefined });
  const built = await sync.plan(db, c, snap([{ label: 'x', qty: 1 }, { label: 'y', qty: 2 }], ['label', 'qty']), 'k5');
  assert.equal(built.plan.fatal, null, 'no key required in mirror mode');
  assert.equal(built.preview.creates, 2);
  const res = await sync.apply(db, c, built, 'k5');
  assert.equal(res.written, 2);
});

test('re-running with no changes writes nothing (idempotent)', async () => {
  const c = cfg({ targetCollection: 'p6' });
  const rows = [{ sku: 'A', name: 'Alpha', price: 1 }];
  await sync.apply(db, c, await sync.plan(db, c, snap(rows), 'k6'), 'k6');
  const again = await sync.plan(db, c, snap(rows), 'k6');
  assert.equal(again.preview.creates, 0);
  assert.equal(again.preview.updates, 0);
  assert.equal(again.preview.unchanged, 1, 'unchanged row skipped on re-run');
});

test('field map (rename + exclude) applies on the direct-write path', async () => {
  const c = cfg({ targetCollection: 'p4', fieldMap: {
    sku: { field: 'sku' }, 'Product Name': { field: 'name' }, Notes: { field: 'n', excluded: true },
  } });
  const built = await sync.plan(db, c, snap([{ sku: 'A', 'Product Name': 'Widget', Notes: 'skip' }], ['sku', 'Product Name', 'Notes']), 'k4');
  await sync.apply(db, c, built, 'k4');
  const doc = (await db.collection('p4').doc('A').get()).data();
  assert.equal(doc.name, 'Widget');
  assert.equal(doc.n, undefined);
  assert.equal(doc.Notes, undefined);
});
