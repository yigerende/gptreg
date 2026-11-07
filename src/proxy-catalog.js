'use strict';

const crypto = require('node:crypto');

const { normalizeProtocol, parseProxyLine, stableProxyId } = require('./proxy-pool');

const CATALOG_SCHEMA_VERSION = 1;
const GLOBAL_COUNTRY_CODE = 'GLOBAL';
const MAX_711_COUNT = 900;
const MAX_B2PROXY_COUNT = 900;
const DEFAULT_PROXY_API_COUNT = 600;
const B2PROXY_DEFAULT_COUNT = DEFAULT_PROXY_API_COUNT;
const B2PROXY_SESSION_MINUTES = 60;
const MAX_1024_SESSION_MINUTES = 120;
const PROXY_SESSION_DEFAULTS = Object.freeze({ '711proxy': 180, b2proxy: 60, '1024proxy': 120, cliproxy: 15, iproyal: 120 });
const DEFAULT_711_API_TEMPLATE = `http://global.rotgbapi.711proxy.com:8089/gen?zone=custom&ptype=1&count=${DEFAULT_PROXY_API_COUNT}&proto=http&stype=text&split=%5Cr%5Cn&sessType=sticky&sessTime=180&sessAuto=0`;
const DEFAULT_B2PROXY_API_TEMPLATE = `http://global.rrp.bestgo.work:8089/gen?zone=custom&ptype=1&region=US&count=${B2PROXY_DEFAULT_COUNT}&proto=socks5&stype=txt&split=%5Cr%5Cn&sessType=sticky&sessTime=${B2PROXY_SESSION_MINUTES}&sessAuto=1`;
const DEFAULT_1024_API_TEMPLATE = `https://white.1024proxy.com/white/api?region=US&num=${DEFAULT_PROXY_API_COUNT}&time=${MAX_1024_SESSION_MINUTES}&format=1&type=txt`;
const DEFAULT_CLIPROXY_API_TEMPLATE = `https://api.cliproxy.io/white/api?region=US&num=${DEFAULT_PROXY_API_COUNT}&time=15&format=n&type=txt`;
const PROXY_API_TEMPLATES = Object.freeze({
  '711proxy': DEFAULT_711_API_TEMPLATE,
  b2proxy: DEFAULT_B2PROXY_API_TEMPLATE,
  '1024proxy': DEFAULT_1024_API_TEMPLATE,
  cliproxy: DEFAULT_CLIPROXY_API_TEMPLATE,
  iproyal: 'https://resi-api.iproyal.com/v1/access/generate-proxy-list',
});
const PROXY_API_BASE_URLS = Object.freeze(Object.fromEntries(
  Object.entries(PROXY_API_TEMPLATES).map(([provider, template]) => [provider, apiBaseUrlOf(template)]),
));
const PROXY_API_LABELS = Object.freeze({
  '711proxy': '711Proxy',
  b2proxy: 'B2Proxy',
  '1024proxy': '1024 Proxy',
  cliproxy: 'CLI Proxy',
  iproyal: 'IPRoyal',
});
const DEFAULT_PROXY_API_PROTOCOLS = Object.freeze({
  '711proxy': 'http',
  b2proxy: 'socks5',
  // 1024Proxy returns bare host:port entries. The proxy service used by this
  // project only works reliably when those entries are interpreted as SOCKS5.
  '1024proxy': 'socks5',
  cliproxy: 'http',
  iproyal: 'http',
});

function stableId(prefix, value) {
  return `${prefix}-${crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 16)}`;
}

/**
 * The identity of an API source: who serves it, for which country, over which
 * protocol.
 *
 * Deliberately not the URL. The URL carries `num` (how many proxies to ask
 * for) and `time` (session minutes), so hashing it made the *quantity* part of
 * the identity: changing a pool's count produced a new id, `importDynamic`
 * failed to match the existing source, and a second source was appended to the
 * same country pool. Both were then refreshed forever — double the HTTP calls
 * and double the catalog.
 *
 * Protocol is excluded too. These whitelist APIs return bare host:port and do
 * not encode a protocol, so http and socks5 are two readings of one upstream
 * source; switching between them replaces the cached entries rather than
 * standing up a second source alongside the first.
 */
function proxyApiSourceId(source = {}) {
  let host = '';
  try { host = new URL(String(source.url || '')).host.toLowerCase(); } catch { host = ''; }
  const provider = String(source.provider || '').toLowerCase();
  const countryCode = normalizeCountryCode(source.countryCode);
  return stableId('source', `${provider}|${countryCode}|${host}`);
}

function normalizeCountryCode(value, fallback = GLOBAL_COUNTRY_CODE) {
  const code = String(value || fallback).trim().toUpperCase();
  if (code === GLOBAL_COUNTRY_CODE) return code;
  if (!/^[A-Z]{2}$/.test(code)) throw new Error('Country code must be GLOBAL or a two-letter ISO code');
  return code;
}

function normalize711Count(value, fallback = DEFAULT_PROXY_API_COUNT) {
  const count = value === undefined || value === null || value === '' ? Number(fallback) : Number(value);
  if (!Number.isInteger(count) || count < 1 || count > MAX_711_COUNT) {
    throw new Error(`711Proxy count must be an integer between 1 and ${MAX_711_COUNT}`);
  }
  return count;
}

function normalizeB2ProxyCount(value, fallback = B2PROXY_DEFAULT_COUNT) {
  const count = value === undefined || value === null || value === '' ? Number(fallback) : Number(value);
  if (!Number.isInteger(count) || count < 1 || count > MAX_B2PROXY_COUNT) {
    throw new Error(`B2Proxy count must be an integer between 1 and ${MAX_B2PROXY_COUNT}`);
  }
  return count;
}

function normalizeProxyApiCount(value, fallback = DEFAULT_PROXY_API_COUNT, provider = '') {
  const count = value === undefined || value === null || value === '' ? Number(fallback) : Number(value);
  if (!Number.isSafeInteger(count) || count < 1) {
    const label = PROXY_API_LABELS[provider] || 'Proxy API';
    throw new Error(`${label} count must be a positive safe integer`);
  }
  return count;
}

function normalizeSessionMinutes(provider, value = PROXY_SESSION_DEFAULTS[provider]) {
  if (!Object.hasOwn(PROXY_SESSION_DEFAULTS, provider)) throw new Error('不支持的代理厂商');
  const max = provider === '1024proxy' ? MAX_1024_SESSION_MINUTES : provider === 'iproyal' ? 10080 : 1440;
  if (!Number.isInteger(value) || value < 1 || value > max) {
    throw new Error(`${PROXY_API_LABELS[provider]} 会话粘性时间须为 1～${max} 分钟的整数`);
  }
  return value;
}

function normalizeProviderSettings(provider, value = {}) {
  if (!Object.hasOwn(PROXY_SESSION_DEFAULTS, provider)) throw new Error('不支持的代理厂商');
  const count = provider === '711proxy' ? normalize711Count(value.count)
    : provider === 'b2proxy' ? normalizeB2ProxyCount(value.count)
      : normalizeProxyApiCount(value.count, DEFAULT_PROXY_API_COUNT, provider);
  const protocol = value.protocol ?? DEFAULT_PROXY_API_PROTOCOLS[provider];
  if (!['http', 'socks5'].includes(protocol)) throw new Error('协议只支持 HTTP 或 SOCKS5');
  return { count, protocol, sessionMinutes: normalizeSessionMinutes(provider, value.sessionMinutes), apiBaseUrl: normalizeProviderBaseUrl(provider, value.apiBaseUrl) };
}

function apiBaseUrlOf(value) {
  const url = new URL(value);
  url.search = '';
  url.hash = '';
  return url.href;
}

function normalizeProviderBaseUrl(provider, value = PROXY_API_BASE_URLS[provider]) {
  if (!Object.hasOwn(PROXY_API_BASE_URLS, provider)) throw new Error('不支持的代理厂商');
  let url;
  try { url = new URL(typeof value === 'string' ? value.trim() : ''); } catch { /* Validated below. */ }
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || url.search || url.hash || !url.hostname || value.length > 2048 || /[?#]/.test(value)) {
    throw new Error('API 地址须填写完整的 http(s)://域名:端口/路径，只填问号前的部分，不含账号密码或参数');
  }
  const known = proxyApiProviderFromHost(url.href);
  if (known && known !== provider) throw new Error('API 地址属于其他代理厂商');
  if (provider === 'iproyal' && url.protocol !== 'https:') throw new Error('IPRoyal API 地址必须使用 HTTPS');
  return url.href;
}

function matchesConfiguredApi(value, options) {
  return Boolean(options.apiBaseUrl) && apiBaseUrlOf(value) === options.apiBaseUrl;
}

function providerSettingsSnapshot(settings = {}) {
  return Object.fromEntries(Object.keys(PROXY_SESSION_DEFAULTS).map(provider => [provider, normalizeProviderSettings(provider, settings[provider])]));
}

function parseUrl(value) {
  try {
    return new URL(String(value).trim());
  } catch {
    throw new Error('Invalid URL');
  }
}

function is711ApiUrl(value, options = {}) {
  try {
    const url = parseUrl(value);
    if (matchesConfiguredApi(value, options)) return true;
    return ['http:', 'https:'].includes(url.protocol)
      && (/(^|\.)rotgbapi\.711proxy\.com$/i.test(url.hostname) || url.hostname === 'global.rotgbapi.trustsource.live')
      && url.port === '8089'
      && url.pathname.replace(/\/+$/, '') === '/gen';
  } catch {
    return false;
  }
}

function isB2ProxyApiUrl(value, options = {}) {
  try {
    const url = parseUrl(value);
    if (matchesConfiguredApi(value, options)) return true;
    return ['http:', 'https:'].includes(url.protocol)
      && (url.hostname === 'global.rrp.bestgo.work')
      && url.port === '8089'
      && url.pathname.replace(/\/+$/, '') === '/gen';
  } catch {
    return false;
  }
}

function is1024ApiUrl(value, options = {}) {
  try {
    const url = parseUrl(value);
    if (matchesConfiguredApi(value, options)) return true;
    return url.protocol === 'https:'
      && (url.hostname === 'white.1024proxy.com')
      && !url.port
      && url.pathname.replace(/\/+$/, '') === '/white/api';
  } catch {
    return false;
  }
}

function isCliProxyApiUrl(value, options = {}) {
  try {
    const url = parseUrl(value);
    if (matchesConfiguredApi(value, options)) return true;
    return url.protocol === 'https:'
      && (url.hostname === 'api.cliproxy.io')
      && !url.port
      && url.pathname.replace(/\/+$/, '') === '/white/api';
  } catch {
    return false;
  }
}

function proxyApiProviderFromHost(value, settings = {}) {
  try {
    const hostname = parseUrl(value).hostname.toLowerCase();
    if (/(^|\.)rotgbapi\.711proxy\.com$/i.test(hostname) || hostname === 'global.rotgbapi.trustsource.live') return '711proxy';
    if (hostname === 'global.rrp.bestgo.work') return 'b2proxy';
    if (hostname === 'white.1024proxy.com') return '1024proxy';
    if (hostname === 'api.cliproxy.io') return 'cliproxy';
    if (hostname === 'resi-api.iproyal.com') return 'iproyal';
    for (const [provider, config] of Object.entries(settings)) {
      if (config.apiBaseUrl && apiBaseUrlOf(value) === config.apiBaseUrl) return provider;
    }
    return '';
  } catch {
    return '';
  }
}

function countryFromProxyEntry(entry) {
  const username = String(entry?.username || '');
  const match = username.match(/(?:^|-)region-([a-z]{2})(?:-|$)/i);
  return match ? normalizeCountryCode(match[1]) : GLOBAL_COUNTRY_CODE;
}

function normalize711ApiUrl(value, options = {}) {
  const url = parseUrl(value);
  if (!is711ApiUrl(url.toString(), options)) throw new Error('Only 711Proxy rotating GB API URLs are supported');
  const countryCode = normalizeCountryCode(options.countryCode || url.searchParams.get('region') || GLOBAL_COUNTRY_CODE);
  const count = normalize711Count(options.count, url.searchParams.get('count') || DEFAULT_PROXY_API_COUNT);
  const protocol = normalizeProtocol(options.protocol || url.searchParams.get('proto') || 'http');
  const sessionMinutes = normalizeSessionMinutes('711proxy', options.sessionMinutes);

  url.searchParams.set('zone', url.searchParams.get('zone') || 'custom');
  url.searchParams.set('ptype', url.searchParams.get('ptype') || '1');
  if (countryCode === GLOBAL_COUNTRY_CODE) url.searchParams.delete('region');
  else url.searchParams.set('region', countryCode);
  url.searchParams.set('count', String(count));
  url.searchParams.set('proto', protocol);
  url.searchParams.set('stype', 'text');
  url.searchParams.set('split', '\\r\\n');
  url.searchParams.set('sessType', 'sticky');
  url.searchParams.set('sessTime', String(sessionMinutes));
  url.searchParams.set('sessAuto', '0');

  return {
    url: url.toString(),
    countryCode,
    count,
    protocol,
    sessionType: 'sticky',
    sessionMinutes,
    earlyRotation: false,
  };
}

function normalizeB2ProxyApiUrl(value, options = {}) {
  const url = parseUrl(value);
  if (!isB2ProxyApiUrl(url.toString(), options)) throw new Error('Only B2Proxy rotating GB API URLs are supported');
  const countryCode = normalizeCountryCode(options.countryCode || url.searchParams.get('region') || 'US');
  if (countryCode === GLOBAL_COUNTRY_CODE) throw new Error('B2Proxy requires a two-letter country code');
  const count = normalizeB2ProxyCount(options.count, url.searchParams.get('count') || B2PROXY_DEFAULT_COUNT);
  const protocol = normalizeProtocol(options.protocol || url.searchParams.get('proto') || DEFAULT_PROXY_API_PROTOCOLS.b2proxy);
  const sessionMinutes = normalizeSessionMinutes('b2proxy', options.sessionMinutes);

  url.searchParams.set('zone', url.searchParams.get('zone') || 'custom');
  url.searchParams.set('ptype', url.searchParams.get('ptype') || '1');
  url.searchParams.set('region', countryCode);
  url.searchParams.set('count', String(count));
  url.searchParams.set('proto', protocol);
  url.searchParams.set('stype', 'txt');
  url.searchParams.set('split', '\\r\\n');
  url.searchParams.set('sessType', 'sticky');
  url.searchParams.set('sessTime', String(sessionMinutes));
  url.searchParams.set('sessAuto', '1');

  return {
    provider: 'b2proxy',
    url: url.toString(),
    countryCode,
    count,
    protocol,
    sessionType: 'sticky',
    sessionMinutes,
    earlyRotation: false,
  };
}

function normalizeRegionalProxyApiUrl(value, options = {}, provider) {
  const url = parseUrl(value);
  const label = PROXY_API_LABELS[provider];
  const valid = provider === '1024proxy' ? is1024ApiUrl(url.toString(), options) : isCliProxyApiUrl(url.toString(), options);
  if (!valid) throw new Error(`Only ${label} whitelist API URLs are supported`);
  const countryCode = normalizeCountryCode(options.countryCode || url.searchParams.get('region') || 'US');
  if (countryCode === GLOBAL_COUNTRY_CODE) throw new Error(`${label} requires a two-letter country code`);
  const count = normalizeProxyApiCount(options.count, url.searchParams.get('num') || DEFAULT_PROXY_API_COUNT, provider);
  // These whitelist APIs return host:port pairs and do not encode the proxy
  // protocol in the URL. Keep it as source metadata so the same API can back
  // either an HTTP or SOCKS5 endpoint.
  const protocol = normalizeProtocol(
    options.protocol
      || (provider === '1024proxy'
        ? DEFAULT_PROXY_API_PROTOCOLS[provider]
        : options.defaultProtocol || DEFAULT_PROXY_API_PROTOCOLS[provider]),
  );
  const sessionMinutes = normalizeSessionMinutes(provider, options.sessionMinutes);

  url.searchParams.set('region', countryCode);
  url.searchParams.set('num', String(count));
  url.searchParams.set('time', String(sessionMinutes));
  url.searchParams.set('format', provider === '1024proxy' ? '1' : 'n');
  url.searchParams.set('type', 'txt');

  return {
    provider,
    url: url.toString(),
    countryCode,
    count,
    protocol,
    sessionType: 'sticky',
    sessionMinutes,
    earlyRotation: false,
  };
}

function normalizeProxyApiUrl(value, options = {}) {
  const url = parseUrl(value);
  if (url.username || url.password || url.hash) throw new Error('代理提取 API 不支持 URL 账号密码或片段');
  const detected = proxyApiProviderFromHost(value);
  const provider = String(options.provider || detected || '').toLowerCase();
  if (detected && detected !== provider) throw new Error('Proxy API provider does not match the URL host');
  if (options.apiBaseUrl !== undefined) options = { ...options, apiBaseUrl: normalizeProviderBaseUrl(provider, options.apiBaseUrl) };
  if (provider === 'iproyal') {
    const apiBaseUrl = normalizeProviderBaseUrl(provider, value);
    if (apiBaseUrl !== (options.apiBaseUrl || PROXY_API_BASE_URLS.iproyal)) throw new Error('IPRoyal 请使用生成代理列表的 API 地址');
    return { provider, url: apiBaseUrl, countryCode: normalizeCountryCode(options.countryCode),
      ...normalizeProviderSettings(provider, { ...options, apiBaseUrl }), sessionType: 'sticky', earlyRotation: false };
  }
  if (provider === '711proxy') return { provider, ...normalize711ApiUrl(value, options) };
  if (provider === 'b2proxy') {
    if (detected && detected !== provider) throw new Error('Proxy API provider does not match the URL host');
    return normalizeB2ProxyApiUrl(value, options);
  }
  if (provider === '1024proxy' || provider === 'cliproxy') {
    if (detected && detected !== provider) throw new Error('Proxy API provider does not match the URL host');
    return normalizeRegionalProxyApiUrl(value, options, provider);
  }
  throw new Error('Unsupported dynamic proxy API URL');
}

function buildProxyApiUrl(provider, options = {}) {
  const normalizedProvider = String(provider || '').toLowerCase();
  const template = PROXY_API_TEMPLATES[normalizedProvider];
  if (!template) throw new Error(`Unsupported dynamic proxy API provider: ${provider}`);
  const apiBaseUrl = normalizeProviderBaseUrl(normalizedProvider, options.apiBaseUrl);
  const url = new URL(apiBaseUrl);
  url.search = new URL(template).search;
  return normalizeProxyApiUrl(url.href, { ...options, apiBaseUrl, provider: normalizedProvider });
}

function emptyProxyCatalog() {
  return { schemaVersion: CATALOG_SCHEMA_VERSION, providerSettings: {}, countryPools: {} };
}

function normalizeCachedEntry(entry, countryCode, sourceId) {
  const parsed = parseProxyLine(entry.url || entry, { defaultProtocol: entry.protocol || 'http' });
  if (!parsed) throw new Error('Dynamic proxy entry is empty');
  return {
    id: stableProxyId(parsed.url),
    url: parsed.url,
    protocol: parsed.protocol,
    countryCode,
    sourceId: sourceId || entry.sourceId || 'manual',
  };
}

function normalizeRetiredEntries(entries = []) {
  const out = [];
  const seen = new Set();
  for (const rawEntry of Array.isArray(entries) ? entries : []) {
    const value = rawEntry && typeof rawEntry === 'object' ? rawEntry : { id: rawEntry };
    let id = String(value.id || '').trim();
    if (!id && value.url) {
      try { id = stableProxyId(parseProxyLine(value.url).url); } catch { id = ''; }
    }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      retiredAt: String(value.retiredAt || ''),
      reason: String(value.reason || '').slice(0, 300),
    });
  }
  return out;
}

function normalizeProxyCatalog(input = {}) {
  if (Number(input.schemaVersion || CATALOG_SCHEMA_VERSION) !== CATALOG_SCHEMA_VERSION) {
    throw new Error(`Unsupported proxy catalog schemaVersion: ${input.schemaVersion}`);
  }
  const catalog = emptyProxyCatalog();
  for (const [provider, settings] of Object.entries(input.providerSettings || {})) {
    catalog.providerSettings[provider] = normalizeProviderSettings(provider, settings);
  }
  for (const [rawCode, rawPool] of Object.entries(input.countryPools || {})) {
    const countryCode = normalizeCountryCode(rawCode);
    const retiredEntries = normalizeRetiredEntries(rawPool?.retiredEntries);
    const retiredIds = new Set(retiredEntries.map((entry) => entry.id));
    const manualSeen = new Set();
    const manualEntries = [];
    for (const rawEntry of rawPool?.manualEntries || []) {
      const entry = normalizeCachedEntry(rawEntry, countryCode, 'manual');
      if (retiredIds.has(entry.id)) continue;
      if (manualSeen.has(entry.url)) continue;
      manualSeen.add(entry.url);
      manualEntries.push(entry);
    }
    const sources = [];
    const sourceIds = new Set();
    for (const rawSource of rawPool?.sources || []) {
      const normalized = normalizeProxyApiUrl(rawSource.url, {
        provider: rawSource.provider,
        countryCode,
        count: rawSource.count,
        protocol: rawSource.protocol,
        sessionMinutes: rawSource.sessionMinutes,
        apiBaseUrl: rawSource.apiBaseUrl || catalog.providerSettings[rawSource.provider]?.apiBaseUrl,
      });
      // Recomputed rather than trusted, so catalogs written under the old
      // URL-derived scheme collapse their duplicate sources on the next read.
      const id = proxyApiSourceId(normalized);
      const entrySeen = new Set();
      const entries = [];
      for (const rawEntry of rawSource.entries || []) {
        const entry = normalizeCachedEntry(rawEntry, countryCode, id);
        if (retiredIds.has(entry.id)) continue;
        if (entrySeen.has(entry.url)) continue;
        entrySeen.add(entry.url);
        entries.push(entry);
      }
      const previous = sourceIds.has(id) ? sources.find((source) => source.id === id) : null;
      if (previous) {
        // Two records for one source: keep the fresher pull and union the
        // cached proxies rather than dropping whichever came second.
        const merged = new Set(previous.entries.map((entry) => entry.url));
        for (const entry of entries) {
          if (merged.has(entry.url)) continue;
          merged.add(entry.url);
          previous.entries.push(entry);
        }
        if (String(rawSource.lastPulledAt || '') > String(previous.lastPulledAt || '')) {
          previous.lastPulledAt = String(rawSource.lastPulledAt || '');
          previous.lastPullCount = Number(rawSource.lastPullCount || previous.entries.length);
          previous.lastError = String(rawSource.lastError || '');
        }
        previous.count = Math.max(Number(previous.count || 0), Number(normalized.count || 0));
        continue;
      }
      sourceIds.add(id);
      sources.push({
        id,
        ...normalized,
        apiBaseUrl: apiBaseUrlOf(normalized.url),
        entries,
        lastPulledAt: rawSource.lastPulledAt || '',
        lastPullCount: Number(rawSource.lastPullCount || entries.length),
        lastError: String(rawSource.lastError || ''),
        lastPulledSettings: rawSource.lastPulledSettings || null,
      });
    }
    if (manualEntries.length || sources.length || retiredEntries.length) {
      catalog.countryPools[countryCode] = {
        countryCode,
        manualEntries,
        sources,
        ...(retiredEntries.length ? { retiredEntries } : {}),
      };
    }
  }
  return catalog;
}

function overridesByLine(options = {}) {
  return new Map((options.overrides || []).map((item) => [Number(item.line), item]));
}

function parseDynamicContent(content, options = {}) {
  const items = [];
  const errors = [];
  const duplicates = [];
  const seen = new Set();
  const overrides = overridesByLine(options);
  String(content || '').split(/\r?\n/).forEach((rawLine, index) => {
    const line = index + 1;
    const text = rawLine.trim();
    if (!text || text.startsWith('#')) return;
    const override = overrides.get(line) || {};
    try {
      let item;
      const provider = override.provider || proxyApiProviderFromHost(text, options.providerSettings);
      if (provider) {
        const source = normalizeProxyApiUrl(text, {
          ...options.providerSettings?.[provider],
          ...override,
          provider,
          // Provider defaults are more reliable than the generic dynamic
          // import default for API responses that contain only host:port.
          defaultProtocol: options.defaultProtocol,
        });
        item = { kind: 'api', line, ...source };
      } else {
        const entry = parseProxyLine(text, { defaultProtocol: override.protocol || options.defaultProtocol || 'http' });
        const countryCode = normalizeCountryCode(override.countryCode || countryFromProxyEntry(entry));
        item = {
          kind: 'proxy',
          line,
          countryCode,
          protocol: entry.protocol,
          url: entry.url,
          id: stableProxyId(entry.url),
        };
      }
      const duplicateKey = item.kind === 'api' ? `api:${item.provider === 'iproyal' ? item.countryCode + ':' : ''}${item.url}` : `proxy:${item.countryCode}:${item.url}`;
      if (seen.has(duplicateKey)) {
        duplicates.push({ line, kind: item.kind, value: item.url });
        return;
      }
      seen.add(duplicateKey);
      items.push(item);
    } catch (error) {
      errors.push({ line, message: error.message });
    }
  });
  return { items, errors, duplicates };
}

function flattenedPoolEntries(pool) {
  const entries = [];
  const seen = new Set();
  for (const entry of [
    ...(pool?.manualEntries || []),
    ...(pool?.sources || []).flatMap((source) => source.entries || []),
  ]) {
    if (seen.has(entry.url)) continue;
    seen.add(entry.url);
    entries.push({ ...entry });
  }
  return entries;
}

module.exports = {
  apiBaseUrlOf,
  PROXY_API_BASE_URLS,
  normalizeProviderBaseUrl,
  PROXY_SESSION_DEFAULTS,
  normalizeSessionMinutes,
  normalizeProviderSettings,
  providerSettingsSnapshot,
  proxyApiSourceId,
  PROXY_API_LABELS,
  buildProxyApiUrl,
  emptyProxyCatalog,
  flattenedPoolEntries,
  normalizeB2ProxyApiUrl,
  normalize711ApiUrl,
  normalizeProxyApiUrl,
  normalizeProxyCatalog,
  parseDynamicContent,
  stableId,
};
