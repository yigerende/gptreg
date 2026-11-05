'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { makeInitialBranchState, prepareBranchPreflight, preflightBranch, runBranchOrchestrator } = require('../src/branch-orchestrator');
const { normalizeRunPlan } = require('../src/run-plan');
const { SessionAssetStore } = require('../src/session-asset-store');

function config() {
  return {
    schemaVersion: 2,
    mail: {
      provider: 'mailcom',
      baseUrl: 'http://127.0.0.1:8001',
      adminToken: 'local-token',
      count: 2,
      folders: ['INBOX'],
      maxResults: 20,
      timeoutMs: 200,
      pollIntervalMs: 5,
      keyword: 'openai',
      aliasBatchSize: 2,
    },
    aliases: { strategy: 'root', count: 1, maxAttempts: 1, runTag: 'branch', plusAddressingEnabled: false },
    sms: {
      provider: 'mock',
      apiKey: 'sms-secret',
      maxPrice: 0.03,
      service: { code: 'mock' },
      country: { id: 151 },
      replacementBudget: 2,
      codeTimeoutMs: 100,
    },
    workers: { maxConcurrency: 1 },
    registration: { exchangeToken: true, dynamicSentinel: true, name: 'Fixture', birthdate: '2000-01-01' },
    proxyPool: { path: 'proxy-pool.txt', defaultProtocol: 'http', required: false, healthCheck: { enabled: false } },
    output: { stateDir: '.state', cpaDir: '.state/output' },
  };
}

function temporaryStore(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-mailcom-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const store = new SessionAssetStore({ cwd, stateDir: '.state', cpaDir: '.state/output' });
  t.after(() => store.close());
  return store;
}

function mailClient(options = {}) {
  const calls = [];
  const released = [];
  const started = [];
  let snapshotAttempts = 0;
  const accounts = [
    { id: 'mail-master', email: 'master@example.com', rootEmail: 'master@example.com', parent: 'master@example.com', kind: 'master', tokenValid: true, bound: false },
    { id: 'mail-alias', email: 'alias@example.com', rootEmail: 'master@example.com', parent: 'master@example.com', kind: 'alias', tokenValid: true, bound: false },
  ];
  const mailboxCount = Math.max(1, Number(options.mailboxCount || accounts.length));
  for (let index = accounts.length; index < mailboxCount; index += 1) {
    accounts.push({
      id: `mail-alias-${index}`,
      email: `alias-${index}@example.com`,
      rootEmail: 'master@example.com',
      parent: 'master@example.com',
      kind: 'alias',
      tokenValid: true,
      bound: false,
    });
  }
  accounts.splice(mailboxCount);
  let consumeAttempts = 0;
  return {
    calls,
    released,
    started,
    get snapshotAttempts() { return snapshotAttempts; },
    remoteRegistrationAddresses: true,
    async listAccounts() { return { accounts }; },
    async reserveMailbox(id) { calls.push(`reserve:${id}`); },
    async markMailboxRegistrationStarted(id) { started.push(String(id)); },
    async releaseMailbox(id) { released.push(String(id)); },
    async snapshotMailbox(id) {
      snapshotAttempts += 1;
      if (options.failFirstSnapshot && snapshotAttempts === 1) {
        throw Object.assign(new Error('mail.com navigator session did not produce navsid'), {
          code: 'WEBMAIL_AUTH_FAILED',
          status: 422,
          retryable: true,
          category: 'mailbox_authentication',
        });
      }
      return { mailboxId: id, messageIds: [], capturedAt: '2026-08-18T00:00:00.000Z' };
    },
    async findVerificationCode() { return null; },
    async consumeMailbox(id) {
      consumeAttempts += 1;
      calls.push(`consume:${id}`);
      if (options.consumeError) throw options.consumeError;
      if (options.failFirstConsume && consumeAttempts === 1) throw new Error('temporary 8001 outage');
      return {
        changed: true,
        mailbox: { id, cycle: 1 },
        recycle: id === 'mail-alias' ? { recycled: true, nextCycle: 2 } : { recycled: false },
      };
    },
  };
}

async function runFixture(t, options = {}) {
  const currentConfig = config();
  const mailboxCount = Math.max(1, Number(options.mailboxCount || 2));
  currentConfig.mail.count = mailboxCount;
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailProvider: 'mailcom',
    mailCount: mailboxCount,
    workerConcurrency: 1,
    aliasStrategy: 'root',
    security: { setPassword: true, enrollTotp: true },
  }, currentConfig);
  const state = makeInitialBranchState(currentConfig, plan, { runId: options.runId || 'mailcom-branch' });
  const mail = mailClient(options);
  await runBranchOrchestrator({ log: { entries: [] } }, state, currentConfig, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    trialChecker: async () => ({ status: 'unknown', code: 'NOT_CHECKED', campaigns: [] }),
    sessionRunnerFactory: ({ job, options: runnerOptions }) => ({
      async run(sessionState) {
        if (options.failFirstSnapshot) {
          await runnerOptions.beforeEmailSend(job.email, sessionState, {});
        }
        sessionState.step = 'verified';
        sessionState.status = 'valid';
        sessionState.accountId = `account-${job.id}`;
        sessionState.accessToken = `access-${job.id}`;
        sessionState.sessionToken = `session-${job.id}`;
        sessionState.planType = 'free';
        sessionState.session = { user: { email: job.email } };
        sessionState.me = { email: job.email };
        sessionState.lastValidatedAt = '2026-08-18T00:00:00.000Z';
        const jobIndex = state.jobs.indexOf(job);
        if (jobIndex >= 0 && jobIndex < Number(options.pendingSecurityCount || 0)) {
          sessionState.status = 'partial';
          sessionState.security = {
            passwordStatus: 'failed',
            totpStatus: 'configured',
            failures: [{ feature: 'password', code: 'PASSWORD_REJECTED', message: 'password did not meet policy' }],
          };
        } else {
          sessionState.security = {
            passwordStatus: 'configured',
            totpStatus: 'configured',
            failures: [],
          };
        }
      },
    }),
  });
  return { state, mail };
}

test('Mail.com skips unavailable selected alias domains when another choice is live', async () => {
  const currentConfig = config();
  currentConfig.mail.aliasDomainMode = 'selected';
  currentConfig.mail.aliasDomains = ['scotlandmail.com', 'sanfranmail.com'];
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailProvider: 'mailcom',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, currentConfig);
  let reserved = 0;
  const preflight = await preflightBranch(currentConfig, plan, {
    mailClient: {
      async listAccounts() {
        return { accounts: [{ id: 'mail-master', email: 'master@example.com', tokenValid: true, bound: false }] };
      },
      async listAliasDomains() {
        return { domains: ['scotlandmail.com'], deniedDomains: ['sanfranmail.com'] };
      },
      async reserveMailbox() { reserved += 1; },
    },
    smsProvider: { async preflight() { return { ready: true, balance: 1, prices: [] }; } },
  });

  assert.equal(preflight.ready, true);
  assert.equal(preflight.mail.ready, true);
  assert.deepEqual(preflight.mail.aliasDomains.usable, ['scotlandmail.com']);
  assert.deepEqual(preflight.mail.aliasDomains.unavailable, ['sanfranmail.com']);
  assert.match(preflight.warnings.join(' '), /sanfranmail\.com/);
  assert.equal(reserved, 0);
});

test('iCloud preflight uses the mailbox pool without touching alias domain policy', async () => {
  const currentConfig = config();
  currentConfig.mail = {
    ...currentConfig.mail,
    provider: 'icloud',
    icloudBaseUrl: 'http://127.0.0.1:8001',
    aliasDomainMode: 'selected',
    aliasDomains: ['must-not-be-read.example'],
  };
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailProvider: 'icloud',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'plus',
  }, currentConfig);
  let aliasDomainCalls = 0;
  const preflight = await preflightBranch(currentConfig, plan, {
    mailClient: {
      remoteRegistrationAddresses: true,
      async listAccounts() {
        return { accounts: [{ id: 'icloud-mailbox', email: 'icloud@example.test', tokenValid: true, bound: false }] };
      },
      async listAliasDomains() {
        aliasDomainCalls += 1;
        throw new Error('iCloud must not query alias domains');
      },
    },
    smsProvider: { async preflight() { return { ready: true, balance: 1, prices: [] }; } },
  });

  assert.equal(preflight.ready, true);
  assert.equal(preflight.mail.kind, 'icloud_pool');
  assert.equal(preflight.mail.aliasDomains, undefined);
  assert.equal(aliasDomainCalls, 0);
  // A legacy `plus` request now turns on iCloud's local +alias (root plus one),
  // which still never consults the Mail API alias-domain policy.
  assert.equal(plan.aliasEnabled, true);
  assert.equal(plan.aliasCount, 2);
});

test('Mail.com blocks when every selected alias domain is unavailable', async () => {
  const currentConfig = config();
  currentConfig.mail.aliasDomainMode = 'selected';
  currentConfig.mail.aliasDomains = ['sanfranmail.com'];
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailProvider: 'mailcom',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, currentConfig);
  const preflight = await preflightBranch(currentConfig, plan, {
    mailClient: {
      async listAccounts() {
        return { accounts: [{ id: 'mail-master', email: 'master@example.com', tokenValid: true, bound: false }] };
      },
      async listAliasDomains() {
        return { domains: ['scotlandmail.com'], deniedDomains: ['sanfranmail.com'] };
      },
    },
    smsProvider: { async preflight() { return { ready: true, balance: 1, prices: [] }; } },
  });

  assert.equal(preflight.ready, false);
  assert.equal(preflight.mail.ready, false);
  assert.deepEqual(preflight.mail.aliasDomains.usable, []);
  assert.deepEqual(preflight.mail.aliasDomains.unavailable, ['sanfranmail.com']);
});

test('Mail.com applies the effective selected alias domains to the run client', async () => {
  const currentConfig = config();
  currentConfig.mail.aliasDomainMode = 'selected';
  currentConfig.mail.aliasDomains = ['scotlandmail.com', 'sanfranmail.com'];
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailProvider: 'mailcom',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, currentConfig);
  const client = {
    aliasDomains: currentConfig.mail.aliasDomains,
    async listAccounts() {
      return { accounts: [{ id: 'mail-master', email: 'master@example.com', tokenValid: true, bound: false }] };
    },
    async listAliasDomains() {
      return { domains: ['scotlandmail.com'], deniedDomains: ['sanfranmail.com'] };
    },
    setAliasDomains(domains) {
      this.aliasDomains = [...domains];
    },
  };
  const prepared = await prepareBranchPreflight(currentConfig, plan, {
    mailClient: client,
    smsProvider: { async preflight() { return { ready: true, balance: 1, prices: [] }; } },
  });

  assert.deepEqual(prepared.effectiveMailAliasDomains, ['scotlandmail.com']);
  assert.deepEqual(client.aliasDomains, ['scotlandmail.com']);
});

test('Mail.com selected alias domains pass preflight when all are live', async () => {
  const currentConfig = config();
  currentConfig.mail.aliasDomainMode = 'selected';
  currentConfig.mail.aliasDomains = ['scotlandmail.com', 'safrica.com'];
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailProvider: 'mailcom',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
  }, currentConfig);
  const preflight = await preflightBranch(currentConfig, plan, {
    mailClient: {
      async listAccounts() {
        return { accounts: [{ id: 'mail-master', email: 'master@example.com', tokenValid: true, bound: false }] };
      },
      async listAliasDomains() {
        return { domains: ['scotlandmail.com', 'safrica.com'], deniedDomains: [] };
      },
    },
    smsProvider: { async preflight() { return { ready: true, balance: 1, prices: [] }; } },
  });

  assert.equal(preflight.ready, true);
  assert.equal(preflight.mail.ready, true);
  assert.deepEqual(preflight.mail.aliasDomains.unavailable, []);
});

test('Mail.com registration consumes root and alias addresses as separate remote mailboxes', async (t) => {
  const { state, mail } = await runFixture(t);

  assert.equal(state.status, 'complete');
  assert.deepEqual(state.jobs.map((job) => job.status), ['complete', 'complete']);
  assert.deepEqual(mail.calls, [
    'reserve:mail-master', 'reserve:mail-alias',
    'consume:mail-master', 'consume:mail-alias',
  ]);
  assert.deepEqual(mail.started.sort(), ['mail-alias', 'mail-master']);
  assert.equal(state.jobs.every((job) => job.remoteMailboxConsumedAt), true);
});

test('a transient Mail.com consume failure is retried before the run becomes terminal', async (t) => {
  const { state, mail } = await runFixture(t, { failFirstConsume: true, runId: 'mailcom-branch-retry' });

  assert.equal(state.status, 'complete');
  assert.equal(mail.calls.filter((call) => call === 'consume:mail-master').length, 2);
  assert.equal(state.jobs.every((job) => job.remoteMailboxConsumedAt), true);
  assert.equal(state.events.some((event) => event.type === 'mailcom_mailbox_consume_deferred'), true);
});

test('Mail.com consumes a master cycle with exactly five incomplete security aliases', async (t) => {
  const { state, mail } = await runFixture(t, {
    mailboxCount: 5,
    pendingSecurityCount: 5,
    runId: 'mailcom-security-threshold-allow',
  });

  assert.equal(state.status, 'partial');
  assert.equal(mail.calls.filter((call) => call.startsWith('consume:')).length, 5);
  assert.equal(state.jobs.every((job) => job.remoteMailboxConsumedAt), true);
  assert.equal(state.events.some((event) => event.type === 'mailcom_rotation_blocked_security_pending'), false);
});

test('Mail.com keeps a master cycle open when six aliases have incomplete security', async (t) => {
  const { state, mail } = await runFixture(t, {
    mailboxCount: 6,
    pendingSecurityCount: 6,
    runId: 'mailcom-security-threshold-block',
  });

  assert.equal(state.status, 'waiting');
  assert.equal(state.lastError?.code, 'MAILCOM_ROTATION_BLOCKED_SECURITY');
  assert.equal(mail.calls.filter((call) => call.startsWith('consume:')).length, 0);
  assert.equal(state.jobs.every((job) => !job.remoteMailboxConsumedAt), true);
  const blocked = state.events.filter((event) => event.type === 'mailcom_rotation_blocked_security_pending');
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].pendingSecurityAliases, 6);
  assert.equal(blocked[0].maxAllowed, 5);
});

test('a retryable Mail.com webmail authentication failure is retried before releasing the mailbox', async (t) => {
  const { state, mail } = await runFixture(t, { failFirstSnapshot: true, runId: 'mailcom-webmail-auth-retry' });

  assert.equal(state.status, 'complete');
  // The first master snapshot fails and the retry succeeds; the sibling alias
  // reuses that successful master baseline instead of opening another webmail
  // read.
  assert.equal(mail.snapshotAttempts, 2);
  assert.equal(state.jobs.every((job) => job.status === 'complete'), true);
  assert.equal(state.mailboxes.every((mailbox) => mailbox.lifecycle !== 'released'), true);
});

test('a Mail.com claim is released when registration never reaches the target flow', async (t) => {
  const currentConfig = config();
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailProvider: 'mailcom',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
    security: { setPassword: true, enrollTotp: true },
  }, currentConfig);
  const state = makeInitialBranchState(currentConfig, plan, { runId: 'mailcom-claim-release' });
  const mail = mailClient();

  await runBranchOrchestrator({ log: { entries: [] } }, state, currentConfig, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    sessionRunnerFactory: () => ({
      async run() {
        throw new Error('registration failed before target flow');
      },
    }),
  });

  assert.equal(state.status, 'failed');
  assert.deepEqual(mail.released, ['mail-master']);
  assert.deepEqual(mail.started, []);
  assert.equal(state.mailboxes[0].lifecycle, 'released');
  assert.equal(state.mailboxes[0].registrationState, 'not_started');
});

async function pollVerdict(t, runId, lastOtpFetch, options = {}) {
  // Drive one real OTP wait to its deadline and hand the error back, rather
  // than letting the job enter retry backoff — the question here is only what
  // the wait concludes, and a full retry cycle takes tens of seconds.
  const currentConfig = config();
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailProvider: 'mailcom',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
    security: { setPassword: true, enrollTotp: true },
  }, currentConfig);
  const state = makeInitialBranchState(currentConfig, plan, { runId });
  const mail = mailClient();
  const responses = Array.isArray(options.responses) ? [...options.responses] : null;
  mail.findVerificationCode = async () => {
    const response = responses?.length ? responses.shift() : null;
    mail.lastOtpFetch = response?.diagnostics || lastOtpFetch;
    return response?.result || null;
  };
  let captured = null;

  await runBranchOrchestrator({ log: { entries: [] } }, state, currentConfig, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    emailTargetDeliveryGraceMs: options.graceMs,
    trialChecker: async () => ({ status: 'unknown', code: 'NOT_CHECKED', campaigns: [] }),
    sessionRunnerFactory: ({ job, options: runnerOptions }) => ({
      async run(sessionState) {
        sessionState.step = 'email_otp_sent';
        await runnerOptions.checkpoint('email_otp_sent', sessionState);
        try {
          await runnerOptions.getEmailCode(job.email, job.emailBoundary);
        } catch (error) {
          captured = error;
        }
        sessionState.step = 'verified';
        sessionState.status = 'valid';
        sessionState.accountId = `account-${job.id}`;
        sessionState.accessToken = `access-${job.id}`;
        sessionState.sessionToken = `session-${job.id}`;
        sessionState.planType = 'free';
        sessionState.session = { user: { email: job.email } };
        sessionState.me = { email: job.email };
        sessionState.lastValidatedAt = '2026-08-18T00:00:00.000Z';
      },
    }),
  });
  return { state, captured };
}

test('an address the provider never delivered to is named as such, not reported as a mail timeout', async (t) => {
  // Eight Workers share one mail.com inbox, so a poll that finds nothing can
  // still see the other seven aliases being served. That is the only evidence
  // separating "our mail path is broken" from "this address got nothing", and
  // it used to sit unread in the diagnostics while the operator watched
  // twenty-five identical timeout lines and skipped the job by hand.
  const { state, captured } = await pollVerdict(t, 'mailcom-not-delivered', {
    checkedEmails: 0,
    listed: 34,
    dropped: { seen: 20, recipient: 14 },
    siblings: {
      count: 7,
      recipients: ['oak44b@safrica.com', 'raven67d@swedenmail.com', 'summer99k@munich.com'],
      latestAt: '2026-08-18T11:47:37.000Z',
    },
  }, { graceMs: 0 });

  assert.equal(captured?.code, 'EMAIL_NOT_DELIVERED_TO_TARGET');
  assert.equal(captured.siblingDeliveries, 7);
  assert.equal(captured.domain, 'example.com');
  assert.match(captured.message, /同一收件箱在本次等待期间收到了 7 封同类邮件/);
  const verdict = state.events.find((entry) => entry.type === 'email_not_delivered_to_target');
  assert.ok(verdict, 'the run should record the verdict as its own event');
  assert.equal(verdict.siblingDeliveries, 7);
});

test('sibling delivery does not hide a target code that arrives later', async (t) => {
  const { state, captured } = await pollVerdict(t, 'mailcom-target-arrives-late', null, {
    graceMs: 1000,
    responses: [
      {
        diagnostics: {
          checkedEmails: 0,
          siblings: { count: 1, recipients: ['sibling@example.com'] },
        },
      },
      {
        result: { code: '654321', messageId: 'target-message' },
      },
    ],
  });

  assert.equal(captured, null);
  assert.equal(state.events.some((entry) => entry.type === 'email_otp_received'), true);
  assert.equal(state.events.some((entry) => entry.type === 'email_not_delivered_to_target'), false);
});

test('a poll with no sibling traffic still fails as a plain mail timeout', async (t) => {
  // The mirror: with nothing else arriving either, the mailbox really might be
  // at fault, so the verdict must not fire.
  const { state, captured } = await pollVerdict(t, 'mailcom-quiet-inbox', {
    checkedEmails: 0,
    listed: 20,
    dropped: { seen: 20 },
    siblings: { count: 0, recipients: [] },
  });

  assert.equal(captured?.code, 'EMAIL_OTP_TIMEOUT');
  assert.equal(state.events.some((entry) => entry.type === 'email_not_delivered_to_target'), false);
});

test('an address abandoned before an account existed goes straight back into the pool', async (t) => {
  // Stopping at the verification-code wait leaves no account behind that
  // address, so retiring it — which is what "registration started" used to
  // mean — threw away a usable mailbox on every cancel.
  const currentConfig = config();
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailProvider: 'mailcom',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
    security: { setPassword: true, enrollTotp: true },
  }, currentConfig);
  const state = makeInitialBranchState(currentConfig, plan, { runId: 'mailcom-abandoned-early' });
  const mail = mailClient();

  await runBranchOrchestrator({ log: { entries: [] } }, state, currentConfig, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    sessionRunnerFactory: ({ options: runnerOptions }) => ({
      async run(sessionState) {
        sessionState.step = 'email_otp_sent';
        await runnerOptions.checkpoint('email_otp_sent', sessionState);
        throw new Error('run ended while waiting for the verification code');
      },
    }),
  });

  assert.deepEqual(mail.started, ['mail-master']);
  assert.deepEqual(mail.released, ['mail-master']);
  assert.deepEqual(mail.calls.filter((call) => call.startsWith('consume:')), []);
  assert.equal(state.mailboxes[0].lifecycle, 'released');
});

test('an address that reached account creation is reported as spent', async (t) => {
  // The mirror of the test above, and the case that quietly drained the pool:
  // once OpenAI has been told about the address it can never be handed out
  // again, but the run used to record that only locally. The provider kept the
  // address `claimed` for good — it never reaps a claim past this point — so
  // every cancelled run permanently cost one address and blocked its cycle from
  // ever completing.
  const currentConfig = config();
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailProvider: 'mailcom',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
    security: { setPassword: true, enrollTotp: true },
  }, currentConfig);
  const state = makeInitialBranchState(currentConfig, plan, { runId: 'mailcom-burned-claim' });
  const mail = mailClient();

  await runBranchOrchestrator({ log: { entries: [] } }, state, currentConfig, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    sessionRunnerFactory: ({ options: runnerOptions }) => ({
      async run(sessionState) {
        sessionState.step = 'account_created';
        sessionState.accountCreated = true;
        await runnerOptions.checkpoint('account_created', sessionState);
        throw new Error('run ended after the account existed but before it was durable');
      },
    }),
  });

  assert.equal(state.status, 'failed');
  assert.deepEqual(mail.started, ['mail-master']);
  // Never released: the address is burned, not free.
  assert.deepEqual(mail.released, []);
  assert.deepEqual(mail.calls.filter((call) => call.startsWith('consume:')), ['consume:mail-master']);
  assert.equal(state.mailboxes[0].status, 'consumed');
  assert.equal(state.mailboxes[0].lifecycle, 'consumed');
  assert.equal(state.mailboxes[0].registrationState, 'consumed');
  assert.equal(state.events.some((entry) => entry.type === 'mailcom_mailbox_burned'), true);
});

test('a mailbox the pool has already dropped settles instead of deferring forever', async (t) => {
  // Observed live: all 20 jobs finished, then the run hung in
  // `waiting_resource_cleanup` retrying POST /api/pool/consume for an alias the
  // pool no longer had. "mailbox not found" can never turn into success, so
  // retrying it is an infinite wait — and an unresolved run also keeps both
  // robots parked, because isBusy() counts it.
  const currentConfig = config();
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailProvider: 'mailcom',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
    security: { setPassword: true, enrollTotp: true },
  }, currentConfig);
  const state = makeInitialBranchState(currentConfig, plan, { runId: 'mailcom-vanished-mailbox' });
  const mail = mailClient();
  let consumeCalls = 0;
  mail.consumeMailbox = async () => {
    consumeCalls += 1;
    throw new Error('mailcom POST /api/pool/consume failed: mailbox not found');
  };

  await runBranchOrchestrator({ log: { entries: [] } }, state, currentConfig, {
    assetStore: temporaryStore(t),
    mailClient: mail,
    sessionRunnerFactory: ({ options: runnerOptions }) => ({
      async run(sessionState) {
        sessionState.step = 'account_created';
        sessionState.accountCreated = true;
        await runnerOptions.checkpoint('account_created', sessionState);
        throw new Error('run ended after the account existed but before it was durable');
      },
    }),
  });

  // The run reaches a terminal status instead of parking in resource cleanup.
  assert.equal(['failed', 'partial', 'complete'].includes(state.status), true, `stuck in ${state.status}`);
  assert.notEqual(state.phase, 'waiting_resource_cleanup');
  assert.equal(consumeCalls, 1, 'a vanished mailbox must not be retried');
  assert.equal(state.events.some((entry) => entry.type === 'mailcom_mailbox_burn_skipped'), true);
  assert.equal(state.events.some((entry) => entry.type === 'mailcom_mailbox_burn_deferred'), false);
});

test('a permanent Mail.com domain rejection becomes manual cleanup instead of pending forever', async (t) => {
  const error = Object.assign(
    new Error('mailcom POST /api/pool/consume failed: unsupported or denied alias domain(s): sanfranmail.com'),
    { code: 'ALIAS_DOMAIN_DENIED', status: 422, retryable: false },
  );
  const { state, mail } = await runFixture(t, {
    mailboxCount: 1,
    consumeError: error,
    runId: 'mailcom-domain-cleanup-blocked',
  });

  assert.equal(state.status, 'partial');
  assert.equal(state.phase, 'partial');
  assert.equal(state.lastError?.code, 'MAILCOM_CLEANUP_MANUAL_REVIEW');
  assert.equal(mail.calls.filter((call) => call.startsWith('consume:')).length, 1);
  assert.equal(state.jobs[0].remoteMailboxCleanup.status, 'cleanup_blocked');
  assert.equal(state.jobs[0].remoteMailboxCleanup.mailboxId, state.jobs[0].mailboxId);
  assert.equal(state.mailboxes[0].lifecycle, 'cleanup_blocked');
  assert.equal(state.externalCleanup[0].type, 'mailcom_mailbox_cleanup');
  assert.equal(state.externalCleanup[0].mailboxId, state.jobs[0].mailboxId);
  assert.equal(state.externalCleanup[0].status, 'manual_review_required');
  assert.notEqual(state.phase, 'waiting_mailbox_cleanup');
});
