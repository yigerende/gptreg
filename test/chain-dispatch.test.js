'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ChainService } = require('../src/ui-server/chain-service');
const { ChainStore } = require('../src/chain-store');
const { ConfigService } = require('../src/ui-server/config-service');

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

function workspace(chain) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-dispatch-'));
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

function asset(id, sourceCountryCode = '') {
  return {
    id,
    email: `${id}@example.com`,
    accountId: `acct-${id}`,
    accessToken: `at-${id}`,
    hasAccessToken: true,
    trial: { ...FREE_MONTH_TRIAL },
    ...(sourceCountryCode ? { sourceProxy: { countryCode: sourceCountryCode } } : {}),
  };
}

/** Records what the console would have sent to the external engine. */
function fakeLinkOps(overrides = {}) {
  const calls = [];
  return {
    calls,
    createJob: overrides.createJob || (async (payload) => {
      calls.push(payload);
      // Extraction expands one job per token; payment is always a single job.
      const tokens = Array.isArray(payload.input?.tokens) ? payload.input.tokens : [null];
      return { ok: true, jobs: tokens.map((_token, index) => ({ id: `job-${calls.length}-${index + 1}` })) };
    }),
    jobs: overrides.jobs || (async () => ({ jobs: [] })),
    retries: [],
    retryJob: overrides.retryJob || (async function retryJob(jobId) { this.retries.push(jobId); return { ok: true }; }),
    submitInput: async () => ({ ok: true }),
  };
}

function build({ assets = [asset('asset-one-0001'), asset('asset-two-0002')], linkops = fakeLinkOps(), chain } = {}) {
  const cwd = workspace(chain);
  const store = new ChainStore({ cwd, stateDir: '.state' });
  const service = new ChainService({
    cwd,
    configService: new ConfigService({ cwd }),
    proxyService: { list: () => ({ dynamic: { countryPools: [] } }) },
    sessionAssets: () => ({
      list: () => assets,
      get: (id) => {
        const found = assets.find((item) => item.id === id);
        if (!found) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return found;
      },
    }),
    store,
    linkops,
  });
  store.sync(assets);
  return { service, store, linkops, cwd };
}

test('a dispatch sends one job batch per target country, carrying the tokens', async () => {
  const { service, store, linkops } = build();
  const ids = store.list().map((record) => record.id);
  const result = await service.extract({ ids });

  assert.equal(linkops.calls.length, 1, 'both rows route to the same default country');
  const [call] = linkops.calls;
  assert.equal(call.domain, 'extraction');
  assert.equal(call.provider, 'paypal');
  assert.equal(call.options.checkoutCountry, 'GB');
  assert.equal(call.options.billingCountry, 'GB', 'billing follows checkout unless configured apart');
  assert.deepEqual(call.input.tokens.sort(), ['at-asset-one-0001', 'at-asset-two-0002']);
  assert.equal(result.accepted.length, 2);
  assert.deepEqual(result.skipped, []);

  for (const record of store.list()) {
    assert.equal(record.status, 'running');
    assert.match(record.linkopsJobId, /^job-1-\d$/);
  }
});

test('a billing country with no profile is skipped, never dispatched anyway', async () => {
  // `RO` is a perfectly good proxy region but has no billing profile, so it can
  // route a checkout exit and still be an impossible country to bill in.
  const { service, store, linkops } = build({
    chain: { countryRules: [{ sourceCountryCode: 'default', billingCountry: 'RO', checkoutCountry: 'RO' }] },
  });
  const ids = store.list().map((record) => record.id);
  await assert.rejects(() => service.extract({ ids }), (error) => {
    assert.equal(error.statusCode, 400);
    assert.match(error.message, /没有对应的账单档案/);
    return true;
  });
  assert.equal(linkops.calls.length, 0, 'nothing was dispatched');
  for (const record of store.list()) assert.equal(record.status, 'pending', 'rows stay pending');
});

test('checkout region and billing profile are sent as the two separate axes they are', async () => {
  // Billing DE with a US exit is the whole point of having two fields.
  const { service, store, linkops } = build({
    chain: { countryRules: [{ sourceCountryCode: 'default', billingCountry: 'DE', checkoutCountry: 'US', updateCountry: 'US' }] },
  });
  await service.extract({ ids: store.list().map((record) => record.id) });
  const [call] = linkops.calls;
  assert.equal(call.options.checkoutCountry, 'US', 'the proxy region');
  assert.equal(call.options.billingCountry, 'DE', 'the billing profile');
  assert.equal(call.options.updateProxyCountry, 'US');
  assert.equal(call.options.applyCheckoutUpdate, true);
});

test('a row whose token went missing after it was ledgered is skipped, not dispatched blank', async () => {
  // The row exists because the account had a token when it was ledgered; the
  // asset lost it since. Dispatching an empty token would burn a job.
  const assets = [asset('asset-one-0001'), asset('asset-two-0002')];
  const { service, store, linkops } = build({ assets });
  const ids = store.list().map((record) => record.id);
  assets[1].accessToken = '';
  assets[1].hasAccessToken = false;

  const result = await service.extract({ ids });
  assert.equal(result.accepted.length, 1);
  assert.equal(result.skipped.length, 1);
  assert.match(result.skipped[0].reason, /提链队列|access token/i);
  assert.equal(result.skipped[0].id, store.list().find((row) => row.email.startsWith('asset-two')).id);
  assert.deepEqual(linkops.calls[0].input.tokens, ['at-asset-one-0001']);
});

test('a completed job writes its link back onto the ledger', async () => {
  const linkops = fakeLinkOps({
    jobs: async () => ({
      jobs: [{
        id: 'job-1-1',
        status: 'completed',
        result: {
          paypal_url: 'https://www.paypal.com/checkoutnow?token=abc',
          billing_country: 'GB',
          currency: 'GBP',
          amount_due: 1.2,
          checkout_session_id: 'cs_test',
        },
      }],
    }),
  });
  const { service, store } = build({ assets: [asset('asset-one-0001')], linkops });
  await service.extract({ ids: store.list().map((record) => record.id) });
  const live = await service.reconcileOnce();

  assert.equal(live, 0, 'nothing left in flight');
  const [record] = store.list();
  assert.equal(record.status, 'success');
  assert.equal(record.result.paypalUrl, 'https://www.paypal.com/checkoutnow?token=abc');
  assert.equal(record.result.currency, 'GBP');
});

test('a failed job records the engine error instead of a generic failure', async () => {
  const linkops = fakeLinkOps({
    jobs: async () => ({ jobs: [{ id: 'job-1-1', status: 'failed', error: '该账号不支持 PayPal', result: {} }] }),
  });
  // Rotation off, so this covers the write-off path on its own.
  const { service, store } = build({ assets: [asset('asset-one-0001')], linkops, chain: { autoRetry: 0 } });
  await service.extract({ ids: store.list().map((record) => record.id) });
  await service.reconcileOnce();

  const [record] = store.list();
  assert.equal(record.status, 'failed');
  assert.equal(record.lastError.message, '该账号不支持 PayPal');
});

test('a job the engine no longer knows about is left in flight rather than failed', async () => {
  const linkops = fakeLinkOps({ jobs: async () => ({ jobs: [] }) });
  const { service, store } = build({ assets: [asset('asset-one-0001')], linkops });
  await service.extract({ ids: store.list().map((record) => record.id) });
  const live = await service.reconcileOnce();

  assert.equal(live, 1);
  assert.equal(store.list()[0].status, 'running');
});

test('a completed job with no link is a failure, not a success with an empty url', async () => {
  const linkops = fakeLinkOps({ jobs: async () => ({ jobs: [{ id: 'job-1-1', status: 'completed', result: {} }] }) });
  const { service, store } = build({ assets: [asset('asset-one-0001')], linkops });
  await service.extract({ ids: store.list().map((record) => record.id) });
  await service.reconcileOnce();

  const [record] = store.list();
  assert.equal(record.status, 'failed');
  assert.match(record.lastError.message, /没有返回链接/);
});

test('a registration country with its own provider routes there instead of PayPal', async () => {
  const assets = [asset('asset-in-000001', 'IN'), asset('asset-vn-000002', 'VN'), asset('asset-id-000003', 'ID')];
  const { service, store, linkops } = build({ assets });
  await service.extract({ ids: store.list().map((record) => record.id) });

  const byProvider = new Map(linkops.calls.map((call) => [call.provider, call]));
  assert.deepEqual([...byProvider.keys()].sort(), ['gopay', 'momo', 'upi']);
  // A single-country provider pins its own pool country, and the engine binds
  // proxies before the provider expands — so the country must still be sent.
  assert.deepEqual(byProvider.get('upi').options, {
    country: 'IN', proxyPoolId: 'upi-in', applyCheckoutUpdate: true, updateProxyCountry: 'IN', updateProxyPoolId: 'upi-in-update',
  });
  // MoMo derives every hop from one seed, so its update hop is turned off
  // explicitly rather than left to the binder's default.
  assert.deepEqual(byProvider.get('momo').options, { country: 'VN', proxyPoolId: 'momo-vn', applyCheckoutUpdate: false });
  assert.deepEqual(byProvider.get('gopay').options, {
    country: 'ID', proxyPoolId: 'gopay-id', applyCheckoutUpdate: true, updateProxyCountry: 'ID', updateProxyPoolId: 'gopay-id-update',
  });
  assert.equal(byProvider.get('upi').domain, 'extraction');
  for (const record of store.list()) {
    assert.ok(['upi', 'momo', 'gopay'].includes(record.linkopsProvider), record.linkopsProvider);
  }
});

test('rows batch per provider, so one country cannot drag another into its job', async () => {
  const assets = [asset('asset-in-000001', 'IN'), asset('asset-us-000002', 'US'), asset('asset-gb-000003', 'GB')];
  const { service, store, linkops } = build({ assets });
  await service.extract({ ids: store.list().map((record) => record.id) });

  // IN goes to UPI on its own; US and GB share the default PayPal route.
  assert.equal(linkops.calls.length, 2);
  const paypal = linkops.calls.find((call) => call.provider === 'paypal');
  assert.equal(paypal.input.tokens.length, 2);
  assert.equal(paypal.options.checkoutCountry, 'GB');
  assert.equal(paypal.options.billingCountry, 'GB');
});

test('a completed PayPal link rolls into payment when auto-continue is on', async () => {
  const linkops = fakeLinkOps({
    jobs: async ({ domain }) => (domain === 'extraction'
      ? { jobs: [{ id: 'job-1-1', status: 'completed', result: { paypal_url: 'https://www.paypal.com/x?token=t' } }] }
      : { jobs: [] }),
  });
  const { service, store } = build({
    assets: [asset('asset-one-0001')],
    linkops,
    chain: { country: 'GB', payment: { autoContinue: true, phone: '+15551230000', country: 'US' } },
  });
  await service.extract({ ids: store.list().map((record) => record.id) });
  await service.reconcileOnce();

  const payment = linkops.calls.find((call) => call.domain === 'payment');
  assert.ok(payment, 'a payment job was created');
  assert.equal(payment.provider, 'paypal');
  assert.equal(payment.input.baToken, 'https://www.paypal.com/x?token=t');
  assert.equal(payment.input.phone, '+15551230000');
  const [record] = store.list();
  assert.equal(record.status, 'success');
  assert.equal(record.paymentStatus, 'pending');
  assert.ok(record.paymentJobId);
});

test('a provider with no payment stage stops at the link instead of erroring', async () => {
  const linkops = fakeLinkOps({
    jobs: async ({ domain }) => (domain === 'extraction'
      ? { jobs: [{ id: 'job-1-1', status: 'completed', result: { provider_url: 'https://momo/x' } }] }
      : { jobs: [] }),
  });
  const { service, store } = build({
    assets: [asset('asset-vn-000001', 'VN')],
    linkops,
    chain: { payment: { autoContinue: true, phone: '+15551230000' } },
  });
  await service.extract({ ids: store.list().map((record) => record.id) });
  await service.reconcileOnce();

  assert.equal(linkops.calls.filter((call) => call.domain === 'payment').length, 0);
  const [record] = store.list();
  assert.equal(record.status, 'success');
  assert.equal(record.paymentStatus, 'pending', 'no payment was attempted');
  assert.equal(record.paymentJobId, '');
});

test('auto-continue without a phone number leaves the link unpaid rather than failing the run', async () => {
  const linkops = fakeLinkOps({
    jobs: async ({ domain }) => (domain === 'extraction'
      ? { jobs: [{ id: 'job-1-1', status: 'completed', result: { paypal_url: 'https://www.paypal.com/x' } }] }
      : { jobs: [] }),
  });
  const { service, store } = build({
    assets: [asset('asset-one-0001')],
    linkops,
    chain: { country: 'GB', payment: { autoContinue: true } },
  });
  await service.extract({ ids: store.list().map((record) => record.id) });
  await service.reconcileOnce();

  assert.equal(linkops.calls.filter((call) => call.domain === 'payment').length, 0);
  assert.equal(store.list()[0].status, 'success', 'the extraction still counts');
});

test('a settled payment job writes the payment status back', async () => {
  let paymentStatusValue = 'running';
  const linkops = fakeLinkOps({
    jobs: async ({ domain }) => (domain === 'extraction'
      ? { jobs: [{ id: 'job-1-1', status: 'completed', result: { paypal_url: 'https://www.paypal.com/x' } }] }
      : { jobs: [{ id: 'job-2-1', status: paymentStatusValue }] }),
  });
  const { service, store } = build({
    assets: [asset('asset-one-0001')],
    linkops,
    chain: { country: 'GB', payment: { autoContinue: true, phone: '+1555' } },
  });
  await service.extract({ ids: store.list().map((record) => record.id) });
  await service.reconcileOnce();
  assert.equal(store.list()[0].paymentStatus, 'pending');

  paymentStatusValue = 'completed';
  await service.reconcileOnce();
  assert.equal(store.list()[0].paymentStatus, 'success');
});

test('auto-continue cannot be saved without a number to sign with', () => {
  const { service } = build({ assets: [asset('asset-one-0001')] });
  assert.throws(() => service.savePaymentSettings({ autoContinue: true, phone: '', country: 'US' }), (error) => {
    assert.equal(error.statusCode, 400);
    assert.match(error.message, /必须先填支付手机号/);
    return true;
  });
  // A country with no billing profile cannot sign a payment either.
  assert.throws(() => service.savePaymentSettings({ phone: '+1555', country: 'RO' }), /没有对应的账单档案/);
  assert.deepEqual(
    service.savePaymentSettings({ autoContinue: true, phone: '+1555', country: 'gb' }),
    { autoContinue: true, phone: '+1555', country: 'GB' },
  );
});

test('a row can carry its own payment number, overriding the shared default', async () => {
  const linkops = fakeLinkOps({
    jobs: async ({ domain }) => (domain === 'extraction'
      ? { jobs: [{ id: 'job-1-1', status: 'completed', result: { paypal_url: 'https://www.paypal.com/x' } }] }
      : { jobs: [] }),
  });
  const { service, store } = build({
    assets: [asset('asset-one-0001')],
    linkops,
    chain: { countryRules: [{ sourceCountryCode: 'default', billingCountry: 'GB', checkoutCountry: 'GB' }], payment: { autoContinue: true, phone: '+1000000000' } },
  });
  const [row] = store.list();
  service.savePaymentPhone(row.id, '+1999999999');
  await service.extract({ ids: [row.id] });
  await service.reconcileOnce();

  const payment = linkops.calls.find((call) => call.domain === 'payment');
  assert.equal(payment.input.phone, '+1999999999', 'the row wins over the default');
});

test('a provider chosen at import overrides the registration country', async () => {
  const assets = [asset('asset-us-000001', 'US')];
  const { service, store, linkops } = build({ assets });
  // A US account would normally be a PayPal row; the operator says UPI.
  await service.importTokens({ content: '', provider: 'upi' }).catch(() => {});
  store.update(store.list()[0].id, { routeProvider: 'upi' });
  await service.extract({ ids: store.list().map((record) => record.id) });

  assert.equal(linkops.calls[0].provider, 'upi');
  assert.deepEqual(linkops.calls[0].options, {
    country: 'IN', proxyPoolId: 'upi-in', applyCheckoutUpdate: true, updateProxyCountry: 'IN', updateProxyPoolId: 'upi-in-update',
  });
});

test('a PayPal import names an existing route rather than a loose country', async () => {
  const { service, store, linkops } = build({
    assets: [asset('asset-us-000001', 'US')],
    chain: {
      countryRules: [
        { sourceCountryCode: 'default', billingCountry: 'US', checkoutCountry: 'US', updateCountry: 'US' },
        { sourceCountryCode: 'TH', billingCountry: 'DE', checkoutCountry: 'TH', updateCountry: 'TH' },
      ],
    },
  });
  assert.deepEqual(service.normalizeImportRoute({ provider: 'paypal', routeKey: 'TH' }), { routeProvider: 'paypal', routeKey: 'TH' });
  assert.throws(() => service.normalizeImportRoute({ provider: 'paypal', routeKey: 'ZZ' }), /路由表里没有/);

  store.update(store.list()[0].id, { routeProvider: 'paypal', routeKey: 'TH' });
  await service.extract({ ids: store.list().map((record) => record.id) });
  // The TH route, not the US registration country's default.
  assert.equal(linkops.calls[0].options.checkoutCountry, 'TH');
  assert.equal(linkops.calls[0].options.billingCountry, 'DE');
});

test('every dispatch names the engine pool it is allowed to draw from', () => {
  const { dispatchOptionsFor, requiredProxyPools } = require('../src/chain-routing');

  // The engine rejects an unnamed pool before it looks one up, so a stocked
  // pool is not enough — the id has to travel with the job.
  const paypal = dispatchOptionsFor('paypal', { checkoutCountry: 'TH', billingCountry: 'DE', updateCountry: 'TH' });
  assert.equal(paypal.options.proxyPoolId, 'paypal-th');
  assert.equal(paypal.options.updateProxyPoolId, 'paypal-th-update');

  // A fixed-country provider names its own pools, never the PayPal table's.
  assert.equal(dispatchOptionsFor('upi', { checkoutCountry: 'US' }).options.proxyPoolId, 'upi-in');
  assert.equal(dispatchOptionsFor('upi', { checkoutCountry: 'US' }).options.updateProxyPoolId, 'upi-in-update');
  assert.equal(dispatchOptionsFor('gopay', {}).options.proxyPoolId, 'gopay-id');

  // MoMo turns the update hop off, so it must not name an update pool at all.
  const momo = dispatchOptionsFor('momo', {});
  assert.equal(momo.options.proxyPoolId, 'momo-vn');
  assert.equal(momo.options.updateProxyPoolId, undefined);

  // What the console offers to stock and what a job asks for are the same ids.
  const pools = requiredProxyPools({ default: { checkoutCountry: 'TH', billingCountry: 'DE', updateCountry: 'TH' } });
  const ids = new Set(pools.map((pool) => pool.id));
  assert.ok(ids.has('paypal-th'));
  assert.ok(ids.has('paypal-th-update'));
  assert.ok(ids.has('momo-vn'));
});

test('a failed extraction is put back on the next proxy instead of written off', async () => {
  const linkops = fakeLinkOps({
    jobs: async () => ({ jobs: [{ id: 'job-1-1', status: 'failed', error: '代理连接失败', can_retry: true, result: {} }] }),
  });
  const { service, store } = build({ assets: [asset('asset-one-0001')], linkops, chain: { autoRetry: 2 } });
  await service.extract({ ids: store.list().map((record) => record.id) });

  // Each pass sees the same failed job and spends one rotation.
  assert.equal(await service.reconcileOnce(), 1, 'the row is back in flight, not failed');
  assert.equal(store.list()[0].status, 'running');
  assert.equal(store.list()[0].linkopsRetryCount, 1);
  assert.deepEqual(linkops.retries, ['job-1-1']);

  assert.equal(await service.reconcileOnce(), 1);
  assert.equal(store.list()[0].linkopsRetryCount, 2);

  // Budget spent: now it is a real failure, and the row says what it cost.
  assert.equal(await service.reconcileOnce(), 0);
  const [record] = store.list();
  assert.equal(record.status, 'failed');
  assert.equal(record.lastError.message, '代理连接失败（已换 2 个代理仍失败）');
  assert.equal(linkops.retries.length, 2, 'no rotation is attempted past the budget');
});

test('an exhausted proxy pool fails the row rather than looping', async () => {
  const linkops = fakeLinkOps({
    jobs: async () => ({ jobs: [{ id: 'job-1-1', status: 'failed', error: '代理连接失败', can_retry: true, result: {} }] }),
    retryJob: async () => { throw new Error('没有可用的 Checkout 重试代理'); },
  });
  const { service, store } = build({ assets: [asset('asset-one-0001')], linkops, chain: { autoRetry: 3 } });
  await service.extract({ ids: store.list().map((record) => record.id) });
  assert.equal(await service.reconcileOnce(), 0);

  const [record] = store.list();
  assert.equal(record.status, 'failed');
  assert.match(record.lastError.message, /没有可用的 Checkout 重试代理/);
});

test('a re-dispatch starts the rotation budget over', async () => {
  const linkops = fakeLinkOps({
    jobs: async () => ({ jobs: [{ id: 'job-1-1', status: 'failed', error: '代理连接失败', can_retry: true, result: {} }] }),
  });
  const { service, store } = build({ assets: [asset('asset-one-0001')], linkops, chain: { autoRetry: 1 } });
  await service.extract({ ids: store.list().map((record) => record.id) });
  await service.reconcileOnce();
  assert.equal(store.list()[0].linkopsRetryCount, 1);
  await service.reconcileOnce();
  assert.equal(store.list()[0].status, 'failed');

  await service.extract({ ids: store.list().map((record) => record.id) });
  assert.equal(store.list()[0].linkopsRetryCount, 0);
});

test('a large dispatch is cut into chunks and sent with several calls in flight', async () => {
  let inFlight = 0;
  let peak = 0;
  const linkops = fakeLinkOps({
    createJob: async (payload) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inFlight -= 1;
      const tokens = payload.input.tokens;
      return { ok: true, jobs: tokens.map((token) => ({ id: `job-${token}` })) };
    },
  });
  const assets = Array.from({ length: 45 }, (_unused, index) => asset(`asset-bulk-${String(index).padStart(4, '0')}`));
  const { service, store } = build({ assets, linkops, chain: { dispatchConcurrency: 3 } });

  const result = await service.extract({ ids: store.list().map((record) => record.id) });

  // 45 rows in one country: three chunks of 20/20/5, not one call of 45.
  assert.equal(result.accepted.length, 45);
  assert.ok(peak > 1, 'chunks are dispatched concurrently');
  assert.ok(peak <= 3, `concurrency stays within the configured limit, saw ${peak}`);
  // Every row still carries the job the engine actually made for its token.
  for (const record of store.list()) {
    assert.equal(record.status, 'running');
    assert.ok(record.linkopsJobId.startsWith('job-'), `${record.id} has no engine job`);
  }
  assert.equal(new Set(store.list().map((record) => record.linkopsJobId)).size, 45, 'no job id is reused across rows');
});

test('one failing chunk does not take the rest of the dispatch with it', async () => {
  let call = 0;
  const linkops = fakeLinkOps({
    createJob: async (payload) => {
      call += 1;
      if (call === 1) throw new Error('引擎拒绝：代理池已过期');
      return { ok: true, jobs: payload.input.tokens.map((token) => ({ id: `job-${token}` })) };
    },
  });
  const assets = Array.from({ length: 30 }, (_unused, index) => asset(`asset-part-${String(index).padStart(4, '0')}`));
  const { service, store } = build({ assets, linkops, chain: { dispatchConcurrency: 1 } });

  const result = await service.extract({ ids: store.list().map((record) => record.id) });
  assert.equal(result.accepted.length, 10, 'the second chunk still went out');
  assert.equal(result.skipped.length, 20);
  assert.match(result.skipped[0].reason, /代理池已过期/);
  assert.equal(store.list().filter((record) => record.status === 'running').length, 10);
});

test('a repeated access token is refused instead of shifting the job mapping', async () => {
  // The engine de-duplicates its token list, so sending the same AT twice comes
  // back one job short and every later row would inherit the wrong job.
  const shared = { ...asset('asset-dup-0002'), accessToken: 'at-asset-dup-0001' };
  const { service, store, linkops } = build({ assets: [asset('asset-dup-0001'), shared, asset('asset-dup-0003')] });

  const result = await service.extract({ ids: store.list().map((record) => record.id) });

  assert.equal(linkops.calls[0].input.tokens.length, 2, 'the duplicate never reaches the engine');
  assert.equal(result.accepted.length, 2);
  const [refused] = result.skipped;
  assert.match(refused.reason, /access token 与 .* 重复/);
  assert.equal(store.list().find((record) => record.id === 'asset-dup-0002').status, 'pending');
});

test('an engine answer that is short of jobs fails the chunk rather than mismapping it', async () => {
  const linkops = fakeLinkOps({
    // One job back for two tokens: which row it belongs to is unknowable.
    createJob: async () => ({ ok: true, jobs: [{ id: 'job-only-one' }] }),
  });
  const { service, store } = build({ linkops });

  const result = await service.extract({ ids: store.list().map((record) => record.id) });
  assert.equal(result.accepted.length, 0);
  assert.equal(result.skipped.length, 2);
  assert.match(result.skipped[0].reason, /只为 2 个 token 建了 1 个作业/);
  assert.ok(store.list().every((record) => record.status === 'pending'), 'no row claims a job it may not own');
});

test('the token list is sent in the field every provider can read', async () => {
  const { service, store, linkops } = build({ assets: [asset('asset-vn-0001', 'VN'), asset('asset-vn-0002', 'VN')] });
  await service.extract({ ids: store.list().map((record) => record.id) });

  const [call] = linkops.calls;
  assert.equal(call.provider, 'momo');
  // MoMo reads `text` and stringifies anything else, so an array alone arrives
  // as its Python repr and collapses the whole batch into one bad token.
  assert.equal(call.input.text, 'at-asset-vn-0001\nat-asset-vn-0002');
  assert.deepEqual(call.input.tokens, ['at-asset-vn-0001', 'at-asset-vn-0002']);
});

test('a row left running without an engine job is returned to the queue', async () => {
  const linkops = fakeLinkOps({ jobs: async () => ({ jobs: [] }) });
  const { service, store } = build({ assets: [asset('asset-one-0001')], linkops });
  const [id] = store.list().map((record) => record.id);

  // The residue of a dispatch whose answer did not line up: running, no job.
  store.markRunning(id, { country: 'GB', provider: 'momo' });
  store.update(id, { linkopsJobId: '', startedAt: new Date(Date.now() - 300_000).toISOString() });
  assert.equal(store.list()[0].status, 'running');

  await service.reconcileOnce();
  const [record] = store.list();
  assert.equal(record.status, 'pending', 'it can be dispatched again instead of waiting forever');
  assert.equal(record.lastError.code, 'CHAIN_NO_ENGINE_JOB');
});

test('a dispatch still writing its job ids is not swept up as an orphan', async () => {
  const linkops = fakeLinkOps({ jobs: async () => ({ jobs: [] }) });
  const { service, store } = build({ assets: [asset('asset-one-0001')], linkops });
  const [id] = store.list().map((record) => record.id);
  store.markRunning(id, { country: 'GB', provider: 'paypal' });

  await service.reconcileOnce();
  assert.equal(store.list()[0].status, 'running');
});

test('opening the console resumes a reconciler that a restart left stopped', async () => {
  const linkops = fakeLinkOps({ jobs: async () => ({ jobs: [] }) });
  const { service, store } = build({ assets: [asset('asset-one-0001')], linkops });
  const [id] = store.list().map((record) => record.id);
  store.markRunning(id, { country: 'GB', provider: 'paypal' });
  store.update(id, { linkopsJobId: 'job-from-a-previous-process' });

  assert.ok(!service.reconcileTimer, 'nothing polls until the ledger is read');
  service.snapshot();
  assert.ok(service.reconcileTimer, 'a row still in flight restarts the poll loop');
  clearTimeout(service.reconcileTimer);
  service.reconcileTimer = null;
});

test('only a failure another exit could fix spends a proxy rotation', () => {
  const { isProxyFailure } = require('../src/ui-server/chain-service');

  // The engine's own verdict that this exit does not work.
  assert.ok(isProxyFailure('MoMo 代理预检连续 4 次失败：Proxy preflight returned HTTP 502'));
  assert.ok(isProxyFailure("PayPal checkout proxy preflight failed after 4 attempts: curl: (7) Couldn't connect"));
  assert.ok(isProxyFailure('Connection reset by peer'));
  assert.ok(isProxyFailure('read timed out'));

  // The account's problem: another exit changes nothing.
  assert.ok(!isProxyFailure('当前账号未提供 MoMo 支付方式：no method'));
  assert.ok(!isProxyFailure('无法解析 ChatGPT Access Token'));
  assert.ok(!isProxyFailure('该账号不支持 PayPal'));

  // The configuration's problem: the next entry comes from the same bad pool.
  assert.ok(!isProxyFailure('请先配置有效的 ID 代理池'));
  assert.ok(!isProxyFailure('Checkout 代理池已过期，请先刷新代理池'));
  assert.ok(!isProxyFailure('MoMo 代理预检没有可用候选'));
});

test('an account-level failure is not retried at all', async () => {
  const linkops = fakeLinkOps({
    jobs: async () => ({ jobs: [{ id: 'job-1-1', status: 'failed', error: '当前账号未提供 MoMo 支付方式', can_retry: true, result: {} }] }),
  });
  const { service, store } = build({ assets: [asset('asset-one-0001')], linkops, chain: { autoRetry: 3 } });
  await service.extract({ ids: store.list().map((record) => record.id) });

  assert.equal(await service.reconcileOnce(), 0);
  const [record] = store.list();
  assert.equal(record.status, 'failed');
  assert.equal(record.lastError.message, '当前账号未提供 MoMo 支付方式', 'no rotation suffix: none was spent');
  assert.equal(linkops.retries.length, 0, 'the proxy budget is untouched');
});

test('an interrupted job is re-dispatched because the engine restarted, not the exit', async () => {
  const linkops = fakeLinkOps({
    jobs: async () => ({ jobs: [{ id: 'job-1-1', status: 'interrupted', error: '服务重启', can_retry: true, result: {} }] }),
  });
  const { service, store } = build({ assets: [asset('asset-one-0001')], linkops, chain: { autoRetry: 2 } });
  await service.extract({ ids: store.list().map((record) => record.id) });

  assert.equal(await service.reconcileOnce(), 1);
  assert.equal(store.list()[0].status, 'running');
  assert.deepEqual(linkops.retries, ['job-1-1']);
});
