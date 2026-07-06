'use strict';

/**
 * Regression guard: the CLI uses @google-cloud/firestore (NOT firebase-admin,
 * which rejects impersonated credentials for Firestore). The sync engine must
 * work against that exact client. Found live 2026-07-06: admin-only credential
 * types crashed Firestore init.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Firestore } = require('@google-cloud/firestore');
const sync = require('../lib/sync');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.error('run via npm test (emulator wrapper)'); process.exit(1);
}
const db = new Firestore({ projectId: 'demo-sheetsync' });
test.after(async () => { await db.terminate(); });

const snap = (rows) => ({
  spreadsheetId: 'ss', tabName: 'Data', snapshotVersion: Date.now(),
  headers: ['sku', 'name', 'price'],
  rows: rows.map((values, i) => ({ sid: `r${i}`, rowIndex: i, values })),
});
const cfg = { mode: 'table', targetCollection: 'compat', keyColumn: 'sku', allowDeletes: false, allowBlankOverwrite: false };

test('full plan → apply → diff → rollback works on @google-cloud/firestore (the client the CLI ships)', async () => {
  const built = await sync.plan(db, cfg, snap([{ sku: 'C1', name: 'One', price: 1 }]), 'compat1');
  assert.equal(built.preview.creates, 1);
  const applied = await sync.apply(db, cfg, built, 'compat1');
  assert.equal(applied.written, 1);
  assert.equal((await db.collection('compat').doc('C1').get()).data().name, 'One');

  // change + re-plan → 1 update; rollback restores
  const built2 = await sync.plan(db, cfg, snap([{ sku: 'C1', name: 'Edited', price: 1 }]), 'compat1');
  assert.equal(built2.preview.updates, 1);
  const applied2 = await sync.apply(db, cfg, built2, 'compat1');
  await sync.rollback(db, cfg, 'compat1', applied2.jobId);
  assert.equal((await db.collection('compat').doc('C1').get()).data().name, 'One', 'rollback on gcloud client');
});
