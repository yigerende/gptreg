'use strict';

/**
 * Client for the nvtokens member inventory API.
 *
 * The public schema endpoints describe the three write endpoints used here:
 * cards/import, mailboxes/import and cards/pool. The API key must stay on the
 * server, so the browser talks to the UI server and never to nvtokens directly.
 */

const DEFAULT_BASE_URL = 'https://nvtokens.com';
const DEFAULT_TIMEOUT_MS = 30000;

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL)
    .trim()
    .replace(/\/api\/inventory\/(?:cards\/import|mailboxes\/import|cards\/pool)\/schema\/?$/i, '')
    .replace(/\/api\/inventory\/(?:cards\/import|mailboxes\/import|cards\/pool)\/?$/i, '')
    .replace(/\/+$/, '');
}

function numeric(value) {
  if (
    typeof value === 'boolean'
    || value === null
    || value === undefined
    || value === ''
    || typeof value === 'object'
  ) return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function countValue(value) {
  return Array.isArray(value) ? value.length : numeric(value);
}

function messageText(value) {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  for (const key of ['message', 'detail', 'error', 'reason', 'description', 'code']) {
    const message = messageText(value[key]);
    if (message) return message;
  }
  return '';
}

function firstCount(sources, names) {
  for (const source of sources) {
    for (const name of names) {
      const value = countValue(source?.[name]);
      if (value !== undefined) return value;
    }
  }
  return undefined;
}

function messages(sources, names) {
  const output = [];
  const seen = new Set();
  for (const source of sources) {
    for (const name of names) {
      const value = source?.[name];
      const entries = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
      for (const entry of entries) {
        const message = messageText(entry);
        if (message && !seen.has(message)) {
          seen.add(message);
          output.push(message);
        }
      }
    }
  }
  return output;
}

function responseHeader(response, name) {
  try {
    if (typeof response?.headers?.get === 'function') return String(response.headers.get(name) || '').trim();
    const value = response?.headers?.[name] ?? response?.headers?.[name.toLowerCase()];
    return String(value || '').trim();
  } catch {
    return '';
  }
}

function responseRequestId(payload) {
  const sources = [payload, payload?.data, payload?.summary, payload?.error]
    .filter((value) => value && typeof value === 'object' && !Array.isArray(value));
  for (const source of sources) {
    for (const name of ['request_id', 'requestId', 'request-id']) {
      const value = String(source?.[name] || '').trim();
      if (value) return value;
    }
  }
  return '';
}

async function readResponsePayload(response) {
  if (typeof response?.text === 'function') {
    try {
      const text = await response.text();
      if (!String(text || '').trim()) return {};
      try {
        return JSON.parse(text);
      } catch {
        return String(text);
      }
    } catch {
      // Fall through to JSON-only test doubles and older fetch shims.
    }
  }
  if (typeof response?.json === 'function') {
    try { return await response.json(); } catch { return {}; }
  }
  return {};
}

/**
 * Normalize the response without assuming one particular nvtokens deployment
 * response shape. HTTP 2xx is the transport success signal; deployments may
 * report the accepted count as imported, accepted, pooled or published.
 */
function summarizeNvtokensResponse(payload, requested = 0) {
  const sources = [payload, payload?.data, payload?.summary, payload?.result, payload?.stats]
    .filter((value) => value && typeof value === 'object' && !Array.isArray(value));
  const failed = firstCount(sources, [
    'failed',
    'failure_count',
    'failed_count',
    'rejected',
    'rejected_count',
    'unmatched',
    'invalid',
  ]) ?? 0;
  const skipped = firstCount(sources, ['skipped', 'skipped_count', 'duplicate', 'duplicates']) ?? 0;
  const reportedAccepted = firstCount(sources, [
    'accepted',
    'accepted_count',
    'imported',
    'imported_count',
    'created',
    'created_count',
    'pooled',
    'pooled_count',
    'published',
    'published_count',
    'success_count',
    'matched',
    'updated',
    'unchanged',
    'returned_to_personal_inventory',
  ]);
  const total = firstCount(sources, ['total', 'processed', 'count', 'cards', 'mailboxes']) ?? Number(requested || 0);
  const accepted = reportedAccepted ?? Math.max(0, total - failed - skipped);
  const errors = messages(sources, [
    'errors',
    'failures',
    'rejected',
    'rejected_items',
    'invalid_details',
    'unmatched_details',
    'invalid',
  ]);
  const warnings = messages(sources, ['warnings', 'warning']);
  const ok = sources.every((source) => source.ok !== false && source.success !== false);
  return {
    ok,
    total,
    accepted: Math.max(0, accepted),
    failed: Math.max(0, failed),
    skipped: Math.max(0, skipped),
    errors,
    warnings,
  };
}

class NvtokensError extends Error {
  constructor(message, { status = 0, code = 'NVTOKENS_ERROR', requestId = '', cause } = {}) {
    super(message);
    this.name = 'NvtokensError';
    this.status = status;
    this.code = code;
    this.requestId = String(requestId || '').trim();
    if (cause) this.cause = cause;
  }
}

class NvtokensClient {
  constructor(options = {}) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.apiKey = String(options.apiKey || '').trim();
    this.timeoutMs = Number(options.requestTimeoutMs || DEFAULT_TIMEOUT_MS);
    this.fetchImpl = options.fetch || globalThis.fetch;
  }

  url(path) {
    return `${this.baseUrl}${String(path).startsWith('/') ? path : `/${path}`}`;
  }

  async request(path, { body, timeoutMs } = {}) {
    if (!this.apiKey) {
      throw new NvtokensError('未配置 nvtokens 会员库存 API Key（nvtokens.apiKey）', { code: 'NVTOKENS_UNCONFIGURED' });
    }
    const budget = Number(timeoutMs || this.timeoutMs);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);
    let response;
    try {
      response = await this.fetchImpl(this.url(path), {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw new NvtokensError(
        error?.name === 'AbortError'
          ? `nvtokens 无响应（${budget}ms 超时）：${this.baseUrl}`
          : `无法连接 nvtokens 服务：${this.baseUrl}`,
        { code: 'NVTOKENS_OFFLINE', cause: error },
      );
    } finally {
      clearTimeout(timer);
    }

    const payload = await readResponsePayload(response);
    if (!response.ok) {
      const sources = [payload, payload?.data].filter((value) => value && typeof value === 'object');
      const detail = messages(sources, ['message', 'detail', 'error', 'reason', 'errors', 'failures', 'rejected', 'invalid']).join('；')
        || messageText(payload)
        || (response.status === 403
          ? '平台拒绝请求（权限或账号入池条件未通过）'
          : `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`);
      const requestId = responseHeader(response, 'x-request-id') || responseRequestId(payload);
      throw new NvtokensError(
        detail,
        {
          status: response.status,
          code: response.status === 401 ? 'NVTOKENS_UNAUTHORIZED' : 'NVTOKENS_REJECTED',
          requestId,
        },
      );
    }
    return payload;
  }

  importCards(body) {
    return this.request('/api/inventory/cards/import', { body });
  }

  importMailboxes(body) {
    return this.request('/api/inventory/mailboxes/import', { body });
  }

  poolCards(body) {
    return this.request('/api/inventory/cards/pool', { body });
  }
}

module.exports = {
  NvtokensClient,
  NvtokensError,
  normalizeBaseUrl,
  summarizeNvtokensResponse,
};
