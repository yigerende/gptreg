'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  CLIENT_ID,
  CODEX_OAUTH_PROTOCOL,
  REDIRECT_URI,
  SCOPES,
  TOKEN_ENDPOINT,
  buildTokenRequestDescriptor,
  createCodexPkceSession,
  decodeJwtPayload,
  exchangeTokens,
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
  parseAndValidateOAuthCallback,
  validateOAuthCallback,
} = require('../src/oauth-pkce');

function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.${Buffer.from('sig').toString('base64url')}`;
}

function tokenExecutor(tokens, status = 200) {
  return async (request) => ({
    response: {
      status,
      url: request.url,
      contentType: 'application/json',
      text: JSON.stringify(tokens),
    },
  });
}

test('generates RFC 7636 S256 code challenge', () => {
  const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  assert.equal(generateCodeChallenge(verifier), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
});

test('generates base64url verifier and state without padding', () => {
  const verifier = generateCodeVerifier({ randomBytes: (length) => Buffer.alloc(length, 0x61) });
  const state = generateState({ randomBytes: (length) => Buffer.alloc(length, 0x62) });

  assert.equal(verifier.length, 43);
  assert.equal(state.length, 43);
  assert.match(verifier, /^[A-Za-z0-9_-]+$/);
  assert.match(state, /^[A-Za-z0-9_-]+$/);
  assert.equal(verifier.includes('='), false);
  assert.equal(state.includes('='), false);
});

test('builds Codex authorize URL with dynamic PKCE values', () => {
  const session = createCodexPkceSession({
    codeVerifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    state: 'unit-state',
  });
  const url = new URL(session.authorizeUrl);

  assert.equal(url.origin + url.pathname, 'https://auth.openai.com/oauth/authorize');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('client_id'), CLIENT_ID);
  assert.equal(url.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.equal(url.searchParams.get('scope'), SCOPES.join(' '));
  assert.equal(url.searchParams.get('code_challenge'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('id_token_add_organizations'), 'true');
  assert.equal(url.searchParams.get('codex_cli_simplified_flow'), 'true');
  assert.equal(url.searchParams.get('state'), 'unit-state');
  assert.equal(url.searchParams.get('originator'), 'codex_vscode');
  assert.equal(session.protocol, CODEX_OAUTH_PROTOCOL);
  assert.equal(session.codeVerifier, 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
});

test('validates callback redirect target, state, and nonempty code', () => {
  const callback = 'http://localhost:1455/auth/callback?code=ac_unit&scope=openid+profile&state=unit-state';
  const parsed = parseAndValidateOAuthCallback(callback, {
    expectedState: 'unit-state',
    expectedRedirectUri: REDIRECT_URI,
  });

  assert.equal(parsed.code, 'ac_unit');
  assert.equal(parsed.state, 'unit-state');
  assert.equal(parsed.scope, 'openid profile');
  assert.throws(
    () => parseAndValidateOAuthCallback(callback, { expectedState: 'other-state' }),
    /state mismatch/,
  );
  assert.throws(
    () => parseAndValidateOAuthCallback('http://localhost:1455/auth/callback?state=unit-state', {
      expectedState: 'unit-state',
    }),
    /callback\.code/,
  );
});

test('rejects callback URLs with a different scheme, host, port, or path', () => {
  const options = { expectedState: 'unit-state', expectedRedirectUri: REDIRECT_URI };
  const callbacks = [
    ['https://localhost:1455/auth/callback?code=ac&state=unit-state', /scheme mismatch/],
    ['http://example.test:1455/auth/callback?code=ac&state=unit-state', /host mismatch/],
    ['http://localhost:1456/auth/callback?code=ac&state=unit-state', /port mismatch/],
    ['http://localhost:1455/other?code=ac&state=unit-state', /path mismatch/],
  ];

  for (const [callback, message] of callbacks) {
    assert.throws(() => parseAndValidateOAuthCallback(callback, options), message);
  }
  assert.throws(
    () => parseAndValidateOAuthCallback('/auth/callback?code=ac&state=unit-state', options),
    /absolute URL/,
  );
});

test('validates callbacks against a session custom redirect and rejects OAuth errors', () => {
  const session = createCodexPkceSession({
    codeVerifier: 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
    state: 'unit-state',
    redirectUri: 'http://127.0.0.1:9876/oauth/return',
  });
  const parsed = validateOAuthCallback(
    session,
    'http://127.0.0.1:9876/oauth/return?code=ac_unit&state=unit-state',
  );
  assert.equal(parsed.code, 'ac_unit');
  assert.throws(
    () => validateOAuthCallback(
      session,
      'http://127.0.0.1:9876/oauth/return?error=access_denied&error_description=nope&state=unit-state',
    ),
    /access_denied: nope/,
  );
  assert.throws(
    () => validateOAuthCallback(
      session,
      'http://127.0.0.1:9876/oauth/return?error=&code=ac_unit&state=unit-state',
    ),
    /invalid_error/,
  );
  assert.throws(
    () => validateOAuthCallback(
      session,
      'http://127.0.0.1:9876/oauth/return?code=first&code=second&state=unit-state',
    ),
    /duplicate code/,
  );
});

test('builds token request descriptor and accepts a complete token response without refresh token', async () => {
  const descriptor = buildTokenRequestDescriptor({
    code: 'ac_unit',
    codeVerifier: 'unit-verifier',
  });
  const body = new URLSearchParams(descriptor.body);

  assert.equal(descriptor.method, 'POST');
  assert.equal(descriptor.url, TOKEN_ENDPOINT);
  assert.equal(descriptor.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(descriptor.headers.accept, 'application/json');
  assert.equal(body.get('grant_type'), 'authorization_code');
  assert.equal(body.get('client_id'), CLIENT_ID);
  assert.equal(body.get('code'), 'ac_unit');
  assert.equal(body.get('redirect_uri'), REDIRECT_URI);
  assert.equal(body.get('code_verifier'), 'unit-verifier');

  const result = await exchangeTokens(descriptor, {
    executor: tokenExecutor({ access_token: 'access-unit', id_token: 'id-unit' }),
  });

  assert.equal(result.tokens.access_token, 'access-unit');
  assert.equal(result.tokens.id_token, 'id-unit');
  assert.equal(result.tokens.refresh_token, undefined);
});

test('reports nested token endpoint errors without object coercion or secret-bearing diagnostics', async () => {
  const descriptor = buildTokenRequestDescriptor({ code: 'secret-provider-code', codeVerifier: 'secret-verifier' });
  await assert.rejects(
    exchangeTokens(descriptor, {
      executor: async () => ({
        response: {
          status: 400,
          contentType: 'application/json',
          text: JSON.stringify({ error: { code: 'invalid_grant', message: 'Authorization code secret-provider-code was rejected' } }),
        },
      }),
    }),
    (error) => {
      assert.equal(error.code, 'INVALID_GRANT');
      assert.match(error.message, /INVALID_GRANT: Authorization code <redacted> was rejected/);
      assert.doesNotMatch(error.message, /\[object Object\]|secret-provider-code/);
      assert.deepEqual(error.diagnostics.requestFields, {
        client_id: 'string',
        code_verifier: 'string',
        grant_type: 'string',
        code: 'string',
        redirect_uri: 'string',
      });
      assert.equal(error.request, undefined);
      return true;
    },
  );
});

test('rejects successful token responses missing either required token', async () => {
  const descriptor = buildTokenRequestDescriptor({ code: 'ac_unit', codeVerifier: 'unit-verifier' });

  await assert.rejects(
    exchangeTokens(descriptor, { executor: tokenExecutor({ access_token: 'access-unit' }) }),
    /id_token/,
  );
  await assert.rejects(
    exchangeTokens(descriptor, { executor: tokenExecutor({ id_token: 'id-unit' }) }),
    /access_token/,
  );
  await assert.rejects(
    exchangeTokens(descriptor, {
      executor: async () => ({ response: { status: 200, text: '<html>not json</html>' } }),
    }),
    /not JSON/,
  );
});

test('decodes JWT payloads without signature verification and strictly rejects malformed tokens', () => {
  const token = jwt({ sub: 'user-unit', email: 'alias@example.com', exp: 1_800_000_000 });
  assert.deepEqual(decodeJwtPayload(token), {
    sub: 'user-unit',
    email: 'alias@example.com',
    exp: 1_800_000_000,
  });

  assert.throws(() => decodeJwtPayload('only.two'), /three-segment/);
  assert.throws(() => decodeJwtPayload('a.***.c'), /non-base64url|valid unpadded base64url/);
  assert.throws(
    () => decodeJwtPayload(`a.${Buffer.from('not json').toString('base64url')}.c`),
    /valid JSON/,
  );
  assert.throws(
    () => decodeJwtPayload(`a.${Buffer.from('[]').toString('base64url')}.c`),
    /must be an object/,
  );
});
