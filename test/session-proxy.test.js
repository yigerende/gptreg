"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const { Database } = require("../src/platform/db");
const { cipher } = require("../src/platform/security");
const { SessionProxyConfig } = require("../src/platform/session-proxy-config");
const { SessionProxyAllocator } = require("../src/platform/session-proxy-allocator");
const { parseGeneratedProxy } = require("../src/ui-server/session-proxy-generator");
const connection = process.env.GPTREG_TEST_DATABASE_URL;
async function until(predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (!await predicate()) { assert.ok(Date.now() < deadline, 'Timed out waiting for simulated execution'); await new Promise(resolve => setTimeout(resolve, 10)); }
}

async function fixture(t, options = {}) {
  const setup = new Database(connection), schema = `sp_${randomBytes(8).toString('hex')}`;
  await setup.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(connection); url.searchParams.set('options', `-c search_path=${schema}`);
  const db = new Database(url.href), crypt = cipher(randomBytes(32).toString('base64'));
  t.after(async () => { await db.close(); await setup.query(`DROP SCHEMA ${schema} CASCADE`); await setup.close(); });
  await db.initialize();
  const config = new SessionProxyConfig(db, crypt);
  await config.save({ expected_revision: 1, apiToken: 'synthetic-api-token', username: 'test-user', password: 'test-password', enabled: true, maxParallel: 2 });
  await config.syncRows([{ code: 'JP', name: '日本' }, { code: 'US', name: '美国' }]);
  await config.editRegion('JP', { enabled: true });
  await config.editRegion('US', { enabled: true });
  const allocator = new SessionProxyAllocator(config, { processId: 'test-instance', generate: async (snapshot, country) => {
    const sessionId = randomBytes(4).toString('hex');
    return { sessionId, endpoint: `http://test-user:test-password_country-${country.toLowerCase()}_session-${sessionId}_lifetime-2h@geo.iproyal.com:12321` };
  }, ...options });
  const policy = await config.policy('random');
  const request = (item = randomUUID()) => ({ source: 'engine', taskItemId: item, taskKind: 'register', attemptSeq: 1, executionId: randomUUID(), policy });
  return { db, crypt, config, allocator, policy, request };
}

test('IPRoyal response validates protocol, country and normalized lifetime', () => {
  const c = { protocol: 'socks5', lifetimeMinutes: 10 };
  const value = 'geo.iproyal.com:32325:user:pass_country-jp_session-a1b2c3d4_lifetime-10m';
  assert.equal(parseGeneratedProxy(value, c, 'JP').sessionId, 'a1b2c3d4');
  assert.throws(() => parseGeneratedProxy(value.replace('32325', '12321'), c, 'JP'));
  assert.throws(() => parseGeneratedProxy(value, c, 'US'));
});

test('shared capacity, exact release and immutable configuration', { skip: !connection }, async t => {
  const f = await fixture(t);
  const results = await Promise.allSettled([f.request(), f.request(), f.request()].map(r => f.allocator.acquire(r)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'SESSION_PROXY_CAPACITY');
  const held = results.find(r => r.status === 'fulfilled').value;
  await f.allocator.release({ ...held, executionId: randomUUID() });
  assert.equal((await f.config.public()).occupied, 2);
  await f.allocator.release(held); await f.allocator.release(held);
  assert.equal((await f.config.public()).occupied, 1);
  const old = await f.config.version(f.policy.configVersion);
  await f.config.save({ expected_revision: (await f.config.public()).revision, password: 'new-password', maxParallel: 1 });
  assert.equal((await f.config.version(f.policy.configVersion)).password, old.password);
  await assert.rejects(f.allocator.acquire(f.request()), { code: 'SESSION_PROXY_CAPACITY' });
  const exposed = JSON.stringify(await f.config.public());
  assert.ok(!exposed.includes('test-password') && !exposed.includes('new-password'));
});

test('supplier adapter sends official HTTP/SOCKS5 and auth fields and never echoes supplier secrets', async () => {
  const { SessionProxyGenerator } = require('../src/ui-server/session-proxy-generator');
  for (const protocol of ['http', 'socks5']) for (const authType of ['credentials', 'subuser']) {
    const cfg = { protocol, authType, apiToken: 'SYNTHETIC_TOKEN', username: 'user@name', password: 'p:a/ss?#', subuserHash: 'SYNTHETIC_HASH', lifetimeMinutes: 1440 };
    const generator = new SessionProxyGenerator({ fetch: async (url, options) => {
      assert.equal(url, 'https://resi-api.iproyal.com/v1/access/generate-proxy-list');
      const body = JSON.parse(options.body); assert.equal(body.port, protocol === 'http' ? 'http|https' : 'socks5');
      assert.equal(body.proxy_count, 1); assert.equal(body.location, '_country-jp');
      assert.equal(body.username, authType === 'credentials' ? cfg.username : undefined); assert.equal(body.subuser_hash, authType === 'subuser' ? cfg.subuserHash : undefined);
      return { ok: true, text: async () => JSON.stringify([`geo.iproyal.com:${protocol === 'http' ? 12321 : 32325}:user@name:p:a/ss?#_country-jp_session-abcd1234_lifetime-1d`]) };
    } });
    const generated = await generator.generate(cfg, 'JP'); const endpoint = new URL(generated.endpoint);
    assert.equal(decodeURIComponent(endpoint.username), cfg.username); assert.ok(decodeURIComponent(endpoint.password).startsWith(cfg.password));
  }
  const failed = new SessionProxyGenerator({ fetch: async () => ({ ok: false, status: 422, text: async () => 'PASSWORD_SHOULD_NOT_APPEAR' }) });
  await assert.rejects(failed.generate({ protocol: 'http', lifetimeMinutes: 120 }, 'JP'), e => e.statusCode === 502 && !e.message.includes('PASSWORD_SHOULD'));
});

test('optional live-IP dedup retries at most three times and releases every failed occupancy', { skip: !connection }, async t => {
  const f = await fixture(t), { SessionProxyRuntime } = require('../src/platform/session-proxy-runtime');
  await f.config.save({ expected_revision: (await f.config.public()).revision, ipDedup: true });
  f.allocator.generator.probe = async () => ({ exitIp: '192.0.2.1', latencyMs: 1, status: 'healthy' });
  const a = { id: 'one', email: 'one@example.test' }, b = { id: 'two', email: 'two@example.test' };
  const state = { runPlan: { proxyPolicy: f.policy }, jobs: [a, b] }, runtime = new SessionProxyRuntime(f.allocator, state);
  const ctx = job => runtime.context(job, { signal: () => new AbortController().signal, checkpoint: async () => {} });
  try {
    await runtime.bind({}, a, ctx(a));
    await assert.rejects(runtime.bind({}, b, ctx(b)), { code: 'SESSION_PROXY_GENERATION_FAILED' });
    assert.equal((await f.config.public()).occupied, 1);
    assert.equal((await f.db.one('SELECT count(*)::int n FROM session_proxy_sessions')).n, 4);
    assert.equal((await f.db.one('SELECT count(*)::int n FROM session_proxy_sessions WHERE retired_at IS NOT NULL')).n, 3);
  } finally { await runtime.close(); }
  assert.equal((await f.config.public()).occupied, 0);
  assert.equal((await f.db.one('SELECT count(*)::int n FROM session_proxy_exit_claims')).n, 0);
});

test('late generator cannot activate an expired reservation', { skip: !connection }, async t => {
  let respond;
  const f = await fixture(t, { generate: () => new Promise(resolve => { respond = resolve; }) });
  const pending = f.allocator.acquire(f.request());
  while (!respond) await new Promise(resolve => setTimeout(resolve, 5));
  await f.db.query("UPDATE session_proxy_bindings SET created_at=now()-interval '2 minutes',reserved_until=now()-interval '1 second' WHERE status='reserved'");
  respond({ sessionId: 'a1b2c3d4', endpoint: 'http://synthetic@geo.iproyal.com:12321' });
  await assert.rejects(pending, { code: 'SESSION_PROXY_EXPIRED' });
  assert.equal((await f.config.public()).occupied, 0);
});

test('revocation overrides frozen credentials; random region remains frozen', { skip: !connection }, async t => {
  const f = await fixture(t), req = f.request(), held = await f.allocator.acquire(req);
  await f.allocator.release(held);
  await f.config.editRegion(held.country, { suppressed: true });
  const resumed = await f.allocator.acquire({ ...req, executionId: randomUUID() });
  assert.equal(resumed.country, held.country);
  assert.equal(resumed.sessionId, held.sessionId);
  assert.equal(String(resumed.expiresAt), String(held.expiresAt));
  await f.config.save({ expected_revision: (await f.config.public()).revision, revoked: true });
  await assert.rejects(f.allocator.assert(resumed), { code: 'SESSION_PROXY_REVOKED' });
});

async function engineBatch(t, f, { count = 2, workers = 2, oauth = false, input = {}, onRegister = async () => {}, onOAuth = async () => {} } = {}) {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const { SessionAssetStore } = require('../src/session-asset-store');
  const { normalizeRunPlan } = require('../src/run-plan');
  const { makeInitialBranchState, runBranchOrchestrator } = require('../src/branch-orchestrator');
  const { SessionProxyRuntime } = require('../src/platform/session-proxy-runtime');
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gptreg-session-proxy-test-'));
  const assetStore = new SessionAssetStore({ cwd, stateDir: '.state', cpaDir: '.state/output' });
  t.after(() => { assetStore.close(); if (cwd.startsWith(path.join(os.tmpdir(), 'gptreg-session-proxy-test-'))) fs.rmSync(cwd, { recursive: true, force: true }); });
  const config = { schemaVersion: 2,
    mail: { provider: 'xiaopingguo', baseUrl: 'http://127.0.0.1:1', password: 'synthetic', count, folders: ['INBOX'], maxResults: 100, timeoutMs: 200, pollIntervalMs: 5, keyword: 'OpenAI' },
    aliases: { strategy: 'root', count: 1, maxAttempts: 1, runTag: 'session', plusAddressingEnabled: false },
    sms: { provider: 'mock', apiKey: 'synthetic', maxPrice: .03, service: { code: 'mock' }, country: { id: 151 }, replacementBudget: 2, codeTimeoutMs: 100 },
    workers: { maxConcurrency: workers }, registration: { exchangeToken: true, dynamicSentinel: false, name: 'Fixture', birthdate: '2000-01-01' },
    proxyPool: { required: true, defaultProtocol: 'http', healthCheck: { enabled: !!f.legacy, probeUrl: 'https://example.test', timeoutMs: 1000 } }, output: { stateDir: '.state', cpaDir: '.state/output' } };
  const plan = normalizeRunPlan({ schemaVersion: 3, taskKind: 'register_session', mailCount: count, workerConcurrency: workers, aliasStrategy: 'root', proxyPolicy: f.legacy ? undefined : f.policy, proxyMode: f.legacy ? 'countryPool' : 'sessionProxy', postRegistrationOAuth: oauth,
    proxyAssignments: Array.from({ length: workers }, (_, i) => ({ workerSlot: i + 1, kind: f.legacy ? 'countryPool' : 'sessionProxy', ...(f.legacy ? { countryCode: 'JP' } : {}) })), ...input }, config);
  const state = makeInitialBranchState(config, plan);
  const runtime = f.legacy ? undefined : new SessionProxyRuntime(f.allocator, state), seen = [], oauthSeen = [], checkpoints = [];
  const claims = f.legacy ? new (require('../src/oauth-proxies').ProxyClaims)(f.legacy.registry, state.runId, f.legacy.usage) : undefined;
  const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 90000); t.after(() => clearTimeout(timer));
  const done = runBranchOrchestrator({ log: { entries: [] } }, state, config, { assetStore, sessionProxyRuntime: runtime,
    ...(f.legacy ? { proxyEntries: f.legacy.entries, proxyUsage: f.legacy.usage, usedProxyIds: claims, proxyProbeExecutor: async () => ({ response: { status: 200 } }) } : {}),
    control: { signal: abort.signal, requestedAction: () => abort.signal.aborted ? 'cancel' : '' },
    saveState: s => checkpoints.push(JSON.stringify(s)),
    trialChecker: async () => ({ status: 'unknown' }),
    mailClient: { listAccounts: async () => ({ accounts: Array.from({ length: count }, (_, i) => ({ id: `mail-${state.runId}-${i}`, email: `${state.runId}-${i}@example.test`, tokenValid: true })) }), reserveMailbox: async () => {}, releaseMailbox: async () => {} },
    sessionRunnerFactory: ({ job, worker }) => ({ async run(session) {
      seen.push(worker.proxy.url); await onRegister({ job, worker, state }); session.accountCreated = true; session.step = 'verified'; session.status = 'valid'; session.accountId = `account-${job.id}`;
      session.accessToken = `at-${job.id}`; session.sessionToken = `st-${job.id}`; session.planType = 'free';
      session.password = 'SYNTHETIC_PASSWORD'; session.totpSecret = 'JBSWY3DPEHPK3PXP';
      session.security = { passwordStatus: 'configured', totpStatus: 'configured' }; session.session = { user: { email: session.email } }; session.me = { email: session.email }; session.lastValidatedAt = new Date().toISOString();
    } }),
    oauthRunnerFactory: ({ job, worker }) => ({ async run(s) { oauthSeen.push(worker.proxy.url); await onOAuth({ job, worker, state }); s.step = 'complete'; s.status = 'complete'; s.account = { email: s.email, access_token: `oauth-${job.id}`, refresh_token: `refresh-${job.id}` }; } }),
  }).finally(async () => { clearTimeout(timer); await runtime?.close(); claims?.clear(); });
  return { done, state, seen, oauthSeen, checkpoints, assetStore, runtime, abort };
}

test('engine batch binds a different session per account and releases all capacity', { skip: !connection, timeout: 15000 }, async t => {
  const f = await fixture(t), batch = await engineBatch(t, f);
  const { state, seen, checkpoints } = batch;
  await batch.done;
  assert.equal(state.status, 'complete', JSON.stringify(state.jobs.map(j => ({ status: j.status, error: j.error }))));
  assert.equal(new Set(seen).size, 2); assert.ok(seen.every(s => s.includes('geo.iproyal.com')));
  assert.ok(checkpoints.every(s => !s.includes('test-password')));
  assert.equal((await f.config.public()).occupied, 0);
  assert.equal((await f.db.one('SELECT count(*)::int AS n FROM session_proxy_bindings WHERE final_account_id IS NOT NULL')).n, 2);
});

test('cancellation and revocation fence slow generation; retries cannot steal an asset', { skip: !connection }, async t => {
  let respond;
  const f = await fixture(t, { generate: () => new Promise(resolve => { respond = resolve; }) });
  const abort = new AbortController(), req = { ...f.request(), signal: abort.signal, assetId: 'original-asset', taskKind: 'oauth' };
  const pending = f.allocator.acquire(req);
  await until(() => respond);
  await assert.rejects(f.allocator.acquire({ ...f.request(), assetId: req.assetId }), { code: 'SESSION_PROXY_BUSY' });
  abort.abort(); respond({ sessionId: 'abcdefgh', endpoint: 'unused' });
  await assert.rejects(pending);
  assert.equal((await f.config.public()).occupied, 0);
  assert.equal((await f.db.one('SELECT count(*)::int n FROM platform_account_execution_claims')).n, 0);
  respond = null;
  const revoked = f.allocator.acquire(f.request()); await until(() => respond);
  await f.config.save({ expected_revision: (await f.config.public()).revision, revoked: true });
  respond({ sessionId: 'ijklmnop', endpoint: 'unused' });
  await assert.rejects(revoked, { code: 'SESSION_PROXY_REVOKED' });
  assert.equal((await f.config.public()).occupied, 0);
});

test('expired active requests keep capacity until drained; old ownership cannot release a resumed interval', { skip: !connection }, async t => {
  const f = await fixture(t), req = { ...f.request(), assetId: 'original-asset', taskKind: 'oauth' };
  const old = await f.allocator.acquire(req), other = await f.allocator.acquire(f.request());
  await f.db.query("UPDATE session_proxy_sessions SET generated_at=now()-interval '3 hours',expires_at=now()-interval '1 second' WHERE session_id=$1", [old.sessionId]);
  await assert.rejects(f.allocator.assert(old), { code: 'SESSION_PROXY_EXPIRED' });
  await f.allocator.stopping(old);
  assert.equal((await f.config.public()).occupied, 2);
  await assert.rejects(f.allocator.acquire(f.request()), { code: 'SESSION_PROXY_CAPACITY' });
  await f.allocator.release(old, 'expired');
  const fresh = await f.allocator.acquire({ ...req, executionId: randomUUID() });
  assert.notEqual(fresh.sessionId, old.sessionId); assert.equal(fresh.country, old.country);
  assert.ok(fresh.ownerEpoch > old.ownerEpoch);
  assert.equal(await f.allocator.release(old), false);
  await f.allocator.assert(fresh); await f.allocator.release(fresh); await f.allocator.release(other);
});

test('changed mailbox creates a new attempt; new config cannot alter old frozen tasks or OAuth sessions', { skip: !connection }, async t => {
  const f = await fixture(t), req = { ...f.request(), identityKey: 'mail-a' };
  const a = await f.allocator.acquire(req); await f.allocator.release(a);
  const b = await f.allocator.acquire({ ...req, identityKey: 'mail-b', executionId: randomUUID() });
  assert.equal(b.attemptSeq, 2); assert.notEqual(b.sessionId, a.sessionId);
  await f.allocator.assert(b, { assetId: 'asset-b' }); await f.allocator.release(b);
  await f.config.save({ expected_revision: (await f.config.public()).revision, password: 'changed', enabled: false });
  const { SessionProxyRuntime } = require('../src/platform/session-proxy-runtime');
  const runtime = new SessionProxyRuntime(f.allocator, { runPlan: { proxyPolicy: f.policy }, jobs: [] });
  const identity = await runtime.identity({ id: 'oauth', assetId: 'asset-b', email: 'same@example.test' });
  assert.equal(identity.policy.configVersion, f.policy.configVersion);
  const oauth = await f.allocator.acquire({ ...identity, executionId: randomUUID() });
  assert.equal(oauth.sessionId, b.sessionId); assert.equal(+oauth.expiresAt, +b.expiresAt);
  await f.allocator.release(oauth);
  const differentCountry = b.country === 'JP' ? 'US' : 'JP';
  const different = new SessionProxyRuntime(f.allocator, { runPlan: { proxyPolicy: { ...f.policy, countries: [{ code: differentCountry, name: differentCountry }] } }, jobs: [] });
  const other = await different.identity({ id: 'oauth-other', assetId: 'asset-b', email: 'same@example.test' });
  assert.notEqual(other.taskItemId, identity.taskItemId);
  const otherHeld = await f.allocator.acquire({ ...other, executionId: randomUUID() });
  assert.equal(otherHeld.country, differentCountry); assert.notEqual(otherHeld.sessionId, b.sessionId);
  await f.allocator.release(otherHeld);
});

test('checkpoint references cannot cross task ownership and request-specific cancellation is preserved', { skip: !connection }, async t => {
  const f = await fixture(t), req = f.request();
  const held = await f.allocator.acquire(req); await f.allocator.release(held);
  const previousRef = { bindingId: held.bindingId, executionId: held.executionId, ownerEpoch: held.ownerEpoch };
  await assert.rejects(f.allocator.acquire({ ...f.request(), previousRef }), { code: 'SESSION_PROXY_CONFIG_INVALID' });
  await assert.rejects(f.allocator.acquire({ ...req, executionId: randomUUID(), previousRef: { ...previousRef, ownerEpoch: held.ownerEpoch + 1 } }), { code: 'SESSION_PROXY_CONFIG_INVALID' });
  const resumed = await f.allocator.acquire({ ...req, executionId: randomUUID(), previousRef });
  assert.equal(resumed.sessionId, held.sessionId); await f.allocator.release(resumed);
  const { SessionProxyRuntime } = require('../src/platform/session-proxy-runtime');
  const job = { id: 'request-abort', email: 'cancel@example.test' };
  const runtime = new SessionProxyRuntime(f.allocator, { runPlan: { proxyPolicy: f.policy }, jobs: [job] });
  try {
    const context = runtime.context(job, { checkpoint: async () => {} });
    await runtime.bind({}, job, context);
    const abort = new AbortController(), reason = new Error('request-specific-abort'); abort.abort(reason);
    await assert.rejects(context.sessionProxyExecutor('https://example.test', { signal: abort.signal }), reason);
  } finally { await runtime.close(); }
  assert.equal((await f.config.public()).occupied, 0);
});

test('configuration conflicts and stale sync are rejected; batch region changes are atomic', { skip: !connection }, async t => {
  const f = await fixture(t), revision = (await f.config.public()).revision;
  const both = await Promise.allSettled([1, 2].map(maxParallel => f.config.save({ expected_revision: revision, maxParallel, password: 'new-synthetic-password' })));
  assert.equal(both.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(both.find(r => r.status === 'rejected').reason.statusCode, 409);
  await assert.rejects(f.config.syncRows([{ code: 'GB', name: '英国' }], f.policy.configVersion), { statusCode: 409 });
  await assert.rejects(f.config.batchRegions(['JP', 'ZZ'], false));
  assert.equal((await f.db.one("SELECT enabled FROM session_proxy_regions WHERE code='JP'")).enabled, true);
  await f.config.editRegion('JP', { suppressed: true }); await f.config.syncRows([{ code: 'JP', name: 'Japan' }]);
  assert.equal((await f.db.one("SELECT suppressed FROM session_proxy_regions WHERE code='JP'")).suppressed, true);
});

test('admin routes enforce auth and pagination; concurrent order replay survives switching defaults', { skip: !connection }, async t => {
  const f = await fixture(t), { Orders } = require('../src/platform/orders'), { buildPlatform } = require('../src/platform/app'), { digest } = require('../src/platform/security');
  const orders = new Orders(f.db, f.crypt, { sessionProxy: f.config });
  const app = buildPlatform({ db: f.db, crypt: f.crypt, orders, sessionProxy: { config: f.config, allocator: f.allocator }, secrets: { internal: 'test' }, proxy: false });
  const user = await f.db.one("INSERT INTO platform_users(id,email,name,password_hash,points) VALUES($1,'member@example.test','member','unused',100000) RETURNING *", [randomUUID()]);
  const admin = await f.db.one("INSERT INTO platform_users(id,email,name,password_hash,role) VALUES($1,'admin@example.test','admin','unused','admin') RETURNING *", [randomUUID()]);
  for (const u of [user, admin]) await f.db.query("INSERT INTO platform_sessions(hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')", [digest(u.id), u.id]);
  const req = (url, u, method = 'GET', payload) => app.inject({ method, url, payload, headers: { 'x-requested-with': 'gptreg', ...(u ? { cookie: `gptreg_session=${u.id}` } : {}) } });
  try {
    const base = '/api/admin/v1/session-proxy';
    for (const suffix of ['', '/regions', '/sessions']) { assert.equal((await req(base + suffix)).statusCode, 401); assert.equal((await req(base + suffix, user)).statusCode, 403); }
    const r = await req(base + '/regions?limit=1&offset=1', admin); assert.equal(r.statusCode, 200); assert.equal(r.json().items.length, 1); assert.equal(r.json().total, 2);
    for (const path of ['/regions', '/sessions']) for (const query of ['limit=1.5', 'offset=Infinity', 'offset=-1']) {
      assert.equal((await req(base + path + '?' + query, admin)).statusCode, 400);
    }
    assert.equal((await req(base + '/regions/JP', admin, 'PATCH', { name: '日本测试' })).statusCode, 200);
    assert.equal((await f.db.one("SELECT count(*)::int n FROM platform_audit WHERE action='session-proxy.region.edit'")).n, 1);
    await f.config.save({ expected_revision: (await f.config.public()).revision, defaultMode: 'sessionProxy' });
    await f.db.query("UPDATE platform_settings SET value=value||'{\"orders_open\":true}' WHERE id=1");
    const requests = await Promise.all(Array.from({ length: 20 }, () => orders.create(user, { quantity: 2, registration_region: 'GLOBAL' }, 'same-order-key', 'web')));
    assert.equal(new Set(requests.map(r => r.order.id)).size, 1);
    assert.equal((await f.db.one("SELECT count(*)::int n FROM platform_ledger WHERE kind='reserve'")).n, 1);
    const saved = await f.db.one('SELECT template FROM platform_orders WHERE id=$1', [requests[0].order.id]);
    assert.equal(saved.template.proxyPolicy.mode, 'sessionProxy'); assert.equal(saved.template.proxyPolicy.countries.length, 2);
    await f.config.save({ expected_revision: (await f.config.public()).revision, defaultMode: 'countryPool', enabled: false });
    assert.equal((await orders.create(user, { quantity: 2, registration_region: 'GLOBAL' }, 'same-order-key', 'web')).replayed, true);
    assert.equal(JSON.stringify((await req(base, admin)).json()).includes('test-password'), false);
  } finally { await app.close(); }
});

test('service restart waits for old process lock; legacy orders and explicit local mode remain unchanged', { skip: !connection }, async t => {
  const f = await fixture(t), { createSessionProxy } = require('../src/platform/session-proxy-service');
  const first = await createSessionProxy(f.db, f.crypt, 'test', { generate: f.allocator.generate });
  const second = await createSessionProxy(f.db, f.crypt, 'test', { generate: f.allocator.generate });
  try {
    await f.config.save({ expected_revision: (await f.config.public()).revision, defaultMode: 'sessionProxy' });
    const old = { taskKind: 'register_session', proxyAssignments: [] };
    assert.deepEqual(await second.preparePlan(old, {}, { frozen: true }), old);
    const country = { ...old, proxyMode: 'countryPool', proxyAssignments: [{ kind: 'countryPool', workerSlot: 1, countryCode: 'JP' }] };
    const readSettings = f.db.settings;
    f.db.settings = () => { throw new Error('Old mode must not read session settings'); };
    try {
      assert.equal(await second.preparePlan(country, {}), country);
      assert.equal(second.runtime({ runPlan: country }), undefined);
      assert.equal(second.runtime({ runPlan: old }), undefined);
    } finally { f.db.settings = readSettings; }
    const local = await second.preparePlan({ ...old, proxyMode: 'local' }, { local: { proxies: [{ id: 'fixed' }] } }, { frozen: true });
    assert.equal(local.proxyAssignments[0].kind, 'local');
    const req = f.request(), held = await first.allocator.acquire(req);
    await f.db.query("UPDATE session_proxy_bindings SET heartbeat_at=now()-interval '1 day',lease_until=now()-interval '1 day' WHERE id=$1", [held.bindingId]);
    await second.recover(); assert.equal((await f.db.one('SELECT status FROM session_proxy_bindings WHERE id=$1', [held.bindingId])).status, 'active');
    await first.close(); await second.recover();
    assert.equal((await f.db.one('SELECT status FROM session_proxy_bindings WHERE id=$1', [held.bindingId])).status, 'stopping');
    await f.db.query("UPDATE session_proxy_bindings SET lease_until=now()-interval '1 second' WHERE id=$1", [held.bindingId]);
    await second.recover();
    const resumed = await second.allocator.acquire({ ...req, executionId: randomUUID() });
    assert.equal(resumed.sessionId, held.sessionId); assert.ok(resumed.ownerEpoch > held.ownerEpoch);
    await second.allocator.release(resumed);
  } finally { await second.close(); }
});

test('workbench 20 workers and 100 accounts obey 15 shared sessions and preserve registration-to-OAuth affinity', { skip: !connection, timeout: 120000 }, async t => {
  const f = await fixture(t); await f.config.save({ expected_revision: (await f.config.public()).revision, maxParallel: 15 });
  let peak = 0; const reserve = f.allocator.reserve.bind(f.allocator);
  f.allocator.reserve = async req => { const row = await reserve(req); peak = Math.max(peak, (await f.config.public()).occupied); return row; };
  const batch = await engineBatch(t, f, { count: 100, workers: 20, oauth: true });
  await batch.done;
  assert.equal(batch.state.status, 'complete', JSON.stringify(batch.state.jobs.filter(j => j.status !== 'complete').map(j => j.error)));
  assert.equal(batch.seen.length, 100); assert.equal(new Set(batch.seen).size, 100);
  assert.deepEqual(batch.oauthSeen.sort(), batch.seen.sort()); assert.equal(peak, 15);
  assert.equal((await f.config.public()).occupied, 0);
  assert.equal((await f.db.one('SELECT count(*)::int n FROM platform_account_execution_claims')).n, 0);
  assert.ok(batch.checkpoints.every(s => !s.includes('test-password')));
  t.diagnostic('Workbench: 100 accounts / 20 workers (current workbench limit), peak active+reserved+stopping 15, 100 distinct sessions, OAuth stays on same session.');
});

for (const load of [
  { users: 5, userCap: 5, globalCap: 15, proxyCap: 20, manual: 50, workers: 10 },
  { users: 10, userCap: 15, globalCap: 100, proxyCap: 100, manual: 100, workers: 20 },
  { users: 10, userCap: 15, globalCap: 100, proxyCap: 120, manual: 100, workers: 20, legacy: true },
]) test(`${load.legacy ? 'legacy country pool: ' : ''}multiple users submit ${load.users * 20} accounts while workbench runs; global ${load.globalCap}, shared proxy ${load.proxyCap}, exact settlement`, { skip: !connection, timeout: 180000 }, async t => {
  const f = await fixture(t), { Orders } = require('../src/platform/orders'), { OrderWorker } = require('../src/platform/worker');
  await f.config.save({ expected_revision: (await f.config.public()).revision, maxParallel: load.legacy ? 1 : load.proxyCap, defaultMode: load.legacy ? 'countryPool' : 'sessionProxy', ...(load.legacy ? { revoked: true, enabled: false } : {}) });
  if (load.legacy) {
    const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gptreg-legacy-load-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    f.legacy = { registry: new Map(), usage: new (require('../src/proxy-usage').ProxyUsage)(path.join(root, 'usage.json')),
      entries: Array.from({ length: 400 }, (_, i) => ({ id: `legacy-${i}`, url: `http://legacy-${i}.example.test:9000`, resourceKind: 'countryPool', countryCode: 'JP', workerSlots: Array.from({ length: 20 }, (_, n) => n + 1), sessionMinutes: 120 })) };
    await f.db.query("UPDATE platform_settings SET value=value||$1::jsonb", [{ template: { proxyAssignments: [{ workerSlot: 1, kind: 'countryPool', countryCode: 'JP' }] } }]);
  }
  await f.db.query("UPDATE platform_settings SET value=value||$1::jsonb", [{ orders_open: true, worker_enabled: true, registration_concurrency: load.globalCap, user_registration_concurrency: load.userCap }]);
  const orders = new Orders(f.db, f.crypt, { sessionProxy: f.config }), users = [];
  for (let i = 0; i < load.users; i++) users.push(await f.db.one('INSERT INTO platform_users(id,email,name,password_hash,points) VALUES($1,$2,$3,$4,100000) RETURNING *', [randomUUID(), `load-${i}@example.test`, `user-${i}`, 'unused']));
  const submitted = await Promise.all(users.map((u, i) => orders.create(u, { quantity: 20, need_oauth: i % 2 === 0 }, randomUUID(), i % 2 ? 'api' : 'web')));
  let unlock = false, peak = 0, overlap = false; const gates = [], batches = new Map(), live = new Map();
  const reserve = f.allocator.reserve.bind(f.allocator);
  f.allocator.reserve = async req => {
    const row = await reserve(req), counts = (await f.db.query("SELECT source,count(*)::int n FROM session_proxy_bindings WHERE status IN ('reserved','active','stopping') GROUP BY source")).rows;
    peak = Math.max(peak, counts.reduce((s, r) => s + r.n, 0));
    if (counts.some(r => r.source === 'order') && counts.some(r => r.source === 'engine')) overlap = true;
    return row;
  };
  const onRegister = async () => { if (f.legacy) peak = Math.max(peak, f.legacy.registry.size); if (!unlock) await new Promise(resolve => gates.push(resolve)); };
  const manual = await engineBatch(t, f, { count: load.manual, workers: load.workers, oauth: true, onRegister });
  await until(() => gates.length === load.workers);
  const manager = {
    setCustomerConcurrency() {}, setCustomerPendingRuns() {}, isTaskSlotBusy: () => false,
    activeRun: id => live.get(id), activeRuns: () => [...live.values()], load: id => batches.get(id)?.state,
    sessionAssets: () => ({ get: id => { for (const b of batches.values()) { try { const a = b.assetStore.get(id); if (a) return a; } catch (e) { if (e.code !== 'ENOENT') throw e; } } }, markLifecycle: () => ({ missing: [] }) }),
    cpaFile: v => { const fs = require('node:fs'), path = require('node:path'); for (const b of batches.values()) { const file = path.resolve(b.assetStore.cpaRoot, v.cpaPath); if (fs.existsSync(file)) return file; } throw new Error('Mock CPA file missing'); },
    async start(input, { runId, customerUserId }) {
      const batch = await engineBatch(t, f, { count: 1, workers: 1, input, onRegister });
      batches.set(runId, batch); live.set(runId, { state: batch.state, owner: customerUserId });
      batch.done.then(() => live.delete(runId));
    },
  };
  const worker = new OrderWorker(f.db, orders, manager);
  await worker.cycle();
  assert.equal(live.size, load.globalCap); assert.equal((await f.db.one("SELECT count(*)::int n FROM platform_items WHERE status='queued'")).n, load.users * 20 - load.globalCap);
  for (const u of users) assert.ok([...live.values()].filter(b => b.owner === u.id).length <= load.userCap);
  await until(() => gates.length === load.proxyCap);
  assert.equal(f.legacy ? f.legacy.registry.size : (await f.config.public()).occupied, load.proxyCap);
  if (f.legacy) overlap = manual.seen.length > 0 && [...batches.values()].some(b => b.seen.length > 0);
  unlock = true; gates.forEach(resolve => resolve());
  const deadline = Date.now() + 150000;
  for (;;) {
    assert.ok(Date.now() < deadline, 'Concurrent customer load timed out');
    await worker.cycle();
    assert.ok(live.size <= load.globalCap);
    for (const u of users) assert.ok([...live.values()].filter(b => b.owner === u.id).length <= load.userCap);
    const remaining = await f.db.one("SELECT count(*)::int n FROM platform_items WHERE status IN ('queued','running','review','oauth_pending')");
    if (!remaining.n) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  await manual.done;
  assert.equal(manual.state.status, 'complete'); assert.equal(manual.seen.length, load.manual);
  const totals = await f.db.one('SELECT sum(delivered)::int delivered,sum(charged)::int charged,sum(released)::int released FROM platform_orders');
  assert.equal(totals.delivered, load.users * 20); assert.equal(totals.charged, Math.ceil(load.users / 2) * 2000 + Math.floor(load.users / 2) * 1000); assert.equal(totals.released, 0);
  assert.equal(batches.size, load.users * 20); assert.equal((await f.db.one("SELECT count(*)::int n FROM platform_ledger WHERE kind='charge'")).n, load.users * 20);
  assert.equal((await f.db.one('SELECT sum(frozen)::int n FROM platform_users')).n, 0);
  assert.equal((await f.config.public()).occupied, 0); assert.equal(peak, load.proxyCap); assert.equal(overlap, true);
  if (f.legacy) {
    assert.equal(f.legacy.registry.size, 0);
    assert.equal((await f.db.one('SELECT count(*)::int n FROM session_proxy_bindings')).n, 0);
    assert.equal((await f.db.one('SELECT count(*)::int n FROM platform_account_execution_claims')).n, 0);
  }
  for (const b of batches.values()) { assert.equal(b.state.status, 'complete'); if (b.state.runPlan.postRegistrationOAuth) assert.deepEqual(b.seen, b.oauthSeen); }
  assert.equal(new Set([...manual.seen, ...[...batches.values()].flatMap(b => b.seen)]).size, load.manual + load.users * 20);
  assert.equal(submitted.length, load.users);
  t.diagnostic(`${load.users} concurrent users, ${load.users * 20} customer accounts + ${load.manual} workbench accounts; customer cap ${load.globalCap}, per-user cap ${load.userCap}, combined proxy peak ${peak}; all delivered and settled once.`);
});
