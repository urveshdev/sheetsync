'use strict';

/**
 * Multi-tab: one spreadsheet FILE with several data tabs (Products, Orders…),
 * each syncing to its own collection with its own config tab.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { isConfigTab, configTabNameFor } = require('../lib/configtab');

test('config tabs are recognized (bare and suffixed); data tabs are not', () => {
  assert.equal(isConfigTab('SheetSync'), true);
  assert.equal(isConfigTab('SheetSync (Products)'), true);
  assert.equal(isConfigTab('SheetSync (Orders 2026)'), true);
  assert.equal(isConfigTab('Products'), false);
  assert.equal(isConfigTab('Sheet1'), false);
  assert.equal(isConfigTab('My SheetSync notes'), false);
});

test('data tabs are everything that is not a config tab', () => {
  const titles = ['Products', 'Orders', 'SheetSync (Products)', 'SheetSync', 'Customers'];
  const data = titles.filter((t) => !isConfigTab(t));
  assert.deepEqual(data, ['Products', 'Orders', 'Customers']);
});

test('each data tab maps to its OWN config tab (no collision)', () => {
  const titles = ['Products', 'Orders'];
  assert.equal(configTabNameFor('Products', false, titles), 'SheetSync (Products)');
  assert.equal(configTabNameFor('Orders', false, titles), 'SheetSync (Orders)');
  assert.notEqual(configTabNameFor('Products', false, titles), configTabNameFor('Orders', false, titles));
});

test('backward-compat: the FIRST tab reuses a legacy bare "SheetSync" tab if present', () => {
  // A single-tab user already has a bare "SheetSync" tab — keep using it.
  const titles = ['Products', 'SheetSync'];
  assert.equal(configTabNameFor('Products', true, titles), 'SheetSync', 'first tab keeps the legacy tab');
  // A second tab added later gets its own suffixed config, not the bare one.
  assert.equal(configTabNameFor('Orders', false, titles), 'SheetSync (Orders)');
});

test('an existing suffixed config tab is preferred over the legacy bare one', () => {
  const titles = ['Products', 'SheetSync', 'SheetSync (Products)'];
  assert.equal(configTabNameFor('Products', true, titles), 'SheetSync (Products)',
    'once a per-tab config exists, use it');
});
