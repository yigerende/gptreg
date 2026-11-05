'use strict';

const fs = require('node:fs');
const path = require('node:path');

const Fastify = require('fastify');
const { ConfigService, withoutSecrets } = require('./config-service');
const { SmsbowerMailService } = require('./smsbower-mail-service');
const { LogStore } = require('./log-store');
const { ProxyService } = require('./proxy-service');
const { RunManager } = require('./run-manager');
const { RebindService } = require('./rebind-service');
const { ChainService } = require('./chain-service');
const { RobotService } = require('./robot-service');
const { LinkOpsService } = require('./linkops-service');
const { isSafeCpaArtifactKey } = require('../cpa-filename');
const { summarizeSmsPreflight } = require('../preflight-resources');
const { safeAssetId } = require('../session-asset-store');
const { attachmentDisposition, exportFileName } = require('../export-file-name');
const { DEFAULT_AT_PROBE_PROXY, probeSessionAssets } = require('../session-asset-health');
const { checkSessionAssetTrials } = require('../session-trial-check');
const { totpCode } = require('../chatgpt-session-runner');
const { DEFAULT_SMSBOWER_BASE_URL, SMSBOWER_COUNTRY_CATALOG, createSmsProvider } = require('../sms-provider');
const { HttpError, mergeObjects, safeRunId, sanitizeValue, scrubString } = require('./utils');

const MAX_SESSION_ASSET_BATCH_SIZE = 500;

function stripLiveAliasDomainConfig(value) {
  const copy = JSON.parse(JSON.stringify(value || {}));
  if (copy.mail && typeof copy.mail === 'object' && !Array.isArray(copy.mail)) {
    delete copy.mail.aliasDomainMode;
    delete copy.mail.aliasDomains;
    delete copy.mail.aliasBatchSize;
    delete copy.mail.providerSettings;
    delete copy.mail.providerEnabled;
  }
  // SMS provider settings are snapshotted into each run context. Persisting a
  // change while another run is active therefore affects only later tasks.
  delete copy.sms;
  return copy;
}

function isLiveAliasDomainConfigUpdate(configService, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  if (payload.secretPatch && Object.keys(payload.secretPatch).length) return false;
  if (Array.isArray(payload.clearSecrets) && payload.clearSecrets.length) return false;
  if (!payload.config || typeof payload.config !== 'object' || Array.isArray(payload.config)) return false;
  const current = withoutSecrets(configService.readRaw());
  const candidate = mergeObjects(current, withoutSecrets(payload.config));
  return JSON.stringify(stripLiveAliasDomainConfig(current))
    === JSON.stringify(stripLiveAliasDomainConfig(candidate));
}

async function checkService(name, url) {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    return { name, status: response.status < 500 ? 'online' : 'degraded', httpStatus: response.status, latencyMs: Date.now() - started };
  } catch (error) {
    return { name, status: 'offline', httpStatus: 0, latencyMs: Date.now() - started, message: error.name === 'AbortError' ? 'timeout' : error.message };
  } finally {
    clearTimeout(timer);
  }
}

async function readSmsBalance(config) {
  const provider = createSmsProvider(config);
  return typeof provider.getBalance === 'function' ? provider.getBalance() : null;
}

async function checkSmsService(config = {}, balanceReader = readSmsBalance) {
  const name = String(config.provider || 'smsbower');
  if (name !== 'mock' && name !== 'firefox' && !config.apiKey) return { name, status: 'missing', message: 'SMS API key is missing' };
  try {
    const value = await balanceReader(config);
    if (value === null || value === undefined) return { name, status: 'configured' };
    const balance = Number(value);
    if (!Number.isFinite(balance)) throw new Error('SMS balance response is invalid');
    return { name, status: 'online', balance, currency: name === 'firefox' ? 'CNY' : 'USD' };
  } catch (error) {
    return { name, status: 'degraded', message: String(error?.message || 'SMS balance request failed') };
  }
}

function smsMarketConfig(configService, provider, options = {}) {
  const raw = configService.readRaw();
  const normalized = configService.normalized();
  const rawSms = raw.sms || {};
  if (provider === 'hero-sms') return require('../sms-settings').effectiveSmsConfig(rawSms, provider);
  const sms = { ...(normalized.sms || {}), provider };
  if (provider === 'smsbower') {
    const bower = normalized.sms?.smsbower || normalized.sms || {};
    const storedBaseUrl = String(rawSms.baseUrl || '');
    sms.baseUrl = storedBaseUrl && !/firefox\.fun/i.test(storedBaseUrl)
      ? storedBaseUrl
      : DEFAULT_SMSBOWER_BASE_URL;
    sms.apiKey = rawSms.apiKey || bower.apiKey || '';
    sms.apiKeyEnv = rawSms.apiKeyEnv || 'SMSBOWER_API_KEY';
    sms.service = rawSms.service || { code: 'dr' };
    sms.country = rawSms.country || bower.country || { id: 151, name: 'Chile' };
    sms.countries = Array.isArray(rawSms.countries) && rawSms.countries.length
      ? rawSms.countries
      : (bower.countries || [sms.country]);
    if (options.includeCatalog === true) sms.countries = SMSBOWER_COUNTRY_CATALOG;
    sms.maxPrice = rawSms.maxPrice ?? bower.maxPrice;
  } else {
    sms.firefox = { ...(normalized.sms?.firefox || {}), ...(rawSms.firefox || {}) };
  }
  return sms;
}

async function readSmsMarket(config = {}) {
  const provider = createSmsProvider(config);
  let result;
  if (provider.name === 'firefox') {
    const countries = await provider.listCountriesForConfig();
    result = {
      provider: provider.name,
      ready: true,
      currency: 'CNY',
      service: { code: provider.iid, name: provider.projectName },
      country: { id: 'cheapest', name: '自动最低价' },
      prices: countries.map((country) => ({ country: country.code, price: country.price, count: 1, providerId: country.code })),
    };
  } else {
    result = await provider.preflight({ checkBalance: false });
    /* Keep the market endpoint independent of account balance. The selector
       UI needs country prices even when the account is temporarily empty. */
    result = {
      provider: provider.name,
      ready: true,
      currency: 'USD',
      service: result.service,
      country: result.country,
      countries: result.countries,
      prices: result.prices,
      maxPrice: result.maxPrice,
    };
  }
  // Keep the shared cap in the market snapshot. The provider already uses it
  // to mark each country eligible/ineligible, but dropping it here made the
  // UI report `maxPrice: null` even though the same cap guarded acquisition.
  const summary = summarizeSmsPreflight(result, { ...config, provider: provider.name }, { required: false, concurrency: 1 });
  return {
    provider: summary.provider,
    currency: summary.currency,
    service: summary.service,
    country: summary.country,
    countries: summary.countries,
    availableCountries: summary.availableCountries,
    ready: summary.ready,
    maxPrice: summary.maxPrice,
    issue: summary.issue,
    message: summary.message,
    cheapestPrice: summary.cheapestPrice,
    offers: summary.offers,
    lowestOffers: summary.lowestOffers,
    checkedAt: new Date().toISOString(),
  };
}

function requestedAssetId(value) {
  try { return safeAssetId(value); } catch { throw new HttpError(400, 'Invalid login-state asset id'); }
}

function buildApp(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 2 * 1024 * 1024 });
  const configService = options.configService || new ConfigService({ cwd, configPath: options.configPath });
  const logStore = options.logStore || new LogStore({
    cwd,
    stateDir: () => path.resolve(cwd, configService.readRaw().output?.stateDir || '.gpt-re-state/v2'),
  });
  const proxyService = options.proxyService || new ProxyService(configService);
  const smsbowerMail = new SmsbowerMailService(configService, { fetch: options.smsbowerMailFetch });
  const runManager = options.runManager || new RunManager({
    cwd,
    configService,
    logStore,
    proxyService,
    harPath: options.harPath,
    deferBootMaintenance: options.deferBootMaintenance === true,
    sub2ApiFetch: options.sub2ApiFetch,
    nvtokensFetch: options.nvtokensFetch,
    // Tests hand in the store they seeded so both sides read one instance;
    // in production the manager opens its own from the configured paths.
    assetStore: options.assetStore,
  });
  const linkops = options.linkops || new LinkOpsService({ cwd, configService });
  const chainService = options.chainService || new ChainService({
    cwd,
    configService,
    proxyService,
    sessionAssets: () => runManager.sessionAssets(),
    sessionAssetIdsInUse: () => runManager.sessionAssetIdsInUse(),
    runner: options.chainRunner,
    linkops,
  });
  const robotService = options.robotService || new RobotService({
    cwd,
    configService,
    proxyService,
    runManager,
    chainService,
    logStore,
  });
  robotService.start();
  const rebindService = options.rebindService || new RebindService({ cwd, configService, proxyService, runManager, logStore });
  // The log directory had no ceiling of its own — it was bounded only by run
  // retention, so nothing was reclaimed until a task happened to finish. Sweep
  // once at boot, then opportunistically as events arrive.
  try { logStore.sweep({ protect: runManager.activeRunIds?.() || [] }); } catch { /* Boot must not fail on maintenance. */ }
  app.addHook('onClose', async () => { await robotService.shutdown(); });
  const sessionAssetProbe = options.sessionAssetProbe || probeSessionAssets;
  const sessionAssetTrialCheck = options.sessionAssetTrialCheck || checkSessionAssetTrials;
  const smsBalanceReader = options.smsBalanceReader || readSmsBalance;
  const smsMarketReader = options.smsMarketReader || readSmsMarket;
  // Keep the dashboard balance and the provider's own account cache on the
  // same short cadence. A manual resource refresh should not keep showing an
  // hour-old balance simply because the service summary was cached longer.
  // Firefox.fun limits myInfo to one request per token every 60 seconds.
  // Keep the dashboard responsive through cached responses without turning
  // the 15-second service health poll into a provider balance poll.
  const smsStatusTtlMs = Math.max(1_000, Number(options.smsStatusTtlMs || 65_000));
  let smsStatusCache = null;
  let smsStatusPending = null;

  const smsStatus = async (config) => {
    const sms = config.sms || {};
    const key = JSON.stringify([
      sms.provider || 'smsbower',
      sms.baseUrl || '',
      sms.apiKey || '',
      sms.firefox?.baseUrl || '',
      sms.firefox?.token || '',
      sms.firefox?.maxPrice ?? null,
      sms.firefox?.countries || [],
    ]);
    const now = Date.now();
    if (smsStatusCache?.key === key && smsStatusCache.expiresAt > now) return smsStatusCache.value;
    if (smsStatusPending?.key === key) return smsStatusPending.promise;
    const promise = checkSmsService(sms, smsBalanceReader);
    smsStatusPending = { key, promise };
    try {
      const value = await promise;
      smsStatusCache = { key, value, expiresAt: Date.now() + smsStatusTtlMs };
      return value;
    } finally {
      if (smsStatusPending?.promise === promise) smsStatusPending = null;
    }
  };

  app.decorate('services', { configService, logStore, proxyService, runManager, chainService, linkops, sessionAssetProbe, sessionAssetTrialCheck, rebindService });
  app.addHook('onClose', async () => runManager.shutdown());

  app.get('/api/v1/health', async () => ({
    ok: true,
    activeRunId: typeof runManager.primaryActiveRunId === 'function' ? runManager.primaryActiveRunId() : (runManager.active?.state.runId || ''),
    activeRunIds: typeof runManager.activeRunIds === 'function' ? runManager.activeRunIds() : [],
    taskCapacity: typeof runManager.taskCapacitySnapshot === 'function' ? runManager.taskCapacitySnapshot() : null,
    now: new Date().toISOString(),
  }));

  app.get('/api/v1/services', async (request, reply) => {
    const storedConfig = configService.readRaw();
    const requestedSmsProvider = String(request.query?.smsProvider || '').trim().toLowerCase();
    const config = ['smsbower', 'firefox', 'hero-sms'].includes(requestedSmsProvider)
      ? { ...storedConfig, sms: { ...(storedConfig.sms || {}), provider: requestedSmsProvider } }
      : storedConfig;
    reply.header('Cache-Control', 'no-store');
    const [mail, sms] = await Promise.all([
      checkService('mail', config.mail?.baseUrl || 'http://127.0.0.1:8000'),
      smsStatus({ ...config, sms: require('../sms-settings').effectiveSmsConfig(config.sms, config.sms?.provider) }),
    ]);
    return {
      services: [mail],
      sms,
    };
  });

  app.get('/api/v1/config', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return configService.snapshot();
  });

  app.get('/api/v1/sms/firefox/countries', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const raw = configService.readRaw();
    const provider = createSmsProvider({
      provider: 'firefox',
      ...(raw.sms?.firefox && typeof raw.sms.firefox === 'object' ? raw.sms.firefox : {}),
    });
    return { countries: await provider.listCountriesForConfig() };
  });

  app.get('/api/v1/sms/market', async (request, reply) => {
    const provider = String(request.query?.provider || configService.readRaw().sms?.provider || 'smsbower').trim().toLowerCase();
    if (!['smsbower', 'firefox', 'hero-sms'].includes(provider)) throw new HttpError(400, 'Unsupported SMS provider');
    reply.header('Cache-Control', 'no-store');
    return smsMarketReader(smsMarketConfig(configService, provider, { includeCatalog: provider === 'smsbower' }));
  });

  const { SmsSettingsService } = require('./sms-settings-service');
  const smsSettings = new SmsSettingsService(configService, { fetch: options.smsSettingsFetch });
  app.get('/api/v1/sms/settings/:provider', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return smsSettings.read(request.params.provider);
  });
  app.post('/api/v1/sms/settings/:provider/test', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return smsSettings.test(request.params.provider, request.body || {});
  });
  app.put('/api/v1/sms/settings/:provider', async (request, reply) => {
    // Legacy live runs do not have a private SMS config snapshot yet.
    if (runManager.starting || runManager.auxiliaryStarting || runManager.customerStarting || runManager.activeRuns().some((r) => !r.state.smsConfig)) throw new HttpError(409, '请等待正在启动或旧版任务结束后保存短信配置');
    const result = smsSettings.save(request.params.provider, request.body || {});
    smsStatusCache = null;
    reply.header('Cache-Control', 'no-store');
    return result;
  });

  app.post('/api/v1/config/validate', async (request) => configService.validate(request.body?.config || request.body || {}));

  app.put('/api/v1/config', async (request, reply) => {
    const liveRun = runManager.active || runManager.starting;
    if (liveRun && !isLiveAliasDomainConfigUpdate(configService, request.body || {})) {
      throw new HttpError(409, '任务进行中只能修改 Mail API 的别名域名与批次设置；其它配置请在任务结束后修改');
    }
    reply.header('Cache-Control', 'no-store');
    return configService.update(request.body || {});
  });

  app.get('/api/v1/mailcom/status', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return runManager.mailcomStatus(request.query?.provider || '');
  });
  app.post('/api/v1/mailcom/import', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    // Returns as soon as the batch is accepted. Alias creation is tens of
    // seconds of remote work per master; holding the request open for it is
    // what forced the dialog to sit and spin.
    const result = await runManager.startMailcomImport(request.body?.content || '', request.body?.provider || '');
    reply.code(202);
    return result;
  });
  app.get('/api/v1/mailcom/import', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return runManager.mailcomImportProgress();
  });
  app.get('/api/v1/icloud/status', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return runManager.icloudStatus();
  });
  app.post('/api/v1/icloud/import', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const result = await runManager.startIcloudImport(request.body?.content || '');
    reply.code(202);
    return result;
  });
  app.get('/api/v1/icloud/import', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return runManager.icloudImportProgress();
  });

  app.post('/api/v1/preflight', async (request) => runManager.preflight(request.body?.plan || {}));

  app.get('/api/v1/runs', async (request) => ({
    activeRunId: typeof runManager.primaryActiveRunId === 'function' ? runManager.primaryActiveRunId() : (runManager.active?.state.runId || ''),
    activeRunIds: typeof runManager.activeRunIds === 'function' ? runManager.activeRunIds() : [],
    taskCapacity: typeof runManager.taskCapacitySnapshot === 'function' ? runManager.taskCapacitySnapshot() : null,
    runs: runManager.list({ compact: request.query?.compact === '1' }),
  }));
  app.post('/api/v1/runs', async (request, reply) => {
    const result = await runManager.start(request.body?.plan || {});
    reply.code(202);
    return result;
  });
  app.delete('/api/v1/runs', async (request) => runManager.removeMany(request.body?.runIds, {
    artifacts: request.body?.artifacts === true,
  }));
  app.get('/api/v1/runs/:runId', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return runManager.get(safeRunId(request.params.runId), { reveal: request.query?.reveal === '1' });
  });
  app.post('/api/v1/runs/:runId/balance-reconciliation', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return runManager.reconcileBalance(safeRunId(request.params.runId));
  });
  app.post('/api/v1/runs/:runId/pause', async (request, reply) => {
    reply.code(202);
    return runManager.pause(safeRunId(request.params.runId));
  });
  app.post('/api/v1/runs/:runId/resume', async (request, reply) => {
    reply.code(202);
    return runManager.resume(safeRunId(request.params.runId), request.body || {});
  });
  app.post('/api/v1/runs/:runId/cancel', async (request, reply) => {
    reply.code(202);
    return runManager.cancel(safeRunId(request.params.runId), request.body?.reason, {
      resolveSmsAcquisition: request.body?.resolveSmsAcquisition,
    });
  });
  app.post('/api/v1/runs/:runId/mail-rental/stop', async (request, reply) => {
    reply.code(202);
    return runManager.stopMailRental(safeRunId(request.params.runId));
  });
  app.post('/api/v1/runs/:runId/mail-rental/configure', async (request, reply) => {
    reply.code(202);
    return runManager.configureMailRental(safeRunId(request.params.runId), request.body || {});
  });
  app.post('/api/v1/runs/:runId/jobs/:jobId/skip', async (request) => runManager.skip(
    safeRunId(request.params.runId),
    String(request.params.jobId || ''),
    request.body?.reason,
  ));
  // Keep the literal `retry` segment ahead of `:jobId/retry` so several
  // waiting SMS acquisitions can be authorized in one scheduler wake-up.
  app.post('/api/v1/runs/:runId/jobs/retry', async (request, reply) => {
    reply.code(202);
    return runManager.retryJobs(
      safeRunId(request.params.runId),
      request.body?.jobIds,
      {
        resolveEffect: request.body?.resolveEffect,
        resolveSmsAcquisition: request.body?.resolveSmsAcquisition,
      },
    );
  });
  app.post('/api/v1/runs/:runId/jobs/:jobId/retry', async (request, reply) => {
    reply.code(202);
    return runManager.retryJob(
      safeRunId(request.params.runId),
      String(request.params.jobId || ''),
      {
        resolveEffect: request.body?.resolveEffect,
        resolveSmsAcquisition: request.body?.resolveSmsAcquisition,
      },
    );
  });
  app.get('/api/v1/runs/:runId/cpa', async (request, reply) => {
    const runId = safeRunId(request.params.runId);
    const download = runManager.cpaDownload(runId);
    reply.header('Content-Type', 'application/json; charset=utf-8');
    reply.header('Content-Disposition', attachmentDisposition(download.fileName));
    reply.header('Cache-Control', 'no-store');
    return download.value;
  });
  app.get('/api/v1/runs/:runId/cpa/:jobId', async (request, reply) => {
    const runId = safeRunId(request.params.runId);
    const jobId = String(request.params.jobId || '').trim();
    if (!isSafeCpaArtifactKey(jobId)) throw new HttpError(400, 'Invalid CPA job id');
    const download = runManager.cpaDownload(runId, jobId);
    reply.header('Content-Type', 'application/json; charset=utf-8');
    reply.header('Content-Disposition', attachmentDisposition(download.fileName));
    reply.header('Cache-Control', 'no-store');
    return download.value;
  });
  app.delete('/api/v1/runs/:runId', async (request) => runManager.remove(safeRunId(request.params.runId), {
    artifacts: request.query?.artifacts === '1',
  }));

  app.get('/api/v1/artifacts/cpa', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    // Serialized by the run manager, which keeps the string while the listing
    // signature holds. Setting the content type ourselves stops Fastify from
    // stringifying an already-JSON string a second time.
    reply.header('Content-Type', 'application/json; charset=utf-8');
    return runManager.cpaArtifactsJson({
      reveal: request.query?.reveal === '1',
      includeLocked: request.query?.locked !== '0',
    });
  });
  // One artifact by its file-level key: the per-row download link. The run/job
  // pair can name two files, and a link built from it would hand back both.
  app.get('/api/v1/artifacts/cpa/download', async (request, reply) => {
    const download = runManager.cpaDownloadByKey(String(request.query?.key || ''));
    reply.header('Content-Type', 'application/json; charset=utf-8');
    reply.header('Content-Disposition', attachmentDisposition(download.fileName));
    reply.header('Cache-Control', 'no-store');
    return download.value;
  });
  app.get('/api/v1/artifacts/cpa/export', async (_request, reply) => {
    reply.header('Content-Type', 'application/json; charset=utf-8');
    reply.header('Cache-Control', 'no-store');
    const accounts = runManager.exportAllCpa();
    reply.header('Content-Disposition', attachmentDisposition(exportFileName({ label: 'CPA', count: accounts.length, ext: 'json' })));
    return accounts;
  });
  app.post('/api/v1/artifacts/cpa/export', async (request, reply) => {
    reply.header('Content-Type', 'application/json; charset=utf-8');
    reply.header('Cache-Control', 'no-store');
    const accounts = runManager.exportCpa(request.body || {});
    reply.header('Content-Disposition', attachmentDisposition(exportFileName({ label: 'CPA', count: accounts.length, ext: 'json' })));
    return accounts;
  });
  app.post('/api/v1/artifacts/cpa/lock', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return runManager.lockCpaArtifacts(request.body?.items, request.body?.batchKey);
  });
  app.post('/api/v1/artifacts/cpa/unlock', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return runManager.unlockCpaArtifacts(request.body?.items);
  });
  // The same check the credential export makes, with nothing written: the
  // console runs it over every batch of a large selection before sending any of
  // them, so one incomplete account still means the whole selection stays home.
  app.post('/api/v1/artifacts/cpa/credentials/preflight', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return runManager.preflightCpaCredentials(request.body || {});
  });
  app.post('/api/v1/artifacts/cpa/credentials', async (request, reply) => {
    const download = runManager.exportCpaCredentials(request.body || {});
    reply.header('Content-Type', download.contentType);
    reply.header('Content-Disposition', attachmentDisposition(download.fileName));
    reply.header('Cache-Control', 'no-store');
    return reply.send(download.content);
  });
  app.post('/api/v1/artifacts/cpa/sub2api', async (request, reply) => {
    reply.header('Content-Type', 'application/json; charset=utf-8');
    reply.header('Cache-Control', 'no-store');
    const document = runManager.exportSub2Api(request.body || {});
    reply.header('Content-Disposition', attachmentDisposition(exportFileName({ label: 'sub2api', count: document?.accounts?.length || 0, ext: 'json' })));
    return document;
  });
  // Batch archives: one file per account inside a folder, for anything that
  // consumes credential files one at a time rather than as a merged array.
  app.post('/api/v1/artifacts/cpa/export/archive', async (request, reply) => {
    const archive = runManager.exportCpaArchive(request.body || {});
    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', attachmentDisposition(archive.fileName));
    reply.header('Cache-Control', 'no-store');
    return reply.send(archive.buffer);
  });
  // Hands the selected CPAs to the local sub2api gateway instead of the
  // browser. Not a download: the reply is the gateway's import tally, and a
  // partial success (one expired access token in a batch) is a 200 whose
  // `failed` count and `errors` the console renders.
  app.post('/api/v1/artifacts/cpa/sub2api/push', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return runManager.pushSub2Api(request.body || {});
  });
  app.post('/api/v1/artifacts/cpa/nvtokens/cards/import', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return runManager.pushNvtokensCards(request.body || {});
  });
  app.post('/api/v1/artifacts/cpa/nvtokens/mailboxes/import', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return runManager.pushNvtokensMailboxes(request.body || {});
  });
  app.post('/api/v1/artifacts/cpa/nvtokens/pool', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return runManager.pushNvtokensPool(request.body || {});
  });
  app.post('/api/v1/artifacts/cpa/sub2api/archive', async (request, reply) => {
    const archive = runManager.exportSub2ApiArchive(request.body || {});
    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', attachmentDisposition(archive.fileName));
    reply.header('Cache-Control', 'no-store');
    return reply.send(archive.buffer);
  });
  app.delete('/api/v1/artifacts/cpa', async (request) => runManager.removeCpaArtifacts(request.body?.items));

  // ── sub2api gateway ────────────────────────────────────────────────────────
  // Reading and pruning the accounts already handed to the gateway, as opposed
  // to `/artifacts/cpa/sub2api/*`, which is about what leaves this side.
  app.get('/api/v1/sub2api/accounts/failed', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return runManager.sub2ApiFailedAccounts();
  });
  app.delete('/api/v1/sub2api/accounts', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return runManager.removeSub2ApiAccounts(request.body?.accountIds);
  });

  // ── upkeep exits ───────────────────────────────────────────────────────────
  // Work on an account that already exists does not go through the country
  // pools: a probe or an OAuth top-up wants a stable address, not a fresh
  // residential IP, and the pools are a paid resource registration needs.
  const maintenanceProxy = () => String(configService.normalized().proxyPool?.maintenanceProxy || '').trim()
    || DEFAULT_AT_PROBE_PROXY;

  /**
   * One filtered page of login states, with the counts for every axis.
   *
   * The counts ship with the rows because they have to be the same
   * computation: the console previously derived its own groups and counted
   * them over a different set than it rendered, so a group could promise 1330
   * accounts and draw 171.
   */
  app.get('/api/v1/session-assets', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const query = request.query || {};
    const requestedFacets = query.facet ?? query.facets;
    return runManager.sessionAssets().query({
      lifecycle: query.lifecycle,
      queue: query.queue,
      facets: Array.isArray(requestedFacets) ? requestedFacets : (requestedFacets ? [requestedFacets] : []),
      sourceRun: query.sourceRun,
      q: query.q,
      cursor: query.cursor,
      limit: query.limit,
      sort: query.sort,
    });
  });
  // Registered ahead of `/:assetId` so the literal segment wins the route match.
  app.get('/api/v1/session-assets/ids', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const query = request.query || {};
    const requestedFacets = query.facet ?? query.facets;
    return runManager.sessionAssets().matchedIds({
      lifecycle: query.lifecycle,
      queue: query.queue,
      facets: Array.isArray(requestedFacets) ? requestedFacets : (requestedFacets ? [requestedFacets] : []),
      sourceRun: query.sourceRun,
      q: query.q,
    });
  });
  const moveLifecycle = async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const assetIds = Array.isArray(request.body?.assetIds) ? request.body.assetIds.map(requestedAssetId) : [];
    if (!assetIds.length) throw new HttpError(400, 'Select at least one login-state asset');
    if (assetIds.length > MAX_SESSION_ASSET_BATCH_SIZE) throw new HttpError(400, `Select at most ${MAX_SESSION_ASSET_BATCH_SIZE} login-state assets`);
    const inUseAssets = runManager.sessionAssetIdsInUse();
    if (assetIds.some((id) => inUseAssets.has(id))) {
      throw new HttpError(409, 'An active or resumable task is using one of the selected login-state assets');
    }
    try {
      // `classification` is the field's old name and older clients still send
      // it; both carry the same three settable pools.
      const requested = request.body?.lifecycle || request.body?.classification || 'sold';
      return runManager.sessionAssets().markLifecycle(assetIds, requested);
    } catch (error) {
      if (error.code === 'ENOENT') throw new HttpError(404, 'A selected login-state asset no longer exists');
      throw new HttpError(400, error.message);
    }
  };
  app.post('/api/v1/session-assets/lifecycle', moveLifecycle);
  // The pre-lifecycle path, kept so a rolled-back console keeps working.
  app.post('/api/v1/session-assets/classification', moveLifecycle);

  // Bare-email launch: the console pastes addresses that already carry saved
  // login-state and we hand back one asset id per address so the run can go in
  // through the `session_assets` source. Read-only — it starts nothing.
  app.post('/api/v1/session-assets/resolve', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const requested = Array.isArray(request.body?.emails) ? request.body.emails : [];
    if (requested.length > 100) throw new HttpError(400, 'At most 100 emails per resolve');
    const store = runManager.sessionAssets();
    const inUse = runManager.sessionAssetIdsInUse();
    // One scan of the store, indexed by address — `findIdentity` would re-read
    // every file per email, and this endpoint answers a whole paste at once.
    const byEmail = new Map();
    for (const asset of store.allRaw()) {
      if (!asset || asset.status === 'corrupt') continue;
      const key = String(asset.email || '').trim().toLowerCase();
      if (key && !byEmail.has(key)) byEmail.set(key, asset);
    }
    const seen = new Set();
    const matched = [];
    const unmatched = [];
    for (const raw of requested) {
      const email = String(raw || '').trim().toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || seen.has(email)) continue;
      seen.add(email);
      const asset = byEmail.get(email);
      if (!asset) { unmatched.push(email); continue; }
      matched.push({
        email,
        assetId: String(asset.id || ''),
        status: String(asset.status || ''),
        lifecycle: String(asset.lifecycle || asset.classification || ''),
        hasAccessToken: Boolean(asset.accessToken),
        accessTokenExpiresAt: String(asset.accessTokenExpiresAt || ''),
        inUse: inUse.has(String(asset.id || '')),
      });
    }
    return { matched, unmatched };
  });
  app.post('/api/v1/session-assets/:assetId/oauth-cooldown/clear', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const id = requestedAssetId(request.params.assetId);
    try {
      const result = runManager.sessionAssets().clearOAuthCooldown(id);
      return { id, cleared: result.changed, asset: result.asset };
    } catch (error) {
      if (error.code === 'ENOENT') throw new HttpError(404, `Login-state asset not found: ${id}`);
      throw error;
    }
  });
  app.get('/api/v1/session-assets/:assetId', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const id = requestedAssetId(request.params.assetId);
    try { return runManager.sessionAssets().detail(id); } catch (error) {
      if (error.code === 'ENOENT') throw new HttpError(404, `Login-state asset not found: ${id}`);
      throw error;
    }
  });
  app.get('/api/v1/session-assets/:assetId/totp', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const id = requestedAssetId(request.params.assetId);
    let asset;
    try { asset = runManager.sessionAssets().get(id); } catch (error) {
      if (error.code === 'ENOENT') throw new HttpError(404, `Login-state asset not found: ${id}`);
      throw error;
    }
    if (!asset.totpSecret) throw new HttpError(409, 'This login-state asset does not have a TOTP secret');
    const now = Date.now();
    return { code: totpCode(asset.totpSecret, now), expiresIn: 30 - (Math.floor(now / 1000) % 30) };
  });
  app.post('/api/v1/session-assets/refresh', async (request, reply) => {
    const assetIds = Array.isArray(request.body?.assetIds) ? request.body.assetIds.map(requestedAssetId) : [];
    if (!assetIds.length) throw new HttpError(400, 'Select at least one login-state asset');
    const result = await runManager.start({
      schemaVersion: 3,
      taskKind: 'session_refresh',
      workerConcurrency: request.body?.workerConcurrency,
      oauthSource: { kind: 'session_assets', assetIds },
      proxyAssignments: request.body?.proxyAssignments,
      security: request.body?.security || {},
    });
    reply.code(202);
    return result;
  });
  app.post('/api/v1/session-assets/probe', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const assetIds = Array.isArray(request.body?.assetIds) ? request.body.assetIds.map(requestedAssetId) : [];
    if (!assetIds.length) throw new HttpError(400, 'Select at least one login-state asset');
    if (assetIds.length > MAX_SESSION_ASSET_BATCH_SIZE) throw new HttpError(400, `Select at most ${MAX_SESSION_ASSET_BATCH_SIZE} login-state assets`);
    const inUseAssets = runManager.sessionAssetIdsInUse();
    if (assetIds.some((id) => inUseAssets.has(id))) {
      throw new HttpError(409, 'An active or resumable task is using one of the selected login-state assets');
    }
    try {
      return await sessionAssetProbe(runManager.sessionAssets(), assetIds, {
        concurrency: 4,
        proxy: maintenanceProxy(),
      });
    } catch (error) {
      if (error.code === 'ENOENT') throw new HttpError(404, 'A selected login-state asset no longer exists');
      throw error;
    }
  });
  app.post('/api/v1/session-assets/trial-check', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const assetIds = Array.isArray(request.body?.assetIds) ? request.body.assetIds.map(requestedAssetId) : [];
    if (!assetIds.length) throw new HttpError(400, 'Select at least one login-state asset');
    if (assetIds.length > MAX_SESSION_ASSET_BATCH_SIZE) throw new HttpError(400, `Select at most ${MAX_SESSION_ASSET_BATCH_SIZE} login-state assets`);
    const inUseAssets = runManager.sessionAssetIdsInUse();
    if (assetIds.some((id) => inUseAssets.has(id))) {
      throw new HttpError(409, 'An active or resumable task is using one of the selected login-state assets');
    }
    const store = runManager.sessionAssets();
    let result;
    try {
      // The promo check is upkeep on an account that already exists, so it goes
      // out through the local forwarder like every other upkeep call. It used
      // to draw a random JP pool exit per asset, which spent a paid resource
      // registration needs and made two checks of the same account answer from
      // two different addresses.
      result = await sessionAssetTrialCheck(store, assetIds, {
        concurrency: 4,
        proxy: maintenanceProxy(),
      });
    } catch (error) {
      if (error.code === 'ENOENT') throw new HttpError(404, 'A selected login-state asset no longer exists');
      throw error;
    }
    // An unknown promo verdict does not say whether the token is dead or the
    // check simply could not run. Probing those assets separates the two, and
    // a probe failure must not discard the promo result that already landed.
    const unknownIds = result.results.filter((item) => item.status === 'unknown').map((item) => item.assetId);
    if (!unknownIds.length) return { ...result, atProbe: null };
    try {
      const atProbe = await sessionAssetProbe(store, unknownIds, {
        concurrency: 4,
        proxy: maintenanceProxy(),
      });
      return { ...result, atProbe };
    } catch {
      return { ...result, atProbe: null };
    }
  });
  app.post('/api/v1/session-assets/export', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const assetIds = Array.isArray(request.body?.assetIds) ? request.body.assetIds.map(requestedAssetId) : [];
    if (!assetIds.length) throw new HttpError(400, 'Select at least one login-state asset');
    try {
      return runManager.sessionAssets().export(assetIds, {
        kind: request.body?.kind,
        format: request.body?.format,
      });
    } catch (error) {
      if (error.code === 'ENOENT') throw new HttpError(404, 'A selected login-state asset no longer exists');
      throw new HttpError(400, error.message);
    }
  });
  app.delete('/api/v1/session-assets', async (request) => {
    const assetIds = Array.isArray(request.body?.assetIds) ? request.body.assetIds.map(requestedAssetId) : [];
    if (!assetIds.length) throw new HttpError(400, 'Select at least one login-state asset');
    const inUseAssets = runManager.sessionAssetIdsInUse();
    const skipped = assetIds.filter((id) => inUseAssets.has(id));
    const removable = assetIds.filter((id) => !inUseAssets.has(id));
    const result = removable.length
      ? runManager.sessionAssets().remove(removable, { cascadeCpa: request.body?.cascadeCpa === true })
      : { requested: 0, removed: [], missing: [], cpaRemoved: request.body?.cascadeCpa === true };
    return { ...result, requested: assetIds.length, skipped };
  });
  // The external extraction/payment engine. These are a thin same-origin proxy
  // so the console never talks to :8082 cross-origin, exactly as it already
  // proxies the mail providers.
  app.get('/api/v1/linkops/status', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return linkops.status();
  });
  app.post('/api/v1/linkops/start', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return linkops.start();
  });
  app.get('/api/v1/linkops/jobs', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return linkops.jobs({
      domain: String(request.query?.domain || ''),
      provider: String(request.query?.provider || ''),
      status: String(request.query?.status || ''),
      limit: Number(request.query?.limit || 200),
    });
  });
  app.post('/api/v1/linkops/jobs', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.code(202);
    return linkops.createJob(request.body || {});
  });
  app.get('/api/v1/linkops/jobs/:jobId', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return linkops.job(String(request.params.jobId || ''));
  });
  app.post('/api/v1/linkops/jobs/:jobId/cancel', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return linkops.cancelJob(String(request.params.jobId || ''));
  });
  app.post('/api/v1/linkops/jobs/:jobId/retry', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return linkops.retryJob(String(request.params.jobId || ''));
  });
  app.delete('/api/v1/linkops/jobs/:jobId', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return linkops.deleteJob(String(request.params.jobId || ''));
  });
  app.post('/api/v1/linkops/jobs/batch-delete', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const ids = Array.isArray(request.body?.jobIds) ? request.body.jobIds : [];
    if (!ids.length) throw new HttpError(400, '请选择至少一个作业');
    return linkops.batchDeleteJobs(ids);
  });
  app.post('/api/v1/linkops/jobs/:jobId/input', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return linkops.submitInput(String(request.params.jobId || ''), request.body?.value);
  });
  // Proxy pools live in the engine, but the operator configures them from here
  // rather than by opening a second workbench. The engine pulls entries from
  // its own upstream source, so these inspect, re-pull, test and clear.
  app.get('/api/v1/linkops/proxy-pools/:provider/:country', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return linkops.proxyPool(String(request.params.provider || ''), String(request.params.country || ''), String(request.query?.role || 'checkout'));
  });
  app.post('/api/v1/linkops/proxy-pools/:provider/:country/refresh', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return linkops.refreshProxyPool(String(request.params.provider || ''), String(request.params.country || ''), String(request.query?.role || 'checkout'));
  });
  app.post('/api/v1/linkops/proxy-pools/:provider/:country/preflight', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return linkops.preflightProxyPool(String(request.params.provider || ''), String(request.params.country || ''), String(request.query?.role || 'checkout'), Number(request.body?.index ?? -1));
  });
  app.delete('/api/v1/linkops/proxy-pools/:provider/:country', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return linkops.clearProxyPool(String(request.params.provider || ''), String(request.params.country || ''), String(request.query?.role || 'checkout'));
  });
  app.get('/api/v1/linkops/links', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return linkops.extractedLinks(Number(request.query?.limit || 200));
  });
  app.get('/api/v1/chains', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return chainService.snapshot();
  });
  app.get('/api/v1/mailcom/domains', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return runManager.mailcomAliasDomains(request.query?.provider || '');
  });
  app.get('/api/v1/robots', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return robotService.snapshot();
  });
  // Registered before `/robots/:robotId`, or `runs` would be read as an id.
  app.delete('/api/v1/robots/runs', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return robotService.clearAllRuns();
  });
  app.patch('/api/v1/robots/:robotId', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return robotService.patchRobot(request.params.robotId, request.body || {});
  });
  app.post('/api/v1/robots/:robotId/start', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return robotService.startRobot(request.params.robotId);
  });
  app.post('/api/v1/robots/:robotId/stop', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return robotService.stopRobot(request.params.robotId);
  });
  app.post('/api/v1/robots/:robotId/commands', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return robotService.command(request.params.robotId, request.body?.command, request.body?.payload || {});
  });
  app.delete('/api/v1/robots/:robotId/runs', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return robotService.clearRuns(request.params.robotId);
  });

  // Registered before the `:chainId` route, or `probe` would be read as an id.
  app.post('/api/v1/chains/probe', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return chainService.probeTokens(request.body?.ids || []);
  });
  // Registered before the `:chainId` route, or `rules` would be read as an id.
  app.put('/api/v1/chains/rules', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { countryRules: chainService.saveCountryRules(request.body || {}) };
  });
  // Registered before `/chains/:chainId`, or `payment-status` would be read as
  // a chain id by the generic route.
  app.post('/api/v1/chains/payment-status', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const result = chainService.markPaymentStatus(request.body?.ids, request.body?.status);
    if (String(request.body?.status || '') === 'success'
      && result.changed?.length
      && typeof robotService?.requestRun === 'function') {
      // Wake the robot with only the records whose status changed in this
      // request. Historical payment-success rows are not a refresh queue.
      try {
        robotService.requestRun('account-maintenance', 'payment_success', {
          commandId: 'payment_success',
          payload: { assetIds: result.changed },
        });
      } catch {
        // Payment status is already durable. A custom test/service embedding
        // without the maintenance robot must not turn that successful write
        // into an HTTP error.
      }
    }
    return result;
  });
  app.get('/api/v1/chains/:chainId', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const id = requestedAssetId(request.params.chainId);
    try { return chainService.detail(id); } catch (error) {
      if (error.code === 'CHAIN_RECORD_NOT_FOUND') throw new HttpError(404, error.message);
      throw error;
    }
  });
  app.get('/api/v1/chains/:chainId/token', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const id = requestedAssetId(request.params.chainId);
    try { return chainService.accessToken(id); } catch (error) {
      if (error.code === 'CHAIN_RECORD_NOT_FOUND') throw new HttpError(404, error.message);
      throw error;
    }
  });
  app.post('/api/v1/chains/extract', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const result = await chainService.extract(request.body || {});
    reply.code(202);
    return result;
  });
  app.get('/api/v1/chains/payment-settings', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return chainService.paymentSettings();
  });
  app.put('/api/v1/chains/payment-settings', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return chainService.savePaymentSettings(request.body || {});
  });
  app.post('/api/v1/chains/pay', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.code(202);
    return chainService.payExtracted(request.body?.ids || []);
  });
  app.put('/api/v1/chains/:chainId/payment-phone', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return chainService.savePaymentPhone(requestedAssetId(request.params.chainId), request.body?.phone || '');
  });
  app.post('/api/v1/chains/import', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return chainService.importTokens(request.body || {});
  });
  app.delete('/api/v1/chains', async (request) => chainService.remove(request.body?.ids));
  app.get('/api/v1/mailboxes', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { mailboxes: await runManager.mailboxes() };
  });

  app.get('/api/v1/runs/:runId/logs', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const reveal = request.query?.reveal === '1';
    return {
      logs: logStore.read(safeRunId(request.params.runId), {
        since: request.query?.since,
        limit: request.query?.limit,
        reveal,
      }),
    };
  });

  app.delete('/api/v1/runs/:runId/logs', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return logStore.clear(safeRunId(request.params.runId));
  });

  app.get('/api/v1/runs/:runId/events', async (request, reply) => {
    const runId = safeRunId(request.params.runId);
    const reveal = request.query?.reveal === '1';
    const lastId = Number(request.headers['last-event-id'] || request.query?.since || 0);
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (record) => {
      const visible = reveal ? record : sanitizeValue(record, { redactPii: true });
      response.write(`id: ${record.seq}\nevent: log\ndata: ${JSON.stringify(visible)}\n\n`);
    };
    for (const record of logStore.read(runId, { since: lastId, reveal: true })) send(record);
    const unsubscribe = logStore.subscribe(runId, send);
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 15000);
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.get('/api/v1/mail/smsbower/config', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return smsbowerMail.read();
  });
  app.put('/api/v1/mail/smsbower/config', async (request, reply) => {
    if (runManager.activeRunIds?.().length || runManager.starting || rebindService.state?.running || rebindService.starting) {
      throw new HttpError(409, '任务运行中，请在任务结束后修改邮箱接口配置');
    }
    reply.header('Cache-Control', 'no-store');
    return smsbowerMail.save(request.body);
  });
  app.post('/api/v1/mail/smsbower/test', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return smsbowerMail.test(request.body);
  });
  app.get('/api/v1/proxies', async () => proxyService.list());
  app.post('/api/v1/proxies/preview', async (request) => proxyService.preview(request.body || {}));
  app.post('/api/v1/proxies/import', async (request) => proxyService.import(request.body || {}));
  app.post('/api/v1/proxies/api/build-pull', async (request) => proxyService.buildAndPullApi(request.body || {}));
  app.post('/api/v1/proxies/711/build-pull', async (request) => proxyService.buildAndPull711(request.body || {}));
  app.post('/api/v1/proxies/sources/pull-all', async (request) => proxyService.pullAll(request.body || {}));
  app.post('/api/v1/proxies/sources/:sourceId/pull', async (request) => proxyService.pull(
    String(request.params.sourceId || ''),
    request.body || {},
  ));
  app.post('/api/v1/proxies/check', async (request) => proxyService.check(request.body || {}));
  app.delete('/api/v1/proxies/dynamic', async (request) => proxyService.removeDynamic(request.body || {}));
  app.delete('/api/v1/proxies', async (request) => proxyService.clear({ scope: request.query?.scope || 'local' }));

  app.setErrorHandler((error, request, reply) => {
    const statusCode = Number(error.statusCode || 500);
    const expose = error?.public === true;
    // The console runs with `logger: false`, so without this an unexpected 500
    // left no trace anywhere — not in stderr, not in a file — and the operator
    // saw only "the local API could not complete the request". The response
    // stays deliberately vague; the server side does not have to be.
    if (statusCode >= 500) {
      const target = `${request?.method || '?'} ${request?.url || '?'}`;
      process.stderr.write(`[gpt-re] ${new Date().toISOString()} ${statusCode} ${target}: ${error?.code || 'ERROR'} ${error?.message || ''}\n${error?.stack || ''}\n`);
    }
    const publicMessage = expose
      ? scrubString(error?.publicMessage || error?.message || 'Upstream request failed')
      : '';
    const publicDetails = expose
      ? sanitizeValue(error.publicDetails || {
        ...(error?.code ? { code: error.code } : {}),
        ...(error?.mailProvider ? { provider: error.mailProvider } : {}),
        ...(error?.action ? { action: error.action } : {}),
        ...(Number.isFinite(Number(error?.status)) ? { upstreamStatus: Number(error.status) } : {}),
        ...(typeof error?.retryable === 'boolean' ? { retryable: error.retryable } : {}),
      })
      : undefined;
    reply.code(statusCode).send({
      error: expose ? (error?.code || 'UPSTREAM_ERROR') : (statusCode >= 500 ? 'Internal Server Error' : error.message),
      message: expose ? publicMessage : (statusCode >= 500 ? 'The local API could not complete the request' : error.message),
      details: expose ? publicDetails : (statusCode >= 500 ? undefined : error.details),
    });
  });

  const webRoot = path.resolve(cwd, 'web/dist');
  if (fs.existsSync(path.join(webRoot, 'index.html'))) {
    const assetRoot = path.join(webRoot, 'assets');
    const mimeTypes = { '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.map': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
    app.get('/assets/*', async (request, reply) => {
      const relative = String(request.params['*'] || '');
      if (!/^[a-zA-Z0-9._/-]+$/.test(relative) || relative.includes('..')) return reply.code(404).send({ error: 'Not Found' });
      const filePath = path.resolve(assetRoot, relative);
      if (!filePath.startsWith(`${assetRoot}${path.sep}`) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return reply.code(404).send({ error: 'Not Found' });
      }
      reply.type(mimeTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
      reply.header('Cache-Control', /\.[a-zA-Z0-9_-]{8,}\./.test(path.basename(filePath)) ? 'public, max-age=31536000, immutable' : 'no-cache');
      return reply.send(fs.createReadStream(filePath));
    });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not Found' });
      // The shell names content-hashed bundles, so it is the one file that must
      // never be cached: without this the browser serves a heuristically cached
      // copy and keeps loading the previous build after a rebuild.
      reply.header('Cache-Control', 'no-store, must-revalidate');
      return reply.type('text/html; charset=utf-8').send(fs.readFileSync(path.join(webRoot, 'index.html')));
    });
  }

  app.get('/api/v1/rebind/providers', async () => rebindService.providers());
  app.post('/api/v1/rebind/preflight', async (request) => rebindService.preflight(request.body || {}));
  app.get('/api/v1/rebind/status', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return rebindService.status();
  });
  app.post('/api/v1/rebind/start', async (request, reply) => {
    const result = await rebindService.start(request.body || {});
    reply.code(202);
    return result;
  });
  app.post('/api/v1/rebind/stop', async () => rebindService.stop());
  app.get('/api/v1/rebind/queue', async () => rebindService.getQueue());
  app.post('/api/v1/rebind/queue/add', async (request) => rebindService.addToQueue(request.body?.assetIds));
  app.post('/api/v1/rebind/queue/remove', async (request) => rebindService.removeFromQueue(request.body?.assetIds));
  app.post('/api/v1/rebind/queue/clear', async () => rebindService.clearQueue());

  return app;
}

module.exports = { buildApp };
