'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildApp } = require('../src/ui-server/app');
const { ChainService } = require('../src/ui-server/chain-service');
const { ChainStore } = require('../src/chain-store');
const { SessionAssetStore } = require('../src/session-asset-store');
const { ConfigService } = require('../src/ui-server/config-service');
const { validateV2Config } = require('../src/config-v2');

function workspace(chain) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-chain-'));
  const config = {
    schemaVersion: 2,
    mail: { provider: 'xiaopingguo', baseUrl: 'http://127.0.0.1:8000', password: 'mail-secret', count: 1 },
    aliases: { strategy: 'root', count: 1, maxAttempts: 1, runTag: 'chain' },
    sms: { provider: 'mock', apiKey: 'sms-secret', maxPrice: 0, service: { code: 'mock' }, country: { id: 151 }, replacementBudget: 2 },
    workers: { maxConcurrency: 1 },
    registration: { exchangeToken: true, dynamicSentinel: true },
    proxyPool: { path: 'proxy-pool.txt', defaultProtocol: 'http', required: false, healthCheck: { enabled: false } },
    output: { stateDir: '.state', cpaDir: '.state/output' },
    ...(chain ? { chain } : {}),
  };
  fs.writeFileSync(path.join(cwd, 'gpt-re.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  fs.writeFileSync(path.join(cwd, 'proxy-pool.txt'), '# empty\n');
  return cwd;
}

/** Two pools so a run can draw a distinct exit for checkout and for update. */
function proxyService(gbCount = 2) {
  const gb = Array.from({ length: gbCount }, (_unused, index) => ({ id: `gb-${index + 1}`, url: `http://gb${index + 1}:1` }));
  return {
    list: () => ({
      dynamic: {
        countryPools: [
          { countryCode: 'GB', total: gb.length, entries: gb },
          { countryCode: 'US', total: 1, entries: [{ id: 'us-1', url: 'http://us1:1' }] },
          { countryCode: 'DE', total: 0, entries: [] },
        ],
      },
    }),
  };
}

function sessionAssets(assets) {
  const store = {
    list: () => assets,
    get: (id) => {
      const asset = assets.find((item) => item.id === id);
      if (!asset) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return asset;
    },
    // Deleting a chain row deletes its account, so the store has to be able to.
    remove: (ids = []) => {
      const wanted = new Set(ids);
      const removed = assets.filter((asset) => wanted.has(asset.id)).map((asset) => asset.id);
      for (const id of removed) assets.splice(assets.findIndex((asset) => asset.id === id), 1);
      return { removed, missing: [...wanted].filter((id) => !removed.includes(id)) };
    },
  };
  return () => store;
}

// Ids must satisfy safeAssetId (8-80 chars), so the fixtures use asset-* rather
// than bare labels.
// Only a claimable one-month free campaign gets an asset into the ledger, so
// the fixture carries the campaign the eligibility gate reads.
const FREE_MONTH_TRIAL = {
  status: 'trial',
  checkedAt: '2026-08-14T00:00:00.000Z',
  campaigns: [{
    key: 'plus',
    id: 'plus-1-month-free',
    planName: 'chatgptplusplan',
    label: '1-month free trial',
    durationPeriods: 1,
    durationPeriod: 'month',
    discountPercentage: 100,
    offerKind: 'free_month',
    offerLabel: '1个月免费',
  }],
  offerKind: 'free_month',
  offerLabel: '1个月免费',
  freeMonthOffer: true,
};

/** `overrides.sourceCountryCode` is the registration exit the ledger records. */
function trialAsset(id, overrides = {}) {
  const { accessToken = `at-${id}`, sourceCountryCode = '', ...rest } = typeof overrides === 'string'
    ? { accessToken: overrides }
    : overrides;
  return {
    id,
    email: `${id}@example.com`,
    accountId: `acct-${id}`,
    accessToken,
    hasAccessToken: true,
    trial: { ...FREE_MONTH_TRIAL },
    ...(sourceCountryCode ? { sourceProxy: { countryCode: sourceCountryCode } } : {}),
    ...rest,
  };
}

const ONE = 'asset-one-0001';
const TWO = 'asset-two-0002';

function chainService(options = {}) {
  const cwd = options.cwd || workspace(options.chain);
  const service = new ChainService({
    cwd,
    configService: new ConfigService({ cwd }),
    proxyService: proxyService(options.gbExits),
    sessionAssets: sessionAssets(options.assets || [trialAsset(ONE), trialAsset(TWO)]),
    ...(options.sessionAssetIdsInUse ? { sessionAssetIdsInUse: options.sessionAssetIdsInUse } : {}),
    store: new ChainStore({ cwd, stateDir: '.state' }),
    // The retry path is exercised without waiting out the real pause.
    attemptBackoffMs: options.attemptBackoffMs ?? 0,
    ...(options.probeToken ? { probeToken: options.probeToken } : {}),
    runner: options.runner || (async () => ({ ok: true, paypalUrl: 'https://www.paypal.com/x', currency: 'GBP', amountDue: 1.2 })),
  });
  return { cwd, service };
}

/** Resolves once every queued extraction has left the active map. */
async function settle(service) {
  for (let attempt = 0; attempt < 200 && service.active.size; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(service.active.size, 0, 'extractions did not settle');
}

test('chain defaults are validated by the config schema instead of passing through raw', () => {
  const base = { schemaVersion: 2, mail: { baseUrl: 'http://127.0.0.1:8000' }, aliases: { strategy: 'root' }, sms: { provider: 'mock', maxPrice: 0 }, registration: { exchangeToken: true } };
  // Concurrency defaults to 20: the console drives the whole batch from one
  // number now, and one-at-a-time was only ever the safe-but-slow default.
  // Timeouts, transport and concurrency left with the in-process engine; the
  // schema now only carries routing and payment.
  assert.deepEqual(validateV2Config(base).chain, {
    country: 'GB',
    countryRules: undefined,
    // Three proxy rotations before a row is written off; the engine rotates on
    // retry but never retries by itself.
    autoRetry: 3,
    dispatchConcurrency: 4,
    payment: { autoContinue: false, phone: '', country: 'US' },
  });
  assert.equal(validateV2Config({ ...base, chain: { autoRetry: 0 } }).chain.autoRetry, 0);
  assert.throws(() => validateV2Config({ ...base, chain: { autoRetry: 99 } }), /chain.autoRetry/);
  assert.deepEqual(
    validateV2Config({ ...base, chain: { payment: { autoContinue: true, phone: ' +1555 ', country: 'gb' } } }).chain.payment,
    { autoContinue: true, phone: '+1555', country: 'GB' },
  );
  assert.equal(validateV2Config({ ...base, chain: { country: 'jp' } }).chain.country, 'JP');
  assert.throws(() => validateV2Config({ ...base, chain: { country: 'CN' } }), /chain.country must be one of/);
});

test('the snapshot hands the console the routing default it should seed the form with', () => {
  const { service } = chainService({ chain: { country: 'JP' } });
  const snapshot = service.snapshot();
  assert.deepEqual(snapshot.settings, { country: 'JP' });
  // Three axes, defaulted from the single configured country until a table
  // says otherwise.
  assert.deepEqual(snapshot.countryRules.default, {
    billingCountry: 'JP', checkoutCountry: 'JP', updateCountry: '', applyCheckoutUpdate: true,
  });
  // Two different tables, published separately because they validate apart.
  assert.ok(snapshot.proxyRegions.includes('RO'), 'RO is a proxy region');
  assert.ok(!snapshot.billingCountries.includes('RO'), 'RO has no billing profile');
  assert.ok(snapshot.billingCountries.includes('JP'));
  assert.equal(snapshot.records.length, 2);
  assert.equal(snapshot.records[0].running, false);
});


test('each routing axis is validated against its own table at save time', () => {
  const { service } = chainService();
  service.snapshot();
  // A region with no billing profile is fine as an exit and impossible to bill.
  assert.throws(() => service.saveCountryRules({ TH: { billingCountry: 'RO', checkoutCountry: 'RO' } }), /没有对应的账单档案/);
  // ...and a billing profile that is not a proxy region cannot be an exit.
  assert.throws(() => service.saveCountryRules({ TH: { billingCountry: 'BA', checkoutCountry: 'BA' } }), /不是可用的代理源区域/);
  assert.deepEqual(service.saveCountryRules({ TH: { billingCountry: 'DE', checkoutCountry: 'US', updateCountry: 'US' } }).TH, {
    billingCountry: 'DE', checkoutCountry: 'US', updateCountry: 'US', applyCheckoutUpdate: true,
  });
});


test('an AT spot check reports per row without touching the login-state asset', async () => {
  const seen = [];
  const rows = [trialAsset(ONE), trialAsset(TWO)];
  const { service } = chainService({
    assets: rows,
    probeToken: async (asset, options) => {
      seen.push({ email: asset.email, proxy: options.proxy, accessToken: asset.accessToken });
      return asset.accessToken === `at-${ONE}`
        ? { status: 'healthy', code: 'AT_OK', message: 'ok', httpStatus: 200, latencyMs: 12 }
        : { status: 'invalid', code: 'AT_REJECTED', message: 'token rejected', httpStatus: 401, latencyMs: 9 };
    },
  });
  service.snapshot();

  const batch = await service.probeTokens([ONE, TWO]);
  assert.equal(batch.checked, 2);
  assert.equal(batch.alive, 1);
  assert.equal(batch.dead, 1);
  // Same local forwarder the login-state probe uses.
  assert.deepEqual([...new Set(seen.map((call) => call.proxy))], ['http://127.0.0.1:7890']);

  // The verdict rides on the snapshot so the row can be painted, but the asset
  // itself is untouched — this is a spot check, not a health record.
  const records = new Map(service.snapshot().records.map((record) => [record.id, record]));
  assert.equal(records.get(ONE).tokenHealth.status, 'healthy');
  assert.equal(records.get(TWO).tokenHealth.status, 'invalid');
  assert.equal(rows[0].health, undefined);
  assert.equal(rows[1].health, undefined);
  assert.equal(records.get(TWO).status, 'pending', 'a dead token must not rewrite the extraction status');
});

test('a probe that cannot run says so instead of condemning the account', async () => {
  const { service } = chainService({
    probeToken: async () => { throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:7890'), { code: 'ECONNREFUSED' }); },
  });
  service.snapshot();
  const batch = await service.probeTokens([ONE]);
  // `unknown`, not dead: the forwarder failed, which says nothing about the AT.
  assert.equal(batch.results[0].status, 'unknown');
  assert.equal(batch.dead, 0);
  assert.equal(batch.alive, 0);
});

test('payment status updates do not race a registration task using the same asset', async (t) => {
  const { cwd, service } = chainService({ sessionAssetIdsInUse: () => new Set([ONE]) });
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  service.snapshot();
  const app = buildApp({ cwd, chainService: service });
  t.after(() => app.close());

  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/chains/payment-status',
    payload: { ids: [ONE], status: 'success' },
  });
  assert.equal(response.statusCode, 409, response.body);
  assert.equal(service.detail(ONE).paymentStatus, 'pending');
});

test('deleting a chain row does not remove an asset owned by a registration task', () => {
  const { service } = chainService({ sessionAssetIdsInUse: () => new Set([ONE]) });
  service.snapshot();
  assert.throws(
    () => service.remove([ONE]),
    (error) => error.statusCode === 409 && /registration or recovery task/.test(error.message),
  );
  assert.equal(service.detail(ONE).status, 'pending');
});

test('chain deletion validates account files before dropping the ledger row', (t) => {
  const { cwd, service } = chainService();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const asset = trialAsset(ONE);
  const assetStore = {
    list: () => [asset],
    get: () => asset,
    validateRemove: () => { throw new Error('asset removal preflight failed'); },
    remove: () => { throw new Error('asset removal must not start'); },
  };
  service.sessionAssets = () => assetStore;
  service.snapshot();

  assert.throws(() => service.remove([ONE]), /asset removal preflight failed/);
  assert.equal(service.detail(ONE).status, 'pending');
});

test('deleting one of two legacy chain rows keeps their shared asset', () => {
  const { service } = chainService();
  service.snapshot();
  const chainStore = service.store();
  const state = chainStore.read();
  state.records['legacy-row-0002'] = {
    ...state.records[ONE],
    id: 'legacy-row-0002',
    assetId: ONE,
    email: 'legacy-row@example.test',
  };
  chainStore.write(state);

  const removed = service.remove([ONE]);
  assert.deepEqual(removed.removed, [ONE]);
  assert.deepEqual(removed.accountsRemoved, []);
  assert.deepEqual(removed.accountsRetained, [ONE]);
  assert.equal(service.sessionAssets().get(ONE).email, `${ONE}@example.com`);
  assert.equal(service.store().get('legacy-row-0002').assetId, ONE);
});

test('chain deletion rejects malformed ids as a bad request', () => {
  const { service } = chainService();
  assert.throws(() => service.remove(['bad']), (error) => error.statusCode === 400);
});

test('payment success wakes the account maintenance robot after the ledger write', async (t) => {
  const { cwd, service } = chainService();
  const wakeups = [];
  const robotService = {
    start() {},
    shutdown() {},
    requestRun(...args) { wakeups.push(args); },
  };
  service.snapshot();
  const app = buildApp({ cwd, chainService: service, robotService });
  t.after(async () => {
    await app.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/chains/payment-status',
    payload: { ids: [ONE], status: 'success' },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(service.detail(ONE).paymentStatus, 'success');
  assert.deepEqual(wakeups, [[
    'account-maintenance',
    'payment_success',
    { commandId: 'payment_success', payload: { assetIds: [ONE] } },
  ]]);

  const repeated = await app.inject({
    method: 'POST',
    url: '/api/v1/chains/payment-status',
    payload: { ids: [ONE], status: 'success' },
  });
  assert.equal(repeated.statusCode, 200, repeated.body);
  assert.deepEqual(wakeups, [[
    'account-maintenance',
    'payment_success',
    { commandId: 'payment_success', payload: { assetIds: [ONE] } },
  ]], 'repeating the same payment-success mark must not enqueue another refresh');
});

const IMPORT_JWT = (tag) => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ sub: tag })).toString('base64url')}.c2ln`;

/** A chain service whose two network calls are scripted per token. */
function importService(script, options = {}) {
  const cwd = workspace();
  fs.writeFileSync(path.join(cwd, 'gpt-re.config.json'), `${JSON.stringify({
    ...JSON.parse(fs.readFileSync(path.join(cwd, 'gpt-re.config.json'), 'utf8')),
    proxyPool: { path: 'proxy-pool.txt', defaultProtocol: 'http', required: false, healthCheck: { enabled: false }, maintenanceProxy: 'http://127.0.0.1:7899' },
  }, null, 2)}\n`);
  const store = new SessionAssetStore({ cwd, stateDir: '.state', cpaDir: '.state/output' });
  const proxies = [];
  const service = new ChainService({
    cwd,
    configService: new ConfigService({ cwd }),
    proxyService: proxyService(),
    sessionAssets: () => store,
    store: new ChainStore({ cwd, stateDir: '.state' }),
    probeToken: async (asset, opts) => {
      proxies.push(opts.proxy);
      return script[asset.accessToken]?.probe
        || { status: 'healthy', code: 'AT_VALID', identity: { emails: ['discovered@example.test'], accountIds: ['acct-discovered'] } };
    },
    checkTrial: async (asset, opts) => {
      proxies.push(opts.proxy);
      return script[asset.accessToken]?.trial
        || { status: 'none', code: 'TRIAL_UNAVAILABLE', message: 'none', httpStatus: 200, checkedAt: '2026-08-15T00:00:00.000Z', latencyMs: 1, campaigns: [] };
    },
    ...options,
  });
  return { service, store, cwd, proxies };
}

const FREE_MONTH_CAMPAIGN = {
  key: 'plus', id: 'plus-1-month-free', planName: 'chatgptplusplan', label: '1-month free trial',
  durationPeriods: 1, durationPeriod: 'month', discountPercentage: 100,
};
const HALF_PRICE_CAMPAIGN = {
  key: 'go', id: 'go-3-month-half-off', planName: 'chatgptgoplan', label: '3-month 50% off',
  durationPeriods: 3, durationPeriod: 'month', discountPercentage: 50,
};

test('only a one-month free trial is admitted, and it lands in the chain ledger', async (t) => {
  const free = IMPORT_JWT('free');
  const discounted = IMPORT_JWT('discounted');
  const dead = IMPORT_JWT('dead');
  const { service, store, proxies } = importService({
    [free]: {
      probe: { status: 'healthy', code: 'AT_VALID', identity: { emails: ['free@example.test'], accountIds: ['acct-free'] } },
      trial: { status: 'trial', code: 'TRIAL_OFFER_AVAILABLE', message: 'ok', httpStatus: 200, checkedAt: '2026-08-15T00:00:00.000Z', latencyMs: 2, campaigns: [FREE_MONTH_CAMPAIGN], planType: 'free' },
    },
    [discounted]: {
      probe: { status: 'healthy', code: 'AT_VALID', identity: { emails: ['half@example.test'], accountIds: ['acct-half'] } },
      trial: { status: 'trial', code: 'TRIAL_OFFER_AVAILABLE', message: 'ok', httpStatus: 200, checkedAt: '2026-08-15T00:00:00.000Z', latencyMs: 2, campaigns: [HALF_PRICE_CAMPAIGN] },
    },
    [dead]: { probe: { status: 'invalid', code: 'AT_UNAUTHORIZED', identity: { emails: [], accountIds: [] } } },
  });
  t.after(() => {
    store.close();
    fs.rmSync(service.cwd || '', { recursive: true, force: true });
  });

  const result = await service.importTokens({
    provider: 'paypal',
    content: [`free@example.test----${free}`, discounted, dead, 'garbage'].join('\n'),
  });

  assert.equal(result.requested, 4);
  assert.equal(result.imported, 1);
  assert.deepEqual(result.admitted.map((row) => row.email), ['free@example.test']);
  assert.deepEqual(result.rejected.map((row) => row.code).sort(), ['AT_UNAUTHORIZED', 'TOKEN_MALFORMED', 'TRIAL_NOT_PLUS_FREE_MONTH']);

  // Every call went out through the configured forwarder, never a country pool.
  assert.deepEqual([...new Set(proxies)], ['http://127.0.0.1:7899']);

  // Only the admitted account was written, and it reaches the extraction queue.
  assert.deepEqual(store.list().map((asset) => asset.email), ['free@example.test']);
  assert.deepEqual(service.snapshot().records.map((record) => record.email), ['free@example.test']);
});

test('a token whose response exposes no email is keyed by its account id, not refused', async (t) => {
  // These come from outside; refusing one because chatgpt.com did not hand back
  // an address would defeat the point of the import.
  const nameless = IMPORT_JWT('nameless');
  const { service, store } = importService({
    [nameless]: {
      probe: { status: 'healthy', code: 'AT_VALID', identity: { emails: [], accountIds: ['acct-nameless'] } },
      trial: { status: 'trial', code: 'TRIAL_OFFER_AVAILABLE', message: 'ok', httpStatus: 200, checkedAt: '2026-08-15T00:00:00.000Z', latencyMs: 2, campaigns: [FREE_MONTH_CAMPAIGN] },
    },
  });
  t.after(() => {
    store.close();
    fs.rmSync(service.cwd || '', { recursive: true, force: true });
  });

  const result = await service.importTokens({ provider: 'paypal', content: nameless });
  assert.equal(result.imported, 1);
  assert.equal(result.admitted[0].email, 'acct-nameless');
  assert.deepEqual(service.snapshot().records.map((record) => record.email), ['acct-nameless']);
});

test('a token that exposes no identity at all has nothing to key on and is refused', async (t) => {
  const anonymous = IMPORT_JWT('anonymous');
  const { service, store } = importService({
    [anonymous]: { probe: { status: 'healthy', code: 'AT_VALID', identity: { emails: [], accountIds: [] } } },
  });
  t.after(() => {
    store.close();
    fs.rmSync(service.cwd || '', { recursive: true, force: true });
  });

  const result = await service.importTokens({ provider: 'paypal', content: anonymous });
  assert.equal(result.imported, 0);
  assert.equal(result.rejected[0].code, 'IDENTITY_UNKNOWN');
  assert.deepEqual(store.list(), []);
});

test('the identity discovered from the probe is used when the paste carries no email', async (t) => {
  const token = IMPORT_JWT('discover');
  const { service, store } = importService({
    [token]: {
      probe: { status: 'healthy', code: 'AT_VALID', identity: { emails: ['found@example.test'], accountIds: ['acct-found'] } },
      trial: { status: 'trial', code: 'TRIAL_OFFER_AVAILABLE', message: 'ok', httpStatus: 200, checkedAt: '2026-08-15T00:00:00.000Z', latencyMs: 2, campaigns: [FREE_MONTH_CAMPAIGN] },
    },
  });
  t.after(() => {
    store.close();
    fs.rmSync(service.cwd || '', { recursive: true, force: true });
  });

  const result = await service.importTokens({ provider: 'paypal', content: token });
  assert.equal(result.imported, 1);
  assert.equal(result.admitted[0].email, 'found@example.test');
  const saved = store.list()[0];
  assert.equal(saved.accountId, 'acct-found');
  assert.equal(saved.sourceKind, 'imported_at');
});

test('a chain row serves its full access token on demand for the copy button', async (t) => {
  const token = IMPORT_JWT('copy-at');
  const { service, store } = importService({
    [token]: {
      probe: { status: 'healthy', code: 'AT_VALID', identity: { emails: ['copy-at@example.test'], accountIds: ['acct-copy-at'] } },
      trial: { status: 'trial', code: 'TRIAL_OFFER_AVAILABLE', message: 'ok', httpStatus: 200, checkedAt: '2026-08-15T00:00:00.000Z', latencyMs: 2, campaigns: [FREE_MONTH_CAMPAIGN] },
    },
  });
  t.after(() => {
    store.close();
    fs.rmSync(service.cwd || '', { recursive: true, force: true });
  });

  const imported = await service.importTokens({ provider: 'paypal', content: token });
  const assetId = imported.admitted[0].assetId;
  const app = buildApp({ cwd: service.cwd, chainService: service });
  try {
    const listed = await app.inject({ method: 'GET', url: '/api/v1/chains' });
    assert.equal(JSON.stringify(listed.json()).includes(token), false, 'the snapshot must not carry the raw token');

    const response = await app.inject({ method: 'GET', url: `/api/v1/chains/${assetId}/token` });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.json().token, token);
    assert.equal(response.json().email, 'copy-at@example.test');

    const missing = await app.inject({ method: 'GET', url: '/api/v1/chains/does-not-exist/token' });
    assert.equal(missing.statusCode, 404, missing.body);
  } finally {
    await app.close();
  }
});

test('deleting an externally imported chain also removes its login-state account', async (t) => {
  const token = IMPORT_JWT('delete-imported');
  const { service, store } = importService({
    [token]: {
      probe: { status: 'healthy', code: 'AT_VALID', identity: { emails: ['delete-imported@example.test'], accountIds: ['acct-delete-imported'] } },
      trial: { status: 'trial', code: 'TRIAL_OFFER_AVAILABLE', message: 'ok', httpStatus: 200, checkedAt: '2026-08-15T00:00:00.000Z', latencyMs: 2, campaigns: [FREE_MONTH_CAMPAIGN] },
    },
  });
  t.after(() => fs.rmSync(service.cwd || '', { recursive: true, force: true }));

  const imported = await service.importTokens({ provider: 'paypal', content: token });
  const assetId = imported.admitted[0].assetId;
  const cpa = store.replaceCpa(assetId, { email: 'delete-imported@example.test', access_token: token }, { runId: 'imported-cpa-run', jobId: 'imported-cpa-job' });
  const app = buildApp({ cwd: service.cwd, chainService: service });
  try {
    const listed = await app.inject({ method: 'GET', url: '/api/v1/chains' });
    assert.equal(listed.json().records[0].sourceKind, 'imported_at');

    const removed = await app.inject({ method: 'DELETE', url: '/api/v1/chains', payload: { ids: [assetId] } });
    assert.equal(removed.statusCode, 200, removed.body);
    assert.deepEqual(removed.json().removed, [assetId]);
    assert.deepEqual(removed.json().accountsRemoved, [assetId]);
    assert.deepEqual(store.list(), []);
    assert.equal(fs.existsSync(cpa.filePath), false);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/api/v1/chains' })).json().records, []);

    // A registered account goes too. Keeping it meant the row's twin survived
    // the delete, kept its trial flag, and was re-synced into a fresh chain row
    // on the next snapshot — so the delete never actually held.
    const registered = store.upsert({
      email: 'registered@example.test',
      accountId: 'acct-registered',
      accessToken: 'registered-at',
      status: 'valid',
      sourceKind: 'register_session',
      trial: { status: 'trial', checkedAt: '2026-08-15T00:00:00.000Z', campaigns: [FREE_MONTH_CAMPAIGN] },
    });
    service.snapshot();
    const registeredRemoved = service.remove([registered.id]);
    assert.deepEqual(registeredRemoved.accountsRemoved, [registered.id]);
    assert.throws(() => store.get(registered.id), (error) => error.code === 'ENOENT');
    assert.deepEqual(service.snapshot().records, [], 'a deleted account must not be re-synced back into the ledger');
  } finally {
    await app.close();
    store.close();
  }
});

test('a paste with nothing usable is a bad request, not an empty success', async (t) => {
  const { service } = importService({});
  t.after(() => fs.rmSync(service.cwd || '', { recursive: true, force: true }));
  await assert.rejects(service.importTokens({ provider: 'paypal', content: '   \n\n' }), (error) => error.statusCode === 400);
  // The import no longer guesses a route from the registration country: an
  // imported token's registration is somebody else's, so the operator must name
  // the provider. `providerForCountry` still routes the rows we registered.
  await assert.rejects(
    service.importTokens({ content: 'anything' }),
    (error) => error.statusCode === 400 && /提链方式/.test(error.message),
  );
  await assert.rejects(
    service.importTokens({ provider: 'not-a-provider', content: 'anything' }),
    (error) => error.statusCode === 400,
  );
});

