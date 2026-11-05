'use strict';

const { UrlSession } = require('./url-session');
const { normalizedEmail } = require('./session-asset-store');
const { classified, truthyText: text } = require('./util/shared');

const CHATGPT_BASE = 'https://chatgpt.com';
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 15000;
// Login-state AT checks use the stable local forwarder.  The proxy that was
// used to create an asset may be a short-lived dynamic endpoint and is not a
// reliable liveness path for a later measurement.
const DEFAULT_AT_PROBE_PROXY = 'http://127.0.0.1:7890';

function identityValues(payload = {}) {
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
      payload.id,
      payload.account?.id,
      ...accounts.map((account) => account?.id),
    ].map(text).filter(Boolean),
  };
}

function classifyHttpResponse(asset, result) {
  const httpStatus = Number(result?.response?.status || 0);
  if (httpStatus === 401) {
    return classified('invalid', 'AT_UNAUTHORIZED', 'Access token was rejected with HTTP 401', { httpStatus });
  }
  if (httpStatus === 403) {
    return classified('uncertain', 'AT_FORBIDDEN', 'Access token probe was blocked with HTTP 403', { httpStatus });
  }
  if (httpStatus === 429) {
    return classified('uncertain', 'AT_RATE_LIMITED', 'Access token probe was rate limited', { httpStatus });
  }
  if (httpStatus >= 500) {
    return classified('uncertain', 'AT_SERVICE_UNAVAILABLE', 'Access token probe reached an unavailable upstream service', { httpStatus });
  }
  if (httpStatus < 200 || httpStatus >= 300) {
    return classified('uncertain', 'AT_PROBE_REJECTED', `Access token probe returned HTTP ${httpStatus || 'unknown'}`, { httpStatus });
  }

  const identity = identityValues(result?.json || {});
  const expectedEmail = normalizedEmail(asset.email);
  const expectedAccountId = text(asset.accountId);
  const emailMatches = Boolean(expectedEmail && identity.emails.includes(expectedEmail));
  const accountMatches = Boolean(expectedAccountId && identity.accountIds.includes(expectedAccountId));

  // Nothing to mismatch against. A caller probing a token it has never seen —
  // an import, for instance — is asking who it belongs to, and answering
  // "identity mismatch" to that question is simply wrong.
  if (!expectedEmail && !expectedAccountId) {
    return identity.emails.length || identity.accountIds.length
      ? classified('healthy', 'AT_VALID', 'Access token is valid and exposed its identity', { httpStatus, identity })
      : classified('uncertain', 'AT_IDENTITY_UNVERIFIED', 'Access token was accepted but the response did not expose a verifiable identity', { httpStatus, identity });
  }
  if (identity.emails.length && !emailMatches) {
    return classified('mismatch', 'AT_IDENTITY_MISMATCH', 'Access token belongs to a different email identity', { httpStatus, identity });
  }
  if (emailMatches || accountMatches) {
    return classified('healthy', 'AT_VALID', 'Access token is valid and its identity matches', { httpStatus, identity });
  }
  if (identity.accountIds.length && expectedAccountId) {
    return classified('mismatch', 'AT_IDENTITY_MISMATCH', 'Access token belongs to a different account identity', { httpStatus, identity });
  }
  return classified('uncertain', 'AT_IDENTITY_UNVERIFIED', 'Access token was accepted but the response did not expose a verifiable identity', { httpStatus, identity });
}

function publicResult(asset, health) {
  return {
    assetId: asset.id,
    email: asset.email,
    healthy: health.status === 'healthy',
    ...health,
  };
}

async function probeSessionAsset(asset, options = {}) {
  const clock = options.now || Date.now;
  const startedAt = clock();
  const previous = asset.health || {};
  const accessToken = text(asset.accessToken);
  if (!accessToken) {
    const checkedAt = new Date(clock()).toISOString();
    return publicResult(asset, {
      status: 'missing',
      code: 'AT_MISSING',
      message: 'Login-state asset does not contain an access token',
      httpStatus: 0,
      checkedAt,
      latencyMs: Math.max(0, clock() - startedAt),
      lastHealthyAt: text(previous.lastHealthyAt),
    });
  }

  const controller = new AbortController();
  const timeoutMs = Math.max(1000, Math.min(60000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS)));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('Access token probe timed out'));
  }, timeoutMs);
  let classification;
  try {
    const session = new UrlSession({
      clientProfile: asset.clientProfile || {},
      // Allow a test/integrator override, but default every UI/API probe to
      // the fixed local 7890 forwarder rather than the saved source proxy.
      proxy: text(options.proxy || options.atProbeProxy || DEFAULT_AT_PROBE_PROXY),
      signal: controller.signal,
      executor: options.executor,
    });
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
    };
    if (text(asset.oaiDid)) headers['oai-device-id'] = text(asset.oaiDid);
    const result = await session.once('GET', `${CHATGPT_BASE}/backend-api/me`, {
      origin: CHATGPT_BASE,
      referer: `${CHATGPT_BASE}/`,
      headers,
      timeoutMs,
    });
    classification = classifyHttpResponse(asset, result);
  } catch (error) {
    classification = timedOut || error?.name === 'AbortError'
      ? classified('uncertain', 'AT_PROBE_TIMEOUT', 'Access token probe timed out', { httpStatus: 0 })
      : classified('uncertain', 'AT_NETWORK_ERROR', 'Access token probe failed before receiving an HTTP response', { httpStatus: 0 });
  } finally {
    clearTimeout(timer);
  }

  const checkedAt = new Date(clock()).toISOString();
  const health = {
    ...classification,
    checkedAt,
    latencyMs: Math.max(0, clock() - startedAt),
    lastHealthyAt: classification.status === 'healthy' ? checkedAt : text(previous.lastHealthyAt),
  };
  return publicResult(asset, health);
}

async function probeSessionAssets(store, assetIds, options = {}) {
  const uniqueIds = [...new Set((assetIds || []).map(text).filter(Boolean))];
  const assets = uniqueIds.map((id) => store.get(id));
  const results = new Array(assets.length);
  const concurrency = Math.max(1, Math.min(8, Number(options.concurrency || DEFAULT_CONCURRENCY), assets.length || 1));
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= assets.length) return;
      const asset = assets[index];
      const result = await probeSessionAsset(asset, options);
      const health = {
        status: result.status,
        code: result.code,
        message: result.message,
        httpStatus: result.httpStatus,
        checkedAt: result.checkedAt,
        latencyMs: result.latencyMs,
        lastHealthyAt: result.lastHealthyAt,
      };
      const current = store.get(asset.id);
      if (text(current.accessToken) !== text(asset.accessToken)) {
        health.status = 'uncertain';
        health.code = 'AT_CHANGED_DURING_PROBE';
        health.message = 'Access token changed while the health check was running';
        health.httpStatus = 0;
        health.lastHealthyAt = text(current.health?.lastHealthyAt);
      }
      store.update(asset.id, { health });
      results[index] = { ...result, healthy: health.status === 'healthy', ...health };
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return {
    requested: (assetIds || []).length,
    checked: results.length,
    results,
  };
}

module.exports = {
  DEFAULT_AT_PROBE_PROXY,
  probeSessionAsset,
  probeSessionAssets,
};
