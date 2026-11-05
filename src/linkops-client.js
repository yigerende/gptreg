'use strict';

/**
 * HTTP client for the external LinkOps workbench.
 *
 * LinkOps owns checkout-link extraction and PayPal payment since those engines
 * were removed from this repo. This module is deliberately thin: it speaks the
 * versioned `/api/v1` surface and translates transport and HTTP failures into
 * one error shape, so callers never have to tell a dead service apart from a
 * rejected payload by inspecting `fetch` internals.
 */

const DEFAULT_BASE_URL = 'http://127.0.0.1:8082';
const DEFAULT_TIMEOUT_MS = 20000;

class LinkOpsError extends Error {
  constructor(message, { status = 0, code = 'LINKOPS_ERROR', cause } = {}) {
    super(message);
    this.name = 'LinkOpsError';
    this.status = status;
    this.code = code;
    if (cause) this.cause = cause;
  }
}

/** True when the service is simply not running, as opposed to refusing a call. */
function isOfflineError(error) {
  return error instanceof LinkOpsError && error.code === 'LINKOPS_OFFLINE';
}

class LinkOpsClient {
  constructor(options = {}) {
    this.baseUrl = String(options.baseUrl || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
    this.timeoutMs = Number(options.requestTimeoutMs || DEFAULT_TIMEOUT_MS);
    this.fetchImpl = options.fetch || globalThis.fetch;
  }

  url(path) {
    return `${this.baseUrl}/api/v1${path.startsWith('/') ? path : `/${path}`}`;
  }

  async request(path, { method = 'GET', body, timeoutMs } = {}) {
    const controller = new AbortController();
    const budget = Number(timeoutMs || this.timeoutMs);
    const timer = setTimeout(() => controller.abort(), budget);
    let response;
    try {
      response = await this.fetchImpl(this.url(path), {
        method,
        signal: controller.signal,
        ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
      });
    } catch (error) {
      // A refused connection and an abort both mean "no service answered".
      // Callers surface this as "未启动" rather than as a failed operation.
      throw new LinkOpsError(
        error?.name === 'AbortError'
          ? `LinkOps 无响应（${budget}ms 超时）：${this.baseUrl}`
          : `无法连接 LinkOps 服务：${this.baseUrl}`,
        { code: 'LINKOPS_OFFLINE', cause: error },
      );
    } finally {
      clearTimeout(timer);
    }

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = payload?.detail || payload?.message || payload?.error || `HTTP ${response.status}`;
      throw new LinkOpsError(typeof detail === 'string' ? detail : JSON.stringify(detail), {
        status: response.status,
        code: 'LINKOPS_REJECTED',
      });
    }
    return payload;
  }

  health() { return this.request('/health'); }

  modules() { return this.request('/modules'); }

  /** One job per token; the service expands the batch and binds proxies itself. */
  createJob({ domain, provider, input = {}, options = {} } = {}) {
    return this.request('/jobs', { method: 'POST', body: { domain, provider, input, options } });
  }

  listJobs({ domain = '', provider = '', status = '', limit = 200 } = {}) {
    const params = new URLSearchParams();
    if (domain) params.set('domain', domain);
    if (provider) params.set('provider', provider);
    if (status) params.set('status', status);
    if (limit) params.set('limit', String(limit));
    const query = params.toString();
    return this.request(`/jobs${query ? `?${query}` : ''}`);
  }

  job(jobId) { return this.request(`/jobs/${encodeURIComponent(jobId)}`); }

  cancelJob(jobId) { return this.request(`/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST', body: {} }); }

  retryJob(jobId) { return this.request(`/jobs/${encodeURIComponent(jobId)}/retry`, { method: 'POST', body: {} }); }

  deleteJob(jobId) { return this.request(`/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' }); }

  /**
   * Clears finished jobs. The engine refuses to delete an active job, and
   * reports those back in `blocked` rather than failing the whole call.
   */
  batchDeleteJobs(jobIds = []) {
    return this.request('/jobs/batch-delete', { method: 'POST', body: { jobIds: jobIds.map((id) => String(id)) } });
  }

  /** Answers an `awaiting_input` job — the OTP or replacement phone it asked for. */
  submitInput(jobId, value) {
    return this.request(`/jobs/${encodeURIComponent(jobId)}/input`, { method: 'POST', body: { value: String(value ?? '') } });
  }

  // Proxy pools are pulled by the engine from its own upstream source; a caller
  // can inspect, re-pull, test one entry, or clear — never upload a list.
  proxyPool(provider, country, role = 'checkout') {
    return this.request(`/proxy-pools/${encodeURIComponent(provider)}/${encodeURIComponent(country)}?role=${encodeURIComponent(role)}`);
  }

  refreshProxyPool(provider, country, role = 'checkout') {
    return this.request(`/proxy-pools/${encodeURIComponent(provider)}/${encodeURIComponent(country)}/refresh?role=${encodeURIComponent(role)}`, { method: 'POST', body: {}, timeoutMs: 60000 });
  }

  preflightProxyPool(provider, country, role = 'checkout', index = -1) {
    return this.request(`/proxy-pools/${encodeURIComponent(provider)}/${encodeURIComponent(country)}/preflight?role=${encodeURIComponent(role)}`, { method: 'POST', body: { index: Number(index) }, timeoutMs: 60000 });
  }

  clearProxyPool(provider, country, role = 'checkout') {
    return this.request(`/proxy-pools/${encodeURIComponent(provider)}/${encodeURIComponent(country)}?role=${encodeURIComponent(role)}`, { method: 'DELETE' });
  }

  /** The durable extracted-link ledger, independent of the jobs table. */
  extractedLinks(limit = 200) { return this.request(`/exports/links?limit=${encodeURIComponent(limit)}`); }
}

module.exports = { LinkOpsClient, LinkOpsError, isOfflineError, DEFAULT_LINKOPS_BASE_URL: DEFAULT_BASE_URL };
