'use strict';
const executionSettings = require('./execution-settings');

const crypto = require('node:crypto');

const {
  ChatGptSessionRunner,
  makeInitialChatGptSessionState,
  missingSecurityFeatures,
  securityStateHasPendingWork,
  securityWorkRequested,
} = require('./chatgpt-session-runner');
const { rebindSentinelProxy } = require('./registration-runner');
const { CockpitOAuthRunner, makeInitialCockpitOAuthState } = require('./cockpit-oauth-runner');
const { CODEX_OAUTH_PROTOCOL, createCodexPkceSession } = require('./oauth-pkce');
const {
  REMOTE_MAIL_PROVIDERS,
  REMOTE_MAILBOX_PROVIDERS,
  defaultMailMaxPollAttempts,
  isMailProviderEnabled,
  secretFromEnv,
  validateV2Config,
} = require('./config-v2');
const { deriveRegistrationEmails, splitEmail } = require('./email-alias');
const { executePureHttpUrl } = require('./pure-url');
const { failedSmsPreflight, skippedSmsPreflight, summarizeSmsPreflight } = require('./preflight-resources');
const { probeProxy } = require('./proxy-pool');
const {
  MAX_RENTAL_WATCH_TARGET,
  MIN_RENTAL_WATCH_POLL_INTERVAL_MS,
  providerBaseUrl,
  requiresSmsPreflight,
} = require('./run-plan');
const { createSmsProvider, sleep } = require('./sms-provider');
const { IcloudClient } = require('./icloud-client');
const { cancellationDetailsForBalance, summarizeSmsCost, summarizeSmsCosts } = require('./sms-cost-ledger');
const {
  applyBalanceCancellationSettlement,
  balanceAccountFingerprint,
  cancellationQuoteSettlementAmount,
  recordBalanceStart,
} = require('./balance-reconciliation');
const { archiveSmsAcquisitionIntent, smsLeaseHasReceivedCode } = require('./sms-acquisition-ledger');
const { checkSessionAssetTrial, trialRecord } = require('./session-trial-check');
const {
  assetLifecycle,
  oauthCooldownActive,
  OAUTH_FAILURE_COOLDOWN_MS,
} = require('./session-asset-grouping');
const { configFingerprint } = require('./state-store');
const {
  DEFAULT_UNSTARTED_RENTAL_TIMEOUT_MS,
  SmsbowerMailClient,
} = require('./smsbower-mail-client');
const { MailcomClient } = require('./mailcom-client');
const { providerAliasSettings } = require('./mail-provider-settings');
const { XiaopingguoClient, isRetryableMailError } = require('./xiaopingguo-client');
const {
  isRetryableSecurityFailure,
  isRetryableTransportError,
  isTlsTransportError,
} = require('./transport-errors');
const {
  markJobSkipped,
  prepareJobForSkip,
  requestJobSkip,
  terminalJobStatusSet,
} = require('./job-lifecycle');
const { clone, hashId, jobResultText } = require('./util/shared');
const { confirmedRebindMetadata, sessionAssetMailProviderEvidence } = require('./session-asset-store');

const BRANCH_TASK_KINDS = new Set(['register_oauth', 'register_session', 'oauth', 'session_refresh']);
const REGISTRATION_TASK_KINDS = new Set(['register_oauth', 'register_session']);
const TERMINAL_JOB_STATUSES = terminalJobStatusSet('branch');
const TERMINAL_RUN_STATUSES = new Set(['complete', 'partial', 'failed', 'cancelled']);
const PHONE_POLL_INTERVAL_MS = 8000;
const OAUTH_PHONE_CODE_TIMEOUT_MS = 60 * 1000;
/** Cleanup reason for a timed-out lease whose code turned up during cleanup. */
const SMS_LATE_CODE_REASON = 'SMS_LATE_CODE';
// Returned by cleanupSms instead of `true` when a timeout cleanup finds the
// code on the live activation and hands it back rather than settling it.
const SMS_LATE_CODE_ADOPTED = 'sms_late_code_adopted';
const SMS_INVENTORY_POLL_INTERVAL_MS = 8000;
const SMS_INVENTORY_RETRY_PHASE = 'waiting_sms_inventory_retry';
const SMS_INVENTORY_EXHAUSTED_PHASE = 'waiting_sms_inventory';
const SMS_PREFLIGHT_PHASE = 'waiting_sms_preflight';
// Out of money rather than out of numbers: parked until the operator tops up.
const SMS_BALANCE_PHASE = 'waiting_sms_balance';
const PROXY_ROTATION_PHASE = 'waiting_proxy_rotation';
const TRANSIENT_PHASE = 'waiting_transient';
// A proxy fault raised once the account flow is already under way. It is kept
// apart from the pre-flight case because the remedy differs: the exit is worth
// two short retries before the half-built attempt is thrown away.
const PROXY_RETRY_PHASE = 'waiting_proxy_retry';
// Raised when the attempt's original exit is gone for good. Retrying is
// pointless — the context it needs no longer exists — so it goes straight to
// rebuilding the attempt somewhere else.
const PROXY_CONTINUITY_PHASE = 'waiting_proxy_continuity';
const RETRY_BACKOFF_PHASE = 'waiting_retry_backoff';
// Optional password/TOTP setup that failed on transport after the account was
// already saved. Worth retrying in-run: the account is safe either way, so the
// only thing at stake is a second round trip.
const SECURITY_RETRY_PHASE = 'waiting_security_retry';
const SECURITY_EMAIL_RETRY_PHASE = 'waiting_security_email_retry';
// A pool can be exhausted simply because more Workers than exits arrived at
// once — with a 20-Worker ceiling that is the normal case, not an operator
// problem. It retries on a long ladder so the losers pick up exits as the
// winners finish, and only gives up after the pool has stayed empty for
// minutes.
const PROXY_POOL_PHASE = 'waiting_proxy_pool';
// OAuth/session-maintenance traffic uses one shared local forwarder. It has
// no remote catalog to rotate, so a transport blip gets a short retry on the
// same endpoint instead of entering the proxy-robot recovery lane.
const MAINTENANCE_PROXY_PHASE = 'waiting_maintenance_proxy';
// The phone branch parks here when a lease is still outstanding and the error
// is not one the replacement loop recognises. The SMS lease is preserved, so a
// retry re-enters `handlePhoneChallenge` and can finish or replace the number.
const PHONE_CONTINUITY_PHASE = 'waiting_phone_continuity';
const PHONE_CONFIRMATION_PHASE = 'waiting_phone_confirmation';
// An ambiguous OAuth validation is retried once automatically. If the fresh
// transaction is ambiguous too, the old code must stay untouched until an
// operator explicitly resumes the job and authorizes one more fresh OAuth
// transaction.
const PHONE_MANUAL_REVIEW_PHASE = 'waiting_phone_manual_review';
// Releasing a paid activation is idempotent and provider-side; a failure here
// is almost always the provider being briefly unreachable.
const SMS_CLEANUP_PHASE = 'waiting_sms_cleanup';
// A rented mailbox that returns this before account creation is not worth
// retrying: discard the rental and ask the provider for a fresh address.
const MAIL_RENTAL_RETRY_PHASE = 'waiting_mail_rental';
const MAIL_RENTAL_WATCH_PHASE = 'waiting_mail_rental_watch';
const MAIL_RENTAL_RETRY_DELAY_MS = 8000;
/**
 * Checkpoint pacing. A save is synchronous end to end (serialize, write, fsync,
 * rename), and the state grows with every finished account: past ~70 accounts a
 * 10MB+ state took ~200ms per save on Windows, and twenty Workers asked for one
 * almost continuously. Saves then ran back to back on the promise chain, the
 * event loop never got to the sockets, and every in-flight request through
 * every proxy timed out together (timer lag measured at 1–20s in those minutes).
 * After each save the loop gets at least as long as that save took, capped, so
 * blocking stays under about half of wall time whatever the state size.
 */
const CHECKPOINT_MAX_GAP_MS = 1000;
const MAIL_RENTAL_RETRY_MAX_DELAY_MS = 60000;
// The provider's stock endpoint is only a hint. Keep the activation endpoint
// under a bounded concurrency cap so a stale count cannot turn one broker poll
// into an unbounded burst of competing claims or state writes. With the
// 20-mailbox batch limit this produces three claim windows: 7/7/6.
const MAIL_RENTAL_CLAIM_CONCURRENCY = 7;
/**
 * How long the broker keeps polling without claiming anything before it
 * finishes the round with what it already has.
 *
 * 挂租 is supposed to wait — that is the difference between it and an ordinary
 * rental, and the provider restocks in batches rather than continuously — so
 * this is deliberately patient. But the wait has to end somewhere: a round
 * that polls an empty provider forever holds the main task slot, and every
 * later scheduled start is refused behind it.
 *
 * The clock restarts on every poll that manages to claim something, so a
 * trickle of restocks keeps a round alive indefinitely; only a provider that
 * stays empty for the whole window ends it.
 *
 * Only polls that could have claimed and did not count: backpressure returns
 * earlier, and reaching the target stops the broker on its own.
 */
const MAIL_RENTAL_STOCK_STARVATION_MS = 20 * 60 * 1000;
const MAIL_RENTAL_CLAIM_RETRY_ATTEMPTS = 2;
const MAIL_RENTAL_CLAIM_RETRY_DELAY_MS = 500;
const MAIL_RENTAL_CLAIM_RETRY_MAX_DELAY_MS = 30000;
// A sibling delivery proves the mailbox path works, but it does not prove that
// the target alias will never arrive. Providers can deliver aliases in waves.
// Keep the evidence useful without making a missing address occupy the full
// registration timeout.
const DEFAULT_EMAIL_TARGET_DELIVERY_GRACE_MS = 45000;
const REMOTE_EMAIL_PROVIDER_MAX_WAIT_MS = 60000;
// A Mail.com master can still rotate when only a small tail of its accounts
// missed optional security setup. More than this means the batch is unhealthy
// enough to keep the cycle open until the security work is repaired.
const MAILCOM_MAX_INCOMPLETE_SECURITY_ALIASES = 5;
const AUTH_CONTINUATION_ORIGIN_INVALID_CODE = 'AUTH_CONTINUATION_ORIGIN_INVALID';
const RENTAL_REPLACEMENT_FAILURE_CODES = new Set([
  AUTH_CONTINUATION_ORIGIN_INVALID_CODE,
]);
const REGISTRATION_EMAIL_TIMEOUT_CODES = new Set([
  'EMAIL_OTP_TIMEOUT',
  'EMAIL_PROVIDER_TIMEOUT',
]);
const MAIL_RENTAL_START_TIMEOUT_CODE = 'MAIL_RENTAL_START_TIMEOUT';
const REGISTRATION_WASTE_CODES = new Set([
  'MFA_TOTP_FACTOR_UNAVAILABLE',
  'MFA_TOTP_SECRET_REQUIRED',
  'USER_ALREADY_EXISTS',
]);
// How many times one mailbox may have its half-built attempt rebuilt on a
// fresh exit. Counted on the job itself rather than in `job.retry`, because a
// resume clears the retry budget on purpose and catalog refresh resumes a
// proxy-waiting run automatically: without a durable count, a job
// that can never finish rebuilds, exhausts, parks, gets resumed, and rebuilds
// again about every two minutes for as long as the console is left running.
// A pool that no longer knows this mailbox cannot be made to know it again, so
// closing it out is done — not deferred. Observed live: a run finished all 20
// jobs, then hung in `waiting_resource_cleanup` retrying POST /api/pool/consume
// for an alias the pool had already dropped, forever, which also kept both
// robots parked because an unresolved run counts as busy.
const MAILBOX_ALREADY_GONE_PATTERN = /mailbox not found|not found|unknown mailbox|does not exist|no such mailbox/i;
const MAILBOX_MANUAL_CLEANUP_PATTERN = /alias domain|unsupported|denied|not allowed|invalid domain/i;
const RENTAL_CLEANUP_RETRY_DELAYS_MS = Object.freeze([5000, 30000, 120000, 300000, 900000]);

function mailboxAlreadyGone(error) {
  if (!error) return false;
  if (error.mailboxGone === true || error.code === 'MAILBOX_GONE') return true;
  // A bare 404 from SMSBower may be an unavailable endpoint rather than a
  // missing rental. The mail client only sets `mailboxGone` when the provider
  // response identifies the mailbox/activation, so do not discard a lease on
  // an ambiguous HTTP response.
  if (String(error.provider || '').toLowerCase() === 'smsbower-mail') return false;
  if (Number(error.status || error.statusCode || 0) === 404) return true;
  return MAILBOX_ALREADY_GONE_PATTERN.test(String(error.message || ''));
}

function mailboxCleanupRequiresManualReview(error) {
  if (!error) return false;
  if (error.providerStateRejected === true) return true;
  if (error.retryable === false) return true;
  const status = Number(error.status || error.statusCode || 0);
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) return true;
  return MAILBOX_MANUAL_CLEANUP_PATTERN.test(String(error.message || ''));
}

// The share of candidates a country pool has actually converted into usable
// exits across measured runs. Preflight uses it to turn a candidate count into
// a statement about whether a lane is thick enough to feed its Workers.
const PROXY_PREFLIGHT_EXPECTED_PASS_RATE = 0.05;

const MAX_FRESH_EXIT_RESTARTS = 2;
const AUTH_CALLBACK_PROXY_RETRY_LIMIT = 2;
const MAX_AUTH_CALLBACK_PROXY_CHANGES = 2;
// A run may have many Workers hit the same depleted pool. One refill attempt
// per short window is enough; retries in that window should consume the new
// catalog instead of issuing another upstream pull for every Worker.
const PROXY_POOL_REFRESH_COOLDOWN_MS = 30000;
// A rotation should use the catalog already captured for this run whenever it
// has one unused, non-retired exit. Catalog refresh is only a fallback for a
// genuinely exhausted catalog, not a prerequisite for replacing one bad exit.
const PROXY_ROTATION_CYCLE_DELAY_MS = 250;

// In-run retry policy for the waits a Worker can recover from by itself.
// Defaults are overlaid by the task's saved retryPolicy. Tuning is snapshotted
// independently from the identity/configuration fingerprint.
// `maxRetries` counts retries only: a job runs once, then up to maxRetries more times.
const RETRY_POLICIES = {
  // The challenged exit is banned and unbound before this policy is read, so
  // the first retry only needs long enough to avoid a hot loop.
  [PROXY_ROTATION_PHASE]: { delaysMs: [150, 500, 1200], maxRetries: 3 },
  [MAINTENANCE_PROXY_PHASE]: {
    // A Cloudflare challenge on the shared local forwarder is often a short
    // upstream/session blip. Give it exactly one 30-second retry, then settle
    // the account instead of parking the whole maintenance lane.
    delaysMs: [30000],
    maxRetries: 1,
    jitterRatio: 0,
  },
  // Mid-registration: two short attempts on the same exit, then the attempt is
  // rebuilt on a fresh one rather than retried forever on a bad route.
  [PROXY_RETRY_PHASE]: { delaysMs: [2000, 2000], maxRetries: 2, onExhausted: 'restart_on_fresh_exit' },
  [PROXY_CONTINUITY_PHASE]: { delaysMs: [250], maxRetries: 0, onExhausted: 'restart_on_fresh_exit' },
  [TRANSIENT_PHASE]: { delaysMs: [2000, 5000, 15000, 45000, 120000], maxRetries: 5 },
  [SECURITY_RETRY_PHASE]: { delaysMs: [3000, 10000, 30000], maxRetries: 3 },
  [SECURITY_EMAIL_RETRY_PHASE]: { delaysMs: [5000], maxRetries: 1 },
  // Slower than the proxy ladders on purpose: each attempt may buy a number,
  // so a hot loop here costs real money.
  [PHONE_CONTINUITY_PHASE]: { delaysMs: [3000, 12000, 30000], maxRetries: 3 },
  [PHONE_CONFIRMATION_PHASE]: { delaysMs: [3000, 12000], maxRetries: 2 },
  [SMS_CLEANUP_PHASE]: { delaysMs: [2000, 6000, 15000, 40000], maxRetries: 4 },
  // Firefox.fun's myInfo endpoint is limited to one request per 60 seconds.
  // Retry after a provider-safe cooldown instead of leaving a transient
  // preflight failure with no nextRunAt.
  [SMS_PREFLIGHT_PHASE]: { delaysMs: [65000, 65000, 65000], maxRetries: 3 },
  // Waits that used to park with an empty `nextRunAt`. Nothing re-queued them,
  // so the scheduler saw no pending work and returned `waiting` with healthy
  // exits sitting idle — a 20-Worker run against a smaller pool stranded every
  // Worker that lost the first race.
  [PROXY_POOL_PHASE]: { delaysMs: [5000, 15000, 30000, 60000, 120000], maxRetries: 12 },
  // The SMS and OAuth-repair waits deliberately have no policy here: several of
  // them guard a durable intent that must be reconciled on resume rather than
  // re-driven on a timer. Adding ladders to them broke exactly those tests, so
  // they are left alone until each one is judged on its own.
};
const RETRY_JITTER_RATIO = 0.2;
// Ceiling on the in-state event log, and how many of the earliest entries are
// always preserved when it is trimmed.
const MAX_STATE_EVENTS = 4000;
const STATE_EVENT_HEAD = 200;
const OAUTH_LOGIN_REPAIR_LIMIT = 1;
const OAUTH_PHONE_STATE_RESTART_LIMIT = 1;
// One rebuild of the consent continuation, for the same reason the phone-send
// transaction gets one: a second attempt that fails the same way is a real
// rejection rather than a transaction the server threw away.
const OAUTH_CONTINUATION_RESTART_LIMIT = 1;
// Rebuilding an expired transaction is useful while inventory is empty, but
// doing it on every poll creates an unbounded sequence of abandoned PKCE states.
// Once the budget is used, the next available number will force the normal
// pre-send transaction rebuild instead.
const OAUTH_INVENTORY_RESTART_LIMIT = 1;
// A lost response after submitting an OAuth phone code is ambiguous. Rebuild
// the OAuth transaction once to learn whether the target accepted it, then
// stop automatic reconstruction if the replacement transaction is ambiguous
// too.
const OAUTH_PHONE_VALIDATION_RECOVERY_LIMIT = 1;
// Upstream codes that mean "this number is spent, get another one" rather than
// "something went wrong". They are uppercased forms of the JSON `error.code`
// chatgpt.com returns on phone send.
//
// PHONE_MAX_USAGE_EXCEEDED and PHONE_RECENTLY_USED are the recycled-number
// cases: the provider handed back a number some other account already burned
// through OpenAI's per-number cap. Nothing about the attempt is wrong, so the
// remedy is the same as PHONE_NUMBER_IN_USE — release the lease and acquire a
// fresh number — and treating them as continuity failures instead used to park
// the job with no way back.
const REPLACE_PHONE_CODES = new Set([
  'INVALID_PHONE_NUMBER',
  'PHONE_NUMBER_IN_USE',
  'PHONE_MAX_USAGE_EXCEEDED',
  'PHONE_RECENTLY_USED',
  'FRAUD_GUARD',
]);
const INVALID_PHONE_CODE_ERRORS = new Set(['INVALID_PHONE_OTP', 'INVALID_OTP', 'OTP_INVALID', 'INVALID_INPUT']);
const DURABLE_SESSION_STEPS = new Set([
  'email_otp_sent',
  'email_otp_validated',
  'phone_required',
  'phone_otp_sent',
  'mfa_required',
  'mfa_challenge_issued',
  'mfa_verification_pending',
  'mfa_validated',
  'account_created',
  'auth_completed',
  'verified',
]);

function nowIso(options = {}) {
  return new Date((options.now || Date.now)()).toISOString();
}

function nowMs(options = {}) {
  const value = (options.now || Date.now)();
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function isPlainRetryState(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function scheduledAt(job) {
  if (!job?.nextRunAt) return null;
  const parsed = Date.parse(job.nextRunAt);
  return Number.isFinite(parsed) ? parsed : null;
}

function inventoryPollIntervalMs(context) {
  const override = Number(context?.smsInventoryPollIntervalMs);
  if (Number.isFinite(override) && override >= 0) return override;
  return SMS_INVENTORY_POLL_INTERVAL_MS;
}

function ensureOAuthRecovery(job) {
  const current = job.oauthRecovery && typeof job.oauthRecovery === 'object' ? job.oauthRecovery : {};
  const attempts = Number(current.attempts || 0);
  job.oauthRecovery = {
    status: String(current.status || 'idle'),
    attempts: Number.isFinite(attempts) ? Math.max(0, attempts) : 0,
    reason: String(current.reason || ''),
    requestedAt: String(current.requestedAt || ''),
    startedAt: String(current.startedAt || ''),
    completedAt: String(current.completedAt || ''),
    lastError: current.lastError || null,
  };
  return job.oauthRecovery;
}

function ensureOAuthPhoneValidationRecovery(job) {
  const current = job.oauthPhoneValidationRecovery && typeof job.oauthPhoneValidationRecovery === 'object'
    ? job.oauthPhoneValidationRecovery
    : {};
  const attempts = Number(current.attempts || 0);
  job.oauthPhoneValidationRecovery = {
    status: String(current.status || 'idle'),
    attempts: Number.isFinite(attempts) ? Math.max(0, attempts) : 0,
    reason: String(current.reason || ''),
    requestedAt: String(current.requestedAt || ''),
    startedAt: String(current.startedAt || ''),
    completedAt: String(current.completedAt || ''),
    activationId: String(current.activationId || ''),
    previousOAuthState: String(current.previousOAuthState || ''),
    outcome: String(current.outcome || ''),
    manualRestarts: Number.isFinite(Number(current.manualRestarts))
      ? Math.max(0, Number(current.manualRestarts))
      : 0,
    lastManualRestartAt: String(current.lastManualRestartAt || ''),
    manualReviewRequired: current.manualReviewRequired === true,
    lastError: current.lastError || null,
  };
  return job.oauthPhoneValidationRecovery;
}

function ensureProxyTransportRecovery(job) {
  const current = job.proxyTransportRecovery && typeof job.proxyTransportRecovery === 'object'
    ? job.proxyTransportRecovery
    : {};
  const failures = Number(current.failureCount || 0);
  job.proxyTransportRecovery = {
    attempted: current.attempted === true,
    pending: current.pending === true,
    failureCount: Number.isFinite(failures) ? Math.max(0, failures) : 0,
    attemptedAt: String(current.attemptedAt || ''),
    resumedAt: String(current.resumedAt || ''),
    lastFailureAt: String(current.lastFailureAt || ''),
    lastFailureCode: String(current.lastFailureCode || ''),
  };
  return job.proxyTransportRecovery;
}

/**
 * OAuth-stage proxy ladder: one retry on the same exit (the OAuth transaction
 * resumes where it stopped), then one change of exit with a fresh
 * authorization, then the job stops. The account itself is already saved, so
 * an endless rotation only burns exits and numbers.
 */
const MAX_OAUTH_SAME_PROXY_RETRIES = 1;
const MAX_OAUTH_PROXY_CHANGES = 1;

function ensureOAuthTransportRecovery(job) {
  const current = job.oauthTransportRecovery && typeof job.oauthTransportRecovery === 'object'
    ? job.oauthTransportRecovery
    : {};
  const retries = Number(current.sameProxyRetries);
  const changes = Number(current.proxyChanges);
  job.oauthTransportRecovery = {
    sameProxyRetries: Number.isFinite(retries) ? Math.max(0, retries) : 0,
    proxyChanges: Number.isFinite(changes) ? Math.max(0, changes) : 0,
    lastFailureAt: String(current.lastFailureAt || ''),
    lastFailureCode: String(current.lastFailureCode || ''),
  };
  return job.oauthTransportRecovery;
}

function oauthStageTransportFailure(job, error = {}) {
  if (error.proxyFailure === true || error.cloudflareChallenge === true) return false;
  if (createdAccountCallbackPending(job)) return false;
  return Boolean(job.oauthState)
    && Boolean(job.sessionAssetId || job.assetId)
    && (!job.cpaPath || job.cpaSuperseded === true)
    && String(job.sessionState?.step || '') === 'verified';
}

function ensureAuthCallbackProxyRecovery(job) {
  const current = job.authCallbackProxyRecovery && typeof job.authCallbackProxyRecovery === 'object'
    ? job.authCallbackProxyRecovery
    : {};
  const attempts = Number(current.attemptsOnProxy);
  const changes = Number(current.proxyChanges);
  job.authCallbackProxyRecovery = {
    currentProxyId: String(current.currentProxyId || job.proxyId || ''),
    attemptsOnProxy: Number.isFinite(attempts) ? Math.max(0, attempts) : 0,
    proxyChanges: Math.max(
      Number.isFinite(changes) ? Math.max(0, changes) : 0,
      Number(job.freshExitRestarts || 0),
    ),
    rebuildPending: current.rebuildPending === true,
    previousProxyId: String(current.previousProxyId || ''),
    lastFailureAt: String(current.lastFailureAt || ''),
    lastFailureCode: String(current.lastFailureCode || ''),
    exhausted: current.exhausted === true,
    rebuildBlocked: current.rebuildBlocked === true,
  };
  return job.authCallbackProxyRecovery;
}

function queueOAuthLoginRepair(job, error, at = new Date().toISOString()) {
  const recovery = ensureOAuthRecovery(job);
  if (recovery.status === 'pending' || recovery.status === 'in_progress') return true;
  if (recovery.attempts >= OAUTH_LOGIN_REPAIR_LIMIT) return false;
  const normalizedReason = oauthLoginRepairReason(error);
  recovery.status = 'pending';
  recovery.reason = normalizedReason || String(error?.code || 'OAUTH_LOGIN_REQUIRED');
  recovery.requestedAt = at;
  recovery.completedAt = '';
  recovery.lastError = {
    code: String(error?.code || 'OAUTH_LOGIN_REQUIRED'),
    status: Number(error?.status || 0),
  };
  return true;
}

function mailboxAccounts(value) {
  if (Array.isArray(value)) return value;
  return Array.isArray(value?.accounts) ? value.accounts : [];
}

function aliasDomainNames(value) {
  const values = Array.isArray(value) ? value : [];
  return [...new Set(values
    .map((item) => String(item || '').trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean))];
}

function aliasDomainCatalog(value) {
  const candidates = [
    value?.domains,
    value?.availableDomains,
    value?.available_domains,
    value?.catalogDomains,
    value?.catalog_domains,
    value?.data?.domains,
  ];
  return aliasDomainNames(candidates.find(Array.isArray) || []);
}

function remoteMailProviderLabel(config) {
  return String(config?.mail?.provider || '').toLowerCase() === 'fastmail' ? 'Fastmail' : 'Mail.com';
}

async function preflightMailcomAliasDomains(client, config) {
  const settings = providerAliasSettings(config?.mail, config?.mail?.provider);
  const mode = settings.aliasDomainMode;
  const requested = aliasDomainNames(settings.aliasDomains);
  if (!remoteRegistrationMailChannel(config) || mode !== 'selected') {
    return { checked: false, ready: true, requested, usable: requested, unavailable: [], denied: [], available: [] };
  }
  if (typeof client?.listAliasDomains !== 'function') {
    return {
      checked: true,
      ready: false,
      catalogAvailable: false,
      code: 'MAILCOM_ALIAS_DOMAIN_CATALOG_UNAVAILABLE',
      requested,
      unavailable: requested,
      denied: [],
      available: [],
      usable: [],
      error: `${remoteMailProviderLabel(config)} alias domain catalog is unavailable; selected domains were not verified`,
    };
  }
  try {
    const catalog = await client.listAliasDomains();
    const available = aliasDomainCatalog(catalog);
    const denied = aliasDomainNames(catalog?.deniedDomains || catalog?.denied_domains);
    const availableSet = new Set(available);
    const unavailable = requested.filter((domain) => !availableSet.has(domain));
    const usable = requested.filter((domain) => availableSet.has(domain));
    return {
      checked: true,
      catalogAvailable: true,
      // A selected list is a whitelist. One unavailable choice should be
      // dropped for this run; only an empty effective whitelist blocks it.
      ready: usable.length > 0,
      allUnavailable: usable.length === 0,
      ...(usable.length ? {} : { code: 'MAILCOM_SELECTED_DOMAINS_UNAVAILABLE' }),
      requested,
      usable,
      unavailable,
      denied: requested.filter((domain) => denied.includes(domain)),
      available,
      ...(unavailable.length ? {
        error: usable.length
          ? `${remoteMailProviderLabel(config)} selected alias domain(s) were skipped: ${unavailable.join(', ')}; using ${usable.join(', ')}`
          : `${remoteMailProviderLabel(config)} selected alias domain(s) are unavailable: ${unavailable.join(', ')}`,
      } : {}),
    };
  } catch (error) {
    return {
      checked: true,
      ready: false,
      catalogAvailable: false,
      code: 'MAILCOM_ALIAS_DOMAIN_CATALOG_UNAVAILABLE',
      requested,
      unavailable: requested,
      denied: [],
      available: [],
      usable: [],
      error: `${remoteMailProviderLabel(config)} alias domain preflight failed: ${error.message}`,
    };
  }
}

function applyMailcomAliasDomains(client, domains) {
  const normalized = aliasDomainNames(domains);
  if (!client || !normalized.length) return normalized;
  if (typeof client.setAliasDomains === 'function') {
    client.setAliasDomains(normalized);
    return normalized;
  }
  // Compatible test doubles may expose the same option as a public field.
  if (Object.hasOwn(client, 'aliasDomains')) client.aliasDomains = normalized;
  return normalized;
}

function rootAddress(email) {
  const parts = splitEmail(email);
  const plus = parts.local.indexOf('+');
  return `${plus >= 0 ? parts.local.slice(0, plus) : parts.local}@${parts.domain}`.toLowerCase();
}

function mailboxForEmail(accounts, email, preferredId = '') {
  const id = String(preferredId || '');
  if (id) {
    const direct = accounts.find((account) => String(account.id) === id);
    if (direct) return direct;
  }
  const root = rootAddress(email);
  return accounts.find((account) => String(account.email || '').trim().toLowerCase() === root) || null;
}

function event(state, type, details = {}, context = {}) {
  const record = { at: nowIso(context), type, ...details };
  state.events.push(record);
  // Every checkpoint serializes the whole state, so an append-only event log
  // makes a long run's disk cost grow quadratically — and at twenty Workers
  // every one of them blocks on that write. The tail is what anyone actually
  // reads; the head is kept so the start of the run is still visible.
  if (state.events.length > MAX_STATE_EVENTS) {
    const dropped = state.events.length - MAX_STATE_EVENTS;
    state.events.splice(STATE_EVENT_HEAD, dropped, {
      at: record.at,
      type: 'branch_events_truncated',
      dropped: dropped + Number(state.eventsDropped || 0),
      message: 'Older events were dropped to keep the checkpoint small',
    });
    state.eventsDropped = Number(state.eventsDropped || 0) + dropped;
  }
  if (typeof context.onEvent === 'function') context.onEvent(record);
  return record;
}

function makeInitialBranchState(config, plan, options = {}) {
  const normalized = validateV2Config(config, options);
  if (!BRANCH_TASK_KINDS.has(plan.taskKind)) throw new Error(`Unsupported branch task kind: ${plan.taskKind}`);
  const at = nowIso(options);
  return {
    schemaVersion: 2,
    mode: 'gpt-re-orchestrator-v2',
    taskKind: plan.taskKind,
    runId: options.runId || `branch-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`,
    configFingerprint: configFingerprint(normalized),
    executionSettings: executionSettings.snapshot(normalized),
    runPlan: clone(plan),
    status: 'initialized',
    phase: 'initializing',
    createdAt: at,
    updatedAt: at,
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
    normalWait: null,
    mailRentalRetry: null,
    /**
     * When the operator stopped renting more mailboxes, in either mode.
     *
     * Empty means "keep renting". The broker keeps its own `stopRequested`
     * because it also has polling to wind down, but the decision itself lives
     * here so an ordinary rental can be stopped the same way — that was the
     * one lever the unified view still did not offer both modes.
     */
    mailRentalStoppedAt: '',
    /**
     * Set once, the first time the provider says there is no money left.
     * Null means the run may still rent and buy.
     */
    balanceStop: null,
    mailRentalWatch: {
      enabled: plan.mailRentalWatch === true,
      target: Number(plan.mailRentalTarget || 0),
      batchSize: Number(plan.mailRentalBatchSize || 0),
      pollIntervalMs: Number(plan.mailRentalPollIntervalMs || 0),
      claimConcurrency: MAIL_RENTAL_CLAIM_CONCURRENCY,
      claimRetryCount: 0,
      claimedCount: 0,
      starvedSince: '',
      pollCount: 0,
      claimBatchTotal: 0,
      claimBatchRemaining: 0,
      claimBatchClaimed: 0,
      claimBatchSoldOut: 0,
      claimBatchRetryable: 0,
      claimBatchAttempts: 0,
      idleMailboxCount: 0,
      idleMailboxLimit: Math.max(1, Number(config.workers?.maxConcurrency || plan.workerConcurrency || 1)) * 2,
      claimPaused: false,
      lastPolledAt: '',
      nextPollAt: '',
      lastStockCount: null,
      lastPrice: null,
      lastStockStatus: 'unknown',
      lastError: null,
      stopRequested: false,
      autoStopped: false,
      stoppedAt: '',
    },
    events: [],
    manifestPath: '',
    control: { requestedAction: null, requestedAt: '', pausedAt: '', resumedAt: '' },
  };
}

/** True when the run's mail channel rents mailboxes instead of pooling them. */
function rentalMailChannel(config) {
  return String(config?.mail?.provider || '') === 'smsbower';
}

function mailRentalWatchEnabled(context) {
  return rentalMailChannel(context?.config)
    && REGISTRATION_TASK_KINDS.has(context?.state?.taskKind)
    && context?.plan?.mailRentalWatch === true
    && context?.state?.mailRentalWatch?.enabled === true;
}

function normalizeMailRentalWatchState(state) {
  const plan = state.runPlan || {};
  const enabled = plan.mailRentalWatch === true;
  const current = state.mailRentalWatch && typeof state.mailRentalWatch === 'object'
    ? state.mailRentalWatch
    : {};
  const target = enabled
    ? Math.max(1, Math.min(MAX_RENTAL_WATCH_TARGET, Number(plan.mailRentalTarget || current.target || 200)))
    : 0;
  const batchSize = enabled
    ? Math.max(1, Math.min(20, Number(plan.mailRentalBatchSize || current.batchSize || 20)))
    : 0;
  const pollIntervalMs = enabled
    ? Math.max(MIN_RENTAL_WATCH_POLL_INTERVAL_MS, Math.min(3_600_000, Number(plan.mailRentalPollIntervalMs || current.pollIntervalMs || 20_000)))
    : 0;
  const configuredWorkers = Number(plan.workerConcurrency);
  const persistedWorkerCount = Number(current.idleMailboxLimit) / 2;
  const workerCount = Math.max(
    1,
    Number.isFinite(configuredWorkers) && configuredWorkers > 0
      ? configuredWorkers
      : (Number.isFinite(persistedWorkerCount) && persistedWorkerCount > 0 ? persistedWorkerCount : state.workers.length || 1),
  );
  const rentedCount = (state.mailboxes || []).filter((mailbox) => mailbox?.rented === true).length;
  const persistedClaimed = Number(current.claimedCount);
  const claimedCount = enabled
    ? Math.max(rentedCount, Number.isFinite(persistedClaimed) ? persistedClaimed : 0)
    : 0;
  const autoStopped = enabled && (current.autoStopped === true || claimedCount >= target);
  state.mailRentalWatch = {
    enabled,
    target,
    batchSize,
    pollIntervalMs,
    claimConcurrency: MAIL_RENTAL_CLAIM_CONCURRENCY,
    claimRetryCount: Math.max(0, Number(current.claimRetryCount || 0)),
    claimedCount,
    pollCount: Math.max(0, Number(current.pollCount || 0)),
    claimBatchTotal: Math.max(0, Number(current.claimBatchTotal || 0)),
    claimBatchRemaining: Math.max(0, Number(current.claimBatchRemaining || 0)),
    claimBatchClaimed: Math.max(0, Number(current.claimBatchClaimed || 0)),
    claimBatchSoldOut: Math.max(0, Number(current.claimBatchSoldOut || 0)),
    claimBatchRetryable: Math.max(0, Number(current.claimBatchRetryable || 0)),
    claimBatchAttempts: Math.max(0, Number(current.claimBatchAttempts || 0)),
    idleMailboxCount: Math.max(0, Number(current.idleMailboxCount || 0)),
    idleMailboxLimit: workerCount * 2,
    claimPaused: current.claimPaused === true,
    lastPolledAt: String(current.lastPolledAt || ''),
    nextPollAt: String(current.nextPollAt || ''),
    lastStockCount: current.lastStockCount == null ? null : Number(current.lastStockCount),
    lastPrice: current.lastPrice == null ? null : Number(current.lastPrice),
    lastStockStatus: ['ok', 'error', 'unknown'].includes(String(current.lastStockStatus || '').toLowerCase())
      ? String(current.lastStockStatus).toLowerCase()
      : (current.lastStockCount == null ? 'unknown' : 'ok'),
    lastError: current.lastError && typeof current.lastError === 'object' ? current.lastError : null,
    stopRequested: current.stopRequested === true,
    autoStopped,
    stoppedAt: String(current.stoppedAt || (autoStopped ? current.lastPolledAt || '' : '')),
    /** First poll of the current run of polls that could claim nothing. */
    starvedSince: String(current.starvedSince || ''),
  };
  if (autoStopped) state.mailRentalWatch.nextPollAt = '';
  // A checkpoint written before the shared marker existed records its stop
  // only on the broker, so adopt it rather than resuming a stopped run.
  const stoppedAt = String(state.mailRentalStoppedAt || '');
  state.mailRentalStoppedAt = stoppedAt
    || (state.mailRentalWatch.stopRequested ? String(state.mailRentalWatch.stoppedAt || '') : '');
  return state.mailRentalWatch;
}

/** Whether the operator has stopped this run from renting any more mailboxes. */
function mailRentalStopped(state) {
  return Boolean(String(state?.mailRentalStoppedAt || '').trim());
}

/** Whether this run has already hit the provider's empty wallet. */
function balanceStopped(state) {
  return Boolean(state?.balanceStop?.at);
}

/**
 * Stops the run the first time the provider says the account is empty.
 *
 * Claiming and settling are two different commitments. A claimed mailbox costs
 * nothing until `settleMailbox` accepts the charge, and an acquired number is
 * refunded when it is cancelled instead of completed. So the stop is
 * deliberately asymmetric: nothing new is claimed or bought, and everything
 * already held runs to its end and settles, because that money is spent either
 * way and an account is worth more than a refund.
 *
 * Stopping the rental is also what ends the run. `rentalCapacityOutstanding`
 * reads `mailRentalStoppedAt` for both rental modes, and an outstanding rental
 * target is the only thing that keeps the scheduler alive once no job is
 * runnable — a run that went broke at 17:14 kept polling for mailboxes until it
 * was cancelled by hand 43 minutes later.
 */
async function latchBalanceStop(context, note = {}) {
  const state = context.state;
  if (balanceStopped(state)) return false;
  const at = nowIso(context);
  const message = String(note.message || 'The provider reported an empty balance');
  // Remember whether this run adopted the shared rental stop, so a resume after
  // a top-up can hand it back instead of inheriting a halt the operator never
  // asked for.
  const adoptedRentalStop = !mailRentalStopped(state);
  state.balanceStop = {
    at,
    source: String(note.source || ''),
    message,
    adoptedRentalStop,
    balance: Number.isFinite(Number(note.balance)) ? Number(note.balance) : null,
  };
  if (adoptedRentalStop) state.mailRentalStoppedAt = at;
  const watch = state.mailRentalWatch;
  if (watch?.enabled && watch.autoStopped !== true) {
    watch.autoStopped = true;
    watch.stoppedAt = String(watch.stoppedAt || '') || at;
    watch.nextPollAt = '';
  }
  state.normalWait = {
    code: 'SMS_BALANCE',
    message: `${message}。已停止租用邮箱和号码，手上正在跑的完成后任务结束`,
    at,
    nextRunAt: '',
  };
  event(state, 'run_stopped_no_balance', {
    source: state.balanceStop.source,
    balance: state.balanceStop.balance,
    adoptedRentalStop,
    claimedCount: Number(watch?.claimedCount || 0),
    message,
  }, context);
  await context.checkpoint('run_stopped_no_balance');
  return true;
}

/**
 * The settled error a job carries once the run has stopped for lack of money.
 * Terminal on purpose: nothing left in this run can give the job a number.
 */
function balanceStopError(state) {
  const error = new Error(String(state?.balanceStop?.message || 'The provider reported an empty balance'));
  error.code = 'NO_BALANCE';
  error.category = 'settled';
  error.retryable = false;
  error.skipJob = true;
  return error;
}

function remoteRegistrationMailChannel(config) {
  return REMOTE_MAIL_PROVIDERS.includes(String(config?.mail?.provider || '').toLowerCase());
}

function remoteMailboxChannel(config) {
  return REMOTE_MAILBOX_PROVIDERS.includes(String(config?.mail?.provider || '').toLowerCase());
}

/**
 * iCloud with the alias switch on: the 8001 pool hands out the root address
 * and the console derives `root+tag@icloud.com` from it, as it does for the
 * Xiaopingguo pool. Every other remote channel keeps one address per job.
 */
function localAliasesOnRemoteMailbox(context) {
  return String(context?.config?.mail?.provider || '').toLowerCase() === 'icloud'
    && Number(context?.plan?.aliasCount || 1) > 1
    && String(context?.plan?.aliasStrategy || '') !== 'root';
}

function remoteSingleAddressJobs(context) {
  if (localAliasesOnRemoteMailbox(context)) return false;
  return remoteMailboxChannel(context.config) || context.mailClient?.remoteRegistrationAddresses === true;
}

function plannedMailProvider(config = {}, plan = {}) {
  return String(plan?.mailProvider || config?.mail?.provider || '').trim().toLowerCase();
}

function mailClientProvider(client) {
  return String(client?.mailProvider || client?.provider || '').trim().toLowerCase();
}

function remoteMailboxEventPrefix(context) {
  return plannedMailProvider(context?.config, context?.plan) === 'icloud' ? 'icloud' : 'mailcom';
}

/**
 * A run must never use a mailbox client from another pool. The provider is
 * attached to every built-in client; custom test clients may omit it and are
 * left compatible with the old duck-typed interface.
 */
function assertMailClientProvider(client, config, plan, action = 'mail') {
  if (!client) return client;
  const expected = plannedMailProvider(config, plan);
  const actual = mailClientProvider(client);
  if (!expected || !actual || expected === actual) return client;
  const error = new Error(`Mail provider mismatch during ${action}: task requires ${expected}, but the client is ${actual}`);
  error.code = 'MAIL_CLIENT_PROVIDER_MISMATCH';
  error.statusCode = 409;
  error.expectedProvider = expected;
  error.actualProvider = actual;
  error.retryable = false;
  throw error;
}

async function authenticatedMailboxClient(config, options = {}) {
  if (options.mailClient) {
    return assertMailClientProvider(options.mailClient, config, { mailProvider: options.mailProvider }, 'initialization');
  }
  if (rentalMailChannel(config)) {
    // No login: the rental API authenticates per request with the same key the
    // SMS side already uses.
    return assertMailClientProvider(new SmsbowerMailClient({
      baseUrl: config.mail.smsbowerBaseUrl,
      apiKey: secretFromEnv(config.mail, 'apiKeyEnv') || config.mail.apiKey,
      service: config.mail.service,
      domain: config.mail.domain,
      maxPrice: config.mail.maxPrice,
      fetch: options.mailFetch || options.fetch,
    }), config, { mailProvider: options.mailProvider }, 'initialization');
  }
  if (remoteMailboxChannel(config)) {
    const provider = String(config.mail.provider || '').toLowerCase();
    if (provider === 'icloud') {
      return assertMailClientProvider(new IcloudClient({
        baseUrl: config.mail.icloudBaseUrl || config.mail.baseUrl,
        adminToken: secretFromEnv(config.mail, 'adminTokenEnv'),
        fetch: options.mailFetch || options.fetch,
      }), config, { mailProvider: options.mailProvider }, 'initialization');
    }
    const aliasSettings = providerAliasSettings(config.mail, provider);
    return assertMailClientProvider(new MailcomClient({
      baseUrl: config.mail.baseUrl,
      adminToken: secretFromEnv(config.mail, 'adminTokenEnv'),
      provider,
      aliasBatchSize: aliasSettings.aliasBatchSize,
      aliasDomainMode: aliasSettings.aliasDomainMode,
      aliasDomains: aliasSettings.aliasDomains,
      fetch: options.mailFetch || options.fetch,
    }), config, { mailProvider: options.mailProvider }, 'initialization');
  }
  const client = new XiaopingguoClient({
    baseUrl: config.mail.baseUrl,
    origin: config.mail.origin,
    fetch: options.mailFetch || options.fetch,
  });
  await client.login(secretFromEnv(config.mail, 'passwordEnv'));
  return assertMailClientProvider(client, config, { mailProvider: options.mailProvider }, 'initialization');
}

/**
 * What preflight can honestly say about proxies, and what it deliberately does
 * not claim.
 *
 * It reports *supply*: how many candidates each Worker's lane holds, and
 * whether that is enough to expect a verified exit at the measured pass rate.
 * It does not probe. Liveness is checked by the Worker immediately before it
 * starts the job, so a preflight count cannot become a stale health verdict.
 *
 * The per-slot count also catches a lane with only one candidate instead of
 * treating any entry assigned to the run as sufficient for every Worker.
 *
 * `expectedYield` is the number that carries the judgement: candidates times
 * the pass rate these pools actually deliver. Below one exit per Worker the
 * lane is thin enough that the run will be waiting on the catalog rather than
 * on accounts, which is worth saying before the launch rather than after.
 */
function proxyPreflight(config, plan, proxyEntries) {
  const required = Boolean(config.proxyPool.required);
  const requiredCount = required ? plan.workerConcurrency : 0;
  const entries = proxyEntries || [];
  const perSlot = [];
  for (let slot = 1; slot <= requiredCount; slot += 1) {
    perSlot.push(entries.filter((entry) => (
      !Array.isArray(entry.workerSlots) || entry.workerSlots.includes(slot)
    )).length);
  }
  const leanest = perSlot.length ? Math.min(...perSlot) : entries.length;
  // The rate the country pools measured across real runs. Only used to turn a
  // candidate count into something an operator can read as "enough" or "thin".
  const expectedYield = Math.floor(leanest * PROXY_PREFLIGHT_EXPECTED_PASS_RATE);
  return {
    required,
    requiredCount,
    available: entries.length,
    // Candidates in the thinnest lane any Worker is assigned to.
    leanestLane: leanest,
    expectedYield,
    thin: required && expectedYield < requiredCount,
    ready: !required || perSlot.every((count) => count > 0),
  };
}

async function prepareBranchPreflight(config, plan, options = {}) {
  // `plan.mailProvider` is the per-task source of truth. Callers outside the
  // UI (and older resume paths) can pass a Mail.com config together with a
  // Fastmail plan, so apply only that field before constructing the mailbox
  // client. Applying the complete run plan here would also change unrelated
  // preflight rules, such as whether a source OAuth task requires a proxy.
  const configuredProvider = String(config?.mail?.provider || '').trim().toLowerCase();
  const plannedProvider = String(plan?.mailProvider || configuredProvider).trim().toLowerCase();
  const providerConfig = plannedProvider && plannedProvider !== configuredProvider
    ? { ...config, mail: { ...config.mail, provider: plannedProvider } }
    : config;
  const normalized = validateV2Config(providerConfig, options);
  const assets = options.assetStore;
  const proxy = proxyPreflight(normalized, plan, options.proxyEntries || []);
  // A credentials OAuth run signs in with a password and a TOTP secret, so it
  // never reads a mailbox. Only registration still needs a mail channel.
  const mailRequired = REGISTRATION_TASK_KINDS.has(plan.taskKind);
  const smsRequired = requiresSmsPreflight(plan);
  // Keep one provider instance for the whole run. OAuth remains lazy at
  // startup, but its first phone challenge must use the same provider that
  // was preflighted for the full registration path.
  const smsProvider = options.smsProvider || createSmsProvider({ ...normalized.sms, fetch: options.smsFetch });
  const mailProviderEnabled = !mailRequired || isMailProviderEnabled(normalized, plan.mailProvider);
  const rentalMail = mailRequired && rentalMailChannel(normalized);
  const rentalWatch = rentalMail && plan.mailRentalWatch === true;
  const mailTask = mailRequired && mailProviderEnabled
    ? (async () => {
      const client = await authenticatedMailboxClient(normalized, {
        ...options,
        mailProvider: plan.mailProvider,
      });
      // Nothing has been rented yet, so counting the pool would always answer
      // zero. Stock and unit price are what can actually be checked up front.
      if (rentalMail) {
        try {
          return { client, accounts: [], rests: await client.priceRests(), aliasDomains: { checked: false, ready: true, usable: [] } };
        } catch (error) {
          return { client, accounts: [], rests: null, restsError: error, aliasDomains: { checked: false, ready: true, usable: [] } };
        }
      }
      const [accountResult, aliasDomains] = await Promise.all([
        client.listAccounts(),
        remoteRegistrationMailChannel(normalized)
          ? preflightMailcomAliasDomains(client, normalized)
          : Promise.resolve({
            checked: false,
            ready: true,
            requested: [],
            usable: [],
            unavailable: [],
            denied: [],
            available: [],
          }),
      ]);
      return { client, accounts: mailboxAccounts(accountResult), aliasDomains };
    })()
    : Promise.resolve({
      client: null,
      accounts: [],
      aliasDomains: { checked: false, ready: true, usable: [] },
      providerDisabled: mailRequired && !mailProviderEnabled,
    });
  const smsTask = smsRequired
    ? (async () => {
      try {
        return { summary: summarizeSmsPreflight(await smsProvider.preflight(), normalized.sms, { required: true, concurrency: plan.workerConcurrency }), warning: '' };
      } catch (error) {
        return {
          summary: failedSmsPreflight(normalized.sms, error, { required: true }),
          warning: `SMS preflight warning: ${error.message}`,
        };
      }
    })()
    : Promise.resolve({ summary: skippedSmsPreflight(normalized.sms), warning: '' });
  const [{ client, accounts, rests, restsError, aliasDomains, providerDisabled }, smsResult] = await Promise.all([mailTask, smsTask]);
  if (remoteRegistrationMailChannel(normalized)
    && aliasDomains?.checked
    && aliasDomains.ready
    && Array.isArray(aliasDomains.usable)
    && aliasDomains.usable.length) {
    // Reuse the filtered whitelist for the actual run so a later
    // /api/pool/consume cannot re-submit a denied domain.
    applyMailcomAliasDomains(client, aliasDomains.usable);
  }
  let selected = 0;
  let eligible = 0;
  let mailKind = '';
  let unusableHistory = 0;
  let oauthCooldownAssetIds = [];
  const warnings = [];
  if (aliasDomains?.error) warnings.push(aliasDomains.error);
  if (providerDisabled) warnings.push(`${remoteMailProviderLabel(normalized)} is disabled for new tasks; enable it before starting a registration run`);

  if (providerDisabled) {
    mailKind = remoteMailboxChannel(normalized) ? `${normalized.mail.provider}_pool` : 'unbound_mailboxes';
    eligible = 0;
    selected = 0;
  } else if (rentalMail) {
    // "Eligible" is the provider's stock: how many mailboxes this run could
    // still rent, not how many it is holding.
    mailKind = 'rentable_mailboxes';
    // A failed stock read is different from a valid `{ count: 0 }` response.
    // Keep the count unknown so the UI cannot turn a transient provider error
    // into a false sold-out result.
    eligible = restsError ? null : Number(rests?.count || 0);
    selected = restsError ? 0 : Math.min(eligible, plan.mailCount);
    if (restsError) warnings.push(`Mail stock check failed: ${restsError.message}`);
    else if (!eligible) warnings.push(`The mail provider has no ${normalized.mail.domain} mailbox in stock for service ${normalized.mail.service}`);
    const unitPrice = Number(rests?.price || 0);
    if (unitPrice > normalized.mail.maxPrice) {
      // Priced out is not "no stock": say so, and refuse rather than let the
      // run discover it one paid mailbox at a time.
      selected = 0;
      warnings.push(`Mailbox unit price ${unitPrice} exceeds mail.maxPrice ${normalized.mail.maxPrice}`);
    }
  } else if (REGISTRATION_TASK_KINDS.has(plan.taskKind)) {
    mailKind = remoteMailboxChannel(normalized)
      ? `${normalized.mail.provider}_pool`
      : 'unbound_mailboxes';
    const spendsRoot = registrationSpendsRoot(plan, normalized);
    const alreadyRegistered = typeof assets?.knownEmails === 'function' ? assets.knownEmails() : new Set();
    const candidates = eligibleRegistrationAccounts(accounts, {
      // `initializeRegistrationJobs` applies exactly this filter. Preflight has
      // to as well, or the launch gate keeps waving through plans the run
      // cannot start.
      spendsRoot,
      alreadyRegistered,
    });
    // The provider says an address is free; we know it is not, because the run
    // already registered it or one of its aliases. Without this the mailbox page
    // says "1 可领取" and the launch panel says 0, with nothing linking the two.
    unusableHistory = eligibleRegistrationAccounts(accounts, { spendsRoot: false }).length - candidates.length;
    eligible = candidates.length;
    selected = Math.min(eligible, plan.mailCount);
  } else if (plan.oauthSource?.kind === 'credentials') {
    // Nothing external to check: the credentials are the resource, and
    // `run-plan` already refused anything malformed before this point.
    mailKind = 'credentials';
    eligible = plan.oauthSource.accounts.length;
    selected = eligible;
  } else {
    mailKind = 'session_assets';
    if (!assets) throw new Error('Session asset store is required for this task');
    const records = plan.oauthSource.assetIds.map((id) => {
      try { return assets.get(id); } catch { return null; }
    });
    const now = typeof assets.now === 'function' ? assets.now : Date.now;
    oauthCooldownAssetIds = plan.taskKind === 'oauth' && plan.oauthSource?.loginOnly !== true
      ? records
        .filter((asset) => asset && asset.status !== 'corrupt' && oauthCooldownActive(asset, now))
        .map((asset) => String(asset.id || ''))
        .filter(Boolean)
      : [];
    eligible = records.filter((asset) => (
      asset
      && asset.status !== 'corrupt'
      && !oauthCooldownAssetIds.includes(String(asset.id || ''))
    )).length;
    selected = eligible;
    if (records.some((asset) => !asset)) warnings.push('One or more selected login-state assets no longer exist');
    if (oauthCooldownAssetIds.length) {
      warnings.push(`OAuth cooldown is active for ${oauthCooldownAssetIds.length} selected login-state asset(s)`);
    }
  }

  const sms = smsResult.summary;
  if (smsResult.warning) warnings.push(smsResult.warning);
  if (!sms.ready && sms.message && !smsResult.warning) warnings.push(sms.message);
  const requestedMail = REGISTRATION_TASK_KINDS.has(plan.taskKind) ? plan.mailCount : plan.totalAccounts;
  const rentalPriceReady = rentalMail
    && !restsError
    && Boolean(rests)
    && Number(rests?.price || 0) <= normalized.mail.maxPrice;
  // A hang-rental task is a broker, not a one-shot reservation. Current stock
  // is informational; only the provider/price check can block startup.
  const mailReady = rentalWatch
    ? (!providerDisabled && rentalPriceReady)
    : (!providerDisabled && selected === requestedMail);
  const mailDomainReady = aliasDomains?.ready !== false;
  const ready = mailReady && mailDomainReady && proxy.ready && (!smsRequired || sms.ready);
  const MAIL_LABELS = {
    session_assets: 'Login-state assets',
    credentials: 'Account credentials',
    readable_mailboxes: 'Readable OAuth mailboxes',
    rentable_mailboxes: 'Rentable mailboxes in stock',
    unbound_mailboxes: 'Unbound root mailboxes',
    mailcom_pool: 'Mail.com API mailbox pool',
    fastmail_pool: 'Fastmail API mailbox pool',
    icloud_pool: 'iCloud mailbox pool',
  };
  const mailLabel = MAIL_LABELS[mailKind] || MAIL_LABELS.unbound_mailboxes;
  // The mail.com pool drains silently: a cancelled run burns its address for
  // good, and nothing in the console said so until a launch failed outright.
  // Carrying the provider's own counts into the preflight card makes the drain
  // visible while there is still room to act on it.
  const poolSummary = ['mailcom_pool', 'fastmail_pool', 'icloud_pool'].includes(mailKind)
    ? (client?.lastPoolSummary || null)
    : null;
  const poolDetail = mailPoolDetail(poolSummary);
  if (unusableHistory > 0) {
    warnings.push(`邮箱库显示可领取，但其中 ${unusableHistory} 个的地址（或其主账号）本地已注册过，不能再用`);
  }
  const snapshot = {
    schemaVersion: 3,
    ready,
    taskKind: plan.taskKind,
    mail: {
      provider: mailKind === 'session_assets' ? 'session-assets' : normalized.mail.provider,
      providerEnabled: mailProviderEnabled,
      kind: mailKind,
      ready: mailReady && mailDomainReady,
      eligible,
      requested: requestedMail,
      selected,
      domainReady: mailDomainReady,
      ...(oauthCooldownAssetIds.length ? { cooldownAssetIds: oauthCooldownAssetIds } : {}),
      ...(aliasDomains?.checked ? { aliasDomains } : {}),
      // Only the rental channel has a unit price; the console shows it instead
      // of the SMS quote when this channel is selected.
      ...(rentalMail ? {
        ...(restsError ? {
          stockStatus: 'error',
          stockError: {
            code: String(restsError?.code || 'MAIL_STOCK_CHECK_FAILED'),
            message: String(restsError?.message || restsError).slice(0, 240),
          },
        } : { stockStatus: 'ready' }),
        ...(rests ? { unitPrice: Number(rests.price), maxPrice: normalized.mail.maxPrice } : { maxPrice: normalized.mail.maxPrice }),
      } : {}),
      ...(rentalWatch ? {
        rentalWatch: {
          target: plan.mailRentalTarget,
          batchSize: plan.mailRentalBatchSize,
          pollIntervalMs: plan.mailRentalPollIntervalMs,
        },
      } : {}),
      ...(poolSummary ? { pool: poolSummary } : {}),
      ...(unusableHistory > 0 ? { unusableHistory } : {}),
    },
    sms,
    proxy,
    checks: [
      {
        id: 'mail',
        label: mailLabel,
        required: true,
        checked: true,
        ready: mailReady && mailDomainReady,
        detail: [
          rentalWatch
            ? (restsError
              ? 'stock unavailable; retrying provider check'
              : `stock ${eligible}; broker target ${plan.mailRentalTarget}`)
            : `${selected}/${requestedMail}`,
          oauthCooldownAssetIds.length
            ? `OAuth cooldown: ${oauthCooldownAssetIds.length} asset(s)`
            : '',
          aliasDomains?.checked
            ? (mailDomainReady
              ? `${aliasDomains.requested.length} selected domain(s) available`
              : `Unavailable domain(s): ${aliasDomains.unavailable.join(', ')}`)
            : '',
          unusableHistory > 0 ? `${unusableHistory} 个已注册过不可用` : '',
          poolDetail,
        ].filter(Boolean).join(' · '),
      },
      {
        id: 'proxy',
        label: 'Worker proxies',
        required: proxy.required,
        checked: true,
        ready: proxy.ready,
        detail: proxy.required
          ? [
            `候选 ${proxy.leanestLane} 个 · 预计可用 ${proxy.expectedYield}/${proxy.requiredCount}`,
            proxy.thin ? '最瘦的国家池偏薄，运行中会边预检边补货' : '',
          ].filter(Boolean).join(' · ')
          : 'Optional',
      },
      {
        id: 'sms',
        label: 'SMS market',
        required: smsRequired,
        checked: sms.checked,
        ready: sms.ready,
        detail: sms.checked
          ? (sms.message || `${sms.offers} offer(s), balance ${sms.balance ?? 'unknown'} ${sms.currency || 'USD'}`)
          : sms.message,
      },
    ],
    warnings,
    checkedAt: nowIso(options),
  };
  return {
    snapshot,
    resources: {
      mailClient: client,
      mailAccounts: accounts,
      smsProvider,
      smsPreflight: smsRequired ? sms : null,
    },
    effectiveMailAliasDomains: remoteRegistrationMailChannel(normalized)
      && providerAliasSettings(normalized.mail, normalized.mail.provider).aliasDomainMode === 'selected'
      && aliasDomains?.catalogAvailable === true
      ? [...(aliasDomains.usable || [])]
      : null,
  };
}

async function preflightBranch(config, plan, options = {}) {
  return (await prepareBranchPreflight(config, plan, options)).snapshot;
}

function ensureBranchRuntimeState(state, config) {
  state.taskKind = state.taskKind || state.runPlan?.taskKind;
  state.events = Array.isArray(state.events) ? state.events : [];
  state.jobs = Array.isArray(state.jobs) ? state.jobs : [];
  state.mailboxes = Array.isArray(state.mailboxes) ? state.mailboxes : [];
  state.workers = Array.isArray(state.workers) ? state.workers : [];
  state.proxyHealth = state.proxyHealth && typeof state.proxyHealth === 'object' ? state.proxyHealth : {};
  state.proxyLeases = state.proxyLeases && typeof state.proxyLeases === 'object' ? state.proxyLeases : {};
  normalizePersistedProxyState(state);
  state.externalCleanup = Array.isArray(state.externalCleanup) ? state.externalCleanup : [];
  state.normalWait = state.normalWait && typeof state.normalWait === 'object' ? state.normalWait : null;
  state.mailRentalRetry = isPlainRetryState(state.mailRentalRetry) ? {
    attempts: Math.max(0, Number(state.mailRentalRetry.attempts || 0)),
    firstAt: String(state.mailRentalRetry.firstAt || ''),
    nextRunAt: String(state.mailRentalRetry.nextRunAt || ''),
    lastError: state.mailRentalRetry.lastError || null,
  } : null;
  normalizeMailRentalWatchState(state);
  state.control = {
    requestedAction: null,
    requestedAt: '',
    pausedAt: '',
    resumedAt: '',
    ...(state.control && typeof state.control === 'object' ? state.control : {}),
  };
  state.control.pendingJobRetries = Array.isArray(state.control.pendingJobRetries)
    ? state.control.pendingJobRetries
    : [];
  for (let index = state.workers.length; index < config.workers.maxConcurrency; index += 1) {
    state.workers.push({
      id: `worker-${index + 1}`,
      slot: index + 1,
      status: 'idle',
      mailboxId: null,
      proxyId: '',
      proxy: null,
      currentJobId: '',
      laneId: '',
      completedRoots: 0,
      createdAt: state.createdAt,
      updatedAt: state.updatedAt,
    });
  }
  for (const worker of state.workers) worker.laneId = String(worker.laneId || '');
  for (const mailbox of state.mailboxes) {
    if (mailbox.rented === true) {
      mailbox.rentedAt = String(mailbox.rentedAt || mailbox.reservedAt || '');
      if (!mailbox.registrationStartDeadlineAt) {
        const rentedAt = Date.parse(mailbox.rentedAt);
        if (Number.isFinite(rentedAt)) {
          mailbox.registrationStartDeadlineAt = new Date(
            rentedAt + DEFAULT_UNSTARTED_RENTAL_TIMEOUT_MS,
          ).toISOString();
        }
      }
      mailbox.registrationStarted = mailbox.registrationStarted === true
        || mailbox.targetTouched === true
        || Boolean(mailbox.registrationStartedAt)
        || String(mailbox.registrationState || '').toLowerCase() === 'started';
    }
    mailbox.registrationState = String(
      mailbox.registrationState
        || (mailbox.registrationStarted === true || mailbox.targetTouched === true ? 'started' : 'not_started'),
    );
    mailbox.registrationStartedAt = String(mailbox.registrationStartedAt || mailbox.targetTouchedAt || '');
    if (mailbox.registrationStartedAt) mailbox.registrationStarted = true;
    if (mailbox.registrationStarted === true && mailbox.registrationState === 'not_started') {
      mailbox.registrationState = 'started';
    }
    if (!mailbox.lifecycle) {
      if (mailbox.status === 'reservation_pending') mailbox.lifecycle = 'claim_pending';
      else if (mailbox.status === 'released') mailbox.lifecycle = 'released';
      else if (mailbox.registrationState === 'started') mailbox.lifecycle = 'registration_in_progress';
      else mailbox.lifecycle = 'claimed_pending_registration';
    }
  }
  for (const job of state.jobs) {
    ensureOAuthRecovery(job);
    ensureOAuthPhoneValidationRecovery(job);
    ensureProxyTransportRecovery(job);
    ensureAuthCallbackProxyRecovery(job);
    job.sessionVerifiedAt = String(job.sessionVerifiedAt || '');
    job.oauthInventoryRestarts = Number.isFinite(Number(job.oauthInventoryRestarts))
      ? Math.max(0, Number(job.oauthInventoryRestarts))
      : 0;
    job.oauthInventoryRestartExhausted = job.oauthInventoryRestartExhausted === true;
    job.rentalReplacementJobId = String(job.rentalReplacementJobId || '');
    job.rentalReplacementFor = String(job.rentalReplacementFor || '');
    job.rentalReplacementAttempt = Math.max(0, Number(job.rentalReplacementAttempt || 0));
    job.remoteMailboxRegistrationStartedAt = String(job.remoteMailboxRegistrationStartedAt || '');
    job.remoteMailboxRegistrationStartError = job.remoteMailboxRegistrationStartError || null;
    job.remoteMailboxConsumeError = job.remoteMailboxConsumeError || null;
    job.remoteMailboxCleanup = job.remoteMailboxCleanup && typeof job.remoteMailboxCleanup === 'object'
      ? job.remoteMailboxCleanup
      : null;
    const affinity = job.workerAffinity && typeof job.workerAffinity === 'object'
      ? job.workerAffinity
      : null;
    if (affinity) {
      job.workerAffinity = {
        workerId: String(affinity.workerId || ''),
        proxyId: String(affinity.proxyId || ''),
        boundAt: String(affinity.boundAt || ''),
        updatedAt: String(affinity.updatedAt || affinity.boundAt || ''),
      };
    } else if (!TERMINAL_JOB_STATUSES.has(job.status) && job.proxyId) {
      const owner = state.workers.find((worker) => String(worker.proxyId || '') === String(job.proxyId));
      job.workerAffinity = owner ? {
        workerId: owner.id,
        proxyId: String(job.proxyId),
        boundAt: String(job.startedAt || job.updatedAt || state.createdAt || ''),
        updatedAt: String(job.updatedAt || state.updatedAt || ''),
      } : null;
    } else {
      job.workerAffinity = null;
    }
    job.nextRunAt = String(job.nextRunAt || '');
    job.retry = isPlainRetryState(job.retry) ? {
      phase: String(job.retry.phase || ''),
      attempts: Math.max(0, Number(job.retry.attempts) || 0),
      firstAt: String(job.retry.firstAt || ''),
      restarted: job.retry.restarted === true,
    } : null;
    job.sms = job.sms || {};
    job.sms.current = job.sms.current || null;
    job.sms.attempts = Array.isArray(job.sms.attempts) ? job.sms.attempts : [];
    job.sms.acquisition = job.sms.acquisition || null;
    job.sms.acquisitions = Array.isArray(job.sms.acquisitions) ? job.sms.acquisitions : [];
    job.sms.inventoryStartedAt = String(job.sms.inventoryStartedAt || '');
    job.sms.inventoryPollCount = Number.isFinite(Number(job.sms.inventoryPollCount))
      ? Math.max(0, Number(job.sms.inventoryPollCount))
      : 0;
    job.sms.costUsd = Number(job.sms.costUsd || 0);
    job.sms.replacements = Number(job.sms.replacements || 0);
    job.sms.sendRetries = Number(job.sms.sendRetries || 0);
  }
  return state;
}

function makeContext(har, state, config, options = {}) {
  const normalized = validateV2Config(state.executionSettings
    ? executionSettings.applySnapshot(clone(config), state.executionSettings)
    : config, options);
  ensureBranchRuntimeState(state, normalized);
  // Paused runs also enter here through cancellation, without initializeJobs.
  // Apply newer compaction rules before any cleanup checkpoint is written.
  for (const job of state.jobs) compactCompletedJob(job);
  const leases = state.jobs.flatMap((job) => [job.sms?.current, ...(job.sms?.attempts || [])]).filter(Boolean);
  const context = {
    ...options,
    har,
    state,
    config: normalized,
    plan: state.runPlan,
    assetStore: options.assetStore,
    proxyEntries: options.proxyEntries || [],
    smsProvider: options.smsProvider || createSmsProvider({ ...normalized.sms, fetch: options.smsFetch, leases }),
    smsPreflightSummary: options.smsPreflight || null,
    mailClient: options.mailClient
      ? assertMailClientProvider(options.mailClient, normalized, state.runPlan, 'runtime')
      : null,
    mailAccounts: Array.isArray(options.mailAccounts) ? options.mailAccounts : [],
    // Mail.com/Fastmail aliases share one master inbox. Keep the provider
    // snapshot single-flight per master, while each job still owns its own
    // recipient boundary and OTP poll.
    emailBoundaryCache: new Map(),
    emailBoundaryFlights: new Map(),
    usedProxyIds: options.usedProxyIds || new Set(state.workers.map((worker) => worker.proxyId).filter(Boolean)),
    proxyPoolRefreshFlight: null,
    proxyPoolRefreshAt: 0,
    fatalAbortController: new AbortController(),
  };
  // Resolves when the write currently serializing has finished.
  let tail = Promise.resolve();
  // A write that has been scheduled but has not begun serializing yet.
  let queued = null;
  let queuedReasons = [];
  let lastSaveEndedAt = 0;
  let lastSaveMs = 0;
  context.checkpoint = async (reason = '') => {
    state.updatedAt = nowIso(context);
    if (reason) state.lastCheckpoint = { at: state.updatedAt, reason };
    // Coalescing, and the reason twenty Workers no longer queue twenty writes.
    //
    // Every checkpoint serializes the *same* mutable `state` object, so a write
    // that has not started yet will pick up whatever this caller just recorded.
    // Joining it is therefore exactly as durable as queueing another write
    // behind it, and it collapses a burst of checkpoints — there are ninety-odd
    // call sites and each Worker walks most of them — into one write in flight
    // plus one pending. Joining a write that has already *started* would not be
    // durable, which is why `queued` is cleared the moment its turn comes.
    if (queued) {
      if (reason) queuedReasons.push(reason);
      return queued;
    }
    queuedReasons = reason ? [reason] : [];
    // `then(run, run)` on purpose: a rejected link used to poison the chain for
    // the rest of the run, so one transient write error turned into every
    // remaining job failing with PROXY_BIND_FAILED. The chain heals; the caller
    // still sees this write's own rejection.
    const run = async () => {
      // Let sockets and timers run before this save blocks the loop again,
      // and keep the gap since the last save at least as long as it took.
      // Callers arriving meanwhile still join this write: `queued` is only
      // cleared when serialization actually starts.
      await new Promise((resolve) => setImmediate(resolve));
      const gapMs = Math.min(CHECKPOINT_MAX_GAP_MS, lastSaveMs);
      const waitMs = lastSaveEndedAt + gapMs - performance.now();
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
      const reasons = queuedReasons;
      queued = null;
      queuedReasons = [];
      const startedAt = performance.now();
      try {
        if (typeof options.saveState === 'function') await options.saveState(state);
        if (typeof options.onCheckpoint === 'function') {
          await options.onCheckpoint({
            reason: reasons[reasons.length - 1] || reason,
            // Every reason this one write covers, oldest first: pacing joins
            // more of them, so a listener must not rely on `reason` alone.
            reasons: reasons.length ? reasons : (reason ? [reason] : []),
            coalesced: reasons.length,
            at: state.updatedAt,
            state,
          });
        }
      } finally {
        lastSaveEndedAt = performance.now();
        lastSaveMs = lastSaveEndedAt - startedAt;
      }
    };
    const settled = tail.then(run, run);
    queued = settled;
    tail = settled.catch(() => {});
    return settled;
  };
  context.random = typeof options.random === 'function' ? options.random : Math.random;
  context.mailRentalRetryDelayMs = Math.max(1, Number(options.mailRentalRetryDelayMs || MAIL_RENTAL_RETRY_DELAY_MS));
  // Tests can collapse the backoff ladder; production uses the saved tuning
  // overlaid on defaults, including resumes outside the web run manager.
  context.retryPolicies = options.retryPolicies || Object.fromEntries(Object.entries(RETRY_POLICIES).map(([phase, policy]) => [phase, { ...policy, ...context.config.retryPolicy?.[phase] }]));
  context.action = () => options.control?.requestedAction?.() || state.control?.requestedAction || '';
  context.signal = () => options.control?.signal || context.fatalAbortController.signal;
  return context;
}

async function ensureMail(context) {
  // Single-flight. The old guard was evaluated synchronously, so twenty Workers
  // arriving together all fell through it and each ran a provider login — and
  // on the rental channel `listAccounts()` answers `[]` until something is
  // rented, so the guard never latched and every call re-hit the provider.
  if (context.mailReady) return context.mailReady;
  context.mailReady = loadMail(context).catch((error) => {
    context.mailReady = null;
    throw error;
  });
  return context.mailReady;
}

async function loadMail(context) {
  if (context.mailClient && context.mailAccounts.length) return;
  context.mailClient = assertMailClientProvider(
    context.mailClient || await authenticatedMailboxClient(context.config, {
      ...context,
      mailProvider: context.plan?.mailProvider,
    }),
    context.config,
    context.plan,
    'runtime',
  );
  // A rental channel has nothing to list until something has been rented, so an
  // empty answer here is normal and must not keep re-triggering a login.
  if (rentalMailChannel(context.config)) {
    if (typeof context.mailClient.restoreMailbox === 'function') {
      for (const mailbox of context.state.mailboxes.filter((item) => item.rented === true && !item.rentalClosed)) {
        context.mailClient.restoreMailbox(mailbox);
      }
    }
    context.mailAccounts = mailboxAccounts(await context.mailClient.listAccounts());
    return;
  }
  context.mailAccounts = mailboxAccounts(await context.mailClient.listAccounts());
}

function primaryMailProvider(context) {
  return String(context.plan?.mailProvider || context.config?.mail?.provider || '').trim().toLowerCase();
}

/**
 * The mail channel a job's own mailbox lives on.
 *
 * A login-state OAuth task may mix assets from several channels — SMSBower
 * Gmail, the Xiaopingguo pool, iCloud, Mail.com. The run's plan names only one
 * of them, so each job carries the channel of the asset it came from. Older
 * checkpoints without the field read it from the asset once.
 */
function jobMailProvider(job, context) {
  const recorded = String(job?.mailProvider || '').trim().toLowerCase();
  if (recorded) return recorded;
  if (!job?.assetId || !context.assetStore || context.plan?.oauthSource?.kind !== 'session_assets') return '';
  try {
    const provider = String(sessionAssetMailProviderEvidence(context.assetStore.get(job.assetId)).provider || '');
    if (provider) job.mailProvider = provider;
    return provider;
  } catch {
    return '';
  }
}

/**
 * The context a job's mailbox reads go through.
 *
 * For the run's own channel that is the run context itself. For any other
 * channel a client is built once, lazily — most OAuth jobs never open their
 * mailbox at all — and the job gets a view of the run context whose mail
 * config, client and account list point at that channel. Everything else on
 * the view (state, checkpoint, caches) is the run's own.
 */
async function mailContextForJob(job, context) {
  const provider = jobMailProvider(job, context);
  if (!provider || provider === primaryMailProvider(context)) {
    await ensureMail(context);
    return context;
  }
  context.providerMail = context.providerMail || new Map();
  let entry = context.providerMail.get(provider);
  if (!entry) {
    const config = validateV2Config({
      ...context.config,
      mail: {
        ...context.config.mail,
        provider,
        baseUrl: providerBaseUrl(context.config.mail, provider),
      },
    });
    entry = { provider, config, view: null, ready: null };
    context.providerMail.set(provider, entry);
  }
  if (!entry.ready) {
    entry.ready = (async () => {
      const client = await authenticatedMailboxClient(entry.config, {
        mailClient: context.mailClients?.[provider] || null,
        mailFetch: context.mailFetch,
        fetch: context.fetch,
        mailProvider: provider,
      });
      const accounts = mailboxAccounts(await client.listAccounts());
      entry.view = Object.create(context, {
        config: { value: entry.config, writable: true, enumerable: true },
        mailClient: { value: client, writable: true, enumerable: true },
        mailAccounts: { value: accounts, writable: true, enumerable: true },
        mailReady: { value: Promise.resolve(), writable: true, enumerable: true },
      });
      event(context.state, 'mail_provider_client_ready', {
        jobId: job.id,
        provider,
        primaryProvider: primaryMailProvider(context),
        accounts: accounts.length,
        message: `Opened the ${provider} mailbox channel for login states that came from it`,
      }, context);
    })().catch((error) => {
      entry.ready = null;
      throw error;
    });
  }
  await entry.ready;
  return entry.view;
}

function jobBase(input, state) {
  const at = state.createdAt;
  return {
    id: `job-${hashId(`${state.runId}|${input.email}|${input.assetId || ''}`)}`,
    taskKind: state.taskKind,
    email: input.email,
    parentEmail: input.parentEmail || input.email,
    mailboxId: input.mailboxId || '',
    laneId: String(input.mailboxId || input.parentEmail || input.assetId || input.email).toLowerCase(),
    assetId: input.assetId || '',
    // Only a credentials-sourced job carries these; every other task kind
    // derives its secrets from the asset store or creates them as it goes.
    credentials: input.credentials
      ? {
        password: String(input.credentials.password || ''),
        totpSecret: String(input.credentials.totpSecret || ''),
      }
      : null,
    // Registration jobs provide a 1-based alias position explicitly. Source
    // jobs such as OAuth reuse an existing account and have no alias position.
    aliasIndex: Number(input.aliasIndex || 0),
    status: 'queued',
    phase: 'queued',
    branch: state.taskKind,
    nextRunAt: '',
    retry: null,
    proxy: null,
    proxyId: '',
    workerAffinity: null,
    proxyTransportRecovery: {
      attempted: false,
      pending: false,
      failureCount: 0,
      attemptedAt: '',
      resumedAt: '',
      lastFailureAt: '',
      lastFailureCode: '',
    },
    authCallbackProxyRecovery: {
      currentProxyId: '',
      attemptsOnProxy: 0,
      proxyChanges: 0,
      rebuildPending: false,
      previousProxyId: '',
      lastFailureAt: '',
      lastFailureCode: '',
      exhausted: false,
      rebuildBlocked: false,
    },
    sessionState: null,
    sessionVerifiedAt: '',
    oauthState: null,
    oauthInventoryRestarts: 0,
    oauthContinuationRestarts: 0,
    oauthInventoryRestartExhausted: false,
    oauthRecovery: {
      status: 'idle',
      attempts: 0,
      reason: '',
      requestedAt: '',
      startedAt: '',
      completedAt: '',
      lastError: null,
    },
    oauthPhoneValidationRecovery: {
      status: 'idle',
      attempts: 0,
      reason: '',
      requestedAt: '',
      startedAt: '',
      completedAt: '',
      activationId: '',
      previousOAuthState: '',
      outcome: '',
      manualRestarts: 0,
      lastManualRestartAt: '',
      manualReviewRequired: false,
      lastError: null,
    },
    accountCreatedAt: '',
    sessionAssetId: '',
    remoteMailboxRegistrationStartedAt: '',
    remoteMailboxRegistrationStartError: null,
    remoteMailboxConsumedAt: '',
    remoteMailboxConsumeError: null,
    remoteMailboxCleanup: null,
    cpaPath: '',
    cpaRevision: 0,
    cpaSuperseded: false,
    sms: {
      current: null,
      attempts: [],
      acquisition: null,
      acquisitions: [],
      inventoryStartedAt: '',
      inventoryPollCount: 0,
      costUsd: 0,
      replacements: 0,
      sendRetries: 0,
    },
    error: null,
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * Addresses this run must not register again.
 *
 * A root mailbox is marked `bound` upstream once reserved, so it normally
 * cannot come back — but a reservation that failed to persist, a rented
 * address the provider re-issues, or a resumed plan can all put a spent
 * address back in front of the generator. Registering it a second time does
 * not create a second account: OpenAI answers on the login path, `user/register`
 * is refused, and the run pays for a mailbox to re-derive an asset it already
 * had. The asset store is the local record of what has been registered, so it
 * is the thing to ask.
 */
function registeredEmails(context) {
  const known = typeof context.assetStore?.knownEmails === 'function'
    ? context.assetStore.knownEmails()
    : new Set();
  for (const job of context.state.jobs || []) {
    const email = String(job.email || '').trim().toLowerCase();
    if (email) known.add(email);
  }
  return known;
}

/**
 * The one predicate that decides whether a provider mailbox can be registered.
 *
 * Preflight and initialization used to filter the account list separately, and
 * the two disagreed: only initialization dropped an address the asset store
 * already knew. `knownEmails()` deliberately includes each asset's *parent*, so
 * one completed alias registration also spends its root — which the console
 * never subtracted. The launch panel showed 9/9 ready, the run started, and it
 * died at `initializing` with NO_ELIGIBLE_MAILBOX before a single job existed.
 * Two callers, one predicate.
 *
 * `reusable !== false` is what keeps a provider-disabled address out: the
 * mail.com pool marks a spent root that way once its cycle recycles. A channel
 * that does not send the field is unaffected.
 */
/**
 * Whether the run registers the pool address itself, so a root that already
 * produced an account must be skipped. iCloud's alias switch registers the
 * root first (`root_plus`), exactly like its root-only mode did; before this,
 * turning the switch on handed out a master registered weeks earlier.
 */
function registrationSpendsRoot(plan = {}, config = {}) {
  const strategy = String(plan.aliasStrategy || '');
  if (strategy === 'root') return true;
  const provider = String(plan.mailProvider || config?.mail?.provider || '').toLowerCase();
  return strategy === 'root_plus' && provider === 'icloud';
}

function eligibleRegistrationAccounts(accounts, options = {}) {
  const selectedIds = options.selectedIds instanceof Set ? options.selectedIds : new Set();
  const alreadyRegistered = options.alreadyRegistered instanceof Set ? options.alreadyRegistered : new Set();
  const spendsRoot = options.spendsRoot === true;
  return (accounts || []).filter((account) => (
    account.email
    && account.tokenValid !== false
    && account.bound !== true
    && account.reusable !== false
    && !selectedIds.has(String(account.id))
    && !(spendsRoot && alreadyRegistered.has(String(account.email).trim().toLowerCase()))
  ));
}

/** Provider-accurate name for the pool an operator has to go top up. */
function mailPoolLabel(config) {
  const provider = String(config?.mail?.provider || '').toLowerCase();
  if (provider === 'mailcom') return 'mail.com 邮箱池';
  if (provider === 'fastmail') return 'Fastmail 邮箱池';
  if (provider === 'icloud') return 'iCloud 邮箱池';
  if (provider === 'smsbower') return 'SMSBower 租用邮箱';
  return '小苹果邮箱池';
}

/** `8 可用 / 9 注册中占用 / 1 已用 / 共 20` — the shape of the shortfall. */
function mailPoolDetail(summary) {
  if (!summary || typeof summary !== 'object') return '';
  const parts = [];
  if (summary.available !== undefined) parts.push(`${summary.available} 可用`);
  if (summary.registration_started) parts.push(`${summary.registration_started} 注册中占用`);
  if (summary.claim_pending) parts.push(`${summary.claim_pending} 已领取待注册`);
  if (summary.consumed !== undefined) parts.push(`${summary.consumed} 已用`);
  if (summary.mailboxes !== undefined) parts.push(`共 ${summary.mailboxes}`);
  return parts.join(' / ');
}

/**
 * iCloud mailboxes are claimed from the 8001 pool as Workers free up, not all
 * at the start. 8001 hands a claim that has not started registering back to
 * the pool after 30 minutes; a run that claimed its whole target up front had
 * mailboxes queued behind busy Workers for longer than that, and they went
 * back to "available" while this run still counted them as its own.
 */
function onDemandPoolClaims(context) {
  return String(context.config?.mail?.provider || '').toLowerCase() === 'icloud'
    && REGISTRATION_TASK_KINDS.has(context.state.taskKind);
}

/** Mailboxes this run is still working on (or about to). */
function activePooledMailboxCount(context) {
  return context.state.mailboxes.filter((mailbox) => {
    if (mailbox.status === 'reservation_pending') return true;
    const jobs = context.state.jobs.filter((job) => String(job.mailboxId) === String(mailbox.id));
    if (!jobs.length) return mailbox.status === 'reserved';
    return jobs.some((job) => !TERMINAL_JOB_STATUSES.has(job.status));
  }).length;
}

function onDemandClaimDeficit(context) {
  const workers = Math.max(1, Number(context.plan.workerConcurrency || 1));
  const remaining = Math.max(0, Number(context.plan.mailCount || 0) - context.state.mailboxes.length);
  return Math.min(remaining, Math.max(0, workers - activePooledMailboxCount(context)));
}

/** One claim pass of the main loop: top the run up to one mailbox per Worker. */
async function claimPooledRegistrationMailboxes(context) {
  if (!onDemandPoolClaims(context) || context.action()) return false;
  if (context.state.mailPoolExhaustedAt || onDemandClaimDeficit(context) <= 0) return false;
  const before = context.state.mailboxes.length;
  try {
    // A mailbox lost to another run between listing and claiming is dropped;
    // claim again in the same pass so a free Worker is not left without work
    // (and an idle run is not mistaken for a finished one).
    for (let pass = 0; pass < 5; pass += 1) {
      const skipsBefore = Number(context.state.mailboxClaimSkips || 0);
      await initializeRegistrationJobs(context, { refresh: true });
      if (onDemandClaimDeficit(context) <= 0 || context.state.mailPoolExhaustedAt) break;
      if (Number(context.state.mailboxClaimSkips || 0) === skipsBefore) break;
    }
  } catch (error) {
    // Nothing left in flight means nothing else will move this run; report it
    // the way a start-up shortage is reported. Otherwise try again next pass.
    if (!activePooledMailboxCount(context)) throw error;
    event(context.state, 'mail_pool_claim_deferred', {
      code: String(error?.code || 'MAIL_POOL_CLAIM_FAILED'),
      message: String(error?.message || error).slice(0, 240),
    }, context);
    return false;
  }
  return context.state.mailboxes.length > before;
}

async function initializeRegistrationJobs(context, options = {}) {
  await ensureMail(context);
  const onDemand = onDemandPoolClaims(context);
  if (onDemand && options.refresh === true) {
    // Other runs claim from the same pool; select from what it says now.
    context.mailAccounts = mailboxAccounts(await context.mailClient.listAccounts());
  }
  const selectedIds = new Set(context.state.mailboxes.map((mailbox) => String(mailbox.id)));
  // A strategy that registers the root address itself cannot reuse a root that
  // already produced an account, however it came back into the pool.
  const spendsRoot = registrationSpendsRoot(context.plan, context.config);
  const alreadyRegistered = registeredEmails(context);
  const available = eligibleRegistrationAccounts(context.mailAccounts, {
    spendsRoot,
    alreadyRegistered,
    selectedIds,
  });
  let needed = onDemand
    ? onDemandClaimDeficit(context)
    : context.plan.mailCount - context.state.mailboxes.length;
  // Rented mailboxes are issued on demand by `rentRegistrationMailbox`, so an
  // empty pool at startup is the expected state rather than a missing resource.
  if (rentalMailChannel(context.config)) return;
  if (onDemand && needed > available.length && context.state.mailboxes.length) {
    // Mid-run the pool may run dry; the run finishes with what it got rather
    // than failing the accounts it already made.
    needed = available.length;
    if (!needed && !context.state.mailPoolExhaustedAt) {
      context.state.mailPoolExhaustedAt = nowIso(context);
      event(context.state, 'mail_pool_exhausted', {
        claimed: context.state.mailboxes.length,
        target: context.plan.mailCount,
        message: `${mailPoolLabel(context.config)}已没有可领取的邮箱，本次共领取 ${context.state.mailboxes.length} / ${context.plan.mailCount} 个`,
      }, context);
      await context.checkpoint('mail_pool_exhausted');
    }
  }
  if (needed > available.length) {
    // The old message named one provider and carried no numbers, so a run that
    // died here told the operator nothing about how short the pool was — or
    // that it was draining at all.
    const pool = context.mailClient?.lastPoolSummary || null;
    const detail = mailPoolDetail(pool);
    throw Object.assign(
      new Error(`${mailPoolLabel(context.config)}可用邮箱不足：本次需要 ${needed} 个，只有 ${available.length} 个可用${detail ? `（${detail}）` : ''}`),
      {
        code: 'NO_ELIGIBLE_MAILBOX',
        provider: String(context.config?.mail?.provider || ''),
        needed,
        available: available.length,
        pool,
      },
    );
  }

  for (const account of available.slice(0, needed)) {
    const mailbox = {
      id: account.id,
      email: account.email,
      rootEmail: account.rootEmail || account.parent || account.email,
      parentEmail: account.parent || account.master || account.email,
      remote: remoteMailboxChannel(context.config),
      providerKind: account.kind || '',
      providerCycle: Number(account.cycle || account.generation || 1),
      status: 'reservation_pending',
      lifecycle: 'claim_pending',
      registrationState: 'not_started',
      registrationStartedAt: '',
      reservation: {
        effect: { kind: 'mailbox_reserve', startedAt: nowIso(context) },
        attempts: 0,
      },
      workerId: '',
      targetCount: context.plan.aliasCount,
      maxAttempts: context.plan.aliasMaxAttempts,
      attemptCount: 0,
      createdCount: 0,
      cpaCompletedCount: 0,
      normalComplete: false,
    };
    context.state.mailboxes.push(mailbox);
    selectedIds.add(String(account.id));
    await context.checkpoint('intent:mailbox_reserve');
  }

  for (const mailbox of context.state.mailboxes) {
    mailbox.targetCount = Number(mailbox.targetCount || context.plan.aliasCount);
    mailbox.maxAttempts = Number(mailbox.maxAttempts || context.plan.aliasMaxAttempts);
    if (mailbox.status === 'reservation_pending') {
      const account = context.mailAccounts.find((candidate) => String(candidate.id) === String(mailbox.id));
      if (account?.bound === true) {
        mailbox.status = 'reserved';
        mailbox.lifecycle = 'claimed_pending_registration';
        mailbox.registrationState = 'not_started';
        mailbox.registrationStartedAt = '';
        mailbox.reservedAt = mailbox.reservedAt || nowIso(context);
        mailbox.reservation = {
          ...(mailbox.reservation || {}),
          effect: null,
          reconciled: true,
          completedAt: nowIso(context),
        };
        await context.checkpoint('mailbox_reserve_reconciled');
      } else {
        mailbox.reservation = mailbox.reservation || {};
        mailbox.reservation.effect = mailbox.reservation.effect
          || { kind: 'mailbox_reserve', startedAt: nowIso(context) };
        mailbox.reservation.attempts = Number(mailbox.reservation.attempts || 0) + 1;
        await context.checkpoint('intent:mailbox_reserve');
        try {
          if (typeof context.mailClient.reserveMailbox === 'function') {
            await context.mailClient.reserveMailbox(mailbox.id);
          }
        } catch (error) {
          mailbox.reservation.lastError = { code: error.code || 'MAILBOX_RESERVE_FAILED', message: error.message };
          mailbox.reservation.lastAttemptAt = nowIso(context);
          if (onDemand && !context.state.jobs.some((job) => String(job.mailboxId) === String(mailbox.id))) {
            // Usually another run took it between the listing and the claim.
            // Nothing was started on it, so it is dropped and the next pass
            // claims a different one.
            context.state.mailboxes = context.state.mailboxes.filter((item) => item !== mailbox);
            context.state.mailboxClaimSkips = Number(context.state.mailboxClaimSkips || 0) + 1;
            if (account) account.bound = true;
            event(context.state, 'mailbox_claim_skipped', {
              mailboxId: String(mailbox.id),
              code: String(error.code || 'MAILBOX_RESERVE_FAILED'),
              message: String(error.message || '').slice(0, 200),
            }, context);
            await context.checkpoint('mailbox_claim_skipped');
            continue;
          }
          await context.checkpoint('mailbox_reserve_uncertain');
          throw error;
        }
        mailbox.status = 'reserved';
        mailbox.lifecycle = 'claimed_pending_registration';
        mailbox.registrationState = 'not_started';
        mailbox.registrationStartedAt = '';
        mailbox.reservedAt = nowIso(context);
        mailbox.reservation = {
          ...mailbox.reservation,
          effect: null,
          completedAt: mailbox.reservedAt,
          lastError: null,
        };
        if (account) account.bound = true;
        await context.checkpoint('mailbox_reserved');
      }
    }

    const existing = context.state.jobs.filter((job) => String(job.mailboxId) === String(mailbox.id));
    if (existing.length || mailbox.status !== 'reserved') continue;
    if (remoteSingleAddressJobs(context)) {
      context.state.jobs.push(jobBase({
        email: mailbox.email,
        parentEmail: mailbox.parentEmail || mailbox.rootEmail,
        mailboxId: mailbox.id,
        aliasIndex: 1,
      }, context.state));
      mailbox.attemptCount = 1;
      mailbox.nextAliasIndex = 2;
      await context.checkpoint('mailbox_remote_address_initialized');
      continue;
    }
    const emails = deriveRegistrationEmails(mailbox.rootEmail, mailbox.targetCount, {
      strategy: context.plan.aliasStrategy,
      runTag: context.plan.aliasRunTag,
      randomInt: context.aliasRandomInt,
      // Four random letters collide about once in seven million, but a resumed
      // or re-reserved root would otherwise re-derive the same address set.
      excludeEmails: [...registeredEmails(context)],
    });
    for (const alias of emails) {
      context.state.jobs.push(jobBase({
        email: alias.email,
        parentEmail: mailbox.rootEmail,
        mailboxId: mailbox.id,
        aliasIndex: alias.index,
      }, context.state));
    }
    mailbox.attemptCount = emails.length;
    mailbox.nextAliasIndex = emails.length + 1;
    await context.checkpoint('mailbox_aliases_initialized');
  }
}

async function initializeSourceJobs(context) {
  const source = context.plan.oauthSource;
  if (source.kind === 'session_assets') {
    for (const assetId of source.assetIds) {
      assertOAuthAssetNotCooling(context, assetId);
      const asset = context.assetStore.get(assetId);
      const job = jobBase({
        email: asset.email,
        parentEmail: asset.parentEmail || asset.email,
        mailboxId: asset.parentMailboxId || '',
        assetId,
        aliasIndex: 0,
      }, context.state);
      // Assets from different mail channels can share one task; each job
      // keeps the channel its mailbox is read through.
      const mailProvider = String(sessionAssetMailProviderEvidence(asset).provider || '');
      if (mailProvider) job.mailProvider = mailProvider;
      context.state.jobs.push(job);
    }
    return;
  }
  // Credentials source: no mailbox is opened, so the jobs carry the secrets
  // they sign in with instead of a mailbox reference.
  for (const account of source.accounts) {
    context.state.jobs.push(jobBase({
      email: account.email,
      parentEmail: account.email,
      mailboxId: '',
      aliasIndex: 0,
      credentials: { password: account.password, totpSecret: account.totpSecret },
    }, context.state));
  }
}

async function initializeJobs(context) {
  // A run resumed from a checkpoint written before trimming existed sheds its
  // finished accounts' working sets on the way back in.
  for (const job of context.state.jobs || []) compactCompletedJob(job);
  if (REGISTRATION_TASK_KINDS.has(context.state.taskKind)) await initializeRegistrationJobs(context);
  else if (!context.state.jobs.length) await initializeSourceJobs(context);
  if (context.state.status === 'running') return;
  context.state.status = 'running';
  context.state.phase = 'running';
  event(context.state, 'branch_jobs_initialized', { taskKind: context.state.taskKind, jobs: context.state.jobs.length }, context);
  await context.checkpoint('branch_jobs_initialized');
}

/**
 * What a finished account no longer needs to carry in the run state.
 *
 * A completed job's login lives on in its session asset and its CPA file, but
 * the job kept the whole working set — the NextAuth session, Sentinel headers,
 * cookie jars, tokens and the CPA body itself — about 115KB per account. Every
 * checkpoint serializes all of it, so the state grew to 11–14MB by account 80
 * and each synchronous save cost ~200ms. Only `complete` jobs are trimmed: a
 * complete job cannot be retried (`retryJob` refuses terminal jobs) and every
 * recovery path that reads these fields is for failed, skipped or partial jobs.
 * The small fields that summaries and registration bookkeeping read — step,
 * status, accountCreated, existingAccount, security — stay.
 */
const COMPLETED_SESSION_STATE_DROP = [
  'session', 'sentinelHeaders', 'sentinelRequestProofs', 'cookieJar', 'cookies',
  'sessionToken', 'accessToken', 'authPayload', 'me', 'events', 'authorizeUrl',
  // Second pass (v2): still ~4KB per account after the first, and a 270-account
  // run stalled again around account 212. Read only by the runners while a
  // login is in flight.
  'usage', 'clientProfile', 'clientIdentity', 'sentinelSdk', 'continueUrl',
  'authCallbackUrl', 'pendingAuthCallbackUrl', 'emailBoundary',
];
const COMPLETED_OAUTH_STATE_DROP = [
  'cookieJar', 'account', 'tokens', 'events', 'accountSelection', 'oauth', 'nextUrl',
  'clientProfile',
];
const JOB_COMPACTION_VERSION = 2;

function compactCompletedJob(job) {
  if (!job || job.status !== 'complete') return false;
  if (Number(job.stateCompacted === true ? 1 : job.stateCompacted || 0) >= JOB_COMPACTION_VERSION) return false;
  for (const [field, drop] of [['sessionState', COMPLETED_SESSION_STATE_DROP], ['oauthState', COMPLETED_OAUTH_STATE_DROP]]) {
    const value = job[field];
    if (!value || typeof value !== 'object') continue;
    for (const key of drop) delete value[key];
  }
  job.stateCompacted = JOB_COMPACTION_VERSION;
  return true;
}

function confirmedRegistration(job) {
  const step = String(job.sessionState?.step || '');
  return Boolean(
    job.sessionAssetId
    || job.accountCreatedAt
    || job.sessionState?.accountCreated
    || ['account_created', 'auth_completed', 'verified'].includes(step)
  );
}

/** Any run that registers accounts, whether or not OAuth follows in the same job. */
function registrationTask(state = {}) {
  return String(state.taskKind || state.runPlan?.taskKind || '').trim() === 'register_session';
}

/**
 * Any run that drives the OAuth phone flow — a standalone `oauth` task, or a
 * registration run that continues into OAuth on the same job and proxy.
 *
 * The phone-failure cooldown used to test `taskKind === 'oauth'` alone, so a
 * register-then-OAuth job could burn its whole replacement budget and still
 * leave the asset uncooled: the next OAuth task picked the same account up and
 * burned another budget on it. Observed live on 2026-09-23: two accounts spent
 * 21 numbers each ($0.65 apiece) and were still written back as `valid` with
 * `oauthCooldown: null`.
 */
function runPerformsOAuth(state = {}) {
  const taskKind = String(state.taskKind || state.runPlan?.taskKind || '').trim();
  if (taskKind === 'oauth') return !oauthRunIsLoginOnly(state);
  if (taskKind === 'register_oauth') return true;
  return taskKind === 'register_session' && state.runPlan?.postRegistrationOAuth === true;
}

function rentalTargetFulfilled(job, context) {
  if (!runPerformsOAuth(context?.state)) return confirmedRegistration(job);
  return job.status === 'complete'
    && (Boolean(job.cpaPath) || ['cpa_saved', 'session_and_cpa_saved'].includes(String(job.result || '')));
}

function finalCallbackFailure(job = {}) {
  if (!TERMINAL_JOB_STATUSES.has(String(job.status || ''))) return false;
  const error = job.error || {};
  const errorCode = String(error.code || '').trim().toUpperCase();
  const causeCode = String(error.causeCode || '').trim().toUpperCase();
  return error.callbackFailure === true
    || errorCode === 'AUTH_CALLBACK_FAILURE'
    || causeCode === 'AUTH_CALLBACK_FAILURE'
    // Older checkpoints only retained the provider's error-page code. Once the
    // job is terminal, that code is the durable evidence that the callback was
    // the final failed step rather than a still-retryable wait.
    || errorCode === 'AUTH_CALLBACK_ERROR_PAGE'
    || job.authCallbackProxyRecovery?.exhausted === true;
}

/**
 * True when this job's own signup created the account.
 *
 * A created account whose callback was lost is finished by signing in again
 * (`callbackLoginRecovery`), and that login leaves `existingAccount` set on the
 * session — so the session alone cannot tell a new account from one that was
 * already registered before the run. Every recovery path is opened only for an
 * account this job created, which makes it the durable evidence.
 */
function accountCreatedInRun(job = {}) {
  return Boolean(job.accountCreatedAt)
    || Boolean(job.callbackLoginRecovery?.status)
    || job.sessionState?.accountCreated === true;
}

/**
 * The result a registration job reports. Also applied when summarizing, so
 * runs checkpointed before this rule read correctly too.
 */
function registrationJobResult(job = {}) {
  const result = String(job.result || '');
  if (result === 'existing_account_recovered' && accountCreatedInRun(job)) return 'session_saved';
  return result;
}

function registrationOutcome(job) {
  if (registrationJobResult(job) === 'existing_account_recovered') return 'existingAccountRecovered';
  if (job?.result === 'session_security_incomplete_oauth_held') return 'securityIncomplete';
  if (finalCallbackFailure(job)) return 'callbackFailed';
  const codes = [job?.error?.code, job?.error?.causeCode]
    .map((code) => String(code || '').trim().toUpperCase())
    .filter(Boolean);
  if (codes.some((code) => REGISTRATION_WASTE_CODES.has(code))) return 'mfaTotp';
  return '';
}

function registrationOutcomeCounts(state) {
  const counts = {
    existingAccountRecovered: 0,
    mfaTotp: 0,
  };
  // Kept off the tile until they happen: a permanent zero row reads as noise
  // rather than as a result.
  let callbackFailed = 0;
  let securityIncomplete = 0;
  for (const job of state.jobs || []) {
    const outcome = registrationOutcome(job);
    if (outcome === 'callbackFailed') callbackFailed += 1;
    else if (outcome === 'securityIncomplete') securityIncomplete += 1;
    else if (outcome) counts[outcome] += 1;
  }
  if (callbackFailed > 0) counts.callbackFailed = callbackFailed;
  if (securityIncomplete > 0) counts.securityIncomplete = securityIncomplete;
  return counts;
}

function jobErrorForSummary(job, state) {
  const current = job?.error || null;
  const mailbox = (state?.mailboxes || [])
    .find((item) => String(item.id) === String(job?.mailboxId));
  if (!mailbox
    || mailbox.rentalClosed !== 'cancelled'
    || !rentalStartExpired(mailbox)
    || confirmedRegistration(job)) return current;
  const currentCodes = [current?.code, current?.causeCode]
    .map((code) => String(code || '').trim().toUpperCase())
    .filter(Boolean);
  if (currentCodes.includes(MAIL_RENTAL_START_TIMEOUT_CODE)) return current;
  return {
    code: MAIL_RENTAL_START_TIMEOUT_CODE,
    message: `Mailbox rental ${mailbox.email || mailbox.id} exceeded the 24-minute registration-start window`,
    category: 'settled',
    mailboxId: mailbox.id,
    ...(mailbox.registrationStartExpiredAt ? { timeoutAt: mailbox.registrationStartExpiredAt } : {}),
  };
}

function registrationSkippedOutcome(job, state) {
  const error = jobErrorForSummary(job, state);
  const codes = [error?.code, error?.causeCode]
    .map((code) => String(code || '').trim().toUpperCase())
    .filter(Boolean);
  if (codes.some((code) => REGISTRATION_EMAIL_TIMEOUT_CODES.has(code))) return 'emailTimeout';
  if (codes.includes(MAIL_RENTAL_START_TIMEOUT_CODE)) return 'rentalStartTimeout';
  if (codes.includes(AUTH_CONTINUATION_ORIGIN_INVALID_CODE)) return 'authContinuationOriginInvalid';
  return '';
}

function registrationSkippedCounts(state) {
  const counts = {
    emailTimeout: 0,
    rentalStartTimeout: 0,
    authContinuationOriginInvalid: 0,
  };
  for (const job of state.jobs || []) {
    const outcome = registrationSkippedOutcome(job, state);
    if (outcome) counts[outcome] += 1;
  }
  return counts;
}

/**
 * Why an account that reached OAuth came out without a CPA.
 *
 * Only accounts that got as far as OAuth count: a 429 during registration is a
 * registration failure, already on 跳过任务. The phone budget is checked
 * first because its exhaustion carries the last number's failure as a cause
 * code, which can itself be a rate limit.
 */
function oauthSkippedOutcome(job) {
  if (!TERMINAL_JOB_STATUSES.has(String(job?.status || '')) || job.status === 'complete') return '';
  if (job.cpaPath && !job.cpaSuperseded) return '';
  if (!job.oauthState && !job.sessionAssetId && !job.assetId) return '';
  const codes = [job.error?.code, job.error?.causeCode]
    .map((code) => String(code || '').trim().toUpperCase())
    .filter(Boolean);
  if (codes.includes('OAUTH_PHONE_REPLACEMENT_BUDGET_EXHAUSTED')) return 'phoneBudgetExhausted';
  if (codes.includes('OAUTH_LOGIN_REQUIRED')) return 'loginRequired';
  if (codes.includes('RATE_LIMIT_EXCEEDED') || Number(job.error?.status || 0) === 429) return 'rateLimited';
  return '';
}

function oauthSkippedCounts(state) {
  const counts = { rateLimited: 0, phoneBudgetExhausted: 0, loginRequired: 0 };
  for (const job of state.jobs || []) {
    const outcome = oauthSkippedOutcome(job);
    if (outcome) counts[outcome] += 1;
  }
  return counts;
}

function wastedRegistrationOutcome(job) {
  const outcome = registrationOutcome(job);
  return outcome === 'mfaTotp' || outcome === 'callbackFailed';
}

function rentalShouldSettleForJob(job, context) {
  // MFA_TOTP and USER_ALREADY_EXISTS mean the rented address was consumed by a
  // registration attempt even though no reusable session asset was produced.
  // A final callback failure is also a consumed registration boundary, even
  // when an older checkpoint did not retain its account-created marker.
  // Charge these outcomes as waste on every registration run. This used to
  // be limited to registration-only runs, but whether OAuth would have
  // followed changes nothing about the mailbox: it has already taken a code,
  // so SMSBower refuses the cancel ("Bad actual activation status") and the
  // rental sat in manual review at $0 — outside both cost and waste. Run
  // ui-20260928104010-sskjn6 (postRegistrationOAuth on) lost two MFA
  // mailboxes that way. All other non-produced outcomes still cancel.
  const outcome = registrationOutcome(job);
  return confirmedRegistration(job)
    || (registrationTask(context.state) && ['mfaTotp', 'callbackFailed'].includes(outcome));
}

function registrationJobsForMailbox(mailbox, context) {
  return context.state.jobs.filter((job) => String(job.mailboxId) === String(mailbox.id));
}

function unassignedRentalReplacement(job, context) {
  return rentalMailChannel(context.config)
    && REGISTRATION_TASK_KINDS.has(context.state.taskKind)
    && Boolean(job.rentalReplacementFor)
    && !String(job.mailboxId || '').trim();
}

function pendingRentalReplacement(context) {
  return context.state.jobs.find((job) => (
    unassignedRentalReplacement(job, context)
    && !TERMINAL_JOB_STATUSES.has(job.status)
  )) || null;
}

function rentalCapacityOutstanding(context) {
  if (!rentalMailChannel(context.config) || !REGISTRATION_TASK_KINDS.has(context.state.taskKind)) return false;
  // One stop for both modes. Mailboxes already held still finish their
  // registrations; nothing new is rented.
  if (mailRentalStopped(context.state)) return false;
  if (mailRentalWatchEnabled(context)) {
    const watch = context.state.mailRentalWatch;
    return watch.stopRequested !== true
      && watch.autoStopped !== true
      && Number(watch.claimedCount || 0) < Number(watch.target || context.plan.mailCount || 0);
  }
  return rentalBudgetRemaining(context) > 0;
}

/** Every mailbox this run has rented, closed or not — what 租约进度 counts. */
function rentedMailboxCount(context) {
  return (context.state.mailboxes || []).filter((mailbox) => mailbox?.rented === true).length;
}

/**
 * How many more mailboxes an ordinary rental run may rent.
 *
 * The plan's mailbox count is a ceiling on rentals, not a quota of successes:
 * every mailbox the provider issued counts once — cancelled, settled, or a
 * replacement for an earlier failure. Replacements used to be exempt, so a run
 * asked for 130 went on renting past 130 while its ordinary lanes, which did
 * respect the ceiling, lost a slot to every replacement and stopped at 107.
 */
function rentalBudgetRemaining(context) {
  const target = Math.max(0, Number(context.plan?.mailCount || 0));
  if (!target) return 0;
  return Math.max(0, target - rentedMailboxCount(context));
}

function mailRentalRetryAt(context) {
  if (!isPlainRetryState(context.state.mailRentalRetry)) return null;
  const parsed = Date.parse(String(context.state.mailRentalRetry.nextRunAt || ''));
  return Number.isFinite(parsed) ? parsed : nowMs(context);
}

function mailRentalWatchPollAt(context) {
  if (!mailRentalWatchEnabled(context)) return null;
  const watch = context.state.mailRentalWatch;
  const snapshot = mailRentalBackpressureSnapshot(context);
  const now = nowMs(context);
  // A claim flight is already authorized. Its completion promise is the useful
  // wake signal, but returning now keeps the helper correct for direct callers.
  if (context.mailRentalClaimFlight) return now;
  // A durable batch may still have windows left, but backpressure can close
  // the room between windows. Do not turn that state into a zero-delay loop.
  if (Number(watch.claimBatchRemaining || 0) > 0) {
    if (snapshot.claimRoom > 0) return now;
    const pausedNext = Date.parse(String(watch.nextPollAt || ''));
    return Number.isFinite(pausedNext) && pausedNext > now
      ? pausedNext
      : now + Math.max(1, Number(watch.pollIntervalMs || 20_000));
  }
  // A Worker completion should reopen the broker immediately after a paused
  // run falls below the threshold, even when the ordinary poll interval has
  // not elapsed yet.
  if (watch.claimPaused === true && snapshot.claimRoom > 0) return now;
  const parsed = Date.parse(String(watch.nextPollAt || ''));
  return Number.isFinite(parsed) ? parsed : now;
}

function mailRentalWakeAt(context) {
  return mailRentalWatchEnabled(context)
    ? mailRentalWatchPollAt(context)
    : mailRentalRetryAt(context);
}

function mailRentalRetryDelay(error, attempt, context) {
  const retryAfterMs = Number(error?.retryAfterMs);
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) return retryAfterMs;
  const base = Math.max(1, Number(context.mailRentalRetryDelayMs || MAIL_RENTAL_RETRY_DELAY_MS));
  return Math.min(
    MAIL_RENTAL_RETRY_MAX_DELAY_MS,
    base * (2 ** Math.max(0, Number(attempt || 1) - 1)),
  );
}

function clearMailRentalRetry(context) {
  const hadRetry = Boolean(context.state.mailRentalRetry);
  const hadWait = context.state.normalWait?.code === 'MAIL_RENTAL_RETRY';
  if (!hadRetry && !hadWait) return false;
  context.state.mailRentalRetry = null;
  if (hadWait) context.state.normalWait = null;
  return true;
}

async function scheduleMailRentalRetry(context, error) {
  const previous = isPlainRetryState(context.state.mailRentalRetry)
    ? context.state.mailRentalRetry
    : {};
  const attempts = Math.max(0, Number(previous.attempts || 0)) + 1;
  const nextRunAt = new Date(nowMs(context) + mailRentalRetryDelay(error, attempts, context)).toISOString();
  const code = String(error?.code || 'MAIL_RENTAL_PROVIDER_RETRY');
  const causeMessage = String(error?.message || 'The mail provider could not issue a mailbox').slice(0, 240);
  const message = `Mailbox rental temporarily unavailable (${code}); retry scheduled for ${nextRunAt}`;
  context.state.mailRentalRetry = {
    attempts,
    firstAt: String(previous.firstAt || nowIso(context)),
    nextRunAt,
    lastError: { code, message: causeMessage },
  };
  context.state.normalWait = {
    code: 'MAIL_RENTAL_RETRY',
    message,
    at: nowIso(context),
    nextRunAt,
  };
  event(context.state, 'mail_rental_retry_scheduled', {
    code,
    attempt: attempts,
    nextRunAt,
    message,
  }, context);
  await context.checkpoint('mail_rental_retry_scheduled');
}

async function deferRentalReplacement(context, pending, error) {
  const retryAt = new Date(nowMs(context) + mailRentalRetryDelay(
    error,
    pending.rentalReplacementAttempt || 1,
    context,
  )).toISOString();
  const providerUnavailable = error.soldOut !== true;
  pending.status = 'waiting';
  pending.phase = MAIL_RENTAL_RETRY_PHASE;
  pending.nextRunAt = retryAt;
  pending.error = {
    code: 'MAIL_RENTAL_UNAVAILABLE',
    message: providerUnavailable
      ? 'The mail provider temporarily failed to issue a mailbox; the replacement will be retried'
      : 'The mail provider has no mailbox in stock; the replacement will be retried',
    ...(error.code ? { causeCode: String(error.code) } : {}),
  };
  event(context.state, 'mail_rental_replacement_waiting', {
    replacementJobId: pending.id,
    nextRunAt: pending.nextRunAt,
    causeCode: error.code || (error.soldOut ? 'MAIL_RENTAL_UNAVAILABLE' : 'MAIL_RENTAL_PROVIDER_RETRY'),
    message: pending.error.message,
  }, context);
  await context.checkpoint('mail_rental_replacement_waiting');
}

function rentalMailboxSlotCounts(context) {
  const fulfilled = context.state.mailboxes.filter((mailbox) => (
    registrationJobsForMailbox(mailbox, context).some((job) => rentalTargetFulfilled(job, context))
  )).length;
  const open = context.state.mailboxes.filter((mailbox) => (
    mailbox.rented === true
      && !mailbox.rentalClosed
      && !registrationJobsForMailbox(mailbox, context).some((job) => rentalTargetFulfilled(job, context))
  )).length;
  return { fulfilled, open };
}

function mailRentalBackpressureSnapshot(context) {
  const workers = Array.isArray(context.state?.workers) ? context.state.workers : [];
  const configuredWorkers = Number(context.plan?.workerConcurrency);
  const workerCount = Math.max(
    1,
    Math.floor(workers.length || (Number.isFinite(configuredWorkers) ? configuredWorkers : 1)),
  );
  const activeMailboxIds = new Set(workers
    .filter((worker) => worker?.status === 'running' && String(worker.mailboxId || '').trim())
    .map((worker) => String(worker.mailboxId)));
  const idleMailboxCount = (context.state.mailboxes || []).filter((mailbox) => (
    mailbox?.rented === true
    && !mailbox.rentalClosed
    && !activeMailboxIds.has(String(mailbox.id))
  )).length;
  const idleMailboxLimit = workerCount * 2;
  return {
    workerCount,
    idleMailboxCount,
    idleMailboxLimit,
    claimRoom: Math.max(0, idleMailboxLimit - idleMailboxCount),
    paused: idleMailboxCount >= idleMailboxLimit,
  };
}

function refreshMailRentalBackpressure(context) {
  const watch = context.state.mailRentalWatch;
  if (!watch) return mailRentalBackpressureSnapshot(context);
  const snapshot = mailRentalBackpressureSnapshot(context);
  const wasPaused = watch.claimPaused === true;
  watch.idleMailboxCount = snapshot.idleMailboxCount;
  watch.idleMailboxLimit = snapshot.idleMailboxLimit;
  watch.claimPaused = snapshot.paused;
  if (wasPaused !== snapshot.paused) {
    event(context.state, 'mail_rental_watch_backpressure', {
      paused: snapshot.paused,
      workerCount: snapshot.workerCount,
      idleMailboxCount: snapshot.idleMailboxCount,
      idleMailboxLimit: snapshot.idleMailboxLimit,
      claimRoom: snapshot.claimRoom,
      message: snapshot.paused
        ? `The rental broker paused claims at ${snapshot.idleMailboxCount} idle mailbox(es); limit is ${snapshot.idleMailboxLimit}`
        : `The rental broker resumed claims with ${snapshot.idleMailboxCount} idle mailbox(es); ${snapshot.claimRoom} slot(s) are available`,
    }, context);
  }
  return { ...snapshot, changed: wasPaused !== snapshot.paused };
}

function scheduleMailRentalBackpressureWait(context, snapshot) {
  const watch = context.state.mailRentalWatch;
  const now = nowMs(context);
  const existingNext = Date.parse(String(watch.nextPollAt || ''));
  const nextPollAt = Number.isFinite(existingNext) && existingNext > now
    ? watch.nextPollAt
    : new Date(now + Math.max(1, Number(watch.pollIntervalMs || 20_000))).toISOString();
  const message = `Unified broker paused: ${snapshot.idleMailboxCount} idle mailbox(es) reached the ${snapshot.idleMailboxLimit} mailbox limit; waiting for a Worker to consume one`;
  const changed = watch.nextPollAt !== nextPollAt
    || context.state.normalWait?.message !== message
    || context.state.normalWait?.nextRunAt !== nextPollAt;
  watch.nextPollAt = nextPollAt;
  context.state.normalWait = {
    code: 'MAIL_RENTAL_WATCH',
    message,
    at: nowIso(context),
    nextRunAt: nextPollAt,
  };
  return changed;
}

function rentalReplacementFailure(job, context) {
  if (!rentalMailChannel(context.config) || !REGISTRATION_TASK_KINDS.has(context.state.taskKind)) return false;
  if (!['failed', 'skipped'].includes(job.status)
    || job.rentalReplacementJobId
    || job.replacementJobId
    || job.compensated === true
    || !job.mailboxId) return false;
  if (runPerformsOAuth(context.state) && confirmedRegistration(job) && !rentalTargetFulfilled(job, context)) return true;
  if (job.status !== 'failed') return false;
  if (job.sessionAssetId || confirmedRegistration(job) || sessionTargetTouched(job)) return false;
  return RENTAL_REPLACEMENT_FAILURE_CODES.has(String(job.error?.code || '').toUpperCase());
}

/**
 * Turns a terminal rented-mail failure into a persisted replacement lane.
 * The old job stays in the history, while the replacement is kept unassigned
 * until a new provider-side rental has actually been opened.
 */
async function replenishFailedRentalJobs(context) {
  if (!rentalMailChannel(context.config) || !REGISTRATION_TASK_KINDS.has(context.state.taskKind)) return 0;
  // Hang-rental counts every issued mailbox against its hard target. A failed
  // address is replaced by the next broker batch, never by a per-job rental.
  if (mailRentalWatchEnabled(context)) return 0;
  if (context.action()) return 0;
  // Queue no more replacements than there are mailboxes left to rent them.
  let room = rentalCapacityOutstanding(context)
    ? rentalBudgetRemaining(context) - context.state.jobs.filter((job) => (
      unassignedRentalReplacement(job, context) && !TERMINAL_JOB_STATUSES.has(job.status)
    )).length
    : 0;
  let added = 0;
  for (const failed of context.state.jobs) {
    if (room <= 0) break;
    if (!rentalReplacementFailure(failed, context)) continue;
    const mailbox = context.state.mailboxes.find((candidate) => String(candidate.id) === String(failed.mailboxId));
    const oauthReplacement = runPerformsOAuth(context.state) && confirmedRegistration(failed);
    const replaceableRental = mailbox && (
      mailbox.rentalClosed === 'cancelled'
      || (oauthReplacement && mailbox.rentalClosed === 'settled')
    );
    if (!replaceableRental) continue;
    const existing = context.state.jobs.find((candidate) => (
      candidate.rentalReplacementFor === failed.id
      && unassignedRentalReplacement(candidate, context)
      && !TERMINAL_JOB_STATUSES.has(candidate.status)
    ));
    if (existing) {
      failed.rentalReplacementJobId = existing.id;
      failed.replacementJobId = existing.id;
      continue;
    }

    const attempt = Number(failed.rentalReplacementAttempt || 0) + 1;
    const replacement = jobBase({
      email: failed.email,
      parentEmail: failed.parentEmail,
      mailboxId: '',
      aliasIndex: failed.aliasIndex,
    }, context.state);
    replacement.id = `job-${hashId(`${context.state.runId}|rental-replacement|${failed.id}|${attempt}`)}`;
    replacement.laneId = `rental-replacement:${failed.id}`;
    replacement.replacementOf = failed.id;
    replacement.rentalReplacementFor = failed.id;
    replacement.rentalReplacementAttempt = attempt;
    replacement.status = 'waiting';
    replacement.phase = MAIL_RENTAL_RETRY_PHASE;
    replacement.nextRunAt = nowIso(context);
    replacement.error = {
      code: 'MAIL_RENTAL_REPLACEMENT_PENDING',
      message: 'The previous rented mailbox was discarded; waiting for a fresh mailbox',
    };
    failed.rentalReplacementAttempt = attempt;
    failed.rentalReplacementJobId = replacement.id;
    failed.replacementJobId = replacement.id;
    // This failed address is intentionally compensated by the replacement;
    // it must not make the eventual run appear partial when the new lane wins.
    failed.compensated = true;
    context.state.jobs.push(replacement);
    added += 1;
    room -= 1;
    event(context.state, 'mail_rental_replacement_queued', {
      failedJobId: failed.id,
      replacementJobId: replacement.id,
      mailboxId: mailbox.id,
      attempt,
      code: failed.error.code,
      message: oauthReplacement
        ? 'The account was registered but OAuth did not produce a CPA; a fresh mailbox will be requested'
        : 'The rented mailbox was cancelled before account creation; a fresh mailbox will be requested',
    }, context);
  }
  if (added) await context.checkpoint('mail_rental_replacement_queued');
  return added;
}

/**
 * How many mailboxes this run is short of, right now.
 *
 * Two separate mistakes lived in the old gate, and together they made the
 * rental channel register strictly one account at a time whatever the Worker
 * count was set to.
 *
 * The first is the comparison. It measured *every* non-terminal job against the
 * idle Worker count, so a job already running on another Worker counted as work
 * a free Worker could pick up. Each rental added one runnable job and consumed
 * one Worker, so the two sides met at half the fleet — and never got there
 * anyway, because of the second mistake.
 *
 * The second is that only one mailbox was ever rented per scheduler pass, and
 * the scheduler's next pass waits on `Promise.race` over the jobs in flight. So
 * pass one rented a mailbox and dispatched the single job it created, then
 * blocked until that whole registration finished before it would rent again.
 * Nineteen Workers sat idle for the duration. The pooled channel never showed
 * this because it builds all of its lanes up front.
 *
 * Measuring only work that no Worker is holding, and renting the shortfall in
 * one parallel batch, gives the rental channel the same first pass the pooled
 * channel has always had.
 */
function rentalMailboxDeficit(context) {
  const budget = rentalBudgetRemaining(context);
  if (budget <= 0) return 0;
  return Math.min(idleWorkersWithoutRunnableWork(context), budget);
}

/**
 * How many idle Workers nothing on hand can occupy right now.
 *
 * The count used to be "idle Workers minus unclaimed jobs", which treated any
 * unclaimed job as able to fill any idle Worker. A job that is mid-transaction
 * is pinned to the Worker it started on — an SMS lease, a created account —
 * and while that Worker is busy with another lane, no idle Worker may take it.
 * Observed at 03:27:35: 163/200 rented, worker-14 idle, and job 150 queued but
 * pinned to worker-4. The old count read that as "1 idle − 1 waiting = 0
 * short", rented nothing, and the scheduler then could not hand job 150 to
 * worker-14 either. So this pairs idle Workers with work the same way
 * `nextJobForWorker` would: lane heads only, a lane already held by a running
 * Worker is not free, and pinned work only goes to its own Worker.
 */
function idleWorkersWithoutRunnableWork(context) {
  const idle = context.state.workers.filter((worker) => worker.status === 'idle');
  if (!idle.length) return 0;
  const now = nowMs(context);
  const jobsById = new Map(context.state.jobs.map((job) => [job.id, job]));
  const claimed = new Set(context.state.workers.map((worker) => worker.currentJobId).filter(Boolean));
  const activeLanes = new Set([...claimed].map((id) => jobsById.get(id)?.laneId).filter(Boolean));
  const runnable = [...pendingLaneHeads(context.state).values()].filter((job) => {
    if (claimed.has(job.id) || activeLanes.has(job.laneId)) return false;
    // Demand for a mailbox, not work for a Worker.
    if (unassignedRentalReplacement(job, context)) return false;
    if (job.status === 'queued') return true;
    // A due retry is promoted to the queue on this same pass; a later one, or a
    // wait with no timer at all, leaves its Worker idle until then.
    if (job.status !== 'waiting') return false;
    const at = scheduledAt(job);
    return at !== null && at <= now;
  });
  const free = new Set(idle);
  const unpinned = [];
  // Pinned work first: it can only ever go to one Worker, so it must not be
  // counted against a Worker that unpinned work could have used instead.
  for (const job of runnable) {
    const takers = idle.filter((worker) => workerMatchesJobAffinity(worker, job));
    if (takers.length === idle.length) {
      unpinned.push(job);
      continue;
    }
    const taker = takers.find((worker) => free.has(worker));
    if (taker) free.delete(taker);
  }
  for (const _job of unpinned) {
    if (!free.size) break;
    free.delete(free.values().next().value);
  }
  // A Worker holding a lane through a wait is busy, not free: renting a
  // mailbox for it would only queue an account nobody will start.
  for (const holder of workersHoldingLanes(context)) free.delete(holder);
  return free.size;
}

function mailRentalClaimRetryDelay(context, failureCount) {
  const pollInterval = Math.max(1, Number(context.state.mailRentalWatch?.pollIntervalMs || 20_000));
  const exponent = Math.max(0, Math.min(6, Number(failureCount || 1) - 1));
  return Math.min(
    pollInterval,
    MAIL_RENTAL_CLAIM_RETRY_MAX_DELAY_MS,
    MAIL_RENTAL_CLAIM_RETRY_DELAY_MS * (2 ** exponent),
  );
}

async function claimWatchMailbox(context) {
  let lastOutcome = { claimed: false, reason: 'sold_out', attempts: 0 };
  for (let attempt = 1; attempt <= MAIL_RENTAL_CLAIM_RETRY_ATTEMPTS; attempt += 1) {
    if (context.state.mailRentalWatch?.stopRequested === true || balanceStopped(context.state)) {
      return { claimed: false, reason: 'stopped', attempts: attempt - 1 };
    }
    const outcome = {};
    try {
      await rentOneMailbox(context, null, {
        outcome,
        suppressUnavailableEvent: true,
        deferCheckpoint: true,
      });
    } catch (error) {
      // A pause/cancel may abort an in-flight provider request. It is a
      // controlled stop, not a fatal broker failure; let the scheduler drain
      // the claim window and enter its requested control state.
      if (context.action()) {
        return {
          claimed: false,
          reason: 'cancelled',
          code: String(error?.code || 'MAIL_RENTAL_CLAIM_CANCELLED'),
          attempts: attempt,
        };
      }
      throw error;
    }
    outcome.attempts = attempt;
    lastOutcome = outcome;
    // A sold-out response can be a stale result from the provider's stock
    // cache. Retry that activation briefly, but do not retry transport or
    // account errors here; the next broker poll owns those backoffs.
    if (outcome.claimed || outcome.reason !== 'sold_out' || attempt >= MAIL_RENTAL_CLAIM_RETRY_ATTEMPTS) {
      return outcome;
    }
    if (!await waitControlled(MAIL_RENTAL_CLAIM_RETRY_DELAY_MS * attempt, context)) {
      return { ...outcome, reason: 'cancelled', attempts: attempt };
    }
  }
  return lastOutcome;
}

function resetMailRentalClaimBatch(watch) {
  watch.claimBatchTotal = 0;
  watch.claimBatchRemaining = 0;
  watch.claimBatchClaimed = 0;
  watch.claimBatchSoldOut = 0;
  watch.claimBatchRetryable = 0;
  watch.claimBatchAttempts = 0;
}

function discardStoppedMailRentalClaimBatch(context) {
  const watch = context.state.mailRentalWatch;
  const hadPendingBatch = Number(watch.claimBatchRemaining || 0) > 0;
  resetMailRentalClaimBatch(watch);
  watch.nextPollAt = '';
  return hadPendingBatch;
}

function notifyMailRentalClaimFlight(flight) {
  if (!flight || typeof flight.resolveWake !== 'function') return;
  const resolve = flight.resolveWake;
  let resolveWake;
  flight.wake = new Promise((nextResolve) => { resolveWake = nextResolve; });
  flight.resolveWake = resolveWake;
  resolve();
}

function recordMailRentalClaimOutcome(context, flight, outcome) {
  const watch = context.state.mailRentalWatch;
  flight.outcomes.push(outcome);
  if (outcome?.claimed === true) watch.claimBatchClaimed += 1;
  if (outcome?.reason === 'sold_out') watch.claimBatchSoldOut += 1;
  if (outcome?.reason === 'retryable') watch.claimBatchRetryable += 1;
  watch.claimBatchAttempts += Math.max(0, Number(outcome?.attempts || 0));
  // The mailbox may return before the Worker scheduler gets its wakeup. Keep
  // the persisted backpressure telemetry conservative until that assignment
  // happens, then refresh it again on the scheduler pass.
  refreshMailRentalBackpressure(context);
}

async function finishMailRentalClaimWindow(context, flight) {
  const watch = context.state.mailRentalWatch;
  const requested = Math.max(0, Number(watch.claimBatchTotal || flight.requested || 0));
  const claimed = Math.max(0, Number(watch.claimBatchClaimed || 0));
  const windowClaimed = flight.outcomes.filter((outcome) => outcome?.claimed === true).length;
  const soldOut = Math.max(0, Number(watch.claimBatchSoldOut || 0));
  const retryable = Math.max(0, Number(watch.claimBatchRetryable || 0));
  const attempts = Math.max(0, Number(watch.claimBatchAttempts || 0));

  if (flight.fatalError) {
    resetMailRentalClaimBatch(watch);
    watch.nextPollAt = '';
    throw flight.fatalError;
  }

  if (context.action()) {
    resetMailRentalClaimBatch(watch);
    watch.nextPollAt = '';
    await context.checkpoint('mail_rental_watch_claim_cancelled');
    return;
  }

  if (balanceStopped(context.state)) {
    // The halt already wrote its own `normalWait` and reason. All this window
    // has to do is drop the rest of the batch without booking a retry poll
    // against an empty wallet — a phantom "retrying at ..." is what the
    // sold-out path is for, and this is not that.
    discardStoppedMailRentalClaimBatch(context);
    watch.nextPollAt = '';
    await context.checkpoint('mail_rental_watch_claims_stopped');
    return;
  }

  if (watch.stopRequested === true) {
    const remaining = Number(watch.claimBatchRemaining || 0);
    discardStoppedMailRentalClaimBatch(context);
    context.state.normalWait = {
      code: 'MAIL_RENTAL_WATCH',
      message: 'Future mailbox claims are stopped; already claimed mailboxes will continue',
      at: nowIso(context),
      nextRunAt: '',
    };
    event(context.state, 'mail_rental_watch_claims_stopped', {
      requested,
      claimed,
      remaining,
      message: 'Future mailbox claims are stopped; already claimed mailboxes will continue',
    }, context);
    await context.checkpoint('mail_rental_watch_claims_stopped');
    return;
  }

  const backpressure = refreshMailRentalBackpressure(context);

  // A completely unavailable window ends this broker batch. Preserve any
  // successful earlier windows, then retry the still-outstanding target on the
  // short backoff rather than issuing duplicate requests in the same poll.
  if (!windowClaimed) {
    watch.claimBatchRemaining = 0;
    watch.claimRetryCount = Math.max(0, Number(watch.claimRetryCount || 0)) + 1;
    const retryDelay = mailRentalClaimRetryDelay(context, watch.claimRetryCount);
    watch.nextPollAt = new Date(nowMs(context) + retryDelay).toISOString();
    const code = soldOut > 0 ? 'MAIL_RENTAL_SOLD_OUT' : 'MAIL_RENTAL_PROVIDER_RETRY';
    const message = soldOut > 0
      ? 'The provider did not issue a mailbox during the claim window'
      : 'The provider did not issue a mailbox; the broker will retry';
    watch.lastError = { code, message };
    context.state.normalWait = {
      code: 'MAIL_RENTAL_WATCH',
      message: `Unified broker saw no issued mailbox in this claim window; retrying at ${watch.nextPollAt}`,
      at: nowIso(context),
      nextRunAt: watch.nextPollAt,
    };
    event(context.state, 'mail_rental_watch_batch_result', {
      requested,
      claimed,
      unavailable: soldOut,
      retryable,
      attempts,
      concurrency: MAIL_RENTAL_CLAIM_CONCURRENCY,
      idleMailboxCount: backpressure.idleMailboxCount,
      idleMailboxLimit: backpressure.idleMailboxLimit,
      claimPaused: backpressure.paused,
      nextPollAt: watch.nextPollAt,
      code,
      message,
    }, context);
    resetMailRentalClaimBatch(watch);
    await context.checkpoint('mail_rental_watch_claim_failed');
    return;
  }

  if (Number(watch.claimBatchRemaining || 0) > 0) {
    // The next window is authorized by the same stock read. Mark it due now so
    // the scheduler starts it as soon as this window has drained, without
    // waiting for the ordinary poll interval.
    watch.nextPollAt = new Date(nowMs(context)).toISOString();
    context.state.normalWait = {
      code: 'MAIL_RENTAL_WATCH',
      message: `Unified broker claimed ${claimed}/${requested}; starting the next claim window`,
      at: nowIso(context),
      nextRunAt: watch.nextPollAt,
    };
    event(context.state, 'mail_rental_watch_batch_progress', {
      requested,
      claimed,
      remaining: watch.claimBatchRemaining,
      unavailable: soldOut,
      retryable,
      attempts,
      concurrency: MAIL_RENTAL_CLAIM_CONCURRENCY,
      idleMailboxCount: backpressure.idleMailboxCount,
      idleMailboxLimit: backpressure.idleMailboxLimit,
      claimPaused: backpressure.paused,
      message: `Unified broker claimed ${claimed}/${requested}; next window is ready`,
    }, context);
    await context.checkpoint('mail_rental_watch_batch_progress');
    return;
  }

  watch.claimRetryCount = 0;
  watch.lastError = null;
  context.state.normalWait = null;
  event(context.state, 'mail_rental_watch_batch_result', {
    requested,
    claimed,
    unavailable: soldOut,
    retryable,
    attempts,
    concurrency: MAIL_RENTAL_CLAIM_CONCURRENCY,
    idleMailboxCount: backpressure.idleMailboxCount,
    idleMailboxLimit: backpressure.idleMailboxLimit,
    claimPaused: backpressure.paused,
    message: `Unified broker claimed ${claimed}/${requested} mailbox(es)`,
  }, context);
  resetMailRentalClaimBatch(watch);
  await context.checkpoint('mail_rental_watch_batch_claimed');
}

async function startMailRentalClaimWindow(context) {
  const watch = context.state.mailRentalWatch;
  if (context.mailRentalClaimFlight) return false;
  if (watch.stopRequested === true) {
    return discardStoppedMailRentalClaimBatch(context);
  }
  const remaining = Math.max(0, Number(watch.claimBatchRemaining || 0));
  if (!remaining) return false;
  const backpressure = refreshMailRentalBackpressure(context);
  if (backpressure.claimRoom <= 0) {
    const waitChanged = scheduleMailRentalBackpressureWait(context, backpressure);
    if (backpressure.changed || waitChanged) await context.checkpoint('mail_rental_watch_backpressure');
    return false;
  }
  const requested = Math.min(MAIL_RENTAL_CLAIM_CONCURRENCY, remaining, backpressure.claimRoom);
  watch.claimBatchRemaining = remaining - requested;
  const flight = {
    requested,
    outcomes: [],
    claims: [],
    fatalError: null,
    wake: null,
    resolveWake: null,
    done: null,
  };
  flight.wake = new Promise((resolve) => { flight.resolveWake = resolve; });
  context.mailRentalClaimFlight = flight;
  try {
    // Persist the remaining window before issuing requests. If the process is
    // restarted during the provider call, the checkpoint at least records the
    // exact batch boundary that was in progress.
    await context.checkpoint('mail_rental_watch_claim_window_started');
  } catch (error) {
    if (context.mailRentalClaimFlight === flight) context.mailRentalClaimFlight = null;
    throw error;
  }
  if (context.action()) {
    resetMailRentalClaimBatch(watch);
    if (context.mailRentalClaimFlight === flight) context.mailRentalClaimFlight = null;
    return false;
  }
  if (watch.stopRequested === true) {
    discardStoppedMailRentalClaimBatch(context);
    if (context.mailRentalClaimFlight === flight) context.mailRentalClaimFlight = null;
    await context.checkpoint('mail_rental_watch_claims_stopped');
    return false;
  }

  for (let index = 0; index < requested; index += 1) {
    const claim = (async () => {
      let outcome;
      try {
        outcome = await claimWatchMailbox(context);
      } catch (error) {
        flight.fatalError = flight.fatalError || error;
        outcome = {
          claimed: false,
          reason: 'fatal',
          code: String(error?.code || 'MAIL_RENTAL_CLAIM_FAILED'),
          attempts: 1,
        };
      }
      recordMailRentalClaimOutcome(context, flight, outcome);
      try {
        // One completion is one durable queue update. Checkpoint coalescing
        // collapses simultaneous completions into at most one write in flight.
        await context.checkpoint('mail_rental_watch_claim_progress');
      } finally {
        notifyMailRentalClaimFlight(flight);
      }
      return outcome;
    })();
    flight.claims.push(claim);
  }
  flight.done = (async () => {
    try {
      const results = await Promise.allSettled(flight.claims);
      const rejected = results.find((result) => result.status === 'rejected');
      if (rejected) throw rejected.reason;
      await finishMailRentalClaimWindow(context, flight);
    } finally {
      if (context.mailRentalClaimFlight === flight) context.mailRentalClaimFlight = null;
      notifyMailRentalClaimFlight(flight);
    }
  })();
  // The scheduler observes this promise. The attached handler prevents an
  // unhandled-rejection report if a control path drains it before the next
  // scheduler wait installs its own observer.
  flight.done.catch(() => {});
  return true;
}

async function rentRegistrationMailboxesFromWatch(context) {
  const watch = context.state.mailRentalWatch;
  // Only one seven-request window may be active. The scheduler can still
  // dispatch any mailbox that has already returned while this flight runs.
  if (context.mailRentalClaimFlight) return false;
  let backpressure = refreshMailRentalBackpressure(context);
  if (watch.stopRequested === true) {
    const discarded = discardStoppedMailRentalClaimBatch(context);
    if (discarded) {
      context.state.normalWait = {
        code: 'MAIL_RENTAL_WATCH',
        message: 'Future mailbox claims are stopped; already claimed mailboxes will continue',
        at: nowIso(context),
        nextRunAt: '',
      };
      event(context.state, 'mail_rental_watch_claims_stopped', {
        message: 'Future mailbox claims are stopped; already claimed mailboxes will continue',
      }, context);
      await context.checkpoint('mail_rental_watch_claims_stopped');
    }
    return false;
  }
  if (Number(watch.claimBatchRemaining || 0) > 0) {
    return startMailRentalClaimWindow(context);
  }
  if (watch.autoStopped === true) return false;
  const now = nowMs(context);
  // `refreshMailRentalBackpressure` above may have observed the Worker consume
  // a mailbox and flipped the persisted flag back to false. Preserve that
  // transition as an immediate wake, even if the previous paused state kept a
  // long ordinary poll timestamp.
  const nextPollAt = backpressure.changed && !backpressure.paused
    ? now
    : mailRentalWatchPollAt(context);
  if (nextPollAt !== null && nextPollAt > now) return false;
  if (backpressure.paused) {
    const waitChanged = scheduleMailRentalBackpressureWait(context, backpressure);
    if (backpressure.changed || waitChanged) await context.checkpoint('mail_rental_watch_backpressure');
    return false;
  }
  if (typeof context.mailClient.priceRests !== 'function') {
    const error = new Error('SMSBower mail client does not support unified stock polling');
    error.code = 'MAIL_RENTAL_STOCK_POLL_UNAVAILABLE';
    error.retryable = false;
    throw error;
  }

  const polledAt = nowIso(context);
  watch.pollCount = Math.max(0, Number(watch.pollCount || 0)) + 1;
  watch.lastPolledAt = polledAt;
  let rests;
  try {
    rests = await context.mailClient.priceRests();
  } catch (error) {
    // Keep the last confirmed quote visible while the provider is recovering.
    // Clearing it here made a short upstream catalogue glitch look like real
    // zero inventory and also made the operator lose the last useful price.
    watch.lastStockStatus = 'error';
    watch.lastError = {
      code: String(error?.code || 'MAIL_RENTAL_STOCK_POLL_FAILED'),
      message: String(error?.message || error).slice(0, 240),
    };
    watch.nextPollAt = new Date(nowMs(context) + Number(watch.pollIntervalMs || 20_000)).toISOString();
    context.state.normalWait = {
      code: 'MAIL_RENTAL_WATCH',
      message: `Unified mailbox stock poll failed; retry scheduled for ${watch.nextPollAt}`,
      at: polledAt,
      nextRunAt: watch.nextPollAt,
    };
    event(context.state, 'mail_rental_watch_poll_failed', {
      code: watch.lastError.code,
      message: watch.lastError.message,
      nextPollAt: watch.nextPollAt,
    }, context);
    await context.checkpoint('mail_rental_watch_poll_failed');
    return false;
  }

  const stock = Math.max(0, Number(rests?.count || 0));
  const price = Number(rests?.price || 0);
  watch.lastStockCount = stock;
  watch.lastPrice = Number.isFinite(price) ? price : null;
  watch.lastStockStatus = 'ok';
  watch.lastError = null;
  watch.nextPollAt = new Date(nowMs(context) + Number(watch.pollIntervalMs || 20_000)).toISOString();
  backpressure = refreshMailRentalBackpressure(context);
  const target = Math.max(0, Number(watch.target || context.plan.mailCount || 0));
  const remaining = Math.max(0, target - Number(watch.claimedCount || 0));
  const batchSize = Math.max(1, Math.min(20, Number(watch.batchSize || 20)));
  // The stock read authorizes a durable batch. The individual claim windows
  // below apply backpressure so the batch can wait for Worker consumption.
  const availableWorkers = rentalMailboxDeficit(context);
  const priceReady = Number.isFinite(price) && price <= Number(context.config.mail.maxPrice || 0);
  if (!priceReady) {
    watch.lastError = {
      code: 'MAIL_RENTAL_PRICE_TOO_HIGH',
      message: `Mailbox price ${price} exceeds max ${context.config.mail.maxPrice}`,
    };
  }
  const batch = priceReady
    ? Math.min(stock, batchSize, remaining)
    : 0;
  // A poll that still owes mailboxes and could not queue one is a starved
  // poll. Backpressure already returned above, so reaching here with an empty
  // batch means the provider has nothing this run can buy.
  if (remaining > 0 && batch === 0) {
    watch.starvedSince = watch.starvedSince || polledAt;
    const starvedFor = nowMs(context) - (Date.parse(watch.starvedSince) || nowMs(context));
    if (starvedFor >= MAIL_RENTAL_STOCK_STARVATION_MS) {
      watch.autoStopped = true;
      watch.stoppedAt = watch.stoppedAt || polledAt;
      watch.nextPollAt = '';
      context.state.normalWait = {
        code: 'MAIL_RENTAL_WATCH',
        message: `The provider had no mailbox this run could claim for ${Math.round(starvedFor / 60_000)} minute(s); finishing with the ${watch.claimedCount} already claimed`,
        at: polledAt,
        nextRunAt: '',
      };
      event(context.state, 'mail_rental_watch_stock_exhausted', {
        stock,
        price,
        claimedCount: watch.claimedCount,
        target,
        starvedForMs: starvedFor,
        message: 'The unified mailbox broker stopped claiming because the provider stayed empty; the round finishes with what it holds',
      }, context);
      await context.checkpoint('mail_rental_watch_stock_exhausted');
      return false;
    }
  } else if (watch.starvedSince) {
    watch.starvedSince = '';
  }
  const claimWindow = Math.min(MAIL_RENTAL_CLAIM_CONCURRENCY, batch, backpressure.claimRoom);
  context.state.normalWait = {
    code: 'MAIL_RENTAL_WATCH',
    message: batch
      ? `Unified broker found ${stock} mailbox(es); queued ${batch}, starting up to ${claimWindow} now`
      : `Unified broker found ${stock} mailbox(es); next poll at ${watch.nextPollAt}`,
    at: polledAt,
    nextRunAt: watch.nextPollAt,
  };
  event(context.state, 'mail_rental_watch_polled', {
    stock,
    price,
    batch,
    availableWorkers,
    workerCount: backpressure.workerCount,
    idleMailboxCount: backpressure.idleMailboxCount,
    idleMailboxLimit: backpressure.idleMailboxLimit,
    claimRoom: backpressure.claimRoom,
    claimPaused: backpressure.paused,
    claimedCount: watch.claimedCount,
    target,
    nextPollAt: watch.nextPollAt,
    message: batch
      ? `Unified broker queued ${batch} mailbox(es); current window allows ${claimWindow}`
      : `Unified broker will poll again at ${watch.nextPollAt}`,
  }, context);
  await context.checkpoint('mail_rental_watch_polled');
  if (!batch || context.action() || watch.stopRequested === true) return false;

  // Persist the whole broker batch before starting its first window. The
  // scheduler then advances this durable queue in 7/7/6 windows while Workers
  // consume each returned mailbox as soon as it is available.
  watch.claimBatchTotal = batch;
  watch.claimBatchRemaining = batch;
  watch.claimBatchClaimed = 0;
  watch.claimBatchSoldOut = 0;
  watch.claimBatchRetryable = 0;
  watch.claimBatchAttempts = 0;
  return startMailRentalClaimWindow(context);
}

/**
 * Rents the mailboxes this run is short of.
 *
 * A rented mailbox is billed from the moment it is issued, so renting the whole
 * `mailCount` up front means paying for mailboxes a run that dies on proxies
 * will never open. Renting exactly the shortfall keeps the spend tracking the
 * work while still filling the fleet in one pass.
 *
 * The batch is issued concurrently: each rental is an upstream round trip and
 * they were being awaited one behind another at the top of the scheduler loop.
 *
 * Returns true when something was added, so the scheduler loops again and picks
 * the new lanes up immediately.
 */
/**
 * Closes replacement lanes that will never get a mailbox.
 *
 * A replacement waits, unassigned, for the next rental. Once the rental is
 * stopped or the plan's mailbox count is spent, none is coming — and a waiting
 * job keeps the scheduler alive, so the run would never finish. The failure it
 * was meant to cover is no longer compensated, so the run reports it.
 */
async function settleStrandedRentalReplacements(context) {
  const stopped = mailRentalStopped(context.state);
  let settled = 0;
  for (const job of context.state.jobs) {
    if (!unassignedRentalReplacement(job, context) || TERMINAL_JOB_STATUSES.has(job.status)) continue;
    job.status = 'skipped';
    job.phase = 'skipped';
    job.nextRunAt = '';
    job.completedAt = nowIso(context);
    job.updatedAt = job.completedAt;
    job.error = {
      code: stopped ? 'MAIL_RENTAL_STOPPED' : 'MAIL_RENTAL_BUDGET_EXHAUSTED',
      message: stopped
        ? 'The mailbox rental was stopped before this replacement got a mailbox'
        : 'Every mailbox the task allows has been rented; this replacement was not given one',
      category: 'settled',
    };
    const source = context.state.jobs.find((candidate) => candidate.id === job.rentalReplacementFor);
    if (source) source.compensated = false;
    event(context.state, 'mail_rental_replacement_dropped', {
      replacementJobId: job.id,
      failedJobId: job.rentalReplacementFor,
      code: job.error.code,
      message: job.error.message,
    }, context);
    settled += 1;
  }
  if (settled) await context.checkpoint('mail_rental_replacement_dropped');
  return settled;
}

async function rentRegistrationMailbox(context) {
  if (!rentalMailChannel(context.config)) return false;
  if (!REGISTRATION_TASK_KINDS.has(context.state.taskKind)) return false;
  if (context.action()) return false;
  if (typeof context.mailClient?.rentMailbox !== 'function') return false;

  if (mailRentalWatchEnabled(context)) return rentRegistrationMailboxesFromWatch(context);

  if (!rentalCapacityOutstanding(context)) {
    // Stopped, or every mailbox the plan allows has been rented. A replacement
    // still waiting for one can never get it, and would hold the run open.
    await settleStrandedRentalReplacements(context);
    clearMailRentalRetry(context);
    return false;
  }

  const deficit = rentalMailboxDeficit(context);
  if (deficit <= 0) return false;
  const now = nowMs(context);
  // Replacements and new lanes share one budget and one batch. A replacement
  // used to be rented alone, and while any was pending — even one parked on a
  // sold-out retry — no new lane was rented at all, so Workers sat idle below
  // the target.
  const replacements = context.state.jobs.filter((job) => {
    if (!unassignedRentalReplacement(job, context) || TERMINAL_JOB_STATUSES.has(job.status)) return false;
    const at = job.status === 'waiting' ? scheduledAt(job) : null;
    return at === null || at <= now;
  }).slice(0, deficit);
  const retryAt = mailRentalRetryAt(context);
  const freshLanes = retryAt !== null && retryAt > now ? 0 : deficit - replacements.length;
  if (!replacements.length && freshLanes <= 0) return false;
  // A provider call may have issued a mailbox even when a sibling call fails.
  // Wait for every result before surfacing a non-retryable error so fatal cleanup
  // sees every mailbox that this batch actually opened.
  const results = await Promise.allSettled([
    ...replacements.map((pending) => rentOneMailbox(context, pending)),
    ...Array.from({ length: freshLanes }, () => rentOneMailbox(context, null)),
  ]);
  const rejected = results.find((result) => result.status === 'rejected');
  if (rejected) throw rejected.reason;
  const claimed = results.some((result) => result.status === 'fulfilled' && result.value === true);
  // A mailbox in hand ends the backoff. It used to be cleared only when the
  // run stopped needing mailboxes at all, so one provider timeout left
  // `mailRentalRetry` — and the 等待库存 banner and stale retry clock it
  // drives — standing for the rest of the run while mailboxes went on being
  // claimed a minute apart. Observed live: a 15:09:37 retry still on screen at
  // 15:12, with five mailboxes rented in between.
  if (claimed) clearMailRentalRetry(context);
  return claimed;
}

async function rentOneMailbox(context, pending, options = {}) {
  const finish = (claimed, reason, details = {}) => {
    if (options.outcome && typeof options.outcome === 'object') {
      Object.assign(options.outcome, { claimed, reason, ...details });
    }
    return claimed;
  };
  let rented;
  try {
    rented = await context.mailClient.rentMailbox({ signal: context.signal() });
  } catch (error) {
    // Out of money is not out of stock. The client has always set this flag and
    // nothing ever read it, so a refusal counted as an ordinary claim failure
    // and was retried: one run spent 53 claim retries against an account that
    // was already at -0.02 USD.
    if (error.insufficientBalance === true) {
      await latchBalanceStop(context, {
        source: 'mail_rental',
        message: String(error.message || 'The mail provider refused the rental for insufficient balance'),
      });
      return finish(false, 'no_balance', { code: String(error?.code || 'MAIL_RENTAL_NO_BALANCE') });
    }
    // Out of stock is a wait, not a failure: the run keeps whatever it already
    // has and tries again on a later pass.
    if (error.soldOut) {
      if (pending) {
        await deferRentalReplacement(context, pending, error);
      } else {
        if (!options.suppressUnavailableEvent) {
          if (mailRentalWatchEnabled(context)) {
            context.state.mailRentalWatch.lastError = {
              code: String(error?.code || 'MAIL_RENTAL_SOLD_OUT'),
              message: 'The provider sold out while the unified batch was being claimed',
            };
          }
          event(context.state, 'mail_rental_unavailable', {
            message: 'The mail provider has no mailbox in stock; the run continues with the mailboxes it already holds',
          }, context);
        }
      }
      return finish(false, 'sold_out', { code: String(error?.code || 'MAIL_RENTAL_SOLD_OUT') });
    }
    if (error.retryable === true) {
      if (pending) await deferRentalReplacement(context, pending, error);
      else if (mailRentalWatchEnabled(context)) {
        if (!options.suppressUnavailableEvent) {
          context.state.mailRentalWatch.lastError = {
            code: String(error?.code || 'MAIL_RENTAL_PROVIDER_RETRY'),
            message: String(error?.message || error).slice(0, 240),
          };
          event(context.state, 'mail_rental_watch_claim_failed', {
            code: context.state.mailRentalWatch.lastError.code,
            message: context.state.mailRentalWatch.lastError.message,
          }, context);
        }
      } else await scheduleMailRentalRetry(context, error);
      return finish(false, 'retryable', {
        code: String(error?.code || 'MAIL_RENTAL_PROVIDER_RETRY'),
        message: String(error?.message || error).slice(0, 240),
      });
    }
    throw error;
  }

  const mailbox = {
    id: String(rented.id),
    email: rented.email,
    rootEmail: rented.email,
    status: 'reserved',
    lifecycle: 'claimed_pending_registration',
    registrationState: 'not_started',
    rentedAt: String(rented.rentedAt || nowIso(context)),
    registrationStartDeadlineAt: String(
      rented.registrationStartDeadlineAt
        || (() => {
          const at = Date.parse(String(rented.rentedAt || nowIso(context)));
          return Number.isFinite(at)
            ? new Date(at + DEFAULT_UNSTARTED_RENTAL_TIMEOUT_MS).toISOString()
            : '';
        })(),
    ),
    registrationStarted: rented.registrationStarted === true,
    registrationStartedAt: String(rented.registrationStartedAt || ''),
    reservedAt: nowIso(context),
    reservation: { effect: null, attempts: 1, completedAt: nowIso(context), lastError: null },
    workerId: '',
    rented: true,
    // Quoted at rent, charged only once the rental is settled.
    quotedPriceUsd: Number(rented.quotedPrice || 0),
    costUsd: 0,
    targetCount: context.plan.aliasCount,
    maxAttempts: context.plan.aliasMaxAttempts,
    attemptCount: 0,
    createdCount: 0,
    cpaCompletedCount: 0,
    normalComplete: false,
  };
  context.state.mailboxes.push(mailbox);
  if (mailRentalWatchEnabled(context)) {
    const watch = context.state.mailRentalWatch;
    watch.claimedCount = Math.max(0, Number(watch.claimedCount || 0)) + 1;
    if (watch.claimedCount >= Number(watch.target || context.plan.mailCount || 0)) {
      watch.autoStopped = true;
      watch.stoppedAt = watch.stoppedAt || nowIso(context);
      watch.nextPollAt = '';
      event(context.state, 'mail_rental_watch_target_reached', {
        claimedCount: watch.claimedCount,
        target: watch.target,
        message: 'The unified mailbox broker reached its target and stopped claiming new mailboxes',
      }, context);
    }
  }
  if (pending) {
    const previousEmail = pending.email;
    pending.email = mailbox.rootEmail;
    pending.parentEmail = mailbox.rootEmail;
    pending.mailboxId = mailbox.id;
    pending.laneId = String(mailbox.id).toLowerCase();
    pending.aliasIndex = 1;
    pending.status = 'queued';
    pending.phase = 'queued';
    pending.nextRunAt = '';
    pending.error = null;
    pending.sessionState = null;
    pending.sessionVerifiedAt = '';
    pending.oauthState = null;
    pending.oauthPhoneValidationRecovery = {
      status: 'idle',
      attempts: 0,
      reason: '',
      requestedAt: '',
      startedAt: '',
      completedAt: '',
      activationId: '',
      previousOAuthState: '',
      outcome: '',
      manualRestarts: 0,
      lastManualRestartAt: '',
      manualReviewRequired: false,
      lastError: null,
    };
    pending.accountCreatedAt = '';
    pending.sessionAssetId = '';
    pending.cpaPath = '';
    pending.cpaRevision = 0;
    pending.cpaSuperseded = false;
    pending.startedAt = '';
    pending.completedAt = '';
    pending.updatedAt = nowIso(context);
    mailbox.attemptCount = 1;
    mailbox.nextAliasIndex = 2;
    event(context.state, 'mail_rental_replacement_rented', {
      replacementJobId: pending.id,
      mailboxId: mailbox.id,
      previousEmail,
      email: mailbox.email,
      attempt: pending.rentalReplacementAttempt,
      message: 'A fresh mailbox was rented for the replacement registration attempt',
    }, context);
  } else {
    const emails = deriveRegistrationEmails(mailbox.rootEmail, mailbox.targetCount, {
      strategy: context.plan.aliasStrategy,
      runTag: context.plan.aliasRunTag,
      randomInt: context.aliasRandomInt,
    });
    for (const alias of emails) {
      context.state.jobs.push(jobBase({
        email: alias.email,
        parentEmail: mailbox.rootEmail,
        mailboxId: mailbox.id,
        aliasIndex: alias.index,
      }, context.state));
    }
    mailbox.attemptCount = emails.length;
    mailbox.nextAliasIndex = emails.length + 1;
  }
  event(context.state, 'mail_rental_opened', {
    mailboxId: mailbox.id,
    email: mailbox.email,
    accounts: pending ? 1 : mailbox.attemptCount,
    replacementJobId: pending?.id || '',
    message: 'Rented a mailbox for the next lane',
  }, context);
  if (!rentalCapacityOutstanding(context)) clearMailRentalRetry(context);
  if (options.deferCheckpoint !== true) await context.checkpoint('mail_rental_opened');
  return finish(true, 'claimed', { mailboxId: mailbox.id });
}

function rentalMailboxRegistrationStarted(mailbox, jobs = []) {
  return mailbox?.registrationStarted === true
    || mailbox?.targetTouched === true
    || Boolean(mailbox?.registrationStartedAt)
    || ['started', 'registration_in_progress', 'consumed'].includes(String(mailbox?.registrationState || '').toLowerCase())
    || jobs.some((job) => sessionTargetTouched(job));
}

function rentalStartExpired(mailbox) {
  return Boolean(
    mailbox
      && (mailbox.registrationStartExpiredAt
        || String(mailbox.registrationState || '').toLowerCase() === 'expired'),
  );
}

/**
 * One reading of the mailbox rental, whichever mode produced it.
 *
 * Both modes rent the same mailboxes under the same 24-minute
 * registration-start window, and both can sit short of their target while the
 * provider is out of stock. Only the unified broker ever reported any of that,
 * so an ordinary rental run showed nothing on the task page — not the deadline
 * about to expire, not why the last claim failed, not how far from the target
 * it was. This is the shape both modes fill; the broker's own machinery stays
 * in `mailRentalWatch` beside it, because only one mode has it.
 */
function summarizeMailRental(state) {
  if (String(state?.runPlan?.mailProvider || '').trim().toLowerCase() !== 'smsbower') return null;
  if (!REGISTRATION_TASK_KINDS.has(state.taskKind)) return null;
  const watch = state.mailRentalWatch?.enabled === true ? state.mailRentalWatch : null;
  const context = { state };
  let claimedCount = 0;
  let activeCount = 0;
  let awaitingStartCount = 0;
  let expiredCount = 0;
  let nextDeadline = null;
  for (const mailbox of state.mailboxes || []) {
    if (mailbox?.rented !== true) continue;
    claimedCount += 1;
    if (rentalStartExpired(mailbox)) expiredCount += 1;
    if (mailbox.rentalClosed) continue;
    activeCount += 1;
    if (rentalMailboxRegistrationStarted(mailbox, registrationJobsForMailbox(mailbox, context))) continue;
    awaitingStartCount += 1;
    const deadline = unstartedRentalDeadlineAt(mailbox);
    if (deadline !== null && (nextDeadline === null || deadline < nextDeadline)) nextDeadline = deadline;
  }
  const retry = isPlainRetryState(state.mailRentalRetry) ? state.mailRentalRetry : null;
  const target = watch
    ? Number(watch.target || 0)
    : Math.max(0, Number(state.runPlan?.mailCount || 0));
  return {
    mode: watch ? 'watch' : 'normal',
    target,
    // The broker counts what it claimed, which includes mailboxes already
    // closed out; an ordinary run has only what it currently holds.
    claimedCount: watch ? Math.max(claimedCount, Number(watch.claimedCount || 0)) : claimedCount,
    activeCount,
    awaitingStartCount,
    expiredCount,
    startWindowMs: DEFAULT_UNSTARTED_RENTAL_TIMEOUT_MS,
    nextStartDeadlineAt: nextDeadline === null ? '' : new Date(nextDeadline).toISOString(),
    retryAt: retry ? String(retry.nextRunAt || '') : '',
    retryAttempts: retry ? Math.max(0, Number(retry.attempts || 0)) : 0,
    stoppedAt: String(state.mailRentalStoppedAt || ''),
    lastError: (watch?.lastError || retry?.lastError || null),
  };
}

function rentalStartTimeoutRecord(job, context) {
  const existing = job?.rentalStartTimeout;
  if (existing?.code === MAIL_RENTAL_START_TIMEOUT_CODE) return existing;

  const mailbox = (context?.state?.mailboxes || [])
    .find((item) => String(item.id) === String(job?.mailboxId));
  if (!mailbox || mailbox.rentalClosed !== 'cancelled' || !rentalStartExpired(mailbox)) return null;

  const timeoutAt = String(mailbox.registrationStartExpiredAt || '');
  const message = `Mailbox rental ${mailbox.email || mailbox.id} exceeded the 24-minute registration-start window`;
  const record = {
    code: MAIL_RENTAL_START_TIMEOUT_CODE,
    message,
    category: 'settled',
    mailboxId: mailbox.id,
    ...(timeoutAt ? { timeoutAt } : {}),
  };
  job.rentalStartTimeout = record;
  return record;
}

function preserveRentalStartTimeout(job, context, record = rentalStartTimeoutRecord(job, context)) {
  if (!record) return false;
  job.nextRunAt = '';
  job.retry = null;
  job.skipPending = null;
  job.status = 'failed';
  job.phase = 'failed';
  job.completedAt = '';
  job.error = {
    code: record.code,
    message: record.message,
    category: record.category,
    mailboxId: record.mailboxId,
    ...(record.timeoutAt ? { timeoutAt: record.timeoutAt } : {}),
  };
  job.updatedAt = nowIso(context);
  return true;
}

function unstartedRentalDeadlineAt(mailbox) {
  const explicit = Date.parse(String(mailbox?.registrationStartDeadlineAt || ''));
  if (Number.isFinite(explicit)) return explicit;
  const rentedAt = Date.parse(String(mailbox?.rentedAt || mailbox?.reservedAt || ''));
  return Number.isFinite(rentedAt) ? rentedAt + DEFAULT_UNSTARTED_RENTAL_TIMEOUT_MS : null;
}

function unstartedRentalExpiryAt(context) {
  if (!rentalMailChannel(context.config)) return null;
  let earliest = null;
  for (const mailbox of context.state.mailboxes || []) {
    if (mailbox?.rented !== true || mailbox.rentalClosed) continue;
    const jobs = registrationJobsForMailbox(mailbox, context);
    if (rentalMailboxRegistrationStarted(mailbox, jobs)) continue;
    const deadline = unstartedRentalDeadlineAt(mailbox);
    if (deadline !== null && (earliest === null || deadline < earliest)) earliest = deadline;
  }
  return earliest;
}

async function expireUnstartedRentalMailboxes(context) {
  if (!rentalMailChannel(context.config)) return 0;
  const now = nowMs(context);
  const due = (context.state.mailboxes || []).filter((mailbox) => {
    if (mailbox?.rented !== true || mailbox.rentalClosed) return false;
    const jobs = registrationJobsForMailbox(mailbox, context);
    const deadline = unstartedRentalDeadlineAt(mailbox);
    return deadline !== null
      && deadline <= now
      && !rentalMailboxRegistrationStarted(mailbox, jobs);
  });
  let expired = 0;
  for (const mailbox of due) {
    const expiredAt = nowIso(context);
    const message = `Mailbox rental ${mailbox.email || mailbox.id} exceeded the 24-minute registration-start window`;
    const timeoutError = Object.assign(new Error(message), {
      code: MAIL_RENTAL_START_TIMEOUT_CODE,
      retryable: false,
      category: 'settled',
      mailboxId: mailbox.id,
    });
    // Set the durable expiry marker before the first await. A worker that was
    // already waking up can otherwise clear the timeout while this cleanup is
    // waiting on SMS cancellation.
    mailbox.registrationState = 'expired';
    mailbox.lifecycle = 'expired';
    mailbox.registrationStartExpiredAt = expiredAt;
    const jobs = registrationJobsForMailbox(mailbox, context);
    for (const job of jobs) {
      if (TERMINAL_JOB_STATUSES.has(job.status)) continue;
      job.rentalStartTimeout = {
        code: timeoutError.code,
        message,
        category: timeoutError.category,
        mailboxId: mailbox.id,
        timeoutAt: expiredAt,
      };
      job.nextRunAt = '';
      job.retry = null;
      job.skipPending = null;
      job.status = 'failed';
      job.phase = 'failed';
      job.error = {
        code: timeoutError.code,
        message,
        category: timeoutError.category,
        mailboxId: mailbox.id,
        timeoutAt: expiredAt,
      };
      await failJobAfterRunError(job, null, context, timeoutError);
    }
    const result = await closeRentedMailbox(mailbox, 'cancel', 0, context);
    event(context.state, 'mail_rental_start_timeout', {
      mailboxId: mailbox.id,
      email: mailbox.email,
      jobIds: jobs.map((job) => job.id),
      closeResult: result,
      message: `${message}; the rental was cancelled and unstarted jobs failed`,
    }, context);
    await context.checkpoint('mail_rental_start_timeout');
    expired += 1;
  }
  return expired;
}

/**
 * Closes the rentals whose lane has finished.
 *
 * Settling accepts the charge, so it normally happens once every account on
 * the mailbox is done *and* carries the password and TOTP that let it log in
 * without email again. MFA_TOTP is the explicit only-registration exception:
 * the mailbox was consumed by a registration attempt and is charged as waste.
 * OAuth may be optional. A lane still holding unfinished or partial work is
 * left open on purpose: a retry will need the mailbox.
 */
async function settleFinishedRentals(context, options = {}) {
  if (!rentalMailChannel(context.config)) return 0;
  const forceClose = options.forceClose === true;
  if (!context.mailClient && forceClose) {
    try {
      // A UI cancellation of a persisted run usually has no prepared client.
      // Rehydrate it here so produced rentals are settled as well as empty
      // rentals being cancelled.
      await ensureMail(context);
    } catch (error) {
      const openRentals = context.state.mailboxes.filter((mailbox) => (
        mailbox.rented === true && !mailbox.rentalClosed
      ));
      for (const mailbox of openRentals) {
        const jobs = registrationJobsForMailbox(mailbox, context);
        const action = jobs.some((job) => rentalShouldSettleForJob(job, context)) ? 'settle' : 'cancel';
        if (!rentalCleanupDue(mailbox, action, context)) continue;
        const cleanup = beginRentalCleanup(mailbox, action, context);
        markRentalCleanupPending(mailbox, cleanup, error, context);
      }
      if (openRentals.length) {
        event(context.state, 'mail_rental_close_deferred', {
          count: openRentals.length,
          message: error.message,
        }, context);
        await context.checkpoint('mail_rental_close_deferred');
      }
      return 0;
    }
  }
  if (typeof context.mailClient?.settleMailbox !== 'function'
    && typeof context.mailClient?.cancelMailbox !== 'function'
    && typeof context.mailClient?.releaseMailbox !== 'function') return 0;
  const onlyMailboxIds = Array.isArray(options.mailboxIds)
    ? new Set(options.mailboxIds.map((id) => String(id || '')).filter(Boolean))
    : null;
  const closable = [];
  for (const mailbox of context.state.mailboxes) {
    if (!mailbox.rented || mailbox.rentalClosed) continue;
    if (onlyMailboxIds && !onlyMailboxIds.has(String(mailbox.id))) continue;
    const jobs = registrationJobsForMailbox(mailbox, context);
    if (!forceClose && !jobs.length) continue;
    if (!forceClose) {
      // A job still running holds its mailbox — unless its account is already
      // registered, saved and secured. OAuth never reads the mailbox again, and
      // SMSBower refuses a settle once the activation has aged past its window:
      // run ui-20261003142635-fjkg9d waited for OAuth and lost four rentals to
      // "Bad actual activation status" 27–53 minutes after renting them.
      //
      // `partial` means the security work did not finish, so the account may
      // yet need another code. Those stay open for the operator to resume
      // during a normal run; an explicit task cancellation still closes them.
      const holding = jobs.some((job) => !registrationSecuredForSettlement(job, context) && (
        !TERMINAL_JOB_STATUSES.has(job.status) || job.status === 'partial'
      ));
      if (holding) continue;
    }

    // A callback/continuation can fail after `create_account` succeeded. The
    // job may be failed or skipped at that point, but the mailbox still has a
    // real account behind it and must be settled rather than cancelled.
    const produced = jobs.filter(confirmedRegistration).length;
    const settle = jobs.some((job) => rentalShouldSettleForJob(job, context));
    closable.push({ mailbox, produced, settle });
  }
  if (!closable.length) return 0;
  const results = await Promise.all(closable.map(({ mailbox, produced, settle }) => (
    closeRentedMailbox(mailbox, settle ? 'settle' : 'cancel', produced, context)
  )));
  return results.filter((result) => result === 'closed' || result === 'unknown').length;
}

/**
 * A registration whose mailbox has nothing left to give.
 *
 * Created, saved as a login state, and carrying every security feature the run
 * needs — the same bar that lets OAuth start. From here the account signs in
 * with its password and TOTP; no step reads the mailbox, so holding the rental
 * open only runs it towards the provider's expiry.
 */
function registrationSecuredForSettlement(job, context) {
  if (!job?.sessionAssetId || !confirmedRegistration(job)) return false;
  const required = context.plan?.postRegistrationOAuth === true
    ? OAUTH_REQUIRED_SECURITY
    : (context.plan?.security || {});
  const state = job.sessionState || {};
  return missingSecurityFeatures(state, required).length === 0 && !securityStateHasPendingWork(state);
}

/**
 * Whether a failed close request may have reached the provider anyway.
 *
 * A timed-out `setStatus` is not a refused one: SMSBower often applies the
 * change and the answer is what gets lost.
 */
function rentalCloseOutcomeUnknown(error) {
  if (!error || error.providerStateRejected === true) return false;
  const code = String(error.code || '').toUpperCase();
  if (/TIMEOUT|TIMED_OUT|ECONNRESET|ETIMEDOUT|ECONNABORTED|EPIPE|SOCKET|NETWORK/.test(code)) return true;
  return /timed out|socket hang up|ECONNRESET|network/i.test(String(error.message || ''));
}

function rentalCleanupRecord(mailbox) {
  const current = mailbox.rentalCleanup && typeof mailbox.rentalCleanup === 'object'
    ? mailbox.rentalCleanup
    : {};
  return {
    action: String(current.action || ''),
    status: String(current.status || ''),
    attempts: Number.isFinite(Number(current.attempts)) ? Math.max(0, Number(current.attempts)) : 0,
    lastAttemptAt: String(current.lastAttemptAt || ''),
    nextAttemptAt: String(current.nextAttemptAt || ''),
    closedAt: String(current.closedAt || ''),
    outcome: String(current.outcome || ''),
    lastError: current.lastError || null,
    providerMissing: current.providerMissing === true,
    // An earlier settle request whose answer was lost: the next refusal may
    // mean it already landed.
    outcomeUncertain: current.outcomeUncertain === true,
  };
}

function rentalCleanupDue(mailbox, action, context) {
  const cleanup = rentalCleanupRecord(mailbox);
  if (!cleanup.status) return true;
  // A previously failed settle must not be replaced by a cancel from a second
  // cleanup pass in the same scheduler turn. An action change is legitimate
  // only when the job's durable output changed, so allow that transition.
  if (cleanup.action !== action) return true;
  if (cleanup.status !== 'pending') return false;
  const next = Date.parse(cleanup.nextAttemptAt);
  return !Number.isFinite(next) || next <= nowMs(context);
}

function beginRentalCleanup(mailbox, action, context) {
  const previous = rentalCleanupRecord(mailbox);
  const attempts = previous.action === action && previous.status === 'pending'
    ? previous.attempts
    : 0;
  const cleanup = {
    ...previous,
    action,
    status: 'pending',
    attempts: attempts + 1,
    lastAttemptAt: nowIso(context),
    nextAttemptAt: '',
    lastError: null,
  };
  mailbox.rentalCleanup = cleanup;
  return cleanup;
}

function rentalCleanupRetryDelay(error, attempt) {
  const retryAfterMs = Number(error?.retryAfterMs);
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) return retryAfterMs;
  return RENTAL_CLEANUP_RETRY_DELAYS_MS[
    Math.min(Math.max(0, Number(attempt || 1) - 1), RENTAL_CLEANUP_RETRY_DELAYS_MS.length - 1)
  ];
}

function markRentalCleanupPending(mailbox, cleanup, error, context) {
  const nextAttemptAt = new Date(nowMs(context) + rentalCleanupRetryDelay(error, cleanup.attempts)).toISOString();
  cleanup.nextAttemptAt = nextAttemptAt;
  cleanup.lastError = {
    code: String(error?.code || 'MAIL_RENTAL_CLOSE_FAILED'),
    message: String(error?.message || error || 'Mailbox rental cleanup failed'),
  };
  if (cleanup.action === 'settle' && rentalCloseOutcomeUnknown(error)) cleanup.outcomeUncertain = true;
  mailbox.rentalCleanup = cleanup;
  mailbox.rentalError = cleanup.lastError;
  return nextAttemptAt;
}

function markRentalCleanupClosed(mailbox, action, produced, context, details = {}) {
  const previous = rentalCleanupRecord(mailbox);
  const outcome = action === 'settle' ? 'settled' : 'cancelled';
  const closedAt = nowIso(context);
  mailbox.rentalClosed = outcome;
  mailbox.rentalCleanup = {
    ...previous,
    action,
    status: 'closed',
    outcome,
    attempts: Math.max(1, previous.attempts),
    nextAttemptAt: '',
    closedAt,
    providerMissing: details.providerMissing === true,
    outcomeUncertain: false,
    lastError: null,
  };
  mailbox.rentalError = '';
  delete mailbox.rentalBillingUncertain;
  delete mailbox.rentalUnresolvedUsd;
  // Settling is the moment the provider bills; a cancelled rental is free.
  mailbox.costUsd = action === 'settle' ? Number(mailbox.quotedPriceUsd || 0) : 0;
  if (details.providerMissing === true) mailbox.rentalCloseReason = 'provider_missing';
  else if (details.settleInferred === true) mailbox.rentalCloseReason = 'settle_landed_before_timeout';
  else delete mailbox.rentalCloseReason;
  return {
    outcome,
    accounts: produced,
    costUsd: Number(mailbox.costUsd || 0),
    providerMissing: details.providerMissing === true,
    message: outcome === 'settled'
      ? (details.settleInferred === true
        ? `Mailbox settled after ${produced} finished account(s); the earlier timed-out settle request had already been applied`
        : `Mailbox settled after ${produced} finished account(s)`)
      : (details.providerMissing === true
        ? 'Mailbox was already absent at the provider; cancellation is idempotently complete'
        : 'Mailbox produced nothing and was cancelled'),
  };
}

function markRentalSettlementUnknown(mailbox, action, produced, error, context) {
  const previous = rentalCleanupRecord(mailbox);
  const unresolvedUsd = Number(mailbox.quotedPriceUsd || 0);
  const at = nowIso(context);
  mailbox.rentalClosed = 'settlement_unknown';
  mailbox.rentalBillingUncertain = true;
  mailbox.rentalUnresolvedUsd = unresolvedUsd;
  mailbox.rentalCleanup = {
    ...previous,
    action,
    status: 'unknown',
    outcome: 'settlement_unknown',
    nextAttemptAt: '',
    closedAt: at,
    providerMissing: true,
    lastError: { code: String(error?.code || 'MAILBOX_GONE'), message: String(error?.message || error) },
  };
  mailbox.rentalError = mailbox.rentalCleanup.lastError;
  return {
    outcome: mailbox.rentalClosed,
    accounts: produced,
    costUsd: 0,
    providerMissing: true,
    unresolvedUsd,
    message: 'Mailbox disappeared before settlement was confirmed; billing remains unresolved',
  };
}

function markRentalCleanupManualReview(mailbox, action, produced, error, context) {
  const previous = rentalCleanupRecord(mailbox);
  const at = nowIso(context);
  const unresolvedUsd = action === 'settle' ? Number(mailbox.quotedPriceUsd || 0) : 0;
  mailbox.rentalClosed = 'cleanup_manual_review';
  mailbox.rentalBillingUncertain = action === 'settle';
  mailbox.rentalUnresolvedUsd = unresolvedUsd;
  mailbox.rentalCleanup = {
    ...previous,
    action,
    status: 'manual_review',
    outcome: mailbox.rentalClosed,
    nextAttemptAt: '',
    closedAt: at,
    lastError: { code: String(error?.code || 'MAIL_RENTAL_CLOSE_FAILED'), message: String(error?.message || error) },
  };
  mailbox.rentalError = mailbox.rentalCleanup.lastError;
  return {
    outcome: mailbox.rentalClosed,
    accounts: produced,
    costUsd: 0,
    unresolvedUsd,
    message: 'Mailbox rental cleanup requires manual review',
  };
}

async function closeRentedMailbox(mailbox, action, produced, context) {
  // A Worker settles its own mailbox the moment the account is secured, while
  // the scheduler may reach the same mailbox in its next pass. Two settle
  // requests for one activation is how the second one comes back refused.
  context.rentalCloseInFlight = context.rentalCloseInFlight || new Set();
  const key = String(mailbox.id);
  if (context.rentalCloseInFlight.has(key)) return 'pending';
  context.rentalCloseInFlight.add(key);
  try {
    return await closeRentedMailboxOnce(mailbox, action, produced, context);
  } finally {
    context.rentalCloseInFlight.delete(key);
  }
}

async function closeRentedMailboxOnce(mailbox, action, produced, context) {
  if (!rentalCleanupDue(mailbox, action, context)) {
    return rentalCleanupRecord(mailbox).status === 'pending' ? 'pending' : 'closed';
  }

  const method = action === 'settle'
    ? context.mailClient?.settleMailbox
    : (context.mailClient?.cancelMailbox || context.mailClient?.releaseMailbox);
  if (typeof method !== 'function') {
    const error = Object.assign(new Error(`Mail client cannot ${action} mailbox rentals`), {
      code: 'MAIL_RENTAL_CLOSE_UNSUPPORTED',
      retryable: false,
    });
    beginRentalCleanup(mailbox, action, context);
    markRentalCleanupManualReview(mailbox, action, produced, error, context);
    event(context.state, 'mail_rental_cleanup_manual_review', {
      mailboxId: mailbox.id,
      action,
      code: error.code,
      message: mailbox.rentalError.message,
    }, context);
    await context.checkpoint('mail_rental_cleanup_manual_review');
    return 'unknown';
  }

  const cleanup = beginRentalCleanup(mailbox, action, context);
  try {
    await method.call(context.mailClient, mailbox.id);
    const detail = markRentalCleanupClosed(mailbox, action, produced, context);
    event(context.state, 'mail_rental_closed', {
      mailboxId: mailbox.id,
      outcome: detail.outcome,
      accounts: detail.accounts,
      costUsd: detail.costUsd,
      message: detail.message,
    }, context);
    await context.checkpoint('mail_rental_closed');
    return 'closed';
  } catch (error) {
    if (action === 'cancel' && mailboxAlreadyGone(error)) {
      const detail = markRentalCleanupClosed(mailbox, action, produced, context, { providerMissing: true });
      event(context.state, 'mail_rental_closed', {
        mailboxId: mailbox.id,
        outcome: detail.outcome,
        accounts: detail.accounts,
        costUsd: detail.costUsd,
        providerMissing: true,
        message: detail.message,
      }, context);
      await context.checkpoint('mail_rental_closed');
      return 'closed';
    }
    if (action === 'settle' && mailboxAlreadyGone(error)) {
      const detail = markRentalSettlementUnknown(mailbox, action, produced, error, context);
      event(context.state, 'mail_rental_settlement_unknown', {
        mailboxId: mailbox.id,
        accounts: detail.accounts,
        quotedPriceUsd: Number(mailbox.quotedPriceUsd || 0),
        unresolvedUsd: detail.unresolvedUsd,
        message: detail.message,
      }, context);
      await context.checkpoint('mail_rental_settlement_unknown');
      return 'unknown';
    }
    if (action === 'settle' && error?.providerStateRejected === true && cleanup.outcomeUncertain === true) {
      // The previous settle timed out, and the provider now refuses to settle
      // a second time. It cannot be both unsettled and unable to settle: the
      // first request landed. Observed on nine rentals in one run, each one
      // otherwise left in manual review with its account already delivered.
      const detail = markRentalCleanupClosed(mailbox, action, produced, context, { settleInferred: true });
      event(context.state, 'mail_rental_closed', {
        mailboxId: mailbox.id,
        outcome: detail.outcome,
        accounts: detail.accounts,
        costUsd: detail.costUsd,
        settleInferred: true,
        message: detail.message,
      }, context);
      await context.checkpoint('mail_rental_closed');
      return 'closed';
    }
    if (mailboxCleanupRequiresManualReview(error)) {
      const detail = markRentalCleanupManualReview(mailbox, action, produced, error, context);
      event(context.state, 'mail_rental_cleanup_manual_review', {
        mailboxId: mailbox.id,
        action,
        code: error.code || 'MAIL_RENTAL_CLOSE_FAILED',
        message: detail.message,
      }, context);
      await context.checkpoint('mail_rental_cleanup_manual_review');
      return 'unknown';
    }
    const nextAttemptAt = markRentalCleanupPending(mailbox, cleanup, error, context);
    event(context.state, 'mail_rental_close_failed', {
      mailboxId: mailbox.id,
      action,
      attempt: cleanup.attempts,
      nextAttemptAt,
      code: error.code || 'MAIL_RENTAL_CLOSE_FAILED',
      message: error.message,
    }, context);
    await context.checkpoint('mail_rental_close_deferred');
    return 'pending';
  }
}

function pendingRentalCleanupCount(context) {
  return context.state.mailboxes.filter((mailbox) => (
    mailbox.rented === true
    && !mailbox.rentalClosed
    && rentalCleanupRecord(mailbox).status === 'pending'
  )).length;
}

async function replenishRegistrationAliases(context) {
  if (!REGISTRATION_TASK_KINDS.has(context.state.taskKind)
    || context.plan.aliasStrategy === 'root'
    || remoteSingleAddressJobs(context)) return 0;
  let added = 0;
  for (const mailbox of context.state.mailboxes) {
    const jobs = registrationJobsForMailbox(mailbox, context);
    const confirmed = jobs.filter(confirmedRegistration).length;
    const viable = jobs.filter((job) => !TERMINAL_JOB_STATUSES.has(job.status)).length;
    mailbox.attemptCount = jobs.length;
    mailbox.createdCount = confirmed;
    mailbox.cpaCompletedCount = jobs.filter((job) => job.cpaPath && !job.cpaSuperseded).length;
    mailbox.nextAliasIndex = Math.max(
      Number(mailbox.nextAliasIndex || 1),
      ...jobs.map((job) => Number(job.aliasIndex || 0) + 1),
      1,
    );
    let needed = Math.max(0, Number(mailbox.targetCount || 1) - confirmed - viable);
    while (needed > 0 && mailbox.attemptCount < Number(mailbox.maxAttempts || mailbox.targetCount || 1)) {
      const failed = [...jobs].reverse().find((job) => (
        job.status === 'failed' && !job.replacementJobId && !confirmedRegistration(job)
      ));
      if (!failed) break;
      const [alias] = deriveRegistrationEmails(mailbox.rootEmail, 1, {
        strategy: 'plus',
        runTag: context.plan.aliasRunTag,
        startIndex: mailbox.nextAliasIndex,
        // Current jobs plus everything already registered: a replacement must
        // not land on an address a previous run already spent.
        excludeEmails: [...jobs.map((job) => job.email), ...registeredEmails(context)],
        randomInt: context.aliasRandomInt,
      });
      const replacement = jobBase({
        email: alias.email,
        parentEmail: mailbox.rootEmail,
        mailboxId: mailbox.id,
        aliasIndex: alias.index,
      }, context.state);
      replacement.replacementOf = failed.id;
      failed.replacementJobId = replacement.id;
      context.state.jobs.push(replacement);
      jobs.push(replacement);
      mailbox.attemptCount += 1;
      mailbox.nextAliasIndex = alias.index + 1;
      needed -= 1;
      added += 1;
      event(context.state, 'alias_replacement_added', {
        mailboxId: mailbox.id,
        failedJobId: failed.id,
        replacementJobId: replacement.id,
        aliasIndex: alias.index,
      }, context);
    }
  }
  if (added) await context.checkpoint('alias_replacements_added');
  return added;
}

/**
 * Whether an exit may be bound by several Workers at once.
 *
 * The one-Worker-per-endpoint rule exists so two registrations are never seen
 * from the same residential IP. The maintenance forwarder is a single process
 * on the host — every Worker leaves from the host address whether they share
 * the entry or not — so reserving it would just strand every Worker but one.
 */
function isMaintenanceProxyEntry(entry = {}) {
  return String(entry?.resourceKind || '').toLowerCase() === 'maintenance'
    || String(entry?.kind || '').toLowerCase() === 'maintenance';
}

function isLegacyMaintenanceProxyUrl(url) {
  return /^https?:\/\/(?:127\.0\.0\.1|localhost):7890(?:\/|$)/i.test(String(url || '').trim());
}

function isMaintenanceProxyId(id) {
  return /^maintenance(?:[-_]|$)/i.test(String(id || '').trim());
}

function isMaintenanceProxyDescriptor(entry = {}) {
  if (entry?.resourceKind && entry.resourceKind !== 'maintenance') return false;
  return isMaintenanceProxyEntry(entry)
    || isLegacyMaintenanceProxyUrl(entry?.url || entry?.endpoint)
    || isMaintenanceProxyId(entry?.id);
}

function sharedProxyEntry(entry, context) {
  if (entry?.resourceKind && entry.resourceKind !== 'maintenance') return false;
  if (isMaintenanceProxyEntry(entry)) return true;
  // Older OAuth checkpoints persisted the URL but not resourceKind. Recover
  // those snapshots from the run's configured forwarder so a resume does not
  // probe 7890 as if it were a replaceable residential exit.
  const configured = String(context?.config?.proxyPool?.maintenanceProxy || '').trim();
  return Boolean(configured && String(entry?.url || '').trim() === configured);
}

function maintenanceProxyIdsForState(state = {}) {
  const ids = new Set();
  const snapshotEntries = Array.isArray(state.proxyResourceSnapshot?.entries)
    ? state.proxyResourceSnapshot.entries
    : [];
  for (const entry of snapshotEntries) {
    if (isMaintenanceProxyDescriptor(entry) && entry.id) ids.add(String(entry.id));
  }

  const plan = state.runPlan || state.plan || {};
  const assignments = Array.isArray(plan.proxyAssignments) ? plan.proxyAssignments : [];
  const assignmentForWorker = (worker) => assignments.find((assignment) => (
    Number(assignment?.workerSlot) === Number(worker?.slot)
  ));
  const assignmentForJob = (job) => {
    const workerId = String(job?.workerAffinity?.workerId || '');
    const worker = (state.workers || []).find((candidate) => String(candidate?.id || '') === workerId);
    return worker ? assignmentForWorker(worker) : null;
  };

  for (const worker of state.workers || []) {
    const proxyId = String(worker?.proxyId || '').trim();
    if (proxyId && assignmentForWorker(worker)?.kind === 'maintenance') ids.add(proxyId);
    if (proxyId && isMaintenanceProxyDescriptor({ ...worker.proxy, id: proxyId })) ids.add(proxyId);
  }
  for (const job of state.jobs || []) {
    const proxyId = String(job?.proxyId || '').trim();
    if (proxyId && assignmentForJob(job)?.kind === 'maintenance') ids.add(proxyId);
    if (proxyId && isMaintenanceProxyDescriptor({ ...job.proxy, id: proxyId })) ids.add(proxyId);
  }

  // The generated maintenance entry has this prefix even when an older
  // checkpoint retained only the health map and lost the assignment metadata.
  for (const id of Object.keys(state.proxyHealth || {})) {
    if (isMaintenanceProxyId(id)) ids.add(String(id));
  }
  return ids;
}

function maintenanceProxyForState(state = {}, proxyId = '', proxy = null) {
  if (isMaintenanceProxyEntry(proxy)) return true;
  const id = String(proxyId || proxy?.id || '').trim();
  if (id && maintenanceProxyIdsForState(state).has(id)) return true;
  const url = String(proxy?.url || '').trim().toLowerCase();
  // Keep the built-in legacy endpoint recognizable even when an old snapshot
  // has lost both its resource kind and its proxy assignment metadata.
  return isLegacyMaintenanceProxyUrl(url);
}

function boundMaintenanceProxy(job, worker, context) {
  return sharedProxyEntry(worker?.proxy, context) || sharedProxyEntry(job?.proxy, context);
}

function candidatesForWorker(worker, context) {
  return (context.proxyEntries || []).filter((entry) => (
    Array.isArray(entry.workerSlots) ? entry.workerSlots.includes(worker.slot) : true
  ));
}

function shuffleProxyEntries(entries, context) {
  const random = typeof context?.random === 'function' ? context.random : Math.random;
  const shuffled = [...entries];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const sample = Number(random());
    const normalized = Number.isFinite(sample)
      ? Math.max(0, Math.min(sample, 0.999999999999))
      : 0;
    const target = Math.floor(normalized * (index + 1));
    [shuffled[index], shuffled[target]] = [shuffled[target], shuffled[index]];
  }
  return shuffled;
}

function proxyRetiredForRun(health, entry = null, context = null) {
  if (entry && sharedProxyEntry(entry, context)) return false;
  return String(health?.status || '') === 'failed';
}

/**
 * Collapse proxy records written by the removed global screener into the one
 * status understood by the current Worker path. This runs at the persistence
 * boundary so the live selector never needs to carry the old state machine.
 */
function normalizePersistedProxyState(state) {
  state.events = Array.isArray(state.events) ? state.events : [];
  for (const record of state.events) {
    if (record?.type === 'worker_proxy_recheck_scheduled') {
      record.type = 'worker_proxy_rejected';
      record.reason = record.reason || 'legacy_proxy_recheck';
    }
  }
  state.proxyHealth = state.proxyHealth && typeof state.proxyHealth === 'object'
    ? state.proxyHealth
    : {};
  const maintenanceIds = maintenanceProxyIdsForState(state);
  for (const [proxyId, value] of Object.entries(state.proxyHealth)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const record = { ...value };
    const legacyReason = String(record.recheckReason || '').trim();
    const retired = ['burned', 'recheck_required'].includes(String(record.status || ''));
    if (retired) {
      record.status = 'failed';
      record.lastFailureAt = record.lastFailureAt || record.burnedAt || record.recheckAt || '';
      record.reason = legacyReason || record.reason || 'proxy_unusable';
      record.lastFailureCode = record.lastFailureCode || record.code || 'PROXY_LEGACY_RETIRED';
    }
    if (record.accountSelectionFailures === undefined && record.accountSelectionRechecks !== undefined) {
      record.accountSelectionFailures = record.accountSelectionRechecks;
    }
    if (record.transportFailureCount === undefined && record.recheckCount !== undefined) {
      record.transportFailureCount = record.recheckCount;
    }
    if (!['failed', 'healthy'].includes(String(record.status || ''))) {
      record.status = 'healthy';
    }
    if (maintenanceIds.has(String(proxyId))) {
      // A local forwarder is shared infrastructure, not a replaceable exit.
      // Older runs recorded its Cloudflare/transport errors as a retired proxy;
      // clear that disposition at the persistence boundary so resume can use
      // the endpoint again.
      record.status = 'healthy';
      record.reason = '';
      record.maintenanceLastFailureAt = record.lastFailureAt || '';
      record.maintenanceLastFailureCode = record.lastFailureCode || '';
    }
    delete record.accountSelectionRechecks;
    delete record.burnedAt;
    delete record.recheckAt;
    delete record.recheckCount;
    delete record.recheckReason;
    delete record.code;
    state.proxyHealth[proxyId] = record;
  }
  return state;
}

function proxyCapacityMayReturn(context) {
  return context.usedProxyIds.size > 0;
}

function replaceProxyEntriesInContext(context, entries) {
  if (!Array.isArray(entries)) return false;
  if (!Array.isArray(context.proxyEntries)) context.proxyEntries = [];
  const previousIds = new Set(context.proxyEntries.map((entry) => String(entry?.id || '')));
  const leasedIds = new Set(Object.values(context.state.proxyLeases || {}).map((id) => String(id || '')));
  for (const entry of entries) {
    const id = String(entry?.id || '');
    if (!id || previousIds.has(id) || leasedIds.has(id)) continue;
    if (context.state.proxyHealth?.[id]?.status === 'failed') delete context.state.proxyHealth[id];
  }
  context.proxyEntries.splice(0, context.proxyEntries.length, ...entries);
  return true;
}

/**
 * Whether this Worker can rotate to a different candidate already present in
 * the run snapshot. The local maintenance forwarder is shareable; residential
 * exits remain one-Worker-at-a-time.
 */
function hasInRunProxyRotationCapacity(worker, context) {
  const candidates = candidatesForWorker(worker, context);
  const currentProxyId = String(worker?.proxyId || '');
  return candidates.some((entry) => (
    String(entry?.id || '') !== currentProxyId
    && (sharedProxyEntry(entry, context) || !context.usedProxyIds.has(entry.id))
    && !proxyRetiredForRun(context.state.proxyHealth?.[entry.id], entry, context)
  ));
}

async function retireFailedCountryPoolProxy(candidate, error, context, details = {}) {
  if (candidate?.resourceKind !== 'countryPool' || !candidate?.countryCode) return false;
  let retired = false;
  if (typeof context.retireCountryPoolProxy === 'function') {
    try {
      const result = await context.retireCountryPoolProxy({
        proxy: candidate,
        reason: error?.message || 'proxy_probe_failed',
        ...details,
      });
      retired = result?.retired !== false;
    } catch (retireError) {
      event(context.state, 'worker_proxy_country_pool_retire_failed', {
        workerId: details.workerId || '',
        proxyId: candidate.id,
        countryCode: candidate.countryCode,
        code: String(retireError?.code || 'PROXY_POOL_RETIRE_FAILED'),
        message: String(retireError?.message || retireError),
      }, context);
    }
  }
  // Drop it from this run even if catalog persistence is temporarily unavailable.
  if (Array.isArray(context.proxyEntries)) {
    for (let index = context.proxyEntries.length - 1; index >= 0; index -= 1) {
      const entry = context.proxyEntries[index];
      if (entry?.id === candidate.id || entry?.url === candidate.url) context.proxyEntries.splice(index, 1);
    }
  }
  if (retired) {
    event(context.state, 'worker_proxy_country_pool_retired', {
      workerId: details.workerId || '',
      proxyId: candidate.id,
      countryCode: candidate.countryCode,
      reason: error?.message || 'proxy_probe_failed',
    }, context);
  }
  return retired;
}

async function refreshProxyEntriesForJob(job, worker, context) {
  if (hasInRunProxyRotationCapacity(worker, context)) return true;
  if (typeof context.refreshProxyResources !== 'function') return false;
  try {
    const result = await context.refreshProxyResources({
      jobId: job.id,
      workerId: worker?.id || '',
      proxyId: worker?.proxyId || job.proxyId || '',
      reason: 'job_proxy_transport_failure',
    });
    const snapshot = result?.snapshot && typeof result.snapshot === 'object'
      ? result.snapshot
      : (Array.isArray(result?.entries) ? result : null);
    if (Array.isArray(snapshot?.entries)) {
      replaceProxyEntriesInContext(context, snapshot.entries);
      context.state.proxyResourceSnapshot = snapshot;
      await context.checkpoint('proxy_resources_refreshed_for_job');
    }
    const available = hasInRunProxyRotationCapacity(worker, context);
    event(context.state, 'job_proxy_resources_refreshed', {
      jobId: job.id,
      workerId: worker?.id || '',
      available,
      entryCount: Array.isArray(context.proxyEntries) ? context.proxyEntries.length : 0,
      message: available
        ? 'The job refreshed the proxy catalog and found a replacement exit'
        : 'The job refreshed the proxy catalog but no replacement exit is available',
    }, context);
    return available;
  } catch (error) {
    event(context.state, 'job_proxy_resources_refresh_failed', {
      jobId: job.id,
      workerId: worker?.id || '',
      code: String(error?.code || 'PROXY_REFRESH_FAILED'),
      message: String(error?.message || error),
    }, context);
    return false;
  }
}

async function refreshProxyEntriesForWaitingWorker(job, worker, context) {
  if (typeof context.refreshProxyResources !== 'function') return false;
  try {
    let result;
    if (context.proxyPoolRefreshFlight) {
      result = await context.proxyPoolRefreshFlight;
    } else {
      const now = Date.now();
      if (Number(context.proxyPoolRefreshAt || 0) > 0
        && now - Number(context.proxyPoolRefreshAt) < PROXY_POOL_REFRESH_COOLDOWN_MS) {
        return hasInRunProxyRotationCapacity(worker, context);
      }
      context.proxyPoolRefreshAt = now;
      const flight = Promise.resolve().then(() => context.refreshProxyResources({
        jobId: job.id,
        workerId: worker?.id || '',
        workerSlots: Number.isFinite(Number(worker?.slot)) ? [Number(worker.slot)] : [],
        reason: 'proxy_pool_exhausted',
      }));
      context.proxyPoolRefreshFlight = flight;
      try {
        result = await flight;
      } finally {
        if (context.proxyPoolRefreshFlight === flight) context.proxyPoolRefreshFlight = null;
      }
    }
    const snapshot = result?.snapshot && typeof result.snapshot === 'object'
      ? result.snapshot
      : (Array.isArray(result?.entries) ? result : null);
    if (Array.isArray(snapshot?.entries)) {
      replaceProxyEntriesInContext(context, snapshot.entries);
      context.state.proxyResourceSnapshot = snapshot;
      await context.checkpoint('proxy_resources_refreshed_for_waiting_workers');
    }
    const available = hasInRunProxyRotationCapacity(worker, context);
    const countryCodes = [...new Set(candidatesForWorker(worker, context)
      .map((entry) => String(entry?.countryCode || '').trim().toUpperCase())
      .filter((countryCode) => countryCode && countryCode !== 'GLOBAL'))];
    event(context.state, 'proxy_resources_refreshed_for_waiting_workers', {
      jobId: job.id,
      workerId: worker?.id || '',
      countryCodes,
      available,
      entryCount: Array.isArray(context.proxyEntries) ? context.proxyEntries.length : 0,
      message: available
        ? 'The waiting Worker refreshed its proxy catalog and found an available exit'
        : 'The waiting Worker refreshed its proxy catalog but still has no available exit',
    }, context);
    return available;
  } catch (error) {
    event(context.state, 'proxy_resources_refresh_for_waiting_workers_failed', {
      jobId: job.id,
      workerId: worker?.id || '',
      code: String(error?.code || 'PROXY_REFRESH_FAILED'),
      message: String(error?.message || error),
    }, context);
    return false;
  }
}

/**
 * Move one failed job to a fresh exit.
 *
 * A job with a live SMS lease cannot simply change IP: it is rebuilt through
 * the existing cleanup path first. A saved session asset is already durable,
 * so follow-up work can just rebind. Other task shapes stay on the guarded
 * robot fallback rather than risking a state transition the runner cannot
 * safely replay.
 */
async function rotateJobProxyForRecovery(job, worker, context) {
  // A created account has a portable callback checkpoint. Keep the current
  // exit for its two callback retries; this function is the generic one-shot
  // transport fallback and would rotate too early.
  if (createdAccountCallbackPending(job)) return false;
  if (!await refreshProxyEntriesForJob(job, worker, context)) return false;

  const hadDurableState = registrationInFlight(job);
  if (!hadDurableState) {
    // Even step=initial can hold a Sentinel identity from a failed first hop.
    // Clear that transaction before binding a different proxy; dropping only
    // the lease leaves every later request failing the continuity guard.
    restartEarlySessionForProxy(job, context);
    unbindWorkerProxy(worker, job, context, {
      code: 'PROXY_LOCAL_RECOVERY',
      reason: 'job_local_proxy_recovery',
    });
    return true;
  }

  if (canRebindProxyForFollowUpWork(job)) {
    unbindWorkerProxy(worker, job, context, {
      code: 'PROXY_LOCAL_RECOVERY',
      reason: 'job_local_follow_up_recovery',
    });
    return true;
  }

  if (!REGISTRATION_TASK_KINDS.has(context.state.taskKind)
    || Number(job.freshExitRestarts || 0) >= MAX_FRESH_EXIT_RESTARTS) return false;
  return restartRegistrationOnFreshExit(job, worker, context);
}

/**
 * Selects and verifies one exit for a Worker. The candidate is reserved before
 * the asynchronous probe, so concurrent Workers cannot claim the same
 * residential endpoint. A failed candidate is retired immediately and the
 * next candidate is tried in the same bind operation.
 */
async function bindWorkerProxy(worker, context) {
  if (worker.proxy?.url) {
    const health = context.state.proxyHealth[worker.proxyId] || {};
    if (proxyRetiredForRun(health, worker.proxy, context)) {
      context.usedProxyIds.delete(worker.proxyId);
      delete context.state.proxyLeases[worker.id];
      worker.proxy = null;
      worker.proxyId = '';
    } else {
      return worker.proxy;
    }
  }
  const allUsable = candidatesForWorker(worker, context)
    .filter((entry) => !proxyRetiredForRun(context.state.proxyHealth[entry.id], entry, context));
  const usable = shuffleProxyEntries(
    allUsable.filter((entry) => sharedProxyEntry(entry, context) || !context.usedProxyIds.has(entry.id)),
    context,
  );
  // The exit just spent (or just dropped) is skipped while anything else is
  // available, but is not removed outright — a one-proxy pool must still work.
  const lastProxyId = String(worker.lastProxyId || '');
  const rotated = lastProxyId ? usable.filter((entry) => entry.id !== lastProxyId) : usable;
  const pool = rotated.length ? rotated : usable;
  // Exits no Worker has used in this run go first, so a released exit is not
  // handed straight to the next account while unused ones are still on hand.
  // Earlier-used exits remain as the fallback when the fresh ones run out.
  const everBound = (entry) => !sharedProxyEntry(entry, context)
    && Boolean(context.state.proxyHealth?.[entry.id]?.lastSuccessAt);
  const candidates = [
    ...pool.filter((entry) => !everBound(entry)),
    ...pool.filter((entry) => everBound(entry)),
  ];
  if (!candidates.length && context.config.proxyPool.required) {
    const busy = allUsable.length > 0;
    throw Object.assign(new Error(
      busy
        ? `All proxy candidates are currently in use for Worker ${worker.slot}`
        : `No proxy candidate for Worker ${worker.slot}`,
    ), { code: busy ? 'PROXY_POOL_BUSY' : 'PROXY_POOL_EXHAUSTED' });
  }
  for (const [index, candidate] of candidates.entries()) {
    // `candidates` was filtered synchronously before the first await, so from
    // the second iteration onwards it is a stale snapshot: another Worker may
    // have claimed or failed this exit while this one was probing. Re-checking
    // here is what keeps two Workers off the same residential IP once probes
    // start failing — which is routine at 20 Workers and rare at 8.
    if (!sharedProxyEntry(candidate, context)) {
      if (context.usedProxyIds.has(candidate.id)) continue;
      if (proxyRetiredForRun(context.state.proxyHealth[candidate.id], candidate, context)) continue;
      context.usedProxyIds.add(candidate.id);
    }
    const sharedMaintenance = sharedProxyEntry(candidate, context);
    let probeCompleted = !context.config.proxyPool.healthCheck.enabled || sharedMaintenance;
    event(context.state, sharedMaintenance ? 'worker_proxy_health_check_skipped' : 'worker_proxy_health_check_started', {
      workerId: worker.id,
      proxyId: candidate.id,
      candidateIndex: index + 1,
      candidateCount: candidates.length,
      ...(sharedMaintenance ? { reason: 'shared_maintenance_forwarder' } : {}),
    }, context);
    await context.checkpoint(sharedMaintenance
      ? 'worker_proxy_health_check_skipped'
      : 'worker_proxy_health_check_started');
    try {
      if (context.config.proxyPool.healthCheck.enabled && !sharedMaintenance) {
        await probeProxy(candidate, {
          probeUrl: context.config.proxyPool.healthCheck.probeUrl,
          timeoutMs: context.config.proxyPool.healthCheck.timeoutMs,
          signal: context.signal(),
          executor: context.proxyProbeExecutor || executePureHttpUrl,
          // The probe only answers whether the exit is reachable. It used to
          // reject a Cloudflare 403 as well, with a `gpt-re-proxy-health/0.1`
          // user agent and none of the header block real traffic sends — so it
          // was measuring whether Cloudflare lets an obvious bot through, which
          // it almost never does. It was also uninformative in the other
          // direction: of 73 exits it passed in one JP run, 68 were challenged
          // anyway once real traffic started. The first real request is the
          // honest probe, it costs about the same (2756ms against 2593ms), and a
          // challenge there lands before `registrationInFlight` — so the exit is
          // unbound, banned and retried with no mailbox spent.
        });
      }
      probeCompleted = true;
      const reusedExit = everBound(candidate);
      worker.proxy = clone(candidate);
      worker.proxyId = candidate.id;
      context.state.proxyLeases[worker.id] = candidate.id;
      context.state.proxyHealth[candidate.id] = {
        ...(context.state.proxyHealth[candidate.id] || {}),
        status: 'healthy',
        lastSuccessAt: nowIso(context),
        reason: '',
      };
      event(context.state, 'worker_proxy_bound', {
        workerId: worker.id,
        proxyId: candidate.id,
        ...(sharedMaintenance ? { shared: true } : {}),
        ...(reusedExit ? { reusedExit: true } : {}),
      }, context);
      await context.checkpoint('worker_proxy_bound');
      return worker.proxy;
    } catch (error) {
      // The claim only holds for a candidate that worked out.
      context.usedProxyIds.delete(candidate.id);
      const maintenance = sharedProxyEntry(candidate, context);
      if (maintenance) {
        const at = nowIso(context);
        const previous = context.state.proxyHealth[candidate.id] || {};
        context.state.proxyHealth[candidate.id] = {
          ...previous,
          status: 'healthy',
          reason: '',
          maintenanceLastFailureAt: at,
          maintenanceLastFailureCode: String(error?.code || 'MAINTENANCE_PROXY_BIND_FAILED'),
        };
        event(context.state, 'worker_proxy_maintenance_bind_failed', {
          workerId: worker.id,
          proxyId: candidate.id,
          candidateIndex: index + 1,
          candidateCount: candidates.length,
          code: String(error?.code || 'MAINTENANCE_PROXY_BIND_FAILED'),
          message: error.message,
          retryable: true,
        }, context);
        await context.checkpoint('worker_proxy_maintenance_bind_failed');
      } else {
        context.state.proxyHealth[candidate.id] = {
          ...(context.state.proxyHealth[candidate.id] || {}),
          status: 'failed',
          lastFailureAt: nowIso(context),
          reason: error.message,
        };
        const retired = !probeCompleted && !context.action?.() && error?.code !== 'CONTROL_REQUESTED'
          ? await retireFailedCountryPoolProxy(candidate, error, context, { workerId: worker.id })
          : false;
        event(context.state, 'worker_proxy_rejected', {
          workerId: worker.id,
          proxyId: candidate.id,
          candidateIndex: index + 1,
          candidateCount: candidates.length,
          message: error.message,
          retired,
        }, context);
        await context.checkpoint('worker_proxy_rejected');
      }
      if (context.action()) throw error;
    }
  }
  if (context.config.proxyPool.required) throw Object.assign(new Error(`Worker ${worker.slot} has no healthy proxy`), { code: 'HEALTHY_PROXY_REQUIRED' });
  return null;
}

/**
 * Detaches a Worker from its exit. Failed exits remain unavailable for this
 * run; healthy exits are released for later work once each account finishes,
 * so a root and its alias leave from different exits. The shared maintenance
 * forwarder is released without a reservation.
 */
function releaseBranchWorkerProxy(worker, context, reason = 'task_cancelled') {
  const proxyId = String(worker.proxyId || context.state.proxyLeases?.[worker.id] || '');
  if (!proxyId && !worker.proxy) return false;
  if (proxyId && !sharedProxyEntry(worker.proxy, context)) {
    context.usedProxyIds.delete(proxyId);
    worker.lastProxyId = proxyId;
  } else if (proxyId) {
    worker.lastProxyId = proxyId;
  }
  if (context.state.proxyLeases) delete context.state.proxyLeases[worker.id];
  worker.proxy = null;
  worker.proxyId = '';
  worker.updatedAt = nowIso(context);
  event(context.state, 'worker_proxy_released', {
    workerId: worker.id,
    proxyId,
    reason,
  }, context);
  return true;
}


function accountSelectionTransportFailure(error = {}) {
  if (error.code === 'OAUTH_ACCOUNT_SELECT_TRANSPORT_FAILED') return true;
  const diagnostics = error.diagnostics || {};
  return error.code === 'OAUTH_ACCOUNT_SELECT_FAILED'
    && Number(error.status || 0) >= 500
    && Number(diagnostics.bodyBytes || 0) === 0
    && !String(diagnostics.contentType || '').trim();
}

function proxyRuntimeTransportFailure(error = {}) {
  error = error || {};
  if (error.proxyFailure === true) return true;
  const code = String(error.code || '').toUpperCase();
  const message = String(error.message || '');
  const transportCode = isRetryableTransportError(error)
    && /(?:_TIMEOUT|TIMEOUT|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|ENETUNREACH|EHOSTUNREACH|SOCKET|NETWORK)/.test(code);
  // `Proxy socket closed during handshake` is the SOCKS/CONNECT exit hanging up
  // before the request reached the target. It carries no error code, so without
  // this it read as a plain job failure: no callback recovery, no OAuth retry.
  const proxyMessage = /proxy request timed out|proxy socket timed out|proxy tls handshake timed out|socket hang up|connection reset|proxy socket closed|closed during handshake/i.test(message);
  const targetAuthHost = /(?:chatgpt\.com|auth\.openai\.com|sentinel\.openai\.com)/i.test(message);
  // Node's own TLS-handshake failure text names neither the proxy nor the host,
  // so the second clause below used to reject it and a dead exit fell through to
  // the generic transient ladder: five retries on the *same* broken proxy,
  // backing off up to two minutes each, instead of rotating. It is the single
  // most common dead-exit signature — ECONNRESET before the handshake completes.
  const tlsHandshakeDropped = /socket disconnected before secure tls connection|before secure tls connection was established/i.test(message);
  // Node's ERR_SSL_PACKET_LENGTH_TOO_LONG and EPROTO variants often contain no
  // proxy hostname. They still mean the current exit returned a bad TLS
  // stream, so rotate that exit instead of retrying the same socket.
  const tlsTransport = isTlsTransportError(error);
  return tlsTransport || ((transportCode || proxyMessage) && (proxyMessage || targetAuthHost || tlsHandshakeDropped));
}

function markProxyFailed(state, proxyId, error = {}, at, options = {}) {
  if (!proxyId) return null;
  state.proxyHealth = state.proxyHealth || {};
  const previous = state.proxyHealth[proxyId] || {};
  const historicalCount = Math.max(0, Number(options.historicalCount || 0));
  const previousCount = Math.max(0, Number(previous.transportFailureCount || 0));
  const count = Math.max(previousCount + 1, historicalCount, 1);
  state.proxyHealth[proxyId] = {
    ...previous,
    status: 'failed',
    reason: String(options.reason || error.message || 'proxy_unusable'),
    lastFailureAt: at,
    lastFailureCode: String(error.code || 'PROXY_TRANSPORT_FAILURE'),
    transportFailureCount: count,
    consecutiveTransportFailures: Math.max(1, Number(previous.consecutiveTransportFailures || 0) + 1),
  };
  return state.proxyHealth[proxyId];
}

function persistedProxyFailureCount(state, job) {
  return (state.events || []).filter((record) => (
    record.type === 'branch_job_waiting'
    && record.jobId === job.id
    && proxyRuntimeTransportFailure(record)
  )).length;
}

function markAccountSelectionProxyFailed(state, proxyId, at) {
  state.proxyHealth = state.proxyHealth || {};
  const previous = state.proxyHealth?.[proxyId] || {};
  const previousCount = Math.max(0, Number(previous.accountSelectionFailures || 0));
  state.proxyHealth[proxyId] = {
    ...previous,
    status: 'failed',
    accountSelectionFailures: previousCount + 1,
    lastFailureAt: at,
    lastFailureCode: 'OAUTH_ACCOUNT_SELECT_TRANSPORT_FAILED',
    reason: 'OAUTH_ACCOUNT_SELECT_TRANSPORT_FAILED',
  };
  return state.proxyHealth[proxyId];
}


async function waitControlled(milliseconds, context) {
  const until = nowMs(context) + Math.max(0, Number(milliseconds || 0));
  while (nowMs(context) < until) {
    if (context.action()) return false;
    const delay = Math.min(500, until - nowMs(context));
    if (typeof context.control?.wait === 'function') await context.control.wait(delay);
    else await (context.sleep || sleep)(delay);
  }
  return !context.action();
}

function mailRetryDelay(error, failureAttempt, context) {
  if (error?.retryable === false) return null;
  const transportFailure = isRetryableTransportError(error);
  if (!isRetryableMailError(error) && !transportFailure) return null;
  const interval = Math.max(1, Number(context.config.mail.pollIntervalMs || 5000));
  const status = Number(error.status || 0);
  const backoff = status >= 500
    ? Math.min(30000, interval * (2 ** Math.max(0, failureAttempt - 1)))
    : interval;
  return Math.max(backoff, Number(error.retryAfterMs || 0));
}

function emailTargetDeliveryGraceMs(context) {
  const configured = Number(
    context.emailTargetDeliveryGraceMs ?? context.config.mail.targetDeliveryGraceMs,
  );
  if (!Number.isFinite(configured)) return DEFAULT_EMAIL_TARGET_DELIVERY_GRACE_MS;
  return Math.max(0, Math.min(configured, Number(context.config.mail.timeoutMs) || configured));
}

function emailProviderWaitMs(context, deadline, siblingEvidenceAt) {
  const remainingMs = Math.max(0, deadline - Date.now());
  if (!context.mailClient?.remoteRegistrationAddresses) {
    return Math.max(1, Number(context.config.mail.pollIntervalMs || 5000));
  }
  const graceMs = emailTargetDeliveryGraceMs(context);
  const siblingRemainingMs = siblingEvidenceAt
    ? Math.max(0, siblingEvidenceAt + graceMs - Date.now())
    : remainingMs;
  return Math.max(1, Math.min(
    REMOTE_EMAIL_PROVIDER_MAX_WAIT_MS,
    remainingMs,
    siblingRemainingMs || remainingMs,
  ));
}

async function readMailWithRetry(operation, options, context) {
  let failureAttempt = 0;
  let lastError = null;
  while (Date.now() <= options.deadline) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      failureAttempt += 1;
      const delayMs = mailRetryDelay(error, failureAttempt, context);
      if (delayMs === null) throw error;
      const remainingMs = options.deadline - Date.now();
      if (remainingMs <= 0) break;
      const waitMs = Math.min(delayMs, remainingMs);
      event(context.state, 'email_provider_backoff', {
        jobId: options.job.id,
        attempt: failureAttempt,
        status: Number(error.status || 0),
        code: String(error.code || 'EMAIL_PROVIDER_ERROR'),
        category: String(error.category || 'mail_provider'),
        ...(error.stage ? { stage: String(error.stage) } : {}),
        retryable: error.retryable !== false,
        waitMs,
        phase: options.phase,
        message: `${error.retryable === false ? 'Email provider rejected the request' : 'Email provider temporarily unavailable'} (${String(error.code || 'EMAIL_PROVIDER_ERROR')}): ${String(error.message || 'unknown error').slice(0, 180)}; retrying in ${Math.ceil(waitMs / 1000)}s`,
      }, context);
      await context.checkpoint('email_provider_backoff');
      if (!await waitControlled(waitMs, context)) {
        throw Object.assign(new Error('Task control interrupted email polling'), { code: 'TASK_INTERRUPTED' });
      }
    }
  }

  // The outer OTP loop can reach its deadline while a final provider read is
  // being scheduled. That is an OTP wait expiring, not a provider outage. Let
  // the caller produce the precise EMAIL_OTP_TIMEOUT code in that case.
  if (options.phase === 'email_otp' && !lastError) return null;

  throw Object.assign(new Error(`Timed out waiting for the email provider during ${options.phase}`), {
    code: 'EMAIL_PROVIDER_TIMEOUT',
    retryable: true,
    category: 'transient',
    waitPhase: TRANSIENT_PHASE,
    ...(lastError ? { cause: lastError } : {}),
  });
}

function emailBoundaryRoot(job, context) {
  const mailbox = (context.state.mailboxes || []).find((item) => String(item.id) === String(job?.mailboxId));
  const account = (context.mailAccounts || []).find((item) => String(item.id) === String(job?.mailboxId));
  const candidates = [
    mailbox?.parentEmail,
    mailbox?.rootEmail,
    mailbox?.parent,
    mailbox?.master,
    account?.parent,
    account?.master,
    account?.rootEmail,
    job?.parentEmail,
    job?.email,
  ];
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (value.includes('@')) return rootAddress(value);
  }
  return '';
}

function sharedEmailBoundaryKey(job, context, options = {}) {
  // Only the durable Mail.com/Fastmail pools expose aliases backed by one
  // master inbox. Rented mailboxes and Xiaopingguo accounts must keep their
  // existing per-mailbox snapshot behavior.
  if (!REGISTRATION_TASK_KINDS.has(context.state.taskKind)
    || !remoteRegistrationMailChannel(context.config)) return '';

  const purpose = String(options.purpose || 'registration').trim().toLowerCase();
  const fresh = options.fresh === true;
  // There are two different registration mail windows. They may both be
  // shared by aliases under one master inbox, but they must never share a
  // cache entry: the second window is captured after `user/register`, just
  // before its new OTP is sent.
  const round = purpose === 'registration_identity'
    ? 'registration_identity'
    : purpose === 'registration'
      ? (fresh ? 'registration' : 'registration_identity')
      : '';
  if (!round) return '';

  const root = emailBoundaryRoot(job, context);
  if (!root) return '';
  return `${String(context.config.mail.provider || '').toLowerCase()}:${root}:${round}`;
}

function invalidateSharedEmailBoundaryCache(job, context) {
  for (const options of [
    { fresh: true, purpose: 'registration_identity' },
    { fresh: true, purpose: 'registration' },
  ]) {
    const key = sharedEmailBoundaryKey(job, context, options);
    if (key) context.emailBoundaryCache?.delete(key);
  }
}

async function emailBoundary(job, context, options = {}) {
  context = await mailContextForJob(job, context);
  const startedAt = Date.now();
  const fresh = options.fresh === true;
  const sharedKey = sharedEmailBoundaryKey(job, context, options);
  const forceFresh = options.forceFresh === true;
  // A sequential-code mailbox (SMSBower) must re-read its queue before every
  // new send: the cached boundary from an earlier transaction cannot exclude a
  // code that is still queued behind it.
  const drainStaleCodes = options.preSend === true && context.mailClient?.sequentialCodes === true;
  if (!fresh && !forceFresh && !drainStaleCodes && job.emailBoundary?.capturedAt) return job.emailBoundary;
  // A fresh OTP transaction must not inherit the completed snapshot from the
  // previous transaction. Keep an already-running single-flight intact so
  // concurrent aliases still share one provider read.
  if (forceFresh && sharedKey) context.emailBoundaryCache?.delete(sharedKey);
  let reused = false;
  let boundary;
  if (sharedKey) {
    const cached = context.emailBoundaryCache.get(sharedKey);
    if (cached) {
      boundary = clone(cached);
      reused = true;
    } else {
      let flight = context.emailBoundaryFlights.get(sharedKey);
      if (!flight) {
        flight = (async () => {
          const captured = await readMailWithRetry(
            () => context.mailClient.snapshotMailbox(job.mailboxId, {
              folders: context.config.mail.folders,
              limit: context.config.mail.maxResults,
              ...(drainStaleCodes ? { drainStaleCodes: true } : {}),
            }),
            {
              deadline: Date.now() + context.config.mail.timeoutMs,
              job,
              phase: 'email_boundary',
            },
            context,
          );
          context.emailBoundaryCache.set(sharedKey, clone(captured));
          return captured;
        })();
        context.emailBoundaryFlights.set(sharedKey, flight);
      } else {
        reused = true;
      }
      try {
        boundary = clone(await flight);
      } finally {
        if (context.emailBoundaryFlights.get(sharedKey) === flight) {
          context.emailBoundaryFlights.delete(sharedKey);
        }
      }
    }
  } else {
    boundary = await readMailWithRetry(
      () => context.mailClient.snapshotMailbox(job.mailboxId, {
        folders: context.config.mail.folders,
        limit: context.config.mail.maxResults,
        ...(drainStaleCodes ? { drainStaleCodes: true } : {}),
      }),
      {
        deadline: Date.now() + context.config.mail.timeoutMs,
        job,
        phase: 'email_boundary',
      },
      context,
    );
  }
  // The message boundary is shared; the mailbox identity is not. A provider
  // snapshot carries whichever alias won the single-flight request, so bind
  // the cloned boundary back to this job before it is checkpointed.
  boundary = {
    ...boundary,
    ...(job.mailboxId ? { mailboxId: job.mailboxId } : {}),
    ...(job.email ? { email: job.email } : {}),
    ...(job.parentEmail ? { parent: job.parentEmail } : {}),
  };
  if (!fresh) job.emailBoundary = boundary;
  event(context.state, 'email_boundary_captured', {
    jobId: job.id,
    mailboxId: job.mailboxId,
    fresh,
    forceFresh,
    shared: Boolean(sharedKey),
    reused,
    durationMs: Date.now() - startedAt,
    purpose: String(options.purpose || 'registration'),
    ...(boundary.drainedStaleCodes ? { drainedStaleCodes: boundary.drainedStaleCodes } : {}),
    ...(boundary.drainError ? { drainError: String(boundary.drainError).slice(0, 200) } : {}),
  }, context);
  await context.checkpoint('email_boundary_captured');
  return boundary;
}

/**
 * Turns an empty mail poll into a sentence that names the cause.
 *
 * Providers that report their filter decisions get quoted; the rest fall back
 * to the request shape, which at least distinguishes an empty mailbox from a
 * filter that matched nothing.
 */
function describeEmptyMailPoll(diagnostics) {
  if (!diagnostics) return '';
  const parts = [`mailbox ${diagnostics.inbox || '?'}`];
  if (diagnostics.listed) parts.push(`listed ${diagnostics.listed}`);
  parts.push(`passed filters ${diagnostics.checkedEmails}`);
  const dropped = diagnostics.dropped && Object.entries(diagnostics.dropped).filter(([, count]) => Number(count) > 0);
  if (dropped?.length) parts.push(`dropped ${dropped.map(([reason, count]) => `${reason}=${count}`).join(' ')}`);
  if (diagnostics.recipient) parts.push(`recipient ${diagnostics.recipient}`);
  if (diagnostics.matchSubjects?.length) parts.push(`subject ${diagnostics.matchSubjects.join('|')}`);
  if (diagnostics.since) parts.push(`since ${diagnostics.since}`);
  // The decisive number, surfaced while the wait is still running rather than
  // only in the timeout: other addresses in this same inbox are being served.
  if (diagnostics.siblings?.count) {
    parts.push(`本窗口其它别名已收到 ${diagnostics.siblings.count} 封`);
  }
  // A full page means the listing may be hiding the message rather than the
  // message being absent — the provider gives 100 newest and no continuation.
  if (diagnostics.pageFull?.length) parts.push(`列表已满 ${diagnostics.pageFull.join('|')}`);
  return ` (${parts.join(', ')})`;
}

/**
 * Turns the last empty poll into a verdict about *who* failed.
 *
 * A shared mail.com inbox serves every alias under one master, so when eight
 * Workers register at once the same listing may show verification mail for
 * sibling addresses first. That is useful evidence that login, listing, body
 * fetch and code parsing work, but it is not an immediate verdict: the target
 * can still arrive later in the provider's delivery window.
 *
 * Without this the operator saw twenty-five identical "no new matching message"
 * lines and had to skip the job by hand, with no way to tell this apart from a
 * broken mail channel.
 */
function undeliveredToTarget(diagnostics, recipient) {
  const siblings = diagnostics?.siblings;
  if (!siblings || !siblings.count) return null;
  if (Number(diagnostics.checkedEmails || 0) > 0) return null;
  const domain = String(recipient || '').split('@')[1] || '';
  const others = siblings.recipients?.length ? `（${siblings.recipients.slice(0, 4).join('、')}${siblings.recipients.length > 4 ? ' 等' : ''}）` : '';
  return Object.assign(
    new Error(`${recipient} 没有收到验证码：同一收件箱在本次等待期间收到了 ${siblings.count} 封同类邮件，`
      + `但都是发给其它别名的${others}。邮箱登录、列表、正文、解析都是通的，是对端没有投递到这个地址`
      + `${domain ? `，可留意 ${domain} 这个域名的投递成功率` : ''}`),
    {
      code: 'EMAIL_NOT_DELIVERED_TO_TARGET',
      // Proven, not suspected: retrying the same address cannot change it.
      retryable: false,
      skipJob: true,
      category: 'transient',
      recipient,
      domain,
      siblingDeliveries: siblings.count,
      siblingRecipients: siblings.recipients || [],
    },
  );
}

/**
 * Tells the mail pool whether this address ever received its code.
 *
 * Best effort by design: domain health is an optimisation, and a job must not
 * fail because the bookkeeping call did. Only the unambiguous verdicts are
 * reported — a wall-clock timeout says the provider was slow, not that the
 * domain is a black hole, and feeding that in would demote healthy domains.
 */
async function reportMailDelivery(context, recipient, delivered, reason = '') {
  if (!recipient || typeof context.mailClient?.reportDelivery !== 'function') return;
  try {
    await context.mailClient.reportDelivery(recipient, delivered, reason);
  } catch (error) {
    event(context.state, 'mail_delivery_report_failed', {
      recipient,
      delivered,
      message: error?.message || String(error),
    }, context);
  }
}

async function waitEmailCode(job, recipient, boundary, context, runnerState = null, options = {}) {
  context = await mailContextForJob(job, context);
  // "The code right behind the rejected one" only exists for a sequential
  // queue. An inbox provider would hand back the same rejected message.
  if (options.nextQueuedCode === true && context.mailClient?.sequentialCodes !== true) return null;
  const configuredTimeout = Number(options.timeoutMs);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? Math.min(configuredTimeout, context.config.mail.timeoutMs)
    : context.config.mail.timeoutMs;
  const deadline = Date.now() + timeoutMs;
  const configuredAttempts = Number(options.maxPollAttempts);
  const maxAttempts = Math.max(1, Number.isFinite(configuredAttempts) && configuredAttempts > 0
    ? Math.floor(configuredAttempts)
    : (Number(context.config.mail.maxPollAttempts)
      || defaultMailMaxPollAttempts(context.config.mail.provider)));
  const targetDeliveryGraceMs = emailTargetDeliveryGraceMs(context);
  let attempt = 0;
  let lastDiagnostics = null;
  let siblingDiagnostics = null;
  let siblingEvidenceAt = 0;
  const taskState = runnerState && typeof runnerState === 'object'
    ? runnerState
    : (job.sessionState && typeof job.sessionState === 'object' ? job.sessionState : {});
  const taskBoundary = boundary || taskState.emailBoundary || job.emailBoundary || {};
  // The provider can accept and deliver an OTP before the HTTP response that
  // records `sentAt` returns. The pre-send snapshot is the safe lower bound;
  // its message ids still exclude everything that was already in the inbox.
  // Old checkpoints without a snapshot retain the send-time fallback.
  const since = String(
    taskBoundary.capturedAt
      || boundary?.capturedAt
      || taskState.emailBoundary?.capturedAt
      || job.emailBoundary?.capturedAt
      || taskBoundary.sentAt
      || taskState.emailOtpSentAt
      || '',
  );
  const excludeMessageIds = taskBoundary.messageIds
    || taskState.emailBoundary?.messageIds
    || job.emailBoundary?.messageIds
    || [];
  const throwIfRentalStartTimedOut = () => {
    const record = rentalStartTimeoutRecord(job, context);
    if (record) throw Object.assign(new Error(record.message), record);
  };
  throwIfRentalStartTimedOut();
  while (Date.now() <= deadline && attempt < maxAttempts) {
    throwIfRentalStartTimedOut();
    if (context.action()) throw Object.assign(new Error('Task control interrupted email polling'), { code: 'TASK_INTERRUPTED' });
    attempt += 1;
    const providerWaitMs = emailProviderWaitMs(context, deadline, siblingEvidenceAt);
    const found = await readMailWithRetry(
      () => context.mailClient.findVerificationCode(job.mailboxId, {
        recipient,
        since,
        folders: context.config.mail.folders,
        maxResults: context.config.mail.maxResults,
        // Remote providers support server-side long polling. Use the remaining
        // task window instead of turning one wait into many short HTTP calls.
        maxWaitMs: providerWaitMs,
        pollIntervalMs: context.config.mail.pollIntervalMs,
        keyword: context.config.mail.keyword,
        excludeMessageIds,
      }),
      { deadline, job, phase: 'email_otp' },
      context,
    );
    // A provider that can explain an empty poll is asked to. Twenty identical
    // "no new matching message" lines say nothing about whether the mailbox is
    // empty or the filter is wrong, which is the only question worth answering
    // when a channel never delivers.
    const diagnostics = found ? null : (
      typeof context.mailClient?.lastOtpDiagnostics === 'function'
        ? context.mailClient.lastOtpDiagnostics(job.mailboxId)
        : (context.mailClient?.lastOtpFetch || null)
    );
    if (diagnostics) lastDiagnostics = diagnostics;
    if (diagnostics?.siblings?.count && Number(diagnostics.checkedEmails || 0) === 0) {
      siblingDiagnostics = diagnostics;
      if (!siblingEvidenceAt) siblingEvidenceAt = Date.now();
    }
    event(context.state, found ? 'email_otp_received' : 'email_otp_poll', {
      jobId: job.id,
      attempt,
      ...(diagnostics ? { diagnostics } : {}),
      message: found
        ? 'Email OTP received'
        : `Email OTP poll ${attempt}: no new matching message${describeEmptyMailPoll(diagnostics)}`,
    }, context);
    if (found?.code) {
      job.emailMessageId = found.messageId || '';
      if (options.reportDelivery !== false) await reportMailDelivery(context, recipient, true);
      await context.checkpoint('email_otp_received');
      return found;
    }
    await context.checkpoint('email_otp_poll');
    if (siblingEvidenceAt && Date.now() >= siblingEvidenceAt + targetDeliveryGraceMs) break;
    // Mail.com keeps one IMAP connection alive for the configured interval;
    // sleeping again here would double the polling period. Other providers
    // retain their existing request-then-sleep behavior.
    if (!context.mailClient?.remoteRegistrationAddresses
      && !await waitControlled(context.config.mail.pollIntervalMs, context)) break;
  }
  const siblingGraceExpired = siblingEvidenceAt > 0
    && Date.now() >= siblingEvidenceAt + targetDeliveryGraceMs;
  const undelivered = siblingGraceExpired
    ? undeliveredToTarget(siblingDiagnostics || lastDiagnostics, recipient)
    : null;
  if (undelivered) {
    event(context.state, 'email_not_delivered_to_target', {
      jobId: job.id,
      recipient,
      domain: undelivered.domain,
      siblingDeliveries: undelivered.siblingDeliveries,
      siblingRecipients: undelivered.siblingRecipients,
      message: undelivered.message,
    }, context);
    if (options.reportDelivery !== false) await reportMailDelivery(context, recipient, false, 'not_delivered_to_target');
    await context.checkpoint('email_not_delivered_to_target');
    throw undelivered;
  }
  // A complete empty window is a settled mailbox result, even if a remote
  // long-poll reaches the wall-clock deadline before maxPollAttempts. Provider
  // transport failures escape from readMailWithRetry and keep their retry path.
  if (attempt >= maxAttempts || Date.now() > deadline) {
    if (options.reportDelivery !== false) await reportMailDelivery(context, recipient, false, 'otp_timeout');
    throw Object.assign(new Error(`${recipient} 轮询 ${attempt} 次仍未收到验证码，判定为收不到邮件并跳过`), {
      code: 'EMAIL_OTP_TIMEOUT',
      retryable: false,
      skipJob: true,
      attempts: attempt,
      recipient,
      domain: String(recipient || '').split('@')[1] || '',
    });
  }
  throw Object.assign(new Error(`Timed out waiting for email OTP for ${recipient}`), {
    code: 'EMAIL_OTP_TIMEOUT',
    retryable: true,
    category: 'transient',
    waitPhase: TRANSIENT_PHASE,
  });
}

function cloudflareChallengeHandler(job, worker, context) {
  // The runner calls this the moment a challenge is seen. Throwing here hands
  // the decision to the job-level handler, which owns proxy state and knows
  // whether the job is safe to move onto a different exit.
  return async (url) => {
    const error = new Error(`Cloudflare challenge at ${new URL(url).hostname}; the shared local maintenance forwarder will be retried`);
    error.code = 'CLOUDFLARE_CHALLENGE';
    error.cloudflareChallenge = true;
    error.challengeUrl = String(url);
    error.retryable = true;
    error.category = 'proxy';
    event(context.state, 'cloudflare_challenge_detected', {
      jobId: job.id,
      workerId: worker.id,
      proxyId: String(worker.proxyId || ''),
      url: String(url),
      message: error.message,
    }, context);
    throw error;
  };
}

function runnerOptions(job, worker, context) {
  return {
    proxy: worker.proxy?.url || '',
    signal: context.signal(),
    dynamicSentinel: context.config.registration.dynamicSentinel,
    prewarmSentinelSdk: context.config.registration.prewarmSentinelSdk,
    // Requests are built from the templates declared in code, not replayed
    // from a recording. `capture` is the opt-in that puts a run back on a HAR
    // so a fresh recording can be diffed against what the code believes.
    useHarTemplates: context.config.registration.protocolTemplates === 'capture',
    browserHeaders: context.config.registration.browserHeaders,
    authRequestTimeoutMs: context.config.registration.authRequestTimeoutMs,
    securityRequestTimeoutMs: context.config.registration.securityRequestTimeoutMs,
    traceAuthRequests: true,
    name: context.config.registration.name,
    birthdate: context.config.registration.birthdate,
    // A credentials job signs in with a password and a TOTP secret and has no
    // mailbox behind it. Wiring these anyway made the runner open the mail
    // channel on its very first step and then poll an empty mailbox id until it
    // timed out — the opposite of what this source exists for. Leaving them off
    // also lets the runner's own "the server still wants a code" guard fire.
    ...(job.credentials ? { mailboxAvailable: false } : {
      beforeEmailSend: (_recipient, _runnerState, options) => emailBoundary(job, context, options),
      getEmailCode: (recipient, boundary, runnerState, options) => waitEmailCode(job, recipient, boundary, context, runnerState, options),
    }),
    solveCloudflare: cloudflareChallengeHandler(job, worker, context),
    checkpoint: async (reason, runnerState) => {
      job.sessionState = runnerState;
      job.phase = runnerState.step;
      job.updatedAt = nowIso(context);
      markSessionTargetTouched(job, context);
      await markRentalMailboxRegistrationStarted(job, context);
      await markRemoteMailboxRegistrationStarted(job, context);
      await context.checkpoint(`session:${reason}`);
    },
    onEvent: (record) => {
      // The boundary hook already emitted the durable event with its purpose
      // and mailbox metadata before the identity side effect.
      if (record.type === 'email_boundary_captured') return;
      event(context.state, record.type, { ...record, jobId: job.id, workerId: worker.id }, context);
    },
    onRequest: (record) => event(context.state, record.type, { ...record, jobId: job.id, workerId: worker.id }, context),
  };
}

function sessionTargetTouched(job = {}) {
  if (job.sessionAssetId || job.targetTouchedAt) return true;
  const state = job.sessionState || {};
  if (state.existingAccount || state.accountCreated) return true;
  if (state.security?.passwordStatus === 'configured' || state.security?.setPassword === true) return true;
  if (/\/log-in\/password/i.test(String(state.continueUrl || ''))) return true;
  return DURABLE_SESSION_STEPS.has(String(state.step || ''));
}

/**
 * Steps OpenAI serves *before* an account exists.
 *
 * `sessionTargetTouched` deliberately covers everything durable, because any of
 * it means the run should not silently hand the address to someone else. But
 * "durable" and "spent" are not the same thing, and treating them as one is why
 * every abandoned run cost a permanent address: a job that only got as far as
 * asking for a verification code has no account behind that address at all.
 * OpenAI will happily register it later. Only the steps past account creation
 * genuinely burn it.
 */
const PRE_ACCOUNT_SESSION_STEPS = new Set([
  'email_otp_sent',
  'email_otp_validated',
  'phone_required',
  'phone_otp_sent',
]);

function mailboxAddressSpent(job = {}) {
  if (job.sessionAssetId || job.accountCreatedAt) return true;
  // Skipped means we stopped trying this address on purpose — the poll budget
  // ran out, or an operator dropped it. Handing it back would leave the cycle
  // one address short of completing, which is the thing standing between a
  // finished batch and a fresh one. Spend it and let the master rotate.
  if (String(job.status || '') === 'skipped') return true;
  const state = job.sessionState || {};
  if (state.accountCreated || state.existingAccount) return true;
  if (state.security?.passwordStatus === 'configured' || state.security?.setPassword === true) return true;
  const step = String(state.step || '');
  if (PRE_ACCOUNT_SESSION_STEPS.has(step)) return false;
  if (/\/log-in\/password/i.test(String(state.continueUrl || ''))) return true;
  return DURABLE_SESSION_STEPS.has(step);
}

function markSessionTargetTouched(job, context) {
  // A session refresh operates on an already durable asset. It does not
  // reserve a new Xiaopingguo mailbox, so the registration-only target marker
  // would be misleading noise in the refresh log.
  if (context.state.taskKind === 'session_refresh') return false;
  if (!sessionTargetTouched(job) || job.targetTouchedAt) return false;
  const mailbox = context.state.mailboxes.find((item) => String(item.id) === String(job.mailboxId));
  const expired = rentalStartExpired(mailbox);
  job.targetTouchedAt = nowIso(context);
  job.targetDisposition = job.sessionState?.existingAccount ? 'existing_account' : 'registration_started';
  if (mailbox && !expired) {
    mailbox.targetTouched = true;
    mailbox.targetTouchedAt = mailbox.targetTouchedAt || job.targetTouchedAt;
    mailbox.registrationState = 'started';
    mailbox.registrationStartedAt = mailbox.registrationStartedAt || job.targetTouchedAt;
    mailbox.lifecycle = 'registration_in_progress';
  }
  event(context.state, 'mailbox_target_touched', {
    jobId: job.id,
    mailboxId: job.mailboxId,
    disposition: job.targetDisposition,
    message: expired
      ? 'The target flow resumed after the mailbox registration-start timeout; the expired rental state was preserved'
      : 'Mailbox has entered a durable target account flow and will not be released as unused',
  }, context);
  return true;
}

async function markRentalMailboxRegistrationStarted(job, context) {
  if (!rentalMailChannel(context.config)
    || !job.mailboxId
    || !sessionTargetTouched(job)) return false;
  const mailbox = context.state.mailboxes.find((item) => String(item.id) === String(job.mailboxId));
  if (!mailbox || mailbox.rentalClosed || rentalStartExpired(mailbox)) return false;
  if (mailbox.registrationStarted === true) return false;

  const startedAt = mailbox.registrationStartedAt || job.targetTouchedAt || nowIso(context);
  const marker = typeof context.mailClient?.markRegistrationStarted === 'function'
    ? context.mailClient.markRegistrationStarted
    : context.mailClient?.markMailboxRegistrationStarted;
  let markerError = null;
  if (typeof marker === 'function') {
    try {
      await marker.call(context.mailClient, mailbox.id, { startedAt });
    } catch (error) {
      // The marker is local bookkeeping. The registration has already crossed
      // the durable boundary, so do not cancel a live rental because the
      // in-memory timer could not be updated.
      markerError = error;
    }
  }
  mailbox.registrationStarted = true;
  mailbox.registrationState = 'started';
  mailbox.registrationStartedAt = startedAt;
  mailbox.targetTouched = true;
  mailbox.targetTouchedAt = mailbox.targetTouchedAt || startedAt;
  mailbox.lifecycle = 'registration_in_progress';
  job.rentalRegistrationStartedAt = job.rentalRegistrationStartedAt || startedAt;
  event(context.state, 'mail_rental_registration_started', {
    jobId: job.id,
    mailboxId: mailbox.id,
    startedAt,
    ...(markerError ? {
      markerError: {
        code: String(markerError.code || 'MAIL_RENTAL_START_MARKER_FAILED'),
        message: String(markerError.message || markerError),
      },
    } : {}),
    message: 'SMSBower mailbox entered registration; the unstarted rental timeout is disabled',
  }, context);
  return true;
}

/**
 * How often a live registration re-announces itself to the mailbox pool.
 *
 * The pool reclaims a registration nobody has spoken for, and the only way to
 * make that reclaim *fast* without cutting off a slow-but-alive run is to have
 * the live run keep saying so. With a heartbeat the pool's timeout measures
 * silence rather than "how long a registration might legitimately take", which
 * is what forced it up to three hours — and made a cancelled task wait three
 * hours before its address came back.
 */
const REMOTE_MAILBOX_HEARTBEAT_MS = 4 * 60 * 1000;

async function markRemoteMailboxRegistrationStarted(job, context) {
  if (!remoteMailboxChannel(context.config)
    || !job.mailboxId
    || typeof context.mailClient?.markMailboxRegistrationStarted !== 'function') return false;
  const startedAt = job.remoteMailboxRegistrationStartedAt;
  if (startedAt) {
    const since = nowMs(context) - Date.parse(job.remoteMailboxHeartbeatAt || startedAt);
    if (!Number.isFinite(since) || since < REMOTE_MAILBOX_HEARTBEAT_MS) return false;
  }
  try {
    await context.mailClient.markMailboxRegistrationStarted(job.mailboxId, {
      note: `run=${context.state.runId};job=${job.id}`,
    });
    job.remoteMailboxHeartbeatAt = nowIso(context);
    if (startedAt) return true;
    job.remoteMailboxRegistrationStartedAt = job.remoteMailboxHeartbeatAt;
    job.remoteMailboxRegistrationStartError = null;
    const eventPrefix = remoteMailboxEventPrefix(context);
    event(context.state, `${eventPrefix}_registration_started`, {
      jobId: job.id,
      mailboxId: job.mailboxId,
      message: `The claimed ${eventPrefix === 'icloud' ? 'iCloud' : 'Mail.com'} mailbox entered a durable registration flow`,
    }, context);
    return true;
  } catch (error) {
    // This marker is bookkeeping only. Registration must continue when an older
    // 8001 service is still running, while the error remains visible for repair.
    job.remoteMailboxRegistrationStartError = {
      code: error.code || 'MAILCOM_REGISTRATION_START_FAILED',
      message: error.message,
    };
    const eventPrefix = remoteMailboxEventPrefix(context);
    event(context.state, `${eventPrefix}_registration_start_deferred`, {
      jobId: job.id,
      mailboxId: job.mailboxId,
      code: error.code || 'MAILCOM_REGISTRATION_START_FAILED',
      message: error.message,
    }, context);
    return false;
  }
}

async function restartStaleEmailOtpSession(job, context) {
  const state = job.sessionState;
  if (!state || state.step !== 'email_otp_sent' || state.accountCreated) return state;
  const sentAt = [...(state.events || [])].reverse().find((record) => record.type === 'email_otp_sent')?.at
    || state.updatedAt
    || job.updatedAt;
  const sentAtMs = Date.parse(sentAt || '');
  const current = typeof context.now === 'function' ? context.now() : Date.now();
  const currentMs = current instanceof Date ? current.getTime() : Number(current);
  if (!Number.isFinite(sentAtMs) || !Number.isFinite(currentMs)) return state;
  if (currentMs - sentAtMs < context.config.mail.timeoutMs) return state;

  const restarted = makeInitialChatGptSessionState({
    email: job.email,
    clientProfile: state.clientProfile,
    oaiDid: state.oaiDid,
    password: state.password,
    totpSecret: state.totpSecret,
  });
  job.sessionState = restarted;
  invalidateSharedEmailBoundaryCache(job, context);
  job.emailBoundary = null;
  job.emailMessageId = '';
  event(context.state, 'email_otp_session_restarted', {
    jobId: job.id,
    previousSentAt: sentAt,
    message: 'Expired email OTP checkpoint restarted with the same client identity',
  }, context);
  await context.checkpoint('email_otp_session_restarted');
  return restarted;
}

function sessionStateFromAsset(asset) {
  const state = makeInitialChatGptSessionState({
    email: asset.email,
    cookieJar: asset.cookieJar,
    clientProfile: asset.clientProfile,
    oaiDid: asset.oaiDid,
    password: asset.password,
    totpSecret: asset.totpSecret,
  });
  state.step = 'auth_completed';
  state.status = ['valid', 'partial'].includes(String(asset.status || '')) ? asset.status : 'running';
  state.accountId = asset.accountId;
  state.sessionToken = asset.sessionToken;
  state.planType = asset.planType || state.planType;
  state.lastValidatedAt = asset.lastValidatedAt || '';
  state.security = { ...state.security, ...(asset.security || {}) };
  return state;
}

function prepareAssetSecurityRecovery(state, security = {}) {
  const current = state?.security || {};
  const passwordTransaction = current.passwordTransaction;
  const passwordIncomplete = security.setPassword === true
    && current.passwordStatus !== 'configured'
    && passwordTransaction
    && passwordTransaction.step !== 'complete';
  if (!passwordIncomplete) return null;

  // OTP has already been validated or the password mutation has already
  // returned. Keep those checkpoints intact; only an OTP-sent/retry-pending
  // transaction is safe to replace with a fresh mailbox boundary.
  const transactionStep = String(passwordTransaction.step || '');
  if (!['otp_sent', 'retry_pending'].includes(transactionStep)) return null;

  current.passwordStatus = 'retry_pending';
  current.passwordTransaction = {
    ...passwordTransaction,
    step: 'retry_pending',
    emailBoundary: null,
    authorizeUrl: '',
    landedUrl: '',
    continueUrl: '',
    nextUrl: '',
    lastError: { code: 'SECURITY_RECOVERY_RESTARTED', retryable: true },
  };
  state.security = current;
  return { previousStep: String(passwordTransaction.step || '') };
}

async function checkpointAssetSecurityRecovery(job, state, asset, worker, security, context, source) {
  const recovery = prepareAssetSecurityRecovery(state, security);
  if (!recovery) return false;
  event(context.state, 'asset_security_recovery_prepared', {
    jobId: job.id,
    workerId: worker.id,
    assetId: asset.id,
    source,
    previousPasswordStep: recovery.previousStep,
    message: 'Discarded the incomplete password transaction; a fresh email OTP will be requested after session verification',
  }, context);
  await context.checkpoint('asset_security_recovery_prepared');
  return true;
}

function securityRetryPending(state) {
  const security = state?.security || {};
  const reauthStatus = String(security.securityReauth?.status || '');
  return state?.step === 'verified'
    && (security.passwordStatus === 'retry_pending'
      || security.totpStatus === 'retry_pending'
      || ['required', 'in_progress', 'retry_pending', 'failed'].includes(reauthStatus)
      || (security.failures || []).some(retryablePersistedSecurityFailure));
}

function definitiveSessionValidationFailure(error = {}) {
  const code = String(error.code || '').toUpperCase();
  if (code === 'ACCOUNT_DEACTIVATED') return false;
  if (['SESSION_ACCESS_TOKEN_MISSING', 'SESSION_IDENTITY_MISMATCH', 'SESSION_ACCOUNT_UNVERIFIED'].includes(code)) return true;
  return Number(error.status || error.httpStatus || 0) === 401;
}

function markDeactivatedSessionAsset(job, context, error) {
  if (String(error?.code || '').toUpperCase() !== 'ACCOUNT_DEACTIVATED') return false;
  const assetId = String(job?.assetId || job?.sessionAssetId || '');
  if (!assetId || typeof context?.assetStore?.get !== 'function' || typeof context?.assetStore?.update !== 'function') return false;

  try {
    const asset = context.assetStore.get(assetId);
    const checkedAt = nowIso(context);
    const status = Number(error.status || error.httpStatus || 0) || 403;
    const message = String(error.message || 'Account is deactivated');
    context.assetStore.update(assetId, {
      health: {
        ...(asset.health || {}),
        status: 'banned',
        code: 'ACCOUNT_DEACTIVATED',
        message,
        httpStatus: status,
        checkedAt,
        latencyMs: 0,
        lastHealthyAt: String(asset.health?.lastHealthyAt || ''),
        operation: String(context.state?.taskKind || ''),
        sourceRunId: String(context.state?.runId || ''),
      },
      lastError: { code: 'ACCOUNT_DEACTIVATED', message, status },
    });
    event(context.state, 'session_asset_marked_banned', {
      jobId: job.id,
      assetId,
      code: 'ACCOUNT_DEACTIVATED',
      message,
    }, context);
    return true;
  } catch (markError) {
    event(context.state, 'session_asset_mark_banned_failed', {
      jobId: job?.id || '',
      assetId,
      code: 'ACCOUNT_DEACTIVATED',
      message: String(markError?.message || markError),
    }, context);
    return false;
  }
}

function markOAuthLoginRequiredSessionAsset(job, context, error) {
  if (context?.state?.taskKind !== 'oauth') return false;
  if (String(error?.code || '').toUpperCase() !== 'OAUTH_LOGIN_REQUIRED') return false;
  const assetId = String(job?.assetId || job?.sessionAssetId || '');
  const store = context?.assetStore;
  if (!assetId || typeof store?.get !== 'function' || typeof store?.markLifecycle !== 'function') return false;

  try {
    const asset = store.get(assetId);
    const lifecycle = assetLifecycle(asset);
    // A sale or a ban is an explicit higher-priority disposition. Do not let
    // an OAuth failure overwrite either one or clear a ban verdict.
    if (['sold', 'banned'].includes(lifecycle)) return false;
    const result = store.markLifecycle([assetId], 'self_use');
    if (!result.changed.includes(assetId)) return lifecycle === 'self_use';
    event(context.state, 'session_asset_marked_self_use', {
      jobId: job.id,
      assetId,
      code: 'OAUTH_LOGIN_REQUIRED',
      reason: 'oauth_login_required_after_repair',
      message: 'OAuth still requires an authenticated session after the automatic login repair; asset moved to self-use',
    }, context);
    return true;
  } catch (markError) {
    event(context.state, 'session_asset_mark_self_use_failed', {
      jobId: job?.id || '',
      assetId,
      code: 'OAUTH_LOGIN_REQUIRED',
      message: String(markError?.message || markError),
    }, context);
    return false;
  }
}

function assertOAuthAssetNotCooling(context, assetId) {
  if (context?.state?.taskKind !== 'oauth') return;
  if (oauthRunIsLoginOnly(context.state) || context.plan?.oauthSource?.loginOnly === true) return;
  const id = String(assetId || '').trim();
  const store = context?.assetStore;
  if (!id || typeof store?.get !== 'function') return;
  const asset = store.get(id);
  const now = typeof context.now === 'function' ? context.now : Date.now;
  if (!oauthCooldownActive(asset, now)) return;
  const error = new Error(`OAuth is cooling down for login-state asset ${id}`);
  error.code = 'OAUTH_ASSET_COOLDOWN';
  error.assetId = id;
  error.cooldownUntil = String(asset.oauthCooldown?.until || '');
  throw error;
}

function markOAuthFailureCooldown(job, context, error = null) {
  if (!runPerformsOAuth(context?.state)) return false;
  const assetId = String(job?.assetId || job?.sessionAssetId || '').trim();
  const store = context?.assetStore;
  const budget = Number(context?.config?.sms?.replacementBudget);
  const failures = Number(job?.sms?.replacements);
  const rateLimited = smsErrorCode(error) === 'RATE_LIMIT_EXCEEDED';
  const budgetExhausted = Number.isFinite(budget)
    && Number.isFinite(failures)
    && failures > budget;
  if (!assetId
    || typeof store?.setOAuthCooldown !== 'function'
    || (!rateLimited && !budgetExhausted)) return false;

  const reason = rateLimited
    ? 'oauth_rate_limit_exceeded'
    : 'oauth_failure_budget_exhausted';
  const failureCount = Number.isFinite(failures)
    ? Math.max(rateLimited ? 1 : 0, failures)
    : (rateLimited ? 1 : 0);

  try {
    const result = store.setOAuthCooldown(assetId, {
      reason,
      durationMs: OAUTH_FAILURE_COOLDOWN_MS,
      failureCount,
      sourceRunId: context.state.runId,
      sourceJobId: job.id,
    });
    event(context.state, 'session_asset_oauth_cooldown_set', {
      jobId: job.id,
      assetId,
      failureCount,
      ...(Number.isFinite(budget) ? { replacementBudget: budget } : {}),
      cooldownUntil: result.cooldown?.until || '',
      reason,
      message: rateLimited
        ? 'OpenAI rate-limited the OAuth phone request; the login-state asset is cooling down for one hour'
        : 'OAuth phone failures exhausted the replacement budget; the login-state asset is cooling down for one hour',
    }, context);
    return true;
  } catch (markError) {
    event(context.state, 'session_asset_oauth_cooldown_failed', {
      jobId: job?.id || '',
      assetId,
      failureCount,
      ...(Number.isFinite(budget) ? { replacementBudget: budget } : {}),
      reason,
      message: String(markError?.message || markError),
    }, context);
    return false;
  }
}

async function rebindSecurityForProxyChange(job, state, asset, worker, context) {
  if (!securityRetryPending(state) || !worker?.proxy?.url) return false;

  const rebound = rebindSentinelProxy(state, worker.proxy.url);
  if (!rebound.changed) return false;

  const security = state.security || {};
  const passwordRequested = security.setPassword === true && security.passwordStatus !== 'configured';
  if (passwordRequested) {
    // The previous password OTP/authorization transaction was created under
    // the old proxy.  Keep the verified account session, but force a fresh
    // optional-security transaction instead of replaying that stale OTP.
    security.passwordStatus = 'retry_pending';
    security.passwordTransaction = {
      ...(security.passwordTransaction || {}),
      step: 'retry_pending',
      emailBoundary: null,
      authorizeUrl: '',
      landedUrl: '',
      continueUrl: '',
      nextUrl: '',
      failedAt: nowIso(context),
      lastError: { code: 'SECURITY_PROXY_REBOUND', retryable: true },
    };
  }
  security.proxyRebind = {
    at: nowIso(context),
    previousProxyId: String(asset?.sourceProxy?.id || ''),
    currentProxyId: String(worker.proxyId || ''),
  };
  state.security = security;
  event(context.state, 'security_proxy_rebound', {
    jobId: job.id,
    workerId: worker.id,
    previousProxyId: String(asset?.sourceProxy?.id || ''),
    currentProxyId: String(worker.proxyId || ''),
    passwordOtpRestarted: passwordRequested,
    message: 'Verified session retained; optional security context rebuilt for the newly bound proxy',
  }, context);
  await context.checkpoint('security_proxy_rebound');
  return true;
}

function hydrateSessionCredentials(state, asset) {
  if (!state || !asset) return state;
  if (!state.password && asset.password) state.password = asset.password;
  if (!state.totpSecret && asset.totpSecret) state.totpSecret = asset.totpSecret;
  state.security = { ...(state.security || {}), ...(asset.security || {}) };
  if (state.totpSecret && state.security.totpStatus === 'not_requested') {
    state.security.totpStatus = 'configured';
    state.security.enrollTotp = true;
  }
  return state;
}

function migrateSessionCheckpoint(state, asset) {
  hydrateSessionCredentials(state, asset);
  const pageType = String(state?.pageType || '').toLowerCase();
  const continuation = String(state?.continueUrl || '');
  if (
    state?.step === 'auth_completed'
    && (pageType === 'mfa_challenge' || /\/mfa-challenge(?:\/|$)/i.test(continuation))
  ) {
    state.step = 'mfa_required';
    state.status = 'running';
  }
  return state;
}

function assetPayload(job, state, context, sourceKind) {
  const validatedAt = String(state.lastValidatedAt || '');
  const securityPending = securityStateHasPendingWork(state);
  const verifiedHealth = state.accessToken && validatedAt ? {
    status: 'healthy',
    code: 'SESSION_VERIFIED',
    message: 'Access token and account identity were verified while saving the login state',
    httpStatus: 200,
    checkedAt: validatedAt,
    latencyMs: 0,
    lastHealthyAt: validatedAt,
  } : null;
  return {
    id: job.assetId || undefined,
    email: state.email,
    parentEmail: job.parentEmail,
    parentMailboxId: job.mailboxId,
    accountId: state.accountId,
    status: securityPending ? 'partial' : 'valid',
    planType: state.planType,
    ...(job.mailboxId && context.plan?.mailProvider
      ? { mailProvider: String(context.plan.mailProvider).toLowerCase() }
      : {}),
    accessToken: state.accessToken,
    sessionToken: state.sessionToken,
    cookieJar: state.cookieJar,
    clientProfile: state.clientProfile,
    clientProfileFingerprint: state.clientProfileFingerprint,
    oaiDid: state.oaiDid,
    session: state.session,
    me: state.me,
    password: state.password || '',
    totpSecret: state.totpSecret || '',
    security: state.security,
    ...(verifiedHealth ? { health: verifiedHealth } : {}),
    sourceKind,
    sourceRunId: context.state.runId,
    lastValidatedAt: state.lastValidatedAt,
    lastError: securityPending ? securityPartialLastError(state) : null,
    // Written once, by the run that created the account. Every later save —
    // a refresh, an OAuth top-up, a login repair — happens on a different exit
    // (usually the local forwarder), and overwriting would turn this into "the
    // last proxy that touched the account", which is not what it is for. The
    // key is omitted rather than set to null so `upsert` keeps what is stored.
    ...(REGISTRATION_TASK_KINDS.has(sourceKind) ? { sourceProxy: registrationExitRecord(job.proxy) } : {}),
  };
}

/**
 * What the account was registered through, kept on the login state.
 *
 * `endpoint` is host:port pulled out of the URL so the console can show the
 * exit without ever handling the credentialed form, and `countryCode` records
 * which pool it came from — later upkeep on this account can then be pointed at
 * the same place instead of guessing.
 */
function registrationExitRecord(proxy) {
  if (!proxy?.url) return null;
  let endpoint = '';
  try {
    const parsed = new URL(String(proxy.url));
    endpoint = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch { endpoint = ''; }
  return {
    id: String(proxy.id || ''),
    url: String(proxy.url),
    endpoint,
    protocol: String(proxy.protocol || String(proxy.url).split('://')[0] || '').toLowerCase(),
    countryCode: String(proxy.countryCode || '').toUpperCase(),
    resourceKind: String(proxy.resourceKind || ''),
  };
}

async function tagSessionAssetTrial(asset, job, context) {
  // The promo tag is metadata: an unreachable or rejecting check must leave the
  // saved login state untouched and simply mark the tag as unknown.
  if (!asset?.id) return asset;
  const checker = typeof context.trialChecker === 'function' ? context.trialChecker : checkSessionAssetTrial;
  let trial;
  try {
    // The promo endpoint is asked from the exit the account was just built on.
    // A different IP right after registration is the one thing this call can
    // control, and it is cheap to get right while the lease is still held.
    const result = await checker(asset, { proxy: String(job.proxy?.url || '') });
    trial = trialRecord(result, {
      checkedAt: String(result.checkedAt || nowIso(context)),
      latencyMs: Number(result.latencyMs || 0),
      previous: asset.trial || {},
    });
  } catch (error) {
    trial = trialRecord({
      status: 'unknown',
      code: 'TRIAL_CHECK_FAILED',
      message: 'Promo check could not be completed while saving the login state',
      httpStatus: 0,
    }, {
      checkedAt: nowIso(context),
      latencyMs: 0,
      previous: asset.trial || {},
    });
    event(context.state, 'session_asset_trial_check_failed', {
      jobId: job.id,
      assetId: asset.id,
      message: String(error?.message || error),
    }, context);
  }
  let saved = asset;
  try {
    saved = context.assetStore.update(asset.id, { trial });
  } catch (error) {
    event(context.state, 'session_asset_trial_check_failed', {
      jobId: job.id,
      assetId: asset.id,
      message: String(error?.message || error),
    }, context);
    return asset;
  }
  event(context.state, 'session_asset_trial_checked', {
    jobId: job.id,
    assetId: asset.id,
    trialStatus: trial.status,
    trialCode: trial.code,
    campaigns: trial.campaigns.length,
  }, context);
  await context.checkpoint('session_asset_trial_checked');
  return saved;
}

function securityPartialLastError(state = {}) {
  const reauth = state.security?.securityReauth || {};
  const detail = reauth.lastError && typeof reauth.lastError === 'object'
    ? reauth.lastError
    : null;
  if (['required', 'in_progress', 'retry_pending', 'failed'].includes(String(reauth.status || ''))
    && detail?.code) {
    return {
      code: String(detail.code),
      message: String(detail.message || '安全重认证尚未完成'),
    };
  }
  return {
    code: 'SECURITY_PARTIAL',
    message: 'Optional security setup was only partially completed',
  };
}

function smsErrorCode(error) {
  return String(error?.code || '').trim().toUpperCase();
}

function preserveSmsError(error, phase) {
  if (smsErrorCode(error) === 'TASK_INTERRUPTED') return error;
  const wrapped = error instanceof Error ? error : new Error(String(error || 'Phone continuity is uncertain'));
  wrapped.code = wrapped.code || 'PHONE_CONTINUITY_UNCERTAIN';
  wrapped.preserveSms = true;
  wrapped.phonePhase = phase;
  return wrapped;
}

const SMS_PREFLIGHT_ERROR_FIELDS = [
  'code',
  'category',
  'retryable',
  'retryAfterMs',
  'replacePhone',
  'status',
  'httpStatus',
  'action',
  'providerCode',
  'preserveSms',
  'phonePhase',
  'waitPhase',
];

function cloneSmsPreflightError(error) {
  const copy = new Error(String(error?.message || 'SMS preflight failed'));
  if (error?.name) copy.name = error.name;
  for (const field of SMS_PREFLIGHT_ERROR_FIELDS) {
    if (error?.[field] !== undefined) copy[field] = error[field];
  }
  return copy;
}

function smsPreflightFailureRetryAt(error, context) {
  const retryAfterMs = Number(error?.retryAfterMs);
  if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
    return nowMs(context) + retryAfterMs;
  }
  // A retryable provider error without an explicit delay still needs a small
  // task-level cooldown, otherwise every child can immediately start the same
  // failed preflight again after the single-flight promise settles.
  if (error?.retryable === true) return nowMs(context) + inventoryPollIntervalMs(context);
  // Non-retryable failures remain cached for this run. Resuming the task builds
  // a fresh context, which gives an operator a clean retry after fixing config.
  return Number.POSITIVE_INFINITY;
}

function cachedSmsPreflightError(context) {
  const cached = context.smsPreflightFailure;
  if (!cached) return null;
  const retryAt = Number(cached.retryAt);
  if (Number.isFinite(retryAt) && retryAt <= nowMs(context)) {
    context.smsPreflightFailure = null;
    return null;
  }
  return cloneSmsPreflightError(cached.error);
}

function replacePhoneError(error) {
  return error?.replacePhone === true || REPLACE_PHONE_CODES.has(smsErrorCode(error));
}

function oauthPhoneReplacementBudgetError(job, error, context, scope) {
  if (scope !== 'oauth') return error;
  const budget = Number(context?.config?.sms?.replacementBudget);
  const attempts = Number(job?.sms?.replacements);
  if (!Number.isFinite(budget) || !Number.isFinite(attempts) || attempts <= budget) return error;

  const causeCode = smsErrorCode(error) || 'PHONE_CHALLENGE_FAILED';
  const exhausted = new Error(
    `OAuth phone attempt budget exhausted after ${attempts} attempts (replacement budget: ${budget})`,
  );
  exhausted.code = 'OAUTH_PHONE_REPLACEMENT_BUDGET_EXHAUSTED';
  exhausted.category = 'settled';
  exhausted.retryable = false;
  exhausted.causeCode = causeCode;
  exhausted.causeMessage = String(error?.message || '');
  exhausted.phoneAttempts = attempts;
  exhausted.phoneReplacementBudget = budget;
  return exhausted;
}

function isUnsentOAuthPhoneSendRateLimit(job, error) {
  const lease = job?.sms?.current;
  return smsErrorCode(error) === 'RATE_LIMIT_EXCEEDED'
    && Number(error?.status || error?.httpStatus || 0) === 400
    && lease?.scope === 'oauth'
    && lease?.targetSent !== true
    && lease?.providerMarkedSent !== true
    && lease?.codeReceived !== true
    && lease?.targetAccepted !== true
    && lease?.effect?.kind === 'target_phone_send';
}

function terminalizeUnsentOAuthPhoneSendRateLimit(job, error, worker, context) {
  if (!isUnsentOAuthPhoneSendRateLimit(job, error)) return false;
  // A definitive target-side 400 before `targetSent` means no OTP was
  // accepted. Cancel the unconfirmed lease and fail this job instead of
  // preserving a paid activation for continuity retries.
  job.sms.current.cleanupAction = 'cancel';
  error.retryable = false;
  error.preserveSms = false;
  delete error.waitPhase;
  event(context.state, 'oauth_phone_send_rate_limited_before_delivery', {
    jobId: job.id,
    workerId: worker?.id || '',
    activationId: job.sms.current.activationId || job.sms.current.id || '',
    code: error.code,
    message: error.message,
  }, context);
  return true;
}

function transientBranchError(error) {
  if (error?.retryable === true) return true;
  const code = smsErrorCode(error);
  if (REGISTRATION_EMAIL_TIMEOUT_CODES.has(code)) return true;
  if (/^(?:EAI_AGAIN|ECONNRESET|ECONNREFUSED|ENETUNREACH|ETIMEDOUT|UND_ERR_)/.test(code)) return true;
  const status = Number(error?.status || 0);
  if (status === 408 || status === 425 || status === 429 || status >= 500) return true;
  return /(?:timed out|timeout|socket hang up|connection reset|network error|fetch failed)/i
    .test(String(error?.message || ''));
}

function ambiguousSmsAcquisitionError(error) {
  const code = smsErrorCode(error);
  const status = Number(error?.status || error?.httpStatus || 0);
  return error?.category === 'transient'
    || /^(?:NETWORK_ERROR|INVALID_NUMBER_RESPONSE|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ECONNABORTED|ENETUNREACH|ETIMEDOUT|UND_ERR_)/.test(code)
    || status === 408
    || status >= 500;
}

/** Out of money at the provider, as opposed to out of numbers. */
function smsBalanceExhaustedError(error) {
  return error?.category === 'balance' || smsErrorCode(error) === 'NO_BALANCE';
}

/**
 * Parks a job that ran out of SMS balance, instead of failing it.
 *
 * Running dry is an operator-fixable state: top the account up and resume. It
 * used to be terminal — `balance` matched neither the transient nor the
 * availability branch, so it fell through to a plain job failure and the
 * account was gone by the time anyone noticed. The preflight already parks the
 * run for exactly this condition; hitting it mid-run now behaves the same.
 *
 * The current balance is read back so the message can state what is actually
 * left rather than only that there is not enough.
 */
async function deferSmsBalance(job, context, scope, error) {
  const quoted = Number(context.config.sms?.maxPrice);
  const currency = context.smsPreflightSummary?.currency || (context.config.sms?.provider === 'firefox' ? 'CNY' : 'USD');
  const workers = Math.max(1, Number(context.plan?.workerConcurrency) || 1);
  const startedWith = Number(context.smsPreflightSummary?.balance);
  let balance = null;
  try {
    if (typeof context.smsProvider?.getBalance === 'function') balance = Number(await context.smsProvider.getBalance());
  } catch {
    // A balance read that fails must not replace the real error.
  }
  const spent = Number.isFinite(startedWith) && Number.isFinite(balance)
    ? Number((startedWith - balance).toFixed(6))
    : null;
  const money = [
    Number.isFinite(balance) ? `余额 ${Number.isFinite(startedWith) ? `${startedWith} → ` : ''}${balance} ${currency}` : '余额读取失败',
    spent !== null ? `本次任务已消耗 ${spent} ${currency}` : '',
    Number.isFinite(quoted) ? `单号 ${quoted} ${currency}，${workers} 个 Worker 并发共需 ${Number((quoted * workers).toFixed(6))} ${currency}` : '',
  ].filter(Boolean).join('；');
  const message = `恭喜没钱了！${money}。充值后继续任务即可接着跑`;

  job.sms.lastInventoryError = {
    code: 'NO_BALANCE',
    category: 'balance',
    message,
    at: nowIso(context),
  };
  event(context.state, 'sms_balance_exhausted', {
    jobId: job.id,
    scope,
    balance: Number.isFinite(balance) ? balance : null,
    startedWith: Number.isFinite(startedWith) ? startedWith : null,
    spent,
    maxPrice: Number.isFinite(quoted) ? quoted : null,
    workerConcurrency: workers,
    requiredBalance: Number.isFinite(quoted) ? Number((quoted * workers).toFixed(6)) : null,
    message,
  }, context);
  await context.checkpoint('sms_balance_exhausted');
  await latchBalanceStop(context, {
    source: `sms:${scope}`,
    message,
    balance: Number.isFinite(balance) ? balance : null,
  });
  const wrapped = preserveSmsError(Object.assign(error, { message }), SMS_BALANCE_PHASE);
  wrapped.code = 'NO_BALANCE';
  // Terminal rather than parked. The run has stopped renting, so no later pass
  // in it will ever have a number for this job; leaving it in
  // `waiting_sms_balance` would only hold its mailbox against a wait that
  // cannot end. Cleanup still runs, so the lease is cancelled and refunded.
  wrapped.category = 'settled';
  wrapped.retryable = false;
  wrapped.skipJob = true;
  return wrapped;
}

function smsInventoryAvailabilityError(error) {
  const code = smsErrorCode(error);
  return error?.category === 'availability'
    || code === 'NO_NUMBERS'
    || code === 'SMS_INVENTORY_EMPTY';
}

function beginSmsInventoryPoll(job, context, scope, source = 'acquire_number') {
  const at = nowIso(context);
  job.sms.inventoryStartedAt = job.sms.inventoryStartedAt || at;
  job.sms.inventoryPollCount = Number(job.sms.inventoryPollCount || 0) + 1;
  const startedAt = Date.parse(job.sms.inventoryStartedAt);
  const elapsedMs = Number.isFinite(startedAt) ? Math.max(0, nowMs(context) - startedAt) : 0;
  event(context.state, 'sms_inventory_poll_started', {
    jobId: job.id,
    scope,
    source,
    attempt: job.sms.inventoryPollCount,
    service: context.smsProvider.service,
    country: context.smsProvider.country,
    maxPrice: context.config.sms.maxPrice,
    elapsedMs,
    message: `SMS inventory poll #${job.sms.inventoryPollCount} started`,
  }, context);
  return job.sms.inventoryPollCount;
}

function resetSmsInventoryWindow(job) {
  job.nextRunAt = '';
  job.sms.inventoryStartedAt = '';
  job.sms.inventoryPollCount = 0;
  job.sms.inventoryExhaustedAt = '';
  job.sms.lastInventoryError = null;
}

async function deferSmsInventory(job, context, scope, error, attempt = 0) {
  const pollAttempt = attempt || beginSmsInventoryPoll(job, context, scope, 'preflight');
  const startedAt = Date.parse(job.sms.inventoryStartedAt);
  const currentTime = nowMs(context);
  const elapsedMs = Number.isFinite(startedAt) ? Math.max(0, currentTime - startedAt) : 0;
  const waitLimitMs = Math.max(1, Number(context.config.sms.inventoryWaitMs || 600000));
  const code = smsErrorCode(error) || 'NO_NUMBERS';
  job.sms.lastInventoryError = {
    code,
    category: String(error?.category || 'availability'),
    message: String(error?.message || 'No SMS numbers are currently available'),
    at: nowIso(context),
  };

  if (elapsedMs >= waitLimitMs) {
    job.nextRunAt = '';
    job.sms.inventoryExhaustedAt = nowIso(context);
    event(context.state, 'sms_inventory_poll_exhausted', {
      jobId: job.id,
      scope,
      attempt: pollAttempt,
      code,
      elapsedMs,
      waitLimitMs,
      message: `SMS inventory remained unavailable for ${Math.ceil(elapsedMs / 1000)}s; automatic polling stopped`,
    }, context);
    await context.checkpoint('sms_inventory_poll_exhausted');
    const wrapped = preserveSmsError(error, SMS_INVENTORY_EXHAUSTED_PHASE);
    wrapped.waitPhase = SMS_INVENTORY_EXHAUSTED_PHASE;
    wrapped.inventoryExhausted = true;
    return wrapped;
  }

  const retryAfterMs = Math.max(0, Number(error?.retryAfterMs || 0));
  const requestedDelayMs = Math.max(1, retryAfterMs, inventoryPollIntervalMs(context));
  // Jittered like every other ladder: twenty Workers that all hear NO_NUMBERS
  // in the same second would otherwise re-poll in lockstep for the whole
  // inventory window, which is exactly the burst the provider rate-limits.
  const jittered = Math.round(requestedDelayMs * (1 + (context.random() * 2 - 1) * RETRY_JITTER_RATIO));
  const delayMs = Math.min(Math.max(1, jittered), Math.max(1, waitLimitMs - elapsedMs));
  job.nextRunAt = new Date(currentTime + delayMs).toISOString();
  event(context.state, 'sms_inventory_poll_waiting', {
    jobId: job.id,
    scope,
    attempt: pollAttempt,
    code,
    category: String(error?.category || 'availability'),
    retryAfterMs,
    delayMs,
    elapsedMs,
    nextRunAt: job.nextRunAt,
    message: `No SMS number is available; poll #${pollAttempt + 1} will run in ${Math.ceil(delayMs / 1000)}s`,
  }, context);
  await context.checkpoint('sms_inventory_poll_waiting');
  const wrapped = preserveSmsError(error, SMS_INVENTORY_RETRY_PHASE);
  wrapped.waitPhase = SMS_INVENTORY_RETRY_PHASE;
  wrapped.inventoryRetryAt = job.nextRunAt;
  return wrapped;
}

function archiveSmsAcquisition(job, acquisition, status, context, details = {}) {
  job.sms.acquisitions.push({
    ...acquisition,
    ...details,
    status,
    finishedAt: nowIso(context),
  });
  job.sms.acquisition = null;
}

function abandonUnresolvedSmsAcquisition(job, context, reason) {
  const acquisition = job.sms?.acquisition;
  if (!acquisition || job.sms?.current) return false;
  const at = nowIso(context);
  archiveSmsAcquisitionIntent(context.state, job, acquisition, {
    at,
    status: 'abandoned_unresolved',
    reason,
    externalCleanup: true,
    provider: context.smsProvider?.name || context.config.sms.provider || '',
  });
  job.sms.acquisition = null;
  event(context.state, 'sms_acquisition_abandoned_unresolved', {
    jobId: job.id,
    acquisitionId: acquisition.id || '',
    reason,
    message: 'Local task cancellation completed; the provider-side outcome has no activation ID and requires manual review',
  }, context);
  return true;
}

function archiveConsumedSmsTerminalReview(job, lease, error, context, reason) {
  const activationId = String(lease.activationId || lease.id || '');
  const at = nowIso(context);
  const finalized = {
    ...lease,
    status: 'complete',
    cleanupAction: 'complete',
    cleanupReason: reason,
    cleanupError: error.message,
    cleanupErrorCode: error.code || 'BAD_STATUS',
    externalCleanupRequired: true,
    terminalReviewRequired: true,
    cleanedAt: at,
  };
  delete finalized.code;
  delete finalized.effect;
  job.sms.attempts.push(finalized);
  job.sms.current = null;
  job.sms.externalCleanupRequired = true;

  context.state.externalCleanup = Array.isArray(context.state.externalCleanup)
    ? context.state.externalCleanup
    : [];
  const duplicate = context.state.externalCleanup.some((record) => (
    record.type === 'sms_activation_terminal_review'
      && String(record.jobId || '') === String(job.id || '')
      && String(record.activationId || '') === activationId
  ));
  if (!duplicate) {
    context.state.externalCleanup.push({
      type: 'sms_activation_terminal_review',
      jobId: job.id,
      activationId,
      provider: String(lease.provider || context.smsProvider?.name || context.config.sms.provider || ''),
      service: String(lease.service || ''),
      country: String(lease.country || ''),
      status: 'manual_review_required',
      action: 'complete',
      providerStatus: String(lease.providerStatus || ''),
      reason: 'provider_rejected_consumed_activation_completion',
      error: { code: String(error.code || 'BAD_STATUS'), message: String(error.message || '') },
      recordedAt: at,
    });
  }
  event(context.state, 'sms_cleanup_terminal_review_archived', {
    jobId: job.id,
    activationId,
    action: 'complete',
    code: error.code || 'BAD_STATUS',
    message: 'Consumed SMS activation was archived locally after the provider rejected its terminal completion status',
  }, context);
}

function isConsumedSmsTerminalStatusRejection(action, lease, error) {
  return action === 'complete'
    && lease.codeReceived === true
    && String(lease.providerStatus || '').toUpperCase() === 'STATUS_OK'
    && String(error?.code || '').toUpperCase() === 'BAD_STATUS'
    && String(error?.action || '').toLowerCase() === 'setstatus'
    && error?.retryable === false;
}

function smsCleanupNeedsFinalCodeCheck(job, reason) {
  return Boolean(job?.skipPending)
    || String(reason || '').toUpperCase().includes('SMS_CODE_TIMEOUT');
}

function markSmsLeaseCodeReceived(lease, context) {
  if (!smsLeaseHasReceivedCode(lease)) return false;
  lease.codeReceived = true;
  lease.codeReceivedAt = lease.codeReceivedAt || nowIso(context);
  return true;
}

function acquisitionLease(result) {
  if (!result || typeof result !== 'object') return null;
  if (result.lease && typeof result.lease === 'object') return result.lease;
  return result.activationId || result.id ? result : null;
}

function rememberAcquiredSms(job, lease, acquisition, scope, context, reconciled = false) {
  const current = {
    ...lease,
    scope,
    acquisitionId: acquisition.id,
    acquisitionReconciled: reconciled,
  };
  job.sms.current = current;
  job.sms.costUsd += Number(current.cost || current.price || 0);
  archiveSmsAcquisition(job, acquisition, reconciled ? 'reconciled' : 'acquired', context, {
    activationId: current.activationId || current.id,
  });
  return current;
}

async function reconcileSmsAcquisition(job, scope, context) {
  const acquisition = job.sms?.acquisition;
  if (!acquisition) return 'none';
  if (acquisition.scope && acquisition.scope !== scope) return 'other_scope';
  acquisition.scope = acquisition.scope || scope;
  if (typeof context.smsProvider.reconcileAcquisition !== 'function') return 'unresolved';
  let result;
  try {
    result = await context.smsProvider.reconcileAcquisition(acquisition);
  } catch (error) {
    acquisition.reconcileAttempts = Number(acquisition.reconcileAttempts || 0) + 1;
    acquisition.lastError = { code: error.code || 'SMS_ACQUISITION_RECONCILE_FAILED', message: error.message };
    acquisition.lastReconcileAt = nowIso(context);
    await context.checkpoint('sms_acquisition_reconcile_failed');
    return 'unresolved';
  }
  const lease = acquisitionLease(result);
  if (lease) {
    rememberAcquiredSms(job, lease, acquisition, scope, context, true);
    await context.checkpoint('sms_acquisition_reconciled');
    return 'acquired';
  }
  const status = String(result?.status || '').toLowerCase();
  if (['missing', 'not_found', 'cancelled', 'failed'].includes(status)) {
    archiveSmsAcquisition(job, acquisition, status, context);
    await context.checkpoint('sms_acquisition_reconciled_empty');
    return 'missing';
  }
  acquisition.reconcileAttempts = Number(acquisition.reconcileAttempts || 0) + 1;
  acquisition.lastReconcileAt = nowIso(context);
  await context.checkpoint('sms_acquisition_reconcile_pending');
  return 'unresolved';
}

async function cleanupPendingSmsAcquisition(job, context, reason) {
  const acquisition = job.sms?.acquisition;
  if (!acquisition) return true;
  const scope = acquisition.scope || 'session';
  const reconciled = await reconcileSmsAcquisition(job, scope, context);
  if (reconciled === 'acquired') return null;
  if (reconciled === 'missing') return true;
  if (typeof context.smsProvider.cancelAcquisition === 'function') {
    try {
      const result = await context.smsProvider.cancelAcquisition(acquisition, reason);
      archiveSmsAcquisition(job, acquisition, 'cancelled', context, {
        providerStatus: result?.status || '',
        cleanupReason: reason,
      });
      await context.checkpoint('sms_acquisition_cancelled');
      return true;
    } catch (error) {
      acquisition.cleanupError = error.message;
    }
  }
  acquisition.status = 'cleanup_pending';
  acquisition.cleanupReason = reason;
  acquisition.cleanupAttempts = Number(acquisition.cleanupAttempts || 0) + 1;
  acquisition.cleanupAt = nowIso(context);
  await context.checkpoint('sms_acquisition_cleanup_deferred');
  return false;
}

async function cleanupSms(job, context, reason, options = {}) {
  if (!job.sms?.current) {
    const acquisitionCleaned = await cleanupPendingSmsAcquisition(job, context, reason);
    if (acquisitionCleaned !== null) return acquisitionCleaned;
  }
  const lease = job.sms.current;
  if (['complete', 'cancelled'].includes(lease.status)) {
    job.sms.attempts.push({ ...lease });
    job.sms.current = null;
    await context.checkpoint('sms_cleaned');
    return true;
  }
  // An explicit action is authoritative. In particular, an uncertain OAuth
  // validation has already consumed a code but must cancel the old lease when
  // the rebuilt transaction asks for a new number.
  let action = ['complete', 'cancel'].includes(String(lease.cleanupAction || ''))
    ? lease.cleanupAction
    : (lease.targetAccepted === true
      || lease.codeReceived === true
      || lease.status === 'code_received'
      || lease.status === 'completion_pending'
      ? 'complete'
      : 'cancel');
  const finalCodeCheck = action === 'cancel' && smsCleanupNeedsFinalCodeCheck(job, reason);
  // Captured before any reconcile result is merged into the lease.
  const sentToTarget = lease.targetSent === true;
  const providerMarkedSent = lease.providerMarkedSent;
  // Only the caller that is about to replace the number for a timeout may
  // take the code back. Anyone else (skip, cancel, job end) still settles.
  const mayAdoptLateCode = options.adoptLateCode === true
    && finalCodeCheck
    && !job.skipPending
    && sentToTarget
    && lease.targetAccepted !== true
    && lease.lateCodeRecovered !== true;
  const adoptIfStillOpen = () => {
    if (!mayAdoptLateCode) return false;
    const remote = String(lease.status || '').toLowerCase();
    if (['complete', 'cancelled', 'missing'].includes(remote)) return false;
    return adoptLateSmsCode(job, {
      ...lease,
      targetSent: sentToTarget,
      providerMarkedSent,
    }, context, 'timeout_cleanup');
  };
  // Set when this cleanup, asked to cancel, found the code had arrived and
  // completed instead. Under a timeout that is not "no code came" and must not
  // be booked as one; the handoff above leaves only the last-instant race.
  let lateCodeObserved = false;
  const finalize = async (result = {}, checkpoint = 'sms_cleaned') => {
    const remoteStatus = String(result?.status || lease.status || '').toLowerCase();
    const status = ['complete', 'cancelled', 'missing'].includes(remoteStatus)
      ? remoteStatus
      : (action === 'complete' ? 'complete' : 'cancelled');
    const recordedReason = lateCodeObserved && String(reason || '').toUpperCase().includes('SMS_CODE_TIMEOUT')
      ? SMS_LATE_CODE_REASON
      : reason;
    const finalized = {
      ...lease,
      ...(result || {}),
      status,
      cleanupAction: action,
      cleanupReason: recordedReason,
      ...(recordedReason !== reason ? { requestedCleanupReason: reason, lateCodeAtCleanup: true } : {}),
      cleanedAt: nowIso(context),
    };
    delete finalized.code;
    delete finalized.effect;
    job.sms.attempts.push(finalized);
    job.sms.current = null;
    await context.checkpoint(checkpoint);
    return true;
  };
  try {
    if (typeof context.smsProvider.reconcile === 'function') {
      try {
        const reconciled = await context.smsProvider.reconcile(lease);
        Object.assign(lease, reconciled || {});
        if (lease.status === 'complete') action = 'complete';
        if (finalCodeCheck && markSmsLeaseCodeReceived(lease, context)) {
          action = 'complete';
          lateCodeObserved = true;
        }
        if (['complete', 'cancelled', 'missing'].includes(reconciled?.status)) {
          return finalize(reconciled, 'sms_cleanup_reconciled');
        }
        // A timeout or operator skip can land in the small window where the
        // first status read still says WAIT_CODE and the provider rejects the
        // following cancellation because the code arrived a moment later.
        // Re-read immediately before sending the destructive status mutation.
        if (finalCodeCheck && action === 'cancel') {
          const finalCheck = await context.smsProvider.reconcile(lease);
          Object.assign(lease, finalCheck || {});
          if (lease.status === 'complete') action = 'complete';
          if (markSmsLeaseCodeReceived(lease, context)) {
            action = 'complete';
            lateCodeObserved = true;
          }
          if (['complete', 'cancelled', 'missing'].includes(finalCheck?.status)) {
            return finalize(finalCheck, 'sms_cleanup_reconciled');
          }
        }
      } catch { /* Fall through to the requested terminal mutation. */ }
    }
    // Cleanup's own reads found the code before anything destructive was
    // sent. Settling here would pay for the number and then replace it.
    if (lateCodeObserved && adoptIfStillOpen()) return SMS_LATE_CODE_ADOPTED;
    const result = action === 'complete'
      ? await context.smsProvider.complete(lease)
      : await context.smsProvider.cancel(lease, reason);
    const cleaned = await finalize(result);
    event(context.state, 'sms_cleanup_completed', {
      jobId: job.id,
      activationId: lease.activationId || lease.id,
      action,
      reason,
      message: `SMS activation ${action} completed`,
    }, context);
    return cleaned;
  } catch (error) {
    if (action === 'cancel'
      && String(error?.code || '').toUpperCase() === 'BAD_STATUS'
      && typeof context.smsProvider.reconcile === 'function') {
      try {
        const lateCheck = await context.smsProvider.reconcile(lease);
        Object.assign(lease, lateCheck || {});
        if (lease.status === 'complete') action = 'complete';
        const codeReceived = markSmsLeaseCodeReceived(lease, context);
        // The cancel was refused because the code landed: the activation is
        // still open and the code is still good for the transaction on screen.
        if (codeReceived && adoptIfStillOpen()) return SMS_LATE_CODE_ADOPTED;
        if (codeReceived) {
          action = 'complete';
          lateCodeObserved = true;
          const completed = await context.smsProvider.complete(lease);
          return finalize(completed);
        }
        if (['complete', 'cancelled', 'missing'].includes(lateCheck?.status)) {
          return finalize(lateCheck);
        }
      } catch (lateError) {
        if (isConsumedSmsTerminalStatusRejection(action, lease, lateError)) {
          archiveConsumedSmsTerminalReview(job, lease, lateError, context, reason);
          await context.checkpoint('sms_cleanup_terminal_review_archived');
          return true;
        }
      }
    }
    if (isConsumedSmsTerminalStatusRejection(action, lease, error)) {
      archiveConsumedSmsTerminalReview(job, lease, error, context, reason);
      await context.checkpoint('sms_cleanup_terminal_review_archived');
      return true;
    }
    job.sms.current = {
      ...lease,
      status: action === 'complete' ? 'completion_pending' : 'pending_cleanup',
      cleanupAction: action,
      cleanupReason: reason,
      cleanupError: error.message,
      cleanupAttempts: Number(lease.cleanupAttempts || 0) + 1,
      cleanupAt: nowIso(context),
    };
    event(context.state, 'sms_cleanup_deferred', {
      jobId: job.id,
      activationId: lease.activationId || lease.id,
      action,
      code: error.code || 'SMS_CLEANUP_FAILED',
      message: error.message,
    }, context);
    await context.checkpoint('sms_cleanup_deferred');
    return false;
  }
}

function ensureOAuthPhoneCodeDeadline(lease, context, fallbackStartedAt = '') {
  if (!lease || lease.scope !== 'oauth' || lease.codeReceived === true) return '';
  const existing = Date.parse(String(lease.codeDeadlineAt || ''));
  if (Number.isFinite(existing)) return lease.codeDeadlineAt;
  const sentAt = Date.parse(String(
    fallbackStartedAt
      || lease.providerMarkedAt
      || lease.targetSentAt
      || '',
  ));
  const startedAt = Number.isFinite(sentAt) ? sentAt : nowMs(context);
  lease.codeDeadlineAt = new Date(startedAt + (context.config.sms.oauthCodeTimeoutMs ?? OAUTH_PHONE_CODE_TIMEOUT_MS)).toISOString();
  return lease.codeDeadlineAt;
}

function oauthSmsResendDisabledError() {
  const error = new Error('OAuth SMS code retry is disabled; replacing the phone number');
  error.code = 'OAUTH_SMS_RESEND_DISABLED';
  error.replacePhone = true;
  return error;
}

/**
 * Single-flight around the preflight below.
 *
 * The guard is a synchronous read and the assignment that satisfies it is on
 * the far side of several awaits, so twenty Workers reaching the phone
 * challenge together — the normal case, since they start together — all fell
 * through it and each ran a full preflight. One preflight is several sequential
 * provider calls, so that was dozens of requests where a handful would do, and
 * the throttling it earned fed straight back into the retry ladder.
 */
async function ensureSmsPreflight(job, context, scope) {
  if (context.smsPreflightSummary?.ready) return context.smsPreflightSummary;
  const cachedError = cachedSmsPreflightError(context);
  if (cachedError) throw cachedError;
  if (context.smsPreflightFlight) return context.smsPreflightFlight;
  const operation = runSmsPreflight(job, context, scope).then(
    (summary) => {
      context.smsPreflightFailure = null;
      return summary;
    },
    (error) => {
      context.smsPreflightFailure = {
        error: cloneSmsPreflightError(error),
        retryAt: smsPreflightFailureRetryAt(error, context),
      };
      throw error;
    },
  );
  context.smsPreflightFlight = operation.finally(() => {
    context.smsPreflightFlight = null;
  });
  return context.smsPreflightFlight;
}

async function runSmsPreflight(job, context, scope) {
  const provider = context.smsProvider;
  if (typeof provider?.preflight !== 'function') {
    context.smsPreflightSummary = { provider: provider?.name || 'unknown', ready: true, checked: false };
    return context.smsPreflightSummary;
  }

  event(context.state, 'sms_phone_preflight_started', {
    jobId: job.id,
    scope,
    service: provider.service || context.config.sms.service,
    country: provider.country || context.config.sms.country,
    message: 'Phone challenge reached; checking SMS balance, price, and inventory before acquisition',
  }, context);
  await context.checkpoint('sms_phone_preflight_started');

  let summary;
  try {
    const result = await provider.preflight();
    summary = summarizeSmsPreflight(result, context.config.sms, { required: true, concurrency: context.plan?.workerConcurrency });
  } catch (error) {
    event(context.state, 'sms_phone_preflight_failed', {
      jobId: job.id,
      scope,
      code: error.code || 'SMS_PREFLIGHT_FAILED',
      message: error.message,
    }, context);
    await context.checkpoint('sms_phone_preflight_failed');
    throw preserveSmsError(error, 'waiting_sms_preflight');
  }

  summary.checkedAt = nowIso(context);
  summary.source = 'runtime_phone_preflight';
  context.smsPreflightSummary = summary;
  recordBalanceStart(context.state, summary, nowMs(context), {
    hasReader: typeof context.smsProvider?.getBalance === 'function',
    accountFingerprint: balanceAccountFingerprint(context.smsProvider),
  });
  if (context.state.preflight && typeof context.state.preflight === 'object') {
    context.state.preflight.sms = summary;
    if (Array.isArray(context.state.preflight.checks)) {
      const check = context.state.preflight.checks.find((item) => item.id === 'sms');
      if (check) {
        check.checked = true;
        check.required = true;
        check.ready = summary.ready;
        check.detail = summary.message || `${summary.offers || 0} offer(s), balance ${summary.balance ?? 'unknown'} ${summary.currency || 'USD'}`;
      }
    }
  }
  event(context.state, 'sms_phone_preflight_completed', {
    jobId: job.id,
    scope,
    ready: summary.ready,
    issue: summary.issue || '',
    balance: summary.balance,
    cheapestPrice: summary.cheapestPrice,
    offers: summary.offers,
    message: summary.message || 'SMS market is ready for phone acquisition',
  }, context);
  await context.checkpoint('sms_phone_preflight_completed');
  if (!summary.ready) {
    const error = new Error(summary.message || 'SMS market is not ready for phone acquisition');
    error.code = summary.issue || 'SMS_PREFLIGHT_FAILED';
    if (error.code === 'SMS_INVENTORY_EMPTY') {
      error.category = 'availability';
      error.retryable = true;
    }
    throw preserveSmsError(error, 'waiting_sms_preflight');
  }
  return summary;
}

async function acquireSms(job, context, scope) {
  if (job.sms.acquisition) {
    const outcome = await reconcileSmsAcquisition(job, scope, context);
    if (outcome === 'acquired') {
      resetSmsInventoryWindow(job);
      return job.sms.current;
    }
    if (outcome !== 'missing' && outcome !== 'none') {
      const error = new Error('SMS number acquisition outcome is uncertain and must be reconciled before another number is requested');
      error.code = 'SMS_ACQUISITION_UNCERTAIN';
      throw preserveSmsError(error, 'waiting_sms_acquisition_reconcile');
    }
  }
  // Out of money: never ask the provider for another number. Reconciling an
  // acquisition that may already exist is above this line on purpose — that one
  // is already paid for and has to be resolved either way.
  if (balanceStopped(context.state)) throw balanceStopError(context.state);
  try {
    await ensureSmsPreflight(job, context, scope);
  } catch (error) {
    if (smsInventoryAvailabilityError(error)) {
      throw await deferSmsInventory(job, context, scope, error);
    }
    throw error;
  }
  const inventoryAttempt = beginSmsInventoryPoll(job, context, scope);
  const acquisition = {
    id: `sms-acquire-${crypto.randomUUID()}`,
    scope,
    status: 'pending',
    startedAt: nowIso(context),
    request: {
      serviceCode: context.smsProvider.service,
      countryId: context.smsProvider.country,
      maxPrice: context.config.sms.maxPrice,
    },
  };
  job.sms.acquisition = acquisition;
  await context.checkpoint('intent:sms_number_acquire');
  let lease;
  try {
    lease = await context.smsProvider.acquireNumber({
      ...acquisition.request,
      acquisitionId: acquisition.id,
    });
  } catch (error) {
    if (error.invalidLease) {
      resetSmsInventoryWindow(job);
      error.invalidLease = { ...error.invalidLease, scope, acquisitionId: acquisition.id };
      archiveSmsAcquisition(job, acquisition, 'invalid_lease', context, {
        activationId: error.invalidLease.activationId || error.invalidLease.id,
      });
      await context.checkpoint('sms_acquisition_invalid_lease');
    } else if (ambiguousSmsAcquisitionError(error)) {
      resetSmsInventoryWindow(job);
      acquisition.status = 'uncertain';
      acquisition.lastError = { code: error.code || 'SMS_ACQUISITION_FAILED', message: error.message };
      acquisition.lastAttemptAt = nowIso(context);
      await context.checkpoint('sms_acquisition_uncertain');
      throw preserveSmsError(error, 'waiting_sms_acquisition_reconcile');
    } else {
      archiveSmsAcquisition(job, acquisition, 'failed', context, {
        error: { code: error.code || 'SMS_ACQUISITION_FAILED', message: error.message },
      });
      await context.checkpoint('sms_acquisition_failed');
      if (smsInventoryAvailabilityError(error)) {
        throw await deferSmsInventory(job, context, scope, error, inventoryAttempt);
      }
      if (smsBalanceExhaustedError(error)) {
        resetSmsInventoryWindow(job);
        throw await deferSmsBalance(job, context, scope, error);
      }
      resetSmsInventoryWindow(job);
    }
    throw error;
  }
  if (lease.country) {
    acquisition.country = String(lease.country);
    acquisition.request.countryId = String(lease.country);
  }
  rememberAcquiredSms(job, lease, acquisition, scope, context);
  event(context.state, 'sms_number_acquired', {
    jobId: job.id,
    activationId: lease.activationId || lease.id,
    country: lease.country || '',
    number: lease.number,
    cost: lease.cost ?? lease.price ?? null,
    inventoryAttempt,
  }, context);
  resetSmsInventoryWindow(job);
  await context.checkpoint('sms_number_acquired');
  return lease;
}

async function recordInvalidLease(job, error, context) {
  const invalid = error?.invalidLease;
  if (!invalid) return false;
  const lease = {
    ...invalid,
    scope: invalid.scope || 'session',
    cleanupAction: invalid.status === 'pending_cleanup' ? 'cancel' : '',
    recordedAt: nowIso(context),
  };
  if (Number.isFinite(Number(lease.cost))) job.sms.costUsd += Number(lease.cost);
  if (lease.status === 'pending_cleanup') job.sms.current = lease;
  else job.sms.attempts.push(lease);
  event(context.state, 'sms_invalid_lease_recorded', {
    jobId: job.id,
    activationId: lease.activationId || lease.id,
    status: lease.status,
    message: error.message,
  }, context);
  await context.checkpoint('sms_invalid_lease_recorded');
  return true;
}

async function pollPhoneCode(job, context, deadlineAt = null) {
  const parsedDeadline = deadlineAt === null || deadlineAt === undefined || deadlineAt === ''
    ? NaN
    : (typeof deadlineAt === 'string' ? Date.parse(deadlineAt) : Number(deadlineAt));
  const deadline = Number.isFinite(parsedDeadline)
    ? parsedDeadline
    : nowMs(context) + context.config.sms.codeTimeoutMs;
  let attempt = 0;
  const readOnce = async () => {
    if (context.action()) throw Object.assign(new Error('Task control interrupted SMS polling'), { code: 'TASK_INTERRUPTED' });
    attempt += 1;
    const observation = await context.smsProvider.pollCode(job.sms.current, {
      timeoutMs: 0,
      pollIntervalMs: 0,
      onPoll: (next) => event(context.state, 'sms_code_poll', {
        jobId: job.id,
        attempt,
        activationId: job.sms.current.activationId || job.sms.current.id,
        providerStatus: next.providerStatus || next.status,
        hasCode: next.hasCode === true,
        message: `SMS poll ${attempt}: ${next.providerStatus || next.status || 'waiting'}`,
      }, context),
    });
    await context.checkpoint('sms_code_poll');
    return String(observation?.code || '');
  };
  while (nowMs(context) < deadline) {
    const code = await readOnce();
    if (code) return code;
    const remainingMs = deadline - nowMs(context);
    if (remainingMs <= 0) break;
    if (!await waitControlled(Math.min(context.config.sms.pollIntervalMs ?? PHONE_POLL_INTERVAL_MS, remainingMs), context)) break;
    // The last wait ends on the deadline itself, and the loop used to exit
    // there without looking: up to a full poll interval of arrivals was never
    // read, and a code that landed in it was only found by the cleanup that
    // then paid for it and threw the number away. One read on the deadline.
    if (nowMs(context) >= deadline) return readOnce();
  }
  return '';
}

async function sendPhoneToTarget(job, runner, runnerState, context) {
  const lease = job.sms.current;
  lease.effect = { kind: 'target_phone_send', scope: lease.scope, startedAt: nowIso(context) };
  await context.checkpoint('intent:target_phone_send');
  try {
    await runner.sendPhone(runnerState, lease.number);
  } catch (error) {
    if (REPLACE_PHONE_CODES.has(smsErrorCode(error))) error.replacePhone = true;
    throw error;
  }
  lease.targetSent = true;
  lease.targetSentAt = nowIso(context);
  lease.effect = null;
  await context.checkpoint('target_phone_sent');
}

const MARK_SENT_REJECTED_RECHECK_DELAY_MS = 3000;

/**
 * `setStatus(1)` refused with BAD_STATUS right after the target accepted the
 * send. The usual cause is a race, not a dead number: the code reached the
 * provider first, the activation moved to STATUS_OK, and "mark as sent" is no
 * longer a legal transition. Failing here skipped the poll entirely, so a code
 * already sitting at the provider was thrown away with the paid activation.
 *
 * Read the activation (now, and once more shortly after). A code found there
 * carries the phone step on as if the mark had succeeded; no code leaves the
 * original error to the existing replacement path.
 */
async function recoverCodeAfterMarkSentRejected(job, context, error) {
  if (smsErrorCode(error) !== 'BAD_STATUS' || typeof context.smsProvider?.reconcile !== 'function') return false;
  const lease = job.sms.current;
  for (let check = 1; check <= 2; check += 1) {
    const recheckDelayMs = Number.isFinite(Number(context.markSentRejectedRecheckDelayMs))
      ? Number(context.markSentRejectedRecheckDelayMs)
      : MARK_SENT_REJECTED_RECHECK_DELAY_MS;
    if (check > 1 && !await waitControlled(recheckDelayMs, context)) break;
    let reconciled;
    try {
      reconciled = await context.smsProvider.reconcile(lease);
    } catch {
      continue;
    }
    const code = String(reconciled?.code || '');
    event(context.state, 'sms_mark_sent_rejected_status_checked', {
      jobId: job.id,
      activationId: lease.activationId || lease.id,
      check,
      providerStatus: String(reconciled?.providerStatus || reconciled?.status || ''),
      hasCode: Boolean(code),
      message: code
        ? 'SMSBower refused setStatus(1) because the code had already arrived; continuing with that code'
        : `SMSBower refused setStatus(1); status check ${check} found no code yet`,
    }, context);
    if (!code) continue;
    const at = nowIso(context);
    job.sms.current = {
      ...lease,
      ...reconciled,
      code,
      codeReceived: true,
      codeReceivedAt: reconciled.codeReceivedAt || at,
      status: 'code_received',
      targetSent: true,
      providerMarkedSent: true,
      providerMarkedAt: at,
      markSentRejected: true,
      effect: null,
    };
    ensureOAuthPhoneCodeDeadline(job.sms.current, context, at);
    await context.checkpoint('sms_code_recovered_after_mark_sent_rejected');
    return true;
  }
  await context.checkpoint('sms_mark_sent_rejected_without_code');
  return false;
}

async function markProviderSmsSent(job, context, options = {}) {
  const lease = job.sms.current;
  if (lease.providerMarkedSent) return;
  if (lease.effect?.kind === 'provider_mark_sent' && typeof context.smsProvider.reconcile === 'function') {
    try {
      const reconciled = await context.smsProvider.reconcile(lease);
      if (['waiting_code', 'retry_requested', 'code_received', 'complete'].includes(reconciled?.status)) {
        const providerMarkedAt = lease.providerMarkedAt || lease.effect?.startedAt || nowIso(context);
        job.sms.current = {
          ...lease,
          ...reconciled,
          targetSent: true,
          providerMarkedSent: true,
          providerMarkedAt,
          effect: null,
        };
        if (reconciled.code) {
          job.sms.current.code = reconciled.code;
          job.sms.current.codeReceived = true;
        }
        ensureOAuthPhoneCodeDeadline(job.sms.current, context, providerMarkedAt);
        await context.checkpoint('sms_mark_sent_reconciled');
        return;
      }
    } catch { /* Retry the same status transition below. */ }
  }
  lease.effect = { kind: 'provider_mark_sent', scope: lease.scope, startedAt: nowIso(context) };
  await context.checkpoint('intent:sms_marked_sent');
  let marked;
  try {
    marked = await context.smsProvider.markSmsSent(lease);
  } catch (error) {
    if (await recoverCodeAfterMarkSentRejected(job, context, error)) return;
    throw error;
  }
  const providerMarkedAt = nowIso(context);
  job.sms.current = {
    ...lease,
    ...(marked || {}),
    targetSent: true,
    providerMarkedSent: true,
    providerMarkedAt,
    effect: null,
  };
  ensureOAuthPhoneCodeDeadline(job.sms.current, context, providerMarkedAt);
  if (options.deferCheckpoint !== true) await context.checkpoint('sms_marked_sent');
}

async function resendSameNumber(job, runner, runnerState, context, reason) {
  const lease = job.sms.current;
  lease.effect = { kind: 'provider_request_another', scope: lease.scope, reason, startedAt: nowIso(context) };
  await context.checkpoint('intent:sms_request_another');
  try {
    const next = await context.smsProvider.requestAnotherCode(lease);
    job.sms.current = {
      ...lease,
      ...(next || {}),
      code: '',
      codeReceived: false,
      targetAccepted: false,
      targetSent: false,
      providerMarkedSent: false,
      resendPrepared: true,
      effect: null,
    };
  } catch (error) {
    if (smsErrorCode(error) === 'BAD_STATUS') error.replacePhone = true;
    throw error;
  }
  job.sms.sendRetries += 1;
  event(context.state, 'sms_same_number_resend', {
    jobId: job.id,
    number: lease.number,
    attempt: job.sms.sendRetries,
    reason,
  }, context);
  await context.checkpoint('sms_request_another');
  await sendPhoneToTarget(job, runner, runnerState, context);
  await markProviderSmsSent(job, context, { deferCheckpoint: true });
  job.sms.current.resendPrepared = false;
  await context.checkpoint('sms_same_number_resent');
}

function phoneStateAdvanced(runnerState) {
  const step = String(runnerState?.step || '');
  if (runnerState?.mode === 'cockpit-oauth') {
    return ['navigating', 'callback_received', 'token_exchange_pending', 'token_validating', 'complete'].includes(step);
  }
  if (runnerState?.mode === 'chatgpt-nextauth-session') {
    return [
      'email_otp_validated',
      'mfa_required',
      'mfa_challenge_issued',
      'mfa_verification_pending',
      'mfa_validated',
      'account_created',
      'auth_completed',
      'verified',
    ].includes(step);
  }
  return false;
}

function markPhoneAccepted(lease, runnerState, context, inferred = false) {
  lease.targetAccepted = true;
  lease.targetAcceptedAt = lease.targetAcceptedAt || nowIso(context);
  if (inferred) lease.targetAcceptedInferred = true;
  lease.acceptedRunnerStep = String(runnerState?.step || '');
  lease.effect = null;
}

async function reconcileAmbiguousPhoneValidation(job, runner, runnerState, context, scope) {
  const lease = job.sms?.current;
  if (lease?.effect?.kind !== 'target_phone_validate') return;
  if (phoneStateAdvanced(runnerState)) {
    markPhoneAccepted(lease, runnerState, context, true);
    await context.checkpoint('target_phone_validation_reconciled');
    return;
  }
  const reconcile = typeof runner.reconcilePhoneValidation === 'function'
    ? (input) => runner.reconcilePhoneValidation(runnerState, input)
    : (typeof context.reconcilePhoneValidation === 'function'
      ? (input) => context.reconcilePhoneValidation({ ...input, runner, runnerState })
      : null);
  if (!reconcile) {
    const error = new Error('Phone OTP validation outcome is uncertain; waiting for target-state confirmation without replaying the code');
    error.code = 'PHONE_VALIDATION_CONFIRMATION_REQUIRED';
    throw preserveSmsError(error, PHONE_CONFIRMATION_PHASE);
  }
  lease.effect.confirmationAttempts = Number(lease.effect.confirmationAttempts || 0) + 1;
  lease.effect.lastConfirmationAt = nowIso(context);
  await context.checkpoint('intent:target_phone_validation_reconcile');
  let result;
  try {
    result = await reconcile({ job, lease, scope });
  } catch (error) {
    lease.effect.lastConfirmationError = { code: error.code || 'PHONE_VALIDATION_RECONCILE_FAILED', message: error.message };
    await context.checkpoint('target_phone_validation_reconcile_failed');
    throw preserveSmsError(error, PHONE_CONFIRMATION_PHASE);
  }
  if (result?.runnerState && typeof result.runnerState === 'object') Object.assign(runnerState, result.runnerState);
  if (result?.step) runnerState.step = String(result.step);
  const status = result === true ? 'accepted' : String(result?.status || '').toLowerCase();
  if (status === 'accepted' || phoneStateAdvanced(runnerState)) {
    markPhoneAccepted(lease, runnerState, context, true);
    await context.checkpoint('target_phone_validation_reconciled');
    return;
  }
  if (result === false || ['rejected', 'invalid'].includes(status)) {
    lease.effect = null;
    lease.code = '';
    lease.codeReceived = false;
    await context.checkpoint('target_phone_validation_rejected');
    if (scope !== 'oauth' && job.sms.sendRetries < (context.config.sms.sendRetryLimit ?? 1)) {
      await resendSameNumber(job, runner, runnerState, context, 'confirmed_invalid_phone_code');
      return;
    }
    const error = new Error(result?.message || 'Target confirmed that the phone OTP was rejected');
    error.code = String(result?.code || 'INVALID_PHONE_OTP').toUpperCase();
    error.validationRejected = true;
    error.replacePhone = true;
    throw error;
  }
  const error = new Error('Target phone validation is still unconfirmed; the OTP will not be replayed');
  error.code = 'PHONE_VALIDATION_STILL_UNCERTAIN';
  throw preserveSmsError(error, PHONE_CONFIRMATION_PHASE);
}

async function reconcilePhoneEffect(job, runner, runnerState, context, scope) {
  const lease = job.sms?.current;
  if (!lease?.effect) return;
  if (lease.scope !== scope) return;
  if (lease.effect.kind === 'target_phone_validate') {
    await reconcileAmbiguousPhoneValidation(job, runner, runnerState, context, scope);
    return;
  }
  if (scope === 'oauth' && lease.effect.kind === 'provider_request_another') {
    throw oauthSmsResendDisabledError();
  }
  if (
    lease.effect.kind === 'target_phone_send'
    && Number(job.sms.sendRetries || 0) === 0
    && runnerState?.step === 'phone_otp_sent'
  ) {
    job.sms.current = {
      ...lease,
      targetSent: true,
      targetSentAt: lease.targetSentAt || nowIso(context),
      targetSentInferred: true,
      effect: null,
    };
    await context.checkpoint('target_phone_send_reconciled');
    return;
  }
  if (typeof context.smsProvider.reconcile !== 'function') return;
  let reconciled;
  try { reconciled = await context.smsProvider.reconcile(lease); } catch { return; }
  const status = String(reconciled?.status || '');
  if (lease.effect.kind === 'provider_request_another' && ['retry_requested', 'waiting_code', 'code_received'].includes(status)) {
    job.sms.current = {
      ...lease,
      ...reconciled,
      code: reconciled.code || '',
      codeReceived: Boolean(reconciled.code),
      targetAccepted: false,
      targetSent: Boolean(reconciled.code),
      providerMarkedSent: true,
      resendPrepared: !reconciled.code,
      effect: null,
    };
    job.sms.sendRetries = Math.max(1, job.sms.sendRetries);
    await context.checkpoint('sms_request_another_reconciled');
    return;
  }
  if (lease.effect.kind === 'target_phone_send' && status === 'code_received') {
    job.sms.current = {
      ...lease,
      ...reconciled,
      code: reconciled.code || lease.code || '',
      codeReceived: true,
      targetSent: true,
      providerMarkedSent: true,
      effect: null,
    };
    await context.checkpoint('target_phone_send_reconciled');
  }
}

async function completePhoneLease(job, context) {
  const lease = job.sms.current;
  lease.cleanupAction = 'complete';
  const cleaned = await cleanupSms(job, context, 'phone_verified');
  if (!cleaned) {
    const error = new Error('Phone was accepted but the SMS activation completion is pending');
    error.code = 'SMS_COMPLETION_PENDING';
    throw preserveSmsError(error, 'waiting_sms_completion');
  }
}

async function settleSmsBeforeJobCompletion(job, context) {
  const lease = job.sms?.current;
  if (!lease) return;
  if (lease.targetAccepted) {
    await completePhoneLease(job, context);
    return;
  }
  lease.cleanupAction = 'cancel';
  const cleaned = await cleanupSms(job, context, 'job_completed_without_phone_challenge');
  if (!cleaned) {
    const error = new Error('SMS activation cleanup must finish before the job can complete');
    error.code = 'SMS_CLEANUP_PENDING';
    throw preserveSmsError(error, SMS_CLEANUP_PHASE);
  }
}

async function processPhoneLease(job, runner, runnerState, context, scope) {
  await reconcilePhoneEffect(job, runner, runnerState, context, scope);
  if (job.sms.current.targetAccepted) {
    await completePhoneLease(job, context);
    return;
  }
  if (scope === 'oauth' && job.sms.current.resendPrepared) {
    throw oauthSmsResendDisabledError();
  }
  if (job.sms.current.resendPrepared && !job.sms.current.targetSent) {
    await sendPhoneToTarget(job, runner, runnerState, context);
    await markProviderSmsSent(job, context);
    job.sms.current.resendPrepared = false;
    await context.checkpoint('sms_same_number_resent');
  }
  if (!job.sms.current.targetSent) await sendPhoneToTarget(job, runner, runnerState, context);
  await markProviderSmsSent(job, context, { deferCheckpoint: true });

  while (true) {
    let code = String(job.sms.current.code || '');
    if (!code) {
      const previousDeadline = job.sms.current.codeDeadlineAt || '';
      if (scope === 'oauth') {
        ensureOAuthPhoneCodeDeadline(job.sms.current, context);
        if (job.sms.current.codeDeadlineAt !== previousDeadline) {
          await context.checkpoint('oauth_sms_code_deadline_initialized');
        }
      }
      code = await pollPhoneCode(job, context, scope === 'oauth' ? job.sms.current.codeDeadlineAt : null);
      while (!code && scope !== 'oauth' && job.sms.sendRetries < (context.config.sms.sendRetryLimit ?? 1)) {
        await resendSameNumber(job, runner, runnerState, context, 'sms_timeout');
        code = await pollPhoneCode(job, context);
      }
      if (!code) {
        const error = new Error('SMS code timeout');
        error.code = 'SMS_CODE_TIMEOUT';
        error.replacePhone = true;
        throw error;
      }
      job.sms.current.code = code;
      job.sms.current.codeReceived = true;
      job.sms.current.status = 'code_received';
      job.sms.current.codeReceivedAt = nowIso(context);
      await context.checkpoint('sms_code_received');
    }

    job.sms.current.effect = { kind: 'target_phone_validate', scope, startedAt: nowIso(context) };
    await context.checkpoint('intent:target_phone_validate');
    try {
      await runner.validatePhone(runnerState, code);
    } catch (error) {
      if (scope !== 'oauth' && INVALID_PHONE_CODE_ERRORS.has(smsErrorCode(error)) && job.sms.sendRetries < (context.config.sms.sendRetryLimit ?? 1)) {
        job.sms.current.effect = null;
        await resendSameNumber(job, runner, runnerState, context, 'invalid_phone_code');
        continue;
      }
      if (INVALID_PHONE_CODE_ERRORS.has(smsErrorCode(error)) || REPLACE_PHONE_CODES.has(smsErrorCode(error))) {
        error.replacePhone = true;
      }
      if (!replacePhoneError(error)) throw preserveSmsError(error, PHONE_CONFIRMATION_PHASE);
      throw error;
    }
    job.sms.current.targetAccepted = true;
    job.sms.current.targetAcceptedAt = nowIso(context);
    job.sms.current.effect = null;
    await context.checkpoint('target_phone_accepted');
    await completePhoneLease(job, context);
    return;
  }
}

/**
 * A code that lands just after the poll deadline still belongs to the phone
 * transaction on screen, so it goes to validation rather than to cleanup.
 *
 * Cleanup already re-read the activation before cancelling, and on finding
 * the code it switched to `complete` — paying for the number — then returned
 * to a caller that had already decided to replace it. The code was bought and
 * never entered: 0.047 of waste booked as SMS_CODE_TIMEOUT on a lease whose
 * record said the code had arrived. The read now happens here, where finding
 * the code can still change the decision.
 */
async function recoverLateSmsCode(job, context, error) {
  if (String(error?.code || '').toUpperCase() !== 'SMS_CODE_TIMEOUT') return false;
  const lease = job.sms?.current;
  if (!lease || !lease.targetSent || lease.targetAccepted || lease.lateCodeRecovered) return false;
  if (job.skipPending || typeof context.smsProvider?.reconcile !== 'function') return false;
  let reconciled;
  try {
    reconciled = await context.smsProvider.reconcile(lease);
  } catch {
    return false;
  }
  if (!String(reconciled?.code || '').trim()) return false;
  const adopted = adoptLateSmsCode(job, {
    ...lease,
    ...reconciled,
    targetSent: lease.targetSent,
    providerMarkedSent: lease.providerMarkedSent,
    codeReceivedAt: reconciled?.codeReceivedAt || lease.codeReceivedAt || '',
  }, context, 'timeout_read');
  if (!adopted) return false;
  await context.checkpoint('sms_late_code_recovered');
  return true;
}

/**
 * Puts a code that arrived at the last moment back on the live lease, so the
 * loop validates it on the transaction already on screen.
 *
 * Two places can see it: the read right after the poll deadline, and the
 * reads cleanup makes before cancelling. Only the first used to change the
 * decision. Cleanup found the code, settled the activation — paying for it —
 * and returned `true`, and its caller replaced the number anyway (run
 * ui-20260928104010-sskjn6, activation 682710490: poll 7 WAIT_CODE, eleven
 * seconds later settled as a timeout, a fresh number bought). Relabelling that
 * as SMS_LATE_CODE named the waste without removing it.
 *
 * Synchronous on purpose: cleanup calls it inside try blocks whose catch
 * falls through to a destructive mutation, so nothing here may throw after
 * `job.sms.current` has been swapped.
 */
function adoptLateSmsCode(job, lease, context, source) {
  const code = String(lease?.code || '').trim();
  if (!code) return false;
  const adopted = {
    ...lease,
    code,
    codeReceived: true,
    status: 'code_received',
    codeReceivedAt: lease.codeReceivedAt || nowIso(context),
    lateCodeRecovered: true,
    effect: null,
  };
  delete adopted.cleanupAction;
  delete adopted.cleanupReason;
  job.sms.current = adopted;
  event(context.state, 'sms_late_code_recovered', {
    jobId: job.id,
    activationId: lease.activationId || lease.id,
    scope: lease.scope || '',
    source,
    codeDeadlineAt: lease.codeDeadlineAt || '',
    message: source === 'timeout_cleanup'
      ? 'SMS code landed while the timeout cleanup was about to cancel; validating it instead of replacing the number'
      : 'SMS code arrived after the poll deadline; validating it instead of replacing the number',
  }, context);
  return true;
}

async function handlePhoneChallenge(job, runner, runnerState, context, scope) {
  while (job.sms.replacements <= context.config.sms.replacementBudget) {
    if (job.sms.current && !job.sms.current.scope) {
      job.sms.current.scope = scope;
      await context.checkpoint('sms_phone_scope_assigned');
    }
    if (job.sms.current?.scope && job.sms.current.scope !== scope) {
      const error = new Error(`Outstanding SMS activation belongs to the ${job.sms.current.scope} phone branch`);
      error.code = 'SMS_PHONE_SCOPE_MISMATCH';
      throw preserveSmsError(error, 'waiting_phone_scope');
    }
    if (job.sms.current?.cleanupAction && !job.sms.current.targetAccepted) {
      const cleaned = await cleanupSms(job, context, job.sms.current.cleanupReason || 'pending_cleanup', { adoptLateCode: true });
      if (cleaned === SMS_LATE_CODE_ADOPTED) {
        await context.checkpoint('sms_late_code_recovered');
      } else if (!cleaned) {
        const error = new Error('SMS activation cleanup is still pending');
        error.code = 'SMS_CLEANUP_PENDING';
        throw preserveSmsError(error, SMS_CLEANUP_PHASE);
      }
    }
    if (!job.sms.current) {
      try {
        await acquireSms(job, context, scope);
      } catch (error) {
        const recorded = await recordInvalidLease(job, error, context);
        if (!recorded) throw error;
        if (job.sms.current) throw preserveSmsError(error, SMS_CLEANUP_PHASE);
        job.sms.replacements += 1;
        if (job.sms.replacements > context.config.sms.replacementBudget) {
          throw oauthPhoneReplacementBudgetError(job, error, context, scope);
        }
        continue;
      }
    }
    try {
      await processPhoneLease(job, runner, runnerState, context, scope);
      return;
    } catch (error) {
      if (error.code === 'TASK_INTERRUPTED') throw error;
      if (!replacePhoneError(error)) throw preserveSmsError(error, error.phonePhase || PHONE_CONTINUITY_PHASE);
      if (await recoverLateSmsCode(job, context, error)) continue;
      const cleaned = await cleanupSms(job, context, error.code || 'phone_challenge_failed', { adoptLateCode: true });
      if (cleaned === SMS_LATE_CODE_ADOPTED) {
        await context.checkpoint('sms_late_code_recovered');
        continue;
      }
      if (!cleaned) throw preserveSmsError(error, SMS_CLEANUP_PHASE);
      job.sms.replacements += 1;
      job.sms.sendRetries = 0;
      event(context.state, 'sms_number_replacement', { jobId: job.id, attempt: job.sms.replacements, message: error.message }, context);
      if (job.sms.replacements > context.config.sms.replacementBudget) {
        throw oauthPhoneReplacementBudgetError(job, error, context, scope);
      }
    }
  }
}

async function reconcileAcceptedPhoneCheckpoint(job, runnerState, context, scope) {
  const lease = job.sms?.current;
  if (!lease || lease.scope !== scope || lease.targetAccepted || !lease.codeReceived) return;
  if (lease.effect?.kind !== 'target_phone_validate') return;
  if (!phoneStateAdvanced(runnerState)) return;
  markPhoneAccepted(lease, runnerState, context, true);
  event(context.state, 'target_phone_acceptance_reconciled', {
    jobId: job.id,
    activationId: lease.activationId || lease.id,
    scope,
    runnerStep: runnerState?.step || '',
    message: 'Recovered the accepted phone boundary from the runner checkpoint',
  }, context);
  await context.checkpoint('target_phone_acceptance_reconciled');
  await completePhoneLease(job, context);
}

async function establishSession(job, worker, context, options = {}) {
  let asset = job.assetId ? context.assetStore.get(job.assetId) : null;
  const security = options.security || {};
  let state = job.sessionState;
  if (state) migrateSessionCheckpoint(state, asset);
  if (state && job.retry?.phase === SECURITY_EMAIL_RETRY_PHASE && !job.securityEmailExhausted) {
    // Hydration restores the asset's last failed transaction. Re-arm after
    // hydration so the next send cannot reuse an expired OTP boundary.
    prepareAssetSecurityRecovery(state, security);
  }
  if (state && options.securityRetryOnly === true && securityWorkRequested(security)) {
    await rebindSecurityForProxyChange(job, state, asset, worker, context);
  }
  const optionsForRunner = runnerOptions(job, worker, context);
  if (asset && confirmedRebindMetadata(asset)) {
    optionsForRunner.confirmedEmailChange = {
      previousEmail: asset.rebind.previousEmail, email: asset.email, accountId: asset.accountId,
    };
  }
  const runner = typeof context.sessionRunnerFactory === 'function'
    ? context.sessionRunnerFactory({ har: context.har, job, worker, context, options: optionsForRunner })
    : new ChatGptSessionRunner(context.har, optionsForRunner);
  try {
    const cachedPlanType = String(asset?.planType || state?.planType || '').trim().toLowerCase();
    const skipUsageMetadata = Boolean(
      options.sourceKind === 'session_refresh'
        && cachedPlanType
        && cachedPlanType !== 'unknown',
    );
    const reuseVerifiedSecuritySession = options.securityRetryOnly === true
      && securityWorkRequested(security)
      && securityRetryPending(state)
      && (!asset?.sourceProxy?.id || String(asset.sourceProxy.id) === String(worker.proxyId || ''));
    const runOptions = {
      security,
      existingOnly: options.existingOnly === true,
      skipVerifiedSessionRefresh: reuseVerifiedSecuritySession,
      skipUsageMetadata,
      forceFreshEmailBoundary: job.emailOtpRecovery?.action === 'fresh_code',
    };
    if (reuseVerifiedSecuritySession) {
      event(context.state, 'session_refresh_skipped_for_security_retry', {
        jobId: job.id,
        workerId: worker.id,
        message: 'Reusing the verified session checkpoint before retrying optional security setup',
      }, context);
    }
    const sameSessionProxy = !asset?.sourceProxy?.id
      || String(asset.sourceProxy.id) === String(worker.proxyId || '');
    // Once this job has verified the session, a later SMS inventory retry may
    // use a maintenance exit instead of the registration exit. The task-local
    // marker is the stronger continuity proof; the proxy match remains required
    // when reusing an asset that was verified before this task started.
    const reuseVerifiedSession = options.reuseVerifiedSession === true
      && Boolean(asset?.id)
      && Boolean(job.oauthState)
      && (Boolean(job.sessionVerifiedAt) || sameSessionProxy)
      && state?.step === 'verified'
      && ['valid', 'partial'].includes(state.status);
    let stateRunCompleted = reuseVerifiedSession;
    if (reuseVerifiedSession) {
      event(context.state, 'session_stage_reused_for_oauth_retry', {
        jobId: job.id,
        workerId: worker.id,
        assetId: asset.id,
        oauthStep: String(job.oauthState?.step || ''),
        message: 'Reusing the verified login state while retrying the persisted OAuth continuation',
      }, context);
      await context.checkpoint('session_stage_reused_for_oauth_retry');
    }
    let persistedValidationFailed = false;
    if (!stateRunCompleted && state?.step === 'verified' && ['valid', 'partial'].includes(state.status) && !options.forceOtp) {
      try {
        await runner.run(state, runOptions);
        stateRunCompleted = true;
      } catch (error) {
        if (!definitiveSessionValidationFailure(error)) throw error;
        event(context.state, 'session_validation_failed', { jobId: job.id, assetId: asset?.id || job.assetId, message: error.message }, context);
        state = null;
        job.sessionState = null;
        job.sessionVerifiedAt = '';
        persistedValidationFailed = true;
      }
    }
    if (!state && asset && !options.forceOtp && !persistedValidationFailed) {
      state = sessionStateFromAsset(asset);
      job.sessionState = state;
      await checkpointAssetSecurityRecovery(job, state, asset, worker, security, context, 'saved_session');
      try {
        await runner.run(state, runOptions);
        stateRunCompleted = true;
      } catch (error) {
        if (!definitiveSessionValidationFailure(error)) throw error;
        event(context.state, 'session_validation_failed', { jobId: job.id, assetId: asset.id, message: error.message }, context);
        state = null;
        job.sessionVerifiedAt = '';
      }
    }
    if (!state || (state.step === 'verified' && state.status !== 'valid' && state.status !== 'partial')) {
      state = makeInitialChatGptSessionState({
        email: job.email,
        clientProfile: asset?.clientProfile,
        // The exit decides the browser's locale and clock. A profile drawn for
        // one country and then used from another contradicts itself, so this
        // is read once, when the account first gets a machine.
        profileCountry: worker.proxy?.countryCode || '',
        clientProfilePool: context.config.registration.clientProfilePool,
        oaiDid: asset?.oaiDid,
        // A credentials job has no asset to read from on its first pass, and its
        // pasted secrets are what make the password login possible at all.
        password: asset?.password || job.credentials?.password,
        totpSecret: asset?.totpSecret || job.credentials?.totpSecret,
      });
      if (asset) hydrateSessionCredentials(state, asset);
      job.sessionState = state;
      if (asset) {
        await checkpointAssetSecurityRecovery(job, state, asset, worker, security, context, 'email_login_fallback');
      }
    }
    const beforeStaleRestart = state;
    state = await restartStaleEmailOtpSession(job, context);
    if (state !== beforeStaleRestart) stateRunCompleted = false;
    await reconcileAcceptedPhoneCheckpoint(job, state, context, 'session');
    if (!stateRunCompleted) await runner.run(state, runOptions);
    if (state.step === 'phone_required' || state.step === 'phone_otp_sent') {
      await handlePhoneChallenge(job, runner, state, context, 'session');
      await runner.run(state, runOptions);
    }
    if (!['valid', 'partial'].includes(state.status)) throw new Error(`ChatGPT session did not reach a verified state: ${state.step}`);
    job.sessionVerifiedAt = job.sessionVerifiedAt || nowIso(context);
    if (!reuseVerifiedSession) {
      markSessionTargetTouched(job, context);
      await markRentalMailboxRegistrationStarted(job, context);
      await markRemoteMailboxRegistrationStarted(job, context);
      asset = context.assetStore.upsert(assetPayload(job, state, context, options.sourceKind || 'email_otp'));
      await context.checkpoint('session_asset_saved');
      asset = await tagSessionAssetTrial(asset, job, context);
    }
    job.assetId = asset.id;
    job.sessionAssetId = asset.id;
    if (state.accountCreated && !job.accountCreatedAt) job.accountCreatedAt = nowIso(context);
    job.sessionState = state;
    return asset;
  } finally {
    await disposeSessionRunner(runner, job, context);
  }
}

function canReuseSessionForOAuthContinuation(job) {
  return Boolean(job.oauthState)
    && !job.cpaPath
    && !job.cpaSuperseded
    && !['pending', 'in_progress'].includes(job.oauthRecovery?.status);
}

/**
 * What an account must carry before its login state is allowed to become a CPA.
 *
 * Fixed rather than read from `plan.security`. A plan is refused at launch
 * unless it asks for both (`assertOAuthSecurityPlanIsSafe`), so consulting it
 * here could only ever weaken the rule — and the one run where it still
 * differs is a run resumed from a checkpoint written before that refusal
 * existed, which is exactly the run worth holding.
 */
const OAUTH_REQUIRED_SECURITY = Object.freeze({ setPassword: true, enrollTotp: true });

/**
 * Stop a register-then-OAuth job at the registration boundary.
 *
 * The same reason the rental mail channels refuse to run without a password
 * and a TOTP: once the mailbox is gone, an account that got neither can never
 * be signed into again. A CPA minted from such an account is a product nobody
 * can use, and running the OAuth leg for it spends phone numbers to produce
 * one. The login state itself is real, so the asset is kept and the job ends
 * `partial` rather than failed — 登录态资产 lists it for OTP/PW 恢复, and the
 * OAuth leg can be launched from there once the account is whole.
 *
 * Only a job that has not already written its CPA is held: once the artifact
 * exists the numbers are spent and withholding it destroys value rather than
 * protecting it.
 */
async function holdBackOAuthForSecurity(job, worker, context, asset, missing) {
  await settleSmsBeforeJobCompletion(job, context);
  event(context.state, 'post_registration_oauth_held_security_incomplete', {
    jobId: job.id,
    workerId: worker.id,
    assetId: asset.id,
    missingSecurity: missing,
    message: `Registration finished without ${missing.join(' and ')}; holding the account back from OAuth until security recovery completes it`,
  }, context);
  await context.checkpoint('post_registration_oauth_held_security_incomplete');
  job.missingSecurity = missing.slice();
  job.status = 'partial';
  job.phase = 'partial';
  job.result = 'session_security_incomplete_oauth_held';
  job.sessionAssetId = asset.id;
}

async function settleSecuredRentalMailbox(job, context) {
  if (!rentalMailChannel(context.config) || !job.mailboxId) return;
  if (!registrationSecuredForSettlement(job, context)) return;
  try {
    await settleFinishedRentals(context, { mailboxIds: [job.mailboxId] });
  } catch (error) {
    // Never fail an account over its mailbox bill: the scheduler's own pass
    // retries the settle, and the account is already saved.
    event(context.state, 'mail_rental_close_deferred', {
      mailboxId: job.mailboxId,
      jobId: job.id,
      message: String(error?.message || error),
    }, context);
  }
}

async function runRegistrationSessionJob(job, worker, context) {
  const oauthAlreadyStarted = context.plan.postRegistrationOAuth === true
    && canReuseSessionForOAuthContinuation(job);
  const callbackLogin = job.callbackLoginRecovery?.status === 'pending';
  const asset = await establishSession(job, worker, context, {
    forceOtp: true,
    security: context.plan.security,
    securityRetryOnly: true,
    reuseVerifiedSession: oauthAlreadyStarted,
    // The account exists; sign in to it (password, or an email code if the
    // login asks for one) instead of walking the signup flow again.
    ...(callbackLogin ? { existingOnly: true } : {}),
    sourceKind: 'register_session',
  });
  if (callbackLogin) {
    job.callbackLoginRecovery.status = 'complete';
    job.callbackLoginRecovery.completedAt = nowIso(context);
    event(context.state, 'auth_callback_login_recovered', {
      jobId: job.id,
      workerId: worker.id,
      message: 'A fresh login replaced the spent authorization code; the account continues on its saved session',
    }, context);
    await context.checkpoint('auth_callback_login_recovered');
  }
  if (context.plan.postRegistrationOAuth === true) {
    const missingSecurity = missingSecurityFeatures(job.sessionState, OAUTH_REQUIRED_SECURITY);
    if (missingSecurity.length && (!job.cpaPath || job.cpaSuperseded)) {
      await holdBackOAuthForSecurity(job, worker, context, asset, missingSecurity);
      return;
    }
    if (!job.cpaPath || job.cpaSuperseded) {
      // The mailbox has done its job. Settle it now rather than after OAuth,
      // which can run for half an hour of phone attempts — longer than the
      // provider keeps the activation open.
      await settleSecuredRentalMailbox(job, context);
      if (!oauthAlreadyStarted) {
        event(context.state, 'post_registration_oauth_started', {
          jobId: job.id,
          workerId: worker.id,
          assetId: asset.id,
          message: 'Login state saved; continuing to Cockpit OAuth in the same Worker context',
        }, context);
        await context.checkpoint('post_registration_oauth_started');
      }
      await runOAuthAuthorization(job, worker, context, asset, { kind: 'register_session' });
    } else {
      await settleSmsBeforeJobCompletion(job, context);
    }
    const partialSecurity = securityStateHasPendingWork(job.sessionState);
    job.status = partialSecurity ? 'partial' : 'complete';
    job.phase = job.status;
    job.result = partialSecurity ? 'session_security_partial_cpa_saved' : 'session_and_cpa_saved';
    return;
  }
  await settleSmsBeforeJobCompletion(job, context);
  job.status = securityStateHasPendingWork(job.sessionState) ? 'partial' : 'complete';
  job.phase = job.status;
  job.result = job.sessionState.existingAccount && !accountCreatedInRun(job)
    ? 'existing_account_recovered'
    : 'session_saved';
  job.sessionAssetId = asset.id;
}

async function runRefreshJob(job, worker, context) {
  const asset = await establishSession(job, worker, context, {
    sourceKind: 'session_refresh',
    security: context.plan.security,
    securityRetryOnly: true,
    existingOnly: true,
  });
  await settleSmsBeforeJobCompletion(job, context);
  job.status = securityStateHasPendingWork(job.sessionState) ? 'partial' : 'complete';
  job.phase = job.status;
  job.result = job.status === 'partial' ? 'session_security_partial' : 'session_refreshed';
  job.sessionAssetId = asset.id;
}

function oauthStateFromAsset(asset) {
  return makeInitialCockpitOAuthState({
    cookieJar: asset.cookieJar,
    clientProfile: asset.clientProfile,
    clientProfileFingerprint: asset.clientProfileFingerprint,
    oaiDid: asset.oaiDid,
    email: asset.email,
    accountId: asset.accountId,
  });
}

function rebuiltOAuthState(previous = {}, asset = {}, options = {}) {
  return makeInitialCockpitOAuthState({
    oauth: createCodexPkceSession({ nowMs: nowMs(options) }),
    cookieJar: previous.cookieJar || asset.cookieJar,
    clientProfile: previous.clientProfile || asset.clientProfile,
    clientProfileFingerprint: previous.clientProfileFingerprint || asset.clientProfileFingerprint,
    oaiDid: previous.oaiDid || asset.oaiDid,
    email: previous.email || asset.email,
    accountId: previous.accountId || asset.accountId,
    workspaceId: previous.workspaceId || '',
  });
}

function recoverableOAuthPhoneSendStateError(job, error) {
  const lease = job.sms?.current;
  const code = smsErrorCode(error);
  const status = Number(error?.status || 0);
  const step = String(job.oauthState?.step || '');
  const staleAuthorizationState = code === 'INVALID_STATE'
    && status === 409
    && step === 'phone_required';
  const invalidAuthStep = code === 'INVALID_AUTH_STEP'
    && status === 400
    && ['phone_required', 'phone_otp_sent'].includes(step);
  return (staleAuthorizationState || invalidAuthStep)
    && lease?.scope === 'oauth'
    && lease.effect?.kind === 'target_phone_send'
    && lease.targetSent !== true
    && lease.providerMarkedSent !== true
    && lease.codeReceived !== true
    && Number(lease.oauthTransactionRestarts || 0) < OAUTH_PHONE_STATE_RESTART_LIMIT;
}

/**
 * A consent continuation the server has thrown away, after the phone is done.
 *
 * `workspace_select` timed out on 2026-09-24 (HTTP 500 `Request timeout`), the
 * job retried it as a transient fault, and the retry replayed the *same*
 * continuation — which that timeout had already invalidated. The answer was
 * HTTP 409 `invalid_state`: "Your sign-in session is no longer valid. Please
 * start over to continue." The account was registered, verified, its password
 * and TOTP were set, and its phone had been validated a minute earlier; only
 * the CPA was lost.
 *
 * The server is asking for a new authorization, not a replay, so that is what
 * this allows — once, and only with no SMS lease in hand. A lease still open
 * belongs to the phone-send recovery above, which reuses it deliberately;
 * rebuilding underneath it would strand a number that has been paid for.
 */
function recoverableOAuthContinuationStateError(job, error) {
  return String(error?.code || '').trim().toUpperCase() === 'INVALID_STATE'
    && Number(error?.status || 0) === 409
    && !job.sms?.current
    && Number(job.oauthContinuationRestarts || 0) < OAUTH_CONTINUATION_RESTART_LIMIT;
}

/**
 * Rebuilds the authorization while keeping everything the account is known by.
 *
 * A fresh PKCE session, and the same cookie jar, browser profile and device id
 * — so the retry is the same machine asking again, which is the whole point of
 * pinning a job to its Worker and exit in the first place.
 */
function resetOAuthContinuation(job, asset, options = {}) {
  const previous = job.oauthState;
  job.oauthContinuationRestarts = Number(job.oauthContinuationRestarts || 0) + 1;
  job.oauthState = rebuiltOAuthState(previous, asset, options);
  return {
    attempt: job.oauthContinuationRestarts,
    previousStep: String(previous?.step || ''),
    previousState: previous?.oauth?.state || '',
  };
}

/**
 * Publishes the rebuild, or declines it. Both `runner.run` call sites go
 * through here: the invalidation can arrive on the first authorization pass or
 * on the continuation that follows the phone stage, and it means the same
 * thing either way.
 */
async function restartInvalidatedOAuthContinuation(job, worker, context, asset, error) {
  if (!recoverableOAuthContinuationStateError(job, error)) return false;
  const restarted = resetOAuthContinuation(job, asset, context);
  event(context.state, 'oauth_continuation_restarted', {
    jobId: job.id,
    workerId: worker?.id || '',
    attempt: restarted.attempt,
    step: restarted.previousStep,
    previousState: restarted.previousState,
    code: String(error?.code || 'INVALID_STATE'),
    status: Number(error?.status || 0),
    message: 'The consent continuation was invalidated server-side; the authorization is rebuilt on the same session and exit',
  }, context);
  await context.checkpoint('oauth_continuation_restarted');
  return true;
}

function resetOAuthPhoneSendTransaction(job, asset, error, options = {}) {
  const lease = job.sms.current;
  const previous = job.oauthState;
  const at = nowIso(options);
  lease.effect = null;
  lease.oauthTransactionRestarts = Number(lease.oauthTransactionRestarts || 0) + 1;
  lease.lastOAuthTransactionError = {
    code: smsErrorCode(error),
    status: Number(error?.status || 0),
    at,
  };
  job.oauthState = rebuiltOAuthState(previous, asset, options);
  return {
    activationId: lease.activationId || lease.id,
    attempt: lease.oauthTransactionRestarts,
    previousState: previous.oauth?.state || '',
    nextState: job.oauthState.oauth?.state || '',
    at,
  };
}

function oauthPhoneValidationRecoveryActive(job) {
  return ['restarting', 'replacing_phone'].includes(
    String(job.oauthPhoneValidationRecovery?.status || ''),
  );
}

function ambiguousOAuthPhoneValidationError(job, error) {
  const lease = job.sms?.current;
  const recoveryStatus = String(job.oauthPhoneValidationRecovery?.status || 'idle');
  if (lease?.scope !== 'oauth'
    || lease.codeReceived !== true
    || lease.effect?.kind !== 'target_phone_validate'
    || ['complete', 'exhausted'].includes(recoveryStatus)
    || replacePhoneError(error)) return false;
  return error?.phonePhase === PHONE_CONFIRMATION_PHASE
    || error?.preserveSms === true
    || smsErrorCode(error).startsWith('PHONE_VALIDATION_')
    || transientBranchError(error);
}

function exhaustedOAuthPhoneValidationError(job, error) {
  const lease = job.sms?.current;
  const recoveryStatus = String(job.oauthPhoneValidationRecovery?.status || 'idle');
  if (recoveryStatus !== 'exhausted'
    || lease?.scope !== 'oauth'
    || lease.codeReceived !== true
    || lease.targetAccepted === true
    || lease.effect?.kind !== 'target_phone_validate') return false;
  return error?.phonePhase === PHONE_CONFIRMATION_PHASE
    || error?.preserveSms === true
    || smsErrorCode(error).startsWith('PHONE_VALIDATION_')
    || transientBranchError(error);
}

function recoverableOAuthPhoneValidationJob(state = {}, job = {}) {
  if (job.oauthCooldown === true || job.error?.oauthCooldown === true) return false;
  if (!['oauth', 'register_oauth', 'register_session'].includes(String(state.taskKind || ''))) return false;
  const lease = job.sms?.current;
  const recovery = job.oauthPhoneValidationRecovery || {};
  const attempts = Number(recovery.attempts || 0);
  if (!['waiting', 'failed'].includes(String(job.status || ''))
    && String(job.phase || '') !== PHONE_CONFIRMATION_PHASE) return false;
  return lease?.scope === 'oauth'
    && lease.codeReceived === true
    && lease.targetAccepted !== true
    && lease.effect?.kind === 'target_phone_validate'
    && Number.isFinite(attempts)
    && attempts < OAUTH_PHONE_VALIDATION_RECOVERY_LIMIT
    && (job.phase === PHONE_CONFIRMATION_PHASE
      || job.error?.phonePhase === PHONE_CONFIRMATION_PHASE
      || smsErrorCode(job.error).startsWith('PHONE_VALIDATION_'));
}

function manualOAuthPhoneValidationRecoveryJob(state = {}, job = {}) {
  if (job.oauthCooldown === true || job.error?.oauthCooldown === true) return false;
  if (!['oauth', 'register_oauth', 'register_session'].includes(String(state.taskKind || ''))) return false;
  const lease = job.sms?.current;
  const recovery = job.oauthPhoneValidationRecovery || {};
  if (String(recovery.status || '') !== 'exhausted') return false;
  if (!['waiting', 'failed'].includes(String(job.status || ''))
    && String(job.phase || '') !== PHONE_MANUAL_REVIEW_PHASE) return false;
  return lease?.scope === 'oauth'
    && lease.codeReceived === true
    && lease.targetAccepted !== true
    && (lease.effect?.kind === 'target_phone_validate' || job.phase === PHONE_MANUAL_REVIEW_PHASE);
}

function resetOAuthPhoneValidationTransaction(job, asset, error, options = {}) {
  const lease = job.sms?.current;
  const previous = job.oauthState;
  if (!lease || !previous) return null;
  const recovery = ensureOAuthPhoneValidationRecovery(job);
  const manual = options.manual === true;
  if (recovery.attempts >= OAUTH_PHONE_VALIDATION_RECOVERY_LIMIT && !manual) return null;
  const at = nowIso(options);
  const previousState = String(previous.oauth?.state || '');
  recovery.status = 'restarting';
  if (!manual) recovery.attempts += 1;
  recovery.manualRestarts = Number(recovery.manualRestarts || 0) + (manual ? 1 : 0);
  recovery.lastManualRestartAt = manual ? at : String(recovery.lastManualRestartAt || '');
  recovery.manualReviewRequired = false;
  recovery.reason = manual ? 'manual_phone_validation_reconciliation' : 'ambiguous_phone_validation';
  recovery.requestedAt = recovery.requestedAt || at;
  recovery.startedAt = at;
  recovery.completedAt = '';
  recovery.activationId = String(lease.activationId || lease.id || '');
  recovery.previousOAuthState = previousState;
  recovery.outcome = '';
  recovery.lastError = {
    code: String(error?.code || 'PHONE_VALIDATION_OUTCOME_UNKNOWN'),
    status: Number(error?.status || 0),
    message: String(error?.message || 'Phone validation response was lost'),
    at,
  };
  // The old code must never be submitted to the rebuilt transaction. Keep the
  // lease and its provider billing evidence until the new OAuth branch decides
  // whether it was accepted or must be replaced. Clearing only the code and
  // validation markers is deliberate: targetSent/providerMarkedSent describe
  // what happened at the provider and remain useful for billing/reconciliation.
  lease.effect = null;
  lease.cleanupAction = '';
  lease.cleanupReason = '';
  lease.code = '';
  lease.codeReceived = false;
  lease.codeReceivedAt = '';
  // `processPhoneLease` promotes the local status to `code_received` before
  // validation. The code is no longer reusable after a transaction rebuild,
  // so leave the old activation in a cancellable waiting state; otherwise a
  // crash in this checkpoint's failure cleanup is misread as phone success.
  lease.status = 'waiting';
  lease.targetAccepted = false;
  delete lease.targetAcceptedAt;
  delete lease.targetAcceptedInferred;
  delete lease.acceptedRunnerStep;
  lease.oauthValidationRecoveryAttempt = recovery.attempts;
  job.oauthState = rebuiltOAuthState(previous, asset || {}, options);
  job.phase = 'oauth';
  return {
    activationId: recovery.activationId,
    attempt: recovery.attempts,
    previousState,
    nextState: String(job.oauthState.oauth?.state || ''),
    at,
  };
}

async function resolveOAuthPhoneValidationRecovery(job, runnerState, context) {
  if (!oauthPhoneValidationRecoveryActive(job)) return;
  const recovery = ensureOAuthPhoneValidationRecovery(job);
  const step = String(runnerState?.step || '');
  const lease = job.sms?.current;
  const leaseIsPrevious = Boolean(
    lease
      && (!recovery.activationId || String(lease.activationId || lease.id || '') === recovery.activationId),
  );

  if (['phone_required', 'phone_otp_sent'].includes(step)) {
    if (leaseIsPrevious) {
      if (lease.targetAccepted) {
        // A crash may have persisted the old acceptance just before the fresh
        // OAuth state was checkpointed. Close that activation first, then let
        // the new transaction acquire its own number.
        await completePhoneLease(job, context);
      } else {
        lease.cleanupAction = 'cancel';
        lease.cleanupReason = 'oauth_phone_validation_recovery_requires_new_phone';
        const cleaned = await cleanupSms(job, context, lease.cleanupReason);
        if (!cleaned) {
          const error = new Error('The old SMS activation must be cancelled before requesting a replacement phone');
          error.code = 'SMS_CLEANUP_PENDING';
          throw preserveSmsError(error, SMS_CLEANUP_PHASE);
        }
      }
    }
    if (recovery.status !== 'replacing_phone') {
      recovery.status = 'replacing_phone';
      recovery.outcome = 'new_phone_required';
      recovery.completedAt = '';
      event(context.state, 'oauth_phone_validation_recovery_phone_required', {
        jobId: job.id,
        activationId: recovery.activationId,
        attempt: recovery.attempts,
        message: 'The rebuilt OAuth transaction still requires a phone; the uncertain activation was cancelled before acquiring a new number',
      }, context);
      await context.checkpoint('oauth_phone_validation_recovery_phone_required');
    }
    return;
  }

  if (!phoneStateAdvanced(runnerState)) return;
  if (lease && !leaseIsPrevious && lease.targetAccepted !== true) return;
  let outcome = 'previous_phone_accepted';
  if (leaseIsPrevious) {
    if (!lease.targetAccepted) {
      markPhoneAccepted(lease, runnerState, context, true);
      await context.checkpoint('oauth_phone_validation_recovery_accepted');
    }
    await completePhoneLease(job, context);
  } else if (lease?.targetAccepted === true) {
    await completePhoneLease(job, context);
    outcome = 'replacement_phone_accepted';
  }
  recovery.status = 'complete';
  recovery.outcome = outcome;
  recovery.completedAt = nowIso(context);
  event(context.state, 'oauth_phone_validation_recovery_completed', {
    jobId: job.id,
    activationId: recovery.activationId,
    attempt: recovery.attempts,
    outcome: recovery.outcome,
    message: outcome === 'previous_phone_accepted'
      ? 'The rebuilt OAuth transaction no longer requested a phone; the previous validation was treated as accepted and OAuth continued'
      : 'The replacement phone was accepted; OAuth continued after the activation was completed',
  }, context);
  await context.checkpoint('oauth_phone_validation_recovery_completed');
}

async function completeOAuthPhoneValidationRecovery(job, context, outcome) {
  const recovery = ensureOAuthPhoneValidationRecovery(job);
  if (recovery.status !== 'replacing_phone') return;
  recovery.status = 'complete';
  recovery.outcome = outcome;
  recovery.completedAt = nowIso(context);
  event(context.state, 'oauth_phone_validation_recovery_completed', {
    jobId: job.id,
    activationId: recovery.activationId,
    attempt: recovery.attempts,
    outcome,
    message: 'The rebuilt OAuth transaction required a phone and completed successfully with a fresh number',
  }, context);
  await context.checkpoint('oauth_phone_validation_recovery_completed');
}

async function exhaustOAuthPhoneValidationRecovery(job, error, context) {
  const recovery = ensureOAuthPhoneValidationRecovery(job);
  if (recovery.status === 'exhausted') return;
  recovery.status = 'exhausted';
  recovery.completedAt = '';
  recovery.outcome = 'still_uncertain';
  recovery.manualReviewRequired = true;
  recovery.lastError = {
    code: String(error?.code || 'PHONE_VALIDATION_OUTCOME_UNKNOWN'),
    status: Number(error?.status || 0),
    message: String(error?.message || 'Phone validation outcome remained uncertain'),
    at: nowIso(context),
  };
  event(context.state, 'oauth_phone_validation_recovery_exhausted', {
    jobId: job.id,
    activationId: recovery.activationId,
    attempts: recovery.attempts,
    message: 'The bounded OAuth phone-validation reconstruction budget is exhausted; automatic code replay is disabled until an operator resumes the job',
  }, context);
  await context.checkpoint('oauth_phone_validation_recovery_exhausted');
}

async function restartOAuthAfterAmbiguousPhoneValidation(job, worker, context, asset, error) {
  const restarted = resetOAuthPhoneValidationTransaction(job, asset, error, context);
  if (!restarted) {
    await exhaustOAuthPhoneValidationRecovery(job, error, context);
    return false;
  }
  event(context.state, 'oauth_phone_validation_recovery_started', {
    jobId: job.id,
    workerId: worker.id,
    activationId: restarted.activationId,
    attempt: restarted.attempt,
    previousState: restarted.previousState,
    nextState: restarted.nextState,
    code: smsErrorCode(error),
    message: 'OAuth phone validation returned no reliable result; a fresh OAuth transaction will determine whether the old phone was accepted',
  }, context);
  await context.checkpoint('oauth_phone_validation_recovery_started');
  return true;
}

async function restartExpiredOAuthAfterInventoryWait(job, asset, context) {
  const previous = job.oauthState;
  if (!previous || previous.step !== 'phone_required') return false;
  if (jobHasSmsContinuity(job)) return false;
  if (!job.sms?.lastInventoryError && Number(job.sms?.inventoryPollCount || 0) < 1) return false;
  const expiresAt = Date.parse(String(previous.oauth?.expiresAt || ''));
  if (!Number.isFinite(expiresAt) || expiresAt > nowMs(context)) return false;
  if (Number(job.oauthInventoryRestarts || 0) >= OAUTH_INVENTORY_RESTART_LIMIT) {
    if (job.oauthInventoryRestartExhausted !== true) {
      job.oauthInventoryRestartExhausted = true;
      event(context.state, 'oauth_inventory_wait_restart_exhausted', {
        jobId: job.id,
        attempts: Number(job.oauthInventoryRestarts || 0),
        previousExpiresAt: new Date(expiresAt).toISOString(),
        message: 'The OAuth transaction already used its inventory-wait reconstruction budget; it will be rebuilt when a number becomes available',
      }, context);
      await context.checkpoint('oauth_inventory_wait_restart_exhausted');
    }
    return false;
  }

  job.oauthState = rebuiltOAuthState(previous, asset, context);
  job.oauthInventoryRestarts = Number(job.oauthInventoryRestarts || 0) + 1;
  event(context.state, 'oauth_inventory_wait_restarted', {
    jobId: job.id,
    previousExpiresAt: new Date(expiresAt).toISOString(),
    attempt: job.oauthInventoryRestarts,
    message: 'The number wait outlived its unused OAuth transaction; authorization restarted without re-login or SMS acquisition',
  }, context);
  await context.checkpoint('oauth_inventory_wait_restarted');
  return true;
}

function oauthLoginRepairReason(error) {
  if (error?.code === 'OAUTH_LOGIN_REQUIRED') return 'oauth_login_required';
  if (error?.code === 'OAUTH_MFA_REQUIRED') return 'oauth_mfa_required';
  if (['OAUTH_ACCOUNT_SELECT_FAILED', 'OAUTH_ACCOUNT_SELECTION_REJECTED'].includes(error?.code)
    && (Number(error.status || 0) >= 500 || error.code === 'OAUTH_ACCOUNT_SELECTION_REJECTED')) {
    return 'oauth_account_session_rejected';
  }
  return '';
}

async function performOAuthLoginRepair(job, worker, context) {
  const recovery = ensureOAuthRecovery(job);
  const normalizedReason = oauthLoginRepairReason({
    code: recovery.reason,
    status: recovery.lastError?.status,
  });
  if (normalizedReason) recovery.reason = normalizedReason;
  if (!['pending', 'in_progress'].includes(recovery.status)) {
    throw Object.assign(new Error('OAuth login-state repair was not scheduled'), { code: 'OAUTH_LOGIN_REPAIR_NOT_SCHEDULED' });
  }

  if (recovery.status === 'pending') {
    recovery.status = 'in_progress';
    recovery.attempts += 1;
    recovery.startedAt = nowIso(context);
    recovery.completedAt = '';
    job.sessionState = null;
    job.oauthState = null;
    job.emailBoundary = null;
    job.emailMessageId = '';
    event(context.state, 'oauth_login_state_repair_started', {
      jobId: job.id,
      attempt: recovery.attempts,
      reason: recovery.reason,
      message: 'Refreshing the auth.openai.com login state before restarting Cockpit OAuth',
    }, context);
    await context.checkpoint('oauth_login_state_repair_started');
  }

  try {
    // A secured account signs back in with its own password, so the mailbox is
    // only a fallback for assets that never got one. Demanding a readable
    // mailbox up front used to strand exactly the accounts that needed it least.
    const asset = job.assetId ? context.assetStore.get(job.assetId) : null;
    if (!String(asset?.password || '').trim()) {
      const mail = await mailContextForJob(job, context);
      const mailbox = mailboxForEmail(mail.mailAccounts, job.email, job.mailboxId);
      if (!mailbox || mailbox.tokenValid === false) {
        const error = new Error(`No readable ${jobMailProvider(job, context) || primaryMailProvider(context) || 'Xiaopingguo'} mailbox is available to repair OAuth login state for ${job.email}`);
        error.code = 'OAUTH_REAUTH_MAILBOX_REQUIRED';
        error.retryable = true;
        error.waitPhase = 'waiting_oauth_login_repair';
        throw error;
      }
      job.mailboxId = mailbox.id;
      job.parentEmail = mailbox.email || job.parentEmail;
    }
    const repaired = await establishSession(job, worker, context, {
      forceOtp: true,
      existingOnly: true,
      sourceKind: 'oauth_reauth',
    });
    recovery.status = 'complete';
    recovery.completedAt = nowIso(context);
    recovery.lastError = null;
    event(context.state, 'oauth_login_state_repair_completed', {
      jobId: job.id,
      attempt: recovery.attempts,
      reason: recovery.reason,
      message: 'auth.openai.com login state refreshed; Cockpit OAuth will restart with new PKCE',
    }, context);
    await context.checkpoint('oauth_login_state_repair_completed');
    return repaired;
  } catch (error) {
    recovery.lastError = {
      code: String(error.code || 'OAUTH_LOGIN_REPAIR_FAILED'),
      status: Number(error.status || 0),
      ...(error.authPageType ? { authPageType: String(error.authPageType) } : {}),
      ...(error.authStep ? { authStep: String(error.authStep) } : {}),
    };
    if (['EMAIL_OTP_TIMEOUT', 'EMAIL_PROVIDER_TIMEOUT', 'OAUTH_REAUTH_MAILBOX_REQUIRED'].includes(error.code)) {
      error.retryable = true;
      error.waitPhase = 'waiting_oauth_login_repair';
    }
    await context.checkpoint('oauth_login_state_repair_incomplete');
    throw error;
  }
}

async function runOAuthAuthorization(job, worker, context, asset, source) {
  job.phase = 'oauth';
  job.oauthState = job.oauthState || oauthStateFromAsset(asset);
  await restartExpiredOAuthAfterInventoryWait(job, asset, context);
  const optionsForRunner = {
    proxy: worker.proxy?.url || '',
    signal: context.signal(),
    dynamicSentinel: context.config.registration.dynamicSentinel,
    solveCloudflare: cloudflareChallengeHandler(job, worker, context),
    checkpoint: async (reason, oauthState) => {
      job.oauthState = oauthState;
      job.phase = oauthState.step;
      await context.checkpoint(`oauth:${reason}`);
    },
    onEvent: (record) => event(context.state, record.type, { ...record, jobId: job.id, workerId: worker.id }, context),
  };
  const createRunner = () => typeof context.oauthRunnerFactory === 'function'
    ? context.oauthRunnerFactory({ har: context.har, job, worker, context, options: optionsForRunner })
    : new CockpitOAuthRunner(optionsForRunner);
  let runner = createRunner();
  await reconcileAcceptedPhoneCheckpoint(job, job.oauthState, context, 'oauth');
  await resolveOAuthPhoneValidationRecovery(job, job.oauthState, context);
  try {
    await runner.run(job.oauthState);
  } catch (error) {
    if (ambiguousOAuthPhoneValidationError(job, error)
      && await restartOAuthAfterAmbiguousPhoneValidation(job, worker, context, asset, error)) {
      return runOAuthAuthorization(job, worker, context, asset, source);
    }
    if (await restartInvalidatedOAuthContinuation(job, worker, context, asset, error)) {
      return runOAuthAuthorization(job, worker, context, asset, source);
    }
    const reason = source.kind === 'session_assets' ? oauthLoginRepairReason(error) : '';
    if (!reason || !queueOAuthLoginRepair(job, error, nowIso(context))) throw error;
    ensureOAuthRecovery(job).reason = reason;
    event(context.state, 'oauth_login_state_repair_scheduled', {
      jobId: job.id,
      reason,
      status: Number(error.status || 0),
      message: 'OAuth authorization rejected the saved auth-domain session; one login repair was scheduled',
    }, context);
    await context.checkpoint('oauth_login_state_repair_scheduled');
    asset = await performOAuthLoginRepair(job, worker, context);
    job.oauthState = oauthStateFromAsset(asset);
    await context.checkpoint('oauth_authorization_restarted_after_login_repair');
    runner = createRunner();
    await runner.run(job.oauthState);
  }
  await resolveOAuthPhoneValidationRecovery(job, job.oauthState, context);
  if (job.oauthState.step === 'phone_required' || job.oauthState.step === 'phone_otp_sent') {
    try {
      await handlePhoneChallenge(job, runner, job.oauthState, context, 'oauth');
      await completeOAuthPhoneValidationRecovery(job, context, 'replacement_phone_accepted');
    } catch (error) {
      if (ambiguousOAuthPhoneValidationError(job, error)
        && await restartOAuthAfterAmbiguousPhoneValidation(job, worker, context, asset, error)) {
        return runOAuthAuthorization(job, worker, context, asset, source);
      }
      if (!recoverableOAuthPhoneSendStateError(job, error)) throw error;
      const restarted = resetOAuthPhoneSendTransaction(job, asset, error, context);
      event(context.state, 'oauth_phone_transaction_restarted', {
        jobId: job.id,
        workerId: worker.id,
        activationId: restarted.activationId,
        attempt: restarted.attempt,
        code: smsErrorCode(error),
        message: 'OAuth phone transaction was rebuilt after a definitive pre-send authorization-state response; the same SMS lease will be reused',
      }, context);
      await context.checkpoint('oauth_phone_transaction_restarted');
      return runOAuthAuthorization(job, worker, context, asset, source);
    }
  }
  if (job.oauthState.step !== 'complete') {
    try {
      await runner.run(job.oauthState);
    } catch (error) {
      if (!await restartInvalidatedOAuthContinuation(job, worker, context, asset, error)) throw error;
      return runOAuthAuthorization(job, worker, context, asset, source);
    }
  }
  if (job.oauthState.step !== 'complete' || !job.oauthState.account) throw new Error('Cockpit OAuth did not produce a CPA account');
  await settleSmsBeforeJobCompletion(job, context);
  const saved = context.assetStore.replaceCpa(asset.id, job.oauthState.account, {
    runId: context.state.runId,
    jobId: job.id,
    completionStatus: 'complete',
  });
  job.cpaPath = saved.cpa.path;
  job.cpaRevision = saved.cpa.revision;
  job.status = 'complete';
  job.phase = 'complete';
  job.result = 'cpa_saved';
  await context.checkpoint('cpa_saved');
}

/**
 * A credentials/login-state run that stops at the login: the session is
 * verified and saved as a login-state asset, and no OAuth is attempted.
 */
function oauthRunIsLoginOnly(state = {}) {
  const plan = state.runPlan || state.plan || {};
  return String(state.taskKind || plan.taskKind || '') === 'oauth'
    && plan.oauthSource?.loginOnly === true;
}

async function runLoginOnlyJob(job, worker, context, source) {
  const asset = await establishSession(job, worker, context, {
    // Same login as the OAuth path: credentials always sign in fresh with the
    // password; a saved login state is validated (and repaired by email OTP).
    forceOtp: source.kind === 'credentials',
    existingOnly: true,
    security: {},
    sourceKind: source.kind === 'credentials' ? 'oauth_credentials' : 'oauth_session',
  });
  await settleSmsBeforeJobCompletion(job, context);
  job.status = 'complete';
  job.phase = 'complete';
  job.result = source.kind === 'credentials' ? 'session_saved' : 'session_refreshed';
  job.sessionAssetId = asset.id;
  await context.checkpoint('login_only_session_saved');
}

async function runOAuthJob(job, worker, context) {
  const source = context.plan.oauthSource || { kind: 'register_oauth' };
  const combinedRegistration = context.state.taskKind === 'register_oauth';
  if (!combinedRegistration && source.loginOnly === true) {
    await runLoginOnlyJob(job, worker, context, source);
    return;
  }
  assertOAuthAssetNotCooling(context, job.assetId || job.sessionAssetId);
  const recovery = ensureOAuthRecovery(job);
  const oauthAlreadyStarted = canReuseSessionForOAuthContinuation(job);
  let asset;
  if (source.kind === 'session_assets' && ['pending', 'in_progress'].includes(recovery.status)) {
    asset = await performOAuthLoginRepair(job, worker, context);
  } else {
    asset = await establishSession(job, worker, context, {
      // A credentials source has no saved session to reuse and no mailbox to
      // fall back on, so it always signs in fresh — with the password.
      forceOtp: combinedRegistration || source.kind === 'credentials',
      existingOnly: !combinedRegistration,
      security: combinedRegistration ? context.plan.security : {},
      reuseVerifiedSession: oauthAlreadyStarted,
      sourceKind: combinedRegistration
        ? 'register_oauth'
        : (source.kind === 'credentials' ? 'oauth_credentials' : 'oauth_session'),
    });
  }
  await runOAuthAuthorization(job, worker, context, asset, source);
}

/**
 * Puts the pending security work back into a retryable state.
 *
 * Shared by the in-run retry and by an operator resume so the two cannot drift:
 * both need the same statuses set before the job is run again.
 */
function armSecurityRetry(job) {
  const security = job.sessionState?.security;
  if (!security) return false;
  const failures = security.failures || [];
  const passwordFailure = failures.find((failure) => failure.feature === 'password' && retryablePersistedSecurityFailure(failure));
  const totpFailure = failures.find((failure) => failure.feature === 'totp' && retryablePersistedSecurityFailure(failure));
  if (passwordFailure) {
    security.passwordStatus = 'retry_pending';
    security.passwordTransaction = {
      ...(security.passwordTransaction || {}),
      step: 'retry_pending',
      lastError: { code: passwordFailure.code || 'PASSWORD_SETUP_FAILED', retryable: true },
    };
  }
  if (totpFailure) security.totpStatus = 'retry_pending';
  return Boolean(passwordFailure || totpFailure);
}

/**
 * Turns a `partial` result back into scheduled work.
 *
 * The account is already registered and saved at this point, so this is pure
 * upside: it finishes the optional security setup without waiting for someone
 * to resume the run. A failure that is not transport-shaped is left alone —
 * retrying it would just fail the same way.
 */
async function scheduleSecurityRetry(job, worker, context) {
  const security = job.sessionState?.security;
  const emailFailure = (security?.failures || []).find(failure => failure.feature === 'password'
    && security.passwordStatus !== 'configured' && require('./transport-errors').isEmailDeliveryFailure(failure));
  if (emailFailure) {
    const limit = retryPolicyForWait(SECURITY_EMAIL_RETRY_PHASE, context).maxRetries;
    // This counter survives operator/platform resumes and is separate from
    // network retries. An empty inbox is not evidence of a bad proxy.
    if (Number(job.securityEmailRetries || 0) >= limit) {
      job.securityEmailExhausted = true;
      return false;
    }
    if (!await scheduleRetryForWait(job, SECURITY_EMAIL_RETRY_PHASE, worker, context, emailFailure)) return false;
    job.securityEmailRetries = Number(job.securityEmailRetries || 0) + 1;
    security.passwordStatus = 'retry_pending';
    security.passwordTransaction = { ...(security.passwordTransaction || {}), step: 'retry_pending', emailBoundary: null };
    job.status = 'waiting';
    job.phase = SECURITY_EMAIL_RETRY_PHASE;
    job.completedAt = '';
    event(context.state, 'security_mail_retry_scheduled', {
      jobId: job.id, attempt: job.securityEmailRetries, maxRetries: limit,
      message: 'Password email code did not arrive; retrying this mailbox within its separate delivery budget',
    }, context);
    return true;
  }
  if (!armSecurityRetry(job)) return false;
  if (!await scheduleRetryForWait(job, SECURITY_RETRY_PHASE, worker, context, null)) return false;
  job.status = 'waiting';
  job.phase = SECURITY_RETRY_PHASE;
  job.completedAt = '';
  event(context.state, 'security_setup_retry_scheduled', {
    jobId: job.id,
    workerId: worker?.id || '',
    nextRunAt: job.nextRunAt,
    attempt: Number(job.retry?.attempts || 0),
    message: 'Optional security setup failed on transport; it will be retried in-run',
  }, context);
  return true;
}

function scheduleSecurityProxyRotation(job, worker, context) {
  if (!job?.sessionState || !['register_session', 'session_refresh'].includes(context.state.taskKind)) return false;
  const failures = job.sessionState.security?.failures || [];
  const failure = [...failures].reverse().find((candidate) => retryablePersistedSecurityFailure(candidate));
  if (!failure) return false;
  const proxyId = String(worker?.proxyId || job.proxyId || '');
  if (!proxyId) return false;
  const error = {
    code: String(failure.code || 'SECURITY_TRANSPORT_FAILURE'),
    message: String(failure.message || 'Optional security request failed over the bound proxy'),
    retryable: true,
  };
  if (!boundMaintenanceProxy(job, worker, context)) {
    const health = markProxyFailed(context.state, proxyId, error, nowIso(context), {
      reason: 'security_transport_failure',
    });
    if (!health) return false;
    event(context.state, 'worker_proxy_rejected', {
      workerId: worker.id,
      jobId: job.id,
      proxyId,
      code: error.code,
      reason: 'security_transport_failure',
      message: 'Optional security transport failed; the retry will bind a new exit',
    }, context);
    unbindWorkerProxy(worker, job, context, {
      ban: true,
      code: error.code,
      reason: 'security_transport_failure',
    });
  }
  return true;
}

function jobHasSmsContinuity(job) {
  return Boolean(job.sms?.current || job.sms?.acquisition);
}

function createdAccountCallbackPending(job = {}) {
  const state = job.sessionState || {};
  const created = state.accountCreated === true
    || Boolean(job.accountCreatedAt)
    || job.error?.accountCreated === true;
  return created && String(state.step || '') === 'auth_callback_pending';
}

/**
 * Callback failures worth replaying on the same or another exit: the request
 * never got an answer, so its code may still be unused. An error page is not
 * one of them — see `callbackCodeSpent`.
 */
function authCallbackProxyFailure(error = {}) {
  return error.cloudflareChallenge === true
    || error.proxyFailure === true
    || proxyRuntimeTransportFailure(error);
}

function canRestartOAuthAfterProxyChange(job) {
  return Boolean(job.oauthState)
    && !jobHasSmsContinuity(job)
    && !job.cpaPath
    && job.sessionState?.step === 'verified'
    && ['valid', 'partial'].includes(String(job.sessionState?.status || ''));
}

/**
 * True once the attempt has state that a proxy change could damage.
 *
 * This is the line between the operator's two rules: before it, a bad exit is
 * simply swapped and the attempt restarts for free; after it, the exit gets a
 * couple of retries because throwing the attempt away costs a mailbox and
 * possibly a paid number.
 */
function registrationInFlight(job) {
  return jobHasSmsContinuity(job)
    || Boolean(job.accountCreatedAt)
    || Boolean(job.sessionAssetId)
    || Boolean(job.sessionState?.accountCreated)
    || String(job.sessionState?.step || 'initial') !== 'initial';
}

/**
 * True when the account transaction is finished and only optional follow-up
 * work is left.
 *
 * Such a job may move to a different exit freely: the session asset is already
 * saved, so there is no half-written account for an IP change to damage. Without
 * this the continuity guard would fire during a security retry and — now that
 * the guard has an escape hatch — trigger a pointless full re-registration.
 */
function canRebindProxyForFollowUpWork(job) {
  return !jobHasSmsContinuity(job)
    && Boolean(job.sessionAssetId)
    && String(job.sessionState?.step || '') === 'verified';
}

function canRestartEarlySessionAfterProxyChange(job) {
  const step = String(job.sessionState?.step || 'initial');
  return !jobHasSmsContinuity(job)
    && !job.accountCreatedAt
    && !job.sessionAssetId
    && !job.sessionState?.accountCreated
    && step === 'initial';
}

function restartEarlySessionForProxy(job, context) {
  // Starting over on a fresh exit means the old Worker has no claim left;
  // keeping the pin would send the restarted attempt back to the same lane.
  if (job.workerAffinity) job.workerAffinity.workerId = '';
  job.sessionVerifiedAt = '';
  const previous = job.sessionState || {};
  job.sessionState = makeInitialChatGptSessionState({
    email: job.email,
    clientProfile: previous.clientProfile,
    oaiDid: previous.oaiDid,
    password: previous.password,
    totpSecret: previous.totpSecret,
  });
  invalidateSharedEmailBoundaryCache(job, context);
  job.emailBoundary = null;
  job.emailMessageId = '';
}

function requiresFreshEmailOtpAfterProxyChange(job = {}) {
  const state = job.sessionState || {};
  const otpRecovery = String(state.emailOtpSendRecovery?.status || '');
  if (['uncertain', 'reconciling', 'retrying'].includes(otpRecovery)) return true;
  if (state.createAccountAttempt?.status === 'uncertain') return true;
  // A new proxy means a new auth transaction. An email code validated in the
  // old transaction is not a portable credential for the replacement one.
  return ['email_otp_sent', 'email_otp_validated'].includes(String(state.step || ''));
}

function restartEmailOtpSessionForProxy(job, context) {
  const previous = job.sessionState || {};
  const restarted = makeInitialChatGptSessionState({
    email: job.email,
    clientProfile: previous.clientProfile,
    oaiDid: previous.oaiDid,
    password: previous.password,
    totpSecret: previous.totpSecret,
  });
  // Keep the single validation-retry budget and an uncertain create_account
  // marker. If the first create request actually succeeded, the fresh flow can
  // reconcile the resulting USER_ALREADY_EXISTS instead of creating again.
  restarted.emailOtpValidationRetries = Number(previous.emailOtpValidationRetries || 0);
  if (previous.createAccountAttempt?.status === 'uncertain') {
    restarted.createAccountAttempt = {
      ...previous.createAccountAttempt,
      status: 'uncertain',
      recoveryReason: 'proxy_context_rebuilt',
    };
  }
  job.sessionState = restarted;
  invalidateSharedEmailBoundaryCache(job, context);
  job.emailBoundary = null;
  job.emailMessageId = '';
  return restarted;
}

function rebuildAuthCallbackSessionForProxy(job, context, previousProxyId = '', proxyId = '') {
  if (!createdAccountCallbackPending(job)) return false;
  const previous = job.sessionState || {};
  const callbackUrl = String(previous.pendingAuthCallbackUrl || previous.continueUrl || '');
  const rebuilt = {
    ...previous,
    cookieJar: clone(previous.cookieJar),
    step: 'auth_callback_pending',
    status: 'running',
    accountCreated: true,
    accountCreatedAt: String(previous.accountCreatedAt || job.accountCreatedAt || nowIso(context)),
    pendingAuthCallbackUrl: callbackUrl,
  };
  job.sessionState = rebuilt;
  job.accountCreatedAt = job.accountCreatedAt || rebuilt.accountCreatedAt;
  job.sessionVerifiedAt = '';
  const recovery = ensureAuthCallbackProxyRecovery(job);
  recovery.currentProxyId = String(proxyId || '');
  recovery.attemptsOnProxy = 0;
  recovery.rebuildPending = false;
  recovery.previousProxyId = String(previousProxyId || recovery.previousProxyId || '');
  recovery.rebuildBlocked = false;
  event(context.state, 'auth_callback_proxy_context_rebuilt', {
    jobId: job.id,
    previousProxyId: String(previousProxyId || ''),
    proxyId: String(proxyId || ''),
    callbackUrlPreserved: Boolean(callbackUrl),
    cookieJarPreserved: Boolean(rebuilt.cookieJar),
    message: 'The account already exists; a fresh callback request context was rebuilt on the replacement proxy',
  }, context);
  return true;
}

async function bindJobWorkerAffinity(job, worker, context) {
  const previous = job.workerAffinity && typeof job.workerAffinity === 'object'
    ? job.workerAffinity
    : {};
  const previousWorkerId = String(previous.workerId || '');
  const previousProxyId = String(previous.proxyId || job.proxyId || '');
  const currentProxyId = String(worker.proxyId || '');
  const callbackPending = createdAccountCallbackPending(job);
  const callbackRecovery = callbackPending ? ensureAuthCallbackProxyRecovery(job) : null;

  if (previousWorkerId && previousWorkerId !== worker.id) {
    // `workerMatchesJobAffinity` lets a different Worker take a job that has
    // nothing durable behind it, so this has to rebind rather than throw —
    // the two guards disagreeing is what turned an idle-Worker optimisation
    // into JOB_WORKER_AFFINITY_VIOLATION failures on a live run.
    if (!canRestartEarlySessionAfterProxyChange(job) && !callbackPending) {
      const error = new Error(`Job ${job.id} is bound to ${previousWorkerId}, not ${worker.id}`);
      error.code = 'JOB_WORKER_AFFINITY_VIOLATION';
      throw error;
    }
    event(context.state, 'job_worker_affinity_reassigned', {
      jobId: job.id,
      fromWorkerId: previousWorkerId,
      workerId: worker.id,
      message: callbackPending
        ? 'The account callback checkpoint was preserved, so an idle Worker picked it up for proxy recovery'
        : 'The job had no durable state, so an idle Worker picked it up instead of waiting',
    }, context);
    previous.workerId = '';
    previous.proxyId = '';
  }

  let reason = previousWorkerId ? '' : 'initial_job_binding';
  if (previousProxyId && previousProxyId !== currentProxyId) {
    if (callbackPending) {
      rebuildAuthCallbackSessionForProxy(job, context, previousProxyId, currentProxyId);
      reason = 'auth_callback_proxy_context_rebuilt';
    } else if (!jobHasSmsContinuity(job)
      && (callbackLoginInFlight(job)
        || openLoginRecoveryForCreatedAccount(job, context, 'CALLBACK_CONTINUATION_UNAVAILABLE', 'proxy_rebound'))) {
      restartCallbackLoginSessionForProxy(job, context, 'proxy_rebound');
      reason = 'callback_login_restarted_after_proxy_change';
      event(context.state, 'callback_login_proxy_context_restarted', {
        jobId: job.id,
        workerId: worker.id,
        previousProxyId,
        proxyId: currentProxyId,
        message: 'The callback re-login moved to another exit; it starts a fresh login there instead of carrying the old transaction',
      }, context);
    } else if (canRestartOAuthAfterProxyChange(job)) {
      job.oauthState = null;
      reason = 'oauth_restarted_after_proxy_change';
      event(context.state, 'oauth_proxy_context_restarted', {
        jobId: job.id,
        workerId: worker.id,
        previousProxyId,
        proxyId: currentProxyId,
        message: 'The proxy changed before any SMS lease existed; OAuth will restart with fresh PKCE on the new proxy',
      }, context);
    } else if (canRebindProxyForFollowUpWork(job)) {
      reason = 'follow_up_work_rebound_after_proxy_change';
      event(context.state, 'security_proxy_context_rebound', {
        jobId: job.id,
        workerId: worker.id,
        previousProxyId,
        proxyId: currentProxyId,
        message: 'The account is already saved and only optional security work remains, so a different exit is safe',
      }, context);
    } else if (canRestartEarlySessionAfterProxyChange(job)) {
      restartEarlySessionForProxy(job, context);
      reason = 'session_restarted_after_proxy_change';
      event(context.state, 'session_proxy_context_restarted', {
        jobId: job.id,
        workerId: worker.id,
        previousProxyId,
        proxyId: currentProxyId,
        message: 'The proxy changed before the account flow became durable; the initial session was rebuilt safely',
      }, context);
    } else {
      const error = new Error('The original proxy context is unavailable for this in-progress account transaction');
      error.code = 'JOB_PROXY_CONTINUITY_REQUIRED';
      error.retryable = true;
      error.waitPhase = 'waiting_proxy_continuity';
      if (jobHasSmsContinuity(job)) throw preserveSmsError(error, 'waiting_proxy_continuity');
      throw error;
    }
  }

  if (callbackPending && callbackRecovery?.rebuildPending && currentProxyId) {
    rebuildAuthCallbackSessionForProxy(
      job,
      context,
      callbackRecovery.previousProxyId,
      currentProxyId,
    );
    reason = 'auth_callback_proxy_context_rebuilt';
  }

  const at = nowIso(context);
  job.workerAffinity = {
    workerId: worker.id,
    proxyId: currentProxyId,
    boundAt: String(previous.boundAt || at),
    updatedAt: at,
  };
  job.proxy = clone(worker.proxy);
  job.proxyId = currentProxyId;
  if (callbackPending) {
    const recovery = ensureAuthCallbackProxyRecovery(job);
    recovery.currentProxyId = currentProxyId;
  }
  if (reason) await context.checkpoint(reason);
}

function retryPolicyForWait(phase, context) {
  const base = (context?.retryPolicies || RETRY_POLICIES)[phase];
  if (!base) return null;
  if (context?.retryPolicies) return base;
  return { ...base, ...context?.config?.retryPolicy?.[phase] };
}

function retryDelayMs(policy, attempt, context) {
  const delays = policy.delaysMs;
  const base = Number(delays[Math.min(Math.max(1, attempt) - 1, delays.length - 1)] || 0);
  const configuredJitter = Number(policy.jitterRatio);
  const jitterRatio = Number.isFinite(configuredJitter)
    ? Math.max(0, configuredJitter)
    : RETRY_JITTER_RATIO;
  const spread = base * jitterRatio;
  const random = typeof context.random === 'function' ? context.random() : Math.random();
  return Math.max(0, Math.round(base - spread + (random * spread * 2)));
}

/** Drop the bound exit so the next bind takes a fresh one. */
function unbindWorkerProxy(worker, job, context, options = {}) {
  const proxyId = String(worker?.proxyId || job.proxyId || '');
  if (!proxyId) return '';
  const maintenance = boundMaintenanceProxy(job, worker, context)
    || maintenanceProxyForState(context.state, proxyId, worker?.proxy || job?.proxy);
  if (maintenance) {
    const previous = context.state.proxyHealth?.[proxyId] || {};
    context.state.proxyHealth = context.state.proxyHealth || {};
    context.state.proxyHealth[proxyId] = {
      ...previous,
      status: 'healthy',
      reason: '',
      maintenanceLastFailureAt: previous.maintenanceLastFailureAt || '',
      maintenanceLastFailureCode: previous.maintenanceLastFailureCode || '',
    };
  } else if (options.ban === true) {
    context.state.proxyHealth = context.state.proxyHealth || {};
    context.state.proxyHealth[proxyId] = {
      ...(context.state.proxyHealth[proxyId] || {}),
      status: 'failed',
      reason: options.reason || 'proxy_unusable',
      lastFailureAt: nowIso(context),
      lastFailureCode: String(options.code || 'PROXY_UNUSABLE'),
    };
  } else {
    markProxyFailed(
      context.state,
      proxyId,
      { code: options.code || 'PROXY_TRANSPORT_FAILURE' },
      nowIso(context),
      { reason: options.reason || 'runtime_transport_failure' },
    );
  }
  if (worker) releaseBranchWorkerProxy(worker, context, options.reason || 'proxy_unusable');
  job.proxy = null;
  job.proxyId = '';
  if (job.workerAffinity) {
    // Cleared so bindJobWorkerAffinity does not read this as a mid-transaction
    // proxy change and refuse to continue.
    job.workerAffinity.proxyId = '';
    job.workerAffinity.updatedAt = nowIso(context);
  }
  return proxyId;
}


/**
 * Throws away a half-finished attempt and rebuilds it on a different exit.
 *
 * Used when a proxy fault has outlived its retries mid-registration. Any paid
 * number is released first, and the rebuild is abandoned if it cannot be —
 * a lease with an unresolved send is ambiguous, and stranding a consumed
 * number is worse than parking for an operator. The account row, if one was
 * already created, is left alone: the rerun detects it and recovers through
 * the passwordless login path instead of creating a duplicate.
 */
async function restartRegistrationOnFreshExit(job, worker, context) {
  if (jobHasSmsContinuity(job) && !await cleanupSms(job, context, 'proxy_restart')) return false;
  const callbackPending = createdAccountCallbackPending(job);
  const callbackRecovery = callbackPending ? ensureAuthCallbackProxyRecovery(job) : null;
  const previousCallbackProxyId = String(worker?.proxyId || job.proxyId || callbackRecovery?.currentProxyId || '');
  const proxyId = unbindWorkerProxy(worker, job, context, { code: 'PROXY_RESTART', reason: 'registration_restart' });
  const createdAccount = Boolean(
    job.accountCreatedAt
      || job.sessionState?.accountCreated
      || job.error?.accountCreated === true,
  );
  let freshEmailOtp = false;
  let previousEmailStep = '';
  if (createdAccount && !callbackPending) {
    // Nothing to preserve: no callback was ever received for this account.
    openLoginRecoveryForCreatedAccount(job, context, 'CALLBACK_CONTINUATION_UNAVAILABLE', 'fresh_exit_restart');
  }
  const loginRebuilt = createdAccount && callbackLoginInFlight(job);
  if (loginRebuilt) {
    // Mid re-login: there is no callback to preserve yet, and the login's
    // transaction and Sentinel identity are tied to the dead exit.
    restartCallbackLoginSessionForProxy(job, context, 'fresh_exit_restart');
  } else if (createdAccount) {
    // The account row is already durable upstream. Keep the callback
    // continuation and cookies so the new exit can finish that account rather
    // than starting a second signup and asking the same mailbox for another
    // OTP. The next runner pass knows how to resume auth_callback_pending.
    job.accountCreatedAt = job.accountCreatedAt || nowIso(context);
    if (job.sessionState) job.sessionState.accountCreated = true;
    job.sessionVerifiedAt = '';
  } else if (requiresFreshEmailOtpAfterProxyChange(job)) {
    // The old authorization transaction is tied to the previous exit. Start a
    // fresh transaction and request a fresh code instead of carrying an OTP
    // validation across the proxy boundary.
    const previousStep = String(job.sessionState?.step || '');
    previousEmailStep = previousStep;
    freshEmailOtp = true;
    restartEmailOtpSessionForProxy(job, context);
    job.emailOtpRecovery = {
      action: 'fresh_code',
      previousStep,
      at: nowIso(context),
    };
    job.sessionVerifiedAt = '';
  } else {
    restartEarlySessionForProxy(job, context);
  }
  job.oauthState = null;
  job.freshExitRestarts = Number(job.freshExitRestarts || 0) + 1;
  if (callbackRecovery) {
    callbackRecovery.currentProxyId = '';
    callbackRecovery.attemptsOnProxy = 0;
    callbackRecovery.proxyChanges = Math.max(
      callbackRecovery.proxyChanges,
      Number(job.freshExitRestarts || 0),
    );
    callbackRecovery.rebuildPending = true;
    callbackRecovery.previousProxyId = previousCallbackProxyId || proxyId;
    callbackRecovery.rebuildBlocked = false;
  }
  event(context.state, 'registration_restarted_on_fresh_exit', {
    jobId: job.id,
    workerId: worker?.id || '',
    proxyId,
    email: job.email,
    createdAccount,
    freshEmailOtp,
    ...(callbackRecovery ? {
      callbackProxyChanges: callbackRecovery.proxyChanges,
      callbackContextRebuildPending: true,
    } : {}),
    ...(freshEmailOtp ? { previousStep: previousEmailStep } : {}),
    ...(loginRebuilt ? { callbackLoginRebuilt: true } : {}),
    message: loginRebuilt
      ? 'Proxy retries were exhausted during the callback re-login; the login restarts from scratch on the new exit'
      : createdAccount
      ? 'Proxy retries were exhausted after account creation; the callback checkpoint is preserved for this mailbox'
      : job.emailOtpRecovery?.action === 'fresh_code'
        ? `Proxy retries were exhausted at ${String(job.emailOtpRecovery.previousStep || 'email verification')}; the auth transaction was rebuilt and a fresh email OTP will be requested`
      : 'Proxy retries were exhausted mid-registration; the attempt restarts for this mailbox on a new exit',
  }, context);
  return true;
}

function callbackProxyRetryPolicy(context) {
  return retryPolicyForWait(PROXY_RETRY_PHASE, context) || {
    delaysMs: [2000, 2000],
    maxRetries: AUTH_CALLBACK_PROXY_RETRY_LIMIT,
    jitterRatio: RETRY_JITTER_RATIO,
  };
}

function callbackProxyRotationPolicy(context) {
  return retryPolicyForWait(PROXY_ROTATION_PHASE, context) || {
    delaysMs: [PROXY_ROTATION_CYCLE_DELAY_MS],
    maxRetries: 1,
    jitterRatio: 0,
  };
}

/**
 * Retry only the saved NextAuth callback checkpoint.
 *
 * The generic transport recovery is intentionally one-shot. A callback that
 * runs after account creation needs a different budget: two retries on the
 * current exit, then a rebuilt request context on a new exit, up to two exit
 * changes. Resetting `job.retry` at the rotation boundary is important: the
 * first attempt on the new exit must not be counted as a retry from the old
 * exit.
 */
/**
 * A NextAuth `OAuthCallback` error page means the authorization code in the
 * saved callback URL is spent: the first request reached OpenAI (often while
 * our side timed out) and consumed it. Replaying that URL can only return the
 * same page — one account on 2026-10-10 burned five exits and five minutes on
 * eight such replays. A fresh login issues a new code, so the account gets one
 * of those instead, on the same Worker and exit.
 */
function callbackCodeSpent(job, error) {
  return error?.code === 'AUTH_CALLBACK_ERROR_PAGE' && createdAccountCallbackPending(job);
}

async function startCallbackLoginRecovery(job, worker, context, error) {
  const previous = job.sessionState || {};
  const restarted = makeInitialChatGptSessionState({
    email: job.email,
    clientProfile: previous.clientProfile,
    oaiDid: previous.oaiDid,
    password: previous.password,
    totpSecret: previous.totpSecret,
  });
  // The password was set during registration; keep that so security setup
  // does not try to set it a second time after the login.
  restarted.security = clone(previous.security || {});
  job.sessionState = restarted;
  job.sessionVerifiedAt = '';
  invalidateSharedEmailBoundaryCache(job, context);
  job.emailBoundary = null;
  job.emailMessageId = '';
  job.callbackLoginRecovery = {
    status: 'pending',
    startedAt: nowIso(context),
    causeCode: String(error?.code || 'AUTH_CALLBACK_ERROR_PAGE'),
    causeReason: String(error?.callbackErrorReason || ''),
  };
  const recovery = ensureAuthCallbackProxyRecovery(job);
  recovery.exhausted = false;
  recovery.rebuildPending = false;
  job.retry = null;
  job.nextRunAt = '';
  job.completedAt = '';
  job.status = 'queued';
  job.phase = 'callback_login_recovery';
  event(context.state, 'auth_callback_login_recovery_started', {
    jobId: job.id,
    workerId: worker?.id || '',
    proxyId: String(worker?.proxyId || job.proxyId || ''),
    reason: job.callbackLoginRecovery.causeReason,
    message: 'The callback code is spent; signing in again once to get a new one',
  }, context);
  await context.checkpoint('auth_callback_login_recovery_started');
}

/**
 * The callback re-login is a login transaction like any other: once the exit
 * changes, its NextAuth state and Sentinel identity belong to the old exit.
 * Keeping them (the account-created "preserve the callback" path) only made
 * every later request fail with SENTINEL_PROXY_IDENTITY_CHANGED. Until the
 * login reaches its own callback, a proxy change rebuilds the login instead.
 */
const MAX_CALLBACK_LOGIN_SESSION_REBUILDS = 3;

function callbackLoginInFlight(job = {}) {
  if (job.callbackLoginRecovery?.status !== 'pending') return false;
  const step = String(job.sessionState?.step || '');
  return !['verified', 'auth_callback_pending'].includes(step);
}

/**
 * The account exists upstream but this job holds no callback to finish it
 * with: create_account answered 500 and its retry said USER_ALREADY_EXISTS, so
 * the continuation was never received; or the exit changed before the
 * callback. The same fresh login that replaces a spent callback code finishes
 * these too.
 */
function createdAccountWithoutCallback(job = {}, error = null) {
  const state = job.sessionState || {};
  const created = state.accountCreated === true
    || Boolean(job.accountCreatedAt)
    || error?.accountCreated === true;
  if (!created) return false;
  return !['auth_callback_pending', 'verified'].includes(String(state.step || ''));
}

const LOGIN_RECOVERABLE_CREATED_ACCOUNT_CODES = new Set([
  'AUTH_CONTINUATION_MISSING',
  'AUTH_CONTINUATION_LIMIT',
  'SENTINEL_PROXY_IDENTITY_CHANGED',
]);

/** Opens a callback re-login for a created account that has no callback. */
function openLoginRecoveryForCreatedAccount(job, context, causeCode, causeReason = '') {
  if (job.callbackLoginRecovery || !createdAccountWithoutCallback(job)) return false;
  job.callbackLoginRecovery = {
    status: 'pending',
    startedAt: nowIso(context),
    causeCode: String(causeCode || 'CALLBACK_CONTINUATION_UNAVAILABLE'),
    causeReason: String(causeReason || ''),
  };
  return true;
}

function restartCallbackLoginSessionForProxy(job, context, reason = 'proxy_changed') {
  const previous = job.sessionState || {};
  const restarted = makeInitialChatGptSessionState({
    email: job.email,
    clientProfile: previous.clientProfile,
    oaiDid: previous.oaiDid,
    password: previous.password,
    totpSecret: previous.totpSecret,
  });
  restarted.security = clone(previous.security || {});
  restarted.emailOtpValidationRetries = Number(previous.emailOtpValidationRetries || 0);
  job.sessionState = restarted;
  job.sessionVerifiedAt = '';
  invalidateSharedEmailBoundaryCache(job, context);
  job.emailBoundary = null;
  job.emailMessageId = '';
  const recovery = job.callbackLoginRecovery;
  recovery.sessionRebuilds = Number(recovery.sessionRebuilds || 0) + 1;
  recovery.lastRebuildAt = nowIso(context);
  recovery.lastRebuildReason = String(reason || '');
  return restarted;
}

async function scheduleAuthCallbackProxyRetry(job, worker, context, error) {
  const retryPolicy = callbackProxyRetryPolicy(context);
  const rotationPolicy = callbackProxyRotationPolicy(context);
  const recovery = ensureAuthCallbackProxyRecovery(job);
  const currentProxyId = String(worker?.proxyId || job.proxyId || recovery.currentProxyId || '');
  const previous = isPlainRetryState(job.retry) && job.retry.phase === PROXY_RETRY_PHASE
    ? job.retry
    : null;
  const maxRetries = Number.isFinite(Number(retryPolicy.maxRetries))
    ? Math.max(0, Number(retryPolicy.maxRetries))
    : AUTH_CALLBACK_PROXY_RETRY_LIMIT;
  const attempts = Number(previous?.attempts || 0) + 1;
  const at = nowIso(context);

  recovery.currentProxyId = currentProxyId;
  recovery.lastFailureAt = at;
  recovery.lastFailureCode = String(error?.code || 'AUTH_CALLBACK_FAILURE');
  recovery.exhausted = false;
  recovery.rebuildBlocked = false;

  if (attempts <= maxRetries) {
    recovery.attemptsOnProxy = attempts;
    job.retry = {
      phase: PROXY_RETRY_PHASE,
      attempts,
      firstAt: previous?.firstAt || at,
      restarted: false,
    };
    const delayMs = Math.max(
      retryDelayMs(retryPolicy, attempts, context),
      Number(error?.retryAfterMs || 0),
    );
    job.nextRunAt = new Date(nowMs(context) + delayMs).toISOString();
    job.status = 'waiting';
    job.phase = PROXY_RETRY_PHASE;
    event(context.state, 'auth_callback_proxy_retry_scheduled', {
      jobId: job.id,
      workerId: worker?.id || '',
      proxyId: currentProxyId,
      attempt: attempts,
      maxRetries,
      proxyChanges: Math.max(recovery.proxyChanges, Number(job.freshExitRestarts || 0)),
      delayMs,
      nextRunAt: job.nextRunAt,
      code: recovery.lastFailureCode,
      message: 'The saved authentication callback will be retried on the current proxy',
    }, context);
    return { scheduled: true, rotated: false, exhausted: false };
  }

  const proxyChanges = Math.max(
    recovery.proxyChanges,
    Number(job.freshExitRestarts || 0),
  );
  if (proxyChanges >= MAX_AUTH_CALLBACK_PROXY_CHANGES) {
    recovery.proxyChanges = proxyChanges;
    recovery.attemptsOnProxy = attempts;
    recovery.exhausted = true;
    return { scheduled: false, rotated: false, exhausted: true };
  }

  const previousProxyId = currentProxyId || recovery.currentProxyId;
  const rebuilt = await restartRegistrationOnFreshExit(job, worker, context);
  if (!rebuilt) {
    recovery.rebuildBlocked = true;
    return { scheduled: false, rotated: false, exhausted: false };
  }

  recovery.proxyChanges = Math.max(
    recovery.proxyChanges,
    Number(job.freshExitRestarts || 0),
  );
  recovery.currentProxyId = '';
  recovery.attemptsOnProxy = 0;
  recovery.rebuildPending = true;
  recovery.previousProxyId = previousProxyId;
  job.retry = null;
  job.status = 'waiting';
  job.phase = PROXY_ROTATION_PHASE;
  const delayMs = retryDelayMs(rotationPolicy, 1, context);
  job.nextRunAt = new Date(nowMs(context) + delayMs).toISOString();
  event(context.state, 'auth_callback_proxy_rotated', {
    jobId: job.id,
    workerId: worker?.id || '',
    previousProxyId,
    proxyChanges: recovery.proxyChanges,
    maxProxyChanges: MAX_AUTH_CALLBACK_PROXY_CHANGES,
    delayMs,
    nextRunAt: job.nextRunAt,
    message: 'Callback retries were exhausted; the saved callback context will be rebuilt on a fresh proxy',
  }, context);
  return { scheduled: true, rotated: true, exhausted: false };
}

async function scheduleRetryForWait(job, phase, worker, context, error) {
  const policies = context?.retryPolicies || RETRY_POLICIES;
  let policy = retryPolicyForWait(phase, context);
  if (!policy) return false;
  const previous = isPlainRetryState(job.retry) && job.retry.phase === phase ? job.retry : null;
  let attempts = Number(previous?.attempts || 0) + 1;
  const at = nowIso(context);
  let cycleRestarted = false;

  let restarted = previous?.restarted === true;
  if (attempts > policy.maxRetries) {
    if (phase === PROXY_ROTATION_PHASE) {
      // A rotation budget is only a short scheduling cycle. Do not hand the
      // whole run to the catalog refresh while this Worker's lane still has a
      // verified exit or an untested candidate available.
      if (hasInRunProxyRotationCapacity(worker, context)) {
        attempts = 1;
        cycleRestarted = true;
      } else {
        // There is no local replacement left. Move to the explicit pool wait so
        // the robot can refresh it; leaving the old rotation phase here would
        // look like a normal challenge and strand the run after the last retry.
        await refreshProxyEntriesForWaitingWorker(job, worker, context);
        job.phase = PROXY_POOL_PHASE;
        job.retry = null;
        job.nextRunAt = '';
        return scheduleRetryForWait(job, PROXY_POOL_PHASE, worker, context, error);
      }
    } else {
      // Give up on the attempt rather than the mailbox: the half-built account
      // is discarded and the same address is registered again from a different
      // exit. Allowed once, so a hostile pool cannot loop forever.
      if (policy.onExhausted !== 'restart_on_fresh_exit' || restarted) return false;
      // `restarted` only latches within one run pass; this one survives resumes.
      if (Number(job.freshExitRestarts || 0) >= MAX_FRESH_EXIT_RESTARTS) return false;
      if (!await restartRegistrationOnFreshExit(job, worker, context)) return false;
      policy = policies[PROXY_ROTATION_PHASE];
      if (!policy) return false;
      attempts = 1;
      restarted = true;
    }
  }

  job.retry = {
    phase,
    attempts,
    firstAt: previous?.firstAt || at,
    restarted,
  };
  const policyDelayMs = cycleRestarted
    ? PROXY_ROTATION_CYCLE_DELAY_MS
    : retryDelayMs(policy, attempts, context);
  const providerDelayMs = Number(error?.retryAfterMs);
  // A provider retry-after is a lower bound, not a hint. Jitter is useful for
  // ordinary transient failures, but letting it move a rate-limited SMS
  // preflight before the provider's window expires just recreates -3 after a
  // restart where the in-memory failure cache is gone.
  const delayMs = Number.isFinite(providerDelayMs) && providerDelayMs > 0
    ? Math.max(policyDelayMs, providerDelayMs)
    : policyDelayMs;
  job.nextRunAt = new Date(nowMs(context) + delayMs).toISOString();
  event(context.state, 'branch_job_retry_scheduled', {
    jobId: job.id,
    workerId: worker?.id || '',
    waitPhase: phase,
    attempt: attempts,
    maxRetries: policy.maxRetries,
    ...(cycleRestarted ? { cycleRestarted: true } : {}),
    delayMs,
    nextRunAt: job.nextRunAt,
    message: cycleRestarted
      ? `${phase} retry cycle restarted with a local proxy candidate`
      : `${phase} will be retried in-run (retry ${attempts}/${policy.maxRetries})`,
  }, context);
  return true;
}

function remoteMailboxGroupKey(job, context) {
  const mailbox = (context.state.mailboxes || []).find((item) => String(item.id) === String(job.mailboxId));
  const owner = mailbox?.parentEmail || mailbox?.rootEmail || job.parentEmail || job.email;
  const ownerKey = String(owner || '').trim().toLowerCase();
  const cycle = Number(mailbox?.providerCycle || job.providerCycle || 0);
  const cycleKey = Number.isFinite(cycle) && cycle > 0 ? String(cycle) : '';
  return `${ownerKey}|${cycleKey}`;
}

function remoteMailboxSecurityGroups(context) {
  const groups = new Map();
  for (const job of context.state.jobs || []) {
    if (!job.mailboxId) continue;
    const mailbox = (context.state.mailboxes || []).find((item) => String(item.id) === String(job.mailboxId));
    const owner = mailbox?.parentEmail || mailbox?.rootEmail || job.parentEmail || job.email;
    const ownerKey = String(owner || '').trim().toLowerCase();
    const cycle = Number(mailbox?.providerCycle || job.providerCycle || 0);
    const key = remoteMailboxGroupKey(job, context);
    const group = groups.get(key) || {
      key,
      parentEmail: ownerKey,
      cycle,
      jobs: [],
      pendingSecurityAliases: 0,
      pendingSecurityMailboxIds: new Set(),
      settled: true,
    };
    group.jobs.push(job);
    if (!TERMINAL_JOB_STATUSES.has(job.status)) group.settled = false;
    const mailboxId = String(job.mailboxId);
    if (job.sessionAssetId
      && securityStateHasPendingWork(job.sessionState)
      && !group.pendingSecurityMailboxIds.has(mailboxId)) {
      group.pendingSecurityMailboxIds.add(mailboxId);
      group.pendingSecurityAliases += 1;
    }
    groups.set(key, group);
  }
  return groups;
}

function remoteMailboxSecurityConsumptionAllowed(job, context, groups) {
  if (plannedMailProvider(context.config, context.plan) === 'icloud') return true;
  if (!securityStateHasPendingWork(job.sessionState)) return true;
  const group = groups.get(remoteMailboxGroupKey(job, context));
  // Do not make a decision while sibling aliases are still running. A partial
  // job can finish before the rest of its master batch and must not consume
  // itself before the final pending-security count is known.
  if (!group || !group.settled) return false;
  if (group.pendingSecurityAliases <= MAILCOM_MAX_INCOMPLETE_SECURITY_ALIASES) {
    return true;
  }
  const signature = `${group.key}:${group.pendingSecurityAliases}`;
  context.mailcomRotationBlocks = Array.isArray(context.mailcomRotationBlocks)
    ? context.mailcomRotationBlocks
    : [];
  if (!context.mailcomRotationBlocks.some((block) => block.signature === signature)) {
    context.mailcomRotationBlocks.push({
      signature,
      parentEmail: group.parentEmail,
      cycle: group.cycle || '',
      pendingSecurityAliases: group.pendingSecurityAliases,
      maxAllowed: MAILCOM_MAX_INCOMPLETE_SECURITY_ALIASES,
    });
  }
  const alreadyRecorded = (context.state.events || []).some((record) => (
    record.type === 'mailcom_rotation_blocked_security_pending'
    && record.parentEmail === group.parentEmail
    && String(record.cycle || '') === String(group.cycle || '')
    && Number(record.pendingSecurityAliases || 0) === group.pendingSecurityAliases
  ));
  if (!alreadyRecorded) {
    event(context.state, 'mailcom_rotation_blocked_security_pending', {
      jobId: job.id,
      mailboxId: job.mailboxId,
      parentEmail: group.parentEmail,
      cycle: group.cycle || '',
      pendingSecurityAliases: group.pendingSecurityAliases,
      maxAllowed: MAILCOM_MAX_INCOMPLETE_SECURITY_ALIASES,
      message: 'Mail.com master rotation is blocked because too many aliases have incomplete security setup',
    }, context);
  }
  return false;
}

function recordMailcomCleanupBlock(job, mailbox, context, error) {
  const at = nowIso(context);
  const mailboxId = String(job?.mailboxId || mailbox?.id || '');
  const detail = {
    code: String(error?.code || 'MAILCOM_CLEANUP_BLOCKED'),
    status: Number(error?.status || error?.statusCode || 0),
    message: String(error?.message || error || 'Mail.com cleanup requires manual review'),
    mailboxId,
    blockedAt: at,
  };
  if (job) {
    job.remoteMailboxConsumeError = detail;
    job.remoteMailboxCleanup = {
      ...detail,
      status: 'cleanup_blocked',
      action: 'manual_review',
    };
  }
  if (mailbox) {
    mailbox.cleanupError = detail.message;
    mailbox.cleanupBlockedAt = at;
    mailbox.status = 'cleanup_blocked';
    mailbox.lifecycle = 'cleanup_blocked';
  }
  context.state.externalCleanup = Array.isArray(context.state.externalCleanup)
    ? context.state.externalCleanup
    : [];
  const recordKey = `${job?.id || ''}:${mailboxId}`;
  const duplicate = context.state.externalCleanup.some((record) => (
    record.type === 'mailcom_mailbox_cleanup'
      && `${record.jobId || ''}:${record.mailboxId || ''}` === recordKey
  ));
  if (!duplicate) {
    context.state.externalCleanup.push({
      type: 'mailcom_mailbox_cleanup',
      jobId: job?.id || '',
      mailboxId,
      email: job?.email || mailbox?.email || '',
      provider: 'mailcom',
      status: 'manual_review_required',
      action: 'correct alias domain policy, then verify or retry mailbox cleanup',
      reason: detail.message,
      code: detail.code,
      recordedAt: at,
    });
  }
  context.mailcomCleanupBlocks = Array.isArray(context.mailcomCleanupBlocks)
    ? context.mailcomCleanupBlocks
    : [];
  if (!context.mailcomCleanupBlocks.some((item) => item === recordKey)) {
    context.mailcomCleanupBlocks.push(recordKey);
    event(context.state, 'mailcom_mailbox_cleanup_blocked', {
      jobId: job?.id || '',
      mailboxId,
      email: job?.email || mailbox?.email || '',
      code: detail.code,
      message: detail.message,
      status: 'manual_review_required',
    }, context);
  }
  return detail;
}

async function finalizeRemoteMailbox(job, context) {
  const securityPending = securityStateHasPendingWork(job.sessionState);
  const pendingSecurityRegistration = securityPending && REGISTRATION_TASK_KINDS.has(context.state.taskKind);
  if (!remoteMailboxChannel(context.config)
    || !context.mailClient?.remoteRegistrationAddresses
    || !job.mailboxId
    || !['complete', 'partial'].includes(job.status)
    || !job.sessionAssetId
    || (job.status === 'partial' && !pendingSecurityRegistration)) return false;
  if (job.remoteMailboxConsumedAt) return true;
  if (job.remoteMailboxCleanup?.status === 'cleanup_blocked') return true;
  // Root and `+alias` share one pool address. Consuming it after the first
  // account would close the inbox the second one still reads its code from,
  // and a second consume of the same address would be refused. Wait for every
  // account on the mailbox, then consume it once for all of them.
  const sharedMailboxJobs = localAliasesOnRemoteMailbox(context)
    ? context.state.jobs.filter((item) => String(item.mailboxId) === String(job.mailboxId))
    : null;
  if (sharedMailboxJobs) {
    const consumedSibling = sharedMailboxJobs.find((item) => item.remoteMailboxConsumedAt);
    if (consumedSibling) {
      job.remoteMailboxConsumedAt = consumedSibling.remoteMailboxConsumedAt;
      job.remoteMailboxConsumeError = null;
      return true;
    }
    if (sharedMailboxJobs.some((item) => !TERMINAL_JOB_STATUSES.has(item.status))) return false;
  }
  if (!remoteMailboxSecurityConsumptionAllowed(job, context, remoteMailboxSecurityGroups(context))) return false;
  try {
    const result = await context.mailClient.consumeMailbox(job.mailboxId, {
      note: `run=${context.state.runId};job=${job.id}`,
    });
    const eventPrefix = remoteMailboxEventPrefix(context);
    const providerLabel = eventPrefix === 'icloud' ? 'iCloud' : 'Mail.com';
    job.remoteMailboxConsumedAt = nowIso(context);
    job.remoteMailboxConsumeError = null;
    job.remoteMailboxRecycle = result.recycle || null;
    for (const sibling of sharedMailboxJobs || []) {
      if (sibling === job || !sibling.sessionAssetId) continue;
      sibling.remoteMailboxConsumedAt = job.remoteMailboxConsumedAt;
      sibling.remoteMailboxConsumeError = null;
    }
    const mailbox = context.state.mailboxes.find((item) => String(item.id) === String(job.mailboxId));
    if (mailbox) {
      mailbox.registrationState = 'consumed';
      mailbox.lifecycle = 'consumed';
      mailbox.consumedAt = job.remoteMailboxConsumedAt;
    }
    event(context.state, `${eventPrefix}_mailbox_consumed`, {
      jobId: job.id,
      mailboxId: job.mailboxId,
      cycle: result.mailbox?.cycle || '',
      recycled: result.recycle?.recycled === true,
      recyclePending: result.recycle?.recyclePending === true,
      securityPending,
      message: result.recycle?.recycled === true
        ? `The completed account consumed its ${providerLabel} address and the master cycle was rebuilt`
        : securityPending
          ? `The account address was consumed despite incomplete optional security setup within the ${providerLabel} threshold`
        : `The completed account consumed its ${providerLabel} address`,
    }, context);
    await context.checkpoint(`${eventPrefix}_mailbox_consumed`);
    return true;
  } catch (error) {
    if (remoteRegistrationMailChannel(context.config) && mailboxCleanupRequiresManualReview(error)) {
      const mailbox = context.state.mailboxes.find((item) => String(item.id) === String(job.mailboxId));
      recordMailcomCleanupBlock(job, mailbox, context, error);
      await context.checkpoint('mailcom_mailbox_cleanup_blocked');
      return true;
    }
    // The account and its security state are already durable. Keep the job
    // complete and let the provider-side reconciliation on the next request
    // retry the harmless pool bookkeeping.
    const eventPrefix = remoteMailboxEventPrefix(context);
    job.remoteMailboxConsumeError = {
      code: error.code || `${eventPrefix.toUpperCase()}_MAILBOX_CONSUME_FAILED`,
      message: error.message,
    };
    event(context.state, `${eventPrefix}_mailbox_consume_deferred`, {
      jobId: job.id,
      mailboxId: job.mailboxId,
      message: error.message,
    }, context);
    await context.checkpoint(`${eventPrefix}_mailbox_consume_deferred`);
    return false;
  }
}

async function reconcileRemoteMailboxConsumption(context) {
  if (!remoteMailboxChannel(context.config)
    || !context.mailClient?.remoteRegistrationAddresses) return 0;
  let pending = 0;
  for (const job of context.state.jobs) {
    const securityPending = securityStateHasPendingWork(job.sessionState);
    const pendingSecurityRegistration = securityPending && REGISTRATION_TASK_KINDS.has(context.state.taskKind);
    if ((!['complete', 'partial'].includes(job.status)
      || (job.status === 'partial' && !pendingSecurityRegistration))
      || !job.mailboxId
      || !job.sessionAssetId
      || job.remoteMailboxConsumedAt
      || job.remoteMailboxCleanup?.status === 'cleanup_blocked') continue;
    if (!await finalizeRemoteMailbox(job, context)) pending += 1;
  }
  return pending;
}

async function skipJobAfterRunError(job, worker, context, error) {
  const reason = error.code || 'job_skipped';
  requestJobSkip(job, { reason, requestedAt: nowIso(context) });
  if (error.callbackFailure === true) {
    // Keep the final callback classification next to the cleanup intent. SMS
    // cleanup may take another pass and replace the visible job error.
    job.skipPending = {
      ...job.skipPending,
      terminalStatus: 'skipped',
      code: String(error.code || 'AUTH_CALLBACK_FAILURE'),
      message: String(error.message || 'Authentication callback failed'),
      callbackFailure: true,
    };
  }
  const cleaned = await cleanupSms(job, context, reason);
  if (!cleaned) {
    job.status = 'waiting';
    job.phase = SMS_CLEANUP_PHASE;
    job.error = {
      code: 'SMS_CLEANUP_PENDING',
      message: 'SMS activation cleanup must complete before the job can stop',
      causeCode: String(error.code || 'job_skipped'),
      ...(error.callbackFailure === true ? { callbackFailure: true } : {}),
    };
  } else {
    markJobSkipped(job, {
      code: error.code || 'BRANCH_JOB_SKIPPED',
      message: error.message || 'Job skipped after a definitive result',
      updatedAt: nowIso(context),
    });
    if (error.callbackFailure === true) job.error.callbackFailure = true;
  }
  event(context.state, 'branch_job_skipped', {
    jobId: job.id,
    workerId: worker?.id || '',
    code: error.code || 'BRANCH_JOB_SKIPPED',
    message: error.message,
  }, context);
}

async function failJobAfterRunError(job, worker, context, error) {
  // A terminal job must not retain an old timer or retry budget. Otherwise a
  // later resume can promote the stale wait before it notices the terminal
  // status, which was the source of stranded maintenance jobs.
  job.nextRunAt = '';
  job.retry = null;
  job.skipPending = null;
  job.status = 'failed';
  job.phase = 'failed';
  const cleaned = await cleanupSms(job, context, error.code || 'job_failed');
  if (!cleaned) {
    job.status = 'waiting';
    job.phase = SMS_CLEANUP_PHASE;
    job.error = {
      code: 'SMS_CLEANUP_PENDING',
      message: 'SMS activation cleanup must complete before the job can stop',
      causeCode: String(error.code || 'job_failed'),
    };
  }
  event(context.state, 'branch_job_failed', {
    jobId: job.id,
    workerId: worker?.id || '',
    code: job.error?.code || error.code || 'BRANCH_JOB_FAILED',
    message: job.error?.message || error.message,
  }, context);
}

async function prepareProxyRecovery(job, worker, context, error) {
  const runtimeTransport = proxyRuntimeTransportFailure(error);
  const maintenanceProxy = boundMaintenanceProxy(job, worker, context);
  const callbackProxyRecovery = createdAccountCallbackPending(job) && authCallbackProxyFailure(error);
  if (callbackProxyRecovery) ensureAuthCallbackProxyRecovery(job);
  if (!runtimeTransport) {
    return {
      runtimeTransport: false,
      registrationWasInFlight: registrationInFlight(job),
      transportRecovery: null,
      transportRecoveryAlreadyUsed: false,
      inRunProxyRotation: false,
      maintenanceProxy,
      callbackProxyRecovery,
    };
  }
  const registrationWasInFlight = registrationInFlight(job);
  const transportRecovery = ensureProxyTransportRecovery(job);
  if (callbackProxyRecovery) {
    return {
      runtimeTransport,
      registrationWasInFlight,
      transportRecovery,
      // The callback owns its retry/rotation budget. A stale one-shot recovery
      // marker from an older checkpoint must not terminate it early.
      transportRecoveryAlreadyUsed: false,
      inRunProxyRotation: false,
      maintenanceProxy,
      callbackProxyRecovery: true,
    };
  }
  if (maintenanceProxy) {
    // Older checkpoints may have sent this local-forwarder failure through the
    // remote proxy refresh path once. Clear that stale latch so a later failure is
    // handled by the local retry policy instead of being skipped as exhausted.
    if (transportRecovery.attempted || transportRecovery.pending) {
      transportRecovery.attempted = false;
      transportRecovery.pending = false;
      transportRecovery.attemptedAt = '';
      transportRecovery.resumedAt = '';
    }
    return {
      runtimeTransport,
      registrationWasInFlight,
      transportRecovery,
      transportRecoveryAlreadyUsed: false,
      inRunProxyRotation: false,
      maintenanceProxy: true,
      callbackProxyRecovery: false,
    };
  }
  let oauthLadderRotation = false;
  if (oauthStageTransportFailure(job, error)) {
    const oauthRecovery = ensureOAuthTransportRecovery(job);
    oauthRecovery.lastFailureAt = nowIso(context);
    oauthRecovery.lastFailureCode = String(error.code || 'PROXY_TRANSPORT_FAILURE');
    const base = {
      runtimeTransport,
      registrationWasInFlight,
      transportRecovery,
      transportRecoveryAlreadyUsed: false,
      inRunProxyRotation: false,
      maintenanceProxy: false,
      callbackProxyRecovery: false,
    };
    if (oauthRecovery.sameProxyRetries < MAX_OAUTH_SAME_PROXY_RETRIES) {
      oauthRecovery.sameProxyRetries += 1;
      return { ...base, oauthSameProxyRetry: true };
    }
    if (oauthRecovery.proxyChanges >= MAX_OAUTH_PROXY_CHANGES) {
      return { ...base, oauthTransportExhausted: true };
    }
    oauthRecovery.proxyChanges += 1;
    oauthLadderRotation = true;
  }
  const transportRecoveryAlreadyUsed = Boolean(transportRecovery?.attempted);
  // A job gets the first chance to rotate its own exit. The callback is
  // single-flight at RunManager level, so concurrent jobs share one catalog
  // pull instead of turning a transport outage into twenty API calls.
  const inRunProxyRotation = !transportRecoveryAlreadyUsed
    && await rotateJobProxyForRecovery(job, worker, context);
  if (oauthLadderRotation && inRunProxyRotation && job.oauthState) {
    // The OAuth transaction (PKCE, state, consent cookies) belongs to the exit
    // that just failed twice. Start a fresh authorization on the new one.
    job.oauthState = null;
    event(context.state, 'oauth_proxy_context_restarted', {
      jobId: job.id,
      workerId: worker?.id || '',
      reason: 'oauth_transport_ladder',
      message: 'OAuth failed again on the same exit; it restarts with a fresh authorization on a new exit',
    }, context);
  }
  return {
    runtimeTransport,
    registrationWasInFlight,
    transportRecovery,
    transportRecoveryAlreadyUsed,
    inRunProxyRotation,
    maintenanceProxy: false,
    callbackProxyRecovery: false,
  };
}

async function runJob(job, worker, context) {
  const persistedError = job.error && typeof job.error === 'object' ? { ...job.error } : null;
  const persistedUnsentOAuthPhoneSendRateLimit = isUnsentOAuthPhoneSendRateLimit(job, persistedError);
  const persistedRentalStartTimeout = rentalStartTimeoutRecord(job, context);
  job.status = 'running';
  job.phase = 'starting';
  // Keep this checkpoint's definitive rate-limit error durable until the
  // unconfirmed SMS lease has been cancelled. Otherwise a crash between
  // `branch_job_started` and cleanup would turn the next resume into another
  // phone-send attempt.
  if (!persistedUnsentOAuthPhoneSendRateLimit && !persistedRentalStartTimeout) job.error = null;
  // A held job that is running again is not held any more. The hold writes a
  // terminal-shaped result and the list of features it was missing, and the
  // security retry that releases it resets only status and phase — so a job
  // whose TOTP the retry had since configured went through the whole OAuth
  // leg still labelled 安全项未完成，已暂停 OAuth, and 注册结果 counted it
  // while it ran. Cleared on the way in rather than in the retry, so the
  // reason stays readable for as long as the job is actually waiting.
  if (job.result === 'session_security_incomplete_oauth_held') {
    job.result = '';
    job.missingSecurity = [];
  }
  job.startedAt = job.startedAt || nowIso(context);
  job.updatedAt = nowIso(context);
  worker.status = 'running';
  worker.currentJobId = job.id;
  worker.mailboxId = job.mailboxId;
  await context.checkpoint('branch_job_started');
  try {
    // A task kind where every lane needs a number cannot finish this one, and
    // starting it would spend a mailbox on an account that can never complete.
    // A lane already in flight is left alone — see `latchBalanceStop`.
    if (balanceStopped(context.state)
      && requiresSmsPreflight(context.plan)
      && !registrationInFlight(job)) {
      await skipJobAfterRunError(job, worker, context, balanceStopError(context.state));
      return;
    }
    if (preserveRentalStartTimeout(job, context)) return;
    if (persistedUnsentOAuthPhoneSendRateLimit) {
      const error = Object.assign(
        new Error(String(persistedError.message || 'OAuth phone send was rate limited before delivery')),
        persistedError,
      );
      throw error;
    }
    await bindJobWorkerAffinity(job, worker, context);
    if (context.state.taskKind === 'register_session') await runRegistrationSessionJob(job, worker, context);
    else if (context.state.taskKind === 'session_refresh') await runRefreshJob(job, worker, context);
    else await runOAuthJob(job, worker, context);
    if (preserveRentalStartTimeout(job, context)) return;
    await finalizeRemoteMailbox(job, context);
    if (job.status === 'partial') {
      scheduleSecurityProxyRotation(job, worker, context);
      await scheduleSecurityRetry(job, worker, context);
    }
    if (job.status === 'complete' && worker.proxyId && context.state.proxyHealth[worker.proxyId]) {
      const health = { ...context.state.proxyHealth[worker.proxyId] };
      delete health.accountSelectionFailures;
      context.state.proxyHealth[worker.proxyId] = {
        ...health,
        status: 'healthy',
        reason: '',
        consecutiveTransportFailures: 0,
        lastSuccessAt: nowIso(context),
      };
    }
    job.completedAt = nowIso(context);
    job.updatedAt = job.completedAt;
    event(context.state, 'branch_job_completed', { jobId: job.id, workerId: worker.id, status: job.status }, context);
    compactCompletedJob(job);
  } catch (error) {
    const rentalTimeout = rentalStartTimeoutRecord(job, context);
    if (rentalTimeout) {
      preserveRentalStartTimeout(job, context, rentalTimeout);
    } else if (context.action()) {
      job.status = 'queued';
      job.phase = context.action() === 'cancel' ? 'cancel_pending' : 'paused';
    } else {
      let callbackProxyRecovery = createdAccountCallbackPending(job);
      if (error.accountCreated === true) {
        // ChatGPT has already accepted create_account before the callback is
        // followed. Persist that fact immediately; otherwise a later proxy
        // retry reconstructs an initial signup session and spends the mailbox
        // on a second OTP for an account that already exists.
        job.accountCreatedAt = job.accountCreatedAt || nowIso(context);
        if (job.sessionState) job.sessionState.accountCreated = true;
        callbackProxyRecovery = createdAccountCallbackPending(job);
        // An error page is not retried here any more: its code is spent, and
        // `callbackCodeSpent` below replaces it with one fresh login.
      }
      // Once the bounded OAuth validation reconstruction budget is exhausted,
      // this is no longer a generic transport failure. Running it through the
      // proxy recovery ladder would schedule another attempt with the same
      // untrusted code and could also rotate an exit while the SMS lease is
      // still unresolved.
      const phoneValidationManualReview = exhaustedOAuthPhoneValidationError(job, error);
      terminalizeUnsentOAuthPhoneSendRateLimit(job, error, worker, context);
        const {
          runtimeTransport,
          registrationWasInFlight,
          transportRecovery,
          transportRecoveryAlreadyUsed,
          inRunProxyRotation,
          maintenanceProxy,
          callbackProxyRecovery: callbackProxyRecoveryActive,
          oauthSameProxyRetry = false,
          oauthTransportExhausted = false,
        } = phoneValidationManualReview
        ? {
          runtimeTransport: false,
          registrationWasInFlight: registrationInFlight(job),
          transportRecovery: null,
          transportRecoveryAlreadyUsed: false,
          inRunProxyRotation: false,
          maintenanceProxy: false,
          callbackProxyRecovery: false,
        }
        : await prepareProxyRecovery(job, worker, context, error);
      const oauthLadder = oauthSameProxyRetry || oauthTransportExhausted;
      const transportRecoveryPending = runtimeTransport
        && !maintenanceProxy
        && !inRunProxyRotation
        && !transportRecoveryAlreadyUsed
        && !callbackProxyRecoveryActive
        && !oauthLadder;
      const transportRecoveryExhausted = runtimeTransport
        && !maintenanceProxy
        && !inRunProxyRotation
        && transportRecoveryAlreadyUsed
        && !callbackProxyRecoveryActive
        && !oauthLadder;
      const transportContinuityExhausted = job.proxyTransportRecovery?.attempted === true
        && error.code === 'JOB_PROXY_CONTINUITY_REQUIRED'
        && !callbackProxyRecoveryActive;
      if (transportContinuityExhausted) {
        error.skipJob = true;
        error.retryable = false;
        error.category = 'settled';
        error.causeCode = error.code;
        error.code = 'PROXY_TRANSPORT_RECOVERY_EXHAUSTED';
        error.message = `${error.message}; the refreshed proxy could not preserve the account transaction, so the account is skipped`;
      }
      if (runtimeTransport) {
        const at = nowIso(context);
        if (maintenanceProxy) {
          // The local forwarder is not a remotely refreshable exit. Keep the
          // legacy recovery fields clear and let the maintenance retry phase
          // own the bounded retry count.
          transportRecovery.pending = false;
          transportRecovery.attempted = false;
        } else if (callbackProxyRecoveryActive || oauthLadder) {
          // Callback recovery and the OAuth ladder have their own budgets.
          // Do not consume the legacy one-shot transport marker here.
        } else {
          transportRecovery.failureCount += 1;
          transportRecovery.lastFailureAt = at;
          transportRecovery.lastFailureCode = String(error.code || 'PROXY_TRANSPORT_FAILURE');
          if (inRunProxyRotation) {
            transportRecovery.pending = false;
          } else if (!transportRecovery.attempted) {
            transportRecovery.attempted = true;
            transportRecovery.pending = true;
            transportRecovery.attemptedAt = at;
          } else if (transportRecovery.attempted) {
            transportRecovery.pending = false;
          }
        }
      }
      const cloudflare = error.cloudflareChallenge === true;
      const sharedMaintenance = maintenanceProxy;
      const proxyFault = cloudflare || error.proxyFailure === true || runtimeTransport;
      if (proxyFault) {
        error.retryable = true;
        if (error.proxyFailure === true) error.code = 'OAUTH_ACCOUNT_SELECT_TRANSPORT_FAILED';
        if (maintenanceProxy) {
          error.category = 'transient';
          error.waitPhase = MAINTENANCE_PROXY_PHASE;
        }
        if (!registrationWasInFlight || inRunProxyRotation) {
          if (!registrationWasInFlight && !inRunProxyRotation && !maintenanceProxy)
            restartEarlySessionForProxy(job, context);
          // A local rotation has already cleared or safely rebuilt the prior
          // proxy context. For a pre-registration failure, do the same here
          // before letting the attempt start over somewhere else.
          const proxyId = maintenanceProxy
            ? String(worker.proxyId || job.proxyId || '')
            : (inRunProxyRotation ? '' : unbindWorkerProxy(worker, job, context, {
              // A Cloudflare response does not make the shared 7890 forwarder
              // unusable. There is no alternate maintenance exit to rotate to.
              ban: cloudflare && !sharedMaintenance,
              code: cloudflare ? 'CLOUDFLARE_CHALLENGE' : (error.code || 'PROXY_TRANSPORT_FAILURE'),
              reason: sharedMaintenance
                ? 'maintenance_forwarder_challenge'
                : (cloudflare ? 'cloudflare_challenge' : 'runtime_transport_failure'),
            }));
          if (!maintenanceProxy) error.waitPhase = PROXY_ROTATION_PHASE;
          event(context.state, maintenanceProxy
            ? 'worker_proxy_maintenance_retry_scheduled'
            : 'worker_proxy_swapped_before_registration', {
            jobId: job.id,
            workerId: worker.id,
            proxyId,
            banned: cloudflare && !sharedMaintenance,
            code: error.code || 'PROXY_TRANSPORT_FAILURE',
            message: maintenanceProxy
              ? 'The shared local maintenance forwarder failed; the job will retry on the same endpoint'
              : (inRunProxyRotation
                ? 'The job changed to a fresh exit and will retry inside the current run'
                : (transportRecoveryPending
                  ? 'Proxy transport failed before the account flow started; the exit was dropped and the one refresh recovery is pending'
                  : (transportRecoveryExhausted
                    ? 'Proxy transport still failed after the one refresh recovery; the account will be skipped'
                    : 'Proxy failed before the account flow started; the exit was dropped and the attempt restarts immediately'))),
            ...(inRunProxyRotation ? {
              recovery: registrationWasInFlight ? 'job_local_rotation' : 'in_run_rotation',
            } : {}),
            ...(maintenanceProxy ? { recovery: 'maintenance_retry', proxyKind: 'maintenance' } : {}),
          }, context);
        } else {
          // Mid-registration the exit is worth keeping for a couple of short
          // attempts when the job could not safely rotate it locally.
          error.waitPhase = maintenanceProxy ? MAINTENANCE_PROXY_PHASE : PROXY_RETRY_PHASE;
          event(context.state, 'worker_proxy_retry_in_registration', {
            jobId: job.id,
            workerId: worker.id,
            proxyId: String(worker.proxyId || job.proxyId || ''),
            code: error.code || 'PROXY_TRANSPORT_FAILURE',
            step: String(job.sessionState?.step || ''),
            message: maintenanceProxy
              ? 'The shared local maintenance forwarder failed; the job will retry on the same endpoint'
              : oauthSameProxyRetry
              ? 'OAuth proxy transport failed; retrying once on the same exit before switching to a new one'
              : oauthTransportExhausted
              ? 'OAuth proxy transport failed again after the same-exit retry and one exit change; the job stops'
              : transportRecoveryPending
              ? 'Proxy transport failed mid-registration; waiting for catalog refresh fallback'
              : (transportRecoveryExhausted
                ? 'Proxy transport still failed after the one refresh recovery; the account will be skipped'
                : 'Proxy failed mid-registration; the bound exit is retried briefly before the attempt is rebuilt'),
          }, context);
        }
      }
      if (transportRecoveryExhausted) {
        const causeCode = String(error.code || 'PROXY_TRANSPORT_FAILURE');
        error.skipJob = true;
        error.retryable = false;
        error.category = 'settled';
        error.causeCode = causeCode;
        error.code = 'PROXY_TRANSPORT_RECOVERY_EXHAUSTED';
        error.message = `${error.message || 'Proxy transport failed'}; proxy refresh was already used and the account is skipped`;
      } else if (transportRecoveryPending) {
        // Catalog refresh owns the fallback only when the job could not find a
        // replacement exit itself. Do not race it with a retry.
        error.retryable = false;
        error.waitPhase = PROXY_ROTATION_PHASE;
      }
      if (phoneValidationManualReview) {
        const causeCode = String(error.code || 'PHONE_VALIDATION_OUTCOME_UNKNOWN');
        error.code = 'OAUTH_PHONE_VALIDATION_MANUAL_REVIEW_REQUIRED';
        error.causeCode = causeCode;
        error.category = 'manual_review';
        error.retryable = false;
        error.preserveSms = true;
        error.waitPhase = PHONE_MANUAL_REVIEW_PHASE;
        error.message = 'OAuth phone validation remained uncertain after the automatic recovery attempt; resume manually to start a fresh OAuth transaction without replaying the old code';
      }
      if (oauthTransportExhausted) {
        const causeCode = String(error.code || 'PROXY_TRANSPORT_FAILURE');
        error.code = 'OAUTH_PROXY_RECOVERY_EXHAUSTED';
        error.causeCode = causeCode;
        error.category = 'settled';
        error.message = `${error.message || 'Proxy transport failed'}; OAuth was already retried once on the same proxy and once on a new proxy`;
      }
      const deactivated = markDeactivatedSessionAsset(job, context, error);
      markOAuthLoginRequiredSessionAsset(job, context, error);
      const oauthCooldownSet = markOAuthFailureCooldown(job, context, error);
      if (callbackProxyRecoveryActive) error.callbackFailure = true;
      job.error = {
        code: error.code || 'BRANCH_JOB_FAILED',
        message: error.message,
        ...(error.category ? { category: String(error.category) } : {}),
        ...(error.inventoryRetryAt ? { retryAt: String(error.inventoryRetryAt) } : {}),
        ...(error.inventoryExhausted === true ? { inventoryExhausted: true } : {}),
        ...(Number(error.status || 0) ? { status: Number(error.status) } : {}),
        ...(error.diagnostics ? { diagnostics: clone(error.diagnostics) } : {}),
        ...(error.authCallbackCompleted !== undefined ? { authCallbackCompleted: Boolean(error.authCallbackCompleted) } : {}),
        ...(error.accountCreated !== undefined ? { accountCreated: Boolean(error.accountCreated) } : {}),
        ...(error.authPageType ? { authPageType: String(error.authPageType) } : {}),
        ...(error.authStep ? { authStep: String(error.authStep) } : {}),
        ...(error.phonePhase ? { phonePhase: String(error.phonePhase) } : {}),
        ...(error.waitPhase ? { waitPhase: String(error.waitPhase) } : {}),
        ...(error.preserveSms === true ? { preserveSms: true } : {}),
        ...(error.callbackFailure === true ? { callbackFailure: true } : {}),
        ...(oauthCooldownSet ? { oauthCooldown: true } : {}),
        ...(phoneValidationManualReview ? { manualReviewRequired: true } : {}),
        ...(error.causeCode ? { causeCode: String(error.causeCode) } : {}),
        ...(error.causeMessage ? { causeMessage: String(error.causeMessage) } : {}),
        ...(Number.isFinite(Number(error.phoneAttempts)) ? { phoneAttempts: Number(error.phoneAttempts) } : {}),
        ...(Number.isFinite(Number(error.phoneReplacementBudget))
          ? { phoneReplacementBudget: Number(error.phoneReplacementBudget) }
          : {}),
      };
      // Some failures are answers, not accidents. An address the provider will
      // not deliver to gives the same answer every time, so parking it for four
      // more retries only holds a Worker and a proxy against a settled outcome.
      // It stops here as `skipped` — distinct from `failed`, because nothing
      // went wrong on our side — and the Worker moves to the next lane.
      //
      // OpenAI closing an account is the same shape of answer. It is a normal
      // cost of doing this at volume, not a defect in the run, and grading a
      // whole batch `partial` because two accounts were banned buries the
      // failures that do need attention. The asset is already marked `banned`
      // above, so the cleanup robot will collect it; the run reports the count
      // and stays `complete`.
      if (deactivated) {
        await skipJobAfterRunError(job, worker, context, error);
      } else if (phoneValidationManualReview) {
        job.status = 'waiting';
        job.phase = PHONE_MANUAL_REVIEW_PHASE;
        job.nextRunAt = '';
        job.retry = null;
        job.completedAt = '';
        event(context.state, 'oauth_phone_validation_manual_review_required', {
          jobId: job.id,
          workerId: worker.id,
          activationId: job.sms.current?.activationId || job.sms.current?.id || '',
          causeCode: error.causeCode,
          message: error.message,
        }, context);
      } else if (error.skipJob === true) {
        await skipJobAfterRunError(job, worker, context, error);
      } else if (oauthTransportExhausted) {
        error.retryable = false;
        await failJobAfterRunError(job, worker, context, error);
      } else if (oauthCooldownSet) {
        // An OAuth cooldown is a settled account outcome. Do not leave the
        // Job in an OAuth retry wait: that keeps the auxiliary slot occupied
        // until an operator happens to resume the run. Cleanup still runs
        // here, so a paid activation is never abandoned.
        error.retryable = false;
        error.category = 'settled';
        await failJobAfterRunError(job, worker, context, error);
      } else if (callbackCodeSpent(job, error) && !job.callbackLoginRecovery) {
        await startCallbackLoginRecovery(job, worker, context, error);
      } else if (callbackCodeSpent(job, error)) {
        // The fresh login reached a callback and that code was refused too.
        // Replaying it cannot help, so stop here as a callback failure.
        if (job.callbackLoginRecovery) {
          job.callbackLoginRecovery.status = 'failed';
          job.callbackLoginRecovery.completedAt = nowIso(context);
        }
        error.skipJob = true;
        error.retryable = false;
        error.category = 'settled';
        error.callbackFailure = true;
        error.causeCode = 'AUTH_CALLBACK_ERROR_PAGE';
        error.message = `${error.message || 'Authentication callback failed'}; a fresh login was already tried and its callback was refused as well`;
        job.error = { ...job.error, message: error.message, callbackFailure: true, causeCode: error.causeCode };
        await skipJobAfterRunError(job, worker, context, error);
      } else if (!job.callbackLoginRecovery
        && LOGIN_RECOVERABLE_CREATED_ACCOUNT_CODES.has(String(error.code || ''))
        && createdAccountWithoutCallback(job, error)) {
        // The account exists, but there is no callback to finish it with (or
        // the one in hand belongs to another exit). Sign in once instead of
        // failing the account or retrying an identity check that cannot pass.
        await startCallbackLoginRecovery(job, worker, context, error);
      } else if (error.code === 'SENTINEL_PROXY_IDENTITY_CHANGED'
        && callbackLoginInFlight(job)
        && Number(job.callbackLoginRecovery.sessionRebuilds || 0) < MAX_CALLBACK_LOGIN_SESSION_REBUILDS) {
        // A login carried across an exit change (older checkpoints) can never
        // pass this check. Rebuild it for the current exit and run it again
        // now rather than spending transient retries on the same mismatch.
        restartCallbackLoginSessionForProxy(job, context, 'sentinel_proxy_identity_changed');
        job.retry = null;
        job.nextRunAt = '';
        job.completedAt = '';
        job.status = 'queued';
        job.phase = 'callback_login_recovery';
        event(context.state, 'callback_login_session_rebuilt', {
          jobId: job.id,
          workerId: worker.id,
          proxyId: String(worker?.proxyId || job.proxyId || ''),
          rebuilds: job.callbackLoginRecovery.sessionRebuilds,
          message: 'The re-login carried an identity from an earlier exit; it restarts on the current exit',
        }, context);
        await context.checkpoint('callback_login_session_rebuilt');
      } else if (callbackProxyRecoveryActive && !maintenanceProxy) {
        const callbackRetry = await scheduleAuthCallbackProxyRetry(job, worker, context, error);
        if (callbackRetry.scheduled) {
          job.completedAt = '';
          event(context.state, 'branch_job_waiting', {
            jobId: job.id,
            workerId: worker.id,
            code: job.error.code,
            message: error.message,
            waitPhase: job.phase,
            retryScheduled: true,
            callbackProxyRecovery: {
              attemptsOnProxy: job.authCallbackProxyRecovery.attemptsOnProxy,
              proxyChanges: job.authCallbackProxyRecovery.proxyChanges,
              maxProxyChanges: MAX_AUTH_CALLBACK_PROXY_CHANGES,
            },
            nextRunAt: job.nextRunAt,
          }, context);
        } else if (callbackRetry.exhausted) {
          const attempts = job.authCallbackProxyRecovery.attemptsOnProxy;
          const changes = job.authCallbackProxyRecovery.proxyChanges;
          error.skipJob = true;
          error.retryable = false;
          error.category = 'settled';
          error.callbackFailure = true;
          error.causeCode = String(error.code || 'AUTH_CALLBACK_FAILURE');
          error.message = `${error.message || 'Authentication callback failed'}; authentication callback failed after ${attempts} retries on the final proxy and ${changes} proxy changes`;
          await skipJobAfterRunError(job, worker, context, error);
        } else {
          // A paid SMS lease could not be closed before the context rebuild.
          // Keep the callback checkpoint and the lease visible for cleanup rather
          // than spending another proxy or silently dropping the activation.
          job.status = 'waiting';
          job.phase = SMS_CLEANUP_PHASE;
          job.nextRunAt = '';
          job.retry = null;
          job.completedAt = '';
          error.preserveSms = true;
          error.waitPhase = SMS_CLEANUP_PHASE;
          job.error = {
            ...job.error,
            message: error.message,
            preserveSms: true,
            waitPhase: SMS_CLEANUP_PHASE,
          };
          event(context.state, 'auth_callback_proxy_rebuild_blocked', {
            jobId: job.id,
            workerId: worker.id,
            code: error.code || 'AUTH_CALLBACK_FAILURE',
            message: error.message,
            waitPhase: job.phase,
          }, context);
        }
      } else if (transportRecoveryPending) {
        job.status = 'waiting';
        job.phase = PROXY_ROTATION_PHASE;
        job.nextRunAt = '';
        job.retry = null;
        job.completedAt = '';
        event(context.state, 'branch_job_waiting', {
          jobId: job.id,
          workerId: worker.id,
          code: job.error.code,
          message: error.message,
          waitPhase: job.phase,
          retryScheduled: false,
          proxyTransportRecovery: 'refresh_once',
        }, context);
      } else if (error.preserveSms === true || transientBranchError(error) || ['pending_cleanup', 'completion_pending'].includes(job.sms?.current?.status)) {
        job.status = 'waiting';
        job.phase = error.waitPhase || error.phonePhase || (job.sms?.current ? PHONE_CONTINUITY_PHASE : TRANSIENT_PHASE);
        // Book an in-run retry where the phase allows it. Without this the job
        // stays parked until an operator resumes, which idles the Worker even
        // though the failure is recoverable on a fresh or re-probed exit.
        // No in-run retry for the two waits nothing in the run can resolve:
        // inventory is upstream, and a balance does not refill by itself.
        const retryScheduled = job.phase === SMS_INVENTORY_RETRY_PHASE || job.phase === SMS_BALANCE_PHASE
          ? false
          : (job.phase === SMS_PREFLIGHT_PHASE && error.retryable !== true
            ? false
            : await scheduleRetryForWait(job, job.phase, worker, context, error));
        const errorCode = String(error.code || '').toUpperCase();
        const emailWaitExhausted = !retryScheduled
          && REGISTRATION_EMAIL_TIMEOUT_CODES.has(errorCode);
        const maintenanceRetryExhausted = !retryScheduled
          && job.phase === MAINTENANCE_PROXY_PHASE;
        if (maintenanceRetryExhausted) {
          // The shared forwarder has no alternate endpoint to rotate to. Once
          // its single retry is spent, fail this account and release the
          // Worker; leaving it in an unscheduled wait strands the whole run
          // when the other lanes finish.
          error.retryable = false;
          error.category = 'settled';
          error.message = `${error.message || 'The shared local maintenance forwarder failed'}; the maintenance forwarder retry budget was exhausted`;
          event(context.state, 'maintenance_proxy_retry_exhausted', {
            jobId: job.id,
            workerId: worker.id,
            proxyId: String(worker.proxyId || job.proxyId || ''),
            attempts: Number(job.retry?.attempts || 0),
            message: error.message,
          }, context);
          await failJobAfterRunError(job, worker, context, error);
        } else if (emailWaitExhausted && errorCode === 'EMAIL_OTP_TIMEOUT') {
          // A legacy or provider-wrapped OTP timeout must not remain parked once
          // its retry budget is gone. The normal clean-mail timeout already sets
          // skipJob before reaching this catch block; this is the final guard.
          error.skipJob = true;
          error.retryable = false;
          error.category = 'settled';
          await skipJobAfterRunError(job, worker, context, error);
        } else if (emailWaitExhausted) {
          // A provider timeout is not proof that the address is bad, so keep it
          // resumable, but do not leave the current run waiting forever.
          await failJobAfterRunError(job, worker, context, error);
        } else {
          event(context.state, 'branch_job_waiting', {
            jobId: job.id,
            workerId: worker.id,
            code: job.error.code,
            message: error.message,
            waitPhase: job.phase,
            retryScheduled,
            nextRunAt: job.nextRunAt || '',
          }, context);
        }
      } else {
        await failJobAfterRunError(job, worker, context, error);
      }
    }
  } finally {
    // One exit per *account*. The operator chose this over sharing one exit
    // across a root and its `+alias`: the next account, even on the same
    // mailbox, must not be seen from the address the finished one used. The
    // Worker keeps its lane, so the alias still follows on the same Worker;
    // only the exit is released and the next bind prefers an unused one.
    if (TERMINAL_JOB_STATUSES.has(job.status)) {
      releaseBranchWorkerProxy(
        worker,
        context,
        laneHasPendingWork(job.laneId, context) ? 'account_finished' : 'lane_finished',
      );
    }
    worker.status = 'idle';
    worker.currentJobId = '';
    worker.mailboxId = null;
    worker.updatedAt = nowIso(context);
    await context.checkpoint('branch_job_stopped');
  }
}

/**
 * Does this root mailbox still have accounts to register?
 *
 * The answer decides whether the Worker keeps its exit. A lane's aliases share
 * one address deliberately (see the release in `runJobOnWorker`), so the exit
 * survives between them and is spent only once the lane is finished.
 */
function laneHasPendingWork(laneId, context) {
  const lane = String(laneId || '');
  if (!lane) return false;
  return context.state.jobs.some((job) => (
    job.laneId === lane
    && !TERMINAL_JOB_STATUSES.has(job.status)
    && !job.skipPending
  ));
}

function pendingLaneHeads(state) {
  const heads = new Map();
  for (const job of state.jobs) {
    if (TERMINAL_JOB_STATUSES.has(job.status) || job.skipPending) continue;
    const current = heads.get(job.laneId);
    if (!current || Number(job.aliasIndex || 0) < Number(current.aliasIndex || 0)) heads.set(job.laneId, job);
  }
  return heads;
}

/**
 * Whether this Worker is allowed to pick the job up.
 *
 * The pin exists to keep a job that is mid-transaction — holding an SMS lease,
 * or carrying a created account or a verified session — on the exit it started
 * on. It was never cleared, so a job that failed before any of that existed
 * stayed bound to one Worker for the rest of the run: in the retry tail that
 * left nineteen Workers idle behind a single lane. A job with nothing durable
 * behind it can start over anywhere, so the pin is ignored for those.
 */
function workerMatchesJobAffinity(worker, job) {
  const workerId = String(job.workerAffinity?.workerId || '');
  if (!workerId || workerId === worker.id) return true;
  return canRestartEarlySessionAfterProxyChange(job) || createdAccountCallbackPending(job);
}

/**
 * Releases a Worker whose exit could not be bound and records why.
 *
 * Runs detached from the scheduler loop, so it never returns a new run state:
 * pause and cancel are the loop head's business, and a bind aborted by one of
 * them leaves the job queued for that pass to deal with instead of burning it.
 */
async function recordProxyBindFailure(job, worker, error, context) {
  worker.status = 'idle';
  worker.currentJobId = '';
  worker.mailboxId = null;
  worker.updatedAt = nowIso(context);
  if (context.action()) return;
  const callbackPending = createdAccountCallbackPending(job);
  job.error = { code: error.code || 'PROXY_BIND_FAILED', message: error.message };
  const recoveryExhausted = !callbackPending && job.proxyTransportRecovery?.attempted === true
    && ['PROXY_POOL_EXHAUSTED', 'HEALTHY_PROXY_REQUIRED', 'PROXY_BIND_FAILED'].includes(String(error.code || ''));
  if (recoveryExhausted) {
    const skipped = new Error(`${error.message}; proxy refresh was already used and the account is skipped`);
    skipped.code = 'PROXY_TRANSPORT_RECOVERY_EXHAUSTED';
    skipped.causeCode = error.code || 'PROXY_BIND_FAILED';
    skipped.skipJob = true;
    skipped.retryable = false;
    job.error = {
      code: skipped.code,
      message: skipped.message,
      causeCode: skipped.causeCode,
      category: 'settled',
    };
    await skipJobAfterRunError(job, worker, context, skipped);
    if (TERMINAL_JOB_STATUSES.has(job.status)) releaseBranchWorkerProxy(worker, context, skipped.code);
    return;
  }
  // A pool may be temporarily busy while another Worker holds the available
  // exits. Refresh the catalog before parking it so a source-side refill can
  // wake this run without requiring the operator to resume it manually.
  if (['PROXY_POOL_BUSY', 'PROXY_POOL_EXHAUSTED', 'HEALTHY_PROXY_REQUIRED'].includes(String(error.code || ''))) {
    const refreshed = await refreshProxyEntriesForWaitingWorker(job, worker, context);
    const scheduled = callbackPending
      ? await scheduleRetryForWait(job, PROXY_POOL_PHASE, worker, context, error)
      : (refreshed || proxyCapacityMayReturn(context))
        && await scheduleRetryForWait(job, PROXY_POOL_PHASE, worker, context, null);
    if (callbackPending && !scheduled) {
      const skipped = new Error(`${error.message}; authentication callback failed because no replacement proxy became available`);
      skipped.code = String(error.code || 'AUTH_CALLBACK_FAILURE');
      skipped.causeCode = 'AUTH_CALLBACK_FAILURE';
      skipped.skipJob = true;
      skipped.retryable = false;
      skipped.category = 'settled';
      skipped.callbackFailure = true;
      await skipJobAfterRunError(job, worker, context, skipped);
      if (TERMINAL_JOB_STATUSES.has(job.status)) releaseBranchWorkerProxy(worker, context, skipped.code);
      return;
    }
    job.status = 'waiting';
    job.phase = PROXY_POOL_PHASE;
    if (!scheduled) job.nextRunAt = '';
    job.updatedAt = nowIso(context);
    event(context.state, 'branch_job_waiting', {
      jobId: job.id,
      workerId: worker.id,
      code: job.error.code,
      message: error.message,
      waitPhase: job.phase,
      retryScheduled: scheduled,
    }, context);
    return;
  }
  job.status = 'failed';
  job.phase = 'failed';
  job.updatedAt = nowIso(context);
}

/**
 * Waits during which the account keeps its Worker.
 *
 * Releasing the lane used to hand the Worker — and the exit it was holding — to
 * the next account. Two accounts then shared one residential IP back to back,
 * and when that next account broke the exit, the waiting one came back on a
 * different IP than it registered on. Observed twice on 2026-10-10: a number
 * shortage, and a two-second exit retry during which another account's
 * callback recovery borrowed the exit and burned it.
 *
 * Every phase here either ends within seconds (exit retries, callback exit
 * changes, security retries) or ends the same way for any new account too (no
 * SMS numbers), so holding costs nothing a released Worker would have earned.
 */
const LANE_HOLDING_WAIT_PHASES = new Set([
  SMS_INVENTORY_RETRY_PHASE,
  SMS_INVENTORY_EXHAUSTED_PHASE,
  PROXY_RETRY_PHASE,
  PROXY_ROTATION_PHASE,
  PROXY_CONTINUITY_PHASE,
  SECURITY_RETRY_PHASE,
  SECURITY_EMAIL_RETRY_PHASE,
]);

function laneHoldingWait(job) {
  return job?.status === 'waiting' && LANE_HOLDING_WAIT_PHASES.has(String(job.phase || ''));
}

/** Idle Workers sitting on a lane whose account is in a holding wait. */
function workersHoldingLanes(context) {
  const laneHeads = pendingLaneHeads(context.state);
  return context.state.workers.filter((worker) => (
    worker.status === 'idle'
    && worker.laneId
    && laneHoldingWait(laneHeads.get(worker.laneId))
  ));
}

function nextJobForWorker(worker, activeLanes, context) {
  const laneHeads = pendingLaneHeads(context.state);
  if (worker.laneId) {
    const laneHead = laneHeads.get(worker.laneId);
    if (laneHead && unassignedRentalReplacement(laneHead, context)) {
      worker.laneId = '';
    } else if (laneHead) {
      const assigned = context.state.workers.some((candidate) => candidate.currentJobId === laneHead.id);
      if (laneHead.status === 'queued' && !assigned) {
        if (workerMatchesJobAffinity(worker, laneHead)) {
          worker.heldLaneJobId = '';
          return laneHead;
        }
        worker.laneId = '';
      } else if (laneHoldingWait(laneHead)) {
        // Hold the lane and its exit; the retry timer brings the job back here.
        if (worker.heldLaneJobId !== laneHead.id) {
          worker.heldLaneJobId = laneHead.id;
          worker.updatedAt = nowIso(context);
          event(context.state, 'worker_lane_held', {
            workerId: worker.id,
            jobId: laneHead.id,
            laneId: worker.laneId,
            phase: laneHead.phase,
            proxyId: String(worker.proxyId || ''),
            message: 'Worker keeps this account and its exit through a short wait instead of starting another account',
          }, context);
        }
        return null;
      } else if (laneHead.status === 'waiting') {
        const deferredLaneId = worker.laneId;
        worker.laneId = '';
        worker.updatedAt = nowIso(context);
        event(context.state, 'worker_lane_deferred', {
          workerId: worker.id,
          jobId: laneHead.id,
          laneId: deferredLaneId,
          phase: laneHead.phase || 'waiting',
          message: 'Worker released a waiting lane and will continue with other runnable lanes',
        }, context);
      } else {
        return null;
      }
    } else {
      worker.laneId = '';
    }
  }
  // A lane its own Worker is holding is not up for grabs: callback recovery
  // used to let any idle Worker adopt it, on whatever exit that Worker held.
  const heldElsewhere = new Set(context.state.workers
    .filter((other) => other.id !== worker.id && other.status === 'idle' && other.laneId)
    .map((other) => other.laneId));
  const job = [...laneHeads.values()].find((candidate) => (
    candidate.status === 'queued'
    && !unassignedRentalReplacement(candidate, context)
    && workerMatchesJobAffinity(worker, candidate)
    && !activeLanes.has(candidate.laneId)
    && !heldElsewhere.has(candidate.laneId)
    && !context.state.workers.some((workerState) => workerState.currentJobId === candidate.id)
  ));
  if (job) worker.laneId = job.laneId;
  return job;
}

/**
 * Every waiting job that has asked to be retried at a specific time.
 *
 * Membership is decided by `nextRunAt`, not by phase: SMS inventory was the
 * first user of this queue, but proxy rotation and transient failures schedule
 * themselves the same way, and all of them must keep the run alive in-process
 * instead of parking it for an operator.
 */
function scheduledRetries(state) {
  return (state.jobs || []).filter((job) => (
    job.status === 'waiting'
    && !job.skipPending
    && scheduledAt(job) !== null
  ));
}

/**
 * Re-queues a job that parked on the one-shot proxy refresh once the run has an
 * exit for it again.
 *
 * `proxyTransportRecovery.pending` means "this job is owed exactly one
 * continuation on a fresh exit". Its only consumer was `resumeBranchState`,
 * which is an operator action, so a job parked mid-run stayed parked while the
 * lanes around it finished and handed their exits back: idle Workers, frozen
 * jobs, and a run that moved again only when someone pressed resume. Consuming
 * the marker here closes that gap. It is set once per job, so each job is
 * promoted at most once, and only when a Worker that may take it actually has a
 * replacement exit -- promoting into an empty pool would spend the recovery and
 * skip the account instead of saving it.
 */
function promoteRecoverableProxyWaits(context) {
  let promoted = 0;
  for (const job of context.state.jobs || []) {
    if (job.status !== 'waiting' || job.skipPending) continue;
    if (scheduledAt(job) !== null) continue;
    if (job.proxyTransportRecovery?.pending !== true) continue;
    const worker = (context.state.workers || [])
      .find((candidate) => workerMatchesJobAffinity(candidate, job)
        && hasInRunProxyRotationCapacity(candidate, context));
    if (!worker) continue;
    job.proxyTransportRecovery.pending = false;
    job.proxyTransportRecovery.resumedAt = nowIso(context);
    job.status = 'queued';
    job.phase = 'queued';
    job.nextRunAt = '';
    job.retry = null;
    job.error = null;
    job.updatedAt = nowIso(context);
    event(context.state, 'proxy_transport_recovery_resumed', {
      jobId: job.id,
      workerId: worker.id,
      attempt: Number(job.proxyTransportRecovery.failureCount || 0),
      message: 'A replacement exit became available inside the run; the pending proxy refresh recovery was consumed without an operator resume',
    }, context);
    promoted += 1;
  }
  return promoted;
}

async function promoteDueRetries(context) {
  const currentTime = nowMs(context);
  const due = scheduledRetries(context.state)
    .filter((job) => scheduledAt(job) <= currentTime)
    .filter((job) => !job.skipPending)
    // A rental replacement is promoted by the rental opener itself. Keeping it
    // waiting here prevents an unassigned placeholder from reaching a Worker.
    .filter((job) => !unassignedRentalReplacement(job, context));
  if (!due.length) return 0;
  for (const job of due) {
    const scheduledFor = job.nextRunAt;
    const phase = job.phase;
    const inventoryRetry = phase === SMS_INVENTORY_RETRY_PHASE;
    job.status = 'queued';
    job.phase = 'queued';
    job.nextRunAt = '';
    job.error = null;
    job.updatedAt = nowIso(context);
    event(context.state, inventoryRetry ? 'sms_inventory_retry_due' : 'branch_job_retry_due', {
      jobId: job.id,
      waitPhase: phase,
      attempt: inventoryRetry
        ? Number(job.sms?.inventoryPollCount || 0) + 1
        : Number(job.retry?.attempts || 0),
      scheduledFor,
      message: inventoryRetry
        ? 'SMS inventory retry is due and has returned to the worker queue'
        : `${phase} retry is due and has returned to the worker queue`,
    }, context);
  }
  context.state.status = 'running';
  context.state.phase = 'running';
  await context.checkpoint(due.some((job) => job.retry) ? 'branch_job_retry_due' : 'sms_inventory_retry_due');
  return due.length;
}

/**
 * Blocks until the scheduler has a reason to run again: a job finished, or the
 * soonest booked retry came due.
 *
 * This is what keeps the loop continuous. Waiting on *all* in-flight jobs would
 * idle every free Worker behind the slowest one, and would stop due retries
 * from being promoted until the whole batch drained. Returns false only when
 * there is nothing left to wait for.
 */
async function waitForSchedulerWakeup(inflight, context) {
  const waits = [...(inflight?.values() || [])];
  const claimFlight = context.mailRentalClaimFlight;
  const wakeWait = (inflight?.size || claimFlight) && typeof context.control?.waitForWake === 'function'
    ? context.control.waitForWake()
    : null;
  if (wakeWait) waits.push(wakeWait.promise);
  if (claimFlight?.wake && typeof claimFlight.wake.then === 'function') {
    // A returned mailbox creates a runnable job before the rest of the window
    // finishes. Wake on each completion so an idle Worker can consume it
    // immediately instead of waiting for the seven-request window to drain.
    waits.push(claimFlight.wake);
  }
  const retries = scheduledRetries(context.state);
  if (retries.length) {
    const soonest = Math.min(...retries.map(scheduledAt));
    if (!waits.length) {
      // Nothing running, so the run is genuinely parked on a timer and the
      // phase should say so.
      const next = retries.find((job) => scheduledAt(job) === soonest);
      const waitPhase = next?.phase === SMS_INVENTORY_RETRY_PHASE
        ? SMS_INVENTORY_RETRY_PHASE
        : (next?.phase === MAIL_RENTAL_RETRY_PHASE ? MAIL_RENTAL_RETRY_PHASE : RETRY_BACKOFF_PHASE);
      if (context.state.status !== 'running' || context.state.phase !== waitPhase) {
        context.state.status = 'running';
        context.state.phase = waitPhase;
        await context.checkpoint(waitPhase === SMS_INVENTORY_RETRY_PHASE
          ? 'branch_sms_inventory_waiting'
          : (waitPhase === MAIL_RENTAL_RETRY_PHASE
            ? 'branch_mail_rental_waiting'
            : 'branch_retry_backoff_waiting'));
      }
    }
    // Floored so a due retry that cannot be assigned yet (every Worker busy, or
    // its lane taken) cannot spin the loop; capped so a long backoff still
    // notices a pause or cancel promptly.
    const delayMs = Math.min(Math.max(soonest - nowMs(context), 250), 30000);
    waits.push(waitControlled(delayMs, context));
  }
  const mailRetryAt = rentalCapacityOutstanding(context) ? mailRentalRetryAt(context) : null;
  // An online configuration update can deliberately clear `nextPollAt` to
  // wake the broker immediately. While a claim window is active, its wake
  // promise is the only useful signal; adding an already-due timer here would
  // spin the scheduler and starve the provider callbacks.
  const claimInProgress = Boolean(context.mailRentalClaimFlight);
  const mailWatchAt = rentalCapacityOutstanding(context)
    && mailRentalWatchEnabled(context)
    && !claimInProgress
    ? mailRentalWakeAt(context)
    : null;
  const rentalWakeAt = mailWatchAt !== null ? mailWatchAt : mailRetryAt;
  const unstartedRentalAt = unstartedRentalExpiryAt(context);
  const waitingForMailboxConsumption = mailRentalWatchEnabled(context)
    && mailRentalBackpressureSnapshot(context).paused;
  // While a Worker is running, its completion is the precise signal that can
  // reopen backpressure. A periodic timer in the same Promise.race is only a
  // fallback for the no-Worker case; keeping both creates a hot loop under
  // virtual clocks and needlessly wakes the broker in production.
  if (rentalWakeAt !== null && (!waitingForMailboxConsumption || !inflight?.size)) {
    if (!waits.length) {
      // A rental retry has no job to carry its timer before the first mailbox is
      // issued. Keep the run visibly active and resumable at the run level.
      const waitPhase = mailWatchAt !== null ? MAIL_RENTAL_WATCH_PHASE : MAIL_RENTAL_RETRY_PHASE;
      if (context.state.status !== 'running' || context.state.phase !== waitPhase) {
        context.state.status = 'running';
        context.state.phase = waitPhase;
        await context.checkpoint(mailWatchAt !== null
          ? 'branch_mail_rental_watch_waiting'
          : 'branch_mail_rental_waiting');
      }
    }
    const delayMs = Math.min(Math.max(rentalWakeAt - nowMs(context), 250), 30000);
    waits.push(waitControlled(delayMs, context));
  }
  if (unstartedRentalAt !== null
    && !claimInProgress
    && !inflight?.size
    && context.state.mailRentalWatch?.stopRequested !== true) {
    const delayMs = Math.min(Math.max(unstartedRentalAt - nowMs(context), 250), 30000);
    waits.push(waitControlled(delayMs, context));
  }
  if (!waits.length) return false;
  try {
    await Promise.race(waits);
    return true;
  } finally {
    wakeWait?.cancel();
  }
}

async function releaseUnusedMailboxes(context, options = {}) {
  if (!REGISTRATION_TASK_KINDS.has(context.state.taskKind)) return 0;
  const records = context.state.mailboxes.map((mailbox) => {
    const jobs = context.state.jobs.filter((job) => String(job.mailboxId) === String(mailbox.id));
    const retained = jobs.some((job) => job.sessionAssetId);
    const produced = jobs.some(confirmedRegistration);
    const targetTouched = jobs.some((job) => sessionTargetTouched(job));
    const addressSpent = jobs.some((job) => mailboxAddressSpent(job));
    mailbox.createdCount = jobs.filter((job) => job.sessionAssetId).length;
    mailbox.attemptCount = jobs.length;
    mailbox.normalComplete = jobs.every((job) => TERMINAL_JOB_STATUSES.has(job.status))
      && (jobs.length > 0 || options.includeUnstarted === true);
    mailbox.targetTouched = targetTouched;
    mailbox.addressSpent = addressSpent;
    if (retained && mailbox.normalComplete) {
      mailbox.status = mailbox.createdCount >= Number(mailbox.targetCount || 1) ? 'complete' : 'partial_retained';
      mailbox.releaseError = '';
    } else if (targetTouched && addressSpent && mailbox.normalComplete) {
      mailbox.status = 'partial_retained';
      mailbox.releaseError = '';
    }
    return {
      mailbox,
      retained,
      produced,
      targetTouched,
      addressSpent,
      reservationPending: mailboxReservationReconciliationPending(mailbox),
      alreadyReleased: mailbox.status === 'released' || mailbox.lifecycle === 'released',
    };
  });
  if (rentalMailChannel(context.config)) {
    const forceCancel = options.forceCancel === true;
    const releasableRentals = records.filter(({ mailbox, retained, produced, targetTouched, addressSpent, reservationPending, alreadyReleased }) => (
      mailbox.rented === true
      && !alreadyReleased
      && !(options.preserveReservationPending === true && reservationPending)
      && !mailbox.rentalClosed
      && rentalCleanupDue(mailbox, 'cancel', context)
      && (mailbox.normalComplete || forceCancel)
      && !retained
      && !produced
      && (forceCancel || !targetTouched || !addressSpent)
    ));
    if (releasableRentals.length && !context.mailClient) {
      try {
        await ensureMail(context);
      } catch (error) {
        for (const { mailbox } of releasableRentals) {
          const cleanup = beginRentalCleanup(mailbox, 'cancel', context);
          markRentalCleanupPending(mailbox, cleanup, error, context);
        }
        event(context.state, 'mailbox_release_deferred', {
          count: releasableRentals.length,
          message: error.message,
        }, context);
        await context.checkpoint('mail_rental_close_deferred');
        return pendingRentalCleanupCount(context);
      }
    }
    await Promise.all(releasableRentals.map(async ({ mailbox }) => (
      closeRentedMailbox(mailbox, 'cancel', 0, context)
    )));
    return pendingRentalCleanupCount(context);
  }
  // A run that stopped before an account existed gives its address straight
  // back. Only reaching a durable step used to be enough to retire it, which
  // meant a cancel during the verification-code wait — by far the most common
  // way a run ends early — permanently cost one address for nothing.
  const releasable = records
    .filter(({ mailbox, retained, targetTouched, addressSpent, reservationPending, alreadyReleased }) => (
      mailbox.normalComplete
      && !alreadyReleased
      && !(options.preserveReservationPending === true && reservationPending)
      && !retained
      && (!targetTouched || !addressSpent)
    ))
    .map(({ mailbox }) => mailbox);
  // The account side of the flow was reached but no asset came out of it. This
  // address really is gone — OpenAI holds an account on it, so handing it out
  // again only buys a second phone number for a login.
  //
  // Marking it `partial_retained` locally was the whole of the old bookkeeping,
  // and the provider was never told. The mail.com pool deliberately never reaps
  // a claim once registration has started, so each such mailbox stayed `claimed`
  // for good: nine cancels during one debugging session took the pool from 18
  // usable addresses to 8 and left the next 9-Worker run dead at `initializing`.
  // Worse, a cycle whose aliases are pinned can never complete, so the master
  // could never recycle either. Reporting it as spent is both the honest answer
  // and the one that lets the pool heal.
  const burnable = records
    .filter(({ mailbox, retained, targetTouched, addressSpent, reservationPending }) => (
      mailbox.normalComplete && !retained && targetTouched && addressSpent && !mailbox.remoteConsumedAt
      && !(options.preserveReservationPending === true && reservationPending)
    ))
    .map(({ mailbox }) => mailbox);
  const burnSupported = remoteMailboxChannel(context.config);
  if ((releasable.length || (burnable.length && burnSupported)) && !context.mailClient) {
    try { await ensureMail(context); } catch (error) {
      for (const mailbox of releasable) {
        mailbox.status = 'release_pending';
        mailbox.releaseError = error.message;
      }
      for (const mailbox of burnable) mailbox.releaseError = error.message;
      event(context.state, 'mailbox_release_deferred', { count: releasable.length + burnable.length, message: error.message }, context);
      return releasable.length + burnable.length;
    }
  }
  let pending = 0;
  const eventPrefix = remoteMailboxEventPrefix(context);
  // Concurrently. These are independent provider calls against different
  // addresses, and running them one after another made the tail of a run as
  // long as the number of unused mailboxes: three burns at roughly thirty
  // seconds each kept a finished run "running" for a minute and a half after
  // its last account was saved.
  if (burnSupported && typeof context.mailClient?.consumeMailbox === 'function') {
    const burns = await Promise.all(burnable.map(async (mailbox) => {
      try {
        await context.mailClient.consumeMailbox(mailbox.id, {
          note: `run=${context.state.runId};registration_started_without_asset`,
        });
        return { mailbox, error: null };
      } catch (error) {
        return { mailbox, error };
      }
    }));
    // Applied after the fact so the state mutations and the event log stay in
    // a deterministic order regardless of which provider call answered first.
    for (const { mailbox, error } of burns) {
      if (error && !mailboxAlreadyGone(error)) {
        if (remoteRegistrationMailChannel(context.config) && mailboxCleanupRequiresManualReview(error)) {
          recordMailcomCleanupBlock(null, mailbox, context, error);
          continue;
        }
        pending += 1;
        mailbox.releaseError = error.message;
        event(context.state, `${eventPrefix}_mailbox_burn_deferred`, {
          mailboxId: mailbox.id,
          email: mailbox.email,
          message: error.message,
        }, context);
        continue;
      }
      if (error) {
        event(context.state, `${eventPrefix}_mailbox_burn_skipped`, {
          mailboxId: mailbox.id,
          email: mailbox.email,
          message: `邮箱库里已经没有这个地址，视为已消费：${error.message}`,
        }, context);
      }
      mailbox.remoteConsumedAt = nowIso(context);
      mailbox.status = 'consumed';
      mailbox.lifecycle = 'consumed';
      mailbox.registrationState = 'consumed';
      mailbox.releaseError = '';
      event(context.state, `${eventPrefix}_mailbox_burned`, {
        mailboxId: mailbox.id,
        email: mailbox.email,
        message: '任务结束时该邮箱已开始注册但没有产出账号资产，已在邮箱库记为已用，不再发放',
      }, context);
    }
  }
  // Same reason as the burns above: independent calls, so they go out together
  // instead of adding one round trip per unused mailbox to the tail of the run.
  if (typeof context.mailClient?.releaseMailbox === 'function') {
    const releases = await Promise.all(releasable.map(async (mailbox) => {
      try {
        await context.mailClient.releaseMailbox(mailbox.id);
        return { mailbox, error: null };
      } catch (error) {
        return { mailbox, error };
      }
    }));
    for (const { mailbox, error } of releases) {
      if (error && !mailboxAlreadyGone(error)) {
        if (remoteRegistrationMailChannel(context.config) && mailboxCleanupRequiresManualReview(error)) {
          recordMailcomCleanupBlock(null, mailbox, context, error);
          continue;
        }
        pending += 1;
        mailbox.status = 'release_pending';
        mailbox.lifecycle = 'release_pending';
        mailbox.releaseError = error.message;
        event(context.state, 'mailbox_release_deferred', { mailboxId: mailbox.id, message: error.message }, context);
        continue;
      }
      // Nothing to give back to a pool that has already forgotten it.
      if (error) {
        event(context.state, 'mailbox_release_skipped', {
          mailboxId: mailbox.id,
          message: `邮箱库里已经没有这个地址，无需归还：${error.message}`,
        }, context);
      }
      mailbox.status = 'released';
      mailbox.lifecycle = 'released';
      mailbox.registrationState = 'not_started';
      mailbox.registrationStartedAt = '';
      mailbox.releasedAt = nowIso(context);
      mailbox.releaseError = '';
      if (mailbox.reservation) {
        mailbox.reservation.effect = null;
        mailbox.reservation.releasedAt = mailbox.releasedAt;
      }
    }
  }
  return pending;
}

async function cancelBranchState(state, config, options = {}) {
  const context = makeContext(options.har || { log: { entries: [] } }, state, config, options);
  let pendingSms = 0;
  for (const job of state.jobs) {
    const previousError = job.error;
    const cancellationCleanupError = previousError?.code === 'SMS_CLEANUP_PENDING'
      && previousError.message === 'SMS activation cleanup is pending';
    job.nextRunAt = '';
    const unresolvedAcquisition = clone(job.sms?.acquisition);
    const cleaned = await cleanupSms(job, context, options.reason || 'task_cancelled');
    const abandoned = !cleaned
      && unresolvedAcquisition
      && !job.sms?.current
      && abandonUnresolvedSmsAcquisition(job, context, options.reason || 'task_cancelled');
    if (!cleaned && !abandoned) {
      pendingSms += 1;
      job.status = 'waiting';
      job.phase = SMS_CLEANUP_PHASE;
      if (!previousError) {
        job.error = { code: 'SMS_CLEANUP_PENDING', message: 'SMS activation cleanup is pending' };
      }
      continue;
    }
    if (abandoned || job.sms?.externalCleanupRequired) {
      if (!previousError) {
        job.error = {
          code: 'SMS_EXTERNAL_CLEANUP_REVIEW',
          message: 'Local task cancellation completed; provider-side SMS outcome requires manual review',
        };
      }
    } else if (!previousError || cancellationCleanupError) {
      job.error = null;
    }
    if (!TERMINAL_JOB_STATUSES.has(job.status)) {
      job.status = 'cancelled';
      job.phase = 'cancelled';
    }
  }
  for (const worker of state.workers) {
    releaseBranchWorkerProxy(worker, context, options.reason || 'task_cancelled');
    worker.status = 'idle';
    worker.currentJobId = '';
    worker.mailboxId = null;
  }
  // A cancellation can arrive after account creation but before the normal
  // finalization pass. Settle those produced accounts first; only empty lanes
  // go through the cancellation path below.
  await settleFinishedRentals(context, { forceClose: true });
  // Mail rentals are independent from SMS leases. A mailbox that has not
  // produced an account can be cancelled immediately even while a phone lease
  // is waiting for its own provider cleanup; the two resources must not keep
  // each other in `waiting_resource_cleanup`.
  const pendingMailboxes = await releaseUnusedMailboxes(context, {
    includeUnstarted: true,
    forceCancel: true,
  });
  const pending = pendingSms + pendingMailboxes;
  state.cancelPending = pending > 0;
  // Same reason as `branch_complete`: a cancelled run is not still renting.
  // A run still draining its resources keeps its wait, because that one is true.
  if (!pending) {
    state.normalWait = null;
    state.mailRentalRetry = null;
  }
  state.status = pending ? 'waiting' : 'cancelled';
  state.phase = pending ? 'waiting_resource_cleanup' : 'cancelled';
  state.lastError = pending ? { code: 'RESOURCE_CLEANUP_PENDING', message: `${pending} resource cleanup operation(s) remain` } : null;
  state.control.requestedAction = null;
  state.updatedAt = nowIso(context);
  await context.checkpoint(pending ? 'branch_cancel_cleanup_pending' : 'branch_cancelled');
  return state;
}

async function skipBranchJob(state, config, jobId, options = {}) {
  const context = makeContext(options.har || { log: { entries: [] } }, state, config, options);
  const job = state.jobs.find((candidate) => candidate.id === jobId);
  if (!job) throw Object.assign(new Error(`Branch job not found: ${jobId}`), { code: 'JOB_NOT_FOUND' });
  if (TERMINAL_JOB_STATUSES.has(job.status)) throw Object.assign(new Error(`Branch job is already terminal: ${job.status}`), { code: 'JOB_TERMINAL' });
  const reason = options.reason || 'job_skipped';
  requestJobSkip(job, { reason, requestedAt: nowIso(context) });
  // A manual skip supersedes any retry that was booked before the operator
  // paused the run. Keep the job in the cleanup lane until SMS cleanup settles;
  // never let the old timer send it back through registration.
  const cleaned = await cleanupSms(job, context, reason);
  if (!cleaned) {
    job.status = 'waiting';
    job.phase = SMS_CLEANUP_PHASE;
    job.error = { code: 'SMS_CLEANUP_PENDING', message: 'SMS activation cleanup is pending before this job can be skipped' };
    await context.checkpoint('branch_job_skip_cleanup_pending');
    return state;
  }
  markJobSkipped(job, {
    code: 'JOB_SKIPPED',
    message: reason,
    updatedAt: nowIso(context),
  });
  await context.checkpoint('branch_job_skipped');
  return state;
}

function staleMfaCompletionCheckpoint(job = {}) {
  return job.sessionState?.step === 'auth_completed'
    && (String(job.sessionState.pageType || '').toLowerCase() === 'mfa_challenge'
      || /\/mfa-challenge(?:\/|$)/i.test(String(job.sessionState.continueUrl || '')));
}

function persistedAccountSelectionProxyId(state, job) {
  const direct = String(job.proxyId || job.proxy?.id || '');
  if (direct) return direct;
  const affectedJobs = (state.jobs || []).filter((candidate) => accountSelectionTransportFailure(candidate.error || {}));
  const matchingEvent = [...(state.events || [])].reverse().find((record) => (
    record.proxyId
    && record.type === 'worker_proxy_rejected'
    && record.code === 'OAUTH_ACCOUNT_SELECT_TRANSPORT_FAILED'
    && (record.jobId === job.id || (!record.jobId && affectedJobs.length === 1))
  ));
  if (matchingEvent?.proxyId) return String(matchingEvent.proxyId);
  const healthMatches = Object.entries(state.proxyHealth || {})
    .filter(([, health]) => (
      health?.reason === 'OAUTH_ACCOUNT_SELECT_TRANSPORT_FAILED'
    ))
    .map(([proxyId]) => proxyId);
  return healthMatches.length === 1 ? String(healthMatches[0]) : '';
}

function migratePersistedAccountSelectionTransportFailure(state, job) {
  if (!accountSelectionTransportFailure(job.error || {})) return false;
  job.error.code = 'OAUTH_ACCOUNT_SELECT_TRANSPORT_FAILED';
  job.error.message = 'OAuth account selection failed at the proxy or transport boundary';
  const proxyId = persistedAccountSelectionProxyId(state, job);
  state.proxyHealth = state.proxyHealth || {};
  state.proxyLeases = state.proxyLeases || {};
  let health = null;
  if (proxyId && !maintenanceProxyForState(state, proxyId, job.proxy)) {
    health = markAccountSelectionProxyFailed(state, proxyId, new Date().toISOString());
  }
  for (const worker of state.workers || []) {
    if (proxyId && worker.proxyId !== proxyId) continue;
    if (!proxyId && worker.currentJobId !== job.id) continue;
    delete state.proxyLeases[worker.id];
    worker.proxy = null;
    worker.proxyId = '';
  }
  job.proxy = null;
  job.proxyId = '';
  if (job.workerAffinity) job.workerAffinity.proxyId = '';
  job.oauthState = null;
  state.events = Array.isArray(state.events) ? state.events : [];
  state.events.push({
    at: new Date().toISOString(),
    type: 'oauth_account_selection_transport_migrated',
    jobId: job.id,
    proxyId,
    proxyStatus: health?.status || '',
    failureCount: health?.accountSelectionFailures || 0,
  });
  return true;
}

function recoverableFailedOAuthJob(state = {}, job = {}) {
  if (job.oauthCooldown === true || job.error?.oauthCooldown === true) return false;
  return state.taskKind === 'oauth'
    && state.runPlan?.oauthSource?.kind === 'session_assets'
    && job.status === 'failed'
    && job.error?.code === 'SESSION_ACCESS_TOKEN_MISSING'
    && Boolean(job.assetId)
    && ['pending', 'in_progress'].includes(job.oauthRecovery?.status)
    && staleMfaCompletionCheckpoint(job);
}

/**
 * A registration that got as far as creating the account, then failed.
 *
 * By the time the ChatGPT callback runs, `create_account` has already
 * succeeded: the account exists upstream and its mailbox is spent. Failing the
 * job outright threw both away for what is usually a bad exit serving an error
 * page. The runner already knows how to resume from the callback or verified
 * session checkpoint, so the only thing missing was letting the resume path
 * see the job.
 */
function recoverableCreatedAccountJob(state = {}, job = {}) {
  if (job.status !== 'failed') return false;
  if (!REGISTRATION_TASK_KINDS.has(state.taskKind)) return false;
  if (job.sessionAssetId) return false;
  const step = String(job.sessionState?.step || '');
  const created = job.sessionState?.accountCreated === true
    || Boolean(job.accountCreatedAt)
    || job.error?.accountCreated === true;
  const creationUncertain = job.sessionState?.createAccountAttempt?.status === 'uncertain';
  if (created) return ['auth_callback_pending', 'auth_completed', 'account_created', 'verified'].includes(step);
  return creationUncertain && ['email_otp_validated', 'account_created'].includes(step);
}

function recoverableEmailJob(state = {}, job = {}) {
  if (job.oauthCooldown === true || job.error?.oauthCooldown === true) return false;
  if (job.status !== 'failed') return false;
  if (!BRANCH_TASK_KINDS.has(state.taskKind)) return false;
  if (!job.mailboxId || job.sessionAssetId) return false;
  const errorCode = String(job.error?.code || '').toUpperCase();
  const sendRecovery = String(job.sessionState?.emailOtpSendRecovery?.status || '');
  return ['EMAIL_OTP_TIMEOUT', 'EMAIL_PROVIDER_TIMEOUT'].includes(errorCode)
    || job.emailOtpRecovery?.action === 'fresh_code'
    || ['uncertain', 'reconciling', 'retrying'].includes(sendRecovery);
}

function oauthCooldownForJob(state = {}, job = {}, options = {}) {
  if (state.taskKind !== 'oauth' || state.runPlan?.oauthSource?.kind !== 'session_assets') return null;
  const assetId = String(job?.assetId || job?.sessionAssetId || '').trim();
  const store = options.assetStore;
  if (!assetId || typeof store?.get !== 'function') return null;
  let asset;
  try {
    asset = store.get(assetId);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const now = typeof options.now === 'function'
    ? options.now
    : (typeof store.now === 'function' ? store.now.bind(store) : Date.now);
  if (!oauthCooldownActive(asset, now)) return null;
  return {
    assetId,
    email: String(asset.email || job.email || ''),
    cooldownUntil: String(asset.oauthCooldown?.until || ''),
    failureCount: Number(asset.oauthCooldown?.failureCount || 0),
  };
}

function terminalizeOAuthCooldownJob(state, job, options = {}) {
  const cooldown = oauthCooldownForJob(state, job, options);
  if (!cooldown || TERMINAL_JOB_STATUSES.has(job.status)) return false;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const message = `OAuth login-state asset is cooling down until ${cooldown.cooldownUntil}`;
  job.nextRunAt = '';
  job.retry = null;
  job.completedAt = '';
  if (job.sms?.current || job.sms?.acquisition) {
    requestJobSkip(job, {
      reason: 'OAUTH_ASSET_COOLDOWN',
      requestedAt: new Date(now()).toISOString(),
    });
    job.skipPending = {
      ...job.skipPending,
      terminalStatus: 'failed',
      code: 'OAUTH_ASSET_COOLDOWN',
      message,
    };
    job.status = 'waiting';
    job.phase = SMS_CLEANUP_PHASE;
  } else {
    job.status = 'failed';
    job.phase = 'failed';
    job.skipPending = null;
  }
  job.error = {
    code: 'OAUTH_ASSET_COOLDOWN',
    message,
    cooldownUntil: cooldown.cooldownUntil,
    failureCount: cooldown.failureCount,
  };
  state.events = Array.isArray(state.events) ? state.events : [];
  state.events.push({
    at: new Date(now()).toISOString(),
    type: 'oauth_cooldown_job_terminalized',
    jobId: job.id,
    assetId: cooldown.assetId,
    cooldownUntil: cooldown.cooldownUntil,
    cleanupPending: Boolean(job.skipPending),
    message: job.skipPending
      ? 'OAuth cooldown stopped this job; SMS cleanup remains before the failed terminal state'
      : 'OAuth cooldown stopped this job before it could be retried',
  });
  return true;
}

function terminalizeStaleMaintenanceWait(state, job, options = {}) {
  if (job.status !== 'waiting' || job.phase !== MAINTENANCE_PROXY_PHASE || scheduledAt(job) !== null) return false;
  const attempts = Number(job.retry?.attempts || 0);
  if (!Number.isFinite(attempts) || attempts < 1) return false;
  const error = {
    code: 'CLOUDFLARE_CHALLENGE',
    message: 'The shared local maintenance forwarder retry budget was exhausted',
  };
  const now = typeof options.now === 'function' ? options.now : Date.now;
  job.nextRunAt = '';
  job.retry = null;
  job.error = error;
  if (job.sms?.current || job.sms?.acquisition) {
    requestJobSkip(job, { reason: error.code, requestedAt: new Date(now()).toISOString() });
    job.skipPending = { ...job.skipPending, terminalStatus: 'failed', ...error };
    job.status = 'waiting';
    job.phase = SMS_CLEANUP_PHASE;
  } else {
    job.status = 'failed';
    job.phase = 'failed';
  }
  state.events = Array.isArray(state.events) ? state.events : [];
  state.events.push({
    at: new Date(now()).toISOString(),
    type: 'maintenance_proxy_retry_exhausted',
    jobId: job.id,
    attempts,
    message: error.message,
  });
  return true;
}

function recoverableOAuthProtocolMigrationJob(state = {}, job = {}) {
  const protocol = String(job.oauthState?.oauth?.protocol || '');
  return state.taskKind === 'oauth'
    && state.runPlan?.oauthSource?.kind === 'session_assets'
    && job.status === 'failed'
    && Boolean(job.assetId)
    && job.oauthState?.mode === 'cockpit-oauth'
    && Boolean(protocol)
    && protocol !== CODEX_OAUTH_PROTOCOL
    && !job.oauthState?.tokens
    && !job.cpaPath;
}

async function disposeSessionRunner(runner, job, context) {
  const dispose = typeof runner?.dispose === 'function'
    ? runner.dispose.bind(runner)
    : typeof runner?.disposeSentinelRuntime === 'function'
      ? runner.disposeSentinelRuntime.bind(runner)
      : null;
  if (!dispose) return;
  try {
    await dispose();
  } catch (error) {
    // Cleanup must not replace the authentication error that caused the
    // session attempt to finish. Keep the failure visible in the run log.
    event(context.state, 'session_runner_dispose_failed', {
      jobId: job.id,
      code: String(error?.code || 'SESSION_RUNNER_DISPOSE_FAILED'),
      message: String(error?.message || 'Session runner cleanup failed').slice(0, 240),
    }, context);
  }
}

function retryablePersistedSecurityFailure(failure = {}) {
  return isRetryableSecurityFailure(failure);
}

function recoverableSecurityJob(state = {}, job = {}) {
  if (!['register_session', 'session_refresh'].includes(state.taskKind)) return false;
  if (job.status !== 'partial' || !job.sessionState || !Boolean(job.assetId || job.sessionAssetId)) return false;
  const security = job.sessionState.security || {};
  if (security.passwordStatus === 'retry_pending' || security.totpStatus === 'retry_pending') return true;
  if (['required', 'in_progress', 'retry_pending', 'failed'].includes(String(security.securityReauth?.status || ''))) return true;
  return (security.failures || []).some(retryablePersistedSecurityFailure);
}

function interruptedTerminalBranchState(state = {}) {
  const status = String(state.status || '').trim().toLowerCase();
  if (!['complete', 'partial', 'failed'].includes(status)) return false;
  if (state.cancelPending === true) return false;
  if (['waiting_resource_cleanup', 'waiting_sms_cleanup', 'waiting_mailbox_cleanup'].includes(
    String(state.phase || '').trim().toLowerCase(),
  )) return false;
  return (state.jobs || []).some((job) => !TERMINAL_JOB_STATUSES.has(job.status));
}

function canResumeBranchState(state = {}) {
  const status = String(state.status || '').trim().toLowerCase();
  // An explicit cancellation is an operator discard decision. A stale
  // security or OAuth checkpoint must not turn the cancelled run into an
  // asset owner or make it resumable again. A cancellation still in progress
  // uses a non-terminal status and keeps its normal resource protection until
  // cleanup finishes.
  if (status === 'cancelled') return false;
  if (!TERMINAL_RUN_STATUSES.has(status)) return true;
  // A worker can persist its job checkpoint just after the run-level status is
  // written. Such a snapshot is terminal on paper but still has live work
  // (for example `waiting_proxy_rotation` or `waiting_mail_rental`). Treat it
  // as an interrupted run so resume can re-queue that work. Cleanup waits are
  // excluded because they must finish cleanup rather than restart the job.
  if (interruptedTerminalBranchState(state)) return true;
  return (state.jobs || []).some((job) => (
    recoverableSecurityJob(state, job)
    // Not gated on `state.status === 'failed'`: a run finishes `partial` when
    // most jobs succeeded, and that is exactly when a stranded created account
    // hides.
    || recoverableCreatedAccountJob(state, job)
    || recoverableEmailJob(state, job)
    || recoverableOAuthPhoneValidationJob(state, job)
    || manualOAuthPhoneValidationRecoveryJob(state, job)
    || (state.status === 'failed' && (
      recoverableFailedOAuthJob(state, job)
      || recoverableOAuthProtocolMigrationJob(state, job)
    ))
  ));
}

// A terminal branch run can be resumable because one job still has a recovery
// checkpoint. Completed jobs in the same batch are no longer part of that
// continuation and must not keep their assets locked.
function resumableBranchAssetIds(state = {}) {
  if (!BRANCH_TASK_KINDS.has(state.taskKind)) return [];
  const ids = new Set();
  const addJobAssets = (job) => {
    for (const id of [job?.assetId, job?.sessionAssetId]) {
      if (id) ids.add(String(id));
    }
  };

  if (!TERMINAL_RUN_STATUSES.has(state.status)) {
    for (const id of state.runPlan?.oauthSource?.assetIds || []) {
      if (id) ids.add(String(id));
    }
    for (const job of state.jobs || []) addJobAssets(job);
    return [...ids];
  }

  if (!canResumeBranchState(state)) return [];
  for (const job of state.jobs || []) {
    const recoverable = !TERMINAL_JOB_STATUSES.has(job.status)
      || recoverableSecurityJob(state, job)
      || recoverableCreatedAccountJob(state, job)
      || recoverableEmailJob(state, job)
      || recoverableOAuthPhoneValidationJob(state, job)
      || manualOAuthPhoneValidationRecoveryJob(state, job)
      || (state.status === 'failed' && (
        recoverableFailedOAuthJob(state, job)
        || recoverableOAuthProtocolMigrationJob(state, job)
      ));
    if (recoverable) addJobAssets(job);
  }
  return [...ids];
}

function resolveSmsAcquisitionOnResume(state, job, options = {}) {
  const resolution = String(options.resolveSmsAcquisition || '').trim().toLowerCase();
  if (!resolution) return false;
  if (resolution !== 'retry') {
    const error = new Error('resolveSmsAcquisition must be "retry"');
    error.code = 'INVALID_SMS_ACQUISITION_RESOLUTION';
    throw error;
  }
  if (job.phase !== 'waiting_sms_acquisition_reconcile' || job.sms?.current || !job.sms?.acquisition) return false;

  const at = new Date().toISOString();
  const acquisition = clone(job.sms.acquisition);
  archiveSmsAcquisitionIntent(state, job, acquisition, {
    at,
    status: 'operator_retry',
    resolution: 'retry',
    reason: 'operator_confirmed_provider_side_outcome',
  });
  job.sms.acquisition = null;
  job.sms.lastAcquisitionResolution = {
    action: 'retry',
    acquisitionId: acquisition.id || '',
    at,
  };
  state.events = Array.isArray(state.events) ? state.events : [];
  state.events.push({
    at,
    type: 'sms_acquisition_retry_authorized',
    jobId: job.id,
    acquisitionId: acquisition.id || '',
    reason: 'operator_confirmed_provider_side_outcome',
    message: 'The operator confirmed that the uncertain SMS acquisition was not created; a new acquisition may be requested',
  });
  return true;
}

function resumeBranchState(state, options = {}) {
  // Nothing to reconcile here any more, and that is the point.
  //
  // Failed exits stay retired for the run, including across resume. A resume
  // never re-tests an address that already failed against real traffic; it
  // binds from the remaining snapshot or from a refreshed catalog instead.
  normalizePersistedProxyState(state);
  // A balance stop is the run halting itself, not the operator stopping the
  // rental. Resuming means the account was topped up, so the halt is handed
  // back; an operator's own stop, which predates the halt, is left in place.
  if (state.balanceStop) {
    if (state.balanceStop.adoptedRentalStop === true) {
      state.mailRentalStoppedAt = '';
      if (state.mailRentalWatch?.enabled) {
        state.mailRentalWatch.autoStopped = false;
        state.mailRentalWatch.stoppedAt = '';
      }
    }
    state.balanceStop = null;
  }
  const recoverableTerminalFailure = TERMINAL_RUN_STATUSES.has(state.status) && canResumeBranchState(state);
  if (TERMINAL_RUN_STATUSES.has(state.status) && !recoverableTerminalFailure) {
    throw new Error(`Cannot resume terminal branch task: ${state.status}`);
  }
  const requestedJobIds = [...new Set((Array.isArray(options.jobIds) ? options.jobIds : [options.jobId])
    .map((jobId) => String(jobId || '').trim())
    .filter(Boolean))];
  const hasRequestedJobs = requestedJobIds.length > 0;
  const requestedJobIdSet = new Set(requestedJobIds);
  const jobs = hasRequestedJobs
    ? state.jobs.filter((candidate) => requestedJobIdSet.has(String(candidate.id || '')))
    : state.jobs;
  if (hasRequestedJobs && jobs.length !== requestedJobIds.length) {
    const found = new Set(jobs.map((job) => String(job.id || '')));
    const missing = requestedJobIds.filter((jobId) => !found.has(jobId));
    const error = new Error(`Branch job not found: ${missing.join(', ')}`);
    error.code = 'JOB_NOT_FOUND';
    error.jobIds = missing;
    throw error;
  }
  if (hasRequestedJobs && options.resolveSmsAcquisition) {
    const invalidJob = jobs.find((job) => !(
      job.phase === 'waiting_sms_acquisition_reconcile'
      && !job.sms?.current
      && job.sms?.acquisition
    ));
    if (invalidJob) {
      const error = new Error(`SMS acquisition is no longer waiting for reconciliation: ${invalidJob.id}`);
      error.code = 'SMS_ACQUISITION_NOT_WAITING';
      error.jobId = invalidJob.id;
      throw error;
    }
  }
  const interruptedRun = interruptedTerminalBranchState(state);
  for (const job of jobs) {
    resolveSmsAcquisitionOnResume(state, job, options);
    if (!job.skipPending && terminalizeOAuthCooldownJob(state, job, options)) continue;
    if (job.skipPending) {
      // A pending operator skip is a cleanup-only lane. An old retry timer or
      // a paused status must never turn it back into registration work.
      job.status = 'waiting';
      job.phase = SMS_CLEANUP_PHASE;
      job.nextRunAt = '';
      job.retry = null;
      job.error = { code: 'SMS_CLEANUP_PENDING', message: 'SMS activation cleanup is pending before this job can be skipped' };
      continue;
    }
    if (terminalizeStaleMaintenanceWait(state, job, options)) continue;
    const transportRecovery = ensureProxyTransportRecovery(job);
    const callbackPending = createdAccountCallbackPending(job);
    ensureAuthCallbackProxyRecovery(job);
    if (callbackPending && (transportRecovery.pending || transportRecovery.attempted)) {
      // This marker belongs to the old one-shot transport lane. A created
      // account now resumes through the callback-specific proxy budget.
      transportRecovery.pending = false;
      transportRecovery.attempted = false;
      transportRecovery.attemptedAt = '';
      transportRecovery.resumedAt = new Date().toISOString();
      state.events = Array.isArray(state.events) ? state.events : [];
      state.events.push({
        at: transportRecovery.resumedAt,
        type: 'auth_callback_proxy_recovery_migrated',
        jobId: job.id,
        message: 'The created-account callback was moved from one-shot transport recovery to its bounded proxy retry policy',
      });
    } else if (transportRecovery.pending) {
      transportRecovery.pending = false;
      transportRecovery.resumedAt = new Date().toISOString();
      state.events = Array.isArray(state.events) ? state.events : [];
      state.events.push({
        at: transportRecovery.resumedAt,
        type: 'proxy_transport_recovery_resumed',
        jobId: job.id,
        attempt: transportRecovery.failureCount,
        message: 'The proxy refresh recovery was consumed; this account gets one continuation attempt',
      });
    }
    if (proxyRuntimeTransportFailure(job.error)) {
      const proxyId = String(job.proxyId || '');
      const historicalCount = persistedProxyFailureCount(state, job);
      const maintenance = maintenanceProxyForState(state, proxyId, job.proxy);
      const health = maintenance
        ? null
        : markProxyFailed(state, proxyId, job.error, new Date().toISOString(), { historicalCount });
      state.events = Array.isArray(state.events) ? state.events : [];
      if (health && !(state.events || []).some((record) => (
        record.type === 'worker_proxy_rejected'
        && record.jobId === job.id
        && record.code === job.error.code
        && record.failureCount === health.transportFailureCount
      ))) {
        const worker = (state.workers || []).find((candidate) => candidate.proxyId === proxyId);
        state.events.push({
          at: new Date().toISOString(),
          type: 'worker_proxy_rejected',
          workerId: worker?.id || '',
          jobId: job.id,
          proxyId,
          code: job.error.code || 'PROXY_TRANSPORT_FAILURE',
          failureCount: health.transportFailureCount,
          reason: 'persisted_runtime_transport_failure',
        });
      }
    }
    const previousPhase = job.phase;
    const recoverablePhoneState = recoverableOAuthPhoneSendStateError(job, job.error);
    const recoverablePhoneStateCode = smsErrorCode(job.error);
    const recoverablePhoneValidation = recoverableOAuthPhoneValidationJob(state, job);
    const recoverablePhoneValidationCode = smsErrorCode(job.error);
    const manualPhoneValidation = manualOAuthPhoneValidationRecoveryJob(state, job);
    // Any phase may hold a future in-run retry, not just SMS inventory; an
    // operator resume must not cancel one that has not come due yet.
    const scheduledRetry = job.status === 'waiting'
      && scheduledAt(job) !== null
      && scheduledAt(job) > nowMs(options);
    const recoverableMfaFailure = recoverableTerminalFailure && recoverableFailedOAuthJob(state, job);
    const recoverableProtocolFailure = recoverableTerminalFailure
      && recoverableOAuthProtocolMigrationJob(state, job);
    const recoverableSecurityFailure = recoverableTerminalFailure && recoverableSecurityJob(state, job);
    if (manualPhoneValidation && !scheduledRetry) {
      const restarted = resetOAuthPhoneValidationTransaction(job, {}, job.error, {
        ...options,
        manual: true,
      });
      if (restarted) {
        job.status = 'queued';
        job.phase = 'resuming_oauth_phone_validation_manual';
        job.error = null;
        job.completedAt = '';
        job.nextRunAt = '';
        job.retry = null;
        job.updatedAt = restarted.at;
        state.events = Array.isArray(state.events) ? state.events : [];
        state.events.push({
          at: restarted.at,
          type: 'oauth_phone_validation_manual_restart_requested',
          jobId: job.id,
          activationId: restarted.activationId,
          attempt: restarted.attempt,
          manualAttempt: job.oauthPhoneValidationRecovery.manualRestarts,
          previousState: restarted.previousState,
          nextState: restarted.nextState,
          reason: 'operator_resumed_manual_phone_validation',
          message: 'The operator resumed the ambiguous OAuth phone checkpoint; a fresh OAuth transaction will decide acceptance without replaying the old code',
        });
        continue;
      }
    }
    if (recoverablePhoneValidation && !scheduledRetry) {
      const restarted = resetOAuthPhoneValidationTransaction(job, {}, job.error, options);
      if (restarted) {
        job.status = 'queued';
        job.phase = 'resuming_oauth_phone_validation';
        job.error = null;
        job.completedAt = '';
        job.nextRunAt = '';
        job.retry = null;
        job.updatedAt = restarted.at;
        state.events = Array.isArray(state.events) ? state.events : [];
        state.events.push({
          at: restarted.at,
          type: 'oauth_phone_validation_recovery_started',
          jobId: job.id,
          activationId: restarted.activationId,
          attempt: restarted.attempt,
          previousState: restarted.previousState,
          nextState: restarted.nextState,
          code: recoverablePhoneValidationCode,
          reason: 'persisted_ambiguous_phone_validation',
          message: 'The waiting OAuth phone validation checkpoint was rebuilt with a fresh OAuth transaction',
        });
        continue;
      }
    }
    if (recoverableEmailJob(state, job)) {
      job.status = 'queued';
      job.phase = 'resuming_email_otp';
      job.error = null;
      job.completedAt = '';
      job.nextRunAt = '';
      job.retry = null;
      job.updatedAt = new Date().toISOString();
      state.events = Array.isArray(state.events) ? state.events : [];
      state.events.push({
        at: job.updatedAt,
        type: 'email_otp_recovery_queued',
        jobId: job.id,
        message: 'The mailbox is retained and the email OTP checkpoint will be retried',
      });
      continue;
    }
    // Re-queued rather than repaired: the runner picks `auth_callback_pending`
    // up at the top of `run()` and either verifies the session or follows the
    // continuation again, this time on whatever exit the Worker binds next.
    if (recoverableCreatedAccountJob(state, job)) {
      job.status = 'queued';
      job.phase = 'resuming_created_account';
      job.error = null;
      job.completedAt = '';
      job.nextRunAt = '';
      job.retry = null;
      job.updatedAt = new Date().toISOString();
      state.events = Array.isArray(state.events) ? state.events : [];
      state.events.push({
        at: job.updatedAt,
        type: 'created_account_recovery_queued',
        jobId: job.id,
        message: 'The account was already created; the run resumes from the callback instead of discarding it',
      });
      continue;
    }
    const recovery = ensureOAuthRecovery(job);
    const migratedTransportFailure = migratePersistedAccountSelectionTransportFailure(state, job);
    const normalizedRecoveryReason = oauthLoginRepairReason({
      code: recovery.reason,
      status: recovery.lastError?.status,
    });
    if (normalizedRecoveryReason) recovery.reason = normalizedRecoveryReason;
    if (staleMfaCompletionCheckpoint(job)) {
      job.sessionState.step = 'mfa_required';
      job.sessionState.status = 'running';
      recovery.reason = 'oauth_mfa_required';
      recovery.lastError = {
        ...(recovery.lastError || {}),
        code: String(job.error?.code || recovery.lastError?.code || 'OAUTH_MFA_REQUIRED'),
        authPageType: 'mfa_challenge',
        authStep: 'mfa_required',
      };
      state.events = Array.isArray(state.events) ? state.events : [];
      state.events.push({
        at: new Date().toISOString(),
        type: 'session_mfa_checkpoint_migrated',
        jobId: job.id,
        reason: 'auth_completed_checkpoint_was_still_on_mfa_challenge',
      });
    }
    const uncertainAccountSelection = [
      'OAUTH_ACCOUNT_SELECT_FAILED',
      'OAUTH_ACCOUNT_SELECTION_REJECTED',
      'OAUTH_ACCOUNT_SELECT_TRANSPORT_FAILED',
      'OAUTH_ACCOUNT_SELECT_HTTP_FAILED',
    ].includes(job.error?.code)
      && (migratedTransportFailure || job.oauthState?.mode === 'cockpit-oauth')
      && !job.oauthState?.oauthCode
      && !job.oauthState?.tokens
      && !job.sms?.current;
    if (uncertainAccountSelection) {
      job.oauthState = null;
      state.events = Array.isArray(state.events) ? state.events : [];
      const sessionAssetSource = state.runPlan?.oauthSource?.kind === 'session_assets' || Boolean(job.assetId);
      const repairReason = oauthLoginRepairReason(job.error);
      const loginRepairQueued = sessionAssetSource && repairReason
        ? queueOAuthLoginRepair(job, job.error, new Date().toISOString())
        : false;
      state.events.push({
        at: new Date().toISOString(),
        type: 'oauth_account_selection_reset',
        jobId: job.id,
        reason: 'uncertain_account_selection_outcome',
        loginRepairQueued,
      });
    }
    if (recoverablePhoneState) {
      const restarted = resetOAuthPhoneSendTransaction(job, {}, job.error, options);
      job.status = 'queued';
      job.phase = 'resuming_oauth_phone_transaction';
      job.error = null;
      job.completedAt = '';
      job.updatedAt = restarted.at;
      state.events = Array.isArray(state.events) ? state.events : [];
      state.events.push({
        at: restarted.at,
        type: 'oauth_phone_transaction_restarted',
        jobId: job.id,
        activationId: restarted.activationId,
        attempt: restarted.attempt,
        code: recoverablePhoneStateCode,
        reason: 'persisted_pre_send_authorization_state_error',
        message: 'Persisted OAuth phone transaction was rebuilt; the unsent SMS lease and Worker affinity were retained',
      });
    } else if (recoverableSecurityFailure) {
      const failures = job.sessionState.security?.failures || [];
      const passwordFailure = failures.find((failure) => failure.feature === 'password' && retryablePersistedSecurityFailure(failure));
      const totpFailure = failures.find((failure) => failure.feature === 'totp' && retryablePersistedSecurityFailure(failure));
      armSecurityRetry(job);
      job.status = 'queued';
      job.phase = 'resuming_security';
      job.error = null;
      job.completedAt = '';
      job.updatedAt = new Date().toISOString();
      state.events = Array.isArray(state.events) ? state.events : [];
      state.events.push({
        at: job.updatedAt,
        type: 'security_setup_resume_queued',
        jobId: job.id,
        password: Boolean(passwordFailure),
        totp: Boolean(totpFailure),
        reason: 'retryable_security_transport_failure',
      });
    } else if (recoverableProtocolFailure) {
      const staleProtocol = String(job.oauthState?.oauth?.protocol || '');
      job.oauthState = null;
      job.status = 'queued';
      job.phase = 'resuming_oauth_protocol';
      job.error = null;
      job.completedAt = '';
      job.updatedAt = new Date().toISOString();
      state.events = Array.isArray(state.events) ? state.events : [];
      state.events.push({
        at: job.updatedAt,
        type: 'oauth_protocol_checkpoint_discarded',
        jobId: job.id,
        staleProtocol,
        nextProtocol: CODEX_OAUTH_PROTOCOL,
        reason: 'non_cockpit_oauth_transaction',
      });
    } else if (recoverableMfaFailure) {
      job.status = 'queued';
      job.phase = 'resuming_mfa';
      job.error = null;
      job.completedAt = '';
      job.updatedAt = new Date().toISOString();
    } else if (!state.cancelPending && (job.status === 'running' || job.status === 'waiting' || job.phase === 'paused')) {
      if (!scheduledRetry) {
        job.status = 'queued';
        if (interruptedRun || hasRequestedJobs) {
          job.phase = 'queued';
          job.error = null;
          job.completedAt = '';
        }
        job.nextRunAt = '';
        // An operator resume is an explicit "try again now", so the in-run
        // retry budget starts over rather than resuming already spent.
        job.retry = null;
        if (previousPhase === SMS_INVENTORY_EXHAUSTED_PHASE && job.sms) {
          job.sms.inventoryStartedAt = '';
          job.sms.inventoryPollCount = 0;
          job.sms.inventoryExhaustedAt = '';
        }
      }
    }
  }
  if (!hasRequestedJobs) {
    for (const worker of state.workers) {
      worker.status = 'idle';
      worker.currentJobId = '';
      worker.mailboxId = null;
    }
  }
  state.status = 'initialized';
  state.phase = 'resuming';
  if (recoverableTerminalFailure) {
    state.completedAt = '';
    state.lastError = null;
  }
  state.control = {
    ...state.control,
    requestedAction: null,
    resumedAt: new Date().toISOString(),
    ...(hasRequestedJobs ? {} : { pendingJobRetries: [] }),
  };
  return state;
}

function legacyExistingAccountSignal(job = {}) {
  const runner = job.runner || {};
  if (runner.blocked?.step !== 'user_register') return false;
  if (!/\/log-in\/password/i.test(String(runner.lastContinueUrl || ''))) return false;
  const lastRegister = [...(runner.events || [])].reverse().find((item) => item.step === 'user_register');
  let responseCode = '';
  try { responseCode = JSON.parse(lastRegister?.textPreview || '{}')?.error?.code || ''; } catch { /* Use persisted job error. */ }
  const jobCode = String(job.error?.code || '').toLowerCase();
  return jobCode === 'existing_account_detected'
    || jobCode === 'invalid_auth_step'
    || String(responseCode).toLowerCase() === 'invalid_auth_step';
}

function canMigrateLegacyRegisterOAuthState(state = {}) {
  if (state.taskKind || !Array.isArray(state.jobs) || state.jobs.length === 0) return false;
  if (TERMINAL_RUN_STATUSES.has(state.status)) return false;
  if (!state.jobs.some((job) => legacyExistingAccountSignal(job))) return false;
  return state.jobs.every((job) => {
    const events = job.runner?.events || [];
    const created = events.some((item) => item.step === 'create_account' && Number(item.status) >= 200 && Number(item.status) < 300);
    const hasSmsHistory = Boolean(job.sms?.current) || (job.sms?.attempts || []).length > 0;
    const hasOutput = Boolean(job.accountCreatedAt || job.cpaPath || job.tokens || created);
    return !TERMINAL_JOB_STATUSES.has(job.status) && !hasSmsHistory && !hasOutput;
  });
}

function migrateLegacyRegisterOAuthState(state, options = {}) {
  if (!canMigrateLegacyRegisterOAuthState(state)) {
    const error = new Error('Legacy run is not safe to migrate into the dynamic registration flow');
    error.code = 'LEGACY_RUN_MIGRATION_UNSAFE';
    throw error;
  }
  const at = nowIso(options);
  const workerCount = Math.max(1, Number(state.runPlan?.workerConcurrency || state.workers?.length || 1));
  state.taskKind = 'register_oauth';
  state.runPlan = {
    ...(state.runPlan || {}),
    taskKind: 'register_oauth',
    security: { setPassword: false, enrollTotp: false, ...(state.runPlan?.security || {}) },
  };
  state.mailboxes = (state.mailboxes || []).map((mailbox) => ({
    id: mailbox.id,
    email: mailbox.rootEmail || mailbox.email,
    rootEmail: mailbox.rootEmail || mailbox.email,
    status: 'reserved',
    workerId: '',
    targetCount: Number(mailbox.targetCount || 1),
    maxAttempts: Number(mailbox.maxAttempts || 1),
    attemptCount: Number(mailbox.attemptCount || 1),
    createdCount: 0,
    cpaCompletedCount: 0,
    normalComplete: false,
    targetTouched: true,
    targetTouchedAt: mailbox.targetTouchedAt || at,
  }));
  state.jobs = state.jobs.map((job) => ({
    id: job.id,
    taskKind: 'register_oauth',
    email: job.email,
    parentEmail: job.parentEmail || job.email,
    mailboxId: job.mailboxId,
    laneId: String(job.mailboxId || job.parentEmail || job.email).toLowerCase(),
    assetId: '',
    aliasIndex: Number(job.aliasIndex || 1),
    status: 'queued',
    phase: 'queued',
    branch: 'register_oauth',
    proxy: null,
    proxyId: '',
    sessionState: null,
    sessionVerifiedAt: '',
    oauthState: null,
    accountCreatedAt: '',
    sessionAssetId: '',
    cpaPath: '',
    cpaRevision: 0,
    cpaSuperseded: false,
    sms: { current: null, attempts: [], costUsd: 0, replacements: 0, sendRetries: 0 },
    error: null,
    targetTouchedAt: at,
    targetDisposition: 'existing_account',
    legacyRecovery: {
      migratedAt: at,
      previousPhase: job.phase || '',
      previousErrorCode: job.error?.code || '',
    },
    createdAt: job.createdAt || state.createdAt,
    updatedAt: at,
  }));
  state.workers = Array.from({ length: workerCount }, (_, index) => ({
    id: `worker-${index + 1}`,
    slot: index + 1,
    status: 'idle',
    mailboxId: null,
    proxyId: '',
    proxy: null,
    currentJobId: '',
    laneId: '',
    completedRoots: 0,
    createdAt: state.createdAt,
    updatedAt: at,
  }));
  state.proxyLeases = {};
  state.proxyHealth = {};
  state.proxyCandidates = [];
  state.finalizationQueue = [];
  state.smsMarkets = {};
  state.externalCleanup = [];
  state.status = 'initialized';
  state.phase = 'resuming';
  state.lastError = null;
  state.normalWait = null;
  state.cancelPending = false;
  state.control = { ...(state.control || {}), requestedAction: null, requestedAt: '', resumedAt: at };
  state.events = Array.isArray(state.events) ? state.events : [];
  state.events.push({
    at,
    type: 'legacy_register_oauth_migrated',
    jobs: state.jobs.length,
    message: 'Legacy fixed registration checkpoint migrated to the dynamic login-or-signup flow',
  });
  if (state.preflight) {
    state.preflight = { ...state.preflight, taskKind: 'register_oauth', plan: state.runPlan };
  }
  state.updatedAt = at;
  return state;
}

async function processPendingJobControls(context) {
  for (const job of context.state.jobs.filter((candidate) => candidate.skipPending)) {
    prepareJobForSkip(job);
    const pending = job.skipPending;
    const reason = pending.reason || 'job_skipped';
    const cleaned = await cleanupSms(job, context, reason);
    if (!cleaned) {
      job.status = 'waiting';
      job.phase = SMS_CLEANUP_PHASE;
      continue;
    }
    if (pending.terminalStatus === 'failed') {
      job.status = 'failed';
      job.phase = 'failed';
      job.error = {
        code: String(pending.code || 'BRANCH_JOB_FAILED'),
        message: String(pending.message || reason),
      };
      job.skipPending = null;
      job.updatedAt = nowIso(context);
      event(context.state, 'branch_job_failed', {
        jobId: job.id,
        code: job.error.code,
        message: job.error.message,
      }, context);
      await context.checkpoint('branch_job_failed');
    } else {
      markJobSkipped(job, { code: 'JOB_SKIPPED', message: reason, updatedAt: nowIso(context) });
      if (pending.callbackFailure === true) job.error.callbackFailure = true;
      await context.checkpoint('branch_job_skipped');
    }
  }
}

async function processPendingJobRetries(context) {
  if (context.action()) return 0;
  const persisted = Array.isArray(context.state.control?.pendingJobRetries)
    ? context.state.control.pendingJobRetries
    : [];
  const queued = typeof context.control?.consumeJobRetries === 'function'
    ? context.control.consumeJobRetries()
    : [];
  const requests = new Map();
  for (const request of [...persisted, ...queued]) {
    const jobId = String(request?.jobId || '').trim();
    if (jobId) requests.set(jobId, { ...request, jobId });
  }
  if (!requests.size) return 0;

  context.state.control.pendingJobRetries = [];
  const groups = new Map();
  for (const request of requests.values()) {
    const job = context.state.jobs.find((candidate) => candidate.id === request.jobId);
    if (!job) {
      event(context.state, 'branch_job_retry_rejected', {
        jobId: request.jobId,
        code: 'JOB_NOT_FOUND',
        message: `Branch job not found: ${request.jobId}`,
      }, context);
      continue;
    }
    const resolution = String(request.resolveSmsAcquisition || '').trim().toLowerCase();
    if (resolution === 'retry' && !(
      job.phase === 'waiting_sms_acquisition_reconcile'
      && !job.sms?.current
      && job.sms?.acquisition
    )) {
      event(context.state, 'branch_job_retry_rejected', {
        jobId: request.jobId,
        code: 'SMS_ACQUISITION_NOT_WAITING',
        message: `SMS acquisition is no longer waiting for reconciliation: ${request.jobId}`,
      }, context);
      continue;
    }
    const key = resolution || '__no_resolution__';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(request);
  }

  for (const requestsInGroup of groups.values()) {
    const resolution = String(requestsInGroup[0]?.resolveSmsAcquisition || '').trim().toLowerCase();
    try {
      resumeBranchState(context.state, {
        jobIds: requestsInGroup.map((request) => request.jobId),
        ...(resolution ? { resolveSmsAcquisition: resolution } : {}),
        assetStore: context.assetStore,
        now: context.now,
      });
      context.state.status = 'running';
      context.state.phase = 'running';
      context.state.lastError = null;
      context.state.normalWait = null;
      for (const request of requestsInGroup) {
        event(context.state, 'branch_job_retry_authorized', {
          jobId: request.jobId,
          resolveSmsAcquisition: String(request.resolveSmsAcquisition || ''),
          message: 'The operator authorized this account to continue from its persisted checkpoint',
        }, context);
      }
    } catch (error) {
      for (const request of requestsInGroup) {
        event(context.state, 'branch_job_retry_rejected', {
          jobId: request.jobId,
          code: String(error?.code || 'JOB_RETRY_REJECTED'),
          message: String(error?.message || 'The account could not be retried'),
        }, context);
      }
    }
  }
  await context.checkpoint('branch_job_retry_requested');
  return requests.size;
}

function fatalErrorRecord(error) {
  return {
    code: String(error?.code || 'BRANCH_RUN_FATAL'),
    message: String(error?.message || error || 'Branch run failed').slice(0, 500),
  };
}

function branchCleanupPendingKeys(context) {
  const keys = new Set();
  const mailboxKey = (id) => `mailbox:${String(id || '').trim()}`;
  for (const job of context.state.jobs) {
    const jobId = String(job.id || '').trim();
    const smsId = String(
      job.sms?.current?.activationId
        || job.sms?.current?.id
        || job.sms?.acquisition?.id
        || job.sms?.acquisition?.activationId
        || '',
    ).trim();
    if (job.sms?.current || job.sms?.acquisition) keys.add(`sms:${jobId}:${smsId}`);
    if (['cleanup_blocked', 'pending', 'unknown', 'manual_review'].includes(
      String(job.remoteMailboxCleanup?.status || ''),
    )) keys.add(mailboxKey(job.mailboxId || jobId));
  }
  for (const mailbox of context.state.mailboxes) {
    const id = String(mailbox.id || '').trim();
    const rentalPending = mailbox.rented === true
      && (!mailbox.rentalClosed
        || mailbox.rentalBillingUncertain === true
        || ['settlement_unknown', 'cleanup_manual_review'].includes(String(mailbox.rentalClosed || '')));
    if (rentalPending) keys.add(`rental:${id}`);
    if (['release_pending', 'cleanup_blocked'].includes(String(mailbox.status || ''))) {
      keys.add(mailbox.rented === true ? `rental:${id}` : mailboxKey(id));
    }
  }
  for (const [index, record] of context.state.externalCleanup.entries()) {
    if (['completed', 'resolved', 'closed'].includes(String(record?.status || '').toLowerCase())) continue;
    const type = String(record?.type || 'external');
    if (type === 'mailcom_mailbox_cleanup') {
      keys.add(mailboxKey(record.mailboxId || record.jobId || index));
    } else if (type === 'sms_activation_terminal_review') {
      keys.add(`sms:${String(record.jobId || '').trim()}:${String(record.activationId || index).trim()}`);
    } else {
      keys.add(`external:${type}:${String(record?.jobId || record?.id || index).trim()}`);
    }
  }
  return keys;
}

function branchCleanupPendingCount(context) {
  return branchCleanupPendingKeys(context).size;
}

function mailboxReservationReconciliationPending(mailbox = {}) {
  return mailbox.status === 'reservation_pending'
    && mailbox.reservation?.effect?.kind === 'mailbox_reserve'
    && mailbox.reservation?.releasedAt == null;
}

function branchReservationReconciliationCount(context) {
  return context.state.mailboxes.filter(mailboxReservationReconciliationPending).length;
}

function requestBranchFatalStop(context, error) {
  const at = nowIso(context);
  context.state.control = {
    ...(context.state.control || {}),
    requestedAction: 'cancel',
    requestedAt: at,
  };
  try {
    if (typeof context.control?.request === 'function') context.control.request('cancel');
  } catch { /* The local abort below still stops runners without a ControlGate. */ }
  try {
    if (!context.control?.signal?.aborted && !context.control?.request
      && !context.fatalAbortController.signal.aborted) {
      context.fatalAbortController.abort(error);
    } else if (!context.fatalAbortController.signal.aborted) {
      context.fatalAbortController.abort(error);
    }
  } catch { /* Cleanup must continue even when an abort listener misbehaves. */ }
}

async function cleanupBranchAfterFatal(context, error, drain) {
  requestBranchFatalStop(context, error);
  await drain();

  const fatal = fatalErrorRecord(error);
  // A reserve request can have succeeded remotely even when its response was
  // lost. Releasing that address here would turn a recoverable bind ambiguity
  // into a permanent leak (and can hand the same address to another run).
  const reservationPending = branchReservationReconciliationCount(context);
  context.state.mailRentalRetry = null;
  context.state.normalWait = null;
  for (const job of context.state.jobs) {
    if (!TERMINAL_JOB_STATUSES.has(job.status)) {
      const previous = job.error && typeof job.error === 'object' ? job.error : {};
      job.status = 'failed';
      job.phase = 'failed';
      job.nextRunAt = '';
      job.retry = null;
      job.completedAt = '';
      job.skipPending = null;
      job.error = {
        code: String(previous.code || fatal.code),
        message: String(previous.message || fatal.message),
        ...(previous.code && previous.code !== fatal.code ? { runErrorCode: fatal.code } : {}),
      };
    }
  }

  let cleanupFailures = 0;
  for (const job of context.state.jobs) {
    try {
      if (!await cleanupSms(job, context, fatal.code)) {
        cleanupFailures += 1;
        job.status = 'waiting';
        job.phase = SMS_CLEANUP_PHASE;
        job.error = {
          code: 'SMS_CLEANUP_PENDING',
          message: 'SMS activation cleanup is pending after the run failed',
          causeCode: fatal.code,
        };
      }
    } catch (cleanupError) {
      cleanupFailures += 1;
      job.status = 'waiting';
      job.phase = SMS_CLEANUP_PHASE;
      job.error = {
        code: 'SMS_CLEANUP_PENDING',
        message: String(cleanupError?.message || cleanupError || 'SMS cleanup failed').slice(0, 300),
        causeCode: fatal.code,
      };
    }
  }

  for (const worker of context.state.workers) {
    try { releaseBranchWorkerProxy(worker, context, 'branch_run_failed'); } catch { /* Best effort. */ }
    worker.status = 'idle';
    worker.currentJobId = '';
    worker.mailboxId = null;
    worker.updatedAt = nowIso(context);
  }

  try {
    await settleFinishedRentals(context, { forceClose: true });
  } catch (cleanupError) {
    cleanupFailures += 1;
    event(context.state, 'branch_fatal_mail_cleanup_failed', {
      code: String(cleanupError?.code || 'MAIL_RENTAL_CLOSE_FAILED'),
      message: String(cleanupError?.message || cleanupError || 'Mailbox cleanup failed').slice(0, 300),
    }, context);
  }
  try {
    await releaseUnusedMailboxes(context, {
      includeUnstarted: true,
      forceCancel: true,
      preserveReservationPending: reservationPending > 0,
    });
  } catch (cleanupError) {
    cleanupFailures += 1;
    event(context.state, 'branch_fatal_mailbox_release_failed', {
      code: String(cleanupError?.code || 'MAILBOX_RELEASE_FAILED'),
      message: String(cleanupError?.message || cleanupError || 'Mailbox release failed').slice(0, 300),
    }, context);
  }
  try {
    await reconcileRemoteMailboxConsumption(context);
  } catch (cleanupError) {
    cleanupFailures += 1;
    event(context.state, 'branch_fatal_remote_mailbox_cleanup_failed', {
      code: String(cleanupError?.code || 'MAILCOM_CLEANUP_FAILED'),
      message: String(cleanupError?.message || cleanupError || 'Remote mailbox cleanup failed').slice(0, 300),
    }, context);
  }

  // Provider cleanup helpers persist their own pending marker before returning
  // control. Count the normalized resource set once; an exception is only a
  // fallback when the helper left no marker behind.
  const cleanupPending = Math.max(cleanupFailures, branchCleanupPendingCount(context));
  const reservationStillPending = branchReservationReconciliationCount(context);
  const pending = cleanupPending + reservationStillPending;
  // `cancelPending` means the next resume should finish a cancellation. A
  // reservation ambiguity is different: resume must reconcile it first, so it
  // must remain a normal resumable wait even when another cleanup is pending.
  context.state.cancelPending = cleanupPending > 0 && reservationStillPending === 0;
  context.state.status = pending ? 'waiting' : 'failed';
  context.state.phase = pending ? 'waiting_resource_cleanup' : 'failed';
  context.state.completedAt = pending ? '' : nowIso(context);
  context.state.lastError = reservationStillPending > 0
    ? {
      code: 'MAILBOX_RESERVATION_PENDING',
      message: `${reservationStillPending} mailbox reservation result(s) require reconciliation before cleanup`,
      ...(cleanupPending > 0 ? { cleanupPending } : {}),
      causeCode: fatal.code,
      causeMessage: fatal.message,
    }
    : (cleanupPending > 0
      ? {
        code: 'RESOURCE_CLEANUP_PENDING',
        message: `${cleanupPending} resource cleanup operation(s) remain after the run failed`,
        causeCode: fatal.code,
        causeMessage: fatal.message,
      }
      : fatal);
  context.state.control = {
    ...(context.state.control || {}),
    requestedAction: null,
  };
  try { context.control?.consume?.('cancel'); } catch { /* The task is already stopped. */ }
  event(context.state, pending ? 'branch_failed_cleanup_pending' : 'branch_failed_cleanup_complete', {
    code: fatal.code,
    pending,
    message: pending
      ? 'The branch stopped after a fatal error; workers are drained and resource cleanup will be retried'
      : 'The branch stopped after a fatal error; workers and provider resources are cleaned up',
  }, context);
  try {
    await context.checkpoint(pending ? 'branch_failed_cleanup_pending' : 'branch_failed');
  } catch { /* The run manager makes one final save after this function returns. */ }
  return pending;
}

/**
 * Reports minutes in which this process could not keep up with its own I/O.
 *
 * Every request through every proxy timing out at once looked like a proxy
 * outage, and the only way to tell it was this process blocking itself was to
 * reconstruct timer lag from the log afterwards. A stall is now logged as it
 * happens, with how many accounts the run holds, so a repeat is obvious.
 */
const EVENT_LOOP_STALL_REPORT_MS = 2000;
const EVENT_LOOP_STALL_WINDOW_MS = 30_000;

function startEventLoopStallMonitor(context, options = {}) {
  // Overridable so a test can watch a short window instead of half a minute.
  const windowMs = Math.max(50, Number(options.eventLoopStallWindowMs) || EVENT_LOOP_STALL_WINDOW_MS);
  const reportMs = Math.max(10, Number(options.eventLoopStallReportMs) || EVENT_LOOP_STALL_REPORT_MS);
  // A plain drift sampler: how late each tick fires is how long the loop was
  // blocked. Measured and reported by the same callback, so a stall can never
  // fall between a sample and a window reset.
  const tickMs = Math.max(10, Math.min(500, Math.floor(windowMs / 4)));
  let expectedAt = performance.now() + tickMs;
  let windowStartedAt = performance.now();
  let windowMaxMs = 0;
  let stalledTicks = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    const lateMs = Math.max(0, now - expectedAt);
    expectedAt = now + tickMs;
    windowMaxMs = Math.max(windowMaxMs, lateMs);
    if (lateMs >= reportMs) stalledTicks += 1;
    if (now - windowStartedAt < windowMs) return;
    if (windowMaxMs >= reportMs) {
      const jobs = context.state.jobs || [];
      const maxMs = Math.round(windowMaxMs);
      event(context.state, 'event_loop_stalled', {
        maxMs,
        stalledTicks,
        windowMs: Math.round(now - windowStartedAt),
        jobs: jobs.length,
        completed: jobs.filter((job) => job.status === 'complete').length,
        message: `This process was blocked for up to ${maxMs}ms in the last ${Math.round((now - windowStartedAt) / 1000)}s; request timeouts in this window are local, not the proxies'`,
      }, context);
    }
    windowStartedAt = now;
    windowMaxMs = 0;
    stalledTicks = 0;
  }, tickMs);
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}

async function runBranchOrchestrator(har, state, config, options = {}) {
  const context = makeContext(har, state, config, options);
  const stopStallMonitor = startEventLoopStallMonitor(context, options);
  // jobId -> promise for every job currently executing.
  const inflight = new Map();
  const drain = async () => {
    while (inflight.size || context.mailRentalClaimFlight) {
      const claimFlight = context.mailRentalClaimFlight;
      const waits = [...inflight.values()];
      if (claimFlight?.done) waits.push(claimFlight.done);
      if (!waits.length) {
        // The claim flight is between its startup checkpoint and promise
        // assignment. Yield once so its startup path can either publish the
        // completion promise or clear itself after a control request.
        await Promise.resolve();
        continue;
      }
      await Promise.allSettled(waits);
    }
  };
  const cancelBranch = () => cancelBranchState(state, config, {
    ...options,
    har,
    reason: 'task_cancelled',
    mailClient: context.mailClient,
    smsProvider: context.smsProvider,
  });
  try {
    if (state.cancelPending) {
      return cancelBranch();
    }
    await initializeJobs(context);
    await expireUnstartedRentalMailboxes(context);
    await processPendingJobControls(context);
    await processPendingJobRetries(context);
    while (true) {
    // Operator skips may be waiting for SMS cleanup after a resume. Resolve
    // them before replenishing lanes or promoting any retry timers.
    await processPendingJobControls(context);
    await processPendingJobRetries(context);
    await expireUnstartedRentalMailboxes(context);
    // Close completed rentals before deciding whether the run has finished.
    // A zero-output rental can then be replaced in the same run instead of
    // falling through the terminal-state check first.
    await settleFinishedRentals(context);
    await replenishFailedRentalJobs(context);
    await replenishRegistrationAliases(context);
    // Before the exit check, not after: a rental run starts with no jobs at all,
    // and the loop would call itself finished before renting the first mailbox.
    await rentRegistrationMailbox(context);
    await claimPooledRegistrationMailboxes(context);
    const action = context.action();
    if (action === 'pause') {
      // Jobs already running must reach their own safe boundary first; returning
      // with work still in flight would keep mutating state after the caller
      // believes the run is parked.
      await drain();
      // Cancellation has priority if it arrives while a pause waits for the
      // in-flight Workers to reach their safe boundary.
      if (context.action() === 'cancel') return cancelBranch();
      context.state.status = 'paused';
      context.state.phase = 'paused';
      context.state.control.pausedAt = nowIso(context);
      await context.checkpoint('branch_paused');
      return state;
    }
    if (action === 'cancel') {
      await drain();
      return cancelBranch();
    }
    if (!context.state.jobs.some((job) => !TERMINAL_JOB_STATUSES.has(job.status))) {
      // A transient rental failure is represented by a run-level timer before
      // the first mailbox exists. Do not mistake that empty job list for a
      // successful zero-account run.
      if (context.mailRentalClaimFlight) {
        await waitForSchedulerWakeup(inflight, context);
        continue;
      }
      if (rentalCapacityOutstanding(context) && mailRentalWakeAt(context) !== null) {
        await waitForSchedulerWakeup(inflight, context);
        continue;
      }
      if (unstartedRentalExpiryAt(context) !== null) {
        await waitForSchedulerWakeup(inflight, context);
        continue;
      }
      break;
    }
    await promoteDueRetries(context);
    promoteRecoverableProxyWaits(context);
    const activeLanes = new Set(context.state.workers
      .map((worker) => context.state.jobs.find((job) => job.id === worker.currentJobId)?.laneId)
      .filter(Boolean));
    // Pair every free Worker with work, then let each one bind and start on its
    // own. Binding used to be a barrier: the batch was awaited as a whole, so a
    // Worker that bound in four seconds sat on a leased exit doing nothing until
    // the slowest one finished — and a Worker walking a run of dead exits pays
    // the health-check timeout per candidate, so that wait has no useful bound.
    for (const worker of context.state.workers.filter((candidate) => candidate.status === 'idle')) {
      const job = nextJobForWorker(worker, activeLanes, context);
      if (!job) continue;
      activeLanes.add(job.laneId);
      // Claimed synchronously, before the first await. The scheduler wakes up
      // whenever any lane settles, which can happen while this exit is still
      // being probed, and an unclaimed Worker would be handed the same lane a
      // second time.
      worker.status = 'running';
      worker.currentJobId = job.id;
      worker.mailboxId = job.mailboxId;
      worker.updatedAt = nowIso(context);
      const settled = bindWorkerProxy(worker, context).then(
        // Tracked individually rather than awaited as a batch: the moment any
        // one of these finishes its Worker has to be able to pick up queued work.
        () => runJob(job, worker, context).catch(() => { /* runJob records every outcome on the job itself. */ }),
        // Two-argument `then` on purpose: only a bind rejection lands here, so a
        // failure thrown by the job itself is never mistaken for a proxy fault.
        (error) => recordProxyBindFailure(job, worker, error, context),
      ).finally(() => inflight.delete(job.id));
      inflight.set(job.id, settled);
    }
    if (inflight.size) {
      await waitForSchedulerWakeup(inflight, context);
      continue;
    }
    await settleFinishedRentals(context);
    if (await replenishRegistrationAliases(context)) continue;
    if (await promoteDueRetries(context)) continue;
    if (promoteRecoverableProxyWaits(context)) continue;
    if (await waitForSchedulerWakeup(inflight, context)) continue;
    const waiting = context.state.jobs.find((job) => job.status === 'waiting');
    if (waiting) {
      state.status = 'waiting';
      state.phase = waiting.phase || 'waiting';
      state.lastError = waiting.error || null;
      await context.checkpoint('branch_waiting');
      return state;
    }
    const queued = context.state.jobs.find((job) => job.status === 'queued');
    if (queued) {
      // A pause or cancel is pending: this is not a stall, it is what the run
      // was asked to produce. Jobs interrupted in flight are deliberately put
      // back to `queued` so the control handler at the top of the loop can
      // settle them, and it has not run yet.
      if (context.action()) continue;
      // Otherwise the scheduler really cannot place this job — its lane is
      // pinned to a Worker that will not take it back, or an affinity has
      // outlived the Worker that set it.
      //
      // This used to throw. Throwing runs the fatal path, and the fatal path
      // is destructive: it aborts every account still in flight and burns the
      // mail addresses they were using, so a scheduling problem cost real
      // inventory and left a run that could not be resumed. A real run ended
      // exactly that way, at eighteen accounts, with two mailboxes burned.
      //
      // Parking says the same thing without the damage. The run is visible,
      // its state names the job nobody would take, the accounts in flight keep
      // their mailboxes, and an operator can resume it once whatever pinned
      // that lane is released.
      state.status = 'waiting';
      state.phase = 'waiting_unassignable_job';
      state.lastError = {
        code: 'JOB_UNASSIGNABLE',
        message: `No worker can take queued job ${queued.id}; the run is parked instead of failed so the accounts in flight keep their mailboxes`,
      };
      event(context.state, 'branch_job_unassignable', {
        jobId: queued.id,
        laneId: queued.laneId || '',
        phase: queued.phase || '',
        workerAffinity: String(queued.workerAffinity?.workerId || ''),
        message: state.lastError.message,
      }, context);
      await context.checkpoint('branch_waiting');
      return state;
    }
    break;
  }
  await drain();
  await settleFinishedRentals(context);
  await replenishFailedRentalJobs(context);
  const pendingMailboxes = await releaseUnusedMailboxes(context);
  if (pendingMailboxes) {
    state.status = 'waiting';
    state.phase = 'waiting_mailbox_cleanup';
    state.lastError = { code: 'MAILBOX_CLEANUP_PENDING', message: `${pendingMailboxes} mailbox release operation(s) remain` };
    await context.checkpoint('branch_mailbox_cleanup_pending');
    return state;
  }
  const pendingRemoteMailboxes = await reconcileRemoteMailboxConsumption(context);
  if (pendingRemoteMailboxes) {
    state.status = 'waiting';
    state.phase = 'waiting_mailbox_cleanup';
    const rotationBlocks = context.mailcomRotationBlocks || [];
    state.lastError = rotationBlocks.length
      ? {
        code: 'MAILCOM_ROTATION_BLOCKED_SECURITY',
        message: `${rotationBlocks.length} Mail.com master rotation(s) blocked; ${rotationBlocks.map((block) => `${block.parentEmail} has ${block.pendingSecurityAliases} incomplete security alias(es)`).join('; ')}`,
      }
      : {
        code: 'MAILCOM_CONSUME_PENDING',
        message: `${pendingRemoteMailboxes} Mail.com mailbox consumption operation(s) remain`,
      };
    await context.checkpoint('branch_mailcom_consume_pending');
    return state;
  }
  for (const mailbox of state.mailboxes) {
    const jobs = registrationJobsForMailbox(mailbox, context);
    mailbox.attemptCount = jobs.length;
    mailbox.createdCount = jobs.filter(confirmedRegistration).length;
    if (mailbox.createdCount >= Number(mailbox.targetCount || 1)) {
      for (const job of jobs) {
        if (job.status === 'failed' && !confirmedRegistration(job)) job.compensated = true;
      }
    }
  }
  const failed = state.jobs.filter((job) => job.status === 'failed' && job.compensated !== true).length;
  const partial = state.jobs.filter((job) => job.status === 'partial').length;
  const complete = state.jobs.filter((job) => job.status === 'complete').length;
  const cleanupBlocked = [...new Set([
    ...(context.mailcomCleanupBlocks || []),
    ...(state.externalCleanup || [])
      .filter((record) => record.type === 'mailcom_mailbox_cleanup' && record.status === 'manual_review_required')
      .map((record) => `${record.jobId || ''}:${record.mailboxId || ''}`),
  ])];
  state.status = failed || partial
    ? (complete || partial ? 'partial' : 'failed')
    : (cleanupBlocked.length ? 'partial' : 'complete');
  state.phase = state.status;
  state.lastError = cleanupBlocked.length
    ? {
      code: 'MAILCOM_CLEANUP_MANUAL_REVIEW',
      message: `${cleanupBlocked.length} Mail.com mailbox cleanup operation(s) require manual review`,
    }
    : null;
  // A finished run is not waiting for anything. `normalWait` is why the run is
  // parked right now, and nothing cleared it on the way out: a run that had
  // raised its mailbox target ended 30 minutes later still announcing
  // 等待处理 Mailbox target is 80; the run keeps renting as Workers free up.
  state.normalWait = null;
  state.mailRentalRetry = null;
  state.completedAt = nowIso(context);
  await context.checkpoint('branch_complete');
  return state;
  } catch (error) {
    await cleanupBranchAfterFatal(context, error, drain);
    throw error;
  } finally {
    stopStallMonitor();
  }
}

/**
 * What the rented mailboxes on a run actually cost.
 *
 * Only a settled rental is billed — the provider charges on `status=3`, and a
 * mailbox that produced nothing is cancelled instead — so an in-flight or
 * cancelled one contributes zero rather than its quote.
 */
function summarizeMailRentalCosts(mailboxes = [], jobs = []) {
  const rentals = (mailboxes || []).filter((mailbox) => mailbox?.rented);
  const wastedMailboxIds = new Set((jobs || [])
    .filter(wastedRegistrationOutcome)
    .map((job) => String(job.mailboxId || '').trim())
    .filter(Boolean));
  const total = rentals.reduce((sum, mailbox) => sum + Number(mailbox.costUsd || 0), 0);
  const wasted = rentals.reduce((sum, mailbox) => (
    wastedMailboxIds.has(String(mailbox.id || '').trim())
      ? sum + Number(mailbox.costUsd || 0)
      : sum
  ), 0);
  const unresolvedAmount = (mailbox) => {
    const status = String(mailbox.rentalClosed || '').toLowerCase();
    if (!mailbox.rentalBillingUncertain && !['settlement_unknown', 'cleanup_manual_review'].includes(status)) return 0;
    return Number(mailbox.rentalUnresolvedUsd ?? mailbox.quotedPriceUsd ?? 0);
  };
  const unresolved = rentals.reduce((sum, mailbox) => sum + unresolvedAmount(mailbox), 0);
  // A wasted outcome whose close never confirmed a charge is still waste: the
  // address took a code, so the provider will not refund it. Counting only
  // settled rentals left those at $0 and out of 浪费 altogether. Booked at the
  // unresolved amount and kept apart from the confirmed figure, so `mail`
  // (what was billed) is not inflated by a charge nobody has confirmed.
  //
  // Priced at the quote, not at `rentalUnresolvedUsd`: a refused *cancel*
  // records that as 0 on the assumption a cancel is free, but the refusal
  // ("Bad actual activation status") is SMSBower saying the address already
  // took a code — which, for a wasted outcome, is the known case.
  const wastedUnresolvedAmount = (mailbox) => {
    const status = String(mailbox.rentalClosed || '').toLowerCase();
    if (!mailbox.rentalBillingUncertain && !['settlement_unknown', 'cleanup_manual_review'].includes(status)) return 0;
    return Number(mailbox.rentalUnresolvedUsd || mailbox.quotedPriceUsd || 0);
  };
  const wastedUnresolved = rentals.filter((mailbox) => (
    wastedMailboxIds.has(String(mailbox.id || '').trim())
    && !(Number(mailbox.costUsd || 0) > 0)
    && wastedUnresolvedAmount(mailbox) > 0
  ));
  return {
    rented: rentals.length,
    settled: rentals.filter((mailbox) => Number(mailbox.costUsd || 0) > 0).length,
    cancelled: rentals.filter((mailbox) => mailbox.rentalClosed === 'cancelled').length,
    totalUsd: Number(total.toFixed(6)),
    wastedUsd: Number(wasted.toFixed(6)),
    wastedRentals: rentals.filter((mailbox) => (
      wastedMailboxIds.has(String(mailbox.id || '').trim())
      && Number(mailbox.costUsd || 0) > 0
    )).length,
    wastedUnresolvedUsd: Number(wastedUnresolved
      .reduce((sum, mailbox) => sum + wastedUnresolvedAmount(mailbox), 0).toFixed(6)),
    wastedUnresolvedRentals: wastedUnresolved.length,
    unresolvedUsd: Number(unresolved.toFixed(6)),
    pending: rentals.filter((mailbox) => !mailbox.rentalClosed).length,
  };
}

function summarizeWastedBreakdown(smsBilling = {}, mailBilling = {}) {
  const breakdown = Object.entries(smsBilling.wastedReasons || {})
    .filter(([, entry]) => Number(entry?.count || 0) > 0)
    .map(([code, entry]) => ({
      kind: 'sms',
      code,
      count: Number(entry.count || 0),
      amount: Number(Number(entry.amount || 0).toFixed(6)),
      currency: smsBilling.currency || 'USD',
    }));
  if (Number(mailBilling.wastedRentals || 0) > 0) {
    breakdown.push({
      kind: 'mail',
      code: 'SETTLED_RENTAL',
      count: Number(mailBilling.wastedRentals || 0),
      amount: Number(Number(mailBilling.wastedUsd || 0).toFixed(6)),
      currency: 'USD',
    });
  }
  if (Number(mailBilling.wastedUnresolvedRentals || 0) > 0) {
    breakdown.push({
      kind: 'mail',
      code: 'UNRESOLVED_RENTAL',
      count: Number(mailBilling.wastedUnresolvedRentals || 0),
      amount: Number(Number(mailBilling.wastedUnresolvedUsd || 0).toFixed(6)),
      currency: 'USD',
    });
  }
  return breakdown;
}

/**
 * Strips pasted account secrets out of a plan before it leaves the process.
 *
 * `state.runPlan` keeps the credentials a credentials-sourced run signs in
 * with, and the console polls the run summary continuously — without this the
 * password and TOTP secret of every account would be served on an un-revealed
 * endpoint and copied into every summary written to disk. The runtime context
 * keeps the real plan; only what leaves is reduced.
 */
function planWithoutSecrets(plan) {
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

function round2(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
}

function summarizeBranchState(state, options = {}) {
  const raw = options.raw === true;
  const sourceJobs = state.jobs || [];
  const rawSmsBilling = summarizeSmsCosts(sourceJobs);
  const reconciliationCurrency = String(state.balanceReconciliation?.currency || rawSmsBilling.currency || 'USD').toUpperCase();
  const cancellationDetails = cancellationDetailsForBalance(rawSmsBilling, reconciliationCurrency);
  const settledCancelledQuotes = cancellationQuoteSettlementAmount(state.balanceReconciliation, cancellationDetails);
  const settledByJob = state.balanceReconciliation?.cancelledQuotesSettledByJob;
  const smsBilling = summarizeSmsCosts(sourceJobs, settledCancelledQuotes > 0 ? {
    settledCancelledQuotesCurrency: reconciliationCurrency,
    ...(settledByJob && typeof settledByJob === 'object'
      ? { settledCancelledQuotesByJob: settledByJob }
      : { settledCancelledQuotesUsd: settledCancelledQuotes }),
  } : {});
  const balanceReconciliation = applyBalanceCancellationSettlement(
    state.balanceReconciliation,
    cancellationDetails,
  );
  const mailBilling = summarizeMailRentalCosts(state.mailboxes, sourceJobs);
  const wastedBreakdown = summarizeWastedBreakdown(smsBilling, mailBilling);
  const ledgers = new Map(smsBilling.ledgers.map(({ job, ledger }) => [job.id, ledger]));
  const jobs = sourceJobs.map((job) => {
    const ledger = ledgers.get(job.id);
    const summaryError = jobErrorForSummary(job, state);
    const summaryJob = summaryError === job.error ? job : { ...job, error: summaryError };
    const aliasIndex = state.taskKind === 'oauth' ? 0 : job.aliasIndex;
    return {
    id: job.id,
    taskKind: job.taskKind,
    email: job.email,
    parentEmail: job.parentEmail,
    mailboxId: job.mailboxId,
    status: job.status,
    phase: job.phase,
    branch: job.branch,
    aliasIndex,
    nextRunAt: job.nextRunAt || '',
    proxyId: job.proxyId,
    smsAttempts: (job.sms?.attempts || []).length + (job.sms?.current ? 1 : 0),
    // smsCostUsd is the confirmed net consumption. The legacy state field
    // job.sms.costUsd remains a quote accumulator for old checkpoints.
    smsCostUsd: ledger.confirmedConsumedUsd > 0 ? ledger.confirmedConsumedUsd : 0,
    smsWastedUsd: ledger.wastedConsumedUsd > 0 ? ledger.wastedConsumedUsd : 0,
    smsWastedAttempts: ledger.wastedActivationCount || 0,
    smsCurrency: ledger.currency,
    smsQuotedUsd: ledger.quotedUsd,
    smsRefundedUsd: ledger.refundedUsd,
    smsUnresolvedUsd: ledger.unresolvedUsd,
    smsCancelledUnresolvedUsd: ledger.cancelledUnresolvedUsd,
    smsCancelledQuoteExcludedUsd: Number(settledByJob?.[String(job.id || '')] || 0),
    smsCostStatus: ledger.status,
    accountCreated: Boolean(job.accountCreatedAt),
    sessionAssetId: job.sessionAssetId,
    assetId: job.assetId,
     cpaPath: job.cpaPath,
     cpaRevision: job.cpaRevision,
      cpaSuperseded: job.cpaSuperseded === true,
      remoteMailboxConsumedAt: job.remoteMailboxConsumedAt || '',
      remoteMailboxConsumeError: clone(job.remoteMailboxConsumeError || null),
      remoteMailboxCleanup: clone(job.remoteMailboxCleanup || null),
      result: jobResultText({ ...summaryJob, result: registrationJobResult(summaryJob) }),
      targetTouched: sessionTargetTouched(job),
      proxyTransportRecovery: clone(job.proxyTransportRecovery || null),
      oauthPhoneValidationRecovery: clone(job.oauthPhoneValidationRecovery || null),
      error: summaryError,
    ...(raw ? { sessionState: job.sessionState, oauthState: job.oauthState, sms: job.sms } : {}),
    };
  });
  return {
    schemaVersion: state.schemaVersion,
    runId: state.runId,
    taskKind: state.taskKind,
    status: state.status,
    phase: state.phase,
    resumable: canResumeBranchState(state),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    completedAt: state.completedAt || '',
    plan: planWithoutSecrets(state.runPlan),
    control: state.control,
    normalWait: clone(state.normalWait || null),
    balanceStop: clone(state.balanceStop || null),
    mailRental: summarizeMailRental(state),
    mailRentalWatch: clone(state.mailRentalWatch || null),
    workers: clone(state.workers || []),
    mailboxes: clone(state.mailboxes || []),
    externalCleanup: clone(state.externalCleanup || []),
    jobs,
    counts: {
      workers: {
        total: (state.workers || []).length,
        running: (state.workers || []).filter((worker) => worker.status === 'running').length,
        idle: (state.workers || []).filter((worker) => worker.status === 'idle').length,
      },
      accountsCreated: jobs.filter((job) => job.sessionAssetId).length,
      sessionsSaved: jobs.filter((job) => job.sessionAssetId).length,
      cpaCompleted: jobs.filter((job) => job.cpaPath && !job.cpaSuperseded).length,
      wasted: smsBilling.wastedActivationCount + mailBilling.wastedRentals + mailBilling.wastedUnresolvedRentals,
      wastedBreakdown,
      ...(registrationTask(state) ? {
        registrationOutcomes: registrationOutcomeCounts(state),
        registrationSkipped: registrationSkippedCounts(state),
      } : {}),
      ...(runPerformsOAuth(state) ? { oauthSkipped: oauthSkippedCounts(state) } : {}),
      // Reported, not graded. A banned account is a settled outcome that leaves
      // its job `skipped`, so it never reaches the failed/partial tally.
      deactivated: jobs.filter((job) => String(job.error?.code || '').toUpperCase() === 'ACCOUNT_DEACTIVATED').length,
      finalization: { queued: 0, running: 0, failed: 0 },
    },
    costs: {
      // Keep the legacy numeric fields, but expose the actual currency for
      // new clients. Mail rentals are always USD, so a CNY SMS run with a
      // settled rental is explicitly mixed rather than silently converted.
      currency: mailBilling.totalUsd > 0 && smsBilling.currency !== 'USD'
        ? 'MIXED'
        : (mailBilling.totalUsd > 0 ? 'USD' : smsBilling.currency),
      sms: smsBilling.confirmedConsumedUsd,
      ...(smsBilling.wastedConsumedUsd > 0 ? {
        wastedSms: smsBilling.wastedConsumedUsd,
        wastedSmsAttempts: smsBilling.wastedActivationCount,
      } : {}),
      // Rented mailboxes bill on settle, so only closed-and-accepted ones count.
      mail: mailBilling.totalUsd,
      mailRentals: mailBilling.settled,
      ...(mailBilling.wastedUsd > 0 ? {
        wastedMail: mailBilling.wastedUsd,
        wastedMailRentals: mailBilling.wastedRentals,
      } : {}),
      ...(mailBilling.wastedUnresolvedUsd > 0 ? {
        wastedMailUnresolved: mailBilling.wastedUnresolvedUsd,
        wastedMailUnresolvedRentals: mailBilling.wastedUnresolvedRentals,
      } : {}),
      mailUnresolved: mailBilling.unresolvedUsd,
      mailPending: mailBilling.pending,
      accountedJobs: smsBilling.accountedJobs,
      // What the run actually cost, in one number. Reading `sms` and `mail`
      // side by side invited adding them by eye, which is wrong the moment
      // the SMS provider bills in anything but USD — `currency` above says
      // MIXED exactly then, and this stays null rather than inventing a rate.
      total: mailBilling.totalUsd > 0 && smsBilling.currency !== 'USD'
        ? null
        : round2(smsBilling.confirmedConsumedUsd + mailBilling.totalUsd),
      // How many numbers the money actually bought. Every activation the run
      // touched is a much larger figure — 907 against 80 on one live run,
      // because a number that never delivered a code is cancelled and costs
      // nothing — and next to a confirmed total it reads as an error rather
      // than as churn. The gross count stays in `billing.activationCount`
      // for anyone reconciling a supplier invoice.
      smsBilledActivations: smsBilling.confirmedActivationCount,
      complete: TERMINAL_RUN_STATUSES.has(state.status),
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
      wastedConsumedUsd: smsBilling.wastedConsumedUsd,
      wastedActivationCount: smsBilling.wastedActivationCount,
      billingComplete: smsBilling.billingComplete,
    },
    balanceReconciliation: clone(balanceReconciliation || null),
    error: state.lastError?.message || '',
  };
}

module.exports = {
  assertMailClientProvider,
  REPLACE_PHONE_CODES,
  BRANCH_TASK_KINDS,
  canResumeBranchState,
  cancelBranchState,
  canMigrateLegacyRegisterOAuthState,
  makeInitialBranchState,
  migrateSessionCheckpoint,
  migrateLegacyRegisterOAuthState,
  applyMailcomAliasDomains,
  preflightMailcomAliasDomains,
  preflightBranch,
  prepareBranchPreflight,
  resumableBranchAssetIds,
  restartStaleEmailOtpSession,
  resumeBranchState,
  runBranchOrchestrator,
  skipBranchJob,
  summarizeBranchState,
  tagSessionAssetTrial,
  // Internal scheduling arithmetic, exported for tests.
  _rentalMailboxDeficit: rentalMailboxDeficit,
  _mailContextForJob: mailContextForJob,
  _emailBoundary: emailBoundary,
  _registrationJobResult: registrationJobResult,
  _compactCompletedJob: compactCompletedJob,
  _waitEmailCode: waitEmailCode,
};
