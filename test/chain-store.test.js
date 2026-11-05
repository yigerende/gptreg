'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { ChainStore, maskedToken, qualifiesForChain, recordSummary } = require('../src/chain-store');

function store(t, now = () => 1000) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-chain-store-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return new ChainStore({ cwd, stateDir: '.state', now });
}

// Only the one-month free campaign can be redeemed by `checkout/update`, so the
// fixtures carry the campaign list the gate actually reads.
const FREE_MONTH_CAMPAIGN = {
  key: 'plus',
  id: 'plus-1-month-free',
  planName: 'chatgptplusplan',
  label: '1-month free trial',
  durationPeriods: 1,
  durationPeriod: 'month',
  discountPercentage: 100,
  offerKind: 'free_month',
  offerLabel: '1个月免费',
};

const HALF_PRICE_CAMPAIGN = {
  key: 'go',
  id: 'go-3-month-half-off',
  planName: 'chatgptgoplan',
  label: '3-month 50% off',
  durationPeriods: 3,
  durationPeriod: 'month',
  discountPercentage: 50,
  offerKind: 'discounted',
  offerLabel: '3个月半价',
};

function trial(overrides = {}) {
  return {
    status: 'trial',
    checkedAt: '2026-08-14T00:00:00.000Z',
    campaigns: [FREE_MONTH_CAMPAIGN],
    offerKind: 'free_month',
    offerLabel: '1个月免费',
    freeMonthOffer: true,
    ...overrides,
  };
}

function asset(overrides = {}) {
  return {
    id: 'asset-chain-0001',
    email: 'chain@example.test',
    accountId: 'account-chain',
    hasAccessToken: true,
    accessToken: 'access-token-value-that-is-long-enough',
    trial: trial(),
    ...overrides,
  };
}

test('only free-month trial accounts holding a token qualify', () => {
  assert.equal(qualifiesForChain(asset()), true);
  assert.equal(qualifiesForChain(asset({ trial: { status: 'none' } })), false);
  assert.equal(qualifiesForChain(asset({ trial: null })), false);
  assert.equal(qualifiesForChain(asset({ hasAccessToken: false, accessToken: '' })), false);
});

test('a discounted campaign is a trial the chain cannot use, so it stays out of the queue', () => {
  const discounted = asset({
    trial: trial({ campaigns: [HALF_PRICE_CAMPAIGN], offerKind: 'discounted', offerLabel: '3个月半价', freeMonthOffer: false }),
  });
  assert.equal(discounted.trial.status, 'trial');
  assert.equal(qualifiesForChain(discounted), false);
  // A free month offered alongside the discount still opens the gate.
  assert.equal(qualifiesForChain(asset({
    trial: trial({ campaigns: [HALF_PRICE_CAMPAIGN, FREE_MONTH_CAMPAIGN] }),
  })), true);
});

test('a trial recorded before the offer classification existed is graded from its campaigns', () => {
  // Records written by the previous build have no `freeMonthOffer` at all.
  const legacyFree = { status: 'trial', checkedAt: '2026-08-01T00:00:00.000Z', campaigns: [{ ...FREE_MONTH_CAMPAIGN, offerKind: undefined, offerLabel: undefined }] };
  const legacyDiscount = { status: 'trial', checkedAt: '2026-08-01T00:00:00.000Z', campaigns: [{ ...HALF_PRICE_CAMPAIGN, offerKind: undefined, offerLabel: undefined }] };
  assert.equal(qualifiesForChain(asset({ trial: legacyFree })), true);
  assert.equal(qualifiesForChain(asset({ trial: legacyDiscount })), false);
  // No campaign data at all is not evidence of a claimable free month.
  assert.equal(qualifiesForChain(asset({ trial: { status: 'trial', checkedAt: '2026-08-01T00:00:00.000Z' } })), false);
});

test('the token preview never carries the whole secret', () => {
  const preview = maskedToken('access-token-value-that-is-long-enough');
  assert.equal(preview.includes('…'), true);
  assert.equal(preview.includes('value-that-is-long'), false);
  assert.equal(maskedToken(''), '');
});

test('record summaries preserve an unknown chain eligibility projection', () => {
  assert.equal(recordSummary({ id: 'asset-chain-0001', chainEligible: null }).chainEligible, null);
  assert.equal(recordSummary({ id: 'asset-chain-0001' }).chainEligible, null);
  assert.equal(recordSummary({ id: 'asset-chain-0001', chainEligible: false }).chainEligible, false);
});

test('sync seeds trial accounts and drops the ones that lose eligibility', (t) => {
  const chains = store(t);
  const seeded = chains.sync([asset(), asset({ id: 'asset-chain-0002', email: 'second@example.test' })]);
  assert.equal(seeded.length, 2);
  assert.equal(seeded.every((record) => record.status === 'pending'), true);
  assert.equal(seeded[0].accessTokenPreview.includes('…'), true);
  assert.equal(JSON.stringify(seeded).includes('access-token-value-that-is-long-enough'), false);

  const reduced = chains.sync([asset()]);
  assert.deepEqual(reduced.map((record) => record.id), ['asset-chain-0001']);
});

test('legacy oauth chain records remain addressable after asset grouping is enabled', (t) => {
  const chains = store(t);
  const legacy = chains.sync([asset({ sourceKind: 'oauth', email: 'legacy-oauth@example.test' })]);
  assert.equal(legacy.length, 1);
  assert.equal(legacy[0].sourceKind, 'oauth');

  const updated = chains.update(legacy[0].id, { paymentStatus: 'success' });
  assert.equal(updated.paymentStatus, 'success');
});

test('chain records retain the registration proxy country', (t) => {
  const chains = store(t);
  const seeded = chains.sync([asset({ sourceProxy: { countryCode: 'JP' } })]);
  assert.equal(seeded[0].sourceCountryCode, 'JP');

  // A later refresh may not carry the original registration exit; do not erase
  // the country that identifies where the account was created.
  const refreshed = chains.sync([asset({ sourceProxy: null })]);
  assert.equal(refreshed[0].sourceCountryCode, 'JP');
});

test('sync does not persist a payment status derived from the follow-up projection', (t) => {
  const chains = store(t);
  chains.sync([asset()]);
  chains.update('asset-chain-0001', {
    paypalFollowup: { status: 'completed', stage: 'completed' },
  });

  const before = JSON.parse(fs.readFileSync(chains.filePath, 'utf8'));
  assert.equal(Object.hasOwn(before.records['asset-chain-0001'], 'paymentStatus'), false);
  assert.equal(chains.sync([asset()])[0].paymentStatus, 'success');

  const after = JSON.parse(fs.readFileSync(chains.filePath, 'utf8'));
  assert.equal(Object.hasOwn(after.records['asset-chain-0001'], 'paymentStatus'), false);
});

test('only a new payment-success transition creates one refresh event', (t) => {
  const chains = store(t);
  const id = 'asset-chain-0001';
  chains.sync([asset()]);

  const first = chains.markPaymentStatus([id], 'success');
  assert.deepEqual(first.changed, [id]);
  const queued = chains.get(id).paymentRefresh;
  assert.equal(queued.status, 'pending');
  assert.ok(queued.requestedAt);

  const repeated = chains.markPaymentStatus([id], 'success');
  assert.deepEqual(repeated.changed, []);
  assert.deepEqual(chains.get(id).paymentRefresh, queued);

  chains.update(id, {
    paymentRefresh: { ...queued, status: 'failed', lastError: { code: 'TEST_FAILURE' } },
  });
  const failedRepeat = chains.markPaymentStatus([id], 'success');
  assert.deepEqual(failedRepeat.changed, [], 'a failed attempt is not reset by repeating the same payment mark');
  assert.equal(chains.get(id).paymentRefresh.status, 'failed');
});

test('legacy payment-success projections do not create a refresh event', (t) => {
  const chains = store(t);
  const id = 'asset-chain-0001';
  chains.sync([asset()]);
  chains.update(id, { paypalFollowup: { status: 'completed', stage: 'completed' } });

  assert.equal(chains.get(id).paymentStatus, 'success');
  assert.equal(chains.get(id).paymentRefresh.status, 'idle');
  chains.markPaymentStatus([id], 'success');
  assert.equal(chains.get(id).paymentRefresh.status, 'idle');
  assert.equal(chains.get(id).paymentRefresh.requestedAt, '');
});

test('a record that already produced a link survives losing its trial flag', (t) => {
  const chains = store(t);
  chains.sync([asset()]);
  chains.markSuccess('asset-chain-0001', { paypalUrl: 'https://paypal.test/x', sessionKindLabel: 'oaics' });
  const kept = chains.sync([]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].result.paypalUrl, 'https://paypal.test/x');
});

test('status transitions track attempts and keep a bounded error history', (t) => {
  const chains = store(t);
  chains.sync([asset()]);
  chains.markRunning('asset-chain-0001', { country: 'GB' });
  assert.equal(chains.get('asset-chain-0001').status, 'running');
  assert.equal(chains.get('asset-chain-0001').request.country, 'GB');

  chains.markFailed('asset-chain-0001', { code: 'CHAIN_TIMEOUT', message: 'timed out' });
  const failed = chains.get('asset-chain-0001');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.attempts, 1);
  assert.equal(failed.lastError.code, 'CHAIN_TIMEOUT');

  chains.markSuccess('asset-chain-0001', { sessionKindLabel: 'cs', checkoutSessionId: 'cs_x', checkoutUpdateApplied: true });
  const done = chains.get('asset-chain-0001');
  assert.equal(done.status, 'success');
  assert.equal(done.attempts, 2);
  assert.equal(done.lastError, null);
  assert.equal(done.sessionKindLabel, 'cs');
  assert.equal(done.checkoutUpdateApplied, true);
});

test('removal reports what was actually there', (t) => {
  const chains = store(t);
  chains.sync([asset()]);
  const result = chains.remove(['asset-chain-0001', 'asset-chain-9999']);
  assert.deepEqual(result.removed, ['asset-chain-0001']);
  assert.deepEqual(result.missing, ['asset-chain-9999']);
  assert.equal(chains.list().length, 0);
});

test('a corrupt ledger degrades to an empty list instead of throwing', (t) => {
  const chains = store(t);
  chains.sync([asset()]);
  fs.writeFileSync(chains.filePath, '{ not json');
  assert.deepEqual(chains.list(), []);
});

test('re-running a record clears the previous outcome instead of mixing two runs', (t) => {
  const chains = store(t);
  chains.sync([asset()]);
  const id = 'asset-chain-0001';

  chains.markRunning(id, { country: 'GB' });
  chains.markSuccess(id, {
    paypalUrl: 'https://www.paypal.com/webapps/hermes?token=EC-FIRST',
    billingCountry: 'GB',
    amount: '20.00',
    transport: 'impit',
  });
  assert.equal(chains.get(id).result.billingCountry, 'GB');

  // Same account, new billing country.
  const running = chains.markRunning(id, { country: 'TH' });
  assert.equal(running.result, null, 'the previous run must not describe this one');
  assert.equal(running.request.country, 'TH');

  // A failure now shows only the failure — not last week's link.
  const failed = chains.markFailed(id, { code: 'CHAIN_TIMEOUT', message: 'timed out' });
  assert.equal(failed.result, null);
  assert.equal(failed.lastError.code, 'CHAIN_TIMEOUT');
  assert.equal(JSON.stringify(failed).includes('EC-FIRST'), false);
});
