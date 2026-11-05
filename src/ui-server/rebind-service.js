'use strict';

/**
 * Batch re-bind (换绑) orchestration.
 *
 * A self-contained service — deliberately outside the branch orchestrator — that
 * fuses the reference `run_rebind_batch` shape with this project's building
 * blocks: session-asset store, proxy catalog, and the mail-channel clients.
 *
 * Left side : already-registered iCloud login-state assets selected by the
 *             operator (only `icloud` accounts may join).
 * Right side: a *different* mail channel that hands out fresh, unregistered
 *             mailboxes; each account is moved onto one via `change_email`.
 *
 * On success the account is updated in place — new address, new channel, fresh
 * login state — and the iCloud address it left behind is stamped onto the record so it
 * is recognisable as "rebound off".
 */

const { XiaopingguoClient } = require('../xiaopingguo-client');
const { SmsbowerMailClient } = require('../smsbower-mail-client');
const { secretFromEnv } = require('../config-v2');
const { probeProxy } = require('../proxy-pool');
const { executePureHttpUrl } = require('../pure-url');
const { rebindAccount } = require('../rebind-chain');
const { createRebindMailChannel } = require('../rebind-mail-channel');
const { sourceProxySummary } = require('../session-asset-store');
const { createRebindProxyPool } = require('./rebind-proxy');
const { loadHar } = require('../har');
const { ChatGptSessionRunner, makeInitialChatGptSessionState } = require('../chatgpt-session-runner');
const { HttpError, mapLimit, atomicWriteText, sanitizeValue } = require('./utils');
const path = require('node:path');
const fs = require('node:fs');

const NEW_MAIL_PROVIDERS = ['mailcom', 'fastmail', 'xiaopingguo', 'smsbower'];
const PROVIDER_LABELS = {
  mailcom: 'Mail.com',
  fastmail: 'Fastmail',
  xiaopingguo: '小苹果(池/自建)',
  smsbower: 'smsbower(租用Gmail)',
};
const ICLOUD_DOMAINS = ['icloud.com', 'me.com', 'mac.com'];
const MAX_RESULTS = 500;
// Only accounts registered at least this long ago may enter the rebind queue.
const REGISTRATION_LOCK_MS = 24 * 60 * 60 * 1000;
const LOGIN_PROGRESS_EVENTS = new Set([
  'nextauth_ready', 'identity_submitted', 'login_password_page', 'password_verified',
  'mfa_required', 'mfa_challenge_issued', 'mfa_verification_pending', 'mfa_validated',
  'auth_callback_pending', 'auth_callback_response_received', 'session_verified',
]);

function text(value) {
  return String(value == null ? '' : value).trim();
}
function nowIso() {
  return new Date().toISOString();
}
function safeSecret(obj, key) {
  // secretFromEnv throws when nothing is configured; here an absent secret
  // is a normal 'not configured' signal, not an error, so swallow it.
  try { return secretFromEnv(obj, key); } catch { return ''; }
}
/** Never echo proxy credentials back to the console. */
function maskProxyUrl(value) {
  const raw = text(value);
  if (!raw) return '';
  try {
    const url = new URL(raw.includes('://') ? raw : `http://${raw}`);
    const credentials = url.username ? `${url.username.slice(0, 3)}***:***@` : '';
    return `${url.protocol}//${credentials}${url.hostname}:${url.port}`;
  } catch {
    return '(unparsable proxy)';
  }
}

function isIcloudAsset(asset = {}) {
  const provider = text(asset.mailProvider).toLowerCase();
  if (provider) return provider === 'icloud';
  const email = text(asset.email).toLowerCase();
  const at = email.lastIndexOf('@');
  const domain = at >= 0 ? email.slice(at + 1) : '';
  return ICLOUD_DOMAINS.includes(domain);
}

class RebindService {
  constructor(options = {}) {
    this.configService = options.configService;
    this.proxyService = options.proxyService;
    this.runManager = options.runManager;
    this.logStore = options.logStore;
    this.cwd = options.cwd ? path.resolve(options.cwd) : process.cwd();
    this.state = this.loadCompletedState();
    this.starting = false;
    this.rebindAccount = options.rebindAccount || rebindAccount;
    this.stopRequested = false;
    this.loginExecutor = options.loginExecutor;
    this.proxyProbeExecutor = options.proxyProbeExecutor;
    this._har = null;
    // The prepared iCloud queue is persisted so it survives a page refresh or
    // a server restart.
    this.queueIds = [];
    try { this.queueIds = this.loadQueue(); } catch { this.queueIds = []; }
  }

  stateDir() {
    return path.resolve(this.cwd, this.configService.readRaw()?.output?.stateDir || '.gpt-re-state/v2');
  }
  queueFilePath() {
    return path.join(this.stateDir(), 'rebind-queue.json');
  }
  loadQueue() {
    const file = this.queueFilePath();
    if (!fs.existsSync(file)) return [];
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(data?.assetIds) ? data.assetIds.map(text).filter(Boolean) : [];
  }
  saveQueue() {
    try {
      fs.mkdirSync(this.stateDir(), { recursive: true });
      atomicWriteText(this.queueFilePath(), `${JSON.stringify({ assetIds: this.queueIds }, null, 2)}\n`);
    } catch { /* queue persistence is best-effort */ }
  }

  loadCompletedState() {
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(this.stateDir(), 'rebind-last-result.json'), 'utf8'));
      if (saved.schemaVersion === 1 && saved.state?.finishedAt && !saved.state.running && Array.isArray(saved.state.results)) {
        return { ...this.freshState(), ...saved.state, active: [] };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') return { ...this.freshState(), historyWarning: '上次换绑结果读取失败，阶段日志仍可用于排查' };
    }
    return this.freshState();
  }

  saveCompletedState() {
    try {
      atomicWriteText(path.join(this.stateDir(), 'rebind-last-result.json'), `${JSON.stringify(sanitizeValue({
        schemaVersion: 1, state: { ...this.state, running: false, active: [] },
      }, { redactPii: false }), null, 2)}\n`);
    } catch {
      this.state.historyWarning = '换绑结果保存失败，请保留当前错误信息';
    }
  }

  recordEvent(type, details = {}) {
    if (!this.logStore || !this.state.runId) return;
    try {
      this.logStore.append(this.state.runId, { type, source: 'rebind', details });
    } catch {
      this.state.historyWarning = '换绑阶段日志写入失败，请保留当前错误信息';
    }
  }

  /** Age since registration (asset createdAt) and whether the 24h lock cleared. */
  registrationInfo(asset, now = Date.now()) {
    const createdAt = text(asset && asset.createdAt);
    const ts = createdAt ? Date.parse(createdAt) : NaN;
    const ageMs = Number.isFinite(ts) ? Math.max(0, now - ts) : null;
    return {
      createdAt,
      ageMs,
      eligible: ageMs != null && ageMs >= REGISTRATION_LOCK_MS,
      eligibleAt: Number.isFinite(ts) ? new Date(ts + REGISTRATION_LOCK_MS).toISOString() : '',
    };
  }

  /** A safe, secret-free projection of one queued account for the console. */
  queueAccount(asset) {
    const info = this.registrationInfo(asset);
    return {
      id: asset.id,
      email: asset.email,
      accountId: text(asset.accountId),
      mailProvider: text(asset.mailProvider) || 'icloud',
      planType: text(asset.planType) || 'unknown',
      hasAccessToken: Boolean(asset.accessToken),
      canRefresh: Boolean(text(asset.password) && text(asset.totpSecret)),
      health: asset.health || null,
      rebind: asset.rebind || null,
      createdAt: info.createdAt,
      ageMs: info.ageMs,
      eligible: info.eligible,
      eligibleAt: info.eligibleAt,
    };
  }

  getQueue() {
    const store = this.store();
    const accounts = [];
    const validIds = [];
    for (const id of this.queueIds) {
      let asset;
      try { asset = store.get(id); } catch { asset = null; }
      if (!asset || asset.status === 'corrupt' || !isIcloudAsset(asset) || asset.rebind?.verificationUncertain) continue;
      accounts.push(this.queueAccount(asset));
      validIds.push(id);
    }
    // Drop ids whose asset was deleted so the persisted queue stays clean.
    if (validIds.length !== this.queueIds.length) { this.queueIds = validIds; this.saveQueue(); }
    return { accounts };
  }

  addToQueue(assetIds) {
    this.assertQueueEditable();
    const store = this.store();
    const ids = [...new Set((Array.isArray(assetIds) ? assetIds : []).map(text).filter(Boolean))];
    const present = new Set(this.queueIds);
    const blocked = [];
    let added = 0;
    for (const id of ids) {
      if (present.has(id)) { blocked.push({ id, email: '', reason: 'already' }); continue; }
      let asset;
      try { asset = store.get(id); } catch { asset = null; }
      if (!asset || asset.status === 'corrupt') { blocked.push({ id, email: '', reason: 'not_found' }); continue; }
      if (asset.rebind?.verificationUncertain) { blocked.push({ id, email: asset.email, reason: 'needs_review' }); continue; }
      if (!isIcloudAsset(asset)) { blocked.push({ id, email: asset.email, reason: 'not_icloud' }); continue; }
      const info = this.registrationInfo(asset);
      if (!info.eligible) { blocked.push({ id, email: asset.email, reason: 'too_new', eligibleAt: info.eligibleAt }); continue; }
      this.queueIds.push(id); present.add(id); added += 1;
    }
    if (added) this.saveQueue();
    return { ...this.getQueue(), added, blocked };
  }

  removeFromQueue(assetIds) {
    this.assertQueueEditable();
    const drop = new Set((Array.isArray(assetIds) ? assetIds : []).map(text).filter(Boolean));
    const before = this.queueIds.length;
    this.queueIds = this.queueIds.filter((id) => !drop.has(id));
    if (this.queueIds.length !== before) this.saveQueue();
    return this.getQueue();
  }

  clearQueue() {
    this.assertQueueEditable();
    this.queueIds = [];
    this.saveQueue();
    return this.getQueue();
  }

  assertQueueEditable() {
    if (this.starting || this.state.running) throw new HttpError(409, '换绑任务准备或运行中，暂不可修改队列');
  }

  freshState() {
    return {
      running: false,
      runId: '',
      provider: '',
      workerConcurrency: 0,
      total: 0,
      assetIds: [],
      done: 0,
      ok: 0,
      fail: 0,
      needsRefresh: 0,
      refreshed: 0,
      proxyRetried: 0,
      startedAt: '',
      finishedAt: '',
      error: '',
      reboundEmails: [],
      results: [],
      active: [],
    };
  }

  config() {
    return this.configService.normalized();
  }
  rawMail() {
    return this.configService.readRaw()?.mail || {};
  }
  store() {
    return this.runManager.sessionAssets();
  }

  har() {
    if (!this._har) this._har = loadHar(this.runManager.harPath || undefined).har;
    return this._har;
  }

  /**
   * Re-sign one account in with its password + TOTP to refresh a stale login
   * state — the same capability the login-state refresh uses, scoped to a
   * single account on the chain's sticky proxy. `security: {}` keeps it a pure
   * refresh: no password change, no TOTP re-enrollment.
   */
  async loginAsset(asset, proxy, signal, onProgress, confirmedEmailChange) {
    const reg = this.config().registration || {};
    // One setting decides this for the whole console now: `live` builds every
    // request from the templates in code, `capture` replays a recording so a
    // fresh one can be diffed against them.
    const useHarTemplates = reg.protocolTemplates === 'capture';
    const har = useHarTemplates ? this.har() : { log: { entries: [] } };
    const state = makeInitialChatGptSessionState({
      email: asset.email,
      password: asset.password,
      totpSecret: asset.totpSecret,
      oaiDid: asset.oaiDid,
      clientProfile: asset.clientProfile,
    });
    state.accountId = text(asset.accountId);
    // Carry the plan the account is already known to be on into the refresh.
    // The usage read below is skipped precisely when this is known, and
    // without it the fresh state had nothing to fall back on: every refresh of
    // a Plus or free account wrote `unknown` and a null usage record back over
    // the values it had skipped the read to preserve.
    state.planType = text(asset.planType) || state.planType;
    state.usage = asset.usage || state.usage || null;
    let failedOperation = '';
    const runner = new ChatGptSessionRunner(har, {
      proxy,
      signal,
      executor: this.loginExecutor,
      confirmedEmailChange,
      useHarTemplates,
      browserHeaders: reg.browserHeaders,
      dynamicSentinel: reg.dynamicSentinel,
      prewarmSentinelSdk: reg.prewarmSentinelSdk,
      authRequestTimeoutMs: reg.authRequestTimeoutMs,
      securityRequestTimeoutMs: reg.securityRequestTimeoutMs,
      name: reg.name,
      birthdate: reg.birthdate,
      traceAuthRequests: true,
      onRequest: (event) => {
        failedOperation = event.code ? event.operation : '';
        this.recordEvent('rebind_auth_request', {
          assetId: asset.id, operation: event.operation, status: event.status,
          code: event.code || '', durationMs: event.durationMs,
        });
      },
      onEvent: (event) => { if (LOGIN_PROGRESS_EVENTS.has(event.type)) onProgress?.({ step: event.type }); },
    });
    const cachedPlanType = text(asset.planType).toLowerCase();
    // Skip the usage read only when there is actually something cached to
    // reuse. A known plan with no usage record on it used to skip the read
    // anyway and then write the missing record back as `null`, losing the
    // metadata the skip existed to protect.
    const skipUsageMetadata = Boolean(cachedPlanType && cachedPlanType !== 'unknown' && asset.usage);
    try {
      // Match the normal session-refresh policy: a known plan can reuse its
      // cached usage metadata; an unknown plan performs one authoritative usage
      // read while saving the fresh login state.
      await runner.run(state, { security: {}, existingOnly: true, skipUsageMetadata });
    } catch (error) {
      error.step ||= failedOperation || state.step;
      throw error;
    } finally {
      try { runner.dispose && runner.dispose(); } catch { /* best effort */ }
    }
    if (!['valid', 'partial'].includes(state.status)) {
      throw new Error(`登录态刷新未完成: step=${state.step} status=${state.status}`);
    }
    return {
      accessToken: state.accessToken, cookieJar: state.cookieJar, accountId: state.accountId,
      oaiDid: state.oaiDid, session: state.session, sessionToken: state.sessionToken,
      clientProfile: state.clientProfile, me: state.me, planType: state.planType,
      usage: state.usage, lastValidatedAt: state.lastValidatedAt,
    };
  }

  /** New-email channels the right column may draw from (iCloud is the left type). */
  providers() {
    const config = this.config();
    const raw = this.rawMail();
    const mail = { ...(config.mail || {}), ...raw };
    const providers = NEW_MAIL_PROVIDERS.map((id) => {
      let configured = false;
      try {
        if (id === 'mailcom') configured = Boolean(text(mail.mailcomBaseUrl || mail.baseUrl) && (safeSecret(mail, 'adminTokenEnv') || text(mail.adminToken)));
        else if (id === 'fastmail') configured = Boolean(text(mail.fastmailBaseUrl) && (safeSecret(mail, 'adminTokenEnv') || text(mail.adminToken)));
        else if (id === 'xiaopingguo') configured = Boolean(text(mail.baseUrl) && (safeSecret(mail, 'passwordEnv') || text(mail.password)));
        else if (id === 'smsbower') configured = Boolean(safeSecret(mail, 'apiKeyEnv') || text(mail.apiKey) || safeSecret(config.sms || {}, 'apiKeyEnv') || text(config.sms?.apiKey));
      } catch { configured = false; }
      return { id, label: PROVIDER_LABELS[id], configured };
    });
    return { activeProvider: text(config.mail?.provider).toLowerCase(), providers };
  }

  /** Build the mail channel facade for the chosen provider. */
  mailChannel(provider) {
    const id = text(provider).toLowerCase();
    if (!NEW_MAIL_PROVIDERS.includes(id)) throw new HttpError(400, `不支持的换绑目标邮箱接口: ${provider}`);
    const config = this.config();
    const raw = this.rawMail();
    const mail = { ...(config.mail || {}), ...raw };

    if (id === 'mailcom' || id === 'fastmail') {
      return createRebindMailChannel(id, this.runManager.mailcomClient(config, id));
    }

    if (id === 'xiaopingguo') {
      const client = new XiaopingguoClient({ baseUrl: text(mail.baseUrl), origin: text(mail.origin) });
      return createRebindMailChannel(id, client, { password: safeSecret(mail, 'passwordEnv') || text(mail.password) });
    }

    // smsbower rented Gmail
    const client = new SmsbowerMailClient({
      baseUrl: mail.smsbowerBaseUrl,
      apiKey: safeSecret(mail, 'apiKeyEnv') || text(mail.apiKey) || safeSecret(config.sms || {}, 'apiKeyEnv') || text(config.sms?.apiKey),
      service: text(mail.service) || 'dr',
      domain: text(mail.domain),
      maxPrice: Number(mail.maxPrice || 0) || 0,
    });
    return createRebindMailChannel(id, client);
  }

  /**
   * The distinct proxy endpoints this plan would actually dial, so a preflight
   * probes the country pool the run will use rather than only the local list.
   */
  assignedEndpoints(proxyAssignments, limit) {
    return createRebindProxyPool(proxyAssignments, this.proxyService.list(), { maintenanceProxy: this.config().proxyPool?.maintenanceProxy }).endpoints().slice(0, limit);
  }

  retireCountryPoolProxy(proxy, reason = 'proxy_probe_failed') {
    if (proxy?.resourceKind !== 'countryPool' || !proxy?.countryCode) return { retired: false };
    if (typeof this.proxyService?.retireDynamicEntry !== 'function') return { retired: false };
    return this.proxyService.retireDynamicEntry({
      countryCode: proxy.countryCode,
      proxyId: proxy.id,
      proxyUrl: proxy.url,
      reason,
    });
  }

  /**
   * Liveness probe over those endpoints, using the very same `probeProxy`,
   * probe URL and timeout the proxy page's check uses — so the re-bind
   * preflight and the proxy preflight agree.
   */
  async probeAssignedProxies(body = {}) {
    const workerConcurrency = Math.max(1, Math.min(20, Number(body.workerConcurrency || 1)));
    const limit = Math.max(3, Math.min(10, workerConcurrency));
    const proxyPool = createRebindProxyPool(body.proxyAssignments, this.proxyService.list(), {
      maintenanceProxy: this.config().proxyPool?.maintenanceProxy,
    });
    const urls = proxyPool.endpoints().slice(0, limit);
    const healthCheck = this.config().proxyPool?.healthCheck || {};
    const results = await mapLimit(urls, 4, async (url) => {
      const checkedAt = nowIso();
      try {
        const result = await probeProxy({ url }, {
          probeUrl: healthCheck.probeUrl || 'https://auth.openai.com/',
          timeoutMs: healthCheck.timeoutMs || 15000,
          executor: this.proxyProbeExecutor || executePureHttpUrl,
          rejectChallenge: true,
        });
        return { proxy: maskProxyUrl(url), status: 'healthy', httpStatus: result.status, latencyMs: result.latencyMs, checkedAt };
      } catch (error) {
        const entry = proxyPool.entry(url);
        let retired = false;
        if (entry?.resourceKind === 'countryPool') {
          try {
            const outcome = this.retireCountryPoolProxy(entry, error?.message || 'proxy_probe_failed');
            retired = outcome?.retired === true;
          } catch { /* The run-time binding still performs the authoritative retirement. */ }
        }
        return { proxy: maskProxyUrl(url), status: 'failed', httpStatus: Number(error?.status || 0), latencyMs: null, message: text(error?.message).slice(0, 160), checkedAt, retired };
      }
    });
    return {
      total: results.length,
      healthy: results.filter((item) => item.status === 'healthy').length,
      failed: results.filter((item) => item.status !== 'healthy').length,
      results,
    };
  }

  async preflight(body = {}) {
    const provider = text(body.provider).toLowerCase();
    const workerConcurrency = Math.max(1, Math.min(20, Number(body.workerConcurrency || 1)));
    const requestedCount = Math.max(0, Number(body.count || 0));
    const catalog = this.proxyService.list();
    const assignments = Array.isArray(body.proxyAssignments) ? body.proxyAssignments : [];
    const usesMaintenanceOnly = assignments.every((item) => item.kind === 'maintenance');
    const pool = createRebindProxyPool(assignments, catalog, { maintenanceProxy: this.config().proxyPool?.maintenanceProxy });
    const { available, ready: capacityReady } = pool.capacity(workerConcurrency);
    const providerInfo = this.providers().providers.find((item) => item.id === provider) || null;
    // A liveness probe is opt-in: the button asks for it, the cheap capacity
    // read stays cheap.
    const probe = body.probe === true ? await this.probeAssignedProxies(body) : null;
    const proxyReady = capacityReady && (!probe || probe.healthy > 0);
    return {
      schemaVersion: 1,
      provider,
      checkedAt: nowIso(),
      proxy: {
        required: !usesMaintenanceOnly,
        requiredCount: workerConcurrency,
        available,
        ready: proxyReady,
        capacityReady,
        maintenanceOnly: usesMaintenanceOnly,
        ...(probe ? { probe } : {}),
      },
      mail: {
        provider,
        configured: Boolean(providerInfo?.configured),
        requested: requestedCount,
        ready: Boolean(providerInfo?.configured),
      },
      ready: proxyReady && Boolean(providerInfo?.configured),
    };
  }

  async start(body = {}) {
    if (this.starting || this.state.running) throw new HttpError(409, '已有换绑任务准备或运行中');
    const provider = text(body.provider).toLowerCase();
    if (!NEW_MAIL_PROVIDERS.includes(provider)) throw new HttpError(400, '请选择一个有效的换绑目标邮箱接口');
    const assetIds = [...new Set((Array.isArray(body.assetIds) ? body.assetIds : []).map(text).filter(Boolean))];
    if (!assetIds.length) throw new HttpError(400, '请至少加入一个被换绑的 iCloud 账号');
    const workerConcurrency = Math.max(1, Math.min(20, assetIds.length, Math.floor(Number(body.workerConcurrency) || 1)));
    const autoRefresh = body.autoRefresh !== false;
    const alwaysFreshLogin = autoRefresh && body.alwaysFreshLogin === true;
    const proxyRetries = Math.max(0, Math.min(5, Math.floor(Number(body.proxyRetries ?? 2) || 0)));
    const otpRetries = Math.max(0, Math.min(5, Math.floor(Number(body.otpRetries ?? 1) || 0)));

    const store = this.store();
    const inUse = this.runManager.sessionAssetIdsInUse ? this.runManager.sessionAssetIdsInUse() : new Set();
    const assets = [];
    for (const id of assetIds) {
      let asset;
      try { asset = store.get(id); } catch { throw new HttpError(404, `账号不存在: ${id}`); }
      if (!asset || asset.status === 'corrupt') throw new HttpError(404, `账号不存在或已损坏: ${id}`);
      if (asset.rebind?.verificationUncertain) throw new HttpError(409, `上次换绑结果待核对: ${asset.email || id}`);
      if (inUse.has && inUse.has(id)) throw new HttpError(409, `账号正被其他任务占用: ${asset.email || id}`);
      if (!isIcloudAsset(asset)) throw new HttpError(400, `只允许加入 iCloud 邮箱账号: ${asset.email || id}`);
      if (!this.registrationInfo(asset).eligible) throw new HttpError(400, `账号注册未满 24 小时，暂不可换绑: ${asset.email || id}`);
      if (text(asset.mailProvider).toLowerCase() === provider) throw new HttpError(400, '换绑目标邮箱接口不能与被换绑账号相同');
      const canRefresh = autoRefresh && text(asset.password) && text(asset.totpSecret);
      if (alwaysFreshLogin && !canRefresh) throw new HttpError(400, `账号缺少密码或 TOTP，无法每次重新登录: ${asset.email || id}`);
      if (!text(asset.accessToken) && !canRefresh) throw new HttpError(400, `账号缺少登录态且无法自动刷新(需密码+TOTP)，请先刷新登录态: ${asset.email || id}`);
      assets.push(asset);
    }

    // Start only performs local checks. Workers select and probe an exit before
    // account traffic, then claim mailboxes and refill an empty pool on demand.
    this.starting = true;
    try {
      const channel = this.mailChannel(provider);
      const catalog = this.proxyService.list();
      const proxyPool = createRebindProxyPool(body.proxyAssignments, catalog, {
        maintenanceProxy: this.config().proxyPool?.maintenanceProxy,
        healthCheck: this.config().proxyPool?.healthCheck,
        executor: this.proxyProbeExecutor,
        shouldStop: () => this.stopRequested,
        retireProxy: ({ proxy, reason }) => this.retireCountryPoolProxy(proxy, reason),
      });
      const resolveProxy = (slot, onCheck) => proxyPool.acquire(slot, onCheck);
      if (!proxyPool.capacity(workerConcurrency).ready) throw new HttpError(400, '所选代理池节点不足，无法为并发 Worker 分配独立代理，请降低并发或补充代理');

      this.stopRequested = false;
      this.state = {
        ...this.freshState(),
        runId: `rebind-${Date.now()}`,
        running: true,
        provider,
        workerConcurrency,
        total: assets.length,
        assetIds,
        autoRefresh,
        alwaysFreshLogin,
        proxyRetries,
        otpRetries,
        proxyAssignments: Array.isArray(body.proxyAssignments) ? body.proxyAssignments : [],
        startedAt: nowIso(),
      };
      this.recordEvent('rebind_started', { assetIds, provider, workerConcurrency, autoRefresh, alwaysFreshLogin });

      // Fire and forget: the operator polls status.
      this.batch = Promise.resolve().then(() => this.runBatch(assets, { provider, workerConcurrency, channel, resolveProxy, proxyPool, autoRefresh, alwaysFreshLogin, proxyRetries, otpRetries })).catch((error) => {
        this.state.error = text(error?.message).slice(0, 220);
        this.state.running = false;
        this.state.finishedAt = nowIso();
      }).finally(() => {
        this.recordEvent('rebind_finished', { done: this.state.done, ok: this.state.ok, fail: this.state.fail, error: this.state.error });
        this.saveCompletedState();
      });
      return { ok: true, total: assets.length, provider, workerConcurrency };
    } finally {
      this.starting = false;
    }
  }

  async processAsset(asset, slot, ctx, store, runId) {
    const hasCredentials = Boolean(text(asset.password) && text(asset.totpSecret));
    const canRefresh = ctx.autoRefresh && hasCredentials;
    const startedAt = nowIso();
    const active = { assetId: asset.id, email: asset.email, newEmail: '', stage: 'login', stagesReached: [], attempt: 1, mailboxAttempt: 0, startedAt, stageStartedAt: startedAt };
    const onStage = (stage, detail = {}) => {
      active.stage = stage;
      if (!active.stagesReached.includes(stage)) active.stagesReached.push(stage);
      active.stageStartedAt = nowIso();
      active.loginStep = '';
      active.loginStepsReached = [];
      active.refreshReason = detail.refreshReason || '';
      active.resumeStage = detail.resumeStage || '';
      active.otp = null;
      active.timeoutMs = detail.timeoutMs || 0;
      for (const key of ['mailboxAttempt', 'maxMailboxAttempts', 'retryReason', 'willRetry']) {
        if (detail[key] !== undefined) active[key] = detail[key];
      }
      this.recordEvent('rebind_stage', { ...active, otp: undefined });
    };
    this.state.active.push(active);
    let proxy;
    try {
      onStage('proxy_check');
      proxy = await ctx.resolveProxy(slot, (detail) => {
        active.proxyCheck = detail;
        this.recordEvent('rebind_proxy_check', { assetId: asset.id, ...detail });
      });
      if (this.stopRequested) return;
    } catch (error) {
      this.recordResult({ assetId: asset.id, status: 'error', stage: 'proxy_check', code: error.code || 'PROXY_PROBE_FAILED', error: text(error.message) }, asset, ctx.provider, 0);
      return;
    }
    active.proxy = maskProxyUrl(proxy);
    const rebindProxy = ctx.proxyPool?.describe(slot) || sourceProxySummary({ url: proxy });
    active.rebindProxy = rebindProxy;
    let result;
    // The chain owns retries at each operation; this service invokes it once so
    // a recovered connection cannot claim another mailbox or replay a change.
    const login = ({ signal, email, reason, onProgress }) => this.loginAsset(
      { ...asset, email: email || asset.email }, proxy, signal, onProgress,
      reason === 'after_rebind' ? { previousEmail: asset.email, email, accountId: asset.accountId } : undefined,
    );
    try {
      result = await this.rebindAccount({
        asset,
        proxy,
        newProvider: ctx.provider,
        login: canRefresh ? login : undefined,
        postLogin: hasCredentials ? login : undefined,
        alwaysFreshLogin: ctx.alwaysFreshLogin === true,
        proxyRetries: ctx.proxyRetries,
        otpRetries: ctx.otpRetries,
        claimEmail: async () => {
          const claimed = await ctx.channel.claim();
          active.newEmail = text(claimed?.email);
          return claimed;
        },
        readOtp: (mailboxId, opts) => ctx.channel.readOtp(mailboxId, opts),
        releaseEmail: (mailboxId) => ctx.channel.release(mailboxId),
        consumeEmail: (mailboxId, opts) => ctx.channel.consume(mailboxId, opts),
        log: (event, detail) => this.recordEvent(event, { ...detail, proxy: active.proxy }),
        onStage,
        onProgress: (detail) => {
          if (detail.loginStep !== undefined && active.loginStep !== detail.loginStep) {
            active.loginStep = detail.loginStep;
            if (!active.loginStepsReached.includes(detail.loginStep)) active.loginStepsReached.push(detail.loginStep);
            this.recordEvent('rebind_login_step', { assetId: asset.id, stage: active.stage, step: active.loginStep, attempt: active.attempt });
          }
          if (detail.otp) active.otp = detail.otp;
          if (detail.connectionRetry) {
            active.connectionRetry = sanitizeValue(detail.connectionRetry, { redactPii: false });
            active.attempt = detail.connectionRetry.attempt + 1;
          }
        },
      });
    } catch (error) {
      result = { assetId: asset.id, previousEmail: asset.email, status: 'error', stage: 'unhandled', proxyRetryable: false, error: text(error?.message).slice(0, 200) };
    }
    const attempts = result.attempts || 1;
    if (attempts > 1) this.state.proxyRetried += 1;

    const confirmed = result.status === 'ok' || result.changeConfirmed === true;
    if (confirmed || result.refreshed || result.verificationUncertain) {
      try {
        onStage('save');
        const checkedAt = nowIso();
        store.update(asset.id, {
          ...this.refreshedSession(result),
          ...(confirmed ? {
            email: result.newEmail,
            rebindProxy,
            mailProvider: ctx.provider,
            parentEmail: result.newEmail,
            parentMailboxId: result.mailboxId,
            ...(result.status === 'ok'
              ? { status: 'valid', lastError: null, lastValidatedAt: checkedAt }
              : { status: 'partial', lastError: { code: result.code || 'REBIND_PROBE_FAILED', message: result.error || '换绑已确认，登录态尚未验证' } }),
            health: result.status === 'ok'
              ? { status: 'healthy', code: 'AT_VALID', message: '换绑后使用原代理刷新登录态并测活通过', httpStatus: result.health?.httpStatus || 200, checkedAt, lastHealthyAt: checkedAt }
              : { status: 'uncertain', code: result.postRefreshed ? result.code || 'REBIND_PROBE_FAILED' : 'REBIND_SESSION_REFRESH_PENDING', message: result.error, checkedAt },
            rebind: { previousEmail: result.previousEmail, newEmail: result.newEmail, previousProvider: 'icloud', provider: ctx.provider, mailboxId: result.mailboxId, reboundAt: checkedAt, postRefreshed: result.postRefreshed === true, runId },
          } : result.verificationUncertain ? {
            rebind: { ...asset.rebind, verificationUncertain: true, pendingEmail: result.newEmail, provider: ctx.provider, mailboxId: result.mailboxId, checkedAt, runId },
          } : {}),
        });
        if (confirmed) this.state.reboundEmails.push(result.previousEmail);
        if (confirmed || result.verificationUncertain) {
          this.queueIds = this.queueIds.filter((id) => id !== asset.id);
          this.saveQueue();
        }
      } catch (error) {
        result.status = 'upsert_fail';
        result.error = `${confirmed ? '已换绑，但' : ''}账号状态写回失败: ${text(error?.message).slice(0, 150)}`;
      }
    }
    this.recordResult({ ...result, rebindProxy: confirmed ? rebindProxy : null, proxy: maskProxyUrl(proxy) }, asset, ctx.provider, attempts);
  }

  refreshedSession(result) {
    return Object.fromEntries(['accessToken', 'oaiDid', 'accountId', 'session', 'cookieJar', 'sessionToken', 'clientProfile', 'me', 'planType', 'usage', 'lastValidatedAt']
      .filter((key) => result[key] !== undefined).map((key) => [key, result[key]]));
  }

  recordResult(result, asset, provider, attempts) {
    this.state.done += 1;
    if (result.status === 'ok') this.state.ok += 1;
    else this.state.fail += 1;
    if (result.status === 'needs_refresh') this.state.needsRefresh += 1;
    if (result.refreshed) this.state.refreshed += 1;
    const entry = sanitizeValue({
      assetId: result.assetId,
      previousEmail: result.previousEmail || asset.email,
      newEmail: result.newEmail || '',
      provider,
      status: result.status,
      stage: result.stage || '',
      code: result.code || '',
      ...(result.failure ? { failure: result.failure } : {}),
      attemptErrors: result.attemptErrors || [],
      refreshed: result.refreshed === true,
      postRefreshed: result.postRefreshed === true,
      mailboxAttempts: result.mailboxAttempts || 0,
      mailboxRetries: result.mailboxRetries || [],
      changeConfirmed: result.changeConfirmed === true,
      warning: result.warning || '',
      ...(result.otpDiagnostics ? { otpDiagnostics: result.otpDiagnostics } : {}),
      attempts,
      proxy: result.proxy || '',
      rebindProxy: result.rebindProxy || null,
      error: result.error || '',
      at: nowIso(),
    }, { redactPii: false });
    this.state.results.push(entry);
    this.recordEvent('rebind_result', entry);
    if (this.state.results.length > MAX_RESULTS) this.state.results.splice(0, this.state.results.length - MAX_RESULTS);
  }

  async runBatch(assets, ctx) {
    const store = this.store();
    let cursor = 0;
    const runId = this.state.runId || `rebind-${Date.now()}`;
    const worker = async (workerIndex) => {
      const slot = workerIndex + 1;
      for (;;) {
        if (this.stopRequested) return;
        const index = cursor;
        cursor += 1;
        if (index >= assets.length) return;
        try {
          await this.processAsset(assets[index], slot, ctx, store, runId);
        } finally {
          ctx.proxyPool?.release(slot);
          this.state.active = this.state.active.filter((item) => item.assetId !== assets[index].id);
        }
      }
    };
    try {
      const finished = await Promise.allSettled(Array.from({ length: Math.max(1, ctx.workerConcurrency) }, (_unused, i) => worker(i)));
      const failed = finished.find((item) => item.status === 'rejected');
      if (failed) throw failed.reason;
    } finally {
      this.state.running = false;
      this.state.finishedAt = nowIso();
    }
  }

  status() {
    return {
      ...this.state, starting: this.starting, results: this.state.results.slice(-200), stopRequested: this.stopRequested,
      active: this.state.active.map((item) => ({
        ...item,
        elapsedSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(item.stageStartedAt)) / 1000)),
        totalElapsedSeconds: Math.max(0, Math.floor((Date.now() - Date.parse(item.startedAt || item.stageStartedAt)) / 1000)),
      })),
    };
  }

  stop() {
    if (!this.state.running) return { ok: true, running: false };
    this.stopRequested = true;
    return { ok: true, running: true, stopRequested: true };
  }
}

module.exports = {
  RebindService,
};
