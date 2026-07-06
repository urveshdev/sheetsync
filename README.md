# SheetSync

Sync a **Google Sheet** into your **Firebase (Firestore)** database — safely and on your terms. Every sync shows a preview before it writes, protects against accidental deletes and overwrites, and can be undone with a single command. Everything runs inside **your own** Google and Firebase account: nothing is installed on your machine, no keys or passwords are shared, and your data never passes through anyone else's servers.

> Free and open source ([MIT](LICENSE)). Contributions welcome.

## Contents

- [Requirements](#requirements)
- [Setup](#setup)
- [Everyday use](#everyday-use)
- [Command reference](#command-reference)
- [Automatic sync](#automatic-sync)
- [Customizing](#customizing)
- [How it works](#how-it-works)
- [Troubleshooting](#troubleshooting)

## Requirements

- A **Google account**
- A **Firebase project** on the Blaze (pay-as-you-go) plan — normal use stays within Google's free tier
- A **Google Sheet** with a heading row

## Setup

Roughly five minutes, done once.

### 1. Open the tool in Cloud Shell

[Google Cloud Shell](https://shell.cloud.google.com) is a free, browser-based terminal tied to your Google account — nothing is installed on your computer.

**One click:**

[![Open in Cloud Shell](https://gstatic.com/cloudssh/images/open-btn.svg)](https://console.cloud.google.com/cloudshell/open?git_repo=https://github.com/urveshdev/sheetsync&cloudshell_working_dir=cli&cloudshell_command=./run.sh)

This opens Cloud Shell, clones the repo, and starts the tool. Or do it manually:

```bash
git clone https://github.com/urveshdev/sheetsync.git
cd sheetsync/cli
./run.sh
```

It will prompt you to sign in with Google (tick every checkbox), paste your Google Sheet's link, and enter your Firebase project name (found at [console.firebase.google.com](https://console.firebase.google.com) → your project → **Settings**).

### 2. Share your sheet (one time)

The tool creates a **helper account** in your project and prints its email address, for example:

```
sheetsync-runner@your-project.iam.gserviceaccount.com
```

In your Google Sheet, click **Share**, add that email as an **Editor**, and send. This works exactly like sharing with a colleague — it is the only access the tool ever has, and un-sharing revokes it instantly.

### 3. Review the plan and sync

The tool adds a **SheetSync** tab to your spreadsheet showing how each column maps to a database field. Review it (adjust anything, or leave it as proposed). The tool then displays a preview — for example, *"8 new, 2 changed, 0 deleted"* — and asks for confirmation before writing anything. Confirm, and your rows appear in Firestore.

From then on the routine is simply: **edit your sheet → run the tool → done.**

## Everyday use

| Goal | Action |
|---|---|
| Sync your latest changes | Run `./run.sh` again |
| Change how a column maps | Edit the **SheetSync** tab, then run again |
| Skip a column | Set its **Sync?** cell to `no` in the SheetSync tab |
| Undo the last sync | `./run.sh --rollback` |
| Sync automatically on a schedule | Accept the prompt after a sync (see [Automatic sync](#automatic-sync)) |
| Sync several tabs in one file | Automatic — each tab gets its own settings and its own database collection |

By design, the tool never deletes a document unless you enable deletions and confirm them, never overwrites a filled-in value with a blank, and re-examines your column setup only when a column is actually added or removed.

## Command reference

```
./run.sh [SHEET_URL] [--project PROJECT_ID] [options]
```

| Option | Effect |
|---|---|
| *(none)* | Show a preview, then ask before writing |
| `--yes` | Skip the confirmation prompt (deletions still require explicit confirmation) |
| `--auto` | Apply only safe changes (new and changed rows); hold anything risky. Used by scheduled runs. |
| `--rollback` | Undo the last sync, restoring every affected document |
| `--project ID` | Your Firebase project (defaults to the Cloud Shell project) |

If you omit `SHEET_URL` and `--project`, the tool asks for them interactively.

## Automatic sync

To keep a sheet in sync without running anything yourself, provision a scheduled job in your own project:

```bash
./deploy-scheduled.sh "SHEET_URL" --project PROJECT_ID                       # hourly
./deploy-scheduled.sh "SHEET_URL" --project PROJECT_ID --every "*/5 * * * *"  # every 5 minutes
```

This deploys a Cloud Run job and a Cloud Scheduler trigger inside your project, then prints a helper-account email — share your sheet with that address so the scheduled job can read it. Cost is negligible (seconds of compute per run; Cloud Scheduler's first three jobs are free). Scheduled runs apply only safe changes; anything risky (deletions, data errors) waits for you to run the tool manually and confirm.

Manage or pause the schedule at **console.cloud.google.com/cloudscheduler**.

## Customizing

The template is yours to modify — every file is plain, readable code with nothing locked or obfuscated. In Cloud Shell, click **Open Editor** to change any file; save and run `./run.sh` again for the change to take effect.

| File | Controls |
|---|---|
| `cli/sheetsync.js` | The overall flow, prompts, and on-screen messages |
| `cli/lib/sync.js` | How rows are written to Firestore, and rollback |
| `cli/lib/sheet.js` | How the heading row is detected |
| `cli/lib/configtab.js` | The layout of the SheetSync settings tab |
| `cli/lib/structure.js` | When the column setup is re-examined |
| `cli/lib/engine/analyzer.js` | How columns are matched to fields, and collection-name selection |
| `cli/lib/engine/planner.js` | The safety rules (preview, blank protection, deletions, changed-rows-only) |
| `cli/lib/engine/aimap.js` | Optional AI-assisted column mapping (Gemini), used only when enabled |

## How it works

You run open-source-style code, signed in as yourself, that reads your sheet through Google's own trusted sign-in and writes to your Firestore directly. There is no SheetSync server and no third party in the data path. Key characteristics:

- **You stay in control** — a preview precedes every write, and any sync is reversible with `--rollback`.
- **Nothing is shared** — no service-account keys, no data routed through external servers.
- **Handles real sheets** — finds your heading row even with title rows above it, and syncs multiple tabs.
- **Not a live mirror** — it syncs when you run it, or on the schedule you set.
- **Sized for admin/catalog data** — thousands of rows, not millions.

## Troubleshooting

| Problem | Fix |
|---|---|
| *"This app is blocked"* at sign-in | You're on an old copy — pull the latest (`git pull`) and re-run; the current version never requests sensitive permissions at sign-in. |
| *The tool can't read my sheet* | Share the sheet (Editor) with the helper-account email the tool printed, then re-run. |
| *"Application credentials… unusable"* | Run `gcloud auth application-default login` (tick all boxes), then re-run. |
| A row won't sync | Check the preview's error line — usually a value that doesn't match its column's type. Fix the cell. |
| Want to undo a sync | `./run.sh --rollback`. |

To remove the tool entirely: un-share your sheet from the helper account, and delete that account in the Firebase/Google Cloud console. Sync bookkeeping lives under a `_sheetSync` collection in your Firestore and can be deleted anytime.
