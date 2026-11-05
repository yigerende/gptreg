'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { loadHar } = require('../src/har');
const {
  makeInitialOrchestratorV2State,
  preflightOrchestratorV2,
  resumeOrchestratorV2State,
  runOrchestratorV2,
  skipAliasV2,
  summarizeOrchestratorV2State,
  waitForNextDue,
} = require('../src/orchestrator-v2');
const { RUN_STEPS } = require('../src/registration-runner');
const { MockSmsProvider, SmsBowerError } = require('../src/sms-provider');
const { loadV2State, saveV2State } = require('../src/state-store');

function jwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'signature',
  ].join('.');
}

class MockMailboxClient {
  constructor(accounts) {
    this.accounts = accounts;
    this.csrfToken = 'csrf-unit';
    this.ready = false;
    this.reserved = [];
    this.released = [];
  }

  async listAccounts() { return this.accounts; }
  async reserveMailbox(id) { this.reserved.push(id); }
  async releaseMailbox(id) { this.released.push(id); }
  async snapshotMailbox() { return { messageIds: ['baseline-message'], capturedAt: '2026-07-28T00:00:00.000Z' }; }
  async findVerificationCode() {
    return this.ready ? {
      code: '717548',
      messageId: 'new-message',
      consumedMessageId: 'new-message',
      receivedAt: '2026-07-28T00:00:01.000Z',
    } : null;
  }
}

function mockRunner(har, mailClient, options = {}) {
  const stats = {
    emailSends: 0,
    phoneAttempts: 0,
    phoneCodeAttempts: 0,
    phoneCodes: [],
    phoneNumbers: [],
    createAttempts: 0,
    active: 0,
    maxActive: 0,
    steps: [],
  };
  let crashed = false;
  const executor = async (request, step, state) => {
    stats.steps.push(step.name);
    stats.active += 1;
    stats.maxActive = Math.max(stats.maxActive, stats.active);
    try {
      if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
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
          cookies: { ...state.cookies, 'oai-did': 'fresh-did' },
        };
      }

      const isLogin = state.mode === 'pure-url-oauth-login-runner';
      let status = 200;
      let location = '';
      let json = {};
      if (step.name === 'bootstrap_oauth_authorize') { status = 302; location = 'https://auth.openai.com/api/oauth/oauth2/auth?unit=1'; }
      if (step.name === 'bootstrap_oauth_auth') { status = 302; location = 'https://auth.openai.com/api/accounts/login?login_challenge=unit'; }
      if (step.name === 'bootstrap_accounts_login') { status = 302; location = 'https://auth.openai.com/log-in'; }
      if (step.name === 'login_authorize_continue') json = { continue_url: 'https://auth.openai.com/log-in/password', page: { type: 'login_password' } };
      if (step.name === 'password_verify') {
        json = {
          continue_url: 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent',
          page: { type: 'sign_in_with_chatgpt_codex_consent' },
          'oai-client-auth-session': { workspaces: [{ id: 'workspace-unit', kind: 'personal', name: 'Unit' }] },
        };
      }
      if (step.name === 'authorize_continue') json = { continue_url: 'https://auth.openai.com/create-account/password', page: { type: 'create_account_password' } };
      if (step.name === 'user_register') json = { continue_url: 'https://auth.openai.com/email-verification', page: { type: 'email_verification' } };
      if (step.name === 'email_otp_send') {
        stats.emailSends += 1;
        mailClient.ready = true;
        if (options.crashAfterEmailSend && !crashed) {
          crashed = true;
          const error = new Error('simulated crash after email send');
          error.code = 'ESIMULATEDCRASH';
          error.fatal = true;
          throw error;
        }
        status = 302;
        location = 'https://auth.openai.com/email-verification';
      }
      if (step.name === 'email_otp_validate') json = { continue_url: 'https://auth.openai.com/add-phone', page: { type: 'add_phone' } };
      if (step.name === 'phone_otp_send') {
        stats.phoneAttempts += 1;
        stats.phoneNumbers.push(state.inputs.phone);
        if (stats.phoneAttempts <= Number(options.rejectedPhones || 0)) {
          status = 400;
          const fraudAttempts = new Set(options.fraudAttempts || []);
          const code = options.rejectionCode || (fraudAttempts.has(stats.phoneAttempts) ? 'fraud_guard' : 'phone_number_in_use');
          json = { error: { code, message: code } };
        } else {
          json = { continue_url: 'https://auth.openai.com/phone-verification', page: { type: 'phone_otp_verification' } };
        }
      }
      if (step.name === 'phone_otp_validate') {
        stats.phoneCodeAttempts += 1;
        stats.phoneCodes.push(state.inputs.phoneCode);
        if (stats.phoneCodeAttempts <= Number(options.invalidPhoneCodes || 0)) {
          status = 400;
          const code = options.invalidPhoneCode || 'invalid_input';
          json = { error: { code, message: 'Invalid OTP code. Please try again.' } };
        } else {
          json = { continue_url: 'https://auth.openai.com/about-you', page: { type: 'about_you' } };
        }
      }
      if (step.name === 'create_account') {
        stats.createAttempts += 1;
        if (stats.createAttempts <= Number(options.phoneRecentlyUsed || 0)) {
          status = 429;
          json = { error: { code: 'phone_recently_used', message: 'recently used' } };
        } else {
          json = {
            continue_url: 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent',
            page: { type: 'sign_in_with_chatgpt_codex_consent' },
            'oai-client-auth-session': { workspaces: [{ id: 'workspace-unit', kind: 'personal', name: 'Unit' }] },
          };
        }
      }
      if (step.name === 'workspace_select') {
        if (isLogin || options.registrationWorkspaceSuccess) {
          json = {
            continue_url: 'https://auth.openai.com/api/oauth/oauth2/auth?login_verifier=unit',
            page: { type: 'redirect' },
            'oai-client-auth-session': { workspaces: [{ id: 'workspace-unit', kind: 'personal', name: 'Unit' }] },
          };
        } else {
          status = 400;
          json = { error: { code: 'login_request_expired', message: 'expired' } };
        }
      }
      if (step.name === 'oauth_auth_login_verifier') { status = 302; location = 'https://auth.openai.com/api/accounts/consent?consent_challenge=unit'; }
      if (step.name === 'oauth_consent') { status = 302; location = 'https://auth.openai.com/api/oauth/oauth2/auth?consent_verifier=unit'; }
      if (step.name === 'oauth_auth_consent_verifier') {
        status = 303;
        location = `http://localhost:1455/auth/callback?code=ac_v2_unit&state=${state.oauth.state}`;
      }

      return {
        request,
        response: { status, url: request.url, location, contentType: 'application/json', text: JSON.stringify(json) },
        cookies: { ...state.cookies, 'oai-did': 'fresh-did' },
      };
    } finally {
      stats.active -= 1;
    }
  };
  return { executor, stats };
}

function configFor(tempDir, accounts, aliasCount = 1) {
  return {
    schemaVersion: 2,
    runId: 'run-v2-unit',
    mail: { accounts, count: accounts.length, timeoutMs: 1000, pollIntervalMs: 1 },
    aliases: { strategy: 'plus', count: aliasCount, runTag: 'ctf', plusAddressingEnabled: true },
    sms: {
      provider: 'mock',
      replacementBudget: 20,
      pollIntervalMs: 1,
      codeTimeoutMs: 1000,
      inventoryWaitMs: 1000,
    },
    workers: { maxConcurrency: 2 },
    registration: { exchangeToken: true, dynamicSentinel: false, maxRuntimeMs: 120000 },
    output: { stateDir: path.join(tempDir, 'state'), cpaDir: path.join(tempDir, 'output') },
  };
}

function tokenExecutor(request, job = {}) {
  const exp = Math.floor(Date.parse('2026-07-29T00:00:00.000Z') / 1000);
  const email = job.email || 'base+ctfAbCd@example.test';
  return Promise.resolve({
    request,
    response: {
      status: 200,
      url: request.url,
      contentType: 'application/json',
      text: JSON.stringify({
        id_token: jwt({ email, exp }),
        access_token: jwt({ email, exp, 'https://api.openai.com/auth': { chatgpt_account_id: 'workspace-unit' } }),
        refresh_token: 'refresh-unit',
      }),
    },
  });
}

function jobTokenExecutor(request, job) {
  const exp = Math.floor(Date.parse('2026-07-29T00:00:00.000Z') / 1000);
  return Promise.resolve({
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
          'https://api.openai.com/auth': { chatgpt_account_id: 'workspace-unit' },
        }),
        refresh_token: 'refresh-unit',
      }),
    },
  });
}

function configureRequiredProxies(config) {
  config.proxyPool = {
    required: true,
    selection: 'random',
    healthCheck: {
      enabled: true,
      probeUrl: 'https://example.test/proxy-health',
      timeoutMs: 1000,
    },
  };
  return config;
}

function localProxyEntries(count) {
  return Array.from({ length: count }, (_, index) => ({
    id: `proxy-test-${index + 1}`,
    url: `http://127.0.0.1:${2080 + index}`,
  }));
}

function successfulProxyProbe(delayMs = 0) {
  return async (request) => {
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    return { response: { status: 204, url: request.url, text: '' } };
  };
}

function fakeClock() {
  let value = Date.parse('2026-07-28T00:00:00.000Z');
  return {
    now: () => value,
    sleep: async (ms) => { value += ms; },
  };
}

test('v2 scheduler replaces fifteen rejected numbers, preserves phone continuity, falls back to login, and writes CPA', async () => {
  const { har } = loadHar();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-'));
  const accounts = [{ id: 7, email: 'base@example.test', tokenValid: true, bound: false }];
  const config = configFor(tempDir, accounts);
  const mailClient = new MockMailboxClient(accounts);
  const numbers = Array.from({ length: 16 }, (_, index) => `+5697000${String(index + 1).padStart(4, '0')}`);
  const smsProvider = new MockSmsProvider({ numbers, codes: ['463193'] });
  const runner = mockRunner(har, mailClient, {
    rejectedPhones: 15,
    fraudAttempts: [1, 3, 4, 12],
    phoneRecentlyUsed: 2,
  });
  let clock = Date.parse('2026-07-28T00:00:00.000Z');
  const state = makeInitialOrchestratorV2State(config, { runId: config.runId, now: () => clock });
  const stateFile = path.join(config.output.stateDir, 'run.json');

  await runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider,
    executor: runner.executor,
    tokenExecutor,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    saveState: (next) => saveV2State(stateFile, next),
  });

  assert.equal(state.status, 'complete');
  assert.equal(state.jobs[0].status, 'complete');
  assert.equal(state.jobs[0].branch, 'login');
  assert.equal(state.jobs[0].sms.attempts.length, 16);
  assert.equal(runner.stats.phoneAttempts, 16);
  assert.equal(runner.stats.createAttempts, 3);
  assert.equal(mailClient.reserved.length, 1);
  assert.equal(mailClient.released.length, 0);

  const cpa = JSON.parse(fs.readFileSync(state.jobs[0].cpaPath, 'utf8'));
  assert.equal(path.basename(state.jobs[0].cpaPath), `${cpa.email}-cpa.json`);
  assert.deepEqual(Object.keys(cpa).sort(), [
    'access_token', 'account_id', 'email', 'expired', 'id_token', 'last_refresh', 'refresh_token', 'type',
  ]);
  assert.equal(cpa.email, state.jobs[0].email);
  assert.match(cpa.email, /^base\+ctf[A-Za-z]{4}@example\.test$/);
  assert.equal(cpa.account_id, 'workspace-unit');
  const manifest = JSON.parse(fs.readFileSync(state.manifestPath, 'utf8'));
  assert.equal(manifest.counts.active, 1);
  assert.equal(JSON.stringify(manifest).includes('refresh-unit'), false);
});

test('scheduler due-time boundaries remain runnable instead of ending the run', async () => {
  const now = Date.parse('2026-08-04T18:07:42.718Z');
  const waits = [];
  const ready = await waitForNextDue([{
    status: 'waiting',
    nextRunAt: new Date(now).toISOString(),
  }], {
    state: { jobs: [] },
    now: () => now,
    control: { wait: async (milliseconds) => waits.push(milliseconds) },
  }, now + 60_000);

  assert.equal(ready, true);
  assert.deepEqual(waits, []);
});

test('preflight requires priced inventory with positive count and a proxy when configured', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-preflight-'));
  const accounts = [{ id: 26, email: 'base@example.test', tokenValid: true, bound: false }];
  const config = configFor(tempDir, accounts);
  config.sms.provider = 'smsbower';
  config.sms.maxPrice = 0.03;
  config.proxyPool = { required: true };
  const smsProvider = {
    name: 'smsbower',
    async preflight() {
      return {
        provider: 'smsbower',
        ready: true,
        balance: 1,
        service: { code: 'dr' },
        country: { id: 151 },
        prices: [{ price: 0.02, count: 0 }],
      };
    },
  };

  const emptyInventory = await preflightOrchestratorV2(config, { smsProvider, proxyEntries: [] });
  assert.equal(emptyInventory.ready, false);
  assert.equal(emptyInventory.sms.ready, false);
  assert.equal(emptyInventory.sms.cheapestPrice, null);
  assert.equal(emptyInventory.proxy.ready, false);

  smsProvider.preflight = async () => ({
    provider: 'smsbower',
    ready: true,
    balance: 1,
    service: { code: 'dr' },
    country: { id: 151 },
    prices: [{ price: 0.02 }],
  });
  const unknownInventory = await preflightOrchestratorV2(config, { smsProvider, proxyEntries: [] });
  assert.equal(unknownInventory.sms.ready, false);
  assert.equal(unknownInventory.sms.cheapestPrice, null);

  smsProvider.preflight = async () => ({
    provider: 'smsbower',
    ready: true,
    balance: 1,
    service: { code: 'dr' },
    country: { id: 151 },
    prices: [
      { provider_id: 401, price: 0.029, count: 3 },
      { provider_id: 402, price: 0.021, count: 7 },
      { provider_id: 403, price: 0.02, count: 2 },
      { provider_id: 404, price: 0.023, count: 5 },
    ],
  });
  const missingProxy = await preflightOrchestratorV2(config, { smsProvider, proxyEntries: [] });
  assert.equal(missingProxy.sms.ready, true);
  assert.equal(missingProxy.ready, false);
  assert.deepEqual(missingProxy.sms.lowestOffers, [
    { providerId: '403', price: 0.02, count: 2 },
    { providerId: '402', price: 0.021, count: 7 },
    { providerId: '404', price: 0.023, count: 5 },
  ]);
});

test('preflight enforces the task mailbox and proxy capacity requested by concurrency', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-preflight-capacity-'));
  const accounts = [
    { id: 260, email: 'capacity-one@example.test', tokenValid: true, bound: false },
    { id: 261, email: 'capacity-two@example.test', tokenValid: true, bound: false },
  ];
  const config = configureRequiredProxies(configFor(tempDir, accounts));
  const smsProvider = new MockSmsProvider();
  const oneProxy = await preflightOrchestratorV2(config, {
    smsProvider,
    proxyEntries: localProxyEntries(1),
  });

  assert.equal(oneProxy.mail.ready, true);
  assert.equal(oneProxy.proxy.requiredCount, 2);
  assert.equal(oneProxy.proxy.ready, false);
  assert.equal(oneProxy.ready, false);

  const enoughCapacity = await preflightOrchestratorV2(config, {
    smsProvider,
    proxyEntries: localProxyEntries(2),
  });
  assert.equal(enoughCapacity.ready, true);

  config.mail.count = 3;
  const mailboxShortfall = await preflightOrchestratorV2(config, {
    smsProvider,
    proxyEntries: localProxyEntries(2),
  });
  assert.equal(mailboxShortfall.mail.ready, false);
  assert.equal(mailboxShortfall.mail.requested, 3);
  assert.equal(mailboxShortfall.mail.selected, 2);
  assert.equal(mailboxShortfall.ready, false);
});

test('production preflight uses inline credentials and only calls read-only SMSBower actions', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-live-preflight-'));
  const accounts = [{ id: 27, email: 'base@example.test', tokenValid: true, bound: false }];
  const config = configFor(tempDir, accounts);
  delete config.mail.accounts;
  config.mail.password = 'unit-mail-secret';
  config.sms = {
    provider: 'smsbower',
    baseUrl: 'https://sms.example.test/stubs/handler_api.php',
    apiKey: 'unit-sms-secret',
    service: { code: 'dr' },
    country: { id: 151, name: 'Chile' },
    maxPrice: 0.03,
  };

  let loginPassword = '';
  const mailClient = {
    csrfToken: '',
    async login(password) {
      loginPassword = password;
      this.csrfToken = 'csrf-unit';
    },
    async listAccounts() { return accounts; },
  };
  const actions = [];
  const smsFetch = async (url) => {
    const action = new URL(url).searchParams.get('action');
    actions.push(action);
    const bodies = {
      getBalance: 'ACCESS_BALANCE:1',
      getCountries: { 151: { eng: 'Chile' } },
      getServicesList: [{ service: 'dr', name: 'OpenAI' }],
      getPricesV3: { status: 'success', data: [{ country: 151, service: 'dr', price: 0.03, count: 1 }] },
    };
    if (!Object.hasOwn(bodies, action)) throw new Error(`Unexpected SMSBower action: ${action}`);
    return {
      status: 200,
      headers: { get: () => null },
      text: async () => typeof bodies[action] === 'string' ? bodies[action] : JSON.stringify(bodies[action]),
    };
  };

  const result = await preflightOrchestratorV2(config, { mailClient, smsFetch, proxyEntries: [] });

  assert.equal(result.ready, true);
  assert.equal(loginPassword, 'unit-mail-secret');
  assert.deepEqual(actions, ['getBalance', 'getCountries', 'getServicesList', 'getPricesV3']);
  assert.equal(actions.includes('getNumberV2'), false);
  assert.equal(actions.includes('setStatus'), false);

  actions.length = 0;
  const expensiveSmsFetch = async (url) => {
    const action = new URL(url).searchParams.get('action');
    actions.push(action);
    const bodies = {
      getBalance: 'ACCESS_BALANCE:1',
      getCountries: { 151: { eng: 'Chile' } },
      getServicesList: [{ service: 'dr', name: 'OpenAI' }],
      getPricesV3: { status: 'success', data: [{ country: 151, service: 'dr', price: 0.031, count: 1 }] },
    };
    return {
      status: 200,
      headers: { get: () => null },
      text: async () => typeof bodies[action] === 'string' ? bodies[action] : JSON.stringify(bodies[action]),
    };
  };
  await assert.rejects(
    preflightOrchestratorV2(config, { mailClient, smsFetch: expensiveSmsFetch, proxyEntries: [] }),
    /cheapest price 0\.031 USD exceeds maxPrice 0\.03 USD/,
  );
  assert.deepEqual(actions, ['getBalance', 'getCountries', 'getServicesList', 'getPricesV3']);
});

test('production preflight supports environment credential fallback without returning secrets', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-env-preflight-'));
  const accounts = [{ id: 28, email: 'base@example.test', tokenValid: true, bound: false }];
  const config = configFor(tempDir, accounts);
  delete config.mail.accounts;
  config.mail.passwordEnv = 'GPT_RE_UNIT_MAIL_PASSWORD';
  config.sms = {
    provider: 'smsbower',
    baseUrl: 'https://sms.example.test/stubs/handler_api.php',
    apiKeyEnv: 'GPT_RE_UNIT_SMS_KEY',
    service: { code: 'dr' },
    country: { id: 151, name: 'Chile' },
    maxPrice: 0.03,
  };

  const mailSecret = 'unit-mail-environment-secret';
  const smsSecret = 'unit-sms-environment-secret';
  const previousMail = process.env.GPT_RE_UNIT_MAIL_PASSWORD;
  const previousSms = process.env.GPT_RE_UNIT_SMS_KEY;
  process.env.GPT_RE_UNIT_MAIL_PASSWORD = mailSecret;
  process.env.GPT_RE_UNIT_SMS_KEY = smsSecret;
  let loginPassword = '';
  const mailClient = {
    csrfToken: '',
    async login(password) {
      loginPassword = password;
      this.csrfToken = 'csrf-unit';
    },
    async listAccounts() { return accounts; },
  };
  const smsFetch = async (url) => {
    const action = new URL(url).searchParams.get('action');
    const bodies = {
      getBalance: 'ACCESS_BALANCE:1',
      getCountries: { 151: { eng: 'Chile' } },
      getServicesList: [{ service: 'dr', name: 'OpenAI' }],
      getPricesV3: { status: 'success', data: [{ country: 151, service: 'dr', price: 0.03, count: 1 }] },
    };
    return {
      status: 200,
      headers: { get: () => null },
      text: async () => typeof bodies[action] === 'string' ? bodies[action] : JSON.stringify(bodies[action]),
    };
  };

  try {
    const result = await preflightOrchestratorV2(config, { mailClient, smsFetch, proxyEntries: [] });
    const serialized = JSON.stringify(result);
    assert.equal(result.ready, true);
    assert.equal(loginPassword, mailSecret);
    assert.equal(serialized.includes(mailSecret), false);
    assert.equal(serialized.includes(smsSecret), false);
  } finally {
    if (previousMail === undefined) delete process.env.GPT_RE_UNIT_MAIL_PASSWORD;
    else process.env.GPT_RE_UNIT_MAIL_PASSWORD = previousMail;
    if (previousSms === undefined) delete process.env.GPT_RE_UNIT_SMS_KEY;
    else process.env.GPT_RE_UNIT_SMS_KEY = previousSms;
  }
});

test('v2 recovery reconciles an ambiguous email send without sending a second OTP', async () => {
  const { har } = loadHar();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-crash-'));
  const accounts = [{ id: 8, email: 'base@example.test', tokenValid: true, bound: false }];
  const config = configFor(tempDir, accounts);
  const mailClient = new MockMailboxClient(accounts);
  const smsProvider = new MockSmsProvider({ numbers: ['+56970000099'], codes: ['463193'] });
  const runner = mockRunner(har, mailClient, { crashAfterEmailSend: true });
  const stateFile = path.join(config.output.stateDir, 'run.json');
  const first = makeInitialOrchestratorV2State(config, { runId: config.runId });

  await assert.rejects(
    runOrchestratorV2(har, first, config, {
      mailClient,
      smsProvider,
      executor: runner.executor,
      tokenExecutor,
      sleep: async () => {},
      saveState: (next) => saveV2State(stateFile, next),
    }),
    /simulated crash/,
  );

  const resumed = loadV2State(stateFile);
  assert.equal(resumed.jobs[0].runner.inFlight.step, 'email_otp_send');
  resumeOrchestratorV2State(resumed);
  await runOrchestratorV2(har, resumed, config, {
    mailClient,
    smsProvider,
    executor: runner.executor,
    tokenExecutor,
    sleep: async () => {},
    saveState: (next) => saveV2State(stateFile, next),
  });

  assert.equal(resumed.jobs[0].status, 'complete');
  assert.equal(runner.stats.emailSends, 1);
  assert.equal(resumed.jobs[0].emailActivity.consumedMessageId, 'new-message');
});

test('email polling honors Retry-After without resending the OTP', async () => {
  const { har } = loadHar();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-mail-retry-after-'));
  const accounts = [{ id: 36, email: 'base@example.test', tokenValid: true, bound: false }];
  const config = configFor(tempDir, accounts);
  config.mail.timeoutMs = 10000;
  const mailClient = new MockMailboxClient(accounts);
  const originalFind = mailClient.findVerificationCode.bind(mailClient);
  let firstPoll = true;
  mailClient.findVerificationCode = async (...args) => {
    if (firstPoll) {
      firstPoll = false;
      const error = new Error('mailbox rate limited');
      error.status = 429;
      error.retryAfterMs = 5000;
      throw error;
    }
    return originalFind(...args);
  };
  const smsProvider = new MockSmsProvider({ numbers: ['+56970000001'], codes: ['100001'] });
  const runner = mockRunner(har, mailClient, { registrationWorkspaceSuccess: true });
  let clock = Date.parse('2026-07-28T00:00:00.000Z');
  const state = makeInitialOrchestratorV2State(config, { runId: 'run-v2-mail-retry-after', now: () => clock });

  await runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider,
    executor: runner.executor,
    tokenExecutor,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });

  assert.equal(state.status, 'complete');
  assert.equal(runner.stats.emailSends, 1);
  assert.ok(clock - Date.parse('2026-07-28T00:00:00.000Z') >= 5000);
});

test('v2 scheduler overlaps different mailbox lanes while keeping aliases from one root serial', async () => {
  const { har } = loadHar();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-concurrency-'));
  const accounts = [
    { id: 11, email: 'one@example.test', tokenValid: true, bound: false },
    { id: 12, email: 'two@example.test', tokenValid: true, bound: false },
  ];
  const config = configFor(tempDir, accounts, 2);
  const mailClient = new MockMailboxClient(accounts);
  const smsProvider = new MockSmsProvider({
    numbers: ['+56970000001', '+56970000002', '+56970000003', '+56970000004'],
    codes: ['100001', '100002', '100003', '100004'],
  });
  const runner = mockRunner(har, mailClient, { delayMs: 1 });
  const activeByRoot = new Map();
  const maxByRoot = new Map();
  const wrappedExecutor = async (request, step, runnerState) => {
    const root = runnerState.email.split('+', 1)[0];
    activeByRoot.set(root, (activeByRoot.get(root) || 0) + 1);
    maxByRoot.set(root, Math.max(maxByRoot.get(root) || 0, activeByRoot.get(root)));
    try {
      return await runner.executor(request, step, runnerState);
    } finally {
      activeByRoot.set(root, activeByRoot.get(root) - 1);
    }
  };
  const state = makeInitialOrchestratorV2State(config, { runId: 'run-v2-concurrency' });

  await runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider,
    executor: wrappedExecutor,
    tokenExecutor: jobTokenExecutor,
    sleep: async () => {},
  });

  assert.equal(state.jobs.length, 4);
  assert.equal(state.jobs.every((job) => job.status === 'complete'), true);
  assert.ok(runner.stats.maxActive >= 2);
  assert.equal(Math.max(...maxByRoot.values()), 1);
});

test('global SMS exposure never exceeds the configured pending-activation cap', async () => {
  const { har } = loadHar();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-sms-capacity-'));
  const accounts = [
    { id: 31, email: 'one@example.test', tokenValid: true, bound: false },
    { id: 32, email: 'two@example.test', tokenValid: true, bound: false },
    { id: 33, email: 'three@example.test', tokenValid: true, bound: false },
  ];
  const config = configFor(tempDir, accounts);
  config.workers.maxConcurrency = 3;
  config.sms.maxPendingCancellations = 2;
  const mailClient = new MockMailboxClient(accounts);
  const smsProvider = new MockSmsProvider({
    numbers: ['+56970000001', '+56970000002', '+56970000003'],
    codes: ['100001', '100002', '100003'],
  });
  const originalAcquire = smsProvider.acquireNumber.bind(smsProvider);
  let maxActive = 0;
  smsProvider.acquireNumber = async (options) => {
    const lease = await originalAcquire(options);
    const active = smsProvider.snapshot().filter((item) => !['complete', 'cancelled'].includes(item.status)).length;
    maxActive = Math.max(maxActive, active);
    return lease;
  };
  const runner = mockRunner(har, mailClient, { registrationWorkspaceSuccess: true });
  let clock = Date.parse('2026-07-28T00:00:00.000Z');
  const state = makeInitialOrchestratorV2State(config, { runId: 'run-v2-sms-capacity', now: () => clock });

  await runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider,
    executor: runner.executor,
    tokenExecutor: jobTokenExecutor,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });

  assert.equal(state.status, 'complete');
  assert.equal(state.jobs.every((job) => job.status === 'complete'), true);
  assert.equal(maxActive, 2);
});

test('five consecutive fraud_guard responses cool the Chile dr market for fifteen minutes', async () => {
  const { har } = loadHar();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-fraud-cooldown-'));
  const accounts = [{ id: 34, email: 'base@example.test', tokenValid: true, bound: false }];
  const config = configFor(tempDir, accounts);
  config.registration.maxRuntimeMs = 1_000_000;
  const mailClient = new MockMailboxClient(accounts);
  const smsProvider = new MockSmsProvider({
    numbers: Array.from({ length: 6 }, (_, index) => `+5697000${String(index + 1).padStart(4, '0')}`),
    codes: ['100001'],
  });
  const runner = mockRunner(har, mailClient, {
    rejectedPhones: 5,
    fraudAttempts: [1, 2, 3, 4, 5],
    registrationWorkspaceSuccess: true,
  });
  const started = Date.parse('2026-07-28T00:00:00.000Z');
  let clock = started;
  const state = makeInitialOrchestratorV2State(config, { runId: 'run-v2-fraud-cooldown', now: () => clock });

  await runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider,
    executor: runner.executor,
    tokenExecutor,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });

  const market = Object.values(state.smsMarkets)[0];
  assert.equal(state.status, 'complete');
  assert.equal(runner.stats.phoneAttempts, 6);
  assert.equal(market.fraudGuardStreak, 0);
  assert.ok(Date.parse(market.cooldownUntil) - started >= 900000);
  assert.ok(clock - started >= 900000);
});

test('invalid phone numbers are cancelled, logged, and replaced before the run continues', async () => {
  const { har } = loadHar();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-invalid-phone-'));
  const accounts = [{ id: 35, email: 'invalid-phone@example.test', tokenValid: true, bound: false }];
  const config = configFor(tempDir, accounts);
  const mailClient = new MockMailboxClient(accounts);
  const smsProvider = new MockSmsProvider({ numbers: ['+56970000001', '+56970000002'], codes: ['100001'] });
  const runner = mockRunner(har, mailClient, {
    rejectedPhones: 1,
    rejectionCode: 'invalid_phone_number',
    registrationWorkspaceSuccess: true,
  });
  let clock = Date.parse('2026-07-28T00:00:00.000Z');
  const state = makeInitialOrchestratorV2State(config, { runId: 'run-v2-invalid-phone', now: () => clock });

  await runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider,
    executor: runner.executor,
    tokenExecutor: jobTokenExecutor,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });

  const eventTypes = state.events.map((event) => event.type);
  assert.equal(state.status, 'complete');
  assert.equal(runner.stats.phoneAttempts, 2);
  assert.equal(smsProvider.snapshot()[0].status, 'cancelled');
  assert.equal(smsProvider.snapshot().some((lease) => lease.status === 'leased'), false);
  for (const type of ['sms_inventory_poll_started', 'sms_number_acquired', 'sms_cancel_started', 'sms_cancelled', 'sms_code_poll_started', 'sms_code_received']) {
    assert.equal(eventTypes.includes(type), true, `missing event ${type}`);
  }
});

test('provider number format failures are recorded and retried after activation cleanup', async () => {
  const { har } = loadHar();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-provider-phone-format-'));
  const accounts = [{ id: 36, email: 'provider-format@example.test', tokenValid: true, bound: false }];
  const config = configFor(tempDir, accounts);
  const mailClient = new MockMailboxClient(accounts);
  const smsProvider = new MockSmsProvider({ numbers: ['+56970000002'], codes: ['100001'] });
  const originalAcquire = smsProvider.acquireNumber.bind(smsProvider);
  let firstAcquire = true;
  smsProvider.acquireNumber = async (options) => {
    if (!firstAcquire) return originalAcquire(options);
    firstAcquire = false;
    const error = new SmsBowerError('provider returned a mismatched number', { code: 'INVALID_PHONE_COUNTRY_FORMAT' });
    error.invalidLease = {
      id: 'bad-provider-lease',
      activationId: 'bad-provider-lease',
      provider: 'mock',
      number: '15551234567',
      service: 'dr',
      country: '151',
      countryCode: '56',
      providerCountryCode: '151',
      status: 'cancelled',
    };
    throw error;
  };
  const runner = mockRunner(har, mailClient, { registrationWorkspaceSuccess: true });
  let clock = Date.parse('2026-07-28T00:00:00.000Z');
  const state = makeInitialOrchestratorV2State(config, { runId: 'run-v2-provider-phone-format', now: () => clock });

  await runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider,
    executor: runner.executor,
    tokenExecutor: jobTokenExecutor,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });

  const job = state.jobs[0];
  assert.equal(state.status, 'complete');
  assert.equal(runner.stats.phoneAttempts, 1);
  assert.equal(job.sms.attempts[0].status, 'cancelled');
  assert.equal(job.sms.attempts[0].rejectReason, 'INVALID_PHONE_COUNTRY_FORMAT');
  assert.equal(job.sms.replacementWindowUsed, 2);
  assert.equal(state.events.some((event) => event.type === 'sms_number_normalization_rejected'), true);
});

test('empty SMS inventory uses a fixed eight-second polling interval', async () => {
  const { har } = loadHar();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-inventory-interval-'));
  const accounts = [{ id: 37, email: 'inventory-interval@example.test', tokenValid: true, bound: false }];
  const config = configFor(tempDir, accounts);
  const mailClient = new MockMailboxClient(accounts);
  const smsProvider = new MockSmsProvider({ numbers: ['+56970000002'], codes: ['100001'] });
  const originalAcquire = smsProvider.acquireNumber.bind(smsProvider);
  let unavailable = true;
  smsProvider.acquireNumber = async (options) => {
    if (!unavailable) return originalAcquire(options);
    unavailable = false;
    throw new SmsBowerError('no allocatable number', { code: 'NO_NUMBERS' });
  };
  const runner = mockRunner(har, mailClient, { registrationWorkspaceSuccess: true });
  let clock = Date.parse('2026-07-28T00:00:00.000Z');
  const delays = [];
  const state = makeInitialOrchestratorV2State(config, { runId: 'run-v2-inventory-interval', now: () => clock });

  await runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider,
    executor: runner.executor,
    tokenExecutor: jobTokenExecutor,
    now: () => clock,
    sleep: async (ms) => { delays.push(ms); clock += ms; },
  });

  const waitingEvent = state.events.find((event) => event.type === 'sms_inventory_poll_waiting');
  assert.equal(state.status, 'complete');
  assert.equal(waitingEvent.delayMs, 8000);
  assert.equal(delays.includes(8000), true);
});

test('v2 scheduler finishes delayed SMSBower cancellation cleanup after account completion', async () => {
  const { har } = loadHar();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-cleanup-'));
  const accounts = [{ id: 21, email: 'cleanup@example.test', tokenValid: true, bound: false }];
  const config = configFor(tempDir, accounts);
  const mailClient = new MockMailboxClient(accounts);
  const smsProvider = new MockSmsProvider({ numbers: ['+56970000001', '+56970000002'], codes: ['100001'] });
  const originalCancel = smsProvider.cancel.bind(smsProvider);
  let firstCancellation = true;
  smsProvider.cancel = async (lease, reason) => {
    if (firstCancellation) {
      firstCancellation = false;
      throw new SmsBowerError('wait before cancellation', { code: 'EARLY_CANCEL_DENIED' });
    }
    return originalCancel(lease, reason);
  };
  const runner = mockRunner(har, mailClient, { rejectedPhones: 1 });
  let clock = Date.parse('2026-07-28T00:00:00.000Z');
  const state = makeInitialOrchestratorV2State(config, { runId: 'run-v2-cleanup', now: () => clock });

  await runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider,
    executor: runner.executor,
    tokenExecutor: jobTokenExecutor,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });

  assert.equal(state.jobs[0].status, 'complete');
  assert.equal(state.jobs[0].sms.pendingCleanup[0].status, 'cancelled');
  assert.equal(state.status, 'complete');
});

test('v2 scheduler resends through OpenAI on the same accepted number after timeout without SMS status 3', async () => {
  const { har } = loadHar();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-resend-'));
  const accounts = [{ id: 22, email: 'resend@example.test', tokenValid: true, bound: false }];
  const config = configFor(tempDir, accounts);
  config.sms.codeTimeoutMs = 1;
  config.sms.pollIntervalMs = 1;
  const mailClient = new MockMailboxClient(accounts);
  const smsProvider = new MockSmsProvider({ numbers: ['+56970000001'] });
  const runner = mockRunner(har, mailClient);
  let requestAnotherCalls = 0;
  let pollCount = 0;
  const originalRetry = smsProvider.requestAnotherCode.bind(smsProvider);
  smsProvider.requestAnotherCode = async (lease) => {
    requestAnotherCalls += 1;
    return originalRetry(lease);
  };
  smsProvider.pollCode = async (lease) => {
    pollCount += 1;
    if (runner.stats.phoneAttempts < 2) return null;
    return { leaseId: lease.id, number: lease.number, code: '100001', receivedAt: '2026-07-28T00:00:02.000Z' };
  };
  let clock = Date.parse('2026-07-28T00:00:00.000Z');
  const state = makeInitialOrchestratorV2State(config, { runId: 'run-v2-resend', now: () => clock });

  await runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider,
    executor: runner.executor,
    tokenExecutor: jobTokenExecutor,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });

  assert.equal(state.jobs[0].status, 'complete');
  assert.equal(requestAnotherCalls, 0);
  assert.ok(pollCount >= 2);
  assert.equal(runner.stats.phoneAttempts, 2);
  assert.deepEqual(runner.stats.phoneNumbers, ['+56970000001', '+56970000001']);
  assert.equal(state.jobs[0].sms.sendRetryCount, 1);
  assert.equal(state.jobs[0].sms.replacementWindowUsed, 1);
});

test('phone continuity pauses after 2/5/10 second retries and resumes with a fresh Sentinel on the same resources', async () => {
  const { har } = loadHar();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-continuity-'));
  const accounts = [{ id: 23, email: 'base@example.test', tokenValid: true, bound: false }];
  const config = configFor(tempDir, accounts);
  const mailClient = new MockMailboxClient(accounts);
  const smsProvider = new MockSmsProvider({ numbers: ['+56970000001'], codes: ['100001'] });
  const behavior = { phoneRecentlyUsed: 100, registrationWorkspaceSuccess: true };
  const runner = mockRunner(har, mailClient, behavior);
  const proxyEntries = [{ id: 'proxy-unit', url: 'http://127.0.0.1:2080' }];
  let clock = Date.parse('2026-07-28T00:00:00.000Z');
  const delays = [];
  const state = makeInitialOrchestratorV2State(config, { runId: 'run-v2-continuity', now: () => clock });

  await runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider,
    proxyEntries,
    executor: runner.executor,
    tokenExecutor,
    now: () => clock,
    sleep: async (ms) => { delays.push(ms); clock += ms; },
  });

  const job = state.jobs[0];
  assert.equal(state.status, 'waiting');
  assert.equal(job.phase, 'waiting_phone_continuity');
  assert.equal(job.status, 'waiting');
  assert.equal(job.nextRunAt, '');
  assert.equal(runner.stats.createAttempts, 4);
  assert.deepEqual(delays.filter((ms) => [2000, 5000, 10000].includes(ms)), [2000, 5000, 10000]);
  assert.equal(job.runner.next, RUN_STEPS.findIndex((step) => step.name === 'sentinel_oauth_create_account'));

  const phone = job.sms.current.number;
  const oauthState = job.runner.oauth.state;
  const proxyId = job.proxy.id;
  const stepOffset = runner.stats.steps.length;
  behavior.phoneRecentlyUsed = 4;
  resumeOrchestratorV2State(state);

  await runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider,
    proxyEntries,
    executor: runner.executor,
    tokenExecutor,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
  });

  assert.equal(state.status, 'complete');
  assert.equal(job.sms.current.number, phone);
  assert.equal(job.runner.oauth.state, oauthState);
  assert.equal(job.proxy.id, proxyId);
  assert.equal(runner.stats.steps[stepOffset], 'sentinel_oauth_create_account');
});

test('a transient cancellation failure retains the activation for an explicit resume', async () => {
  const { har } = loadHar();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-cancel-retry-'));
  const accounts = [{ id: 24, email: 'base@example.test', tokenValid: true, bound: false }];
  const config = configFor(tempDir, accounts);
  const mailClient = new MockMailboxClient(accounts);
  const smsProvider = new MockSmsProvider({ numbers: ['+56970000001', '+56970000002'], codes: ['100001'] });
  const originalCancel = smsProvider.cancel.bind(smsProvider);
  let failCancellation = true;
  smsProvider.cancel = async (lease, reason) => {
    if (failCancellation) {
      throw new SmsBowerError('temporary cancellation failure', { code: 'HTTP_500', httpStatus: 500 });
    }
    return originalCancel(lease, reason);
  };
  const runner = mockRunner(har, mailClient, { rejectedPhones: 1 });
  const state = makeInitialOrchestratorV2State(config, { runId: 'run-v2-cancel-retry' });

  await runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider,
    executor: runner.executor,
    tokenExecutor,
    sleep: async () => {},
  });

  assert.equal(state.status, 'waiting');
  assert.ok(state.jobs[0].sms.current?.id);
  assert.equal(state.jobs[0].sms.pendingCleanup.length, 0);
  assert.equal(runner.stats.phoneAttempts, 1);

  failCancellation = false;
  resumeOrchestratorV2State(state);
  await runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider,
    executor: runner.executor,
    tokenExecutor,
    sleep: async () => {},
  });

  assert.equal(state.status, 'complete');
  assert.equal(runner.stats.phoneAttempts, 2);
  assert.equal(state.jobs[0].sms.attempts[0].status, 'cancelled');
});

test('a crash after remote SMS completion is reconciled without a second status 6 request', async () => {
  const { har } = loadHar();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-complete-recovery-'));
  const accounts = [{ id: 25, email: 'base@example.test', tokenValid: true, bound: false }];
  const config = configFor(tempDir, accounts);
  const mailClient = new MockMailboxClient(accounts);
  const smsProvider = new MockSmsProvider({ numbers: ['+56970000001'], codes: ['100001'] });
  const originalComplete = smsProvider.complete.bind(smsProvider);
  let completionCalls = 0;
  let crash = true;
  smsProvider.complete = async (lease) => {
    completionCalls += 1;
    const completed = await originalComplete(lease);
    if (crash) {
      crash = false;
      const error = new Error('simulated crash after SMS status 6');
      error.code = 'ESIMULATEDCRASH';
      error.fatal = true;
      throw error;
    }
    return completed;
  };
  const runner = mockRunner(har, mailClient);
  const stateFile = path.join(config.output.stateDir, 'run.json');
  const state = makeInitialOrchestratorV2State(config, { runId: 'run-v2-complete-recovery' });

  await assert.rejects(runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider,
    executor: runner.executor,
    tokenExecutor,
    sleep: async () => {},
    saveState: (next) => saveV2State(stateFile, next),
  }), /simulated crash/);

  const resumed = loadV2State(stateFile);
  assert.equal(resumed.jobs[0].sms.effect.kind, 'sms_complete');
  resumeOrchestratorV2State(resumed);
  await runOrchestratorV2(har, resumed, config, {
    mailClient,
    smsProvider,
    executor: runner.executor,
    tokenExecutor,
    sleep: async () => {},
    saveState: (next) => saveV2State(stateFile, next),
  });

  assert.equal(resumed.status, 'complete');
  assert.equal(resumed.jobs[0].sms.current.status, 'complete');
  assert.equal(completionCalls, 1);
});

test('explicit effect retry clears an ambiguous runner intent and refreshes create-account Sentinel', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-effect-resolution-'));
  const config = configFor(tempDir, [{ id: 27, email: 'base@example.test' }]);
  const state = makeInitialOrchestratorV2State(config, { runId: 'run-v2-effect-resolution' });
  const createIndex = RUN_STEPS.findIndex((step) => step.name === 'create_account');
  const sentinelIndex = RUN_STEPS.findIndex((step) => step.name === 'sentinel_oauth_create_account');
  state.jobs.push({
    id: 'job-ambiguous',
    status: 'waiting',
    phase: 'waiting_reconcile_create_account',
    branch: 'registration',
    runner: {
      next: createIndex,
      complete: false,
      blocked: null,
      inFlight: { step: 'create_account' },
    },
    effect: { kind: 'runner', step: 'create_account' },
    sms: { current: { id: 'sms-unit', number: '+56970000001' }, attempts: [], pendingCleanup: [] },
    attempts: { phoneContinuity: 0 },
  });

  assert.throws(
    () => resumeOrchestratorV2State(state, { effectResolution: 'retry' }),
    /specific jobId/,
  );
  resumeOrchestratorV2State(state, { jobId: 'job-ambiguous', effectResolution: 'retry' });
  assert.equal(state.jobs[0].runner.next, sentinelIndex);
  assert.equal(state.jobs[0].runner.inFlight, null);
  assert.equal(state.jobs[0].effect, null);
  assert.equal(state.jobs[0].manualEffectResolution.step, 'create_account');
});

test('mailbox reservation intent is reconciled after the remote bind succeeds before a crash', async () => {
  const { har } = loadHar();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-mail-reserve-'));
  const accounts = [{ id: 28, email: 'base@example.test', tokenValid: true, bound: false }];
  const config = configFor(tempDir, accounts);
  const mailClient = new MockMailboxClient(accounts);
  let crash = true;
  mailClient.reserveMailbox = async (id) => {
    mailClient.reserved.push(id);
    if (crash) {
      crash = false;
      const error = new Error('simulated crash after mailbox bind');
      error.code = 'ESIMULATEDCRASH';
      error.fatal = true;
      throw error;
    }
  };
  const smsProvider = new MockSmsProvider({ numbers: ['+56970000001'], codes: ['100001'] });
  const runner = mockRunner(har, mailClient, { registrationWorkspaceSuccess: true });
  const stateFile = path.join(config.output.stateDir, 'run.json');
  const state = makeInitialOrchestratorV2State(config, { runId: 'run-v2-mail-reserve' });

  await assert.rejects(runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider,
    executor: runner.executor,
    tokenExecutor,
    sleep: async () => {},
    saveState: (next) => saveV2State(stateFile, next),
  }), /simulated crash/);

  const resumed = loadV2State(stateFile);
  assert.equal(resumed.mailboxes[0].status, 'reserving');
  resumeOrchestratorV2State(resumed);
  await runOrchestratorV2(har, resumed, config, {
    mailClient,
    smsProvider,
    executor: runner.executor,
    tokenExecutor,
    sleep: async () => {},
    saveState: (next) => saveV2State(stateFile, next),
  });

  assert.equal(resumed.status, 'complete');
  assert.equal(resumed.mailboxes[0].status, 'complete');
  assert.deepEqual(mailClient.reserved, [28, 28]);
});

test('SMS status 1 intent is reconciled after a crash without repeating the provider mutation', async () => {
  const { har } = loadHar();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-sms-ready-'));
  const accounts = [{ id: 29, email: 'base@example.test', tokenValid: true, bound: false }];
  const config = configFor(tempDir, accounts);
  const mailClient = new MockMailboxClient(accounts);
  const smsProvider = new MockSmsProvider({ numbers: ['+56970000001'], codes: ['100001'] });
  const originalMark = smsProvider.markSmsSent.bind(smsProvider);
  let markCalls = 0;
  let crash = true;
  smsProvider.markSmsSent = async (lease) => {
    markCalls += 1;
    const updated = await originalMark(lease);
    if (crash) {
      crash = false;
      const error = new Error('simulated crash after SMS status 1');
      error.code = 'ESIMULATEDCRASH';
      error.fatal = true;
      throw error;
    }
    return updated;
  };
  const runner = mockRunner(har, mailClient, { registrationWorkspaceSuccess: true });
  const stateFile = path.join(config.output.stateDir, 'run.json');
  const state = makeInitialOrchestratorV2State(config, { runId: 'run-v2-sms-ready' });

  await assert.rejects(runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider,
    executor: runner.executor,
    tokenExecutor,
    sleep: async () => {},
    saveState: (next) => saveV2State(stateFile, next),
  }), /simulated crash/);

  const resumed = loadV2State(stateFile);
  assert.equal(resumed.jobs[0].sms.effect.kind, 'sms_mark_sent');
  resumeOrchestratorV2State(resumed);
  await runOrchestratorV2(har, resumed, config, {
    mailClient,
    smsProvider,
    executor: runner.executor,
    tokenExecutor,
    sleep: async () => {},
    saveState: (next) => saveV2State(stateFile, next),
  });

  assert.equal(resumed.status, 'complete');
  assert.equal(markCalls, 1);
});

test('SMS status 3 intent after invalid_input resumes without replaying the stale code', async () => {
  const { har } = loadHar();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-sms-retry-'));
  const accounts = [{ id: 30, email: 'base@example.test', tokenValid: true, bound: false }];
  const config = configFor(tempDir, accounts);
  const mailClient = new MockMailboxClient(accounts);
  const smsProvider = new MockSmsProvider({ numbers: ['+56970000001'], codes: ['100001'] });
  const originalRequest = smsProvider.requestAnotherCode.bind(smsProvider);
  let requestCalls = 0;
  let crash = true;
  smsProvider.requestAnotherCode = async (lease) => {
    requestCalls += 1;
    const updated = await originalRequest(lease);
    if (crash) {
      crash = false;
      const error = new Error('simulated crash after SMS status 3');
      error.code = 'ESIMULATEDCRASH';
      error.fatal = true;
      throw error;
    }
    return updated;
  };
  const runner = mockRunner(har, mailClient, { invalidPhoneCodes: 1, registrationWorkspaceSuccess: true });
  const stateFile = path.join(config.output.stateDir, 'run.json');
  let clock = Date.parse('2026-07-28T00:00:00.000Z');
  const state = makeInitialOrchestratorV2State(config, { runId: 'run-v2-sms-retry', now: () => clock });

  await assert.rejects(runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider,
    executor: runner.executor,
    tokenExecutor,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    saveState: (next) => saveV2State(stateFile, next),
  }), /simulated crash/);

  const resumed = loadV2State(stateFile);
  assert.equal(resumed.jobs[0].sms.effect.kind, 'sms_request_another');
  smsProvider.codes.push('100002');
  resumeOrchestratorV2State(resumed);
  await runOrchestratorV2(har, resumed, config, {
    mailClient,
    smsProvider,
    executor: runner.executor,
    tokenExecutor,
    now: () => clock,
    sleep: async (ms) => { clock += ms; },
    saveState: (next) => saveV2State(stateFile, next),
  });

  assert.equal(resumed.status, 'complete');
  assert.equal(requestCalls, 1);
  assert.equal(runner.stats.phoneAttempts, 2);
  assert.deepEqual(runner.stats.phoneCodes, ['100001', '100002']);
  assert.equal(resumed.jobs[0].sms.replacementWindowUsed, 1);
});

test('invalid_input requests one more code on the same activation and never replays the stale code', async () => {
  const { har } = loadHar();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-invalid-code-'));
  const accounts = [{ id: 31, email: 'base@example.test', tokenValid: true, bound: false }];
  const config = configFor(tempDir, accounts);
  const mailClient = new MockMailboxClient(accounts);
  const smsProvider = new MockSmsProvider({ numbers: ['+56970000001'], codes: ['100001', '100002'] });
  const originalRequest = smsProvider.requestAnotherCode.bind(smsProvider);
  let requestCalls = 0;
  smsProvider.requestAnotherCode = async (lease) => {
    requestCalls += 1;
    return originalRequest(lease);
  };
  const runner = mockRunner(har, mailClient, { invalidPhoneCodes: 1, registrationWorkspaceSuccess: true });
  const state = makeInitialOrchestratorV2State(config, { runId: 'run-v2-invalid-code' });

  await runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider,
    executor: runner.executor,
    tokenExecutor,
    sleep: async () => {},
  });

  assert.equal(state.status, 'complete');
  assert.equal(requestCalls, 1);
  assert.deepEqual(runner.stats.phoneNumbers, ['+56970000001', '+56970000001']);
  assert.deepEqual(runner.stats.phoneCodes, ['100001', '100002']);
});

test('BAD_STATUS while requesting another code closes the old activation and acquires a new number', async () => {
  const { har } = loadHar();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-bad-status-'));
  const accounts = [{ id: 32, email: 'base@example.test', tokenValid: true, bound: false }];
  const config = configFor(tempDir, accounts);
  const mailClient = new MockMailboxClient(accounts);
  const smsProvider = new MockSmsProvider({
    numbers: ['+56970000001', '+56970000002'],
    codes: ['100001', '200002'],
  });
  let requestCalls = 0;
  smsProvider.requestAnotherCode = async () => {
    requestCalls += 1;
    throw new SmsBowerError('SMSBower setStatus failed: BAD_STATUS', { code: 'BAD_STATUS', action: 'setStatus' });
  };
  const runner = mockRunner(har, mailClient, { invalidPhoneCodes: 1, registrationWorkspaceSuccess: true });
  const state = makeInitialOrchestratorV2State(config, { runId: 'run-v2-bad-status' });

  await runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider,
    executor: runner.executor,
    tokenExecutor,
    sleep: async () => {},
  });

  assert.equal(state.status, 'complete');
  assert.equal(requestCalls, 1);
  assert.deepEqual(runner.stats.phoneNumbers, ['+56970000001', '+56970000002']);
  assert.deepEqual(runner.stats.phoneCodes, ['100001', '200002']);
  assert.equal(state.jobs[0].sms.attempts[0].rejectReason, 'sms_request_another_bad_status');
});

test('an ambiguous SMS status 3 mutation is reconciled automatically every eight seconds', async () => {
  const { har } = loadHar();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-status-reconcile-'));
  const accounts = [{ id: 33, email: 'base@example.test', tokenValid: true, bound: false }];
  const config = configFor(tempDir, accounts);
  const mailClient = new MockMailboxClient(accounts);
  const smsProvider = new MockSmsProvider({ numbers: ['+56970000001'], codes: ['100001', '100002'] });
  smsProvider.requestAnotherCode = async () => {
    throw new SmsBowerError('uncertain status mutation', { code: 'HTTP_500', httpStatus: 500, action: 'setStatus' });
  };
  let reconcileCalls = 0;
  smsProvider.reconcile = async (lease) => {
    reconcileCalls += 1;
    return { ...lease, status: reconcileCalls === 1 ? 'waiting_code' : 'retry_requested' };
  };
  const runner = mockRunner(har, mailClient, { invalidPhoneCodes: 1, registrationWorkspaceSuccess: true });
  let clock = Date.parse('2026-07-28T00:00:00.000Z');
  const delays = [];
  const state = makeInitialOrchestratorV2State(config, { runId: 'run-v2-status-reconcile', now: () => clock });

  await runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider,
    executor: runner.executor,
    tokenExecutor,
    now: () => clock,
    sleep: async (ms) => { delays.push(ms); clock += ms; },
  });

  assert.equal(state.status, 'complete');
  assert.equal(reconcileCalls, 2);
  assert.equal(delays.filter((delay) => delay === 8000).length, 2);
  assert.deepEqual(runner.stats.phoneCodes, ['100001', '100002']);
});

test('terminal cancelled runs cannot be resumed', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-terminal-resume-'));
  const config = configFor(tempDir, [{ id: 34, email: 'base@example.test' }]);
  const state = makeInitialOrchestratorV2State(config, { runId: 'run-v2-terminal-resume' });
  state.status = 'cancelled';

  assert.throws(() => resumeOrchestratorV2State(state), (error) => {
    assert.equal(error.code, 'TERMINAL_RUN');
    assert.match(error.message, /cancelled/);
    return true;
  });
});

test('v2 summary separates a balance-matched cancellation quote from confirmed SMS spend', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-cost-summary-'));
  const config = configFor(tempDir, [{ id: 35, email: 'base@example.test' }]);
  const state = makeInitialOrchestratorV2State(config, { runId: 'run-v2-cost-summary' });
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
    id: 'job-v2-cost-summary',
    email: 'base@example.test',
    status: 'complete',
    phase: 'complete',
    accountCreatedAt: '2026-08-31T00:00:05.000Z',
    sms: {
      attempts: [
        { id: 'activation-cancelled', status: 'cancelled', cost: 0.495 },
        { id: 'activation-complete', status: 'complete', cost: 0.33 },
      ],
    },
  }];

  const summary = summarizeOrchestratorV2State(state);
  assert.equal(summary.costs.sms, 0.33);
  assert.equal(summary.billing.unresolvedUsd, 0);
  assert.equal(summary.billing.cancelledQuotesSettledUsd, 0.495);
  assert.equal(summary.balanceReconciliation.note, 'balance_matched_cancelled_quotes_excluded');
  assert.equal(summary.balanceReconciliation.unresolved, 0);
});

test('v2 summaries put a failed job error into its result without dropping the error object', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-failure-result-'));
  const config = configFor(tempDir, [{ id: 36, email: 'failed@example.test' }]);
  const state = makeInitialOrchestratorV2State(config, { runId: 'run-v2-failure-result' });
  state.jobs = [{
    id: 'job-v2-failure-result',
    email: 'failed@example.test',
    status: 'failed',
    phase: 'failed',
    error: { code: 'RATE_LIMIT_EXCEEDED', message: 'oauth_phone_send request was throttled' },
  }];

  const summary = summarizeOrchestratorV2State(state);
  assert.equal(summary.jobs[0].result, '失败：RATE_LIMIT_EXCEEDED，oauth_phone_send request was throttled');
  assert.deepEqual(summary.jobs[0].error, state.jobs[0].error);
});

test('resuming a timed-out run preserves an ambiguous SMS mutation for reconciliation', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-reconcile-resume-'));
  const config = configFor(tempDir, [{ id: 35, email: 'base@example.test' }]);
  const state = makeInitialOrchestratorV2State(config, { runId: 'run-v2-reconcile-resume' });
  state.status = 'waiting';
  state.jobs.push({
    id: 'job-reconcile-resume',
    status: 'waiting',
    phase: 'waiting_sms_request_reconcile',
    branch: 'registration',
    nextRunAt: '2026-07-28T00:00:08.000Z',
    runner: { blocked: null },
    sms: {
      current: { id: 'sms-reconcile', activationId: 'sms-reconcile', status: 'waiting_code' },
      effect: { kind: 'sms_request_another', activationId: 'sms-reconcile', reconcileAttempts: 1 },
    },
    attempts: {},
  });

  resumeOrchestratorV2State(state);

  assert.equal(state.jobs[0].status, 'runnable');
  assert.equal(state.jobs[0].sms.effect.kind, 'sms_request_another');
  assert.equal(state.jobs[0].sms.effect.reconcileAttempts, 1);
});

test('resuming an ambiguous number acquisition archives the intent before allowing a new purchase', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-acquire-resume-'));
  const config = configFor(tempDir, [{ id: 36, email: 'base@example.test' }]);
  const state = makeInitialOrchestratorV2State(config, { runId: 'run-v2-acquire-resume' });
  state.status = 'waiting';
  state.jobs.push({
    id: 'job-acquire-resume', status: 'waiting', phase: 'waiting_sms_acquire_reconcile',
    branch: 'registration', nextRunAt: '', runner: { blocked: null }, attempts: {},
    sms: {
      current: null, attempts: [], acquisitions: [], pendingCleanup: [],
      effect: {
        id: 'sms-acquire-uncertain', kind: 'sms_acquire', service: 'dr', country: '151', maxPrice: 0.055,
        request: { serviceCode: 'dr', countryId: '151', maxPrice: 0.055 },
      },
    },
  });

  resumeOrchestratorV2State(state);

  assert.equal(state.jobs[0].sms.effect, null);
  assert.equal(state.jobs[0].sms.acquisitions[0].status, 'operator_retry');
  assert.equal(state.jobs[0].sms.acquisitions[0].id, 'sms-acquire-uncertain');
  assert.equal(state.events.at(-1).type, 'sms_acquisition_retry_authorized');
});

test('skipping an alias releases its proxy lease for the next job', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-skip-proxy-'));
  const accounts = [{ id: 35, email: 'base@example.test', tokenValid: true, bound: false }];
  const config = configFor(tempDir, accounts, 2);
  const state = makeInitialOrchestratorV2State(config, { runId: 'run-v2-skip-proxy' });
  state.mailboxes.push({ id: 35, rootEmail: 'base@example.test', status: 'reserved', successCount: 0 });
  state.jobs.push(
    {
      id: 'job-first', mailboxId: 35, aliasIndex: 1, email: 'base+ctf001@example.test', status: 'waiting', phase: 'waiting_error',
      proxy: { id: 'proxy-unit', url: 'http://127.0.0.1:2080', sticky: true },
      sms: { current: null, attempts: [], pendingCleanup: [] },
    },
    {
      id: 'job-second', mailboxId: 35, aliasIndex: 2, email: 'base+ctf002@example.test', status: 'queued', phase: 'registration',
      proxy: null, sms: { current: null, attempts: [], pendingCleanup: [] },
    },
  );
  state.proxyLeases = { 'job-first': 'proxy-unit' };

  await skipAliasV2(state, config, 'job-first', {
    mailClient: new MockMailboxClient(accounts),
    smsProvider: new MockSmsProvider(),
  });

  assert.equal(state.jobs[0].status, 'skipped');
  assert.deepEqual(state.proxyLeases, {});
  assert.equal(state.jobs[1].status, 'queued');
});

test('different root mailboxes hold exclusive proxy leases while running concurrently', async () => {
  const { har } = loadHar();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-proxy-roots-'));
  const accounts = [
    { id: 41, email: 'one@example.test', tokenValid: true, bound: false },
    { id: 42, email: 'two@example.test', tokenValid: true, bound: false },
  ];
  const config = configureRequiredProxies(configFor(tempDir, accounts));
  const mailClient = new MockMailboxClient(accounts);
  const smsProvider = new MockSmsProvider({
    numbers: ['+56970000001', '+56970000002'],
    codes: ['100001', '100002'],
  });
  const proxies = localProxyEntries(2);
  const runner = mockRunner(har, mailClient, { delayMs: 1 });
  const state = makeInitialOrchestratorV2State(config, { runId: 'run-v2-proxy-roots' });
  const proxyByRoot = new Map();
  const executor = async (request, step, runnerState) => {
    const job = state.jobs.find((candidate) => candidate.email === runnerState.email);
    if (job?.proxy) proxyByRoot.set(job.parentEmail, job.proxy.id);
    return runner.executor(request, step, runnerState);
  };

  await runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider,
    proxyEntries: proxies,
    proxyProbeExecutor: successfulProxyProbe(1),
    executor,
    tokenExecutor: jobTokenExecutor,
    random: () => 0.999,
  });

  assert.equal(state.status, 'complete');
  assert.equal(proxyByRoot.size, 2);
  assert.equal(new Set(proxyByRoot.values()).size, 2);
  assert.ok(runner.stats.maxActive >= 2);
  assert.deepEqual(state.proxyLeases, {});
  assert.equal(Object.values(state.proxyHealth).every((record) => record.status === 'healthy'), true);
});

test('aliases from one root remain serial and re-probe the retained proxy at the alias boundary', async () => {
  const { har } = loadHar();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-proxy-boundary-'));
  const accounts = [{ id: 43, email: 'serial@example.test', tokenValid: true, bound: false }];
  const config = configureRequiredProxies(configFor(tempDir, accounts, 2));
  const mailClient = new MockMailboxClient(accounts);
  const smsProvider = new MockSmsProvider({
    numbers: ['+56970000001', '+56970000002'],
    codes: ['100001', '100002'],
  });
  const proxies = localProxyEntries(1);
  const runner = mockRunner(har, mailClient, { delayMs: 1 });
  const state = makeInitialOrchestratorV2State(config, { runId: 'run-v2-proxy-boundary' });
  const boundarySnapshots = [];
  let active = 0;
  let maxActive = 0;
  const executor = async (request, step, runnerState) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      return await runner.executor(request, step, runnerState);
    } finally {
      active -= 1;
    }
  };
  const proxyProbeExecutor = async (request) => {
    boundarySnapshots.push(state.jobs.filter((job) => job.status === 'complete').length);
    return { response: { status: 204, url: request.url, text: '' } };
  };

  await runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider,
    proxyEntries: proxies,
    proxyProbeExecutor,
    executor,
    tokenExecutor: jobTokenExecutor,
    random: () => 0.999,
  });

  assert.equal(state.jobs.length, 2);
  assert.equal(state.jobs.every((job) => job.status === 'complete'), true);
  assert.equal(new Set(state.jobs.map((job) => job.proxy.id)).size, 1);
  assert.equal(maxActive, 1);
  assert.deepEqual(boundarySnapshots, [0, 1]);
});

test('a failed boundary probe is permanently excluded and replaced by the next candidate', async () => {
  const { har } = loadHar();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-proxy-probe-fail-'));
  const accounts = [{ id: 44, email: 'probe@example.test', tokenValid: true, bound: false }];
  const config = configureRequiredProxies(configFor(tempDir, accounts, 2));
  const mailClient = new MockMailboxClient(accounts);
  const smsProvider = new MockSmsProvider({
    numbers: ['+56970000001', '+56970000002'],
    codes: ['100001', '100002'],
  });
  const proxies = localProxyEntries(2);
  const runner = mockRunner(har, mailClient);
  const state = makeInitialOrchestratorV2State(config, { runId: 'run-v2-proxy-probe-fail' });
  const calls = new Map();
  const proxyProbeExecutor = async (request, context) => {
    calls.set(context.proxy, Number(calls.get(context.proxy) || 0) + 1);
    if (context.proxy === proxies[0].url) throw new Error('proxy health probe failed');
    return { response: { status: 204, url: request.url, text: '' } };
  };

  await runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider,
    proxyEntries: proxies,
    proxyProbeExecutor,
    executor: runner.executor,
    tokenExecutor: jobTokenExecutor,
    random: () => 0.999,
  });

  assert.equal(state.status, 'complete');
  assert.equal(calls.get(proxies[0].url), 1);
  assert.equal(state.proxyHealth[proxies[0].id].status, 'failed');
  assert.equal(state.jobs.every((job) => job.proxy.id === proxies[1].id), true);
  assert.equal(state.events.filter((event) => event.type === 'proxy_health_failed').length, 1);
});

test('a transient runtime proxy-like error keeps the proxy when its recheck succeeds', async () => {
  const { har } = loadHar();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-proxy-transient-'));
  const accounts = [{ id: 45, email: 'transient@example.test', tokenValid: true, bound: false }];
  const config = configureRequiredProxies(configFor(tempDir, accounts));
  config.mail.timeoutMs = 10000;
  const mailClient = new MockMailboxClient(accounts);
  const originalFind = mailClient.findVerificationCode.bind(mailClient);
  let failedOnce = false;
  mailClient.findVerificationCode = async (...args) => {
    if (!failedOnce) {
      failedOnce = true;
      const error = new Error('proxy ECONNRESET while reading mail');
      error.code = 'ECONNRESET';
      throw error;
    }
    return originalFind(...args);
  };
  const smsProvider = new MockSmsProvider({ numbers: ['+56970000001'], codes: ['100001'] });
  const proxies = localProxyEntries(2);
  const runner = mockRunner(har, mailClient);
  const state = makeInitialOrchestratorV2State(config, { runId: 'run-v2-proxy-transient' });
  const clock = fakeClock();
  let probeCalls = 0;

  await runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider,
    proxyEntries: proxies,
    proxyProbeExecutor: async (request) => {
      probeCalls += 1;
      return { response: { status: 204, url: request.url, text: '' } };
    },
    executor: runner.executor,
    tokenExecutor: jobTokenExecutor,
    random: () => 0.999,
    ...clock,
  });

  assert.equal(
    state.status,
    'complete',
    `job stopped at ${state.jobs[0]?.status}/${state.jobs[0]?.phase}: ${state.jobs[0]?.error?.code || 'no-error'}`,
  );
  assert.equal(state.jobs.length, 1);
  assert.equal(state.jobs[0].attempts.transient, 1);
  assert.equal(state.jobs[0].proxy.id, proxies[0].id);
  assert.equal(state.proxyHealth[proxies[0].id].status, 'healthy');
  assert.equal(state.events.some((event) => event.type === 'proxy_runtime_recheck_passed'), true);
  assert.equal(probeCalls, 2);
});

test('a TLS reset while requesting Sentinel proof rebuilds the intent and retries safely', async () => {
  const { har } = loadHar();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-sentinel-transient-'));
  const accounts = [{ id: 450, email: 'sentinel-retry@example.test', tokenValid: true, bound: false }];
  const config = configureRequiredProxies(configFor(tempDir, accounts));
  const mailClient = new MockMailboxClient(accounts);
  const smsProvider = new MockSmsProvider({ numbers: ['+56970000001'], codes: ['100001'] });
  const proxies = localProxyEntries(1);
  const runner = mockRunner(har, mailClient, { registrationWorkspaceSuccess: true });
  const state = makeInitialOrchestratorV2State(config, { runId: 'run-v2-sentinel-transient' });
  const clock = fakeClock();
  let sentinelAttempts = 0;
  const executor = async (request, step, runnerState) => {
    if (step.name === 'sentinel_oauth_create_account') {
      sentinelAttempts += 1;
      if (sentinelAttempts === 1) {
        const error = new Error('Client network socket disconnected before secure TLS connection was established');
        error.code = 'ECONNRESET';
        throw error;
      }
    }
    return runner.executor(request, step, runnerState);
  };

  await runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider,
    proxyEntries: proxies,
    proxyProbeExecutor: async (request) => ({ response: { status: 204, url: request.url, text: '' } }),
    executor,
    tokenExecutor: jobTokenExecutor,
    random: () => 0.999,
    ...clock,
  });

  assert.equal(state.status, 'complete');
  assert.equal(sentinelAttempts, 2);
  assert.equal(state.jobs[0].attempts.transient, 1);
  assert.equal(state.jobs[0].runner.inFlight, null);
  assert.equal(state.events.some((event) => event.type === 'sentinel_transient_retry_scheduled'), true);
  assert.equal(state.events.some((event) => event.type === 'ambiguous_effect'), false);
});

test('confirmed pre-create proxy failures replace aliases only up to maxAttempts', async () => {
  const { har } = loadHar();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-proxy-pre-create-'));
  const accounts = [{ id: 46, email: 'replace@example.test', tokenValid: true, bound: false }];
  const config = configureRequiredProxies(configFor(tempDir, accounts));
  config.aliases.maxAttempts = 3;
  const mailClient = new MockMailboxClient(accounts);
  const smsProvider = new MockSmsProvider();
  const proxies = localProxyEntries(3);
  const runner = mockRunner(har, mailClient);
  const state = makeInitialOrchestratorV2State(config, { runId: 'run-v2-proxy-pre-create' });
  const failedAliases = new Set();
  const probeCounts = new Map();
  const executor = async (request, step, runnerState) => {
    if (step.name === 'authorize_continue' && !failedAliases.has(runnerState.email)) {
      failedAliases.add(runnerState.email);
      throw new Error('proxy ECONNRESET before account creation');
    }
    return runner.executor(request, step, runnerState);
  };
  const proxyProbeExecutor = async (request, context) => {
    const count = Number(probeCounts.get(context.proxy) || 0) + 1;
    probeCounts.set(context.proxy, count);
    if (count > 1) throw new Error('confirmed proxy probe failure');
    return { response: { status: 204, url: request.url, text: '' } };
  };

  await runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider,
    proxyEntries: proxies,
    proxyProbeExecutor,
    executor,
    tokenExecutor: jobTokenExecutor,
    random: () => 0.999,
  });

  assert.equal(state.jobs.length, 3);
  assert.equal(state.jobs.every((job) => job.status === 'failed_proxy'), true);
  assert.equal(state.jobs.every((job) => !job.accountCreatedAt), true);
  assert.equal(state.jobs[1].replacementOf, state.jobs[0].id);
  assert.equal(state.jobs[2].replacementOf, state.jobs[1].id);
  assert.equal(state.mailboxes[0].attemptCount, 3);
  assert.equal(state.jobs[2].replacementJobId, '');
  assert.equal(Object.values(state.proxyHealth).every((record) => record.status === 'failed'), true);
});

test('confirmed post-create proxy failure queues finalization without replacing the alias', async () => {
  const { har } = loadHar();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-proxy-post-create-'));
  const accounts = [{ id: 47, email: 'finalize@example.test', tokenValid: true, bound: false }];
  const config = configureRequiredProxies(configFor(tempDir, accounts));
  const mailClient = new MockMailboxClient(accounts);
  const smsProvider = new MockSmsProvider({ numbers: ['+56970000001'], codes: ['100001'] });
  const proxies = localProxyEntries(2);
  const runner = mockRunner(har, mailClient);
  const state = makeInitialOrchestratorV2State(config, { runId: 'run-v2-proxy-post-create' });
  let failedAfterCreate = false;
  let probeCalls = 0;
  const executor = async (request, step, runnerState) => {
    if (runnerState.mode === 'pure-url-registration-runner' && step.name === 'consent_data' && !failedAfterCreate) {
      failedAfterCreate = true;
      throw new Error('proxy ECONNRESET after account creation');
    }
    return runner.executor(request, step, runnerState);
  };
  const stop = new Error('stop after finalization is queued');

  await assert.rejects(
    runOrchestratorV2(har, state, config, {
      mailClient,
      smsProvider,
      proxyEntries: proxies,
      proxyProbeExecutor: async (request) => {
        probeCalls += 1;
        if (probeCalls > 1) throw new Error('confirmed proxy probe failure');
        return { response: { status: 204, url: request.url, text: '' } };
      },
      executor,
      tokenExecutor: jobTokenExecutor,
      random: () => 0.999,
      saveState: async (next) => {
        if (next.lastCheckpoint?.reason === 'finalization_queued') throw stop;
      },
    }),
    stop,
  );

  const [job] = state.jobs;
  assert.equal(state.jobs.length, 1);
  assert.equal(job.status, 'pending_finalize');
  assert.equal(job.phase, 'pending_finalize');
  assert.ok(job.accountCreatedAt);
  assert.equal(job.sms.current.status, 'complete');
  assert.equal(job.replacementJobId, undefined);
  assert.deepEqual(state.finalizationQueue, [job.id]);
});

test('finalizers run FIFO after normal workers and retry transient token failures in isolation', async () => {
  const { har } = loadHar();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-proxy-finalizers-'));
  const accounts = [
    { id: 48, email: 'first@example.test', tokenValid: true, bound: false },
    { id: 49, email: 'second@example.test', tokenValid: true, bound: false },
  ];
  const config = configureRequiredProxies(configFor(tempDir, accounts));
  const mailClient = new MockMailboxClient(accounts);
  const smsProvider = new MockSmsProvider({
    numbers: ['+56970000001', '+56970000002'],
    codes: ['100001', '100002'],
  });
  const proxies = localProxyEntries(4);
  const runner = mockRunner(har, mailClient);
  const state = makeInitialOrchestratorV2State(config, { runId: 'run-v2-proxy-finalizers' });
  const postCreateFailures = new Set();
  const probeCounts = new Map();
  const tokenCalls = [];
  let firstTokenFailed = false;
  let activeFinalizers = 0;
  let maxActiveFinalizers = 0;
  const executor = async (request, step, runnerState) => {
    const finalizing = runnerState.mode === 'pure-url-oauth-login-runner';
    if (finalizing) {
      activeFinalizers += 1;
      maxActiveFinalizers = Math.max(maxActiveFinalizers, activeFinalizers);
    }
    try {
      if (
        runnerState.mode === 'pure-url-registration-runner'
        && step.name === 'consent_data'
        && !postCreateFailures.has(runnerState.email)
      ) {
        postCreateFailures.add(runnerState.email);
        throw new Error('proxy ECONNRESET after account creation');
      }
      return await runner.executor(request, step, runnerState);
    } finally {
      if (finalizing) activeFinalizers -= 1;
    }
  };
  const proxyProbeExecutor = async (request, context) => {
    const count = Number(probeCounts.get(context.proxy) || 0) + 1;
    probeCounts.set(context.proxy, count);
    if ([proxies[0].url, proxies[1].url].includes(context.proxy) && count > 1) {
      throw new Error('confirmed proxy probe failure');
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
    return { response: { status: 204, url: request.url, text: '' } };
  };
  const tokenExecutorWithRetry = async (request, job) => {
    tokenCalls.push(job.id);
    if (!firstTokenFailed) {
      firstTokenFailed = true;
      throw new Error('temporary token endpoint failure');
    }
    return jobTokenExecutor(request, job);
  };

  await runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider,
    proxyEntries: proxies,
    proxyProbeExecutor,
    executor,
    tokenExecutor: tokenExecutorWithRetry,
    random: () => 0.999,
  });

  const queue = state.finalizationQueue;
  const starts = state.events.filter((event) => event.type === 'finalization_attempt_started');
  const normalDoneIndex = state.events.findIndex((event) => event.type === 'normal_phase_complete');
  const firstFinalizerIndex = state.events.findIndex((event) => event.type === 'finalization_attempt_started');
  assert.equal(
    state.status,
    'complete',
    `finalizers stopped as ${state.jobs.map((job) => `${job.status}/${job.phase}/${job.finalization?.status || 'none'}/${job.error?.code || 'no-error'}/${job.runner?.inFlight?.step || 'no-flight'}`).join(',')}; tokens=${tokenCalls.join(',')}`,
  );
  assert.equal(state.jobs.length, 2);
  assert.equal(state.jobs.every((job) => job.status === 'complete'), true);
  assert.deepEqual(tokenCalls, [queue[0], queue[0], queue[1]]);
  assert.deepEqual(starts.map((event) => event.jobId), [queue[0], queue[0], queue[1]]);
  assert.equal(state.jobs.find((job) => job.id === queue[0]).finalization.attempts, 2);
  assert.equal(state.jobs.find((job) => job.id === queue[1]).finalization.attempts, 1);
  assert.ok(normalDoneIndex >= 0 && firstFinalizerIndex > normalDoneIndex);
  assert.equal(maxActiveFinalizers, 1);
  assert.deepEqual(state.proxyLeases, {});
});

test('restart recovers orphaned checking and unowned leased proxy health states', async () => {
  const { har } = loadHar();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-proxy-recovery-'));
  const accounts = [{ id: 50, email: 'recovery@example.test', tokenValid: true, bound: false }];
  const config = configureRequiredProxies(configFor(tempDir, accounts));
  const mailClient = new MockMailboxClient(accounts);
  const smsProvider = new MockSmsProvider({ numbers: ['+56970000001'], codes: ['100001'] });
  const proxies = localProxyEntries(2);
  const runner = mockRunner(har, mailClient);
  const clock = fakeClock();
  const state = makeInitialOrchestratorV2State(config, { runId: 'run-v2-proxy-recovery', now: clock.now });
  state.proxyHealth = {
    [proxies[0].id]: {
      id: proxies[0].id,
      status: 'checking',
      checkingBy: 'probe:interrupted-run',
      checkingAt: '2026-07-27T23:59:00.000Z',
    },
    [proxies[1].id]: {
      id: proxies[1].id,
      status: 'leased',
      leasedTo: 'mailbox:missing-owner',
      leasedAt: '2026-07-27T23:59:00.000Z',
    },
  };
  state.proxyLeases = {};

  await runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider,
    proxyEntries: proxies,
    proxyProbeExecutor: successfulProxyProbe(),
    executor: runner.executor,
    tokenExecutor: jobTokenExecutor,
    random: () => 0.999,
    ...clock,
  });

  assert.equal(
    state.status,
    'complete',
    `stale health remained ${Object.values(state.proxyHealth).map((record) => record.status).join(',')}`,
  );
  const recoveredStatuses = Object.values(state.proxyHealth).map((record) => record.status);
  assert.equal(recoveredStatuses.includes('checking'), false);
  assert.equal(recoveredStatuses.includes('leased'), false);
  assert.equal(recoveredStatuses.includes('healthy'), true);
  assert.deepEqual(state.proxyLeases, {});
});

test('pre-create proxy aborts drain ambiguous email, cancel SMS, and still satisfy the account target', async () => {
  const { har } = loadHar();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-v2-proxy-cleanup-'));
  const accounts = [{ id: 51, email: 'cleanup@example.test', tokenValid: true, bound: false }];
  const config = configureRequiredProxies(configFor(tempDir, accounts));
  config.aliases.maxAttempts = 3;
  const mailClient = new MockMailboxClient(accounts);
  const smsProvider = new MockSmsProvider({
    numbers: ['+56970000001', '+56970000002'],
    codes: ['100001'],
  });
  const proxies = localProxyEntries(3);
  const runner = mockRunner(har, mailClient, { registrationWorkspaceSuccess: true });
  const state = makeInitialOrchestratorV2State(config, { runId: 'run-v2-proxy-cleanup' });
  const injected = new Set();
  const aliasOrdinals = new Map();
  const probeCounts = new Map();
  const executor = async (request, step, runnerState) => {
    const result = await runner.executor(request, step, runnerState);
    if (!aliasOrdinals.has(runnerState.email)) aliasOrdinals.set(runnerState.email, aliasOrdinals.size + 1);
    const ordinal = aliasOrdinals.get(runnerState.email);
    const failureStep = ordinal === 1
      ? 'email_otp_send'
      : (ordinal === 2 ? 'phone_otp_send' : '');
    const key = `${runnerState.email}:${step.name}`;
    if (step.name === failureStep && !injected.has(key)) {
      injected.add(key);
      throw new Error(`proxy ECONNRESET after ambiguous ${step.name}`);
    }
    return result;
  };
  const proxyProbeExecutor = async (request, context) => {
    const count = Number(probeCounts.get(context.proxy) || 0) + 1;
    probeCounts.set(context.proxy, count);
    if ([proxies[0].url, proxies[1].url].includes(context.proxy) && count > 1) {
      throw new Error('confirmed proxy probe failure');
    }
    return { response: { status: 204, url: request.url, text: '' } };
  };

  await runOrchestratorV2(har, state, config, {
    mailClient,
    smsProvider,
    proxyEntries: proxies,
    proxyProbeExecutor,
    executor,
    tokenExecutor: jobTokenExecutor,
    random: () => 0.999,
  });

  assert.equal(state.status, 'complete');
  assert.deepEqual(state.jobs.map((job) => job.status), ['failed_proxy', 'failed_proxy', 'complete']);
  assert.equal(state.jobs[0].emailActivity.status, 'drained');
  assert.equal(state.jobs[0].emailActivity.consumedMessageId, 'new-message');
  assert.equal(state.jobs[1].sms.current, null);
  assert.equal(state.jobs[1].sms.attempts[0].status, 'cancelled');
  assert.equal(state.jobs[1].replacementJobId, state.jobs[2].id);
  assert.equal(state.mailboxes[0].attemptCount, 3);
  assert.equal(state.mailboxes[0].createdCount, 1);
  assert.equal(state.mailboxes[0].cpaCompletedCount, 1);
});
