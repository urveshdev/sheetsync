#!/usr/bin/env node
'use strict';

/**
 * SheetSync CLI — one script, no add-on, no extension.
 *
 *   node sheetsync.js <sheet-url-or-id> [--project ID] [--auto] [--yes] [--rollback]
 *
 * Reads your Google Sheet, uses a "SheetSync (TabName)" config tab per data tab as the
 * config/mapping UI, and writes to YOUR Firestore directly with YOUR own
 * credentials. First run proposes the config into the SheetSync tab; you edit
 * it; re-run to sync. --auto applies only safe changes (for cron); --yes skips
 * the confirm prompt; --rollback undoes the last sync.
 */

const path = require('node:path');
const readline = require('node:readline');
const { google } = require('googleapis');
const { gridToSnapshot } = require('./lib/sheet');
const { proposalToGrid, gridToConfig, isConfigTab, configTabNameFor } = require('./lib/configtab');
const { analyze } = require('./lib/engine').analyzer;
const { reconcileStructure } = require('./lib/structure');
const sync = require('./lib/sync');

async function existingFieldsOf(db, collectionName) {
  try {
    const snap = await db.collection(collectionName).limit(20).get();
    return [...new Set(snap.docs.flatMap((d) => Object.keys(d.data() || {})))].filter((f) => f !== '_sheetSync');
  } catch (_e) { return []; }
}

const say = (m) => console.log(m);
const die = (m) => { console.error(`\n✗ ${m}\n`); process.exit(1); };

const { parseArgs } = require('./lib/args');
const sheetId = (s) => { const m = String(s).match(/\/d\/([a-zA-Z0-9_-]+)/); return m ? m[1] : s; };

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise((res) => rl.question(`${question} [y/N] `, res));
  rl.close();
  return /^y(es)?$/i.test(ans.trim());
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.sheet) die('Usage: node sheetsync.js <sheet-url-or-id> [--project ID] [--auto] [--yes] [--rollback]');
  const spreadsheetId = sheetId(args.sheet);
  const projectId = args.flags.project || process.env.GOOGLE_CLOUD_PROJECT || process.env.DEVSHELL_PROJECT_ID;
  if (!projectId || typeof projectId !== 'string') {
    die('No project ID. Pass it as:  --project YOUR_FIREBASE_PROJECT_ID');
  }

  // Auth: impersonate the project's sheetsync-runner service account (set up by
  // run.sh / deploy-scheduled.sh). One identity for Sheets AND Firestore; the
  // user shares the sheet with it once. No OAuth consent, no key files.
  // Firestore comes from @google-cloud/firestore (accepts an authClient);
  // firebase-admin refuses non-ADC credentials for Firestore.
  const serviceAccount = process.env.SHEETSYNC_SA || args.flags.sa || `sheetsync-runner@${projectId}.iam.gserviceaccount.com`;
  const { makeAuth } = require('./lib/auth');
  const { authClient } = await makeAuth({ serviceAccount });
  // Pre-flight: mint one robot token NOW so auth problems surface here with a
  // clear remedy — and so a later sheet 403 can only mean "not shared yet".
  try { await authClient.getAccessToken(); }
  catch (e) { die(String(e.message || e)); }
  const sheets = google.sheets({ version: 'v4', auth: authClient });
  const { Firestore } = require('@google-cloud/firestore');
  const db = new Firestore({ projectId, authClient });

  // Read the spreadsheet: tab list + the data tab + the SheetSync tab.
  // Open the sheet — if the robot can't see it yet, guide the user through
  // sharing RIGHT HERE in the shell (print the exact email, wait, retry).
  let meta = null;
  for (let attempt = 1; !meta; attempt++) {
    try { meta = (await sheets.spreadsheets.get({ spreadsheetId })).data; }
    catch (e) {
      const denied = /403|PERMISSION_DENIED|does not have permission/i.test(String(e.message));
      if (!denied) die(`Could not open the sheet (${e.message}). Is the link/ID right?`);
      if (args.flags.auto || !process.stdin.isTTY || attempt >= 5) {
        die(`The sync robot can't see this sheet.\n  Share the sheet (Editor) with:  ${serviceAccount}\n  …then run this again.`);
      }
      say('\n┌──────────────────── ACTION NEEDED (one time) ────────────────────┐');
      say('│ The sync robot can\'t see your sheet yet. In your sheet, click     ');
      say('│ Share and add this email as **Editor**:                           ');
      say('│');
      say(`│     ${serviceAccount}`);
      say('│');
      say('└───────────────────────────────────────────────────────────────────┘');
      await confirm('Done? Press y when you\'ve shared the sheet');
      say('Checking again…');
    }
  }
  const titles = meta.sheets.map((s) => s.properties.title);
  const dataTabs = titles.filter((t) => !isConfigTab(t));
  if (dataTabs.length === 0) die('No data tabs found (only SheetSync config tabs). Add a tab with your data.');

  // ---- per-tab helpers (each tab in the file syncs to its own collection) ----
  const q = (t) => `'${String(t).replace(/'/g, "''")}'`;
  const keyFor = (tab) => `${spreadsheetId}__${tab}`.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 200);
  const readConfigTab = async (cfgName) => {
    if (!titles.includes(cfgName)) return null;
    return gridToConfig((await sheets.spreadsheets.values.get({ spreadsheetId, range: q(cfgName) })).data.values || []);
  };
  const writeConfigTab = async (cfgName, grid) => {
    if (!titles.includes(cfgName)) {
      await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title: cfgName } } }] } });
      titles.push(cfgName);
    }
    await sheets.spreadsheets.values.update({ spreadsheetId, range: `${q(cfgName)}!A1`, valueInputOption: 'RAW', requestBody: { values: grid } });
  };
  let collectionsCache = null;
  const gatherCollections = async () => {
    if (collectionsCache) return collectionsCache;
    const collections = [];
    for (const col of await db.listCollections()) {
      if (col.id.startsWith('_sheetSync')) continue;
      const sample = await col.limit(20).get();
      collections.push({ name: col.id, sampleDocs: sample.docs.map((d) => d.data()), docIds: sample.docs.map((d) => d.id) });
    }
    collectionsCache = collections; return collections;
  };

  // ---- rollback: undo the last sync of every tab ----
  if (args.flags.rollback) {
    let any = false;
    for (let i = 0; i < dataTabs.length; i++) {
      const tab = dataTabs[i];
      const state = await sync.loadState(db, keyFor(tab));
      const cfg = await readConfigTab(configTabNameFor(tab, i === 0, titles));
      if (!state.lastJobId || !cfg) continue;
      const r = await sync.rollback(db, cfg, keyFor(tab), state.lastJobId);
      say(`✔ ${tab}: rolled back ${r.restored} document(s).`); any = true;
    }
    if (!any) die('No previous sync to roll back.');
    return;
  }

  // ---- phase 1: ensure every data tab has a config; propose where missing ----
  const plans = []; // { tab, cfgName, snapshot }
  let created = 0;
  for (let i = 0; i < dataTabs.length; i++) {
    const tab = dataTabs[i];
    const grid = (await sheets.spreadsheets.values.get({ spreadsheetId, range: q(tab) })).data.values || [];
    if (grid.length < 2) { say(`(skipping "${tab}" — needs a header row and at least one data row)`); continue; }
    const snapshot = gridToSnapshot(grid);
    if (!snapshot.headers.length) { say(`(skipping "${tab}" — no header row with column names)`); continue; }
    snapshot.spreadsheetId = spreadsheetId; snapshot.tabName = tab; snapshot.snapshotVersion = Date.now();
    const cfgName = configTabNameFor(tab, i === 0, titles);
    const config = await readConfigTab(cfgName);
    if (!config || !config.targetCollection) {
      const collections = await gatherCollections();
      const result = analyze(snapshot, collections, []);
      if (process.env.GEMINI_API_KEY) {
        const { aiFieldMap } = require('./lib/engine').aimap;
        const chosen = collections.find((c) => c.name === result.proposal.targetCollection);
        const existing = chosen ? [...new Set(chosen.sampleDocs.flatMap((d) => Object.keys(d || {})))] : [];
        const ai = await aiFieldMap({ apiKey: process.env.GEMINI_API_KEY, headers: snapshot.headers, sampleRows: snapshot.rows, existingFields: existing });
        if (ai) result.fieldMap = { ...result.fieldMap, ...ai };
      }
      await writeConfigTab(cfgName, proposalToGrid({ ...result.proposal, allowDeletes: false, fieldMap: result.fieldMap }));
      say(`✔ Created "${cfgName}" for tab "${tab}" → proposes /${result.proposal.targetCollection} (confidence ${result.confidence}).`);
      created++;
    }
    plans.push({ tab, cfgName, snapshot });
  }
  if (plans.length === 0) die('No syncable tabs (each needs a header row + at least one data row).');

  // ---- phase 2: one review pause if we just proposed any config ----
  if (created > 0) {
    if (args.flags.auto || !process.stdin.isTTY) {
      say(`\nReview the SheetSync config tab(s) in your spreadsheet, then run this command again to sync.`);
      return;
    }
    say(`\nOpen the SheetSync config tab(s) and review the mapping(s). Edit anything you disagree with (or nothing).`);
    if (!(await confirm('Reviewed? Press y to continue to the sync'))) { say('Stopped. Run again when ready.'); return; }
  }

  // ---- phase 3: sync each tab independently ----
  const multi = plans.length > 1;
  const done = [];
  for (const { tab, cfgName, snapshot } of plans) {
    if (multi) say(`\n──────── Tab: ${tab} ────────`);
    const r = await syncOneTab({ sheets, db, spreadsheetId, projectId, args, auto: Boolean(args.flags.auto), q, confirm, say }, { tab, cfgName, snapshot, keyFor });
    if (r) done.push(r);
  }

  // ---- one footer: where to change things ----
  if (done.length) {
    say('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    say('Where to change things:');
    say('   • Mapping / collection / key / deletes → edit the matching "SheetSync (…)" tab, then re-run');
    say('   • Sync again after editing the sheet   → same command');
    say(`   • Undo the last sync (all tabs)        → ./run.sh "${args.sheet}" --project ${projectId} --rollback`);
    say(`   • Automatic-sync schedule              → https://console.cloud.google.com/cloudscheduler?project=${projectId}`);
    say('   • Customize this tool                  → all the code is in this folder; in Cloud Shell click "Open Editor" and edit any file');
    say('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  }
}

/** Sync one data tab: structure reconcile → plan → preview → confirm → apply → summary. Never process-exits (one tab's issue must not kill the others). */
async function syncOneTab(ctx, { tab, cfgName, snapshot, keyFor }) {
  const { sheets, db, spreadsheetId, projectId, args, auto, q, confirm, say } = ctx;
  const key = keyFor(tab);
  let config = gridToConfig((await sheets.spreadsheets.values.get({ spreadsheetId, range: q(cfgName) })).data.values || []);
  if (!config || !config.targetCollection) { say(`  (skipping "${tab}" — its "${cfgName}" tab is incomplete)`); return null; }

  // Structure-change check: only re-map when COLUMNS change.
  const existingFields = await existingFieldsOf(db, config.targetCollection);
  const aiPropose = process.env.GEMINI_API_KEY
    ? (newCols) => require('./lib/engine').aimap.aiFieldMap({ apiKey: process.env.GEMINI_API_KEY, headers: newCols, sampleRows: snapshot.rows.slice(0, 5), existingFields })
    : undefined;
  const recon = await reconcileStructure(config, snapshot.headers, existingFields, aiPropose);
  if (recon.changed) {
    Object.assign(config, recon.config);
    try {
      await sheets.spreadsheets.values.update({ spreadsheetId, range: `${q(cfgName)}!A1`, valueInputOption: 'RAW', requestBody: { values: proposalToGrid({ ...config, fieldMap: config.fieldMap }) } });
      say(`  structure changed: added ${recon.newColumns.length} new column(s) (${recon.newColumns.join(', ')}) to "${cfgName}".`);
    } catch (_e) {
      say(`  structure changed: mapped ${recon.newColumns.length} new column(s) this run (couldn't persist to the tab — share as Editor).`);
    }
  }

  const built = await sync.plan(db, config, snapshot, key);
  const p = built.preview;
  if (built.plan.fatal) { say(`  ✗ ${tab}: ${built.plan.fatal}`); return null; }
  say(`  Preview /${config.targetCollection}: creates ${p.creates} · updates ${p.updates} · unchanged ${p.unchanged} · errors ${p.blockedRows} · blank-blocked ${p.blankOverwritesBlocked} · deletes ${p.deletes}`);
  for (const e of built.plan.errors.slice(0, 10)) say(`    ! ${e.sid}: ${e.error}`);
  if (p.creates + p.updates + p.deletes === 0) { say(`  ${tab}: already up to date.`); return { tab, collection: config.targetCollection, written: 0, deleted: 0 }; }

  if (auto && (p.deletes > 0 || p.blockedRows > 0 || p.blankOverwritesBlocked > 0)) {
    say(`  (auto) "${tab}" has risky changes (deletes/errors/blanks) — held for review; not auto-applied.`); return null;
  }
  const confirmDeletes = Boolean(args.flags.yes) || (p.deletes > 0 && await confirm(`  This will DELETE ${p.deletes} document(s) in /${config.targetCollection}. Continue?`));
  if (!auto && !args.flags.yes) {
    if (!(await confirm(`  Apply to /${config.targetCollection}?`))) { say(`  ${tab}: cancelled.`); return null; }
  }
  const res = await sync.apply(db, config, built, key, { confirmDeletes: p.deletes > 0 ? confirmDeletes : true });
  if (res.needsDeleteConfirm) { say(`  ${tab}: deletes not confirmed — nothing written.`); return null; }
  if (res.error) { say(`  ✗ ${tab}: ${res.error}`); return null; }

  const consoleUrl = `https://console.firebase.google.com/project/${projectId}/firestore/databases/-default-/data/~2F${encodeURIComponent(config.targetCollection)}`;
  const parts = [];
  if (p.creates) parts.push(`${p.creates} created`);
  if (p.updates) parts.push(`${p.updates} updated`);
  if (res.deleted) parts.push(`${res.deleted} deleted`);
  if (p.unchanged) parts.push(`${p.unchanged} unchanged`);
  say(`  ✔ ${tab} → /${config.targetCollection}: ${parts.join(', ')}.  ${consoleUrl}`);
  return { tab, collection: config.targetCollection, written: res.written, deleted: res.deleted };
}

main().catch((e) => die(e.message));
