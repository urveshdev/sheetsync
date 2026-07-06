'use strict';

/**
 * Static guards for the shell wrappers (the layer that's only fully testable
 * live — these pin the properties that broke or annoyed users).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const runSh = fs.readFileSync(path.join(__dirname, '..', 'run.sh'), 'utf8');
const deploySh = fs.readFileSync(path.join(__dirname, '..', 'deploy-scheduled.sh'), 'utf8');

test('shell scripts parse as valid bash', () => {
  for (const f of ['run.sh', 'deploy-scheduled.sh']) {
    const res = spawnSync('bash', ['-n', path.join(__dirname, '..', f)]);
    assert.equal(res.status, 0, `${f} failed bash -n: ${res.stderr}`);
  }
});

test('REGRESSION: sign-in is a single flow (login --update-adc), never two code-pastes in a row', () => {
  assert.match(runSh, /gcloud auth login --update-adc/,
    'without --update-adc users paste two verification codes back-to-back');
  // The two-flows-in-sequence shape must not come back: an unconditional
  // application-default login directly after a plain login.
  assert.doesNotMatch(runSh, /gcloud auth login;\s*\n?.*application-default login/,
    'back-to-back double login reintroduced');
});

test('REGRESSION: no sensitive scopes at sign-in (Google blocks gcloud client for Sheets scopes)', () => {
  assert.doesNotMatch(runSh, /auth.*login.*--scopes/, 'scoped gcloud login caused "This app is blocked"');
  assert.doesNotMatch(runSh, /spreadsheets/, 'run.sh must never request Sheets scopes at sign-in');
});

test('REGRESSION (env sim): finds ADC in a temp CLOUDSDK_CONFIG dir — the exact Cloud Shell failure', () => {
  // Live 2026-07-06: gcloud saved ADC to /tmp/tmp.XXXX (CLOUDSDK_CONFIG) where
  // Node never looks. export_adc_path must find it and export the env var.
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sheetsync-adc-'));
  fs.writeFileSync(path.join(tmp, 'application_default_credentials.json'), '{}');
  const lib = path.join(__dirname, '..', 'lib', 'adc.sh');

  // Case 1: CLOUDSDK_CONFIG temp dir (user's session) → must pick that file.
  let out = spawnSync('bash', ['-c', `. "${lib}"; export_adc_path && printf '%s' "$GOOGLE_APPLICATION_CREDENTIALS"`],
    { env: { ...process.env, CLOUDSDK_CONFIG: tmp, HOME: '/nonexistent-home' } });
  assert.equal(out.status, 0, 'must succeed when ADC is in CLOUDSDK_CONFIG');
  assert.equal(out.stdout.toString(), path.join(tmp, 'application_default_credentials.json'));

  // Case 2: standard location fallback.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sheetsync-home-'));
  fs.mkdirSync(path.join(home, '.config', 'gcloud'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'gcloud', 'application_default_credentials.json'), '{}');
  out = spawnSync('bash', ['-c', `. "${lib}"; export_adc_path && printf '%s' "$GOOGLE_APPLICATION_CREDENTIALS"`],
    { env: { ...process.env, CLOUDSDK_CONFIG: '/nonexistent-csc', HOME: home } });
  assert.equal(out.stdout.toString(), path.join(home, '.config', 'gcloud', 'application_default_credentials.json'));

  // Case 3: nowhere → non-zero, no export.
  out = spawnSync('bash', ['-c', `. "${lib}"; export_adc_path`],
    { env: { ...process.env, CLOUDSDK_CONFIG: '/nope', HOME: '/nope' } });
  assert.notEqual(out.status, 0, 'must fail cleanly when no ADC exists anywhere');
});

test('run.sh sources the adc helpers and sets the quota project (ADC API-call requirement)', () => {
  assert.match(runSh, /\. "\$\(dirname "\$0"\)\/lib\/adc\.sh"/, 'run.sh must source lib/adc.sh');
  assert.match(runSh, /set-quota-project/, 'quota project must be attached (gcloud warned about it live)');
  const quotaAt = runSh.indexOf('set-quota-project');
  const nodeAt = runSh.indexOf('node sheetsync.js');
  assert.ok(quotaAt !== -1 && quotaAt < nodeAt, 'quota project set before the CLI runs');
});

test('REGRESSION: ADC is validated with NODE (not gcloud) and re-login self-heals a broken file', () => {
  // Live bug: gcloud accepted a half-written ADC file that crashed Node with
  // "Cannot create property 'refresh_token' on string ''".
  const adcSh = fs.readFileSync(path.join(__dirname, '..', 'lib', 'adc.sh'), 'utf8');
  assert.match(adcSh, /adc_ok\(\)/, 'node-based ADC probe missing');
  assert.match(adcSh, /GoogleAuth[\s\S]*getClient/, 'probe must exercise the same library the CLI uses');
  assert.match(runSh, /adc_ok \|\| fail/, 'must fail with a remedy if re-login does not heal');
  const deps = runSh.indexOf('npm install');
  const probe = runSh.indexOf('adc_ok');
  assert.ok(deps !== -1 && probe !== -1 && deps < probe, 'deps must install BEFORE the node probe uses them');
});

test('run.sh guides the share step (boxed prompt with the robot email) and self-updates', () => {
  assert.match(runSh, /ACTION NEEDED/, 'first-time share instructions missing');
  assert.match(runSh, /sheetsync-runner@/, 'robot email missing from setup');
  assert.match(runSh, /git pull -q --ff-only/, 'self-update for stale Cloud Shell clones missing');
});

test('REGRESSION: first run is ONE continuous flow — waits for tab review instead of exiting', () => {
  // UX bug: after creating the SheetSync tab the CLI exited and told the user
  // to "run this command again" — twice in one journey. Interactive runs must
  // pause for review and continue in the same invocation.
  const cli = fs.readFileSync(path.join(__dirname, '..', 'sheetsync.js'), 'utf8');
  assert.match(cli, /Reviewed\? Press y to continue/, 'review-and-continue prompt missing');
  assert.match(cli, /isTTY/, 'must still exit cleanly for non-interactive/auto runs');
  // Config is (re-)read from the tab at sync time — after the review pause —
  // so user edits during the pause take effect.
  assert.match(cli, /gridToConfig\(\(await sheets\.spreadsheets\.values\.get/,
    'config must be read from the tab at sync time (post-review)');
});

test('REGRESSION: after applying, the CLI explains what happened, where data lives, and where to change things', () => {
  // UX bug: 'Synced: 2 written' told the user nothing. The summary must name
  // the collection, link the Firestore console, and point at the SheetSync tab.
  const cli = fs.readFileSync(path.join(__dirname, '..', 'sheetsync.js'), 'utf8');
  // Per-tab: names the tab, the collection, the counts, and the console link.
  assert.match(cli, /✔ \$\{tab\} → \/\$\{config\.targetCollection\}/, 'per-tab result line missing');
  assert.match(cli, /console\.firebase\.google\.com\/project\/\$\{projectId\}\/firestore/, 'Firestore console link missing');
  // Footer: where to change things.
  assert.match(cli, /Where to change things/, 'change-guidance missing');
  assert.match(cli, /--rollback/, 'undo command missing from summary');
});

test('one-step flow: run.sh offers automatic scheduling after a successful sync (interactive only)', () => {
  assert.match(runSh, /sync AUTOMATICALLY every hour/i, 'in-flow scheduling offer missing');
  assert.match(runSh, /deploy-scheduled\.sh "\$SHEET" --project "\$PROJECT"/, 'offer must invoke the scheduler setup with the same sheet+project');
  assert.match(runSh, /scheduler jobs describe "\$\(sched_name_of "\$SHEET"\)"/, 'must detect an existing schedule (per-sheet name) instead of re-offering');
  assert.match(runSh, /\[ -t 0 \]/, 'offer must be gated to interactive terminals');
  assert.match(runSh, /--auto\|--rollback\) SKIP_OFFER=1/, 'no offer on auto/rollback runs');
});

test('final summary links where to modify: schedule console + the open-source repo', () => {
  const cli = fs.readFileSync(path.join(__dirname, '..', 'sheetsync.js'), 'utf8');
  assert.match(cli, /cloudscheduler\?project=/, 'schedule-management link missing');
  assert.match(cli, /Customize this tool/, 'customize-guidance (edit files in Cloud Shell) missing');
});

test('REGRESSION: schedules are named PER SHEET — a second spreadsheet must not overwrite the first', () => {
  // Fixed names (sheetsync-sync / sheetsync-hourly) meant scheduling sheet B
  // silently replaced sheet A's schedule.
  const lib = path.join(__dirname, '..', 'lib', 'naming.sh');
  const run = (cmd) => spawnSync('bash', ['-c', `. "${lib}"; ${cmd}`]).stdout.toString().trim();
  const urlA = 'https://docs.google.com/spreadsheets/d/AAA111/edit';
  const jobA = run(`job_name_of "${urlA}"`);
  const jobAById = run('job_name_of "AAA111"');
  const jobB = run('job_name_of "BBB222"');
  assert.match(jobA, /^sheetsync-sync-\d+$/, 'name-safe suffixed job name');
  assert.equal(jobA, jobAById, 'URL and bare ID must map to the same job');
  assert.notEqual(jobA, jobB, 'different sheets → different jobs');
  assert.match(deploySh, /job_name_of "\$SHEET"/, 'deploy must use per-sheet job names');
  assert.match(runSh, /sched_name_of "\$SHEET"/, 'run.sh schedule check must use per-sheet names');
  assert.doesNotMatch(deploySh, /JOB="sheetsync-sync"/, 'fixed job name must not return');
});

test('deploy-scheduled.sh keeps the self-impersonation grant and ships the self-contained engine', () => {
  assert.match(deploySh, /serviceAccountTokenCreator/, 'SA self-impersonation grant missing (Sheets tokens on Cloud Run)');
  assert.match(deploySh, /SHEETSYNC_SA/, 'job must know which SA to impersonate');
  // Engine must live inside cli/ so the container (built from cli/) has it.
  const fs = require('node:fs');
  for (const f of ['planner.js', 'analyzer.js', 'aimap.js']) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'lib', 'engine', f)), `cli/lib/engine/${f} missing — container would crash`);
  }
  // .gcloudignore must NOT exclude the engine from the build upload.
  const gci = fs.readFileSync(path.join(__dirname, '..', '.gcloudignore'), 'utf8');
  assert.doesNotMatch(gci, /^[^#\n]*lib\/engine/m, '.gcloudignore must not exclude lib/engine');
});

test('REGRESSION: every engine module the loader requires exists in cli/lib/engine (vendoring-bug class)', () => {
  // Live 2026-07-06: the Cloud Run container crashed because planner.js, then
  // aimap.js, were not shipped. Pin that the loader's list matches the files.
  const fs = require('node:fs');
  const engineJs = fs.readFileSync(path.join(__dirname, '..', 'lib', 'engine.js'), 'utf8');
  const required = [...engineJs.matchAll(/load\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(required.length >= 3, 'expected at least planner/analyzer/aimap');
  for (const f of required) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'lib', 'engine', f)), `engine.js requires ${f} but cli/lib/engine/${f} is missing`);
  }
});
