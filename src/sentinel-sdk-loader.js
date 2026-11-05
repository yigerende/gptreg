'use strict';

const crypto = require('node:crypto');

const { applyBrowserHeaders, profileFingerprint } = require('./client-profile');

const DEFAULT_BOOTSTRAP_URL = 'https://sentinel.openai.com/backend-api/sentinel/sdk.js';
const DEFAULT_CACHE_TTL_MS = 300000;
const sourceCache = new Map();
const sourceInflight = new Map();
const runnerSdk = new WeakMap();

function extractVersionedSdkUrl(source) {
  return String(source || '').match(/https:\/\/sentinel\.openai\.com\/sentinel\/[^'"<>\s]+\/sdk\.js/)?.[0] || '';
}

function isVersionedSdkUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && parsed.hostname === 'sentinel.openai.com'
      && /^\/sentinel\/[^/]+\/sdk\.js$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

function sourceHash(source) {
  return crypto.createHash('sha256').update(String(source || '')).digest('hex');
}

function sdkRequest(url, profile, index, referer) {
  const request = {
    index,
    method: 'GET',
    url,
    headers: {
      Accept: '*/*',
      Referer: referer,
      'Sec-Fetch-Dest': 'script',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': referer.includes('sentinel.openai.com') ? 'same-origin' : 'cross-site',
    },
    cookies: {},
    body: '',
    contentType: '',
  };
  return applyBrowserHeaders(request, profile);
}

function assertSdkResponse(result, label) {
  const status = Number(result?.response?.status || 0);
  const source = String(result?.response?.text || '');
  if (status < 200 || status >= 400) throw new Error(`${label} returned HTTP ${status || 'unknown'}`);
  if (!source.trim()) throw new Error(`${label} returned an empty response`);
  return source;
}

function rememberState(state, sdk, origin, error = sdk.error || '') {
  state.sentinelSdk = {
    url: sdk.url,
    sha256: sourceHash(sdk.source),
    origin,
    profileFingerprint: profileFingerprint(state.clientProfile),
    loadedAt: new Date().toISOString(),
    error,
  };
}

function mergeSdkResponseCookies(state, result) {
  const responseCookies = result?.cookies;
  if (!responseCookies || typeof responseCookies !== 'object' || Array.isArray(responseCookies)) return;
  const currentCookies = state.cookies && typeof state.cookies === 'object' && !Array.isArray(state.cookies)
    ? state.cookies
    : {};
  const lockedDid = currentCookies['oai-did'] || state.oaiDid || '';
  state.cookies = { ...currentCookies, ...responseCookies };
  // SDK source responses are scoped to sentinel.openai.com. They must never
  // replace the auth session's device identity with an empty or foreign value.
  if (lockedDid) state.cookies['oai-did'] = lockedDid;
}

async function loadSentinelSdk(harSdk, state, options = {}) {
  const shouldPin = options.pin !== false;
  const pinned = shouldPin ? runnerSdk.get(state) : null;
  if (pinned) {
    rememberState(state, pinned, pinned.origin);
    return pinned;
  }
  if (options.source) {
    const sdk = { source: String(options.source), url: options.url || harSdk.url || DEFAULT_BOOTSTRAP_URL, origin: 'supplied' };
    if (shouldPin) runnerSdk.set(state, sdk);
    return sdk;
  }
  const executor = options.executor;
  if (typeof executor !== 'function' || options.live === false) {
    if (!harSdk.source) throw new Error('Sentinel SDK requires a live executor or an explicitly supplied SDK source');
    const sdk = { ...harSdk, origin: 'har' };
    if (shouldPin) runnerSdk.set(state, sdk);
    rememberState(state, sdk, sdk.origin);
    return sdk;
  }

  const profile = state.clientProfile;
  const bootstrapUrl = options.bootstrapUrl || DEFAULT_BOOTSTRAP_URL;
  const cacheKey = `${profileFingerprint(profile)}|${bootstrapUrl}`;
  // A static SDK can be reused after it has completed, but an in-flight fetch
  // stays on one proxy.  This keeps the transport boundary of each worker
  // intact while still collapsing duplicate loads racing on that same exit.
  const proxyKey = sourceHash(String(options.proxy || 'direct'));
  const inflightKey = `${cacheKey}|${proxyKey}`;
  const now = Date.now();
  const persisted = state.sentinelSdk;
  if (persisted?.sha256 && /^har(?:-fallback)?$/.test(String(persisted.origin || ''))
    && sourceHash(harSdk.source) === persisted.sha256) {
    const sdk = { ...harSdk, origin: persisted.origin, error: persisted.error || '' };
    if (shouldPin) runnerSdk.set(state, sdk);
    rememberState(state, sdk, sdk.origin);
    return sdk;
  }
  if (persisted?.sha256 && isVersionedSdkUrl(persisted.url)) {
    const sourceRequest = sdkRequest(
      persisted.url,
      profile,
      -9103,
      'https://sentinel.openai.com/backend-api/sentinel/frame.html',
    );
    const sourceResult = await executor(sourceRequest, { name: 'sentinel_sdk_resume', type: 'sentinelSdk' }, state);
    mergeSdkResponseCookies(state, sourceResult);
    const source = assertSdkResponse(sourceResult, 'Persisted Sentinel SDK');
    if (sourceHash(source) !== persisted.sha256) {
      throw new Error('Persisted Sentinel SDK source hash changed during runner resume');
    }
    const sdk = { source, url: persisted.url, origin: 'live-resume' };
    if (shouldPin) runnerSdk.set(state, sdk);
    sourceCache.set(cacheKey, { sdk: { source, url: persisted.url }, origin: 'live', expiresAt: now + DEFAULT_CACHE_TTL_MS });
    rememberState(state, sdk, sdk.origin);
    return sdk;
  }
  const cached = sourceCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    const sdk = { ...cached.sdk, origin: cached.origin };
    if (shouldPin) runnerSdk.set(state, sdk);
    rememberState(state, sdk, sdk.origin);
    return sdk;
  }

  let liveSourcePromise = sourceInflight.get(inflightKey);
  if (!liveSourcePromise) {
    liveSourcePromise = (async () => {
      const bootstrapRequest = sdkRequest(bootstrapUrl, profile, -9101, 'https://auth.openai.com/');
      const bootstrapResult = await executor(bootstrapRequest, { name: 'sentinel_sdk_bootstrap', type: 'sentinelSdk' }, state);
      mergeSdkResponseCookies(state, bootstrapResult);
      const bootstrapSource = assertSdkResponse(bootstrapResult, 'Sentinel SDK bootstrap');
      const sdkUrl = extractVersionedSdkUrl(bootstrapSource) || harSdk.url
        || (/\bSentinelSDK\b/.test(bootstrapSource) ? bootstrapUrl : '');
      if (!sdkUrl) throw new Error('Sentinel SDK bootstrap did not provide a versioned SDK URL');
      let sdkSource = bootstrapSource;

      if (sdkUrl !== bootstrapUrl || !/\bSentinelSDK\b/.test(bootstrapSource)) {
        const sourceRequest = sdkRequest(
          sdkUrl,
          profile,
          -9102,
          'https://sentinel.openai.com/backend-api/sentinel/frame.html',
        );
        const sourceResult = await executor(sourceRequest, { name: 'sentinel_sdk_source', type: 'sentinelSdk' }, state);
        mergeSdkResponseCookies(state, sourceResult);
        sdkSource = assertSdkResponse(sourceResult, 'Versioned Sentinel SDK');
      }
      if (!/\bSentinelSDK\b/.test(sdkSource)) throw new Error('Sentinel SDK public API marker was not found');

      return {
        sdk: { source: sdkSource, url: sdkUrl },
        origin: 'live',
      };
    })();
    sourceInflight.set(inflightKey, liveSourcePromise);
  }

  try {
    const { sdk, origin } = await liveSourcePromise;
    const ttlMs = Math.max(0, Number(options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS));
    if (ttlMs) sourceCache.set(cacheKey, { sdk, origin, expiresAt: now + ttlMs });
    const resolved = { ...sdk, origin };
    if (shouldPin) runnerSdk.set(state, resolved);
    rememberState(state, resolved, origin);
    return resolved;
  } catch (error) {
    if (options.allowHarFallback === false || !harSdk.source) throw error;
    const sdk = { ...harSdk, origin: 'har-fallback', error: error.message };
    if (shouldPin) runnerSdk.set(state, sdk);
    rememberState(state, sdk, sdk.origin, error.message);
    return sdk;
  } finally {
    if (sourceInflight.get(inflightKey) === liveSourcePromise) sourceInflight.delete(inflightKey);
  }
}

function clearSentinelSdkCache() {
  sourceCache.clear();
  sourceInflight.clear();
}

module.exports = {
  clearSentinelSdkCache,
  extractVersionedSdkUrl,
  loadSentinelSdk,
};
