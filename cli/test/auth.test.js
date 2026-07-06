'use strict';

/**
 * REGRESSION (live, 2026-07-06): google-auth-library's Impersonated class
 * crashed with "unable to impersonate: TypeError: Cannot create property
 * 'refresh_token' on string ''". We now mint robot tokens ourselves via the
 * IAM Credentials REST API. These tests pin that path with a stubbed source
 * client — no network, no real credentials.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { RobotAuth } = require('../lib/auth');

const SA = 'sheetsync-runner@p.iam.gserviceaccount.com';

function stubSource(responder) {
  const calls = [];
  return { calls, request: async (opts) => { calls.push(opts); return responder(opts); } };
}

test('mints a robot token via generateAccessToken and sends it as a Bearer header', async () => {
  const src = stubSource(async (opts) => {
    assert.match(opts.url, /iamcredentials\.googleapis\.com/);
    assert.match(opts.url, new RegExp(encodeURIComponent(SA)));
    assert.deepEqual(opts.data.scope.includes('https://www.googleapis.com/auth/spreadsheets'), true,
      'must request the Sheets scope (the whole reason impersonation exists)');
    return { data: { accessToken: 'robot-tok-1', expireTime: new Date(Date.now() + 3600e3).toISOString() } };
  });
  const auth = new RobotAuth(src, SA);
  const headers = await auth.getRequestHeaders();
  assert.equal(headers.Authorization, 'Bearer robot-tok-1');
});

test('caches the token — repeated calls do not re-mint until near expiry', async () => {
  const src = stubSource(async () => ({ data: { accessToken: 't', expireTime: new Date(Date.now() + 3600e3).toISOString() } }));
  const auth = new RobotAuth(src, SA);
  await auth.getAccessToken(); await auth.getAccessToken(); await auth.getRequestHeaders();
  assert.equal(src.calls.length, 1, 'one mint, then cache');
});

test('re-mints when the cached token is about to expire', async () => {
  let n = 0;
  const src = stubSource(async () => ({ data: { accessToken: `t${++n}`, expireTime: new Date(Date.now() + 30e3).toISOString() } }));
  const auth = new RobotAuth(src, SA);
  await auth.getAccessToken();
  const second = await auth.getAccessToken();
  assert.equal(second.token, 't2', 'near-expiry token refreshed');
});

test('403 from IAM Credentials maps to a clear "re-run to grant access" message', async () => {
  const src = stubSource(async () => { const e = new Error('Request failed with status code 403 PERMISSION_DENIED'); throw e; });
  const auth = new RobotAuth(src, SA);
  await assert.rejects(() => auth.getAccessToken(), /re-run \.\/run\.sh once to grant access/i);
});

test('other mint failures point at application-default login (the base credential)', async () => {
  const src = stubSource(async () => { throw new Error('invalid_grant: token expired'); });
  const auth = new RobotAuth(src, SA);
  await assert.rejects(() => auth.getAccessToken(), /gcloud auth application-default login/);
});

test('SHEETSYNC_BASE_TOKEN escape hatch: builds impersonation auth without needing ADC', async () => {
  const { makeAuth } = require('../lib/auth');
  process.env.SHEETSYNC_BASE_TOKEN = 'fake-cloud-platform-token';
  try {
    const { authClient, viaImpersonation } = await makeAuth({ serviceAccount: 'sheetsync-runner@p.iam.gserviceaccount.com' });
    assert.equal(viaImpersonation, true);
    assert.equal(typeof authClient.getRequestHeaders, 'function', 'returns a usable RobotAuth');
  } finally { delete process.env.SHEETSYNC_BASE_TOKEN; }
});
