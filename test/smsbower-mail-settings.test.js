'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildApp } = require('../src/ui-server/app');
const { prepareBranchPreflight } = require('../src/branch-orchestrator');
const { normalizeRunPlan } = require('../src/run-plan');

function fixture(t, fetch, options = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-mail-settings-'));
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../gpt-re.config.example.json'), 'utf8'));
  config.mail.maxPrice = 0.2;
  config.sms.apiKey = 'shared-test-key';
  delete config.mail.apiKey;
  const file = path.join(cwd, 'gpt-re.config.json');
  fs.writeFileSync(file, JSON.stringify(config));
  const app = buildApp({ cwd, smsbowerMailFetch: fetch, deferBootMaintenance: true, ...options });
  t.after(async () => { await app.close(); fs.rmSync(cwd, { recursive: true, force: true }); });
  return { app, file, config };
}

test('mail configuration tests the unsaved draft with one read-only stock request and never exposes keys', async (t) => {
  const calls = [];
  const { app, file } = fixture(t, async (url) => {
    calls.push(new URL(url));
    return new Response(JSON.stringify({ status: 1, data: { dr: { 'gmail.com': { price: 0.12, count: 0 } } } }));
  });
  const before = fs.readFileSync(file, 'utf8');
  const current = await app.inject('/api/v1/mail/smsbower/config');
  assert.equal(current.json().apiKeyConfigured, true);
  assert.equal(current.body.includes('shared-test-key'), false);
  const result = await app.inject({ method: 'POST', url: '/api/v1/mail/smsbower/test', payload: {
    baseUrl: 'https://mail-draft.example/api/mail', service: 'dr', maxPrice: 0.1, apiKey: 'draft-test-key',
  } });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().ok, true);
  assert.equal(result.json().count, 0);
  assert.equal(result.json().withinBudget, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].origin, 'https://mail-draft.example');
  assert.equal(calls[0].pathname, '/api/mail/getPriceRests');
  assert.equal(calls[0].searchParams.get('api_key'), 'draft-test-key');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal(result.body.includes('draft-test-key'), false);
});

test('resource board reads the dedicated MAIL balance, selected SMS price, caches reads and never buys resources', async t => {
  const calls = [];
  const { app } = fixture(t, async value => {
    const url = new URL(value); calls.push(url);
    if (url.searchParams.get('action') === 'getBalance') return new Response('ACCESS_BALANCE:12.345');
    assert.equal(url.pathname, '/api/mail/getPriceRests');
    return new Response(JSON.stringify({ status: 1, data: { dr: { 'gmail.com': { price: .017, count: 100 } } } }));
  }, { smsBalanceReader: async () => 4.287, smsMarketReader: async () => ({ currency: 'USD', cheapestPrice: .07 }) });
  await app.inject({ method: 'PUT', url: '/api/v1/mail/smsbower/config', payload: { apiKey: 'dedicated-mail-test-key', maxPrice: .1 } });
  const responses = await Promise.all([app.inject('/api/v1/resources/summary?mailProvider=smsbower'), app.inject('/api/v1/resources/summary?mailProvider=smsbower')]);
  for (const response of responses) {
    assert.equal(response.statusCode, 200, response.body);
    const data = response.json();
    assert.equal(data.mail.balance, 12.345); assert.equal(data.mail.stock, 100); assert.equal(data.mail.unitPrice, .017);
    assert.equal(data.sms.balance, 4.287); assert.equal(data.sms.cheapestPrice, .07);
    assert.equal(data.taskCapacity.customer.capacity, 15);
    assert.ok(!response.body.includes('dedicated-mail-test-key'));
  }
  assert.equal(calls.length, 2);
  assert.ok(calls.every(url => url.searchParams.get('api_key') === 'dedicated-mail-test-key'));
});

test('resource failures keep unknown amounts null and redact upstream errors', async t => {
  const { app } = fixture(t, async () => { throw new Error('secret-provider-key'); }, {
    smsBalanceReader: async () => { throw new Error('secret-sms-key'); },
    smsMarketReader: async () => { throw new Error('secret-sms-key'); },
  });
  const response = await app.inject('/api/v1/resources/summary?mailProvider=smsbower');
  assert.equal(response.statusCode, 200, response.body);
  const data = response.json();
  assert.equal(data.mail.balance, null); assert.equal(data.mail.unitPrice, null); assert.equal(data.sms.cheapestPrice, null);
  assert.ok(!response.body.includes('secret-'));
});

test('saved mailbox settings reach actual registration preflight and an empty key preserves the saved key', async (t) => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(new URL(url));
    return new Response(JSON.stringify({ status: 1, data: { dr: { 'gmail.com': { price: 0.12, count: 5 } } } }));
  };
  const { app, file } = fixture(t, fetch);
  const payload = { baseUrl: 'https://mail-saved.example/api/mail/', service: 'dr', maxPrice: 0.2, apiKey: 'private-mail-key' };
  const saved = await app.inject({ method: 'PUT', url: '/api/v1/mail/smsbower/config', payload });
  assert.equal(saved.statusCode, 200, saved.body);
  assert.equal(saved.json().dedicatedApiKey, true);
  assert.equal(saved.body.includes(payload.apiKey), false);
  const again = await app.inject({ method: 'PUT', url: '/api/v1/mail/smsbower/config', payload: { ...payload, apiKey: '' } });
  assert.equal(again.statusCode, 200, again.body);
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(raw.mail.apiKey, 'private-mail-key');
  assert.equal(raw.sms.apiKey, 'shared-test-key');
  assert.equal(raw.mail.smsbowerBaseUrl, 'https://mail-saved.example/api/mail');
  const normalized = app.services.configService.normalized();
  normalized.mail.provider = 'smsbower';
  delete normalized.mail.password;
  delete normalized.mail.passwordEnv;
  const plan = normalizeRunPlan({ taskKind: 'register_session', mailProvider: 'smsbower', mailCount: 1, workerConcurrency: 1, postRegistrationOAuth: false }, normalized);
  const identity = app.services.runManager.preflightIdentity(normalized, plan, null);
  const changedKey = structuredClone(normalized);
  changedKey.mail.apiKey = 'different-private-key';
  assert.notEqual(app.services.runManager.preflightIdentity(changedKey, plan, null), identity);
  await prepareBranchPreflight(normalized, plan, { mailFetch: fetch, smsProvider: { name: 'mock' } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].origin, 'https://mail-saved.example');
  assert.equal(calls[0].searchParams.get('api_key'), 'private-mail-key');
  const snapshot = await app.inject('/api/v1/config');
  assert.equal(snapshot.body.includes('private-mail-key'), false);
});

test('test failures are explicit, do not echo provider secrets, and bad input makes no request', async (t) => {
  let calls = 0;
  const { app, file } = fixture(t, async () => {
    calls++;
    return new Response(JSON.stringify({ status: 0, error: 'No access shared-test-key' }), { status: 401 });
  });
  const before = fs.readFileSync(file, 'utf8');
  const failed = await app.inject({ method: 'POST', url: '/api/v1/mail/smsbower/test', payload: {} });
  assert.equal(failed.json().ok, false);
  assert.equal(failed.json().code, 'AUTH_FAILED');
  assert.equal(failed.body.includes('shared-test-key'), false);
  for (const payload of [{ baseUrl: 'file:///tmp/key' }, { baseUrl: 'https://mail.invalid/?api_key=oops' }, { service: '' }]) {
    const invalid = await app.inject({ method: 'POST', url: '/api/v1/mail/smsbower/test', payload });
    assert.equal(invalid.statusCode, 400, invalid.body);
  }
  assert.equal(calls, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});
