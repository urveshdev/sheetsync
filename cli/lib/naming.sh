# SheetSync — shared naming helpers (sourced by run.sh and deploy-scheduled.sh).
#
# Cloud Run jobs / Scheduler entries are named PER SHEET, so scheduling a
# second spreadsheet never overwrites the first one's schedule (live-class
# bug: fixed names meant one schedule per project, silently replaced).

# Extract the spreadsheet ID from a URL (or pass an ID through).
sheet_id_of() {
  printf '%s' "$1" | sed -nE 's#.*/d/([a-zA-Z0-9_-]+).*#\1#p' | grep . || printf '%s' "$1"
}

# Stable, name-safe suffix for a sheet (cksum: portable, deterministic).
sheet_suffix_of() {
  printf '%s' "$(sheet_id_of "$1")" | cksum | cut -d' ' -f1
}

job_name_of() { printf 'sheetsync-sync-%s' "$(sheet_suffix_of "$1")"; }
sched_name_of() { printf 'sheetsync-hourly-%s' "$(sheet_suffix_of "$1")"; }
