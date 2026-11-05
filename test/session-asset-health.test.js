'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { DEFAULT_AT_PROBE_PROXY, probeSessionAsset, probeSessionAssets } = require('../src/session-asset-health');
const { SessionAssetStore } = require('../src/session-asset-store');

function response(status, payload = {}) {
  return {
    response: {
      status,
      url: 'https://chatgpt.com/backend-api/me',
      location: '',
      contentType: 'application/json',
      text: JSON.stringify(payload),
    },
  };
}

test('AT probe uses the fixed local proxy and profile without sending saved cookies', async () => {
  let captured;
  const result = await probeSessionAsset({
    id: 'asset-health-fixture',
    email: 'person@example.test',
    accountId: 'account-health',
    accessToken: 'access-health-secret',
    cookieJar: { cookies: [{ key: 'session-token', value: 'must-not-be-sent' }] },
    oaiDid: 'device-health',
    sourceProxy: { url: 'http://127.0.0.1:4001' },
  }, {
    now: () => 1000,
    executor: async (request, options) => {
      captured = { request, options };
      return response(200, { email: 'person@example.test', account_id: 'account-health' });
    },
  });

  assert.equal(result.status, 'healthy');
  assert.equal(result.code, 'AT_VALID');
  assert.equal(result.httpStatus, 200);
  assert.equal(captured.options.proxy, DEFAULT_AT_PROBE_PROXY);
  assert.equal(captured.request.headers.Authorization, 'Bearer access-health-secret');
  assert.equal(captured.request.headers['oai-device-id'], 'device-health');
  assert.equal(Object.keys(captured.request.headers).some((name) => name.toLowerCase() === 'cookie'), false);
  assert.equal(JSON.stringify(captured.options.cookieJar).includes('must-not-be-sent'), false);
});

test('AT probe accepts an explicit proxy override for diagnostics', async () => {
  let proxy = '';
  await probeSessionAsset({
    id: 'asset-health-override',
    email: 'person@example.test',
    accessToken: 'access-health-override',
  }, {
    proxy: 'http://127.0.0.1:4001',
    executor: async (_request, options) => {
      proxy = options.proxy;
      return response(200, { email: 'person@example.test' });
    },
  });
  assert.equal(proxy, 'http://127.0.0.1:4001');
});

test('AT probe distinguishes invalid, uncertain, missing, and mismatched assets', async () => {
  const base = { id: 'asset-health-status', email: 'person@example.test', accessToken: 'access-status' };
  const run = (status, payload) => probeSessionAsset(base, {
    now: () => 2000,
    executor: async () => response(status, payload),
  });

  assert.equal((await run(401)).status, 'invalid');
  assert.equal((await run(403)).status, 'uncertain');
  assert.equal((await run(429)).code, 'AT_RATE_LIMITED');
  assert.equal((await run(503)).code, 'AT_SERVICE_UNAVAILABLE');
  assert.equal((await run(200, { email: 'other@example.test' })).status, 'mismatch');
  assert.equal((await run(200, {})).code, 'AT_IDENTITY_UNVERIFIED');
  assert.equal((await probeSessionAsset({ ...base, accessToken: '' }, { now: () => 2000 })).status, 'missing');
});

test('batch AT probe persists sanitized health metadata for every asset', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-health-'));
  const store = new SessionAssetStore({ cwd, stateDir: '.state', cpaDir: '.state/output' });
  t.after(() => { store.close(); fs.rmSync(cwd, { recursive: true, force: true }); });
  const first = store.upsert({ email: 'first@example.test', accountId: 'account-first', accessToken: 'token-first' });
  const second = store.upsert({ email: 'second@example.test', accountId: 'account-second', accessToken: 'token-second' });

  const batch = await probeSessionAssets(store, [first.id, second.id], {
    concurrency: 2,
    now: () => 3000,
    executor: async (request) => {
      const firstToken = request.headers.Authorization.endsWith('token-first');
      return firstToken
        ? response(200, { email: 'first@example.test', account_id: 'account-first' })
        : response(401, { error: 'sensitive response body must not persist' });
    },
  });

  assert.equal(batch.requested, 2);
  assert.equal(batch.checked, 2);
  assert.deepEqual(batch.results.map((item) => item.status), ['healthy', 'invalid']);
  assert.equal(store.get(first.id).health.status, 'healthy');
  assert.equal(store.get(second.id).health.code, 'AT_UNAUTHORIZED');
  assert.equal(JSON.stringify(store.list()).includes('sensitive response body'), false);
  assert.equal(JSON.stringify(store.list()).includes('token-first'), false);
});
