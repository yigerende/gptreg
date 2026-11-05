'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ChatGptSessionRunner,
  mfaTotpFactor,
  makeInitialChatGptSessionState,
  retryableSecurityError,
} = require('../src/chatgpt-session-runner');
const { createCookieJar } = require('../src/cookie-jar');
const { loadHar } = require('../src/har');
const { clearSentinelSdkCache } = require('../src/sentinel-sdk-loader');
const { UrlSession } = require('../src/url-session');

function result(json = {}, options = {}) {
  return {
    json,
    response: {
      status: options.status || 200,
      url: options.url || 'https://auth.openai.com/fixture',
      location: options.location || '',
      contentType: options.contentType || 'application/json',
      text: options.text === undefined ? JSON.stringify(json) : options.text,
      ...(options.serverDate ? { serverDate: options.serverDate } : {}),
    },
    ...(options.history ? { history: options.history } : {}),
  };
}

function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.${Buffer.from('sig').toString('base64url')}`;
}

test('accepts contextual alphanumeric email OTPs and rejects malformed callback values', async () => {
  const accepted = new ChatGptSessionRunner({ log: { entries: [] } }, {
    getEmailCode: async () => ({ code: 'A1B2C3' }),
  });
  const rejected = new ChatGptSessionRunner({ log: { entries: [] } }, {
    getEmailCode: async () => ({ code: 'ABCDEF' }),
  });
  const state = makeInitialChatGptSessionState({ email: 'otp@example.test' });

  assert.equal(await accepted.waitEmailCode(state), 'A1B2C3');
  await assert.rejects(
    rejected.waitEmailCode(state),
    (error) => error.code === 'EMAIL_OTP_FORMAT_INVALID',
  );
});

test('recognizes the non-recovery TOTP factor from an MFA page', () => {
  assert.deepEqual(mfaTotpFactor({
    page: {
      type: 'mfa_challenge',
      payload: {
        factor_id: 'factor-current',
        factors: [
          { id: 'recovery', factor_type: 'email', is_recovery: true },
          { id: 'factor-current', factor_type: 'totp', is_recovery: false },
        ],
      },
    },
  }), { id: 'factor-current', type: 'totp', recovery: false });
});

test('completes MFA before marking the NextAuth callback as complete', async () => {
  const email = 'mfa@example.test';
  const state = makeInitialChatGptSessionState({
    email,
    totpSecret: 'JBSWY3DPEHPK3PXP',
  });
  state.step = 'email_otp_sent';
  state.emailBoundary = { capturedAt: '2026-08-06T00:00:00.000Z', messageIds: ['mfa-mail'] };
  const calls = [];
  const callback = 'https://chatgpt.com/api/auth/callback/openai?code=fixture&state=fixture';
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    getEmailCode: async () => ({ code: 'A1B2C3' }),
    executor: async (request) => {
      const url = new URL(request.url);
      calls.push({ method: request.method, path: url.pathname, body: request.body, headers: request.headers });
      if (url.pathname === '/api/accounts/email-otp/validate') {
        return result({
          continue_url: 'https://auth.openai.com/mfa-challenge/challenge',
          page: {
            type: 'mfa_challenge',
            payload: {
              factor_id: 'factor-current',
              factors: [{ id: 'factor-current', factor_type: 'totp', is_recovery: false }],
            },
          },
        }, { url: request.url });
      }
      if (url.pathname === '/api/accounts/mfa/issue_challenge') return result({}, { url: request.url });
      if (url.pathname === '/api/accounts/mfa/verify') {
        assert.match(JSON.parse(request.body).code, /^\d{6}$/);
        assert.equal(JSON.parse(request.body).id, 'factor-current');
        const invocationHeader = Object.keys(request.headers).find((name) => name.toLowerCase() === 'x-access-flow-invocation-id');
        assert.ok(invocationHeader);
        assert.match(request.headers[invocationHeader], /^[0-9a-f-]{36}$/i);
        return result({ page: { type: 'external_url', payload: { url: callback } } }, { url: request.url });
      }
      if (url.pathname === '/api/auth/callback/openai') {
        return result({}, { status: 302, url: request.url, location: 'https://chatgpt.com/' });
      }
      if (url.hostname === 'chatgpt.com' && url.pathname === '/') return result({}, { url: request.url });
      if (url.pathname === '/api/auth/session') {
        return result({ accessToken: 'not-a-jwt', user: { email } }, { url: request.url });
      }
      if (url.pathname === '/backend-api/me') return result({ email, account_id: 'account-mfa' }, { url: request.url });
      if (url.pathname === '/backend-api/wham/usage') return result({}, { status: 404, url: request.url });
      throw new Error(`Unexpected fixture request: ${request.method} ${request.url}`);
    },
  });

  await runner.run(state);

  assert.equal(state.step, 'verified');
  assert.equal(state.status, 'valid');
  assert.equal(state.authCallbackUrl, callback);
  assert.match(state.mfaChallenge.invocationId, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(calls.map((call) => call.path), [
    '/api/accounts/email-otp/validate',
    '/api/accounts/mfa/issue_challenge',
    '/api/accounts/mfa/verify',
    '/api/auth/callback/openai',
    '/',
    '/api/auth/session',
    '/backend-api/me',
    '/backend-api/wham/usage',
  ]);
  assert.deepEqual(state.events.map((event) => event.type).filter((type) => type.startsWith('mfa_') || type === 'auth_completed'), [
    'mfa_challenge_issued',
    'mfa_verification_pending',
    'mfa_validated',
    'auth_completed',
  ]);
  assert.equal(JSON.stringify(state.events).includes('A1B2C3'), false);
});

test('rejects a refreshed login state whose account ID differs from the saved asset', async () => {
  const email = 'bound-session@example.test';
  const state = makeInitialChatGptSessionState({ email });
  state.step = 'auth_completed';
  state.accountId = 'expected-account';
  const accessToken = jwt({
    email,
    'https://api.openai.com/auth': { chatgpt_account_id: 'different-account' },
  });
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    executor: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/api/auth/session') {
        return result({ accessToken, user: { email }, account: { id: 'different-account' } }, { url: request.url });
      }
      if (url.pathname === '/backend-api/me') {
        return result({ email, account_id: 'different-account' }, { url: request.url });
      }
      if (url.pathname === '/backend-api/wham/usage') return result({}, { status: 404, url: request.url });
      throw new Error(`Unexpected identity fixture request: ${request.method} ${request.url}`);
    },
  });

  await assert.rejects(
    runner.run(state),
    (error) => error.code === 'SESSION_IDENTITY_MISMATCH',
  );
  assert.equal(state.accountId, 'expected-account');
  assert.notEqual(state.step, 'verified');
});

for (const sessionStatus of [404, 200]) {
  test(`recovers an authenticated session from the home bootstrap when NextAuth session is ${sessionStatus === 404 ? 'unavailable' : 'empty'}`, async () => {
    const email = `bootstrap-${sessionStatus}@example.test`;
    const state = makeInitialChatGptSessionState({ email });
    state.step = 'auth_completed';
    const accessToken = jwt({ email, 'https://api.openai.com/auth': { chatgpt_account_id: `account-${sessionStatus}` } });
    const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
      executor: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === '/api/auth/session') {
          return result(sessionStatus === 404 ? {} : { session: {} }, { status: sessionStatus, url: request.url });
        }
        if (url.pathname === '/') {
          return result({}, {
            contentType: 'text/html',
            text: `<script id="client-bootstrap" type="application/json">${JSON.stringify({ session: { accessToken, user: { email } } })}</script>`,
            url: request.url,
          });
        }
        if (url.pathname === '/backend-api/me') return result({ email, account_id: `account-${sessionStatus}` }, { url: request.url });
        if (url.pathname === '/backend-api/wham/usage') return result({}, { status: 404, url: request.url });
        throw new Error(`Unexpected bootstrap fixture request: ${request.method} ${request.url}`);
      },
    });

    await runner.run(state);

    assert.equal(state.status, 'valid');
    assert.equal(state.step, 'verified');
    assert.equal(state.accountId, `account-${sessionStatus}`);
  });
}

test('does not accept an anonymous home bootstrap as an authenticated session', async () => {
  const state = makeInitialChatGptSessionState({ email: 'anonymous-bootstrap@example.test' });
  state.step = 'auth_completed';
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    executor: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/api/auth/session') return result({}, { status: 404, url: request.url });
      if (url.pathname === '/') return result({}, {
        contentType: 'text/html',
        text: '<script id="client-bootstrap" type="application/json">{"session":{}}</script>',
        url: request.url,
      });
      throw new Error(`Unexpected anonymous bootstrap request: ${request.method} ${request.url}`);
    },
  });

  await assert.rejects(
    runner.run(state),
    (error) => error.code === 'SESSION_ACCESS_TOKEN_MISSING',
  );
});

test('reconciles a successful callback before replaying its one-time code', async () => {
  const email = 'callback-reconcile@example.test';
  const state = makeInitialChatGptSessionState({ email });
  state.step = 'auth_callback_pending';
  state.pendingAuthCallbackUrl = 'https://chatgpt.com/api/auth/callback/openai?code=one-time&state=unit';
  const accessToken = jwt({ email, 'https://api.openai.com/auth': { chatgpt_account_id: 'account-reconciled' } });
  const calls = [];
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    executor: async (request) => {
      const url = new URL(request.url);
      calls.push(url.pathname);
      if (url.pathname === '/api/auth/session') return result({ accessToken, user: { email } }, { url: request.url });
      if (url.pathname === '/backend-api/me') return result({ email, account_id: 'account-reconciled' }, { url: request.url });
      if (url.pathname === '/backend-api/wham/usage') return result({}, { status: 404, url: request.url });
      if (url.pathname === '/api/auth/callback/openai') throw new Error('The one-time callback must not be replayed');
      throw new Error(`Unexpected callback reconciliation request: ${request.method} ${request.url}`);
    },
  });

  await runner.run(state);

  assert.equal(state.status, 'valid');
  assert.equal(state.step, 'verified');
  assert.equal(state.pendingAuthCallbackUrl, '');
  assert.equal(calls.includes('/api/auth/callback/openai'), false);
});

test('reports a missing TOTP secret instead of treating an MFA page as authenticated', async () => {
  const state = makeInitialChatGptSessionState({ email: 'mfa-missing@example.test' });
  state.step = 'mfa_required';
  state.continueUrl = 'https://auth.openai.com/mfa-challenge/challenge';
  state.authPayload = {
    continue_url: state.continueUrl,
    page: {
      type: 'mfa_challenge',
      payload: { factor_id: 'factor-current', factors: [{ id: 'factor-current', factor_type: 'totp' }] },
    },
  };
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    getEmailCode: async () => ({ code: 'A1B2C3' }),
  });
  runner.checkpoint = async () => {};

  await assert.rejects(
    runner.run(state),
    (error) => error.code === 'MFA_TOTP_SECRET_REQUIRED',
  );
  assert.equal(state.step, 'mfa_required');
  assert.equal(state.mfaChallenge.status, 'blocked');
});

test('never labels an empty auth continuation as auth_completed', async () => {
  const state = makeInitialChatGptSessionState({ email: 'continuation@example.test' });
  state.continueUrl = 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent';
  state.step = 'email_otp_validated';
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {});
  runner.request = async () => result({});
  runner.checkpoint = async () => {};

  await assert.rejects(
    runner.followContinuation(state, {}),
    (error) => error.code === 'AUTH_CONTINUATION_MISSING',
  );
  assert.notEqual(state.step, 'auth_completed');
});

test('rejects a NextAuth callback that lands on an error page without marking auth complete', async () => {
  const state = makeInitialChatGptSessionState({ email: 'callback-error@example.test' });
  state.step = 'email_otp_validated';
  state.continueUrl = 'https://chatgpt.com/api/auth/callback/openai?code=fixture&state=fixture';
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    executor: async (request) => {
      const url = new URL(request.url);
      if (url.pathname === '/api/auth/callback/openai') {
        return result({}, { status: 302, url: request.url, location: 'https://chatgpt.com/api/auth/error?error=Callback' });
      }
      if (url.pathname === '/api/auth/error') return result({}, { url: request.url, text: '<title>NextAuth error</title>' });
      throw new Error(`Unexpected callback fixture request: ${request.method} ${request.url}`);
    },
  });
  await assert.rejects(
    runner.followContinuation(state, runner.session(state)),
    (error) => error.code === 'AUTH_CALLBACK_ERROR_PAGE',
  );
  assert.notEqual(state.step, 'auth_completed');
  assert.equal(state.authCallbackUrl, '');
});

test('captures a signup mail boundary before starting the NextAuth transaction', async () => {
  const order = [];
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    beforeEmailSend: async () => {
      order.push('boundary');
      return { capturedAt: '2026-08-05T00:00:00.000Z', messageIds: ['old'] };
    },
  });
  const state = makeInitialChatGptSessionState({ email: 'new@example.test' });
  runner.nextAuthAuthorize = async () => {
    order.push('authorize');
    return {
      authorizeUrl: 'https://auth.openai.com/api/accounts/authorize?screen_hint=signup',
      landedUrl: 'https://auth.openai.com/log-in',
    };
  };
  runner.checkpoint = async (_state, _session, reason) => { order.push(`checkpoint:${reason}`); };

  await runner.bootstrap(state, {}, {});

  assert.deepEqual(order, [
    'boundary',
    'checkpoint:email_boundary_captured',
    'authorize',
    'checkpoint:nextauth_ready',
  ]);
  assert.deepEqual(state.emailBoundary.messageIds, ['old']);
});

test('a failed signup password detour keeps the OTP issued during identity submission', async () => {
  const calls = [];
  const boundaryOptions = [];
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    beforeEmailSend: async (_email, _state, options) => {
      boundaryOptions.push(options);
      return { capturedAt: '2026-08-05T00:00:00.000Z', messageIds: ['before-identity'] };
    },
    checkpoint: async () => {},
  });
  runner.sentinelHeaders = async () => ({});
  runner.request = async (_session, operation, _method, url) => {
    calls.push(operation);
    if (operation === 'authorize_continue') {
      return result({
        continue_url: 'https://auth.openai.com/api/accounts/email-otp/send',
        page: { type: 'email_otp_verification' },
      }, { url });
    }
    if (operation === 'user_register') {
      throw Object.assign(new Error('password detour unavailable'), {
        code: 'INVALID_AUTH_STEP',
        status: 400,
      });
    }
    return result({}, { url });
  };

  const state = makeInitialChatGptSessionState({ email: 'fallback-boundary@example.test' });
  state.step = 'nextauth_ready';
  state.continueUrl = 'https://auth.openai.com/api/accounts/authorize/continue';
  state.emailBoundary = { capturedAt: '2026-08-05T00:00:00.000Z', messageIds: ['before-identity'] };

  await runner.submitIdentity(state, { serializeCookies: () => state.cookieJar }, {});
  await runner.sendEmailOtp(state, { serializeCookies: () => state.cookieJar }, {});

  assert.deepEqual(calls, [
    'authorize_continue',
    'create_account_password_page',
    'user_register',
    'email_otp_send',
  ]);
  assert.equal(state.step, 'email_otp_sent');
  assert.deepEqual(state.emailBoundary.messageIds, ['before-identity']);
  assert.deepEqual(boundaryOptions, []);
});

test('rebuilds an expired authorize continuation once without losing the mail boundary', async () => {
  const calls = [];
  const boundaries = [];
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    beforeEmailSend: async (_email, _state, options) => {
      boundaries.push(options);
      return { capturedAt: '2026-08-05T00:00:00.000Z', messageIds: ['before-auth'] };
    },
    getEmailCode: async () => ({ code: 'A1B2C3' }),
    checkpoint: async () => {},
  });
  runner.sentinelHeaders = async () => ({});
  runner.nextAuthAuthorize = async () => ({
    authorizeUrl: 'https://auth.openai.com/api/accounts/authorize?screen_hint=signup',
    landedUrl: 'https://auth.openai.com/log-in',
  });
  runner.request = async (_session, operation, _method, url) => {
    calls.push(operation);
    if (operation === 'authorize_continue' && calls.filter((item) => item === 'authorize_continue').length === 1) {
      throw Object.assign(new Error('authorize_continue failed with HTTP 409: invalid_state'), {
        code: 'INVALID_STATE',
        status: 409,
      });
    }
    if (operation === 'authorize_continue') {
      return result({
        continue_url: 'https://auth.openai.com/api/accounts/email-otp/send',
        page: { type: 'email_otp_verification' },
      }, { url });
    }
    if (operation === 'create_account_password_page') return result({}, { url });
    if (operation === 'user_register') {
      throw Object.assign(new Error('password detour unavailable'), {
        code: 'INVALID_AUTH_STEP',
        status: 400,
      });
    }
    if (operation === 'email_otp_send') return result({}, { url });
    if (operation === 'email_otp_validate') {
      return result({
        continue_url: 'https://auth.openai.com/add-phone',
        page: { type: 'add_phone' },
      }, { url });
    }
    throw new Error(`Unexpected fixture request: ${operation}`);
  };

  const state = makeInitialChatGptSessionState({ email: 'stale-auth@example.test' });
  state.step = 'nextauth_ready';
  state.continueUrl = 'https://auth.openai.com/api/accounts/authorize/continue';
  await runner.run(state);

  assert.equal(state.step, 'phone_required');
  assert.equal(state.authTransactionRestarts, 1);
  assert.equal(calls.filter((item) => item === 'authorize_continue').length, 2);
  assert.deepEqual(boundaries, [{ fresh: true, purpose: 'registration_identity', preSend: true }]);
  assert.equal(state.events.some((event) => event.type === 'auth_transaction_restarted'), true);
});

test('stale authorize recovery drops transaction cookies but keeps the device identity', async () => {
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    beforeEmailSend: async () => ({ capturedAt: '2026-08-05T00:00:00.000Z', messageIds: ['before-auth'] }),
    getEmailCode: async () => ({ code: 'A1B2C3' }),
    checkpoint: async (reason, state) => {
      state.lastCheckpoint = reason;
    },
  });
  runner.sentinelHeaders = async () => ({});
  runner.nextAuthAuthorize = async () => ({
    authorizeUrl: 'https://auth.openai.com/api/accounts/authorize?screen_hint=signup',
    landedUrl: 'https://auth.openai.com/log-in',
  });
  let authorizeContinueCalls = 0;
  runner.request = async (_session, operation, _method, url) => {
    if (operation === 'authorize_continue' && authorizeContinueCalls++ === 0) {
      throw Object.assign(new Error('authorize_continue failed with HTTP 409: invalid_state'), {
        code: 'INVALID_STATE',
        status: 409,
      });
    }
    if (operation === 'authorize_continue') {
      return result({
        continue_url: 'https://auth.openai.com/api/accounts/email-otp/send',
        page: { type: 'email_otp_verification' },
      }, { url });
    }
    if (operation === 'create_account_password_page') return result({}, { url });
    if (operation === 'user_register') {
      throw Object.assign(new Error('password detour unavailable'), {
        code: 'INVALID_AUTH_STEP',
        status: 400,
      });
    }
    if (operation === 'email_otp_send') return result({}, { url });
    if (operation === 'email_otp_validate') {
      return result({
        continue_url: 'https://auth.openai.com/add-phone',
        page: { type: 'add_phone' },
      }, { url });
    }
    throw new Error(`Unexpected fixture request: ${operation}`);
  };

  const state = makeInitialChatGptSessionState({ email: 'stale-cookie@example.test' });
  const jar = createCookieJar(state.cookieJar);
  jar.setCookieSync('oai-client-auth-session=stale; Path=/', 'https://auth.openai.com/');
  jar.setCookieSync('oai-client-auth-info=stale; Path=/', 'https://auth.openai.com/');
  jar.setCookieSync('oai-login-csrf_dev_123=stale; Path=/', 'https://auth.openai.com/');
  jar.setCookieSync('__Host-next-auth.csrf-token=stale; Path=/', 'https://chatgpt.com/');
  jar.setCookieSync('__Secure-next-auth.callback-url=stale; Path=/', 'https://chatgpt.com/');
  state.cookieJar = jar.serializeSync();
  state.step = 'nextauth_ready';
  state.continueUrl = 'https://auth.openai.com/api/accounts/authorize/continue';

  await runner.run(state);

  const keys = new Set((state.cookieJar.cookies || []).map((cookie) => cookie.key));
  assert.equal(keys.has('oai-did'), true);
  assert.equal(keys.has('oai-client-auth-session'), false);
  assert.equal(keys.has('oai-client-auth-info'), false);
  assert.equal(keys.has('oai-login-csrf_dev_123'), false);
  assert.equal(keys.has('__Host-next-auth.csrf-token'), false);
  assert.equal(keys.has('__Secure-next-auth.callback-url'), false);
});

test('existing-account password page switches to passwordless email OTP recovery', async () => {
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    beforeEmailSend: async () => ({ capturedAt: '2026-08-05T00:00:00.000Z', messageIds: ['old'] }),
  });
  const state = makeInitialChatGptSessionState({ email: 'existing@example.test' });
  state.authPayload = { page: { type: 'login_password' }, continue_url: 'https://auth.openai.com/log-in/password' };
  const calls = [];
  runner.request = async (_session, operation, method, url, options) => {
    calls.push({ operation, method, url, options });
    return result({ continue_url: 'https://auth.openai.com/email-verification' });
  };
  runner.checkpoint = async () => {};

  await runner.sendEmailOtp(state, {}, {});

  assert.equal(state.existingAccount, true);
  assert.equal(state.step, 'email_otp_sent');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://auth.openai.com/api/accounts/passwordless/send-otp');
  assert.deepEqual(state.emailBoundary.messageIds, ['old']);
});

test('OAuth email login refuses every new-account creation branch', async () => {
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {});
  const state = makeInitialChatGptSessionState({ email: 'not-registered@example.test' });
  state.authPayload = {
    page: { type: 'create_account_password' },
    continue_url: 'https://auth.openai.com/create-account/password',
  };
  runner.request = async () => { throw new Error('new-account mutation must not be requested'); };
  runner.checkpoint = async () => {};

  await assert.rejects(
    runner.sendEmailOtp(state, {}, { security: {}, existingOnly: true }),
    (error) => error.code === 'OAUTH_EXISTING_ACCOUNT_REQUIRED',
  );

  state.authPayload = { page: { type: 'about_you' }, continue_url: 'https://auth.openai.com/about-you' };
  await assert.rejects(
    runner.completeAccount(state, {}, { existingOnly: true }),
    (error) => error.code === 'OAUTH_EXISTING_ACCOUNT_REQUIRED',
  );
});

test('optional password setup performs a second NextAuth authorization and independent OTP transaction', async () => {
  const boundaryOptions = [];
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    beforeEmailSend: async (_email, _state, options) => {
      boundaryOptions.push(options);
      return { capturedAt: '2026-08-05T00:00:01.000Z', messageIds: ['registration-message'] };
    },
    getEmailCode: async (_email, boundary) => {
      assert.equal(boundary.capturedAt, '2026-08-05T00:00:01.000Z');
      return { code: 'A1B2C3' };
    },
  });
  const state = makeInitialChatGptSessionState({ email: 'passwordless@example.test' });
  state.step = 'verified';
  state.status = 'valid';
  const signIns = [];
  const requests = [];
  const sentinelFlows = [];
  runner.nextAuthContext = async () => 'csrf-fixture';
  runner.openAiSignIn = async (_state, _session, csrf, query, operation) => {
    signIns.push({ csrf, query, operation });
    return operation === 'password_add_authorize'
      ? { authorizeUrl: 'https://auth.openai.com/authorize?password=1', landedUrl: 'https://auth.openai.com/email-verification' }
      : { authorizeUrl: 'https://auth.openai.com/authorize?session=1', landedUrl: 'https://chatgpt.com/api/auth/callback/openai' };
  };
  runner.sentinelHeaders = async (_state, _session, flow) => {
    sentinelFlows.push(flow);
    return { 'openai-sentinel-token': `sentinel-${flow}` };
  };
  runner.request = async (_session, operation, method, url, options = {}) => {
    requests.push({ operation, method, url, options });
    if (operation === 'password_otp_validate') {
      return result({ continue_url: 'https://auth.openai.com/reset-password/new-password', page: { type: 'reset_password' } });
    }
    if (operation === 'password_add') {
      return result({ continue_url: 'https://chatgpt.com/api/auth/callback/openai?code=fixture' });
    }
    return result({});
  };
  runner.checkpoint = async () => {};

  const failures = await runner.configureSecurity(state, {}, { setPassword: true, enrollTotp: false });

  assert.deepEqual(failures, []);
  assert.equal(signIns.length, 2);
  assert.equal(signIns[1].query.connection, 'password');
  assert.equal(signIns[1].query.post_login_add_password, 'true');
  assert.equal(signIns[1].query.reauth, 'password');
  assert.deepEqual(sentinelFlows, ['email_otp_validate', 'password_reset']);
  assert.match(state.password, /^Gpt-/);
  assert.equal(state.security.passwordStatus, 'configured');
  assert.equal(state.security.passwordTransaction.step, 'complete');
  assert.deepEqual(boundaryOptions, [{ fresh: true, purpose: 'password_setup', preSend: true }]);
  assert.equal(requests.find((call) => call.operation === 'password_otp_validate').options.json.code, 'A1B2C3');
  assert.equal(requests.some((call) => call.url.endsWith('/api/accounts/password/add')), true);
  assert.equal(requests.some((call) => call.operation === 'password_callback'), true);
});

test('password mutation MFA continuation records the password as configured without replaying the callback', async () => {
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {});
  const state = makeInitialChatGptSessionState({ email: 'password-mfa-continuation@example.test' });
  state.step = 'verified';
  state.status = 'valid';
  const calls = [];
  runner.beginPasswordSetup = async (current) => {
    current.security.passwordTransaction = {
      step: 'otp_validated',
      resetExisting: false,
      password: 'Gpt-fixture-password!8a',
    };
  };
  runner.sentinelHeaders = async () => ({ 'openai-sentinel-token': 'fixture' });
  runner.securityRequest = async (_session, operation, method, url) => {
    calls.push(operation);
    assert.equal(operation, 'password_add');
    assert.equal(method, 'POST');
    return result({ continue_url: 'https://auth.openai.com/mfa-challenge/confirmation' }, { url });
  };
  runner.checkpoint = async () => {};

  const failures = await runner.configureSecurity(state, {}, { setPassword: true, enrollTotp: false });

  assert.deepEqual(failures, []);
  assert.deepEqual(calls, ['password_add']);
  assert.equal(state.security.passwordStatus, 'configured');
  assert.equal(state.security.passwordTransaction.step, 'complete');
  assert.equal(state.security.passwordTransaction.confirmationMfaRequired, true);
  assert.equal(state.security.passwordTransaction.confirmationMfaPath, '/mfa-challenge/confirmation');
  assert.equal(calls.includes('password_callback'), false);
});

test('pure session refresh preserves unresolved security failures', async () => {
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {});
  const state = makeInitialChatGptSessionState({ email: 'pure-refresh-security@example.test' });
  state.step = 'verified';
  state.status = 'partial';
  state.accessToken = 'saved-access-token';
  state.security.passwordStatus = 'failed';
  state.security.passwordTransaction = { step: 'password_submitted' };
  state.security.failures = [{ feature: 'password', code: 'PASSWORD_SETUP_FAILED' }];
  runner.verify = async (current) => {
    current.step = 'verified';
    current.status = 'valid';
  };
  runner.checkpoint = async () => {};

  await runner.run(state, { skipVerifiedSessionRefresh: false });

  assert.equal(state.status, 'partial');
  assert.equal(state.security.passwordStatus, 'failed');
  assert.equal(state.security.failures[0].code, 'PASSWORD_SETUP_FAILED');
});

test('usage metadata timeout does not invalidate a verified session or erase cached plan data', async () => {
  const email = 'usage-timeout@example.test';
  const state = makeInitialChatGptSessionState({ email });
  state.step = 'auth_completed';
  state.planType = 'plus';
  state.usage = { plan_type: 'plus', source: 'cached' };
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {});
  const accessToken = jwt({ email, 'https://api.openai.com/auth': { chatgpt_account_id: 'usage-account' } });
  runner.request = async (_session, operation, _method, url) => {
    if (operation === 'chatgpt_session') return result({ accessToken, user: { email } }, { url });
    if (operation === 'chatgpt_me') return result({ email, account_id: 'usage-account' }, { url });
    if (operation === 'chatgpt_usage') throw Object.assign(new Error('usage request timed out'), { code: 'ETIMEDOUT' });
    throw new Error(`Unexpected usage fixture operation: ${operation}`);
  };
  runner.checkpoint = async () => {};

  await runner.run(state);

  assert.equal(state.status, 'valid');
  assert.equal(state.step, 'verified');
  assert.equal(state.planType, 'plus');
  assert.deepEqual(state.usage, { plan_type: 'plus', source: 'cached' });
});

test('saved plan data allows a refresh to skip the non-authoritative usage request', async () => {
  const email = 'usage-cache-refresh@example.test';
  const state = makeInitialChatGptSessionState({ email });
  state.step = 'auth_completed';
  state.planType = 'free';
  state.usage = { plan_type: 'free', source: 'cached' };
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {});
  const accessToken = jwt({ email, 'https://api.openai.com/auth': { chatgpt_account_id: 'usage-cache-account' } });
  const operations = [];
  runner.request = async (_session, operation, _method, url) => {
    operations.push(operation);
    if (operation === 'chatgpt_session') return result({ accessToken, user: { email } }, { url });
    if (operation === 'chatgpt_me') return result({ email, account_id: 'usage-cache-account' }, { url });
    throw new Error(`Unexpected metadata operation: ${operation}`);
  };
  runner.checkpoint = async () => {};

  await runner.run(state, { skipUsageMetadata: true });

  assert.deepEqual(operations, ['chatgpt_session', 'chatgpt_me']);
  assert.equal(state.status, 'valid');
  assert.equal(state.planType, 'free');
  assert.deepEqual(state.usage, { plan_type: 'free', source: 'cached' });
});

test('refreshes the access token after password mutation before enrolling TOTP', async () => {
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {});
  const state = makeInitialChatGptSessionState({ email: 'security@example.test' });
  state.step = 'verified';
  state.status = 'valid';
  state.security.passwordStatus = 'configured';
  state.security.passwordTransaction = { step: 'complete', completedAt: '2026-08-05T00:00:00.000Z' };
  const order = [];
  runner.refreshAccessToken = async (current) => {
    order.push('refresh');
    current.security.passwordTransaction.accessTokenRefreshedAt = '2026-08-05T00:00:01.000Z';
  };
  runner.enrollTotp = async (current) => {
    order.push('totp');
    current.security.totpStatus = 'configured';
    current.totpSecret = 'totp-fixture';
  };
  runner.checkpoint = async () => {};

  const failures = await runner.configureSecurity(state, {}, { setPassword: true, enrollTotp: true });

  assert.deepEqual(failures, []);
  assert.deepEqual(order, ['refresh', 'totp']);
  assert.equal(state.security.totpStatus, 'configured');
});

test('security re-authentication verifies the saved password without mutating it', async () => {
  const checkpoints = [];
  const sentinelFlows = [];
  const requests = [];
  let boundaryCalls = 0;
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    proxy: 'http://127.0.0.1:7890',
    beforeEmailSend: async () => {
      boundaryCalls += 1;
      throw Object.assign(new Error('mailbox not found'), { code: 'MAILBOX_NOT_FOUND', status: 404 });
    },
    checkpoint: async (reason) => checkpoints.push(reason),
  });
  const state = makeInitialChatGptSessionState({
    email: 'security-reauth@example.test',
    password: 'Gpt-existing-password!8a',
  });
  state.step = 'verified';
  state.status = 'partial';
  state.accountId = 'account-security-reauth';
  state.accessToken = 'old-access-token';
  runner.nextAuthContext = async () => 'csrf-security-reauth';
  runner.openAiSignIn = async (_state, _session, csrf, query, operation) => {
    assert.equal(csrf, 'csrf-security-reauth');
    assert.equal(operation, 'security_reauth');
    assert.equal(query.connection, 'password');
    assert.equal(query.reauth, 'password');
    assert.equal(query.max_age, '0');
    assert.equal(Object.hasOwn(query, 'post_login_add_password'), false);
    return { authorizeUrl: 'https://auth.openai.com/authorize/security', landedUrl: 'https://auth.openai.com/log-in/password' };
  };
  runner.sentinelHeaders = async (_state, _session, flow) => {
    sentinelFlows.push(flow);
    return { 'openai-sentinel-token': 'sentinel-password-verify' };
  };
  runner.securityRequest = async (_session, operation, method, url, options) => {
    requests.push({ operation, method, url, options });
    assert.equal(operation, 'security_reauth_password_verify');
    return result({ continue_url: 'https://chatgpt.com/api/auth/callback/openai?code=reauth' }, { url });
  };
  runner.followContinuation = async (current) => {
    current.step = 'auth_completed';
    current.authCallbackUrl = current.continueUrl;
  };
  runner.verify = async (current) => {
    current.step = 'verified';
    current.status = 'valid';
    current.accessToken = 'fresh-access-token';
    current.sessionToken = 'fresh-session-token';
    current.accountId = 'account-security-reauth';
    current.me = { email: current.email, account_id: current.accountId };
    current.lastValidatedAt = '2026-08-07T00:00:00.000Z';
  };

  await runner.securityReauthenticate(state, { serializeCookies: () => state.cookieJar });

  assert.deepEqual(sentinelFlows, ['password_verify']);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST');
  assert.equal(new URL(requests[0].url).pathname, '/api/accounts/password/verify');
  assert.deepEqual(requests[0].options.json, { password: 'Gpt-existing-password!8a' });
  assert.equal(state.password, 'Gpt-existing-password!8a');
  assert.equal(state.accessToken, 'fresh-access-token');
  assert.equal(state.security.securityReauth.status, 'complete');
  assert.equal(boundaryCalls, 1);
  assert.equal(checkpoints.includes('security_reauth_started'), true);
  assert.equal(checkpoints.includes('security_reauth_completed'), true);
});

test('security re-authentication accepts the server email OTP step without password mutation', async () => {
  const checkpoints = [];
  const boundaryOptions = [];
  const requests = [];
  let codeReads = 0;
  const callback = 'https://chatgpt.com/api/auth/callback/openai?code=email-reauth';
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    proxy: 'http://127.0.0.1:7890',
    beforeEmailSend: async (_email, _current, options) => {
      boundaryOptions.push(options);
      return { capturedAt: '2026-08-07T00:00:00.000Z', messageIds: ['before-security-reauth'] };
    },
    getEmailCode: async (_email, boundary) => {
      codeReads += 1;
      assert.equal(boundary.messageIds[0], 'before-security-reauth');
      return { code: 'A1B2C3' };
    },
    checkpoint: async (reason) => checkpoints.push(reason),
  });
  const state = makeInitialChatGptSessionState({
    email: 'security-email-reauth@example.test',
  });
  state.step = 'verified';
  state.status = 'partial';
  state.accountId = 'account-security-email-reauth';
  state.accessToken = 'old-access-token';
  runner.nextAuthContext = async () => 'csrf-security-email-reauth';
  runner.openAiSignIn = async (_state, _session, csrf, query, operation) => {
    assert.equal(csrf, 'csrf-security-email-reauth');
    assert.equal(operation, 'security_reauth');
    assert.equal(query.connection, 'password');
    assert.equal(query.reauth, 'password');
    return {
      authorizeUrl: 'https://auth.openai.com/authorize/security-email',
      landedUrl: 'https://auth.openai.com/email-verification',
    };
  };
  runner.securityRequest = async (_session, operation, method, url, options) => {
    requests.push({ operation, method, url, options });
    assert.equal(operation, 'security_reauth_email_otp_validate');
    assert.equal(method, 'POST');
    assert.deepEqual(options.json, { code: 'A1B2C3' });
    return result({ continue_url: callback }, { url });
  };
  runner.followContinuation = async (current) => {
    current.step = 'auth_completed';
    current.authCallbackUrl = current.continueUrl;
  };
  runner.verify = async (current) => {
    current.step = 'verified';
    current.status = 'valid';
    current.accessToken = 'fresh-email-reauth-access-token';
    current.sessionToken = 'fresh-email-reauth-session-token';
    current.accountId = 'account-security-email-reauth';
    current.me = { email: current.email, account_id: current.accountId };
    current.lastValidatedAt = '2026-08-07T00:00:00.000Z';
  };

  await runner.securityReauthenticate(state, { serializeCookies: () => state.cookieJar });

  assert.equal(codeReads, 1);
  assert.deepEqual(boundaryOptions, [{ fresh: true, purpose: 'security_reauth', preSend: true }]);
  assert.equal(requests.length, 1);
  // This fixture deliberately has no saved password, so a server-selected
  // email step must not invent or mutate one.
  assert.equal(state.password, '');
  assert.equal(state.accessToken, 'fresh-email-reauth-access-token');
  assert.equal(state.security.securityReauth.status, 'complete');
  assert.equal(state.security.securityReauth.method, 'email_otp');
  assert.equal(state.security.securityReauth.emailOtp.status, 'validated');
  assert.ok(checkpoints.some((reason) => String(reason).endsWith('security_reauth_email_boundary_captured')));
  assert.ok(checkpoints.some((reason) => String(reason).endsWith('security_reauth_email_otp_sent')));
  assert.ok(checkpoints.some((reason) => String(reason).endsWith('security_reauth_email_otp_received')));
  assert.ok(checkpoints.some((reason) => String(reason).endsWith('security_reauth_email_otp_validated')));
  assert.ok(checkpoints.includes('security_reauth_completed'));
});

test('security email re-authentication resumes a pending OTP without a second authorize or mailbox snapshot', async () => {
  const boundary = { capturedAt: '2026-08-07T00:00:00.000Z', messageIds: ['pending-reauth'] };
  const callback = 'https://chatgpt.com/api/auth/callback/openai?code=resumed-email-reauth';
  let authorizeCalls = 0;
  let boundaryCalls = 0;
  let codeReads = 0;
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    proxy: 'http://127.0.0.1:7890',
    beforeEmailSend: async () => { boundaryCalls += 1; return boundary; },
    getEmailCode: async (_email, currentBoundary) => {
      codeReads += 1;
      assert.deepEqual(currentBoundary, boundary);
      return { code: 'D4E5F6' };
    },
  });
  const state = makeInitialChatGptSessionState({
    email: 'security-email-resume@example.test',
    password: 'Gpt-existing-password!8a',
  });
  state.step = 'verified';
  state.status = 'partial';
  state.accountId = 'account-security-email-resume';
  state.accessToken = 'old-access-token';
  state.security.securityReauth = {
    status: 'failed',
    attempts: 1,
    emailOtp: {
      status: 'waiting',
      method: 'email_otp',
      boundary,
      continueUrl: 'https://auth.openai.com/email-verification',
      sentAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  };
  runner.nextAuthContext = async () => { throw new Error('authorize bootstrap must not repeat'); };
  runner.openAiSignIn = async () => {
    authorizeCalls += 1;
    throw new Error('authorize must not repeat');
  };
  runner.securityRequest = async (_session, operation, method, url, options) => {
    assert.equal(operation, 'security_reauth_email_otp_validate');
    assert.equal(method, 'POST');
    assert.deepEqual(options.json, { code: 'D4E5F6' });
    return result({ continue_url: callback }, { url });
  };
  runner.followContinuation = async (current) => {
    current.step = 'auth_completed';
    current.authCallbackUrl = current.continueUrl;
  };
  runner.verify = async (current) => {
    current.step = 'verified';
    current.status = 'valid';
    current.accessToken = 'resumed-email-reauth-access-token';
    current.sessionToken = 'resumed-email-reauth-session-token';
    current.accountId = 'account-security-email-resume';
    current.me = { email: current.email, account_id: current.accountId };
  };

  await runner.securityReauthenticate(state, { serializeCookies: () => state.cookieJar });

  assert.equal(authorizeCalls, 0);
  assert.equal(boundaryCalls, 0);
  assert.equal(codeReads, 1);
  assert.equal(state.security.securityReauth.status, 'complete');
  assert.equal(state.security.securityReauth.emailOtp.status, 'validated');
});

test('TOTP enrollment performs one security re-authentication after a reauth-required 401', async () => {
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, { proxy: 'http://127.0.0.1:7890' });
  const state = makeInitialChatGptSessionState({
    email: 'totp-reauth-retry@example.test',
    password: 'Gpt-existing-password!8a',
  });
  state.step = 'verified';
  state.status = 'partial';
  state.accessToken = 'saved-access-token';
  state.security.passwordStatus = 'configured';
  state.security.totpStatus = 'failed';
  let reauthCalls = 0;
  let enrollCalls = 0;
  const optionsSeen = [];
  runner.enrollTotp = async (current, _session, options = {}) => {
    enrollCalls += 1;
    optionsSeen.push(options);
    if (enrollCalls === 1) {
      const error = new Error('mfa_enroll failed with HTTP 401: User must re-authenticate to enroll/disable a factor');
      error.code = 'MFA_ENROLL_FAILED';
      error.status = 401;
      throw error;
    }
    current.totpSecret = 'JBSWY3DPEHPK3PXP';
    current.security.totpStatus = 'configured';
  };
  runner.securityReauthenticate = async (current) => {
    reauthCalls += 1;
    current.security.securityReauth = { status: 'complete', expiresAt: new Date(Date.now() + 60_000).toISOString() };
    current.accessToken = 'reauth-access-token';
  };
  runner.securityCheckpoint = async () => {};

  const failures = await runner.configureSecurity(state, {}, { setPassword: true, enrollTotp: true });

  assert.deepEqual(failures, []);
  assert.equal(reauthCalls, 1);
  assert.equal(enrollCalls, 2);
  assert.deepEqual(optionsSeen, [{}, { skipPreflight: true }]);
  assert.equal(state.security.totpStatus, 'configured');
  assert.equal(state.status, 'partial');
});

test('MFA security requests carry the ChatGPT origin and referer contract', async () => {
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {});
  const state = makeInitialChatGptSessionState({ email: 'security-headers@example.test' });
  state.step = 'verified';
  state.status = 'valid';
  state.accessToken = 'access-security-headers';
  state.oaiDid = 'device-security-headers';
  const calls = [];
  runner.securityRequest = async (_session, operation, method, url, options) => {
    calls.push({ operation, method, url, options });
    if (operation === 'mfa_info') return { json: { mfa_enabled: false }, response: { status: 200 } };
    if (operation === 'security_settings') return { json: { aas_eligible: true }, response: { status: 200 } };
    if (operation === 'mfa_enroll') return { json: { secret: 'JBSWY3DPEHPK3PXP', session_id: 'session-fixture', factor: { id: 'factor-fixture' } }, response: { status: 200 } };
    return { json: { success: true }, response: { status: 200 } };
  };
  runner.checkpoint = async () => {};

  await runner.enrollTotp(state, {});

  assert.deepEqual(calls.map((call) => call.operation), ['mfa_info', 'security_settings', 'mfa_enroll', 'mfa_activate']);
  for (const call of calls) {
    assert.equal(call.options.referer, 'https://chatgpt.com/');
    assert.equal(call.options.headers.Authorization, 'Bearer access-security-headers');
    assert.equal(call.options.headers['oai-device-id'], 'device-security-headers');
  }
  assert.equal(calls[0].options.origin, undefined);
  assert.equal(calls[1].options.origin, undefined);
  assert.equal(calls[2].options.origin, 'https://chatgpt.com');
  assert.equal(calls[3].options.origin, 'https://chatgpt.com');
});

test('bounds optional security requests and records a retryable password checkpoint after timeout', async () => {
  const events = [];
  const timeouts = [];
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    securityRequestTimeoutMs: 30000,
    getEmailCode: async () => ({ code: 'A1B2C3' }),
    onEvent: async (event) => events.push(event),
  });
  const state = makeInitialChatGptSessionState({ email: 'security-timeout@example.test' });
  state.step = 'verified';
  state.status = 'valid';
  state.security.passwordTransaction = {
    step: 'otp_sent',
    resetExisting: false,
    emailBoundary: { capturedAt: '2026-08-06T00:00:00.000Z', messageIds: [] },
    password: 'Gpt-timeout-fixture!8a',
  };
  runner.sentinelHeaders = async () => ({});
  const session = {
    serializeCookies: () => ({ version: 1, cookies: [] }),
    async request(_method, url, options) {
      timeouts.push(options.timeoutMs);
      throw new Error(`Proxy request timed out after ${options.timeoutMs} ms: ${url}`);
    },
  };

  const failures = await runner.configureSecurity(state, session, { setPassword: true, enrollTotp: true });

  assert.equal(failures.length, 2);
  assert.equal(failures[0].code, 'PASSWORD_OTP_VALIDATE_TIMEOUT');
  assert.equal(failures[1].code, 'TOTP_SETUP_DEFERRED');
  assert.equal(state.security.passwordStatus, 'retry_pending');
  assert.equal(state.security.totpStatus, 'retry_pending');
  assert.equal(state.security.passwordTransaction.step, 'retry_pending');
  assert.deepEqual(timeouts, [30000]);
  assert.equal(events.some((event) => event.type === 'password_otp_validation_started'), true);
  assert.equal(events.some((event) => event.type === 'password_otp_validation_failed'), true);
  assert.equal(events.some((event) => event.type === 'password_setup_failed'), true);
  assert.equal(events.some((event) => event.type === 'totp_setup_deferred'), true);
});

test('proxy-bound Sentinel failure defers TOTP until the security context is rebuilt', async () => {
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    getEmailCode: async () => ({ code: 'A1B2C3' }),
  });
  const state = makeInitialChatGptSessionState({ email: 'security-proxy-rebind@example.test' });
  state.step = 'verified';
  state.status = 'valid';
  state.security.passwordTransaction = {
    step: 'otp_sent',
    emailBoundary: { capturedAt: '2026-08-06T00:00:00.000Z', messageIds: [] },
    password: 'Gpt-proxy-rebind-fixture!8a',
  };
  runner.sentinelHeaders = async () => {
    const error = new Error('Firefox client identity changed within the same runner at proxy');
    error.code = 'SENTINEL_PROXY_IDENTITY_CHANGED';
    error.retryable = true;
    throw error;
  };
  let totpCalled = false;
  runner.enrollTotp = async () => { totpCalled = true; };
  runner.checkpoint = async () => {};

  const failures = await runner.configureSecurity(state, {}, { setPassword: true, enrollTotp: true });

  assert.equal(failures[0].code, 'SENTINEL_PROXY_IDENTITY_CHANGED');
  assert.equal(failures[1].code, 'TOTP_SETUP_DEFERRED');
  assert.equal(state.security.passwordStatus, 'retry_pending');
  assert.equal(state.security.totpStatus, 'retry_pending');
  assert.equal(totpCalled, false);
});

for (const scenario of [
  { name: 'stale session profile', sessionEmail: 'old@icloud.com', meEmail: 'new@example.test', accepted: true },
  { name: 'stale backend profile', sessionEmail: 'new@example.test', meEmail: 'old@icloud.com', accepted: true },
  { name: 'unrelated email', sessionEmail: 'other@example.test', meEmail: 'new@example.test' },
  { name: 'only old email', sessionEmail: 'old@icloud.com', meEmail: 'old@icloud.com' },
  { name: 'different account', sessionEmail: 'old@icloud.com', meEmail: 'new@example.test', observedId: 'wrong-account' },
  { name: 'missing account ID', sessionEmail: 'old@icloud.com', meEmail: 'new@example.test', observedId: '' },
  { name: 'ordinary refresh', sessionEmail: 'old@icloud.com', meEmail: 'new@example.test', confirmed: false },
]) {
  test(`confirmed email-change identity verification handles ${scenario.name}`, async () => {
    const accountId = 'same-account';
    const observedId = scenario.observedId ?? accountId;
    const state = makeInitialChatGptSessionState({ email: 'new@example.test' });
    state.step = 'auth_completed';
    // Fresh-login fallback has no accountId on the state; the confirmed asset
    // transition must still carry the immutable identity into verification.
    const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
      confirmedEmailChange: scenario.confirmed === false ? undefined : {
        previousEmail: 'old@icloud.com', email: state.email, accountId,
      },
      executor: async (request) => {
        const route = new URL(request.url).pathname;
        if (route === '/api/auth/session') return result({ accessToken: 'fixture-token', user: { email: scenario.sessionEmail }, account: { id: observedId } });
        if (route === '/backend-api/me') return result({ email: scenario.meEmail, account_id: observedId });
        throw new Error(`Unexpected verification request: ${route}`);
      },
    });
    if (scenario.accepted) {
      await runner.run(state, { skipUsageMetadata: true });
      assert.equal(state.status, 'valid');
      assert.equal(state.email, 'new@example.test');
      assert.equal(state.accountId, accountId);
      assert.equal(state.events.at(-1).rebindIdentityReconciled, true);
      assert.equal(state.session.user.email, scenario.sessionEmail, 'server evidence must remain unmodified');
    } else {
      await assert.rejects(runner.run(state, { skipUsageMetadata: true }), (error) => {
        assert.ok(['SESSION_IDENTITY_MISMATCH', 'SESSION_ACCOUNT_UNVERIFIED'].includes(error.code));
        assert.equal(error.diagnostics.expectedEmail, state.email);
        assert.equal(JSON.stringify(error.diagnostics).includes('fixture-token'), false);
        return true;
      });
      assert.notEqual(state.status, 'valid');
      assert.equal(state.accessToken, undefined);
    }
  });
}

test('TLS security transport failures are retryable but definitive MFA results are not', async () => {
  assert.equal(retryableSecurityError({
    code: 'ERR_SSL_PACKET_LENGTH_TOO_LONG',
    message: 'tls_get_more_records: packet length too long',
  }), true);
  assert.equal(retryableSecurityError({
    code: 'MFA_ALREADY_ENABLED',
    retryable: true,
  }), false);

  const makeState = (email) => {
    const state = makeInitialChatGptSessionState({ email });
    state.step = 'verified';
    state.status = 'valid';
    return state;
  };
  const session = { serializeCookies: () => ({ version: 1, cookies: [] }) };

  const transportRunner = new ChatGptSessionRunner({ log: { entries: [] } }, {});
  transportRunner.checkpoint = async () => {};
  transportRunner.enrollTotp = async () => {
    throw Object.assign(new Error('tls_get_more_records: packet length too long'), {
      code: 'ERR_SSL_PACKET_LENGTH_TOO_LONG',
    });
  };
  const transportState = makeState('tls-security@example.test');
  await transportRunner.configureSecurity(transportState, session, { enrollTotp: true });
  assert.equal(transportState.security.totpStatus, 'retry_pending');

  const definitiveRunner = new ChatGptSessionRunner({ log: { entries: [] } }, {});
  definitiveRunner.checkpoint = async () => {};
  definitiveRunner.enrollTotp = async () => {
    throw Object.assign(new Error('MFA is already enabled'), { code: 'MFA_ALREADY_ENABLED' });
  };
  const definitiveState = makeState('mfa-already-enabled@example.test');
  await definitiveRunner.configureSecurity(definitiveState, session, { enrollTotp: true });
  assert.equal(definitiveState.security.totpStatus, 'failed');
});

test('one ChatGPT session runner reuses its Sentinel runtime and releases it', async () => {
  const { har } = loadHar();
  const challenge = {
    token: 'cache-challenge',
    proofofwork: { required: false },
    turnstile: { required: false },
    so: { required: false },
  };
  const did = 'sentinel-cache-did';
  const sdk = {
    url: 'https://sentinel.openai.com/sentinel/test/sdk.js',
    source: [
      'globalThis.SentinelSDK = {',
      '  init() {',
      '    const frame = document.createElement(\"iframe\");',
      '    document.body.appendChild(frame);',
      '    frame.contentWindow.postMessage({ p: \"requirements-proof\" }, \"*\");',
      '  },',
      '  token(flow) {',
      '    return JSON.stringify({ p: \"proof\", c: \"cache-challenge\", id: \"sentinel-cache-did\", flow });',
      '  },',
      '};',
    ].join('\n'),
  };
  const state = makeInitialChatGptSessionState({ email: 'sentinel-cache@example.test', oaiDid: did });
  const session = {
    cookieJar: state.cookieJar,
    serializeCookies: () => state.cookieJar,
    async executeRequest(request) {
      return {
        request,
        response: {
          status: 200,
          url: request.url,
          location: '',
          contentType: 'application/json',
          text: JSON.stringify(challenge),
        },
        cookies: { ...state.cookies },
      };
    },
  };
  const runner = new ChatGptSessionRunner(har, {
    proxy: 'http://proxy.example.test:8080',
    sentinelSdkSource: sdk.source,
    sentinelSdkUrl: sdk.url,
    liveSentinelSdk: false,
    sentinelBehaviorDurationMs: 0,
  });

  await runner.sentinelHeaders(state, session, 'oauth_create_account');
  const runtime = runner.sentinelRuntime;
  assert.ok(runtime);
  await runner.sentinelHeaders(state, session, 'oauth_create_account');
  assert.strictEqual(runner.sentinelRuntime, runtime);

  runner.dispose();
  assert.equal(runner.sentinelRuntime, null);
  assert.equal(runner.sentinelRuntimeKey, '');
});

test('a reusable Sentinel runtime loads the live SDK through the current session executor', async () => {
  clearSentinelSdkCache();
  const { har } = loadHar();
  const challenge = {
    token: 'live-sdk-challenge',
    proofofwork: { required: false },
    turnstile: { required: false },
    so: { required: false },
  };
  const did = 'live-sdk-did';
  const sdkUrl = 'https://sentinel.openai.com/sentinel/live-test/sdk.js';
  const sdkSource = [
    'globalThis.SentinelSDK = {',
    '  init() {',
    '    const frame = document.createElement("iframe");',
    '    document.body.appendChild(frame);',
    '    frame.contentWindow.postMessage({ p: "live-proof" }, "*");',
    '  },',
    '  token(flow) {',
    '    return JSON.stringify({ p: "proof", c: "live-sdk-challenge", id: "live-sdk-did", flow });',
    '  },',
    '};',
  ].join('\n');
  const state = makeInitialChatGptSessionState({ email: 'live-sdk@example.test', oaiDid: did });
  const sdkRequests = [];
  const session = {
    cookieJar: state.cookieJar,
    serializeCookies: () => state.cookieJar,
    async executeRequest(request) {
      const isBootstrap = request.url.endsWith('/backend-api/sentinel/sdk.js');
      const isSdkSource = request.url.endsWith('/sentinel/live-test/sdk.js');
      if (isBootstrap || isSdkSource) {
        sdkRequests.push(request.url);
        return {
          request,
          response: {
            status: 200,
            url: request.url,
            location: '',
            contentType: 'application/javascript',
            text: isBootstrap ? `const sdk = "${sdkUrl}";` : sdkSource,
          },
          cookies: { ...state.cookies },
        };
      }
      return {
        request,
        response: {
          status: 200,
          url: request.url,
          location: '',
          contentType: 'application/json',
          text: JSON.stringify(challenge),
        },
        cookies: { ...state.cookies },
      };
    },
  };
  const runner = new ChatGptSessionRunner(har, {
    proxy: 'http://proxy.live-sdk.test:8080',
    liveSentinelSdk: true,
    sentinelSdkCacheTtlMs: 0,
    sentinelBehaviorDurationMs: 0,
  });

  await runner.sentinelHeaders(state, session, 'oauth_create_account');

  assert.equal(state.sentinelSdk.origin, 'live');
  assert.equal(sdkRequests.some((url) => url.endsWith('/backend-api/sentinel/sdk.js')), true);
  assert.equal(sdkRequests.some((url) => url.endsWith('/sentinel/live-test/sdk.js')), true);
  runner.dispose();
  clearSentinelSdkCache();
});

test('Sentinel prewarm uses an isolated cookie jar and hands its runtime to identity submission', async () => {
  clearSentinelSdkCache();
  const { har } = loadHar();
  const sdkUrl = 'https://sentinel.openai.com/sentinel/prewarm-test/sdk.js';
  const sdkSource = [
    'globalThis.SentinelSDK = {',
    '  init() {',
    '    const frame = document.createElement("iframe");',
    '    document.body.appendChild(frame);',
    '  },',
    '  token(flow) {',
    '    return JSON.stringify({ p: "proof", c: "challenge", id: "prewarm-did", flow });',
    '  },',
    '};',
  ].join('\n');
  const state = makeInitialChatGptSessionState({ email: 'prewarm-isolation@example.test', oaiDid: 'prewarm-did' });
  const sdkRequests = [];
  const executor = async (request) => {
    const isBootstrap = request.url.endsWith('/backend-api/sentinel/sdk.js');
    const isSdkSource = request.url.endsWith('/sentinel/prewarm-test/sdk.js');
    if (isBootstrap || isSdkSource) sdkRequests.push(request.url);
    return {
      request,
      response: {
        status: 200,
        url: request.url,
        location: '',
        contentType: isBootstrap || isSdkSource ? 'application/javascript' : 'application/json',
        text: isBootstrap ? `const sdk = "${sdkUrl}";` : (isSdkSource ? sdkSource : '{}'),
      },
      cookies: { 'oai-did': 'foreign-did', 'sentinel-prewarm': '1' },
    };
  };
  const session = new UrlSession({
    cookieJar: state.cookieJar,
    clientProfile: state.clientProfile,
    proxy: 'http://proxy.prewarm.test:8080',
    executor,
  });
  const runner = new ChatGptSessionRunner(har, {
    prewarmSentinelSdk: true,
    dynamicSentinel: true,
    liveSentinelSdk: true,
    proxy: 'http://proxy.prewarm.test:8080',
    sentinelBehaviorDurationMs: 0,
  });

  await runner.prewarmSentinelRuntime(state, session, 'authorize_continue');
  assert.deepEqual(sdkRequests, [
    'https://sentinel.openai.com/backend-api/sentinel/sdk.js',
    sdkUrl,
  ]);
  assert.equal(state.cookies['oai-did'], state.oaiDid, 'SDK cookies must not replace the auth device cookie');
  const runtime = await runner.getSentinelRuntime(state, 'authorize_continue');
  assert.strictEqual(runner.sentinelRuntime, runtime);
  runner.dispose();
  clearSentinelSdkCache();
});

test('request timing records operation and path without query values', async () => {
  const timings = [];
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    traceAuthRequests: true,
    onRequest: async (record) => timings.push(record),
  });
  const session = {
    async request() { return result({ ok: true }, { url: 'https://chatgpt.com/api/auth/signin/openai' }); },
  };

  await runner.request(
    session,
    'chatgpt_signin',
    'POST',
    'https://chatgpt.com/api/auth/signin/openai?login_hint=private@example.test&state=secret-state',
  );

  assert.equal(timings.length, 1);
  assert.equal(timings[0].operation, 'chatgpt_signin');
  assert.equal(timings[0].host, 'chatgpt.com');
  assert.equal(timings[0].path, '/api/auth/signin/openai');
  assert.doesNotMatch(JSON.stringify(timings[0]), /private@example\.test|secret-state|login_hint/);
});

test('bounds primary auth requests without overriding an explicit request timeout', async () => {
  const timeouts = [];
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, { authRequestTimeoutMs: 30000 });
  const session = {
    async request(_method, _url, options) {
      timeouts.push(options.timeoutMs);
      return result({ ok: true });
    },
  };

  await runner.request(session, 'chatgpt_home', 'GET', 'https://chatgpt.com/');
  await runner.request(session, 'chatgpt_csrf', 'GET', 'https://chatgpt.com/api/auth/csrf', { timeoutMs: 7000 });

  assert.deepEqual(timeouts, [30000, 7000]);
});

test('normal NextAuth bootstrap always loads the home document before CSRF', async () => {
  const calls = [];
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {});
  runner.request = async (_session, operation) => {
    calls.push(operation);
    return operation === 'chatgpt_csrf'
      ? result({ csrfToken: 'csrf-after-home' })
      : result({});
  };

  const token = await runner.nextAuthContext({});

  assert.equal(token, 'csrf-after-home');
  assert.deepEqual(calls, ['chatgpt_home', 'chatgpt_csrf']);
});

test('reuses an unchanged NextAuth CSRF context inside one authorization transaction', async () => {
  const calls = [];
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {});
  runner.request = async (_session, operation) => {
    calls.push(operation);
    return operation === 'chatgpt_csrf' ? result({ csrfToken: 'cached-csrf' }) : result({});
  };
  const session = {};

  assert.equal(await runner.nextAuthContext(session), 'cached-csrf');
  assert.equal(await runner.nextAuthContext(session), 'cached-csrf');
  assert.deepEqual(calls, ['chatgpt_home', 'chatgpt_csrf']);
});

test('starts Sentinel prewarm before the NextAuth sign-in request', async () => {
  const order = [];
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {});
  runner.nextAuthContext = async () => {
    order.push('csrf');
    return 'csrf-token';
  };
  runner.prewarmSentinelRuntime = async () => {
    order.push('sentinel_prewarm');
  };
  runner.openAiSignIn = async () => {
    order.push('signin');
    return {
      authorizeUrl: 'https://auth.openai.com/api/accounts/authorize',
      landedUrl: 'https://auth.openai.com/log-in',
    };
  };

  await runner.nextAuthAuthorize(
    makeInitialChatGptSessionState({ email: 'prewarm@example.test' }),
    {},
  );
  assert.deepEqual(order, ['csrf', 'sentinel_prewarm', 'signin']);
});

test('NextAuth bootstrap reports a missing CSRF token after the home document', async () => {
  const calls = [];
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {});
  runner.request = async (_session, operation) => {
    calls.push(operation);
    return result({});
  };

  await assert.rejects(
    runner.nextAuthContext({}),
    (error) => error.code === 'NEXTAUTH_CSRF_INITIALIZATION_FAILED' && error.retryable === true,
  );
  assert.deepEqual(calls, ['chatgpt_home', 'chatgpt_csrf']);
});

test('NextAuth rejects a CSRF sign-in landing instead of entering authorize_continue', async () => {
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {});
  runner.request = async (_session, operation) => operation === 'chatgpt_signin'
    ? result({ url: 'https://auth.openai.com/authorize?state=fixture' })
    : result({}, { url: 'https://auth.openai.com/api/auth/signin?csrf' });

  await assert.rejects(
    runner.openAiSignIn(
      {},
      {},
      'csrf-fixture',
      { login_hint: 'fixture@example.test' },
    ),
    (error) => error.code === 'NEXTAUTH_CSRF_INITIALIZATION_FAILED'
      && error.status === 409
      && error.retryable === true,
  );
});

test('security-only retry can reuse a verified checkpoint and restore valid status', async () => {
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {});
  const state = makeInitialChatGptSessionState({ email: 'security-retry@example.test' });
  state.step = 'verified';
  state.status = 'partial';
  state.accessToken = 'saved-access-token';
  state.security.passwordStatus = 'retry_pending';
  let verifies = 0;
  let securityRuns = 0;
  runner.verify = async () => { verifies += 1; };
  runner.configureSecurity = async (current) => {
    securityRuns += 1;
    current.security.passwordStatus = 'configured';
    current.security.passwordTransaction = { step: 'complete' };
    current.security.failures = [];
    return [];
  };

  await runner.run(state, {
    security: { setPassword: true, enrollTotp: false },
    skipVerifiedSessionRefresh: true,
  });

  assert.equal(verifies, 0);
  assert.equal(securityRuns, 1);
  assert.equal(state.status, 'valid');
});

test('password security recovery starts a fresh transaction after a retry checkpoint', async () => {
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {});
  const state = makeInitialChatGptSessionState({ email: 'fresh-security-recovery@example.test' });
  state.step = 'verified';
  state.status = 'partial';
  state.security.passwordStatus = 'retry_pending';
  state.security.passwordTransaction = {
    step: 'retry_pending',
    emailBoundary: { capturedAt: '2026-08-01T00:00:00.000Z', messageIds: ['stale-message'] },
    authorizeUrl: 'https://auth.openai.com/authorize?stale=1',
  };
  const checkpoints = [];
  let beganFresh = false;
  runner.securityCheckpoint = async (_state, _session, type) => checkpoints.push(type);
  runner.beginPasswordSetup = async (current) => {
    beganFresh = true;
    assert.equal(current.security.passwordTransaction, null);
    assert.equal(current.security.passwordStatus, 'not_started');
    current.security.passwordTransaction = { step: 'complete' };
    current.security.passwordStatus = 'configured';
    current.password = 'Gpt-fresh-recovery!8a';
  };
  runner.completePasswordSetup = async () => {};

  await runner.configurePassword(state, {});

  assert.equal(beganFresh, true);
  assert.deepEqual(checkpoints, ['password_setup_retry_started']);
  assert.equal(state.security.passwordStatus, 'configured');
});

test('phone_recently_used retries create_account with fresh Sentinel on the same session', async () => {
  const waits = [];
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    wait: async (ms) => waits.push(ms),
    name: 'Fixture',
    birthdate: '2000-01-01',
  });
  const state = makeInitialChatGptSessionState({ email: 'continuity@example.test' });
  state.step = 'email_otp_validated';
  state.authPayload = { page: { type: 'about_you' }, continue_url: 'https://auth.openai.com/about-you' };
  let sentinelCalls = 0;
  let createCalls = 0;
  const checkpoints = [];
  runner.sentinelHeaders = async () => {
    sentinelCalls += 1;
    return { 'openai-sentinel-token': `sentinel-${sentinelCalls}` };
  };
  runner.request = async (_session, operation) => {
    assert.equal(operation, 'create_account');
    createCalls += 1;
    if (createCalls <= 3) throw Object.assign(new Error('phone recently used'), { code: 'PHONE_RECENTLY_USED' });
    return result({ continue_url: '' });
  };
  runner.checkpoint = async (_state, _session, type, details) => checkpoints.push({ type, details });
  runner.followContinuation = async () => {};

  await runner.completeAccount(state, {});

  assert.equal(createCalls, 4);
  assert.equal(sentinelCalls, 4);
  assert.deepEqual(waits, [2000, 5000, 10000]);
  assert.deepEqual(checkpoints.map((item) => item.type), ['create_account_retry', 'create_account_retry', 'create_account_retry', 'account_created']);
  assert.equal(state.accountCreated, true);
  assert.equal(state.createAccountRetry, undefined);
});

test('exhausted phone_recently_used remains an explicit continuity checkpoint', async () => {
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, { wait: async () => {} });
  const state = makeInitialChatGptSessionState({ email: 'continuity-wait@example.test' });
  state.step = 'email_otp_validated';
  state.authPayload = { page: { type: 'about_you' }, continue_url: 'https://auth.openai.com/about-you' };
  runner.sentinelHeaders = async () => ({});
  runner.request = async () => { throw Object.assign(new Error('phone recently used'), { code: 'PHONE_RECENTLY_USED' }); };
  runner.checkpoint = async () => {};

  await assert.rejects(
    runner.completeAccount(state, {}),
    (error) => error.code === 'PHONE_RECENTLY_USED' && error.retryable === true && error.waitPhase === 'waiting_phone_continuity',
  );
  assert.equal(state.createAccountRetry.exhausted, true);
  assert.equal(state.createAccountRetry.attempts, 3);
});

test('a saved password logs in directly instead of asking for a mailbox code', async () => {
  const checkpoints = [];
  const requests = [];
  const sentinelFlows = [];
  let boundaryCalls = 0;
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    // Deliberately present: the point of this test is that a runner which
    // *could* read a mailbox still does not, because a password is available.
    getEmailCode: async () => { throw new Error('the password path must not read a mailbox'); },
    beforeEmailSend: async () => {
      boundaryCalls += 1;
      return { capturedAt: '2026-08-16T00:00:00.000Z', messageIds: [] };
    },
    checkpoint: async (reason) => checkpoints.push(reason),
  });
  runner.sentinelHeaders = async (_state, _session, flow) => {
    sentinelFlows.push(flow);
    return { 'openai-sentinel-token': 'sentinel-login-password' };
  };
  runner.request = async (_session, operation, method, url, options) => {
    requests.push({ operation, method, url, options });
    return result({
      continue_url: 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent',
      page: { type: 'sign_in_with_chatgpt_codex_consent' },
    }, { url });
  };
  let followed = 0;
  runner.followContinuation = async (current) => {
    followed += 1;
    current.step = 'auth_completed';
  };

  const state = makeInitialChatGptSessionState({
    email: 'secured@example.test',
    password: 'Gpt-Secured!8a',
    totpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
  });
  state.step = 'identity_submitted';
  state.authPayload = {
    continue_url: 'https://auth.openai.com/log-in/password',
    page: { type: 'login_password' },
  };

  await runner.sendEmailOtp(state, { serializeCookies: () => state.cookieJar }, { existingOnly: true });

  assert.deepEqual(requests.map((entry) => entry.operation), ['password_verify']);
  assert.equal(new URL(requests[0].url).pathname, '/api/accounts/password/verify');
  assert.deepEqual(requests[0].options.json, { password: 'Gpt-Secured!8a' });
  assert.deepEqual(sentinelFlows, ['password_verify']);
  assert.equal(followed, 1);
  assert.equal(state.existingAccount, true);
  assert.equal(state.step, 'auth_completed');
  assert.equal(boundaryCalls, 0);
  assert.equal(state.emailBoundary, null);
  // `email_otp_sent` would park the job on a poll it can never satisfy.
  assert.equal(checkpoints.includes('email_otp_sent'), false);
  assert.equal(checkpoints.includes('password_verified'), true);
});

test('an existing-account verification-code page opens the saved password fallback first', async () => {
  const checkpoints = [];
  const requests = [];
  let boundaryCalls = 0;
  let followed = 0;
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    beforeEmailSend: async () => {
      boundaryCalls += 1;
      throw new Error('the saved-password path must not read a mailbox');
    },
    checkpoint: async (reason) => checkpoints.push(reason),
  });
  runner.sentinelHeaders = async () => ({ 'openai-sentinel-token': 'sentinel-password-fallback' });
  runner.request = async (_session, operation, method, url, options) => {
    requests.push({ operation, method, url, options });
    if (operation === 'login_password_page') return result({}, { url });
    return result({
      continue_url: 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent',
      page: { type: 'sign_in_with_chatgpt_codex_consent' },
    }, { url });
  };
  runner.followContinuation = async (state) => {
    followed += 1;
    state.step = 'auth_completed';
  };

  const state = makeInitialChatGptSessionState({
    email: 'code-screen@example.test',
    password: 'Gpt-Secured!8a',
    totpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
  });
  state.step = 'identity_submitted';
  state.authPayload = {
    continue_url: 'https://auth.openai.com/email-verification',
    page: { type: 'email_otp_verification' },
  };

  await runner.sendEmailOtp(state, { serializeCookies: () => state.cookieJar }, { existingOnly: true });

  assert.deepEqual(requests.map((entry) => entry.operation), ['login_password_page', 'password_verify']);
  assert.equal(requests[0].method, 'GET');
  assert.equal(new URL(requests[0].url).pathname, '/log-in/password');
  assert.deepEqual(requests[1].options.json, { password: 'Gpt-Secured!8a' });
  assert.equal(followed, 1);
  assert.equal(boundaryCalls, 0);
  assert.equal(state.existingAccount, true);
  assert.equal(state.step, 'auth_completed');
  assert.equal(state.passwordLoginAttempted, true);
  assert.equal(checkpoints.includes('login_password_page'), true);
  assert.equal(checkpoints.includes('email_otp_sent'), false);
});

test('a password-connection authorize that lands on the code screen still takes the password detour', async () => {
  const requests = [];
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    beforeEmailSend: async () => { throw new Error('the saved-password path must not read a mailbox'); },
    checkpoint: async () => {},
  });
  runner.sentinelHeaders = async () => ({ 'openai-sentinel-token': 'sentinel-password-connection' });
  runner.request = async (_session, operation, _method, url, options) => {
    requests.push({ operation, url, options });
    if (operation === 'login_password_page') return result({}, { url });
    return result({
      continue_url: 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent',
      page: { type: 'sign_in_with_chatgpt_codex_consent' },
    }, { url });
  };
  runner.followContinuation = async (state) => { state.step = 'auth_completed'; };

  const state = makeInitialChatGptSessionState({
    email: 'credentials@example.test',
    password: 'Gpt-Credentials!8a',
    totpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
  });
  // Observed 2026-10-13: `connection=password` was requested, yet
  // authorize/continue answered with the email-code page.
  state.passwordAuthorizeAttempted = true;
  state.step = 'identity_submitted';
  state.authPayload = {
    continue_url: 'https://auth.openai.com/email-verification',
    page: { type: 'email_otp_verification' },
  };

  await runner.sendEmailOtp(state, { serializeCookies: () => state.cookieJar }, { existingOnly: true });

  assert.deepEqual(requests.map((entry) => entry.operation), ['login_password_page', 'password_verify']);
  assert.deepEqual(requests[1].options.json, { password: 'Gpt-Credentials!8a' });
  assert.equal(state.step, 'auth_completed');
  assert.equal(requests.some((entry) => entry.operation === 'passwordless_send_otp'), false);
});

test('a password already submitted is not submitted again from the code screen', async () => {
  const requests = [];
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    beforeEmailSend: async () => ({ capturedAt: '2026-10-13T00:00:00.000Z', messageIds: [] }),
    getEmailCode: async () => '123456',
    checkpoint: async () => {},
  });
  runner.sentinelHeaders = async () => ({});
  runner.request = async (_session, operation, _method, url) => {
    requests.push(operation);
    return result({}, { url });
  };
  const state = makeInitialChatGptSessionState({ email: 'once@example.test', password: 'Gpt-Once!8a' });
  state.passwordLoginAttempted = true;
  state.step = 'identity_submitted';
  state.authPayload = { continue_url: 'https://auth.openai.com/email-verification', page: { type: 'email_otp_verification' } };

  await runner.sendEmailOtp(state, { serializeCookies: () => state.cookieJar }, { existingOnly: true });

  assert.equal(requests.includes('login_password_page'), false);
  assert.equal(requests.includes('password_verify'), false);
  assert.equal(requests.includes('passwordless_send_otp'), true);
});

test('a run with no mailbox never sends an email code and names a required password reset', async () => {
  const requests = [];
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, { mailboxAvailable: false, checkpoint: async () => {} });
  runner.sentinelHeaders = async () => ({});
  runner.request = async (_session, operation, _method, url) => {
    requests.push(operation);
    if (operation === 'login_password_page') return result({}, { url });
    if (operation === 'password_verify') {
      const error = new Error('password_verify failed with HTTP 401');
      error.status = 401;
      error.code = 'PASSWORD_RESET_REQUIRED';
      throw error;
    }
    return result({}, { url });
  };
  const state = makeInitialChatGptSessionState({ email: 'reset@example.test', password: 'Gpt-Reset!8a' });
  state.step = 'identity_submitted';
  state.authPayload = { continue_url: 'https://auth.openai.com/email-verification', page: { type: 'email_otp_verification' } };

  await assert.rejects(
    runner.sendEmailOtp(state, { serializeCookies: () => state.cookieJar }, { existingOnly: true }),
    (error) => error.code === 'PASSWORD_RESET_REQUIRED' && error.retryable === false,
  );
  assert.deepEqual(requests, ['login_password_page', 'password_verify']);
  assert.equal(state.step, 'identity_submitted');
});

test('a run with no mailbox and no password stops before sending a code', async () => {
  const requests = [];
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, { mailboxAvailable: false, checkpoint: async () => {} });
  runner.request = async (_session, operation, _method, url) => { requests.push(operation); return result({}, { url }); };
  const state = makeInitialChatGptSessionState({ email: 'nomail@example.test' });
  state.step = 'identity_submitted';
  state.authPayload = { continue_url: 'https://auth.openai.com/email-verification', page: { type: 'email_otp_verification' } };

  await assert.rejects(
    runner.sendEmailOtp(state, { serializeCookies: () => state.cookieJar }, { existingOnly: true }),
    (error) => error.code === 'EMAIL_OTP_MAILBOX_UNAVAILABLE',
  );
  assert.equal(requests.includes('passwordless_send_otp'), false);
});

test('password fallback does not send the email OTP twice when password verification asks for email confirmation', async () => {
  const requests = [];
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    beforeEmailSend: async () => ({ capturedAt: '2026-08-16T00:00:00.000Z', messageIds: [] }),
    getEmailCode: async () => ({ code: 'A1B2C3' }),
    checkpoint: async () => {},
  });
  runner.sentinelHeaders = async () => ({});
  runner.request = async (_session, operation, method, url, options) => {
    requests.push({ operation, method, url, options });
    if (operation === 'login_password_page') return result({}, { url });
    if (operation === 'password_verify') {
      return result({
        continue_url: 'https://auth.openai.com/email-verification',
        page: { type: 'email_otp_verification' },
      }, { url });
    }
    if (operation === 'email_otp_send') return result({}, { url });
    throw new Error(`unexpected duplicate authentication request: ${operation}`);
  };

  const state = makeInitialChatGptSessionState({
    email: 'password-email-confirm@example.test',
    password: 'Gpt-Secured!8a',
  });
  state.step = 'identity_submitted';
  state.authPayload = {
    continue_url: 'https://auth.openai.com/email-verification',
    page: { type: 'email_otp_verification' },
  };

  await runner.sendEmailOtp(state, { serializeCookies: () => state.cookieJar }, { existingOnly: true });

  assert.deepEqual(requests.map((entry) => entry.operation), [
    'login_password_page',
    'password_verify',
    'email_otp_send',
  ]);
  assert.equal(state.step, 'email_otp_sent');
});

test('a rejected password on the verification-code page falls back to passwordless OTP once', async () => {
  const requests = [];
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    beforeEmailSend: async () => ({ capturedAt: '2026-08-16T00:00:00.000Z', messageIds: [] }),
    checkpoint: async () => {},
  });
  runner.sentinelHeaders = async () => ({});
  runner.request = async (_session, operation, method, url, options) => {
    requests.push({ operation, method, url, options });
    if (operation === 'login_password_page') return result({}, { url });
    if (operation === 'password_verify') throw Object.assign(new Error('password rejected'), { status: 401, code: 'INVALID_PASSWORD' });
    return result({ continue_url: 'https://auth.openai.com/email-verification' }, { url });
  };

  const state = makeInitialChatGptSessionState({ email: 'rejected-password@example.test', password: 'Gpt-Stale!8a' });
  state.step = 'identity_submitted';
  state.authPayload = {
    continue_url: 'https://auth.openai.com/email-verification',
    page: { type: 'email_otp_verification' },
  };

  await runner.sendEmailOtp(state, { serializeCookies: () => state.cookieJar }, { existingOnly: true });

  assert.deepEqual(requests.map((entry) => entry.operation), ['login_password_page', 'password_verify', 'passwordless_send_otp']);
  assert.equal(state.step, 'email_otp_sent');
  assert.equal(state.existingAccount, true);
});

test('preserves account deactivation instead of degrading it to an email OTP failure', async () => {
  const checkpoints = [];
  let boundaryCalls = 0;
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    beforeEmailSend: async () => {
      boundaryCalls += 1;
      return { capturedAt: '2026-08-16T00:00:00.000Z', messageIds: [] };
    },
    checkpoint: async (reason) => checkpoints.push(reason),
  });
  runner.sentinelHeaders = async () => ({});
  runner.request = async (_session, operation) => {
    assert.equal(operation, 'password_verify');
    const error = new Error('password verification rejected');
    error.code = 'ACCOUNT_DEACTIVATED';
    error.status = 403;
    throw error;
  };

  const state = makeInitialChatGptSessionState({
    email: 'deactivated@example.test',
    password: 'Gpt-Deactivated!8a',
    totpSecret: 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP',
  });
  state.step = 'identity_submitted';
  state.authPayload = {
    continue_url: 'https://auth.openai.com/log-in/password',
    page: { type: 'login_password' },
  };

  await assert.rejects(
    runner.sendEmailOtp(state, { serializeCookies: () => state.cookieJar }, { existingOnly: true }),
    (error) => error.code === 'ACCOUNT_DEACTIVATED' && error.status === 403 && error.retryable === false,
  );
  assert.equal(boundaryCalls, 0);
  assert.deepEqual(checkpoints, ['password_login_rejected']);
  assert.equal(state.emailBoundary, null);
});

test('a closed existing-account password detour falls back to one passwordless OTP', async () => {
  const requests = [];
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    beforeEmailSend: async () => ({ capturedAt: '2026-08-16T00:00:00.000Z', messageIds: [] }),
    checkpoint: async () => {},
  });
  runner.request = async (_session, operation, method, url, options) => {
    requests.push({ operation, method, url, options });
    if (operation === 'login_password_page') {
      throw Object.assign(new Error('password detour closed'), { status: 400, code: 'INVALID_AUTH_STEP' });
    }
    return result({}, { url });
  };

  const state = makeInitialChatGptSessionState({
    email: 'closed-password-detour@example.test',
    password: 'Gpt-Secured!8a',
  });
  state.step = 'identity_submitted';
  state.authPayload = {
    continue_url: 'https://auth.openai.com/email-verification',
    page: { type: 'email_otp_verification' },
  };

  await runner.sendEmailOtp(state, { serializeCookies: () => state.cookieJar }, { existingOnly: true });

  assert.deepEqual(requests.map((entry) => entry.operation), [
    'login_password_page',
    'passwordless_send_otp',
  ]);
  assert.equal(state.step, 'email_otp_sent');
});

test('an account with no saved password still falls back to the passwordless OTP', async () => {
  const requests = [];
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    beforeEmailSend: async () => ({ capturedAt: '2026-08-16T00:00:00.000Z', messageIds: [] }),
    checkpoint: async () => {},
  });
  runner.request = async (_session, operation, method, url, options) => {
    requests.push({ operation, method, url, options });
    return result({}, { url });
  };

  const state = makeInitialChatGptSessionState({ email: 'passwordless@example.test' });
  state.step = 'identity_submitted';
  state.emailBoundary = { capturedAt: '2026-08-16T00:00:00.000Z', messageIds: [] };
  state.authPayload = {
    continue_url: 'https://auth.openai.com/log-in/password',
    page: { type: 'login_password' },
  };

  await runner.sendEmailOtp(state, { serializeCookies: () => state.cookieJar }, { existingOnly: true });

  assert.deepEqual(requests.map((entry) => entry.operation), ['passwordless_send_otp']);
  assert.equal(state.step, 'email_otp_sent');
  assert.equal(state.existingAccount, true);
});

test('a credentials login refuses to hang when the server still wants an email code', async () => {
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, { checkpoint: async () => {} });
  runner.sentinelHeaders = async () => ({});
  runner.request = async (_session, _operation, _method, url) => result({
    continue_url: 'https://auth.openai.com/email-verification',
    page: { type: 'email_otp_verification' },
  }, { url });

  const state = makeInitialChatGptSessionState({
    email: 'no-mailbox@example.test',
    password: 'Gpt-NoMailbox!8a',
  });

  await assert.rejects(
    runner.verifyPassword(state, { serializeCookies: () => state.cookieJar }),
    (error) => error.code === 'PASSWORD_LOGIN_EMAIL_VERIFICATION_REQUIRED' && error.retryable === false,
  );
});

test('registration asks for the signup screen so the password is set during user/register', async () => {
  const bodies = [];
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    beforeEmailSend: async () => ({ capturedAt: '2026-08-16T00:00:00.000Z', messageIds: [] }),
    checkpoint: async () => {},
  });
  runner.sentinelHeaders = async () => ({});
  runner.request = async (_session, _operation, _method, url, options) => {
    bodies.push(options.json);
    return result({
      continue_url: 'https://auth.openai.com/create-account/password',
      page: { type: 'create_account_password' },
    }, { url });
  };

  const registration = makeInitialChatGptSessionState({ email: 'fresh@example.test' });
  await runner.submitIdentity(registration, { serializeCookies: () => registration.cookieJar }, {});
  // `login_or_signup` answers with `email_otp_verification`, which builds a
  // passwordless account and costs a second OTP later just to attach one.
  assert.equal(bodies[0].screen_hint, 'signup');
  assert.equal(registration.pageType, 'create_account_password');

  const login = makeInitialChatGptSessionState({ email: 'existing@example.test' });
  await runner.submitIdentity(login, { serializeCookies: () => login.cookieJar }, { existingOnly: true });
  assert.equal(Object.hasOwn(bodies[1], 'screen_hint'), false);
});

test('a signup takes the password detour off the verification-code screen', async () => {
  // The browser's "Continue with password" button is a link to
  // `/create-account/password`; the page behind it posts `user/register`. That
  // navigation is the only thing that sets a password inline — no `screen_hint`
  // combination reaches it, as live runs showed.
  const calls = [];
  const checkpoints = [];
  const boundaries = [];
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    beforeEmailSend: async (_email, _state, boundaryOptions) => {
      boundaries.push(boundaryOptions || {});
      return { capturedAt: '2026-08-16T00:00:00.000Z', messageIds: [] };
    },
    checkpoint: async (reason) => checkpoints.push(reason),
  });
  runner.sentinelHeaders = async () => ({ 'openai-sentinel-token': 'sentinel-register' });
  runner.request = async (_session, operation, method, url, options) => {
    calls.push({ operation, method, url, json: options?.json });
    if (operation === 'user_register') {
      return result({
        continue_url: 'https://auth.openai.com/api/accounts/email-otp/send',
        page: { type: 'email_otp_send' },
      }, { url });
    }
    return result({}, { url });
  };

  const state = makeInitialChatGptSessionState({ email: 'fresh@example.test' });
  state.step = 'identity_submitted';
  state.emailBoundary = { capturedAt: '2026-08-16T00:00:00.000Z', messageIds: [] };
  state.authPayload = {
    continue_url: 'https://auth.openai.com/email-verification',
    page: { type: 'email_otp_verification' },
  };

  await runner.sendEmailOtp(state, { serializeCookies: () => state.cookieJar }, {});

  const operations = calls.map((entry) => entry.operation);
  assert.deepEqual(operations, ['create_account_password_page', 'user_register', 'email_otp_send']);
  const register = calls.find((entry) => entry.operation === 'user_register');
  assert.equal(register.json.username, 'fresh@example.test');
  assert.equal(typeof register.json.password, 'string');
  assert.equal(register.json.password.length > 8, true);
  assert.equal(state.password, register.json.password);
  assert.equal(state.security.passwordStatus, 'configured');
  // Still exactly one code, and it is the registration's own.
  assert.equal(operations.filter((name) => name === 'email_otp_send').length, 1);
  assert.equal(state.step, 'email_otp_sent');
  assert.equal(Number.isFinite(Date.parse(state.emailOtpSentAt)), true);
  assert.equal(state.emailBoundary.sentAt, state.emailOtpSentAt);
  assert.equal(checkpoints.includes('password_set_during_registration'), true);
  // The boundary has to be the one taken after `user/register`, or the poll can
  // pick up a message the server sent while still steering towards passwordless.
  assert.equal(boundaries.at(-1)?.fresh, true);
  assert.equal(boundaries.at(-1)?.purpose, 'registration');
});

test('a mailbox failure after user/register is propagated without falling back or sending another code', async () => {
  const calls = [];
  let boundaryAvailable = false;
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    beforeEmailSend: async () => {
      if (!boundaryAvailable) {
        throw Object.assign(new Error('mail provider temporarily unavailable'), {
          code: 'EMAIL_PROVIDER_TIMEOUT',
          category: 'mail_transport',
          retryable: true,
        });
      }
      return { capturedAt: '2026-08-16T00:00:00.000Z', messageIds: [] };
    },
    checkpoint: async () => {},
  });
  runner.sentinelHeaders = async () => ({ 'openai-sentinel-token': 'sentinel-register' });
  runner.request = async (_session, operation, _method, url) => {
    calls.push(operation);
    if (operation === 'user_register') {
      return result({
        continue_url: 'https://auth.openai.com/api/accounts/email-otp/send',
        page: { type: 'email_otp_send' },
      }, { url });
    }
    return result({}, { url });
  };

  const state = makeInitialChatGptSessionState({ email: 'fresh@example.test' });
  state.step = 'identity_submitted';
  state.authPayload = {
    continue_url: 'https://auth.openai.com/email-verification',
    page: { type: 'email_otp_verification' },
  };

  await assert.rejects(
    runner.sendEmailOtp(state, { serializeCookies: () => state.cookieJar }, {}),
    (error) => error.code === 'EMAIL_PROVIDER_TIMEOUT',
  );
  assert.deepEqual(calls, ['create_account_password_page', 'user_register']);
  assert.equal(state.accountRegistered, true);

  boundaryAvailable = true;
  await runner.sendEmailOtp(state, { serializeCookies: () => state.cookieJar }, {});
  assert.deepEqual(calls, [
    'create_account_password_page',
    'user_register',
    'email_otp_send',
  ]);
});

test('uses the upstream server response time as the mailbox boundary when available', async () => {
  let requestStartedAt = 0;
  let requestFinishedAt = 0;
  const serverDate = new Date(Date.now() - 1000).toUTCString();
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    checkpoint: async () => {},
  });
  runner.useCreateAccountPassword = async () => false;
  runner.request = async (_session, operation, _method, url) => {
    if (operation === 'email_otp_send') {
      requestStartedAt = Date.now();
      const sendStartedAt = Date.parse(state.emailOtpSendStartedAt);
      assert.equal(Number.isFinite(sendStartedAt), true);
      assert.equal(sendStartedAt <= requestStartedAt, true);
      await new Promise((resolve) => setTimeout(resolve, 30));
      requestFinishedAt = Date.now();
    }
    return result({}, { url, serverDate });
  };

  const state = makeInitialChatGptSessionState({ email: 'delayed-send@example.test' });
  state.step = 'identity_submitted';
  state.emailBoundary = { capturedAt: '2026-08-16T00:00:00.000Z', messageIds: ['old-mail'] };
  state.authPayload = {
    continue_url: 'https://auth.openai.com/api/accounts/email-otp/send',
    page: { type: 'email_otp_verification' },
  };

  await runner.sendEmailOtp(state, { serializeCookies: () => state.cookieJar }, {});

  const sentAt = Date.parse(state.emailOtpSentAt);
  assert.equal(sentAt, Date.parse(serverDate));
  assert.equal(state.emailOtpSentAtSource, 'server_response_date');
  assert.equal(sentAt <= requestStartedAt, true);
  assert.equal(sentAt < requestFinishedAt, true);
  assert.equal(state.emailBoundary.sentAt, state.emailOtpSentAt);
  assert.equal(state.emailOtpSendStartedAt, '');
});

test('uses the send endpoint Date before a redirected verification page Date', async () => {
  const sendDate = new Date(Date.now() - 1000).toUTCString();
  const pageDate = new Date(Date.parse(sendDate) + 1000).toUTCString();
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    checkpoint: async () => {},
  });
  runner.useCreateAccountPassword = async () => false;
  runner.request = async (_session, operation, _method, url) => {
    if (operation !== 'email_otp_send') return result({}, { url });
    return result({}, {
      url: 'https://auth.openai.com/email-verification',
      serverDate: pageDate,
      history: [
        {
          url: 'https://auth.openai.com/api/accounts/email-otp/send',
          serverDate: sendDate,
        },
        {
          url: 'https://auth.openai.com/email-verification',
          serverDate: pageDate,
        },
      ],
    });
  };

  const state = makeInitialChatGptSessionState({ email: 'redirected-send@example.test' });
  state.step = 'identity_submitted';
  state.emailBoundary = { capturedAt: '2026-08-16T00:00:00.000Z', messageIds: [] };
  state.authPayload = {
    continue_url: 'https://auth.openai.com/api/accounts/email-otp/send',
    page: { type: 'email_otp_verification' },
  };

  await runner.sendEmailOtp(state, { serializeCookies: () => state.cookieJar }, {});

  assert.equal(state.emailOtpSentAt, new Date(Date.parse(sendDate)).toISOString());
  assert.equal(state.emailOtpSentAtSource, 'server_response_date');
});

test('a closed password detour degrades to the passwordless account, not a failure', async () => {
  const calls = [];
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    beforeEmailSend: async () => ({ capturedAt: '2026-08-16T00:00:00.000Z', messageIds: [] }),
    checkpoint: async () => {},
  });
  runner.sentinelHeaders = async () => ({});
  runner.request = async (_session, operation, _method, url) => {
    calls.push(operation);
    if (operation === 'user_register') {
      throw Object.assign(new Error('create account password is not available'), { code: 'BAD_REQUEST', status: 400 });
    }
    return result({}, { url });
  };

  const state = makeInitialChatGptSessionState({ email: 'fresh@example.test' });
  state.step = 'identity_submitted';
  state.emailBoundary = { capturedAt: '2026-08-16T00:00:00.000Z', messageIds: [] };
  state.authPayload = {
    continue_url: 'https://auth.openai.com/api/accounts/email-otp/send',
    page: { type: 'email_otp_verification' },
  };

  await runner.sendEmailOtp(state, { serializeCookies: () => state.cookieJar }, {});

  assert.equal(calls.includes('user_register'), true);
  assert.equal(calls.includes('email_otp_send'), true);
  assert.equal(state.step, 'email_otp_sent');
  assert.notEqual(state.security?.passwordStatus, 'configured');
});

test('an existing-account login never registers a new account behind the code screen', async () => {
  const calls = [];
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    beforeEmailSend: async () => ({ capturedAt: '2026-08-16T00:00:00.000Z', messageIds: [] }),
    checkpoint: async () => {},
  });
  runner.sentinelHeaders = async () => ({});
  runner.request = async (_session, operation, _method, url) => {
    calls.push(operation);
    return result({}, { url });
  };

  const state = makeInitialChatGptSessionState({ email: 'existing@example.test' });
  state.step = 'identity_submitted';
  state.emailBoundary = { capturedAt: '2026-08-16T00:00:00.000Z', messageIds: [] };
  state.authPayload = {
    continue_url: 'https://auth.openai.com/api/accounts/email-otp/send',
    page: { type: 'email_otp_verification' },
  };

  await runner.sendEmailOtp(state, { serializeCookies: () => state.cookieJar }, { existingOnly: true });

  assert.equal(calls.includes('user_register'), false);
  assert.equal(state.step, 'email_otp_sent');
});

test('the bootstrap checkpoint reports the hint asked for and the one the server kept', async () => {
  // These two disagreeing is the exact failure that made a registration cost a
  // second email OTP, and it was invisible in the run log for a whole batch.
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, { checkpoint: async () => {} });
  runner.nextAuthContext = async () => 'csrf-token';
  runner.openAiSignIn = async () => ({
    authorizeUrl: 'https://auth.openai.com/api/accounts/authorize?screen_hint=signup',
    landedUrl: 'https://auth.openai.com/log-in',
  });
  const payload = Buffer.from(JSON.stringify({ original_screen_hint: 'login_or_signup' })).toString('base64');
  const session = {
    serializeCookies: () => ({ cookies: [{ key: 'oai-client-auth-session', value: `${payload}.sig.mac` }] }),
  };

  const state = makeInitialChatGptSessionState({ email: 'fresh@example.test' });
  await runner.bootstrap(state, session, {});

  const entry = (state.events || []).find((event) => event.type === 'nextauth_ready');
  assert.equal(entry?.requestedScreenHint, 'signup');
  assert.equal(entry?.sessionScreenHint, 'login_or_signup');
});

test('a rejected email OTP gets one fresh code and a fresh mailbox boundary', async () => {
  const operations = [];
  const validatedCodes = [];
  const boundaryOptions = [];
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    beforeEmailSend: async (_email, _state, options) => {
      boundaryOptions.push(options);
      return { capturedAt: '2026-08-31T00:01:00.000Z', messageIds: ['fresh-boundary'] };
    },
    getEmailCode: async (_email, boundary) => ({
      code: boundary?.messageIds?.[0] === 'old-boundary' ? '111111' : '222222',
    }),
    checkpoint: async () => {},
  });
  runner.sentinelHeaders = async () => ({});
  runner.useCreateAccountPassword = async () => false;
  runner.bootstrap = async (state, _session, options) => {
    assert.equal(options.forceFreshEmailBoundary, true);
    state.step = 'identity_submitted';
    state.pageType = 'email_otp_verification';
    state.continueUrl = 'https://auth.openai.com/email-verification';
    state.authPayload = {
      continue_url: state.continueUrl,
      page: { type: 'email_otp_verification' },
    };
  };
  runner.request = async (_session, operation, _method, url, requestOptions = {}) => {
    operations.push(operation);
    if (operation === 'email_otp_send') return result({}, { url });
    if (operation === 'email_otp_validate') {
      validatedCodes.push(requestOptions.json.code);
      if (validatedCodes.length === 1) {
        throw Object.assign(new Error('verification code rejected'), {
          code: 'WRONG_EMAIL_OTP_CODE',
          status: 400,
        });
      }
      return result({
        continue_url: 'https://auth.openai.com/about-you',
        page: { type: 'about_you' },
      }, { url });
    }
    throw new Error(`Unexpected fixture request: ${operation}`);
  };
  runner.completeAccount = async (state) => {
    state.step = 'verified';
    state.status = 'valid';
  };

  const state = makeInitialChatGptSessionState({ email: 'wrong-code@example.test' });
  state.step = 'email_otp_sent';
  state.emailBoundary = { capturedAt: '2026-08-31T00:00:00.000Z', messageIds: ['old-boundary'] };
  state.authPayload = {
    continue_url: 'https://auth.openai.com/email-verification',
    page: { type: 'email_otp_verification' },
  };

  await runner.run(state);

  assert.deepEqual(validatedCodes, ['111111', '222222']);
  assert.deepEqual(operations, ['email_otp_validate', 'email_otp_send', 'email_otp_validate']);
  assert.equal(state.emailOtpValidationRetries, 1);
  assert.deepEqual(state.emailBoundary.messageIds, ['fresh-boundary']);
  assert.equal(boundaryOptions.length, 1);
  assert.equal(boundaryOptions[0].fresh, true);
  assert.equal(boundaryOptions[0].forceFresh, true);
});

test('an uncertain email send is reconciled before one fresh-code retry', async () => {
  const operations = [];
  const validatedCodes = [];
  const boundaryOptions = [];
  let sendAttempts = 0;
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    beforeEmailSend: async (_email, _state, options) => {
      boundaryOptions.push(options);
      return { capturedAt: '2026-08-31T00:02:00.000Z', messageIds: ['fresh-boundary'] };
    },
    getEmailCode: async (_email, boundary) => ({
      code: boundary?.messageIds?.[0] === 'old-boundary' ? '333333' : '444444',
    }),
    checkpoint: async () => {},
  });
  runner.sentinelHeaders = async () => ({});
  runner.useCreateAccountPassword = async () => false;
  runner.bootstrap = async (state, _session, options) => {
    assert.equal(options.forceFreshEmailBoundary, true);
    state.step = 'identity_submitted';
    state.pageType = 'email_otp_verification';
    state.continueUrl = 'https://auth.openai.com/email-verification';
    state.authPayload = {
      continue_url: state.continueUrl,
      page: { type: 'email_otp_verification' },
    };
  };
  runner.request = async (_session, operation, _method, url, requestOptions = {}) => {
    operations.push(operation);
    if (operation === 'email_otp_send') {
      sendAttempts += 1;
      if (sendAttempts === 1) throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      return result({}, { url });
    }
    if (operation === 'email_otp_validate') {
      validatedCodes.push(requestOptions.json.code);
      if (validatedCodes.length === 1) {
        throw Object.assign(new Error('stale code rejected'), {
          code: 'WRONG_EMAIL_OTP_CODE',
          status: 400,
        });
      }
      return result({
        continue_url: 'https://auth.openai.com/about-you',
        page: { type: 'about_you' },
      }, { url });
    }
    throw new Error(`Unexpected fixture request: ${operation}`);
  };
  runner.completeAccount = async () => {};

  const state = makeInitialChatGptSessionState({ email: 'uncertain-send@example.test' });
  state.step = 'identity_submitted';
  state.emailBoundary = { capturedAt: '2026-08-31T00:00:00.000Z', messageIds: ['old-boundary'] };
  state.authPayload = {
    continue_url: 'https://auth.openai.com/email-verification',
    page: { type: 'email_otp_verification' },
  };

  await assert.rejects(
    runner.sendEmailOtp(state, runner.session(state), {}),
    (error) => error.code === 'ECONNRESET' && error.emailOtpSendOutcomeUncertain === true,
  );
  assert.equal(state.emailOtpSendRecovery.status, 'uncertain');

  await runner.run(state);

  assert.deepEqual(validatedCodes, ['333333', '444444']);
  assert.deepEqual(operations, [
    'email_otp_send',
    'email_otp_validate',
    'email_otp_send',
    'email_otp_validate',
  ]);
  assert.equal(sendAttempts, 2);
  assert.equal(state.emailOtpSendRecovery, null);
  assert.equal(boundaryOptions.length, 1);
  assert.equal(boundaryOptions[0].forceFresh, true);
});

test('an uncertain account creation retries create_account without requesting another email OTP', async () => {
  const operations = [];
  let createAttempts = 0;
  let continuationFollows = 0;
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    checkpoint: async () => {},
  });
  runner.sentinelHeaders = async () => ({});
  runner.request = async (_session, operation, _method, url) => {
    operations.push(operation);
    if (operation !== 'create_account') throw new Error(`Unexpected fixture request: ${operation}`);
    createAttempts += 1;
    if (createAttempts === 1) throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
    return result({
      continue_url: 'https://chatgpt.com/api/auth/callback/openai?code=fixture&state=fixture',
      page: { type: 'external_url' },
    }, { url });
  };
  runner.followContinuation = async () => { continuationFollows += 1; };

  const state = makeInitialChatGptSessionState({ email: 'create-uncertain@example.test' });
  state.step = 'email_otp_validated';
  state.authPayload = {
    continue_url: 'https://auth.openai.com/about-you',
    page: { type: 'about_you' },
  };

  await assert.rejects(
    runner.completeAccount(state, runner.session(state), {}),
    (error) => error.code === 'ECONNRESET' && error.accountCreationUncertain === true,
  );
  assert.equal(state.createAccountAttempt.status, 'uncertain');
  assert.equal(state.step, 'email_otp_validated');

  await runner.completeAccount(state, runner.session(state), {});

  assert.deepEqual(operations, ['create_account', 'create_account']);
  assert.equal(state.accountCreated, true);
  assert.equal(state.createAccountAttempt, undefined);
  assert.equal(continuationFollows, 1);
});

test('a legacy email send checkpoint with retryUsed cannot spend another fresh-code retry', async () => {
  let mailboxReads = 0;
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    beforeEmailSend: async () => {
      throw new Error('a second fresh-code request must not be made');
    },
    getEmailCode: async () => {
      mailboxReads += 1;
      throw Object.assign(new Error('no code arrived'), {
        code: 'EMAIL_OTP_TIMEOUT',
      });
    },
    checkpoint: async () => {},
  });

  const state = makeInitialChatGptSessionState({ email: 'legacy-recovery@example.test' });
  state.step = 'identity_submitted';
  state.emailBoundary = { capturedAt: '2026-08-31T00:04:00.000Z', messageIds: ['old-boundary'] };
  state.authPayload = {
    continue_url: 'https://auth.openai.com/email-verification',
    page: { type: 'email_otp_verification' },
  };
  state.emailOtpSendRecovery = {
    status: 'uncertain',
    retryUsed: true,
    retryCount: 0,
  };

  await assert.rejects(
    runner.sendEmailOtp(state, runner.session(state), {}),
    (error) => error.code === 'EMAIL_OTP_SEND_RECOVERY_EXHAUSTED',
  );
  assert.equal(mailboxReads, 1);
  assert.equal(state.emailOtpSendRecovery.status, 'exhausted');
});

test('a rejected email OTP first tries the next queued code on the same page', async () => {
  const operations = [];
  const validatedCodes = [];
  const readOptions = [];
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    beforeEmailSend: async () => {
      throw new Error('the queued retry must not open a new mailbox boundary');
    },
    getEmailCode: async (_email, _boundary, _state, options = {}) => {
      readOptions.push(options);
      return { code: options.nextQueuedCode === true ? '222222' : '111111' };
    },
    checkpoint: async () => {},
  });
  runner.sentinelHeaders = async () => ({});
  runner.bootstrap = async () => {
    throw new Error('the queued retry must not restart the auth transaction');
  };
  runner.request = async (_session, operation, _method, url, requestOptions = {}) => {
    operations.push(operation);
    if (operation === 'email_otp_validate') {
      validatedCodes.push(requestOptions.json.code);
      if (validatedCodes.length === 1) {
        throw Object.assign(new Error('verification code rejected'), { code: 'WRONG_EMAIL_OTP_CODE', status: 401 });
      }
      return result({ continue_url: 'https://auth.openai.com/about-you', page: { type: 'about_you' } }, { url });
    }
    throw new Error(`Unexpected fixture request: ${operation}`);
  };
  runner.completeAccount = async (state) => {
    state.step = 'verified';
    state.status = 'valid';
  };

  const state = makeInitialChatGptSessionState({ email: 'queued-code@example.test' });
  state.step = 'email_otp_sent';
  state.emailOtpSentAt = '2026-10-11T02:25:52.650Z';
  state.emailBoundary = { capturedAt: '2026-10-11T02:25:50.000Z', messageIds: [] };
  state.authPayload = {
    continue_url: 'https://auth.openai.com/email-verification',
    page: { type: 'email_otp_verification' },
  };

  await runner.run(state);

  assert.deepEqual(validatedCodes, ['111111', '222222']);
  assert.deepEqual(operations, ['email_otp_validate', 'email_otp_validate']);
  assert.equal(state.emailOtpValidationRetries, 0);
  assert.equal(readOptions[1].nextQueuedCode, true);
  assert.equal(readOptions[1].reportDelivery, false);
  assert.equal(state.events.some((event) => event.type === 'email_otp_queued_code_retry'), true);
});

test('a queued read that returns nothing falls back to the fresh-code restart', async () => {
  const validatedCodes = [];
  let restarted = 0;
  const runner = new ChatGptSessionRunner({ log: { entries: [] } }, {
    getEmailCode: async (_email, _boundary, _state, options = {}) => (
      options.nextQueuedCode === true ? null : { code: restarted ? '333333' : '111111' }
    ),
    checkpoint: async () => {},
  });
  runner.restartAfterWrongEmailOtp = async (state) => {
    restarted += 1;
    state.emailOtpValidationRetries = 1;
    state.emailOtpSentAt = '2026-10-11T02:27:00.000Z';
    state.step = 'email_otp_sent';
  };
  runner.request = async (_session, operation, _method, url, requestOptions = {}) => {
    if (operation !== 'email_otp_validate') throw new Error(`Unexpected fixture request: ${operation}`);
    validatedCodes.push(requestOptions.json.code);
    if (validatedCodes.length === 1) {
      throw Object.assign(new Error('verification code rejected'), { code: 'WRONG_EMAIL_OTP_CODE', status: 401 });
    }
    return result({ continue_url: 'https://auth.openai.com/about-you', page: { type: 'about_you' } }, { url });
  };
  runner.completeAccount = async (state) => {
    state.step = 'verified';
    state.status = 'valid';
  };
  const state = makeInitialChatGptSessionState({ email: 'queued-empty@example.test' });
  state.step = 'email_otp_sent';
  state.emailOtpSentAt = '2026-10-11T02:25:52.650Z';
  state.emailBoundary = { capturedAt: '2026-10-11T02:25:50.000Z', messageIds: [] };
  state.authPayload = {
    continue_url: 'https://auth.openai.com/email-verification',
    page: { type: 'email_otp_verification' },
  };

  await runner.run(state);

  assert.equal(restarted, 1);
  assert.deepEqual(validatedCodes, ['111111', '333333']);
});
