'use strict';

const path = require('node:path');

const { parseAccessTokenInput } = require('../access-token-import');
const { ChainStore, PAYMENT_STATUSES, paymentStatus } = require('../chain-store');
const { safeAssetId } = require('../session-asset-store');
const { normalizedCountry } = require('../chain-countries');
const { BILLING_COUNTRIES, PROXY_REGIONS, dispatchOptionsFor, normalizeRoute, paymentProviderFor, providerDescriptor, providerForCountry, proxyPoolId, requiredProxyPools } = require('../chain-routing');
const { probeSessionAsset } = require('../session-asset-health');
const { checkSessionAssetTrial, trialRecord } = require('../session-trial-check');
const { isChainRedeemableTrial } = require('../trial-offer');
const { assetLifecycle, assetNextAction, chainQueueEligible } = require('../session-asset-grouping');
const { HttpError, mapLimit } = require('./utils');
const { truthyText: text } = require('../util/shared');



/** The external engine answers in snake_case; the ledger stores camelCase. */
function chainResultFromJob(job = {}) {
  const result = job.result || {};
  const paypalUrl = text(result.paypal_url) || text(result.provider_url);
  return {
    ok: true,
    paypalUrl,
    providerUrl: text(result.provider_url),
    accountEmail: text(result.account_email),
    checkoutSessionId: text(result.checkout_session_id),
    sessionKind: text(result.session_kind),
    sessionKindLabel: text(result.session_kind),
    billingCountry: text(result.billing_country),
    currency: text(result.currency),
    paymentMethod: text(result.payment_method),
    amountDue: Number(result.amount_due || 0),
    transport: 'linkops',
  };
}

/**
 * The seam the external engine plugs into.
 *
 */

/**
 * Failures a different exit could plausibly fix.
 *
 * Matched against the engine's own message, which `redact()` strips of proxy
 * URLs but leaves descriptive. Deliberately narrow: rotating costs a proxy and
 * a run, so anything that is the account's problem (no MoMo method, an
 * unparseable token) or the configuration's (an empty, expired or unnamed pool
 * — where the next entry comes from the same unusable pool) must fail on the
 * first attempt rather than burn the budget proving it.
 */
const PROXY_FAILURE_PATTERNS = [
  // Preflight is the engine's own verdict that this exit does not work.
  /代理预检/,
  /proxy preflight/i,
  /代理连接失败/,
  // Transport-level failures reaching the exit at all.
  /curl:?\s*\(\d+\)/i,
  /\b(?:ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE)\b/,
  /connection (?:reset|refused|aborted|closed)/i,
  /tunnel connection failed/i,
  /max retries exceeded/i,
  /(?:read |connect(?:ion)? )?time(?:d )?out/i,
  /\b(?:SSL|TLS)\b.*\b(?:error|handshake)\b/i,
  /remote end closed connection/i,
];

/**
 * True when a different exit is worth trying.
 *
 * Configuration failures are excluded first: several of them say "代理" too,
 * but the next entry would come from the same pool that is already empty or
 * expired, so a rotation cannot help and `retry_options` would refuse anyway.
 */
const PROXY_CONFIG_PATTERNS = [
  /代理池(?:已过期|不存在|为空)/,
  /没有可用代理/,
  /没有可用的 \S+ 重试代理/,
  /请先(?:选择|配置)/,
  /国家不能为空/,
  /没有可用候选/,
];

function isProxyFailure(message) {
  const value = text(message);
  if (!value) return false;
  if (PROXY_CONFIG_PATTERNS.some((pattern) => pattern.test(value))) return false;
  return PROXY_FAILURE_PATTERNS.some((pattern) => pattern.test(value));
}

const MAX_BATCH = 50;
/**
 * How many rows one dispatch may carry, and how they are cut into engine calls.
 *
 * The engine expands one job per token inside a single call, so a 200-token
 * call is one long request whose failure loses the whole batch. Cutting it into
 * chunks bounds that blast radius and lets several calls be in flight at once —
 * the engine queues internally, so the console's job is to fill that queue
 * quickly, not to feed it one row at a time.
 */
const MAX_DISPATCH = 200;
const DISPATCH_CHUNK = 20;
const MAX_IMPORT = 200;
const IMPORT_CONCURRENCY = 4;
// AT probes are one cheap request each through the local forwarder, so they can
// run wider than an extraction — but not unbounded, because they all share that
// single forwarder.
const PROBE_CONCURRENCY = 8;
// Verdicts that mean the token is gone rather than merely unverifiable. Only
// these turn a row red; `unknown` says the probe failed, not the account.
const DEAD_TOKEN_STATUSES = new Set(['invalid', 'banned', 'missing']);
class ChainService {
  constructor(options = {}) {
    this.cwd = path.resolve(options.cwd || process.cwd());
    this.configService = options.configService;
    this.proxyService = options.proxyService;
    this.sessionAssets = options.sessionAssets;
    // Registration runs own the login-state asset while they are active or
    // resumable. Keep that ownership check at the service boundary so manual
    // chain metadata updates cannot race a registration checkpoint.
    this.sessionAssetIdsInUse = options.sessionAssetIdsInUse || null;
    // The external engine. Absent in unit tests that only exercise projection.
    this.linkops = options.linkops || null;
    this.reconcileTimer = null;
    // Injected for tests; both calls are plain HTTP against chatgpt.com.
    this.probeToken = options.probeToken || probeSessionAsset;
    this.checkTrial = options.checkTrial || checkSessionAssetTrial;
    this.storeOverride = options.store || null;
    this.storeCache = null;
    // Chain id -> the last AT verdict, held in memory only. Deliberately not
    // written to the asset store: this is a spot check the operator runs before
    // spending exits on a batch, not a health record the rest of the console
    // should start trusting.
    this.tokenHealth = new Map();
    this.now = options.now || Date.now;
  }

  /**
   * Console defaults for the extraction form. The config file is the source of
   * truth, but it is re-clamped here so a hand-edited file that bypassed schema
   * validation still cannot hand the runner an absurd budget.
   */
  /**
   * Extraction rules keyed by the country the account was *registered* from.
   *
   * One global billing country and one pool pair was never quite right: an
   * account registered on a TH exit and billed through a GB pool trips the
   * mismatch checks that a same-country route sails through. The registration
   * country is already on every row (`sourceCountryCode`), so it is the natural
   * key — the operator writes the routing once per country and the batch stops
   * needing a decision per run.
   *
   * `default` is the fallback for a row whose registration country has no rule
   * of its own, including rows with no recorded country at all.
   */
  /**
   * The routing table, as three country axes per registration country.
   *
   * `checkoutCountry` picks the proxy pool, `billingCountry` picks the billing
   * profile, and `updateCountry` picks the update hop's pool — the engine
   * validates each against a different table, so they are stored apart. Legacy
   * files wrote them as `country` / `checkoutPool` / `updatePool`.
   */
  countryRules() {
    const chain = this.configService?.readRaw?.().chain || {};
    const settings = this.settings();
    const fallback = normalizeRoute({ billingCountry: settings.country, checkoutCountry: settings.country });
    // Stored as a list, read as a table. The object form is what an older
    // config file holds, and is still understood.
    const stored = Array.isArray(chain.countryRules)
      ? chain.countryRules.map((entry) => [text(entry?.sourceCountryCode) || 'default', entry])
      : Object.entries(chain.countryRules && typeof chain.countryRules === 'object' ? chain.countryRules : {});
    const merge = (base, value) => {
      const route = normalizeRoute(value);
      return {
        billingCountry: route.billingCountry || base.billingCountry,
        checkoutCountry: route.checkoutCountry || base.checkoutCountry,
        updateCountry: route.updateCountry || base.updateCountry,
        applyCheckoutUpdate: value && Object.hasOwn(value, 'applyCheckoutUpdate')
          ? value.applyCheckoutUpdate !== false
          : base.applyCheckoutUpdate,
      };
    };
    const rules = { default: { ...fallback } };
    for (const [key, value] of stored) {
      if (text(key).toLowerCase() !== 'default') continue;
      rules.default = merge(fallback, value);
    }
    for (const [key, value] of stored) {
      const code = text(key).toUpperCase();
      if (!code || code === 'DEFAULT') continue;
      rules[code] = merge(rules.default, value);
    }
    return rules;
  }

  saveCountryRules(payload = {}) {
    const incoming = payload && typeof payload === 'object' ? (payload.rules || payload) : {};
    if (!incoming || typeof incoming !== 'object') throw new HttpError(400, 'Country rules must be an object');
    const entries = Array.isArray(incoming)
      ? incoming.map((entry) => [text(entry?.sourceCountryCode) || 'default', entry])
      : Object.entries(incoming);
    const cleaned = [];
    const provided = new Map();
    const seen = new Set();
    for (const [key, value] of entries) {
      const code = text(key).toLowerCase() === 'default' ? 'default' : text(key).toUpperCase();
      if (!code || seen.has(code)) continue;
      seen.add(code);
      const route = normalizeRoute(value);
      cleaned.push({ sourceCountryCode: code, ...route });
      provided.set(code, route);
    }

    // A rule is an override, so each row is validated after inheritance rather
    // than as written — a table must not be saveable in a state that is
    // guaranteed to be refused on its first dispatch.
    const current = this.countryRules();
    const defaultRule = { ...current.default, ...Object.fromEntries(Object.entries(provided.get('default') || {}).filter(([, value]) => value !== '')) };
    for (const [code, route] of provided) {
      const effective = code === 'default'
        ? defaultRule
        : { ...defaultRule, ...Object.fromEntries(Object.entries(route).filter(([, value]) => value !== '')) };
      const label = code === 'default' ? '默认' : code;
      if (effective.checkoutCountry && !PROXY_REGIONS.includes(effective.checkoutCountry)) {
        throw new HttpError(400, `${label}：Checkout 代理区域 ${effective.checkoutCountry} 不是可用的代理源区域`);
      }
      if (effective.updateCountry && !PROXY_REGIONS.includes(effective.updateCountry)) {
        throw new HttpError(400, `${label}：Update 代理区域 ${effective.updateCountry} 不是可用的代理源区域`);
      }
      if (effective.billingCountry && !BILLING_COUNTRIES.includes(effective.billingCountry)) {
        throw new HttpError(400, `${label}：账单国家 ${effective.billingCountry} 没有对应的账单档案（${BILLING_COUNTRIES.join(' ')}）`);
      }
    }
    // `update` takes `{ config }` and deep-merges it, so only the branch that
    // changed is sent — passing the whole file merged it onto itself and, when
    // handed the bare config, silently wrote nothing at all.
    this.configService.update({ config: { chain: { countryRules: cleaned } } });
    return this.countryRules();
  }

  settings() {
    const chain = this.configService?.readRaw?.().chain || {};
    let country = 'GB';
    try { country = normalizedCountry(chain.country); } catch { country = 'GB'; }
    return { country };
  }

  /** The stable local forwarder every import call goes out through. */
  maintenanceProxy() {
    return text(this.configService?.readRaw?.().proxyPool?.maintenanceProxy) || 'http://127.0.0.1:7890';
  }

  /**
   * Admits pasted access tokens into the extraction queue.
   *
   * Two calls per token, both through the local forwarder: `/backend-api/me` to
   * learn who the token belongs to, then the promo check. Only a claimable
   * one-month free campaign is saved — a discounted run cannot be redeemed by
   * `checkout/update`, so importing one would just queue a guaranteed failure.
   *
   * Nothing is written for a token that does not pass, and every input line
   * comes back with a reason, so a rejected batch can be understood without
   * reading the server log.
   */
  /**
   * An explicit routing choice made at import time.
   *
   * Without one a row is routed by where it was registered, which is right for
   * most accounts. Choosing here is for the case the registration country does
   * not decide — the same token could be run as a PayPal checkout from any of
   * the configured routes. The PayPal second level names an existing route
   * rather than a loose country, so there is still one table to keep correct.
   */
  normalizeImportRoute(payload = {}) {
    const provider = text(payload.provider).toLowerCase();
    // The import used to accept no provider and leave the row to be routed by
    // its registration country at extraction time. An imported access token has
    // no registration of ours behind it, so that country was whatever the
    // previous owner registered in — a guess dressed up as a rule. The operator
    // names the route now, and `providerForCountry` stays for the registered
    // rows where the country is actually ours.
    if (!provider) throw new HttpError(400, '导入访问令牌时必须选择提链方式');
    const descriptor = providerDescriptor(provider);
    if (!descriptor) throw new HttpError(400, `未知的提链 provider：${provider}`);
    if (descriptor.fixedCountry) return { routeProvider: provider, routeKey: '' };
    const rules = this.countryRules();
    const routeKey = text(payload.routeKey) || 'default';
    const key = routeKey.toLowerCase() === 'default' ? 'default' : routeKey.toUpperCase();
    if (!rules[key]) throw new HttpError(400, `路由表里没有「${key}」这条路线`);
    const resolved = dispatchOptionsFor(provider, rules[key]);
    if (resolved.error) throw new HttpError(400, `路线「${key}」不可用：${resolved.error}`);
    return { routeProvider: provider, routeKey: key };
  }

  async importTokens(payload = {}) {
    if (!this.sessionAssets) throw new HttpError(500, 'Login-state storage is not available');
    // Validated before any network work, so a bad choice fails immediately
    // rather than after screening two hundred tokens.
    const route = this.normalizeImportRoute(payload);
    const { entries, rejected } = parseAccessTokenInput(payload.content);
    const skipped = rejected.map((entry) => ({ ...entry, imported: false }));
    if (!entries.length) {
      if (!skipped.length) throw new HttpError(400, 'Paste at least one access token');
      return { requested: skipped.length, imported: 0, admitted: [], rejected: skipped };
    }
    if (entries.length > MAX_IMPORT) throw new HttpError(400, `Import at most ${MAX_IMPORT} access tokens at a time`);

    const proxy = this.maintenanceProxy();
    const store = this.sessionAssets();
    const admitted = [];
    const results = new Array(entries.length);
    let cursor = 0;

    const worker = async () => {
      for (;;) {
        const index = cursor;
        cursor += 1;
        if (index >= entries.length) return;
        results[index] = await this.screenToken(entries[index], { proxy, store });
      }
    };
    await Promise.all(Array.from(
      { length: Math.max(1, Math.min(IMPORT_CONCURRENCY, entries.length)) },
      () => worker(),
    ));

    for (const result of results) {
      if (result.imported) admitted.push(result);
      else skipped.push(result);
    }
    if (admitted.length) {
      // The chain row is a projection of the asset, so it has to exist before
      // the choice can be written onto it.
      const chainStore = this.store();
      chainStore.sync(store.list());
      for (const item of admitted) {
        try { chainStore.update(item.assetId, route); } catch { /* Not chain-eligible; the choice has nothing to sit on. */ }
      }
    }
    return {
      requested: entries.length + rejected.length,
      imported: admitted.length,
      admitted,
      rejected: skipped.sort((left, right) => Number(left.line || 0) - Number(right.line || 0)),
    };
  }

  /**
   * Identity, then promo, then save. Returns one row for the console either way.
   */
  async screenToken(entry, { proxy, store }) {
    const row = { line: entry.line, email: entry.email, imported: false };
    const probe = await this.probeToken({ email: entry.email, accessToken: entry.accessToken }, { proxy });
    if (probe.status !== 'healthy') {
      return { ...row, code: probe.code, reason: probe.status === 'invalid' ? 'AT 已失效' : `AT 无法验证（${probe.code}）` };
    }
    // These tokens come from outside, so nothing is expected to exist locally.
    // The paste wins if it carried an address, otherwise `/backend-api/me` is
    // asked; the account id is the last resort, because the store keys assets
    // by identity and an unlabelled row is worse than an ugly one.
    const accountId = text(probe.identity?.accountIds?.[0]);
    const email = text(entry.email) || text(probe.identity?.emails?.[0]) || accountId;
    if (!email) return { ...row, code: 'IDENTITY_UNKNOWN', reason: 'AT 没有暴露任何身份，无法入库' };
    row.email = email;

    const checked = await this.checkTrial({ email, accountId, accessToken: entry.accessToken }, { proxy });
    const trial = trialRecord(checked, {
      checkedAt: text(checked.checkedAt) || new Date().toISOString(),
      latencyMs: Number(checked.latencyMs || 0),
      previous: {},
    });
    if (trial.status !== 'trial') {
      return { ...row, code: trial.code, reason: trial.status === 'none' ? '没有可领的优惠' : `优惠检测未完成（${trial.code}）` };
    }
    // Plus specifically. A Go free month is claimable but buys a Go
    // subscription, so admitting it would queue a link nobody wants.
    if (!isChainRedeemableTrial(trial)) {
      return { ...row, code: 'TRIAL_NOT_PLUS_FREE_MONTH', reason: `${trial.offerLabel || '折扣试用'}，不是 Plus 一个月免费` };
    }

    const saved = store.upsert({
      email,
      accountId,
      accessToken: entry.accessToken,
      status: 'valid',
      planType: text(checked.planType),
      trial,
      sourceKind: 'imported_at',
      lastValidatedAt: trial.checkedAt,
    });
    return { ...row, imported: true, assetId: saved.id, offerLabel: trial.offerLabel, code: trial.code, reason: trial.offerLabel || '一个月免费' };
  }

  store() {
    if (this.storeOverride) return this.storeOverride;
    const stateDir = this.configService?.readRaw?.().output?.stateDir || '.gpt-re-state/v2';
    const key = path.resolve(this.cwd, stateDir);
    if (!this.storeCache || this.storeCache.key !== key) {
      this.storeCache = { key, store: new ChainStore({ cwd: this.cwd, stateDir }) };
    }
    return this.storeCache.store;
  }

  snapshot() {
    const assets = this.sessionAssets ? this.sessionAssets().list() : [];
    const records = this.store().sync(assets);
    const rules = this.countryRules();
    // The reconciler is self-terminating, so a row left in flight by a previous
    // process would otherwise wait for the next dispatch to wake anything up.
    // Opening the console is the natural moment to resume it.
    if (records.some((record) => text(record.status) === 'running' || (text(record.paymentJobId) && paymentStatus(record) === 'pending'))) {
      this.startReconciler();
    }
    return {
      records: records.map((record) => ({
        ...record,
        // A row is "running" when the external engine still owns a job for it.
        running: text(record.status) === 'running' && Boolean(text(record.linkopsJobId)),
        tokenHealth: this.tokenHealth.get(record.id) || null,
      })),
      // The two axes the routing table is validated against; the console needs
      // both because they are different tables, not one shared country list.
      proxyRegions: PROXY_REGIONS,
      billingCountries: BILLING_COUNTRIES,
      settings: this.settings(),
      countryRules: rules,
      // The pools this routing will actually draw from, so the console lists
      // what needs stocking instead of every provider×country×role triple.
      proxyPools: requiredProxyPools(rules),
    };
  }

  detail(id) {
    const record = this.store().get(id);
    return {
      ...record,
      running: text(record.status) === 'running' && Boolean(text(record.linkopsJobId)),
      tokenHealth: this.tokenHealth.get(record.id) || null,
    };
  }

  /**
   * The full access token behind one ledger row, for the console's copy button.
   * Snapshots never carry it; it is read on demand, one row at a time.
   */
  accessToken(id) {
    const record = this.store().get(id);
    return { id: record.id, email: record.email || '', token: this.accessTokenFor(record.assetId || record.id) };
  }

  /**
   * Spot-check the access tokens behind the selected rows.
   *
   * Reuses the login-state probe verbatim — same request, same local forwarder —
   * but keeps the verdict here instead of writing it onto the asset. Two reasons
   * to keep it separate: the operator runs this to decide whether a batch is
   * worth starting, not to curate 登录态; and a probe answers for one moment,
   * so persisting it would age into a claim the store cannot back up.
   *
   * A dead token is a normal, expected outcome, so a failed probe is a result
   * rather than an error — the batch always reports on every row it was given.
   */
  async probeTokens(ids = [], options = {}) {
    const requested = Array.isArray(ids) ? ids.map(text).filter(Boolean) : [];
    if (!requested.length) throw new HttpError(400, 'Select at least one chain record');
    if (requested.length > MAX_BATCH) throw new HttpError(400, `Select at most ${MAX_BATCH} accounts`);
    const chainStore = this.store();
    const assetStore = this.sessionAssets ? this.sessionAssets() : null;
    const proxy = text(options.proxy) || this.maintenanceProxy();
    const concurrency = Math.max(1, Math.min(PROBE_CONCURRENCY, requested.length));

    const targets = [];
    for (const id of requested) {
      let record;
      try { record = chainStore.get(id); } catch (error) {
        if (error.code === 'CHAIN_RECORD_NOT_FOUND') continue;
        throw error;
      }
      targets.push(record);
    }
    if (!targets.length) throw new HttpError(404, 'No chain record for the selected account(s)');

    const results = [];
    const queue = [...targets];
    const worker = async () => {
      for (;;) {
        const record = queue.shift();
        if (!record) return;
        const verdict = await this.probeOne(record, { assetStore, proxy });
        this.tokenHealth.set(record.id, verdict);
        results.push({ id: record.id, email: record.email, ...verdict });
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return {
      checked: results.length,
      alive: results.filter((row) => row.status === 'healthy').length,
      dead: results.filter((row) => DEAD_TOKEN_STATUSES.has(row.status)).length,
      results,
    };
  }

  /** One row's verdict, reduced to what a chip has to say. */
  async probeOne(record, { assetStore, proxy }) {
    const checkedAt = new Date(this.now()).toISOString();
    let asset = null;
    try { asset = assetStore?.get(text(record.assetId) || text(record.id)) || null; } catch { asset = null; }
    const accessToken = text(asset?.accessToken);
    if (!accessToken) {
      return { status: 'missing', code: 'AT_MISSING', message: '本地没有这个账号的 AT', checkedAt, latencyMs: 0 };
    }
    try {
      const probe = await this.probeToken({ email: record.email, accessToken }, { proxy });
      return {
        status: text(probe.status) || 'unknown',
        code: text(probe.code),
        message: text(probe.message),
        httpStatus: Number(probe.httpStatus || 0) || 0,
        latencyMs: Number(probe.latencyMs || 0) || 0,
        checkedAt: text(probe.checkedAt) || checkedAt,
      };
    } catch (error) {
      // The probe itself broke — a dead forwarder, say. That is not a verdict
      // on the token, and must not be shown as one.
      return {
        status: 'unknown',
        code: text(error.code) || 'AT_PROBE_FAILED',
        message: text(error.message) || '测活请求失败',
        checkedAt,
        latencyMs: 0,
      };
    }
  }

  accessTokenFor(assetId) {
    let asset;
    try { asset = this.sessionAssets().get(assetId); } catch (error) {
      if (error.code === 'ENOENT') throw new HttpError(404, `Login-state asset no longer exists: ${assetId}`);
      throw error;
    }
    const token = text(asset.accessToken);
    if (!token) throw new HttpError(409, `Login-state asset has no access token: ${asset.email || assetId}`);
    return token;
  }

  /**
   * Re-read the asset at submit time. The chain ledger is a projection and may
   * be one poll behind a lifecycle/security change, so its row alone is not a
   * sufficient authorization to consume an account.
   */
  validateQueueAsset(record) {
    if (typeof this.sessionAssets !== 'function') return;
    const assetStore = this.sessionAssets();
    if (typeof assetStore?.get !== 'function') return;
    const assetId = text(record.assetId) || text(record.id);
    let asset;
    try {
      asset = assetStore.get(assetId);
    } catch (error) {
      if (error?.code === 'ENOENT') throw new HttpError(404, `Login-state asset no longer exists: ${assetId}`);
      throw error;
    }
    if (chainQueueEligible(asset)) return;
    throw new HttpError(409, `${record.email || asset.email || assetId} 当前不在提链队列（${assetLifecycle(asset)} / ${assetNextAction(asset)}）`);
  }

  /**
   * Dispatches selected rows to the external engine, grouped by target country.
   *
   * One LinkOps job per account: the service expands the token batch itself and
   * binds its own proxies, so nothing here draws an exit. Rows whose target
   * country the engine does not support are reported as skipped instead of
   * being rewritten onto a country that would bill wrong.
   */
  /**
   * Dispatches selected rows, grouped by the provider their registration
   * country routes to.
   *
   * India, Vietnam and Indonesia have their own single-country providers; every
   * other country goes through the PayPal checkout, where the routing table
   * still chooses which checkout country to use. Batches are keyed by
   * provider+country because that is exactly what one engine job carries.
   */
  async extract(payload = {}) {
    const ids = Array.isArray(payload.ids) ? payload.ids.map(text).filter(Boolean) : [];
    if (!ids.length) throw new HttpError(400, 'Select at least one account');
    if (ids.length > MAX_DISPATCH) throw new HttpError(400, `一次最多派发 ${MAX_DISPATCH} 个账号`);
    if (!this.linkops) throw new HttpError(503, '提链执行引擎未接入');
    const store = this.store();
    const known = new Map(store.list().map((record) => [record.id, record]));
    const missing = ids.filter((id) => !known.has(id));
    if (missing.length) throw new HttpError(404, `No chain record for ${missing.length} selected account(s)`);
    const notRetryable = ids.filter((id) => {
      const record = known.get(id);
      const status = text(record.status).toLowerCase();
      return paymentStatus(record) === 'success' || !['pending', 'failed'].includes(status);
    });
    if (notRetryable.length) {
      throw new HttpError(409, `${notRetryable.length} selected account(s) are not pending or failed extraction records`);
    }
    const rules = this.countryRules();
    const override = payload.country === undefined ? '' : text(payload.country).toUpperCase();
    const groups = new Map();
    const seenTokens = new Map();
    const skipped = [];
    for (const id of ids) {
      const record = known.get(id);
      // Queue eligibility is judged per row, like the provider and the token:
      // one stale account should not refuse the whole batch.
      try { this.validateQueueAsset(record); } catch (error) {
        skipped.push({ id, email: record.email, reason: error.message });
        continue;
      }
      const source = text(record.sourceCountryCode).toUpperCase();
      // An explicit choice made at import wins over the registration country.
      const provider = text(record.routeProvider) || providerForCountry(source);
      const rule = rules[text(record.routeKey)] || rules[source] || rules.default;
      // A one-off override still only moves the billing profile; the proxy
      // region is a pool decision and stays with the table.
      const resolved = dispatchOptionsFor(provider, override ? { ...rule, billingCountry: override } : rule);
      if (resolved.error) {
        skipped.push({ id, email: record.email, provider, reason: resolved.error });
        continue;
      }
      let token;
      try { token = this.accessTokenFor(record.assetId || record.id); } catch (error) {
        skipped.push({ id, email: record.email, provider, reason: error.message });
        continue;
      }
      // The engine de-duplicates the token list it is handed and answers with
      // one job per surviving token, which the rows are matched to by position.
      // A repeated token would therefore shift every later row onto another
      // account's job, so it is refused here instead.
      if (seenTokens.has(token)) {
        skipped.push({ id, email: record.email, provider, reason: `access token 与 ${seenTokens.get(token)} 重复，未派发` });
        continue;
      }
      seenTokens.set(token, record.email || id);
      // One engine job carries one option set, so the batch key is every axis
      // that option set depends on.
      const key = `${provider}:${resolved.checkoutCountry}:${resolved.billingCountry}`;
      if (!groups.has(key)) {
        groups.set(key, {
          provider,
          checkoutCountry: resolved.checkoutCountry,
          billingCountry: resolved.billingCountry,
          options: resolved.options,
          rows: [],
        });
      }
      groups.get(key).rows.push({ id, token });
    }
    if (!groups.size) throw new HttpError(400, skipped[0]?.reason || '没有可派发的账号');

    // One call per chunk, several calls in flight. Chunks from different groups
    // are interleaved deliberately: a slow country must not hold back the rest.
    const chunks = [];
    for (const group of groups.values()) {
      for (let cursor = 0; cursor < group.rows.length; cursor += DISPATCH_CHUNK) {
        chunks.push({ ...group, rows: group.rows.slice(cursor, cursor + DISPATCH_CHUNK) });
      }
    }

    const dispatched = [];
    const failures = [];
    const outcomes = await mapLimit(chunks, this.dispatchConcurrency(), async (chunk) => {
      try {
        const tokens = chunk.rows.map((row) => row.token);
        const response = await this.linkops.createJob({
          domain: 'extraction',
          provider: chunk.provider,
          // `text` and `tokens` both, because the providers do not read the
          // same field. PayPal, GoPay and UPI parse the array; MoMo reads
          // `text or tokens` and stringifies whatever it gets, so an array
          // arrives as its Python repr — `['eyJ...']`, brackets and quotes
          // included — which its token matcher accepts whole. That produced one
          // job carrying one malformed token no matter how many rows were sent,
          // and left every other row in flight against a job that never existed.
          input: { text: tokens.join('\n'), tokens },
          options: chunk.options,
        });
        return { chunk, response };
      } catch (error) {
        return { chunk, error };
      }
    });

    // The ledger is written after the fan-out rather than inside it: the store
    // is a read-modify-write of one file, so concurrent writers would lose
    // updates.
    for (const { chunk, response, error } of outcomes) {
      const { provider, checkoutCountry, billingCountry, rows } = chunk;
      if (error) {
        for (const row of rows) failures.push({ id: row.id, provider, checkoutCountry, billingCountry, reason: error.message });
        continue;
      }
      // The engine expands one job per token, in the order they were sent, so
      // rows are matched to jobs by position. A short answer means the engine
      // dropped something (a duplicate or an unparseable token): the positions
      // no longer line up, and guessing would attach a row to another
      // account's job, so the whole chunk is reported rather than mismapped.
      const jobIds = (response?.jobs || []).map((job) => text(job?.id)).filter(Boolean);
      if (jobIds.length !== rows.length) {
        for (const row of rows) {
          failures.push({
            id: row.id,
            provider,
            checkoutCountry,
            billingCountry,
            reason: `引擎只为 ${rows.length} 个 token 建了 ${jobIds.length} 个作业，无法确定对应关系`,
          });
        }
        continue;
      }
      rows.forEach((row, index) => {
        const linkopsJobId = jobIds[index] || '';
        store.markRunning(row.id, { country: billingCountry, provider });
        store.update(row.id, { linkopsJobId, linkopsProvider: provider, linkopsRetryCount: 0 });
        dispatched.push({ id: row.id, provider, checkoutCountry, billingCountry, linkopsJobId });
      });
    }
    if (dispatched.length) this.startReconciler();

    const routes = new Map();
    for (const item of dispatched) {
      const key = `${item.provider}:${item.checkoutCountry}:${item.billingCountry}`;
      routes.set(key, (routes.get(key) || 0) + 1);
    }
    return {
      accepted: dispatched.map((item) => item.id),
      dispatched,
      skipped: [...skipped, ...failures],
      routes: [...routes].map(([key, count]) => {
        const [provider, checkoutCountry, billingCountry] = key.split(':');
        return { provider, checkoutCountry, billingCountry, count };
      }),
    };
  }

  /** How many engine calls one dispatch keeps in flight. */
  dispatchConcurrency() {
    return Number(this.configService?.normalized?.().chain?.dispatchConcurrency ?? 4);
  }

  /** Whether an extracted link should roll straight into payment, and with what. */
  paymentSettings() {
    const payment = this.configService?.readRaw?.().chain?.payment || {};
    return {
      autoContinue: payment.autoContinue === true,
      phone: text(payment.phone),
      country: text(payment.country).toUpperCase() || 'US',
    };
  }

  savePaymentSettings(payload = {}) {
    const input = payload && typeof payload === 'object' ? payload : {};
    const phone = text(input.phone);
    const country = text(input.country).toUpperCase() || 'US';
    if (!BILLING_COUNTRIES.includes(country)) {
      throw new HttpError(400, `支付国家 ${country} 没有对应的账单档案（${BILLING_COUNTRIES.join(' ')}）`);
    }
    const autoContinue = input.autoContinue === true;
    // Turning continuation on without a number to sign with would silently do
    // nothing on every extracted link, so it is refused at the point of saving.
    if (autoContinue && !phone) throw new HttpError(400, '开启自动顺延必须先填支付手机号');
    this.configService.update({ config: { chain: { payment: { autoContinue, phone, country } } } });
    return this.paymentSettings();
  }

  /** A row's own number wins over the shared default. */
  paymentPhoneFor(record = {}) {
    return text(record.paymentPhone) || this.paymentSettings().phone;
  }

  savePaymentPhone(id, phone) {
    const record = this.store().get(id);
    this.validateQueueAsset(record);
    return this.store().update(id, { paymentPhone: text(phone) });
  }

  /**
   * Continues one extracted link into the payment engine.
   *
   * Returns a reason instead of throwing when the row simply is not ready — a
   * provider with no payment stage, a missing link, or no phone number to sign
   * with are all ordinary states, not failures of the caller.
   */
  async continuePayment(record) {
    const provider = paymentProviderFor(text(record.linkopsProvider));
    if (!provider) return { skipped: `${text(record.linkopsProvider) || '该 provider'} 暂无支付环节` };
    const link = text(record.result?.paypalUrl);
    if (!link) return { skipped: '没有可支付的链接' };
    const phone = this.paymentPhoneFor(record);
    if (!phone) return { skipped: '未配置支付手机号' };
    const country = text(record.request?.country) || this.paymentSettings().country;
    const response = await this.linkops.createJob({
      domain: 'payment',
      provider,
      // The extracted checkout link is the BA approval token the engine signs.
      input: { baToken: link, phone },
      // Payment binds only the checkout pool, but it still refuses a job that
      // does not name it.
      options: { country, proxyPoolId: proxyPoolId(provider, country, 'checkout') },
    });
    const paymentJobId = text(response?.jobs?.[0]?.id);
    this.store().update(record.id, { paymentJobId, paymentProvider: provider, paymentStatus: 'pending' });
    return { paymentJobId };
  }

  /** Manual counterpart to auto-continue, for rows the operator picks. */
  async payExtracted(ids = []) {
    if (!this.linkops) throw new HttpError(503, '提链执行引擎未接入');
    const requested = Array.isArray(ids) ? ids.map(text).filter(Boolean) : [];
    if (!requested.length) throw new HttpError(400, '请选择至少一个已提链的账号');
    if (requested.length > MAX_BATCH) throw new HttpError(400, `一次最多 ${MAX_BATCH} 个`);
    const store = this.store();
    const accepted = [];
    const skipped = [];
    for (const id of requested) {
      let record;
      try { record = store.get(id); } catch { skipped.push({ id, reason: '记录不存在' }); continue; }
      if (text(record.paymentJobId) && paymentStatus(record) === 'pending') {
        skipped.push({ id, email: record.email, reason: '已有进行中的支付作业' });
        continue;
      }
      try {
        const outcome = await this.continuePayment(record);
        if (outcome.skipped) skipped.push({ id, email: record.email, reason: outcome.skipped });
        else accepted.push({ id, paymentJobId: outcome.paymentJobId });
      } catch (error) {
        skipped.push({ id, email: record.email, reason: error.message });
      }
    }
    if (accepted.length) this.startReconciler();
    return { accepted: accepted.map((item) => item.id), dispatched: accepted, skipped };
  }

  /**
   * Polls the engine until every dispatched row has settled.
   *
   * Pull-based and self-terminating: nothing runs while the ledger has no rows
   * in flight, so an idle console costs no requests to a service that may not
   * even be running.
   */
  startReconciler() {
    if (this.reconcileTimer || !this.linkops) return;
    const tick = async () => {
      this.reconcileTimer = null;
      let pending = 0;
      try { pending = await this.reconcileOnce(); } catch { pending = this.pendingDispatchCount(); }
      if (pending > 0) {
        this.reconcileTimer = setTimeout(tick, 4000);
        this.reconcileTimer.unref?.();
      }
    };
    this.reconcileTimer = setTimeout(tick, 1500);
    this.reconcileTimer.unref?.();
  }

  /**
   * A row the external engine still owns.
   *
   * Read from the ledger rather than from an in-process map: the run happens in
   * another service now, so the durable record is the only thing that knows.
   */
  inFlight(id) {
    let record;
    try { record = this.store().get(id); } catch { return false; }
    return text(record.status) === 'running' && Boolean(text(record.linkopsJobId));
  }

  pendingDispatchCount() {
    return this.store().list().filter((record) => (
      // A running row counts whether or not it has an engine job: without a job
      // it is an orphan the reconciler still has to sweep back to the queue.
      text(record.status) === 'running'
      || (text(record.paymentJobId) && paymentStatus(record) === 'pending')
    )).length;
  }

  /**
   * Puts a failed extraction back on the next proxy in its pool.
   *
   * Every extraction provider's `retry_options` advances `retryProxies` to the
   * next exit — the rotation is already built — but the engine only runs it
   * when someone asks, so an unreachable proxy otherwise ends the row on its
   * first attempt. Retrying blind rather than on a matched error string is
   * deliberate: the engine does not classify failures, and a bounded count that
   * the ledger carries is honest about what it cost.
   *
   * Returns true when the row is back in flight; false means it was written off
   * (and the reason says whether the pool or the budget ran out).
   */
  async rotateProxyAndRetry(record, job, reason) {
    const store = this.store();
    const budget = Number(this.configService?.normalized?.().chain?.autoRetry ?? 3);
    const spent = Number(record.linkopsRetryCount || 0);
    // An interrupted job is the engine restarting mid-run, not a verdict on the
    // account, so it earns a re-dispatch the same way a bad exit does.
    const worthRotating = text(job.status) === 'interrupted' || isProxyFailure(reason);
    if (!worthRotating || !(budget > 0) || spent >= budget || job.can_retry === false) {
      const suffix = spent > 0 ? `（已换 ${spent} 个代理仍失败）` : '';
      store.markFailed(record.id, { code: 'CHAIN_EXTRACTION_FAILED', message: `${reason}${suffix}`, stages: [] });
      return false;
    }
    try {
      await this.linkops.retryJob(text(record.linkopsJobId));
    } catch (error) {
      // The usual cause is an exhausted pool — the engine raises rather than
      // silently reusing the exit that just failed.
      store.markFailed(record.id, {
        code: 'CHAIN_EXTRACTION_FAILED',
        message: `${reason}；换代理重试失败：${error.message}`,
        stages: [],
      });
      return false;
    }
    store.update(record.id, { linkopsRetryCount: spent + 1, lastError: null });
    return true;
  }

  /** Writes settled engine jobs back onto the ledger; returns rows still in flight. */
  async reconcileOnce() {
    if (!this.linkops) return 0;
    const store = this.store();
    const rows = store.list();
    // A row marked running with no engine job can never settle: nothing polls
    // it, and the engine has nothing to report. It is the residue of a dispatch
    // whose answer did not line up with what was sent, so it is returned to the
    // queue rather than left waiting forever. The age gate keeps this clear of a
    // dispatch that is still writing its job ids.
    const orphanCutoff = Date.now() - 60_000;
    for (const record of rows) {
      if (text(record.status) !== 'running' || text(record.linkopsJobId)) continue;
      const startedAt = Date.parse(text(record.startedAt) || '');
      if (Number.isFinite(startedAt) && startedAt > orphanCutoff) continue;
      store.update(record.id, {
        status: 'pending',
        lastError: { code: 'CHAIN_NO_ENGINE_JOB', message: '派发未换回引擎作业，已退回待派发' },
      });
    }
    const extracting = rows.filter((record) => text(record.status) === 'running' && text(record.linkopsJobId));
    const paying = rows.filter((record) => text(record.paymentJobId) && paymentStatus(record) === 'pending');
    if (!extracting.length && !paying.length) return 0;
    let live = 0;
    const autoContinue = this.paymentSettings().autoContinue;

    if (extracting.length) {
      const page = await this.linkops.jobs({ domain: 'extraction', limit: 500 });
      const byId = new Map((page?.jobs || []).map((job) => [text(job.id), job]));
      for (const record of extracting) {
        const job = byId.get(text(record.linkopsJobId));
        // A job the engine no longer knows about (restarted, pruned) is left in
        // flight rather than failed: the operator can retry from the workbench.
        if (!job) { live += 1; continue; }
        const status = text(job.status);
        if (status === 'completed') {
          const result = chainResultFromJob(job);
          if (!result.paypalUrl) {
            store.markFailed(record.id, { code: 'CHAIN_NO_LINK', message: '外部引擎报告完成但没有返回链接' });
            continue;
          }
          const saved = store.markSuccess(record.id, result);
          if (autoContinue) {
            // The link is the whole point of the run; rolling it into payment
            // here is what keeps an operator from re-selecting the same rows.
            try {
              const outcome = await this.continuePayment(saved);
              if (!outcome.skipped) live += 1;
            } catch { /* Reported on the row's payment status next cycle. */ }
          }
        } else if (status === 'failed' || status === 'interrupted') {
          const reason = text(job.error) || `外部引擎提链${status === 'interrupted' ? '中断' : '失败'}`;
          const retried = await this.rotateProxyAndRetry(record, job, reason);
          if (retried) { live += 1; continue; }
        } else if (status === 'cancelled') {
          store.update(record.id, { status: 'pending', lastError: null, linkopsJobId: '' });
        } else {
          live += 1;
        }
      }
    }

    if (paying.length) {
      const page = await this.linkops.jobs({ domain: 'payment', limit: 500 });
      const byId = new Map((page?.jobs || []).map((job) => [text(job.id), job]));
      for (const record of paying) {
        const job = byId.get(text(record.paymentJobId));
        if (!job) { live += 1; continue; }
        const status = text(job.status);
        if (status === 'completed') store.markPaymentStatus([record.id], 'success');
        else if (status === 'failed' || status === 'interrupted' || status === 'cancelled') {
          store.markPaymentStatus([record.id], 'failed');
        } else {
          // `awaiting_input` counts as live: the operator answers it in the
          // console's payment monitor, and the row settles on a later pass.
          live += 1;
        }
      }
    }
    return live;
  }

  remove(ids = []) {
    const requested = Array.isArray(ids) ? ids.map(text).filter(Boolean) : [];
    if (!requested.length) throw new HttpError(400, 'Select at least one chain record');
    if (requested.length > MAX_BATCH) throw new HttpError(400, `Select at most ${MAX_BATCH} chain records`);
    let keys;
    try {
      keys = [...new Set(requested.map((id) => safeAssetId(id)))];
    } catch (error) {
      throw new HttpError(400, error.message);
    }
    const busy = keys.filter((id) => this.inFlight(id));
    if (busy.length) throw new HttpError(409, `${busy.length} selected account(s) are still extracting`);
    const chainStore = this.store();
    const assetStore = this.sessionAssets ? this.sessionAssets() : null;
    // Deleting a chain row deletes the account behind it.
    //
    // The old rule only removed assets that came from the external AT import,
    // on the theory that a registered account still belonged to 登录态. In
    // practice that left the row's twin behind: the account stayed in the asset
    // list, kept its trial flag, and was immediately re-synced into a fresh
    // chain row — so "delete" deleted nothing that lasted. One row, one account,
    // one delete.
    const assetIds = new Set();
    const targetRecords = new Map();
    for (const id of keys) {
      let record;
      try { record = chainStore.get(id); } catch (error) {
        if (error.code === 'CHAIN_RECORD_NOT_FOUND') continue;
        throw error;
      }
      targetRecords.set(id, record);
      const assetId = text(record.assetId) || text(record.id);
      if (assetId) assetIds.add(assetId);
    }
    if (assetIds.size && typeof assetStore?.remove !== 'function') {
      throw new HttpError(500, 'Login-state storage cannot remove accounts');
    }
    const ownedIds = typeof this.sessionAssetIdsInUse === 'function'
      ? this.sessionAssetIdsInUse()
      : [];
    const inUse = new Set((ownedIds instanceof Set ? [...ownedIds] : Array.isArray(ownedIds) ? ownedIds : [])
      .map(text)
      .filter(Boolean));
    const busyAssets = [...assetIds].filter((id) => inUse.has(id));
    if (busyAssets.length) {
      throw new HttpError(409, `${busyAssets.length} selected account(s) are still used by a registration or recovery task`);
    }

    const targetIds = new Set(targetRecords.keys());
    const retainedAssetIds = new Set();
    for (const record of chainStore.list()) {
      if (targetIds.has(text(record.id))) continue;
      const assetId = text(record.assetId) || text(record.id);
      if (assetId && assetIds.has(assetId)) retainedAssetIds.add(assetId);
    }
    const deletableAssetIds = [...assetIds].filter((id) => !retainedAssetIds.has(id));
    // Validate all linked files before removing the ledger rows. The two stores
    // cannot commit atomically, but deterministic path/file errors must leave a
    // chain row available for a safe retry.
    if (deletableAssetIds.length && typeof assetStore?.validateRemove === 'function') {
      assetStore.validateRemove(deletableAssetIds, { cascadeCpa: true });
    }
    const result = chainStore.remove(keys);
    // Cascaded: the CPA is an artifact of the account, and keeping it after the
    // account is gone only leaves an export that can never be reproduced.
    const accounts = deletableAssetIds.length
      ? assetStore.remove(deletableAssetIds, { cascadeCpa: true })
      : { removed: [], missing: [] };
    return {
      ...result,
      accountsRemoved: accounts.removed || [],
      accountsMissing: accounts.missing || [],
      accountsRetained: [...retainedAssetIds],
    };
  }

  markPaymentStatus(ids = [], status = 'pending') {
    const requested = Array.isArray(ids) ? ids.map(text).filter(Boolean) : [];
    if (!requested.length) throw new HttpError(400, 'Select at least one chain record');
    if (requested.length > MAX_BATCH) throw new HttpError(400, `Select at most ${MAX_BATCH} accounts`);
    const nextStatus = text(status);
    if (!PAYMENT_STATUSES.has(nextStatus)) throw new HttpError(400, `Unsupported payment status: ${status}`);
    const chainStore = this.store();
    let keys;
    try {
      keys = [...new Set(requested.map((id) => safeAssetId(id)))];
    } catch (error) {
      throw new HttpError(400, error.message);
    }
    const busy = [];
    const records = new Map();
    for (const id of keys) {
      if (this.inFlight(id)) {
        busy.push(id);
        continue;
      }
      try {
        const record = chainStore.get(id);
        records.set(id, record);
        if (record.status === 'running') busy.push(id);
      } catch (error) {
        if (error.code !== 'CHAIN_RECORD_NOT_FOUND') throw error;
      }
    }
    const ownedIds = typeof this.sessionAssetIdsInUse === 'function' ? this.sessionAssetIdsInUse() : [];
    const inUse = new Set((ownedIds instanceof Set ? [...ownedIds] : Array.isArray(ownedIds) ? ownedIds : []).map(text).filter(Boolean));
    for (const id of keys) {
      const assetId = text(records.get(id)?.assetId) || id;
      if (inUse.has(id) || inUse.has(assetId)) busy.push(id);
    }
    if (busy.length) {
      throw new HttpError(409, '注册或提链任务正在使用所选账号，任务结束后再归类支付结果');
    }
    try { return chainStore.markPaymentStatus(keys, nextStatus); } catch (error) {
      if (/Invalid session asset id/.test(String(error.message || ''))) throw new HttpError(400, error.message);
      throw error;
    }
  }
}

module.exports = { ChainService, isProxyFailure };
