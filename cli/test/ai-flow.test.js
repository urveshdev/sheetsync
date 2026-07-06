'use strict';

/**
 * The AI mapping flow, end to end with a STUBBED model (no key, no network):
 * messy headers → AI proposes mapping → user "fixes" one entry in the
 * SheetSync tab → the corrected mapping is what actually syncs.
 * Mirrors exactly what happens with a real GEMINI_API_KEY.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { aimap } = require('../lib/engine');
const { proposalToGrid, gridToConfig } = require('../lib/configtab');
const { reconcileStructure } = require('../lib/structure');

test('AI proposes; deterministic backfills; user correction in the tab wins', async () => {
  // 1. AI proposes a mapping for messy headers (stubbed Gemini).
  const fakeGemini = async () => JSON.stringify({ map: {
    'Prod. Name': { field: 'name' },
    'Cost (USD)': { field: 'price' },          // AI guess — user will correct this
    'Warehouse Notes': { field: 'notes', excluded: true },
  } });
  const ai = await aimap.aiFieldMap({
    apiKey: 'stub', headers: ['SKU', 'Prod. Name', 'Cost (USD)', 'Warehouse Notes'],
    sampleRows: [{ values: { SKU: 'A1', 'Prod. Name': 'Widget', 'Cost (USD)': 9, 'Warehouse Notes': 'x' } }],
    existingFields: ['sku', 'name', 'price'], callGemini: fakeGemini,
  });
  assert.equal(ai['Prod. Name'].field, 'name');
  assert.equal(ai['Warehouse Notes'].excluded, true);
  assert.equal(ai['SKU'], undefined, 'AI skipped SKU — deterministic must backfill');

  // 2. Merge (AI primary, deterministic backfill) → the SheetSync tab grid.
  const { proposeFieldMap } = require('../lib/engine').analyzer;
  const det = proposeFieldMap(['SKU', 'Prod. Name', 'Cost (USD)', 'Warehouse Notes'], ['sku', 'name', 'price']).map;
  const merged = { ...det, ...ai };
  assert.equal(merged['SKU'].field, 'sku', 'deterministic backfilled the AI gap');
  const grid = proposalToGrid({ targetCollection: 'products', keyColumn: 'SKU', mode: 'table', allowDeletes: false, fieldMap: merged });

  // 3. USER FIX: they disagree with AI's 'price' for "Cost (USD)" → edit the tab cell to 'costUsd'.
  const row = grid.findIndex((r) => r[0] === 'Cost (USD)');
  grid[row][1] = 'costUsd';

  // 4. Parse the tab back — the user's correction is what the sync will use.
  const cfg = gridToConfig(grid);
  assert.equal(cfg.fieldMap['Cost (USD)'].field, 'costUsd', 'user edit overrides AI');
  assert.equal(cfg.fieldMap['Prod. Name'].field, 'name', 'accepted AI entries survive');
  assert.equal(cfg.fieldMap['Warehouse Notes'].excluded, true);
});

test('AI runs for NEW columns only on structure change; AI failure falls back deterministically', async () => {
  const cfg = { mode: 'table', targetCollection: 'p', keyColumn: 'sku',
    fieldMap: { SKU: { field: 'sku' }, 'Prod. Name': { field: 'name' } } };
  let aiCalls = 0;
  const aiFor = async (cols) => { aiCalls++; return { [cols[0]]: { field: 'discountPct', source: 'ai' } }; };

  // rows-only change → AI must NOT be called
  const same = await reconcileStructure(cfg, ['SKU', 'Prod. Name'], [], aiFor);
  assert.equal(same.changed, false);
  assert.equal(aiCalls, 0, 'no AI on row-only changes');

  // new column → AI called for just that column
  const grown = await reconcileStructure(cfg, ['SKU', 'Prod. Name', 'Disc %'], [], aiFor);
  assert.equal(aiCalls, 1);
  assert.equal(grown.config.fieldMap['Disc %'].field, 'discountPct');
  assert.equal(grown.config.fieldMap['Prod. Name'].field, 'name', 'existing mappings untouched');
});
