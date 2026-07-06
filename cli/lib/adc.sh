# SheetSync — ADC environment helpers (sourced by run.sh; unit-tested directly).
#
# gcloud writes application-default credentials into $CLOUDSDK_CONFIG, which
# some Cloud Shell sessions point at a TEMP directory, while Node's auth
# library only searches the standard path. These helpers find the file
# wherever gcloud actually put it and point Node at it via
# GOOGLE_APPLICATION_CREDENTIALS.

# Locate the ADC file (CLOUDSDK_CONFIG first, then the standard path) and
# export GOOGLE_APPLICATION_CREDENTIALS. Returns 1 if none found.
export_adc_path() {
  local p
  for p in "${CLOUDSDK_CONFIG:-/nonexistent}/application_default_credentials.json" \
           "$HOME/.config/gcloud/application_default_credentials.json"; do
    if [ -f "$p" ]; then
      export GOOGLE_APPLICATION_CREDENTIALS="$p"
      return 0
    fi
  done
  return 1
}

# True if Node (the SAME library the CLI uses) can mint a token from ADC.
adc_ok() {
  export_adc_path || true
  node -e '
    const { GoogleAuth } = require("google-auth-library");
    (async () => {
      const a = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
      const c = await a.getClient();
      const t = await c.getAccessToken();
      if (!t || !(t.token || typeof t === "string")) process.exit(1);
    })().catch(() => process.exit(1));
  ' >/dev/null 2>&1
}
