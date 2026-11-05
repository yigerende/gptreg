'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RebindService } = require('../src/ui-server/rebind-service');
const { SessionAssetStore } = require('../src/session-asset-store');
const { rebindAccount } = require('../src/rebind-chain');
const { findDefaultHar } = require('../src/har');
const { createCookieJar, serializeCookieJar } = require('../src/cookie-jar');
const { clearSentinelSdkCache } = require('../src/sentinel-sdk-loader');
const { LogStore } = require('../src/ui-server/log-store');

const old = (id, extra = {}) => ({ id, email: `${id}@icloud.com`, mailProvider: 'icloud', createdAt: '2020-01-01T00:00:00.000Z', accessToken: 'test-token', ...extra });

function fixture(assets = [old('one')]) {
  const rows = new Map(assets.map((asset) => [asset.id, structuredClone(asset)]));
  const service = Object.create(RebindService.prototype);
  const store = { get: (id) => rows.get(id), update: (id, patch) => rows.set(id, { ...rows.get(id), ...patch }) };
  Object.assign(service, {
    state: service.freshState(), starting: false, stopRequested: false, queueIds: assets.map((asset) => asset.id),
    saveQueue() { this.savedQueue = [...this.queueIds]; },
    saveCompletedState() {},
    store: () => store,
    runManager: { sessionAssetIdsInUse: () => new Set() },
    proxyService: { list: () => ({}) },
    config: () => ({}),
    mailChannel: () => ({ ensure: async () => {} }),
  });
  return { service, rows };
}

test('the list carries first storage time and refresh retains it for the 24-hour lock', () => {
  let current;
  let now = Date.parse('2026-09-16T08:00:00Z');
  const store = Object.create(SessionAssetStore.prototype);
  Object.assign(store, {
    now: () => now, findIdentity: () => current, get: () => current,
    save: (asset) => (current = asset), entries: () => [],
    matchEntries: () => ({ matched: [{ filePath: 'memory' }], counts: {} }),
    readAssetForListing: () => current,
  });
  const initial = store.upsert({ email: 'first@icloud.com' });
  now += 86400000;
  store.update(initial.id, { accessToken: 'refreshed' });
  const row = store.query().assets[0];
  assert.equal(row.createdAt, initial.createdAt);
  assert.notEqual(row.updatedAt, row.createdAt);
  const info = RebindService.prototype.registrationInfo;
  assert.equal(info(row, now - 1).eligible, false);
  assert.equal(info(row, now).eligible, true);
  assert.equal(info({}, now).eligible, false);
});

test('queue reads discard deleted and already rebound accounts and expose refresh capability without secrets', () => {
  const { service } = fixture([old('one', { password: 'private', totpSecret: 'private' }), old('moved', { mailProvider: 'fastmail' })]);
  service.queueIds.push('missing');
  const queue = service.getQueue();
  assert.deepEqual(queue.accounts.map((asset) => asset.id), ['one']);
  assert.equal(queue.accounts[0].canRefresh, true);
  assert.equal(JSON.stringify(queue).includes('private'), false);
  assert.deepEqual(service.savedQueue, ['one']);
});

test('start returns immediately while mailbox allocation is pending and prevents duplicate starts', { timeout: 1000 }, async () => {
  const { service } = fixture();
  let releaseProcess;
  service.mailChannel = () => ({ claim: async () => ({ email: 'new@example.test', mailboxId: 'box-1' }) });
  service.rebindAccount = async ({ claimEmail, onStage }) => {
    onStage('claim');
    await claimEmail();
    await new Promise((resolve) => { releaseProcess = resolve; });
    return { assetId: 'one', status: 'error', stage: 'claim', error: 'empty' };
  };
  const body = { provider: 'fastmail', assetIds: ['one'], workerConcurrency: 20 };
  const started = await service.start(body);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(started.workerConcurrency, 1);
  assert.equal(service.status().starting, false);
  assert.equal(service.status().running, true);
  assert.equal(service.status().active[0].stage, 'claim');
  assert.equal(service.status().active[0].newEmail, 'new@example.test');
  await assert.rejects(service.start(body), /准备或运行中/);
  assert.throws(() => service.clearQueue(), /暂不可修改队列/);
  assert.throws(() => service.removeFromQueue(['one']), /暂不可修改队列/);
  assert.throws(() => service.addToQueue(['one']), /暂不可修改队列/);
  releaseProcess();
  await service.batch;
  assert.equal(service.status().running, false);
  assert.deepEqual(service.status().active, []);
});

test('mailbox failure finishes the batch and releases the lock for another start', async () => {
  const { service } = fixture();
  service.mailChannel = () => ({ claim: async () => { throw new Error('offline'); } });
  service.rebindAccount = async ({ claimEmail }) => claimEmail();
  const started = await service.start({ provider: 'fastmail', assetIds: ['one'] });
  await service.batch;
  assert.equal(started.ok, true);
  assert.equal(service.status().fail, 1);
  assert.equal(service.starting, false);
  assert.equal(service.status().running, false);
  await service.start({ provider: 'fastmail', assetIds: ['one'] });
  await service.batch;
  service.clearQueue();
  assert.deepEqual(service.queueIds, []);
});

test('always-login validates credentials while disabled auto-login suppresses the option', async () => {
  const { service } = fixture();
  const body = { provider: 'fastmail', assetIds: ['one'], alwaysFreshLogin: true };
  await assert.rejects(service.start(body), /缺少密码或 TOTP/);
  let mode;
  service.runBatch = async (_assets, ctx) => { mode = ctx.alwaysFreshLogin; };
  await service.start({ ...body, autoRefresh: false });
  await service.batch;
  assert.equal(mode, false);
});

test('a completed batch removes successes, preserves failures, and retains failure details', async () => {
  const assets = [old('one'), old('two')];
  const { service, rows } = fixture(assets);
  service.state = { ...service.freshState(), running: true, total: 2 };
  service.rebindAccount = async ({ asset }) => asset.id === 'one'
    ? { assetId: asset.id, previousEmail: asset.email, status: 'ok', newEmail: 'new@example.test', mailboxId: 'new-box' }
    : { assetId: asset.id, status: 'error', stage: 'otp', error: '验证码超时' };
  await service.runBatch(assets, { provider: 'fastmail', workerConcurrency: 2, resolveProxy: () => 'test-proxy', channel: {}, autoRefresh: false, proxyRetries: 0 });
  assert.deepEqual(service.queueIds, ['two']);
  assert.deepEqual(service.savedQueue, ['two']);
  assert.equal(rows.get('one').email, 'new@example.test');
  assert.equal(rows.get('one').createdAt, assets[0].createdAt);
  assert.equal(service.status().done, 2);
  assert.equal(service.status().ok, 1);
  assert.equal(service.status().fail, 1);
  assert.equal(service.status().running, false);
  assert.equal(service.status().results.find((item) => item.assetId === 'two').error, '验证码超时');
});

test('stopping finishes the current account and leaves untouched accounts queued', async () => {
  const assets = [old('one'), old('two')];
  const { service } = fixture(assets);
  service.state.running = true;
  service.rebindAccount = async ({ asset }) => {
    service.stop();
    return { assetId: asset.id, previousEmail: asset.email, status: 'ok', newEmail: 'new@example.test' };
  };
  await service.runBatch(assets, { provider: 'fastmail', workerConcurrency: 1, resolveProxy: () => '', channel: {}, autoRefresh: false });
  assert.equal(service.status().done, 1);
  assert.equal(service.status().stopRequested, true);
  assert.deepEqual(service.queueIds, ['two']);
});

test('confirmed changes are saved and dequeued even when the health check fails', async () => {
  const { service, rows } = fixture();
  service.rebindAccount = async () => ({
    assetId: 'one', previousEmail: 'one@icloud.com', newEmail: 'moved@example.test', mailboxId: 'box',
    status: 'error', stage: 'verify_health', code: 'PROBE_NETWORK_ERROR', error: 'probe failed', changeConfirmed: true,
    accessToken: 'refreshed-token', refreshed: true, proxyRetryable: true,
  });
  let attempts = 0;
  await service.runBatch([rows.get('one')], { provider: 'fastmail', workerConcurrency: 1, resolveProxy: () => String(++attempts), channel: {}, proxyRetries: 2 });
  assert.equal(attempts, 1);
  assert.equal(rows.get('one').email, 'moved@example.test');
  assert.equal(rows.get('one').accessToken, 'refreshed-token');
  assert.equal(rows.get('one').health.status, 'uncertain');
  assert.deepEqual(service.queueIds, []);
  assert.equal(service.status().results[0].changeConfirmed, true);
});

test('ambiguous confirmation is retained on the asset and cannot be queued or started again', async () => {
  const { service, rows } = fixture();
  service.rebindAccount = async () => ({ assetId: 'one', status: 'needs_review', verificationUncertain: true, newEmail: 'maybe@example.test', mailboxId: 'box' });
  await service.runBatch([rows.get('one')], { provider: 'fastmail', workerConcurrency: 1, resolveProxy: () => '', channel: {} });
  assert.equal(rows.get('one').email, 'one@icloud.com');
  assert.equal(rows.get('one').rebind.pendingEmail, 'maybe@example.test');
  assert.deepEqual(service.queueIds, []);
  assert.equal(service.addToQueue(['one']).blocked[0].reason, 'needs_review');
  await assert.rejects(service.start({ provider: 'fastmail', assetIds: ['one'] }), /待核对/);
});

test('stop during a failed attempt records the result without starting another attempt or account', async () => {
  const { service, rows } = fixture([old('one'), old('two')]);
  service.state.running = true;
  let calls = 0;
  service.rebindAccount = async () => {
    calls++;
    service.stop();
    return { assetId: 'one', status: 'error', proxyRetryable: true, error: 'timeout' };
  };
  await service.runBatch([...rows.values()], { provider: 'fastmail', workerConcurrency: 1, resolveProxy: () => 'proxy', channel: {}, proxyRetries: 2 });
  assert.equal(calls, 1);
  assert.equal(service.status().done, 1);
  assert.equal(service.status().fail, 1);
  assert.deepEqual(service.queueIds, ['one', 'two']);
});

test('status time advances while the same step is pending', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const { service } = fixture();
  service.state.active.push({ assetId: 'one', stage: 'otp', stageStartedAt: new Date().toISOString() });
  assert.equal(service.status().active[0].elapsedSeconds, 0);
  t.mock.timers.tick(15000);
  assert.equal(service.status().active[0].elapsedSeconds, 15);
});

test('post-change login and connection retries keep the original proxy even when pre-login is disabled', async () => {
  const { service, rows } = fixture([old('one', { password: 'test-password', totpSecret: 'test-totp', status: 'invalid', parentMailboxId: 'old-icloud-box', lastError: { code: 'LOGIN_STATE_INVALID' } })]);
  const logins = [];
  const requests = [];
  let proxyCalls = 0;
  let transportCalls = 0;
  service.loginAsset = async (asset, proxy, signal, onProgress) => {
    logins.push({ email: asset.email, proxy, password: asset.password });
    assert.ok(signal instanceof AbortSignal);
    onProgress({ step: 'password_verified' });
    const active = service.status().active[0];
    assert.equal(active.stage, 'post_login_refresh');
    assert.equal(active.loginStep, 'password_verified');
    return { accessToken: 'new-token', sessionToken: 'new-cookie-token', session: { user: { email: asset.email } } };
  };
  service.rebindAccount = (params) => rebindAccount({ ...params, executor: async (request, options) => {
    assert.equal(options.proxy, 'http://first.test:8080');
    if (++transportCalls === 1) throw new Error('ECONNRESET');
    requests.push(request.url);
    const email = request.headers.Authorization === 'Bearer new-token' ? 'moved@example.test' : 'one@icloud.com';
    return { response: { status: 200, text: JSON.stringify(request.url.endsWith('/me') ? { email } : {}) } };
  } });
  await service.runBatch([rows.get('one')], {
    provider: 'fastmail', workerConcurrency: 1, autoRefresh: false, proxyRetries: 2,
    resolveProxy: () => ++proxyCalls === 1 ? 'http://first.test:8080' : 'http://second.test:8080',
    channel: { claim: async () => ({ email: 'moved@example.test', mailboxId: 'box' }), readOtp: async () => '123456', consume: async () => {} },
  });
  assert.equal(proxyCalls, 1);
  assert.deepEqual(logins, [{ email: 'moved@example.test', proxy: 'http://first.test:8080', password: 'test-password' }]);
  assert.equal(requests.filter((url) => url.endsWith('/verify')).length, 1);
  assert.equal(rows.get('one').email, 'moved@example.test');
  assert.equal(rows.get('one').accessToken, 'new-token');
  assert.equal(rows.get('one').sessionToken, 'new-cookie-token');
  assert.equal(rows.get('one').parentMailboxId, 'box');
  assert.equal(rows.get('one').parentEmail, 'moved@example.test');
  assert.equal(rows.get('one').rebind.previousEmail, 'one@icloud.com');
  assert.equal(rows.get('one').status, 'valid');
  assert.equal(rows.get('one').lastError, null);
  assert.equal(rows.get('one').health.status, 'healthy');
  assert.equal(service.status().results[0].postRefreshed, true);
  assert.equal(service.status().results[0].attempts, 2);
  assert.deepEqual(service.status().results[0].attemptErrors.map(({ stage, code }) => ({ stage, code })), [{ stage: 'login', code: 'PROBE_NETWORK_ERROR' }]);
  assert.equal(JSON.stringify(service.status()).includes('test-password'), false);
  assert.equal(JSON.stringify(service.status()).includes('new-token'), false);
  assert.deepEqual(service.queueIds, []);
});

test('a failed post-change refresh saves the new email and leaves the account available for refresh', async () => {
  const { service, rows } = fixture([old('one', { password: 'test-password', totpSecret: 'test-totp' })]);
  let proxies = 0;
  let logins = 0;
  service.loginAsset = async () => { logins++; throw new Error('login request timeout'); };
  service.rebindAccount = (params) => rebindAccount({ ...params, timeouts: { retryMs: 0 }, executor: async (request) => ({ response: { status: 200, text: JSON.stringify(request.url.endsWith('/me') ? { email: 'one@icloud.com' } : {}) } }) });
  await service.runBatch([rows.get('one')], {
    provider: 'fastmail', workerConcurrency: 1, autoRefresh: true, proxyRetries: 2,
    resolveProxy: () => { proxies++; return 'http://same.test:8080'; },
    channel: { claim: async () => ({ email: 'moved@example.test', mailboxId: 'box' }), readOtp: async () => '123456', consume: async () => {} },
  });
  assert.equal(proxies, 1);
  assert.equal(logins, 3);
  assert.equal(service.status().results[0].attemptErrors.length, 2);
  assert.equal(rows.get('one').email, 'moved@example.test');
  assert.equal(rows.get('one').health.status, 'uncertain');
  assert.equal(rows.get('one').rebind.verificationUncertain, undefined);
  assert.equal(rows.get('one').status, 'partial');
  assert.equal(rows.get('one').health.code, 'REBIND_SESSION_REFRESH_PENDING');
  assert.equal(rows.get('one').parentEmail, 'moved@example.test');
  assert.equal(rows.get('one').parentMailboxId, 'box');
  assert.equal(rows.get('one').lastError.code, 'AT_REFRESH_FAILED');
  assert.equal(service.status().results[0].status, 'needs_refresh');
  assert.equal(service.status().running, false);
  assert.deepEqual(service.status().active, []);
});

test('post-change timeout resumes new-email login without repeating the mailbox or change', async () => {
  const { service, rows } = fixture([old('one', { password: 'original-password', totpSecret: 'original-totp', accountId: 'same-account' })]);
  let logins = 0;
  let claims = 0;
  let verifies = 0;
  let changed = false;
  service.loginAsset = async (asset, proxy, _signal, onProgress, transition) => {
    logins++;
    assert.equal(asset.email, 'new@example.test');
    assert.equal(proxy, 'http://127.0.0.1:7890');
    assert.deepEqual(transition, { previousEmail: 'one@icloud.com', email: asset.email, accountId: 'same-account' });
    onProgress({ step: 'password_verified' });
    assert.equal(service.status().active[0].stage, 'post_login_refresh');
    assert.equal(service.status().active[0].newEmail, 'new@example.test');
    if (logins === 1) throw Object.assign(new Error('connect ETIMEDOUT 127.0.0.1:7890'), { code: 'ETIMEDOUT' });
    return { accessToken: 'new-session', accountId: 'same-account' };
  };
  service.rebindAccount = (params) => rebindAccount({ ...params, timeouts: { retryMs: 0 }, executor: async (request) => {
    if (request.url.endsWith('/verify')) { verifies++; changed = true; }
    return { response: { status: 200, text: JSON.stringify(request.url.endsWith('/me') ? { email: changed ? 'new@example.test' : 'one@icloud.com', account_id: 'same-account' } : {}) } };
  } });
  await service.runBatch([rows.get('one')], {
    provider: 'mailcom', workerConcurrency: 1, proxyRetries: 2,
    resolveProxy: () => 'http://127.0.0.1:7890',
    channel: {
      claim: async () => { claims++; return { email: 'new@example.test', mailboxId: 'mailcom:alias:1:new' }; },
      readOtp: async () => '123456', consume: async () => {},
      release: async () => assert.fail('mailbox must not be released'),
    },
  });
  assert.equal(logins, 2);
  assert.equal(claims, 1);
  assert.equal(verifies, 1);
  assert.equal(service.status().ok, 1);
  assert.equal(service.status().proxyRetried, 1);
  assert.equal(service.status().results[0].attemptErrors[0].stage, 'post_login_refresh');
  assert.equal(rows.get('one').password, 'original-password');
  assert.equal(rows.get('one').totpSecret, 'original-totp');
  assert.equal(rows.get('one').accessToken, 'new-session');
  assert.equal(rows.get('one').rebind.postRefreshed, true);
});

test('starting one account keeps other queued accounts untouched and reports the submitted scope', async () => {
  const { service, rows } = fixture([old('one'), old('two', { accessToken: '' })]);
  const processed = [];
  service.rebindAccount = async ({ asset }) => {
    processed.push(asset.id);
    return { assetId: asset.id, previousEmail: asset.email, status: 'ok', newEmail: 'moved@example.test', mailboxId: 'box' };
  };
  const started = await service.start({ assetIds: ['one'], provider: 'fastmail', workerConcurrency: 20 });
  await service.batch;
  assert.equal(started.workerConcurrency, 1);
  assert.deepEqual(processed, ['one']);
  assert.deepEqual(service.status().assetIds, ['one']);
  assert.equal(service.status().total, 1);
  assert.equal(service.status().done, 1);
  assert.deepEqual(service.queueIds, ['two']);
  assert.equal(rows.get('two').email, 'two@icloud.com');
  assert.equal(rows.get('two').accessToken, '');
});

test('invalid proxy assignments fail before claiming a mailbox instead of falling back to maintenance', async () => {
  const { service } = fixture();
  let claims = 0;
  service.mailChannel = () => ({ claim: async () => { claims++; } });
  for (const assignment of [{ kind: 'local', localProxyId: 'gone' }, { kind: 'countryPool', countryCode: 'US' }, { kind: 'invalid' }]) {
    await assert.rejects(service.start({ assetIds: ['one'], provider: 'fastmail', proxyAssignments: [assignment] }), /代理/);
    assert.equal(service.state.running, false);
  }
  assert.equal(claims, 0);
});

test('real password and TOTP refresh completes before and after rebind without HAR and pins every request to one proxy', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rebind-live-login-'));
  const originalCwd = process.cwd();
  t.after(() => {
    process.chdir(originalCwd);
    fs.rmSync(directory, { recursive: true, force: true });
    clearSentinelSdkCache();
  });
  for (const name of ['localhost_Archive-one.har', 'localhost_Archive-two.har']) {
    fs.writeFileSync(path.join(directory, name), 'not a usable auth capture');
  }
  assert.throws(() => findDefaultHar(directory), /Multiple .har files/);
  process.chdir(directory);
  clearSentinelSdkCache();

  const proxy = 'http://proxy-user:proxy-password@same.test:8080';
  const asset = old('one', { password: 'original-password', totpSecret: 'JBSWY3DPEHPK3PXP', oaiDid: 'integration-did', accountId: 'integration-account' });
  const { service, rows } = fixture([asset]);
  service.config = () => ({ registration: { dynamicSentinel: true, prewarmSentinelSdk: true } });
  // An explicit stale capture setting must not affect dynamic session refresh.
  service.runManager.harPath = path.join(directory, 'missing.har');
  let email = asset.email;
  let proxyResolutions = 0;
  let beginAttempts = 0;
  const requests = [];
  const loginEmails = [];
  const stages = [];
  const sdkUrl = 'https://sentinel.openai.com/sentinel/integration/sdk.js';
  const sdkSource = `globalThis.SentinelSDK = {
    init() {
      const frame = document.createElement('iframe');
      document.body.appendChild(frame);
      frame.contentWindow.postMessage({ p: 'requirements-proof' }, '*');
    },
    token(flow) { return JSON.stringify({ p: 'proof', c: 'integration-challenge', id: 'integration-did', flow }); }
  };`;
  const executor = async (request, options) => {
    assert.equal(options.proxy, proxy, `Proxy changed at ${new URL(request.url).pathname}`);
    assert.ok(options.signal instanceof AbortSignal);
    const url = new URL(request.url);
    requests.push(url.pathname);
    stages.push(service.state.active[0].stage);
    const reply = (payload = {}, extra = {}) => ({ request, response: { status: 200, url: request.url, text: JSON.stringify(payload), ...extra } });
    if (url.pathname === '/') return reply();
    if (url.pathname === '/api/auth/csrf') return reply({ csrfToken: 'fixture-csrf' });
    if (url.pathname === '/api/auth/signin/openai') {
      email = url.searchParams.get('login_hint');
      loginEmails.push(email);
      assert.equal(url.searchParams.get('connection'), 'password');
      return reply({ url: 'https://auth.openai.com/log-in' });
    }
    if (url.pathname === '/log-in' || url.pathname === '/log-in/password') return reply();
    if (url.pathname === '/backend-api/sentinel/sdk.js') return reply({}, { text: `const sdk = '${sdkUrl}';` });
    if (request.url === sdkUrl) return reply({}, { text: sdkSource });
    if (url.pathname === '/backend-api/sentinel/req') {
      const body = JSON.parse(request.body);
      assert.equal(body.id, asset.oaiDid);
      assert.equal(body.p, 'requirements-proof');
      assert.ok(['authorize_continue', 'password_verify'].includes(body.flow));
      assert.equal(request.headers.Origin, 'https://sentinel.openai.com');
      assert.equal(request.headers.Referer, 'https://sentinel.openai.com/backend-api/sentinel/frame.html?sv=integration');
      return reply({ token: 'integration-challenge', proofofwork: { required: false }, turnstile: { required: false }, so: { required: false } });
    }
    if (url.pathname === '/api/accounts/authorize/continue') {
      assert.equal(JSON.parse(request.body).username.value, email);
      assert.ok(request.headers['openai-sentinel-token']);
      return reply({ continue_url: 'https://auth.openai.com/log-in/password', page: { type: 'login_password' } });
    }
    if (url.pathname === '/api/accounts/password/verify') {
      assert.equal(JSON.parse(request.body).password, asset.password);
      assert.ok(request.headers['openai-sentinel-token']);
      return reply({ continue_url: 'https://auth.openai.com/mfa-challenge/challenge', page: { type: 'mfa_challenge', payload: { factors: [{ id: 'factor-1', factor_type: 'totp', is_recovery: false }] } } });
    }
    if (url.pathname === '/api/accounts/mfa/issue_challenge') return reply();
    if (url.pathname === '/api/accounts/mfa/verify') {
      assert.match(JSON.parse(request.body).code, /^\d{6}$/);
      return reply({ page: { type: 'external_url', payload: { url: 'https://chatgpt.com/api/auth/callback/openai?code=fixture&state=fixture' } } });
    }
    if (url.pathname === '/api/auth/callback/openai') {
      const jar = createCookieJar(options.cookieJar);
      jar.setCookieSync(`__Secure-next-auth.session-token=session-${email}; Path=/; Secure; HttpOnly`, 'https://chatgpt.com/');
      return { ...reply({}, { status: 302, location: 'https://chatgpt.com/' }), cookieJar: serializeCookieJar(jar) };
    }
    if (url.pathname === '/api/auth/session') return reply({ accessToken: `token-${email}`, user: { email }, account: { id: asset.accountId } });
    if (url.pathname === '/backend-api/me') return reply({ email, account_id: asset.accountId });
    if (url.pathname === '/backend-api/wham/usage') return reply({ plan_type: 'free', used: 0, limit: 40 });
    if (url.pathname === '/backend-api/accounts/change_email/begin') {
      if (++beginAttempts === 1) throw new Error('ECONNRESET');
      return reply();
    }
    if (url.pathname === '/backend-api/accounts/change_email/verify') return reply();
    throw new Error(`Unexpected request (including any credential mutation): ${request.method} ${url.pathname}`);
  };
  service.loginExecutor = executor;
  service.rebindAccount = (params) => rebindAccount({ ...params, executor });
  await service.runBatch([rows.get('one')], {
    provider: 'fastmail', workerConcurrency: 1, autoRefresh: true, alwaysFreshLogin: true, proxyRetries: 2,
    resolveProxy: () => { proxyResolutions++; return proxyResolutions === 1 ? proxy : 'http://unexpected.test:8080'; },
    channel: { claim: async () => ({ email: 'moved@example.test', mailboxId: 'new-box' }), readOtp: async () => '123456', release: async () => {}, consume: async () => {} },
  });
  assert.equal(service.status().ok, 1, JSON.stringify(service.status().results));
  assert.deepEqual(loginEmails, ['one@icloud.com', 'moved@example.test']);
  assert.equal(proxyResolutions, 1);
  assert.equal(beginAttempts, 2);
  assert.ok(stages.includes('login_refresh'));
  assert.ok(stages.includes('post_login_refresh'));
  assert.equal(requests.filter((p) => p === '/api/accounts/mfa/verify').length, 2);
  assert.equal(requests.filter((p) => p === '/api/auth/session').length, 2);
  assert.equal(requests.filter((p) => p === '/backend-api/accounts/change_email/verify').length, 1);
  assert.equal(rows.get('one').accessToken, 'token-moved@example.test');
  assert.equal(rows.get('one').sessionToken, 'session-moved@example.test');
  assert.equal(rows.get('one').password, asset.password);
  assert.equal(rows.get('one').totpSecret, asset.totpSecret);
  assert.equal(rows.get('one').planType, 'free');
  assert.deepEqual(rows.get('one').usage, { plan_type: 'free', used: 0, limit: 40 });
  assert.equal(service.status().results[0].proxy, 'http://<redacted>@same.test:8080');
  assert.equal(JSON.stringify(service.status()).includes('proxy-password'), false);
});

test('failed reauthentication keeps stage diagnostics and survives a service restart without saving credentials', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rebind-history-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { service: stub, rows } = fixture([old('one', { password: 'asset-password-private', totpSecret: 'totp-private' })]);
  const logStore = new LogStore({ cwd: directory });
  const options = {
    cwd: directory, logStore,
    configService: { readRaw: () => ({}), normalized: () => ({ proxyPool: { maintenanceProxy: 'http://raw-user:raw-password@same.test:8080' } }) },
    runManager: { sessionAssets: stub.store, sessionAssetIdsInUse: () => new Set() },
    proxyService: { list: () => ({}) },
  };
  const service = new RebindService(options);
  service.queueIds = ['one'];
  let claims = 0;
  let releases = 0;
  service.mailChannel = () => ({
    claim: async () => { claims++; return { email: 'new@example.test', mailboxId: 'mailcom:box' }; },
    release: async () => { releases++; },
  });
  service.loginAsset = async (_asset, proxy, _signal, onProgress) => {
    assert.equal(proxy, 'http://raw-user:raw-password@same.test:8080');
    onProgress({ step: 'mfa_validated' });
    assert.equal(service.status().active[0].stage, 'change_reauth');
    assert.equal(service.status().active[0].newEmail, 'new@example.test');
    assert.equal(service.status().active[0].resumeStage, 'change_begin');
    assert.deepEqual(service.status().active[0].stagesReached, ['proxy_check', 'login', 'claim', 'change_begin', 'change_reauth']);
    throw Object.assign(new Error('chatgpt_me failed with HTTP 401: token_revoked'), { code: 'TOKEN_REVOKED', step: 'chatgpt_me', status: 401 });
  };
  service.rebindAccount = (params) => rebindAccount({ ...params, executor: async (request) => request.url.endsWith('/me')
    ? { response: { status: 200, text: '{"email":"one@icloud.com"}' } }
    : { response: { status: 401, text: '{"error":{"code":"reauth_required"}}' } },
  });
  await service.start({ assetIds: ['one'], provider: 'mailcom' });
  await service.batch;
  const result = service.status().results[0];
  assert.equal(claims, 1);
  assert.equal(releases, 1);
  assert.equal(result.stage, 'change_reauth');
  assert.equal(result.failure.code, 'TOKEN_REVOKED');
  assert.equal(result.failure.step, 'chatgpt_me');
  assert.equal(result.failure.httpStatus, 401);
  assert.equal(rows.get('one').email, 'one@icloud.com');

  const restored = new RebindService(options);
  assert.equal(restored.status().running, false);
  assert.equal(restored.status().runId, service.status().runId);
  assert.deepEqual(restored.status().results, service.status().results);
  const logs = logStore.read(service.state.runId, { reveal: true });
  assert.ok(logs.some((event) => event.type === 'login_state_rejected' && event.details.serverCode === 'reauth_required'));
  assert.ok(logs.some((event) => event.type === 'rebind_stage' && event.details.stage === 'change_reauth' && event.details.refreshReason === 'change_begin_rejected'));
  assert.ok(logs.some((event) => event.type === 'rebind_login_step' && event.details.step === 'mfa_validated'));
  assert.equal(logs.at(-1).type, 'rebind_finished');
  const saved = fs.readFileSync(path.join(directory, '.gpt-re-state/v2/rebind-last-result.json'), 'utf8') + JSON.stringify(logs);
  for (const secret of ['asset-password-private', 'totp-private', 'test-token', 'raw-password']) assert.equal(saved.includes(secret), false);
});

test('diagnostic write failures do not abort a rebind or hide its original failure', async () => {
  const { service } = fixture();
  service.logStore = { append: () => { throw new Error('disk full'); } };
  service.rebindAccount = async () => ({ assetId: 'one', status: 'error', stage: 'claim', error: 'no mailbox' });
  await service.start({ assetIds: ['one'], provider: 'fastmail' });
  await service.batch;
  assert.equal(service.status().results[0].error, 'no mailbox');
  assert.equal(service.status().fail, 1);
  assert.match(service.status().historyWarning, /日志写入失败/);
});

test('country-pool checks run before mailbox allocation and confirmed rebind records its own exit', async () => {
  const sourceProxy = { countryCode: 'US', endpoint: 'registered.test:8080', protocol: 'http', id: 'original' };
  const { service, rows } = fixture([old('one', { sourceProxy, password: 'unchanged-password', totpSecret: 'unchanged-totp' })]);
  const chosen = 'http://user:proxy-private@rebound.test:9000';
  service.config = () => ({ proxyPool: { healthCheck: { enabled: true, probeUrl: 'https://probe.example.test/', timeoutMs: 1234 } } });
  service.proxyService.list = () => ({ dynamic: { countryPools: [{ countryCode: 'JP', total: 1, entries: [{ url: chosen }] }] } });
  const order = [];
  service.proxyProbeExecutor = async (request, options) => {
    order.push('probe');
    assert.equal(options.proxy, chosen);
    assert.equal(request.url, 'https://probe.example.test/');
    assert.equal(options.timeoutMs, 1234);
    assert.equal(service.status().active[0].stage, 'proxy_check');
    return { response: { status: 200 } };
  };
  service.mailChannel = () => ({
    claim: async () => { order.push('claim'); return { email: 'moved@example.test', mailboxId: 'new-box' }; },
    readOtp: async () => '123456', release: async () => {}, consume: async () => {},
  });
  service.loginAsset = async (asset, proxy) => {
    assert.equal(proxy, chosen);
    order.push(`login:${asset.email}`);
    return { accessToken: 'new-token' };
  };
  let beginAttempts = 0;
  service.rebindAccount = (params) => rebindAccount({ ...params, executor: async (request, options) => {
    assert.equal(options.proxy, chosen);
    if (request.url.endsWith('/begin') && ++beginAttempts === 1) throw new Error('ECONNRESET');
    const email = request.headers.Authorization === 'Bearer new-token' ? 'moved@example.test' : 'one@icloud.com';
    return { response: { status: 200, text: JSON.stringify(request.url.endsWith('/me') ? { email } : {}) } };
  } });
  await service.start({ assetIds: ['one'], provider: 'fastmail', proxyAssignments: [{ workerSlot: 1, kind: 'countryPool', countryCode: 'JP' }] });
  await service.batch;
  assert.equal(service.status().ok, 1);
  assert.deepEqual(order, ['probe', 'claim', 'login:moved@example.test']);
  assert.deepEqual(rows.get('one').sourceProxy, sourceProxy);
  assert.equal(rows.get('one').rebindProxy.countryCode, 'JP');
  assert.equal(rows.get('one').rebindProxy.endpoint, 'rebound.test:9000');
  assert.equal(service.status().results[0].rebindProxy.countryCode, 'JP');
  assert.equal(JSON.stringify(rows.get('one').rebindProxy).includes('proxy-private'), false);
  assert.equal(rows.get('one').password, 'unchanged-password');
  assert.equal(rows.get('one').totpSecret, 'unchanged-totp');
});

test('failed proxy selection consumes no mailbox and does not change account provenance', async () => {
  const { service, rows } = fixture();
  service.proxyService.list = () => ({ dynamic: { countryPools: [{ countryCode: 'JP', entries: [{ url: 'http://bad.test:8080' }] }] } });
  service.proxyProbeExecutor = async () => ({ response: { status: 403, text: 'Cloudflare Just a moment' } });
  service.rebindAccount = async () => assert.fail('must not start an account on a rejected proxy');
  service.mailChannel = () => ({ claim: async () => assert.fail('must not claim a mailbox') });
  await service.start({ assetIds: ['one'], provider: 'fastmail', proxyAssignments: [{ workerSlot: 1, kind: 'countryPool', countryCode: 'JP' }] });
  await service.batch;
  assert.equal(service.status().results[0].stage, 'proxy_check');
  assert.equal(service.status().results[0].code, 'HEALTHY_PROXY_REQUIRED');
  assert.equal(service.status().results[0].attempts, 0);
  assert.equal(rows.get('one').email, 'one@icloud.com');
  assert.equal(rows.get('one').rebindProxy, undefined);
});

test('manual country-pool probes use the worker health policy and reject Cloudflare challenges', async () => {
  const { service } = fixture();
  const retired = [];
  service.proxyService.list = () => ({ dynamic: { countryPools: [{ countryCode: 'JP', entries: [{ url: 'http://challenge.test:8080' }] }] } });
  service.proxyService.retireDynamicEntry = (payload) => { retired.push(payload); return { retired: true }; };
  service.proxyProbeExecutor = async () => ({ response: { status: 403, text: 'Cloudflare Just a moment' } });
  const result = await service.probeAssignedProxies({ proxyAssignments: [{ kind: 'countryPool', countryCode: 'JP' }] });
  assert.equal(result.healthy, 0);
  assert.equal(result.failed, 1);
  assert.equal(result.results[0].httpStatus, 403);
  assert.equal(result.results[0].retired, true);
  assert.equal(retired[0].countryCode, 'JP');
});
