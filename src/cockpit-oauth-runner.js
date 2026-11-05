'use strict';

const crypto = require('node:crypto');
const { parse } = require('parse5');

const { cookieObjectFor, cookieRecords } = require('./cookie-jar');
const { tryParseJson } = require('./http-shape');
const { buildCpaAccount } = require('./cpa-output');
const {
  AUTH_ENDPOINT,
  CLIENT_ID,
  CODEX_OAUTH_PROTOCOL,
  CODE_CHALLENGE_METHOD,
  ORIGINATOR,
  REDIRECT_URI,
  SCOPES,
  TOKEN_ENDPOINT,
  createCodexPkceSession,
  decodeJwtPayload,
  exchangeCodeForToken,
  generateCodeChallenge,
  validateOAuthCallback,
} = require('./oauth-pkce');
const { UrlSession } = require('./url-session');
const {
  AUTH_BASE,
  CHATGPT_BASE,
  authStep,
  phoneChannelCapability,
  phoneSendPayload,
  trimSessionEvents,
} = require('./chatgpt-session-runner');

const CHATGPT_ACCOUNT_CHECK_URL = `${CHATGPT_BASE}/backend-api/accounts/check/v4-2023-04-27`;
const FIREFOX_DOCUMENT_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const ACCOUNT_SELECT_URL = `${AUTH_BASE}/api/accounts/session/select`;
const PRESERVE_EXPIRED_OAUTH_STEPS = new Set(['phone_required', 'phone_otp_sent', 'mfa_required', 'token_validating']);
const OAUTH_LOGIN_PAGE_PATTERN = /^\/(?:log-in(?:-or-create-account)?|email-verification)(?:\/|$)/i;

function shortHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function safeUrlShape(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value), AUTH_BASE);
    return {
      url: `${url.origin}${url.pathname}`,
      queryKeys: [...new Set([...url.searchParams.keys()])].sort(),
    };
  } catch {
    return null;
  }
}

function responseDiagnostics(result) {
  const text = String(result?.response?.text || '');
  const requestUrl = result?.request?.url || '';
  const responseUrl = result?.response?.url || '';
  const responseError = result?.json?.error;
  const errorCode = typeof responseError === 'object'
    ? responseError?.code
    : responseError;
  const errorType = typeof responseError === 'object'
    ? responseError?.type
    : '';
  const errorMessage = typeof responseError === 'object'
    ? responseError?.message
    : result?.json?.message;
  return {
    status: Number(result?.response?.status || 0),
    contentType: String(result?.response?.contentType || '').split(';', 1)[0].toLowerCase(),
    location: safeUrlShape(result?.response?.location),
    responseUrl: safeUrlShape(responseUrl),
    request: {
      method: String(result?.request?.method || ''),
      url: safeUrlShape(requestUrl),
    },
    history: Array.isArray(result?.history)
      ? result.history.slice(-8).map((item) => ({
        method: String(item?.method || ''),
        status: Number(item?.status || 0),
        url: safeUrlShape(item?.url),
        location: safeUrlShape(item?.location),
      }))
      : [],
    bodyBytes: Buffer.byteLength(text),
    bodyHash: text ? shortHash(text) : '',
    errorCode: redactOAuthDetail(errorCode),
    errorType: redactOAuthDetail(errorType),
    errorMessage: redactOAuthDetail(errorMessage),
  };
}

function authCookieDiagnostics(cookieJar) {
  const active = new Set(Object.keys(cookieObjectFor(cookieJar, `${AUTH_BASE}/`)));
  return cookieRecords(cookieJar)
    .filter((cookie) => active.has(cookie.key))
    .map((cookie) => ({
      name: cookie.key,
      domain: cookie.domain,
      creation: cookie.creation || '',
      expires: cookie.expires || '',
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

function documentNavigationHeaders(options = {}) {
  return {
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': options.site || 'same-origin',
    ...(options.userInitiated ? { 'Sec-Fetch-User': '?1' } : {}),
    'Upgrade-Insecure-Requests': '1',
  };
}

function apiFetchHeaders() {
  return {
    Accept: 'application/json',
    'Sec-Fetch-Dest': 'empty',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Site': 'same-origin',
  };
}

function nodeAttribute(node, name) {
  return String(node?.attrs?.find((attribute) => attribute.name === name)?.value || '');
}

function nodeText(node) {
  if (!node) return '';
  if (node.nodeName === '#text') return String(node.value || '');
  return (node.childNodes || []).map(nodeText).join(' ');
}

function nodeHint(node) {
  const descriptive = [
    nodeAttribute(node, 'aria-label'),
    nodeAttribute(node, 'title'),
    nodeAttribute(node, 'data-email'),
    nodeAttribute(node, 'data-account-email'),
    nodeText(node),
  ].filter(Boolean);
  if (!descriptive.length) descriptive.push(nodeAttribute(node, 'value'));
  return descriptive.join(' ').replace(/\s+/g, ' ').trim();
}

function visitNodes(node, visitor) {
  if (!node) return;
  visitor(node);
  for (const child of node.childNodes || []) visitNodes(child, visitor);
}

function accountChoicesFromHtml(html) {
  const document = parse(String(html || ''));
  const choices = [];
  visitNodes(document, (node) => {
    if (node.tagName !== 'form') return;
    let action;
    try { action = new URL(nodeAttribute(node, 'action') || '/choose-an-account', AUTH_BASE); } catch { return; }
    const pathname = action.pathname;
    if (action.origin !== AUTH_BASE || pathname !== '/choose-an-account' || nodeAttribute(node, 'method').toLowerCase() !== 'post') return;
    const hidden = {};
    visitNodes(node, (candidate) => {
      if (candidate.tagName !== 'input' || nodeAttribute(candidate, 'type').toLowerCase() !== 'hidden') return;
      const name = nodeAttribute(candidate, 'name').trim();
      if (name) hidden[name] = nodeAttribute(candidate, 'value');
    });
    const intent = hidden.intent
      || nodeAttribute(node, 'data-intent')
      || 'select';
    const choicesBefore = choices.length;
    visitNodes(node, (candidate) => {
      const tag = String(candidate.tagName || '').toLowerCase();
      const type = nodeAttribute(candidate, 'type').toLowerCase();
      if (!['button', 'input'].includes(tag) || nodeAttribute(candidate, 'name') !== 'session_id') return;
      if (tag === 'input' && type && !['submit', 'button'].includes(type)) return;
      const sessionId = nodeAttribute(candidate, 'value').trim();
      if (!sessionId) return;
      choices.push({
        intent,
        sessionId,
        label: nodeHint(candidate),
      });
    });
    if (choices.length === choicesBefore && hidden.session_id) {
      choices.push({
        intent,
        sessionId: hidden.session_id,
        label: nodeHint(node),
      });
    }
  });
  return choices;
}

function matchingAccountChoice(html, email) {
  const choices = accountChoicesFromHtml(html);
  const expected = String(email || '').trim().toLowerCase();
  const matches = choices.filter((choice) => {
    const addresses = choice.label.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/gi) || [];
    return expected && addresses.some((address) => address.toLowerCase() === expected);
  });
  if (matches.length !== 1 || matches[0].intent !== 'select') {
    const error = new Error(matches.length > 1
      ? 'OAuth account chooser returned more than one matching login state'
      : 'OAuth account chooser did not contain the requested login state');
    error.code = 'OAUTH_ACCOUNT_SELECTION_MISMATCH';
    throw error;
  }
  return matches[0];
}

function workspacesFrom(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) {
    return value.flatMap((item) => workspacesFrom(item, seen));
  }
  const direct = Array.isArray(value.workspaces) ? value.workspaces : [];
  const nested = Object.values(value).flatMap((item) => workspacesFrom(item, seen));
  return [...direct, ...nested].filter((item) => item && typeof item === 'object' && item.id);
}

function currentWorkspaceIdFrom(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return '';
  seen.add(value);
  if (!Array.isArray(value)) {
    const direct = String(value.current_workspace_id || value.currentWorkspaceId || '').trim();
    if (direct) return direct;
  }
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    const nested = currentWorkspaceIdFrom(item, seen);
    if (nested) return nested;
  }
  return '';
}

function uniqueWorkspaces(candidates = []) {
  const byId = new Map();
  for (const candidate of candidates) {
    const id = String(candidate?.id || '').trim();
    if (id && !byId.has(id)) byId.set(id, candidate);
  }
  return [...byId.values()];
}

function matchingWorkspaceId(candidates, state, currentWorkspaceId = '') {
  const workspaces = uniqueWorkspaces(candidates);
  const accountId = String(state.accountId || '').trim();
  const accountMatches = accountId ? workspaces.filter((workspace) => [
    workspace.id,
    workspace.account_id,
    workspace.accountId,
  ].some((value) => String(value || '').trim() === accountId)) : [];
  if (accountMatches.length === 1) return String(accountMatches[0].id);
  if (accountMatches.length > 1) return '';
  for (const preferred of [currentWorkspaceId, state.workspaceId]) {
    const normalized = String(preferred || '').trim();
    if (!normalized) continue;
    const match = workspaces.find((workspace) => String(workspace.id || '').trim() === normalized);
    if (match) return String(match.id);
  }
  return workspaces.length === 1 ? String(workspaces[0].id) : '';
}

function tokenAccountId(tokens = {}) {
  const payloads = [];
  for (const token of [tokens.access_token, tokens.id_token]) {
    if (!token) continue;
    const payload = decodeJwtPayload(token);
    payloads.push(payload, payload['https://api.openai.com/auth'] || {});
  }
  const ids = payloads.flatMap((payload) => [
    payload.account_id,
    payload.chatgpt_account_id,
  ]).map((value) => String(value || '').trim()).filter(Boolean);
  return [...new Set(ids)];
}

function accountIdFromJson(value = {}) {
  const candidates = [
    value.account_id,
    value.accountId,
    value.chatgpt_account_id,
    value.chatgptAccountId,
    value.account?.id,
    value.account?.account_id,
    value.user?.account_id,
    value.user?.accountId,
  ];
  return candidates.map((candidate) => String(candidate || '').trim()).find(Boolean) || '';
}

function oauthContinuationUrl(value, oauth) {
  if (!value) return '';
  let url;
  try { url = new URL(String(value), AUTH_BASE); } catch {
    const error = new Error('OAuth continuation URL is malformed');
    error.code = 'OAUTH_CONTINUATION_URL_INVALID';
    throw error;
  }
  if ([AUTH_BASE, CHATGPT_BASE].includes(url.origin) || (oauth && isCallback(url.toString(), oauth))) return url.toString();
  const error = new Error(`OAuth continuation origin is not allowed: ${url.origin}`);
  error.code = 'OAUTH_CONTINUATION_ORIGIN_INVALID';
  throw error;
}

function isCallback(url, oauth) {
  try {
    const candidate = new URL(url);
    const expected = new URL(oauth.redirectUri);
    return candidate.protocol === expected.protocol
      && candidate.hostname === expected.hostname
      && candidate.port === expected.port
      && candidate.pathname === expected.pathname;
  } catch {
    return false;
  }
}

function sameScope(actual, expected) {
  const normalize = (value) => [...new Set(String(value || '').split(/\s+/).filter(Boolean))].sort();
  return JSON.stringify(normalize(actual)) === JSON.stringify(normalize(expected));
}

function hasCodexOAuthContract(oauth, options = {}) {
  if (
    oauth?.protocol !== CODEX_OAUTH_PROTOCOL
    || oauth.clientId !== CLIENT_ID
    || oauth.authEndpoint !== AUTH_ENDPOINT
    || oauth.tokenEndpoint !== TOKEN_ENDPOINT
    || oauth.redirectUri !== REDIRECT_URI
    || typeof oauth.codeVerifier !== 'string'
    || !oauth.codeVerifier.trim()
    || typeof oauth.state !== 'string'
    || !oauth.state.trim()
    || !sameScope(oauth.scope, SCOPES.join(' '))
    || !Number.isFinite(Date.parse(oauth.expiresAt || ''))
    || (!options.allowExpired && Date.parse(oauth.expiresAt) <= Date.now())
  ) return false;
  try {
    const authorize = new URL(oauth.authorizeUrl);
    return `${authorize.origin}${authorize.pathname}` === AUTH_ENDPOINT
      && authorize.searchParams.get('client_id') === CLIENT_ID
      && authorize.searchParams.get('redirect_uri') === REDIRECT_URI
      && authorize.searchParams.get('response_type') === 'code'
      && authorize.searchParams.get('state') === oauth.state
      && authorize.searchParams.get('code_challenge_method') === CODE_CHALLENGE_METHOD
      && authorize.searchParams.get('code_challenge') === generateCodeChallenge(oauth.codeVerifier)
      && sameScope(authorize.searchParams.get('scope'), oauth.scope)
      && authorize.searchParams.get('id_token_add_organizations') === 'true'
      && authorize.searchParams.get('codex_cli_simplified_flow') === 'true'
      && authorize.searchParams.get('originator') === ORIGINATOR;
  } catch {
    return false;
  }
}

function redactOAuthDetail(value) {
  return String(value || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<email>')
    .replace(/\b(?:eyJ|sess-|acct_|org-)[A-Za-z0-9_.-]{10,}\b/g, '<redacted>')
    .slice(0, 180);
}

function oauthError(operation, result) {
  const contentType = String(result?.response?.contentType || '').toLowerCase();
  const responseText = contentType.includes('text/html')
    ? 'HTML response'
    : String(result?.response?.text || '')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<email>')
      .replace(/\b(?:eyJ|sess-|acct_|org-)[A-Za-z0-9_.-]{10,}\b/g, '<redacted>')
      .slice(0, 160);
  const rawDetail = result?.json?.error?.code
    || result?.json?.error
    || result?.json?.message
    || responseText
    || 'unknown response';
  const detail = redactOAuthDetail(
    typeof rawDetail === 'string' ? rawDetail : JSON.stringify(rawDetail),
  );
  const error = new Error(`${operation} failed with HTTP ${result?.response?.status || 0}: ${detail}`);
  error.code = String(result?.json?.error?.code || `${operation}_failed`).replace(/[^a-z0-9_]+/gi, '_').toUpperCase();
  error.status = Number(result?.response?.status || 0);
  error.diagnostics = responseDiagnostics(result);
  return error;
}

function classifyAccountSelectionError(error) {
  const diagnostics = error?.diagnostics || {};
  if (
    error?.code === 'OAUTH_ACCOUNT_SELECT_FAILED'
    && Number(error.status || 0) >= 500
    && Number(diagnostics.bodyBytes || 0) === 0
    && !String(diagnostics.contentType || '').trim()
  ) {
    error.code = 'OAUTH_ACCOUNT_SELECT_HTTP_FAILED';
    error.message = 'OAuth account selection returned an empty HTTP 500; retrying the same authenticated session';
    error.retryable = true;
    error.waitPhase = 'waiting_oauth_account_selection_retry';
    error.accountSelectionFailure = true;
  }
  return error;
}

// Per-transaction scratch that auth.openai.com leaves on the auth domain while
// a login/authorize handshake is in flight. Carrying a spent set into a brand
// new PKCE transaction makes `/oauth/authorize` resume the old handshake — it
// hands the request to the raw Hydra endpoint and then to the login challenge —
// instead of taking the `/choose-an-account` fast path a live session gets.
//
// The session cookies themselves (`oai-client-auth-session`, `usc_*`,
// `unified_session_manifest`, `oai-did`, Cloudflare's) are deliberately kept:
// those are what proves the account is still signed in.
// Narrowed deliberately: `hydra_redirect` and the login CSRF token belong to one
// handshake and are worthless to the next. `rg_context` / `iss_context` look
// like session routing rather than scratch, and dropping them could be what
// makes a live session unresolvable — they stay until there is evidence either
// way, because the cost of guessing wrong here is an account that cannot OAuth.
const AUTH_HANDSHAKE_COOKIES = [/^hydra_redirect$/, /^oai-login-csrf/];

/**
 * Drops the in-flight handshake cookies from a serialized jar.
 *
 * Only safe when a fresh transaction is about to start, which is exactly when
 * `makeInitialCockpitOAuthState` is called — a resumed state reuses its own
 * `cookieJar` and never passes back through here.
 */
function withoutAuthHandshakeCookies(cookieJar) {
  if (!cookieJar) return cookieJar;
  const parsed = typeof cookieJar === 'string' ? tryParseJson(cookieJar) : cookieJar;
  if (!parsed || !Array.isArray(parsed.cookies)) return cookieJar;
  const kept = parsed.cookies.filter((cookie) => !(
    String(cookie?.domain || '').endsWith('auth.openai.com')
    && AUTH_HANDSHAKE_COOKIES.some((pattern) => pattern.test(String(cookie?.key || '')))
  ));
  if (kept.length === parsed.cookies.length) return cookieJar;
  const next = { ...parsed, cookies: kept };
  return typeof cookieJar === 'string' ? JSON.stringify(next) : next;
}

function makeInitialCockpitOAuthState(options = {}) {
  return {
    schemaVersion: 3,
    mode: 'cockpit-oauth',
    step: 'initial',
    status: 'running',
    oauth: options.oauth || createCodexPkceSession(),
    cookieJar: withoutAuthHandshakeCookies(options.cookieJar),
    clientProfile: options.clientProfile,
    clientProfileFingerprint: options.clientProfileFingerprint || '',
    oaiDid: options.oaiDid || '',
    email: options.email || '',
    accountId: options.accountId || '',
    workspaceId: options.workspaceId || '',
    nextUrl: '',
    callbackUrl: '',
    oauthCode: '',
    tokens: null,
    tokenExchange: null,
    tokenValidation: null,
    account: null,
    phoneChallenge: null,
    accountSelection: null,
    accountSelectionHistory: [],
    events: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

class CockpitOAuthRunner {
  constructor(options = {}) {
    this.options = options;
  }

  session(state) {
    return new UrlSession({
      cookieJar: state.cookieJar,
      clientProfile: state.clientProfile,
      proxy: this.options.proxy,
      signal: this.options.signal,
      executor: this.options.executor,
    });
  }

  tokenSession(state) {
    return new UrlSession({
      clientProfile: state.clientProfile,
      proxy: this.options.proxy,
      signal: this.options.signal,
      executor: this.options.executor,
    });
  }

  async checkpoint(state, session, type, details = {}) {
    state.cookieJar = session.serializeCookies();
    state.updatedAt = new Date().toISOString();
    const event = { at: state.updatedAt, type, ...details };
    state.events.push(event);
    // Same bound as the registration session: this trace rides along in the run
    // state that every checkpoint rewrites in full.
    trimSessionEvents(state.events);
    if (typeof this.options.onEvent === 'function') await this.options.onEvent(event, state);
    if (typeof this.options.checkpoint === 'function') await this.options.checkpoint(type, state);
  }

  async request(session, operation, method, url, options = {}) {
    let result = await session.request(method, url, options);
    let status = Number(result.response?.status || 0);
    const challenged = status === 403 && /cloudflare|just a moment|cdn-cgi/i.test(result.response?.text || '');
    if (challenged && typeof this.options.solveCloudflare === 'function') {
      await this.options.solveCloudflare(url, session, result);
      result = await session.request(method, url, options);
      status = Number(result.response?.status || 0);
    }
    if (status < 200 || status >= 400) throw oauthError(operation, result);
    return result;
  }

  resetAuthorizationState(state) {
    if (state.accountSelection) {
      state.accountSelectionHistory = [...(state.accountSelectionHistory || []), state.accountSelection].slice(-4);
    }
    state.schemaVersion = 3;
    state.oauth = createCodexPkceSession();
    state.step = 'initial';
    state.status = 'running';
    state.nextUrl = '';
    state.callbackUrl = '';
    state.oauthCode = '';
    state.tokens = null;
    state.tokenExchange = null;
    state.tokenValidation = null;
    state.account = null;
    state.phoneChallenge = null;
    state.accountSelection = null;
    state.workspaceId = '';
  }

  async ensureCockpitProtocol(state, session) {
    if (hasCodexOAuthContract(state.oauth)) return;
    if (
      PRESERVE_EXPIRED_OAUTH_STEPS.has(state.step)
      && hasCodexOAuthContract(state.oauth, { allowExpired: true })
    ) {
      await this.checkpoint(state, session, 'oauth_protocol_expired_preserved', { step: state.step });
      return;
    }
    this.resetAuthorizationState(state);
    await this.checkpoint(state, session, 'oauth_protocol_migrated', {
      protocol: CODEX_OAUTH_PROTOCOL,
      reason: 'non_cockpit_or_invalid_oauth_contract',
    });
  }

  async beginCockpitOAuth(state, session) {
    if (!hasCodexOAuthContract(state.oauth)) {
      const error = new Error('Cockpit OAuth PKCE contract is invalid before authorization');
      error.code = 'OAUTH_COCKPIT_CONTRACT_INVALID';
      throw error;
    }
    state.nextUrl = state.oauth.authorizeUrl;
    state.step = 'navigating';
    await this.checkpoint(state, session, 'oauth_authorization_started', {
      protocol: state.oauth.protocol,
      clientId: state.oauth.clientId,
      authorizeUrl: safeUrlShape(state.oauth.authorizeUrl),
    });
  }

  captureCallback(state, nextUrl) {
    const callback = validateOAuthCallback(state.oauth, nextUrl);
    state.callbackUrl = nextUrl;
    state.oauthCode = callback.code;
    state.oauth = { ...state.oauth, code: callback.code, callback, callbackUrl: nextUrl };
    state.step = 'callback_received';
  }

  async captureCallbackResult(state, session, result, candidates = []) {
    const callbackUrl = [
      result?.redirectUrl,
      result?.response?.location,
      result?.response?.url,
      ...candidates,
    ].find((candidate) => candidate && isCallback(candidate, state.oauth));
    if (!callbackUrl) return false;
    this.captureCallback(state, callbackUrl);
    await this.checkpoint(state, session, 'oauth_callback_received');
    return true;
  }

  async workspaceId(state, session, json = {}) {
    let candidates = workspacesFrom(json);
    let currentWorkspaceId = currentWorkspaceIdFrom(json);
    let selected = matchingWorkspaceId(candidates, state, currentWorkspaceId);
    if (selected) return selected;
    try {
      const dump = await this.request(session, 'client_auth_session_dump', 'GET', `${AUTH_BASE}/api/accounts/client_auth_session_dump`, {
        referer: state.nextUrl || `${AUTH_BASE}/sign-in-with-chatgpt/codex/consent`,
        headers: { Accept: 'application/json' },
      });
      candidates = uniqueWorkspaces([...candidates, ...workspacesFrom(dump.json)]);
      currentWorkspaceId = currentWorkspaceId || currentWorkspaceIdFrom(dump.json);
      selected = matchingWorkspaceId(candidates, state, currentWorkspaceId);
      if (selected) return selected;
    } catch (error) {
      if (![401, 403, 404].includes(Number(error.status || 0))) throw error;
    }
    if (uniqueWorkspaces(candidates).length > 1) {
      const error = new Error('Cockpit OAuth exposed multiple workspaces without a deterministic account match');
      error.code = 'OAUTH_WORKSPACE_AMBIGUOUS';
      throw error;
    }
    return String(state.workspaceId || '');
  }

  async selectWorkspace(state, session, json = {}) {
    const workspaceId = await this.workspaceId(state, session, json);
    if (!workspaceId) {
      const error = new Error('Cockpit OAuth consent did not expose a workspace ID');
      error.code = 'OAUTH_WORKSPACE_MISSING';
      throw error;
    }
    // Workspace selection is a plain consent continuation; it is not an account-creation consumer.
    const selected = await this.request(session, 'workspace_select', 'POST', `${AUTH_BASE}/api/accounts/workspace/select`, {
      origin: AUTH_BASE,
      referer: state.nextUrl || `${AUTH_BASE}/sign-in-with-chatgpt/codex/consent`,
      headers: apiFetchHeaders(),
      json: { workspace_id: workspaceId },
    });
    state.workspaceId = workspaceId;
    state.nextUrl = oauthContinuationUrl(authStep(selected.json).continueUrl || selected.response.location, state.oauth);
    await this.checkpoint(state, session, 'oauth_workspace_selected', { workspaceId });
  }

  async consentPage(state, session) {
    const page = new URL(state.nextUrl, AUTH_BASE);
    if (!page.pathname.endsWith('.data')) page.pathname = `${page.pathname}.data`;
    if (!page.searchParams.has('_routes')) page.searchParams.set('_routes', 'SIGN_IN_WITH_CHATGPT_CODEX_CONSENT');
    const data = await this.request(session, 'oauth_consent_data', 'GET', page.toString(), {
      referer: state.nextUrl,
      headers: { Accept: 'application/json' },
    });
    await this.selectWorkspace(state, session, data.json);
  }

  async chooseAccount(state, session, pageResult, currentUrl) {
    const choice = matchingAccountChoice(pageResult.response?.text, state.email);
    const pending = {
      status: 'pending',
      startedAt: new Date().toISOString(),
      action: safeUrlShape(ACCOUNT_SELECT_URL),
      requestFields: ['session_id'],
      choiceFingerprint: shortHash(choice.sessionId),
      authCookies: authCookieDiagnostics(session.serializeCookies()),
    };
    state.accountSelection = pending;
    state.step = 'account_select_pending';
    await this.checkpoint(state, session, 'oauth_account_selection_pending', pending);
    let selected;
    try {
      selected = await this.request(session, 'oauth_account_select', 'POST', ACCOUNT_SELECT_URL, {
        origin: AUTH_BASE,
        referer: currentUrl,
        headers: apiFetchHeaders(),
        json: { session_id: choice.sessionId },
        follow: false,
      });
    } catch (error) {
      classifyAccountSelectionError(error);
      state.accountSelection = {
        ...pending,
        status: 'failed',
        failedAt: new Date().toISOString(),
        response: error.diagnostics || null,
      };
      await this.checkpoint(state, session, 'oauth_account_selection_failed', {
        choiceFingerprint: pending.choiceFingerprint,
        response: error.diagnostics || null,
      });
      throw error;
    }
    state.accountSelection = {
      ...pending,
      status: 'accepted',
      completedAt: new Date().toISOString(),
      response: responseDiagnostics(selected),
    };
    const step = authStep(selected.json);
    if (await this.captureCallbackResult(state, session, selected, [step.continueUrl])) return;
    const nextUrl = step.continueUrl
      || selected.response?.location
      || '';
    const continuation = oauthContinuationUrl(nextUrl, state.oauth);
    if (!continuation || new URL(continuation).pathname === '/choose-an-account') {
      state.accountSelection = {
        ...state.accountSelection,
        status: 'rejected',
        failedAt: new Date().toISOString(),
        response: responseDiagnostics(selected),
      };
      await this.checkpoint(state, session, 'oauth_account_selection_rejected', {
        choiceFingerprint: pending.choiceFingerprint,
        response: state.accountSelection.response,
      });
      const error = new Error('OAuth account selection did not advance the authorization session');
      error.code = 'OAUTH_ACCOUNT_SELECTION_REJECTED';
      throw error;
    }
    state.nextUrl = continuation;
    if (/\/(?:add-phone|phone-verification)(?:\/|$)/i.test(new URL(state.nextUrl).pathname)) {
      state.phoneChallenge = {
        multiChannelAllowed: phoneChannelCapability(selected.json, session.serializeCookies()),
      };
      state.step = 'phone_required';
      await this.checkpoint(state, session, 'oauth_phone_required');
      return;
    }
    if (/\/mfa-challenge(?:\/|$)/i.test(new URL(state.nextUrl).pathname)) {
      state.step = 'mfa_required';
      await this.checkpoint(state, session, 'oauth_mfa_required');
      const error = new Error('Cockpit OAuth reached an MFA challenge after account selection');
      error.code = 'OAUTH_MFA_REQUIRED';
      throw error;
    }
    state.step = 'navigating';
    await this.checkpoint(state, session, 'oauth_account_selected');
  }

  async navigate(state, session) {
    state.nextUrl = state.nextUrl || state.oauth.authorizeUrl;
    // `/api/accounts/login?login_challenge=` is Hydra's login endpoint, not a
    // login *page*: with a live auth-domain session it accepts the challenge
    // and bounces straight back with a verifier. Following it can therefore
    // recover, but a dead session would ping-pong, so the hops are counted.
    let loginChallengeHops = 0;
    for (let index = 0; index < 28; index += 1) {
      if (!state.nextUrl) throw new Error('Cockpit OAuth navigation lost the next URL');
      if (isCallback(state.nextUrl, state.oauth)) {
        this.captureCallback(state, state.nextUrl);
        await this.checkpoint(state, session, 'oauth_callback_received');
        return;
      }
      const current = new URL(state.nextUrl, AUTH_BASE);
      if (/\/(?:about-you|create-account)(?:\/|$)/i.test(current.pathname)) {
        const error = new Error('OAuth source must already be a registered account; account creation is not allowed in this branch');
        error.code = 'OAUTH_EXISTING_ACCOUNT_REQUIRED';
        throw error;
      }
      // These are the rendered pages a browser shows a signed-out human;
      // reaching one means the saved session did not carry into OAuth.
      if (OAUTH_LOGIN_PAGE_PATTERN.test(current.pathname)) {
        const error = new Error('OAuth requires an existing authenticated account session');
        error.code = 'OAUTH_LOGIN_REQUIRED';
        throw error;
      }
      // The login endpoint is followed rather than assumed fatal. A valid
      // session resolves the challenge here and the loop carries on; a dead one
      // redirects to `/log-in`, which the check above then reports. Bailing on
      // sight used to fail accounts whose session was in fact fine, and burned
      // the single login repair on a diagnosis that could not be right.
      if (current.pathname === '/api/accounts/login') {
        loginChallengeHops += 1;
        if (loginChallengeHops > 2) {
          const error = new Error('OAuth login challenge did not resolve into an authenticated session');
          error.code = 'OAUTH_LOGIN_REQUIRED';
          error.diagnostics = { loginChallengeHops, url: current.toString() };
          throw error;
        }
        await this.checkpoint(state, session, 'oauth_login_challenge_followed', {
          attempt: loginChallengeHops,
          message: 'Authorization was handed to the login challenge endpoint; following it to see whether the saved session resolves it',
        });
      }
      if (/\/(?:add-phone|phone-verification)(?:\/|$)/i.test(current.pathname)) {
        state.step = 'phone_required';
        await this.checkpoint(state, session, 'oauth_phone_required');
        return;
      }
      if (/\/mfa-challenge(?:\/|$)/i.test(current.pathname)) {
        state.step = 'mfa_required';
        await this.checkpoint(state, session, 'oauth_mfa_required');
        const error = new Error('Cockpit OAuth requires an MFA challenge that must be completed during login-state repair');
        error.code = 'OAUTH_MFA_REQUIRED';
        throw error;
      }
      if (/\/sign-in-with-chatgpt\/codex\/consent(?:\.data)?$/i.test(current.pathname)) {
        await this.consentPage(state, session);
        continue;
      }

      const result = await this.request(session, 'oauth_navigate', 'GET', current.toString(), {
        follow: false,
        referer: `${AUTH_BASE}/`,
        accept: FIREFOX_DOCUMENT_ACCEPT,
        headers: documentNavigationHeaders(),
      });
      const location = result.response.location
        ? oauthContinuationUrl(result.response.location, state.oauth)
        : '';
      const step = authStep(result.json);
      if (await this.captureCallbackResult(state, session, result, [location, step.continueUrl])) return;
      const responseUrl = new URL(result.response?.url || current.toString(), AUTH_BASE);
      if (responseUrl.pathname === '/choose-an-account') {
        if (Number(result.response?.status || 0) === 200) {
          await this.chooseAccount(state, session, result, responseUrl.toString());
          if (state.step !== 'navigating') return;
          continue;
        }
        const error = new Error('Cockpit OAuth account chooser returned an unsupported response');
        error.code = 'OAUTH_UNEXPECTED_ACCOUNT_CHOOSER';
        error.retryable = false;
        error.diagnostics = responseDiagnostics(result);
        throw error;
      }
      const candidates = uniqueWorkspaces(workspacesFrom(result.json));
      const currentWorkspaceId = currentWorkspaceIdFrom(result.json);
      if (currentWorkspaceId) state.workspaceId = currentWorkspaceId;
      else if (candidates.length === 1) state.workspaceId = String(candidates[0].id);
      if (step.pageType === 'add_phone' || /\/(?:add-phone|phone-verification)/i.test(step.continueUrl || location)) {
        state.nextUrl = oauthContinuationUrl(step.continueUrl || location, state.oauth);
        state.phoneChallenge = {
          multiChannelAllowed: phoneChannelCapability(result.json, session.serializeCookies()),
        };
        state.step = 'phone_required';
        await this.checkpoint(state, session, 'oauth_phone_required');
        return;
      }
      if (step.pageType === 'workspace_select') {
        state.nextUrl = current.toString();
        await this.selectWorkspace(state, session, result.json);
        continue;
      }
      state.nextUrl = location || oauthContinuationUrl(step.continueUrl, state.oauth);
      if (!state.nextUrl && result.response.status === 200) {
        const error = new Error(`Cockpit OAuth stopped at an unsupported page: ${current.pathname}`);
        error.code = 'OAUTH_UNSUPPORTED_PAGE';
        throw error;
      }
      await this.checkpoint(state, session, 'oauth_redirect', { status: result.response.status, nextUrl: safeUrlShape(state.nextUrl) });
    }
    throw new Error('Cockpit OAuth navigation exceeded its step limit');
  }

  async sendPhone(state, phone) {
    const session = this.session(state);
    const explicitCapability = state.phoneChallenge?.multiChannelAllowed;
    const phoneRequest = phoneSendPayload(
      phone,
      typeof explicitCapability === 'boolean'
        ? { 'oai-client-auth-session': { multi_channel_allowed: explicitCapability } }
        : {},
      session.serializeCookies(),
    );
    state.phoneChallenge = {
      ...(state.phoneChallenge || {}),
      multiChannelAllowed: phoneRequest.multiChannelAllowed,
      channelIncluded: Object.hasOwn(phoneRequest.payload, 'channel'),
    };
    const result = await this.request(session, 'oauth_phone_send', 'POST', `${AUTH_BASE}/api/accounts/add-phone/send`, {
      origin: AUTH_BASE,
      referer: `${AUTH_BASE}/add-phone`,
      headers: apiFetchHeaders(),
      json: phoneRequest.payload,
    });
    const step = authStep(result.json);
    state.nextUrl = oauthContinuationUrl(step.continueUrl || result.response?.location || `${AUTH_BASE}/phone-verification`, state.oauth);
    state.step = 'phone_otp_sent';
    await this.checkpoint(state, session, 'oauth_phone_otp_sent', {
      channelIncluded: state.phoneChallenge.channelIncluded,
      multiChannelAllowed: state.phoneChallenge.multiChannelAllowed,
    });
    return state;
  }

  async validatePhone(state, code) {
    const session = this.session(state);
    const result = await this.request(session, 'oauth_phone_validate', 'POST', `${AUTH_BASE}/api/accounts/phone-otp/validate`, {
      origin: AUTH_BASE,
      referer: `${AUTH_BASE}/phone-verification`,
      headers: apiFetchHeaders(),
      json: { code: String(code) },
    });
    const step = authStep(result.json);
    const nextUrl = step.continueUrl || result.response?.location || '';
    if (!nextUrl) {
      const error = new Error('OAuth phone verification did not return a continuation URL');
      error.code = 'OAUTH_PHONE_CONTINUATION_MISSING';
      throw error;
    }
    state.nextUrl = oauthContinuationUrl(nextUrl, state.oauth);
    if (isCallback(state.nextUrl, state.oauth)) {
      this.captureCallback(state, state.nextUrl);
      await this.checkpoint(state, session, 'oauth_callback_received');
    } else {
      state.step = 'navigating';
      await this.checkpoint(state, session, 'oauth_phone_validated');
    }
    return state;
  }

  async exchange(state, session) {
    state.step = 'token_exchange_pending';
    state.tokenExchange = {
      status: 'pending',
      startedAt: new Date().toISOString(),
    };
    await this.checkpoint(state, session, 'oauth_token_exchange_pending');
    const tokenSession = this.tokenSession(state);
    const result = await exchangeCodeForToken(state.oauth, state.oauthCode, {
      executor: async (request) => tokenSession.once(request.method, request.url, {
        headers: request.headers,
        body: request.body,
        contentType: request.contentType,
      }),
    });
    if (typeof result.tokens.refresh_token !== 'string' || !result.tokens.refresh_token.trim()) {
      const error = new Error('Cockpit OAuth token response did not include a refresh token');
      error.code = 'OAUTH_REFRESH_TOKEN_MISSING';
      throw error;
    }
    state.tokens = result.tokens;
    state.oauthCode = '';
    state.callbackUrl = '';
    state.oauth = {
      ...state.oauth,
      code: '',
      callback: undefined,
      callbackUrl: '',
    };
    state.tokenExchange = {
      status: 'received',
      protocol: state.oauth.protocol,
      receivedAt: new Date().toISOString(),
    };
    state.step = 'token_validating';
    await this.checkpoint(state, session, 'oauth_tokens_received');
  }

  async validateTokens(state, session) {
    let account = buildCpaAccount({
      email: state.email,
      accountId: state.accountId,
      tokens: state.tokens,
      completedAt: new Date().toISOString(),
    });
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${account.access_token}`,
      'oai-device-id': state.oaiDid,
    };
    const bearerSession = this.tokenSession(state);
    const me = await this.request(bearerSession, 'oauth_token_me', 'GET', `${CHATGPT_BASE}/backend-api/me`, {
      origin: CHATGPT_BASE,
      referer: `${CHATGPT_BASE}/`,
      headers,
    });
    const checked = await this.request(bearerSession, 'oauth_token_account_check', 'GET', CHATGPT_ACCOUNT_CHECK_URL, {
      origin: CHATGPT_BASE,
      referer: `${CHATGPT_BASE}/`,
      headers,
    });
    const verifiedEmail = String(me.json?.email || me.json?.user?.email || '').trim();
    if (verifiedEmail && verifiedEmail.toLowerCase() !== account.email.toLowerCase()) {
      const error = new Error('OAuth Bearer identity does not match the selected login state');
      error.code = 'OAUTH_TOKEN_IDENTITY_MISMATCH';
      throw error;
    }
    const selectedAccountId = String(state.accountId || '').trim();
    const tokenAccountIds = tokenAccountId(state.tokens);
    const verifiedAccountId = accountIdFromJson(me.json);
    const checkedAccountId = accountIdFromJson(checked.json);
    const observedAccountIds = [...new Set([...tokenAccountIds, verifiedAccountId, checkedAccountId].filter(Boolean))];
    if (selectedAccountId && observedAccountIds.some((id) => id !== selectedAccountId)) {
      const error = new Error('OAuth Bearer account does not match the selected login state');
      error.code = 'OAUTH_TOKEN_IDENTITY_MISMATCH';
      throw error;
    }
    if (observedAccountIds.length > 1) {
      const error = new Error('OAuth Bearer account identifiers disagree across token and account endpoints');
      error.code = 'OAUTH_TOKEN_IDENTITY_MISMATCH';
      throw error;
    }
    if (selectedAccountId && observedAccountIds.length === 0) {
      const error = new Error('OAuth Bearer account could not be bound to the selected login state');
      error.code = 'OAUTH_TOKEN_ACCOUNT_UNVERIFIED';
      throw error;
    }
    if (!account.account_id && observedAccountIds[0]) {
      account = buildCpaAccount({
        email: state.email,
        accountId: observedAccountIds[0],
        tokens: state.tokens,
        completedAt: new Date().toISOString(),
      });
    }
    state.account = account;
    state.tokenValidation = {
      meStatus: Number(me.response?.status || 0),
      accountCheckStatus: Number(checked.response?.status || 0),
      validatedAt: new Date().toISOString(),
    };
    state.status = 'complete';
    state.step = 'complete';
    state.completedAt = new Date().toISOString();
    await this.checkpoint(state, session, 'oauth_tokens_validated');
    return state;
  }

  async run(state) {
    const session = this.session(state);
    if (state.step === 'complete') return state;
    await this.ensureCockpitProtocol(state, session);
    if (state.step === 'account_select_pending') {
      this.resetAuthorizationState(state);
      await this.checkpoint(state, session, 'oauth_account_selection_restarted');
    }
    if (state.step === 'token_exchange_pending' && !state.tokens) {
      this.resetAuthorizationState(state);
      await this.checkpoint(state, session, 'oauth_token_exchange_restarted');
    }
    if (state.step === 'mfa_required') {
      const error = new Error('Cockpit OAuth requires MFA login-state repair before authorization can continue');
      error.code = 'OAUTH_MFA_REQUIRED';
      throw error;
    }
    if (state.step === 'initial') await this.beginCockpitOAuth(state, session);
    if (state.step === 'phone_required' || state.step === 'phone_otp_sent') return state;
    if (state.step === 'navigating') await this.navigate(state, session);
    if (state.step === 'callback_received') await this.exchange(state, session);
    if (state.step === 'token_validating') await this.validateTokens(state, session);
    return state;
  }
}

module.exports = {
  CockpitOAuthRunner,
  accountChoicesFromHtml,
  hasCodexOAuthContract,
  makeInitialCockpitOAuthState,
  matchingAccountChoice,
};
