'use strict';

/**
 * Pure helpers for turning a raw 2-D grid (as returned by the Sheets API) into
 * the { headers, rows } shape the planner expects — including header-row
 * detection and durable row identity. No I/O here, so it's unit-testable.
 */

const BLANK = (v) => v === null || v === undefined || String(v).trim() === '';

/** Find the most likely header row (0-based) in the first ~15 rows. */
function detectHeaderRow(grid) {
  let best = 0, bestScore = -1;
  const scan = Math.min(15, grid.length - 1);
  for (let r = 0; r < scan; r++) {
    const row = grid[r] || [];
    const nonEmpty = row.filter((c) => !BLANK(c));
    if (nonEmpty.length < 2) continue; // title / blank rows
    const texty = nonEmpty.filter((c) => Number.isNaN(Number(c))).length;
    const uniq = new Set(nonEmpty.map((c) => String(c).trim().toLowerCase())).size;
    const score = (texty / nonEmpty.length) * 0.5
      + (uniq / nonEmpty.length) * 0.3
      + (row.length ? nonEmpty.length / row.length : 0) * 0.2;
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return best;
}

/**
 * Build the planner snapshot from a grid.
 * Row identity: table mode uses the key column value as the id; mirror mode
 * uses a stable content hash of the row (so no hidden column is needed).
 * @returns {{headers, rows:[{sid, values}], headerRow}}
 */
function gridToSnapshot(grid, { headerRow } = {}) {
  const hr = headerRow != null ? headerRow : detectHeaderRow(grid);
  const headers = (grid[hr] || []).map((h) => String(h).trim()).filter((h) => h !== '');
  const rows = [];
  for (let i = hr + 1; i < grid.length; i++) {
    const raw = grid[i] || [];
    if (raw.every((c) => BLANK(c))) continue; // skip blank rows
    const values = {};
    headers.forEach((h, c) => { values[h] = raw[c] !== undefined ? raw[c] : ''; });
    rows.push({ sid: `row${i - hr}`, rowIndex: i, values });
  }
  return { headers, rows, headerRow: hr };
}

module.exports = { detectHeaderRow, gridToSnapshot, BLANK };
