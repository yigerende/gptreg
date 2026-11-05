'use strict';
const runtimeSecrets = require('./platform/runtime-secrets');

const { exportFileName } = require('./export-file-name');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { serializeCookieJar } = require('./cookie-jar');
const { cpaFileNameForEmail } = require('./cpa-filename');
const {
  accessTokenExpired,
  assetGrouping,
  assetLifecycle,
  assetNextAction,
  hasAccessToken,
  isPlusAsset,
  oauthCooldownActive,
  OAUTH_FAILURE_COOLDOWN_MS,
  reconcileLifecycle,
  staticFacets,
} = require('./session-asset-grouping');
const { atomicWriteText, resolveInside } = require('./ui-server/utils');
const { clone } = require('./util/shared');

const SESSION_ASSET_SCHEMA_VERSION = 1;
const SESSION_ASSET_CLASSIFICATIONS = new Set(['active', 'planned', 'sold']);
// `banned` is discovered, never chosen, so it is absent here on purpose.
const SETTABLE_LIFECYCLES = new Set(['active', 'planned', 'self_use', 'sold']);
// Pools the pre-lifecycle `classification` field can name. `self_use` is not
// one: it postdates that field, and a build rolled back past it would read an
// unknown classification as `active`, which is exactly how self-use accounts
// should degrade — they are working inventory that happens to be spoken for.
const LEGACY_CLASSIFICATIONS = ['planned', 'sold'];
const SESSION_ASSET_MAIL_PROVIDERS = new Set(['xiaopingguo', 'smsbower', 'mailcom', 'fastmail', 'icloud']);
const MAILBOX_PROVIDER_PREFIXES = new Map([
  ['xiaopingguo', 'xiaopingguo'],
  ['smsbower', 'smsbower'],
  ['mailcom', 'mailcom'],
  ['mailapi', 'mailcom'],
  ['fastmail', 'fastmail'],
  ['icloud', 'icloud'],
]);
const ASSET_FILE = /^asset-([a-z0-9-]{8,80})\.json$/i;
/**
 * How long a sold account's locked batch must have settled before it is
 * archived. An operator locks a batch when the sale is done; a day later
 * nothing is going to touch it again.
 */
const SETTLED_ARCHIVE_HOURS = 24;

function nowIso(now = Date.now) {
  return new Date(now()).toISOString();
}

function normalizedEmail(value) {
  return String(value || '').trim().toLowerCase();
}

function normalizedMailProvider(value) {
  const provider = String(value || '').trim().toLowerCase();
  return SESSION_ASSET_MAIL_PROVIDERS.has(provider) ? provider : '';
}

function pushProviderEvidence(evidence, provider, source, strength) {
  if (provider) evidence.push({ provider, source, strength });
}

function confirmedRebindMetadata(asset) {
  const rebound = asset.rebind;
  if (!rebound || rebound.verificationUncertain || !Number.isFinite(Date.parse(rebound.reboundAt))) return null;
  const previous = normalizedEmail(rebound.previousEmail);
  const current = normalizedEmail(asset.email);
  if (!previous || !current || previous === current) return null;
  if (rebound.newEmail && normalizedEmail(rebound.newEmail) !== current) return null;
  const provider = normalizedMailProvider(rebound.provider);
  const mailboxId = String(rebound.mailboxId || '').trim();
  const prefix = mailboxId.split(':', 1)[0].toLowerCase();
  if (!provider || !mailboxId || MAILBOX_PROVIDER_PREFIXES.get(prefix) !== provider) return null;
  return { provider, mailboxId, previousProvider: normalizedMailProvider(rebound.previousProvider) };
}

/** Repair the confirmed legacy rebind that changed email but kept its iCloud mailbox. */
function reconcileReboundMailbox(asset) {
  const rebound = confirmedRebindMetadata(asset);
  if (!rebound) return false;
  const currentProvider = normalizedMailProvider(asset.mailProvider);
  if (currentProvider && ![rebound.provider, rebound.previousProvider].includes(currentProvider)) return false;
  let changed = false;
  const fields = { mailProvider: rebound.provider, parentEmail: asset.email, parentMailboxId: rebound.mailboxId };
  for (const [key, value] of Object.entries(fields)) {
    if (asset[key] !== value) { asset[key] = value; changed = true; }
  }
  // A rejected token is not a healthy session, even if change_email succeeded.
  if (asset.health?.code === 'LOGIN_STATE_INVALID' && asset.health.status === 'uncertain') {
    asset.health = { ...asset.health, status: 'invalid' };
    if (asset.status === 'valid') asset.status = 'invalid';
    changed = true;
  }
  return changed;
}

/**
 * Resolve the mailbox channel attached to a saved login state.
 *
 * `mailProvider` is authoritative for assets written by the current flow.
 * Older assets predate that field, so their namespaced mailbox id and source
 * kind are retained as strong evidence. Numeric legacy mailbox ids can still
 * be identified from the two mailbox domains this application historically
 * issued; an unresolved asset is deliberately left unresolved instead of
 * silently borrowing the active global provider.
 */
function sessionAssetMailProviderEvidence(asset = {}) {
  const evidence = [];
  const explicit = normalizedMailProvider(asset.mailProvider);
  pushProviderEvidence(evidence, explicit, 'asset.mailProvider', 'explicit');

  const mailboxId = String(asset.parentMailboxId || '').trim().toLowerCase();
  const mailboxPrefix = mailboxId.includes(':') ? mailboxId.split(':', 1)[0] : mailboxId;
  pushProviderEvidence(
    evidence,
    MAILBOX_PROVIDER_PREFIXES.get(mailboxPrefix) || '',
    'asset.parentMailboxId',
    'strong',
  );

  const sourceKind = String(asset.sourceKind || '').trim().toLowerCase();
  const sourceProvider = sourceKind.includes('icloud')
    ? 'icloud'
    : sourceKind.includes('fastmail')
      ? 'fastmail'
      : (sourceKind.includes('mailcom') || sourceKind.includes('mailapi'))
      ? 'mailcom'
      : sourceKind.includes('smsbower')
        ? 'smsbower'
        : sourceKind.includes('xiaopingguo')
          ? 'xiaopingguo'
          : '';
  // After a confirmed move the source kind describes registration history,
  // while the current mailbox fields describe the channel used for recovery.
  if (!confirmedRebindMetadata(asset)) pushProviderEvidence(evidence, sourceProvider, 'asset.sourceKind', 'strong');

  const strong = evidence.filter((item) => item.strength !== 'weak');
  const strongProviders = [...new Set(strong.map((item) => item.provider))];
  if (strongProviders.length > 1) {
    return {
      provider: '',
      source: 'conflict',
      providers: strongProviders,
      evidence,
    };
  }
  if (strongProviders.length === 1) {
    return {
      provider: strongProviders[0],
      source: strong[0].source,
      providers: strongProviders,
      evidence,
    };
  }

  // The numeric ids used by the legacy local and rental channels have no
  // namespace. Only apply the domain heuristic when such an id exists.
  if (mailboxId && !mailboxId.includes(':')) {
    const domain = String(asset.email || '').trim().toLowerCase().split('@').pop();
    const legacyProvider = domain === 'gmail.com'
      ? 'smsbower'
      : ['outlook.com', 'hotmail.com', 'live.com'].includes(domain)
        ? 'xiaopingguo'
        : '';
    pushProviderEvidence(evidence, legacyProvider, 'legacy mailbox domain', 'weak');
    if (legacyProvider) {
      return {
        provider: legacyProvider,
        source: 'legacy mailbox domain',
        providers: [legacyProvider],
        evidence,
      };
    }
  }
  return { provider: '', source: 'unknown', providers: [], evidence };
}

function sessionAssetMailProvider(asset = {}) {
  const resolved = sessionAssetMailProviderEvidence(asset);
  return resolved.source === 'conflict' ? '' : resolved.provider;
}

function decodeJwtPayload(token) {
  const part = String(token || '').split('.')[1];
  if (!part) return {};
  try { return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')); } catch { return {}; }
}

function accessTokenExpiry(token) {
  const exp = Number(decodeJwtPayload(token).exp || 0);
  return exp > 0 ? new Date(exp * 1000).toISOString() : '';
}

/** The exit country an account registered from, as its index facet records it. */
function registrationCountryFromFacets(facets) {
  if (!Array.isArray(facets)) return '';
  const facet = facets.find((value) => typeof value === 'string' && value.startsWith('exitCountry:'));
  return facet ? facet.slice('exitCountry:'.length).trim().toUpperCase() : '';
}

function safeAssetId(value) {
  const id = String(value || '').trim();
  if (!/^[a-z0-9][a-z0-9-]{7,79}$/i.test(id)) throw new Error(`Invalid session asset id: ${id || '<empty>'}`);
  return id;
}

function classification(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return SESSION_ASSET_CLASSIFICATIONS.has(normalized) ? normalized : 'active';
}

/**
 * Whether each secret is present, without handing the secret over.
 *
 * Shared by the list summary and the detail payload: the console decides
 * "needs a password" from these, and a view that omitted them used to read as
 * "no password" for every account.
 */
function secretPresence(asset = {}) {
  return {
    hasAccessToken: Boolean(asset.accessToken),
    hasSessionToken: Boolean(asset.sessionToken),
    hasPassword: Boolean(asset.password),
    hasTotp: Boolean(asset.totpSecret),
  };
}

function securitySummary(value = {}) {
  const security = value && typeof value === 'object' ? value : {};
  const failures = Array.isArray(security.failures) ? security.failures : [];
  const transaction = security.passwordTransaction && typeof security.passwordTransaction === 'object'
    ? security.passwordTransaction
    : {};
  const reauth = security.securityReauth && typeof security.securityReauth === 'object'
    ? security.securityReauth
    : {};
  return {
    setPassword: security.setPassword === true,
    enrollTotp: security.enrollTotp === true,
    passwordStatus: String(security.passwordStatus || ''),
    totpStatus: String(security.totpStatus || ''),
    passwordTransactionStep: String(transaction.step || ''),
    confirmationMfaRequired: transaction.confirmationMfaRequired === true,
    securityReauthStatus: String(reauth.status || ''),
    securityReauthReason: String(reauth.reason || ''),
    securityReauthStep: String(reauth.step || ''),
    securityReauthMethod: String(reauth.method || ''),
    securityReauthEmailStatus: String(reauth.emailOtp?.status || ''),
    failures: failures.map((failure) => ({
      feature: String(failure?.feature || ''),
      code: String(failure?.code || ''),
    })),
  };
}

function isSecurityReauthFailure(failure = {}) {
  const code = String(failure?.code || '').toUpperCase();
  const message = String(failure?.message || '').toLowerCase();
  return code === 'SECURITY_REAUTH_REQUIRED'
    || code === 'MFA_ENROLL_REAUTH_REQUIRED'
    || /re[-\s]?authenticate|reauthenticate|recently authenticate|enroll\/disable a factor/.test(message);
}

function reconcileSecurityReauth(asset, now = Date.now) {
  const security = asset?.security && typeof asset.security === 'object' ? asset.security : {};
  if (security.totpStatus === 'configured') return false;
  const failures = Array.isArray(security.failures) ? security.failures : [];
  const failure = [...failures].reverse().find(isSecurityReauthFailure);
  if (!failure && String(security.securityReauth?.status || '') !== 'required') return false;
  const existingReauth = security.securityReauth || {};
  // Idempotence guard. This runs on every *read* of an asset and writes when it
  // fires, so it has to latch after one application. It used to also require
  // `totpStatus` to be retry_pending or failed — but the write below only ever
  // rewrites `failed`, so an asset whose TOTP sat at '', 'pending' or 'skipped'
  // never satisfied it and was copied, rewritten and fsync'd on *every* read.
  // The run list reads one asset per job every two seconds.
  if (existingReauth.status === 'required'
    && existingReauth.reason === 'MFA_ENROLL_REAUTH_REQUIRED'
    && String(existingReauth.requiredAt || '') !== ''
    && existingReauth.lastError?.code === 'SECURITY_REAUTH_REQUIRED'
    && security.totpStatus !== 'failed'
    && asset.lastError?.code === 'SECURITY_REAUTH_REQUIRED') return false;
  const at = new Date(now()).toISOString();
  asset.security = {
    ...security,
    securityReauth: {
      ...(security.securityReauth || {}),
      status: 'required',
      reason: 'MFA_ENROLL_REAUTH_REQUIRED',
      requiredAt: String(security.securityReauth?.requiredAt || at),
      lastError: {
        code: 'SECURITY_REAUTH_REQUIRED',
        retryable: true,
      },
    },
    totpStatus: security.totpStatus === 'failed' ? 'retry_pending' : security.totpStatus,
  };
  asset.lastError = {
    code: 'SECURITY_REAUTH_REQUIRED',
    message: 'TOTP 设置需要一次安全重认证',
  };
  asset.updatedAt = at;
  return true;
}

function reconcilePasswordConfirmation(asset, now = Date.now) {
  const security = asset?.security && typeof asset.security === 'object' ? asset.security : {};
  const transaction = security.passwordTransaction && typeof security.passwordTransaction === 'object'
    ? security.passwordTransaction
    : null;
  const failures = Array.isArray(security.failures) ? security.failures : [];
  const confirmationFailure = failures.some((failure) => String(failure?.code || '').toUpperCase() === 'PASSWORD_CONFIRMATION_MFA_REQUIRED');
  // The migration is one-shot. Once the transaction is marked complete and the
  // confirmation failure has been dropped there is nothing left to move, and
  // re-running it would rewrite `updatedAt` on every read of the asset.
  if (!confirmationFailure
    && transaction?.step === 'complete'
    && security.passwordStatus === 'configured') return false;
  if (!asset?.password || (!confirmationFailure && transaction?.confirmationMfaRequired !== true)) return false;
  if (transaction?.step !== 'password_submitted' && transaction?.confirmationMfaRequired !== true) return false;

  const completedAt = String(transaction.completedAt || asset.updatedAt || new Date(now()).toISOString());
  const nextUrl = String(transaction.nextUrl || '');
  let confirmationMfaPath = String(transaction.confirmationMfaPath || '');
  if (!confirmationMfaPath && nextUrl) {
    try { confirmationMfaPath = new URL(nextUrl).pathname; } catch { /* Keep the path empty in legacy data. */ }
  }
  asset.security = {
    ...security,
    setPassword: true,
    passwordStatus: 'configured',
    passwordTransaction: {
      ...transaction,
      step: 'complete',
      confirmationMfaRequired: true,
      ...(confirmationMfaPath ? { confirmationMfaPath } : {}),
      completedAt,
    },
    failures: failures.filter((failure) => String(failure?.code || '').toUpperCase() !== 'PASSWORD_CONFIRMATION_MFA_REQUIRED'),
  };
  if (!asset.security.failures.length && asset.status === 'partial') {
    asset.status = 'valid';
    asset.lastError = null;
  }
  asset.updatedAt = new Date(now()).toISOString();
  return true;
}

function oauthSummary(asset = {}) {
  const value = asset.oauth && typeof asset.oauth === 'object' ? asset.oauth : {};
  const successful = value.successful === true || Boolean(asset.cpa);
  return {
    successful,
    successCount: Math.max(successful ? 1 : 0, Number(value.successCount || 0)),
    lastSucceededAt: String(value.lastSucceededAt || asset.cpa?.updatedAt || ''),
    lastRunId: String(value.lastRunId || asset.cpa?.runId || ''),
    lastJobId: String(value.lastJobId || asset.cpa?.jobId || ''),
  };
}

function oauthCooldownSummary(asset = {}, now = Date.now) {
  const value = asset.oauthCooldown && typeof asset.oauthCooldown === 'object'
    ? asset.oauthCooldown
    : {};
  const failureCount = Number(value.failureCount);
  return {
    active: oauthCooldownActive(asset, now),
    until: String(value.until || ''),
    reason: String(value.reason || ''),
    failureCount: Number.isFinite(failureCount) ? Math.max(0, Math.floor(failureCount)) : 0,
    sourceRunId: String(value.sourceRunId || ''),
    sourceJobId: String(value.sourceJobId || ''),
    setAt: String(value.setAt || ''),
  };
}

/**
 * The list row.
 *
 * `lifecycle`, `nextAction` and `facets` are derived here rather than in the
 * browser so that the API can filter and count from the same values it renders.
 * The console used to re-implement these predicates itself, which is how its
 * dropdown counts and its row counts came to disagree.
 */
function assetSummary(asset, now = Date.now) {
  // Grouping reads the *resolved* provider, not the stored field. Only 55 of
  // the 1330 live assets carry `mailProvider` on disk — every earlier record
  // predates it — so grouping on the raw field would have filed almost the
  // whole store under "channel unknown" while the evidence resolver right
  // beside it could name the channel for far more of them.
  const mailProvider = sessionAssetMailProvider(asset);
  return {
    schemaVersion: asset.schemaVersion,
    id: asset.id,
    email: asset.email,
    parentEmail: asset.parentEmail || '',
    parentMailboxId: asset.parentMailboxId || '',
    mailProvider,
    accountId: asset.accountId || '',
    status: asset.status || 'unknown',
    classification: classification(asset.classification),
    ...assetGrouping({ ...asset, mailProvider }, now),
    planType: asset.planType || 'unknown',
    sourceKind: asset.sourceKind || '',
    sourceRunId: asset.sourceRunId || '',
    createdAt: asset.createdAt || '',
    updatedAt: asset.updatedAt || '',
    lastValidatedAt: asset.lastValidatedAt || '',
    accessTokenExpiresAt: asset.accessTokenExpiresAt || '',
    ...secretPresence(asset),
    security: securitySummary(asset.security),
    // The exit the account was registered through, minus the URL: a pool entry
    // can carry credentials and the summary is what reaches the browser.
    sourceProxy: sourceProxySummary(asset.sourceProxy),
    rebindProxy: sourceProxySummary(asset.rebindProxy),
    health: clone(asset.health || null),
    trial: clone(asset.trial || null),
    oauth: oauthSummary(asset),
    oauthCooldown: oauthCooldownSummary(asset, now),
    cpa: clone(asset.cpa || null),
    lastError: clone(asset.lastError || null),
  };
}

/**
 * Drop keys whose value carries no information.
 *
 * Every consumer of these rows reads them through `||`, `?.` or a truthiness
 * test, so an absent key and an empty one mean the same thing — but the empty
 * one still costs its name on the wire, once per row. That is most of what a
 * list page weighed: `security` alone shipped fourteen keys per account and on
 * a healthy store all but two of them are empty strings.
 */
function compact(value) {
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === '' || item === null || item === undefined || item === false || item === 0) continue;
    if (Array.isArray(item) && !item.length) continue;
    out[key] = item;
  }
  return out;
}

/**
 * The row the console list actually renders.
 *
 * Deliberately a whitelist rather than the full summary minus a few fields: it
 * is reviewable against the JSX, and a field added to the record later cannot
 * silently start riding along on a request that polls every five seconds. The
 * inspector reads the detail endpoint, which still returns everything, so
 * nothing here needs to serve that panel.
 */
function listSummary(asset, now = Date.now) {
  const mailProvider = sessionAssetMailProvider(asset);
  const health = asset.health && typeof asset.health === 'object' ? asset.health : null;
  const trial = asset.trial && typeof asset.trial === 'object' ? asset.trial : null;
  const security = securitySummary(asset.security);
  const proxy = sourceProxySummary(asset.sourceProxy);
  const rebindProxy = sourceProxySummary(asset.rebindProxy);
  const oauthCooldown = oauthCooldownSummary(asset, now);
  return compact({
    id: asset.id,
    email: asset.email,
    accountId: asset.accountId || '',
    status: asset.status || 'unknown',
    ...assetGrouping({ ...asset, mailProvider }, now),
    planType: asset.planType || 'unknown',
    sourceRunId: asset.sourceRunId || '',
    createdAt: asset.createdAt || '',
    updatedAt: asset.updatedAt || '',
    lastValidatedAt: asset.lastValidatedAt || '',
    accessTokenExpiresAt: asset.accessTokenExpiresAt || '',
    hasAccessToken: Boolean(asset.accessToken),
    hasPassword: Boolean(asset.password),
    hasTotp: Boolean(asset.totpSecret),
    // Only what `securityRecoveryLabel` and the recovery gate read. The rest of
    // the security record — the failure list, the transaction bookkeeping — is
    // inspector material.
    security: compact({
      passwordStatus: security.passwordStatus,
      totpStatus: security.totpStatus,
      passwordTransactionStep: security.passwordTransactionStep,
      securityReauthStatus: security.securityReauthStatus,
      securityReauthMethod: security.securityReauthMethod,
      securityReauthEmailStatus: security.securityReauthEmailStatus,
    }),
    // The row shows a badge and a "checked at" tooltip; the message and the
    // last-healthy timestamp are only ever rendered in the inspector.
    health: health ? compact({
      status: String(health.status || ''),
      code: String(health.code || ''),
      checkedAt: String(health.checkedAt || ''),
    }) : null,
    trial: trial ? compact({
      status: String(trial.status || ''),
      code: String(trial.code || ''),
      message: String(trial.message || ''),
      checkedAt: String(trial.checkedAt || ''),
      activeTrial: trial.activeTrial === true,
      freeMonthOffer: trial.freeMonthOffer === true,
      offerLabel: String(trial.offerLabel || ''),
      offerPlan: String(trial.offerPlan || ''),
      offerPlanLabel: String(trial.offerPlanLabel || ''),
      subscriptionPlan: String(trial.subscriptionPlan || ''),
      campaigns: (Array.isArray(trial.campaigns) ? trial.campaigns : []).map((campaign) => compact({
        key: String(campaign?.key || ''),
        planName: String(campaign?.planName || ''),
        label: String(campaign?.label || ''),
        offerLabel: String(campaign?.offerLabel || ''),
        durationPeriod: String(campaign?.durationPeriod || ''),
        durationPeriods: Number(campaign?.durationPeriods || 0),
        discountPercentage: Number(campaign?.discountPercentage || 0),
      })),
    }) : null,
    // `oauthSummary` already folds a retained CPA into `successful`, so the row
    // needs the flag rather than the artifact.
    oauth: compact({ successful: oauthSummary(asset).successful }),
    oauthCooldown: oauthCooldown.active ? compact(oauthCooldown) : null,
    sourceProxy: proxy ? compact({
      endpoint: proxy.endpoint,
      countryCode: proxy.countryCode,
      protocol: proxy.protocol,
    }) : null,
    rebindProxy: rebindProxy ? compact({ endpoint: rebindProxy.endpoint, countryCode: rebindProxy.countryCode, protocol: rebindProxy.protocol }) : null,
    // Only the code is read, to spot a deactivation the health record missed.
    lastError: asset.lastError?.code ? { code: String(asset.lastError.code) } : null,
  });
}

/** Credential-free view of a recorded registration or rebind proxy. */
function sourceProxySummary(sourceProxy) {
  if (!sourceProxy || typeof sourceProxy !== 'object') return null;
  let endpoint = String(sourceProxy.endpoint || '');
  if (!endpoint && sourceProxy.url) {
    try {
      const parsed = new URL(String(sourceProxy.url));
      endpoint = parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
    } catch { endpoint = ''; }
  }
  return {
    id: String(sourceProxy.id || ''),
    endpoint,
    protocol: String(sourceProxy.protocol || '').toLowerCase(),
    countryCode: String(sourceProxy.countryCode || '').toUpperCase(),
    resourceKind: String(sourceProxy.resourceKind || ''),
  };
}

function corruptAssetForFile(filePath, error) {
  return {
    schemaVersion: SESSION_ASSET_SCHEMA_VERSION,
    id: path.basename(filePath).replace(/^asset-|\.json$/g, ''),
    email: '<corrupt>',
    status: 'corrupt',
    lastError: { code: 'ASSET_CORRUPT', message: String(error?.message || error || 'Unreadable session asset') },
    updatedAt: '',
  };
}

/** One stat, or null when the file is gone. */
function statSignature(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return { mtimeMs: stats.mtimeMs, size: stats.size };
  } catch { return null; }
}

// Bumped when the shape of an index row changes, so an older cache is
// ignored rather than trusted into a wrong listing.
const INDEX_CACHE_VERSION = 1;

/** Newest first, then by path so the order is total and stable. */
function compareIndexEntries(left, right) {
  return right.updatedAt.localeCompare(left.updatedAt)
    || left.filePath.localeCompare(right.filePath);
}

class SessionAssetStore {
  constructor(options = {}) {
    this.cwd = path.resolve(options.cwd || process.cwd());
    this.stateRoot = path.resolve(this.cwd, options.stateDir || '.gpt-re-state/v2');
    this.assetRoot = path.join(this.stateRoot, 'session-assets');
    /**
     * Settled business, moved out of the listing but not out of reach.
     *
     * `files()` reads one directory and matches `asset-<id>.json`, so anything
     * in a subfolder is already invisible to the index — the whole cost of an
     * archived account disappears from every cold rebuild. It stays a plain
     * asset file in the same format: `get` still resolves it by id for a CPA
     * page that links to it, and restoring one is a move back.
     *
     * Measured on 2026-09-25: 8064 assets took 90.8s to index cold, and 4637
     * of them were already sold.
     */
    this.archiveRoot = path.join(this.assetRoot, 'archive');
    this.cpaRoot = path.resolve(this.cwd, options.cpaDir || '.gpt-re-state/v2/output');
    this.now = options.now || Date.now;
    // Parsed assets keyed by path, invalidated by the file's own mtime/size.
    this.readCache = new Map();
    // The sorted index, and the directory watch that decides when to rebuild
    // it. See `entries`.
    this.indexSnapshot = null;
    this.indexSnapshotAt = 0;
    // Monotonic in-process change token for consumers that cache derived
    // views. File mtimes still protect the asset cache; this token tells a
    // run-list cache that a canonical CPA revision may have changed.
    this.changeVersion = 0;
    this.indexWatcher = null;
    this.indexWatchFailed = false;
    // Paths the watch reported as changed since the snapshot was built.
    // Patching these is what keeps a write O(1) instead of O(store).
    this.dirtyIndexPaths = new Set();
    // The built index, persisted so a restart does not have to read every
    // asset back just to list them. Entries carry the file signature they
    // were built from, so a stale one is detected per file rather than
    // trusted wholesale.
    this.indexCachePath = path.join(this.stateRoot, 'session-assets.index.json');
    this.indexCacheLoaded = false;
    // filePath -> { mtimeMs, size } for the rows currently in the snapshot.
    this.indexSignatures = new Map();
    // filePath -> { mtimeMs, size, entry } CPA projections carried in the
    // index cache. Without them the first CPA listing after a restart (and the
    // boot-time CPA file-name migration) read every asset back from disk —
    // measured at ~55s of a ~56s start on a 4400-asset store. Trusted only
    // while the file still has the signature the projection was built from.
    this.persistedCpa = new Map();
    // Set when a projection was built from the file itself and the cache on
    // disk has not caught up with it yet.
    this.cpaProjectionsUnsaved = false;
    // The age is a safety net for anything the watch misses, not the
    // mechanism: a healthy watch reports every write, so rebuilding the
    // whole index every minute only pays 2 stat calls per asset for
    // nothing. A store that lost its watch keeps the old, tighter bound.
    this.indexMaxAgeMs = Number.isFinite(options.indexMaxAgeMs) ? options.indexMaxAgeMs : 600_000;
    this.indexMaxAgeWithoutWatchMs = Number.isFinite(options.indexMaxAgeMs) ? options.indexMaxAgeMs : 60_000;
    // Past this many changed files, re-reading the directory once beats
    // patching them one at a time.
    this.maxIndexPatch = Number.isFinite(options.maxIndexPatch) ? options.maxIndexPatch : 200;
  }

  /**
   * Watch the asset directory so the index can be reused between polls.
   *
   * Without this, every request rebuilt the index by stat-ing every asset file.
   * The console polls this list every five seconds and the store holds well
   * over a thousand assets, so that scan was effectively continuous — and it
   * dominated the request: on one measured store the stat pass was 5.9s of a
   * 6.0s call, while turning the results into summaries took 11ms.
   *
   * The watch is a hint, not the contract. It can miss events on some
   * filesystems and network mounts, so the snapshot still expires on its own
   * after `indexMaxAgeMs`; writes through this store invalidate it directly.
   */
  startIndexWatch() {
    if (this.indexWatcher || this.indexWatchFailed) return;
    try {
      fs.mkdirSync(this.assetRoot, { recursive: true });
      this.indexWatcher = fs.watch(this.assetRoot, { persistent: false }, (_event, filename) => {
        this.changeVersion += 1;
        // Without a filename there is nothing to patch, so fall back to the
        // old whole-index rebuild. Node gives one on Windows and Linux for
        // this kind of directory watch; the branch is for the platforms and
        // error paths that do not.
        if (!filename) { this.indexSnapshot = null; this.dirtyIndexPaths.clear(); return; }
        const name = path.basename(String(filename));
        // Every asset write also writes its `.bak`, so half the events name a
        // backup. `readRecord` already folds the backup into the primary's
        // cache signature, so marking the primary covers both.
        const primary = name.endsWith('.bak') ? name.slice(0, -4) : name;
        if (!ASSET_FILE.test(primary)) return;
        this.dirtyIndexPaths.add(path.join(this.assetRoot, primary));
      });
      this.indexWatcher.on('error', () => {
        this.indexWatchFailed = true;
        this.indexSnapshot = null;
        this.dirtyIndexPaths.clear();
      });
    } catch {
      // No watch available here; `indexMaxAgeMs` alone governs the snapshot.
      this.indexWatchFailed = true;
    }
  }

  /** Release the directory watch. Servers run for the process lifetime; tests do not. */
  close() {
    this.indexWatcher?.close();
    this.indexWatcher = null;
    this.indexSnapshot = null;
  }

  /** The index for every asset, newest first, rebuilt only when it has to be. */
  entries() {
    this.startIndexWatch();
    const maxAge = this.indexWatchFailed ? this.indexMaxAgeWithoutWatchMs : this.indexMaxAgeMs;
    const age = this.now() - this.indexSnapshotAt;
    if (this.indexSnapshot && age < maxAge && this.patchIndex()) return this.indexSnapshot;
    const cached = this.loadIndexCache();
    const rebuilt = [];
    let reused = 0;
    for (const filePath of this.files()) {
      // One stat answers both questions: does this file still exist, and is
      // the row we already built for it still true. Reading the file only
      // happens when the answer is no — which at startup is almost never,
      // and is where the whole cost of this list used to be.
      const signature = statSignature(filePath);
      const previous = cached.get(filePath);
      if (signature && previous && previous.mtimeMs === signature.mtimeMs && previous.size === signature.size) {
        rebuilt.push(previous.entry);
        reused += 1;
        continue;
      }
      const entry = this.indexEntry(filePath, this.readAssetForListing(filePath));
      rebuilt.push(entry);
      if (signature) this.indexSignatures.set(filePath, signature);
    }
    const built = rebuilt.sort(compareIndexEntries);
    this.indexSnapshot = built;
    this.indexSnapshotAt = this.now();
    this.dirtyIndexPaths.clear();
    this.indexReusedFromCache = reused;
    this.saveIndexCache();
    return built;
  }

  /**
   * The index as it was last written, keyed by path.
   *
   * Rebuilding from the files themselves meant a restart read every asset —
   * 286 MB across 7,332 of them on one measured store — to recover a dozen
   * small fields per row. The cache carries the file signature each row was
   * built from, so a row is reused only while its file is byte-for-byte the
   * one it came from.
   */
  loadIndexCache() {
    const byPath = new Map();
    if (this.indexCacheLoaded) {
      for (const entry of this.indexSnapshot || []) {
        const signature = this.indexSignatures.get(entry.filePath);
        if (signature) byPath.set(entry.filePath, { ...signature, entry });
      }
      return byPath;
    }
    this.indexCacheLoaded = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.indexCachePath, 'utf8'));
      if (parsed?.version !== INDEX_CACHE_VERSION || !Array.isArray(parsed.entries)) return byPath;
      for (const row of parsed.entries) {
        const filePath = String(row?.entry?.filePath || '');
        if (!filePath || !Number.isFinite(row.mtimeMs) || !Number.isFinite(row.size)) continue;
        byPath.set(filePath, { mtimeMs: row.mtimeMs, size: row.size, entry: row.entry });
        this.indexSignatures.set(filePath, { mtimeMs: row.mtimeMs, size: row.size });
        if (row.cpaEntry && typeof row.cpaEntry === 'object' && !Array.isArray(row.cpaEntry)) {
          this.persistedCpa.set(filePath, { mtimeMs: row.mtimeMs, size: row.size, entry: row.cpaEntry });
        }
      }
    } catch {
      // No cache, unreadable, or written by another version: rebuild from the
      // files, which is what this always did.
    }
    return byPath;
  }

  /** Best effort: a store that cannot write its cache still works, just cold. */
  saveIndexCache() {
    if (!this.indexSnapshot) return;
    const entries = [];
    for (const entry of this.indexSnapshot) {
      const signature = this.indexSignatures.get(entry.filePath);
      if (!signature) continue;
      const cpaEntry = this.cpaEntryForSignature(entry.filePath, signature);
      entries.push(cpaEntry ? { ...signature, entry, cpaEntry } : { ...signature, entry });
    }
    const temporary = `${this.indexCachePath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.indexCachePath), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify({ version: INDEX_CACHE_VERSION, entries }));
      fs.renameSync(temporary, this.indexCachePath);
      this.cpaProjectionsUnsaved = false;
    } catch {
      try { fs.rmSync(temporary, { force: true }); } catch { /* nothing to undo */ }
    }
  }

  /**
   * Fold the files the watch reported into the snapshot in place.
   *
   * A run rewrites assets continuously, and the console polls this list
   * every few seconds. Dropping the whole snapshot on each write meant
   * every poll re-stat-ed the store — two calls per asset, so 14,664 of
   * them at 7,332 assets — to learn what one file had changed.
   *
   * Returns false when the caller should rebuild instead: too many files
   * changed to be worth patching one by one.
   */
  patchIndex() {
    if (!this.dirtyIndexPaths.size) return true;
    if (this.dirtyIndexPaths.size > this.maxIndexPatch) return false;
    const dirty = [...this.dirtyIndexPaths];
    this.dirtyIndexPaths.clear();
    const byPath = new Map(this.indexSnapshot.map((entry) => [entry.filePath, entry]));
    let changed = false;
    for (const filePath of dirty) {
      let entry = null;
      try {
        const signature = statSignature(filePath);
        if (!signature) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        entry = this.indexEntry(filePath, this.readAssetForListing(filePath));
        this.indexSignatures.set(filePath, signature);
      } catch (error) {
        // Gone between the event and now: drop it. Anything else is a
        // filesystem problem this cache must not paper over.
        if (error.code !== 'ENOENT') { this.indexSnapshot = null; return false; }
        this.readCache.delete(filePath);
        this.persistedCpa.delete(filePath);
        this.indexSignatures.delete(filePath);
      }
      const previous = byPath.get(filePath);
      if (entry) {
        if (previous === entry) continue;
        byPath.set(filePath, entry);
      } else if (previous) {
        byPath.delete(filePath);
      } else continue;
      changed = true;
    }
    if (changed) {
      this.indexSnapshot = [...byPath.values()].sort(compareIndexEntries);
      this.saveIndexCache();
    }
    return true;
  }

  filePath(id) {
    const name = `asset-${safeAssetId(id)}.json`;
    const live = path.join(this.assetRoot, name);
    // The live copy wins; the archive answers only for an id that is no longer
    // listed. A write to an archived asset updates it where it lies rather
    // than quietly resurrecting it into the index.
    if (fs.existsSync(live)) return live;
    const archived = path.join(this.archiveRoot, name);
    return fs.existsSync(archived) ? archived : live;
  }

  /** Archived asset files. `emails.json` is the roster, not an asset. */
  archivedFiles() {
    try {
      return fs.readdirSync(this.archiveRoot)
        .filter((name) => ASSET_FILE.test(name) && !name.endsWith('.bak'))
        .map((name) => path.join(this.archiveRoot, name));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  /**
   * Moves assets between the listing and the archive.
   *
   * A rename, not a rewrite: the bytes are untouched, the `.bak` beside each
   * file travels with it, and `restore` is the same call in reverse. Nothing
   * is deleted, so a mistake costs one more move rather than an account.
   */
  relocate(ids, { restore = false } = {}) {
    const from = restore ? this.archiveRoot : this.assetRoot;
    const to = restore ? this.assetRoot : this.archiveRoot;
    fs.mkdirSync(to, { recursive: true });
    const moved = [];
    const skipped = [];
    for (const id of ids) {
      const name = `asset-${safeAssetId(id)}.json`;
      const source = path.join(from, name);
      if (!fs.existsSync(source)) {
        skipped.push({ id, reason: restore ? 'not_archived' : 'not_listed' });
        continue;
      }
      const target = path.join(to, name);
      if (fs.existsSync(target)) {
        skipped.push({ id, reason: 'already_present' });
        continue;
      }
      fs.renameSync(source, target);
      // The backup is part of the record: leaving it behind would let a later
      // read of the live directory resurrect a stale copy of an archived asset.
      if (fs.existsSync(`${source}.bak`)) fs.renameSync(`${source}.bak`, `${target}.bak`);
      this.readCache.delete(source);
      this.persistedCpa.delete(source);
      this.readCache.delete(target);
      this.persistedCpa.delete(target);
      moved.push(id);
    }
    if (moved.length) {
      this.indexSnapshot = null;
      this.dirtyIndexPaths.clear();
      this.changeVersion += 1;
      // Patched for just the moved accounts. A full rebuild reads every
      // archived file twice; on an unlock from the console that froze the
      // server for minutes. The full rebuild stays as the fallback when the
      // previous snapshot cannot be trusted.
      this.patchArchivedIndex(moved, { restore });
    }
    return { moved, skipped };
  }

  /**
   * Archived asset ids for these addresses, read from the archive snapshot so
   * an unlock does not have to open every archived file to find its accounts.
   */
  archivedIdsForEmails(emails = []) {
    const wanted = new Set([...emails].map((email) => normalizedEmail(email)).filter(Boolean));
    if (!wanted.size) return [];
    const ids = new Set();
    for (const entry of this.archivedIndex().cpa || []) {
      const id = String(entry?.id || '').trim();
      if (!id) continue;
      if (wanted.has(normalizedEmail(entry.email)) || wanted.has(normalizedEmail(entry.parentEmail))) ids.add(id);
    }
    return [...ids];
  }

  files() {
    try {
      return fs.readdirSync(this.assetRoot)
        .filter((name) => ASSET_FILE.test(name) && !name.endsWith('.bak'))
        .map((name) => path.join(this.assetRoot, name));
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw error;
    }
  }

  /**
   * A parsed asset, re-read only when the file changes.
   *
   * There are hundreds of these and the console touches nearly all of them on
   * every poll: the run list resolves one per job, the assets page lists them
   * all, and the CPA page walks them twice. Every one of those was an open,
   * read, parse and schema check. The cached value is shared — `get` clones
   * before handing it out, and the list paths only read.
   */
  /**
   * The cache record behind one file: the parsed asset, plus room for its
   * derived query index. Both are keyed on the same mtime/size check so a
   * single stat serves the read path and the filter path.
   */
  readRecord(filePath) {
    const signatures = [filePath, `${filePath}.bak`].map((candidate) => {
      try {
        const stats = fs.statSync(candidate);
        return { cacheable: true, value: { mtimeMs: stats.mtimeMs, size: stats.size } };
      } catch (error) {
        // A missing backup is a stable signature. Other stat errors are not:
        // caching through a transient permission or filesystem failure could
        // make a later change invisible indefinitely.
        return error.code === 'ENOENT'
          ? { cacheable: true, value: null }
          : { cacheable: false, value: null };
      }
    });
    const sameSignature = (left, right) => (left === null && right === null)
      || (left?.mtimeMs === right?.mtimeMs && left?.size === right?.size);
    const cached = this.readCache.get(filePath);
    if (cached
      && signatures.every((signature) => signature.cacheable)
      && sameSignature(cached.primary, signatures[0].value)
      && sameSignature(cached.backup, signatures[1].value)) return cached;
    const record = {
      primary: signatures[0].value,
      backup: signatures[1].value,
      value: this.readFileUncached(filePath),
      index: null,
    };
    if (signatures.every((signature) => signature.cacheable)) this.readCache.set(filePath, record);
    return record;
  }

  readFile(filePath) {
    return this.readRecord(filePath).value;
  }

  readAssetForListing(filePath) {
    try { return this.readFile(filePath); } catch (error) {
      return corruptAssetForFile(filePath, error);
    }
  }

  /**
   * The narrow row the filter and the counts run over.
   *
   * Built once per file version and reused, because the console asks for the
   * whole store every few seconds and building full summaries for 1400 assets
   * only to discard all but one page of them is most of what that request cost.
   * `accessTokenExpiresAt` is carried rather than the `atExpired` facet: expiry
   * arrives on its own while the file is untouched, so it is judged per query.
   */
  indexEntry(filePath, asset) {
    const record = this.readCache.get(filePath);
    if (record?.index) return record.index;
    const value = asset === undefined ? this.readFile(filePath) : asset;
    const mailProvider = sessionAssetMailProvider(value);
    const graded = { ...value, mailProvider };
    const createdAtMs = Date.parse(String(value.createdAt || ''));
    const index = {
      id: String(value.id || ''),
      filePath,
      lifecycle: assetLifecycle(graded),
      nextAction: assetNextAction(graded),
      facets: staticFacets(graded),
      hasAccessToken: hasAccessToken(value),
      accessTokenExpiresAt: String(value.accessTokenExpiresAt || ''),
      oauthCooldownUntil: String(value.oauthCooldown?.until || ''),
      sourceRunId: String(value.sourceRunId || ''),
      updatedAt: String(value.updatedAt || ''),
      createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : Infinity,
      search: [value.email, value.accountId, value.id, value.planType, value.sourceRunId]
        .map((value) => String(value || '').toLowerCase())
        .join(' '),
    };
    if (record) record.index = index;
    return index;
  }

  readFileUncached(filePath) {
    const read = (candidate) => {
      const value = runtimeSecrets.parse(fs.readFileSync(candidate, 'utf8'));
      if (value.schemaVersion !== SESSION_ASSET_SCHEMA_VERSION) {
        throw new Error(`Unsupported session asset schema: ${value.schemaVersion}`);
      }
      safeAssetId(value.id);
      if (!normalizedEmail(value.email)) throw new Error('Session asset email is required');
      return value;
    };
    try {
      const value = read(filePath);
      const passwordReconciled = reconcilePasswordConfirmation(value, this.now);
      const reauthReconciled = reconcileSecurityReauth(value, this.now);
      const rebindReconciled = reconcileReboundMailbox(value);
      // Deliberately does not touch `updatedAt`: stamping the clock here would
      // reorder the whole list — it is sorted by that field — the first time a
      // migrated store was read, which is not a change the operator made.
      const lifecycleReconciled = reconcileLifecycle(value);
      if (passwordReconciled || reauthReconciled || lifecycleReconciled || rebindReconciled) {
        // Migrate known legacy records once. A failed write must not
        // make an otherwise readable asset unavailable.
        try { this.save(value); } catch { /* The in-memory reconciliation remains usable. */ }
      }
      return value;
    } catch (primary) {
      try {
        const backup = read(`${filePath}.bak`);
        reconcileReboundMailbox(backup);
        return backup;
      } catch {
        throw primary;
      }
    }
  }

  allRaw() {
    return this.entries().map((entry) => this.readAssetForListing(entry.filePath));
  }

  /**
   * The narrow record the CPA artifact listing runs over.
   *
   * `allRaw` hands back whole assets, and the listing reads six fields from
   * each: the history page polls it every ten seconds and the store holds
   * thousands of files, so rebuilding full objects — two `stat` calls apiece
   * just to confirm the cache — was most of what that request cost. This is
   * built once per file version and cached beside the filter index, so a
   * listing between two index rebuilds touches no filesystem at all.
   *
   * `lifecycle` is the stored field rather than the derived one on purpose:
   * the listing groups CPA files by the shelf an operator put them on, not by
   * the health grade `assetLifecycle` computes.
   */
  cpaEntry(filePath) {
    const record = this.readCache.get(filePath);
    if (record?.cpaIndex) return record.cpaIndex;
    // A file already parsed in this process is the fresher source; the
    // persisted row only stands in for one that has not been read yet.
    const signature = record ? null : this.indexSignatures.get(filePath);
    const persisted = signature ? this.persistedCpa.get(filePath) : null;
    if (persisted && persisted.mtimeMs === signature.mtimeMs && persisted.size === signature.size) {
      return persisted.entry;
    }
    let value;
    try { value = this.readFile(filePath); } catch { return null; }
    this.cpaProjectionsUnsaved = true;
    const cpa = value.cpa && typeof value.cpa === 'object' && !Array.isArray(value.cpa) ? value.cpa : null;
    const entry = {
      id: String(value.id || ''),
      email: String(value.email || ''),
      parentEmail: String(value.parentEmail || ''),
      lifecycle: String(value.lifecycle || ''),
      isPlus: isPlusAsset(value),
      cpa: cpa ? {
        path: String(cpa.path || ''),
        runId: String(cpa.runId || ''),
        jobId: String(cpa.jobId || ''),
        revision: Number(cpa.revision || 0),
        completionStatus: String(cpa.completionStatus || ''),
      } : null,
    };
    const cached = this.readCache.get(filePath);
    if (cached) cached.cpaIndex = entry;
    return entry;
  }

  /**
   * Every asset as a CPA-listing record, archived ones included.
   *
   * Archiving takes an account out of the login-state listing, which is where
   * its cost was, but the CPA page is a record of what was sold — an operator
   * locks a batch precisely so it stays readable. The archived half comes from
   * the snapshot rather than from the files, so the page keeps its history
   * without paying for it. See `cpaEntry` and `archivedIndex`.
   */
  cpaEntries() {
    const entries = [];
    for (const entry of this.entries()) {
      const projected = this.cpaEntry(entry.filePath);
      // The registration country rides on the index row (its `exitCountry:`
      // facet), so attaching it here costs no file read; the projection itself
      // stays as persisted.
      if (projected) entries.push({ ...projected, registrationCountry: registrationCountryFromFacets(entry.facets) });
    }
    // New projections were read from disk: persist them so the next restart
    // (and the next cold listing) does not have to read those files again.
    if (this.cpaProjectionsUnsaved) this.saveIndexCache();
    entries.push(...this.archivedIndex().cpa);
    return entries;
  }

  /** The CPA projection for a file, only if it was built from `signature`. */
  cpaEntryForSignature(filePath, signature) {
    const record = this.readCache.get(filePath);
    if (record?.cpaIndex
      && record.primary?.mtimeMs === signature.mtimeMs
      && record.primary?.size === signature.size) return record.cpaIndex;
    const persisted = this.persistedCpa.get(filePath);
    if (persisted && persisted.mtimeMs === signature.mtimeMs && persisted.size === signature.size) {
      return persisted.entry;
    }
    return null;
  }

  /**
   * `{ id, sourceRunId }` for every asset, from the cached index.
   *
   * The only two fields the in-use scan reads, and the index already carries
   * both — reading whole assets for them re-stats the entire store on a poll
   * that runs whenever a task is open.
   */
  ownershipEntries() {
    return this.entries().map(({ id, sourceRunId }) => ({ id, sourceRunId }));
  }

  /**
   * Every address this store has ever seen, lowercased.
   *
   * The registration path needs to know what has already been registered, and
   * the asset store is the only local record of that. Both the account address
   * and the root it was derived from are included: a root that produced
   * aliases has itself been spent for the `root` strategy.
   */
  knownEmails() {
    // The archive counts. This set is the only thing standing between a
    // recycled mailbox and a second registration of an address that already
    // has an account, and archiving a sold account must not quietly make its
    // address available again — so the roster below stands in for the files
    // that are no longer listed.
    const emails = new Set(this.archivedIndex().emails);
    for (const asset of this.allRaw()) {
      const email = String(asset?.email || '').trim().toLowerCase();
      const parent = String(asset?.parentEmail || '').trim().toLowerCase();
      if (email) emails.add(email);
      if (parent) emails.add(parent);
    }
    return emails;
  }

  /**
   * Sold accounts whose CPA batch has been locked long enough to be settled.
   *
   * Two records have to agree: this store knows which accounts are sold, and
   * the lock registry beside it knows when their batch was closed. The address
   * is the join, and it comes from the asset rather than the index row, which
   * is built for filtering and carries none.
   */
  settledSoldIds({ hours = SETTLED_ARCHIVE_HOURS, skip = new Set() } = {}) {
    const cutoff = this.now() - Math.max(0, Number(hours) || 0) * 3_600_000;
    const settled = new Set();
    let entries;
    try {
      entries = JSON.parse(fs.readFileSync(path.join(this.stateRoot, 'cpa-locked-batches.json'), 'utf8')).entries || {};
    } catch (error) {
      if (error.code !== 'ENOENT' && error.name !== 'SyntaxError') throw error;
      return [];
    }
    for (const [key, value] of Object.entries(entries)) {
      const lockedAt = Date.parse(value?.lockedAt || '');
      if (!Number.isFinite(lockedAt) || lockedAt > cutoff) continue;
      const email = path.basename(String(key)).replace(/-cpa\.json$/i, '').trim().toLowerCase();
      if (email) settled.add(email);
    }
    if (!settled.size) return [];
    const ids = [];
    for (const row of this.entries()) {
      if (String(row.lifecycle || '') !== 'sold' || skip.has(row.id)) continue;
      const email = String(this.readFile(row.filePath)?.email || '').trim().toLowerCase();
      if (email && settled.has(email)) ids.push(row.id);
    }
    return ids;
  }

  archivedIndexPath() {
    return path.join(this.archiveRoot, 'index.json');
  }

  /**
   * What the archive holds, without reading the archive.
   *
   * Two pages still need something from an archived account: the registration
   * path asks whether its address has been used, and the CPA listing shows the
   * locked batch it belongs to. Reading 3891 files to answer either would undo
   * the point of moving them, and nothing in an archived account changes — it
   * is sold and its batch is locked — so a snapshot taken as the files move is
   * permanently true.
   *
   * Checked against the archive's file count on every read: a mismatch means
   * someone moved files by hand, and the snapshot is rebuilt rather than
   * trusted.
   */
  archivedIndex() {
    const files = this.archivedFiles();
    if (!files.length) return { emails: new Set(), cpa: [] };
    if (this.archivedIndexCache?.count === files.length) return this.archivedIndexCache.value;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.archivedIndexPath(), 'utf8'));
      if (Number(parsed?.assets) === files.length && Array.isArray(parsed.emails) && Array.isArray(parsed.cpa)) {
        const value = {
          emails: new Set(parsed.emails.map((email) => String(email || '').trim().toLowerCase()).filter(Boolean)),
          cpa: parsed.cpa,
        };
        this.archivedIndexCache = { count: files.length, value };
        return value;
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && error.name !== 'SyntaxError') throw error;
    }
    return this.rewriteArchivedIndex(files);
  }

  /**
   * Applies one relocate to the archive snapshot without re-reading the
   * archive. Restored ids leave it (and their addresses, unless another
   * archived account still carries them); newly archived ids are read once
   * each and added.
   */
  patchArchivedIndex(ids = [], { restore = false } = {}) {
    let previous = null;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.archivedIndexPath(), 'utf8'));
      if (Array.isArray(parsed?.emails) && Array.isArray(parsed?.cpa)) previous = parsed;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.name !== 'SyntaxError') throw error;
    }
    const files = this.archivedFiles();
    const previousCount = Number(previous?.assets);
    const expectedPrevious = restore ? files.length + ids.length : files.length - ids.length;
    // A snapshot that was already out of step with the archive is not patched.
    if (!previous || previousCount !== expectedPrevious) return this.rewriteArchivedIndex(files);
    const moved = new Set(ids.map((id) => String(id)));
    const normalize = (value) => String(value || '').trim().toLowerCase();
    let cpa = previous.cpa.filter((entry) => !moved.has(String(entry?.id || '')));
    const emails = new Set(previous.emails.map(normalize).filter(Boolean));
    if (restore) {
      const stillArchived = new Set();
      for (const entry of cpa) {
        for (const value of [entry?.email, entry?.parentEmail]) if (normalize(value)) stillArchived.add(normalize(value));
      }
      for (const entry of previous.cpa) {
        if (!moved.has(String(entry?.id || ''))) continue;
        for (const value of [entry?.email, entry?.parentEmail]) {
          const email = normalize(value);
          if (email && !stillArchived.has(email)) emails.delete(email);
        }
      }
    } else {
      for (const id of moved) {
        const entry = this.cpaEntry(path.join(this.archiveRoot, `asset-${safeAssetId(id)}.json`));
        if (!entry) continue;
        cpa.push(entry);
        for (const value of [entry.email, entry.parentEmail]) if (normalize(value)) emails.add(normalize(value));
      }
    }
    const value = { emails, cpa };
    if (files.length) {
      fs.writeFileSync(
        this.archivedIndexPath(),
        `${JSON.stringify({ assets: files.length, emails: [...emails], cpa }, null, 2)}\n`,
      );
    } else {
      try { fs.unlinkSync(this.archivedIndexPath()); } catch { /* nothing to clear */ }
    }
    this.archivedIndexCache = { count: files.length, value };
    return value;
  }

  rewriteArchivedIndex(files = this.archivedFiles()) {
    const emails = new Set();
    const cpa = [];
    for (const file of files) {
      const entry = this.cpaEntry(file);
      if (entry) cpa.push(entry);
      let asset;
      try { asset = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
      for (const value of [asset?.email, asset?.parentEmail]) {
        const normalized = String(value || '').trim().toLowerCase();
        if (normalized) emails.add(normalized);
      }
    }
    const value = { emails, cpa };
    if (files.length) {
      fs.mkdirSync(this.archiveRoot, { recursive: true });
      fs.writeFileSync(
        this.archivedIndexPath(),
        `${JSON.stringify({ assets: files.length, emails: [...emails], cpa }, null, 2)}\n`,
      );
    } else {
      try { fs.unlinkSync(this.archivedIndexPath()); } catch { /* nothing to clear */ }
    }
    this.archivedIndexCache = { count: files.length, value };
    return value;
  }

  list() {
    // Bound explicitly rather than passed to `map`, which would hand the
    // summary the array index as its clock.
    return this.allRaw().map((asset) => assetSummary(asset, this.now));
  }

  /**
   * Resolve a filter against the index: the matching entries, and the counts.
   *
   * Shared by `query` and `matchedIds` so a page, its counts, and "select all"
   * are three views of one computation. The console used to derive its own
   * groups and count them over a different base set than it rendered, so a
   * group could advertise 1330 accounts and then draw 171; keeping one matcher
   * here makes that disagreement unrepresentable.
   *
   * Each axis is counted with the *other* axes applied but not its own, so a
   * label reads as "what you get if you click this".
   */
  matchEntries(options = {}) {
    const lifecycle = String(options.lifecycle || '').trim().toLowerCase();
    const queue = String(options.queue || '').trim().toLowerCase();
    const facets = [...new Set((Array.isArray(options.facets) ? options.facets : [])
      .map((facet) => String(facet || '').trim())
      .filter(Boolean))];
    const sourceRun = String(options.sourceRun || '').trim();
    const search = String(options.q || '').trim().toLowerCase();
    const now = this.now;

    const expired = (entry) => entry.hasAccessToken
      && accessTokenExpired({ accessTokenExpiresAt: entry.accessTokenExpiresAt }, now);
    const oauthCooling = (entry) => oauthCooldownActive({
      oauthCooldown: { until: entry.oauthCooldownUntil },
    }, now);
    // `atExpired` is judged here rather than stored: an access token ages out
    // while its file sits untouched, and the index is cached against that
    // file's mtime, so a baked-in expiry facet would never turn true.
    const hasFacet = (entry, facet) => (facet === 'atExpired'
      ? expired(entry)
      : (facet === 'oauthCooldown' ? oauthCooling(entry) : entry.facets.includes(facet)));

    // The text and source-run filters scope every axis, counts included: a
    // search narrows what all three axes are counted over.
    const scoped = this.entries().filter((entry) => (!sourceRun || entry.sourceRunId === sourceRun)
      && (!search || entry.search.includes(search)));

    const matchesLifecycle = (entry) => !lifecycle || lifecycle === 'all' || entry.lifecycle === lifecycle;
    const matchesQueue = (entry) => !queue || queue === 'all' || entry.nextAction === queue;
    const matchesFacets = (entry) => facets.every((facet) => hasFacet(entry, facet));

    const facetNames = new Set(['atExpired', 'oauthCooldown']);
    for (const entry of scoped) for (const facet of entry.facets) facetNames.add(facet);
    const counts = { lifecycle: {}, queue: {}, facets: {} };
    for (const name of facetNames) counts.facets[name] = 0;

    const matched = [];
    for (const entry of scoped) {
      const byLifecycle = matchesLifecycle(entry);
      const byQueue = matchesQueue(entry);
      const byFacets = matchesFacets(entry);
      if (byQueue && byFacets) counts.lifecycle[entry.lifecycle] = (counts.lifecycle[entry.lifecycle] || 0) + 1;
      if (byLifecycle && byFacets) counts.queue[entry.nextAction] = (counts.queue[entry.nextAction] || 0) + 1;
      if (byLifecycle && byQueue && byFacets) {
        matched.push(entry);
        // Counted as "the current selection, narrowed by this one", so a chip
        // says how much clicking it removes rather than how many exist overall.
        for (const facet of facetNames) if (hasFacet(entry, facet)) counts.facets[facet] += 1;
      }
    }
    return { matched, counts };
  }

  /** One filtered page of full row summaries, with the counts beside them. */
  query(options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || 200, 1), 2000);
    const offset = Math.max(Number(options.cursor) || 0, 0);
    const { matched, counts } = this.matchEntries(options);
    if (options.sort === 'createdAtAsc') {
      matched.sort((left, right) => left.createdAtMs - right.createdAtMs || left.id.localeCompare(right.id));
    }
    const page = matched.slice(offset, offset + limit);
    return {
      assets: page.map((entry) => listSummary(this.readAssetForListing(entry.filePath), this.now)),
      total: matched.length,
      offset,
      limit,
      cursor: offset + page.length < matched.length ? String(offset + page.length) : '',
      counts,
      // Every source task that produced an asset, newest first. The console
      // offers these as a filter and cannot enumerate them from one page.
      sourceRuns: [...new Set(this.entries().map((entry) => entry.sourceRunId).filter(Boolean))],
    };
  }

  /**
   * Just the ids a filter matches, read straight off the index.
   *
   * "Select all" has to mean every match, not every row that happens to be
   * loaded, or a bulk delete quietly spares whatever sat below the fold.
   */
  matchedIds(options = {}) {
    const { matched } = this.matchEntries(options);
    return { ids: matched.map((entry) => entry.id), total: matched.length };
  }

  get(id, options = {}) {
    const asset = this.readFile(this.filePath(id));
    return options.raw === false ? assetSummary(asset, this.now) : clone(asset);
  }

  /**
   * The stored record itself, shared and never to be mutated.
   *
   * `get` hands out a deep clone, which is the right default for anything that
   * writes back. Reading a few fields off several hundred assets is not that:
   * a credential export cloned every ~40 KB asset twice — once to check the
   * identity against its CPA, once to build the line — for six strings.
   */
  peek(id) {
    return this.readFile(this.filePath(id));
  }

  /**
   * The record behind one login state, as the console inspector needs it.
   *
   * The raw asset carries the credentials that panel exists to show, but none
   * of the derived fields the shared status helpers read, so both are merged
   * here rather than leaving the caller to recompute them.
   */
  detail(id) {
    const asset = this.readFile(this.filePath(id));
    // Resolved once and fed to grouping, so the inspector and the list row
    // agree on the mailbox channel.
    const mailProvider = sessionAssetMailProvider(asset);
    return {
      ...clone(asset),
      mailProvider,
      ...assetGrouping({ ...asset, mailProvider }, this.now),
      ...secretPresence(asset),
      // Keep the transaction and failure details available to the inspector;
      // the compact projection is exposed separately for consumers that only
      // need the derived status fields.
      security: clone(asset.security),
      securitySummary: securitySummary(asset.security),
      sourceProxy: sourceProxySummary(asset.sourceProxy),
      rebindProxy: sourceProxySummary(asset.rebindProxy),
      oauthCooldown: oauthCooldownSummary(asset, this.now),
    };
  }

  findIdentity(input = {}) {
    const accountId = String(input.accountId || '').trim();
    const email = normalizedEmail(input.email);
    if (!accountId && !email) return null;
    // The index already includes both identities. Narrow the candidates in
    // memory, then verify exact matches against the authoritative asset.
    // Reading allRaw here re-statted every asset for every new account.
    const accountSearch = accountId.toLowerCase();
    for (const entry of this.entries()) {
      if (!(accountSearch && entry.search.includes(accountSearch))
        && !(email && entry.search.includes(email))) continue;
      const candidate = this.readAssetForListing(entry.filePath);
      if (candidate.status !== 'corrupt'
        && ((accountId && String(candidate.accountId || '') === accountId)
          || (email && normalizedEmail(candidate.email) === email))) return candidate;
    }
    return null;
  }

  save(asset) {
    const file = this.filePath(asset.id);
    fs.mkdirSync(this.assetRoot, { recursive: true });
    if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.bak`);
    atomicWriteText(file, `${JSON.stringify(runtimeSecrets.protect(asset), null, 2)}\n`);
    this.changeVersion += 1;
    this.readCache.delete(file);
    this.persistedCpa.delete(file);
    // Preserve the other rows; the next reader patches this one even before
    // fs.watch delivers its event. Archived assets must stay out of the list.
    if (path.dirname(file) === this.assetRoot) this.dirtyIndexPaths.add(file);
    return clone(asset);
  }

  upsert(input = {}) {
    const email = String(input.email || '').trim();
    if (!normalizedEmail(email)) throw new Error('Session asset email is required');
    const existing = input.id ? this.get(input.id) : this.findIdentity(input);
    const timestamp = nowIso(this.now);
    // Legacy assets did not persist the provider. Keep the inferred value when
    // an existing asset is updated so a later save turns the migration into an
    // explicit binding instead of writing the empty legacy field back again.
    const inheritedMailProvider = existing
      ? sessionAssetMailProvider(existing)
      : sessionAssetMailProvider(input);
    const requestedMailProvider = [
      input.mailProvider,
      existing?.mailProvider,
      inheritedMailProvider,
    ].map((value) => String(value || '').trim()).find(Boolean) || '';
    const mailProvider = requestedMailProvider ? normalizedMailProvider(requestedMailProvider) : '';
    if (requestedMailProvider && !mailProvider) {
      throw new Error(`Unsupported session asset mail provider: ${requestedMailProvider}`);
    }
    const accessToken = input.accessToken !== undefined ? String(input.accessToken || '') : String(existing?.accessToken || '');
    const cookieInput = input.cookieJar ?? input.cookies;
    const retained = (key, fallback) => input[key] !== undefined ? input[key] : (existing?.[key] ?? fallback);
    const hasLifecycleInput = Object.hasOwn(input, 'lifecycle') && input.lifecycle !== undefined;
    const hasClassificationInput = Object.hasOwn(input, 'classification') && input.classification !== undefined;
    // Both fields identify the same inventory pool. A patch that names either
    // one must be able to move the pool; when both are present, lifecycle is
    // the newer authoritative spelling and classification follows it.
    const requestedLifecycle = hasLifecycleInput
      ? input.lifecycle
      : hasClassificationInput
        ? input.classification
        : (existing?.lifecycle ?? existing?.classification);
    const resolvedLifecycle = assetLifecycle({
      ...(existing || {}),
      ...input,
      classification: hasClassificationInput
        ? classification(input.classification)
        : classification(existing?.classification),
      lifecycle: requestedLifecycle,
    });
    const asset = {
      ...(existing || {}),
      ...clone(input),
      schemaVersion: SESSION_ASSET_SCHEMA_VERSION,
      id: existing?.id || input.id || crypto.randomUUID(),
      email,
      normalizedEmail: normalizedEmail(email),
      accountId: String(input.accountId ?? existing?.accountId ?? ''),
      parentEmail: String(input.parentEmail ?? existing?.parentEmail ?? ''),
      parentMailboxId: input.parentMailboxId ?? existing?.parentMailboxId ?? '',
      mailProvider,
      status: String(input.status || existing?.status || 'valid'),
      classification: LEGACY_CLASSIFICATIONS.includes(resolvedLifecycle) ? resolvedLifecycle : 'active',
      lifecycle: resolvedLifecycle,
      planType: String(input.planType || existing?.planType || 'unknown').toLowerCase(),
      accessToken,
      accessTokenExpiresAt: input.accessTokenExpiresAt
        || accessTokenExpiry(accessToken)
        || existing?.accessTokenExpiresAt
        || '',
      cookieJar: cookieInput !== undefined
        ? serializeCookieJar(cookieInput)
        : clone(existing?.cookieJar || serializeCookieJar()),
      clientProfile: clone(retained('clientProfile', null)),
      clientProfileFingerprint: String(input.clientProfileFingerprint ?? existing?.clientProfileFingerprint ?? ''),
      oaiDid: String(input.oaiDid ?? existing?.oaiDid ?? ''),
      sessionToken: String(input.sessionToken ?? existing?.sessionToken ?? ''),
      sourceProxy: clone(retained('sourceProxy', null)),
      rebindProxy: clone(retained('rebindProxy', null)),
      session: clone(retained('session', null)),
      me: clone(retained('me', null)),
      security: clone(retained('security', {})),
      health: clone(retained('health', null)),
      trial: clone(retained('trial', null)),
      oauth: clone(retained('oauth', null)),
      oauthCooldown: clone(Object.hasOwn(input, 'oauthCooldown')
        ? input.oauthCooldown
        : existing?.oauthCooldown ?? null),
      sourceKind: String(input.sourceKind ?? existing?.sourceKind ?? ''),
      sourceRunId: String(input.sourceRunId ?? existing?.sourceRunId ?? ''),
      createdAt: existing?.createdAt || input.createdAt || timestamp,
      updatedAt: timestamp,
      lastValidatedAt: input.lastValidatedAt ?? existing?.lastValidatedAt ?? '',
      lastError: clone(Object.hasOwn(input, 'lastError') ? input.lastError : existing?.lastError ?? null),
      cpa: clone(Object.hasOwn(input, 'cpa') ? input.cpa : existing?.cpa ?? null),
    };
    delete asset.cookies;
    return this.save(asset);
  }

  update(id, patch = {}) {
    const existing = this.get(id);
    return this.upsert({
      ...clone(patch),
      id,
      // `upsert` retains every omitted field from the existing record. Keeping
      // the patch narrow preserves the distinction between an omitted
      // lifecycle and a lifecycle explicitly changed by the caller.
      email: patch.email ?? existing.email,
    });
  }

  setOAuthCooldown(id, details = {}) {
    const asset = this.get(id);
    const now = Number(this.now());
    const atMs = Number.isFinite(now) ? now : Date.now();
    const durationMs = Number(details.durationMs);
    const requestedUntil = Date.parse(String(details.until || ''));
    const currentUntil = Date.parse(String(asset.oauthCooldown?.until || ''));
    const requestedFailureCount = Number(details.failureCount);
    const fallbackUntil = atMs + (
      Number.isFinite(durationMs) && durationMs > 0
        ? durationMs
        : OAUTH_FAILURE_COOLDOWN_MS
    );
    const untilMs = Math.max(
      Number.isFinite(requestedUntil) && requestedUntil > atMs ? requestedUntil : fallbackUntil,
      Number.isFinite(currentUntil) && currentUntil > atMs ? currentUntil : 0,
    );
    const cooldown = {
      until: new Date(untilMs).toISOString(),
      reason: String(details.reason || 'oauth_failure_budget_exhausted'),
      failureCount: Number.isFinite(requestedFailureCount)
        ? Math.max(0, Math.floor(requestedFailureCount))
        : 0,
      sourceRunId: String(details.sourceRunId || ''),
      sourceJobId: String(details.sourceJobId || ''),
      setAt: new Date(atMs).toISOString(),
    };
    const previous = asset.oauthCooldown && typeof asset.oauthCooldown === 'object'
      ? asset.oauthCooldown
      : null;
    const unchanged = previous
      && String(previous.until || '') === cooldown.until
      && String(previous.reason || '') === cooldown.reason
      && Number(previous.failureCount || 0) === cooldown.failureCount
      && String(previous.sourceRunId || '') === cooldown.sourceRunId
      && String(previous.sourceJobId || '') === cooldown.sourceJobId;
    if (unchanged && oauthCooldownActive(asset, this.now)) {
      return {
        changed: false,
        cooldown: oauthCooldownSummary(asset, this.now),
        asset: assetSummary(asset, this.now),
      };
    }
    const saved = this.update(id, { oauthCooldown: cooldown });
    return {
      changed: true,
      cooldown: oauthCooldownSummary(saved, this.now),
      asset: assetSummary(saved, this.now),
    };
  }

  clearOAuthCooldown(id) {
    const asset = this.get(id);
    const hadCooldown = Boolean(asset.oauthCooldown && typeof asset.oauthCooldown === 'object');
    if (!hadCooldown) {
      return { changed: false, asset: assetSummary(asset, this.now) };
    }
    const saved = this.update(id, { oauthCooldown: null });
    return { changed: true, asset: assetSummary(saved, this.now) };
  }

  /**
   * Move accounts between inventory pools.
   *
   * `classification` is written alongside `lifecycle` so a rollback to the
   * previous build still reads the right pool. `banned` is not settable here —
   * it is a fact about the account discovered by a probe, not an operator
   * decision — but moving a banned account back to `active` is allowed, which
   * is how a wrongly flagged account is recovered.
   */
  markLifecycle(ids = [], value = 'sold') {
    const normalized = String(value || '').trim().toLowerCase();
    if (!SETTABLE_LIFECYCLES.has(normalized)) {
      throw new Error(`Unsupported session asset lifecycle: ${value}`);
    }
    const requested = Array.isArray(ids) ? ids : [];
    const keys = [...new Set(requested.map((id) => safeAssetId(id)))];
    const changed = [];
    const missing = [];
    const at = nowIso(this.now);
    for (const key of keys) {
      let asset;
      try { asset = this.get(key); } catch (error) {
        if (error.code === 'ENOENT') { missing.push(key); continue; }
        throw error;
      }
      const current = assetLifecycle(asset);
      // A deactivated account moved back to `active`, `planned` or `self_use`
      // would be re-derived as `banned` on the next read, so the health verdict
      // is cleared with it. All three moves assert the account is usable;
      // `sold` does not, and a sold account keeps its ban record.
      const clearing = ['active', 'planned', 'self_use'].includes(normalized) && current === 'banned';
      if (current === normalized) continue;
      this.save({
        ...asset,
        classification: LEGACY_CLASSIFICATIONS.includes(normalized) ? normalized : 'active',
        lifecycle: normalized,
        ...(clearing ? { health: null, lastError: null } : {}),
        updatedAt: at,
      });
      changed.push(key);
    }
    return {
      requested: requested.length,
      lifecycle: normalized,
      classification: normalized,
      changed,
      missing,
    };
  }

  /** @deprecated Kept for callers that predate the lifecycle axis. */
  markClassification(ids = [], value = 'sold') {
    return this.markLifecycle(ids, value);
  }

  replaceCpa(id, account, metadata = {}) {
    const asset = this.get(id);
    const previous = clone(asset.cpa || null);
    let previousFilePath = '';
    if (previous?.path) {
      try { previousFilePath = resolveInside(this.cpaRoot, previous.path); } catch { /* Replace unsafe legacy metadata. */ }
    }
    const filePath = path.join(this.cpaRoot, 'session-assets', cpaFileNameForEmail(asset.email));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    atomicWriteText(filePath, `${JSON.stringify(runtimeSecrets.protect(account), null, 2)}\n`);
    const cpa = {
      path: path.relative(this.cpaRoot, filePath),
      revision: Number(previous?.revision || 0) + 1,
      runId: String(metadata.runId || ''),
      jobId: String(metadata.jobId || ''),
      // A CPA can outlive the run state that produced it. Keep the job-level
      // outcome with the canonical asset so the artifact badge remains useful
      // after task history is removed.
      completionStatus: String(metadata.completionStatus || 'complete').trim() || 'complete',
      updatedAt: nowIso(this.now),
    };
    const previousOauth = oauthSummary(asset);
    const oauth = {
      successful: true,
      successCount: Math.max(previousOauth.successCount, Number(previous?.revision || 0)) + 1,
      lastSucceededAt: cpa.updatedAt,
      lastRunId: cpa.runId,
      lastJobId: cpa.jobId,
    };
    // A successful OAuth is a stronger resolution than a temporary failure
    // budget lock. Clear the lock as the canonical CPA is written.
    this.update(id, { cpa, oauth, oauthCooldown: null });
    if (previousFilePath && path.resolve(previousFilePath) !== path.resolve(filePath)) {
      try { fs.unlinkSync(previousFilePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return { previous, cpa, filePath };
  }

  migrateCpaFileNames() {
    const migrated = [];
    const collisions = [];
    // Runs on every start. Walking `allRaw()` here read and parsed every asset
    // file just to find the few (usually none) with a legacy CPA file name.
    // The CPA projection carries the two fields that decide it, so only an
    // asset that actually needs moving is read in full.
    const nothingToMove = (projected) => {
      if (!projected?.cpa?.path || !projected.email) return true;
      let source;
      try { source = resolveInside(this.cpaRoot, projected.cpa.path); } catch { return true; }
      try {
        const target = path.join(this.cpaRoot, 'session-assets', cpaFileNameForEmail(projected.email));
        if (path.resolve(source) === path.resolve(target)) return true;
      } catch {
        // Let the full check below decide exactly as it always has.
      }
      try { return !fs.statSync(source).isFile(); } catch { return true; }
    };
    const candidates = [];
    for (const entry of this.entries()) {
      if (nothingToMove(this.cpaEntry(entry.filePath))) continue;
      candidates.push(this.readAssetForListing(entry.filePath));
    }
    if (this.cpaProjectionsUnsaved) this.saveIndexCache();
    for (const asset of candidates) {
      if (asset.status === 'corrupt' || !asset.cpa?.path || !asset.email) continue;
      let source;
      try { source = resolveInside(this.cpaRoot, asset.cpa.path); } catch { continue; }
      if (!fs.existsSync(source) || !fs.statSync(source).isFile()) continue;
      const target = path.join(this.cpaRoot, 'session-assets', cpaFileNameForEmail(asset.email));
      if (path.resolve(source) === path.resolve(target)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      if (fs.existsSync(target)) {
        if (!fs.readFileSync(source).equals(fs.readFileSync(target))) {
          collisions.push({ assetId: asset.id, source, target });
          continue;
        }
      } else {
        fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      }
      this.save({
        ...asset,
        cpa: {
          ...asset.cpa,
          path: path.relative(this.cpaRoot, target),
        },
      });
      try { fs.unlinkSync(source); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      migrated.push({ assetId: asset.id, source, target });
    }
    return { migrated, collisions };
  }

  removalPlan(ids, options = {}) {
    const plan = [];
    const missing = [];
    for (const rawId of ids || []) {
      const id = safeAssetId(rawId);
      let asset;
      try { asset = this.get(id); } catch (error) {
        if (error.code === 'ENOENT') { missing.push(id); continue; }
        throw error;
      }
      const files = [];
      if (options.cascadeCpa && asset.cpa?.path) files.push(resolveInside(this.cpaRoot, asset.cpa.path));
      const file = this.filePath(id);
      files.push(file, `${file}.bak`);
      // All predictable failures must happen before the first file is removed.
      // This keeps a multi-account deletion retryable when one record is bad.
      for (const candidate of files) {
        try {
          if (fs.lstatSync(candidate).isDirectory()) throw new Error(`Cannot remove directory as a session asset file: ${candidate}`);
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
        }
      }
      plan.push({ id, file, files });
    }
    return { plan, missing };
  }

  validateRemove(ids, options = {}) {
    return this.removalPlan(ids, options);
  }

  remove(ids, options = {}) {
    const { plan, missing } = this.removalPlan(ids, options);
    const removed = [];
    for (const entry of plan) {
      for (const candidate of entry.files) {
        try { fs.unlinkSync(candidate); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      this.readCache.delete(entry.file);
      this.persistedCpa.delete(entry.file);
      this.changeVersion += 1;
      this.indexSnapshot = null;
      removed.push(entry.id);
    }
    return { requested: (ids || []).length, removed, missing, cpaRemoved: options.cascadeCpa === true };
  }

  export(ids, options = {}) {
    const kind = String(options.kind || 'at');
    const format = String(options.format || 'email-at');
    // Read-only: the lines below take six fields per asset, so this must not
    // clone the whole record for each of them.
    const selected = (ids || []).map((id) => this.peek(id));
    const lines = [];
    const skipped = [];
    // Whether each exported account already went through OAuth (it has a CPA),
    // for the file name: a buyer's batch should say so without being opened.
    let oauth = 0;
    for (const asset of selected) {
      if (kind === 'credentials') {
        if (!asset.password && !asset.totpSecret) { skipped.push(asset.id); continue; }
        lines.push(`${asset.email}----${asset.password || ''}----${asset.totpSecret || ''}`);
        if (asset.cpa?.path) oauth += 1;
        continue;
      }
      if (!asset.accessToken) { skipped.push(asset.id); continue; }
      lines.push(format === 'raw' ? asset.accessToken : `${asset.email}----${asset.accessToken}`);
      if (asset.cpa?.path) oauth += 1;
    }
    if (!['at', 'credentials'].includes(kind)) throw new Error(`Unsupported session asset export kind: ${kind}`);
    if (kind === 'at' && !['raw', 'email-at'].includes(format)) throw new Error(`Unsupported AT export format: ${format}`);
    return {
      fileName: exportFileName({
        label: kind === 'credentials' ? '登录态凭证' : 'AT',
        count: lines.length,
        oauth,
        pending: lines.length - oauth,
        ext: 'txt',
      }),
      contentType: 'text/plain; charset=utf-8',
      content: lines.length ? `${lines.join('\n')}\n` : '',
      exported: lines.length,
      skipped,
    };
  }
}

module.exports = {
  SETTLED_ARCHIVE_HOURS,
  SessionAssetStore,
  assetSummary,
  confirmedRebindMetadata,
  decodeJwtPayload,
  normalizedEmail,
  safeAssetId,
  sessionAssetMailProviderEvidence,
  sourceProxySummary,
};
