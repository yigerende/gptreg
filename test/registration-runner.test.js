'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { getHeader, loadHar } = require('../src/har');
const {
  LOGIN_STEPS,
  RUN_STEPS,
  STEP_PLAN_VERSION,
  migrateRegistrationState,
  makeInitialLoginState,
  makeInitialRegistrationState,
  makeSentinelConsumerHeaders,
  rebindSentinelProxy,
  runLoginFlow,
  runRegistrationFlow,
  summarizeRegistrationState,
} = require('../src/registration-runner');

test('binds dynamic create_account Sentinel and SO headers to one Firefox identity', async () => {
  const { har } = loadHar();
  const state = makeInitialRegistrationState(har, { email: 'profile@example.test' });
  state.next = RUN_STEPS.findIndex((step) => step.name === 'sentinel_oauth_create_account');
  state.cookies = { 'oai-did': 'firefox-did' };
  state.lastContinueUrl = 'https://auth.openai.com/about-you';
  const challenge = {
    token: 'challenge-current',
    proofofwork: { required: true },
    turnstile: { required: true },
    so: { required: true },
  };
  const mainToken = JSON.stringify({
    p: 'pow',
    t: 'turnstile',
    c: challenge.token,
    id: 'firefox-did',
    flow: 'oauth_create_account',
  });
  const soToken = JSON.stringify({
    so: 'observer',
    c: challenge.token,
    id: 'firefox-did',
    flow: 'oauth_create_account',
  });
  const runtimeCalls = [];
  const sentinelRuntime = {
    async getRequirementsToken(flow) {
      runtimeCalls.push(['requirements', flow]);
      return 'requirements-proof';
    },
    async getChallengeTokens(flow, response, proof, options) {
      runtimeCalls.push(['tokens', flow, response.token, proof, options.id]);
      return { token: mainToken, soToken };
    },
  };
  let executedRequest;

  await runRegistrationFlow(har, state, {
    once: true,
    proxy: 'http://proxy.example.test:8080',
    sentinelRuntime,
    executor: async (request) => {
      executedRequest = request;
      return {
        request,
        response: {
          status: 200,
          url: request.url,
          location: '',
          contentType: 'application/json',
          text: JSON.stringify(challenge),
        },
        cookies: { ...state.cookies, 'oai-sc': `0${challenge.token}` },
      };
    },
  });

  assert.equal(JSON.parse(executedRequest.body).p, 'requirements-proof');
  assert.match(executedRequest.headers['User-Agent'], /Firefox\/153\.0/);
  assert.equal(state.sentinelHeaders.oauth_create_account['openai-sentinel-token'], mainToken);
  assert.equal(state.sentinelHeaders.oauth_create_account['openai-sentinel-so-token'], soToken);
  assert.equal(state.cookies['oai-sc'], `0${challenge.token}`);
  assert.deepEqual(runtimeCalls, [
    ['requirements', 'oauth_create_account'],
    ['tokens', 'oauth_create_account', challenge.token, 'requirements-proof', 'firefox-did'],
  ]);
  assert.equal(state.clientIdentity.did, 'firefox-did');
});

test('Sentinel dry-run builds its proof locally without fetching the live SDK', async () => {
  const { har } = loadHar();
  const state = makeInitialRegistrationState(har, { email: 'dry-sentinel@example.test' });
  state.next = RUN_STEPS.findIndex((step) => step.name === 'sentinel_oauth_create_account');
  state.cookies = { 'oai-did': 'dry-did' };
  let calls = 0;

  await runRegistrationFlow(har, state, {
    dryRun: true,
    proxy: 'http://proxy.example.test:8080',
    executor: async () => {
      calls += 1;
      throw new Error('dry-run executor must not be called');
    },
  });

  const descriptor = new URL(state.blocked.pureUrl);
  const request = JSON.parse(Buffer.from(descriptor.searchParams.get('r'), 'base64url').toString('utf8'));
  assert.equal(calls, 0);
  assert.match(JSON.parse(request.body).p, /^gAAAAAC/);
  assert.equal(state.sentinelSdk.origin, 'har');
});

test('rejects a proxy or device change after the Firefox Sentinel identity is locked', async () => {
  const { har } = loadHar();
  const state = makeInitialRegistrationState(har, { email: 'continuity@example.test' });
  const sentinelIndex = RUN_STEPS.findIndex((step) => step.name === 'sentinel_oauth_create_account');
  state.next = sentinelIndex;
  state.cookies = { 'oai-did': 'continuity-did' };

  await runRegistrationFlow(har, state, { dryRun: true, proxy: 'http://proxy-a.example.test:8080' });
  state.next = sentinelIndex;
  state.blocked = null;

  await assert.rejects(
    runRegistrationFlow(har, state, { dryRun: true, proxy: 'http://proxy-b.example.test:8080' }),
    /identity changed.*proxy/,
  );
  state.cookies['oai-did'] = 'another-did';
  await assert.rejects(
    runRegistrationFlow(har, state, { dryRun: true, proxy: 'http://proxy-a.example.test:8080' }),
    /identity changed.*did/,
  );
});

test('security recovery can explicitly rebind only the Sentinel proxy and clears stale proofs', () => {
  const { har } = loadHar();
  const state = makeInitialRegistrationState(har, { email: 'rebind@example.test' });
  state.cookies = { 'oai-did': 'rebind-did' };
  state.clientIdentity = {
    profile: state.clientProfileFingerprint,
    did: 'rebind-did',
    proxy: require('node:crypto').createHash('sha256').update('http://proxy-a.example.test:8080').digest('hex'),
  };
  state.sentinelHeaders = { stale: { 'openai-sentinel-token': 'old' } };
  state.sentinelRequestProofs = { stale: 'old-proof' };

  const result = rebindSentinelProxy(state, 'http://proxy-b.example.test:8080');

  assert.equal(result.changed, true);
  assert.equal(state.clientIdentity.did, 'rebind-did');
  assert.notEqual(state.clientIdentity.proxy, result.previous.proxy);
  assert.deepEqual(state.sentinelHeaders, {});
  assert.deepEqual(state.sentinelRequestProofs, {});
});

test('derives Sentinel consumer headers from a pure URL Sentinel response', () => {
  const { har } = loadHar();
  const response = JSON.parse(har.log.entries[142].response.content.text);
  const headers = makeSentinelConsumerHeaders(har, 146, response, {
    id: 'fresh-did',
  });
  const tokenEnvelope = JSON.parse(headers['openai-sentinel-token']);

  assert.equal(tokenEnvelope.c, response.token);
  assert.equal(tokenEnvelope.id, 'fresh-did');
  assert.equal(tokenEnvelope.flow, 'username_password_create');
  assert.ok(tokenEnvelope.p);
  assert.ok(tokenEnvelope.t);
});

test('registration runner emits pure URL dry-run state without executing network', async () => {
  const { har } = loadHar();
  const state = makeInitialRegistrationState(har, {
    email: 'user1@example.com',
  });

  await runRegistrationFlow(har, state, { dryRun: true });
  const summary = summarizeRegistrationState(state, { redact: false });

  assert.equal(summary.nextStep, 'bootstrap_oauth_authorize');
  assert.deepEqual(summary.blocked.missing, ['dry_run']);
  assert.match(summary.blocked.pureUrl, /^gpt-re\+http:\/\/request\/0\?/);
});

test('registration runner stops at email OTP when executor reaches that boundary', async () => {
  const { har } = loadHar();
  const state = makeInitialRegistrationState(har, {
    email: 'user1@example.com',
  });

  await runRegistrationFlow(har, state, {
    dynamicSentinel: false,
    executor: async (request, step) => {
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

      return {
        request,
        response: {
          status: step.name === 'email_otp_send' ? 302 : (har.log.entries[step.index]?.response.status || 200),
          url: request.url,
          location: step.name === 'email_otp_send'
            ? 'https://auth.openai.com/email-verification'
            : getHeader(har.log.entries[step.index]?.response.headers || [], 'location'),
          contentType: 'application/json',
          text: step.name === 'bootstrap_log_in_page'
            ? "window.__CF$cv$params={r:'test-ray',t:'test-time'};"
            : '{}',
        },
        cookies: { ...state.cookies, 'oai-did': 'fresh-did' },
      };
    },
  });

  // The boundary is the Sentinel step, not the validate itself: its challenge
  // expires in 540s, so it is minted after the code arrives, not before.
  assert.equal(state.next, RUN_STEPS.findIndex((step) => step.name === 'sentinel_email_otp_validate'));
  assert.equal(summarizeRegistrationState(state).blocked.step, 'sentinel_email_otp_validate');
  assert.deepEqual(summarizeRegistrationState(state).blocked.missing, ['emailCode']);
  assert.ok(state.sentinelHeaders.authorize_continue);
  assert.ok(state.sentinelHeaders.username_password_create);
});

test('email OTP validation sends the Sentinel and SO headers minted for its own flow', async () => {
  const { har } = loadHar();
  const state = makeInitialRegistrationState(har, { email: 'otp@example.test' });
  state.next = RUN_STEPS.findIndex((step) => step.name === 'sentinel_email_otp_validate');
  state.cookies = { 'oai-did': 'otp-did' };
  state.inputs.emailCode = '441846';
  state.lastLocation = 'https://auth.openai.com/email-verification';

  const challenge = {
    token: 'challenge-email-otp',
    proofofwork: { required: true },
    turnstile: { required: true },
    so: { required: true },
  };
  const mainToken = JSON.stringify({
    p: 'pow', t: 'turnstile', c: challenge.token, id: 'otp-did', flow: 'email_otp_validate',
  });
  const soToken = JSON.stringify({
    so: 'observer', c: challenge.token, id: 'otp-did', flow: 'email_otp_validate',
  });
  const flows = [];
  const sentinelRuntime = {
    async getRequirementsToken(flow) {
      flows.push(['requirements', flow]);
      return 'otp-requirements-proof';
    },
    async getChallengeTokens(flow, response, proof, options) {
      flows.push(['tokens', flow, response.token, proof, options.id]);
      return { token: mainToken, soToken };
    },
  };
  const sent = {};

  await runRegistrationFlow(har, state, {
    sentinelRuntime,
    executor: async (request, step) => {
      sent[step.name] = request;
      return {
        request,
        response: {
          status: 200,
          url: request.url,
          location: '',
          contentType: 'application/json',
          text: step.type === 'sentinel'
            ? JSON.stringify(challenge)
            : JSON.stringify({ continue_url: 'https://auth.openai.com/add-phone' }),
        },
        cookies: { ...state.cookies },
      };
    },
  });

  // The Sentinel step ran, and the validate carried what it minted.
  assert.equal(JSON.parse(sent.sentinel_email_otp_validate.body).flow, 'email_otp_validate');
  assert.equal(JSON.parse(sent.sentinel_email_otp_validate.body).p, 'otp-requirements-proof');

  const headers = sent.email_otp_validate.headers;
  assert.equal(headers['openai-sentinel-token'], mainToken);
  assert.equal(headers['openai-sentinel-so-token'], soToken);
  assert.equal(JSON.parse(sent.email_otp_validate.body).code, '441846');

  // Both envelopes stay bound to one challenge, one device, one flow.
  for (const name of ['openai-sentinel-token', 'openai-sentinel-so-token']) {
    const envelope = JSON.parse(headers[name]);
    assert.equal(envelope.c, challenge.token);
    assert.equal(envelope.id, 'otp-did');
    assert.equal(envelope.flow, 'email_otp_validate');
  }

  assert.deepEqual(flows, [
    ['requirements', 'email_otp_validate'],
    ['tokens', 'email_otp_validate', challenge.token, 'otp-requirements-proof', 'otp-did'],
  ]);
  // Stops at the next real boundary, so nothing else was replayed.
  assert.equal(summarizeRegistrationState(state).blocked.step, 'phone_otp_send');
});

test('a registration state written before the Sentinel OTP step resumes on the right step', () => {
  const before = RUN_STEPS.findIndex((step) => step.name === 'sentinel_email_otp_validate');

  // Parked on the old `email_otp_validate` (same index the Sentinel step now
  // holds): stays put, because that step blocks on the same input.
  const parked = migrateRegistrationState({ mode: 'pure-url-registration-runner', next: before });
  assert.equal(parked.next, before);
  assert.equal(parked.stepPlanVersion, STEP_PLAN_VERSION);

  // Anything past it shifts down by one so a finished step is not replayed.
  const past = migrateRegistrationState({ mode: 'pure-url-registration-runner', next: before + 1 });
  assert.equal(past.next, before + 2);

  // Migrating twice is a no-op, and login states are left alone.
  assert.equal(migrateRegistrationState(past).next, before + 2);
  const login = migrateRegistrationState({ mode: 'pure-url-oauth-login-runner', next: before + 1 });
  assert.equal(login.next, before + 1);
  assert.equal(login.stepPlanVersion, undefined);
});

test('oauth login runner verifies password and extracts callback code', async () => {
  const { har } = loadHar();
  const state = makeInitialLoginState(har, {
    email: 'user1@example.com',
    password: 'Password123!aa',
  });
  const finalCode = 'ac_unit_test_code';

  await runLoginFlow(har, state, {
    dynamicSentinel: false,
    executor: async (request, step) => {
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

      const jsonByStep = {
        login_authorize_continue: {
          continue_url: 'https://auth.openai.com/log-in/password',
          page: { type: 'login_password' },
          'oai-client-auth-session': { username: { value: state.email, kind: 'email' } },
        },
        password_verify: {
          continue_url: 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent',
          page: { type: 'sign_in_with_chatgpt_codex_consent' },
          'oai-client-auth-session': {
            workspaces: [{ id: 'workspace-unit', kind: 'personal', name: null }],
          },
        },
        workspace_select: {
          continue_url: 'https://auth.openai.com/api/oauth/oauth2/auth?login_verifier=unit',
          page: { type: 'redirect' },
          'oai-client-auth-session': {
            workspaces: [{ id: 'workspace-unit', kind: 'personal', name: null }],
          },
        },
      };
      const redirectByStep = {
        bootstrap_oauth_authorize: 'https://auth.openai.com/api/oauth/oauth2/auth?unit=1',
        bootstrap_oauth_auth: 'https://auth.openai.com/api/accounts/login?login_challenge=unit',
        bootstrap_accounts_login: 'https://auth.openai.com/log-in',
        oauth_auth_login_verifier: 'https://auth.openai.com/api/accounts/consent?consent_challenge=unit',
        oauth_consent: 'https://auth.openai.com/api/oauth/oauth2/auth?consent_verifier=unit',
        oauth_auth_consent_verifier: `http://localhost:1455/auth/callback?code=${finalCode}&state=${state.oauth.state}`,
      };
      const statusByStep = {
        bootstrap_oauth_authorize: 302,
        bootstrap_oauth_auth: 302,
        bootstrap_accounts_login: 302,
        oauth_auth_login_verifier: 302,
        oauth_consent: 302,
        oauth_auth_consent_verifier: 303,
      };

      return {
        request,
        response: {
          status: statusByStep[step.name] || 200,
          url: request.url,
          location: redirectByStep[step.name] || '',
          contentType: 'application/json',
          text: JSON.stringify(jsonByStep[step.name] || {}),
        },
        cookies: { ...state.cookies, 'oai-did': 'fresh-did' },
      };
    },
  });

  assert.equal(state.complete, true);
  assert.equal(state.blocked, null);
  assert.equal(state.inputs.workspaceId, 'workspace-unit');
  assert.equal(state.oauthCode, finalCode);
  assert.equal(summarizeRegistrationState(state, { steps: LOGIN_STEPS }).nextStep, null);
  assert.ok(JSON.parse(state.sentinelHeaders.password_verify['openai-sentinel-token']).p);
});

test('oauth runner rejects successful final redirects with an error, missing code, or wrong callback target', async () => {
  const { har } = loadHar();
  const finalIndex = LOGIN_STEPS.findIndex((step) => step.name === 'oauth_auth_consent_verifier');
  const callbacks = [
    (state) => `http://localhost:1455/auth/callback?error=access_denied&state=${state.oauth.state}`,
    (state) => `http://localhost:1455/auth/callback?state=${state.oauth.state}`,
    (state) => `https://example.test/callback?state=${state.oauth.state}`,
  ];

  for (const callback of callbacks) {
    const state = makeInitialLoginState(har, {
      email: 'callback@example.test',
      password: 'unit-password',
    });
    state.next = finalIndex;
    state.lastLocation = 'https://auth.openai.com/api/oauth/oauth2/auth?consent_verifier=unit';
    state.oauthCode = 'stale-code';

    await assert.rejects(runLoginFlow(har, state, {
      once: true,
      dynamicSentinel: false,
      executor: async (request) => ({
        request,
        response: {
          status: 303,
          url: request.url,
          location: callback(state),
          contentType: 'text/plain',
          text: '',
        },
        cookies: state.cookies,
      }),
    }));
    assert.equal(state.oauthCode, '');
    assert.notEqual(state.complete, true);
  }
});
