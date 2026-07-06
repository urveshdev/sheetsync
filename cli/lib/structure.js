'use strict';

/**
 * Structure-change detection. Mapping/analysis is EXPENSIVE (and, if enabled,
 * uses AI), so we only redo it when the sheet's COLUMNS change — not when rows
 * are added or edited. Given the saved config (from the SheetSync tab) and the
 * sheet's current headers, decide whether re-mapping is needed and, if so,
 * propose fields for ONLY the newly-appeared columns.
 */

const { proposeFieldMap } = require('./engine').analyzer;

/**
 * @param {object} config parsed from the SheetSync tab (has fieldMap)
 * @param {string[]} headers current sheet headers
 * @param {string[]} existingFields fields already in the target collection
 * @param {(newCols:string[])=>object|null} [aiPropose] optional AI for the new columns only
 * @returns {Promise<{changed:boolean, config:object, newColumns:string[], removedColumns:string[]}>}
 */
async function reconcileStructure(config, headers, existingFields, aiPropose) {
  const mapped = new Set(Object.keys(config.fieldMap || {}));
  const present = headers.filter((h) => h !== '_sheetSyncId');
  const newColumns = present.filter((h) => !mapped.has(h));
  const removedColumns = [...mapped].filter((h) => !present.includes(h));

  if (newColumns.length === 0) {
    // Pure row change (add/edit/delete rows) → NO analysis, NO AI. Just sync.
    return { changed: false, config, newColumns: [], removedColumns };
  }

  // Columns were added → map only those (deterministic, or AI if provided).
  let addition = null;
  if (aiPropose) { try { addition = await aiPropose(newColumns); } catch (_e) { addition = null; } }
  if (!addition) addition = proposeFieldMap(newColumns, existingFields).map;

  return {
    changed: true,
    config: { ...config, fieldMap: { ...(config.fieldMap || {}), ...addition } },
    newColumns,
    removedColumns,
  };
}

module.exports = { reconcileStructure };
