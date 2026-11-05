'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CockpitOAuthRunner,
  accountChoicesFromHtml,
  hasCodexOAuthContract,
  makeInitialCockpitOAuthState,
  matchingAccountChoice,
} = require('../src/cockpit-oauth-runner');
const { phoneSendPayload } = require('../src/chatgpt-session-runner');
const {
  AUTH_ENDPOINT,
  CLIENT_ID,
  CODEX_OAUTH_PROTOCOL,
  REDIRECT_URI,
  SCOPES,
  TOKEN_ENDPOINT,
} = require('../src/oauth-pkce');
const { cookieHeaderFor } = require('../src/cookie-jar');

function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.${Buffer.from('sig').toString('base64url')}`;
}

function response(request, status, payload = {}, options = {}) {
  return {
    request,
    response: {
      status,
      url: options.url || request.url,
      location: options.location || '',
      contentType: options.contentType || 'application/json',
      text: options.text === undefined ? JSON.stringify(payload) : options.text,
    },
  };
}

function callbackFor(oauth, code) {
  const url = new URL(oauth.redirectUri);
  url.searchParams.set('code', code);
  url.searchParams.set('state', oauth.state);
  return url.toString();
}

function chooserHtml(email) {
  return `<!doctype html><form action="/choose-an-account" method="post">
    <input type="hidden" name="intent" value="select">
    <button name="session_id" value="session-other">Other other@example.test</button>
    <button name="session_id" value="session-current">Current ${email}</button>
  </form>`;
}

function headerValue(headers, name) {
  const key = Object.keys(headers || {}).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : '';
}

function makeCockpitState(options = {}) {
  return makeInitialCockpitOAuthState(options);
}

test('parses and matches the existing account chooser without exposing another session', () => {
  const html = chooserHtml('person@example.test');
  assert.deepEqual(accountChoicesFromHtml(html).map(({ intent, label }) => ({ intent, label })), [
    { intent: 'select', label: 'Other other@example.test' },
    { intent: 'select', label: 'Current person@example.test' },
  ]);
  assert.equal(matchingAccountChoice(html, 'person@example.test').sessionId, 'session-current');
  assert.throws(
    () => matchingAccountChoice(html, 'missing@example.test'),
    (error) => error.code === 'OAUTH_ACCOUNT_SELECTION_MISMATCH' && !error.message.includes('session-current'),
  );
  assert.throws(
    () => matchingAccountChoice(chooserHtml('olduser@example.test'), 'user@example.test'),
    (error) => error.code === 'OAUTH_ACCOUNT_SELECTION_MISMATCH',
  );
});

test('extracts only the selected login session from the chooser form', () => {
  const html = `<!doctype html><form action="/choose-an-account?transaction=unit" method="post">
    <input type="hidden" name="intent" value="select">
    <input type="hidden" name="form_token" value="token-unit">
    <button name="session_id" value="session-current">Current person@example.test</button>
  </form>`;
  const choice = matchingAccountChoice(html, 'person@example.test');

  assert.deepEqual(choice, {
    intent: 'select',
    sessionId: 'session-current',
    label: 'Current person@example.test',
  });
});

test('matches chooser controls that expose the account email through accessible attributes', () => {
  const html = `<!doctype html><form action="/choose-an-account" method="post">
    <input type="hidden" name="intent" value="select">
    <input type="submit" name="session_id" value="session-current" aria-label="Continue with person@example.test">
  </form>`;
  const choice = matchingAccountChoice(html, 'person@example.test');
  assert.equal(choice.sessionId, 'session-current');
});

test('ignores account chooser forms whose action leaves auth.openai.com', () => {
  const html = `<!doctype html><form action="https://evil.example/choose-an-account" method="post">
    <input type="hidden" name="intent" value="select">
    <button name="session_id" value="session-current">Current person@example.test</button>
  </form>`;
  assert.deepEqual(accountChoicesFromHtml(html), []);
});

test('initial state stores the Cockpit Codex PKCE contract', () => {
  const state = makeInitialCockpitOAuthState({ email: 'person@example.test', oaiDid: 'device-unit' });
  const authorize = new URL(state.oauth.authorizeUrl);

  assert.equal(state.oauth.protocol, CODEX_OAUTH_PROTOCOL);
  assert.equal(hasCodexOAuthContract(state.oauth), true);
  assert.equal(`${authorize.origin}${authorize.pathname}`, AUTH_ENDPOINT);
  assert.equal(authorize.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(authorize.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.equal(authorize.searchParams.get('scope'), SCOPES.join(' '));
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorize.searchParams.get('id_token_add_organizations'), 'true');
  assert.equal(authorize.searchParams.get('codex_cli_simplified_flow'), 'true');
  assert.equal(authorize.searchParams.get('originator'), 'codex_vscode');
  assert.match(state.oauth.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
});

test('omits the SMS channel when the auth session only permits one verification channel', () => {
  const cookiePayload = Buffer.from(JSON.stringify({ multi_channel_allowed: false })).toString('base64url');
  const cookieJar = {
    'oai-client-auth-session': `${cookiePayload}.unit.signature`,
  };

  assert.deepEqual(phoneSendPayload('+56912345678', {}, cookieJar), {
    payload: { phone_number: '+56912345678' },
    multiChannelAllowed: false,
  });
  assert.deepEqual(phoneSendPayload('+56912345678', {
    'oai-client-auth-session': { multi_channel_allowed: true },
  }, cookieJar), {
    payload: { phone_number: '+56912345678', channel: 'sms' },
    multiChannelAllowed: true,
  });
});

test('OAuth branch rejects every account-creation continuation', async () => {
  for (const path of ['/about-you', '/create-account', '/create-account/password']) {
    const state = makeInitialCockpitOAuthState({ email: 'existing-only@example.test' });
    state.step = 'navigating';
    state.nextUrl = `https://auth.openai.com${path}`;
    const runner = new CockpitOAuthRunner({
      executor: async () => { throw new Error('OAuth must reject before issuing an account-creation request'); },
    });
    await assert.rejects(
      runner.run(state),
      (error) => error.code === 'OAUTH_EXISTING_ACCOUNT_REQUIRED',
    );
  }
});

test('OAuth completion requires a refresh token from the matching Cockpit exchange', async () => {
  const state = makeInitialCockpitOAuthState({ email: 'refresh-required@example.test' });
  state.oauthCode = 'callback-code';
  state.callbackUrl = callbackFor(state.oauth, state.oauthCode);
  state.step = 'callback_received';
  const runner = new CockpitOAuthRunner({
    executor: async (request) => response(request, 200, {
      access_token: jwt({ email: state.email, exp: 1_900_000_000 }),
      id_token: jwt({ email: state.email, exp: 1_900_000_000 }),
    }),
  });

  await assert.rejects(
    runner.run(state),
    (error) => error.code === 'OAUTH_REFRESH_TOKEN_MISSING',
  );
  assert.equal(state.step, 'token_exchange_pending');
  assert.equal(state.tokens, null);
});

test('workspace selection stays a plain JSON continuation and does not consume account-creation Sentinel', async () => {
  const state = makeInitialCockpitOAuthState({ email: 'workspace@example.test', accountId: 'account-workspace' });
  state.nextUrl = 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent';
  const runner = new CockpitOAuthRunner({});
  runner.workspaceId = async () => 'workspace-1';
  runner.sentinelHeaders = async () => { throw new Error('workspace selection must not request Sentinel'); };
  runner.request = async (_session, operation, method, url, options) => {
    assert.equal(operation, 'workspace_select');
    assert.equal(method, 'POST');
    assert.equal(url, 'https://auth.openai.com/api/accounts/workspace/select');
    assert.deepEqual(options.json, { workspace_id: 'workspace-1' });
    assert.equal(Object.keys(options.headers).some((name) => name.toLowerCase().startsWith('openai-sentinel-')), false);
    const payload = { continue_url: 'https://auth.openai.com/api/oauth/oauth2/auth?login_verifier=unit' };
    return { ...response({ url }, 200, payload, { url }), json: payload };
  };
  runner.checkpoint = async () => {};

  await runner.selectWorkspace(state, { serializeCookies: () => state.cookieJar }, {});

  assert.equal(state.workspaceId, 'workspace-1');
  assert.equal(state.nextUrl, 'https://auth.openai.com/api/oauth/oauth2/auth?login_verifier=unit');
});

test('workspace selection binds a multi-workspace consent to the saved account ID', async () => {
  const state = makeInitialCockpitOAuthState({
    email: 'workspace-match@example.test',
    accountId: 'workspace-wanted',
  });
  const runner = new CockpitOAuthRunner({});
  runner.request = async () => { throw new Error('A direct account match must not need a session dump'); };

  const selected = await runner.workspaceId(state, {}, {
    workspaces: [
      { id: 'workspace-other' },
      { id: 'workspace-wanted' },
    ],
  });

  assert.equal(selected, 'workspace-wanted');
});

test('workspace selection rejects multiple candidates when none matches the saved account', async () => {
  const state = makeInitialCockpitOAuthState({
    email: 'workspace-ambiguous@example.test',
    accountId: 'account-without-workspace',
  });
  const candidates = [{ id: 'workspace-a' }, { id: 'workspace-b' }];
  const runner = new CockpitOAuthRunner({});
  runner.request = async () => ({ json: { workspaces: candidates } });

  await assert.rejects(
    runner.workspaceId(state, {}, { workspaces: candidates }),
    (error) => error.code === 'OAUTH_WORKSPACE_AMBIGUOUS',
  );
});

test('follows the full Cockpit consent verifier chain before exchanging the local callback code', async () => {
  const email = 'consent@example.test';
  const accountId = 'account-consent';
  const state = makeCockpitState({ email, accountId, oaiDid: 'device-consent' });
  const callback = callbackFor(state.oauth, 'consent-code');
  const accessToken = jwt({ email, exp: 1_900_000_000, 'https://api.openai.com/auth': { chatgpt_account_id: accountId } });
  const idToken = jwt({ email, exp: 1_900_000_000 });
  const calls = [];
  const executor = async (request) => {
    const url = new URL(request.url);
    calls.push({ method: request.method, path: url.pathname, query: [...url.searchParams.keys()], headers: request.headers });
    if (url.pathname === '/oauth/authorize') return response(request, 302, {}, { location: 'https://auth.openai.com/sign-in-with-chatgpt/codex/consent' });
    if (url.pathname === '/sign-in-with-chatgpt/codex/consent.data') {
      return response(request, 200, { workspaces: [{ id: 'workspace-1' }] });
    }
    if (url.pathname === '/api/accounts/workspace/select') {
      assert.equal(Object.keys(request.headers).some((name) => name.toLowerCase().startsWith('openai-sentinel-')), false);
      return response(request, 200, { continue_url: 'https://auth.openai.com/api/oauth/oauth2/auth?login_verifier=unit' });
    }
    if (url.pathname === '/api/oauth/oauth2/auth' && url.searchParams.has('login_verifier')) {
      return response(request, 302, {}, { location: 'https://auth.openai.com/api/accounts/consent?consent_challenge=unit' });
    }
    if (url.pathname === '/api/accounts/consent') {
      return response(request, 302, {}, { location: 'https://auth.openai.com/api/oauth/oauth2/auth?consent_verifier=unit' });
    }
    if (url.pathname === '/api/oauth/oauth2/auth' && url.searchParams.has('consent_verifier')) {
      return response(request, 303, {}, { location: callback });
    }
    if (request.url === TOKEN_ENDPOINT) return response(request, 200, {
      access_token: accessToken,
      id_token: idToken,
      refresh_token: 'refresh-consent',
    });
    if (url.pathname === '/backend-api/me') return response(request, 200, { email, account_id: accountId });
    if (url.pathname === '/backend-api/accounts/check/v4-2023-04-27') return response(request, 200, { account_id: accountId });
    throw new Error(`Unexpected consent request: ${request.method} ${request.url}`);
  };
  const runner = new CockpitOAuthRunner({ executor });

  await runner.run(state);

  assert.equal(state.step, 'complete');
  assert.equal(state.account.email, email);
  assert.equal(state.account.refresh_token, 'refresh-consent');
  assert.deepEqual(calls.map((call) => call.path), [
    '/oauth/authorize',
    '/sign-in-with-chatgpt/codex/consent.data',
    '/api/accounts/workspace/select',
    '/api/oauth/oauth2/auth',
    '/api/accounts/consent',
    '/api/oauth/oauth2/auth',
    '/oauth/token',
    '/backend-api/me',
    '/backend-api/accounts/check/v4-2023-04-27',
  ]);
  const redirectEvents = state.events.filter((event) => event.type === 'oauth_redirect');
  assert.equal(JSON.stringify(redirectEvents).includes('login_verifier=unit'), false);
  assert.equal(JSON.stringify(redirectEvents).includes('consent_verifier=unit'), false);
});

test('rejects a token whose account identity differs from the selected account', async () => {
  const email = 'identity-mismatch@example.test';
  const state = makeInitialCockpitOAuthState({ email, accountId: 'expected-A' });
  state.tokens = {
    access_token: jwt({ email, exp: 1_900_000_000, 'https://api.openai.com/auth': { chatgpt_account_id: 'actual-B' } }),
    id_token: jwt({ email, exp: 1_900_000_000 }),
  };
  const runner = new CockpitOAuthRunner({});
  runner.request = async (_session, operation, method, url) => response({ method, url }, 200,
    operation === 'oauth_token_me' ? { email, account_id: 'actual-B' } : { account_id: 'actual-B' });
  await assert.rejects(
    runner.validateTokens(state, { serializeCookies: () => state.cookieJar }),
    (error) => error.code === 'OAUTH_TOKEN_IDENTITY_MISMATCH',
  );
  assert.notEqual(state.step, 'complete');
});

test('does not reset an expired PKCE contract while a durable phone checkpoint is waiting', async () => {
  const state = makeInitialCockpitOAuthState({ email: 'expired-phone@example.test' });
  state.step = 'phone_required';
  state.nextUrl = 'https://auth.openai.com/phone-verification';
  state.oauth.expiresAt = '2020-01-01T00:00:00.000Z';
  const originalState = state.oauth.state;
  const checkpoints = [];
  const runner = new CockpitOAuthRunner({ checkpoint: async (type) => checkpoints.push(type) });
  await runner.run(state);
  assert.equal(state.step, 'phone_required');
  assert.equal(state.oauth.state, originalState);
  assert.equal(checkpoints.includes('oauth_protocol_expired_preserved'), true);
});

test('turns an OAuth MFA checkpoint into an explicit login-state repair error', async () => {
  const state = makeInitialCockpitOAuthState({ email: 'oauth-mfa@example.test' });
  state.step = 'mfa_required';
  const runner = new CockpitOAuthRunner({});
  await assert.rejects(
    runner.run(state),
    (error) => error.code === 'OAUTH_MFA_REQUIRED',
  );
});

test('runs Cockpit Codex OAuth through account selection, phone verification, matching token exchange, and Bearer validation', async () => {
  const email = 'person@example.test';
  const accountId = 'account-codex-unit';
  const accessToken = jwt({
    email,
    exp: 1_900_000_000,
    'https://api.openai.com/auth': { chatgpt_account_id: accountId },
  });
  const idToken = jwt({ email, exp: 1_900_000_000 });
  const calls = [];
  const state = makeCockpitState({
    email,
    accountId,
    oaiDid: 'device-codex-unit',
    cookieJar: { auth_session: 'browser-session-cookie' },
  });
  const callback = callbackFor(state.oauth, 'codex-code-unit');
  const executor = async (request, execution = {}) => {
    const url = new URL(request.url);
    calls.push({ method: request.method, path: url.pathname, body: request.body, headers: request.headers });
    if (url.pathname === '/oauth/authorize') {
      assert.equal(request.method, 'GET');
      assert.equal(headerValue(request.headers, 'accept'), 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8');
      assert.equal(headerValue(request.headers, 'sec-fetch-mode'), 'navigate');
      assert.equal(headerValue(request.headers, 'sec-fetch-dest'), 'document');
      assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
      assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI);
      assert.equal(url.searchParams.get('scope'), SCOPES.join(' '));
      assert.equal(url.searchParams.get('state'), state.oauth.state);
      assert.match(url.searchParams.get('code_challenge'), /^[A-Za-z0-9_-]{43}$/);
      return response(request, 302, {}, { location: 'https://auth.openai.com/choose-an-account' });
    }
    if (url.pathname === '/choose-an-account' && request.method === 'GET') {
      return response(request, 200, {}, { contentType: 'text/html', text: chooserHtml(email) });
    }
    if (url.pathname === '/api/accounts/session/select' && request.method === 'POST') {
      assert.equal(headerValue(request.headers, 'accept'), 'application/json');
      assert.equal(headerValue(request.headers, 'content-type'), 'application/json');
      assert.equal(headerValue(request.headers, 'sec-fetch-dest'), 'empty');
      assert.equal(headerValue(request.headers, 'sec-fetch-mode'), 'cors');
      assert.match(cookieHeaderFor(execution.cookieJar, request.url), /browser-session-cookie/);
      assert.deepEqual(JSON.parse(request.body), { session_id: 'session-current' });
      return response(request, 200, { continue_url: 'https://auth.openai.com/add-phone' });
    }
    if (url.pathname === '/add-phone' && request.method === 'GET') {
      return response(request, 200, {}, { contentType: 'text/html', text: '<html>add phone</html>' });
    }
    if (url.pathname === '/api/accounts/add-phone/send') {
      return response(request, 200, { continue_url: 'https://auth.openai.com/phone-verification' });
    }
    if (url.pathname === '/api/accounts/phone-otp/validate') {
      return response(request, 200, { continue_url: callback });
    }
    if (request.url === TOKEN_ENDPOINT) {
      const body = new URLSearchParams(request.body);
      assert.equal(body.get('grant_type'), 'authorization_code');
      assert.equal(body.get('client_id'), CLIENT_ID);
      assert.equal(body.get('code'), 'codex-code-unit');
      assert.equal(body.get('code_verifier'), state.oauth.codeVerifier);
      assert.equal(body.get('redirect_uri'), REDIRECT_URI);
      assert.equal(headerValue(request.headers, 'content-type'), 'application/x-www-form-urlencoded');
      assert.equal(headerValue(request.headers, 'origin'), '');
      assert.equal(headerValue(request.headers, 'referer'), '');
      return response(request, 200, { access_token: accessToken, id_token: idToken, refresh_token: 'refresh-codex-unit' });
    }
    if (url.pathname === '/backend-api/me') {
      assert.equal(request.headers.Authorization, `Bearer ${accessToken}`);
      assert.equal(cookieHeaderFor(execution.cookieJar, request.url), '');
      return response(request, 200, { email, account_id: accountId });
    }
    if (url.pathname === '/backend-api/accounts/check/v4-2023-04-27') {
      assert.equal(cookieHeaderFor(execution.cookieJar, request.url), '');
      return response(request, 200, { account_id: accountId });
    }
    if (/^\/api\/auth\/(?:providers|csrf|signin|callback)/.test(url.pathname)) {
      throw new Error(`Cockpit OAuth must not enter the NextAuth provider chain: ${url.pathname}`);
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  };
  const checkpoints = [];
  const runner = new CockpitOAuthRunner({
    executor,
    checkpoint: async (type) => checkpoints.push(type),
  });

  await runner.run(state);
  assert.equal(state.step, 'phone_required');
  await runner.sendPhone(state, '+56912345678');
  assert.equal(state.step, 'phone_otp_sent');
  await runner.validatePhone(state, '123456');
  assert.equal(state.step, 'callback_received');
  await runner.run(state);

  assert.equal(state.step, 'complete');
  assert.equal(state.status, 'complete');
  assert.equal(state.account.email, email);
  assert.equal(state.account.account_id, accountId);
  assert.equal(state.account.refresh_token, 'refresh-codex-unit');
  assert.equal(state.oauthCode, '');
  assert.equal(state.callbackUrl, '');
  assert.equal(calls.some((call) => call.path === '/api/auth/callback/openai'), false);
  assert.deepEqual(checkpoints.filter((type) => /oauth_(?:authorization|phone|required|callback|token)/.test(type)), [
    'oauth_authorization_started',
    'oauth_phone_required',
    'oauth_phone_otp_sent',
    'oauth_callback_received',
    'oauth_token_exchange_pending',
    'oauth_tokens_received',
    'oauth_tokens_validated',
  ]);
});

for (const viaChooser of [false, true]) {
  test(`completes a no-phone Cockpit OAuth flow when ${viaChooser ? 'the chooser' : 'authorize'} returns the local callback directly`, async () => {
    const email = 'no-phone@example.test';
    const accountId = 'account-no-phone-unit';
    const accessToken = jwt({
      email,
      exp: 1_900_000_000,
      'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    });
    const idToken = jwt({ email, exp: 1_900_000_000 });
    const state = makeCockpitState({ email, accountId, oaiDid: 'device-no-phone' });
    const callback = callbackFor(state.oauth, 'no-phone-code');
    const calls = [];
    const executor = async (request) => {
      const url = new URL(request.url);
      calls.push(`${request.method} ${url.pathname}`);
      if (url.pathname === '/oauth/authorize') {
        return response(request, 302, {}, {
          location: viaChooser ? 'https://auth.openai.com/choose-an-account' : callback,
        });
      }
      if (url.pathname === '/choose-an-account' && request.method === 'GET') {
        return response(request, 200, {}, { contentType: 'text/html', text: chooserHtml(email) });
      }
      if (url.pathname === '/api/accounts/session/select' && request.method === 'POST') {
        assert.deepEqual(JSON.parse(request.body), { session_id: 'session-current' });
        return response(request, 200, { continue_url: callback });
      }
      if (request.url === TOKEN_ENDPOINT) {
        assert.equal(new URLSearchParams(request.body).get('code'), 'no-phone-code');
        return response(request, 200, { access_token: accessToken, id_token: idToken, refresh_token: 'refresh-no-phone' });
      }
      if (url.pathname === '/backend-api/me') return response(request, 200, { email, account_id: accountId });
      if (url.pathname === '/backend-api/accounts/check/v4-2023-04-27') return response(request, 200, { account_id: accountId });
      throw new Error(`Unexpected request: ${request.method} ${request.url}`);
    };
    const checkpoints = [];
    const runner = new CockpitOAuthRunner({
      executor,
      checkpoint: async (type) => checkpoints.push(type),
    });

    await runner.run(state);

    assert.equal(state.step, 'complete');
    assert.equal(state.account.refresh_token, 'refresh-no-phone');
    assert.equal(calls.some((call) => /add-phone|phone-verification/.test(call)), false);
    assert.equal(calls.some((call) => call.endsWith('/api/auth/callback/openai')), false);
    assert.equal(checkpoints.includes('oauth_phone_required'), false);
    assert.equal(checkpoints.includes('oauth_callback_received'), true);
  });
}

test('an ambiguous token exchange checkpoint restarts with a fresh Codex authorization instead of replaying its code', async () => {
  const state = makeInitialCockpitOAuthState({ email: 'resume@example.test' });
  const staleState = state.oauth.state;
  state.step = 'token_exchange_pending';
  state.oauthCode = 'must-not-replay';
  state.callbackUrl = callbackFor(state.oauth, 'must-not-replay');
  state.tokenExchange = { status: 'pending' };
  const checkpoints = [];
  const runner = new CockpitOAuthRunner({
    checkpoint: async (type) => checkpoints.push(type),
  });
  runner.beginCockpitOAuth = async (current) => {
    assert.equal(current.oauthCode, '');
    assert.equal(current.callbackUrl, '');
    assert.notEqual(current.oauth.state, staleState);
    current.step = 'phone_required';
  };

  await runner.run(state);

  assert.equal(state.step, 'phone_required');
  assert.equal(checkpoints.includes('oauth_token_exchange_restarted'), true);
});

test('a stale NextAuth provider state is discarded and migrated to fresh Cockpit PKCE', async () => {
  const state = makeInitialCockpitOAuthState({ email: 'legacy-provider@example.test' });
  state.oauth = {
    protocol: 'chatgpt-nextauth-provider',
    clientId: 'app_X8zY6vW2pQ9tR3dE7nK1jL5gH',
    authEndpoint: 'https://auth.openai.com/api/accounts/authorize',
    tokenEndpoint: 'https://auth.openai.com/api/accounts/oauth/token',
    redirectUri: 'https://chatgpt.com/api/auth/callback/openai',
    codeVerifier: 'legacy-verifier',
    state: 'legacy-state',
    authorizeUrl: 'https://auth.openai.com/api/accounts/authorize?state=legacy-state',
  };
  state.oauthCode = 'legacy-code-must-not-replay';
  state.callbackUrl = 'https://chatgpt.com/api/auth/callback/openai?code=legacy-code-must-not-replay&state=legacy-state';
  state.step = 'callback_received';
  const checkpoints = [];
  const runner = new CockpitOAuthRunner({
    checkpoint: async (type) => checkpoints.push(type),
  });
  runner.beginCockpitOAuth = async (current) => {
    assert.equal(current.oauthCode, '');
    assert.equal(current.callbackUrl, '');
    assert.equal(current.oauth.protocol, CODEX_OAUTH_PROTOCOL);
    assert.equal(hasCodexOAuthContract(current.oauth), true);
    current.step = 'phone_required';
  };

  await runner.run(state);

  assert.equal(state.step, 'phone_required');
  assert.equal(checkpoints.includes('oauth_protocol_migrated'), true);
});

test('an uncertain account selection is checkpointed and restarted with a fresh authorization', async () => {
  const email = 'selection-retry@example.test';
  const state = makeInitialCockpitOAuthState({ email });
  const staleState = state.oauth.state;
  state.nextUrl = 'https://auth.openai.com/choose-an-account';
  state.step = 'navigating';
  const checkpoints = [];
  const runner = new CockpitOAuthRunner({
    executor: async (request) => {
      assert.equal(request.method, 'POST');
      assert.equal(request.url, 'https://auth.openai.com/api/accounts/session/select');
      assert.equal(headerValue(request.headers, 'sec-fetch-mode'), 'cors');
      assert.equal(headerValue(request.headers, 'sec-fetch-dest'), 'empty');
      assert.equal(headerValue(request.headers, 'accept'), 'application/json');
      assert.deepEqual(JSON.parse(request.body), { session_id: 'session-current' });
      return response(request, 500, {});
    },
    checkpoint: async (type) => checkpoints.push(type),
  });
  const pageResult = response(
    { method: 'GET', url: state.nextUrl },
    200,
    {},
    { contentType: 'text/html', text: chooserHtml(email) },
  );

  await assert.rejects(
    runner.chooseAccount(state, runner.session(state), pageResult, state.nextUrl),
    (error) => error.code === 'OAUTH_ACCOUNT_SELECT_FAILED',
  );
  assert.equal(state.step, 'account_select_pending');
  assert.equal(checkpoints.includes('oauth_account_selection_pending'), true);
  assert.equal(checkpoints.includes('oauth_account_selection_failed'), true);
  assert.equal(state.accountSelection.status, 'failed');
  assert.deepEqual(state.accountSelection.requestFields, ['session_id']);
  assert.equal(state.accountSelection.response.status, 500);
  assert.equal(state.accountSelection.response.bodyBytes, 2);
  assert.match(state.accountSelection.choiceFingerprint, /^[a-f0-9]{16}$/);
  assert.equal(JSON.stringify(state.accountSelection).includes('session-current'), false);

  runner.beginCockpitOAuth = async (current) => { current.step = 'phone_required'; };
  await runner.run(state);
  assert.equal(state.step, 'phone_required');
  assert.notEqual(state.oauth.state, staleState);
  assert.equal(checkpoints.includes('oauth_account_selection_restarted'), true);
  assert.equal(state.accountSelection, null);
  assert.equal(state.accountSelectionHistory.at(-1).status, 'failed');
});

test('classifies a chooser response that does not advance as a rejected selection', async () => {
  const email = 'selection-rejected@example.test';
  const state = makeInitialCockpitOAuthState({ email });
  state.nextUrl = 'https://auth.openai.com/choose-an-account';
  const runner = new CockpitOAuthRunner({});
  runner.checkpoint = async () => {};
  runner.request = async (_session, _operation, method, url) => response({ method, url }, 200, {}, { url });
  const page = response({ method: 'GET', url: state.nextUrl }, 200, {}, { contentType: 'text/html', text: chooserHtml(email) });
  await assert.rejects(
    runner.chooseAccount(state, runner.session(state), page, state.nextUrl),
    (error) => error.code === 'OAUTH_ACCOUNT_SELECTION_REJECTED',
  );
  assert.equal(state.accountSelection.status, 'rejected');
});

test('classifies an empty chooser 500 as an OAuth HTTP retry without blaming the proxy', async () => {
  const email = 'selection-transport@example.test';
  const state = makeInitialCockpitOAuthState({ email });
  state.nextUrl = 'https://auth.openai.com/choose-an-account';
  const runner = new CockpitOAuthRunner({});
  runner.checkpoint = async () => {};
  runner.request = async (_session, _operation, method, url) => {
    const error = new Error('oauth_account_select failed with HTTP 500: unknown response');
    error.code = 'OAUTH_ACCOUNT_SELECT_FAILED';
    error.status = 500;
    error.diagnostics = { status: 500, contentType: '', bodyBytes: 0, bodyHash: '' };
    throw error;
  };
  const page = response({ method: 'GET', url: state.nextUrl }, 200, {}, { contentType: 'text/html', text: chooserHtml(email) });
  await assert.rejects(
    runner.chooseAccount(state, runner.session(state), page, state.nextUrl),
    (error) => error.code === 'OAUTH_ACCOUNT_SELECT_HTTP_FAILED'
      && error.accountSelectionFailure === true
      && error.proxyFailure !== true
      && error.retryable === true,
  );
  assert.equal(state.accountSelection.status, 'failed');
  assert.equal(state.accountSelection.response.bodyBytes, 0);
});

test('a login challenge is followed and a live session carries the authorization through', async () => {
  // Regression: `/oauth/authorize` hands a request to Hydra, which bounces it to
  // `/api/accounts/login?login_challenge=`. That hop is normal — a live session
  // resolves it and comes straight back with a verifier. Treating the URL alone
  // as proof of a signed-out account failed accounts whose session was fine, and
  // spent the one allowed login repair chasing a diagnosis that could not hold.
  const state = makeInitialCockpitOAuthState({ email: 'live-session@example.test' });
  state.step = 'navigating';
  state.nextUrl = 'https://auth.openai.com/api/accounts/login?login_challenge=challenge-1';
  const visited = [];
  const runner = new CockpitOAuthRunner({
    executor: async (request) => {
      visited.push(new URL(request.url).pathname);
      if (new URL(request.url).pathname === '/api/accounts/login') {
        // The session is live, so the challenge resolves into a verifier.
        return response(request, 302, {}, { location: 'https://auth.openai.com/api/oauth/oauth2/auth?login_verifier=ok' });
      }
      return response(request, 302, {}, { location: callbackFor(state.oauth, 'code-after-challenge') });
    },
  });

  await runner.navigate(state, runner.session(state));

  assert.equal(visited.includes('/api/accounts/login'), true, 'the login hop has to be attempted, not assumed fatal');
  assert.equal(state.oauthCode, 'code-after-challenge');
  assert.equal(state.step, 'callback_received');
  assert.equal(
    state.events.some((record) => record.type === 'oauth_login_challenge_followed'),
    true,
  );
});

test('a login challenge that lands on the sign-in page is still reported as a dead session', async () => {
  const state = makeInitialCockpitOAuthState({ email: 'dead-session@example.test' });
  state.step = 'navigating';
  state.nextUrl = 'https://auth.openai.com/api/accounts/login?login_challenge=challenge-2';
  const runner = new CockpitOAuthRunner({
    executor: async (request) => response(request, 302, {}, { location: 'https://auth.openai.com/log-in' }),
  });

  await assert.rejects(
    runner.run(state),
    (error) => error.code === 'OAUTH_LOGIN_REQUIRED',
  );
});

test('the combined login-or-create page is reported as a dead session', async () => {
  const state = makeInitialCockpitOAuthState({ email: 'combined-login-page@example.test' });
  state.step = 'navigating';
  state.nextUrl = 'https://auth.openai.com/log-in-or-create-account';
  const runner = new CockpitOAuthRunner({});

  await assert.rejects(
    runner.run(state),
    (error) => error.code === 'OAUTH_LOGIN_REQUIRED',
  );
});

test('a login challenge that keeps handing itself back gives up instead of looping', async () => {
  const state = makeInitialCockpitOAuthState({ email: 'looping@example.test' });
  state.step = 'navigating';
  state.nextUrl = 'https://auth.openai.com/api/accounts/login?login_challenge=challenge-3';
  let calls = 0;
  const runner = new CockpitOAuthRunner({
    executor: async (request) => {
      calls += 1;
      return response(request, 302, {}, { location: 'https://auth.openai.com/api/accounts/login?login_challenge=challenge-3' });
    },
  });

  await assert.rejects(
    runner.run(state),
    (error) => error.code === 'OAUTH_LOGIN_REQUIRED',
  );
  // Bounded: two attempts, not the full 28-hop navigation budget.
  assert.equal(calls, 2);
});

test('a new PKCE transaction drops spent handshake cookies but keeps the session ones', () => {
  const cookieJar = JSON.stringify({
    cookies: [
      { key: 'oai-did', domain: 'auth.openai.com' },
      { key: 'oai-client-auth-session', domain: 'auth.openai.com' },
      { key: 'unified_session_manifest', domain: 'auth.openai.com' },
      { key: 'usc_VYBao3LljscGDQ5mwxugJtqw', domain: 'auth.openai.com' },
      // Left over from a handshake that already failed once.
      { key: 'hydra_redirect', domain: 'auth.openai.com' },
      { key: 'oai-login-csrf_dev_3772291445', domain: 'auth.openai.com' },
      { key: 'rg_context', domain: 'auth.openai.com' },
      { key: 'iss_context', domain: 'auth.openai.com' },
      { key: '__Secure-next-auth.session-token.0', domain: 'chatgpt.com' },
    ],
  });

  const state = makeInitialCockpitOAuthState({ email: 'fresh-transaction@example.test', cookieJar });
  const keys = JSON.parse(state.cookieJar).cookies.map((cookie) => cookie.key);

  assert.deepEqual(keys, [
    'oai-did',
    'oai-client-auth-session',
    'unified_session_manifest',
    'usc_VYBao3LljscGDQ5mwxugJtqw',
    // Routing context is kept: only the two per-handshake cookies are dropped.
    'rg_context',
    'iss_context',
    '__Secure-next-auth.session-token.0',
  ]);
});
