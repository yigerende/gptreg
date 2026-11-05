'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  DEFAULT_TRIAL_CHECK_PROXY,
  checkSessionAssetTrial,
  checkSessionAssetTrials,
  classifyTrialResponse,
} = require('../src/session-trial-check');
const { SessionAssetStore } = require('../src/session-asset-store');

// Shapes below mirror a captured chatgpt.com/backend-api/accounts/check/v4
// response: an eligible account exposes the promo campaign, a spent account
// returns the same envelope with an empty campaign map.
function accountPayload(accountId, { campaigns = {}, planType = 'free', trial = null, previouslyPaid = false } = {}) {
  return {
    accounts: {
      [accountId]: {
        account: {
          account_id: accountId,
          plan_type: planType,
          has_previously_paid_subscription: previouslyPaid,
          is_most_recent_expired_subscription_gratis: false,
        },
        features: ['gpt5'],
        entitlement: {
          subscription_id: null,
          has_active_subscription: false,
          subscription_plan: 'chatgptfreeplan',
          trial,
        },
        eligible_promo_campaigns: campaigns,
        eligible_offers: { offers: [{ id: 'chatgptplusplan' }], default_offer_id: 'chatgptplusplan' },
      },
    },
    account_ordering: [accountId],
  };
}

const PLUS_TRIAL_CAMPAIGN = {
  plus: {
    id: 'plus-1-month-free',
    metadata: {
      plan_name: 'chatgptplusplan',
      title: 'Try Plus free for 1 month',
      discount: { percentage: 100 },
      duration: { num_periods: 1, period: 'month' },
      promotion_type: 'discount',
      promotion_type_label: '1-month free trial',
    },
  },
};

// The other shape seen in the wild: a discounted run rather than a free month,
// usually three months at half price on the Go plan. It is a real campaign, but
// not one `checkout/update` can redeem.
const GO_DISCOUNT_CAMPAIGN = {
  go: {
    id: 'go-3-month-half-off',
    metadata: {
      plan_name: 'chatgptgoplan',
      title: 'Go for 3 months at 50% off',
      discount: { percentage: 50 },
      duration: { num_periods: 3, period: 'month' },
      promotion_type: 'discount',
      promotion_type_label: '3-month 50% off',
    },
  },
};

function response(status, payload = {}) {
  return {
    // `json` mirrors what UrlSession derives from the body, so the classifier
    // can be exercised directly as well as through the transport.
    json: payload,
    response: {
      status,
      url: 'https://chatgpt.com/backend-api/accounts/check/v4-2023-04-27',
      location: '',
      contentType: 'application/json',
      text: JSON.stringify(payload),
    },
  };
}

test('an eligible promo campaign is classified as a claimable trial', () => {
  const classification = classifyTrialResponse(
    { id: 'asset-trial', email: 'person@example.test', accountId: 'account-trial' },
    response(200, accountPayload('account-trial', { campaigns: PLUS_TRIAL_CAMPAIGN })),
  );

  assert.equal(classification.status, 'trial');
  assert.equal(classification.code, 'TRIAL_OFFER_AVAILABLE');
  assert.equal(classification.campaigns.length, 1);
  assert.deepEqual(classification.campaigns[0], {
    key: 'plus',
    id: 'plus-1-month-free',
    planName: 'chatgptplusplan',
    label: '1-month free trial',
    durationPeriods: 1,
    durationPeriod: 'month',
    discountPercentage: 100,
    offerKind: 'free_month',
    offerLabel: 'Plus 1个月免费',
    offerPlanLabel: 'Plus',
  });
  assert.equal(classification.offerKind, 'free_month');
  assert.equal(classification.offerLabel, 'Plus 1个月免费');
  // Persisted separately so a caller can act on the plan without parsing it
  // back out of the label.
  assert.equal(classification.offerPlan, 'chatgptplusplan');
  assert.equal(classification.offerPlanLabel, 'Plus');
  assert.equal(classification.freeMonthOffer, true);
});

test('a discounted campaign is still a trial but is not a claimable free month', () => {
  const classification = classifyTrialResponse(
    { id: 'asset-discount', email: 'person@example.test', accountId: 'account-discount' },
    response(200, accountPayload('account-discount', { campaigns: GO_DISCOUNT_CAMPAIGN })),
  );

  assert.equal(classification.status, 'trial');
  assert.equal(classification.code, 'TRIAL_OFFER_AVAILABLE');
  assert.equal(classification.campaigns[0].offerKind, 'discounted');
  assert.equal(classification.offerKind, 'discounted');
  assert.equal(classification.offerLabel, 'Go 3个月半价');
  assert.equal(classification.offerPlan, 'chatgptgoplan');
  // This is the flag the chain queue reads; a half-price run must never set it.
  assert.equal(classification.freeMonthOffer, false);
});

test('a redeemable free month outranks a discounted campaign offered alongside it', () => {
  const classification = classifyTrialResponse(
    { id: 'asset-both', email: 'person@example.test', accountId: 'account-both' },
    response(200, accountPayload('account-both', { campaigns: { ...GO_DISCOUNT_CAMPAIGN, ...PLUS_TRIAL_CAMPAIGN } })),
  );

  assert.equal(classification.campaigns.length, 2);
  assert.equal(classification.offerKind, 'free_month');
  assert.equal(classification.freeMonthOffer, true);
  assert.match(classification.message, /chatgptplusplan/);
});

test('an empty campaign map is classified as no trial', () => {
  const classification = classifyTrialResponse(
    { id: 'asset-none', email: 'person@example.test', accountId: 'account-none' },
    response(200, accountPayload('account-none', { previouslyPaid: true })),
  );

  assert.equal(classification.status, 'none');
  assert.equal(classification.code, 'TRIAL_UNAVAILABLE');
  assert.equal(classification.hasPreviouslyPaid, true);
  assert.deepEqual(classification.campaigns, []);
});

test('an account already inside a trial is reported as an active trial', () => {
  const classification = classifyTrialResponse(
    { id: 'asset-active', email: 'person@example.test', accountId: 'account-active' },
    response(200, accountPayload('account-active', { planType: 'plus', trial: { expires_at: '2026-09-01T00:00:00Z' } })),
  );

  assert.equal(classification.status, 'trial');
  assert.equal(classification.code, 'TRIAL_ACTIVE');
  assert.equal(classification.activeTrial, true);
});

test('the default account entry answers for assets without a stored account id', () => {
  const payload = accountPayload('account-keyed', { campaigns: PLUS_TRIAL_CAMPAIGN });
  payload.accounts.default = payload.accounts['account-keyed'];
  const classification = classifyTrialResponse({ id: 'asset-default', email: 'person@example.test' }, response(200, payload));

  assert.equal(classification.status, 'trial');
});

test('rejected, throttled, and unrecognised responses stay unknown instead of guessing', () => {
  const asset = { id: 'asset-http', email: 'person@example.test', accountId: 'account-http' };
  const run = (status, payload = {}) => classifyTrialResponse(asset, response(status, payload));

  assert.equal(run(401).code, 'TRIAL_UNAUTHORIZED');
  assert.equal(run(403).code, 'TRIAL_FORBIDDEN');
  assert.equal(run(429).code, 'TRIAL_RATE_LIMITED');
  assert.equal(run(503).code, 'TRIAL_SERVICE_UNAVAILABLE');
  assert.equal(run(302).code, 'TRIAL_CHECK_REJECTED');
  assert.equal(run(200, { accounts: {} }).code, 'TRIAL_ACCOUNT_MISSING');
  assert.equal([...new Set([401, 403, 429, 503, 302].map((status) => run(status).status))].join(), 'unknown');
});

test('the promo check sends the documented headers over the fixed local proxy', async () => {
  let captured;
  const result = await checkSessionAssetTrial({
    id: 'asset-headers',
    email: 'person@example.test',
    accountId: 'account-headers',
    accessToken: 'access-trial-secret',
    oaiDid: 'device-trial',
    cookieJar: { cookies: [{ key: 'session-token', value: 'must-not-be-sent' }] },
    sourceProxy: { url: 'http://127.0.0.1:4001' },
  }, {
    now: () => 1000,
    executor: async (request, options) => {
      captured = { request, options };
      return response(200, accountPayload('account-headers', { campaigns: PLUS_TRIAL_CAMPAIGN }));
    },
  });

  assert.equal(result.status, 'trial');
  assert.equal(result.trialAvailable, true);
  assert.equal(captured.options.proxy, DEFAULT_TRIAL_CHECK_PROXY);
  assert.match(captured.request.url, /\/backend-api\/accounts\/check\/v4-2023-04-27\?timezone_offset_min=-?\d+$/);
  assert.equal(captured.request.headers.Authorization, 'Bearer access-trial-secret');
  assert.equal(captured.request.headers['ChatGPT-Account-ID'], 'account-headers');
  assert.equal(captured.request.headers['OAI-Device-Id'], 'device-trial');
  assert.equal(captured.request.headers.Accept, 'application/json');
  assert.equal(JSON.stringify(captured.options.cookieJar).includes('must-not-be-sent'), false);
});

test('an asset without an access token is unknown rather than no-trial', async () => {
  const result = await checkSessionAssetTrial({ id: 'asset-no-at', email: 'person@example.test' }, { now: () => 2000 });
  assert.equal(result.status, 'unknown');
  assert.equal(result.code, 'TRIAL_AT_MISSING');
});

test('a transport failure keeps the previous trial timestamp and reports unknown', async () => {
  const result = await checkSessionAssetTrial({
    id: 'asset-network',
    email: 'person@example.test',
    accessToken: 'access-network',
    trial: { status: 'trial', lastTrialAt: '2026-08-01T00:00:00.000Z' },
  }, {
    now: () => 3000,
    executor: async () => { throw new Error('socket hang up'); },
  });

  assert.equal(result.status, 'unknown');
  assert.equal(result.code, 'TRIAL_NETWORK_ERROR');
  assert.equal(result.lastTrialAt, '2026-08-01T00:00:00.000Z');
});

test('batch promo check persists a sanitized tag on every asset', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-trial-'));
  const store = new SessionAssetStore({ cwd, stateDir: '.state', cpaDir: '.state/output' });
  t.after(() => { store.close(); fs.rmSync(cwd, { recursive: true, force: true }); });
  const first = store.upsert({ email: 'first@example.test', accountId: 'account-first', accessToken: 'token-first' });
  const second = store.upsert({ email: 'second@example.test', accountId: 'account-second', accessToken: 'token-second' });

  const batch = await checkSessionAssetTrials(store, [first.id, second.id], {
    concurrency: 2,
    now: () => 4000,
    executor: async (request) => (request.headers.Authorization.endsWith('token-first')
      ? response(200, accountPayload('account-first', { campaigns: PLUS_TRIAL_CAMPAIGN }))
      : response(401, { detail: 'sensitive response body must not persist' })),
  });

  assert.equal(batch.requested, 2);
  assert.equal(batch.checked, 2);
  assert.deepEqual(batch.results.map((item) => item.status), ['trial', 'unknown']);
  assert.equal(store.get(first.id).trial.status, 'trial');
  assert.equal(store.get(first.id).trial.campaigns[0].id, 'plus-1-month-free');
  assert.equal(store.get(first.id).trial.freeMonthOffer, true);
  assert.equal(store.get(first.id).trial.offerLabel, 'Plus 1个月免费');
  assert.equal(store.get(second.id).trial.code, 'TRIAL_UNAUTHORIZED');
  assert.equal(JSON.stringify(store.list()).includes('sensitive response body'), false);
  assert.equal(JSON.stringify(store.list()).includes('token-first'), false);
  assert.equal(store.list().every((asset) => asset.trial !== undefined), true);
});

test('a token replaced mid-check invalidates the measurement instead of mislabelling it', async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-trial-race-'));
  const store = new SessionAssetStore({ cwd, stateDir: '.state', cpaDir: '.state/output' });
  t.after(() => { store.close(); fs.rmSync(cwd, { recursive: true, force: true }); });
  const asset = store.upsert({ email: 'race@example.test', accountId: 'account-race', accessToken: 'token-old' });

  const batch = await checkSessionAssetTrials(store, [asset.id], {
    now: () => 5000,
    executor: async () => {
      store.update(asset.id, { accessToken: 'token-new' });
      return response(200, accountPayload('account-race', { campaigns: PLUS_TRIAL_CAMPAIGN }));
    },
  });

  assert.equal(batch.results[0].code, 'TRIAL_AT_CHANGED_DURING_CHECK');
  assert.equal(store.get(asset.id).trial.status, 'unknown');
  assert.deepEqual(store.get(asset.id).trial.campaigns, []);
  // The offer summary is derived from the campaigns, so it has to be cleared
  // with them — a stale `freeMonthOffer` would smuggle the asset into 提链.
  assert.equal(store.get(asset.id).trial.freeMonthOffer, false);
  assert.equal(store.get(asset.id).trial.offerKind, '');
});
