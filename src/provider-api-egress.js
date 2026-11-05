'use strict';

const { executePureHttpUrl } = require('./pure-url');

/**
 * Egress for the SMS vendor's API (SMSBower SMS and SMSBower mail).
 *
 * Those calls used to go out with Node's bare `fetch`, so where they actually
 * left from was whatever the machine's routing decided, and a single local
 * forwarder — one exit IP — took every request of a 20-Worker run. When that
 * exit got throttled, every claim, poll and status call timed out together.
 *
 * Requests use only explicitly configured forwarders; otherwise they go direct.
 * The current forwarder keeps serving until it fails
 * `failoverAfter` times in a row; then traffic moves to the next and the
 * rotation continues around the list. A forwarder that refuses the connection
 * outright is skipped at once and the request is retried on the next one,
 * because no request reached the vendor and nothing can have been duplicated.
 * A timeout is *not* retried here: the vendor may have acted on it, and the
 * callers already own their retry and idempotency rules.
 */

const DEFAULT_FAILOVER_AFTER = 2;
const DEFAULT_TIMEOUT_MS = 30_000;
// The forwarder itself is unreachable: nothing was sent upstream.
const CONNECT_FAILURE = /ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EADDRNOTAVAIL|Proxy socket closed before connect|Proxy socket timed out|proxy connect/i;

function uniqueProxies(list) {
  const seen = new Set();
  const out = [];
  for (const value of Array.isArray(list) ? list : []) {
    const url = String(value || '').trim();
    if (!url || seen.has(url.toLowerCase())) continue;
    seen.add(url.toLowerCase());
    out.push(url);
  }
  return out;
}

/**
 * The forwarders the vendor API should use, from `proxyPool`.
 *
 * An explicit `providerApiProxies` array wins (an empty one means "go
 * direct"). Otherwise use explicitly configured `apiRequestProxy` and
 * `maintenanceProxy`, in that order. No desktop endpoint is invented.
 */
function providerApiProxiesFromConfig(config = {}) {
  const pool = config?.proxyPool || {};
  if (Array.isArray(pool.providerApiProxies)) return uniqueProxies(pool.providerApiProxies);
  const configured = uniqueProxies([pool.apiRequestProxy, pool.maintenanceProxy]);
  // No implicit desktop proxy on a server. Explicit providerApiProxies keeps
  // its existing meaning, including [] for direct access.
  return configured;
}

function headerBag(response = {}) {
  const values = {
    'content-type': response.contentType || '',
    location: response.location || '',
    date: response.serverDate || '',
    'retry-after': Number(response.retryAfterMs) > 0 ? String(Math.ceil(Number(response.retryAfterMs) / 1000)) : '',
  };
  return {
    get(name) {
      const value = values[String(name || '').toLowerCase()];
      return value ? value : null;
    },
  };
}

class RotatingProxyEgress {
  constructor(options = {}) {
    this.resolveProxies = typeof options.resolveProxies === 'function'
      ? options.resolveProxies
      : () => uniqueProxies(options.proxies);
    this.failoverAfter = Math.max(1, Number(options.failoverAfter) || DEFAULT_FAILOVER_AFTER);
    this.timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
    this.executor = options.executor || executePureHttpUrl;
    this.directFetch = options.directFetch || ((...args) => globalThis.fetch(...args));
    this.onSwitch = typeof options.onSwitch === 'function' ? options.onSwitch : null;
    this.index = 0;
    this.consecutiveFailures = 0;
    this.lastProxies = [];
    this.fetch = this.fetch.bind(this);
  }

  proxies() {
    const list = uniqueProxies(this.resolveProxies());
    // A config edit that changes the list starts the rotation from its head.
    if (list.join('\n') !== this.lastProxies.join('\n')) {
      this.lastProxies = list;
      this.index = 0;
      this.consecutiveFailures = 0;
    }
    return list;
  }

  current() {
    const list = this.proxies();
    return list.length ? list[this.index % list.length] : '';
  }

  status() {
    const list = this.proxies();
    return { proxies: list, current: list.length ? list[this.index % list.length] : '', consecutiveFailures: this.consecutiveFailures };
  }

  advance(reason) {
    const list = this.proxies();
    if (list.length < 2) {
      this.consecutiveFailures = 0;
      return;
    }
    const from = list[this.index % list.length];
    this.index = (this.index + 1) % list.length;
    this.consecutiveFailures = 0;
    const to = list[this.index];
    if (this.onSwitch) {
      try { this.onSwitch({ from, to, reason }); } catch { /* reporting must not break a request */ }
    }
  }

  recordFailure(proxy, reason) {
    if (proxy !== this.current()) return;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failoverAfter) this.advance(reason);
  }

  recordSuccess(proxy) {
    if (proxy === this.current()) this.consecutiveFailures = 0;
  }

  async once(proxy, url, init) {
    const result = await this.executor({
      index: -1025,
      method: String(init.method || 'GET').toUpperCase(),
      url: String(url),
      headers: { ...(init.headers || {}) },
      cookies: {},
      body: typeof init.body === 'string' ? init.body : '',
      contentType: '',
      redirect: '',
    }, {
      name: 'provider_api',
      proxy,
      timeoutMs: this.timeoutMs,
      signal: init.signal,
    });
    const response = result.response || {};
    const text = String(response.text || '');
    const status = Number(response.status || 0);
    return {
      ok: status >= 200 && status < 300,
      status,
      url: response.url || String(url),
      headers: headerBag(response),
      text: async () => text,
      json: async () => JSON.parse(text),
      viaProxy: proxy,
    };
  }

  async fetch(url, init = {}) {
    const list = this.proxies();
    if (!list.length) return this.directFetch(url, init);
    let attempts = 0;
    for (;;) {
      const proxy = this.current();
      attempts += 1;
      try {
        const response = await this.once(proxy, url, init);
        this.recordSuccess(proxy);
        return response;
      } catch (error) {
        // A caller's own timeout arrives as an abort, so an abort counts as a
        // failure too. A task stop can therefore count once against a healthy
        // forwarder; that costs at most one early switch, never a request.
        const message = String(error?.message || error || '');
        if (CONNECT_FAILURE.test(message) || CONNECT_FAILURE.test(String(error?.code || ''))) {
          // Nothing reached the vendor: move on now and try the next forwarder.
          if (proxy === this.current()) this.advance(`connect_failed: ${message.slice(0, 120)}`);
          if (attempts < list.length && !init.signal?.aborted) continue;
          throw error;
        }
        this.recordFailure(proxy, `request_failed: ${message.slice(0, 120)}`);
        throw error;
      }
    }
  }
}

let sharedEgress = null;

/**
 * The process-wide egress, so every SMSBower client agrees on which forwarder
 * is healthy. Until the console configures it (CLI runs, tests), clients keep
 * their plain `fetch`.
 */
function configureProviderApiEgress(options = {}) {
  sharedEgress = options ? new RotatingProxyEgress({
    onSwitch: ({ from, to, reason }) => {
      console.warn(`[gpt-re] SMS vendor API egress switched ${from} -> ${to} (${reason})`);
    },
    ...options,
  }) : null;
  return sharedEgress;
}

function providerApiFetch() {
  return sharedEgress ? sharedEgress.fetch : null;
}

function providerApiEgressStatus() {
  return sharedEgress ? sharedEgress.status() : null;
}

module.exports = {
  DEFAULT_FAILOVER_AFTER,
  RotatingProxyEgress,
  configureProviderApiEgress,
  providerApiEgressStatus,
  providerApiFetch,
  providerApiProxiesFromConfig,
};
