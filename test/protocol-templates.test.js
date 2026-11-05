'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { findDefaultHar } = require('../src/har');
const { LOGIN_STEPS, RUN_STEPS, makeInitialRegistrationState, stepRequest } = require('../src/registration-runner');
const { REGISTRATION_STEP_PATHS } = require('../src/registration-flow');
const { TEMPLATES } = require('../src/protocol-templates');
const { validateV2Config } = require('../src/config-v2');
const { ConfigService } = require('../src/ui-server/config-service');
const { RunManager } = require('../src/ui-server/run-manager');

function baseConfig(registration = {}) {
  return {
    schemaVersion: 2,
    mail: { provider: 'xiaopingguo', baseUrl: 'http://127.0.0.1:8000', password: 'mail-secret', count: 1 },
    aliases: { strategy: 'plus', count: 1, maxAttempts: 2, runTag: 'proto', plusAddressingEnabled: true },
    sms: { provider: 'mock', apiKey: 'sms-secret', maxPrice: 0, service: { code: 'mock' }, country: { id: 151 }, replacementBudget: 2 },
    workers: { maxConcurrency: 1 },
    registration: { exchangeToken: true, dynamicSentinel: true, ...registration },
    proxyPool: { path: 'proxy-pool.txt', defaultProtocol: 'http', required: false, healthCheck: { enabled: false } },
    output: { stateDir: '.state', cpaDir: '.state/output' },
  };
}

function workspace(registration = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-protocol-'));
  fs.writeFileSync(path.join(cwd, 'gpt-re.config.json'), `${JSON.stringify(baseConfig(registration), null, 2)}\n`);
  fs.writeFileSync(path.join(cwd, 'proxy-pool.txt'), '# empty\n');
  return cwd;
}

function manager(cwd, harPath = '') {
  return new RunManager({ cwd, configService: new ConfigService({ cwd }), logStore: { append() {} }, harPath });
}

test('registration templates default to the ones declared in code', () => {
  assert.equal(validateV2Config(baseConfig()).registration.protocolTemplates, 'live');
  assert.equal(validateV2Config(baseConfig({ protocolTemplates: 'capture' })).registration.protocolTemplates, 'capture');
  // Anything else is a typo, and a typo must not silently put a run back on a
  // stale recording.
  assert.equal(validateV2Config(baseConfig({ protocolTemplates: 'HAR' })).registration.protocolTemplates, 'live');
});

test('a branch run needs no capture, even in a workspace where one cannot be resolved', () => {
  const cwd = workspace();
  // Two registration baselines: the exact shape that makes findDefaultHar give
  // up. A run used to die on this before its first job, on a file it never
  // needed.
  for (const name of ['localhost_Archive-july.har', 'localhost_Archive-september.har']) {
    fs.writeFileSync(path.join(cwd, name), '{"log":{"entries":[]}}');
  }
  assert.throws(() => findDefaultHar(cwd), /Multiple \.har files/);

  const config = validateV2Config(baseConfig());
  const capture = manager(cwd).protocolCapture({ taskKind: 'register_session' }, config);
  assert.deepEqual(capture, { log: { entries: [] } });
  assert.equal(Object.isFrozen(capture), true);
});

test('asking for capture templates still opens the recording', () => {
  const cwd = workspace({ protocolTemplates: 'capture' });
  const harPath = path.join(cwd, 'pinned.har');
  fs.writeFileSync(harPath, JSON.stringify({ log: { entries: [{ request: { url: 'https://auth.openai.com/log-in', method: 'GET', headers: [] } }] } }));

  const config = validateV2Config(baseConfig({ protocolTemplates: 'capture' }));
  const capture = manager(cwd, harPath).protocolCapture({ taskKind: 'register_session' }, config);
  assert.equal(capture.log.entries.length, 1);
  assert.equal(capture.log.entries[0].request.url, 'https://auth.openai.com/log-in');
});

test('no scheduler needs a capture, whatever kind of task it is running', () => {
  const cwd = workspace();
  const harPath = path.join(cwd, 'pinned.har');
  fs.writeFileSync(harPath, JSON.stringify({ log: { entries: [{ request: { url: 'https://auth.openai.com/log-in', method: 'GET', headers: [] } }] } }));

  const config = validateV2Config(baseConfig());
  for (const taskKind of ['register_session', 'register_oauth', 'oauth', 'session_refresh', 'orchestrator_v2']) {
    assert.deepEqual(manager(cwd, harPath).protocolCapture({ taskKind }, config), { log: { entries: [] } }, taskKind);
  }
});

const EMPTY_CAPTURE = { log: { entries: [] } };

function readyState() {
  const state = makeInitialRegistrationState(EMPTY_CAPTURE, { email: 'probe@example.test', password: 'Pw-123456!' });
  state.oauth = { ...(state.oauth || {}), authorizeUrl: 'https://auth.openai.com/oauth/authorize?client_id=app&state=abc' };
  state.lastLocation = 'https://auth.openai.com/api/accounts/login?login_challenge=abc';
  state.lastContinueUrl = 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent';
  state.inputs = { emailCode: '123456', phone: '+15550000000', phoneCode: '654321', workspaceId: 'workspace-1' };
  state.workspaceId = 'workspace-1';
  const minted = { 'openai-sentinel-token': '{}' };
  state.sentinelHeaders = {
    authorize_continue: minted,
    username_password_create: minted,
    oauth_create_account: minted,
    email_otp_validate: minted,
    password_verify: minted,
  };
  return state;
}

test('every step of both flows builds without a capture', () => {
  // The whole point of the templates: a workspace with no `.har` in it at all
  // still produces every request, including the two the login flow used to
  // borrow from the registration entries.
  const state = readyState();
  const built = [];
  for (const steps of [RUN_STEPS, LOGIN_STEPS]) {
    for (const step of steps) {
      if (step.type === 'cloudflareJsd') continue;
      const request = stepRequest(EMPTY_CAPTURE, step, state, {});
      assert.ok(request.url, `${step.name} produced no URL`);
      assert.ok(request.method, `${step.name} produced no method`);
      assert.equal(typeof request.headers['User-Agent'], 'string', `${step.name} sent no user agent`);
      built.push(`${step.name} ${request.method}`);
    }
  }
  assert.equal(built.length, 35);
});

test('a template carries the page it is sent from, not the page a recording happened to be on', () => {
  const state = readyState();
  const register = stepRequest(EMPTY_CAPTURE, RUN_STEPS.find((step) => step.name === 'user_register'), state, {});
  assert.equal(register.url, 'https://auth.openai.com/api/accounts/user/register');
  assert.equal(register.headers.Referer, 'https://auth.openai.com/create-account/password');
  assert.equal(register.headers['Sec-Fetch-Site'], 'same-origin');

  // The login password verify used to borrow the register entry's block and
  // then overwrite four fields, leaving it claiming a page it never came from.
  const verify = stepRequest(EMPTY_CAPTURE, LOGIN_STEPS.find((step) => step.name === 'password_verify'), state, {});
  assert.equal(verify.url, 'https://auth.openai.com/api/accounts/password/verify');
  assert.equal(verify.headers.Referer, 'https://auth.openai.com/log-in/password');
});

test('no template replays a recorded session’s own identity', () => {
  // A capture carries the trace ids and invocation id of the session it
  // recorded. Replaying those sent every account the same ones.
  const state = readyState();
  for (const steps of [RUN_STEPS, LOGIN_STEPS]) {
    for (const step of steps) {
      if (step.type === 'cloudflareJsd') continue;
      const names = Object.keys(stepRequest(EMPTY_CAPTURE, step, state, {}).headers).map((name) => name.toLowerCase());
      for (const leaked of ['traceparent', 'tracestate', 'x-datadog-trace-id', 'x-datadog-parent-id', 'x-access-flow-invocation-id']) {
        assert.equal(names.includes(leaked), false, `${step.name} still replays ${leaked}`);
      }
      // …nor the cache headers that only appear because the capture was taken
      // with devtools open.
      assert.equal(names.includes('pragma'), false, `${step.name} still sends Pragma`);
    }
  }
});

test('the declared templates agree with the endpoints the plan says it drives', () => {
  for (const path of REGISTRATION_STEP_PATHS) {
    const matching = Object.values(TEMPLATES).filter((template) => template.path === path);
    assert.ok(matching.length > 0, `no template drives ${path}`);
  }
});
