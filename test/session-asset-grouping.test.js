'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  NEXT_ACTIONS,
  NEXT_ACTION_RULES,
  assetFacets,
  assetLifecycle,
  assetNextAction,
  chainQueueEligible,
  needsSecurityRecovery,
  needsSessionRefresh,
} = require('../src/session-asset-grouping');
const { SessionAssetStore, assetSummary } = require('../src/session-asset-store');

const FREE_MONTH_PLUS = {
  status: 'trial',
  campaigns: [{
    key: 'plus',
    planName: 'chatgptplusplan',
    durationPeriods: 1,
    durationPeriod: 'month',
    discountPercentage: 100,
  }],
};

const FREE_MONTH_GO = {
  status: 'trial',
  campaigns: [{
    key: 'go',
    planName: 'chatgptgoplan',
    durationPeriods: 1,
    durationPeriod: 'month',
    discountPercentage: 100,
  }],
};

/** A record with nothing left to do: OAuth'd, secured, probed, no offer. */
function settled(overrides = {}) {
  return {
    id: 'asset-settled-0001',
    email: 'settled@example.test',
    status: 'valid',
    accessToken: 'access-token',
    password: 'password',
    totpSecret: 'totp',
    security: { passwordStatus: 'configured', totpStatus: 'configured' },
    health: { status: 'healthy' },
    trial: { status: 'none' },
    oauth: { successful: true },
    ...overrides,
  };
}

test('the next-action table partitions the active set and every action is reachable', () => {
  const cases = [
    ['refresh', settled({ health: { status: 'invalid' } })],
    ['security', settled({ password: '', security: {} })],
    ['chain', settled({ trial: FREE_MONTH_PLUS, oauth: null })],
    ['oauth', settled({ oauth: null })],
    ['trial_check', settled({ trial: null })],
    ['none', settled()],
  ];
  for (const [expected, asset] of cases) assert.equal(assetNextAction(asset), expected, expected);
  // Every declared action is covered above, and every rule produces one.
  assert.deepEqual([...new Set(cases.map(([action]) => action))].sort(), [...NEXT_ACTIONS].sort());
  assert.deepEqual(NEXT_ACTION_RULES.map((rule) => rule.action), NEXT_ACTIONS.slice(0, -1));
});

test('a redeemable free month outranks the OAuth queue that would otherwise swallow it', () => {
  // Both predicates match this account: it has never been OAuth'd *and* it has
  // a Plus free month waiting. If `oauth` won, the extractable accounts would
  // be indistinguishable from the bulk backlog — which is the bug this order
  // exists to prevent.
  const redeemable = settled({ trial: FREE_MONTH_PLUS, oauth: null, cpa: null });
  assert.equal(assetNextAction(redeemable), 'chain');
  assert.ok(NEXT_ACTION_RULES.findIndex((rule) => rule.action === 'chain')
    < NEXT_ACTION_RULES.findIndex((rule) => rule.action === 'oauth'));

  // A free month on Go is claimable but buys the wrong plan, so it stays in the
  // ordinary queue rather than being offered for extraction.
  assert.equal(assetNextAction(settled({ trial: FREE_MONTH_GO, oauth: null })), 'oauth');
});

test('an aged-out access token is a facet, not a refresh queue entry', () => {
  const expired = settled({ accessTokenExpiresAt: new Date(Date.now() - 3600_000).toISOString() });
  assert.equal(needsSessionRefresh(expired), false);
  assert.equal(assetNextAction(expired), 'none');
  assert.ok(assetFacets(expired).includes('atExpired'));

  // A probe that actually came back dead is a different claim and does queue.
  const probedDead = settled({ health: { status: 'mismatch' } });
  assert.equal(assetNextAction(probedDead), 'refresh');
  assert.equal(assetFacets(probedDead).includes('atExpired'), false);
});

test('a password already committed behind an MFA continuation is not re-queued', () => {
  const committed = settled({
    security: { passwordStatus: 'confirmation_mfa_required', totpStatus: 'configured' },
  });
  assert.equal(needsSecurityRecovery(committed), false);
  assert.equal(assetNextAction(committed), 'none');

  // A blocked re-auth does need operator attention, even with both secrets set.
  const blocked = settled({
    security: { passwordStatus: 'configured', totpStatus: 'configured', securityReauth: { status: 'required' } },
  });
  assert.equal(assetNextAction(blocked), 'security');
  // The flattened summary shape has to grade identically to the raw record.
  assert.equal(needsSecurityRecovery({
    hasPassword: true,
    hasTotp: true,
    security: { passwordStatus: 'configured', totpStatus: 'configured', securityReauthStatus: 'required' },
  }), true);
});

test('only a completed sale outranks a derived deactivation; planned does not', () => {
  const deactivated = { health: { status: 'banned' } };
  assert.equal(assetLifecycle(deactivated), 'banned');
  assert.equal(assetLifecycle({ ...deactivated, classification: 'sold' }), 'sold');
  // An intent to sell is not a sale, and a closed account can never be sold.
  // Leaving it in the planned pool only hid dead stock from the cleanup robot,
  // which matches on `banned`.
  assert.equal(assetLifecycle({ ...deactivated, classification: 'planned' }), 'banned');
  assert.equal(assetLifecycle({ ...deactivated, lifecycle: 'planned' }), 'banned');
  assert.equal(assetLifecycle({ lifecycle: 'planned', lastError: { code: 'ACCOUNT_DEACTIVATED' } }), 'banned');
  assert.equal(assetLifecycle({ lastError: { code: 'ACCOUNT_DEACTIVATED' } }), 'banned');
  // A stored lifecycle wins over the legacy field, but still promotes to banned.
  assert.equal(assetLifecycle({ lifecycle: 'sold', classification: 'planned' }), 'sold');
  assert.equal(assetLifecycle({ lifecycle: 'active', ...deactivated }), 'banned');
  // A planned account that is still alive stays planned.
  assert.equal(assetLifecycle({ lifecycle: 'planned' }), 'planned');
  // Sold is not work.
  assert.equal(assetNextAction(settled({ classification: 'sold', oauth: null })), 'none');
  const redeemable = settled({ trial: FREE_MONTH_PLUS, oauth: null });
  assert.equal(chainQueueEligible(redeemable), true);
  assert.equal(chainQueueEligible({ ...redeemable, classification: 'planned' }), false);
  assert.equal(chainQueueEligible({ ...redeemable, classification: 'sold' }), false);
  assert.equal(chainQueueEligible({ ...redeemable, health: { status: 'banned' } }), false);
});

test('a planned account keeps the refresh action and nothing else', () => {
  // Without this the planned pool is never graded: no probe means no health
  // verdict, so it can never be derived as banned and the cleanup robot never
  // sees it. Refresh is the only action it gets — the chain, OAuth, security
  // and trial queues stay behind the `active` gate.
  const dead = { lifecycle: 'planned', accessToken: '' };
  assert.equal(assetNextAction(dead), 'refresh');
  const redeemable = settled({ trial: FREE_MONTH_PLUS, oauth: null });
  assert.equal(assetNextAction(redeemable), 'chain');
  assert.equal(assetNextAction({ ...redeemable, lifecycle: 'planned' }), 'none');
  assert.equal(assetNextAction({ ...redeemable, lifecycle: 'sold' }), 'none');
  // The chain worker has its own gate, so this must not feed it.
  assert.equal(chainQueueEligible({ ...redeemable, lifecycle: 'planned' }), false);
});

test('a self-use account is graded exactly like an in-stock one', () => {
  // `self_use` says who an account is for, not that it stopped being worked
  // on. Grading it as anything less than `active` would quietly drop it out of
  // refresh — and an account we are running ourselves is the last one that can
  // afford a dead token.
  const redeemable = settled({ trial: FREE_MONTH_PLUS, oauth: null });
  assert.equal(assetNextAction(redeemable), 'chain');
  assert.equal(assetNextAction({ ...redeemable, lifecycle: 'self_use' }), 'chain');
  assert.equal(chainQueueEligible({ ...redeemable, lifecycle: 'self_use' }), true);
  assert.equal(assetNextAction({ lifecycle: 'self_use', accessToken: '' }), 'refresh');
  assert.equal(assetNextAction(settled({ lifecycle: 'self_use', hasPassword: false, password: '', totpSecret: '' })), 'security');
  assert.equal(assetNextAction(settled({ lifecycle: 'self_use', oauth: null })), 'oauth');
  // The pool postdates the legacy `classification` field on purpose: a build
  // rolled back past it reads the unknown value as `active`, which is the pool
  // a self-use account behaves like anyway.
  assert.equal(assetLifecycle({ classification: 'self_use' }), 'active');
});

test('a closed account cannot be self-use, so deactivation outranks the label', () => {
  // The same reasoning as `planned`: only a completed sale is a fact about the
  // past that survives the account closing. "Ours to use" is a claim about the
  // present, and a dead account hidden under it would be invisible to the
  // cleanup robot, which matches on `banned`.
  const deactivated = { health: { status: 'banned' } };
  assert.equal(assetLifecycle({ ...deactivated, lifecycle: 'self_use' }), 'banned');
  assert.equal(assetLifecycle({ lifecycle: 'self_use', lastError: { code: 'ACCOUNT_DEACTIVATED' } }), 'banned');
  assert.equal(assetLifecycle({ lifecycle: 'self_use' }), 'self_use');
  assert.equal(assetNextAction({ ...deactivated, lifecycle: 'self_use' }), 'none');
  assert.equal(chainQueueEligible({ ...settled({ trial: FREE_MONTH_PLUS, oauth: null }), ...deactivated, lifecycle: 'self_use' }), false);
});

test('a retired trial-pool exit stays a resource kind, never a country', () => {
  // The trial proxy pool is gone, but assets it stamped are not: they still
  // carry `countryCode: 'TRIAL'`, and reading that as a country puts a fake
  // entry in the console's country list. The guard outlives the feature.
  const facets = assetFacets(settled({
    sourceProxy: { countryCode: 'TRIAL', resourceKind: 'trialPool' },
  }));
  assert.ok(facets.includes('exitResource:trialPool'));
  assert.ok(!facets.some((facet) => facet.startsWith('exitCountry:')));
  assert.ok(assetFacets(settled({ sourceProxy: { countryCode: 'jp', resourceKind: 'countryPool' } }))
    .includes('exitCountry:JP'));
});

test('negative inventory facets are complementary to chain and OAuth state', () => {
  const ready = assetFacets(settled({
    trial: FREE_MONTH_PLUS,
    oauth: null,
    cpa: null,
  }));
  assert.ok(ready.includes('chainReady'));
  assert.ok(ready.includes('oauthPending'));
  assert.ok(!ready.includes('noChainValue'));
  assert.ok(!ready.includes('oauthDone'));

  const noValue = assetFacets(settled({
    trial: { status: 'none' },
    oauth: { successful: true },
  }));
  assert.ok(noValue.includes('noChainValue'));
  assert.ok(noValue.includes('oauthDone'));
  assert.ok(!noValue.includes('chainReady'));
  assert.ok(!noValue.includes('oauthPending'));

  // Unknown and non-Plus offers are not chain value. They remain independent
  // from the OAuth facet so either property can be filtered on its own.
  const unknown = assetFacets(settled({ trial: null, oauth: null, cpa: null }));
  assert.ok(unknown.includes('noChainValue'));
  assert.ok(unknown.includes('oauthPending'));
});

test('the list summary groups on the resolved mailbox channel, not the stored field', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-grouping-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const store = new SessionAssetStore({ cwd, stateDir: '.state', cpaDir: '.state/output' });
  t.after(() => store.close());

  // A legacy record, written straight to disk because `upsert` back-fills the
  // provider now and so cannot produce one. This is the shape 1275 of the 1330
  // live assets actually have: no `mailProvider`, but a namespaced mailbox id
  // the evidence resolver can still read.
  const legacy = store.save({
    schemaVersion: 1,
    id: 'asset-legacy-fastmail-01',
    email: 'legacy@example.test',
    accessToken: 'token',
    parentMailboxId: 'fastmail:1234',
  });
  assert.equal(legacy.mailProvider, undefined);
  const [row] = store.list();
  assert.equal(row.mailProvider, 'fastmail');
  assert.ok(row.facets.includes('mailProvider:fastmail'));
  assert.equal(row.lifecycle, 'active');
  assert.equal(row.nextAction, 'security');
  assert.equal(store.detail(legacy.id).nextAction, 'security');
});

test('grading a summary matches grading the record it came from', () => {
  for (const asset of [
    settled(),
    settled({ oauth: null }),
    settled({ trial: FREE_MONTH_PLUS, oauth: null }),
    settled({ password: '', security: {} }),
    settled({ health: { status: 'invalid' } }),
    settled({ trial: null }),
  ]) {
    const summary = assetSummary({ schemaVersion: 1, ...asset });
    assert.equal(summary.nextAction, assetNextAction(asset), summary.email);
    assert.equal(summary.lifecycle, assetLifecycle(asset));
  }
});

test('a query returns its counts and its rows from one pass, so they cannot disagree', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-query-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const store = new SessionAssetStore({ cwd, stateDir: '.state', cpaDir: '.state/output' });
  t.after(() => store.close());

  const rows = [
    ['chain-jp', { trial: FREE_MONTH_PLUS, oauth: null, sourceProxy: { countryCode: 'JP', resourceKind: 'countryPool' } }],
    ['chain-us', { trial: FREE_MONTH_PLUS, oauth: null, sourceProxy: { countryCode: 'US', resourceKind: 'countryPool' } }],
    ['oauth-jp', { oauth: null, sourceProxy: { countryCode: 'JP', resourceKind: 'countryPool' } }],
    ['done-jp', { sourceProxy: { countryCode: 'JP', resourceKind: 'countryPool' } }],
  ];
  for (const [name, overrides] of rows) {
    store.upsert({ ...settled({ ...overrides }), id: undefined, email: `${name}@example.test` });
  }
  const soldRow = store.upsert({ ...settled(), id: undefined, email: 'sold@example.test' });
  store.markLifecycle([soldRow.id], 'sold');

  const active = store.query({ lifecycle: 'active' });
  assert.equal(active.total, 4);
  assert.equal(active.assets.length, 4);
  assert.deepEqual(active.counts.queue, { chain: 2, oauth: 1, none: 1 });
  // The lifecycle axis is counted without applying itself, so the pool the
  // operator is not currently looking at still reports its size.
  assert.deepEqual(active.counts.lifecycle, { active: 4, sold: 1 });

  // Every axis composes, and the count a chip advertises is the number of rows
  // clicking it produces — the invariant the old console broke.
  for (const facet of Object.keys(active.counts.facets)) {
    const narrowed = store.query({ lifecycle: 'active', facets: [facet] });
    assert.equal(narrowed.total, active.counts.facets[facet], `facet ${facet}`);
    assert.equal(narrowed.assets.length, narrowed.total, `facet ${facet} rows`);
  }
  for (const queue of Object.keys(active.counts.queue)) {
    const narrowed = store.query({ lifecycle: 'active', queue });
    assert.equal(narrowed.total, active.counts.queue[queue], `queue ${queue}`);
  }

  const chainInJapan = store.query({ lifecycle: 'active', queue: 'chain', facets: ['exitCountry:JP'] });
  assert.equal(chainInJapan.total, 1);
  assert.equal(chainInJapan.assets[0].email, 'chain-jp@example.test');

  // A search scopes every axis, not just the rows.
  const searched = store.query({ q: 'chain-' });
  assert.equal(searched.total, 2);
  assert.deepEqual(searched.counts.queue, { chain: 2 });
});

test('paging walks the whole result set exactly once', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-paging-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const store = new SessionAssetStore({ cwd, stateDir: '.state', cpaDir: '.state/output' });
  t.after(() => store.close());
  for (let index = 0; index < 7; index += 1) {
    store.upsert({ ...settled(), id: undefined, email: `page-${index}@example.test` });
  }

  const seen = [];
  let cursor = '';
  do {
    const page = store.query({ limit: 3, cursor });
    assert.ok(page.assets.length <= 3);
    seen.push(...page.assets.map((asset) => asset.id));
    cursor = page.cursor;
  } while (cursor);
  assert.equal(seen.length, 7);
  assert.equal(new Set(seen).size, 7);
});

test('an access token that expires while the file sits untouched still filters as expired', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-expiry-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  let clock = Date.parse('2026-01-01T00:00:00.000Z');
  const store = new SessionAssetStore({ cwd, stateDir: '.state', cpaDir: '.state/output', now: () => clock });
  t.after(() => store.close());
  store.upsert({ ...settled(), id: undefined, accessTokenExpiresAt: '2026-01-01T01:00:00.000Z' });

  assert.equal(store.query({ facets: ['atExpired'] }).total, 0);
  // Nothing writes to the asset here. The cached index is keyed on the file's
  // mtime, so an expiry facet baked into it would stay stale forever.
  clock += 7200_000;
  assert.equal(store.query({ facets: ['atExpired'] }).total, 1);
});

test('first-storage ordering spans pages, survives refresh, and leaves unknown dates last', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-rebind-order-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  let now = Date.parse('2026-09-16T12:00:00Z');
  const store = new SessionAssetStore({ cwd, stateDir: '.state', now: () => now });
  t.after(() => store.close());
  const newest = store.upsert({ email: 'newest@icloud.com', createdAt: '2026-09-16T04:00:00Z' });
  const earliest = store.upsert({ email: 'earliest@icloud.com', createdAt: '2026-09-15T10:00:00+08:00' });
  const middle = store.upsert({ email: 'middle@icloud.com', createdAt: '2026-09-15T04:00:00Z' });
  const unknown = store.upsert({ email: 'unknown@icloud.com', createdAt: 'invalid' });
  now += 1000;
  store.update(newest.id, { accessToken: 'refreshed' });
  const first = store.query({ sort: 'createdAtAsc', limit: 2 });
  const second = store.query({ sort: 'createdAtAsc', limit: 2, cursor: first.cursor });
  assert.deepEqual(first.assets.map((asset) => asset.id), [earliest.id, middle.id]);
  assert.deepEqual(second.assets.map((asset) => asset.id), [newest.id, unknown.id]);
  assert.equal(store.query({ limit: 1 }).assets[0].id, newest.id, 'the regular asset list keeps its existing order');
});
