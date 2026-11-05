'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  assertMailClientProvider,
  canResumeBranchState,
  canMigrateLegacyRegisterOAuthState,
  cancelBranchState,
  makeInitialBranchState,
  migrateSessionCheckpoint,
  migrateLegacyRegisterOAuthState,
  preflightBranch,
  prepareBranchPreflight,
  restartStaleEmailOtpSession,
  resumeBranchState,
  runBranchOrchestrator,
  skipBranchJob,
  summarizeBranchState,
  _rentalMailboxDeficit,
  tagSessionAssetTrial,
} = require('../src/branch-orchestrator');
const { makeInitialChatGptSessionState } = require('../src/chatgpt-session-runner');
const { CockpitOAuthRunner, makeInitialCockpitOAuthState } = require('../src/cockpit-oauth-runner');
const { cookieObjectFor, createCookieJar } = require('../src/cookie-jar');
const { normalizeRunPlan } = require('../src/run-plan');
const { SessionAssetStore } = require('../src/session-asset-store');
const { ControlGate } = require('../src/ui-server/run-manager');
const { summarizeSmsCost } = require('../src/sms-cost-ledger');

function branchConfig(workers = 1) {
  return {
    schemaVersion: 2,
    mail: {
      provider: 'xiaopingguo',
      baseUrl: 'http://127.0.0.1:8000',
      password: 'mail-secret',
      count: 1,
      folders: ['INBOX'],
      maxResults: 20,
      timeoutMs: 200,
      pollIntervalMs: 5,
      keyword: 'OpenAI',
    },
    aliases: { strategy: 'plus', count: 1, maxAttempts: 2, runTag: 'branch', plusAddressingEnabled: true },
    sms: {
      provider: 'mock',
      apiKey: 'sms-secret',
      maxPrice: 0.03,
      service: { code: 'mock' },
      country: { id: 151 },
      replacementBudget: 2,
      codeTimeoutMs: 100,
    },
    workers: { maxConcurrency: workers },
    registration: { exchangeToken: true, dynamicSentinel: true, name: 'Fixture', birthdate: '2000-01-01' },
    proxyPool: { path: 'proxy-pool.txt', defaultProtocol: 'http', required: false, healthCheck: { enabled: false } },
    output: { stateDir: '.state', cpaDir: '.state/output' },
  };
}

function temporaryStore(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-branch-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const store = new SessionAssetStore({ cwd, stateDir: '.state', cpaDir: '.state/output' });
  t.after(() => store.close());
  return store;
}

function mailboxClient(accounts) {
  const reserved = [];
  const released = [];
  // The pool now draws addresses from mail.com's whole live domain catalogue,
  // which is only safe because an undeliverable domain demotes itself on these
  // reports. Recording them here keeps that wiring under test.
  const delivery = [];
  return {
    reserved,
    released,
    delivery,
    async listAccounts() { return { accounts }; },
    async reserveMailbox(id) { reserved.push(String(id)); },
    async releaseMailbox(id) { released.push(String(id)); },
    async reportDelivery(address, delivered) { delivery.push({ address, delivered }); },
  };
}

function finishSession(state, job) {
  state.step = 'verified';
  state.status = 'valid';
  // A registration that got everything it asked for. The OAuth leg is gated on
  // this, so a test that means "registration succeeded" has to say so; a test
  // about incomplete security overwrites these two afterwards.
  state.security = { ...(state.security || {}), passwordStatus: 'configured', totpStatus: 'configured' };
  state.accountId = `account-${job.id}`;
  state.accessToken = `access-${job.id}`;
  state.sessionToken = `session-${job.id}`;
  state.planType = 'free';
  state.session = { user: { email: state.email } };
  state.me = { email: state.email };
  state.lastValidatedAt = new Date().toISOString();
}

for (const confirmed of [true, false]) {
  test(`refresh forwards only confirmed email changes and keeps maintenance proxy (confirmed: ${confirmed})`, async (t) => {
    const config = branchConfig();
    const store = temporaryStore(t);
    config.proxyPool.maintenanceProxy = 'http://127.0.0.1:7890';
    const asset = store.upsert({
      email: 'new@example.test', mailProvider: 'xiaopingguo', accountId: 'saved-account',
      parentEmail: 'new@example.test', parentMailboxId: 'xiaopingguo:box',
      accessToken: 'old-token', status: 'partial', password: 'kept-password', totpSecret: 'KEPTTOTP',
      rebind: {
        previousEmail: 'old@icloud.com', newEmail: 'new@example.test', provider: 'xiaopingguo',
        mailboxId: 'xiaopingguo:box', reboundAt: '2026-09-16T09:44:00Z', verificationUncertain: !confirmed,
      },
    });
    const plan = normalizeRunPlan({
      schemaVersion: 3, taskKind: 'session_refresh', workerConcurrency: 1,
      oauthSource: { kind: 'session_assets', assetIds: [asset.id] },
      proxyAssignments: [{ workerSlot: 1, kind: 'maintenance' }], security: {},
    }, config);
    const state = makeInitialBranchState(config, plan, { runId: `refresh-email-change-${confirmed}` });
    let calls = 0;
    await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
      assetStore: store,
      proxyEntries: [{ id: 'maintenance-test', url: 'http://127.0.0.1:7890', resourceKind: 'maintenance', workerSlots: [1] }],
      trialChecker: async () => ({ status: 'unknown' }),
      sessionRunnerFactory: ({ job, options }) => ({
        async run(current, runOptions) {
          calls++;
          assert.equal(options.proxy, 'http://127.0.0.1:7890');
          assert.equal(runOptions.existingOnly, true);
          assert.deepEqual(options.confirmedEmailChange, confirmed ? {
            previousEmail: 'old@icloud.com', email: asset.email, accountId: asset.accountId,
          } : undefined);
          if (calls === 1) throw Object.assign(new Error('old token revoked'), { code: 'TOKEN_REVOKED', status: 401 });
          assert.equal(current.email, asset.email);
          assert.equal(current.password, asset.password);
          assert.equal(current.totpSecret, asset.totpSecret);
          finishSession(current, job);
          current.accountId = asset.accountId;
        },
      }),
    });
    assert.equal(state.status, 'complete');
    assert.equal(calls, 2);
    assert.equal(store.get(asset.id).email, asset.email);
  });
}

test('runtime rejects a mailbox client from another provider before pool access', () => {
  const config = branchConfig(1);
  config.mail.provider = 'fastmail';
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);

  assert.throws(
    () => assertMailClientProvider({ mailProvider: 'xiaopingguo' }, config, plan, 'runtime'),
    (error) => {
      assert.equal(error.code, 'MAIL_CLIENT_PROVIDER_MISMATCH');
      assert.equal(error.expectedProvider, 'fastmail');
      assert.equal(error.actualProvider, 'xiaopingguo');
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test('registration-session workers serialize aliases per root and never acquire SMS when no phone challenge appears', async (t) => {
  const config = branchConfig(2);
  config.mail.count = 2;
  config.aliases.count = 2;
  config.aliases.maxAttempts = 2;
  const plan = normalizeRunPlan({
    schemaVersion: 3,
    taskKind: 'register_session',
    mailCount: 2,
    workerConcurrency: 2,
    aliasStrategy: 'plus',
    aliasCount: 2,
    aliasMaxAttempts: 2,
    aliasRunTag: 'lane',
    proxyAssignments: [
      { workerSlot: 1, kind: 'local', localProxyId: 'proxy-one' },
      { workerSlot: 2, kind: 'local', localProxyId: 'proxy-two' },
    ],
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-session-lanes' });
  const store = temporaryStore(t);
  const mail = mailboxClient([
    { id: 'mail-1', email: 'one@example.test', tokenValid: true, bound: false },
    { id: 'mail-2', email: 'two@example.test', tokenValid: true, bound: false },
  ]);
  const activeByLane = new Set();
  let globalActive = 0;
  let maxGlobalActive = 0;
  let smsAcquires = 0;
  const proxyByLane = new Map();

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: store,
    mailClient: mail,
    proxyEntries: [
      { id: 'proxy-one', url: 'http://127.0.0.1:4101', workerSlots: [1] },
      { id: 'proxy-two', url: 'http://127.0.0.1:4102', workerSlots: [2] },
    ],
    smsProvider: { async acquireNumber() { smsAcquires += 1; throw new Error('SMS must remain conditional'); } },
    sessionRunnerFactory: ({ job, worker }) => ({
      async run(sessionState) {
        assert.equal(activeByLane.has(job.laneId), false, `lane ${job.laneId} overlapped`);
        // Each slot owns exactly one proxy here, so the per-account rebind
        // lands on the same exit; what matters is the lane stays on its slot.
        const previousProxy = proxyByLane.get(job.laneId);
        if (previousProxy) assert.equal(worker.proxy.id, previousProxy, `lane ${job.laneId} changed slot`);
        else proxyByLane.set(job.laneId, worker.proxy.id);
        activeByLane.add(job.laneId);
        globalActive += 1;
        maxGlobalActive = Math.max(maxGlobalActive, globalActive);
        await new Promise((resolve) => setTimeout(resolve, 15));
        finishSession(sessionState, job);
        globalActive -= 1;
        activeByLane.delete(job.laneId);
      },
    }),
  });

  assert.equal(state.status, 'complete');
  assert.equal(state.jobs.length, 4);
  assert.equal(state.jobs.every((job) => job.status === 'complete'), true);
  assert.equal(store.list().length, 4);
  assert.equal(store.list().every((asset) => asset.health?.status === 'healthy'), true);
  assert.equal(store.list().every((asset) => asset.health?.code === 'SESSION_VERIFIED'), true);
  assert.equal(smsAcquires, 0);
  assert.equal(maxGlobalActive, 2);
  assert.equal(proxyByLane.size, 2);
  assert.deepEqual(mail.reserved.sort(), ['mail-1', 'mail-2']);
  assert.equal(state.events.some((event) => event.type === 'worker_proxy_bound'), true);
  // One bind per account: the exit is released after every account, even
  // between a root and its alias.
  assert.equal(state.events.filter((event) => event.type === 'worker_proxy_bound').length, 4);
});

test('cancelling during worker proxy health check completes as cancelled', async (t) => {
  const config = branchConfig(1);
  config.proxyPool.healthCheck = {
    enabled: true,
    probeUrl: 'https://auth.openai.com/',
    timeoutMs: 5000,
  };
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
    proxyAssignments: [{ workerSlot: 1, kind: 'local', localProxyId: 'proxy-hanging' }],
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-cancel-proxy-check' });
  const store = temporaryStore(t);
  const mail = mailboxClient([{ id: 'mail-cancel-proxy', email: 'cancel-proxy@example.test', tokenValid: true, bound: false }]);
  const proxy = net.createServer(() => {});
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => proxy.close());
  let action = '';
  const controller = new AbortController();
  setTimeout(() => {
    action = 'cancel';
    controller.abort('cancel');
  }, 75);

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: store,
    mailClient: mail,
    proxyEntries: [{
      id: 'proxy-hanging',
      url: `http://127.0.0.1:${proxy.address().port}`,
      workerSlots: [1],
    }],
    control: {
      requestedAction: () => action,
      signal: controller.signal,
    },
  });

  assert.equal(state.status, 'cancelled');
  assert.equal(state.jobs[0].status, 'cancelled');
  assert.deepEqual(mail.released, ['mail-cancel-proxy']);
});

test('cancellation preserves a job failure reason', async () => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-cancel-preserves-error' });
  const failure = { code: 'RATE_LIMIT_EXCEEDED', message: 'phone request was throttled' };
  state.jobs.push({
    id: 'job-cancel-preserves-error',
    email: 'failed-before-cancel@example.test',
    parentEmail: 'failed-before-cancel@example.test',
    mailboxId: '',
    laneId: 'failed-before-cancel@example.test',
    status: 'waiting',
    phase: 'waiting_error',
    error: failure,
    sms: { current: null, attempts: [], acquisitions: [], costUsd: 0, replacements: 0, sendRetries: 0 },
  });

  await cancelBranchState(state, config, { mailClient: mailboxClient([]), smsProvider: {} });

  assert.equal(state.status, 'cancelled');
  assert.equal(state.jobs[0].status, 'cancelled');
  assert.deepEqual(state.jobs[0].error, failure);
});

test('cancellation received while a pause is draining completes as cancelled', async (t) => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-cancel-during-pause-drain' });
  const store = temporaryStore(t);
  const mail = mailboxClient([{ id: 'mail-pause-drain', email: 'pause-drain@example.test', tokenValid: true, bound: false }]);
  const gate = new ControlGate();
  let releaseJob;
  const jobRelease = new Promise((resolve) => { releaseJob = resolve; });
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  let cancelRequestedResolve;
  const cancelRequested = new Promise((resolve) => { cancelRequestedResolve = resolve; });

  const run = runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: store,
    mailClient: mail,
    control: gate,
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        startedResolve();
        gate.request('pause');
        setImmediate(() => {
          gate.request('cancel');
          cancelRequestedResolve();
        });
        await jobRelease;
        throw Object.assign(new Error('registration interrupted by cancellation'), { code: 'TASK_INTERRUPTED' });
      },
    }),
  });

  await started;
  await cancelRequested;
  releaseJob();
  await run;

  assert.equal(state.status, 'cancelled');
  assert.equal(state.phase, 'cancelled');
  assert.equal(state.control.requestedAction, null);
  assert.equal(state.jobs[0].status, 'cancelled');
  assert.deepEqual(mail.released, ['mail-pause-drain']);
});

test('registration-session keeps the same alias and receives arrived mail after refresh busy', async (t) => {
  const config = branchConfig(1);
  config.aliases.strategy = 'root';
  config.aliases.count = 1;
  config.aliases.maxAttempts = 1;
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-mail-refresh-busy' });
  const mail = mailboxClient([{ id: 'mail-busy', email: 'busy@example.test', tokenValid: true, bound: false }]);
  let polls = 0;
  mail.snapshotMailbox = async () => ({ messageIds: ['baseline'], capturedAt: new Date().toISOString() });
  mail.findVerificationCode = async () => {
    polls += 1;
    if (polls === 1) {
      throw Object.assign(new Error('xiaopingguo mail failed: account refresh busy'), {
        status: 409,
        retryAfterMs: 10,
        response: { error: 'account refresh busy' },
      });
    }
    return { code: '483921', messageId: 'arrived-message', receivedAt: new Date().toISOString() };
  };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    sessionRunnerFactory: ({ job, options }) => ({
      async run(sessionState) {
        const boundary = await options.beforeEmailSend();
        const code = await options.getEmailCode(job.email, boundary);
        assert.equal(code.code, '483921');
        finishSession(sessionState, job);
      },
    }),
  });

  assert.equal(state.status, 'complete', JSON.stringify({ status: state.status, phase: state.phase, job: state.jobs[0], events: state.events.slice(-30) }));
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].emailMessageId, 'arrived-message');
  assert.equal(polls, 2);
  assert.ok(state.events.some((record) => record.type === 'email_provider_backoff'));
});

test('an address that never answers is skipped once the poll budget is spent, not retried', async (t) => {
  // Three polls with nothing matching is the provider's answer, not a blip.
  // Retrying re-ran registration up to the send and waited the window out again
  // four more times, holding a Worker and a proxy against a settled outcome.
  const config = branchConfig(1);
  config.mail.timeoutMs = 60000;
  config.mail.pollIntervalMs = 1;
  config.mail.maxPollAttempts = 3;
  config.aliases.strategy = 'root';
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-email-budget-skip' });
  const mail = mailboxClient([{ id: 'mail-silent', email: 'silent@example.test', tokenValid: true, bound: false }]);
  let runnerCalls = 0;
  let polls = 0;
  mail.snapshotMailbox = async () => ({ messageIds: [], capturedAt: new Date().toISOString() });
  mail.findVerificationCode = async () => { polls += 1; return null; };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    retryPolicies: { waiting_transient: { delaysMs: [1], maxRetries: 3 } },
    assetStore: temporaryStore(t),
    mailClient: mail,
    sessionRunnerFactory: ({ job, options }) => ({
      async run(sessionState) {
        runnerCalls += 1;
        const boundary = await options.beforeEmailSend(job.email, sessionState, { purpose: 'registration' });
        sessionState.step = 'email_otp_sent';
        sessionState.events.push({ type: 'email_otp_sent', at: new Date().toISOString() });
        await options.getEmailCode(job.email, boundary);
      },
    }),
  });

  assert.equal(polls, 3);
  assert.equal(runnerCalls, 1, 'the registration must not be replayed for an address that gave its answer');
  assert.equal(state.jobs[0].status, 'skipped');
  assert.equal(state.jobs[0].error.code, 'EMAIL_OTP_TIMEOUT');
  assert.match(state.jobs[0].error.message, /轮询 3 次/);
  assert.equal(state.events.some((record) => record.type === 'branch_job_skipped'), true);
  // Reported so the domain's health can be judged on evidence.
  assert.deepEqual(mail.delivery, [{ address: 'silent@example.test', delivered: false }]);
});

test('an operator skip clears a stale retry while SMS cleanup is pending', async (t) => {
  const config = branchConfig(1);
  config.aliases.strategy = 'root';
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-manual-skip-cleanup' });
  state.mailboxes = [{
    id: 'mail-skip',
    email: 'skip@example.test',
    rootEmail: 'skip@example.test',
    status: 'reserved',
    workerId: '',
    targetCount: 1,
    createdCount: 0,
    attemptCount: 1,
    normalComplete: false,
  }];
  state.jobs = [{
    id: 'job-manual-skip',
    taskKind: 'register_session',
    email: 'skip@example.test',
    parentEmail: 'skip@example.test',
    mailboxId: 'mail-skip',
    laneId: 'mail-skip',
    aliasIndex: 1,
    status: 'waiting',
    phase: 'waiting_transient',
    nextRunAt: new Date(Date.now() - 1).toISOString(),
    retry: { phase: 'waiting_transient', attempts: 2, firstAt: new Date().toISOString() },
    sms: { current: { id: 'sms-skip', status: 'active' }, attempts: [], replacements: 0 },
    error: { code: 'TRANSIENT', message: 'retry this before the operator skipped it' },
  }];
  const smsProvider = {
    async cancel() { throw new Error('SMS provider cleanup is temporarily unavailable'); },
  };

  await skipBranchJob(state, config, 'job-manual-skip', {
    smsProvider,
    saveState: async () => {},
    assetStore: temporaryStore(t),
  });

  assert.equal(state.jobs[0].status, 'waiting');
  assert.equal(state.jobs[0].phase, 'waiting_sms_cleanup');
  assert.equal(state.jobs[0].nextRunAt, '');
  assert.equal(state.jobs[0].retry, null);
  assert.ok(state.jobs[0].skipPending);

  let runnerCalls = 0;
  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([{ id: 'mail-skip', email: 'skip@example.test', tokenValid: true, bound: false }]),
    smsProvider,
    sessionRunnerFactory: () => ({ async run() { runnerCalls += 1; } }),
  });

  assert.equal(runnerCalls, 0);
  assert.equal(state.jobs[0].status, 'waiting');
  assert.equal(state.jobs[0].phase, 'waiting_sms_cleanup');
  assert.ok(state.jobs[0].skipPending);
});

test('an operator skip completes an SMS activation when the final status check receives the code', async () => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-skip-code-race' });
  state.jobs = [{
    id: 'job-skip-code-race',
    email: 'skip-code@example.test',
    parentEmail: 'skip-code@example.test',
    mailboxId: '',
    laneId: 'skip-code@example.test',
    status: 'waiting',
    phase: 'waiting_sms_cleanup',
    sms: {
      current: {
        id: 'activation-skip-code-race',
        activationId: 'activation-skip-code-race',
        number: '+56912345678',
        status: 'waiting_code',
      },
      attempts: [],
      costUsd: 0.02,
      replacements: 0,
      sendRetries: 0,
    },
  }];
  let reconcileCalls = 0;
  let completeCalls = 0;
  let cancelCalls = 0;
  const smsProvider = {
    async reconcile(lease) {
      reconcileCalls += 1;
      return reconcileCalls === 1
        ? { ...lease, status: 'waiting_code', providerStatus: 'STATUS_WAIT_CODE' }
        : { ...lease, status: 'code_received', providerStatus: 'STATUS_OK', code: '123456' };
    },
    async complete(lease) {
      completeCalls += 1;
      return { ...lease, status: 'complete', providerStatus: 'STATUS_OK' };
    },
    async cancel() {
      cancelCalls += 1;
      throw new Error('cancel must not run after the code is observed');
    },
  };

  await skipBranchJob(state, config, 'job-skip-code-race', {
    smsProvider,
    saveState: async () => {},
  });

  assert.equal(reconcileCalls, 2);
  assert.equal(completeCalls, 1);
  assert.equal(cancelCalls, 0);
  assert.equal(state.jobs[0].status, 'skipped');
  assert.equal(state.jobs[0].phase, 'skipped');
  assert.equal(state.jobs[0].skipPending, null);
  assert.equal(state.jobs[0].sms.current, null);
  assert.equal(state.jobs[0].sms.attempts[0].status, 'complete');
});

test('an operator skip recovers when SMSBower rejects cancellation after the code arrives', async () => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-skip-late-code' });
  state.jobs = [{
    id: 'job-skip-late-code',
    email: 'skip-late@example.test',
    parentEmail: 'skip-late@example.test',
    mailboxId: '',
    laneId: 'skip-late@example.test',
    status: 'waiting',
    phase: 'waiting_sms_cleanup',
    sms: {
      current: {
        id: 'activation-skip-late-code',
        activationId: 'activation-skip-late-code',
        number: '+56912345678',
        status: 'waiting_code',
      },
      attempts: [],
      costUsd: 0.02,
      replacements: 0,
      sendRetries: 0,
    },
  }];
  let reconcileCalls = 0;
  let completeCalls = 0;
  let cancelCalls = 0;
  const smsProvider = {
    async reconcile(lease) {
      reconcileCalls += 1;
      return reconcileCalls < 3
        ? { ...lease, status: 'waiting_code', providerStatus: 'STATUS_WAIT_CODE' }
        : { ...lease, status: 'code_received', providerStatus: 'STATUS_OK', code: '654321' };
    },
    async complete(lease) {
      completeCalls += 1;
      return { ...lease, status: 'complete', providerStatus: 'STATUS_OK' };
    },
    async cancel() {
      cancelCalls += 1;
      throw Object.assign(new Error('SMSBower setStatus failed: BAD_STATUS'), { code: 'BAD_STATUS' });
    },
  };

  await skipBranchJob(state, config, 'job-skip-late-code', {
    smsProvider,
    saveState: async () => {},
  });

  assert.equal(reconcileCalls, 3);
  assert.equal(completeCalls, 1);
  assert.equal(cancelCalls, 1);
  assert.equal(state.jobs[0].status, 'skipped');
  assert.equal(state.jobs[0].sms.current, null);
  assert.equal(state.jobs[0].sms.attempts[0].status, 'complete');
});

test('an empty email wait skips after its deadline without replaying registration', async (t) => {
  const config = branchConfig(1);
  config.mail.timeoutMs = 20;
  config.mail.pollIntervalMs = 1;
  // Keep the poll budget out of reach so this covers the wall-clock exit used
  // by the remote Mail.com long-poll path.
  config.mail.maxPollAttempts = 200;
  config.aliases.strategy = 'root';
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-email-timeout-skip' });
  const mail = mailboxClient([{ id: 'mail-timeout', email: 'timeout@example.test', tokenValid: true, bound: false }]);
  let runnerCalls = 0;
  let polls = 0;
  mail.snapshotMailbox = async () => ({ messageIds: [], capturedAt: new Date().toISOString() });
  mail.findVerificationCode = async () => { polls += 1; return null; };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    retryPolicies: { waiting_transient: { delaysMs: [1], maxRetries: 3 } },
    assetStore: temporaryStore(t),
    mailClient: mail,
    sessionRunnerFactory: ({ job, options }) => ({
      async run(sessionState) {
        runnerCalls += 1;
        const boundary = await options.beforeEmailSend(job.email, sessionState, { purpose: 'registration' });
        sessionState.step = 'email_otp_sent';
        sessionState.events.push({ type: 'email_otp_sent', at: new Date().toISOString() });
        await options.getEmailCode(job.email, boundary);
      },
    }),
  });

  assert.equal(runnerCalls, 1, 'an empty mailbox must not replay registration');
  assert.ok(polls > 0);
  assert.equal(state.jobs[0].status, 'skipped');
  assert.equal(state.jobs[0].error.code, 'EMAIL_OTP_TIMEOUT');
  assert.equal(state.events.some((record) => record.type === 'branch_job_retry_scheduled'), false);
  assert.deepEqual(mail.delivery, [{ address: 'timeout@example.test', delivered: false }]);
});

test('an exhausted email wait retry cannot leave a job parked', async (t) => {
  const config = branchConfig(1);
  config.aliases.strategy = 'root';
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-email-retry-exhausted' });
  const mail = mailboxClient([{ id: 'mail-retry-exhausted', email: 'retry-exhausted@example.test', tokenValid: true, bound: false }]);
  let runnerCalls = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    retryPolicies: { waiting_transient: { delaysMs: [1], maxRetries: 1 } },
    assetStore: temporaryStore(t),
    mailClient: mail,
    sessionRunnerFactory: () => ({
      async run() {
        runnerCalls += 1;
        throw Object.assign(new Error('email wait expired'), {
          code: 'EMAIL_OTP_TIMEOUT',
          retryable: true,
          category: 'transient',
          waitPhase: 'waiting_transient',
        });
      },
    }),
  });

  assert.equal(runnerCalls, 2);
  assert.equal(state.jobs[0].status, 'skipped');
  assert.equal(state.jobs[0].phase, 'skipped');
  assert.equal(state.jobs[0].nextRunAt, '');
  assert.equal(state.jobs[0].retry, null);
  assert.equal(state.events.some((record) => record.type === 'branch_job_skipped'), true);
});

test('an email provider timeout is retryable without discarding the mailbox', async (t) => {
  const config = branchConfig(1);
  config.mail.timeoutMs = 20;
  config.mail.pollIntervalMs = 1;
  config.aliases.strategy = 'root';
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-email-provider-retry' });
  const mail = mailboxClient([{ id: 'mail-provider-timeout', email: 'provider-timeout@example.test', tokenValid: true, bound: false }]);
  let runnerCalls = 0;
  let providerFailures = 0;
  mail.snapshotMailbox = async () => ({ messageIds: [], capturedAt: new Date().toISOString() });
  mail.findVerificationCode = async () => {
    if (runnerCalls > 1) return { code: '483921', messageId: 'arrived-after-provider-retry' };
    providerFailures += 1;
    throw Object.assign(new Error('mail API temporarily unavailable'), { status: 503 });
  };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    retryPolicies: { waiting_transient: { delaysMs: [1], maxRetries: 1 } },
    assetStore: temporaryStore(t),
    mailClient: mail,
    sessionRunnerFactory: ({ job, options }) => ({
      async run(sessionState) {
        runnerCalls += 1;
        const boundary = await options.beforeEmailSend(job.email, sessionState, { purpose: 'registration' });
        sessionState.step = 'email_otp_sent';
        sessionState.events.push({ type: 'email_otp_sent', at: new Date().toISOString() });
        const found = await options.getEmailCode(job.email, boundary);
        assert.equal(found.code, '483921');
        finishSession(sessionState, job);
      },
    }),
  });

  assert.equal(runnerCalls, 2);
  assert.ok(providerFailures > 0);
  assert.equal(state.jobs[0].status, 'complete');
  assert.equal(state.jobs[0].emailMessageId, 'arrived-after-provider-retry');
  assert.equal(state.events.some((record) => record.type === 'email_provider_backoff'), true);
  assert.deepEqual(mail.released, []);
});

test('a bare fetch failure uses the transient retry lane', async (t) => {
  const config = branchConfig(1);
  config.aliases.strategy = 'root';
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-fetch-failure-retry' });
  const mail = mailboxClient([{ id: 'mail-fetch-failure', email: 'fetch-failure@example.test', tokenValid: true, bound: false }]);
  let runnerCalls = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    retryPolicies: { waiting_transient: { delaysMs: [1], maxRetries: 1 } },
    assetStore: temporaryStore(t),
    mailClient: mail,
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        runnerCalls += 1;
        if (runnerCalls === 1) throw new TypeError('fetch failed');
        finishSession(sessionState, job);
      },
    }),
  });

  assert.equal(runnerCalls, 2);
  assert.equal(state.status, 'complete', JSON.stringify({ status: state.status, phase: state.phase, job: state.jobs[0], events: state.events.slice(-30) }));
  assert.equal(state.jobs[0].status, 'complete');
  assert.equal(state.events.some((record) => record.type === 'branch_job_retry_scheduled'), true);
});

test('a spent callback code is replaced by one fresh login instead of replaying it', async (t) => {
  // 2026-10-10: the first callback timed out after reaching OpenAI, and every
  // replay of the same URL — eight of them across five exits — came back as
  // the OAuthCallback error page. The code is single-use; only a new login
  // can produce another.
  const config = branchConfig(1);
  config.aliases.strategy = 'root';
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-created-account-recovery' });
  const mail = mailboxClient([{ id: 'mail-created', email: 'created@example.test', tokenValid: true, bound: false }]);
  const calls = [];

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    retryPolicies: { waiting_proxy_retry: { delaysMs: [1], maxRetries: 1 } },
    assetStore: temporaryStore(t),
    mailClient: mail,
    sessionRunnerFactory: ({ job, worker }) => ({
      async run(sessionState, options = {}) {
        calls.push({ step: sessionState.step, existingOnly: options.existingOnly === true, password: sessionState.password, passwordStatus: sessionState.security?.passwordStatus, worker: worker.id, proxyId: worker.proxyId });
        if (calls.length === 1) {
          sessionState.password = 'registered-password';
          sessionState.security = { ...(sessionState.security || {}), setPassword: true, passwordStatus: 'configured' };
          sessionState.accountCreated = true;
          sessionState.step = 'auth_callback_pending';
          throw Object.assign(new Error('NextAuth callback returned an error page (error_param:OAuthCallback)'), {
            code: 'AUTH_CALLBACK_ERROR_PAGE',
            callbackErrorReason: 'error_param:OAuthCallback',
            accountCreated: true,
          });
        }
        finishSession(sessionState, job);
      },
    }),
  });

  assert.equal(calls.length, 2, 'one fresh login, no replay of the spent URL');
  assert.equal(state.jobs[0].status, 'complete');
  assert.notEqual(state.jobs[0].accountCreatedAt, '');
  // The second pass is a login to the existing account, from the start, with
  // the registration password kept and not set again.
  assert.equal(calls[1].step, 'initial');
  assert.equal(calls[1].existingOnly, true);
  assert.equal(calls[1].password, 'registered-password');
  assert.equal(calls[1].passwordStatus, 'configured');
  assert.equal(calls[1].worker, calls[0].worker);
  assert.equal(calls[1].proxyId, calls[0].proxyId);
  assert.equal(state.jobs[0].callbackLoginRecovery.status, 'complete');
  assert.equal(state.events.some((record) => record.type === 'auth_callback_login_recovery_started'), true);
  assert.equal(state.events.some((record) => record.type === 'auth_callback_proxy_retry_scheduled'), false);
});

test('a callback that errors on every exit is skipped instead of looping across resumes', async (t) => {
  const config = branchConfig(1);
  config.aliases.strategy = 'root';
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-callback-dead-end' });
  const mail = mailboxClient([{ id: 'mail-dead-end', email: 'deadend@example.test', tokenValid: true, bound: false }]);
  let runnerCalls = 0;

  // The account is created and the callback then refuses it, forever, on every
  // exit. The run must stop after the bounded fresh-exit recovery budget.
  const options = () => ({
    retryPolicies: {
      waiting_proxy_retry: { delaysMs: [1], maxRetries: 1, onExhausted: 'restart_on_fresh_exit' },
      waiting_proxy_rotation: { delaysMs: [1], maxRetries: 1 },
    },
    assetStore: temporaryStore(t),
    mailClient: mail,
    sessionRunnerFactory: () => ({
      async run(sessionState) {
        runnerCalls += 1;
        sessionState.accountCreated = true;
        sessionState.step = 'auth_callback_pending';
        throw Object.assign(new Error('NextAuth callback returned an error page'), {
          code: 'AUTH_CALLBACK_ERROR_PAGE',
          accountCreated: true,
        });
      },
    }),
  });

  let passes = 0;
  for (; passes < 8; passes += 1) {
    await runBranchOrchestrator({ log: { entries: [] } }, state, config, options());
    if (state.jobs[0].status !== 'waiting') break;
    resumeBranchState(state);
  }

  assert.equal(state.jobs[0].status, 'skipped');
  // The spent code is not replayed: one fresh login, and when its callback is
  // refused too the account stops as a callback failure in the same pass.
  assert.equal(passes, 0);
  assert.equal(runnerCalls, 2);
  assert.equal(state.jobs[0].callbackLoginRecovery.status, 'failed');
  assert.equal(state.jobs[0].error.callbackFailure, true);
  const skipped = state.events.find((record) => record.type === 'branch_job_skipped');
  assert.equal(skipped?.code, 'AUTH_CALLBACK_ERROR_PAGE');
});

test('created-account callback retries each proxy twice and rebuilds the context after rotation', async (t) => {
  const config = branchConfig(1);
  config.proxyPool.required = true;
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-callback-proxy-budget' });
  const callbackUrl = 'https://auth.openai.com/api/auth/callback/openai?state=callback-state';
  const proxies = [
    { id: 'callback-proxy-a', url: 'http://callback-proxy-a:4101' },
    { id: 'callback-proxy-b', url: 'http://callback-proxy-b:4102' },
    { id: 'callback-proxy-c', url: 'http://callback-proxy-c:4103' },
  ];
  const seen = [];
  let runnerCalls = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    retryPolicies: {
      waiting_proxy_retry: { delaysMs: [1, 1], maxRetries: 2 },
      waiting_proxy_rotation: { delaysMs: [1], maxRetries: 1, jitterRatio: 0 },
    },
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([{ id: 'mail-callback-budget', email: 'callback-budget@example.test', tokenValid: true, bound: false }]),
    proxyEntries: proxies,
    proxyProbeExecutor: async (_request, probeOptions) => ({ response: { status: 200, url: probeOptions.proxy } }),
    random: () => 0.999,
    sessionRunnerFactory: ({ job, worker, options }) => {
      seen.push({ proxyId: worker.proxyId, proxy: options.proxy, step: job.sessionState?.step || '' });
      return {
        async run(sessionState) {
          runnerCalls += 1;
          if (runnerCalls < 8) {
            if (runnerCalls > 1) {
              assert.equal(sessionState.step, 'auth_callback_pending');
              assert.equal(sessionState.pendingAuthCallbackUrl, callbackUrl);
              assert.deepEqual(sessionState.cookieJar, { cookies: [{ key: 'callback-cookie' }] });
            }
            sessionState.accountCreated = true;
            sessionState.step = 'auth_callback_pending';
            sessionState.status = 'running';
            sessionState.pendingAuthCallbackUrl = callbackUrl;
            sessionState.continueUrl = callbackUrl;
            sessionState.cookieJar = { cookies: [{ key: 'callback-cookie' }] };
            // Unanswered, not refused: the code may still be good, so the
            // callback is replayed — unlike an error page, which means spent.
            throw Object.assign(new Error('Request to chatgpt.com callback timed out'), {
              code: 'ETIMEDOUT',
              accountCreated: true,
            });
          }
          assert.equal(sessionState.step, 'auth_callback_pending');
          assert.equal(sessionState.pendingAuthCallbackUrl, callbackUrl);
          finishSession(sessionState, job);
        },
      };
    },
  });

  assert.equal(state.status, 'complete');
  assert.equal(state.jobs[0].status, 'complete');
  assert.equal(runnerCalls, 8, 'three attempts on each of the first two exits, then two on the last exit');
  assert.equal(seen.length, runnerCalls);
  assert.equal(seen[0].proxyId, seen[1].proxyId);
  assert.equal(seen[1].proxyId, seen[2].proxyId);
  assert.notEqual(seen[2].proxyId, seen[3].proxyId);
  assert.equal(seen[3].proxyId, seen[4].proxyId);
  assert.equal(seen[4].proxyId, seen[5].proxyId);
  assert.notEqual(seen[5].proxyId, seen[6].proxyId);
  assert.equal(seen[6].proxyId, seen[7].proxyId);
  assert.equal(state.jobs[0].freshExitRestarts, 2);
  assert.equal(state.jobs[0].authCallbackProxyRecovery.proxyChanges, 2);
  assert.equal(state.events.filter((record) => record.type === 'auth_callback_proxy_context_rebuilt').length, 2);
  assert.equal(state.events.some((record) => record.type === 'PROXY_TRANSPORT_RECOVERY_EXHAUSTED'), false);
});

test('created-account callback exhaustion ends with a callback failure after two proxy changes', async (t) => {
  const config = branchConfig(1);
  config.proxyPool.required = true;
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-callback-proxy-exhausted' });
  let runnerCalls = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    retryPolicies: {
      waiting_proxy_retry: { delaysMs: [1, 1], maxRetries: 2 },
      waiting_proxy_rotation: { delaysMs: [1], maxRetries: 1, jitterRatio: 0 },
    },
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([{ id: 'mail-callback-exhausted', email: 'callback-exhausted@example.test', tokenValid: true, bound: false }]),
    proxyEntries: [
      { id: 'callback-exhausted-a', url: 'http://callback-exhausted-a:4101' },
      { id: 'callback-exhausted-b', url: 'http://callback-exhausted-b:4102' },
      { id: 'callback-exhausted-c', url: 'http://callback-exhausted-c:4103' },
    ],
    proxyProbeExecutor: async (_request, probeOptions) => ({ response: { status: 200, url: probeOptions.proxy } }),
    random: () => 0.999,
    sessionRunnerFactory: () => ({
      async run(sessionState) {
        runnerCalls += 1;
        sessionState.accountCreated = true;
        sessionState.step = 'auth_callback_pending';
        sessionState.pendingAuthCallbackUrl = 'https://auth.openai.com/api/auth/callback/openai?state=exhausted';
        throw Object.assign(new Error('Request to chatgpt.com callback timed out'), {
          code: 'ETIMEDOUT',
          accountCreated: true,
        });
      },
    }),
  });

  const job = state.jobs[0];
  assert.equal(state.status, 'complete');
  assert.equal(job.status, 'skipped');
  assert.equal(job.freshExitRestarts, 2);
  assert.equal(runnerCalls, 9);
  assert.match(job.error.message, /authentication callback failed/i);
  assert.equal(job.error.code, 'ETIMEDOUT');
  assert.equal(job.error.code === 'PROXY_TRANSPORT_RECOVERY_EXHAUSTED', false);
  assert.equal(job.authCallbackProxyRecovery.exhausted, true);
});

test('created-account callback refreshes an empty proxy pool and resumes on the new exit', async (t) => {
  const config = branchConfig(1);
  config.proxyPool.required = true;
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-callback-proxy-refresh' });
  const callbackUrl = 'https://auth.openai.com/api/auth/callback/openai?state=refresh';
  const initialProxy = { id: 'callback-refresh-a', url: 'http://callback-refresh-a:4101' };
  const refreshedProxy = { id: 'callback-refresh-b', url: 'http://callback-refresh-b:4102' };
  let runnerCalls = 0;
  let refreshes = 0;
  const used = [];

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    retryPolicies: {
      waiting_proxy_retry: { delaysMs: [1, 1], maxRetries: 2 },
      waiting_proxy_rotation: { delaysMs: [1], maxRetries: 1, jitterRatio: 0 },
      waiting_proxy_pool: { delaysMs: [1], maxRetries: 1, jitterRatio: 0 },
    },
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([{ id: 'mail-callback-refresh', email: 'callback-refresh@example.test', tokenValid: true, bound: false }]),
    proxyEntries: [initialProxy],
    refreshProxyResources: async (details) => {
      refreshes += 1;
      assert.deepEqual(details.workerSlots, [1]);
      return { snapshot: { schemaVersion: 1, entries: [initialProxy, refreshedProxy] } };
    },
    proxyProbeExecutor: async (_request, probeOptions) => ({ response: { status: 200, url: probeOptions.proxy } }),
    sessionRunnerFactory: ({ job, worker }) => ({
      async run(sessionState) {
        runnerCalls += 1;
        used.push(worker.proxyId);
        if (runnerCalls <= 3) {
          sessionState.accountCreated = true;
          sessionState.step = 'auth_callback_pending';
          sessionState.pendingAuthCallbackUrl = callbackUrl;
          sessionState.cookieJar = { cookies: [{ key: 'callback-cookie' }] };
          // A callback that never answered: the code may still be good, so
            // it is replayed — unlike an error page, which means it is spent.
            throw Object.assign(new Error('Request to chatgpt.com callback timed out'), {
            code: 'ETIMEDOUT',
            accountCreated: true,
          });
        }
        assert.equal(sessionState.step, 'auth_callback_pending');
        assert.equal(sessionState.pendingAuthCallbackUrl, callbackUrl);
        assert.deepEqual(sessionState.cookieJar, { cookies: [{ key: 'callback-cookie' }] });
        finishSession(sessionState, job);
      },
    }),
  });

  assert.equal(state.status, 'complete');
  assert.equal(state.jobs[0].status, 'complete');
  assert.equal(refreshes, 1);
  assert.equal(runnerCalls, 4);
  assert.deepEqual(used.slice(0, 3), [initialProxy.id, initialProxy.id, initialProxy.id]);
  assert.equal(used[3], refreshedProxy.id);
  assert.equal(state.jobs[0].freshExitRestarts, 1);
  assert.equal(state.events.some((record) => record.type === 'proxy_resources_refreshed_for_waiting_workers'), true);
  assert.equal(state.events.filter((record) => record.type === 'auth_callback_proxy_context_rebuilt').length, 1);
});

test('password setup takes a fresh mailbox boundary without replacing the registration boundary', async (t) => {
  const config = branchConfig(1);
  config.aliases.strategy = 'root';
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-fresh-password-boundary' });
  const mail = mailboxClient([{ id: 'mail-fresh', email: 'fresh@example.test', tokenValid: true, bound: false }]);
  let snapshots = 0;
  mail.snapshotMailbox = async () => {
    snapshots += 1;
    return { messageIds: [`snapshot-${snapshots}`], capturedAt: `2026-08-05T00:00:0${snapshots}.000Z` };
  };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    sessionRunnerFactory: ({ job, options }) => ({
      async run(sessionState) {
        const registration = await options.beforeEmailSend(job.email, sessionState, { purpose: 'registration' });
        const cached = await options.beforeEmailSend(job.email, sessionState, { purpose: 'registration' });
        const password = await options.beforeEmailSend(job.email, sessionState, { fresh: true, purpose: 'password_setup' });
        assert.deepEqual(cached, registration);
        assert.notDeepEqual(password, registration);
        finishSession(sessionState, job);
      },
    }),
  });

  assert.equal(snapshots, 2);
  assert.deepEqual(state.jobs[0].emailBoundary.messageIds, ['snapshot-1']);
  assert.equal(state.events.filter((record) => record.type === 'email_boundary_captured').length, 2);
});

test('registration aliases share one master mailbox baseline while keeping job boundaries independent', { timeout: 10000 }, async (t) => {
  const config = branchConfig(3);
  config.mail.provider = 'fastmail';
  config.mail.count = 3;
  config.aliases.strategy = 'root';
  config.aliases.count = 1;
  config.aliases.maxAttempts = 1;
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 3,
    workerConcurrency: 3,
    aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-shared-master-boundary' });
  const accounts = [1, 2, 3].map((index) => ({
    id: `mail-shared-${index}`,
    email: `alias-${index}@fastmail.com`,
    parent: 'testuser@fastmail.com',
    rootEmail: 'testuser@fastmail.com',
    tokenValid: true,
    bound: false,
  }));
  const mail = mailboxClient(accounts);
  mail.remoteRegistrationAddresses = true;
  mail.consumeMailbox = async (id) => ({ mailbox: { id, cycle: 1 }, recycle: null });
  let snapshots = 0;
  let activeSnapshots = 0;
  let maxActiveSnapshots = 0;
  const boundaries = [];
  mail.snapshotMailbox = async () => {
    snapshots += 1;
    activeSnapshots += 1;
    maxActiveSnapshots = Math.max(maxActiveSnapshots, activeSnapshots);
    await new Promise((resolve) => setTimeout(resolve, 20));
    activeSnapshots -= 1;
    return { messageIds: ['master-baseline'], capturedAt: '2026-08-23T00:00:00.000Z' };
  };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    sessionRunnerFactory: ({ job, options }) => ({
      async run(sessionState) {
        const boundary = await options.beforeEmailSend(job.email, sessionState, {
          fresh: true,
          purpose: 'registration_identity',
        });
        boundaries.push({ email: job.email, boundary });
        sessionState.emailBoundary = boundary;
        finishSession(sessionState, job);
      },
    }),
  });

  assert.equal(state.status, 'complete');
  assert.equal(snapshots, 1, 'all aliases under one master should share the baseline read');
  assert.equal(maxActiveSnapshots, 1);
  assert.equal(boundaries.length, 3);
  assert.deepEqual(boundaries.map((item) => item.boundary.messageIds), [
    ['master-baseline'],
    ['master-baseline'],
    ['master-baseline'],
  ]);
  assert.equal(new Set(boundaries.map((item) => item.boundary)).size, 3, 'each job receives its own boundary object');
  assert.equal(state.events.filter((record) => record.type === 'email_boundary_captured').length, 3);
  assert.ok(state.events.filter((record) => record.type === 'email_boundary_captured').every((record) => record.shared === true));
});

test('the second registration baseline is single-flight per master and polls from the captured window', { timeout: 10000 }, async (t) => {
  const config = branchConfig(3);
  config.mail.provider = 'fastmail';
  config.mail.count = 3;
  config.aliases.strategy = 'root';
  config.aliases.count = 1;
  config.aliases.maxAttempts = 1;
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 3,
    workerConcurrency: 3,
    aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-shared-second-boundary' });
  const accounts = [1, 2, 3].map((index) => ({
    id: `mail-second-${index}`,
    email: `alias-second-${index}@fastmail.com`,
    parent: 'testuser@fastmail.com',
    rootEmail: 'testuser@fastmail.com',
    tokenValid: true,
    bound: false,
  }));
  const mail = mailboxClient(accounts);
  mail.remoteRegistrationAddresses = true;
  mail.consumeMailbox = async (id) => ({ mailbox: { id, cycle: 1 }, recycle: null });
  let snapshots = 0;
  let activeSnapshots = 0;
  let maxActiveSnapshots = 0;
  const polls = [];
  let sendIndex = 0;
  const secondBoundaryCapturedAt = '2026-08-23T00:02:00.000Z';
  mail.snapshotMailbox = async () => {
    snapshots += 1;
    activeSnapshots += 1;
    maxActiveSnapshots = Math.max(maxActiveSnapshots, activeSnapshots);
    await new Promise((resolve) => setTimeout(resolve, 20));
    activeSnapshots -= 1;
    return {
      messageIds: [`second-baseline-${snapshots}`],
      capturedAt: new Date(Date.UTC(2026, 7, 23, 0, snapshots, 0)).toISOString(),
    };
  };
  mail.findVerificationCode = async (mailboxId, options) => {
    polls.push({ mailboxId, ...options });
    // The code is available after the snapshot but before the send response
    // timestamp. A send-time lower bound would incorrectly miss it.
    if (options.since !== secondBoundaryCapturedAt) return null;
    return { code: '483921', messageId: `otp-${mailboxId}`, receivedAt: new Date().toISOString() };
  };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    sessionRunnerFactory: ({ job, options }) => ({
      async run(sessionState) {
        await options.beforeEmailSend(job.email, sessionState, {
          fresh: true,
          purpose: 'registration_identity',
        });
        const secondBoundary = await options.beforeEmailSend(job.email, sessionState, {
          fresh: true,
          purpose: 'registration',
        });
        sendIndex += 1;
        const sentAt = new Date(Date.UTC(2026, 7, 23, 1, sendIndex, 0)).toISOString();
        sessionState.emailBoundary = { ...secondBoundary, sentAt };
        sessionState.emailOtpSentAt = sentAt;
        const found = await options.getEmailCode(job.email, sessionState.emailBoundary, sessionState);
        assert.equal(found.code, '483921');
        finishSession(sessionState, job);
      },
    }),
  });

  assert.equal(state.status, 'complete');
  assert.equal(snapshots, 2, 'the identity and post-register rounds each read the master once');
  assert.equal(maxActiveSnapshots, 1);
  assert.equal(polls.length, 3);
  assert.equal(new Set(polls.map((poll) => poll.recipient)).size, 3);
  // A code may arrive before the send request's response Date is recorded.
  // The fresh baseline is the lower bound, while its ids exclude old mail.
  assert.deepEqual(new Set(polls.map((poll) => poll.since)), new Set([secondBoundaryCapturedAt]));
  assert.ok(polls.every((poll) => poll.excludeMessageIds[0] === 'second-baseline-2'));
});

test('stale email OTP recovery keeps the Firefox identity while rebuilding the auth session', async () => {
  const config = branchConfig(1);
  config.mail.timeoutMs = 120000;
  const original = makeInitialChatGptSessionState({ email: 'stale@example.test' });
  original.step = 'email_otp_sent';
  original.updatedAt = '2026-08-05T00:00:00.000Z';
  original.events.push({ type: 'email_otp_sent', at: original.updatedAt });
  const job = {
    id: 'job-stale-email',
    email: original.email,
    sessionState: original,
    emailBoundary: { capturedAt: original.updatedAt, messageIds: ['old-code'] },
    emailMessageId: 'old-code',
  };
  const runtime = { events: [] };
  let checkpoint = '';

  const restarted = await restartStaleEmailOtpSession(job, {
    config,
    state: runtime,
    now: () => Date.parse('2026-08-05T00:03:00.000Z'),
    checkpoint: async (reason) => { checkpoint = reason; },
  });

  assert.notEqual(restarted, original);
  assert.equal(restarted.step, 'initial');
  assert.equal(restarted.oaiDid, original.oaiDid);
  assert.equal(restarted.clientProfileFingerprint, original.clientProfileFingerprint);
  assert.equal(job.emailBoundary, null);
  assert.equal(job.emailMessageId, '');
  assert.equal(checkpoint, 'email_otp_session_restarted');
  assert.equal(runtime.events.at(-1).type, 'email_otp_session_restarted');
});

test('a waiting alias blocks later aliases in the same root lane', async (t) => {
  const config = branchConfig(1);
  config.aliases.count = 2;
  config.aliases.maxAttempts = 2;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 1, workerConcurrency: 1,
    aliasStrategy: 'plus', aliasCount: 2, aliasMaxAttempts: 2,
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-lane-wait-blocks' });
  let acquireCalls = 0;
  const smsProvider = {
    service: 'mock', country: '151',
    async acquireNumber() {
      acquireCalls += 1;
      return { id: 'activation-lane-wait', activationId: 'activation-lane-wait', number: '+56912345678', status: 'leased', cost: 0.02 };
    },
    async markSmsSent(lease) { return { ...lease, status: 'waiting' }; },
    async pollCode() { return { code: '123456', status: 'received' }; },
    async complete(lease) { return { ...lease, status: 'complete' }; },
    async cancel(lease) { return { ...lease, status: 'cancelled' }; },
    async requestAnotherCode(lease) { return lease; },
  };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    // These assertions are about the parking decision (lane blocking, lease
    // reconciliation), not the ladder that now retries it. Without this the
    // in-run retry recovers the job and the run finishes 'complete'.
    retryPolicies: {},
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([{ id: 'mail-lane-wait', email: 'lane-wait@example.test', tokenValid: true, bound: false }]),
    smsProvider,
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        if (job.aliasIndex === 1 && sessionState.step === 'initial') sessionState.step = 'phone_required';
        else finishSession(sessionState, job);
      },
      async sendPhone(sessionState) { sessionState.step = 'phone_otp_sent'; },
      async validatePhone() { throw Object.assign(new Error('validation response was lost'), { code: 'ECONNRESET' }); },
    }),
  });

  assert.equal(state.status, 'waiting');
  assert.deepEqual(state.jobs.map((job) => job.status), ['waiting', 'queued']);
  assert.equal(acquireCalls, 1);
  assert.equal(state.jobs[1].startedAt, undefined);
});

test('a waiting lane releases its worker to continue unrelated root lanes', async (t) => {
  const config = branchConfig(1);
  config.mail.count = 2;
  config.aliases.strategy = 'root';
  config.aliases.count = 1;
  config.aliases.maxAttempts = 1;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 2, workerConcurrency: 1,
    aliasStrategy: 'root', aliasCount: 1, aliasMaxAttempts: 1,
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-waiting-lane-continues' });
  const smsProvider = {
    service: 'mock', country: '151',
    async acquireNumber() {
      return { id: 'activation-deferred-lane', activationId: 'activation-deferred-lane', number: '+56912345678', status: 'leased', cost: 0.02 };
    },
    async markSmsSent(lease) { return { ...lease, status: 'waiting' }; },
    async pollCode() { return { code: '123456', status: 'received' }; },
    async complete(lease) { return { ...lease, status: 'complete' }; },
    async cancel(lease) { return { ...lease, status: 'cancelled' }; },
    async requestAnotherCode(lease) { return lease; },
  };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    // These assertions are about the parking decision (lane blocking, lease
    // reconciliation), not the ladder that now retries it. Without this the
    // in-run retry recovers the job and the run finishes 'complete'.
    retryPolicies: {},
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([
      { id: 'mail-deferred', email: 'deferred@example.test', tokenValid: true, bound: false },
      { id: 'mail-runnable', email: 'runnable@example.test', tokenValid: true, bound: false },
    ]),
    smsProvider,
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        if (job.email === 'deferred@example.test' && sessionState.step === 'initial') sessionState.step = 'phone_required';
        else finishSession(sessionState, job);
      },
      async sendPhone(sessionState) { sessionState.step = 'phone_otp_sent'; },
      async validatePhone() { throw Object.assign(new Error('validation response was lost'), { code: 'ECONNRESET' }); },
    }),
  });

  const deferred = state.jobs.find((job) => job.email === 'deferred@example.test');
  const runnable = state.jobs.find((job) => job.email === 'runnable@example.test');
  assert.equal(state.status, 'waiting');
  assert.equal(deferred.status, 'waiting');
  assert.equal(runnable.status, 'complete');
  assert.ok(runnable.startedAt);
  assert.equal(state.events.some((record) => (
    record.type === 'worker_lane_deferred'
    && record.jobId === deferred.id
    && record.laneId === deferred.laneId
  )), true);
});

test('a Worker picks up queued work as soon as its own job ends, without waiting for the slow one', async (t) => {
  const config = branchConfig(2);
  config.mail.count = 4;
  config.aliases.strategy = 'root';
  config.aliases.count = 1;
  config.aliases.maxAttempts = 1;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 4, workerConcurrency: 2,
    aliasStrategy: 'root', aliasCount: 1, aliasMaxAttempts: 1,
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-continuous-scheduling' });
  let releaseSlow;
  const slowStarted = new Promise((resolve) => { state.slowStartedResolve = resolve; });
  const slowGate = new Promise((resolve) => { releaseSlow = resolve; });
  const finished = [];

  const run = runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([
      { id: 'mail-slow', email: 'slow@example.test', tokenValid: true, bound: false },
      { id: 'mail-a', email: 'a@example.test', tokenValid: true, bound: false },
      { id: 'mail-b', email: 'b@example.test', tokenValid: true, bound: false },
      { id: 'mail-c', email: 'c@example.test', tokenValid: true, bound: false },
    ]),
    // This test exercises queue draining; keep the optional promo lookup out
    // of the fixture so a live local proxy cannot mask scheduler behavior.
    trialChecker: async () => ({
      status: 'none',
      code: 'TRIAL_UNAVAILABLE',
      message: 'none',
      httpStatus: 200,
      checkedAt: new Date().toISOString(),
      latencyMs: 1,
      campaigns: [],
    }),
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        if (job.email === 'slow@example.test') {
          state.slowStartedResolve?.();
          // Holds one Worker for the whole run.
          await slowGate;
        }
        finishSession(sessionState, job);
        finished.push(job.email);
      },
    }),
  });

  await slowStarted;
  // The fast lane must drain entirely while the slow job is still parked in its
  // Worker. Under the old batch barrier nothing could start until it returned.
  for (let attempt = 0; attempt < 200 && finished.length < 3; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(finished.length, 3, 'the free Worker must keep taking queued jobs');
  assert.equal(finished.includes('slow@example.test'), false);

  releaseSlow();
  await run;
  assert.equal(finished.length, 4);
  assert.equal(state.jobs.every((job) => job.status === 'complete'), true);
});

test('a Cloudflare rotation is promoted while another Worker is still busy', async (t) => {
  const config = branchConfig(2);
  config.mail.count = 2;
  config.proxyPool.required = true;
  config.aliases.strategy = 'root';
  config.aliases.count = 1;
  config.aliases.maxAttempts = 1;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 2, workerConcurrency: 2,
    aliasStrategy: 'root', aliasCount: 1, aliasMaxAttempts: 1,
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-rotation-while-busy' });
  let releaseSlow;
  const slowGate = new Promise((resolve) => { releaseSlow = resolve; });
  const exits = [];
  let challenged = false;

  const run = runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([
      { id: 'mail-hold', email: 'hold@example.test', tokenValid: true, bound: false },
      { id: 'mail-cf', email: 'cf@example.test', tokenValid: true, bound: false },
    ]),
    proxyEntries: [
      { id: 'proxy-1', url: 'http://proxy-1:4101' },
      { id: 'proxy-2', url: 'http://proxy-2:4102' },
      { id: 'proxy-3', url: 'http://proxy-3:4103' },
    ],
    proxyProbeExecutor: async (_request, probeOptions) => ({ response: { status: 200, url: probeOptions.proxy } }),
    retryPolicies: { waiting_proxy_rotation: { delaysMs: [1], maxRetries: 3, proxyAction: 'already_rotated' } },
    sessionRunnerFactory: ({ job, worker }) => ({
      async run(sessionState) {
        if (job.email === 'hold@example.test') {
          await slowGate;
          finishSession(sessionState, job);
          return;
        }
        exits.push(worker.proxyId);
        if (!challenged) {
          challenged = true;
          throw Object.assign(new Error('Cloudflare challenge'), {
            code: 'CLOUDFLARE_CHALLENGE',
            cloudflareChallenge: true,
          });
        }
        finishSession(sessionState, job);
      },
    }),
  });

  // The rotated job has to come back on a fresh exit while the other Worker is
  // still holding its job; the batch barrier used to pin it until that ended.
  for (let attempt = 0; attempt < 300 && exits.length < 2; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // Released before the assertions, not after: a failure here used to throw
  // with the other Worker still parked on the gate, so the run never settled
  // and the test hung instead of reporting.
  const observed = { exits: [...exits], health: state.proxyHealth[exits[0]]?.status };
  releaseSlow();

  assert.equal(observed.exits.length, 2, 'the retry must not wait for the other Worker');
  assert.notEqual(observed.exits[0], observed.exits[1], 'and it must land on a different exit');
  assert.equal(observed.health, 'failed');

  await run;
  assert.equal(state.jobs.every((job) => job.status === 'complete'), true);
});

test('each account is registered from its own exit', async (t) => {
  const config = branchConfig(1);
  config.mail.count = 3;
  config.proxyPool.required = true;
  config.aliases.strategy = 'root';
  config.aliases.count = 1;
  config.aliases.maxAttempts = 1;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 3, workerConcurrency: 1,
    aliasStrategy: 'root', aliasCount: 1, aliasMaxAttempts: 1,
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-exit-per-account' });
  const used = [];

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([
      { id: 'mail-1', email: 'one@example.test', tokenValid: true, bound: false },
      { id: 'mail-2', email: 'two@example.test', tokenValid: true, bound: false },
      { id: 'mail-3', email: 'three@example.test', tokenValid: true, bound: false },
    ]),
    proxyEntries: [
      { id: 'exit-1', url: 'http://exit-1:4101' },
      { id: 'exit-2', url: 'http://exit-2:4102' },
      { id: 'exit-3', url: 'http://exit-3:4103' },
    ],
    proxyProbeExecutor: async (_request, probeOptions) => ({ response: { status: 200, url: probeOptions.proxy } }),
    sessionRunnerFactory: ({ job, worker }) => ({
      async run(sessionState) {
        used.push(worker.proxyId);
        finishSession(sessionState, job);
      },
    }),
  });

  assert.equal(used.length, 3);
  // A single Worker used to keep one exit for every account it registered.
  assert.equal(used[0] !== used[1] && used[1] !== used[2], true, `consecutive accounts shared an exit: ${used.join(', ')}`);
  assert.equal(state.jobs.every((job) => job.status === 'complete'), true);
  assert.equal(state.workers[0].proxyId, '', 'the last exit is handed back too');
});

test('a proxy fault before the account flow uses a spare exit inside the same run', async (t) => {
  const config = branchConfig(1);
  config.proxyPool.required = true;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-preflight-swap' });
  const used = [];

  const options = {
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([{ id: 'mail-pre', email: 'pre@example.test', tokenValid: true, bound: false }]),
    proxyEntries: [{ id: 'exit-a', url: 'http://exit-a:4101' }, { id: 'exit-b', url: 'http://exit-b:4102' }],
    proxyProbeExecutor: async (_request, probeOptions) => ({ response: { status: 200, url: probeOptions.proxy } }),
    retryPolicies: { waiting_proxy_rotation: { delaysMs: [1], maxRetries: 3, proxyAction: 'already_rotated' } },
    sessionRunnerFactory: ({ job, worker }) => ({
      async run(sessionState) {
        used.push(worker.proxyId);
        if (used.length === 1) {
          // Still on step `initial`: nothing durable exists, so the exit is
          // dropped immediately rather than rechecked on a backoff ladder.
          throw Object.assign(new Error('Proxy request timed out: https://chatgpt.com/api/auth/session'), {
            code: 'CHATGPT_SESSION_TIMEOUT',
            retryable: true,
          });
        }
        finishSession(sessionState, job);
      },
    }),
  };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, options);

  assert.equal(used.length, 2);
  assert.equal(state.status, 'complete');
  assert.equal(state.jobs[0].status, 'complete');
  assert.equal(state.jobs[0].proxyTransportRecovery.pending, false);
  assert.notEqual(used[0], used[1], 'the spare exit must be used without operator resume');
  assert.equal(state.events.some((record) => record.type === 'branch_job_retry_scheduled'), true);
  assert.equal(state.events.some((record) => record.type === 'worker_proxy_swapped_before_registration'), true);
  // The exit that carried the failure is spent, not scheduled for a recheck:
  // a probe cannot overturn evidence from real traffic, and the pool refills.
  assert.equal(state.proxyHealth[used[0]].status, 'failed');
});

test('a pre-registration transport fault rotates in-run when a large pool has a spare exit', async (t) => {
  const config = branchConfig(1);
  config.proxyPool.required = true;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-preflight-inrun-rotation' });
  const used = [];

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([{ id: 'mail-pre-large', email: 'pre-large@example.test', tokenValid: true, bound: false }]),
    proxyEntries: [
      { id: 'exit-large-a', url: 'http://exit-large-a:4101' },
      { id: 'exit-large-b', url: 'http://exit-large-b:4102' },
      { id: 'exit-large-c', url: 'http://exit-large-c:4103' },
    ],
    proxyProbeExecutor: async (_request, probeOptions) => ({ response: { status: 200, url: probeOptions.proxy } }),
    retryPolicies: { waiting_proxy_rotation: { delaysMs: [1], maxRetries: 2, proxyAction: 'already_rotated' } },
    sessionRunnerFactory: ({ job, worker }) => ({
      async run(sessionState) {
        used.push(worker.proxyId);
        if (used.length === 1) {
          throw Object.assign(new Error('Proxy request timed out: https://chatgpt.com/api/auth/session'), {
            code: 'CHATGPT_SESSION_TIMEOUT',
            retryable: true,
          });
        }
        finishSession(sessionState, job);
      },
    }),
  });

  assert.equal(state.status, 'complete');
  assert.equal(state.jobs[0].status, 'complete');
  assert.equal(used.length, 2);
  assert.notEqual(used[0], used[1]);
  assert.equal(state.jobs[0].proxyTransportRecovery.pending, false);
  assert.equal(state.events.some((record) => (
    record.type === 'worker_proxy_swapped_before_registration' && record.recovery === 'in_run_rotation'
  )), true);
  assert.equal(state.events.some((record) => record.type === 'branch_job_retry_scheduled'), true);
});

test('a registration subtask refreshes the proxy catalog and changes exit without waiting for the robot', async (t) => {
  const config = branchConfig(1);
  config.proxyPool.required = true;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-job-local-proxy-recovery' });
  const used = [];
  let refreshes = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([{ id: 'mail-job-recovery', email: 'job-recovery@example.test', tokenValid: true, bound: false }]),
    proxyEntries: [{ id: 'exit-local-dead', url: 'http://exit-local-dead:4101', workerSlots: [1] }],
    refreshProxyResources: async () => {
      refreshes += 1;
      return {
        snapshot: {
          schemaVersion: 1,
          entries: [
            { id: 'exit-local-dead', url: 'http://exit-local-dead:4101', workerSlots: [1] },
            { id: 'exit-local-good-a', url: 'http://exit-local-good-a:4102', workerSlots: [1] },
            { id: 'exit-local-good-b', url: 'http://exit-local-good-b:4103', workerSlots: [1] },
          ],
        },
      };
    },
    proxyProbeExecutor: async (_request, probeOptions) => ({ response: { status: 200, url: probeOptions.proxy } }),
    retryPolicies: { waiting_proxy_rotation: { delaysMs: [1], maxRetries: 2 } },
    sessionRunnerFactory: ({ job, worker }) => ({
      async run(sessionState) {
        used.push(worker.proxyId);
        if (used.length === 1) {
          // The flow is already past the initial checkpoint. The local
          // recovery must rebuild this attempt on a new exit safely.
          sessionState.step = 'email_otp_validated';
          throw Object.assign(new Error('Proxy request timed out: https://chatgpt.com/api/auth/session'), {
            code: 'CHATGPT_SESSION_TIMEOUT',
            retryable: true,
          });
        }
        finishSession(sessionState, job);
      },
    }),
  });

  assert.equal(refreshes, 1);
  assert.equal(state.status, 'complete');
  assert.equal(state.jobs[0].status, 'complete');
  assert.equal(used.length, 2);
  assert.notEqual(used[0], used[1]);
  assert.equal(state.jobs[0].proxyTransportRecovery.pending, false);
  assert.equal(state.events.some((record) => (
    record.type === 'worker_proxy_swapped_before_registration' && record.recovery === 'job_local_rotation'
  )), true);
  // The job refreshes its catalog only after no replacement is present in the
  // current snapshot.
  assert.equal(state.events.some((record) => record.type === 'job_proxy_resources_refreshed'), true);
});

test('a maintenance forwarder transport fault retries on 7890 without catalog refresh', async (t) => {
  const config = branchConfig(1);
  config.proxyPool.required = true;
  config.proxyPool.maintenanceProxy = 'http://127.0.0.1:7890';
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-maintenance-proxy-retry' });
  const mail = mailboxClient([{ id: 'mail-maintenance-retry', email: 'maintenance-retry@example.test', tokenValid: true, bound: false }]);
  const maintenance = {
    id: 'maintenance-local',
    url: 'http://127.0.0.1:7890',
    protocol: 'http',
    workerSlots: [1],
    resourceKind: 'maintenance',
  };
  let runnerCalls = 0;
  let refreshCalls = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    proxyEntries: [maintenance],
    refreshProxyResources: async () => {
      refreshCalls += 1;
      throw new Error('catalog refresh must not own the local forwarder');
    },
    retryPolicies: { waiting_maintenance_proxy: { delaysMs: [1], maxRetries: 2 } },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        runnerCalls += 1;
        if (runnerCalls === 1) {
          throw Object.assign(new Error('Client network socket disconnected before secure TLS connection was established'), {
            code: 'ECONNRESET',
            retryable: true,
            category: 'transient',
          });
        }
        finishSession(sessionState, job);
      },
    }),
  });

  assert.equal(state.status, 'complete');
  assert.equal(state.jobs[0].status, 'complete');
  assert.equal(runnerCalls, 2);
  assert.equal(refreshCalls, 0);
  assert.equal(state.jobs[0].proxyTransportRecovery.attempted, false);
  assert.equal(state.jobs[0].proxyTransportRecovery.pending, false);
  assert.equal(state.events.some((record) => (
    record.type === 'worker_proxy_maintenance_retry_scheduled'
    && record.recovery === 'maintenance_retry'
    && record.proxyKind === 'maintenance'
  )), true);
  assert.equal(state.events.some((record) => record.type === 'branch_job_retry_scheduled' && record.waitPhase === 'waiting_maintenance_proxy'), true);
});

test('maintenance forwarder retry exhaustion fails the job instead of leaving an unscheduled wait', async (t) => {
  const config = branchConfig(1);
  config.proxyPool.required = true;
  config.proxyPool.maintenanceProxy = 'http://127.0.0.1:7890';
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-maintenance-proxy-exhausted' });
  const maintenance = {
    id: 'maintenance-local',
    url: 'http://127.0.0.1:7890',
    protocol: 'http',
    workerSlots: [1],
    resourceKind: 'maintenance',
  };
  let runnerCalls = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([{ id: 'mail-maintenance-exhausted', email: 'maintenance-exhausted@example.test', tokenValid: true, bound: false }]),
    proxyEntries: [maintenance],
    retryPolicies: { waiting_maintenance_proxy: { delaysMs: [1], maxRetries: 1, jitterRatio: 0 } },
    sessionRunnerFactory: () => ({
      async run() {
        runnerCalls += 1;
        throw Object.assign(new Error('Cloudflare challenge at chatgpt.com'), {
          code: 'CLOUDFLARE_CHALLENGE',
          cloudflareChallenge: true,
          retryable: true,
        });
      },
    }),
  });

  const job = state.jobs[0];
  assert.equal(runnerCalls, 2);
  assert.equal(state.status, 'failed');
  assert.equal(job.status, 'failed');
  assert.equal(job.phase, 'failed');
  assert.equal(job.nextRunAt, '');
  assert.equal(job.retry, null);
  assert.equal(state.proxyHealth[maintenance.id]?.status === 'failed', false);
  assert.equal(state.events.some((record) => (
    record.type === 'maintenance_proxy_retry_exhausted'
    && record.jobId === job.id
    && record.attempts === 1
  )), true);
  assert.equal(state.events.some((record) => (
    record.type === 'branch_job_failed' && record.jobId === job.id
  )), true);
});

test('an account whose exit was banned mid-flight is rebuilt instead of parked forever', async (t) => {
  const config = branchConfig(1);
  config.proxyPool.required = true;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-continuity-rebuild' });
  const exits = [];
  let attempt = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([{ id: 'mail-cont', email: 'cont@example.test', tokenValid: true, bound: false }]),
    proxyEntries: [{ id: 'exit-x', url: 'http://exit-x:4101' }, { id: 'exit-y', url: 'http://exit-y:4102' }],
    proxyProbeExecutor: async (_request, probeOptions) => ({ response: { status: 200, url: probeOptions.proxy } }),
    retryPolicies: {
      waiting_proxy_retry: { delaysMs: [1], maxRetries: 1, proxyAction: 'keep', onExhausted: 'restart_on_fresh_exit' },
      waiting_proxy_rotation: { delaysMs: [1], maxRetries: 3, proxyAction: 'already_rotated' },
    },
    sessionRunnerFactory: ({ job, worker }) => ({
      async run(sessionState) {
        attempt += 1;
        exits.push(worker.proxyId);
        if (attempt <= 2) {
          // Reproduces the stuck job: the account exists, so the attempt has
          // durable state and the continuity guard refuses to move it to a
          // different exit — which used to mean parking forever once the
          // original exit was banned.
          sessionState.accountCreated = true;
          sessionState.step = 'auth_callback_pending';
          job.accountCreatedAt = job.accountCreatedAt || new Date().toISOString();
          throw Object.assign(new Error('Cloudflare challenge'), {
            code: 'CLOUDFLARE_CHALLENGE',
            cloudflareChallenge: true,
          });
        }
        finishSession(sessionState, job);
      },
    }),
  });

  const restarted = state.events.find((record) => record.type === 'registration_restarted_on_fresh_exit');
  assert.ok(restarted, 'the attempt has to be rebuilt rather than left in waiting_proxy_continuity');
  assert.equal(restarted.email, 'cont@example.test', 'the same mailbox is registered again');
  assert.notEqual(exits.at(-1), exits[0], 'the rebuild has to run from a different exit');
  assert.equal(state.jobs[0].status, 'complete');
  assert.equal(state.jobs[0].phase, 'complete');
});

test('a proxy rebuild after email verification requests a fresh OTP transaction', async (t) => {
  const config = branchConfig(1);
  config.proxyPool.required = true;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-fresh-otp-after-proxy' });
  const exits = [];
  let attempts = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([{ id: 'mail-fresh-otp', email: 'fresh@example.test', tokenValid: true, bound: false }]),
    proxyEntries: [
      { id: 'exit-old', url: 'http://exit-old:4101' },
      { id: 'exit-new', url: 'http://exit-new:4102' },
      { id: 'exit-spare', url: 'http://exit-spare:4103' },
    ],
    proxyProbeExecutor: async (_request, probeOptions) => ({ response: { status: 200, url: probeOptions.proxy } }),
    retryPolicies: {
      waiting_proxy_retry: { delaysMs: [1], maxRetries: 1, proxyAction: 'keep', onExhausted: 'restart_on_fresh_exit' },
      waiting_proxy_rotation: { delaysMs: [1], maxRetries: 3, proxyAction: 'already_rotated' },
    },
    sessionRunnerFactory: ({ job, worker }) => ({
      async run(sessionState) {
        attempts += 1;
        exits.push(worker.proxyId);
        if (attempts === 1) {
          sessionState.step = 'email_otp_validated';
          sessionState.emailBoundary = { messageIds: ['old-code'] };
          sessionState.createAccountAttempt = { status: 'uncertain', attempts: 1 };
          throw Object.assign(new Error('connection reset after create_account'), {
            code: 'ECONNRESET',
            proxyFailure: true,
          });
        }
        assert.equal(sessionState.step, 'initial');
        assert.equal(sessionState.emailBoundary, null);
        assert.equal(sessionState.createAccountAttempt.status, 'uncertain');
        finishSession(sessionState, job);
      },
    }),
  });

  assert.equal(state.jobs[0].status, 'complete');
  assert.notEqual(exits[0], exits[1]);
  const restarted = state.events.find((record) => record.type === 'registration_restarted_on_fresh_exit');
  assert.equal(restarted.freshEmailOtp, true);
  assert.equal(restarted.previousStep, 'email_otp_validated');
});

test('idle Workers bind their exits concurrently and never claim the same one', async (t) => {
  const config = branchConfig(4);
  config.mail.count = 4;
  config.proxyPool.required = true;
  config.aliases.strategy = 'root';
  config.aliases.count = 1;
  config.aliases.maxAttempts = 1;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 4, workerConcurrency: 4,
    aliasStrategy: 'root', aliasCount: 1, aliasMaxAttempts: 1,
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-parallel-bind' });
  const PROBE_MS = 60;
  let probesInFlight = 0;
  let peakProbesInFlight = 0;
  const claimed = [];

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([
      { id: 'm1', email: 'w1@example.test', tokenValid: true, bound: false },
      { id: 'm2', email: 'w2@example.test', tokenValid: true, bound: false },
      { id: 'm3', email: 'w3@example.test', tokenValid: true, bound: false },
      { id: 'm4', email: 'w4@example.test', tokenValid: true, bound: false },
    ]),
    proxyEntries: Array.from({ length: 8 }, (_, index) => ({ id: `p${index + 1}`, url: `http://p${index + 1}:4100` })),
    proxyProbeExecutor: async (_request, probeOptions) => {
      probesInFlight += 1;
      peakProbesInFlight = Math.max(peakProbesInFlight, probesInFlight);
      await new Promise((resolve) => setTimeout(resolve, PROBE_MS));
      probesInFlight -= 1;
      return { response: { status: 200, url: probeOptions.proxy } };
    },
    sessionRunnerFactory: ({ job, worker }) => ({
      async run(sessionState) {
        claimed.push(worker.proxyId);
        await new Promise((resolve) => setTimeout(resolve, 20));
        finishSession(sessionState, job);
      },
    }),
  });

  // Serial binding would peak at one probe at a time and cost 4x PROBE_MS
  // before the first job could start.
  assert.ok(peakProbesInFlight > 1, `probes never overlapped (peak ${peakProbesInFlight})`);
  // Reserving the candidate before the probe is what keeps the parallel binds
  // off each other's exits.
  const firstFour = claimed.slice(0, 4);
  assert.equal(new Set(firstFour).size, firstFour.length, `two Workers shared an exit: ${firstFour.join(', ')}`);
  assert.equal(state.jobs.every((job) => job.status === 'complete'), true);
});

test('a rejected exit is retired and never re-probed in the same run', async (t) => {
  const config = branchConfig(1);
  config.mail.count = 1;
  config.proxyPool.required = true;
  config.proxyPool.healthCheck = {
    enabled: true,
    probeUrl: 'https://auth.openai.com/',
    timeoutMs: 5000,
  };
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 1, workerConcurrency: 1,
    aliasStrategy: 'plus', aliasCount: 2, aliasMaxAttempts: 2,
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-proxy-prefers-vetted' });
  // A country pool the way the live ones measure: a handful of exits answer and
  // the rest are blocked. A Worker must retire each rejected candidate and
  // continue with a fresh candidate instead of probing it again.
  const proxies = Array.from({ length: 40 }, (_, index) => ({
    id: `proxy-vetted-${index + 1}`,
    url: `http://proxy-vetted-${index + 1}:4100`,
  }));
  const healthy = new Set(['proxy-vetted-3', 'proxy-vetted-4', 'proxy-vetted-5']);
  const probed = [];

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([{ id: 'mail-vetted', email: 'vetted@example.test', tokenValid: true, bound: false }]),
    proxyEntries: proxies,
    proxyProbeExecutor: async (_request, probeOptions) => {
      const id = proxies.find((proxy) => proxy.url === probeOptions.proxy)?.id || '';
      probed.push(id);
      if (!healthy.has(id)) throw Object.assign(new Error('blocked'), { code: 'PROXY_CLOUDFLARE_CHALLENGE' });
      return { response: { status: 200, url: probeOptions.proxy } };
    },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) { finishSession(sessionState, job); },
    }),
  });

  assert.equal(state.status, 'complete');

  // A rejection is final for this run, so a dead exit is probed at most once.
  const deadProbes = probed.filter((id) => !healthy.has(id));
  const repeated = deadProbes.filter((id, index) => deadProbes.indexOf(id) !== index);
  assert.deepEqual(repeated, [], `a rejected exit must not be re-probed: ${repeated.join(', ')}`);

  // Every bound exit has passed the Worker's own probe.
  const binds = state.events.filter((event) => event.type === 'worker_proxy_bound');
  assert.equal(binds.length >= 1, true, 'the run must bind an exit');
  assert.equal(binds.every((event) => healthy.has(event.proxyId)), true);
  assert.equal(new Set(binds.map((event) => event.proxyId)).size, binds.length,
    'one address per root mailbox');
  // Rejected candidates remain failed; the successful exit is healthy and can
  // be released for later work after the lane finishes.
  for (const bind of binds) {
    assert.equal(state.proxyHealth[bind.proxyId]?.status, 'healthy', bind.proxyId);
  }
});

test('a deferred OAuth lane keeps its original Worker and proxy affinity', async (t) => {
  const config = branchConfig(2);
  config.sms.inventoryWaitMs = 100;
  const store = temporaryStore(t);
  const addAsset = (email, parentMailboxId = '') => {
    const seed = makeInitialChatGptSessionState({ email });
    return store.upsert({
      email,
      parentEmail: parentMailboxId ? 'shared-lane@example.test' : email,
      parentMailboxId,
      accountId: `account-${email}`,
      accessToken: `access-${email}`,
      sessionToken: `session-${email}`,
      cookieJar: seed.cookieJar,
      clientProfile: seed.clientProfile,
      clientProfileFingerprint: seed.clientProfileFingerprint,
      oaiDid: seed.oaiDid,
      status: 'valid',
    });
  };
  const deferredAsset = addAsset('deferred-oauth@example.test');
  const otherAsset = addAsset('other-oauth@example.test');
  const sharedOne = addAsset('shared-one@example.test', 'shared-lane');
  const sharedTwo = addAsset('shared-two@example.test', 'shared-lane');
  const plan = normalizeRunPlan({
    taskKind: 'oauth', workerConcurrency: 2,
    oauthSource: {
      kind: 'session_assets',
      assetIds: [deferredAsset.id, otherAsset.id, sharedOne.id, sharedTwo.id],
    },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-oauth-worker-affinity' });
  let acquireCalls = 0;
  const deferredWorkers = [];

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: store,
    smsInventoryPollIntervalMs: 1,
    proxyEntries: [
      { id: 'proxy-affinity-one', url: 'http://127.0.0.1:4101', workerSlots: [1] },
      { id: 'proxy-affinity-two', url: 'http://127.0.0.1:4102', workerSlots: [2] },
    ],
    smsProvider: {
      service: 'mock', country: '151',
      async preflight() { return { provider: 'mock', ready: true }; },
      async acquireNumber() {
        acquireCalls += 1;
        if (acquireCalls === 1) {
          throw Object.assign(new Error('No numbers are currently available'), {
            code: 'NO_NUMBERS', category: 'availability', retryable: true,
          });
        }
        return { id: 'activation-affinity', activationId: 'activation-affinity', number: '+56912345678', status: 'leased', cost: 0.02 };
      },
      async markSmsSent(lease) { return { ...lease, status: 'waiting' }; },
      async pollCode() { return { code: '123456', status: 'received' }; },
      async complete(lease) { return { ...lease, status: 'complete' }; },
      async cancel(lease) { return { ...lease, status: 'cancelled' }; },
    },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        if (job.laneId === 'shared-lane') await new Promise((resolve) => setTimeout(resolve, 10));
        finishSession(sessionState, job);
      },
    }),
    oauthRunnerFactory: ({ job, worker }) => {
      if (job.email === deferredAsset.email) deferredWorkers.push(worker.id);
      return {
        async run(oauthState) {
          if (job.email === deferredAsset.email) {
            if (oauthState.step === 'initial') oauthState.step = 'phone_required';
            else if (oauthState.step === 'navigating') {
              oauthState.step = 'complete';
              oauthState.status = 'complete';
              oauthState.account = { email: oauthState.email, access_token: 'oauth-affinity-access', refresh_token: 'oauth-affinity-refresh' };
            }
            return;
          }
          oauthState.step = 'complete';
          oauthState.status = 'complete';
          oauthState.account = { email: oauthState.email, access_token: `oauth-${job.id}`, refresh_token: `refresh-${job.id}` };
        },
        async sendPhone(oauthState) { oauthState.step = 'phone_otp_sent'; },
        async validatePhone(oauthState) { oauthState.step = 'navigating'; },
      };
    },
  });

  const deferred = state.jobs.find((job) => job.assetId === deferredAsset.id);
  assert.equal(state.status, 'complete');
  assert.equal(acquireCalls, 2);
  assert.deepEqual([...new Set(deferredWorkers)], ['worker-1']);
  assert.equal(deferred.workerAffinity.workerId, 'worker-1');
  assert.equal(deferred.workerAffinity.proxyId, 'proxy-affinity-one');
  assert.equal(deferred.proxyId, 'proxy-affinity-one');
  assert.equal(state.jobs.every((job) => job.aliasIndex === 0), true);
});

test('mailbox reservation intent is checkpointed before binding and an ambiguous bind is reconciled on resume', async (t) => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-mailbox-reservation-intent' });
  const account = { id: 'mail-reserve-intent', email: 'reserve-intent@example.test', tokenValid: true, bound: false };
  const persisted = [];
  let reserveCalls = 0;
  const mailClient = {
    async listAccounts() { return { accounts: [account] }; },
    async reserveMailbox(id) {
      reserveCalls += 1;
      assert.equal(id, account.id);
      const intent = persisted.find((snapshot) => snapshot.lastCheckpoint?.reason === 'intent:mailbox_reserve');
      assert.equal(intent.mailboxes[0].status, 'reservation_pending');
      assert.equal(intent.mailboxes[0].reservation.effect.kind, 'mailbox_reserve');
      account.bound = true;
      throw Object.assign(new Error('connection closed after mailbox bind'), { code: 'ECONNRESET' });
    },
    async releaseMailbox() {},
  };
  const options = {
    assetStore: temporaryStore(t),
    mailClient,
    saveState: async (next) => persisted.push(JSON.parse(JSON.stringify(next))),
    sessionRunnerFactory: ({ job }) => ({ async run(sessionState) { finishSession(sessionState, job); } }),
  };

  await assert.rejects(
    runBranchOrchestrator({ log: { entries: [] } }, state, config, options),
    { code: 'ECONNRESET' },
  );
  assert.equal(state.mailboxes[0].status, 'reservation_pending');
  assert.equal(state.status, 'waiting');
  assert.equal(state.phase, 'waiting_resource_cleanup');
  assert.equal(state.cancelPending, false);
  assert.equal(state.jobs.length, 0);

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, options);
  assert.equal(state.status, 'complete');
  assert.equal(reserveCalls, 1);
  assert.equal(state.mailboxes[0].reservation.reconciled, true);
  assert.equal(state.jobs.length, 1);
});

test('cancellation releases a mailbox whose reservation outcome was persisted before jobs existed', async () => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-mailbox-reservation-cancel' });
  state.mailboxes.push({
    id: 'mail-reservation-cancel', email: 'reservation-cancel@example.test', rootEmail: 'reservation-cancel@example.test',
    status: 'reservation_pending', reservation: { effect: { kind: 'mailbox_reserve' }, attempts: 1 },
  });
  const mail = mailboxClient([]);

  await cancelBranchState(state, config, { mailClient: mail, smsProvider: {} });

  assert.equal(state.status, 'cancelled');
  assert.deepEqual(mail.released, ['mail-reservation-cancel']);
  assert.equal(state.mailboxes[0].status, 'released');
  assert.equal(state.mailboxes[0].reservation.effect, null);
});

test('combined registration and OAuth uses the dynamic existing-account session path', async (t) => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({
    taskKind: 'register_oauth',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-register-oauth-existing' });
  const store = temporaryStore(t);
  const mail = mailboxClient([{ id: 'mail-existing', email: 'existing@example.test', tokenValid: true, bound: false }]);
  let sessionRuns = 0;
  let oauthRuns = 0;
  let smsAcquires = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: store,
    mailClient: mail,
    smsProvider: { async acquireNumber() { smsAcquires += 1; throw new Error('phone challenge was not requested'); } },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        sessionRuns += 1;
        sessionState.existingAccount = true;
        finishSession(sessionState, job);
      },
    }),
    oauthRunnerFactory: () => ({
      async run(oauthState) {
        oauthRuns += 1;
        oauthState.step = 'complete';
        oauthState.status = 'complete';
        oauthState.account = {
          email: oauthState.email,
          access_token: 'combined-access',
          refresh_token: 'combined-refresh',
        };
      },
    }),
  });

  const asset = store.get(state.jobs[0].sessionAssetId);
  assert.equal(state.status, 'complete');
  assert.equal(state.jobs[0].result, 'cpa_saved');
  assert.equal(state.jobs[0].targetDisposition, 'existing_account');
  assert.equal(state.mailboxes[0].status, 'complete');
  assert.equal(asset.sourceKind, 'register_oauth');
  assert.equal(asset.cpa.runId, state.runId);
  assert.equal(sessionRuns, 1);
  assert.equal(oauthRuns, 1);
  assert.equal(smsAcquires, 0);
  assert.deepEqual(mail.released, []);
});

test('a finished run stops claiming it is waiting for mailboxes', async (t) => {
  // `normalWait` is why a run is parked right now, and nothing cleared it on
  // the way out. A task whose mailbox target had been raised mid-run ended
  // half an hour later still announcing 等待处理 "Mailbox target is 80; the run
  // keeps renting as Workers free up" — with every job terminal and nothing
  // left to rent.
  const config = branchConfig(1);
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-wait-cleared-on-finish' });
  // What the operator's live target change leaves behind.
  state.normalWait = {
    code: 'MAIL_RENTAL',
    message: 'Mailbox target is 80; the run keeps renting as Workers free up',
    at: new Date().toISOString(),
    nextRunAt: '',
  };
  state.mailRentalRetry = { attempts: 1, firstAt: new Date().toISOString(), nextRunAt: new Date().toISOString() };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([{ id: 'mail-wait-cleared', email: 'wait-cleared@example.test', tokenValid: true, bound: false }]),
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) { finishSession(sessionState, job); },
    }),
  });

  assert.equal(state.status, 'complete');
  assert.equal(state.normalWait, null);
  assert.equal(state.mailRentalRetry, null);
  assert.equal(summarizeBranchState(state).normalWait, null);
});

test('a consent continuation the server invalidated is rebuilt instead of failing the account', async (t) => {
  // Reproduces the loss of 2026-09-24: `workspace_select` answered HTTP 500
  // `Request timeout`, the job retried it as a transient fault, and the retry
  // replayed the same continuation — which that timeout had already
  // invalidated. The answer was HTTP 409 `invalid_state` ("Your sign-in
  // session is no longer valid. Please start over to continue.") and the job
  // failed with a registered, verified, phone-validated account and no CPA.
  const config = branchConfig(1);
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    postRegistrationOAuth: true,
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
    security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-oauth-continuation-restart' });
  const store = temporaryStore(t);
  const mail = mailboxClient([{ id: 'mail-continuation', email: 'continuation@example.test', tokenValid: true, bound: false }]);
  const pkceStates = [];
  let oauthRuns = 0;
  let smsAcquires = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: store,
    mailClient: mail,
    smsProvider: { async acquireNumber() { smsAcquires += 1; throw new Error('phone challenge was not requested'); } },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) { finishSession(sessionState, job); },
    }),
    oauthRunnerFactory: () => ({
      async run(oauthState) {
        oauthRuns += 1;
        pkceStates.push(oauthState.oauth?.state || '');
        if (oauthRuns === 1) {
          throw Object.assign(new Error('workspace_select failed with HTTP 409: invalid_state'), {
            code: 'INVALID_STATE',
            status: 409,
          });
        }
        oauthState.step = 'complete';
        oauthState.status = 'complete';
        oauthState.account = {
          email: oauthState.email,
          access_token: 'continuation-access',
          refresh_token: 'continuation-refresh',
        };
      },
    }),
  });

  const job = state.jobs[0];
  assert.equal(state.status, 'complete');
  assert.equal(job.status, 'complete');
  assert.ok(job.cpaPath, 'the rebuilt authorization must produce the CPA the first attempt lost');
  assert.equal(oauthRuns, 2);
  assert.equal(job.oauthContinuationRestarts, 1);
  assert.equal(
    state.events.some((record) => record.type === 'oauth_continuation_restarted'),
    true,
  );
  // A new authorization, not a replay of the one the server threw away.
  assert.equal(pkceStates.length, 2);
  assert.notEqual(pkceStates[0], pkceStates[1]);
  assert.ok(pkceStates.every(Boolean));
  // The account was already verified, so the rebuild asks for no second phone.
  assert.equal(smsAcquires, 0);
});

test('a consent continuation is rebuilt once, and a second invalidation is a real rejection', async (t) => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    postRegistrationOAuth: true,
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
    security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-oauth-continuation-limit' });
  const store = temporaryStore(t);
  const mail = mailboxClient([{ id: 'mail-continuation-limit', email: 'continuation-limit@example.test', tokenValid: true, bound: false }]);
  let oauthRuns = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: store,
    mailClient: mail,
    smsProvider: { async acquireNumber() { throw new Error('phone challenge was not requested'); } },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) { finishSession(sessionState, job); },
    }),
    oauthRunnerFactory: () => ({
      async run() {
        oauthRuns += 1;
        throw Object.assign(new Error('workspace_select failed with HTTP 409: invalid_state'), {
          code: 'INVALID_STATE',
          status: 409,
        });
      },
    }),
  });

  const job = state.jobs[0];
  assert.equal(job.oauthContinuationRestarts, 1);
  assert.equal(oauthRuns, 2);
  assert.ok(!job.cpaPath);
  // The login state is real either way, so the account is kept for a later
  // OAuth task rather than thrown away with the failed authorization.
  assert.ok(store.get(job.sessionAssetId));
});

test('login-state registration can continue OAuth from the saved asset without a second login', async (t) => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    postRegistrationOAuth: true,
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-session-then-oauth' });
  const store = temporaryStore(t);
  const mail = mailboxClient([{ id: 'mail-session-oauth', email: 'session-oauth@example.test', tokenValid: true, bound: false }]);
  let sessionRuns = 0;
  let oauthRuns = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: store,
    mailClient: mail,
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        sessionRuns += 1;
        sessionState.accountCreated = true;
        finishSession(sessionState, job);
      },
    }),
    oauthRunnerFactory: () => ({
      async run(oauthState) {
        oauthRuns += 1;
        oauthState.step = 'complete';
        oauthState.status = 'complete';
        oauthState.account = {
          email: oauthState.email,
          access_token: 'session-oauth-access',
          refresh_token: 'session-oauth-refresh',
        };
      },
    }),
  });

  const asset = store.get(state.jobs[0].sessionAssetId);
  assert.equal(state.status, 'complete');
  assert.equal(state.jobs[0].result, 'session_and_cpa_saved');
  assert.equal(asset.sourceKind, 'register_session');
  assert.equal(asset.cpa.runId, state.runId);
  assert.equal(sessionRuns, 1);
  assert.equal(oauthRuns, 1);
  assert.equal(state.events.some((record) => record.type === 'post_registration_oauth_started'), true);
});

test('OAuth inventory retries reuse the verified registration session without re-saving it', async (t) => {
  const config = branchConfig(1);
  config.sms.inventoryWaitMs = 100;
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    postRegistrationOAuth: true,
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-session-oauth-inventory-retry' });
  const store = temporaryStore(t);
  const mail = mailboxClient([{ id: 'mail-session-oauth-inventory', email: 'session-oauth-inventory@example.test', tokenValid: true, bound: false }]);
  let sessionRuns = 0;
  let oauthRuns = 0;
  let acquireCalls = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: store,
    mailClient: mail,
    smsInventoryPollIntervalMs: 1,
    proxyEntries: [{ id: 'proxy-session-oauth-inventory', url: 'http://127.0.0.1:4101', workerSlots: [1] }],
    smsProvider: {
      service: 'mock', country: '151',
      async preflight() { return { provider: 'mock', ready: true, balance: 1, prices: [{ price: 0.02, count: 1 }] }; },
      async acquireNumber() {
        acquireCalls += 1;
        if (acquireCalls === 1) {
          throw Object.assign(new Error('No numbers are currently available'), {
            code: 'NO_NUMBERS', category: 'availability', retryable: true,
          });
        }
        return { id: 'activation-session-oauth-inventory', activationId: 'activation-session-oauth-inventory', number: '+56912345678', status: 'leased', cost: 0.02 };
      },
      async markSmsSent(lease) { return { ...lease, status: 'waiting' }; },
      async pollCode() { return { code: '123456', status: 'received' }; },
      async complete(lease) { return { ...lease, status: 'complete' }; },
      async cancel(lease) { return { ...lease, status: 'cancelled' }; },
    },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        sessionRuns += 1;
        sessionState.accountCreated = true;
        finishSession(sessionState, job);
      },
    }),
    oauthRunnerFactory: () => ({
      async run(oauthState) {
        oauthRuns += 1;
        if (oauthState.step === 'initial' || oauthState.step === 'phone_required') {
          if (oauthState.step === 'initial') oauthState.step = 'phone_required';
          return;
        }
        if (oauthState.step === 'navigating') {
          oauthState.step = 'complete';
          oauthState.status = 'complete';
          oauthState.account = {
            email: oauthState.email,
            access_token: 'inventory-retry-access',
            refresh_token: 'inventory-retry-refresh',
          };
        }
      },
      async sendPhone(oauthState) { oauthState.step = 'phone_otp_sent'; },
      async validatePhone(oauthState) { oauthState.step = 'navigating'; },
    }),
  });

  assert.equal(state.status, 'complete');
  assert.equal(state.jobs[0].result, 'session_and_cpa_saved');
  assert.equal(sessionRuns, 1);
  assert.equal(acquireCalls, 2);
  assert.equal(state.events.filter((record) => record.type === 'post_registration_oauth_started').length, 1);
  assert.equal(state.events.filter((record) => record.type === 'session_stage_reused_for_oauth_retry').length, 1);
  assert.equal(state.events.filter((record) => record.type === 'branch_job_waiting' && record.code === 'NO_NUMBERS').length, 1);
  assert.ok(oauthRuns >= 3);
});

test('an expired no-number OAuth checkpoint restarts PKCE without repeating login', async (t) => {
  const config = branchConfig(1);
  config.sms.inventoryWaitMs = 100;
  const store = temporaryStore(t);
  const seed = makeInitialChatGptSessionState({ email: 'oauth-expired-inventory@example.test' });
  const asset = store.upsert({
    email: seed.email,
    parentEmail: seed.email,
    accountId: 'account-oauth-expired-inventory',
    accessToken: 'access-oauth-expired-inventory',
    sessionToken: 'session-oauth-expired-inventory',
    cookieJar: seed.cookieJar,
    clientProfile: seed.clientProfile,
    clientProfileFingerprint: seed.clientProfileFingerprint,
    oaiDid: seed.oaiDid,
    sourceProxy: { id: 'registration-proxy', url: 'http://127.0.0.1:4199' },
    status: 'valid',
  });
  const plan = normalizeRunPlan({
    taskKind: 'oauth', workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: [asset.id] },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-oauth-expired-inventory' });
  let sessionRuns = 0;
  let acquireCalls = 0;
  const oauthContracts = [];

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: store,
    smsInventoryPollIntervalMs: 1,
    smsProvider: {
      service: 'mock', country: '151',
      async preflight() { return { provider: 'mock', ready: true }; },
      async acquireNumber() {
        acquireCalls += 1;
        if (acquireCalls === 1) {
          state.jobs[0].oauthState.oauth.expiresAt = '2000-01-01T00:00:00.000Z';
          throw Object.assign(new Error('No numbers are currently available'), {
            code: 'NO_NUMBERS', category: 'availability', retryable: true,
          });
        }
        return { id: 'activation-expired-oauth', activationId: 'activation-expired-oauth', number: '+56912345678', status: 'leased', cost: 0.02 };
      },
      async markSmsSent(lease) { return { ...lease, status: 'waiting' }; },
      async pollCode() { return { code: '123456', status: 'received' }; },
      async complete(lease) { return { ...lease, status: 'complete' }; },
      async cancel(lease) { return { ...lease, status: 'cancelled' }; },
    },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        sessionRuns += 1;
        finishSession(sessionState, job);
      },
    }),
    oauthRunnerFactory: () => ({
      async run(oauthState) {
        oauthContracts.push(oauthState.oauth.state);
        if (oauthState.step === 'initial') oauthState.step = 'phone_required';
        else if (oauthState.step === 'navigating') {
          oauthState.step = 'complete';
          oauthState.status = 'complete';
          oauthState.account = { email: oauthState.email, access_token: 'oauth-expired-access', refresh_token: 'oauth-expired-refresh' };
        }
      },
      async sendPhone(oauthState) { oauthState.step = 'phone_otp_sent'; },
      async validatePhone(oauthState) { oauthState.step = 'navigating'; },
    }),
  });

  assert.equal(state.status, 'complete');
  assert.equal(sessionRuns, 1);
  assert.equal(acquireCalls, 2);
  assert.equal(new Set(oauthContracts).size, 2);
  assert.equal(state.jobs[0].oauthInventoryRestarts, 1);
  assert.equal(state.events.filter((record) => record.type === 'oauth_inventory_wait_restarted').length, 1);
});

function badStatusOAuthRun(t, runId, { codeOnReconcile }) {
  const config = branchConfig(1);
  const store = temporaryStore(t);
  const seed = makeInitialChatGptSessionState({ email: `${runId}@example.test` });
  const asset = store.upsert({
    email: seed.email,
    parentEmail: seed.email,
    accountId: `account-${runId}`,
    accessToken: `access-${runId}`,
    sessionToken: `session-${runId}`,
    cookieJar: seed.cookieJar,
    clientProfile: seed.clientProfile,
    clientProfileFingerprint: seed.clientProfileFingerprint,
    oaiDid: seed.oaiDid,
    status: 'valid',
  });
  const plan = normalizeRunPlan({
    taskKind: 'oauth', workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: [asset.id] },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId });
  const calls = { acquire: 0, reconcile: 0, poll: 0, cancelled: [], validated: [] };
  const done = runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: store,
    markSentRejectedRecheckDelayMs: 1,
    retryPolicies: {
      waiting_phone_continuity: { delaysMs: [1], maxRetries: 1 },
      waiting_transient: { delaysMs: [1], maxRetries: 1 },
    },
    smsProvider: {
      service: 'mock', country: '151',
      async preflight() { return { provider: 'mock', ready: true }; },
      async acquireNumber() {
        calls.acquire += 1;
        const id = `activation-${runId}-${calls.acquire}`;
        return { id, activationId: id, number: `+5691234567${calls.acquire}`, status: 'leased', cost: 0.02 };
      },
      async markSmsSent(lease) {
        // Only the first number races: its code is already at the provider.
        if (lease.id.endsWith('-1')) {
          throw Object.assign(new Error('SMSBower setStatus failed: BAD_STATUS'), { code: 'BAD_STATUS' });
        }
        return { ...lease, status: 'waiting' };
      },
      async reconcile(lease) {
        calls.reconcile += 1;
        return codeOnReconcile
          ? { ...lease, status: 'code_received', providerStatus: 'STATUS_OK', code: '246810' }
          : { ...lease, status: 'waiting_code', providerStatus: 'STATUS_WAIT_CODE' };
      },
      async pollCode() { calls.poll += 1; return { code: '135790', status: 'received' }; },
      async complete(lease) { return { ...lease, status: 'complete' }; },
      async cancel(lease) { calls.cancelled.push(lease.id); return { ...lease, status: 'cancelled' }; },
    },
    sessionRunnerFactory: ({ job }) => ({ async run(sessionState) { finishSession(sessionState, job); } }),
    oauthRunnerFactory: () => ({
      async run(oauthState) {
        if (oauthState.step === 'initial') oauthState.step = 'phone_required';
        else if (oauthState.step === 'navigating') {
          oauthState.step = 'complete';
          oauthState.status = 'complete';
          oauthState.account = { email: oauthState.email, access_token: 'a', refresh_token: 'r' };
        }
      },
      async sendPhone(oauthState) { oauthState.step = 'phone_otp_sent'; },
      async validatePhone(oauthState, code) { calls.validated.push(code); oauthState.step = 'navigating'; },
    }),
  });
  return { state, calls, done };
}

test('a BAD_STATUS on mark-sent reads the activation and uses a code that already arrived', async (t) => {
  // Two OAuth jobs on 2026-10-05: the phone send succeeded, setStatus(1) came
  // back BAD_STATUS five seconds later because the code had already landed,
  // and the job never polled — it rotated the exit and threw the paid
  // activation away with the code still on it.
  const { state, calls, done } = badStatusOAuthRun(t, 'bad-status-code', { codeOnReconcile: true });
  await done;
  assert.equal(state.jobs[0].status, 'complete');
  assert.equal(calls.acquire, 1, 'the same activation finishes the phone step');
  assert.deepEqual(calls.validated, ['246810']);
  assert.equal(calls.poll, 0, 'the code came from the status read, not a later poll');
  assert.deepEqual(calls.cancelled, []);
  assert.equal(state.events.some((record) => record.type === 'sms_mark_sent_rejected_status_checked' && record.hasCode), true);
});

test('a BAD_STATUS on mark-sent with no code yet keeps the existing replacement path', async (t) => {
  const { state, calls, done } = badStatusOAuthRun(t, 'bad-status-empty', { codeOnReconcile: false });
  await done;
  const checks = state.events.filter((record) => record.type === 'sms_mark_sent_rejected_status_checked');
  assert.equal(checks.length >= 2, true, 'read now and once more shortly after');
  assert.equal(checks.every((record) => record.hasCode === false), true);
  // Nothing recovered here: the job falls back to the existing BAD_STATUS
  // wait, exactly as before this change.
  assert.equal(calls.validated.includes('246810'), false);
  assert.equal(state.events.some((record) => record.type === 'branch_job_waiting' && record.code === 'BAD_STATUS'), true);
});

test('OAuth rebuilds a definitive invalid_state phone transaction and reuses the same unsent SMS lease', async (t) => {
  const config = branchConfig(1);
  const store = temporaryStore(t);
  const seed = makeInitialChatGptSessionState({ email: 'oauth-phone-state@example.test' });
  const asset = store.upsert({
    email: seed.email,
    parentEmail: seed.email,
    accountId: 'account-oauth-phone-state',
    accessToken: 'access-oauth-phone-state',
    sessionToken: 'session-oauth-phone-state',
    cookieJar: seed.cookieJar,
    clientProfile: seed.clientProfile,
    clientProfileFingerprint: seed.clientProfileFingerprint,
    oaiDid: seed.oaiDid,
    status: 'valid',
  });
  const plan = normalizeRunPlan({
    taskKind: 'oauth', workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: [asset.id] },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-oauth-phone-state' });
  let acquireCalls = 0;
  let sendCalls = 0;
  const oauthContracts = [];

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: store,
    smsProvider: {
      service: 'mock', country: '151',
      async preflight() { return { provider: 'mock', ready: true }; },
      async acquireNumber() {
        acquireCalls += 1;
        return { id: 'activation-oauth-state', activationId: 'activation-oauth-state', number: '+56912345678', status: 'leased', cost: 0.02 };
      },
      async markSmsSent(lease) { return { ...lease, status: 'waiting' }; },
      async pollCode() { return { code: '123456', status: 'received' }; },
      async complete(lease) { return { ...lease, status: 'complete' }; },
      async cancel(lease) { return { ...lease, status: 'cancelled' }; },
    },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) { finishSession(sessionState, job); },
    }),
    oauthRunnerFactory: () => ({
      async run(oauthState) {
        oauthContracts.push(oauthState.oauth.state);
        if (oauthState.step === 'initial') oauthState.step = 'phone_required';
        else if (oauthState.step === 'navigating') {
          oauthState.step = 'complete';
          oauthState.status = 'complete';
          oauthState.account = { email: oauthState.email, access_token: 'oauth-state-access', refresh_token: 'oauth-state-refresh' };
        }
      },
      async sendPhone(oauthState) {
        sendCalls += 1;
        if (sendCalls === 1) {
          throw Object.assign(new Error('oauth_phone_send failed with HTTP 409: invalid_state'), {
            code: 'INVALID_STATE', status: 409,
          });
        }
        oauthState.step = 'phone_otp_sent';
      },
      async validatePhone(oauthState) { oauthState.step = 'navigating'; },
    }),
  });

  assert.equal(state.status, 'complete');
  assert.equal(acquireCalls, 1);
  assert.equal(sendCalls, 2);
  assert.equal(new Set(oauthContracts).size, 2);
  assert.equal(state.jobs[0].sms.attempts[0].activationId, 'activation-oauth-state');
  assert.equal(state.jobs[0].sms.attempts[0].oauthTransactionRestarts, 1);
  assert.equal(state.events.filter((record) => record.type === 'oauth_phone_transaction_restarted').length, 1);
});

test('OAuth automatically rebuilds an invalid_auth_step phone transaction instead of parking', async (t) => {
  const config = branchConfig(1);
  const store = temporaryStore(t);
  const seed = makeInitialChatGptSessionState({ email: 'oauth-phone-auth-step@example.test' });
  const asset = store.upsert({
    email: seed.email,
    parentEmail: seed.email,
    accountId: 'account-oauth-phone-auth-step',
    accessToken: 'access-oauth-phone-auth-step',
    sessionToken: 'session-oauth-phone-auth-step',
    cookieJar: seed.cookieJar,
    clientProfile: seed.clientProfile,
    clientProfileFingerprint: seed.clientProfileFingerprint,
    oaiDid: seed.oaiDid,
    status: 'valid',
  });
  const plan = normalizeRunPlan({
    taskKind: 'oauth', workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: [asset.id] },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-oauth-phone-auth-step' });
  let acquireCalls = 0;
  let sendCalls = 0;
  const oauthContracts = [];

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: store,
    smsProvider: {
      service: 'mock', country: '151',
      async preflight() { return { provider: 'mock', ready: true }; },
      async acquireNumber() {
        acquireCalls += 1;
        return { id: 'activation-oauth-auth-step', activationId: 'activation-oauth-auth-step', number: '+56912345678', status: 'leased', cost: 0.02 };
      },
      async markSmsSent(lease) { return { ...lease, status: 'waiting' }; },
      async pollCode() { return { code: '123456', status: 'received' }; },
      async complete(lease) { return { ...lease, status: 'complete' }; },
      async cancel(lease) { return { ...lease, status: 'cancelled' }; },
    },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) { finishSession(sessionState, job); },
    }),
    oauthRunnerFactory: () => ({
      async run(oauthState) {
        oauthContracts.push(oauthState.oauth.state);
        if (oauthState.step === 'initial') oauthState.step = 'phone_otp_sent';
        else if (oauthState.step === 'navigating') {
          oauthState.step = 'complete';
          oauthState.status = 'complete';
          oauthState.account = { email: oauthState.email, access_token: 'oauth-auth-step-access' };
        }
      },
      async sendPhone(oauthState) {
        sendCalls += 1;
        if (sendCalls === 1) {
          throw Object.assign(new Error('oauth_phone_send failed with HTTP 400: invalid_auth_step'), {
            code: 'INVALID_AUTH_STEP', status: 400,
          });
        }
        oauthState.step = 'phone_otp_sent';
      },
      async validatePhone(oauthState) { oauthState.step = 'navigating'; },
    }),
  });

  assert.equal(state.status, 'complete');
  assert.equal(state.jobs[0].status, 'complete');
  assert.equal(acquireCalls, 1);
  assert.equal(sendCalls, 2);
  assert.equal(new Set(oauthContracts).size, 2);
  assert.equal(state.jobs[0].sms.attempts[0].activationId, 'activation-oauth-auth-step');
  assert.equal(state.jobs[0].sms.attempts[0].oauthTransactionRestarts, 1);
  assert.equal(state.events.filter((record) => record.type === 'oauth_phone_transaction_restarted').length, 1);
  assert.equal(state.events.some((record) => record.type === 'branch_job_waiting'), false);
});

test('resume rebuilds a persisted pre-send invalid_state checkpoint without dropping its SMS lease', () => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({
    taskKind: 'oauth', workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: ['asset-oauth-resume-state'] },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-oauth-phone-state-resume' });
  const oauthState = makeInitialCockpitOAuthState({
    email: 'oauth-phone-resume@example.test',
    accountId: 'account-oauth-phone-resume',
  });
  oauthState.step = 'phone_required';
  const previousPkceState = oauthState.oauth.state;
  state.status = 'waiting';
  state.phase = 'waiting_phone_continuity';
  state.jobs.push({
    id: 'job-oauth-phone-resume', taskKind: 'oauth', assetId: 'asset-oauth-resume-state',
    email: oauthState.email, parentEmail: oauthState.email, mailboxId: '', laneId: 'asset-oauth-resume-state',
    status: 'waiting', phase: 'waiting_phone_continuity', oauthState,
    oauthRecovery: { status: 'idle', attempts: 0 },
    sms: {
      current: {
        id: 'activation-oauth-resume', activationId: 'activation-oauth-resume', number: '+56912345678',
        scope: 'oauth', status: 'leased', effect: { kind: 'target_phone_send', scope: 'oauth' },
      },
      attempts: [], acquisitions: [], acquisition: null, costUsd: 0.02, replacements: 0, sendRetries: 0,
    },
    error: { code: 'INVALID_STATE', status: 409, message: 'oauth_phone_send failed with HTTP 409: invalid_state' },
  });

  resumeBranchState(state, { now: () => Date.parse('2026-08-08T10:00:00.000Z') });

  assert.equal(state.status, 'initialized');
  assert.equal(state.jobs[0].status, 'queued');
  assert.equal(state.jobs[0].phase, 'resuming_oauth_phone_transaction');
  assert.equal(state.jobs[0].error, null);
  assert.equal(state.jobs[0].sms.current.activationId, 'activation-oauth-resume');
  assert.equal(state.jobs[0].sms.current.effect, null);
  assert.equal(state.jobs[0].sms.current.oauthTransactionRestarts, 1);
  assert.equal(state.jobs[0].oauthState.step, 'initial');
  assert.notEqual(state.jobs[0].oauthState.oauth.state, previousPkceState);
  assert.equal(state.events.at(-1).type, 'oauth_phone_transaction_restarted');
});

test('resume rebuilds the current waiting OAuth phone-validation checkpoint', async (t) => {
  const config = branchConfig(1);
  const store = temporaryStore(t);
  const seed = makeInitialChatGptSessionState({ email: 'oauth-phone-validation-resume@example.test' });
  const asset = store.upsert({
    email: seed.email,
    parentEmail: seed.email,
    accountId: 'account-oauth-phone-validation-resume',
    cookieJar: seed.cookieJar,
    clientProfile: seed.clientProfile,
    clientProfileFingerprint: seed.clientProfileFingerprint,
    oaiDid: seed.oaiDid,
    status: 'valid',
  });
  const plan = normalizeRunPlan({
    taskKind: 'oauth', workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: [asset.id] },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-oauth-phone-validation-resume' });
  const oauthState = makeInitialCockpitOAuthState({
    email: asset.email,
    accountId: asset.accountId,
    cookieJar: asset.cookieJar,
    clientProfile: asset.clientProfile,
    clientProfileFingerprint: asset.clientProfileFingerprint,
    oaiDid: asset.oaiDid,
  });
  oauthState.step = 'phone_otp_sent';
  const previousPkceState = oauthState.oauth.state;
  state.status = 'waiting';
  state.phase = 'waiting_phone_confirmation';
  state.jobs.push({
    id: 'job-oauth-phone-validation-resume',
    taskKind: 'oauth',
    assetId: asset.id,
    email: asset.email,
    parentEmail: asset.email,
    mailboxId: '',
    laneId: asset.id,
    status: 'waiting',
    phase: 'waiting_phone_confirmation',
    oauthState,
    oauthRecovery: { status: 'idle', attempts: 0 },
    sms: {
      current: {
        id: 'activation-oauth-validation-resume',
        activationId: 'activation-oauth-validation-resume',
        number: '+56912345678',
        scope: 'oauth',
        status: 'code_received',
        code: '123456',
        codeReceived: true,
        targetSent: true,
        providerMarkedSent: true,
        effect: { kind: 'target_phone_validate', scope: 'oauth' },
      },
      attempts: [],
      acquisitions: [],
      acquisition: null,
      costUsd: 0.02,
      replacements: 0,
      sendRetries: 0,
    },
    error: { code: 'PHONE_VALIDATION_CONFIRMATION_REQUIRED', message: 'validation outcome is unknown' },
  });

  resumeBranchState(state, { now: () => Date.parse('2026-08-31T12:00:00.000Z') });

  const job = state.jobs[0];
  assert.equal(state.status, 'initialized');
  assert.equal(job.status, 'queued');
  assert.equal(job.phase, 'resuming_oauth_phone_validation');
  assert.equal(job.error, null);
  assert.equal(job.sms.current.effect, null);
  assert.equal(job.oauthPhoneValidationRecovery.status, 'restarting');
  assert.equal(job.oauthPhoneValidationRecovery.attempts, 1);
  assert.equal(job.oauthState.step, 'initial');
  assert.notEqual(job.oauthState.oauth.state, previousPkceState);

  let completeCalls = 0;
  const oauthContracts = [];
  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: store,
    smsProvider: {
      service: 'mock', country: '151',
      async complete(lease) { completeCalls += 1; return { ...lease, status: 'complete' }; },
      async cancel(lease) { return { ...lease, status: 'cancelled' }; },
    },
    sessionRunnerFactory: ({ job: currentJob }) => ({
      async run(sessionState) { finishSession(sessionState, currentJob); },
    }),
    oauthRunnerFactory: () => ({
      async run(current) {
        oauthContracts.push(current.oauth.state);
        if (current.step === 'initial') current.step = 'navigating';
        else if (current.step === 'navigating') {
          current.step = 'complete';
          current.status = 'complete';
          current.account = { email: current.email, access_token: 'oauth-phone-validation-resume-cpa' };
        }
      },
    }),
  });

  assert.equal(state.status, 'complete');
  assert.equal(completeCalls, 1);
  assert.equal(new Set(oauthContracts).size, 1);
  assert.equal(job.sms.attempts[0].status, 'complete');
  assert.equal(job.sms.attempts[0].targetAcceptedInferred, true);
  assert.equal(job.oauthPhoneValidationRecovery.status, 'complete');
  assert.equal(job.oauthPhoneValidationRecovery.outcome, 'previous_phone_accepted');
});

test('a crash after OAuth phone-validation rebuild resumes a restarting checkpoint without replaying the old code', async (t) => {
  const config = branchConfig(1);
  const store = temporaryStore(t);
  const seed = makeInitialChatGptSessionState({ email: 'oauth-phone-restarting-crash@example.test' });
  const asset = store.upsert({
    email: seed.email,
    parentEmail: seed.email,
    accountId: 'account-oauth-phone-restarting-crash',
    cookieJar: seed.cookieJar,
    clientProfile: seed.clientProfile,
    clientProfileFingerprint: seed.clientProfileFingerprint,
    oaiDid: seed.oaiDid,
    status: 'valid',
  });
  const plan = normalizeRunPlan({
    taskKind: 'oauth', workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: [asset.id] },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-oauth-phone-restarting-crash' });
  const persisted = [];
  let crashAtRecoveryCheckpoint = true;
  let acquireCalls = 0;
  let cancelCalls = 0;
  let completeCalls = 0;
  const validatedCodes = [];
  const oauthContracts = [];

  const options = {
    assetStore: store,
    smsProvider: {
      service: 'mock', country: '151',
      async acquireNumber() {
        acquireCalls += 1;
        return {
          id: `activation-restarting-${acquireCalls}`,
          activationId: `activation-restarting-${acquireCalls}`,
          number: '+56912345678',
          status: 'leased',
          cost: 0.02,
        };
      },
      async markSmsSent(lease) { return { ...lease, status: 'waiting' }; },
      async pollCode(lease) {
        return { code: lease.activationId === 'activation-restarting-1' ? 'old-code' : 'new-code', status: 'received' };
      },
      async complete(lease) { completeCalls += 1; return { ...lease, status: 'complete' }; },
      async cancel(lease) { cancelCalls += 1; return { ...lease, status: 'cancelled' }; },
      async requestAnotherCode(lease) { return lease; },
    },
    saveState: async (next) => persisted.push(JSON.parse(JSON.stringify(next))),
    onCheckpoint: ({ reason }) => {
      if (crashAtRecoveryCheckpoint && reason === 'oauth_phone_validation_recovery_started') {
        crashAtRecoveryCheckpoint = false;
        throw Object.assign(new Error('simulated process interruption'), { code: 'PROCESS_INTERRUPTED' });
      }
    },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) { finishSession(sessionState, job); },
    }),
    oauthRunnerFactory: () => ({
      async run(oauthState) {
        oauthContracts.push(oauthState.oauth.state);
        if (oauthState.step === 'initial') oauthState.step = 'phone_required';
        else if (oauthState.step === 'navigating') {
          oauthState.step = 'complete';
          oauthState.status = 'complete';
          oauthState.account = { email: oauthState.email, access_token: 'oauth-restarting-crash-cpa' };
        }
      },
      async sendPhone(oauthState) { oauthState.step = 'phone_otp_sent'; },
      async validatePhone(oauthState, code) {
        validatedCodes.push(code);
        if (validatedCodes.length === 1) {
          throw Object.assign(new Error('validation response was lost'), { code: 'ECONNRESET' });
        }
        oauthState.step = 'navigating';
      },
    }),
  };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, options);

  const restartingSnapshot = persisted.find(
    (snapshot) => snapshot.lastCheckpoint?.reason === 'oauth_phone_validation_recovery_started',
  );
  assert.ok(restartingSnapshot, 'the rebuilt transaction must be durable before the interruption');
  const interruptedJob = restartingSnapshot.jobs[0];
  assert.equal(interruptedJob.oauthPhoneValidationRecovery.status, 'restarting');
  assert.equal(interruptedJob.sms.current.code, '');
  assert.equal(interruptedJob.sms.current.codeReceived, false);
  assert.equal(interruptedJob.sms.current.effect, null);
  assert.equal(interruptedJob.sms.current.status, 'waiting');
  assert.equal(interruptedJob.oauthState.step, 'initial');

  // The first invocation above models the process that was interrupted after
  // its durable write. Reset provider-call observations before replaying the
  // persisted snapshot so the assertions describe the replacement process.
  cancelCalls = 0;
  completeCalls = 0;

  resumeBranchState(restartingSnapshot);
  assert.equal(restartingSnapshot.jobs[0].status, 'queued');
  assert.equal(restartingSnapshot.jobs[0].oauthPhoneValidationRecovery.status, 'restarting');
  assert.equal(restartingSnapshot.jobs[0].sms.current.code, '');

  await runBranchOrchestrator({ log: { entries: [] } }, restartingSnapshot, config, options);

  assert.equal(restartingSnapshot.status, 'complete');
  assert.equal(acquireCalls, 2);
  assert.equal(cancelCalls, 1);
  assert.equal(completeCalls, 1);
  assert.deepEqual(validatedCodes, ['old-code', 'new-code']);
  assert.equal(new Set(oauthContracts).size, 2);
  assert.equal(restartingSnapshot.jobs[0].sms.attempts[0].status, 'cancelled');
  assert.equal(restartingSnapshot.jobs[0].sms.attempts[1].status, 'complete');
  assert.equal(restartingSnapshot.jobs[0].oauthPhoneValidationRecovery.status, 'complete');
  assert.equal(restartingSnapshot.jobs[0].oauthPhoneValidationRecovery.outcome, 'replacement_phone_accepted');
  assert.equal(restartingSnapshot.jobs[0].result, 'cpa_saved');
});

test('resume rebuilds a persisted invalid_auth_step checkpoint without parking the OAuth job', () => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({
    taskKind: 'oauth', workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: ['asset-oauth-auth-step-resume'] },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-oauth-auth-step-resume' });
  const oauthState = makeInitialCockpitOAuthState({
    email: 'oauth-auth-step-resume@example.test',
    accountId: 'account-oauth-auth-step-resume',
  });
  oauthState.step = 'phone_otp_sent';
  const previousPkceState = oauthState.oauth.state;
  state.status = 'waiting';
  state.phase = 'waiting_phone_continuity';
  state.jobs.push({
    id: 'job-oauth-auth-step-resume', taskKind: 'oauth', assetId: 'asset-oauth-auth-step-resume',
    email: oauthState.email, parentEmail: oauthState.email, mailboxId: '', laneId: 'asset-oauth-auth-step-resume',
    status: 'waiting', phase: 'waiting_phone_continuity', oauthState,
    oauthRecovery: { status: 'idle', attempts: 0 },
    sms: {
      current: {
        id: 'activation-oauth-auth-step-resume', activationId: 'activation-oauth-auth-step-resume', number: '+56912345678',
        scope: 'oauth', status: 'leased', effect: { kind: 'target_phone_send', scope: 'oauth' },
      },
      attempts: [], acquisitions: [], acquisition: null, costUsd: 0.02, replacements: 0, sendRetries: 0,
    },
    error: { code: 'INVALID_AUTH_STEP', status: 400, message: 'oauth_phone_send failed with HTTP 400: invalid_auth_step' },
  });

  resumeBranchState(state, { now: () => Date.parse('2026-08-08T10:00:00.000Z') });

  const job = state.jobs[0];
  assert.equal(state.status, 'initialized');
  assert.equal(job.status, 'queued');
  assert.equal(job.phase, 'resuming_oauth_phone_transaction');
  assert.equal(job.error, null);
  assert.equal(job.sms.current.activationId, 'activation-oauth-auth-step-resume');
  assert.equal(job.sms.current.effect, null);
  assert.equal(job.sms.current.oauthTransactionRestarts, 1);
  assert.equal(job.oauthState.step, 'initial');
  assert.notEqual(job.oauthState.oauth.state, previousPkceState);
  assert.equal(state.events.at(-1).type, 'oauth_phone_transaction_restarted');
  assert.equal(state.events.at(-1).code, 'INVALID_AUTH_STEP');
});

test('combined registration holds OAuth back until password and TOTP are both configured', async (t) => {
  // A CPA is sold as a working account. One that never got the password it was
  // supposed to get cannot be signed into again once its mailbox is gone, so
  // running the OAuth leg for it spends phone numbers to mint a dud. The login
  // state is real, so the asset is kept and the job is resumable: security
  // recovery completes the account, and OAuth runs then — once.
  const config = branchConfig(1);
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    postRegistrationOAuth: true,
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
    security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-session-oauth-partial-security' });
  const store = temporaryStore(t);
  const mail = mailboxClient([{ id: 'mail-partial-security', email: 'partial-security@example.test', tokenValid: true, bound: false }]);
  let oauthRuns = 0;
  const oauthRunner = () => ({
    async run(oauthState) {
      oauthRuns += 1;
      oauthState.step = 'complete';
      oauthState.status = 'complete';
      oauthState.account = { email: oauthState.email, access_token: 'partial-access', refresh_token: 'partial-refresh' };
    },
  });

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    // About the resume path, not the in-run security retry; maxRetries 0
    // keeps the job terminal at `partial` exactly as before.
    retryPolicies: { waiting_security_retry: { delaysMs: [1], maxRetries: 0 } },
    assetStore: store,
    mailClient: mail,
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        finishSession(sessionState, job);
        sessionState.status = 'partial';
        sessionState.security = {
          ...(sessionState.security || {}),
          passwordStatus: 'retry_pending',
          totpStatus: 'configured',
          failures: [{ feature: 'password', code: 'ETIMEDOUT', message: 'password setup timed out' }],
        };
      },
    }),
    oauthRunnerFactory: oauthRunner,
  });

  assert.equal(state.status, 'partial');
  assert.equal(state.jobs[0].result, 'session_security_incomplete_oauth_held');
  assert.deepEqual(state.jobs[0].missingSecurity, ['password']);
  assert.equal(oauthRuns, 0);
  assert.ok(!state.jobs[0].cpaPath);
  // The account itself is kept — 登录态资产 lists it for OTP/PW 恢复.
  assert.ok(store.get(state.jobs[0].sessionAssetId));
  assert.equal(state.events.some((record) => record.type === 'post_registration_oauth_held_security_incomplete'), true);
  assert.equal(summarizeBranchState(state).counts.registrationOutcomes.securityIncomplete, 1);
  assert.equal(canResumeBranchState(state), true);

  resumeBranchState(state);
  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    retryPolicies: { waiting_security_retry: { delaysMs: [1], maxRetries: 0 } },
    assetStore: store,
    mailClient: mail,
    sessionRunnerFactory: () => ({
      async run(sessionState) {
        sessionState.status = 'valid';
        sessionState.security.passwordStatus = 'configured';
        sessionState.security.totpStatus = 'configured';
        sessionState.security.failures = [];
      },
    }),
    oauthRunnerFactory: oauthRunner,
  });

  assert.equal(state.status, 'complete');
  assert.ok(state.jobs[0].cpaPath);
  assert.equal(state.jobs[0].result, 'session_and_cpa_saved');
  assert.equal(oauthRuns, 1);
  // The hold is cleared by running again, not left behind. It used to survive
  // the retry that released it, so a job that had since configured its TOTP
  // ran the whole OAuth leg labelled 安全项未完成，已暂停 OAuth and was still
  // counted as an unfinished account on the 注册结果 tile.
  assert.deepEqual(state.jobs[0].missingSecurity, []);
  assert.equal(summarizeBranchState(state).counts.registrationOutcomes.securityIncomplete, undefined);
});

test('the OAuth security gate does not read the plan it was launched with', async (t) => {
  // A plan that skips password or TOTP is refused at launch, so the only way
  // to reach the orchestrator with one is to resume a checkpoint written
  // before that refusal existed. Reading `plan.security` back here would let
  // exactly that run mint the CPA the rule exists to prevent, so the gate
  // asks for both regardless of what the plan wanted.
  const config = branchConfig(1);
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    postRegistrationOAuth: true,
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
    security: { setPassword: true, enrollTotp: true },
  }, config);
  plan.security = { setPassword: false, enrollTotp: false };
  const state = makeInitialBranchState(config, plan, { runId: 'branch-session-oauth-legacy-plan' });
  const store = temporaryStore(t);
  let oauthRuns = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    retryPolicies: { waiting_security_retry: { delaysMs: [1], maxRetries: 0 } },
    assetStore: store,
    mailClient: mailboxClient([{ id: 'mail-legacy-plan', email: 'legacy-plan@example.test', tokenValid: true, bound: false }]),
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        finishSession(sessionState, job);
        sessionState.security = {
          ...(sessionState.security || {}),
          passwordStatus: 'not_requested',
          totpStatus: 'not_requested',
          failures: [],
        };
      },
    }),
    oauthRunnerFactory: () => ({
      async run() { oauthRuns += 1; },
    }),
  });

  assert.equal(state.jobs[0].result, 'session_security_incomplete_oauth_held');
  assert.deepEqual(state.jobs[0].missingSecurity, ['password', 'totp']);
  assert.equal(oauthRuns, 0);
  assert.ok(!state.jobs[0].cpaPath);
  // The login state is real either way, so it is kept for OTP/PW 恢复.
  assert.ok(store.get(state.jobs[0].sessionAssetId));
});

test('combined register_oauth keeps account creation enabled before Cockpit OAuth', async (t) => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({
    taskKind: 'register_oauth',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-register-oauth-create' });
  const store = temporaryStore(t);
  const runOptions = [];

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: store,
    mailClient: mailboxClient([{ id: 'mail-new-account', email: 'new-account@example.test', tokenValid: true, bound: false }]),
    smsProvider: { async acquireNumber() { throw new Error('phone challenge was not requested'); } },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState, options) {
        runOptions.push(options);
        sessionState.accountCreated = true;
        sessionState.existingAccount = false;
        finishSession(sessionState, job);
      },
    }),
    oauthRunnerFactory: () => ({
      async run(oauthState) {
        oauthState.step = 'complete';
        oauthState.status = 'complete';
        oauthState.account = {
          email: oauthState.email,
          access_token: 'created-access',
          refresh_token: 'created-refresh',
        };
      },
    }),
  });

  assert.equal(state.status, 'complete');
  assert.equal(runOptions.length, 1);
  assert.equal(runOptions[0].existingOnly, false);
  assert.equal(state.jobs[0].sessionState.accountCreated, true);
  assert.equal(state.jobs[0].targetDisposition, 'registration_started');
  assert.notEqual(state.jobs[0].accountCreatedAt, '');
  assert.equal(state.jobs[0].result, 'cpa_saved');
});

test('cancellation retains a mailbox after a durable account flow was reached', async () => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({ taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root' }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-retain-target-touched' });
  state.mailboxes.push({ id: 'mail-touched', email: 'touched@example.test', rootEmail: 'touched@example.test', status: 'reserved' });
  state.jobs.push({
    id: 'job-touched', taskKind: 'register_session', email: 'touched@example.test', parentEmail: 'touched@example.test',
    mailboxId: 'mail-touched', laneId: 'mail-touched', status: 'waiting', phase: 'email_otp_sent',
    sessionState: { step: 'email_otp_sent', existingAccount: true, security: {} },
    sms: { current: null, attempts: [], costUsd: 0, replacements: 0, sendRetries: 0 },
  });
  const mail = mailboxClient([]);

  await cancelBranchState(state, config, { mailClient: mail, smsProvider: {} });

  assert.equal(state.status, 'cancelled');
  assert.equal(state.jobs[0].status, 'cancelled');
  assert.equal(state.mailboxes[0].status, 'partial_retained');
  assert.equal(state.mailboxes[0].targetTouched, true);
  assert.deepEqual(mail.released, []);
});

test('a safe legacy invalid-auth-step checkpoint migrates to dynamic register OAuth recovery', () => {
  const state = {
    schemaVersion: 2,
    mode: 'gpt-re-orchestrator-v2',
    runId: 'legacy-invalid-auth-step',
    status: 'waiting',
    phase: 'normal',
    createdAt: '2026-08-05T12:40:07.000Z',
    updatedAt: '2026-08-05T12:40:28.000Z',
    runPlan: { schemaVersion: 2, mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root', aliasCount: 1, aliasMaxAttempts: 1 },
    mailboxes: [{ id: 'mail-legacy', rootEmail: 'legacy@example.test', status: 'reserved', targetCount: 1, maxAttempts: 1 }],
    jobs: [{
      id: 'job-legacy', mailboxId: 'mail-legacy', parentEmail: 'legacy@example.test', email: 'legacy@example.test',
      aliasIndex: 1, status: 'waiting', phase: 'blocked_user_register', error: { code: 'invalid_auth_step', message: 'Invalid authorization step.' },
      runner: {
        blocked: { step: 'user_register', missing: ['http_400'] },
        lastContinueUrl: 'https://auth.openai.com/log-in/password',
        events: [{ step: 'user_register', status: 400, textPreview: JSON.stringify({ error: { code: 'invalid_auth_step' } }) }],
      },
      sms: { current: null, attempts: [] },
      createdAt: '2026-08-05T12:40:08.000Z',
    }],
    workers: [{ id: 'worker-1', status: 'running' }],
    proxyLeases: { owner: 'proxy-one' },
    proxyHealth: { 'proxy-one': { status: 'leased' } },
    events: [],
    control: { requestedAction: null },
  };

  assert.equal(canMigrateLegacyRegisterOAuthState(state), true);
  migrateLegacyRegisterOAuthState(state, { now: () => Date.parse('2026-08-06T00:00:00.000Z') });

  assert.equal(state.taskKind, 'register_oauth');
  assert.equal(state.runPlan.taskKind, 'register_oauth');
  assert.equal(state.status, 'initialized');
  assert.equal(state.phase, 'resuming');
  assert.equal(state.jobs[0].status, 'queued');
  assert.equal(state.jobs[0].sessionState, null);
  assert.equal(state.jobs[0].targetDisposition, 'existing_account');
  assert.equal(state.workers[0].slot, 1);
  assert.deepEqual(state.proxyLeases, {});
  assert.equal(state.events.at(-1).type, 'legacy_register_oauth_migrated');
});

test('branch workers exclude proxies already marked failed', async (t) => {
  const config = branchConfig(1);
  config.proxyPool.required = true;
  const plan = normalizeRunPlan({
    schemaVersion: 3,
    taskKind: 'register_session',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
    proxyAssignments: [{ workerSlot: 1, kind: 'local', localProxyId: 'proxy-failed' }],
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-excludes-failed-proxy' });
  state.proxyHealth['proxy-failed'] = { status: 'failed', reason: 'previous probe failed' };
  let runnerCalls = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([{ id: 'mail-proxy', email: 'proxy@example.test', tokenValid: true, bound: false }]),
    proxyEntries: [{ id: 'proxy-failed', url: 'http://127.0.0.1:4199', workerSlots: [1] }],
    sessionRunnerFactory: () => ({ async run() { runnerCalls += 1; } }),
  });

  // An empty pool parks rather than failing: the checkpoint stays resumable, so
  // adding a healthy proxy and resuming continues the same alias instead of
  // burning it.
  assert.equal(state.status, 'waiting');
  assert.equal(state.jobs[0].status, 'waiting');
  assert.equal(state.jobs[0].phase, 'waiting_proxy_pool');
  assert.equal(state.jobs[0].error.code, 'PROXY_POOL_EXHAUSTED');
  assert.equal(state.jobs[0].nextRunAt, '', 'an empty pool does not refill on a timer');
  assert.equal(runnerCalls, 0);
});

test('proxy pool exhaustion refreshes the waiting Worker and keeps the active exit', async (t) => {
  const config = branchConfig(2);
  config.mail.count = 2;
  config.proxyPool.required = true;
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 2,
    workerConcurrency: 2,
    aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-waiting-proxy-refresh' });
  const usedByWorker = new Map();
  let refreshes = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([
      { id: 'mail-proxy-refresh-1', email: 'proxy-refresh-1@example.test', tokenValid: true, bound: false },
      { id: 'mail-proxy-refresh-2', email: 'proxy-refresh-2@example.test', tokenValid: true, bound: false },
    ]),
    proxyEntries: [{ id: 'proxy-active', url: 'http://proxy-active:4101' }],
    refreshProxyResources: async (details) => {
      refreshes += 1;
      assert.deepEqual(details.workerSlots, [2]);
      return {
        snapshot: {
          schemaVersion: 1,
          entries: [{ id: 'proxy-refreshed', url: 'http://proxy-refreshed:4102' }],
        },
      };
    },
    proxyProbeExecutor: async (_request, probeOptions) => ({ response: { status: 200, url: probeOptions.proxy } }),
    retryPolicies: { waiting_proxy_pool: { delaysMs: [1], maxRetries: 2 } },
    sessionRunnerFactory: ({ job, worker }) => ({
      async run(sessionState) {
        // Hold Worker 1 until Worker 2 has bound its own exit and started.
        // This used to be a flat 15ms sleep, and under load Worker 1 finished
        // first and took the second lane as well, so the refreshed exit showed
        // up on slot 1 and the assertion below failed — roughly half of
        // full-suite runs. Waiting for the other Worker to start is what the
        // test actually means, and it cannot drift.
        if (worker.slot === 1) {
          for (let tick = 0; !usedByWorker.has(2) && tick < 600; tick += 1) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        }
        usedByWorker.set(worker.slot, [...(usedByWorker.get(worker.slot) || []), worker.proxyId]);
        finishSession(sessionState, job);
      },
    }),
  });

  assert.equal(refreshes, 1);
  assert.equal(state.status, 'complete');
  assert.equal(state.jobs.every((job) => job.status === 'complete'), true);
  assert.deepEqual(usedByWorker.get(1), ['proxy-active']);
  assert.deepEqual(usedByWorker.get(2), ['proxy-refreshed']);
  assert.equal(state.events.some((event) => event.type === 'proxy_resources_refreshed_for_waiting_workers'), true);
});

test('branch preflight keeps SMS conditional for login-state registration', async () => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);
  let smsPreflightCalls = 0;
  const preflight = await preflightBranch(config, plan, {
    mailClient: mailboxClient([{ id: 'mail-ready', email: 'ready@example.test', tokenValid: true, bound: false }]),
    smsProvider: { async preflight() { smsPreflightCalls += 1; throw new Error('must stay conditional'); } },
  });

  assert.equal(preflight.ready, true);
  assert.equal(preflight.mail.selected, 1);
  assert.equal(preflight.sms.checked, false);
  assert.equal(preflight.sms.required, false);
  assert.equal(preflight.sms.conditional, true);
  assert.equal(preflight.sms.balance, null);
  assert.equal(smsPreflightCalls, 0);
});

test('disabled Fastmail is rejected by registration preflight without touching its pool', async () => {
  const config = branchConfig(1);
  config.mail.provider = 'fastmail';
  config.mail.providerEnabled = { fastmail: false };
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailProvider: 'fastmail',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);
  let listCalls = 0;
  const preflight = await preflightBranch(config, plan, {
    mailClient: { async listAccounts() { listCalls += 1; return []; } },
  });

  assert.equal(listCalls, 0);
  assert.equal(preflight.ready, false);
  assert.equal(preflight.mail.selected, 0);
  assert.equal(preflight.mail.providerEnabled, false);
  assert.match(preflight.warnings.join(' '), /Fastmail is disabled/);
});

test('registration preflight follows the task Fastmail provider even when global config is Mail.com', async () => {
  const config = branchConfig(1);
  config.mail.provider = 'mailcom';
  config.mail.mailcomBaseUrl = 'http://mailcom.example.test:8001';
  config.mail.fastmailBaseUrl = 'http://fastmail.example.test:8001';
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailProvider: 'fastmail',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);
  const requests = [];
  const preflight = await preflightBranch(config, plan, {
    mailFetch: async (url) => {
      requests.push(String(url));
      if (String(url).includes('/api/pool/accounts')) {
        return new Response(JSON.stringify({
          provider: 'fastmail',
          accounts: [{ id: 'fastmail:alias:1:test', email: 'fast@example.test', tokenValid: true, bound: false }],
          summary: { provider: 'fastmail', available: 1, mailboxes: 1 },
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      throw new Error(`unexpected mail request: ${url}`);
    },
    smsProvider: { async preflight() { return { provider: 'mock', ready: true, balance: 1, prices: [] }; } },
  });

  assert.equal(preflight.ready, true);
  assert.equal(preflight.mail.kind, 'fastmail_pool');
  assert.equal(preflight.mail.provider, 'fastmail');
  assert.equal(requests.length, 1);
  assert.match(requests[0], /fastmail\.example\.test:8001\/api\/pool\/accounts\?provider=fastmail/);
});

test('registration followed by OAuth preflight promotes SMS to a required resource', async () => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    postRegistrationOAuth: true,
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);
  let smsPreflightCalls = 0;
  const preflight = await preflightBranch(config, plan, {
    mailClient: mailboxClient([{ id: 'mail-session-oauth-ready', email: 'session-oauth-ready@example.test', tokenValid: true, bound: false }]),
    smsProvider: { async preflight() { smsPreflightCalls += 1; return { provider: 'mock', ready: true, balance: 1, prices: [] }; } },
  });

  assert.equal(preflight.ready, true);
  assert.equal(preflight.sms.required, true);
  assert.equal(preflight.sms.checked, true);
  assert.equal(smsPreflightCalls, 1);
});

test('pure OAuth keeps SMS conditional until an account actually reaches a phone challenge', async (t) => {
  const config = branchConfig(1);
  const store = temporaryStore(t);
  const seed = makeInitialChatGptSessionState({ email: 'oauth-no-phone@example.test' });
  const asset = store.upsert({
    email: seed.email,
    cookieJar: seed.cookieJar,
    clientProfile: seed.clientProfile,
    clientProfileFingerprint: seed.clientProfileFingerprint,
    oaiDid: seed.oaiDid,
    status: 'valid',
  });
  const plan = normalizeRunPlan({
    taskKind: 'oauth',
    workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: [asset.id] },
  }, config);
  let smsPreflightCalls = 0;
  const preflight = await preflightBranch(config, plan, {
    assetStore: store,
    smsProvider: { async preflight() { smsPreflightCalls += 1; throw new Error('must stay conditional'); } },
  });

  assert.equal(preflight.ready, true);
  assert.equal(preflight.sms.checked, false);
  assert.equal(preflight.sms.required, false);
  assert.equal(preflight.sms.conditional, true);
  assert.equal(smsPreflightCalls, 0);
});

test('OAuth preflight excludes login-state assets that are cooling down', async (t) => {
  const config = branchConfig(1);
  const store = temporaryStore(t);
  const asset = store.upsert({ email: 'oauth-preflight-cooldown@example.test', status: 'valid' });
  store.setOAuthCooldown(asset.id, { failureCount: 21 });
  const plan = normalizeRunPlan({
    taskKind: 'oauth', workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: [asset.id] },
  }, config);

  const preflight = await preflightBranch(config, plan, { assetStore: store });

  assert.equal(preflight.ready, false);
  assert.equal(preflight.mail.selected, 0);
  assert.equal(preflight.mail.requested, 1);
  assert.deepEqual(preflight.mail.cooldownAssetIds, [asset.id]);
  assert.match(preflight.warnings.join(' '), /OAuth cooldown is active/);
});

test('registration-session preflight measures root mailboxes instead of expanded aliases', async () => {
  const config = branchConfig(2);
  config.mail.count = 2;
  config.aliases.count = 2;
  config.aliases.maxAttempts = 2;
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 2,
    workerConcurrency: 2,
    aliasStrategy: 'plus',
    aliasCount: 2,
    aliasMaxAttempts: 2,
  }, config);
  const preflight = await preflightBranch(config, plan, {
    mailClient: mailboxClient([
      { id: 'mail-root-one', email: 'root-one@example.test', tokenValid: true, bound: false },
      { id: 'mail-root-two', email: 'root-two@example.test', tokenValid: true, bound: false },
    ]),
  });

  assert.equal(plan.totalAccounts, 4);
  assert.equal(preflight.ready, true);
  assert.equal(preflight.mail.requested, 2);
  assert.equal(preflight.mail.selected, 2);
});

test('registration OAuth preflight requires live SMS balance, price, and positive inventory', async () => {
  const config = branchConfig(1);
  config.sms.provider = 'smsbower';
  const plan = normalizeRunPlan({
    taskKind: 'register_oauth',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);
  const mailClient = mailboxClient([{ id: 'mail-oauth-ready', email: 'oauth-ready@example.test', tokenValid: true, bound: false }]);
  const smsProvider = {
    async preflight() {
      return {
        provider: 'smsbower', ready: true, balance: 1,
        service: { code: 'dr' }, country: { id: 151 },
        prices: [
          { providerId: 2, price: 0.025, count: 4 },
          { providerId: 1, price: 0.02, count: 0 },
          { providerId: 3, price: 0.022, count: 7 },
        ],
      };
    },
  };
  const ready = await preflightBranch(config, plan, { mailClient, smsProvider });

  assert.equal(ready.ready, true);
  assert.equal(ready.sms.checked, true);
  assert.equal(ready.sms.required, true);
  assert.equal(ready.sms.cheapestPrice, 0.022);
  assert.deepEqual(ready.sms.lowestOffers, [
    { providerId: '3', price: 0.022, count: 7 },
    { providerId: '2', price: 0.025, count: 4 },
  ]);

  smsProvider.preflight = async () => ({ provider: 'smsbower', ready: true, balance: 1, prices: [{ price: 0.01, count: 0 }] });
  const empty = await preflightBranch(config, plan, { mailClient, smsProvider });
  assert.equal(empty.ready, false);
  assert.equal(empty.sms.issue, 'SMS_INVENTORY_EMPTY');
});

test('registration OAuth prepares mail and SMS in parallel and returns reusable resources', { timeout: 1000 }, async () => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({
    taskKind: 'register_oauth',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);
  let startMail;
  let startSms;
  let releaseMail;
  let releaseSms;
  const mailStarted = new Promise((resolve) => { startMail = resolve; });
  const smsStarted = new Promise((resolve) => { startSms = resolve; });
  const mailGate = new Promise((resolve) => { releaseMail = resolve; });
  const smsGate = new Promise((resolve) => { releaseSms = resolve; });
  const mailClient = {
    async listAccounts() {
      startMail();
      await mailGate;
      return { accounts: [{ id: 'mail-parallel', email: 'parallel@example.test', tokenValid: true, bound: false }] };
    },
  };
  const smsProvider = {
    async preflight() {
      startSms();
      await smsGate;
      return { provider: 'mock', ready: true, balance: 1, prices: [] };
    },
  };

  const preparing = prepareBranchPreflight(config, plan, { mailClient, smsProvider });
  await Promise.all([mailStarted, smsStarted]);
  releaseMail();
  releaseSms();
  const prepared = await preparing;

  assert.equal(prepared.snapshot.ready, true);
  assert.equal(prepared.resources.mailClient, mailClient);
  assert.equal(prepared.resources.mailAccounts[0].id, 'mail-parallel');
  assert.equal(prepared.resources.smsProvider, smsProvider);
});

test('credential OAuth preflight counts the pasted accounts and never opens a mail channel', async () => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({
    taskKind: 'oauth',
    workerConcurrency: 1,
    oauthSource: {
      kind: 'credentials',
      accounts: [{ email: 'secured@example.test', password: 'Gpt-Secured!8a', totpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' }],
    },
  }, config);
  let mailCalls = 0;
  const preflight = await preflightBranch(config, plan, {
    // A mail client that answers at all would hide the bug: this task signs in
    // with a password, so touching the provider is itself the failure.
    mailClient: { async listAccounts() { mailCalls += 1; return []; } },
    smsProvider: {
      async preflight() {
        return { provider: 'mock', ready: true, balance: 1, prices: [] };
      },
    },
  });

  assert.equal(mailCalls, 0);
  assert.equal(preflight.mail.kind, 'credentials');
  assert.equal(preflight.mail.requested, 1);
  assert.equal(preflight.mail.selected, 1);
  assert.equal(preflight.ready, true);
});

test('OAuth falls back from an expired saved session and atomically supersedes its canonical CPA', async (t) => {
  const config = branchConfig(1);
  const store = temporaryStore(t);
  const seed = makeInitialChatGptSessionState({ email: 'saved@example.test' });
  const asset = store.upsert({
    email: seed.email,
    parentEmail: seed.email,
    accountId: 'account-saved',
    cookieJar: seed.cookieJar,
    clientProfile: seed.clientProfile,
    clientProfileFingerprint: seed.clientProfileFingerprint,
    oaiDid: seed.oaiDid,
    status: 'valid',
  });
  store.replaceCpa(asset.id, { email: asset.email, access_token: 'old-cpa' }, { runId: 'old-run', jobId: 'old-job' });
  const plan = normalizeRunPlan({
    taskKind: 'oauth',
    workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: [asset.id] },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-oauth-refresh' });
  const seenSteps = [];

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: store,
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        seenSteps.push(sessionState.step);
        if (seenSteps.length === 1) {
          const error = new Error('saved NextAuth token expired');
          error.code = 'SESSION_ACCESS_TOKEN_MISSING';
          throw error;
        }
        finishSession(sessionState, job);
      },
    }),
    oauthRunnerFactory: () => ({
      async run(oauthState) {
        oauthState.step = 'complete';
        oauthState.status = 'complete';
        oauthState.account = { email: oauthState.email, access_token: 'new-cpa', refresh_token: 'refresh-cpa' };
      },
    }),
  });

  const current = store.get(asset.id);
  assert.deepEqual(seenSteps, ['auth_completed', 'initial']);
  assert.equal(state.status, 'complete');
  assert.equal(current.cpa.revision, 2);
  assert.equal(current.cpa.runId, state.runId);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(store.cpaRoot, current.cpa.path), 'utf8')), {
    email: asset.email,
    access_token: 'new-cpa',
    refresh_token: 'refresh-cpa',
  });
  assert.equal(summarizeBranchState(state).counts.cpaCompleted, 1);
});

test('OAuth repairs a rejected auth-domain account session once before restarting PKCE', async (t) => {
  const config = branchConfig(1);
  const store = temporaryStore(t);
  const seed = makeInitialChatGptSessionState({ email: 'stale-auth-session@example.test' });
  const asset = store.upsert({
    email: seed.email,
    parentEmail: seed.email,
    parentMailboxId: 'mail-stale-auth',
    accountId: 'account-stale-auth',
    cookieJar: seed.cookieJar,
    clientProfile: seed.clientProfile,
    clientProfileFingerprint: seed.clientProfileFingerprint,
    oaiDid: seed.oaiDid,
    status: 'valid',
  });
  const plan = normalizeRunPlan({
    taskKind: 'oauth',
    workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: [asset.id] },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-oauth-auth-session-repair' });
  const sessionSteps = [];
  let oauthRuns = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: store,
    mailClient: mailboxClient([{ id: 'mail-stale-auth', email: seed.email, tokenValid: true, bound: true }]),
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        const startingStep = sessionState.step;
        sessionSteps.push(startingStep);
        finishSession(sessionState, job);
        sessionState.existingAccount = true;
        if (startingStep === 'initial') {
          const jar = createCookieJar(sessionState.cookieJar);
          jar.setCookieSync('oai-client-auth-info=repaired-auth-session; Path=/; Secure', 'https://auth.openai.com/');
          sessionState.cookieJar = jar.serializeSync();
        }
      },
    }),
    oauthRunnerFactory: () => ({
      async run(oauthState) {
        oauthRuns += 1;
        if (oauthRuns === 1) {
          const error = new Error('oauth_account_select failed with HTTP 500: unknown response');
          error.code = 'OAUTH_ACCOUNT_SELECT_FAILED';
          error.status = 500;
          error.diagnostics = { status: 500, contentType: '', bodyBytes: 0, bodyHash: '' };
          throw error;
        }
        assert.equal(cookieObjectFor(oauthState.cookieJar, 'https://auth.openai.com/')['oai-client-auth-info'], 'repaired-auth-session');
        oauthState.step = 'complete';
        oauthState.status = 'complete';
        oauthState.account = { email: oauthState.email, access_token: 'repaired-cpa' };
      },
    }),
  });

  assert.equal(state.status, 'complete');
  assert.deepEqual(sessionSteps, ['auth_completed', 'initial']);
  assert.equal(oauthRuns, 2);
  assert.equal(state.jobs[0].oauthRecovery.status, 'complete');
  assert.equal(state.jobs[0].oauthRecovery.attempts, 1);
  assert.equal(state.jobs[0].oauthRecovery.reason, 'oauth_account_session_rejected');
  assert.deepEqual(
    state.events.filter((record) => record.type.startsWith('oauth_login_state_repair_')).map((record) => record.type),
    ['oauth_login_state_repair_scheduled', 'oauth_login_state_repair_started', 'oauth_login_state_repair_completed'],
  );
  assert.equal(store.get(asset.id).sourceKind, 'oauth_reauth');
});

test('migrates an old MFA checkpoint and restores the asset TOTP secret', () => {
  const state = makeInitialChatGptSessionState({ email: 'mfa-migration@example.test' });
  state.step = 'auth_completed';
  state.pageType = 'mfa_challenge';
  state.continueUrl = 'https://auth.openai.com/mfa-challenge/challenge';
  state.security.totpStatus = 'not_requested';
  const migrated = migrateSessionCheckpoint(state, {
    totpSecret: 'JBSWY3DPEHPK3PXP',
    security: { totpStatus: 'configured', enrollTotp: true },
  });

  assert.equal(migrated, state);
  assert.equal(state.step, 'mfa_required');
  assert.equal(state.status, 'running');
  assert.equal(state.totpSecret, 'JBSWY3DPEHPK3PXP');
  assert.equal(state.security.totpStatus, 'configured');
});

test('resumes only a failed OAuth job whose legacy completion checkpoint is still on MFA', () => {
  const state = {
    taskKind: 'oauth',
    runPlan: { oauthSource: { kind: 'session_assets', assetIds: ['asset-mfa-resume'] } },
    status: 'failed',
    phase: 'failed',
    completedAt: '2026-08-06T08:36:52.104Z',
    lastError: null,
    cancelPending: null,
    control: {},
    events: [],
    workers: [{ status: 'idle', currentJobId: '', mailboxId: null }],
    jobs: [{
      id: 'job-mfa-resume',
      assetId: 'asset-mfa-resume',
      status: 'failed',
      phase: 'failed',
      error: { code: 'SESSION_ACCESS_TOKEN_MISSING', message: 'NextAuth session did not return accessToken' },
      sessionState: {
        step: 'auth_completed', status: 'running', pageType: 'mfa_challenge',
        continueUrl: 'https://auth.openai.com/mfa-challenge/challenge',
      },
      oauthRecovery: {
        status: 'in_progress', attempts: 1, reason: 'OAUTH_ACCOUNT_SELECT_FAILED',
        lastError: { code: 'SESSION_ACCESS_TOKEN_MISSING', status: 0 },
      },
      sms: { current: null },
    }],
  };
  const unsupported = JSON.parse(JSON.stringify(state));
  unsupported.jobs[0].sessionState.pageType = 'consent';
  unsupported.jobs[0].sessionState.continueUrl = 'https://auth.openai.com/oauth/consent';

  assert.equal(canResumeBranchState(unsupported), false);
  assert.throws(() => resumeBranchState(unsupported), /Cannot resume terminal branch task: failed/);
  assert.equal(canResumeBranchState(state), true);

  resumeBranchState(state);

  assert.equal(state.status, 'initialized');
  assert.equal(state.phase, 'resuming');
  assert.equal(state.completedAt, '');
  assert.equal(state.jobs[0].status, 'queued');
  assert.equal(state.jobs[0].phase, 'resuming_mfa');
  assert.equal(state.jobs[0].error, null);
  assert.equal(state.jobs[0].sessionState.step, 'mfa_required');
  assert.equal(state.jobs[0].oauthRecovery.reason, 'oauth_mfa_required');
  assert.equal(state.events.at(-1).type, 'session_mfa_checkpoint_migrated');
});

test('a terminal snapshot with waiting work is resumable after an interrupted scheduler write', () => {
  const state = {
    taskKind: 'register_session',
    runPlan: { taskKind: 'register_session', mailCount: 2 },
    status: 'failed',
    phase: 'running',
    completedAt: '2026-09-01T16:26:58.405Z',
    lastError: { code: 'ERUN', message: 'sms provider transport failed' },
    cancelPending: false,
    control: {},
    events: [],
    workers: [{ id: 'worker-1', status: 'idle', currentJobId: '', mailboxId: null }],
    jobs: [
      {
        id: 'job-waiting-proxy',
        status: 'waiting',
        phase: 'waiting_proxy_rotation',
        error: { code: 'CLOUDFLARE_CHALLENGE', message: 'proxy challenged' },
        mailboxId: 'mail-1',
        sms: { current: null },
      },
      {
        id: 'job-waiting-rental',
        status: 'waiting',
        phase: 'waiting_mail_rental',
        error: { code: 'MAIL_RENTAL_UNAVAILABLE', message: 'mail stock is temporarily empty' },
        mailboxId: '',
        rentalReplacementFor: 'job-waiting-proxy',
        sms: { current: null },
      },
    ],
  };

  assert.equal(canResumeBranchState(state), true);
  resumeBranchState(state, { now: () => Date.now() });

  assert.equal(state.status, 'initialized');
  assert.equal(state.phase, 'resuming');
  assert.equal(state.completedAt, '');
  assert.equal(state.lastError, null);
  assert.equal(state.jobs[0].status, 'queued');
  assert.equal(state.jobs[0].phase, 'queued');
  assert.equal(state.jobs[0].error, null);
  assert.equal(state.jobs[1].status, 'queued');
  assert.equal(state.jobs[1].phase, 'queued');
  assert.equal(state.jobs[1].error, null);
});

test('resumes a failed NextAuth OAuth checkpoint with a fresh Cockpit PKCE transaction', () => {
  const state = {
    taskKind: 'oauth',
    runPlan: { oauthSource: { kind: 'session_assets', assetIds: ['asset-protocol-resume'] } },
    status: 'failed',
    phase: 'failed',
    completedAt: '2026-08-06T11:28:13.002Z',
    lastError: null,
    cancelPending: null,
    control: {},
    events: [],
    workers: [{ status: 'idle', currentJobId: '', mailboxId: null }],
    jobs: [{
      id: 'job-protocol-resume',
      assetId: 'asset-protocol-resume',
      status: 'failed',
      phase: 'failed',
      error: { code: 'EMPTY_STRING', message: 'Invalid code_verifier: empty string' },
      oauthState: {
        mode: 'cockpit-oauth',
        step: 'token_exchange_pending',
        oauth: { protocol: 'chatgpt-nextauth-oauth' },
        tokens: null,
      },
      oauthRecovery: { status: 'idle', attempts: 0, reason: '', lastError: null },
      sms: { current: null },
      cpaPath: '',
    }],
  };

  assert.equal(canResumeBranchState(state), true);
  resumeBranchState(state);

  assert.equal(state.status, 'initialized');
  assert.equal(state.phase, 'resuming');
  assert.equal(state.completedAt, '');
  assert.equal(state.jobs[0].status, 'queued');
  assert.equal(state.jobs[0].phase, 'resuming_oauth_protocol');
  assert.equal(state.jobs[0].error, null);
  assert.equal(state.jobs[0].oauthState, null);
  assert.deepEqual(state.events.at(-1), {
    at: state.jobs[0].updatedAt,
    type: 'oauth_protocol_checkpoint_discarded',
    jobId: 'job-protocol-resume',
    staleProtocol: 'chatgpt-nextauth-oauth',
    nextProtocol: 'codex-pkce',
    reason: 'non_cockpit_oauth_transaction',
  });
});

test('OAuth does not repeat email login repair when account selection still fails afterwards', async (t) => {
  const config = branchConfig(1);
  const store = temporaryStore(t);
  const seed = makeInitialChatGptSessionState({ email: 'persistent-select-failure@example.test' });
  const asset = store.upsert({
    email: seed.email,
    parentEmail: seed.email,
    parentMailboxId: 'mail-persistent-select',
    accountId: 'account-persistent-select',
    cookieJar: seed.cookieJar,
    clientProfile: seed.clientProfile,
    clientProfileFingerprint: seed.clientProfileFingerprint,
    oaiDid: seed.oaiDid,
    status: 'valid',
  });
  const plan = normalizeRunPlan({
    taskKind: 'oauth', workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: [asset.id] },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-oauth-one-auth-repair' });
  let freshEmailLogins = 0;
  let oauthRuns = 0;
  const options = {
    assetStore: store,
    mailClient: mailboxClient([{ id: 'mail-persistent-select', email: seed.email, tokenValid: true, bound: true }]),
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        if (sessionState.step === 'initial') freshEmailLogins += 1;
        finishSession(sessionState, job);
        sessionState.existingAccount = true;
      },
    }),
    oauthRunnerFactory: () => ({
      async run() {
        oauthRuns += 1;
        throw Object.assign(new Error('account selection still returns 500'), {
          code: 'OAUTH_ACCOUNT_SELECT_FAILED',
          status: 500,
        });
      },
    }),
    // This test is about login repair not repeating, not about the retry
    // ladder; an empty policy table keeps the in-run retries out of the way.
    retryPolicies: {},
  };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, options);
  assert.equal(state.status, 'waiting');
  assert.equal(state.jobs[0].oauthRecovery.attempts, 1);
  assert.equal(freshEmailLogins, 1);

  resumeBranchState(state);
  await runBranchOrchestrator({ log: { entries: [] } }, state, config, options);

  assert.equal(state.status, 'waiting');
  assert.equal(state.jobs[0].oauthRecovery.attempts, 1);
  assert.equal(freshEmailLogins, 1);
  assert.equal(oauthRuns, 3);
  assert.equal(state.events.filter((record) => record.type === 'oauth_login_state_repair_started').length, 1);
});

test('final OAuth login failure marks the session asset as self-use after repair', async (t) => {
  const config = branchConfig(1);
  const store = temporaryStore(t);
  const seed = makeInitialChatGptSessionState({ email: 'oauth-login-required-self-use@example.test' });
  const asset = store.upsert({
    email: seed.email,
    parentEmail: seed.email,
    parentMailboxId: 'mail-oauth-login-required-self-use',
    accountId: 'account-oauth-login-required-self-use',
    cookieJar: seed.cookieJar,
    clientProfile: seed.clientProfile,
    clientProfileFingerprint: seed.clientProfileFingerprint,
    oaiDid: seed.oaiDid,
    status: 'valid',
  });
  const plan = normalizeRunPlan({
    taskKind: 'oauth', workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: [asset.id] },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-oauth-login-required-self-use' });
  let oauthRuns = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: store,
    mailClient: mailboxClient([{
      id: 'mail-oauth-login-required-self-use',
      email: seed.email,
      tokenValid: true,
      bound: true,
    }]),
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        finishSession(sessionState, job);
        sessionState.existingAccount = true;
      },
    }),
    oauthRunnerFactory: () => ({
      async run() {
        oauthRuns += 1;
        throw Object.assign(new Error('OAuth requires an existing authenticated account session'), {
          code: 'OAUTH_LOGIN_REQUIRED',
        });
      },
    }),
    retryPolicies: {},
  });

  const stored = store.get(asset.id);
  assert.equal(oauthRuns, 2);
  assert.equal(state.jobs[0].status, 'failed');
  assert.equal(state.jobs[0].error.code, 'OAUTH_LOGIN_REQUIRED');
  assert.equal(stored.lifecycle, 'self_use');
  assert.equal(stored.classification, 'active');
  assert.equal(state.events.some((record) => (
    record.type === 'session_asset_marked_self_use'
    && record.assetId === asset.id
  )), true);
});

test('OAuth login failure does not overwrite sold or banned session asset lifecycles', async (t) => {
  const config = branchConfig(1);
  for (const lifecycle of ['sold', 'banned']) {
    const store = temporaryStore(t);
    const seed = makeInitialChatGptSessionState({ email: `oauth-login-required-${lifecycle}@example.test` });
    const asset = store.upsert({
      email: seed.email,
      parentEmail: seed.email,
      parentMailboxId: `mail-oauth-login-required-${lifecycle}`,
      accountId: `account-oauth-login-required-${lifecycle}`,
      cookieJar: seed.cookieJar,
      clientProfile: seed.clientProfile,
      clientProfileFingerprint: seed.clientProfileFingerprint,
      oaiDid: seed.oaiDid,
      status: 'valid',
    });
    if (lifecycle === 'sold') store.markLifecycle([asset.id], lifecycle);
    else store.update(asset.id, { health: { status: 'banned', code: 'ACCOUNT_DEACTIVATED' } });
    const plan = normalizeRunPlan({
      taskKind: 'oauth', workerConcurrency: 1,
      oauthSource: { kind: 'session_assets', assetIds: [asset.id] },
    }, config);
    const state = makeInitialBranchState(config, plan, { runId: `branch-oauth-login-required-${lifecycle}` });

    await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
      assetStore: store,
      mailClient: mailboxClient([{
        id: `mail-oauth-login-required-${lifecycle}`,
        email: seed.email,
        tokenValid: true,
        bound: true,
      }]),
      sessionRunnerFactory: ({ job }) => ({
        async run(sessionState) {
          finishSession(sessionState, job);
          sessionState.existingAccount = true;
        },
      }),
      oauthRunnerFactory: () => ({
        async run() {
          throw Object.assign(new Error('OAuth requires an existing authenticated account session'), {
            code: 'OAUTH_LOGIN_REQUIRED',
          });
        },
      }),
      retryPolicies: {},
    });

    assert.equal(store.list().find((row) => row.id === asset.id).lifecycle, lifecycle);
    assert.equal(state.events.some((record) => record.type === 'session_asset_marked_self_use'), false);
  }
});

test('OAuth email source logs into an existing account before OAuth and cannot enable account creation', async (t) => {
  const config = branchConfig(1);
  const store = temporaryStore(t);
  const plan = normalizeRunPlan({
    taskKind: 'oauth',
    workerConcurrency: 1,
    oauthSource: {
      kind: 'credentials',
      accounts: [{ email: 'existing-email@example.test', password: 'Gpt-Existing!8a', totpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' }],
    },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-oauth-existing-email' });
  const runOptions = [];
  const seededCredentials = [];
  let smsAcquires = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: store,
    mailClient: { async listAccounts() { throw new Error('credential OAuth must not open a mailbox'); } },
    smsProvider: {
      async acquireNumber() { smsAcquires += 1; throw new Error('No phone challenge was returned'); },
    },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState, options) {
        runOptions.push(options);
        seededCredentials.push({ password: sessionState.password, totpSecret: sessionState.totpSecret });
        finishSession(sessionState, job);
        sessionState.existingAccount = true;
      },
    }),
    oauthRunnerFactory: () => ({
      async run(oauthState) {
        oauthState.step = 'complete';
        oauthState.status = 'complete';
        oauthState.account = { email: oauthState.email, access_token: 'existing-email-cpa' };
      },
    }),
  });

  assert.equal(state.status, 'complete');
  assert.equal(runOptions.length > 0, true);
  assert.equal(runOptions.every((options) => options.existingOnly === true), true);
  // The pasted secrets have to reach the session state, or the runner would
  // fall back to the passwordless OTP and wait on a mailbox that is never read.
  assert.deepEqual(seededCredentials[0], {
    password: 'Gpt-Existing!8a',
    totpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
  });
  assert.equal(state.jobs[0].sessionState.accountCreated, undefined);
  assert.equal(state.jobs[0].sessionState.existingAccount, true);
  assert.equal(smsAcquires, 0);
});

test('a created account finished by re-login reports session_saved, not existing-account recovery', () => {
  const { _registrationJobResult: result } = require('../src/branch-orchestrator');
  const recovered = { result: 'existing_account_recovered', sessionState: { existingAccount: true } };
  // Truly pre-existing: nothing in the job says this run created it.
  assert.equal(result(recovered), 'existing_account_recovered');
  // Created here, callback lost, finished by signing in again.
  assert.equal(result({ ...recovered, accountCreatedAt: '2026-10-13T16:28:34.795Z' }), 'session_saved');
  assert.equal(result({ ...recovered, callbackLoginRecovery: { status: 'complete', causeCode: 'CALLBACK_CONTINUATION_UNAVAILABLE' } }), 'session_saved');
  assert.equal(result({ result: 'session_saved' }), 'session_saved');
});

test('login-only credential run saves the login state and never starts OAuth', async (t) => {
  const config = branchConfig(1);
  const store = temporaryStore(t);
  const plan = normalizeRunPlan({
    taskKind: 'oauth',
    workerConcurrency: 1,
    oauthSource: {
      kind: 'credentials',
      loginOnly: true,
      accounts: [{ email: 'login-only@example.test', password: 'Gpt-LoginOnly!8a', totpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' }],
    },
  }, config);
  assert.equal(plan.oauthSource.loginOnly, true);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-login-only-credentials' });
  const seededCredentials = [];
  let oauthRuns = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: store,
    mailClient: { async listAccounts() { throw new Error('credential login must not open a mailbox'); } },
    smsProvider: { async acquireNumber() { throw new Error('No phone challenge was returned'); } },
    sessionRunnerFactory: ({ job, options: runnerOptions }) => ({
      async run(sessionState, options) {
        // No mailbox behind a credentials job: the runner must refuse to send a code.
        assert.equal(runnerOptions.mailboxAvailable, false);
        assert.equal(runnerOptions.getEmailCode, undefined);
        assert.equal(options.existingOnly, true);
        seededCredentials.push({ password: sessionState.password, totpSecret: sessionState.totpSecret });
        finishSession(sessionState, job);
        sessionState.existingAccount = true;
      },
    }),
    oauthRunnerFactory: () => ({
      async run() { oauthRuns += 1; throw new Error('login-only must not run OAuth'); },
    }),
  });

  const job = state.jobs[0];
  assert.equal(state.status, 'complete');
  assert.equal(oauthRuns, 0);
  assert.equal(job.status, 'complete');
  assert.equal(job.result, 'session_saved');
  assert.equal(job.cpaPath || '', '');
  assert.equal(job.oauthState || null, null);
  assert.deepEqual(seededCredentials[0], { password: 'Gpt-LoginOnly!8a', totpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP' });
  const saved = store.get(job.sessionAssetId);
  assert.equal(saved.email, 'login-only@example.test');
  assert.equal(saved.cpa || null, null);
  assert.equal(summarizeBranchState(state).counts.cpaCompleted, 0);
});

test('login-only saved-session run ignores an OAuth cooldown and skips OAuth', async (t) => {
  const config = branchConfig(1);
  const store = temporaryStore(t);
  const seed = makeInitialChatGptSessionState({ email: 'cooling-login@example.test' });
  const asset = store.upsert({
    email: seed.email,
    parentEmail: seed.email,
    accountId: 'account-cooling-login',
    cookieJar: seed.cookieJar,
    clientProfile: seed.clientProfile,
    clientProfileFingerprint: seed.clientProfileFingerprint,
    oaiDid: seed.oaiDid,
    status: 'valid',
    oauthCooldown: { until: new Date(Date.now() + 3_600_000).toISOString(), failureCount: 3 },
  });
  const plan = normalizeRunPlan({
    taskKind: 'oauth',
    workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: [asset.id], loginOnly: true },
  }, config);
  const preflight = await preflightBranch(config, plan, {
    assetStore: store,
    smsProvider: { async preflight() { return { provider: 'mock', ready: true, balance: 1, prices: [] }; } },
  });
  assert.equal(preflight.mail.selected, 1);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-login-only-assets' });
  let oauthRuns = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: store,
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) { finishSession(sessionState, job); },
    }),
    oauthRunnerFactory: () => ({
      async run() { oauthRuns += 1; throw new Error('login-only must not run OAuth'); },
    }),
  });

  assert.equal(state.status, 'complete');
  assert.equal(oauthRuns, 0);
  assert.equal(state.jobs[0].result, 'session_refreshed');
  assert.equal(state.jobs[0].sessionAssetId, asset.id);
});

test('OAuth phone inventory retry reuses the checkpoint state and verified session', async (t) => {
  const config = branchConfig(1);
  config.sms.inventoryWaitMs = 100;
  const store = temporaryStore(t);
  const seed = makeInitialChatGptSessionState({ email: 'oauth-phone-state@example.test' });
  const asset = store.upsert({
    email: seed.email,
    parentEmail: seed.email,
    accountId: 'account-oauth-phone-state',
    cookieJar: seed.cookieJar,
    clientProfile: seed.clientProfile,
    clientProfileFingerprint: seed.clientProfileFingerprint,
    oaiDid: seed.oaiDid,
    sourceProxy: { id: 'registration-proxy', url: 'http://127.0.0.1:4199' },
    status: 'valid',
  });
  const plan = normalizeRunPlan({
    taskKind: 'oauth',
    workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: [asset.id] },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-oauth-phone-state' });
  let oauthStateReference;
  let smsPreflightCalls = 0;
  let sessionRuns = 0;
  let trialChecks = 0;
  let acquireCalls = 0;
  const smsProvider = {
    service: 'mock', country: '151',
    async preflight() { smsPreflightCalls += 1; return { provider: 'mock', ready: true }; },
    async acquireNumber() {
      acquireCalls += 1;
      if (acquireCalls === 1) {
        throw Object.assign(new Error('No numbers are currently available'), {
          code: 'NO_NUMBERS', category: 'availability', retryable: true,
        });
      }
      return { id: 'activation-oauth', activationId: 'activation-oauth', number: '+56912345678', status: 'leased', cost: 0.02 };
    },
    async markSmsSent(lease) { return { ...lease, status: 'waiting' }; },
    async pollCode() { return { code: '123456', status: 'received' }; },
    async complete(lease) { return { ...lease, status: 'complete' }; },
    async cancel(lease) { return { ...lease, status: 'cancelled' }; },
    async requestAnotherCode(lease) { return lease; },
  };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: store,
    smsProvider,
    smsInventoryPollIntervalMs: 1,
    trialChecker: async () => {
      trialChecks += 1;
      return {
        status: 'none',
        code: 'TRIAL_UNAVAILABLE',
        message: 'none',
        httpStatus: 200,
        checkedAt: new Date().toISOString(),
        latencyMs: 1,
        campaigns: [],
      };
    },
    sessionRunnerFactory: () => ({
      async run(sessionState) {
        sessionRuns += 1;
        sessionState.step = 'verified';
        sessionState.status = 'valid';
        sessionState.accessToken = 'access-oauth-phone-state';
        sessionState.sessionToken = 'session-oauth-phone-state';
      },
    }),
    oauthRunnerFactory: ({ job }) => ({
      async run(oauthState) {
        oauthStateReference = oauthState;
        if (oauthState.step === 'initial') oauthState.step = 'phone_required';
        else if (oauthState.step === 'navigating') {
          oauthState.step = 'complete';
          oauthState.status = 'complete';
          oauthState.account = { email: oauthState.email, access_token: 'oauth-phone-cpa' };
        }
      },
      async sendPhone(oauthState) {
        assert.strictEqual(oauthState, job.oauthState);
        oauthState.step = 'phone_otp_sent';
      },
      async validatePhone(oauthState) {
        assert.strictEqual(oauthState, oauthStateReference);
        oauthState.step = 'navigating';
      },
    }),
  });

  assert.equal(state.status, 'complete');
  assert.equal(state.jobs[0].oauthState.step, 'complete');
  assert.equal(state.jobs[0].sms.attempts[0].status, 'complete');
  assert.equal(state.jobs[0].sms.attempts[0].scope, 'oauth');
  assert.equal(acquireCalls, 2);
  assert.equal(sessionRuns, 1);
  assert.equal(trialChecks, 1);
  assert.equal(Boolean(state.jobs[0].sessionVerifiedAt), true);
  assert.equal(smsPreflightCalls, 1);
  assert.equal(state.events.filter((record) => record.type === 'session_stage_reused_for_oauth_retry').length, 1);
  assert.equal(state.events.some((record) => record.type === 'sms_phone_preflight_completed' && record.scope === 'oauth'), true);
});

test('OAuth phone preflight is shared across workers and caches a rate-limit failure', async (t) => {
  const config = branchConfig(2);
  const store = temporaryStore(t);
  const assets = ['one', 'two'].map((name, index) => {
    const seed = makeInitialChatGptSessionState({ email: `oauth-phone-preflight-${name}@example.test` });
    return store.upsert({
      email: seed.email,
      parentEmail: seed.email,
      accountId: `account-oauth-phone-preflight-${index}`,
      cookieJar: seed.cookieJar,
      clientProfile: seed.clientProfile,
      clientProfileFingerprint: seed.clientProfileFingerprint,
      oaiDid: seed.oaiDid,
      sourceProxy: { id: `registration-proxy-${index}`, url: `http://127.0.0.1:42${index}9` },
      status: 'valid',
    });
  });
  const plan = normalizeRunPlan({
    taskKind: 'oauth',
    workerConcurrency: 2,
    oauthSource: { kind: 'session_assets', assetIds: assets.map((asset) => asset.id) },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-oauth-phone-preflight-shared' });
  let smsPreflightCalls = 0;
  const smsProvider = {
    service: '1096',
    country: 'cheapest',
    async preflight() {
      smsPreflightCalls += 1;
      throw Object.assign(new Error('Firefox.fun myInfo failed: -3'), {
        code: 'FIREFOX_RATE_LIMIT',
        category: 'transient',
        retryable: true,
        retryAfterMs: 60_000,
      });
    },
  };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    // This case isolates the shared failure cache. A separate test covers the
    // retry-after floor without advancing this two-worker case through a
    // second provider window.
    retryPolicies: { waiting_sms_preflight: { delaysMs: [1], maxRetries: 0 } },
    assetStore: store,
    smsProvider,
    sessionRunnerFactory: () => ({
      async run(sessionState) {
        sessionState.step = 'verified';
        sessionState.status = 'valid';
        sessionState.accessToken = 'access-oauth-phone-preflight';
        sessionState.sessionToken = 'session-oauth-phone-preflight';
      },
    }),
    oauthRunnerFactory: () => ({
      async run(oauthState) {
        oauthState.step = 'phone_required';
      },
    }),
  });

  assert.equal(state.status, 'waiting');
  assert.equal(smsPreflightCalls, 1);
  assert.equal(state.jobs.length, 2);
  assert.equal(state.jobs.every((job) => job.status === 'waiting'), true);
  assert.equal(state.events.filter((record) => record.type === 'sms_phone_preflight_started').length, 1);
  assert.equal(state.events.filter((record) => record.type === 'sms_phone_preflight_failed').length, 1);
});

test('OAuth phone preflight honors a provider retry-after instead of retrying early', async (t) => {
  const config = branchConfig(1);
  const store = temporaryStore(t);
  const seed = makeInitialChatGptSessionState({ email: 'oauth-phone-preflight-retry@example.test' });
  const asset = store.upsert({
    email: seed.email,
    parentEmail: seed.email,
    accountId: 'account-oauth-phone-preflight-retry',
    cookieJar: seed.cookieJar,
    clientProfile: seed.clientProfile,
    clientProfileFingerprint: seed.clientProfileFingerprint,
    oaiDid: seed.oaiDid,
    status: 'valid',
  });
  const plan = normalizeRunPlan({
    taskKind: 'oauth',
    workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: [asset.id] },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-oauth-phone-preflight-retry' });
  let fakeNow = Date.parse('2026-08-24T00:00:00.000Z');
  let calls = 0;
  const smsProvider = {
    service: '1096',
    country: 'cheapest',
    async preflight() {
      calls += 1;
      throw Object.assign(new Error('Firefox.fun myInfo failed: -3'), {
        code: 'FIREFOX_RATE_LIMIT',
        category: 'transient',
        retryable: true,
        retryAfterMs: 60_000,
      });
    },
  };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    retryPolicies: { waiting_sms_preflight: { delaysMs: [1], maxRetries: 1 } },
    assetStore: store,
    smsProvider,
    now: () => fakeNow,
    sleep: async (milliseconds) => { fakeNow += Number(milliseconds || 0); },
    sessionRunnerFactory: () => ({ async run() {} }),
    oauthRunnerFactory: () => ({
      async run(oauthState) { oauthState.step = 'phone_required'; },
    }),
  });

  assert.equal(state.status, 'waiting');
  assert.equal(calls, 2, 'the provider is retried only after the cooldown window');
  const retry = state.events.find((record) => record.type === 'branch_job_retry_scheduled');
  assert.ok(retry);
  assert.ok(retry.delayMs >= 60_000);
  assert.equal(state.jobs[0].nextRunAt, '', 'an exhausted preflight retry must not stay scheduled');
});

test('OAuth keeps the same valid phone transaction when a timed-out activation is replaced', async (t) => {
  const config = branchConfig(1);
  config.sms.codeTimeoutMs = 1;
  config.sms.replacementBudget = 2;
  const store = temporaryStore(t);
  const seed = makeInitialChatGptSessionState({ email: 'oauth-phone-replacement@example.test' });
  const asset = store.upsert({
    email: seed.email,
    parentEmail: seed.email,
    accountId: 'account-oauth-phone-replacement',
    cookieJar: seed.cookieJar,
    clientProfile: seed.clientProfile,
    clientProfileFingerprint: seed.clientProfileFingerprint,
    oaiDid: seed.oaiDid,
    status: 'valid',
  });
  const plan = normalizeRunPlan({
    taskKind: 'oauth',
    workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: [asset.id] },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-oauth-phone-replacement' });
  let acquireCalls = 0;
  let fakeNow = Date.parse('2026-08-08T00:00:00.000Z');
  const sends = [];
  let sameNumberResends = 0;
  const smsProvider = {
    service: 'mock', country: '151',
    async preflight() { return { provider: 'mock', ready: true }; },
    async acquireNumber() {
      acquireCalls += 1;
      return {
        id: `activation-${acquireCalls}`,
        activationId: `activation-${acquireCalls}`,
        number: `+5691234567${acquireCalls}`,
        status: 'leased',
        cost: 0.02,
      };
    },
    async markSmsSent(lease) { return { ...lease, status: 'waiting' }; },
    async pollCode(lease) {
      return lease.activationId === 'activation-2'
        ? { code: '123456', status: 'received' }
        : { code: '', status: 'waiting' };
    },
    async requestAnotherCode() {
      sameNumberResends += 1;
      throw Object.assign(new Error('SMSBower setStatus failed: BAD_STATUS'), {
        code: 'BAD_STATUS', action: 'setStatus', retryable: false,
      });
    },
    async cancel(lease) { return { ...lease, status: 'cancelled' }; },
    async complete(lease) { return { ...lease, status: 'complete' }; },
  };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: store,
    smsProvider,
    now: () => fakeNow,
    sleep: async (milliseconds) => { fakeNow += Number(milliseconds || 0); },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) { finishSession(sessionState, job); },
    }),
    oauthRunnerFactory: () => ({
      async run(oauthState) {
        if (oauthState.step === 'initial') oauthState.step = 'phone_required';
        else if (oauthState.step === 'navigating') {
          oauthState.step = 'complete';
          oauthState.status = 'complete';
          oauthState.account = { email: oauthState.email, access_token: 'oauth-phone-replacement-cpa' };
        }
      },
      async sendPhone(oauthState, phone) {
        sends.push({ oauthState: oauthState.oauth.state, phone });
        oauthState.step = 'phone_otp_sent';
      },
      async validatePhone(oauthState) { oauthState.step = 'navigating'; },
    }),
  });

  assert.equal(state.status, 'complete');
  assert.equal(acquireCalls, 2);
  assert.equal(sends.length, 2);
  assert.equal(sameNumberResends, 0);
  assert.equal(sends[0].oauthState, sends[1].oauthState);
  assert.equal(state.jobs[0].sms.attempts[0].status, 'cancelled');
  assert.equal(state.jobs[0].sms.attempts[1].status, 'complete');
  assert.equal(
    Date.parse(state.jobs[0].sms.attempts[0].codeDeadlineAt)
      - Date.parse(state.jobs[0].sms.attempts[0].providerMarkedAt),
    60_000,
  );
});

test('an OAuth phone lease cannot be reconciled from an unrelated verified session checkpoint', async (t) => {
  const config = branchConfig(1);
  const store = temporaryStore(t);
  const seed = makeInitialChatGptSessionState({ email: 'oauth-scope@example.test' });
  const asset = store.upsert({
    email: seed.email,
    parentEmail: seed.email,
    accountId: 'account-oauth-scope',
    cookieJar: seed.cookieJar,
    clientProfile: seed.clientProfile,
    clientProfileFingerprint: seed.clientProfileFingerprint,
    oaiDid: seed.oaiDid,
    status: 'valid',
  });
  const plan = normalizeRunPlan({
    taskKind: 'oauth', workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: [asset.id] },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-oauth-phone-scope' });
  let acquireCalls = 0;
  let validateCalls = 0;
  let completeCalls = 0;
  const validatedCodes = [];
  const oauthContracts = [];
  const options = {
    // Parking is what this test measures; the real phone retry ladder would
    // keep the run alive on live timers instead of returning here.
    retryPolicies: {},
    assetStore: store,
    smsProvider: {
      service: 'mock', country: '151',
      async acquireNumber() {
        acquireCalls += 1;
        return { id: `activation-oauth-scope-${acquireCalls}`, activationId: `activation-oauth-scope-${acquireCalls}`, number: '+56912345678', status: 'leased', cost: 0.02 };
      },
      async markSmsSent(lease) { return { ...lease, status: 'waiting' }; },
      async pollCode(lease) { return { code: lease.activationId, status: 'received' }; },
      async complete(lease) { completeCalls += 1; return { ...lease, status: 'complete' }; },
      async cancel(lease) { return { ...lease, status: 'cancelled' }; },
      async requestAnotherCode(lease) { return lease; },
    },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) { finishSession(sessionState, job); },
    }),
    oauthRunnerFactory: () => ({
      async run(oauthState) {
        oauthContracts.push(oauthState.oauth.state);
        if (oauthState.step === 'initial') oauthState.step = 'phone_required';
        else if (oauthState.step === 'navigating') {
          oauthState.step = 'complete';
          oauthState.status = 'complete';
          oauthState.account = { email: oauthState.email, access_token: 'oauth-scope-cpa' };
        }
      },
      async sendPhone(oauthState) { oauthState.step = 'phone_otp_sent'; },
      async validatePhone(_oauthState, code) {
        validateCalls += 1;
        validatedCodes.push(code);
        throw Object.assign(new Error('connection reset after OAuth phone validation'), { code: 'ECONNRESET' });
      },
    }),
  };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, options);
  assert.equal(state.status, 'waiting');
  assert.equal(state.jobs[0].sessionState.step, 'verified');
  assert.equal(state.jobs[0].sms.current.scope, 'oauth');
  assert.equal(state.jobs[0].phase, 'waiting_phone_manual_review');
  assert.equal(state.jobs[0].error.code, 'OAUTH_PHONE_VALIDATION_MANUAL_REVIEW_REQUIRED');
  assert.equal(state.jobs[0].error.manualReviewRequired, true);
  assert.equal(state.jobs[0].nextRunAt, '');
  assert.equal(state.jobs[0].sms.current.code, 'activation-oauth-scope-2');
  assert.equal(acquireCalls, 2);
  assert.equal(validateCalls, 2);
  assert.equal(completeCalls, 0);

  resumeBranchState(state);
  assert.equal(state.jobs[0].sms.current.code, '');
  assert.equal(state.jobs[0].sms.current.codeReceived, false);
  state.jobs[0].oauthState.step = 'initial';
  await runBranchOrchestrator({ log: { entries: [] } }, state, config, options);
  assert.equal(state.status, 'waiting');
  assert.notEqual(state.jobs[0].sms.current.targetAccepted, true);
  assert.equal(completeCalls, 0);

  resumeBranchState(state);
  state.jobs[0].oauthState.step = 'navigating';
  await runBranchOrchestrator({ log: { entries: [] } }, state, config, options);
  assert.equal(state.status, 'complete');
  assert.equal(acquireCalls, 3);
  assert.equal(validateCalls, 3);
  assert.deepEqual(validatedCodes, [
    'activation-oauth-scope-1',
    'activation-oauth-scope-2',
    'activation-oauth-scope-3',
  ]);
  assert.equal(completeCalls, 1);
  assert.equal(state.jobs[0].sms.attempts.at(-1).scope, 'oauth');
  assert.equal(state.jobs[0].sms.attempts.at(-1).targetAcceptedInferred, true);
  assert.equal(new Set(oauthContracts).size, 4);
  assert.equal(state.jobs[0].oauthPhoneValidationRecovery.status, 'complete');
  assert.equal(state.jobs[0].oauthPhoneValidationRecovery.attempts, 1);
});

test('OAuth rebuild treats an ambiguous validation as accepted when fresh OAuth no longer asks for a phone', async (t) => {
  const config = branchConfig(1);
  const store = temporaryStore(t);
  const seed = makeInitialChatGptSessionState({ email: 'oauth-phone-reconciled@example.test' });
  const asset = store.upsert({
    email: seed.email,
    parentEmail: seed.email,
    accountId: 'account-oauth-phone-reconciled',
    cookieJar: seed.cookieJar,
    clientProfile: seed.clientProfile,
    clientProfileFingerprint: seed.clientProfileFingerprint,
    oaiDid: seed.oaiDid,
    status: 'valid',
  });
  const plan = normalizeRunPlan({
    taskKind: 'oauth', workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: [asset.id] },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-oauth-phone-reconciled' });
  const oauthContracts = [];
  let acquireCalls = 0;
  let validateCalls = 0;
  let completeCalls = 0;
  const options = {
    assetStore: store,
    smsProvider: {
      service: 'mock', country: '151',
      async acquireNumber() {
        acquireCalls += 1;
        return { id: 'activation-oauth-reconciled', activationId: 'activation-oauth-reconciled', number: '+56912345678', status: 'leased', cost: 0.02 };
      },
      async markSmsSent(lease) { return { ...lease, status: 'waiting' }; },
      async pollCode() { return { code: '123456', status: 'received' }; },
      async complete(lease) { completeCalls += 1; return { ...lease, status: 'complete' }; },
      async cancel(lease) { return { ...lease, status: 'cancelled' }; },
      async requestAnotherCode(lease) { return lease; },
    },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) { finishSession(sessionState, job); },
    }),
    oauthRunnerFactory: () => ({
      async run(oauthState) {
        oauthContracts.push(oauthState.oauth.state);
        if (oauthState.step === 'initial') {
          // The first transaction reached phone verification. The new PKCE
          // transaction skips it, which is the acceptance signal we need.
          oauthState.step = oauthContracts.length === 1 ? 'phone_required' : 'navigating';
        } else if (oauthState.step === 'navigating') {
          oauthState.step = 'complete';
          oauthState.status = 'complete';
          oauthState.account = { email: oauthState.email, access_token: 'oauth-phone-reconciled-cpa' };
        }
      },
      async sendPhone(oauthState) { oauthState.step = 'phone_otp_sent'; },
      async validatePhone() {
        validateCalls += 1;
        throw Object.assign(new Error('connection reset after OAuth phone validation'), { code: 'ECONNRESET' });
      },
    }),
  };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, options);

  assert.equal(state.status, 'complete');
  assert.equal(acquireCalls, 1);
  assert.equal(validateCalls, 1);
  assert.equal(completeCalls, 1);
  assert.equal(new Set(oauthContracts).size, 2);
  assert.equal(state.jobs[0].sms.attempts[0].status, 'complete');
  assert.equal(state.jobs[0].sms.attempts[0].targetAcceptedInferred, true);
  assert.equal(state.jobs[0].oauthPhoneValidationRecovery.status, 'complete');
  assert.equal(state.jobs[0].oauthPhoneValidationRecovery.outcome, 'previous_phone_accepted');
  assert.equal(state.jobs[0].result, 'cpa_saved');
});

test('resume discards an uncertain account-selection transaction before retrying OAuth', () => {
  const state = {
    status: 'waiting',
    phase: 'waiting_transient',
    cancelPending: null,
    control: {},
    events: [],
    workers: [{ status: 'idle', currentJobId: '', mailboxId: null }],
    jobs: [{
      id: 'job-account-select-retry',
      assetId: 'asset-account-select-retry',
      status: 'waiting',
      phase: 'waiting_transient',
      error: { code: 'OAUTH_ACCOUNT_SELECTION_REJECTED', message: 'chooser did not advance' },
      sms: { current: null },
      oauthState: {
        mode: 'cockpit-oauth',
        step: 'navigating',
        oauthCode: '',
        tokens: null,
      },
    }],
  };

  resumeBranchState(state);

  assert.equal(state.jobs[0].status, 'queued');
  assert.equal(state.jobs[0].oauthState, null);
  assert.equal(state.jobs[0].oauthRecovery.status, 'pending');
  assert.equal(state.jobs[0].oauthRecovery.attempts, 0);
  assert.equal(state.events.at(-1).type, 'oauth_account_selection_reset');
  assert.equal(state.events.at(-1).loginRepairQueued, true);
});

test('resume retires an empty chooser 500 without forcing login repair', () => {
  const state = {
    taskKind: 'oauth',
    runPlan: { oauthSource: { kind: 'session_assets', assetIds: ['asset-transport'] } },
    status: 'waiting', phase: 'waiting_transient', cancelPending: null, control: {}, events: [],
    proxyHealth: {
      'proxy-bad': { status: 'failed', reason: 'OAUTH_ACCOUNT_SELECT_TRANSPORT_FAILED' },
    },
    proxyLeases: {},
    workers: [{ id: 'worker-1', status: 'idle', currentJobId: '', mailboxId: null, proxyId: '', proxy: null }],
    jobs: [{
      id: 'job-transport', assetId: 'asset-transport', status: 'waiting', phase: 'waiting_transient',
      proxyId: '', proxy: null,
      error: {
        code: 'OAUTH_ACCOUNT_SELECT_FAILED', status: 500, message: 'unknown response',
        diagnostics: { status: 500, contentType: '', bodyBytes: 0, bodyHash: '' },
      },
      oauthState: { mode: 'cockpit-oauth', step: 'account_select_pending', oauthCode: '', tokens: null },
      oauthRecovery: { status: 'complete', attempts: 1, reason: 'oauth_account_session_rejected', lastError: null },
      sms: { current: null },
    }],
  };
  state.events.push({
    at: '2026-08-06T10:32:16.552Z', type: 'worker_proxy_rejected', workerId: 'worker-1',
    proxyId: 'proxy-bad', code: 'OAUTH_ACCOUNT_SELECT_TRANSPORT_FAILED',
  });
  resumeBranchState(state);
  assert.equal(state.status, 'initialized');
  assert.equal(state.jobs[0].status, 'queued');
  assert.equal(state.jobs[0].error.code, 'OAUTH_ACCOUNT_SELECT_TRANSPORT_FAILED');
  assert.equal(state.jobs[0].oauthState, null);
  assert.equal(state.workers[0].proxy, null);
  assert.equal(state.workers[0].proxyId, '');
  // The exit is retired rather than checked again: the failure came from the
  // account-selection request itself, which a health probe cannot second-guess.
  assert.equal(state.proxyHealth['proxy-bad'].status, 'failed');
  assert.equal(state.proxyHealth['proxy-bad'].reason, 'OAUTH_ACCOUNT_SELECT_TRANSPORT_FAILED');
  assert.equal(state.proxyLeases['worker-1'], undefined);
  assert.equal(state.jobs[0].oauthRecovery.status, 'complete');
  assert.equal(state.events.some((event) => event.type === 'oauth_account_selection_transport_migrated'), true);
  assert.equal(state.events.at(-1).loginRepairQueued, false);
});

test('a no-phone OAuth completion cancels any stale activation before saving CPA output', async (t) => {
  const config = branchConfig(1);
  const store = temporaryStore(t);
  const seed = makeInitialChatGptSessionState({ email: 'oauth-stale-sms@example.test' });
  const asset = store.upsert({
    email: seed.email,
    accountId: 'account-stale-sms',
    cookieJar: seed.cookieJar,
    clientProfile: seed.clientProfile,
    clientProfileFingerprint: seed.clientProfileFingerprint,
    oaiDid: seed.oaiDid,
    status: 'valid',
  });
  const plan = normalizeRunPlan({
    taskKind: 'oauth', workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: [asset.id] },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-oauth-stale-sms' });
  state.jobs.push({
    id: 'job-oauth-stale-sms', taskKind: 'oauth', email: asset.email, parentEmail: asset.email,
    mailboxId: '', laneId: asset.id, assetId: asset.id, status: 'queued', phase: 'queued',
    sms: {
      current: { id: 'activation-stale', activationId: 'activation-stale', number: '+56912345678', status: 'leased', scope: 'oauth' },
      attempts: [], acquisition: null, acquisitionHistory: [], costUsd: 0, replacements: 0, sendRetries: 0,
    },
  });
  let cancelCalls = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: store,
    smsProvider: {
      async cancel(lease) { cancelCalls += 1; return { ...lease, status: 'cancelled' }; },
    },
    sessionRunnerFactory: ({ job }) => ({ async run(sessionState) { finishSession(sessionState, job); } }),
    oauthRunnerFactory: () => ({
      async run(oauthState) {
        oauthState.step = 'complete';
        oauthState.status = 'complete';
        oauthState.account = { email: oauthState.email, access_token: 'oauth-stale-cpa', refresh_token: 'oauth-stale-refresh' };
      },
    }),
  });

  assert.equal(state.status, 'complete');
  assert.equal(cancelCalls, 1);
  assert.equal(state.jobs[0].sms.current, null);
  assert.equal(state.jobs[0].sms.attempts[0].status, 'cancelled');
  assert.equal(store.get(asset.id).cpa.revision, 1);
});

test('branch cancellation closes an outstanding SMS activation before marking jobs cancelled', async () => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({ taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root' }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-cancel-sms' });
  state.mailboxes.push({
    id: 'mail-cancel',
    email: 'cancel@example.test',
    status: 'reserved',
  });
  state.jobs.push({
    id: 'job-cancel-sms',
    email: 'cancel@example.test',
    parentEmail: 'cancel@example.test',
    mailboxId: 'mail-cancel',
    laneId: 'mail-cancel',
    status: 'waiting',
    phase: 'phone_otp_sent',
    sms: {
      current: { id: 'activation-1', activationId: 'activation-1', number: '+56912345678', status: 'waiting' },
      attempts: [],
      costUsd: 0.02,
      replacements: 0,
      sendRetries: 0,
    },
  });
  const cancelled = [];
  const mail = mailboxClient([]);

  await cancelBranchState(state, config, {
    mailClient: mail,
    smsProvider: { async cancel(lease, reason) { cancelled.push({ id: lease.activationId, reason }); } },
  });

  assert.deepEqual(cancelled, [{ id: 'activation-1', reason: 'task_cancelled' }]);
  assert.equal(state.status, 'cancelled');
  assert.equal(state.jobs[0].status, 'cancelled');
  assert.equal(state.jobs[0].sms.current, null);
  assert.equal(state.jobs[0].sms.attempts[0].status, 'cancelled');
  assert.deepEqual(mail.released, ['mail-cancel']);
  assert.equal(state.mailboxes[0].status, 'released');
});

test('SMS acquisition intent is durable before the provider call and reconciles a crash-gap lease on resume', async (t) => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({ taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root' }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-sms-acquisition-intent' });
  const persisted = [];
  let acquireCalls = 0;
  let reconcileCalls = 0;
  let pendingAcquisitionId = '';
  const smsProvider = {
    service: 'mock', country: '151',
    async acquireNumber(request) {
      acquireCalls += 1;
      pendingAcquisitionId = request.acquisitionId;
      const intent = persisted.find((snapshot) => snapshot.lastCheckpoint?.reason === 'intent:sms_number_acquire');
      assert.equal(intent.jobs[0].sms.current, null);
      assert.equal(intent.jobs[0].sms.acquisition.id, pendingAcquisitionId);
      assert.equal(intent.jobs[0].sms.acquisition.scope, 'session');
      throw Object.assign(new Error('transport closed after number allocation'), { code: 'ECONNRESET' });
    },
    async reconcileAcquisition(intent) {
      reconcileCalls += 1;
      assert.equal(intent.id, pendingAcquisitionId);
      return {
        status: 'acquired',
        lease: { id: 'activation-acquire-gap', activationId: 'activation-acquire-gap', number: '+56912345678', status: 'leased', cost: 0.02 },
      };
    },
    async markSmsSent(lease) { return { ...lease, status: 'waiting' }; },
    async pollCode() { return { code: '123456', status: 'received' }; },
    async complete(lease) { return { ...lease, status: 'complete' }; },
    async cancel(lease) { return { ...lease, status: 'cancelled' }; },
    async requestAnotherCode(lease) { return lease; },
  };
  const options = {
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([{ id: 'mail-acquire-gap', email: 'acquire-gap@example.test', tokenValid: true, bound: false }]),
    smsProvider,
    saveState: async (next) => persisted.push(JSON.parse(JSON.stringify(next))),
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        if (sessionState.step === 'initial') sessionState.step = 'phone_required';
        else if (sessionState.step === 'email_otp_validated') finishSession(sessionState, job);
      },
      async sendPhone(sessionState) { sessionState.step = 'phone_otp_sent'; },
      async validatePhone(sessionState) { sessionState.step = 'email_otp_validated'; },
    }),
  };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, options);
  assert.equal(state.status, 'waiting');
  assert.equal(state.jobs[0].phase, 'waiting_sms_acquisition_reconcile');
  assert.equal(state.jobs[0].sms.current, null);
  assert.equal(state.jobs[0].sms.acquisition.status, 'uncertain');
  assert.equal(acquireCalls, 1);

  resumeBranchState(state);
  await runBranchOrchestrator({ log: { entries: [] } }, state, config, options);
  assert.equal(state.status, 'complete');
  assert.equal(acquireCalls, 1);
  assert.equal(reconcileCalls, 1);
  assert.equal(state.jobs[0].sms.acquisition, null);
  assert.equal(state.jobs[0].sms.acquisitions.at(-1).status, 'reconciled');
  assert.equal(state.jobs[0].sms.attempts[0].activationId, 'activation-acquire-gap');
  assert.equal(state.jobs[0].sms.attempts[0].scope, 'session');
});

test('an operator-authorized resume archives an uncertain acquisition before requesting a new number', async (t) => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({ taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root' }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-sms-acquisition-operator-retry' });
  let acquireCalls = 0;
  const smsProvider = {
    service: 'mock', country: '151',
    async acquireNumber() {
      acquireCalls += 1;
      if (acquireCalls === 1) {
        throw Object.assign(new Error('getNumberV2 timed out after allocation may have started'), {
          code: 'NETWORK_ERROR', category: 'transient', retryable: true,
        });
      }
      return { id: 'activation-after-operator-retry', activationId: 'activation-after-operator-retry', number: '+56912345678', status: 'leased', cost: 0.02 };
    },
    async markSmsSent(lease) { return { ...lease, status: 'waiting' }; },
    async pollCode() { return { code: '123456', status: 'received' }; },
    async complete(lease) { return { ...lease, status: 'complete' }; },
    async cancel(lease) { return { ...lease, status: 'cancelled' }; },
    async requestAnotherCode(lease) { return lease; },
  };
  const options = {
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([{ id: 'mail-operator-retry', email: 'operator-retry@example.test', tokenValid: true, bound: false }]),
    smsProvider,
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        if (sessionState.step === 'initial') sessionState.step = 'phone_required';
        else if (sessionState.step === 'email_otp_validated') finishSession(sessionState, job);
      },
      async sendPhone(sessionState) { sessionState.step = 'phone_otp_sent'; },
      async validatePhone(sessionState) { sessionState.step = 'email_otp_validated'; },
    }),
  };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, options);
  assert.equal(state.status, 'waiting');
  assert.equal(state.jobs[0].phase, 'waiting_sms_acquisition_reconcile');
  const uncertainId = state.jobs[0].sms.acquisition.id;

  resumeBranchState(state, { resolveSmsAcquisition: 'retry' });
  assert.equal(state.jobs[0].sms.acquisition, null);
  assert.equal(state.jobs[0].sms.acquisitions.at(-1).status, 'operator_retry');
  assert.equal(state.jobs[0].sms.acquisitions.at(-1).id, uncertainId);
  assert.equal(state.events.at(-1).type, 'sms_acquisition_retry_authorized');

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, options);
  assert.equal(state.status, 'complete');
  assert.equal(acquireCalls, 2);
  assert.equal(state.jobs[0].sms.attempts[0].activationId, 'activation-after-operator-retry');
});

test('a scoped branch resume changes only the requested SMS acquisition job', () => {
  const config = branchConfig(2);
  const plan = normalizeRunPlan({ taskKind: 'register_session', mailCount: 2, workerConcurrency: 2, aliasStrategy: 'root' }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-scoped-sms-resume' });
  const acquisition = (id) => ({ id, scope: 'session', status: 'uncertain', startedAt: new Date().toISOString() });
  const job = (id) => ({
    id,
    email: `${id}@example.test`,
    parentEmail: `${id}@example.test`,
    mailboxId: `mail-${id}`,
    laneId: `lane-${id}`,
    aliasIndex: 1,
    branch: 'register_session',
    status: 'waiting',
    phase: 'waiting_sms_acquisition_reconcile',
    proxy: null,
    proxyId: '',
    workerAffinity: null,
    sessionState: null,
    oauthState: null,
    accountCreatedAt: '',
    sessionAssetId: '',
    sms: { current: null, attempts: [], acquisitions: [], acquisition: acquisition(`acq-${id}`), costUsd: 0, replacements: 0, sendRetries: 0 },
    error: { code: 'SMS_ACQUISITION_UNCERTAIN', message: 'provider response was unclear' },
    retry: null,
    nextRunAt: '',
    skipPending: null,
  });
  state.status = 'waiting';
  state.phase = 'waiting_sms_acquisition_reconcile';
  state.jobs = [job('target'), job('other')];
  state.workers = [
    { id: 'worker-1', status: 'running', currentJobId: 'other', mailboxId: 'mail-other', laneId: 'lane-other' },
    { id: 'worker-2', status: 'idle', currentJobId: '', mailboxId: null, laneId: '' },
  ];
  const otherBefore = JSON.parse(JSON.stringify(state.jobs[1]));
  const workersBefore = JSON.parse(JSON.stringify(state.workers));

  resumeBranchState(state, { jobId: 'target', resolveSmsAcquisition: 'retry' });

  assert.equal(state.jobs[0].status, 'queued');
  assert.equal(state.jobs[0].phase, 'queued');
  assert.equal(state.jobs[0].sms.acquisition, null);
  assert.equal(state.jobs[0].sms.acquisitions.at(-1).status, 'operator_retry');
  assert.deepEqual(state.jobs[1], otherBefore);
  assert.deepEqual(state.workers, workersBefore);
});

test('a batch scoped branch resume changes only the requested SMS acquisition jobs', () => {
  const config = branchConfig(3);
  const plan = normalizeRunPlan({ taskKind: 'register_session', mailCount: 3, workerConcurrency: 3, aliasStrategy: 'root' }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-batch-scoped-sms-resume' });
  const acquisition = (id) => ({ id, scope: 'session', status: 'uncertain', startedAt: new Date().toISOString() });
  const job = (id) => ({
    id,
    email: `${id}@example.test`,
    parentEmail: `${id}@example.test`,
    mailboxId: `mail-${id}`,
    laneId: `lane-${id}`,
    aliasIndex: 1,
    branch: 'register_session',
    status: 'waiting',
    phase: 'waiting_sms_acquisition_reconcile',
    proxy: null,
    proxyId: '',
    workerAffinity: null,
    sessionState: null,
    oauthState: null,
    accountCreatedAt: '',
    sessionAssetId: '',
    sms: { current: null, attempts: [], acquisitions: [], acquisition: acquisition(`acq-${id}`), costUsd: 0, replacements: 0, sendRetries: 0 },
    error: { code: 'SMS_ACQUISITION_UNCERTAIN', message: 'provider response was unclear' },
    retry: null,
    nextRunAt: '',
    skipPending: null,
  });
  state.status = 'waiting';
  state.phase = 'waiting_sms_acquisition_reconcile';
  state.jobs = [job('first'), job('second'), job('other')];
  state.workers = [
    { id: 'worker-1', status: 'running', currentJobId: 'other', mailboxId: 'mail-other', laneId: 'lane-other' },
    { id: 'worker-2', status: 'running', currentJobId: 'first', mailboxId: 'mail-first', laneId: 'lane-first' },
    { id: 'worker-3', status: 'idle', currentJobId: '', mailboxId: null, laneId: '' },
  ];
  const otherBefore = JSON.parse(JSON.stringify(state.jobs[2]));
  const workersBefore = JSON.parse(JSON.stringify(state.workers));

  resumeBranchState(state, { jobIds: ['first', 'second'], resolveSmsAcquisition: 'retry' });

  for (const jobId of ['first', 'second']) {
    const selected = state.jobs.find((job) => job.id === jobId);
    assert.equal(selected.status, 'queued');
    assert.equal(selected.phase, 'queued');
    assert.equal(selected.sms.acquisition, null);
    assert.equal(selected.sms.acquisitions.at(-1).status, 'operator_retry');
  }
  assert.deepEqual(state.jobs[2], otherBefore);
  assert.deepEqual(state.workers, workersBefore);
  assert.equal(state.events.filter((event) => event.type === 'sms_acquisition_retry_authorized').length, 2);
});

test('a definitive no-numbers response is polled automatically without operator resume', async (t) => {
  const config = branchConfig(1);
  config.sms.inventoryWaitMs = 100;
  const plan = normalizeRunPlan({ taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root' }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-sms-no-numbers' });
  let acquireCalls = 0;
  const options = {
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([{ id: 'mail-no-numbers', email: 'no-numbers@example.test', tokenValid: true, bound: false }]),
    smsInventoryPollIntervalMs: 1,
    smsProvider: {
      service: 'mock', country: '151',
      async acquireNumber() {
        acquireCalls += 1;
        if (acquireCalls === 1) {
          throw Object.assign(new Error('No numbers are currently available'), {
            code: 'NO_NUMBERS', category: 'availability', retryable: true,
          });
        }
        return { id: 'activation-after-wait', activationId: 'activation-after-wait', number: '+56912345678', status: 'leased', cost: 0.02 };
      },
      async markSmsSent(lease) { return { ...lease, status: 'waiting' }; },
      async pollCode() { return { code: '123456', status: 'received' }; },
      async complete(lease) { return { ...lease, status: 'complete' }; },
      async cancel(lease) { return { ...lease, status: 'cancelled' }; },
      async requestAnotherCode(lease) { return lease; },
    },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        if (sessionState.step === 'initial') sessionState.step = 'phone_required';
        else if (sessionState.step === 'email_otp_validated') finishSession(sessionState, job);
      },
      async sendPhone(sessionState) { sessionState.step = 'phone_otp_sent'; },
      async validatePhone(sessionState) { sessionState.step = 'email_otp_validated'; },
    }),
  };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, options);
  assert.equal(state.status, 'complete');
  assert.equal(state.jobs[0].sms.acquisition, null);
  assert.equal(acquireCalls, 2);
  assert.ok(state.jobs[0].sms.acquisitions.some((acquisition) => acquisition.status === 'failed'));
  assert.equal(state.jobs[0].sms.attempts[0].activationId, 'activation-after-wait');
  assert.equal(state.jobs[0].nextRunAt, '');
  assert.equal(state.jobs[0].sms.inventoryStartedAt, '');
  assert.ok(state.events.some((event) => event.type === 'sms_inventory_poll_waiting'));
  assert.ok(state.events.some((event) => event.type === 'sms_inventory_retry_due'));
});

test('a Worker keeps its account and exit while that account waits for an SMS number', async (t) => {
  // Live run 2026-10-10: Workers released accounts waiting on NO_NUMBERS and
  // started new ones on the same exit; one of those broke the exit and the
  // waiting account came back on a different IP than it registered on.
  const config = branchConfig(1);
  config.mail.count = 2;
  config.sms.inventoryWaitMs = 60000;
  config.proxyPool.required = true;
  const plan = normalizeRunPlan({ taskKind: 'register_session', mailCount: 2, workerConcurrency: 1, aliasStrategy: 'root' }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-sms-wait-holds-lane' });
  let acquireCalls = 0;
  const order = [];
  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([
      { id: 'mail-hold-a', email: 'hold-a@example.test', tokenValid: true, bound: false },
      { id: 'mail-hold-b', email: 'hold-b@example.test', tokenValid: true, bound: false },
    ]),
    proxyEntries: [
      { id: 'hold-proxy-1', url: 'http://hold-proxy-1:4501' },
      { id: 'hold-proxy-2', url: 'http://hold-proxy-2:4502' },
    ],
    proxyProbeExecutor: async (_request, probeOptions) => ({ response: { status: 200, url: probeOptions.proxy } }),
    // Long enough that the scheduler sees the wait before the retry is due.
    smsInventoryPollIntervalMs: 40,
    smsProvider: {
      service: 'mock', country: '151',
      async acquireNumber() {
        acquireCalls += 1;
        if (acquireCalls <= 2) {
          throw Object.assign(new Error('No numbers are currently available'), { code: 'NO_NUMBERS', category: 'availability', retryable: true });
        }
        const id = `activation-hold-${acquireCalls}`;
        return { id, activationId: id, number: '+56912345678', status: 'leased', cost: 0.02 };
      },
      async markSmsSent(lease) { return { ...lease, status: 'waiting' }; },
      async pollCode() { return { code: '123456', status: 'received' }; },
      async complete(lease) { return { ...lease, status: 'complete' }; },
      async cancel(lease) { return { ...lease, status: 'cancelled' }; },
      async requestAnotherCode(lease) { return lease; },
    },
    sessionRunnerFactory: ({ job, worker }) => ({
      async run(sessionState) {
        order.push({ email: job.email, proxyId: worker.proxyId, step: sessionState.step });
        if (sessionState.step === 'initial') sessionState.step = 'phone_required';
        else if (sessionState.step === 'email_otp_validated') finishSession(sessionState, job);
      },
      async sendPhone(sessionState) { sessionState.step = 'phone_otp_sent'; },
      async validatePhone(sessionState) { sessionState.step = 'email_otp_validated'; },
    }),
  });

  assert.equal(state.status, 'complete');
  const first = order[0].email;
  const firstDone = order.map((entry) => entry.email).lastIndexOf(first);
  const secondStart = order.findIndex((entry) => entry.email !== first);
  assert.ok(secondStart > firstDone, 'the second account starts only after the waiting one finished');
  assert.equal(new Set(order.filter((entry) => entry.email === first).map((entry) => entry.proxyId)).size, 1, 'the waiting account kept its exit');
  assert.equal(state.events.some((record) => record.type === 'worker_lane_deferred'), false);
  assert.equal(state.events.some((record) => record.type === 'worker_lane_held'), true);
  // The next account gets the exit nobody has used yet, not the one just released.
  const second = order.find((entry) => entry.email !== first);
  assert.notEqual(second.proxyId, order[0].proxyId);
});

for (const random of [0, 0.5, 0.999]) {
  test(`a Worker's next exit is one no Worker has used in this run (random ${random})`, async (t) => {
    const config = branchConfig(1);
    config.mail.count = 3;
    config.proxyPool.required = true;
    const plan = normalizeRunPlan({ taskKind: 'register_session', mailCount: 3, workerConcurrency: 1, aliasStrategy: 'root' }, config);
    const state = makeInitialBranchState(config, plan, { runId: `branch-fresh-exit-${String(random).replace('.', '')}` });
    const used = [];
    await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
      assetStore: temporaryStore(t),
      random: () => random,
      mailClient: mailboxClient([
        { id: 'mail-fresh-a', email: 'fresh-a@example.test', tokenValid: true, bound: false },
        { id: 'mail-fresh-b', email: 'fresh-b@example.test', tokenValid: true, bound: false },
        { id: 'mail-fresh-c', email: 'fresh-c@example.test', tokenValid: true, bound: false },
      ]),
      proxyEntries: [
        { id: 'fresh-proxy-1', url: 'http://fresh-proxy-1:4601' },
        { id: 'fresh-proxy-2', url: 'http://fresh-proxy-2:4602' },
        { id: 'fresh-proxy-3', url: 'http://fresh-proxy-3:4603' },
      ],
      proxyProbeExecutor: async (_request, probeOptions) => ({ response: { status: 200, url: probeOptions.proxy } }),
      sessionRunnerFactory: ({ job, worker }) => ({
        async run(sessionState) {
          used.push(worker.proxyId);
          finishSession(sessionState, job);
        },
      }),
    });
    assert.equal(state.status, 'complete');
    assert.equal(used.length, 3);
    // Three accounts, three exits: none is handed out twice while an unused one
    // remains, whatever order the shuffle produced.
    assert.equal(new Set(used).size, 3, JSON.stringify(used));
    assert.equal(state.events.some((record) => record.type === 'worker_proxy_bound' && record.reusedExit), false);
  });
}

test('automatic no-number polling stops at the configured inventory wait limit', async (t) => {
  const config = branchConfig(1);
  config.sms.inventoryWaitMs = 12;
  const plan = normalizeRunPlan({ taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root' }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-sms-no-numbers-exhausted' });
  let acquireCalls = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([{ id: 'mail-no-numbers-exhausted', email: 'no-numbers-exhausted@example.test', tokenValid: true, bound: false }]),
    smsInventoryPollIntervalMs: 2,
    smsProvider: {
      service: 'mock', country: '151',
      async acquireNumber() {
        acquireCalls += 1;
        throw Object.assign(new Error('No numbers are currently available'), {
          code: 'NO_NUMBERS', category: 'availability', retryable: true,
        });
      },
    },
    sessionRunnerFactory: () => ({
      async run(sessionState) { sessionState.step = 'phone_required'; },
    }),
  });

  assert.equal(state.status, 'waiting');
  assert.equal(state.phase, 'waiting_sms_inventory');
  assert.equal(state.jobs[0].status, 'waiting');
  assert.equal(state.jobs[0].phase, 'waiting_sms_inventory');
  assert.equal(state.jobs[0].nextRunAt, '');
  assert.equal(state.jobs[0].error.inventoryExhausted, true);
  assert.ok(acquireCalls >= 1);
  assert.ok(state.events.some((event) => event.type === 'sms_inventory_poll_exhausted'));
});

test('pausing an inventory wait preserves its timer and resumes the same job when due', async (t) => {
  const config = branchConfig(1);
  config.sms.inventoryWaitMs = 20000;
  const plan = normalizeRunPlan({ taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root' }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-sms-inventory-pause' });
  let action = '';
  let acquireCalls = 0;
  const control = {
    requestedAction: () => action,
    async wait() { action = 'pause'; },
  };
  const options = {
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([{ id: 'mail-inventory-pause', email: 'inventory-pause@example.test', tokenValid: true, bound: false }]),
    control,
    smsProvider: {
      service: 'mock', country: '151',
      async acquireNumber() {
        acquireCalls += 1;
        if (acquireCalls === 1) {
          throw Object.assign(new Error('No numbers are currently available'), {
            code: 'NO_NUMBERS', category: 'availability', retryable: true,
          });
        }
        return { id: 'activation-after-pause', activationId: 'activation-after-pause', number: '+56912345678', status: 'leased', cost: 0.02 };
      },
      async markSmsSent(lease) { return { ...lease, status: 'waiting' }; },
      async pollCode() { return { code: '123456', status: 'received' }; },
      async complete(lease) { return { ...lease, status: 'complete' }; },
      async cancel(lease) { return { ...lease, status: 'cancelled' }; },
    },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        if (sessionState.step === 'initial') sessionState.step = 'phone_required';
        else if (sessionState.step === 'email_otp_validated') finishSession(sessionState, job);
      },
      async sendPhone(sessionState) { sessionState.step = 'phone_otp_sent'; },
      async validatePhone(sessionState) { sessionState.step = 'email_otp_validated'; },
    }),
  };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, options);
  assert.equal(state.status, 'paused');
  assert.equal(state.jobs[0].phase, 'waiting_sms_inventory_retry');
  assert.ok(Date.parse(state.jobs[0].nextRunAt) > Date.now());
  // Jittered ±20% like every other ladder: twenty Workers hearing NO_NUMBERS in
  // the same second must not re-poll the provider in lockstep. The band, not
  // the exact value, is the contract.
  const inventoryDelayMs = state.events.find((event) => event.type === 'sms_inventory_poll_waiting').delayMs;
  assert.ok(inventoryDelayMs >= 6400 && inventoryDelayMs <= 9600, `inventory poll delay out of jitter band: ${inventoryDelayMs}`);
  assert.equal(acquireCalls, 1);

  resumeBranchState(state);
  assert.equal(state.jobs[0].status, 'waiting');
  state.jobs[0].nextRunAt = new Date(Date.now() - 1).toISOString();
  action = '';
  await runBranchOrchestrator({ log: { entries: [] } }, state, config, options);
  assert.equal(state.status, 'complete');
  assert.equal(acquireCalls, 2);
});

test('cancelling during an inventory wait wakes the scheduler and clears the retry timer', async (t) => {
  const config = branchConfig(1);
  config.sms.inventoryWaitMs = 20000;
  const plan = normalizeRunPlan({ taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root' }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-sms-inventory-cancel' });
  let action = '';
  let acquireCalls = 0;
  const mail = mailboxClient([{ id: 'mail-inventory-cancel', email: 'inventory-cancel@example.test', tokenValid: true, bound: false }]);

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    smsInventoryPollIntervalMs: 10000,
    control: {
      requestedAction: () => action,
      async wait() { action = 'cancel'; },
    },
    smsProvider: {
      service: 'mock', country: '151',
      async acquireNumber() {
        acquireCalls += 1;
        throw Object.assign(new Error('No numbers are currently available'), {
          code: 'NO_NUMBERS', category: 'availability', retryable: true,
        });
      },
    },
    sessionRunnerFactory: () => ({
      async run(sessionState) { sessionState.step = 'phone_required'; },
    }),
  });

  assert.equal(state.status, 'cancelled');
  assert.equal(state.jobs[0].status, 'cancelled');
  assert.equal(state.jobs[0].nextRunAt, '');
  assert.equal(acquireCalls, 1);
});

test('cancellation compensates a pending SMS acquisition intent before stopping the job', async () => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({ taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root' }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-sms-acquisition-cancel' });
  state.jobs.push({
    id: 'job-acquisition-cancel', email: 'acquisition-cancel@example.test', parentEmail: 'acquisition-cancel@example.test',
    mailboxId: '', laneId: 'acquisition-cancel@example.test', status: 'waiting', phase: 'waiting_sms_acquisition_reconcile',
    sms: {
      current: null, attempts: [], acquisitions: [], costUsd: 0, replacements: 0, sendRetries: 0,
      acquisition: { id: 'sms-acquire-pending', scope: 'session', status: 'uncertain', startedAt: new Date().toISOString() },
    },
  });
  const cancelled = [];

  await cancelBranchState(state, config, {
    smsProvider: {
      async cancelAcquisition(intent, reason) {
        cancelled.push({ id: intent.id, reason });
        return { status: 'cancelled' };
      },
    },
  });

  assert.equal(state.status, 'cancelled');
  assert.deepEqual(cancelled, [{ id: 'sms-acquire-pending', reason: 'task_cancelled' }]);
  assert.equal(state.jobs[0].sms.acquisition, null);
  assert.equal(state.jobs[0].sms.acquisitions[0].status, 'cancelled');
});

test('cancelling an unresolved SMS acquisition finishes local cleanup and releases the worker proxy', async () => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({ taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root' }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-sms-cancel-unresolved' });
  state.mailboxes.push({ id: 'mail-sms-cancel-unresolved', email: 'sms-cancel@example.test', rootEmail: 'sms-cancel@example.test', status: 'reserved' });
  state.workers = [{
    id: 'worker-1', slot: 1, status: 'idle', mailboxId: null, currentJobId: '',
    proxyId: 'proxy-cancel-unresolved', proxy: { id: 'proxy-cancel-unresolved', url: 'http://127.0.0.1:4001' },
  }];
  state.proxyLeases = { 'worker-1': 'proxy-cancel-unresolved' };
  state.jobs.push({
    id: 'job-sms-cancel-unresolved', email: 'sms-cancel@example.test', parentEmail: 'sms-cancel@example.test',
    mailboxId: 'mail-sms-cancel-unresolved', laneId: 'sms-cancel-unresolved', status: 'waiting',
    phase: 'waiting_sms_acquisition_reconcile',
    sms: {
      current: null, attempts: [], acquisitions: [], costUsd: 0, replacements: 0, sendRetries: 0,
      acquisition: {
        id: 'sms-acquire-unresolved', scope: 'oauth', status: 'uncertain',
        startedAt: new Date().toISOString(), request: { serviceCode: 'dr', countryId: '151', maxPrice: 0.055 },
      },
    },
  });
  const mail = mailboxClient([]);

  await cancelBranchState(state, config, { mailClient: mail, smsProvider: {} });

  assert.equal(state.status, 'cancelled');
  assert.equal(state.cancelPending, false);
  assert.equal(state.jobs[0].status, 'cancelled');
  assert.equal(state.jobs[0].sms.acquisition, null);
  assert.equal(state.jobs[0].sms.acquisitions[0].status, 'abandoned_unresolved');
  assert.equal(state.externalCleanup[0].status, 'manual_review_required');
  assert.equal(state.proxyLeases['worker-1'], undefined);
  assert.equal(state.workers[0].proxyId, '');
  assert.equal(state.workers[0].proxy, null);
  assert.deepEqual(mail.released, ['mail-sms-cancel-unresolved']);
});

test('an ambiguous phone validation is never replayed and resumes only after target confirmation', async (t) => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({ taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root' }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-phone-continuity' });
  const store = temporaryStore(t);
  const mail = mailboxClient([{ id: 'mail-phone', email: 'phone@example.test', tokenValid: true, bound: false }]);
  let acquireCalls = 0;
  let cancelCalls = 0;
  let completeCalls = 0;
  let validateCalls = 0;
  let confirmed = false;
  const smsProvider = {
    service: 'mock', country: '151',
    async acquireNumber() {
      acquireCalls += 1;
      return { id: 'activation-phone', activationId: 'activation-phone', number: '+56912345678', status: 'leased', cost: 0.02 };
    },
    async markSmsSent(lease) { return { ...lease, status: 'waiting' }; },
    async pollCode() { return { code: '123456', status: 'received', providerStatus: 'STATUS_OK' }; },
    async requestAnotherCode(lease) { return lease; },
    async complete(lease) { completeCalls += 1; return { ...lease, status: 'complete' }; },
    async cancel(lease) { cancelCalls += 1; return { ...lease, status: 'cancelled' }; },
  };
  const options = {
    // Parking is what this test measures; the real phone retry ladder would
    // keep the run alive on live timers instead of returning here.
    retryPolicies: {},
    assetStore: store,
    mailClient: mail,
    smsProvider,
    reconcilePhoneValidation: async () => (confirmed
      ? { status: 'accepted', step: 'email_otp_validated' }
      : { status: 'unknown' }),
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        if (sessionState.step === 'initial') sessionState.step = 'phone_required';
        else if (sessionState.step === 'email_otp_validated') finishSession(sessionState, job);
      },
      async sendPhone(sessionState) { sessionState.step = 'phone_otp_sent'; },
      async validatePhone(sessionState) {
        validateCalls += 1;
        const error = new Error('socket reset after phone validation');
        error.code = 'ECONNRESET';
        throw error;
      },
    }),
  };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, options);
  assert.equal(state.status, 'waiting');
  assert.equal(state.jobs[0].phase, 'waiting_phone_confirmation');
  assert.equal(state.jobs[0].sms.current.activationId, 'activation-phone');
  assert.equal(state.jobs[0].sms.current.scope, 'session');
  assert.equal(state.jobs[0].sms.current.effect.kind, 'target_phone_validate');
  assert.equal(state.jobs[0].sms.current.code, '123456');
  assert.equal(acquireCalls, 1);
  assert.equal(cancelCalls, 0);

  resumeBranchState(state);
  await runBranchOrchestrator({ log: { entries: [] } }, state, config, options);
  assert.equal(state.status, 'waiting');
  assert.equal(state.jobs[0].phase, 'waiting_phone_confirmation');
  assert.equal(acquireCalls, 1);
  assert.equal(validateCalls, 1);
  assert.equal(completeCalls, 0);

  confirmed = true;
  resumeBranchState(state);
  await runBranchOrchestrator({ log: { entries: [] } }, state, config, options);
  assert.equal(state.status, 'complete');
  assert.equal(acquireCalls, 1);
  assert.equal(validateCalls, 1);
  assert.equal(completeCalls, 1);
  assert.equal(cancelCalls, 0);
  assert.equal(state.jobs[0].sms.current, null);
});

test('resume reconciles a checkpointed target phone send without sending a duplicate OTP', async (t) => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({ taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root' }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-phone-send-checkpoint' });
  let sendCalls = 0;
  let markCalls = 0;
  const options = {
    // These assertions are about the parking decision (lane blocking, lease
    // reconciliation), not the ladder that now retries it. Without this the
    // in-run retry recovers the job and the run finishes 'complete'.
    retryPolicies: {},
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([{ id: 'mail-phone-send', email: 'phone-send@example.test', tokenValid: true, bound: false }]),
    smsProvider: {
      service: 'mock', country: '151',
      async acquireNumber() { return { id: 'activation-send', activationId: 'activation-send', number: '+56912345678', status: 'leased', cost: 0.02 }; },
      async markSmsSent(lease) { markCalls += 1; return { ...lease, status: 'waiting' }; },
      async pollCode() { return { code: '123456', status: 'received' }; },
      async complete(lease) { return { ...lease, status: 'complete' }; },
      async cancel(lease) { return { ...lease, status: 'cancelled' }; },
      async requestAnotherCode(lease) { return lease; },
    },
    sessionRunnerFactory: ({ job, options: runnerHooks }) => ({
      async run(sessionState) {
        if (sessionState.step === 'initial') sessionState.step = 'phone_required';
        else if (sessionState.step === 'email_otp_validated') finishSession(sessionState, job);
      },
      async sendPhone(sessionState) {
        sendCalls += 1;
        sessionState.step = 'phone_otp_sent';
        await runnerHooks.checkpoint('phone_otp_sent', sessionState);
        if (sendCalls === 1) throw Object.assign(new Error('transport closed after target checkpoint'), { code: 'ECONNRESET' });
      },
      async validatePhone(sessionState) { sessionState.step = 'email_otp_validated'; },
    }),
  };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, options);
  assert.equal(state.status, 'waiting');
  assert.equal(state.jobs[0].sms.current.effect.kind, 'target_phone_send');
  assert.equal(sendCalls, 1);
  assert.equal(markCalls, 0);

  resumeBranchState(state);
  await runBranchOrchestrator({ log: { entries: [] } }, state, config, options);
  assert.equal(state.status, 'complete');
  assert.equal(sendCalls, 1);
  assert.equal(markCalls, 1);
  assert.equal(state.jobs[0].sms.attempts[0].targetSentInferred, true);
});

test('a transient branch transport failure keeps a resumable checkpoint instead of failing the job', async (t) => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({ taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root' }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-transient-checkpoint' });
  const mail = mailboxClient([{ id: 'mail-transient', email: 'transient@example.test', tokenValid: true, bound: false }]);
  let runCalls = 0;
  const options = {
    assetStore: temporaryStore(t),
    mailClient: mail,
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        runCalls += 1;
        if (runCalls === 1) {
          sessionState.step = 'email_otp_validated';
          throw Object.assign(new Error('upstream reset'), { code: 'ECONNRESET' });
        }
        finishSession(sessionState, job);
      },
    }),
  };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, options);
  // The Worker recovers the transient failure inside the same run: parking it
  // for an operator resume used to idle the Worker for no reason.
  assert.equal(state.status, 'complete');
  assert.equal(runCalls, 2);
  assert.deepEqual(mail.released, []);
  const scheduled = state.events.find((record) => record.type === 'branch_job_retry_scheduled');
  assert.equal(scheduled.waitPhase, 'waiting_transient');
  assert.equal(scheduled.attempt, 1);
  assert.equal(state.events.some((record) => record.type === 'branch_job_retry_due'), true);
  assert.equal(state.jobs[0].nextRunAt, '');
});

test('a transient failure that never clears parks for an operator without stalling the other lane', async (t) => {
  const config = branchConfig(1);
  config.mail.count = 2;
  config.aliases.strategy = 'root';
  config.aliases.count = 1;
  config.aliases.maxAttempts = 1;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 2, workerConcurrency: 1,
    aliasStrategy: 'root', aliasCount: 1, aliasMaxAttempts: 1,
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-transient-exhausted' });
  let stuckRuns = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([
      { id: 'mail-stuck', email: 'stuck@example.test', tokenValid: true, bound: false },
      { id: 'mail-ok', email: 'ok@example.test', tokenValid: true, bound: false },
    ]),
    retryPolicies: { waiting_transient: { delaysMs: [1], maxRetries: 2 } },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        if (job.email !== 'stuck@example.test') return finishSession(sessionState, job);
        stuckRuns += 1;
        throw Object.assign(new Error('upstream reset'), { code: 'ECONNRESET' });
      },
    }),
  });

  const stuck = state.jobs.find((job) => job.email === 'stuck@example.test');
  const ok = state.jobs.find((job) => job.email === 'ok@example.test');
  // One initial run plus two retries, then it stops asking.
  assert.equal(stuckRuns, 3);
  assert.equal(stuck.status, 'waiting');
  assert.equal(stuck.phase, 'waiting_transient');
  assert.equal(stuck.nextRunAt, '', 'an exhausted job must not hold a retry slot');
  assert.equal(stuck.retry.attempts, 2);
  assert.equal(ok.status, 'complete', 'the unrelated lane still had to finish');
  // An operator resume hands back a fresh budget.
  resumeBranchState(state);
  assert.equal(state.jobs.find((job) => job.email === 'stuck@example.test').retry, null);
});

test('a Cloudflare challenge rotates to a fresh exit and finishes inside the same run', async (t) => {
  const config = branchConfig(1);
  config.proxyPool.required = true;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-cloudflare-inrun-rotation' });
  const first = { id: 'proxy-cf-a', url: 'http://proxy-cf-a:4101', workerSlots: [1] };
  const second = { id: 'proxy-cf-b', url: 'http://proxy-cf-b:4102', workerSlots: [1] };
  const proxiesSeen = [];

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([{ id: 'mail-cf', email: 'cf@example.test', tokenValid: true, bound: false }]),
    proxyEntries: [first, second],
    // `proxyPool.required` turns the health check on during config validation,
    // so the probe has to be stubbed or it would resolve fixture hostnames.
    proxyProbeExecutor: async (_request, probeOptions) => ({ response: { status: 200, url: probeOptions.proxy } }),
    retryPolicies: { waiting_proxy_rotation: { delaysMs: [1], maxRetries: 3, proxyAction: 'already_rotated' } },
    sessionRunnerFactory: ({ job, worker }) => ({
      async run(sessionState) {
        proxiesSeen.push(worker.proxyId);
        // The first exit drawn is the challenged one; bindWorkerProxy shuffles
        // candidates, so the fixture keys off the attempt, not the proxy id.
        if (proxiesSeen.length === 1) {
          throw Object.assign(new Error('Cloudflare challenge'), {
            code: 'CLOUDFLARE_CHALLENGE',
            cloudflareChallenge: true,
          });
        }
        finishSession(sessionState, job);
      },
    }),
  });

  // No operator resume: the challenged exit is banned for the run and the job
  // comes straight back on a different one.
  assert.equal(state.status, 'complete');
  assert.equal(state.jobs[0].status, 'complete');
  // bindWorkerProxy shuffles candidates, so assert the shape rather than which
  // fixture happened to be picked first.
  assert.equal(proxiesSeen.length, 2);
  assert.notEqual(proxiesSeen[0], proxiesSeen[1], 'the retry has to leave the challenged exit');
  assert.equal(state.proxyHealth[proxiesSeen[0]].status, 'failed');
  assert.equal(state.proxyHealth[proxiesSeen[0]].reason, 'cloudflare_challenge');
  const swapped = state.events.find((record) => record.type === 'worker_proxy_swapped_before_registration');
  assert.equal(swapped.banned, true, 'a challenged exit is retired for the run, not rechecked');
  const scheduled = state.events.find((record) => record.type === 'branch_job_retry_scheduled');
  assert.equal(scheduled.waitPhase, 'waiting_proxy_rotation');
});

test('a failed country-pool worker probe retires the endpoint before the next bind', async (t) => {
  const config = branchConfig(1);
  config.proxyPool.required = true;
  config.proxyPool.healthCheck = { enabled: true, probeUrl: 'https://probe.example.test/', timeoutMs: 50 };
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-country-pool-retirement' });
  const bad = { id: 'proxy-country-bad', url: 'http://proxy-country-bad:4101', workerSlots: [1], resourceKind: 'countryPool', countryCode: 'JP' };
  const good = { id: 'proxy-country-good', url: 'http://proxy-country-good:4102', workerSlots: [1], resourceKind: 'countryPool', countryCode: 'JP' };
  const retired = [];

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([{ id: 'mail-country-retirement', email: 'country-retirement@example.test', tokenValid: true, bound: false }]),
    proxyEntries: [bad, good],
    random: () => 0.999,
    proxyProbeExecutor: async (_request, probeOptions) => {
      if (probeOptions.proxy === bad.url) throw new Error('country-pool probe failed');
      return { response: { status: 200, url: probeOptions.proxy } };
    },
    retireCountryPoolProxy: async ({ proxy }) => { retired.push(proxy.id); return { retired: true }; },
    sessionRunnerFactory: ({ job }) => ({ async run(sessionState) { finishSession(sessionState, job); } }),
  });

  assert.equal(state.status, 'complete');
  assert.deepEqual(retired, [bad.id]);
  assert.equal(state.proxyHealth[bad.id].status, 'failed');
  assert.equal(state.events.some((event) => event.type === 'worker_proxy_country_pool_retired' && event.proxyId === bad.id), true);
  assert.equal(state.events.find((event) => event.type === 'worker_proxy_rejected' && event.proxyId === bad.id).retired, true);
});

test('a proxy rotation retry cycle restarts while local candidates remain', async (t) => {
  const config = branchConfig(1);
  config.proxyPool.required = true;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-proxy-rotation-cycle' });
  const proxies = Array.from({ length: 5 }, (_, index) => ({
    id: `proxy-cycle-${index + 1}`,
    url: `http://proxy-cycle-${index + 1}:410${index + 1}`,
    workerSlots: [1],
  }));
  let attempts = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([{ id: 'mail-cycle', email: 'cycle@example.test', tokenValid: true, bound: false }]),
    proxyEntries: proxies,
    proxyProbeExecutor: async (_request, probeOptions) => ({ response: { status: 200, url: probeOptions.proxy } }),
    retryPolicies: { waiting_proxy_rotation: { delaysMs: [1], maxRetries: 3 } },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        attempts += 1;
        if (attempts < 5) {
          throw Object.assign(new Error('Cloudflare challenge'), {
            code: 'CLOUDFLARE_CHALLENGE',
            cloudflareChallenge: true,
          });
        }
        finishSession(sessionState, job);
      },
    }),
  });

  assert.equal(state.status, 'complete');
  assert.equal(attempts, 5);
  assert.equal(state.events.some((record) => (
    record.type === 'branch_job_retry_scheduled' && record.cycleRestarted === true
  )), true);
  assert.equal(state.events.some((record) => record.type === 'branch_job_waiting' && record.waitPhase === 'waiting_proxy_pool'), false);
});

test('proxy rotation exhaustion refreshes the pool before waiting', async (t) => {
  const config = branchConfig(1);
  config.proxyPool.required = true;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-proxy-rotation-refresh' });
  const initial = { id: 'proxy-refresh-initial', url: 'http://proxy-refresh-initial:4101', workerSlots: [1] };
  const replacement = { id: 'proxy-refresh-replacement', url: 'http://proxy-refresh-replacement:4102', workerSlots: [1] };
  let attempts = 0;
  let refreshes = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([{ id: 'mail-proxy-rotation-refresh', email: 'proxy-rotation-refresh@example.test', tokenValid: true, bound: false }]),
    proxyEntries: [initial],
    refreshProxyResources: async (details) => {
      refreshes += 1;
      assert.deepEqual(details.workerSlots, [1]);
      return { snapshot: { schemaVersion: 1, entries: [initial, replacement] } };
    },
    proxyProbeExecutor: async (_request, probeOptions) => ({ response: { status: 200, url: probeOptions.proxy } }),
    retryPolicies: {
      waiting_proxy_rotation: { delaysMs: [1], maxRetries: 1, jitterRatio: 0 },
      waiting_proxy_pool: { delaysMs: [1], maxRetries: 2, jitterRatio: 0 },
    },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        attempts += 1;
        if (attempts === 1) {
          throw Object.assign(new Error('Cloudflare challenge'), {
            code: 'CLOUDFLARE_CHALLENGE',
            cloudflareChallenge: true,
          });
        }
        finishSession(sessionState, job);
      },
    }),
  });

  assert.equal(state.status, 'complete');
  assert.equal(state.jobs[0].status, 'complete');
  assert.equal(attempts, 2);
  assert.equal(refreshes, 1);
  assert.equal(state.events.some((event) => event.type === 'proxy_resources_refreshed_for_waiting_workers'), true);
});

test('a Cloudflare challenge holding a paid number retries in place, then drops the number for a fresh exit', async (t) => {
  const config = branchConfig(1);
  config.proxyPool.required = true;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-cloudflare-sms-abandon' });
  const challenged = { id: 'proxy-cf-held', url: 'http://proxy-cf-held:4101', workerSlots: [1] };
  const clean = { id: 'proxy-cf-clean', url: 'http://proxy-cf-clean:4102', workerSlots: [1] };
  let cancelled = 0;
  const smsProvider = {
    service: 'mock',
    country: '151',
    async acquireNumber() {
      return { id: 'activation-cf', activationId: 'activation-cf', number: '+56912345678', status: 'leased', cost: 0.02 };
    },
    async markSmsSent(lease) { return { ...lease, status: 'waiting' }; },
    async pollCode() { return { code: '123456', status: 'received' }; },
    async complete(lease) { return { ...lease, status: 'complete' }; },
    async cancel(lease) { cancelled += 1; return { ...lease, status: 'cancelled' }; },
    async requestAnotherCode(lease) { return lease; },
  };
  const proxiesSeen = [];
  let validateCalls = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([{ id: 'mail-cf-held', email: 'cfheld@example.test', tokenValid: true, bound: false }]),
    proxyEntries: [challenged, clean],
    proxyProbeExecutor: async (_request, probeOptions) => ({ response: { status: 200, url: probeOptions.proxy } }),
    smsProvider,
    retryPolicies: {
      waiting_proxy_retry: { delaysMs: [1], maxRetries: 1, proxyAction: 'keep', onExhausted: 'restart_on_fresh_exit' },
      waiting_proxy_rotation: { delaysMs: [1], maxRetries: 3, proxyAction: 'already_rotated' },
    },
    sessionRunnerFactory: ({ job, worker }) => ({
      async run(sessionState) {
        if (sessionState.step === 'initial') sessionState.step = 'phone_required';
        else if (sessionState.step === 'email_otp_validated') finishSession(sessionState, job);
      },
      async sendPhone(sessionState) {
        validateCalls += 1;
        proxiesSeen.push(worker.proxyId);
        // Challenged while a paid lease is held but before the OTP goes out, so
        // nothing is ambiguous and the exit is worth a couple of retries.
        // Throwing from validatePhone instead would trip the never-replay guard.
        if (!state.events.some((record) => record.type === 'registration_restarted_on_fresh_exit')) {
          throw Object.assign(new Error('Cloudflare challenge'), {
            code: 'CLOUDFLARE_CHALLENGE',
            cloudflareChallenge: true,
          });
        }
        sessionState.step = 'phone_otp_sent';
      },
      async validatePhone(sessionState) { sessionState.step = 'email_otp_validated'; },
    }),
  });

  assert.equal(state.events.some((record) => record.type === 'worker_proxy_retry_in_registration'), true,
    'mid-registration the bound exit is retried rather than dropped at once');
  const restarted = state.events.find((record) => record.type === 'registration_restarted_on_fresh_exit');
  assert.ok(restarted, 'exhausted retries must rebuild the attempt instead of parking it');
  assert.equal(cancelled >= 1, true, 'the paid activation has to be cancelled before the rebuild');
  // The exit is kept while the number is alive, then left behind.
  assert.equal(proxiesSeen[0], proxiesSeen[1], 'the paid number must not be stranded by an early rotation');
  assert.notEqual(proxiesSeen.at(-1), proxiesSeen[0], 'the rebuilt attempt has to leave the bad exit');
  assert.equal(state.jobs[0].status, 'complete');
});

test('a runtime auth timeout retires the bound exit and rebinds without a recheck', async (t) => {
  const config = branchConfig(1);
  config.proxyPool.required = true;
  config.proxyPool.healthCheck = {
    enabled: true,
    probeUrl: 'https://auth.openai.com/',
    timeoutMs: 50,
  };
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-proxy-runtime-timeout' });
  const mail = mailboxClient([{ id: 'mail-proxy-runtime', email: 'proxy-runtime@example.test', tokenValid: true, bound: false }]);
  const store = temporaryStore(t);
  const dead = { id: 'proxy-dead-runtime', url: 'http://proxy-dead-runtime:4101', workerSlots: [1] };
  const good = { id: 'proxy-good-runtime', url: 'http://proxy-good-runtime:4102', workerSlots: [1] };
  let probeCalls = 0;
  let runCalls = 0;
  const options = {
    assetStore: store,
    mailClient: mail,
    proxyEntries: [dead],
    proxyProbeExecutor: async (_request, probeOptions) => {
      probeCalls += 1;
      if (probeOptions.proxy === dead.url && probeCalls > 1) {
        throw Object.assign(new Error('proxy probe timed out'), { code: 'ETIMEDOUT' });
      }
      return { response: { status: 200, url: probeOptions.proxy } };
    },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        runCalls += 1;
        if (runCalls === 1) {
          throw Object.assign(new Error('Proxy request timed out after 15000 ms: https://chatgpt.com/api/auth/session'), {
            code: 'CHATGPT_SESSION_TIMEOUT',
            retryable: true,
            category: 'transient',
          });
        }
        finishSession(sessionState, job);
      },
    }),
  };

  options.retryPolicies = { waiting_proxy_rotation: { delaysMs: [1], maxRetries: 2, proxyAction: 'already_rotated' } };
  await runBranchOrchestrator({ log: { entries: [] } }, state, config, options);
  // The exit that carried the failure is spent outright. There is no recheck:
  // a synthetic probe cannot overturn evidence from the account flow itself,
  // and re-probing the address was the only thing the old path could do with
  // the answer anyway. The refresh recovery still arms exactly as before —
  // this was the lane's only exit, so nothing is left to rotate onto.
  assert.equal(state.status, 'waiting');
  assert.equal(state.jobs[0].phase, 'waiting_proxy_rotation');
  assert.equal(state.jobs[0].status, 'waiting');
  assert.equal(state.jobs[0].proxyTransportRecovery.pending, true);
  assert.equal(state.jobs[0].nextRunAt, '');
  assert.equal(state.proxyHealth[dead.id].status, 'failed');
  assert.equal(probeCalls <= 1, true, 'the bound exit must not be re-probed after a real-traffic failure');
  assert.equal(state.events.some((record) => record.type === 'branch_job_retry_scheduled'), false);
  assert.equal(state.events.some((record) => record.type === 'worker_proxy_swapped_before_registration'), true);

  options.proxyEntries = [dead, good];
  resumeBranchState(state);
  await runBranchOrchestrator({ log: { entries: [] } }, state, config, options);

  assert.equal(state.status, 'complete');
  // The exit is handed back once the account finishes, so the Worker holds none
  // and only remembers the one it just spent.
  assert.equal(state.workers[0].proxyId, '');
  assert.equal(state.workers[0].lastProxyId, good.id);
  // The refresh recovery is consumed on resume and the run lands on `good`,
  // which is then spent by the account it registered.
  assert.equal(state.proxyHealth[dead.id]?.status, 'failed');
  assert.equal(state.proxyHealth[good.id].status, 'healthy');
  assert.equal(state.proxyHealth[good.id].reason, '');
  assert.equal(state.events.some((record) => record.type === 'proxy_transport_recovery_resumed'), true);
  assert.equal(runCalls, 2);
});

test('a parked proxy refresh recovery is consumed in run once a lane hands its exit back', async (t) => {
  // The regression: the pending marker was only ever consumed by
  // `resumeBranchState`, an operator action. A job that parked because every
  // exit was busy therefore stayed parked while the other lanes finished and
  // released theirs, and the run sat with idle Workers until someone pressed
  // resume.
  const config = branchConfig(2);
  config.mail.count = 2;
  config.proxyPool.required = true;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 2, workerConcurrency: 2, aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-proxy-recovery-in-run' });
  const mail = mailboxClient([
    { id: 'mail-recovery-1', email: 'recovery-1@example.test', tokenValid: true, bound: false },
    { id: 'mail-recovery-2', email: 'recovery-2@example.test', tokenValid: true, bound: false },
  ]);
  const runsByJob = new Map();
  const options = {
    assetStore: temporaryStore(t),
    mailClient: mail,
    proxyEntries: [
      { id: 'proxy-lane-a', url: 'http://proxy-lane-a:4101' },
      { id: 'proxy-lane-b', url: 'http://proxy-lane-b:4102' },
    ],
    proxyProbeExecutor: async (_request, probeOptions) => ({ response: { status: 200, url: probeOptions.proxy } }),
    sessionRunnerFactory: ({ job, worker }) => ({
      async run(sessionState) {
        const attempts = (runsByJob.get(job.id) || 0) + 1;
        runsByJob.set(job.id, attempts);
        if (worker.slot === 1) {
          // Hold the other exit long enough for slot 2 to fail with the pool busy.
          await new Promise((resolve) => setTimeout(resolve, 25));
          finishSession(sessionState, job);
          return;
        }
        if (attempts === 1) {
          throw Object.assign(new Error('Proxy request timed out: https://chatgpt.com/api/auth/session'), {
            code: 'CHATGPT_SESSION_TIMEOUT',
            retryable: true,
            category: 'transient',
          });
        }
        finishSession(sessionState, job);
      },
    }),
  };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, options);

  const resumedInRun = state.events.filter((record) => record.type === 'proxy_transport_recovery_resumed');
  assert.equal(resumedInRun.length, 1, 'the pending recovery is consumed inside the run, without an operator resume');
  assert.equal(state.status, 'complete');
  assert.equal(state.jobs.every((job) => job.status === 'complete'), true,
    'the parked lane finishes on the exit the other lane handed back');
  assert.equal(state.jobs.every((job) => job.proxyTransportRecovery.pending), false,
    'the marker is one-shot, so nothing stays armed after it is consumed');
});

test('a proxy transport failure after the one refresh recovery skips the account', async (t) => {
  const config = branchConfig(1);
  config.proxyPool.required = true;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-proxy-recovery-exhausted' });
  const mail = mailboxClient([{ id: 'mail-proxy-exhausted', email: 'proxy-exhausted@example.test', tokenValid: true, bound: false }]);
  let runCalls = 0;
  const options = {
    assetStore: temporaryStore(t),
    mailClient: mail,
    proxyEntries: [
      { id: 'proxy-recovery-a', url: 'http://proxy-recovery-a:4101' },
      { id: 'proxy-recovery-b', url: 'http://proxy-recovery-b:4102' },
    ],
    proxyProbeExecutor: async (_request, probeOptions) => ({ response: { status: 200, url: probeOptions.proxy } }),
    sessionRunnerFactory: () => ({
      async run() {
        runCalls += 1;
        throw Object.assign(new Error('Proxy request timed out: https://chatgpt.com/api/auth/session'), {
          code: 'CHATGPT_SESSION_TIMEOUT',
          retryable: true,
          category: 'transient',
        });
      },
    }),
  };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, options);
  assert.equal(state.jobs[0].status, 'waiting');
  assert.equal(runCalls, 2, 'a spare exit is tried before the refresh fallback is armed');

  resumeBranchState(state);
  await runBranchOrchestrator({ log: { entries: [] } }, state, config, options);

  assert.equal(runCalls, 2, 'already measured exits must not be replayed after recovery is consumed');
  assert.equal(state.jobs[0].status, 'skipped');
  assert.equal(state.jobs[0].phase, 'skipped');
  assert.equal(state.jobs[0].proxyTransportRecovery.attempted, true);
  assert.equal(state.jobs[0].proxyTransportRecovery.pending, false);
  assert.equal(state.jobs[0].error.code, 'PROXY_TRANSPORT_RECOVERY_EXHAUSTED');
  assert.equal(state.events.filter((record) => record.type === 'branch_job_retry_scheduled').length, 1,
    'the spare exit rotation is scheduled once before the refresh fallback');
  assert.equal(state.events.filter((record) => record.type === 'branch_job_skipped').length, 1);
});

test('an invalid acquired lease with deferred cleanup is persisted before a replacement is obtained', async (t) => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({ taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root' }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-invalid-lease-cleanup' });
  const store = temporaryStore(t);
  const mail = mailboxClient([{ id: 'mail-invalid-lease', email: 'invalid-lease@example.test', tokenValid: true, bound: false }]);
  let acquireCalls = 0;
  let cancelCalls = 0;
  const smsProvider = {
    service: 'mock', country: '151',
    async acquireNumber() {
      acquireCalls += 1;
      if (acquireCalls === 1) {
        const error = new Error('number does not match the configured dialing code');
        error.code = 'PHONE_COUNTRY_MISMATCH';
        error.invalidLease = {
          id: 'activation-invalid', activationId: 'activation-invalid', number: '151999999',
          status: 'pending_cleanup', cost: 0.01,
        };
        throw error;
      }
      return { id: 'activation-valid', activationId: 'activation-valid', number: '+56912345678', status: 'leased', cost: 0.02 };
    },
    async cancel(lease) { cancelCalls += 1; return { ...lease, status: 'cancelled' }; },
    async markSmsSent(lease) { return { ...lease, status: 'waiting' }; },
    async pollCode() { return { code: '123456', status: 'received' }; },
    async complete(lease) { return { ...lease, status: 'complete' }; },
    async requestAnotherCode(lease) { return lease; },
  };
  const options = {
    // These assertions are about the parking decision (lane blocking, lease
    // reconciliation), not the ladder that now retries it. Without this the
    // in-run retry recovers the job and the run finishes 'complete'.
    retryPolicies: {},
    assetStore: store,
    mailClient: mail,
    smsProvider,
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        if (sessionState.step === 'initial') sessionState.step = 'phone_required';
        else if (sessionState.step === 'email_otp_validated') finishSession(sessionState, job);
      },
      async sendPhone(sessionState) { sessionState.step = 'phone_otp_sent'; },
      async validatePhone(sessionState) { sessionState.step = 'email_otp_validated'; },
    }),
  };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, options);
  assert.equal(state.status, 'waiting');
  assert.equal(state.jobs[0].sms.current.activationId, 'activation-invalid');
  assert.equal(state.jobs[0].sms.current.status, 'pending_cleanup');
  assert.equal(state.jobs[0].sms.costUsd, 0.01);

  resumeBranchState(state);
  await runBranchOrchestrator({ log: { entries: [] } }, state, config, options);
  assert.equal(state.status, 'complete');
  assert.equal(acquireCalls, 2);
  assert.equal(cancelCalls, 1);
  assert.equal(state.jobs[0].sms.costUsd, 0.03);
  assert.deepEqual(state.jobs[0].sms.attempts.map((lease) => lease.activationId), ['activation-invalid', 'activation-valid']);
});

test('resume infers an accepted phone from the advanced runner checkpoint before continuing', async (t) => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({ taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root' }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-phone-checkpoint-reconcile' });
  let validateCalls = 0;
  let completeCalls = 0;
  const options = {
    // These assertions are about the parking decision (lane blocking, lease
    // reconciliation), not the ladder that now retries it. Without this the
    // in-run retry recovers the job and the run finishes 'complete'.
    retryPolicies: {},
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([{ id: 'mail-phone-checkpoint', email: 'phone-checkpoint@example.test', tokenValid: true, bound: false }]),
    smsProvider: {
      service: 'mock', country: '151',
      async acquireNumber() { return { id: 'activation-checkpoint', activationId: 'activation-checkpoint', number: '+56912345678', status: 'leased', cost: 0.02 }; },
      async markSmsSent(lease) { return { ...lease, status: 'waiting' }; },
      async pollCode() { return { code: '123456', status: 'received' }; },
      async complete(lease) { completeCalls += 1; return { ...lease, status: 'complete' }; },
      async cancel(lease) { return { ...lease, status: 'cancelled' }; },
      async requestAnotherCode(lease) { return lease; },
    },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        if (sessionState.step === 'initial') sessionState.step = 'phone_required';
        else if (sessionState.step === 'email_otp_validated') finishSession(sessionState, job);
      },
      async sendPhone(sessionState) { sessionState.step = 'phone_otp_sent'; },
      async validatePhone(sessionState) {
        validateCalls += 1;
        sessionState.step = 'email_otp_validated';
        if (validateCalls === 1) throw Object.assign(new Error('checkpoint saved before transport closed'), { code: 'ECONNRESET' });
      },
    }),
  };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, options);
  assert.equal(state.status, 'waiting');
  assert.equal(state.jobs[0].sessionState.step, 'email_otp_validated');
  assert.equal(state.jobs[0].sms.current.targetAccepted, undefined);

  resumeBranchState(state);
  await runBranchOrchestrator({ log: { entries: [] } }, state, config, options);
  assert.equal(state.status, 'complete');
  assert.equal(validateCalls, 1);
  assert.equal(completeCalls, 1);
  assert.equal(state.jobs[0].sms.attempts[0].targetAcceptedInferred, true);
});

test('failed SMS cancellation remains persisted and a later cancel retries the same activation', async () => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({ taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root' }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-cancel-retry' });
  state.mailboxes.push({ id: 'mail-cancel-retry', email: 'cancel-retry@example.test', status: 'reserved' });
  state.jobs.push({
    id: 'job-cancel-retry', email: 'cancel-retry@example.test', parentEmail: 'cancel-retry@example.test',
    mailboxId: 'mail-cancel-retry', laneId: 'mail-cancel-retry', status: 'waiting', phase: 'phone_otp_sent',
    sms: { current: { id: 'activation-retry', activationId: 'activation-retry', number: '+56912345678', status: 'waiting' }, attempts: [], costUsd: 0.02, replacements: 0, sendRetries: 0 },
  });
  const mail = mailboxClient([]);
  let cancelCalls = 0;
  const smsProvider = {
    async cancel(lease) {
      cancelCalls += 1;
      if (cancelCalls === 1) throw Object.assign(new Error('temporary provider failure'), { code: 'ETIMEDOUT' });
      return { ...lease, status: 'cancelled' };
    },
  };

  await cancelBranchState(state, config, { mailClient: mail, smsProvider });
  assert.equal(state.status, 'waiting');
  assert.equal(state.cancelPending, true);
  assert.equal(state.jobs[0].sms.current.activationId, 'activation-retry');
  assert.equal(state.jobs[0].sms.current.status, 'pending_cleanup');
  assert.equal(state.jobs[0].sms.attempts.length, 0);
  assert.deepEqual(mail.released, []);

  await cancelBranchState(state, config, { mailClient: mail, smsProvider });
  assert.equal(state.status, 'cancelled');
  assert.equal(state.cancelPending, false);
  assert.equal(state.jobs[0].sms.current, null);
  assert.equal(state.jobs[0].sms.attempts[0].status, 'cancelled');
  assert.equal(state.jobs[0].error, null);
  assert.deepEqual(mail.released, ['mail-cancel-retry']);
});

test('cancellation archives a consumed activation when SMSBower rejects terminal completion with BAD_STATUS', async () => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({ taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root' }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-consumed-terminal-review' });
  state.jobs.push({
    id: 'job-consumed-terminal-review', email: 'consumed@example.test', parentEmail: 'consumed@example.test',
    mailboxId: '', laneId: 'consumed@example.test', status: 'waiting', phase: 'waiting_sms_cleanup',
    sms: {
      current: {
        id: 'activation-consumed', activationId: 'activation-consumed', provider: 'smsbower',
        service: 'dr', country: '151', status: 'completion_pending', providerStatus: 'STATUS_OK',
        codeReceived: true, cleanupAction: 'complete', cost: 0.052,
      },
      attempts: [], acquisitions: [], costUsd: 0.052, replacements: 0, sendRetries: 0,
    },
  });
  let completeCalls = 0;
  const smsProvider = {
    name: 'smsbower',
    async complete() {
      completeCalls += 1;
      throw Object.assign(new Error('SMSBower setStatus failed: BAD_STATUS'), {
        code: 'BAD_STATUS', action: 'setStatus', retryable: false,
      });
    },
  };

  await cancelBranchState(state, config, { smsProvider });

  assert.equal(completeCalls, 1);
  assert.equal(state.status, 'cancelled');
  assert.equal(state.cancelPending, false);
  assert.equal(state.jobs[0].status, 'cancelled');
  assert.equal(state.jobs[0].sms.current, null);
  assert.equal(state.jobs[0].sms.attempts[0].status, 'complete');
  assert.equal(state.jobs[0].sms.attempts[0].terminalReviewRequired, true);
  assert.equal(state.jobs[0].sms.externalCleanupRequired, true);
  assert.equal(state.externalCleanup.length, 1);
  assert.equal(state.externalCleanup[0].type, 'sms_activation_terminal_review');
  assert.equal(state.externalCleanup[0].activationId, 'activation-consumed');
  assert.equal(state.externalCleanup[0].status, 'manual_review_required');

  await cancelBranchState(state, config, { smsProvider });
  assert.equal(completeCalls, 1);
  assert.equal(state.externalCleanup.length, 1);
});

test('offline branch cancellation reauthenticates Xiaopingguo before releasing a zero-output mailbox', async () => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({ taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root' }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-cancel-mail-reauth' });
  state.mailboxes.push({ id: 'mail-reauth', email: 'reauth@example.test', status: 'reserved' });
  state.jobs.push({
    id: 'job-mail-reauth', email: 'reauth@example.test', parentEmail: 'reauth@example.test',
    mailboxId: 'mail-reauth', laneId: 'mail-reauth', status: 'waiting', phase: 'queued',
    sms: { current: null, attempts: [], costUsd: 0, replacements: 0, sendRetries: 0 },
  });
  const calls = [];
  const mailFetch = async (url, init = {}) => {
    const pathname = new URL(String(url)).pathname;
    calls.push(`${init.method || 'GET'} ${pathname}`);
    const body = pathname === '/api/login'
      ? { csrfToken: 'csrf-mail-reauth' }
      : pathname === '/api/accounts'
        ? { accounts: [{ id: 'mail-reauth', email: 'reauth@example.test', bound: true }] }
        : { id: 'mail-reauth', bound: false };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  await cancelBranchState(state, config, { mailFetch, smsProvider: {} });
  assert.equal(state.status, 'cancelled');
  assert.equal(state.mailboxes[0].status, 'released');
  assert.deepEqual(calls, ['POST /api/login', 'GET /api/accounts', 'PATCH /api/accounts/mail-reauth']);
});

test('Cockpit phone validation stops at the accepted boundary before OAuth navigation resumes', async () => {
  const state = makeInitialCockpitOAuthState({ email: 'oauth-phone@example.test' });
  state.step = 'phone_otp_sent';
  let calls = 0;
  const runner = new CockpitOAuthRunner({
    executor: async (request) => {
      calls += 1;
      assert.match(request.url, /\/api\/accounts\/phone-otp\/validate$/);
      return {
        request,
        response: {
          status: 200,
          url: request.url,
          location: '',
          contentType: 'application/json',
          text: JSON.stringify({ continue_url: 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent' }),
        },
      };
    },
  });

  await runner.validatePhone(state, '123456');
  assert.equal(calls, 1);
  assert.equal(state.step, 'navigating');
});

test('branch summaries separate confirmed SMS consumption from cancelled quotes', () => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-cost-summary' });
  state.status = 'complete';
  state.jobs = [{
    id: 'job-cost-summary',
    email: 'cost-summary@example.test',
    parentEmail: 'cost-summary@example.test',
    status: 'complete',
    phase: 'complete',
    aliasIndex: 1,
    sms: {
      current: null,
      attempts: [
        { id: 'activation-cancelled', status: 'cancelled', cost: 0.03 },
        { id: 'activation-complete', status: 'complete', cost: 0.02 },
      ],
      costUsd: 0.05,
    },
  }];

  const summary = summarizeBranchState(state);
  assert.equal(summary.jobs[0].smsCostUsd, 0.02);
  assert.equal(summary.jobs[0].smsQuotedUsd, 0.05);
  assert.equal(summary.jobs[0].smsUnresolvedUsd, 0.03);
  assert.equal(summary.costs.sms, 0.02);
  assert.equal(summary.billing.unresolvedUsd, 0.03);
  assert.equal(summary.billing.billingComplete, false);
});

test('branch summary explains a balance-matched cancellation quote separately from confirmed spend', () => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-cost-settled-cancel' });
  state.status = 'complete';
  state.balanceReconciliation = {
    provider: 'mock',
    currency: 'USD',
    startBalance: 1.009,
    startCheckedAt: '2026-08-31T00:00:00.000Z',
    endBalance: 0.679,
    endAccountFingerprint: '',
    endCheckedAt: '2026-08-31T00:00:10.000Z',
    observedDecrease: 0.33,
    confirmedConsumed: 0.33,
    unresolved: 0.495,
    difference: 0,
    tolerance: 0.000001,
    billingComplete: false,
    concurrent: false,
    concurrentRunIds: [],
    status: 'pending',
    finalizedAt: '2026-08-31T00:00:10.000Z',
  };
  state.jobs = [{
    id: 'job-cost-settled-cancel',
    email: 'cost-settled@example.test',
    parentEmail: 'cost-settled@example.test',
    status: 'complete',
    phase: 'complete',
    aliasIndex: 1,
    accountCreatedAt: '2026-08-31T00:00:05.000Z',
    sms: {
      current: null,
      attempts: [
        { id: 'activation-cancelled', status: 'cancelled', cost: 0.495 },
        { id: 'activation-complete', status: 'complete', cost: 0.33 },
      ],
    },
  }];

  const summary = summarizeBranchState(state);
  assert.equal(summary.costs.sms, 0.33);
  assert.equal(summary.billing.unresolvedUsd, 0);
  assert.equal(summary.billing.cancelledQuotesSettledUsd, 0.495);
  assert.equal(summary.balanceReconciliation.note, 'balance_matched_cancelled_quotes_excluded');
  assert.equal(summary.balanceReconciliation.unresolved, 0);
});

test('partial session security transport failures are resumable without replaying the account flow', () => {
  const state = {
    taskKind: 'register_session',
    status: 'partial',
    phase: 'partial',
    completedAt: '2026-08-06T18:38:25.778Z',
    lastError: null,
    cancelPending: false,
    control: {},
    events: [],
    workers: [{ id: 'worker-1', status: 'idle', currentJobId: '', mailboxId: null }],
    jobs: [{
      id: 'job-security-retry',
      assetId: 'asset-security-retry',
      sessionAssetId: 'asset-security-retry',
      status: 'partial',
      phase: 'partial',
      error: null,
      sessionState: {
        step: 'verified',
        status: 'partial',
        security: {
          passwordStatus: 'failed',
          totpStatus: 'failed',
          passwordTransaction: { step: 'otp_sent' },
          failures: [
            { feature: 'password', code: 'PASSWORD_OTP_VALIDATE_TIMEOUT', message: 'Proxy request timed out' },
            { feature: 'totp', code: 'MFA_INFO_TIMEOUT', message: 'Proxy request timed out' },
          ],
        },
      },
      sms: { current: null },
    }],
  };

  assert.equal(canResumeBranchState(state), true);
  resumeBranchState(state);

  assert.equal(state.status, 'initialized');
  assert.equal(state.jobs[0].status, 'queued');
  assert.equal(state.jobs[0].phase, 'resuming_security');
  assert.equal(state.jobs[0].sessionState.security.passwordStatus, 'retry_pending');
  assert.equal(state.jobs[0].sessionState.security.totpStatus, 'retry_pending');
  assert.equal(state.jobs[0].sessionState.security.passwordTransaction.step, 'retry_pending');
  assert.equal(state.events.at(-1).type, 'security_setup_resume_queued');
});

test('a security setup that failed on transport finishes in-run without a resume', async (t) => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root',
    security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-security-inrun-retry' });
  let securityAttempts = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([{ id: 'mail-sec', email: 'sec@example.test', tokenValid: true, bound: false }]),
    retryPolicies: { waiting_security_retry: { delaysMs: [1], maxRetries: 3 } },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        finishSession(sessionState, job);
        securityAttempts += 1;
        sessionState.security = sessionState.security || {};
        if (securityAttempts === 1) {
          // The account is already saved at this point; only the optional
          // password/TOTP work failed, and it failed on transport.
          sessionState.status = 'partial';
          sessionState.security.passwordStatus = 'retry_pending';
          sessionState.security.totpStatus = 'retry_pending';
          sessionState.security.failures = [
            { feature: 'password', code: 'ECONNRESET', message: 'Client network socket disconnected' },
            { feature: 'totp', code: 'TOTP_SETUP_DEFERRED', message: 'deferred after the password transport failed' },
          ];
          return;
        }
        sessionState.status = 'valid';
        sessionState.security.passwordStatus = 'configured';
        sessionState.security.totpStatus = 'configured';
        sessionState.security.failures = [];
      },
    }),
  });

  // Two runs: the first left security pending, the second finished it. Before
  // this the job stopped at `partial` and only an operator resume could finish.
  assert.equal(securityAttempts, 2);
  assert.equal(state.events.some((record) => record.type === 'security_setup_retry_scheduled'), true);
  assert.equal(state.jobs[0].status, 'complete');
  assert.equal(state.status, 'complete');
});

test('a mixed login-state OAuth task reads each mailbox through its own channel', async (t) => {
  const { validateV2Config } = require('../src/config-v2');
  const { _mailContextForJob: mailContextForJob } = require('../src/branch-orchestrator');
  const store = temporaryStore(t);
  const outlook = store.upsert({ email: 'pool@outlook.example', mailProvider: 'xiaopingguo', parentMailboxId: 'xiaopingguo:pool' });
  const icloud = store.upsert({ email: 'apple@icloud.example', mailProvider: 'icloud', parentMailboxId: 'icloud:apple' });
  const primaryClient = mailboxClient([{ id: 'xiaopingguo:pool', email: 'pool@outlook.example', tokenValid: true }]);
  const icloudClient = mailboxClient([{ id: 'icloud:apple', email: 'apple@icloud.example', tokenValid: true }]);
  const config = validateV2Config(branchConfig());
  const context = {
    config,
    plan: { mailProvider: 'xiaopingguo', oauthSource: { kind: 'session_assets', assetIds: [outlook.id, icloud.id] } },
    state: { events: [] },
    assetStore: store,
    mailClient: primaryClient,
    mailAccounts: [{ id: 'xiaopingguo:pool', email: 'pool@outlook.example', tokenValid: true }],
    mailClients: { icloud: icloudClient },
  };

  const primaryJob = { id: 'job-pool', assetId: outlook.id, mailProvider: 'xiaopingguo' };
  assert.equal(await mailContextForJob(primaryJob, context), context, 'the run channel uses the run context itself');

  // An older checkpoint without the field reads the channel from the asset.
  const icloudJob = { id: 'job-apple', assetId: icloud.id };
  const view = await mailContextForJob(icloudJob, context);
  assert.equal(icloudJob.mailProvider, 'icloud');
  assert.equal(view.mailClient, icloudClient);
  assert.deepEqual(view.mailAccounts.map((account) => account.id), ['icloud:apple']);
  assert.equal(view.config.mail.provider, 'icloud');
  // Everything else is the run's own, and the run's client is untouched.
  assert.equal(view.state, context.state);
  assert.equal(context.mailClient, primaryClient);
  assert.equal(context.config.mail.provider, 'xiaopingguo');
  // Built once per channel.
  assert.equal(await mailContextForJob({ id: 'job-apple-2', mailProvider: 'icloud' }, context), view);
  assert.equal(context.state.events.filter((record) => record.type === 'mail_provider_client_ready').length, 1);
});

test('a TOTP setup cut off by a proxy handshake drop is retried and the account goes on to OAuth', async (t) => {
  // Account 8 of ui-20261003170504-fdcn2b: the password was set during
  // registration, then TOTP enrollment hit "Proxy socket closed during
  // handshake" — a dead exit, with only a generic REQUEST_FAILED code. That
  // read as a real refusal, so the account was held back from OAuth as
  // `partial` and never retried on another exit.
  const config = branchConfig(1);
  const plan = normalizeRunPlan({
    taskKind: 'register_session', postRegistrationOAuth: true, mailCount: 1, workerConcurrency: 1,
    aliasStrategy: 'root', security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-security-handshake-retry' });
  let sessionRuns = 0;
  let oauthRuns = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([{ id: 'mail-hs', email: 'handshake@example.test', tokenValid: true, bound: false }]),
    retryPolicies: { waiting_security_retry: { delaysMs: [1], maxRetries: 3 } },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        finishSession(sessionState, job);
        sessionRuns += 1;
        if (sessionRuns === 1) {
          // What the runner wrote before this was recognised as transport.
          sessionState.status = 'partial';
          sessionState.security.totpStatus = 'failed';
          sessionState.security.failures = [
            { feature: 'totp', code: 'TOTP_SETUP_FAILED', message: 'Proxy socket closed during handshake' },
          ];
          return;
        }
        sessionState.security.failures = [];
      },
    }),
    oauthRunnerFactory: () => ({
      async run(oauthState) {
        oauthRuns += 1;
        oauthState.step = 'complete';
        oauthState.status = 'complete';
        oauthState.account = { email: oauthState.email, access_token: 'cpa' };
      },
    }),
  });

  assert.equal(sessionRuns, 2);
  assert.equal(state.events.some((record) => record.type === 'security_setup_retry_scheduled'), true);
  assert.equal(oauthRuns, 1);
  assert.equal(state.jobs[0].status, 'complete');
  assert.ok(state.jobs[0].cpaPath);
});

test('a callback cut off by a proxy handshake drop goes through callback proxy recovery', async (t) => {
  // Account 42 of ui-20261003180221-7sgjfd: the account was created and the
  // callback code issued, then the callback request hit "Proxy socket closed
  // during handshake". It carried no error code, so it failed outright instead
  // of entering the created-account callback recovery.
  const config = branchConfig(1);
  config.proxyPool.required = true;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-callback-handshake' });
  const callbackUrl = 'https://auth.openai.com/api/auth/callback/openai?state=hs';
  const seen = [];
  let runnerCalls = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    retryPolicies: {
      waiting_proxy_retry: { delaysMs: [1, 1], maxRetries: 2 },
      waiting_proxy_rotation: { delaysMs: [1], maxRetries: 1, jitterRatio: 0 },
    },
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([{ id: 'mail-cb-hs', email: 'cb-hs@example.test', tokenValid: true, bound: false }]),
    proxyEntries: [
      { id: 'cb-hs-a', url: 'http://cb-hs-a:4301' },
      { id: 'cb-hs-b', url: 'http://cb-hs-b:4302' },
    ],
    proxyProbeExecutor: async (_request, probeOptions) => ({ response: { status: 200, url: probeOptions.proxy } }),
    sessionRunnerFactory: ({ job, worker }) => {
      seen.push(worker.proxyId);
      return {
        async run(sessionState) {
          runnerCalls += 1;
          if (runnerCalls === 1) {
            sessionState.accountCreated = true;
            sessionState.step = 'auth_callback_pending';
            sessionState.status = 'running';
            sessionState.pendingAuthCallbackUrl = callbackUrl;
            throw Object.assign(new Error('Proxy socket closed during handshake'), { accountCreated: true });
          }
          assert.equal(sessionState.step, 'auth_callback_pending');
          assert.equal(sessionState.pendingAuthCallbackUrl, callbackUrl);
          finishSession(sessionState, job);
        },
      };
    },
  });

  assert.equal(runnerCalls, 2);
  assert.equal(seen[0], seen[1], 'the first callback retry stays on the same exit');
  assert.equal(state.jobs[0].status, 'complete');
  assert.equal(state.jobs[0].authCallbackProxyRecovery.lastFailureCode !== undefined, true);
  assert.equal(state.events.some((record) => record.type === 'branch_job_failed'), false);
});

function oauthHandshakeRun(t, runId, failures) {
  const config = branchConfig(1);
  config.proxyPool.required = true;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', postRegistrationOAuth: true, mailCount: 1, workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId });
  const oauthCalls = [];
  const done = runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    retryPolicies: {
      waiting_proxy_retry: { delaysMs: [1, 1], maxRetries: 2 },
      waiting_proxy_rotation: { delaysMs: [1], maxRetries: 3, jitterRatio: 0 },
    },
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([{ id: `mail-${runId}`, email: `${runId}@example.test`, tokenValid: true, bound: false }]),
    proxyEntries: [
      { id: `${runId}-a`, url: 'http://oauth-hs-a:4401' },
      { id: `${runId}-b`, url: 'http://oauth-hs-b:4402' },
      { id: `${runId}-c`, url: 'http://oauth-hs-c:4403' },
    ],
    proxyProbeExecutor: async (_request, probeOptions) => ({ response: { status: 200, url: probeOptions.proxy } }),
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) { finishSession(sessionState, job); },
    }),
    oauthRunnerFactory: ({ worker }) => ({
      async run(oauthState) {
        oauthCalls.push({ proxyId: worker.proxyId, step: oauthState.step, marker: oauthState.marker || '' });
        if (oauthCalls.length <= failures) {
          // Mid-transaction: the consent page navigation is where #35 died.
          oauthState.step = 'navigating';
          oauthState.status = 'running';
          oauthState.marker = `attempt-${oauthCalls.length}`;
          throw new Error('Proxy socket closed during handshake');
        }
        oauthState.step = 'complete';
        oauthState.status = 'complete';
        oauthState.account = { email: oauthState.email, access_token: 'cpa' };
      },
    }),
  });
  return { state, oauthCalls, done };
}

test('an OAuth handshake drop is retried once on the same exit and resumes the transaction', async (t) => {
  // Account 35 of ui-20261003180221-7sgjfd died on the consent navigation
  // after its phone was verified. One retry on the same exit keeps that work.
  const { state, oauthCalls, done } = oauthHandshakeRun(t, 'oauth-hs-once', 1);
  await done;
  assert.equal(oauthCalls.length, 2);
  assert.equal(oauthCalls[0].proxyId, oauthCalls[1].proxyId, 'the first retry stays on the same exit');
  assert.equal(oauthCalls[1].marker, 'attempt-1', 'the OAuth transaction is resumed, not restarted');
  assert.equal(state.jobs[0].status, 'complete');
  assert.ok(state.jobs[0].cpaPath);
  assert.equal(state.jobs[0].oauthTransportRecovery.sameProxyRetries, 1);
  assert.equal(state.jobs[0].oauthTransportRecovery.proxyChanges, 0);
});

test('a second OAuth handshake drop changes the exit and restarts authorization once', async (t) => {
  const { state, oauthCalls, done } = oauthHandshakeRun(t, 'oauth-hs-twice', 2);
  await done;
  assert.equal(oauthCalls.length, 3);
  assert.equal(oauthCalls[0].proxyId, oauthCalls[1].proxyId);
  assert.notEqual(oauthCalls[1].proxyId, oauthCalls[2].proxyId, 'the second failure moves to a new exit');
  assert.equal(oauthCalls[2].marker, '', 'the new exit starts a fresh authorization');
  assert.equal(state.events.some((record) => record.type === 'oauth_proxy_context_restarted'), true);
  assert.equal(state.jobs[0].status, 'complete');
  assert.ok(state.jobs[0].cpaPath);
  assert.equal(state.jobs[0].oauthTransportRecovery.proxyChanges, 1);
});

test('an OAuth handshake drop after the same-exit retry and one exit change stops the job', async (t) => {
  const { state, oauthCalls, done } = oauthHandshakeRun(t, 'oauth-hs-thrice', 3);
  await done;
  assert.equal(oauthCalls.length, 3, 'no fourth attempt');
  assert.equal(state.jobs[0].status, 'failed');
  assert.equal(state.jobs[0].error.code, 'OAUTH_PROXY_RECOVERY_EXHAUSTED');
  assert.equal(state.jobs[0].sessionAssetId !== '', true, 'the saved login state is kept');
});

test('a short retry wait keeps the Worker on its account instead of starting the next one', async (t) => {
  // Live run 2026-10-10 01:04: account 3 waited two seconds for an exit retry,
  // its Worker meanwhile took another account onto account 3's exit, and
  // account 3 queued behind it and came back on a different IP.
  const config = branchConfig(1);
  config.mail.count = 2;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 2, workerConcurrency: 1, aliasStrategy: 'root',
    security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-short-wait-holds-lane' });
  const order = [];
  let firstFailed = false;
  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([
      { id: 'mail-short-a', email: 'short-a@example.test', tokenValid: true, bound: false },
      { id: 'mail-short-b', email: 'short-b@example.test', tokenValid: true, bound: false },
    ]),
    retryPolicies: { waiting_security_retry: { delaysMs: [20], maxRetries: 3 } },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        order.push(job.email);
        finishSession(sessionState, job);
        if (!firstFailed) {
          firstFailed = true;
          sessionState.status = 'partial';
          sessionState.security.totpStatus = 'failed';
          sessionState.security.failures = [{ feature: 'totp', code: 'TOTP_SETUP_FAILED', message: 'socket hang up' }];
          return;
        }
        sessionState.security.failures = [];
      },
    }),
  });

  assert.equal(state.status, 'complete');
  const first = order[0];
  assert.deepEqual(order, [first, first, order.find((email) => email !== first)], JSON.stringify(order));
  assert.equal(state.events.some((record) => record.type === 'security_setup_retry_scheduled'), true);
  assert.equal(state.events.some((record) => record.type === 'worker_lane_deferred'), false);
});

test('a security failure that is not transport-shaped is left alone', async (t) => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root',
    security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-security-not-retryable' });
  let attempts = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([{ id: 'mail-sec2', email: 'sec2@example.test', tokenValid: true, bound: false }]),
    retryPolicies: { waiting_security_retry: { delaysMs: [1], maxRetries: 3 } },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        finishSession(sessionState, job);
        attempts += 1;
        sessionState.status = 'partial';
        sessionState.security = {
          passwordStatus: 'retry_pending',
          totpStatus: 'not_requested',
          // A rejection, not a broken connection: retrying only fails again.
          failures: [{ feature: 'password', code: 'PASSWORD_REJECTED', message: 'password did not meet policy' }],
        };
      },
    }),
  });

  assert.equal(attempts, 1, 'a non-retryable security failure must not be replayed');
  assert.equal(state.jobs[0].status, 'partial');
  assert.equal(state.events.some((record) => record.type === 'security_setup_retry_scheduled'), false);
});

test('MFA enrollment re-auth requirements are resumable as security work', () => {
  const state = {
    taskKind: 'session_refresh',
    status: 'partial',
    phase: 'partial',
    completedAt: '2026-08-07T00:00:00.000Z',
    lastError: null,
    cancelPending: false,
    control: {},
    events: [],
    workers: [{ id: 'worker-reauth', status: 'idle', currentJobId: '', mailboxId: null }],
    jobs: [{
      id: 'job-reauth-required',
      assetId: 'asset-reauth-required',
      sessionAssetId: 'asset-reauth-required',
      status: 'partial',
      phase: 'partial',
      error: null,
      sessionState: {
        step: 'verified',
        status: 'partial',
        security: {
          passwordStatus: 'configured',
          totpStatus: 'failed',
          securityReauth: { status: 'required', reason: 'MFA_ENROLL_REAUTH_REQUIRED' },
          failures: [{
            feature: 'totp',
            code: 'MFA_ENROLL_REAUTH_REQUIRED',
            message: 'TOTP enrollment requires re-authentication',
          }],
        },
      },
      sms: { current: null },
    }],
  };

  assert.equal(canResumeBranchState(state), true);
  resumeBranchState(state);

  assert.equal(state.status, 'initialized');
  assert.equal(state.jobs[0].status, 'queued');
  assert.equal(state.jobs[0].phase, 'resuming_security');
  assert.equal(state.jobs[0].sessionState.security.totpStatus, 'retry_pending');
  assert.equal(state.events.at(-1).type, 'security_setup_resume_queued');
});

test('a new OTP/PW recovery task replaces a persisted stale password OTP transaction', async (t) => {
  const config = branchConfig(1);
  const store = temporaryStore(t);
  const seed = makeInitialChatGptSessionState({ email: 'security-asset-recovery@example.test' });
  const asset = store.upsert({
    email: seed.email,
    parentEmail: seed.email,
    parentMailboxId: 'mail-security-asset-recovery',
    accountId: 'account-security-asset-recovery',
    cookieJar: seed.cookieJar,
    clientProfile: seed.clientProfile,
    clientProfileFingerprint: seed.clientProfileFingerprint,
    oaiDid: seed.oaiDid,
    accessToken: 'saved-security-access-token',
    sessionToken: 'saved-security-session-token',
    status: 'partial',
    totpSecret: 'JBSWY3DPEHPK3PXP',
    security: {
      setPassword: true,
      enrollTotp: true,
      passwordStatus: 'failed',
      totpStatus: 'configured',
      passwordTransaction: {
        step: 'otp_sent',
        emailBoundary: { capturedAt: '2026-08-01T00:00:00.000Z', messageIds: ['stale-message'] },
        authorizeUrl: 'https://auth.openai.com/authorize?stale=1',
        landedUrl: 'https://auth.openai.com/email-verification',
        password: 'Gpt-stale-transaction!8a',
      },
      failures: [{ feature: 'password', code: 'PASSWORD_SETUP_FAILED' }],
    },
  });
  const plan = normalizeRunPlan({
    schemaVersion: 3,
    taskKind: 'session_refresh',
    workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: [asset.id] },
    proxyAssignments: [{ workerSlot: 1, kind: 'local', localProxyId: 'proxy-security-recovery' }],
    security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-security-asset-recovery' });
  let observedRecoveryState = null;
  let runnerCalls = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    // About the resume path, not the in-run security retry; maxRetries 0
    // keeps the job terminal at `partial` exactly as before.
    retryPolicies: { waiting_security_retry: { delaysMs: [1], maxRetries: 0 } },
    assetStore: store,
    proxyEntries: [{
      id: 'proxy-security-recovery',
      url: 'http://127.0.0.1:4101',
      workerSlots: [1],
    }],
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState, options) {
        runnerCalls += 1;
        observedRecoveryState = {
          sessionStep: sessionState.step,
          step: sessionState.security.passwordTransaction?.step,
          emailBoundary: sessionState.security.passwordTransaction?.emailBoundary,
          authorizeUrl: sessionState.security.passwordTransaction?.authorizeUrl,
          security: options.security,
        };
        if (runnerCalls === 1) {
          assert.equal(sessionState.step, 'auth_completed');
          throw Object.assign(new Error('Saved login state expired'), { code: 'SESSION_ACCESS_TOKEN_MISSING' });
        }
        sessionState.step = 'verified';
        sessionState.status = 'partial';
        sessionState.accountId = asset.accountId;
        sessionState.accessToken = asset.accessToken;
        sessionState.sessionToken = asset.sessionToken;
        sessionState.planType = 'free';
        sessionState.session = { user: { email: sessionState.email } };
        sessionState.me = { email: sessionState.email };
        sessionState.lastValidatedAt = new Date().toISOString();
        sessionState.security.passwordStatus = 'retry_pending';
        sessionState.security.totpStatus = 'configured';
        sessionState.security.failures = [{ feature: 'password', code: 'PASSWORD_SETUP_TIMEOUT' }];
        job.sessionState = sessionState;
      },
    }),
  });

  assert.deepEqual(observedRecoveryState, {
    sessionStep: 'initial',
    step: 'retry_pending',
    emailBoundary: null,
    authorizeUrl: '',
    security: { setPassword: true, enrollTotp: true },
  });
  assert.equal(state.status, 'partial');
  assert.equal(state.jobs[0].status, 'partial');
  assert.equal(state.jobs[0].phase, 'partial');
  assert.equal(state.jobs[0].result, 'session_security_partial');
  assert.equal(runnerCalls, 2);
  assert.deepEqual(
    state.events.filter((record) => record.type === 'asset_security_recovery_prepared').map((record) => record.source),
    ['saved_session', 'email_login_fallback'],
  );
});

test('ordinary session refresh revalidates a verified checkpoint and does not rebind security state', async (t) => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({
    schemaVersion: 3,
    taskKind: 'session_refresh',
    workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: ['asset-ordinary-refresh'] },
    proxyAssignments: [{ workerSlot: 1, kind: 'local', localProxyId: 'proxy-refresh-new' }],
    security: { setPassword: false, enrollTotp: false },
  }, config);
  const store = temporaryStore(t);
  const seed = makeInitialChatGptSessionState({ email: 'ordinary-refresh@example.test' });
  const asset = store.upsert({
    email: seed.email,
    accountId: 'account-ordinary-refresh',
    accessToken: 'saved-refresh-access',
    sessionToken: 'saved-refresh-session',
    cookieJar: seed.cookieJar,
    clientProfile: seed.clientProfile,
    clientProfileFingerprint: seed.clientProfileFingerprint,
    oaiDid: seed.oaiDid,
    planType: 'free',
    status: 'partial',
    sourceProxy: { id: 'proxy-refresh-old', url: 'http://127.0.0.1:4199' },
    security: {
      setPassword: true,
      enrollTotp: false,
      passwordStatus: 'retry_pending',
      passwordTransaction: { step: 'retry_pending' },
      failures: [{ feature: 'password', code: 'PASSWORD_SETUP_TIMEOUT' }],
    },
  });
  plan.oauthSource.assetIds[0] = asset.id;
  const persisted = makeInitialChatGptSessionState({
    email: asset.email,
    cookieJar: asset.cookieJar,
    clientProfile: asset.clientProfile,
    oaiDid: asset.oaiDid,
  });
  persisted.step = 'verified';
  persisted.status = 'partial';
  persisted.accountId = asset.accountId;
  persisted.accessToken = asset.accessToken;
  persisted.sessionToken = asset.sessionToken;
  persisted.planType = asset.planType;
  persisted.security = { ...asset.security };
  const state = makeInitialBranchState(config, plan, { runId: 'branch-ordinary-refresh-checkpoint' });
  state.jobs.push({
    id: 'job-ordinary-refresh-checkpoint',
    taskKind: 'session_refresh',
    email: asset.email,
    parentEmail: asset.email,
    mailboxId: '',
    laneId: asset.id,
    assetId: asset.id,
    aliasIndex: 1,
    status: 'queued',
    phase: 'queued',
    branch: 'session_refresh',
    nextRunAt: '',
    proxy: null,
    proxyId: '',
    sessionState: persisted,
    oauthState: null,
    oauthRecovery: { status: 'idle', attempts: 0, reason: '', requestedAt: '', startedAt: '', completedAt: '', lastError: null },
    accountCreatedAt: '',
    sessionAssetId: asset.id,
    cpaPath: '',
    cpaRevision: 0,
    cpaSuperseded: false,
    sms: { current: null, attempts: [], acquisition: null, acquisitions: [], costUsd: 0, replacements: 0, sendRetries: 0 },
    error: null,
    createdAt: state.createdAt,
    updatedAt: state.createdAt,
  });
  let observedOptions;
  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    // About the resume path, not the in-run security retry; maxRetries 0
    // keeps the job terminal at `partial` exactly as before.
    retryPolicies: { waiting_security_retry: { delaysMs: [1], maxRetries: 0 } },
    assetStore: store,
    proxyEntries: [{ id: 'proxy-refresh-new', url: 'http://127.0.0.1:4109', workerSlots: [1] }],
    sessionRunnerFactory: () => ({
      async run(sessionState, options) {
        observedOptions = options;
        sessionState.step = 'verified';
        sessionState.status = 'valid';
      },
    }),
  });

  assert.ok(observedOptions, JSON.stringify({ status: state.status, jobs: state.jobs, events: state.events }));
  assert.equal(observedOptions.skipVerifiedSessionRefresh, false);
  assert.equal(observedOptions.skipUsageMetadata, true);
  assert.equal(state.jobs[0].sessionState.security.proxyRebind, undefined);
  assert.equal(state.events.some((record) => record.type === 'mailbox_target_touched'), false);
});

test('ACCOUNT_DEACTIVATED marks an existing login-state asset as banned instead of an AT failure', async (t) => {
  const config = branchConfig(1);
  const store = temporaryStore(t);
  const seed = makeInitialChatGptSessionState({ email: 'deactivated-asset@example.test' });
  const asset = store.upsert({
    email: seed.email,
    accountId: 'account-deactivated-asset',
    accessToken: 'saved-deactivated-access',
    sessionToken: 'saved-deactivated-session',
    cookieJar: seed.cookieJar,
    clientProfile: seed.clientProfile,
    oaiDid: seed.oaiDid,
    planType: 'free',
    status: 'valid',
    password: 'saved-password',
    totpSecret: 'JBSWY3DPEHPK3PXP',
    health: {
      status: 'healthy',
      code: 'SESSION_VERIFIED',
      message: 'previously valid',
      httpStatus: 200,
      checkedAt: new Date().toISOString(),
      latencyMs: 0,
      lastHealthyAt: new Date().toISOString(),
    },
  });
  const plan = normalizeRunPlan({
    schemaVersion: 3,
    taskKind: 'session_refresh',
    workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: [asset.id] },
    proxyAssignments: [{ workerSlot: 1, kind: 'local', localProxyId: 'maintenance-local' }],
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-account-deactivated' });

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: store,
    proxyEntries: [{ id: 'maintenance-local', url: 'http://127.0.0.1:7890', workerSlots: [1] }],
    smsProvider: { service: 'mock', country: '151' },
    sessionRunnerFactory: () => ({
      async run() {
        throw Object.assign(new Error('The account has been deactivated'), {
          code: 'ACCOUNT_DEACTIVATED',
          status: 403,
          retryable: false,
        });
      },
    }),
  });

  const stored = store.get(asset.id);
  // A closed account is a settled answer, not a defect in the run: the job ends
  // `skipped`, so the batch still grades `complete` and the count is reported
  // rather than folded into the failure tally.
  assert.equal(state.jobs[0].status, 'skipped');
  assert.equal(state.jobs[0].error.code, 'ACCOUNT_DEACTIVATED');
  assert.equal(state.status, 'complete');
  assert.equal(summarizeBranchState(state).counts.deactivated, 1);
  assert.equal(stored.health.status, 'banned');
  assert.equal(stored.health.code, 'ACCOUNT_DEACTIVATED');
  assert.equal(stored.lastError.code, 'ACCOUNT_DEACTIVATED');
  assert.equal(state.events.some((record) => record.type === 'session_asset_marked_banned'), true);
  assert.equal(state.events.some((record) => record.type === 'branch_job_skipped'), true);
});

test('a number rejected as spent is swapped for a fresh one instead of parking the job', async (t) => {
  // Regression: chatgpt.com answers `phone_max_usage_exceeded` (HTTP 403) when
  // the provider recycles a number some other account already burned through
  // OpenAI's per-number cap. It used to fall through to
  // `waiting_phone_continuity`, which has no way back inside the run, so the
  // job sat parked while the fix was simply to buy another number.
  const config = branchConfig(1);
  config.sms.replacementBudget = 3;
  const store = temporaryStore(t);
  const seed = makeInitialChatGptSessionState({ email: 'phone-spent@example.test' });
  const asset = store.upsert({
    email: seed.email,
    parentEmail: seed.email,
    accountId: 'account-phone-spent',
    cookieJar: seed.cookieJar,
    clientProfile: seed.clientProfile,
    clientProfileFingerprint: seed.clientProfileFingerprint,
    oaiDid: seed.oaiDid,
    status: 'valid',
  });
  const plan = normalizeRunPlan({
    taskKind: 'oauth', workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: [asset.id] },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-phone-max-usage' });
  let acquireCalls = 0;
  const cancelled = [];
  const sends = [];

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: store,
    smsProvider: {
      service: 'mock', country: '151',
      async acquireNumber() {
        acquireCalls += 1;
        return {
          id: `activation-${acquireCalls}`, activationId: `activation-${acquireCalls}`,
          number: `+5691111000${acquireCalls}`, status: 'leased', cost: 0.02,
        };
      },
      async markSmsSent(lease) { return { ...lease, status: 'waiting' }; },
      async pollCode() { return { code: '123456', status: 'received' }; },
      async complete(lease) { return { ...lease, status: 'complete' }; },
      async cancel(lease) { cancelled.push(lease.activationId); return { ...lease, status: 'cancelled' }; },
      async requestAnotherCode(lease) { return lease; },
    },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) { finishSession(sessionState, job); },
    }),
    oauthRunnerFactory: () => ({
      async run(oauthState) {
        if (oauthState.step === 'initial') oauthState.step = 'phone_required';
        else if (oauthState.step === 'navigating') {
          oauthState.step = 'complete';
          oauthState.status = 'complete';
          oauthState.account = { email: oauthState.email, access_token: 'phone-spent-cpa' };
        }
      },
      async sendPhone(oauthState, phone) {
        sends.push(phone);
        if (sends.length === 1) {
          throw Object.assign(new Error('oauth_phone_send failed with HTTP 403: phone_max_usage_exceeded'), {
            code: 'PHONE_MAX_USAGE_EXCEEDED', status: 403,
          });
        }
        oauthState.step = 'phone_otp_sent';
      },
      async validatePhone(oauthState) { oauthState.step = 'navigating'; },
    }),
  });

  assert.equal(state.status, 'complete');
  // The spent number was released and a second one bought, rather than parking.
  assert.equal(acquireCalls, 2);
  assert.deepEqual(cancelled, ['activation-1']);
  assert.equal(state.jobs[0].sms.replacements, 1);
  assert.equal(state.jobs[0].phase, 'complete');
  const replacement = state.events.find((record) => record.type === 'sms_number_replacement');
  assert.match(String(replacement?.message || ''), /phone_max_usage_exceeded/);
});

test('the 21st OAuth phone failure cools down the source login-state asset', async (t) => {
  const config = branchConfig(1);
  config.sms.replacementBudget = 20;
  const store = temporaryStore(t);
  const seed = makeInitialChatGptSessionState({ email: 'oauth-phone-budget-exhausted@example.test' });
  const asset = store.upsert({
    email: seed.email,
    parentEmail: seed.email,
    accountId: 'account-oauth-phone-budget-exhausted',
    cookieJar: seed.cookieJar,
    clientProfile: seed.clientProfile,
    clientProfileFingerprint: seed.clientProfileFingerprint,
    oaiDid: seed.oaiDid,
    status: 'valid',
  });
  const plan = normalizeRunPlan({
    taskKind: 'oauth', workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: [asset.id] },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-oauth-phone-budget-exhausted' });
  let acquireCalls = 0;
  let sendCalls = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: store,
    smsProvider: {
      service: 'mock', country: '151',
      async acquireNumber() {
        acquireCalls += 1;
        return {
          id: `activation-budget-${acquireCalls}`,
          activationId: `activation-budget-${acquireCalls}`,
          number: `+5692222000${String(acquireCalls).padStart(2, '0')}`,
          status: 'leased',
          cost: 0.02,
        };
      },
      async cancel(lease) { return { ...lease, status: 'cancelled' }; },
    },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) { finishSession(sessionState, job); },
    }),
    oauthRunnerFactory: () => ({
      async run(oauthState) {
        if (oauthState.step === 'initial') oauthState.step = 'phone_required';
      },
      async sendPhone() {
        sendCalls += 1;
        throw Object.assign(new Error('oauth_phone_send failed with HTTP 403: phone_max_usage_exceeded'), {
          code: 'PHONE_MAX_USAGE_EXCEEDED', status: 403,
        });
      },
    }),
  });

  const job = state.jobs[0];
  const stored = store.get(asset.id);
  assert.equal(state.status, 'failed');
  assert.equal(job.status, 'failed');
  assert.equal(job.sms.replacements, 21);
  assert.equal(acquireCalls, 21);
  assert.equal(sendCalls, 21);
  assert.equal(job.error.code, 'OAUTH_PHONE_REPLACEMENT_BUDGET_EXHAUSTED');
  assert.match(job.error.message, /OAuth phone attempt budget exhausted/);
  assert.equal(job.error.causeCode, 'PHONE_MAX_USAGE_EXCEEDED');
  assert.match(job.error.causeMessage, /phone_max_usage_exceeded/);
  assert.equal(job.error.phoneAttempts, 21);
  assert.equal(job.error.phoneReplacementBudget, 20);
  assert.equal(stored.oauthCooldown.failureCount, 21);
  assert.equal(Date.parse(stored.oauthCooldown.until) > Date.now(), true);
  assert.equal(state.events.some((record) => record.type === 'session_asset_oauth_cooldown_set'), true);
});

test('a register-then-OAuth run cools the asset down when the phone budget is spent', async (t) => {
  // The cooldown used to be gated on `taskKind === 'oauth'`, so a registration
  // run that continued into OAuth burned all 21 numbers and still wrote the
  // asset back uncooled — the next OAuth task picked the same account up and
  // spent another budget on it.
  const config = branchConfig(1);
  config.sms.replacementBudget = 20;
  const store = temporaryStore(t);
  const plan = normalizeRunPlan({
    taskKind: 'register_session', postRegistrationOAuth: true, mailCount: 1, workerConcurrency: 1,
    aliasStrategy: 'root', aliasCount: 1, aliasMaxAttempts: 1,
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-register-oauth-budget' });
  let acquireCalls = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: store,
    mailClient: mailboxClient([{ id: 'mail-budget', email: 'register-oauth-budget@example.test', tokenValid: true, bound: false }]),
    smsProvider: {
      service: 'mock', country: '151',
      async acquireNumber() {
        acquireCalls += 1;
        return {
          id: `activation-reg-${acquireCalls}`,
          activationId: `activation-reg-${acquireCalls}`,
          number: `+5692222100${String(acquireCalls).padStart(2, '0')}`,
          status: 'leased',
          cost: 0.02,
        };
      },
      async cancel(lease) { return { ...lease, status: 'cancelled' }; },
    },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) { finishSession(sessionState, job); },
    }),
    oauthRunnerFactory: () => ({
      async run(oauthState) {
        if (oauthState.step === 'initial') oauthState.step = 'phone_required';
      },
      async sendPhone() {
        throw Object.assign(new Error('oauth_phone_send failed with HTTP 403: phone_max_usage_exceeded'), {
          code: 'PHONE_MAX_USAGE_EXCEEDED', status: 403,
        });
      },
    }),
  });

  const job = state.jobs[0];
  assert.equal(job.error.code, 'OAUTH_PHONE_REPLACEMENT_BUDGET_EXHAUSTED');
  assert.equal(job.sms.replacements, 21);
  const stored = store.get(job.sessionAssetId);
  assert.equal(stored.oauthCooldown.failureCount, 21);
  assert.equal(stored.oauthCooldown.reason, 'oauth_failure_budget_exhausted');
  assert.equal(Date.parse(stored.oauthCooldown.until) > Date.now(), true);
  assert.equal(state.events.some((record) => record.type === 'session_asset_oauth_cooldown_set'), true);
});

test('an OAuth phone-send rate limit cancels an unsent lease and fails the job', async (t) => {
  const config = branchConfig(1);
  const store = temporaryStore(t);
  const seed = makeInitialChatGptSessionState({ email: 'oauth-phone-rate-limit@example.test' });
  const asset = store.upsert({
    email: seed.email,
    parentEmail: seed.email,
    accountId: 'account-oauth-phone-rate-limit',
    accessToken: 'access-oauth-phone-rate-limit',
    sessionToken: 'session-oauth-phone-rate-limit',
    cookieJar: seed.cookieJar,
    clientProfile: seed.clientProfile,
    clientProfileFingerprint: seed.clientProfileFingerprint,
    oaiDid: seed.oaiDid,
    status: 'valid',
  });
  const plan = normalizeRunPlan({
    taskKind: 'oauth', workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: [asset.id] },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-oauth-phone-rate-limit' });
  let cancelCalls = 0;
  let sendCalls = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: store,
    smsProvider: {
      service: 'mock', country: '151',
      async acquireNumber() {
        return {
          id: 'activation-oauth-rate-limit',
          activationId: 'activation-oauth-rate-limit',
          number: '+56912345000',
          status: 'leased',
          cost: 0.02,
        };
      },
      async cancel(lease) {
        cancelCalls += 1;
        return { ...lease, status: 'cancelled' };
      },
    },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) { finishSession(sessionState, job); },
    }),
    oauthRunnerFactory: () => ({
      async run(oauthState) {
        if (oauthState.step === 'initial') oauthState.step = 'phone_required';
      },
      async sendPhone() {
        sendCalls += 1;
        throw Object.assign(new Error('oauth_phone_send failed with HTTP 400: rate_limit_exceeded'), {
          code: 'RATE_LIMIT_EXCEEDED',
          status: 400,
        });
      },
    }),
  });

  const job = state.jobs[0];
  assert.equal(sendCalls, 1);
  assert.equal(cancelCalls, 1);
  assert.equal(job.status, 'failed');
  assert.equal(job.phase, 'failed');
  assert.equal(job.nextRunAt, '');
  assert.equal(job.sms.current, null);
  assert.equal(job.sms.attempts[0].status, 'cancelled');
  assert.equal(job.sms.attempts[0].cleanupReason, 'RATE_LIMIT_EXCEEDED');
  assert.equal(job.error.code, 'RATE_LIMIT_EXCEEDED');
  assert.equal(job.error.oauthCooldown, true);
  const stored = store.get(asset.id);
  assert.equal(stored.oauthCooldown.reason, 'oauth_rate_limit_exceeded');
  assert.equal(stored.oauthCooldown.failureCount, 1);
  assert.equal(
    Date.parse(stored.oauthCooldown.until) - Date.parse(stored.oauthCooldown.setAt),
    60 * 60 * 1000,
  );
  assert.equal(state.events.some((record) => record.type === 'oauth_phone_send_rate_limited_before_delivery'), true);
  assert.equal(state.events.some((record) => (
    record.type === 'session_asset_oauth_cooldown_set'
    && record.reason === 'oauth_rate_limit_exceeded'
  )), true);
  assert.equal(state.events.some((record) => record.type === 'branch_job_waiting'), false);
});

test('a persisted OAuth phone-send rate limit is cleaned before any resumed send', async (t) => {
  const config = branchConfig(1);
  const store = temporaryStore(t);
  const seed = makeInitialChatGptSessionState({ email: 'oauth-phone-rate-limit-resume@example.test' });
  const asset = store.upsert({
    email: seed.email,
    parentEmail: seed.email,
    accountId: 'account-oauth-phone-rate-limit-resume',
    accessToken: 'access-oauth-phone-rate-limit-resume',
    sessionToken: 'session-oauth-phone-rate-limit-resume',
    cookieJar: seed.cookieJar,
    clientProfile: seed.clientProfile,
    clientProfileFingerprint: seed.clientProfileFingerprint,
    oaiDid: seed.oaiDid,
    status: 'valid',
  });
  const plan = normalizeRunPlan({
    taskKind: 'oauth', workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: [asset.id] },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-oauth-phone-rate-limit-resume' });
  let acquireCalls = 0;
  let cancelCalls = 0;
  let sendCalls = 0;

  const options = {
    assetStore: store,
    retryPolicies: { waiting_phone_continuity: { delaysMs: [1], maxRetries: 0 } },
    smsProvider: {
      service: 'mock', country: '151',
      async acquireNumber() {
        acquireCalls += 1;
        return {
          id: 'activation-oauth-rate-limit-resume',
          activationId: 'activation-oauth-rate-limit-resume',
          number: '+56912345001',
          status: 'leased',
          cost: 0.02,
        };
      },
      async cancel(lease) {
        cancelCalls += 1;
        return { ...lease, status: 'cancelled' };
      },
    },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) { finishSession(sessionState, job); },
    }),
    oauthRunnerFactory: () => ({
      async run(oauthState) {
        if (oauthState.step === 'initial') oauthState.step = 'phone_required';
      },
      async sendPhone() {
        sendCalls += 1;
        if (sendCalls === 1) {
          throw Object.assign(new Error('phone send outcome was not persisted yet'), {
            code: 'PHONE_SEND_UNCERTAIN',
            status: 400,
          });
        }
        throw new Error('resumed OAuth phone send must not run');
      },
    }),
  };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, options);
  assert.equal(state.status, 'waiting');
  assert.equal(state.jobs[0].status, 'waiting');
  assert.equal(sendCalls, 1);
  assert.equal(acquireCalls, 1);
  assert.equal(state.jobs[0].sms.current.effect.kind, 'target_phone_send');

  state.jobs[0].error = {
    code: 'RATE_LIMIT_EXCEEDED',
    status: 400,
    message: 'oauth_phone_send failed with HTTP 400: rate_limit_exceeded',
    phonePhase: 'waiting_phone_continuity',
    preserveSms: true,
  };
  const waitingEventsBeforeResume = state.events.filter((record) => record.type === 'branch_job_waiting').length;
  resumeBranchState(state, { now: () => Date.parse('2026-09-13T10:00:00.000Z') });
  await runBranchOrchestrator({ log: { entries: [] } }, state, config, options);

  const job = state.jobs[0];
  assert.equal(sendCalls, 1);
  assert.equal(cancelCalls, 1);
  assert.equal(job.status, 'failed');
  assert.equal(job.phase, 'failed');
  assert.equal(job.sms.current, null);
  assert.equal(job.sms.attempts[0].status, 'cancelled');
  assert.equal(job.error.oauthCooldown, true);
  assert.equal(store.get(asset.id).oauthCooldown.reason, 'oauth_rate_limit_exceeded');
  assert.equal(state.events.filter((record) => record.type === 'branch_job_waiting').length, waitingEventsBeforeResume);
  assert.equal(state.events.filter((record) => record.type === 'oauth_phone_send_rate_limited_before_delivery').length, 1);
});

test('OAuth rebuilds after an ambiguous phone validation and replaces the old number', async (t) => {
  const config = branchConfig(1);
  const store = temporaryStore(t);
  const seed = makeInitialChatGptSessionState({ email: 'phone-park@example.test' });
  const asset = store.upsert({
    email: seed.email,
    parentEmail: seed.email,
    accountId: 'account-phone-park',
    cookieJar: seed.cookieJar,
    clientProfile: seed.clientProfile,
    clientProfileFingerprint: seed.clientProfileFingerprint,
    oaiDid: seed.oaiDid,
    status: 'valid',
  });
  const plan = normalizeRunPlan({
    taskKind: 'oauth', workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: [asset.id] },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-phone-park-retry' });
  let validateCalls = 0;
  let acquireCalls = 0;
  let cancelCalls = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: store,
    // A one-tick ladder: the point is that a retry is booked at all, not how
    // long the real ladder waits.
    retryPolicies: { waiting_phone_confirmation: { delaysMs: [1], maxRetries: 2 } },
    smsProvider: {
      service: 'mock', country: '151',
      async acquireNumber() {
        acquireCalls += 1;
        return { id: 'activation-park', activationId: 'activation-park', number: '+56912340000', status: 'leased', cost: 0.02 };
      },
      async markSmsSent(lease) { return { ...lease, status: 'waiting' }; },
      async pollCode() { return { code: '123456', status: 'received' }; },
      async complete(lease) { return { ...lease, status: 'complete' }; },
      async cancel(lease) { cancelCalls += 1; return { ...lease, status: 'cancelled' }; },
      async requestAnotherCode(lease) { return lease; },
    },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) { finishSession(sessionState, job); },
    }),
    oauthRunnerFactory: () => ({
      async run(oauthState) {
        if (oauthState.step === 'initial') oauthState.step = 'phone_required';
        else if (oauthState.step === 'navigating') {
          oauthState.step = 'complete';
          oauthState.status = 'complete';
          oauthState.account = { email: oauthState.email, access_token: 'phone-park-cpa' };
        }
      },
      async sendPhone(oauthState) { oauthState.step = 'phone_otp_sent'; },
      async validatePhone(oauthState) {
        validateCalls += 1;
        // The first OAuth transaction loses the validation response. The
        // rebuilt transaction still asks for a phone, and its validation gets
        // through after the old activation has been cancelled.
        if (validateCalls === 1) throw Object.assign(new Error('validation response was lost'), { code: 'ECONNRESET' });
        oauthState.step = 'navigating';
      },
    }),
  });

  assert.equal(state.status, 'complete');
  assert.equal(acquireCalls, 2);
  assert.equal(cancelCalls, 1);
  assert.equal(validateCalls, 2);
  assert.equal(state.jobs[0].sms.attempts[0].status, 'cancelled');
  assert.equal(state.jobs[0].sms.attempts.at(-1).status, 'complete');
  assert.equal(state.jobs[0].oauthPhoneValidationRecovery.status, 'complete');
  assert.equal(state.jobs[0].oauthPhoneValidationRecovery.outcome, 'replacement_phone_accepted');
});

test('the login state records which pool and exit registered it, and the promo check reuses that exit', async (t) => {
  // Later upkeep needs to know where an account came from, and the promo call
  // right after registration must not answer from a different IP than the one
  // the account was just built on.
  const config = branchConfig(1);
  const store = temporaryStore(t);
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 1, workerConcurrency: 1,
    aliasStrategy: 'root', aliasCount: 1, aliasMaxAttempts: 1,
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-source-exit' });
  const trialProxies = [];

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: store,
    mailClient: mailboxClient([{ id: 'mail-exit', email: 'exit@example.test', tokenValid: true, bound: false }]),
    proxyEntries: [{
      id: 'proxy-gb-1',
      url: 'socks5://user:secret@162.128.157.89:7279',
      protocol: 'socks5',
      workerSlots: [1],
      resourceKind: 'countryPool',
      countryCode: 'GB',
    }],
    smsProvider: { service: 'mock', country: '151' },
    trialChecker: async (_asset, options) => {
      trialProxies.push(String(options?.proxy || ''));
      return {
        status: 'none', code: 'TRIAL_UNAVAILABLE', message: 'no promo', httpStatus: 200,
        checkedAt: new Date().toISOString(), latencyMs: 3, campaigns: [],
      };
    },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) { finishSession(sessionState, job); },
    }),
  });

  assert.equal(state.status, 'complete');
  const stored = store.get(store.list()[0].id);
  assert.equal(stored.sourceProxy.countryCode, 'GB');
  assert.equal(stored.sourceProxy.endpoint, '162.128.157.89:7279');
  assert.equal(stored.sourceProxy.protocol, 'socks5');
  assert.equal(stored.sourceProxy.resourceKind, 'countryPool');
  // The promo check went out through the registration exit, not a fixed local one.
  assert.deepEqual(trialProxies, ['socks5://user:secret@162.128.157.89:7279']);

  // The browser-facing summary keeps the endpoint but never the credentials.
  const summary = store.list()[0];
  assert.equal(summary.sourceProxy.endpoint, '162.128.157.89:7279');
  assert.equal(summary.sourceProxy.countryCode, 'GB');
  assert.equal(JSON.stringify(summary).includes('secret'), false);
});

test('a Worker still probing its exit does not hold up one that already bound', async (t) => {
  // Binding used to be a barrier: the whole batch was awaited before any job
  // started, so a Worker walking a run of dead exits — each costing a full
  // health-check timeout — kept every other Worker sitting on a leased proxy.
  const config = branchConfig(2);
  config.mail.count = 2;
  config.aliases.strategy = 'root';
  config.aliases.count = 1;
  config.aliases.maxAttempts = 1;
  config.proxyPool.healthCheck = { enabled: true, probeUrl: 'https://auth.openai.com/', timeoutMs: 5000 };
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 2, workerConcurrency: 2,
    aliasStrategy: 'root', aliasCount: 1, aliasMaxAttempts: 1,
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-bind-no-barrier' });

  let releaseSlowProbe;
  const slowProbe = new Promise((resolve) => { releaseSlowProbe = resolve; });
  const order = [];

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([
      { id: 'mail-fast', email: 'fast@example.test', tokenValid: true, bound: false },
      { id: 'mail-slow', email: 'slow@example.test', tokenValid: true, bound: false },
    ]),
    proxyEntries: [
      { id: 'exit-fast', url: 'http://exit-fast:4101', workerSlots: [1] },
      { id: 'exit-slow', url: 'http://exit-slow:4102', workerSlots: [2] },
    ],
    proxyProbeExecutor: async (_request, probeOptions) => {
      // Worker 2's exit takes as long as a real dead candidate would.
      if (String(probeOptions.proxy).includes('exit-slow')) await slowProbe;
      return { response: { status: 200, url: probeOptions.proxy } };
    },
    smsProvider: { service: 'mock', country: '151' },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        order.push(`run:${job.email}`);
        // The fast lane reaching its job is the proof; only then is the slow
        // probe allowed to finish.
        if (job.email === 'fast@example.test') releaseSlowProbe();
        finishSession(sessionState, job);
      },
    }),
  });

  assert.equal(state.status, 'complete');
  // The fast Worker ran while the slow one was still inside its health check.
  assert.equal(order[0], 'run:fast@example.test');
  assert.equal(order.includes('run:slow@example.test'), true);
  assert.deepEqual(state.jobs.map((job) => job.status), ['complete', 'complete']);
});

test('the registration exit is written once and survives every later save', async (t) => {
  // The field answers "where was this account made", so a refresh through the
  // local forwarder must not rewrite it to 127.0.0.1.
  const config = branchConfig(1);
  const store = temporaryStore(t);
  const registerPlan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 1, workerConcurrency: 1,
    aliasStrategy: 'root', aliasCount: 1, aliasMaxAttempts: 1,
  }, config);
  const registerState = makeInitialBranchState(config, registerPlan, { runId: 'branch-exit-sticky-register' });

  await runBranchOrchestrator({ log: { entries: [] } }, registerState, config, {
    assetStore: store,
    mailClient: mailboxClient([{ id: 'mail-sticky', email: 'sticky@example.test', tokenValid: true, bound: false }]),
    proxyEntries: [{
      id: 'proxy-gb', url: 'socks5://162.128.157.89:7279', protocol: 'socks5',
      workerSlots: [1], resourceKind: 'countryPool', countryCode: 'GB',
    }],
    smsProvider: { service: 'mock', country: '151' },
    trialChecker: async () => ({ status: 'none', code: 'TRIAL_UNAVAILABLE', message: 'none', httpStatus: 200, checkedAt: new Date().toISOString(), latencyMs: 1, campaigns: [] }),
    sessionRunnerFactory: ({ job }) => ({ async run(sessionState) { finishSession(sessionState, job); } }),
  });

  const assetId = store.list()[0].id;
  assert.equal(store.get(assetId).sourceProxy.endpoint, '162.128.157.89:7279');
  assert.equal(store.get(assetId).sourceProxy.countryCode, 'GB');

  // Now refresh the same login state through the local forwarder.
  const refreshPlan = normalizeRunPlan({
    taskKind: 'session_refresh', workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: [assetId] },
  }, config);
  const refreshState = makeInitialBranchState(config, refreshPlan, { runId: 'branch-exit-sticky-refresh' });

  await runBranchOrchestrator({ log: { entries: [] } }, refreshState, config, {
    assetStore: store,
    proxyEntries: [{
      id: 'maintenance-local', url: 'http://127.0.0.1:7890', protocol: 'http',
      workerSlots: [1], resourceKind: 'maintenance',
    }],
    smsProvider: { service: 'mock', country: '151' },
    sessionRunnerFactory: ({ job }) => ({ async run(sessionState) { finishSession(sessionState, job); } }),
  });

  const after = store.get(assetId);
  assert.equal(after.sourceProxy.endpoint, '162.128.157.89:7279', 'the refresh exit must not overwrite the registration exit');
  assert.equal(after.sourceProxy.countryCode, 'GB');
  assert.equal(after.sourceProxy.resourceKind, 'countryPool');
});

test('every Worker can share the maintenance forwarder at the same time', async (t) => {
  // The local forwarder is one process on the host, not a residential exit, so
  // the one-Worker-per-endpoint rule that keeps two registrations off the same
  // IP must not apply to it — otherwise concurrent OAuth top-up from the
  // login-state page binds Worker 1 and strands every other Worker.
  const config = branchConfig(3);
  config.proxyPool.required = true;
  config.mail.count = 3;
  config.aliases.strategy = 'root';
  config.aliases.count = 1;
  config.aliases.maxAttempts = 1;
  const store = temporaryStore(t);
  const assets = ['one', 'two', 'three'].map((name) => {
    const seed = makeInitialChatGptSessionState({ email: `${name}@example.test` });
    return store.upsert({
      email: seed.email, parentEmail: seed.email, accountId: `account-${name}`,
      cookieJar: seed.cookieJar, clientProfile: seed.clientProfile,
      clientProfileFingerprint: seed.clientProfileFingerprint, oaiDid: seed.oaiDid, status: 'valid',
    });
  });
  const plan = normalizeRunPlan({
    taskKind: 'oauth', workerConcurrency: 3,
    oauthSource: { kind: 'session_assets', assetIds: assets.map((asset) => asset.id) },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-shared-forwarder' });

  const boundBy = new Set();
  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: store,
    // Exactly what run-manager synthesises for a maintenance lane: one entry,
    // every Worker slot.
    proxyEntries: [{
      id: 'maintenance-local',
      url: 'http://127.0.0.1:7890',
      protocol: 'http',
      workerSlots: [1, 2, 3],
      resourceKind: 'maintenance',
    }],
    // A shared forwarder must not be retired because auth.openai.com returned
    // a Cloudflare interstitial during a generic health probe.
    proxyProbeExecutor: async (_request, probeOptions) => ({
      response: { status: 403, text: '<title>Just a moment...</title>', url: probeOptions.proxy },
    }),
    smsProvider: { service: 'mock', country: '151' },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) { finishSession(sessionState, job); },
    }),
    oauthRunnerFactory: ({ worker }) => ({
      async run(oauthState) {
        boundBy.add(worker.proxyId);
        oauthState.step = 'complete';
        oauthState.status = 'complete';
        oauthState.account = { email: oauthState.email, access_token: `cpa-${oauthState.email}` };
      },
    }),
  });

  const parked = state.jobs.filter((job) => job.status === 'waiting');
  assert.deepEqual(parked.map((job) => `${job.email} ${job.phase} ${job.error?.code || ''}`), [], 'no Worker may be stranded without an exit');
  assert.equal(state.status, 'complete');
  assert.deepEqual(state.jobs.map((job) => job.status), ['complete', 'complete', 'complete']);
  assert.deepEqual([...boundBy], ['maintenance-local'], 'all three ran through the one forwarder');
  assert.equal(state.events.some((event) => event.type === 'worker_proxy_rejected'), false);
  // The forwarder is intentionally not probed, so the bind itself records
  // that it is shared.
  assert.equal(state.events.filter((event) => event.type === 'worker_proxy_bound' && event.shared === true).length, 3);
});

test('a legacy maintenance snapshot without resource metadata still uses the forwarder', async (t) => {
  const config = branchConfig(1);
  config.proxyPool.required = true;
  config.proxyPool.maintenanceProxy = 'http://127.0.0.1:7890';
  config.mail.count = 1;
  config.aliases.strategy = 'root';
  config.aliases.count = 1;
  config.aliases.maxAttempts = 1;
  const store = temporaryStore(t);
  const seed = makeInitialChatGptSessionState({ email: 'legacy-maintenance@example.test' });
  const asset = store.upsert({
    email: seed.email,
    parentEmail: seed.email,
    accountId: 'account-legacy-maintenance',
    cookieJar: seed.cookieJar,
    clientProfile: seed.clientProfile,
    clientProfileFingerprint: seed.clientProfileFingerprint,
    oaiDid: seed.oaiDid,
    status: 'valid',
  });
  const plan = normalizeRunPlan({
    taskKind: 'oauth',
    workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: [asset.id] },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-legacy-maintenance' });

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: store,
    // This is the shape written by an older checkpoint: the URL is present,
    // but resourceKind was not persisted yet.
    proxyEntries: [{
      id: 'legacy-maintenance',
      url: 'http://127.0.0.1:7890',
      protocol: 'http',
      workerSlots: [1],
    }],
    proxyProbeExecutor: async (_request, probeOptions) => ({
      response: { status: 403, text: '<title>Just a moment...</title>', url: probeOptions.proxy },
    }),
    smsProvider: { service: 'mock', country: '151' },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) { finishSession(sessionState, job); },
    }),
    oauthRunnerFactory: () => ({
      async run(oauthState) {
        oauthState.step = 'complete';
        oauthState.status = 'complete';
        oauthState.account = { email: oauthState.email, access_token: 'legacy-maintenance-cpa' };
      },
    }),
  });

  assert.equal(state.status, 'complete');
  assert.equal(state.jobs[0].status, 'complete');
  assert.equal(state.events.some((event) => event.type === 'worker_proxy_rejected'), false);
  assert.equal(state.events.filter((event) => event.type === 'worker_proxy_bound' && event.shared === true).length, 1);
});

/** A registration config wired to the rented-mailbox channel. */
function rentalConfig(workers = 1, aliasCount = 2) {
  const config = branchConfig(workers);
  config.mail = { ...config.mail, provider: 'smsbower', service: 'dr', domain: 'gmail.com', maxPrice: 0.2, apiKey: 'mail-key' };
  config.aliases = { ...config.aliases, strategy: 'root', count: aliasCount, maxAttempts: aliasCount, plusAddressingEnabled: true };
  return config;
}

/** Minimal rental client: records the lifecycle calls a run makes. */
function rentalMailClient(options = {}) {
  const calls = [];
  let issued = 0;
  let requests = 0;
  let activeRequests = 0;
  let maxActiveRequests = 0;
  const rentals = new Map();
  return {
    calls,
    rentals,
    get requests() { return requests; },
    get maxActiveRequests() { return maxActiveRequests; },
    async rentMailbox() {
      requests += 1;
      activeRequests += 1;
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
      try {
        if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, Number(options.delayMs)));
        if (options.soldOutRequests !== undefined && requests <= options.soldOutRequests) {
          throw Object.assign(new Error('smsbower mail getActivation failed: No mails yet'), { soldOut: true });
        }
        if (options.soldOutAfter !== undefined && issued >= options.soldOutAfter) {
          throw Object.assign(new Error('smsbower mail getActivation failed: No mails yet'), { soldOut: true });
        }
        if (options.insufficientBalanceAfter !== undefined && issued >= options.insufficientBalanceAfter) {
          throw Object.assign(new Error('smsbower mail getActivation failed: insufficient balance'), {
            insufficientBalance: true,
          });
        }
        issued += 1;
        const id = `mail-${issued}`;
        rentals.set(id, { id, settled: false });
        calls.push(`rent:${id}`);
        return { id, email: `rented${issued}@gmail.com`, quotedPrice: 0.14 };
      } finally {
        activeRequests -= 1;
      }
    },
    async listAccounts() {
      return [...rentals.values()].filter((rental) => !rental.settled)
        .map((rental) => ({ id: rental.id, email: `rented${rental.id.split('-')[1]}@gmail.com`, tokenValid: true, bound: false }));
    },
    async snapshotMailbox() { return { messageIds: [], capturedAt: new Date().toISOString() }; },
    async findVerificationCode() { return { code: '123456', messageId: `m${calls.length}`, source: 'smsbower_mail' }; },
    async settleMailbox(id) { rentals.get(id).settled = true; calls.push(`settle:${id}`); return true; },
    async cancelMailbox(id) { rentals.get(id).settled = true; calls.push(`cancel:${id}`); return true; },
    async reserveMailbox() { return true; },
    async releaseMailbox() { return true; },
    async markBound() { return true; },
  };
}

test('hang-rental uses one broker poll and claims the configured batch when a Worker is free', async (t) => {
  const config = rentalConfig(4, 1);
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailProvider: 'smsbower',
    mailRentalWatch: true,
    mailRentalTarget: 25,
    mailRentalBatchSize: 20,
    mailRentalPollIntervalMs: 20_000,
    mailCount: 25,
    workerConcurrency: 4,
    aliasStrategy: 'root',
    security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-rental-watch-batches' });
  const mail = rentalMailClient({ delayMs: 5 });
  let priceRestsCalls = 0;
  mail.priceRests = async () => {
    priceRestsCalls += 1;
    return { service: 'dr', domain: 'gmail.com', price: 0.14, count: 25 };
  };
  let clock = Date.now();

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    now: () => clock,
    sleep: async (milliseconds) => { clock += Math.max(20_000, Number(milliseconds) || 0); },
    smsProvider: { service: 'mock', country: '151' },
    onCheckpoint: async ({ reasons, state: checkpoint }) => {
      if (reasons.includes('mail_rental_watch_batch_claimed')) checkpoint.mailRentalWatch.stopRequested = true;
    },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) { finishSession(sessionState, job); },
    }),
  });

  const polls = state.events.filter((record) => record.type === 'mail_rental_watch_polled');
  const rents = mail.calls.filter((call) => call.startsWith('rent:'));
  assert.equal(state.status, 'complete');
  assert.equal(priceRestsCalls, 1, 'the broker polls once per interval, not once per Worker');
  assert.deepEqual(polls.map((record) => record.batch), [20]);
  assert.equal(polls.every((record) => record.batch <= 20), true);
  assert.equal(polls.every((record) => record.availableWorkers <= 4), true);
  assert.equal(rents.length, 20);
  assert.equal(mail.maxActiveRequests, 7, 'one broker batch stays within the seven-claim cap');
  assert.equal(state.mailboxes.length, 20);
  assert.equal(state.mailRentalWatch.claimedCount, 20);
  assert.equal(state.mailRentalWatch.claimConcurrency, 7);
  assert.equal(state.events.filter((record) => record.type === 'mail_rental_unavailable').length, 0);
  assert.deepEqual(state.events.filter((record) => record.type === 'mail_rental_watch_batch_result').map((record) => record.claimed), [20]);
  assert.equal(state.mailRentalWatch.stopRequested, true);
  assert.equal(state.mailRentalWatch.autoStopped, false);
  assert.equal(state.mailRentalWatch.pollIntervalMs, 20_000);
});

test('a hang-rental round that starts on an empty shelf waits for a restock instead of finishing', async (t) => {
  const config = rentalConfig(2, 1);
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailProvider: 'smsbower',
    mailRentalWatch: true,
    mailRentalTarget: 25,
    mailRentalBatchSize: 20,
    mailRentalPollIntervalMs: 20_000,
    mailCount: 25,
    workerConcurrency: 2,
    aliasStrategy: 'root',
    security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-rental-watch-restock' });
  const mail = rentalMailClient();
  // Empty for the first four polls, then the provider restocks.
  let polls = 0;
  mail.priceRests = async () => {
    polls += 1;
    return { service: 'dr', domain: 'gmail.com', price: 0.14, count: polls <= 4 ? 0 : 2 };
  };
  let clock = Date.now();

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    now: () => clock,
    sleep: async (milliseconds) => { clock += Math.max(20_000, Number(milliseconds) || 0); },
    smsProvider: { service: 'mock', country: '151' },
    onCheckpoint: async ({ reasons, state: checkpoint }) => {
      // Two are enough to prove the round survived the empty stretch.
      if (reasons.includes('mail_rental_watch_batch_claimed')) checkpoint.mailRentalWatch.stopRequested = true;
    },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) { finishSession(sessionState, job); },
    }),
  });

  // An empty shelf at launch is not an empty round: the broker kept polling,
  // and the restock four polls later was claimed and registered.
  const polled = state.events.filter((record) => record.type === 'mail_rental_watch_polled');
  assert.ok(polled.length >= 5, `expected the broker to keep polling, saw ${polled.length}`);
  assert.deepEqual(polled.slice(0, 4).map((record) => record.batch), [0, 0, 0, 0]);
  assert.equal(state.mailboxes.length, 2);
  assert.equal(state.mailRentalWatch.claimedCount, 2);
  assert.equal(state.events.filter((record) => record.type === 'mail_rental_watch_stock_exhausted').length, 0);
  assert.equal(['complete', 'partial'].includes(state.status), true, state.status);
});

test('a hang-rental round finishes with what it holds when the provider stays empty', async (t) => {
  const config = rentalConfig(2, 1);
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailProvider: 'smsbower',
    mailRentalWatch: true,
    mailRentalTarget: 25,
    mailRentalBatchSize: 20,
    mailRentalPollIntervalMs: 20_000,
    mailCount: 25,
    workerConcurrency: 2,
    aliasStrategy: 'root',
    security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-rental-watch-starved' });
  // Three in stock, then the provider dries up for good.
  const mail = rentalMailClient({ soldOutAfter: 3 });
  let polls = 0;
  mail.priceRests = async () => {
    polls += 1;
    return { service: 'dr', domain: 'gmail.com', price: 0.14, count: polls === 1 ? 3 : 0 };
  };
  let clock = Date.now();

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    now: () => clock,
    sleep: async (milliseconds) => { clock += Math.max(20_000, Number(milliseconds) || 0); },
    smsProvider: { service: 'mock', country: '151' },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) { finishSession(sessionState, job); },
    }),
  });

  // 挂租 waits — that is what separates it from an ordinary rental — but the
  // wait ends, or the round would hold the main task slot forever and every
  // later scheduled start would be refused behind it.
  const exhausted = state.events.filter((record) => record.type === 'mail_rental_watch_stock_exhausted');
  assert.equal(exhausted.length, 1);
  assert.equal(exhausted[0].claimedCount, 3);
  assert.equal(exhausted[0].target, 25);
  assert.ok(exhausted[0].starvedForMs >= 20 * 60 * 1000);
  assert.equal(state.mailRentalWatch.autoStopped, true);
  assert.equal(state.mailRentalWatch.claimedCount, 3);
  assert.ok(state.mailRentalWatch.stoppedAt);
  // The three it did rent were registered, not abandoned.
  assert.equal(state.mailboxes.length, 3);
  assert.equal(['complete', 'partial'].includes(state.status), true, state.status);
});

test('an expired unstarted rental fails its job and cancels the provider lease', async (t) => {
  const config = rentalConfig(1, 1);
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailProvider: 'smsbower',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
    aliasCount: 1,
    aliasMaxAttempts: 1,
    security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-rental-start-timeout' });
  const mail = rentalMailClient();
  await mail.rentMailbox();
  const rentedAt = new Date(Date.now() - (25 * 60 * 1000)).toISOString();
  state.mailboxes.push({
    id: 'mail-1',
    email: 'rented1@gmail.com',
    rootEmail: 'rented1@gmail.com',
    status: 'reserved',
    lifecycle: 'claimed_pending_registration',
    registrationState: 'not_started',
    rented: true,
    rentedAt,
    registrationStartDeadlineAt: new Date(Date.parse(rentedAt) + (24 * 60 * 1000)).toISOString(),
    targetCount: 1,
    maxAttempts: 1,
    quotedPriceUsd: 0.14,
    costUsd: 0,
  });
  state.jobs.push({
    id: 'job-expired-rental',
    taskKind: 'register_session',
    email: 'rented1@gmail.com',
    parentEmail: 'rented1@gmail.com',
    mailboxId: 'mail-1',
    laneId: 'mail-1',
    status: 'queued',
    phase: 'queued',
    nextRunAt: '',
    retry: null,
    error: null,
    sessionState: null,
    sessionAssetId: '',
    accountCreatedAt: '',
    credentials: null,
    sms: { current: null, attempts: [], acquisitions: [], costUsd: 0, replacements: 0, sendRetries: 0 },
  });

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    smsProvider: { service: 'mock', country: '151' },
  });

  assert.equal(state.status, 'failed');
  assert.equal(state.jobs[0].status, 'failed');
  assert.equal(state.jobs[0].error.code, 'MAIL_RENTAL_START_TIMEOUT');
  assert.equal(state.jobs[0].rentalStartTimeout.code, 'MAIL_RENTAL_START_TIMEOUT');
  assert.equal(state.mailboxes[0].rentalClosed, 'cancelled');
  assert.equal(state.mailboxes[0].registrationState, 'expired');
  assert.deepEqual(mail.calls, ['rent:mail-1', 'cancel:mail-1']);
});

test('a late worker cannot overwrite a rental start timeout', async (t) => {
  const config = rentalConfig(1, 1);
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailProvider: 'smsbower',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
    aliasCount: 1,
    aliasMaxAttempts: 1,
    security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-late-rental-timeout' });
  const mail = rentalMailClient();
  let runnerCalls = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    smsProvider: { service: 'mock', country: '151' },
    sessionRunnerFactory: ({ job }) => ({
      async run() {
        runnerCalls += 1;
        const mailbox = state.mailboxes.find((item) => String(item.id) === String(job.mailboxId));
        const timeoutAt = new Date().toISOString();
        const record = {
          code: 'MAIL_RENTAL_START_TIMEOUT',
          message: 'Mailbox registration-start timeout was recorded before the worker returned',
          category: 'settled',
          mailboxId: job.mailboxId,
          timeoutAt,
        };
        mailbox.registrationState = 'expired';
        mailbox.lifecycle = 'expired';
        mailbox.registrationStartExpiredAt = timeoutAt;
        mailbox.rentalClosed = 'cancelled';
        job.rentalStartTimeout = record;
        throw Object.assign(new Error('late mailbox read after cancellation'), {
          code: 'BRANCH_JOB_FAILED',
        });
      },
    }),
  });

  assert.equal(runnerCalls, 1);
  assert.equal(state.status, 'failed');
  assert.equal(state.jobs[0].status, 'failed');
  assert.equal(state.jobs[0].error.code, 'MAIL_RENTAL_START_TIMEOUT');
  assert.equal(state.jobs[0].rentalStartTimeout.code, 'MAIL_RENTAL_START_TIMEOUT');
  assert.equal(state.mailboxes[0].registrationState, 'expired');
  assert.equal(state.mailboxes[0].rentalClosed, 'cancelled');
});

test('hang-rental pauses at twice the Worker count and resumes the remaining batch after consumption', async (t) => {
  const config = rentalConfig(1, 1);
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailProvider: 'smsbower',
    mailRentalWatch: true,
    mailRentalTarget: 4,
    mailRentalBatchSize: 4,
    mailRentalPollIntervalMs: 3_600_000,
    mailCount: 4,
    workerConcurrency: 1,
    aliasStrategy: 'root',
    security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-rental-watch-backpressure' });
  const mail = rentalMailClient();
  let priceRestsCalls = 0;
  mail.priceRests = async () => {
    priceRestsCalls += 1;
    return { service: 'dr', domain: 'gmail.com', price: 0.14, count: 4 };
  };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    smsProvider: { service: 'mock', country: '151' },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        finishSession(sessionState, job);
      },
    }),
  });

  const backpressure = state.events.filter((record) => record.type === 'mail_rental_watch_backpressure');
  assert.equal(state.status, 'complete');
  assert.equal(priceRestsCalls, 1, 'the remaining stock was consumed from the original poll batch');
  assert.equal(mail.calls.filter((call) => call.startsWith('rent:')).length, 4);
  assert.equal(state.mailRentalWatch.claimedCount, 4);
  assert.equal(state.mailRentalWatch.idleMailboxLimit, 2);
  assert.equal(backpressure.some((record) => record.paused === true), true);
  assert.equal(backpressure.every((record) => record.idleMailboxCount <= record.idleMailboxLimit), true);
  assert.equal(state.mailboxes.every((mailbox) => Boolean(mailbox.rentalClosed)), true);
});

test('hang-rental retries a sold-out claim without emitting one log per Worker', async (t) => {
  const config = rentalConfig(1, 1);
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailProvider: 'smsbower',
    mailRentalWatch: true,
    mailRentalTarget: 1,
    mailRentalBatchSize: 20,
    mailRentalPollIntervalMs: 20_000,
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
    security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-rental-watch-retry' });
  const mail = rentalMailClient({ soldOutRequests: 1 });
  mail.priceRests = async () => ({ service: 'dr', domain: 'gmail.com', price: 0.14, count: 1 });

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    smsProvider: { service: 'mock', country: '151' },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) { finishSession(sessionState, job); },
    }),
  });

  assert.equal(state.status, 'complete');
  assert.equal(mail.requests, 2);
  assert.equal(state.mailRentalWatch.claimedCount, 1);
  assert.equal(state.events.filter((record) => record.type === 'mail_rental_unavailable').length, 0);
  assert.deepEqual(state.events.filter((record) => record.type === 'mail_rental_watch_batch_result').map((record) => record.claimed), [1]);
});

test('an ordinary rental clears its backoff as soon as a mailbox is in hand', async (t) => {
  // The backoff used to be cleared only when the run stopped needing mailboxes
  // at all. One refused attempt therefore left `mailRentalRetry` standing for
  // the rest of the run, and the console read it as a live wait: 等待库存 with
  // a retry clock already in the past, while mailboxes went on being claimed a
  // minute apart. Observed on a live run at 15:12 against a 15:09:37 retry,
  // with five mailboxes rented in between.
  const config = rentalConfig(1, 1);
  config.mail.count = 2;
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailProvider: 'smsbower',
    mailCount: 2,
    workerConcurrency: 1,
    aliasStrategy: 'root',
    aliasCount: 1,
    aliasMaxAttempts: 1,
    security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-rental-retry-cleared' });
  const mail = rentalMailClient();
  // A provider timeout rather than an empty shelf: sold-out is a wait the run
  // takes silently, while a transport failure is what arms the backoff — and
  // it is what the live run hit (`smsbower mail getActivation failed: timed
  // out after 10000 ms`).
  const issue = mail.rentMailbox;
  let refused = false;
  mail.rentMailbox = async (...args) => {
    if (!refused) {
      refused = true;
      throw Object.assign(new Error('smsbower mail getActivation failed: timed out after 10000 ms'), {
        code: 'MAIL_PROVIDER_TIMEOUT',
        retryable: true,
      });
    }
    return issue(...args);
  };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    smsProvider: { service: 'mock', country: '151' },
    mailRentalRetryDelayMs: 1,
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) { finishSession(sessionState, job); },
    }),
  });

  // The refused request armed the backoff...
  assert.equal(refused, true);
  assert.ok(
    state.events.some((record) => record.type === 'mail_rental_retry_scheduled'),
    'a refused rental must schedule a retry',
  );
  // ...and renting again cleared it, rather than leaving a stale clock behind
  // for the console to render as a live wait.
  assert.equal(state.mailRentalRetry, null);
  assert.equal(state.normalWait?.code === 'MAIL_RENTAL_RETRY', false);
  assert.equal(summarizeBranchState(state).mailRental.retryAt, '');
  assert.equal(state.mailboxes.length, 2);
});

test('hang-rental continues toward a target increased while the run is active', async (t) => {
  const config = rentalConfig(1, 1);
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailProvider: 'smsbower',
    mailRentalWatch: true,
    mailRentalTarget: 2,
    mailRentalBatchSize: 1,
    mailRentalPollIntervalMs: 20_000,
    mailCount: 2,
    workerConcurrency: 1,
    aliasStrategy: 'root',
    security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-rental-watch-live-increase' });
  const mail = rentalMailClient();
  mail.priceRests = async () => ({ service: 'dr', domain: 'gmail.com', price: 0.14, count: 10 });
  let clock = Date.now();
  let increased = false;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    now: () => clock,
    sleep: async (milliseconds) => { clock += Math.max(20_000, Number(milliseconds) || 0); },
    onCheckpoint: async ({ reasons, state: checkpoint }) => {
      if (reasons.includes('mail_rental_watch_batch_claimed') && !increased) {
        increased = true;
        checkpoint.runPlan.mailCount = 4;
        checkpoint.runPlan.mailRentalTarget = 4;
        checkpoint.runPlan.totalAccounts = 4;
        checkpoint.mailRentalWatch.target = 4;
        checkpoint.mailRentalWatch.autoStopped = false;
        checkpoint.mailRentalWatch.stopRequested = false;
        checkpoint.mailRentalWatch.nextPollAt = '';
      }
    },
    smsProvider: { service: 'mock', country: '151' },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) { finishSession(sessionState, job); },
    }),
  });

  assert.equal(state.status, 'complete');
  assert.equal(mail.calls.filter((call) => call.startsWith('rent:')).length, 4);
  assert.equal(state.mailRentalWatch.claimedCount, 4);
  assert.equal(state.mailRentalWatch.target, 4);
  assert.equal(state.jobs.length, 4);
  assert.equal(state.jobs.every((job) => job.status === 'complete'), true);
  assert.equal(state.mailRentalWatch.autoStopped, true);
});

test('stopping hang-rental stops future polls while the claimed batch still completes', async (t) => {
  const config = rentalConfig(2, 1);
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailProvider: 'smsbower',
    mailRentalWatch: true,
    mailRentalTarget: 25,
    mailRentalBatchSize: 20,
    mailRentalPollIntervalMs: 20_000,
    mailCount: 25,
    workerConcurrency: 2,
    aliasStrategy: 'root',
    security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-rental-watch-stop' });
  const mail = rentalMailClient();
  let priceRestsCalls = 0;
  mail.priceRests = async () => {
    priceRestsCalls += 1;
    return { service: 'dr', domain: 'gmail.com', price: 0.14, count: 25 };
  };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    onCheckpoint: async ({ reasons, state: checkpoint }) => {
      if (reasons.includes('mail_rental_watch_batch_claimed')) checkpoint.mailRentalWatch.stopRequested = true;
    },
    smsProvider: { service: 'mock', country: '151' },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) { finishSession(sessionState, job); },
    }),
  });

  const rents = mail.calls.filter((call) => call.startsWith('rent:'));
  assert.equal(state.status, 'complete');
  assert.equal(priceRestsCalls, 1);
  assert.equal(rents.length, 20);
  assert.equal(state.jobs.length, 20);
  assert.equal(state.jobs.every((job) => job.status === 'complete'), true);
  assert.equal(state.mailRentalWatch.claimedCount, 20);
  assert.equal(state.mailRentalWatch.stopRequested, true);
  assert.equal(state.mailRentalWatch.autoStopped, false);
});

test('stopping hang-rental during a batch discards unissued claim windows', async (t) => {
  const config = rentalConfig(1, 1);
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailProvider: 'smsbower',
    mailRentalWatch: true,
    mailRentalTarget: 5,
    mailRentalBatchSize: 5,
    mailRentalPollIntervalMs: 20_000,
    mailCount: 5,
    workerConcurrency: 1,
    aliasStrategy: 'root',
    security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-rental-watch-stop-mid-batch' });
  const mail = rentalMailClient();
  mail.priceRests = async () => ({ service: 'dr', domain: 'gmail.com', price: 0.14, count: 5 });
  let stopped = false;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    onCheckpoint: async ({ reasons, state: checkpoint }) => {
      if (reasons.includes('mail_rental_watch_batch_progress') && !stopped) {
        stopped = true;
        checkpoint.mailRentalWatch.stopRequested = true;
      }
    },
    smsProvider: { service: 'mock', country: '151' },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) { finishSession(sessionState, job); },
    }),
  });

  assert.equal(state.status, 'complete');
  assert.equal(mail.calls.filter((call) => call.startsWith('rent:')).length, 2);
  assert.equal(state.jobs.length, 2);
  assert.equal(state.jobs.every((job) => job.status === 'complete'), true);
  assert.equal(state.mailRentalWatch.claimedCount, 2);
  assert.equal(state.mailRentalWatch.claimBatchRemaining, 0);
  assert.equal(state.events.filter((record) => record.type === 'mail_rental_watch_claims_stopped').length, 1);
});

test('a rented mailbox is only paid for when a Worker is ready to use it', async (t) => {
  // Renting the whole mailCount up front bills for mailboxes a run that dies
  // early never opens, so the rental happens lane by lane.
  const config = rentalConfig(1, 2);
  config.mail.count = 3;
  const plan = normalizeRunPlan({
    taskKind: 'register_oauth', mailCount: 3, workerConcurrency: 1,
    aliasStrategy: 'root', aliasCount: 2, aliasMaxAttempts: 2,
    mailProvider: 'smsbower', security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-rental-lazy' });
  const mail = rentalMailClient();

  // Nothing has been rented before the run starts.
  assert.deepEqual(mail.calls, []);

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    smsProvider: { service: 'mock', country: '151' },
    sessionRunnerFactory: ({ job }) => ({ async run(sessionState) { finishSession(sessionState, job); } }),
    oauthRunnerFactory: () => ({
      async run(oauthState) {
        oauthState.step = 'complete';
        oauthState.status = 'complete';
        oauthState.account = { email: oauthState.email, access_token: `cpa-${oauthState.email}` };
      },
    }),
  });

  const rents = mail.calls.filter((call) => call.startsWith('rent:'));
  assert.equal(rents.length, 3, 'one rental per lane, drawn as the Worker frees up');
  // One account per mailbox now: the address the provider issued, nothing derived.
  assert.deepEqual(state.jobs.map((job) => job.status), Array(3).fill('complete'));
  assert.equal(new Set(state.jobs.map((job) => job.parentEmail)).size, 3);
});

test('an account still in OAuth occupies one mailbox slot, not two', async (t) => {
  const config = rentalConfig(2, 1);
  config.mail.count = 3;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', postRegistrationOAuth: true, mailCount: 3, workerConcurrency: 2,
    aliasStrategy: 'root', aliasCount: 1, aliasMaxAttempts: 1,
    mailProvider: 'smsbower', security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-rental-oauth-slot-count' });
  const mail = rentalMailClient();
  const originalRent = mail.rentMailbox.bind(mail);
  let resolveThirdRental;
  const thirdRental = new Promise((resolve) => { resolveThirdRental = resolve; });
  mail.rentMailbox = async (...args) => {
    const rented = await originalRent(...args);
    if (rented.id === 'mail-3') resolveThirdRental();
    return rented;
  };
  let resolveSecondJob;
  const secondJobContinue = new Promise((resolve) => { resolveSecondJob = resolve; });
  let resolveSecondHeld;
  const secondHeld = new Promise((resolve) => { resolveSecondHeld = resolve; });

  const run = runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    smsProvider: { service: 'mock', country: '151' },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) { finishSession(sessionState, job); },
    }),
    oauthRunnerFactory: ({ job }) => ({
      async run(oauthState) {
        if (job.mailboxId === 'mail-1') await secondHeld;
        if (job.mailboxId === 'mail-2') {
          resolveSecondHeld();
          await secondJobContinue;
        }
        oauthState.step = 'complete';
        oauthState.status = 'complete';
        oauthState.account = { email: oauthState.email, access_token: `cpa-${job.mailboxId}` };
      },
    }),
  });

  const waitFor = (predicate, timeoutMs) => new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const poll = () => {
      if (predicate()) resolve(true);
      else if (Date.now() >= deadline) resolve(false);
      else setTimeout(poll, 10);
    };
    poll();
  });
  const firstJobComplete = await waitFor(
    () => state.jobs.some((job) => job.mailboxId === 'mail-1' && job.status === 'complete'),
    2000,
  );
  const rentedWhileSecondOAuthWasOpen = firstJobComplete && await Promise.race([
    thirdRental.then(() => true),
    new Promise((resolve) => setTimeout(() => resolve(false), 250)),
  ]);
  resolveSecondJob();
  await run;

  assert.equal(rentedWhileSecondOAuthWasOpen, true);
  assert.equal(mail.calls.filter((call) => call.startsWith('rent:')).length, 3);
  assert.equal(state.jobs.filter((job) => job.status === 'complete').length, 3);
});

test('a finished lane settles its mailbox and an empty one is cancelled instead', async (t) => {
  const config = rentalConfig(1, 1);
  config.mail.count = 1;
  const plan = normalizeRunPlan({
    taskKind: 'register_oauth', mailCount: 1, workerConcurrency: 1,
    aliasStrategy: 'root', aliasCount: 1, aliasMaxAttempts: 1,
    mailProvider: 'smsbower', security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-rental-settle' });
  const mail = rentalMailClient();

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    smsProvider: { service: 'mock', country: '151' },
    sessionRunnerFactory: ({ job }) => ({ async run(sessionState) { finishSession(sessionState, job); } }),
    oauthRunnerFactory: () => ({
      async run(oauthState) {
        oauthState.step = 'complete';
        oauthState.status = 'complete';
        oauthState.account = { email: oauthState.email, access_token: 'cpa' };
      },
    }),
  });

  assert.equal(state.jobs[0].status, 'complete');
  assert.deepEqual(mail.calls, ['rent:mail-1', 'settle:mail-1']);
  assert.equal(state.mailboxes[0].rentalClosed, 'settled');
});

test('a post-account continuation failure settles the rental instead of cancelling it', async (t) => {
  const config = rentalConfig(1, 1);
  config.mail.count = 1;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 1, workerConcurrency: 1,
    aliasStrategy: 'root', aliasCount: 1, aliasMaxAttempts: 1,
    mailProvider: 'smsbower', security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-rental-post-account-failure' });
  const mail = rentalMailClient();

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    smsProvider: { service: 'mock', country: '151' },
    sessionRunnerFactory: () => ({
      async run(sessionState) {
        sessionState.accountCreated = true;
        sessionState.step = 'auth_callback_pending';
        throw Object.assign(new Error('Authentication continuation origin is not allowed'), {
          code: 'AUTH_CONTINUATION_ORIGIN_INVALID',
          accountCreated: true,
        });
      },
    }),
  });

  assert.equal(state.jobs[0].status, 'failed');
  assert.equal(state.jobs[0].accountCreatedAt !== '', true);
  assert.deepEqual(mail.calls, ['rent:mail-1', 'settle:mail-1']);
  assert.equal(state.mailboxes[0].rentalClosed, 'settled');
});

test('a fatal scheduler error drains workers and closes every open rental', async (t) => {
  const config = rentalConfig(2, 1);
  config.mail.count = 2;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 2, workerConcurrency: 2,
    aliasStrategy: 'root', aliasCount: 1, aliasMaxAttempts: 1,
    mailProvider: 'smsbower', security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-fatal-drain-rentals' });
  const mail = rentalMailClient();
  await mail.rentMailbox();
  state.mailboxes = [{
    id: 'mail-1',
    email: 'rented1@gmail.com',
    rootEmail: 'rented1@gmail.com',
    status: 'reserved',
    rented: true,
    quotedPriceUsd: 0.14,
    targetCount: 1,
    maxAttempts: 1,
  }];
  state.jobs = [{
    id: 'job-fatal-1',
    email: 'rented1@gmail.com',
    parentEmail: 'rented1@gmail.com',
    mailboxId: 'mail-1',
    laneId: 'mail-1',
    aliasIndex: 1,
    status: 'queued',
    phase: 'queued',
    sms: { current: null, attempts: [], acquisitions: [], costUsd: 0, replacements: 0, sendRetries: 0 },
  }];
  const retryAt = new Date(Date.now() + 10).toISOString();
  state.mailRentalRetry = { attempts: 1, firstAt: new Date().toISOString(), nextRunAt: retryAt };
  state.normalWait = { code: 'MAIL_RENTAL_RETRY', nextRunAt: retryAt };

  let releaseWorker;
  const workerHeld = new Promise((resolve) => { releaseWorker = resolve; });
  mail.rentMailbox = async () => {
    releaseWorker();
    throw Object.assign(new Error('mail provider returned an unrecoverable response'), {
      code: 'MAIL_RENTAL_PROVIDER_FATAL',
      retryable: false,
    });
  };

  await assert.rejects(
    runBranchOrchestrator({ log: { entries: [] } }, state, config, {
      assetStore: temporaryStore(t),
      mailClient: mail,
      smsProvider: { service: 'mock', country: '151' },
      sessionRunnerFactory: ({ job }) => ({
        async run(sessionState) {
          assert.equal(job.id, 'job-fatal-1');
          await workerHeld;
          throw new Error('worker stopped after scheduler failure');
        },
      }),
    }),
    { code: 'MAIL_RENTAL_PROVIDER_FATAL' },
  );

  assert.equal(state.status, 'failed');
  assert.equal(state.phase, 'failed');
  assert.equal(state.workers.every((worker) => worker.status === 'idle' && !worker.currentJobId), true);
  assert.deepEqual(mail.calls, ['rent:mail-1', 'cancel:mail-1']);
  assert.equal(state.mailboxes.every((mailbox) => mailbox.rentalClosed), true);
});

test('cancelling a partial uncreated rental cancels it even after the target was touched', async () => {
  const config = rentalConfig(1, 1);
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 1, workerConcurrency: 1,
    aliasStrategy: 'root', aliasCount: 1, aliasMaxAttempts: 1,
    mailProvider: 'smsbower', security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-rental-cancel-partial' });
  const mail = rentalMailClient();
  await mail.rentMailbox();
  state.mailboxes.push({
    id: 'mail-1', email: 'rented1@gmail.com', rootEmail: 'rented1@gmail.com',
    status: 'reserved', rented: true, targetCount: 1, maxAttempts: 1,
  });
  state.jobs.push({
    id: 'job-rental-cancel-partial', email: 'rented1@gmail.com', parentEmail: 'rented1@gmail.com',
    mailboxId: 'mail-1', laneId: 'mail-1', status: 'partial', phase: 'partial',
    targetTouchedAt: new Date().toISOString(),
    // This is a durable pre-account checkpoint: the address is already spent,
    // but no account has been confirmed and the rental must still be cancelled.
    sessionState: { step: 'mfa_challenge_issued' },
    sms: { current: null, attempts: [], acquisitions: [], costUsd: 0, replacements: 0, sendRetries: 0 },
  });

  await cancelBranchState(state, config, { mailClient: mail, smsProvider: {} });

  assert.equal(state.status, 'cancelled');
  assert.deepEqual(mail.calls, ['rent:mail-1', 'cancel:mail-1']);
  assert.equal(state.mailboxes[0].rentalClosed, 'cancelled');
});

test('cancelling a partial created rental settles it instead of cancelling the account mailbox', async () => {
  const config = rentalConfig(1, 1);
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 1, workerConcurrency: 1,
    aliasStrategy: 'root', aliasCount: 1, aliasMaxAttempts: 1,
    mailProvider: 'smsbower', security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-rental-cancel-created-partial' });
  const mail = rentalMailClient();
  await mail.rentMailbox();
  state.mailboxes.push({
    id: 'mail-1', email: 'rented1@gmail.com', rootEmail: 'rented1@gmail.com',
    status: 'reserved', rented: true, targetCount: 1, maxAttempts: 1,
  });
  state.jobs.push({
    id: 'job-rental-cancel-created-partial', email: 'rented1@gmail.com', parentEmail: 'rented1@gmail.com',
    mailboxId: 'mail-1', laneId: 'mail-1', status: 'partial', phase: 'partial',
    accountCreatedAt: new Date().toISOString(),
    sessionState: { step: 'auth_callback_pending', accountCreated: true },
    sms: { current: null, attempts: [], acquisitions: [], costUsd: 0, replacements: 0, sendRetries: 0 },
  });

  await cancelBranchState(state, config, { mailClient: mail, smsProvider: {} });

  assert.equal(state.status, 'cancelled');
  assert.deepEqual(mail.calls, ['rent:mail-1', 'settle:mail-1']);
  assert.equal(state.mailboxes[0].rentalClosed, 'settled');
});

test('cancelling a persisted rental rehydrates the mail client before settling it', async () => {
  const config = rentalConfig(1, 1);
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 1, workerConcurrency: 1,
    aliasStrategy: 'root', aliasCount: 1, aliasMaxAttempts: 1,
    mailProvider: 'smsbower', security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-rental-cancel-rehydrate' });
  state.mailboxes.push({
    id: 'mail-persisted', email: 'persisted@gmail.com', rootEmail: 'persisted@gmail.com',
    status: 'reserved', rented: true, quotedPriceUsd: 0.14, targetCount: 1, maxAttempts: 1,
  });
  state.jobs.push({
    id: 'job-rental-cancel-rehydrate', email: 'persisted@gmail.com', parentEmail: 'persisted@gmail.com',
    mailboxId: 'mail-persisted', laneId: 'mail-persisted', status: 'partial', phase: 'partial',
    accountCreatedAt: new Date().toISOString(),
    sessionState: { step: 'auth_callback_pending', accountCreated: true },
    sms: { current: null, attempts: [], acquisitions: [], costUsd: 0, replacements: 0, sendRetries: 0 },
  });
  const requests = [];

  await cancelBranchState(state, config, {
    smsProvider: {},
    mailFetch: async (url) => {
      requests.push(new URL(url));
      return { status: 200, text: async () => JSON.stringify({ status: 1, message: 'Success' }) };
    },
  });

  assert.equal(state.status, 'cancelled');
  assert.equal(state.mailboxes[0].rentalClosed, 'settled');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].pathname.endsWith('/setStatus'), true);
  assert.equal(requests[0].searchParams.get('id'), 'mail-persisted');
  assert.equal(requests[0].searchParams.get('status'), '3');
});

test('rental cleanup retries after a transient cancel failure without completing early', async () => {
  const config = rentalConfig(1, 1);
  config.mail.count = 1;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 1, workerConcurrency: 1,
    aliasStrategy: 'root', aliasCount: 1, aliasMaxAttempts: 1,
    mailProvider: 'smsbower', security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-rental-cancel-retry' });
  const mail = rentalMailClient();
  await mail.rentMailbox();
  state.mailboxes.push({
    id: 'mail-1', email: 'rented1@gmail.com', rootEmail: 'rented1@gmail.com',
    status: 'reserved', rented: true, targetCount: 1, maxAttempts: 1,
  });
  state.jobs.push({
    id: 'job-rental-cancel-retry', email: 'rented1@gmail.com', parentEmail: 'rented1@gmail.com',
    mailboxId: 'mail-1', laneId: 'mail-1', status: 'waiting', phase: 'queued',
    sms: { current: null, attempts: [], acquisitions: [], costUsd: 0, replacements: 0, sendRetries: 0 },
  });
  const clockStart = Date.now();
  let clock = clockStart;
  let cancelCalls = 0;
  const cancel = mail.cancelMailbox.bind(mail);
  mail.cancelMailbox = async (id) => {
    cancelCalls += 1;
    if (cancelCalls === 1) throw Object.assign(new Error('temporary provider failure'), { code: 'ETIMEDOUT' });
    return cancel(id);
  };

  await cancelBranchState(state, config, { mailClient: mail, smsProvider: {}, now: () => clock });
  assert.equal(state.status, 'waiting');
  assert.equal(state.cancelPending, true);
  assert.equal(state.mailboxes[0].rentalCleanup.status, 'pending');
  assert.equal(cancelCalls, 1);

  clock += 5000;
  await cancelBranchState(state, config, { mailClient: mail, smsProvider: {}, now: () => clock });
  assert.equal(state.status, 'cancelled');
  assert.equal(state.cancelPending, false);
  assert.equal(cancelCalls, 2);
  assert.equal(state.mailboxes[0].rentalClosed, 'cancelled');
});

test('a provider mailbox-state rejection ends cancellation with an external review marker', async () => {
  const config = rentalConfig(1, 1);
  config.mail.count = 1;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 1, workerConcurrency: 1,
    aliasStrategy: 'root', aliasCount: 1, aliasMaxAttempts: 1,
    mailProvider: 'smsbower', security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-rental-state-rejected' });
  const mail = rentalMailClient();
  await mail.rentMailbox();
  state.mailboxes.push({
    id: 'mail-1', email: 'rented1@gmail.com', rootEmail: 'rented1@gmail.com',
    status: 'reserved', rented: true, targetCount: 1, maxAttempts: 1,
  });
  state.jobs.push({
    id: 'job-rental-state-rejected', email: 'rented1@gmail.com', parentEmail: 'rented1@gmail.com',
    mailboxId: 'mail-1', laneId: 'mail-1', status: 'waiting', phase: 'queued',
    sms: { current: null, attempts: [], acquisitions: [], costUsd: 0, replacements: 0, sendRetries: 0 },
  });
  mail.cancelMailbox = async () => {
    throw Object.assign(new Error('smsbower mail setStatus failed: Bad actual activation status'), {
      code: 'MAILBOX_STATE_REJECTED',
      providerStateRejected: true,
      retryable: false,
    });
  };

  await cancelBranchState(state, config, { mailClient: mail, smsProvider: {} });

  assert.equal(state.status, 'cancelled');
  assert.equal(state.cancelPending, false);
  assert.equal(state.mailboxes[0].rentalClosed, 'cleanup_manual_review');
  assert.equal(state.mailboxes[0].rentalCleanup.status, 'manual_review');
  assert.equal(state.mailboxes[0].rentalCleanup.lastError.code, 'MAILBOX_STATE_REJECTED');
});

test('a transient settlement failure keeps the run waiting until the rental closes', async (t) => {
  const config = rentalConfig(1, 1);
  config.mail.count = 1;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 1, workerConcurrency: 1,
    aliasStrategy: 'root', aliasCount: 1, aliasMaxAttempts: 1,
    mailProvider: 'smsbower', security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-rental-settle-retry' });
  const mail = rentalMailClient();
  let settleCalls = 0;
  const settle = mail.settleMailbox.bind(mail);
  mail.settleMailbox = async (id) => {
    settleCalls += 1;
    if (settleCalls === 1) throw Object.assign(new Error('temporary provider failure'), { code: 'ETIMEDOUT' });
    return settle(id);
  };
  let clock = Date.now();
  const options = {
    assetStore: temporaryStore(t),
    mailClient: mail,
    smsProvider: { service: 'mock', country: '151' },
    now: () => clock,
    sessionRunnerFactory: ({ job }) => ({ async run(sessionState) { finishSession(sessionState, job); } }),
    oauthRunnerFactory: () => ({
      async run(oauthState) {
        oauthState.step = 'complete';
        oauthState.status = 'complete';
        oauthState.account = { email: oauthState.email, access_token: 'cpa' };
      },
    }),
  };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, options);
  assert.equal(state.status, 'waiting');
  assert.equal(state.phase, 'waiting_mailbox_cleanup');
  assert.equal(state.mailboxes[0].rentalCleanup.status, 'pending');
  assert.equal(settleCalls, 1);

  clock += 5000;
  resumeBranchState(state, { now: () => clock });
  await runBranchOrchestrator({ log: { entries: [] } }, state, config, options);
  assert.equal(state.status, 'complete');
  assert.equal(settleCalls, 2);
  assert.equal(state.mailboxes[0].rentalClosed, 'settled');
});

test('a pre-account rental failure cancels the mailbox and replaces it within the mailbox budget', async (t) => {
  // Three mailboxes allowed: the two cancelled ones and their replacements all
  // count against that budget.
  const config = rentalConfig(1, 1);
  config.mail.count = 3;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', postRegistrationOAuth: true, mailCount: 3, workerConcurrency: 1,
    aliasStrategy: 'root', aliasCount: 1, aliasMaxAttempts: 1,
    mailProvider: 'smsbower', security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-rental-replacement' });
  const mail = rentalMailClient();
  let attempts = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    smsProvider: { service: 'mock', country: '151' },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        attempts += 1;
        if (attempts <= 2) {
          throw Object.assign(new Error('Authentication continuation origin is not allowed'), {
            code: 'AUTH_CONTINUATION_ORIGIN_INVALID',
          });
        }
        finishSession(sessionState, job);
      },
    }),
    oauthRunnerFactory: () => ({
      async run(oauthState) {
        oauthState.step = 'complete';
        oauthState.status = 'complete';
        oauthState.account = { email: oauthState.email, access_token: 'cpa' };
      },
    }),
  });

  assert.equal(state.status, 'complete');
  assert.equal(attempts, 3);
  assert.deepEqual(mail.calls, [
    'rent:mail-1', 'cancel:mail-1',
    'rent:mail-2', 'cancel:mail-2',
    'rent:mail-3', 'settle:mail-3',
  ]);
  assert.deepEqual(state.jobs.map((job) => job.status), ['failed', 'failed', 'complete']);
  assert.equal(state.jobs[0].compensated, true);
  assert.equal(state.jobs[1].compensated, true);
  assert.equal(state.jobs[0].replacementJobId, state.jobs[1].id);
  assert.equal(state.jobs[1].replacementJobId, state.jobs[2].id);
  assert.equal(state.events.filter((record) => record.type === 'mail_rental_replacement_queued').length, 2);
  assert.equal(state.mailboxes.filter((mailbox) => mailbox.rentalClosed === 'cancelled').length, 2);
  assert.equal(summarizeBranchState(state).costs.mail, 0.14);
});

test('a terminal post-registration OAuth failure replaces its settled mailbox', async (t) => {
  const config = rentalConfig(1, 1);
  config.mail.count = 2;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', postRegistrationOAuth: true, mailCount: 2, workerConcurrency: 1,
    aliasStrategy: 'root', aliasCount: 1, aliasMaxAttempts: 1,
    mailProvider: 'smsbower', security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-rental-oauth-replacement' });
  const mail = rentalMailClient();
  let oauthAttempts = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    smsProvider: { service: 'mock', country: '151' },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) { finishSession(sessionState, job); },
    }),
    oauthRunnerFactory: () => ({
      async run(oauthState) {
        oauthAttempts += 1;
        if (oauthAttempts === 1) {
          throw Object.assign(new Error('OAuth login state is no longer valid'), {
            code: 'OAUTH_LOGIN_REQUIRED',
          });
        }
        oauthState.step = 'complete';
        oauthState.status = 'complete';
        oauthState.account = { email: oauthState.email, access_token: 'replacement-cpa' };
      },
    }),
  });

  const replacement = state.jobs.find((job) => job.replacementOf === state.jobs[0].id);
  assert.equal(state.status, 'complete');
  assert.equal(oauthAttempts, 2);
  assert.equal(mail.calls.filter((call) => call.startsWith('rent:')).length, 2);
  assert.equal(state.jobs[0].compensated, true);
  assert.equal(state.jobs[0].replacementJobId, replacement.id);
  assert.equal(replacement.status, 'complete');
  assert.equal(state.mailboxes.filter((mailbox) => mailbox.rentalClosed === 'settled').length, 2);
  assert.equal(state.mailboxes.filter((mailbox) => mailbox.rentalClosed === 'cancelled').length, 0);
});

test('an ordinary rental never rents past the plan mailbox count, replacements included', async (t) => {
  const config = rentalConfig(1, 1);
  config.mail.count = 1;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', postRegistrationOAuth: true, mailCount: 1, workerConcurrency: 1,
    aliasStrategy: 'root', aliasCount: 1, aliasMaxAttempts: 1,
    mailProvider: 'smsbower', security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-rental-budget' });
  const mail = rentalMailClient();

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    smsProvider: { service: 'mock', country: '151' },
    sessionRunnerFactory: () => ({
      async run() {
        throw Object.assign(new Error('Authentication continuation origin is not allowed'), {
          code: 'AUTH_CONTINUATION_ORIGIN_INVALID',
        });
      },
    }),
    oauthRunnerFactory: () => ({ async run() { throw new Error('unreachable'); } }),
  });

  // The one mailbox the plan allows was rented and cancelled; nothing replaces it.
  assert.deepEqual(mail.calls, ['rent:mail-1', 'cancel:mail-1']);
  assert.equal(state.mailboxes.length, 1);
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].status, 'failed');
  assert.notEqual(state.jobs[0].compensated, true);
  assert.equal(state.status, 'failed');
});

test('a replacement waiting on stock does not stop idle Workers from getting fresh mailboxes', async (t) => {
  // Observed live: while a replacement sat on a sold-out retry, no new lane was
  // rented at all, and 17 of 18 Workers idled below the target for 40 minutes.
  const config = rentalConfig(3, 1);
  config.mail.count = 6;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', postRegistrationOAuth: true, mailCount: 6, workerConcurrency: 3,
    aliasStrategy: 'root', aliasCount: 1, aliasMaxAttempts: 1,
    mailProvider: 'smsbower', security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-rental-idle-workers' });
  const inner = rentalMailClient();
  const rentedAt = [];
  let soldOutAt = 0;
  let requests = 0;
  const mail = Object.create(inner);
  // The fourth request is the replacement for the first mailbox: sold out once.
  mail.rentMailbox = async (...args) => {
    requests += 1;
    if (requests === 4) {
      soldOutAt = Date.now();
      throw Object.assign(new Error('smsbower mail getActivation failed: No mails yet'), { soldOut: true });
    }
    const rented = await inner.rentMailbox(...args);
    rentedAt.push(Date.now());
    return rented;
  };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    mailRentalRetryDelayMs: 400,
    smsProvider: { service: 'mock', country: '151' },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        if (job.email === 'rented1@gmail.com') {
          await new Promise((resolve) => setTimeout(resolve, 5));
          throw Object.assign(new Error('Authentication continuation origin is not allowed'), {
            code: 'AUTH_CONTINUATION_ORIGIN_INVALID',
          });
        }
        await new Promise((resolve) => setTimeout(resolve, 40));
        finishSession(sessionState, job);
      },
    }),
    oauthRunnerFactory: () => ({
      async run(oauthState) {
        oauthState.step = 'complete';
        oauthState.status = 'complete';
        oauthState.account = { email: oauthState.email, access_token: 'cpa' };
      },
    }),
  });

  assert.ok(soldOutAt > 0, 'the replacement request should have hit the sold-out stock');
  // Workers freed while the replacement waited were given fresh mailboxes long
  // before its 400 ms retry came due.
  assert.ok(rentedAt.filter((at) => at > soldOutAt && at < soldOutAt + 300).length >= 1);
  // And the plan's six mailboxes are the ceiling, replacement or not.
  assert.equal(state.mailboxes.length, 6);
  assert.equal(inner.calls.filter((call) => call.startsWith('rent:')).length, 6);
  assert.equal(state.jobs.filter((job) => job.status === 'complete').length, 5);
});

test('a secured registration settles its rented mailbox before OAuth runs', async (t) => {
  const config = rentalConfig(1, 1);
  config.mail.count = 1;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', postRegistrationOAuth: true, mailCount: 1, workerConcurrency: 1,
    aliasStrategy: 'root', aliasCount: 1, aliasMaxAttempts: 1,
    mailProvider: 'smsbower', security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-rental-settle-before-oauth' });
  const mail = rentalMailClient();
  let callsWhenOAuthRan = null;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    smsProvider: { service: 'mock', country: '151' },
    sessionRunnerFactory: ({ job }) => ({ async run(sessionState) { finishSession(sessionState, job); } }),
    oauthRunnerFactory: () => ({
      async run(oauthState) {
        callsWhenOAuthRan = [...mail.calls];
        oauthState.step = 'complete';
        oauthState.status = 'complete';
        oauthState.account = { email: oauthState.email, access_token: 'cpa' };
      },
    }),
  });

  // Settled while OAuth was still to come, and only once.
  assert.deepEqual(callsWhenOAuthRan, ['rent:mail-1', 'settle:mail-1']);
  assert.deepEqual(mail.calls, ['rent:mail-1', 'settle:mail-1']);
  assert.equal(state.mailboxes[0].rentalClosed, 'settled');
  assert.equal(state.status, 'complete');
});

test('a registration without its TOTP keeps the mailbox open instead of settling early', async (t) => {
  const config = rentalConfig(1, 1);
  config.mail.count = 1;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', postRegistrationOAuth: true, mailCount: 1, workerConcurrency: 1,
    aliasStrategy: 'root', aliasCount: 1, aliasMaxAttempts: 1,
    mailProvider: 'smsbower', security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-rental-no-totp-open' });
  const mail = rentalMailClient();

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    smsProvider: { service: 'mock', country: '151' },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        finishSession(sessionState, job);
        sessionState.security = { ...sessionState.security, totpStatus: 'failed' };
      },
    }),
    oauthRunnerFactory: () => ({ async run() { throw new Error('OAuth must be held back'); } }),
  });

  // Security recovery may still need a code from this mailbox.
  assert.deepEqual(mail.calls, ['rent:mail-1']);
  assert.equal(state.mailboxes[0].rentalClosed || '', '');
  assert.equal(state.jobs[0].status, 'partial');
});

test('a settle refused after a timed-out settle counts as settled, not manual review', async (t) => {
  const config = rentalConfig(1, 1);
  config.mail.count = 1;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', postRegistrationOAuth: true, mailCount: 1, workerConcurrency: 1,
    aliasStrategy: 'root', aliasCount: 1, aliasMaxAttempts: 1,
    mailProvider: 'smsbower', security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-rental-settle-timeout' });
  const mail = rentalMailClient();
  let settleRequests = 0;
  mail.settleMailbox = async (id) => {
    settleRequests += 1;
    if (settleRequests === 1) {
      // Applied at the provider, but the answer never came back.
      throw Object.assign(new Error('smsbower mail setStatus failed: timed out after 10000 ms'), {
        code: 'MAIL_PROVIDER_TIMEOUT', retryAfterMs: 5,
      });
    }
    throw Object.assign(new Error('smsbower mail setStatus failed: Bad actual activation status'), {
      code: 'MAILBOX_STATE_REJECTED', providerStateRejected: true, retryable: false,
    });
  };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    smsProvider: { service: 'mock', country: '151' },
    sessionRunnerFactory: ({ job }) => ({ async run(sessionState) { finishSession(sessionState, job); } }),
    oauthRunnerFactory: () => ({
      async run(oauthState) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        oauthState.step = 'complete';
        oauthState.status = 'complete';
        oauthState.account = { email: oauthState.email, access_token: 'cpa' };
      },
    }),
  });

  assert.equal(settleRequests, 2);
  const mailbox = state.mailboxes[0];
  assert.equal(mailbox.rentalClosed, 'settled');
  assert.equal(mailbox.rentalCloseReason, 'settle_landed_before_timeout');
  assert.equal(mailbox.costUsd, 0.14);
  assert.equal(state.events.some((record) => record.type === 'mail_rental_cleanup_manual_review'), false);
  assert.equal(state.status, 'complete');
});

test('a settle refused with no earlier timeout still goes to manual review', async (t) => {
  const config = rentalConfig(1, 1);
  config.mail.count = 1;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', postRegistrationOAuth: true, mailCount: 1, workerConcurrency: 1,
    aliasStrategy: 'root', aliasCount: 1, aliasMaxAttempts: 1,
    mailProvider: 'smsbower', security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-rental-settle-refused' });
  const mail = rentalMailClient();
  mail.settleMailbox = async () => {
    throw Object.assign(new Error('smsbower mail setStatus failed: Bad actual activation status'), {
      code: 'MAILBOX_STATE_REJECTED', providerStateRejected: true, retryable: false,
    });
  };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    smsProvider: { service: 'mock', country: '151' },
    sessionRunnerFactory: ({ job }) => ({ async run(sessionState) { finishSession(sessionState, job); } }),
    oauthRunnerFactory: () => ({
      async run(oauthState) {
        oauthState.step = 'complete';
        oauthState.status = 'complete';
        oauthState.account = { email: oauthState.email, access_token: 'cpa' };
      },
    }),
  });

  // Nothing says this rental was ever settled: it stays the operator's call.
  assert.equal(state.mailboxes[0].rentalClosed, 'cleanup_manual_review');
});

test('OAuth skips are counted by reason, and only for accounts that reached OAuth', () => {
  const config = rentalConfig(1, 1);
  const plan = normalizeRunPlan({
    taskKind: 'register_session', postRegistrationOAuth: true, mailCount: 6, workerConcurrency: 1,
    aliasStrategy: 'root', aliasCount: 1, aliasMaxAttempts: 1,
    mailProvider: 'smsbower', security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-oauth-skipped-counts' });
  const reached = { sessionAssetId: 'asset', oauthState: { step: 'phone_otp_sent' } };
  state.jobs = [
    { id: 'phone', status: 'failed', ...reached, error: { code: 'OAUTH_PHONE_REPLACEMENT_BUDGET_EXHAUSTED', causeCode: 'RATE_LIMIT_EXCEEDED' } },
    { id: 'login', status: 'failed', ...reached, error: { code: 'OAUTH_LOGIN_REQUIRED' } },
    { id: 'rate', status: 'failed', ...reached, error: { code: 'RATE_LIMIT_EXCEEDED' } },
    // A 429 during registration never reached OAuth; it belongs to the registration tiles.
    { id: 'registration-rate', status: 'failed', error: { code: 'RATE_LIMIT_EXCEEDED' } },
    // OAuth eventually succeeded: nothing was skipped.
    { id: 'done', status: 'complete', ...reached, cpaPath: 'out.json' },
  ];
  const counts = summarizeBranchState(state).counts;
  assert.deepEqual(counts.oauthSkipped, { rateLimited: 1, phoneBudgetExhausted: 1, loginRequired: 1 });

  // A registration-only run has no OAuth stage and no such tile.
  const registrationOnly = makeInitialBranchState(config, normalizeRunPlan({
    taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root',
    mailProvider: 'smsbower', security: { setPassword: true, enrollTotp: true },
  }, config), { runId: 'branch-oauth-skipped-none' });
  assert.equal(summarizeBranchState(registrationOnly).counts.oauthSkipped, undefined);
});

test('a job pinned to a busy Worker does not count as work for an idle one', () => {
  // The 03:27:35 snapshot: 163/200 rented, worker-14 idle, and the one queued
  // job already in SMS verification, pinned to worker-4, which is busy with
  // another lane. The old count read that as 1 idle − 1 queued = 0 short.
  const config = rentalConfig(3, 1);
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 200, workerConcurrency: 3,
    aliasStrategy: 'root', aliasCount: 1, aliasMaxAttempts: 1,
    mailProvider: 'smsbower', security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-rental-pinned-deficit' });
  state.mailboxes = Array.from({ length: 163 }, (_, index) => ({ id: `m${index}`, rented: true }));
  state.workers = [
    { id: 'worker-4', status: 'running', currentJobId: 'job-157' },
    { id: 'worker-9', status: 'running', currentJobId: 'job-158' },
    { id: 'worker-14', status: 'idle', currentJobId: '' },
  ];
  const pinned = { id: 'job-150', laneId: 'lane-150', status: 'queued', mailboxId: 'm150',
    workerAffinity: { workerId: 'worker-4' }, sms: { current: { activationId: 'a1', status: 'code_waiting' } },
    sessionState: { step: 'phone_otp_sent' } };
  state.jobs = [
    { id: 'job-157', laneId: 'lane-157', status: 'running', mailboxId: 'm157' },
    { id: 'job-158', laneId: 'lane-158', status: 'running', mailboxId: 'm158' },
    pinned,
  ];
  const context = { state, plan, config, now: () => Date.now() };
  assert.equal(_rentalMailboxDeficit(context), 1);

  // Once its own Worker is the idle one, the pinned job does fill it.
  state.workers[0] = { id: 'worker-4', status: 'idle', currentJobId: '' };
  state.workers[2] = { id: 'worker-14', status: 'running', currentJobId: 'job-other' };
  state.jobs.push({ id: 'job-other', laneId: 'lane-other', status: 'running', mailboxId: 'm1' });
  state.jobs[0].status = 'complete';
  assert.equal(_rentalMailboxDeficit(context), 0);

  // An unpinned queued job still covers an idle Worker, as before.
  state.workers = [{ id: 'worker-14', status: 'idle', currentJobId: '' }];
  state.jobs = [{ id: 'job-free', laneId: 'lane-free', status: 'queued', mailboxId: 'm2' }];
  assert.equal(_rentalMailboxDeficit(context), 0);
  // ...and the plan's mailbox ceiling still caps the shortfall.
  state.jobs = [];
  state.mailboxes = Array.from({ length: 200 }, (_, index) => ({ id: `m${index}`, rented: true }));
  assert.equal(_rentalMailboxDeficit(context), 0);
});

test('an empty provider stock parks the run on what it already holds', async (t) => {
  const config = rentalConfig(1, 1);
  config.mail.count = 2;
  const plan = normalizeRunPlan({
    taskKind: 'register_oauth', mailCount: 2, workerConcurrency: 1,
    aliasStrategy: 'root', aliasCount: 1, aliasMaxAttempts: 1,
    mailProvider: 'smsbower', security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-rental-soldout' });
  // Only one mailbox is ever issued; the second request comes back sold out.
  const mail = rentalMailClient({ soldOutAfter: 1 });

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    smsProvider: { service: 'mock', country: '151' },
    sessionRunnerFactory: ({ job }) => ({ async run(sessionState) { finishSession(sessionState, job); } }),
    oauthRunnerFactory: () => ({
      async run(oauthState) {
        oauthState.step = 'complete';
        oauthState.status = 'complete';
        oauthState.account = { email: oauthState.email, access_token: 'cpa' };
      },
    }),
  });

  // The one account it could build is finished and paid for; the run does not fail.
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].status, 'complete');
  assert.deepEqual(mail.calls, ['rent:mail-1', 'settle:mail-1']);
  assert.equal(state.events.some((record) => record.type === 'mail_rental_unavailable'), true);
});

test('the rental channel is preflighted on provider stock, not on a pool it has not rented yet', async () => {
  // Counting mailboxes it holds would always answer zero before the run starts,
  // which is exactly the false "no mailbox" the pooled check used to report.
  const config = rentalConfig(1, 2);
  config.mail.count = 2;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', postRegistrationOAuth: true, mailCount: 2, workerConcurrency: 1,
    aliasStrategy: 'root', aliasCount: 2, aliasMaxAttempts: 2,
    mailProvider: 'smsbower', security: { setPassword: true, enrollTotp: true },
  }, config);
  const options = (price, count) => ({
    mailClient: { async priceRests() { return { service: 'dr', domain: 'gmail.com', price, count }; }, async listAccounts() { return []; } },
    smsProvider: { async preflight() { return { ready: true, balance: 9, price: 0.05, count: 99, service: 'dr', country: 151 }; } },
    proxyEntries: [{ id: 'p1', url: 'http://p1:1', workerSlots: [1] }],
  });

  const stocked = await prepareBranchPreflight(config, plan, options(0.12, 5));
  assert.equal(stocked.snapshot.mail.kind, 'rentable_mailboxes');
  assert.equal(stocked.snapshot.mail.eligible, 5);
  assert.equal(stocked.snapshot.mail.ready, true);

  const empty = await prepareBranchPreflight(config, plan, options(0.12, 0));
  assert.equal(empty.snapshot.mail.ready, false);
  assert.equal(empty.snapshot.warnings.some((warning) => /no gmail\.com mailbox in stock/.test(warning)), true);

  // Priced out is refused up front rather than discovered one paid mailbox at a time.
  const dear = await prepareBranchPreflight(config, plan, options(0.5, 5));
  assert.equal(dear.snapshot.mail.ready, false);
  assert.equal(dear.snapshot.warnings.some((warning) => /exceeds mail\.maxPrice/.test(warning)), true);

  const stockError = new Error('incomplete stock response');
  stockError.code = 'MAIL_STOCK_RESPONSE_INVALID';
  const failed = await prepareBranchPreflight(config, plan, {
    mailClient: { async priceRests() { throw stockError; }, async listAccounts() { return []; } },
    smsProvider: { async preflight() { return { ready: true, balance: 9, price: 0.05, count: 99, service: 'dr', country: 151 }; } },
    proxyEntries: [{ id: 'p1', url: 'http://p1:1', workerSlots: [1] }],
  });
  assert.equal(failed.snapshot.mail.eligible, null);
  assert.equal(failed.snapshot.mail.stockStatus, 'error');
  assert.equal(failed.snapshot.mail.stockError.code, 'MAIL_STOCK_RESPONSE_INVALID');
  assert.equal(failed.snapshot.mail.ready, false);
});

test('the rental channel builds its own client when none is injected', async () => {
  // Every other rental test hands in a stub, which means the factory that picks
  // the client by provider is never executed — a missing import survived that
  // blind spot once already. This drives the real construction path.
  const config = rentalConfig(1, 1);
  config.mail.count = 1;
  config.mail.apiKey = 'mail-key';
  const plan = normalizeRunPlan({
    taskKind: 'register_session', postRegistrationOAuth: true, mailCount: 1, workerConcurrency: 1,
    aliasStrategy: 'root', aliasCount: 1, aliasMaxAttempts: 1,
    mailProvider: 'smsbower', security: { setPassword: true, enrollTotp: true },
  }, config);

  const requested = [];
  const snapshot = await prepareBranchPreflight(config, plan, {
    // No mailClient: the factory has to produce a real SmsbowerMailClient and
    // reach the provider through this fetch.
    mailFetch: async (url) => {
      requested.push(String(url));
      return { status: 200, text: async () => JSON.stringify({ status: 1, data: { dr: { 'gmail.com': { price: 0.1, count: 3 } } } }) };
    },
    smsProvider: { async preflight() { return { ready: true, balance: 9, price: 0.05, count: 99, service: 'dr', country: 151 }; } },
    proxyEntries: [{ id: 'p1', url: 'http://p1:1', workerSlots: [1] }],
  });

  assert.equal(snapshot.snapshot.mail.kind, 'rentable_mailboxes');
  assert.equal(snapshot.snapshot.mail.eligible, 3);
  assert.equal(snapshot.snapshot.mail.ready, true);
  // It asked the mail API, with the key, and never tried to log in anywhere.
  assert.equal(requested.length, 1);
  assert.match(requested[0], /\/getPriceRests\?/);
  assert.match(requested[0], /api_key=mail-key/);
});

test('a rental registers the address it issued and derives nothing from it', async (t) => {
  // Aliases are gone: a rented mailbox has a code quota, and making one mailbox
  // receive for two accounts is what exhausted it in practice.
  const config = rentalConfig(1, 2);
  config.mail.count = 1;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', postRegistrationOAuth: true, mailCount: 1, workerConcurrency: 1,
    aliasStrategy: 'root', aliasCount: 2, aliasMaxAttempts: 2,
    mailProvider: 'smsbower', security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-rental-root-first' });
  const mail = rentalMailClient();

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    smsProvider: { service: 'mock', country: '151' },
    sessionRunnerFactory: ({ job }) => ({ async run(sessionState) { finishSession(sessionState, job); } }),
    oauthRunnerFactory: () => ({
      async run(oauthState) {
        oauthState.step = 'complete';
        oauthState.status = 'complete';
        oauthState.account = { email: oauthState.email, access_token: 'cpa' };
      },
    }),
  });

  const emails = state.jobs.map((job) => job.email);
  // Exactly the issued address — no `+alias` may appear at all.
  assert.deepEqual(emails, ['rented1@gmail.com']);
  assert.equal(emails.some((email) => email.includes('+')), false);
  assert.deepEqual(state.jobs.map((job) => job.status), ['complete']);
});

test('a run reports what its rented mailboxes cost, counting only the settled ones', async (t) => {
  const config = rentalConfig(1, 1);
  config.mail.count = 2;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', postRegistrationOAuth: true, mailCount: 2, workerConcurrency: 1,
    aliasStrategy: 'root', aliasCount: 1, aliasMaxAttempts: 1,
    mailProvider: 'smsbower', security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-rental-cost' });
  const mail = rentalMailClient();
  let attempt = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    smsProvider: { service: 'mock', country: '151' },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        attempt += 1;
        // The second mailbox produces nothing, so it is cancelled, not billed.
        if (attempt === 2) throw Object.assign(new Error('registration rejected'), { code: 'REGISTRATION_REJECTED' });
        finishSession(sessionState, job);
      },
    }),
    oauthRunnerFactory: () => ({
      async run(oauthState) {
        oauthState.step = 'complete';
        oauthState.status = 'complete';
        oauthState.account = { email: oauthState.email, access_token: 'cpa' };
      },
    }),
  });

  const summary = summarizeBranchState(state);
  assert.equal(summary.costs.currency, 'USD');
  // One settled at 0.14; the cancelled one contributes nothing.
  assert.equal(summary.costs.mail, 0.14);
  assert.equal(summary.costs.mailRentals, 1);
  assert.deepEqual(mail.calls.filter((call) => !call.startsWith('rent:')), ['settle:mail-1', 'cancel:mail-2']);
});

test('registration summaries classify the three non-CPA outcomes for every task that registers', () => {
  const state = {
    schemaVersion: 2,
    runId: 'branch-registration-outcomes',
    taskKind: 'register_session',
    status: 'complete',
    phase: 'complete',
    createdAt: '',
    updatedAt: '',
    runPlan: { taskKind: 'register_session', postRegistrationOAuth: false },
    workers: [],
    mailboxes: [],
    externalCleanup: [],
    control: { requestedAction: null, requestedAt: '', pausedAt: '', resumedAt: '' },
    jobs: [
      { id: 'email-otp', status: 'skipped', error: { code: 'EMAIL_OTP_TIMEOUT', message: 'verification timed out' } },
      { id: 'email-provider', status: 'failed', error: { code: 'EMAIL_PROVIDER_TIMEOUT' } },
      { id: 'rental-timeout', status: 'failed', error: { code: 'MAIL_RENTAL_START_TIMEOUT' } },
      { id: 'origin-invalid', status: 'failed', error: { code: 'AUTH_CONTINUATION_ORIGIN_INVALID' } },
      { id: 'existing', status: 'complete', result: 'existing_account_recovered' },
      { id: 'mfa-factor', status: 'failed', error: { code: 'MFA_TOTP_FACTOR_UNAVAILABLE' } },
      { id: 'mfa-secret', status: 'failed', error: { code: 'MFA_TOTP_SECRET_REQUIRED' } },
      { id: 'already-exists', status: 'failed', error: { code: 'USER_ALREADY_EXISTS' } },
      { id: 'callback-pending', status: 'waiting', error: { code: 'AUTH_CALLBACK_ERROR_PAGE', callbackFailure: true } },
      { id: 'callback-final', status: 'skipped', error: { code: 'AUTH_CALLBACK_ERROR_PAGE', callbackFailure: true } },
      { id: 'callback-exhausted', status: 'skipped', error: { code: 'AUTH_CALLBACK_ERROR_PAGE' }, authCallbackProxyRecovery: { exhausted: true } },
      { id: 'callback-legacy-final', status: 'failed', error: { code: 'AUTH_CALLBACK_ERROR_PAGE' } },
    ],
  };

  const summary = summarizeBranchState(state);
  assert.deepEqual(summary.counts.registrationOutcomes, {
    existingAccountRecovered: 1,
    mfaTotp: 3,
    callbackFailed: 3,
  });
  assert.deepEqual(summary.counts.registrationSkipped, {
    emailTimeout: 2,
    rentalStartTimeout: 1,
    authContinuationOriginInvalid: 1,
  });
  assert.equal(summary.jobs[0].result, '失败：EMAIL_OTP_TIMEOUT，verification timed out');
  assert.deepEqual(summary.jobs[0].error, state.jobs[0].error);
  assert.equal(summary.jobs.find((job) => job.id === 'existing').result, 'existing_account_recovered');

  // A registration run that continues into OAuth on the same job still
  // registered every one of these accounts, so it reports the same
  // registration outcomes. Reporting them only for registration-without-OAuth
  // left the console showing CPA artifact counts and nothing about the
  // registrations that produced them.
  const registerThenOauth = {
    ...state,
    runPlan: { taskKind: 'register_session', postRegistrationOAuth: true },
  };
  assert.deepEqual(summarizeBranchState(registerThenOauth).counts.registrationOutcomes, {
    existingAccountRecovered: 1,
    mfaTotp: 3,
    callbackFailed: 3,
  });
  assert.deepEqual(summarizeBranchState(registerThenOauth).counts.registrationSkipped, {
    emailTimeout: 2,
    rentalStartTimeout: 1,
    authContinuationOriginInvalid: 1,
  });

  // A task that registers nothing still has nothing to report.
  const oauthOnly = { ...state, taskKind: 'oauth', runPlan: { taskKind: 'oauth' } };
  assert.equal(summarizeBranchState(oauthOnly).counts.registrationOutcomes, undefined);
  assert.equal(summarizeBranchState(oauthOnly).counts.registrationSkipped, undefined);

  const withoutCallback = {
    ...state,
    jobs: state.jobs.filter((job) => !String(job.id).startsWith('callback-')),
  };
  assert.equal(Object.hasOwn(summarizeBranchState(withoutCallback).counts.registrationOutcomes, 'callbackFailed'), false);
});

test('summary restores a rental timeout when an old worker overwrote the job error', () => {
  const state = {
    schemaVersion: 2,
    runId: 'branch-rental-timeout-summary',
    taskKind: 'register_session',
    status: 'partial',
    phase: 'partial',
    createdAt: '',
    updatedAt: '',
    runPlan: { taskKind: 'register_session', postRegistrationOAuth: false },
    workers: [],
    mailboxes: [{
      id: 'mail-timeout',
      email: 'timeout@gmail.com',
      rented: true,
      rentalClosed: 'cancelled',
      registrationState: 'started',
      registrationStartExpiredAt: '2026-09-21T07:41:51.149Z',
      costUsd: 0,
    }],
    externalCleanup: [],
    control: { requestedAction: null, requestedAt: '', pausedAt: '', resumedAt: '' },
    jobs: [{
      id: 'job-late-worker',
      mailboxId: 'mail-timeout',
      status: 'failed',
      error: { code: 'BRANCH_JOB_FAILED', message: 'mailbox was already settled' },
    }],
  };

  const summary = summarizeBranchState(state);
  assert.equal(summary.jobs[0].error.code, 'MAIL_RENTAL_START_TIMEOUT');
  assert.match(summary.jobs[0].result, /MAIL_RENTAL_START_TIMEOUT/);
  assert.equal(summary.counts.registrationSkipped.rentalStartTimeout, 1);
});

test('summary splits settled rental waste from ordinary mailbox cost without double counting a mailbox', () => {
  const state = {
    schemaVersion: 2,
    runId: 'branch-rental-waste-summary',
    taskKind: 'register_session',
    status: 'complete',
    phase: 'complete',
    createdAt: '',
    updatedAt: '',
    runPlan: { taskKind: 'register_session', postRegistrationOAuth: false },
    workers: [],
    mailboxes: [
      { id: 'mail-mfa', rented: true, rentalClosed: 'settled', costUsd: 0.14 },
      { id: 'mail-callback', rented: true, rentalClosed: 'settled', costUsd: 0.15 },
      { id: 'mail-ordinary', rented: true, rentalClosed: 'settled', costUsd: 0.16 },
      { id: 'mail-cancelled', rented: true, rentalClosed: 'cancelled', costUsd: 0 },
    ],
    externalCleanup: [],
    control: { requestedAction: null, requestedAt: '', pausedAt: '', resumedAt: '' },
    jobs: [
      { id: 'mfa-job', mailboxId: 'mail-mfa', status: 'failed', error: { code: 'MFA_TOTP_SECRET_REQUIRED' } },
      { id: 'mfa-duplicate-job', mailboxId: 'mail-mfa', status: 'failed', error: { code: 'USER_ALREADY_EXISTS' } },
      { id: 'callback-job', mailboxId: 'mail-callback', status: 'skipped', error: { code: 'AUTH_CALLBACK_ERROR_PAGE' }, authCallbackProxyRecovery: { exhausted: true } },
      { id: 'ordinary-job', mailboxId: 'mail-ordinary', status: 'complete' },
    ],
  };

  const summary = summarizeBranchState(state);
  assert.equal(summary.costs.mail, 0.45);
  assert.equal(summary.costs.mailRentals, 3);
  assert.equal(summary.costs.wastedMail, 0.29);
  assert.equal(summary.costs.wastedMailRentals, 2);
});

test('OAuth settled phone failures are exposed as separate wasted activations', () => {
  const state = {
    schemaVersion: 2,
    runId: 'branch-oauth-phone-waste-summary',
    taskKind: 'oauth',
    status: 'complete',
    phase: 'complete',
    createdAt: '',
    updatedAt: '',
    runPlan: { taskKind: 'oauth' },
    workers: [],
    mailboxes: [],
    externalCleanup: [],
    control: { requestedAction: null, requestedAt: '', pausedAt: '', resumedAt: '' },
    jobs: [{
      id: 'oauth-phone-waste',
      taskKind: 'oauth',
      status: 'complete',
      phase: 'complete',
      sessionAssetId: 'asset-oauth-phone-waste',
      sms: {
        attempts: [
          { id: 'spent', scope: 'oauth', status: 'complete', cost: 0.045, codeReceived: true, cleanupReason: 'PHONE_RECENTLY_USED' },
          { id: 'rejected', scope: 'oauth', status: 'complete', cost: 0.045, codeReceived: true, cleanupReason: 'INVALID_INPUT' },
          { id: 'accepted', scope: 'oauth', status: 'complete', cost: 0.045, codeReceived: true, targetAccepted: true },
        ],
      },
    }],
  };

  const summary = summarizeBranchState(state);
  assert.equal(summary.counts.wasted, 2);
  assert.equal(summary.costs.sms, 0.135);
  assert.equal(summary.costs.wastedSms, 0.09);
  assert.equal(summary.costs.wastedSmsAttempts, 2);
  assert.equal(summary.jobs[0].smsWastedUsd, 0.09);
  assert.deepEqual(summary.counts.wastedBreakdown, [
    { kind: 'sms', code: 'PHONE_RECENTLY_USED', count: 1, amount: 0.045, currency: 'USD' },
    { kind: 'sms', code: 'INVALID_INPUT', count: 1, amount: 0.045, currency: 'USD' },
  ]);
});

test('only-registration MFA TOTP waste settles the rented mailbox and enters task cost', async (t) => {
  const config = rentalConfig(1, 1);
  config.mail.count = 1;
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    postRegistrationOAuth: false,
    mailProvider: 'smsbower',
    mailRentalWatch: true,
    mailRentalTarget: 1,
    mailRentalBatchSize: 1,
    mailRentalPollIntervalMs: 20_000,
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
    aliasCount: 1,
    aliasMaxAttempts: 1,
    security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-rental-mfa-totp-waste' });
  const mail = rentalMailClient();
  mail.priceRests = async () => ({ service: 'dr', domain: 'gmail.com', price: 0.14, count: 1 });

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    smsProvider: { service: 'mock', country: '151' },
    sessionRunnerFactory: () => ({
      async run() {
        throw Object.assign(new Error('TOTP secret is unavailable'), {
          code: 'MFA_TOTP_SECRET_REQUIRED',
        });
      },
    }),
  });

  assert.equal(state.jobs[0].status, 'failed');
  assert.equal(state.jobs[0].error.code, 'MFA_TOTP_SECRET_REQUIRED');
  assert.deepEqual(mail.calls, ['rent:mail-1', 'settle:mail-1']);
  const summary = summarizeBranchState(state);
  assert.equal(summary.counts.registrationOutcomes.mfaTotp, 1);
  assert.equal(summary.costs.mail, 0.14);
  assert.equal(summary.costs.mailRentals, 1);
});

test('MFA TOTP waste settles the rented mailbox even when OAuth would have followed', async (t) => {
  // ui-20260928104010-sskjn6 had postRegistrationOAuth on; its two MFA
  // mailboxes were cancelled, SMSBower refused (the address had taken a
  // code) and they sat in manual review at $0, outside cost and waste.
  const config = rentalConfig(1, 1);
  config.mail.count = 1;
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    postRegistrationOAuth: true,
    mailProvider: 'smsbower',
    mailRentalWatch: true,
    mailRentalTarget: 1,
    mailRentalBatchSize: 1,
    mailRentalPollIntervalMs: 20_000,
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
    aliasCount: 1,
    aliasMaxAttempts: 1,
    security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-rental-mfa-totp-oauth-waste' });
  const mail = rentalMailClient();
  mail.priceRests = async () => ({ service: 'dr', domain: 'gmail.com', price: 0.14, count: 1 });

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    smsProvider: {
      service: 'mock',
      country: '151',
      async preflight() { return { provider: 'mock', ready: true }; },
    },
    sessionRunnerFactory: () => ({
      async run() {
        throw Object.assign(new Error('TOTP secret is unavailable'), {
          code: 'MFA_TOTP_SECRET_REQUIRED',
        });
      },
    }),
  });

  assert.equal(state.jobs[0].error.code, 'MFA_TOTP_SECRET_REQUIRED');
  assert.deepEqual(mail.calls, ['rent:mail-1', 'settle:mail-1']);
  const summary = summarizeBranchState(state);
  assert.equal(summary.counts.registrationOutcomes.mfaTotp, 1);
  assert.equal(summary.costs.wastedMail, 0.14);
  assert.equal(summary.costs.wastedMailRentals, 1);
});

test('an MFA mailbox stuck in manual review is counted as waste, apart from billed cost', () => {
  const state = {
    schemaVersion: 2,
    runId: 'branch-rental-waste-unresolved',
    taskKind: 'register_session',
    status: 'partial',
    phase: 'partial',
    createdAt: '',
    updatedAt: '',
    runPlan: { taskKind: 'register_session', postRegistrationOAuth: true },
    workers: [],
    mailboxes: [
      { id: 'mail-mfa-review', rented: true, rentalClosed: 'cleanup_manual_review', quotedPriceUsd: 0.015, costUsd: 0, rentalUnresolvedUsd: 0 },
      { id: 'mail-mfa-settled', rented: true, rentalClosed: 'settled', costUsd: 0.015 },
      { id: 'mail-ordinary-review', rented: true, rentalClosed: 'cleanup_manual_review', rentalBillingUncertain: true, quotedPriceUsd: 0.015, rentalUnresolvedUsd: 0.015, costUsd: 0 },
      { id: 'mail-ordinary', rented: true, rentalClosed: 'settled', costUsd: 0.015 },
    ],
    externalCleanup: [],
    control: { requestedAction: null, requestedAt: '', pausedAt: '', resumedAt: '' },
    jobs: [
      { id: 'mfa-review', mailboxId: 'mail-mfa-review', status: 'failed', error: { code: 'MFA_TOTP_SECRET_REQUIRED' } },
      { id: 'mfa-settled', mailboxId: 'mail-mfa-settled', status: 'failed', error: { code: 'MFA_TOTP_SECRET_REQUIRED' } },
      { id: 'ordinary-review', mailboxId: 'mail-ordinary-review', status: 'complete' },
      { id: 'ordinary', mailboxId: 'mail-ordinary', status: 'complete' },
    ],
  };

  const summary = summarizeBranchState(state);
  assert.equal(summary.counts.wasted, 2);
  assert.equal(summary.costs.mail, 0.03, 'billed cost only counts confirmed charges');
  assert.equal(summary.costs.wastedMail, 0.015);
  assert.equal(summary.costs.wastedMailUnresolved, 0.015);
  assert.equal(summary.costs.wastedMailUnresolvedRentals, 1);
  // The refused cancel stays at its recorded 0 here; only the waste figure reprices it.
  assert.equal(summary.costs.mailUnresolved, 0.015);
  assert.deepEqual(summary.counts.wastedBreakdown, [
    { kind: 'mail', code: 'SETTLED_RENTAL', count: 1, amount: 0.015, currency: 'USD' },
    { kind: 'mail', code: 'UNRESOLVED_RENTAL', count: 1, amount: 0.015, currency: 'USD' },
  ]);
});

test('only-registration USER_ALREADY_EXISTS waste settles the rented mailbox and enters task cost', async (t) => {
  const config = rentalConfig(1, 1);
  config.mail.count = 1;
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    postRegistrationOAuth: false,
    mailProvider: 'smsbower',
    mailRentalWatch: true,
    mailRentalTarget: 1,
    mailRentalBatchSize: 1,
    mailRentalPollIntervalMs: 20_000,
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
    aliasCount: 1,
    aliasMaxAttempts: 1,
    security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-rental-user-already-exists-waste' });
  const mail = rentalMailClient();
  mail.priceRests = async () => ({ service: 'dr', domain: 'gmail.com', price: 0.14, count: 1 });

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    smsProvider: { service: 'mock', country: '151' },
    sessionRunnerFactory: () => ({
      async run() {
        throw Object.assign(new Error('account already exists'), {
          code: 'USER_ALREADY_EXISTS',
        });
      },
    }),
  });

  assert.equal(state.jobs[0].status, 'failed');
  assert.equal(state.jobs[0].error.code, 'USER_ALREADY_EXISTS');
  assert.deepEqual(mail.calls, ['rent:mail-1', 'settle:mail-1']);
  const summary = summarizeBranchState(state);
  assert.equal(summary.counts.registrationOutcomes.mfaTotp, 1);
  assert.equal(summary.costs.mail, 0.14);
  assert.equal(summary.costs.mailRentals, 1);
});

test('running out of SMS balance stops the whole run instead of parking the job', async (t) => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({ taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root' }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-sms-no-balance' });

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([{ id: 'mail-no-balance', email: 'no-balance@example.test', tokenValid: true, bound: false }]),
    smsProvider: {
      service: 'mock', country: '151',
      // Read back after the failure so the message can state what is left.
      async getBalance() { return 0.004; },
      async acquireNumber() {
        throw Object.assign(new Error('SMSBower getNumberV2 failed: NO_BALANCE'), {
          code: 'NO_BALANCE', category: 'balance',
        });
      },
    },
    sessionRunnerFactory: () => ({
      async run(sessionState) { sessionState.step = 'phone_required'; },
    }),
  });

  const job = state.jobs[0];
  // Nothing in this run can ever hand the job a number once the run has stopped
  // renting, so parking it would only hold its mailbox against a wait that
  // cannot end. `skipped`, not `failed`: running dry is not a defect.
  assert.equal(job.status, 'skipped');
  assert.equal(job.error.code, 'NO_BALANCE');
  assert.equal(job.nextRunAt, '');
  assert.match(job.error.message, /恭喜没钱了/);
  assert.match(job.error.message, /0\.004/);
  assert.equal(['complete', 'partial'].includes(state.status), true, state.status);

  // The stop is latched once and shuts the rental down through the same marker
  // both rental modes read.
  assert.equal(Boolean(state.balanceStop?.at), true);
  assert.equal(state.balanceStop.adoptedRentalStop, true);
  assert.notEqual(String(state.mailRentalStoppedAt || ''), '');
  assert.equal(state.events.filter((entry) => entry.type === 'run_stopped_no_balance').length, 1);

  const event = state.events.find((entry) => entry.type === 'sms_balance_exhausted');
  assert.ok(event, 'the balance stop is reported as its own event');
  assert.equal(event.balance, 0.004);
  assert.equal(event.workerConcurrency, 1);
  assert.match(event.message, /恭喜没钱了/);
});

test('a balance read that fails still stops the run rather than masking the reason', async (t) => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({ taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root' }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-sms-no-balance-unreadable' });

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([{ id: 'mail-nb2', email: 'nb2@example.test', tokenValid: true, bound: false }]),
    smsProvider: {
      service: 'mock', country: '151',
      async getBalance() { throw new Error('getBalance unavailable'); },
      async acquireNumber() {
        throw Object.assign(new Error('SMSBower getNumberV2 failed: NO_BALANCE'), { code: 'NO_BALANCE', category: 'balance' });
      },
    },
    sessionRunnerFactory: () => ({ async run(sessionState) { sessionState.step = 'phone_required'; } }),
  });

  assert.equal(state.jobs[0].status, 'skipped');
  assert.match(state.jobs[0].error.message, /恭喜没钱了/);
  assert.match(state.jobs[0].error.message, /余额读取失败/);
  assert.equal(Boolean(state.balanceStop?.at), true);
});

test('a mailbox refused for want of money stops the round and keeps what it holds', async (t) => {
  // Two separate points, and they stop differently. Claiming is blocked outright
  // — the client has always flagged `insufficientBalance` and nothing read it,
  // so a refusal was retried like any other claim failure. Settling is not
  // blocked: a mailbox only costs money once it is settled, and the two already
  // claimed have accounts to produce.
  const config = rentalConfig(2, 1);
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailProvider: 'smsbower',
    mailRentalWatch: true,
    mailRentalTarget: 25,
    mailRentalBatchSize: 20,
    mailRentalPollIntervalMs: 20_000,
    mailCount: 25,
    workerConcurrency: 2,
    aliasStrategy: 'root',
    security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-rental-no-balance' });
  const mail = rentalMailClient({ insufficientBalanceAfter: 2 });
  mail.priceRests = async () => ({ service: 'dr', domain: 'gmail.com', price: 0.14, count: 5 });
  let clock = Date.now();
  // Claims run concurrently, so the window that hits the refusal may have
  // siblings already in flight. What must not happen is another request after
  // the stop is latched.
  let requestsAtStop = null;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    now: () => clock,
    sleep: async (milliseconds) => { clock += Math.max(20_000, Number(milliseconds) || 0); },
    smsProvider: { service: 'mock', country: '151' },
    onCheckpoint: async ({ reasons }) => {
      if (reasons.includes('run_stopped_no_balance') && requestsAtStop === null) requestsAtStop = mail.requests;
    },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) { finishSession(sessionState, job); },
    }),
  });

  assert.equal(state.events.filter((record) => record.type === 'run_stopped_no_balance').length, 1);
  assert.equal(state.balanceStop.source, 'mail_rental');
  assert.notEqual(String(state.mailRentalStoppedAt || ''), '');
  // The refusal ends the round instead of being retried against an empty wallet.
  assert.notEqual(requestsAtStop, null, 'the stop has to be checkpointed');
  assert.equal(mail.requests, requestsAtStop,
    `no mailbox may be requested after the stop; ${mail.requests - requestsAtStop} were`);
  assert.equal(Number(state.mailRentalWatch.claimRetryCount || 0), 0, 'a refusal must not book a claim retry');
  assert.equal(state.mailboxes.length, 2);
  // And the two it already holds are registered and settled, not discarded.
  assert.equal(state.jobs.filter((job) => job.status === 'complete').length, 2);
  assert.equal(mail.calls.filter((call) => call.startsWith('settle:')).length, 2);
  assert.equal(['complete', 'partial'].includes(state.status), true, state.status);
});

test('a resume hands back the rental stop the balance halt adopted, but not the operator own', async (t) => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({ taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root' }, config);

  // The run halted itself: resuming means the account was topped up.
  const adopted = makeInitialBranchState(config, plan, { runId: 'branch-balance-resume-adopted' });
  adopted.status = 'waiting';
  adopted.jobs = [{ id: 'job-a', status: 'waiting', phase: 'waiting_sms_balance', nextRunAt: '', retry: null, laneId: 'lane-a' }];
  adopted.mailRentalStoppedAt = '2026-09-26T00:00:00.000Z';
  adopted.balanceStop = { at: '2026-09-26T00:00:00.000Z', source: 'sms:oauth', message: 'no balance', adoptedRentalStop: true, balance: 0 };
  resumeBranchState(adopted);
  assert.equal(adopted.balanceStop, null);
  assert.equal(adopted.mailRentalStoppedAt, '');

  // The operator had already stopped renting before the money ran out. That
  // decision is theirs and survives the resume.
  const operator = makeInitialBranchState(config, plan, { runId: 'branch-balance-resume-operator' });
  operator.status = 'waiting';
  operator.jobs = [{ id: 'job-b', status: 'waiting', phase: 'waiting_sms_balance', nextRunAt: '', retry: null, laneId: 'lane-b' }];
  operator.mailRentalStoppedAt = '2026-09-25T23:00:00.000Z';
  operator.balanceStop = { at: '2026-09-26T00:00:00.000Z', source: 'sms:oauth', message: 'no balance', adoptedRentalStop: false, balance: 0 };
  resumeBranchState(operator);
  assert.equal(operator.balanceStop, null);
  assert.equal(operator.mailRentalStoppedAt, '2026-09-25T23:00:00.000Z');
});

test('a dead exit that drops the TLS handshake rotates the proxy instead of backing off on itself', async (t) => {
  // Node's own text for a proxy that dies mid-handshake names neither the proxy
  // nor the target host, so the transport predicate used to reject it and the
  // job fell into the generic transient ladder — five retries on the same dead
  // exit, backing off up to two minutes each. Measured in a live run: 9 of these
  // sat in `waiting_transient` while 12 Cloudflare challenges next to them
  // correctly rotated.
  const config = branchConfig(1);
  config.aliases.strategy = 'root';
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-tls-drop-rotates' });
  const mail = mailboxClient([{ id: 'mail-tls', email: 'tls@example.test', tokenValid: true, bound: false }]);
  let runnerCalls = 0;

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    retryPolicies: {
      waiting_proxy_rotation: { delaysMs: [1], maxRetries: 3 },
      waiting_transient: { delaysMs: [1], maxRetries: 3 },
    },
    assetStore: temporaryStore(t),
    mailClient: mail,
    // A spare exit, so the rotation has somewhere to go.
    proxyEntries: [
      { id: 'proxy-dead', url: 'http://127.0.0.1:4201', workerSlots: [1] },
      { id: 'proxy-spare', url: 'http://127.0.0.1:4202', workerSlots: [1] },
    ],
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        runnerCalls += 1;
        if (runnerCalls === 1) {
          throw Object.assign(
            new Error('tls_get_more_records: packet length too long'),
            { code: 'ERR_SSL_PACKET_LENGTH_TOO_LONG' },
          );
        }
        finishSession(sessionState, job);
      },
    }),
  });

  const waited = state.events.filter((record) => record.type === 'branch_job_waiting');
  assert.ok(waited.length >= 1, 'the dropped handshake should have parked the job once');
  assert.equal(waited[0].waitPhase, 'waiting_proxy_rotation');
  // The point of the fix: it must never land in the generic transient ladder,
  // which retries the same dead exit instead of leaving it.
  assert.equal(waited.every((record) => record.waitPhase !== 'waiting_transient'), true);
  // The exit is dropped rather than retried: verified by reverting the predicate,
  // where this same error produced `waiting_transient` and the runner simply ran
  // again on the dead proxy.
  assert.equal(state.events.some((record) => record.type === 'worker_proxy_swapped_before_registration'), true);
  assert.equal(runnerCalls, 2, 'the dead exit must be replaced by the spare exit');
});

test('a resume normalizes legacy retired addresses to failed', async (t) => {
  // Older checkpoints may contain the retired screener statuses. The current
  // Worker path keeps the addresses unavailable under its single failed state.
  const now = Date.now();
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const config = branchConfig(1);
  config.proxyPool.required = true;
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-resume-health' });
  state.status = 'waiting';
  state.proxyHealth = {
    'proxy-spent-recently': {
      status: 'recheck_required',
      reason: 'proxy_unusable',
      recheckReason: 'OAUTH_ACCOUNT_SELECT_TRANSPORT_FAILED',
      recheckAt: iso(30 * 1000),
      accountSelectionRechecks: 2,
      recheckCount: 2,
    },
    'proxy-spent-long-ago': { status: 'burned', reason: 'proxy_unusable', burnedAt: iso(45 * 60 * 1000) },
    'proxy-undated': { status: 'burned', reason: 'runtime_transport_failure' },
    'proxy-legacy-leased': { status: 'leased', leasedTo: 'old-worker' },
  };

  resumeBranchState(state);

  // No ageing or reset event: a retired address stays unavailable, but its
  // persisted status no longer exposes the removed state machine.
  assert.equal(Object.keys(state.proxyHealth).length, 4);
  assert.equal(state.proxyHealth['proxy-spent-recently']?.status, 'failed');
  assert.equal(state.proxyHealth['proxy-spent-recently']?.reason, 'OAUTH_ACCOUNT_SELECT_TRANSPORT_FAILED');
  assert.equal(state.proxyHealth['proxy-spent-recently']?.accountSelectionFailures, 2);
  assert.equal(Object.hasOwn(state.proxyHealth['proxy-spent-recently'], 'recheckReason'), false);
  assert.equal(state.proxyHealth['proxy-spent-long-ago']?.status, 'failed');
  assert.equal(state.proxyHealth['proxy-undated']?.status, 'failed');
  assert.equal(Object.hasOwn(state.proxyHealth['proxy-undated'], 'burnedAt'), false);
  assert.equal(state.proxyHealth['proxy-legacy-leased']?.status, 'healthy');
  assert.equal(state.events.some((record) => record.type === 'proxy_health_reset_on_resume'), false);

  // The resumed run refuses to bind any of them, even though they remain in the
  // catalog it is handed.
  const bound = [];
  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([{ id: 'mail-resume-burn', email: 'resume-burn@example.test', tokenValid: true, bound: false }]),
    proxyEntries: [
      { id: 'proxy-spent-recently', url: 'http://proxy-spent-recently:4101' },
      { id: 'proxy-spent-long-ago', url: 'http://proxy-spent-long-ago:4102' },
      { id: 'proxy-undated', url: 'http://proxy-undated:4103' },
      { id: 'proxy-fresh', url: 'http://proxy-fresh:4104' },
    ],
    proxyProbeExecutor: async (_request, probeOptions) => ({ response: { status: 200, url: probeOptions.proxy } }),
    sessionRunnerFactory: ({ job, worker }) => ({
      async run(sessionState) {
        bound.push(worker.proxyId);
        finishSession(sessionState, job);
      },
    }),
  });

  assert.deepEqual(bound, ['proxy-fresh'], 'a retired address must never be offered again');
});

test('a terminal run can resume uncertain email-send and account-create checkpoints', () => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 2,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-auth-checkpoint-resume' });
  state.status = 'failed';
  state.phase = 'failed';
  state.jobs = [
    {
      id: 'job-uncertain-email',
      status: 'failed',
      phase: 'failed',
      mailboxId: 'mail-uncertain-email',
      sessionAssetId: '',
      sessionState: {
        step: 'identity_submitted',
        emailOtpSendRecovery: { status: 'uncertain', retryCount: 0 },
      },
      error: { code: 'EMAIL_OTP_SEND_TIMEOUT', message: 'email send response was lost' },
    },
    {
      id: 'job-uncertain-create',
      status: 'failed',
      phase: 'failed',
      mailboxId: 'mail-uncertain-create',
      sessionAssetId: '',
      sessionState: {
        step: 'email_otp_validated',
        createAccountAttempt: { status: 'uncertain', attempts: 1 },
      },
      error: { code: 'CREATE_ACCOUNT_TIMEOUT', message: 'create_account response was lost' },
    },
    {
      id: 'job-fresh-otp',
      status: 'failed',
      phase: 'failed',
      mailboxId: 'mail-fresh-otp',
      sessionAssetId: '',
      emailOtpRecovery: { action: 'fresh_code', previousStep: 'email_otp_validated' },
      sessionState: { step: 'initial' },
      error: { code: 'OAUTH_ACCOUNT_SELECT_TRANSPORT_FAILED', message: 'proxy recovery interrupted the new OTP transaction' },
    },
  ];

  assert.equal(canResumeBranchState(state), true);

  resumeBranchState(state);

  assert.equal(state.status, 'initialized');
  assert.equal(state.jobs[0].status, 'queued');
  assert.equal(state.jobs[0].phase, 'resuming_email_otp');
  assert.equal(state.jobs[1].status, 'queued');
  assert.equal(state.jobs[1].phase, 'resuming_created_account');
  assert.equal(state.jobs[2].status, 'queued');
  assert.equal(state.jobs[2].phase, 'resuming_email_otp');
  assert.equal(state.jobs.every((job) => job.error === null), true);
  assert.equal(state.events.some((event) => event.type === 'email_otp_recovery_queued'), true);
  assert.equal(state.events.some((event) => event.type === 'created_account_recovery_queued'), true);
});

test('a verified created-account checkpoint can recover after login-state persistence failed', () => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-verified-asset-recovery' });
  state.status = 'failed';
  state.phase = 'failed';
  state.jobs = [{
    id: 'job-verified-asset-recovery',
    status: 'failed',
    phase: 'failed',
    mailboxId: 'mail-verified-asset-recovery',
    sessionAssetId: '',
    accountCreatedAt: '2026-09-14T18:09:00.000Z',
    sessionState: {
      step: 'verified',
      status: 'partial',
      accountCreated: true,
      security: { passwordStatus: 'failed', totpStatus: 'configured' },
    },
    error: { code: 'SESSION_ASSET_SAVE_FAILED', message: 'login-state persistence failed' },
  }];

  assert.equal(canResumeBranchState(state), true);
  resumeBranchState(state);

  assert.equal(state.status, 'initialized');
  assert.equal(state.jobs[0].status, 'queued');
  assert.equal(state.jobs[0].phase, 'resuming_created_account');
  assert.equal(state.jobs[0].error, null);
  assert.equal(state.events.at(-1).type, 'created_account_recovery_queued');
});

test('a forced shared mailbox baseline is fresh and remains single-flight under concurrency', { timeout: 10000 }, async (t) => {
  const config = branchConfig(1);
  config.mail.provider = 'fastmail';
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-forced-mail-baseline' });
  const mail = mailboxClient([{
    id: 'mail-forced-baseline',
    email: 'alias@fastmail.com',
    parent: 'root@fastmail.com',
    rootEmail: 'root@fastmail.com',
    tokenValid: true,
    bound: false,
  }]);
  mail.remoteRegistrationAddresses = true;
  mail.consumeMailbox = async (id) => ({ mailbox: { id }, recycle: null });
  let snapshots = 0;
  let activeSnapshots = 0;
  let maxActiveSnapshots = 0;
  mail.snapshotMailbox = async () => {
    snapshots += 1;
    activeSnapshots += 1;
    maxActiveSnapshots = Math.max(maxActiveSnapshots, activeSnapshots);
    await new Promise((resolve) => setTimeout(resolve, 10));
    activeSnapshots -= 1;
    return {
      messageIds: [`baseline-${snapshots}`],
      capturedAt: `2026-08-31T00:0${snapshots}:00.000Z`,
    };
  };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    sessionRunnerFactory: ({ job, options }) => ({
      async run(sessionState) {
        const initial = await options.beforeEmailSend(job.email, sessionState, {
          fresh: true,
          purpose: 'registration_identity',
        });
        const [forcedA, forcedB] = await Promise.all([
          options.beforeEmailSend(job.email, sessionState, {
            fresh: true,
            forceFresh: true,
            purpose: 'registration_identity',
          }),
          options.beforeEmailSend(job.email, sessionState, {
            fresh: true,
            forceFresh: true,
            purpose: 'registration_identity',
          }),
        ]);
        assert.deepEqual(initial.messageIds, ['baseline-1']);
        assert.deepEqual(forcedA.messageIds, ['baseline-2']);
        assert.deepEqual(forcedB.messageIds, ['baseline-2']);
        sessionState.emailBoundary = forcedA;
        finishSession(sessionState, job);
      },
    }),
  });

  assert.equal(state.status, 'complete');
  assert.equal(snapshots, 2);
  assert.equal(maxActiveSnapshots, 1);
  assert.equal(state.events.some((event) => event.type === 'email_boundary_captured' && event.forceFresh === true), true);
});

test('branch summary reports the mailbox rental for both modes, not only the unified broker', () => {
  const config = branchConfig(2);
  // The rental channel needs its own price ceiling and key, the same way the
  // other SMSBower mail tests set it up; without them config normalization
  // rejects the fixture before the summary is ever built.
  config.mail = { ...config.mail, provider: 'smsbower', service: 'dr', domain: 'gmail.com', maxPrice: 0.2, apiKey: 'mail-key' };
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailProvider: 'smsbower',
    mailCount: 4,
    workerConcurrency: 2,
    aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-plain-rental' });
  const rentedAt = new Date(Date.parse('2026-09-22T10:00:00.000Z')).toISOString();
  state.mailboxes = [
    // Taken into a registration attempt: no longer burning its start window.
    { id: 'mail-started', email: 'started@example.test', rented: true, rentedAt, registrationState: 'started' },
    // Held and idle: this is the deadline the strip counts down to.
    { id: 'mail-idle', email: 'idle@example.test', rented: true, rentedAt, registrationState: 'not_started', registrationStartDeadlineAt: '2026-09-22T10:24:00.000Z' },
    // Reclaimed by the provider after the window closed.
    { id: 'mail-expired', email: 'expired@example.test', rented: true, rentedAt, registrationState: 'expired', registrationStartExpiredAt: '2026-09-22T10:24:00.000Z', rentalClosed: 'cancelled' },
  ];
  state.mailRentalRetry = { attempts: 2, firstAt: rentedAt, nextRunAt: '2026-09-22T10:05:00.000Z', lastError: { code: 'MAIL_RENTAL_SOLD_OUT' } };

  const rental = summarizeBranchState(state).mailRental;
  assert.equal(rental.mode, 'normal');
  assert.equal(rental.target, 4);
  assert.equal(rental.claimedCount, 3);
  assert.equal(rental.activeCount, 2);
  assert.equal(rental.awaitingStartCount, 1);
  assert.equal(rental.expiredCount, 1);
  assert.equal(rental.nextStartDeadlineAt, '2026-09-22T10:24:00.000Z');
  assert.equal(rental.startWindowMs, 24 * 60 * 1000);
  assert.equal(rental.retryAt, '2026-09-22T10:05:00.000Z');
  assert.equal(rental.retryAttempts, 2);
  assert.equal(rental.lastError.code, 'MAIL_RENTAL_SOLD_OUT');

  // The unified broker fills the same shape, and keeps its own machinery
  // beside it rather than inside it.
  const watched = makeInitialBranchState(config, normalizeRunPlan({
    taskKind: 'register_session',
    mailProvider: 'smsbower',
    mailCount: 4,
    workerConcurrency: 2,
    aliasStrategy: 'root',
    mailRentalWatch: true,
    mailRentalTarget: 40,
  }, config), { runId: 'branch-watch-rental' });
  watched.mailboxes = [{ id: 'mail-1', email: 'one@example.test', rented: true, rentedAt, registrationState: 'started' }];
  watched.mailRentalWatch.claimedCount = 9;
  const watchedSummary = summarizeBranchState(watched);
  assert.equal(watchedSummary.mailRental.mode, 'watch');
  assert.equal(watchedSummary.mailRental.target, 40);
  assert.equal(watchedSummary.mailRental.claimedCount, 9);
  assert.equal(watchedSummary.mailRentalWatch.enabled, true);

  // A pooled mail channel rents nothing, so there is no rental to report.
  const pooled = makeInitialBranchState(branchConfig(1), normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, branchConfig(1)), { runId: 'branch-pooled' });
  assert.equal(summarizeBranchState(pooled).mailRental, null);
});

// A code that arrives just past the OAuth poll deadline. Cleanup used to find
// it, complete (pay for) the activation, and hand the job a fresh number — the
// code was bought and never entered, and the ledger booked it as a code that
// never came.
function lateCodeOAuthFixture(t, name, smsOverrides) {
  const config = branchConfig(1);
  config.sms.codeTimeoutMs = 1;
  config.sms.replacementBudget = 2;
  const store = temporaryStore(t);
  const seed = makeInitialChatGptSessionState({ email: `${name}@example.test` });
  const asset = store.upsert({
    email: seed.email,
    parentEmail: seed.email,
    accountId: `account-${name}`,
    cookieJar: seed.cookieJar,
    clientProfile: seed.clientProfile,
    clientProfileFingerprint: seed.clientProfileFingerprint,
    oaiDid: seed.oaiDid,
    status: 'valid',
  });
  const plan = normalizeRunPlan({
    taskKind: 'oauth',
    workerConcurrency: 1,
    oauthSource: { kind: 'session_assets', assetIds: [asset.id] },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: `branch-${name}` });
  const clock = { now: Date.parse('2026-09-26T09:06:50.000Z') };
  const calls = { acquire: 0, complete: [], cancel: [], validated: [] };
  const smsProvider = {
    service: 'mock', country: '151',
    async preflight() { return { provider: 'mock', ready: true }; },
    async acquireNumber() {
      calls.acquire += 1;
      return {
        id: `activation-${calls.acquire}`,
        activationId: `activation-${calls.acquire}`,
        number: `+5691234000${calls.acquire}`,
        status: 'leased',
        cost: 0.047,
      };
    },
    async markSmsSent(lease) { return { ...lease, status: 'waiting' }; },
    async pollCode() { return { code: '', status: 'waiting' }; },
    async cancel(lease) { calls.cancel.push(lease.activationId); return { ...lease, status: 'cancelled' }; },
    async complete(lease) { calls.complete.push(lease.activationId); return { ...lease, status: 'complete' }; },
    ...smsOverrides(calls, clock),
  };
  const run = () => runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: store,
    smsProvider,
    now: () => clock.now,
    sleep: async (milliseconds) => { clock.now += Number(milliseconds || 0); },
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) { finishSession(sessionState, job); },
    }),
    oauthRunnerFactory: () => ({
      async run(oauthState) {
        if (oauthState.step === 'initial') oauthState.step = 'phone_required';
        else if (oauthState.step === 'navigating') {
          oauthState.step = 'complete';
          oauthState.status = 'complete';
          oauthState.account = { email: oauthState.email, access_token: `${name}-cpa` };
        }
      },
      async sendPhone(oauthState) { oauthState.step = 'phone_otp_sent'; },
      async validatePhone(oauthState, code) {
        calls.validated.push(code);
        oauthState.step = 'navigating';
      },
    }),
  });
  return { state, calls, run };
}

test('an OAuth code that arrives after the poll deadline is validated instead of replacing the number', async (t) => {
  const { state, calls, run } = lateCodeOAuthFixture(t, 'oauth-late-code', () => ({
    async reconcile(lease) {
      return { ...lease, status: 'code_received', providerStatus: 'STATUS_OK', code: '654321', codeReceived: true };
    },
  }));
  await run();

  const job = state.jobs[0];
  assert.equal(state.status, 'complete');
  assert.equal(calls.acquire, 1, 'the paid number must not be replaced');
  assert.deepEqual(calls.validated, ['654321']);
  assert.deepEqual(calls.complete, ['activation-1']);
  assert.deepEqual(calls.cancel, []);
  assert.equal(job.sms.replacements, 0);
  assert.equal(job.sms.attempts.length, 1);
  assert.equal(job.sms.attempts[0].status, 'complete');
  assert.equal(job.sms.attempts[0].cleanupReason, 'phone_verified');
  assert.equal(job.sms.attempts[0].lateCodeRecovered, true);
  assert.equal(state.events.some((record) => record.type === 'sms_late_code_recovered'), true);
  assert.equal(state.events.some((record) => record.type === 'sms_number_replacement'), false);
  assert.equal(summarizeSmsCost(job).wastedConsumedUsd, 0);
});

test('OAuth polling reads the activation once more on the deadline itself', async (t) => {
  let deadlineReads = 0;
  const { state, calls, run } = lateCodeOAuthFixture(t, 'oauth-deadline-read', (_calls, clock) => ({
    async pollCode(lease) {
      if (clock.now < Date.parse(lease.codeDeadlineAt)) return { code: '', status: 'waiting' };
      deadlineReads += 1;
      return { code: '112233', status: 'received' };
    },
  }));
  await run();

  assert.equal(state.status, 'complete');
  assert.equal(deadlineReads, 1);
  assert.equal(calls.acquire, 1);
  assert.deepEqual(calls.validated, ['112233']);
  assert.equal(state.jobs[0].sms.replacements, 0);
});

test('a code found only by the timeout cleanup is validated, not paid for and replaced', async (t) => {
  // ui-20260928104010-sskjn6, activation 682710490: the post-deadline read
  // still said WAIT_CODE, cleanup's own read seconds later saw the code,
  // settled the activation and the job bought a fresh number anyway.
  let reconcileCalls = 0;
  const { state, calls, run } = lateCodeOAuthFixture(t, 'oauth-late-code-race', () => ({
    async reconcile(lease) {
      reconcileCalls += 1;
      // The handoff read still sees nothing; the code lands before cleanup's.
      return reconcileCalls === 1
        ? { ...lease, status: 'waiting_code', providerStatus: 'STATUS_WAIT_CODE' }
        : { ...lease, status: 'code_received', providerStatus: 'STATUS_OK', code: '999999', codeReceived: true };
    },
  }));
  await run();

  const job = state.jobs[0];
  assert.equal(state.status, 'complete');
  assert.equal(calls.acquire, 1, 'the number whose code arrived must not be replaced');
  assert.deepEqual(calls.validated, ['999999']);
  assert.deepEqual(calls.cancel, []);
  assert.deepEqual(calls.complete, ['activation-1']);
  assert.equal(job.sms.replacements, 0);
  assert.equal(job.sms.attempts.length, 1);
  assert.equal(job.sms.attempts[0].cleanupReason, 'phone_verified');
  assert.equal(job.sms.attempts[0].lateCodeRecovered, true);
  const recovered = state.events.find((record) => record.type === 'sms_late_code_recovered');
  assert.equal(recovered?.source, 'timeout_cleanup');
  assert.equal(state.events.some((record) => record.type === 'sms_number_replacement'), false);
  const summary = summarizeSmsCost(job);
  assert.equal(summary.wastedConsumedUsd, 0);
  assert.equal(summary.wastedReasons.SMS_LATE_CODE, undefined);
  assert.equal(summary.wastedReasons.SMS_CODE_TIMEOUT, undefined);
});

test('a timeout cancel refused because the code landed validates that code', async (t) => {
  let reconcileCalls = 0;
  let cancelRefused = false;
  const { state, calls, run } = lateCodeOAuthFixture(t, 'oauth-late-code-cancel-refused', (callLog) => ({
    async reconcile(lease) {
      reconcileCalls += 1;
      // Every read before the cancel is WAIT_CODE; the code lands in between.
      return cancelRefused
        ? { ...lease, status: 'code_received', providerStatus: 'STATUS_OK', code: '778899', codeReceived: true }
        : { ...lease, status: 'waiting_code', providerStatus: 'STATUS_WAIT_CODE' };
    },
    async cancel(lease) {
      callLog.cancel.push(lease.activationId);
      cancelRefused = true;
      throw Object.assign(new Error('BAD_STATUS'), { code: 'BAD_STATUS', action: 'setStatus' });
    },
  }));
  await run();

  const job = state.jobs[0];
  assert.equal(state.status, 'complete');
  assert.ok(reconcileCalls >= 3);
  assert.equal(calls.acquire, 1);
  assert.deepEqual(calls.cancel, ['activation-1']);
  assert.deepEqual(calls.validated, ['778899']);
  assert.deepEqual(calls.complete, ['activation-1']);
  assert.equal(job.sms.replacements, 0);
  assert.equal(job.sms.attempts[0].cleanupReason, 'phone_verified');
  assert.equal(state.events.some((record) => record.type === 'sms_number_replacement'), false);
  assert.equal(summarizeSmsCost(job).wastedConsumedUsd, 0);
});

test('a pre-send boundary re-reads a sequential mailbox instead of reusing the cached one', async () => {
  // Account 2 of ui-20261011022322-pmhe10: the callback re-login reused the
  // registration boundary (fresh:false), so the duplicate registration code
  // still queued on the SMSBower rental was validated as the login code.
  const { validateV2Config } = require('../src/config-v2');
  const { _emailBoundary: emailBoundary, _waitEmailCode: waitEmailCode } = require('../src/branch-orchestrator');
  const snapshots = [];
  let reads = 0;
  const sequential = {
    sequentialCodes: true,
    snapshotMailbox: async (_id, options) => {
      snapshots.push(options);
      return { messageIds: ['m#2'], capturedAt: '2026-10-11T02:25:50.000Z', drainedStaleCodes: 1 };
    },
    findVerificationCode: async () => {
      reads += 1;
      return { code: '222222', messageId: 'm#3' };
    },
  };
  const config = validateV2Config(branchConfig());
  const context = {
    config,
    state: { events: [] },
    mailClient: sequential,
    mailAccounts: [{ id: 'm', email: 'relogin@gmail.com', tokenValid: true }],
    mailReady: Promise.resolve(),
    checkpoint: async () => {},
    action: () => null,
  };
  const job = {
    id: 'job-relogin',
    mailboxId: 'm',
    email: 'relogin@gmail.com',
    emailBoundary: { messageIds: [], capturedAt: '2026-10-11T02:24:03.000Z' },
  };

  // Post-send style call (no preSend): the cached boundary is still returned.
  assert.equal(await emailBoundary(job, context, { purpose: 'registration' }), job.emailBoundary);
  assert.equal(snapshots.length, 0);

  const boundary = await emailBoundary(job, context, { purpose: 'registration', preSend: true });
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].drainStaleCodes, true);
  assert.deepEqual(boundary.messageIds, ['m#2']);
  const captured = context.state.events.find((record) => record.type === 'email_boundary_captured');
  assert.equal(captured.drainedStaleCodes, 1);

  // The queued follow-up read answers only for a sequential provider.
  const queued = await waitEmailCode(job, job.email, boundary, context, null, { nextQueuedCode: true, reportDelivery: false });
  assert.equal(queued.code, '222222');
  const inbox = { ...context, mailClient: { ...sequential, sequentialCodes: false } };
  assert.equal(await waitEmailCode(job, job.email, boundary, inbox, null, { nextQueuedCode: true }), null);
  assert.equal(reads, 1);
});

test('a callback re-login cut off by a dead exit restarts the login on the new exit', async (t) => {
  // Account 2 of ui-20261011022322-pmhe10: the re-login hit ECONNRESET, the
  // fresh-exit restart kept the half-done login (as if it were a callback
  // checkpoint), and every later pass failed SENTINEL_PROXY_IDENTITY_CHANGED.
  const config = branchConfig(1);
  config.proxyPool.required = true;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-relogin-fresh-exit' });
  const calls = [];
  let deadExit = '';

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([{ id: 'mail-relogin', email: 'relogin@example.test', tokenValid: true, bound: false }]),
    proxyEntries: [{ id: 'exit-a', url: 'http://exit-a:4101' }, { id: 'exit-b', url: 'http://exit-b:4102' }],
    proxyProbeExecutor: async (_request, probeOptions) => ({ response: { status: 200, url: probeOptions.proxy } }),
    retryPolicies: {
      waiting_proxy_retry: { delaysMs: [1], maxRetries: 1, proxyAction: 'keep', onExhausted: 'restart_on_fresh_exit' },
      waiting_proxy_rotation: { delaysMs: [1], maxRetries: 3, proxyAction: 'already_rotated' },
    },
    sessionRunnerFactory: ({ job, worker }) => ({
      async run(sessionState, options = {}) {
        calls.push({
          step: sessionState.step,
          identity: sessionState.clientIdentity?.proxy || '',
          existingOnly: options.existingOnly === true,
          password: sessionState.password,
          proxyId: worker.proxyId,
        });
        if (calls.length === 1) {
          sessionState.password = 'registered-password';
          sessionState.accountCreated = true;
          sessionState.step = 'auth_callback_pending';
          job.accountCreatedAt = new Date().toISOString();
          throw Object.assign(new Error('NextAuth callback returned an error page (error_param:OAuthCallback)'), {
            code: 'AUTH_CALLBACK_ERROR_PAGE', accountCreated: true,
          });
        }
        deadExit = deadExit || worker.proxyId;
        if (worker.proxyId === deadExit) {
          // The re-login gets as far as the identity page on this exit, then
          // the exit dies (and stays dead for the same-exit retry).
          sessionState.step = 'nextauth_ready';
          sessionState.clientIdentity = { profile: 'p', did: 'd', proxy: `hash-${worker.proxyId}` };
          throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        }
        if (sessionState.clientIdentity && sessionState.clientIdentity.proxy !== `hash-${worker.proxyId}`) {
          throw Object.assign(new Error('Firefox client identity changed within the same runner at proxy'), {
            code: 'SENTINEL_PROXY_IDENTITY_CHANGED', retryable: true, category: 'transient',
          });
        }
        finishSession(sessionState, job);
      },
    }),
  });

  const job = state.jobs[0];
  assert.equal(job.status, 'complete', JSON.stringify(state.events.slice(-12).map((record) => [record.type, record.code])));
  const last = calls.at(-1);
  assert.equal(last.step, 'initial', 'the login starts over instead of resuming the old transaction');
  assert.equal(last.identity, '');
  assert.equal(last.existingOnly, true);
  assert.equal(last.password, 'registered-password');
  assert.equal(state.events.some((record) => record.code === 'SENTINEL_PROXY_IDENTITY_CHANGED'), false);
  const restarted = state.events.find((record) => record.type === 'registration_restarted_on_fresh_exit');
  assert.equal(restarted?.callbackLoginRebuilt, true);
  assert.equal(job.callbackLoginRecovery.status, 'complete');
});

test('a re-login carrying an identity from an earlier exit is rebuilt instead of retried', async (t) => {
  // Older checkpoints already hold the mismatched identity; the run must
  // rebuild the login once and continue, not burn transient retries on it.
  const config = branchConfig(1);
  config.aliases.strategy = 'root';
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-relogin-identity' });
  const calls = [];

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    retryPolicies: { waiting_transient: { delaysMs: [60_000], maxRetries: 5 } },
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([{ id: 'mail-identity', email: 'identity@example.test', tokenValid: true, bound: false }]),
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState, options = {}) {
        calls.push({ step: sessionState.step, existingOnly: options.existingOnly === true, password: sessionState.password });
        if (calls.length === 1) {
          sessionState.password = 'registered-password';
          sessionState.accountCreated = true;
          sessionState.step = 'auth_callback_pending';
          throw Object.assign(new Error('NextAuth callback returned an error page'), {
            code: 'AUTH_CALLBACK_ERROR_PAGE', accountCreated: true,
          });
        }
        if (calls.length === 2) {
          sessionState.step = 'nextauth_ready';
          throw Object.assign(new Error('Firefox client identity changed within the same runner at proxy'), {
            code: 'SENTINEL_PROXY_IDENTITY_CHANGED', retryable: true, category: 'transient',
          });
        }
        finishSession(sessionState, job);
      },
    }),
  });

  assert.equal(calls.length, 3);
  assert.equal(calls[2].step, 'initial');
  assert.equal(calls[2].existingOnly, true);
  assert.equal(calls[2].password, 'registered-password');
  assert.equal(state.jobs[0].status, 'complete');
  assert.equal(state.jobs[0].callbackLoginRecovery.sessionRebuilds, 1);
  assert.equal(state.events.some((record) => record.type === 'callback_login_session_rebuilt'), true);
  assert.equal(state.events.some((record) => record.type === 'branch_job_retry_scheduled' && record.waitPhase === 'waiting_transient'), false);
});

test('an iCloud mailbox with the alias switch registers root and +alias, then consumes the address once', async (t) => {
  const config = branchConfig(1);
  config.mail.provider = 'icloud';
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 1,
    workerConcurrency: 1,
    mailProvider: 'icloud',
    aliasEnabled: true,
    security: { setPassword: true, enrollTotp: true },
  }, config);
  assert.equal(plan.aliasCount, 2);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-icloud-alias' });
  const mail = mailboxClient([{ id: 'icloud-root', email: 'apple@icloud.com', tokenValid: true, bound: false }]);
  mail.remoteRegistrationAddresses = true;
  const consumed = [];
  const recipientsAtConsume = [];
  const registered = [];
  mail.consumeMailbox = async (id) => {
    consumed.push(String(id));
    recipientsAtConsume.push([...registered]);
    return { mailbox: { id, cycle: 1 }, recycle: null };
  };
  mail.snapshotMailbox = async () => ({ messageIds: [], capturedAt: new Date().toISOString() });

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        registered.push(job.email);
        finishSession(sessionState, job);
      },
    }),
  });

  const emails = state.jobs.map((job) => job.email);
  assert.equal(emails.length, 2, JSON.stringify(state.events.slice(-8).map((record) => [record.type, record.message])));
  assert.equal(emails[0], 'apple@icloud.com');
  assert.match(emails[1], /^apple\+[A-Za-z0-9]+@icloud\.com$/);
  assert.ok(state.jobs.every((job) => job.status === 'complete'));
  assert.ok(state.jobs.every((job) => String(job.mailboxId) === 'icloud-root'));
  // One consume for the shared address, only after both accounts finished.
  assert.deepEqual(consumed, ['icloud-root']);
  assert.equal(recipientsAtConsume[0].length, 2);
  assert.ok(state.jobs.every((job) => job.remoteMailboxConsumedAt));
});

test('a completed account sheds its login working set from the run state but keeps its bookkeeping', async (t) => {
  const { _compactCompletedJob: compact } = require('../src/branch-orchestrator');
  const config = branchConfig(1);
  const plan = normalizeRunPlan({ taskKind: 'register_session', mailCount: 2, workerConcurrency: 1 }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-compact-complete' });
  const store = temporaryStore(t);
  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: store,
    mailClient: mailboxClient([1, 2].map((n) => ({ id: `compact-${n}`, email: `compact-${n}@example.test`, tokenValid: true, bound: false }))),
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        finishSession(sessionState, job);
        sessionState.session = { user: { email: job.email }, padding: 'x'.repeat(4000) };
        sessionState.sentinelHeaders = { 'openai-sentinel-token': 'y'.repeat(4000) };
      },
    }),
  });

  assert.equal(state.status, 'complete');
  for (const job of state.jobs) {
    assert.equal(job.status, 'complete');
    assert.equal(job.stateCompacted, 2);
    for (const key of ['session', 'sentinelHeaders', 'cookieJar', 'accessToken', 'sessionToken']) {
      assert.equal(job.sessionState[key], undefined, `${key} should be dropped`);
    }
    // What summaries and registration bookkeeping read is still there.
    assert.equal(job.sessionState.step, 'verified');
    assert.ok(job.sessionAssetId);
    // The asset itself keeps the login.
    assert.ok(store.get(job.sessionAssetId).cookieJar);
  }
  assert.doesNotThrow(() => summarizeBranchState(state));

  // Only complete jobs are touched: anything still retryable keeps its state.
  const partial = { status: 'partial', sessionState: { step: 'verified', cookieJar: { a: 1 } } };
  assert.equal(compact(partial), false);
  assert.deepEqual(partial.sessionState.cookieJar, { a: 1 });
  const failed = { status: 'failed', oauthState: { tokens: { access_token: 'keep' } } };
  assert.equal(compact(failed), false);
  assert.equal(failed.oauthState.tokens.access_token, 'keep');
});

test('a run logs the minutes in which the process blocked itself', async (t) => {
  const config = branchConfig(1);
  const plan = normalizeRunPlan({ taskKind: 'register_session', mailCount: 1, workerConcurrency: 1 }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-stall-monitor' });
  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    eventLoopStallWindowMs: 60,
    eventLoopStallReportMs: 80,
    mailClient: mailboxClient([{ id: 'stall-1', email: 'stall-1@example.test', tokenValid: true, bound: false }]),
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        const startedAt = performance.now();
        while (performance.now() - startedAt < 200) { /* a synchronous stall */ }
        // Let the monitor's window close with the stall in it.
        await new Promise((resolve) => setTimeout(resolve, 150));
        finishSession(sessionState, job);
      },
    }),
  });
  const stall = state.events.find((record) => record.type === 'event_loop_stalled');
  assert.ok(stall, 'the stall is reported');
  assert.ok(stall.maxMs >= 150, `reported ${stall.maxMs}ms`);
  assert.match(stall.message, /local, not the proxies/);
});

test('checkpoint saves leave the event loop at least as long as each save blocked it', async (t) => {
  const config = branchConfig(3);
  const plan = normalizeRunPlan({ taskKind: 'register_session', mailCount: 3, workerConcurrency: 3 }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-checkpoint-pacing' });
  const SAVE_MS = 25;
  const saves = [];
  // A save is synchronous in production (serialize + fsync); model that.
  const blockingSave = async () => {
    const startedAt = performance.now();
    while (performance.now() - startedAt < SAVE_MS) { /* block the loop */ }
    saves.push({ startedAt, endedAt: performance.now() });
  };
  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
      assetStore: temporaryStore(t),
      saveState: blockingSave,
      mailClient: mailboxClient([1, 2, 3].map((n) => ({ id: `pace-${n}`, email: `pace-${n}@example.test`, tokenValid: true, bound: false }))),
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        finishSession(sessionState, job);
      },
    }),
  });

  assert.equal(state.status, 'complete');
  assert.ok(saves.length > 3, `expected several saves, got ${saves.length}`);
  for (let index = 1; index < saves.length; index += 1) {
    const gap = saves[index].startedAt - saves[index - 1].endedAt;
    assert.ok(gap >= SAVE_MS * 0.8, `save ${index} started ${gap.toFixed(1)}ms after the previous one`);
  }
});

test('a root and its alias leave from different exits on the same Worker', async (t) => {
  const config = branchConfig(1);
  config.proxyPool.required = true;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasEnabled: true,
  }, config);
  assert.equal(plan.aliasCount, 2);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-alias-own-exit' });
  const seen = [];

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([{ id: 'mail-own-exit', email: 'own-exit@example.test', tokenValid: true, bound: false }]),
    proxyEntries: [
      { id: 'exit-a', url: 'http://exit-a:4101' },
      { id: 'exit-b', url: 'http://exit-b:4102' },
      { id: 'exit-c', url: 'http://exit-c:4103' },
    ],
    proxyProbeExecutor: async (_request, probeOptions) => ({ response: { status: 200, url: probeOptions.proxy } }),
    sessionRunnerFactory: ({ job, worker }) => ({
      async run(sessionState) {
        seen.push({ email: job.email, worker: worker.id, proxyId: worker.proxyId });
        finishSession(sessionState, job);
      },
    }),
  });

  assert.equal(seen.length, 2);
  assert.equal(seen[0].worker, seen[1].worker, 'the alias stays on the root\'s Worker');
  assert.notEqual(seen[0].proxyId, seen[1].proxyId, 'each account gets its own exit');
  assert.ok(state.events.some((record) => record.type === 'worker_proxy_released' && record.reason === 'account_finished'));
});

test('iCloud with the alias switch skips a master that already has an account', async (t) => {
  // ui-20261013121736-oep9av: turning the switch on moved iCloud from `root`
  // to `root_plus`, which stopped excluding registered roots, and the run got
  // a master registered on 09-15 — OpenAI answered with a login page.
  const config = branchConfig(1);
  config.mail.provider = 'icloud';
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 1, workerConcurrency: 1,
    mailProvider: 'icloud', aliasEnabled: true, security: { setPassword: true, enrollTotp: true },
  }, config);
  const store = temporaryStore(t);
  store.upsert({ email: 'used@icloud.com', accountId: 'old-account', accessToken: 'old-token', mailProvider: 'icloud' });
  const state = makeInitialBranchState(config, plan, { runId: 'branch-icloud-skip-registered' });
  const mail = mailboxClient([
    { id: 'icloud-used', email: 'used@icloud.com', tokenValid: true, bound: false },
    { id: 'icloud-fresh', email: 'fresh@icloud.com', tokenValid: true, bound: false },
  ]);
  mail.remoteRegistrationAddresses = true;
  mail.consumeMailbox = async (id) => ({ mailbox: { id }, recycle: null });

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: store,
    mailClient: mail,
    sessionRunnerFactory: ({ job }) => ({ async run(sessionState) { finishSession(sessionState, job); } }),
  });

  assert.deepEqual(state.mailboxes.map((mailbox) => mailbox.id), ['icloud-fresh']);
  assert.equal(state.jobs[0].email, 'fresh@icloud.com');
  assert.deepEqual(mail.reserved, ['icloud-fresh']);
});


test('iCloud claims a mailbox only when a Worker is free for it', async (t) => {
  // 8001 returns a claim that has not started registering after 30 minutes;
  // claiming the whole target up front let queued mailboxes expire.
  const config = branchConfig(1);
  config.mail.provider = 'icloud';
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 3, workerConcurrency: 1,
    mailProvider: 'icloud', aliasEnabled: false, security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-icloud-on-demand' });
  const accounts = ['a', 'b', 'c', 'd'].map((name) => ({ id: `icloud-${name}`, email: `${name}@icloud.com`, tokenValid: true, bound: false }));
  const mail = mailboxClient(accounts);
  mail.remoteRegistrationAddresses = true;
  let listed = 0;
  const listAccounts = mail.listAccounts;
  mail.listAccounts = async () => { listed += 1; return listAccounts(); };
  // The second mailbox is taken by someone else between listing and claiming.
  const reserve = mail.reserveMailbox;
  mail.reserveMailbox = async (id) => {
    if (id === 'icloud-b') throw Object.assign(new Error('mailbox is not available'), { code: 'MAILBOX_NOT_AVAILABLE' });
    return reserve(id);
  };
  mail.consumeMailbox = async (id) => ({ mailbox: { id }, recycle: null });
  const reservedWhenRunning = [];

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    sessionRunnerFactory: ({ job }) => ({
      async run(sessionState) {
        reservedWhenRunning.push(mail.reserved.length);
        finishSession(sessionState, job);
      },
    }),
  });

  assert.equal(state.status, 'complete');
  // One claim per free Worker: never more than one mailbox ahead.
  assert.deepEqual(reservedWhenRunning, [1, 2, 3]);
  assert.deepEqual(mail.reserved, ['icloud-a', 'icloud-c', 'icloud-d']);
  assert.deepEqual(state.jobs.map((job) => job.email), ['a@icloud.com', 'c@icloud.com', 'd@icloud.com']);
  assert.ok(listed >= 3, 'each claim reads the pool as it is now');
  assert.ok(state.events.some((record) => record.type === 'mailbox_claim_skipped' && record.mailboxId === 'icloud-b'));
});

test('an iCloud run whose pool runs dry finishes with the mailboxes it got', async (t) => {
  const config = branchConfig(1);
  config.mail.provider = 'icloud';
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 3, workerConcurrency: 1,
    mailProvider: 'icloud', aliasEnabled: false, security: { setPassword: true, enrollTotp: true },
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-icloud-dry' });
  const accounts = [{ id: 'icloud-only', email: 'only@icloud.com', tokenValid: true, bound: false }];
  const mail = mailboxClient(accounts);
  mail.remoteRegistrationAddresses = true;
  mail.consumeMailbox = async (id) => {
    accounts.splice(0, accounts.length);
    return { mailbox: { id }, recycle: null };
  };

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    sessionRunnerFactory: ({ job }) => ({ async run(sessionState) { finishSession(sessionState, job); } }),
  });

  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].status, 'complete');
  assert.ok(state.mailPoolExhaustedAt);
  assert.ok(state.events.some((record) => record.type === 'mail_pool_exhausted'));
});

for (const code of ['AUTH_CONTINUATION_MISSING', 'SENTINEL_PROXY_IDENTITY_CHANGED']) {
  test(`a created account with no callback signs in once after ${code}`, async (t) => {
    // ui-20261013132014-8pucl9: create_account answered 500, its retry said
    // USER_ALREADY_EXISTS, and with no callback the account was failed, then
    // looped on SENTINEL_PROXY_IDENTITY_CHANGED after an exit change.
    const config = branchConfig(1);
    config.aliases.strategy = 'root';
    const plan = normalizeRunPlan({
      taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root',
    }, config);
    const state = makeInitialBranchState(config, plan, { runId: `branch-created-no-callback-${code}` });
    const calls = [];

    await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
      retryPolicies: { waiting_transient: { delaysMs: [60_000], maxRetries: 5 } },
      assetStore: temporaryStore(t),
      mailClient: mailboxClient([{ id: 'mail-no-callback', email: 'nocallback@example.test', tokenValid: true, bound: false }]),
      sessionRunnerFactory: ({ job }) => ({
        async run(sessionState, options = {}) {
          calls.push({ step: sessionState.step, existingOnly: options.existingOnly === true, password: sessionState.password, identity: Boolean(sessionState.clientIdentity) });
          if (calls.length === 1) {
            sessionState.password = 'registered-password';
            sessionState.security = { ...(sessionState.security || {}), passwordStatus: 'configured' };
            sessionState.accountCreated = true;
            sessionState.step = 'account_created';
            sessionState.clientIdentity = { profile: 'p', did: 'd', proxy: 'old-exit' };
            throw Object.assign(new Error(code === 'AUTH_CONTINUATION_MISSING'
              ? 'Authentication continuation ended before the ChatGPT callback'
              : 'Firefox client identity changed within the same runner at proxy'), {
              code,
              retryable: code !== 'AUTH_CONTINUATION_MISSING',
              ...(code === 'SENTINEL_PROXY_IDENTITY_CHANGED' ? { category: 'transient' } : {}),
            });
          }
          finishSession(sessionState, job);
        },
      }),
    });

    assert.equal(state.jobs[0].status, 'complete', JSON.stringify(state.events.slice(-6).map((record) => [record.type, record.code])));
    assert.equal(calls.length, 2);
    assert.equal(calls[1].step, 'initial');
    assert.equal(calls[1].existingOnly, true);
    assert.equal(calls[1].password, 'registered-password');
    assert.equal(calls[1].identity, false, 'the old exit identity is not carried into the login');
    assert.equal(state.jobs[0].callbackLoginRecovery.status, 'complete');
    assert.equal(state.jobs[0].callbackLoginRecovery.causeCode, code);
  });
}

test('a created account without a callback moved to a fresh exit signs in there', async (t) => {
  const config = branchConfig(1);
  config.proxyPool.required = true;
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailCount: 1, workerConcurrency: 1, aliasStrategy: 'root',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'branch-created-fresh-exit-login' });
  const calls = [];
  let deadExit = '';

  await runBranchOrchestrator({ log: { entries: [] } }, state, config, {
    assetStore: temporaryStore(t),
    mailClient: mailboxClient([{ id: 'mail-fresh-login', email: 'freshlogin@example.test', tokenValid: true, bound: false }]),
    proxyEntries: [{ id: 'exit-a', url: 'http://exit-a:4101' }, { id: 'exit-b', url: 'http://exit-b:4102' }],
    proxyProbeExecutor: async (_request, probeOptions) => ({ response: { status: 200, url: probeOptions.proxy } }),
    retryPolicies: {
      waiting_proxy_retry: { delaysMs: [1], maxRetries: 1, proxyAction: 'keep', onExhausted: 'restart_on_fresh_exit' },
      waiting_proxy_rotation: { delaysMs: [1], maxRetries: 3, proxyAction: 'already_rotated' },
    },
    sessionRunnerFactory: ({ job, worker }) => ({
      async run(sessionState, options = {}) {
        calls.push({ step: sessionState.step, existingOnly: options.existingOnly === true, proxyId: worker.proxyId });
        deadExit = deadExit || worker.proxyId;
        if (worker.proxyId === deadExit) {
          sessionState.password = sessionState.password || 'registered-password';
          sessionState.accountCreated = true;
          sessionState.step = 'account_created';
          job.accountCreatedAt = job.accountCreatedAt || new Date().toISOString();
          throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        }
        finishSession(sessionState, job);
      },
    }),
  });

  assert.equal(state.jobs[0].status, 'complete', JSON.stringify(state.events.slice(-8).map((record) => [record.type, record.code])));
  const last = calls.at(-1);
  assert.notEqual(last.proxyId, deadExit);
  assert.equal(last.step, 'initial');
  assert.equal(last.existingOnly, true);
  assert.equal(state.jobs[0].callbackLoginRecovery.causeCode, 'CALLBACK_CONTINUATION_UNAVAILABLE');
});
