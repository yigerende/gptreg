'use strict';

const { extractEmailOtp } = require('./email-otp');
const { tryParseJson } = require('./http-shape');

const MAIL_RECEIVED_CLOCK_SKEW_MS = 120000;

function cookieHeader(cookies) {
  return Object.entries(cookies || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function parseSetCookie(value) {
  const first = String(value || '').split(';', 1)[0];
  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  return { name: first.slice(0, eq), value: first.slice(eq + 1) };
}

function updateCookiesFromHeaders(cookies, headers) {
  const next = { ...(cookies || {}) };
  const values = typeof headers?.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers?.get?.('set-cookie')].filter(Boolean);
  for (const value of values) {
    const parsed = parseSetCookie(value);
    if (parsed) next[parsed.name] = parsed.value;
  }
  return next;
}

function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) || '';
  const target = String(name).toLowerCase();
  const key = Object.keys(headers).find((item) => item.toLowerCase() === target);
  return key ? headers[key] : '';
}

function parseRetryAfterMs(value, nowMs = Date.now()) {
  const retryAfter = String(value || '').trim();
  if (!retryAfter) return 0;
  if (/^\d+(?:\.\d+)?$/.test(retryAfter)) {
    return Math.max(0, Math.ceil(Number(retryAfter) * 1000));
  }
  const timestamp = Date.parse(retryAfter);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - nowMs) : 0;
}

function mailItems(result) {
  return Array.isArray(result) ? result : (result?.messages || result?.mail || []);
}

function messageIdOf(message) {
  const value = message?.id ?? message?.messageId ?? message?.internetMessageId;
  return value === undefined || value === null ? '' : String(value);
}

function exclusionSet(value) {
  if (value instanceof Set) return new Set([...value].map(String));
  if (Array.isArray(value)) return new Set(value.map(String));
  return new Set();
}

function finiteNonNegative(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function normalizedFolders(value, fallback = ['inbox']) {
  const folders = Array.isArray(value) && value.length ? value : fallback;
  return [...new Set(folders.map((folder) => String(folder).trim()).filter(Boolean))];
}

function unsupportedMailFoldersEndpoint(error) {
  return [404, 405].includes(Number(error?.status));
}

function isRetryableMailError(error) {
  if (String(error?.code || '').toUpperCase() === 'IMAP_AUTH_FAILED') return false;
  if (error?.retryable === false) return false;
  if (error?.retryable === true) return true;
  const status = Number(error?.status || 0);
  if (status === 429 || (status >= 500 && status <= 599)) return true;
  if (status !== 409) return false;
  const message = String(error?.response?.error || error?.response?.message || error?.message || '').toLowerCase();
  return message.includes('refresh busy') || message.includes('refresh is already in progress');
}

function batchFolderErrors(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value).map(([folder, detail]) => {
    const status = Number(detail?.status || 0);
    const message = String(detail?.error || detail?.message || 'folder unavailable');
    const error = new Error(`xiaopingguo mail-folders ${folder} failed: ${message}`);
    error.status = status;
    error.response = { error: message, folder };
    error.retryAfterMs = finiteNonNegative(detail?.retryAfter, 0) * 1000;
    return error;
  });
}

class XiaopingguoClient {
  constructor(options = {}) {
    this.mailProvider = 'xiaopingguo';
    this.baseUrl = String(options.baseUrl || 'http://127.0.0.1:8000').replace(/\/+$/, '');
    this.origin = options.origin || this.baseUrl;
    this.fetch = options.fetch || globalThis.fetch;
    this.csrfToken = options.csrfToken || '';
    this.cookies = { ...(options.cookies || {}) };
    this.now = options.now || Date.now;
    this.sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.mailFolderBatchSupport = options.mailFolderBatchSupport === false ? false : null;
    this.mailFolderFlights = new Map();
    this.lastOtpFetchByMailbox = new Map();
  }

  // Keep the authenticated session, but isolate mutable caches per run.
  fork() {
    return new XiaopingguoClient({
      baseUrl: this.baseUrl,
      origin: this.origin,
      fetch: this.fetch,
      csrfToken: this.csrfToken,
      cookies: { ...this.cookies },
      now: this.now,
      sleep: this.sleep,
      mailFolderBatchSupport: this.mailFolderBatchSupport,
    });
  }

  async request(method, path, options = {}) {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const headers = {
      Accept: 'application/json',
      ...(options.headers || {}),
    };
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const cookie = cookieHeader(this.cookies);
    if (cookie) headers.Cookie = cookie;
    if (method !== 'GET') {
      headers.Origin = this.origin;
      if (this.csrfToken) headers['X-CSRF-Token'] = this.csrfToken;
    }

    const response = await this.fetch(url, {
      method,
      headers,
      body,
      redirect: 'manual',
    });
    this.cookies = updateCookiesFromHeaders(this.cookies, response.headers);
    const text = await response.text();
    const json = tryParseJson(text) || {};
    if (response.status >= 400) {
      const message = json.error || json.message || `HTTP ${response.status}`;
      const error = new Error(`xiaopingguo ${method} ${path} failed: ${message}`);
      error.status = response.status;
      error.response = json;
      error.retryAfterMs = parseRetryAfterMs(headerValue(response.headers, 'retry-after'), this.now());
      throw error;
    }
    return { status: response.status, json, text, headers: response.headers };
  }

  async login(password) {
    const result = await this.request('POST', '/api/login', { body: { password } });
    this.csrfToken = result.json.csrfToken || this.csrfToken;
    return result.json;
  }

  async checkAuth() {
    return (await this.request('GET', '/api/check-auth')).json;
  }

  async listAccounts() {
    return (await this.request('GET', '/api/accounts')).json;
  }

  async randomUnbound() {
    return (await this.request('POST', '/api/accounts/random-unbound', { body: {} })).json.account;
  }

  async revealAccount(accountId) {
    return (await this.request('POST', `/api/accounts/${accountId}/reveal`, { body: {} })).json;
  }

  async listMail(accountId, options = {}) {
    return (await this.request('POST', `/api/accounts/${accountId}/mail`, {
      body: {
        folder: options.folder || 'inbox',
        limit: options.limit || 20,
      },
    })).json;
  }

  async listMailFolders(accountId, options = {}) {
    const folders = normalizedFolders(options.folders);
    const limit = options.limit || options.maxResults || 20;
    const flightKey = `${accountId}:${limit}:${folders.join(',')}`;
    const active = this.mailFolderFlights.get(flightKey);
    if (active) return active;

    const operation = this.#listMailFolders(accountId, folders, limit);
    this.mailFolderFlights.set(flightKey, operation);
    try {
      return await operation;
    } finally {
      if (this.mailFolderFlights.get(flightKey) === operation) {
        this.mailFolderFlights.delete(flightKey);
      }
    }
  }

  async #listMailFolders(accountId, folders, limit) {
    if (this.mailFolderBatchSupport !== false) {
      try {
        const response = await this.request('POST', `/api/accounts/${accountId}/mail-folders`, {
          body: { folders, limit },
        });
        const result = response.json?.folders;
        if (!result || typeof result !== 'object' || Array.isArray(result)) {
          throw Object.assign(new Error('xiaopingguo mail-folders returned an invalid response'), {
            code: 'XIAOPINGGUO_INVALID_MAIL_FOLDERS',
          });
        }
        this.mailFolderBatchSupport = true;
        return {
          folders: Object.fromEntries(folders.map((folder) => [folder, mailItems(result[folder])])),
          errors: batchFolderErrors(response.json?.errors),
          source: 'mail-folders',
        };
      } catch (error) {
        if (!unsupportedMailFoldersEndpoint(error)) throw error;
        this.mailFolderBatchSupport = false;
      }
    }

    const result = {};
    const errors = [];
    for (const folder of folders) {
      try {
        result[folder] = mailItems(await this.listMail(accountId, { folder, limit }));
      } catch (error) {
        result[folder] = [];
        errors.push(error);
      }
    }
    return { folders: result, errors, source: 'legacy-mail' };
  }

  async snapshotMailbox(accountId, options = {}) {
    const folders = normalizedFolders(options.folders, ['inbox', 'junkemail']);
    const messageIds = new Set();
    const result = await this.listMailFolders(accountId, {
      folders,
      limit: options.limit || 20,
    });
    for (const folder of folders) {
      for (const message of result.folders[folder] || []) {
        const messageId = messageIdOf(message);
        if (messageId) messageIds.add(messageId);
      }
    }
    if (result.errors.length) throw result.errors[0];
    return {
      messageIds: [...messageIds],
      capturedAt: new Date(this.now()).toISOString(),
    };
  }

  async verifyCode(accountId, options = {}) {
    if (options.recipient || options.since || options.folders || options.excludeMessageIds) {
      const found = await this.findVerificationCode(accountId, options);
      if (found) return found;
      const error = new Error('xiaopingguo filtered verification code not found');
      error.status = 404;
      error.response = { error: 'not found' };
      throw error;
    }
    const body = {
      maxResults: options.maxResults || 20,
    };
    if (options.keyword) body.keyword = options.keyword;
    return (await this.request('POST', `/api/accounts/${accountId}/verify-code`, { body })).json;
  }

  async findVerificationCode(accountId, options = {}) {
    const folders = normalizedFolders(options.folders);
    const messages = [];
    const result = await this.listMailFolders(accountId, {
      folders,
      limit: options.maxResults || options.limit || 20,
    });
    for (const folder of folders) {
      for (const item of result.folders[folder] || []) messages.push({ ...item, folder });
    }

    const sinceMs = options.since ? Date.parse(options.since) : 0;
    const receivedAfterMs = sinceMs ? sinceMs - MAIL_RECEIVED_CLOCK_SKEW_MS : 0;
    const recipient = String(options.recipient || '').toLowerCase();
    const keyword = String(options.keyword || '').toLowerCase();
    const excluded = exclusionSet(options.excludeMessageIds);

    const recent = messages
      .filter((message) => !excluded.has(messageIdOf(message)))
      .filter((message) => !receivedAfterMs || Date.parse(message.date || message.receivedDateTime || message.createdDateTime || 0) >= receivedAfterMs)
      .filter((message) => !keyword || messageText(message).toLowerCase().includes(keyword));
    const ordered = recent
      .filter((message) => !recipient || messageMatchesRecipient(message, recipient))
      .sort((a, b) => Date.parse(b.date || b.receivedDateTime || 0) - Date.parse(a.date || a.receivedDateTime || 0));
    const diagnostics = { mailboxId: String(accountId), recipient, listed: recent.length, checkedEmails: ordered.length, found: false };
    this.lastOtpFetchByMailbox.set(String(accountId), diagnostics);
    while (this.lastOtpFetchByMailbox.size > 256) this.lastOtpFetchByMailbox.delete(this.lastOtpFetchByMailbox.keys().next().value);

    for (const message of ordered) {
      const code = extractVerificationCode(messageText(message));
      if (!code) continue;
      diagnostics.found = true;
      const messageId = messageIdOf(message);
      return {
        code,
        messageId,
        consumedMessageId: messageId,
        sender: message.sender || message.from || '',
        subject: message.subject || '',
        receivedAt: message.date || message.receivedDateTime || '',
        folder: message.folder,
        source: 'mail_filter',
      };
    }
    if (result.errors.length) throw result.errors[0];
    return null;
  }

  async pollVerifyCode(accountId, options = {}) {
    const timeoutMs = finiteNonNegative(options.timeoutMs, 120000);
    const pollIntervalMs = finiteNonNegative(options.pollIntervalMs, 5000);
    const maxBackoffMs = finiteNonNegative(options.maxBackoffMs, 30000);
    const maxServerErrorRetries = Math.floor(finiteNonNegative(options.maxServerErrorRetries, 3));
    const started = this.now();
    const deadline = started + timeoutMs;
    let lastError = null;
    let consecutiveServerErrors = 0;
    while (this.now() <= deadline) {
      let delayMs = pollIntervalMs;
      try {
        return await this.verifyCode(accountId, options);
      } catch (error) {
        if (error.status >= 500 && error.status <= 599) {
          consecutiveServerErrors += 1;
          if (consecutiveServerErrors > maxServerErrorRetries) throw error;
          const backoffMs = Math.min(maxBackoffMs, pollIntervalMs * (2 ** (consecutiveServerErrors - 1)));
          delayMs = Math.max(backoffMs, error.retryAfterMs || 0);
        } else if (error.status === 404 || isRetryableMailError(error)) {
          consecutiveServerErrors = 0;
          delayMs = Math.max(pollIntervalMs, error.retryAfterMs || 0);
        } else {
          throw error;
        }
        lastError = error;
      }
      const remainingMs = deadline - this.now();
      if (remainingMs <= 0) break;
      await this.sleep(Math.min(delayMs, remainingMs));
    }
    const error = new Error('Timed out waiting for xiaopingguo verification code');
    error.cause = lastError;
    throw error;
  }

  async markBound(accountId, bound = true) {
    return (await this.request('PATCH', `/api/accounts/${accountId}`, { body: { bound } })).json;
  }

  async reserveMailbox(accountId) {
    return this.markBound(accountId, true);
  }

  async releaseMailbox(accountId) {
    return this.markBound(accountId, false);
  }
}

function messageText(message = {}) {
  return [
    message.subject,
    message.sender,
    message.from,
    message.to,
    message.bodyPreview,
    message.text,
    message.html,
    typeof message.body === 'string' ? message.body : message.body?.content,
  ].filter(Boolean).join('\n');
}

function recipientValues(message = {}) {
  const values = [];
  for (const key of ['to', 'recipient', 'recipients']) {
    const value = message[key];
    if (typeof value === 'string') values.push(value);
    if (Array.isArray(value)) values.push(...value.map((item) => typeof item === 'string' ? item : item.email || item.address || item.emailAddress?.address || ''));
  }
  for (const key of ['toRecipients', 'ccRecipients']) {
    const value = message[key];
    if (Array.isArray(value)) values.push(...value.map((item) => item.email || item.address || item.emailAddress?.address || ''));
  }
  return values.filter(Boolean).map((value) => String(value).toLowerCase());
}

function messageMatchesRecipient(message, recipient) {
  const values = recipientValues(message);
  if (values.length === 0) return true;
  return values.some((value) => value === recipient || value.includes(`<${recipient}>`));
}

function extractVerificationCode(text) {
  return extractEmailOtp(text);
}

module.exports = {
  XiaopingguoClient,
  extractVerificationCode,
  isRetryableMailError,
};
