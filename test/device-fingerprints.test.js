'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SessionAssetStore } = require('../src/session-asset-store');
const { deviceFingerprintPage } = require('../src/ui-server/device-fingerprints');
const { buildApp } = require('../src/ui-server/app');

test('device inventory paginates, counts archived duplicates globally and never returns account secrets', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gptreg-device-inventory-'));
  const store = new SessionAssetStore({ cwd, stateDir: 'state', cpaDir: 'output' });
  let app;
  t.after(async () => { if (app) await app.close(); store.close(); fs.rmSync(cwd, { recursive: true, force: true }); });
  const records = [];
  for (let i = 0; i < 123; i++) records.push(store.upsert({
    email: `account-${i}@example.test`, accountId: `account-${i}`,
    clientProfileFingerprint: i === 122 ? 'fingerprint-0' : `fingerprint-${i}`,
    oaiDid: i === 121 ? 'device-2' : i === 10 ? '' : `device-${i}`,
    sourceProxy: { id: `proxy-${i}`, countryCode: 'PH', exitIp: i === 122 ? '203.0.113.10' : `203.0.113.${i + 10}`, url: 'http://secret-user:secret-password@proxy.invalid:8080' },
    clientProfile: { schemaVersion: 2, browser: 'firefox', browserVersion: '156.0', userAgent: 'fixture UA', screen: { width: 1920, height: 1080 }, viewport: null, password: 'profile-secret' },
    password: 'account-secret', totpSecret: 'totp-secret', accessToken: 'token-secret',
    cookieJar: { cookies: [{ key: 'secret-cookie', value: 'cookie-secret' }] },
  }));
  fs.mkdirSync(store.archiveRoot, { recursive: true });
  const last = store.filePath(records[122].id);
  fs.renameSync(last, path.join(store.archiveRoot, path.basename(last)));
  app = buildApp({ cwd, runManager: { sessionAssets: () => store, async shutdown() {} }, robotService: { start() {}, async shutdown() {} }, logStore: { sweep() {} } });
  const get = query => app.inject(`/api/v1/device-fingerprints?${query}`);
  const firstResponse = await get('limit=50&offset=0');
  assert.equal(firstResponse.statusCode, 200, firstResponse.body);
  assert.equal(firstResponse.headers['cache-control'], 'no-store');
  const first = firstResponse.json(), second = (await get('limit=50&offset=50')).json();
  assert.equal(first.total, 123);
  assert.equal(first.items.length, 50);
  assert.equal(second.items.length, 50);
  assert.ok(second.items.every(row => !first.items.some(prior => prior.id === row.id)));
  assert.equal(first.summary.uniqueFingerprints, 122);
  assert.equal(first.summary.duplicateFingerprintGroups, 1);
  assert.equal(first.summary.duplicateFingerprintAccounts, 2);
  assert.equal(first.summary.uniqueDeviceIds, 121);
  assert.equal(first.summary.duplicateDeviceAccounts, 2);
  assert.equal(first.summary.missing, 1);
  assert.equal(first.summary.duplicateExitIpAccounts, 2);
  assert.equal(first.summary.uniqueExitIps, 122);
  assert.equal((await get('match=exitIp&limit=1')).json().total, 2);
  assert.equal((await get('q=203.0.113.10')).json().total, 2, 'exact IP must not match .100 through .109');

  const duplicates = (await get('match=fingerprint&limit=1')).json();
  assert.equal(duplicates.total, 2);
  assert.equal(duplicates.items[0].fingerprintAccounts, 2);
  assert.equal(duplicates.summary.total, 123);
  const archived = (await get('q=ACCOUNT-122%40EXAMPLE.TEST')).json();
  assert.equal(archived.total, 1);
  assert.equal(archived.items[0].archived, true);
  assert.equal(archived.items[0].fingerprintAccounts, 2);
  assert.equal(archived.items[0].exitIpAccounts, 2);
  const proxyDetail = await app.inject(`/api/v1/device-fingerprints/${records[122].id}/proxy`);
  assert.equal(proxyDetail.json().proxyUrl, 'http://secret-user:secret-password@proxy.invalid:8080');
  assert.equal(proxyDetail.headers['cache-control'], 'no-store');
  assert.equal((await app.inject('/api/v1/device-fingerprints/unknown/proxy')).statusCode, 404);
  assert.equal((await get('q=device-2&match=device')).json().total, 2);
  assert.equal((await get('match=missing')).json().items[0].email, 'account-10@example.test');
  const lastPage = (await get('offset=9999&limit=50')).json();
  assert.equal(lastPage.offset, 100); assert.equal(lastPage.items.length, 23);
  for (const query of ['limit=201', 'offset=-1', 'offset=NaN', 'match=unknown', `q=${'a'.repeat(257)}`]) assert.equal((await get(query)).statusCode, 400);
  for (const secret of ['account-secret', 'totp-secret', 'token-secret', 'cookie-secret', 'secret-password', 'profile-secret']) assert.ok(!firstResponse.body.includes(secret), secret);
  // An updated device must be reflected immediately; this inventory does not
  // persist another copy of the account or change its original fingerprint.
  store.update(records[121].id, { oaiDid: 'new-device-121' });
  assert.equal((await get('match=device')).json().total, 0);
  assert.equal(store.get(records[0].id).password, 'account-secret');
});

test('duplicate badges count distinct accounts; missing data is not a shared fingerprint', () => {
  const records = [
    { id: 'a', email: 'same@example.test', clientProfileFingerprint: 'fp', oaiDid: 'did' },
    { id: 'b', email: 'SAME@example.test', clientProfileFingerprint: 'fp', oaiDid: 'did' },
    { id: 'c', email: 'missing@example.test' },
    { id: 'd', email: 'also-missing@example.test', status: 'corrupt' },
  ];
  const store = { files: () => records, archivedFiles: () => [], readAssetForListing: value => value };
  const page = deviceFingerprintPage(store);
  assert.equal(page.summary.duplicateFingerprintAccounts, 0);
  assert.equal(page.summary.duplicateDeviceAccounts, 0);
  assert.equal(page.summary.missing, 2);
  assert.equal(page.summary.unreadable, 1);
  assert.equal(deviceFingerprintPage(store, { match: 'fingerprint' }).total, 0);
});
