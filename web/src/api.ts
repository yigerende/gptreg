import type { CpaCredentialPreflight, ChainPaymentSettings, LinkOpsProxyPool, ChainDispatchResult, LinkOpsStatus, LinkOpsJobPage, LinkOpsJobDeleteResult, ChainCountryRule, ChainExtractPlan, ChainTokenHealth, ChainImportResult, ChainRecord, ChainSnapshot, ConfigSnapshot, CpaArtifact, LogRecord, MailboxOption, MailcomAliasDomains, MailcomImportProgress, MailcomStatus, MailRentalConfigureBody, PreflightSnapshot, ProxyAssignment, ProxyCatalogSnapshot, RobotRecord, RobotSnapshot, RunListSnapshot, RunPlan, RunSummary, ServiceStatus, SessionAsset, SessionAssetPage, SessionAssetProbeBatch, SessionAssetQuery, SessionAssetResolveResult, SessionAssetTrialBatch, SettableSessionAssetLifecycle, SmsMarketSnapshot, Sub2ApiDeleteResult, Sub2ApiDocument, Sub2ApiFailedAccounts, Sub2ApiPushResult, NvtokensPushResult, TaskCapacitySnapshot, CpaArtifactSelectionItem, CpaExportSelection, RebindProviders, RebindPreflight, RebindStatus, RebindStartBody, RebindStartResult, RebindQueue, RebindQueueAddResult } from './types';


import type { SmsbowerMailInput, SmsbowerMailSettings, SmsbowerMailTest } from './SmsbowerMailConfig';

class ApiError extends Error {
  status: number;
  details: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    headers: {
      'X-Requested-With': 'gptreg',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(response.status, payload.message || payload.error || `HTTP ${response.status}`, payload.details);
  return payload as T;
}

/**
 * Fetches a binary attachment instead of JSON.
 *
 * The archive endpoints answer with a ZIP, so `api()` — which parses every
 * response as JSON — cannot be used. The server's own `Content-Disposition`
 * name is preferred over the caller's so the two can never drift.
 */
async function apiDownload(path: string, init: RequestInit = {}): Promise<{ blob: Blob; fileName: string }> {
  const response = await fetch(`/api/v1${path}`, {
    ...init,
    headers: {
      'X-Requested-With': 'gptreg',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({} as any));
    throw new ApiError(response.status, payload.message || payload.error || `HTTP ${response.status}`, payload.details);
  }
  const disposition = response.headers.get('content-disposition') || '';
  // The RFC 5987 form first: export names carry Chinese, which the plain
  // `filename=` can only hold as an ASCII fallback.
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  let fileName = '';
  if (encoded) {
    try { fileName = decodeURIComponent(encoded.trim()); } catch { fileName = ''; }
  }
  if (!fileName) fileName = /filename="?([^";]+)"?/i.exec(disposition)?.[1] || 'download.zip';
  return { blob: await response.blob(), fileName };
}

/** Serializes the three filter axes; repeated `facet` params compose with AND. */
function sessionAssetSearch(query: SessionAssetQuery = {}) {
  const params = new URLSearchParams();
  if (query.lifecycle) params.set('lifecycle', query.lifecycle);
  if (query.queue) params.set('queue', query.queue);
  for (const facet of query.facets || []) params.append('facet', facet);
  if (query.sourceRun) params.set('sourceRun', query.sourceRun);
  if (query.q) params.set('q', query.q);
  if (query.cursor) params.set('cursor', query.cursor);
  if (query.limit) params.set('limit', String(query.limit));
  if (query.sort) params.set('sort', query.sort);
  const search = params.toString();
  return search ? `?${search}` : '';
}

export const endpoints = {
  platformConfig: () => api<{ fields: import('./PlatformConfigPage').ExecutionSetting[] }>('/platform-config'),
  savePlatformConfig: (values: Record<string, number | number[]>) => api<{ fields: import('./PlatformConfigPage').ExecutionSetting[] }>('/platform-config', { method: 'PUT', body: JSON.stringify({ values }) }),
  smsSettings: (provider: string) => api<any>(`/sms/settings/${encodeURIComponent(provider)}`),
  testSmsSettings: (provider: string, body: unknown) => api<any>(`/sms/settings/${encodeURIComponent(provider)}/test`, { method: 'POST', body: JSON.stringify(body) }),
  saveSmsSettings: (provider: string, body: unknown) => api<ConfigSnapshot>(`/sms/settings/${encodeURIComponent(provider)}`, { method: 'PUT', body: JSON.stringify(body) }),
  health: () => api<{ ok: boolean; activeRunId: string; activeRunIds?: string[]; taskCapacity?: TaskCapacitySnapshot | null; now: string }>('/health'),
  resourceSummary: (mailProvider: string, smsProvider: string) => api<any>(`/resources/summary?${new URLSearchParams({ mailProvider, smsProvider })}`),
  services: (smsProvider?: 'smsbower' | 'firefox' | 'hero-sms') => api<{ services: ServiceStatus[]; sms: ServiceStatus }>(`/services${smsProvider ? `?smsProvider=${encodeURIComponent(smsProvider)}` : ''}`),
  config: () => api<ConfigSnapshot>('/config'),
  smsFirefoxCountries: () => api<{ countries: Array<{ code: string; name?: string; englishName?: string; dialingCode?: string; price?: number }> }>('/sms/firefox/countries'),
  smsMarket: (provider: 'smsbower' | 'firefox' | 'hero-sms') => api<SmsMarketSnapshot>(`/sms/market?provider=${encodeURIComponent(provider)}`),
  saveConfig: (body: unknown) => api<ConfigSnapshot>('/config', { method: 'PUT', body: JSON.stringify(body) }),
  mailcomStatus: (provider?: string) => api<MailcomStatus>(`/mailcom/status${provider ? `?provider=${encodeURIComponent(provider)}` : ''}`),
  // Accepted-and-running, not finished: poll `mailcomImportProgress` for the rest.
  importMailcomMasters: (content: string, provider?: string) => api<MailcomImportProgress>('/mailcom/import', { method: 'POST', body: JSON.stringify({ content, ...(provider ? { provider } : {}) }) }),
  mailcomImportProgress: () => api<MailcomImportProgress>('/mailcom/import'),
  mailcomDomains: (provider?: string) => api<MailcomAliasDomains>(`/mailcom/domains${provider ? `?provider=${encodeURIComponent(provider)}` : ''}`),
  icloudStatus: () => api<MailcomStatus>('/icloud/status'),
  importIcloudMailboxes: (content: string) => api<MailcomImportProgress>('/icloud/import', { method: 'POST', body: JSON.stringify({ content }) }),
  icloudImportProgress: () => api<MailcomImportProgress>('/icloud/import'),
  validateConfig: (config: unknown) => api<any>('/config/validate', { method: 'POST', body: JSON.stringify({ config }) }),
  preflight: (plan?: RunPlan) => api<PreflightSnapshot>('/preflight', { method: 'POST', body: JSON.stringify(plan ? { plan } : {}) }),
  // The console polls this endpoint continuously. History details are fetched
  // only after opening a run, so keep the polling payload to its live summary.
  runs: () => api<RunListSnapshot>('/runs?compact=1'),
  run: (id: string, reveal = false) => api<RunSummary>(`/runs/${encodeURIComponent(id)}${reveal ? '?reveal=1' : ''}`),
  reconcileBalance: (id: string) => api<RunSummary>(`/runs/${encodeURIComponent(id)}/balance-reconciliation`, { method: 'POST' }),
  startRun: (plan: RunPlan) => api<RunSummary>('/runs', { method: 'POST', body: JSON.stringify({ plan }) }),
  pauseRun: (id: string) => api<RunSummary>(`/runs/${encodeURIComponent(id)}/pause`, { method: 'POST' }),
  resumeRun: (id: string, body: unknown = {}) => api<RunSummary>(`/runs/${encodeURIComponent(id)}/resume`, { method: 'POST', body: JSON.stringify(body) }),
  cancelRun: (id: string, reason = '由控制台取消') => api<RunSummary>(`/runs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) }),
  stopMailRental: (id: string) => api<RunSummary>(`/runs/${encodeURIComponent(id)}/mail-rental/stop`, { method: 'POST' }),
  configureMailRental: (id: string, body: MailRentalConfigureBody) => api<RunSummary>(`/runs/${encodeURIComponent(id)}/mail-rental/configure`, { method: 'POST', body: JSON.stringify(body) }),
  skipJob: (runId: string, jobId: string, reason = '由控制台跳过') => api<RunSummary>(`/runs/${encodeURIComponent(runId)}/jobs/${encodeURIComponent(jobId)}/skip`, { method: 'POST', body: JSON.stringify({ reason }) }),
  retryJob: (runId: string, jobId: string, body: { resolveSmsAcquisition?: 'retry'; resolveEffect?: string } = {}) => api<RunSummary>(`/runs/${encodeURIComponent(runId)}/jobs/${encodeURIComponent(jobId)}/retry`, { method: 'POST', body: JSON.stringify(body) }),
  retryJobs: (runId: string, jobIds: string[], body: { resolveSmsAcquisition?: 'retry'; resolveEffect?: string } = {}) => api<RunSummary>(`/runs/${encodeURIComponent(runId)}/jobs/retry`, { method: 'POST', body: JSON.stringify({ ...body, jobIds }) }),
  deleteRun: (id: string, artifacts = false) => api<any>(`/runs/${encodeURIComponent(id)}?artifacts=${artifacts ? '1' : '0'}`, { method: 'DELETE' }),
  deleteRuns: (runIds: string[], artifacts = false) => api<{ requested: number; removed: Array<{ runId: string }> }>('/runs', { method: 'DELETE', body: JSON.stringify({ runIds, artifacts }) }),
  // Revealed, like the run detail and the log stream: the alias address is the
  // only thing that says which account a CPA file belongs to, and this console
  // is loopback-only.
  cpaArtifacts: (options: { includeLocked?: boolean } = {}) => api<{ artifacts: CpaArtifact[] }>(`/artifacts/cpa?reveal=1${options.includeLocked === false ? '&locked=0' : ''}`),
  lockCpaBatch: (items: CpaArtifactSelectionItem[], batchKey?: string) => api<{ requested: number; locked: CpaArtifactSelectionItem[]; alreadyLocked: CpaArtifactSelectionItem[]; batchKey: string }>('/artifacts/cpa/lock', { method: 'POST', body: JSON.stringify({ items, ...(batchKey ? { batchKey } : {}) }) }),
  unlockCpaBatch: (items: CpaArtifactSelectionItem[]) => api<{ requested: number; unlocked: CpaArtifactSelectionItem[]; alreadyUnlocked: CpaArtifactSelectionItem[]; restored?: string[] }>('/artifacts/cpa/unlock', { method: 'POST', body: JSON.stringify({ items }) }),
  exportCpa: (selection: CpaExportSelection) => api<unknown[]>('/artifacts/cpa/export', { method: 'POST', body: JSON.stringify(selection) }),
  exportCpaCredentials: (selection: CpaExportSelection) => apiDownload('/artifacts/cpa/credentials', { method: 'POST', body: JSON.stringify(selection) }),
  // Writes nothing: the console asks this of every batch before it sends any of
  // them, so one account with an incomplete login state still means the whole
  // selection stays here.
  preflightCpaCredentials: (selection: CpaExportSelection) => api<CpaCredentialPreflight>('/artifacts/cpa/credentials/preflight', { method: 'POST', body: JSON.stringify(selection) }),
  exportSub2Api: (selection: CpaExportSelection) => api<Sub2ApiDocument>('/artifacts/cpa/sub2api', { method: 'POST', body: JSON.stringify(selection) }),
  exportCpaArchive: (selection: CpaExportSelection) => apiDownload('/artifacts/cpa/export/archive', { method: 'POST', body: JSON.stringify(selection) }),
  exportSub2ApiArchive: (selection: CpaExportSelection) => apiDownload('/artifacts/cpa/sub2api/archive', { method: 'POST', body: JSON.stringify(selection) }),
  // Not a download: this hands the CPAs to the local sub2api gateway and comes
  // back with its import tally. A partial import is a success with a `failed`
  // count, so the caller has to read the result, not just the HTTP status.
  pushSub2Api: (selection: CpaExportSelection) => api<Sub2ApiPushResult>('/artifacts/cpa/sub2api/push', { method: 'POST', body: JSON.stringify(selection) }),
  // Reading and pruning what the gateway already holds, as opposed to the
  // `/artifacts/cpa/sub2api/*` calls, which are about what leaves this side.
  sub2ApiFailedAccounts: () => api<Sub2ApiFailedAccounts>('/sub2api/accounts/failed'),
  pushNvtokensCards: (selection: CpaExportSelection) => api<NvtokensPushResult>('/artifacts/cpa/nvtokens/cards/import', { method: 'POST', body: JSON.stringify(selection) }),
  pushNvtokensMailboxes: (selection: CpaExportSelection) => api<NvtokensPushResult>('/artifacts/cpa/nvtokens/mailboxes/import', { method: 'POST', body: JSON.stringify(selection) }),
  pushNvtokensPool: (selection: CpaExportSelection & { priceYuan: number }) => api<NvtokensPushResult>('/artifacts/cpa/nvtokens/pool', { method: 'POST', body: JSON.stringify(selection) }),
  removeSub2ApiAccounts: (accountIds: number[]) => api<Sub2ApiDeleteResult>('/sub2api/accounts', { method: 'DELETE', body: JSON.stringify({ accountIds }) }),
  removeCpaArtifacts: (items: CpaArtifactSelectionItem[]) => api<{ requested: number; removed: CpaArtifactSelectionItem[]; missing: CpaArtifactSelectionItem[] }>('/artifacts/cpa', { method: 'DELETE', body: JSON.stringify({ items }) }),
  sessionAssets: (query: SessionAssetQuery = {}) => api<SessionAssetPage>(`/session-assets${sessionAssetSearch(query)}`),
  // Every id the current filter matches, so "select all" covers the matches
  // rather than whichever page happens to be loaded.
  sessionAssetIds: (query: SessionAssetQuery = {}) => api<{ ids: string[]; total: number }>(`/session-assets/ids${sessionAssetSearch(query)}`),
  resolveSessionAssetEmails: (emails: string[]) => api<SessionAssetResolveResult>('/session-assets/resolve', { method: 'POST', body: JSON.stringify({ emails }) }),
  sessionAsset: (id: string) => api<SessionAsset>(`/session-assets/${encodeURIComponent(id)}`),
  clearSessionAssetOAuthCooldown: (id: string) => api<{ id: string; cleared: boolean; asset: SessionAsset }>(`/session-assets/${encodeURIComponent(id)}/oauth-cooldown/clear`, { method: 'POST', body: '{}' }),
  moveSessionAssetLifecycle: (assetIds: string[], lifecycle: SettableSessionAssetLifecycle = 'sold') => api<{ requested: number; lifecycle: string; classification: string; changed: string[]; missing: string[] }>('/session-assets/lifecycle', { method: 'POST', body: JSON.stringify({ assetIds, lifecycle }) }),
  sessionAssetTotp: (id: string) => api<{ code: string; expiresIn: number }>(`/session-assets/${encodeURIComponent(id)}/totp`),
  probeSessionAssets: (assetIds: string[]) => api<SessionAssetProbeBatch>('/session-assets/probe', { method: 'POST', body: JSON.stringify({ assetIds }) }),
  trialCheckSessionAssets: (assetIds: string[]) => api<SessionAssetTrialBatch>('/session-assets/trial-check', { method: 'POST', body: JSON.stringify({ assetIds }) }),
  refreshSessionAssets: (body: { assetIds: string[]; workerConcurrency: number; proxyAssignments: ProxyAssignment[]; security?: { setPassword: boolean; enrollTotp: boolean } }) => api<RunSummary>('/session-assets/refresh', { method: 'POST', body: JSON.stringify(body) }),
  exportSessionAssets: (body: { assetIds: string[]; kind: 'at' | 'credentials'; format?: 'raw' | 'email-at' }) => api<{ fileName: string; contentType: string; content: string; exported: number; skipped: string[] }>('/session-assets/export', { method: 'POST', body: JSON.stringify(body) }),
  removeSessionAssets: (assetIds: string[], cascadeCpa = false) => api<{ requested: number; removed: string[]; missing: string[]; skipped: string[]; cpaRemoved: boolean }>('/session-assets', { method: 'DELETE', body: JSON.stringify({ assetIds, cascadeCpa }) }),
  linkopsStatus: () => api<LinkOpsStatus>('/linkops/status'),
  startLinkops: () => api<{ ok: boolean; output: string; status: LinkOpsStatus }>('/linkops/start', { method: 'POST', body: '{}' }),
  linkopsJobs: (query: { domain?: string; provider?: string; status?: string; limit?: number } = {}) => {
    const params = new URLSearchParams();
    if (query.domain) params.set('domain', query.domain);
    if (query.provider) params.set('provider', query.provider);
    if (query.status) params.set('status', query.status);
    if (query.limit) params.set('limit', String(query.limit));
    const search = params.toString();
    return api<LinkOpsJobPage>(`/linkops/jobs${search ? `?${search}` : ''}`);
  },
  createLinkopsJob: (body: { domain: string; provider: string; input: Record<string, unknown>; options?: Record<string, unknown> }) => api<{ ok: boolean; jobs?: Array<{ id: string }> }>('/linkops/jobs', { method: 'POST', body: JSON.stringify(body) }),
  cancelLinkopsJob: (id: string) => api<{ ok: boolean }>(`/linkops/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' }),
  retryLinkopsJob: (id: string) => api<{ ok: boolean }>(`/linkops/jobs/${encodeURIComponent(id)}/retry`, { method: 'POST', body: '{}' }),
  chainPaymentSettings: () => api<ChainPaymentSettings>('/chains/payment-settings'),
  saveChainPaymentSettings: (body: ChainPaymentSettings) => api<ChainPaymentSettings>('/chains/payment-settings', { method: 'PUT', body: JSON.stringify(body) }),
  payExtractedChains: (ids: string[]) => api<ChainDispatchResult>('/chains/pay', { method: 'POST', body: JSON.stringify({ ids }) }),
  saveChainPaymentPhone: (id: string, phone: string) => api<ChainRecord>(`/chains/${encodeURIComponent(id)}/payment-phone`, { method: 'PUT', body: JSON.stringify({ phone }) }),
  submitLinkopsInput: (id: string, value: string) => api<{ ok: boolean }>(`/linkops/jobs/${encodeURIComponent(id)}/input`, { method: 'POST', body: JSON.stringify({ value }) }),
  deleteLinkopsJob: (id: string) => api<{ ok: boolean; deleted?: string }>(`/linkops/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  batchDeleteLinkopsJobs: (jobIds: string[]) => api<LinkOpsJobDeleteResult>('/linkops/jobs/batch-delete', { method: 'POST', body: JSON.stringify({ jobIds }) }),
  linkopsProxyPool: (provider: string, country: string, role = 'checkout') => api<LinkOpsProxyPool>(`/linkops/proxy-pools/${encodeURIComponent(provider)}/${encodeURIComponent(country)}?role=${encodeURIComponent(role)}`),
  refreshLinkopsProxyPool: (provider: string, country: string, role = 'checkout') => api<LinkOpsProxyPool>(`/linkops/proxy-pools/${encodeURIComponent(provider)}/${encodeURIComponent(country)}/refresh?role=${encodeURIComponent(role)}`, { method: 'POST', body: '{}' }),
  preflightLinkopsProxyPool: (provider: string, country: string, role = 'checkout') => api<{ ok: boolean; result?: Record<string, unknown> }>(`/linkops/proxy-pools/${encodeURIComponent(provider)}/${encodeURIComponent(country)}/preflight?role=${encodeURIComponent(role)}`, { method: 'POST', body: JSON.stringify({ index: -1 }) }),
  clearLinkopsProxyPool: (provider: string, country: string, role = 'checkout') => api<{ ok: boolean }>(`/linkops/proxy-pools/${encodeURIComponent(provider)}/${encodeURIComponent(country)}?role=${encodeURIComponent(role)}`, { method: 'DELETE' }),
  chains: () => api<ChainSnapshot>('/chains'),
  importChainTokens: (body: { content: string; provider?: string; routeKey?: string }) => api<ChainImportResult>('/chains/import', { method: 'POST', body: JSON.stringify(body) }),
  chain: (id: string) => api<ChainRecord>(`/chains/${encodeURIComponent(id)}`),
  chainToken: (id: string) => api<{ id: string; email: string; token: string }>(`/chains/${encodeURIComponent(id)}/token`),
  extractChains: (plan: ChainExtractPlan) => api<ChainDispatchResult>('/chains/extract', { method: 'POST', body: JSON.stringify(plan) }),
  probeChainTokens: (ids: string[]) => api<{ checked: number; alive: number; dead: number; results: Array<ChainTokenHealth & { id: string; email: string }> }>('/chains/probe', { method: 'POST', body: JSON.stringify({ ids }) }),
  markChainPayment: (ids: string[], status: 'pending' | 'success' | 'failed') => api<{ requested: number; status: string; changed: string[]; missing: string[] }>('/chains/payment-status', { method: 'POST', body: JSON.stringify({ ids, status }) }),
  saveChainRules: (rules: Record<string, ChainCountryRule>) => api<{ countryRules: Record<string, ChainCountryRule> }>('/chains/rules', { method: 'PUT', body: JSON.stringify({ rules }) }),
  robots: () => api<RobotSnapshot>('/robots'),
  updateRobot: (id: string, patch: { intervalMs?: number; enabled?: boolean; config?: Record<string, unknown> }) => api<RobotRecord>(`/robots/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  startRobot: (id: string) => api<RobotRecord>(`/robots/${encodeURIComponent(id)}/start`, { method: 'POST' }),
  stopRobot: (id: string) => api<RobotRecord>(`/robots/${encodeURIComponent(id)}/stop`, { method: 'POST' }),
  robotCommand: (id: string, command: string, payload: Record<string, unknown> = {}) => api<{ robotId: string; command: string; queued?: boolean; robot?: RobotRecord }>(`/robots/${encodeURIComponent(id)}/commands`, { method: 'POST', body: JSON.stringify({ command, payload }) }),
  clearRobotRuns: () => api<{ removed: number; robots: RobotRecord[] }>('/robots/runs', { method: 'DELETE' }),
  removeChains: (ids: string[]) => api<{ requested: number; removed: string[]; missing: string[]; accountsRemoved: string[]; accountsMissing: string[]; accountsRetained: string[] }>('/chains', { method: 'DELETE', body: JSON.stringify({ ids }) }),
  mailboxes: () => api<{ mailboxes: MailboxOption[] }>('/mailboxes'),
  clearLogs: (id: string) => api<{ runId: string; removed: number }>(`/runs/${encodeURIComponent(id)}/logs`, { method: 'DELETE' }),
  logs: (id: string, reveal = false, limit = 10000) => api<{ logs: LogRecord[] }>(`/runs/${encodeURIComponent(id)}/logs?limit=${limit}&reveal=${reveal ? '1' : '0'}`),
  smsbowerMailConfig: () => api<SmsbowerMailSettings>('/mail/smsbower/config'),
  saveSmsbowerMailConfig: (body: SmsbowerMailInput) => api<SmsbowerMailSettings>('/mail/smsbower/config', { method: 'PUT', body: JSON.stringify(body) }),
  testSmsbowerMailConfig: (body: SmsbowerMailInput) => api<SmsbowerMailTest>('/mail/smsbower/test', { method: 'POST', body: JSON.stringify(body) }),
  proxies: () => api<ProxyCatalogSnapshot>('/proxies'),
  previewProxies: (body: unknown) => api<any>('/proxies/preview', { method: 'POST', body: JSON.stringify(body) }),
  importProxies: (body: unknown) => api<any>('/proxies/import', { method: 'POST', body: JSON.stringify(body) }),
  buildAndPullProxyApi: (body: { provider: string; countryCode: string; count: number; protocol: string }) => api<ProxyCatalogSnapshot>('/proxies/api/build-pull', { method: 'POST', body: JSON.stringify(body) }),
  buildAndPull711: (body: { countryCode: string; count: number; protocol: string }) => api<ProxyCatalogSnapshot>('/proxies/711/build-pull', { method: 'POST', body: JSON.stringify(body) }),
  checkProxies: (ids?: string[]) => api<any>('/proxies/check', { method: 'POST', body: JSON.stringify({ ids }) }),
  pullProxySource: (sourceId: string) => api<ProxyCatalogSnapshot>(`/proxies/sources/${encodeURIComponent(sourceId)}/pull`, { method: 'POST', body: '{}' }),
  removeDynamicProxy: (selection: { countryCode: string; sourceId?: string; entryId?: string }) => api<ProxyCatalogSnapshot>('/proxies/dynamic', { method: 'DELETE', body: JSON.stringify(selection) }),
  clearProxies: (scope: 'local' | 'dynamic' = 'local') => api<ProxyCatalogSnapshot>(`/proxies?scope=${scope}`, { method: 'DELETE' }),
  rebindProviders: () => api<RebindProviders>('/rebind/providers'),
  rebindPreflight: (body: { provider: string; workerConcurrency: number; count: number; proxyAssignments: ProxyAssignment[]; probe?: boolean }) => api<RebindPreflight>('/rebind/preflight', { method: 'POST', body: JSON.stringify(body) }),
  rebindStatus: () => api<RebindStatus>('/rebind/status'),
  startRebind: (body: RebindStartBody) => api<RebindStartResult>('/rebind/start', { method: 'POST', body: JSON.stringify(body) }),
  stopRebind: () => api<{ ok: boolean; running: boolean; stopRequested?: boolean }>('/rebind/stop', { method: 'POST', body: '{}' }),
  rebindQueue: () => api<RebindQueue>('/rebind/queue'),
  rebindQueueAdd: (assetIds: string[]) => api<RebindQueueAddResult>('/rebind/queue/add', { method: 'POST', body: JSON.stringify({ assetIds }) }),
  rebindQueueRemove: (assetIds: string[]) => api<RebindQueue>('/rebind/queue/remove', { method: 'POST', body: JSON.stringify({ assetIds }) }),
  rebindQueueClear: () => api<RebindQueue>('/rebind/queue/clear', { method: 'POST', body: '{}' }),
};
