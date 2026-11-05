'use strict';

const { tryParseJson } = require('./http-shape');
const { text } = require('./util/shared');

const DEFAULT_BASE_URL = 'http://127.0.0.1:8001';
const PROVIDER = 'icloud';
// Let the WDMail adapter do a useful long poll. The previous 3-second cap
// expired at the same time as the upstream HTTP timeout, so every Worker
// turned one mail check into a transport retry.
const MAX_REGISTRATION_POLL_WAIT_MS = 15000;
const DEFAULT_POLL_INTERVAL_SECONDS = 3;
const CLOCK_SKEW_FALLBACK_MAX_SECONDS = 60;
const CLOCK_SKEW_FALLBACK_LOOKBACK_MS = 1000;

/** `root+tag@domain` → `root@domain`; any other address is returned as is. */
function rootAddress(address) {
  const value = text(address).toLowerCase();
  const at = value.lastIndexOf('@');
  if (at <= 0) return value;
  const local = value.slice(0, at);
  const plus = local.indexOf('+');
  return plus > 0 ? `${local.slice(0, plus)}${value.slice(at)}` : value;
}

function providerError(action, message, extra = {}) {
  const error = new Error(`${PROVIDER} ${action} failed: ${message}`);
  error.provider = 'icloud-email-kit';
  error.mailProvider = PROVIDER;
  error.action = action;
  Object.assign(error, extra);
  error.public = extra.public !== false;
  return error;
}

function assertProviderResult(result, action, options = {}) {
  const actual = text(result?.provider).toLowerCase();
  if ((!actual && options.requireProvider === true) || (actual && actual !== PROVIDER)) {
    throw providerError(
      action,
      actual
        ? `expected ${PROVIDER} pool but the API returned ${actual}`
        : `expected the API to identify the ${PROVIDER} pool`,
      {
        code: actual ? 'PROVIDER_MISMATCH' : 'PROVIDER_METADATA_MISSING',
        status: 502,
        statusCode: 502,
        retryable: false,
      },
    );
  }
  return result;
}

class IcloudClient {
  constructor(options = {}) {
    this.baseUrl = text(options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.adminToken = text(options.adminToken);
    this.fetch = options.fetch || globalThis.fetch;
    this.now = options.now || Date.now;
    this.provider = PROVIDER;
    this.mailProvider = PROVIDER;
    this.aliasBatchSize = 1;
    this.aliasDomainMode = 'random';
    this.aliasDomains = [];
    this.remoteRegistrationAddresses = true;
    this.lastPoolSummary = null;
    this.lastOtpFetch = null;
    this.lastOtpFetchByMailbox = new Map();
  }

  // Keep cached preflight credentials out of the mutable runtime client.
  fork() {
    return new IcloudClient({
      baseUrl: this.baseUrl,
      adminToken: this.adminToken,
      fetch: this.fetch,
      now: this.now,
    });
  }

  providerPath(path) {
    const separator = path.includes('?') ? '&' : '?';
    return `${path}${separator}provider=${encodeURIComponent(PROVIDER)}`;
  }

  async request(method, path, body) {
    if (!this.adminToken) {
      throw providerError('request', 'mail admin token is not configured', {
        code: 'MAIL_PROVIDER_NOT_CONFIGURED',
        statusCode: 503,
        retryable: false,
      });
    }
    const headers = {
      Accept: 'application/json',
      'X-Admin-Token': this.adminToken,
    };
    const init = { method, headers, redirect: 'manual' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${this.providerPath(path)}`, init);
    } catch (error) {
      throw providerError(`${method} ${path}`, error.message, {
        code: 'MAIL_PROVIDER_UNAVAILABLE',
        statusCode: 503,
        retryable: true,
        cause: error,
      });
    }
    const raw = await response.text();
    const json = tryParseJson(raw) || {};
    if (!response.ok) {
      const detail = json.detail;
      const detailObject = detail && typeof detail === 'object' && !Array.isArray(detail)
        ? detail
        : null;
      const message = detailObject?.message
        || (typeof detail === 'string' ? detail : '')
        || json.error
        || json.message
        || `HTTP ${response.status}`;
      const retryable = detailObject && typeof detailObject.retryable === 'boolean'
        ? detailObject.retryable
        : response.status === 408 || response.status === 429 || response.status >= 500;
      const code = detailObject?.code ? String(detailObject.code) : 'MAIL_PROVIDER_HTTP_ERROR';
      const retryAfterMs = Number(detailObject?.retryAfterMs);
      throw providerError(`${method} ${path}`, message, {
        code,
        status: response.status,
        statusCode: 502,
        response: json,
        ...(detailObject?.category ? { category: String(detailObject.category) } : {}),
        ...(detailObject?.stage ? { stage: String(detailObject.stage) } : {}),
        ...(Number.isFinite(Number(detailObject?.status))
          ? { providerStatus: Number(detailObject.status) }
          : {}),
        ...(Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? { retryAfterMs } : {}),
        retryable,
        publicDetails: {
          code,
          provider: PROVIDER,
          action: `${method} ${path}`,
          upstreamStatus: response.status,
          retryable,
          ...(detailObject?.category ? { category: String(detailObject.category) } : {}),
          ...(detailObject?.stage ? { stage: String(detailObject.stage) } : {}),
          ...(Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? { retryAfterMs } : {}),
        },
      });
    }
    return json;
  }

  async checkAuth() {
    return this.request('GET', '/api/health');
  }

  async summary() {
    return assertProviderResult(await this.request('GET', '/api/summary'), 'summary', { requireProvider: true });
  }

  async listAccounts() {
    const result = assertProviderResult(
      await this.request('GET', '/api/pool/accounts'),
      'pool accounts',
      { requireProvider: true },
    );
    if (result && typeof result === 'object' && !Array.isArray(result) && result.summary) {
      this.lastPoolSummary = result.summary;
    }
    return Array.isArray(result) ? result : (result.accounts || []);
  }

  async addMaster(email, endpoint) {
    return this.request('POST', '/api/masters', {
      email: String(email),
      // 8001 keeps the WDMail URL in its provider-specific protected pool.
      password: String(endpoint),
      count: 1,
    });
  }

  async importMasters(content) {
    return this.request('POST', '/api/masters/bulk', {
      content: String(content),
      count: 1,
    });
  }

  async reserveMailbox(mailboxId) {
    return this.request('POST', '/api/pool/reserve', { id: String(mailboxId) });
  }

  async markMailboxRegistrationStarted(mailboxId, options = {}) {
    return this.request('POST', '/api/pool/registration-started', {
      id: String(mailboxId),
      note: options.note || '',
    });
  }

  async releaseMailbox(mailboxId) {
    return this.request('POST', '/api/pool/release', { id: String(mailboxId), status: 'available' });
  }

  async consumeMailbox(mailboxId, options = {}) {
    return this.request('POST', '/api/pool/consume', {
      id: String(mailboxId),
      note: options.note || '',
      alias_count: 1,
    });
  }

  async listAliasDomains() {
    return {
      provider: PROVIDER,
      mode: 'random',
      domains: [],
      availableDomains: [],
      selectedDomains: [],
      deniedDomains: [],
    };
  }

  async reportDelivery(address, delivered, reason = '') {
    return {
      provider: PROVIDER,
      address: String(address || ''),
      delivered: Boolean(delivered),
      ...(reason ? { reason: String(reason) } : {}),
    };
  }

  async snapshotMailbox(mailboxId) {
    // WDMail exposes a mailbox-scoped HTML view, not a message-id listing.
    // Keep the boundary shape stable without making a Mail.com snapshot call.
    return { mailboxId: String(mailboxId || ''), messageIds: [], source: 'wdmail_http' };
  }

  async findVerificationCode(mailboxId, options = {}) {
    // WDMail is a normal HTTP page, not a long-lived mailbox connection.
    // Use bounded server-side polling so concurrent registrations do not
    // repeatedly reopen the same local API path every few seconds.
    const requestedWaitMs = Number(options.maxWaitMs);
    const maxWaitMs = Math.max(
      1,
      Math.min(
        MAX_REGISTRATION_POLL_WAIT_MS,
        Number.isFinite(requestedWaitMs) && requestedWaitMs > 0 ? requestedWaitMs : 5000,
      ),
    );
    const maxWait = Math.max(1, Math.min(600, Math.ceil(maxWaitMs / 1000)));
    const requestedPollInterval = Number(options.pollInterval);
    const requestedPollIntervalMs = Number(options.pollIntervalMs);
    const pollInterval = Number.isFinite(requestedPollInterval) && requestedPollInterval > 0
      ? requestedPollInterval
      : (Number.isFinite(requestedPollIntervalMs) && requestedPollIntervalMs > 0
        ? Math.ceil(requestedPollIntervalMs / 1000)
        : DEFAULT_POLL_INTERVAL_SECONDS);
    const recipient = text(options.recipient);
    // OpenAI's mail to `root+tag@icloud.com` lands in the root inbox, and 8001
    // reads that inbox by its root address: it refuses any other recipient
    // ("recipient does not match mailbox") and does not filter by recipient.
    // The alias is told apart by time instead — root and alias run one after
    // the other, and `since` is the alias's own send boundary.
    const mailboxAddress = rootAddress(recipient);
    const requestedSince = text(options.since);
    const baseBody = {
      mailbox_id: String(mailboxId),
      max_wait: maxWait,
      poll_interval: Math.max(1, Math.min(60, pollInterval)),
      match_subjects: options.keyword ? [options.keyword] : undefined,
      match_recipient: Boolean(mailboxAddress),
      email: mailboxAddress || undefined,
      exclude_message_ids: Array.isArray(options.excludeMessageIds) ? options.excludeMessageIds : [],
    };
    const requestBody = (since) => ({
      ...baseBody,
      since: since || undefined,
    });
    const strictResult = await this.request('POST', '/api/otp/fetch', requestBody(requestedSince));
    let result = strictResult;
    const strictReceivedAt = text(strictResult.receivedAt || strictResult.received_at);
    const sentAtMs = Date.parse(requestedSince);
    const receivedAtMs = Date.parse(strictReceivedAt);
    const clockSkewSeconds = Number.isFinite(sentAtMs) && Number.isFinite(receivedAtMs)
      ? (sentAtMs - receivedAtMs) / 1000
      : 0;
    const hasCandidate = Number(strictResult.checked_emails ?? strictResult.checkedEmails ?? 0) > 0
      && Number(strictResult.listed ?? 0) > 0;
    const canUseClockSkewFallback = !strictResult.otp
      && hasCandidate
      && clockSkewSeconds > 0
      && clockSkewSeconds <= CLOCK_SKEW_FALLBACK_MAX_SECONDS;
    const fallbackSince = canUseClockSkewFallback
      ? new Date(receivedAtMs - CLOCK_SKEW_FALLBACK_LOOKBACK_MS).toISOString()
      : '';
    const clockSkewFallback = {
      attempted: Boolean(fallbackSince),
      used: false,
      originalSince: requestedSince,
      fallbackSince,
      receivedAt: strictReceivedAt,
      skewSeconds: clockSkewSeconds,
    };
    if (fallbackSince) {
      result = await this.request('POST', '/api/otp/fetch', requestBody(fallbackSince));
      clockSkewFallback.used = Boolean(result.otp);
    }
    const diagnostics = {
      at: new Date(this.now()).toISOString(),
      mailboxId: String(mailboxId),
      recipient,
      sentAt: requestedSince,
      since: fallbackSince || requestedSince,
      receivedAt: text(result.receivedAt || result.received_at || strictReceivedAt),
      found: Boolean(result.otp),
      checkedEmails: Number(result.checked_emails ?? result.checkedEmails ?? 0) || 0,
      listed: Number(result.listed || 0) || 0,
      source: text(result.source),
      inbox: text(result.email),
      subject: text(result.subject),
      clockSkewFallback,
    };
    this.lastOtpFetch = diagnostics;
    this.lastOtpFetchByMailbox.set(String(mailboxId), diagnostics);
    if (!result.otp) return null;
    return {
      code: String(result.otp),
      messageId: result.messageId || `${result.email}:${result.checked_emails || 0}`,
      consumedMessageId: result.messageId || '',
      sender: result.sender || '',
      subject: result.subject || '',
      receivedAt: result.receivedAt || new Date(this.now()).toISOString(),
      folder: 'INBOX',
      source: result.source || 'wdmail_http',
    };
  }

  lastOtpDiagnostics(mailboxId) {
    return this.lastOtpFetchByMailbox.get(String(mailboxId)) || null;
  }
}

module.exports = { IcloudClient };
