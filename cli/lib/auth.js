'use strict';

/**
 * Robot auth without key files and without google-auth-library's Impersonated
 * class (which crashed live with "unable to impersonate: TypeError: Cannot
 * create property 'refresh_token' on string ''" on some ADC credential types).
 *
 * We mint the robot's access token OURSELVES via the IAM Credentials REST API
 * (projects/-/serviceAccounts/{SA}:generateAccessToken) using whatever base
 * ADC exists (user login, Cloud Shell, or the Cloud Run job's own identity),
 * cache it, and refresh before expiry. The resulting client plugs into both
 * googleapis (Sheets) and @google-cloud/firestore via getRequestHeaders().
 */

const { GoogleAuth, OAuth2Client } = require('google-auth-library');

const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/cloud-platform',
];

class RobotAuth extends OAuth2Client {
  /**
   * @param {object} sourceClient any auth client with .request() (base ADC)
   * @param {string} targetPrincipal the robot SA email
   * @param {string[]} scopes
   */
  constructor(sourceClient, targetPrincipal, scopes = SCOPES) {
    super();
    this.sourceClient = sourceClient;
    this.targetPrincipal = targetPrincipal;
    this.scopes_ = scopes;
    this._token = null;
    this._expiry = 0;
  }

  async getAccessToken() {
    if (this._token && Date.now() < this._expiry - 60_000) {
      return { token: this._token };
    }
    const url = `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(this.targetPrincipal)}:generateAccessToken`;
    let res;
    try {
      res = await this.sourceClient.request({
        url, method: 'POST',
        data: { scope: this.scopes_, lifetime: '3600s' },
      });
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/403|PERMISSION_DENIED/i.test(msg)) {
        throw new Error(`cannot act as the sync robot (${this.targetPrincipal}). ` +
          'Re-run ./run.sh once to grant access (the permission can take ~1 minute to propagate).');
      }
      throw new Error(`could not mint a robot token: ${msg}. Try:  gcloud auth application-default login`);
    }
    this._token = res.data.accessToken;
    this._expiry = res.data.expireTime ? Date.parse(res.data.expireTime) : Date.now() + 3300_000;
    return { token: this._token };
  }

  async getRequestHeaders() {
    const { token } = await this.getAccessToken();
    return { Authorization: `Bearer ${token}` };
  }

  // Some transports (gax) probe these; keep them harmless.
  async getRequestMetadataAsync() { return { headers: await this.getRequestHeaders() }; }
}

async function makeAuth({ serviceAccount }) {
  let sourceClient;
  // Escape hatch for CI / broken-ADC environments: use a pre-obtained
  // cloud-platform access token (e.g. `gcloud auth print-access-token`) as the
  // base credential instead of Application Default Credentials.
  if (process.env.SHEETSYNC_BASE_TOKEN) {
    sourceClient = new OAuth2Client();
    sourceClient.setCredentials({ access_token: process.env.SHEETSYNC_BASE_TOKEN });
  } else {
    sourceClient = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient();
  }
  if (!serviceAccount) return { authClient: sourceClient, viaImpersonation: false };
  return { authClient: new RobotAuth(sourceClient, serviceAccount), viaImpersonation: true };
}

module.exports = { makeAuth, RobotAuth, SCOPES };
