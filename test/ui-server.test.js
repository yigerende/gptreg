'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { makeInitialBranchState } = require('../src/branch-orchestrator');
const { makeInitialOrchestratorV2State, runOrchestratorV2 } = require('../src/orchestrator-v2');
const { applyRunPlan, normalizeRunPlan } = require('../src/run-plan');
const { buildApp } = require('../src/ui-server/app');
const { SessionAssetStore } = require('../src/session-asset-store');
const { ConfigService } = require('../src/ui-server/config-service');
const { buildProxyApiUrl } = require('../src/proxy-catalog');
const { ProxyService, parseProxyContent } = require('../src/ui-server/proxy-service');
const { ControlGate, RunManager, TERMINAL_RUN_STATUSES, preflightHttpError, terminalRunSummary } = require('../src/ui-server/run-manager');
const { balanceAccountFingerprint, finalizeBalanceReconciliation, recordBalanceStart } = require('../src/balance-reconciliation');
const { configFingerprint, saveV2State } = require('../src/state-store');
const { sanitizeValue } = require('../src/ui-server/utils');

function temporaryWorkspace() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-ui-'));
  const config = {
    schemaVersion: 2,
    mail: { provider: 'xiaopingguo', baseUrl: 'http://127.0.0.1:8000', password: 'mail-secret', count: 1 },
    aliases: { strategy: 'plus', count: 1, maxAttempts: 2, runTag: 'ui', plusAddressingEnabled: true },
    sms: { provider: 'mock', apiKey: 'sms-secret', maxPrice: 0, service: { code: 'mock' }, country: { id: 151 }, replacementBudget: 2 },
    workers: { maxConcurrency: 1 },
    registration: { exchangeToken: true, dynamicSentinel: true },
    proxyPool: { path: 'proxy-pool.txt', defaultProtocol: 'http', required: false, healthCheck: { enabled: false } },
    output: { stateDir: '.state', cpaDir: '.state/output' },
  };
  fs.writeFileSync(path.join(cwd, 'gpt-re.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  fs.writeFileSync(path.join(cwd, 'proxy-pool.txt'), '# empty\n');
  return { cwd, config };
}


/** The download name a response carries, decoded from its RFC 5987 form. */
function downloadName(response) {
  const header = String(response.headers['content-disposition'] || '');
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
  return encoded ? decodeURIComponent(encoded) : (/filename="([^"]+)"/i.exec(header)?.[1] || '');
}

test('Mail.com import filters rejected selected domains before creating aliases', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  config.mail.provider = 'mailcom';
  config.mail.aliasDomainMode = 'selected';
  config.mail.aliasDomains = ['geologist.com', 'keromail.com', 'minister.com'];
  config.mail.adminToken = 'local-token';
  fs.writeFileSync(path.join(cwd, 'gpt-re.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  const manager = new RunManager({ cwd, configService: new ConfigService({ cwd }), logStore: { append() {} } });
  const assetStore = manager.sessionAssets();
  t.after(() => { assetStore.close(); fs.rmSync(cwd, { recursive: true, force: true }); });
  const calls = [];
  manager.mailcomClient = () => ({
    aliasDomains: [...config.mail.aliasDomains],
    async listAliasDomains() {
      return { domains: ['geologist.com', 'minister.com'], deniedDomains: ['keromail.com'] };
    },
    setAliasDomains(domains) {
      this.aliasDomains = [...domains];
    },
    async addMaster(email, password, options) {
      calls.push({ email, password, options });
      return { added: 1, aliasSetup: [{ created: ['alias@geologist.com'] }] };
    },
  });

  const accepted = await manager.startMailcomImport('master@example.com----password');
  assert.deepEqual(accepted.aliasDomains, {
    requested: ['geologist.com', 'keromail.com', 'minister.com'],
    usable: ['geologist.com', 'minister.com'],
    skipped: ['keromail.com'],
  });
  while (manager.mailcomImportProgress().status === 'running') {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.deepEqual(calls[0].options, { aliasDomains: ['geologist.com', 'minister.com'] });
  assert.equal(manager.mailcomImportProgress().status, 'complete');
});

test('Mail.com import rejects an all-unavailable selected domain set before starting', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  config.mail.provider = 'mailcom';
  config.mail.aliasDomainMode = 'selected';
  config.mail.aliasDomains = ['keromail.com'];
  config.mail.adminToken = 'local-token';
  fs.writeFileSync(path.join(cwd, 'gpt-re.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  const manager = new RunManager({ cwd, configService: new ConfigService({ cwd }), logStore: { append() {} } });
  const assetStore = manager.sessionAssets();
  t.after(() => { assetStore.close(); fs.rmSync(cwd, { recursive: true, force: true }); });
  let addCalls = 0;
  manager.mailcomClient = () => ({
    async listAliasDomains() {
      return { domains: ['geologist.com'], deniedDomains: ['keromail.com'] };
    },
    async addMaster() { addCalls += 1; },
  });

  await assert.rejects(
    manager.startMailcomImport('master@example.com----password'),
    (error) => {
      assert.equal(error.statusCode, 409);
      assert.equal(error.details.code, 'MAILCOM_SELECTED_DOMAINS_UNAVAILABLE');
      return true;
    },
  );
  assert.equal(addCalls, 0);
  assert.equal(manager.mailcomImportProgress().status, 'idle');
});

test('iCloud import accepts mailbox----WDMail URL lines without invoking Mail API alias flow', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  config.mail.provider = 'icloud';
  config.mail.icloudBaseUrl = 'http://icloud.example.test:8001';
  config.mail.adminToken = 'local-token';
  fs.writeFileSync(path.join(cwd, 'gpt-re.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  const manager = new RunManager({ cwd, configService: new ConfigService({ cwd }), logStore: { append() {} } });
  const assetStore = manager.sessionAssets();
  t.after(() => { assetStore.close(); fs.rmSync(cwd, { recursive: true, force: true }); });
  const calls = [];
  manager.mailcomClient = () => {
    throw new Error('iCloud import must not construct a Mail.com/Fastmail client');
  };
  manager.icloudClient = () => ({
    async addMaster(email, endpoint) {
      calls.push({ email, endpoint });
      return { added: 1, duplicates: [] };
    },
  });

  const accepted = await manager.startIcloudImport([
    'hustle.dresses.0e@icloud.com----https://api.wdmail.top/m?f=html&e=hustle.dresses.0e@icloud.com:example-password',
    'invalid-line',
    'second.box@icloud.com----https://api.wdmail.top/m?f=html&e=second.box@icloud.com:second-password',
  ].join('\n'));

  assert.equal(accepted.provider, 'icloud');
  assert.equal(accepted.total, 2);
  assert.deepEqual(accepted.invalidLines, [2]);
  while (manager.icloudImportProgress().status === 'running') {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.deepEqual(calls, [
    {
      email: 'hustle.dresses.0e@icloud.com',
      endpoint: 'https://api.wdmail.top/m?f=html&e=hustle.dresses.0e@icloud.com:example-password',
    },
    {
      email: 'second.box@icloud.com',
      endpoint: 'https://api.wdmail.top/m?f=html&e=second.box@icloud.com:second-password',
    },
  ]);
  assert.equal(manager.icloudImportProgress().status, 'complete');
  assert.equal(manager.icloudImportProgress().added, 2);
});

/** Reads entry names out of a ZIP central directory. */
function zipEntryNames(buffer) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const end = data.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.notEqual(end, -1, 'archive has no end-of-central-directory record');
  const count = data.readUInt16LE(end + 10);
  let offset = data.readUInt32LE(end + 16);
  const names = [];
  for (let index = 0; index < count; index += 1) {
    assert.equal(data.readUInt32LE(offset), 0x02014b50, 'archive central directory is malformed');
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    names.push(data.toString('utf8', offset + 46, offset + 46 + nameLength));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.${Buffer.from('sig').toString('base64url')}`;
}

test('terminal run summaries report successful outputs and wall-clock duration only', () => {
  const base = {
    taskKind: 'register_session',
    runPlan: { taskKind: 'register_session', postRegistrationOAuth: true },
    status: 'failed',
    createdAt: '2026-08-07T00:00:00.000Z',
    updatedAt: '2026-08-07T00:00:10.000Z',
    jobs: [
      { sessionAssetId: 'asset-one', cpaPath: 'one.json' },
      { sessionAssetId: 'asset-two', cpaPath: 'two.json', cpaSuperseded: true },
      { status: 'failed' },
    ],
  };
  assert.deepEqual(terminalRunSummary(base), {
    message: 'register_oauth 1 · time 10s',
    details: { result: 'register_oauth', count: 1, duration: '10s', status: 'failed' },
  });
  assert.equal(terminalRunSummary({
    ...base,
    taskKind: 'oauth',
    runPlan: { taskKind: 'oauth' },
  }).message, 'oauth 1 · time 10s');
  assert.equal(terminalRunSummary({
    ...base,
    taskKind: 'session_refresh',
    runPlan: { taskKind: 'session_refresh', security: { setPassword: true, enrollTotp: true } },
    jobs: [{ sessionAssetId: 'asset-one' }],
  }).details.result, 'otp_pw_recovery');
  assert.doesNotMatch(terminalRunSummary(base).message, /fail|cancel/i);
});

test('config API never returns inline secrets and preserves them on ordinary updates', async () => {
  const { cwd, config } = temporaryWorkspace();
  config.workers.auxiliaryTaskCapacity = 9;
  config.sub2api = { baseUrl: 'http://127.0.0.1:8080', adminApiKey: 'gateway-secret' };
  fs.writeFileSync(path.join(cwd, 'gpt-re.config.json'), `${JSON.stringify(config, null, 2)}
`);
  const service = new ConfigService({ cwd });
  const snapshot = service.snapshot();
  // The sub2api gateway key has no console field, which is exactly why it must
  // still be stripped: the browser would otherwise round-trip it back on save.
  assert.equal(JSON.stringify(snapshot).includes('gateway-secret'), false);
  assert.equal(snapshot.config.sub2api.baseUrl, 'http://127.0.0.1:8080');
  service.update({ config: snapshot.config });
  assert.equal(service.readRaw().sub2api.adminApiKey, 'gateway-secret');
  assert.equal(snapshot.secrets.mailPasswordConfigured, true);
  assert.equal(snapshot.secrets.smsApiKeyConfigured, true);
  assert.equal(JSON.stringify(snapshot).includes('mail-secret'), false);
  assert.equal(JSON.stringify(snapshot).includes('sms-secret'), false);
  assert.equal(Object.hasOwn(snapshot.config.workers, 'auxiliaryTaskCapacity'), false);
  assert.equal(Object.hasOwn(service.readRaw().workers, 'auxiliaryTaskCapacity'), false);

  const legacy = service.readRaw();
  legacy.sms.firefox = { apiReturn: true, baseUrl: 'http://user-edited.example/api' };
  fs.writeFileSync(path.join(cwd, 'gpt-re.config.json'), `${JSON.stringify(legacy, null, 2)}\n`);
  service.update({ config: { sms: { firefox: { apiReturn: true, baseUrl: 'http://another.example/api' } } } });
  const cleaned = service.readRaw();
  assert.equal(Object.hasOwn(cleaned.sms.firefox, 'apiReturn'), false);
  assert.equal(cleaned.sms.firefox.baseUrl, 'https://firefox.fun/yhapi.ashx');

  service.update({ config: { aliases: { count: 2, maxAttempts: 2 } } });
  const stored = service.readRaw();
  assert.equal(stored.aliases.count, 2);
  assert.equal(stored.mail.password, 'mail-secret');
  assert.equal(stored.sms.apiKey, 'sms-secret');
});

test('stopping an ordinary rental narrows the task to the mailboxes it already holds', async (t) => {
  // Stopping means the run will never claim another mailbox, so the target it
  // was aiming at is no longer the size of the task. Left alone, 任务进度 went
  // on counting toward it — 12/200 for the rest of the run, the bar frozen at
  // 6% while the work actually finished.
  const { cwd, config } = temporaryWorkspace();
  config.mail = {
    ...config.mail,
    provider: 'smsbower',
    service: { code: 'dr' },
    domain: 'gmail.com',
    maxPrice: 0.2,
    apiKey: 'mail-key',
  };
  fs.writeFileSync(path.join(cwd, 'gpt-re.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  const manager = new RunManager({ cwd, configService: new ConfigService({ cwd }), logStore: { append() {} } });
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailProvider: 'smsbower',
    mailCount: 200,
    workerConcurrency: 2,
    aliasStrategy: 'root',
    security: { setPassword: true, enrollTotp: true },
  }, manager.config());
  const applied = applyRunPlan(manager.config(), plan);
  const runId = 'ui-stop-normal-rental';
  const state = makeInitialBranchState(applied, plan, { runId });
  state.status = 'running';
  state.phase = 'running';
  state.mailboxes = Array.from({ length: 12 }, (_, index) => ({
    id: `mail-${index}`,
    email: `rented-${index}@example.test`,
    rented: true,
    status: 'reserved',
  }));
  const stateFile = path.join(applied.output.stateDir, `run-${runId}.json`);
  saveV2State(stateFile, state);

  const app = buildApp({ cwd });
  t.after(async () => {
    await manager.shutdown();
    await app.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const response = await app.inject({ method: 'POST', url: `/api/v1/runs/${runId}/mail-rental/stop` });
  assert.equal(response.statusCode, 202, response.body);
  const summary = response.json();
  assert.equal(summary.plan.mailCount, 12);
  assert.equal(summary.plan.totalAccounts, 12);
  assert.equal(summary.mailRental.target, 12);
  assert.equal(summary.mailRental.claimedCount, 12);
  assert.equal(summary.normalWait.message, 'Future mailbox rentals are stopped; the 12 already rented will finish the task');
  // Narrowing the target is what the deficit math reads, so the run cannot
  // quietly rent again on the next scheduler pass.
  const stopped = app.services.runManager.load(runId);
  assert.ok(String(stopped.mailRentalStoppedAt || '').trim(), 'the shared stop marker must be recorded');
  assert.equal(stopped.runPlan.mailCount, 12);
  assert.equal(
    stopped.configFingerprint,
    configFingerprint(app.services.runManager.configForState(stopped)),
    'a narrowed target changes mail.count, so the effective fingerprint must be persisted with it',
  );

  // Resuming rentals afterwards adds to what is held rather than restoring a
  // target the operator has already abandoned.
  const resumed = await app.inject({
    method: 'POST',
    url: `/api/v1/runs/${runId}/mail-rental/configure`,
    payload: { additional: 8, action: 'continue' },
  });
  assert.equal(resumed.statusCode, 202, resumed.body);
  const resumedSummary = resumed.json();
  assert.equal(resumedSummary.plan.mailCount, 20);
  assert.equal(resumedSummary.plan.totalAccounts, 20);
  assert.equal(resumedSummary.mailRental.target, 20);
});

test('hang-rental controls persist stop and live target updates without restarting', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  config.mail = {
    ...config.mail,
    provider: 'smsbower',
    service: { code: 'dr' },
    domain: 'gmail.com',
    maxPrice: 0.2,
    apiKey: 'mail-key',
  };
  fs.writeFileSync(path.join(cwd, 'gpt-re.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  const manager = new RunManager({ cwd, configService: new ConfigService({ cwd }), logStore: { append() {} } });
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailProvider: 'smsbower',
    mailRentalWatch: true,
    mailRentalTarget: 25,
    mailRentalBatchSize: 20,
    mailRentalPollIntervalMs: 20_000,
    mailCount: 25,
    workerConcurrency: 1,
    aliasStrategy: 'root',
    security: { setPassword: true, enrollTotp: true },
  }, manager.config());
  const applied = applyRunPlan(manager.config(), plan);
  const runId = 'ui-stop-mail-rental';
  const state = makeInitialBranchState(applied, plan, { runId });
  state.status = 'waiting';
  state.phase = 'waiting_mail_rental_watch';
  state.mailRentalWatch.nextPollAt = new Date(Date.now() + 20_000).toISOString();
  const stateFile = path.join(applied.output.stateDir, `run-${runId}.json`);
  saveV2State(stateFile, state);

  const app = buildApp({ cwd });
  t.after(async () => {
    await manager.shutdown();
    await app.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const response = await app.inject({ method: 'POST', url: `/api/v1/runs/${runId}/mail-rental/stop` });
  assert.equal(response.statusCode, 202, response.body);
  const summary = response.json();
  assert.equal(summary.status, 'waiting');
  assert.equal(summary.mailRentalWatch.stopRequested, true);
  assert.equal(summary.mailRentalWatch.nextPollAt, '');
  assert.ok(summary.mailRentalWatch.stoppedAt, 'stop must record when future claims were disabled');
  assert.equal(summary.normalWait.message, 'Future mailbox rentals are stopped; already rented mailboxes will continue');
  assert.equal(summary.normalWait.nextRunAt, '');
  assert.equal(summary.plan.mailRentalWatch, true);

  const configured = await app.inject({
    method: 'POST',
    url: `/api/v1/runs/${runId}/mail-rental/configure`,
    payload: { additional: 225, batchSize: 3, pollIntervalMs: 45_000, action: 'continue' },
  });
  assert.equal(configured.statusCode, 202, configured.body);
  const configuredSummary = configured.json();
  assert.equal(configuredSummary.plan.mailCount, 250);
  assert.equal(configuredSummary.plan.mailRentalTarget, 250);
  assert.equal(configuredSummary.plan.totalAccounts, 250);
  assert.equal(configuredSummary.mailRentalWatch.target, 250);
  assert.equal(configuredSummary.mailRentalWatch.batchSize, 3);
  assert.equal(configuredSummary.mailRentalWatch.pollIntervalMs, 45_000);
  assert.equal(configuredSummary.mailRentalWatch.stopRequested, false);
  assert.equal(configuredSummary.mailRentalWatch.nextPollAt !== '', true);
  const configuredState = app.services.runManager.load(runId);
  assert.equal(
    configuredState.configFingerprint,
    configFingerprint(app.services.runManager.configForState(configuredState)),
    'live hang-rental changes must persist the effective run fingerprint',
  );

  const fast = await app.inject({
    method: 'POST',
    url: `/api/v1/runs/${runId}/mail-rental/configure`,
    payload: { pollIntervalMs: 1_000, action: 'continue' },
  });
  assert.equal(fast.statusCode, 202, fast.body);
  assert.equal(fast.json().mailRentalWatch.pollIntervalMs, 1_000);

  const decrease = await app.inject({
    method: 'POST',
    url: `/api/v1/runs/${runId}/mail-rental/configure`,
    payload: { target: 249, action: 'continue' },
  });
  assert.equal(decrease.statusCode, 400, decrease.body);
  assert.equal(decrease.json().details.code, 'MAIL_RENTAL_TARGET_DECREASE_NOT_ALLOWED');
});

test('hang-rental resume migrates legacy live-target changes but rejects unrelated drift', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  config.mail = {
    ...config.mail,
    provider: 'smsbower',
    service: { code: 'dr' },
    domain: 'gmail.com',
    maxPrice: 0.2,
    apiKey: 'mail-key',
  };
  fs.writeFileSync(path.join(cwd, 'gpt-re.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  const configService = new ConfigService({ cwd });
  const manager = new RunManager({ cwd, configService, logStore: { append() {} } });
  t.after(async () => {
    await manager.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailProvider: 'smsbower',
    mailRentalWatch: true,
    mailRentalTarget: 25,
    mailRentalBatchSize: 20,
    mailRentalPollIntervalMs: 20_000,
    mailCount: 25,
    workerConcurrency: 1,
    aliasStrategy: 'root',
    security: { setPassword: true, enrollTotp: true },
  }, configService.normalized());
  const applied = applyRunPlan(configService.normalized(), plan);
  const makeLegacyState = (runId) => {
    const state = makeInitialBranchState(applied, plan, { runId });
    state.status = 'waiting';
    state.phase = 'waiting_mail_rental_watch';
    state.mailRentalWatch.target = 150;
    state.mailRentalWatch.batchSize = 7;
    state.mailRentalWatch.pollIntervalMs = 30_000;
    state.mailRentalWatch.nextPollAt = new Date(Date.now() + 30_000).toISOString();
    state.runPlan.mailCount = 150;
    state.runPlan.mailRentalTarget = 150;
    state.runPlan.mailRentalBatchSize = 7;
    state.runPlan.mailRentalPollIntervalMs = 30_000;
    state.runPlan.totalAccounts = 150;
    state.preflight = {
      ready: true,
      mail: { rentalWatch: { target: 25, batchSize: 20, pollIntervalMs: 20_000 } },
      plan: structuredClone(plan),
    };
    return state;
  };

  const legacyRunId = 'legacy-hang-rental-resume';
  const legacyState = makeLegacyState(legacyRunId);
  const legacyStateFile = path.join(applied.output.stateDir, `run-${legacyRunId}.json`);
  saveV2State(legacyStateFile, legacyState);
  manager.launch = () => {};

  await manager.resume(legacyRunId);
  const resumed = manager.load(legacyRunId);
  assert.equal(resumed.configFingerprint, configFingerprint(manager.configForState(resumed)));
  assert.equal(resumed.runPlan.mailRentalTarget, 150);
  // Free the main slot so the independent drift case reaches the fingerprint
  // gate instead of being rejected as a second active registration task.
  resumed.status = 'complete';
  saveV2State(legacyStateFile, resumed);

  const driftRunId = 'legacy-hang-rental-config-drift';
  const driftState = makeLegacyState(driftRunId);
  const driftStateFile = path.join(applied.output.stateDir, `run-${driftRunId}.json`);
  saveV2State(driftStateFile, driftState);
  configService.update({ config: { mail: { maxPrice: 0.3 } } });

  await assert.rejects(
    manager.resume(driftRunId),
    (error) => error.statusCode === 409 && /Current config does not match this run/.test(error.message),
  );
});

test('Mail API preview uses its credential while Xiaopingguo remains active', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  config.mail.adminToken = 'local-token';
  config.mail.mailcomBaseUrl = 'http://127.0.0.1:8001';
  config.mail.fastmailBaseUrl = 'http://127.0.0.1:8001';
  fs.writeFileSync(path.join(cwd, 'gpt-re.config.json'), `${JSON.stringify(config, null, 2)}\n`);

  const originalFetch = globalThis.fetch;
  const requests = [];
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const provider = url.searchParams.get('provider');
    requests.push({ path: url.pathname, provider, token: init?.headers?.['X-Admin-Token'] });
    if (url.pathname === '/api/pool/accounts') {
      return new Response(JSON.stringify({ provider, accounts: [] }), { status: 200 });
    }
    if (url.pathname === '/api/summary') {
      return new Response(JSON.stringify({ provider, masters: 0, aliases: 0, mailboxes: 0, available: 0 }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  };

  const app = buildApp({ cwd });
  t.after(() => app.close());
  for (const provider of ['mailcom', 'fastmail']) {
    const response = await app.inject({ url: `/api/v1/mailcom/status?provider=${provider}` });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.json().summary.provider, provider);
  }
  assert.equal(requests.length, 4);
  assert.equal(requests.every((request) => request.token === 'local-token'), true);
  assert.deepEqual([...new Set(requests.map((request) => request.provider))].sort(), ['fastmail', 'mailcom']);
});

test('source tasks bind the mailbox provider instead of the active global provider', () => {
  const { cwd } = temporaryWorkspace();
  const manager = new RunManager({ cwd, configService: new ConfigService({ cwd }), logStore: { append() {} } });
  try {
    const asset = manager.sessionAssets().upsert({
      email: 'legacy-fastmail@fastmail.example',
      parentMailboxId: 'fastmail:alias:1:asset',
      sourceKind: 'register_session',
    });

    const { config, plan } = manager.runConfiguration({
      taskKind: 'session_refresh',
      workerConcurrency: 1,
      mailProvider: 'xiaopingguo',
      oauthSource: { kind: 'session_assets', assetIds: [asset.id] },
    });
    assert.equal(plan.mailProvider, 'fastmail');
    assert.equal(config.mail.provider, 'fastmail');
    assert.equal(config.mail.baseUrl, config.mail.fastmailBaseUrl);
  } finally {
    manager.sessionAssets().close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('source tasks bind iCloud login-state assets to the iCloud mailbox config', () => {
  const { cwd } = temporaryWorkspace();
  const manager = new RunManager({ cwd, configService: new ConfigService({ cwd }), logStore: { append() {} } });
  try {
    const asset = manager.sessionAssets().upsert({
      email: 'legacy-icloud@icloud.example',
      parentMailboxId: 'icloud:mailbox:asset',
      sourceKind: 'register_session',
    });

    const { config, plan } = manager.runConfiguration({
      taskKind: 'session_refresh',
      workerConcurrency: 1,
      mailProvider: 'xiaopingguo',
      oauthSource: { kind: 'session_assets', assetIds: [asset.id] },
    });
    assert.equal(plan.mailProvider, 'icloud');
    assert.equal(config.mail.provider, 'icloud');
    assert.equal(config.mail.baseUrl, config.mail.icloudBaseUrl);
  } finally {
    manager.sessionAssets().close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('legacy source state uses its job mailbox namespace when the asset file is gone', () => {
  const { cwd } = temporaryWorkspace();
  const manager = new RunManager({ cwd, configService: new ConfigService({ cwd }), logStore: { append() {} } });
  try {
    const plan = normalizeRunPlan({
      taskKind: 'session_refresh',
      workerConcurrency: 1,
      mailProvider: 'xiaopingguo',
      oauthSource: { kind: 'session_assets', assetIds: ['missing-fastmail-asset'] },
    }, manager.config());
    const state = {
      runPlan: plan,
      jobs: [{
        assetId: 'missing-fastmail-asset',
        email: 'legacy-alias@fastmail.example',
        mailboxId: 'fastmail:alias:1:missing',
      }],
    };

    const config = manager.configForState(state);
    assert.equal(state.runPlan.mailProvider, 'fastmail');
    assert.equal(config.mail.provider, 'fastmail');
    assert.equal(config.mail.baseUrl, config.mail.fastmailBaseUrl);
  } finally {
    manager.sessionAssets().close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('resuming a legacy source task repairs the provider before launching', async (t) => {
  const { cwd } = temporaryWorkspace();
  const manager = new RunManager({ cwd, configService: new ConfigService({ cwd }), logStore: { append() {} } });
  const assetStore = manager.sessionAssets();
  t.after(() => { assetStore.close(); fs.rmSync(cwd, { recursive: true, force: true }); });
  const asset = manager.sessionAssets().upsert({
    email: 'resume-fastmail@fastmail.example',
    parentMailboxId: 'fastmail:alias:1:resume',
    accessToken: 'resume-access-token',
    status: 'partial',
    security: {
      totpStatus: 'retry_pending',
      failures: [{ feature: 'totp', code: 'SECURITY_SETUP_TIMEOUT' }],
    },
  });
  const plan = normalizeRunPlan({
    taskKind: 'session_refresh',
    workerConcurrency: 1,
    mailProvider: 'xiaopingguo',
    oauthSource: { kind: 'session_assets', assetIds: [asset.id] },
    security: { setPassword: false, enrollTotp: true },
  }, manager.config());
  const applied = applyRunPlan(manager.config(), plan);
  const runId = 'legacy-fastmail-provider-resume';
  const state = makeInitialBranchState(applied, plan, { runId });
  state.status = 'partial';
  state.phase = 'partial';
  state.jobs = [{
    id: 'job-resume-fastmail',
    taskKind: 'session_refresh',
    email: asset.email,
    parentEmail: asset.parentEmail || asset.email,
    mailboxId: asset.parentMailboxId,
    assetId: asset.id,
    status: 'partial',
    phase: 'partial',
    sessionState: {
      email: asset.email,
      status: 'valid',
      step: 'verified',
      security: {
        totpStatus: 'retry_pending',
        failures: [{ feature: 'totp', code: 'SECURITY_SETUP_TIMEOUT' }],
      },
    },
    sms: { current: null, attempts: [] },
  }];
  const stateFile = path.join(applied.output.stateDir, `run-${runId}.json`);
  saveV2State(stateFile, state);

  let launched = null;
  let launchedConfig = null;
  manager.launch = (next, _file, config) => {
    launched = next;
    launchedConfig = config;
    return {};
  };
  const response = await manager.resume(runId);

  assert.equal(response.plan.mailProvider, 'fastmail');
  assert.equal(launched.runPlan.mailProvider, 'fastmail');
  assert.equal(launchedConfig.mail.provider, 'fastmail');
  assert.equal(stateFile.endsWith(`${runId}.json`), true);
});

test('source tasks accept assets from different mailbox providers', () => {
  const { cwd } = temporaryWorkspace();
  const manager = new RunManager({ cwd, configService: new ConfigService({ cwd }), logStore: { append() {} } });
  try {
    const fastmail = manager.sessionAssets().upsert({
      email: 'one@fastmail.example',
      parentMailboxId: 'fastmail:alias:1:one',
    });
    const mailcom = manager.sessionAssets().upsert({
      email: 'two@mailcom.example',
      parentMailboxId: 'mailcom:alias:1:two',
    });
    const mailcomTwo = manager.sessionAssets().upsert({
      email: 'three@mailcom.example',
      parentMailboxId: 'mailcom:alias:1:three',
    });

    // Each job reads its own mailbox through its asset's channel; the plan
    // names the most common one for the run's own client.
    const { plan } = manager.runConfiguration({
      taskKind: 'oauth',
      workerConcurrency: 2,
      oauthSource: { kind: 'session_assets', assetIds: [fastmail.id, mailcom.id, mailcomTwo.id] },
    });
    assert.equal(plan.mailProvider, 'mailcom');
    assert.deepEqual(plan.oauthSource.assetIds, [fastmail.id, mailcom.id, mailcomTwo.id]);
  } finally {
    manager.sessionAssets().close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('source tasks reject an asset whose mailbox provider cannot be determined', () => {
  const { cwd } = temporaryWorkspace();
  const manager = new RunManager({ cwd, configService: new ConfigService({ cwd }), logStore: { append() {} } });
  try {
    const asset = manager.sessionAssets().upsert({
      email: 'unknown-pool@example.test',
      parentMailboxId: 'legacy:alias:1:unknown',
    });

    assert.throws(
      () => manager.runConfiguration({
        taskKind: 'session_refresh',
        workerConcurrency: 1,
        oauthSource: { kind: 'session_assets', assetIds: [asset.id] },
      }),
      (error) => {
        assert.equal(error.code, 'SESSION_ASSET_MAIL_PROVIDER_UNKNOWN');
        assert.deepEqual(error.assetIds, [asset.id]);
        assert.equal(error.unresolvedCount, 1);
        return true;
      },
    );
  } finally {
    manager.sessionAssets().close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('an active task allows only live alias-domain configuration changes', async (t) => {
  const { cwd } = temporaryWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const app = buildApp({ cwd });
  t.after(async () => {
    app.services.runManager.active = null;
    await app.close();
  });
  app.services.runManager.active = { state: { runId: 'active-run' } };

  const before = await app.inject({ url: '/api/v1/config' });
  const draft = JSON.parse(before.body).config;
  const aliasUpdate = await app.inject({
    method: 'PUT',
    url: '/api/v1/config',
    payload: {
      config: {
        ...draft,
        mail: {
          ...draft.mail,
          aliasDomainMode: 'selected',
          aliasDomains: ['geologist.com', 'minister.com'],
        },
      },
    },
  });
  assert.equal(aliasUpdate.statusCode, 200, aliasUpdate.body);
  assert.deepEqual(app.services.configService.readRaw().mail.aliasDomains, ['geologist.com', 'minister.com']);

  const unrelatedUpdate = await app.inject({
    method: 'PUT',
    url: '/api/v1/config',
    payload: {
      config: {
        ...draft,
        registration: { ...draft.registration, maxRuntimeMs: 123456 },
      },
    },
  });
  assert.equal(unrelatedUpdate.statusCode, 409, unrelatedUpdate.body);
});

test('service summary exposes a cached SMS balance without loading market inventory', async (t) => {
  const { cwd } = temporaryWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => new Response('', { status: 200 });
  let balanceCalls = 0;
  const balanceProviders = [];
  const app = buildApp({
    cwd,
    smsStatusTtlMs: 60_000,
    smsBalanceReader: async (config) => {
      balanceCalls += 1;
      balanceProviders.push(config.provider);
      return config.provider === 'firefox' ? 1.234 : 7.547;
    },
  });
  t.after(() => app.close());

  const first = await app.inject({ url: '/api/v1/services' });
  const second = await app.inject({ url: '/api/v1/services' });
  assert.equal(first.statusCode, 200, first.body);
  assert.ok(Array.isArray(first.json().services));
  assert.deepEqual(first.json().services.map((service) => service.name), ['mail']);
  assert.deepEqual(first.json().sms, { name: 'mock', status: 'online', balance: 7.547, currency: 'USD' });
  assert.deepEqual(second.json().sms, first.json().sms);
  assert.equal(balanceCalls, 1);

  const firefox = await app.inject({ url: '/api/v1/services?smsProvider=firefox' });
  assert.equal(firefox.statusCode, 200, firefox.body);
  assert.deepEqual(firefox.json().sms, { name: 'firefox', status: 'online', balance: 1.234, currency: 'CNY' });
  assert.equal(balanceCalls, 2);
  assert.deepEqual(balanceProviders, ['mock', 'firefox']);
});

test('balance reconciliation retry reads one balance without re-running the task', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const runId = 'balance-retry-only';
  const provider = {
    name: 'mock',
    apiKey: 'balance-retry-secret',
    async getBalance(options) {
      assert.equal(options.fresh, true);
      provider.calls += 1;
      return 9;
    },
    calls: 0,
  };
  const state = makeInitialOrchestratorV2State(config, { cwd, runId });
  state.status = 'complete';
  state.phase = 'complete';
  state.completedAt = '2026-08-31T00:00:10.000Z';
  state.jobs = [{
    id: 'job-balance-retry',
    status: 'complete',
    accountCreatedAt: '2026-08-31T00:00:05.000Z',
    sms: { attempts: [{ id: 'sms-balance-retry', provider: 'mock', status: 'complete', cost: 1, currency: 'USD' }] },
  }];
  const fingerprint = balanceAccountFingerprint(provider);
  recordBalanceStart(state, {
    checked: true,
    provider: 'mock',
    currency: 'USD',
    balance: 10,
    checkedAt: '2026-08-31T00:00:00.000Z',
    source: 'task_start',
  }, 0, { hasReader: true, accountFingerprint: fingerprint });
  state.balanceReconciliation = finalizeBalanceReconciliation(state.balanceReconciliation, {
    endBalance: null,
    endAccountFingerprint: fingerprint,
    errorCode: 'BALANCE_READ_FAILED',
    confirmedConsumed: 1,
    unresolved: 0,
    billingComplete: true,
  });
  const stateFile = path.join(cwd, config.output.stateDir, `run-${runId}.json`);
  saveV2State(stateFile, state);

  const manager = new RunManager({ cwd, configService: new ConfigService({ cwd }), logStore: { append() {} } });
  let executeCalls = 0;
  manager.execute = async () => { executeCalls += 1; };
  manager.runSmsProvider = () => provider;
  const app = buildApp({ cwd, runManager: manager });
  t.after(() => app.close());

  const response = await app.inject({ method: 'POST', url: `/api/v1/runs/${runId}/balance-reconciliation` });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().balanceReconciliation.status, 'matched');
  assert.equal(response.json().balanceReconciliation.finalizedAt !== '', true);
  assert.equal(provider.calls, 1);
  assert.equal(executeCalls, 0);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).balanceReconciliation.status, 'matched');
});

test('cancelling an inactive branch run finalizes its balance reconciliation', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    workerConcurrency: 1,
  }, config);
  const runId = 'cancel-finalizes-balance';
  const state = makeInitialBranchState(config, plan, { cwd, runId });
  state.status = 'paused';
  state.phase = 'paused';
  state.jobs = [{
    id: 'cancel-finalizes-balance-job',
    status: 'complete',
    phase: 'complete',
    sms: {
      attempts: [{ id: 'cancel-finalizes-balance-sms', status: 'complete', cost: 1, currency: 'USD' }],
    },
  }];
  const provider = {
    name: 'mock',
    apiKey: 'cancel-finalizes-balance-secret',
    calls: 0,
    async getBalance(options) {
      assert.equal(options.fresh, true);
      this.calls += 1;
      return 9;
    },
  };
  recordBalanceStart(state, {
    checked: true,
    provider: 'mock',
    currency: 'USD',
    balance: 10,
    checkedAt: '2026-08-31T00:00:00.000Z',
    source: 'task_start',
  }, 0, { hasReader: true, accountFingerprint: balanceAccountFingerprint(provider) });
  const stateFile = path.join(cwd, config.output.stateDir, `run-${runId}.json`);
  saveV2State(stateFile, state);

  const manager = new RunManager({ cwd, configService: new ConfigService({ cwd }), logStore: { append() {} } });
  manager.runSmsProvider = () => provider;
  const assetStore = manager.sessionAssets();
  t.after(() => {
    assetStore.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const result = await manager.cancel(runId, 'test cancel');
  assert.equal(result.status, 'cancelled');
  assert.equal(provider.calls, 1);
  assert.equal(result.balanceReconciliation.status, 'matched');
  assert.equal(result.balanceReconciliation.finalizedAt !== '', true);
});

test('balance reconciliation can recover a terminal record left pending before finalization', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const runId = 'balance-pending-terminal';
  const provider = {
    name: 'mock',
    apiKey: 'balance-pending-terminal-secret',
    calls: 0,
    async getBalance(options) {
      assert.equal(options.fresh, true);
      this.calls += 1;
      return 9;
    },
  };
  const state = makeInitialOrchestratorV2State(config, { cwd, runId });
  state.status = 'cancelled';
  state.phase = 'cancelled';
  state.jobs = [{
    id: 'balance-pending-terminal-job',
    status: 'complete',
    sms: {
      attempts: [{ id: 'balance-pending-terminal-sms', status: 'complete', cost: 1, currency: 'USD' }],
    },
  }];
  recordBalanceStart(state, {
    checked: true,
    provider: 'mock',
    currency: 'USD',
    balance: 10,
    checkedAt: '2026-08-31T00:00:00.000Z',
    source: 'task_start',
  }, 0, { hasReader: true, accountFingerprint: balanceAccountFingerprint(provider) });
  const stateFile = path.join(cwd, config.output.stateDir, `run-${runId}.json`);
  saveV2State(stateFile, state);

  const manager = new RunManager({ cwd, configService: new ConfigService({ cwd }), logStore: { append() {} } });
  manager.runSmsProvider = () => provider;
  const app = buildApp({ cwd, runManager: manager });
  t.after(() => app.close());

  const response = await app.inject({ method: 'POST', url: `/api/v1/runs/${runId}/balance-reconciliation` });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(provider.calls, 1);
  assert.equal(response.json().balanceReconciliation.status, 'matched');
  assert.equal(response.json().balanceReconciliation.finalizedAt !== '', true);
});

test('a run waiting for resource cleanup does not finalize its balance early', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'run-resource-cleanup-wait' });
  state.status = 'waiting';
  state.phase = 'waiting_resource_cleanup';
  state.lastError = { code: 'RESOURCE_CLEANUP_PENDING', message: 'mailbox cleanup is pending' };
  const provider = {
    name: 'mock',
    calls: 0,
    async getBalance() { this.calls += 1; return 1; },
  };
  recordBalanceStart(state, {
    checked: true,
    provider: 'mock',
    currency: 'USD',
    balance: 1,
    checkedAt: '2026-08-31T00:00:00.000Z',
    source: 'task_start',
  }, 0, { hasReader: true, accountFingerprint: balanceAccountFingerprint(provider) });
  const stateFile = path.join(cwd, config.output.stateDir, `run-${state.runId}.json`);
  saveV2State(stateFile, state);
  const manager = new RunManager({ cwd, configService: new ConfigService({ cwd }), logStore: { append() {} } });
  // Fail the run before it can touch the parked state. This used to happen by
  // accident — `harPath` pointed at a missing capture and the eager load threw
  // — which stopped being a lever once a branch run stopped opening captures
  // at all. What the test is actually about is the failure path: a run that
  // dies while its resources are still being cleaned up stays `waiting` and
  // does not settle its balance.
  manager.proxyEntriesForState = () => {
    throw Object.assign(new Error('proxy source unavailable'), { code: 'PROXY_SOURCE_UNAVAILABLE' });
  };

  await manager.execute({
    state,
    stateFile,
    config,
    gate: new ControlGate(),
    preparedResources: { smsProvider: provider },
    lock: { release() {} },
    slot: 'main',
  });

  assert.equal(state.status, 'waiting');
  assert.equal(state.phase, 'waiting_resource_cleanup');
  assert.equal(provider.calls, 0);
  assert.equal(state.balanceReconciliation.finalizedAt, '');
});

test('SMS market endpoint returns the current lowest quote independently of balance checks', async (t) => {
  const { cwd } = temporaryWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const requests = [];
  const app = buildApp({
    cwd,
    smsMarketReader: async (config) => {
      requests.push(config);
      return {
        provider: config.provider,
        currency: 'USD',
        service: { code: 'dr', name: 'OpenAI' },
        country: { id: 151, name: 'Chile' },
        cheapestPrice: 0.031,
        offers: 3,
        lowestOffers: [{ providerId: 'a', price: 0.031, count: 4 }],
        checkedAt: new Date().toISOString(),
      };
    },
  });
  t.after(() => app.close());

  const response = await app.inject({ url: '/api/v1/sms/market?provider=smsbower' });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().cheapestPrice, 0.031);
  assert.equal(requests[0].provider, 'smsbower');
});

test('SMS market snapshot preserves the shared SMSBower max price', async (t) => {
  const { cwd } = temporaryWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const configPath = path.join(cwd, 'gpt-re.config.json');
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  raw.sms = {
    ...raw.sms,
    provider: 'smsbower',
    apiKey: 'market-cap-secret',
    service: { code: 'dr' },
    maxPrice: 0.03,
    countries: [{ id: 151 }, { id: 6 }],
  };
  fs.writeFileSync(configPath, `${JSON.stringify(raw, null, 2)}\n`);
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async (url) => {
    const query = new URL(url).searchParams;
    const action = query.get('action');
    if (action === 'getCountries') return new Response(JSON.stringify({
      151: { eng: 'Chile' },
      6: { eng: 'Indonesia' },
      43: { eng: 'Germany' },
      4: { eng: 'Philippines' },
      73: { eng: 'Brazil' },
      33: { eng: 'Colombia' },
      1: { eng: 'Ukraine' },
      53: { eng: 'Saudi Arabia' },
    }), { status: 200 });
    if (action === 'getServicesList') return new Response(JSON.stringify([{ service: 'dr', name: 'OpenAI' }]), { status: 200 });
    if (action === 'getPricesV3') return new Response(JSON.stringify({
      status: 'success',
      data: [{ country: query.get('country'), service: 'dr', price: 0.02, count: 4 }],
    }), { status: 200 });
    throw new Error(`Unexpected SMS market action: ${action}`);
  };
  const app = buildApp({ cwd });
  t.after(() => app.close());

  const response = await app.inject({ url: '/api/v1/sms/market?provider=smsbower' });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().maxPrice, 0.03);
  assert.equal(response.json().countries.length, 8);
  assert.deepEqual(response.json().availableCountries, ['151', '6', '43', '4', '73', '33', '1', '53']);
});

test('run start uses a synchronous latch while asynchronous preflight is pending', async (t) => {
  const { cwd } = temporaryWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const app = buildApp({ cwd });
  t.after(() => app.close());
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let releaseLogin;
  let markLoginStarted;
  const loginStarted = new Promise((resolve) => { markLoginStarted = resolve; });
  const loginGate = new Promise((resolve) => { releaseLogin = resolve; });
  globalThis.fetch = async (input) => {
    const pathname = new URL(String(input)).pathname;
    if (pathname === '/api/login') {
      markLoginStarted();
      await loginGate;
      return new Response(JSON.stringify({ csrfToken: 'csrf-start-latch' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (pathname === '/api/accounts') {
      return new Response(JSON.stringify({ accounts: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`Unexpected start-latch request: ${pathname}`);
  };
  const plan = { taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root' };
  const first = app.services.runManager.start(plan);
  await loginStarted;

  await assert.rejects(app.services.runManager.start(plan), (error) => error.statusCode === 409 && /starting/.test(error.message));
  releaseLogin();
  await assert.rejects(first, (error) => error.statusCode === 409 && /Preflight is not ready/.test(error.message));
  assert.equal(app.services.runManager.starting, false);
  assert.equal(app.services.runManager.stateFiles().length, 0);
});


test('auxiliary capacity is fixed at three', (t) => {
  const { cwd } = temporaryWorkspace();
  const configService = new ConfigService({ cwd });
  const fromConfig = new RunManager({ cwd, configService, logStore: { append() {} } });
  // One cleanup, registered once: after-hooks run in registration order, so
  // removing the workspace first leaves every later hook reading a deleted
  // config — and on Windows an open asset store blocks the removal anyway.
  t.after(() => {
    fromConfig.sessionAssets().close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  assert.equal(fromConfig.slotCapacity('auxiliary').capacity, 3);
  // The main slot is not a capacity choice: registration consumes mailboxes,
  // numbers and residential exits, so one at a time is the point.
  assert.equal(fromConfig.slotCapacity('main').capacity, 1);

  configService.update({ config: { workers: { maxConcurrency: 2 } } });
  assert.equal(fromConfig.slotCapacity('auxiliary').capacity, 3);
});

test('registration and auxiliary tasks use independent capacity while assets stay exclusive', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  const configService = new ConfigService({ cwd });
  const manager = new RunManager({
    cwd,
    configService,
    logStore: { append() {} },
  });
  const assetStore = manager.sessionAssets();
  t.after(() => { assetStore.close(); fs.rmSync(cwd, { recursive: true, force: true }); });
  const firstAsset = assetStore.upsert({ email: 'aux-one@example.test', accessToken: 'aux-one-token' });
  const secondAsset = assetStore.upsert({ email: 'aux-two@example.test', accessToken: 'aux-two-token' });
  const thirdAsset = assetStore.upsert({ email: 'aux-three@example.test', accessToken: 'aux-three-token' });
  const fourthAsset = assetStore.upsert({ email: 'aux-four@example.test', accessToken: 'aux-four-token' });
  const releases = new Map();
  manager.runConfiguration = (input) => ({
    config,
    plan: normalizeRunPlan(input, configService.normalized()),
  });
  manager.proxySnapshot = () => null;
  manager.preparedPreflight = async () => ({ snapshot: { ready: true }, resources: {} });
  manager.execute = (active) => new Promise((resolve) => releases.set(active.state.runId, resolve));

  const registration = await manager.start({ taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root' });
  const firstAuxiliary = await manager.start({
    taskKind: 'oauth',
    workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: [firstAsset.id] },
  });
  assert.equal(manager.active.state.runId, registration.runId);
  assert.deepEqual(manager.activeRunIds().sort(), [firstAuxiliary.runId, registration.runId].sort());
  assert.equal(manager.taskCapacitySnapshot().main.available, 0);
  assert.equal(manager.taskCapacitySnapshot().auxiliary.available, 2);

  await assert.rejects(
    manager.start({
      taskKind: 'oauth',
      workerConcurrency: 1,
      oauthSource: { kind: 'session_assets', assetIds: [firstAsset.id] },
    }),
    (error) => error.statusCode === 409 && error.details?.code === 'SESSION_ASSET_IN_USE',
  );
  const secondAuxiliary = await manager.start({
    taskKind: 'session_refresh',
    workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: [secondAsset.id] },
  });
  const thirdAuxiliary = await manager.start({
    taskKind: 'session_refresh',
    workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: [thirdAsset.id] },
  });
  assert.equal(manager.taskCapacitySnapshot().auxiliary.available, 0);
  await assert.rejects(
    manager.start({
      taskKind: 'session_refresh',
      workerConcurrency: 1,
      oauthSource: { kind: 'session_assets', assetIds: [fourthAsset.id] },
    }),
    (error) => error.statusCode === 409 && error.details?.code === 'AUXILIARY_TASK_CAPACITY',
  );

  for (const runId of [registration.runId, firstAuxiliary.runId, secondAuxiliary.runId, thirdAuxiliary.runId]) releases.get(runId)();
  await Promise.all([...manager.activeRuns()].map((active) => active.promise));
  for (const active of manager.activeRuns()) {
    try { active.lock.release(); } catch {}
    if (active.slot === 'auxiliary') manager.auxiliaryActive.delete(active.state.runId);
    else manager.active = null;
  }
});

test('session asset classification stays blocked during asynchronous run startup', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const manager = new RunManager({ cwd, configService: new ConfigService({ cwd }), logStore: { append() {} } });
  const asset = manager.sessionAssets().upsert({ email: 'startup-reserved@example.test', accessToken: 'startup-token' });
  const plan = {
    schemaVersion: 3,
    taskKind: 'oauth',
    workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: [asset.id] },
  };
  manager.runConfiguration = () => ({ config, plan });
  manager.proxySnapshot = () => null;
  let release;
  let markStarted;
  const preflightStarted = new Promise((resolve) => { markStarted = resolve; });
  const preflightGate = new Promise((resolve) => { release = resolve; });
  manager.preparedPreflight = async () => {
    markStarted();
    await preflightGate;
    return { snapshot: { ready: false } };
  };
  const app = buildApp({ cwd, runManager: manager });
  t.after(() => app.close());

  const starting = manager.start(plan);
  await preflightStarted;
  const blocked = await app.inject({
    method: 'POST',
    url: '/api/v1/session-assets/classification',
    payload: { assetIds: [asset.id], classification: 'sold' },
  });
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.equal(manager.sessionAssets().get(asset.id).classification, 'active');

  release();
  await assert.rejects(starting, (error) => error.statusCode === 409 && /Preflight is not ready/.test(error.message));
  assert.equal(manager.startingAssetIds.size, 0);
  const classified = await app.inject({
    method: 'POST',
    url: '/api/v1/session-assets/classification',
    payload: { assetIds: [asset.id], classification: 'sold' },
  });
  assert.equal(classified.statusCode, 200, classified.body);
  assert.equal(manager.sessionAssets().get(asset.id).classification, 'sold');
});

test('run start reuses an exact recent preflight without logging in or listing mail twice', async (t) => {
  const { cwd } = temporaryWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const app = buildApp({ cwd });
  t.after(() => app.close());
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  globalThis.fetch = async (input) => {
    const pathname = new URL(String(input)).pathname;
    calls.push(pathname);
    if (pathname === '/api/login') {
      return new Response(JSON.stringify({ csrfToken: 'csrf-prepared' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (pathname === '/api/accounts') {
      return new Response(JSON.stringify({ accounts: [{ id: 11, email: 'ready@example.test', tokenValid: true, bound: false }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`Unexpected prepared-preflight request: ${pathname}`);
  };
  const plan = { taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root' };
  const manager = app.services.runManager;
  let launchedResources;
  manager.launch = (_state, _stateFile, _config, resources) => { launchedResources = resources; };

  const checked = await manager.preflight(plan);
  const started = await manager.start(plan);

  assert.equal(checked.ready, true);
  assert.ok(started.runId);
  assert.deepEqual(calls, ['/api/login', '/api/accounts']);
  assert.equal(launchedResources.mailAccounts[0].email, 'ready@example.test');
  assert.ok(launchedResources.mailClient);
});

test('parallel starts isolate cached branch resources per run', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  const configService = new ConfigService({ cwd });
  const manager = new RunManager({ cwd, configService, logStore: { append() {} } });
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const plan = normalizeRunPlan({
    taskKind: 'oauth',
    workerConcurrency: 1,
    oauthSource: {
      kind: 'credentials',
      accounts: [{ email: 'parallel-resource@example.test', password: 'secret', totpSecret: 'JBSWY3DPEHPK3PXP' }],
    },
  }, config);
  const cachedMailClient = {
    mailProvider: 'xiaopingguo',
    fork() {
      return { mailProvider: 'xiaopingguo', forked: true };
    },
  };
  const cachedPrepared = {
    snapshot: { ready: true },
    resources: {
      mailClient: cachedMailClient,
      mailAccounts: [{ id: 1, email: 'parallel-resource@example.test', bound: false }],
      smsProvider: { name: 'cached-provider' },
    },
  };
  const launched = [];
  manager.runConfiguration = () => ({ config, plan });
  manager.proxySnapshot = () => null;
  manager.preparedPreflight = async () => cachedPrepared;
  manager.initializeBalanceReconciliation = async () => {};
  manager.launch = (_state, _stateFile, _config, resources) => launched.push(resources);

  await Promise.all([manager.start(plan), manager.start(plan)]);

  assert.equal(launched.length, 2);
  assert.notEqual(launched[0].mailClient, launched[1].mailClient);
  assert.notEqual(launched[0].mailClient, cachedMailClient);
  assert.notEqual(launched[0].mailAccounts, launched[1].mailAccounts);
  assert.notEqual(launched[0].smsProvider, launched[1].smsProvider);
  assert.notEqual(launched[0].smsProvider, cachedPrepared.resources.smsProvider);

  launched[0].mailAccounts[0].bound = true;
  assert.equal(launched[1].mailAccounts[0].bound, false);
});

test('pure OAuth preflight does not require SMS credentials before a phone challenge exists', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  config.sms.apiKey = '';
  config.sms.apiKeyEnv = 'GPT_RE_TEST_MISSING_SMS_KEY';
  fs.writeFileSync(path.join(cwd, 'gpt-re.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  const previous = process.env.GPT_RE_TEST_MISSING_SMS_KEY;
  delete process.env.GPT_RE_TEST_MISSING_SMS_KEY;
  t.after(() => {
    if (previous === undefined) delete process.env.GPT_RE_TEST_MISSING_SMS_KEY;
    else process.env.GPT_RE_TEST_MISSING_SMS_KEY = previous;
  });
  fs.writeFileSync(path.join(cwd, 'proxy-pool.txt'), 'http://127.0.0.1:4001\n');
  const app = buildApp({ cwd });
  t.after(() => app.close());
  const store = app.services.runManager.sessionAssets();
  const asset = store.upsert({ email: 'oauth-conditional-sms@example.test', status: 'valid' });

  const preflight = await app.services.runManager.preflight({
    taskKind: 'oauth',
    workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: [asset.id] },
  });

  assert.equal(preflight.ready, true);
  assert.equal(preflight.sms.required, false);
  assert.equal(preflight.sms.checked, false);
  assert.equal(preflight.sms.conditional, true);
});

test('proxy import previews errors, removes duplicates, and writes normalized entries', () => {
  const { cwd } = temporaryWorkspace();
  const config = new ConfigService({ cwd });
  const service = new ProxyService(config);
  const preview = parseProxyContent('127.0.0.1:4001\n127.0.0.1:4001\nbad-line\n', { defaultProtocol: 'http' });
  assert.equal(preview.entries.length, 1);
  assert.equal(preview.duplicates.length, 1);
  assert.equal(preview.errors.length, 1);

  const result = service.import({ content: '127.0.0.1:4001\nsocks5://127.0.0.1:4002', mode: 'replace' });
  assert.equal(result.total, 2);
  assert.match(fs.readFileSync(path.join(cwd, 'proxy-pool.txt'), 'utf8'), /http:\/\/127\.0\.0\.1:4001/);
});

test('proxy recovery resume accepts a waiting run after selected mail domains change', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  config.mail.aliasDomainMode = 'selected';
  config.mail.aliasDomains = ['old-domain.example'];
  fs.writeFileSync(path.join(cwd, 'gpt-re.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  const configService = new ConfigService({ cwd });
  const manager = new RunManager({ cwd, configService, logStore: { append() {} } });
  const assetStore = manager.sessionAssets();
  t.after(() => { assetStore.close(); fs.rmSync(cwd, { recursive: true, force: true }); });
  const plan = normalizeRunPlan({ taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root' }, configService.normalized());
  const runId = 'waiting-domain-recovery';
  const state = makeInitialBranchState(configService.normalized(), plan, { runId });
  state.status = 'waiting';
  state.phase = 'waiting_proxy_rotation';
  state.configFingerprint = '0'.repeat(64);
  state.jobs = [{
    id: 'waiting-domain-job',
    status: 'waiting',
    phase: 'waiting_proxy_rotation',
    error: { code: 'ECONNRESET', message: 'proxy transport reset' },
    proxyTransportRecovery: { attempted: true, pending: true, failureCount: 1 },
  }];
  const stateFile = path.join(cwd, config.output.stateDir, `run-${runId}.json`);
  saveV2State(stateFile, state);
  configService.update({ config: { mail: { aliasDomainMode: 'selected', aliasDomains: ['new-domain.example'] } } });
  manager.proxySnapshot = () => ({ schemaVersion: 1, createdAt: new Date().toISOString(), assignments: [], entries: [{ id: 'new-proxy' }] });
  manager.launch = () => {};

  const resumed = await manager.resume(runId, { refreshProxySnapshot: true });
  const saved = manager.load(runId);
  assert.equal(resumed.runId, runId);
  assert.equal(saved.configFingerprint, configFingerprint(manager.configForState(saved)));
  assert.deepEqual(saved.proxyResourceSnapshot.entries, [{ id: 'new-proxy' }]);
});

test('asset ownership includes terminal registration runs that still expose recovery', () => {
  const { cwd, config } = temporaryWorkspace();
  let manager;
  try {
    const configService = new ConfigService({ cwd });
    manager = new RunManager({ cwd, configService, logStore: { append() {} } });
    const plan = normalizeRunPlan({
      taskKind: 'register_session',
      mailCount: 1,
      workerConcurrency: 1,
    }, configService.normalized());
    const runId = 'recoverable-registration-run';
    const assetId = 'asset-recoverable-registration';
    const state = makeInitialBranchState(config, plan, { runId });
    state.status = 'failed';
    state.phase = 'failed';
    state.jobs = [{
      id: 'recoverable-registration-job',
      status: 'partial',
      phase: 'security',
      assetId,
      sessionState: { security: { passwordStatus: 'retry_pending' } },
    }, {
      id: 'completed-registration-job',
      status: 'complete',
      phase: 'complete',
      assetId: 'asset-completed-registration',
    }];
    saveV2State(path.join(cwd, config.output.stateDir, `run-${runId}.json`), state);
    const produced = manager.sessionAssets().upsert({
      email: 'completed-registration@example.test',
      sourceRunId: runId,
    });

    assert.equal(manager.sessionAssetIdsInUse().has(assetId), true);
    assert.equal(manager.sessionAssetIdsInUse().has(produced.id), false);
  } finally {
    manager?.sessionAssets().close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('asset ownership releases a cancelled terminal run even when security recovery remains', () => {
  const { cwd, config } = temporaryWorkspace();
  let manager;
  try {
    const configService = new ConfigService({ cwd });
    manager = new RunManager({ cwd, configService, logStore: { append() {} } });
    const plan = normalizeRunPlan({
      taskKind: 'session_refresh',
      workerConcurrency: 1,
      oauthSource: { kind: 'session_assets', assetIds: ['asset-cancelled-security'] },
    }, configService.normalized());
    const runId = 'cancelled-security-recovery-run';
    const assetId = 'asset-cancelled-security';
    const state = makeInitialBranchState(config, plan, { runId });
    state.status = 'cancelled';
    state.phase = 'cancelled';
    state.jobs = [{
      id: 'cancelled-security-job',
      status: 'partial',
      phase: 'partial',
      assetId,
      sessionState: {
        step: 'verified',
        security: {
          passwordStatus: 'configured',
          totpStatus: 'failed',
          securityReauth: { status: 'failed' },
        },
      },
    }];
    saveV2State(path.join(cwd, config.output.stateDir, `run-${runId}.json`), state);

    assert.equal(manager.sessionAssetIdsInUse().has(assetId), false);
  } finally {
    manager?.sessionAssets().close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('robot maintenance ownership releases terminal jobs inside an active run', () => {
  const { cwd, config } = temporaryWorkspace();
  let manager;
  try {
    const configService = new ConfigService({ cwd });
    manager = new RunManager({ cwd, configService, logStore: { append() {} } });
    const plan = normalizeRunPlan({
      taskKind: 'register_session',
      mailCount: 1,
      workerConcurrency: 1,
    }, configService.normalized());
    const runId = 'mixed-job-status-run';
    const state = makeInitialBranchState(config, plan, { runId });
    state.status = 'running';
    state.jobs = [
      { id: 'job-complete', status: 'complete', assetId: 'asset-complete' },
      { id: 'job-failed', status: 'failed', assetId: 'asset-failed' },
      { id: 'job-waiting', status: 'waiting', assetId: 'asset-waiting' },
      { id: 'job-pending', status: 'pending', assetId: 'asset-pending' },
    ];
    saveV2State(path.join(cwd, config.output.stateDir, `run-${runId}.json`), state);
    const produced = manager.sessionAssets().upsert({
      email: 'produced-before-checkpoint@example.test',
      sourceRunId: runId,
    });

    const inFlight = manager.sessionAssetIdsInFlight();
    assert.equal(inFlight.has('asset-complete'), false);
    assert.equal(inFlight.has('asset-failed'), false);
    assert.equal(inFlight.has('asset-waiting'), true);
    assert.equal(inFlight.has('asset-pending'), true);
    assert.equal(inFlight.has(produced.id), true);
    assert.equal(manager.sessionAssetIdsInUse().has('asset-complete'), true);
    assert.equal(manager.sessionAssetIdsInUse().has(produced.id), true);
  } finally {
    manager?.sessionAssets().close();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('local API serves health, redacted config, proxies, runs, and SPA fallback', async () => {
  const { cwd } = temporaryWorkspace();
  const app = buildApp({ cwd });
  for (const url of ['/api/v1/health', '/api/v1/config', '/api/v1/proxies', '/api/v1/runs']) {
    const response = await app.inject({ url });
    assert.equal(response.statusCode, 200, `${url}: ${response.body}`);
  }
  const configResponse = await app.inject({ url: '/api/v1/config' });
  assert.equal(configResponse.body.includes('mail-secret'), false);
  await app.close();
});

test('login-state asset API supports bounded batch AT health checks', async (t) => {
  const { cwd } = temporaryWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  let captured = null;
  const app = buildApp({
    cwd,
    sessionAssetProbe: async (store, assetIds, options) => {
      captured = { store, assetIds, options };
      const asset = store.get(assetIds[0]);
      const health = {
        status: 'healthy', code: 'AT_VALID', message: 'ok', httpStatus: 200,
        checkedAt: '2026-08-06T00:00:00.000Z', latencyMs: 12, lastHealthyAt: '2026-08-06T00:00:00.000Z',
      };
      store.update(asset.id, { health });
      return { requested: 1, checked: 1, results: [{ assetId: asset.id, email: asset.email, healthy: true, ...health }] };
    },
  });
  t.after(() => app.close());
  const asset = app.services.runManager.sessionAssets().upsert({
    email: 'probe-api@example.test',
    accountId: 'account-probe-api',
    accessToken: 'probe-api-token',
  });

  const response = await app.inject({
    url: '/api/v1/session-assets/probe',
    method: 'POST',
    payload: { assetIds: [asset.id] },
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.json().results[0].status, 'healthy');
  assert.deepEqual(captured.assetIds, [asset.id]);
  assert.equal(captured.options.concurrency, 4);
  assert.equal(captured.options.proxy, 'http://127.0.0.1:7890');
  assert.equal(app.services.runManager.sessionAssets().list()[0].health.status, 'healthy');
});

test('login-state lifecycle accepts 500 assets and rejects larger batches', async (t) => {
  const { cwd } = temporaryWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const app = buildApp({ cwd });
  t.after(() => app.close());
  const store = app.services.runManager.sessionAssets();
  const assets = Array.from({ length: 500 }, (_, index) => store.upsert({
    email: `lifecycle-batch-${index}@example.test`,
    accessToken: `lifecycle-token-${index}`,
  }));
  const assetIds = assets.map((asset) => asset.id);

  const accepted = await app.inject({
    url: '/api/v1/session-assets/lifecycle',
    method: 'POST',
    payload: { assetIds, lifecycle: 'sold' },
  });
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json().changed.length, 500);

  const rejected = await app.inject({
    url: '/api/v1/session-assets/lifecycle',
    method: 'POST',
    payload: { assetIds: [...assetIds, assetIds[0]], lifecycle: 'active' },
  });
  assert.equal(rejected.statusCode, 400, rejected.body);
  assert.match(rejected.body, /Select at most 500 login-state assets/);
});

test('promo check falls through to an AT probe only for the unknown verdicts', async (t) => {
  const { cwd } = temporaryWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  let probedIds = null;
  let probeOptions = null;
  const app = buildApp({
    cwd,
    sessionAssetTrialCheck: async (store, assetIds) => ({
      requested: assetIds.length,
      checked: assetIds.length,
      results: assetIds.map((id, index) => ({
        assetId: id,
        email: store.get(id).email,
        trialAvailable: index === 0,
        status: index === 0 ? 'trial' : 'unknown',
        code: index === 0 ? 'TRIAL_OFFER_AVAILABLE' : 'TRIAL_UNAUTHORIZED',
        campaigns: [],
      })),
    }),
    sessionAssetProbe: async (store, assetIds, options) => {
      probedIds = assetIds;
      probeOptions = options;
      const health = {
        status: 'invalid', code: 'AT_UNAUTHORIZED', message: 'rejected', httpStatus: 401,
        checkedAt: '2026-08-14T00:00:00.000Z', latencyMs: 9, lastHealthyAt: '',
      };
      for (const id of assetIds) store.update(id, { health });
      return { requested: assetIds.length, checked: assetIds.length, results: assetIds.map((id) => ({ assetId: id, email: store.get(id).email, healthy: false, ...health })) };
    },
  });
  t.after(() => app.close());
  const store = app.services.runManager.sessionAssets();
  const withTrial = store.upsert({ email: 'promo-ok@example.test', accountId: 'account-promo-ok', accessToken: 'promo-ok-token' });
  const unknown = store.upsert({ email: 'promo-unknown@example.test', accountId: 'account-promo-unknown', accessToken: 'promo-unknown-token' });

  const response = await app.inject({
    url: '/api/v1/session-assets/trial-check',
    method: 'POST',
    payload: { assetIds: [withTrial.id, unknown.id] },
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.deepEqual(probedIds, [unknown.id]);
  assert.equal(probeOptions.proxy, 'http://127.0.0.1:7890');
  assert.equal(response.json().atProbe.results[0].status, 'invalid');
  assert.equal(store.get(unknown.id).health.code, 'AT_UNAUTHORIZED');
  assert.equal(store.get(withTrial.id).health, null);
});

test('a failing follow-up probe still returns the promo verdicts', async (t) => {
  const { cwd } = temporaryWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const app = buildApp({
    cwd,
    sessionAssetTrialCheck: async (store, assetIds) => ({
      requested: assetIds.length,
      checked: assetIds.length,
      results: assetIds.map((id) => ({ assetId: id, email: store.get(id).email, trialAvailable: false, status: 'unknown', code: 'TRIAL_NETWORK_ERROR', campaigns: [] })),
    }),
    sessionAssetProbe: async () => { throw new Error('probe transport is down'); },
  });
  t.after(() => app.close());
  const asset = app.services.runManager.sessionAssets().upsert({ email: 'promo-probe-fail@example.test', accessToken: 'promo-probe-fail-token' });

  const response = await app.inject({
    url: '/api/v1/session-assets/trial-check',
    method: 'POST',
    payload: { assetIds: [asset.id] },
  });

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().results[0].code, 'TRIAL_NETWORK_ERROR');
  assert.equal(response.json().atProbe, null);
});

test('the login-state list filters on three axes and reports counts that match the rows it returns', async (t) => {
  const { cwd } = temporaryWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const app = buildApp({ cwd });
  const store = app.services.runManager.sessionAssets();
  t.after(() => store.close());

  const freeMonthPlus = {
    status: 'trial',
    campaigns: [{ key: 'plus', planName: 'chatgptplusplan', durationPeriods: 1, durationPeriod: 'month', discountPercentage: 100 }],
  };
  const base = {
    accessToken: 'token',
    password: 'password',
    totpSecret: 'JBSWY3DPEHPK3PXP',
    status: 'valid',
    security: { passwordStatus: 'configured', totpStatus: 'configured' },
    health: { status: 'healthy' },
  };
  const chainJp = store.upsert({ ...base, email: 'chain-jp@example.test', trial: freeMonthPlus, sourceProxy: { countryCode: 'JP', resourceKind: 'countryPool' } });
  store.upsert({ ...base, email: 'chain-us@example.test', trial: freeMonthPlus, sourceProxy: { countryCode: 'US', resourceKind: 'countryPool' } });
  store.upsert({ ...base, email: 'oauth-jp@example.test', trial: { status: 'none' }, sourceProxy: { countryCode: 'JP', resourceKind: 'countryPool' } });
  const sold = store.upsert({ ...base, email: 'sold@example.test', trial: { status: 'none' }, oauth: { successful: true } });
  store.markLifecycle([sold.id], 'sold');

  const active = await app.inject({ url: '/api/v1/session-assets?lifecycle=active' });
  assert.equal(active.statusCode, 200, active.body);
  const page = active.json();
  assert.equal(page.total, 3);
  assert.equal(page.assets.length, 3);
  assert.deepEqual(page.counts.queue, { chain: 2, oauth: 1 });
  // The lifecycle axis is counted without applying itself, so the pool the
  // operator is not looking at still reports its size.
  assert.deepEqual(page.counts.lifecycle, { active: 3, sold: 1 });

  // Every count is a promise about how many rows clicking it yields. This is
  // the invariant the old console broke, so it is asserted over the whole axis
  // rather than on one sample.
  for (const [facet, expected] of Object.entries(page.counts.facets)) {
    const narrowed = await app.inject({ url: `/api/v1/session-assets?lifecycle=active&facet=${encodeURIComponent(facet)}` });
    assert.equal(narrowed.json().total, expected, `facet ${facet}`);
    assert.equal(narrowed.json().assets.length, expected, `facet ${facet} rows`);
  }

  // Axes compose, and `ids` selects exactly what the same filter renders.
  const composed = '/api/v1/session-assets?lifecycle=active&queue=chain&facet=exitCountry%3AJP';
  const narrowed = await app.inject({ url: composed });
  assert.equal(narrowed.json().total, 1);
  assert.equal(narrowed.json().assets[0].email, 'chain-jp@example.test');
  const ids = await app.inject({ url: composed.replace('/session-assets?', '/session-assets/ids?') });
  assert.equal(ids.statusCode, 200, ids.body);
  assert.deepEqual(ids.json(), { ids: [chainJp.id], total: 1 });

  // Paging covers the whole match set once, and the cursor stops at the end.
  const first = await app.inject({ url: '/api/v1/session-assets?lifecycle=active&limit=2' });
  assert.equal(first.json().assets.length, 2);
  assert.equal(first.json().cursor, '2');
  const second = await app.inject({ url: `/api/v1/session-assets?lifecycle=active&limit=2&cursor=${first.json().cursor}` });
  assert.equal(second.json().assets.length, 1);
  assert.equal(second.json().cursor, '');

  // A list row carries what the list draws and no more: the inspector's fields
  // and every credential stay on the detail endpoint.
  const row = page.assets[0];
  for (const field of ['accessToken', 'password', 'totpSecret', 'sessionToken', 'cookieJar']) {
    assert.equal(field in row, false, `list row must not carry ${field}`);
  }
  for (const field of ['parentEmail', 'sourceKind', 'cpa', 'schemaVersion']) {
    assert.equal(field in row, false, `list row should leave ${field} to the detail endpoint`);
  }
  assert.equal(row.createdAt, store.get(row.id).createdAt, 'the rebind picker needs the original storage time');
  assert.equal(typeof row.nextAction, 'string');
  assert.ok(Array.isArray(row.facets));
  const detail = await app.inject({ url: `/api/v1/session-assets/${chainJp.id}` });
  assert.equal(detail.json().parentEmail !== undefined, true);
  assert.equal(detail.json().accessToken, 'token');
  store.save({ ...store.get(chainJp.id), createdAt: '2020-01-01T00:00:00Z' });
  const oldestFirst = await app.inject({ url: '/api/v1/session-assets?sort=createdAtAsc&limit=1' });
  assert.equal(oldestFirst.json().assets[0].id, chainJp.id);
});

test('login-state asset API lists summaries, reveals details, exports credentials, and cascades CPA deletion', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const app = buildApp({ cwd });
  const store = app.services.runManager.sessionAssets();
  const asset = store.upsert({
    email: 'asset@example.test',
    accountId: 'account-api-fixture',
    accessToken: 'access-api-fixture',
    sessionToken: 'session-api-fixture',
    password: 'password-api-fixture',
    totpSecret: 'JBSWY3DPEHPK3PXP',
    status: 'valid',
  });
  const saved = store.replaceCpa(asset.id, { email: asset.email, access_token: 'cpa-api-fixture' }, {
    runId: 'asset-api-run',
    jobId: 'asset-api-job',
  });

  const listed = await app.inject({ url: '/api/v1/session-assets' });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.json().assets.length, 1);
  assert.equal(listed.body.includes('access-api-fixture'), false);
  assert.equal(listed.json().assets[0].hasPassword, true);

  store.setOAuthCooldown(asset.id, { failureCount: 21, sourceRunId: 'cooldown-run', sourceJobId: 'cooldown-job' });
  const coolingList = await app.inject({ url: `/api/v1/session-assets?lifecycle=active&facet=oauthCooldown` });
  assert.equal(coolingList.statusCode, 200, coolingList.body);
  assert.deepEqual(coolingList.json().assets.map((item) => item.id), [asset.id]);
  assert.equal(coolingList.json().assets[0].oauthCooldown.failureCount, 21);
  const localProxy = app.services.proxyService.import({ content: 'http://127.0.0.1:4001', mode: 'replace' }).local.proxies[0];
  const coolingPlan = normalizeRunPlan({
    taskKind: 'oauth', workerConcurrency: 1,
    proxyAssignments: [{ workerSlot: 1, kind: 'local', localProxyId: localProxy.id }],
    oauthSource: { kind: 'session_assets', assetIds: [asset.id] },
  }, config);
  const coolingPreflight = await app.inject({
    url: '/api/v1/preflight',
    method: 'POST',
    payload: { plan: coolingPlan },
  });
  assert.equal(coolingPreflight.statusCode, 200, coolingPreflight.body);
  assert.equal(coolingPreflight.json().ready, false);
  assert.deepEqual(coolingPreflight.json().mail.cooldownAssetIds, [asset.id]);
  const blockedOAuth = await app.inject({
    url: '/api/v1/runs',
    method: 'POST',
    payload: { plan: coolingPlan },
  });
  assert.equal(blockedOAuth.statusCode, 409, blockedOAuth.body);
  assert.equal(blockedOAuth.json().details.code, 'OAUTH_ASSET_COOLDOWN');
  const clearedCooldown = await app.inject({
    url: `/api/v1/session-assets/${asset.id}/oauth-cooldown/clear`,
    method: 'POST',
    payload: {},
  });
  assert.equal(clearedCooldown.statusCode, 200, clearedCooldown.body);
  assert.equal(clearedCooldown.json().cleared, true);
  assert.equal(store.get(asset.id).oauthCooldown, null);

  const detail = await app.inject({ url: `/api/v1/session-assets/${asset.id}` });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().accessToken, 'access-api-fixture');

  const totp = await app.inject({ url: `/api/v1/session-assets/${asset.id}/totp` });
  assert.equal(totp.statusCode, 200, totp.body);
  assert.match(totp.json().code, /^\d{6}$/);

  const exported = await app.inject({
    url: '/api/v1/session-assets/export',
    method: 'POST',
    payload: { assetIds: [asset.id], kind: 'credentials' },
  });
  assert.equal(exported.statusCode, 200, exported.body);
  assert.equal(exported.headers['cache-control'], 'no-store');
  assert.equal(exported.json().content, 'asset@example.test----password-api-fixture----JBSWY3DPEHPK3PXP\n');
  // This fixture asset already has a CPA, so the file says it went through OAuth.
  assert.match(exported.json().fileName, /^登录态凭证-已OAuth-1个-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.txt$/);

  const pausedPlan = normalizeRunPlan({
    taskKind: 'oauth',
    workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: [asset.id] },
  }, config);
  const pausedState = makeInitialBranchState(config, pausedPlan, { runId: 'asset-paused-run' });
  pausedState.status = 'paused';
  pausedState.phase = 'paused';
  pausedState.jobs = [{ id: 'asset-paused-job', assetId: asset.id, sessionAssetId: asset.id }];
  const pausedStateFile = path.join(cwd, config.output.stateDir, `run-${pausedState.runId}.json`);
  saveV2State(pausedStateFile, pausedState);
  const classificationBlocked = await app.inject({
    url: '/api/v1/session-assets/classification',
    method: 'POST',
    payload: { assetIds: [asset.id], classification: 'sold' },
  });
  assert.equal(classificationBlocked.statusCode, 409, classificationBlocked.body);
  assert.equal(store.get(asset.id).classification, 'active');
  const blocked = await app.inject({
    url: '/api/v1/session-assets',
    method: 'DELETE',
    payload: { assetIds: [asset.id], cascadeCpa: true },
  });
  assert.equal(blocked.statusCode, 200, blocked.body);
  assert.deepEqual(blocked.json().skipped, [asset.id]);
  assert.equal(fs.existsSync(saved.filePath), true);

  pausedState.status = 'cancelled';
  pausedState.phase = 'cancelled';
  saveV2State(pausedStateFile, pausedState);
  // The current path. `classification` above is the pre-lifecycle spelling and
  // is kept working, but the console posts to this one.
  const planned = await app.inject({
    url: '/api/v1/session-assets/lifecycle',
    method: 'POST',
    payload: { assetIds: [asset.id], lifecycle: 'planned' },
  });
  assert.equal(planned.statusCode, 200, planned.body);
  assert.deepEqual(planned.json().changed, [asset.id]);
  assert.equal(planned.json().lifecycle, 'planned');
  assert.equal(store.get(asset.id).lifecycle, 'planned');
  assert.equal(store.get(asset.id).classification, 'planned');

  const classified = await app.inject({
    url: '/api/v1/session-assets/lifecycle',
    method: 'POST',
    payload: { assetIds: [asset.id], lifecycle: 'sold' },
  });
  assert.equal(classified.statusCode, 200, classified.body);
  assert.deepEqual(classified.json().changed, [asset.id]);
  assert.equal(store.get(asset.id).lifecycle, 'sold');

  // `banned` is a probe verdict, not an operator choice, so it is refused here.
  const banned = await app.inject({
    url: '/api/v1/session-assets/lifecycle',
    method: 'POST',
    payload: { assetIds: [asset.id], lifecycle: 'banned' },
  });
  assert.equal(banned.statusCode, 400, banned.body);
  assert.equal(store.get(asset.id).lifecycle, 'sold');

  const retainedAsset = store.upsert({
    email: 'retained@example.test',
    accountId: 'account-retained',
    status: 'valid',
  });
  const retainedCpa = store.replaceCpa(retainedAsset.id, { email: retainedAsset.email, access_token: 'retained-cpa-token' }, {
    runId: 'retained-cpa-run',
    jobId: 'retained-cpa-job',
  });
  const retainedRemoval = await app.inject({
    url: '/api/v1/session-assets',
    method: 'DELETE',
    payload: { assetIds: [retainedAsset.id], cascadeCpa: false },
  });
  assert.equal(retainedRemoval.statusCode, 200, retainedRemoval.body);
  assert.equal(fs.existsSync(retainedCpa.filePath), true);
  const retainedArtifacts = await app.inject({ url: '/api/v1/artifacts/cpa' });
  const retainedRecord = retainedArtifacts.json().artifacts.find((item) => item.fileName === path.basename(retainedCpa.filePath));
  assert.equal(retainedRecord.runId, 'session-assets');
  assert.equal(retainedRecord.jobId, 'retained@example.test-cpa');
  const retainedExport = await app.inject({
    url: '/api/v1/artifacts/cpa/export',
    method: 'POST',
    payload: { items: [{ runId: retainedRecord.runId, jobId: retainedRecord.jobId }] },
  });
  assert.deepEqual(retainedExport.json(), [{ email: retainedAsset.email, access_token: 'retained-cpa-token' }]);

  const removed = await app.inject({
    url: '/api/v1/session-assets',
    method: 'DELETE',
    payload: { assetIds: [asset.id], cascadeCpa: true },
  });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.deepEqual(removed.json().removed, [asset.id]);
  assert.equal(fs.existsSync(saved.filePath), false);
  await app.close();
});

test('superseded OAuth history cannot delete the current canonical CPA', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const app = buildApp({ cwd });
  const store = app.services.runManager.sessionAssets();
  const asset = store.upsert({ email: 'revision@example.test', accountId: 'account-revision', status: 'valid' });
  const plan = normalizeRunPlan({
    taskKind: 'oauth',
    workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: [asset.id] },
  }, config);
  const oldRun = makeInitialBranchState(config, plan, { runId: 'oauth-revision-old' });
  const oldCpa = store.replaceCpa(asset.id, { email: asset.email, access_token: 'old-revision' }, {
    runId: oldRun.runId,
    jobId: 'job-revision-old',
  });
  oldRun.status = 'complete';
  oldRun.jobs = [{
    id: 'job-revision-old', email: asset.email, parentEmail: asset.email, status: 'complete', phase: 'complete',
    branch: 'oauth', aliasIndex: 1, assetId: asset.id, sessionAssetId: asset.id,
    cpaPath: oldCpa.cpa.path, cpaRevision: oldCpa.cpa.revision, sms: { current: null, attempts: [], costUsd: 0 },
  }];
  saveV2State(path.join(cwd, config.output.stateDir, `run-${oldRun.runId}.json`), oldRun);

  const newRun = makeInitialBranchState(config, plan, { runId: 'oauth-revision-new' });
  const newCpa = store.replaceCpa(asset.id, { email: asset.email, access_token: 'new-revision' }, {
    runId: newRun.runId,
    jobId: 'job-revision-new',
  });
  newRun.status = 'complete';
  newRun.jobs = [{
    id: 'job-revision-new', email: asset.email, parentEmail: asset.email, status: 'complete', phase: 'complete',
    branch: 'oauth', aliasIndex: 1, assetId: asset.id, sessionAssetId: asset.id,
    cpaPath: newCpa.cpa.path, cpaRevision: newCpa.cpa.revision, sms: { current: null, attempts: [], costUsd: 0 },
  }];
  saveV2State(path.join(cwd, config.output.stateDir, `run-${newRun.runId}.json`), newRun);

  const runs = await app.inject({ url: '/api/v1/runs' });
  const oldSummary = runs.json().runs.find((run) => run.runId === oldRun.runId);
  const newSummary = runs.json().runs.find((run) => run.runId === newRun.runId);
  assert.equal(oldSummary.jobs[0].cpaSuperseded, true);
  assert.equal(oldSummary.counts.cpaCompleted, 0);
  assert.equal(newSummary.jobs[0].cpaSuperseded, false);
  assert.equal(newSummary.counts.cpaCompleted, 1);

  const compactRuns = await app.inject({ url: '/api/v1/runs?compact=1' });
  assert.equal(compactRuns.statusCode, 200, compactRuns.body);
  assert.ok(Buffer.byteLength(compactRuns.body) < Buffer.byteLength(runs.body));
  const oldCompact = compactRuns.json().runs.find((run) => run.runId === oldRun.runId);
  const newCompact = compactRuns.json().runs.find((run) => run.runId === newRun.runId);
  assert.equal(Object.hasOwn(oldCompact, 'jobs'), false);
  assert.equal(Object.hasOwn(oldCompact, 'billing'), false);
  assert.equal(oldCompact.counts.cpaCompleted, 0);
  assert.equal(newCompact.counts.cpaCompleted, 1);

  const artifacts = (await app.inject({ url: '/api/v1/artifacts/cpa' })).json().artifacts;
  assert.equal(artifacts.find((artifact) => artifact.assetId === asset.id).aliasIndex, 0);

  const removed = await app.inject({ url: `/api/v1/runs/${oldRun.runId}?artifacts=1`, method: 'DELETE' });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal(fs.existsSync(newCpa.filePath), true);
  assert.equal(store.get(asset.id).cpa.revision, 2);
  assert.equal(JSON.parse(fs.readFileSync(newCpa.filePath, 'utf8')).access_token, 'new-revision');
  await app.close();
});

test('orphaned canonical CPA does not inherit metadata from superseded OAuth history', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const app = buildApp({ cwd });
  const store = app.services.runManager.sessionAssets();
  const asset = store.upsert({ email: 'orphan@example.test', accountId: 'account-orphan', status: 'valid' });
  const plan = normalizeRunPlan({
    taskKind: 'oauth',
    workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: [asset.id] },
  }, config);

  const oldRun = makeInitialBranchState(config, plan, { runId: 'oauth-orphan-old' });
  const oldCpa = store.replaceCpa(asset.id, { email: asset.email, access_token: 'old-orphan-token' }, {
    runId: oldRun.runId,
    jobId: 'job-orphan-old',
  });
  oldRun.status = 'complete';
  oldRun.jobs = [{
    id: 'job-orphan-old', email: asset.email, parentEmail: asset.email, status: 'complete', phase: 'complete',
    branch: 'oauth', aliasIndex: 1, assetId: asset.id, sessionAssetId: asset.id,
    cpaPath: oldCpa.cpa.path, cpaRevision: oldCpa.cpa.revision, sms: { current: null, attempts: [], costUsd: 0 },
  }];
  saveV2State(path.join(cwd, config.output.stateDir, `run-${oldRun.runId}.json`), oldRun);

  const newRun = makeInitialBranchState(config, plan, { runId: 'oauth-orphan-new' });
  const newCpa = store.replaceCpa(asset.id, { email: asset.email, access_token: 'new-orphan-token' }, {
    runId: newRun.runId,
    jobId: 'job-orphan-new',
  });
  // The job completed, but another job in the same task could still leave the
  // task partial. The CPA keeps its own completion result while history exists
  // and after that history is removed.
  newRun.status = 'partial';
  newRun.phase = 'partial';
  newRun.jobs = [{
    id: 'job-orphan-new', email: asset.email, parentEmail: asset.email, status: 'complete', phase: 'complete',
    branch: 'oauth', aliasIndex: 1, assetId: asset.id, sessionAssetId: asset.id,
    cpaPath: newCpa.cpa.path, cpaRevision: newCpa.cpa.revision, sms: { current: null, attempts: [], costUsd: 0 },
  }];
  saveV2State(path.join(cwd, config.output.stateDir, `run-${newRun.runId}.json`), newRun);

  const whileHistoryExists = await app.inject({ url: '/api/v1/artifacts/cpa' });
  assert.equal(whileHistoryExists.statusCode, 200, whileHistoryExists.body);
  assert.equal(whileHistoryExists.json().artifacts.find((artifact) => artifact.assetId === asset.id).runStatus, 'complete');
  const taskSummary = (await app.inject({ url: '/api/v1/runs' })).json().runs.find((run) => run.runId === newRun.runId);
  assert.equal(taskSummary.status, 'partial');

  const historyRemoved = await app.inject({ url: `/api/v1/runs/${newRun.runId}`, method: 'DELETE' });
  assert.equal(historyRemoved.statusCode, 200, historyRemoved.body);
  assert.equal(fs.existsSync(newCpa.filePath), true);

  const afterHistoryRemoval = await app.inject({ url: '/api/v1/artifacts/cpa' });
  assert.equal(afterHistoryRemoval.statusCode, 200, afterHistoryRemoval.body);
  assert.equal(afterHistoryRemoval.json().artifacts.find((artifact) => artifact.assetId === asset.id).runStatus, 'complete');

  const assetRemoved = await app.inject({
    url: '/api/v1/session-assets',
    method: 'DELETE',
    payload: { assetIds: [asset.id], cascadeCpa: false },
  });
  assert.equal(assetRemoved.statusCode, 200, assetRemoved.body);
  assert.equal(fs.existsSync(newCpa.filePath), true);

  const listed = await app.inject({ url: '/api/v1/artifacts/cpa' });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.deepEqual(listed.json().artifacts.map(({ runId, jobId }) => ({ runId, jobId })), [{
    runId: 'session-assets',
    jobId: 'orphan@example.test-cpa',
  }]);

  const staleDownload = await app.inject({ url: `/api/v1/runs/${oldRun.runId}/cpa/job-orphan-old` });
  assert.equal(staleDownload.statusCode, 404, staleDownload.body);
  const retainedExport = await app.inject({
    url: '/api/v1/artifacts/cpa/export',
    method: 'POST',
    payload: { items: [{ runId: 'session-assets', jobId: 'orphan@example.test-cpa' }] },
  });
  assert.equal(retainedExport.statusCode, 200, retainedExport.body);
  assert.deepEqual(retainedExport.json(), [{ email: asset.email, access_token: 'new-orphan-token' }]);
  await app.close();
});

test('resume API rejects a cancelled terminal run with an actionable conflict', async () => {
  const { cwd, config } = temporaryWorkspace();
  const runId = 'ui-terminal-run';
  const state = makeInitialOrchestratorV2State(config, { cwd, runId });
  state.status = 'cancelled';
  saveV2State(path.join(cwd, config.output.stateDir, `run-${runId}.json`), state);
  const app = buildApp({ cwd });

  const response = await app.inject({
    url: `/api/v1/runs/${runId}/resume`,
    method: 'POST',
    payload: {},
  });

  assert.equal(response.statusCode, 409, response.body);
  assert.equal(response.json().details.code, 'TERMINAL_RUN');
  assert.equal(response.json().details.status, 'cancelled');
  await app.close();
});

test('resume API exposes and restarts a failed OAuth task stopped on a legacy MFA checkpoint', async (t) => {
  const { cwd } = temporaryWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const plan = normalizeRunPlan({
    taskKind: 'oauth', workerConcurrency: 1,
    proxyAssignments: [{ workerSlot: 1, kind: 'local', localProxyId: 'saved-proxy' }],
    oauthSource: { kind: 'session_assets', assetIds: ['asset-mfa-resume'] },
  }, new ConfigService({ cwd }).normalized());
  const applied = applyRunPlan(new ConfigService({ cwd }).normalized(), plan);
  const runId = 'oauth-mfa-failed-resume';
  const state = makeInitialBranchState(applied, plan, { runId });
  state.status = 'failed';
  state.phase = 'failed';
  state.completedAt = '2026-08-06T08:36:52.104Z';
  state.jobs = [{
    id: 'job-mfa-resume', taskKind: 'oauth', email: 'mfa-resume@example.test',
    parentEmail: 'mfa-resume@example.test', mailboxId: 'fastmail:25', laneId: 'asset-mfa-resume',
    assetId: 'asset-mfa-resume', status: 'failed', phase: 'failed',
    error: { code: 'SESSION_ACCESS_TOKEN_MISSING', message: 'NextAuth session did not return accessToken' },
    sessionState: {
      step: 'auth_completed', status: 'running', pageType: 'mfa_challenge',
      continueUrl: 'https://auth.openai.com/mfa-challenge/challenge',
    },
    oauthRecovery: {
      status: 'in_progress', attempts: 1, reason: 'OAUTH_ACCOUNT_SELECT_FAILED',
      lastError: { code: 'SESSION_ACCESS_TOKEN_MISSING', status: 0 },
    },
    sms: { current: null, attempts: [], costUsd: 0 },
  }];
  const stateFile = path.join(applied.output.stateDir, `run-${runId}.json`);
  saveV2State(stateFile, state);
  const app = buildApp({ cwd });
  t.after(() => app.close());
  let launched = null;
  app.services.runManager.launch = (next) => { launched = next; return {}; };

  const detail = await app.inject({ url: `/api/v1/runs/${runId}` });
  assert.equal(detail.statusCode, 200, detail.body);
  assert.equal(detail.json().resumable, true);

  const response = await app.inject({ method: 'POST', url: `/api/v1/runs/${runId}/resume`, payload: {} });
  assert.equal(response.statusCode, 202, response.body);
  assert.equal(launched.status, 'initialized');
  assert.equal(launched.jobs[0].status, 'queued');
  assert.equal(launched.jobs[0].phase, 'resuming_mfa');
  assert.equal(launched.jobs[0].sessionState.step, 'mfa_required');
});

test('resume API migrates a safe legacy existing-account checkpoint before launch', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const plan = normalizeRunPlan({
    taskKind: 'register_oauth',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'plus',
    aliasCount: 1,
    aliasMaxAttempts: 2,
  }, config);
  const applied = applyRunPlan(new ConfigService({ cwd }).normalized(), plan);
  const runId = 'legacy-existing-account-resume';
  const state = makeInitialOrchestratorV2State(applied, { runId });
  state.runPlan = plan;
  state.status = 'waiting';
  state.phase = 'normal';
  state.mailboxes = [{
    id: 'mail-legacy-resume', rootEmail: 'legacy-resume@example.test', status: 'reserved',
    targetCount: 1, maxAttempts: 2, attemptCount: 1, createdCount: 0, cpaCompletedCount: 0,
  }];
  state.jobs = [{
    id: 'job-legacy-resume', mailboxId: 'mail-legacy-resume', parentEmail: 'legacy-resume@example.test',
    email: 'legacy-resume+uiAbCd@example.test', aliasIndex: 1, status: 'waiting', phase: 'blocked_user_register',
    error: { code: 'invalid_auth_step', message: 'Invalid authorization step.' },
    runner: {
      blocked: { step: 'user_register', missing: ['http_400'] },
      lastContinueUrl: 'https://auth.openai.com/log-in/password',
      events: [{ step: 'user_register', status: 400, textPreview: JSON.stringify({ error: { code: 'invalid_auth_step' } }) }],
    },
    sms: { current: null, attempts: [] },
    createdAt: state.createdAt,
  }];
  state.workers = [{ id: 'worker-1', status: 'running', mailboxId: 'mail-legacy-resume' }];
  const stateFile = path.join(cwd, config.output.stateDir, `run-${runId}.json`);
  saveV2State(stateFile, state);

  const app = buildApp({ cwd });
  t.after(() => app.close());
  let launched = null;
  app.services.runManager.launch = (next) => { launched = next; return {}; };
  const response = await app.inject({ method: 'POST', url: `/api/v1/runs/${runId}/resume`, payload: {} });

  assert.equal(response.statusCode, 202, response.body);
  assert.equal(launched.taskKind, 'register_oauth');
  assert.equal(launched.runPlan.taskKind, 'register_oauth');
  assert.equal(launched.jobs[0].status, 'queued');
  assert.equal(launched.jobs[0].sessionState, null);
  assert.equal(launched.events.at(-1).type, 'legacy_register_oauth_migrated');
});

test('711 quick-build route forwards country, count, and protocol to the proxy service', async () => {
  const { cwd } = temporaryWorkspace();
  let received = null;
  const snapshot = { total: 0, local: { total: 0, errors: [], proxies: [] }, dynamic: { total: 0, countryPools: [] }, errors: [], proxies: [] };
  const proxyService = {
    list: () => snapshot,
    buildAndPull711: async (payload) => { received = payload; return snapshot; },
  };
  const app = buildApp({ cwd, proxyService });
  const response = await app.inject({
    url: '/api/v1/proxies/711/build-pull',
    method: 'POST',
    payload: { countryCode: 'US', count: 25, protocol: 'socks5' },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(received, { countryCode: 'US', count: 25, protocol: 'socks5' });
  await app.close();
});

test('generic proxy API quick-build route forwards provider and regional options', async () => {
  const { cwd } = temporaryWorkspace();
  let received = null;
  const snapshot = { total: 0, local: { total: 0, errors: [], proxies: [] }, dynamic: { total: 0, countryPools: [] }, errors: [], proxies: [] };
  const proxyService = {
    list: () => snapshot,
    buildAndPullApi: async (payload) => { received = payload; return snapshot; },
  };
  const app = buildApp({ cwd, proxyService });
  const response = await app.inject({
    url: '/api/v1/proxies/api/build-pull',
    method: 'POST',
    payload: { provider: 'cliproxy', countryCode: 'US', count: 5, protocol: 'http' },
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(received, { provider: 'cliproxy', countryCode: 'US', count: 5, protocol: 'http' });
  await app.close();
});

test('711 quick-build route rejects invalid options before making a provider request', async () => {
  const { cwd } = temporaryWorkspace();
  const configService = new ConfigService({ cwd });
  let fetchCalled = false;
  const proxyService = new ProxyService(configService, {
    fetch: async () => { fetchCalled = true; throw new Error('must not be called'); },
  });
  const app = buildApp({ cwd, proxyService });
  const response = await app.inject({
    url: '/api/v1/proxies/711/build-pull',
    method: 'POST',
    payload: { countryCode: 'USA', count: 0, protocol: 'http' },
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.equal(fetchCalled, false);
  await app.close();
});

test('a push made before the export ledgers were stamped is carried forward once, not on every read', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  config.sub2api = { baseUrl: 'http://127.0.0.1:8080', adminApiKey: 'admin-key' };
  fs.writeFileSync(path.join(cwd, 'gpt-re.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const assetStore = new SessionAssetStore({ cwd, stateDir: config.output.stateDir, cpaDir: config.output.cpaDir });
  t.after(() => assetStore.close());
  const asset = assetStore.upsert({ email: 'legacy@example.test', accountId: 'account-legacy', accessToken: 'at' });
  assetStore.replaceCpa(asset.id, { type: 'codex', email: asset.email, access_token: 'token' }, {});

  const app = buildApp({ cwd, assetStore });
  t.after(() => app.close());
  const listed = (await app.inject({ url: '/api/v1/artifacts/cpa' })).json().artifacts;
  assert.equal(listed.length, 1);

  // Stand in for a push made before the change: only its own ledger is written.
  // Checked through the real predicate rather than the file, which the boot-time
  // retention sweep creates empty regardless.
  const manager = app.services.runManager;
  const records = manager.cpaArtifactRecords();
  manager.markSub2ApiPushes(records, records);
  assert.equal(manager.cpaArtifactExported(records[0], manager.readSub2ApiPushRegistry().entries, 'sub2api_push'), true);
  assert.equal(manager.cpaArtifactExported(records[0], manager.readCpaExportRegistry().entries, 'cpa'), false);
  const exportLedger = path.join(cwd, config.output.stateDir, 'cpa-exports.json');

  // Reading the listing carries it forward: those credentials reached the
  // gateway, so 最新 and 导出未导出 must both stop offering to send them.
  const afterReconcile = (await app.inject({ url: '/api/v1/artifacts/cpa' })).json().artifacts;
  assert.equal(typeof afterReconcile[0].sub2ApiPushedAt, 'string');
  assert.equal(typeof afterReconcile[0].cpaExportedAt, 'string');
  assert.equal(typeof afterReconcile[0].sub2ApiExportedAt, 'string');

  // ...and only once. The console polls this listing every few seconds, so a
  // reconcile that could not tell "already done" from "needs doing" would
  // rewrite and fsync both ledgers forever.
  const stamp = () => fs.statSync(exportLedger).mtimeMs;
  const settled = stamp();
  for (let index = 0; index < 3; index += 1) await app.inject({ url: '/api/v1/artifacts/cpa' });
  assert.equal(stamp(), settled);
});

test('a paused run keeps its task slot, and the capacity snapshot names it', async (t) => {
  const { cwd } = temporaryWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const manager = new RunManager({ cwd, configService: new ConfigService({ cwd }), logStore: { append() {} } });
  const assetStore = manager.sessionAssets();
  t.after(() => assetStore.close());

  // Nothing executing, but a paused run is not terminal, so it holds the one
  // main slot on purpose: displacing it would cost the chance to resume it.
  const config = manager.config();
  const state = makeInitialBranchState(config, normalizeRunPlan({ taskKind: 'register_session', mailCount: 1 }, config), { runId: 'paused-run' });
  state.status = 'paused';
  saveV2State(path.join(cwd, '.state', 'run-paused-run.json'), state);
  manager.activeRuns = () => [];

  const capacity = manager.taskCapacitySnapshot();
  assert.equal(capacity.main.available, 0);
  assert.equal(capacity.main.running, 1);
  // Without this the console has a disabled launch button, an empty running
  // list, and no way to say which run to resume or cancel.
  assert.deepEqual(capacity.main.holders, [{ runId: 'paused-run', status: 'paused', active: false }]);
  assert.equal(capacity.auxiliary.available, capacity.auxiliary.capacity);
  assert.deepEqual(capacity.auxiliary.holders, []);
});

test('the CPA artifact cap keeps the newest 2000 unlocked files', (t) => {
  const { cwd, config } = temporaryWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const cpaDirectory = path.join(cwd, config.output.cpaDir, 'session-assets');
  fs.mkdirSync(cpaDirectory, { recursive: true });
  const baseTime = Date.parse('2026-08-20T00:00:00.000Z');

  // Login-state CPAs belong to an asset rather than a run, so run-history
  // pruning never reaches them — the count cap is the only thing that does.
  // Write the artifact fixtures directly: creating 1010 new assets through
  // upsert would rescan every previous asset on each call and make this
  // retention test O(n^2) on Windows file systems.
  const assetStore = new SessionAssetStore({ cwd, stateDir: config.output.stateDir, cpaDir: config.output.cpaDir });
  t.after(() => assetStore.close());
  const written = [];
  for (let index = 0; index < 2010; index += 1) {
    const email = `cap-${String(index).padStart(3, '0')}@example.test`;
    const filePath = path.join(cpaDirectory, `cap-${String(index).padStart(3, '0')}.json`);
    fs.writeFileSync(filePath, `${JSON.stringify({ type: 'codex', email, access_token: `token-${index}` })}\n`);
    // Oldest first, so the ones that fall off the end are predictable.
    fs.utimesSync(filePath, baseTime / 1000 + index * 60, baseTime / 1000 + index * 60);
    written.push({ email, filePath });
  }

  const manager = new RunManager({ cwd, configService: new ConfigService({ cwd }), logStore: { append() {} }, assetStore });
  manager.pruneCpaArtifactHistory();

  const remaining = written.filter((entry) => fs.existsSync(entry.filePath));
  assert.equal(remaining.length, 2000);
  // The newest survive; the 10 oldest are the ones dropped.
  assert.equal(fs.existsSync(written[9].filePath), false);
  assert.equal(fs.existsSync(written[10].filePath), true);
  assert.equal(fs.existsSync(written[2009].filePath), true);
});

test('a self-use batch can be locked and unlocked without deleting its CPA', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const assetStore = new SessionAssetStore({ cwd, stateDir: config.output.stateDir, cpaDir: config.output.cpaDir });
  t.after(() => assetStore.close());
  const asset = assetStore.upsert({ email: 'locked-self@example.test', accountId: 'locked-account', accessToken: 'at' });
  assetStore.replaceCpa(asset.id, { type: 'codex', email: asset.email, access_token: 'locked-token' }, { runId: 'locked-run', jobId: 'locked-job' });
  assetStore.markLifecycle([asset.id], 'self_use');

  const app = buildApp({ cwd, assetStore });
  t.after(() => app.close());
  const listed = (await app.inject({ url: '/api/v1/artifacts/cpa?reveal=1' })).json().artifacts;
  assert.equal(listed.length, 1);
  const item = { runId: listed[0].runId, jobId: listed[0].jobId, key: listed[0].key };

  const exported = await app.inject({ url: '/api/v1/artifacts/cpa/export', method: 'POST', payload: { items: [item] } });
  assert.equal(exported.statusCode, 200, exported.body);
  const locked = await app.inject({ url: '/api/v1/artifacts/cpa/lock', method: 'POST', payload: { items: [item], batchKey: 'locked-batch' } });
  assert.equal(locked.statusCode, 200, locked.body);
  assert.deepEqual(locked.json().locked, [item]);

  const sourcePath = assetStore.get(asset.id).cpa.path;
  const sourceFile = path.resolve(cwd, config.output.cpaDir, sourcePath);
  const unlocked = await app.inject({ url: '/api/v1/artifacts/cpa/unlock', method: 'POST', payload: { items: [item] } });
  assert.equal(unlocked.statusCode, 200, unlocked.body);
  assert.deepEqual(unlocked.json().unlocked, [item]);
  assert.equal(fs.existsSync(sourceFile), true);
  assert.equal((await app.inject({ url: '/api/v1/artifacts/cpa?reveal=1' })).json().artifacts[0].locked, undefined);

  const relocked = await app.inject({ url: '/api/v1/artifacts/cpa/lock', method: 'POST', payload: { items: [item], batchKey: 'locked-batch' } });
  assert.equal(relocked.statusCode, 200, relocked.body);

  // The source still exists at this point. `locked=0` must exclude the
  // registered snapshot before touching that source, rather than relying on
  // the later cleanup that removes it.
  const unlockedOnly = await app.inject({ url: '/api/v1/artifacts/cpa?reveal=1&locked=0' });
  assert.equal(unlockedOnly.statusCode, 200, unlockedOnly.body);
  assert.deepEqual(unlockedOnly.json().artifacts, []);

  // Replacing the canonical CPA reuses the path but advances its revision;
  // that new version is no longer the locked snapshot and must reappear.
  assetStore.replaceCpa(asset.id, { type: 'codex', email: asset.email, access_token: 'refreshed-token' }, {
    runId: 'refreshed-run',
    jobId: 'refreshed-job',
  });
  const refreshedOnly = await app.inject({ url: '/api/v1/artifacts/cpa?reveal=1&locked=0' });
  assert.equal(refreshedOnly.statusCode, 200, refreshedOnly.body);
  assert.deepEqual(refreshedOnly.json().artifacts.map((artifact) => artifact.jobId), ['refreshed-job']);

  fs.unlinkSync(sourceFile);
  const afterLock = await app.inject({ url: '/api/v1/artifacts/cpa?reveal=1' });
  assert.equal(afterLock.statusCode, 200, afterLock.body);
  assert.equal(afterLock.json().artifacts[0].locked, true);
  assert.equal(afterLock.json().artifacts[0].lockBatchKey, 'locked-batch');

  const refusedExport = await app.inject({ url: '/api/v1/artifacts/cpa/export', method: 'POST', payload: { items: [item] } });
  assert.equal(refusedExport.statusCode, 409, refusedExport.body);
  const refusedDownload = await app.inject({ url: `/api/v1/runs/${item.runId}/cpa/${item.jobId}` });
  assert.equal(refusedDownload.statusCode, 409, refusedDownload.body);
  const refusedRemove = await app.inject({ url: '/api/v1/artifacts/cpa', method: 'DELETE', payload: { items: [item] } });
  assert.equal(refusedRemove.statusCode, 409, refusedRemove.body);

  const manager = app.services.runManager;
  assert.equal(manager.pruneCpaArtifactHistory(), 0);
  assert.equal((await app.inject({ url: '/api/v1/artifacts/cpa?reveal=1' })).json().artifacts.length, 1);
});

test('two CPA files under one run/job pair are two rows, and export as two', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const assetStore = new SessionAssetStore({ cwd, stateDir: config.output.stateDir, cpaDir: config.output.cpaDir });
  t.after(() => assetStore.close());
  // A job's CPA can end up under two mailboxes — a refresh or a rebind moves
  // it — and both files then carry the same runId:jobId. Selecting by that
  // pair collapsed them into one export and left the other marked unexported
  // forever; the file key is what tells them apart.
  const pair = { runId: 'pair-run', jobId: 'pair-job' };
  const emails = ['pair-one@example.test', 'pair-two@example.test'];
  for (const [index, email] of emails.entries()) {
    const asset = assetStore.upsert({ email, accountId: `pair-account-${index}`, accessToken: `at-${index}` });
    assetStore.replaceCpa(asset.id, { type: 'codex', email, access_token: `token-${index}` }, pair);
  }

  const app = buildApp({ cwd, assetStore });
  t.after(() => app.close());
  const listed = (await app.inject({ url: '/api/v1/artifacts/cpa?reveal=1' })).json().artifacts;
  assert.equal(listed.length, 2);
  assert.deepEqual(listed.map((artifact) => artifact.jobId), [pair.jobId, pair.jobId]);
  assert.equal(new Set(listed.map((artifact) => artifact.key)).size, 2);

  const exported = await app.inject({
    url: '/api/v1/artifacts/cpa/export',
    method: 'POST',
    payload: { items: listed.map(({ runId, jobId, key }) => ({ runId, jobId, key })) },
  });
  assert.equal(exported.statusCode, 200, exported.body);
  assert.deepEqual(exported.json().map((account) => account.email).sort(), [...emails].sort());
  const after = (await app.inject({ url: '/api/v1/artifacts/cpa?reveal=1' })).json().artifacts;
  assert.deepEqual(after.filter((artifact) => artifact.cpaExportedAt).map((artifact) => artifact.email).sort(), [...emails].sort());

  // The per-row download link is keyed by the file, so asking for one row
  // returns that one file — not the pair's two merged into an array.
  for (const [index, artifact] of listed.entries()) {
    const single = await app.inject({ url: `/api/v1/artifacts/cpa/download?key=${encodeURIComponent(artifact.key)}` });
    assert.equal(single.statusCode, 200, single.body);
    assert.equal(single.json().email, listed[index].email);
    assert.equal(Array.isArray(single.json()), false);
    assert.equal(single.headers['content-disposition'], `attachment; filename="${artifact.fileName}"`);
  }
  const unknown = await app.inject({ url: '/api/v1/artifacts/cpa/download?key=missing.json' });
  assert.equal(unknown.statusCode, 404);

  // The bare pair stays addressable for a client that predates the key. It is
  // ambiguous by construction, so it resolves to one of the two files rather
  // than to both.
  const legacy = await app.inject({
    url: '/api/v1/artifacts/cpa/export',
    method: 'POST',
    payload: { items: [{ runId: pair.runId, jobId: pair.jobId }] },
  });
  assert.equal(legacy.statusCode, 200, legacy.body);
  assert.equal(legacy.json().length, 1);
});

test('run history keeps the newest 60 entries and protects live or resumable CPA artifacts', (t) => {
  const { cwd, config } = temporaryWorkspace();
  const stateDirectory = path.join(cwd, config.output.stateDir);
  const cpaDirectory = path.join(cwd, config.output.cpaDir);
  const baseTime = Date.parse('2026-08-20T00:00:00.000Z');
  const removedLogs = [];

  const writeRun = (state, index, jobStatus = state.status, jobOverrides = {}) => {
    const runId = state.runId;
    const jobId = `${runId}-job`;
    const relativeCpaPath = path.posix.join(runId, 'accounts', `${jobId}.json`);
    const artifactPath = path.join(cpaDirectory, runId, 'accounts', `${jobId}.json`);
    const at = new Date(baseTime + index * 60 * 1000).toISOString();
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    fs.writeFileSync(artifactPath, `${JSON.stringify({ email: `${runId}@example.test`, access_token: runId })}\n`);
    fs.utimesSync(artifactPath, baseTime / 1000 + index * 60, baseTime / 1000 + index * 60);
    state.createdAt = at;
    state.updatedAt = at;
    state.completedAt = TERMINAL_RUN_STATUSES.has(state.status) ? at : '';
    state.jobs = [{
      id: jobId,
      email: `${runId}@example.test`,
      status: jobStatus,
      phase: jobStatus,
      cpaPath: relativeCpaPath,
      ...jobOverrides,
    }];
    const statePath = path.join(stateDirectory, `run-${runId}.json`);
    saveV2State(statePath, state);
    return { statePath, artifactPath };
  };

  const terminalRuns = [];
  for (let index = 0; index < 65; index += 1) {
    const runId = `history-run-${String(index).padStart(3, '0')}`;
    const state = makeInitialOrchestratorV2State(config, { cwd, runId });
    state.status = 'complete';
    terminalRuns.push({ runId, ...writeRun(state, index) });
  }

  const activeRunId = 'history-active-run';
  const activeState = makeInitialOrchestratorV2State(config, { cwd, runId: activeRunId });
  activeState.status = 'running';
  const active = writeRun(activeState, 100, 'running');

  const plan = normalizeRunPlan({ taskKind: 'register_session', mailCount: 1, workerConcurrency: 1 }, config);
  const resumableRunId = 'history-resumable-run';
  const resumableState = makeInitialBranchState(config, plan, { cwd, runId: resumableRunId });
  resumableState.status = 'failed';
  resumableState.phase = 'failed';
  const resumable = writeRun(resumableState, 101, 'partial', {
    assetId: 'asset-resumable-history',
    sessionState: { security: { passwordStatus: 'retry_pending' } },
  });

  const manager = new RunManager({
    cwd,
    configService: new ConfigService({ cwd }),
    logStore: { append() {}, remove(runId) { removedLogs.push(runId); } },
  });
  t.after(async () => { await manager.shutdown(); fs.rmSync(cwd, { recursive: true, force: true }); });

  const retainedHistory = manager.stateFiles()
    .map((file) => manager.cachedState(file).runId)
    .filter((runId) => runId.startsWith('history-run-'))
    .sort();
  assert.deepEqual(retainedHistory, Array.from({ length: 60 }, (_unused, index) => `history-run-${String(index + 5).padStart(3, '0')}`));
  assert.equal(fs.existsSync(terminalRuns[0].statePath), false);
  assert.equal(fs.existsSync(terminalRuns[4].artifactPath), false);
  assert.equal(fs.existsSync(terminalRuns[5].statePath), true);
  assert.equal(fs.existsSync(terminalRuns[5].artifactPath), true);
  assert.equal(fs.existsSync(active.statePath), true);
  assert.equal(fs.existsSync(active.artifactPath), true);
  assert.equal(fs.existsSync(resumable.statePath), true);
  assert.equal(fs.existsSync(resumable.artifactPath), true);

  const artifacts = manager.cpaArtifacts();
  assert.equal(artifacts.filter((artifact) => artifact.runId.startsWith('history-run-')).length, 60);
  assert.equal(artifacts.find((artifact) => artifact.runId === activeRunId).deletable, false);
  assert.equal(artifacts.find((artifact) => artifact.runId === resumableRunId).deletable, false);
  assert.deepEqual(removedLogs.sort(), terminalRuns.slice(0, 5).map((run) => run.runId).sort());
});

test('CPA artifact API lists, exports, downloads, and batch-cleans retained files', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const runId = 'ui-artifact-test';
  const jobId = 'job-artifact-test';
  const otherRunId = 'ui-artifact-other';
  const otherJobId = 'job-artifact-other';
  const state = makeInitialOrchestratorV2State(config, { cwd, runId });
  const artifactPath = path.join(cwd, config.output.cpaDir, runId, 'accounts', `${jobId}.json`);
  const otherArtifactPath = path.join(cwd, config.output.cpaDir, otherRunId, 'accounts', `${otherJobId}.json`);
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.mkdirSync(path.dirname(otherArtifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, `${JSON.stringify({ email: 'artifact@example.test', access_token: 'artifact-token' })}\n`);
  fs.writeFileSync(otherArtifactPath, `${JSON.stringify({ email: 'other@example.test', access_token: 'other-token' })}\n`);
  state.status = 'complete';
  state.jobs = [{
    id: jobId,
    email: 'artifact@example.test',
    aliasIndex: 1,
    status: 'complete',
    phase: 'complete',
    branch: 'registration',
    accountCreatedAt: '2026-08-05T00:00:00.000Z',
    cpaPath: artifactPath,
    sms: { current: null, attempts: [] },
  }];
  saveV2State(path.join(cwd, config.output.stateDir, `run-${runId}.json`), state);

  const app = buildApp({ cwd });
  const listed = await app.inject({ url: '/api/v1/artifacts/cpa' });
  assert.equal(listed.statusCode, 200, listed.body);
  assert.equal(listed.json().artifacts.length, 2);
  const listedArtifact = listed.json().artifacts.find((artifact) => artifact.runId === runId);
  assert.equal(listedArtifact.email, 'a***@example.test');
  assert.equal(listedArtifact.deletable, true);

  // The console asks for the real addresses, the same way it does for the run
  // detail and the log stream. The alias is the only thing that says which
  // account a CPA file belongs to, so a masked list cannot be matched to a
  // mailbox — and masking at record construction had put `a***@…` into the
  // export and push paths too, not just the display.
  const revealed = await app.inject({ url: '/api/v1/artifacts/cpa?reveal=1' });
  assert.equal(revealed.statusCode, 200, revealed.body);
  const revealedArtifact = revealed.json().artifacts.find((artifact) => artifact.runId === runId);
  assert.equal(revealedArtifact.email, 'artifact@example.test');

  const historyRemoved = await app.inject({
    url: '/api/v1/runs',
    method: 'DELETE',
    payload: { runIds: [runId], artifacts: false },
  });
  assert.equal(historyRemoved.statusCode, 200, historyRemoved.body);
  assert.equal(historyRemoved.json().removed.length, 1);
  assert.equal(fs.existsSync(artifactPath), true);
  const orphaned = await app.inject({ url: '/api/v1/artifacts/cpa' });
  assert.equal(orphaned.json().artifacts.length, 2);
  assert.equal(orphaned.json().artifacts.find((artifact) => artifact.runId === runId).runStatus, 'archived');
  assert.equal(orphaned.json().artifacts.every((artifact) => artifact.deletable), true);

  const downloadedRun = await app.inject({ url: `/api/v1/runs/${runId}/cpa` });
  assert.equal(downloadedRun.statusCode, 200, downloadedRun.body);
  assert.equal(downloadedRun.json().access_token, 'artifact-token');
  const afterRunDownload = (await app.inject({ url: '/api/v1/artifacts/cpa' })).json().artifacts;
  assert.equal(afterRunDownload.find((artifact) => artifact.runId === runId).cpaExportedAt !== undefined, true);
  assert.equal(afterRunDownload.find((artifact) => artifact.runId === otherRunId).cpaExportedAt, undefined);

  const exported = await app.inject({ url: '/api/v1/artifacts/cpa/export' });
  assert.equal(exported.statusCode, 200, exported.body);
  assert.equal(exported.json().length, 2);
  assert.match(downloadName(exported), /^CPA-已OAuth-\d+个-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/);
  const afterAllExport = await app.inject({ url: '/api/v1/artifacts/cpa' });
  assert.equal(afterAllExport.json().artifacts.every((artifact) => typeof artifact.cpaExportedAt === 'string'), true);
  assert.equal(afterAllExport.json().artifacts.every((artifact) => !artifact.sub2ApiExportedAt), true);

  const exportedRuns = await app.inject({
    url: '/api/v1/artifacts/cpa/export',
    method: 'POST',
    payload: { runIds: [runId] },
  });
  assert.equal(exportedRuns.statusCode, 200, exportedRuns.body);
  assert.deepEqual(exportedRuns.json(), [{ email: 'artifact@example.test', access_token: 'artifact-token' }]);

  // An explicit selection can still be made from a stale page, so the caller
  // can require the server-side ledger check instead of trusting its snapshot.
  const repeatedSelection = await app.inject({
    url: '/api/v1/artifacts/cpa/export',
    method: 'POST',
    payload: { items: [{ runId, jobId }], unexportedOnly: true },
  });
  assert.equal(repeatedSelection.statusCode, 409, repeatedSelection.body);

  const exportedItems = await app.inject({
    url: '/api/v1/artifacts/cpa/export',
    method: 'POST',
    payload: { items: [{ runId: otherRunId, jobId: otherJobId }] },
  });
  assert.equal(exportedItems.statusCode, 200, exportedItems.body);
  assert.deepEqual(exportedItems.json(), [{ email: 'other@example.test', access_token: 'other-token' }]);

  fs.appendFileSync(otherArtifactPath, ' ');
  const afterReplacement = await app.inject({ url: '/api/v1/artifacts/cpa' });
  const replacedArtifact = afterReplacement.json().artifacts.find((artifact) => artifact.runId === otherRunId);
  assert.equal(replacedArtifact.cpaExportedAt, undefined);

  // `unexported` is resolved from the server's own ledger rather than a list the
  // console assembled, so the rewritten artifact — and only it — comes back.
  const exportedNew = await app.inject({
    url: '/api/v1/artifacts/cpa/export',
    method: 'POST',
    payload: { unexported: true },
  });
  assert.equal(exportedNew.statusCode, 200, exportedNew.body);
  assert.deepEqual(exportedNew.json(), [{ email: 'other@example.test', access_token: 'other-token' }]);
  // Exporting it marks it, so a second pass has nothing left to send.
  const exhausted = await app.inject({
    url: '/api/v1/artifacts/cpa/export',
    method: 'POST',
    payload: { unexported: true },
  });
  assert.equal(exhausted.statusCode, 404, exhausted.body);
  // One request may carry a 1000-account sale; the cap is checked before any
  // entry is resolved, so these placeholder references only exercise the bound.
  const tooMany = await app.inject({
    url: '/api/v1/artifacts/cpa/export',
    method: 'POST',
    payload: { items: Array.from({ length: 1001 }, (_, index) => ({ runId, jobId: `job-${index}` })) },
  });
  assert.equal(tooMany.statusCode, 400, tooMany.body);
  assert.match(tooMany.body, /At most 1000 entries/);
  const atCap = await app.inject({
    url: '/api/v1/artifacts/cpa/export',
    method: 'POST',
    payload: { items: Array.from({ length: 1000 }, (_, index) => ({ runId, jobId: `job-${index}` })) },
  });
  assert.doesNotMatch(atCap.body, /At most/);
  // sub2api reads its own ledger, so the CPA export above did not consume its
  // unexported set: this selection still resolves. (It then fails on conversion
  // because these fixtures carry placeholder tokens rather than real JWTs —
  // a 404 here would mean the ledgers had been shared.)
  const newSub2Api = await app.inject({
    url: '/api/v1/artifacts/cpa/sub2api',
    method: 'POST',
    payload: { unexported: true },
  });
  assert.notEqual(newSub2Api.statusCode, 404, newSub2Api.body);
  const mixedSelection = await app.inject({
    url: '/api/v1/artifacts/cpa/export',
    method: 'POST',
    payload: { unexported: true, runIds: [runId] },
  });
  assert.equal(mixedSelection.statusCode, 400, mixedSelection.body);

  const ambiguousExport = await app.inject({
    url: '/api/v1/artifacts/cpa/export',
    method: 'POST',
    payload: { runIds: [runId], items: [{ runId, jobId }] },
  });
  assert.equal(ambiguousExport.statusCode, 400, ambiguousExport.body);

  const downloaded = await app.inject({ url: `/api/v1/runs/${runId}/cpa/${jobId}` });
  assert.equal(downloaded.statusCode, 200, downloaded.body);
  assert.equal(downloaded.json().access_token, 'artifact-token');

  const removed = await app.inject({
    url: '/api/v1/artifacts/cpa',
    method: 'DELETE',
    payload: { items: [{ runId, jobId }, { runId: otherRunId, jobId: otherJobId }] },
  });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal(removed.json().removed.length, 2);
  assert.equal(fs.existsSync(artifactPath), false);
  assert.deepEqual((await app.inject({ url: '/api/v1/artifacts/cpa' })).json().artifacts, []);
  await app.close();
});

test('selected CPA credential export writes one email-password-2FA line and marks the CPA exported', async (t) => {
  const { cwd } = temporaryWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const app = buildApp({ cwd });
  const store = app.services.runManager.sessionAssets();
  const first = store.upsert({
    email: 'credential-one@example.test',
    password: 'password-one-fixture',
    totpSecret: 'TOTP-ONE-FIXTURE',
    status: 'valid',
  });
  const second = store.upsert({
    email: 'credential-two@example.test',
    password: 'password-two-fixture',
    totpSecret: 'TOTP-TWO-FIXTURE',
    status: 'valid',
  });
  store.replaceCpa(first.id, { email: first.email, access_token: 'token-one-fixture' }, {
    runId: 'credential-export-run',
    jobId: 'credential-export-one',
  });
  store.replaceCpa(second.id, { email: second.email, access_token: 'token-two-fixture' }, {
    runId: 'credential-export-run',
    jobId: 'credential-export-two',
  });

  const exported = await app.inject({
    url: '/api/v1/artifacts/cpa/credentials',
    method: 'POST',
    payload: {
      items: [
        { runId: 'credential-export-run', jobId: 'credential-export-one' },
        { runId: 'credential-export-run', jobId: 'credential-export-two' },
      ],
    },
  });
  assert.equal(exported.statusCode, 200, exported.body);
  assert.equal(exported.headers['content-type'], 'text/plain; charset=utf-8');
  assert.match(downloadName(exported), /^凭证-已OAuth-\d+个-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.txt$/);
  assert.equal(exported.body, 'credential-one@example.test----password-one-fixture----TOTP-ONE-FIXTURE\ncredential-two@example.test----password-two-fixture----TOTP-TWO-FIXTURE\n');

  const listed = (await app.inject({ url: '/api/v1/artifacts/cpa' })).json().artifacts;
  assert.equal(typeof listed.find((artifact) => artifact.jobId === 'credential-export-one').cpaExportedAt, 'string');
  assert.equal(typeof listed.find((artifact) => artifact.jobId === 'credential-export-two').cpaExportedAt, 'string');

  const emptySelection = await app.inject({
    url: '/api/v1/artifacts/cpa/credentials',
    method: 'POST',
    payload: {},
  });
  assert.equal(emptySelection.statusCode, 400, emptySelection.body);

  const incomplete = store.upsert({
    email: 'credential-incomplete@example.test',
    password: 'password-incomplete-fixture',
    status: 'valid',
  });
  store.replaceCpa(incomplete.id, { email: incomplete.email, access_token: 'token-incomplete-fixture' }, {
    runId: 'credential-export-run',
    jobId: 'credential-export-incomplete',
  });
  const rejected = await app.inject({
    url: '/api/v1/artifacts/cpa/credentials',
    method: 'POST',
    payload: { items: [{ runId: 'credential-export-run', jobId: 'credential-export-incomplete' }] },
  });
  assert.equal(rejected.statusCode, 422, rejected.body);
  assert.match(rejected.body, /missing 2FA/);
  assert.equal((await app.inject({ url: '/api/v1/artifacts/cpa' })).json().artifacts.find((artifact) => artifact.jobId === 'credential-export-incomplete').cpaExportedAt, undefined);
  await app.close();
});

test('CPA export caps the actual retained artifacts selected by one run at 1000', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  const runId = 'bulk-export-run';
  const accountsDirectory = path.join(cwd, config.output.cpaDir, runId, 'accounts');
  fs.mkdirSync(accountsDirectory, { recursive: true });
  for (let index = 0; index < 1001; index += 1) {
    const jobId = `job-${String(index).padStart(4, '0')}`;
    fs.writeFileSync(
      path.join(accountsDirectory, `${jobId}.json`),
      `${JSON.stringify({ email: `bulk-${index}@example.test`, access_token: `token-${index}` })}\n`,
    );
  }
  const app = buildApp({ cwd });
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  t.after(() => app.close());

  const response = await app.inject({
    url: '/api/v1/artifacts/cpa/export',
    method: 'POST',
    payload: { runIds: [runId] },
  });
  assert.equal(response.statusCode, 400, response.body);
  assert.match(response.body, /at most 1000/i);

  const runDownload = await app.inject({ url: `/api/v1/runs/${runId}/cpa` });
  assert.equal(runDownload.statusCode, 400, runDownload.body);
  assert.match(runDownload.body, /at most 1000/i);

  fs.unlinkSync(path.join(accountsDirectory, 'job-1000.json'));
  const atCap = await app.inject({
    url: '/api/v1/artifacts/cpa/export',
    method: 'POST',
    payload: { runIds: [runId] },
  });
  assert.equal(atCap.statusCode, 200, atCap.body);
  assert.equal(atCap.json().length, 1000);
});

test('CPA export rejects identity mismatches and duplicate account references', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  const app = buildApp({ cwd });
  const store = app.services.runManager.sessionAssets();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  t.after(() => app.close());

  const mismatch = store.upsert({
    email: 'login-state@example.test',
    accountId: 'login-state-account',
    password: 'password-fixture',
    totpSecret: 'TOTP-FIXTURE',
  });
  const mismatchCpa = store.replaceCpa(mismatch.id, {
    email: 'different-account@example.test',
    account_id: 'login-state-account',
    access_token: 'token-fixture',
  }, { runId: 'identity-export-run', jobId: 'identity-export-job' });
  const mismatchItem = { runId: 'identity-export-run', jobId: 'identity-export-job' };

  const rejectedArchive = await app.inject({
    url: '/api/v1/artifacts/cpa/sub2api/archive',
    method: 'POST',
    payload: { items: [mismatchItem] },
  });
  assert.equal(rejectedArchive.statusCode, 422, rejectedArchive.body);
  assert.match(rejectedArchive.body, /does not match artifact metadata/i);

  // The failed archive must release its reservation, so the next validation
  // reports the identity problem rather than a stale "already in progress".
  const rejectedCredentials = await app.inject({
    url: '/api/v1/artifacts/cpa/credentials',
    method: 'POST',
    payload: { items: [mismatchItem] },
  });
  assert.equal(rejectedCredentials.statusCode, 422, rejectedCredentials.body);
  assert.match(rejectedCredentials.body, /does not match artifact metadata/i);

  fs.writeFileSync(mismatchCpa.filePath, `${JSON.stringify({
    email: mismatch.email,
    account_id: mismatch.accountId,
    access_token: jwt({
      exp: 1_900_000_000,
      'https://api.openai.com/auth': { chatgpt_account_id: mismatch.accountId },
    }),
    id_token: jwt({ email: mismatch.email }),
  })}\n`);
  const fixedArchive = await app.inject({
    url: '/api/v1/artifacts/cpa/sub2api/archive',
    method: 'POST',
    payload: { items: [mismatchItem] },
  });
  assert.equal(fixedArchive.statusCode, 200, fixedArchive.body);

  const first = store.upsert({
    email: 'duplicate-one@example.test',
    accountId: 'shared-account-id',
  });
  const second = store.upsert({
    email: 'duplicate-two@example.test',
    accountId: 'different-account-id',
  });
  store.update(second.id, { accountId: 'shared-account-id' });
  store.replaceCpa(first.id, {
    email: first.email,
    account_id: 'shared-account-id',
    access_token: 'token-one',
  }, { runId: 'duplicate-export-run', jobId: 'duplicate-one' });
  store.replaceCpa(second.id, {
    email: second.email,
    account_id: 'shared-account-id',
    access_token: 'token-two',
  }, { runId: 'duplicate-export-run', jobId: 'duplicate-two' });
  const duplicateItems = {
    items: [
      { runId: 'duplicate-export-run', jobId: 'duplicate-one' },
      { runId: 'duplicate-export-run', jobId: 'duplicate-two' },
    ],
  };
  const duplicateCpa = await app.inject({
    url: '/api/v1/artifacts/cpa/export',
    method: 'POST',
    payload: duplicateItems,
  });
  assert.equal(duplicateCpa.statusCode, 409, duplicateCpa.body);
  assert.match(duplicateCpa.body, /same account/i);
  const duplicateCredentials = await app.inject({
    url: '/api/v1/artifacts/cpa/credentials',
    method: 'POST',
    payload: duplicateItems,
  });
  assert.equal(duplicateCredentials.statusCode, 409, duplicateCredentials.body);
  assert.match(duplicateCredentials.body, /same account/i);
});

test('CPA artifact API marks retained Plus OAuth artifacts', async (t) => {
  const { cwd } = temporaryWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const app = buildApp({ cwd });
  const store = app.services.runManager.sessionAssets();
  const asset = store.upsert({
    email: 'plus-artifact@example.test',
    planType: 'plus',
    accountId: 'plus-artifact-account',
    status: 'valid',
  });
  const saved = store.replaceCpa(asset.id, { email: asset.email, access_token: 'plus-artifact-token' }, {
    runId: 'plus-artifact-run',
    jobId: 'plus-artifact-job',
  });

  const listed = await app.inject({ url: '/api/v1/artifacts/cpa' });
  assert.equal(listed.statusCode, 200, listed.body);
  const record = listed.json().artifacts.find((artifact) => artifact.fileName === path.basename(saved.filePath));
  assert.equal(record.isPlus, true);
  assert.equal(record.cpaExportedAt, undefined);
  assert.equal(record.sub2ApiExportedAt, undefined);
  await app.close();
});

test('CPA artifact API carries the registration country of each account', async (t) => {
  const { cwd } = temporaryWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const app = buildApp({ cwd });
  const store = app.services.runManager.sessionAssets();
  const indian = store.upsert({
    email: 'india-artifact@example.test',
    accountId: 'india-artifact-account',
    status: 'valid',
    sourceProxy: { id: 'pool-in', countryCode: 'in', resourceKind: 'countryPool' },
  });
  const unknown = store.upsert({ email: 'nowhere-artifact@example.test', accountId: 'nowhere-account', status: 'valid' });
  const savedIndian = store.replaceCpa(indian.id, { email: indian.email, access_token: 'india-token' }, { runId: 'country-run', jobId: 'india-job' });
  const savedUnknown = store.replaceCpa(unknown.id, { email: unknown.email, access_token: 'nowhere-token' }, { runId: 'country-run', jobId: 'nowhere-job' });

  const listed = await app.inject({ url: '/api/v1/artifacts/cpa' });
  assert.equal(listed.statusCode, 200, listed.body);
  const byFile = new Map(listed.json().artifacts.map((artifact) => [artifact.fileName, artifact]));
  assert.equal(byFile.get(path.basename(savedIndian.filePath)).registrationCountry, 'IN');
  assert.equal(byFile.get(path.basename(savedUnknown.filePath)).registrationCountry, '');
  await app.close();
});

test('the gateway error set merges both of sub2api\'s error signals and carries the counts that explain an empty one', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  config.sub2api = { baseUrl: 'http://127.0.0.1:8080', adminApiKey: 'admin-key' };
  fs.writeFileSync(path.join(cwd, 'gpt-re.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  // Two accounts are broken in the two different ways sub2api expresses it:
  // one carries the `error` status and one only an `error_message`. Neither
  // needs its own request — `?status=error` is a plain match on the stored
  // column, so those rows are already in the scan.
  const rows = [
    { id: 1, name: 'flagged@example.test', status: 'error', credentials: { email: 'flagged@example.test' }, error_message: 'token revoked' },
    { id: 2, name: 'messaged@example.test', status: 'active', credentials: { email: 'messaged@example.test' }, error_message: 'refresh failed' },
    { id: 3, name: 'fine@example.test', status: 'active', credentials: { email: 'fine@example.test' }, error_message: '' },
  ];
  const calls = [];
  const app = buildApp({
    cwd,
    sub2ApiFetch: async (url, init) => {
      calls.push({ url, method: init?.method || 'GET' });
      const parsed = new URL(url);
      if (parsed.pathname === '/api/v1/admin/accounts') {
        const status = parsed.searchParams.get('status') || '';
        const pageSize = Number(parsed.searchParams.get('page_size') || 0);
        const items = status === 'error' ? rows.filter((row) => row.status === 'error') : (status ? [] : rows);
        return {
          ok: true,
          status: 200,
          json: async () => ({ code: 0, data: { items: pageSize === 1 ? [] : items, total: items.length, page: 1, page_size: pageSize } }),
        };
      }
      if (parsed.pathname === '/api/v1/admin/accounts/batch-delete') {
        return { ok: true, status: 200, json: async () => ({ code: 0, data: { deleted: 2, errors: [] } }) };
      }
      return { ok: false, status: 404, json: async () => ({ message: `unexpected ${parsed.pathname}` }) };
    },
  });
  t.after(() => app.close());

  const failed = await app.inject({ url: '/api/v1/sub2api/accounts/failed' });
  assert.equal(failed.statusCode, 200, failed.body);
  const body = failed.json();
  assert.deepEqual(body.accounts.map((account) => account.email), ['flagged@example.test', 'messaged@example.test']);
  assert.deepEqual(body.accounts.map((account) => account.id), [1, 2]);
  assert.equal(body.accounts[0].reason, 'token revoked');
  assert.equal(body.truncated, false);
  // The counts come from the derived-status filters, which is the whole point:
  // an account row can say `active` while the gateway does not schedule it.
  // Only the two the console renders are asked for; `total` rides along on the
  // scan, and the error count is the length of the list itself.
  assert.equal(body.breakdown.total, rows.length);
  assert.deepEqual(Object.keys(body.breakdown).sort(), ['active', 'rate_limited', 'total']);
  // One scan plus one count per rendered status, and no separate error page.
  const reads = calls.filter((call) => call.method === 'GET');
  assert.equal(reads.length, 3, JSON.stringify(reads));
  assert.ok(reads.some((call) => call.url.includes('status=rate_limited')), JSON.stringify(reads));
  assert.ok(!reads.some((call) => call.url.includes('status=error')), JSON.stringify(reads));
  // The scan asks for the compact rows: half the payload, same fields.
  assert.ok(reads.some((call) => call.url.includes('lite=1')), JSON.stringify(reads));

  const removed = await app.inject({ url: '/api/v1/sub2api/accounts', method: 'DELETE', payload: { accountIds: [1, 2] } });
  assert.equal(removed.statusCode, 200, removed.body);
  assert.equal(removed.json().deleted, 2);
  const deleteCall = calls.find((call) => call.url.endsWith('/accounts/batch-delete'));
  assert.equal(deleteCall?.method, 'POST');

  // Deleting nothing is a mistake worth refusing rather than a no-op round trip.
  const empty = await app.inject({ url: '/api/v1/sub2api/accounts', method: 'DELETE', payload: { accountIds: [] } });
  assert.equal(empty.statusCode, 400, empty.body);
});

test('a gateway that is not running is 503 on the error set, not a failed read', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  config.sub2api = { baseUrl: 'http://127.0.0.1:8080', adminApiKey: 'admin-key' };
  fs.writeFileSync(path.join(cwd, 'gpt-re.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const app = buildApp({
    cwd,
    sub2ApiFetch: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); },
  });
  t.after(() => app.close());
  const offline = await app.inject({ url: '/api/v1/sub2api/accounts/failed' });
  assert.equal(offline.statusCode, 503, offline.body);
});

test('a push files its accounts into the configured gateway group, and refuses to guess when the name is wrong', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  config.sub2api = { baseUrl: 'http://127.0.0.1:8080', adminApiKey: 'admin-key', groupName: 'openai' };
  fs.writeFileSync(path.join(cwd, 'gpt-re.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const assetStore = new SessionAssetStore({ cwd, stateDir: config.output.stateDir, cpaDir: config.output.cpaDir });
  t.after(() => assetStore.close());
  const asset = assetStore.upsert({ email: 'grouped@example.test', accountId: 'account-grouped', accessToken: 'at' });
  assetStore.replaceCpa(asset.id, {
    type: 'codex',
    access_token: jwt({ exp: 1_900_000_000, 'https://api.openai.com/auth': { chatgpt_account_id: 'account-grouped' } }),
    id_token: jwt({ email: 'grouped@example.test' }),
    email: 'grouped@example.test',
  }, { runId: 'group-run', jobId: 'group-job' });

  // The gateway's group is called `openai`. sub2api only auto-files an import
  // into a group named `<platform>-default`, so without the configured name the
  // accounts would land ungrouped and unschedulable.
  let groups = [{ id: 2, name: 'openai', platform: 'openai' }];
  const imports = [];
  const app = buildApp({
    cwd,
    assetStore,
    sub2ApiFetch: async (url, init) => {
      const parsed = new URL(url);
      if (parsed.pathname === '/api/v1/admin/groups') {
        return { ok: true, status: 200, json: async () => ({ code: 0, data: { items: groups, total: groups.length } }) };
      }
      if (parsed.pathname === '/api/v1/admin/accounts/import/codex-session') {
        imports.push(JSON.parse(init.body));
        return { ok: true, status: 200, json: async () => ({ code: 0, data: { total: 1, created: 1, updated: 0, skipped: 0, failed: 0 } }) };
      }
      return { ok: true, status: 200, json: async () => ({ code: 0, data: { items: [], total: 0 } }) };
    },
  });
  t.after(() => app.close());
  const listed = (await app.inject({ url: '/api/v1/artifacts/cpa' })).json().artifacts;
  const payload = { items: [{ runId: listed[0].runId, jobId: listed[0].jobId }] };

  const pushed = await app.inject({ url: '/api/v1/artifacts/cpa/sub2api/push', method: 'POST', payload });
  assert.equal(pushed.statusCode, 200, pushed.body);
  assert.equal(imports.length, 1);
  assert.deepEqual(imports[0].group_ids, [2]);
  // `update_existing` plus the group ids is what rehomes an account imported
  // before the group was configured, rather than only touching new ones.
  assert.equal(imports[0].update_existing, true);

  // A name that matches nothing is an error, not a silent push into limbo —
  // that outcome is the whole reason the setting exists.
  groups = [{ id: 5, name: 'anthropic', platform: 'anthropic' }];
  const wrong = await app.inject({ url: '/api/v1/artifacts/cpa/sub2api/push', method: 'POST', payload });
  assert.equal(wrong.statusCode, 400, wrong.body);
  assert.match(wrong.json().message, /openai/);
  assert.match(wrong.json().message, /anthropic/);
  assert.equal(imports.length, 1, 'a failed group lookup must not send the accounts anyway');
});

test('pushing to sub2api sends CPA records verbatim, then files them as self-use', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  config.sub2api = { baseUrl: 'http://127.0.0.1:8080', adminApiKey: 'admin-key' };
  fs.writeFileSync(path.join(cwd, 'gpt-re.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const assetStore = new SessionAssetStore({ cwd, stateDir: config.output.stateDir, cpaDir: config.output.cpaDir });
  t.after(() => assetStore.close());
  const asset = assetStore.upsert({ email: 'self@example.test', accountId: 'account-self', accessToken: 'at' });
  const record = {
    type: 'codex',
    access_token: jwt({
      exp: 1_900_000_000,
      'https://api.openai.com/auth': { chatgpt_account_id: 'account-self', chatgpt_user_id: 'user-self' },
    }),
    id_token: jwt({ email: 'self@example.test' }),
    refresh_token: 'refresh-self',
    account_id: 'account-self',
    email: 'self@example.test',
  };
  assetStore.replaceCpa(asset.id, record, { runId: 'push-run', jobId: 'push-job' });

  const calls = [];
  const app = buildApp({
    cwd,
    assetStore,
    sub2ApiFetch: async (url, init) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 0, data: { total: 1, created: 1, updated: 0, skipped: 0, failed: 0 } }),
      };
    },
  });
  t.after(() => app.close());

  const listed = (await app.inject({ url: '/api/v1/artifacts/cpa' })).json().artifacts;
  assert.equal(listed.length, 1, JSON.stringify(listed));
  const item = { runId: listed[0].runId, jobId: listed[0].jobId };

  const pushed = await app.inject({ url: '/api/v1/artifacts/cpa/sub2api/push', method: 'POST', payload: { items: [item] } });
  assert.equal(pushed.statusCode, 200, pushed.body);
  assert.deepEqual(pushed.json().classified, [asset.id]);
  assert.equal(pushed.json().pushed, 1);

  // The gateway's Codex importer reads `access_token`/`id_token`/`email` off
  // the entry itself, so the CPA record goes over the wire unwrapped — the
  // sub2api *document* shape would bury them under `credentials`.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://127.0.0.1:8080/api/v1/admin/accounts/import/codex-session');
  assert.equal(calls[0].init.headers['x-api-key'], 'admin-key');
  const sent = JSON.parse(calls[0].init.body);
  assert.equal(sent.update_existing, true);
  assert.deepEqual(JSON.parse(sent.content), [record]);

  // A push is a classification: the account is now one we run ourselves, and
  // that shows on the login-state page without a second click.
  assert.equal(assetStore.get(asset.id).lifecycle, 'self_use');
  // ...and self-use is still working inventory, so it keeps a next action.
  assert.notEqual(assetStore.get(asset.id, { raw: false }).nextAction, 'none');
  const afterPush = (await app.inject({ url: '/api/v1/artifacts/cpa' })).json().artifacts;
  // Delivered: the push has its own ledger, and it also stamps the export ones,
  // because credentials that reached the gateway have left this machine and
  // 导出未导出 must stop offering to send them again.
  assert.equal(typeof afterPush[0].sub2ApiPushedAt, 'string');
  assert.equal(typeof afterPush[0].cpaExportedAt, 'string');
  assert.equal(typeof afterPush[0].sub2ApiExportedAt, 'string');
  // One push is one delivery: all three ledgers carry the same stamp.
  assert.equal(afterPush[0].cpaExportedAt, afterPush[0].sub2ApiPushedAt);
  assert.equal(afterPush[0].sub2ApiExportedAt, afterPush[0].sub2ApiPushedAt);

  // A push split into several requests shares the console's stamp, so the
  // history shows it as one batch rather than one group per 25 accounts.
  const deliveryAt = '2026-10-09T05:46:00.000Z';
  const batched = await app.inject({ url: '/api/v1/artifacts/cpa/sub2api/push', method: 'POST', payload: { items: [item], deliveryAt } });
  assert.equal(batched.statusCode, 200, batched.body);
  const afterBatched = (await app.inject({ url: '/api/v1/artifacts/cpa' })).json().artifacts;
  assert.equal(afterBatched[0].sub2ApiPushedAt, deliveryAt);
  assert.equal(afterBatched[0].cpaExportedAt, deliveryAt);
  assert.equal(afterBatched[0].sub2ApiExportedAt, deliveryAt);

  // A sold account keeps its sale record even if its CPA is pushed again: the
  // completed sale is the one assertion self-use must not overwrite.
  assetStore.markLifecycle([asset.id], 'sold');
  const resold = await app.inject({ url: '/api/v1/artifacts/cpa/sub2api/push', method: 'POST', payload: { items: [item] } });
  assert.equal(resold.statusCode, 200, resold.body);
  assert.deepEqual(resold.json().classified, []);
  assert.equal(assetStore.get(asset.id).lifecycle, 'sold');
  assetStore.markLifecycle([asset.id], 'self_use');

  // `unexported` reads the push ledger here, and there is nothing left to send.
  const exhausted = await app.inject({ url: '/api/v1/artifacts/cpa/sub2api/push', method: 'POST', payload: { unexported: true } });
  assert.equal(exhausted.statusCode, 404, exhausted.body);
  assert.match(exhausted.body, /pushed/);
  // The download selections are exhausted too, for the same reason: a pushed
  // artifact has been delivered, so neither export has work left on it.
  for (const url of ['/api/v1/artifacts/cpa/sub2api', '/api/v1/artifacts/cpa/export']) {
    const done = await app.inject({ url, method: 'POST', payload: { unexported: true } });
    assert.equal(done.statusCode, 404, `${url}: ${done.body}`);
  }
  assert.equal(calls.length, 3);
});

test('concurrent sub2api pushes reserve the selected CPA until the gateway answers', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  config.sub2api = { baseUrl: 'http://127.0.0.1:8080', adminApiKey: 'admin-key' };
  fs.writeFileSync(path.join(cwd, 'gpt-re.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  const assetStore = new SessionAssetStore({ cwd, stateDir: config.output.stateDir, cpaDir: config.output.cpaDir });
  const asset = assetStore.upsert({ email: 'concurrent@example.test', accountId: 'concurrent-account' });
  assetStore.replaceCpa(asset.id, {
    access_token: jwt({
      exp: 1_900_000_000,
      'https://api.openai.com/auth': { chatgpt_account_id: 'concurrent-account' },
    }),
    id_token: jwt({ email: asset.email }),
    refresh_token: 'refresh-concurrent',
    account_id: 'concurrent-account',
    email: asset.email,
  }, { runId: 'concurrent-push-run', jobId: 'concurrent-push-job' });

  let importStarted;
  let signalImportStarted;
  importStarted = new Promise((resolve) => { signalImportStarted = resolve; });
  let releaseGateway;
  const gatewayReleased = new Promise((resolve) => { releaseGateway = resolve; });
  let importCalls = 0;
  const app = buildApp({
    cwd,
    assetStore,
    sub2ApiFetch: async (url) => {
      if (new URL(url).pathname === '/api/v1/admin/accounts/import/codex-session') {
        importCalls += 1;
        signalImportStarted();
        await gatewayReleased;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 0, data: { total: 1, created: 1, updated: 0, skipped: 0, failed: 0 } }),
      };
    },
  });
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  t.after(() => assetStore.close());
  t.after(() => app.close());

  const listed = (await app.inject({ url: '/api/v1/artifacts/cpa' })).json().artifacts;
  const item = { runId: listed[0].runId, jobId: listed[0].jobId };
  const first = app.inject({
    url: '/api/v1/artifacts/cpa/sub2api/push',
    method: 'POST',
    payload: { items: [item] },
  });
  await importStarted;

  const second = await app.inject({
    url: '/api/v1/artifacts/cpa/sub2api/push',
    method: 'POST',
    payload: { items: [item] },
  });
  assert.equal(second.statusCode, 409, second.body);
  assert.match(second.body, /already in progress/i);
  assert.equal(importCalls, 1);

  releaseGateway();
  const firstResponse = await first;
  assert.equal(firstResponse.statusCode, 200, firstResponse.body);
  assert.equal(firstResponse.json().pushed, 1);
});

test('a sub2api push that lands nothing leaves the ledger and the lifecycle alone', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  config.sub2api = { baseUrl: 'http://127.0.0.1:8080', adminApiKey: 'admin-key' };
  fs.writeFileSync(path.join(cwd, 'gpt-re.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));

  const assetStore = new SessionAssetStore({ cwd, stateDir: config.output.stateDir, cpaDir: config.output.cpaDir });
  t.after(() => assetStore.close());
  const asset = assetStore.upsert({ email: 'stale@example.test', accountId: 'account-stale', accessToken: 'at' });
  assetStore.replaceCpa(asset.id, {
    type: 'codex',
    access_token: jwt({ exp: 1_000_000_000 }),
    id_token: jwt({ email: 'stale@example.test' }),
    email: 'stale@example.test',
  }, { runId: 'stale-run', jobId: 'stale-job' });

  // Every entry refused — the shape sub2api answers with when the access
  // tokens in a batch have all expired since the CPA was written.
  let gatewayUp = false;
  const app = buildApp({
    cwd,
    assetStore,
    sub2ApiFetch: async () => {
      if (!gatewayUp) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      return {
        ok: true,
        status: 200,
        json: async () => ({ code: 0, data: { total: 1, created: 0, updated: 0, skipped: 0, failed: 1, errors: [{ message: 'access_token 已过期' }] } }),
      };
    },
  });
  t.after(() => app.close());
  const listed = (await app.inject({ url: '/api/v1/artifacts/cpa' })).json().artifacts;
  const payload = { items: [{ runId: listed[0].runId, jobId: listed[0].jobId }] };

  // A gateway that is not running is 503, not a failed push: the operator has
  // to start sub2api, not fix the accounts.
  const offline = await app.inject({ url: '/api/v1/artifacts/cpa/sub2api/push', method: 'POST', payload });
  assert.equal(offline.statusCode, 503, offline.body);

  gatewayUp = true;
  const refused = await app.inject({ url: '/api/v1/artifacts/cpa/sub2api/push', method: 'POST', payload });
  assert.equal(refused.statusCode, 200, refused.body);
  assert.equal(refused.json().pushed, 0);
  assert.deepEqual(refused.json().errors, ['access_token 已过期']);
  assert.equal(assetStore.get(asset.id).lifecycle, 'active');
  assert.equal((await app.inject({ url: '/api/v1/artifacts/cpa' })).json().artifacts[0].sub2ApiPushedAt, undefined);
});

test('batch export packs one file per account into a folder, for CPA and sub2api alike', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  // Every retained CPA file is one account delivery unit. Keep the addresses
  // distinct so the archive test exercises packaging, not duplicate rejection.
  const fixtures = [
    { runId: 'zip-one', jobId: 'job-one', email: 'shared@example.test', accountId: 'account-one' },
    { runId: 'zip-two', jobId: 'job-two', email: 'second@example.test', accountId: 'account-two' },
    { runId: 'zip-two', jobId: 'job-three', email: 'other@example.test', accountId: 'account-three' },
  ];
  for (const fixture of fixtures) {
    const filePath = path.join(cwd, config.output.cpaDir, fixture.runId, 'accounts', `${fixture.jobId}.json`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify({
      type: 'codex',
      access_token: jwt({
        exp: 1_900_000_000,
        'https://api.openai.com/auth': {
          chatgpt_account_id: fixture.accountId,
          chatgpt_user_id: `user-${fixture.accountId}`,
        },
      }),
      id_token: jwt({ email: fixture.email }),
      refresh_token: `refresh-${fixture.accountId}`,
      account_id: fixture.accountId,
      email: fixture.email,
      expired: new Date(1_900_000_000 * 1000).toISOString(),
      last_refresh: '2026-08-07T12:00:00.000Z',
    })}\n`);
  }

  const app = buildApp({ cwd });
  t.after(() => app.close());
  const items = fixtures.map(({ runId, jobId }) => ({ runId, jobId }));

  const cpaArchive = await app.inject({ url: '/api/v1/artifacts/cpa/export/archive', method: 'POST', payload: { items } });
  assert.equal(cpaArchive.statusCode, 200, cpaArchive.body);
  assert.equal(cpaArchive.headers['content-type'], 'application/zip');
  assert.match(downloadName(cpaArchive), /^CPA-已OAuth-3个-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.zip$/);
  const cpaNames = zipEntryNames(cpaArchive.rawPayload);
  assert.equal(cpaNames.length, 3);
  const cpaFolder = downloadName(cpaArchive).replace(/\.zip$/, '/');
  assert.equal(cpaNames.every((name) => name.startsWith(cpaFolder) && name.endsWith('.json')), true);
  assert.equal(new Set(cpaNames).size, 3);
  const afterCpaArchive = (await app.inject({ url: '/api/v1/artifacts/cpa' })).json().artifacts;
  assert.equal(afterCpaArchive.every((artifact) => typeof artifact.cpaExportedAt === 'string'), true);
  assert.equal(afterCpaArchive.every((artifact) => !artifact.sub2ApiExportedAt), true);

  const sub2Archive = await app.inject({ url: '/api/v1/artifacts/cpa/sub2api/archive', method: 'POST', payload: { items } });
  assert.equal(sub2Archive.statusCode, 200, sub2Archive.body);
  assert.equal(sub2Archive.headers['content-type'], 'application/zip');
  assert.match(downloadName(sub2Archive), /^sub2api-已OAuth-3个-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.zip$/);
  const sub2Names = zipEntryNames(sub2Archive.rawPayload);
  assert.equal(sub2Names.length, 3);
  const sub2Folder = downloadName(sub2Archive).replace(/\.zip$/, '/');
  assert.equal(sub2Names.every((name) => name.startsWith(sub2Folder) && name.endsWith('.sub2api.json')), true);
  assert.equal(new Set(sub2Names).size, 3);
  // Downloading the archive counts as an export, same as the merged document.
  const after = (await app.inject({ url: '/api/v1/artifacts/cpa' })).json().artifacts;
  assert.equal(after.every((artifact) => typeof artifact.cpaExportedAt === 'string'), true);
  assert.equal(after.every((artifact) => typeof artifact.sub2ApiExportedAt === 'string'), true);

  const empty = await app.inject({ url: '/api/v1/artifacts/cpa/sub2api/archive', method: 'POST', payload: {} });
  assert.equal(empty.statusCode, 400, empty.body);
});

test('CPA artifact API converts selected Codex files to sub2api only when downloaded', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const fixtures = [
    { runId: 'sub2api-one', jobId: 'job-one', email: 'one@example.test', accountId: 'account-one' },
    { runId: 'sub2api-two', jobId: 'job-two', email: 'two@example.test', accountId: 'account-two' },
  ];
  const original = new Map();
  for (const fixture of fixtures) {
    const filePath = path.join(cwd, config.output.cpaDir, fixture.runId, 'accounts', `${fixture.jobId}.json`);
    const record = {
      type: 'codex',
      access_token: jwt({
        exp: 1_900_000_000,
        'https://api.openai.com/auth': {
          chatgpt_account_id: fixture.accountId,
          chatgpt_user_id: `user-${fixture.accountId}`,
        },
      }),
      id_token: jwt({ email: fixture.email }),
      refresh_token: `refresh-${fixture.accountId}`,
      account_id: fixture.accountId,
      email: fixture.email,
      expired: new Date(1_900_000_000 * 1000).toISOString(),
      last_refresh: '2026-08-07T12:00:00.000Z',
    };
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const serialized = `${JSON.stringify(record)}\n`;
    fs.writeFileSync(filePath, serialized);
    original.set(filePath, serialized);
    fixture.filePath = filePath;
  }

  const app = buildApp({ cwd });
  const empty = await app.inject({
    url: '/api/v1/artifacts/cpa/sub2api',
    method: 'POST',
    payload: {},
  });
  assert.equal(empty.statusCode, 400, empty.body);
  const beforeExport = await app.inject({ url: '/api/v1/artifacts/cpa' });
  assert.equal(beforeExport.statusCode, 200, beforeExport.body);
  assert.equal(beforeExport.json().artifacts.every((artifact) => !artifact.cpaExportedAt), true);
  assert.equal(beforeExport.json().artifacts.every((artifact) => !artifact.sub2ApiExportedAt), true);
  const single = await app.inject({
    url: '/api/v1/artifacts/cpa/sub2api',
    method: 'POST',
    payload: { items: [{ runId: fixtures[0].runId, jobId: fixtures[0].jobId }] },
  });
  assert.equal(single.statusCode, 200, single.body);
  assert.match(downloadName(single), /^sub2api-已OAuth-\d+个-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.json$/);
  assert.equal(single.json().accounts.length, 1);
  assert.equal(single.json().accounts[0].platform, 'openai');
  assert.equal(single.json().accounts[0].type, 'oauth');
  assert.equal(single.json().accounts[0].credentials.chatgpt_account_id, fixtures[0].accountId);
  const afterSingle = (await app.inject({ url: '/api/v1/artifacts/cpa' })).json().artifacts;
  assert.deepEqual(afterSingle.map((artifact) => artifact.jobId), [fixtures[1].jobId, fixtures[0].jobId]);
  assert.equal(typeof afterSingle[1].sub2ApiExportedAt, 'string');

  const batch = await app.inject({
    url: '/api/v1/artifacts/cpa/sub2api',
    method: 'POST',
    payload: { items: fixtures.map(({ runId, jobId }) => ({ runId, jobId })) },
  });
  assert.equal(batch.statusCode, 200, batch.body);
  assert.deepEqual(batch.json().proxies, []);
  assert.deepEqual(batch.json().accounts.map((account) => account.name), fixtures.map((fixture) => fixture.email));
  for (const fixture of fixtures) assert.equal(fs.readFileSync(fixture.filePath, 'utf8'), original.get(fixture.filePath));
  const afterBatch = (await app.inject({ url: '/api/v1/artifacts/cpa' })).json().artifacts;
  assert.equal(afterBatch.every((artifact) => typeof artifact.sub2ApiExportedAt === 'string'), true);

  fs.appendFileSync(fixtures[0].filePath, ' ');
  // Direct fixture writes bypass the engine's synchronous cache invalidation.
  app.services.runManager.invalidateCpaArtifactScan();
  const afterReplacement = (await app.inject({ url: '/api/v1/artifacts/cpa' })).json().artifacts;
  const replaced = afterReplacement.find((artifact) => artifact.jobId === fixtures[0].jobId);
  assert.ok(replaced);
  assert.equal(replaced.sub2ApiExportedAt, undefined);
  await app.close();
});

test('log redaction preserves timestamps and internal ids while masking PII', () => {
  const visible = sanitizeValue({
    at: '2026-08-04T18:07:42.734Z',
    runId: 'ui-20260804180656-k9nvhk',
    jobId: 'job-727f791c9bba',
    message: 'sent to person@example.com at +56912345678',
  }, { redactPii: true });
  assert.equal(visible.at, '2026-08-04T18:07:42.734Z');
  assert.equal(visible.runId, 'ui-20260804180656-k9nvhk');
  assert.equal(visible.jobId, 'job-727f791c9bba');
  assert.equal(visible.message.includes('person@example.com'), false);
  assert.equal(visible.message.includes('912345678'), false);
});

test('preflight resource failures remain actionable client errors', () => {
  // The shortfall the orchestrator measured is the only place the real numbers
  // exist, so the HTTP layer has to forward that message instead of replacing
  // it with a fixed string that named one provider whatever channel was in use.
  const error = new Error('mail.com 邮箱池可用邮箱不足：本次需要 9 个，只有 8 个可用（8 可用 / 9 注册中占用 / 1 已用 / 共 20）');
  error.code = 'NO_ELIGIBLE_MAILBOX';
  error.provider = 'mailcom';
  error.needed = 9;
  error.available = 8;
  error.pool = { available: 8, registration_started: 9, consumed: 1, mailboxes: 20 };
  const visible = preflightHttpError(error);
  assert.equal(visible.statusCode, 409);
  assert.equal(visible.details.code, 'NO_ELIGIBLE_MAILBOX');
  assert.equal(visible.details.needed, 9);
  assert.equal(visible.details.available, 8);
  assert.equal(visible.details.pool.registration_started, 9);
  assert.match(visible.message, /本次需要 9 个，只有 8 个可用/);
});

test('preflight preserves a public mail transport status and reason', () => {
  const error = Object.assign(new Error('fastmail GET /api/pool/accounts failed: connection refused'), {
    code: 'MAIL_PROVIDER_UNAVAILABLE',
    statusCode: 503,
    mailProvider: 'fastmail',
    action: 'GET /api/pool/accounts',
    retryable: true,
    public: true,
  });
  const visible = preflightHttpError(error);
  assert.equal(visible.statusCode, 503);
  assert.equal(visible.code, 'MAIL_PROVIDER_UNAVAILABLE');
  assert.equal(visible.public, true);
  assert.equal(visible.details.provider, 'fastmail');
  assert.equal(visible.details.retryable, true);
  assert.match(visible.message, /connection refused/);
});

test('remote mail API failures expose a sanitized reason without the generic 500 wrapper', async (t) => {
  const { cwd } = temporaryWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const app = buildApp({ cwd });
  t.after(() => app.close());
  app.services.runManager.mailcomStatus = async () => {
    const error = Object.assign(new Error('fastmail GET /api/summary failed: invalid admin token'), {
      code: 'MAIL_PROVIDER_HTTP_ERROR',
      status: 401,
      statusCode: 502,
      mailProvider: 'fastmail',
      action: 'GET /api/summary',
      public: true,
      publicDetails: {
        code: 'MAIL_PROVIDER_HTTP_ERROR',
        provider: 'fastmail',
        action: 'GET /api/summary',
        upstreamStatus: 401,
        retryable: false,
      },
    });
    throw error;
  };

  const response = await app.inject({ url: '/api/v1/mailcom/status?provider=fastmail' });
  assert.equal(response.statusCode, 502, response.body);
  assert.match(response.json().message, /invalid admin token/);
  assert.notEqual(response.json().message, 'The local API could not complete the request');
  assert.equal(response.json().details.upstreamStatus, 401);
  assert.equal(response.json().details.provider, 'fastmail');
});

test('scheduler honors an initial checkpoint-safe pause without claiming resources', async () => {
  const { cwd, config } = temporaryWorkspace();
  const state = makeInitialOrchestratorV2State(config, { cwd, runId: 'ui-pause-test' });
  const gate = new ControlGate();
  gate.request('pause');
  const checkpoints = [];
  await runOrchestratorV2({ log: { entries: [] } }, state, config, {
    cwd,
    control: gate,
    saveState: async () => {},
    onCheckpoint: ({ reason }) => checkpoints.push(reason),
  });
  assert.equal(state.status, 'paused');
  assert.equal(state.mailboxes.length, 0);
  assert.equal(state.control.requestedAction, 'pause');
  assert.deepEqual(checkpoints, ['scheduler_paused']);
});

test('run manager cleans up a cancel request when a branch returns paused', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  config.proxyPool.maintenanceProxy = 'http://127.0.0.1:7890';
  const plan = normalizeRunPlan({
    taskKind: 'oauth',
    workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: ['asset-already-complete'] },
  }, config);
  const runId = 'ui-cancel-after-pause';
  const state = makeInitialBranchState(config, plan, { cwd, runId });
  state.jobs = [{
    id: 'ui-cancel-after-pause-job',
    email: 'paused@example.test',
    mailboxId: '',
    laneId: 'paused@example.test',
    status: 'complete',
    phase: 'complete',
    sms: { current: null, attempts: [], acquisition: null, acquisitions: [] },
  }];
  state.control.requestedAction = 'cancel';
  const stateFile = path.join(cwd, config.output.stateDir, `run-${runId}.json`);
  saveV2State(stateFile, state);
  const logs = [];
  const manager = new RunManager({
    cwd,
    configService: new ConfigService({ cwd }),
    logStore: { append(_runId, record) { logs.push(record); } },
    harPath: path.join(process.cwd(), 'localhost.har'),
  });
  t.after(async () => {
    await manager.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const gate = new ControlGate();
  gate.request('pause');
  await manager.execute({
    state,
    stateFile,
    config,
    gate,
    preparedResources: { smsProvider: { name: 'mock' } },
    lock: { release() {} },
    slot: 'main',
  });

  assert.equal(state.status, 'cancelled');
  assert.equal(state.phase, 'cancelled');
  assert.equal(state.control.requestedAction, null);
  assert.equal(logs.some((record) => record.type === 'run_paused'), false);
});

test('scheduler cancellation interrupts a hung proxy health check', async () => {
  const { cwd, config } = temporaryWorkspace();
  config.mail.accounts = [{ id: 1, email: 'cancel-probe@example.test', tokenValid: true, bound: false }];
  config.proxyPool.required = true;
  config.proxyPool.healthCheck = { enabled: true, probeUrl: 'https://example.test/health', timeoutMs: 60_000 };
  const state = makeInitialOrchestratorV2State(config, { cwd, runId: 'ui-cancel-probe-test' });
  const gate = new ControlGate();
  let started;
  const probeStarted = new Promise((resolve) => { started = resolve; });
  const run = runOrchestratorV2({ log: { entries: [] } }, state, config, {
    cwd,
    control: gate,
    proxyEntries: [{ id: 'proxy-cancel-test', url: 'http://127.0.0.1:2080' }],
    proxyProbeExecutor: () => {
      started();
      return new Promise(() => {});
    },
    saveState: async () => {},
  });

  await probeStarted;
  gate.request('cancel');
  await Promise.race([
    run,
    new Promise((_, reject) => setTimeout(() => reject(new Error('hung proxy check ignored cancellation')), 1000)),
  ]);

  assert.equal(state.status, 'cancel_requested');
  assert.equal(state.mailboxes.length, 0);
  assert.equal(state.proxyHealth['proxy-cancel-test'].status, 'unknown');
  assert.equal(state.proxyCounts.checking, 0);
  assert.equal(state.events.some((event) => event.type === 'proxy_health_interrupted'), true);
});

test('control gate exposes and resets its abort signal', () => {
  const gate = new ControlGate();
  const firstSignal = gate.signal;
  gate.request('cancel');
  assert.equal(firstSignal.aborted, true);
  gate.consume('cancel');
  assert.notEqual(gate.signal, firstSignal);
  assert.equal(gate.signal.aborted, false);
});

test('control gate wakes the scheduler for a scoped job retry', async () => {
  const gate = new ControlGate();
  const wake = gate.waitForWake();
  gate.requestJobRetry({ jobId: 'job-waiting-sms', resolveSmsAcquisition: 'retry' });
  await wake.promise;
  assert.deepEqual(gate.consumeJobRetries(), [{ jobId: 'job-waiting-sms', resolveSmsAcquisition: 'retry' }]);
});

test('control gate coalesces a batch of scoped job retries into one wake-up', async () => {
  const gate = new ControlGate();
  let wakeCount = 0;
  const wake = gate.wake.bind(gate);
  gate.wake = () => {
    wakeCount += 1;
    wake();
  };
  const wait = gate.waitForWake();
  gate.requestJobRetries([
    { jobId: 'job-waiting-sms-1', resolveSmsAcquisition: 'retry' },
    { jobId: 'job-waiting-sms-2', resolveSmsAcquisition: 'retry' },
  ]);
  await wait.promise;
  assert.equal(wakeCount, 1);
  assert.deepEqual(gate.consumeJobRetries(), [
    { jobId: 'job-waiting-sms-1', resolveSmsAcquisition: 'retry' },
    { jobId: 'job-waiting-sms-2', resolveSmsAcquisition: 'retry' },
  ]);
});

test('run manager persists a batch of scoped job retries and wakes once', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  const logs = [];
  const manager = new RunManager({
    cwd,
    configService: new ConfigService({ cwd }),
    logStore: { append(_runId, record) { logs.push(record); } },
  });
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 2,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'batch-retry-manager' });
  state.status = 'running';
  state.jobs = [
    { id: 'job-batch-1', status: 'waiting', phase: 'waiting_sms_acquisition_reconcile' },
    { id: 'job-batch-2', status: 'waiting', phase: 'waiting_sms_acquisition_reconcile' },
    { id: 'job-other', status: 'running', phase: 'phone_otp_sent' },
  ];
  const stateFile = path.join(cwd, config.output.stateDir, `run-${state.runId}.json`);
  saveV2State(stateFile, state);
  const gate = new ControlGate();
  let wakeCount = 0;
  const wake = gate.wake.bind(gate);
  gate.wake = () => { wakeCount += 1; wake(); };
  manager.active = { state, stateFile, gate };
  manager.get = () => ({ runId: state.runId, active: true, jobs: state.jobs });
  t.after(async () => {
    manager.active = null;
    await manager.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  await manager.retryJobs(state.runId, ['job-batch-1', 'job-batch-2'], { resolveSmsAcquisition: 'retry' });

  assert.equal(wakeCount, 1);
  assert.deepEqual(gate.consumeJobRetries().map((request) => request.jobId), ['job-batch-1', 'job-batch-2']);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')).control.pendingJobRetries.map((request) => request.jobId), ['job-batch-1', 'job-batch-2']);
  assert.deepEqual(logs.at(-1).details.jobIds, ['job-batch-1', 'job-batch-2']);
  assert.equal(logs.at(-1).details.count, 2);
});

test('batch job retry route forwards all requested job ids', async (t) => {
  const { cwd } = temporaryWorkspace();
  const manager = new RunManager({ cwd, configService: new ConfigService({ cwd }), logStore: { append() {} } });
  let call;
  manager.retryJobs = async (...args) => {
    call = args;
    return { runId: args[0], active: true };
  };
  const app = buildApp({ cwd, runManager: manager });
  t.after(async () => {
    await app.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/runs/batch-route/jobs/retry',
    payload: { jobIds: ['job-route-1', 'job-route-2'], resolveSmsAcquisition: 'retry' },
  });

  assert.equal(response.statusCode, 202, response.body);
  assert.deepEqual(call, [
    'batch-route',
    ['job-route-1', 'job-route-2'],
    { resolveEffect: undefined, resolveSmsAcquisition: 'retry' },
  ]);
});

test('every upkeep call, promo check included, goes through the configured forwarder', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  // The port is configurable, so the test picks one that is nobody's default.
  fs.writeFileSync(path.join(cwd, 'gpt-re.config.json'), `${JSON.stringify({
    ...config,
    proxyPool: { ...config.proxyPool, maintenanceProxy: 'http://127.0.0.1:7899' },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(cwd, 'dynamic-proxy-pools.json'), `${JSON.stringify({
    schemaVersion: 1,
    countryPools: {
      JP: { countryCode: 'JP', manualEntries: ['http://jp-one:9001', 'http://jp-two:9002'], sources: [] },
      GB: { countryCode: 'GB', manualEntries: ['http://gb-one:9003'], sources: [] },
    },
  }, null, 2)}\n`);

  const store = new SessionAssetStore({ cwd, stateDir: '.state', cpaDir: '.state/output' });
  t.after(() => { store.close(); fs.rmSync(cwd, { recursive: true, force: true }); });
  const asset = store.upsert({ email: 'upkeep@example.test', accountId: 'account-upkeep', accessToken: 'at-upkeep' });

  const probeProxies = [];
  const trialProxies = [];
  const app = buildApp({
    cwd,
    sessionAssetProbe: async (_store, assetIds, options) => {
      probeProxies.push(String(options.proxy || ''));
      return { requested: assetIds.length, checked: assetIds.length, results: [] };
    },
    sessionAssetTrialCheck: async (_store, assetIds, options) => {
      // A per-asset picker would mean two checks of one account answering from
      // two addresses; there must not be one.
      assert.equal(typeof options.proxyFor, 'undefined');
      trialProxies.push(String(options.proxy || ''));
      return { requested: assetIds.length, checked: assetIds.length, results: [] };
    },
  });
  t.after(() => app.close());

  const probe = await app.inject({ method: 'POST', url: '/api/v1/session-assets/probe', payload: { assetIds: [asset.id] } });
  assert.equal(probe.statusCode, 200);
  assert.deepEqual(probeProxies, ['http://127.0.0.1:7899']);

  const trial = await app.inject({ method: 'POST', url: '/api/v1/session-assets/trial-check', payload: { assetIds: [asset.id] } });
  assert.equal(trial.statusCode, 200);
  // The forwarder, never a country pool: the promo check is upkeep on an
  // account that already exists, and the pools are what registration pays for.
  assert.deepEqual(trialProxies, ['http://127.0.0.1:7899']);
});

test('the promo check needs no proxy catalog at all', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  fs.writeFileSync(path.join(cwd, 'gpt-re.config.json'), `${JSON.stringify({
    ...config,
    proxyPool: { ...config.proxyPool, maintenanceProxy: 'http://127.0.0.1:7899' },
  }, null, 2)}\n`);

  const store = new SessionAssetStore({ cwd, stateDir: '.state', cpaDir: '.state/output' });
  t.after(() => { store.close(); fs.rmSync(cwd, { recursive: true, force: true }); });
  const asset = store.upsert({ email: 'no-pool@example.test', accountId: 'account-no-pool', accessToken: 'at-no-pool' });

  let seen = null;
  const app = buildApp({
    cwd,
    sessionAssetTrialCheck: async (_store, assetIds, options) => {
      seen = options;
      return { requested: assetIds.length, checked: assetIds.length, results: [] };
    },
  });
  t.after(() => app.close());

  const response = await app.inject({ method: 'POST', url: '/api/v1/session-assets/trial-check', payload: { assetIds: [asset.id] } });
  assert.equal(response.statusCode, 200);
  assert.equal(typeof seen.proxyFor, 'undefined');
  assert.equal(seen.proxy, 'http://127.0.0.1:7899');
});

test('the maintenance forwarder is editable from the console and reaches the runtime', async (t) => {
  const { cwd } = temporaryWorkspace();
  const app = buildApp({ cwd });
  t.after(() => app.close());

  const before = await app.inject({ url: '/api/v1/config' });
  const draft = JSON.parse(before.body).config;
  // Saved through the same route the config page uses.
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/v1/config',
    payload: { config: { ...draft, proxyPool: { ...draft.proxyPool, maintenanceProxy: 'http://127.0.0.1:7899' } } },
  });
  assert.equal(saved.statusCode, 200);

  const after = await app.inject({ url: '/api/v1/config' });
  assert.equal(JSON.parse(after.body).config.proxyPool.maintenanceProxy, 'http://127.0.0.1:7899');

  // And the upkeep endpoints pick the new value up without a restart.
  const store = new SessionAssetStore({ cwd, stateDir: '.state', cpaDir: '.state/output' });
  t.after(() => { store.close(); fs.rmSync(cwd, { recursive: true, force: true }); });
  const asset = store.upsert({ email: 'reconfigured@example.test', accountId: 'account-reconfigured', accessToken: 'at-reconfigured' });
  const probes = [];
  const live = buildApp({
    cwd,
    sessionAssetProbe: async (_store, assetIds, options) => {
      probes.push(String(options.proxy || ''));
      return { requested: assetIds.length, checked: assetIds.length, results: [] };
    },
  });
  t.after(() => live.close());
  const probe = await live.inject({ method: 'POST', url: '/api/v1/session-assets/probe', payload: { assetIds: [asset.id] } });
  assert.equal(probe.statusCode, 200);
  assert.deepEqual(probes, ['http://127.0.0.1:7899']);
});

test('refreshing every country pool pulls each source and reports the ones that failed', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'gpt-re.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  // Built rather than hand-written: the catalog normalizer only accepts a real
  // provider API URL, so a fake host makes readCatalog throw before the pull.
  const source = (countryCode, id) => ({
    id, provider: '1024proxy', protocol: 'socks5', count: 2,
    url: buildProxyApiUrl('1024proxy', { countryCode, count: 2, protocol: 'socks5' }).url,
    entries: [], lastPulledAt: '', lastPullCount: 0, lastError: '',
  });
  fs.writeFileSync(path.join(cwd, 'dynamic-proxy-pools.json'), `${JSON.stringify({
    schemaVersion: 1,
    countryPools: {
      JP: { countryCode: 'JP', manualEntries: [], sources: [source('JP', 'src-jp')] },
      GB: { countryCode: 'GB', manualEntries: [], sources: [source('GB', 'src-gb')] },
      TH: { countryCode: 'TH', manualEntries: [], sources: [source('TH', 'src-th')] },
    },
  }, null, 2)}\n`);

  const proxyService = new ProxyService(new ConfigService({ cwd }));
  const pulled = [];
  proxyService.fetchApiSource = async (url) => {
    pulled.push(url);
    // The GB source is the broken one; the batch must survive it.
    if (url.includes('region=GB')) return { ok: false, status: 503, text: async () => '' };
    const code = String(new URL(url).searchParams.get('region')).toLowerCase();
    return { ok: true, status: 200, text: async () => `socks5://${code}-1.example.test:1080\nsocks5://${code}-2.example.test:1080\n` };
  };

  const app = buildApp({ cwd, proxyService });
  t.after(() => app.close());

  const response = await app.inject({ method: 'POST', url: '/api/v1/proxies/sources/pull-all' });
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body);

  assert.equal(body.refresh.requested, 3);
  assert.equal(body.refresh.succeeded, 2);
  assert.equal(body.refresh.failed, 1);
  assert.equal(body.refresh.pulled, 4);
  assert.deepEqual(body.refresh.results.filter((r) => !r.ok).map((r) => r.countryCode), ['GB']);
  // Sequential and in country order, so a provider is never hit in parallel.
  assert.deepEqual(pulled.map((url) => new URL(url).searchParams.get('region')), ['GB', 'JP', 'TH']);

  // The two good pools landed even though one source failed.
  const catalog = JSON.parse(fs.readFileSync(path.join(cwd, 'dynamic-proxy-pools.json'), 'utf8'));
  assert.equal(catalog.countryPools.JP.sources[0].entries.length, 2);
  assert.equal(catalog.countryPools.TH.sources[0].entries.length, 2);
  assert.equal(catalog.countryPools.GB.sources[0].entries.length, 0);
  assert.match(catalog.countryPools.GB.sources[0].lastError, /503/);
});

test('targeted proxy refresh pulls only the requested country pools', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'gpt-re.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  const source = (countryCode, id) => ({
    id, provider: '1024proxy', protocol: 'socks5', count: 1,
    url: buildProxyApiUrl('1024proxy', { countryCode, count: 1, protocol: 'socks5' }).url,
    entries: [], lastPulledAt: '', lastPullCount: 0, lastError: '',
  });
  fs.writeFileSync(path.join(cwd, 'dynamic-proxy-pools.json'), `${JSON.stringify({
    schemaVersion: 1,
    countryPools: {
      VN: { countryCode: 'VN', manualEntries: [], sources: [source('VN', 'src-vn')] },
      US: { countryCode: 'US', manualEntries: [], sources: [source('US', 'src-us')] },
      IN: { countryCode: 'IN', manualEntries: [], sources: [source('IN', 'src-in')] },
    },
  }, null, 2)}\n`);

  const proxyService = new ProxyService(new ConfigService({ cwd }));
  const pulled = [];
  proxyService.fetchApiSource = async (url) => {
    const countryCode = new URL(url).searchParams.get('region');
    pulled.push(countryCode);
    return { ok: true, status: 200, text: async () => `socks5://${countryCode.toLowerCase()}-1.example.test:1080\n` };
  };

  const result = await proxyService.pullAll({ allowEmpty: true, countryCodes: ['vn'] });

  assert.equal(result.refresh.requested, 1);
  assert.deepEqual(pulled, ['VN']);
  assert.equal(result.refresh.results[0].countryCode, 'VN');
});

test('concurrent run refreshes for different countries keep their own targets', async (t) => {
  const { cwd } = temporaryWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const calls = [];
  const pending = [];
  const proxyService = {
    pullAll(options) {
      calls.push(options);
      return new Promise((resolve) => pending.push(resolve));
    },
  };
  const manager = new RunManager({
    cwd,
    configService: new ConfigService({ cwd }),
    logStore: { append() {} },
    proxyService,
  });
  t.after(async () => { await manager.shutdown(); });
  manager.proxySnapshot = () => ({ schemaVersion: 1, entries: [] });
  const state = {
    runPlan: {
      proxyAssignments: [
        { workerSlot: 1, kind: 'countryPool', countryCode: 'US' },
        { workerSlot: 2, kind: 'countryPool', countryCode: 'VN' },
      ],
    },
  };

  const usRefresh = manager.refreshProxyResourcesForRun(state, { workerSlots: [1] });
  await new Promise((resolve) => setImmediate(resolve));
  const vnRefresh = manager.refreshProxyResourcesForRun(state, { workerSlots: [2] });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(calls, [{ allowEmpty: true, countryCodes: ['US'] }]);
  pending.shift()({ refresh: { requested: 1 } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [
    { allowEmpty: true, countryCodes: ['US'] },
    { allowEmpty: true, countryCodes: ['VN'] },
  ]);
  pending.shift()({ refresh: { requested: 1 } });
  await Promise.all([usRefresh, vnRefresh]);
});

test('active run proxy refresh swaps only waiting candidates and preserves leases', async (t) => {
  const { cwd } = temporaryWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const manager = new RunManager({
    cwd,
    configService: new ConfigService({ cwd }),
    logStore: { append() {} },
  });
  const active = {
    state: {
      runId: 'active-proxy-refresh',
      taskKind: 'register_session',
      runPlan: {
        taskKind: 'register_session',
        proxyAssignments: [{ workerSlot: 1, kind: 'countryPool', countryCode: 'US' }],
      },
      workers: [{ id: 'worker-1', slot: 1, proxyId: 'leased-old', proxy: { id: 'leased-old' } }],
      proxyLeases: { 'worker-1': 'leased-old' },
      proxyHealth: { 'leased-old': { status: 'healthy' }, 'new-proxy': { status: 'failed' } },
    },
    proxyEntries: [{ id: 'leased-old', workerSlots: [1] }],
  };
  manager.active = active;
  manager.proxySnapshot = () => ({
    schemaVersion: 1,
    entries: [
      { id: 'leased-old', workerSlots: [1] },
      { id: 'new-proxy', workerSlots: [1] },
    ],
  });

  const result = await manager.refreshActiveProxySnapshots({ countryCodes: ['US'], persist: false });

  assert.deepEqual(result.updated, [{ runId: 'active-proxy-refresh', entryCount: 2, boundWorkerCount: 1 }]);
  assert.deepEqual(active.proxyEntries.map((entry) => entry.id), ['leased-old', 'new-proxy']);
  assert.equal(active.state.workers[0].proxyId, 'leased-old');
  assert.deepEqual(active.state.proxyLeases, { 'worker-1': 'leased-old' });
  assert.equal(active.state.proxyHealth['new-proxy'], undefined, 'a new exit can be health-checked again');
});

test('refreshing every country pool needs at least one source to refresh', async (t) => {
  const { cwd } = temporaryWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const app = buildApp({ cwd });
  t.after(() => app.close());
  const response = await app.inject({ method: 'POST', url: '/api/v1/proxies/sources/pull-all' });
  assert.equal(response.statusCode, 400);
});

test('rebind start responds while allocation is pending and stop preserves the remaining queue', { timeout: 10000 }, async (t) => {
  const { cwd } = temporaryWorkspace();
  const app = buildApp({ cwd });
  const service = app.services.rebindService;
  const store = app.services.runManager.sessionAssets();
  let releaseClaim;
  t.after(async () => {
    releaseClaim?.();
    await service.batch;
    await app.close();
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  const assets = ['first', 'second'].map((name) => {
    const asset = store.upsert({ email: `${name}@icloud.com`, mailProvider: 'icloud', accessToken: 'fixture-private-token' });
    store.save({ ...asset, createdAt: '2020-01-01T00:00:00Z' });
    return asset.id;
  });
  service.addToQueue(assets);
  service.mailChannel = () => ({ claim: () => new Promise((resolve) => { releaseClaim = resolve; }) });
  service.rebindAccount = async ({ asset, claimEmail, onStage }) => {
    onStage('claim');
    await claimEmail();
    return { assetId: asset.id, status: 'error', stage: 'claim', error: 'pool empty' };
  };
  const body = { provider: 'fastmail', assetIds: assets, workerConcurrency: 1 };
  const startedAt = Date.now();
  const started = await app.inject({ method: 'POST', url: '/api/v1/rebind/start', payload: body });
  assert.equal(started.statusCode, 202);
  assert.ok(Date.now() - startedAt < 2000, 'mail allocation must not delay HTTP acceptance');
  const state = (await app.inject({ method: 'GET', url: '/api/v1/rebind/status' })).json();
  assert.equal(state.running, true);
  assert.equal(state.starting, false);
  assert.equal(state.active[0].stage, 'claim');
  assert.equal(JSON.stringify(state).includes('fixture-private-token'), false);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/rebind/start', payload: body })).statusCode, 409);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/rebind/stop', payload: {} })).json().stopRequested, true);
  releaseClaim();
  await service.batch;
  const finished = (await app.inject({ method: 'GET', url: '/api/v1/rebind/status' })).json();
  assert.equal(finished.running, false);
  assert.equal(finished.done, 1);
  assert.deepEqual(finished.active, []);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/rebind/queue' })).json().accounts.length, 2);
});

test('unlocking an archived sold account brings it back, and a relock restarts the settle window', async (t) => {
  const { cwd, config } = temporaryWorkspace();
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  let now = Date.parse('2026-10-01T00:00:00.000Z');
  const assetStore = new SessionAssetStore({ cwd, stateDir: config.output.stateDir, cpaDir: config.output.cpaDir, now: () => now });
  t.after(() => assetStore.close());
  const asset = assetStore.upsert({ email: 'sold-archived@example.test', accountId: 'sold-account', accessToken: 'at' });
  assetStore.replaceCpa(asset.id, { type: 'codex', email: asset.email, access_token: 'sold-token' }, { runId: 'sold-run', jobId: 'sold-job' });
  assetStore.markLifecycle([asset.id], 'sold');

  const manager = new RunManager({ cwd, configService: new ConfigService({ cwd }), logStore: { append() {} }, assetStore, now: () => now });
  const app = buildApp({ cwd, assetStore, runManager: manager });
  t.after(() => app.close());
  const artifacts = (await app.inject({ url: '/api/v1/artifacts/cpa?reveal=1' })).json().artifacts;
  const item = { runId: artifacts[0].runId, jobId: artifacts[0].jobId, key: artifacts[0].key };
  assert.equal((await app.inject({ url: '/api/v1/artifacts/cpa/export', method: 'POST', payload: { items: [item] } })).statusCode, 200);
  assert.equal((await app.inject({ url: '/api/v1/artifacts/cpa/lock', method: 'POST', payload: { items: [item], batchKey: 'sold-batch' } })).statusCode, 200);

  // A day later the settled account is archived out of the listing.
  now += 25 * 3_600_000;
  assert.equal(manager.archiveSettledAssets().archived, 1);
  assert.equal(assetStore.files().length, 0);

  const unlocked = await app.inject({ url: '/api/v1/artifacts/cpa/unlock', method: 'POST', payload: { items: [item] } });
  assert.equal(unlocked.statusCode, 200, unlocked.body);
  assert.deepEqual(unlocked.json().restored, [asset.id]);
  assert.equal(assetStore.files().length, 1, 'the account is back in the login-state listing');
  assert.equal(assetStore.get(asset.id).email, asset.email);
  // Unlocked, it is not settled: nothing archives it again.
  now += 48 * 3_600_000;
  assert.equal(manager.archiveSettledAssets().archived, 0);

  // Locked again, the 24 hours count from the new lock, not the old one.
  assert.equal((await app.inject({ url: '/api/v1/artifacts/cpa/lock', method: 'POST', payload: { items: [item], batchKey: 'sold-batch' } })).statusCode, 200);
  now += 23 * 3_600_000;
  assert.equal(manager.archiveSettledAssets().archived, 0);
  now += 2 * 3_600_000;
  assert.equal(manager.archiveSettledAssets().archived, 1);
});
