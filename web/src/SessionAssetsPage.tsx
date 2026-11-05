import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Activity, Check, CircleAlert, Clock3, Copy, Download, FilterX, Gift, KeyRound, LoaderCircle, RefreshCw, Repeat, ShieldCheck, Tag, Trash2, Unlock, UserRoundCheck, X } from 'lucide-react';

import { endpoints } from './api';
import { AppSelect } from './components/AppSelect';
import {
  Button,
  ConfigNumberInput,
  ConfirmDialog,
  EmptyState,
  IconButton,
  Notice,
  PageHeader,
  StatusBadge,
  copyText,
  downloadText,
  errorMessage,
  formatTime,
} from './components/ConsoleUi';
import { useRangeSelection } from './components/useRangeSelection';
import { isIcloudAssetRow, setRebindPending } from './rebind-handoff';
import { MAX_WORKER_CONCURRENCY, maintenanceProxyAssignments } from './run-plan-ui';
import { useNavigate } from './router';
import { SESSION_CHECK_GROUP, localActivity, pageResults, useLocalActivity, usePageResult } from './local-activity';
import type { RunPlan, SessionAsset, SessionAssetHealth, SessionAssetLifecycle, SessionAssetListRow, SessionAssetNextAction, SessionAssetOAuthCooldown, SessionAssetProbeBatch, SessionAssetTrial, SessionAssetTrialBatch } from './types';

/** What a finished AT 测活 or 优惠检测 left behind, for the line that restates it. */
type SessionCheckResult = { label: string; tone: string; text: string; at: number };

/**
 * The pools an operator can move an account into. `banned` is discovered.
 *
 * `active` is absent because moving *back* to the pool is a separate button on
 * the CPA page; here the dropdown is only ever used to take something out of
 * general circulation. `self_use` belongs in it even though a self-use account
 * keeps every queue: what the operator is asserting is that this one is spoken
 * for, which is the same kind of statement as planning to sell it.
 */
type SaleLifecycle = 'planned' | 'self_use' | 'sold';

type StoredFilters = {
  search: string;
  sourceRun: string;
  lifecycle: SessionAssetLifecycle | 'all';
  queue: SessionAssetNextAction | 'all';
  facets: string[];
};

const PAGE_SIZE = 200;
// Keep the endpoint's own four-worker concurrency, while splitting large
// selections so the shared top bar can advance after each completed batch.
const SESSION_CHECK_BATCH_SIZE = 4;
// Typing is not a filter change until it stops. Each keystroke otherwise
// becomes its own server query and its own page of rows: typing four letters
// fired four full scans, the first two of which matched most of the store.
const SEARCH_DEBOUNCE_MS = 280;
// Past this many loaded rows the background poll costs more than it is worth —
// it refetches everything already on screen. See `pollInterval`.
const POLL_ROW_BUDGET = 400;
const FILTERS_KEY = 'gpt-re.session-assets.filters.v1';

const DEFAULT_FILTERS: StoredFilters = {
  search: '',
  sourceRun: 'all',
  // The working pool, not everything: sold and planned inventory is still one
  // click away, but it is not what an operator opens this page to act on.
  lifecycle: 'active',
  queue: 'all',
  facets: [],
};

/**
 * Filters survive a reload.
 *
 * At this scale rebuilding a three-axis filter after every refresh is real
 * friction, and the axes are cheap to store. Anything unrecognised falls back
 * to the default rather than being trusted, so a stale or hand-edited entry
 * cannot wedge the page on a filter with no UI to clear it.
 */
function loadFilters(): StoredFilters {
  try {
    const stored = JSON.parse(window.localStorage.getItem(FILTERS_KEY) || '{}');
    return {
      search: typeof stored.search === 'string' ? stored.search : DEFAULT_FILTERS.search,
      sourceRun: typeof stored.sourceRun === 'string' ? stored.sourceRun : DEFAULT_FILTERS.sourceRun,
      lifecycle: LIFECYCLE_ORDER.includes(stored.lifecycle) || stored.lifecycle === 'all' ? stored.lifecycle : DEFAULT_FILTERS.lifecycle,
      queue: QUEUE_ORDER.includes(stored.queue) || stored.queue === 'all' ? stored.queue : DEFAULT_FILTERS.queue,
      facets: Array.isArray(stored.facets) ? stored.facets.filter((facet: unknown) => typeof facet === 'string') : [],
    };
  } catch {
    return DEFAULT_FILTERS;
  }
}

function saveFilters(filters: StoredFilters) {
  try { window.localStorage.setItem(FILTERS_KEY, JSON.stringify(filters)); } catch { /* Private mode; the filters just do not persist. */ }
}

const LIFECYCLE_ORDER = ['active', 'planned', 'self_use', 'sold', 'banned'];
const LIFECYCLE_LABELS: Record<string, string> = {
  active: '在库',
  planned: '计划卖出',
  self_use: '自用',
  sold: '已卖出',
  banned: '已封禁',
};

// Mirrors the server's `NEXT_ACTION_RULES` order, so the dropdown reads in the
// same priority the grading uses.
const QUEUE_ORDER = ['refresh', 'security', 'chain', 'oauth', 'trial_check', 'none'];
const QUEUE_LABELS: Record<string, string> = {
  refresh: 'AT 需刷新',
  security: '待补 PW/OTP',
  chain: '可提链',
  oauth: '待 OAuth',
  trial_check: '待检测优惠',
  none: '无待办',
};
const QUEUE_TONES: Record<string, string> = {
  refresh: 'failed',
  security: 'running',
  chain: 'complete',
  oauth: 'pending',
  trial_check: 'pending',
  none: 'unknown',
};

const SALE_LIFECYCLE_OPTIONS: Array<{ value: SaleLifecycle; label: string }> = [
  { value: 'sold', label: '已卖出' },
  { value: 'planned', label: '计划卖出' },
  { value: 'self_use', label: '自用' },
];
const SALE_LIFECYCLE_ACTION_LABELS: Record<SaleLifecycle, string> = {
  sold: '标记已卖出',
  planned: '标记计划卖出',
  self_use: '标记自用',
};

/** Facets with no value half, in the order they are worth scanning. */
const FLAG_FACETS: Array<[string, string]> = [
  ['chainReady', '可提链'],
  ['noChainValue', '无提链价值'],
  ['hasOffer', '有优惠'],
  ['discountedOnly', '仅折扣'],
  ['atExpired', 'AT 已过期'],
  ['plus', 'Plus'],
  ['oauthDone', '已 OAuth'],
  ['oauthPending', '未 OAuth'],
  ['oauthCooldown', 'OAuth 冷却中'],
];
const FACET_GROUP_LABELS: Record<string, string> = {
  flag: '属性',
  mailProvider: '邮箱通道',
  exitCountry: '出口国家',
  exitResource: '出口资源',
};

function sumCounts(counts?: Record<string, number>) {
  return Object.values(counts || {}).reduce((total, value) => total + value, 0);
}

/**
 * Lay the server's flat facet counts out as chip rows.
 *
 * Namespaced facets are grouped by their prefix and ordered by size, because
 * the useful question of an exit-country list is "where are most of them", not
 * "what does the alphabet say".
 */
function groupFacets(counts: Record<string, number>, selected: string[] = []) {
  // A selected facet is always offered, even when the other axes have narrowed
  // it out of the count list. Dropping it would leave a filter applied with no
  // control on screen to see or clear it.
  const present: Record<string, number> = { ...counts };
  for (const facet of selected) if (!(facet in present)) present[facet] = 0;
  const flags = FLAG_FACETS
    .filter(([facet]) => facet in present)
    .map(([facet, label]) => ({ facet, label, count: present[facet] || 0 }));
  const groups = new Map<string, Array<{ facet: string; label: string; count: number }>>();
  for (const [facet, count] of Object.entries(present)) {
    const separator = facet.indexOf(':');
    if (separator < 0) continue;
    const key = facet.slice(0, separator);
    if (!FACET_GROUP_LABELS[key]) continue;
    const items = groups.get(key) || [];
    items.push({ facet, label: facet.slice(separator + 1), count });
    groups.set(key, items);
  }
  return [
    ...(flags.length ? [{ key: 'flag', label: FACET_GROUP_LABELS.flag, items: flags }] : []),
    ...[...groups].map(([key, items]) => ({
      key,
      label: FACET_GROUP_LABELS[key],
      items: items.sort((left, right) => right.count - left.count || left.label.localeCompare(right.label)),
    })),
  ];
}

const HEALTH_LABELS: Record<string, string> = {
  healthy: '有效',
  invalid: '已失效',
  uncertain: '待确认',
  missing: '缺少 AT',
  mismatch: '身份不符',
  banned: '封禁',
};

function healthLabel(health?: SessionAssetHealth | null) {
  return health ? (HEALTH_LABELS[health.status] || health.status) : '未测活';
}

/**
 * Only a one-month free campaign can be turned into a PayPal link, so the tag
 * has to separate it from the discounted runs (three months at half price, and
 * similar) rather than calling both of them "试用".
 *
 * The campaign list is inspected directly, so assets checked before the backend
 * started persisting `freeMonthOffer` still get the right tag.
 */
function freeMonthTrial(trial?: SessionAssetTrial | null) {
  if (!trial) return false;
  if (trial.campaigns?.length) {
    return trial.campaigns.some((campaign) => campaign.discountPercentage >= 100
      && campaign.durationPeriods === 1
      && String(campaign.durationPeriod || '').toLowerCase() === 'month');
  }
  return trial.freeMonthOffer === true;
}

/** Chain entry gate, mirrored from `qualifiesForChain` on the server. */
function isPlusPlan(planType?: string | null) {
  const normalized = String(planType || '').trim().toLowerCase();
  return normalized === 'plus' || normalized.includes('plus');
}

/**
 * Mirrors `isChainRedeemableTrial` on the server: a free month, on Plus.
 *
 * A Go free month is claimable and shows its own tag, but it buys a Go
 * subscription, so it is not queued for extraction.
 */
function chainRedeemable(trial?: SessionAssetTrial | null) {
  if (!trial) return false;
  if (trial.campaigns?.length) {
    return trial.campaigns.some((campaign) => campaign.discountPercentage >= 100
      && campaign.durationPeriods === 1
      && String(campaign.durationPeriod || '').toLowerCase() === 'month'
      && String(campaign.planName || '').toLowerCase().includes('plus'));
  }
  if (trial.freeMonthOffer !== true) return false;
  return String(trial.offerPlan || trial.subscriptionPlan || '').toLowerCase().includes('plus');
}

function displayPlanType(asset: SessionAssetListRow) {
  // The `plus` facet already folds in the plan recorded on the trial record,
  // which is where a Plus account often shows up first.
  return asset.facets?.includes('plus') ? 'plus' : (asset.planType || 'unknown');
}

/** `chatgptgoplan` -> `Go`. Mirrors `campaignPlanLabel` on the server. */
function planLabel(planName?: string | null) {
  const plan = String(planName || '').trim().toLowerCase();
  if (!plan) return '';
  if (plan === 'chatgptplusplan') return 'Plus';
  if (plan === 'chatgptgoplan') return 'Go';
  if (plan === 'chatgptproplan') return 'Pro';
  const stripped = plan.replace(/^chatgpt/, '').replace(/plan$/, '');
  return stripped ? stripped.charAt(0).toUpperCase() + stripped.slice(1) : '';
}

/** The campaign the chain would actually redeem, or the best one on offer. */
function headlineCampaign(trial?: SessionAssetTrial | null) {
  const campaigns = trial?.campaigns || [];
  if (!campaigns.length) return null;
  const free = campaigns.filter((campaign) => campaign.discountPercentage >= 100
    && campaign.durationPeriods === 1
    && String(campaign.durationPeriod || '').toLowerCase() === 'month');
  if (free.length) return free.find((campaign) => planLabel(campaign.planName) === 'Plus') || free[0];
  return campaigns.find((campaign) => campaign.offerLabel) || campaigns[0];
}

/**
 * Composed from the campaign list first, and only then from the stored string.
 *
 * The stored `offerLabel` on an asset checked before the plan was part of the
 * tag reads `1个月免费` with no hint of which plan it is on — which is the
 * confusion this is here to end. Rebuilding it from the campaign gives old
 * records the plan too, without re-checking every account.
 */
function offerLabel(trial?: SessionAssetTrial | null) {
  if (!trial) return '';
  const campaign = headlineCampaign(trial);
  if (campaign) {
    const plan = planLabel(campaign.planName);
    const stored = campaign.offerLabel || '';
    if (stored) return plan && !stored.startsWith(plan) ? `${plan} ${stored}` : stored;
  }
  if (trial.offerLabel) {
    const plan = trial.offerPlanLabel || planLabel(trial.offerPlan);
    return plan && !trial.offerLabel.startsWith(plan) ? `${plan} ${trial.offerLabel}` : trial.offerLabel;
  }
  return '';
}

/** The plan a free month would actually land on, '' when there is none. */
function freeMonthPlan(trial?: SessionAssetTrial | null) {
  if (!freeMonthTrial(trial)) return '';
  const campaign = headlineCampaign(trial);
  return planLabel(campaign?.planName) || trial?.offerPlanLabel || planLabel(trial?.offerPlan) || '';
}

/**
 * The badge split into its two halves.
 *
 * `Plus 1个月免费` as one run of 9px text in a pill was a wall — the plan and
 * the offer are different facts and the plan is the one being scanned for, so
 * it gets its own token and the offer reads as ordinary text beside it.
 */
function trialParts(trial?: SessionAssetTrial | null): { plan: string; text: string } {
  if (!trial) return { plan: '', text: '待检测' };
  if (trial.status === 'none') return { plan: '', text: '无试用' };
  if (trial.status !== 'trial') return { plan: '', text: '未知' };
  const campaign = headlineCampaign(trial);
  const plan = planLabel(campaign?.planName) || trial.offerPlanLabel || planLabel(trial.offerPlan);
  const full = offerLabel(trial) || (freeMonthTrial(trial) ? '1个月免费' : '试用');
  // `offerLabel` already carries the plan; strip it so it is not shown twice.
  const offer = plan && full.startsWith(`${plan} `) ? full.slice(plan.length + 1) : full;
  return { plan, text: trial.activeTrial ? `试用中 · ${offer}` : offer };
}

function trialLabel(trial?: SessionAssetTrial | null) {
  const { plan, text } = trialParts(trial);
  return plan ? `${plan} ${text}` : text;
}

function trialTone(trial?: SessionAssetTrial | null) {
  if (!trial) return 'pending';
  if (trial.status === 'none') return 'no';
  if (trial.status !== 'trial') return 'unknown';
  // A discounted campaign is a real promo, just not an extractable one.
  if (!freeMonthTrial(trial)) return 'promo';
  // The extractable one — a free month on Plus — is the only gold tag on the
  // page. Every other free month is claimable but buys a different plan, so it
  // reads as information rather than as work waiting to be done.
  return chainRedeemable(trial) ? 'free' : 'free-alt';
}

function campaignSummary(trial?: SessionAssetTrial | null) {
  return (trial?.campaigns || [])
    .map((campaign) => [
      planLabel(campaign.planName) || campaign.planName || campaign.key,
      campaign.label,
      campaign.durationPeriods ? `${campaign.durationPeriods} ${campaign.durationPeriod}` : '',
      campaign.offerLabel || '',
    ].filter(Boolean).join(' · '))
    .join('；');
}

function trialTitle(trial?: SessionAssetTrial | null) {
  if (!trial) return '尚未做过优惠检测，登录态创建后会自动补标签';
  const campaigns = campaignSummary(trial);
  const plan = freeMonthPlan(trial);
  const eligibility = trial.status !== 'trial'
    ? ''
    : (chainRedeemable(trial)
      ? '可进入提链（Plus 一个月免费）'
      : (freeMonthTrial(trial)
        // Claimable, but on a plan this pipeline does not extract.
        ? `免费月在 ${plan || '其他'} 计划上，不进入提链`
        : '折扣试用，不进入提链'));
  return [
    `${trial.code}：${trial.message}`,
    campaigns ? `可领优惠：${campaigns}` : '',
    eligibility,
    trial.checkedAt ? `检测于 ${formatTime(trial.checkedAt)}` : '',
  ].filter(Boolean).join('\n');
}

function planBadgeClass(planType?: string | null) {
  return `plan-badge${isPlusPlan(planType) ? ' plan-badge-plus' : ''}`;
}

function TrialBadge({ trial }: { trial?: SessionAssetTrial | null }) {
  const { plan, text } = trialParts(trial);
  return <span className={`trial-badge trial-${trialTone(trial)}`} title={trialTitle(trial)}>
    {plan && <b className="trial-badge-plan">{plan}</b>}
    <span className="trial-badge-text">{text}</span>
  </span>;
}

/**
 * The pool and exit the account was registered through.
 *
 * Shown so an operator can tell at a glance which country an account belongs to
 * before pointing later work at it — historical assets recorded only the
 * endpoint, so the country is omitted rather than guessed.
 */
function sourceExitLabel(asset: SessionAssetListRow, kind: 'sourceProxy' | 'rebindProxy' = 'sourceProxy') {
  const source = asset[kind];
  if (!source?.endpoint) return '';
  return [source.countryCode, source.endpoint].filter(Boolean).join(' · ');
}

function sourceExitTitle(asset: SessionAssetListRow, kind: 'sourceProxy' | 'rebindProxy' = 'sourceProxy') {
  const source = asset[kind];
  if (!source?.endpoint) return '';
  return [
    `${kind === 'sourceProxy' ? '注册' : '换绑'}代理节点：${source.endpoint}`,
    source.countryCode ? `国家池：${source.countryCode}` : '未记录国家池',
    source.protocol ? `协议：${source.protocol}` : '',
  ].filter(Boolean).join('\n');
}

function oauthSucceeded(asset: SessionAssetListRow) {
  return asset.oauth?.successful === true
    || ('cpa' in asset && Boolean(asset.cpa));
}

function isLatestTaskAsset(asset: SessionAssetListRow, latestRunId: string) {
  return Boolean(latestRunId) && asset.sourceRunId === latestRunId;
}

function accessTokenExpired(asset: SessionAssetListRow) {
  const expiry = Date.parse(String(asset.accessTokenExpiresAt || ''));
  return asset.hasAccessToken === true && Number.isFinite(expiry) && expiry <= Date.now();
}

function isBanned(asset: SessionAssetListRow) {
  // The health record still answers this on a sold account, where `lifecycle`
  // deliberately keeps reporting the pool the operator put it in.
  return asset.lifecycle === 'banned'
    || asset.health?.status === 'banned'
    || String(asset.health?.code || '').toUpperCase() === 'ACCOUNT_DEACTIVATED'
    || String(asset.lastError?.code || '').toUpperCase() === 'ACCOUNT_DEACTIVATED';
}

/** The shelf tag on a row, or nothing for an account still in general circulation. */
function salePoolOf(asset: SessionAssetListRow): SaleLifecycle | null {
  return asset.lifecycle === 'planned' || asset.lifecycle === 'self_use' || asset.lifecycle === 'sold'
    ? asset.lifecycle
    : null;
}

function SessionLifecycleTag({ lifecycle }: { lifecycle: SaleLifecycle }) {
  const label = LIFECYCLE_LABELS[lifecycle];
  return <span className={`session-classification-tag session-classification-${lifecycle}`} title={label}>{label}</span>;
}

function oauthCooldownLabel(cooldown?: SessionAssetOAuthCooldown | null) {
  return cooldown?.active === true ? `OAuth 冷却至 ${formatTime(cooldown.until)}` : '';
}

function OAuthCooldownTag({ cooldown, onClear, clearing = false }: { cooldown?: SessionAssetOAuthCooldown | null; onClear?: () => void; clearing?: boolean }) {
  const label = oauthCooldownLabel(cooldown);
  if (!label) return null;
  const clear = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onClear?.();
  };
  return <span className="session-cooldown-tag" title={label}><span>OAuth 冷却</span>{onClear && <IconButton label="强制解除 OAuth 冷却" className="session-cooldown-clear" onClick={clear} disabled={clearing}>{clearing ? <LoaderCircle className="spin" size={12} /> : <Unlock size={12} />}</IconButton>}</span>;
}

/** The queue an account sits in, as the server graded it. */
function NextActionBadge({ asset }: { asset: SessionAssetListRow }) {
  const action = asset.nextAction || 'none';
  return <StatusBadge status={QUEUE_TONES[action] || 'unknown'} label={QUEUE_LABELS[action] || action} />;
}

function displayedHealth(asset: SessionAssetListRow): SessionAssetHealth | null {
  const hasAccessToken = asset.hasAccessToken === true;
  if (isBanned(asset)) {
    return {
      ...(asset.health || {}),
      status: 'banned',
      code: 'ACCOUNT_DEACTIVATED',
      message: asset.health?.message || asset.lastError?.message || '账号已封禁',
      httpStatus: asset.health?.httpStatus || 403,
      checkedAt: asset.health?.checkedAt || asset.updatedAt || asset.lastValidatedAt || '',
      latencyMs: asset.health?.latencyMs || 0,
      lastHealthyAt: asset.health?.lastHealthyAt || '',
    };
  }
  if (hasAccessToken && accessTokenExpired(asset) && (!asset.health || ['healthy', 'uncertain'].includes(asset.health.status))) {
    return {
      ...(asset.health || {}),
      status: 'invalid',
      code: 'AT_EXPIRED',
      message: 'AT 已过期，按失效处理',
      httpStatus: 0,
      checkedAt: asset.health?.checkedAt || asset.lastValidatedAt || asset.accessTokenExpiresAt || '',
      latencyMs: 0,
      lastHealthyAt: asset.health?.lastHealthyAt || '',
    };
  }
  if (asset.health) return asset.health;
  if (!asset.hasAccessToken || !asset.lastValidatedAt) return null;
  return {
    status: 'healthy',
    code: 'SESSION_VERIFIED',
    message: '登录态保存时已验证 AT 与账号身份',
    httpStatus: 200,
    checkedAt: asset.lastValidatedAt,
    latencyMs: 0,
    lastHealthyAt: asset.lastValidatedAt,
  };
}

function securityRecoveryLabel(asset: SessionAssetListRow) {
  const reauthStatus = String(asset.security?.securityReauthStatus || asset.security?.securityReauth?.status || '');
  const reauthMethod = String(asset.security?.securityReauthMethod || asset.security?.securityReauth?.method || '');
  const emailOtpStatus = String(asset.security?.securityReauthEmailStatus || asset.security?.securityReauth?.emailOtp?.status || '');
  if (reauthStatus === 'in_progress') return '安全重认证中';
  if (reauthStatus === 'required' || reauthStatus === 'retry_pending') {
    return reauthMethod === 'email_otp' || emailOtpStatus === 'waiting'
      ? '待邮箱 OTP 重认证'
      : '待安全重认证';
  }
  if (reauthStatus === 'failed') {
    return reauthMethod === 'email_otp' || emailOtpStatus
      ? '邮箱 OTP 重认证失败'
      : '安全重认证失败';
  }
  if (!asset.hasPassword || ['failed', 'retry_pending'].includes(asset.security?.passwordStatus || '')) return '待补密码';
  if (!asset.hasTotp || ['failed', 'retry_pending'].includes(asset.security?.totpStatus || '')) return '待补 TOTP';
  if (asset.security?.passwordStatus === 'confirmation_mfa_required') return '密码已完成';
  return '安全设置已完成';
}

const SECURITY_REAUTH_STATES = new Set(['required', 'in_progress', 'retry_pending', 'failed']);
const SECURITY_RETRY_STATES = new Set(['failed', 'retry_pending']);

/**
 * Keep the recovery action usable for legacy summaries as well as the current
 * server-graded `nextAction`. The list endpoint used to omit that derived
 * field, while the presence flags and security statuses were already enough to
 * decide whether a recovery run had work to do.
 */
function needsSecurityRecovery(asset: SessionAssetListRow) {
  const security = asset.security || {};
  const reauth = String(security.securityReauthStatus || security.securityReauth?.status || '').toLowerCase();
  const passwordStatus = String(security.passwordStatus || '').toLowerCase();
  const totpStatus = String(security.totpStatus || '').toLowerCase();
  const passwordConfirmation = passwordStatus === 'confirmation_mfa_required'
    || String(security.passwordTransactionStep || security.passwordTransaction?.step || '').toLowerCase() === 'confirmation_mfa_required';
  const passwordNeedsRecovery = !passwordConfirmation
    && (!asset.hasPassword || SECURITY_REAUTH_STATES.has(reauth) || SECURITY_RETRY_STATES.has(passwordStatus));
  const totpNeedsRecovery = !asset.hasTotp
    || SECURITY_REAUTH_STATES.has(reauth)
    || SECURITY_RETRY_STATES.has(totpStatus);
  return passwordNeedsRecovery || totpNeedsRecovery;
}

// Rows rendered before the scroll container has been measured. See `renderRows`.
const UNMEASURED_ROW_BUDGET = 30;

function sessionCheckBatches(assetIds: string[]) {
  const ids = [...new Set(assetIds.filter(Boolean))];
  const batches: string[][] = [];
  for (let index = 0; index < ids.length; index += SESSION_CHECK_BATCH_SIZE) {
    batches.push(ids.slice(index, index + SESSION_CHECK_BATCH_SIZE));
  }
  return { ids, batches };
}

async function runSessionCheckBatches<T>(
  assetIds: string[],
  request: (batch: string[]) => Promise<T>,
  onProgress: (done: number) => void,
) {
  const { ids, batches } = sessionCheckBatches(assetIds);
  const results: T[] = [];
  let done = 0;
  for (const batch of batches) {
    results.push(await request(batch));
    done += batch.length;
    onProgress(done);
  }
  return { ids, results };
}

function combineProbeBatches(batches: SessionAssetProbeBatch[], requested: number): SessionAssetProbeBatch {
  const results = batches.flatMap((batch) => batch.results);
  return { requested, checked: results.length, results };
}

function combineTrialBatches(batches: SessionAssetTrialBatch[], requested: number): SessionAssetTrialBatch {
  const results = batches.flatMap((batch) => batch.results);
  const atProbeResults = batches.flatMap((batch) => batch.atProbe?.results || []);
  return {
    requested,
    checked: results.length,
    results,
    atProbe: atProbeResults.length
      ? { requested: atProbeResults.length, checked: atProbeResults.length, results: atProbeResults }
      : null,
  };
}

/**
 * What a check found, without naming the check.
 *
 * The page line puts the name in its own label, so a `text` that repeated it
 * read 「AT 测活  AT 测活完成：有效 21」. The name is added back where there is
 * nothing else to identify it — the floating notice on another page, and the
 * top bar's tooltip.
 */
type SessionCheckNotice = { tone: 'success' | 'warning' | 'danger' | 'info'; summary: string };

function checkMessage(label: string, summary: string) {
  return `${label}完成：${summary}`;
}

function probeNotice(result: SessionAssetProbeBatch): SessionCheckNotice {
  const healthy = result.results.filter((item) => item.status === 'healthy').length;
  const invalid = result.results.filter((item) => ['invalid', 'mismatch'].includes(item.status)).length;
  const uncertain = result.checked - healthy - invalid;
  return {
    tone: healthy === result.checked ? 'success' : 'warning',
    summary: `有效 ${healthy}${invalid ? ` · 失效/不符 ${invalid}` : ''}${uncertain ? ` · 待确认 ${uncertain}` : ''}`,
  };
}

function trialNotice(result: SessionAssetTrialBatch): SessionCheckNotice {
  const withTrial = result.results.filter((item) => item.status === 'trial').length;
  const freeMonth = result.results.filter((item) => item.status === 'trial' && freeMonthTrial(item)).length;
  const discounted = withTrial - freeMonth;
  const without = result.results.filter((item) => item.status === 'none').length;
  const unknown = result.checked - withTrial - without;
  const probed = result.atProbe?.results || [];
  const deadTokens = probed.filter((item) => ['invalid', 'mismatch', 'missing'].includes(item.status)).length;
  const followUp = probed.length
    ? `，已补测 ${probed.length} 个未知项的 AT：${deadTokens ? `失效 ${deadTokens}` : '均未失效'}`
    : '';
  return {
    tone: deadTokens || unknown > 0 ? 'warning' : 'success',
    summary: `一个月免费 ${freeMonth}${discounted ? ` · 折扣试用 ${discounted}` : ''}${without ? ` · 无试用 ${without}` : ''}${unknown ? ` · 未知 ${unknown}` : ''}${followUp}`,
  };
}

export function SessionAssetsPage() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [filters, setFilters] = useState<StoredFilters>(loadFilters);
  // What the input shows, versus what the query uses. They differ only while
  // the operator is mid-word.
  const [searchDraft, setSearchDraft] = useState(() => filters.search);
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [focusedId, setFocusedId] = useState('');
  const [refreshConcurrency, setRefreshConcurrency] = useState(MAX_WORKER_CONCURRENCY);
  const [cascadeCpa, setCascadeCpa] = useState(false);
  const [saleLifecycle, setSaleLifecycle] = useState<SaleLifecycle>('sold');
  const [notice, setNotice] = useState<{ tone: string; text: string } | null>(null);
  const { search, sourceRun, lifecycle, queue, facets } = filters;

  useEffect(() => { saveFilters(filters); }, [filters]);
  useEffect(() => {
    if (searchDraft === filters.search) return;
    const timer = window.setTimeout(() => setFilters((current) => ({ ...current, search: searchDraft })), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [searchDraft, filters.search]);
  // A narrower filter almost always means a shorter list, so paging back to the
  // first page keeps "载入更多" honest instead of leaving a stale deep offset.
  useEffect(() => { setLimit(PAGE_SIZE); }, [search, sourceRun, lifecycle, queue, facets]);

  const query = useMemo(() => ({
    lifecycle,
    queue,
    facets,
    sourceRun: sourceRun === 'all' ? '' : sourceRun,
    q: search.trim(),
  }), [facets, lifecycle, queue, search, sourceRun]);

  // The server resolves the three axes and returns the counts alongside the
  // rows, so a group's label and its list are the same computation and cannot
  // disagree. Previous data is held during a refetch so changing a filter does
  // not blank the list.
  // The poll refetches whatever is loaded, so its cost grows with every press
  // of "载入更多": at 1000 rows one refresh is ~2 MB and several seconds of
  // server time, every five seconds. A deep page is a deliberate browse rather
  // than a dashboard, so the poll backs off and then stops, and the operator
  // refreshes explicitly. The first page keeps its live cadence.
  const pollInterval = limit <= PAGE_SIZE ? 5000 : (limit <= POLL_ROW_BUDGET ? 20000 : false as const);
  const page = useQuery({
    queryKey: ['session-assets', query, limit],
    queryFn: () => endpoints.sessionAssets({ ...query, limit }),
    refetchInterval: pollInterval,
    placeholderData: keepPreviousData,
  });
  const runs = useQuery({ queryKey: ['runs'], queryFn: endpoints.runs, refetchInterval: 5000 });
  const config = useQuery({ queryKey: ['config'], queryFn: endpoints.config });
  const detail = useQuery({ queryKey: ['session-asset', focusedId], queryFn: () => endpoints.sessionAsset(focusedId), enabled: Boolean(focusedId), refetchInterval: 5000 });

  const rows = useMemo(() => page.data?.assets || [], [page.data?.assets]);
  const counts = page.data?.counts;
  const total = page.data?.total || 0;
  const sourceRuns = useMemo(() => page.data?.sourceRuns || [], [page.data?.sourceRuns]);
  const moreCursor = page.data?.cursor || '';

  // Selection survives a filter change, so the batch bar has to say something
  // about accounts that are no longer on screen — and the id lists returned by
  // "select all" carry no detail of their own. Only the one fact the batch bar
  // needs is kept, rather than every row ever loaded: remembering whole
  // summaries meant holding the entire store in memory after a full browse.
  const seenNeedsSecurity = useRef(new Map<string, boolean>());
  useEffect(() => {
    for (const asset of rows) {
      seenNeedsSecurity.current.set(asset.id, asset.nextAction === 'security' || needsSecurityRecovery(asset));
    }
  }, [rows]);

  const latestAssetRunId = useMemo(() => {
    const assetRunIds = [...new Set([
      ...sourceRuns,
      ...rows.map((asset) => asset.sourceRunId).filter(Boolean),
    ])];
    const listed = (runs.data?.runs || [])
      .filter((run) => assetRunIds.includes(run.runId))
      .map((run, index) => ({ run, index }))
      .sort((left, right) => {
        const rightTime = Date.parse(String(right.run.updatedAt || '')) || 0;
        const leftTime = Date.parse(String(left.run.updatedAt || '')) || 0;
        return rightTime - leftTime || left.index - right.index;
      })[0]?.run;
    return listed?.runId || assetRunIds[0] || '';
  }, [rows, runs.data?.runs, sourceRuns]);

  const rowIds = useMemo(() => rows.map((asset) => asset.id), [rows]);
  const rangeSelection = useRangeSelection({ keys: rowIds, selected, setSelected });
  // The store grows without bound and every row carries three badges and three
  // buttons, so past a couple of hundred accounts the page stops scrolling
  // smoothly. The range brush already owns the scroll container's ref, and the
  // virtualizer reuses it rather than introducing a second scroll parent.
  const listVirtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => rangeSelection.containerProps.ref.current,
    estimateSize: () => 59,
    getItemKey: (index) => rows[index]?.id ?? index,
    overscan: 10,
  });
  // A hidden or not-yet-laid-out panel briefly reports zero height, which is
  // every first commit — the ref is still null when the virtualizer first runs.
  // The fallback used to render the *entire* list at that moment: with a few
  // hundred accounts that is thousands of nodes built synchronously, then
  // discarded one frame later when the observer reports a real size.
  const virtualRows = listVirtual.getVirtualItems();
  const renderRows = virtualRows.length
    ? virtualRows
    : rows.slice(0, UNMEASURED_ROW_BUDGET).map((_, index) => ({ index, start: index * 59 }));

  const actionIds = useMemo(
    () => (selected.size ? [...selected] : (focusedId ? [focusedId] : [])),
    [selected, focusedId],
  );
  const visibleIds = useMemo(() => new Set(rowIds), [rowIds]);
  const offViewCount = useMemo(
    () => [...selected].filter((id) => !visibleIds.has(id)).length,
    [selected, visibleIds],
  );
  // Errs towards enabled. "Select all" hands back ids without detail, so some
  // selected accounts may never have been loaded; the recovery task skips
  // whatever is already configured, which makes a false positive harmless and a
  // false negative an account nobody can fix from here.
  const securityRecoveryNeeded = useMemo(
    () => actionIds.some((id) => seenNeedsSecurity.current.get(id) !== false),
    [actionIds, rows],
  );
  const allMatchedSelected = total > 0 && selected.size >= total && rows.every((asset) => selected.has(asset.id));

  const workerCount = Math.max(1, Math.min(actionIds.length || 1, refreshConcurrency, MAX_WORKER_CONCURRENCY));
  // Everything launched from this page works on accounts that already exist, so
  // it goes through the configured local forwarder instead of drawing from the
  // country pools. Registration tasks are started from the task page and keep
  // their pool exit for the whole job, OAuth leg included.
  const proxyAssignments = maintenanceProxyAssignments(workerCount);
  const oauthPlanFor = (ids: string[]): RunPlan => {
    const count = ids.length;
    const concurrency = Math.max(1, Math.min(count || 1, refreshConcurrency, MAX_WORKER_CONCURRENCY));
    return {
      schemaVersion: 3,
      taskKind: 'oauth',
      mailCount: count,
      workerConcurrency: concurrency,
      aliasStrategy: 'root',
      aliasCount: 1,
      aliasMaxAttempts: 1,
      aliasRunTag: String(config.data?.config.aliases?.runTag || 'gptre'),
      totalAccounts: count,
      proxyAssignments: maintenanceProxyAssignments(concurrency),
      oauthSource: { kind: 'session_assets', assetIds: ids },
      postRegistrationOAuth: false,
      security: { setPassword: false, enrollTotp: false },
    };
  };
  const refreshReady = actionIds.length > 0;
  const selectedCooldownIds = useMemo(
    () => new Set(rows.filter((asset) => asset.oauthCooldown?.active === true).map((asset) => asset.id)),
    [rows],
  );
  const oauthReady = actionIds.length > 0 && !actionIds.some((id) => selectedCooldownIds.has(id));

  const patch = (next: Partial<StoredFilters>) => setFilters((current) => ({ ...current, ...next }));
  const toggleFacet = (facet: string) => setFilters((current) => ({
    ...current,
    facets: current.facets.includes(facet)
      ? current.facets.filter((item) => item !== facet)
      : [...current.facets, facet],
  }));

  useEffect(() => {
    setFocusedId((current) => (current && visibleIds.has(current) ? current : (rows[0]?.id || '')));
  }, [rows, visibleIds]);

  const selectAllMatched = useMutation({
    mutationFn: () => endpoints.sessionAssetIds(query),
    onSuccess: (result) => {
      setSelected(new Set(result.ids));
      if (result.ids.length > rows.length) {
        setNotice({ tone: 'success', text: `已选中全部 ${result.ids.length} 个匹配账号，其中 ${result.ids.length - rows.length} 个不在当前视图` });
      }
    },
    onError: (error) => setNotice({ tone: 'danger', text: errorMessage(error) }),
  });
  const exportAssets = useMutation({
    mutationFn: (options: { kind: 'at' | 'credentials'; format?: 'raw' | 'email-at' }) => endpoints.exportSessionAssets({ assetIds: actionIds, ...options }),
    onSuccess: (result) => {
      downloadText(result.content, result.fileName, result.contentType);
      setNotice({ tone: 'success', text: `已导出 ${result.exported} 条记录${result.skipped.length ? `，跳过 ${result.skipped.length} 条缺失项` : ''}` });
    },
    onError: (error) => setNotice({ tone: 'danger', text: errorMessage(error) }),
  });
  const refresh = useMutation({
    mutationFn: (securityRecovery: boolean) => endpoints.refreshSessionAssets({
      assetIds: actionIds,
      workerConcurrency: workerCount,
      proxyAssignments,
      security: securityRecovery
        ? { setPassword: true, enrollTotp: true }
        : { setPassword: false, enrollTotp: false },
    }),
    onSuccess: (run) => { client.invalidateQueries({ queryKey: ['runs'] }); navigate(`/run/${run.runId}`); },
    onError: (error) => setNotice({ tone: 'danger', text: errorMessage(error) }),
  });
  const oauth = useMutation({
    mutationFn: (ids: string[]) => endpoints.startRun(oauthPlanFor(ids)),
    onSuccess: (run) => { client.invalidateQueries({ queryKey: ['runs'] }); navigate(`/run/${run.runId}`); },
    onError: (error) => setNotice({ tone: 'danger', text: errorMessage(error) }),
  });
  const probe = useMutation({
    mutationFn: async (assetIds: string[]) => {
      const { ids } = sessionCheckBatches(assetIds);
      const activityId = localActivity.begin({ label: 'AT 测活', done: 0, total: ids.length, group: SESSION_CHECK_GROUP });
      try {
        const { results } = await runSessionCheckBatches(
          assetIds,
          (batch) => endpoints.probeSessionAssets(batch),
          (done) => localActivity.update(activityId, done),
        );
        const combined = combineProbeBatches(results, ids.length);
        void client.invalidateQueries({ queryKey: ['session-assets'] });
        if (focusedId) void client.invalidateQueries({ queryKey: ['session-asset', focusedId] });
        const notice = probeNotice(combined);
        pageResults.set(SESSION_CHECK_GROUP, { label: 'AT 测活', tone: notice.tone, text: notice.summary, at: Date.now() });
        localActivity.finish(activityId, { message: checkMessage('AT 测活', notice.summary), tone: notice.tone });
        return combined;
      } catch (error) {
        void client.invalidateQueries({ queryKey: ['session-assets'] });
        if (focusedId) void client.invalidateQueries({ queryKey: ['session-asset', focusedId] });
        pageResults.set(SESSION_CHECK_GROUP, { label: 'AT 测活', tone: 'danger', text: errorMessage(error), at: Date.now() });
        localActivity.fail(activityId, errorMessage(error));
        throw error;
      }
    },
  });
  const trialCheck = useMutation({
    mutationFn: async (assetIds: string[]) => {
      const { ids } = sessionCheckBatches(assetIds);
      const activityId = localActivity.begin({ label: '优惠检测', done: 0, total: ids.length, group: SESSION_CHECK_GROUP });
      try {
        const { results } = await runSessionCheckBatches(
          assetIds,
          (batch) => endpoints.trialCheckSessionAssets(batch),
          (done) => localActivity.update(activityId, done),
        );
        const combined = combineTrialBatches(results, ids.length);
        void client.invalidateQueries({ queryKey: ['session-assets'] });
        if (focusedId) void client.invalidateQueries({ queryKey: ['session-asset', focusedId] });
        const notice = trialNotice(combined);
        pageResults.set(SESSION_CHECK_GROUP, { label: '优惠检测', tone: notice.tone, text: notice.summary, at: Date.now() });
        localActivity.finish(activityId, { message: checkMessage('优惠检测', notice.summary), tone: notice.tone });
        return combined;
      } catch (error) {
        void client.invalidateQueries({ queryKey: ['session-assets'] });
        if (focusedId) void client.invalidateQueries({ queryKey: ['session-asset', focusedId] });
        pageResults.set(SESSION_CHECK_GROUP, { label: '优惠检测', tone: 'danger', text: errorMessage(error), at: Date.now() });
        localActivity.fail(activityId, errorMessage(error));
        throw error;
      }
    },
  });
  const globalActivity = useLocalActivity();
  /**
   * What the last check found, kept on the page rather than flashed past.
   *
   * The outcome used to live only in an auto-dismissing notice and in a top-bar
   * box that read 完成 with no numbers, so a check of forty accounts announced
   * its result for a few seconds and then left nothing behind. It now stays
   * until the next check replaces it — in a module store rather than in this
   * component, because the floating notice is suppressed while this line is
   * the one stating the outcome, and component state does not survive walking
   * to another page and back.
   */
  const lastCheck = usePageResult<SessionCheckResult>(SESSION_CHECK_GROUP);
  // A check that is still in flight, even if the mutation that started it was
  // unmounted by a navigation away and back.
  const sessionCheckRunning = globalActivity?.group === SESSION_CHECK_GROUP && globalActivity.status === 'running';
  const sessionCheckBusy = probe.isPending || trialCheck.isPending || sessionCheckRunning;
  const remove = useMutation({
    mutationFn: () => endpoints.removeSessionAssets(actionIds, cascadeCpa),
    onSuccess: (result) => {
      setSelected(new Set());
      setFocusedId('');
      setNotice({
        tone: result.skipped?.length ? 'warning' : 'success',
        text: `已删除 ${result.removed.length} 个登录态资产${result.cpaRemoved ? '及其最新 CPA' : ''}${result.skipped?.length ? `，跳过 ${result.skipped.length} 个正在任务中资产` : ''}`,
      });
      client.invalidateQueries({ queryKey: ['session-assets'] });
      client.invalidateQueries({ queryKey: ['cpa-artifacts'] });
    },
    onError: (error) => setNotice({ tone: 'danger', text: errorMessage(error) }),
  });
  const classify = useMutation({
    mutationFn: (input: { assetIds: string[]; lifecycle: SaleLifecycle }) => endpoints.moveSessionAssetLifecycle(input.assetIds, input.lifecycle),
    onSuccess: (result, input) => {
      setSelected(new Set());
      setNotice({ tone: 'success', text: `已归类 ${result.changed.length} 个登录态为${LIFECYCLE_LABELS[input.lifecycle]}` });
      client.invalidateQueries({ queryKey: ['session-assets'] });
      if (focusedId) client.invalidateQueries({ queryKey: ['session-asset', focusedId] });
    },
    onError: (error) => setNotice({ tone: 'danger', text: errorMessage(error) }),
  });
  const clearOAuthCooldown = useMutation({
    mutationFn: (id: string) => endpoints.clearSessionAssetOAuthCooldown(id),
    onSuccess: (_result, id) => {
      setNotice({ tone: 'success', text: 'OAuth 冷却已解除' });
      client.invalidateQueries({ queryKey: ['session-assets'] });
      client.invalidateQueries({ queryKey: ['session-asset', id] });
    },
    onError: (error) => setNotice({ tone: 'danger', text: errorMessage(error) }),
  });
  const revealTotp = useMutation({
    mutationFn: (id: string) => endpoints.sessionAssetTotp(id),
    onSuccess: async (result) => {
      await copyText(result.code);
      setNotice({ tone: 'success', text: `当前 TOTP ${result.code} 已复制，${result.expiresIn} 秒后更新` });
    },
    onError: (error) => setNotice({ tone: 'danger', text: errorMessage(error) }),
  });
  const copy = async (label: string, value = '') => {
    if (!value) return;
    try { await copyText(value); setNotice({ tone: 'success', text: `${label} 已复制` }); } catch (error) { setNotice({ tone: 'danger', text: errorMessage(error) }); }
  };
  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const launchOAuth = () => oauth.mutate(actionIds);
  const rebindRows = useMemo(() => rows.filter((asset) => actionIds.includes(asset.id) && isIcloudAssetRow(asset)), [rows, actionIds]);
  const goRebind = () => {
    if (!rebindRows.length) return;
    setRebindPending(rebindRows);
    navigate('/rebind');
  };
  const probingIds = useMemo(() => new Set(probe.isPending ? (probe.variables || []) : []), [probe.isPending, probe.variables]);
  const trialCheckingIds = useMemo(() => new Set(trialCheck.isPending ? (trialCheck.variables || []) : []), [trialCheck.isPending, trialCheck.variables]);
  const oauthingIds = useMemo(() => new Set(oauth.isPending ? (oauth.variables || []) : []), [oauth.isPending, oauth.variables]);
  const refreshingSecurity = refresh.isPending && refresh.variables === true;
  const refreshingSession = refresh.isPending && refresh.variables !== true;
  const oauthLabel = selected.size > 1 ? `批量 OAuth (${selected.size})` : '发起 OAuth';
  const oauthAriaLabel = selected.size > 1 ? `批量 OAuth (${selected.size})` : 'OAuth 当前账号';
  // Spelled out on every destructive confirmation: at this scale a selection
  // routinely reaches past the rows on screen, and "delete 900 accounts" must
  // not be something the operator can read as "delete the ones I can see".
  const scopeNote = offViewCount ? `其中 ${offViewCount} 个不在当前视图。` : '';
  const facetGroups = useMemo(() => groupFacets(counts?.facets || {}, facets), [counts?.facets, facets]);

  return <div className="sessions-page">
    <PageHeader title="登录态资产" description="AT 快速测活统一经本机 7890；与完整登录态刷新相互独立" actions={<div className="session-page-actions">
      <Button icon={refreshingSession ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />} onClick={() => refresh.mutate(false)} disabled={!refreshReady || refresh.isPending}>{refreshingSession ? '启动中' : `登录态刷新${actionIds.length ? ` (${actionIds.length})` : ''}`}</Button>
      <Button title={securityRecoveryNeeded ? '补全未配置的密码与 TOTP' : '所选账号的密码与 TOTP 已配置'} icon={refreshingSecurity ? <LoaderCircle className="spin" size={16} /> : <ShieldCheck size={16} />} onClick={() => refresh.mutate(true)} disabled={!refreshReady || !securityRecoveryNeeded || refresh.isPending}>{refreshingSecurity ? '启动中' : `OTP/PW 恢复${actionIds.length > 1 ? ` (${actionIds.length})` : ''}`}</Button>
      <Button tone="primary" aria-label={oauthAriaLabel} icon={oauth.isPending ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />} onClick={launchOAuth} disabled={!oauthReady || oauth.isPending}>{oauth.isPending ? '启动中' : oauthLabel}</Button>
    </div>} />
    {(sessionCheckRunning || lastCheck) && <div className={`session-check-result session-check-result-${sessionCheckRunning ? 'running' : (lastCheck?.tone || 'success')}`} role="status">
      {sessionCheckRunning
        ? <>
          <LoaderCircle className="spin" size={14} aria-hidden="true" />
          <strong>{globalActivity?.label}</strong>
          <span className="session-check-result-progress">{globalActivity?.done}/{globalActivity?.total}</span>
          <span className="session-check-result-track"><span style={{ width: `${Math.max(3, Math.round(((globalActivity?.done || 0) / Math.max(1, globalActivity?.total || 1)) * 100))}%` }} /></span>
        </>
        : <>
          {lastCheck?.tone === 'danger' ? <CircleAlert size={14} aria-hidden="true" /> : <Check size={14} aria-hidden="true" />}
          <strong>{lastCheck?.label}</strong>
          <span className="session-check-result-text" title={lastCheck?.text}>{lastCheck?.text}</span>
          <time dateTime={new Date(lastCheck?.at || 0).toISOString()}>{formatTime(new Date(lastCheck?.at || 0).toISOString())}</time>
          <IconButton label="清除上次检测结果" onClick={() => pageResults.clear(SESSION_CHECK_GROUP)}><X size={13} /></IconButton>
        </>}
    </div>}
    {notice && <Notice tone={notice.tone} floating onClose={() => setNotice(null)} autoDismissToken={notice}>{notice.text}</Notice>}
    <div className="sessions-workspace">
      <section className="session-list-panel">
        <div className="session-toolbar">
          <input className="session-search" aria-label="搜索登录态资产" placeholder="搜索邮箱、Account ID、任务" value={searchDraft} onChange={(event) => setSearchDraft(event.target.value)} />
          <AppSelect className="session-filter-select session-lifecycle-filter" ariaLabel="库存状态筛选" value={lifecycle} onValueChange={(value) => patch({ lifecycle: value as StoredFilters['lifecycle'] })} options={[
            { value: 'all', label: `全部库存 · ${sumCounts(counts?.lifecycle)}` },
            ...LIFECYCLE_ORDER.map((value) => ({ value, label: `${LIFECYCLE_LABELS[value]} · ${counts?.lifecycle?.[value as SessionAssetLifecycle] || 0}` })),
          ]} />
          <AppSelect className="session-filter-select session-queue-filter" ariaLabel="账号队列筛选" value={queue} onValueChange={(value) => patch({ queue: value as StoredFilters['queue'] })} options={[
            { value: 'all', label: `全部待办 · ${sumCounts(counts?.queue)}` },
            ...QUEUE_ORDER.map((value) => ({ value, label: `${QUEUE_LABELS[value]} · ${counts?.queue?.[value as SessionAssetNextAction] || 0}` })),
          ]} />
          <AppSelect className="session-filter-select session-source-filter" ariaLabel="来源任务筛选" value={sourceRun} onValueChange={(value) => patch({ sourceRun: value })} options={[{ value: 'all', label: '全部来源任务' }, ...sourceRuns.map((runId) => ({ value: runId, label: runId }))]} />
          <label className="session-concurrency"><span>刷新并发</span><ConfigNumberInput min={1} max={MAX_WORKER_CONCURRENCY} title="实际并发不超过本次所选账号数" value={refreshConcurrency} onValueChange={setRefreshConcurrency} /></label>
        </div>
        <div className="session-facetbar" role="group" aria-label="属性筛选">
          {facetGroups.map((group) => <div className="session-facet-group" key={group.key}>
            <span className="session-facet-legend">{group.label}</span>
            <div className="session-facet-options">
              {group.items.map((item) => <button
                key={item.facet}
                type="button"
                className={`session-facet-chip${facets.includes(item.facet) ? ' on' : ''}`}
                aria-pressed={facets.includes(item.facet)}
                disabled={item.count === 0 && !facets.includes(item.facet)}
                onClick={() => toggleFacet(item.facet)}
              >{item.label}<b>{item.count}</b></button>)}
            </div>
          </div>)}
          {facets.length > 0 && <button type="button" className="session-facet-clear" onClick={() => patch({ facets: [] })}>清除 {facets.length} 项属性</button>}
        </div>
        <div className="session-batchbar">
          <div className="session-batch-selection">
            <label><input type="checkbox" aria-label={`全选匹配 ${total}`} checked={allMatchedSelected} disabled={selectAllMatched.isPending || !total} onChange={() => (allMatchedSelected ? setSelected(new Set()) : selectAllMatched.mutate())} />全选匹配 {total}</label>
            <span className="session-batch-hint">{selected.size ? `已选 ${selected.size}${offViewCount ? `（${offViewCount} 个不在当前视图）` : ''}` : '长按任意行并拖动可连续多选'}</span>
            {offViewCount > 0 && <button
              type="button"
              className="session-batch-trim"
              title={`移除 ${offViewCount} 个当前视图外的已选资产`}
              aria-label={`仅保留当前视图内的资产，移除 ${offViewCount} 个视图外选中项`}
              onClick={() => setSelected(new Set([...selected].filter((id) => visibleIds.has(id))))}
            ><FilterX size={14} aria-hidden="true" /><span>仅保留视图内</span><b>{offViewCount}</b></button>}
          </div>
          <div className="session-batch-actions-scroll">
          <div className="session-batch-actions">
          <Button tone="quiet" title="将选中的 iCloud 账号带入换绑页面" icon={<Repeat size={15} />} onClick={goRebind} disabled={!rebindRows.length}><span>{rebindRows.length ? `加入换绑 (${rebindRows.length})` : '加入换绑'}</span></Button>
          <Button tone="quiet" icon={probe.isPending ? <LoaderCircle className="spin" size={15} /> : <Activity size={15} />} onClick={() => probe.mutate(actionIds)} disabled={!actionIds.length || sessionCheckBusy}><span>{selected.size ? `批量 AT 测活 (${selected.size})` : 'AT 测活'}</span></Button>
          <Button tone="quiet" title="重新拉取 ChatGPT 优惠资格并刷新试用标签" icon={trialCheck.isPending ? <LoaderCircle className="spin" size={15} /> : <Gift size={15} />} onClick={() => trialCheck.mutate(actionIds)} disabled={!actionIds.length || sessionCheckBusy}><span>{selected.size ? `批量优惠检测 (${selected.size})` : '优惠检测'}</span></Button>
          <IconButton label="导出原始 AT" onClick={() => exportAssets.mutate({ kind: 'at', format: 'raw' })} disabled={!actionIds.length || exportAssets.isPending}><Download size={16} /></IconButton>
          <Button tone="quiet" icon={<Download size={15} />} onClick={() => exportAssets.mutate({ kind: 'at', format: 'email-at' })} disabled={!actionIds.length || exportAssets.isPending}><span>邮箱 + AT</span></Button>
          <Button tone="quiet" icon={<KeyRound size={15} />} onClick={() => exportAssets.mutate({ kind: 'credentials' })} disabled={!actionIds.length || exportAssets.isPending}><span>密码 + TOTP</span></Button>
          <div className="session-classification-action">
            <ConfirmDialog trigger={<Button tone="quiet" icon={<Tag size={15} />} disabled={!actionIds.length || classify.isPending}><span>{SALE_LIFECYCLE_ACTION_LABELS[saleLifecycle]}</span></Button>} title={`归类为${LIFECYCLE_LABELS[saleLifecycle]}`} description={`将 ${actionIds.length} 个选中的登录态移到“${LIFECYCLE_LABELS[saleLifecycle]}”。${scopeNote}计划卖出的账号选择“已卖出”时会直接升级，不会删除会话或 CPA。${saleLifecycle === 'self_use' ? '自用账号仍会照常参与刷新、提链与优惠检测。' : ''}`} confirmLabel="确认归类" onConfirm={() => classify.mutate({ assetIds: actionIds, lifecycle: saleLifecycle })} />
            <AppSelect className="session-classification-select" ariaLabel="归类动作" minMenuWidth={128} menuAlign="end" value={saleLifecycle} onValueChange={(value) => setSaleLifecycle(value as SaleLifecycle)} options={SALE_LIFECYCLE_OPTIONS} disabled={!actionIds.length || classify.isPending} />
          </div>
          <ConfirmDialog trigger={<IconButton label="删除选中登录态" disabled={!actionIds.length || remove.isPending}><Trash2 size={16} /></IconButton>} title="删除登录态资产" description={`将删除 ${actionIds.length} 个会话、AT 与可选安全凭据。${scopeNote}`} danger confirmLabel="确认删除" onConfirm={() => remove.mutate()}><label className="delete-option"><input type="checkbox" checked={cascadeCpa} onChange={(event) => setCascadeCpa(event.target.checked)} />同时删除这些资产的最新 CPA</label></ConfirmDialog>
          </div>
          </div>
        </div>
        <div className={`session-list-scroll${rangeSelection.dragging ? ' session-range-selecting' : ''}`} {...rangeSelection.containerProps}>
          <div className="session-list-head"><span /><span>账号</span><span>套餐</span><span>试用</span><span>待办</span><span>OAuth</span><span>AT</span><span>更新时间</span><span>操作</span></div>
          {rows.length ? <div className="session-list-body" style={{ height: listVirtual.getTotalSize() }}>{renderRows.map((virtualRow) => {
            const index = virtualRow.index;
            const asset = rows[index];
            const health = displayedHealth(asset);
            const picked = selected.has(asset.id);
            const inRange = rangeSelection.isInRange(index);
            const pool = salePoolOf(asset);
            return <div ref={listVirtual.measureElement} data-index={virtualRow.index} role="button" tabIndex={0} style={{ transform: `translateY(${virtualRow.start}px)` }} className={`session-list-row${focusedId === asset.id ? ' focused' : ''}${picked ? ' session-row-selected' : ''}${inRange ? ' session-row-range' : ''}`} data-selected={picked} key={asset.id} {...rangeSelection.rowProps(index)} onClick={() => setFocusedId(asset.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') setFocusedId(asset.id); }}>
            <span onClick={(event) => event.stopPropagation()}><input aria-label={`选择 ${asset.email}`} type="checkbox" checked={picked} onChange={() => toggle(asset.id)} /></span>
            <span className="session-account"><span className="session-email-line"><strong className={isLatestTaskAsset(asset, latestAssetRunId) ? 'session-email-latest' : undefined}>{asset.email}</strong><span className="session-account-tags">{pool && <SessionLifecycleTag lifecycle={pool} />}<OAuthCooldownTag cooldown={asset.oauthCooldown} onClear={() => clearOAuthCooldown.mutate(asset.id)} clearing={clearOAuthCooldown.isPending && clearOAuthCooldown.variables === asset.id} /></span></span><small>{asset.accountId || asset.id}</small><small className="session-row-meta">{securityRecoveryLabel(asset)}{sourceExitLabel(asset) && <em className="session-source-exit" title={sourceExitTitle(asset)}>{sourceExitLabel(asset)}</em>}{sourceExitLabel(asset, 'rebindProxy') && <em className="session-source-exit" title={sourceExitTitle(asset, 'rebindProxy')}>换绑 {sourceExitLabel(asset, 'rebindProxy')}</em>}</small></span>
            <span className={planBadgeClass(displayPlanType(asset))}>{displayPlanType(asset)}</span>
            <TrialBadge trial={asset.trial} />
            <NextActionBadge asset={asset} />
            <StatusBadge status={oauthSucceeded(asset) ? 'complete' : 'unknown'} label={oauthSucceeded(asset) ? '已成功' : '未 OAuth'} />
            <StatusBadge status={health?.status || 'unknown'} label={healthLabel(health)} />
            <time title={`AT 测活于 ${formatTime(health?.checkedAt)}`}>{formatTime(asset.updatedAt)}</time>
            <span className="session-row-action" onClick={(event) => event.stopPropagation()}><IconButton label={`AT 测活 ${asset.email}`} onClick={() => probe.mutate([asset.id])} disabled={sessionCheckBusy}>{probingIds.has(asset.id) ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}</IconButton><IconButton label={`优惠检测 ${asset.email}`} onClick={() => trialCheck.mutate([asset.id])} disabled={sessionCheckBusy}>{trialCheckingIds.has(asset.id) ? <LoaderCircle className="spin" size={15} /> : <Gift size={15} />}</IconButton><IconButton label={asset.oauthCooldown?.active ? `OAuth 冷却中 ${asset.email}` : `OAuth ${asset.email}`} onClick={() => oauth.mutate([asset.id])} disabled={oauth.isPending || asset.oauthCooldown?.active === true}>{oauthingIds.has(asset.id) ? <LoaderCircle className="spin" size={15} /> : <KeyRound size={15} />}</IconButton></span>
          </div>;
           })}</div> : <EmptyState icon={<KeyRound size={25} />} title={page.isLoading ? '读取登录态' : '没有匹配的登录态'} detail={page.isLoading ? '正在按当前筛选取回。' : '放宽库存、待办或属性筛选，或清除搜索。'} />}
        </div>
        {(moreCursor || pollInterval === false) && <div className="session-list-more">
          {moreCursor && <Button tone="quiet" onClick={() => setLimit((current) => current + PAGE_SIZE)} disabled={page.isFetching}>{page.isFetching ? '载入中' : `载入更多（已显示 ${rows.length} / ${total}）`}</Button>}
          {/* Saying so, because a page that silently stopped updating is worse
              than one that never claimed to. */}
          {pollInterval === false && <button type="button" className="session-list-refresh" onClick={() => page.refetch()} disabled={page.isFetching}>{page.isFetching ? '刷新中' : `已暂停自动刷新（${rows.length} 行）· 手动刷新`}</button>}
        </div>}
      </section>
      <aside className="session-inspector">
        {detail.isLoading ? <div className="loading-line"><LoaderCircle className="spin" />读取登录态详情</div> : detail.data ? <SessionAssetInspector asset={detail.data} latestRunId={latestAssetRunId} onCopy={copy} onTotp={() => revealTotp.mutate(detail.data!.id)} onProbe={() => probe.mutate([detail.data!.id])} onTrialCheck={() => trialCheck.mutate([detail.data!.id])} onOAuth={() => oauth.mutate([detail.data!.id])} onClearOAuthCooldown={() => clearOAuthCooldown.mutate(detail.data!.id)} clearingOAuthCooldown={clearOAuthCooldown.isPending && clearOAuthCooldown.variables === detail.data.id} probing={probingIds.has(detail.data.id)} trialChecking={trialCheckingIds.has(detail.data.id)} checkBusy={sessionCheckBusy} oauthing={oauthingIds.has(detail.data.id)} /> : <EmptyState icon={<UserRoundCheck size={25} />} title="选择一个登录态" detail="右侧会显示完整会话与可执行操作。" />}
      </aside>
    </div>
  </div>;
}

function SecretValue({ label, value, onCopy }: { label: string; value?: string; onCopy: (label: string, value?: string) => void }) {
  return <div className="session-secret"><div><span>{label}</span><code>{value || '未配置'}</code></div><IconButton label={`复制${label}`} onClick={() => onCopy(label, value)} disabled={!value}><Copy size={15} /></IconButton></div>;
}

function SessionAssetInspector({ asset, latestRunId, onCopy, onTotp, onProbe, onTrialCheck, onOAuth, onClearOAuthCooldown, clearingOAuthCooldown, probing, trialChecking, checkBusy, oauthing }: { asset: SessionAsset; latestRunId: string; onCopy: (label: string, value?: string) => void; onTotp: () => void; onProbe: () => void; onTrialCheck: () => void; onOAuth: () => void; onClearOAuthCooldown: () => void; clearingOAuthCooldown: boolean; probing: boolean; trialChecking: boolean; checkBusy: boolean; oauthing: boolean }) {
  const health = displayedHealth(asset);
  const inventoryClassification = salePoolOf(asset);
  return <div className="session-inspector-content">
    <div className="session-inspector-head"><div className="session-inspector-status-row"><span className={planBadgeClass(displayPlanType(asset))}>{displayPlanType(asset)}</span><TrialBadge trial={asset.trial} /><StatusBadge status={asset.status} />{inventoryClassification && <SessionLifecycleTag lifecycle={inventoryClassification} />}<StatusBadge status={oauthSucceeded(asset) ? 'complete' : 'unknown'} label={oauthSucceeded(asset) ? 'OAuth 已成功' : '未 OAuth'} /><OAuthCooldownTag cooldown={asset.oauthCooldown} onClear={onClearOAuthCooldown} clearing={clearingOAuthCooldown} /><span className="session-inspector-probe"><IconButton label="AT 测活" onClick={onProbe} disabled={checkBusy}>{probing ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}</IconButton><IconButton label="重新检测优惠" onClick={onTrialCheck} disabled={checkBusy}>{trialChecking ? <LoaderCircle className="spin" size={15} /> : <Gift size={15} />}</IconButton><IconButton label={asset.oauthCooldown?.active ? 'OAuth 冷却中' : '发起 OAuth'} onClick={onOAuth} disabled={oauthing || asset.oauthCooldown?.active === true}>{oauthing ? <LoaderCircle className="spin" size={15} /> : <KeyRound size={15} />}</IconButton></span></div><div className="session-inspector-email-line"><h2 className={isLatestTaskAsset(asset, latestRunId) ? 'session-email-latest' : undefined}>{asset.email}</h2><IconButton label="复制邮箱" onClick={() => onCopy('邮箱', asset.email)} disabled={!asset.email}><Copy size={15} /></IconButton></div><p>{asset.accountId || asset.id}</p></div>
    <div className="session-facts"><div><span>AT 状态</span><strong>{healthLabel(health)}</strong></div><div><span>测活时间</span><strong>{formatTime(health?.checkedAt)}</strong></div><div><span>最近验证</span><strong>{formatTime(asset.lastValidatedAt)}</strong></div><div><span>AT 到期</span><strong>{formatTime(asset.accessTokenExpiresAt)}</strong></div><div><span>安全设置</span><strong>{securityRecoveryLabel(asset)}</strong></div><div><span>试用资格</span><strong>{trialLabel(asset.trial)}</strong></div><div><span>优惠检测</span><strong>{formatTime(asset.trial?.checkedAt)}</strong></div><div><span>注册出口</span><strong title={sourceExitTitle(asset)}>{sourceExitLabel(asset) || '—'}</strong></div><div><span>换绑国家 / IP</span><strong title={sourceExitTitle(asset, 'rebindProxy')}>{sourceExitLabel(asset, 'rebindProxy') || '—'}</strong></div><div><span>来源</span><strong>{asset.sourceKind || '—'}</strong></div><div><span>OAuth / CPA</span><strong>{oauthSucceeded(asset) ? `已成功 ${asset.oauth?.successCount || asset.cpa?.revision || 1} 次${asset.cpa ? ` · rev ${asset.cpa.revision}` : ''}` : '未 OAuth'}</strong></div></div>
    {health && <div className={`session-health-detail health-${health.status}`}><StatusBadge status={health.status} label={healthLabel(health)} /><div><strong>{health.code}</strong><small>{health.message}{health.latencyMs > 0 ? ` · ${health.latencyMs} ms` : ''}</small></div></div>}
    <div className={`session-trial-detail trial-${trialTone(asset.trial)}`}><TrialBadge trial={asset.trial} /><div><strong>{asset.trial?.code || 'TRIAL_NOT_CHECKED'}</strong><small>{asset.trial ? `${asset.trial.message}${asset.trial.latencyMs > 0 ? ` · ${asset.trial.latencyMs} ms` : ''}` : '登录态创建后会自动检测一次，也可以随时手动重检'}</small>{campaignSummary(asset.trial) && <small className="session-trial-campaigns">{campaignSummary(asset.trial)}</small>}</div></div>
    <section><div className="section-heading"><div><h2>登录凭据</h2><p>完整值仅由本机详情接口读取</p></div></div>
      <SecretValue label="Access Token" value={asset.accessToken} onCopy={onCopy} />
      <SecretValue label="Session Token" value={asset.sessionToken} onCopy={onCopy} />
      <SecretValue label="密码" value={asset.password} onCopy={onCopy} />
      <SecretValue label="TOTP Secret" value={asset.totpSecret} onCopy={onCopy} />
      {asset.totpSecret && <Button tone="quiet" icon={<Clock3 size={15} />} onClick={onTotp}>复制当前 TOTP</Button>}
    </section>
    <section><div className="section-heading"><div><h2>会话身份</h2><p>跨任务保持 Firefox 画像和设备标识</p></div></div><dl className="session-identity-list"><div><dt>Asset ID</dt><dd>{asset.id}</dd></div><div><dt>oai-did</dt><dd>{asset.oaiDid || '—'}</dd></div><div><dt>根邮箱</dt><dd>{asset.parentEmail || '—'}</dd></div><div><dt>来源任务</dt><dd>{asset.sourceRunId || '—'}</dd></div></dl></section>
    {asset.lastError && <Notice tone="warning">{asset.lastError.code}：{asset.lastError.message}</Notice>}
  </div>;
}
