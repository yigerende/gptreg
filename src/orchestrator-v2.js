'use strict';
const runtimeSecrets = require('./platform/runtime-secrets');

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { secretFromEnv, validateV2Config } = require('./config-v2');
const { cpaFileNameForEmail } = require('./cpa-filename');
const { buildCpaAccount, buildRunManifest } = require('./cpa-output');
const { derivePlusAliases, deriveRegistrationEmails } = require('./email-alias');
const { exchangeTokens } = require('./oauth-pkce');
const { executePureHttpUrl } = require('./pure-url');
const { summarizeSmsPreflight } = require('./preflight-resources');
const { createProxyAllocator, loadProxyPool, probeProxy } = require('./proxy-pool');
const {
  LOGIN_STEPS,
  RUN_STEPS,
  makeInitialLoginState,
  makeInitialRegistrationState,
  migrateRegistrationState,
  runLoginFlow,
  runRegistrationFlow,
} = require('./registration-runner');
const {
  classifyRegistrationBlock,
  lastEvent,
  retryDelayMs,
  rewindToStep,
} = require('./registration-policy');
const { SmsBowerError, createSmsProvider, isSmsProviderError, sleep } = require('./sms-provider');
const { cancellationDetailsForBalance, summarizeSmsCost, summarizeSmsCosts } = require('./sms-cost-ledger');
const {
  applyBalanceCancellationSettlement,
  cancellationQuoteSettlementAmount,
} = require('./balance-reconciliation');
const { archiveSmsAcquisitionIntent, smsLeaseHasReceivedCode } = require('./sms-acquisition-ledger');
const { acquireExclusiveLock, configFingerprint } = require('./state-store');
const { XiaopingguoClient, isRetryableMailError } = require('./xiaopingguo-client');
const {
  isTerminalJobStatus,
  markJobSkipped,
  prepareJobForSkip,
  terminalJobStatusSet,
} = require('./job-lifecycle');
const { cloneJson, hashId, jobResultText } = require('./util/shared');

const TERMINAL_JOB_STATUSES = terminalJobStatusSet('orchestrator-v2');
const TERMINAL_RUN_STATUSES = new Set(['complete', 'partial', 'cancelled', 'failed']);
const NORMAL_LANE_DONE_STATUSES = new Set([...TERMINAL_JOB_STATUSES, 'pending_finalize']);
const RUNNABLE_JOB_STATUSES = new Set(['queued', 'runnable', 'waiting']);
const INVALID_PHONE_CODE_ERRORS = new Set(['invalid_phone_otp', 'invalid_otp', 'otp_invalid', 'invalid_input']);
const ABORTED_EMAIL_DRAIN_MS = 120000;
const SMS_INVENTORY_POLL_INTERVAL_MS = 8000;
const SMS_EFFECT_RECONCILE_INTERVAL_MS = 8000;
const SMS_EFFECT_RECONCILE_MAX_ATTEMPTS = 3;

function defaultNow() {
  return Date.now();
}

function nowMs(context = {}) {
  return Number((context.now || defaultNow)());
}

function nowIso(context = {}) {
  return new Date(nowMs(context)).toISOString();
}

function runStatePathV2(config, runId, options = {}) {
  const normalized = validateV2Config(config, options);
  return path.join(normalized.output.stateDir, `run-${runId}.json`);
}

function makeRunId(config = {}) {
  const tag = String(config.aliases?.runTag || 'gptre').replace(/[^a-z0-9_-]/gi, '').slice(0, 20) || 'gptre';
  return `v2-${tag}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

function makeInitialOrchestratorV2State(config, options = {}) {
  const normalized = validateV2Config(config, options);
  const at = new Date((options.now || defaultNow)()).toISOString();
  return {
    schemaVersion: 2,
    mode: 'gpt-re-orchestrator-v2',
    runId: options.runId || normalized.runId || makeRunId(normalized),
    configFingerprint: configFingerprint(normalized),
    status: 'initialized',
    createdAt: at,
    updatedAt: at,
    phase: 'normal',
    mailboxes: [],
    jobs: [],
    workers: [],
    proxyLeases: {},
    proxyHealth: {},
    proxyCandidates: [],
    finalizationQueue: [],
    smsMarkets: {},
    balanceReconciliation: null,
    externalCleanup: [],
    events: [],
    manifestPath: '',
    control: {
      requestedAction: null,
      requestedAt: '',
      pausedAt: '',
      resumedAt: '',
    },
  };
}

function ensureRuntimeState(state, config, context = {}) {
  state.phase = state.phase || 'normal';
  state.workers = Array.isArray(state.workers) ? state.workers : [];
  state.proxyLeases = state.proxyLeases && typeof state.proxyLeases === 'object' ? state.proxyLeases : {};
  state.proxyHealth = state.proxyHealth && typeof state.proxyHealth === 'object' ? state.proxyHealth : {};
  state.proxyCandidates = Array.isArray(state.proxyCandidates) ? state.proxyCandidates : [];
  state.finalizationQueue = Array.isArray(state.finalizationQueue) ? state.finalizationQueue : [];
  state.externalCleanup = Array.isArray(state.externalCleanup) ? state.externalCleanup : [];
  state.control = state.control && typeof state.control === 'object' && !Array.isArray(state.control)
    ? state.control
    : { requestedAction: null, requestedAt: '', pausedAt: '', resumedAt: '' };
  for (let index = state.workers.length; index < config.workers.maxConcurrency; index += 1) {
    state.workers.push({
      id: `worker-${index + 1}`,
      status: 'idle',
      mailboxId: null,
      proxyId: '',
      currentJobId: '',
      completedRoots: 0,
      createdAt: nowIso(context),
      updatedAt: nowIso(context),
    });
  }
  for (const mailbox of state.mailboxes || []) {
    mailbox.targetCount = Number(mailbox.targetCount || config.aliases.count);
    mailbox.maxAttempts = Number(mailbox.maxAttempts || config.aliases.maxAttempts);
    mailbox.attemptCount = Number(mailbox.attemptCount || (state.jobs || []).filter((job) => String(job.mailboxId) === String(mailbox.id)).length);
    mailbox.createdCount = Number(mailbox.createdCount || (state.jobs || []).filter((job) => String(job.mailboxId) === String(mailbox.id) && job.accountCreatedAt).length);
    mailbox.cpaCompletedCount = Number(mailbox.cpaCompletedCount || mailbox.successCount || 0);
    mailbox.nextAliasIndex = Number(mailbox.nextAliasIndex || mailbox.attemptCount + 1);
    mailbox.normalComplete = Boolean(mailbox.normalComplete);
    mailbox.proxy = mailbox.proxy || null;
    mailbox.proxyVerifiedAt = mailbox.proxyVerifiedAt || '';
    mailbox.proxyConsumedByJobId = mailbox.proxyConsumedByJobId || '';
    mailbox.workerId = mailbox.workerId || '';
  }
  for (const job of state.jobs || []) {
    // A job persisted before the RUN_STEPS insertion carries a `runner.next`
    // on the old numbering; move it before anything reads it.
    if (job.runner) job.runner = migrateRegistrationState(job.runner);
    if (!job.accountCreatedAt && createAccountSucceededExactly(job)) {
      const event = (job.runner?.events || []).find((candidate) => candidate.step === 'create_account' && candidate.status === 200);
      job.accountCreatedAt = event?.at || job.updatedAt || state.updatedAt || state.createdAt;
    }
    job.finalization = job.finalization || null;
    job.replacementOf = job.replacementOf || '';
    job.proxyFailure = job.proxyFailure || null;
    job.proxyVerifiedAt = job.proxyVerifiedAt || '';
    job.clientProfile = job.clientProfile || job.runner?.clientProfile || null;
    job.sms = job.sms || { current: null, attempts: [], pendingCleanup: [], effect: null };
    job.sms.attempts = Array.isArray(job.sms.attempts) ? job.sms.attempts : [];
    job.sms.acquisitions = Array.isArray(job.sms.acquisitions) ? job.sms.acquisitions : [];
    job.sms.pendingCleanup = Array.isArray(job.sms.pendingCleanup) ? job.sms.pendingCleanup : [];
    job.sms.codeRetryCount = Number(job.sms.codeRetryCount || 0);
    job.sms.sendRetryCount = Number(job.sms.sendRetryCount || 0);
    job.sms.codePollCount = Number(job.sms.codePollCount || 0);
  }
  return state;
}

function shuffleIds(values, random = Math.random) {
  const shuffled = [...values];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const sample = Number(random());
    const normalized = Number.isFinite(sample) ? Math.max(0, Math.min(sample, 0.999999999999)) : 0;
    const target = Math.floor(normalized * (index + 1));
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  return shuffled;
}

function ensureProxyCandidateOrder(state, entries, random = Math.random) {
  const availableIds = new Set(entries.map((entry) => entry.id));
  const retained = (state.proxyCandidates || []).filter((id) => availableIds.has(id));
  const retainedSet = new Set(retained);
  const added = entries.map((entry) => entry.id).filter((id) => !retainedSet.has(id));
  state.proxyCandidates = [...retained, ...shuffleIds(added, random)];
  return state.proxyCandidates;
}

function stateEvent(state, type, details = {}, context = {}) {
  const event = { at: nowIso(context), type, ...details };
  state.events.push(event);
  if (typeof context.onEvent === 'function') context.onEvent(event);
  return event;
}

function mailboxAccounts(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.accounts)) return value.accounts;
  return [];
}

function reconcilePersistedProxyLeases(state, proxyEntries) {
  const available = new Set(proxyEntries.map((entry) => entry.id));
  const expected = [];

  for (const mailbox of state.mailboxes || []) {
    if (!mailboxKeepsWorker(state, mailbox) || ['capped', 'released'].includes(mailbox.status)) continue;
    const laneJob = currentLaneJob(state, mailbox);
    const proxyId = mailbox.proxy?.id || laneJob?.proxy?.id || '';
    if (proxyId) expected.push([normalProxyOwner(mailbox), proxyId]);
  }
  for (const job of state.jobs || []) {
    if (job.finalization?.status === 'running' && job.proxy?.id) {
      const owner = proxyContinuityEnabled(state)
        ? normalProxyOwner(mailboxForJob(state, job))
        : finalizerProxyOwner(job);
      expected.push([owner, job.proxy.id]);
    }
  }

  const used = new Set();
  const leases = {};
  for (const [owner, proxyId] of expected) {
    if (!available.has(proxyId) || used.has(proxyId) || state.proxyHealth?.[proxyId]?.status === 'failed') continue;
    leases[owner] = proxyId;
    used.add(proxyId);
  }
  state.proxyLeases = leases;
  return leases;
}

function createContext(state, config, options = {}) {
  const normalized = validateV2Config(config, options);
  ensureRuntimeState(state, normalized, options);
  const mailClient = options.mailClient || new XiaopingguoClient({
    baseUrl: normalized.mail.baseUrl,
    origin: normalized.mail.origin,
    fetch: options.mailFetch || options.fetch,
  });
  const serializedSmsLeases = (state.jobs || []).flatMap((job) => [
    ...(job.sms?.attempts || []),
    ...(job.sms?.current ? [job.sms.current] : []),
  ]).filter((lease) => lease?.id || lease?.activationId);
  const smsProvider = options.smsProvider || createSmsProvider({
    ...normalized.sms,
    fetch: options.smsFetch,
    leases: serializedSmsLeases,
  });
  const proxyEntries = options.proxyEntries || (normalized.proxyPool.path
    ? loadProxyPool(normalized.proxyPool.path, { defaultProtocol: normalized.proxyPool.defaultProtocol || 'http' })
    : []);
  reconcilePersistedProxyLeases(state, proxyEntries);
  const proxyCandidateOrder = ensureProxyCandidateOrder(state, proxyEntries, options.random || Math.random);
  const proxyAllocator = createProxyAllocator(proxyEntries, state.proxyLeases, {
    healthState: state.proxyHealth,
    order: proxyCandidateOrder,
  });
  let checkpointTail = Promise.resolve();
  let smsTail = Promise.resolve();

  const context = {
    ...options,
    config: normalized,
    state,
    mailClient,
    smsProvider,
    proxyEntries,
    proxyAllocator,
    mailboxLocks: [],
    lockedMailboxIds: new Set(),
  };
  const proxySnapshot = proxyAllocator.snapshot();
  state.proxyLeases = proxySnapshot.leases;
  state.proxyHealth = proxySnapshot.health;
  state.proxyCounts = proxySnapshot.counts;
  context.checkpoint = async (reason = '') => {
    state.updatedAt = nowIso(context);
    if (reason) state.lastCheckpoint = { at: state.updatedAt, reason };
    checkpointTail = checkpointTail.then(async () => {
      if (options.saveState) {
        try {
          await options.saveState(state);
        } catch (cause) {
          const error = cause instanceof Error ? cause : new Error(String(cause));
          error.fatal = true;
          if (!error.code) error.code = 'ESTATECHECKPOINT';
          throw error;
        }
      }
      if (typeof options.onCheckpoint === 'function') {
        await options.onCheckpoint({ reason, at: state.updatedAt, state });
      }
    });
    return checkpointTail;
  };
  context.withSmsLock = async (fn) => {
    const run = smsTail.then(fn, fn);
    smsTail = run.catch(() => {});
    return run;
  };
  return context;
}

async function authenticateMail(context) {
  if (context.mailAuthenticated) return;
  if (context.mailClient.csrfToken) {
    context.mailAuthenticated = true;
    return;
  }
  const password = secretFromEnv(context.config.mail, 'passwordEnv');
  await context.mailClient.login(password);
  context.mailAuthenticated = true;
}

async function preflightOrchestratorV2(config, options = {}) {
  const normalized = validateV2Config(config, options);
  const scratch = makeInitialOrchestratorV2State(normalized, { ...options, runId: options.runId || 'preflight' });
  const context = createContext(scratch, normalized, options);
  let accounts;
  if (Array.isArray(normalized.mail.accounts) && normalized.mail.accounts.length) {
    accounts = normalized.mail.accounts;
  } else {
    await authenticateMail(context);
    accounts = mailboxAccounts(await context.mailClient.listAccounts());
  }
  const eligible = accounts.filter((account) => (
    account.email && account.tokenValid !== false && account.bound !== true && account.reusable !== false
  ));
  if (eligible.length === 0) {
    // The console shows this string verbatim, so it has to name the pool and
    // the count rather than leave the operator to guess what ran out.
    const error = new Error(`小苹果邮箱池没有可用的未绑定邮箱：共 ${accounts.length} 个，0 个可用（邮箱 Token 必须有效且未绑定）`);
    error.code = 'NO_ELIGIBLE_MAILBOX';
    error.provider = String(normalized.mail.provider || '');
    error.needed = Number(normalized.mail.count || 0);
    error.available = 0;
    throw error;
  }

  const smsResult = await context.smsProvider.preflight();
  const sms = summarizeSmsPreflight(smsResult, normalized.sms, { required: true });
  const mailReady = eligible.length >= normalized.mail.count;
  const requiredProxyCount = normalized.proxyPool.required
    ? Math.min(normalized.mail.count, normalized.workers.maxConcurrency)
    : 0;
  const proxyReady = !normalized.proxyPool.required || context.proxyEntries.length >= requiredProxyCount;
  if (sms.issue === 'SMS_PRICE_ABOVE_MAX') {
    throw new Error(sms.message.replace(/^SMS /, 'SMSBower '));
  }
  if (sms.issue === 'SMS_BALANCE_LOW') {
    throw new Error(sms.message.replace(/^SMS /, 'SMSBower '));
  }

  return {
    schemaVersion: 2,
    ready: mailReady && sms.ready && proxyReady,
    mail: {
      provider: normalized.mail.provider,
      ready: mailReady,
      eligible: eligible.length,
      requested: normalized.mail.count,
      selected: Math.min(eligible.length, normalized.mail.count),
    },
    sms,
    proxy: {
      required: normalized.proxyPool.required,
      requiredCount: requiredProxyCount,
      available: context.proxyEntries.length,
      ready: proxyReady,
    },
    checkedAt: nowIso(context),
  };
}

function mailboxLockPath(config, accountId) {
  return path.join(config.output.stateDir, 'mailbox-locks', `${hashId(accountId, 24)}.lock`);
}

function activeNormalMailboxes(state) {
  return (state.mailboxes || []).filter((mailbox) => (
    !mailbox.normalComplete && !['capped', 'released', 'complete'].includes(mailbox.status)
  ));
}

function proxyContinuityEnabled(state) {
  return Number(state.runPlan?.schemaVersion || 0) >= 2;
}

function mailboxHasPendingFinalization(state, mailbox) {
  return (state.jobs || []).some((job) => (
    String(job.mailboxId) === String(mailbox.id)
    && (
      ['queued', 'running'].includes(job.finalization?.status)
      || job.status === 'pending_finalize'
      || (job.finalization && !['complete', 'failed', 'cancelled', 'skipped'].includes(job.finalization.status))
    )
  ));
}

function mailboxKeepsWorker(state, mailbox) {
  return !mailbox.normalComplete
    || (proxyContinuityEnabled(state) && mailboxHasPendingFinalization(state, mailbox));
}

function idleWorkers(state) {
  return (state.workers || []).filter((worker) => worker.status === 'idle');
}

function resetWorker(worker, context) {
  worker.status = 'idle';
  worker.mailboxId = null;
  worker.proxyId = '';
  worker.currentJobId = '';
  worker.updatedAt = nowIso(context);
}

function reconcileWorkerAssignments(context) {
  const { state } = context;
  const claimedMailboxes = new Set();
  for (const worker of state.workers) {
    const mailbox = state.mailboxes.find((candidate) => String(candidate.id) === String(worker.mailboxId));
    const valid = mailbox
      && mailboxKeepsWorker(state, mailbox)
      && mailbox.workerId === worker.id
      && !claimedMailboxes.has(String(mailbox.id));
    if (!valid) {
      resetWorker(worker, context);
      continue;
    }
    claimedMailboxes.add(String(mailbox.id));
    worker.status = 'running';
    worker.proxyId = mailbox.proxy?.id || '';
  }
  for (const mailbox of state.mailboxes.filter((candidate) => mailboxKeepsWorker(state, candidate))) {
    const worker = state.workers.find((candidate) => candidate.id === mailbox.workerId);
    if (!worker || String(worker.mailboxId) !== String(mailbox.id) || worker.status !== 'running') {
      mailbox.workerId = '';
    }
  }
}

function proxyBinding(proxy, context) {
  if (!proxy) return null;
  return { id: proxy.id, url: proxy.url, sticky: false, assignedAt: nowIso(context) };
}

function workerSlot(workerOrId) {
  const id = typeof workerOrId === 'string' ? workerOrId : workerOrId?.id;
  const slot = Number(String(id || '').match(/^worker-(\d+)$/)?.[1] || 0);
  return Number.isInteger(slot) && slot > 0 ? slot : 0;
}

function proxyAllowedForWorker(proxy, workerOrId) {
  if (!Array.isArray(proxy?.workerSlots) || proxy.workerSlots.length === 0) return true;
  return proxy.workerSlots.includes(workerSlot(workerOrId));
}

function bindWorkerToMailbox(worker, mailbox, proxy, context) {
  const binding = proxyBinding(proxy, context);
  if (binding) {
    mailbox.proxy = binding;
    mailbox.proxyVerifiedAt = nowIso(context);
    mailbox.proxyConsumedByJobId = mailbox.proxyConsumedByJobId || '';
  }
  worker.status = 'running';
  worker.mailboxId = mailbox.id;
  worker.proxyId = binding?.id || mailbox.proxy?.id || '';
  worker.currentJobId = '';
  worker.updatedAt = nowIso(context);
  mailbox.workerId = worker.id;
  if (!['reserving', 'reserved'].includes(mailbox.status)) mailbox.status = 'active';
  context.state.normalWait = null;
  stateEvent(context.state, 'worker_bound', { workerId: worker.id, mailboxId: mailbox.id, proxyId: worker.proxyId }, context);
}

async function proxyForMailboxBinding(mailbox, worker, context) {
  if (context.proxyEntries.length === 0) return null;
  const owner = normalProxyOwner(mailbox);
  const snapshot = context.proxyAllocator.snapshot();
  const leasedId = snapshot.leases[owner] || '';
  const retained = proxyEntry(context, mailbox.proxy);
  if (retained && retained.id === leasedId && snapshot.health[retained.id]?.status !== 'failed') return retained;
  return acquireHealthyProxy(owner, context, {
    preferredId: mailbox.proxy?.id || '',
    worker,
  });
}

async function assignWorkers(context) {
  reconcileWorkerAssignments(context);
  const available = idleWorkers(context.state);
  const unassigned = activeNormalMailboxes(context.state).filter((mailbox) => !mailbox.workerId);
  for (const mailbox of unassigned) {
    const worker = available.shift();
    if (!worker) break;
    const proxy = await proxyForMailboxBinding(mailbox, worker, context);
    if (context.proxyEntries.length > 0 && !proxy) {
      context.state.normalWait = {
        code: 'proxy_pool_exhausted',
        message: 'No checked proxy is available for the next root worker',
        at: nowIso(context),
      };
      break;
    }
    if (context.config.proxyPool.required && !proxy) {
      context.state.normalWait = {
        code: 'healthy_proxy_required',
        message: 'A checked proxy is required before binding a root worker',
        at: nowIso(context),
      };
      break;
    }
    bindWorkerToMailbox(worker, mailbox, proxy, context);
  }
}

async function claimMailboxes(context, requestedSlots = context.config.workers.maxConcurrency) {
  const { state, config } = context;
  reconcileWorkerAssignments(context);
  if (state.mailboxes.length) {
    for (const mailbox of state.mailboxes.filter((item) => (
      ['reserving', 'reserved', 'active', 'waiting_proxy'].includes(item.status)
      || mailboxKeepsWorker(state, item)
    ))) {
      if (context.lockedMailboxIds.has(String(mailbox.id))) continue;
      const lock = acquireExclusiveLock(mailboxLockPath(config, mailbox.id), {
        runId: state.runId,
        kind: 'mailbox',
        accountId: mailbox.id,
      });
      context.mailboxLocks.push(lock);
      context.lockedMailboxIds.add(String(mailbox.id));
    }
    await assignWorkers(context);
    for (const mailbox of state.mailboxes.filter((item) => item.status === 'reserving' && item.workerId)) {
      try {
        if (typeof context.mailClient.reserveMailbox === 'function') {
          await authenticateMail(context);
          await context.mailClient.reserveMailbox(mailbox.id);
        }
        mailbox.status = 'reserved';
        mailbox.reservedAt = nowIso(context);
        mailbox.reserveError = '';
        await context.checkpoint('mailbox_reservation_reconciled');
      } catch (error) {
        if (error?.fatal === true) throw error;
        mailbox.reserveError = error.message;
        await context.checkpoint('mailbox_reservation_error');
        throw error;
      }
    }
  }

  const capacity = Math.min(idleWorkers(state).length, requestedSlots, config.workers.maxConcurrency);
  const remainingTarget = Math.max(0, config.mail.count - state.mailboxes.length);
  const claimCount = Math.min(capacity, remainingTarget);
  if (claimCount === 0) {
    return state.mailboxes;
  }
  const proxySnapshot = context.proxyAllocator.snapshot();
  if (
    (context.proxyEntries.length > 0 && proxySnapshot.available === 0)
    || (config.proxyPool.required && context.proxyEntries.length === 0)
  ) {
    state.normalWait = {
      code: config.proxyPool.required ? 'healthy_proxy_required' : 'proxy_pool_exhausted',
      message: 'No checked proxy is available for the next root worker',
      at: nowIso(context),
    };
    return state.mailboxes;
  }

  let accounts;
  if (Array.isArray(config.mail.accounts) && config.mail.accounts.length) {
    accounts = config.mail.accounts;
  } else {
    await authenticateMail(context);
    accounts = mailboxAccounts(await context.mailClient.listAccounts());
  }
  const existingIds = new Set(state.mailboxes.map((mailbox) => String(mailbox.id)));
  const candidates = accounts
    .filter((account) => account.email && account.tokenValid !== false && account.bound !== true && !existingIds.has(String(account.id)))
    .slice(0, claimCount);
  if (candidates.length === 0 && state.mailboxes.length === 0) {
    throw new Error('No eligible xiaopingguo mailbox could be claimed');
  }
  state.mailboxClaimExhausted = candidates.length === 0;

  const availableWorkers = idleWorkers(state);
  for (const account of candidates) {
    const worker = availableWorkers.shift();
    if (!worker) break;
    const lock = acquireExclusiveLock(mailboxLockPath(config, account.id), {
      runId: state.runId,
      kind: 'mailbox',
      accountId: account.id,
    });
    context.mailboxLocks.push(lock);
    context.lockedMailboxIds.add(String(account.id));
    const owner = normalProxyOwner(account);
    const proxy = context.proxyEntries.length > 0
      ? await acquireHealthyProxy(owner, context, { worker })
      : null;
    if ((context.proxyEntries.length > 0 || config.proxyPool.required) && !proxy) {
      context.proxyAllocator.release(owner);
      syncProxyState(context);
      context.lockedMailboxIds.delete(String(account.id));
      context.mailboxLocks = context.mailboxLocks.filter((candidate) => candidate !== lock);
      lock.release();
      state.normalWait = {
        code: config.proxyPool.required ? 'healthy_proxy_required' : 'proxy_pool_exhausted',
        message: 'No checked proxy is available for the next root worker',
        at: nowIso(context),
      };
      break;
    }
    const binding = proxyBinding(proxy, context);
    const mailbox = {
      id: account.id,
      rootEmail: account.email,
      status: 'reserving',
      reservationStartedAt: nowIso(context),
      reservedAt: '',
      successCount: 0,
      createdCount: 0,
      cpaCompletedCount: 0,
      targetCount: config.aliases.count,
      maxAttempts: config.aliases.maxAttempts,
      attemptCount: 0,
      nextAliasIndex: 1,
      normalComplete: false,
      workerId: '',
      proxy: binding,
      proxyVerifiedAt: binding ? nowIso(context) : '',
      proxyConsumedByJobId: '',
      stopReason: '',
    };
    state.mailboxes.push(mailbox);
    bindWorkerToMailbox(worker, mailbox, proxy, context);
    stateEvent(state, 'mailbox_reservation_started', { accountId: account.id }, context);
    await context.checkpoint('intent:mailbox_reserve');
    try {
      if (typeof context.mailClient.reserveMailbox === 'function') {
        await authenticateMail(context);
        await context.mailClient.reserveMailbox(account.id);
      }
      mailbox.status = 'reserved';
      mailbox.reservedAt = nowIso(context);
      stateEvent(state, 'mailbox_reserved', { accountId: account.id }, context);
      await context.checkpoint('mailbox_reserved');
    } catch (error) {
      if (error?.fatal === true) throw error;
      mailbox.reserveError = error.message;
      await context.checkpoint('mailbox_reservation_error');
      throw error;
    }
  }
  if (candidates.length < claimCount) {
    state.mailboxShortfall = {
      requested: config.mail.count,
      claimed: state.mailboxes.length,
      at: nowIso(context),
    };
  } else if (state.mailboxes.length >= config.mail.count) {
    state.mailboxClaimExhausted = false;
    delete state.mailboxShortfall;
  }
  return state.mailboxes;
}

function makeAliasJob(mailbox, alias, context, options = {}) {
  return {
    id: `job-${hashId(`${context.state.runId}|${mailbox.id}|${alias.email}`)}`,
    mailboxId: mailbox.id,
    parentEmail: mailbox.rootEmail,
    email: alias.email,
    emailStrategy: alias.strategy || 'plus',
    aliasIndex: alias.index,
    replacementOf: options.replacementOf || '',
    status: 'queued',
    phase: 'registration',
    branch: 'registration',
    nextRunAt: '',
    password: '',
    workspaceId: '',
    oauthCode: '',
    callbackUrl: '',
    tokens: null,
    cpaPath: '',
    proxy: null,
    proxyRotations: 0,
    proxyVerifiedAt: '',
    proxyFailure: null,
    clientProfile: null,
    finalization: null,
    runner: null,
    emailActivity: null,
    sms: {
      current: null,
      attempts: [],
      pendingCleanup: [],
      effect: null,
      replacementWindowUsed: 0,
      codeRetryCount: 0,
      sendRetryCount: 0,
    },
    attempts: {
      transient: 0,
      accountCreate: 0,
      phoneContinuity: 0,
      tokenExchange: 0,
    },
    error: null,
    createdAt: nowIso(context),
    startedAt: '',
    updatedAt: nowIso(context),
    completedAt: '',
  };
}

function ensureJobs(context) {
  const { state, config } = context;
  let added = 0;
  for (const mailbox of state.mailboxes) {
    const existing = state.jobs.filter((job) => String(job.mailboxId) === String(mailbox.id));
    if (existing.length) {
      mailbox.attemptCount = Math.max(Number(mailbox.attemptCount || 0), existing.length);
      mailbox.nextAliasIndex = Math.max(Number(mailbox.nextAliasIndex || 1), ...existing.map((job) => Number(job.aliasIndex || 0) + 1));
      continue;
    }
    const aliases = deriveRegistrationEmails(mailbox.rootEmail, config.aliases.count, {
      strategy: config.aliases.strategy,
      runTag: config.aliases.runTag,
      randomInt: context.aliasRandomInt,
    });
    for (const alias of aliases) {
      state.jobs.push(makeAliasJob(mailbox, alias, context));
      added += 1;
    }
    mailbox.attemptCount = aliases.length;
    mailbox.nextAliasIndex = aliases.length + 1;
  }
  if (added) stateEvent(state, 'jobs_created', { count: added, total: state.jobs.length }, context);
  return state.jobs;
}

function mailboxForJob(state, job) {
  return state.mailboxes.find((mailbox) => String(mailbox.id) === String(job.mailboxId));
}

function currentLaneJob(state, mailbox) {
  return state.jobs
    .filter((job) => String(job.mailboxId) === String(mailbox.id))
    .sort((left, right) => left.aliasIndex - right.aliasIndex)
    .find((job) => !NORMAL_LANE_DONE_STATUSES.has(job.status)) || null;
}

function jobsForMailbox(state, mailbox) {
  return (state.jobs || []).filter((job) => String(job.mailboxId) === String(mailbox.id));
}

function refreshMailboxProgress(mailbox, state) {
  const jobs = jobsForMailbox(state, mailbox);
  mailbox.attemptCount = jobs.length;
  mailbox.createdCount = jobs.filter(hasConfirmedAccountCreation).length;
  mailbox.cpaCompletedCount = jobs.filter((job) => job.status === 'complete' && job.cpaPath).length;
  mailbox.successCount = mailbox.cpaCompletedCount;
  mailbox.nextAliasIndex = Math.max(Number(mailbox.nextAliasIndex || 1), ...jobs.map((job) => Number(job.aliasIndex || 0) + 1), 1);
  return mailbox;
}

function appendReplacementAlias(job, context) {
  const mailbox = mailboxForJob(context.state, job);
  refreshMailboxProgress(mailbox, context.state);
  if (context.config.aliases.strategy === 'root') return null;
  if (mailbox.createdCount >= mailbox.targetCount || mailbox.attemptCount >= mailbox.maxAttempts) return null;
  const [alias] = derivePlusAliases(mailbox.rootEmail, 1, {
    runTag: context.config.aliases.runTag,
    startIndex: mailbox.nextAliasIndex,
    randomInt: context.aliasRandomInt,
    excludeEmails: jobsForMailbox(context.state, mailbox).map((candidate) => candidate.email),
  });
  const replacement = makeAliasJob(mailbox, alias, context, { replacementOf: job.id });
  context.state.jobs.push(replacement);
  mailbox.attemptCount += 1;
  mailbox.nextAliasIndex = alias.index + 1;
  stateEvent(context.state, 'alias_replacement_added', {
    mailboxId: mailbox.id,
    failedJobId: job.id,
    replacementJobId: replacement.id,
    aliasIndex: alias.index,
  }, context);
  return replacement;
}

function dueAt(job) {
  if (!job.nextRunAt) return 0;
  const parsed = Date.parse(job.nextRunAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

function jobIsDue(job, at) {
  if (!RUNNABLE_JOB_STATUSES.has(job.status)) return false;
  if (job.status !== 'waiting') return true;
  return Boolean(job.nextRunAt) && dueAt(job) <= at;
}

function scheduleJob(job, delayMs, status, phase, context, error = null) {
  job.status = status;
  job.phase = phase || job.phase;
  job.nextRunAt = delayMs > 0 ? new Date(nowMs(context) + delayMs).toISOString() : '';
  job.error = error;
  job.updatedAt = nowIso(context);
}

function markRunnable(job, phase, context) {
  scheduleJob(job, 0, 'runnable', phase || job.phase, context, null);
}

function syncProxyState(context) {
  const snapshot = context.proxyAllocator.snapshot();
  context.state.proxyLeases = snapshot.leases;
  context.state.proxyHealth = snapshot.health;
  context.state.proxyCounts = snapshot.counts;
  return snapshot;
}

function normalProxyOwner(mailbox) {
  return `mailbox:${mailbox.id}`;
}

function finalizerProxyOwner(job) {
  return `finalizer:${job.id}`;
}

function proxyEntry(context, proxyLike) {
  return context.proxyEntries.find((entry) => entry.id === proxyLike?.id || entry.url === proxyLike?.url) || null;
}

async function runProxyProbe(proxy, context) {
  if (!context.config.proxyPool.healthCheck.enabled) return { status: 204, latencyMs: 0, skipped: true };
  const timeoutMs = Math.max(1, Number(context.config.proxyPool.healthCheck.timeoutMs || 15000));
  const signal = context.control?.signal;
  const executor = context.proxyProbeExecutor || (async (request, probeContext) => executePureHttpUrl(request, {
    proxy: probeContext.proxy,
    timeoutMs: probeContext.timeoutMs,
    signal: probeContext.signal,
  }));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => {
      const error = new Error('Proxy health check interrupted by an operator request');
      error.code = 'CONTROL_REQUESTED';
      finish(reject, error);
    };
    const timer = setTimeout(() => {
      const error = new Error(`Proxy health check timed out after ${timeoutMs} ms`);
      error.code = 'ETIMEDOUT';
      finish(reject, error);
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve().then(() => probeProxy(proxy, {
      probeUrl: context.config.proxyPool.healthCheck.probeUrl,
      timeoutMs,
      signal,
      executor,
    })).then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

async function acquireHealthyProxy(ownerId, context, options = {}) {
  const preferredId = options.preferredId || '';
  context.proxyAllocator.release(ownerId);
  syncProxyState(context);
  const excluded = new Set(options.excludeIds || []);
  const configuredAssignments = context.config.workers.proxyAssignments || [];
  const maximumAttempts = configuredAssignments.length ? 3 : Number.POSITIVE_INFINITY;
  let attempts = 0;
  while (true) {
    const order = preferredId
      ? [preferredId, ...context.state.proxyCandidates.filter((id) => id !== preferredId)]
      : context.state.proxyCandidates;
    const candidate = context.proxyAllocator.beginCheck(`probe:${ownerId}`, {
      includeHealthy: true,
      excludeIds: [...excluded],
      order,
      isUsable: (entry) => proxyAllowedForWorker(entry, options.worker),
    });
    if (!candidate) return null;
    attempts += 1;
    syncProxyState(context);
    await context.checkpoint('intent:proxy_health_check');
    let result;
    try {
      result = await runProxyProbe(candidate, context);
    } catch (error) {
      if (error.code === 'CONTROL_REQUESTED' || schedulerControlAction(context)) {
        context.proxyAllocator.cancelCheck(candidate, { at: nowIso(context) });
        syncProxyState(context);
        stateEvent(context.state, 'proxy_health_interrupted', { proxyId: candidate.id }, context);
        await context.checkpoint('proxy_health_interrupted');
        return null;
      }
      context.proxyAllocator.completeCheck(candidate, false, {
        reason: error.message,
        at: nowIso(context),
      });
      let retired = false;
      if (candidate.resourceKind === 'countryPool'
        && candidate.countryCode
        && typeof context.retireCountryPoolProxy === 'function') {
        try {
          const outcome = await context.retireCountryPoolProxy({
            proxy: candidate,
            reason: error.message,
          });
          retired = outcome?.retired !== false;
        } catch (retireError) {
          stateEvent(context.state, 'proxy_country_pool_retire_failed', {
            proxyId: candidate.id,
            countryCode: candidate.countryCode,
            code: String(retireError?.code || 'PROXY_POOL_RETIRE_FAILED'),
            reason: String(retireError?.message || retireError),
          }, context);
        }
      }
      excluded.add(candidate.id);
      syncProxyState(context);
      stateEvent(context.state, 'proxy_health_failed', {
        proxyId: candidate.id,
        reason: error.message,
        retired,
      }, context);
      await context.checkpoint('proxy_health_failed');
      if (attempts >= maximumAttempts) return null;
      continue;
    }
    context.proxyAllocator.completeCheck(candidate, true, {
      latencyMs: result.latencyMs,
      httpStatus: result.status,
      at: nowIso(context),
    });
    const leased = context.proxyAllocator.acquire(ownerId, {
      requireHealthy: true,
      order: [candidate.id],
      isUsable: (entry) => proxyAllowedForWorker(entry, options.worker),
    });
    syncProxyState(context);
    await context.checkpoint('proxy_health_passed');
    return leased;
  }
}

function releaseJobProxy(job, context, options = {}) {
  const mailbox = mailboxForJob(context.state, job);
  const finalizerOwned = (job.finalization?.status === 'running' || options.finalizer === true)
    && !proxyContinuityEnabled(context.state);
  if (finalizerOwned) {
    context.proxyAllocator.release(finalizerProxyOwner(job));
  } else if (options.force === true && mailbox) {
    context.proxyAllocator.release(normalProxyOwner(mailbox));
    mailbox.proxy = null;
  }
  syncProxyState(context);
  if (job.proxy) job.proxyReleasedAt = nowIso(context);
  if (finalizerOwned || options.force === true) job.proxy = null;
}

function releaseMailboxProxy(mailbox, context) {
  context.proxyAllocator.release(normalProxyOwner(mailbox));
  mailbox.proxy = null;
  syncProxyState(context);
}

function currentRunnerStep(job) {
  const steps = job.branch === 'login' ? LOGIN_STEPS : RUN_STEPS;
  return steps[job.runner?.next || 0] || null;
}

async function ensureProxy(job, context) {
  if (context.proxyEntries.length === 0) {
    if (context.config.proxyPool.required) {
      scheduleJob(job, 0, 'waiting', 'waiting_proxy', context, {
        code: 'healthy_proxy_required',
        message: 'No proxy is available',
      });
    }
    return null;
  }
  const mailbox = mailboxForJob(context.state, job);
  const finalizing = job.finalization?.status === 'running';
  const continuity = proxyContinuityEnabled(context.state);
  const ownerId = finalizing && !continuity ? finalizerProxyOwner(job) : normalProxyOwner(mailbox);
  const snapshot = context.proxyAllocator.snapshot();
  if (
    job.proxy
    && job.proxyVerifiedAt
    && job.runner
    && snapshot.leases[ownerId] === job.proxy.id
    && snapshot.health[job.proxy.id]?.status !== 'failed'
  ) {
    return job.proxy;
  }
  if (
    !finalizing
    && !job.proxy
    && mailbox.proxy
    && mailbox.proxyVerifiedAt
    && !mailbox.proxyConsumedByJobId
    && snapshot.leases[ownerId] === mailbox.proxy.id
  ) {
    job.proxy = { ...mailbox.proxy };
    job.proxyVerifiedAt = mailbox.proxyVerifiedAt;
    mailbox.proxyConsumedByJobId = job.id;
    const worker = context.state.workers.find((candidate) => candidate.id === mailbox.workerId);
    if (worker) worker.currentJobId = job.id;
    await context.checkpoint('proxy_binding_consumed');
    return job.proxy;
  }
  if (finalizing && continuity && !mailbox.proxy) {
    scheduleJob(job, 30000, 'waiting', 'waiting_proxy_continuity', context, {
      code: 'original_proxy_unavailable',
      message: 'The root mailbox proxy is unavailable; finalization will not switch IP',
    });
    return null;
  }
  const preferredId = finalizing && !continuity ? '' : mailbox.proxy?.id;
  const worker = mailbox
    ? context.state.workers.find((candidate) => candidate.id === mailbox.workerId)
    : null;
  const proxy = await acquireHealthyProxy(ownerId, context, { preferredId, worker });
  if (!proxy) {
    scheduleJob(job, 30000, 'waiting', 'waiting_proxy', context, {
      code: 'proxy_pool_exhausted',
      message: 'No unleased proxy is available',
    });
    return null;
  }
  const binding = proxyBinding(proxy, context);
  job.proxy = binding;
  job.proxyVerifiedAt = nowIso(context);
  if (!finalizing || continuity) {
    mailbox.proxy = { ...binding };
    mailbox.proxyVerifiedAt = job.proxyVerifiedAt;
    mailbox.proxyConsumedByJobId = job.id;
    const worker = context.state.workers.find((candidate) => candidate.id === mailbox.workerId);
    if (worker) {
      worker.status = 'running';
      worker.proxyId = proxy.id;
      worker.currentJobId = job.id;
      worker.updatedAt = nowIso(context);
    }
  }
  syncProxyState(context);
  await context.checkpoint('proxy_assigned');
  return job.proxy;
}

async function ensureRunner(job, context) {
  if (job.runner) return job.runner;
  if (job.branch === 'login') {
    job.runner = makeInitialLoginState(context.har, {
      email: job.email,
      password: job.password,
      workspaceId: job.workspaceId,
      clientProfile: job.clientProfile,
    });
  } else {
    job.runner = makeInitialRegistrationState(context.har, {
      email: job.email,
      name: context.config.registration.name,
      birthdate: context.config.registration.birthdate,
      workspaceId: context.config.registration.workspaceId,
      clientProfile: job.clientProfile,
    });
    job.password = job.runner.password;
  }
  job.startedAt = job.startedAt || nowIso(context);
  job.status = 'runnable';
  await context.checkpoint('runner_initialized');
  return job.runner;
}

function syncJobFromRunner(job, context) {
  const runner = job.runner || {};
  job.password = runner.password || job.password;
  job.workspaceId = runner.inputs?.workspaceId || job.workspaceId || '';
  job.oauthCode = runner.oauthCode || job.oauthCode || '';
  job.callbackUrl = runner.oauth?.callbackUrl || job.callbackUrl || '';
  job.clientProfile = runner.clientProfile || job.clientProfile || null;
  job.updatedAt = nowIso(context);
  if (job.proxy && (runner.events || []).length) {
    job.proxy.sticky = true;
    if (job.finalization?.status !== 'running') {
      const mailbox = mailboxForJob(context.state, job);
      if (mailbox?.proxy?.id === job.proxy.id) mailbox.proxy.sticky = true;
    }
  }
}

function runnerOptions(job, context) {
  const registration = context.config.registration;
  return {
    once: true,
    proxy: job.proxy?.url || registration.proxy || '',
    dynamicSentinel: registration.dynamicSentinel !== false,
    // Same contract as the branch scheduler: requests come from the templates
    // declared in code unless an operator asks for a recording to be replayed.
    useHarTemplates: registration.protocolTemplates === 'capture',
    cloudflareJsd: Boolean(registration.cloudflareJsd),
    executor: context.executor,
    onStepIntent: async (_runner, step, effect) => {
      job.effect = { kind: 'runner', branch: job.branch, step: step.name, ...cloneJson(effect) };
      await context.checkpoint(`intent:${step.name}`);
    },
    onStepResult: async (_runner, step, result) => {
      job.effect = null;
      job.lastResponse = {
        step: step.name,
        status: result.response.status,
        retryAfterMs: Number(result.response.retryAfterMs || 0),
        at: nowIso(context),
      };
      syncJobFromRunner(job, context);
      await context.checkpoint(`result:${step.name}`);
    },
  };
}

async function advanceRunnerOnce(job, context) {
  const runner = await ensureRunner(job, context);
  if (job.branch === 'login') await runLoginFlow(context.har, runner, runnerOptions(job, context));
  else await runRegistrationFlow(context.har, runner, runnerOptions(job, context));
  syncJobFromRunner(job, context);
  await context.checkpoint('runner_advanced');
  return runner;
}

async function prepareEmailBaseline(job, context) {
  if (job.emailActivity?.baselineMessageIds?.length || job.emailActivity?.preparedAt) return true;
  await authenticateMail(context);
  let snapshot;
  try {
    snapshot = await context.mailClient.snapshotMailbox(job.mailboxId, {
      folders: context.config.mail.folders,
      limit: context.config.mail.maxResults,
    });
  } catch (error) {
    if (!isRetryableMailError(error)) throw error;
    scheduleJob(job, Math.max(context.config.mail.pollIntervalMs, Number(error.retryAfterMs || 0)), 'waiting', 'waiting_email_baseline', context, {
      code: `mail_http_${Number(error.status || 0)}`,
      message: error.message,
    });
    return false;
  }
  job.emailActivity = {
    status: 'prepared',
    baselineMessageIds: snapshot.messageIds,
    preparedAt: snapshot.capturedAt,
    deadlineAt: new Date(nowMs(context) + context.config.mail.timeoutMs).toISOString(),
    consumedMessageId: '',
  };
  await context.checkpoint('email_baseline_captured');
  return true;
}

async function pollEmailCode(job, context) {
  await authenticateMail(context);
  const activity = job.emailActivity || {};
  if (!activity.deadlineAt) {
    activity.deadlineAt = new Date(nowMs(context) + context.config.mail.timeoutMs).toISOString();
    job.emailActivity = activity;
  }
  if (Date.parse(activity.deadlineAt) <= nowMs(context)) {
    scheduleJob(job, 0, 'waiting', 'waiting_email_timeout', context, {
      code: 'email_code_timeout',
      message: 'Timed out waiting for a new verification message',
    });
    return;
  }

  let found;
  try {
    found = await context.mailClient.findVerificationCode(job.mailboxId, {
      folders: context.config.mail.folders,
      maxResults: context.config.mail.maxResults,
      keyword: context.config.mail.keyword,
      pollIntervalMs: context.config.mail.pollIntervalMs,
      recipient: job.email,
      since: activity.preparedAt,
      excludeMessageIds: activity.baselineMessageIds || [],
    });
    job.attempts.mailPollErrors = 0;
  } catch (error) {
    const status = Number(error.status || 0);
    if (!isRetryableMailError(error)) throw error;
    job.attempts.mailPollErrors = Number(job.attempts.mailPollErrors || 0) + 1;
    if (status >= 500 && job.attempts.mailPollErrors > 3) {
      scheduleJob(job, 0, 'waiting', 'waiting_email_provider', context, {
        code: `mail_http_${status}`,
        message: error.message,
      });
      return;
    }
    const backoff = status >= 500
      ? Math.min(30000, context.config.mail.pollIntervalMs * (2 ** (job.attempts.mailPollErrors - 1)))
      : context.config.mail.pollIntervalMs;
    scheduleJob(job, Math.max(backoff, Number(error.retryAfterMs || 0)), 'waiting', 'waiting_email', context, {
      code: `mail_http_${status}`,
      message: error.message,
    });
    return;
  }
  if (found?.code) {
    job.runner.inputs.emailCode = found.code;
    job.runner.blocked = null;
    if (activity.ambiguousSend) {
      // Re-enter at the Sentinel step: the challenge that `email_otp_validate`
      // consumes is minted there, so jumping straight to the validate would
      // send the request without its `openai-sentinel-*` headers.
      job.runner.next = RUN_STEPS.findIndex((item) => item.name === 'sentinel_email_otp_validate');
    }
    job.emailActivity = {
      ...activity,
      status: 'complete',
      consumedMessageId: found.consumedMessageId || found.messageId || '',
      receivedAt: found.receivedAt || nowIso(context),
      code: '<redacted:email_code>',
    };
    markRunnable(job, 'registration', context);
    await context.checkpoint('email_code_received');
    return;
  }
  scheduleJob(job, context.config.mail.pollIntervalMs, 'waiting', 'waiting_email', context);
}

function emailNeedsDrain(job) {
  if (job.emailActivity?.consumedMessageId) return false;
  const ambiguousSend = (job.runner?.inFlight || job.effect)?.step === 'email_otp_send';
  return job.emailActivity?.status === 'sent' || Boolean(job.emailActivity?.ambiguousSend) || ambiguousSend;
}

async function finishProxyFailedAlias(job, context) {
  const replacement = appendReplacementAlias(job, context);
  job.status = 'failed_proxy';
  job.phase = 'failed_proxy';
  job.nextRunAt = '';
  job.error = {
    code: 'confirmed_proxy_failure',
    message: job.proxyFailure?.message || 'Proxy failed during alias registration',
  };
  job.failedAt = nowIso(context);
  job.replacementJobId = replacement?.id || '';
  await context.checkpoint('proxy_failed_alias_finished');
}

async function drainAbortedEmail(job, context) {
  const activity = job.emailActivity || {};
  activity.drainDeadlineAt = activity.drainDeadlineAt
    || new Date(nowMs(context) + ABORTED_EMAIL_DRAIN_MS).toISOString();
  job.emailActivity = activity;
  await authenticateMail(context);
  let found = null;
  try {
    found = await context.mailClient.findVerificationCode(job.mailboxId, {
      folders: context.config.mail.folders,
      maxResults: context.config.mail.maxResults,
      keyword: context.config.mail.keyword,
      pollIntervalMs: context.config.mail.pollIntervalMs,
      recipient: job.email,
      since: activity.sentAt || activity.preparedAt,
      excludeMessageIds: activity.baselineMessageIds || [],
    });
  } catch (error) {
    const status = Number(error.status || 0);
    if (!isRetryableMailError(error)) throw error;
    scheduleJob(job, Math.max(context.config.mail.pollIntervalMs, Number(error.retryAfterMs || 0)), 'waiting', 'draining_aborted_email', context, {
      code: `mail_http_${status}`,
      message: error.message,
    });
    return;
  }

  if (found?.code) {
    job.emailActivity = {
      ...activity,
      status: 'drained',
      consumedMessageId: found.consumedMessageId || found.messageId || '',
      drainedAt: nowIso(context),
      code: '<redacted:email_code>',
    };
    await finishProxyFailedAlias(job, context);
    return;
  }
  if (Date.parse(activity.drainDeadlineAt) <= nowMs(context)) {
    const snapshot = await context.mailClient.snapshotMailbox(job.mailboxId, {
      folders: context.config.mail.folders,
      limit: context.config.mail.maxResults,
    });
    job.emailActivity = {
      ...activity,
      status: 'drain_timeout',
      drainTimedOut: true,
      drainedAt: nowIso(context),
      postDrainMessageIds: snapshot.messageIds,
    };
    await finishProxyFailedAlias(job, context);
    return;
  }
  scheduleJob(job, context.config.mail.pollIntervalMs, 'waiting', 'draining_aborted_email', context);
}

async function continueProxyAbort(job, context) {
  if (job.sms?.current) {
    try {
      await cancelCurrentSms(job, 'confirmed_proxy_failure', context);
    } catch (error) {
      scheduleJob(job, Math.max(30000, Number(error.retryAfterMs || 0)), 'waiting', 'waiting_proxy_abort_cleanup', context, {
        code: error.code || 'sms_cancel_failed',
        message: error.message,
      });
      return;
    }
  }
  if (emailNeedsDrain(job)) {
    scheduleJob(job, 0, 'waiting', 'draining_aborted_email', context);
    await drainAbortedEmail(job, context);
    return;
  }
  await finishProxyFailedAlias(job, context);
}

function marketKey(context) {
  const provider = context.smsProvider;
  return `${provider.name || context.config.sms.provider}:${provider.service || context.config.sms.service.code}:${provider.country || context.config.sms.country.id}`;
}

function marketState(context) {
  const key = marketKey(context);
  if (!context.state.smsMarkets[key]) {
    context.state.smsMarkets[key] = { fraudGuardStreak: 0, cooldownUntil: '', updatedAt: nowIso(context) };
  }
  return context.state.smsMarkets[key];
}

function pendingCleanupCount(state) {
  return pendingSmsCleanups(state).length;
}

function smsCapacityUsed(state) {
  const active = (state.jobs || []).filter((job) => {
    const status = job.sms?.current?.status;
    return status && !['complete', 'cancelled', 'released', 'banned', 'missing'].includes(status);
  }).length;
  return active + pendingCleanupCount(state);
}

async function processSmsCleanup(job, context) {
  const pending = job.sms.pendingCleanup || [];
  for (const lease of pending.filter((item) => item.status === 'pending_cleanup' && dueAt({ nextRunAt: item.cleanupAt }) <= nowMs(context))) {
    await context.withSmsLock(async () => {
      try {
        if (typeof context.smsProvider.reconcile === 'function') {
          const reconciled = await context.smsProvider.reconcile(lease);
          Object.assign(lease, reconciled);
          if (['cancelled', 'complete', 'missing'].includes(lease.status)) return;
        }
        const cancelled = await context.smsProvider.cancel(lease, lease.cancelReason || 'rejected');
        Object.assign(lease, cancelled, { status: 'cancelled' });
      } catch (error) {
        if ((error instanceof SmsBowerError && error.code === 'EARLY_CANCEL_DENIED') || error?.code === 'FIREFOX_RELEASE_TOO_EARLY') {
          lease.cleanupAt = new Date(nowMs(context) + Math.max(120000, error.retryAfterMs || 0)).toISOString();
        } else if (error?.retryable === true) {
          lease.cleanupError = error.message;
          lease.cleanupAt = new Date(nowMs(context) + Math.max(30000, error.retryAfterMs || 0)).toISOString();
        } else {
          throw error;
        }
      }
    });
    await context.checkpoint('sms_cleanup');
  }
}

function pendingSmsCleanups(state) {
  return (state.jobs || []).flatMap((job) => (job.sms?.pendingCleanup || [])
    .filter((item) => item.status === 'pending_cleanup')
    .map((item) => ({ job, item })));
}

async function processDueSmsCleanups(context) {
  const dueJobs = new Set(pendingSmsCleanups(context.state)
    .filter(({ item }) => !item.cleanupAt || Date.parse(item.cleanupAt) <= nowMs(context))
    .map(({ job }) => job));
  for (const job of dueJobs) await processSmsCleanup(job, context);
}

function markSmsLeaseCodeReceived(lease, context) {
  if (!smsLeaseHasReceivedCode(lease)) return false;
  lease.codeReceived = true;
  lease.codeReceivedAt = lease.codeReceivedAt || nowIso(context);
  return true;
}

function smsCleanupNeedsFinalCodeCheck(job, reason) {
  const normalizedReason = String(reason || '').trim().toUpperCase();
  return Boolean(job?.skipPending)
    || normalizedReason.includes('SMS_CODE_TIMEOUT');
}

async function cancelCurrentSms(job, reason, context, options = {}) {
  const lease = job.sms.current;
  if (!lease) return;
  const activationId = lease.activationId || lease.id;
  const mailbox = mailboxForJob(context.state, job);
  stateEvent(context.state, 'sms_cancel_started', {
    workerId: mailbox?.workerId || '',
    jobId: job.id,
    activationId,
    number: lease.number,
    reason,
    message: `准备清理号码 ${lease.number || activationId}：${reason}`,
  }, context);
  job.sms.effect = {
    kind: 'sms_cancel',
    activationId,
    reason,
    startedAt: nowIso(context),
  };
  await context.checkpoint('intent:sms_cancel');
  let activationRecorded = false;
  try {
    await context.withSmsLock(async () => {
      try {
        const recordReconciledTerminal = () => {
          if (!['cancelled', 'complete', 'missing'].includes(lease.status)) return false;
          job.sms.attempts.push({ ...lease, rejectReason: reason });
          stateEvent(context.state, 'sms_cancel_reconciled', {
            workerId: mailbox?.workerId || '',
            jobId: job.id,
            activationId,
            providerStatus: lease.providerStatus || lease.status,
            status: lease.status,
            reason,
            message: `SMS activation already ${lease.status}; cancellation was not repeated`,
          }, context);
          activationRecorded = true;
          return true;
        };
        if (typeof context.smsProvider.reconcile === 'function') {
          try {
            const reconciled = await context.smsProvider.reconcile(lease);
            Object.assign(lease, reconciled);
            markSmsLeaseCodeReceived(lease, context);
            if (['cancelled', 'complete', 'missing'].includes(lease.status)) {
              job.sms.attempts.push({ ...lease, rejectReason: reason });
              stateEvent(context.state, 'sms_cancel_reconciled', {
                workerId: mailbox?.workerId || '',
                jobId: job.id,
                activationId,
                providerStatus: lease.providerStatus || lease.status,
                status: lease.status,
                reason,
                message: `号码无需重复取消，平台状态为 ${lease.status}`,
              }, context);
              activationRecorded = true;
              return;
            }
          } catch (error) {
            stateEvent(context.state, 'sms_cancel_reconcile_failed', {
              workerId: mailbox?.workerId || '',
              jobId: job.id,
              activationId,
              code: error.code || 'sms_reconcile_failed',
              retryable: error.retryable === true,
              message: `取消前状态核对失败，将直接尝试取消：${error.message}`,
            }, context);
          }
        }
        // The first status read and setStatus(8) are themselves a race. A
        // final immediate read closes the timeout/skip window without adding
        // a fixed sleep to every cleanup.
        if ((options.finalCodeCheck === true || smsCleanupNeedsFinalCodeCheck(job, reason))
          && typeof context.smsProvider.reconcile === 'function'
          && !['cancelled', 'complete', 'missing'].includes(lease.status)
          && !smsLeaseHasReceivedCode(lease)) {
          try {
            const finalCheck = await context.smsProvider.reconcile(lease);
            Object.assign(lease, finalCheck);
            markSmsLeaseCodeReceived(lease, context);
            if (recordReconciledTerminal()) return;
          } catch (error) {
            stateEvent(context.state, 'sms_cancel_recheck_failed', {
              workerId: mailbox?.workerId || '',
              jobId: job.id,
              activationId,
              code: error.code || 'sms_recheck_failed',
              retryable: error.retryable === true,
              reason,
              message: `SMS final status check failed before cancellation: ${error.message}`,
            }, context);
          }
        }
        if (smsLeaseHasReceivedCode(lease)) {
          let completed;
          try {
            completed = await context.smsProvider.complete(lease);
          } catch (error) {
            if (!(error instanceof SmsBowerError) || error.code !== 'BAD_STATUS') throw error;
            completed = {
              ...lease,
              status: 'complete',
              providerStatus: lease.providerStatus || error.code,
              completedAt: nowIso(context),
            };
          }
          job.sms.attempts.push({ ...completed, rejectReason: reason });
          stateEvent(context.state, 'sms_completed_after_code', {
            workerId: mailbox?.workerId || '',
            jobId: job.id,
            activationId,
            providerStatus: completed.providerStatus || completed.status,
            reason,
            message: `验证码已产生，号码按已消费完成而不再取消：${reason}`,
          }, context);
          activationRecorded = true;
          return;
        }
        const cancelled = await context.smsProvider.cancel(lease, reason);
        job.sms.attempts.push({ ...cancelled, rejectReason: reason });
        stateEvent(context.state, 'sms_cancelled', {
          workerId: mailbox?.workerId || '',
          jobId: job.id,
          activationId,
          providerStatus: cancelled.providerStatus || cancelled.status,
          reason,
          message: `号码已取消：${reason}`,
        }, context);
        activationRecorded = true;
      } catch (error) {
        if (String(error?.code || '').toUpperCase() === 'BAD_STATUS'
          && typeof context.smsProvider.reconcile === 'function') {
          try {
            const lateCheck = await context.smsProvider.reconcile(lease);
            Object.assign(lease, lateCheck || {});
            markSmsLeaseCodeReceived(lease, context);
            if (recordReconciledTerminal()) return;
            if (smsLeaseHasReceivedCode(lease)) {
              let completed;
              try {
                completed = await context.smsProvider.complete(lease);
              } catch (completeError) {
                if (!(completeError instanceof SmsBowerError) || completeError.code !== 'BAD_STATUS') throw completeError;
                completed = {
                  ...lease,
                  status: 'complete',
                  providerStatus: lease.providerStatus || completeError.code,
                  completedAt: nowIso(context),
                };
              }
              job.sms.attempts.push({ ...completed, rejectReason: reason });
              stateEvent(context.state, 'sms_completed_after_code', {
                workerId: mailbox?.workerId || '',
                jobId: job.id,
                activationId,
                providerStatus: completed.providerStatus || completed.status,
                reason,
                message: 'SMS code arrived during cancellation; activation was completed instead',
              }, context);
              activationRecorded = true;
              return;
            }
          } catch {
            // Preserve the original cancellation error so the activation stays
            // recoverable if the late status read is unavailable as well.
          }
        }
        if (!((error instanceof SmsBowerError && error.code === 'EARLY_CANCEL_DENIED') || error?.code === 'FIREFOX_RELEASE_TOO_EARLY')) throw error;
        const pending = {
          ...lease,
          status: 'pending_cleanup',
          cancelReason: reason,
          cleanupAt: new Date(nowMs(context) + Math.max(120000, error.retryAfterMs || 0)).toISOString(),
        };
        job.sms.pendingCleanup.push(pending);
        job.sms.attempts.push({ ...pending });
        stateEvent(context.state, 'sms_cancel_deferred', {
          workerId: mailbox?.workerId || '',
          jobId: job.id,
          activationId,
          code: error.code,
          cleanupAt: pending.cleanupAt,
          reason,
          message: `平台暂不允许取消，已安排于 ${pending.cleanupAt} 重试`,
        }, context);
        activationRecorded = true;
      }
    });
  } catch (error) {
    stateEvent(context.state, 'sms_cancel_failed', {
      workerId: mailbox?.workerId || '',
      jobId: job.id,
      activationId,
      code: error.code || 'sms_cancel_failed',
      retryable: error.retryable === true,
      reason,
      message: `号码取消失败：${error.message}`,
    }, context);
    throw error;
  } finally {
    if (activationRecorded) {
      job.sms.current = null;
      job.sms.effect = null;
      if (job.runner?.inputs) {
        job.runner.inputs.phone = '';
        job.runner.inputs.phoneCode = '';
        job.runner.blocked = null;
      }
    }
  }
  if (activationRecorded) await context.checkpoint('sms_activation_rejected');
}

async function acquirePhone(job, context) {
  await processSmsCleanup(job, context);
  if (smsCapacityUsed(context.state) >= context.config.sms.maxPendingCancellations) {
    const cleanupAt = pendingSmsCleanups(context.state)
      .map(({ item }) => Date.parse(item.cleanupAt))
      .filter(Number.isFinite)
      .sort((a, b) => a - b)[0];
    scheduleJob(job, Math.max(1000, (cleanupAt || nowMs(context) + 30000) - nowMs(context)), 'waiting', 'waiting_sms_cleanup', context);
    return;
  }
  if (job.sms.replacementWindowUsed >= context.config.sms.replacementBudget) {
    scheduleJob(job, 0, 'waiting', 'waiting_sms_quality', context, {
      code: 'sms_replacement_budget_exhausted',
      message: `Used ${job.sms.replacementWindowUsed} numbers in the current replacement window`,
    });
    return;
  }
  const market = marketState(context);
  if (market.cooldownUntil && Date.parse(market.cooldownUntil) > nowMs(context)) {
    scheduleJob(job, Date.parse(market.cooldownUntil) - nowMs(context), 'waiting', 'waiting_sms_market_cooldown', context);
    return;
  }

  job.sms.inventoryStartedAt = job.sms.inventoryStartedAt || nowIso(context);
  const mailbox = mailboxForJob(context.state, job);
  const inventoryAttempt = Number(job.attempts.smsInventory || 0) + 1;
  const inventoryStartedMs = Date.parse(job.sms.inventoryStartedAt);
  stateEvent(context.state, 'sms_inventory_poll_started', {
    workerId: mailbox?.workerId || '',
    jobId: job.id,
    attempt: inventoryAttempt,
    service: context.smsProvider.service,
    country: context.smsProvider.country,
    maxPrice: context.config.sms.maxPrice,
    elapsedMs: Number.isFinite(inventoryStartedMs) ? Math.max(0, nowMs(context) - inventoryStartedMs) : 0,
    message: `取号轮询 #${inventoryAttempt}：国家 ${context.smsProvider.country}，服务 ${context.smsProvider.service}，上限 ${context.config.sms.provider === 'firefox' ? '¥' : '$'}${context.config.sms.maxPrice}`,
  }, context);
  job.sms.effect = {
    id: `sms-acquire-${crypto.randomUUID()}`,
    kind: 'sms_acquire',
    service: context.smsProvider.service,
    country: context.smsProvider.country,
    maxPrice: context.config.sms.maxPrice,
    request: {
      serviceCode: context.smsProvider.service,
      countryId: context.smsProvider.country,
      maxPrice: context.config.sms.maxPrice,
    },
    startedAt: nowIso(context),
  };
  await context.checkpoint('intent:sms_acquire');
  try {
    const lease = await context.withSmsLock(async () => {
      if (smsCapacityUsed(context.state) >= context.config.sms.maxPendingCancellations) return null;
      const acquired = await context.smsProvider.acquireNumber({
        serviceCode: context.smsProvider.service,
        countryId: context.smsProvider.country,
        maxPrice: context.config.sms.maxPrice,
      });
      job.sms.current = acquired;
      return acquired;
    });
    if (!lease) {
      job.sms.effect = null;
      scheduleJob(job, 30000, 'waiting', 'waiting_sms_cleanup', context);
      return;
    }
    job.sms.replacementWindowUsed += 1;
    job.sms.codePollCount = 0;
    job.sms.codeRetryCount = 0;
    job.sms.sendRetryCount = 0;
    job.sms.codeDeadlineAt = '';
    job.sms.receivedCode = '';
    job.runner.inputs.phone = lease.number;
    job.runner.inputs.phoneCode = '';
    job.runner.blocked = null;
    job.sms.inventoryStartedAt = '';
    job.sms.effect = null;
    stateEvent(context.state, 'sms_number_acquired', {
      workerId: mailbox?.workerId || '',
      jobId: job.id,
      attempt: inventoryAttempt,
      activationId: lease.activationId || lease.id,
      country: lease.country || '',
      number: lease.number,
      cost: lease.cost,
      currency: lease.currency || 'USD',
      operator: lease.operator || '',
      providerStatus: lease.providerStatus || lease.status,
      message: `取号成功：${lease.number}，activation ${lease.activationId || lease.id}，费用 ${lease.currency === 'CNY' ? '¥' : '$'}${lease.cost ?? '未知'}`,
    }, context);
    markRunnable(job, 'registration', context);
    await context.checkpoint('sms_number_acquired');
  } catch (error) {
    if (error?.invalidLease) {
      const invalidLease = {
        ...error.invalidLease,
        cleanupAt: error.invalidLease.status === 'pending_cleanup'
          ? new Date(nowMs(context) + 120000).toISOString()
          : '',
        rejectReason: error.code || 'invalid_provider_number',
      };
      job.sms.effect = null;
      job.sms.replacementWindowUsed += 1;
      job.sms.attempts.push(invalidLease);
      if (invalidLease.status === 'pending_cleanup') job.sms.pendingCleanup.push({ ...invalidLease });
      stateEvent(context.state, 'sms_number_normalization_rejected', {
        workerId: mailbox?.workerId || '',
        jobId: job.id,
        activationId: invalidLease.activationId || invalidLease.id,
        rawNumber: invalidLease.number,
        country: invalidLease.country || context.smsProvider.country,
        dialingCode: invalidLease.countryCode,
        providerCountryCode: invalidLease.providerCountryCode,
        cleanupStatus: invalidLease.status,
        code: error.code,
        message: `接码平台号码格式与国家不一致，已${invalidLease.status === 'cancelled' ? '取消' : '安排清理'} activation ${invalidLease.activationId || invalidLease.id}`,
      }, context);
      scheduleJob(job, 1000, 'waiting', 'waiting_sms_invalid_number', context, {
        code: error.code,
        message: error.message,
      });
      return;
    }
    if (isSmsProviderError(error) && error.category === 'availability') {
      job.sms.effect = null;
      const started = Date.parse(job.sms.inventoryStartedAt);
      if (Number.isFinite(started) && nowMs(context) - started >= context.config.sms.inventoryWaitMs) {
        stateEvent(context.state, 'sms_inventory_poll_exhausted', {
          workerId: mailbox?.workerId || '',
          jobId: job.id,
          attempt: inventoryAttempt,
          code: error.code,
          elapsedMs: nowMs(context) - started,
          message: `取号轮询已到等待上限：${error.code}`,
        }, context);
        scheduleJob(job, 0, 'waiting', 'waiting_sms_inventory', context, {
          code: error.code,
          message: error.message,
        });
      } else {
        const attempt = Number(job.attempts.smsInventory || 0) + 1;
        job.attempts.smsInventory = attempt;
        const delay = Math.max(error.retryAfterMs || 0, SMS_INVENTORY_POLL_INTERVAL_MS);
        stateEvent(context.state, 'sms_inventory_poll_waiting', {
          workerId: mailbox?.workerId || '',
          jobId: job.id,
          attempt,
          code: error.code,
          category: error.category,
          retryAfterMs: Number(error.retryAfterMs || 0),
          delayMs: delay,
          elapsedMs: Number.isFinite(started) ? Math.max(0, nowMs(context) - started) : 0,
          message: `取号轮询 #${attempt} 暂无可用号码，${Math.ceil(delay / 1000)} 秒后重试（${error.code}）`,
        }, context);
        scheduleJob(job, delay, 'waiting', 'waiting_sms_inventory_retry', context, {
          code: error.code,
          message: error.message,
        });
      }
      return;
    }
    stateEvent(context.state, 'sms_inventory_poll_failed', {
      workerId: mailbox?.workerId || '',
      jobId: job.id,
      attempt: inventoryAttempt,
      code: error.code || 'sms_acquire_failed',
      category: error.category || '',
      retryable: error.retryable === true,
      message: `取号失败：${error.message}`,
    }, context);
    throw error;
  }
}

async function markSmsSent(job, context, options = {}) {
  if (!job.sms.current || job.sms.current.status === 'sms_sent' || job.sms.current.status === 'code_received') return;
  job.sms.effect = {
    kind: 'sms_mark_sent',
    activationId: job.sms.current.activationId || job.sms.current.id,
    startedAt: nowIso(context),
  };
  await context.checkpoint('intent:sms_mark_sent');
  const updated = await context.withSmsLock(() => context.smsProvider.markSmsSent(job.sms.current));
  job.sms.current = { ...job.sms.current, ...updated, waitingStartedAt: nowIso(context) };
  job.sms.codeDeadlineAt = new Date(nowMs(context) + context.config.sms.codeTimeoutMs).toISOString();
  job.sms.effect = null;
  if (options.deferCheckpoint !== true) await context.checkpoint('sms_marked_sent');
}

function clearSmsCodeState(job) {
  job.sms.codeDeadlineAt = '';
  job.sms.codePollCount = 0;
  job.sms.receivedCode = '';
  if (job.runner?.inputs) job.runner.inputs.phoneCode = '';
}

function rewindForPhoneOtpSend(job, context) {
  clearSmsCodeState(job);
  rewindToStep(job.runner, RUN_STEPS, 'phone_otp_send');
  markRunnable(job, 'registration', context);
}

async function retryPhoneOtpSendOnSameNumber(job, context, reason) {
  job.sms.sendRetryCount = Number(job.sms.sendRetryCount || 0) + 1;
  rewindForPhoneOtpSend(job, context);
  const mailbox = mailboxForJob(context.state, job);
  const activationId = job.sms.current?.activationId || job.sms.current?.id || '';
  stateEvent(context.state, 'sms_same_number_resend_scheduled', {
    workerId: mailbox?.workerId || '',
    jobId: job.id,
    activationId,
    number: job.sms.current?.number || '',
    reason,
    attempt: job.sms.sendRetryCount,
    message: `验证码等待超时，将在同一号码上重新发送：activation ${activationId}`,
  }, context);
  await context.checkpoint('sms_same_number_resend_scheduled');
}

async function replaceSmsActivation(job, context, reason) {
  const mailbox = mailboxForJob(context.state, job);
  const activationId = job.sms.current?.activationId || job.sms.current?.id || '';
  const number = job.sms.current?.number || '';
  job.sms.effect = null;
  rewindForPhoneOtpSend(job, context);
  stateEvent(context.state, 'sms_replacement_scheduled', {
    workerId: mailbox?.workerId || '',
    jobId: job.id,
    activationId,
    number,
    reason,
    message: `当前 activation 无法继续接收有效验证码，清理后换号：${reason}`,
  }, context);
  if (job.sms.current) await cancelCurrentSms(job, reason, context);
  markRunnable(job, 'registration', context);
  await context.checkpoint('sms_replacement_scheduled');
}

async function requestAnotherSms(job, context, reason) {
  if (!job.sms.current) throw new Error('Cannot request another SMS without an activation');
  const nextRetryCount = Number(job.sms.codeRetryCount || 0) + 1;
  job.sms.effect = {
    kind: 'sms_request_another',
    activationId: job.sms.current.activationId || job.sms.current.id,
    reason,
    nextRetryCount,
    reconcileAttempts: 0,
    startedAt: nowIso(context),
  };
  await context.checkpoint('intent:sms_request_another');
  let updated;
  try {
    updated = await context.withSmsLock(() => context.smsProvider.requestAnotherCode(job.sms.current));
  } catch (error) {
    if (error instanceof SmsBowerError && error.retryable !== true) job.sms.effect = null;
    throw error;
  }
  job.sms.current = { ...job.sms.current, ...updated };
  job.sms.codeRetryCount = nextRetryCount;
  job.sms.effect = null;
  rewindForPhoneOtpSend(job, context);
  await context.checkpoint('sms_request_another_accepted');
  return job.sms.current;
}

async function pollSmsCode(job, context) {
  const lease = job.sms.current;
  if (!lease) {
    scheduleJob(job, 0, 'waiting', 'waiting_sms_missing_lease', context, {
      code: 'sms_lease_missing',
      message: 'Cannot poll SMS without a persisted activation',
    });
    return;
  }
  if (lease.status === 'leased' || lease.status === 'retry_requested') {
    await markSmsSent(job, context);
  }
  if (!job.sms.codeDeadlineAt) {
    job.sms.codeDeadlineAt = new Date(nowMs(context) + context.config.sms.codeTimeoutMs).toISOString();
  }
  const mailbox = mailboxForJob(context.state, job);
  const pollAttempt = Number(job.sms.codePollCount || 0) + 1;
  job.sms.codePollCount = pollAttempt;
  const activationId = lease.activationId || lease.id;
  const remainingBeforePoll = Math.max(0, Date.parse(job.sms.codeDeadlineAt) - nowMs(context));
  stateEvent(context.state, 'sms_code_poll_started', {
    workerId: mailbox?.workerId || '',
    jobId: job.id,
    attempt: pollAttempt,
    activationId,
    deadlineAt: job.sms.codeDeadlineAt,
    remainingMs: remainingBeforePoll,
    message: `验证码轮询 #${pollAttempt}：activation ${activationId}，剩余 ${Math.ceil(remainingBeforePoll / 1000)} 秒`,
  }, context);
  let result;
  let observation = null;
  try {
    result = await context.smsProvider.pollCode(lease, {
      timeoutMs: 0,
      pollIntervalMs: 0,
      onPoll: (next) => { observation = next; },
    });
  } catch (error) {
    if (error?.retryable !== true) throw error;
    const remaining = Date.parse(job.sms.codeDeadlineAt) - nowMs(context);
    if (remaining > 0) {
      const delay = Math.min(remaining, Math.max(context.config.sms.pollIntervalMs, Number(error.retryAfterMs || 0)));
      stateEvent(context.state, 'sms_code_poll_retry', {
        workerId: mailbox?.workerId || '',
        jobId: job.id,
        attempt: pollAttempt,
        activationId,
        code: error.code || 'sms_poll_retry',
        retryAfterMs: Number(error.retryAfterMs || 0),
        delayMs: delay,
        nextPollAt: new Date(nowMs(context) + delay).toISOString(),
        message: `验证码轮询 #${pollAttempt} 请求失败，${Math.ceil(delay / 1000)} 秒后重试（${error.code || 'sms_poll_retry'}）`,
      }, context);
      scheduleJob(job, delay, 'waiting', 'waiting_sms_code', context, {
        code: error.code || 'sms_poll_retry',
        message: error.message,
      });
      return;
    }
    result = null;
  }
  if (result?.code) {
    job.runner.inputs.phoneCode = result.code;
    job.runner.blocked = null;
    job.sms.current = { ...lease, status: 'code_received', codeReceivedAt: result.receivedAt || nowIso(context) };
    job.sms.receivedCode = '<redacted:phone_code>';
    stateEvent(context.state, 'sms_code_received', {
      workerId: mailbox?.workerId || '',
      jobId: job.id,
      attempt: pollAttempt,
      activationId,
      providerStatus: result.providerStatus || observation?.providerStatus || 'STATUS_OK',
      receivedAt: result.receivedAt || nowIso(context),
      message: `验证码已收到：activation ${activationId}，第 ${pollAttempt} 次轮询命中`,
    }, context);
    markRunnable(job, 'phone_continuity', context);
    await context.checkpoint('sms_code_received');
    return;
  }
  if (job.sms.codeDeadlineAt && Date.parse(job.sms.codeDeadlineAt) <= nowMs(context)) {
    stateEvent(context.state, 'sms_code_poll_timeout', {
      workerId: mailbox?.workerId || '',
      jobId: job.id,
      attempt: pollAttempt,
      activationId,
      providerStatus: observation?.providerStatus || '',
      retryCount: job.sms.sendRetryCount,
      message: `验证码轮询超时：activation ${activationId}`,
    }, context);
    if (Number(job.sms.sendRetryCount || 0) < 1) {
      await retryPhoneOtpSendOnSameNumber(job, context, 'sms_code_timeout');
      return;
    }
    await replaceSmsActivation(job, context, 'sms_code_timeout_after_same_number_resend');
    return;
  }
  const delay = context.config.sms.pollIntervalMs;
  stateEvent(context.state, 'sms_code_poll_waiting', {
    workerId: mailbox?.workerId || '',
    jobId: job.id,
    attempt: pollAttempt,
    activationId,
    providerStatus: observation?.providerStatus || 'STATUS_WAIT_CODE',
    providerState: observation?.status || 'waiting',
    delayMs: delay,
    nextPollAt: new Date(nowMs(context) + delay).toISOString(),
    message: `验证码轮询 #${pollAttempt}：${observation?.providerStatus || 'STATUS_WAIT_CODE'}，${Math.ceil(delay / 1000)} 秒后继续`,
  }, context);
  scheduleJob(job, delay, 'waiting', 'waiting_sms_code', context);
}

async function completeSms(job, context) {
  if (!job.sms.current || job.sms.current.status === 'complete') return;
  job.sms.effect = {
    kind: 'sms_complete',
    activationId: job.sms.current.activationId || job.sms.current.id,
    startedAt: nowIso(context),
  };
  await context.checkpoint('intent:sms_complete');
  const completed = await context.withSmsLock(() => context.smsProvider.complete(job.sms.current));
  job.sms.current = { ...job.sms.current, ...completed };
  if (!completedSmsAttemptRecorded(job)) {
    job.sms.attempts.push(cloneJson(job.sms.current));
  }
  job.sms.effect = null;
  await context.checkpoint('sms_activation_complete');
}

function createAccountSucceededExactly(job) {
  return (job.runner?.events || []).some((event) => event.step === 'create_account' && event.status === 200);
}

function legacyTargetTouched(job = {}) {
  const runner = job.runner || {};
  const durableStep = (runner.events || []).some((item) => (
    ['user_register', 'email_otp_validate', 'create_account'].includes(item.step)
    && Number(item.status) >= 200
    && Number(item.status) < 300
  ));
  return durableStep
    || /\/log-in\/password/i.test(String(runner.lastContinueUrl || ''))
    || Boolean(job.accountCreatedAt);
}

function mailboxHasLegacyTargetTouch(state, mailbox) {
  return (state.jobs || []).some((job) => (
    String(job.mailboxId) === String(mailbox.id) && legacyTargetTouched(job)
  ));
}

function hasConfirmedAccountCreation(job) {
  return Boolean(job.accountCreatedAt) || createAccountSucceededExactly(job);
}

function confirmedSmsCostUsd(job, ledger = summarizeSmsCost(job)) {
  return ledger.confirmedConsumedUsd > 0 ? ledger.confirmedConsumedUsd : null;
}

async function recordAccountCreated(job, context) {
  if (!job.accountCreatedAt) {
    job.accountCreatedAt = nowIso(context);
    const mailbox = mailboxForJob(context.state, job);
    mailbox.createdCount = Number(mailbox.createdCount || 0) + 1;
    stateEvent(context.state, 'account_created', { mailboxId: mailbox.id, jobId: job.id }, context);
  }
  job.attempts.phoneContinuity = 0;
  await completeSms(job, context);
}

async function queueFinalization(job, reason, context) {
  if (!hasConfirmedAccountCreation(job)) {
    scheduleJob(job, 0, 'waiting', 'waiting_reconcile_create_account', context, {
      code: 'missing_account_creation_proof',
      message: 'Cannot finalize an alias without exact create_account success evidence',
    });
    return false;
  }
  job.finalization = {
    status: 'queued',
    attempts: Number(job.finalization?.attempts || 0),
    reason,
    queuedAt: job.finalization?.queuedAt || nowIso(context),
    originalProxyId: job.proxyFailure?.proxyId || job.proxy?.id || '',
    lastError: '',
  };
  job.registrationCompleted = {
    accountCreatedAt: job.accountCreatedAt,
    workspaceId: job.workspaceId,
    lastStep: lastEvent(job.runner)?.step || '',
  };
  job.runner = null;
  job.effect = null;
  job.branch = 'login';
  job.oauthCode = '';
  job.callbackUrl = '';
  job.tokens = null;
  scheduleJob(job, 0, 'pending_finalize', 'pending_finalize', context, {
    code: 'post_create_proxy_failure',
    message: reason,
  });
  if (!context.state.finalizationQueue.includes(job.id)) context.state.finalizationQueue.push(job.id);
  stateEvent(context.state, 'finalization_queued', { jobId: job.id, mailboxId: job.mailboxId }, context);
  await context.checkpoint('finalization_queued');
  return true;
}

function completedSmsAttemptRecorded(job) {
  const activationId = String(job.sms?.current?.id || job.sms?.current?.activationId || '');
  return Boolean(activationId) && (job.sms?.attempts || []).some((item) => (
    String(item.id || item.activationId) === activationId && item.status === 'complete'
  ));
}

async function ensureSmsCompletedAfterCreate(job, context) {
  if (!job.sms?.current || !createAccountSucceededExactly(job)) return;
  job.accountCreatedAt = job.accountCreatedAt || nowIso(context);
  if (job.sms.current.status === 'complete' && completedSmsAttemptRecorded(job) && !job.sms.effect) return;
  if (job.sms.current.status !== 'complete' && typeof context.smsProvider.reconcile === 'function') {
    const reconciled = await context.withSmsLock(() => context.smsProvider.reconcile(job.sms.current));
    job.sms.current = { ...job.sms.current, ...reconciled };
  }
  if (job.sms.current.status !== 'complete') {
    await completeSms(job, context);
    return;
  }
  if (!completedSmsAttemptRecorded(job)) {
    job.sms.attempts.push(cloneJson(job.sms.current));
  }
  job.sms.effect = null;
  await context.checkpoint('sms_activation_reconciled_complete');
}

async function reconcileSmsEffect(job, context) {
  const effect = job.sms?.effect;
  if (!effect) return false;

  if (effect.kind === 'sms_acquire') {
    if (job.sms.current) {
      job.runner.inputs.phone = job.sms.current.number;
      job.runner.blocked = null;
      job.sms.effect = null;
      markRunnable(job, 'registration', context);
      await context.checkpoint('reconciled:sms_acquire_with_lease');
    } else {
      scheduleJob(job, 0, 'waiting', 'waiting_sms_acquire_reconcile', context, {
        code: 'ambiguous_sms_acquire',
        message: 'SMSBower has no idempotency key; verify the activation before retrying acquisition',
      });
      await context.checkpoint('ambiguous:sms_acquire');
    }
    return true;
  }

  const current = job.sms.current;
  const activationId = String(current?.activationId || current?.id || '');
  if (!current || !activationId || activationId !== String(effect.activationId || '')) {
    scheduleJob(job, 0, 'waiting', 'waiting_sms_effect_reconcile', context, {
      code: 'sms_effect_activation_mismatch',
      message: `Cannot reconcile ${effect.kind} without its activation`,
    });
    await context.checkpoint('ambiguous:sms_effect_activation');
    return true;
  }

  if (typeof context.smsProvider.reconcile === 'function') {
    const reconciled = await context.withSmsLock(() => context.smsProvider.reconcile(current));
    job.sms.current = { ...current, ...reconciled };
  }

  if (effect.kind === 'sms_complete') return false;

  if (effect.kind === 'sms_cancel') {
    if (['cancelled', 'missing'].includes(job.sms.current.status)) {
      job.sms.attempts.push({ ...job.sms.current, rejectReason: effect.reason || 'reconciled_cancel' });
      job.sms.current = null;
      job.sms.effect = null;
      job.runner.inputs.phone = '';
      job.runner.inputs.phoneCode = '';
      job.runner.blocked = null;
      markRunnable(job, 'registration', context);
      await context.checkpoint('reconciled:sms_cancel');
      return true;
    }
    job.sms.effect = null;
    await cancelCurrentSms(job, effect.reason || 'reconciled_cancel', context);
    markRunnable(job, 'registration', context);
    return true;
  }

  if (effect.kind === 'sms_mark_sent') {
    if (!['sms_sent', 'code_received', 'complete'].includes(job.sms.current.status)) {
      const updated = await context.withSmsLock(() => context.smsProvider.markSmsSent(job.sms.current));
      job.sms.current = { ...job.sms.current, ...updated };
    }
    job.sms.current.waitingStartedAt = job.sms.current.waitingStartedAt || nowIso(context);
    job.sms.codeDeadlineAt = job.sms.codeDeadlineAt
      || new Date(nowMs(context) + context.config.sms.codeTimeoutMs).toISOString();
    job.sms.effect = null;
    await context.checkpoint('reconciled:sms_mark_sent');
    return false;
  }

  if (effect.kind === 'sms_request_another') {
    if (job.sms.current.status === 'retry_requested') {
      job.sms.codeRetryCount = Math.max(job.sms.codeRetryCount, Number(effect.nextRetryCount || 1));
      job.sms.effect = null;
      rewindForPhoneOtpSend(job, context);
      await context.checkpoint('reconciled:sms_request_another');
      return true;
    }
    if (['complete', 'cancelled', 'missing'].includes(job.sms.current.status)) {
      job.sms.effect = null;
      await replaceSmsActivation(job, context, 'sms_request_another_activation_closed');
      return true;
    }

    effect.reconcileAttempts = Number(effect.reconcileAttempts || 0) + 1;
    const mailbox = mailboxForJob(context.state, job);
    const activationId = job.sms.current.activationId || job.sms.current.id;
    if (effect.reconcileAttempts >= SMS_EFFECT_RECONCILE_MAX_ATTEMPTS) {
      stateEvent(context.state, 'sms_request_another_reconcile_exhausted', {
        workerId: mailbox?.workerId || '',
        jobId: job.id,
        activationId,
        attempt: effect.reconcileAttempts,
        providerStatus: job.sms.current.providerStatus || job.sms.current.status,
        message: `连续 ${effect.reconcileAttempts} 次未确认 status 3，停止重放旧验证码并换号`,
      }, context);
      job.sms.effect = null;
      await replaceSmsActivation(job, context, 'ambiguous_sms_request_another_exhausted');
      return true;
    }
    stateEvent(context.state, 'sms_request_another_reconcile_waiting', {
      workerId: mailbox?.workerId || '',
      jobId: job.id,
      activationId,
      attempt: effect.reconcileAttempts,
      providerStatus: job.sms.current.providerStatus || job.sms.current.status,
      delayMs: SMS_EFFECT_RECONCILE_INTERVAL_MS,
      message: `status 3 结果暂不明确，${SMS_EFFECT_RECONCILE_INTERVAL_MS / 1000} 秒后自动核对`,
    }, context);
    scheduleJob(job, SMS_EFFECT_RECONCILE_INTERVAL_MS, 'waiting', 'waiting_sms_request_reconcile', context, {
      code: 'ambiguous_sms_request_another',
      message: 'SMSBower status 3 outcome is being reconciled automatically',
    });
    await context.checkpoint('ambiguous:sms_request_another');
    return true;
  }
  return false;
}

function incrementFraudMarket(code, context) {
  const market = marketState(context);
  if (code === 'fraud_guard') market.fraudGuardStreak += 1;
  else market.fraudGuardStreak = 0;
  if (market.fraudGuardStreak >= context.config.sms.fraudGuardThreshold) {
    market.cooldownUntil = new Date(nowMs(context) + context.config.sms.fraudGuardCooldownMs).toISOString();
    market.fraudGuardStreak = 0;
  }
  market.updatedAt = nowIso(context);
  return market;
}

async function startFallbackLogin(job, reason, context) {
  if (!hasConfirmedAccountCreation(job)) {
    scheduleJob(job, 0, 'waiting', 'blocked_login_without_creation_proof', context, {
      code: 'missing_account_creation_proof',
      message: 'Refusing fallback login without a successful create_account event',
    });
    return;
  }
  job.branch = 'login';
  job.phase = 'fallback_login';
  job.status = 'runnable';
  job.nextRunAt = '';
  job.oauthCode = '';
  job.callbackUrl = '';
  job.tokens = null;
  job.runner = makeInitialLoginState(context.har, {
    email: job.email,
    password: job.password,
    workspaceId: job.workspaceId,
    clientProfile: job.clientProfile,
  });
  job.fallbackReason = reason;
  job.fallbackStartedAt = nowIso(context);
  await context.checkpoint('fallback_login_started');
}

async function handleRegistrationBlock(job, context) {
  const block = classifyRegistrationBlock(job.runner);
  if (block.action === 'wait_email') return pollEmailCode(job, context);
  if (block.action === 'acquire_phone') return acquirePhone(job, context);
  if (block.action === 'wait_sms_code') return pollSmsCode(job, context);
  if (block.action === 'replace_phone') {
    incrementFraudMarket(block.code, context);
    await cancelCurrentSms(job, block.code, context);
    markRunnable(job, 'registration', context);
    return;
  }
  if (block.action === 'fallback_login') return startFallbackLogin(job, block.code, context);
  if (block.action === 'migrate_existing_account') {
    scheduleJob(job, 0, 'waiting', 'waiting_existing_account_recovery', context, {
      code: block.code,
      message: block.message,
    });
    return;
  }
  if (block.action === 'retry_phone_continuity') {
    markRunnable(job, 'phone_continuity', context);
    return;
  }
  if (block.action === 'retry_account_create') {
    job.attempts.accountCreate += 1;
    if (job.attempts.accountCreate > 3) {
      if (job.sms.current) await cancelCurrentSms(job, block.code || 'account_creation_limited', context);
      capMailbox(job, block.code || 'account_creation_limited', context);
      return;
    }
    rewindToStep(job.runner, RUN_STEPS, 'sentinel_oauth_create_account');
    const delay = Math.max(block.event?.retryAfterMs || 0, retryDelayMs(job.attempts.accountCreate));
    scheduleJob(job, delay, 'waiting', 'registration', context, { code: block.code, message: block.message });
    return;
  }
  if (block.action === 'retry_transient') {
    job.attempts.transient += 1;
    if (job.attempts.transient <= 3) {
      job.runner.blocked = null;
      scheduleJob(job, Math.max(block.event?.retryAfterMs || 0, retryDelayMs(job.attempts.transient)), 'waiting', job.phase, context, {
        code: block.code || `http_${block.status}`,
        message: block.message,
      });
      return;
    }
  }
  if (block.step === 'phone_otp_validate' && INVALID_PHONE_CODE_ERRORS.has(block.code)) {
    clearSmsCodeState(job);
    const canRetryActivation = job.sms.current
      && job.sms.current.canGetAnotherSms !== false
      && Number(job.sms.codeRetryCount || 0) < 1;
    if (canRetryActivation) {
      try {
        await requestAnotherSms(job, context, 'invalid_phone_code');
        return;
      } catch (error) {
        if (!(error instanceof SmsBowerError) || error.code !== 'BAD_STATUS') throw error;
        const mailbox = mailboxForJob(context.state, job);
        stateEvent(context.state, 'sms_request_another_unavailable', {
          workerId: mailbox?.workerId || '',
          jobId: job.id,
          activationId: job.sms.current?.activationId || job.sms.current?.id || '',
          code: error.code,
          message: '平台拒绝当前 activation 的 status 3，旧验证码已清除，将换号继续',
        }, context);
      }
    }
    const reason = job.sms.current?.canGetAnotherSms === false
      ? 'sms_activation_does_not_support_another_code'
      : (Number(job.sms.codeRetryCount || 0) >= 1
        ? 'sms_invalid_code_retry_exhausted'
        : 'sms_request_another_bad_status');
    await replaceSmsActivation(job, context, reason);
    return;
  }
  if (job.finalization?.status === 'running') {
    const error = new Error(block.message || `Finalization blocked at ${block.step || 'login'}`);
    error.code = block.code || 'finalization_blocked';
    await resetFinalizationAttempt(job, error, context);
    return;
  }
  scheduleJob(job, 0, 'waiting', `blocked_${block.step || 'registration'}`, context, {
    code: block.code || `http_${block.status || 'error'}`,
    message: block.message || 'Registration requires operator action',
  });
}

function capMailbox(job, reason, context) {
  const mailbox = mailboxForJob(context.state, job);
  mailbox.status = 'capped';
  mailbox.stopReason = reason;
  mailbox.stoppedAt = nowIso(context);
  mailbox.normalComplete = true;
  scheduleJob(job, 0, 'skipped', 'root_capped', context, { code: reason, message: 'Root mailbox creation limit reached' });
  releaseMailboxWorker(mailbox, context);
  for (const candidate of context.state.jobs) {
    if (String(candidate.mailboxId) !== String(job.mailboxId) || candidate.id === job.id || TERMINAL_JOB_STATUSES.has(candidate.status)) continue;
    scheduleJob(candidate, 0, 'skipped', 'root_capped', context, { code: reason, message: 'Skipped after root mailbox circuit breaker' });
    releaseJobProxy(candidate, context);
  }
}

async function runPhoneContinuity(job, context) {
  while (true) {
    if (job.runner.blocked) {
      const block = classifyRegistrationBlock(job.runner);
      if (block.action !== 'retry_phone_continuity') {
        await handleRegistrationBlock(job, context);
        return;
      }

      job.attempts.phoneContinuity += 1;
      rewindToStep(job.runner, RUN_STEPS, 'sentinel_oauth_create_account');
      if (job.attempts.phoneContinuity > 3) {
        scheduleJob(job, 0, 'waiting', 'waiting_phone_continuity', context, {
          code: block.code,
          message: block.message,
        });
        await context.checkpoint('phone_continuity_paused');
        return;
      }

      const delay = retryDelayMs(job.attempts.phoneContinuity);
      scheduleJob(job, delay, 'waiting', 'phone_continuity', context, {
        code: block.code,
        message: block.message,
      });
      await context.checkpoint('phone_continuity_retry_scheduled');
      return;
    }

    const step = currentRunnerStep(job);
    if (!step || !['phone_otp_validate', 'sentinel_oauth_create_account', 'create_account'].includes(step.name)) {
      markRunnable(job, 'registration', context);
      return;
    }
    await advanceRunnerOnce(job, context);
    const event = lastEvent(job.runner);
    if (!job.runner.blocked) {
      if (event?.step === 'create_account' && event.status === 200) {
        await recordAccountCreated(job, context);
        markRunnable(job, 'registration', context);
        return;
      }
      continue;
    }
  }
}

function writeJsonAtomic(filePath, value) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(runtimeSecrets.protect(value), null, 2)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temporary, resolved);
  } catch (error) {
    if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(error.code) || !fs.existsSync(resolved)) throw error;
    const displaced = `${resolved}.replaced`;
    if (fs.existsSync(displaced)) fs.unlinkSync(displaced);
    fs.renameSync(resolved, displaced);
    try {
      fs.renameSync(temporary, resolved);
      fs.unlinkSync(displaced);
    } catch (replaceError) {
      if (!fs.existsSync(resolved) && fs.existsSync(displaced)) fs.renameSync(displaced, resolved);
      throw replaceError;
    }
  }
  return resolved;
}

function deterministicFinalizationError(error) {
  return /identity|email.+(?:mismatch|does not match)|account.+(?:mismatch|does not match)|callback|oauth state|malformed|missing (?:access|id)_token|invalid exp|password.+invalid/i.test(error?.message || '');
}

async function failFinalization(job, error, context) {
  job.finalization = {
    ...(job.finalization || {}),
    status: 'failed',
    failedAt: nowIso(context),
    lastError: error.message,
  };
  job.status = 'finalize_failed';
  job.phase = 'finalize_failed';
  job.nextRunAt = '';
  job.completedAt = nowIso(context);
  job.effect = null;
  job.error = { code: error.code || 'finalization_failed', message: error.message };
  releaseJobProxy(job, context, { finalizer: true });
  stateEvent(context.state, 'finalization_failed', { jobId: job.id, attempts: job.finalization.attempts }, context);
  await context.checkpoint('finalization_failed');
}

async function resetFinalizationAttempt(job, error, context) {
  if (deterministicFinalizationError(error) || Number(job.finalization?.attempts || 0) >= 3) {
    await failFinalization(job, error, context);
    return false;
  }
  releaseJobProxy(job, context, { finalizer: true });
  job.finalization = {
    ...job.finalization,
    status: 'queued',
    lastError: error.message,
    lastAttemptAt: nowIso(context),
  };
  job.runner = null;
  job.effect = null;
  job.oauthCode = '';
  job.callbackUrl = '';
  job.tokens = null;
  job.proxy = null;
  job.proxyVerifiedAt = '';
  scheduleJob(job, 0, 'pending_finalize', 'pending_finalize', context, {
    code: error.code || 'finalization_retry',
    message: error.message,
  });
  await context.checkpoint('finalization_retry_queued');
  return true;
}

async function startFinalizationAttempt(job, context) {
  if (Number(job.finalization?.attempts || 0) >= 3) {
    await failFinalization(job, new Error(job.finalization?.lastError || 'Finalization retry budget exhausted'), context);
    return false;
  }
  job.finalization = {
    ...(job.finalization || {}),
    status: 'running',
    attempts: Number(job.finalization?.attempts || 0) + 1,
    attemptStartedAt: nowIso(context),
  };
  job.branch = 'login';
  job.effect = null;
  job.runner = makeInitialLoginState(context.har, {
    email: job.email,
    password: job.password,
    workspaceId: job.workspaceId,
    clientProfile: job.clientProfile,
  });
  job.oauthCode = '';
  job.callbackUrl = '';
  job.tokens = null;
  if (proxyContinuityEnabled(context.state)) {
    const mailbox = mailboxForJob(context.state, job);
    job.proxy = mailbox.proxy ? { ...mailbox.proxy } : null;
    job.proxyVerifiedAt = mailbox.proxyVerifiedAt || '';
  } else {
    job.proxy = null;
    job.proxyVerifiedAt = '';
  }
  markRunnable(job, 'finalization', context);
  stateEvent(context.state, 'finalization_attempt_started', {
    jobId: job.id,
    attempt: job.finalization.attempts,
  }, context);
  await context.checkpoint('finalization_attempt_started');
  return true;
}

async function exchangeJobTokens(job, context) {
  const finalizing = job.finalization?.status === 'running';
  job.effect = { kind: 'oauth_token_exchange', startedAt: nowIso(context), codePresent: Boolean(job.oauthCode) };
  await context.checkpoint('intent:oauth_token_exchange');
  try {
    const result = await exchangeTokens({ code: job.oauthCode, oauth: job.runner.oauth }, {
      executor: context.tokenExecutor
        ? (request) => context.tokenExecutor(request, job)
        : (request) => executePureHttpUrl(request, {
          proxy: job.proxy?.url || '',
          timeoutMs: context.config.registration.tokenTimeoutMs || 60000,
        }),
    });
    const completedAt = nowIso(context);
    const account = buildCpaAccount({
      jobId: job.id,
      email: job.email,
      workspaceId: job.workspaceId,
      tokens: result.tokens,
      completedAt,
    });
    job.tokens = result.tokens;
    job.tokenResponse = { status: result.response.status, contentType: result.response.contentType };
    job.effect = null;
    job.completedAt = completedAt;
    job.status = 'complete';
    job.phase = 'complete';
    job.nextRunAt = '';
    job.cpaPath = writeJsonAtomic(path.join(
      context.config.output.cpaDir,
      context.state.runId,
      'accounts',
      cpaFileNameForEmail(job.email),
    ), account);
    if (job.finalization) {
      job.finalization.status = 'complete';
      job.finalization.completedAt = completedAt;
    }
    const mailbox = mailboxForJob(context.state, job);
    refreshMailboxProgress(mailbox, context.state);
    mailbox.status = finalizing
      ? (mailbox.cpaCompletedCount >= mailbox.createdCount ? 'complete' : 'partial')
      : 'active';
    releaseJobProxy(job, context, { finalizer: finalizing });
    await context.checkpoint('oauth_tokens_saved');
  } catch (error) {
    if (error?.fatal === true) throw error;
    job.effect = null;
    job.attempts.tokenExchange += 1;
    if (job.finalization?.status === 'running') {
      await resetFinalizationAttempt(job, error, context);
      return;
    }
    if (hasConfirmedAccountCreation(job) && job.attempts.tokenExchange <= 3) {
      await startFallbackLogin(job, 'oauth_token_exchange_failed', context);
      return;
    }
    scheduleJob(job, 0, 'waiting', 'waiting_token_exchange', context, {
      code: error.code || 'token_exchange_failed',
      message: error.message,
    });
  }
}

async function reconcileInFlight(job, context) {
  const effect = job.runner?.inFlight || job.effect;
  if (!effect) return false;
  const step = effect.step;
  if (step === 'email_otp_send') {
    job.runner.inFlight = null;
    job.effect = null;
    job.emailActivity = { ...(job.emailActivity || {}), ambiguousSend: true };
    job.runner.blocked = { step: 'sentinel_email_otp_validate', missing: ['emailCode'] };
    scheduleJob(job, 0, 'runnable', 'waiting_email', context);
    await pollEmailCode(job, context);
    await context.checkpoint('reconciled:email_otp_send');
    return true;
  }
  if (effect.kind === 'oauth_token_exchange') {
    job.effect = null;
    await startFallbackLogin(job, 'ambiguous_token_exchange', context);
    return true;
  }
  scheduleJob(job, 0, 'waiting', `waiting_reconcile_${step || 'effect'}`, context, {
    code: 'ambiguous_side_effect',
    message: `Manual reconciliation is required for ${step || effect.kind}`,
  });
  await context.checkpoint('ambiguous_effect');
  return true;
}

function isProxyLikeError(error) {
  return /proxy|socks|connect|network socket|tls|tunnel|ECONN|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ECONNRESET/i.test(`${error?.code || ''} ${error?.message || ''}`);
}

function resetReplayableSentinelIntent(job) {
  const effect = job.runner?.inFlight || job.effect;
  if (!job.runner || !effect?.step) return '';
  const step = RUN_STEPS.find((candidate) => candidate.name === effect.step);
  if (step?.type !== 'sentinel') return '';
  job.runner.inFlight = null;
  job.effect = null;
  rewindToStep(job.runner, RUN_STEPS, step.name);
  return step.name;
}

function ambiguousCreateEffect(job) {
  const effect = job.runner?.inFlight || job.effect;
  return effect?.step === 'create_account';
}

async function confirmProxyFailure(job, error, context) {
  const entry = proxyEntry(context, job.proxy);
  if (!entry || !context.config.proxyPool.healthCheck.enabled) return false;
  try {
    const result = await runProxyProbe(entry, context);
    stateEvent(context.state, 'proxy_runtime_recheck_passed', {
      proxyId: entry.id,
      httpStatus: result.status,
      latencyMs: result.latencyMs,
    }, context);
    return false;
  } catch (probeError) {
    const mailbox = mailboxForJob(context.state, job);
    const preserveForContinuity = proxyContinuityEnabled(context.state) && Boolean(job.proxy?.sticky);
    job.proxyFailure = {
      proxyId: entry.id,
      message: error.message,
      probeError: probeError.message,
      confirmedAt: nowIso(context),
      preservedForContinuity: preserveForContinuity,
    };
    if (preserveForContinuity) {
      stateEvent(context.state, 'proxy_runtime_failure_preserved', {
        proxyId: entry.id,
        jobId: job.id,
        mailboxId: job.mailboxId,
      }, context);
      await context.checkpoint('proxy_runtime_failure_preserved');
      return true;
    }
    context.proxyAllocator.fail(entry, probeError.message || error.message);
    if (mailbox?.proxy?.id === entry.id) mailbox.proxy = null;
    const worker = mailbox ? context.state.workers.find((candidate) => candidate.id === mailbox.workerId) : null;
    if (worker?.proxyId === entry.id) worker.proxyId = '';
    syncProxyState(context);
    stateEvent(context.state, 'proxy_runtime_failure_confirmed', {
      proxyId: entry.id,
      jobId: job.id,
      mailboxId: job.mailboxId,
    }, context);
    await context.checkpoint('proxy_runtime_failure_confirmed');
    return true;
  }
}

async function handleProcessError(job, error, context) {
  if (job.sms?.effect?.kind === 'sms_request_another') {
    const mailbox = mailboxForJob(context.state, job);
    stateEvent(context.state, 'sms_request_another_reconcile_scheduled', {
      workerId: mailbox?.workerId || '',
      jobId: job.id,
      activationId: job.sms.effect.activationId || '',
      code: error.code || error.name || 'sms_request_another_error',
      delayMs: SMS_EFFECT_RECONCILE_INTERVAL_MS,
      message: `status 3 请求结果不明确，${SMS_EFFECT_RECONCILE_INTERVAL_MS / 1000} 秒后自动核对`,
    }, context);
    scheduleJob(job, SMS_EFFECT_RECONCILE_INTERVAL_MS, 'waiting', 'waiting_sms_request_reconcile', context, {
      code: 'ambiguous_sms_request_another',
      message: error.message,
    });
    return;
  }
  if (!isProxyLikeError(error)) {
    if (job.finalization?.status === 'running') {
      await resetFinalizationAttempt(job, error, context);
      return;
    }
    scheduleJob(job, 0, 'waiting', 'waiting_error', context, {
      code: error.code || error.name || 'job_error',
      message: error.message,
    });
    return;
  }

  const confirmed = await confirmProxyFailure(job, error, context);
  if (!confirmed) {
    const replayedSentinelStep = resetReplayableSentinelIntent(job);
    job.attempts.transient = Number(job.attempts.transient || 0) + 1;
    if (job.attempts.transient <= 3) {
      if (replayedSentinelStep) {
        stateEvent(context.state, 'sentinel_transient_retry_scheduled', {
          jobId: job.id,
          step: replayedSentinelStep,
          attempt: job.attempts.transient,
          code: error.code || 'sentinel_network_error',
          message: `Sentinel 网络请求中断，已重建意图并安排第 ${job.attempts.transient} 次重试`,
        }, context);
      }
      scheduleJob(job, retryDelayMs(job.attempts.transient), 'waiting', job.phase, context, {
        code: 'proxy_recheck_passed_transient_error',
        message: error.message,
      });
    } else {
      scheduleJob(job, 0, 'waiting', 'waiting_error', context, {
        code: error.code || 'transient_retry_exhausted',
        message: error.message,
      });
    }
    return;
  }

  if (job.proxyFailure?.preservedForContinuity) {
    scheduleJob(job, 30000, 'waiting', 'waiting_proxy_continuity', context, {
      code: 'original_proxy_unavailable',
      message: 'The bound proxy failed after the flow started; waiting without changing IP',
    });
    return;
  }

  if (ambiguousCreateEffect(job)) {
    scheduleJob(job, 0, 'waiting', 'waiting_reconcile_create_account', context, {
      code: 'ambiguous_create_account_after_proxy_failure',
      message: 'Proxy failed while create_account outcome was ambiguous; manual reconciliation is required',
    });
    return;
  }
  if (hasConfirmedAccountCreation(job)) {
    await queueFinalization(job, error.message, context);
    return;
  }
  job.proxy = null;
  job.proxyVerifiedAt = '';
  scheduleJob(job, 0, 'waiting', 'waiting_proxy_abort_cleanup', context, {
    code: 'confirmed_proxy_failure',
    message: error.message,
  });
  await continueProxyAbort(job, context);
}

async function processJob(job, context) {
  try {
    if (TERMINAL_JOB_STATUSES.has(job.status)) return;
    if (job.status === 'waiting' && dueAt(job) > nowMs(context)) return;
    const mailbox = mailboxForJob(context.state, job);
    const worker = mailbox ? context.state.workers.find((candidate) => candidate.id === mailbox.workerId) : null;
    if (worker && job.finalization?.status !== 'running') {
      worker.currentJobId = job.id;
      worker.updatedAt = nowIso(context);
    }
    if (['waiting_proxy_abort_cleanup', 'draining_aborted_email'].includes(job.phase)) {
      if (job.phase === 'draining_aborted_email') await drainAbortedEmail(job, context);
      else await continueProxyAbort(job, context);
      return;
    }
    markRunnable(job, job.phase, context);
    await ensureProxy(job, context);
    if (job.status === 'waiting') return;
    await ensureRunner(job, context);
    if (await reconcileSmsEffect(job, context)) return;
    if (await reconcileInFlight(job, context)) return;
    await ensureSmsCompletedAfterCreate(job, context);
    if (job.phase === 'token_exchange') return exchangeJobTokens(job, context);
    if (job.phase === 'phone_continuity') return await runPhoneContinuity(job, context);

    if (job.runner.complete) {
      job.phase = 'token_exchange';
      job.oauthCode = job.runner.oauthCode;
      markRunnable(job, 'token_exchange', context);
      return;
    }
    if (job.runner.blocked) {
      await handleRegistrationBlock(job, context);
      return;
    }

    const step = currentRunnerStep(job);
    if (!step) {
      scheduleJob(job, 0, 'waiting', 'blocked_runner', context, { code: 'runner_step_missing', message: 'Runner has no next step' });
      return;
    }
    if (job.branch === 'registration' && step.name === 'email_otp_send' && !await prepareEmailBaseline(job, context)) return;
    await advanceRunnerOnce(job, context);
    const event = lastEvent(job.runner);
    if (job.runner.blocked) {
      await handleRegistrationBlock(job, context);
      return;
    }
    if (event?.step === 'email_otp_send' && event.status >= 200 && event.status < 400) {
      job.emailActivity.status = 'sent';
      job.emailActivity.sentAt = nowIso(context);
      // The send step completed; start the mailbox query in this scheduler turn
      // instead of routing through another runnable pass first.
      await pollEmailCode(job, context);
      return;
    }
    if (event?.step === 'phone_otp_send' && event.status >= 200 && event.status < 400) {
      incrementFraudMarket('', context);
      await markSmsSent(job, context, { deferCheckpoint: true });
      // The provider status is now ready, so start the first code query in the
      // same scheduler turn instead of waiting for a second runnable pass.
      await pollSmsCode(job, context);
      return;
    }
    if (event?.step === 'create_account' && event.status === 200) {
      await recordAccountCreated(job, context);
    }
    if (job.runner.complete) {
      job.phase = 'token_exchange';
      job.oauthCode = job.runner.oauthCode;
    }
    markRunnable(job, job.phase, context);
  } catch (error) {
    if (error?.fatal === true || error?.code === 'ESIMULATEDCRASH') throw error;
    await handleProcessError(job, error, context);
    await context.checkpoint('job_error');
  }
}

function activeJobs(state) {
  return state.mailboxes
    .filter((mailbox) => mailbox.workerId && !mailbox.normalComplete && !['capped', 'released', 'complete'].includes(mailbox.status))
    .map((mailbox) => currentLaneJob(state, mailbox))
    .filter(Boolean);
}

function releaseMailboxWorker(mailbox, context) {
  releaseMailboxProxy(mailbox, context);
  const worker = context.state.workers.find((candidate) => candidate.id === mailbox.workerId);
  if (worker) {
    worker.status = 'idle';
    worker.mailboxId = null;
    worker.proxyId = '';
    worker.currentJobId = '';
    worker.completedRoots = Number(worker.completedRoots || 0) + 1;
    worker.updatedAt = nowIso(context);
  }
  stateEvent(context.state, 'worker_released', { workerId: mailbox.workerId, mailboxId: mailbox.id }, context);
  mailbox.workerId = '';
}

function finishNormalMailboxes(context) {
  for (const mailbox of activeNormalMailboxes(context.state)) {
    refreshMailboxProgress(mailbox, context.state);
    if (currentLaneJob(context.state, mailbox)) continue;
    mailbox.normalComplete = true;
    mailbox.normalCompletedAt = nowIso(context);
    mailbox.status = mailbox.createdCount >= mailbox.targetCount ? 'normal_complete' : 'normal_partial';
    if (!proxyContinuityEnabled(context.state) || !mailboxHasPendingFinalization(context.state, mailbox)) {
      releaseMailboxWorker(mailbox, context);
    } else {
      const worker = context.state.workers.find((candidate) => candidate.id === mailbox.workerId);
      if (worker) {
        worker.status = 'running';
        worker.currentJobId = context.state.jobs.find((job) => (
          String(job.mailboxId) === String(mailbox.id) && job.status === 'pending_finalize'
        ))?.id || '';
      }
    }
  }
}

function releaseFinalizedMailboxWorkers(context) {
  if (!proxyContinuityEnabled(context.state)) return;
  for (const mailbox of context.state.mailboxes) {
    if (!mailbox.normalComplete || !mailbox.workerId || mailboxHasPendingFinalization(context.state, mailbox)) continue;
    releaseMailboxWorker(mailbox, context);
  }
}

function updateRunStatus(state) {
  if (state.status === 'cancelled') return state.status;
  const jobs = state.jobs || [];
  const unfinished = jobs.some((job) => !TERMINAL_JOB_STATUSES.has(job.status));
  if (pendingSmsCleanups(state).length) {
    state.status = 'waiting_cleanup';
  } else if (state.phase === 'normal' && state.normalWait) {
    state.status = 'waiting';
  } else if (unfinished && state.phase === 'finalization') {
    state.status = 'finalizing';
  } else if (unfinished && jobs.some((job) => job.status === 'waiting')) {
    state.status = 'waiting';
  } else if (unfinished) {
    state.status = 'running';
  } else {
    const mailboxRequestMet = !state.mailboxShortfall
      || Number(state.mailboxShortfall.claimed || 0) >= Number(state.mailboxShortfall.requested || 0);
    const targetsMet = mailboxRequestMet && state.mailboxes.length > 0 && state.mailboxes.every((mailbox) => (
      Number(mailbox.cpaCompletedCount || mailbox.successCount || 0) >= Number(mailbox.targetCount || 1)
    ));
    state.status = targetsMet ? 'complete' : 'partial';
  }
  return state.status;
}

function normalWorkPending(state, config) {
  if (activeNormalMailboxes(state).length > 0) return true;
  return state.mailboxes.length < config.mail.count && state.mailboxClaimExhausted !== true;
}

async function releaseZeroSuccessMailboxes(context) {
  for (const mailbox of context.state.mailboxes) {
    const laneJobs = context.state.jobs.filter((job) => String(job.mailboxId) === String(mailbox.id));
    const terminal = laneJobs.length > 0 && laneJobs.every((job) => TERMINAL_JOB_STATUSES.has(job.status));
    if (!terminal) continue;
    refreshMailboxProgress(mailbox, context.state);
    const targetTouched = mailboxHasLegacyTargetTouch(context.state, mailbox);
    mailbox.targetTouched = targetTouched;
    if (Number(mailbox.createdCount || 0) === 0 && !targetTouched && mailbox.status !== 'released') {
      if (typeof context.mailClient.releaseMailbox === 'function') {
        await authenticateMail(context);
        await context.mailClient.releaseMailbox(mailbox.id);
      }
      mailbox.status = 'released';
      mailbox.releasedAt = nowIso(context);
    } else if (targetTouched && Number(mailbox.createdCount || 0) === 0) {
      mailbox.status = 'partial_retained';
      mailbox.targetTouchedAt = mailbox.targetTouchedAt || nowIso(context);
    } else if (mailbox.status !== 'capped') {
      mailbox.status = mailbox.cpaCompletedCount >= mailbox.createdCount ? 'complete' : 'partial';
    }
  }
}

function writeManifest(context) {
  const manifest = buildRunManifest({
    runId: context.state.runId,
    status: context.state.status,
    generatedAt: nowIso(context),
    jobs: context.state.jobs,
  });
  const manifestPath = path.join(context.config.output.cpaDir, context.state.runId, 'manifest.json');
  context.state.manifestPath = writeJsonAtomic(manifestPath, manifest);
  return manifest;
}

function finalizationJobs(state) {
  const queuedIds = new Set(state.finalizationQueue || []);
  return (state.jobs || [])
    .filter((job) => queuedIds.has(job.id) && !['complete', 'finalize_failed', 'cancelled', 'skipped'].includes(job.status))
    .sort((left, right) => Date.parse(left.finalization?.queuedAt || left.createdAt) - Date.parse(right.finalization?.queuedAt || right.createdAt));
}

async function waitForNextDue(jobs, context, runDeadline) {
  const scheduledAt = [
    ...jobs.filter((job) => job.status === 'waiting' && job.nextRunAt).map(dueAt),
    ...pendingSmsCleanups(context.state).map(({ item }) => Date.parse(item.cleanupAt)),
  ].filter(Number.isFinite).sort((a, b) => a - b);
  const currentTime = nowMs(context);
  if (scheduledAt.some((at) => at <= currentTime)) return true;
  const next = scheduledAt.find((at) => at > currentTime);
  if (!next || next > runDeadline) return false;
  const delayMs = Math.min(next - currentTime, 30000);
  if (typeof context.control?.wait === 'function') await context.control.wait(delayMs);
  else await (context.sleep || sleep)(delayMs);
  return true;
}

function schedulerControlAction(context) {
  const source = context.control?.requestedAction;
  const action = typeof source === 'function' ? source() : source;
  return action === 'pause' || action === 'cancel' ? action : '';
}

async function applySchedulerControl(context) {
  const action = schedulerControlAction(context);
  if (!action) return '';
  const at = nowIso(context);
  context.state.control = {
    ...(context.state.control || {}),
    requestedAction: action,
    requestedAt: context.state.control?.requestedAt || at,
  };
  if (action === 'pause') {
    context.state.status = 'paused';
    context.state.control.pausedAt = at;
    stateEvent(context.state, 'scheduler_paused', {}, context);
    await context.checkpoint('scheduler_paused');
  } else {
    context.state.status = 'cancel_requested';
    stateEvent(context.state, 'scheduler_cancel_requested', {}, context);
    await context.checkpoint('scheduler_cancel_requested');
  }
  if (typeof context.control?.consume === 'function') context.control.consume(action);
  return action;
}

async function runOrchestratorV2(har, state, config, options = {}) {
  const context = createContext(state, config, options);
  context.har = har;
  const runDeadline = nowMs(context) + context.config.registration.maxRuntimeMs;
  state.status = 'running';
  state.control = {
    ...(state.control || {}),
    requestedAction: null,
    requestedAt: '',
  };
  try {
    const initialControlAction = await applySchedulerControl(context);
    if (initialControlAction) return state;
    if (state.phase === 'normal') {
      await claimMailboxes(context, context.config.workers.maxConcurrency);
      ensureJobs(context);
    }
    await context.checkpoint('scheduler_started');

    while (nowMs(context) <= runDeadline) {
      const controlAction = await applySchedulerControl(context);
      if (controlAction) return state;
      await processDueSmsCleanups(context);
      if (state.phase === 'normal') {
        const proxyBindingPaused = proxyContinuityEnabled(state)
          && ['proxy_pool_exhausted', 'healthy_proxy_required'].includes(state.normalWait?.code);
        finishNormalMailboxes(context);
        releaseFinalizedMailboxWorkers(context);
        if (!proxyBindingPaused) await claimMailboxes(context, context.config.workers.maxConcurrency);
        ensureJobs(context);
        if (!proxyBindingPaused) await assignWorkers(context);
        if (proxyContinuityEnabled(state)) {
          for (const job of finalizationJobs(state).filter((candidate) => candidate.status === 'pending_finalize')) {
            const mailbox = mailboxForJob(state, job);
            if (mailbox?.workerId) await startFinalizationAttempt(job, context);
          }
        }
        const lanes = [
          ...activeJobs(state),
          ...(proxyContinuityEnabled(state)
            ? finalizationJobs(state).filter((job) => job.finalization?.status === 'running')
            : []),
        ];
        if (lanes.length === 0) {
          if (normalWorkPending(state, context.config)) {
            state.normalWait = state.normalWait || {
              code: 'normal_resources_unavailable',
              message: 'Normal registration work remains but no worker can be bound',
              at: nowIso(context),
            };
            await context.checkpoint('normal_phase_waiting');
            break;
          }
          state.normalWait = null;
          state.phase = 'finalization';
          stateEvent(state, 'normal_phase_complete', {
            roots: state.mailboxes.length,
            queuedFinalizations: finalizationJobs(state).length,
          }, context);
          await context.checkpoint('normal_phase_complete');
          continue;
        }
        const due = lanes.filter((job) => jobIsDue(job, nowMs(context)));
        if (due.length === 0) {
          if (!(await waitForNextDue(lanes, context, runDeadline))) break;
          continue;
        }
        const batch = due.slice(0, context.config.workers.maxConcurrency);
        await Promise.all(batch.map((job) => processJob(job, context)));
        await context.checkpoint('scheduler_tick');
        continue;
      }

      const finalizers = finalizationJobs(state);
      if (finalizers.length === 0) {
        if (pendingSmsCleanups(state).length && await waitForNextDue([], context, runDeadline)) continue;
        break;
      }
      const job = finalizers[0];
      if (job.status === 'pending_finalize') {
        await startFinalizationAttempt(job, context);
        continue;
      }
      if (job.status === 'waiting' && !jobIsDue(job, nowMs(context))) {
        if (!(await waitForNextDue([job], context, runDeadline))) break;
        continue;
      }
      await processJob(job, context);
      releaseFinalizedMailboxWorkers(context);
      await context.checkpoint('finalization_tick');
    }
    releaseFinalizedMailboxWorkers(context);
    await releaseZeroSuccessMailboxes(context);
    updateRunStatus(state);
    writeManifest(context);
    await context.checkpoint('scheduler_finished');
    return state;
  } finally {
    for (const lock of context.mailboxLocks.reverse()) {
      try { lock.release(); } catch { /* Preserve the scheduler result. */ }
    }
  }
}

function resumeOrchestratorV2State(state, options = {}) {
  if (TERMINAL_RUN_STATUSES.has(state.status)) {
    const error = new Error(`Cannot resume terminal run with status "${state.status}"`);
    error.code = 'TERMINAL_RUN';
    throw error;
  }
  const effectResolution = String(options.effectResolution || '').trim().toLowerCase();
  if (effectResolution && effectResolution !== 'retry') {
    throw new Error('effectResolution must be "retry"');
  }
  if (effectResolution && !options.jobId) {
    throw new Error('Resolving an ambiguous effect requires a specific jobId');
  }
  if (state.status === 'paused' && !effectResolution && !options.jobId) {
    state.status = 'initialized';
    state.control = {
      ...(state.control || {}),
      requestedAction: null,
      requestedAt: '',
      resumedAt: new Date().toISOString(),
    };
    return state;
  }
  const selected = options.jobId ? state.jobs.filter((job) => job.id === options.jobId) : state.jobs;
  if (options.jobId && selected.length === 0) throw new Error(`Unknown job: ${options.jobId}`);
  for (const job of selected) {
    if (TERMINAL_JOB_STATUSES.has(job.status)) continue;
    if (effectResolution) {
      const effect = job.runner?.inFlight || job.effect;
      if (!effect) throw new Error(`Job ${job.id} has no ambiguous runner effect to resolve`);
      const sentinelBefore = {
        authorize_continue: 'sentinel_authorize_continue',
        login_authorize_continue: 'sentinel_authorize_continue',
        user_register: 'sentinel_username_password_create',
        password_verify: 'sentinel_password_verify',
        create_account: 'sentinel_oauth_create_account',
      }[effect.step];
      if (sentinelBefore) {
        rewindToStep(job.runner, job.branch === 'login' ? LOGIN_STEPS : RUN_STEPS, sentinelBefore);
      } else {
        job.runner.inFlight = null;
        job.runner.blocked = null;
        job.runner.complete = false;
      }
      job.runner.inFlight = null;
      job.effect = null;
      job.manualEffectResolution = {
        action: 'retry',
        step: effect.step || effect.kind || '',
        at: new Date().toISOString(),
      };
    }
    if (!effectResolution && job.finalization?.status === 'queued') {
      job.status = 'pending_finalize';
      job.phase = 'pending_finalize';
      job.nextRunAt = '';
      continue;
    }
    job.status = 'runnable';
    job.nextRunAt = '';
    job.error = null;
    const previousPhase = job.phase;
    if (previousPhase === 'waiting_sms_quality') job.sms.replacementWindowUsed = 0;
    if (previousPhase === 'waiting_phone_continuity') job.attempts.phoneContinuity = 0;
    if (previousPhase === 'waiting_email_timeout' && job.emailActivity) job.emailActivity.deadlineAt = '';
    if (previousPhase === 'waiting_sms_code_timeout' && job.sms) job.sms.codeDeadlineAt = '';
    if (previousPhase === 'waiting_sms_acquire_reconcile' && job.sms) {
      const acquisition = job.sms.effect?.kind === 'sms_acquire' ? cloneJson(job.sms.effect) : null;
      if (acquisition) {
        const at = nowIso(options);
        archiveSmsAcquisitionIntent(state, job, acquisition, {
          at,
          status: 'operator_retry',
          resolution: 'retry',
          reason: 'operator_confirmed_provider_side_outcome',
        });
        state.events = Array.isArray(state.events) ? state.events : [];
        state.events.push({
          at,
          type: 'sms_acquisition_retry_authorized',
          jobId: job.id,
          acquisitionId: acquisition.id || '',
          reason: 'operator_confirmed_provider_side_outcome',
        });
      }
      job.sms.effect = null;
      job.sms.codeDeadlineAt = '';
    }
    if (job.phase.startsWith('waiting_') || job.phase.startsWith('blocked_')) {
      const recoveryAction = job.runner?.blocked ? classifyRegistrationBlock(job.runner).action : '';
      const resourceActions = new Set([
        'wait_email',
        'acquire_phone',
        'wait_sms_code',
        'replace_phone',
        'retry_phone_continuity',
        'retry_account_create',
        'retry_transient',
        'migrate_existing_account',
      ]);
      if (job.runner?.blocked && !resourceActions.has(recoveryAction)) job.runner.blocked = null;
      job.phase = previousPhase === 'waiting_phone_continuity'
        ? 'phone_continuity'
        : (job.finalization?.status === 'running'
          ? 'finalization'
          : (job.branch === 'login' ? 'fallback_login' : 'registration'));
    }
  }
  if ((state.phase || 'normal') === 'normal') state.normalWait = null;
  state.status = 'initialized';
  return state;
}

async function skipAliasV2(state, config, jobId, options = {}) {
  const context = createContext(state, config, options);
  const job = state.jobs.find((candidate) => candidate.id === jobId);
  if (!job) throw new Error(`Unknown job: ${jobId}`);
  if (isTerminalJobStatus(job.status, 'orchestrator-v2')) {
    throw Object.assign(new Error(`Job is already terminal: ${job.status}`), { code: 'JOB_TERMINAL' });
  }
  prepareJobForSkip(job);
  if (job.sms?.current) {
    await cancelCurrentSms(job, options.reason || 'operator_skip', context, { finalCodeCheck: true });
  }
  markJobSkipped(job, {
    code: 'operator_skip',
    message: options.reason || 'Skipped by operator',
    updatedAt: nowIso(context),
  });
  releaseJobProxy(job, context);
  if (job.finalization) job.finalization.status = 'skipped';
  finishNormalMailboxes(context);
  await releaseZeroSuccessMailboxes(context);
  updateRunStatus(state);
  writeManifest(context);
  await context.checkpoint('alias_skipped');
  return state;
}

async function cancelOrchestratorV2(state, config, options = {}) {
  const context = createContext(state, config, options);
  for (const job of state.jobs) {
    const terminal = TERMINAL_JOB_STATUSES.has(job.status);
    const previousError = job.error;
    if (!terminal && !job.sms?.current && job.sms?.effect?.kind === 'sms_acquire') {
      const acquisition = cloneJson(job.sms.effect);
      archiveSmsAcquisitionIntent(state, job, acquisition, {
        at: nowIso(context),
        status: 'abandoned_unresolved',
        reason: options.reason || 'run_cancelled',
        externalCleanup: true,
        provider: context.smsProvider?.name || context.config.sms.provider || '',
      });
      job.sms.effect = null;
      if (!previousError) {
        job.error = {
          code: 'SMS_EXTERNAL_CLEANUP_REVIEW',
          message: 'Local task cancellation completed; provider-side SMS outcome requires manual review',
        };
      }
      stateEvent(state, 'sms_acquisition_abandoned_unresolved', {
        jobId: job.id,
        acquisitionId: acquisition.id || '',
        message: 'Local task cancellation completed; the provider-side outcome has no activation ID and requires manual review',
      }, context);
    }
    if (!terminal && job.sms?.current) {
      try {
        await cancelCurrentSms(job, 'run_cancelled', context);
      } catch (error) {
        if (error?.fatal === true) throw error;
        job.cleanupError = error.message;
      }
    }
    for (const lease of job.sms?.pendingCleanup || []) {
      if (lease.status !== 'pending_cleanup') continue;
      try {
        const cancelled = await context.withSmsLock(() => context.smsProvider.cancel(lease, 'run_cancelled'));
        Object.assign(lease, cancelled, { status: 'cancelled' });
      } catch (error) {
        lease.cleanupError = error.message;
      }
    }
    if (!terminal) {
      job.status = 'cancelled';
      job.phase = 'cancelled';
      job.updatedAt = nowIso(context);
    }
    releaseJobProxy(job, context);
    if (!terminal && job.finalization) job.finalization.status = 'cancelled';
  }
  for (const mailbox of state.mailboxes) {
    refreshMailboxProgress(mailbox, state);
    releaseMailboxProxy(mailbox, context);
    mailbox.workerId = '';
    const targetTouched = mailboxHasLegacyTargetTouch(state, mailbox);
    mailbox.targetTouched = targetTouched;
    if (Number(mailbox.createdCount || 0) !== 0 || targetTouched) {
      mailbox.status = 'cancelled_retained';
      mailbox.targetTouchedAt = targetTouched ? (mailbox.targetTouchedAt || nowIso(context)) : mailbox.targetTouchedAt;
      continue;
    }
    try {
      if (typeof context.mailClient.releaseMailbox === 'function') {
        await authenticateMail(context);
        await context.mailClient.releaseMailbox(mailbox.id);
      }
      mailbox.status = 'released';
      mailbox.releasedAt = nowIso(context);
    } catch (error) {
      mailbox.releaseError = error.message;
    }
  }
  for (const owner of Object.keys(context.proxyAllocator.snapshot().leases)) {
    context.proxyAllocator.release(owner);
  }
  syncProxyState(context);
  for (const worker of state.workers || []) resetWorker(worker, context);
  state.status = 'cancelled';
  state.phase = 'cancelled';
  state.cancelPending = false;
  state.lastError = null;
  state.cancelledAt = nowIso(context);
  writeManifest(context);
  await context.checkpoint('run_cancelled');
  return state;
}

function summarizeOrchestratorV2State(state, options = {}) {
  const raw = options.raw === true || options.redact === false;
  const jobs = state.jobs || [];
  const workers = state.workers || [];
  const proxyHealth = state.proxyHealth || {};
  const scrub = (value) => String(value || '').replace(
    /([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi,
    '$1<redacted>@',
  ).replace(/(^|[\s(])[^\s:@/]+:[^\s@/]+@/g, '$1<redacted>@');
  const errorSummary = (error) => error ? {
    code: error.code || '',
    message: scrub(error.message),
  } : null;
  const workerCounts = {
    total: workers.length,
    running: workers.filter((worker) => worker.status === 'running').length,
    idle: workers.filter((worker) => worker.status === 'idle').length,
  };
  const proxyCounts = { unknown: 0, checking: 0, healthy: 0, leased: 0, failed: 0 };
  for (const record of Object.values(proxyHealth)) {
    const status = Object.hasOwn(proxyCounts, record?.status) ? record.status : 'unknown';
    proxyCounts[status] += 1;
  }
  const finalizationCounts = {
    queued: jobs.filter((job) => job.finalization?.status === 'queued').length,
    running: jobs.filter((job) => job.finalization?.status === 'running').length,
    failed: jobs.filter((job) => job.status === 'finalize_failed' || job.finalization?.status === 'failed').length,
  };
  const rawSmsBilling = summarizeSmsCosts(jobs);
  const reconciliationCurrency = String(state.balanceReconciliation?.currency || rawSmsBilling.currency || 'USD').toUpperCase();
  const cancellationDetails = cancellationDetailsForBalance(rawSmsBilling, reconciliationCurrency);
  const settledCancelledQuotes = cancellationQuoteSettlementAmount(
    state.balanceReconciliation,
    cancellationDetails,
  );
  const settledByJob = state.balanceReconciliation?.cancelledQuotesSettledByJob;
  const smsBilling = summarizeSmsCosts(jobs, settledCancelledQuotes > 0 ? {
    settledCancelledQuotesCurrency: reconciliationCurrency,
    ...(settledByJob && typeof settledByJob === 'object'
      ? { settledCancelledQuotesByJob: settledByJob }
      : { settledCancelledQuotesUsd: settledCancelledQuotes }),
  } : {});
  const balanceReconciliation = applyBalanceCancellationSettlement(
    state.balanceReconciliation,
    cancellationDetails,
  );
  const smsLedgerByJob = new Map(smsBilling.ledgers.map(({ job, ledger }) => [job.id, ledger]));
  const smsCostByJob = new Map(jobs.map((job) => [
    job.id,
    confirmedSmsCostUsd(job, smsLedgerByJob.get(job.id)),
  ]));
  const createdJobs = jobs.filter(hasConfirmedAccountCreation);
  const accountedSmsCosts = createdJobs
    .map((job) => smsCostByJob.get(job.id))
    .filter((cost) => cost !== null);
  return {
    schemaVersion: state.schemaVersion,
    mode: state.mode,
    runId: state.runId,
    status: state.status,
    phase: state.phase || 'normal',
    updatedAt: state.updatedAt,
    manifestPath: state.manifestPath,
    normalWait: state.normalWait ? {
      code: state.normalWait.code || '',
      message: scrub(state.normalWait.message),
      at: state.normalWait.at || '',
    } : null,
    control: {
      requestedAction: state.control?.requestedAction || null,
      requestedAt: state.control?.requestedAt || '',
      pausedAt: state.control?.pausedAt || '',
      resumedAt: state.control?.resumedAt || '',
    },
    plan: state.runPlan ? cloneJson(state.runPlan) : null,
    counts: {
      workers: workerCounts,
      accountsCreated: jobs.filter(hasConfirmedAccountCreation).length,
      cpaCompleted: jobs.filter((job) => job.status === 'complete' && Boolean(job.cpaPath)).length,
      finalization: finalizationCounts,
    },
    costs: {
      currency: smsBilling.currency,
      sms: smsBilling.confirmedConsumedUsd,
      accountedJobs: smsBilling.accountedJobs,
      complete: accountedSmsCosts.length === createdJobs.length,
    },
    billing: {
      currency: smsBilling.currency,
      currencyTotals: smsBilling.currencyTotals,
      quotedUsd: smsBilling.quotedUsd,
      grossConsumedUsd: smsBilling.grossConsumedUsd,
      confirmedConsumedUsd: smsBilling.confirmedConsumedUsd,
      refundedUsd: smsBilling.refundedUsd,
      unresolvedUsd: smsBilling.unresolvedUsd,
      cancelledUnresolvedUsd: smsBilling.cancelledUnresolvedUsd,
      cancelledQuotedUsd: smsBilling.cancelledQuotedUsd,
      cancelledQuotesSettledUsd: settledCancelledQuotes,
      activeQuotedUsd: smsBilling.activeQuotedUsd,
      accountedJobs: smsBilling.accountedJobs,
      unresolvedJobs: smsBilling.unresolvedJobs,
      activationCount: smsBilling.activationCount,
      billingComplete: smsBilling.billingComplete,
    },
    balanceReconciliation: cloneJson(balanceReconciliation || null),
    workers: workers.map((worker) => ({
      id: worker.id,
      status: worker.status,
      mailboxId: worker.mailboxId,
      proxyId: worker.proxyId || '',
      currentJobId: worker.currentJobId || '',
      completedRoots: Number(worker.completedRoots || 0),
      updatedAt: worker.updatedAt || '',
    })),
    externalCleanup: cloneJson(state.externalCleanup || []),
    proxy: {
      candidates: (state.proxyCandidates || []).length,
      leases: Object.keys(state.proxyLeases || {}).length,
      counts: proxyCounts,
      health: Object.values(proxyHealth).map((record) => ({
        id: record.id,
        endpoint: scrub(record.endpoint),
        status: record.status || 'unknown',
        successCount: Number(record.successCount || 0),
        failureCount: Number(record.failureCount || 0),
        lastCheckedAt: record.lastCheckedAt || '',
        latencyMs: record.latencyMs ?? null,
      })),
    },
    mailboxes: state.mailboxes.map((mailbox) => ({
      id: mailbox.id,
      email: raw ? mailbox.rootEmail : '<redacted:email>',
      status: mailbox.status,
      workerId: mailbox.workerId || '',
      proxyId: mailbox.proxy?.id || '',
      targetCount: Number(mailbox.targetCount || 0),
      maxAttempts: Number(mailbox.maxAttempts || 0),
      attemptCount: Number(mailbox.attemptCount || 0),
      createdCount: Number(mailbox.createdCount || 0),
      cpaCompletedCount: Number(mailbox.cpaCompletedCount || mailbox.successCount || 0),
      successCount: Number(mailbox.successCount || 0),
      normalComplete: Boolean(mailbox.normalComplete),
      stopReason: mailbox.stopReason,
    })),
    jobs: jobs.map((job) => {
      const error = errorSummary(job.error);
      return {
        id: job.id,
        email: raw ? job.email : '<redacted:email>',
        status: job.status,
        phase: job.phase,
        branch: job.branch,
        aliasIndex: job.aliasIndex,
        replacementOf: job.replacementOf || '',
        proxyId: job.proxy?.id || '',
        smsAttempts: job.sms?.attempts?.length || 0,
        smsCostUsd: smsCostByJob.get(job.id),
        smsCurrency: smsLedgerByJob.get(job.id)?.currency || 'USD',
        smsQuotedUsd: smsLedgerByJob.get(job.id)?.quotedUsd || 0,
        smsRefundedUsd: smsLedgerByJob.get(job.id)?.refundedUsd || 0,
        smsUnresolvedUsd: smsLedgerByJob.get(job.id)?.unresolvedUsd || 0,
        smsCancelledUnresolvedUsd: smsLedgerByJob.get(job.id)?.cancelledUnresolvedUsd || 0,
        smsCancelledQuoteExcludedUsd: Number(settledByJob?.[String(job.id || '')] || 0),
        smsCostStatus: smsLedgerByJob.get(job.id)?.status || 'not_used',
        accountCreated: hasConfirmedAccountCreation(job),
        finalization: job.finalization ? {
          status: job.finalization.status || '',
          attempts: Number(job.finalization.attempts || 0),
          reason: scrub(job.finalization.reason),
          lastError: scrub(job.finalization.lastError),
        } : null,
        workspaceId: job.workspaceId,
        cpaPath: job.cpaPath,
        result: jobResultText({ result: job.result, error }),
        error,
      };
    }),
  };
}

module.exports = {
  cancelOrchestratorV2,
  ensureJobs,
  makeInitialOrchestratorV2State,
  preflightOrchestratorV2,
  resumeOrchestratorV2State,
  runOrchestratorV2,
  runStatePathV2,
  skipAliasV2,
  summarizeOrchestratorV2State,
  updateRunStatus,
  waitForNextDue,
};
