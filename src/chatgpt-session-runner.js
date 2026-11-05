'use strict';

const crypto = require('node:crypto');

const {
  cookieObjectFor,
  cookieRecords,
  createCookieJar,
  serializeCookieJar,
} = require('./cookie-jar');
const { createClientProfile, createFirefox153Profile, profileFingerprint } = require('./client-profile');
const { normalizeEmailOtp } = require('./email-otp');
const { decodeJwtPayload } = require('./session-asset-store');
const { verifySessionIdentity } = require('./session-identity');
const {
  disposeSentinelRuntime,
  makeSentinelRuntime,
  runSentinelFlow,
} = require('./registration-runner');
const {
  isRetryableSecurityFailure,
  isRetryableTransportError,
} = require('./transport-errors');
const { UrlSession } = require('./url-session');

const AUTH_BASE = 'https://auth.openai.com';
const CHATGPT_BASE = 'https://chatgpt.com';
const CREATE_ACCOUNT_RETRY_DELAYS_MS = Object.freeze([2000, 5000, 10000]);
const MAX_AUTH_TRANSACTION_RESTARTS = 1;
const NEXTAUTH_CONTEXT_CACHE_TTL_MS = 30000;
// A dropped email-send response is ambiguous: the provider may have accepted
// the request even though the client never saw the response. Give the old
// transaction a short chance to prove that before issuing a new code.
const EMAIL_OTP_SEND_RECONCILE_TIMEOUT_MS = 12000;
const MAX_EMAIL_OTP_SEND_RECOVERY_RETRIES = 1;
const MAX_EMAIL_OTP_VALIDATION_RETRIES = 1;
// How long a rejected code waits for the next queued one before the whole
// auth transaction is restarted instead.
const QUEUED_EMAIL_CODE_RETRY_TIMEOUT_MS = 20_000;
const MAX_EMAIL_OTP_SERVER_DATE_DRIFT_MS = 5 * 60 * 1000;
const EMAIL_OTP_SEND_RECOVERY_STATUSES = new Set(['uncertain', 'reconciling', 'retrying', 'exhausted']);
// A security re-authentication is intentionally short-lived.  It is useful
// for the following MFA mutation and for a process restart immediately after
// the checkpoint, but it must not become a long-lived substitute for login.
const SECURITY_REAUTH_TTL_MS = 5 * 60 * 1000;
const NEXTAUTH_SESSION_COOKIES = Object.freeze([
  '__Secure-next-auth.session-token',
  'next-auth.session-token',
  '__Secure-authjs.session-token',
  'authjs.session-token',
]);
const AUTH_TRANSACTION_COOKIE_NAMES = Object.freeze([
  '__Host-next-auth.csrf-token',
  '__Secure-next-auth.callback-url',
  'oai-client-auth-session',
  'oai-client-auth-info',
  'unified_session_manifest',
]);

function mergeAbortSignals(signals = []) {
  const active = signals.filter(Boolean);
  if (active.length <= 1) return active[0];
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return AbortSignal.any(active);
  }
  const controller = new AbortController();
  const abort = (signal) => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  for (const signal of active) {
    if (signal.aborted) abort(signal);
    else signal.addEventListener('abort', () => abort(signal), { once: true });
  }
  return controller.signal;
}

// Per-session trace bounds. The opening steps say what the session is and how
// it was resumed, so they are kept; the rest is a rolling tail.
const MAX_SESSION_EVENTS = 400;
const SESSION_EVENT_HEAD = 40;

/**
 * Caps a session trace in place, leaving a marker where the gap is.
 *
 * These traces are embedded in the run state, which is rewritten in full on
 * every checkpoint of every Worker, so an uncapped trace makes every later
 * write of the whole run more expensive — the same reason the run's own event
 * list is capped. Exported so the OAuth runner keeps the identical bound.
 */
function trimSessionEvents(events) {
  if (!Array.isArray(events) || events.length <= MAX_SESSION_EVENTS) return events;
  const dropped = events.length - MAX_SESSION_EVENTS;
  events.splice(SESSION_EVENT_HEAD, dropped, {
    at: new Date().toISOString(),
    type: 'session_events_trimmed',
    dropped,
    message: `${dropped} earlier session step(s) dropped to keep the run state bounded`,
  });
  return events;
}

function randomPassword() {
  return `Gpt-${crypto.randomBytes(9).toString('base64url')}!8a`;
}

/**
 * Picks the `screen_hint` that `authorize/continue` is answered against.
 *
 * `signup` makes the server hand back `create_account_password`, which lets the
 * account be registered through `user/register` with a password already set —
 * one email OTP for the whole registration. `login_or_signup` answers with
 * `email_otp_verification` instead, which builds a passwordless account and
 * forces a second OTP later just to attach a password. A login-only flow keeps
 * the neutral hint so an unknown address still fails as "not an account".
 */
function identityScreenHint(options = {}) {
  return options.existingOnly === true ? 'login_or_signup' : 'signup';
}

/** Reads what the server stamped into the auth session it just issued. */
function clientAuthSessionScreenHint(session) {
  try {
    const cookie = (session.serializeCookies?.()?.cookies || [])
      .find((entry) => entry.key === 'oai-client-auth-session');
    if (!cookie?.value) return '';
    const [payload] = String(cookie.value).split('.');
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    return String(JSON.parse(Buffer.from(padded, 'base64').toString('utf8')).original_screen_hint || '');
  } catch {
    return '';
  }
}

function normalizePageType(value) {
  return String(value || '').trim().toLowerCase().replace(/-/g, '_');
}

function authStep(json = {}) {
  const page = json.page && typeof json.page === 'object' ? json.page : {};
  const payload = page.payload && typeof page.payload === 'object' ? page.payload : {};
  return {
    continueUrl: String(
      json.continue_url
      || json.continueUrl
      || page.continue_url
      || page.continueUrl
      || payload.continue_url
      || payload.continueUrl
      || payload.url
      || json.url
      || '',
    ).trim(),
    pageType: normalizePageType(page.type || page.name || json.page_type || ''),
    payload,
  };
}

function isStaleAuthorizationState(error) {
  return String(error?.code || '').trim().toUpperCase() === 'INVALID_STATE'
    && Number(error?.status || error?.httpStatus || 0) === 409;
}

function isAuthorizationTransactionCookie(key) {
  const name = String(key || '');
  return AUTH_TRANSACTION_COOKIE_NAMES.includes(name) || name.startsWith('oai-login-csrf_');
}

function clearAuthorizationTransactionCookies(session) {
  if (!session?.cookieJar || typeof session.cookieJar.serializeSync !== 'function') return;
  const serialized = session.cookieJar.serializeSync();
  const cookies = Array.isArray(serialized.cookies) ? serialized.cookies : [];
  const retained = cookies.filter((cookie) => !isAuthorizationTransactionCookie(cookie.key));
  if (retained.length === cookies.length) return;
  session.cookieJar = createCookieJar({ ...serialized, cookies: retained });
}

function resetAuthorizationTransaction(state, session) {
  // A 409 means the server rejected the state carried by the previous auth
  // transaction. Reusing its CSRF/session manifest can reproduce the same
  // rejection; keep the device identity and rebuild only transaction cookies.
  clearAuthorizationTransactionCookies(session);
  state.step = 'initial';
  state.authorizeUrl = '';
  state.continueUrl = '';
  state.pageType = '';
  state.authPayload = null;
  state.authCallbackUrl = '';
  state.pendingAuthCallbackUrl = '';
  state.mfaChallenge = null;
}

function clientAuthSessionFromJson(json = {}) {
  if (!json || typeof json !== 'object') return null;
  const direct = json['oai-client-auth-session']
    || json.oai_client_auth_session
    || json.client_auth_session;
  if (direct && typeof direct === 'object') return direct;
  return null;
}

function clientAuthSessionFromCookies(cookieJar) {
  const value = String(cookieObjectFor(cookieJar, `${AUTH_BASE}/`)['oai-client-auth-session'] || '').trim();
  if (!value) return null;
  try {
    const payload = value.split('.', 1)[0];
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return decoded && typeof decoded === 'object' ? decoded : null;
  } catch {
    return null;
  }
}

function phoneChannelCapability(json = {}, cookieJar) {
  const responseSession = clientAuthSessionFromJson(json);
  if (typeof responseSession?.multi_channel_allowed === 'boolean') {
    return responseSession.multi_channel_allowed;
  }
  const cookieSession = clientAuthSessionFromCookies(cookieJar);
  return typeof cookieSession?.multi_channel_allowed === 'boolean'
    ? cookieSession.multi_channel_allowed
    : null;
}

function phoneSendPayload(phone, json = {}, cookieJar) {
  const multiChannelAllowed = phoneChannelCapability(json, cookieJar);
  return {
    payload: {
      phone_number: String(phone),
      ...(multiChannelAllowed === false ? {} : { channel: 'sms' }),
    },
    multiChannelAllowed,
  };
}

function isChatGptCallbackUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return url.origin === CHATGPT_BASE && url.pathname === '/api/auth/callback/openai';
  } catch {
    return false;
  }
}

function mfaTotpFactor(json = {}) {
  const step = authStep(json);
  const factors = Array.isArray(step.payload.factors) ? step.payload.factors : [];
  const declaredId = String(step.payload.factor_id || '').trim();
  const factor = factors.find((candidate) => (
    candidate
    && String(candidate.factor_type || '').trim().toLowerCase() === 'totp'
    && candidate.is_recovery !== true
    && (!declaredId || String(candidate.id || '').trim() === declaredId)
  ));
  const factorId = String(factor?.id || (factors.length ? '' : declaredId)).trim();
  const factorType = String(factor?.factor_type || (factorId ? 'totp' : '')).trim().toLowerCase();
  return {
    id: factorId,
    type: factorType,
    recovery: factor?.is_recovery === true,
  };
}

function redactAuthDetail(value) {
  return String(value || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<email>')
    .replace(/\b(?:eyJ|sess-|acct_|org-)[A-Za-z0-9_.-]{10,}\b/g, '<redacted>')
    .slice(0, 180);
}

function authResponseDiagnostics(result) {
  const text = String(result?.response?.text || '');
  let location = '';
  try { location = result?.response?.location ? new URL(result.response.location, AUTH_BASE).pathname : ''; } catch { /* Keep the diagnostic path empty. */ }
  return {
    status: Number(result?.response?.status || 0),
    contentType: String(result?.response?.contentType || '').split(';', 1)[0].toLowerCase(),
    location,
    bodyBytes: Buffer.byteLength(text),
    bodyHash: text ? crypto.createHash('sha256').update(text).digest('hex').slice(0, 16) : '',
  };
}

function requestError(operation, result) {
  const rawDetail = result?.json?.error?.code
    || result?.json?.error
    || result?.json?.message
    || result?.response?.text
    || 'unknown response';
  const detail = redactAuthDetail(typeof rawDetail === 'string' ? rawDetail : JSON.stringify(rawDetail));
  const error = new Error(`${operation} failed with HTTP ${result?.response?.status || 0}: ${detail}`);
  error.code = String(result?.json?.error?.code || `${operation.toUpperCase()}_FAILED`).replace(/[^A-Z0-9_]+/gi, '_').toUpperCase();
  error.status = Number(result?.response?.status || 0);
  error.response = result?.json || {};
  error.diagnostics = authResponseDiagnostics(result);
  return error;
}

function assertOk(operation, result, statuses = null) {
  const status = Number(result?.response?.status || 0);
  const accepted = statuses ? statuses.includes(status) : status >= 200 && status < 400;
  if (!accepted) throw requestError(operation, result);
  return result;
}

function retryableSecurityError(error) {
  if (String(error?.code || '').toUpperCase() === 'SENTINEL_PROXY_IDENTITY_CHANGED') return true;
  return isRetryableSecurityFailure(error);
}

function passwordDetourCanFallback(error = {}) {
  const code = String(error.code || '').toUpperCase();
  const category = String(error.category || '').toLowerCase();
  const status = Number(error.status || 0);
  // A mailbox/provider failure is not evidence that the password detour is
  // unavailable. Falling back here would issue another OTP after a remote
  // side effect has already succeeded, which is how a temporary mail outage
  // turned into repeated registration messages.
  if (code === 'TASK_INTERRUPTED'
    || category === 'mail_transport'
    || category === 'mailbox_authentication'
    || /^EMAIL_|^(?:WEBMAIL|IMAP)_/.test(code)) return false;
  if (error.retryable === true && status !== 400 && status !== 401 && status !== 403) return false;
  return code === 'INVALID_AUTH_STEP' || [400, 401, 403].includes(status);
}

function securityReauthProxyFingerprint(proxy = '') {
  const value = String(proxy || 'direct').trim() || 'direct';
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function securityReauthIsUsable(state = {}, proxy = '', now = Date.now) {
  const record = state.security?.securityReauth;
  if (!record || record.status !== 'complete') return false;
  const expiresAt = Date.parse(String(record.expiresAt || ''));
  if (!Number.isFinite(expiresAt) || expiresAt <= Number(now())) return false;
  const expectedProxy = String(record.proxyFingerprint || '');
  if (expectedProxy && expectedProxy !== securityReauthProxyFingerprint(proxy)) return false;
  const expectedProfile = String(record.clientProfileFingerprint || '');
  if (expectedProfile && expectedProfile !== String(state.clientProfileFingerprint || '')) return false;
  const expectedAccessToken = String(record.accessTokenFingerprint || '');
  if (expectedAccessToken && !state.accessToken) return false;
  if (expectedAccessToken && state.accessToken) {
    const currentAccessToken = crypto.createHash('sha256').update(String(state.accessToken)).digest('hex').slice(0, 16);
    if (expectedAccessToken !== currentAccessToken) return false;
  }
  return true;
}

function securityReauthRequired(error = {}) {
  const status = Number(error.status || error.httpStatus || error.response?.status || 0);
  if (status !== 401) return false;
  let response = '';
  try { response = JSON.stringify(error.response || {}); } catch { response = ''; }
  const detail = `${String(error.code || '')} ${String(error.message || '')} ${response}`.toLowerCase();
  return /re[-\s]?authenticate|reauthenticate|recently authenticate|enroll\/disable a factor/.test(detail);
}

function securityErrorDetails(error) {
  return {
    code: String(error?.code || 'SECURITY_SETUP_FAILED'),
    retryable: retryableSecurityError(error),
    message: redactAuthDetail(error?.message || 'Security setup failed'),
  };
}

function securityCheckpointMessage(type, details = {}) {
  const messages = {
    password_during_registration_unavailable: '注册时设置密码不可用，回落到无密码注册（稍后补密码会多一封邮件）',
    password_setup_started: '开始设置密码',
    password_otp_sent: '密码设置验证码已发送，等待邮箱 OTP',
    password_otp_validation_started: '开始验证密码设置邮箱 OTP',
    password_otp_validated: '密码设置邮箱 OTP 验证完成',
    password_submitted: '密码已提交，等待安全确认结果',
    password_configured: details.confirmationMfaRequired
      ? '密码已设置成功；服务端返回了 MFA continuation，作为后续认证提示保留'
      : '密码设置完成',
    totp_setup_started: '开始设置 TOTP',
    totp_setup_deferred: 'TOTP 设置暂缓，等待密码安全步骤完成',
    totp_configured: 'TOTP 设置并激活完成',
    security_reauth_started: '开始安全重认证（仅验证现有密码，不修改密码）',
    security_reauth_required: 'TOTP 注册要求一次安全重认证',
    security_reauth_email_boundary_captured: '已建立安全重认证邮箱基线',
    security_reauth_email_otp_sent: '安全重认证需要邮箱 OTP，等待首封验证码',
    security_reauth_email_otp_resumed: '继续等待已发送的安全重认证邮箱 OTP',
    security_reauth_email_otp_received: '已收到安全重认证邮箱 OTP',
    security_reauth_email_otp_validated: '安全重认证邮箱 OTP 验证完成',
    security_reauth_completed: '安全重认证完成，继续 TOTP 注册',
    security_reauth_failed: '安全重认证失败',
    totp_setup_failed: 'TOTP 设置失败',
    password_setup_failed: '密码设置失败',
  };
  return messages[type] || '';
}

const SECURITY_PENDING_STATUSES = new Set([
  'waiting_otp',
  'retry_pending',
  'failed',
  'confirmation_mfa_required',
]);

function securityWorkRequested(security = {}) {
  return security.setPassword === true || security.enrollTotp === true;
}

/**
 * The security features a run asked for that the account did not end up with.
 *
 * `securityStateHasPendingWork` answers a different question — is there work
 * left to retry — and a feature that never started has none: no status, no
 * failure, nothing pending. That absence must not read as "configured", which
 * is why this asks the positive question instead. Only what the plan requested
 * counts: a run that never asked for a password cannot be missing one.
 */
function missingSecurityFeatures(state = {}, security = {}) {
  const current = state.security || {};
  const missing = [];
  if (security.setPassword === true && String(current.passwordStatus || '') !== 'configured') missing.push('password');
  if (security.enrollTotp === true && String(current.totpStatus || '') !== 'configured') missing.push('totp');
  return missing;
}

function securityStateHasPendingWork(state = {}) {
  const security = state.security || {};
  const failures = Array.isArray(security.failures) ? security.failures : [];
  const passwordStatus = String(security.passwordStatus || '');
  const totpStatus = String(security.totpStatus || '');
  const passwordFailure = passwordStatus !== 'configured' && (
    SECURITY_PENDING_STATUSES.has(passwordStatus)
      || failures.some((failure) => !failure?.feature || failure.feature === 'password')
  );
  const totpFailure = totpStatus !== 'configured' && (
    SECURITY_PENDING_STATUSES.has(totpStatus)
      || failures.some((failure) => !failure?.feature || failure.feature === 'totp')
  );
  const transactionStep = String(security.passwordTransaction?.step || '');
  // A configured password is the authoritative mutation result. Legacy
  // checkpoints may still carry an older non-complete transaction step; do
  // not let that stale bookkeeping keep an otherwise complete asset partial.
  const transactionPending = passwordStatus !== 'configured'
    && Boolean(transactionStep && transactionStep !== 'complete');
  const reauthStatus = String(security.securityReauth?.status || '');
  const reauthPending = ['required', 'in_progress', 'retry_pending'].includes(reauthStatus);
  return passwordFailure || totpFailure || transactionPending || reauthPending;
}

function passwordConfirmationMfaError(transaction = {}) {
  const error = new Error('Password was submitted; the follow-up login continuation requires an existing MFA factor');
  error.code = 'PASSWORD_CONFIRMATION_MFA_REQUIRED';
  error.retryable = false;
  error.nextUrl = String(transaction.nextUrl || '');
  return error;
}

function absoluteAuthUrl(value) {
  if (!value) return '';
  const url = new URL(String(value), AUTH_BASE);
  if (![AUTH_BASE, CHATGPT_BASE].includes(url.origin)) {
    const error = new Error(`Authentication continuation origin is not allowed: ${url.origin}`);
    error.code = 'AUTH_CONTINUATION_ORIGIN_INVALID';
    throw error;
  }
  return url.toString();
}

function authPath(value) {
  try {
    return new URL(String(value || ''), AUTH_BASE).pathname;
  } catch {
    return '';
  }
}

function isEmailVerificationUrl(value) {
  const pathname = authPath(value);
  return /(?:^|\/)(?:email-verification|email-otp|log-in\/email(?:-otp)?)(?:\/|$)/i.test(pathname);
}

function isNextAuthCsrfSignInUrl(value) {
  try {
    const url = new URL(String(value || ''), AUTH_BASE);
    return [AUTH_BASE, CHATGPT_BASE].includes(url.origin)
      && url.pathname === '/api/auth/signin'
      && url.searchParams.has('csrf');
  } catch {
    return false;
  }
}

function nextAuthInitializationError(url, stage = 'authorization') {
  const error = new Error(
    `NextAuth ${stage} landed on the CSRF sign-in bootstrap page; the ChatGPT home initialization was not accepted`,
  );
  error.code = 'NEXTAUTH_CSRF_INITIALIZATION_FAILED';
  error.status = 409;
  error.retryable = true;
  error.category = 'transient';
  error.landedUrl = String(url || '');
  return error;
}

function markEmailOtpSendStarted(state) {
  const sendStartedAt = new Date().toISOString();
  state.emailOtpSendStartedAt = sendStartedAt;
  state.emailOtpSentAtSource = '';
  return sendStartedAt;
}

function responseHeaderValue(response, name) {
  const headers = response?.headers;
  if (!headers) return '';
  if (typeof headers.get === 'function') return String(headers.get(name) || '').trim();
  if (Array.isArray(headers)) {
    return String(headers.find((header) => String(header?.name || '').toLowerCase() === name.toLowerCase())?.value || '').trim();
  }
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? String(headers[key] || '').trim() : '';
}

function isEmailOtpSendUrl(value) {
  try {
    const pathname = new URL(String(value || ''), AUTH_BASE).pathname;
    return /\/(?:email-otp\/send|passwordless\/send-otp)\/?$/i.test(pathname);
  } catch {
    return false;
  }
}

function responseServerDate(result) {
  const history = Array.isArray(result?.history) ? result.history : [];
  const sendResponses = history.filter((item) => isEmailOtpSendUrl(item?.url));
  const candidates = [
    ...sendResponses,
    result?.response,
    ...history,
  ];
  for (const response of candidates) {
    const value = String(
      response?.serverDate
        || response?.date
        || responseHeaderValue(response, 'date')
        || '',
    ).trim();
    const timestamp = Date.parse(value);
    if (value && Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }
  return '';
}

function transportOutcomeMayBeUnknown(error = {}) {
  const status = Number(error.status || error.httpStatus || 0);
  return isRetryableTransportError(error)
    || status === 408
    || status === 425
    || status === 429
    || status >= 500;
}

function errorCheckpointDetails(error = {}) {
  return {
    code: String(error.code || 'REQUEST_FAILED'),
    status: Number(error.status || error.httpStatus || 0),
    message: String(error.message || 'Request failed').slice(0, 240),
  };
}

function isWrongEmailOtpError(error = {}) {
  return String(error.code || '').trim().toUpperCase() === 'WRONG_EMAIL_OTP_CODE';
}

function emailOtpRecoveryRetryCount(recovery = {}) {
  const count = Number(recovery.retryCount || 0);
  const normalized = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
  // Older checkpoints only persisted retryUsed. Treat that flag as one spent
  // retry so a migration cannot silently grant a second fresh-code attempt.
  return recovery.retryUsed === true ? Math.max(1, normalized) : normalized;
}

function emailOtpRecoveryRetryUsed(recovery = {}) {
  return recovery.retryUsed === true
    || emailOtpRecoveryRetryCount(recovery) >= MAX_EMAIL_OTP_SEND_RECOVERY_RETRIES;
}

function markEmailOtpSendUncertain(state, sendStartedAt, error) {
  const previous = state.emailOtpSendRecovery && typeof state.emailOtpSendRecovery === 'object'
    ? state.emailOtpSendRecovery
    : {};
  state.emailOtpSendStartedAt = '';
  state.emailOtpSendRecovery = {
    ...previous,
    status: 'uncertain',
    attempts: Number(previous.attempts || 0) + 1,
    startedAt: String(previous.startedAt || sendStartedAt || new Date().toISOString()),
    lastAttemptAt: new Date().toISOString(),
    lastError: errorCheckpointDetails(error),
  };
}

function markEmailOtpSent(state, sendStartedAt = '', sendResult = null) {
  const startedAtMs = Date.parse(String(sendStartedAt || state.emailOtpSendStartedAt || ''));
  const nowMs = Date.now();
  const serverAt = responseServerDate(sendResult);
  const serverAtMs = Date.parse(serverAt);
  const serverTimeUsable = Number.isFinite(serverAtMs)
    && serverAtMs >= startedAtMs - MAX_EMAIL_OTP_SERVER_DATE_DRIFT_MS
    && serverAtMs <= nowMs + MAX_EMAIL_OTP_SERVER_DATE_DRIFT_MS;
  // The HTTP Date is the upstream server's clock, which is the closest
  // available boundary to when it accepted the send. Fall back only when the
  // server did not expose a usable date or its clock is clearly invalid.
  const sentAt = serverTimeUsable
    ? serverAt
    : (Number.isFinite(startedAtMs) && startedAtMs <= nowMs
      ? new Date(startedAtMs).toISOString()
      : new Date(nowMs).toISOString());
  state.emailOtpSentAt = sentAt;
  state.emailOtpSentAtSource = serverTimeUsable ? 'server_response_date' : 'request_start';
  state.emailOtpSendStartedAt = '';
  state.emailOtpSendRecovery = null;
  // This is a task-owned copy. Shared mailbox cache entries are cloned before
  // they reach the runner, so the send timestamp cannot leak to another alias.
  if (state.emailBoundary && typeof state.emailBoundary === 'object') {
    state.emailBoundary = { ...state.emailBoundary, sentAt };
  }
  return sentAt;
}

function securityReauthEmailTransactionUsable(transaction = {}, now = Date.now) {
  const status = String(transaction.status || '').trim().toLowerCase();
  if (!['waiting', 'validated'].includes(status)) return false;
  const expiresAt = Date.parse(String(transaction.expiresAt || ''));
  if (!Number.isFinite(expiresAt) || expiresAt <= Number(now())) return false;
  if (!transaction.continueUrl || !isEmailVerificationUrl(transaction.continueUrl)) {
    return status === 'validated' && Boolean(transaction.continueUrl);
  }
  return Boolean(
    transaction.boundary
      && (transaction.boundary.capturedAt || Array.isArray(transaction.boundary.messageIds)),
  );
}

function authUrlSummary(value) {
  try {
    const url = new URL(String(value || ''), AUTH_BASE);
    return {
      path: url.pathname,
      queryKeys: [...new Set([...url.searchParams.keys()])].sort(),
      // The two parameters that decide whether this becomes a signup or a
      // login. Knowing the key was present was not enough to tell why a whole
      // batch registered passwordless — the value is what matters, and neither
      // of these is a secret.
      screenHint: url.searchParams.get('screen_hint') || '',
      prompt: url.searchParams.get('prompt') || '',
    };
  } catch {
    return { path: '', queryKeys: [], screenHint: '', prompt: '' };
  }
}

function requestTargetSummary(value) {
  try {
    const url = new URL(String(value || ''), CHATGPT_BASE);
    return { host: url.hostname, path: url.pathname };
  } catch {
    return { host: '', path: '' };
  }
}

/**
 * Why the NextAuth callback was judged an error page, or '' if it was fine.
 *
 * A bare boolean left the failure undiagnosable: all the run log kept was a
 * hash of 445 KB of HTML, so there was no telling an `/api/auth/error` landing
 * from a proxy-injected interstitial. The reason string is cheap and is the
 * difference between "this exit is bad" and "this account is bad".
 */
function callbackErrorReason(result) {
  const urls = [
    result?.response?.url,
    result?.redirectUrl,
    ...(Array.isArray(result?.history) ? result.history.map((item) => item?.url) : []),
  ];
  for (const value of urls) {
    try {
      const url = new URL(String(value || ''), CHATGPT_BASE);
      if (url.origin !== CHATGPT_BASE) continue;
      if (url.pathname === '/api/auth/error') return `auth_error_page:${url.searchParams.get('error') || 'unknown'}`;
      if (url.searchParams.has('error')) return `error_param:${url.searchParams.get('error') || 'unknown'}`;
    } catch { /* Ignore diagnostic-only malformed history entries. */ }
  }
  const jsonError = String(result?.json?.error || '').trim();
  return jsonError ? `json_error:${jsonError}` : '';
}

function accountClaims(accessToken, session = {}) {
  const payload = decodeJwtPayload(accessToken);
  const auth = payload['https://api.openai.com/auth'] || {};
  const profile = payload['https://api.openai.com/profile'] || {};
  const account = session.account || session.user?.account || {};
  return {
    email: String(session.user?.email || profile.email || payload.email || '').trim(),
    accountId: String(
      account.id
      || account.account_id
      || session.accountId
      || auth.chatgpt_account_id
      || payload.chatgpt_account_id
      || '',
    ).trim(),
    planType: String(
      account.plan_type
      || session.planType
      || auth.chatgpt_plan_type
      || payload.chatgpt_plan_type
      || 'unknown',
    ).trim().toLowerCase(),
  };
}

function observedAccountIds(accessToken, session = {}, me = {}) {
  const payload = decodeJwtPayload(accessToken);
  const auth = payload['https://api.openai.com/auth'] || {};
  const account = session.account || session.user?.account || {};
  const meAccount = me.account || me.user?.account || {};
  const candidates = [
    account.id,
    account.account_id,
    session.accountId,
    session.account_id,
    auth.chatgpt_account_id,
    payload.chatgpt_account_id,
    payload.account_id,
    me.account_id,
    me.accountId,
    me.chatgpt_account_id,
    me.chatgptAccountId,
    meAccount.id,
    meAccount.account_id,
    me.user?.account_id,
    me.user?.accountId,
  ];
  return [...new Set(candidates.map((value) => String(value || '').trim()).filter(Boolean))];
}

function sessionCookie(cookieJar) {
  const records = cookieRecords(cookieJar);
  for (const base of NEXTAUTH_SESSION_COOKIES) {
    const exact = records.find((cookie) => cookie.key === base);
    if (exact?.value) return exact.value;
    const chunks = records
      .filter((cookie) => cookie.key.startsWith(`${base}.`))
      .sort((left, right) => Number(left.key.slice(base.length + 1)) - Number(right.key.slice(base.length + 1)));
    if (chunks.length) return chunks.map((cookie) => cookie.value).join('');
  }
  return '';
}

// The authenticated home document embeds the same session object used by the
// web client. Keep this as a bounded fallback for raw HTTP clients when the
// NextAuth session endpoint is delayed or hidden by an intermediate gateway.
function parseClientBootstrap(html) {
  const source = String(html || '');
  const match = source.match(/<script\b[^>]*\bid\s*=\s*["']client-bootstrap["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  try {
    const value = JSON.parse(match[1].trim());
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function sessionPayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  if (value.session && typeof value.session === 'object' && !Array.isArray(value.session)) {
    return value.session;
  }
  return value;
}

function base32Bytes(value) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  // Hyphens are stripped as well as whitespace, to match the console's parser
  // in `web/src/credential-input.ts`. They disagreed: a secret pasted in the
  // grouped `ABCD-EFGH-…` form previewed a valid code in the browser and then
  // threw here the moment the run reached the TOTP step.
  for (const character of String(value || '').replace(/=+$/g, '').replace(/[\s-]/g, '').toUpperCase()) {
    const index = alphabet.indexOf(character);
    if (index < 0) throw new Error('Invalid base32 TOTP secret');
    bits += index.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let offset = 0; offset + 8 <= bits.length; offset += 8) bytes.push(Number.parseInt(bits.slice(offset, offset + 8), 2));
  return Buffer.from(bytes);
}

function totpCode(secret, now = Date.now()) {
  const counter = Math.floor(now / 1000 / 30);
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));
  const digest = crypto.createHmac('sha1', base32Bytes(secret)).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const number = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(number).padStart(6, '0');
}

function makeInitialChatGptSessionState(options = {}) {
  // An account keeps the machine it was registered on: every restart path
  // hands the previous profile back in, and a rebind months later reads it off
  // the stored asset. Only a genuinely new account draws from the pool, and it
  // draws deterministically from its own address, so the same account rebuilds
  // the same machine rather than appearing to have bought a new one.
  const profile = options.clientProfile || (options.clientProfilePool === false
    ? createFirefox153Profile()
    : createClientProfile({
      seed: options.profileSeed || options.email || '',
      country: options.profileCountry || '',
    }));
  const jar = createCookieJar(options.cookieJar || options.cookies);
  const oaiDid = String(options.oaiDid || crypto.randomUUID());
  jar.setCookieSync(`oai-did=${encodeURIComponent(oaiDid)}; Path=/; Secure; SameSite=Lax`, `${AUTH_BASE}/`, { ignoreError: true });
  return {
    schemaVersion: 1,
    mode: 'chatgpt-nextauth-session',
    email: String(options.email || '').trim(),
    step: 'initial',
    status: 'running',
    oaiDid,
    cookieJar: serializeCookieJar(jar),
    clientProfile: profile,
    clientProfileFingerprint: profileFingerprint(profile),
    authorizeUrl: '',
    continueUrl: '',
    pageType: '',
    authTransactionRestarts: 0,
    authCallbackUrl: '',
    pendingAuthCallbackUrl: '',
    emailBoundary: null,
    emailOtpSentAt: '',
    emailOtpSentAtSource: '',
    emailOtpSendStartedAt: '',
    emailOtpSendRecovery: null,
    emailOtpValidationRetries: 0,
    createAccountAttempt: null,
    accountCreatedAt: '',
    mfaChallenge: null,
    password: String(options.password || ''),
    totpSecret: String(options.totpSecret || ''),
    passwordRequiredByFlow: false,
    security: {
      setPassword: Boolean(options.password),
      enrollTotp: Boolean(options.totpSecret),
      passwordStatus: options.password ? 'configured' : 'not_requested',
      totpStatus: options.totpSecret ? 'configured' : 'not_requested',
      securityReauth: {
        status: 'not_started',
        attempts: 0,
      },
    },
    events: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

class ChatGptSessionRunner {
  constructor(har, options = {}) {
    this.har = har;
    this.options = options;
    this.sentinelRuntime = null;
    this.sentinelRuntimeKey = '';
    this.sentinelPrewarm = null;
    this.nextAuthContextCache = new WeakMap();
  }

  sentinelRuntimeIdentity(state, options = {}) {
    const profile = state.clientProfile || {};
    const proxy = options.proxy === undefined ? this.options.proxy : options.proxy;
    const source = options.sentinelSdkSource === undefined
      ? String(this.options.sentinelSdkSource || '')
      : String(options.sentinelSdkSource || '');
    const sourceFingerprint = source
      ? crypto.createHash('sha256').update(source).digest('hex').slice(0, 16)
      : '';
    return [
      profileFingerprint(profile),
      securityReauthProxyFingerprint(proxy),
      String(options.sentinelSdkUrl || this.options.sentinelSdkUrl || ''),
      sourceFingerprint,
    ].join('|');
  }

  disposeSentinelRuntime() {
    if (this.sentinelRuntime) disposeSentinelRuntime(this.sentinelRuntime);
    this.sentinelRuntime = null;
    this.sentinelRuntimeKey = '';
  }

  disposeSentinelPrewarm() {
    const prewarm = this.sentinelPrewarm;
    if (!prewarm) return;
    prewarm.disposed = true;
    if (!prewarm.controller.signal.aborted) prewarm.controller.abort('runner_disposed');
    if (prewarm.runtime) disposeSentinelRuntime(prewarm.runtime);
    this.sentinelPrewarm = null;
  }

  dispose() {
    this.disposeSentinelRuntime();
    this.disposeSentinelPrewarm();
  }

  nextAuthCookieFingerprint(session) {
    const cookies = cookieObjectFor(
      session?.cookieJar || session?.serializeCookies?.(),
      `${CHATGPT_BASE}/`,
    );
    return crypto.createHash('sha256').update(JSON.stringify(cookies)).digest('hex');
  }

  clearNextAuthContext(session) {
    if (session && typeof session === 'object') this.nextAuthContextCache.delete(session);
  }

  async prewarmSentinelRuntime(state, session, flow, options = {}) {
    if (this.options.prewarmSentinelSdk !== true
      || this.options.dynamicSentinel === false
      || options.dynamicSentinel === false
      || typeof session?.executeRequest !== 'function') return null;
    const key = this.sentinelRuntimeIdentity(state, options);
    if (this.sentinelRuntime && this.sentinelRuntimeKey === key) return this.sentinelRuntime;
    if (this.sentinelPrewarm?.key === key) return this.sentinelPrewarm.promise;
    if (this.sentinelPrewarm) this.disposeSentinelPrewarm();

    state.cookies = cookieObjectFor(session.cookieJar || session.serializeCookies?.(), `${AUTH_BASE}/`);
    const controller = new AbortController();
    const signal = mergeAbortSignals([this.options.signal, controller.signal]);
    const prewarmSession = new UrlSession({
      cookieJar: session.serializeCookies?.() || session.cookieJar,
      clientProfile: state.clientProfile,
      browserHeaders: this.options.browserHeaders,
      proxy: this.options.proxy,
      signal,
      executor: session.executor || this.options.executor,
    });
    const prewarmState = {
      ...state,
      cookies: { ...state.cookies },
      cookieJar: prewarmSession.serializeCookies(),
    };
    const prewarm = {
      key,
      controller,
      runtime: null,
      disposed: false,
      promise: null,
    };
    prewarm.promise = Promise.resolve()
      .then(() => makeSentinelRuntime(this.har, prewarmState, { flow }, {
        ...this.options,
        ...options,
        clientProfile: state.clientProfile,
        proxy: options.proxy === undefined ? this.options.proxy : options.proxy,
        sentinelExecutor: (request) => prewarmSession.executeRequest(request, {
          signal,
          ...(options.operationTimeoutMs ? { timeoutMs: options.operationTimeoutMs } : {}),
        }),
      }))
      .then((runtime) => {
        if (prewarm.disposed) {
          disposeSentinelRuntime(runtime);
          return null;
        }
        prewarm.runtime = runtime;
        prewarm.sdk = prewarmState.sentinelSdk;
        return runtime;
      })
      .catch(() => null);
    this.sentinelPrewarm = prewarm;
    return prewarm.promise;
  }

  async getSentinelRuntime(state, flow, options = {}) {
    if (options.sentinelRuntime || options.dynamicSentinel === false || this.options.dynamicSentinel === false) {
      return options.sentinelRuntime || null;
    }
    const key = this.sentinelRuntimeIdentity(state, options);
    if (this.sentinelRuntime && this.sentinelRuntimeKey !== key) this.disposeSentinelRuntime();
    if (this.sentinelPrewarm && this.sentinelPrewarm.key !== key) this.disposeSentinelPrewarm();
    if (!this.sentinelRuntime && this.sentinelPrewarm?.key === key) {
      const prewarmed = this.sentinelPrewarm;
      const runtime = await prewarmed.promise;
      if (runtime && !prewarmed.disposed) {
        this.sentinelRuntime = runtime;
        this.sentinelRuntimeKey = key;
        if (this.options.useHarTemplates === false && prewarmed.sdk) state.sentinelSdk = { ...prewarmed.sdk };
        this.sentinelPrewarm = null;
      } else if (this.sentinelPrewarm === prewarmed) {
        this.sentinelPrewarm = null;
      }
    }
    if (!this.sentinelRuntime) {
      this.sentinelRuntime = await makeSentinelRuntime(this.har, state, { flow }, {
        ...this.options,
        ...options,
        clientProfile: state.clientProfile,
        proxy: options.proxy === undefined ? this.options.proxy : options.proxy,
      });
      this.sentinelRuntimeKey = key;
    }
    if (typeof this.sentinelRuntime.setCookies === 'function') {
      this.sentinelRuntime.setCookies(state.cookies);
    }
    return this.sentinelRuntime;
  }

  session(state) {
    return new UrlSession({
      cookieJar: state.cookieJar,
      clientProfile: state.clientProfile,
      browserHeaders: this.options.browserHeaders,
      proxy: this.options.proxy,
      signal: this.options.signal,
      executor: this.options.executor,
    });
  }

  async checkpoint(state, session, type, details = {}) {
    state.cookieJar = session.serializeCookies();
    state.updatedAt = new Date().toISOString();
    const event = { at: state.updatedAt, type, ...details };
    state.events = Array.isArray(state.events) ? state.events : [];
    state.events.push(event);
    trimSessionEvents(state.events);
    if (typeof this.options.onEvent === 'function') await this.options.onEvent(event, state);
    if (typeof this.options.checkpoint === 'function') await this.options.checkpoint(type, state);
  }

  securityTimeoutMs() {
    const value = Number(this.options.securityRequestTimeoutMs);
    return Number.isFinite(value) && value > 0 ? Math.max(1000, Math.floor(value)) : 0;
  }

  authTimeoutMs() {
    const value = Number(this.options.authRequestTimeoutMs);
    return Number.isFinite(value) && value > 0 ? Math.max(1000, Math.floor(value)) : 0;
  }

  authRequestOptions(options = {}) {
    const timeoutMs = this.authTimeoutMs();
    if (!timeoutMs || options.timeoutMs !== undefined) return options;
    return { ...options, timeoutMs };
  }

  securityRequestOptions(options = {}) {
    const timeoutMs = this.securityTimeoutMs();
    if (!timeoutMs || options.timeoutMs !== undefined) return options;
    return { ...options, timeoutMs };
  }

  async securityRequest(session, operation, method, url, options = {}) {
    return this.request(session, operation, method, url, this.securityRequestOptions(options));
  }

  async securityCheckpoint(state, session, type, details = {}) {
    const message = securityCheckpointMessage(type, details);
    await this.checkpoint(state, session, type, {
      timeoutMs: this.securityTimeoutMs() || undefined,
      ...details,
      ...(message && !details.message ? { message } : {}),
    });
  }

  async trySecurityCheckpoint(state, session, type, details = {}) {
    try {
      await this.securityCheckpoint(state, session, type, details);
    } catch {
      // Keep the original transport/authentication error as the result. The
      // next durable checkpoint will still persist the security state.
    }
  }

  async reportRequestTiming(operation, method, url, startedAt, result, error = null) {
    if (this.options.traceAuthRequests !== true || typeof this.options.onRequest !== 'function') return;
    const target = requestTargetSummary(url);
    const record = {
      type: 'auth_request_timing',
      operation: String(operation),
      method: String(method || 'GET').toUpperCase(),
      ...target,
      durationMs: Date.now() - startedAt,
      status: Number(result?.response?.status || error?.status || 0),
      ...(error ? { code: String(error.code || 'REQUEST_FAILED') } : {}),
    };
    try { await this.options.onRequest(record); } catch { /* Diagnostics must not change flow behavior. */ }
  }

  async request(session, operation, method, url, options = {}) {
    const requestOptions = this.authRequestOptions(options);
    const startedAt = Date.now();
    let result;
    try {
      result = await session.request(method, url, requestOptions);
      const status = Number(result.response?.status || 0);
      const challenged = status === 403 && /cloudflare|just a moment|cdn-cgi/i.test(result.response?.text || '');
      if (challenged && typeof this.options.solveCloudflare === 'function') {
        await this.options.solveCloudflare(url, session, result);
        result = await session.request(method, url, requestOptions);
      }
      const checked = assertOk(operation, result, requestOptions.statuses || null);
      await this.reportRequestTiming(operation, method, url, startedAt, checked);
      return checked;
    } catch (error) {
      // The low-level URL executor deliberately keeps transport errors terse.
      // Give security checkpoints a stable, retryable code instead of making
      // the UI look idle until the generic 60-second timeout expires.
      if (!error.code && /timed out|timeout|connection reset|socket hang up/i.test(String(error.message || ''))) {
        error.code = `${String(operation).replace(/[^a-z0-9]+/gi, '_').toUpperCase()}_TIMEOUT`;
        error.retryable = true;
        error.category = 'transient';
      }
      await this.reportRequestTiming(operation, method, url, startedAt, result, error);
      throw error;
    }
  }

  async wait(ms) {
    if (typeof this.options.wait === 'function') return this.options.wait(ms);
    const signal = this.options.signal;
    if (signal?.aborted) throw Object.assign(new Error('Task control interrupted account creation retry'), { code: 'TASK_INTERRUPTED' });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(done, Math.max(0, Number(ms || 0)));
      const onAbort = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        reject(Object.assign(new Error('Task control interrupted account creation retry'), { code: 'TASK_INTERRUPTED' }));
      };
      function done() {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async sentinelHeaders(state, session, flow, options = {}) {
    state.cookies = cookieObjectFor(session.cookieJar, `${AUTH_BASE}/`);
    const sentinelRequestOptions = options.operationTimeoutMs
      ? { timeoutMs: options.operationTimeoutMs }
      : {};
    const sentinelExecutor = async (request) => session.executeRequest(request, sentinelRequestOptions);
    const suppliedRuntime = options.sentinelRuntime;
    // The runtime is created before runSentinelFlow so it can be reused by the
    // next Sentinel operation. It still needs the same session executor here;
    // otherwise SDK loading silently falls back to the HAR because the loader
    // has no way to fetch the current versioned SDK.
    const sentinelRuntime = suppliedRuntime || await this.getSentinelRuntime(state, flow, {
      ...options,
      sentinelExecutor,
    });
    const result = await runSentinelFlow(this.har, state, flow, {
      ...this.options,
      ...options,
      clientProfile: state.clientProfile,
      proxy: options.proxy === undefined ? this.options.proxy : options.proxy,
      ...(sentinelRuntime ? { sentinelRuntime } : {}),
      executor: sentinelExecutor,
    });
    state.cookieJar = session.serializeCookies();
    return result.headers;
  }

  async nextAuthContext(session, requestOptions = {}) {
    const cached = session && this.nextAuthContextCache.get(session);
    const cacheAge = cached ? Date.now() - cached.createdAt : Number.POSITIVE_INFINITY;
    if (cached
      && cacheAge >= 0
      && cacheAge <= NEXTAUTH_CONTEXT_CACHE_TTL_MS
      && cached.cookieFingerprint === this.nextAuthCookieFingerprint(session)) {
      return cached.csrfToken;
    }
    const readCsrf = () => this.request(session, 'chatgpt_csrf', 'GET', `${CHATGPT_BASE}/api/auth/csrf`, {
      ...requestOptions,
      referer: `${CHATGPT_BASE}/`,
      headers: { Accept: 'application/json' },
    });
    const tokenFrom = (response) => String(response?.json?.csrfToken || '').trim();

    // NextAuth's CSRF cookie is bound to the browser bootstrap. Always load
    // the home document first so the following sign-in transaction has the
    // same initialization state as the real page.
    await this.request(session, 'chatgpt_home', 'GET', `${CHATGPT_BASE}/`, {
      ...requestOptions,
      follow: true,
      accept: 'text/html,application/xhtml+xml',
    });
    const csrf = await readCsrf();
    const csrfToken = tokenFrom(csrf);
    if (!csrfToken) {
      const error = new Error('ChatGPT CSRF response did not contain csrfToken');
      error.code = 'NEXTAUTH_CSRF_INITIALIZATION_FAILED';
      error.retryable = true;
      error.category = 'transient';
      throw error;
    }
    if (session && typeof session === 'object') {
      this.nextAuthContextCache.set(session, {
        csrfToken,
        createdAt: Date.now(),
        cookieFingerprint: this.nextAuthCookieFingerprint(session),
      });
    }
    return csrfToken;
  }

  async openAiSignIn(_state, session, csrfToken, query, operation = 'chatgpt_signin', requestOptions = {}) {
    const params = new URLSearchParams(Object.entries(query || {})
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([name, value]) => [name, String(value)]));
    const signIn = await this.request(
      session,
      operation,
      'POST',
      `${CHATGPT_BASE}/api/auth/signin/openai?${params}`,
      {
        ...requestOptions,
        origin: CHATGPT_BASE,
        referer: `${CHATGPT_BASE}/`,
        headers: { Accept: 'application/json' },
        form: { callbackUrl: `${CHATGPT_BASE}/`, csrfToken, json: 'true' },
      },
    );
    const authorizeUrl = absoluteAuthUrl(String(signIn.json.url || signIn.response.location || '').trim());
    if (!authorizeUrl) throw new Error('ChatGPT signin response did not provide an authorize URL');
    if (isNextAuthCsrfSignInUrl(authorizeUrl)) {
      throw nextAuthInitializationError(authorizeUrl, 'sign-in');
    }
    const authorizeOperation = operation === 'chatgpt_signin' ? 'chatgpt_authorize' : `${operation}_authorize`;
    const landed = await this.request(session, authorizeOperation, 'GET', authorizeUrl, {
      ...requestOptions,
      follow: true,
      referer: `${CHATGPT_BASE}/`,
      accept: 'text/html,application/xhtml+xml',
      stopRedirect: (nextUrl) => {
        const safe = absoluteAuthUrl(nextUrl);
        return safe.startsWith(`${CHATGPT_BASE}/api/auth/callback/`);
      },
    });
    const landedUrl = absoluteAuthUrl(landed.redirectUrl || landed.response.url || authorizeUrl);
    if (isNextAuthCsrfSignInUrl(landedUrl)) {
      throw nextAuthInitializationError(landedUrl);
    }
    return { authorizeUrl, landedUrl };
  }

  async nextAuthAuthorize(state, session, query = {}, requestOptions = {}) {
    const csrfToken = await this.nextAuthContext(session, requestOptions);
    // The page normally loads Sentinel while the auth transaction is being
    // opened. Use a copied cookie jar so this overlap cannot mutate the real
    // authentication session or its device identity.
    void this.prewarmSentinelRuntime(state, session, 'authorize_continue', requestOptions).catch(() => {});
    return this.openAiSignIn(state, session, csrfToken, {
      prompt: 'login',
      'ext-passkey-client-capabilities': '01111',
      'ext-oai-did': state.oaiDid,
      auth_session_logging_id: crypto.randomUUID(),
      // Neither this nor the `authorize/continue` body hint decides whether a
      // signup gets a password page: live runs produced `email_otp_verification`
      // for every combination of the two. What the browser actually does is
      // navigate to `/create-account/password` from the code screen — see
      // `useCreateAccountPassword`.
      screen_hint: 'login_or_signup',
      login_hint: state.email,
      ...query,
    }, 'chatgpt_signin', requestOptions);
  }

  async prepareRegistrationEmailBoundary(state, session, options = {}) {
    if (options.existingOnly === true
      || state.emailBoundary
      || typeof this.options.beforeEmailSend !== 'function') return state.emailBoundary;

    // Mailbox snapshots belong before the NextAuth transaction starts. A slow
    // provider must not hold an already-issued authorize/continue state open.
    state.emailBoundary = await this.snapshotEmail(state, {
      fresh: true,
      ...(options.forceFreshEmailBoundary === true ? { forceFresh: true } : {}),
      purpose: 'registration_identity',
      preSend: true,
    });
    if (state.emailBoundary) {
      await this.checkpoint(state, session, 'email_boundary_captured', {
        fresh: true,
        purpose: 'registration_identity',
        beforeAuthorization: true,
      });
    }
    return state.emailBoundary;
  }

  async bootstrap(state, session, options = {}) {
    await this.prepareRegistrationEmailBoundary(state, session, options);
    const requestedScreenHint = identityScreenHint(options);
    const passwordLoginRequested = options.existingOnly === true && Boolean(String(state.password || '').trim());
    let authorization;
    if (passwordLoginRequested) {
      state.passwordAuthorizeAttempted = true;
      try {
        // A normal login_or_signup authorization now prefers passwordless OTP
        // for an existing account. The explicit password connection is the
        // same route used by security re-authentication and is the only point
        // at which the saved password can be tried before any mailbox read.
        authorization = await this.nextAuthAuthorize(state, session, {
          connection: 'password',
          max_age: '0',
          reauth: 'password',
        });
      } catch (error) {
        if (![400, 401, 403].includes(Number(error.status || 0))) throw error;
        await this.trySecurityCheckpoint(state, session, 'password_login_authorize_unavailable', {
          status: Number(error.status || 0),
          code: String(error.code || 'PASSWORD_LOGIN_AUTHORIZE_FAILED'),
        });
        authorization = await this.nextAuthAuthorize(state, session, {});
      }
    } else {
      authorization = await this.nextAuthAuthorize(state, session, {});
    }
    state.authorizeUrl = authorization.authorizeUrl;
    state.continueUrl = authorization.landedUrl;
    state.step = 'nextauth_ready';
    // Both hints are recorded because they can disagree: the server normalizes
    // and may override what was asked for, and that disagreement is the whole
    // difference between a one-OTP and a two-OTP registration.
    await this.checkpoint(state, session, 'nextauth_ready', {
      authorize: authUrlSummary(state.authorizeUrl),
      // What went on the authorize URL, what the `authorize/continue` body will
      // ask for, and what the server kept. Reporting the body's hint as the
      // requested one made these disagree on every run for no real reason.
      requestedScreenHint: authUrlSummary(state.authorizeUrl).screenHint,
      continueScreenHint: requestedScreenHint,
      sessionScreenHint: clientAuthSessionScreenHint(session),
      passwordLoginRequested,
    });
  }

  async submitIdentity(state, session, options = {}) {
    if (options.existingOnly === true && /\/log-in\/password\/?$/i.test(authPath(state.continueUrl))) {
      // `connection=password` can land directly on the rendered password
      // route. There is no authorize/continue request to replay in that case;
      // doing so would replace the password continuation with an OTP page.
      state.pageType = 'login_password';
      state.authPayload = {
        ...(state.authPayload || {}),
        page: { ...(state.authPayload?.page || {}), type: 'login_password' },
        continue_url: state.continueUrl,
      };
      state.step = 'identity_submitted';
      await this.checkpoint(state, session, 'identity_submitted', {
        pageType: state.pageType,
        screenHint: identityScreenHint(options),
        sessionScreenHint: clientAuthSessionScreenHint(session),
        passwordPageFromAuthorize: true,
      });
      return;
    }
    const sentinel = await this.sentinelHeaders(state, session, 'authorize_continue');
    // The existing-account endpoint is the login contract. Supplying the
    // registration-oriented screen hint makes auth.openai.com deliberately
    // choose the passwordless OTP page, even when the account has a saved
    // password. Keep the hint for signup, but let an existing account use the
    // same body as the browser login flow.
    const json = { username: { kind: 'email', value: state.email } };
    if (options.existingOnly !== true) json.screen_hint = identityScreenHint(options);
    const result = await this.request(session, 'authorize_continue', 'POST', `${AUTH_BASE}/api/accounts/authorize/continue`, {
      origin: AUTH_BASE,
      referer: `${AUTH_BASE}/log-in?usernameKind=email`,
      headers: { Accept: 'application/json', ...sentinel },
      json,
    });
    const step = authStep(result.json);
    state.continueUrl = absoluteAuthUrl(step.continueUrl);
    state.pageType = step.pageType;
    state.authPayload = result.json;
    state.step = 'identity_submitted';
    await this.checkpoint(state, session, 'identity_submitted', {
      pageType: step.pageType,
      screenHint: identityScreenHint(options),
      sessionScreenHint: clientAuthSessionScreenHint(session),
    });
  }

  async submitIdentityWithRecovery(state, session, options = {}) {
    try {
      return await this.submitIdentity(state, session, options);
    } catch (error) {
      const restarts = Number(state.authTransactionRestarts || 0);
      const canRestart = state.step === 'nextauth_ready'
        && isStaleAuthorizationState(error)
        && restarts < MAX_AUTH_TRANSACTION_RESTARTS;
      if (!canRestart) throw error;

      state.authTransactionRestarts = restarts + 1;
      resetAuthorizationTransaction(state, session);
      this.clearNextAuthContext(session);
      await this.checkpoint(state, session, 'auth_transaction_restarted', {
        previousStep: 'nextauth_ready',
        code: 'INVALID_STATE',
        status: 409,
        attempt: state.authTransactionRestarts,
        message: 'The authorization continuation expired before identity submission; rebuilding the auth transaction once',
      });
      await this.bootstrap(state, session, options);
      return this.submitIdentity(state, session, options);
    }
  }

  async snapshotEmail(state, options = {}) {
    if (typeof this.options.beforeEmailSend !== 'function') return null;
    return this.options.beforeEmailSend(state.email, state, options);
  }

  async sendEmailOtpRequest(state, send) {
    if (this.options.mailboxAvailable === false) {
      // Nothing on this run can read a mailbox (a credentials job). Sending
      // the code anyway spends a verification mail and adds to the account's
      // login attempts — it only ever ended in "callback is not configured"
      // a second later. Say why the login needs one instead.
      const rejection = state.passwordLoginRejection || null;
      const resetRequired = String(rejection?.code || '').toUpperCase() === 'PASSWORD_RESET_REQUIRED';
      const error = new Error(resetRequired
        ? 'OpenAI requires a password reset for this account (password login rejected with PASSWORD_RESET_REQUIRED); only an email code can sign it in, and this run has no mailbox'
        : (rejection
          ? `Password login was rejected (${rejection.code || rejection.status}); only an email code can sign this account in, and this run has no mailbox`
          : 'This login requires an email verification code, and this run has no mailbox to read it from'));
      error.code = resetRequired ? 'PASSWORD_RESET_REQUIRED' : 'EMAIL_OTP_MAILBOX_UNAVAILABLE';
      error.retryable = false;
      error.emailOtpNotSent = true;
      throw error;
    }
    const sendStartedAt = markEmailOtpSendStarted(state);
    try {
      const result = await send();
      markEmailOtpSent(state, sendStartedAt, result);
      return result;
    } catch (error) {
      // A transport error does not tell us whether the upstream send was
      // accepted. Keep the current auth transaction and mailbox boundary so a
      // resume can look for that code before creating a new transaction.
      if (transportOutcomeMayBeUnknown(error)) {
        markEmailOtpSendUncertain(state, sendStartedAt, error);
        error.emailOtpSendOutcomeUncertain = true;
      } else {
        state.emailOtpSendStartedAt = '';
      }
      throw error;
    }
  }

  emailOtpSendRecoveryTimeoutMs() {
    const configured = Number(this.options.emailOtpSendReconcileTimeoutMs);
    if (!Number.isFinite(configured) || configured <= 0) return EMAIL_OTP_SEND_RECONCILE_TIMEOUT_MS;
    return Math.max(1000, Math.min(EMAIL_OTP_SEND_RECONCILE_TIMEOUT_MS, Math.floor(configured)));
  }

  async resumeFreshEmailOtpTransaction(state, session, options = {}) {
    const resumeOptions = {
      ...options,
      forceFreshEmailBoundary: true,
    };
    if (state.step === 'initial') {
      await this.bootstrap(state, session, {
        existingOnly: resumeOptions.existingOnly === true,
        forceFreshEmailBoundary: true,
      });
    }
    if (state.step === 'nextauth_ready') {
      await this.submitIdentityWithRecovery(state, session, {
        existingOnly: resumeOptions.existingOnly === true,
      });
    }
    if (state.step === 'identity_submitted') {
      await this.sendEmailOtp(state, session, {
        ...resumeOptions,
        ignoreEmailOtpRecovery: true,
      });
    }
    if (['email_otp_sent', 'email_otp_validated'].includes(String(state.step || ''))) return true;
    const error = new Error(`Email OTP recovery stopped at ${state.step || 'unknown step'}`);
    error.code = 'EMAIL_OTP_RECOVERY_STEP_INVALID';
    error.retryable = false;
    throw error;
  }

  async restartEmailOtpTransaction(state, session, options = {}, details = {}) {
    const previous = state.emailOtpSendRecovery && typeof state.emailOtpSendRecovery === 'object'
      ? state.emailOtpSendRecovery
      : {};
    const previousRetryCount = emailOtpRecoveryRetryCount(previous);
    const retryCount = previousRetryCount + 1;
    if (emailOtpRecoveryRetryUsed(previous) || retryCount > MAX_EMAIL_OTP_SEND_RECOVERY_RETRIES) {
      const error = new Error('Email OTP send recovery has already used its single fresh-code retry');
      error.code = 'EMAIL_OTP_SEND_RECOVERY_EXHAUSTED';
      error.retryable = false;
      throw error;
    }
    const at = new Date().toISOString();
    state.emailOtpSendRecovery = {
      ...previous,
      status: 'retrying',
      retryCount,
      retryUsed: retryCount >= MAX_EMAIL_OTP_SEND_RECOVERY_RETRIES,
      restartedAt: at,
      lastError: details.error ? errorCheckpointDetails(details.error) : (previous.lastError || null),
    };
    state.emailBoundary = null;
    state.emailOtpSentAt = '';
    state.emailOtpSentAtSource = '';
    state.emailOtpSendStartedAt = '';
    state.createAccountAttempt = null;
    resetAuthorizationTransaction(state, session);
    this.clearNextAuthContext(session);
    await this.checkpoint(state, session, 'email_otp_transaction_restarted', {
      reason: details.reason || 'email_otp_send_outcome_uncertain',
      attempt: Number(previous.attempts || 0),
      retry: retryCount,
    });
    return this.resumeFreshEmailOtpTransaction(state, session, options);
  }

  async reconcileEmailOtpSend(state, session, options = {}) {
    const recovery = state.emailOtpSendRecovery;
    const recoveryStatus = String(recovery?.status || '');
    if (!recovery || !EMAIL_OTP_SEND_RECOVERY_STATUSES.has(recoveryStatus) || recoveryStatus === 'retrying') return false;
    if (recovery.status === 'exhausted') {
      const error = new Error('Email OTP send recovery has already used its single fresh-code retry');
      error.code = 'EMAIL_OTP_SEND_RECOVERY_EXHAUSTED';
      error.retryable = false;
      throw error;
    }

    if (!state.emailBoundary) {
      return this.restartEmailOtpTransaction(state, session, options, {
        reason: 'original_email_otp_boundary_missing',
      });
    }

    // The old send may have succeeded. Reading against the original boundary
    // is the only safe way to determine that without invalidating the code by
    // sending again. The read path is explicitly marked as reconciliation so
    // a missing result does not demote a healthy mail domain.
    recovery.status = 'reconciling';
    recovery.reconcileStartedAt = new Date().toISOString();
    await this.checkpoint(state, session, 'email_otp_send_reconciliation_started', {
      attempt: Number(recovery.attempts || 0),
    });
    let found;
    try {
      found = await this.waitEmailCode(state, state.emailBoundary, {
        timeoutMs: this.emailOtpSendRecoveryTimeoutMs(),
        maxPollAttempts: 3,
        reportDelivery: false,
        purpose: 'email_otp_send_reconciliation',
      });
    } catch (error) {
      const code = String(error.code || '').toUpperCase();
      const noCode = ['EMAIL_OTP_TIMEOUT', 'EMAIL_NOT_DELIVERED_TO_TARGET'].includes(code);
      if (!noCode) {
        state.emailOtpSendRecovery = {
          ...recovery,
          status: 'uncertain',
          lastError: errorCheckpointDetails(error),
        };
        throw error;
      }
      if (emailOtpRecoveryRetryUsed(recovery)) {
        state.emailOtpSendRecovery = {
          ...recovery,
          status: 'exhausted',
          exhaustedAt: new Date().toISOString(),
          lastError: errorCheckpointDetails(error),
        };
        await this.checkpoint(state, session, 'email_otp_send_recovery_exhausted', {
          attempt: Number(recovery.attempts || 0),
        });
        const exhausted = new Error('No code arrived after the original send and its single fresh-code retry');
        exhausted.code = 'EMAIL_OTP_SEND_RECOVERY_EXHAUSTED';
        exhausted.retryable = false;
        throw exhausted;
      }
      return this.restartEmailOtpTransaction(state, session, options, {
        reason: 'original_email_otp_not_observed',
        error,
      });
    }
    const sentAt = String(found.receivedAt || recovery.startedAt || new Date().toISOString());
    state.emailOtpSentAt = sentAt;
    state.emailBoundary = { ...(state.emailBoundary || {}), sentAt };
    state.emailOtpSendRecovery = null;
    state.step = 'email_otp_sent';
    await this.checkpoint(state, session, 'email_otp_send_reconciled');
    // The reconciliation read already returned the code. Validate that value
    // immediately rather than polling the same message twice. If validation
    // fails, its error belongs to validation, not to the send outcome.
    try {
      await this.validateEmailOtp(state, session, found);
    } catch (error) {
      // A code found during reconciliation can still be an old/stale code.
      // Treat that as a validation failure, then use the same single fresh-code
      // path as the ordinary runner instead of replaying the rejected value.
      if (await this.retryNextQueuedEmailCode(state, session, error)) return true;
      if (!isWrongEmailOtpError(error)
        || Number(state.emailOtpValidationRetries || 0) >= MAX_EMAIL_OTP_VALIDATION_RETRIES) throw error;
      await this.restartAfterWrongEmailOtp(state, session, options, error);
    }
    return true;
  }

  /**
   * Signs in with the saved password instead of a mailbox round-trip.
   *
   * Returns true when the login is under way — the continuation has been
   * followed and `state.step` now points at MFA, a phone challenge or a
   * completed callback. Returns false when the server still insists on an
   * email code, leaving `state` positioned so the caller's existing OTP tail
   * takes over.
   */
  async verifyPassword(state, session) {
    const password = String(state.password || '').trim();
    if (!password) return false;
    const sentinel = await this.sentinelHeaders(state, session, 'password_verify');
    let verified;
    try {
      verified = await this.request(session, 'password_verify', 'POST', `${AUTH_BASE}/api/accounts/password/verify`, {
        origin: AUTH_BASE,
        referer: `${AUTH_BASE}/log-in/password`,
        headers: { Accept: 'application/json', ...sentinel },
        json: { password },
        statuses: [200],
      });
    } catch (error) {
      // A stored password can go stale — changed server-side, or written by an
      // older run. Before this path existed the branch always sent a mailbox
      // code, so a rejected password must degrade to that rather than fail a
      // job the mailbox could still finish.
      const status = Number(error.status || 0);
      const code = String(error.code || '').toUpperCase();
      if (code === 'ACCOUNT_DEACTIVATED') {
        error.retryable = false;
        await this.checkpoint(state, session, 'password_login_rejected', { status, code });
        throw error;
      }
      if (![400, 401, 403].includes(status)) throw error;
      state.passwordLoginRejection = { status, code };
      await this.checkpoint(state, session, 'password_login_rejected', { status, code });
      return false;
    }
    const step = authStep(verified.json);
    const continueUrl = absoluteAuthUrl(step.continueUrl || verified.response?.location);
    if (!continueUrl) {
      const error = new Error('Password login did not return a continuation URL');
      error.code = 'PASSWORD_LOGIN_CONTINUATION_MISSING';
      throw error;
    }
    state.authPayload = verified.json;
    state.continueUrl = continueUrl;
    state.pageType = step.pageType;

    if (isEmailVerificationUrl(continueUrl)) {
      // The password was right but the account still wants a mailbox code.
      // Nothing can read one on a credentials-only run, so fail loudly here
      // rather than block on a poll that can never be answered.
      if (typeof this.options.getEmailCode !== 'function') {
        const error = new Error('Password login was accepted but the account still requires an email verification code');
        error.code = 'PASSWORD_LOGIN_EMAIL_VERIFICATION_REQUIRED';
        error.retryable = false;
        throw error;
      }
      if (!state.emailBoundary) {
        state.emailBoundary = await this.snapshotEmail(state);
        await this.checkpoint(state, session, 'email_boundary_captured');
      }
      // A continuation can be the send endpoint itself or the verification
      // page. Handle both here so every caller observes one durable OTP
      // boundary and none of them can issue a second code while unwinding the
      // password fallback.
      const emailOtpUrl = /\/api\/accounts\/email-otp\/send/i.test(authPath(continueUrl))
        ? continueUrl
        : `${AUTH_BASE}/api/accounts/email-otp/send`;
      await this.sendEmailOtpRequest(state, () => this.request(session, 'email_otp_send', 'GET', emailOtpUrl, {
        follow: true,
        referer: `${AUTH_BASE}/log-in/password`,
        statuses: [200, 302],
      }));
      state.step = 'email_otp_sent';
      await this.checkpoint(state, session, 'password_login_email_fallback', { pageType: step.pageType });
      return false;
    }

    state.step = 'password_verified';
    await this.checkpoint(state, session, 'password_verified', { pageType: step.pageType });
    await this.followContinuation(state, session);
    return true;
  }

  /**
   * The existing-account authorize flow can land on the email-code screen
   * even when the account has a password. The browser's password fallback is
   * a normal navigation to `/log-in/password`; without replaying that
   * navigation the runner has no password page to submit and immediately
   * falls into the mailbox path.
   *
   * Returns false when the saved password is rejected so the caller can keep
   * its passwordless email-OTP fallback. A successful password login follows
   * the continuation and returns true.
   */
  async useExistingAccountPassword(state, session, step, options = {}) {
    const pageType = step.pageType || state.pageType;
    if (options.existingOnly !== true) return false;
    if (!/^email_otp_verification/.test(String(pageType || ''))) return false;
    // `passwordAuthorizeAttempted` only means the authorize URL asked for the
    // password connection; it submits nothing. When that request still lands
    // on the code screen, the detour below is the only way the saved password
    // gets used — skipping it sent every credentials login to a mailbox it
    // does not have. What must not repeat is a password actually submitted.
    if (state.passwordLoginAttempted === true) return false;
    if (state.existingAccount || !String(state.password || '').trim()) return false;

    const passwordUrl = `${AUTH_BASE}/log-in/password`;
    try {
      await this.request(session, 'login_password_page', 'GET', passwordUrl, {
        follow: true,
        referer: `${AUTH_BASE}/email-verification`,
        accept: 'text/html,application/xhtml+xml',
        statuses: [200, 302],
      });
    } catch (error) {
      // The email-code page can expose a stale or closed password detour. That
      // is an authentication-step rejection, not a transport failure; use the
      // one allowed passwordless OTP fallback below. Never turn mail/provider
      // errors into another password attempt or another code send.
      if (![400, 401, 403].includes(Number(error.status || 0))) throw error;
      await this.trySecurityCheckpoint(state, session, 'password_login_page_unavailable', {
        status: Number(error.status || 0),
        code: String(error.code || 'LOGIN_PASSWORD_PAGE_FAILED'),
      });
      return false;
    }
    // Keep the marker across a checkpoint. If the password is rejected, the
    // same run must move on to passwordless OTP rather than submit it twice.
    state.passwordLoginAttempted = true;
    state.existingAccount = true;
    state.pageType = 'login_password';
    state.continueUrl = passwordUrl;
    state.authPayload = {
      ...(state.authPayload || {}),
      page: { ...(state.authPayload?.page || {}), type: 'login_password' },
      continue_url: passwordUrl,
    };
    await this.checkpoint(state, session, 'login_password_page');
    return this.verifyPassword(state, session);
  }

  /**
   * Takes the "Continue with password" exit off the verification-code screen.
   *
   * A signup lands on `email_otp_verification` and, left alone, becomes a
   * passwordless account — attaching a password afterwards then costs a second
   * email OTP. The browser avoids that with a plain client-side navigation:
   *
   *     passwordFallbackPath = mode === 'passwordless_signup'
   *       ? '/create-account/password' : '/log-in/password'
   *
   * There is no API behind the button. Loading that document and posting
   * `user/register` is the whole mechanism, and it leaves exactly one OTP in
   * the flow. Neither `screen_hint` on the authorize nor on the continue body
   * has any bearing on it; live runs proved every combination lands here.
   *
   * Returns false — never throws — when the detour is not on offer, so a
   * server that has closed it degrades to the passwordless account this code
   * already knew how to finish.
   */
  async useCreateAccountPassword(state, session, step) {
    const pageType = step.pageType || state.pageType;
    if (!/^email_otp_verification/.test(String(pageType || ''))) return false;
    if (state.accountCreated || state.existingAccount) return false;

    const password = String(state.password || '').trim() || randomPassword();
    if (!state.accountRegistered) {
      try {
        await this.request(session, 'create_account_password_page', 'GET', `${AUTH_BASE}/create-account/password`, {
          follow: true,
          referer: `${AUTH_BASE}/email-verification`,
          accept: 'text/html,application/xhtml+xml',
          statuses: [200, 302],
        });
        const sentinel = await this.sentinelHeaders(state, session, 'username_password_create');
        const registered = await this.request(session, 'user_register', 'POST', `${AUTH_BASE}/api/accounts/user/register`, {
          origin: AUTH_BASE,
          referer: `${AUTH_BASE}/create-account/password`,
          headers: { Accept: 'application/json', ...sentinel },
          json: { username: state.email, password },
          statuses: [200],
        });
        state.authPayload = registered.json;
        state.password = password;
        state.security = state.security || {};
        state.security.passwordStatus = 'configured';
        state.security.setPassword = true;
        // Persist this boundary before any mailbox read. If 8001 is briefly
        // unavailable, a resume can continue from the successful register
        // response without submitting the password again.
        state.accountRegistered = true;
        await this.checkpoint(state, session, 'password_registered_during_registration', {
          pageType: authStep(registered.json).pageType,
        });
      } catch (error) {
        if (!passwordDetourCanFallback(error)) throw error;
        // Only an explicit auth-step rejection means the password detour is
        // unavailable. The passwordless path remains a valid fallback then.
        await this.trySecurityCheckpoint(state, session, 'password_during_registration_unavailable', {
          code: String(error.code || 'CREATE_ACCOUNT_PASSWORD_UNAVAILABLE'),
          status: Number(error.status || 0),
        });
        return false;
      }
    }

    // Re-baseline only when a new code is actually coming. `user/register`
    // answers with the send endpoint on the happy path; if it answers with
    // anything else, the only code in flight is the earlier one and moving
    // the boundary past it would guarantee a timeout.
    const registeredStep = authStep(state.authPayload || {});
    const willSend = /\/api\/accounts\/email-otp\/send/i.test(registeredStep.continueUrl || '');
    const boundary = willSend
      ? await this.snapshotEmail(state, { fresh: true, purpose: 'registration', preSend: true })
      : null;
    if (boundary) state.emailBoundary = boundary;
    await this.checkpoint(state, session, 'password_set_during_registration', {
      pageType: registeredStep.pageType,
      rebaselined: Boolean(boundary),
    });
    return true;
  }

  async sendEmailOtp(state, session, options = {}) {
    if (options.ignoreEmailOtpRecovery !== true) {
      const recoveryStatus = String(state.emailOtpSendRecovery?.status || '');
      if (recoveryStatus === 'uncertain' || recoveryStatus === 'reconciling') {
        return this.reconcileEmailOtpSend(state, session, options);
      }
      if (recoveryStatus === 'retrying') {
        return this.resumeFreshEmailOtpTransaction(state, session, options);
      }
      if (recoveryStatus === 'exhausted') {
        const error = new Error('Email OTP send recovery has already used its single fresh-code retry');
        error.code = 'EMAIL_OTP_SEND_RECOVERY_EXHAUSTED';
        error.retryable = false;
        throw error;
      }
    }
    const security = options.security || options;
    // Tracks whether a code is already on its way, so the shared tail neither
    // double-sends nor leaves the job waiting for a mail nobody asked for.
    let sent = false;
    const step = authStep(state.authPayload || {});
    const pageType = step.pageType || state.pageType;
    const ensureEmailBoundary = async () => {
      if (state.emailBoundary) return;
      // Every branch below calls this before its send request, so the
      // boundary may discard codes still queued from earlier transactions.
      state.emailBoundary = await this.snapshotEmail(state, {
        ...(options.forceFreshEmailBoundary === true ? { fresh: true, forceFresh: true } : {}),
        purpose: 'registration',
        preSend: true,
      });
      await this.checkpoint(state, session, 'email_boundary_captured');
    };

    if (pageType === 'create_account_password' || /create-account\/password/i.test(step.continueUrl)) {
      if (options.existingOnly === true) {
        const error = new Error('OAuth email source does not belong to an existing account');
        error.code = 'OAUTH_EXISTING_ACCOUNT_REQUIRED';
        throw error;
      }
      await ensureEmailBoundary();
      state.password = state.password || randomPassword();
      state.passwordRequiredByFlow = security.setPassword !== true;
      const sentinel = await this.sentinelHeaders(state, session, 'username_password_create');
      const registered = await this.request(session, 'user_register', 'POST', `${AUTH_BASE}/api/accounts/user/register`, {
        origin: AUTH_BASE,
        referer: `${AUTH_BASE}/create-account/password`,
        headers: { Accept: 'application/json', ...sentinel },
        json: { username: state.email, password: state.password },
      });
      state.authPayload = registered.json;
      state.security.passwordStatus = 'configured';
      state.security.setPassword = true;
    } else if (state.step === 'email_otp_sent') {
      sent = true;
    } else if (options.existingOnly === true && await this.useExistingAccountPassword(state, session, step, options)) {
      return;
    } else if (options.existingOnly === true && /^email_otp_verification/.test(String(pageType || ''))) {
      // Existing-account email verification is already the fallback page. It
      // must use passwordless/send-otp exactly once; the generic continuation
      // branch would GET the same send endpoint again after a rejected password
      // detour and invalidate the first code.
      if (state.step === 'email_otp_sent') return;
      await ensureEmailBoundary();
      await this.sendEmailOtpRequest(state, () => this.request(session, 'passwordless_send_otp', 'POST', `${AUTH_BASE}/api/accounts/passwordless/send-otp`, {
        origin: AUTH_BASE,
        referer: `${AUTH_BASE}/email-verification`,
        headers: { Accept: 'application/json' },
        json: {},
        statuses: [200, 201, 204],
      }));
      sent = true;
    } else if (options.existingOnly !== true && await this.useCreateAccountPassword(state, session, step)) {
      // Handled inside: the account now exists with a password, and the tail
      // below issues the one email OTP the whole registration needs.
    } else if (pageType === 'login_password'
      || pageType === 'password'
      || /log-in\/password/i.test(step.continueUrl)
      || /log-in\/password/i.test(state.continueUrl)) {
      state.existingAccount = true;
      // A saved password turns the login page into a one-request step. Falling
      // back to the passwordless OTP here is what used to make every OAuth and
      // every login-state refresh read a mailbox it does not need.
      if (String(state.password || '').trim() && state.passwordLoginAttempted !== true) {
        if (await this.verifyPassword(state, session)) return;
        if (state.step === 'email_otp_sent') return;
      }
      await ensureEmailBoundary();
      await this.sendEmailOtpRequest(state, () => this.request(session, 'passwordless_send_otp', 'POST', `${AUTH_BASE}/api/accounts/passwordless/send-otp`, {
        origin: AUTH_BASE,
        referer: `${AUTH_BASE}/log-in/password`,
        headers: { Accept: 'application/json' },
        json: {},
        statuses: [200, 201, 204],
      }));
      sent = true;
    } else {
      await ensureEmailBoundary();
      const sendUrl = absoluteAuthUrl(step.continueUrl || `${AUTH_BASE}/api/accounts/email-otp/send`);
      await this.sendEmailOtpRequest(state, () => this.request(session, 'email_otp_send', 'GET', sendUrl, {
        follow: true,
        referer: `${AUTH_BASE}/create-account/password`,
        statuses: [200, 302],
      }));
      // Already sent. The tail below must not fire again: the continuation on
      // `authPayload` is unchanged in this branch, so it matches the same send
      // endpoint and used to issue a second code that invalidated the first.
      sent = true;
    }

    // verifyPassword may have already sent the code while handling an
    // existing-account password fallback. Its checkpoint is the durable
    // boundary; do not send the same OTP again from this shared tail.
    if (state.step === 'email_otp_sent') return;

    if (!sent) {
      const afterRegister = authStep(state.authPayload || {});
      if (afterRegister.continueUrl && /\/api\/accounts\/email-otp\/send/i.test(afterRegister.continueUrl)) {
        await ensureEmailBoundary();
        await this.sendEmailOtpRequest(state, () => this.request(session, 'email_otp_send', 'GET', absoluteAuthUrl(afterRegister.continueUrl), {
          follow: true,
          referer: `${AUTH_BASE}/create-account/password`,
          statuses: [200, 302],
        }));
        sent = true;
      }
    }
    if (!sent) {
      // No code is on its way. Saying so is better than parking the job on a
      // poll that can only end in a timeout.
      const error = new Error('The authentication flow did not issue an email verification code');
      error.code = 'EMAIL_OTP_NOT_SENT';
      error.retryable = false;
      throw error;
    }
    state.step = 'email_otp_sent';
    await this.checkpoint(state, session, 'email_otp_sent');
  }

  async waitEmailCode(state, boundary = state.emailBoundary, options = {}) {
    if (typeof this.options.getEmailCode !== 'function') throw new Error('Email OTP callback is not configured');
    const result = await this.options.getEmailCode(state.email, boundary, state, options);
    const code = normalizeEmailOtp(typeof result === 'string' ? result : result?.code);
    if (!code) {
      const error = new Error('Email OTP callback did not return a valid code');
      error.code = 'EMAIL_OTP_FORMAT_INVALID';
      throw error;
    }
    return code;
  }

  async validateEmailOtp(state, session, received = null) {
    const code = normalizeEmailOtp(
      received
        ? (typeof received === 'string' ? received : received.code)
        : await this.waitEmailCode(state),
    );
    if (!code) {
      const error = new Error('Email OTP callback did not return a valid code');
      error.code = 'EMAIL_OTP_FORMAT_INVALID';
      throw error;
    }
    let result;
    try {
      result = await this.request(session, 'email_otp_validate', 'POST', `${AUTH_BASE}/api/accounts/email-otp/validate`, {
        origin: AUTH_BASE,
        referer: `${AUTH_BASE}/email-verification`,
        headers: { Accept: 'application/json' },
        json: { code },
      });
    } catch (error) {
      // Lets a follow-up read refuse to submit the value that was just
      // rejected. Not checkpointed; it lives only on the thrown error.
      if (error && typeof error === 'object') error.submittedEmailOtp = code;
      throw error;
    }
    const step = authStep(result.json);
    state.authPayload = result.json;
    state.continueUrl = absoluteAuthUrl(step.continueUrl);
    state.pageType = step.pageType;
    state.step = step.pageType === 'add_phone' || /add-phone/i.test(step.continueUrl)
      ? 'phone_required'
      : step.pageType === 'mfa_challenge' || /mfa-challenge/i.test(step.continueUrl)
        ? 'mfa_required'
        : 'email_otp_validated';
    await this.checkpoint(state, session, 'email_otp_validated', { pageType: step.pageType });
  }

  async sendPhone(state, phone) {
    const session = this.session(state);
    const phoneRequest = phoneSendPayload(phone, state.authPayload, session.serializeCookies());
    const result = await this.request(session, 'phone_otp_send', 'POST', `${AUTH_BASE}/api/accounts/add-phone/send`, {
      origin: AUTH_BASE,
      referer: `${AUTH_BASE}/add-phone`,
      headers: { Accept: 'application/json' },
      json: phoneRequest.payload,
    });
    const step = authStep(result.json);
    state.authPayload = result.json;
    state.continueUrl = absoluteAuthUrl(step.continueUrl);
    state.pageType = step.pageType;
    state.step = 'phone_otp_sent';
    await this.checkpoint(state, session, 'phone_otp_sent', {
      channelIncluded: Object.hasOwn(phoneRequest.payload, 'channel'),
      multiChannelAllowed: phoneRequest.multiChannelAllowed,
    });
    return state;
  }

  async validatePhone(state, code) {
    const session = this.session(state);
    const result = await this.request(session, 'phone_otp_validate', 'POST', `${AUTH_BASE}/api/accounts/phone-otp/validate`, {
      origin: AUTH_BASE,
      referer: `${AUTH_BASE}/phone-verification`,
      headers: { Accept: 'application/json' },
      json: { code: String(code) },
    });
    const step = authStep(result.json);
    state.authPayload = result.json;
    state.continueUrl = absoluteAuthUrl(step.continueUrl);
    state.pageType = step.pageType;
    state.step = step.pageType === 'mfa_challenge' || /mfa-challenge/i.test(step.continueUrl)
      ? 'mfa_required'
      : 'email_otp_validated';
    await this.checkpoint(state, session, 'phone_otp_validated', { pageType: step.pageType });
    return state;
  }

  async completeMfa(state, session) {
    const factor = mfaTotpFactor(state.authPayload || {});
    if (!factor.id || factor.type !== 'totp') {
      const error = new Error('The authentication flow requires an unsupported MFA factor');
      error.code = 'MFA_TOTP_FACTOR_UNAVAILABLE';
      error.retryable = false;
      throw error;
    }
    if (!state.totpSecret) {
      state.mfaChallenge = {
        status: 'blocked',
        factorType: factor.type,
        requestedAt: state.updatedAt || new Date().toISOString(),
      };
      await this.checkpoint(state, session, 'mfa_required', { factorType: factor.type });
      const error = new Error('The authentication flow requires a TOTP secret, but this session asset does not have one');
      error.code = 'MFA_TOTP_SECRET_REQUIRED';
      error.retryable = false;
      throw error;
    }

    const challenge = state.mfaChallenge || {};
    if (challenge.status === 'verified' && state.continueUrl) {
      state.step = 'mfa_validated';
      await this.followContinuation(state, session);
      return;
    }
    if (challenge.status !== 'issued' || challenge.factorId !== factor.id) {
      const referer = absoluteAuthUrl(state.continueUrl) || `${AUTH_BASE}/mfa-challenge`;
      await this.request(session, 'mfa_issue_challenge', 'POST', `${AUTH_BASE}/api/accounts/mfa/issue_challenge`, {
        origin: AUTH_BASE,
        referer,
        headers: { Accept: 'application/json' },
        json: { id: factor.id, type: 'totp', force_fresh_challenge: false },
        statuses: [200, 201, 204],
      });
      state.mfaChallenge = {
        status: 'issued',
        factorId: factor.id,
        factorType: factor.type,
        issuedAt: new Date().toISOString(),
      };
      state.step = 'mfa_challenge_issued';
      await this.checkpoint(state, session, 'mfa_challenge_issued', { factorType: factor.type });
    }

    const referer = absoluteAuthUrl(state.continueUrl) || `${AUTH_BASE}/mfa-challenge`;
    const invocationId = state.mfaChallenge?.invocationId || crypto.randomUUID();
    state.mfaChallenge = {
      ...(state.mfaChallenge || {}),
      status: 'verification_pending',
      invocationId,
      verificationStartedAt: new Date().toISOString(),
    };
    state.step = 'mfa_verification_pending';
    await this.checkpoint(state, session, 'mfa_verification_pending', { factorType: factor.type });
    const verified = await this.request(session, 'mfa_verify', 'POST', `${AUTH_BASE}/api/accounts/mfa/verify`, {
      origin: AUTH_BASE,
      referer,
      headers: {
        Accept: 'application/json',
          'x-access-flow-invocation-id': invocationId,
      },
      json: { id: factor.id, type: 'totp', code: totpCode(state.totpSecret) },
      statuses: [200],
    });
    const next = authStep(verified.json);
    const nextUrl = absoluteAuthUrl(next.continueUrl || verified.response?.location);
    if (!nextUrl) {
      const error = new Error('MFA verification did not return a continuation URL');
      error.code = 'MFA_CONTINUATION_MISSING';
      throw error;
    }
    state.authPayload = verified.json;
    state.continueUrl = nextUrl;
    state.pageType = next.pageType;
    state.mfaChallenge = {
      ...(state.mfaChallenge || {}),
      status: 'verified',
      verifiedAt: new Date().toISOString(),
    };
    state.step = 'mfa_validated';
    await this.checkpoint(state, session, 'mfa_validated', { factorType: factor.type });
    await this.followContinuation(state, session);
  }

  async completeAccount(state, session, options = {}) {
    let step = authStep(state.authPayload || {});
    if (step.pageType === 'mfa_challenge' || /mfa-challenge/i.test(step.continueUrl)) {
      state.existingAccount = true;
      state.step = 'mfa_required';
      await this.checkpoint(state, session, 'mfa_required', { factorType: mfaTotpFactor(state.authPayload).type });
      return;
    }
    if (step.pageType === 'about_you' || /\/about-you/i.test(step.continueUrl)) {
      if (options.existingOnly === true) {
        const error = new Error('OAuth email source reached new-account creation instead of existing-account login');
        error.code = 'OAUTH_EXISTING_ACCOUNT_REQUIRED';
        throw error;
      }
      let created;
      let creationReconciled = false;
      let retryCount = Number(state.createAccountRetry?.attempts || 0);
      let createAttemptCount = Number(state.createAccountAttempt?.attempts || 0);
      const pendingAt = Date.parse(state.createAccountRetry?.nextAttemptAt || '');
      if (Number.isFinite(pendingAt) && pendingAt > Date.now()) await this.wait(pendingAt - Date.now());
      while (!created && !creationReconciled) {
        const attempt = createAttemptCount + 1;
        const sentinel = await this.sentinelHeaders(state, session, 'oauth_create_account');
        try {
          created = await this.request(session, 'create_account', 'POST', `${AUTH_BASE}/api/accounts/create_account`, {
            origin: AUTH_BASE,
            referer: `${AUTH_BASE}/about-you`,
            headers: { Accept: 'application/json', ...sentinel },
            json: {
              name: String(this.options.name || 'Alex'),
              birthdate: String(this.options.birthdate || '2001-01-01'),
            },
          });
          createAttemptCount = attempt;
        } catch (error) {
          const code = String(error.code || '').toUpperCase();
          const previousCreateAttempt = state.createAccountAttempt;
          if (code === 'USER_ALREADY_EXISTS' && previousCreateAttempt?.status === 'uncertain') {
            const responseStep = authStep(error.response || {});
            const responseContinuation = responseStep.continueUrl || error.response?.location || state.continueUrl;
            if (responseStep.continueUrl || responseStep.pageType) state.authPayload = error.response;
            if (responseContinuation) state.continueUrl = absoluteAuthUrl(responseContinuation);
            state.pageType = responseStep.pageType || state.pageType;
            state.accountCreated = true;
            state.accountCreatedAt = state.accountCreatedAt || new Date().toISOString();
            state.createAccountAttempt = {
              ...previousCreateAttempt,
              status: 'reconciled_existing',
              attempts: Math.max(Number(previousCreateAttempt.attempts || 0), attempt),
              reconciledAt: new Date().toISOString(),
              lastError: errorCheckpointDetails(error),
            };
            creationReconciled = true;
            await this.checkpoint(state, session, 'account_creation_reconciled', {
              attempt,
              reason: 'user_already_exists_after_uncertain_create',
            });
            break;
          }
          if (transportOutcomeMayBeUnknown(error)) {
            createAttemptCount = attempt;
            state.createAccountAttempt = {
              ...(previousCreateAttempt && typeof previousCreateAttempt === 'object' ? previousCreateAttempt : {}),
              status: 'uncertain',
              attempts: attempt,
              startedAt: String(previousCreateAttempt?.startedAt || new Date().toISOString()),
              lastAttemptAt: new Date().toISOString(),
              lastError: errorCheckpointDetails(error),
            };
            await this.checkpoint(state, session, 'create_account_outcome_uncertain', {
              attempt,
              code,
              status: Number(error.status || error.httpStatus || 0),
            });
            error.accountCreationUncertain = true;
            error.retryable = true;
            error.category = error.category || 'transient';
            throw error;
          }
          if (code !== 'PHONE_RECENTLY_USED' || retryCount >= CREATE_ACCOUNT_RETRY_DELAYS_MS.length) {
            const continuityBlocked = code === 'PHONE_RECENTLY_USED';
            state.createAccountRetry = {
              attempts: retryCount,
              exhausted: continuityBlocked,
              failedAt: new Date().toISOString(),
            };
            if (continuityBlocked) {
              error.retryable = true;
              error.waitPhase = 'waiting_phone_continuity';
            }
            throw error;
          }
          const delayMs = CREATE_ACCOUNT_RETRY_DELAYS_MS[retryCount];
          retryCount += 1;
          state.createAccountRetry = {
            attempts: retryCount,
            delayMs,
            nextAttemptAt: new Date(Date.now() + delayMs).toISOString(),
          };
          await this.checkpoint(state, session, 'create_account_retry', { attempt: retryCount, delayMs, code: error.code });
          await this.wait(delayMs);
        }
      }
      delete state.createAccountRetry;
      if (!creationReconciled) {
        delete state.createAccountAttempt;
        state.authPayload = created.json;
        step = authStep(created.json);
        state.continueUrl = absoluteAuthUrl(step.continueUrl);
        state.pageType = step.pageType;
        state.accountCreated = true;
        state.accountCreatedAt = state.accountCreatedAt || new Date().toISOString();
        state.step = 'account_created';
        await this.checkpoint(state, session, 'account_created', { pageType: step.pageType });
      } else {
        state.step = 'account_created';
      }
    } else {
      state.existingAccount = true;
    }
    try {
      await this.followContinuation(state, session);
    } catch (error) {
      if (state.accountCreated === true) error.accountCreated = true;
      throw error;
    }
  }

  async followContinuation(state, session) {
    let nextUrl = absoluteAuthUrl(state.continueUrl);
    let callbackFollowed = false;
    for (let index = 0; nextUrl && index < 16; index += 1) {
      if (isChatGptCallbackUrl(nextUrl)) {
        state.pendingAuthCallbackUrl = nextUrl;
        state.step = 'auth_callback_pending';
        await this.checkpoint(state, session, 'auth_callback_pending', {
          callbackPath: '/api/auth/callback/openai',
        });
        const callbackResult = await this.request(session, 'chatgpt_callback', 'GET', nextUrl, {
          follow: true,
          referer: state.continueUrl || `${AUTH_BASE}/email-verification`,
          accept: 'text/html,application/xhtml+xml',
        });
        await this.checkpoint(state, session, 'auth_callback_response_received', {
          callbackPath: '/api/auth/callback/openai',
          status: Number(callbackResult.response?.status || 0),
        });
        const callbackError = callbackErrorReason(callbackResult);
        if (callbackError) {
          const error = new Error(`NextAuth callback returned an error page (${callbackError})`);
          error.code = 'AUTH_CALLBACK_ERROR_PAGE';
          error.authCallbackCompleted = false;
          // The account already exists at this point — creation happened two
          // steps back. Saying so is what lets the orchestrator keep it instead
          // of discarding a registered account with its mailbox.
          error.accountCreated = state.accountCreated === true || state.step === 'auth_callback_pending';
          error.callbackErrorReason = callbackError;
          error.diagnostics = authResponseDiagnostics(callbackResult);
          throw error;
        }
        state.authCallbackUrl = nextUrl;
        state.pendingAuthCallbackUrl = '';
        callbackFollowed = true;
        break;
      }
      const pathName = new URL(nextUrl, AUTH_BASE).pathname;
      if (/\/mfa-challenge(?:\/|$)/i.test(pathName)) {
        state.pageType = 'mfa_challenge';
        state.step = 'mfa_required';
        await this.checkpoint(state, session, 'mfa_required', { factorType: mfaTotpFactor(state.authPayload).type });
        return;
      }
      if (/\/(?:add-phone|phone-verification)(?:\/|$)/i.test(pathName)) {
        state.step = 'phone_required';
        await this.checkpoint(state, session, 'phone_required');
        return;
      }
      const result = await this.request(session, 'auth_continue', 'GET', nextUrl, {
        follow: false,
        referer: nextUrl,
        accept: 'text/html,application/xhtml+xml,application/json',
      });
      const location = result.response.location ? absoluteAuthUrl(result.response.location) : '';
      const step = authStep(result.json);
      if (step.pageType === 'mfa_challenge' || /mfa-challenge/i.test(step.continueUrl || location)) {
        state.authPayload = result.json;
        state.continueUrl = absoluteAuthUrl(step.continueUrl || location || nextUrl);
        state.pageType = 'mfa_challenge';
        state.step = 'mfa_required';
        await this.checkpoint(state, session, 'mfa_required', { factorType: mfaTotpFactor(result.json).type });
        return;
      }
      if (step.pageType === 'add_phone' || /(?:add-phone|phone-verification)/i.test(step.continueUrl || location)) {
        state.authPayload = result.json;
        state.continueUrl = absoluteAuthUrl(step.continueUrl || location || nextUrl);
        state.pageType = step.pageType || 'add_phone';
        state.step = 'phone_required';
        await this.checkpoint(state, session, 'phone_required');
        return;
      }
      if (step.pageType === 'workspace_select') {
        const workspaces = result.json?.['oai-client-auth-session']?.workspaces || step.payload.workspaces || [];
        const workspaceId = workspaces[0]?.id;
        if (!workspaceId) throw new Error('Workspace selection did not provide a workspace ID');
        const selected = await this.request(session, 'workspace_select', 'POST', `${AUTH_BASE}/api/accounts/workspace/select`, {
          origin: AUTH_BASE,
          referer: nextUrl,
          headers: { Accept: 'application/json' },
          json: { workspace_id: workspaceId },
        });
        nextUrl = absoluteAuthUrl(authStep(selected.json).continueUrl || selected.response.location);
        continue;
      }
      nextUrl = location || absoluteAuthUrl(step.continueUrl);
      if (!nextUrl) {
        const error = new Error('Authentication continuation ended before the ChatGPT callback');
        error.code = 'AUTH_CONTINUATION_MISSING';
        error.retryable = false;
        throw error;
      }
    }
    if (!callbackFollowed) {
      const error = new Error('Authentication continuation exceeded its step limit before the ChatGPT callback');
      error.code = 'AUTH_CONTINUATION_LIMIT';
      error.retryable = false;
      throw error;
    }
    state.step = 'auth_completed';
    await this.checkpoint(state, session, 'auth_completed', {
      callbackPath: '/api/auth/callback/openai',
    });
  }

  async verify(state, session, options = {}) {
    let result;
    try {
      result = await this.request(session, 'chatgpt_session', 'GET', `${CHATGPT_BASE}/api/auth/session?update=${Date.now()}`, {
        referer: `${CHATGPT_BASE}/`,
        headers: { Accept: 'application/json' },
      });
    } catch (error) {
      // Only route-not-available responses may use the document fallback. A
      // proxy or authentication failure must remain visible to the caller.
      if (![401, 404, 405].includes(Number(error.status || 0))) throw error;
      result = { json: {}, response: { status: Number(error.status || 0), text: '' } };
    }
    let payload = sessionPayload(result.json);
    let accessToken = String(payload.accessToken || payload.access_token || '').trim();
    if (!accessToken) {
      const home = await this.request(session, 'chatgpt_home_session_fallback', 'GET', `${CHATGPT_BASE}/`, {
        follow: true,
        referer: `${CHATGPT_BASE}/api/auth/session`,
        accept: 'text/html,application/xhtml+xml',
      });
      const embedded = sessionPayload(parseClientBootstrap(home.response?.text));
      if (embedded.accessToken || embedded.access_token) {
        payload = { ...payload, ...embedded };
        accessToken = String(payload.accessToken || payload.access_token || '').trim();
      }
    }
    if (!accessToken) {
      const error = new Error('ChatGPT NextAuth session did not return accessToken');
      error.code = 'SESSION_ACCESS_TOKEN_MISSING';
      error.authCallbackCompleted = Boolean(state.authCallbackUrl);
      error.authPageType = String(state.pageType || '');
      error.authStep = String(state.step || '');
      throw error;
    }
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      'oai-device-id': state.oaiDid,
    };
    const me = await this.request(session, 'chatgpt_me', 'GET', `${CHATGPT_BASE}/backend-api/me`, {
      origin: CHATGPT_BASE,
      referer: `${CHATGPT_BASE}/`,
      headers,
    });
    let usage = null;
    const previousUsage = state.usage;
    const previousPlanType = String(state.planType || '').trim().toLowerCase();
    if (options.skipUsageMetadata !== true) {
      try {
        usage = (await this.request(session, 'chatgpt_usage', 'GET', `${CHATGPT_BASE}/backend-api/wham/usage`, {
          origin: CHATGPT_BASE,
          referer: `${CHATGPT_BASE}/`,
          headers,
        })).json;
      } catch {
        // Usage is metadata only. A rate limit, gateway error, or transport
        // timeout must not invalidate an otherwise verified login state.
        usage = null;
      }
    }
    const claims = accountClaims(accessToken, payload);
    const verifiedEmails = [...new Set([
      claims.email,
      me.json.email,
      me.json.user?.email,
    ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean))];
    const accountIds = observedAccountIds(accessToken, payload, me.json);
    const identity = verifySessionIdentity(state, verifiedEmails, accountIds, this.options.confirmedEmailChange);
    state.session = payload;
    state.accessToken = accessToken;
    state.sessionToken = sessionCookie(session.cookieJar);
    state.accountId = identity.accountId;
    const observedPlanType = String(
      usage?.plan_type
      || usage?.planType
      || usage?.account?.plan_type
      || claims.planType
      || '',
    ).trim().toLowerCase();
    state.planType = (observedPlanType && observedPlanType !== 'unknown')
      ? observedPlanType
      : (previousPlanType || 'unknown');
    state.me = me.json;
    state.usage = usage && Object.keys(usage).length ? usage : (previousUsage || null);
    state.status = 'valid';
    state.step = 'verified';
    state.lastValidatedAt = new Date().toISOString();
    await this.checkpoint(state, session, 'session_verified', {
      accountId: state.accountId, planType: state.planType,
      ...(identity.reconciled ? { rebindIdentityReconciled: true } : {}),
    });
    return state;
  }

  /**
   * A rejected code on a sequential mailbox is often a stale one queued ahead
   * of the code this send produced. Before paying for a whole new auth
   * transaction (and its rate limit), read the next queued code once and try
   * it on the same verification page. Returns true when it validated.
   *
   * Only providers that report `sequentialCodes` answer this read; the rest
   * return nothing and the caller falls back to the full restart.
   */
  async retryNextQueuedEmailCode(state, session, error) {
    if (!isWrongEmailOtpError(error) || typeof this.options.getEmailCode !== 'function') return false;
    const sendMarker = String(state.emailOtpSentAt || state.emailBoundary?.capturedAt || 'unknown');
    if (state.emailOtpQueuedRetryFor === sendMarker) return false;
    state.emailOtpQueuedRetryFor = sendMarker;
    let next = null;
    try {
      next = await this.options.getEmailCode(state.email, state.emailBoundary, state, {
        nextQueuedCode: true,
        timeoutMs: QUEUED_EMAIL_CODE_RETRY_TIMEOUT_MS,
        reportDelivery: false,
      });
    } catch (waitError) {
      // A stop request is not "no queued code"; let it unwind the run.
      if (String(waitError?.code || '') === 'TASK_INTERRUPTED') throw waitError;
      return false;
    }
    const code = normalizeEmailOtp(typeof next === 'string' ? next : next?.code);
    if (!code || code === String(error?.submittedEmailOtp || '')) return false;
    await this.checkpoint(state, session, 'email_otp_queued_code_retry', {
      code: String(error?.code || 'WRONG_EMAIL_OTP_CODE'),
    });
    try {
      await this.validateEmailOtp(state, session, next);
      return true;
    } catch (retryError) {
      if (!isWrongEmailOtpError(retryError)) throw retryError;
      return false;
    }
  }

  async restartAfterWrongEmailOtp(state, session, options = {}, error) {
    const attempts = Number(state.emailOtpValidationRetries || 0) + 1;
    state.emailOtpValidationRetries = attempts;
    state.emailOtpSendRecovery = null;
    state.emailBoundary = null;
    state.emailOtpSentAt = '';
    state.emailOtpSentAtSource = '';
    state.emailOtpSendStartedAt = '';
    state.createAccountAttempt = null;
    resetAuthorizationTransaction(state, session);
    this.clearNextAuthContext(session);
    await this.checkpoint(state, session, 'email_otp_validation_retry_started', {
      attempt: attempts,
      code: String(error?.code || 'WRONG_EMAIL_OTP_CODE'),
    });
    await this.bootstrap(state, session, {
      existingOnly: options.existingOnly === true,
      forceFreshEmailBoundary: true,
    });
    if (state.step === 'nextauth_ready') {
      await this.submitIdentityWithRecovery(state, session, { existingOnly: options.existingOnly === true });
    }
    if (state.step === 'identity_submitted') {
      await this.sendEmailOtp(state, session, {
        ...options,
        forceFreshEmailBoundary: true,
      });
    }
  }

  async beginPasswordSetup(state, session) {
    const requestOptions = this.securityRequestOptions();
    const [emailBoundary, csrfToken] = await Promise.all([
      this.snapshotEmail(state, { fresh: true, purpose: 'password_setup', preSend: true }),
      this.nextAuthContext(session, requestOptions),
    ]);
    await this.openAiSignIn(state, session, csrfToken, {
      prompt: 'login',
      'ext-oai-did': state.oaiDid,
      auth_session_logging_id: crypto.randomUUID(),
      screen_hint: 'login_or_signup',
      login_hint: state.email,
    }, 'password_add_session', requestOptions);
    const authorization = await this.openAiSignIn(state, session, csrfToken, {
      connection: 'password',
      'ext-oai-did': state.oaiDid,
      login_hint: state.email,
      max_age: '0',
      post_login_add_password: 'true',
      reauth: 'password',
    }, 'password_add_authorize', requestOptions);
    const landedUrl = authorization.landedUrl || authorization.authorizeUrl;
    const landedPath = new URL(landedUrl, AUTH_BASE).pathname;
    const resetExisting = /\/log-in\/password\/?$/i.test(landedPath);
    if (resetExisting) {
      await this.securityRequest(session, 'password_reset_send_otp', 'POST', `${AUTH_BASE}/api/accounts/password/send-otp`, {
        origin: AUTH_BASE,
        referer: `${AUTH_BASE}/log-in/password`,
        headers: { Accept: 'application/json' },
        statuses: [200, 201, 204],
      });
    } else if (!/\/(email-verification|reset-password)(?:\/|$)/i.test(landedPath)) {
      const error = new Error(`Password setup reached an unsupported authorization page: ${landedPath}`);
      error.code = 'PASSWORD_ADD_UNEXPECTED_AUTH_STEP';
      throw error;
    }
    state.security.passwordTransaction = {
      step: 'otp_sent',
      resetExisting,
      emailBoundary: emailBoundary || null,
      authorizeUrl: authorization.authorizeUrl,
      landedUrl,
      password: randomPassword(),
      startedAt: new Date().toISOString(),
    };
    state.security.passwordStatus = 'waiting_otp';
    await this.checkpoint(state, session, 'password_otp_sent', { resetExisting });
  }

  async completePasswordSetup(state, session) {
    const transaction = state.security.passwordTransaction;
    if (!transaction || transaction.step === 'complete') return;
    if (transaction.step === 'confirmation_mfa_required') {
      throw passwordConfirmationMfaError(transaction);
    }
    if (transaction.step === 'otp_sent') {
      const code = await this.waitEmailCode(state, transaction.emailBoundary);
      const validationStarted = Date.now();
      await this.securityCheckpoint(state, session, 'password_otp_validation_started', {
        resetExisting: transaction.resetExisting,
      });
      try {
        const sentinel = await this.sentinelHeaders(state, session, 'email_otp_validate', {
          operationTimeoutMs: this.securityTimeoutMs() || undefined,
        });
        const validated = await this.securityRequest(session, 'password_otp_validate', 'POST', `${AUTH_BASE}/api/accounts/email-otp/validate`, {
          origin: AUTH_BASE,
          referer: `${AUTH_BASE}/email-verification`,
          headers: { Accept: 'application/json', ...sentinel },
          json: { code },
          statuses: [200],
        });
        const step = authStep(validated.json);
        const continueUrl = absoluteAuthUrl(step.continueUrl);
        if (!continueUrl || !/\/reset-password\/new-password\/?$/i.test(new URL(continueUrl).pathname)) {
          const error = new Error(`Password OTP reached an unsupported authorization page: ${step.continueUrl || 'missing continue URL'}`);
          error.code = 'PASSWORD_ADD_UNEXPECTED_OTP_STEP';
          throw error;
        }
        await this.securityRequest(session, 'password_new_page', 'GET', continueUrl, {
          follow: true,
          referer: `${AUTH_BASE}/email-verification`,
          accept: 'text/html,application/xhtml+xml',
        });
        transaction.step = 'otp_validated';
        transaction.continueUrl = continueUrl;
        await this.checkpoint(state, session, 'password_otp_validated', { resetExisting: transaction.resetExisting });
      } catch (error) {
        await this.trySecurityCheckpoint(state, session, 'password_otp_validation_failed', {
          ...securityErrorDetails(error),
          durationMs: Date.now() - validationStarted,
        });
        throw error;
      }
    }
    if (transaction.step === 'otp_validated') {
      const password = String(transaction.password || randomPassword());
      const endpoint = transaction.resetExisting ? 'reset' : 'add';
      const sentinel = await this.sentinelHeaders(state, session, 'password_reset', {
        operationTimeoutMs: this.securityTimeoutMs() || undefined,
      });
      const result = await this.securityRequest(session, `password_${endpoint}`, 'POST', `${AUTH_BASE}/api/accounts/password/${endpoint}`, {
        origin: AUTH_BASE,
        referer: `${AUTH_BASE}/reset-password/new-password`,
        headers: { Accept: 'application/json', ...sentinel },
        json: { password },
        statuses: [200],
      });
      if (result.json.error) {
        const error = requestError(`password_${endpoint}`, result);
        error.code = String(result.json.error?.code || 'PASSWORD_ADD_REJECTED').toUpperCase();
        throw error;
      }
      state.password = password;
      transaction.step = 'password_submitted';
      transaction.nextUrl = absoluteAuthUrl(authStep(result.json).continueUrl || result.response.location);
      await this.checkpoint(state, session, 'password_submitted', { resetExisting: transaction.resetExisting });
    }
    if (transaction.step !== 'password_submitted') return;

    if (transaction.nextUrl) {
      const nextPath = new URL(transaction.nextUrl).pathname;
      if (/\/mfa-challenge(?:\/|$)/i.test(nextPath)) {
        // The password mutation returned HTTP 200. The MFA continuation is
        // for completing the re-authentication redirect, which is not needed
        // to retain the already verified ChatGPT session. Record that side
        // branch as an informational completion instead of replaying OTP.
        transaction.step = 'complete';
        transaction.confirmationMfaRequired = true;
        transaction.confirmationMfaPath = nextPath;
        transaction.completedAt = new Date().toISOString();
        state.security.passwordStatus = 'configured';
        state.security.setPassword = true;
        await this.checkpoint(state, session, 'password_configured', {
          resetExisting: transaction.resetExisting,
          confirmationMfaRequired: true,
        });
        return;
      }
      await this.securityRequest(session, 'password_callback', 'GET', transaction.nextUrl, {
        follow: true,
        referer: `${AUTH_BASE}/reset-password/new-password`,
        accept: 'text/html,application/xhtml+xml',
      });
    }
    state.security.passwordStatus = 'configured';
    state.security.setPassword = true;
    state.security.passwordTransaction = {
      step: 'complete',
      resetExisting: transaction.resetExisting,
      ...(transaction.confirmationMfaRequired ? {
        confirmationMfaRequired: true,
        confirmationMfaPath: transaction.confirmationMfaPath,
      } : {}),
      completedAt: new Date().toISOString(),
    };
    await this.checkpoint(state, session, 'password_configured', { resetExisting: transaction.resetExisting });
  }

  async refreshAccessToken(state, session) {
    const result = await this.securityRequest(session, 'chatgpt_session_refresh', 'GET', `${CHATGPT_BASE}/api/auth/session?update=${Date.now()}`, {
      referer: `${CHATGPT_BASE}/`,
      headers: { Accept: 'application/json' },
    });
    const accessToken = String(result.json.accessToken || result.json.access_token || '').trim();
    if (!accessToken) {
      const error = new Error('ChatGPT NextAuth session refresh did not return accessToken');
      error.code = 'SESSION_ACCESS_TOKEN_MISSING';
      throw error;
    }
    state.session = result.json;
    state.accessToken = accessToken;
    state.sessionToken = sessionCookie(session.cookieJar);
    state.security.passwordTransaction.accessTokenRefreshedAt = new Date().toISOString();
    await this.checkpoint(state, session, 'session_refreshed_after_password');
  }

  async securityReauthenticateWithEmailOtp(state, session, reauthState, landedUrl = '', options = {}) {
    const current = state.security?.securityReauth || {};
    const previous = current.emailOtp && typeof current.emailOtp === 'object'
      ? current.emailOtp
      : {};
    const suppliedBoundary = options.boundary || reauthState.emailBoundary || previous.boundary || null;
    const continuation = absoluteAuthUrl(landedUrl || previous.continueUrl || reauthState.continueUrl);
    if (!continuation) {
      const error = new Error('Security email re-authentication did not return an email verification URL');
      error.code = 'SECURITY_REAUTH_EMAIL_URL_MISSING';
      error.retryable = false;
      throw error;
    }

    let boundary = suppliedBoundary;
    if (!boundary) {
      // Post-send fallback: the verification page already exists, so this
      // snapshot must not discard queued codes (no preSend).
      boundary = await this.snapshotEmail(reauthState, {
        fresh: true,
        purpose: 'security_reauth',
      });
    }
    reauthState.emailBoundary = boundary || null;
    reauthState.continueUrl = continuation;
    reauthState.pageType = 'email_verification';
    reauthState.step = 'email_otp_sent';

    const alreadyValidated = previous.status === 'validated';
    const resumed = options.resume === true;
    const expiresAt = String(previous.expiresAt || new Date(Date.now() + SECURITY_REAUTH_TTL_MS).toISOString());
    const sentAt = String(options.sentAt || boundary?.sentAt || previous.sentAt || new Date().toISOString());
    const waiting = {
      ...previous,
      status: alreadyValidated ? 'validated' : 'waiting',
      method: 'email_otp',
      boundary: boundary || null,
      continueUrl: continuation,
      sentAt,
      expiresAt,
      lastError: null,
    };
    state.security.securityReauth = {
      ...current,
      method: 'email_otp',
      emailOtp: waiting,
    };
    if (!alreadyValidated && !resumed) {
      await this.securityCheckpoint(state, session, 'security_reauth_email_otp_sent', {
        method: 'email_otp',
      });
    } else if (resumed) {
      await this.securityCheckpoint(state, session, 'security_reauth_email_otp_resumed', {
        method: 'email_otp',
      });
    }

    if (!alreadyValidated) {
      const code = await this.waitEmailCode(reauthState, boundary);
      await this.securityCheckpoint(state, session, 'security_reauth_email_otp_received', {
        method: 'email_otp',
      });
      const validated = await this.securityRequest(
        session,
        'security_reauth_email_otp_validate',
        'POST',
        `${AUTH_BASE}/api/accounts/email-otp/validate`,
        {
          origin: AUTH_BASE,
          referer: `${AUTH_BASE}/email-verification`,
          headers: { Accept: 'application/json' },
          json: { code },
          statuses: [200],
        },
      );
      const step = authStep(validated.json);
      const nextUrl = absoluteAuthUrl(step.continueUrl || validated.response?.location);
      if (!nextUrl) {
        const error = new Error('Security email re-authentication did not return a continuation URL');
        error.code = 'SECURITY_REAUTH_EMAIL_CONTINUATION_MISSING';
        error.retryable = false;
        throw error;
      }
      if (isEmailVerificationUrl(nextUrl)) {
        const error = new Error('Security email re-authentication returned another email verification step');
        error.code = 'SECURITY_REAUTH_EMAIL_OTP_LOOP';
        error.retryable = true;
        throw error;
      }
      reauthState.authPayload = validated.json;
      reauthState.continueUrl = nextUrl;
      reauthState.pageType = step.pageType;
      reauthState.step = 'email_otp_validated';
      state.security.securityReauth = {
        ...(state.security.securityReauth || {}),
        emailOtp: {
          ...waiting,
          status: 'validated',
          continueUrl: nextUrl,
          validatedAt: new Date().toISOString(),
          lastError: null,
        },
      };
      await this.securityCheckpoint(state, session, 'security_reauth_email_otp_validated', {
        method: 'email_otp',
      });
    } else {
      reauthState.continueUrl = continuation;
      reauthState.step = 'email_otp_validated';
    }
    return reauthState.continueUrl;
  }

  async securityVerifyPassword(state, session, reauthState) {
    const password = String(reauthState.password || '').trim();
    const sentinel = await this.sentinelHeaders(reauthState, session, 'password_verify', {
      operationTimeoutMs: this.securityTimeoutMs() || undefined,
    });
    let verified;
    try {
      verified = await this.securityRequest(
        session,
        'security_reauth_password_verify',
        'POST',
        `${AUTH_BASE}/api/accounts/password/verify`,
        {
          origin: AUTH_BASE,
          referer: `${AUTH_BASE}/log-in/password`,
          headers: { Accept: 'application/json', ...sentinel },
          json: { password },
          statuses: [200],
        },
      );
    } catch (error) {
      if (String(error.code || '').toUpperCase() === 'ACCOUNT_DEACTIVATED') throw error;
      const status = Number(error.status || 0);
      if (![400, 401, 403].includes(status)) throw error;
      await this.trySecurityCheckpoint(state, session, 'security_reauth_password_rejected', {
        status,
        code: String(error.code || 'INVALID_PASSWORD'),
      });
      return false;
    }

    const step = authStep(verified.json);
    reauthState.authPayload = verified.json;
    reauthState.continueUrl = absoluteAuthUrl(step.continueUrl || verified.response?.location);
    reauthState.pageType = step.pageType;
    if (!reauthState.continueUrl) {
      const error = new Error('Security password re-authentication did not return a continuation URL');
      error.code = 'SECURITY_REAUTH_CONTINUATION_MISSING';
      throw error;
    }
    return true;
  }

  async securitySendEmailOtpFallback(state, session, reauthState, boundary, boundaryError) {
    if (boundaryError) throw boundaryError;
    const continuation = `${AUTH_BASE}/email-verification`;
    reauthState.emailBoundary = reauthState.emailBoundary || boundary || null;
    await this.sendEmailOtpRequest(reauthState, () => this.securityRequest(
      session,
      'security_reauth_email_otp_send',
      'POST',
      `${AUTH_BASE}/api/accounts/passwordless/send-otp`,
      {
        origin: AUTH_BASE,
        referer: `${AUTH_BASE}/log-in/password`,
        headers: { Accept: 'application/json' },
        json: {},
        statuses: [200, 201, 204],
      },
    ));
    await this.securityReauthenticateWithEmailOtp(state, session, reauthState, continuation, {
      boundary: reauthState.emailBoundary,
      sentAt: reauthState.emailOtpSentAt,
    });
  }

  async securityReauthenticateFromEmailPage(state, session, reauthState, landedUrl, boundary, boundaryError) {
    const password = String(reauthState.password || '').trim();
    if (!password) {
      if (boundaryError) throw boundaryError;
      await this.securityReauthenticateWithEmailOtp(state, session, reauthState, landedUrl, { boundary });
      return;
    }

    const passwordUrl = `${AUTH_BASE}/log-in/password`;
    let passwordPageAvailable = true;
    try {
      await this.request(session, 'security_reauth_password_page', 'GET', passwordUrl, {
        follow: true,
        referer: `${AUTH_BASE}/email-verification`,
        accept: 'text/html,application/xhtml+xml',
        statuses: [200, 302],
      });
    } catch (error) {
      if (![400, 401, 403].includes(Number(error.status || 0))) throw error;
      passwordPageAvailable = false;
      await this.trySecurityCheckpoint(state, session, 'security_reauth_password_page_unavailable', {
        status: Number(error.status || 0),
        code: String(error.code || 'SECURITY_REAUTH_PASSWORD_PAGE_FAILED'),
      });
    }

    if (passwordPageAvailable) {
      reauthState.pageType = 'login_password';
      reauthState.continueUrl = passwordUrl;
      const accepted = await this.securityVerifyPassword(state, session, reauthState);
      if (accepted) {
        if (isEmailVerificationUrl(reauthState.continueUrl)) {
          if (boundaryError) throw boundaryError;
          await this.securityReauthenticateWithEmailOtp(state, session, reauthState, reauthState.continueUrl, {
            boundary,
          });
        }
        return;
      }
    }

    await this.securitySendEmailOtpFallback(state, session, reauthState, boundary, boundaryError);
  }

  // Re-authenticate the account for a sensitive security mutation.  The
  // preferred route verifies the saved password, but OpenAI may legitimately
  // step the same transaction up to email OTP.  Neither route mutates the
  // password or replays the password-setup transaction.
  async securityReauthenticate(state, session) {
    const password = String(state.password || '').trim();

    state.security = state.security || {};
    const previous = state.security.securityReauth || {};
    const attempt = Math.max(0, Number(previous.attempts || 0)) + 1;
    const startedAt = new Date().toISOString();
    const proxyFingerprint = securityReauthProxyFingerprint(this.options.proxy);
    state.security.securityReauth = {
      ...previous,
      status: 'in_progress',
      attempts: attempt,
      startedAt,
      completedAt: '',
      expiresAt: '',
      proxyFingerprint,
      clientProfileFingerprint: String(state.clientProfileFingerprint || ''),
      lastError: null,
    };
    await this.securityCheckpoint(state, session, 'security_reauth_started', { attempt });

    const reauthState = makeInitialChatGptSessionState({
      email: state.email,
      cookieJar: state.cookieJar,
      clientProfile: state.clientProfile,
      oaiDid: state.oaiDid,
      password,
      totpSecret: state.totpSecret,
    });
    Object.assign(reauthState, {
      step: 'security_reauth',
      status: 'running',
      accountId: state.accountId || '',
      planType: state.planType || 'unknown',
      usage: state.usage || null,
      accessToken: state.accessToken || '',
      sessionToken: state.sessionToken || '',
      session: state.session || null,
      me: state.me || null,
    });
    reauthState.security = {
      setPassword: false,
      enrollTotp: false,
      passwordStatus: 'configured',
      totpStatus: reauthState.totpSecret ? 'configured' : 'not_requested',
    };

    // The normal runner checkpoint targets the job's primary session state.
    // Route transient re-auth checkpoints to the parent state while keeping
    // the temporary auth navigation out of the registration/login branch.
    const originalCheckpoint = this.options.checkpoint;
    const originalOnEvent = this.options.onEvent;
    this.options.onEvent = null;
    this.options.checkpoint = async (reason, current) => {
      state.cookieJar = current.cookieJar;
      state.security.securityReauth = {
        ...(state.security.securityReauth || {}),
        step: String(reason || ''),
      };
      if (typeof originalCheckpoint === 'function') {
        await originalCheckpoint(`security_reauth:${reason}`, state);
      }
    };

    let failure = null;
    try {
      const requestOptions = this.securityRequestOptions();
      const previousEmailOtp = previous.emailOtp && typeof previous.emailOtp === 'object'
        ? previous.emailOtp
        : {};
      const resumeEmailOtp = securityReauthEmailTransactionUsable(previousEmailOtp);
      if (resumeEmailOtp) {
        reauthState.emailBoundary = previousEmailOtp.boundary || null;
        reauthState.continueUrl = previousEmailOtp.continueUrl;
        reauthState.pageType = 'email_verification';
        reauthState.step = previousEmailOtp.status === 'validated'
          ? 'email_otp_validated'
          : 'email_otp_sent';
        await this.securityReauthenticateWithEmailOtp(state, session, reauthState, '', {
          boundary: reauthState.emailBoundary,
          resume: true,
        });
      } else {
        // Do not let an expired/invalidated transaction from an older attempt
        // be mistaken for a validated continuation when the new authorize
        // request takes the email branch again.
        state.security.securityReauth = {
          ...(state.security.securityReauth || {}),
          emailOtp: {},
        };
        // The authorize request itself can issue the email OTP. Capture the
        // mailbox boundary before it so the first poll cannot consume an old
        // registration/security message. A missing or temporarily unavailable
        // mailbox must not block the preferred saved-password path, though: the
        // error is held until the server actually selects the email branch.
        const [csrfToken, boundaryResult] = await Promise.all([
          this.nextAuthContext(session, requestOptions),
          this.snapshotEmail(reauthState, {
            fresh: true,
            purpose: 'security_reauth',
            preSend: true,
          }).then((boundary) => ({ boundary }))
            .catch((error) => ({ error })),
        ]);
        const emailBoundary = boundaryResult.boundary || null;
        const emailBoundaryError = boundaryResult.error || null;
        if (emailBoundaryError) {
          await this.trySecurityCheckpoint(state, session, 'security_reauth_email_boundary_unavailable', {
            code: String(emailBoundaryError.code || 'SECURITY_REAUTH_EMAIL_BOUNDARY_FAILED'),
            status: Number(emailBoundaryError.status || 0),
            message: String(emailBoundaryError.message || 'Security re-authentication email boundary unavailable'),
          });
        }
        reauthState.emailBoundary = emailBoundary;
        if (emailBoundary) {
          state.security.securityReauth = {
            ...(state.security.securityReauth || {}),
            emailOtp: {
              ...(resumeEmailOtp ? previousEmailOtp : {}),
              boundary: emailBoundary,
              expiresAt: new Date(Date.now() + SECURITY_REAUTH_TTL_MS).toISOString(),
            },
          };
          await this.securityCheckpoint(state, session, 'security_reauth_email_boundary_captured', {
            method: 'pending',
          });
        }
        /*
         * Keep the boundary captured above for a possible email branch. Do not
         * throw its error yet: the next request may land on the password page,
         * in which case no mailbox is needed at all.
         */
        const authorization = await this.openAiSignIn(reauthState, session, csrfToken, {
            prompt: 'login',
            'ext-oai-did': reauthState.oaiDid,
            auth_session_logging_id: crypto.randomUUID(),
            screen_hint: 'login_or_signup',
            login_hint: reauthState.email,
            connection: 'password',
            max_age: '0',
            reauth: 'password',
        }, 'security_reauth', requestOptions);

          const landedUrl = absoluteAuthUrl(authorization.landedUrl || authorization.authorizeUrl);
          if (!landedUrl) {
            const error = new Error('Security re-authentication did not return an authorization landing URL');
            error.code = 'SECURITY_REAUTH_LANDING_URL_MISSING';
            error.retryable = false;
            throw error;
          }
          const landedPath = authPath(landedUrl);
          if (/\/authorize(?:\/|$)/i.test(landedPath)) {
            const error = new Error(`Security re-authentication stopped on the authorize page: ${landedPath}`);
            error.code = 'SECURITY_REAUTH_AUTHORIZATION_INCOMPLETE';
            error.retryable = false;
            throw error;
          }
          if (/\/log-in\/password\/?$/i.test(landedPath)) {
            if (!password) {
              const error = new Error('Security re-authentication reached the password page but no saved password is available');
              error.code = 'SECURITY_REAUTH_PASSWORD_MISSING';
              error.retryable = false;
              throw error;
            }
            const accepted = await this.securityVerifyPassword(state, session, reauthState);
            if (!accepted) {
              await this.securitySendEmailOtpFallback(state, session, reauthState, emailBoundary, emailBoundaryError);
            } else if (isEmailVerificationUrl(reauthState.continueUrl)) {
              if (emailBoundaryError) throw emailBoundaryError;
              await this.securityReauthenticateWithEmailOtp(state, session, reauthState, reauthState.continueUrl, {
                boundary: emailBoundary,
              });
            }
          } else if (isEmailVerificationUrl(landedUrl)) {
            await this.securityReauthenticateFromEmailPage(
              state,
              session,
              reauthState,
              landedUrl,
              emailBoundary,
              emailBoundaryError,
            );
          } else {
            reauthState.continueUrl = landedUrl;
          }
      }

      await this.followContinuation(reauthState, session);
      if (reauthState.step === 'mfa_required') {
        if (!reauthState.totpSecret) {
          const error = new Error('Security re-authentication requires an existing MFA factor');
          error.code = 'SECURITY_REAUTH_MFA_REQUIRED';
          error.retryable = false;
          throw error;
        }
        await this.completeMfa(reauthState, session);
      }
      if (reauthState.step === 'auth_completed') {
        await this.verify(reauthState, session, { skipUsageMetadata: true });
      }
      if (reauthState.step !== 'verified' || !reauthState.accessToken) {
        const error = new Error('Security re-authentication did not produce a verified session');
        error.code = 'SECURITY_REAUTH_NOT_VERIFIED';
        error.retryable = false;
        throw error;
      }

      state.cookieJar = reauthState.cookieJar;
      state.accessToken = reauthState.accessToken;
      state.sessionToken = reauthState.sessionToken;
      state.session = reauthState.session;
      state.me = reauthState.me;
      state.accountId = reauthState.accountId || state.accountId;
      state.planType = reauthState.planType || state.planType;
      state.usage = reauthState.usage || state.usage || null;
      state.lastValidatedAt = reauthState.lastValidatedAt || state.lastValidatedAt;
      state.step = 'verified';
    } catch (error) {
      failure = error;
    } finally {
      state.cookieJar = session.serializeCookies();
      this.options.checkpoint = originalCheckpoint;
      this.options.onEvent = originalOnEvent;
    }

    if (failure) {
      const details = securityErrorDetails(failure);
      state.security.securityReauth = {
        ...(state.security.securityReauth || {}),
        status: 'failed',
        failedAt: new Date().toISOString(),
        lastError: details,
      };
      await this.trySecurityCheckpoint(state, session, 'security_reauth_failed', {
        ...details,
        message: `安全重认证失败：${details.message}`,
      });
      throw failure;
    }

    const completedAt = new Date().toISOString();
    state.security.securityReauth = {
      ...(state.security.securityReauth || {}),
      status: 'complete',
      completedAt,
      expiresAt: new Date(Date.now() + SECURITY_REAUTH_TTL_MS).toISOString(),
      proxyFingerprint,
      clientProfileFingerprint: String(state.clientProfileFingerprint || ''),
      accessTokenFingerprint: crypto.createHash('sha256').update(String(state.accessToken || '')).digest('hex').slice(0, 16),
      lastError: null,
    };
    await this.securityCheckpoint(state, session, 'security_reauth_completed', { attempt });
    return state;
  }

  async configurePassword(state, session) {
    if (state.security.passwordTransaction?.step === 'retry_pending') {
      state.security.passwordTransaction = null;
      state.security.passwordStatus = 'not_started';
      await this.securityCheckpoint(state, session, 'password_setup_retry_started', {
        reason: 'previous_security_attempt_failed',
      });
    }
    if (state.password && !state.security.passwordTransaction) {
      state.security.passwordStatus = 'configured';
      state.security.setPassword = true;
      return;
    }
    if (state.security.passwordTransaction?.step === 'complete') {
      state.security.passwordStatus = 'configured';
      state.security.setPassword = true;
      return;
    }
    if (!state.security.passwordTransaction) {
      await this.beginPasswordSetup(state, session);
    }
    await this.completePasswordSetup(state, session);
  }

  async enrollTotp(state, session, options = {}) {
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${state.accessToken}`,
      'oai-device-id': state.oaiDid,
    };
    const requestContext = {
      referer: `${CHATGPT_BASE}/`,
      headers,
    };
    if (options.skipPreflight !== true) {
      const info = await this.securityRequest(session, 'mfa_info', 'GET', `${CHATGPT_BASE}/backend-api/accounts/mfa_info`, requestContext);
      if (info.json.mfa_enabled === true) throw Object.assign(new Error('MFA is already enabled without a recoverable TOTP secret'), { code: 'MFA_ALREADY_ENABLED' });
      const security = await this.securityRequest(session, 'security_settings', 'GET', `${CHATGPT_BASE}/backend-api/accounts/security_settings/info`, requestContext);
      if (security.json.aas_eligible === false) throw Object.assign(new Error('Account is not eligible for TOTP enrollment'), { code: 'MFA_NOT_ELIGIBLE' });
    }
    const enrolled = await this.securityRequest(session, 'mfa_enroll', 'POST', `${CHATGPT_BASE}/backend-api/accounts/mfa/enroll`, {
      origin: CHATGPT_BASE,
      referer: `${CHATGPT_BASE}/`,
      headers,
      json: { factor_type: 'totp' },
    });
    const secret = String(enrolled.json.secret || '').trim();
    const sessionId = String(enrolled.json.session_id || '').trim();
    const factorId = String(enrolled.json.factor?.id || '').trim();
    if (!secret || !sessionId || !factorId) throw new Error('TOTP enrollment returned incomplete data');
    const activated = await this.securityRequest(session, 'mfa_activate', 'POST', `${CHATGPT_BASE}/backend-api/accounts/mfa/user/activate_enrollment`, {
      origin: CHATGPT_BASE,
      referer: `${CHATGPT_BASE}/`,
      headers,
      json: { code: totpCode(secret), factor_type: 'totp', session_id: sessionId },
    });
    if (activated.json.success !== true) throw new Error(`TOTP activation was rejected: ${activated.json.error || 'unknown'}`);
    state.totpSecret = secret;
    state.security.enrollTotp = true;
    state.security.totpStatus = 'configured';
    await this.checkpoint(state, session, 'totp_configured', { factorId });
  }

  async configureSecurity(state, session, security = {}) {
    state.security = state.security || {};
    const passwordRequested = security.setPassword === true;
    const totpRequested = security.enrollTotp === true;
    state.security.setPassword = state.security.setPassword === true || passwordRequested || Boolean(state.password);
    state.security.enrollTotp = state.security.enrollTotp === true || totpRequested || Boolean(state.totpSecret);
    // A pure login-state refresh must not rewrite historical security
    // failures or turn a partial asset into a successful security run.
    if (!passwordRequested && !totpRequested) return [];
    const failures = [];
    let deferTotpForPasswordFailure = false;
    if (passwordRequested && state.security.passwordStatus !== 'configured') {
      const started = Date.now();
      await this.securityCheckpoint(state, session, 'password_setup_started', {
        resumed: state.security.passwordTransaction?.step === 'retry_pending',
      });
      try {
        await this.configurePassword(state, session);
      } catch (error) {
        const retryable = retryableSecurityError(error);
        const confirmationMfaRequired = error.code === 'PASSWORD_CONFIRMATION_MFA_REQUIRED';
        // TOTP depends on the same verified security context.  A proxy-bound
        // Sentinel identity failure is recoverable only after that context is
        // rebuilt, so do not start a second security mutation in the same run.
        deferTotpForPasswordFailure = retryable || confirmationMfaRequired;
        state.security.passwordStatus = confirmationMfaRequired
          ? 'confirmation_mfa_required'
          : (retryable ? 'retry_pending' : 'failed');
        if (retryable) {
          const previous = state.security.passwordTransaction || {};
          state.security.passwordTransaction = {
            ...previous,
            step: 'retry_pending',
            failedAt: new Date().toISOString(),
            lastError: securityErrorDetails(error),
          };
        }
        failures.push({ feature: 'password', code: error.code || 'PASSWORD_SETUP_FAILED', message: error.message });
        await this.trySecurityCheckpoint(state, session, 'password_setup_failed', {
          ...securityErrorDetails(error),
          durationMs: Date.now() - started,
        });
      }
    }
    if (totpRequested && state.security.totpStatus !== 'configured') {
      if (state.totpSecret) {
        state.security.totpStatus = 'configured';
      } else if (deferTotpForPasswordFailure) {
        state.security.totpStatus = 'retry_pending';
        failures.push({
          feature: 'totp',
          code: 'TOTP_SETUP_DEFERRED',
          message: state.security.passwordStatus === 'confirmation_mfa_required'
            ? 'TOTP setup was deferred until password confirmation MFA is resolved'
            : 'TOTP setup was deferred after the password security transport failed',
        });
        await this.securityCheckpoint(state, session, 'totp_setup_deferred', {
          reason: state.security.passwordStatus === 'confirmation_mfa_required'
            ? 'password_confirmation_mfa_required'
            : 'password_security_transport_failed',
        });
      } else {
        const started = Date.now();
        await this.securityCheckpoint(state, session, 'totp_setup_started');
        let securityReauthAttempted = false;
        try {
          const passwordTransaction = state.security.passwordTransaction;
          if (passwordTransaction?.step === 'complete' && !passwordTransaction.accessTokenRefreshedAt) {
            await this.refreshAccessToken(state, session);
          }
          const reauth = state.security.securityReauth || {};
          if (['required', 'in_progress', 'retry_pending', 'failed'].includes(String(reauth.status || ''))
            && !securityReauthIsUsable(state, this.options.proxy)) {
            securityReauthAttempted = true;
            await this.securityReauthenticate(state, session);
          }
          try {
            await this.enrollTotp(state, session);
          } catch (error) {
            // The MFA endpoint is the authority on whether a recent
            // security re-authentication is required.  Recover that exact
            // condition once, then retry only the enrollment mutation.
            if (!securityReauthRequired(error) || securityReauthAttempted) throw error;
            state.security.securityReauth = {
              ...(state.security.securityReauth || {}),
              status: 'required',
              reason: 'MFA_ENROLL_REAUTH_REQUIRED',
              requiredAt: new Date().toISOString(),
              lastError: {
                ...securityErrorDetails(error),
                code: 'SECURITY_REAUTH_REQUIRED',
                message: 'TOTP 设置需要一次安全重认证',
              },
            };
            await this.trySecurityCheckpoint(state, session, 'security_reauth_required', {
              code: 'SECURITY_REAUTH_REQUIRED',
              causeCode: String(error.code || 'MFA_ENROLL_FAILED'),
            });
            securityReauthAttempted = true;
            await this.securityReauthenticate(state, session);
            await this.enrollTotp(state, session, { skipPreflight: true });
          }
        } catch (error) {
          state.security.totpStatus = retryableSecurityError(error) ? 'retry_pending' : 'failed';
          failures.push({ feature: 'totp', code: error.code || 'TOTP_SETUP_FAILED', message: error.message });
          const details = securityErrorDetails(error);
          await this.trySecurityCheckpoint(state, session, 'totp_setup_failed', {
            ...details,
            message: `TOTP 设置失败：${details.message}`,
            durationMs: Date.now() - started,
          });
        }
      }
    }
    state.security.failures = failures;
    return failures;
  }

  async run(state, options = {}) {
    const session = this.session(state);
    const security = options.security || {};
    const requestedSecurity = securityWorkRequested(security);
    const verifyOptions = { skipUsageMetadata: options.skipUsageMetadata === true };
    if (state.step === 'verified' && state.accessToken && options.skipVerifiedSessionRefresh !== true) {
      await this.verify(state, session, verifyOptions);
    }
    if (state.step === 'auth_callback_pending') {
      try {
        await this.verify(state, session, verifyOptions);
        state.pendingAuthCallbackUrl = '';
        await this.checkpoint(state, session, 'auth_callback_reconciled', {
          callbackPath: '/api/auth/callback/openai',
        });
      } catch (error) {
        if (error.code !== 'SESSION_ACCESS_TOKEN_MISSING') throw error;
        state.continueUrl = state.pendingAuthCallbackUrl || state.continueUrl;
        await this.followContinuation(state, session);
      }
    }
    if (state.step === 'initial') {
      await this.bootstrap(state, session, {
        existingOnly: options.existingOnly === true,
        ...(options.forceFreshEmailBoundary === true ? { forceFreshEmailBoundary: true } : {}),
      });
    }
    if (state.step === 'nextauth_ready') {
      await this.submitIdentityWithRecovery(state, session, { existingOnly: options.existingOnly === true });
    }
    if (state.step === 'identity_submitted') await this.sendEmailOtp(state, session, { security, existingOnly: options.existingOnly === true });
    if (state.step === 'email_otp_sent') {
      try {
        await this.validateEmailOtp(state, session);
      } catch (error) {
        const wrongCode = isWrongEmailOtpError(error);
        const queuedCodeValidated = wrongCode && await this.retryNextQueuedEmailCode(state, session, error);
        if (!queuedCodeValidated) {
          const retries = Number(state.emailOtpValidationRetries || 0);
          if (!wrongCode || retries >= MAX_EMAIL_OTP_VALIDATION_RETRIES) throw error;
          await this.restartAfterWrongEmailOtp(state, session, options, error);
          if (state.step === 'email_otp_sent') await this.validateEmailOtp(state, session);
        }
      }
    }
    if (state.step === 'phone_required' || state.step === 'phone_otp_sent') {
      state.cookieJar = session.serializeCookies();
      return state;
    }
    if (['email_otp_validated', 'account_created'].includes(state.step)) await this.completeAccount(state, session, options);
    if (['mfa_required', 'mfa_challenge_issued', 'mfa_verification_pending'].includes(state.step)) {
      await this.completeMfa(state, session);
    }
    if (state.step === 'mfa_validated') {
      if (state.authCallbackUrl) {
        state.step = 'auth_completed';
        await this.checkpoint(state, session, 'auth_completed', { callbackPath: '/api/auth/callback/openai' });
      } else {
        await this.followContinuation(state, session);
      }
    }
    if (state.step === 'auth_completed') await this.verify(state, session, verifyOptions);
    if (state.step === 'verified') {
      const failures = await this.configureSecurity(state, session, security);
      const securityPending = securityStateHasPendingWork(state);
      if (requestedSecurity) {
        state.status = failures.length || securityPending ? 'partial' : 'valid';
      } else {
        // Verification succeeded; preserve partial only when the asset still
        // has an unresolved security transaction.
        state.status = securityPending ? 'partial' : 'valid';
      }
      state.cookieJar = session.serializeCookies();
    }
    return state;
  }
}

module.exports = {
  AUTH_BASE,
  CHATGPT_BASE,
  ChatGptSessionRunner,
  authStep,
  makeInitialChatGptSessionState,
  mfaTotpFactor,
  missingSecurityFeatures,
  phoneChannelCapability,
  phoneSendPayload,
  securityStateHasPendingWork,
  securityWorkRequested,
  retryableSecurityError,
  totpCode,
  trimSessionEvents,
};
