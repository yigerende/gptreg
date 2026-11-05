'use strict';

const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const { firstDefined } = require('./util/shared');

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const AUTH_ENDPOINT = 'https://auth.openai.com/oauth/authorize';
const TOKEN_ENDPOINT = 'https://auth.openai.com/oauth/token';
const REDIRECT_URI = 'http://localhost:1455/auth/callback';
const CODEX_OAUTH_PROTOCOL = 'codex-pkce';
const OAUTH_SESSION_TTL_MS = 300_000;
const SCOPES = Object.freeze([
  'openid',
  'profile',
  'email',
  'offline_access',
  'api.connectors.read',
  'api.connectors.invoke',
]);
const CODE_CHALLENGE_METHOD = 'S256';
const ORIGINATOR = 'codex_vscode';

function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function assertNonBlankString(value, name) {
  assertNonEmptyString(value, name);
  if (value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function byteLengthFromOptions(options, fallback) {
  if (typeof options === 'number') return options;
  return options?.byteLength ?? fallback;
}

function randomBytes(byteLength, options = {}) {
  if (!Number.isInteger(byteLength) || byteLength <= 0) {
    throw new RangeError(`byteLength must be a positive integer: ${byteLength}`);
  }
  const source = options.randomBytes || crypto.randomBytes;
  const bytes = source(byteLength);
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    throw new TypeError('randomBytes must return a Buffer or Uint8Array');
  }
  if (bytes.length !== byteLength) {
    throw new Error(`randomBytes returned ${bytes.length} bytes; expected ${byteLength}`);
  }
  return Buffer.from(bytes);
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function generateBase64UrlToken(options = {}) {
  const byteLength = byteLengthFromOptions(options, 32);
  return base64url(randomBytes(byteLength, typeof options === 'object' ? options : {}));
}

function generateCodeVerifier(options = {}) {
  const verifier = generateBase64UrlToken({
    ...(typeof options === 'object' ? options : {}),
    byteLength: byteLengthFromOptions(options, 32),
  });

  if (verifier.length < 43 || verifier.length > 128) {
    throw new RangeError(`PKCE code_verifier length must be 43-128 characters: ${verifier.length}`);
  }

  return verifier;
}

function generateState(options = {}) {
  return generateBase64UrlToken({
    ...(typeof options === 'object' ? options : {}),
    byteLength: byteLengthFromOptions(options, 32),
  });
}

function generateCodeChallenge(codeVerifier) {
  assertNonEmptyString(codeVerifier, 'codeVerifier');
  return crypto.createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
}

function scopeString(scopes = SCOPES) {
  if (typeof scopes === 'string') return scopes;
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new TypeError('scopes must be a non-empty array or string');
  }
  return scopes.join(' ');
}

function buildCodexAuthorizeUrl(options = {}) {
  const state = options.state;
  const codeChallenge = options.codeChallenge || (
    options.codeVerifier ? generateCodeChallenge(options.codeVerifier) : ''
  );
  assertNonEmptyString(state, 'state');
  assertNonEmptyString(codeChallenge, 'codeChallenge');

  const url = new URL(options.authEndpoint || AUTH_ENDPOINT);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', options.clientId || CLIENT_ID);
  url.searchParams.set('redirect_uri', options.redirectUri || REDIRECT_URI);
  url.searchParams.set('scope', scopeString(options.scopes || options.scope || SCOPES));
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', options.codeChallengeMethod || CODE_CHALLENGE_METHOD);
  url.searchParams.set('id_token_add_organizations', 'true');
  url.searchParams.set('codex_cli_simplified_flow', 'true');
  url.searchParams.set('state', state);
  url.searchParams.set('originator', options.originator || ORIGINATOR);
  return url.toString();
}

function createCodexPkceSession(options = {}) {
  const codeVerifier = options.codeVerifier || generateCodeVerifier({
    byteLength: options.verifierBytes ?? options.byteLength ?? 32,
    randomBytes: options.randomBytes,
  });
  const codeChallenge = options.codeChallenge || generateCodeChallenge(codeVerifier);
  const state = options.state || generateState({
    byteLength: options.stateBytes ?? 32,
    randomBytes: options.randomBytes,
  });
  const redirectUri = options.redirectUri || REDIRECT_URI;
  const scope = scopeString(options.scopes || options.scope || SCOPES);
  const authorizeUrl = buildCodexAuthorizeUrl({
    ...options,
    state,
    codeChallenge,
    redirectUri,
    scope,
  });
  const createdAtMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const ttlMs = Number.isFinite(Number(options.ttlMs)) ? Number(options.ttlMs) : OAUTH_SESSION_TTL_MS;

  return {
    protocol: CODEX_OAUTH_PROTOCOL,
    clientId: options.clientId || CLIENT_ID,
    authEndpoint: options.authEndpoint || AUTH_ENDPOINT,
    tokenEndpoint: options.tokenEndpoint || TOKEN_ENDPOINT,
    redirectUri,
    scopes: scope.split(' '),
    scope,
    codeVerifier,
    codeChallenge,
    codeChallengeMethod: options.codeChallengeMethod || CODE_CHALLENGE_METHOD,
    state,
    originator: options.originator || ORIGINATOR,
    authorizeUrl,
    createdAt: new Date(createdAtMs).toISOString(),
    expiresAt: new Date(createdAtMs + ttlMs).toISOString(),
  };
}

function parseAbsoluteUrl(value, name) {
  assertNonBlankString(value, name);
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    throw new TypeError(`${name} must be an absolute URL: ${error.message}`);
  }
  if (!url.protocol || !url.hostname || url.username || url.password) {
    throw new TypeError(`${name} must be an absolute URL without credentials`);
  }
  return url;
}

function singleSearchParam(url, name) {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) {
    throw new Error(`OAuth callback contains duplicate ${name} parameters`);
  }
  return values[0] || '';
}

function parseOAuthCallback(callbackUrl) {
  const url = parseAbsoluteUrl(callbackUrl, 'callbackUrl');
  return {
    url: url.toString(),
    code: singleSearchParam(url, 'code'),
    state: singleSearchParam(url, 'state'),
    scope: singleSearchParam(url, 'scope'),
    error: singleSearchParam(url, 'error'),
    errorDescription: singleSearchParam(url, 'error_description'),
    hasError: url.searchParams.has('error'),
  };
}

function validateOAuthCallbackRedirect(callback, expectedRedirectUri = REDIRECT_URI) {
  const parsed = typeof callback === 'string' ? parseOAuthCallback(callback) : callback;
  if (!parsed || typeof parsed !== 'object') {
    throw new TypeError('callback must be a callback URL string or parsed callback object');
  }

  const actual = parseAbsoluteUrl(parsed.url, 'callback.url');
  const expected = parseAbsoluteUrl(expectedRedirectUri, 'expectedRedirectUri');
  const components = [
    ['scheme', actual.protocol, expected.protocol],
    ['host', actual.hostname, expected.hostname],
    ['port', actual.port, expected.port],
    ['path', actual.pathname, expected.pathname],
  ];
  const mismatch = components.find(([, actualValue, expectedValue]) => actualValue !== expectedValue);
  if (mismatch) {
    const [component] = mismatch;
    throw new Error(`OAuth callback redirect ${component} mismatch`);
  }
  return parsed;
}

function equalState(actual, expected) {
  const actualBytes = Buffer.from(actual, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return actualBytes.length === expectedBytes.length
    && crypto.timingSafeEqual(actualBytes, expectedBytes);
}

function validateOAuthCallbackState(callback, expectedState) {
  assertNonBlankString(expectedState, 'expectedState');
  const parsed = typeof callback === 'string' ? parseOAuthCallback(callback) : callback;
  if (!parsed || typeof parsed !== 'object') {
    throw new TypeError('callback must be a callback URL string or parsed callback object');
  }
  assertNonBlankString(parsed.state, 'callback.state');
  if (!equalState(parsed.state, expectedState)) {
    throw new Error('OAuth callback state mismatch');
  }
  return parsed;
}

function parseAndValidateOAuthCallback(callbackUrl, options = {}) {
  const expectedState = typeof options === 'string' ? options : options.expectedState;
  const expectedRedirectUri = typeof options === 'string'
    ? REDIRECT_URI
    : options.expectedRedirectUri || options.redirectUri || REDIRECT_URI;
  const parsed = validateOAuthCallbackRedirect(parseOAuthCallback(callbackUrl), expectedRedirectUri);
  validateOAuthCallbackState(parsed, expectedState);
  if (parsed.hasError || parsed.error) {
    const errorCode = parsed.error || 'invalid_error';
    throw new Error(`OAuth callback returned error: ${errorCode}${parsed.errorDescription ? `: ${parsed.errorDescription}` : ''}`);
  }
  assertNonBlankString(parsed.code, 'callback.code');
  return parsed;
}

function createOAuthSession(options = {}) {
  return createCodexPkceSession(options);
}

function validateOAuthCallback(session, callbackUrl) {
  return parseAndValidateOAuthCallback(callbackUrl, {
    expectedState: session?.state || '',
    expectedRedirectUri: session?.redirectUri || REDIRECT_URI,
  });
}

function decodeBase64UrlJson(segment, name = 'JWT payload') {
  assertNonBlankString(segment, name);
  if (!/^[A-Za-z0-9_-]+$/.test(segment) || segment.length % 4 === 1) {
    throw new TypeError(`${name} is not valid unpadded base64url`);
  }

  const bytes = Buffer.from(segment, 'base64url');
  if (bytes.length === 0 || bytes.toString('base64url') !== segment) {
    throw new TypeError(`${name} is not canonical base64url`);
  }

  let textValue;
  try {
    textValue = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new TypeError(`${name} is not valid UTF-8: ${error.message}`);
  }

  let value;
  try {
    value = JSON.parse(textValue);
  } catch (error) {
    throw new TypeError(`${name} is not valid JSON: ${error.message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} JSON must be an object`);
  }
  return value;
}

function decodeJwtPayload(token) {
  assertNonBlankString(token, 'token');
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new TypeError('token must be a three-segment compact JWT');
  }
  if (parts.some((part) => !/^[A-Za-z0-9_-]+$/.test(part))) {
    throw new TypeError('token contains a non-base64url JWT segment');
  }
  return decodeBase64UrlJson(parts[1], 'JWT payload');
}

function buildTokenRequestDescriptor(input = {}) {
  const code = firstDefined(input.code, input.oauthCode, input.callback?.code, input.oauth?.code);
  const codeVerifier = firstDefined(
    input.codeVerifier,
    input.code_verifier,
    input.oauth?.codeVerifier,
    input.oauth?.code_verifier,
  );
  const clientId = firstDefined(input.clientId, input.client_id, CLIENT_ID);
  const redirectUri = firstDefined(input.redirectUri, input.redirect_uri, input.oauth?.redirectUri, REDIRECT_URI);
  const tokenEndpoint = firstDefined(input.tokenEndpoint, input.token_endpoint, TOKEN_ENDPOINT);

  assertNonEmptyString(code, 'code');
  assertNonEmptyString(codeVerifier, 'codeVerifier');

  const bodyParams = {
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  };
  const body = new URLSearchParams(bodyParams).toString();

  return {
    method: 'POST',
    url: tokenEndpoint,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    cookies: {},
    body,
    bodyParams,
    contentType: 'application/x-www-form-urlencoded',
  };
}

function buildTokenRequest(session, code, options = {}) {
  return {
    index: options.index || -1455,
    expectStatus: 200,
    redirect: '',
    ...buildTokenRequestDescriptor({
      oauth: session,
      code,
      codeVerifier: session?.codeVerifier,
      clientId: session?.clientId,
      redirectUri: session?.redirectUri,
      tokenEndpoint: session?.tokenEndpoint,
    }),
  };
}

async function fetchTokenExecutor(request) {
  const response = await fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: 'manual',
  });
  return {
    request,
    response: {
      status: response.status,
      url: response.url,
      location: response.headers.get('location') || '',
      contentType: response.headers.get('content-type') || '',
      text: await response.text(),
    },
  };
}

function parseTokenResponseText(text) {
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw new Error('OAuth token response was not JSON: empty response body');
  }
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new TypeError('top-level JSON value must be an object');
    }
    return value;
  } catch (error) {
    throw new Error(`OAuth token response was not JSON: ${error.message}`);
  }
}

function validateTokenResponse(tokens) {
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) {
    throw new TypeError('OAuth token response JSON must be an object');
  }
  const missing = ['id_token', 'access_token'].filter((name) => (
    typeof tokens[name] !== 'string' || tokens[name].trim().length === 0
  ));
  if (missing.length > 0) {
    const error = new Error(`OAuth token response missing required field(s): ${missing.join(', ')}`);
    error.missing = missing;
    error.tokens = tokens;
    throw error;
  }
  if (
    tokens.refresh_token !== undefined
    && tokens.refresh_token !== null
    && typeof tokens.refresh_token !== 'string'
  ) {
    throw new Error('OAuth token response refresh_token must be a string when present');
  }
  return tokens;
}

function executorResponse(result) {
  const response = result?.response || result || {};
  return {
    status: response.status ?? result?.status ?? 0,
    url: response.url || result?.url || TOKEN_ENDPOINT,
    location: response.location || result?.location || '',
    contentType: response.contentType || result?.contentType || '',
    text: response.text ?? result?.text ?? result?.body ?? '',
  };
}

function sanitizedTokenError(value, secrets = []) {
  let sanitized = String(value || '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret) sanitized = sanitized.split(secret).join('<redacted>');
  }
  return sanitized
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<email>')
    .replace(/\b(?:eyJ|sess-|acct_|org-)[A-Za-z0-9_.-]{10,}\b/g, '<redacted>')
    .slice(0, 180);
}

function tokenExchangeError(response, tokens, request) {
  const nested = tokens?.error && typeof tokens.error === 'object' && !Array.isArray(tokens.error)
    ? tokens.error
    : {};
  const rawCode = nested.code
    || tokens?.code
    || (typeof tokens?.error === 'string' ? tokens.error : '')
    || 'OAUTH_TOKEN_EXCHANGE_FAILED';
  const rawMessage = nested.message
    || tokens?.error_description
    || tokens?.message
    || (typeof tokens?.error === 'string' ? tokens.error : '')
    || (tokens ? 'Token endpoint rejected the request' : 'Token endpoint returned a non-JSON error response');
  const code = String(rawCode).replace(/[^a-z0-9_]+/gi, '_').toUpperCase();
  const message = sanitizedTokenError(rawMessage, [request.bodyParams?.code, request.bodyParams?.code_verifier]);
  const error = new Error(`OAuth token exchange failed with ${response.status}: ${code}${message && message !== rawCode ? `: ${message}` : ''}`);
  error.code = code;
  error.status = Number(response.status || 0);
  error.diagnostics = {
    status: error.status,
    contentType: String(response.contentType || ''),
    errorCode: code,
    errorMessage: message,
    requestFields: Object.fromEntries(Object.entries(request.bodyParams || {}).map(([name, value]) => [name, typeof value])),
  };
  return error;
}

async function exchangeTokens(input = {}, options = {}) {
  const request = input.method && input.url ? input : buildTokenRequestDescriptor(input);
  const executor = options.executor || input.executor || fetchTokenExecutor;
  const result = await executor(request);
  const response = executorResponse(result);
  let tokens;

  try {
    tokens = result?.tokens === undefined
      ? parseTokenResponseText(response.text)
      : result.tokens;
  } catch (parseError) {
    if (response.status >= 200 && response.status < 300) {
      parseError.request = request;
      parseError.response = response;
      throw parseError;
    }
  }

  if (response.status < 200 || response.status >= 300) {
    throw tokenExchangeError(response, tokens, request);
  }

  try {
    validateTokenResponse(tokens);
  } catch (error) {
    error.request = request;
    error.response = response;
    throw error;
  }

  return {
    request,
    response,
    tokens,
  };
}

async function exchangeCodeForToken(session, callbackOrCode, options = {}) {
  const code = String(callbackOrCode || '').startsWith('http')
    ? validateOAuthCallback(session, callbackOrCode).code
    : callbackOrCode;
  return exchangeTokens(buildTokenRequest(session, code, options), options);
}

function redactOAuthSession(session, options = {}) {
  if (!session) return null;
  if (options.redact === false || options.raw === true) return { ...session };
  return {
    ...session,
    codeVerifier: session.codeVerifier ? '<redacted:code_verifier>' : '',
    code: session.code ? '<redacted:oauth_code>' : '',
    callback: session.callback ? {
      ...session.callback,
      code: session.callback.code ? '<redacted:oauth_code>' : '',
    } : undefined,
  };
}

module.exports = {
  AUTH_ENDPOINT,
  CLIENT_ID,
  CODEX_OAUTH_PROTOCOL,
  CODE_CHALLENGE_METHOD,
  ORIGINATOR,
  REDIRECT_URI,
  SCOPES,
  TOKEN_ENDPOINT,
  buildTokenRequestDescriptor,
  createCodexPkceSession,
  createOAuthSession,
  decodeJwtPayload,
  exchangeCodeForToken,
  exchangeTokens,
  generateCodeChallenge,
  generateCodeVerifier,
  generateState,
  parseAndValidateOAuthCallback,
  redactOAuthSession,
  validateOAuthCallback,
  validateTokenResponse,
};
