'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { atomicWriteText } = require('./ui-server/utils');
const { safeAssetId } = require('./session-asset-store');
const { assetGrouping, chainQueueEligible, qualifiesForChain } = require('./session-asset-grouping');
const { clone, truthyText: text } = require('./util/shared');

const CHAIN_SCHEMA_VERSION = 1;
// `deactivated` is deliberately its own terminal state rather than a failure.
// OpenAI closing an account is a fact about the account, not something that went
// wrong with the extraction — counting it as a failure buried the real failures
// and made the success rate meaningless.
const CHAIN_STATUSES = new Set(['pending', 'running', 'success', 'failed', 'deactivated']);
const PAYMENT_STATUSES = new Set(['pending', 'success', 'failed']);
const PAYMENT_REFRESH_STATUSES = new Set(['idle', 'pending', 'queued', 'running', 'complete', 'failed']);
const MAX_ATTEMPT_HISTORY = 10;

function nowIso(now = Date.now) {
  return new Date(now()).toISOString();
}

/**
 * Payment is a separate lifecycle from extraction. Legacy ledgers only have
 * the PayPal follow-up status, so derive a value until the next write makes it
 * explicit. A generated PayPal URL is deliberately still pending: it is not
 * evidence that the provider-side payment was completed.
 */
function paymentStatus(record = {}) {
  const explicit = text(record.paymentStatus);
  if (PAYMENT_STATUSES.has(explicit)) return explicit;
  const followup = text(record.paypalFollowup?.status);
  if (followup === 'completed') return 'success';
  if (followup === 'failed') return 'failed';
  return 'pending';
}

function paymentRefreshState(record = {}) {
  const raw = record.paymentRefresh && typeof record.paymentRefresh === 'object'
    ? record.paymentRefresh
    : {};
  const stored = text(raw.status);
  const status = PAYMENT_REFRESH_STATUSES.has(stored)
    ? stored
    : 'idle';
  return {
    status,
    runId: text(raw.runId),
    requestedAt: text(raw.requestedAt),
    queuedAt: text(raw.queuedAt),
    startedAt: text(raw.startedAt),
    completedAt: text(raw.completedAt),
    lastError: clone(raw.lastError || null),
  };
}

/** Redacted access-token preview for operator-facing chain records. */
function maskedToken(token) {
  const value = text(token);
  if (!value) return '';
  return value.length <= 24 ? `${value.slice(0, 6)}…` : `${value.slice(0, 12)}…${value.slice(-8)}`;
}

function recordSummary(record = {}) {
  return {
    schemaVersion: CHAIN_SCHEMA_VERSION,
    id: record.id,
    assetId: record.assetId || record.id,
    email: record.email || '',
    accountId: record.accountId || '',
    sourceKind: record.sourceKind || '',
    sourceCountryCode: record.sourceCountryCode || '',
    assetLifecycle: record.assetLifecycle || '',
    assetNextAction: record.assetNextAction || '',
    assetFacets: Array.isArray(record.assetFacets) ? [...record.assetFacets] : [],
    chainEligible: record.chainEligible === undefined || record.chainEligible === null
      ? null
      : record.chainEligible === true,
    accessTokenPreview: record.accessTokenPreview || '',
    hasAccessToken: record.hasAccessToken === true,
    status: record.status || 'pending',
    paymentStatus: paymentStatus(record),
    // A failed run still knows what it created, so the kind falls back to what
    // the attempt observed rather than going blank.
    sessionKind: record.result?.sessionKind || record.sessionKind || '',
    sessionKindLabel: record.result?.sessionKindLabel || record.sessionKindLabel || '',
    checkoutUpdateApplied: record.result?.checkoutUpdateApplied ?? null,
    attempts: Number(record.attempts || 0),
    createdAt: record.createdAt || '',
    updatedAt: record.updatedAt || '',
    startedAt: record.startedAt || '',
    finishedAt: record.finishedAt || '',
    trialCheckedAt: record.trialCheckedAt || '',
    result: clone(record.result || null),
    lastError: clone(record.lastError || null),
    request: clone(record.request || null),
    // The external engine's job for a row still in flight. Surfaced because the
    // reconciler reads the ledger through this projection, and the console
    // links a running row to the job that is producing it.
    // An explicit provider/route chosen at import, overriding the country rule.
    routeProvider: record.routeProvider || '',
    routeKey: record.routeKey || '',
    linkopsJobId: record.linkopsJobId || '',
    linkopsProvider: record.linkopsProvider || '',
    // How many proxy rotations this row has already spent. Projected because
    // the reconciler reads the ledger through here and needs to stop.
    linkopsRetryCount: Number(record.linkopsRetryCount || 0),
    // The payment stage that follows an extracted link, where the provider has
    // one. Held on the row so the console can pair a link with its payment job.
    paymentJobId: record.paymentJobId || '',
    paymentProvider: record.paymentProvider || '',
    paymentPhone: record.paymentPhone || '',
    paymentRefresh: paymentRefreshState(record),
  };
}

class ChainStore {
  constructor(options = {}) {
    this.cwd = path.resolve(options.cwd || process.cwd());
    this.stateRoot = path.resolve(this.cwd, options.stateDir || '.gpt-re-state/v2');
    this.filePath = path.join(this.stateRoot, 'chain-links.json');
    this.now = options.now || Date.now;
  }

  read() {
    try {
      const value = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (value.schemaVersion !== CHAIN_SCHEMA_VERSION) throw new Error(`Unsupported chain schema: ${value.schemaVersion}`);
      return { schemaVersion: CHAIN_SCHEMA_VERSION, records: value.records && typeof value.records === 'object' ? value.records : {} };
    } catch (error) {
      if (error.code === 'ENOENT') return { schemaVersion: CHAIN_SCHEMA_VERSION, records: {} };
      // A corrupt ledger must not take the page down; extraction results are
      // reproducible, so an empty ledger is a safe fallback.
      return { schemaVersion: CHAIN_SCHEMA_VERSION, records: {} };
    }
  }

  write(state) {
    fs.mkdirSync(this.stateRoot, { recursive: true });
    atomicWriteText(this.filePath, `${JSON.stringify(state, null, 2)}\n`);
    return state;
  }

  /**
   * Mirrors queue-eligible login-state assets into the ledger. New trial
   * accounts appear as `pending`; records whose asset lost its queue eligibility
   * are dropped unless they are already running or produced a link worth keeping.
   */
  sync(assets = []) {
    const state = this.read();
    const at = nowIso(this.now);
    const seen = new Set();
    let changed = false;
    for (const asset of assets) {
      const id = text(asset.id);
      if (!id) continue;
      const existing = state.records[id];
      const grouping = assetGrouping(asset);
      const chainEligible = chainQueueEligible(asset);
      // A row already being consumed must remain addressable until its worker
      // settles. A successful link is historical output and must remain visible
      // even after the asset no longer has a current offer.
      const preserveExisting = Boolean(existing && (existing.status === 'running' || existing.result?.paypalUrl));
      if (!chainEligible && !preserveExisting) continue;
      seen.add(id);
      const next = {
        ...(existing || {}),
        schemaVersion: CHAIN_SCHEMA_VERSION,
        id,
        assetId: id,
        email: text(asset.email),
        accountId: text(asset.accountId),
        sourceKind: text(asset.sourceKind) || text(existing?.sourceKind),
        sourceCountryCode: text(asset.sourceProxy?.countryCode) || text(existing?.sourceCountryCode),
        assetLifecycle: grouping.lifecycle,
        assetNextAction: grouping.nextAction,
        assetFacets: [...grouping.facets],
        chainEligible,
        hasAccessToken: Boolean(asset.hasAccessToken || asset.accessToken),
        accessTokenPreview: maskedToken(asset.accessToken) || text(existing?.accessTokenPreview),
        trialCheckedAt: text(asset.trial?.checkedAt),
        // Which promo this row would redeem. Carried onto the chain record so
        // the extraction page can show, before anything is run, that a free
        // month sitting on Go produces a Go subscription rather than Plus.
        offerLabel: text(asset.trial?.offerLabel),
        offerPlan: text(asset.trial?.offerPlan),
        status: existing?.status || 'pending',
        // A missing payment status is intentionally left missing here. The
        // list/detail projection derives `pending` from the follow-up record,
        // but a GET /chains poll must not turn that derived value into a disk
        // write while another task is still running.
        ...(existing && Object.hasOwn(existing, 'paymentStatus')
          ? { paymentStatus: paymentStatus(existing) }
          : {}),
        attempts: Number(existing?.attempts || 0),
        createdAt: existing?.createdAt || at,
        updatedAt: existing?.updatedAt || at,
      };
      if (JSON.stringify(existing || null) !== JSON.stringify(next)) {
        state.records[id] = next;
        changed = true;
      }
    }
    for (const [id, record] of Object.entries(state.records)) {
      if (seen.has(id) || record.result?.paypalUrl || record.status === 'running') continue;
      delete state.records[id];
      changed = true;
    }
    if (changed) this.write(state);
    return this.list();
  }

  list() {
    const state = this.read();
    return Object.values(state.records)
      .map(recordSummary)
      .sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
  }

  get(id) {
    const record = this.read().records[safeAssetId(id)];
    if (!record) {
      throw Object.assign(new Error(`Chain record not found: ${id}`), { code: 'CHAIN_RECORD_NOT_FOUND' });
    }
    return recordSummary(record);
  }

  update(id, patch = {}) {
    const key = safeAssetId(id);
    const state = this.read();
    const existing = state.records[key];
    if (!existing) throw Object.assign(new Error(`Chain record not found: ${id}`), { code: 'CHAIN_RECORD_NOT_FOUND' });
    const next = { ...existing, ...clone(patch), id: key, updatedAt: nowIso(this.now) };
    if (patch.status && !CHAIN_STATUSES.has(patch.status)) throw new Error(`Unsupported chain status: ${patch.status}`);
    if (Object.hasOwn(patch, 'paymentStatus') && !PAYMENT_STATUSES.has(patch.paymentStatus)) {
      throw new Error(`Unsupported payment status: ${patch.paymentStatus}`);
    }
    state.records[key] = next;
    this.write(state);
    return recordSummary(next);
  }

  markPaymentStatus(ids = [], status = 'pending') {
    if (!PAYMENT_STATUSES.has(status)) throw new Error(`Unsupported payment status: ${status}`);
    const requested = Array.isArray(ids) ? ids : [];
    const keys = [...new Set(requested.map((id) => safeAssetId(id)))];
    const state = this.read();
    const changed = [];
    const missing = [];
    const at = nowIso(this.now);
    for (const key of keys) {
      const record = state.records[key];
      if (!record) {
        missing.push(key);
        continue;
      }
      const previousStatus = paymentStatus(record);
      const previousRefresh = paymentRefreshState(record);
      // Only a real transition into payment success creates a refresh event.
      // A legacy record can project `paymentStatus=success` from a completed
      // PayPal follow-up, but that is not a newly marked event and must not
      // cause the maintenance robot to refresh it retroactively.
      const needsRefreshInitialization = status === 'success' && previousStatus !== 'success';
      if (previousStatus === status && record.paymentStatus === status && !needsRefreshInitialization) continue;
      let nextRefresh = previousRefresh;
      if (status === 'success' && (previousStatus !== 'success' || needsRefreshInitialization)) {
        nextRefresh = {
          status: 'pending',
          runId: '',
          requestedAt: at,
          queuedAt: '',
          startedAt: '',
          completedAt: '',
          lastError: null,
        };
      } else if (status !== 'success' && previousStatus === 'success') {
        nextRefresh = {
          status: 'idle',
          runId: '',
          requestedAt: '',
          queuedAt: '',
          startedAt: '',
          completedAt: '',
          lastError: null,
        };
      }
      state.records[key] = { ...record, paymentStatus: status, paymentRefresh: nextRefresh, updatedAt: at };
      changed.push(key);
    }
    if (changed.length) this.write(state);
    return { requested: requested.length, status, changed, missing };
  }

  markRunning(id, request = {}) {
    const at = nowIso(this.now);
    return this.update(id, {
      status: 'running',
      startedAt: at,
      finishedAt: '',
      lastError: null,
      // A new attempt supersedes the last one. Without this the record mixes two
      // runs: the console reads the billing country, the amount and the PayPal
      // link off `result`, so re-running with a different country kept showing
      // the old one — and a re-run that failed still offered the previous link
      // next to its own error, which is a link nobody should be copying.
      result: null,
      // What this attempt was dispatched with. Proxies are the external
      // engine's business now, so only the target country is worth keeping.
      request: {
        country: text(request.country),
        provider: text(request.provider),
        startedAt: at,
      },
    });
  }

  markSuccess(id, result = {}) {
    const record = this.read().records[safeAssetId(id)] || {};
    return this.update(id, {
      status: 'success',
      finishedAt: nowIso(this.now),
      attempts: Number(record.attempts || 0) + 1,
      lastError: null,
      result: clone(result),
    });
  }

  markDeactivated(id, error = {}) {
    const at = nowIso(this.now);
    return this.update(id, {
      status: 'deactivated',
      finishedAt: at,
      lastError: {
        code: text(error.code) || 'ACCOUNT_DEACTIVATED',
        message: text(error.message) || '账号已被 OpenAI 注销',
        at,
        stages: Array.isArray(error.stages) ? clone(error.stages) : [],
      },
    });
  }

  markFailed(id, error = {}) {
    const record = this.read().records[safeAssetId(id)] || {};
    const history = Array.isArray(record.errorHistory) ? record.errorHistory : [];
    const failure = {
      code: text(error.code) || 'CHAIN_EXTRACTION_FAILED',
      message: text(error.message) || 'Chain extraction failed',
      at: nowIso(this.now),
      ...(Number(error.status || error.httpStatus || 0) > 0
        ? { status: Number(error.status || error.httpStatus) }
        : {}),
    };
    // The stage feed only explains the attempt being looked at right now, so it
    // rides on `lastError` and is deliberately kept out of the retained history.
    const stages = Array.isArray(error.stages) ? clone(error.stages) : [];
    return this.update(id, {
      status: 'failed',
      finishedAt: failure.at,
      attempts: Number(record.attempts || 0) + 1,
      lastError: { ...failure, stages },
      errorHistory: [...history, failure].slice(-MAX_ATTEMPT_HISTORY),
      ...(text(error.sessionKind) ? {
        sessionKind: text(error.sessionKind),
        sessionKindLabel: text(error.sessionKindLabel),
        checkoutSessionId: text(error.checkoutSessionId),
      } : {}),
    });
  }

  remove(ids = []) {
    const state = this.read();
    const removed = [];
    const missing = [];
    for (const rawId of ids) {
      const id = safeAssetId(rawId);
      if (state.records[id]) {
        delete state.records[id];
        removed.push(id);
      } else missing.push(id);
    }
    if (removed.length) this.write(state);
    return { requested: ids.length, removed, missing };
  }
}

module.exports = {
  PAYMENT_STATUSES,
  ChainStore,
  maskedToken,
  paymentStatus,
  qualifiesForChain,
  recordSummary,
};
