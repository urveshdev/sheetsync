#!/usr/bin/env bash
#
# SheetSync — set up AUTOMATIC hourly sync with no machine of your own running.
# Deploys the CLI as a Cloud Run JOB and a Cloud Scheduler trigger, all in YOUR
# project. After this, your sheet syncs on a schedule by itself.
#
#   ./deploy-scheduled.sh <sheet-url> --project ID [--region us-central1] [--every "0 * * * *"]
#
# One manual step it prints at the end: share your sheet (Viewer) with the
# job's service-account email, so the scheduled job can read it.
#
set -euo pipefail
cd "$(dirname "$0")"
say(){ printf '\n\033[1m== %s\033[0m\n' "$*"; }
note(){ printf '   %s\n' "$*"; }
fail(){ printf '\n\033[31mx %s\033[0m\n' "$*"; exit 1; }

SHEET=""; PROJECT=""; REGION="us-central1"; CRON="0 * * * *"
while [ $# -gt 0 ]; do case "$1" in
  --project) PROJECT="$2"; shift 2;;
  --region) REGION="$2"; shift 2;;
  --every) CRON="$2"; shift 2;;
  --*) shift;;
  *) [ -z "$SHEET" ] && SHEET="$1"; shift;;
esac; done
[ -n "$SHEET" ] || fail "Pass your sheet URL."
[ -n "$PROJECT" ] || PROJECT="${GOOGLE_CLOUD_PROJECT:-}"
[ -n "$PROJECT" ] || fail "Pass --project YOUR_FIREBASE_PROJECT_ID."
command -v gcloud >/dev/null 2>&1 || fail "gcloud required (Cloud Shell has it)."

# Per-sheet names so multiple spreadsheets can each have their own schedule.
# shellcheck source=lib/naming.sh
. "$(dirname "$0")/lib/naming.sh"
JOB="$(job_name_of "$SHEET")"
SCHED="$(sched_name_of "$SHEET")"
SA="sheetsync-runner@${PROJECT}.iam.gserviceaccount.com"

say "1. Enable APIs"
gcloud services enable run.googleapis.com cloudscheduler.googleapis.com sheets.googleapis.com \
  cloudbuild.googleapis.com artifactregistry.googleapis.com iam.googleapis.com --project "$PROJECT"

say "2. Service account for the job (reads your sheet, writes Firestore)"
gcloud services enable iamcredentials.googleapis.com --project "$PROJECT" >/dev/null 2>&1 || true
gcloud iam service-accounts describe "$SA" --project "$PROJECT" >/dev/null 2>&1 || \
  gcloud iam service-accounts create sheetsync-runner --display-name "SheetSync runner" --project "$PROJECT"
gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$SA" \
  --role roles/datastore.user --condition=None >/dev/null
# The job impersonates ITSELF to mint Sheets-scoped tokens (metadata tokens
# don't carry Workspace scopes) — needs tokenCreator on itself.
gcloud iam service-accounts add-iam-policy-binding "$SA" --project "$PROJECT" \
  --member "serviceAccount:$SA" --role roles/iam.serviceAccountTokenCreator --condition=None >/dev/null

say "3. Deploy the Cloud Run job (builds from this folder)"
# The engine lives in ./lib/engine/ (committed) — the container is
# self-contained; nothing to vendor.
gcloud run jobs deploy "$JOB" \
  --source . --region "$REGION" --project "$PROJECT" \
  --service-account "$SA" \
  --set-env-vars "SHEET=${SHEET},GOOGLE_CLOUD_PROJECT=${PROJECT},SHEETSYNC_AUTO=1,SHEETSYNC_SA=${SA}" \
  --max-retries 1

say "4. Schedule it ($CRON)"
gcloud projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$SA" \
  --role roles/run.invoker --condition=None >/dev/null
URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs/${JOB}:run"
if gcloud scheduler jobs describe "$SCHED" --location "$REGION" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "$SCHED" --location "$REGION" --project "$PROJECT" \
    --schedule "$CRON" --uri "$URI" --http-method POST --oauth-service-account-email "$SA"
else
  gcloud scheduler jobs create http "$SCHED" --location "$REGION" --project "$PROJECT" \
    --schedule "$CRON" --uri "$URI" --http-method POST --oauth-service-account-email "$SA"
fi

say "Done — one manual step"
note "Share your Google Sheet (Viewer is enough) with this address:"
note ""
note "    $SA"
note ""
note "After that, your sheet syncs automatically on schedule ($CRON)."
note "Run once now:  gcloud run jobs execute $JOB --region $REGION --project $PROJECT"
note "Change frequency: re-run with --every \"*/5 * * * *\" (every 5 min), etc."
