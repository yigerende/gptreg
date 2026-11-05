'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { SessionAssetStore } = require('../src/session-asset-store');
const { buildApp } = require('../src/ui-server/app');

const API_KEY = 'nvtokens-test-key';

function temporaryWorkspace() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-nvtokens-'));
  const config = {
    schemaVersion: 2,
    mail: { provider: 'xiaopingguo', baseUrl: 'http://127.0.0.1:8000', password: 'mail-secret', count: 1 },
    aliases: { strategy: 'plus', count: 1, maxAttempts: 2, runTag: 'nvtokens', plusAddressingEnabled: true },
    sms: { provider: 'mock', apiKey: 'sms-secret', maxPrice: 0, service: { code: 'mock' }, country: { id: 151 }, replacementBudget: 2 },
    workers: { maxConcurrency: 1 },
    registration: { exchangeToken: true, dynamicSentinel: true },
    proxyPool: { path: 'proxy-pool.txt', defaultProtocol: 'http', required: false, healthCheck: { enabled: false } },
    output: { stateDir: '.state', cpaDir: '.state/output' },
    nvtokens: { baseUrl: 'https://nvtokens.test', apiKey: API_KEY, requestTimeoutMs: 1000 },
  };
  fs.writeFileSync(path.join(cwd, 'gpt-re.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  fs.writeFileSync(path.join(cwd, 'proxy-pool.txt'), '# empty\n');
  return { cwd, config };
}

function accountRecord(email, index = '') {
  return {
    type: 'codex',
    email,
    account_id: `account-${index || email}`,
    access_token: `access-token-${index || email}`,
  };
}

function createArtifact(store, { email, index = '', password = 'password-fixture', totpSecret = 'totp-fixture' }) {
  const asset = store.upsert({
    email,
    accountId: `account-${index || email}`,
    accessToken: `access-token-${index || email}`,
    password,
    totpSecret,
    lifecycle: 'sold',
  });
  const jobId = `job-${index || email.split('@')[0]}`;
  store.replaceCpa(asset.id, accountRecord(email, index), { runId: `run-${index || 'fixture'}`, jobId });
  return { asset, item: { runId: `run-${index || 'fixture'}`, jobId } };
}

function response(payload, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) { return headers[String(name).toLowerCase()] || ''; },
    },
    async json() { return payload; },
  };
}

async function makeApp(t, options = {}) {
  const { cwd, config } = temporaryWorkspace();
  const assetStore = new SessionAssetStore({ cwd, stateDir: config.output.stateDir, cpaDir: config.output.cpaDir });
  const app = buildApp({ cwd, assetStore, nvtokensFetch: options.fetch });
  t.after(async () => {
    await app.close();
    assetStore.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  return { app, assetStore, cwd, config };
}

test('CPA nvtokens routes send the documented payloads and stamp successful exports', async (t) => {
  const calls = [];
  const { app, assetStore, cwd, config } = await makeApp(t, {
    fetch: async (url, init) => {
      calls.push({ url, init });
      return response({ ok: true, accepted: 1, total: 1 });
    },
  });
  const fixture = createArtifact(assetStore, { email: 'sold@example.test', index: 'one' });
  const configResponse = await app.inject({ url: '/api/v1/config' });
  assert.equal(configResponse.statusCode, 200, configResponse.body);
  assert.doesNotMatch(configResponse.body, /nvtokens-test-key/);

  const cards = await app.inject({
    url: '/api/v1/artifacts/cpa/nvtokens/cards/import',
    method: 'POST',
    payload: { items: [fixture.item] },
  });
  const mailboxes = await app.inject({
    url: '/api/v1/artifacts/cpa/nvtokens/mailboxes/import',
    method: 'POST',
    payload: { items: [fixture.item] },
  });
  const pool = await app.inject({
    url: '/api/v1/artifacts/cpa/nvtokens/pool',
    method: 'POST',
    payload: { items: [fixture.item], priceYuan: 2.5 },
  });

  for (const result of [cards, mailboxes, pool]) assert.equal(result.statusCode, 200, result.body);
  assert.deepEqual(calls.map(({ url }) => url), [
    'https://nvtokens.test/api/inventory/cards/import',
    'https://nvtokens.test/api/inventory/mailboxes/import',
    'https://nvtokens.test/api/inventory/cards/pool',
  ]);
  assert.equal(calls.every(({ init }) => init.headers['x-api-key'] === API_KEY), true);
  assert.deepEqual(JSON.parse(calls[0].init.body), { data: [accountRecord('sold@example.test', 'one')] });
  assert.deepEqual(JSON.parse(calls[1].init.body), {
    tokens: [{ email: 'sold@example.test', password: 'password-fixture', two_factor_secret: 'totp-fixture' }],
  });
  assert.deepEqual(JSON.parse(calls[2].init.body), {
    data: [accountRecord('sold@example.test', 'one')],
    price_yuan: 2.5,
    inventory_tokens: [{ email: 'sold@example.test', password: 'password-fixture', two_factor_secret: 'totp-fixture' }],
  });

  const listed = (await app.inject({ url: '/api/v1/artifacts/cpa' })).json().artifacts;
  assert.equal(listed.length, 1);
  assert.equal(typeof listed[0].nvtokensCardsImportedAt, 'string');
  assert.equal(typeof listed[0].nvtokensMailboxesImportedAt, 'string');
  assert.equal(typeof listed[0].nvtokensCardsPooledAt, 'string');
  assert.equal(typeof listed[0].cpaExportedAt, 'string');
  const ledger = JSON.parse(fs.readFileSync(path.join(cwd, config.output.stateDir, 'cpa-nvtokens-pushes.json'), 'utf8'));
  assert.equal(Object.keys(ledger.entries).length, 1);
  assert.equal(typeof Object.values(ledger.entries)[0].cardsPooledAt, 'string');
});

test('each nvtokens kind refuses to resend what its own ledger already holds', async (t) => {
  const calls = [];
  const { app, assetStore } = await makeApp(t, {
    fetch: async (url, init) => {
      calls.push(url);
      return response({ ok: true, accepted: 1, total: 1 });
    },
  });
  const pooled = createArtifact(assetStore, { email: 'pooled@example.test', index: 'pooled' });
  const fresh = createArtifact(assetStore, { email: 'fresh@example.test', index: 'fresh' });
  const push = (route, items, extra = {}) => app.inject({
    url: `/api/v1/artifacts/cpa/nvtokens/${route}`,
    method: 'POST',
    payload: { items, unexportedOnly: true, ...extra },
  });

  const first = await push('pool', [pooled.item], { priceYuan: 2 });
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(calls.length, 1);

  // Pooled once: a second pool of the same account is refused before nvtokens sees it.
  const again = await push('pool', [pooled.item], { priceYuan: 2 });
  assert.equal(again.statusCode, 409, again.body);
  assert.match(again.body, /already been pushed/);
  assert.equal(calls.length, 1);

  // The guard is per kind: pooling an account says nothing about its mailbox import.
  const mailbox = await push('mailboxes/import', [pooled.item]);
  assert.equal(mailbox.statusCode, 200, mailbox.body);
  const mailboxAgain = await push('mailboxes/import', [pooled.item]);
  assert.equal(mailboxAgain.statusCode, 409, mailboxAgain.body);

  // A fresh account still goes through.
  const other = await push('pool', [fresh.item], { priceYuan: 2 });
  assert.equal(other.statusCode, 200, other.body);
  assert.deepEqual(calls, [
    'https://nvtokens.test/api/inventory/cards/pool',
    'https://nvtokens.test/api/inventory/mailboxes/import',
    'https://nvtokens.test/api/inventory/cards/pool',
  ]);
});

test('nvtokens card and pool pushes preserve the CPA access token when the linked asset changes', async (t) => {
  const calls = [];
  const { app, assetStore } = await makeApp(t, {
    fetch: async (url, init) => {
      calls.push({ url, init });
      return response({ ok: true, accepted: 1, total: 1 });
    },
  });
  const fixture = createArtifact(assetStore, { email: 'refreshed@example.test', index: 'refreshed' });
  assetStore.update(fixture.asset.id, { accessToken: 'fresh-access-token' });

  const cards = await app.inject({
    url: '/api/v1/artifacts/cpa/nvtokens/cards/import',
    method: 'POST',
    payload: { items: [fixture.item] },
  });
  const pool = await app.inject({
    url: '/api/v1/artifacts/cpa/nvtokens/pool',
    method: 'POST',
    payload: { items: [fixture.item], priceYuan: 1 },
  });

  assert.equal(cards.statusCode, 200, cards.body);
  assert.equal(pool.statusCode, 200, pool.body);
  assert.equal(JSON.parse(calls[0].init.body).data[0].access_token, 'access-token-refreshed');
  assert.equal(JSON.parse(calls[1].init.body).data[0].access_token, 'access-token-refreshed');
  assert.equal(JSON.parse(calls[0].init.body).data[0].account_id, 'account-refreshed');
  assert.equal(JSON.parse(calls[1].init.body).data[0].account_id, 'account-refreshed');
});

test('nvtokens batches from one delivery operation share one export timestamp', async (t) => {
  const { app, assetStore } = await makeApp(t, {
    fetch: async () => response({ ok: true, accepted: 1, total: 1 }),
  });
  const first = createArtifact(assetStore, { email: 'batch-one@example.test', index: 'batch-one' });
  const second = createArtifact(assetStore, { email: 'batch-two@example.test', index: 'batch-two' });
  const deliveryAt = '2026-09-14T08:00:00.000Z';

  for (const item of [first.item, second.item]) {
    const result = await app.inject({
      url: '/api/v1/artifacts/cpa/nvtokens/cards/import',
      method: 'POST',
      payload: { items: [item], deliveryAt },
    });
    assert.equal(result.statusCode, 200, result.body);
  }

  const listed = (await app.inject({ url: '/api/v1/artifacts/cpa' })).json().artifacts;
  assert.equal(listed.length, 2);
  for (const artifact of listed) {
    assert.equal(artifact.nvtokensCardsImportedAt, deliveryAt);
    assert.equal(artifact.cpaExportedAt, deliveryAt);
  }
});

test('nvtokens HTTP failures do not mark the CPA as exported', async (t) => {
  const calls = [];
  const { app, assetStore } = await makeApp(t, {
    fetch: async (url, init) => {
      calls.push({ url, init });
      return response({ error: 'inventory rejected' }, 422);
    },
  });
  const fixture = createArtifact(assetStore, { email: 'rejected@example.test', index: 'reject' });
  const result = await app.inject({
    url: '/api/v1/artifacts/cpa/nvtokens/cards/import',
    method: 'POST',
    payload: { items: [fixture.item] },
  });
  assert.equal(result.statusCode, 422, result.body);
  assert.match(result.json().message, /inventory rejected/);
  assert.equal(calls.length, 1);
  const listed = (await app.inject({ url: '/api/v1/artifacts/cpa' })).json().artifacts;
  assert.equal(listed[0].nvtokensCardsImportedAt, undefined);
  assert.equal(listed[0].cpaExportedAt, undefined);
});

test('nvtokens pool exposes upstream 403 details without stamping the CPA', async (t) => {
  const { app, assetStore } = await makeApp(t, {
    fetch: async () => response(
      { errors: [{ reason: '账号已在号池' }] },
      403,
      { 'x-request-id': 'pool-request-fixture' },
    ),
  });
  const fixture = createArtifact(assetStore, { email: 'already-pooled@example.test', index: 'pooled' });
  const result = await app.inject({
    url: '/api/v1/artifacts/cpa/nvtokens/pool',
    method: 'POST',
    payload: { items: [fixture.item], priceYuan: 1 },
  });
  assert.equal(result.statusCode, 403, result.body);
  assert.match(result.json().message, /HTTP 403/);
  assert.match(result.json().message, /账号已在号池/);
  assert.match(result.json().message, /pool-request-fixture/);
  assert.equal(result.json().details.requestId, 'pool-request-fixture');
});

test('partial nvtokens acceptance is reported but does not stamp an ambiguous batch', async (t) => {
  const { app, assetStore } = await makeApp(t, {
    fetch: async () => response({ ok: true, total: 2, accepted: 1, failed: 1, errors: ['one card rejected'] }),
  });
  const first = createArtifact(assetStore, { email: 'partial-one@example.test', index: 'partial-one' });
  const second = createArtifact(assetStore, { email: 'partial-two@example.test', index: 'partial-two' });
  const result = await app.inject({
    url: '/api/v1/artifacts/cpa/nvtokens/cards/import',
    method: 'POST',
    payload: { items: [first.item, second.item] },
  });
  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().pushed, 1);
  assert.equal(result.json().artifacts, 0);
  const listed = (await app.inject({ url: '/api/v1/artifacts/cpa' })).json().artifacts;
  assert.equal(listed.every((artifact) => artifact.nvtokensCardsImportedAt === undefined), true);
  assert.equal(listed.every((artifact) => artifact.cpaExportedAt === undefined), true);
});

test('live card rejections expose the upstream reason and do not stamp exports', async (t) => {
  const { app, assetStore } = await makeApp(t, {
    fetch: async () => response({
      accepted: [],
      rejected: [{ reason: 'Codex authorization failed: HTTP 401' }],
      summary: { accepted: 0, rejected: 1 },
    }, 201),
  });
  const fixture = createArtifact(assetStore, { email: 'expired-token@example.test', index: 'expired-token' });
  const result = await app.inject({
    url: '/api/v1/artifacts/cpa/nvtokens/cards/import',
    method: 'POST',
    payload: { items: [fixture.item] },
  });

  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().pushed, 0);
  assert.equal(result.json().failed, 1);
  assert.deepEqual(result.json().errors, ['Codex authorization failed: HTTP 401']);
  const listed = (await app.inject({ url: '/api/v1/artifacts/cpa' })).json().artifacts;
  assert.equal(listed[0].nvtokensCardsImportedAt, undefined);
  assert.equal(listed[0].cpaExportedAt, undefined);
});

test('live mailbox unmatched results are not treated as successful imports', async (t) => {
  const { app, assetStore } = await makeApp(t, {
    fetch: async () => response({
      total: 1,
      parsed: 1,
      matched: 0,
      updated: 0,
      unchanged: 0,
      returned_to_personal_inventory: 0,
      unmatched: 1,
      invalid: 0,
      duplicates: 0,
      unmatched_details: [{ reason: 'No matching inventory account' }],
    }, 201),
  });
  const fixture = createArtifact(assetStore, { email: 'unmatched-mailbox@example.test', index: 'unmatched-mailbox' });
  const result = await app.inject({
    url: '/api/v1/artifacts/cpa/nvtokens/mailboxes/import',
    method: 'POST',
    payload: { items: [fixture.item] },
  });

  assert.equal(result.statusCode, 200, result.body);
  assert.equal(result.json().pushed, 0);
  assert.equal(result.json().failed, 1);
  assert.deepEqual(result.json().errors, ['No matching inventory account']);
  const listed = (await app.inject({ url: '/api/v1/artifacts/cpa' })).json().artifacts;
  assert.equal(listed[0].nvtokensMailboxesImportedAt, undefined);
  assert.equal(listed[0].cpaExportedAt, undefined);
});

test('a pool push sends the usable accounts and reports the one it held back', async (t) => {
  const bodies = [];
  const { app, assetStore } = await makeApp(t, {
    fetch: async (url, init) => {
      bodies.push(JSON.parse(String(init.body)));
      return response({ ok: true, accepted: 2, total: 2 });
    },
  });
  // Two complete accounts and one without a long-lived 2FA secret — the shape
  // that used to reject all three and take a whole 25-strong batch with it.
  const good = [
    createArtifact(assetStore, { email: 'pool-good-one@example.test', index: 'pool-good-one' }),
    createArtifact(assetStore, { email: 'pool-good-two@example.test', index: 'pool-good-two' }),
  ];
  const bad = createArtifact(assetStore, { email: 'pool-no-2fa@example.test', index: 'pool-no-2fa', totpSecret: '' });

  const result = await app.inject({
    url: '/api/v1/artifacts/cpa/nvtokens/pool',
    method: 'POST',
    payload: { items: [good[0].item, bad.item, good[1].item], priceYuan: 1 },
  });

  assert.equal(result.statusCode, 200, result.body);
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].inventory_tokens.map((token) => token.email), [
    'pool-good-one@example.test',
    'pool-good-two@example.test',
  ]);
  assert.deepEqual(bodies[0].data.map((record) => record.email), [
    'pool-good-one@example.test',
    'pool-good-two@example.test',
  ]);
  const json = result.json();
  assert.equal(json.pushed, 2);
  assert.equal(json.skipped, 1);
  assert.deepEqual(json.skippedDetails.map(({ email, reason }) => ({ email, reason })), [
    { email: 'pool-no-2fa@example.test', reason: '缺少长期 2FA 密钥' },
  ]);

  // Only what went is stamped: the held-back account is still un-pooled, so
  // the next push offers it again instead of hiding it as delivered.
  const listed = (await app.inject({ url: '/api/v1/artifacts/cpa' })).json().artifacts;
  const pooledAt = (jobId) => listed.find((artifact) => artifact.jobId === jobId)?.nvtokensCardsPooledAt;
  assert.equal(typeof pooledAt(good[0].item.jobId), 'string');
  assert.equal(typeof pooledAt(good[1].item.jobId), 'string');
  assert.equal(pooledAt(bad.item.jobId), undefined);
});

test('a pool push with nothing usable still fails, and names every account', async (t) => {
  let calls = 0;
  const { app, assetStore } = await makeApp(t, {
    fetch: async () => { calls += 1; return response({ ok: true, accepted: 1, total: 1 }); },
  });
  const first = createArtifact(assetStore, { email: 'pool-empty-one@example.test', index: 'pool-empty-one', totpSecret: '' });
  const second = createArtifact(assetStore, { email: 'pool-empty-two@example.test', index: 'pool-empty-two', password: '' });

  const result = await app.inject({
    url: '/api/v1/artifacts/cpa/nvtokens/pool',
    method: 'POST',
    payload: { items: [first.item, second.item], priceYuan: 1 },
  });

  assert.equal(result.statusCode, 422, result.body);
  assert.match(result.json().message, /pool-empty-one@example\.test：缺少长期 2FA 密钥/);
  assert.match(result.json().message, /pool-empty-two@example\.test：缺少密码/);
  assert.equal(result.json().details.skipped.length, 2);
  assert.equal(calls, 0);
});

test('mailbox and pool pushes reject credentials without password or long-lived 2FA', async (t) => {
  let calls = 0;
  const { app, assetStore } = await makeApp(t, {
    fetch: async () => {
      calls += 1;
      return response({ ok: true, accepted: 1, total: 1 });
    },
  });
  const fixture = createArtifact(assetStore, {
    email: 'missing-credentials@example.test',
    index: 'missing',
    password: '',
    totpSecret: '',
  });
  for (const url of [
    '/api/v1/artifacts/cpa/nvtokens/mailboxes/import',
    '/api/v1/artifacts/cpa/nvtokens/pool',
  ]) {
    const result = await app.inject({ url, method: 'POST', payload: { items: [fixture.item], priceYuan: 1 } });
    assert.equal(result.statusCode, 422, `${url}: ${result.body}`);
    assert.match(result.json().message, /Cannot push credentials/);
  }
  assert.equal(calls, 0);
});

test('nvtokens pool rejects mismatched CPA and credential emails locally', async (t) => {
  let calls = 0;
  const { app, assetStore } = await makeApp(t, {
    fetch: async () => {
      calls += 1;
      return response({ ok: true, accepted: 1, total: 1 });
    },
  });
  const fixture = createArtifact(assetStore, { email: 'credential@example.test', index: 'mismatch' });
  assetStore.replaceCpa(
    fixture.asset.id,
    accountRecord('different@example.test', 'mismatch'),
    { runId: fixture.item.runId, jobId: fixture.item.jobId },
  );
  const result = await app.inject({
    url: '/api/v1/artifacts/cpa/nvtokens/pool',
    method: 'POST',
    payload: { items: [fixture.item], priceYuan: 1 },
  });
  assert.equal(result.statusCode, 422, result.body);
  assert.match(result.json().message, /邮箱不一致/);
  assert.equal(calls, 0);
});

test('nvtokens pool rejects a one-time 2FA code locally', async (t) => {
  let calls = 0;
  const { app, assetStore } = await makeApp(t, {
    fetch: async () => {
      calls += 1;
      return response({ ok: true, accepted: 1, total: 1 });
    },
  });
  const fixture = createArtifact(assetStore, {
    email: 'dynamic-code@example.test',
    index: 'dynamic-code',
    totpSecret: '123456',
  });
  const result = await app.inject({
    url: '/api/v1/artifacts/cpa/nvtokens/pool',
    method: 'POST',
    payload: { items: [fixture.item], priceYuan: 1 },
  });
  assert.equal(result.statusCode, 422, result.body);
  assert.match(result.json().message, /长期 2FA 密钥/);
  assert.equal(calls, 0);
});

test('nvtokens credential pushes keep array CPA records aligned with assets', async (t) => {
  const calls = [];
  const { app, assetStore } = await makeApp(t, {
    fetch: async (url, init) => {
      calls.push({ url, init });
      return response({ ok: true, accepted: 2, total: 2 });
    },
  });
  const first = createArtifact(assetStore, { email: 'array-one@example.test', index: 'array-one' });
  assetStore.upsert({
    email: 'array-two@example.test',
    accountId: 'account-array-two',
    accessToken: 'access-token-array-two',
    password: 'password-array-two',
    totpSecret: 'totp-array-two',
    lifecycle: 'sold',
  });
  assetStore.replaceCpa(
    first.asset.id,
    [accountRecord('array-one@example.test', 'array-one'), accountRecord('array-two@example.test', 'array-two')],
    first.item,
  );

  for (const url of [
    '/api/v1/artifacts/cpa/nvtokens/mailboxes/import',
    '/api/v1/artifacts/cpa/nvtokens/pool',
  ]) {
    const result = await app.inject({ url, method: 'POST', payload: { items: [first.item], priceYuan: 1 } });
    assert.equal(result.statusCode, 200, `${url}: ${result.body}`);
  }
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    tokens: [
      { email: 'array-one@example.test', password: 'password-fixture', two_factor_secret: 'totp-fixture' },
      { email: 'array-two@example.test', password: 'password-array-two', two_factor_secret: 'totp-array-two' },
    ],
  });
  assert.deepEqual(JSON.parse(calls[1].init.body).inventory_tokens, [
    { email: 'array-one@example.test', password: 'password-fixture', two_factor_secret: 'totp-fixture' },
    { email: 'array-two@example.test', password: 'password-array-two', two_factor_secret: 'totp-array-two' },
  ]);
});

test('nvtokens mailbox import rejects a one-time 2FA code locally', async (t) => {
  let calls = 0;
  const { app, assetStore } = await makeApp(t, {
    fetch: async () => {
      calls += 1;
      return response({ ok: true, accepted: 1, total: 1 });
    },
  });
  const fixture = createArtifact(assetStore, {
    email: 'mailbox-dynamic-code@example.test',
    index: 'mailbox-dynamic-code',
    totpSecret: '123456',
  });
  const result = await app.inject({
    url: '/api/v1/artifacts/cpa/nvtokens/mailboxes/import',
    method: 'POST',
    payload: { items: [fixture.item] },
  });
  assert.equal(result.statusCode, 422, result.body);
  assert.match(result.json().message, /Cannot push credentials/);
  assert.equal(calls, 0);
});
