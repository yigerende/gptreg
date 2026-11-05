'use strict';
const runtimeSecrets = require('../platform/runtime-secrets');

const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const {
  REMOTE_MAIL_PROVIDERS,
  REMOTE_MAILBOX_PROVIDERS,
  secretFromEnv,
  validateV2Config,
} = require('../config-v2');
const { isCpaArtifactFileName, isSafeCpaArtifactKey } = require('../cpa-filename');
const { loadHar } = require('../har');

// Passed where a runner still expects the shape of a recording but must not
// read one. Frozen so a runner cannot quietly accumulate entries into it.
const EMPTY_PROTOCOL_CAPTURE = Object.freeze({ log: Object.freeze({ entries: Object.freeze([]) }) });
const {
  BRANCH_TASK_KINDS,
  applyMailcomAliasDomains,
  canMigrateLegacyRegisterOAuthState,
  canResumeBranchState,
  cancelBranchState,
  makeInitialBranchState,
  migrateLegacyRegisterOAuthState,
  preflightMailcomAliasDomains,
  prepareBranchPreflight,
  resumableBranchAssetIds,
  resumeBranchState,
  runBranchOrchestrator,
  skipBranchJob,
  summarizeBranchState,
} = require('../branch-orchestrator');
const {
  cancelOrchestratorV2,
  resumeOrchestratorV2State,
  runOrchestratorV2,
  runStatePathV2,
  skipAliasV2,
  summarizeOrchestratorV2State,
} = require('../orchestrator-v2');
const { acquireStateLock, configFingerprint, loadV2State, saveV2StateWithRetry } = require('../state-store');
const { stableId } = require('../proxy-catalog');
const { exportFileName } = require('../export-file-name');
const {
  MAX_RENTAL_WATCH_TARGET,
  MIN_RENTAL_WATCH_POLL_INTERVAL_MS,
  applyRunPlan,
  normalizeRunPlan,
  requiresSmsPreflight,
} = require('../run-plan');
const { createSmsProvider } = require('../sms-provider');
const {
  balanceAccountFingerprint,
  currencyName,
  finalizeBalanceReconciliation,
  finiteNumber,
  providerName,
  recordBalanceStart,
} = require('../balance-reconciliation');
const { cancellationDetailsForBalance, summarizeSmsCosts } = require('../sms-cost-ledger');
const {
  SessionAssetStore,
  sessionAssetMailProviderEvidence,
} = require('../session-asset-store');
const { buildSub2ApiDocument } = require('../sub2api');
const { Sub2ApiClient, Sub2ApiError } = require('../sub2api-client');
const {
  NvtokensClient,
  NvtokensError,
  summarizeNvtokensResponse,
} = require('../nvtokens-client');
const { XiaopingguoClient } = require('../xiaopingguo-client');
const { MailcomClient } = require('../mailcom-client');
const { IcloudClient } = require('../icloud-client');
const { providerAliasSettings } = require('../mail-provider-settings');
const { createZipArchive, uniqueEntryName } = require('../zip-archive');
const { isTerminalJobStatus } = require('../job-lifecycle');
const { ProxyService } = require('./proxy-service');
const { atomicWriteText, HttpError, maskEmail, resolveInside, safeRunId, scrubString } = require('./utils');
const { assetLifecycle, oauthCooldownActive } = require('../session-asset-grouping');
const { clone } = require('../util/shared');

const TERMINAL_RUN_STATUSES = new Set(['complete', 'partial', 'cancelled', 'failed']);
const AUXILIARY_TASK_KINDS = new Set(['oauth', 'session_refresh']);
const DEFAULT_AUXILIARY_TASK_CAPACITY = 3;
// Folder names inside the batch archives, and the archive file names too.
const NVTOKENS_PUSH_REGISTRY_SCHEMA_VERSION = 1;
const CPA_LOCK_REGISTRY_SCHEMA_VERSION = 1;
const MAX_RETAINED_HISTORY = 60;
// The CPA artifact cap is its own number, not the history cap reused. They
// bound different things: how many finished tasks stay browsable, and how many
// credential files stay on disk. A CPA file is small and is the actual product,
// so it is worth keeping around for longer than the run that produced it.
const MAX_RETAINED_CPA_ARTIFACTS = 2000;
const CPA_ARTIFACT_LIST_CACHE_KEY = 'cpa-artifact-list';
const CPA_ARTIFACT_SCAN_CACHE_KEY = 'cpa-artifact-scan';
/**
 * How long a watch-backed listing may be trusted without re-reading the files.
 *
 * `fs.watch` is a hint. On network shares, container mounts and a few
 * filesystems it reports no error and then delivers no events, and a cache
 * keyed only on the watch counter would serve the same stale listing forever.
 * Past this age the listing falls back to the exact file signature, which
 * stats every retained CPA file. One minute, matching the session-asset
 * index's own `indexMaxAgeMs`: the watch is the mechanism, this is only the
 * floor under it, and paying for a full scan more often than that would tax
 * every working setup for the sake of the broken one.
 */
const CPA_ARTIFACT_LIST_MAX_AGE_MS = 60_000;
// How stale an unreferenced output directory or scratch file must be before it
// is reclaimed. Generous on purpose: these sweeps run while tasks may be
// starting, and the cost of keeping junk one more hour is nil.
const ORPHAN_OUTPUT_GRACE_MS = 6 * 60 * 60_000;
const RESOURCE_CLEANUP_PHASES = new Set([
  'waiting_resource_cleanup',
  'waiting_sms_cleanup',
  'waiting_mailbox_cleanup',
]);
const RESOURCE_CLEANUP_RETRY_FALLBACK_MS = 30_000;
const RESOURCE_CLEANUP_BUSY_RETRY_MS = 5_000;
// These fields are the live controls exposed by the hang-rental dialog. They
// change the broker's future work, but are not a change to the task's mailbox,
// proxy, or protocol contract.
const MAIL_RENTAL_MUTABLE_PLAN_KEYS = new Set([
  'mailCount',
  'mailRentalTarget',
  'mailRentalBatchSize',
  'mailRentalPollIntervalMs',
  'totalAccounts',
]);

/**
 * Largest selection one CPA export, credentials export or sub2api export may
 * carry. Sized for a 1000-account sale in one file: each entry is a ~200-byte
 * reference, far inside the 2 MB request body limit, and the work per entry is
 * one file read. Removals keep their own, smaller caps.
 */
const CPA_EXPORT_MAX_ENTRIES = 1000;

function planWithoutMailRentalControls(plan) {
  if (!plan || typeof plan !== 'object') return null;
  const comparable = { ...plan };
  for (const key of MAIL_RENTAL_MUTABLE_PLAN_KEYS) delete comparable[key];
  return comparable;
}

function mailRentalBaselinePlan(state) {
  const current = state?.runPlan || state?.plan;
  const preflight = state?.preflight?.plan;
  if (!current || typeof current !== 'object' || !preflight || typeof preflight !== 'object') return null;

  // `preflight.plan` was accidentally shared with `runPlan` in older states.
  // The immutable rental snapshot is still present in the preflight result, so
  // rebuild just the four live fields when that alias has already been mutated.
  const rental = state.preflight?.mail?.rentalWatch;
  if (!rental || typeof rental !== 'object') return preflight;
  const target = Number(rental.target);
  const batchSize = Number(rental.batchSize);
  const pollIntervalMs = Number(rental.pollIntervalMs);
  if (!Number.isSafeInteger(target) || !Number.isSafeInteger(batchSize) || !Number.isSafeInteger(pollIntervalMs)) {
    return preflight;
  }
  return {
    ...preflight,
    mailCount: target,
    mailRentalTarget: target,
    mailRentalBatchSize: batchSize,
    mailRentalPollIntervalMs: pollIntervalMs,
    totalAccounts: target * Math.max(1, Number(current.aliasCount || preflight.aliasCount || 1)),
  };
}

function timeValue(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function stateHistoryTime(state = {}) {
  return Math.max(
    timeValue(state.updatedAt),
    timeValue(state.completedAt),
    timeValue(state.cancelledAt),
    timeValue(state.createdAt),
  );
}

function resourceCleanupPendingState(state = {}) {
  return state.cancelPending === true
    || RESOURCE_CLEANUP_PHASES.has(String(state.phase || '').toLowerCase());
}

function resourceCleanupRetryAt(state = {}, now = Date.now()) {
  const candidates = [];
  const add = (value) => {
    const timestamp = timeValue(value);
    if (timestamp > 0) candidates.push(timestamp);
  };

  for (const mailbox of state.mailboxes || []) {
    const cleanup = mailbox?.rentalCleanup;
    if (cleanup?.status === 'pending') add(cleanup.nextAttemptAt);
  }
  for (const job of state.jobs || []) {
    const sms = job?.sms || {};
    for (const cleanup of sms.pendingCleanup || []) {
      if (cleanup?.status === 'pending_cleanup') add(cleanup.cleanupAt);
    }
    if (['pending_cleanup', 'completion_pending'].includes(String(sms.current?.status || ''))) {
      add(sms.current.cleanupAt);
    }
    if (String(state.phase || '').toLowerCase() === 'waiting_sms_cleanup'
      || String(job?.phase || '').toLowerCase() === 'waiting_sms_cleanup'
      || job?.error?.code === 'SMS_CLEANUP_PENDING') {
      add(job.nextRunAt);
      add(job.retry?.nextRunAt);
    }
  }

  return candidates.length
    ? Math.max(now, Math.min(...candidates))
    : now + RESOURCE_CLEANUP_RETRY_FALLBACK_MS;
}

function newestStateFirst(left, right) {
  return stateHistoryTime(right.state) - stateHistoryTime(left.state)
    || String(right.state?.runId || '').localeCompare(String(left.state?.runId || ''));
}

function newestArtifactFirst(left, right) {
  return timeValue(right.modifiedAt) - timeValue(left.modifiedAt)
    || String(right.filePath || '').localeCompare(String(left.filePath || ''));
}

/**
 * One readable line per record a push held back, for the error and the result.
 *
 * The account is what the operator needs first: "1 selected CPA record(s)"
 * sent them hunting through the whole selection for the row to fix.
 */
function nvtokensSkipReasons(skipped = []) {
  return skipped.map((item) => {
    const who = String(item?.email || '').trim() || [item?.runId, item?.jobId].filter(Boolean).join('/') || '未知账号';
    return `${who}：${String(item?.reason || '无法推送')}`;
  });
}

function cpaArtifactDeletable(runId, state, activeRunIds) {
  const id = String(runId || '');
  if (activeRunIds.has(id)) return false;
  if (!state) return true;
  const status = String(state.status || '').toLowerCase();
  if (!TERMINAL_RUN_STATUSES.has(status)) return false;
  return !(BRANCH_TASK_KINDS.has(state.taskKind) && canResumeBranchState(state));
}

function taskKindOf(value = {}) {
  const plan = value?.runPlan || value?.plan || value;
  return String(value?.taskKind || plan?.taskKind || 'register_session').trim() || 'register_session';
}

function taskSlotOf(value = {}) {
  return AUXILIARY_TASK_KINDS.has(taskKindOf(value)) ? 'auxiliary' : 'main';
}

/**
 * The run list needs the plan to describe a task, but credentials-sourced
 * plans also carry passwords and TOTP secrets. Keep the same redaction rule
 * as the full summary while allowing the compact list projection to avoid
 * building the rest of the task detail.
 */
function publicRunPlan(plan) {
  if (!plan || typeof plan !== 'object') return plan;
  const accounts = plan.oauthSource?.accounts;
  if (!Array.isArray(accounts)) return plan;
  return {
    ...plan,
    oauthSource: {
      ...plan.oauthSource,
      accounts: accounts.map((account) => ({
        email: String(account?.email || ''),
        hasPassword: Boolean(account?.password),
        hasTotpSecret: Boolean(account?.totpSecret),
      })),
    },
  };
}

function normalizedProvider(value) {
  return providerName(value);
}

function roundedAmount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(6)) : 0;
}

function jobHasSmsActivity(job = {}) {
  const sms = job.sms || {};
  return Boolean(
    sms.current
    || sms.acquisition
    || (Array.isArray(sms.attempts) && sms.attempts.length)
    || (Array.isArray(sms.acquisitions) && sms.acquisitions.length)
    || (Array.isArray(sms.pendingCleanup) && sms.pendingCleanup.length),
  );
}

function activeBalanceProvider(active = null) {
  return active?.smsProvider || active?.preparedResources?.smsProvider || null;
}

function stateBalanceProvider(state = {}, active = null) {
  const provider = normalizedProvider(
    activeBalanceProvider(active)?.name
      || activeBalanceProvider(active)?.provider
      || active?.config?.sms?.provider
      || state.balanceReconciliation?.provider
      || state.preflight?.sms?.provider,
  );
  return provider;
}

function activeBalanceAccountFingerprint(active) {
  if (!active) return '';
  const provider = activeBalanceProvider(active);
  if (provider) {
    const current = balanceAccountFingerprint(provider);
    if (current) {
      active.balanceAccountFingerprint = current;
      return current;
    }
  }
  if (active.balanceAccountFingerprint) return active.balanceAccountFingerprint;
  if (active.state?.balanceReconciliation?.accountFingerprint) {
    active.balanceAccountFingerprint = String(active.state.balanceReconciliation.accountFingerprint);
    return active.balanceAccountFingerprint;
  }
  return '';
}

function fingerprintsMayShare(left, right) {
  if (!left || !right) return true;
  if (left.endsWith(':unknown') || right.endsWith(':unknown')) return true;
  return left === right;
}

function stateUsesBalanceAccount(state = {}, expectedProvider = '', active = null) {
  const provider = stateBalanceProvider(state, active);
  const expected = normalizedProvider(expectedProvider);
  if (provider && expected && provider !== expected) return false;
  if (state.balanceReconciliation) return true;
  const plan = state.runPlan || state.plan || {};
  if (requiresSmsPreflight(plan) && (!expected || normalizedProvider(state.preflight?.sms?.provider) === expected)) return true;
  return (state.jobs || []).some(jobHasSmsActivity)
    || (state.mailboxes || []).some((mailbox) => mailbox?.rented === true);
}

function hasFinancialAmount(bucket = {}) {
  return ['quoted', 'grossConsumed', 'confirmedConsumed', 'refunded', 'unresolved', 'cancelledUnresolved', 'cancelledQuoted', 'activeQuoted']
    .some((key) => Number(bucket[key] || 0) > 0);
}

function financialAmounts(state = {}, currency = 'USD') {
  const expectedCurrency = currencyName(currency);
  const sms = summarizeSmsCosts(state.jobs || [], { defaultCurrency: expectedCurrency });
  const smsByCurrency = sms.currencyTotals || {};
  const smsCurrent = smsByCurrency[expectedCurrency] || {};
  const smsCurrencies = Object.entries(smsByCurrency)
    .filter(([, bucket]) => hasFinancialAmount(bucket))
    .map(([code]) => code);
  const rentals = (state.mailboxes || []).filter((mailbox) => mailbox?.rented === true);
  const billableRentals = rentals.filter((mailbox) => {
    const closed = String(mailbox.rentalClosed || '').trim().toLowerCase();
    return closed !== 'cancelled' && closed !== 'canceled';
  });
  let mailConfirmed = 0;
  let mailUnresolved = 0;
  let mailBillingComplete = true;
  for (const mailbox of billableRentals) {
    const closed = String(mailbox.rentalClosed || '').trim().toLowerCase();
    if (closed === 'cancelled' || closed === 'canceled') continue;
    if (closed === 'settled') {
      const cost = finiteNumber(mailbox.costUsd);
      if (cost === null) {
        mailBillingComplete = false;
        mailUnresolved += Math.max(0, finiteNumber(mailbox.quotedPriceUsd) || 0);
      } else {
        mailConfirmed += cost;
      }
      continue;
    }
    mailBillingComplete = false;
    mailUnresolved += Math.max(0, finiteNumber(mailbox.quotedPriceUsd) || 0);
  }
  const hasMailAmount = billableRentals.some((mailbox) => (
    (finiteNumber(mailbox.costUsd) || 0) > 0 || (finiteNumber(mailbox.quotedPriceUsd) || 0) > 0
  ));
  const currencies = [...new Set([
    ...smsCurrencies,
    ...(hasMailAmount ? ['USD'] : []),
  ])];
  const currencyMismatch = currencies.some((code) => code !== expectedCurrency);
  const cancellationDetails = cancellationDetailsForBalance(sms, expectedCurrency);
  return {
    confirmed: roundedAmount(Number(smsCurrent.confirmedConsumed || 0) + (expectedCurrency === 'USD' ? mailConfirmed : 0)),
    unresolved: roundedAmount(Number(smsCurrent.unresolved || 0) + (expectedCurrency === 'USD' ? mailUnresolved : 0)),
    cancelledUnresolved: roundedAmount(cancellationDetails.cancelledUnresolved),
    cancellationOnlyUnresolved: cancellationDetails.cancellationOnlyUnresolved && mailUnresolved <= 0 && !currencyMismatch,
    cancelledUnresolvedByJob: cancellationDetails.cancelledUnresolvedByJob,
    billingComplete: sms.billingComplete && mailBillingComplete && !currencyMismatch,
    currencyMismatch,
    currencies,
  };
}

function usesMaintenanceProxy(state = {}) {
  const plan = state.runPlan || state.plan || {};
  const assignments = Array.isArray(plan.proxyAssignments) ? plan.proxyAssignments : [];
  const taskKind = taskKindOf(state);
  const sourceTask = taskKind === 'oauth' || taskKind === 'session_refresh';
  // OAuth/session-maintenance plans without an explicit assignment were
  // historically defaulted to the configured local forwarder.
  if (!assignments.length) return sourceTask;
  return assignments.every((assignment) => String(assignment?.kind || '').toLowerCase() === 'maintenance');
}

function proxyRecoveryWaitDetails(state = {}) {
  const maintenanceProxy = usesMaintenanceProxy(state);
  const values = [
    { kind: 'phase', value: state.phase },
    { kind: 'wait_code', value: state.normalWait?.code },
    { kind: 'wait_message', value: state.normalWait?.message },
    { kind: 'last_error_code', value: state.lastError?.code },
    { kind: 'last_error_message', value: state.lastError?.message },
    ...(state.jobs || []).flatMap((job) => [
      { kind: 'job_phase', value: job.phase },
      { kind: 'job_error_code', value: job.error?.code },
      { kind: 'job_error_message', value: job.error?.message },
      { kind: 'proxy_transport_recovery', value: !maintenanceProxy && job.proxyTransportRecovery?.pending ? 'network_transport_recovery' : '' },
    ]),
  ].filter((entry) => entry.value !== undefined && entry.value !== null && String(entry.value));
  const normalized = values.map((entry) => ({ ...entry, text: String(entry.value).toLowerCase() }));
  const networkTransport = normalized.find((entry) => entry.kind === 'proxy_transport_recovery');
  // A normal challenge or an in-run rotation is owned by the branch worker.
  // Only an explicit exhausted/uncapable pool, or the durable one-shot
  // transport fallback, belongs to the refresh robot. Treating every
  // `waiting_proxy_rotation` checkpoint as a refresh request caused a large
  // healthy catalog to be pulled repeatedly while the branch still had exits
  // it could try itself.
  const proxyPoolBusy = normalized.some((entry) => (
    /proxy_pool_busy|proxy_capacity_wait/.test(entry.text)
      || /(?:all )?proxy candidates? (?:are )?(?:currently )?(?:in use|busy)/.test(entry.text)
      || /proxy pool (?:is )?(?:busy|in use)/.test(entry.text)
  ));
  const explicitProxyPool = normalized.find((entry) => (
    /(?:proxy_pool_exhausted|healthy_proxy_required|no_checked_proxy|country_proxy_pool_(?:empty|capacity)|proxy_bind_failed)/.test(entry.text)
      || /no (?:healthy )?proxy (?:candidate|available)/.test(entry.text)
  ));
  const waitingProxyPool = normalized.find((entry) => entry.text === 'waiting_proxy_pool');
  const proxyPool = !maintenanceProxy && (explicitProxyPool || (!proxyPoolBusy && waitingProxyPool));
  const match = networkTransport || proxyPool;
  if (!match) return null;
  const codeEntry = normalized.find((entry) => entry.kind.endsWith('code'));
  return {
    reason: networkTransport ? 'network_transport' : 'proxy_pool',
    code: String(explicitProxyPool?.value || codeEntry?.value || proxyPool?.value || ''),
    phase: String(state.phase || ''),
    detail: String(match.value),
  };
}

function maintenanceProxyEntry(config, workerConcurrency) {
  const url = String(config?.proxyPool?.maintenanceProxy || '').trim();
  if (!url) {
    const error = new Error('proxyPool.maintenanceProxy is not configured');
    error.code = 'MAINTENANCE_PROXY_NOT_CONFIGURED';
    throw error;
  }
  const count = Math.max(1, Number(workerConcurrency) || 1);
  return {
    id: stableId('maintenance', url),
    url,
    protocol: (url.split('://')[0] || 'http').toLowerCase(),
    workerSlots: Array.from({ length: count }, (_unused, index) => index + 1),
    resourceKind: 'maintenance',
    countryCode: '',
  };
}

/**
 * A provider failure trimmed to something a card can hold.
 *
 * A raw mail.com rejection arrives as a JSON blob with no spaces in it. Handed
 * to the UI whole it is one unbreakable token a few hundred characters long,
 * which is what pushed the import panel past the edge of the page.
 */
function importFailureText(setup) {
  const raw = setup?.error
    || (Array.isArray(setup?.failed) && setup.failed.length
      ? setup.failed.map((item) => [item?.status, item?.reason, item?.error].filter(Boolean).join(' ')).filter(Boolean).join('; ')
        || `${setup.failed.length} 个别名创建失败`
      : '')
    || '别名创建失败';
  const text = scrubString(String(raw).replace(/\s+/g, ' ').trim());
  return text.length > 140 ? `${text.slice(0, 140)}…` : text;
}

function preflightHttpError(error) {
  if (error instanceof HttpError) return error;
  const code = String(error?.code || 'PREFLIGHT_FAILED');
  const detail = scrubString(error?.message || 'Unknown preflight error');
  const providerFailure = error?.public === true && Number(error?.statusCode || 0) >= 500;
  if (providerFailure) {
    const statusCode = Number(error.statusCode);
    const wrapped = new HttpError(statusCode, `预检失败：${detail}`, {
      code,
      ...(error?.mailProvider ? { provider: String(error.mailProvider) } : {}),
      ...(error?.action ? { action: String(error.action) } : {}),
      ...(Number.isFinite(Number(error?.status)) ? { upstreamStatus: Number(error.status) } : {}),
      ...(typeof error?.retryable === 'boolean' ? { retryable: error.retryable } : {}),
    });
    wrapped.code = code;
    wrapped.public = true;
    wrapped.publicDetails = wrapped.details;
    return wrapped;
  }
  const providerBinding = code.startsWith('SESSION_ASSET_MAIL_PROVIDER_')
    ? {
      ...(Array.isArray(error?.providers) ? { providers: error.providers } : {}),
      ...(Number.isInteger(error?.unresolvedCount) ? { unresolvedCount: error.unresolvedCount } : {}),
      ...(Array.isArray(error?.missingAssetIds) ? { missingAssetIds: error.missingAssetIds } : {}),
      ...(Array.isArray(error?.assetIds) ? { assetIds: error.assetIds } : {}),
    }
    : code === 'MAIL_CLIENT_PROVIDER_MISMATCH'
      ? {
        expectedProvider: String(error?.expectedProvider || ''),
        actualProvider: String(error?.actualProvider || ''),
      }
    : {};
  // The old text named one provider no matter which channel was selected, and
  // dropped the message the orchestrator had built — which is the only place
  // the actual shortfall (needed vs. available, and how the pool is split) is
  // written down. Pass it through.
  const message = code.startsWith('SESSION_ASSET_MAIL_PROVIDER_')
    ? `邮箱资产校验失败：${detail}`
    : `预检失败：${detail}`;
  return new HttpError(409, message, {
    code,
    ...(code === 'NO_ELIGIBLE_MAILBOX'
      ? { provider: error?.provider || '', needed: error?.needed, available: error?.available, pool: error?.pool || null }
      : providerBinding),
  });
}

function normalizeRequestedJobIds(value) {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values
    .map((jobId) => String(jobId || '').trim())
    .filter(Boolean))];
}

class ControlGate {
  constructor() {
    this.action = '';
    this.waiters = new Set();
    this.wakeWaiters = new Set();
    this.jobRetryRequests = new Map();
    this.controller = new AbortController();
  }

  requestedAction = () => this.action;

  get signal() { return this.controller.signal; }

  request(action) {
    if (!['pause', 'cancel'].includes(action)) throw new Error(`Unsupported control action: ${action}`);
    this.action = action;
    if (!this.controller.signal.aborted) this.controller.abort(action);
    this.wake();
  }

  wake() {
    for (const wake of this.waiters) wake();
    this.waiters.clear();
    for (const wake of this.wakeWaiters) wake();
    this.wakeWaiters.clear();
  }

  requestJobRetry(request = {}) {
    this.requestJobRetries([request]);
  }

  requestJobRetries(requests = []) {
    for (const request of requests) {
      const jobId = String(request?.jobId || '').trim();
      if (!jobId) throw new Error('A job id is required');
      this.jobRetryRequests.set(jobId, { ...request, jobId });
    }
    if (requests.length) this.wake();
  }

  consumeJobRetries() {
    const requests = [...this.jobRetryRequests.values()];
    this.jobRetryRequests.clear();
    return requests;
  }

  waitForWake() {
    let done;
    const promise = new Promise((resolve) => { done = resolve; });
    const wake = () => {
      this.wakeWaiters.delete(wake);
      done();
    };
    this.wakeWaiters.add(wake);
    return {
      promise,
      cancel: () => this.wakeWaiters.delete(wake),
    };
  }

  consume(action) {
    if (this.action === action) {
      this.action = '';
      this.controller = new AbortController();
    }
  }

  wait(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(done, Math.max(0, Number(ms || 0)));
      const self = this;
      function done() {
        clearTimeout(timer);
        self.waiters.delete(done);
        resolve();
      }
      self.waiters.add(done);
      if (self.action) done();
    });
  }
}

function generatedRunId() {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `ui-${stamp}-${Math.random().toString(36).slice(2, 8)}`;
}

function compactDuration(startValue, endValue) {
  const start = Date.parse(String(startValue || ''));
  const end = typeof endValue === 'number' ? endValue : Date.parse(String(endValue || ''));
  const totalSeconds = Number.isFinite(start) && Number.isFinite(end)
    ? Math.max(0, Math.round((end - start) / 1000))
    : 0;
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function terminalRunSummary(state, now = Date.now()) {
  const jobs = Array.isArray(state?.jobs) ? state.jobs : [];
  const plan = state?.runPlan || state?.plan || {};
  const taskKind = String(plan.taskKind || state?.taskKind || 'register_session');
  const sessions = jobs.filter((job) => Boolean(job.sessionAssetId)).length;
  const cpas = jobs.filter((job) => Boolean(job.cpaPath) && job.cpaSuperseded !== true).length;
  let result = 'register';
  let count = sessions;
  if (taskKind === 'register_oauth' || (taskKind === 'register_session' && plan.postRegistrationOAuth === true)) {
    result = 'register_oauth';
    count = cpas;
  } else if (taskKind === 'oauth' && plan.oauthSource?.loginOnly === true) {
    result = 'login';
  } else if (taskKind === 'oauth') {
    result = 'oauth';
    count = cpas;
  } else if (taskKind === 'session_refresh') {
    const security = plan.security && typeof plan.security === 'object' ? plan.security : {};
    result = security.setPassword === true || security.enrollTotp === true
      ? 'otp_pw_recovery'
      : 'refresh';
  }
  const endedAt = state?.completedAt || state?.cancelledAt || state?.updatedAt || now;
  const duration = compactDuration(state?.createdAt, endedAt);
  return {
    message: `${result} ${count} · time ${duration}`,
    details: { result, count, duration, status: String(state?.status || '') },
  };
}

class RunManager extends EventEmitter {
  constructor(options) {
    super();
    this.cwd = path.resolve(options.cwd || process.cwd());
    this.configService = options.configService;
    this.logStore = options.logStore;
    this.proxyService = options.proxyService || new ProxyService(options.configService);
    this.harPath = options.harPath || '';
    // The one seam the sub2api push has: tests drive the gateway through this
    // rather than binding a real listener on 8080.
    this.sub2ApiFetch = options.sub2ApiFetch || null;
    // The nvtokens member inventory API is injected in tests for the same
    // reason; production uses the global fetch implementation.
    this.nvtokensFetch = options.nvtokensFetch || null;
    this.assetStoreOverride = options.assetStore || null;
    this.assetStoreCache = null;
    // Export requests are normally synchronous, but sub2api push stays
    // suspended while the upstream service answers. Keep the selected CPA keys
    // reserved across that await so a second request cannot deliver the same
    // account before the first request stamps its ledger.
    this.cpaExportReservations = new Set();
    this.cpaArtifactListCache = new Map();
    this.cpaArtifactScanCache = new Map();
    this.cpaArtifactWatcher = null;
    this.cpaArtifactWatchRoot = '';
    this.cpaArtifactWatchFailed = false;
    this.cpaArtifactWatchVersion = 0;
    this.closed = false;
    this.active = null;
    this.auxiliaryActive = new Map();
    this.auxiliaryStarting = 0;
    this.starting = false;
    // A session-assets run spends time in async preflight before its state file
    // exists. Reserve those assets in memory so maintenance mutations cannot
    // slip through during that startup window.
    this.startingAssetIds = new Set();
    this.auxiliaryStartingAssetIds = new Set();
    this.preflightCache = null;
    this.preflightFlights = new Map();
    this.compactSummaryCache = new Map();
    this.preflightTtlMs = Number(options.preflightTtlMs || 60000);
    this.now = options.now || Date.now;
    // A transport failure can be reported by several Workers at once. Keep
    // proxy catalog refresh single-flight across active runs so each job can
    // recover locally without multiplying the upstream pull.
    this.proxyRefreshFlight = null;
    this.proxyRefreshFlightCountries = null;
    // The most recent mail.com master import, running behind its request.
    this.mailcomImport = null;
    this.mailcomImportPreparation = null;
    // iCloud imports are a separate mailbox-only workflow. They never enter
    // the Mail.com/Fastmail alias policy or import state machine.
    this.icloudImport = null;
    this.historyPruneInProgress = false;
    this.cleanupRetryTimers = new Map();
    // History retention walks every run, asset and CPA file. It is maintenance
    // — the same pass already runs after each task settles — so the console
    // process asks for it after the port is open (`runBootMaintenance`)
    // instead of keeping the UI unreachable while it runs.
    if (!options.deferBootMaintenance) this.pruneRetainedHistory();
    this.schedulePendingCleanupRetries();
  }

  runBootMaintenance() {
    if (this.closed) return null;
    try { return this.pruneRetainedHistory(); } catch { return null; }
  }

  config() {
    return this.configService.normalized();
  }

  mailcomClient(config = this.config(), provider = '') {
    const selectedProvider = String(provider || config.mail?.provider || '').trim().toLowerCase();
    if (!REMOTE_MAIL_PROVIDERS.includes(selectedProvider)) {
      throw new HttpError(409, 'A remote API mail channel is not selected');
    }
    // `validateV2Config` intentionally blanks remote credentials while the
    // active provider is Xiaopingguo. A provider preview can still target
    // Mail.com/Fastmail before that provider is saved, so recover the secret
    // from the raw config without exposing it in the public snapshot.
    const rawMail = this.configService.readRaw()?.mail || {};
    const mail = {
      ...(config.mail || {}),
      adminToken: config.mail?.adminToken || rawMail.adminToken || '',
      adminTokenEnv: config.mail?.adminTokenEnv || rawMail.adminTokenEnv || 'MAILCOM_ADMIN_TOKEN',
    };
    const baseUrl = selectedProvider === 'fastmail'
      ? mail.fastmailBaseUrl
      : mail.mailcomBaseUrl;
    const aliasSettings = providerAliasSettings(mail, selectedProvider);
    return new MailcomClient({
      baseUrl: baseUrl || mail.baseUrl,
      adminToken: secretFromEnv(mail, 'adminTokenEnv'),
      provider: selectedProvider,
      aliasBatchSize: aliasSettings.aliasBatchSize,
      aliasDomainMode: aliasSettings.aliasDomainMode,
      aliasDomains: aliasSettings.aliasDomains,
    });
  }

  icloudClient(config = this.config()) {
    const rawMail = this.configService.readRaw()?.mail || {};
    const mail = {
      ...(config.mail || {}),
      adminToken: config.mail?.adminToken || rawMail.adminToken || '',
      adminTokenEnv: config.mail?.adminTokenEnv || rawMail.adminTokenEnv || 'MAILCOM_ADMIN_TOKEN',
    };
    return new IcloudClient({
      baseUrl: mail.icloudBaseUrl || 'http://127.0.0.1:8001',
      adminToken: secretFromEnv(mail, 'adminTokenEnv'),
    });
  }

  async mailcomStatus(provider = '') {
    const client = this.mailcomClient(this.config(), provider);
    const [accounts, summary] = await Promise.all([client.listAccounts(), client.summary()]);
    return { accounts, summary };
  }

  async mailcomAccounts(provider = '') {
    return this.mailcomClient(this.config(), provider).listAccounts();
  }

  async mailcomAliasDomains(provider = '') {
    return this.mailcomClient(this.config(), provider).listAliasDomains();
  }

  async prepareMailcomAliasPolicy(config = this.config(), client = this.mailcomClient(config)) {
    const policy = await preflightMailcomAliasDomains(client, config);
    if (policy.ready === false) {
      const statusCode = policy.catalogAvailable === true ? 409 : 503;
      throw new HttpError(
        statusCode,
        policy.error || 'Mail.com alias domains are not available',
        policy,
      );
    }
    if (policy.checked) applyMailcomAliasDomains(client, policy.usable);
    return { client, policy };
  }

  async importMailcomMasters(content, provider = '') {
    const text = String(content || '').trim();
    if (!text) throw new HttpError(400, 'mail.com master account input is empty');
    const config = this.config();
    const selectedProvider = String(provider || config.mail?.provider || '').trim().toLowerCase();
    const providerConfig = selectedProvider === String(config.mail?.provider || '').toLowerCase()
      ? config
      : { ...config, mail: { ...config.mail, provider: selectedProvider } };
    const { client, policy } = await this.prepareMailcomAliasPolicy(
      providerConfig,
      this.mailcomClient(config, selectedProvider),
    );
    return client.importMasters(text, policy.checked ? { aliasDomains: policy.usable } : {});
  }

  /**
   * Start an import and return immediately.
   *
   * Building nine remote aliases per master takes tens of seconds, and the
   * import used to hold the HTTP request open for all of it — so the dialog
   * spun, the operator could not do anything else, and a slow mail.com looked
   * like a hung console. The work now runs behind the request and reports
   * progress the launch page can draw, one master at a time.
   */
  async startMailcomImport(content, provider = '') {
    const text = String(content || '').trim();
    if (!text) throw new HttpError(400, 'mail.com master account input is empty');
    if (this.mailcomImport?.status === 'running' || this.mailcomImportPreparation) {
      throw new HttpError(409, '已有一批主账号正在导入，请等它跑完');
    }
    const entries = [];
    const invalidLines = [];
    text.split(/\r?\n/).forEach((rawLine, index) => {
      const line = rawLine.trim();
      if (!line) return;
      if (!line.includes('----')) { invalidLines.push(index + 1); return; }
      const [email, password] = line.split('----');
      if (!email?.trim() || !password?.trim()) { invalidLines.push(index + 1); return; }
      entries.push({ email: email.trim(), password: password.trim() });
    });
    if (!entries.length) throw new HttpError(400, '没有解析出有效的「邮箱----密码」行');

    const config = this.config();
    const selectedProvider = String(provider || config.mail?.provider || '').trim().toLowerCase();
    const providerConfig = selectedProvider === config.mail.provider
      ? config
      : { ...config, mail: { ...config.mail, provider: selectedProvider } };
    const preparation = this.prepareMailcomAliasPolicy(providerConfig, this.mailcomClient(config, selectedProvider));
    this.mailcomImportPreparation = preparation;
    let prepared;
    try {
      prepared = await preparation;
    } finally {
      if (this.mailcomImportPreparation === preparation) this.mailcomImportPreparation = null;
    }
    const { client, policy } = prepared;
    const effectiveAliasDomains = policy.checked ? [...policy.usable] : null;

    // Create the visible job only after the domain policy is verified, so a
    // rejected whitelist never leaves an import spinning in the background.
    const job = {
      id: `mailcom-import-${this.now()}`,
      provider: selectedProvider,
      status: 'running',
      total: entries.length,
      processed: 0,
      added: 0,
      duplicates: 0,
      aliasesCreated: 0,
      invalidLines,
      current: '',
      failures: [],
      startedAt: new Date(this.now()).toISOString(),
      finishedAt: '',
      error: '',
      ...(policy.checked ? {
        aliasDomains: {
          requested: [...policy.requested],
          usable: [...policy.usable],
          skipped: [...policy.unavailable],
        },
      } : {}),
    };
    this.mailcomImport = job;
    // Sequential on purpose: every master hits the same provider, and mail.com
    // answers alias creation with a masked 409 when it is being pushed.
    (async () => {
      for (const entry of entries) {
        job.current = entry.email;
        try {
          const result = await client.addMaster(
            entry.email,
            entry.password,
            effectiveAliasDomains ? { aliasDomains: effectiveAliasDomains } : {},
          );
          job.added += Number(result?.added || 0);
          job.duplicates += Array.isArray(result?.duplicates) ? result.duplicates.length : Number(result?.duplicates || 0);
          for (const setup of result?.aliasSetup || []) {
            // `produced` is what the create path answers with; `created` is what
            // the already-full path answers with. Reading only one of them is
            // why a master that really did build nine aliases reported zero.
            const built = setup?.created ?? setup?.produced;
            job.aliasesCreated += Array.isArray(built) ? built.length : 0;
            if (setup?.status === 'error' || setup?.failed?.length) {
              job.failures.push({ email: entry.email, message: importFailureText(setup) });
            }
          }
        } catch (error) {
          job.failures.push({ email: entry.email, message: importFailureText({ error: error?.message || String(error) }) });
        }
        job.processed += 1;
      }
      job.current = '';
      job.status = job.failures.length && !job.added ? 'failed' : 'complete';
      job.finishedAt = new Date(this.now()).toISOString();
    })().catch((error) => {
      job.status = 'failed';
      job.error = importFailureText({ error: error?.message || String(error) });
      job.current = '';
      job.finishedAt = new Date(this.now()).toISOString();
    });
    return { ...job };
  }

  mailcomImportProgress() {
    return this.mailcomImport ? { ...this.mailcomImport } : { status: 'idle' };
  }

  async icloudStatus() {
    const client = this.icloudClient(this.config());
    const [accounts, summary] = await Promise.all([client.listAccounts(), client.summary()]);
    return { accounts, summary };
  }

  async startIcloudImport(content) {
    const text = String(content || '').trim();
    if (!text) throw new HttpError(400, 'iCloud mailbox input is empty');
    if (this.icloudImport?.status === 'running') {
      throw new HttpError(409, 'An iCloud mailbox import is already running');
    }
    const entries = [];
    const invalidLines = [];
    text.split(/\r?\n/).forEach((rawLine, index) => {
      const line = rawLine.trim();
      if (!line) return;
      const separator = line.indexOf('----');
      if (separator <= 0) {
        invalidLines.push(index + 1);
        return;
      }
      const email = line.slice(0, separator).trim();
      const endpoint = line.slice(separator + 4).trim();
      if (!email || !endpoint || !/^https?:\/\//i.test(endpoint)) {
        invalidLines.push(index + 1);
        return;
      }
      entries.push({ email, endpoint });
    });
    if (!entries.length) throw new HttpError(400, 'No valid iCloud mailbox lines were found');

    const client = this.icloudClient(this.config());
    const job = {
      id: `icloud-import-${this.now()}`,
      provider: 'icloud',
      status: 'running',
      total: entries.length,
      processed: 0,
      added: 0,
      duplicates: 0,
      invalidLines,
      current: '',
      failures: [],
      startedAt: new Date(this.now()).toISOString(),
      finishedAt: '',
      error: '',
    };
    this.icloudImport = job;
    (async () => {
      for (const entry of entries) {
        job.current = entry.email;
        try {
          const result = await client.addMaster(entry.email, entry.endpoint);
          job.added += Number(result?.added || 0);
          job.duplicates += Array.isArray(result?.duplicates)
            ? result.duplicates.length
            : Number(result?.duplicates || 0);
        } catch (error) {
          job.failures.push({ email: entry.email, message: error?.message || String(error) });
        }
        job.processed += 1;
      }
      job.current = '';
      job.status = job.failures.length && !job.added ? 'failed' : 'complete';
      job.finishedAt = new Date(this.now()).toISOString();
    })().catch((error) => {
      job.status = 'failed';
      job.error = error?.message || String(error);
      job.current = '';
      job.finishedAt = new Date(this.now()).toISOString();
    });
    return { ...job };
  }

  icloudImportProgress() {
    return this.icloudImport ? { ...this.icloudImport } : { status: 'idle' };
  }

  taskSlot(value = {}) {
    return taskSlotOf(value);
  }

  activeRuns() {
    const runs = [];
    if (this.active) runs.push(this.active);
    runs.push(...this.auxiliaryActive.values());
    return runs;
  }

  activeRun(runId) {
    const id = String(runId || '');
    return this.activeRuns().find((candidate) => String(candidate?.state?.runId || '') === id) || null;
  }

  activeRunIds() {
    return this.activeRuns().map((candidate) => String(candidate.state.runId));
  }

  applyProxySnapshotToActive(active, snapshot) {
    if (!active?.state || !Array.isArray(snapshot?.entries)) return false;
    const liveEntries = Array.isArray(active.proxyEntries) ? active.proxyEntries : [];
    const previousIds = new Set(liveEntries.map((entry) => String(entry?.id || '')));
    const leasedIds = new Set(Object.values(active.state?.proxyLeases || {}).map((id) => String(id || '')));
    for (const entry of snapshot.entries) {
      const id = String(entry?.id || '');
      if (!id || previousIds.has(id) || leasedIds.has(id)) continue;
      if (active.state?.proxyHealth?.[id]?.status === 'failed') delete active.state.proxyHealth[id];
    }
    liveEntries.splice(0, liveEntries.length, ...snapshot.entries);
    active.proxyEntries = liveEntries;
    active.state.proxyResourceSnapshot = snapshot;
    return true;
  }

  async refreshActiveProxySnapshots(details = {}) {
    const requestedCountries = new Set((Array.isArray(details?.countryCodes)
      ? details.countryCodes
      : details?.countryCode
        ? [details.countryCode]
        : [])
      .map((countryCode) => String(countryCode || '').trim().toUpperCase())
      .filter((countryCode) => countryCode && countryCode !== 'GLOBAL'));
    const updated = [];
    const skipped = [];
    const failed = [];
    for (const active of this.activeRuns()) {
      const state = active?.state;
      if (!state || !BRANCH_TASK_KINDS.has(taskKindOf(state))) continue;
      const plan = state.runPlan || state.plan || {};
      const assignments = Array.isArray(plan.proxyAssignments)
        ? plan.proxyAssignments
        : [];
      if (requestedCountries.size && !assignments.some((assignment) => (
        assignment?.kind === 'countryPool'
        && requestedCountries.has(String(assignment.countryCode || '').trim().toUpperCase())
      ))) {
        skipped.push(String(state.runId || ''));
        continue;
      }
      try {
        const snapshot = this.proxySnapshot(plan);
        if (!this.applyProxySnapshotToActive(active, snapshot)) continue;
        state.updatedAt = new Date(this.now()).toISOString();
        if (details.persist !== false) {
          try {
            await saveV2StateWithRetry(active.stateFile, state);
          } catch (error) {
            failed.push({ runId: String(state.runId || ''), code: String(error?.code || 'STATE_SAVE_FAILED') });
          }
        }
        const item = {
          runId: String(state.runId || ''),
          entryCount: snapshot.entries.length,
          boundWorkerCount: (state.workers || []).filter((worker) => String(worker?.proxyId || '')).length,
        };
        updated.push(item);
        this.logStore?.append?.(state.runId, {
          source: 'run-manager',
          type: 'proxy_resources_refreshed_for_active_run',
          message: '活动任务已接收最新代理候选池，现有代理租约保持不变',
          details: {
            ...item,
            reason: String(details.reason || 'proxy_refresh'),
            countryCodes: [...requestedCountries],
            persistFailed: failed.some((entry) => entry.runId === item.runId),
          },
        });
      } catch (error) {
        failed.push({
          runId: String(state.runId || ''),
          code: String(error?.code || 'PROXY_SNAPSHOT_REFRESH_FAILED'),
          message: String(error?.message || error),
        });
      }
    }
    return { updated, skipped, failed };
  }

  /**
   * One run id to represent "a task is running", across both slots.
   *
   * `this.active` holds the main slot only, so a console that read it went
   * blank for every `oauth` and `session_refresh` run — which is most of what
   * the login-state page starts. The main slot still wins when both are busy,
   * because that is the run an operator is most likely looking for.
   */
  primaryActiveRunId() {
    return String(this.active?.state?.runId || this.activeRunIds()[0] || '');
  }

  startingAssetsFor(slot) {
    return slot === 'auxiliary' ? this.auxiliaryStartingAssetIds : this.startingAssetIds;
  }

  /**
   * Who is using each task slot, and how much is left.
   *
   * `holders` is the part that is easy to leave out and painful to be without.
   * A slot stays occupied by any run that has not reached a terminal state —
   * including a paused or waiting one, which keeps its slot precisely so it
   * stays resumable rather than being displaced by a new task. Nothing is
   * executing then, so `activeRunIds` is empty and the console has a disabled
   * launch button and no way to explain it: the operator sees no running task
   * and cannot start one. Naming the run that holds the slot turns that dead
   * end into "resume or cancel this one".
   */
  taskCapacitySnapshot() {
    const entry = (slot) => {
      const snapshot = this.slotCapacity(slot);
      return {
        capacity: snapshot.capacity,
        running: snapshot.occupied,
        starting: snapshot.starting,
        available: Math.max(0, snapshot.capacity - snapshot.occupied - snapshot.starting),
        holders: this.unresolved(slot).map((run) => ({
          runId: String(run.runId || ''),
          status: String(run.status || ''),
          // Distinguishes "still executing" from "parked and holding the slot",
          // which read identically in a count.
          active: run.active === true,
        })),
      };
    };
    return {
      main: entry('main'),
      auxiliary: entry('auxiliary'),
    };
  }

  slotCapacity(slot, excludeRunId = '') {
    const normalized = slot === 'auxiliary' ? 'auxiliary' : 'main';
    return {
      slot: normalized,
      capacity: normalized === 'auxiliary' ? DEFAULT_AUXILIARY_TASK_CAPACITY : 1,
      occupied: this.occupiedSlotCount(normalized, excludeRunId),
      starting: normalized === 'auxiliary' ? this.auxiliaryStarting : (this.starting ? 1 : 0),
    };
  }

  occupiedSlotCount(slot, excludeRunId = '') {
    const excluded = String(excludeRunId || '');
    const ids = new Set(this.unresolved(slot).map((run) => String(run.runId || '')));
    for (const active of this.activeRuns()) {
      if (taskSlotOf(active.state) !== slot) continue;
      const id = String(active.state.runId || '');
      if (id && id !== excluded) ids.add(id);
    }
    if (excluded) ids.delete(excluded);
    return ids.size;
  }

  isTaskSlotBusy(slot = 'main') {
    const snapshot = this.slotCapacity(slot);
    return snapshot.occupied + snapshot.starting >= snapshot.capacity;
  }

  assertTaskSlotAvailable(slot, excludeRunId = '', options = {}) {
    const snapshot = this.slotCapacity(slot, excludeRunId);
    const normalized = snapshot.slot;
    const occupied = snapshot.occupied;
    const starting = options.ignoreStarting === true
      ? 0
      : snapshot.starting;
    const capacity = snapshot.capacity;
    if (occupied + starting < capacity) return;
    const error = new HttpError(
      409,
      normalized === 'auxiliary'
        ? 'All auxiliary task capacity is in use'
        : 'A registration task is already active or starting',
      {
        code: normalized === 'auxiliary' ? 'AUXILIARY_TASK_CAPACITY' : 'MAIN_TASK_CAPACITY',
        slot: normalized,
        capacity,
        running: occupied,
        starting,
      },
    );
    throw error;
  }

  reserveStartingSlot(slot, excludeRunId = '') {
    this.assertTaskSlotAvailable(slot, excludeRunId);
    const token = { slot, assetIds: new Set() };
    if (slot === 'auxiliary') this.auxiliaryStarting += 1;
    else {
      this.starting = true;
      this.startingAssetIds.clear();
    }
    return token;
  }

  reserveStartingAssets(token, assetIds = []) {
    const ids = [...new Set(assetIds.map((id) => String(id || '').trim()).filter(Boolean))];
    if (!ids.length) return;
    const inUse = this.sessionAssetIdsInUse();
    const starting = this.startingAssetsFor(token.slot);
    const conflicts = ids.filter((id) => inUse.has(id) || starting.has(id));
    if (conflicts.length) {
      throw new HttpError(409, 'One or more selected login-state assets are already in use', {
        code: 'SESSION_ASSET_IN_USE',
        assetIds: conflicts,
      });
    }
    for (const id of ids) {
      starting.add(id);
      token.assetIds.add(id);
    }
  }

  releaseStartingSlot(token) {
    if (!token) return;
    const starting = this.startingAssetsFor(token.slot);
    for (const id of token.assetIds || []) starting.delete(id);
    if (token.slot === 'auxiliary') this.auxiliaryStarting = Math.max(0, this.auxiliaryStarting - 1);
    else {
      this.starting = false;
      this.startingAssetIds.clear();
    }
  }

  oauthCooldownsForPlan(plan, state = null) {
    if (plan?.taskKind !== 'oauth' || plan.oauthSource?.kind !== 'session_assets') return [];
    // A login-only run never starts OAuth, so an OAuth cooldown does not apply.
    if (plan.oauthSource.loginOnly === true) return [];
    const assetIds = new Set((plan.oauthSource.assetIds || []).map((id) => String(id || '').trim()).filter(Boolean));
    for (const job of state?.jobs || []) {
      for (const id of [job?.assetId, job?.sessionAssetId]) {
        const normalized = String(id || '').trim();
        if (normalized) assetIds.add(normalized);
      }
    }
    const blocked = [];
    const store = this.sessionAssets();
    const now = typeof this.now === 'function' ? this.now : Date.now;
    for (const id of assetIds) {
      let asset;
      try { asset = store.get(id); } catch (error) {
        if (error?.code === 'ENOENT') continue;
        throw error;
      }
      if (!oauthCooldownActive(asset, now)) continue;
      blocked.push({
        assetId: id,
        email: String(asset.email || ''),
        cooldownUntil: String(asset.oauthCooldown?.until || ''),
        failureCount: Number(asset.oauthCooldown?.failureCount || 0),
      });
    }
    return blocked;
  }

  assertOAuthAssetsNotCooling(plan, state = null) {
    const blocked = this.oauthCooldownsForPlan(plan, state);
    if (!blocked.length) return;
    throw new HttpError(409, 'One or more selected login-state assets are in OAuth cooldown', {
      code: 'OAUTH_ASSET_COOLDOWN',
      assetIds: blocked.map((item) => item.assetId),
      cooldowns: blocked,
    });
  }

  filterOAuthCooldownAssets(plan) {
    if (plan?.taskKind !== 'oauth' || plan.oauthSource?.kind !== 'session_assets') {
      return { plan, blocked: [] };
    }
    const assetIds = (plan.oauthSource.assetIds || []).map((id) => String(id || '').trim()).filter(Boolean);
    if (!assetIds.length) return { plan, blocked: [] };
    const blocked = this.oauthCooldownsForPlan(plan);
    if (!blocked.length || blocked.length >= assetIds.length) return { plan, blocked };
    const blockedIds = new Set(blocked.map((item) => item.assetId));
    const eligibleIds = assetIds.filter((id) => !blockedIds.has(id));
    const workerConcurrency = Math.max(
      1,
      Math.min(Number(plan.workerConcurrency) || 1, eligibleIds.length),
    );
    const proxyAssignments = Array.isArray(plan.proxyAssignments)
      ? plan.proxyAssignments
        .slice(0, workerConcurrency)
        .map((assignment, index) => ({ ...assignment, workerSlot: index + 1 }))
      : plan.proxyAssignments;
    return {
      blocked,
      plan: {
        ...plan,
        mailCount: eligibleIds.length,
        totalAccounts: eligibleIds.length,
        workerConcurrency,
        ...(Array.isArray(proxyAssignments) ? { proxyAssignments } : {}),
        oauthSource: { ...plan.oauthSource, assetIds: eligibleIds },
      },
    };
  }

  bindSessionAssetMailProvider(planInput = {}, options = {}) {
    const plan = planInput || {};
    const source = plan.oauthSource;
    if (!AUXILIARY_TASK_KINDS.has(String(plan.taskKind || '')) || source?.kind !== 'session_assets') {
      return plan;
    }

    const assetStore = this.sessionAssets();
    const fallbackByAssetId = options.assetMetadata instanceof Map
      ? options.assetMetadata
      : new Map();
    const resolutions = source.assetIds.map((assetId) => {
      let asset = null;
      let missing = false;
      try {
        asset = assetStore.get(assetId);
      } catch (error) {
        // A historical task can outlive a manually removed asset. Preserve
        // the resumable-task compatibility path, but never hide parse or
        // permission errors as a missing asset.
        if (error?.code !== 'ENOENT') throw error;
        missing = true;
      }

      const resolution = sessionAssetMailProviderEvidence(asset || {});
      const fallbackRecords = Array.isArray(fallbackByAssetId.get(String(assetId)))
        ? fallbackByAssetId.get(String(assetId))
        : [];
      const fallbackResolutions = fallbackRecords.map((record) => sessionAssetMailProviderEvidence(record));
      const fallbackProviders = [...new Set(
        fallbackResolutions.map((item) => item.provider).filter(Boolean),
      )];
      const fallbackConflict = fallbackResolutions.find((item) => item.source === 'conflict')
        || (fallbackProviders.length > 1
          ? {
            source: 'conflict',
            providers: fallbackProviders,
            evidence: fallbackResolutions.flatMap((item) => item.evidence || []),
          }
          : null);

      // The asset file remains authoritative. Job metadata is only a recovery
      // fallback for old checkpoints whose asset was deleted or predates the
      // provider field; it must never override a contradictory asset record.
      const resolved = resolution.source === 'conflict'
        ? resolution
        : resolution.provider
          ? resolution
          : (fallbackConflict || fallbackResolutions.find((item) => item.provider) || resolution);
      return {
        assetId: String(assetId),
        asset,
        missing,
        resolution: resolved,
        fallbackRecords,
      };
    });
    const metadataConflict = resolutions.find((item) => item.resolution.source === 'conflict');
    if (metadataConflict) {
      const error = new Error('A login-state asset contains conflicting mail-provider metadata');
      error.code = 'SESSION_ASSET_MAIL_PROVIDER_METADATA_CONFLICT';
      error.providers = metadataConflict.resolution.providers;
      throw error;
    }

    // Assets from several mail channels may share one task: each job reads
    // its own mailbox through the channel its asset came from (see
    // `mailContextForJob`). The plan names the most common one, which is the
    // channel the run's own client opens.
    const providerCounts = new Map();
    for (const item of resolutions) {
      const provider = item.resolution.provider;
      if (provider) providerCounts.set(provider, (providerCounts.get(provider) || 0) + 1);
    }
    const providers = [...providerCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([provider]) => provider);

    const unresolvedWithMailbox = resolutions.filter((item) => (
      !item.resolution.provider
      && (item.missing
        || String(item.asset?.parentMailboxId || '').trim()
        || item.fallbackRecords.some((record) => String(record?.parentMailboxId || '').trim()))
    ));
    if (unresolvedWithMailbox.length) {
      const error = new Error('Could not determine the mail provider for every selected mailbox asset');
      error.code = 'SESSION_ASSET_MAIL_PROVIDER_UNKNOWN';
      error.providers = providers;
      error.unresolvedCount = unresolvedWithMailbox.length;
      error.assetIds = unresolvedWithMailbox.map((item) => item.assetId);
      error.missingAssetIds = resolutions.filter((item) => item.missing).map((item) => item.assetId);
      throw error;
    }

    // Existing-account work follows the mailbox that owns the login state.
    // The global provider selector is for new mailbox generation only.
    // A plan that already names one of the channels keeps it, so a resumed
    // mixed task does not change its primary channel between runs.
    if (!providers.length || providers.includes(String(plan.mailProvider || '').toLowerCase())) return plan;
    return { ...plan, mailProvider: providers[0] };
  }

  bindStateMailProvider(state) {
    if (!state?.runPlan) return state?.runPlan || null;
    // State jobs retain the mailbox id even when a legacy asset file was
    // removed. Use that namespace to recover the provider without falling
    // back to the current global selector.
    const assetMetadata = new Map();
    for (const job of state.jobs || []) {
      const assetId = String(job?.assetId || job?.sessionAssetId || '').trim();
      if (!assetId) continue;
      const records = assetMetadata.get(assetId) || [];
      records.push({
        email: job.email,
        parentMailboxId: job.mailboxId,
      });
      assetMetadata.set(assetId, records);
    }
    const plan = this.bindSessionAssetMailProvider(state.runPlan, { assetMetadata });
    if (plan === state.runPlan || plan.mailProvider === state.runPlan.mailProvider) return plan;
    state.runPlan = plan;
    if (state.preflight?.plan) state.preflight = {
      ...state.preflight,
      plan: { ...state.preflight.plan, mailProvider: plan.mailProvider },
    };
    return plan;
  }

  runConfiguration(planInput = {}) {
    const base = this.config();
    const plan = this.bindSessionAssetMailProvider(normalizeRunPlan(planInput, base));
    if (Array.isArray(planInput.mailAliasDomains)) {
      plan.mailAliasDomains = [...planInput.mailAliasDomains];
    }
    return { config: applyRunPlan(base, plan), plan };
  }

  proxySnapshot(plan) {
    const taskKind = String(plan.taskKind || '');
    const sourceTask = taskKind === 'oauth' || taskKind === 'session_refresh';
    const configuredAssignments = Array.isArray(plan.proxyAssignments) ? plan.proxyAssignments : [];
    // Older saved OAuth plans had no assignment list at all. They still need a
    // durable snapshot so a resume cannot silently run without its forwarder.
    if (Number(plan.schemaVersion || 1) < 2 && !sourceTask) return null;
    const resources = this.proxyService.list();
    const local = new Map((resources.local?.proxies || []).map((entry) => [entry.id, entry]));
    const pools = new Map((resources.dynamic?.countryPools || []).map((pool) => [pool.countryCode, pool]));
    const entries = new Map();

    const addEntry = (entry, assignment, metadata) => {
      const current = entries.get(entry.id) || {
        id: entry.id,
        url: entry.url || entry.endpoint,
        protocol: entry.protocol,
        workerSlots: [],
        resourceKind: metadata.resourceKind,
        countryCode: metadata.countryCode || '',
      };
      if (!current.workerSlots.includes(assignment.workerSlot)) current.workerSlots.push(assignment.workerSlot);
      entries.set(entry.id, current);
    };

    const assignments = configuredAssignments.length
      ? configuredAssignments
      : (sourceTask
        ? maintenanceProxyEntry(this.config(), plan.workerConcurrency).workerSlots.map((workerSlot) => ({ workerSlot, kind: 'maintenance' }))
        : []);
    const localReservations = new Set();

    // Upkeep traffic goes through the configured local forwarder. It is not a
    // catalog resource, so it is synthesised here rather than looked up, and
    // every Worker that asked for it shares the one entry.
    const maintenanceAssignments = assignments.filter((candidate) => candidate.kind === 'maintenance');
    if (maintenanceAssignments.length) {
      const entry = maintenanceProxyEntry(this.config(), plan.workerConcurrency);
      for (const assignment of maintenanceAssignments) addEntry(entry, assignment, { resourceKind: 'maintenance' });
    }
    for (const assignment of assignments.filter((candidate) => candidate.kind === 'local')) {
      const entry = local.get(assignment.localProxyId);
      if (!entry) {
        const error = new Error(`Worker ${assignment.workerSlot} selected a local proxy that no longer exists`);
        error.code = 'LOCAL_PROXY_NOT_FOUND';
        throw error;
      }
      if (localReservations.has(entry.id)) {
        const error = new Error(`Local proxy ${entry.endpoint || entry.url} is assigned to multiple Workers`);
        error.code = 'LOCAL_PROXY_DUPLICATE_ASSIGNMENT';
        throw error;
      }
      localReservations.add(entry.id);
      addEntry(entry, assignment, { resourceKind: 'local' });
    }

    const assignmentsByCountry = new Map();
    for (const assignment of assignments.filter((candidate) => candidate.kind === 'countryPool')) {
      const group = assignmentsByCountry.get(assignment.countryCode) || [];
      group.push(assignment);
      assignmentsByCountry.set(assignment.countryCode, group);
    }
    const selectedCountryByProxy = new Map();
    for (const [countryCode, countryAssignments] of assignmentsByCountry) {
      const pool = pools.get(countryCode);
      if (!pool || !pool.entries.length) {
        const error = new Error(`Worker ${countryAssignments[0].workerSlot} selected empty country pool ${countryCode}`);
        error.code = 'COUNTRY_PROXY_POOL_EMPTY';
        throw error;
      }
      const poolEntries = pool.entries.filter((entry) => !localReservations.has(entry.id));
      for (const entry of poolEntries) {
        const previousCountry = selectedCountryByProxy.get(entry.id);
        if (previousCountry && previousCountry !== countryCode) {
          const error = new Error(`Proxy ${entry.url} appears in both selected country pools ${previousCountry} and ${countryCode}`);
          error.code = 'COUNTRY_PROXY_POOL_OVERLAP';
          throw error;
        }
        selectedCountryByProxy.set(entry.id, countryCode);
      }
      if (poolEntries.length < countryAssignments.length) {
        const error = new Error(`Country pool ${countryCode} has ${poolEntries.length} unreserved proxies for ${countryAssignments.length} Workers`);
        error.code = 'COUNTRY_PROXY_POOL_CAPACITY';
        throw error;
      }
      for (const entry of poolEntries) {
        for (const assignment of countryAssignments) {
          addEntry(entry, assignment, { resourceKind: 'countryPool', countryCode });
        }
      }
    }

    return {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      assignments: assignments.map((assignment) => ({ ...assignment })),
      entries: [...entries.values()].map((entry) => ({
        ...entry,
        workerSlots: entry.workerSlots.sort((left, right) => left - right),
      })),
    };
  }

  async refreshProxyResourcesForRun(state, details = {}) {
    if (!this.proxyService || typeof this.proxyService.pullAll !== 'function') {
      throw new HttpError(503, 'Proxy refresh service is unavailable');
    }

    const assignments = Array.isArray(state?.runPlan?.proxyAssignments)
      ? state.runPlan.proxyAssignments
      : [];
    const requestedSlots = Array.isArray(details?.workerSlots)
      ? new Set(details.workerSlots.map((slot) => Number(slot)).filter(Number.isFinite))
      : null;
    const countryCodes = [...new Set(assignments
      .filter((assignment) => assignment?.kind === 'countryPool')
      .filter((assignment) => !requestedSlots || requestedSlots.has(Number(assignment.workerSlot)))
      .map((assignment) => String(assignment.countryCode || '').trim().toUpperCase())
      .filter(Boolean))];
    // A catch-all lane, an old plan without assignments, or a direct caller
    // without worker slots has no narrower country target. Preserve the
    // historical full refresh for those cases.
    const targetCountries = countryCodes.length ? countryCodes : null;

    let refresh;
    for (;;) {
      const activeFlight = this.proxyRefreshFlight;
      if (activeFlight) {
        const activeCountries = this.proxyRefreshFlightCountries;
        const coversRequest = targetCountries
          ? (!activeCountries || targetCountries.every((countryCode) => activeCountries.has(countryCode)))
          : !activeCountries;
        if (coversRequest) {
          refresh = await activeFlight;
          break;
        }
        // Another lane is being refreshed. Wait for it, then start a flight
        // for this lane so a VN shortage is not satisfied by a US-only pull.
        try { await activeFlight; } catch { /* This lane still gets its own pull. */ }
        continue;
      }

      const pullOptions = { allowEmpty: true };
      if (targetCountries) pullOptions.countryCodes = targetCountries;
      const pull = Promise.resolve()
        .then(() => this.proxyService.pullAll(pullOptions))
        .finally(() => {
          if (this.proxyRefreshFlight === pull) {
            this.proxyRefreshFlight = null;
            this.proxyRefreshFlightCountries = null;
          }
        });
      this.proxyRefreshFlight = pull;
      this.proxyRefreshFlightCountries = targetCountries ? new Set(targetCountries) : null;
      refresh = await pull;
      break;
    }
    const snapshot = this.proxySnapshot(state?.runPlan || {});
    if (state && snapshot) state.proxyResourceSnapshot = snapshot;
    return {
      refresh: refresh?.refresh || null,
      snapshot,
    };
  }

  proxyEntriesForState(state, config) {
    const plan = state.runPlan || {};
    const taskKind = String(state.taskKind || plan.taskKind || '');
    const sourceTask = taskKind === 'oauth' || taskKind === 'session_refresh';
    const hasAssignments = Array.isArray(plan.proxyAssignments) && plan.proxyAssignments.length > 0;
    if (Array.isArray(state.proxyResourceSnapshot?.entries) && state.proxyResourceSnapshot.entries.length) {
      return state.proxyResourceSnapshot.entries;
    }
    const maintenanceOnly = sourceTask
      && (!hasAssignments || plan.proxyAssignments.every((assignment) => assignment.kind === 'maintenance'));
    if (maintenanceOnly) {
      return [maintenanceProxyEntry(config, plan.workerConcurrency || config.workers?.maxConcurrency)];
    }
    if (Array.isArray(state.proxyResourceSnapshot?.entries)) return state.proxyResourceSnapshot.entries;
    return config.proxyPool?.path
      ? undefined
      : [];
  }

  configForState(state) {
    const base = this.config();
    const plan = state.runPlan ? this.bindStateMailProvider(state) : null;
    const effective = plan ? applyRunPlan(base, plan) : base;
    // Applying a plan can turn on required health checks (for example the v3
    // shared maintenance lane). Normalize once more so the fingerprint used
    // for resume matches the fingerprint stored when the run was created.
    return validateV2Config(effective, { cwd: this.cwd });
  }

  stateDirectory() {
    const configured = this.configService.readRaw().output?.stateDir || '.gpt-re-state/v2';
    return path.resolve(this.cwd, configured);
  }

  /**
   * Resolved once per synchronous pass, not once per call.
   *
   * `cpaExportKey` asks for this for every artifact in every ledger, and each
   * ask was a stat of the config file plus a full parse of it: 131,221 calls
   * in a single boot over 5,065 CPA files, most of the startup that ran before
   * the port opened. The config cannot change in the middle of one
   * synchronous pass, so the answer is kept until the pass yields and then
   * dropped — an edit is still seen by the very next request.
   */
  cpaDirectory() {
    if (this.cpaDirectoryMemo) return this.cpaDirectoryMemo;
    const configured = this.configService.readRaw().output?.cpaDir || '.gpt-re-state/v2/output';
    this.cpaDirectoryMemo = path.resolve(this.cwd, configured);
    queueMicrotask(() => { this.cpaDirectoryMemo = ''; });
    return this.cpaDirectoryMemo;
  }

  sub2ApiExportRegistryPath() {
    return path.join(this.stateDirectory(), 'cpa-sub2api-exports.json');
  }

  /**
   * Pushes to the sub2api gateway, kept apart from the sub2api *download*
   * ledger on purpose: downloading a file and handing an account to the
   * gateway are different events, and an operator who did one still wants to
   * see that the other has not happened.
   */
  sub2ApiPushRegistryPath() {
    return path.join(this.stateDirectory(), 'cpa-sub2api-pushes.json');
  }

  cpaExportRegistryPath() {
    return path.join(this.stateDirectory(), 'cpa-exports.json');
  }

  nvtokensPushRegistryPath() {
    return path.join(this.stateDirectory(), 'cpa-nvtokens-pushes.json');
  }

  /**
   * Moves settled accounts out of the login-state listing.
   *
   * The store decides which accounts qualify — it holds both halves of the
   * join — and this adds the one fact only the manager knows: an account some
   * task is holding stays put, however settled it looks.
   */
  archiveSettledAssets({ hours } = {}) {
    const store = this.sessionAssets();
    const ids = store.settledSoldIds({ hours, skip: this.sessionAssetIdsInUse() });
    if (!ids.length) return { candidates: 0, archived: 0, skipped: 0 };
    const result = store.relocate(ids);
    return { candidates: ids.length, archived: result.moved.length, skipped: result.skipped.length };
  }

  cpaLockRegistryPath() {
    return path.join(this.stateDirectory(), 'cpa-locked-batches.json');
  }

  readCpaLockRegistry() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cpaLockRegistryPath(), 'utf8'));
      if (
        parsed?.schemaVersion !== CPA_LOCK_REGISTRY_SCHEMA_VERSION
        || !parsed.entries
        || typeof parsed.entries !== 'object'
        || Array.isArray(parsed.entries)
      ) {
        return { schemaVersion: CPA_LOCK_REGISTRY_SCHEMA_VERSION, entries: {} };
      }
      return { schemaVersion: CPA_LOCK_REGISTRY_SCHEMA_VERSION, entries: parsed.entries };
    } catch (error) {
      if (error.code !== 'ENOENT' && error.name !== 'SyntaxError') throw error;
      return { schemaVersion: CPA_LOCK_REGISTRY_SCHEMA_VERSION, entries: {} };
    }
  }

  writeCpaLockRegistry(entries) {
    atomicWriteText(
      this.cpaLockRegistryPath(),
      `${JSON.stringify({ schemaVersion: CPA_LOCK_REGISTRY_SCHEMA_VERSION, entries }, null, 2)}\n`,
    );
  }

  readSub2ApiPushRegistry() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.sub2ApiPushRegistryPath(), 'utf8'));
      if (parsed?.schemaVersion !== 1 || !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
        return { schemaVersion: 1, entries: {} };
      }
      return { schemaVersion: 1, entries: parsed.entries };
    } catch (error) {
      if (error.code !== 'ENOENT' && error.name !== 'SyntaxError') throw error;
      return { schemaVersion: 1, entries: {} };
    }
  }

  readSub2ApiExportRegistry() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.sub2ApiExportRegistryPath(), 'utf8'));
      if (parsed?.schemaVersion !== 1 || !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
        return { schemaVersion: 1, entries: {} };
      }
      return { schemaVersion: 1, entries: parsed.entries };
    } catch (error) {
      if (error.code !== 'ENOENT' && error.name !== 'SyntaxError') throw error;
      return { schemaVersion: 1, entries: {} };
    }
  }

  readCpaExportRegistry() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.cpaExportRegistryPath(), 'utf8'));
      if (parsed?.schemaVersion !== 1 || !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
        return { schemaVersion: 1, entries: {} };
      }
      return { schemaVersion: 1, entries: parsed.entries };
    } catch (error) {
      if (error.code !== 'ENOENT' && error.name !== 'SyntaxError') throw error;
      return { schemaVersion: 1, entries: {} };
    }
  }

  readNvtokensPushRegistry() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.nvtokensPushRegistryPath(), 'utf8'));
      if (
        parsed?.schemaVersion !== NVTOKENS_PUSH_REGISTRY_SCHEMA_VERSION
        || !parsed.entries
        || typeof parsed.entries !== 'object'
        || Array.isArray(parsed.entries)
      ) {
        return { schemaVersion: NVTOKENS_PUSH_REGISTRY_SCHEMA_VERSION, entries: {} };
      }
      return { schemaVersion: NVTOKENS_PUSH_REGISTRY_SCHEMA_VERSION, entries: parsed.entries };
    } catch (error) {
      if (error.code !== 'ENOENT' && error.name !== 'SyntaxError') throw error;
      return { schemaVersion: NVTOKENS_PUSH_REGISTRY_SCHEMA_VERSION, entries: {} };
    }
  }

  cpaExportKey(artifact) {
    return path.relative(this.cpaDirectory(), path.resolve(artifact.filePath)).replace(/\\/g, '/').toLowerCase();
  }

  cpaArtifactVersion(artifact) {
    return `${artifact.size}:${artifact.modifiedAt}:${Number(artifact._revision || 0)}`;
  }

  /**
   * One artifact as the console names it: the run/job pair it is displayed
   * under, plus the file key that actually identifies it. A report about a
   * subset of a selection carries both, so the console can name the exact row
   * it refused even when two rows share a run/job pair.
   */
  cpaArtifactRef(artifact) {
    return {
      runId: String(artifact.runId || ''),
      jobId: String(artifact.jobId || ''),
      key: this.cpaExportKey(artifact),
    };
  }

  cpaArtifactDeliveryAt(artifact) {
    return [
      artifact?.cpaExportedAt,
      artifact?.sub2ApiExportedAt,
      artifact?.sub2ApiPushedAt,
      artifact?.nvtokensCardsImportedAt,
      artifact?.nvtokensMailboxesImportedAt,
      artifact?.nvtokensCardsPooledAt,
    ]
      .filter((value) => typeof value === 'string' && value)
      .sort((left, right) => (Date.parse(left) || 0) - (Date.parse(right) || 0))
      .at(-1) || '';
  }

  cpaLockedArtifactFromEntry(key, entry) {
    const snapshot = entry?.artifact;
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
    let filePath;
    try { filePath = resolveInside(this.cpaDirectory(), key); } catch { return null; }
    const runId = String(snapshot.runId || '').trim();
    const jobId = String(snapshot.jobId || '').trim();
    if (!runId || !isSafeCpaArtifactKey(jobId)) return null;
    return {
      ...snapshot,
      runId,
      jobId,
      filePath,
      locked: true,
      lockedAt: String(entry.lockedAt || '').trim(),
      lockBatchKey: String(entry.batchKey || '').trim(),
      _revision: Number(snapshot._revision || 0),
    };
  }

  cpaArtifactLockSnapshot(artifact, lockedAt, batchKey) {
    const {
      filePath: _filePath,
      locked: _locked,
      lockedAt: _lockedAt,
      lockBatchKey: _lockBatchKey,
      ...snapshot
    } = artifact;
    return {
      version: this.cpaArtifactVersion(artifact),
      lockedAt,
      batchKey,
      artifact: snapshot,
    };
  }

  markSub2ApiExports(exportedArtifacts, availableArtifacts, exportedAtOverride) {
    const previous = this.readSub2ApiExportRegistry().entries;
    const entries = {};
    for (const artifact of availableArtifacts) {
      const key = this.cpaExportKey(artifact);
      const current = previous[key];
      if (current?.version === this.cpaArtifactVersion(artifact) && typeof current.exportedAt === 'string') {
        entries[key] = current;
      }
    }
    const exportedAt = exportedAtOverride || new Date(this.now()).toISOString();
    for (const artifact of exportedArtifacts) {
      entries[this.cpaExportKey(artifact)] = {
        version: this.cpaArtifactVersion(artifact),
        exportedAt,
      };
    }
    atomicWriteText(this.sub2ApiExportRegistryPath(), `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`);
  }

  /**
   * Stamp the artifacts a push actually landed, and drop stale entries.
   *
   * Same version-keyed shape as the export ledgers: a CPA rewritten after its
   * push counts as un-pushed again, which is right — the gateway is holding
   * the previous tokens and wants the new ones.
   */
  markSub2ApiPushes(pushedArtifacts, availableArtifacts, pushedAtOverride) {
    const previous = this.readSub2ApiPushRegistry().entries;
    const entries = {};
    for (const artifact of availableArtifacts) {
      const key = this.cpaExportKey(artifact);
      const current = previous[key];
      if (current?.version === this.cpaArtifactVersion(artifact) && typeof current.pushedAt === 'string') {
        entries[key] = current;
      }
    }
    const pushedAt = pushedAtOverride || new Date(this.now()).toISOString();
    for (const artifact of pushedArtifacts) {
      entries[this.cpaExportKey(artifact)] = {
        version: this.cpaArtifactVersion(artifact),
        pushedAt,
      };
    }
    atomicWriteText(this.sub2ApiPushRegistryPath(), `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}
`);
  }

  markCpaExports(exportedArtifacts, availableArtifacts, exportedAtOverride) {
    const previous = this.readCpaExportRegistry().entries;
    const entries = {};
    for (const artifact of availableArtifacts) {
      const key = this.cpaExportKey(artifact);
      const current = previous[key];
      if (current?.version === this.cpaArtifactVersion(artifact) && typeof current.exportedAt === 'string') {
        entries[key] = current;
      }
    }
    const exportedAt = exportedAtOverride || new Date(this.now()).toISOString();
    for (const artifact of exportedArtifacts) {
      entries[this.cpaExportKey(artifact)] = {
        version: this.cpaArtifactVersion(artifact),
        exportedAt,
      };
    }
    atomicWriteText(this.cpaExportRegistryPath(), `${JSON.stringify({ schemaVersion: 1, entries }, null, 2)}\n`);
  }

  nvtokensStampField(kind) {
    return kind === 'nvtokens_cards'
      ? 'cardsImportedAt'
      : kind === 'nvtokens_mailboxes'
        ? 'mailboxesImportedAt'
        : kind === 'nvtokens_pool'
          ? 'cardsPooledAt'
          : '';
  }

  markNvtokensPushes(kind, pushedArtifacts, availableArtifacts, pushedAtOverride) {
    const stampField = this.nvtokensStampField(kind);
    if (!stampField) throw new Error(`Unknown nvtokens push kind: ${kind}`);
    const previous = this.readNvtokensPushRegistry().entries;
    const entries = {};
    for (const artifact of availableArtifacts) {
      const key = this.cpaExportKey(artifact);
      const current = previous[key];
      if (current?.version !== this.cpaArtifactVersion(artifact)) continue;
      const retained = { version: current.version };
      for (const field of ['cardsImportedAt', 'mailboxesImportedAt', 'cardsPooledAt']) {
        if (typeof current[field] === 'string') retained[field] = current[field];
      }
      entries[key] = retained;
    }
    const pushedAt = pushedAtOverride || new Date(this.now()).toISOString();
    for (const artifact of pushedArtifacts) {
      const key = this.cpaExportKey(artifact);
      entries[key] = {
        ...(entries[key] || {}),
        version: this.cpaArtifactVersion(artifact),
        [stampField]: pushedAt,
      };
    }
    atomicWriteText(
      this.nvtokensPushRegistryPath(),
      `${JSON.stringify({ schemaVersion: NVTOKENS_PUSH_REGISTRY_SCHEMA_VERSION, entries }, null, 2)}\n`,
    );
  }

  /**
   * The recording a run replays, or an empty one.
   *
   * A HAR is evidence of what the protocol looked like when it was captured,
   * not the protocol itself. It ages with every deploy on the other side, it
   * pins one browser's header block onto every account, and replaying it hands
   * every account the same `traceparent` and datadog ids. Both schedulers
   * build each request from the templates declared in code and the account's
   * own client profile, so a run opens a capture only when an operator asks
   * for one — to replay a fresh recording against those templates.
   *
   * Loading it eagerly was also a standing failure mode of its own: a
   * workspace holding two `localhost_Archive*.har` files made `findDefaultHar`
   * throw before the first job started, so the whole run died on a file it did
   * not need.
   */
  protocolCapture(_state, config) {
    if (config?.registration?.protocolTemplates !== 'capture') return EMPTY_PROTOCOL_CAPTURE;
    return loadHar(this.harPath || undefined).har;
  }

  sessionAssets() {
    if (this.assetStoreOverride) return this.assetStoreOverride;
    const raw = this.configService.readRaw();
    const stateDir = raw.output?.stateDir || '.gpt-re-state/v2';
    const cpaDir = raw.output?.cpaDir || '.gpt-re-state/v2/output';
    const key = `${path.resolve(this.cwd, stateDir)}|${path.resolve(this.cwd, cpaDir)}`;
    if (!this.assetStoreCache || this.assetStoreCache.key !== key) {
      const store = new SessionAssetStore({ cwd: this.cwd, stateDir, cpaDir });
      store.migrateCpaFileNames();
      this.assetStoreCache?.store?.close?.();
      this.assetStoreCache = {
        key,
        store,
      };
    }
    return this.assetStoreCache.store;
  }

  sessionAssetIdsInUse() {
    const states = new Map();
    const files = this.stateFiles();
    this.pruneStateCache(files);
    for (const stateFile of files) {
      try {
        // Read-only scan, so the shared cached parse is safe here.
        const state = this.cachedState(stateFile);
        states.set(state.runId, state);
      } catch { /* Ignore unreadable history; the asset store has its own backup handling. */ }
    }
    for (const active of this.activeRuns()) {
      if (active?.state) states.set(active.state.runId, active.state);
    }

    const ids = new Set(this.startingAssetIds);
    for (const id of this.auxiliaryStartingAssetIds) ids.add(id);
    for (const state of states.values()) {
      // A terminal branch run may still expose a recovery action (for example
      // a created-account or security checkpoint). It still owns its assets
      // until that recovery is consumed or the run is explicitly discarded.
      const resumable = BRANCH_TASK_KINDS.has(state.taskKind) && canResumeBranchState(state);
      if (TERMINAL_RUN_STATUSES.has(state.status) && !resumable) continue;
      if (TERMINAL_RUN_STATUSES.has(state.status) && BRANCH_TASK_KINDS.has(state.taskKind)) {
        for (const id of resumableBranchAssetIds(state)) ids.add(String(id));
        continue;
      }
      for (const id of state.runPlan?.oauthSource?.assetIds || []) {
        if (id) ids.add(String(id));
      }
      for (const job of state.jobs || []) {
        for (const id of [job.assetId, job.sessionAssetId]) {
          if (id) ids.add(String(id));
        }
      }
    }
    // A live registration worker can save the login-state file before its
    // checkpoint writes the new asset id back to the job. Protect that short
    // window with sourceRunId; terminal resumable runs are already narrowed to
    // their recoverable Jobs above and must not relock completed siblings.
    this.addAssetsProducedByOpenRuns(ids, states, { includeResumable: false });
    return ids;
  }

  addAssetsProducedByOpenRuns(ids, states, options = {}) {
    const includeResumable = options.includeResumable !== false;
    const openRunIds = new Set();
    for (const state of states.values()) {
      const runId = String(state?.runId || '').trim();
      if (!runId) continue;
      const status = String(state?.status || '').toLowerCase();
      if (!TERMINAL_RUN_STATUSES.has(status)) {
        openRunIds.add(runId);
        continue;
      }
      if (includeResumable
        && BRANCH_TASK_KINDS.has(state.taskKind)
        && canResumeBranchState(state)) {
        openRunIds.add(runId);
      }
    }
    if (!openRunIds.size) return;
    let owners;
    try {
      owners = this.sessionAssets().ownershipEntries();
    } catch {
      return;
    }
    for (const owner of owners) {
      const id = String(owner?.id || '').trim();
      const sourceRunId = String(owner?.sourceRunId || '').trim();
      if (id && openRunIds.has(sourceRunId)) ids.add(id);
    }
  }

  sessionAssetIdsInFlight() {
    const states = new Map();
    const files = this.stateFiles();
    this.pruneStateCache(files);
    for (const stateFile of files) {
      try {
        // This read-only scan shares the same cache as the conservative
        // ownership check above, but applies a narrower job-level policy.
        const state = this.cachedState(stateFile);
        states.set(state.runId, state);
      } catch { /* Ignore unreadable history; maintenance can retry next cycle. */ }
    }
    for (const active of this.activeRuns()) {
      if (active?.state) states.set(active.state.runId, active.state);
    }

    const ids = new Set(this.startingAssetIds);
    for (const id of this.auxiliaryStartingAssetIds) ids.add(id);
    for (const state of states.values()) {
      const runIsActive = !TERMINAL_RUN_STATUSES.has(String(state.status || '').toLowerCase());
      const jobsByAsset = new Map();
      for (const job of state.jobs || []) {
        const status = String(job?.status || '').trim();
        const jobIsInFlight = status
          ? !isTerminalJobStatus(status)
          : runIsActive;
        for (const id of [job?.assetId, job?.sessionAssetId]) {
          const normalized = String(id || '').trim();
          if (!normalized) continue;
          const entries = jobsByAsset.get(normalized) || [];
          entries.push(jobIsInFlight);
          jobsByAsset.set(normalized, entries);
          if (jobIsInFlight) ids.add(normalized);
        }
      }

      // Auxiliary plans know their target assets before every Job has been
      // materialized. Reserve those targets only when no terminal Job has
      // already released the asset.
      if (runIsActive) {
        for (const id of state.runPlan?.oauthSource?.assetIds || []) {
          const normalized = String(id || '').trim();
          if (!normalized) continue;
          const jobs = jobsByAsset.get(normalized);
          if (!jobs?.length || jobs.some(Boolean)) ids.add(normalized);
        }
      }
    }
    // Include assets already written by an active task even when its current
    // job checkpoint has not recorded the generated asset id yet.
    this.addAssetsProducedByOpenRuns(ids, states, { includeResumable: false });
    return ids;
  }

  async mailboxes() {
    const config = this.config();
    const provider = String(config.mail.provider || '').toLowerCase();
    const accounts = REMOTE_MAILBOX_PROVIDERS.includes(provider)
      ? await (provider === 'icloud'
        ? this.icloudClient(config).listAccounts()
        : this.mailcomClient(config).listAccounts())
      : Array.isArray(config.mail.accounts) && config.mail.accounts.length
      ? config.mail.accounts
      : await (async () => {
        const client = new XiaopingguoClient({ baseUrl: config.mail.baseUrl, origin: config.mail.origin });
        await client.login(secretFromEnv(config.mail, 'passwordEnv'));
        const result = await client.listAccounts();
        return Array.isArray(result) ? result : (result.accounts || []);
      })();
    return accounts.map((account) => ({
      id: account.id,
      email: account.email,
      status: account.status || '',
      lifecycle: account.lifecycle || '',
      registrationState: account.registrationState || '',
      reusable: account.reusable === true || (account.reusable === undefined && account.bound !== true),
      claimExpiresAt: account.claimExpiresAt || null,
      bound: account.bound === true,
      tokenValid: account.tokenValid !== false,
      provider: account.provider || '',
    }));
  }

  stateFiles() {
    const directory = this.stateDirectory();
    try {
      return fs.readdirSync(directory)
        .filter((name) => /^run-.+\.json$/i.test(name) && !name.endsWith('.bak'))
        .map((name) => path.join(directory, name));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  /**
   * A parsed state for reading, re-parsed only when the file changes.
   *
   * The console polls `/api/v1/runs` every two seconds and that call used to
   * read, `JSON.parse` and re-validate *every* run file in the directory —
   * history included, none of which ever changes again. With a few dozen runs
   * that is hundreds of milliseconds of blocking parse per poll, stolen from
   * the twenty Workers sharing this event loop.
   *
   * The returned object is shared and must not be mutated. Every write path
   * goes through `load`, which still parses a private copy.
   */
  cachedState(file) {
    const active = this.activeRuns().find((run) => run.stateFile === file);
    if (active?.state) return active.state;
    const stats = fs.statSync(file);
    this.stateCache = this.stateCache || new Map();
    const cached = this.stateCache.get(file);
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached.state;
    const state = loadV2State(file);
    this.stateCache.set(file, { mtimeMs: stats.mtimeMs, size: stats.size, state });
    return state;
  }

  /** Drops cache entries for files that no longer exist. */
  pruneStateCache(files) {
    const live = new Set(files);
    if (this.stateCache) {
      for (const key of this.stateCache.keys()) {
        if (!live.has(key)) this.stateCache.delete(key);
      }
    }
    if (this.compactSummaryCache) {
      for (const key of this.compactSummaryCache.keys()) {
        if (!live.has(key)) this.compactSummaryCache.delete(key);
      }
    }
  }

  findStateFile(runId) {
    const id = safeRunId(runId);
    const file = this.stateFiles().find((candidate) => {
      try { return this.cachedState(candidate).runId === id; } catch { return false; }
    });
    if (!file) throw new HttpError(404, `Run not found: ${id}`);
    return file;
  }

  load(runId) {
    return loadV2State(this.findStateFile(runId));
  }

  summary(state, options = {}) {
    if (!BRANCH_TASK_KINDS.has(state.taskKind)) {
      return summarizeOrchestratorV2State(state, { raw: options.reveal === true });
    }
    const summary = summarizeBranchState(state, { raw: options.reveal === true });
    // Resolved once per call rather than once per job: this used to re-enter
    // the store — and through it the config file — for every job in the run.
    const assets = summary.jobs?.some((job) => job.assetId && job.cpaRevision) ? this.sessionAssets() : null;
    for (const job of summary.jobs || []) {
      if (!job.assetId || !job.cpaRevision) continue;
      try {
        const current = typeof assets.peek === 'function' ? assets.peek(job.assetId) : assets.get(job.assetId);
        job.cpaSuperseded = Number(current.cpa?.revision || 0) !== Number(job.cpaRevision)
          || current.cpa?.runId !== state.runId;
      } catch {
        job.cpaSuperseded = true;
      }
    }
    if (summary.counts) {
      summary.counts.cpaCompleted = (summary.jobs || []).filter((job) => job.cpaPath && !job.cpaSuperseded).length;
    }
    return summary;
  }

  /**
   * The console only needs enough data to name a run, show progress counts,
   * and decide which slot it occupies. Sending every job, worker, mailbox,
   * billing ledger and cleanup record on each poll made old history a part of
   * the live task loop. Details remain available through `get`.
   */
  compactSummary(state, currentCpa = null) {
    const taskKind = taskKindOf(state);
    const branch = BRANCH_TASK_KINDS.has(taskKind);
    const jobs = Array.isArray(state.jobs) ? state.jobs : [];
    const workers = Array.isArray(state.workers) ? state.workers : [];
    const accountCreated = (job) => branch
      ? Boolean(job.sessionAssetId)
      : Boolean(job.accountCreatedAt)
        || (job.runner?.events || []).some((event) => event.step === 'create_account' && event.status === 200);
    const cpaCompleted = jobs.filter((job) => {
      if (!job.cpaPath || job.cpaSuperseded === true) return false;
      if (!branch && job.status !== 'complete') return false;
      return typeof currentCpa === 'function' ? currentCpa(job, state) : true;
    }).length;
    const finalization = {
      queued: jobs.filter((job) => job.finalization?.status === 'queued').length,
      running: jobs.filter((job) => job.finalization?.status === 'running').length,
      failed: jobs.filter((job) => job.status === 'finalize_failed' || job.finalization?.status === 'failed').length,
    };
    return {
      schemaVersion: state.schemaVersion,
      ...(state.mode ? { mode: state.mode } : {}),
      runId: state.runId,
      taskKind,
      status: state.status,
      ...(branch ? { resumable: canResumeBranchState(state) } : {}),
      phase: state.phase || (branch ? '' : 'normal'),
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
      completedAt: state.completedAt || '',
      plan: publicRunPlan(state.runPlan || state.plan || null),
      ...(branch ? { mailRentalWatch: state.mailRentalWatch ? { ...state.mailRentalWatch } : null } : {}),
      counts: {
        workers: {
          total: workers.length,
          running: workers.filter((worker) => worker.status === 'running').length,
          idle: workers.filter((worker) => worker.status === 'idle').length,
        },
        accountsCreated: jobs.filter(accountCreated).length,
        ...(branch ? { sessionsSaved: jobs.filter((job) => Boolean(job.sessionAssetId)).length } : {}),
        cpaCompleted,
        ...(branch ? {
          deactivated: jobs.filter((job) => String(job.error?.code || '').toUpperCase() === 'ACCOUNT_DEACTIVATED').length,
        } : {}),
        finalization,
      },
      error: state.lastError?.message || '',
    };
  }

  list(options = {}) {
    const files = this.stateFiles();
    this.pruneStateCache(files);
    const compact = options.compact === true;
    const currentCpaCache = new Map();
    let assetStore = null;
    const currentCpa = (job, state) => {
      if (!job.assetId || !job.cpaRevision) return true;
      const assetId = String(job.assetId);
      if (!currentCpaCache.has(assetId)) {
        let asset = null;
        try {
          assetStore = assetStore || this.sessionAssets();
          asset = typeof assetStore.peek === 'function' ? assetStore.peek(assetId) : assetStore.get(assetId, { raw: false });
        } catch { /* A missing asset makes the producing run's CPA stale. */ }
        currentCpaCache.set(assetId, asset);
      }
      const asset = currentCpaCache.get(assetId);
      return Boolean(asset)
        && Number(asset.cpa?.revision || 0) === Number(job.cpaRevision)
        && String(asset.cpa?.runId || '') === String(state.runId || '');
    };
    return files.map((file) => {
      try {
        const state = this.cachedState(file);
        const active = Boolean(this.activeRun(state.runId));
        const stateRecord = this.stateCache?.get(file);
        const hasCpaRefs = compact && !active && (state.jobs || []).some((job) => job.cpaPath);
        let assetVersion = 0;
        let cacheable = true;
        if (hasCpaRefs) {
          try {
            assetStore = assetStore || this.sessionAssets();
            assetVersion = Number(assetStore.changeVersion || 0);
          } catch {
            // Do not retain a projection when the asset version cannot be
            // observed; the next poll must be able to recover a fresh count.
            cacheable = false;
          }
        }
        const cached = compact && !active ? this.compactSummaryCache.get(file) : null;
        const signatureMatches = cached
          && cached.mtimeMs === stateRecord?.mtimeMs
          && cached.size === stateRecord?.size
          && cached.assetVersion === assetVersion;
        const projected = signatureMatches
          ? cached.value
          : (compact && !active ? this.compactSummary(state, currentCpa) : this.summary(state));
        if (compact && !active && cacheable && !signatureMatches) {
          this.compactSummaryCache.set(file, {
            mtimeMs: stateRecord?.mtimeMs,
            size: stateRecord?.size,
            assetVersion,
            value: projected,
          });
        }
        return {
          // Keep the active row's existing cost fields for the dashboard. A
          // terminal history row has no live controls that need the detail.
          ...projected,
          // When the run began. The console shows how long a task has been
          // going, and `updatedAt` answers a different question.
          startedAt: String(state.createdAt || ''),
          active,
          taskSlot: taskSlotOf(state),
        };
      } catch (error) {
        return {
          runId: path.basename(file, '.json'),
          status: 'corrupt',
          error: error.message,
          active: false,
          taskSlot: 'main',
        };
      }
    }).sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')));
  }

  unresolved(slot = '') {
    const normalizedSlot = slot ? (slot === 'auxiliary' ? 'auxiliary' : 'main') : '';
    // Slot checks run on every health/list poll. They need no billing,
    // mailbox details or canonical CPA reads for hundreds of completed jobs.
    const runs = [];
    for (const file of this.stateFiles()) {
      try {
        const state = this.cachedState(file);
        const taskSlot = taskSlotOf(state);
        if (TERMINAL_RUN_STATUSES.has(state.status) || state.status === 'corrupt'
          || (normalizedSlot && taskSlot !== normalizedSlot)) continue;
        runs.push({ runId: state.runId, status: state.status, taskSlot, active: Boolean(this.activeRun(state.runId)) });
      } catch { /* Unreadable history cannot hold a task slot. */ }
    }
    return runs;
  }

  clearCleanupRetry(runId) {
    const id = String(runId || '').trim();
    const scheduled = this.cleanupRetryTimers.get(id);
    if (scheduled) clearTimeout(scheduled.timer);
    this.cleanupRetryTimers.delete(id);
  }

  scheduleResourceCleanupRetry(runId, state = null, options = {}) {
    const id = String(runId || '').trim();
    if (!id || this.closed) return;
    let current = state;
    if (!current) {
      try { current = this.load(id); } catch { return; }
    }
    if (!BRANCH_TASK_KINDS.has(current.taskKind) || !resourceCleanupPendingState(current)) {
      this.clearCleanupRetry(id);
      return;
    }
    const now = this.now();
    const scheduledAt = Number.isFinite(Number(options.delayMs))
      ? now + Math.max(0, Number(options.delayMs))
      : resourceCleanupRetryAt(current, now);
    const previous = this.cleanupRetryTimers.get(id);
    if (previous && previous.at <= scheduledAt) return;
    this.clearCleanupRetry(id);
    const timer = setTimeout(() => {
      this.cleanupRetryTimers.delete(id);
      this.retryResourceCleanup(id).catch(() => { /* The next retry is scheduled from the failure path. */ });
    }, Math.max(0, scheduledAt - now));
    timer.unref?.();
    this.cleanupRetryTimers.set(id, { timer, at: scheduledAt });
  }

  schedulePendingCleanupRetries() {
    for (const file of this.stateFiles()) {
      try {
        const state = this.cachedState(file);
        if (BRANCH_TASK_KINDS.has(state.taskKind) && resourceCleanupPendingState(state)) {
          this.scheduleResourceCleanupRetry(state.runId, state);
        }
      } catch { /* A corrupt historical state is left for the normal inspection path. */ }
    }
  }

  async retryResourceCleanup(runId) {
    const id = String(runId || '').trim();
    if (!id || this.closed) return;
    const active = this.activeRun(id);
    if (active) {
      this.scheduleResourceCleanupRetry(id, active.state, { delayMs: RESOURCE_CLEANUP_BUSY_RETRY_MS });
      return;
    }
    let state;
    try { state = this.load(id); } catch { return; }
    if (!BRANCH_TASK_KINDS.has(state.taskKind) || !resourceCleanupPendingState(state)) return;
    try {
      // A cancelled branch only needs its cleanup pass repeated. Calling
      // `cancel` avoids the normal config-fingerprint gate and never requeues
      // registration work; a normal completion wait resumes the branch so its
      // final billing pass can run.
      if (state.cancelPending === true) await this.cancel(id, 'resource_cleanup_retry');
      else await this.resume(id, { cleanupRetry: true });
    } catch (error) {
      let latest = state;
      try { latest = this.load(id); } catch { /* Keep the snapshot for retry scheduling. */ }
      if (resourceCleanupPendingState(latest)) {
        this.scheduleResourceCleanupRetry(id, latest, {
          delayMs: this.isTaskSlotBusy(taskSlotOf(latest))
            ? RESOURCE_CLEANUP_BUSY_RETRY_MS
            : undefined,
        });
      }
      this.logStore?.append?.(id, {
        level: 'warn',
        source: 'run-manager',
        type: 'resource_cleanup_retry_failed',
        message: String(error?.message || error || 'Resource cleanup retry failed'),
        details: { code: String(error?.code || 'RESOURCE_CLEANUP_RETRY_FAILED') },
      });
    }
  }

  isBusy() {
    return this.isTaskSlotBusy('main') || this.isTaskSlotBusy('auxiliary');
  }

  preflightIdentity(config, plan, proxyResourceSnapshot) {
    // A credentials OAuth run never opens a mailbox, so the mail secret must
    // not take part in its preflight identity.
    const mailRequired = ['register_oauth', 'register_session'].includes(plan.taskKind);
    const smsRequired = requiresSmsPreflight(plan);
    const secretIdentity = crypto.createHash('sha256');
    if (mailRequired) secretIdentity.update(secretFromEnv(
      config.mail,
      String(config.mail?.provider || '').toLowerCase() === 'smsbower' ? 'apiKeyEnv'
        : REMOTE_MAILBOX_PROVIDERS.includes(String(config.mail?.provider || '').toLowerCase()) ? 'adminTokenEnv' : 'passwordEnv',
    ));
    secretIdentity.update('\0');
    if (smsRequired) secretIdentity.update(secretFromEnv(config.sms, 'apiKeyEnv'));
    const aliasSettings = REMOTE_MAIL_PROVIDERS.includes(String(plan.mailProvider || '').toLowerCase())
      ? providerAliasSettings(config.mail, plan.mailProvider)
      : { aliasDomainMode: 'none', aliasDomains: [] };
    const mailDomainIdentity = {
      provider: plan.mailProvider,
      mode: aliasSettings.aliasDomainMode,
      domains: aliasSettings.aliasDomains,
    };
    return crypto.createHash('sha256')
      .update(configFingerprint(config))
      .update('\0')
      .update(JSON.stringify(plan))
      .update('\0')
      .update(JSON.stringify(proxyResourceSnapshot?.entries || []))
      .update('\0')
      .update(JSON.stringify(mailDomainIdentity))
      .update('\0')
      .update(secretIdentity.digest('hex'))
      .digest('hex');
  }

  async preparedPreflight(config, plan, proxyResourceSnapshot, options = {}) {
    const key = this.preflightIdentity(config, plan, proxyResourceSnapshot);
    const now = this.now();
    const cached = this.preflightCache;
    const cooldownStateIsDynamic = plan.taskKind === 'oauth' && plan.oauthSource?.kind === 'session_assets';
    if (!options.forceRefresh && !cooldownStateIsDynamic &&
      cached?.key === key
      && cached.expiresAt > now
      && (options.reuseUnready !== false || cached.prepared.snapshot.ready)
    ) {
      return cached.prepared;
    }
    const running = this.preflightFlights.get(key);
    if (running) return running;

    const operation = prepareBranchPreflight(config, plan, {
      proxyEntries: proxyResourceSnapshot?.entries || [],
      assetStore: this.sessionAssets(),
    }).then((prepared) => {
      // A temporary SMSBower catalogue response must not be held for the full
      // normal preflight TTL. Keep successful snapshots cached as before, but
      // retry a failed rental stock read quickly so the dashboard can recover
      // without a manual refresh.
      const mailStockFailed = prepared.snapshot?.mail?.stockStatus === 'error';
      this.preflightCache = {
        key,
        expiresAt: this.now() + (mailStockFailed ? Math.min(this.preflightTtlMs, 5_000) : this.preflightTtlMs),
        prepared,
      };
      return prepared;
    });
    this.preflightFlights.set(key, operation);
    try {
      return await operation;
    } finally {
      if (this.preflightFlights.get(key) === operation) this.preflightFlights.delete(key);
    }
  }

  async initializeBalanceReconciliation(state, plan, config, preflight, resources = null) {
    const provider = resources?.smsProvider;
    const hasReader = typeof provider?.getBalance === 'function';
    const accountFingerprint = hasReader ? balanceAccountFingerprint(provider) : '';
    recordBalanceStart(state, preflight?.sms, this.now(), {
      hasReader,
      accountFingerprint,
    });
    const usesRentalBalance = ['register_oauth', 'register_session'].includes(String(plan?.taskKind || ''))
      && String(config?.mail?.provider || '').toLowerCase() === 'smsbower';
    const needsFreshStart = Boolean(preflight?.sms?.checked === true || usesRentalBalance);
    if (!hasReader || !needsFreshStart || finiteNumber(state.balanceReconciliation?.startBalance) !== null) {
      return state.balanceReconciliation || null;
    }

    let balance = null;
    let errorCode = '';
    try {
      balance = Number(await provider.getBalance({ fresh: true }));
      if (!Number.isFinite(balance)) throw new Error('Balance response is invalid');
    } catch (error) {
      errorCode = String(error?.code || error?.name || 'BALANCE_READ_FAILED').slice(0, 96);
    }
    const providerLabel = provider?.name || config.sms?.provider || '';
    const summary = {
      checked: true,
      provider: providerLabel,
      currency: currencyName(preflight?.sms?.currency, providerLabel),
      balance,
      checkedAt: new Date(this.now()).toISOString(),
      source: 'task_start',
      errorCode,
    };
    return recordBalanceStart(state, summary, this.now(), {
      hasReader: true,
      accountFingerprint,
    });
  }

  runSmsProvider(state, config, preparedResources = null) {
    if (preparedResources?.smsProvider) return preparedResources.smsProvider;
    const leases = (state.jobs || []).flatMap((job) => [
      ...(job.sms?.attempts || []),
      ...(job.sms?.current ? [job.sms.current] : []),
    ]).filter((lease) => lease?.id || lease?.activationId);
    return createSmsProvider({ ...config.sms, leases });
  }

  runtimeResourcesForStart(state, config, prepared) {
    const source = prepared?.resources || {};
    const mailClient = source.mailClient && typeof source.mailClient.fork === 'function'
      ? source.mailClient.fork()
      : null;
    return {
      ...source,
      // Preflight may be shared by concurrent starts. Never pass an unknown
      // mutable client through to another run; makeContext will recreate it.
      mailClient,
      mailAccounts: Array.isArray(source.mailAccounts) ? clone(source.mailAccounts) : [],
      smsPreflight: clone(source.smsPreflight || null),
      smsProvider: this.runSmsProvider(state, config),
    };
  }

  concurrentBalanceRunIdsForActive(active) {
    const state = active?.state || {};
    const provider = stateBalanceProvider(state, active);
    if (!provider) return [];
    const accountFingerprint = activeBalanceAccountFingerprint(active);
    return this.activeRuns()
      .filter((active) => String(active?.state?.runId || '') !== String(state.runId || ''))
      .filter((candidate) => stateUsesBalanceAccount(candidate?.state || {}, provider, candidate))
      .filter((candidate) => {
        const candidateFingerprint = activeBalanceAccountFingerprint(candidate);
        return fingerprintsMayShare(accountFingerprint, candidateFingerprint);
      })
      .map((active) => String(active.state.runId || '').trim())
      .filter(Boolean);
  }

  async finalizeBalanceReconciliation(active) {
    const state = active?.state;
    if (!state?.balanceReconciliation || state.balanceReconciliation.finalizedAt) return null;
    let endBalance = null;
    let endAccountFingerprint = '';
    let errorCode = '';
    try {
      const provider = active.smsProvider || this.runSmsProvider(state, active.config, active.preparedResources);
      active.smsProvider = provider;
      endAccountFingerprint = balanceAccountFingerprint(provider);
      active.balanceAccountFingerprint = endAccountFingerprint;
      if (typeof provider?.getBalance !== 'function') throw Object.assign(new Error('Balance reader is unavailable'), { code: 'BALANCE_READER_UNAVAILABLE' });
      endBalance = Number(await provider.getBalance({ fresh: true }));
      if (!Number.isFinite(endBalance)) throw Object.assign(new Error('Balance response is invalid'), { code: 'INVALID_BALANCE_RESPONSE' });
    } catch (error) {
      errorCode = String(error?.code || error?.name || 'BALANCE_READ_FAILED').slice(0, 96);
    }
    const amounts = financialAmounts(state, state.balanceReconciliation.currency);
    const reconciliation = finalizeBalanceReconciliation(
      state.balanceReconciliation,
      {
        endBalance,
        endAccountFingerprint,
        errorCode,
        confirmedConsumed: amounts.confirmed,
        unresolved: amounts.unresolved,
        cancelledUnresolved: amounts.cancelledUnresolved,
        cancellationOnlyUnresolved: amounts.cancellationOnlyUnresolved,
        cancelledUnresolvedByJob: amounts.cancelledUnresolvedByJob,
        billingComplete: amounts.billingComplete,
        currencyMismatch: amounts.currencyMismatch,
        concurrentRunIds: this.concurrentBalanceRunIdsForActive(active),
        endCheckedAt: new Date(this.now()).toISOString(),
      },
      this.now(),
    );
    state.balanceReconciliation = reconciliation;
    state.updatedAt = new Date(this.now()).toISOString();
    try { await saveV2StateWithRetry(active.stateFile, state); } catch { /* Reconciliation must not change the task result. */ }
    this.appendBalanceReconciliationLog(state.runId, reconciliation);
    return reconciliation;
  }

  appendBalanceReconciliationLog(runId, reconciliation) {
    this.logStore.append(runId, {
      source: 'run-manager',
      type: 'balance_reconciliation',
      message: `Task balance reconciliation: ${reconciliation.status}`,
      details: {
        provider: reconciliation.provider,
        currency: reconciliation.currency,
        status: reconciliation.status,
        startBalance: reconciliation.startBalance,
        endBalance: reconciliation.endBalance,
        observedDecrease: reconciliation.observedDecrease,
        confirmedConsumed: reconciliation.confirmedConsumed,
        unresolved: reconciliation.unresolved,
        unresolvedBeforeBalanceSettlement: reconciliation.unresolvedBeforeBalanceSettlement,
        cancelledQuotesSettledByBalance: reconciliation.cancelledQuotesSettledByBalance,
        difference: reconciliation.difference,
        concurrent: reconciliation.concurrent,
        accountChanged: reconciliation.accountChanged,
        note: reconciliation.note,
      },
    });
  }

  /**
   * Re-read only the provider balance for a completed task. Retrying the run
   * itself would repeat mailbox, SMS, and OAuth side effects, so this path is
   * deliberately independent from both orchestrators.
   */
  async reconcileBalance(runId) {
    const id = safeRunId(runId);
    if (this.activeRun(id)) throw new HttpError(409, 'Cannot reconcile the balance of an active run', { code: 'RUN_ACTIVE' });
    const stateFile = this.findStateFile(id);
    const lock = acquireStateLock(stateFile, { command: 'ui-balance-reconcile', runId: id });
    try {
      if (this.activeRun(id)) throw new HttpError(409, 'Cannot reconcile the balance of an active run', { code: 'RUN_ACTIVE' });
      const state = loadV2State(stateFile);
      if (!TERMINAL_RUN_STATUSES.has(String(state.status || '').toLowerCase())) {
        throw new HttpError(409, 'Balance reconciliation is available after the run has stopped', {
          code: 'RUN_NOT_TERMINAL',
          status: state.status,
        });
      }
      const current = state.balanceReconciliation;
      if (!current) {
        throw new HttpError(409, 'This run has no balance reconciliation to retry', {
          code: 'BALANCE_RECONCILIATION_UNAVAILABLE',
        });
      }
      // A terminal run may have reached this endpoint without ever entering
      // the finalizer (for example, a paused run cancelled after its worker
      // loop had already exited). Any record without finalizedAt is still an
      // honest, retryable snapshot; do not require the finalizer to have
      // stamped retryable first.
      if (current.finalizedAt) {
        throw new HttpError(409, 'This balance reconciliation is already final', {
          code: 'BALANCE_RECONCILIATION_NOT_RETRYABLE',
          status: current.status,
        });
      }

      // SMS settings are global today, but the reconciliation records which
      // provider was used. Keep a later global provider switch from silently
      // reading the wrong account during a retry.
      const baseConfig = this.config();
      const config = {
        ...baseConfig,
        sms: { ...(baseConfig.sms || {}), provider: normalizedProvider(current.provider) },
      };
      let provider = null;
      let endBalance = null;
      let endAccountFingerprint = '';
      let errorCode = '';
      try {
        provider = this.runSmsProvider(state, config);
        if (typeof provider?.getBalance !== 'function') {
          throw Object.assign(new Error('Balance reader is unavailable'), { code: 'BALANCE_READER_UNAVAILABLE' });
        }
        endAccountFingerprint = balanceAccountFingerprint(provider);
        endBalance = Number(await provider.getBalance({ fresh: true }));
        if (!Number.isFinite(endBalance)) {
          throw Object.assign(new Error('Balance response is invalid'), { code: 'INVALID_BALANCE_RESPONSE' });
        }
      } catch (error) {
        errorCode = String(error?.code || error?.name || 'BALANCE_READ_FAILED').slice(0, 96);
      }
      const amounts = financialAmounts(state, current.currency);
      const active = provider ? {
        state,
        config,
        smsProvider: provider,
        balanceAccountFingerprint: endAccountFingerprint,
      } : null;
      const reconciliation = finalizeBalanceReconciliation(current, {
        endBalance,
        endAccountFingerprint,
        errorCode,
        confirmedConsumed: amounts.confirmed,
        unresolved: amounts.unresolved,
        cancelledUnresolved: amounts.cancelledUnresolved,
        cancellationOnlyUnresolved: amounts.cancellationOnlyUnresolved,
        cancelledUnresolvedByJob: amounts.cancelledUnresolvedByJob,
        billingComplete: amounts.billingComplete,
        currencyMismatch: amounts.currencyMismatch,
        concurrentRunIds: active ? this.concurrentBalanceRunIdsForActive(active) : [],
        endCheckedAt: new Date(this.now()).toISOString(),
      }, this.now());
      state.balanceReconciliation = reconciliation;
      state.updatedAt = new Date(this.now()).toISOString();
      await saveV2StateWithRetry(stateFile, state);
      this.appendBalanceReconciliationLog(id, reconciliation);
      return this.summary(state);
    } finally {
      lock.release();
    }
  }

  async preflight(planInput = {}, options = {}) {
    try {
      // Inside the try on purpose: plan validation throws plain Errors, and
      // leaving this outside turned every rejected plan into an opaque 500
      // instead of telling the operator which rule the plan broke.
      const { config, plan } = this.runConfiguration(planInput);
      const snapshot = this.proxySnapshot(plan);
      const prepared = await this.preparedPreflight(config, plan, snapshot, options);
      const effectivePlan = Array.isArray(prepared.effectiveMailAliasDomains)
        ? { ...plan, mailAliasDomains: [...prepared.effectiveMailAliasDomains] }
        : plan;
      return { ...prepared.snapshot, plan: effectivePlan };
    } catch (error) {
      throw preflightHttpError(error);
    }
  }

  async start(planInput = {}, startOptions = {}) {
    const slot = taskSlotOf(planInput);
    const startingToken = this.reserveStartingSlot(slot);
    let stateFile = '';
    let launched = false;
    try {
      // Same reason as in `preflight`: a plan the schema rejects has to come
      // back as the rule it broke, not as an internal error.
      let config;
      let plan;
      try { ({ config, plan } = this.runConfiguration(planInput)); } catch (error) { throw preflightHttpError(error); }
      const cooldownAdjusted = this.filterOAuthCooldownAssets(plan);
      plan = cooldownAdjusted.plan;
      // Cooldown assets are excluded from a mixed OAuth launch. Rebuild the
      // effective config after resizing the source and Worker count so the
      // filtered accounts do not inherit the old task capacity.
      config = applyRunPlan(this.config(), plan);
      if (taskSlotOf(plan) !== slot) {
        throw new HttpError(409, 'The selected task kind changed its execution slot', { code: 'TASK_SLOT_CHANGED' });
      }
      this.reserveStartingAssets(startingToken, plan.oauthSource?.assetIds || []);
      let proxyResourceSnapshot;
      try { proxyResourceSnapshot = this.proxySnapshot(plan); } catch (error) { throw preflightHttpError(error); }
      let preflight;
      let prepared;
      try {
        prepared = await this.preparedPreflight(config, plan, proxyResourceSnapshot, {
          reuseUnready: false,
        });
        preflight = prepared.snapshot;
      } catch (error) { throw preflightHttpError(error); }
      this.assertOAuthAssetsNotCooling(plan);
      if (!preflight.ready) throw new HttpError(409, 'Preflight is not ready', preflight);
      if (Array.isArray(prepared.effectiveMailAliasDomains)) {
        plan.mailAliasDomains = [...prepared.effectiveMailAliasDomains];
        config = applyRunPlan(config, plan);
      }
      const state = makeInitialBranchState(config, plan, { runId: startOptions.runId ? safeRunId(startOptions.runId) : generatedRunId() });
      state.runPlan = plan;
      if (proxyResourceSnapshot) state.proxyResourceSnapshot = proxyResourceSnapshot;
      // Keep the preflight plan as the original checkpoint baseline. The live
      // hang-rental controls update `state.runPlan` after launch and must not
      // rewrite the evidence used to migrate an older checkpoint.
      state.preflight = { ...preflight, plan: structuredClone(plan) };
      const runtimeResources = this.runtimeResourcesForStart(state, config, prepared);
      await this.initializeBalanceReconciliation(state, plan, config, preflight, runtimeResources);
      stateFile = runStatePathV2(config, state.runId, { cwd: this.cwd });
      await saveV2StateWithRetry(stateFile, state);
      this.launch(state, stateFile, config, runtimeResources, { startingToken });
      this.preflightCache = null;
      launched = true;
      return { stateFile: path.relative(this.cwd, stateFile), ...this.summary(state) };
    } finally {
      this.releaseStartingSlot(startingToken);
      if (stateFile && !launched) {
        for (const candidate of [stateFile, `${stateFile}.bak`, `${stateFile}.lock`]) {
          try { fs.unlinkSync(candidate); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
      }
    }
  }

  launch(state, stateFile, config, preparedResources = null, options = {}) {
    const slot = taskSlotOf(state);
    this.assertTaskSlotAvailable(slot, state.runId, { ignoreStarting: options.startingToken?.slot === slot });
    const lock = acquireStateLock(stateFile, { command: 'ui-run', runId: state.runId });
    const gate = new ControlGate();
    const active = { state, stateFile, config, lock, gate, preparedResources, slot, proxyEntries: null, promise: null };
    if (slot === 'auxiliary') this.auxiliaryActive.set(state.runId, active);
    else this.active = active;
    this.logStore.append(state.runId, { source: 'run-manager', type: 'run_started', message: '任务已启动' });
    active.promise = this.execute(active);
    return active;
  }

  appendTerminalSummary(state) {
    const summary = terminalRunSummary(state, this.now());
    return this.logStore.append(state.runId, {
      source: 'run-manager',
      type: 'run_result_summary',
      message: summary.message,
      details: summary.details,
    });
  }

  async execute(active) {
    const { state, stateFile, config, gate, preparedResources } = active;
    try {
      const runtimeResources = { ...(preparedResources || {}) };
      const smsProvider = this.runSmsProvider(state, config, runtimeResources);
      runtimeResources.smsProvider = smsProvider;
      active.smsProvider = smsProvider;
      recordBalanceStart(state, state.preflight?.sms, this.now(), {
        hasReader: typeof smsProvider?.getBalance === 'function',
        accountFingerprint: balanceAccountFingerprint(smsProvider),
      });
      const har = this.protocolCapture(state, config);
      const initialProxyEntries = this.proxyEntriesForState(state, config);
      active.proxyEntries = Array.isArray(initialProxyEntries) ? initialProxyEntries : [];
      const runOptions = {
        proxyEntries: active.proxyEntries,
        control: gate,
        saveState: (next) => saveV2StateWithRetry(stateFile, next),
        onEvent: (event) => this.logStore.append(state.runId, {
          at: event.at,
          source: 'scheduler',
          type: event.type,
          workerId: event.workerId,
          jobId: event.jobId,
          message: event.message || event.type,
          details: event,
        }),
        onCheckpoint: ({ reason, at }) => this.logStore.append(state.runId, {
          at,
          source: 'checkpoint',
          type: 'checkpoint',
          message: reason,
          details: { reason, status: state.status, phase: state.phase },
        }),
        refreshProxyResources: async (details) => {
          const result = await this.refreshProxyResourcesForRun(state, details);
          this.applyProxySnapshotToActive(active, result?.snapshot);
          return result;
        },
        ...runtimeResources,
        retireCountryPoolProxy: async ({ proxy, reason }) => {
          if (proxy?.resourceKind !== 'countryPool' || !proxy?.countryCode) return { retired: false };
          if (typeof this.proxyService?.retireDynamicEntry !== 'function') return { retired: false };
          return this.proxyService.retireDynamicEntry({
            countryCode: proxy.countryCode,
            proxyId: proxy.id,
            proxyUrl: proxy.url,
            reason,
          });
        },
      };
      if (BRANCH_TASK_KINDS.has(state.taskKind)) {
        await runBranchOrchestrator(har, state, config, {
          ...runOptions,
          assetStore: this.sessionAssets(),
        });
      } else {
        await runOrchestratorV2(har, state, config, runOptions);
      }
      // A branch can finish its pause drain with a newer cancel request. In
      // that race the status is already `paused`, but the durable control
      // marker still requires the same cleanup as `cancel_requested`.
      const cancellationRequested = state.status === 'cancel_requested'
        || state.control?.requestedAction === 'cancel';
      if (cancellationRequested) {
        if (BRANCH_TASK_KINDS.has(state.taskKind)) {
          await cancelBranchState(state, config, {
            ...runOptions,
            har,
            assetStore: this.sessionAssets(),
          });
        } else {
          await cancelOrchestratorV2(state, config, {
            proxyEntries: this.proxyEntriesForState(state, config),
            saveState: (next) => saveV2StateWithRetry(stateFile, next),
          });
        }
      }
      const waitingJob = (state.jobs || []).find((job) => job.status === 'waiting' && job.error);
      const waitReason = waitingJob?.error?.message || state.normalWait?.message || '';
      const type = state.status === 'paused' ? 'run_paused' : (state.status === 'waiting' ? 'run_waiting' : 'run_stopped');
      const message = state.status === 'paused'
        ? '任务已安全暂停'
        : (state.status === 'waiting' ? `任务进入等待${waitReason ? `：${waitReason}` : ''}` : `任务已停止：${state.status}`);
      this.logStore.append(state.runId, {
        source: 'run-manager',
        type,
        message,
        details: {
          status: state.status,
          jobId: waitingJob?.id || '',
          code: waitingJob?.error?.code || '',
          reason: waitReason,
          externalCleanup: state.externalCleanup?.length || 0,
        },
      });
      if (TERMINAL_RUN_STATUSES.has(state.status)) {
        await this.finalizeBalanceReconciliation(active);
        this.appendTerminalSummary(state);
      }
    } catch (error) {
      const errorCode = String(error.code || 'ERUN');
      const errorMessage = scrubString(error.message);
      const cleanupPending = resourceCleanupPendingState(state);
      if (cleanupPending) {
        state.status = 'waiting';
        if (!RESOURCE_CLEANUP_PHASES.has(String(state.phase || '').toLowerCase())) {
          state.phase = 'waiting_resource_cleanup';
        }
        state.completedAt = '';
        state.lastError = {
          ...(state.lastError || {
            code: 'RESOURCE_CLEANUP_PENDING',
            message: 'Resource cleanup is pending after the run failed',
          }),
          causeCode: errorCode,
          causeMessage: errorMessage,
        };
      } else {
        state.status = 'failed';
        state.phase = 'failed';
        state.completedAt = state.completedAt || new Date().toISOString();
        state.lastError = { code: errorCode, message: errorMessage };
      }
      state.updatedAt = new Date().toISOString();
      if (TERMINAL_RUN_STATUSES.has(state.status)) await this.finalizeBalanceReconciliation(active);
      try { await saveV2StateWithRetry(stateFile, state); } catch { /* Keep the original run error. */ }
      this.logStore.append(state.runId, {
        level: 'error',
        source: 'run-manager',
        type: 'run_failed',
        message: errorMessage,
        details: { code: errorCode, cleanupPending },
      });
      if (TERMINAL_RUN_STATUSES.has(state.status)) this.appendTerminalSummary(state);
    } finally {
      try { active.lock.release(); } catch { /* Surface lock issues on the next operation. */ }
      const finalStatus = state.status;
      if (active.slot === 'auxiliary') {
        if (this.auxiliaryActive.get(state.runId) === active) this.auxiliaryActive.delete(state.runId);
      } else if (this.active === active) {
        this.active = null;
      }
      if (BRANCH_TASK_KINDS.has(state.taskKind) && resourceCleanupPendingState(state)) {
        this.scheduleResourceCleanupRetry(state.runId, state);
      } else {
        this.clearCleanupRetry(state.runId);
      }
      // Robots wait for a real terminal task state. A proxy-related waiting
      // run is the one exception: the refresh robot can refill the pool and
      // resume it without treating the wait as a finished task.
      if (TERMINAL_RUN_STATUSES.has(finalStatus)) {
        try { this.pruneRetainedHistory(); } catch { /* Retention is maintenance, never a task failure. */ }
        try { this.emit('runFinished', { runId: state.runId, status: finalStatus }); } catch { /* A monitor must not alter task cleanup. */ }
      } else if (finalStatus === 'waiting') {
        const proxyRecovery = proxyRecoveryWaitDetails(state);
        if (proxyRecovery) {
          try {
            this.emit('runWaiting', {
              runId: state.runId,
              status: finalStatus,
              proxyRecovery: true,
              ...proxyRecovery,
            });
          } catch { /* A monitor must not alter task cleanup. */ }
        }
      }
    }
  }

  get(runId, options = {}) {
    const active = this.activeRun(runId);
    const state = active?.state || this.load(runId);
    return { ...this.summary(state, options), active: Boolean(active), taskSlot: taskSlotOf(state) };
  }

  async requestControl(runId, action) {
    const active = this.activeRun(runId);
    if (!active) throw new HttpError(409, 'Run is not currently active');
    active.state.control = {
      ...(active.state.control || {}),
      requestedAction: action,
      requestedAt: new Date().toISOString(),
    };
    active.gate.request(action);
    await saveV2StateWithRetry(active.stateFile, active.state);
    this.logStore.append(runId, { source: 'operator', type: `${action}_requested`, message: action === 'pause' ? '已请求安全暂停' : '已请求安全取消' });
    return this.get(runId);
  }

  async retryJob(runId, jobId, options = {}) {
    return this.retryJobs(runId, [jobId], options);
  }

  async retryJobs(runId, jobIds, options = {}) {
    const id = safeRunId(runId);
    const requestedJobIds = normalizeRequestedJobIds(jobIds);
    if (!requestedJobIds.length) {
      throw new HttpError(400, 'At least one job id is required', { code: 'JOB_IDS_REQUIRED' });
    }
    const active = this.activeRun(id);
    if (active && BRANCH_TASK_KINDS.has(active.state.taskKind)) {
      const jobsById = new Map((active.state.jobs || []).map((job) => [String(job.id || ''), job]));
      const missing = requestedJobIds.filter((jobId) => !jobsById.has(jobId));
      if (missing.length) {
        throw new HttpError(404, `Job not found: ${missing.join(', ')}`, {
          code: 'JOB_NOT_FOUND',
          jobIds: missing,
        });
      }
      if (active.state.control?.requestedAction) {
        throw new HttpError(409, 'The run is stopping; retry the accounts after it has paused', { code: 'RUN_CONTROL_PENDING' });
      }
      const terminal = requestedJobIds
        .map((jobId) => jobsById.get(jobId))
        .find((job) => ['complete', 'failed', 'skipped', 'cancelled'].includes(String(job.status || '').toLowerCase()));
      if (terminal) {
        throw new HttpError(409, `Job is already terminal: ${terminal.status}`, {
          code: 'JOB_TERMINAL',
          jobId: terminal.id,
        });
      }
      const requestedAt = new Date(this.now()).toISOString();
      const requests = requestedJobIds.map((jobId) => ({
        jobId,
        ...(options.resolveSmsAcquisition ? { resolveSmsAcquisition: options.resolveSmsAcquisition } : {}),
        requestedAt,
      }));
      const pending = new Map((active.state.control?.pendingJobRetries || [])
        .map((candidate) => [String(candidate?.jobId || ''), candidate])
        .filter(([candidateJobId]) => candidateJobId));
      for (const request of requests) pending.set(request.jobId, request);
      active.state.control = {
        ...(active.state.control || {}),
        pendingJobRetries: [...pending.values()],
      };
      active.gate.requestJobRetries(requests);
      await saveV2StateWithRetry(active.stateFile, active.state);
      this.logStore.append(id, {
        source: 'operator',
        type: 'job_retry_requested',
        message: '已请求指定账号继续执行',
        details: {
          jobIds: requestedJobIds,
          jobId: requestedJobIds.length === 1 ? requestedJobIds[0] : '',
          count: requestedJobIds.length,
          resolveSmsAcquisition: String(options.resolveSmsAcquisition || ''),
        },
      });
      return this.get(id);
    }
    return this.resume(id, {
      ...options,
      jobIds: requestedJobIds,
    });
  }

  async configureMailRental(runId, options = {}) {
    const id = String(runId || '').trim();
    const active = this.activeRun(id);
    const stateFile = active ? active.stateFile : this.findStateFile(id);
    const state = active ? active.state : loadV2State(stateFile);
    const plan = state.runPlan || state.plan || {};
    // Both modes, not only the broker. An ordinary rental run holds the same
    // paid mailboxes and has the same two questions — rent more, or stop —
    // and refusing it here was the last place the two modes still diverged.
    if (String(plan.mailProvider || '').toLowerCase() !== 'smsbower') {
      throw new HttpError(409, 'This run does not rent mailboxes', { code: 'MAIL_RENTAL_NOT_ENABLED' });
    }
    const watch = plan.mailRentalWatch === true;
    if (TERMINAL_RUN_STATUSES.has(String(state.status || '').toLowerCase())) {
      throw new HttpError(409, 'A finished run cannot change its mailbox rental target', { code: 'MAIL_RENTAL_RUN_FINISHED' });
    }

    const invalid = (code, message) => {
      throw new HttpError(400, message, { code });
    };
    const asInteger = (value, fallback, minimum, maximum, code, label) => {
      const number = value === undefined || value === null || value === '' ? fallback : Number(value);
      if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
        invalid(code, `${label} must be an integer between ${minimum} and ${maximum}`);
      }
      return number;
    };
    const current = state.mailRentalWatch && typeof state.mailRentalWatch === 'object'
      ? state.mailRentalWatch
      : {};
    const claimedCount = Math.max(
      Number(current.claimedCount || 0),
      (state.mailboxes || []).filter((mailbox) => mailbox?.rented === true).length,
    );
    const currentTarget = Math.max(
      claimedCount,
      watch
        ? Number(current.target || plan.mailRentalTarget || plan.mailCount || 1)
        : Number(plan.mailCount || 1),
    );
    if (!Number.isSafeInteger(currentTarget) || currentTarget < 1 || currentTarget > MAX_RENTAL_WATCH_TARGET) {
      invalid('MAIL_RENTAL_TARGET_INVALID', `Current mailbox target must be an integer between 1 and ${MAX_RENTAL_WATCH_TARGET}`);
    }

    const hasTarget = options.target !== undefined && options.target !== null && options.target !== '';
    const additional = asInteger(
      options.additional,
      0,
      0,
      MAX_RENTAL_WATCH_TARGET,
      'MAIL_RENTAL_ADDITIONAL_INVALID',
      'additional mailbox count',
    );
    const requestedTarget = hasTarget
      ? asInteger(options.target, currentTarget, 1, MAX_RENTAL_WATCH_TARGET, 'MAIL_RENTAL_TARGET_INVALID', 'mailbox target')
      : currentTarget + additional;
    if (!Number.isSafeInteger(requestedTarget) || requestedTarget > MAX_RENTAL_WATCH_TARGET) {
      invalid('MAIL_RENTAL_TARGET_TOO_LARGE', `Mailbox target cannot exceed ${MAX_RENTAL_WATCH_TARGET}`);
    }
    if (requestedTarget < currentTarget) {
      invalid('MAIL_RENTAL_TARGET_DECREASE_NOT_ALLOWED', 'A running mailbox target can only be increased');
    }
    const targetIncrease = requestedTarget - currentTarget;
    // Batch size and polling belong to the broker. An ordinary rental has no
    // poll loop to configure, so the values are read but never applied.
    const batchSize = asInteger(
      watch ? options.batchSize : undefined,
      Number(current.batchSize || plan.mailRentalBatchSize || 20),
      1,
      20,
      'MAIL_RENTAL_BATCH_INVALID',
      'mailbox batch size',
    );
    const pollIntervalMs = asInteger(
      watch ? options.pollIntervalMs : undefined,
      Number(current.pollIntervalMs || plan.mailRentalPollIntervalMs || 20_000),
      MIN_RENTAL_WATCH_POLL_INTERVAL_MS,
      3_600_000,
      'MAIL_RENTAL_POLL_INTERVAL_INVALID',
      'mailbox poll interval',
    );
    const action = String(options.action || 'keep').trim().toLowerCase();
    if (!['keep', 'stop', 'continue'].includes(action)) {
      invalid('MAIL_RENTAL_ACTION_INVALID', 'Mailbox rental action must be keep, stop, or continue');
    }
    if (action === 'stop' && targetIncrease > 0) {
      invalid('MAIL_RENTAL_STOP_WITH_INCREASE', 'Adding mailboxes and stopping future claims cannot be combined');
    }

    const at = new Date(this.now()).toISOString();
    const continuing = action === 'continue' || targetIncrease > 0;
    // `keep` keeps whatever the run was doing, including a stop. The broker
    // records one on itself; an ordinary rental has only the shared marker.
    const alreadyStopped = Boolean(String(state.mailRentalStoppedAt || '').trim()) || current.stopRequested === true;
    const stopRequested = action === 'stop'
      ? true
      : (continuing ? false : alreadyStopped);
    const autoStopped = !stopRequested && claimedCount >= requestedTarget
      ? true
      : (continuing ? false : (action === 'stop' ? false : current.autoStopped === true));
    const hasOutstandingTarget = !stopRequested && !autoStopped && claimedCount < requestedTarget;
    // Stopping future rentals settles how big this task is. It will never
    // claim another mailbox, so what it holds is what it is going to produce,
    // and the target has to say so: leaving it where it was left 任务进度
    // counting toward a number the run had just promised never to reach —
    // 61/200 for the rest of its life, the bar frozen near a third while the
    // work actually finished. Adding mailboxes and stopping cannot be combined,
    // so this only ever narrows a target the operator has abandoned.
    const effectiveTarget = stopRequested && claimedCount > 0
      ? Math.min(requestedTarget, claimedCount)
      : requestedTarget;
    const nextPollAt = hasOutstandingTarget
      ? new Date(this.now() + (continuing || targetIncrease > 0 ? 0 : pollIntervalMs)).toISOString()
      : '';

    state.runPlan = plan;
    plan.mailCount = effectiveTarget;
    plan.totalAccounts = effectiveTarget * Math.max(1, Number(plan.aliasCount || 1));
    // The shared stop, read by both modes when deciding whether to rent more.
    state.mailRentalStoppedAt = stopRequested ? String(state.mailRentalStoppedAt || at) : '';
    if (watch) {
      plan.mailRentalTarget = effectiveTarget;
      plan.mailRentalBatchSize = batchSize;
      plan.mailRentalPollIntervalMs = pollIntervalMs;
      state.mailRentalWatch = {
        ...current,
        enabled: true,
        target: effectiveTarget,
        batchSize,
        pollIntervalMs,
        claimedCount,
        stopRequested,
        autoStopped,
        stoppedAt: stopRequested || autoStopped ? String(current.stoppedAt || at) : '',
        nextPollAt,
        lastError: continuing ? null : (current.lastError || null),
      };
    } else if (continuing) {
      // Raising an ordinary rental's target clears the backoff so the next
      // scheduler pass rents instead of waiting out a sold-out retry.
      state.mailRentalRetry = null;
    }
    // Changing the live target changes `mail.count` in the effective run
    // configuration. Persist the new fingerprint with the same update so the
    // next resume sees an intentional task change rather than config drift.
    state.configFingerprint = configFingerprint(this.configForState(state));
    state.updatedAt = at;
    state.normalWait = {
      code: watch ? 'MAIL_RENTAL_WATCH' : 'MAIL_RENTAL',
      message: stopRequested
        ? (claimedCount > 0
          ? `Future mailbox rentals are stopped; the ${claimedCount} already rented will finish the task`
          : 'Future mailbox rentals are stopped; already rented mailboxes will continue')
        : (hasOutstandingTarget
          ? (watch
            ? `Mailbox target is ${requestedTarget}; next stock poll at ${nextPollAt}`
            : `Mailbox target is ${requestedTarget}; the run keeps renting as Workers free up`)
          : 'Mailbox rental target has been reached'),
      at,
      nextRunAt: watch ? nextPollAt : '',
    };

    const log = {
      source: 'operator',
      type: watch ? 'mail_rental_watch_configured' : 'mail_rental_configured',
      action,
      added: targetIncrease,
      target: effectiveTarget,
      batchSize,
      pollIntervalMs,
      stopRequested,
      message: targetIncrease
        ? `Added ${targetIncrease} mailbox rental slot(s); target is now ${requestedTarget}`
        : (stopRequested
          ? (claimedCount > 0
            ? `Stopped future mailbox rentals; target narrowed to the ${effectiveTarget} already claimed`
            : 'Stopped future mailbox rentals')
          : (watch ? 'Updated mailbox rental polling configuration' : 'Resumed mailbox rentals')),
    };
    if (active) {
      await saveV2StateWithRetry(active.stateFile, state);
      // Persist the stop before waking the scheduler so a waiting poll cannot
      // observe and checkpoint the pre-stop state first.
      active.gate.wake?.();
      this.logStore.append(id, log);
      return this.get(id);
    }
    const lock = acquireStateLock(stateFile, { command: 'ui-configure-mail-rental', runId: id });
    try {
      await saveV2StateWithRetry(stateFile, state);
      this.logStore.append(id, log);
      return this.summary(state);
    } finally {
      lock.release();
    }
  }

  async stopMailRental(runId) {
    return this.configureMailRental(runId, { action: 'stop' });
  }

  async pause(runId) {
    return this.requestControl(runId, 'pause');
  }

  async cancel(runId, reason = 'Cancelled from UI', cancelOptions = {}) {
    if (this.activeRun(runId)) return this.requestControl(runId, 'cancel');
    const stateFile = this.findStateFile(runId);
    const state = loadV2State(stateFile);
    const config = this.configForState(state);
    const lock = acquireStateLock(stateFile, { command: 'ui-cancel', runId });
    try {
      const options = {
        reason,
        resolveSmsAcquisition: cancelOptions.resolveSmsAcquisition,
        proxyEntries: this.proxyEntriesForState(state, config),
        saveState: (next) => saveV2StateWithRetry(stateFile, next),
      };
      if (BRANCH_TASK_KINDS.has(state.taskKind)) {
        await cancelBranchState(state, config, { ...options, assetStore: this.sessionAssets() });
      } else {
        await cancelOrchestratorV2(state, config, options);
      }
      if (TERMINAL_RUN_STATUSES.has(state.status)) {
        // A paused/waiting run can lose its active RunManager entry before an
        // operator cancels it. That synchronous cancellation path still has
        // to perform the same final balance read as execute().
        await this.finalizeBalanceReconciliation({ state, stateFile, config });
      }
      this.logStore.append(runId, {
        source: 'operator',
        type: state.status === 'cancelled'
          ? (state.externalCleanup?.length ? 'run_cancelled_external_cleanup' : 'run_cancelled')
          : 'run_cancel_cleanup_pending',
        message: state.status === 'cancelled' ? reason : '取消已记录，仍有资源清理需要重试',
      });
      if (TERMINAL_RUN_STATUSES.has(state.status)) this.appendTerminalSummary(state);
      if (BRANCH_TASK_KINDS.has(state.taskKind) && resourceCleanupPendingState(state)) {
        this.scheduleResourceCleanupRetry(state.runId, state);
      } else {
        this.clearCleanupRetry(state.runId);
      }
      return this.summary(state);
    } finally {
      lock.release();
    }
  }

  async resume(runId, options = {}) {
    const stateFile = this.findStateFile(runId);
    const state = loadV2State(stateFile);
    if (this.activeRun(runId)) throw new HttpError(409, 'Run is already active');
    const requestedJobIds = normalizeRequestedJobIds(
      options.jobIds !== undefined ? options.jobIds : options.jobId,
    );
    const requestedJobId = requestedJobIds.length === 1 ? requestedJobIds[0] : '';
    if (requestedJobIds.length > 1 && !BRANCH_TASK_KINDS.has(state.taskKind)) {
      throw new HttpError(400, 'Batch job retry is only supported for branch tasks', { code: 'BATCH_JOB_RETRY_UNSUPPORTED' });
    }
    this.clearCleanupRetry(runId);
    const slot = taskSlotOf(state);
    const recoverableBranchFailure = BRANCH_TASK_KINDS.has(state.taskKind) && canResumeBranchState(state);
    if (TERMINAL_RUN_STATUSES.has(state.status) && !recoverableBranchFailure) {
      throw new HttpError(409, `任务已处于终态，无法恢复：${state.status}`, {
        code: 'TERMINAL_RUN',
        status: state.status,
      });
    }
    const startingToken = this.reserveStartingSlot(slot, runId);
    try {
      const previousPlan = state.runPlan ? { ...state.runPlan } : null;
      const previousConfig = previousPlan
        ? (() => {
          try {
            return validateV2Config(
              applyRunPlan(this.config(), previousPlan),
              { cwd: this.cwd },
            );
          } catch { return null; }
        })()
        : null;
      const providerBeforeRepair = String(previousPlan?.mailProvider || '').toLowerCase();
      try {
        this.bindStateMailProvider(state);
      } catch (error) {
        throw preflightHttpError(error);
      }
      const providerBindingChanged = providerBeforeRepair
        !== String(state.runPlan?.mailProvider || '').toLowerCase();
      const config = this.configForState(state);
      const currentFingerprint = configFingerprint(config);
      const proxyRecovery = proxyRecoveryWaitDetails(state);
      const acceptsProxyRecoveryConfigDrift = options.refreshProxySnapshot === true
        && ['waiting', 'paused'].includes(String(state.status || '').toLowerCase())
        && Boolean(proxyRecovery);
      // A legacy task may have captured the active global provider instead of
      // the provider that owns its selected asset. Accept exactly that repair
      // when the rest of the current config still reconstructs the checkpoint;
      // unrelated config drift remains blocked by the normal fingerprint gate.
      const providerRepairAccepted = Boolean(
        providerBindingChanged
        && previousConfig
        && configFingerprint(previousConfig) === state.configFingerprint,
      );
      const baselinePlan = mailRentalBaselinePlan(state);
      const acceptsMailRentalConfigDrift = Boolean(
        state.configFingerprint !== currentFingerprint
        && state.mailRentalWatch?.enabled === true
        && String(state.runPlan?.mailProvider || '').toLowerCase() === 'smsbower'
        && ['register_oauth', 'register_session'].includes(String(state.taskKind || ''))
        && ['waiting', 'paused'].includes(String(state.status || '').toLowerCase())
        && baselinePlan
        && isDeepStrictEqual(
          planWithoutMailRentalControls(state.runPlan),
          planWithoutMailRentalControls(baselinePlan),
        )
        && (() => {
          try {
            const baselineConfig = validateV2Config(
              applyRunPlan(this.config(), baselinePlan),
              { cwd: this.cwd },
            );
            return configFingerprint(baselineConfig) === state.configFingerprint;
          } catch { return false; }
        })(),
      );
      const configDriftAccepted = state.configFingerprint !== currentFingerprint
        && (acceptsProxyRecoveryConfigDrift || providerRepairAccepted || acceptsMailRentalConfigDrift);
      if (state.configFingerprint !== currentFingerprint && !configDriftAccepted) {
        throw new HttpError(409, 'Current config does not match this run');
      }
      if (options.refreshProxySnapshot === true) {
        state.proxyResourceSnapshot = this.proxySnapshot(state.runPlan || {});
      }
      if (configDriftAccepted) state.configFingerprint = currentFingerprint;
      const migrated = canMigrateLegacyRegisterOAuthState(state);
      if (migrated) migrateLegacyRegisterOAuthState(state);
      if (BRANCH_TASK_KINDS.has(state.taskKind)) {
        resumeBranchState(state, {
          ...(requestedJobIds.length ? { jobIds: requestedJobIds } : {}),
          resolveSmsAcquisition: options.resolveSmsAcquisition,
          assetStore: this.sessionAssets(),
          now: this.now,
        });
      } else {
        resumeOrchestratorV2State(state, {
          jobId: requestedJobId || undefined,
          effectResolution: options.resolveEffect,
        });
      }
      await saveV2StateWithRetry(stateFile, state);
      this.logStore.append(runId, {
        source: 'operator',
        type: migrated ? 'legacy_register_oauth_migrated' : 'resume_requested',
        message: '已从持久化检查点请求继续执行',
        details: {
          jobId: requestedJobId,
          ...(requestedJobIds.length ? { jobIds: requestedJobIds } : {}),
          status: state.status,
          resumedAt: state.control?.resumedAt || '',
          migrated,
          ...(acceptsProxyRecoveryConfigDrift ? {
            proxyRecoveryConfigDriftAccepted: true,
            proxyRecoveryReason: proxyRecovery?.reason || '',
            proxyRecoveryCode: proxyRecovery?.code || '',
          } : {}),
          ...(providerRepairAccepted ? {
            sessionAssetMailProviderRepaired: true,
            previousMailProvider: providerBeforeRepair,
            mailProvider: state.runPlan?.mailProvider || '',
          } : {}),
          ...(acceptsMailRentalConfigDrift ? {
            mailRentalConfigDriftAccepted: true,
            reason: 'legacy_live_mail_rental_controls',
          } : {}),
        },
      });
      this.launch(state, stateFile, config, null, { startingToken });
      return this.get(runId);
    } finally {
      this.releaseStartingSlot(startingToken);
    }
  }

  async skip(runId, jobId, reason = 'Skipped from UI') {
    if (this.activeRun(runId)) throw new HttpError(409, 'Pause the run before skipping an alias');
    const stateFile = this.findStateFile(runId);
    const state = loadV2State(stateFile);
    const config = this.configForState(state);
    const job = (state.jobs || []).find((candidate) => candidate.id === jobId);
    if (!job) throw new HttpError(404, `Job not found: ${jobId}`, { code: 'JOB_NOT_FOUND' });
    const lifecycleKind = BRANCH_TASK_KINDS.has(state.taskKind) ? 'branch' : 'orchestrator-v2';
    if (isTerminalJobStatus(job.status, lifecycleKind)) {
      throw new HttpError(409, `Job is already terminal: ${job.status}`, { code: 'JOB_TERMINAL' });
    }
    const lock = acquireStateLock(stateFile, { command: 'ui-skip', runId });
    try {
      const skipOptions = {
        reason,
        proxyEntries: this.proxyEntriesForState(state, config),
        saveState: (next) => saveV2StateWithRetry(stateFile, next),
        assetStore: this.sessionAssets(),
      };
      if (BRANCH_TASK_KINDS.has(state.taskKind)) {
        await skipBranchJob(state, config, jobId, skipOptions);
      } else {
        await skipAliasV2(state, config, jobId, skipOptions);
      }
      this.logStore.append(runId, { source: 'operator', type: 'alias_skipped', jobId, message: reason });
      return this.summary(state);
    } finally {
      lock.release();
    }
  }

  /**
   * Note when retention drops an artifact a stored asset still points at.
   *
   * The protection rule is "referenced by a run that has not finished", not
   * "referenced by the asset library", so an asset sitting in the library can
   * lose the file its credentials live in once the artifact count passes the
   * cap. That behaviour is unchanged here by decision; this only makes it
   * traceable after the fact instead of silent.
   */
  warnOnReferencedArtifactRemoval(artifact) {
    const assetId = String(artifact?.assetId || '');
    if (!assetId) return;
    try {
      const asset = this.sessionAssets().get(assetId, { raw: false });
      if (!asset?.cpa) return;
      this.logStore?.append?.(String(artifact.runId || 'run-manager'), {
        level: 'warn',
        source: 'run-manager',
        type: 'cpa_artifact_pruned_while_referenced',
        message: `按保留上限清理的 CPA 产物仍被登录态资产 ${assetId} 引用`,
        details: { assetId, runId: String(artifact.runId || ''), path: String(artifact.path || '') },
      });
    } catch { /* Best effort; never block retention. */ }
  }

  removeCpaArtifactRecord(artifact) {
    if (artifact?.assetId) {
      try { this.sessionAssets().update(artifact.assetId, { cpa: null }); } catch { /* Keep pruning file history best-effort. */ }
    }
    try {
      fs.unlinkSync(artifact.filePath);
      // The scan behind every listing is cached; a file this process just
      // removed has to leave it now rather than when the watch gets around to
      // reporting it.
      this.invalidateCpaArtifactScan();
      return true;
    } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  removeRetainedRun(entry, artifacts = []) {
    const uniqueArtifacts = new Map();
    for (const artifact of artifacts) {
      const key = path.resolve(artifact.filePath).toLowerCase();
      uniqueArtifacts.set(key, artifact);
    }
    for (const artifact of uniqueArtifacts.values()) {
      if (artifact.locked === true) continue;
      this.removeCpaArtifactRecord(artifact);
    }
    for (const file of [entry.file, `${entry.file}.bak`, `${entry.file}.lock`]) {
      try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    this.stateCache?.delete(entry.file);
    try { this.logStore?.remove?.(entry.state.runId); } catch { /* History pruning must not affect the live task loop. */ }
  }

  /**
   * Remove `<cpaDir>/<runId>/` trees whose run state is long gone.
   *
   * The orchestrator writes a per-run `manifest.json` and an `accounts/`
   * directory there, but every deletion path — retention, explicit run removal,
   * artifact removal — works on files it can name from a run's state. Once the
   * state is pruned the directory becomes unreachable and stays forever; a
   * month-old store here held fourteen of them.
   *
   * Only directories older than the grace period are considered, so a run that
   * has written its manifest but not yet registered its state is safe.
   */
  collectOrphanOutputDirectories(graceMs = ORPHAN_OUTPUT_GRACE_MS) {
    const root = this.cpaDirectory();
    let names = [];
    try { names = fs.readdirSync(root, { withFileTypes: true }); } catch { return 0; }
    const liveRunIds = new Set();
    for (const file of this.stateFiles()) {
      const match = path.basename(file).match(/^run-(.+)\.json$/i);
      if (match) liveRunIds.add(match[1]);
    }
    for (const runId of this.activeRunIds()) liveRunIds.add(String(runId));
    for (const key of Object.keys(this.readCpaLockRegistry().entries)) {
      const [runId] = String(key || '').replace(/\\/g, '/').split('/');
      if (runId && runId !== 'session-assets') liveRunIds.add(runId);
    }
    const cutoff = this.now() - graceMs;
    let removed = 0;
    for (const entry of names) {
      if (!entry.isDirectory()) continue;
      // `session-assets/` holds the canonical per-asset CPA files, which belong
      // to assets rather than to runs.
      if (entry.name === 'session-assets') continue;
      if (liveRunIds.has(entry.name)) continue;
      const directory = path.join(root, entry.name);
      try {
        if (fs.statSync(directory).mtimeMs >= cutoff) continue;
        fs.rmSync(directory, { recursive: true, force: true });
        removed += 1;
      } catch { /* A directory that will not delete is left for the next sweep. */ }
    }
    if (removed) this.invalidateCpaArtifactScan();
    return removed;
  }

  /**
   * Remove abandoned atomic-write scratch files.
   *
   * `stateFiles()` matches `run-*.json`, so a crashed atomic write leaves
   * `run-<id>.json.<pid>.<hex>.tmp` invisible to every sweep — one such file
   * here was 1.7 MB and four months old.
   */
  collectAbandonedStateScratch(graceMs = ORPHAN_OUTPUT_GRACE_MS) {
    const directory = this.stateDirectory();
    let names = [];
    try { names = fs.readdirSync(directory); } catch { return 0; }
    const cutoff = this.now() - graceMs;
    let removed = 0;
    for (const name of names) {
      if (!name.endsWith('.tmp')) continue;
      const file = path.join(directory, name);
      try {
        if (fs.statSync(file).mtimeMs >= cutoff) continue;
        fs.unlinkSync(file);
        removed += 1;
      } catch { /* Left for the next sweep. */ }
    }
    return removed;
  }

  pruneCpaArtifactHistory(preloadedRecords = null) {
    const records = preloadedRecords || this.cpaArtifactRecords();
    const activeRunIds = new Set(this.activeRunIds());
    let inUse = new Set();
    try { inUse = this.sessionAssetIdsInUse(); } catch { /* Active-run protection below still applies. */ }
    const protectedRecords = records.filter((artifact) => (
      activeRunIds.has(String(artifact.runId || ''))
      || artifact.locked === true
      || artifact.deletable !== true
      || (artifact.assetId && inUse.has(String(artifact.assetId)))
    ));
    const protectedSet = new Set(protectedRecords);
    const eligible = records
      .filter((artifact) => !protectedSet.has(artifact))
      .sort(newestArtifactFirst);
    const stale = eligible.slice(MAX_RETAINED_CPA_ARTIFACTS);
    for (const artifact of stale) {
      // The count cap is the one path that can take a file a library asset
      // still depends on. Leave a trace before it goes.
      this.warnOnReferencedArtifactRemoval(artifact);
      this.removeCpaArtifactRecord(artifact);
    }

    // Export markers are a second, easy-to-miss source of unbounded history.
    // Reconcile them against the files that still exist after pruning.
    // Each listing stats every CPA file in the store; only list again when
    // something was actually removed.
    const remaining = stale.length ? this.cpaArtifactRecords() : records;
    this.markCpaExports([], remaining);
    this.markSub2ApiExports([], remaining);
    this.markSub2ApiPushes([], remaining);
    for (const kind of ['nvtokens_cards', 'nvtokens_mailboxes', 'nvtokens_pool']) {
      this.markNvtokensPushes(kind, [], remaining);
    }
    return stale.length;
  }

  pruneRetainedHistory() {
    // Retention scans thousands of files. A boot timer or a finished auxiliary
    // task must not block another task's live network requests with this pass.
    // The last executing task retries retention in its finally block.
    if (this.historyPruneInProgress || this.starting || this.auxiliaryStarting || this.activeRuns().length) {
      return { runsRemoved: 0, artifactsRemoved: 0 };
    }
    this.historyPruneInProgress = true;
    let runsRemoved = 0;
    let artifactsRemoved = 0;
    try {
      const activeRunIds = new Set(this.activeRunIds());
      let inUse = new Set();
      try { inUse = this.sessionAssetIdsInUse(); } catch { /* Keep terminal history cleanup available. */ }
      const entries = [];
      for (const file of this.stateFiles()) {
        try { entries.push({ file, state: this.cachedState(file) }); } catch { /* Leave corrupt history for manual inspection. */ }
      }
      const terminal = entries.filter((entry) => {
        const status = String(entry.state.status || '').toLowerCase();
        if (!TERMINAL_RUN_STATUSES.has(status)) return false;
        if (activeRunIds.has(String(entry.state.runId || ''))) return false;
        if (BRANCH_TASK_KINDS.has(entry.state.taskKind) && canResumeBranchState(entry.state)) return false;
        const ownedIds = [
          ...(entry.state.runPlan?.oauthSource?.assetIds || []),
          ...(entry.state.jobs || []).flatMap((job) => [job?.assetId, job?.sessionAssetId]),
        ].map((id) => String(id || '').trim()).filter(Boolean);
        return !ownedIds.some((id) => inUse.has(id));
      }).sort(newestStateFirst);
      const retainedRunIds = new Set(terminal.slice(0, MAX_RETAINED_HISTORY).map((entry) => String(entry.state.runId || '')));
      const artifactsByRun = new Map();
      const artifactRecords = this.cpaArtifactRecords();
      for (const artifact of artifactRecords) {
        const key = String(artifact.runId || '');
        const list = artifactsByRun.get(key) || [];
        list.push(artifact);
        artifactsByRun.set(key, list);
      }
      for (const entry of terminal) {
        const runId = String(entry.state.runId || '');
        if (retainedRunIds.has(runId)) continue;
        this.removeRetainedRun(entry, artifactsByRun.get(runId) || []);
        runsRemoved += 1;
      }
      // Nothing was removed since the listing above, so the artifact pass can
      // reuse it rather than stat every CPA file again.
      artifactsRemoved = this.pruneCpaArtifactHistory(runsRemoved ? null : artifactRecords);
      // Retention decides what to keep; these two only reclaim things nothing
      // can reach any more, and neither consults the retention cap.
      const orphansRemoved = this.collectOrphanOutputDirectories();
      const scratchRemoved = this.collectAbandonedStateScratch();
      return { runsRemoved, artifactsRemoved, orphansRemoved, scratchRemoved };
    } catch {
      return { runsRemoved, artifactsRemoved };
    } finally {
      this.historyPruneInProgress = false;
    }
  }

  cpaFile(job) {
    if (!job?.cpaPath) return '';
    return resolveInside(this.cpaDirectory(), job.cpaPath);
  }

  /**
   * The retained CPA records, stamped with what has already been delivered.
   *
   * Answers from the listing cache: callers include every export, push, lock
   * and delete path, all of which used to pay for a fresh scan of the whole
   * store before they could resolve a handful of selected rows.
   */
  cpaArtifactRecords(options = {}) {
    return this.cpaArtifactListing(options.includeLocked !== false).records;
  }

  cpaArtifactScan(options = {}) {
    // The history page opens on the unhandled set. Locked batches are durable
    // snapshots for audit, but they are not part of that first view and can be
    // very numerous. Keep their registry keys for collision checks while
    // avoiding snapshot construction and source-file stats until the caller
    // explicitly asks for locked records.
    const includeLocked = options.includeLocked !== false;
    const activeRunIds = new Set(this.activeRunIds());
    const states = new Map();
    const records = new Map();
    const lockRegistry = this.readCpaLockRegistry();
    const lockedEntries = new Map();
    const lockedSnapshots = new Map();
    for (const [rawKey, entry] of Object.entries(lockRegistry.entries)) {
      const key = String(rawKey || '').replace(/\\/g, '/').toLowerCase();
      if (!key) continue;
      lockedEntries.set(key, entry);
      if (!includeLocked) continue;
      const locked = this.cpaLockedArtifactFromEntry(key, entry);
      if (locked) lockedSnapshots.set(key, { ...entry, artifact: locked });
    }
    // `runStatus` is the API's historical field name for the status shown on a
    // CPA card. The artifact is a per-job result, so prefer its persisted
    // completion status, then the job checkpoint, and only use the parent run
    // status for legacy artifacts that carry neither.
    const artifactStatus = (asset, job, fallback) => String(
      asset?.cpa?.completionStatus || job?.status || fallback || 'complete',
    ).trim() || 'complete';
    const add = (record) => {
      const key = path.resolve(record.filePath).toLowerCase();
      const lockedEntry = lockedEntries.get(this.cpaExportKey(record));
      if (!record.locked && lockedEntry?.version === this.cpaArtifactVersion(record)) return;
      const current = records.get(key);
      if (current && Number(current._revision || 0) > Number(record._revision || 0)) return;
      records.set(key, record);
    };
    if (includeLocked) {
      for (const [key, entry] of lockedSnapshots) {
        add({ ...entry.artifact, locked: true });
      }
    }
    const lockedPathMatches = (filePath, revision = 0) => {
      const key = this.cpaExportKey({ filePath });
      if (!lockedEntries.has(key)) return false;
      const entry = lockedEntries.get(key);
      if (!includeLocked) {
        // A refreshed session asset keeps its path but increments its CPA
        // revision. Keep that new version visible without statting a source
        // file whose locked revision is still immutable.
        if (!entry?.artifact || typeof entry.artifact !== 'object' || Array.isArray(entry.artifact)) return true;
        const currentRevision = Number(revision || 0);
        if (currentRevision <= 0) return true;
        return Number(entry.artifact._revision || 0) === currentRevision;
      }
      const snapshot = lockedSnapshots.get(key);
      if (!snapshot) return true;
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) return true;
        return `${stat.size}:${stat.mtime.toISOString()}:${Number(revision || 0)}` === snapshot.version;
      } catch (error) {
        // A locked snapshot remains displayable after its source file or run
        // history has been removed. Do not touch the missing file again.
        return true;
      }
    };
    // Sale lifecycle lives on the login-state asset; a CPA file inherits it by
    // the account it belongs to. Indexed by both asset id and address so files
    // recovered from disk (which carry no asset id) still resolve by email.
    const assetStore = this.sessionAssets();
    const assets = assetStore.cpaEntries();
    const assetsById = new Map(assets.map((asset) => [String(asset?.id || ''), asset]));
    const lifecycleByAssetId = new Map();
    const lifecycleByEmail = new Map();
    for (const asset of assets) {
      const lifecycle = String(asset?.lifecycle || '');
      if (!lifecycle) continue;
      if (asset.id) lifecycleByAssetId.set(String(asset.id), lifecycle);
      const email = String(asset?.email || '').trim().toLowerCase();
      if (email && !lifecycleByEmail.has(email)) lifecycleByEmail.set(email, lifecycle);
    }
    const lifecycleFor = (assetId, email) => lifecycleByAssetId.get(String(assetId || ''))
      || lifecycleByEmail.get(String(email || '').trim().toLowerCase())
      || '';
    const stateFilesForArtifacts = this.stateFiles();
    this.pruneStateCache(stateFilesForArtifacts);
    for (const stateFile of stateFilesForArtifacts) {
      let state;
      // Read-only scan; nothing below writes to `state`.
      try { state = this.cachedState(stateFile); } catch { continue; }
      states.set(state.runId, state);
      for (const job of state.jobs || []) {
        if (!job.cpaPath) continue;
        let asset = null;
        if (job.assetId && job.cpaRevision) {
          asset = assetsById.get(String(job.assetId || '')) || null;
          if (!asset || (
            Number(asset.cpa?.revision || 0) !== Number(job.cpaRevision)
            || asset.cpa?.runId !== state.runId
            || asset.cpa?.jobId !== job.id
          )) continue;
        }
        let filePath;
        try {
          filePath = asset?.cpa?.path
            ? resolveInside(this.cpaDirectory(), asset.cpa.path)
            : this.cpaFile(job);
        } catch { continue; }
        if (lockedPathMatches(filePath, job.cpaRevision)) continue;
        if (!fs.existsSync(filePath)) continue;
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        const jobEmail = String(job.email || '');
        // The root this alias belongs to, so a card can answer "which mailbox"
        // as well as "which address". Empty — or the address itself — means
        // there is no parent: the `root` alias strategy and the remote-address
        // mail channels register the mailbox directly.
        const jobParentEmail = String(job.parentEmail || '');
        const hasParentMailbox = Boolean(jobParentEmail)
          && jobParentEmail.toLowerCase() !== jobEmail.toLowerCase();
        add({
          runId: state.runId,
          jobId: job.id,
          // A standalone OAuth job reuses an existing account, and a `root`
          // registration *is* its mailbox. Both inherit aliasIndex=1 from the
          // registration default, and neither may make its CPA look like a
          // child mailbox: the index only means something under a distinct root.
          aliasIndex: taskKindOf(state) === 'oauth' || !hasParentMailbox
            ? 0
            : Number(job.aliasIndex || 0),
          email: jobEmail,
          parentEmail: jobParentEmail,
          lifecycle: lifecycleFor(asset?.id, job.email),
          fileName: path.basename(filePath),
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          runStatus: artifactStatus(asset, job, state.status),
          deletable: cpaArtifactDeletable(state.runId, state, activeRunIds),
          assetId: asset?.id || '',
          superseded: false,
          isPlus: asset?.isPlus === true,
          registrationCountry: String(asset?.registrationCountry || ''),
          _revision: Number(job.cpaRevision || 0),
          filePath,
        });
      }
    }

    for (const asset of assets) {
      if (!asset.cpa?.path) continue;
      let filePath;
      try { filePath = resolveInside(this.cpaDirectory(), asset.cpa.path); } catch { continue; }
      if (lockedPathMatches(filePath, asset.cpa.revision)) continue;
      if (records.has(path.resolve(filePath).toLowerCase())) continue;
      // One `stat` rather than an `existsSync` plus two more: this runs once
      // per asset in the store, and a missing file is the same "skip" either
      // way.
      let stat;
      try { stat = fs.statSync(filePath); } catch { continue; }
      if (!stat.isFile()) continue;
      const runState = states.get(asset.cpa.runId);
      const runJob = Array.isArray(runState?.jobs)
        ? runState.jobs.find((candidate) => String(candidate?.id || '') === String(asset.cpa.jobId || ''))
        : null;
      add({
        runId: asset.cpa.runId || 'session-assets',
        jobId: asset.cpa.jobId || asset.id,
        aliasIndex: 0,
        email: String(asset.email || ''),
        parentEmail: String(asset.parentEmail || ''),
        lifecycle: lifecycleFor(asset.id, asset.email),
        fileName: path.basename(filePath),
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        runStatus: artifactStatus(asset, runJob, runState?.status),
        deletable: cpaArtifactDeletable(asset.cpa.runId, runState, activeRunIds),
        assetId: asset.id,
        superseded: false,
        isPlus: asset?.isPlus === true,
        registrationCountry: String(asset?.registrationCountry || ''),
        _revision: Number(asset.cpa.revision || 0),
        filePath,
      });
    }

    const sessionCpaDirectory = path.join(this.cpaDirectory(), 'session-assets');
    let retainedSessionFiles = [];
    try { retainedSessionFiles = fs.readdirSync(sessionCpaDirectory, { withFileTypes: true }); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
      for (const file of retainedSessionFiles) {
        if (!file.isFile() || !isCpaArtifactFileName(file.name)) continue;
        const filePath = path.join(sessionCpaDirectory, file.name);
        if (lockedPathMatches(filePath, 0)) continue;
        if (records.has(path.resolve(filePath).toLowerCase())) continue;
      let email = '';
      try { email = JSON.parse(fs.readFileSync(filePath, 'utf8')).email || ''; } catch { /* Keep corrupt artifacts visible for cleanup. */ }
      const stat = fs.statSync(filePath);
      add({
        runId: 'session-assets',
        jobId: path.basename(file.name, '.json'),
        aliasIndex: 0,
        email: String(email || ''),
        parentEmail: '',
        lifecycle: lifecycleFor('', email),
        fileName: file.name,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        runStatus: 'retained',
        deletable: true,
        assetId: '',
        superseded: false,
        isPlus: false,
        _revision: 0,
        filePath,
      });
    }

    const root = this.cpaDirectory();
    let runDirectories = [];
    try { runDirectories = fs.readdirSync(root, { withFileTypes: true }); } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    for (const runDirectory of runDirectories) {
      if (!runDirectory.isDirectory() || !/^[a-z0-9][a-z0-9_-]{2,79}$/i.test(runDirectory.name)) continue;
      const accountsDirectory = path.join(root, runDirectory.name, 'accounts');
      let files = [];
      try { files = fs.readdirSync(accountsDirectory, { withFileTypes: true }); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        continue;
      }
      for (const file of files) {
        if (!file.isFile() || !isCpaArtifactFileName(file.name)) continue;
        const filePath = path.join(accountsDirectory, file.name);
        if (lockedPathMatches(filePath, 0)) continue;
        if (records.has(path.resolve(filePath).toLowerCase())) continue;
        const jobId = path.basename(file.name, '.json');
        const state = states.get(runDirectory.name);
        let email = '';
        try { email = JSON.parse(fs.readFileSync(filePath, 'utf8')).email || ''; } catch { /* Keep corrupt artifacts visible for cleanup. */ }
        const stat = fs.statSync(filePath);
        const runJob = Array.isArray(state?.jobs)
          ? state.jobs.find((candidate) => String(candidate?.id || '') === jobId)
          : null;
        add({
          runId: runDirectory.name,
          jobId,
          aliasIndex: 0,
          email: String(email || ''),
          parentEmail: '',
          lifecycle: lifecycleFor('', email),
          fileName: file.name,
          size: stat.size,
          modifiedAt: stat.mtime.toISOString(),
          runStatus: artifactStatus(null, runJob, state?.status || 'archived'),
          deletable: cpaArtifactDeletable(runDirectory.name, state, activeRunIds),
          assetId: '',
          superseded: false,
          isPlus: false,
          _revision: 0,
          filePath,
        });
      }
    }
    return [...records.values()];
  }

  /**
   * The delivery stamps merged onto a scan, unsent first and newest first.
   *
   * Ledger-only and cheap, so an export that writes a ledger re-runs just this
   * pass rather than dragging the filesystem scan behind it.
   */
  cpaArtifactStampedRecords(all) {
    let registries = {
      sub2api: this.readSub2ApiExportRegistry().entries,
      cpa: this.readCpaExportRegistry().entries,
      push: this.readSub2ApiPushRegistry().entries,
      nvtokens: this.readNvtokensPushRegistry().entries,
    };
    if (this.reconcilePushedExports(all, registries)) {
      registries = {
        sub2api: this.readSub2ApiExportRegistry().entries,
        cpa: this.readCpaExportRegistry().entries,
        push: registries.push,
        nvtokens: this.readNvtokensPushRegistry().entries,
      };
    }
    const {
      sub2api: sub2ApiExportRegistry,
      cpa: cpaExportRegistry,
      push: sub2ApiPushRegistry,
      nvtokens: nvtokensPushRegistry,
    } = registries;
    return all
      .map((artifact) => {
        const key = this.cpaExportKey(artifact);
        const version = this.cpaArtifactVersion(artifact);
        const sub2ApiMarker = sub2ApiExportRegistry[key];
        const cpaMarker = cpaExportRegistry[key];
        const pushMarker = sub2ApiPushRegistry[key];
        const nvtokensMarker = nvtokensPushRegistry[key];
        return {
          ...artifact,
          ...(sub2ApiMarker?.version === version && typeof sub2ApiMarker.exportedAt === 'string' ? { sub2ApiExportedAt: sub2ApiMarker.exportedAt } : {}),
          ...(cpaMarker?.version === version && typeof cpaMarker.exportedAt === 'string' ? { cpaExportedAt: cpaMarker.exportedAt } : {}),
          ...(pushMarker?.version === version && typeof pushMarker.pushedAt === 'string' ? { sub2ApiPushedAt: pushMarker.pushedAt } : {}),
          ...(nvtokensMarker?.version === version && typeof nvtokensMarker.cardsImportedAt === 'string' ? { nvtokensCardsImportedAt: nvtokensMarker.cardsImportedAt } : {}),
          ...(nvtokensMarker?.version === version && typeof nvtokensMarker.mailboxesImportedAt === 'string' ? { nvtokensMailboxesImportedAt: nvtokensMarker.mailboxesImportedAt } : {}),
          ...(nvtokensMarker?.version === version && typeof nvtokensMarker.cardsPooledAt === 'string' ? { nvtokensCardsPooledAt: nvtokensMarker.cardsPooledAt } : {}),
        };
      })
      // Anything that has left — downloaded either way, or pushed to the
      // gateway — sorts below what has not, so the new ones stay on top.
      .sort((left, right) => {
        const sent = (artifact) => Number(Boolean(
          artifact.cpaExportedAt
          || artifact.sub2ApiExportedAt
          || artifact.sub2ApiPushedAt
          || artifact.nvtokensCardsImportedAt
          || artifact.nvtokensMailboxesImportedAt
          || artifact.nvtokensCardsPooledAt
        ));
        return sent(left) - sent(right)
          || right.modifiedAt.localeCompare(left.modifiedAt)
          || String(left.fileName || '').localeCompare(String(right.fileName || ''));
      });
  }

  /**
   * Carry an old push forward into the export ledgers, once.
   *
   * A push now stamps all three ledgers, because credentials that reached the
   * gateway have been delivered. Pushes made before that only stamped their
   * own, so those artifacts still read as never-exported and 导出未导出 keeps
   * offering to send them again.
   *
   * Shaped like the store's other read-time reconciles: it computes what is
   * missing and writes only when there is something to write. That latch is
   * load-bearing — this runs on every listing, which the console polls every
   * few seconds, and an unconditional rewrite would fsync both ledgers on a
   * loop forever.
   *
   * Only a push marker matching the artifact's *current* version counts, so a
   * CPA regenerated since its push is left alone and correctly reads as new.
   */
  reconcilePushedExports(records, registries) {
    const pending = records.filter((artifact) => {
      const key = this.cpaExportKey(artifact);
      const version = this.cpaArtifactVersion(artifact);
      const push = registries.push[key];
      if (push?.version !== version || typeof push.pushedAt !== 'string') return false;
      const cpa = registries.cpa[key];
      const sub2api = registries.sub2api[key];
      return cpa?.version !== version || typeof cpa.exportedAt !== 'string'
        || sub2api?.version !== version || typeof sub2api.exportedAt !== 'string';
    });
    if (!pending.length) return false;
    this.markCpaExports(pending, records);
    this.markSub2ApiExports(pending, records);
    return true;
  }

  /**
   * The CPA artifact list, masked unless the caller asks for the real
   * addresses.
   *
   * Masking used to happen where the record was built, which put a `C***@…`
   * string into every consumer — the export, the sub2api push, the delete
   * confirmation — and left the console unable to show the address even though
   * it is the only thing that identifies which account a file belongs to. The
   * records now carry the truth and this decides what leaves the process, which
   * is the same `reveal` contract the run detail and the log stream already
   * use.
   */
  startCpaArtifactWatch() {
    const root = this.cpaDirectory();
    if (this.cpaArtifactWatchRoot === root && (this.cpaArtifactWatcher || this.cpaArtifactWatchFailed)) return;
    this.closeCpaArtifactWatch();
    this.cpaArtifactWatchRoot = root;
    try {
      fs.mkdirSync(root, { recursive: true });
      const watcher = fs.watch(root, { recursive: true, persistent: false }, () => {
        this.cpaArtifactWatchVersion += 1;
      });
      watcher.on('error', () => {
        if (this.cpaArtifactWatcher !== watcher) return;
        this.cpaArtifactWatcher = null;
        this.cpaArtifactWatchFailed = true;
        this.cpaArtifactWatchVersion += 1;
        try { watcher.close(); } catch { /* Best effort; the fallback remains correct. */ }
      });
      this.cpaArtifactWatcher = watcher;
    } catch {
      // Recursive watches are unavailable on some filesystems. The listing
      // falls back to the exact file signature in that case.
      this.cpaArtifactWatchFailed = true;
    }
  }

  closeCpaArtifactWatch() {
    try { this.cpaArtifactWatcher?.close(); } catch { /* Best effort during shutdown or config changes. */ }
    this.cpaArtifactWatcher = null;
    this.cpaArtifactWatchRoot = '';
    this.cpaArtifactWatchFailed = false;
  }

  cpaArtifactFileSignature() {
    const root = this.cpaDirectory();
    const parts = [];
    const visit = (directory) => {
      let entries;
      try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return;
      }
      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const filePath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          visit(filePath);
          continue;
        }
        if (!entry.isFile() || !isCpaArtifactFileName(entry.name)) continue;
        try {
          const stat = fs.statSync(filePath);
          parts.push(`${filePath}:${stat.size}:${stat.mtimeMs}`);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
    };
    visit(root);
    return parts.join('|');
  }

  /** `size:mtime` for a set of files, as a cache signature fragment. */
  fileSignatureFor(paths) {
    return paths.map((filePath) => {
      try {
        const stat = fs.statSync(filePath);
        return `${filePath}:${stat.size}:${stat.mtimeMs}`;
      } catch (error) {
        return error.code === 'ENOENT' ? `${filePath}:missing` : `${filePath}:error`;
      }
    }).join('|');
  }

  /**
   * What the filesystem scan behind a listing depends on.
   *
   * The lock registry belongs here because locking changes which records exist
   * at all. The four delivery ledgers do not: they only decide the `…ExportedAt`
   * stamps merged on afterwards, and keeping them out is what lets an export —
   * which writes one of them — reuse the scan instead of repeating it.
   */
  cpaArtifactScanSignature(assetStore) {
    const fileSignature = this.fileSignatureFor([...this.stateFiles(), this.cpaLockRegistryPath()]);
    return `${Number(assetStore?.changeVersion || 0)}:${this.activeRunIds().join(',')}:${fileSignature}`;
  }

  /** The delivery ledgers, which decide the stamps rather than the record set. */
  cpaDeliveryLedgerSignature() {
    return this.fileSignatureFor([
      this.cpaExportRegistryPath(),
      this.sub2ApiExportRegistryPath(),
      this.sub2ApiPushRegistryPath(),
      this.nvtokensPushRegistryPath(),
    ]);
  }

  /**
   * Forget the cached scan.
   *
   * The directory watch is a hint that arrives asynchronously, so a CPA file
   * this process just wrote or unlinked is not yet reflected in its version.
   * Anything that touches those files calls this so the next read rescans
   * rather than answering from a set that no longer exists on disk.
   */
  invalidateCpaArtifactScan() {
    this.cpaArtifactWatchVersion += 1;
    this.cpaArtifactScanCache.clear();
    this.cpaArtifactListCache.clear();
  }

  /**
   * The filesystem scan behind a listing, reused while nothing on disk moved.
   *
   * Every export, push, lock and delete used to run this scan again: a 4.9 MB
   * lock registry parse, a snapshot per locked batch, a `stat` per retained CPA
   * file and a directory walk — measured on a 5,740-file store, and paid once
   * per request rather than once per change. Selections are resolved against
   * this, so the cost belongs to whatever actually changed the store.
   */
  cpaArtifactScanRecords(includeLocked = true, options = {}) {
    const assetStore = this.sessionAssets();
    this.startCpaArtifactWatch();
    const cacheKey = `${CPA_ARTIFACT_SCAN_CACHE_KEY}:${includeLocked ? 'locked' : 'unlocked'}`;
    const cached = this.cpaArtifactScanCache.get(cacheKey);
    // The watch decides *when* to re-read the CPA files, and the file signature
    // decides whether anything actually moved. Keeping those two apart matters:
    // a watch event that names a scratch file, or a caller asking to verify,
    // then costs one `stat` pass instead of a full rescan.
    const needsFileSignature = options.verify === true
      || !cached
      || this.cpaArtifactWatchFailed
      || cached.cpaWatchVersion !== this.cpaArtifactWatchVersion
      || this.now() - cached.builtAt >= CPA_ARTIFACT_LIST_MAX_AGE_MS;
    const signature = this.cpaArtifactScanSignature(assetStore);
    const fileSignature = needsFileSignature ? this.cpaArtifactFileSignature() : cached.fileSignature;
    if (cached && cached.signature === signature && cached.fileSignature === fileSignature) {
      // The files agreed with the cache, so the entry is young again and the
      // next poll can go back to the cheap check.
      if (needsFileSignature) {
        cached.builtAt = this.now();
        cached.cpaWatchVersion = this.cpaArtifactWatchVersion;
      }
      return { records: cached.records, signature: `${signature}:${fileSignature}` };
    }
    const records = this.cpaArtifactScan({ includeLocked });
    this.cpaArtifactScanCache.set(cacheKey, {
      signature,
      fileSignature,
      records,
      cpaWatchVersion: this.cpaArtifactWatchVersion,
      builtAt: this.now(),
    });
    return { records, signature: `${signature}:${fileSignature}` };
  }

  /** The cached record set behind a listing, with the signature it was built for. */
  cpaArtifactListing(includeLocked = true) {
    const cacheKey = `${CPA_ARTIFACT_LIST_CACHE_KEY}:${includeLocked ? 'locked' : 'unlocked'}`;
    const cached = this.cpaArtifactListCache.get(cacheKey);
    const ledgerSignature = this.cpaDeliveryLedgerSignature();
    // A delivery ledger that moved since the last read means something was just
    // exported or pushed — and whatever rewrote a CPA file may have moved with
    // it, which is exactly when the watch hint is least trustworthy. Verify the
    // files on that one read: it costs a `stat` pass, not a rescan.
    const verify = Boolean(cached) && cached.ledgerSignature !== ledgerSignature;
    const scan = this.cpaArtifactScanRecords(includeLocked, { verify });
    const signature = `${scan.signature}:${ledgerSignature}`;
    if (cached?.signature === signature) return { records: cached.records, signature };
    const records = this.cpaArtifactStampedRecords(scan.records);
    // Read again after stamping: `reconcilePushedExports` can carry an old push
    // into the export ledgers, which moves the ledger signature under us. Keying
    // the entry to the state the records were actually built from stops the next
    // read from repeating a merge whose result is already here.
    const builtLedgerSignature = this.cpaDeliveryLedgerSignature();
    const builtSignature = `${scan.signature}:${builtLedgerSignature}`;
    this.cpaArtifactListCache.set(cacheKey, {
      signature: builtSignature,
      ledgerSignature: builtLedgerSignature,
      records,
      payload: null,
    });
    return { records, signature: builtSignature };
  }

  /** Internal records as the API shape: no file path, no revision, masked unless revealed. */
  cpaArtifactRows(records, reveal) {
    // `key` is the row's stable, file-level identity. runId:jobId is NOT unique:
    // one job's CPA can exist at two paths (a refreshed/rebound asset moves it),
    // so selection and export must key by the file, not the pair.
    return records.map(({ filePath, _revision, ...artifact }) => {
      const withKey = { ...artifact, key: this.cpaExportKey({ filePath }) };
      return reveal
        ? withKey
        : { ...withKey, email: maskEmail(artifact.email || ''), parentEmail: maskEmail(artifact.parentEmail || '') };
    });
  }

  /**
   * Look up a selection item against the retained records.
   *
   * Prefers the file-level `key` (relative path). Falls back to runId:jobId for
   * older clients, but that pair can collapse two distinct files into one, which
   * is exactly the ambiguity `key` removes.
   */
  cpaSelectionMaps(records) {
    const byKey = new Map();
    const byPair = new Map();
    for (const artifact of records) {
      byKey.set(this.cpaExportKey(artifact), artifact);
      byPair.set(`${artifact.runId}:${artifact.jobId}`, artifact);
    }
    return { byKey, byPair };
  }

  resolveCpaItem(item, maps) {
    const key = String(item?.key || '').replace(/\\/g, '/').toLowerCase();
    if (key) {
      const artifact = maps.byKey.get(key);
      if (!artifact) throw new HttpError(404, `CPA artifact not found: ${key}`);
      return artifact;
    }
    const runId = safeRunId(item?.runId);
    const jobId = String(item?.jobId || '').trim();
    if (!isSafeCpaArtifactKey(jobId)) throw new HttpError(400, 'Invalid CPA job id');
    const artifact = maps.byPair.get(`${runId}:${jobId}`);
    if (!artifact) throw new HttpError(404, `CPA artifact not found: ${jobId}`);
    return artifact;
  }

  cpaArtifacts(options = {}) {
    const includeLocked = options.includeLocked !== false;
    return this.cpaArtifactRows(this.cpaArtifactListing(includeLocked).records, options.reveal === true);
  }

  /**
   * The listing already serialized, reused while nothing has changed.
   *
   * The history page polls this every ten seconds and a full store answers
   * with thousands of records: rebuilding the same objects and stringifying
   * the same megabyte on every poll is work whose result is known to be
   * identical. The cache is keyed to the listing signature, so the first poll
   * after any change pays for it and the rest do not.
   */
  cpaArtifactsJson(options = {}) {
    const reveal = options.reveal === true;
    const includeLocked = options.includeLocked !== false;
    const { records, signature } = this.cpaArtifactListing(includeLocked);
    const cacheKey = `${CPA_ARTIFACT_LIST_CACHE_KEY}:${includeLocked ? 'locked' : 'unlocked'}`;
    const entry = this.cpaArtifactListCache.get(cacheKey);
    const payload = entry?.payload;
    if (payload?.signature === signature && payload.reveal === reveal) return payload.json;
    const json = JSON.stringify({ artifacts: this.cpaArtifactRows(records, reveal) });
    if (entry?.signature === signature) entry.payload = { signature, reveal, json };
    return json;
  }

  lockCpaArtifacts(items, batchKey = '') {
    if (!Array.isArray(items) || items.length === 0) throw new HttpError(400, 'Select at least one CPA artifact batch');
    if (items.length > MAX_RETAINED_CPA_ARTIFACTS) throw new HttpError(400, `At most ${MAX_RETAINED_CPA_ARTIFACTS} CPA artifacts can be locked at once`);
    const maps = this.cpaSelectionMaps(this.cpaArtifactRecords());
    const unique = new Map();
    for (const item of items) {
      const artifact = this.resolveCpaItem(item, maps);
      unique.set(this.cpaExportKey(artifact), artifact);
    }
    const targets = [...unique.values()].map((artifact) => {
      if (!['self_use', 'sold'].includes(String(artifact.lifecycle || ''))) {
        throw new HttpError(409, `Only self-use or sold CPA artifacts can be locked: ${artifact.jobId}`);
      }
      if (artifact.locked !== true && !this.cpaArtifactDeliveryAt(artifact)) {
        throw new HttpError(409, `CPA artifact has not been exported or pushed: ${artifact.jobId}`);
      }
      return artifact;
    });
    const requestedBatchKey = String(batchKey || '').trim();
    const registry = this.readCpaLockRegistry();
    const entries = { ...registry.entries };
    const lockedAt = new Date(this.now()).toISOString();
    const locked = [];
    const alreadyLocked = [];
    for (const artifact of targets) {
      const key = this.cpaExportKey(artifact);
      const current = entries[key];
      if (artifact.locked === true && current?.version === this.cpaArtifactVersion(artifact)) {
        alreadyLocked.push(this.cpaArtifactRef(artifact));
        continue;
      }
      const deliveryAt = this.cpaArtifactDeliveryAt(artifact);
      entries[key] = this.cpaArtifactLockSnapshot(
        artifact,
        lockedAt,
        requestedBatchKey || deliveryAt || `${artifact.runId}:${artifact.jobId}`,
      );
      locked.push(this.cpaArtifactRef(artifact));
    }
    if (locked.length) this.writeCpaLockRegistry(entries);
    return {
      requested: targets.length,
      locked,
      alreadyLocked,
      batchKey: requestedBatchKey || this.cpaArtifactDeliveryAt(targets[0]),
    };
  }

  unlockCpaArtifacts(items) {
    if (!Array.isArray(items) || items.length === 0) throw new HttpError(400, 'Select at least one CPA artifact batch');
    if (items.length > MAX_RETAINED_CPA_ARTIFACTS) throw new HttpError(400, `At most ${MAX_RETAINED_CPA_ARTIFACTS} CPA artifacts can be unlocked at once`);
    const maps = this.cpaSelectionMaps(this.cpaArtifactRecords());
    const unique = new Map();
    for (const item of items) {
      const artifact = this.resolveCpaItem(item, maps);
      unique.set(this.cpaExportKey(artifact), artifact);
    }
    const registry = this.readCpaLockRegistry();
    const entries = { ...registry.entries };
    const unlocked = [];
    const alreadyUnlocked = [];
    for (const artifact of unique.values()) {
      const key = this.cpaExportKey(artifact);
      if (artifact.locked !== true || !entries[key]) {
        alreadyUnlocked.push(this.cpaArtifactRef(artifact));
        continue;
      }
      delete entries[key];
      unlocked.push(this.cpaArtifactRef(artifact));
    }
    if (unlocked.length) this.writeCpaLockRegistry(entries);
    const restored = unlocked.length ? this.restoreUnlockedAssets(
      [...unique.values()].filter((artifact) => unlocked.some((ref) => ref.key === this.cpaExportKey(artifact))),
    ) : { restored: [], skipped: [] };
    return { requested: unique.size, unlocked, alreadyUnlocked, restored: restored.restored, restoreSkipped: restored.skipped };
  }

  /**
   * An unlocked account goes back to the login-state listing.
   *
   * Archiving is a move, done because the batch had been locked for a day; the
   * unlock takes that reason away, so the move is reversed here rather than
   * left for nothing to undo. Locking again starts a fresh `lockedAt`, so the
   * account is only archived again after another full settle window.
   */
  restoreUnlockedAssets(artifacts = []) {
    const store = this.sessionAssets();
    const inUse = this.sessionAssetIdsInUse();
    const ids = new Set();
    const emails = [];
    for (const artifact of artifacts) {
      const assetId = String(artifact?.assetId || '').trim();
      if (assetId) ids.add(assetId);
      for (const email of [artifact?.email, artifact?.parentEmail]) if (email) emails.push(email);
    }
    for (const id of store.archivedIdsForEmails(emails)) ids.add(id);
    const candidates = [...ids].filter((id) => !inUse.has(id));
    if (!candidates.length) return { restored: [], skipped: [] };
    const result = store.relocate(candidates, { restore: true });
    // Only ids that were actually archived matter; a live account reports
    // `not_archived` and needs nothing.
    const skipped = result.skipped.filter((item) => item.reason !== 'not_archived');
    if (result.moved.length) this.invalidateCpaArtifactScan();
    return { restored: result.moved, skipped };
  }

  cpa(runId, jobId = '') {
    return this.cpaDownload(runId, jobId).value;
  }

  cpaDownload(runId, jobId = '') {
    const available = this.cpaArtifactRecords();
    const matches = available.filter((artifact) => artifact.runId === runId && (!jobId || artifact.jobId === jobId));
    const artifacts = matches.filter((artifact) => artifact.locked !== true);
    if (matches.length && !artifacts.length) throw new HttpError(409, 'CPA artifact batch is locked');
    if (!artifacts.length) throw new HttpError(404, `No retained CPA artifacts for run: ${runId}`);
    if (artifacts.length > CPA_EXPORT_MAX_ENTRIES) {
      throw new HttpError(400, `${artifacts.length} CPA artifacts selected; at most ${CPA_EXPORT_MAX_ENTRIES} can be exported at once`);
    }
    const release = this.reserveCpaArtifacts(artifacts);
    try {
      const accounts = this.cpaAccountEntriesForExport(artifacts).map(({ value }) => value);
      this.markCpaExports(artifacts, available);
      return {
        value: accounts.length === 1 ? accounts[0] : accounts,
        fileName: accounts.length === 1 ? artifacts[0].fileName : `${runId}-cpa.json`,
      };
    } finally {
      release();
    }
  }

  /**
   * Exactly one artifact, named by its file-level key.
   *
   * A run/job pair can name two files, so a per-row link built from it would
   * hand the operator both — and stamp both as exported. The key names one file.
   */
  cpaDownloadByKey(key) {
    const normalized = String(key || '').replace(/\\/g, '/').toLowerCase();
    if (!normalized) throw new HttpError(400, 'Invalid CPA artifact key');
    const available = this.cpaArtifactRecords();
    const artifact = available.find((candidate) => this.cpaExportKey(candidate) === normalized);
    if (!artifact) throw new HttpError(404, `No retained CPA artifact for key: ${normalized}`);
    if (artifact.locked === true) throw new HttpError(409, 'CPA artifact batch is locked');
    const release = this.reserveCpaArtifacts([artifact]);
    try {
      const [{ value }] = this.cpaAccountEntriesForExport([artifact]);
      this.markCpaExports([artifact], available);
      return { value, fileName: artifact.fileName };
    } finally {
      release();
    }
  }

  /**
   * Whether this artifact's *current* bytes have already left through `kind`.
   *
   * The marker stores the artifact version it was written for, so a CPA that
   * was rewritten after its export counts as unexported again — which is what
   * an operator means by "the new ones".
   *
   * The three ledgers are keyed identically and differ only in the timestamp
   * field they stamp, so the kind picks that field rather than a key scheme.
   */
  cpaArtifactExported(artifact, entries, kind = 'cpa') {
    const marker = entries[this.cpaExportKey(artifact)];
    const stamp = kind === 'sub2api_push'
      ? marker?.pushedAt
      : (this.nvtokensStampField(kind) ? marker?.[this.nvtokensStampField(kind)] : marker?.exportedAt);
    return marker?.version === this.cpaArtifactVersion(artifact) && typeof stamp === 'string';
  }

  reserveCpaArtifacts(artifacts) {
    const keys = [...new Set(artifacts.map((artifact) => this.cpaExportKey(artifact)))];
    const busy = keys.filter((key) => this.cpaExportReservations.has(key));
    if (busy.length) {
      throw new HttpError(409, `CPA artifact export is already in progress: ${busy.join(', ')}`);
    }
    for (const key of keys) this.cpaExportReservations.add(key);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      for (const key of keys) this.cpaExportReservations.delete(key);
    };
  }

  /**
   * Validate the account identity represented by each retained CPA file.
   *
   * A file is the delivery unit everywhere in the history UI, so a file that
   * contains two accounts, disagrees with its linked login state, or appears
   * twice in one batch cannot safely be exported as one account. Email is the
   * required cross-source identity; account id and asset id strengthen the
   * duplicate check when those fields are available.
   */
  cpaAccountEntriesForExport(artifacts) {
    const assetStore = this.sessionAssets();
    const seen = new Map();
    const entries = [];
    for (const artifact of artifacts) {
      let value;
      try {
        value = runtimeSecrets.parse(fs.readFileSync(artifact.filePath, 'utf8'));
      } catch (error) {
        throw new HttpError(422, `CPA artifact cannot be read: ${scrubString(error?.message || 'invalid Codex CPA')}`);
      }
      const records = Array.isArray(value)
        ? value
        : (Array.isArray(value?.accounts)
          ? value.accounts
          : (Array.isArray(value?.data) ? value.data : [value]));
      if (records.length !== 1 || !records[0] || typeof records[0] !== 'object' || Array.isArray(records[0])) {
        throw new HttpError(422, `CPA artifact must contain exactly one account: ${artifact.fileName}`);
      }
      const record = records[0];
      const email = this.nvtokensCpaRecordEmail(record);
      if (!email) throw new HttpError(422, `CPA artifact has no account email: ${artifact.fileName}`);
      const normalizedEmail = email.toLowerCase();
      const accountId = String(
        record.account_id
          || record.accountId
          || record.chatgpt_account_id
          || record.chatgptAccountId
          || record.credentials?.account_id
          || record.credentials?.chatgpt_account_id
          || '',
      ).trim();
      const artifactEmail = String(artifact.email || '').trim().toLowerCase();
      if (artifactEmail && artifactEmail !== normalizedEmail) {
        throw new HttpError(422, `CPA email does not match artifact metadata: ${artifact.fileName}`);
      }

      let asset = null;
      const assetId = String(artifact.assetId || '').trim();
      if (assetId) {
        try {
          // Read-only for the whole export: `peek` skips the deep clone `get`
          // makes, which at a thousand accounts is a thousand copies of a
          // cookie jar nothing here reads.
          asset = assetStore.peek(assetId);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      if (asset) {
        const assetEmail = String(asset.email || '').trim().toLowerCase();
        if (!assetEmail || assetEmail !== normalizedEmail) {
          throw new HttpError(422, `Login-state email does not match CPA: ${artifact.fileName}`);
        }
        const assetAccountId = String(asset.accountId || '').trim();
        if (assetAccountId && accountId && assetAccountId !== accountId) {
          throw new HttpError(422, `Login-state account does not match CPA: ${artifact.fileName}`);
        }
      }

      const identityKeys = [`email:${normalizedEmail}`];
      if (accountId) identityKeys.push(`account:${accountId}`);
      if (assetId) identityKeys.push(`asset:${assetId}`);
      const duplicate = identityKeys.find((key) => seen.has(key));
      if (duplicate) {
        const previous = seen.get(duplicate);
        throw new HttpError(409, `Selected CPA artifacts refer to the same account: ${email} (${previous} and ${artifact.fileName})`);
      }
      for (const key of identityKeys) seen.set(key, artifact.fileName);
      entries.push({ artifact, value, record, email: String(asset?.email || email).trim(), accountId, asset });
    }
    return entries;
  }

  /** The ledger a `kind` reads and writes. */
  exportRegistryFor(kind) {
    if (kind === 'sub2api') return this.readSub2ApiExportRegistry();
    if (kind === 'sub2api_push') return this.readSub2ApiPushRegistry();
    if (this.nvtokensStampField(kind)) return this.readNvtokensPushRegistry();
    return this.readCpaExportRegistry();
  }

  /**
   * @param {object} selection  `runIds`, `items`, `unexported`, or nothing for all.
   * @param {object} options    `kind` picks which ledger `unexported` reads:
   *                            `cpa`, `sub2api` (downloads) or `sub2api_push`.
   */
  selectedCpaArtifacts(selection = {}, options = {}) {
    const hasRunSelection = selection.runIds !== undefined;
    const hasItemSelection = selection.items !== undefined;
    const hasUnexported = selection.unexported === true;
    const hasUnexportedOnly = selection.unexportedOnly === true;
    if ([hasRunSelection, hasItemSelection, hasUnexported].filter(Boolean).length > 1) {
      throw new HttpError(400, 'Choose runs, CPA artifacts, or the unexported set — not more than one');
    }
    if (hasUnexportedOnly && (!hasItemSelection || hasRunSelection || hasUnexported)) {
      throw new HttpError(400, 'unexportedOnly requires an explicit CPA artifact selection');
    }
    if (hasRunSelection && (!Array.isArray(selection.runIds) || selection.runIds.length === 0)) throw new HttpError(400, 'Select at least one run');
    if (hasItemSelection && (!Array.isArray(selection.items) || selection.items.length === 0)) throw new HttpError(400, 'Select at least one CPA artifact');
    if (selection.runIds?.length > CPA_EXPORT_MAX_ENTRIES || selection.items?.length > CPA_EXPORT_MAX_ENTRIES) {
      throw new HttpError(400, `At most ${CPA_EXPORT_MAX_ENTRIES} entries can be exported at once`);
    }

    const available = this.cpaArtifactRecords();
    const active = available.filter((artifact) => artifact.locked !== true);
    const kind = ['sub2api', 'sub2api_push', 'nvtokens_cards', 'nvtokens_mailboxes', 'nvtokens_pool']
      .includes(options.kind)
      ? options.kind
      : 'cpa';
    let artifacts = active;
    if (hasUnexported) {
      // Read the ledger here rather than trusting a list the browser built: the
      // console's snapshot can be seconds old, and exporting a file twice is
      // exactly what this selection exists to prevent.
      const entries = this.exportRegistryFor(kind).entries;
      const verb = kind === 'sub2api_push' || this.nvtokensStampField(kind) ? 'pushed' : 'exported';
      artifacts = active.filter((artifact) => !this.cpaArtifactExported(artifact, entries, kind));
      if (!artifacts.length) {
        // Two different empties, and telling an operator "all exported" when
        // there is simply nothing retained sends them looking for a bug.
        throw new HttpError(404, available.length
          ? `Every retained CPA artifact has already been ${verb}`
          : 'No retained CPA artifacts');
      }
      if (artifacts.length > CPA_EXPORT_MAX_ENTRIES) {
        throw new HttpError(400, `${artifacts.length} CPA artifacts have not been ${verb}; at most ${CPA_EXPORT_MAX_ENTRIES} can be sent at once`);
      }
    } else if (hasRunSelection) {
      const runIds = new Set(selection.runIds.map(safeRunId));
      artifacts = active.filter((artifact) => runIds.has(artifact.runId));
    } else if (hasItemSelection) {
      const maps = this.cpaSelectionMaps(available);
      const selected = new Map();
      for (const item of selection.items) {
        const artifact = this.resolveCpaItem(item, maps);
        if (artifact.locked === true) throw new HttpError(409, `CPA artifact batch is locked: ${artifact.jobId}`);
        // Dedup by the file-level key, so two rows that happen to share
        // runId:jobId stay two exports instead of collapsing into one.
        selected.set(this.cpaExportKey(artifact), artifact);
      }
      artifacts = [...selected.values()];
      if (hasUnexportedOnly) {
        const entries = this.exportRegistryFor(kind).entries;
        const verb = kind === 'sub2api_push' || this.nvtokensStampField(kind) ? 'pushed' : 'exported';
        const alreadyExported = artifacts.filter((artifact) => this.cpaArtifactExported(artifact, entries, kind));
        if (alreadyExported.length) {
          throw new HttpError(409, `${alreadyExported.length} selected CPA artifact(s) have already been ${verb}`);
        }
      }
    }
    if (!artifacts.length) throw new HttpError(404, 'No retained CPA artifacts match the selection');
    if (artifacts.length > CPA_EXPORT_MAX_ENTRIES) {
      throw new HttpError(400, `${artifacts.length} CPA artifacts selected; at most ${CPA_EXPORT_MAX_ENTRIES} can be exported at once`);
    }
    return { artifacts, available };
  }

  /**
   * The timestamp a batch is stamped with, or `undefined` for "now".
   *
   * The console sends a large selection as several requests. Each stamps its own
   * ledger entries — that is what makes an interrupted export keep whatever
   * landed — but they are one delivery, and the history page groups rows by that
   * stamp. Without a shared timestamp a thousand-account export would arrive as
   * ten separate batches a second apart.
   */
  exportDeliveryAt(value) {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !value.trim()) throw new HttpError(400, 'deliveryAt must be a valid timestamp');
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) throw new HttpError(400, 'deliveryAt must be a valid timestamp');
    return parsed.toISOString();
  }

  exportCpa(selection = {}) {
    const deliveryAt = this.exportDeliveryAt(selection.deliveryAt);
    const { artifacts, available } = this.selectedCpaArtifacts(selection, { kind: 'cpa' });
    const release = this.reserveCpaArtifacts(artifacts);
    try {
      const records = this.cpaAccountEntriesForExport(artifacts).map(({ value }) => value);
      this.markCpaExports(artifacts, available, deliveryAt);
      return records;
    } finally {
      release();
    }
  }

  exportAllCpa() {
    return this.exportCpa();
  }

  /**
   * Export selected CPA accounts as one `email----password----2FA` line each.
   * Passwords and TOTP secrets live on the login-state asset rather than in
   * the CPA JSON. This uses the same CPA export ledger as the JSON download.
   */
  /**
   * Which of these accounts cannot be handed over as `email----password----2FA`.
   *
   * Split out of the export so the same judgement can be made without writing
   * anything: see `preflightCpaCredentials`.
   */
  missingCpaCredentials(entries) {
    const missing = [];
    const assetIds = [];
    for (const entry of entries) {
      const artifact = entry.artifact;
      const assetId = String(artifact.assetId || '').trim();
      const asset = entry.asset;
      if (!assetId || !asset) {
        missing.push({
          ...this.cpaArtifactRef(artifact),
          email: String(entry.email || artifact.email || ''),
          reason: assetId ? 'login-state asset not found' : 'no associated login-state asset',
        });
        continue;
      }
      const missingFields = [];
      if (!String(asset.email || '').trim()) missingFields.push('email');
      if (!String(asset.password || '')) missingFields.push('password');
      if (!String(asset.totpSecret || '').trim()) missingFields.push('2FA');
      if (missingFields.length) {
        missing.push({
          ...this.cpaArtifactRef(artifact),
          email: String(asset.email || entry.email || artifact.email || ''),
          reason: `missing ${missingFields.join(', ')}`,
        });
        continue;
      }
      if ([asset.email, asset.password, asset.totpSecret].some((value) => /[\r\n]/.test(String(value)))) {
        missing.push({
          ...this.cpaArtifactRef(artifact),
          email: String(asset.email || entry.email || artifact.email || ''),
          reason: 'credential contains a line break',
        });
        continue;
      }
      assetIds.push(assetId);
    }
    return { missing, assetIds };
  }

  assertCredentialSelection(selection) {
    const hasExplicitSelection = selection
      && typeof selection === 'object'
      && (selection.runIds !== undefined || selection.items !== undefined);
    if (!hasExplicitSelection || selection.unexported === true) {
      throw new HttpError(400, 'Select at least one CPA artifact');
    }
  }

  /**
   * What a credential export would refuse, without exporting anything.
   *
   * The export is all-or-nothing on purpose: a batch handed to a buyer is
   * complete or it is not sent. That is also what stopped the console from
   * splitting a large selection into request-sized batches — a later batch
   * failing would leave the earlier ones stamped and delivered. This answers the
   * same question for one batch and writes nothing, so the console can check
   * every batch first and only then send them.
   */
  preflightCpaCredentials(selection = {}) {
    this.assertCredentialSelection(selection);
    const { artifacts } = this.selectedCpaArtifacts(selection, { kind: 'cpa' });
    const { missing } = this.missingCpaCredentials(this.cpaAccountEntriesForExport(artifacts));
    return { requested: artifacts.length, ready: artifacts.length - missing.length, missing };
  }

  exportCpaCredentials(selection = {}) {
    this.assertCredentialSelection(selection);
    const { artifacts, available } = this.selectedCpaArtifacts(selection, { kind: 'cpa' });
    const release = this.reserveCpaArtifacts(artifacts);
    try {
      const entries = this.cpaAccountEntriesForExport(artifacts);
      const { missing, assetIds } = this.missingCpaCredentials(entries);
      if (missing.length) {
        throw new HttpError(422, `Cannot export credentials for ${missing.length} selected CPA artifact(s)：${nvtokensSkipReasons(missing).join('；')}`, { missing });
      }
      const exported = this.sessionAssets().export(assetIds, { kind: 'credentials' });
      this.markCpaExports(artifacts, available, this.exportDeliveryAt(selection.deliveryAt));
      return {
        // Every CPA is an OAuth-completed account by definition.
        fileName: exportFileName({ label: '凭证', count: exported.exported, ext: 'txt' }),
        contentType: 'text/plain; charset=utf-8',
        content: exported.content,
        exported: artifacts.length,
      };
    } finally {
      release();
    }
  }

  /**
   * The same CPAs as `exportCpa`, but one file per account inside a folder.
   *
   * A single merged array is convenient to eyeball and useless to feed to
   * anything that consumes one credential file at a time, which is what the
   * artifacts are for. The archive keeps the on-disk file name so a downloaded
   * batch matches the console listing line for line.
   */
  exportCpaArchive(selection = {}) {
    const { artifacts, available } = this.selectedCpaArtifacts(selection, { kind: 'cpa' });
    const release = this.reserveCpaArtifacts(artifacts);
    const taken = new Set();
    try {
      const accounts = this.cpaAccountEntriesForExport(artifacts);
      // The folder inside carries the archive's own name, so unpacking two
      // exports side by side never merges them.
      const fileName = exportFileName({ label: 'CPA', count: accounts.length, ext: 'zip' });
      const folder = fileName.replace(/\.zip$/, '');
      const entries = accounts.map(({ artifact, value }) => ({
        path: `${folder}/${uniqueEntryName(artifact.fileName, taken)}`,
        // Re-serialized rather than copied: a parse here is what catches a
        // truncated artifact before it reaches the operator's disk.
        content: `${JSON.stringify(value, null, 2)}\n`,
      }));
      const buffer = createZipArchive(entries);
      this.markCpaExports(artifacts, available);
      return { fileName, buffer };
    } catch (error) {
      // A truncated artifact is the operator's problem to fix, not an internal
      // error: say which kind of failure it is.
      if (error instanceof HttpError) throw error;
      throw new HttpError(422, `CPA artifact cannot be read: ${scrubString(error?.message || 'invalid Codex CPA')}`);
    } finally {
      release();
    }
  }

  /** One sub2api document per account, in a folder, marked exported as a batch. */
  exportSub2ApiArchive(selection = {}) {
    if (selection.runIds === undefined && selection.items === undefined && selection.unexported !== true) {
      throw new HttpError(400, 'Select at least one CPA artifact or run');
    }
    const { artifacts, available } = this.selectedCpaArtifacts(selection, { kind: 'sub2api' });
    const release = this.reserveCpaArtifacts(artifacts);
    const taken = new Set();
    let entries;
    let fileName;
    try {
      const accounts = this.cpaAccountEntriesForExport(artifacts);
      fileName = exportFileName({ label: 'sub2api', count: accounts.length, ext: 'zip' });
      const folder = fileName.replace(/\.zip$/, '');
      entries = accounts.map(({ artifact, value }) => {
        const name = `${artifact.fileName.replace(/\.json$/i, '')}.sub2api.json`;
        return {
          path: `${folder}/${uniqueEntryName(name, taken)}`,
          content: `${JSON.stringify(buildSub2ApiDocument([value]), null, 2)}\n`,
        };
      });
    } catch (error) {
      // The second try/finally below only starts after conversion succeeds.
      // Release here as well so a bad identity or unreadable CPA does not leave
      // the artifact reserved until process restart.
      release();
      if (error instanceof HttpError) throw error;
      throw new HttpError(422, `CPA cannot be converted to sub2api: ${scrubString(error?.message || 'invalid Codex CPA')}`);
    }
    // Only once the archive exists: a batch that failed anywhere — conversion
    // or packing — must not leave its artifacts flagged as exported while the
    // operator got a 500 and no file.
    try {
      const buffer = createZipArchive(entries);
      this.markSub2ApiExports(artifacts, available);
      return { fileName, buffer };
    } finally {
      release();
    }
  }

  exportSub2Api(selection = {}) {
    if (selection.runIds === undefined && selection.items === undefined && selection.unexported !== true) {
      throw new HttpError(400, 'Select at least one CPA artifact or run');
    }
    const { artifacts, available } = this.selectedCpaArtifacts(selection, { kind: 'sub2api' });
    const release = this.reserveCpaArtifacts(artifacts);
    try {
      const records = this.cpaAccountEntriesForExport(artifacts).map(({ value }) => value);
      const document = buildSub2ApiDocument(records);
      this.markSub2ApiExports(artifacts, available);
      return document;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(422, `CPA cannot be converted to sub2api: ${scrubString(error?.message || 'invalid Codex CPA')}`);
    } finally {
      release();
    }
  }

  /**
   * The sub2api gateway this instance pushes self-use accounts to.
   *
   * The admin API key is optional here rather than required at config-load
   * time: an operator who never pushes should not have to configure a gateway,
   * and the client turns a missing key into a message they can act on.
   */
  sub2ApiClient() {
    const config = this.configService.normalized().sub2api || {};
    let adminApiKey = '';
    try { adminApiKey = secretFromEnv(config, 'adminApiKeyEnv'); } catch { adminApiKey = ''; }
    return new Sub2ApiClient({
      baseUrl: config.baseUrl,
      adminApiKey,
      requestTimeoutMs: config.requestTimeoutMs,
      ...(this.sub2ApiFetch ? { fetch: this.sub2ApiFetch } : {}),
    });
  }

  /**
   * The gateway groups a push files its accounts into.
   *
   * Worth doing rather than letting the gateway decide: sub2api only auto-files
   * an import when a group is named exactly `<platform>-default`, so a gateway
   * whose group is called `openai` leaves every pushed account ungrouped — on
   * no schedule, serving nothing, until someone moves them by hand.
   *
   * Configured ids win over a name and skip the lookup. A name that resolves to
   * nothing is an error rather than a silent fall-through to ungrouped: pushing
   * sixty accounts into limbo is the failure this setting exists to prevent, so
   * it must not be the thing that happens when the setting is wrong.
   */
  async sub2ApiGroupIds(client) {
    const config = this.configService.normalized().sub2api || {};
    if (config.groupIds?.length) return config.groupIds;
    const wanted = String(config.groupName || '').trim();
    if (!wanted) return [];
    const groups = await client.listGroups();
    const match = groups.find((group) => group.name.toLowerCase() === wanted.toLowerCase());
    if (!match) {
      const names = groups.map((group) => group.name).join('、') || '（网关没有任何分组）';
      throw new HttpError(400, `sub2api 没有名为「${wanted}」的分组，现有：${names}`);
    }
    return [match.id];
  }

  /**
   * Hand the selected CPAs to the local sub2api gateway.
   *
   * The CPA record goes over the wire unchanged. sub2api's Codex import reads
   * `access_token` / `id_token` / `refresh_token` / `email` / `account_id` off
   * each entry, which is exactly this repo's CPA shape, and re-derives expiry,
   * organization and plan from the access token's own claims. Converting to
   * the sub2api *document* first would be worse, not better: that shape nests
   * everything under `credentials`, where the importer does not look.
   *
   * A push is a partial success by default — one dead access token in a batch
   * is refused per-entry, not for the batch — so the whole selection is stamped
   * as pushed only when at least one account landed, and the per-entry failures
   * come back for the operator to read.
   */
  async pushSub2Api(selection = {}) {
    if (selection.runIds === undefined && selection.items === undefined && selection.unexported !== true) {
      throw new HttpError(400, 'Select at least one CPA artifact or run');
    }
    // The console pushes in batches of 25; a shared stamp keeps them one
    // delivery on the history page instead of one group per request.
    const requestedDeliveryAt = this.exportDeliveryAt(selection.deliveryAt);
    const client = this.sub2ApiClient();
    const { artifacts, available } = this.selectedCpaArtifacts(selection, { kind: 'sub2api_push' });
    const release = this.reserveCpaArtifacts(artifacts);
    try {
    let records;
    try {
      records = artifacts.map((artifact) => runtimeSecrets.parse(fs.readFileSync(artifact.filePath, 'utf8')));
    } catch (error) {
      throw new HttpError(422, `CPA artifact cannot be read: ${scrubString(error?.message || 'invalid Codex CPA')}`);
    }
    // Flattened because a CPA file holds either one account or an array of
    // them, and sub2api counts entries, not files.
    const accounts = records.flatMap((record) => (Array.isArray(record?.accounts)
      ? record.accounts
      : Array.isArray(record) ? record : [record]));

    let summary;
    try {
      const groupIds = await this.sub2ApiGroupIds(client);
      summary = await client.importCodexSessions(accounts, { updateExisting: true, groupIds });
    } catch (error) {
      throw this.sub2ApiHttpError(error);
    }

    // Nothing landed: leave the ledger and the lifecycle alone so the operator
    // can fix the cause and push the same selection again.
    if (summary.created + summary.updated === 0) {
      return { ...summary, pushed: 0, artifacts: artifacts.length, classified: [] };
    }

    // Delivered, so every ledger records it. The push ledger is what makes the
    // 已推送 badge and the "not yet pushed" selection possible, but an artifact
    // whose credentials have reached the gateway has left this machine, and
    // leaving the export ledgers unstamped would keep 导出未导出 offering to
    // send the same files again.
    // One stamp for all three ledgers too: the history groups by the latest of
    // them, and three separate clocks could split even a single request.
    const deliveryAt = requestedDeliveryAt || new Date(this.now()).toISOString();
    this.markSub2ApiPushes(artifacts, available, deliveryAt);
    this.markCpaExports(artifacts, available, deliveryAt);
    this.markSub2ApiExports(artifacts, available, deliveryAt);
    // A pushed account is one we are running ourselves, so it moves to the
    // self-use pool here rather than waiting for the operator to tag it.
    //
    // Not gated on the in-use check the lifecycle route applies: `self_use`
    // keeps every queue `active` has, so relabelling an asset a task is
    // holding changes nothing about how it is worked. It *is* gated on the two
    // pools that outrank it — a sold account keeps its sale record, and a
    // banned one must not have its ban cleared by a push, which is what moving
    // it to a usable pool would do.
    const assetIds = [...new Set(artifacts.map((artifact) => String(artifact.assetId || '')).filter(Boolean))];
    let classified = [];
    const relabel = assetIds.filter((id) => {
      try { return !['sold', 'banned'].includes(assetLifecycle(this.sessionAssets().get(id))); } catch { return false; }
    });
    if (relabel.length) {
      try {
        classified = this.sessionAssets().markLifecycle(relabel, 'self_use').changed;
      } catch (error) {
        // The push already happened. Losing the label is worth a log line, not
        // a 500 that tells the operator the push failed when it did not.
        this.logStore?.append?.(String(artifacts[0]?.runId || 'run-manager'), {
          level: 'warn',
          source: 'run-manager',
          type: 'sub2api_push_classify_failed',
          message: `推送 sub2api 成功，但归类为自用失败：${scrubString(error?.message || 'unknown')}`,
          details: { assetIds },
        });
      }
    }
    return { ...summary, pushed: summary.created + summary.updated, artifacts: artifacts.length, classified };
    } finally {
      release();
    }
  }

  /**
   * Turn a sub2api HTTP failure into the status an operator can act on.
   *
   * 503 for a gateway that is not running, 400 for one this instance has no
   * key for, 502 for one that answered and refused: "start sub2api", "set the
   * key" and "read the message" are three different next steps.
   */
  sub2ApiHttpError(error) {
    if (!(error instanceof Sub2ApiError)) return error;
    const status = error.code === 'SUB2API_OFFLINE'
      ? 503
      : (error.code === 'SUB2API_UNCONFIGURED' ? 400 : (error.status || 502));
    return new HttpError(status, scrubString(error.message));
  }

  nvtokensClient() {
    const config = this.configService.normalized().nvtokens || {};
    let apiKey = '';
    try { apiKey = secretFromEnv(config, 'apiKeyEnv'); } catch { apiKey = ''; }
    return new NvtokensClient({
      baseUrl: config.baseUrl,
      apiKey,
      requestTimeoutMs: config.requestTimeoutMs,
      ...(this.nvtokensFetch ? { fetch: this.nvtokensFetch } : {}),
    });
  }

  nvtokensHttpError(error) {
    if (!(error instanceof NvtokensError)) return error;
    const status = error.code === 'NVTOKENS_OFFLINE'
      ? 503
      : (error.code === 'NVTOKENS_UNCONFIGURED' ? 400 : (error.status || 502));
    const upstream = error.status ? `nvtokens 上游 HTTP ${error.status}: ` : '';
    const requestId = error.requestId ? `（请求 ID：${scrubString(error.requestId)}）` : '';
    return new HttpError(status, `${upstream}${scrubString(error.message)}${requestId}`, {
      code: error.code,
      ...(error.status ? { upstreamStatus: error.status } : {}),
      ...(error.requestId ? { requestId: scrubString(error.requestId) } : {}),
    });
  }

  nvtokensSelectedCpa(selection, kind) {
    if (
      selection?.runIds === undefined
      && selection?.items === undefined
      && selection?.unexported !== true
    ) {
      throw new HttpError(400, 'Select at least one CPA artifact or run');
    }
    return this.selectedCpaArtifacts(selection, { kind });
  }

  nvtokensCpaEntries(artifacts) {
    try {
      const entries = [];
      for (const artifact of artifacts) {
        const value = runtimeSecrets.parse(fs.readFileSync(artifact.filePath, 'utf8'));
        const records = Array.isArray(value)
          ? value
          : (Array.isArray(value?.accounts)
            ? value.accounts
            : (Array.isArray(value?.data) ? value.data : [value]));
        if (!records.length || records.some((record) => !record || typeof record !== 'object' || Array.isArray(record))) {
          throw new Error('CPA JSON does not contain account objects');
        }
        records.forEach((record, recordIndex) => entries.push({ artifact, record, recordIndex }));
      }
      if (!entries.length) throw new Error('CPA JSON does not contain account objects');
      // Keep the CPA record as the source of truth for card imports. Resolve
      // the linked asset only so credential imports can validate and pair the
      // mailbox fields with the same account.
      const assetStore = this.sessionAssets();
      const assetsByEmail = new Map();
      for (const asset of assetStore.allRaw()) {
        const email = String(asset?.email || '').trim().toLowerCase();
        if (!email || asset?.status === 'corrupt') continue;
        const matches = assetsByEmail.get(email) || [];
        matches.push(asset);
        assetsByEmail.set(email, matches);
      }
      const artifactEntryCounts = new Map();
      for (const entry of entries) {
        const key = path.resolve(entry.artifact.filePath).toLowerCase();
        artifactEntryCounts.set(key, (artifactEntryCounts.get(key) || 0) + 1);
      }
      const resolved = entries.map((entry) => {
        const recordEmail = this.nvtokensCpaRecordEmail(entry.record).toLowerCase();
        const artifactKey = path.resolve(entry.artifact.filePath).toLowerCase();
        let asset = null;
        let assetResolution = 'none';
        if (entry.artifact.assetId && artifactEntryCounts.get(artifactKey) === 1) {
          try {
            asset = assetStore.peek(String(entry.artifact.assetId));
            assetResolution = 'asset_id';
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
            assetResolution = 'missing_asset';
          }
        } else {
          const matches = assetsByEmail.get(recordEmail) || [];
          if (matches.length === 1) {
            asset = matches[0];
            assetResolution = 'email';
          } else if (matches.length > 1) {
            assetResolution = 'ambiguous_email';
          }
        }
        return { ...entry, asset, assetResolution };
      });

      return resolved;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(422, `CPA artifact cannot be read: ${scrubString(error?.message || 'invalid Codex CPA')}`);
    }
  }

  nvtokensCpaRecordEmail(record = {}) {
    return String(
      record.email
        || record.credentials?.email
        || record.account?.email
        || '',
    ).trim();
  }

  /**
   * Pair every selected CPA record with the credentials on its login-state
   * asset, and set the unusable ones aside instead of refusing the batch.
   *
   * One account without a long-lived 2FA secret used to reject the whole
   * request, so a batch of 25 lost its other 24 to a single bad row, and the
   * console reported only an English count with no account name. Unusable
   * records are now returned as `skipped`, each with the account it belongs
   * to and why it cannot go, and the rest are sent. A selection with nothing
   * usable is still an error: there is no push left to make, and the reasons
   * are all the operator needs.
   */
  nvtokensCredentialEntries(artifacts) {
    const entries = this.nvtokensCpaEntries(artifacts);

    const usable = [];
    const tokens = [];
    const skipped = [];
    const skippedArtifacts = new Set();
    const seenEmails = new Set();
    const setAside = (entry, email, reason) => {
      skippedArtifacts.add(entry.artifact);
      skipped.push({
        ...this.cpaArtifactRef(entry.artifact),
        ...(entry.recordIndex > 0 ? { recordIndex: entry.recordIndex } : {}),
        email,
        reason,
      });
    };
    for (const entry of entries) {
      const recordEmail = this.nvtokensCpaRecordEmail(entry.record);
      if (!recordEmail) {
        setAside(entry, '', 'CPA 记录里没有邮箱');
        continue;
      }
      const emailKey = recordEmail.toLowerCase();
      if (seenEmails.has(emailKey)) {
        setAside(entry, recordEmail, '同一次推送里重复出现');
        continue;
      }
      seenEmails.add(emailKey);

      const asset = entry.asset || null;
      if (!asset) {
        setAside(entry, recordEmail, entry.assetResolution === 'ambiguous_email'
          ? '有多个登录态资产用同一个邮箱'
          : (entry.artifact.assetId ? '找不到对应的登录态资产' : '没有关联的登录态资产'));
        continue;
      }
      const assetEmail = String(asset.email || '').trim();
      if (assetEmail.toLowerCase() !== emailKey) {
        setAside(entry, recordEmail, '登录态与 CPA 的邮箱不一致');
        continue;
      }
      const password = String(asset.password || '');
      const twoFactorSecret = String(asset.totpSecret || '').trim();
      const missingFields = [];
      if (!password) missingFields.push('密码');
      if (!twoFactorSecret) missingFields.push('长期 2FA 密钥');
      if (missingFields.length) {
        setAside(entry, recordEmail, `缺少${missingFields.join('、')}`);
        continue;
      }
      if ([assetEmail, password, twoFactorSecret].some((value) => /[\r\n]/.test(value))) {
        setAside(entry, recordEmail, '凭证里含有换行');
        continue;
      }
      if (/^\d{6}$/.test(twoFactorSecret)) {
        setAside(entry, recordEmail, '2FA 是一次性验证码，不是长期 2FA 密钥');
        continue;
      }
      usable.push(entry);
      tokens.push({ email: assetEmail, password, two_factor_secret: twoFactorSecret });
    }
    if (!usable.length) {
      throw new HttpError(
        422,
        `Cannot push credentials for ${skipped.length} selected CPA record(s)：${nvtokensSkipReasons(skipped).join('；')}`,
        { missing: skipped, skipped },
      );
    }
    // Only an artifact whose every record went can be stamped as delivered:
    // a multi-record CPA that lost one row has not fully left this machine.
    const delivered = [];
    const seenArtifacts = new Set();
    for (const { artifact } of usable) {
      if (skippedArtifacts.has(artifact) || seenArtifacts.has(artifact)) continue;
      seenArtifacts.add(artifact);
      delivered.push(artifact);
    }
    return {
      entries: usable,
      records: usable.map(({ record }) => record),
      tokens,
      skipped,
      artifacts: delivered,
    };
  }

  nvtokensOptionalBody(selection, config) {
    const body = {};
    const destination = String(selection?.destination || config.destination || '').trim();
    if (destination && destination !== 'normal') {
      if (!['normal', 'fallback_only'].includes(destination)) {
        throw new HttpError(400, 'nvtokens destination must be normal or fallback_only');
      }
      body.destination = destination;
    }
    const warrantyChannelId = String(config.warrantyChannelId || '').trim();
    const warrantyName = String(config.warrantyName || '').trim();
    if (warrantyChannelId) body.warranty_channel_id = warrantyChannelId;
    else if (warrantyName) body.warranty_name = warrantyName;
    if (config.team5xWarranty && typeof config.team5xWarranty === 'object') {
      body.team5x_warranty = { ...config.team5xWarranty };
    }
    if (config.fallbackPoolEnabled === true) body.fallback_pool_enabled = true;
    if (config.fallbackPoolMultiplier !== null && config.fallbackPoolMultiplier !== undefined) {
      body.fallback_pool_multiplier = config.fallbackPoolMultiplier;
    }
    return body;
  }

  nvtokensAssertBatchSize(kind, count) {
    const limit = kind === 'nvtokens_mailboxes' ? 1000 : 100;
    if (count > limit) {
      throw new HttpError(400, `nvtokens ${kind === 'nvtokens_mailboxes' ? 'mailbox' : 'card'} batches are limited to ${limit} entries`);
    }
  }

  nvtokensDeliveryAt(value) {
    if (value === undefined) return new Date(this.now()).toISOString();
    if (typeof value !== 'string' || !value.trim()) {
      throw new HttpError(400, 'nvtokens deliveryAt must be a valid timestamp');
    }
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) {
      throw new HttpError(400, 'nvtokens deliveryAt must be a valid timestamp');
    }
    return parsed.toISOString();
  }

  nvtokensPushResult(kind, rawPayload, requested, artifacts, available, deliveryAt, setAside = []) {
    const summary = summarizeNvtokensResponse(rawPayload, requested);
    // A partial response tells us how many entries were accepted, but not
    // which CPA file each entry came from. Do not stamp the whole selection
    // unless the upstream accepted every requested entry.
    const delivered = summary.ok
      && requested > 0
      && summary.accepted >= requested
      && summary.failed === 0
      && summary.skipped === 0;
    if (delivered) {
      const stampedAt = this.nvtokensDeliveryAt(deliveryAt);
      this.markNvtokensPushes(kind, artifacts, available, stampedAt);
      // Anything accepted by the member inventory has left this machine and
      // is therefore an export even when the operator never downloaded it.
      this.markCpaExports(artifacts, available, stampedAt);
    }
    return {
      ...summary,
      // Records this machine held back are skips too: the operator wants one
      // number for "did not go", not one for the platform and one for here.
      skipped: summary.skipped + setAside.length,
      skippedDetails: setAside,
      pushed: summary.accepted,
      artifacts: delivered ? artifacts.length : 0,
      exported: delivered ? artifacts.length : 0,
      kind,
    };
  }

  async pushNvtokens(kind, selection, prepareRequest) {
    const { artifacts, available } = this.nvtokensSelectedCpa(selection, kind);
    const config = this.configService.normalized().nvtokens || {};
    const prepared = prepareRequest({ artifacts, config, selection });
    const { count, send } = prepared;
    // Credential pushes can hold records back, so only what was actually sent
    // is stamped — stamping the whole selection would mark a skipped account
    // as delivered and quietly hide it from the next push.
    const sent = prepared.artifacts || artifacts;
    const setAside = prepared.skipped || [];
    this.nvtokensAssertBatchSize(kind, count);
    try {
      const payload = await send(this.nvtokensClient());
      return this.nvtokensPushResult(kind, payload, count, sent, available, selection.deliveryAt, setAside);
    } catch (error) {
      throw this.nvtokensHttpError(error);
    }
  }

  pushNvtokensCards(selection = {}) {
    return this.pushNvtokens('nvtokens_cards', selection, ({ artifacts, config, selection: currentSelection }) => {
      const records = this.nvtokensCpaEntries(artifacts).map(({ record }) => record);
      return {
        count: records.length,
        send: (client) => client.importCards({
          data: records,
          ...this.nvtokensOptionalBody(currentSelection, config),
        }),
      };
    });
  }

  pushNvtokensMailboxes(selection = {}) {
    return this.pushNvtokens('nvtokens_mailboxes', selection, ({ artifacts }) => {
      // The documented structured shape preserves exact field boundaries and
      // keeps passwords/2FA secrets safe when they contain delimiter text.
      const { tokens, skipped, artifacts: sent } = this.nvtokensCredentialEntries(artifacts);
      return { count: tokens.length, skipped, artifacts: sent, send: (client) => client.importMailboxes({ tokens }) };
    });
  }

  pushNvtokensPool(selection = {}) {
    return this.pushNvtokens('nvtokens_pool', selection, ({ artifacts, config, selection: currentSelection }) => {
      const { records, tokens, skipped, artifacts: sent } = this.nvtokensCredentialEntries(artifacts);
      const rawPrice = currentSelection.priceYuan ?? currentSelection.price_yuan ?? config.defaultPriceYuan;
      const priceYuan = Number(rawPrice);
      if (!Number.isFinite(priceYuan) || priceYuan <= 0) {
        throw new HttpError(422, 'A positive nvtokens pool price is required');
      }
      return {
        count: records.length,
        skipped,
        artifacts: sent,
        send: (client) => client.poolCards({
          data: records,
          price_yuan: priceYuan,
          inventory_tokens: tokens,
          ...this.nvtokensOptionalBody(currentSelection, config),
        }),
      };
    });
  }

  /**
   * The accounts sub2api itself has marked broken, with their addresses.
   *
   * Two signals, both read out of one scan. `status=error` is a server-side
   * filter but a plain match on the stored column, so those rows are already
   * in the scan; a non-empty `error_message` is not filterable at all and
   * could only ever have been found this way. The scan is capped and says when
   * it hit the cap rather than pretending it saw everything.
   *
   * The two counts alongside cost one request each and cannot come out of the
   * scan: they are sub2api's *derived* statuses, and every row can report
   * `status: "active"` while the gateway counts it as rate-limited. Without
   * them a zero result reads as a broken button instead of as "nothing is in
   * the error state right now". Recomputing them here from `schedulable` and
   * the two cooldown timestamps would duplicate the gateway's predicate and
   * silently drift from it, which is worse than two count queries.
   *
   * Three requests in total, and no access tokens: the listing carries only
   * credential metadata.
   */
  async sub2ApiFailedAccounts() {
    const client = this.sub2ApiClient();
    try {
      const scanned = await client.listAccounts({});
      const breakdown = { total: scanned.total, ...(await client.accountCounts(['active', 'rate_limited'])) };
      const byId = new Map();
      for (const account of scanned.accounts.filter((row) => String(row?.status || '').toLowerCase() === 'error' || String(row?.error_message || '').trim())) {
        const id = Number(account?.id);
        if (!Number.isInteger(id) || byId.has(id)) continue;
        byId.set(id, {
          id,
          // The importer writes the address into all three, but an account
          // added by hand in sub2api may only carry the name.
          email: String(account?.credentials?.email || account?.extra?.email || account?.name || '').trim(),
          status: String(account?.status || ''),
          reason: scrubString(String(account?.error_message || account?.temp_unschedulable_reason || '').trim()).slice(0, 300),
        });
      }
      return {
        accounts: [...byId.values()].sort((left, right) => left.email.localeCompare(right.email)),
        breakdown,
        truncated: scanned.truncated,
      };
    } catch (error) {
      throw this.sub2ApiHttpError(error);
    }
  }

  /**
   * Permanently remove accounts from the gateway.
   *
   * Deliberately a separate call from the read above rather than a cascade:
   * the operator sees the addresses first and then decides, and a pull that
   * silently emptied the gateway would be impossible to take back.
   */
  async removeSub2ApiAccounts(ids = []) {
    const accountIds = Array.isArray(ids) ? ids : [];
    if (!accountIds.length) throw new HttpError(400, 'Select at least one sub2api account');
    if (accountIds.length > 500) throw new HttpError(400, 'At most 500 sub2api accounts can be removed at once');
    try {
      return await this.sub2ApiClient().deleteAccounts(accountIds);
    } catch (error) {
      throw this.sub2ApiHttpError(error);
    }
  }

  removeCpaArtifacts(items) {
    if (!Array.isArray(items) || items.length === 0) throw new HttpError(400, 'Select at least one CPA artifact');
    if (items.length > 500) throw new HttpError(400, 'At most 500 CPA artifacts can be removed at once');
    const maps = this.cpaSelectionMaps(this.cpaArtifactRecords());
    const unique = new Map();
    for (const item of items) {
      const artifact = this.resolveCpaItem(item, maps);
      unique.set(this.cpaExportKey(artifact), artifact);
    }
    const targets = [...unique.values()].map((artifact) => {
      if (artifact.locked === true) throw new HttpError(409, `CPA artifact batch is locked: ${artifact.jobId}`);
      if (!artifact.deletable) throw new HttpError(409, `Finish or cancel the run before removing its CPA artifacts: ${artifact.runId}`);
      return artifact;
    });
    const removed = [];
    const missing = [];
    for (const target of targets) {
      try {
        fs.unlinkSync(target.filePath);
        if (target.assetId) {
          try { this.sessionAssets().update(target.assetId, { cpa: null }); } catch { /* Artifact removal remains authoritative. */ }
        }
        removed.push(this.cpaArtifactRef(target));
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        missing.push(this.cpaArtifactRef(target));
      }
    }
    if (removed.length) this.invalidateCpaArtifactScan();
    return { requested: targets.length, removed, missing };
  }

  removeMany(runIds, options = {}) {
    if (!Array.isArray(runIds) || runIds.length === 0) throw new HttpError(400, 'Select at least one run history');
    if (runIds.length > 500) throw new HttpError(400, 'At most 500 run histories can be removed at once');
    const ids = [...new Set(runIds.map(safeRunId))];
    for (const runId of ids) {
      if (this.activeRun(runId)) throw new HttpError(409, `Cannot delete the active run: ${runId}`);
      const state = this.load(runId);
      if (!TERMINAL_RUN_STATUSES.has(state.status)) throw new HttpError(409, `Cancel the run before deleting its history: ${runId}`);
    }
    return {
      requested: ids.length,
      removed: ids.map((runId) => this.remove(runId, options)),
    };
  }

  remove(runId, options = {}) {
    if (this.activeRun(runId)) throw new HttpError(409, 'Cannot delete an active run');
    const stateFile = this.findStateFile(runId);
    const state = loadV2State(stateFile);
    if (!TERMINAL_RUN_STATUSES.has(state.status)) throw new HttpError(409, 'Cancel the run before deleting its history');
    const retainedArtifacts = options.artifacts
      ? this.cpaArtifactRecords().filter((artifact) => artifact.runId === state.runId)
      : [];
    for (const file of [stateFile, `${stateFile}.bak`, `${stateFile}.lock`]) {
      try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    this.logStore.remove(runId);
    if (options.artifacts) {
      for (const artifact of retainedArtifacts) {
        if (artifact.locked === true) continue;
        if (artifact.assetId) {
          try { this.sessionAssets().update(artifact.assetId, { cpa: null }); } catch { /* The retained file remains authoritative. */ }
        }
        try { fs.unlinkSync(artifact.filePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
    }
    this.invalidateCpaArtifactScan();
    return { removed: true, runId, artifactsRemoved: Boolean(options.artifacts) };
  }

  async shutdown() {
    this.closed = true;
    const active = this.activeRuns();
    try {
      for (const scheduled of this.cleanupRetryTimers.values()) clearTimeout(scheduled.timer);
      this.cleanupRetryTimers.clear();
      for (const run of active) run.gate.request('pause');
      await Promise.all(active.map((run) => run.promise));
    } finally {
      this.closeCpaArtifactWatch();
      // The manager owns stores it created from config. An injected store may
      // be shared by the caller, so its watcher remains the caller's concern.
      if (!this.assetStoreOverride) this.assetStoreCache?.store?.close?.();
    }
  }
}

module.exports = {
  ControlGate,
  RunManager,
  TERMINAL_RUN_STATUSES,
  financialAmounts,
  preflightHttpError,
  proxyRecoveryWaitDetails,
  stateUsesBalanceAccount,
  terminalRunSummary,
};
