'use strict';

/**
 * Loads the sync engine (planner + analyzer + optional AI mapper). The engine
 * lives alongside the CLI in ./engine/ so the tool is fully self-contained —
 * no external folders, no build-time vendoring.
 */
const path = require('node:path');

function load(name) {
  return require(path.join(__dirname, 'engine', name));
}

module.exports = {
  planner: load('planner.js'),
  analyzer: load('analyzer.js'),
  aimap: load('aimap.js'),
};
