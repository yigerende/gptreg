'use strict';

const { tryParseJson } = require('./http-shape');
const { text } = require('./util/shared');

const DEFAULT_BASE_URL = 'http://127.0.0.1:8001';
const REMOTE_MAIL_PROVIDERS = new Set(['mailcom', 'fastmail']);

function normalizeAliasDomains(value) {
  const values = Array.isArray(value) ? value : [];
  return [...new Set(values
    .map((item) => text(item).toLowerCase().replace(/^@/, ''))
    .filter(Boolean))];
}

function normalizeProvider(value) {
  const provider = text(value || 'mailcom').toLowerCase();
  if (!REMOTE_MAIL_PROVIDERS.has(provider)) throw new Error(`Unsupported remote mail provider: ${provider}`);
  return provider;
}

function providerError(action, message, extra = {}, provider = 'mailcom') {
  const normalizedProvider = normalizeProvider(provider);
  const error = new Error(`${normalizedProvider} ${action} failed: ${message}`);
  error.provider = `${normalizedProvider}-email-kit`;
  error.mailProvider = normalizedProvider;
  error.action = action;
  Object.assign(error, extra);
  error.public = extra.public !== false;
  return error;
}

function assertProviderResult(result, action, provider, options = {}) {
  const actual = text(result?.provider).toLowerCase();
  if ((!actual && options.requireProvider === true) || (actual && actual !== provider)) {
    throw providerError(
      action,
      actual
        ? `expected ${provider} pool but the API returned ${actual}`
        : `expected the API to identify the ${provider} pool`,
      {
        code: actual ? 'PROVIDER_MISMATCH' : 'PROVIDER_METADATA_MISSING',
        status: 502,
        statusCode: 502,
        retryable: false,
      },
      provider,
    );
  }
  return result;
}

class MailcomClient {
  constructor(options = {}) {
    // Kept for callers that only ever use one mailbox. Concurrent workers use
    // the keyed map below so one mailbox cannot overwrite another one's poll
    // diagnostics.
    this.lastOtpFetch = null;
    this.lastOtpFetchByMailbox = new Map();
    // Counts from the last `/api/pool/accounts`, so a shortfall can say how the
    // pool is actually split rather than just "not enough".
    this.lastPoolSummary = null;
    this.baseUrl = text(options.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.adminToken = text(options.adminToken);
    this.provider = normalizeProvider(options.provider);
    this.mailProvider = this.provider;
    this.fetch = options.fetch || globalThis.fetch;
    this.now = options.now || Date.now;
    const defaultBatchSize = this.provider === 'mailcom' ? 9 : 1;
    this.aliasBatchSize = Math.max(1, Number(options.aliasBatchSize || defaultBatchSize));
    this.aliasDomainMode = text(options.aliasDomainMode || 'random').toLowerCase();
    this.aliasDomains = normalizeAliasDomains(options.aliasDomains || options.domains);
    this.remoteRegistrationAddresses = true;
  }

  // Preflight results may be shared by concurrent starts. Rebuild the cheap
  // client so OTP and pool diagnostics stay task-local.
  fork() {
    return new MailcomClient({
      baseUrl: this.baseUrl,
      adminToken: this.adminToken,
      provider: this.provider,
      fetch: this.fetch,
      now: this.now,
      aliasBatchSize: this.aliasBatchSize,
      aliasDomainMode: this.aliasDomainMode,
      aliasDomains: this.aliasDomains,
    });
  }

  providerPath(path, options = {}) {
    const query = { ...(options.query || {}) };
    // 8001 is one HTTP service, but its Mail.com and Fastmail pools are
    // independent. The service treats a missing provider as an aggregate view
    // for several read routes, so every pool operation must be explicit.
    query.provider = this.provider;
    const entries = Object.entries(query)
      .filter(([, value]) => value !== undefined && value !== null && String(value) !== '')
      .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
    if (!entries.length) return path;
    return `${path}${path.includes('?') ? '&' : '?'}${entries.join('&')}`;
  }

  aliasDomainPayload(options = {}) {
    const mode = text(options.aliasDomainMode || options.domainMode || this.aliasDomainMode || 'random').toLowerCase();
    if (!['random', 'selected'].includes(mode)) {
      throw providerError('alias domains', `unsupported domain mode: ${mode}`, {}, this.provider);
    }
    return {
      domain_mode: mode,
      domains: normalizeAliasDomains(options.aliasDomains || options.domains || this.aliasDomains),
    };
  }

  setAliasDomains(domains) {
    this.aliasDomains = normalizeAliasDomains(domains);
    return [...this.aliasDomains];
  }

  async request(method, path, body, options = {}) {
    if (!this.adminToken) {
      throw providerError('request', 'mail admin token is not configured', {
        code: 'MAIL_PROVIDER_NOT_CONFIGURED',
        statusCode: 503,
        retryable: false,
      }, this.provider);
    }
    const headers = {
      Accept: 'application/json',
      'X-Admin-Token': this.adminToken,
    };
    const init = { method, headers, redirect: 'manual' };
    if (options.signal) init.signal = options.signal;
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let response;
    try {
      response = await this.fetch(`${this.baseUrl}${this.providerPath(path, options)}`, init);
    } catch (error) {
      throw providerError(`${method} ${path}`, error.message, {
        code: 'MAIL_PROVIDER_UNAVAILABLE',
        statusCode: 503,
        retryable: true,
        cause: error,
      }, this.provider);
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
      const code = detailObject?.code
        ? String(detailObject.code)
        : 'MAIL_PROVIDER_HTTP_ERROR';
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
        retryable,
        ...(Number.isFinite(Number(detailObject?.retryAfterMs))
          ? { retryAfterMs: Number(detailObject.retryAfterMs) }
          : {}),
        publicDetails: {
          code,
          provider: this.provider,
          action: `${method} ${path}`,
          upstreamStatus: response.status,
          retryable,
          ...(detailObject?.category ? { category: String(detailObject.category) } : {}),
          ...(detailObject?.stage ? { stage: String(detailObject.stage) } : {}),
          ...(Number.isFinite(Number(detailObject?.retryAfterMs))
            ? { retryAfterMs: Number(detailObject.retryAfterMs) }
            : {}),
        },
      }, this.provider);
    }
    return json;
  }

  async checkAuth() {
    return this.request('GET', '/api/health');
  }

  async summary() {
    return assertProviderResult(await this.request('GET', '/api/summary'), 'summary', this.provider, { requireProvider: true });
  }

  async listAccounts() {
    const result = assertProviderResult(await this.request('GET', '/api/pool/accounts'), 'pool accounts', this.provider, { requireProvider: true });
    // The same response already carries the pool's own counts, and throwing
    // them away is why a shortfall could only ever be reported as a bare
    // "not enough mailboxes". Keep them for the preflight card and for the
    // error an exhausted pool raises.
    if (result && typeof result === 'object' && !Array.isArray(result) && result.summary) {
      this.lastPoolSummary = result.summary;
    }
    return Array.isArray(result) ? result : (result.accounts || []);
  }

  /**
   * One master at a time, so an import can report progress.
   *
   * `/api/masters/bulk` imports every line and then builds every alias batch
   * inside a single request, which is why the dialog could only sit and spin:
   * there is nothing to report until the whole thing returns. This endpoint
   * does the same work for one account, so the caller owns the loop and knows
   * where it is.
   */
  async addMaster(email, password, options = {}) {
    return this.request('POST', '/api/masters', {
      email: String(email),
      password: String(password),
      count: Math.max(1, Number(options.count || this.aliasBatchSize || 9)),
      ...this.aliasDomainPayload(options),
    });
  }

  async importMasters(content, options = {}) {
    const count = Math.max(1, Number(options.count || this.aliasBatchSize || 9));
    return this.request('POST', '/api/masters/bulk', {
      content,
      count,
      ...this.aliasDomainPayload(options),
    });
  }

  async ensurePool(count = this.aliasBatchSize, options = {}) {
    return this.request('POST', '/api/pool/ensure', {
      count,
      ...this.aliasDomainPayload(options),
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
      alias_count: Math.max(1, Number(options.aliasCount || this.aliasBatchSize || 9)),
      ...this.aliasDomainPayload(options),
    });
  }

  async listAliasDomains(options = {}) {
    const result = assertProviderResult(await this.request('GET', '/api/aliases/domains', undefined, {
      query: { email: options.email || '' },
    }), 'alias domains', this.provider, { requireProvider: true });
    if (this.provider !== 'fastmail' || !result || typeof result !== 'object' || Array.isArray(result)) return result;
    // Fastmail exposes candidateDomains before a per-master availability probe
    // has populated catalogDomains. Keep both fields, but add the canonical
    // `domains` view consumed by the main project's domain picker and preflight.
    const catalog = normalizeAliasDomains(result.catalogDomains || result.catalog_domains);
    const candidates = normalizeAliasDomains(result.candidateDomains || result.candidate_domains);
    const domains = catalog.length ? catalog : candidates;
    return {
      ...result,
      domains,
      availableDomains: domains,
      selectedDomains: normalizeAliasDomains(result.selectedDomains || this.aliasDomains),
      deniedDomains: normalizeAliasDomains(result.deniedDomains || result.denied_domains),
    };
  }

  // Whether a code actually arrived is only visible from this side, and the
  // pool needs it: it now draws from mail.com's whole live domain catalogue,
  // and a domain that stops delivering has to demote itself on this evidence.
  async reportDelivery(address, delivered, reason = '') {
    return this.request('POST', '/api/aliases/delivery', {
      address: String(address || ''),
      delivered: Boolean(delivered),
      ...(reason ? { reason: String(reason) } : {}),
    });
  }

  async snapshotMailbox(mailboxId, options = {}) {
    // The 8001 snapshot endpoint accepts only the mailbox id and owns its
    // server-side message window. Sending the old client-side `limit` field
    // made this request depend on Pydantic's extra-field behavior.
    return this.request('POST', '/api/pool/snapshot', { id: String(mailboxId) });
  }

  async findVerificationCode(mailboxId, options = {}) {
    const maxWaitMs = Number(options.maxWaitMs || 5000);
    const maxWait = Math.max(1, Math.min(60, Math.ceil(maxWaitMs / 1000)));
    const recipient = text(options.recipient);
    const excludeMessageIds = Array.isArray(options.excludeMessageIds) ? options.excludeMessageIds : [];
    const request = {
      mailbox_id: String(mailboxId),
      max_wait: maxWait,
      poll_interval: 1,
      match_subjects: options.keyword ? [options.keyword] : undefined,
      // The address itself, not just the intent to filter by one. Registration
      // uses an alias while delivery lands in the root inbox, so the provider
      // must receive the alias even though the mailbox is opened by id.
      email: recipient || undefined,
      match_recipient: Boolean(recipient),
      since: options.since || undefined,
      exclude_message_ids: excludeMessageIds,
    };
    const result = await this.request('POST', '/api/otp/fetch', request, { signal: options.signal });
    // A poll that finds nothing is the failure mode worth explaining: whether
    // the server saw messages and filtered them all out, or saw none at all, is
    // the difference between a bad filter and mail that never arrived. The
    // answer was being thrown away with the rest of the response.
    this.lastOtpFetch = {
      at: new Date(this.now()).toISOString(),
      mailboxId: String(mailboxId),
      recipient,
      matchSubjects: request.match_subjects || null,
      since: request.since || '',
      sentAt: text(options.since),
      excluded: request.exclude_message_ids.length,
      found: Boolean(result.otp),
      checkedEmails: Number(result.checked_emails ?? result.checkedEmails ?? 0) || 0,
      // Only present on an empty poll: how many messages the mailbox held and
      // which filter rejected each one.
      listed: Number(result.listed ?? 0) || 0,
      dropped: result.dropped && typeof result.dropped === 'object' ? result.dropped : null,
      sample: Array.isArray(result.sample) ? result.sample : null,
      misses: Array.isArray(result.misses) ? result.misses : null,
      // Matching mail the same inbox received for *other* addresses inside this
      // wait window. Non-zero with `checkedEmails: 0` is the one observation
      // that separates a broken mail path from an address that simply was not
      // delivered to — every other counter looks identical in both cases.
      siblings: result.siblings && typeof result.siblings === 'object'
        ? {
          count: Number(result.siblings.count || 0) || 0,
          recipients: Array.isArray(result.siblings.recipients) ? result.siblings.recipients : [],
          latestAt: text(result.siblings.latest_at || result.siblings.latestAt),
        }
        : null,
      // Folders whose listing came back full: the provider pages at 100 with no
      // continuation, so a real message could be sitting just past the edge.
      pageFull: Array.isArray(result.pageFull) ? result.pageFull : [],
      inbox: text(result.email),
      subject: text(result.subject),
      sender: text(result.sender),
      source: text(result.source),
    };
    this.lastOtpFetchByMailbox.set(String(mailboxId), this.lastOtpFetch);
    while (this.lastOtpFetchByMailbox.size > 256) {
      const oldest = this.lastOtpFetchByMailbox.keys().next().value;
      if (oldest === undefined) break;
      this.lastOtpFetchByMailbox.delete(oldest);
    }
    if (!result.otp) return null;
    return {
      code: String(result.otp),
      messageId: result.messageId || `${result.email}:${result.checked_emails || 0}`,
      consumedMessageId: result.messageId || '',
      sender: result.sender || '',
      subject: result.subject || '',
      receivedAt: result.receivedAt || new Date(this.now()).toISOString(),
      folder: 'INBOX',
      source: result.source || 'mailcom_web',
    };
  }

  lastOtpDiagnostics(mailboxId) {
    return this.lastOtpFetchByMailbox.get(String(mailboxId)) || null;
  }

  async randomUnbound() {
    const rows = await this.listAccounts();
    return rows.find((row) => row.status === 'available' && row.bound !== true) || null;
  }
}

module.exports = {
  MailcomClient,
};
