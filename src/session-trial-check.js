'use strict';

const { describeCampaign, isFreeMonthCampaign, offerSummary } = require('./trial-offer');
const { UrlSession } = require('./url-session');
const { classified, truthyText: text } = require('./util/shared');

const CHATGPT_BASE = 'https://chatgpt.com';
const TRIAL_CHECK_PATH = '/backend-api/accounts/check/v4-2023-04-27';
const DEFAULT_CONCURRENCY = 4;
const DEFAULT_TIMEOUT_MS = 15000;
// Last-resort exit when the caller names none. Callers that know better pass
// one: the check that runs right after registration reuses the exit the account
// was created through, and the console draws a fresh one per asset.
const DEFAULT_TRIAL_CHECK_PROXY = 'http://127.0.0.1:7890';

function timezoneOffsetMinutes(now) {
  const offset = new Date(now()).getTimezoneOffset();
  return Number.isFinite(offset) ? offset : 0;
}

function trialCheckUrl(now = Date.now) {
  // ChatGPT sends the browser offset on every check call; keeping it makes the
  // promo payload match what the account would see in a real session.
  return `${CHATGPT_BASE}${TRIAL_CHECK_PATH}?timezone_offset_min=${timezoneOffsetMinutes(now)}`;
}

function accountEntry(payload = {}, accountId = '') {
  const accounts = payload && typeof payload.accounts === 'object' && payload.accounts ? payload.accounts : {};
  const id = text(accountId);
  if (id && accounts[id] && typeof accounts[id] === 'object') return accounts[id];
  if (accounts.default && typeof accounts.default === 'object') return accounts.default;
  return Object.values(accounts).find((value) => value && typeof value === 'object') || null;
}

function promoCampaigns(entry = {}) {
  const source = entry.eligible_promo_campaigns;
  if (!source || typeof source !== 'object') return [];
  return Object.entries(source)
    .filter(([, value]) => value && typeof value === 'object')
    .map(([key, value]) => {
      const metadata = value.metadata && typeof value.metadata === 'object' ? value.metadata : {};
      const duration = metadata.duration && typeof metadata.duration === 'object' ? metadata.duration : {};
      return describeCampaign({
        key: text(key),
        id: text(value.id),
        planName: text(metadata.plan_name),
        label: text(metadata.promotion_type_label || metadata.promotion_type),
        durationPeriods: Number(duration.num_periods || 0) || 0,
        durationPeriod: text(duration.period),
        discountPercentage: Number(metadata.discount?.percentage ?? 0) || 0,
      });
    })
    .sort((left, right) => left.key.localeCompare(right.key));
}

function classifyTrialResponse(asset, result) {
  const httpStatus = Number(result?.response?.status || 0);
  if (httpStatus === 401) {
    return classified('unknown', 'TRIAL_UNAUTHORIZED', 'Promo check was rejected with HTTP 401', { httpStatus });
  }
  if (httpStatus === 403) {
    return classified('unknown', 'TRIAL_FORBIDDEN', 'Promo check was blocked with HTTP 403', { httpStatus });
  }
  if (httpStatus === 429) {
    return classified('unknown', 'TRIAL_RATE_LIMITED', 'Promo check was rate limited', { httpStatus });
  }
  if (httpStatus >= 500) {
    return classified('unknown', 'TRIAL_SERVICE_UNAVAILABLE', 'Promo check reached an unavailable upstream service', { httpStatus });
  }
  if (httpStatus < 200 || httpStatus >= 300) {
    return classified('unknown', 'TRIAL_CHECK_REJECTED', `Promo check returned HTTP ${httpStatus || 'unknown'}`, { httpStatus });
  }

  const payload = result?.json && typeof result.json === 'object' ? result.json : {};
  const entry = accountEntry(payload, asset?.accountId);
  if (!entry) {
    return classified('unknown', 'TRIAL_ACCOUNT_MISSING', 'Promo check response did not contain an account entry', { httpStatus });
  }

  const account = entry.account && typeof entry.account === 'object' ? entry.account : {};
  const entitlement = entry.entitlement && typeof entry.entitlement === 'object' ? entry.entitlement : {};
  const offers = entry.eligible_offers && typeof entry.eligible_offers === 'object' ? entry.eligible_offers : {};
  const campaigns = promoCampaigns(entry);
  const activeTrial = Boolean(entitlement.trial && typeof entitlement.trial === 'object'
    ? Object.keys(entitlement.trial).length
    : entitlement.trial);
  const facts = {
    httpStatus,
    planType: text(account.plan_type) || 'unknown',
    subscriptionPlan: text(entitlement.subscription_plan),
    hasActiveSubscription: entitlement.has_active_subscription === true,
    hasPreviouslyPaid: account.has_previously_paid_subscription === true,
    activeTrial,
    defaultOfferId: text(offers.default_offer_id),
    campaigns,
    ...offerSummary(campaigns),
  };

  if (activeTrial) {
    return classified('trial', 'TRIAL_ACTIVE', 'The account is currently inside a trial subscription', facts);
  }
  if (campaigns.length) {
    const best = campaigns.find((campaign) => isFreeMonthCampaign(campaign))
      || campaigns.find((campaign) => campaign.discountPercentage >= 100)
      || campaigns[0];
    const detail = [best.planName || best.key, best.label].filter(Boolean).join(' · ');
    return classified('trial', 'TRIAL_OFFER_AVAILABLE', `The account can still claim a promo trial${detail ? `: ${detail}` : ''}`, facts);
  }
  return classified('none', 'TRIAL_UNAVAILABLE', 'The account has no claimable promo campaign', facts);
}

function publicResult(asset, trial) {
  return {
    assetId: asset.id,
    email: asset.email,
    trialAvailable: trial.status === 'trial',
    ...trial,
  };
}

function trialRecord(classification, { checkedAt, latencyMs, previous = {} }) {
  return {
    status: classification.status,
    code: classification.code,
    message: classification.message,
    httpStatus: Number(classification.httpStatus || 0),
    checkedAt,
    latencyMs,
    planType: text(classification.planType),
    subscriptionPlan: text(classification.subscriptionPlan),
    hasActiveSubscription: classification.hasActiveSubscription === true,
    hasPreviouslyPaid: classification.hasPreviouslyPaid === true,
    activeTrial: classification.activeTrial === true,
    defaultOfferId: text(classification.defaultOfferId),
    campaigns: Array.isArray(classification.campaigns) ? classification.campaigns : [],
    offerKind: text(classification.offerKind),
    offerLabel: text(classification.offerLabel),
    // Which plan the headline offer sits on. Persisted because a free month on
    // Go and a free month on Plus read identically without it, and the chain
    // now checks out whichever plan the campaign actually belongs to.
    offerPlan: text(classification.offerPlan),
    offerPlanLabel: text(classification.offerPlanLabel),
    freeMonthOffer: classification.freeMonthOffer === true,
    lastTrialAt: classification.status === 'trial' ? checkedAt : text(previous.lastTrialAt),
  };
}

async function checkSessionAssetTrial(asset, options = {}) {
  const clock = options.now || Date.now;
  const startedAt = clock();
  const previous = asset.trial && typeof asset.trial === 'object' ? asset.trial : {};
  const accessToken = text(asset.accessToken);
  if (!accessToken) {
    const checkedAt = new Date(clock()).toISOString();
    return publicResult(asset, trialRecord(
      classified('unknown', 'TRIAL_AT_MISSING', 'Login-state asset does not contain an access token', { httpStatus: 0 }),
      { checkedAt, latencyMs: Math.max(0, clock() - startedAt), previous },
    ));
  }

  // `proxyFor` lets a batch draw a different exit per asset; a plain `proxy`
  // still works for the single-exit callers.
  const proxy = typeof options.proxyFor === 'function'
    ? text(options.proxyFor(asset))
    : text(options.proxy || options.trialCheckProxy);

  const controller = new AbortController();
  const timeoutMs = Math.max(1000, Math.min(60000, Number(options.timeoutMs || DEFAULT_TIMEOUT_MS)));
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('Promo check timed out'));
  }, timeoutMs);
  let classification;
  try {
    const session = new UrlSession({
      clientProfile: asset.clientProfile || {},
      proxy: proxy || DEFAULT_TRIAL_CHECK_PROXY,
      signal: controller.signal,
      executor: options.executor,
    });
    const headers = {
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
    };
    const accountId = text(asset.accountId);
    if (accountId) headers['ChatGPT-Account-ID'] = accountId;
    if (text(asset.oaiDid)) headers['OAI-Device-Id'] = text(asset.oaiDid);
    const result = await session.once('GET', trialCheckUrl(clock), {
      origin: CHATGPT_BASE,
      referer: `${CHATGPT_BASE}/`,
      headers,
      timeoutMs,
    });
    classification = classifyTrialResponse(asset, result);
  } catch (error) {
    classification = timedOut || error?.name === 'AbortError'
      ? classified('unknown', 'TRIAL_CHECK_TIMEOUT', 'Promo check timed out', { httpStatus: 0 })
      : classified('unknown', 'TRIAL_NETWORK_ERROR', 'Promo check failed before receiving an HTTP response', { httpStatus: 0 });
  } finally {
    clearTimeout(timer);
  }

  const checkedAt = new Date(clock()).toISOString();
  return publicResult(asset, trialRecord(classification, {
    checkedAt,
    latencyMs: Math.max(0, clock() - startedAt),
    previous,
  }));
}

async function checkSessionAssetTrials(store, assetIds, options = {}) {
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
      const result = await checkSessionAssetTrial(asset, options);
      const trial = trialRecord(result, {
        checkedAt: result.checkedAt,
        latencyMs: result.latencyMs,
        previous: asset.trial || {},
      });
      const current = store.get(asset.id);
      if (text(current.accessToken) !== text(asset.accessToken)) {
        // The asset was refreshed underneath the check; the measurement no
        // longer describes the token that is now stored.
        trial.status = 'unknown';
        trial.code = 'TRIAL_AT_CHANGED_DURING_CHECK';
        trial.message = 'Access token changed while the promo check was running';
        trial.httpStatus = 0;
        trial.campaigns = [];
        trial.offerKind = '';
        trial.offerLabel = '';
        trial.freeMonthOffer = false;
        trial.lastTrialAt = text(current.trial?.lastTrialAt);
      }
      store.update(asset.id, { trial });
      results[index] = { ...result, trialAvailable: trial.status === 'trial', ...trial };
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
  DEFAULT_TRIAL_CHECK_PROXY,
  checkSessionAssetTrial,
  checkSessionAssetTrials,
  classifyTrialResponse,
  trialRecord,
};
