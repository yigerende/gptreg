'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PROXY_HEALTH_STATUSES = new Set(['unknown', 'checking', 'healthy', 'leased', 'failed']);

function stripInlineComment(line) {
  const hash = line.indexOf('#');
  return (hash === -1 ? line : line.slice(0, hash)).trim();
}

function normalizeProtocol(protocol) {
  const value = String(protocol || 'http').replace(/:$/, '').toLowerCase();
  if (value === 'socks') return 'socks5';
  if (value !== 'http' && value !== 'socks5') {
    throw new Error(`Unsupported proxy protocol: ${protocol}`);
  }
  return value;
}

function proxyUrlFromParts(parts, options = {}) {
  const protocol = normalizeProtocol(parts.protocol || options.defaultProtocol || 'http');
  const host = String(parts.host || '').trim();
  const port = String(parts.port || '').trim();
  if (!host || !port) throw new Error('Proxy entry requires host and port');

  const username = parts.username ? encodeURIComponent(parts.username) : '';
  const password = parts.password ? encodeURIComponent(parts.password) : '';
  const auth = username ? `${username}:${password}@` : '';
  return `${protocol}://${auth}${host}:${port}`;
}

function normalizeProxyUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new Error('Invalid proxy URL');
  }
  const protocol = normalizeProtocol(parsed.protocol);
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname) throw new Error('Proxy entry requires a host');
  const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
  const username = parsed.username ? encodeURIComponent(decodeURIComponent(parsed.username)) : '';
  const password = parsed.password ? encodeURIComponent(decodeURIComponent(parsed.password)) : '';
  const auth = username ? `${username}:${password}@` : '';
  const port = parsed.port ? `:${parsed.port}` : '';
  return `${protocol}://${auth}${host}${port}`;
}

function stableProxyId(url) {
  const normalized = normalizeProxyUrl(url);
  return `proxy-${crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 16)}`;
}

function redactProxyUrl(value) {
  try {
    const parsed = new URL(String(value));
    const protocol = normalizeProtocol(parsed.protocol);
    const hostname = parsed.hostname.toLowerCase();
    const host = hostname.includes(':') && !hostname.startsWith('[') ? `[${hostname}]` : hostname;
    return `${protocol}://${host}${parsed.port ? `:${parsed.port}` : ''}`;
  } catch {
    return '<invalid-proxy>';
  }
}

function safeReason(value) {
  const text = String(value || '');
  if (!text) return '';
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1<redacted>@')
    .slice(0, 300);
}

function parseProxyLine(line, options = {}) {
  const text = stripInlineComment(String(line || ''));
  if (!text) return null;

  if (/^\d+$/.test(text)) {
    return parseProxyLine(`127.0.0.1:${text}`, options);
  }

  if (text.includes('://')) {
    const url = normalizeProxyUrl(text);
    const parsed = new URL(url);
    return {
      raw: redactProxyUrl(url),
      url,
      protocol: normalizeProtocol(parsed.protocol),
      host: parsed.hostname,
      port: parsed.port,
      username: decodeURIComponent(parsed.username || ''),
      password: decodeURIComponent(parsed.password || ''),
    };
  }

  const atParts = text.match(/^([^:@]+):([^@]*)@([^:]+):(\d+)$/);
  if (atParts) {
    const entry = {
      raw: text,
      protocol: options.defaultProtocol || 'http',
      username: atParts[1],
      password: atParts[2],
      host: atParts[3],
      port: atParts[4],
    };
    const url = normalizeProxyUrl(proxyUrlFromParts(entry, options));
    return { ...entry, raw: redactProxyUrl(url), url };
  }

  const parts = text.split(':');
  if (parts.length === 2) {
    const entry = {
      raw: text,
      protocol: options.defaultProtocol || 'http',
      host: parts[0],
      port: parts[1],
      username: '',
      password: '',
    };
    const url = normalizeProxyUrl(proxyUrlFromParts(entry, options));
    return { ...entry, raw: redactProxyUrl(url), url };
  }

  if (parts.length === 4) {
    const entry = {
      raw: text,
      protocol: options.defaultProtocol || 'http',
      host: parts[0],
      port: parts[1],
      username: parts[2],
      password: parts[3],
    };
    const url = normalizeProxyUrl(proxyUrlFromParts(entry, options));
    return { ...entry, raw: redactProxyUrl(url), url };
  }

  throw new Error('Unsupported proxy entry format');
}

function parseProxyList(text, options = {}) {
  const seen = new Set();
  const entries = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const entry = parseProxyLine(line, options);
    if (!entry || seen.has(entry.url)) continue;
    seen.add(entry.url);
    entries.push({ ...entry, id: stableProxyId(entry.url) });
  }
  return entries;
}

function loadProxyPool(filePath, options = {}) {
  if (!filePath) return [];
  const resolved = path.resolve(filePath);
  return parseProxyList(fs.readFileSync(resolved, 'utf8'), options).map((entry) => ({
    ...entry,
    source: resolved,
  }));
}

function normalizeProxyEntry(entry, index = 0) {
  const parsed = typeof entry === 'string' ? parseProxyLine(entry) : entry;
  if (!parsed?.url) throw new Error(`Proxy entry ${index + 1} requires a url`);
  const url = normalizeProxyUrl(parsed.url);
  return {
    ...parsed,
    raw: parsed.raw ? redactProxyUrl(url) : undefined,
    url,
    id: parsed.id || stableProxyId(url),
  };
}

function allocatorArguments(initialLeases, options) {
  if (
    options === undefined
    && initialLeases
    && typeof initialLeases === 'object'
    && !Array.isArray(initialLeases)
    && (
      Object.hasOwn(initialLeases, 'leases')
      || Object.hasOwn(initialLeases, 'healthState')
      || Object.hasOwn(initialLeases, 'health')
      || Object.hasOwn(initialLeases, 'random')
      || Object.hasOwn(initialLeases, 'order')
    )
  ) {
    return { leases: initialLeases.leases || {}, options: initialLeases };
  }
  return { leases: initialLeases || {}, options: options || {} };
}

function orderedCandidates(candidates, order) {
  if (!order) return candidates;
  if (typeof order === 'function') {
    if (order.length >= 2) return [...candidates].sort(order);
    const result = order([...candidates]);
    return Array.isArray(result) ? result : candidates;
  }
  if (!Array.isArray(order)) return candidates;
  const rank = new Map(order.map((value, index) => [String(value), index]));
  return [...candidates].sort((left, right) => {
    const leftRank = rank.get(left.id) ?? rank.get(left.url) ?? rank.get(String(left._inputIndex)) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(right.id) ?? rank.get(right.url) ?? rank.get(String(right._inputIndex)) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || left._inputIndex - right._inputIndex;
  });
}

function chooseProxy(candidates, options = {}, defaults = {}) {
  const ordered = orderedCandidates(candidates, options.order ?? defaults.order);
  if (!ordered.length) return null;
  const random = options.random ?? defaults.random;
  if (typeof random !== 'function') return ordered[0];
  const sample = Number(random());
  const normalized = Number.isFinite(sample) ? Math.max(0, Math.min(sample, 0.999999999999)) : 0;
  return ordered[Math.floor(normalized * ordered.length)];
}

function proxyId(proxyOrId) {
  return String(proxyOrId && typeof proxyOrId === 'object' ? proxyOrId.id : proxyOrId || '');
}

function createProxyAllocator(entries = [], initialLeases = {}, allocatorOptions) {
  const parsedArgs = allocatorArguments(initialLeases, allocatorOptions);
  const seen = new Set();
  const pool = entries.map(normalizeProxyEntry).filter((entry, index) => {
    entry._inputIndex = index;
    if (seen.has(entry.url)) return false;
    seen.add(entry.url);
    return true;
  });
  const leases = { ...parsedArgs.leases };
  const defaults = parsedArgs.options;
  let health = createProxyHealthState(pool, defaults.healthState || defaults.health || {});

  function leasedIds() {
    return new Set(Object.values(leases).filter(Boolean));
  }

  function entryFor(value) {
    const id = proxyId(value);
    return pool.find((entry) => entry.id === id || entry.url === value?.url) || null;
  }

  function setLeased(entry, jobId) {
    const record = health[entry.id];
    record.status = 'leased';
    record.leasedTo = jobId;
    record.leasedAt = new Date().toISOString();
    record.checkingBy = '';
  }

  for (const [jobId, id] of Object.entries(leases)) {
    const entry = pool.find((candidate) => candidate.id === id);
    if (!entry || health[id]?.status === 'failed') {
      delete leases[jobId];
      continue;
    }
    setLeased(entry, jobId);
  }

  const activeLeaseIds = leasedIds();
  for (const entry of pool) {
    const record = health[entry.id];
    if (record.status === 'checking') {
      record.status = record.lastSuccessAt ? 'healthy' : 'unknown';
      record.checkingBy = '';
      record.recoveredAt = new Date().toISOString();
    } else if (record.status === 'leased' && !activeLeaseIds.has(entry.id)) {
      record.status = record.lastSuccessAt ? 'healthy' : 'unknown';
      record.leasedTo = '';
      record.recoveredAt = new Date().toISOString();
    }
  }

  function selectable(options = {}, statuses = new Set(['unknown', 'healthy'])) {
    const used = leasedIds();
    const excluded = new Set([
      ...(options.excludeIds || []),
      ...(options.exclude || []),
    ].map((value) => proxyId(value)));
    const isUsable = options.isUsable || (() => true);
    return pool.filter((entry) => (
      !used.has(entry.id)
      && !excluded.has(entry.id)
      && statuses.has(health[entry.id]?.status || 'unknown')
      && isUsable(entry)
    ));
  }

  const allocator = {
    pool,
    leases,
    get health() { return health; },
    acquire(jobId, options = {}) {
      if (!jobId) throw new Error('Proxy lease requires a jobId');
      const currentId = leases[jobId];
      if (currentId) {
        const current = pool.find((entry) => entry.id === currentId);
        if (current && health[current.id]?.status !== 'failed') return current;
        delete leases[jobId];
      }
      const statuses = options.requireHealthy === true ? new Set(['healthy']) : new Set(['unknown', 'healthy']);
      const entry = chooseProxy(selectable(options, statuses), options, defaults);
      if (!entry) return null;
      leases[jobId] = entry.id;
      setLeased(entry, jobId);
      return entry;
    },
    acquireRandom(jobId, options = {}) {
      return this.acquire(jobId, { ...options, random: options.random || defaults.random || Math.random });
    },
    beginCheck(owner = 'health-check', options = {}) {
      if (owner && typeof owner === 'object') {
        options = owner;
        owner = options.owner || 'health-check';
      }
      const statuses = options.includeHealthy ? new Set(['unknown', 'healthy']) : new Set(['unknown']);
      const entry = chooseProxy(selectable(options, statuses), options, defaults);
      if (!entry) return null;
      const record = health[entry.id];
      record.status = 'checking';
      record.checkingBy = String(owner);
      record.checkingAt = new Date().toISOString();
      return entry;
    },
    completeCheck(proxyOrId, success, details = {}) {
      const entry = entryFor(proxyOrId);
      if (!entry) return null;
      health = success
        ? markProxySuccess(health, entry, details)
        : markProxyFailure(health, entry, details);
      return entry;
    },
    cancelCheck(proxyOrId, details = {}) {
      const entry = entryFor(proxyOrId);
      if (!entry) return null;
      const record = health[entry.id];
      if (record?.status === 'checking') {
        record.status = record.lastSuccessAt ? 'healthy' : 'unknown';
        record.checkingBy = '';
        record.cancelledAt = details.at || new Date().toISOString();
      }
      return entry;
    },
    fail(proxyOrId, reason = 'proxy_failure') {
      const entry = entryFor(proxyOrId);
      if (!entry) return null;
      for (const [jobId, id] of Object.entries(leases)) if (id === entry.id) delete leases[jobId];
      health = markProxyFailure(health, entry, { reason });
      return entry;
    },
    rotate(jobId, options = {}) {
      const currentId = leases[jobId] || '';
      const current = pool.find((entry) => entry.id === currentId) || null;
      delete leases[jobId];
      if (current) {
        if (options.markFailed !== false) health = markProxyFailure(health, current, { reason: options.reason || 'proxy_rotated' });
        else if (health[current.id]?.status === 'leased') health[current.id].status = 'healthy';
      }
      return this.acquire(jobId, {
        ...options,
        excludeIds: [...(options.excludeIds || []), ...(currentId ? [currentId] : [])],
      });
    },
    release(jobId) {
      const id = leases[jobId];
      delete leases[jobId];
      const entry = pool.find((candidate) => candidate.id === id) || null;
      const record = entry ? health[entry.id] : null;
      if (record?.status === 'leased' && (!record.leasedTo || record.leasedTo === jobId)) {
        record.status = 'healthy';
        record.leasedTo = '';
        record.releasedAt = new Date().toISOString();
      }
      return entry;
    },
    snapshot() {
      const counts = { unknown: 0, checking: 0, healthy: 0, leased: 0, failed: 0 };
      for (const entry of pool) {
        const status = health[entry.id]?.status || 'unknown';
        counts[status] = Number(counts[status] || 0) + 1;
      }
      return {
        leases: { ...leases },
        health: JSON.parse(JSON.stringify(health)),
        available: counts.unknown + counts.healthy,
        total: pool.length,
        counts,
      };
    },
  };
  return allocator;
}

function createProxyHealthState(entries = [], existing = {}) {
  const now = new Date().toISOString();
  const out = {};
  for (const [id, value] of Object.entries(existing || {})) {
    const previous = value && typeof value === 'object' ? value : {};
    let status = String(previous.status || 'unknown');
    if (!PROXY_HEALTH_STATUSES.has(status)) {
      status = ['banned', 'unhealthy', 'degraded'].includes(status) ? 'failed' : 'unknown';
    }
    out[id] = { ...previous, id, status, reason: safeReason(previous.reason || '') };
    if (previous.url && !previous.endpoint) out[id].endpoint = redactProxyUrl(previous.url);
    delete out[id].url;
  }
  for (const entry of entries || []) {
    const previous = existing?.[entry.id] || {};
    let status = String(previous.status || 'unknown');
    if (!PROXY_HEALTH_STATUSES.has(status)) {
      status = ['banned', 'unhealthy', 'degraded'].includes(status) ? 'failed' : 'unknown';
    }
    out[entry.id] = {
      ...previous,
      id: entry.id,
      endpoint: redactProxyUrl(entry.url),
      status,
      successCount: Number(previous.successCount || 0),
      failureCount: Number(previous.failureCount || 0),
      consecutiveFailures: Number(previous.consecutiveFailures || 0),
      lastCheckedAt: previous.lastCheckedAt || '',
      lastSuccessAt: previous.lastSuccessAt || '',
      lastFailureAt: previous.lastFailureAt || '',
      cooldownUntil: '',
      latencyMs: previous.latencyMs ?? null,
      reason: safeReason(previous.reason || ''),
      createdAt: previous.createdAt || now,
    };
    delete out[entry.id].url;
  }
  return out;
}

function proxyCooldownActive(record, nowMs = Date.now()) {
  if (!record?.cooldownUntil) return false;
  return Date.parse(record.cooldownUntil) > nowMs;
}

function isProxyUsable(record, options = {}) {
  if (!record) return true;
  if (['failed', 'banned', 'unhealthy', 'checking', 'leased'].includes(record.status)) return false;
  if (proxyCooldownActive(record, options.nowMs)) return false;
  const maxConsecutiveFailures = Number(options.maxConsecutiveFailures || 3);
  return Number(record.consecutiveFailures || 0) < maxConsecutiveFailures;
}

function markProxySuccess(healthState, proxy, details = {}) {
  const state = createProxyHealthState([proxy], healthState);
  const record = state[proxy.id];
  record.status = 'healthy';
  record.successCount = Number(record.successCount || 0) + 1;
  record.consecutiveFailures = 0;
  record.lastCheckedAt = details.at || new Date().toISOString();
  record.lastSuccessAt = record.lastCheckedAt;
  record.cooldownUntil = '';
  record.checkingBy = '';
  record.leasedTo = '';
  record.reason = '';
  record.latencyMs = details.latencyMs ?? record.latencyMs ?? null;
  return state;
}

function markProxyFailure(healthState, proxy, details = {}) {
  const state = createProxyHealthState([proxy], healthState);
  const record = state[proxy.id];
  record.failureCount = Number(record.failureCount || 0) + 1;
  record.consecutiveFailures = Number(record.consecutiveFailures || 0) + 1;
  record.lastCheckedAt = details.at || new Date().toISOString();
  record.lastFailureAt = record.lastCheckedAt;
  record.reason = safeReason(details.reason || details.error || 'proxy_failure');
  record.status = 'failed';
  record.cooldownUntil = '';
  record.checkingBy = '';
  record.leasedTo = '';
  return state;
}

function isCloudflareChallenge(status, body) {
  return Number(status) === 403 && /cloudflare|just a moment|cdn-cgi/i.test(String(body || ''));
}

async function probeProxy(proxy, options = {}) {
  if (!proxy?.url) throw new Error('Proxy probe requires proxy.url');
  const probeUrl = options.probeUrl || 'https://auth.openai.com/';
  const request = {
    index: -2080,
    method: 'GET',
    url: probeUrl,
    headers: {
      Accept: '*/*',
      'User-Agent': options.userAgent || 'gpt-re-proxy-health/0.1',
    },
    cookies: {},
    body: '',
    contentType: '',
    expectStatus: 200,
    redirect: '',
  };
  const started = Date.now();
  const executor = options.executor;
  if (!executor) throw new Error('Proxy probe requires an executor');
  const result = await executor(request, {
    name: 'proxy_health_check',
    proxy: proxy.url,
    timeoutMs: options.timeoutMs || 15000,
    signal: options.signal,
  });
  const status = Number(result.response?.status || result.status || 0);
  if (status < 200 || status >= 500) {
    throw new Error(`Proxy probe failed with HTTP ${status || 'unknown'}`);
  }
  // A Cloudflare interstitial is a successful transport, so callers that route
  // real auth traffic through this exit must be able to treat it as unhealthy;
  // the generic catalog check keeps accepting it as "reachable".
  if (options.rejectChallenge === true && isCloudflareChallenge(status, result.response?.text)) {
    throw Object.assign(
      new Error(`Proxy probe reached a Cloudflare challenge with HTTP ${status}`),
      { code: 'PROXY_CLOUDFLARE_CHALLENGE', status },
    );
  }
  return {
    status,
    latencyMs: Date.now() - started,
    url: result.response?.url || probeUrl,
  };
}

module.exports = {
  isCloudflareChallenge,
  createProxyAllocator,
  createProxyHealthState,
  isProxyUsable,
  loadProxyPool,
  markProxyFailure,
  markProxySuccess,
  normalizeProtocol,
  normalizeProxyUrl,
  parseProxyLine,
  parseProxyList,
  probeProxy,
  stableProxyId,
};
