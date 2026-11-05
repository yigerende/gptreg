'use strict';

/**
 * Abstracted account re-bind (换绑) chain.
 *
 * Distilled from the reference `rebind.py`: sign the account's login-state in,
 * ask ChatGPT to move it onto a fresh mailbox on a *different* mail channel,
 * read the one-time code the change delivers to that mailbox, confirm it, and
 * re-probe the account so the caller can prove it survived.
 *
 * The fast path reuses the login state already captured on the session asset —
 * its access token *and* its cookie jar — through the same lightweight
 * `UrlSession` the health probe uses, so one sticky proxy carries the
 * begin -> verify -> re-probe steps on a single identity. When that stored
 * login state is stale (or a sensitive step demands a fresh one), an injected
 * `login` closure re-signs the account in with its password + TOTP — the same
 * capability the project's login-state refresh uses — and the chain retries on
 * the refreshed session instead of failing. Mailbox claiming and OTP reading
 * are injected as closures so the chain stays agnostic of the mail channel.
 */

const { UrlSession } = require('./url-session');
const { normalizedEmail } = require('./session-asset-store');
const { compactOtpDiagnostics, recipientMismatch } = require('./rebind-mail-channel');
const { isRetryableTransportError } = require('./transport-errors');
const { setTimeout: sleep } = require('node:timers/promises');

const CHATGPT_BASE = 'https://chatgpt.com';
const DEFAULT_PROBE_TIMEOUT_MS = 15000;
const DEFAULT_CHANGE_TIMEOUT_MS = 30000;
const DEFAULT_OTP_TIMEOUT_MS = 120000;
const DEFAULT_OTP_POLL_INTERVAL_MS = 4000;
const DEFAULT_OTP_RETRIES = 1;

function text(value) {
  return String(value == null ? '' : value).trim();
}

function otpTimeoutMessage(diagnostics) {
  if (!diagnostics) return '未在超时时间内收到换绑验证码';
  if (recipientMismatch(diagnostics)) {
    return '未在超时时间内收到换绑验证码（邮箱接口收到了邮件，但没有匹配到领取地址）';
  }
  const checked = Math.max(diagnostics.listed, diagnostics.checkedEmails);
  return checked > 0
    ? `未在超时时间内收到换绑验证码（已检查 ${checked} 封邮件）`
    : '未在超时时间内收到换绑验证码（邮箱接口没有发现新邮件）';
}

class RebindError extends Error {
  constructor(stage, code, message, details = {}) {
    super(message);
    this.name = 'RebindError';
    this.stage = stage;
    this.code = code;
    this.details = details;
  }
}

function isLoginStateError(error) {
  const code = error && error.code;
  return code === 'LOGIN_STATE_INVALID' || code === 'LOGIN_STATE_REJECTED';
}

// A transport/proxy failure never reached (or never heard back from) the
// server, so a bounded retry on the same endpoint may help. Server HTTP
// errors must not trigger a blind transport retry.
const TRANSPORT_ERROR_PATTERN = /ENETUNREACH|ECONNRESET|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|EAI_AGAIN|EPIPE|socket hang up|timed ?out|timeout|proxy|CONNECT|network|tunnel|socket|closed before|disconnected before|handshake/i;
function isTransportError(error) {
  if (!error) return false;
  if (error.fatal || error.retryable === false) return false;
  if (Number(error.details?.httpStatus || error.status || error.statusCode || 0) >= 400) return false;
  if (error.code === 'PROBE_NETWORK_ERROR') return true;
  const code = String(error.code || '');
  if (isRetryableTransportError(error) || /_TIMEOUT$/.test(code)) return true;
  return TRANSPORT_ERROR_PATTERN.test(String(error.message || ''));
}

function identityFrom(payload = {}) {
  const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
  return {
    emails: [
      payload.email,
      payload.user?.email,
      payload.account?.email,
      ...accounts.map((account) => account?.email),
    ].map(normalizedEmail).filter(Boolean),
    accountIds: [
      payload.account_id,
      payload.accountId,
      payload.account?.id,
      payload.user?.account_id,
      ...accounts.map((account) => account?.id),
    ].map(text).filter(Boolean),
  };
}

function backendHeaders(ctx, extra = {}) {
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${ctx.accessToken}`,
  };
  if (ctx.oaiDid) headers['oai-device-id'] = ctx.oaiDid;
  if (ctx.accountId) headers['chatgpt-account-id'] = ctx.accountId;
  const build = text(ctx.session?.build_number || ctx.session?.buildNumber);
  const clientVersion = text(ctx.session?.client_version || ctx.session?.clientVersion);
  if (build) headers['oai-client-build-number'] = build;
  if (clientVersion) headers['oai-client-version'] = clientVersion;
  return { ...headers, ...extra };
}

async function backendRequest(session, ctx, method, path, options = {}) {
  return session.once(method, `${CHATGPT_BASE}${path}`, {
    origin: CHATGPT_BASE,
    referer: `${CHATGPT_BASE}/`,
    headers: backendHeaders(ctx),
    json: options.json,
    timeoutMs: options.timeoutMs,
    signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(options.timeoutMs || DEFAULT_CHANGE_TIMEOUT_MS)]),
  });
}

function assertOk(stage, code, result) {
  const status = Number(result?.response?.status || 0);
  if (status >= 200 && status < 300) return result;
  const snippet = text(result?.response?.text).slice(0, 180);
  const authError = text(result?.json?.error?.code || result?.json?.code);
  if (status === 401 || (status === 403 && /session|token|reauth|login_required/i.test(authError))) {
    throw new RebindError(stage, 'LOGIN_STATE_REJECTED', `${code}: login state rejected (HTTP ${status})`, { httpStatus: status, serverCode: authError });
  }
  if (status === 403) throw new RebindError(stage, 'CHANGE_EMAIL_FORBIDDEN', '换绑请求被拒绝（HTTP 403），请核对账号是否支持换绑', { httpStatus: status, serverCode: authError });
  throw new RebindError(stage, code, `${code}: HTTP ${status} ${snippet}`, { httpStatus: status, serverCode: authError });
}

/** Confirm the current access token still resolves, optionally to a target email. */
async function probeIdentity(session, ctx, options = {}) {
  ctx = { ...ctx, signal: ctx.signal || AbortSignal.timeout(DEFAULT_PROBE_TIMEOUT_MS) };
  const timeoutMs = Number(options.timeoutMs || DEFAULT_PROBE_TIMEOUT_MS);
  let result;
  try {
    result = await backendRequest(session, ctx, 'GET', '/backend-api/me', { timeoutMs });
  } catch (error) {
    throw new RebindError(options.stage || 'probe', 'PROBE_NETWORK_ERROR', `identity probe failed: ${text(error?.message)}`, {});
  }
  const status = Number(result?.response?.status || 0);
  const serverCode = text(result?.json?.error?.code || result?.json?.code);
  if (status === 401) throw new RebindError(options.stage || 'probe', 'LOGIN_STATE_INVALID', 'access token was rejected (HTTP 401)', { httpStatus: status, serverCode });
  if (status < 200 || status >= 300) {
    throw new RebindError(options.stage || 'probe', 'PROBE_REJECTED', `identity probe returned HTTP ${status}`, { httpStatus: status, serverCode });
  }
  const identity = identityFrom(result.json || {});
  if (ctx.accountId && identity.accountIds.some((id) => id !== ctx.accountId)) {
    throw new RebindError(options.stage || 'probe', 'IDENTITY_MISMATCH', '测活返回的账号 ID 与原账号不一致');
  }
  return { httpStatus: status, identity };
}

/**
 * Run the full re-bind for one account.
 *
 * @param {object} params
 * @param {object} params.asset      Raw session asset (accessToken/cookieJar/clientProfile/accountId/...).
 * @param {string} params.proxy      Sticky proxy URL for the whole chain.
 * @param {string} params.newProvider  Mail channel the new address comes from.
 * @param {Function} params.claimEmail   async () => ({ mailboxId, email })
 * @param {Function} params.readOtp      async (mailboxId, { recipient, since }) => code
 * @param {Function} [params.login]      async () => ({ accessToken, cookieJar, accountId, oaiDid, session })
 *        Re-signs the account in with password + TOTP to refresh a stale login state.
 * @param {Function} [params.postLogin]  Login with the new email after confirmation, independently of the pre-login policy.
 * @param {boolean}  [params.alwaysFreshLogin]  Refresh before the first attempt (reference behaviour).
 * @param {Function} [params.releaseEmail]  async (mailboxId) => void   (rollback on failure)
 * @param {Function} [params.consumeEmail]  async (mailboxId, { email, reason }) => void  (mark consumed)
 * @param {Function} [params.log]        (event, detail) => void
 * @param {object}   [params.timeouts]
 */
async function rebindAccount(params = {}) {
  const asset = params.asset || {};
  const log = typeof params.log === 'function' ? params.log : () => {};
  const timeouts = params.timeouts || {};
  const maxOtpRetries = Math.max(0, Math.min(5, Math.floor(Number(params.otpRetries ?? DEFAULT_OTP_RETRIES) || 0)));
  const maxConnectionRetries = Math.max(0, Math.min(5, Math.floor(Number(params.proxyRetries ?? 2) || 0)));
  const otpTimeoutMs = timeouts.otpMs || DEFAULT_OTP_TIMEOUT_MS;
  const signal = AbortSignal.timeout(timeouts.accountMs || 300000 + (maxOtpRetries + 1) * otpTimeoutMs);
  const canLogin = typeof params.login === 'function';
  const postLogin = params.postLogin || params.login;
  const previousEmail = text(asset.email);
  const result = {
    assetId: asset.id,
    previousEmail,
    accountId: text(asset.accountId),
    provider: params.newProvider || '',
    status: 'error',
    stage: 'init',
    newEmail: '',
    mailboxId: '',
    refreshed: false,
    postRefreshed: false,
    mailboxAttempts: 0,
    mailboxRetries: [],
    attemptErrors: [],
    attempts: 1,
  };

  // Mutable session context — a mid-chain login-state refresh replaces it.
  const ctx = {
    accessToken: text(asset.accessToken),
    accountId: text(asset.accountId),
    oaiDid: text(asset.oaiDid),
    session: asset.session || {},
    signal,
  };
  let cookieJar = asset.cookieJar;
  let session = new UrlSession({ clientProfile: asset.clientProfile || {}, cookieJar, proxy: text(params.proxy), executor: params.executor, signal });
  let refreshed = false;
  const setStage = (stage, detail = {}) => {
    result.stage = stage;
    params.onStage?.(stage, detail);
  };

  // Retry the interrupted operation while retaining the mailbox and confirmed
  // steps. Restarting rebindAccount would release the mailbox or rebind twice.
  const retryConnection = async (action) => {
    for (let retryAttempt = 0; ; retryAttempt += 1) {
      signal.throwIfAborted();
      try {
        return await action();
      } catch (error) {
        if (signal.aborted || !isTransportError(error) || retryAttempt >= maxConnectionRetries) throw error;
        const delayMs = Math.min(10000, Math.max(0, Number(timeouts.retryMs ?? 1000)) * (2 ** retryAttempt));
        const retry = {
          attempt: result.attempts++, stage: result.stage,
          code: text(error.details?.causeCode || error.code) || 'NETWORK_ERROR',
          error: text(error.message).slice(0, 220), retryAttempt: retryAttempt + 1,
          maxRetries: maxConnectionRetries, delayMs,
          nextRetryAt: new Date(Date.now() + delayMs).toISOString(),
        };
        result.attemptErrors.push(retry);
        log('rebind_connection_retry', { assetId: asset.id, ...retry, nextAttempt: result.attempts });
        params.onProgress?.({ connectionRetry: { ...retry, pending: true } });
        if (delayMs) await sleep(delayMs, undefined, { signal });
        signal.throwIfAborted();
        params.onProgress?.({ connectionRetry: { ...retry, pending: false } });
      }
    }
  };

  const applyRefresh = async (reason, email = previousEmail, login = params.login) => {
    const refreshStage = reason === 'verify_reconcile' ? 'change_reconcile' : reason === 'after_rebind' ? 'post_login_refresh' : reason === 'change_begin_rejected' ? 'change_reauth' : 'login_refresh';
    if (typeof login !== 'function') throw new RebindError(refreshStage, 'AT_REFRESH_UNAVAILABLE', '无法自动刷新登录态（账号缺少密码或 TOTP）');
    const previousStage = result.stage;
    setStage(refreshStage, { refreshReason: reason, resumeStage: previousStage });
    log('login_refresh_started', { assetId: asset.id, reason });
    let fresh;
    let loginStep = '';
    try {
      fresh = await retryConnection(() => login({ signal, email, reason, onProgress: (detail) => {
        loginStep = text(detail?.step);
        params.onProgress?.({ loginStep });
      } }));
    } catch (error) {
      const wrapped = new RebindError(refreshStage, 'AT_REFRESH_FAILED', `登录态刷新失败: ${text(error?.message).slice(0, 160)}`, {
        causeCode: text(error?.code), step: text(error?.step) || loginStep,
        httpStatus: Number(error?.status || error?.statusCode || 0), refreshReason: reason, resumeStage: previousStage,
      });
      wrapped.retryable = isTransportError(error);
      throw wrapped;
    }
    if (!text(fresh?.accessToken)) throw new RebindError(refreshStage, 'AT_REFRESH_FAILED', '登录态刷新未返回 access token');
    if (ctx.accountId && fresh.accountId && ctx.accountId !== text(fresh.accountId)) {
      throw new RebindError(refreshStage, 'IDENTITY_MISMATCH', '刷新后的账号 ID 与原账号不一致');
    }
    ctx.accessToken = text(fresh.accessToken);
    if (text(fresh.accountId)) ctx.accountId = text(fresh.accountId);
    if (text(fresh.oaiDid)) ctx.oaiDid = text(fresh.oaiDid);
    if (fresh.session) ctx.session = fresh.session;
    if (fresh.planType) {
      ctx.planType = text(fresh.planType).toLowerCase();
      // Reuse the plan observed by the first login in this chain so a second
      // login after confirmation does not issue a duplicate usage request.
      asset.planType = ctx.planType;
    }
    if (fresh.usage !== undefined) ctx.usage = fresh.usage;
    cookieJar = fresh.cookieJar || cookieJar;
    session = new UrlSession({ clientProfile: fresh.clientProfile || asset.clientProfile || {}, cookieJar, proxy: text(params.proxy), executor: params.executor, signal });
    refreshed = true;
    result.refreshed = true;
    if (reason === 'after_rebind' || reason === 'verify_reconcile') result.postRefreshed = true;
    for (const key of ['sessionToken', 'clientProfile', 'me', 'planType', 'usage', 'lastValidatedAt']) {
      if (fresh[key] !== undefined) result[key] = fresh[key];
    }
    log('login_refresh_done', { assetId: asset.id });
    if (reason !== 'after_rebind') setStage(previousStage);
  };

  // Login-state rejection is recoverable exactly once. Keeping this policy in
  // one helper prevents the probe and change-begin stages from drifting apart.
  const retryAfterRefresh = async (reason, action) => {
    try {
      return await action();
    } catch (error) {
      if (!isLoginStateError(error) || !canLogin || refreshed) throw error;
      log('login_state_rejected', { assetId: asset.id, stage: result.stage, reason, code: error.code, httpStatus: error.details?.httpStatus, serverCode: error.details?.serverCode });
      await applyRefresh(reason);
      return action();
    }
  };

  const probeExpectingPrevious = async (stage) => {
    const probe = await retryConnection(() => probeIdentity(session, ctx, { stage, timeoutMs: timeouts.probeMs }));
    if (previousEmail && probe.identity.emails.length && !probe.identity.emails.includes(normalizedEmail(previousEmail))) {
      throw new RebindError(stage, 'IDENTITY_MISMATCH', '登录态身份与账号邮箱不一致', { emails: probe.identity.emails });
    }
    return probe;
  };

  let claimed = null;
  let changeConfirmed = false;
  let verificationUncertain = false;
  let bookkeeping = Promise.resolve();
  let otpRetryCount = 0;
  const releaseClaimed = async () => {
    const current = claimed;
    claimed = null;
    if (!current || changeConfirmed || verificationUncertain || typeof params.releaseEmail !== 'function') return;
    setStage('release');
    try {
      await params.releaseEmail(text(current.mailboxId ?? current.id));
    } catch (releaseError) {
      result.warning = `邮箱释放失败: ${text(releaseError?.message).slice(0, 150)}`;
    }
  };
  const consumeClaimed = async (reason) => {
    const current = claimed;
    claimed = null;
    if (!current || typeof params.consumeEmail !== 'function') return;
    try {
      await params.consumeEmail(text(current.mailboxId ?? current.id), { email: text(current.email), reason });
    } catch (consumeError) {
      result.warning = `邮箱消费登记失败: ${text(consumeError?.message).slice(0, 150)}`;
    }
  };
  try {
    // 1) Establish a usable login state (refresh eagerly, or on a stale token).
    setStage('login');
    if (params.alwaysFreshLogin && canLogin) await applyRefresh('always_fresh');
    if (!ctx.accessToken) {
      if (canLogin) await applyRefresh('missing_token');
      else return { ...result, status: 'needs_refresh', stage: 'precheck', code: 'AT_MISSING', error: '登录态缺少 access token，请先刷新登录态' };
    }
    await retryAfterRefresh('probe_rejected', () => probeExpectingPrevious('login'));
    log('login_verified', { assetId: asset.id, refreshed });

    let newEmail = '';
    let mailboxId = '';
    let code = '';
    // 2-4) Claim a mailbox, start the change, and wait for its OTP. If the
    //     mailbox produces no code before the deadline, consume it and retry
    //     once with a fresh address so a delayed or dead inbox is never reused.
    for (;;) {
      signal.throwIfAborted();
      setStage('claim', { mailboxAttempt: otpRetryCount + 1, maxMailboxAttempts: maxOtpRetries + 1 });
      const nextClaim = await params.claimEmail();
      newEmail = text(nextClaim?.email);
      mailboxId = text(nextClaim?.mailboxId ?? nextClaim?.id);
      if (!newEmail) throw new RebindError('claim', 'NO_MAILBOX', '目标邮箱接口没有可领取的未注册邮箱');
      claimed = nextClaim;
      result.newEmail = newEmail;
      result.mailboxId = mailboxId;
      result.mailboxAttempts = otpRetryCount + 1;
      delete result.otpDiagnostics;
      const since = new Date(Date.now() - 5000).toISOString();
      log('mailbox_claimed', { assetId: asset.id, email: newEmail, mailboxId, attempt: otpRetryCount + 1 });

      // 3) Ask ChatGPT to move the account onto the new address. A sensitive
      //    step-up rejection triggers one login-state refresh and a retry.
      setStage('change_begin');
      const beginOnce = () => backendRequest(session, ctx, 'POST', '/backend-api/accounts/change_email/begin', {
        json: { email: newEmail },
        timeoutMs: timeouts.changeMs || DEFAULT_CHANGE_TIMEOUT_MS,
      });
      await retryAfterRefresh('change_begin_rejected', async () => {
        await retryConnection(async () => assertOk('change_begin', 'CHANGE_EMAIL_BEGIN_FAILED', await beginOnce()));
      });
      log('change_email_begun', { assetId: asset.id, email: newEmail });

      // 4) Read the one-time code delivered to the new mailbox.
      setStage('otp', { timeoutMs: otpTimeoutMs });
      let otp;
      try {
        otp = await params.readOtp(mailboxId, {
          recipient: newEmail,
          since,
          signal,
          timeoutMs: otpTimeoutMs,
          pollIntervalMs: timeouts.otpPollMs || DEFAULT_OTP_POLL_INTERVAL_MS,
          onPoll: (detail) => params.onProgress?.({ otp: detail }),
        });
      } catch (error) {
        if (signal.aborted) {
          await consumeClaimed('otp_timeout');
          throw new RebindError('otp', 'ACCOUNT_TIMEOUT', '账号处理总时限已到，当前收码邮箱已弃用');
        }
        if (error.fatal || error.retryable === false || [401, 403].includes(error.status || error.statusCode) || !isTransportError(error)) throw error;
        otp = { code: '', reason: 'otp_timeout' };
      }
      code = typeof otp === 'string' ? text(otp) : text(otp?.code || otp?.otp || otp?.verificationCode);
      const diagnostics = compactOtpDiagnostics(otp?.diagnostics);
      if (diagnostics) result.otpDiagnostics = diagnostics;
      if (code) break;
      const reason = otp?.reason === 'recipient_mismatch' || recipientMismatch(diagnostics) ? 'recipient_mismatch' : 'otp_timeout';
      const retry = { email: newEmail, mailboxId, reason };
      result.mailboxRetries.push(retry);
      setStage('mailbox_retry', { retryReason: reason, willRetry: otpRetryCount < maxOtpRetries });
      await consumeClaimed(reason);
      if (otpRetryCount >= maxOtpRetries) throw new RebindError('otp', reason === 'recipient_mismatch' ? 'OTP_RECIPIENT_MISMATCH' : 'NO_OTP', reason === 'recipient_mismatch' ? '邮箱收到了邮件，但没有匹配到领取地址；更换邮箱次数已用完' : otpTimeoutMessage(diagnostics), { diagnostics });
      otpRetryCount += 1;
      log('mailbox_retry', { assetId: asset.id, previousMailboxId: mailboxId, reason, attempt: otpRetryCount + 1 });
    }
    log('otp_received', { assetId: asset.id, email: newEmail });

    // 5) Confirm the change.
    setStage('change_verify');
    try {
      assertOk('change_verify', 'CHANGE_EMAIL_VERIFY_FAILED', await backendRequest(session, ctx, 'POST', '/backend-api/accounts/change_email/verify', {
        json: { email: newEmail, code: text(code) },
        timeoutMs: timeouts.changeMs || DEFAULT_CHANGE_TIMEOUT_MS,
      }));
    } catch (error) {
      if (!isTransportError(error)) throw error;
      // Do not replay a commit whose response was lost. Reconcile with reads
      // and, if needed, a login to the new address on the same bound proxy.
      verificationUncertain = true;
      setStage('change_reconcile');
      log('change_email_confirmation_lost', { assetId: asset.id, code: text(error.code), message: text(error.message).slice(0, 180) });
      const checkChangedEmail = () => retryConnection(() => probeIdentity(session, ctx, { stage: 'change_reconcile', timeoutMs: timeouts.probeMs }));
      let observed;
      try { observed = await checkChangedEmail(); } catch (probeError) {
        if (!isLoginStateError(probeError)) throw probeError;
      }
      if (!observed?.identity.emails.includes(normalizedEmail(newEmail)) && typeof postLogin === 'function') {
        await applyRefresh('verify_reconcile', newEmail, postLogin);
        observed = await checkChangedEmail();
      }
      if (!observed?.identity.emails.includes(normalizedEmail(newEmail))) throw error;
      verificationUncertain = false;
      log('change_email_reconciled', { assetId: asset.id, email: newEmail });
    }
    changeConfirmed = true;
    result.changeConfirmed = true;
    log('change_email_verified', { assetId: asset.id, email: newEmail });

    // Confirmation commits the mailbox binding even if the health probe fails.
    if (typeof params.consumeEmail === 'function') {
      // Overlap bookkeeping with the probe, but settle both before finishing.
      bookkeeping = Promise.resolve().then(() => params.consumeEmail(mailboxId, { email: newEmail }))
        .catch((error) => { result.warning = `邮箱状态登记失败: ${text(error?.message).slice(0, 150)}`; });
    }

    // A confirmed change can invalidate the old session. Always log in with
    // the new email on this attempt's proxy before declaring the account ready.
    if (!result.postRefreshed) await applyRefresh('after_rebind', newEmail, postLogin);

    // 6) Re-probe the fresh session to prove it answers on the new address.
    setStage('verify_health');
    const post = await retryConnection(() => probeIdentity(session, ctx, { stage: 'verify_health', timeoutMs: timeouts.probeMs }));
    const movedOntoNew = post.identity.emails.includes(normalizedEmail(newEmail));
    if (!movedOntoNew) throw new RebindError('verify_health', 'EMAIL_NOT_MOVED', '换绑后账号邮箱仍未更新为新地址', { emails: post.identity.emails });

    result.status = 'ok';
    result.stage = 'done';
    result.changeConfirmed = true;
    result.proxyRetryable = false;
    result.health = { status: 'alive', httpStatus: post.httpStatus, checkedAt: new Date().toISOString() };
    log('rebind_ok', { assetId: asset.id, previousEmail, newEmail, refreshed });
    return result;
  } catch (error) {
    const stage = error instanceof RebindError ? error.stage : result.stage;
    const code = error instanceof RebindError ? error.code : 'REBIND_FAILED';
    await releaseClaimed();
    const needsRefresh = ['AT_MISSING', 'LOGIN_STATE_INVALID', 'LOGIN_STATE_REJECTED', 'AT_REFRESH_UNAVAILABLE', 'AT_REFRESH_FAILED'].includes(code);
    result.status = verificationUncertain ? 'needs_review' : needsRefresh ? 'needs_refresh' : 'error';
    result.stage = stage;
    result.code = code;
    result.failure = {
      code: text(error?.details?.causeCode || error?.details?.serverCode || error?.code) || code,
      step: text(error?.details?.step || error?.step) || stage,
      httpStatus: Number(error?.details?.httpStatus || error?.status || error?.statusCode || 0),
      refreshReason: text(error?.details?.refreshReason), resumeStage: text(error?.details?.resumeStage),
    };
    result.changeConfirmed = changeConfirmed;
    result.verificationUncertain = verificationUncertain;
    // Local operation retries are exhausted. The caller must never replay the
    // entire chain, including a mailbox claim or an already-confirmed change.
    result.proxyRetryable = false;
    result.error = verificationUncertain ? '确认换绑时连接中断，结果待核对；邮箱已保留，请核对后再处理' : text(error?.message).slice(0, 220);
    log('rebind_failed', { assetId: asset.id, stage, code, message: result.error });
    return result;
  } finally {
    if (refreshed || changeConfirmed) {
      Object.assign(result, { accessToken: ctx.accessToken, accountId: ctx.accountId, oaiDid: ctx.oaiDid, session: ctx.session, cookieJar: session.serializeCookies() });
    }
    if (changeConfirmed && params.consumeEmail) params.onStage?.('settle');
    await bookkeeping;
  }
}

module.exports = {
  rebindAccount,
};
