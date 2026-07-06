#!/usr/bin/env bash
#
# SheetSync — one command. Reads your Google Sheet and syncs it to YOUR
# Firestore. No add-on, no extension, no OAuth consent screens, no key files.
#
#   ./run.sh [sheet-url] [--project ID] [--auto] [--yes] [--rollback]
#
# How access works: a small "robot" service account (sheetsync-runner@…) is
# created inside YOUR project; you share the sheet with it once (like sharing
# with a colleague). The script impersonates it — no keys ever exist.
#
set -euo pipefail
cd "$(dirname "$0")"
say(){ printf '\n\033[1m== %s\033[0m\n' "$*"; }
note(){ printf '   %s\n' "$*"; }
fail(){ printf '\n\033[31mx %s\033[0m\n' "$*"; exit 1; }

note "SheetSync CLI v2 (sync-robot auth — never requests Sheets scopes at sign-in)"
command -v node >/dev/null 2>&1 || fail "Node.js required (Cloud Shell has it)."
command -v gcloud >/dev/null 2>&1 || fail "gcloud required (Cloud Shell has it; locally: cloud.google.com/sdk)."
# Self-check: refuse to run if this working copy is stale (belt & braces for
# Cloud Shell, which reuses an old clone without pulling).
if git rev-parse --git-dir >/dev/null 2>&1; then
  git fetch -q origin main 2>/dev/null || true
  L="$(git rev-parse HEAD 2>/dev/null)"; R="$(git rev-parse origin/main 2>/dev/null)"
  if [ -n "$R" ] && [ "$L" != "$R" ]; then
    note "Updating to the latest version…"
    git pull -q --ff-only origin main 2>/dev/null && exec "$0" "$@" || note "(couldn't auto-update — run 'git pull' manually if anything misbehaves)"
  fi
fi

# ---------- gather sheet + project ----------
ARGS=("$@"); SHEET=""; PROJECT=""
for a in "$@"; do case "$a" in
  --project) :;; --project=*) PROJECT="${a#--project=}";;
  https://*|*/d/*) SHEET="$a";;
esac; done
# --project VALUE form
prev=""; for a in "$@"; do [ "$prev" = "--project" ] && PROJECT="$a"; prev="$a"; done
if [ -z "$SHEET" ]; then
  printf '\nPaste your Google Sheet link: '; read -r SHEET
  [ -n "$SHEET" ] || fail "No sheet link given."
  ARGS=("$SHEET" "${ARGS[@]}")
fi
if [ -z "$PROJECT" ]; then
  DEF="${GOOGLE_CLOUD_PROJECT:-}"
  printf 'Your Firebase project ID%s: ' "${DEF:+ [$DEF]}"; read -r PROJECT
  PROJECT="${PROJECT:-$DEF}"
  [ -n "$PROJECT" ] || fail "No project ID given."
  ARGS+=("--project" "$PROJECT")
fi

# ---------- dependencies first (the sign-in probe below needs them) ----------
[ -d node_modules ] || { say "Installing dependencies (once)"; npm install --no-fund --no-audit >/dev/null; }

# ---------- sign in (plain — no sensitive scopes, so Google never blocks it) ----------
# CRITICAL: validate the application credential with NODE, not gcloud — a
# half-written ADC file can satisfy gcloud but crash Node's auth library with
# "Cannot create property 'refresh_token' on string ''" (seen live). If the
# probe fails, a fresh application-default login rewrites the file.
# shellcheck source=lib/adc.sh
. "$(dirname "$0")/lib/adc.sh"

say "Checking Google sign-in"
if ! gcloud auth print-access-token >/dev/null 2>&1; then
  note "A browser window will open — one sign-in covers everything."
  gcloud auth login --update-adc
fi
if ! adc_ok; then
  note "Refreshing application credentials (a previous sign-in left them unusable)…"
  gcloud auth application-default login
  adc_ok || fail "Application credentials still unusable even after re-login.
  gcloud saved them at: ${CLOUDSDK_CONFIG:-~/.config/gcloud}/application_default_credentials.json
  Please paste this whole message to your support contact."
fi
# Attach a quota project — without it, IAM-Credentials/Sheets calls made with
# user ADC can fail with 'quota project' / 'API not enabled' errors (the
# warning gcloud printed at sign-in). Harmless if already set.
gcloud auth application-default set-quota-project "$PROJECT" >/dev/null 2>&1 || true
export_adc_path || true

# ---------- the sync robot (service account in YOUR project) ----------
SA="sheetsync-runner@${PROJECT}.iam.gserviceaccount.com"
say "Setting up the sync robot in $PROJECT"
gcloud services enable iamcredentials.googleapis.com sheets.googleapis.com firestore.googleapis.com \
  --project "$PROJECT" >/dev/null 2>&1 || true
FIRST_TIME=""
if ! gcloud iam service-accounts describe "$SA" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud iam service-accounts create sheetsync-runner --display-name "SheetSync runner" --project "$PROJECT" >/dev/null
  FIRST_TIME=1
fi
ME="$(gcloud config get-value account 2>/dev/null)"
gcloud iam service-accounts add-iam-policy-binding "$SA" --project "$PROJECT" \
  --member "user:$ME" --role roles/iam.serviceAccountTokenCreator --condition=None >/dev/null 2>&1 || true
gcloud projects add-iam-policy-binding "$PROJECT" \
  --member "serviceAccount:$SA" --role roles/datastore.user --condition=None >/dev/null 2>&1 || true

if [ -n "$FIRST_TIME" ]; then
  printf '\n\033[1m┌──────────────────────── ACTION NEEDED (one time) ────────────────────────┐\033[0m\n'
  printf '\033[1m│\033[0m Share your Google Sheet (as Editor) with this email, like a colleague:\n'
  printf '\033[1m│\033[0m\n'
  printf '\033[1m│\033[0m     %s\n' "$SA"
  printf '\033[1m│\033[0m\n'
  printf '\033[1m│\033[0m Sheet → Share button → paste the email → Editor → Send.\n'
  printf '\033[1m│\033[0m Then run this command again.\n'
  printf '\033[1m└───────────────────────────────────────────────────────────────────────────┘\033[0m\n\n'
  exit 0
fi
note "Sync robot ready: $SA (sheet must be shared with it — Editor)"

# ---------- go ----------
export SHEETSYNC_SA="$SA"
SKIP_OFFER=""
for a in "$@"; do case "$a" in --auto|--rollback) SKIP_OFFER=1;; esac; done

if node sheetsync.js "${ARGS[@]}"; then
  # ---------- same-flow scheduling offer (everything in ONE step) ----------
  if [ -t 0 ] && [ -z "$SKIP_OFFER" ]; then
    . "$(dirname "$0")/lib/naming.sh"
    if gcloud scheduler jobs describe "$(sched_name_of "$SHEET")" --location us-central1 --project "$PROJECT" >/dev/null 2>&1; then
      note "Automatic sync is ON (hourly). Manage/pause: https://console.cloud.google.com/cloudscheduler?project=$PROJECT"
    else
      printf '\nWant this to sync AUTOMATICALLY every hour (runs inside your own project, ~$0)? [y/N] '
      read -r yn
      if printf '%s' "$yn" | grep -qi '^y'; then
        ./deploy-scheduled.sh "$SHEET" --project "$PROJECT" || \
          note "Automatic setup hit a snag — manual sync still works; re-run ./deploy-scheduled.sh anytime."
      else
        note "Staying manual. Enable automatic sync later with:  ./deploy-scheduled.sh \"$SHEET\" --project $PROJECT"
      fi
    fi
  fi
fi
