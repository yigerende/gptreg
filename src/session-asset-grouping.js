'use strict';

/**
 * The single place that decides where a login-state asset belongs.
 *
 * Three axes, deliberately kept apart because they answer different questions:
 *
 *   lifecycle   which inventory pool the account sits in     (single, exclusive)
 *   nextAction  the one thing to do to it next               (single, exclusive)
 *   facets      everything else worth filtering on           (many, additive)
 *
 * The console used to fold all three into one single-select dropdown and then
 * layer two independent "hide" toggles on top, which is why its counts and its
 * rows disagreed: the counts were computed over one base set and the rows over
 * another. Deriving all three here, server-side, means the API can return the
 * rows and the counts from one pass and they cannot drift apart.
 *
 * Only `./trial-offer` and `./util/shared` are required here, and neither
 * reaches into the asset or chain stores. This is
 * load-bearing: `chain-store` already requires `session-asset-store`, so a
 * grouping module that reached back into `chain-store` would close a cycle and
 * hand `chain-store` an undefined `safeAssetId`. `qualifiesForChain` therefore
 * lives here and `chain-store` re-exports it.
 */

const { isChainRedeemableTrial } = require('./trial-offer');
const { text } = require('./util/shared');

const ASSET_LIFECYCLES = ['active', 'planned', 'self_use', 'sold', 'banned'];
const SALE_LIFECYCLES = ['planned', 'sold'];
// The pools whose accounts are still worked on. `self_use` is a shelf label,
// not a retirement: an account kept for our own use has to stay as healthy as
// one held for sale, so it keeps every queue `active` has.
const WORKING_LIFECYCLES = ['active', 'self_use'];
const NEXT_ACTIONS = ['refresh', 'security', 'chain', 'oauth', 'trial_check', 'none'];
const REGISTERED_SOURCE_KINDS = new Set(['register_session', 'register_oauth']);
const DIRECT_CHAIN_SOURCE_KINDS = new Set(['imported_at']);

const DEACTIVATED_CODE = 'ACCOUNT_DEACTIVATED';
// A probe verdict that means the token itself is gone or wrong, as opposed to
// an inconclusive check. Natural expiry is deliberately absent; see below.
const DEAD_TOKEN_HEALTH = ['invalid', 'mismatch', 'missing'];
const REAUTH_BLOCKED = ['required', 'in_progress', 'retry_pending', 'failed'];
const SETUP_UNFINISHED = ['failed', 'retry_pending'];
const OAUTH_FAILURE_COOLDOWN_MS = 60 * 60 * 1000;

function lower(value) {
  return text(value).toLowerCase();
}

/**
 * The secret-bearing fields arrive in two shapes and both have to work here.
 *
 * The store holds raw assets (`accessToken`, `password`, `totpSecret`); the
 * list summary and the browser hold only presence flags (`hasAccessToken` and
 * friends). Reading both means the same predicate grades a stored record and a
 * payload identically, which is the property the console tests rely on.
 */
function hasAccessToken(asset = {}) {
  return Boolean(asset.accessToken || asset.hasAccessToken);
}

function hasPassword(asset = {}) {
  return Boolean(asset.password || asset.hasPassword);
}

function hasTotp(asset = {}) {
  return Boolean(asset.totpSecret || asset.hasTotp);
}

/** `security` is likewise either the raw record or its flattened summary. */
function securityView(asset = {}) {
  const security = asset.security && typeof asset.security === 'object' ? asset.security : {};
  const reauth = security.securityReauth && typeof security.securityReauth === 'object'
    ? security.securityReauth
    : {};
  const transaction = security.passwordTransaction && typeof security.passwordTransaction === 'object'
    ? security.passwordTransaction
    : {};
  return {
    passwordStatus: lower(security.passwordStatus),
    totpStatus: lower(security.totpStatus),
    reauthStatus: lower(security.securityReauthStatus || reauth.status),
    passwordTransactionStep: lower(security.passwordTransactionStep || transaction.step),
  };
}

function accessTokenExpired(asset = {}, now = Date.now) {
  const expiry = Date.parse(text(asset.accessTokenExpiresAt));
  return Number.isFinite(expiry) && expiry <= now();
}

function oauthSucceeded(asset = {}) {
  return asset.oauth?.successful === true || Boolean(asset.cpa);
}

function oauthCooldownActive(asset = {}, now = Date.now) {
  const until = Date.parse(text(asset.oauthCooldown?.until));
  return Number.isFinite(until) && until > now();
}

/**
 * OpenAI has closed the account.
 *
 * Recorded in two places by two different writers — the health record and the
 * asset's `lastError` — so both are read rather than picking a winner.
 */
function isDeactivated(asset = {}) {
  return lower(asset.health?.status) === 'banned'
    || text(asset.health?.code).toUpperCase() === DEACTIVATED_CODE
    || text(asset.lastError?.code).toUpperCase() === DEACTIVATED_CODE;
}

/**
 * The token is unusable *now*, as judged by an actual probe.
 *
 * Natural expiry is excluded on purpose and is published as the `atExpired`
 * facet instead. An access token that simply aged out does not mean the account
 * needs operator attention, and folding expiry in here would drag 695 settled
 * accounts back into the work queue every time their hour was up. A probe that
 * came back invalid, mismatched or missing is a different claim, and that one
 * does belong in the queue.
 */
function needsSessionRefresh(asset = {}) {
  if (lower(asset.status) === 'corrupt') return false;
  return !hasAccessToken(asset)
    || DEAD_TOKEN_HEALTH.includes(lower(asset.health?.status))
    || ['LOGIN_STATE_INVALID', 'REBIND_SESSION_REFRESH_PENDING'].includes(text(asset.health?.code).toUpperCase());
}

/**
 * Password or TOTP is missing, or its last setup attempt did not finish.
 *
 * A password mutation that returned an MFA continuation is already committed —
 * the account has the password — so it must not be sent back through the
 * OTP/PW flow, which would start a second transaction against a live one.
 */
function needsSecurityRecovery(asset = {}) {
  const security = securityView(asset);
  const passwordCommitted = security.passwordStatus === 'confirmation_mfa_required'
    || security.passwordTransactionStep === 'confirmation_mfa_required';
  const reauthBlocked = REAUTH_BLOCKED.includes(security.reauthStatus);
  const passwordUnfinished = !passwordCommitted && (
    !hasPassword(asset)
    || reauthBlocked
    || SETUP_UNFINISHED.includes(security.passwordStatus)
  );
  const totpUnfinished = !hasTotp(asset)
    || SETUP_UNFINISHED.includes(security.totpStatus)
    || reauthBlocked;
  return passwordUnfinished || totpUnfinished;
}

/** No offer verdict on record yet, so the account's value is still unknown. */
function needsTrialCheck(asset = {}) {
  const status = lower(asset.trial?.status);
  return !status || status === 'unknown';
}

/**
 * Whether an asset has a chain-redeemable Plus offer and a token to use it.
 *
 * A free month on Go is a real, claimable offer and it used to qualify — but it
 * buys a Go subscription, so extracting it produces a link nobody wants. The
 * gate is the Plus free month specifically, not "any free month".
 */
function qualifiesForChain(asset = {}) {
  return lower(asset.trial?.status) === 'trial'
    && isChainRedeemableTrial(asset.trial)
    && hasAccessToken(asset);
}

function isPlusPlan(planType) {
  return lower(planType).includes('plus');
}

/**
 * Optional-chained rather than defaulted: a default parameter only fills in for
 * `undefined`, and the CPA listing calls this with a `null` asset for a file
 * whose account is gone. That path used to have its own copy of this rule in
 * `run-manager`; when the two were merged the stricter signature threw.
 */
function isPlusAsset(asset) {
  return isPlusPlan(asset?.planType)
    || isPlusPlan(asset?.trial?.planType)
    || isPlusPlan(asset?.trial?.subscriptionPlan);
}

/**
 * Which inventory pool the account is in.
 *
 * `sold` is the one assertion that outranks the derived `banned`: an account
 * that was sold and later closed is still sold, and losing that would lose the
 * sale record.
 *
 * `planned` does not outrank it. It is an intent to sell, not a completed sale,
 * and a closed account can never be sold — leaving it in the planned pool only
 * hides dead stock from the cleanup robot, which matches on `banned`. So
 * deactivation promotes `active` and `planned` alike, and only `sold` is held.
 *
 * `self_use` does not outrank it either, and for the same reason as `planned`:
 * it says "this one is ours to use", which a closed account cannot be. A dead
 * account kept under a self-use label would be invisible to the cleanup robot
 * and would still read as usable inventory on the console.
 *
 * Reads the stored `lifecycle` when one is present and falls back to the legacy
 * `classification` field, so this grades migrated and unmigrated records alike.
 */
function assetLifecycle(asset = {}) {
  const stored = lower(asset.lifecycle);
  const legacy = lower(asset.classification);
  const base = ASSET_LIFECYCLES.includes(stored)
    ? stored
    : (SALE_LIFECYCLES.includes(legacy) ? legacy : 'active');
  if (base === 'sold' || base === 'banned') return base;
  return isDeactivated(asset) ? 'banned' : base;
}

/**
 * Whether the security queue has an authoritative verdict for this asset.
 *
 * Old chain/import records were written before security metadata existed. They
 * must keep their historical behaviour, otherwise opening the chain page would
 * silently remove them from the ledger. A registered asset with an actual
 * password/TOTP or security checkpoint is new enough to obey `nextAction`.
 */
function hasAuthoritativeSecurityState(asset = {}) {
  const security = asset.security && typeof asset.security === 'object' ? asset.security : {};
  return Boolean(
    asset.password
      || asset.totpSecret
      || asset.hasPassword === true
      || asset.hasTotp === true
      || security.setPassword === true
      || security.enrollTotp === true
      || text(security.passwordStatus)
      || text(security.totpStatus)
      || text(security.securityReauthStatus)
      || text(security.passwordTransactionStep)
      || (security.passwordTransaction && typeof security.passwordTransaction === 'object' && Object.keys(security.passwordTransaction).length)
      || (security.securityReauth && typeof security.securityReauth === 'object' && Object.keys(security.securityReauth).length),
  );
}

/**
 * Final gate for a record entering the extraction ledger or worker queue.
 *
 * `qualifiesForChain` answers the offer question. This predicate answers the
 * operational question: can this exact asset be consumed by extraction now?
 * Keeping the two separate lets the assets page still show offer facets while
 * preventing lifecycle and security queues from being drained by the chain
 * worker.
 */
function chainQueueEligible(asset = {}) {
  if (!qualifiesForChain(asset)) return false;
  if (!WORKING_LIFECYCLES.includes(assetLifecycle(asset)) || needsSessionRefresh(asset)) return false;

  const sourceKind = lower(asset.sourceKind);
  if (DIRECT_CHAIN_SOURCE_KINDS.has(sourceKind)) return true;
  if (!REGISTERED_SOURCE_KINDS.has(sourceKind)) {
    // Imported ATs and historical OAuth/session records predate the registered
    // account security gate. Their presence in the chain ledger is already an
    // operator decision, so the new security queue must not silently remove
    // them. New registration records are the only source kind whose admission
    // is governed by the security verdict below.
    return true;
  }

  // A registered record with no security verdict is legacy/incomplete data.
  // Once a verdict exists, security must finish before extraction is allowed.
  return !hasAuthoritativeSecurityState(asset) || assetNextAction(asset) === 'chain';
}

/**
 * The priority table. Order is the whole design, so it is a named, exported
 * list rather than an if-chain: changing an operator's queues should mean
 * editing a table and a test, not reading control flow.
 *
 * `chain` sits above `oauth` deliberately. A chain-redeemable account has not
 * been OAuth'd either, so the looser `oauth` rule would swallow every one of
 * them — on the current store that buries 170 extractable accounts inside a
 * bucket of 1186. The redeemable free month is the higher-value action and it
 * expires, so it wins.
 */
const NEXT_ACTION_RULES = [
  { action: 'refresh', matches: needsSessionRefresh },
  { action: 'security', matches: needsSecurityRecovery },
  { action: 'chain', matches: qualifiesForChain },
  { action: 'oauth', matches: (asset) => !oauthSucceeded(asset) },
  { action: 'trial_check', matches: needsTrialCheck },
];

/**
 * The one thing to do to this account next, or 'none'.
 *
 * Exclusive by construction: the first matching rule wins, so the per-action
 * counts partition the queued set and always sum to it.
 *
 * `planned` gets exactly one action — `refresh` — and nothing else. An account
 * reserved for sale still has to stay alive to be sellable, and that probe is
 * also the only thing that ever discovers the account was closed: without it a
 * planned account is never graded, so it can never be derived as `banned` and
 * the cleanup robot never sees it. The other actions (oauth, chain, security,
 * trial) are work on inventory that is not spoken for, so they stay behind the
 * working-pool gate — in particular this must not feed the chain worker, which
 * has its own copy of that gate in `chainQueueEligible`. `sold` is not work.
 *
 * `self_use` is graded exactly like `active`. Marking an account as ours to use
 * changes who it is for, not what has to be true of it, so it keeps refresh,
 * security, chain, oauth and trial work. That is the whole difference between
 * it and `sold`, which is the pool an account leaves the working set through.
 */
function assetNextAction(asset = {}) {
  if (lower(asset.status) === 'corrupt') return 'none';
  const lifecycle = assetLifecycle(asset);
  if (lifecycle === 'planned') return needsSessionRefresh(asset) ? 'refresh' : 'none';
  if (!WORKING_LIFECYCLES.includes(lifecycle)) return 'none';
  return NEXT_ACTION_RULES.find((rule) => rule.matches(asset))?.action || 'none';
}

/**
 * The facets that only change when the asset itself does.
 *
 * Split out from `assetFacets` because the query index is cached against each
 * file's mtime, and `atExpired` is the one facet that turns true on its own
 * while the file sits untouched. Caching it would leave an account looking
 * unexpired until something else happened to rewrite it, so the index stores
 * these and recomputes expiry per query.
 */
function staticFacets(asset = {}) {
  const facets = [];
  // Keep the value and no-value states complementary. A missing/unknown offer
  // is not silently treated as chain-ready, and the negative facet lets the
  // inventory page filter it without reconstructing the rule in the browser.
  if (qualifiesForChain(asset)) facets.push('chainReady');
  else facets.push('noChainValue');
  if (lower(asset.trial?.status) === 'trial') {
    facets.push('hasOffer');
    if (!qualifiesForChain(asset)) facets.push('discountedOnly');
  }
  if (isPlusAsset(asset)) facets.push('plus');
  if (oauthSucceeded(asset)) facets.push('oauthDone');
  else facets.push('oauthPending');

  const mailProvider = lower(asset.mailProvider);
  if (mailProvider) facets.push(`mailProvider:${mailProvider}`);
  // Accounts that were moved off their original iCloud address by the
  // re-bind (换绑) flow carry a `rebind` stamp; expose it as a filterable facet.
  if (asset.rebind && text(asset.rebind.previousEmail)) facets.push('rebound');

  // `countryCode` and `resourceKind` are separate dimensions and must not be
  // merged. The retired trial proxy pool wrote a countryCode of `TRIAL`, which
  // is not a country, and treating it as one puts a fake entry in the country
  // list. The pool is gone but its records are not, so the guard stays.
  const countryCode = text(asset.sourceProxy?.countryCode).toUpperCase();
  if (countryCode && countryCode !== 'TRIAL') facets.push(`exitCountry:${countryCode}`);
  const resourceKind = text(asset.sourceProxy?.resourceKind);
  if (resourceKind) facets.push(`exitResource:${resourceKind}`);

  return facets;
}

function assetFacets(asset = {}, now = Date.now) {
  const facets = staticFacets(asset);
  if (hasAccessToken(asset) && accessTokenExpired(asset, now)) facets.push('atExpired');
  if (oauthCooldownActive(asset, now)) facets.push('oauthCooldown');
  return facets;
}

/**
 * Normalize a stored `lifecycle` onto the asset, once.
 *
 * Follows the same shape as the store's other read-time migrations: it returns
 * whether it changed anything, and the caller persists only then. The latch
 * matters more than it looks — this runs on *every* read of an asset, and the
 * run list resolves one asset per job every two seconds, so a reconcile that
 * cannot tell "already migrated" from "needs migrating" rewrites and fsyncs the
 * whole store on a loop. That has bitten this file twice before.
 *
 * Deactivation is allowed to promote an `active` asset to `banned` and nothing
 * else: an account an operator marked sold stays sold after OpenAI closes it.
 */
function reconcileLifecycle(asset) {
  if (!asset || typeof asset !== 'object') return false;
  const resolved = assetLifecycle(asset);
  if (asset.lifecycle === resolved) return false;
  asset.lifecycle = resolved;
  return true;
}

/** The three axes together, as the list summary and the index both need them. */
function assetGrouping(asset = {}, now = Date.now) {
  return {
    lifecycle: assetLifecycle(asset),
    nextAction: assetNextAction(asset),
    facets: assetFacets(asset, now),
  };
}

module.exports = {
  NEXT_ACTIONS,
  NEXT_ACTION_RULES,
  accessTokenExpired,
  assetFacets,
  assetGrouping,
  assetLifecycle,
  assetNextAction,
  chainQueueEligible,
  hasAccessToken,
  isDeactivated,
  isPlusAsset,
  needsSecurityRecovery,
  needsSessionRefresh,
  oauthCooldownActive,
  OAUTH_FAILURE_COOLDOWN_MS,
  qualifiesForChain,
  reconcileLifecycle,
  staticFacets,
};
