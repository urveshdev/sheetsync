'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseArgs } = require('../lib/args');

const ENV = {}; // isolate from real env

test('REGRESSION: "--project VALUE" (space form, what run.sh passes) parses as a string', () => {
  const a = parseArgs(['https://docs.google.com/spreadsheets/d/abc/edit', '--project', 'my-firebase-project'], ENV);
  assert.equal(a.flags.project, 'my-firebase-project', 'was true (boolean) — crashed Firestore projectId');
  assert.equal(a.sheet, 'https://docs.google.com/spreadsheets/d/abc/edit');
});

test('"--project=VALUE" (equals form) still works', () => {
  assert.equal(parseArgs(['--project=my-proj'], ENV).flags.project, 'my-proj');
});

test('boolean flags stay boolean and do not eat the next token', () => {
  const a = parseArgs(['--auto', 'sheeturl', '--yes', '--rollback'], ENV);
  assert.equal(a.flags.auto, true);
  assert.equal(a.flags.yes, true);
  assert.equal(a.flags.rollback, true);
  assert.equal(a.sheet, 'sheeturl', 'positional after boolean flag still captured');
});

test('value flag at end of argv (no value) degrades to boolean, not crash', () => {
  assert.equal(parseArgs(['--project'], ENV).flags.project, true);
});

test('env fallbacks: SHEET and SHEETSYNC_AUTO', () => {
  const a = parseArgs([], { SHEET: 'from-env', SHEETSYNC_AUTO: '1' });
  assert.equal(a.sheet, 'from-env');
  assert.equal(a.flags.auto, true);
  assert.equal(a.flags.yes, true);
});
