'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { loadHar } = require('../src/har');
const {
  cancelOrchestratorV2,
  ensureJobs,
  makeInitialOrchestratorV2State,
  resumeOrchestratorV2State,
  runOrchestratorV2,
  skipAliasV2,
  summarizeOrchestratorV2State,
} = require('../src/orchestrator-v2');
const { validateV2Config } = require('../src/config-v2');
const { MockSmsProvider } = require('../src/sms-provider');

const STARTED_AT = '2026-07-28T00:00:00.000Z';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-resources-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function fakeClock() {
  let value = Date.parse(STARTED_AT);
  return {
    now: () => value,
    sleep: async (ms) => { value += ms; },
  };
}

function configFor(directory, accounts, options = {}) {
  return {
    schemaVersion: 2,
    runId: options.runId || 'run-v2-resource-invariants',
    mail: {
      accounts,
      count: accounts.length,
      timeoutMs: 1000,
      pollIntervalMs: 1,
    },
    aliases: {
      strategy: 'plus',
      count: 1,
      runTag: 'resource',
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
      maxRuntimeMs: 120000,
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
      stateDir: path.join(directory, 'state'),
      cpaDir: path.join(directory, 'output'),
    },
  };
}

class MailboxClient {
  constructor(accounts) {
    this.accounts = accounts;
    this.csrfToken = 'csrf-resource-test';
    this.ready = false;
    this.reserved = [];
    this.released = [];
  }

  async listAccounts() { return this.accounts; }
  async reserveMailbox(id) { this.reserved.push(id); }
  async releaseMailbox(id) { this.released.push(id); }
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
        cookies: { ...runner.cookies, 'oai-did': 'resource-test-did' },
      };
    }

    let status = 200;
    let location = '';
    let json = {};
    if (step.name === 'bootstrap_oauth_authorize') {
      status = 302;
      location = 'https://auth.openai.com/api/oauth/oauth2/auth?resource=1';
    }
    if (step.name === 'bootstrap_oauth_auth') {
      status = 302;
      location = 'https://auth.openai.com/api/accounts/login?login_challenge=resource';
    }
    if (step.name === 'bootstrap_accounts_login') {
      status = 302;
      location = 'https://auth.openai.com/log-in';
    }
    if (step.name === 'authorize_continue') {
      json = { continue_url: 'https://auth.openai.com/create-account/password', page: { type: 'create_account_password' } };
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
    if (step.name === 'create_account') {
      json = {
        continue_url: 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent',
        page: { type: 'sign_in_with_chatgpt_codex_consent' },
        'oai-client-auth-session': {
          workspaces: [{ id: 'workspace-resource', kind: 'personal', name: 'Resource' }],
        },
      };
    }
    if (step.name === 'workspace_select') {
      json = {
        continue_url: 'https://auth.openai.com/api/oauth/oauth2/auth?login_verifier=resource',
        page: { type: 'redirect' },
        'oai-client-auth-session': {
          workspaces: [{ id: 'workspace-resource', kind: 'personal', name: 'Resource' }],
        },
      };
    }
    if (step.name === 'oauth_auth_login_verifier') {
      status = 302;
      location = 'https://auth.openai.com/api/accounts/consent?consent_challenge=resource';
    }
    if (step.name === 'oauth_consent') {
      status = 302;
      location = 'https://auth.openai.com/api/oauth/oauth2/auth?consent_verifier=resource';
    }
    if (step.name === 'oauth_auth_consent_verifier') {
      status = 303;
      location = `http://localhost:1455/auth/callback?code=ac_resource&state=${runner.oauth.state}`;
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
      cookies: { ...runner.cookies, 'oai-did': 'resource-test-did' },
    };
  };
}

function jwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.');
}

function tokenResult(request, job) {
  const exp = Math.floor(Date.parse('2026-07-29T00:00:00.000Z') / 1000);
  return {
    request,
    response: {
      status: 200,
      url: request.url,
      contentType: 'application/json',
      text: JSON.stringify({
        id_token: jwt({ email: job.email, exp }),
        access_token: jwt({
          email: job.email,
          exp,
          'https://api.openai.com/auth': { chatgpt_account_id: 'workspace-resource' },
        }),
        refresh_token: 'refresh-resource',
      }),
    },
  };
}

function seededMailbox(id, email, overrides = {}) {
  return {
    id,
    rootEmail: email,
    status: 'active',
    successCount: 0,
    createdCount: 0,
    cpaCompletedCount: 0,
    targetCount: 1,
    maxAttempts: 3,
    attemptCount: 1,
    nextAliasIndex: 2,
    normalComplete: false,
    workerId: '',
    proxy: null,
    proxyVerifiedAt: '',
    proxyConsumedByJobId: '',
    stopReason: '',
    ...overrides,
  };
}

function seededJob(id, mailboxId, email, overrides = {}) {
  return {
    id,
    mailboxId,
    parentEmail: email.replace(/\+[^@]+(?=@)/, ''),
    email,
    aliasIndex: 1,
    replacementOf: '',
    status: 'waiting',
    phase: 'waiting_error',
    branch: 'registration',
    nextRunAt: '',
    password: '',
    workspaceId: '',
    oauthCode: '',
    callbackUrl: '',
    tokens: null,
    cpaPath: '',
    proxy: null,
    proxyVerifiedAt: '',
    proxyFailure: null,
    accountCreatedAt: '',
    finalization: null,
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

function seededWorker(id, overrides = {}) {
  return {
    id,
    status: 'idle',
    mailboxId: null,
    proxyId: '',
    currentJobId: '',
    completedRoots: 0,
    createdAt: STARTED_AT,
    updatedAt: STARTED_AT,
    ...overrides,
  };
}

test('root mode schedules the original mailbox once and never creates initial aliases', (t) => {
  const directory = temporaryDirectory(t);
  const accounts = [{ id: 301, email: 'root-mode@example.test', tokenValid: true, bound: false }];
  const input = configFor(directory, accounts, { runId: 'run-v2-root-mode' });
  input.aliases = { strategy: 'root', count: 6, maxAttempts: 8, plusAddressingEnabled: false };
  const config = validateV2Config(input, { cwd: directory });
  const state = makeInitialOrchestratorV2State(config, { runId: config.runId });
  state.mailboxes = [seededMailbox(301, accounts[0].email, {
    targetCount: config.aliases.count,
    maxAttempts: config.aliases.maxAttempts,
  })];

  ensureJobs({ state, config, now: () => Date.parse(STARTED_AT) });

  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].email, accounts[0].email);
  assert.equal(state.jobs[0].emailStrategy, 'root');
  assert.equal(state.mailboxes[0].targetCount, 1);
  assert.equal(state.mailboxes[0].maxAttempts, 1);
});

test('one healthy proxy binds one root at a time and is reused after the first root releases it', async (t) => {
  const { har } = loadHar();
  const directory = temporaryDirectory(t);
  const accounts = [
    { id: 101, email: 'first@example.test', tokenValid: true, bound: false },
    { id: 102, email: 'second@example.test', tokenValid: true, bound: false },
  ];
  const config = configFor(directory, accounts, {
    runId: 'run-v2-one-proxy-two-roots',
    maxConcurrency: 2,
    requiredProxy: true,
  });
  const clock = fakeClock();
  const state = makeInitialOrchestratorV2State(config, { runId: config.runId, now: clock.now });
  const mailClient = new MailboxClient(accounts);
  const proxy = { id: 'proxy-only', url: 'http://127.0.0.1:2080' };
  const snapshots = [];

  await runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider: new MockSmsProvider({
      numbers: ['+56970000001', '+56970000002'],
      codes: ['100001', '100002'],
    }),
    executor: successfulExecutor(har, mailClient),
    tokenExecutor: (request, job) => Promise.resolve(tokenResult(request, job)),
    proxyEntries: [proxy],
    proxyProbeExecutor: async (request) => ({ response: { status: 204, url: request.url, text: '' } }),
    random: () => 0,
    now: clock.now,
    sleep: clock.sleep,
    saveState: (next) => { snapshots.push(clone(next)); },
  });

  const maximumRunningWorkers = Math.max(...snapshots.map((snapshot) => (
    snapshot.workers.filter((worker) => worker.status === 'running').length
  )));
  const maximumBoundRoots = Math.max(...snapshots.map((snapshot) => (
    snapshot.mailboxes.filter((mailbox) => mailbox.workerId).length
  )));
  assert.equal(maximumRunningWorkers, 1);
  assert.equal(maximumBoundRoots, 1);
  assert.deepEqual(mailClient.reserved, [101, 102]);
  assert.equal(state.jobs.length, 2);
  assert.equal(state.jobs.every((job) => job.status === 'complete'), true);

  const firstOwner = 'mailbox:101';
  const secondOwner = 'mailbox:102';
  const firstOwnedAt = snapshots.findIndex((snapshot) => snapshot.proxyLeases[firstOwner] === proxy.id);
  const firstReleasedAt = snapshots.findIndex((snapshot, index) => (
    index > firstOwnedAt
    && snapshot.proxyLeases[firstOwner] === undefined
    && snapshot.mailboxes.some((mailbox) => mailbox.id === 101 && mailbox.workerId === '')
  ));
  const secondOwnedAt = snapshots.findIndex((snapshot, index) => (
    index > firstReleasedAt && snapshot.proxyLeases[secondOwner] === proxy.id
  ));
  assert.ok(firstOwnedAt >= 0);
  assert.ok(firstReleasedAt > firstOwnedAt);
  assert.ok(secondOwnedAt > firstReleasedAt);
  assert.deepEqual(state.proxyLeases, {});
});

test('skipping the final alias releases its worker and mailbox-owned proxy', async (t) => {
  const directory = temporaryDirectory(t);
  const accounts = [{ id: 201, email: 'skip@example.test', tokenValid: true, bound: false }];
  const config = configFor(directory, accounts, { runId: 'run-v2-skip-final-alias', requiredProxy: true });
  const state = makeInitialOrchestratorV2State(config, { runId: config.runId });
  const proxy = { id: 'proxy-skip', url: 'http://127.0.0.1:2081' };
  const owner = 'mailbox:201';
  state.workers = [seededWorker('worker-1', {
    status: 'running',
    mailboxId: 201,
    proxyId: proxy.id,
    currentJobId: 'job-skip',
  })];
  state.mailboxes = [seededMailbox(201, accounts[0].email, {
    workerId: 'worker-1',
    proxy: { ...proxy, assignedAt: STARTED_AT },
    proxyVerifiedAt: STARTED_AT,
    proxyConsumedByJobId: 'job-skip',
  })];
  state.jobs = [seededJob('job-skip', 201, 'skip+resource001@example.test', {
    proxy: { ...proxy, assignedAt: STARTED_AT },
    proxyVerifiedAt: STARTED_AT,
  })];
  state.proxyLeases = { [owner]: proxy.id };

  await skipAliasV2(state, config, 'job-skip', {
    mailClient: new MailboxClient(accounts),
    smsProvider: new MockSmsProvider(),
    proxyEntries: [proxy],
  });

  assert.equal(state.jobs[0].status, 'skipped');
  assert.deepEqual(
    {
      lease: state.proxyLeases[owner] || '',
      mailboxProxy: state.mailboxes[0].proxy,
      mailboxWorkerId: state.mailboxes[0].workerId,
      workerStatus: state.workers[0].status,
      workerMailboxId: state.workers[0].mailboxId,
      workerProxyId: state.workers[0].proxyId,
      workerCurrentJobId: state.workers[0].currentJobId,
    },
    {
      lease: '',
      mailboxProxy: null,
      mailboxWorkerId: '',
      workerStatus: 'idle',
      workerMailboxId: null,
      workerProxyId: '',
      workerCurrentJobId: '',
    },
  );
});

test('skipping an alias completes an SMS activation when the final status check receives the code', async (t) => {
  const directory = temporaryDirectory(t);
  const accounts = [{ id: 202, email: 'skip-code@example.test', tokenValid: true, bound: false }];
  const config = configFor(directory, accounts, { runId: 'run-v2-skip-code-race' });
  const state = makeInitialOrchestratorV2State(config, { runId: config.runId });
  const lease = {
    id: 'activation-v2-skip-code-race',
    activationId: 'activation-v2-skip-code-race',
    number: '+56970000002',
    status: 'waiting_code',
    providerStatus: 'STATUS_WAIT_CODE',
  };
  state.mailboxes = [seededMailbox(202, accounts[0].email)];
  state.jobs = [seededJob('job-v2-skip-code-race', 202, 'skip-code+resource001@example.test', {
    sms: { current: lease, attempts: [], pendingCleanup: [], effect: null },
  })];
  let reconcileCalls = 0;
  let completeCalls = 0;
  let cancelCalls = 0;
  const smsProvider = {
    async reconcile(current) {
      reconcileCalls += 1;
      return reconcileCalls === 1
        ? { ...current, status: 'waiting_code', providerStatus: 'STATUS_WAIT_CODE' }
        : { ...current, status: 'code_received', providerStatus: 'STATUS_OK', code: '246810' };
    },
    async complete(current) {
      completeCalls += 1;
      return { ...current, status: 'complete', providerStatus: 'STATUS_OK' };
    },
    async cancel() {
      cancelCalls += 1;
      throw new Error('cancel must not run after the code is observed');
    },
  };

  await skipAliasV2(state, config, 'job-v2-skip-code-race', {
    mailClient: new MailboxClient(accounts),
    smsProvider,
  });

  assert.equal(reconcileCalls, 2);
  assert.equal(completeCalls, 1);
  assert.equal(cancelCalls, 0);
  assert.equal(state.jobs[0].status, 'skipped');
  assert.equal(state.jobs[0].phase, 'skipped');
  assert.equal(state.jobs[0].sms.current, null);
  assert.equal(state.jobs[0].sms.attempts[0].status, 'complete');
});

test('cancelling a run releases every mailbox and finalizer proxy owner', async (t) => {
  const directory = temporaryDirectory(t);
  const accounts = [
    { id: 301, email: 'normal@example.test', tokenValid: true, bound: false },
    { id: 302, email: 'finalizer@example.test', tokenValid: true, bound: false },
  ];
  const config = configFor(directory, accounts, {
    runId: 'run-v2-cancel-proxy-owners',
    maxConcurrency: 2,
    requiredProxy: true,
  });
  const state = makeInitialOrchestratorV2State(config, { runId: config.runId });
  const normalProxy = { id: 'proxy-normal', url: 'http://127.0.0.1:2082' };
  const finalizerProxy = { id: 'proxy-finalizer', url: 'http://127.0.0.1:2083' };
  const normalOwner = 'mailbox:301';
  const finalizerOwner = 'finalizer:job-finalizer';
  state.workers = [
    seededWorker('worker-1', {
      status: 'running', mailboxId: 301, proxyId: normalProxy.id, currentJobId: 'job-normal',
    }),
    seededWorker('worker-2'),
  ];
  state.mailboxes = [
    seededMailbox(301, accounts[0].email, {
      workerId: 'worker-1',
      proxy: { ...normalProxy, assignedAt: STARTED_AT },
      proxyVerifiedAt: STARTED_AT,
      proxyConsumedByJobId: 'job-normal',
    }),
    seededMailbox(302, accounts[1].email, {
      status: 'normal_complete',
      successCount: 1,
      createdCount: 1,
      cpaCompletedCount: 0,
      normalComplete: true,
    }),
  ];
  state.jobs = [
    seededJob('job-normal', 301, 'normal+resource001@example.test', {
      proxy: { ...normalProxy, assignedAt: STARTED_AT },
      proxyVerifiedAt: STARTED_AT,
    }),
    seededJob('job-finalizer', 302, 'finalizer+resource001@example.test', {
      status: 'runnable',
      phase: 'fallback_login',
      branch: 'login',
      accountCreatedAt: STARTED_AT,
      proxy: { ...finalizerProxy, assignedAt: STARTED_AT },
      proxyVerifiedAt: STARTED_AT,
      finalization: {
        status: 'running',
        attempts: 1,
        queuedAt: STARTED_AT,
        startedAt: STARTED_AT,
      },
    }),
  ];
  state.proxyLeases = {
    [normalOwner]: normalProxy.id,
    [finalizerOwner]: finalizerProxy.id,
  };

  await cancelOrchestratorV2(state, config, {
    mailClient: new MailboxClient(accounts),
    smsProvider: new MockSmsProvider(),
    proxyEntries: [normalProxy, finalizerProxy],
  });

  assert.equal(state.status, 'cancelled');
  assert.deepEqual(state.proxyLeases, {});
  assert.equal(state.mailboxes[0].proxy, null);
  assert.equal(state.proxyHealth[normalProxy.id].leasedTo, '');
  assert.equal(state.proxyHealth[finalizerProxy.id].leasedTo, '');
  assert.notEqual(state.proxyHealth[normalProxy.id].status, 'leased');
  assert.notEqual(state.proxyHealth[finalizerProxy.id].status, 'leased');
});

test('legacy cancellation retains a mailbox after user registration succeeded', async (t) => {
  const directory = temporaryDirectory(t);
  const accounts = [{ id: 304, email: 'partial-account@example.test', tokenValid: true, bound: true }];
  const config = configFor(directory, accounts, { runId: 'run-v2-retain-partial-account' });
  const state = makeInitialOrchestratorV2State(config, { runId: config.runId });
  const mail = new MailboxClient(accounts);
  state.workers = [seededWorker('worker-1', { status: 'running', mailboxId: 304, currentJobId: 'job-partial-account' })];
  state.mailboxes = [seededMailbox(304, accounts[0].email, { workerId: 'worker-1', status: 'reserved' })];
  state.jobs = [seededJob('job-partial-account', 304, accounts[0].email, {
    runner: {
      lastContinueUrl: 'https://auth.openai.com/email-verification',
      events: [
        { step: 'authorize_continue', status: 200 },
        { step: 'user_register', status: 200 },
      ],
    },
  })];

  await cancelOrchestratorV2(state, config, {
    mailClient: mail,
    smsProvider: new MockSmsProvider(),
  });

  assert.equal(state.status, 'cancelled');
  assert.equal(state.mailboxes[0].status, 'cancelled_retained');
  assert.equal(state.mailboxes[0].targetTouched, true);
  assert.deepEqual(mail.released, []);
});

test('cancelling after an SMS code was received completes the activation instead of cancelling it', async (t) => {
  const directory = temporaryDirectory(t);
  const accounts = [{ id: 303, email: 'received-code@example.test', tokenValid: true, bound: false }];
  const config = configFor(directory, accounts, { runId: 'run-v2-cancel-received-code' });
  const state = makeInitialOrchestratorV2State(config, { runId: config.runId });
  const lease = {
    id: 'activation-code-received',
    activationId: 'activation-code-received',
    number: '+56970000001',
    status: 'code_received',
    providerStatus: 'STATUS_OK',
    code: '100001',
    cost: 0.04,
  };
  state.workers = [seededWorker('worker-1', { status: 'running', mailboxId: 303, currentJobId: 'job-code-received' })];
  state.mailboxes = [seededMailbox(303, accounts[0].email, { workerId: 'worker-1' })];
  state.jobs = [seededJob('job-code-received', 303, 'received-code+resource001@example.test', {
    sms: {
      current: lease,
      attempts: [],
      pendingCleanup: [],
      effect: null,
      replacementWindowUsed: 1,
      codeRetryCount: 0,
    },
  })];
  const smsProvider = new MockSmsProvider();
  smsProvider.restoreLease(lease);
  const originalComplete = smsProvider.complete.bind(smsProvider);
  const originalCancel = smsProvider.cancel.bind(smsProvider);
  let completeCalls = 0;
  let cancelCalls = 0;
  smsProvider.complete = async (...args) => { completeCalls += 1; return originalComplete(...args); };
  smsProvider.cancel = async (...args) => { cancelCalls += 1; return originalCancel(...args); };

  await cancelOrchestratorV2(state, config, {
    mailClient: new MailboxClient(accounts),
    smsProvider,
  });

  assert.equal(state.status, 'cancelled');
  assert.equal(completeCalls, 1);
  assert.equal(cancelCalls, 0);
  assert.equal(state.jobs[0].sms.current, null);
  assert.equal(state.jobs[0].sms.attempts[0].status, 'complete');
  assert.equal(state.events.some((event) => event.type === 'sms_completed_after_code'), true);
});

test('full-chain cancellation records an ambiguous number acquisition instead of silently dropping it', async (t) => {
  const directory = temporaryDirectory(t);
  const accounts = [{ id: 305, email: 'ambiguous-acquire@example.test', tokenValid: true, bound: true }];
  const config = configFor(directory, accounts, { runId: 'run-v2-cancel-ambiguous-acquire' });
  const state = makeInitialOrchestratorV2State(config, { runId: config.runId });
  state.workers = [seededWorker('worker-1', { status: 'running', mailboxId: 305, currentJobId: 'job-ambiguous-acquire' })];
  state.mailboxes = [seededMailbox(305, accounts[0].email, { workerId: 'worker-1', status: 'reserved' })];
  state.jobs = [seededJob('job-ambiguous-acquire', 305, accounts[0].email, {
    phase: 'waiting_sms_acquire_reconcile',
    sms: {
      current: null, attempts: [], acquisitions: [], pendingCleanup: [],
      effect: {
        id: 'sms-acquire-full-chain-uncertain', kind: 'sms_acquire', service: 'dr', country: '151', maxPrice: 0.055,
        request: { serviceCode: 'dr', countryId: '151', maxPrice: 0.055 },
      },
    },
  })];

  await cancelOrchestratorV2(state, config, {
    mailClient: new MailboxClient(accounts),
    smsProvider: new MockSmsProvider(),
    reason: 'operator_cancelled',
  });

  assert.equal(state.status, 'cancelled');
  assert.equal(state.phase, 'cancelled');
  assert.equal(state.jobs[0].sms.effect, null);
  assert.equal(state.jobs[0].sms.acquisitions[0].status, 'abandoned_unresolved');
  assert.equal(state.externalCleanup[0].acquisitionId, 'sms-acquire-full-chain-uncertain');
  assert.equal(state.externalCleanup[0].status, 'manual_review_required');
  assert.equal(state.events.some((event) => event.type === 'sms_acquisition_abandoned_unresolved'), true);
  assert.deepEqual(summarizeOrchestratorV2State(state).externalCleanup, state.externalCleanup);
});

test('full-chain cancellation preserves an existing job failure reason during external cleanup', async (t) => {
  const directory = temporaryDirectory(t);
  const accounts = [{ id: 306, email: 'preserve-error@example.test', tokenValid: true, bound: false }];
  const config = configFor(directory, accounts, { runId: 'run-v2-cancel-preserves-error' });
  const state = makeInitialOrchestratorV2State(config, { runId: config.runId });
  const failure = { code: 'RATE_LIMIT_EXCEEDED', message: 'phone request was throttled' };
  state.jobs = [seededJob('job-preserve-error', 306, accounts[0].email, {
    error: failure,
    sms: {
      current: null, attempts: [], acquisitions: [], pendingCleanup: [],
      effect: {
        id: 'sms-acquire-preserve-error', kind: 'sms_acquire', service: 'dr', country: '151', maxPrice: 0.055,
        request: { serviceCode: 'dr', countryId: '151', maxPrice: 0.055 },
      },
    },
  })];

  await cancelOrchestratorV2(state, config, {
    mailClient: new MailboxClient(accounts),
    smsProvider: new MockSmsProvider(),
    reason: 'operator_cancelled',
  });

  assert.equal(state.status, 'cancelled');
  assert.equal(state.jobs[0].status, 'cancelled');
  assert.deepEqual(state.jobs[0].error, failure);
});

test('summary exposes operational counts without proxy credentials', (t) => {
  const directory = temporaryDirectory(t);
  const accounts = [{ id: 401, email: 'summary@example.test', tokenValid: true, bound: false }];
  const config = configFor(directory, accounts, { runId: 'run-v2-summary-counts', maxConcurrency: 2 });
  const state = makeInitialOrchestratorV2State(config, { runId: config.runId });
  const proxyUrl = 'http://proxy-user:proxy-password@127.0.0.1:2084';
  state.workers = [
    seededWorker('worker-1', {
      status: 'running', mailboxId: 401, proxyId: 'proxy-summary', currentJobId: 'job-finalizer', completedRoots: 2,
    }),
    seededWorker('worker-2'),
  ];
  state.mailboxes = [seededMailbox(401, accounts[0].email, {
    createdCount: 2,
    cpaCompletedCount: 1,
    successCount: 1,
    workerId: 'worker-1',
    proxy: { id: 'proxy-summary', url: proxyUrl, assignedAt: STARTED_AT },
  })];
  state.jobs = [
    seededJob('job-complete', 401, 'summary+resource001@example.test', {
      status: 'complete',
      phase: 'complete',
      accountCreatedAt: STARTED_AT,
      cpaPath: path.join(directory, 'account.json'),
      proxy: { id: 'proxy-summary', url: proxyUrl, assignedAt: STARTED_AT },
      sms: {
        current: { id: 'activation-complete', status: 'complete', cost: 0.04, currency: 'USD' },
        attempts: [
          { id: 'activation-cancelled', status: 'cancelled', cost: 0.07, currency: 'USD' },
          { id: 'activation-complete', status: 'complete', cost: 0.04, currency: 'USD' },
        ],
        pendingCleanup: [],
        effect: null,
        replacementWindowUsed: 2,
        codeRetryCount: 0,
      },
    }),
    seededJob('job-finalizer', 401, 'summary+resource002@example.test', {
      status: 'runnable',
      phase: 'fallback_login',
      branch: 'login',
      accountCreatedAt: STARTED_AT,
      proxy: { id: 'proxy-summary', url: proxyUrl, assignedAt: STARTED_AT },
      finalization: { status: 'running', attempts: 2, queuedAt: STARTED_AT, startedAt: STARTED_AT },
      error: { code: 'proxy_failure', message: `connect ${proxyUrl} failed` },
    }),
  ];
  state.finalizationQueue = ['job-finalizer'];
  state.proxyCandidates = ['proxy-summary'];
  state.proxyHealth = {
    'proxy-summary': {
      id: 'proxy-summary',
      endpoint: proxyUrl,
      status: 'healthy',
      successCount: 1,
      failureCount: 0,
      lastCheckedAt: STARTED_AT,
      latencyMs: 5,
    },
  };

  const summary = summarizeOrchestratorV2State(state, { raw: true });
  const serialized = JSON.stringify(summary);
  assert.deepEqual(summary.counts, {
    workers: { total: 2, running: 1, idle: 1 },
    accountsCreated: 2,
    cpaCompleted: 1,
    finalization: { queued: 0, running: 1, failed: 0 },
  });
  assert.deepEqual(summary.costs, {
    currency: 'USD',
    sms: 0.04,
    accountedJobs: 1,
    complete: false,
  });
  assert.equal(summary.jobs[0].smsCostUsd, 0.04);
  assert.equal(summary.jobs[1].smsCostUsd, null);
  assert.doesNotMatch(serialized, /proxy-user|proxy-password/);
});

test('proxy exhaustion waits without claiming a root and resume accepts a newly added proxy', async (t) => {
  const { har } = loadHar();
  const directory = temporaryDirectory(t);
  const accounts = [{ id: 501, email: 'resume-proxy@example.test', tokenValid: true, bound: false }];
  const config = configFor(directory, accounts, {
    runId: 'run-v2-proxy-resume',
    requiredProxy: true,
  });
  const clock = fakeClock();
  const state = makeInitialOrchestratorV2State(config, { runId: config.runId, now: clock.now });
  const mailClient = new MailboxClient(accounts);
  const failedProxy = { id: 'proxy-failed', url: 'http://127.0.0.1:2085' };
  const addedProxy = { id: 'proxy-added', url: 'http://127.0.0.1:2086' };
  const checks = new Map();
  const proxyProbeExecutor = async (request, context) => {
    checks.set(context.proxy, Number(checks.get(context.proxy) || 0) + 1);
    if (context.proxy === failedProxy.url) throw new Error('proxy health check failed');
    return { response: { status: 204, url: request.url, text: '' } };
  };

  await runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider: new MockSmsProvider(),
    proxyEntries: [failedProxy],
    proxyProbeExecutor,
    executor: successfulExecutor(har, mailClient),
    tokenExecutor: (request, job) => Promise.resolve(tokenResult(request, job)),
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(state.status, 'waiting');
  assert.equal(state.phase, 'normal');
  assert.equal(state.mailboxes.length, 0);
  assert.equal(state.jobs.length, 0);
  assert.deepEqual(mailClient.reserved, []);
  assert.equal(state.proxyHealth[failedProxy.id].status, 'failed');

  resumeOrchestratorV2State(state);
  await runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider: new MockSmsProvider({ numbers: ['+56970000001'], codes: ['100001'] }),
    proxyEntries: [failedProxy, addedProxy],
    proxyProbeExecutor,
    executor: successfulExecutor(har, mailClient),
    tokenExecutor: (request, job) => Promise.resolve(tokenResult(request, job)),
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(state.status, 'complete');
  assert.deepEqual(mailClient.reserved, [501]);
  assert.equal(checks.get(failedProxy.url), 1);
  assert.ok(Number(checks.get(addedProxy.url) || 0) >= 1);
  assert.equal(state.jobs[0].proxy.id, addedProxy.id);
});

test('a checkpoint crash after a successful proxy probe does not mark the proxy failed', async (t) => {
  const { har } = loadHar();
  const directory = temporaryDirectory(t);
  const accounts = [{ id: 502, email: 'proxy-crash@example.test', tokenValid: true, bound: false }];
  const config = configFor(directory, accounts, {
    runId: 'run-v2-proxy-checkpoint-crash',
    requiredProxy: true,
  });
  const clock = fakeClock();
  const state = makeInitialOrchestratorV2State(config, { runId: config.runId, now: clock.now });
  const mailClient = new MailboxClient(accounts);
  const proxy = { id: 'proxy-checkpoint', url: 'http://127.0.0.1:2087' };
  let crash = true;
  let probeCalls = 0;
  const proxyProbeExecutor = async (request) => {
    probeCalls += 1;
    return { response: { status: 204, url: request.url, text: '' } };
  };

  await assert.rejects(runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider: new MockSmsProvider(),
    proxyEntries: [proxy],
    proxyProbeExecutor,
    executor: successfulExecutor(har, mailClient),
    tokenExecutor: (request, job) => Promise.resolve(tokenResult(request, job)),
    now: clock.now,
    sleep: clock.sleep,
    saveState: async (next) => {
      if (crash && next.lastCheckpoint?.reason === 'proxy_health_passed') {
        crash = false;
        const error = new Error('simulated checkpoint crash');
        error.code = 'ESIMULATEDCRASH';
        throw error;
      }
    },
  }), /simulated checkpoint crash/);

  assert.notEqual(state.proxyHealth[proxy.id].status, 'failed');
  assert.equal(state.mailboxes.length, 0);

  resumeOrchestratorV2State(state);
  await runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider: new MockSmsProvider({ numbers: ['+56970000001'], codes: ['100001'] }),
    proxyEntries: [proxy],
    proxyProbeExecutor,
    executor: successfulExecutor(har, mailClient),
    tokenExecutor: (request, job) => Promise.resolve(tokenResult(request, job)),
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(state.status, 'complete');
  assert.equal(probeCalls, 2);
  assert.equal(state.proxyHealth[proxy.id].status, 'healthy');
});

test('schema v2 country-pool binding stops after three failed proxy probes', async (t) => {
  const { har } = loadHar();
  const directory = temporaryDirectory(t);
  const accounts = [{ id: 601, email: 'three-probes@example.test', tokenValid: true, bound: false }];
  const config = configFor(directory, accounts, {
    runId: 'run-v2-three-proxy-probes',
    requiredProxy: true,
  });
  config.workers.proxyAssignments = [{ workerSlot: 1, kind: 'countryPool', countryCode: 'CL' }];
  const clock = fakeClock();
  const state = makeInitialOrchestratorV2State(config, { runId: config.runId, now: clock.now });
  state.runPlan = {
    schemaVersion: 2,
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'plus',
    aliasCount: 1,
    aliasMaxAttempts: 3,
    aliasRunTag: 'resource',
    proxyAssignments: config.workers.proxyAssignments,
  };
  const proxies = Array.from({ length: 4 }, (_, index) => ({
    id: `proxy-three-${index + 1}`,
    url: `http://127.0.0.1:${2090 + index}`,
    workerSlots: [1],
  }));
  const checked = [];

  await runOrchestratorV2(har, state, config, {
    mailClient: new MailboxClient(accounts),
    smsProvider: new MockSmsProvider(),
    proxyEntries: proxies,
    proxyProbeExecutor: async (_request, context) => {
      checked.push(context.proxy);
      throw new Error('proxy unavailable');
    },
    executor: successfulExecutor(har, new MailboxClient(accounts)),
    tokenExecutor: (request, job) => Promise.resolve(tokenResult(request, job)),
    random: () => 0,
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(state.status, 'waiting');
  assert.equal(checked.length, 3);
  assert.equal(Object.values(state.proxyHealth).filter((record) => record.status === 'failed').length, 3);
  assert.equal(Object.values(state.proxyHealth).filter((record) => record.status === 'unknown').length, 1);
  assert.equal(state.mailboxes.length, 0);
});
