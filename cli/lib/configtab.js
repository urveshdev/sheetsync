'use strict';

/**
 * The "SheetSync" tab IS the whole UI. This module turns the analyzer's
 * proposal into a 2-D grid to write into that tab, and parses a user-edited
 * tab back into config. No I/O — pure, testable.
 *
 * Tab layout:
 *   A1: SheetSync — edit below, then re-run to sync
 *   A3: Target collection | <value>
 *   A4: Key column        | <value>
 *   A5: Mode              | table | mirror
 *   A6: Allow deletes     | no | yes
 *   A8: Sheet Column | Firebase Field | Sync?     (header)
 *   A9…: one row per column
 */

const HEADER = 'SheetSync — edit below, then re-run to sync';
const MAP_HEADER = ['Sheet Column', 'Firebase Field', 'Sync? (yes/no)'];

function proposalToGrid({ targetCollection, keyColumn, mode, allowDeletes, fieldMap }) {
  const grid = [
    [HEADER],
    [],
    ['Target collection', targetCollection || ''],
    ['Key column', keyColumn || ''],
    ['Mode', mode || 'table'],
    ['Allow deletes', allowDeletes ? 'yes' : 'no'],
    [],
    MAP_HEADER,
  ];
  for (const header of Object.keys(fieldMap || {})) {
    const m = fieldMap[header];
    grid.push([header, m.field || header, m.excluded ? 'no' : 'yes']);
  }
  return grid;
}

const norm = (s) => String(s == null ? '' : s).trim();
const truthy = (s) => /^(y|yes|true|1)$/i.test(norm(s));

/** Parse a user-edited SheetSync tab grid back into config. Returns null if it doesn't look like our tab. */
function gridToConfig(grid) {
  if (!Array.isArray(grid) || !grid.length || norm(grid[0][0]).indexOf('SheetSync') !== 0) return null;
  const kv = {};
  let mapStart = -1;
  for (let i = 1; i < grid.length; i++) {
    const a = norm(grid[i][0]);
    if (a === MAP_HEADER[0]) { mapStart = i + 1; break; }
    if (a) kv[a.toLowerCase()] = norm(grid[i][1]);
  }
  const fieldMap = {};
  if (mapStart >= 0) {
    for (let i = mapStart; i < grid.length; i++) {
      const col = norm(grid[i][0]);
      if (!col) continue;
      fieldMap[col] = { field: norm(grid[i][1]) || col, excluded: !truthy(grid[i][2]), source: 'user' };
    }
  }
  return {
    mode: (kv['mode'] || 'table').toLowerCase() === 'mirror' ? 'mirror' : 'table',
    targetCollection: kv['target collection'] || '',
    keyColumn: kv['key column'] || '',
    allowDeletes: truthy(kv['allow deletes']),
    allowBlankOverwrite: false,
    fieldMap,
  };
}

/** A tab is a config tab (not user data) if it's the bare "SheetSync" or "SheetSync (…)". */
function isConfigTab(title) {
  return title === 'SheetSync' || /^SheetSync \(.*\)$/.test(String(title));
}

/**
 * Config tab name for a given data tab. Each data tab in a spreadsheet gets its
 * own config → its own collection. Backward-compat: the FIRST data tab reuses a
 * legacy bare "SheetSync" tab if one already exists (single-tab setups keep
 * working); otherwise the per-tab name "SheetSync (TabName)" is used.
 */
function configTabNameFor(dataTab, isFirst, titles) {
  const suffixed = `SheetSync (${dataTab})`;
  if (titles.includes(suffixed)) return suffixed;
  if (isFirst && titles.includes('SheetSync')) return 'SheetSync';
  return suffixed;
}

module.exports = { proposalToGrid, gridToConfig, isConfigTab, configTabNameFor, HEADER, MAP_HEADER };
