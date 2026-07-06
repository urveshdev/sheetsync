'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { reconcileStructure } = require('../lib/structure');

const cfg = () => ({
  mode: 'table', targetCollection: 'p', keyColumn: 'sku', allowDeletes: false,
  fieldMap: { sku: { field: 'sku' }, 'Product Name': { field: 'name' } },
});

test('no column change → no re-map (rows-only edits skip analysis/AI)', async () => {
  const r = await reconcileStructure(cfg(), ['sku', 'Product Name'], ['sku', 'name']);
  assert.equal(r.changed, false, 'same columns → nothing to do');
  assert.deepEqual(r.newColumns, []);
});

test('reordered/renamed-value columns still count as unchanged if the set matches', async () => {
  const r = await reconcileStructure(cfg(), ['Product Name', 'sku'], []);
  assert.equal(r.changed, false);
});

test('a new column triggers mapping for ONLY that column', async () => {
  const r = await reconcileStructure(cfg(), ['sku', 'Product Name', 'Unit Price'], ['sku', 'name', 'price']);
  assert.equal(r.changed, true);
  assert.deepEqual(r.newColumns, ['Unit Price']);
  assert.equal(r.config.fieldMap['Unit Price'].field, 'price', 'new column mapped to existing field');
  assert.equal(r.config.fieldMap['Product Name'].field, 'name', 'existing mapping untouched');
});

test('a removed column is reported but does not block', async () => {
  const r = await reconcileStructure(cfg(), ['sku'], []);
  assert.equal(r.changed, false, 'removing a column is not a re-map trigger');
  assert.deepEqual(r.removedColumns, ['Product Name']);
});

test('AI proposer is used for new columns when provided, else deterministic', async () => {
  const aiFor = async (cols) => ({ [cols[0]]: { field: 'aiField', excluded: false, source: 'ai' } });
  const r = await reconcileStructure(cfg(), ['sku', 'Product Name', 'Weird'], [], aiFor);
  assert.equal(r.config.fieldMap['Weird'].field, 'aiField');
  // AI failure → falls back to deterministic
  const r2 = await reconcileStructure(cfg(), ['sku', 'Product Name', 'Weird'], [], async () => { throw new Error('down'); });
  assert.equal(r2.config.fieldMap['Weird'].field, 'weird');
});
