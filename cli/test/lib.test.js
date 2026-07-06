'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectHeaderRow, gridToSnapshot } = require('../lib/sheet');
const { proposalToGrid, gridToConfig } = require('../lib/configtab');

test('detectHeaderRow finds row 0 on a clean grid', () => {
  const grid = [['sku', 'name', 'price'], ['B1', 'Cable', '9']];
  assert.equal(detectHeaderRow(grid), 0);
});

test('detectHeaderRow skips a title + blank row and finds the real header', () => {
  const grid = [
    ['Q3 Inventory Report'],   // title
    [],                        // blank
    ['sku', 'name', 'price'],  // real header (row 2)
    ['B1', 'Cable', '9'],
  ];
  assert.equal(detectHeaderRow(grid), 2);
});

test('gridToSnapshot maps headers → row values below the header', () => {
  const grid = [['title'], ['sku', 'name'], ['B1', 'Cable'], ['', ''], ['B2', 'HDMI']];
  const snap = gridToSnapshot(grid);
  assert.equal(snap.headerRow, 1);
  assert.deepEqual(snap.headers, ['sku', 'name']);
  assert.equal(snap.rows.length, 2, 'blank row skipped');
  assert.deepEqual(snap.rows[0].values, { sku: 'B1', name: 'Cable' });
});

test('config tab round-trips: proposal → grid → parsed config', () => {
  const grid = proposalToGrid({
    targetCollection: 'products', keyColumn: 'sku', mode: 'table', allowDeletes: false,
    fieldMap: { sku: { field: 'sku' }, 'Product Name': { field: 'name' }, Notes: { field: 'notes', excluded: true } },
  });
  const cfg = gridToConfig(grid);
  assert.equal(cfg.targetCollection, 'products');
  assert.equal(cfg.keyColumn, 'sku');
  assert.equal(cfg.mode, 'table');
  assert.equal(cfg.allowDeletes, false);
  assert.equal(cfg.fieldMap['Product Name'].field, 'name');
  assert.equal(cfg.fieldMap['Notes'].excluded, true);
});

test('gridToConfig honors user edits (rename + toggle sync off + allow deletes)', () => {
  const cfg = gridToConfig([
    ['SheetSync — edit below, then re-run to sync'],
    [],
    ['Target collection', 'catalog'],
    ['Key column', 'sku'],
    ['Mode', 'table'],
    ['Allow deletes', 'yes'],
    [],
    ['Sheet Column', 'Firebase Field', 'Sync? (yes/no)'],
    ['sku', 'sku', 'yes'],
    ['Long Name', 'title', 'yes'],
    ['scratch', 'scratch', 'no'],
  ]);
  assert.equal(cfg.targetCollection, 'catalog');
  assert.equal(cfg.allowDeletes, true);
  assert.equal(cfg.fieldMap['Long Name'].field, 'title');
  assert.equal(cfg.fieldMap['scratch'].excluded, true);
});

test('gridToConfig returns null for a non-SheetSync grid', () => {
  assert.equal(gridToConfig([['random', 'stuff']]), null);
  assert.equal(gridToConfig([]), null);
});
