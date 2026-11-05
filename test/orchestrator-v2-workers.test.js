'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildRunManifest } = require('../src/cpa-output');
const { loadHar } = require('../src/har');
const {
  makeInitialOrchestratorV2State,
  resumeOrchestratorV2State,
  runOrchestratorV2,
  updateRunStatus,
} = require('../src/orchestrator-v2');
const { MockSmsProvider } = require('../src/sms-provider');

const STARTED_AT = '2026-07-28T00:00:00.000Z';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function jwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.');
}

function fakeClock() {
  let value = Date.parse(STARTED_AT);
  return {
    now: () => value,
    sleep: async (ms) => { value += ms; },
  };
}

function configFor(tempDir, accounts, options = {}) {
  return {
    schemaVersion: 2,
    runId: options.runId || 'run-v2-workers',
    mail: {
      accounts,
      count: accounts.length,
      timeoutMs: 1000,
      pollIntervalMs: 1,
    },
    aliases: {
      strategy: 'plus',
      count: options.aliasCount || 1,
      runTag: 'worker',
      plusAddressingEnabled: true,
    },
    sms: {
      provider: 'mock',
      replacementBudget: 20,
      pollIntervalMs: 1,
      codeTimeoutMs: 1000,
      inventoryWaitMs: 1000,
    },
    workers: { maxConcurrency: options.maxConcurrency || 1 },
    registration: {
      exchangeToken: true,
      dynamicSentinel: false,
      maxRuntimeMs: options.maxRuntimeMs || 120000,
    },
    proxyPool: options.requiredProxy ? {
      required: true,
      selection: 'random',
      healthCheck: {
        enabled: true,
        probeUrl: 'https://example.test/proxy-health',
        timeoutMs: 1000,
      },
    } : undefined,
    output: {
      stateDir: path.join(tempDir, 'state'),
      cpaDir: path.join(tempDir, 'output'),
    },
  };
}

class MailboxClient {
  constructor(accounts) {
    this.accounts = accounts;
    this.csrfToken = 'csrf-worker-test';
    this.ready = false;
    this.reserved = [];
  }

  async listAccounts() { return this.accounts; }
  async reserveMailbox(id) { this.reserved.push(id); }
  async releaseMailbox() {}
  async snapshotMailbox() {
    return { messageIds: ['baseline-message'], capturedAt: STARTED_AT };
  }

  async findVerificationCode() {
    return this.ready ? {
      code: '717548',
      messageId: 'new-message',
      consumedMessageId: 'new-message',
      receivedAt: '2026-07-28T00:00:01.000Z',
    } : null;
  }
}

function successfulExecutor(har, mailClient) {
  return async (request, step, runner) => {
    if (step.type === 'sentinel') {
      return {
        request,
        response: {
          status: 200,
          url: request.url,
          location: '',
          contentType: 'application/json',
          text: har.log.entries[step.index].response.content.text,
        },
        cookies: { ...runner.cookies, 'oai-did': 'worker-test-did' },
      };
    }

    let status = 200;
    let location = '';
    let json = {};
    if (step.name === 'bootstrap_oauth_authorize') {
      status = 302;
      location = 'https://auth.openai.com/api/oauth/oauth2/auth?worker=1';
    }
    if (step.name === 'bootstrap_oauth_auth') {
      status = 302;
      location = 'https://auth.openai.com/api/accounts/login?login_challenge=worker';
    }
    if (step.name === 'bootstrap_accounts_login') {
      status = 302;
      location = 'https://auth.openai.com/log-in';
    }
    if (step.name === 'authorize_continue') {
      json = { continue_url: 'https://auth.openai.com/create-account/password', page: { type: 'create_account_password' } };
    }
    if (step.name === 'login_authorize_continue') {
      json = { continue_url: 'https://auth.openai.com/log-in/password', page: { type: 'login_password' } };
    }
    if (step.name === 'user_register') {
      json = { continue_url: 'https://auth.openai.com/email-verification', page: { type: 'email_verification' } };
    }
    if (step.name === 'email_otp_send') {
      mailClient.ready = true;
      status = 302;
      location = 'https://auth.openai.com/email-verification';
    }
    if (step.name === 'email_otp_validate') {
      json = { continue_url: 'https://auth.openai.com/add-phone', page: { type: 'add_phone' } };
    }
    if (step.name === 'phone_otp_send') {
      json = { continue_url: 'https://auth.openai.com/phone-verification', page: { type: 'phone_otp_verification' } };
    }
    if (step.name === 'phone_otp_validate') {
      json = { continue_url: 'https://auth.openai.com/about-you', page: { type: 'about_you' } };
    }
    if (step.name === 'create_account' || step.name === 'password_verify') {
      json = {
        continue_url: 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent',
        page: { type: 'sign_in_with_chatgpt_codex_consent' },
        'oai-client-auth-session': {
          workspaces: [{ id: 'workspace-worker', kind: 'personal', name: 'Worker' }],
        },
      };
    }
    if (step.name === 'workspace_select') {
      json = {
        continue_url: 'https://auth.openai.com/api/oauth/oauth2/auth?login_verifier=worker',
        page: { type: 'redirect' },
        'oai-client-auth-session': {
          workspaces: [{ id: 'workspace-worker', kind: 'personal', name: 'Worker' }],
        },
      };
    }
    if (step.name === 'oauth_auth_login_verifier') {
      status = 302;
      location = 'https://auth.openai.com/api/accounts/consent?consent_challenge=worker';
    }
    if (step.name === 'oauth_consent') {
      status = 302;
      location = 'https://auth.openai.com/api/oauth/oauth2/auth?consent_verifier=worker';
    }
    if (step.name === 'oauth_auth_consent_verifier') {
      status = 303;
      location = `http://localhost:1455/auth/callback?code=ac_worker&state=${runner.oauth.state}`;
    }

    return {
      request,
      response: {
        status,
        url: request.url,
        location,
        contentType: 'application/json',
        text: JSON.stringify(json),
      },
      cookies: { ...runner.cookies, 'oai-did': 'worker-test-did' },
    };
  };
}

function tokenResult(request, job, email = job.email) {
  const exp = Math.floor(Date.parse('2026-07-29T00:00:00.000Z') / 1000);
  return {
    request,
    response: {
      status: 200,
      url: request.url,
      contentType: 'application/json',
      text: JSON.stringify({
        id_token: jwt({ email, exp }),
        access_token: jwt({
          email,
          exp,
          'https://api.openai.com/auth': { chatgpt_account_id: 'workspace-worker' },
        }),
        refresh_token: 'refresh-worker',
      }),
    },
  };
}

function seededMailbox(id, email, overrides = {}) {
  return {
    id,
    rootEmail: email,
    status: 'normal_complete',
    successCount: 0,
    createdCount: 1,
    cpaCompletedCount: 0,
    targetCount: 1,
    maxAttempts: 3,
    attemptCount: 1,
    nextAliasIndex: 2,
    normalComplete: true,
    workerId: '',
    proxy: null,
    stopReason: '',
    ...overrides,
  };
}

function seededFinalizationJob(id, mailboxId, email, overrides = {}) {
  return {
    id,
    mailboxId,
    parentEmail: email.replace(/\+[^@]+(?=@)/, ''),
    email,
    aliasIndex: 1,
    replacementOf: '',
    status: 'pending_finalize',
    phase: 'pending_finalize',
    branch: 'login',
    nextRunAt: '',
    password: 'WorkerTestPassword!123',
    workspaceId: 'workspace-worker',
    oauthCode: '',
    callbackUrl: '',
    tokens: null,
    cpaPath: '',
    proxy: null,
    proxyVerifiedAt: '',
    proxyFailure: null,
    accountCreatedAt: STARTED_AT,
    finalization: {
      status: 'queued',
      attempts: 0,
      reason: 'post_create_proxy_failure',
      queuedAt: STARTED_AT,
      originalProxyId: 'proxy-original',
      lastError: '',
    },
    runner: null,
    effect: null,
    sms: {
      current: null,
      attempts: [],
      pendingCleanup: [],
      effect: null,
      replacementWindowUsed: 0,
      codeRetryCount: 0,
    },
    attempts: {
      transient: 0,
      accountCreate: 0,
      phoneContinuity: 0,
      tokenExchange: 0,
    },
    error: null,
    createdAt: STARTED_AT,
    startedAt: STARTED_AT,
    updatedAt: STARTED_AT,
    completedAt: '',
    ...overrides,
  };
}

function seedFinalizationState(config, specs) {
  const clock = fakeClock();
  const state = makeInitialOrchestratorV2State(config, {
    runId: config.runId,
    now: clock.now,
  });
  state.phase = 'finalization';
  state.mailboxes = specs.mailboxes;
  state.jobs = specs.jobs;
  state.finalizationQueue = specs.jobs.map((job) => job.id);
  return { state, clock };
}

test('pending finalization releases the worker and lets the next root claim the slot', async () => {
  const { har } = loadHar();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-worker-handoff-'));
  const accounts = [
    { id: 41, email: 'first@example.test', tokenValid: true, bound: false },
    { id: 42, email: 'second@example.test', tokenValid: true, bound: false },
  ];
  const config = configFor(tempDir, accounts, { runId: 'run-v2-worker-handoff' });
  const clock = fakeClock();
  const state = makeInitialOrchestratorV2State(config, { runId: config.runId, now: clock.now });
  state.workers = [{
    id: 'worker-1',
    status: 'running',
    mailboxId: 41,
    proxyId: '',
    currentJobId: 'job-pending',
    completedRoots: 0,
    createdAt: STARTED_AT,
    updatedAt: STARTED_AT,
  }];
  state.mailboxes = [seededMailbox(41, accounts[0].email, {
    status: 'active',
    normalComplete: false,
    workerId: 'worker-1',
  })];
  state.jobs = [seededFinalizationJob('job-pending', 41, 'first+worker001@example.test')];
  state.finalizationQueue = ['job-pending'];

  const snapshots = [];
  const stopAfterHandoff = async () => {
    const error = new Error('stop after worker handoff');
    error.code = 'ESIMULATEDCRASH';
    error.fatal = true;
    throw error;
  };

  await assert.rejects(runOrchestratorV2(har, state, config, {
    mailClient: new MailboxClient(accounts),
    smsProvider: new MockSmsProvider(),
    executor: stopAfterHandoff,
    now: clock.now,
    sleep: clock.sleep,
    saveState: (next) => { snapshots.push(clone(next)); },
  }), /stop after worker handoff/);

  const first = state.mailboxes.find((mailbox) => mailbox.id === 41);
  const second = state.mailboxes.find((mailbox) => mailbox.id === 42);
  const worker = state.workers[0];
  assert.equal(state.jobs[0].status, 'pending_finalize');
  assert.equal(first.normalComplete, true);
  assert.equal(first.workerId, '');
  assert.equal(first.successCount, 0);
  assert.equal(worker.status, 'running');
  assert.equal(worker.mailboxId, 42);
  assert.equal(second.workerId, worker.id);
  assert.ok(state.jobs.some((job) => job.mailboxId === 42));
  assert.ok(snapshots.every((snapshot) => snapshot.workers.filter((item) => item.status === 'running').length <= 1));

  const releasedAt = state.events.findIndex((event) => event.type === 'worker_released' && event.mailboxId === 41);
  const reboundAt = state.events.findIndex((event) => event.type === 'worker_bound' && event.mailboxId === 42);
  assert.ok(releasedAt >= 0 && reboundAt > releasedAt);
});

test('aliases from one root reuse the mailbox-owned proxy and release it after the lane', async () => {
  const { har } = loadHar();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-worker-proxy-'));
  const accounts = [{ id: 51, email: 'sticky@example.test', tokenValid: true, bound: false }];
  const config = configFor(tempDir, accounts, {
    runId: 'run-v2-worker-proxy',
    aliasCount: 2,
    requiredProxy: true,
  });
  const clock = fakeClock();
  const state = makeInitialOrchestratorV2State(config, { runId: config.runId, now: clock.now });
  const mailClient = new MailboxClient(accounts);
  const snapshots = [];
  const proxyEntries = [{ id: 'proxy-sticky', url: 'http://127.0.0.1:2080' }];

  await runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider: new MockSmsProvider({
      numbers: ['+56970000001', '+56970000002'],
      codes: ['100001', '100002'],
    }),
    executor: successfulExecutor(har, mailClient),
    tokenExecutor: (request, job) => Promise.resolve(tokenResult(request, job)),
    proxyEntries,
    proxyProbeExecutor: async (request) => ({ response: { status: 204, url: request.url, text: '' } }),
    random: () => 0,
    now: clock.now,
    sleep: clock.sleep,
    saveState: (next) => { snapshots.push(clone(next)); },
  });

  assert.equal(state.jobs.length, 2);
  assert.equal(state.jobs.every((job) => job.status === 'complete'), true);
  assert.deepEqual(new Set(state.jobs.map((job) => job.proxy.id)), new Set(['proxy-sticky']));
  const observedOwners = new Set(snapshots.flatMap((snapshot) => Object.keys(snapshot.proxyLeases || {})));
  assert.deepEqual(observedOwners, new Set(['mailbox:51']));
  assert.deepEqual(state.proxyLeases, {});
});

test('successful finalizers use isolated owners and release a proxy for the next finalizer', async () => {
  const { har } = loadHar();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-finalizer-proxy-'));
  const accounts = [{ id: 61, email: 'finalize@example.test', tokenValid: true, bound: false }];
  const config = configFor(tempDir, accounts, {
    runId: 'run-v2-finalizer-proxy',
    requiredProxy: true,
  });
  const mailbox = seededMailbox(61, accounts[0].email, {
    createdCount: 2,
    targetCount: 2,
    attemptCount: 2,
    nextAliasIndex: 3,
  });
  const jobs = [
    seededFinalizationJob('job-finalize-1', 61, 'finalize+worker001@example.test'),
    seededFinalizationJob('job-finalize-2', 61, 'finalize+worker002@example.test', { aliasIndex: 2 }),
  ];
  const { state, clock } = seedFinalizationState(config, { mailboxes: [mailbox], jobs });
  const mailClient = new MailboxClient(accounts);
  const snapshots = [];

  await runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider: new MockSmsProvider(),
    executor: successfulExecutor(har, mailClient),
    tokenExecutor: (request, job) => Promise.resolve(tokenResult(request, job)),
    proxyEntries: [{ id: 'proxy-finalizer', url: 'http://127.0.0.1:2081' }],
    proxyProbeExecutor: async (request) => ({ response: { status: 204, url: request.url, text: '' } }),
    random: () => 0,
    now: clock.now,
    sleep: clock.sleep,
    saveState: (next) => { snapshots.push(clone(next)); },
  });

  const observedOwners = new Set(snapshots.flatMap((snapshot) => Object.keys(snapshot.proxyLeases || {})));
  assert.ok([...observedOwners].every((owner) => owner.startsWith('finalizer:')));
  assert.equal(state.jobs[0].status, 'complete');
  assert.deepEqual(state.proxyLeases, {}, 'a terminal finalizer must not retain its proxy lease');
  assert.equal(state.jobs[1].status, 'complete');
  assert.equal(state.mailboxes[0].successCount, 2);
});

test('schema v2 keeps the root Worker proxy through OAuth finalization', async () => {
  const { har } = loadHar();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-finalizer-continuity-'));
  const accounts = [{ id: 62, email: 'continuous@example.test', tokenValid: true, bound: false }];
  const config = configFor(tempDir, accounts, {
    runId: 'run-v2-finalizer-continuity',
    requiredProxy: true,
  });
  config.workers.proxyAssignments = [{ workerSlot: 1, kind: 'local', localProxyId: 'proxy-continuous' }];
  const proxy = { id: 'proxy-continuous', url: 'http://127.0.0.1:2088', workerSlots: [1] };
  const mailbox = seededMailbox(62, accounts[0].email, {
    workerId: 'worker-1',
    proxy: { id: proxy.id, url: proxy.url, sticky: true, assignedAt: STARTED_AT },
    proxyVerifiedAt: STARTED_AT,
    proxyConsumedByJobId: 'job-finalize-continuous',
  });
  const job = seededFinalizationJob('job-finalize-continuous', 62, 'continuous+worker001@example.test', {
    proxy: { id: proxy.id, url: proxy.url, sticky: true, assignedAt: STARTED_AT },
    proxyVerifiedAt: STARTED_AT,
  });
  const { state, clock } = seedFinalizationState(config, { mailboxes: [mailbox], jobs: [job] });
  state.runPlan = {
    schemaVersion: 2,
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'plus',
    aliasCount: 1,
    aliasMaxAttempts: 3,
    aliasRunTag: 'worker',
    proxyAssignments: config.workers.proxyAssignments,
  };
  state.workers = [{
    id: 'worker-1',
    status: 'running',
    mailboxId: 62,
    proxyId: proxy.id,
    currentJobId: job.id,
    completedRoots: 0,
    createdAt: STARTED_AT,
    updatedAt: STARTED_AT,
  }];
  state.proxyLeases = { 'mailbox:62': proxy.id };
  const snapshots = [];

  await runOrchestratorV2(har, state, config, {
    mailClient: new MailboxClient(accounts),
    smsProvider: new MockSmsProvider(),
    executor: successfulExecutor(har, new MailboxClient(accounts)),
    tokenExecutor: (request, currentJob) => Promise.resolve(tokenResult(request, currentJob)),
    proxyEntries: [proxy],
    proxyProbeExecutor: async (request) => ({ response: { status: 204, url: request.url, text: '' } }),
    now: clock.now,
    sleep: clock.sleep,
    saveState: (next) => { snapshots.push(clone(next)); },
  });

  const observedOwners = new Set(snapshots.flatMap((snapshot) => Object.keys(snapshot.proxyLeases || {})));
  assert.deepEqual(observedOwners, new Set(['mailbox:62']));
  assert.equal(state.jobs[0].proxy.id, proxy.id);
  assert.equal(state.jobs[0].status, 'complete');
  assert.equal(state.workers[0].status, 'idle');
  assert.equal(state.mailboxes[0].proxy, null);
  assert.deepEqual(state.proxyLeases, {});
});

test('a transient finalization error stays queued without recording success and can retry', async () => {
  const { har } = loadHar();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-finalizer-retry-'));
  const accounts = [{ id: 71, email: 'retry@example.test', tokenValid: true, bound: false }];
  const config = configFor(tempDir, accounts, { runId: 'run-v2-finalizer-retry' });
  const job = seededFinalizationJob('job-finalize-retry', 71, 'retry+worker001@example.test');
  const { state, clock } = seedFinalizationState(config, {
    mailboxes: [seededMailbox(71, accounts[0].email)],
    jobs: [job],
  });
  const mailClient = new MailboxClient(accounts);
  const snapshots = [];
  let tokenCalls = 0;

  await runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider: new MockSmsProvider(),
    executor: successfulExecutor(har, mailClient),
    tokenExecutor: async (request, currentJob) => {
      tokenCalls += 1;
      if (tokenCalls === 1) throw new Error('token endpoint temporarily unavailable');
      return tokenResult(request, currentJob);
    },
    now: clock.now,
    sleep: clock.sleep,
    saveState: (next) => { snapshots.push(clone(next)); },
  });

  const retrySnapshot = snapshots.find((snapshot) => (
    snapshot.jobs[0].status === 'pending_finalize'
    && snapshot.jobs[0].finalization?.attempts === 1
    && snapshot.jobs[0].finalization?.lastError === 'token endpoint temporarily unavailable'
  ));
  assert.ok(retrySnapshot);
  assert.equal(retrySnapshot.mailboxes[0].successCount, 0);
  assert.equal(retrySnapshot.jobs[0].cpaPath, '');
  assert.equal(state.jobs[0].status, 'complete');
  assert.equal(state.jobs[0].finalization.attempts, 2);
  assert.equal(state.mailboxes[0].successCount, 1);
});

test('a deterministic token identity failure finalizes once without CPA success', async () => {
  const { har } = loadHar();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-finalizer-deterministic-'));
  const accounts = [{ id: 81, email: 'identity@example.test', tokenValid: true, bound: false }];
  const config = configFor(tempDir, accounts, { runId: 'run-v2-finalizer-deterministic' });
  const job = seededFinalizationJob('job-finalize-identity', 81, 'identity+worker001@example.test');
  const { state, clock } = seedFinalizationState(config, {
    mailboxes: [seededMailbox(81, accounts[0].email)],
    jobs: [job],
  });
  const mailClient = new MailboxClient(accounts);

  await runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider: new MockSmsProvider(),
    executor: successfulExecutor(har, mailClient),
    tokenExecutor: (request, currentJob) => Promise.resolve(tokenResult(request, currentJob, 'other@example.test')),
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(state.jobs[0].status, 'finalize_failed');
  assert.equal(state.jobs[0].cpaPath, '');
  assert.equal(state.mailboxes[0].successCount, 0);
  assert.equal(state.status, 'partial');
  const manifest = JSON.parse(fs.readFileSync(state.manifestPath, 'utf8'));
  assert.equal(manifest.counts.active, 0);
  assert.equal(manifest.counts.exported, 0);
  assert.equal(state.jobs[0].finalization.attempts, 1, 'deterministic identity mismatches must not consume transient retries');
});

test('pending finalization is not reported as a complete run or active CPA account', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-finalizer-status-'));
  const accounts = [{ id: 91, email: 'pending@example.test', tokenValid: true, bound: false }];
  const config = configFor(tempDir, accounts, { runId: 'run-v2-finalizer-status' });
  const job = seededFinalizationJob('job-finalize-pending', 91, 'pending+worker001@example.test');
  const { state } = seedFinalizationState(config, {
    mailboxes: [seededMailbox(91, accounts[0].email)],
    jobs: [job],
  });

  assert.equal(updateRunStatus(state), 'finalizing');
  const manifest = buildRunManifest({
    runId: state.runId,
    status: state.status,
    generatedAt: STARTED_AT,
    jobs: state.jobs,
  });
  assert.equal(manifest.status, 'finalizing');
  assert.equal(manifest.counts.active, 0);
  assert.equal(manifest.counts.exported, 0);
  assert.deepEqual(manifest.counts.byStatus, { pending_finalize: 1 });
  assert.equal(state.mailboxes[0].successCount, 0);
});

test('resume preserves queued finalization instead of bypassing its fresh-attempt setup', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-finalizer-resume-'));
  const accounts = [{ id: 92, email: 'resume@example.test', tokenValid: true, bound: false }];
  const config = configFor(tempDir, accounts, { runId: 'run-v2-finalizer-resume' });
  const job = seededFinalizationJob('job-finalize-resume', 92, 'resume+worker001@example.test');
  const { state } = seedFinalizationState(config, {
    mailboxes: [seededMailbox(92, accounts[0].email)],
    jobs: [job],
  });

  resumeOrchestratorV2State(state);

  assert.equal(job.status, 'pending_finalize');
  assert.equal(job.phase, 'pending_finalize');
  assert.equal(job.finalization.status, 'queued');
  assert.equal(job.finalization.attempts, 0);
  assert.equal(job.runner, null);
});

test('transient finalization failures stop after exactly three fresh login attempts', async () => {
  const { har } = loadHar();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-finalizer-budget-'));
  const accounts = [{ id: 93, email: 'budget@example.test', tokenValid: true, bound: false }];
  const config = configFor(tempDir, accounts, { runId: 'run-v2-finalizer-budget' });
  const job = seededFinalizationJob('job-finalize-budget', 93, 'budget+worker001@example.test');
  const { state, clock } = seedFinalizationState(config, {
    mailboxes: [seededMailbox(93, accounts[0].email)],
    jobs: [job],
  });
  const mailClient = new MailboxClient(accounts);
  let tokenCalls = 0;

  await runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider: new MockSmsProvider(),
    executor: successfulExecutor(har, mailClient),
    tokenExecutor: async () => {
      tokenCalls += 1;
      throw new Error('token endpoint temporarily unavailable');
    },
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(tokenCalls, 3);
  assert.equal(job.finalization.attempts, 3);
  assert.equal(job.status, 'finalize_failed');
  assert.equal(job.cpaPath, '');
  assert.equal(state.status, 'partial');
  assert.equal(state.events.filter((event) => event.type === 'finalization_attempt_started').length, 3);
});
