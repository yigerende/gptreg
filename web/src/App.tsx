import { Pagination, type PageInfo } from './components/Pagination';
import { OAuthProxyDialog } from './OAuthProxyDialog';
import { SmsSettingsDialog } from './SmsSettingsDialog';
import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  Activity,
  AlertTriangle,
  Archive,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsDown,
  CircleDollarSign,
  CirclePause,
  CirclePlay,
  Clock3,
  Copy,
  Download,
  Eraser,
  FileJson,
  FileOutput,
  FolderArchive,
  FolderDown,
  Gauge,
  History,
  KeyRound,
  LayoutDashboard,
  Link2,
  ListChecks,
  ListRestart,
  Lock,
  LoaderCircle,
  Menu,
  Moon,
  Network,
  Radio,
  RefreshCw,
  Save,
  ScrollText,
  Settings2,
  ShieldAlert,
  ShieldCheck,
  SkipForward,
  Square,
  Sun,
  Tag,
  Trash2,
  Unlock,
  Upload,
  UserRoundCheck,
  Wifi,
  WifiOff,
  X,
  Repeat,
} from 'lucide-react';
import { Dialog, Switch, Tabs } from 'radix-ui';
import { DismissableLayer } from 'radix-ui/internal';

import { endpoints } from './api';
import {
  TASK_SLOT_LABELS,
  TASK_SLOT_PURPOSE,
  isAuxiliaryRun,
  isTerminalRunStatus,
  jobResultLabel,
  phaseLabel,
  runStatusLabel,
  runTaskDescription,
  runTaskSlot,
  runTaskSlotLabel,
  taskKindLabel,
  taskKindPurpose,
} from './task-labels';
import { AppSelect } from './components/AppSelect';
import {
  Button,
  ConfigNumberInput,
  ConfirmDialog,
  EmptyState,
  IconButton,
  IconLink,
  Notice,
  PageHeader,
  StatusBadge,
  copyText,
  errorMessage,
  formatTime,
  statusTone,
} from './components/ConsoleUi';
import { useRangeSelection } from './components/useRangeSelection';
import { isSkippableJobStatus, isTerminalJobStatus } from './job-lifecycle';
import { MAX_WORKER_CONCURRENCY, balancedPoolAssignments, countryPoolAssignments, defaultProxyAssignments, proxyAssignmentsAreReady, resizeProxyAssignments } from './run-plan-ui';
import { exportFileName } from './export-file-name';
import { detectCredentialSourceMode, maskSecret, parseCredentialInput, parseEmailInput, totpCode, totpRemaining, type CredentialEntry, type CredentialRejection, type EmailEntry } from './credential-input';
import { Link, NavLink, useNavigate, useParams, useRouter } from './router';
import { ChainsPage } from './ChainsPage';
import { CPA_PUSH_GROUP, SESSION_CHECK_GROUP, localActivity, pageResults, useLocalActivity, usePageResult } from './local-activity';
import { RobotsPage, durationLabel } from './RobotsPage';
import { SessionAssetsPage } from './SessionAssetsPage';
import { RebindPage } from './RebindPage';
import { SmsbowerMailConfig } from './SmsbowerMailConfig';
import type { OAuthSkippedCounts, BalanceReconciliation, CpaArtifact, CpaArtifactSelectionItem, CpaCredentialPreflight, CpaExportSelection, JobSummary, LogRecord, MailRentalConfigureBody, MailcomAliasDomains, MailcomImportProgress, NvtokensPushResult, PreflightSnapshot, ProxyAssignment, ProxyCatalogSnapshot, ProxyRecord, RegistrationOutcomeCounts, RegistrationSkippedCounts, RobotRun, RunListSnapshot, RunPlan, RunSummary, ServiceStatus, SessionAssetResolveMatch, TaskCapacitySnapshot, TaskSlotCapacity, SettableSessionAssetLifecycle, Sub2ApiFailedAccounts } from './types';

const navItems = [
  { to: '/', label: '启动工作台', icon: LayoutDashboard },
  { to: '/run', label: '当前任务', icon: Activity },
  { to: '/sessions', label: '登录态', icon: KeyRound },
  { to: '/rebind', label: '换绑', icon: Repeat },
  { to: '/robots', label: '机器人', icon: Bot },
  { to: '/chains', label: '提链', icon: Link2 },
  { to: '/proxies', label: '代理', icon: Network },
  { to: '/history', label: '历史与产物', icon: History },
];

const ISO_PROXY_COUNTRIES = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' ');
const regionNames = typeof Intl.DisplayNames === 'function' ? new Intl.DisplayNames(['zh-CN'], { type: 'region' }) : null;
const proxyCountryLabel = (code: string) => code === 'GLOBAL' ? '全球 · GLOBAL' : `${regionNames?.of(code) || code} · ${code}`;
/** Picker token for CPA rows whose login state recorded no exit country. */
const UNKNOWN_REGISTRATION_COUNTRY = '?';
const registrationCountryLabel = (code: string) => code === UNKNOWN_REGISTRATION_COUNTRY ? '未知注册国' : proxyCountryLabel(code);
/** The registration country as it appears in an export file name: `US`, or `未知注册国`. */
const registrationCountryFileTag = (code: string) => code === UNKNOWN_REGISTRATION_COUNTRY ? '未知注册国' : code;
const PROXY_COUNTRY_OPTIONS = ['GLOBAL', ...ISO_PROXY_COUNTRIES].map((code) => ({ code, label: proxyCountryLabel(code) }));
const PROXY_COUNTRY_SELECT_OPTIONS = PROXY_COUNTRY_OPTIONS.map((country) => ({ value: country.code, label: country.label }));
const PROXY_API_PROVIDER_OPTIONS = [
  { value: '711proxy', label: '711Proxy' },
  { value: 'b2proxy', label: 'B2Proxy' },
  { value: '1024proxy', label: '1024 Proxy' },
  { value: 'cliproxy', label: 'CLI Proxy' },
];
const DEFAULT_PROXY_API_COUNT = 600;
const PROXY_API_PROVIDER_META: Record<string, { label: string; sessionMinutes: number; regionalOnly: boolean; defaultProtocol: 'http' | 'socks5'; defaultCount?: number; maxCount?: number }> = {
  '711proxy': { label: '711Proxy', sessionMinutes: 180, regionalOnly: false, defaultProtocol: 'http', defaultCount: DEFAULT_PROXY_API_COUNT, maxCount: 900 },
  b2proxy: { label: 'B2Proxy', sessionMinutes: 60, regionalOnly: true, defaultProtocol: 'socks5', defaultCount: DEFAULT_PROXY_API_COUNT, maxCount: 900 },
  '1024proxy': { label: '1024 Proxy', sessionMinutes: 120, regionalOnly: true, defaultProtocol: 'socks5', defaultCount: DEFAULT_PROXY_API_COUNT },
  cliproxy: { label: 'CLI Proxy', sessionMinutes: 15, regionalOnly: true, defaultProtocol: 'http', defaultCount: DEFAULT_PROXY_API_COUNT },
};

function formatUsd(value: unknown, minimumFractionDigits = 2) {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  return `$${number.toLocaleString('en-US', { minimumFractionDigits, maximumFractionDigits: 3 })}`;
}

function formatCurrency(value: unknown, currency = 'USD', minimumFractionDigits = 2) {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  if (!Number.isFinite(number)) return '—';
  const code = String(currency || 'USD').toUpperCase();
  const formatted = number.toLocaleString('en-US', { minimumFractionDigits, maximumFractionDigits: 3 });
  if (code === 'USD') return `$${formatted}`;
  if (code === 'CNY' || code === 'RMB') return `¥${formatted}`;
  return `${formatted} ${code}`;
}

function smsCurrency(provider: string, currency?: string) {
  return String(currency || (String(provider).toLowerCase() === 'firefox' ? 'CNY' : 'USD')).toUpperCase();
}

function formatBytes(value: unknown) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 ** 2)).toFixed(1)} MB`;
}

const MONEY_TOLERANCE = 0.000001;
const AUXILIARY_TASK_CAPACITY = 3;
const MAX_MAIL_RENTAL_TARGET = 1000;
const MIN_MAIL_RENTAL_POLL_INTERVAL_SECONDS = 1;
const RUNS_POLL_ACTIVE_MS = 2_500;
const RUNS_POLL_IDLE_MS = 10_000;

type RunsQueryState = {
  data: RunListSnapshot | undefined;
  isLoading: boolean;
  isError: boolean;
};

const RunsQueryContext = createContext<RunsQueryState | null>(null);

function useRunsQuery() {
  const query = useContext(RunsQueryContext);
  if (!query) throw new Error('useRunsQuery must be used inside AppLayout');
  return query;
}

function isOnlyCancelledQuote(unresolved: unknown, cancelledUnresolved: unknown) {
  const pending = Number(unresolved || 0);
  const cancelled = Number(cancelledUnresolved || 0);
  return cancelled > MONEY_TOLERANCE
    && pending > MONEY_TOLERANCE
    && Math.abs(pending - cancelled) <= MONEY_TOLERANCE;
}

/**
 * Confirmed SMS consumption, including whatever of it was wasted.
 *
 * Waste is money that was spent, so it belongs in the total; the cost tile
 * names how much of the total it was rather than quietly subtracting it.
 */
function formatRunSmsCost(costs: RunSummary['costs'], billing?: RunSummary['billing']) {
  if (!costs) return '—';
  const buckets = Object.entries(billing?.currencyTotals || {});
  if (buckets.length) {
    const rendered = buckets.map(([currency, bucket]) => {
      const confirmed = Math.max(0, Number(bucket?.confirmedConsumed || 0));
      const unresolved = Number(bucket?.unresolved || 0);
      const cancelledUnresolved = Number(bucket?.cancelledUnresolved || 0);
      if (unresolved > 0) {
        if (isOnlyCancelledQuote(unresolved, cancelledUnresolved)) {
          return confirmed > 0
            ? `${formatCurrency(confirmed, currency)} 已确认`
            : `${formatCurrency(unresolved, currency)} 取消报价待结算`;
        }
        return confirmed > 0
          ? `${formatCurrency(confirmed, currency)} 已确认`
          : `${formatCurrency(unresolved, currency)} 待核对`;
      }
      return confirmed > 0 ? formatCurrency(confirmed, currency) : '';
    }).filter(Boolean);
    if (rendered.length) return rendered.join(' + ');
    if (Number(billing?.unresolvedJobs || 0) > 0) return '待核对';
  }
  const currency = billing?.currency || costs.currency || 'USD';
  const confirmed = Math.max(0, Number(billing?.confirmedConsumedUsd ?? costs.sms ?? 0));
  const unresolved = Number(billing?.unresolvedUsd ?? 0);
  const cancelledUnresolved = Number(billing?.cancelledUnresolvedUsd ?? 0);
  if (!confirmed && !unresolved && Number(billing?.cancelledQuotesSettledUsd || 0) > MONEY_TOLERANCE) return '—';
  if (!confirmed && !unresolved && Number(billing?.unresolvedJobs || 0) > 0) return '待核对';
  if (!confirmed && !unresolved && !billing?.quotedUsd) return '—';
  if (unresolved > 0) {
    if (isOnlyCancelledQuote(unresolved, cancelledUnresolved)) {
      return confirmed > 0
        ? `${formatCurrency(confirmed, currency)} 已确认`
        : `${formatCurrency(unresolved, currency)} 取消报价待结算`;
    }
    return confirmed > 0 ? `${formatCurrency(confirmed, currency)} 已确认` : `${formatCurrency(unresolved, currency)} 待核对`;
  }
  return formatCurrency(confirmed, currency);
}

function formatJobSmsCost(job: JobSummary) {
  const currency = job.smsCurrency || 'USD';
  const confirmed = Number(job.smsCostUsd || 0);
  const unresolved = Number(job.smsUnresolvedUsd || 0);
  const cancelledUnresolved = Number(job.smsCancelledUnresolvedUsd || 0);
  const excluded = Number(job.smsCancelledQuoteExcludedUsd || 0);
  if (!confirmed && !unresolved && excluded > MONEY_TOLERANCE) return `${formatCurrency(excluded, currency)} 取消报价已排除`;
  if (!confirmed && !unresolved && ['pending', 'needs_review'].includes(job.smsCostStatus || '')) return '待核对';
  if (!confirmed && !unresolved) return '—';
  if (unresolved > 0 && isOnlyCancelledQuote(unresolved, cancelledUnresolved)) {
    return confirmed > 0
      ? `${formatCurrency(confirmed, currency)} 已确认`
      : `${formatCurrency(unresolved, currency)} 待供应商结算`;
  }
  if (unresolved > 0) return confirmed > 0 ? `${formatCurrency(confirmed, currency)} 已确认` : `${formatCurrency(unresolved, currency)} 待核对`;
  return `${formatCurrency(confirmed, currency)} 已确认`;
}

function cancellationBillingMessages(run: RunSummary) {
  const billing = run.billing;
  if (!billing) return [];
  const currency = billing.currency || run.costs?.currency || 'USD';
  const unresolved = Number(billing.unresolvedUsd || 0);
  const cancelledUnresolved = Number(billing.cancelledUnresolvedUsd || 0);
  const settled = Number(
    run.balanceReconciliation?.cancelledQuotesSettledByBalance
      ?? billing.cancelledQuotesSettledUsd
      ?? 0,
  );
  const messages: string[] = [];
  if (settled > MONEY_TOLERANCE) {
    messages.push(`${formatCurrency(settled, currency)} 已排除取消号码报价，不计入确认消费`);
  }
  if (cancelledUnresolved > MONEY_TOLERANCE) {
    messages.push(`${formatCurrency(cancelledUnresolved, currency)} 为已取消号码报价，等待供应商结算，不等于已确认损失`);
  }
  const otherUnresolved = Math.max(0, unresolved - cancelledUnresolved);
  if (otherUnresolved > MONEY_TOLERANCE) {
    messages.push(`${formatCurrency(otherUnresolved, currency)} 仍待核对`);
  }
  return messages;
}

/**
 * The one billing state worth interrupting the count line for.
 *
 * The hint under 任务总金额 used to be a running commentary on the ledger —
 * 总报价 $1.24，仅展示确认消费, 已核对 37 个任务 — none of which an operator
 * acts on. What they do act on is money that is still moving: a cancelled
 * number the supplier has not settled, or a charge with no result at all.
 */
function smsBillingException(run: RunSummary) {
  const cancellationMessages = cancellationBillingMessages(run);
  if (cancellationMessages.length) return cancellationMessages.join('；');
  const billing = run.billing;
  if (billing?.unresolvedJobs) {
    return billing.unresolvedUsd > 0
      ? `${formatCurrency(billing.unresolvedUsd, billing.currency || 'USD')} 待平台账单核对`
      : `${billing.unresolvedJobs} 个号码缺少计费结果`;
  }
  return '';
}

/**
 * What a wasted charge is called, rather than the code the ledger keys it by.
 *
 * A closed set, produced by the SMS cost ledger and by rental settlement. An
 * operator reading a cost tile should not have to translate
 * `PHONE_RECENTLY_USED` in their head; the raw code stays in the tooltip,
 * which is what searching a log for it needs.
 */
const WASTE_CODE_LABELS: Record<string, string> = {
  PHONE_RECENTLY_USED: '号码已被占用',
  PHONE_REJECTED: '号码被拒收',
  SMS_CODE_TIMEOUT: '等不到验证码',
  SMS_LATE_CODE: '验证码迟到未用',
  INVALID_INPUT: '验证码被拒',
  PROXY_RESTART: '换代理重来',
  PHONE_REPLACED: '号码作废重取',
  PHONE_UNUSED: '号码没用上',
  SETTLED_RENTAL: '邮箱已结算',
  UNRESOLVED_RENTAL: '邮箱已用掉·扣费待确认',
  UNKNOWN: '未归类',
};

/** Wasted SMS consumption, in the currency each charge was actually made in. */
function smsWasteAmounts(run: RunSummary) {
  const buckets = Object.entries(run.billing?.currencyTotals || {});
  if (buckets.length) {
    return buckets.map(([currency, bucket]) => {
      const wasted = bucket?.wastedConsumed === undefined
        ? (String(currency).toUpperCase() === 'USD' ? Number(run.costs?.wastedSms || 0) : 0)
        : Number(bucket.wastedConsumed || 0);
      return wasted > MONEY_TOLERANCE ? formatCurrency(wasted, currency, 3) : '';
    }).filter(Boolean);
  }
  const wasted = Math.max(0, Number(run.costs?.wastedSms || 0));
  return wasted > MONEY_TOLERANCE ? [formatCurrency(wasted, run.costs?.currency || 'USD', 3)] : [];
}

/**
 * What a run spent, and how much of that bought nothing.
 *
 * These two were three separate readings of the same ledger: a tile showing
 * ordinary spend with the waste stacked underneath as a red `+`, a second tile
 * listing the waste reasons as raw codes, and a tooltip repeating the amount a
 * third time. One summary now answers all of it, and one tile renders it.
 *
 * The headline is the whole confirmed amount, waste included — it is money
 * that left the account — and the waste line says how much of it was wasted
 * and why.
 */
function runCostSummary(run: RunSummary) {
  const sms = formatRunSmsCost(run.costs, run.billing);
  const mailRentals = Number(run.costs?.mailRentals || 0);
  const mail = Math.max(0, Number(run.costs?.mail || 0));
  const wastedMail = Math.min(mail, Math.max(0, Number(run.costs?.wastedMail || 0)));
  // The parts, kept for the tooltip and for a mixed-currency run where adding
  // them would be wrong.
  const mailText = mailRentals > 0 && mail > MONEY_TOLERANCE ? formatCurrency(mail, 'USD', 3) : '';
  const parts = [sms === '—' ? '' : sms, mailText].filter(Boolean).join(' + ') || '—';
  // "总金额" used to read `$0.18 + $0.14` — two numbers and an operator, left
  // for the eye to add. The server now sends the sum when both sides bill in
  // the same currency, and null when they do not; fall back to the parts.
  const summed = run.costs?.total;
  const total = typeof summed === 'number' && Number.isFinite(summed) && parts !== '—'
    ? formatCurrency(summed, 'USD', 3)
    : parts;
  const waste = [
    // Per currency where the billing record splits it that way — a CNY
    // provider's wasted numbers are not dollars — and otherwise the run's own
    // currency. Mailbox rentals settle in USD either way.
    ...smsWasteAmounts(run),
    wastedMail > MONEY_TOLERANCE ? formatCurrency(wastedMail, 'USD', 3) : '',
  ].filter(Boolean).join(' + ');
  // Only reasons the ledger actually classified. A legacy run carries a bare
  // `wasted` count and no breakdown, and inventing a row for it would put a
  // number on screen that nothing stands behind.
  const reasons = (run.counts?.wastedBreakdown || []).filter((item) => Number(item.count || 0) > 0);
  return { total, parts, mailText, waste, reasons };
}

/**
 * What the money bought, in units rather than in quotes.
 *
 * Counted the way the total is: only what was charged for. A number that
 * never delivered a code is cancelled and costs nothing, and counting those
 * too put 907 next to $3.07 — a ratio that reads as a bug rather than as
 * churn. The gross figure belongs to a supplier reconciliation, not here.
 */
function runTotalCostHint(run: RunSummary) {
  const hints: string[] = [];
  const activations = Number(run.costs?.smsBilledActivations || 0);
  if (activations > 0) hints.push(`号码 ${activations} 个`);
  const mailRentals = Number(run.costs?.mailRentals || 0);
  if (mailRentals > 0) hints.push(`邮箱 ${mailRentals} 个已结算`);
  const exception = smsBillingException(run);
  if (exception) hints.push(exception);
  return hints.join(' · ') || '—';
}

/** 任务总金额: everything the run confirmed, waste included. */
function RunCostMetric({ run }: { run: RunSummary }) {
  const { total, parts, mailText } = runCostSummary(run);
  // The mailbox side, spelled out next to the total. Two rental modes bill
  // separately and an operator checking a supplier invoice needs the split,
  // which used to live only in a tooltip. Only when the headline is a sum:
  // a mixed-currency run still shows `$0.04 + $0.200`, which is the split
  // already.
  const value = mailText && total !== parts ? `${total}（邮箱 ${mailText}）` : total;
  return <Metric className="metric-cost" label="任务总金额" value={<span title={parts === total ? total : `${total}（${parts}）`}>{value}</span>} hint={runTotalCostHint(run)} icon={<CircleDollarSign size={20} />} />;
}

/**
 * The wasted share of a run's spend, on one line under the metrics.
 *
 * A line rather than a tile. The reasons are named — `号码已被占用`, not
 * `PHONE_RECENTLY_USED` — and names need room: a tile is a fifth of the strip
 * and truncates them to nothing, while the strip has the width to spare and
 * only appears when a run actually wasted something.
 */
function RunWasteStrip({ run }: { run: RunSummary }) {
  const { waste, reasons } = runCostSummary(run);
  if (!waste) return null;
  const attempts = reasons.length
    ? reasons.reduce((total, item) => total + Number(item.count || 0), 0)
    : Number(run.counts?.wasted || 0);
  return <div className="run-waste-strip" role="note" aria-label="浪费">
    <AlertTriangle size={14} aria-hidden="true" />
    <strong>浪费 {waste}</strong>
    {attempts > 0 && <span>{attempts} 次</span>}
    {/* Only reasons the ledger classified. A legacy run has the amount and the
        count but no breakdown, and inventing a row for it would put a number
        on screen that nothing stands behind. */}
    {reasons.map((item) => <em key={`${item.kind}-${item.code}`} data-wasted-code={item.code} title={item.code}>
      {WASTE_CODE_LABELS[item.code] || item.code}<b>{item.count}</b>
    </em>)}
  </div>;
}

function formatReconciliationAmount(value: number | null | undefined, currency: string) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  const code = String(currency || 'USD').toUpperCase();
  const formatted = Number(value).toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 6 });
  if (code === 'USD') return `$${formatted}`;
  if (code === 'CNY' || code === 'RMB') return `¥${formatted}`;
  return `${formatted} ${code}`;
}

function reconciliationStatusLabel(status: BalanceReconciliation['status']) {
  if (status === 'manual_review') return '需人工核对';
  return ({
    pending: '待核对',
    matched: '已对上',
    mismatch: '金额不一致',
    concurrent: '并发不可归因',
  } as Record<string, string>)[status] || '待核对';
}

function reconciliationStatusDetail(reconciliation: BalanceReconciliation, active: boolean) {
  if (reconciliation.status === 'manual_review' || reconciliation.manualReviewRequired) {
    return '开始余额缺失，任务已结束，需要人工核对这笔支出';
  }
  if (active && !reconciliation.finalizedAt) return '任务结束后读取结束余额并完成核对';
  if (reconciliation.note === 'balance_matched_cancelled_quotes_excluded') return '余额实际减少与任务确认金额一致；取消号码报价未计入确认消费';
  if (reconciliation.status === 'matched') return '余额实际减少与任务确认金额一致';
  if (reconciliation.status === 'mismatch') return '余额实际减少与任务确认金额的差额超过容差';
  if (reconciliation.note === 'balance_account_changed') return '任务恢复或运行期间切换了余额账号，开始与结束余额不属于同一账户，暂不比较';
  if (reconciliation.status === 'concurrent') return '任务期间有其他任务共用该资金账户，本次余额变化无法单独归因';
  if (reconciliation.note === 'task_amount_currency_mismatch') return '任务包含不同币种的费用，不能直接与当前资金账户余额相加核对';
  if (reconciliation.note === 'billing_incomplete') return '仍有未决费用，暂不判定金额是否一致';
  // A rise in the balance is a deposit, not spending; it is reported as such
  // rather than as a disagreement with the task's charges.
  if (reconciliation.note === 'balance_increased_during_run') return '任务期间余额不降反增，通常是期间充值；本次余额变化不能用于核对';
  if (reconciliation.note === 'confirmed_amount_unavailable') return '两次余额都读到了，但任务没有记录确认金额，没有可比对的数字';
  if (reconciliation.note === 'start_balance_unavailable') return '开始余额读取失败，无法计算本次余额变化';
  // Deliberately does not promise a later reconciliation: the task is over and
  // nothing re-runs on its own. It only says a retry is still possible.
  if (reconciliation.note === 'end_balance_unavailable') return '结束余额读取失败，本次未能核对；余额可读后可重新核对';
  return '余额快照或账单结果不完整，暂不能判定';
}

function BalanceReconciliationPanel({ run, onRetry, retrying = false }: { run: RunSummary; onRetry?: () => void; retrying?: boolean }) {
  const reconciliation = run.balanceReconciliation;
  if (!reconciliation) return null;
  const totalConfirmed = reconciliation.confirmedConsumed;
  const mailIncluded = Number(run.costs?.mail || 0) > 0;
  const status = reconciliation.status || 'pending';
  // The verdict already names these; showing them is what lets an operator act
  // on it. "仍有未决费用" without the amount, or "有其他任务共用" without saying
  // which, is a dead end when both numbers are already in the record.
  const unresolved = Number(reconciliation.unresolved || 0) > 0 ? reconciliation.unresolved : null;
  const cancelledUnresolved = Number(run.billing?.cancelledUnresolvedUsd || 0);
  const cancelledQuotesSettled = Number(
    reconciliation.cancelledQuotesSettledByBalance
      ?? run.billing?.cancelledQuotesSettledUsd
      ?? 0,
  );
  const cancellationOnlyPending = unresolved !== null && isOnlyCancelledQuote(unresolved, cancelledUnresolved);
  const concurrentRunIds = reconciliation.concurrentRunIds || [];
  const errorCode = reconciliation.error?.code || '';
  const cancellationDetails = cancellationBillingMessages(run).join('；');
  const statusDetail = cancellationOnlyPending && reconciliation.note === 'billing_incomplete'
    ? '取消号码的供应商结算尚未确认'
    : reconciliationStatusDetail(reconciliation, Boolean(run.active));
  return <section className={`workspace-band run-balance-band run-balance-${status}`}>
    <div className="section-heading run-balance-heading">
      <div><h2>费用核对</h2><p>本次任务总确认金额与资金账户余额变化的结果</p></div>
      <div className="run-balance-heading-actions">
        <span className="run-balance-provider">{reconciliation.provider} · {reconciliation.currency}</span>
        {!run.active && reconciliation.retryable === true && onRetry && <Button icon={retrying ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />} onClick={onRetry} disabled={retrying}>{retrying ? '正在重新核对' : '重新核对余额'}</Button>}
      </div>
    </div>
    <div className="run-balance-grid">
      <div><small>开始余额</small><strong>{formatReconciliationAmount(reconciliation.startBalance, reconciliation.currency)}</strong></div>
      <div><small>结束余额</small><strong>{formatReconciliationAmount(reconciliation.endBalance, reconciliation.currency)}</strong></div>
      <div><small>余额实际减少</small><strong>{formatReconciliationAmount(reconciliation.observedDecrease, reconciliation.currency)}</strong></div>
      <div><small>任务确认金额</small><strong>{formatReconciliationAmount(totalConfirmed, reconciliation.currency)}</strong></div>
      <div><small>差额（减少 − 确认）</small><strong>{formatReconciliationAmount(reconciliation.difference, reconciliation.currency)}</strong></div>
      {cancelledQuotesSettled > MONEY_TOLERANCE && <div className="run-balance-excluded"><small>已排除取消报价</small><strong>{formatReconciliationAmount(cancelledQuotesSettled, reconciliation.currency)}</strong></div>}
      {unresolved !== null && <div><small>{cancellationOnlyPending ? '待供应商结算' : '未决费用'}</small><strong>{formatReconciliationAmount(unresolved, reconciliation.currency)}</strong></div>}
    </div>
    <div className="run-balance-status">
      {status === 'matched' ? <Check size={15} /> : <AlertTriangle size={15} />}
      <div>
        <strong>{reconciliationStatusLabel(status)}</strong>
        <span>{statusDetail}{cancellationDetails ? `；${cancellationDetails}` : ''}{mailIncluded ? '；已结算邮箱租约已计入任务确认金额' : ''}{errorCode ? `（${errorCode}）` : ''}</span>
        {concurrentRunIds.length > 0 && <span className="run-balance-shared">共用该账户的任务：{concurrentRunIds.map((runId, index) => <span key={runId}>{index > 0 ? '、' : ''}<Link to={`/run/${encodeURIComponent(runId)}`}>{runId}</Link></span>)}</span>}
      </div>
    </div>
  </section>;
}

function downloadJson(payload: unknown, fileName: string) {
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function sub2ApiFileName(cpaFileName: string) {
  const baseName = cpaFileName.replace(/\.json$/i, '') || 'codex-cpa';
  return `${baseName}.sub2api.json`;
}

function ProxyCountrySelect({ value, onValueChange, includeGlobal = true }: { value: string; onValueChange: (value: string) => void; includeGlobal?: boolean }) {
  return <AppSelect
    value={value}
    options={includeGlobal ? PROXY_COUNTRY_SELECT_OPTIONS : PROXY_COUNTRY_SELECT_OPTIONS.filter((option) => option.value !== 'GLOBAL')}
    onValueChange={onValueChange}
    ariaLabel="国家"
    searchable
    minMenuWidth={240}
    className="country-select"
  />;
}

function useTheme() {
  const [theme, setTheme] = useState(() => localStorage.getItem('gpt-re-theme') || 'light');
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('gpt-re-theme', theme);
  }, [theme]);
  return { theme, toggle: () => setTheme((value) => value === 'light' ? 'dark' : 'light') };
}

function ServiceIndicator({ service }: { service: ServiceStatus }) {
  const online = ['online', 'configured'].includes(service.status);
  return <div className="service-indicator" title={service.message || ''}>{online ? <Wifi size={14} /> : <WifiOff size={14} />}<span>{service.name}</span><span className={`service-light service-${statusTone(service.status)}`} /></div>;
}

/**
 * A once-a-second clock, shared by everything in the top bar that shows elapsed
 * time.
 *
 * A running robot's `durationMs` is 0 until it finishes, so elapsed has to be
 * derived from `startedAt` on the client. One ticker for the whole bar, and
 * only while something is actually running — an idle console does not re-render
 * every second.
 */
function useElapsedTicker(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function elapsedSince(startedAt: string | undefined, now: number) {
  const started = Date.parse(String(startedAt || ''));
  if (!Number.isFinite(started)) return '';
  return durationLabel(Math.max(0, now - started));
}

/**
 * Running robots and timed robot waits, in the top bar.
 *
 * Renders nothing when nothing is running, so the bar keeps its usual shape;
 * the row is a fixed-height flex line and this sits in the elastic middle.
 */
function TopbarActivity({ activeRunId }: { activeRunId: string }) {
  const robots = useQuery({
    queryKey: ['robots'],
    queryFn: endpoints.robots,
    refetchInterval: 2500,
  });
  const activeRobots = (robots.data?.robots || []).filter((robot) => (
    robot.status === 'running'
    || (robot.status === 'waiting' && robot.progress?.mode === 'countdown')
  ));
  const local = useLocalActivity();
  const busy = activeRobots.length > 0 || Boolean(activeRunId) || Boolean(local);
  const now = useElapsedTicker(busy);
  if (!busy) return null;
  return <div className="topbar-activity">
    {/* The outcome goes in the tooltip as well as the box: the box has room
        for 完成 and nothing else, and the message it carries is the only place
        a one-line summary of the run exists once the notice has gone. */}
    {local && <span
      className={`topbar-activity-item${local.status === 'complete' ? ' is-complete' : local.status === 'error' ? ' is-error' : ''}`}
      title={local.message || `${local.label} ${local.done}/${local.total}`}
    >
      <span className={`topbar-activity-name${local.status === 'complete' ? ' is-complete' : ''}`}>{local.label}</span>
      <span className="topbar-activity-track">
        <span className="topbar-activity-fill" style={{ width: `${Math.max(4, Math.round((local.done / Math.max(1, local.total)) * 100))}%` }} />
      </span>
      <b>{local.status === 'complete' ? '完成' : local.status === 'error' ? '失败' : `${local.done}/${local.total}`}</b>
    </span>}
    {activeRobots.map((robot) => {
      const progress = robot.progress;
      const countdownEndsAt = progress?.mode === 'countdown' ? Date.parse(String(progress.endsAt || '')) : NaN;
      const countdown = Number.isFinite(countdownEndsAt) && Number(progress?.total) > 0;
      const remainingMs = countdown ? Math.max(0, countdownEndsAt - now) : 0;
      const percent = countdown
        ? Math.max(0, Math.min(100, Math.ceil((remainingMs / Math.max(1, Number(progress?.total))) * 100)))
        : progress && progress.total > 0
          ? Math.min(100, Math.round((progress.done / progress.total) * 100))
          : null;
      const elapsed = elapsedSince(robot.lastRun?.startedAt, now);
      return <span
        className="topbar-activity-item"
        key={robot.id}
        title={`${robot.name}${progress?.label ? ` · ${progress.label}` : ''}${countdown ? ` · 剩余 ${durationLabel(remainingMs)}` : ''}${elapsed ? ` · 已运行 ${elapsed}` : ''}`}
      >
        <span className={`topbar-activity-name${countdown ? ' is-countdown' : ''}`}>{countdown ? `${robot.name} · ${progress?.label || '下一轮开始'}` : robot.name}</span>
        {/* An indeterminate bar for a handler that reports no progress, so the
            row does not silently drop the robots that cannot count themselves. */}
        <span className={`topbar-activity-track${percent === null ? ' is-indeterminate' : ''}`}>
          <span className="topbar-activity-fill" style={percent === null ? undefined : { width: `${percent}%` }} />
        </span>
        {progress && progress.total > 0 && <b>{countdown ? durationLabel(remainingMs) : `${progress.done}/${progress.total}`}</b>}
        {!countdown && elapsed && <time>{elapsed}</time>}
      </span>;
    })}
  </div>;
}

/**
 * The result line each page keeps for itself, by the group its work publishes
 * under.
 *
 * The floating copy exists for work whose page the operator has since left; on
 * the page that already states the outcome it is the same sentence twice, one
 * of which then disappears. Keyed by group rather than by path because a CPA
 * push is only restated on the history page: suppressing it by path hid it
 * from someone standing on the sessions page, which states session checks and
 * nothing else.
 */
const PAGE_RESULT_GROUPS: Record<string, string> = {
  '/sessions': SESSION_CHECK_GROUP,
  '/history': CPA_PUSH_GROUP,
};

function LocalActivityNotice({ suppressGroup }: { suppressGroup?: string }) {
  const local = useLocalActivity();
  if (!local || local.status === 'running' || !local.message) return null;
  if (suppressGroup && local.group === suppressGroup) return null;
  return <Notice tone={local.tone || (local.status === 'error' ? 'danger' : 'success')} floating onClose={() => localActivity.dismiss(local.id)} autoDismissToken={local.id}>{local.message}</Notice>;
}

function AppLayout({ children }: { children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { theme, toggle } = useTheme();
  const { path } = useRouter();
  // Keyed by route shape, not by the exact path. Keying on the path meant that
  // moving between two runs threw the whole page away and rebuilt it — every
  // memo, every virtualizer, every query observer — when only an id changed.
  const routeKey = path.replace(/^\/run\/.*/, '/run');
  const services = useQuery({ queryKey: ['services'], queryFn: () => endpoints.services(), refetchInterval: 15_000 });
  const health = useQuery({ queryKey: ['health'], queryFn: endpoints.health, refetchInterval: 4_000 });
  // One observer owns the task summary for the whole console. Pages and the
  // task-center panel read this snapshot instead of creating competing timers.
  const runs = useQuery<RunListSnapshot>({
    queryKey: ['runs'],
    queryFn: endpoints.runs,
    refetchInterval: (query) => {
      const hasUnfinishedRun = (query.state.data?.runs || []).some((run) => !isTerminalRunStatus(run.status));
      return hasUnfinishedRun ? RUNS_POLL_ACTIVE_MS : RUNS_POLL_IDLE_MS;
    },
  });

  return <RunsQueryContext.Provider value={runs}>
    <div className="app-shell">
    <aside className={`sidebar ${mobileOpen ? 'sidebar-open' : ''}`}>
      <div className="brand"><div className="brand-mark">G</div><div><strong>GPT-RE</strong><span>注册控制台</span></div></div>
      <nav>{navItems.map(({ to, label, icon: Icon }) => <NavLink key={to} to={to} end={to === '/'} onClick={() => setMobileOpen(false)} className={({ isActive }) => isActive ? 'nav-link nav-active' : 'nav-link'}><Icon size={18} /><span>{label}</span><ChevronRight className="nav-chevron" size={15} /></NavLink>)}</nav>
      <div className="sidebar-foot"><span className="local-only"><ShieldCheck size={15} />仅限本机</span><span>127.0.0.1:3210</span></div>
    </aside>
    {mobileOpen && <button className="sidebar-scrim" aria-label="关闭导航" onClick={() => setMobileOpen(false)} />}
    <div className="app-body">
      <header className="topbar">
        <IconButton label="打开导航" onClick={() => setMobileOpen(true)}><Menu size={19} /></IconButton>
        <div className="service-strip">
          {(services.data?.services || []).map((service) => <ServiceIndicator key={service.name} service={service} />)}
          {services.data?.sms && <ServiceIndicator service={services.data.sms} />}
        </div>
        <TopbarActivity activeRunId={health.data?.activeRunId || ''} />
        <div className="topbar-spacer" />
        <TaskCenter activeRunId={health.data?.activeRunId || ''} />
        <IconButton label={theme === 'light' ? '切换深色主题' : '切换浅色主题'} onClick={toggle}>{theme === 'light' ? <Moon size={18} /> : <Sun size={18} />}</IconButton>
      </header>
      <LocalActivityNotice suppressGroup={PAGE_RESULT_GROUPS[path]} />
      <main className={`content ${/^\/run(?:\/|$)/.test(path) ? 'content-run' : (path === '/' || path === '/config' ? 'content-launch' : path === '/proxies' ? 'content-proxy' : path === '/history' ? 'content-history' : path === '/sessions' ? 'content-sessions' : path === '/rebind' ? 'content-rebind' : path === '/chains' ? 'content-chains' : path === '/robots' ? 'content-robots' : '')}`}><div className="route-view" key={routeKey}>{children}</div></main>
    </div>
    </div>
  </RunsQueryContext.Provider>;
}

/**
 * Every task the scheduler is holding a slot for, in one top-bar control.
 *
 * The badge it replaces read `health.activeRunId` and rendered the words "任务
 * 运行中". Two things were wrong with that, and both are the shapes an operator
 * gets stuck in:
 *
 *  - It showed **one** run. The scheduler runs a main task beside several
 *    auxiliary ones, so with two tasks in flight the bar named one and hid the
 *    rest — including, if the main task was the hidden one, the only task that
 *    matters.
 *  - It showed only **executing** runs. A paused or waiting task keeps its slot
 *    precisely so it stays resumable, so `active` is false while the slot is
 *    still taken. The bar went blank, the launch button stayed disabled, and
 *    nothing on screen connected the two. That is the "任务崩了暂停不了" report.
 *
 * So the trigger counts what is running *and* what is merely holding, and the
 * panel lists both against the slot capacity they are consuming.
 */
function slotHolderRuns(runs: RunSummary[], activeRunIds: Set<string>) {
  return runs
    .filter((run) => run.active || activeRunIds.has(run.runId) || !isTerminalRunStatus(run.status))
    .sort((left, right) => {
      const slot = Number(isAuxiliaryRun(left)) - Number(isAuxiliaryRun(right));
      if (slot) return slot;
      // Executing tasks first: a holder that is parked is the thing you act on
      // second, after seeing what is actually moving.
      const active = Number(Boolean(right.active)) - Number(Boolean(left.active));
      if (active) return active;
      // `updatedAt` changes on every checkpoint and poll. The creation time is
      // stable for the life of a run, so keep parallel rows in a fixed order.
      const started = String(right.startedAt || '').localeCompare(String(left.startedAt || ''));
      if (started) return started;
      return String(left.runId).localeCompare(String(right.runId));
    });
}

function TaskSlotMeter({ slot, capacity }: { slot: 'main' | 'auxiliary'; capacity?: TaskSlotCapacity }) {
  const used = capacity ? capacity.running + capacity.starting : 0;
  const total = capacity?.capacity ?? (slot === 'main' ? 1 : AUXILIARY_TASK_CAPACITY);
  const full = capacity ? capacity.available <= 0 : false;
  return <div className={`task-slot-meter${full ? ' is-full' : ''}`}>
    <div className="task-slot-meter-head">
      <strong>{TASK_SLOT_LABELS[slot]}</strong>
      <em>{used}/{total || '—'}</em>
    </div>
    <p>{TASK_SLOT_PURPOSE[slot]}</p>
  </div>;
}

function TaskCenter({ activeRunId }: { activeRunId: string }) {
  const [open, setOpen] = useState(false);
  const runs = useRunsQuery();
  const activeRunIds = new Set(runs.data?.activeRunIds || (runs.data?.activeRunId ? [runs.data.activeRunId] : []));
  const holders = slotHolderRuns(runs.data?.runs || [], activeRunIds);
  const executing = holders.filter((run) => run.active);
  const parked = holders.filter((run) => !run.active);
  const now = useElapsedTicker(holders.length > 0);
  const capacity = runs.data?.taskCapacity;
  if (!holders.length) {
    // Worth saying once, quietly, rather than leaving the corner empty and
    // ambiguous about whether the console is even polling.
    return <Link className="task-center-trigger is-idle" to="/" title="当前没有任务占用任务位">
      <span className="task-center-dot" />空闲
    </Link>;
  }
  const label = `任务中心：${executing.length} 个运行中${parked.length ? `，${parked.length} 个占用任务位` : ''}`;
  return <div className="task-center">
    <button
      type="button"
      className={`task-center-trigger${executing.length ? ' is-running' : ' is-parked'}`}
      aria-label={label}
      aria-expanded={open}
      onClick={() => setOpen((value) => !value)}
    >
      <span className={`task-center-dot${executing.length ? ' pulse' : ''}`} />
      {executing.length > 0 && <><b>{executing.length}</b><span>运行</span></>}
      {parked.length > 0 && <><b className="task-center-parked">{parked.length}</b><span>占用</span></>}
      <ChevronDown size={14} />
    </button>
    {/* Anchored by CSS to the bar rather than measured: the panel always hangs
        from the same corner, so none of Radix Popper's positioning — and none
        of the ResizeObserver it needs — buys anything here. `AppSelect` takes
        the same route for the same reason. */}
    {open && <DismissableLayer.DismissableLayer
      asChild
      onEscapeKeyDown={() => setOpen(false)}
      onPointerDownOutside={() => setOpen(false)}
      onFocusOutside={() => setOpen(false)}
    >
      <div className="task-center-panel" role="dialog" aria-label="任务中心">
        <div className="task-center-slots">
          <TaskSlotMeter slot="main" capacity={capacity?.main} />
          <TaskSlotMeter slot="auxiliary" capacity={capacity?.auxiliary} />
        </div>
        <div className="task-center-list">
          {holders.map((run) => {
            const kind = run.taskKind || run.plan?.taskKind;
            const description = runTaskDescription(run);
            const phase = phaseLabel(run.phase);
            const elapsed = elapsedSince(run.startedAt, now);
            return <Link
              className={`task-center-row${run.runId === activeRunId ? ' is-current' : ''}`}
              to={`/run/${run.runId}`}
              key={run.runId}
              onClick={() => setOpen(false)}
            >
              <span className="task-center-slot">{runTaskSlotLabel(run)}</span>
              <span className="task-center-body">
                <strong>{taskKindLabel(kind, run.plan)}</strong>
                {description && <small className="task-center-desc">{description}</small>}
                <small className="task-center-meta">
                  <span title={phase.raw}>{phase.label}</span>
                  {elapsed && <time>已运行 {elapsed}</time>}
                  {/* Named, because "holding a slot without executing" is the
                      state an operator has to resolve before launching. */}
                  {!run.active && <em>占用任务位</em>}
                </small>
              </span>
              <StatusBadge status={run.status} label={runStatusLabel(run.status)} />
            </Link>;
          })}
        </div>
        {parked.length > 0 && <p className="task-center-hint">
          占用任务位的任务并未在执行。恢复或取消它之后，对应的任务位才会释放。
        </p>}
      </div>
    </DismissableLayer.DismissableLayer>}
  </div>;
}

function Metric({ label, value, hint, icon, className }: { label: string; value: ReactNode; hint?: string; icon: ReactNode; className?: string }) {
  return <div className={`metric${className ? ` ${className}` : ''}`}>
    <div className="metric-icon">{icon}</div>
    <div><span>{label}</span><strong>{value}</strong>{hint && <small title={hint}>{hint}</small>}</div>
  </div>;
}

/**
 * Any run that registers accounts, whether or not OAuth follows in the same job.
 *
 * The registration tiles used to be gated on `isRegistrationOnlyRun`, so a
 * register-then-OAuth run showed its CPA artifacts and nothing about the
 * registrations that produced them — no outcomes, no skips, no timeouts.
 */
function isRegistrationRun(run: RunSummary) {
  return (run.taskKind || run.plan?.taskKind) === 'register_session';
}

/** A registration run with no OAuth stage, so there is no CPA artifact to count. */
function isRegistrationOnlyRun(run: RunSummary) {
  return isRegistrationRun(run) && run.plan?.postRegistrationOAuth !== true;
}

type OutcomeRow = { key: string; label: string; title?: string; count: number };

/**
 * A tile whose value is a short list of named outcomes rather than one number.
 *
 * 注册结果 and 跳过任务 were two components with the same markup, the same
 * three CSS rules and their own copies of the row shape. The names an operator
 * reads come from the row list; the protocol codes behind them stay in the
 * tooltips.
 */
function OutcomeMetric({ label, icon, rows }: { label: string; icon: ReactNode; rows: OutcomeRow[] }) {
  return <div className="metric metric-outcomes" aria-label={label}>
    <div className="metric-icon">{icon}</div>
    <div className="metric-outcome-list">
      <span className="metric-outcome-label">{label}</span>
      {rows.map((row) => <div className={`metric-outcome-row metric-outcome-${row.key}`} key={row.key}>
        <span title={row.title || row.label}>{row.label}</span><strong>{row.count}</strong>
      </div>)}
    </div>
  </div>;
}

function RegistrationOutcomeMetric({ outcomes }: { outcomes?: RegistrationOutcomeCounts }) {
  const callbackFailed = Number(outcomes?.callbackFailed || 0);
  const securityIncomplete = Number(outcomes?.securityIncomplete || 0);
  return <OutcomeMetric label="注册结果" icon={<ListRestart size={20} />} rows={[
    { key: 'existing-account', label: '已有账号恢复', count: outcomes?.existingAccountRecovered ?? 0 },
    { key: 'mfa-totp', label: '账号已存在', title: 'MFA_TOTP / USER_ALREADY_EXISTS', count: outcomes?.mfaTotp ?? 0 },
    // Only when they happened: a permanent zero on a tile reads as a column of
    // noise rather than as a result.
    ...(callbackFailed > 0 ? [{ key: 'callback-failed', label: '回调失败', title: '回调重试耗尽后最终失败', count: callbackFailed }] : []),
    ...(securityIncomplete > 0 ? [{ key: 'security-incomplete', label: '安全项未完成', title: '密码或 TOTP 没设成功，已暂停 OAuth；在登录态页跑 OTP/PW 恢复后再发起', count: securityIncomplete }] : []),
  ]} />;
}

function RegistrationSkippedMetric({ outcomes }: { outcomes?: RegistrationSkippedCounts }) {
  return <OutcomeMetric label="跳过任务" icon={<SkipForward size={20} />} rows={[
    { key: 'email-timeout', label: '邮箱超时', count: outcomes?.emailTimeout ?? 0 },
    { key: 'rental-timeout', label: '租约超时', title: '24 分钟内没有拿到可用邮箱', count: outcomes?.rentalStartTimeout ?? 0 },
    { key: 'origin-invalid', label: '登录来源错误', title: 'AUTH_CONTINUATION_ORIGIN_INVALID', count: outcomes?.authContinuationOriginInvalid ?? 0 },
  ]} />;
}

function OAuthSkippedMetric({ outcomes }: { outcomes: OAuthSkippedCounts }) {
  return <OutcomeMetric label="OAuth 跳过" icon={<SkipForward size={20} />} rows={[
    { key: 'oauth-rate-limit', label: '速率限制', title: 'RATE_LIMIT_EXCEEDED / HTTP 429', count: outcomes.rateLimited ?? 0 },
    { key: 'oauth-phone-budget', label: '号码用尽', title: 'OAuth 手机号替换次数用完（默认 20 次）：OAUTH_PHONE_REPLACEMENT_BUDGET_EXHAUSTED', count: outcomes.phoneBudgetExhausted ?? 0 },
    { key: 'oauth-login-required', label: '跳登录页', title: 'OAuth 被跳转回登录页：OAUTH_LOGIN_REQUIRED', count: outcomes.loginRequired ?? 0 },
  ]} />;
}

type PreflightCheck = NonNullable<PreflightSnapshot['checks']>[number];

function PreflightCheckCard({ check, mailLabel }: { check: PreflightCheck; mailLabel: string }) {
  const pending = !check.checked && check.required;
  const stateClass = pending ? 'check-pending' : (!check.checked ? 'check-conditional' : (check.ready ? 'check-ready' : 'check-blocked'));
  const stateLabel = pending ? '等待检查' : (!check.checked ? '按需检查' : (check.ready ? '已就绪' : '未就绪'));
  const label = check.id === 'mail' ? mailLabel : (check.id === 'proxy' ? 'Worker 代理' : '短信市场');
  return <div className={`preflight-check ${stateClass}`} data-state={stateClass.replace('check-', '')}>
    <span className="preflight-state-dot" aria-hidden="true" />
    <div><strong>{label}</strong><small>{stateLabel} · {check.detail}</small></div>
    <em>{check.required ? '必需' : '按需'}</em>
  </div>;
}

function runPlanFromConfig(config: Record<string, any>, catalog?: ProxyCatalogSnapshot, mailProviderOverride?: string): RunPlan {
  const mailCount = Math.min(MAX_MAIL_RENTAL_TARGET, Math.max(1, Number(config.mail?.count || 1)));
  const requestedProvider = String(mailProviderOverride || config.mail?.provider || 'xiaopingguo').toLowerCase();
  const supportedProviders: NonNullable<RunPlan['mailProvider']>[] = ['xiaopingguo', 'smsbower', 'mailcom', 'fastmail', 'icloud'];
  const mailProvider: NonNullable<RunPlan['mailProvider']> = supportedProviders.includes(requestedProvider as NonNullable<RunPlan['mailProvider']>)
    ? requestedProvider as NonNullable<RunPlan['mailProvider']>
    : 'xiaopingguo';
  const channel = mailChannel(mailProvider);
  const configuredAliasStrategy = String(config.aliases?.strategy || '').toLowerCase();
  // Only the persistent Xiaopingguo pool can safely serve a root address and
  // one plus alias. SMSBower rents one address per activation and must stay
  // root-only; the UI switch is available only for the pooled channel.
  const aliasEnabled = channel.supportsAliases === true
    && (channel.defaultAliasEnabled === true || ['plus', 'root_plus'].includes(configuredAliasStrategy));
  const aliasCount = aliasEnabled ? 2 : 1;
  const workerConcurrency = Math.min(mailCount, Math.max(1, Number(config.workers?.maxConcurrency || 1)));
  return {
    schemaVersion: 3,
    taskKind: 'register_session',
    mailCount,
    workerConcurrency,
    aliasEnabled,
    aliasStrategy: aliasEnabled ? 'root_plus' : 'root',
    aliasCount,
    aliasMaxAttempts: aliasCount,
    aliasRunTag: String(config.aliases?.runTag || 'gptre'),
    proxyAssignments: defaultProxyAssignments(workerConcurrency, catalog),
    totalAccounts: mailCount * aliasCount,
    oauthSource: null,
    postRegistrationOAuth: channel.forces?.postRegistrationOAuth === true,
    security: {
      setPassword: channel.forces?.security?.setPassword ?? true,
      enrollTotp: channel.forces?.security?.enrollTotp ?? true,
    },
    mailProvider,
    mailRentalWatch: false,
  };
}

function runRecency(run: RunSummary) {
  for (const value of [run.updatedAt, run.startedAt]) {
    const timestamp = Date.parse(String(value || ''));
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return Number.NEGATIVE_INFINITY;
}

/** Restore the channel used by the most recently touched mailbox task. */
function latestRunMailProvider(runs?: RunSummary[]) {
  return [...(runs || [])]
    .filter((run) => Boolean(run.plan?.mailProvider))
    .sort((left, right) => {
      const leftTime = runRecency(left);
      const rightTime = runRecency(right);
      return leftTime === rightTime ? 0 : rightTime - leftTime;
    })[0]
    ?.plan?.mailProvider;
}

function preflightQueryKey(plan: RunPlan) {
  return ['resources', JSON.stringify({
    taskKind: plan.taskKind,
    mailCount: plan.mailCount,
    workerConcurrency: plan.workerConcurrency,
    mailProvider: plan.mailProvider,
    mailRentalWatch: plan.mailRentalWatch,
    mailRentalTarget: plan.mailRentalTarget,
    mailRentalBatchSize: plan.mailRentalBatchSize,
    mailRentalPollIntervalMs: plan.mailRentalPollIntervalMs,
    oauthSource: plan.oauthSource,
    postRegistrationOAuth: plan.postRegistrationOAuth,
    proxyAssignments: plan.proxyAssignments,
  })] as const;
}

/** Every mail channel the launch page can pick, and what each one constrains. */
type MailChannel = {
  id: NonNullable<RunPlan['mailProvider']>;
  name: string;
  tag: string;
  detail: string;
  /** Plan fields this channel pins, applied on selection and on every edit. */
  forces?: Partial<RunPlan>;
  /** Whether this provider can serve a root address and one plus alias. */
  supportsAliases?: boolean;
  /** The alias switch starts on for this channel (the operator can still turn it off). */
  defaultAliasEnabled?: boolean;
  /** Shown in place of the alias hint when the switch is locked off. */
  aliasLockedReason?: string;
  /** Blocks "register only", because the account must finish OAuth in-run. */
  requiresOAuthInRun?: boolean;
};

const MAIL_CHANNELS: MailChannel[] = [
  {
    id: 'xiaopingguo',
    name: '小苹果池',
    tag: 'POOL',
    detail: '常驻 Outlook 邮箱池，可反复读取验证码',
    supportsAliases: true,
  },
  {
    id: 'smsbower',
    name: 'SMSBower Gmail',
    tag: 'RENTAL',
    detail: '按次租用，跑完即结算；密码与 TOTP 必须完成，OAuth 可选',
    supportsAliases: false,
    aliasLockedReason: '按次租用，只有根邮箱',
    // A rental closes with the run, so the account has to leave it able to log
    // in unaided; and its code quota cannot serve a second address. OAuth is
    // available as an explicit follow-up, but is not required for registration.
    forces: { aliasEnabled: false, security: { setPassword: true, enrollTotp: true }, postRegistrationOAuth: false },
  },
  {
    id: 'mailcom',
    name: 'Mail API',
    tag: 'CYCLE',
    detail: '统一 8001 接口；在配置中切换 Mail.com / Fastmail 参数',
    supportsAliases: false,
    aliasLockedReason: '别名由 8001 服务自动创建和循环回收',
    forces: { aliasEnabled: false, security: { setPassword: true, enrollTotp: true }, postRegistrationOAuth: false },
  },
  {
    id: 'icloud',
    name: 'iCloud',
    tag: 'POOL',
    detail: '独立 iCloud 邮箱池；可开启别名，额外注册一个 根邮箱+标签@ 地址',
    supportsAliases: true,
    defaultAliasEnabled: true,
    forces: { security: { setPassword: true, enrollTotp: true }, postRegistrationOAuth: false },
  },
];

const DEFAULT_XIAOPINGGUO_BASE_URL = 'http://127.0.0.1:8000';
const DEFAULT_MAILCOM_BASE_URL = 'http://127.0.0.1:8001';
const DEFAULT_MAILCOM_ALIAS_BATCH_SIZE = 9;
const DEFAULT_FASTMAIL_ALIAS_BATCH_SIZE = 1;

function defaultAliasBatchSize(provider: 'mailcom' | 'fastmail') {
  return provider === 'fastmail' ? DEFAULT_FASTMAIL_ALIAS_BATCH_SIZE : DEFAULT_MAILCOM_ALIAS_BATCH_SIZE;
}

function mailEndpointForProvider(draft: Record<string, any>, provider: string) {
  const mail = draft?.mail || {};
  const legacy = String(mail.baseUrl || '').replace(/\/+$/, '');
  const xiaopingguo = String(
    mail.xiaopingguoBaseUrl
      || (String(mail.provider || '').toLowerCase() === 'xiaopingguo' && legacy !== DEFAULT_MAILCOM_BASE_URL ? legacy : '')
      || DEFAULT_XIAOPINGGUO_BASE_URL,
  ).replace(/\/+$/, '');
  const remoteApi = String(
    mail.mailcomBaseUrl
      || mail.fastmailBaseUrl
      || (['mailcom', 'fastmail'].includes(String(mail.provider || '').toLowerCase()) && legacy !== DEFAULT_XIAOPINGGUO_BASE_URL ? legacy : '')
      || DEFAULT_MAILCOM_BASE_URL,
  ).replace(/\/+$/, '');
  const icloud = String(
    mail.icloudBaseUrl
      || (String(mail.provider || '').toLowerCase() === 'icloud' && legacy !== DEFAULT_XIAOPINGGUO_BASE_URL ? legacy : '')
      || DEFAULT_MAILCOM_BASE_URL,
  ).replace(/\/+$/, '');
  if (provider === 'mailcom' || provider === 'fastmail') return remoteApi;
  if (provider === 'icloud') return icloud;
  return xiaopingguo;
}

type MailAliasSettings = {
  aliasBatchSize: number;
  aliasDomainMode: 'random' | 'selected';
  aliasDomains: string[];
};

function normalizeMailAliasDomains(value: unknown) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || '').trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean))];
}

function mailAliasSettings(draft: Record<string, any>, provider: 'mailcom' | 'fastmail'): MailAliasSettings {
  const mail = draft?.mail || {};
  const providerSettings = mail.providerSettings && typeof mail.providerSettings === 'object' && !Array.isArray(mail.providerSettings)
    ? mail.providerSettings
    : {};
  const hasProviderSettings = Object.prototype.hasOwnProperty.call(providerSettings, provider);
  const configured = providerSettings[provider] && typeof providerSettings[provider] === 'object'
    ? providerSettings[provider]
    : {};
  const activeProvider = String(mail.provider || '').toLowerCase();
  // The flat fields predate the separate Fastmail pool and therefore belong
  // to Mail.com only. A provider-only switch must not make Fastmail inherit
  // Mail.com's batch size or domain whitelist before its own block exists.
  const legacy = !hasProviderSettings && provider === 'mailcom' && activeProvider === provider ? mail : {};
  const fallbackBatchSize = defaultAliasBatchSize(provider);
  const parsedBatchSize = Number(configured.aliasBatchSize ?? legacy.aliasBatchSize ?? fallbackBatchSize);
  return {
    aliasBatchSize: Number.isInteger(parsedBatchSize) && parsedBatchSize > 0 ? parsedBatchSize : fallbackBatchSize,
    aliasDomainMode: String(configured.aliasDomainMode ?? legacy.aliasDomainMode ?? 'random').toLowerCase() === 'selected' ? 'selected' : 'random',
    aliasDomains: normalizeMailAliasDomains(configured.aliasDomains ?? legacy.aliasDomains),
  };
}

function mailChannel(id?: string) {
  const channelId = id === 'fastmail' ? 'mailcom' : id;
  return MAIL_CHANNELS.find((channel) => channel.id === channelId) || MAIL_CHANNELS[0];
}

/** The plan payload only carries the three fields the runner signs in with. */
function credentialAccounts(entries: CredentialEntry[]) {
  return entries.map(({ email, password, totpSecret }) => ({ email, password, totpSecret }));
}

/** One second tick, shared by every TOTP cell so they stay in step. */
function useSecondTick() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return now;
}

/**
 * The code an authenticator would show right now, with the window it belongs to.
 *
 * Computing it here is the cheapest possible proof that a pasted secret is the
 * real one — a typo shows up before the run starts rather than as an MFA
 * rejection three requests into a proxied login.
 */
function TotpCell({ secret, now }: { secret: string; now: number }) {
  const [code, setCode] = useState('••••••');
  const window30 = Math.floor(now / 30_000);
  useEffect(() => {
    let live = true;
    totpCode(secret, now).then((value) => { if (live && value) setCode(value); });
    return () => { live = false; };
    // Recomputed once per 30s window, not once per tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [secret, window30]);
  return (
    <div className="credential-totp">
      <span className="credential-code">{code}</span>
      <span className="credential-window" aria-hidden="true"><i style={{ width: `${totpRemaining(now) * 100}%` }} /></span>
    </div>
  );
}

/** Paste order is preserved so a rejected line can be found in the textarea. */
function CredentialLedger({ entries, rejected, onRemove }: {
  entries: CredentialEntry[];
  rejected: CredentialRejection[];
  onRemove: (line: number) => void;
}) {
  const now = useSecondTick();
  const rows = useMemo(() => [
    ...entries.map((entry) => ({ line: entry.line, entry, rejection: null as CredentialRejection | null })),
    ...rejected.map((rejection) => ({ line: rejection.line, entry: null as CredentialEntry | null, rejection })),
  ].sort((left, right) => left.line - right.line), [entries, rejected]);

  if (!rows.length) {
    return <div className="credential-empty">粘贴凭据后在这里逐行核对</div>;
  }
  return (
    <div className="credential-table-wrap">
      <table className="credential-table">
        <thead><tr><th>邮箱</th><th>密码</th><th>TOTP</th><th>状态</th><th aria-label="移除" /></tr></thead>
        <tbody>
          {rows.map(({ line, entry, rejection }) => (
            <tr key={line} className={entry ? '' : 'invalid'}>
              <td className="credential-email">{entry ? entry.email : rejection?.input}</td>
              <td className="mono">{entry ? maskSecret(entry.password, 1) : '—'}</td>
              <td>{entry ? <TotpCell secret={entry.totpSecret} now={now} /> : <span className="mono">—</span>}</td>
              <td>{entry
                ? <span className="credential-pill ok">就绪</span>
                : <span className="credential-pill bad">{rejection?.reason}</span>}</td>
              <td><button type="button" className="credential-remove" title={`移除第 ${line} 行`} onClick={() => onRemove(line)}><Trash2 size={14} /></button></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The email-mode twin of CredentialLedger: each address shows the login-state it resolved to. */
function SessionEmailLedger({ emails, rejected, matched, unmatched, resolving, errored, onRemove }: {
  emails: EmailEntry[];
  rejected: CredentialRejection[];
  matched: SessionAssetResolveMatch[];
  unmatched: string[];
  resolving: boolean;
  errored: boolean;
  onRemove: (line: number) => void;
}) {
  const matchByEmail = useMemo(() => {
    const map = new Map<string, SessionAssetResolveMatch>();
    for (const item of matched) map.set(item.email, item);
    return map;
  }, [matched]);
  const unmatchedSet = useMemo(() => new Set(unmatched), [unmatched]);
  const rows = useMemo(() => [
    ...emails.map((entry) => ({ line: entry.line, email: entry.email, rejection: null as CredentialRejection | null })),
    ...rejected.map((rejection) => ({ line: rejection.line, email: null as string | null, rejection })),
  ].sort((left, right) => left.line - right.line), [emails, rejected]);

  if (!rows.length) {
    return <div className="credential-empty">每行粘贴一个已保存登录态的邮箱，自动匹配</div>;
  }
  return (
    <div className="credential-table-wrap">
      <table className="credential-table">
        <thead><tr><th>邮箱</th><th>登录态资产</th><th>状态</th><th aria-label="移除" /></tr></thead>
        <tbody>
          {rows.map(({ line, email, rejection }) => {
            const match = email ? matchByEmail.get(email) : undefined;
            const missing = email ? unmatchedSet.has(email) : false;
            return (
              <tr key={line} className={email && match && !match.inUse && match.hasAccessToken ? '' : 'invalid'}>
                <td className="credential-email">{email || rejection?.input}</td>
                <td className="mono">{match ? `${match.assetId.slice(0, 8)}…` : '—'}</td>
                <td>{rejection
                  ? <span className="credential-pill bad">{rejection.reason}</span>
                  : match
                    ? (match.inUse
                      ? <span className="credential-pill bad">占用中</span>
                      : match.hasAccessToken
                        ? <span className="credential-pill ok">登录态就绪</span>
                        : <span className="credential-pill bad">无有效令牌</span>)
                    : missing
                      ? <span className="credential-pill bad">未匹配</span>
                      : errored
                        ? <span className="credential-pill bad">匹配失败</span>
                        : <span className="credential-pill">{resolving ? '匹配中…' : '待匹配'}</span>}</td>
                <td><button type="button" className="credential-remove" title={`移除第 ${line} 行`} onClick={() => onRemove(line)}><Trash2 size={14} /></button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Where a master import is reported once its dialog is out of the way.
 *
 * Nine remote aliases per master is tens of seconds of work, and it used to run
 * inside the import request — so the dialog spun, blocked, and the operator had
 * nothing to look at but a spinner. The batch now runs behind the request and
 * says where it is here, on the page they were going to anyway.
 */
const MAILCOM_IMPORT_CARD_LINGER_MS = 20_000;

function MailcomImportProgressCard({ progress }: { progress?: MailcomImportProgress }) {
  // The server keeps the last batch forever so a late poll can still read it,
  // which meant the card never left: a finished import went on squeezing the
  // column for the rest of the session, and came back on every reload. It is
  // only interesting while it runs and for a moment after, so it retires
  // itself. Keyed on `finishedAt` rather than a mount timer, so reopening the
  // page well after the fact does not restart the countdown.
  const finishedAt = progress?.finishedAt || '';
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    setDismissed(false);
    if (!finishedAt) return undefined;
    const finished = Date.parse(finishedAt);
    const remaining = Number.isFinite(finished)
      ? MAILCOM_IMPORT_CARD_LINGER_MS - (Date.now() - finished)
      : MAILCOM_IMPORT_CARD_LINGER_MS;
    if (remaining <= 0) {
      setDismissed(true);
      return undefined;
    }
    const timer = setTimeout(() => setDismissed(true), remaining);
    return () => clearTimeout(timer);
  }, [finishedAt]);

  if (!progress || progress.status === 'idle' || dismissed) return null;
  const total = Math.max(1, Number(progress.total || 0));
  const processed = Math.min(Number(progress.processed || 0), total);
  const percent = Math.round((processed / total) * 100);
  const running = progress.status === 'running';
  const failures = progress.failures || [];
  return <section className={`workspace-band mailcom-import-progress mailcom-import-${progress.status}`}>
    <div className="section-heading">
      <div>
        <span className="eyebrow">MAIL API</span>
        <h2>{running ? '正在导入主账号' : progress.status === 'failed' ? '主账号导入失败' : '主账号导入完成'}</h2>
        <p>{running
          ? `正在为 ${progress.current || '…'} 建别名`
          : `新增 ${progress.added ?? 0} 个主账号 · 建了 ${progress.aliasesCreated ?? 0} 个别名${progress.duplicates ? ` · ${progress.duplicates} 个重复已跳过` : ''}`}</p>
      </div>
      <div className="mailcom-progress-meta">
        <span className="market-checked">{processed}/{total}</span>
        {!running && <button type="button" className="mailcom-progress-close" onClick={() => setDismissed(true)} aria-label="关闭导入结果"><X size={14} /></button>}
      </div>
    </div>
    <div className="mailcom-progress-track" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
      <div className="mailcom-progress-fill" style={{ width: `${running ? Math.max(percent, 4) : 100}%` }} />
    </div>
    {progress.error && <small className="mailcom-progress-error">{progress.error}</small>}
    {failures.length > 0 && <ul className="mailcom-progress-failures">
      {failures.slice(0, 4).map((failure) => <li key={`${failure.email}-${failure.message}`}><strong>{failure.email}</strong><span>{failure.message}</span></li>)}
      {failures.length > 4 && <li><span>另有 {failures.length - 4} 条失败</span></li>}
    </ul>}
    {progress.invalidLines?.length ? <small className="mailcom-progress-error">第 {progress.invalidLines.slice(0, 8).join('、')} 行格式不对，已跳过</small> : null}
  </section>;
}

function IcloudImportProgressCard({ progress }: { progress?: MailcomImportProgress }) {
  const finishedAt = progress?.finishedAt || '';
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    setDismissed(false);
    if (!finishedAt) return undefined;
    const finished = Date.parse(finishedAt);
    const remaining = Number.isFinite(finished)
      ? MAILCOM_IMPORT_CARD_LINGER_MS - (Date.now() - finished)
      : MAILCOM_IMPORT_CARD_LINGER_MS;
    if (remaining <= 0) {
      setDismissed(true);
      return undefined;
    }
    const timer = setTimeout(() => setDismissed(true), remaining);
    return () => clearTimeout(timer);
  }, [finishedAt]);

  if (!progress || progress.status === 'idle' || dismissed) return null;
  const total = Math.max(1, Number(progress.total || 0));
  const processed = Math.min(Number(progress.processed || 0), total);
  const percent = Math.round((processed / total) * 100);
  const running = progress.status === 'running';
  const failures = progress.failures || [];
  return <section className={`workspace-band mailcom-import-progress mailcom-import-${progress.status}`}>
    <div className="section-heading">
      <div>
        <span className="eyebrow">ICLOUD</span>
        <h2>{running ? 'Importing iCloud mailboxes' : progress.status === 'failed' ? 'iCloud import failed' : 'iCloud import complete'}</h2>
        <p>{running
          ? `Processing ${progress.current || 'mailbox'}`
          : `Added ${progress.added ?? 0} mailbox(es)${progress.duplicates ? `; ${progress.duplicates} duplicate(s)` : ''}`}</p>
      </div>
      <div className="mailcom-progress-meta">
        <span className="market-checked">{processed}/{total}</span>
        {!running && <button type="button" className="mailcom-progress-close" onClick={() => setDismissed(true)} aria-label="Dismiss import result"><X size={14} /></button>}
      </div>
    </div>
    <div className="mailcom-progress-track" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
      <div className="mailcom-progress-fill" style={{ width: `${running ? Math.max(percent, 4) : 100}%` }} />
    </div>
    {progress.error && <small className="mailcom-progress-error">{progress.error}</small>}
    {failures.length > 0 && <ul className="mailcom-progress-failures">
      {failures.slice(0, 4).map((failure) => <li key={`${failure.email}-${failure.message}`}><strong>{failure.email}</strong><span>{failure.message}</span></li>)}
      {failures.length > 4 && <li><span>{failures.length - 4} more failures</span></li>}
    </ul>}
    {progress.invalidLines?.length ? <small className="mailcom-progress-error">Invalid lines: {progress.invalidLines.slice(0, 8).join(', ')}</small> : null}
  </section>;
}

function MailcomConfigDialog({
  open,
  onOpenChange,
  provider,
  onProviderChange,
  draft,
  updateConfig,
  onEndpointChange,
  importText,
  onImportTextChange,
  status,
  statusError,
  configNotice,
  domainOptions,
  importing,
  importProgress,
  saving,
  onSave,
  onImport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  provider: string;
  onProviderChange: (provider: 'mailcom' | 'fastmail') => void;
  draft: Record<string, any>;
  updateConfig: (path: string, value: unknown) => void;
  onEndpointChange: (value: string) => void;
  importText: string;
  onImportTextChange: (value: string) => void;
  status?: { summary?: Record<string, number> };
  statusError?: unknown;
  configNotice?: { tone: string; text: string } | null;
  domainOptions?: MailcomAliasDomains;
  importing: boolean;
  importProgress?: MailcomImportProgress;
  saving: boolean;
  onSave: (provider: 'mailcom' | 'fastmail') => void;
  onImport: () => void;
}) {
  const providerId = provider === 'fastmail' ? 'fastmail' : 'mailcom';
  const endpoint = mailEndpointForProvider(draft, providerId);
  const aliasSettings = mailAliasSettings(draft, providerId);
  const summary = status?.summary || {};
  const statusText = statusError === undefined || statusError === null ? '' : errorMessage(statusError);
  const domainCatalogMatchesProvider = providerId === 'mailcom'
    ? (!domainOptions?.provider || domainOptions.provider === 'mailcom')
    : domainOptions?.provider === 'fastmail';
  const running = importProgress?.status === 'running';
  const percent = running
    ? Math.round((Math.min(Number(importProgress?.processed || 0), Math.max(1, Number(importProgress?.total || 0))) / Math.max(1, Number(importProgress?.total || 0))) * 100)
    : 0;
  const selectedDomains = aliasSettings.aliasDomains;
  const availableDomains: string[] = domainCatalogMatchesProvider && domainOptions?.domains?.length
    ? domainOptions.domains
    : [];
  const [domainQuery, setDomainQuery] = useState('');
  const aliasDomainMode = aliasSettings.aliasDomainMode;
  const aliasBatchLabel = providerId === 'fastmail' ? 'Fastmail 补池批次' : 'Mail.com 每个主账号别名数';
  const domainModeLabel = providerId === 'fastmail' ? 'Fastmail 别名域名策略' : 'Mail.com 别名域名策略';
  const domainLabel = providerId === 'fastmail' ? 'Fastmail 指定域名' : 'Mail.com 指定域名';
  const domainPlaceholder = providerId === 'fastmail' ? 'fastmail.com, fastmail.org' : 'torontomail.com, swissmail.com';
  const updateAliasSetting = (key: keyof MailAliasSettings, value: unknown) => updateConfig(
    `mail.providerSettings.${providerId}`,
    { ...aliasSettings, [key]: key === 'aliasDomains' ? normalizeMailAliasDomains(value) : value },
  );
  const showDomainPicker = aliasDomainMode === 'selected' && availableDomains.length > 0;
  const saveFeedback = configNotice?.text || '';
  const feedbackTone = configNotice?.tone || 'info';
  // 搜索候选域名——但已勾选的永远不隐藏，否则搜索会让"已选但未匹配"的域名看起来像被取消了。
  const normalizedDomainQuery = domainQuery.trim().toLowerCase();
  const visibleDomains = normalizedDomainQuery
    ? availableDomains.filter((domain) => domain.includes(normalizedDomainQuery) || selectedDomains.includes(domain))
    : availableDomains;
  const toggleDomain = (domain: string) => {
    const next = new Set(selectedDomains);
    if (next.has(domain)) next.delete(domain); else next.add(domain);
    updateAliasSetting('aliasDomains', [...next]);
  };
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="dialog-content dialog-wide mailcom-dialog">
        <Dialog.Title>Mail API 配置</Dialog.Title>
        <Dialog.Description>{providerId === 'fastmail'
          ? '统一接口当前使用 Fastmail 独立邮箱池；补池批次默认 1，域名目录只来自 Fastmail。'
          : '统一接口当前使用 Mail.com 独立邮箱池；别名批次和域名策略只作用于 Mail.com。'}</Dialog.Description>
        <div className="mailcom-provider-switch segmented" role="radiogroup" aria-label="Mail API 邮箱商">
          {[
            ['mailcom', 'Mail.com'],
            ['fastmail', 'Fastmail'],
          ].map(([id, name]) => <button
            type="button"
            role="radio"
            aria-checked={providerId === id}
            className={providerId === id ? 'selected' : ''}
            key={id}
            onClick={() => onProviderChange(id as 'mailcom' | 'fastmail')}
          >{name}</button>)}
        </div>
        <div className="mailcom-config-grid">
          <label><span>统一 API 地址</span><input value={endpoint} onChange={(event) => onEndpointChange(event.target.value)} /></label>
          <label><span>{aliasBatchLabel}</span><ConfigNumberInput min={1} max={100} value={aliasSettings.aliasBatchSize} onValueChange={(value) => updateAliasSetting('aliasBatchSize', value)} /></label>
          <label><span>{domainModeLabel}</span><AppSelect ariaLabel={domainModeLabel} value={aliasDomainMode} onValueChange={(value) => updateAliasSetting('aliasDomainMode', value)} options={[{ value: 'random', label: '随机可用域名' }, { value: 'selected', label: '仅使用指定域名' }]} /></label>
          <label><span>{domainLabel}</span><input value={selectedDomains.join(', ')} placeholder={domainPlaceholder} onChange={(event) => updateAliasSetting('aliasDomains', event.target.value.split(',').map((value) => value.trim()).filter(Boolean))} /></label>
        </div>
        {showDomainPicker && <div className="mailcom-domain-picker" role="group" aria-label="可用别名域名">
          <span>可用域名</span>
          <div className="mailcom-domain-picker-body">
            <input
              className="mailcom-domain-search"
              type="search"
              value={domainQuery}
              placeholder={`搜索 ${availableDomains.length} 个域名…`}
              aria-label="搜索可用别名域名"
              onChange={(event) => setDomainQuery(event.target.value)}
            />
            <div className="mailcom-domain-list">
              {visibleDomains.length
                ? visibleDomains.map((domain) => <label className="mailcom-domain-chip" data-selected={selectedDomains.includes(domain) || undefined} key={domain}><input type="checkbox" checked={selectedDomains.includes(domain)} onChange={() => toggleDomain(domain)} /><span>{domain}</span></label>)
                : <span className="mailcom-domain-empty">没有匹配 “{domainQuery.trim()}” 的域名</span>}
            </div>
          </div>
        </div>}
        <div className="mailcom-pool-strip">
          <span><strong>{summary.masters ?? '—'}</strong> 主账号</span>
          <span><strong>{summary.mailboxes ?? '—'}</strong> 可用地址总量</span>
          <span><strong>{summary.available ?? '—'}</strong> 可领取</span>
          <span><strong>{summary.claim_pending ?? '—'}</strong> 已领取待注册</span>
          <span><strong>{summary.registration_started ?? '—'}</strong> 注册中</span>
          <span><strong>{summary.consumed ?? '—'}</strong> 已注册已消费</span>
          {statusText && <em>{statusText}</em>}
        </div>
        <section className="mailcom-import-box">
          <div className="mailcom-import-heading"><div><strong>导入主账号</strong><small>每行一条：邮箱----密码</small></div><span>自动建别名</span></div>
          <textarea
            className="mailcom-import-input"
            rows={8}
            spellCheck={false}
            placeholder={'master@example.com----password\nnext@example.com----password'}
            value={importText}
            onChange={(event) => onImportTextChange(event.target.value)}
          />
        </section>
        {running && <div className="mailcom-dialog-progress">
          <div className="mailcom-progress-track" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
            <div className="mailcom-progress-fill" style={{ width: `${Math.max(percent, 4)}%` }} />
          </div>
          <small>后台正在建别名 {importProgress?.processed ?? 0}/{importProgress?.total ?? 0}{importProgress?.current ? ` · ${importProgress.current}` : ''}，关掉这个弹窗也会继续，进度在启动页</small>
        </div>}
        <div className="mailcom-dialog-footer">
          {saveFeedback && <div className={`mailcom-dialog-feedback mailcom-dialog-feedback-${feedbackTone}`} role={feedbackTone === 'danger' ? 'alert' : 'status'}>
            {feedbackTone === 'success' ? <Check size={15} aria-hidden="true" /> : <AlertTriangle size={15} aria-hidden="true" />}
            <span>{saveFeedback}</span>
          </div>}
          <div className="dialog-actions mailcom-dialog-actions">
            <Dialog.Close asChild><Button tone="quiet">关闭</Button></Dialog.Close>
            <Button onClick={() => onSave(providerId)} disabled={saving} icon={saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}>保存配置并切换</Button>
            {/* Only the hand-off is awaited. Once the batch is accepted the button
                goes live again instead of spinning for the whole remote build. */}
            <Button tone="primary" onClick={onImport} disabled={importing || running || !importText.trim()} icon={importing || running ? <LoaderCircle className="spin" size={15} /> : <Upload size={15} />}>{importing ? '提交中' : running ? '后台进行中' : '导入并建别名'}</Button>
          </div>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

function IcloudConfigDialog({
  open,
  onOpenChange,
  draft,
  onEndpointChange,
  importText,
  onImportTextChange,
  status,
  statusError,
  configNotice,
  importing,
  importProgress,
  saving,
  onSave,
  onImport,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  draft: Record<string, any>;
  onEndpointChange: (value: string) => void;
  importText: string;
  onImportTextChange: (value: string) => void;
  status?: { summary?: Record<string, number> };
  statusError?: unknown;
  configNotice?: { tone: string; text: string } | null;
  importing: boolean;
  importProgress?: MailcomImportProgress;
  saving: boolean;
  onSave: (provider: 'icloud') => void;
  onImport: () => void;
}) {
  const endpoint = mailEndpointForProvider(draft, 'icloud');
  const summary = status?.summary || {};
  const statusText = statusError === undefined || statusError === null ? '' : errorMessage(statusError);
  const running = importProgress?.status === 'running';
  const percent = running
    ? Math.round((Math.min(Number(importProgress?.processed || 0), Math.max(1, Number(importProgress?.total || 0))) / Math.max(1, Number(importProgress?.total || 0))) * 100)
    : 0;
  const saveFeedback = configNotice?.text || '';
  const feedbackTone = configNotice?.tone || 'info';
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="dialog-content dialog-wide mailcom-dialog">
        <Dialog.Title>iCloud mailbox API</Dialog.Title>
        <Dialog.Description>独立 iCloud 邮箱池。每个地址对应一个 WDMail URL，不创建别名。</Dialog.Description>
        <div className="mailcom-config-grid">
          <label><span>iCloud API address</span><input value={endpoint} onChange={(event) => onEndpointChange(event.target.value)} /></label>
        </div>
        <div className="mailcom-pool-strip">
          <span><strong>{summary.masters ?? '—'}</strong> mailboxes</span>
          <span><strong>{summary.available ?? '—'}</strong> available</span>
          <span><strong>{summary.claim_pending ?? '—'}</strong> claimed</span>
          <span><strong>{summary.registration_started ?? '—'}</strong> in registration</span>
          <span><strong>{summary.consumed ?? '—'}</strong> consumed</span>
          {statusText && <em>{statusText}</em>}
        </div>
        <section className="mailcom-import-box">
          <div className="mailcom-import-heading"><div><strong>Import iCloud mailboxes</strong><small>One line: email----WDMail URL</small></div><span>No aliases</span></div>
          <textarea
            className="mailcom-import-input"
            rows={8}
            spellCheck={false}
            placeholder={'icloud@example.com----https://api.wdmail.top/m?f=html&e=icloud@example.com:example-password'}
            value={importText}
            onChange={(event) => onImportTextChange(event.target.value)}
          />
        </section>
        {running && <div className="mailcom-dialog-progress">
          <div className="mailcom-progress-track" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
            <div className="mailcom-progress-fill" style={{ width: `${Math.max(percent, 4)}%` }} />
          </div>
          <small>Importing {importProgress?.processed ?? 0}/{importProgress?.total ?? 0}{importProgress?.current ? ` · ${importProgress.current}` : ''}</small>
        </div>}
        <div className="mailcom-dialog-footer">
          {saveFeedback && <div className={`mailcom-dialog-feedback mailcom-dialog-feedback-${feedbackTone}`} role={feedbackTone === 'danger' ? 'alert' : 'status'}>
            {feedbackTone === 'success' ? <Check size={15} aria-hidden="true" /> : <AlertTriangle size={15} aria-hidden="true" />}
            <span>{saveFeedback}</span>
          </div>}
          <div className="dialog-actions mailcom-dialog-actions">
            <Dialog.Close asChild><Button tone="quiet">Close</Button></Dialog.Close>
            <Button onClick={() => onSave('icloud')} disabled={saving} icon={saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />}>Save iCloud config</Button>
            <Button tone="primary" onClick={onImport} disabled={importing || running || !importText.trim()} icon={importing || running ? <LoaderCircle className="spin" size={15} /> : <Upload size={15} />}>{importing ? 'Submitting' : running ? 'Importing' : 'Import mailboxes'}</Button>
          </div>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

function SmsMailboxSettingsDialog({
  open,
  onOpenChange,
  plan,
  normalMailCount,
  onApply,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  plan: RunPlan;
  normalMailCount: number;
  onApply: (patch: Partial<RunPlan>) => void;
}) {
  const [tab, setTab] = useState('rental');
  useEffect(() => { if (open) setTab('rental'); }, [open]);
  const [draft, setDraft] = useState({
    mailRentalWatch: plan.mailRentalWatch === true,
    mailRentalTarget: plan.mailRentalTarget || 200,
    mailRentalBatchSize: plan.mailRentalBatchSize || 20,
    mailRentalPollIntervalMs: plan.mailRentalPollIntervalMs || 20_000,
  });
  useEffect(() => {
    if (!open) return;
    setDraft({
      mailRentalWatch: plan.mailRentalWatch === true,
      mailRentalTarget: plan.mailRentalTarget || 200,
      mailRentalBatchSize: plan.mailRentalBatchSize || 20,
      mailRentalPollIntervalMs: plan.mailRentalPollIntervalMs || 20_000,
    });
  }, [open, plan]);
  const watch = draft.mailRentalWatch;
  const target = Math.max(1, Math.min(MAX_MAIL_RENTAL_TARGET, Number(draft.mailRentalTarget || 200)));
  const batchSize = Math.max(1, Math.min(20, Number(draft.mailRentalBatchSize || 20)));
  const pollIntervalMs = Math.max(MIN_MAIL_RENTAL_POLL_INTERVAL_SECONDS * 1000, Math.min(3_600_000, Number(draft.mailRentalPollIntervalMs || 20_000)));
  const apply = () => {
    const patch: Partial<RunPlan> = {
      mailProvider: 'smsbower',
      ...(watch ? { mailCount: target } : { mailCount: normalMailCount }),
      mailRentalWatch: watch,
      mailRentalTarget: watch ? target : undefined,
      mailRentalBatchSize: watch ? batchSize : undefined,
      mailRentalPollIntervalMs: watch ? pollIntervalMs : undefined,
    };
    onApply(patch);
    onOpenChange(false);
  };
  const modeLabel = watch ? '挂租模式' : '普通租约';
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="dialog-content sms-mail-settings-dialog">
        <Dialog.Title>SMSBower Gmail 设置</Dialog.Title>
        <Dialog.Description>选择邮箱租约模式，或配置并测试邮箱接口。</Dialog.Description>
        <Tabs.Root value={tab} onValueChange={setTab}>
        <Tabs.List className="tabs-list" aria-label="SMSBower Gmail 设置页签">
          <Tabs.Trigger value="rental">租约</Tabs.Trigger>
          <Tabs.Trigger value="api">接口配置</Tabs.Trigger>
        </Tabs.List>
        <Tabs.Content value="rental" forceMount hidden={tab !== 'rental'} className="sms-mail-tab">
        <div className="sms-mail-current-mode" aria-live="polite"><span>当前模式</span><strong>{modeLabel}</strong></div>
        <div className="mail-rental-mode" role="radiogroup" aria-label="邮箱租约模式">
          <button type="button" role="radio" aria-checked={!watch} className={!watch ? 'selected' : ''} onClick={() => setDraft((current) => ({ ...current, mailRentalWatch: false }))}>
            <strong>普通租约</strong><small>按任务缺口租用，库存不足时等待</small>
          </button>
          <button type="button" role="radio" aria-checked={watch} className={watch ? 'selected' : ''} onClick={() => setDraft((current) => ({ ...current, mailRentalWatch: true }))}>
            <strong>挂租模式</strong><small>统一轮询、统一租约，再分配给 Worker</small>
          </button>
        </div>
        {watch ? <>
          <div className="sms-mail-settings-grid">
            <label><span>挂租总量</span><ConfigNumberInput min={1} max={MAX_MAIL_RENTAL_TARGET} value={target} onValueChange={(value) => setDraft((current) => ({ ...current, mailRentalTarget: value }))} /></label>
            <label><span>单批领取数量</span><ConfigNumberInput min={1} max={20} value={batchSize} onValueChange={(value) => setDraft((current) => ({ ...current, mailRentalBatchSize: value }))} /></label>
            <label><span>库存轮询间隔（秒）</span><ConfigNumberInput min={MIN_MAIL_RENTAL_POLL_INTERVAL_SECONDS} max={3600} value={Math.round(pollIntervalMs / 1000)} onValueChange={(value) => setDraft((current) => ({ ...current, mailRentalPollIntervalMs: value * 1000 }))} /></label>
          </div>
          <div className="mail-rental-settings-note">挂租模式每次最多领取 20 个；达到总量或手动停止后不再领取，已领取邮箱继续完成注册和清理。</div>
        </> : <div className="mail-rental-original-note">普通租约沿用任务页的根邮箱数量，不在这里额外配置。</div>}
        <div className="dialog-actions">
          <Dialog.Close asChild><Button tone="quiet">取消</Button></Dialog.Close>
          <Button tone="primary" icon={<Save size={15} />} onClick={apply}>应用配置</Button>
        </div>
        </Tabs.Content>
        <Tabs.Content value="api" forceMount hidden={tab !== 'api'} className="sms-mail-tab"><SmsbowerMailConfig /></Tabs.Content>
        </Tabs.Root>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

/** The launch page's two task slots, with the auxiliary lane fixed at three. */
function TaskSlotBoard({ capacity, holders }: {
  capacity?: TaskCapacitySnapshot | null;
  holders: RunSummary[];
}) {
  const bySlot = (slot: 'main' | 'auxiliary') => holders.filter((run) => runTaskSlot(run) === slot);
  return <section className="task-slot-board" aria-label="任务位">
    {(['main', 'auxiliary'] as const).map((slot) => {
      const snapshot = capacity?.[slot];
      const used = snapshot ? snapshot.running + snapshot.starting : bySlot(slot).length;
      const total = slot === 'auxiliary' ? AUXILIARY_TASK_CAPACITY : (snapshot?.capacity ?? 1);
      const full = snapshot ? snapshot.available <= 0 : used >= total;
      const runs = bySlot(slot);
      return <div className={`task-slot-card${full ? ' is-full' : ''}`} key={slot}>
        <div className="task-slot-card-head">
          <strong>{TASK_SLOT_LABELS[slot]}</strong>
          <em>{used}/{total}</em>
        </div>
        <p className="task-slot-card-purpose">{TASK_SLOT_PURPOSE[slot]}</p>
        <div className="task-slot-card-runs">
          {runs.length ? runs.map((run) => <Link className="task-slot-run" to={`/run/${run.runId}`} key={run.runId}>
            <StatusBadge status={run.status} label={runStatusLabel(run.status)} />
            <span>{taskKindLabel(run.taskKind || run.plan?.taskKind, run.plan)}</span>
            {/* A holder that is not executing is the one to act on: it is why
                the launch button below is disabled. */}
            {!run.active && <em>占用中</em>}
          </Link>) : <span className="task-slot-empty">空闲</span>}
        </div>
      </div>;
    })}
  </section>;
}

function DashboardPage() {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [planNotice, setPlanNotice] = useState<{ tone: string; text: string } | null>(null);
  const [configNotice, setConfigNotice] = useState<{ tone: string; text: string } | null>(null);
  const [plan, setPlan] = useState<RunPlan>(() => runPlanFromConfig({}));
  const normalMailCountRef = useRef(1);
  const [draft, setDraft] = useState<Record<string, any>>({});
  const [jsonText, setJsonText] = useState('{}');
  const [mailPassword, setMailPassword] = useState('');
  const [mailcomImportText, setMailcomImportText] = useState('');
  const [icloudImportText, setIcloudImportText] = useState('');
  const [mailApiDialogOpen, setMailApiDialogOpen] = useState(false);
  const [mailApiDialogProvider, setMailApiDialogProvider] = useState<'mailcom' | 'fastmail'>('mailcom');
  const [icloudDialogOpen, setIcloudDialogOpen] = useState(false);
  const [smsDialogOpen, setSmsDialogOpen] = useState(false);
  const [smsDialogProvider, setSmsDialogProvider] = useState<'smsbower' | 'firefox' | 'hero-sms'>('smsbower');
  const [smsMailDialogOpen, setSmsMailDialogOpen] = useState(false);
  // Seeded from the CPA page's sub2api rail when it hands over a list of
  // addresses to re-login. Read once on mount: it is a handoff, not state the
  // launch page owns, and leaving it behind would refill the box on every
  // later visit.
  const [credentialText, setCredentialText] = useState(takeReloginEmails);
  const handedOffEmails = useRef(Boolean(credentialText));
  // Default to the ceiling; the derivation below clamps it to the number of
  // matched accounts, so fewer accounts fall back to that count automatically.
  const [oauthWorkerConcurrency, setOauthWorkerConcurrency] = useState(MAX_WORKER_CONCURRENCY);
  const credentialInput = useMemo(() => parseCredentialInput(credentialText), [credentialText]);
  // Auto-detected: a bare address (no `----`) turns the whole paste into an
  // email list that resolves to saved login-state; triples stay credentials.
  const credentialMode = useMemo(() => detectCredentialSourceMode(credentialText), [credentialText]);
  const emailInput = useMemo(() => parseEmailInput(credentialText), [credentialText]);
  const emailKey = useMemo(
    () => emailInput.emails.map((entry) => entry.email).slice().sort().join('\n'),
    [emailInput.emails],
  );
  const emailResolve = useQuery({
    queryKey: ['session-asset-resolve', emailKey],
    queryFn: () => endpoints.resolveSessionAssetEmails(emailKey ? emailKey.split('\n') : []),
    enabled: credentialMode === 'emails' && emailInput.emails.length > 0,
    staleTime: 10_000,
    retry: 1,
  });
  const emailResolveError = credentialMode === 'emails' && emailInput.emails.length > 0 && emailResolve.isError
    ? errorMessage(emailResolve.error)
    : '';
  const emailMatched = credentialMode === 'emails' ? (emailResolve.data?.matched || []) : [];
  const emailUnmatched = credentialMode === 'emails' ? (emailResolve.data?.unmatched || []) : [];
  const planInitialized = useRef(false);
  const runs = useRunsQuery();
  const serviceSummary = useQuery({
    queryKey: ['services', smsDialogProvider],
    queryFn: () => endpoints.services(smsDialogProvider),
    staleTime: 15_000,
  });
  const resourceBoard = useQuery({
    queryKey: ['resource-board', plan.mailProvider, smsDialogProvider],
    queryFn: () => endpoints.resourceSummary(plan.mailProvider || 'xiaopingguo', smsDialogProvider),
    staleTime: 65000, retry: false, refetchOnWindowFocus: false,
  });
  const config = useQuery({ queryKey: ['config'], queryFn: endpoints.config });
  const smsMarket = useQuery({
    queryKey: ['sms-market', smsDialogProvider],
    queryFn: () => endpoints.smsMarket(smsDialogProvider),
    enabled: smsDialogProvider === 'smsbower' && Boolean(config.data),
    retry: false,
    staleTime: 15_000,
  });
  // Polled from the page, not the dialog: the whole point is that the operator
  // can close the dialog and watch the bar on the launch page instead.
  const mailcomImport = useQuery({
    queryKey: ['mailcom-import'],
    queryFn: endpoints.mailcomImportProgress,
    retry: false,
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 1200 : false),
  });
  const mailcomImportStatus = mailcomImport.data?.status;
  useEffect(() => {
    // A finished batch changed the pool, and every count the launch panel draws
    // comes from those two queries.
    if (mailcomImportStatus !== 'complete' && mailcomImportStatus !== 'failed') return;
    client.invalidateQueries({ queryKey: ['mailcom-status'] });
    client.invalidateQueries({ queryKey: ['resources'] });
  }, [mailcomImportStatus, client]);
  const icloudImport = useQuery({
    queryKey: ['icloud-import'],
    queryFn: endpoints.icloudImportProgress,
    retry: false,
    refetchInterval: (query) => (query.state.data?.status === 'running' ? 1200 : false),
  });
  const icloudImportStatus = icloudImport.data?.status;
  useEffect(() => {
    if (icloudImportStatus !== 'complete' && icloudImportStatus !== 'failed') return;
    client.invalidateQueries({ queryKey: ['icloud-status'] });
    client.invalidateQueries({ queryKey: ['resources'] });
  }, [icloudImportStatus, client]);
  const mailcomStatus = useQuery({
    queryKey: ['mailcom-status', mailApiDialogProvider],
    queryFn: () => endpoints.mailcomStatus(mailApiDialogProvider),
    enabled: mailApiDialogOpen,
    retry: false,
    refetchInterval: 15_000,
  });
  const mailcomDomains = useQuery({
    queryKey: ['mailcom-domains', mailApiDialogProvider],
    queryFn: () => endpoints.mailcomDomains(mailApiDialogProvider),
    enabled: mailApiDialogOpen,
    retry: false,
    staleTime: 60_000,
  });
  const icloudStatus = useQuery({
    queryKey: ['icloud-status'],
    queryFn: endpoints.icloudStatus,
    enabled: icloudDialogOpen,
    retry: false,
    refetchInterval: 15_000,
  });
  const proxyCatalog = useQuery({ queryKey: ['proxies'], queryFn: endpoints.proxies });
  const sourceCount = plan.oauthSource?.kind === 'credentials'
      ? plan.oauthSource.accounts.length
      : plan.oauthSource?.kind === 'session_assets'
        ? plan.oauthSource.assetIds.length
        : plan.mailCount;
  const sourceReady = plan.taskKind !== 'oauth' || sourceCount > 0;
  // Both of these walk every entry of every country pool — thousands of items
  // on a full catalog — and both ran on every render of a page that re-renders
  // twice a second from the run poll. `preflightQueryKey` also stringifies the
  // whole plan, which React Query then hashes again on each render.
  const proxyAssignmentsReady = useMemo(
    () => proxyAssignmentsAreReady(plan.proxyAssignments, proxyCatalog.data),
    [plan.proxyAssignments, proxyCatalog.data],
  );
  const resourcesQueryKey = useMemo(() => preflightQueryKey(plan), [plan]);
  const resources = useQuery({
    queryKey: resourcesQueryKey,
    queryFn: () => endpoints.preflight(plan),
    enabled: planInitialized.current && Boolean(config.data && proxyCatalog.data) && sourceReady && proxyAssignmentsReady,
    refetchInterval: String(plan.mailProvider || '').toLowerCase() === 'smsbower' ? 20_000 : 60_000,
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    if (!config.data) return;
    setDraft(config.data.config);
    setJsonText(JSON.stringify(config.data.config, null, 2));
    if (!smsDialogOpen) {
      setSmsDialogProvider(config.data.config.sms?.provider === 'hero-sms' ? 'hero-sms' : config.data.config.sms?.provider === 'firefox' ? 'firefox' : 'smsbower');
    }
  }, [config.data]);
  useEffect(() => {
    if (!config.data) return;
    // The config is not the source of truth for the launch choice anymore:
    // restore the channel from the latest task once the runs query has made
    // its first attempt. A failed runs request still falls back to config.
    if (!planInitialized.current && proxyCatalog.data && (runs.data || runs.isError)) {
      planInitialized.current = true;
      setPlan(runPlanFromConfig(
        config.data.config,
        proxyCatalog.data,
        latestRunMailProvider(runs.data?.runs),
      ));
    }
  }, [config.data, proxyCatalog.data, runs.data, runs.isError]);
  useEffect(() => {
    if (plan.taskKind !== 'oauth' && plan.mailRentalWatch !== true) {
      normalMailCountRef.current = Math.min(MAX_MAIL_RENTAL_TARGET, Math.max(1, Number(plan.mailCount || 1)));
    }
  }, [plan.taskKind, plan.mailCount, plan.mailRentalWatch]);
  // Reachable from the plan that consumes the pools: an emptied country pool
  // is discovered while assigning workers, and walking to another page to
  // refill it only to walk back is the whole friction. The hook re-reads the
  // catalog when the robot finishes, which is what turns a refilled pool back
  // into a valid worker assignment without a reload.
  const pullAllProxies = useProxyRefreshRobot((run) => setPlanNotice(proxyRefreshNotice(run)));
  const start = useMutation({
    mutationFn: (nextPlan: RunPlan) => endpoints.startRun(nextPlan),
    onSuccess: (run) => { client.invalidateQueries({ queryKey: ['runs'] }); navigate(`/run/${run.runId}`); },
    onError: (error) => setPlanNotice({ tone: 'danger', text: errorMessage(error) }),
  });
  const preflight = useMutation({
    mutationFn: (nextPlan: RunPlan) => endpoints.preflight(nextPlan),
    onSuccess: (data, nextPlan) => {
      client.setQueryData(preflightQueryKey(nextPlan), data);
      const requestedMail = data.mail.requested ?? nextPlan.mailCount;
      const shortages = [
        !nextPlan.mailRentalWatch && data.mail.selected < requestedMail ? `账号来源 ${data.mail.selected}/${requestedMail}` : '',
        data.proxy.required && !data.proxy.ready
          ? `代理国家池为空 ${data.proxy.available}/${data.proxy.requiredCount ?? nextPlan.workerConcurrency}`
          : '',
        data.sms.required && !data.sms.ready ? (data.sms.message || '短信资源未就绪') : '',
      ].filter(Boolean);
      setPlanNotice({
        tone: data.ready ? 'success' : 'warning',
        text: data.ready ? '预检通过，可以启动任务' : (shortages.length ? `任务资源不足：${shortages.join(' · ')}` : '预检未就绪，请检查资源配置'),
      });
    },
    onError: (error) => setPlanNotice({ tone: 'danger', text: errorMessage(error) }),
  });
  // Everything holding a slot, executing or not — a paused task keeps its slot
  // and is the thing that has to be resolved before a new one can start.
  const slotHolders = slotHolderRuns(runs.data?.runs || [], new Set(runs.data?.activeRunIds || []));
  // Registration controls use the main task slot. Existing-account OAuth and
  // session refresh use the independent auxiliary capacity.
  const active = runs.data?.runs.find((run) => run.runId === runs.data?.activeRunId && !isAuxiliaryRun(run))
    || runs.data?.runs.find((run) => run.active && !isAuxiliaryRun(run));
  const auxiliaryAvailable = runs.data?.taskCapacity?.auxiliary
    ? runs.data.taskCapacity.auxiliary.available > 0
    : true;
  const mainCapacity = runs.data?.taskCapacity?.main;
  const mainAvailable = mainCapacity ? mainCapacity.available > 0 : true;
  // A slot can be held by a run that is not executing — a paused or waiting
  // task keeps its slot so it stays resumable. Without naming it, the launch
  // button is simply dead: nothing shows as running and nothing can start.
  const slotBlocker = (slot: 'main' | 'auxiliary') => (runs.data?.taskCapacity?.[slot]?.holders || [])
    .find((holder) => !holder.active);
  const mainBlocker = mainAvailable ? undefined : slotBlocker('main');
  const auxiliaryBlocker = auxiliaryAvailable ? undefined : slotBlocker('auxiliary');
  const blockerReason = (blocker: { runId: string; status: string } | undefined) => (blocker
    ? `${SLOT_HOLDER_LABELS[blocker.status] || blocker.status}的任务 ${blocker.runId} 仍占用任务位，恢复或取消它之后才能启动新任务`
    : '');
  const recent = runs.data?.runs.slice(0, 4) || [];
  const cfg = config.data?.config || {};
  const activeMailChannel = mailChannel(plan.mailProvider);
  // Empty when the switch is usable. The row is rendered either way — dropping
  // it on a channel change resized the column, which is what made the whole
  // left side jump as the operator switched providers.
  const aliasLockedReason = activeMailChannel.supportsAliases === true
    ? ''
    : (activeMailChannel.aliasLockedReason || '该邮箱接口不支持别名');
  const snapshot = resources.data;
  // A preflight snapshot belongs to the provider that produced it. Keep it
  // out of the SMS widgets after a provider switch so an old balance or quote
  // cannot mask the fresh service-summary response.
  const smsSnapshot = snapshot && String(snapshot.sms?.provider || '').toLowerCase() === smsDialogProvider
    ? snapshot
    : null;
  const refreshing = resourceBoard.isFetching || resources.isFetching || serviceSummary.isFetching || smsMarket.isFetching || preflight.isPending;
  const marketOffers = smsSnapshot?.sms.lowestOffers?.length
    ? smsSnapshot.sms.lowestOffers
    : (smsMarket.data?.lowestOffers || []);
  const marketCountry = smsSnapshot?.sms.country.chn || smsSnapshot?.sms.country.name || smsSnapshot?.sms.country.eng || smsSnapshot?.sms.country.id || smsMarket.data?.country?.name || smsMarket.data?.country?.id || '—';
  const marketService = smsSnapshot?.sms.service.name || smsSnapshot?.sms.service.code || smsMarket.data?.service?.name || smsMarket.data?.service?.code || '—';
  const activeSmsCurrency = smsCurrency(smsDialogProvider, smsSnapshot?.sms.currency || smsMarket.data?.currency || serviceSummary.data?.sms.currency);
  const updatePlan = (patch: Partial<RunPlan>) => {
    setPlanNotice(null);
    setPlan((current) => {
      const next = { ...current, ...patch };
      const taskKind = next.taskKind || 'register_session';
      const selectedCount = next.oauthSource?.kind === 'credentials'
          ? next.oauthSource.accounts.length
          : next.oauthSource?.kind === 'session_assets'
            ? next.oauthSource.assetIds.length
            : 0;
      const rentalWatch = taskKind !== 'oauth'
        && next.mailProvider === 'smsbower'
        && next.mailRentalWatch === true;
      if (Object.hasOwn(patch, 'mailCount') && rentalWatch && !Object.hasOwn(patch, 'mailRentalTarget')) {
        next.mailRentalTarget = patch.mailCount;
      }
      next.mailCount = taskKind === 'oauth'
        ? selectedCount
        : (rentalWatch
          ? Math.min(MAX_MAIL_RENTAL_TARGET, Math.max(1, Number(next.mailRentalTarget || next.mailCount || 200)))
          : Math.min(MAX_MAIL_RENTAL_TARGET, Math.max(1, Number(next.mailCount || 1))));
      // A rented mailbox closes with the run, so the account has to leave it
      // able to log in unaided. The server refuses any other combination; the
      // form applies it here so the operator never meets that error. Forcing
      // these one way and never restoring them is what used to leave the form
      // stuck with the security switches welded on after one visit here.
      const switchedChannel = patch.mailProvider !== undefined && patch.mailProvider !== current.mailProvider;
      const channel = mailChannel(next.mailProvider);
      if (switchedChannel && !channel.forces) {
        // Leaving a constrained channel restores the saved defaults rather than
        // stranding the operator with the previous channel's forced values.
        const restored = runPlanFromConfig(cfg, proxyCatalog.data, next.mailProvider);
        next.aliasEnabled = restored.aliasEnabled;
        next.security = restored.security;
        next.postRegistrationOAuth = restored.postRegistrationOAuth;
      }
      // Applied on every edit, not only on the switch, so no other control can
      // move a field this channel pins.
      Object.assign(next, channel.forces || {});
      if (channel.id !== 'smsbower') next.mailRentalWatch = false;
      const aliasesAllowed = channel.supportsAliases === true;
      // Switching onto a channel whose alias switch starts on turns it on;
      // the operator's own toggle afterwards is left alone.
      if (switchedChannel && channel.defaultAliasEnabled === true && !Object.hasOwn(patch, 'aliasEnabled')) {
        next.aliasEnabled = true;
      }
      if (!aliasesAllowed) next.aliasEnabled = false;
      next.aliasStrategy = aliasesAllowed && next.aliasEnabled ? 'root_plus' : 'root';
      next.aliasCount = next.aliasEnabled ? 2 : 1;
      next.aliasMaxAttempts = next.aliasCount;
      const requestedWorkers = Math.min(MAX_WORKER_CONCURRENCY, Math.max(1, Number(next.workerConcurrency || 1)));
      if (taskKind !== 'oauth' && Object.hasOwn(patch, 'workerConcurrency') && requestedWorkers > next.mailCount) {
        next.mailCount = requestedWorkers;
      }
      next.workerConcurrency = Math.min(next.mailCount, requestedWorkers);
      if (next.mailCount === 0) next.workerConcurrency = 1;
      next.proxyAssignments = resizeProxyAssignments((next.proxyAssignments || []).filter((p) => taskKind !== 'oauth' || p.kind !== 'maintenance'), next.workerConcurrency, proxyCatalog.data);
      if (taskKind === 'oauth' || !aliasesAllowed || next.aliasStrategy === 'root') {
        next.aliasStrategy = 'root';
        next.aliasCount = 1;
        next.aliasMaxAttempts = 1;
      } else {
        next.aliasCount = Math.max(1, Number(next.aliasCount || 1));
        next.aliasMaxAttempts = Math.max(next.aliasCount, Number(next.aliasMaxAttempts || next.aliasCount));
      }
      next.totalAccounts = taskKind === 'oauth' ? selectedCount : next.mailCount * next.aliasCount;
      if (next.mailProvider !== 'smsbower') {
        next.mailRentalTarget = undefined;
        next.mailRentalBatchSize = undefined;
        next.mailRentalPollIntervalMs = undefined;
      } else if (next.mailRentalWatch !== true) {
        next.mailRentalTarget = undefined;
        next.mailRentalBatchSize = undefined;
        next.mailRentalPollIntervalMs = undefined;
      } else {
        next.mailRentalTarget = Math.min(MAX_MAIL_RENTAL_TARGET, Math.max(1, Number(next.mailRentalTarget || 200)));
        next.mailRentalBatchSize = Math.min(20, Math.max(1, Number(next.mailRentalBatchSize || 20)));
        next.mailRentalPollIntervalMs = Math.max(MIN_MAIL_RENTAL_POLL_INTERVAL_SECONDS * 1000, Math.min(3_600_000, Number(next.mailRentalPollIntervalMs || 20_000)));
      }
      return next;
    });
  };
  const selectTaskKind = (taskKind: NonNullable<RunPlan['taskKind']>) => {
    const base = runPlanFromConfig(cfg, proxyCatalog.data);
    if (taskKind === 'register_session') {
      setPlan({ ...base, taskKind, schemaVersion: 3 });
      return;
    }
    const emailsMode = credentialMode === 'emails';
    const accounts = emailsMode ? [] : credentialAccounts(credentialInput.entries);
    const assetIds = emailsMode ? emailMatched.map((match) => match.assetId) : [];
    const count = emailsMode ? assetIds.length : accounts.length;
    const requestedWorkers = Math.max(1, Math.min(MAX_WORKER_CONCURRENCY, oauthWorkerConcurrency));
    const workerConcurrency = Math.max(1, Math.min(count || 1, requestedWorkers));
    setPlan({
      ...base,
      taskKind: 'oauth',
      schemaVersion: 3,
      mailCount: count,
      workerConcurrency,
      aliasStrategy: 'root',
      aliasCount: 1,
      aliasMaxAttempts: 1,
      totalAccounts: count,
      oauthSource: emailsMode
        ? { kind: 'session_assets', assetIds }
        : { kind: 'credentials', accounts },
      postRegistrationOAuth: false,
      security: { setPassword: false, enrollTotp: false },
      proxyAssignments: resizeProxyAssignments(plan.proxyAssignments.filter((p) => p.kind !== 'maintenance'), workerConcurrency, proxyCatalog.data),
    });
  };
  // Text only. The OAuth source is derived from the paste by an effect below,
  // because the email → login-state lookup is async.
  const updateCredentialText = (value: string) => setCredentialText(value);
  /** Drops one parsed row by rewriting the source text, so the two stay in step. */
  const removeCredentialLine = (line: number) => {
    const lines = credentialText.split(/\r?\n/);
    lines.splice(line - 1, 1);
    updateCredentialText(lines.join('\n'));
  };
  const updateOAuthWorkerConcurrency = (value: number) => {
    const requestedWorkers = Math.max(1, Math.min(MAX_WORKER_CONCURRENCY, value));
    setOauthWorkerConcurrency(requestedWorkers);
    updatePlan({ workerConcurrency: Math.min(sourceCount || 1, requestedWorkers) });
  };
  const updateConfig = (path: string, value: unknown) => setDraft((current) => {
    let next = setPath(current, path, value);
    if (path === 'sms.countries' && Array.isArray(value) && value.length) {
      next = setPath(next, 'sms.country', value[0]);
    }
    setJsonText(JSON.stringify(next, null, 2));
    setConfigNotice(null);
    return next;
  });
  const buildMailProviderConfig = (input: Record<string, any>, provider: string) => {
    const endpoint = mailEndpointForProvider(input, provider);
    let next = setPath(input, 'mail.provider', provider);
    const remoteProvider = provider === 'fastmail' || provider === 'mailcom' ? provider : '';
    const currentProvider = String(input.mail?.provider || '').toLowerCase();
    if (remoteProvider) {
      const providerSettings = {
        ...(input.mail?.providerSettings && typeof input.mail.providerSettings === 'object' && !Array.isArray(input.mail.providerSettings)
          ? input.mail.providerSettings
          : {}),
        mailcom: mailAliasSettings(input, 'mailcom'),
        fastmail: mailAliasSettings(input, 'fastmail'),
      };
      // Materialize both sides when an old config is switched for the first
      // time. The legacy flat policy is copied only to the provider that was
      // active before the switch; the other pool keeps its own defaults.
      if (currentProvider !== 'mailcom' && currentProvider !== 'fastmail') {
        delete providerSettings.mailcom;
        delete providerSettings.fastmail;
        providerSettings[remoteProvider] = mailAliasSettings(input, remoteProvider);
      }
      next = setPath(next, 'mail.providerSettings', providerSettings);
    }
    if (provider === 'mailcom' || provider === 'fastmail') {
      // Mail.com and Fastmail share the HTTP endpoint, but the provider query
      // selects their independent pool on 8001.
      next = setPath(next, 'mail.mailcomBaseUrl', endpoint);
      next = setPath(next, 'mail.fastmailBaseUrl', endpoint);
    } else if (provider === 'icloud') {
      next = setPath(next, 'mail.icloudBaseUrl', endpoint);
    } else {
      next = setPath(next, 'mail.xiaopingguoBaseUrl', endpoint);
    }
    next = setPath(next, 'mail.baseUrl', endpoint);
    return next;
  };
  const switchMailProvider = (provider: string) => setDraft((current) => {
    const next = buildMailProviderConfig(current, provider);
    setJsonText(JSON.stringify(next, null, 2));
    setConfigNotice(null);
    return next;
  });
  const updateMailApiEndpoint = (value: string) => setDraft((current) => {
    let next = setPath(current, 'mail.baseUrl', value);
    next = setPath(next, 'mail.mailcomBaseUrl', value);
    next = setPath(next, 'mail.fastmailBaseUrl', value);
    setJsonText(JSON.stringify(next, null, 2));
    setConfigNotice(null);
    return next;
  });
  const updateIcloudEndpoint = (value: string) => setDraft((current) => {
    let next = setPath(current, 'mail.baseUrl', value);
    next = setPath(next, 'mail.icloudBaseUrl', value);
    setJsonText(JSON.stringify(next, null, 2));
    setConfigNotice(null);
    return next;
  });
  const buildSmsProviderConfig = (input: Record<string, any>, provider: 'smsbower' | 'firefox' | 'hero-sms') => {
    let next = setPath(input, 'sms.provider', provider);
    if (provider === 'firefox') {
      next = setPath(next, 'sms.firefox.iid', '1096');
      next = setPath(next, 'sms.firefox.countryMode', 'cheapest');
    } else {
      if (next.sms?.maxPrice === undefined || next.sms?.maxPrice === null || next.sms?.maxPrice === '') next = setPath(next, 'sms.maxPrice', 0.03);
      if (!next.sms?.service) next = setPath(next, 'sms.service', { code: 'dr' });
      if (!next.sms?.country) next = setPath(next, 'sms.country', { id: 151, name: 'Chile' });
      if (!Array.isArray(next.sms?.countries) || !next.sms.countries.length) next = setPath(next, 'sms.countries', [next.sms.country]);
      if (Array.isArray(next.sms?.countries) && next.sms.countries.length) next = setPath(next, 'sms.country', next.sms.countries[0]);
    }
    return next;
  };
  const selectMailApiProvider = (provider: 'mailcom' | 'fastmail') => setMailApiDialogProvider(provider);
  const configSavePayload = (switchProvider?: 'mailcom' | 'fastmail' | 'icloud', switchSmsProvider?: 'smsbower' | 'firefox' | 'hero-sms') => {
    let parsed: Record<string, any>;
    try { parsed = JSON.parse(jsonText); } catch { throw new Error('高级 JSON 不是有效格式'); }
    if (switchProvider) parsed = buildMailProviderConfig(parsed, switchProvider);
    if (switchSmsProvider) parsed = buildSmsProviderConfig(parsed, switchSmsProvider);
    const secretPatch: Record<string, string> = {};
    if (mailPassword) secretPatch.mailPassword = mailPassword;
    return { config: parsed, secretPatch };
  };
  const saveConfig = useMutation({
    mutationFn: (variables?: { switchProvider?: 'mailcom' | 'fastmail' | 'icloud'; switchSmsProvider?: 'smsbower' | 'firefox' | 'hero-sms' }) => endpoints.saveConfig(configSavePayload(variables?.switchProvider, variables?.switchSmsProvider)),
    onSuccess: (data, variables) => {
      setMailPassword('');
      setConfigNotice({
        tone: 'success',
        text: variables?.switchProvider
          ? `配置已保存，当前任务已切换到 ${variables.switchProvider === 'fastmail' ? 'Fastmail' : (variables.switchProvider === 'icloud' ? 'iCloud' : 'Mail.com')}`
          : '配置已保存',
      });
      client.setQueryData(['config'], data);
      if (variables?.switchProvider) {
        updatePlan({ mailProvider: variables.switchProvider });
        if (variables.switchProvider === 'mailcom' || variables.switchProvider === 'fastmail') {
          setMailApiDialogProvider(variables.switchProvider);
        }
      }
      if (variables?.switchSmsProvider) {
        setSmsDialogProvider(variables.switchSmsProvider);
      }
      client.invalidateQueries({ queryKey: ['services'] });
      client.invalidateQueries({ queryKey: ['resources'] });
    },
    onError: (error) => setConfigNotice({ tone: 'danger', text: errorMessage(error) }),
  });
  const importMailcom = useMutation({
    mutationFn: async ({ content, provider }: { content: string; provider: 'mailcom' | 'fastmail' }) => {
      // Persist the staged endpoint/provider first so the server-side import
      // call uses exactly what the operator just selected.
      const saved = await endpoints.saveConfig(configSavePayload());
      client.setQueryData(['config'], saved);
      return endpoints.importMailcomMasters(content, provider);
    },
    onSuccess: (job) => {
      // The dialog stays open and keeps what was typed: the batch is only
      // *accepted* here, and closing the thing that reported it would throw the
      // input away before the operator knows whether the lines parsed.
      setConfigNotice({
        tone: 'success',
        text: `已接受 ${job.total ?? 0} 个主账号，正在后台建别名，可关闭弹窗在启动页看进度`,
      });
      client.setQueryData(['mailcom-import'], job);
      client.invalidateQueries({ queryKey: ['mailcom-import'] });
    },
    onError: (error) => setConfigNotice({ tone: 'danger', text: errorMessage(error) }),
  });
  const importIcloud = useMutation({
    mutationFn: async (content: string) => {
      // Persist the staged iCloud endpoint, then use the dedicated mailbox
      // route. This path never invokes the Mail.com/Fastmail alias importer.
      const saved = await endpoints.saveConfig(configSavePayload());
      client.setQueryData(['config'], saved);
      return endpoints.importIcloudMailboxes(content);
    },
    onSuccess: (job) => {
      setConfigNotice({
        tone: 'success',
        text: `Accepted ${job.total ?? 0} iCloud mailbox(es); importing in the background`,
      });
      client.setQueryData(['icloud-import'], job);
      client.invalidateQueries({ queryKey: ['icloud-import'] });
    },
    onError: (error) => setConfigNotice({ tone: 'danger', text: errorMessage(error) }),
  });
  const validateConfig = useMutation({
    mutationFn: () => endpoints.validateConfig(JSON.parse(jsonText)),
    onSuccess: () => setConfigNotice({ tone: 'success', text: '配置校验通过' }),
    onError: (error) => setConfigNotice({ tone: 'danger', text: errorMessage(error) }),
  });
  const configActions = <div className="launch-config-actions"><Button icon={<ShieldCheck size={16} />} onClick={() => validateConfig.mutate()} disabled={validateConfig.isPending}>校验</Button><Button tone="primary" icon={<Save size={16} />} onClick={() => saveConfig.mutate({})} disabled={saveConfig.isPending}>{saveConfig.isPending ? '保存中' : '保存'}</Button></div>;
  const smsConfigAction = <Button icon={<Settings2 size={16} />} onClick={() => setSmsDialogOpen(true)}>短信配置</Button>;
  const editJson = (value: string) => {
    setJsonText(value);
    setConfigNotice(null);
    try { setDraft(JSON.parse(value)); } catch { /* Keep editing invalid JSON. */ }
  };
  const taskKind = plan.taskKind || 'register_session';
  const mailRentalWatch = taskKind !== 'oauth' && plan.mailProvider === 'smsbower' && plan.mailRentalWatch === true;
  const planValid = Number.isInteger(plan.mailCount) && plan.mailCount >= 1 && plan.mailCount <= MAX_MAIL_RENTAL_TARGET
    && Number.isInteger(plan.workerConcurrency) && plan.workerConcurrency >= 1 && plan.workerConcurrency <= MAX_WORKER_CONCURRENCY
    && plan.workerConcurrency <= plan.mailCount
    && (plan.aliasStrategy === 'root' || (
      Number.isInteger(plan.aliasCount) && plan.aliasCount >= 1 && plan.aliasCount <= 6
      && Number.isInteger(plan.aliasMaxAttempts) && plan.aliasMaxAttempts >= plan.aliasCount && plan.aliasMaxAttempts <= 8
    ))
    && Boolean(plan.aliasRunTag.trim())
    && plan.proxyAssignments.length === plan.workerConcurrency
    && new Set(plan.proxyAssignments.map((assignment) => assignment.workerSlot)).size === plan.workerConcurrency
    && (() => {
      const localIds = plan.proxyAssignments.flatMap((assignment) => assignment.kind === 'local' ? [assignment.localProxyId] : []);
      return new Set(localIds).size === localIds.length;
    })()
    && proxyAssignmentsReady
    && (!mailRentalWatch || (
      plan.mailRentalTarget === plan.mailCount
      && Number.isInteger(plan.mailRentalBatchSize) && Number(plan.mailRentalBatchSize || 0) >= 1 && Number(plan.mailRentalBatchSize || 0) <= 20
      && Number.isInteger(plan.mailRentalPollIntervalMs) && Number(plan.mailRentalPollIntervalMs || 0) >= MIN_MAIL_RENTAL_POLL_INTERVAL_SECONDS * 1000
    ))
    && (plan.taskKind !== 'oauth' || (plan.oauthSource?.kind === 'credentials' && plan.oauthSource.accounts.length > 0)
      || (plan.oauthSource?.kind === 'session_assets' && plan.oauthSource.assetIds.length > 0));
  // Keep the plan's OAuth source in step with the pasted text: email lines
  // resolve to saved login-state (`session_assets`), triples stay credential
  // logins. In an effect because the resolve is async and can land later.
  useEffect(() => {
    if (taskKind !== 'oauth') return;
    if (credentialMode === 'emails') {
      const assetIds = emailMatched.map((match) => match.assetId);
      updatePlan({
        oauthSource: { kind: 'session_assets', assetIds },
        workerConcurrency: Math.min(assetIds.length || 1, oauthWorkerConcurrency),
      });
    } else {
      const accounts = credentialAccounts(credentialInput.entries);
      updatePlan({
        oauthSource: { kind: 'credentials', accounts },
        workerConcurrency: Math.min(accounts.length || 1, oauthWorkerConcurrency),
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskKind, credentialMode, credentialText, emailResolve.data, oauthWorkerConcurrency]);
  // A handoff arrives with the addresses but no task kind, and the effect above
  // only fills in the source once the kind is `oauth`. Waits for the config to
  // land because the plan is rebuilt from it, and fires once: after this the
  // operator owns the choice, including switching away from it.
  useEffect(() => {
    if (!handedOffEmails.current) return;
    if (!planInitialized.current || !config.data || !proxyCatalog.data) return;
    handedOffEmails.current = false;
    selectTaskKind('oauth');
    setPlanNotice({ tone: 'info', text: '已填入 sub2api 的错误账号邮箱，按登录态直登 OAuth 起任务' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.data, proxyCatalog.data]);
  const planControlsReady = planInitialized.current && Boolean(config.data && proxyCatalog.data);
  const startingRegistrationOnly = start.isPending && start.variables?.postRegistrationOAuth !== true;
  const startingRegistrationOAuth = start.isPending && start.variables?.postRegistrationOAuth === true;
  const startingLoginOnly = start.isPending && start.variables?.oauthSource?.loginOnly === true;
  const startingSourceOAuth = start.isPending && start.variables?.oauthSource?.loginOnly !== true;
  const waitingForOAuthSource = taskKind === 'oauth' && !sourceReady;
  const smsPreflightChecked = smsSnapshot ? smsSnapshot.sms.checked !== false : false;
  // A completed preflight is newer and uses the same provider snapshot as the
  // launch decision. Do not let the slower service-summary cache overwrite it.
  const preflightSmsBalance = smsSnapshot?.sms.balance ?? null;
  const smsBalance = preflightSmsBalance ?? serviceSummary.data?.sms.balance;
  const smsBalanceHint = preflightSmsBalance !== null
    ? `预检同步 · 可支撑 ${smsSnapshot?.sms.availableConcurrency ?? '—'} 个并发`
    : serviceSummary.data?.sms.message
      || serviceSummary.data?.sms.name
      || smsDialogProvider
      || '正在读取短信供应商';
  const preflightDisabledReason = !sourceReady
    ? '请先填写或选择邮箱 OTP 账号'
    : (!proxyAssignmentsReady ? '请先为每个 Worker 选择可用代理' : (!planValid ? '当前任务参数尚未完整' : ''));
  const rentalMail = plan.mailProvider === 'smsbower';
  const mailcomMail = plan.mailProvider === 'mailcom' || plan.mailProvider === 'fastmail';
  // "Available root mailboxes" is the wrong noun for a rental: the number is
  // the provider's stock, not a pool this run holds.
  const mailMetricLabel = taskKind === 'oauth'
    ? '可读邮箱'
    : (rentalMail ? '可租邮箱库存' : (mailcomMail ? '可用 API 邮箱' : '可用根邮箱'));
  const sourcePrompt = '请粘贴账号凭据，或每行一个已保存登录态的邮箱';
  const pendingChecks: PreflightCheck[] = !snapshot && (!sourceReady || !proxyAssignmentsReady) ? [
    { id: 'mail', label: 'Account source', required: true, checked: true, ready: sourceReady, detail: sourceReady ? `${taskKind === 'oauth' ? sourceCount : plan.mailCount} 个账号来源` : sourcePrompt },
    { id: 'proxy', label: 'Worker proxies', required: true, checked: true, ready: proxyAssignmentsReady, detail: proxyAssignmentsReady ? `${plan.workerConcurrency} 个 Worker 已分配` : `Worker 已增加到 ${plan.workerConcurrency}，请补齐代理` },
    { id: 'sms', label: 'SMS market', required: plan.postRegistrationOAuth === true, checked: false, ready: false, detail: plan.postRegistrationOAuth === true ? (sourceReady && proxyAssignmentsReady ? '等待自动检查' : '账号来源和代理就绪后自动检查') : '实际出现手机验证时按需检查' },
  ] : [];
  const preflightChecks = snapshot?.checks?.filter((check) => check.id !== 'sms' || Boolean(smsSnapshot)) || pendingChecks;
  const mailMetricHint = snapshot
    ? (mailRentalWatch
      ? `当前库存 ${snapshot.mail.eligible ?? 0} · 挂租目标 ${plan.mailRentalTarget ?? plan.mailCount}`
      : `本次可用 ${snapshot.mail.selected}/${snapshot.mail.requested ?? plan.mailCount}`)
    : (waitingForOAuthSource ? sourcePrompt : (taskKind === 'oauth' ? `本次已选 ${sourceCount} 个` : (rentalMail ? '正在查询 SMSBower 库存' : (mailcomMail ? '正在读取 Mail API 池' : '正在读取小苹果'))));
  const mailStockError = Boolean(rentalMail && snapshot?.mail.stockStatus === 'error');
  const mailStockErrorMessage = String(snapshot?.mail.stockError?.message || '').trim();
  const mailStockValue = waitingForOAuthSource
    ? '待选择'
    : (mailStockError ? '更新中' : (snapshot?.mail.eligible ?? (rentalMail ? resourceBoard.data?.mail?.stock : null) ?? '—'));
  const mailStockHint = mailStockError
    ? `库存查询失败，正在重试${mailStockErrorMessage ? `：${mailStockErrorMessage}` : ''}`
    : mailMetricHint;
  const mailPriceValue = waitingForOAuthSource
    ? '待选择'
    : (mailStockError ? '更新中' : formatUsd(snapshot?.mail.unitPrice ?? resourceBoard.data?.mail?.unitPrice, 3));
  const mailPriceHint = mailStockError
    ? `邮箱库存/价格查询失败，正在重试${mailStockErrorMessage ? `：${mailStockErrorMessage}` : ''}`
    : (snapshot?.mail.unitPrice !== undefined
      ? `上限 ${formatUsd(snapshot?.mail.maxPrice, 3)} · 库存 ${snapshot?.mail.eligible ?? '—'}`
      : '正在查询 SMSBower 报价');

  const updateWorkerProxy = (workerSlot: number, kind: ProxyAssignment['kind'], id = '') => {
    // Only the two resource-backed kinds are set per Worker; `maintenance` is a
    // bulk choice with no id and is applied through its own assignment builder.
    if (!id || (kind !== 'local' && kind !== 'countryPool')) return;
    const assignment: ProxyAssignment = kind === 'local'
      ? { workerSlot, kind: 'local', localProxyId: id }
      : { workerSlot, kind: 'countryPool', countryCode: id };
    updatePlan({
      proxyAssignments: plan.proxyAssignments.map((current) => current.workerSlot === workerSlot ? assignment : current),
    });
  };
  // 仅登录: the same sign-in as the OAuth launch, stopping once the login state
  // is saved. The flag rides on the source so the panel's plan stays one plan.
  const launchSourceTask = (loginOnly: boolean) => {
    if (!plan.oauthSource) return;
    const nextPlan: RunPlan = { ...plan, oauthSource: { ...plan.oauthSource, loginOnly } };
    setPlanNotice(null);
    setPlan(nextPlan);
    start.mutate(nextPlan);
  };
  const launchRegistration = (postRegistrationOAuth: boolean) => {
    const nextPlan = { ...plan, postRegistrationOAuth };
    setPlanNotice(null);
    setPlan(nextPlan);
    start.mutate(nextPlan);
  };
  // The OAuth leg turns a login state into a product someone else signs into,
  // and the password and the TOTP secret are the only credentials that outlive
  // the run — the mailbox closes with it and the cookies expire. The server
  // refuses such a plan outright; saying so on the button costs nothing and
  // saves a launch that fails on submit. 仅注册 stays open: a login state
  // without TOTP is thin, not broken, and 登录态资产 can finish it later.
  const oauthSecurityMissing = [
    plan.security?.setPassword === true ? '' : '随机密码',
    plan.security?.enrollTotp === true ? '' : 'TOTP',
  ].filter(Boolean);
  // Picking a pool per Worker is fine at 3 lanes and miserable at 20, so the
  // two shapes that are actually wanted get one control each.
  const assignAllToPool = (countryCode: string) => {
    if (!countryCode) return;
    updatePlan({ proxyAssignments: countryPoolAssignments(plan.workerConcurrency, countryCode) });
  };
  const assignBalancedPools = () => {
    const balanced = balancedPoolAssignments(plan.workerConcurrency, proxyCatalog.data);
    if (!balanced.length) {
      setPlanNotice({ tone: 'warning', text: '没有任何国家池有可用出口，先去代理页拉取' });
      return;
    }
    updatePlan({ proxyAssignments: balanced });
  };
  const bulkPoolOptions = useMemo(() => (proxyCatalog.data?.dynamic?.countryPools || [])
    .filter((pool) => pool.total > 0)
    .map((pool) => ({ value: pool.countryCode, label: `${pool.countryCode} · ${pool.total} 个出口` })), [proxyCatalog.data]);
  const hasAnyProxyResources = Boolean(proxyCatalog.data?.total);
  const singlePoolSelection = useMemo(() => {
    const codes = new Set(plan.proxyAssignments.flatMap((a) => a.kind === 'countryPool' ? [a.countryCode] : []));
    return codes.size === 1 && plan.proxyAssignments.every((a) => a.kind === 'countryPool') ? [...codes][0] : '';
  }, [plan.proxyAssignments]);
  // Hoisted out of the row loop below, where each of up to twenty rows rebuilt
  // them from the same two arrays — quadratic in Worker count, and re-filtering
  // the whole catalog once per row.
  const localProxyCatalog = useMemo(
    () => proxyCatalog.data?.local?.proxies || proxyCatalog.data?.proxies || [],
    [proxyCatalog.data],
  );
  const localIdsByWorkerSlot = useMemo(() => {
    const byId = new Map<number, string>();
    for (const assignment of plan.proxyAssignments) {
      if (assignment.kind === 'local') byId.set(assignment.workerSlot, assignment.localProxyId);
    }
    return byId;
  }, [plan.proxyAssignments]);
  const countryPoolCatalog = useMemo(
    () => proxyCatalog.data?.dynamic?.countryPools || [],
    [proxyCatalog.data],
  );

  const selectWorkerProxyKind = (workerSlot: number, kind: ProxyAssignment['kind']) => {
    if (kind === 'local') {
      const used = new Set(plan.proxyAssignments.flatMap((assignment) => assignment.kind === 'local' && assignment.workerSlot !== workerSlot ? [assignment.localProxyId] : []));
      const candidate = (proxyCatalog.data?.local?.proxies || proxyCatalog.data?.proxies || []).find((proxy) => !used.has(proxy.id));
      if (candidate) updateWorkerProxy(workerSlot, 'local', candidate.id);
      return;
    }
    const pool = proxyCatalog.data?.dynamic?.countryPools?.find((candidate) => candidate.total > 0);
    if (pool) updateWorkerProxy(workerSlot, 'countryPool', pool.countryCode);
  };

  return <div className="launch-page">
    <div className="launch-page-head">
      <PageHeader title="启动工作台" description="本次任务配置、资源状态与运行结果" />
      <section className="launch-overview-board" aria-labelledby="launch-overview-title">
        {resources.error && <Notice tone="danger">资源摘要刷新失败：{errorMessage(resources.error)}</Notice>}
        <div className="launch-overview-heading"><div><span className="eyebrow">LIVE RESOURCE BOARD</span><h2 id="launch-overview-title">运行概览</h2></div><IconButton label="刷新资源" onClick={() => { resourceBoard.refetch(); serviceSummary.refetch(); if (sourceReady && proxyAssignmentsReady) resources.refetch(); }} disabled={refreshing}>{refreshing ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}</IconButton></div>
        <section className="metrics-grid launch-metrics">
          <Metric label={mailMetricLabel} value={mailStockValue} hint={mailStockHint} icon={<Archive size={21} />} />
          <Metric label="短信余额" value={formatCurrency(smsBalance, activeSmsCurrency)} hint={smsBalanceHint} icon={<Activity size={21} />} />
          <Metric label="邮箱余额" value={formatCurrency(resourceBoard.data?.mail?.balance, 'USD', 3)} hint={resourceBoard.data?.mail?.message || '正在读取邮箱账户'} icon={<Archive size={21} />} />
          {rentalMail && <Metric label="邮箱单价" value={mailPriceValue} hint={mailPriceHint} icon={<Gauge size={21} />} />}
          <Metric label="短信最低单价" value={formatCurrency(resourceBoard.data?.sms?.cheapestPrice, resourceBoard.data?.sms?.currency || activeSmsCurrency, 3)} hint={resourceBoard.data?.sms?.marketHint || '正在读取当前配置国家和服务的报价'} icon={<Gauge size={21} />} />
        </section>
         <TaskSlotBoard
           capacity={runs.data?.taskCapacity}
           holders={slotHolders}
         />
       </section>
    </div>
    <div className="launch-workspace">
      <aside className={`launch-config-column${taskKind === 'register_session' ? ' launch-register-column' : ''}`}>
        <div className="task-kind-bar" role="group" aria-label="任务类型">
          <button type="button" className={taskKind === 'register_session' ? 'selected' : ''} aria-pressed={taskKind === 'register_session'} disabled={!planControlsReady} onClick={() => selectTaskKind('register_session')}><UserRoundCheck size={16} /><span><strong>登录态注册</strong><small>保存会话，可继续 OAuth</small></span></button>
          <button type="button" className={taskKind === 'oauth' ? 'selected' : ''} aria-pressed={taskKind === 'oauth'} disabled={!planControlsReady} onClick={() => selectTaskKind('oauth')}><ShieldCheck size={16} /><span><strong>凭据直登 OAuth</strong><small>密码 + TOTP，不读邮箱</small></span></button>
        </div>
        <div className={`launch-action-bar${taskKind === 'register_session' || taskKind === 'oauth' ? ' launch-registration-actions' : ''}`}><div><strong>{taskKindLabel(taskKind, plan)}</strong><span>{taskKind === 'oauth' ? `${sourceCount} 个账号 · ${plan.workerConcurrency} Worker` : `${plan.mailCount} 根 · ${plan.workerConcurrency} Worker · 预计 ${plan.totalAccounts} 个账号`}</span></div>{smsConfigAction}<Button title={preflightDisabledReason || '按当前任务类型检查资源'} icon={preflight.isPending ? <LoaderCircle className="spin" size={16} /> : <Gauge size={16} />} onClick={() => preflight.mutate(plan)} disabled={!planValid || preflight.isPending || !config.data}>预检</Button>{taskKind === 'register_session' ? <><Button icon={startingRegistrationOnly ? <LoaderCircle className="spin" size={16} /> : <UserRoundCheck size={16} />} onClick={() => launchRegistration(false)} disabled={!planValid || start.isPending || Boolean(active) || !mainAvailable || !config.data || activeMailChannel.requiresOAuthInRun === true} title={blockerReason(mainBlocker) || (activeMailChannel.requiresOAuthInRun ? `${activeMailChannel.name} 会随任务结束关闭，必须在同一次任务里跑完 OAuth` : '')}>{startingRegistrationOnly ? '启动中' : (mailRentalWatch ? '启动挂租' : '仅注册')}</Button><Button tone="primary" icon={startingRegistrationOAuth ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />} onClick={() => launchRegistration(true)} disabled={!planValid || start.isPending || Boolean(active) || !mainAvailable || !config.data || oauthSecurityMissing.length > 0} title={oauthSecurityMissing.length ? `注册后 OAuth 需要先开启${oauthSecurityMissing.join(' 和 ')}：邮箱和会话都会随任务结束失效，没有它们的账号再也登不回来` : blockerReason(mainBlocker)}>{startingRegistrationOAuth ? '启动中' : '注册后 OAuth'}</Button></> : <><Button icon={startingLoginOnly ? <LoaderCircle className="spin" size={16} /> : <UserRoundCheck size={16} />} onClick={() => launchSourceTask(true)} disabled={!planValid || start.isPending || !auxiliaryAvailable || !config.data} title={blockerReason(auxiliaryBlocker) || '只登录并保存登录态，不跑 OAuth、不产出 CPA'}>{startingLoginOnly ? '启动中' : '仅登录'}</Button><Button tone="primary" icon={startingSourceOAuth ? <LoaderCircle className="spin" size={16} /> : <KeyRound size={16} />} onClick={() => launchSourceTask(false)} disabled={!planValid || start.isPending || !auxiliaryAvailable || !config.data} title={blockerReason(auxiliaryBlocker)}>{startingSourceOAuth ? '启动中' : (credentialMode === 'emails' ? '启动登录态直登' : '启动凭据 OAuth')}</Button></>}</div>
        <Tabs.Root defaultValue="task" className="launch-config-tabs">
          <Tabs.List className="tabs-list"><Tabs.Trigger value="task">本次任务</Tabs.Trigger><Tabs.Trigger value="resources">全局资源</Tabs.Trigger><Tabs.Trigger value="advanced">高级 JSON</Tabs.Trigger></Tabs.List>
          <Tabs.Content value="task" className={`launch-tab-content${taskKind !== 'oauth' ? ' launch-task-tab' : ''}`}>
             {!config.data ? <div className="loading-line"><LoaderCircle className="spin" />正在读取任务默认值</div> : <>
             <div className="task-config-split">
             <div className="task-input-column">
             <div className="task-input-scroll">
             {planNotice && <Notice tone={planNotice.tone} floating onClose={() => setPlanNotice(null)} autoDismissToken={planNotice}>{planNotice.text}</Notice>}
             {taskKind !== 'oauth' ? <div className="launch-form-stack">
               <section className="launch-form-section">
                <div className="launch-section-heading"><div><span>任务规模</span></div></div>
                <div className="run-plan-grid">
                 <Field label={mailRentalWatch ? '挂租总量' : '根邮箱数量（mail.count）'} hint={mailRentalWatch ? `统一 Broker 达到此数量后停止领取（最多 ${MAX_MAIL_RENTAL_TARGET}）` : `本任务独立值（最多 ${MAX_MAIL_RENTAL_TARGET}）`}><ConfigNumberInput min={1} max={MAX_MAIL_RENTAL_TARGET} value={plan.mailCount} onValueChange={(value) => updatePlan({ mailCount: value, ...(mailRentalWatch ? { mailRentalTarget: value } : {}) })} /></Field>
                 <Field label="Worker 并发" hint={`不超过根邮箱数量，最多 ${MAX_WORKER_CONCURRENCY}`}><ConfigNumberInput min={1} max={MAX_WORKER_CONCURRENCY} value={plan.workerConcurrency} onValueChange={(value) => updatePlan({ workerConcurrency: value })} /></Field>
                </div>
                <label className={`alias-toggle-row${aliasLockedReason ? ' locked' : ''}`}>
                 <span><strong>启用 Plus 别名</strong><small>{aliasLockedReason || '每个根邮箱再注册 1 个 +alias'}</small></span>
                 <Switch.Root aria-label="启用 Plus 别名" className="switch-root" disabled={Boolean(aliasLockedReason)} checked={plan.aliasEnabled === true} onCheckedChange={(checked) => updatePlan({ aliasEnabled: checked })}><Switch.Thumb className="switch-thumb" /></Switch.Root>
                </label>
               </section>
              {taskKind === 'register_session' && <section className="launch-form-section launch-security-section">
               <div className="launch-section-heading"><div><span>安全配置</span></div></div>
               <div className="session-security-options">
                <label><span>设置随机密码</span><Switch.Root className="switch-root" checked={plan.security?.setPassword === true} onCheckedChange={(checked) => updatePlan({ security: { setPassword: checked, enrollTotp: plan.security?.enrollTotp === true } })}><Switch.Thumb className="switch-thumb" /></Switch.Root></label>
                <label><span>启用 TOTP</span><Switch.Root className="switch-root" checked={plan.security?.enrollTotp === true} onCheckedChange={(checked) => updatePlan({ security: { setPassword: plan.security?.setPassword === true, enrollTotp: checked } })}><Switch.Thumb className="switch-thumb" /></Switch.Root></label>
               </div>
              </section>}
             </div> : <div className="credential-panel">
              <div className="credential-head">
                <div><strong>账号凭据</strong><small>{credentialMode === 'emails' ? '每行一个已保存登录态的邮箱，自动匹配资产、用已保存会话直接授权' : '已注册且已完成安全设置的账号，用密码 + TOTP 直接登录授权'}</small></div>
                <div className="credential-chips">
                  <span className="credential-chip">{credentialMode === 'emails' ? <><KeyRound size={14} />登录态直登</> : <><ShieldCheck size={14} />免邮箱验证</>}</span>
                  <span className="credential-chip neutral"><Radio size={14} />使用下方 Worker 所选代理</span>
                </div>
              </div>
              <div className="credential-split">
                <div className="credential-entry">
                  <textarea
                    className="credential-input"
                    aria-label="账号凭据"
                    spellCheck={false}
                    placeholder={'每行一个邮箱（自动匹配登录态）\n或 email----password----totpSecret'}
                    value={credentialText}
                    onChange={(event) => updateCredentialText(event.target.value)}
                  />
                  <div className="credential-hint">
                    {credentialMode === 'emails'
                      ? <>每行一个邮箱：自动在登录态资产库匹配，用已保存会话直接授权，无需密码 / TOTP。含 <code>----</code> 的行会切回凭据模式。</>
                      : <>分隔符 <code>----</code>，顺序为 邮箱 / 密码 / TOTP 密钥。与登录态资产页「导出凭据」格式一致，可直接回灌；只贴邮箱则自动走登录态直登。</>}
                  </div>
                </div>
                <div className="credential-ledger">
                  {credentialMode === 'emails'
                    ? <SessionEmailLedger emails={emailInput.emails} rejected={emailInput.rejected} matched={emailMatched} unmatched={emailUnmatched} resolving={emailResolve.isFetching} errored={Boolean(emailResolveError)} onRemove={removeCredentialLine} />
                    : <CredentialLedger entries={credentialInput.entries} rejected={credentialInput.rejected} onRemove={removeCredentialLine} />}
                  {credentialMode === 'emails' && emailResolveError && <div className="credential-resolve-error">
                    <span><AlertTriangle size={14} />匹配失败：{emailResolveError}。请确认已重启后端服务（<code>/session-assets/resolve</code> 为新接口）。</span>
                    <button type="button" onClick={() => emailResolve.refetch()} disabled={emailResolve.isFetching}>{emailResolve.isFetching ? '重试中…' : '重试'}</button>
                  </div>}
                  <div className="credential-footer">
                    <div className="credential-stats">
                      {credentialMode === 'emails'
                        ? <>
                            <span><strong>{emailMatched.length}</strong>条已匹配</span>
                            {emailUnmatched.length > 0 && <span className="negative"><strong>{emailUnmatched.length}</strong>条未匹配</span>}
                            {emailInput.rejected.length > 0 && <span className="negative"><strong>{emailInput.rejected.length}</strong>条无效</span>}
                          </>
                        : <>
                            <span><strong>{credentialInput.entries.length}</strong>条可用</span>
                            {credentialInput.rejected.length > 0 && <span className="negative"><strong>{credentialInput.rejected.length}</strong>条无效</span>}
                          </>}
                    </div>
                    <Field label="Worker 并发"><ConfigNumberInput min={1} max={MAX_WORKER_CONCURRENCY} title="实际并发不超过可用账号数" value={oauthWorkerConcurrency} onValueChange={updateOAuthWorkerConcurrency} /></Field>
                  </div>
                </div>
              </div>
              </div>}
              </div>
              {taskKind !== 'oauth' && <section className="launch-mail-channel-row">
                <div className="launch-section-heading"><div><span>邮箱接口模式</span></div></div>
                <div className="mail-channel-picker" role="radiogroup" aria-label="邮箱接口模式">
                  {MAIL_CHANNELS.map((channel) => {
                    const active = mailChannel(plan.mailProvider).id === channel.id;
                    return <button
                      type="button"
                      key={channel.id}
                      role="radio"
                      aria-checked={active}
                      className={`mail-channel${active ? ' selected' : ''}`}
                      title={channel.name}
                      onClick={() => {
                        if (channel.id === 'icloud') {
                          setIcloudDialogOpen(true);
                          return;
                        }
                        if (channel.id === 'mailcom') {
                          const currentProvider = plan.mailProvider === 'fastmail' || plan.mailProvider === 'mailcom'
                            ? plan.mailProvider
                            : (['mailcom', 'fastmail'].includes(String(draft.mail?.provider || '').toLowerCase())
                              ? String(draft.mail.provider).toLowerCase() as 'mailcom' | 'fastmail'
                              : 'mailcom');
                          selectMailApiProvider(currentProvider);
                          setMailApiDialogOpen(true);
                          return;
                        }
                        switchMailProvider(channel.id);
                        updatePlan({ mailProvider: channel.id });
                        if (channel.id === 'smsbower') setSmsMailDialogOpen(true);
                      }}
                    >
                      <span className="mail-channel-head"><strong>{channel.name}</strong><em>{channel.tag}</em></span>
                      <small>{channel.detail}</small>
                      {channel.id === 'smsbower' && <span className="mail-channel-mode" aria-label="当前租约模式">当前：{plan.mailRentalWatch === true ? '挂租模式' : '普通租约'}</span>}
                    </button>;
                  })}
                </div>
              </section>}
              </div>
              <div className="task-proxy-column">
            <div className="worker-proxy-plan">
              <div className="section-heading"><div><h2>Worker 代理</h2><p>本地端口固定绑定；国家池在启动前随机检测</p></div><div className="worker-proxy-heading-actions">
                <IconButton label={pullAllProxies.pending ? '正在刷新全部国家池' : '立即刷新全部国家池'} onClick={() => pullAllProxies.trigger.mutate()} disabled={pullAllProxies.pending}>{pullAllProxies.pending ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />}</IconButton>
                <IconLink to="/proxies" label="管理代理"><Network size={16} /></IconLink>
              </div></div>
              <div className="worker-proxy-bulk">
                <span>批量</span>
                <AppSelect
                  ariaLabel="全部 Worker 使用同一国家池"
                  value={singlePoolSelection}
                  onValueChange={assignAllToPool}
                  options={[{ value: '', label: '全部同一国家池…' }, ...bulkPoolOptions]}
                />
                <button type="button" title="按各池剩余出口数轮流分配，不把一个池抽干" onClick={assignBalancedPools} disabled={!bulkPoolOptions.length}>按容量均分</button>
              </div>
              <div className="worker-proxy-rows">
                {plan.proxyAssignments.map((assignment) => {
                  const usedLocal = new Set([...localIdsByWorkerSlot].flatMap(([slot, id]) => slot === assignment.workerSlot ? [] : [id]));
                  const localOptions = localProxyCatalog.filter((proxy) => !usedLocal.has(proxy.id) || (assignment.kind === 'local' && proxy.id === assignment.localProxyId));
                  const poolOptions = countryPoolCatalog.filter((pool) => pool.total > 0 || (assignment.kind === 'countryPool' && pool.countryCode === assignment.countryCode));
                  const selectedPool = assignment.kind === 'countryPool' ? poolOptions.find((pool) => pool.countryCode === assignment.countryCode) : null;
                  return <div className="worker-proxy-row" key={assignment.workerSlot}>
                    <div className="worker-proxy-identity"><span>{String(assignment.workerSlot).padStart(2, '0')}</span><div><strong>Worker {assignment.workerSlot}</strong><small>{assignment.kind === 'local' ? '固定资源' : '随机候选'}</small></div></div>
                    <div className="worker-proxy-kind" role="group" aria-label={`Worker ${assignment.workerSlot} 代理类型`}>
                      <button type="button" className={assignment.kind === 'local' ? 'selected' : ''} onClick={() => selectWorkerProxyKind(assignment.workerSlot, 'local')} disabled={assignment.kind !== 'local' && !localOptions.length}><Radio size={14} />本地端口</button>
                      <button type="button" className={assignment.kind === 'countryPool' ? 'selected' : ''} onClick={() => selectWorkerProxyKind(assignment.workerSlot, 'countryPool')} disabled={assignment.kind !== 'countryPool' && !poolOptions.some((pool) => pool.total > 0)}><Network size={14} />国家池</button>
                    </div>
                    <div className="worker-proxy-resource"><span>代理资源</span>{assignment.kind === 'local'
                      ? <AppSelect ariaLabel={`Worker ${assignment.workerSlot} 代理资源`} value={assignment.localProxyId} onValueChange={(value) => updateWorkerProxy(assignment.workerSlot, 'local', value)} options={localOptions.map((proxy) => ({ value: proxy.id, label: proxy.endpoint }))} />
                       : assignment.kind === 'countryPool'
                         ? <AppSelect ariaLabel={`Worker ${assignment.workerSlot} 代理资源`} value={assignment.countryCode} onValueChange={(value) => updateWorkerProxy(assignment.workerSlot, 'countryPool', value)} options={poolOptions.map((pool) => ({ value: pool.countryCode, label: `${pool.countryCode === 'GLOBAL' ? '全球池' : pool.countryCode} · ${pool.total} 条`, disabled: pool.total === 0 }))} />
                           /* Maintenance lanes come from the login-state page, never from this editor. */
                           : <span className="worker-proxy-fixed">配置的本机转发</span>}
                       <small>{assignment.kind === 'local' ? '仅当前 Worker 使用' : assignment.kind === 'maintenance' ? 'proxyPool.maintenanceProxy' : `${selectedPool?.total || 0} 条候选 · 绑定前健康检测`}</small>
                    </div>
                  </div>;
                })}
              </div>
              {!hasAnyProxyResources && <Notice tone="warning">没有可分配代理，请先进入代理页导入本地端口或拉取国家池。</Notice>}
               {hasAnyProxyResources && !proxyAssignmentsReady && <Notice tone="warning">Worker 代理分配无效。固定本地端口会优先保留，请检查已选国家池或试用池的剩余容量和重复地址。</Notice>}
             </div>
              </div>
              </div>
              </>}
          </Tabs.Content>
          <Tabs.Content value="resources" className="launch-tab-content">
            <div className="launch-tab-heading"><div><h2>全局资源</h2><p>所有任务共享的接口、凭据与链路设置</p></div>{configActions}</div>
            {configNotice && <Notice tone={configNotice.tone} floating onClose={() => setConfigNotice(null)} autoDismissToken={configNotice}>{configNotice.text}</Notice>}
            {config.isLoading ? <div className="loading-line"><LoaderCircle className="spin" />正在读取配置</div> : <div className="launch-resource-grid">
              <section className="config-section"><div className="config-title"><h2>邮箱</h2><p>小苹果接口与验证码筛选</p></div><div className="form-grid"><Field label="小苹果接口地址"><input value={draft.mail?.xiaopingguoBaseUrl || (draft.mail?.provider === 'xiaopingguo' ? draft.mail?.baseUrl : '') || DEFAULT_XIAOPINGGUO_BASE_URL} onChange={(event) => updateConfig('mail.xiaopingguoBaseUrl', event.target.value)} /></Field><Field label="邮箱密码" hint={config.data?.secrets.mailPasswordConfigured ? '已配置；留空保持' : '尚未配置'}><input type="password" value={mailPassword} placeholder={config.data?.secrets.mailPasswordConfigured ? '••••••••' : '输入密码'} onChange={(event) => setMailPassword(event.target.value)} /></Field><Field label="邮件关键词"><input value={draft.mail?.keyword || ''} onChange={(event) => updateConfig('mail.keyword', event.target.value)} /></Field><Field label="租用邮箱 service" hint="SMSBower 邮箱渠道用，短信那边同为 dr"><input placeholder="dr" value={draft.mail?.service ?? ''} onChange={(event) => updateConfig('mail.service', event.target.value)} /></Field><Field label="租用邮箱单价上限 (USD)" hint="SMSBower 邮箱渠道必填，超过则不启动"><ConfigNumberInput min={0} max={5} step={0.01} value={Number(draft.mail?.maxPrice ?? 0)} onValueChange={(value) => updateConfig('mail.maxPrice', value)} /></Field></div></section>
              <section className="config-section"><div className="config-title"><h2>短信</h2><p>供应商、密钥、参与国家与单价均在短信配置中管理</p></div><div className="form-grid"><Button onClick={() => setSmsDialogOpen(true)}>短信供应商配置</Button><Field label="替换号码预算"><ConfigNumberInput min={1} max={30} value={draft.sms?.replacementBudget ?? 20} onValueChange={(value) => updateConfig('sms.replacementBudget', value)} /></Field></div></section>
              <section className="config-section"><div className="config-title"><h2>代理</h2><p>Worker 必须绑定代理，启动任务时独立选择</p></div><div className="form-grid"><Field label="默认协议"><AppSelect ariaLabel="默认协议" value={draft.proxyPool?.defaultProtocol || 'http'} onValueChange={(value) => updateConfig('proxyPool.defaultProtocol', value)} options={[{ value: 'http', label: 'HTTP' }, { value: 'socks5', label: 'SOCKS5' }]} /></Field><Field label="检测目标"><input value={draft.proxyPool?.healthCheck?.probeUrl || ''} onChange={(event) => updateConfig('proxyPool.healthCheck.probeUrl', event.target.value)} /></Field><Field label="检测超时 ms" hint="超时即跳过该出口；若绑定成功率突然大跌，先排查本机网络再动这个值"><ConfigNumberInput min={1000} max={120000} step={500} value={Number(draft.proxyPool?.healthCheck?.timeoutMs ?? 8000)} onValueChange={(value) => updateConfig('proxyPool.healthCheck.timeoutMs', value)} /></Field><Field label="本机转发" hint="登录态刷新、补安全配置和 AT 测活使用；独立 OAuth 使用 Worker 所选代理"><input placeholder="http://127.0.0.1:7890" value={draft.proxyPool?.maintenanceProxy ?? ''} onChange={(event) => updateConfig('proxyPool.maintenanceProxy', event.target.value)} /></Field><div className="toggle-field"><div><span>健康检查</span><small>绑定 Worker 前检测</small></div><Switch.Root className="switch-root" checked={draft.proxyPool?.healthCheck?.enabled !== false} onCheckedChange={(checked) => updateConfig('proxyPool.healthCheck.enabled', checked)}><Switch.Thumb className="switch-thumb" /></Switch.Root></div></div></section>
              <section className="config-section"><div className="config-title"><h2>注册链路</h2><p>Sentinel 与 OAuth</p></div><div className="form-grid"><Field label="显示名称"><input value={draft.registration?.name || ''} onChange={(event) => updateConfig('registration.name', event.target.value)} /></Field><Field label="出生日期"><input type="date" value={draft.registration?.birthdate || ''} onChange={(event) => updateConfig('registration.birthdate', event.target.value)} /></Field><Field label="最大运行时间 ms"><ConfigNumberInput min={1000} value={draft.registration?.maxRuntimeMs ?? 900000} onValueChange={(value) => updateConfig('registration.maxRuntimeMs', value)} /></Field><div className="toggle-field"><div><span>动态 Sentinel</span><small>关键阶段生成新证明</small></div><Switch.Root className="switch-root" checked={draft.registration?.dynamicSentinel !== false} onCheckedChange={(checked) => updateConfig('registration.dynamicSentinel', checked)}><Switch.Thumb className="switch-thumb" /></Switch.Root></div></div></section>
            </div>}
          </Tabs.Content>
          <Tabs.Content value="advanced" className="launch-tab-content launch-json-tab">
            <div className="launch-tab-heading"><div><h2>高级 JSON</h2><p>密钥不会返回浏览器，保存时保留现有值</p></div>{configActions}</div>
            {configNotice && <Notice tone={configNotice.tone} floating onClose={() => setConfigNotice(null)} autoDismissToken={configNotice}>{configNotice.text}</Notice>}
            <textarea className="json-editor" spellCheck={false} value={jsonText} onChange={(event) => editJson(event.target.value)} />
          </Tabs.Content>
        </Tabs.Root>
      </aside>

      <aside className="launch-side-column">
        <MailcomImportProgressCard progress={mailcomImport.data} />
        <IcloudImportProgressCard progress={icloudImport.data} />
        <section className="workspace-band market-band preflight-band launch-preflight-panel">
          <div className="section-heading"><div><span className="eyebrow">CHECKPOINT</span><h2>任务预检</h2><p>{taskKindLabel(taskKind, plan)} · 状态随分支变化</p></div><span className="market-checked">{formatTime(snapshot?.checkedAt)}</span></div>
          <div className="preflight-checks" aria-label="任务预检状态">
            {preflightChecks.length ? preflightChecks.map((check) => <PreflightCheckCard check={check} mailLabel={mailMetricLabel} key={check.id} />) : resources.error ? <div className="preflight-check check-blocked"><span className="preflight-state-dot" aria-hidden="true" /><div><strong>预检请求失败</strong><small>{errorMessage(resources.error)}</small></div><em>重试</em></div> : <div className="preflight-check check-loading"><LoaderCircle className="spin" size={16} /><span>正在检查资源</span></div>}
          </div>
            {waitingForOAuthSource ? <div className="market-empty conditional-market">选择账号后检查可读邮箱与 Worker 代理；手机验证资源在实际出现挑战时按需获取。</div> : !proxyAssignmentsReady ? <div className="market-empty conditional-market">请补齐每个 Worker 的代理。</div> : !snapshot && resources.error ? <div className="market-empty conditional-market">预检失败，请修正后重试。</div> : !snapshot ? <div className="market-empty conditional-market"><LoaderCircle className="spin" size={15} />正在读取资源</div> : smsPreflightChecked ? <>
            <div className="market-subhead"><h3>号码市场</h3><span>{marketCountry} · {marketService} · 最低三档</span></div>
            {marketOffers.length ? <div className="market-offers">{marketOffers.map((offer, index) => <div className="market-offer" key={`${offer.providerId}-${offer.price}-${index}`}><span className="offer-rank">0{index + 1}</span><div><small>单价</small><strong>{formatCurrency(offer.price, activeSmsCurrency, 3)}</strong></div><div><small>号码</small><strong>{offer.count}</strong></div></div>)}</div> : <div className="market-empty">{resources.isFetching ? '正在读取号码库存' : (snapshot?.sms.message || '暂无可用报价')}</div>}
          </> : <div className="market-empty conditional-market">手机验证出现时按需检查短信资源。</div>}
        </section>
       <section className="recent-runs-rail workspace-band" aria-labelledby="recent-runs-title">
          <div className="section-heading"><div><span className="eyebrow">RUN HISTORY</span><h2 id="recent-runs-title">最近运行</h2><p>最近 4 条持久化结果</p></div><Link className="text-link" to="/history">全部<ChevronRight size={15} /></Link></div>
         {recent.length ? <div className="compact-table"><div className="table-head"><span>任务</span><span>状态</span><span>登录态 / CPA</span><span>更新时间</span><span /></div>{recent.map((run) => <Link className="table-row" to={`/run/${run.runId}`} key={run.runId}><div><strong>{run.runId}</strong><small>{taskKindLabel(run.taskKind || run.plan?.taskKind, run.plan)}</small></div><StatusBadge status={run.status} /><span>{run.counts?.sessionsSaved ?? run.counts?.accountsCreated ?? 0} / {run.counts?.cpaCompleted ?? 0}</span><span>{formatTime(run.updatedAt)}</span><ChevronRight size={16} /></Link>)}</div> : <EmptyState icon={<History size={24} />} title="暂无运行记录" detail="任务结果会保留在这里。" />}
       </section>
      </aside>
    </div>
    <MailcomConfigDialog
      open={mailApiDialogOpen}
      onOpenChange={(open) => {
        setMailApiDialogOpen(open);
      }}
      provider={mailApiDialogProvider}
      onProviderChange={selectMailApiProvider}
      draft={draft}
      updateConfig={updateConfig}
      onEndpointChange={updateMailApiEndpoint}
      importText={mailcomImportText}
      onImportTextChange={setMailcomImportText}
      status={mailcomStatus.data}
      statusError={mailcomStatus.error}
      configNotice={configNotice}
      domainOptions={mailcomDomains.data}
      importing={importMailcom.isPending}
      importProgress={mailcomImport.data}
      saving={saveConfig.isPending}
      onSave={(provider) => saveConfig.mutate({ switchProvider: provider })}
      onImport={() => importMailcom.mutate({
        content: mailcomImportText,
        provider: mailApiDialogProvider,
      })}
    />
    <IcloudConfigDialog
      open={icloudDialogOpen}
      onOpenChange={(open) => {
        setIcloudDialogOpen(open);
      }}
      draft={draft}
      onEndpointChange={updateIcloudEndpoint}
      importText={icloudImportText}
      onImportTextChange={setIcloudImportText}
      status={icloudStatus.data}
      statusError={icloudStatus.error}
      configNotice={configNotice}
      importing={importIcloud.isPending}
      importProgress={icloudImport.data}
      saving={saveConfig.isPending}
      onSave={(provider) => saveConfig.mutate({ switchProvider: provider })}
      onImport={() => importIcloud.mutate(icloudImportText)}
    />
    <SmsSettingsDialog open={smsDialogOpen} onOpenChange={setSmsDialogOpen} onSaved={(provider) => setSmsDialogProvider(provider)} />
    <SmsMailboxSettingsDialog
      open={smsMailDialogOpen}
      onOpenChange={setSmsMailDialogOpen}
      plan={plan}
      normalMailCount={normalMailCountRef.current}
      onApply={(patch) => updatePlan(patch)}
    />
  </div>;
}

function resolveRunId(requested: string | undefined, data: { activeRunId: string; runs: RunSummary[] } | undefined) {
  return requested || data?.activeRunId || data?.runs.find((run) => !isTerminalRunStatus(run.status))?.runId || data?.runs[0]?.runId || '';
}

/**
 * The one-line answer to "what is this task, and where is it".
 *
 * The header used to read `登录态注册 · ui-20260910140428-zklooc`, which names
 * the kind and then spends the rest of the line on a timestamp. What an
 * operator wants there is the plan — how many accounts, from which channel,
 * through which pools — with the id kept as the thing you copy into a bug
 * report rather than the thing you read.
 */
function runHeaderDescription(run: RunSummary | undefined, runId: string) {
  if (!run) return runId;
  const description = runTaskDescription(run);
  const purpose = taskKindPurpose(run.taskKind || run.plan?.taskKind, run.plan);
  return [description, purpose].filter(Boolean).join(' — ') || runId;
}

function runWaitPresentation(run: RunSummary, active: boolean, waitMessage?: string) {
  const normalWait = run.normalWait;
  const rentalWatch = run.mailRentalWatch;
  if (normalWait?.code === 'MAIL_RENTAL_WATCH') {
    const stopped = rentalWatch?.stopRequested === true;
    const stockError = rentalWatch?.lastStockStatus === 'error';
    const workers = run.counts?.workers;
    const workerText = workers?.total ? `Worker ${workers.running}/${workers.total}` : '';
    const stockText = rentalWatch?.lastStockCount == null ? '' : `库存 ${rentalWatch.lastStockCount}`;
    const claimText = !stockError && rentalWatch?.lastError ? '本轮未领取到邮箱' : '';
    const nextRunAt = normalWait.nextRunAt || rentalWatch?.nextPollAt;
    const nextText = nextRunAt ? `下次检查 ${formatTime(nextRunAt)}` : '';
    return {
      label: stopped ? '已停止领取' : (stockError ? '库存重试' : '调度等待'),
      detail: stopped
        ? [workerText, stockText, '已领取邮箱继续完成任务'].filter(Boolean).join(' · ')
        : ([workerText, stockText, claimText, nextText].filter(Boolean).join(' · ') || '统一 Broker 等待下一次检查'),
      tone: stopped || !stockError ? 'normal' : 'warning',
      icon: stopped ? CirclePause : (stockError ? AlertTriangle : Clock3),
    } as const;
  }
  if (!waitMessage) return null;
  const passive = !active || run.status === 'waiting' || run.status === 'paused' || String(run.phase || '').startsWith('waiting_');
  return {
    label: passive ? '等待处理' : '需要关注',
    detail: waitMessage,
    tone: passive ? 'normal' : 'warning',
    icon: passive ? Clock3 : AlertTriangle,
  } as const;
}

type MailRental = NonNullable<RunSummary['mailRental']>;
type MailRentalWatch = NonNullable<RunSummary['mailRentalWatch']>;

function mailRentalWatchStatus(watch: MailRentalWatch, claimedCount = Number(watch.claimedCount || 0)) {
  if (watch.stopRequested) return { status: 'paused', label: '已停止领取' } as const;
  // The broker stops for two reasons, and they are not the same news: it got
  // everything it asked for, or the provider ran dry and it settled for what
  // it had. Both used to read 已达到总量.
  if (watch.autoStopped) {
    return claimedCount >= Number(watch.target || 0)
      ? { status: 'complete', label: '已达到总量' } as const
      : { status: 'warning', label: '库存不足已收工' } as const;
  }
  if (watch.claimPaused) return { status: 'waiting', label: '暂缓领取' } as const;
  return { status: 'running', label: '领取中' } as const;
}

/**
 * A rental backoff that has not run out yet, or null.
 *
 * A retry that is already due is not a wait — the next scheduler pass rents on
 * it. Reading the field's mere presence left 等待库存 on screen with a retry
 * clock in the past while mailboxes were being claimed a minute apart.
 */
export function pendingRentalRetryAt(rental: MailRental, now: number) {
  const at = Date.parse(String(rental.retryAt || ''));
  return Number.isFinite(at) && at > now ? at : null;
}

/** Why a rental is backing off, in the supplier's words rather than an assumption. */
export function rentalRetryReason(rental: MailRental) {
  const code = String(rental.lastError?.code || '').toUpperCase();
  if (!code || code === 'MAIL_RENTAL_PROVIDER_RETRY' || code.includes('STOCK') || code.includes('SOLD_OUT')) return '库存不足';
  if (code.includes('TIMEOUT')) return '供应商超时';
  if (code.includes('BALANCE')) return '供应商余额不足';
  return '供应商暂时不可用';
}

/**
 * Whether the run is still acquiring mailboxes, in either mode.
 *
 * The broker says so itself. An ordinary rental has no such flag, so it is
 * read off the numbers: short of target and still running means it is trying,
 * and a backoff that has not elapsed says the last attempt was refused.
 */
function mailRentalStatus(rental: MailRental, watch: MailRentalWatch | null | undefined, active: boolean, now: number) {
  if (rental.mode === 'watch' && watch) return mailRentalWatchStatus(watch, rental.claimedCount);
  // The operator's stop outranks everything below: it is a decision, not a
  // state the run happens to be in.
  if (rental.stoppedAt) return { status: 'paused', label: '已停止租用' } as const;
  if (rental.claimedCount >= rental.target && rental.target > 0) return { status: 'complete', label: '已租满' } as const;
  if (!active) return { status: 'paused', label: '任务已停止' } as const;
  if (pendingRentalRetryAt(rental, now)) return { status: 'waiting', label: `等待重试（${rentalRetryReason(rental)}）` } as const;
  return { status: 'running', label: '租用中' } as const;
}

/** Time left before the provider reclaims the earliest unstarted rental. */
function rentalStartCountdown(rental: MailRental, now: number) {
  const deadline = Date.parse(String(rental.nextStartDeadlineAt || ''));
  if (!Number.isFinite(deadline)) return null;
  return Math.max(0, deadline - now);
}

/**
 * The mailbox rental, on one strip, in both modes.
 *
 * The first two cells are what every rental run has: how far it is from its
 * target, and how long the earliest idle mailbox has before the provider takes
 * it back. The third cell is where the modes differ — the broker reports its
 * polling, an ordinary rental reports whether it still owes mailboxes — and
 * only the broker has a fourth.
 */
function MailRentalStrip({ rental, watch, run, active }: {
  rental: MailRental;
  watch: MailRentalWatch | null | undefined;
  run: RunSummary;
  active: boolean;
}) {
  const now = useSecondTick();
  const status = mailRentalStatus(rental, watch, active, now);
  const countdown = rentalStartCountdown(rental, now);
  const stockError = watch?.lastStockStatus === 'error';
  const stockErrorMessage = String(watch?.lastError?.message || '').trim();
  const deficit = Math.max(0, rental.target - rental.claimedCount);
  const windowMinutes = Math.round(Number(rental.startWindowMs || 0) / 60_000);
  return <section className="mail-rental-strip" aria-live="polite" aria-label="邮箱租约">
    <div>
      <span>{rental.mode === 'watch' ? '挂租模式' : '普通租约'}</span>
      <strong>{rental.claimedCount}/{rental.target || '—'}</strong>
      <small>{status.label}{rental.mode === 'watch' && watch?.claimPaused && !watch.stopRequested ? '：空闲邮箱达到上限' : ''}</small>
    </div>
    <div className={countdown !== null && countdown <= 5 * 60_000 ? 'mail-rental-cell-urgent' : undefined}>
      <span>{windowMinutes} 分钟起跑窗口</span>
      <strong>{countdown === null ? '—' : durationLabel(countdown)}</strong>
      <small>{rental.awaitingStartCount
        ? `${rental.awaitingStartCount} 个待起跑${rental.expiredCount ? ` · 已超时 ${rental.expiredCount}` : ''}`
        : (rental.expiredCount ? `全部已起跑 · 历史超时 ${rental.expiredCount}` : '全部已进入注册')}</small>
    </div>
    {rental.mode === 'watch' && watch
      ? <>
        <div>
          <span>单批 / 间隔</span>
          <strong>{watch.batchSize} 个 / {Math.round(Number(watch.pollIntervalMs || 0) / 1000)} 秒</strong>
          <small>单个 Broker 轮询，领取最多 {watch.claimConcurrency || 7} 路；再分配给 Worker</small>
        </div>
        <div>
          <span>{watch.claimPaused ? '空闲邮箱' : (stockError ? '上次库存' : '当前库存')}</span>
          <strong>{watch.claimPaused
            ? `${watch.idleMailboxCount ?? 0}/${watch.idleMailboxLimit ?? ((run.counts?.workers?.total || 1) * 2)}`
            : (watch.lastStockCount ?? (stockError ? '更新中' : '—'))}</strong>
          <small>{watch.claimPaused
            ? '达到上限，Worker 消费后自动恢复领取'
            : (stockError
              ? `查询失败，保留上次值${stockErrorMessage ? `：${stockErrorMessage}` : ''}`
              : (watch.nextPollAt ? `下次 ${formatTime(watch.nextPollAt)}` : '不再轮询'))}</small>
        </div>
      </>
      : <div>
        <span>待补租用</span>
        <strong>{rental.stoppedAt ? '—' : (deficit || '—')}</strong>
        <small>{rental.stoppedAt
          ? `${formatTime(rental.stoppedAt)} 已停止后续租用`
          : (deficit === 0
            ? '已租满本次任务所需邮箱'
            : (pendingRentalRetryAt(rental, now)
              ? `${rentalRetryReason(rental)}，${formatTime(rental.retryAt)} 重试${rental.retryAttempts ? `（第 ${rental.retryAttempts} 次）` : ''}`
              : (active ? '正在向供应商租用' : '任务已停止，不再租用')))}</small>
      </div>}
  </section>;
}

function RunProgressSummary({ run }: { run: RunSummary }) {
  const jobs = run.jobs || [];
  const rentalWatch = run.mailRentalWatch;
  const accountTotal = Math.max(
    jobs.length,
    Number(run.plan?.totalAccounts || 0),
    rentalWatch?.enabled ? Number(run.plan?.mailCount || 0) : 0,
  );
  const completed = jobs.filter((job) => isTerminalJobStatus(job.status)).length;
  const rentalTarget = rentalWatch?.enabled ? Math.max(0, Number(rentalWatch.target || 0)) : 0;
  const rentalClaimed = rentalWatch?.enabled
    ? Math.min(rentalTarget, Math.max(0, Number(rentalWatch.claimedCount || 0)))
    : 0;
  const progressTotal = accountTotal + rentalTarget;
  const progressDone = completed + rentalClaimed;
  const percent = progressTotal > 0 ? Math.min(100, Math.round((progressDone / progressTotal) * 100)) : 0;
  const workers = run.counts?.workers;
  const progressText = rentalWatch?.enabled
    ? `租约 ${rentalClaimed}/${rentalTarget} · 账号 ${completed}/${accountTotal}`
    : (accountTotal ? `${completed}/${accountTotal}` : '等待任务生成');
  return <section className="run-progress-summary" aria-label="任务进度">
    <div className="run-progress-head">
      <div><span>任务进度</span><strong>{progressText}</strong></div>
      <b>{progressTotal ? `${percent}%` : '—'}</b>
    </div>
    <div className="run-progress-track" role="progressbar" aria-label="任务进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
      <span style={{ width: `${percent}%` }} />
    </div>
    <div className="run-progress-stats">
      <span><small>登录态</small><strong>{run.counts?.sessionsSaved ?? run.counts?.accountsCreated ?? 0}</strong></span>
      <span><small>Worker</small><strong>{workers ? `${workers.running}/${workers.total}` : '—'}</strong></span>
      {rentalWatch?.enabled && <span><small>统一 Broker</small><strong>{rentalWatch.claimedCount}/{rentalWatch.target}</strong></span>}
    </div>
  </section>;
}

/**
 * Status, phase, plan and the reason it is waiting, in reading order.
 *
 * Two things were wrong with the row this replaces. It rendered `data.phase`
 * raw, so a parked task announced itself as `waiting_sms_acquisition_reconcile`
 * — an identifier the operator has to know the codebase to decode. And the
 * wait reason, which is the only actionable part when a task is stuck, sat last
 * behind three pieces of static plan text.
 *
 * So the phase is labelled (identifier kept in `title` for bug reports), and a
 * waiting task leads with why.
 */
function RunStatusStrip({ run, runId, active, waitMessage }: {
  run: RunSummary;
  runId: string;
  active: boolean;
  waitMessage?: string;
}) {
  const phase = phaseLabel(run.phase);
  const slot = runTaskSlotLabel(run);
  const wait = runWaitPresentation(run, active, waitMessage);
  const WaitIcon = wait?.icon;
  return <section className="run-status-strip">
    <div className="run-status-state">
      <StatusBadge status={run.status} label={runStatusLabel(run.status)} />
      <strong title={phase.raw}>{phase.label}</strong>
      <StatusBadge status={active ? 'running' : 'idle'} label={active ? '后台执行中' : '后台未运行'} />
      <span className="run-status-slot" title={TASK_SLOT_PURPOSE[isAuxiliaryRun(run) ? 'auxiliary' : 'main']}>{slot}</span>
    </div>
    {wait && WaitIcon && <span className={`wait-reason wait-reason-${wait.tone}`} title={wait.detail}>
      <WaitIcon size={15} />
      <span className="wait-reason-copy"><strong>{wait.label}</strong><small>{wait.detail}</small></span>
    </span>}
    <span className="run-status-meta">
      <code title="任务 ID，用于日志与状态文件">{runId}</code>
      <span>最后更新 {formatTime(run.updatedAt)}</span>
    </span>
  </section>;
}

/**
 * Rent more, or stop renting — for either mode.
 *
 * The two questions an operator has about a paid mailbox pool are the same
 * whichever mode filled it, so this dialog is too. Only the broker's own
 * machinery — how many to claim per batch, how often to re-read stock — is
 * hidden on an ordinary rental, which has no poll loop to configure.
 */
function MailRentalRunConfigDialog({
  open,
  onOpenChange,
  rental,
  watch,
  onApply,
  saving,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rental: MailRental;
  watch: MailRentalWatch | null;
  onApply: (body: MailRentalConfigureBody) => void;
  saving: boolean;
}) {
  const [additional, setAdditional] = useState(0);
  const [batchSize, setBatchSize] = useState(20);
  const [pollIntervalSeconds, setPollIntervalSeconds] = useState(20);
  const [action, setAction] = useState<'continue' | 'stop'>('continue');
  const broker = rental.mode === 'watch' && watch ? watch : null;
  const verb = broker ? '领取' : '租用';
  const claimedCount = Math.max(0, Number(rental.claimedCount || 0));
  const currentTarget = Math.max(claimedCount, Number(rental.target || 0));
  const maxAdditional = Math.max(0, MAX_MAIL_RENTAL_TARGET - currentTarget);
  const safeAdditional = Math.max(0, Math.min(maxAdditional, Number(additional || 0)));
  // Stopping settles the task's size at what it already holds, so the number
  // the operator is about to save is not the current target — it is the
  // claimed count. Saying so here is the difference between a bar that jumps
  // to something truthful and one that looks broken.
  const projectedTarget = action === 'stop' ? claimedCount : currentTarget + safeAdditional;
  const stopped = Boolean(rental.stoppedAt) || broker?.stopRequested === true || broker?.autoStopped === true;

  useEffect(() => {
    if (!open) return;
    setAdditional(0);
    setBatchSize(Math.max(1, Math.min(20, Number(broker?.batchSize || 20))));
    setPollIntervalSeconds(Math.max(MIN_MAIL_RENTAL_POLL_INTERVAL_SECONDS, Math.min(3600, Math.round(Number(broker?.pollIntervalMs || 20_000) / 1000))));
    setAction(stopped ? 'stop' : 'continue');
  }, [open]);

  const updateAdditional = (value: number) => {
    const next = Math.max(0, Math.min(maxAdditional, Number(value || 0)));
    setAdditional(next);
    if (next > 0) setAction('continue');
  };
  const apply = () => onApply({
    additional: safeAdditional,
    action,
    ...(broker ? {
      batchSize: Math.max(1, Math.min(20, Number(batchSize || 20))),
      pollIntervalMs: Math.max(MIN_MAIL_RENTAL_POLL_INTERVAL_SECONDS * 1000, Math.min(3_600_000, Number(pollIntervalSeconds || 20) * 1000)),
    } : {}),
  });

  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="dialog-content sms-mail-settings-dialog">
        <Dialog.Title>邮箱租约</Dialog.Title>
        <Dialog.Description>{broker
          ? '在线调整统一 Broker。保存后当前任务继续运行，已经领取的邮箱和账号不受影响。'
          : '在线调整本次任务的邮箱租用。保存后任务继续运行，已经租到的邮箱和账号不受影响。'}</Dialog.Description>
        <div className="sms-settings-summary">
          <div><span>已{verb} / 当前目标</span><strong>{claimedCount} / {currentTarget}</strong><small>目标可继续追加；停止后续{verb}会收到已{verb}数量</small></div>
          <div><span>保存后目标</span><strong>{projectedTarget}</strong><small>{action === 'stop' ? `收到已${verb}的 ${claimedCount} 个` : (safeAdditional ? `本次追加 ${safeAdditional} 个` : '本次不追加')}</small></div>
        </div>
        <div className="mail-rental-mode" role="radiogroup" aria-label={`后续${verb}动作`}>
          <button type="button" role="radio" aria-checked={action === 'continue'} className={action === 'continue' ? 'selected' : ''} onClick={() => setAction('continue')}>
            <strong>继续{verb}</strong><small>{broker ? '按新的间隔继续轮询库存' : '按任务缺口继续向供应商租用'}</small>
          </button>
          <button type="button" role="radio" aria-checked={action === 'stop'} className={action === 'stop' ? 'selected' : ''} disabled={safeAdditional > 0} onClick={() => setAction('stop')}>
            <strong>停止后续{verb}</strong><small>{safeAdditional > 0 ? `追加数量会自动恢复${verb}` : `已${verb}的 ${claimedCount} 个跑完即收尾`}</small>
          </button>
        </div>
        <div className="sms-mail-settings-grid">
          <label><span>本次追加租用数量</span><ConfigNumberInput min={0} max={maxAdditional} value={safeAdditional} onValueChange={updateAdditional} disabled={maxAdditional <= 0} /></label>
          {broker && <>
            <label><span>单批领取数量</span><ConfigNumberInput min={1} max={20} value={batchSize} onValueChange={setBatchSize} /></label>
            <label><span>轮询间隔（秒）</span><ConfigNumberInput min={MIN_MAIL_RENTAL_POLL_INTERVAL_SECONDS} max={3600} value={pollIntervalSeconds} onValueChange={setPollIntervalSeconds} /></label>
          </>}
        </div>
        <div className="mail-rental-settings-note">{broker
          ? '单个 Broker 轮询，最多 7 路并发领取；轮询间隔只影响后续库存查询，不会重启任务。'
          : '普通租约按 Worker 空闲情况逐个租用；停止后不再新租，24 分钟起跑窗口内没用上的邮箱仍会自动释放。'}</div>
        <div className="dialog-actions">
          <Dialog.Close asChild><Button tone="quiet" disabled={saving}>取消</Button></Dialog.Close>
          <Button tone="primary" icon={saving ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />} onClick={apply} disabled={saving}>保存配置</Button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

function RunPage() {
  const params = useParams();
  const client = useQueryClient();
  const [notice, setNotice] = useState<{ tone: string; text: string } | null>(null);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [operationsOpen, setOperationsOpen] = useState<boolean | null>(null);
  const [mailRentalDialogOpen, setMailRentalDialogOpen] = useState(false);
  const resumeFeedback = useRef<'requested' | 'running' | ''>('');
  const runs = useRunsQuery();
  const runId = resolveRunId(params.runId, runs.data);
  const [jobOffset, setJobOffset] = useState(0);
  useEffect(() => { setJobOffset(0); }, [runId]);
  const run = useQuery({
    queryKey: ['run', runId, jobOffset],
    queryFn: () => endpoints.runPage(runId, jobOffset),
    enabled: Boolean(runId),
    refetchInterval: 1500,
    // Keeps the run on screen while the next one loads, instead of dropping the
    // whole page back to "正在读取状态" on every switch.
    placeholderData: keepPreviousData,
  });
  const [oauthResumeOpen, setOAuthResumeOpen] = useState(false);
  const action = useMutation({
    mutationFn: async ({ kind, resolveSmsAcquisition, proxyAssignments }: { kind: 'pause' | 'resume' | 'cancel'; resolveSmsAcquisition?: 'retry'; proxyAssignments?: RunPlan['proxyAssignments'] }) => {
      if (kind === 'pause') return endpoints.pauseRun(runId);
      if (kind === 'resume') return endpoints.resumeRun(runId, { ...(resolveSmsAcquisition ? { resolveSmsAcquisition } : {}), ...(proxyAssignments ? { proxyAssignments } : {}) });
      return endpoints.cancelRun(runId);
    },
    onMutate: ({ kind }) => {
      if (kind === 'resume') {
        resumeFeedback.current = 'requested';
        setNotice({ tone: 'info', text: '正在从上次持久化检查点继续任务' });
      }
    },
    onSuccess: (next, { kind }) => {
      client.invalidateQueries({ queryKey: ['run', runId, jobOffset] });
      client.invalidateQueries({ queryKey: ['runs'] });
      if (kind === 'resume') {
        resumeFeedback.current = next.active ? 'running' : 'requested';
        setNotice({ tone: 'success', text: '任务已重新启动，正在处理上次未完成的步骤' });
      } else if (kind === 'pause') {
        setNotice({ tone: 'info', text: '已提交安全暂停请求' });
      } else if (kind === 'cancel') {
        setNotice({ tone: 'warning', text: '取消请求已提交，正在清理任务资源' });
      }
    },
    onError: (error) => {
      resumeFeedback.current = '';
      setNotice({ tone: 'danger', text: errorMessage(error) });
    },
  });
  const retryJob = useMutation({
    mutationFn: (jobId: string) => endpoints.retryJob(runId, jobId, { resolveSmsAcquisition: 'retry' }),
    onMutate: () => setNotice({ tone: 'info', text: '正在提交该账号的核对结果' }),
    onSuccess: (next, jobId) => {
      client.setQueryData(['run', runId, jobOffset], next);
      client.invalidateQueries({ queryKey: ['run', runId, jobOffset] });
      client.invalidateQueries({ queryKey: ['runs'] });
      const job = next.jobs?.find((candidate) => candidate.id === jobId);
      setNotice({
        tone: 'success',
        text: job?.status === 'queued' || job?.status === 'running'
          ? '该账号已确认，已立即加入继续执行队列'
          : '该账号的继续请求已提交',
      });
    },
    onError: (error) => setNotice({ tone: 'danger', text: errorMessage(error) }),
  });
  const retryJobs = useMutation({
    mutationFn: (jobIds: string[]) => endpoints.retryJobs(runId, jobIds, { resolveSmsAcquisition: 'retry' }),
    onMutate: (jobIds) => setNotice({ tone: 'info', text: `正在提交 ${jobIds.length} 个账号的核对结果` }),
    onSuccess: (next, jobIds) => {
      client.setQueryData(['run', runId, jobOffset], next);
      client.invalidateQueries({ queryKey: ['run', runId, jobOffset] });
      client.invalidateQueries({ queryKey: ['runs'] });
      setNotice({ tone: 'success', text: `已确认 ${jobIds.length} 个账号，已一起加入继续执行队列` });
    },
    onError: (error) => setNotice({ tone: 'danger', text: errorMessage(error) }),
  });
  const mailRentalConfigure = useMutation({
    mutationFn: (body: MailRentalConfigureBody) => endpoints.configureMailRental(runId, body),
    onMutate: async (body) => {
      if (body.action !== 'stop') return undefined;
      await client.cancelQueries({ queryKey: ['run', runId, jobOffset] });
      const previous = client.getQueryData<RunSummary>(['run', runId, jobOffset]);
      const current = previous?.mailRentalWatch;
      if (!previous || !current) return { previous };
      const at = new Date().toISOString();
      client.setQueryData<RunSummary>(['run', runId, jobOffset], {
        ...previous,
        updatedAt: at,
        normalWait: {
          code: 'MAIL_RENTAL_WATCH',
          message: '已停止后续领取，已领取邮箱继续完成任务',
          at,
          nextRunAt: '',
        },
        mailRentalWatch: {
          ...current,
          stopRequested: true,
          autoStopped: false,
          nextPollAt: '',
          stoppedAt: at,
        },
      });
      return { previous };
    },
    onSuccess: (next, body) => {
      client.setQueryData(['run', runId, jobOffset], next);
      client.invalidateQueries({ queryKey: ['run', runId, jobOffset] });
      client.invalidateQueries({ queryKey: ['runs'] });
      setMailRentalDialogOpen(false);
      const verb = next.mailRental?.mode === 'watch' ? '领取' : '租用';
      if (body.action === 'stop') {
        setOperationsOpen(true);
        setNotice({ tone: 'info', text: `已停止后续${verb}，已${verb}邮箱继续完成任务` });
      } else {
        setNotice({ tone: 'success', text: '邮箱租约已更新，当前任务继续运行' });
      }
    },
    onError: (error, _body, context) => {
      if (context?.previous) client.setQueryData(['run', runId, jobOffset], context.previous);
      setNotice({ tone: 'danger', text: errorMessage(error) });
    },
  });
  const skip = useMutation({
    mutationFn: (jobId: string) => endpoints.skipJob(runId, jobId),
    onMutate: () => setNotice({ tone: 'info', text: '正在清理短信资源并跳过账号任务' }),
    onSuccess: (next, jobId) => {
      client.setQueryData(['run', runId, jobOffset], next);
      client.invalidateQueries({ queryKey: ['run', runId, jobOffset] });
      const job = next.jobs?.find((candidate) => candidate.id === jobId);
      setNotice({
        tone: job?.status === 'skipped' ? 'success' : 'warning',
        text: job?.status === 'skipped'
          ? '账号任务已跳过'
          : '跳过请求已记录，短信清理仍在等待，任务不会重新运行',
      });
    },
    onError: (error) => setNotice({ tone: 'danger', text: errorMessage(error) }),
  });
  const balanceRetry = useMutation({
    mutationFn: () => endpoints.reconcileBalance(runId),
    onSuccess: (next) => {
      client.setQueryData(['run', runId, jobOffset], next);
      client.invalidateQueries({ queryKey: ['runs'] });
      setNotice({ tone: 'success', text: '余额已重新读取并完成核对' });
    },
    onError: (error) => setNotice({ tone: 'danger', text: errorMessage(error) }),
  });
  const data = run.data;
  const activeRunIds = new Set(runs.data?.activeRunIds || (runs.data?.activeRunId ? [runs.data.activeRunId] : []));
  // Everything holding a task slot, not only what is executing. A paused task
  // keeps its slot so it stays resumable, and it is exactly the one an operator
  // needs to reach — the old filter dropped it and left no route back.
  const activeTaskOptions = slotHolderRuns(runs.data?.runs || [], activeRunIds);
  // Shown whenever there is more than one task to move between. The old gate
  // required a main *and* an auxiliary task, so two auxiliary tasks running
  // together offered no way to switch between them.
  const showTaskSwitcher = activeTaskOptions.length > 1;
  const [taskSwitcherOpen, setTaskSwitcherOpen] = useState(false);
  useEffect(() => {
    setOverviewOpen(false);
    setOperationsOpen(null);
    setMailRentalDialogOpen(false);
  }, [runId]);
  useEffect(() => {
    if (!data || !resumeFeedback.current) return;
    if (data.active) {
      resumeFeedback.current = 'running';
      return;
    }
    if (resumeFeedback.current !== 'running') return;
    resumeFeedback.current = '';
    const blocked = data.jobs?.find((job) => job.error && !isTerminalJobStatus(job.status));
    if (data.status === 'complete') setNotice({ tone: 'success', text: '继续执行后任务已完成' });
    else if (['failed', 'cancelled'].includes(data.status)) setNotice({ tone: 'danger', text: `任务已停止：${blocked?.error?.message || data.status}` });
    else setNotice({ tone: 'warning', text: `任务再次进入等待：${blocked?.error?.message || data.normalWait?.message || data.status}` });
  }, [data?.active, data?.status, data?.updatedAt]);
  // Ticking, because the badge turns on an elapsed backoff: a retry clock that
  // has come due is no longer a wait, and nothing else on this page would
  // re-render to notice. Called before the empty-page return below: a hook
  // after it ran while the run list was loading and vanished once it loaded
  // empty, so opening /run directly crashed the whole console (React #300).
  const rentalNow = useSecondTick();
  if (!runId && !runs.isLoading) return <div className="run-page run-page-empty"><PageHeader title="当前任务" /><EmptyState icon={<Activity size={26} />} title="没有可查看的任务" detail="从总览启动任务后，这里会显示完整执行状态。" action={<Link className="button button-primary" to="/">返回总览</Link>} /></div>;

  const active = Boolean(data?.active);
  const paused = data?.status === 'paused';
  const cancelling = data?.control?.requestedAction === 'cancel';
  const blockedJob = data?.jobs?.find((job) => job.error && !isTerminalJobStatus(job.status));
  // A terminal run's wait is history, not a state: the runs already on disk
  // carry the `normalWait` that was current when they stopped, and reading it
  // back made a finished task claim it was still renting mailboxes. What is
  // worth showing once a run is over is why it stopped.
  // A balance stop is terminal, so its jobs are terminal too and the blocked-job
  // lookup above finds nothing. Without this a run that stopped for want of
  // money just ended, with no reason anywhere on the page.
  const waitMessage = (active ? data?.normalWait?.message : '')
    || (!active ? (data?.balanceStop?.message || blockedJob?.error?.message) : '');
  const externalCleanupCount = data?.externalCleanup?.length || 0;
  const rental = data?.mailRental || null;
  const rentalWatch = data?.mailRentalWatch?.enabled === true ? data.mailRentalWatch : null;
  const reconciliation = data?.balanceReconciliation;
  const rentalStatus = rental ? mailRentalStatus(rental, rentalWatch, active, rentalNow) : null;
  const jobsById = new Map((data?.jobs || []).map((job) => [job.id, job]));
  const smsReconciliationJobs = (data?.jobs || []).filter((job) => (
    job.status === 'waiting' && job.phase === 'waiting_sms_acquisition_reconcile'
  ));
  // Any run that rents mailboxes, not only the broker: an ordinary rental
  // spends the same money and had no way to stop it.
  const canConfigureMailRental = Boolean(
    rental
      && data
      && !['complete', 'cancelled'].includes(data.status),
  );
  return <div className="run-page">
    {showTaskSwitcher && <nav className="run-task-switcher" aria-label="并行任务切换">
      <div className="run-task-switcher-heading">
        <strong>并行任务<em>{activeTaskOptions.length}</em></strong><Button aria-expanded={taskSwitcherOpen} aria-controls="parallel-task-options" onClick={() => setTaskSwitcherOpen(open => !open)}>{taskSwitcherOpen ? '收起任务' : '展开任务'}</Button>
        <span>主任务与附属任务占用各自的任务位，可同时运行</span>
      </div>
      <div id="parallel-task-options" className="run-task-switcher-options" hidden={!taskSwitcherOpen}>
        {activeTaskOptions.map((candidate) => {
          const selected = candidate.runId === runId;
          const description = runTaskDescription(candidate);
          return <Link
            className={`run-task-switcher-link${selected ? ' is-selected' : ''}`}
            to={`/run/${candidate.runId}`}
            aria-current={selected ? 'page' : undefined}
            key={candidate.runId}
          >
            <span className="run-task-switcher-slot">{runTaskSlotLabel(candidate)}</span>
            <span className="run-task-switcher-main">
              <strong>{taskKindLabel(candidate.taskKind || candidate.plan?.taskKind, candidate.plan)}</strong>
              {/* The plan, not the id: a column of `ui-<timestamp>` strings is
                  not something an operator can pick between. */}
              <small>{description || candidate.runId}</small>
            </span>
            <StatusBadge status={candidate.status} label={runStatusLabel(candidate.status)} />
          </Link>;
        })}
      </div>
    </nav>}
    <PageHeader title={taskKindLabel(data?.taskKind || data?.plan?.taskKind, data?.plan)} description={runHeaderDescription(data, runId)} actions={<>
      {canConfigureMailRental && <Button icon={mailRentalConfigure.isPending ? <LoaderCircle className="spin" size={17} /> : <Settings2 size={17} />} disabled={mailRentalConfigure.isPending || action.isPending} onClick={() => setMailRentalDialogOpen(true)}>邮箱租约</Button>}
      {active && <Button icon={<CirclePause size={17} />} onClick={() => action.mutate({ kind: 'pause' })} disabled={action.isPending}>安全暂停</Button>}
      <OAuthProxyDialog open={oauthResumeOpen} onOpenChange={setOAuthResumeOpen} workers={data?.plan?.workerConcurrency || 1} initial={data?.plan?.proxyAssignments} busy={action.isPending} error={action.error ? errorMessage(action.error) : ''} onConfirm={(proxyAssignments) => action.mutate({ kind: 'resume', proxyAssignments }, { onSuccess: () => setOAuthResumeOpen(false) })} />
      {!active && data && (data.resumable === true || !isTerminalRunStatus(data.status)) && <Button tone="primary" icon={action.isPending ? <LoaderCircle className="spin" size={17} /> : <CirclePlay size={17} />} onClick={() => data.taskKind === 'oauth' && (!data.plan?.proxyAssignments?.length || data.plan.proxyAssignments.some((p) => p.kind === 'maintenance')) ? setOAuthResumeOpen(true) : action.mutate({ kind: 'resume' })} disabled={action.isPending}>{action.isPending ? '启动中' : '从检查点继续'}</Button>}
      {!active && data?.taskKind === 'oauth' && data.resumable === true && <Button disabled={action.isPending} onClick={() => setOAuthResumeOpen(true)}>更换代理并继续</Button>}
      {data && !['complete', 'cancelled'].includes(data.status) && <ConfirmDialog trigger={<Button tone="danger" icon={cancelling ? <LoaderCircle className="spin" size={16} /> : <Square size={16} />} disabled={cancelling || action.isPending}>{cancelling ? '取消中' : '取消任务'}</Button>} title="取消整个任务" description="同一任务下的所有 Worker 会在各自当前安全边界统一停止，并清理短信 activation、邮箱和代理资源。" danger confirmLabel="确认取消" onConfirm={() => action.mutate({ kind: 'cancel' })} />}
    </>} />
    {notice && <Notice tone={notice.tone} floating onClose={() => setNotice(null)} autoDismissToken={notice}>{notice.text}</Notice>}
    {externalCleanupCount > 0 && <Notice tone="warning" floating onClose={() => setNotice(null)}>本地资源已清理，但有 {externalCleanupCount} 项外部资源终态需要人工核对。</Notice>}
    {rental && <MailRentalRunConfigDialog
      open={mailRentalDialogOpen}
      onOpenChange={setMailRentalDialogOpen}
      rental={rental}
      watch={rentalWatch}
      onApply={(body) => mailRentalConfigure.mutate(body)}
      saving={mailRentalConfigure.isPending}
    />}
    {run.isLoading ? <div className="loading-line"><LoaderCircle className="spin" />正在读取状态</div> : data && <>
      <details className="run-overview-details" open={overviewOpen} onToggle={(event) => setOverviewOpen(event.currentTarget.open)}>
        <summary className="run-overview-summary">
          <span className="run-overview-summary-title"><ChevronDown size={15} className="run-overview-summary-chevron" />任务概览</span>
          <span className="run-overview-summary-hint">{overviewOpen ? '点击收起详情' : '点击展开详情'}</span>
        </summary>
        <div className="run-overview-body">
          <RunStatusStrip run={data} runId={runId} active={active} waitMessage={waitMessage} />
          <RunProgressSummary run={data} />
          <section className="metrics-grid metrics-compact">
            <Metric label="Worker" value={`${data.counts?.workers.running ?? 0}/${data.counts?.workers.total ?? 0}`} icon={<ListRestart size={20} />} />
            <Metric label="登录态保存" value={data.counts?.sessionsSaved ?? data.counts?.accountsCreated ?? 0} icon={<Check size={20} />} />
            {isRegistrationRun(data) && <RegistrationOutcomeMetric outcomes={data.counts?.registrationOutcomes} />}
            {!isRegistrationOnlyRun(data) && <Metric label="CPA 完成" value={data.counts?.cpaCompleted ?? 0} icon={<FileJson size={20} />} />}
            {isRegistrationRun(data) && <RegistrationSkippedMetric outcomes={data.counts?.registrationSkipped} />}
            {data.counts?.oauthSkipped && <OAuthSkippedMetric outcomes={data.counts.oauthSkipped} />}
            {Boolean(data.counts?.deactivated) && <Metric label="账号被封禁" value={data.counts?.deactivated ?? 0} hint="正常损耗，不计入失败；清洗机器人会回收" icon={<ShieldAlert size={20} />} />}
            <RunCostMetric run={data} />
          </section>
          <RunWasteStrip run={data} />
        </div>
      </details>
      {/* One band for both rental modes. It used to appear only for the unified
          broker, which left an ordinary rental run with no view of its own
          mailboxes at all: not the target it was short of, and not the
          24-minute window its idle mailboxes were burning through. A run with
          no rental keeps the cost panel on its own, where it is the only thing
          to read and a drawer would only add a click. */}
      {rental && <details className="run-operations-details" open={operationsOpen ?? false} onToggle={(event) => setOperationsOpen(event.currentTarget.open)}>
        <summary className="run-operations-summary">
          <span className="run-operations-summary-title"><ChevronDown size={15} className="run-operations-summary-chevron" />邮箱租约与费用</span>
          <span className="run-operations-summary-item"><small>{rental.mode === 'watch' ? '挂租进度' : '租约进度'}</small><strong>{rental.claimedCount}/{rental.target || '—'}</strong></span>
          {rentalStatus && <span className="run-operations-summary-item run-operations-summary-rental-status" aria-live="polite"><small>{rental?.mode === 'watch' ? '后续领取' : '租用'}</small><StatusBadge status={rentalStatus.status} label={rentalStatus.label} /></span>}
          {reconciliation && <span className="run-operations-summary-item run-operations-summary-reconciliation"><small>费用核对</small><StatusBadge status={reconciliation.status} label={reconciliationStatusLabel(reconciliation.status)} /></span>}
          <span className="run-operations-summary-hint">点击展开详情</span>
        </summary>
        <div className="run-operations-body">
          <MailRentalStrip rental={rental} watch={rentalWatch} run={data} active={active} />
          <BalanceReconciliationPanel run={data} onRetry={() => balanceRetry.mutate()} retrying={balanceRetry.isPending} />
        </div>
      </details>}
      {!rental && reconciliation && <BalanceReconciliationPanel run={data} onRetry={() => balanceRetry.mutate()} retrying={balanceRetry.isPending} />}
      <div className="run-workspace-grid">
        <div className="run-primary-column">
          <details className="workspace-band worker-lanes-band">
            <summary className="section-heading worker-lanes-summary">
              <div><h2>Worker 泳道</h2><p>{rentalWatch ? '统一 Broker 轮询库存，Worker 只负责并发注册' : '同一根邮箱或会话来源严格串行'}</p></div>
              <ChevronDown size={16} className="worker-lanes-summary-chevron" />
            </summary>
            <div className="worker-grid">{(data.workers || []).map((worker) => {
              const currentJob = jobsById.get(worker.currentJobId);
              const currentPhase = currentJob ? phaseLabel(currentJob.phase) : null;
              return <div className="worker-lane" key={worker.id}>
                <div className="worker-lane-head"><strong>{worker.id}</strong><StatusBadge status={worker.status} /></div>
                <div className="worker-lane-current">
                  <span>当前账号</span>
                  <strong title={currentJob?.email || ''}>{currentJob?.email || '空闲，等待分配'}</strong>
                  {currentPhase && <small title={currentPhase.raw}>{currentPhase.label}</small>}
                </div>
                <dl><dt>根邮箱</dt><dd>{worker.mailboxId || '未绑定'}</dd><dt>当前 Job</dt><dd>{worker.currentJobId || '—'}</dd><dt>已完成</dt><dd>{worker.completedRoots}</dd></dl>
              </div>;
            })}</div>
          </details>
          <section className="workspace-band run-jobs-band">
            <div className="section-heading">
              <div><h2>账号任务队列</h2><p>会话、短信与 OAuth 结果集中展示</p></div>
              {smsReconciliationJobs.length > 1 && <ConfirmDialog
                trigger={<Button tone="primary" icon={retryJobs.isPending ? <LoaderCircle className="spin" size={15} /> : <ListChecks size={15} />} disabled={retryJobs.isPending || retryJob.isPending}>批量核对并继续（{smsReconciliationJobs.length}）</Button>}
                title="批量确认账号继续"
                description={`请确认这 ${smsReconciliationJobs.length} 个账号在接码平台上的取号都没有产生号码。确认后会一次性重新加入执行队列，其他正在执行的账号保持当前进度。`}
                confirmLabel="确认全部无号并继续"
                onConfirm={() => retryJobs.mutate(smsReconciliationJobs.map((job) => job.id))}
              />}
            </div>
            <div className="data-table jobs-table" inert={run.isPlaceholderData}>
              <div className="table-head"><span>#</span><span>邮箱</span><span>阶段</span><span>状态</span><span>短信</span><span>金额</span><span>结果</span><span /></div>
              {(data.jobsPage?.items || data.jobs || []).map((job, index) => <div className="table-row" key={job.id}>
                <span className="job-sequence">{(data.jobsPage?.offset || 0) + index + 1}</span>
                <div><strong>{job.email}</strong><small>{job.sessionAssetId || job.id}</small></div>
                {/* Labelled, with the identifier kept in the tooltip: this column
                    is how an operator finds the stuck job, and it used to read
                    . */}
                <span title={phaseLabel(job.phase).raw}>{phaseLabel(job.phase).label}</span>
                <StatusBadge status={job.status} />
                <span>{job.smsAttempts} 次</span>
                <span>{formatJobSmsCost(job)}</span>
                <span className={job.status === 'failed' || Boolean(job.error) ? 'job-result-failure' : undefined}>{job.cpaSuperseded ? 'CPA 已替代' : jobResultLabel(job.result, job.error) || (job.cpaPath ? 'CPA 已保存' : job.sessionAssetId ? '登录态已保存' : job.accountCreated ? '已创建' : '—')}</span>
                <div>
                  {job.status === 'waiting' && job.phase === 'waiting_sms_acquisition_reconcile' && <ConfirmDialog
                    trigger={<IconButton label="核对无误后继续此账号" disabled={retryJob.isPending || retryJobs.isPending}><CirclePlay size={16} /></IconButton>}
                    title="确认此账号继续"
                    description="请先确认接码平台上一次取号没有产生号码。确认后只会重新申请此账号的号码，其他账号继续保持当前进度。"
                    confirmLabel="确认无号并继续"
                    onConfirm={() => retryJob.mutate(job.id)}
                  />}
                  {paused && isSkippableJobStatus(job.status) && <ConfirmDialog trigger={<IconButton label="跳过账号任务"><SkipForward size={16} /></IconButton>} title="跳过此账号任务" description="当前短信资源会先执行清理，该账号不会再自动运行。" confirmLabel="确认跳过" danger onConfirm={() => skip.mutate(job.id)} />}
                </div>
              </div>)}
            </div>
            <Pagination label="账号任务分页" total={data.jobsPage?.total ?? data.jobs?.length ?? 0} offset={jobOffset} busy={run.isFetching} onChange={setJobOffset} />
          </section>
        </div>
        <aside className="run-observer-column">
          <RunLogPanel runId={runId} />
        </aside>
      </div>
    </>}
  </div>;
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

function setPath(source: Record<string, any>, path: string, value: unknown) {
  const next = structuredClone(source);
  const parts = path.split('.');
  let target: Record<string, any> = next;
  parts.slice(0, -1).forEach((part) => { target[part] = target[part] || {}; target = target[part]; });
  target[parts.at(-1)!] = value;
  return next;
}


const PROXY_REFRESH_ROBOT_ID = 'proxy-refresh';

/**
 * A manual "refresh every country pool", routed through the refresh robot.
 *
 * The robot is the only path that reports per-source progress: the service's
 * `pullAll` takes an `onProgress` callback, the robot handler wires it to the
 * progress the top bar's activity strip renders, and the plain HTTP route does
 * not pass one. Calling that route directly therefore does the same work with
 * no way to show it happening.
 *
 * So both manual buttons send the robot its own `run_now` command instead.
 * Same work, the same guard against two refreshes overlapping, and the bar an
 * operator already recognises — without either page drawing one of its own.
 *
 * Completion is observed rather than awaited, because the run is a background
 * job: when the robot stops running, the catalog is re-read and the caller is
 * handed the finished run to report.
 */
function useProxyRefreshRobot(onFinished: (run: RobotRun | null) => void) {
  const client = useQueryClient();
  const robots = useQuery({ queryKey: ['robots'], queryFn: endpoints.robots, refetchInterval: 2500 });
  // Optional all the way down: a snapshot without a `robots` array must leave
  // the page rendering rather than take it out with a TypeError.
  const robot = robots.data?.robots?.find((entry) => entry.id === PROXY_REFRESH_ROBOT_ID);
  const running = robot?.status === 'running';
  const wasRunning = useRef(false);
  // Held in a ref so a caller's inline callback does not re-arm the effect on
  // every render and replay the completion.
  const finished = useRef(onFinished);
  finished.current = onFinished;
  useEffect(() => {
    if (wasRunning.current && !running) {
      client.invalidateQueries({ queryKey: ['proxies'] });
      finished.current(robot?.lastRun ?? null);
    }
    wasRunning.current = running;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);
  const trigger = useMutation({
    mutationFn: () => endpoints.robotCommand(PROXY_REFRESH_ROBOT_ID, 'run_now'),
    // Ask for the robot list straight away so the button flips to its running
    // state on the click rather than on the next poll.
    onSuccess: () => client.invalidateQueries({ queryKey: ['robots'] }),
  });
  return { running, trigger, pending: trigger.isPending || running };
}

/** The one-line result of a finished pool refresh, named pools and all. */
function proxyRefreshNotice(run: RobotRun | null) {
  const result = run?.result || {};
  const succeeded = Number(result.succeeded || 0);
  const failed = Number(result.failed || 0);
  const pulled = Number(result.pulled || 0);
  if (run?.status === 'failed' && !succeeded) {
    return { tone: 'danger', text: `国家池刷新失败${run.error ? `：${run.error}` : ''}` };
  }
  return {
    tone: failed ? 'warning' : 'success',
    text: `国家池刷新完成：成功 ${succeeded} · 共 ${pulled} 条${failed ? ` · 失败 ${failed}` : ''}`,
  };
}

function ManualProxyEntries({ country, onRemove }: { country: string; onRemove: (entryId: string) => void }) {
  const [offset, setOffset] = useState(0);
  const entries = useQuery({ queryKey: ['proxies', 'entries', country, offset], queryFn: () => endpoints.proxyEntries(country, offset) });
  return <div className="manual-proxy-list">
    {entries.error && <Notice tone="danger">{errorMessage(entries.error)}</Notice>}
    {(entries.data?.items || []).map(entry => <div key={entry.id}><code>{entry.url}</code><IconButton label="删除手工代理" onClick={() => onRemove(entry.id)}><Trash2 size={14} /></IconButton></div>)}
    <Pagination label={`${country} 手工代理分页`} total={entries.data?.total || 0} offset={offset} busy={entries.isFetching} onChange={setOffset} />
  </div>;
}

function ProxyPage() {
  const client = useQueryClient();
  const [proxyOffset, setProxyOffset] = useState(0);
  const proxies = useQuery({ queryKey: ['proxies', 'page', proxyOffset], queryFn: () => endpoints.proxiesPage(proxyOffset) });
  const [localContent, setLocalContent] = useState('');
  const [dynamicContent, setDynamicContent] = useState('');
  const [localProtocol, setLocalProtocol] = useState('http');
  const [dynamicProtocol, setDynamicProtocol] = useState('http');
  const [localMode, setLocalMode] = useState<'append' | 'replace'>('append');
  const [dynamicMode, setDynamicMode] = useState<'append' | 'replace'>('append');
  const [quickProvider, setQuickProvider] = useState('711proxy');
  const [quickCountry, setQuickCountry] = useState('GLOBAL');
  const [quickCount, setQuickCount] = useState(DEFAULT_PROXY_API_COUNT);
  const [quickProtocol, setQuickProtocol] = useState('http');
  const [localPreview, setLocalPreview] = useState<any>(null);
  const [dynamicPreview, setDynamicPreview] = useState<any>(null);
  const [dynamicOverrides, setDynamicOverrides] = useState<Array<{ line: number; countryCode: string; count?: number; protocol: string }>>([]);
  const [notice, setNotice] = useState<{ tone: string; text: string } | null>(null);
  const refresh = () => client.invalidateQueries({ queryKey: ['proxies'] });
  const check = useMutation({
    mutationFn: (ids?: string[]) => endpoints.checkProxies(ids),
    onSuccess: refresh,
    onError: (error) => setNotice({ tone: 'danger', text: errorMessage(error) }),
  });
  const importMutation = useMutation({
    mutationFn: async (body: any) => {
      const { autoPull, ...payload } = body;
      let sourceUrls = new Set<string>();
      if (payload.scope === 'dynamic' && autoPull) {
        const normalized = await endpoints.previewProxies(payload);
        if (normalized.invalid > 0) throw new Error(normalized.errors?.[0]?.message || '代理 API 参数无效');
        sourceUrls = new Set(normalized.items.filter((item: any) => item.kind === 'api').map((item: any) => item.url));
      }
      let snapshot = await endpoints.importProxies(payload) as ProxyCatalogSnapshot;
      const sourceIds = snapshot.dynamic?.countryPools
        .flatMap((pool) => pool.sources)
        .filter((source) => sourceUrls.has(source.url))
        .map((source) => source.id) || [];
      for (const sourceId of sourceIds) snapshot = await endpoints.pullProxySource(sourceId);
      return { snapshot, pulled: sourceIds.length };
    },
    onSuccess: (result, variables: any) => {
      if (variables.scope === 'dynamic') {
        setDynamicContent('');
        setDynamicPreview(null);
        setDynamicOverrides([]);
      } else {
        setLocalContent('');
        setLocalPreview(null);
      }
      void client.invalidateQueries({ queryKey: ['proxies'] });
      setNotice({ tone: 'success', text: result.pulled ? `已构建并拉取 ${result.pulled} 个代理 API 来源` : '代理资源已导入' });
      refresh();
    },
    onError: (error) => { setNotice({ tone: 'danger', text: errorMessage(error) }); refresh(); },
  });
  const quickProviderMeta = PROXY_API_PROVIDER_META[quickProvider];
  const quickPull = useMutation({
    mutationFn: () => endpoints.buildAndPullProxyApi({ provider: quickProvider, countryCode: quickCountry, count: quickCount, protocol: quickProtocol }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['proxies'] });
      setNotice({ tone: 'success', text: `已拉取 ${quickCountry === 'GLOBAL' ? '全球' : quickCountry} 国家池，目标 ${quickCount} 条` });
      refresh();
    },
    onError: (error) => { setNotice({ tone: 'danger', text: errorMessage(error) }); refresh(); },
  });
  const clear = useMutation({
    mutationFn: (scope: 'local' | 'dynamic') => endpoints.clearProxies(scope),
    onSuccess: refresh,
    onError: (error) => setNotice({ tone: 'danger', text: errorMessage(error) }),
  });
  const pull = useMutation({
    mutationFn: (sourceId: string) => endpoints.pullProxySource(sourceId),
    onSuccess: () => { setNotice({ tone: 'success', text: '代理 API 来源已刷新' }); refresh(); },
    onError: (error) => { setNotice({ tone: 'danger', text: errorMessage(error) }); refresh(); },
  });
  const pullAll = useProxyRefreshRobot((run) => setNotice(proxyRefreshNotice(run)));
  const removeDynamic = useMutation({
    mutationFn: endpoints.removeDynamicProxy,
    onSuccess: refresh,
    onError: (error) => setNotice({ tone: 'danger', text: errorMessage(error) }),
  });
  const previewLocal = async () => {
    try {
      setLocalPreview(await endpoints.previewProxies({ content: localContent, defaultProtocol: localProtocol, scope: 'local' }));
    } catch (error) { setNotice({ tone: 'danger', text: errorMessage(error) }); }
  };
  const previewDynamic = async () => {
    try {
      const result = await endpoints.previewProxies({ content: dynamicContent, defaultProtocol: dynamicProtocol, scope: 'dynamic' });
      setDynamicPreview(result);
      setDynamicOverrides(result.items.map((item: any) => ({
        line: item.line,
        countryCode: item.countryCode,
        count: item.kind === 'api' ? item.count : undefined,
        protocol: item.protocol,
      })));
    } catch (error) { setNotice({ tone: 'danger', text: errorMessage(error) }); }
  };
  const updateOverride = (line: number, patch: Partial<{ countryCode: string; count: number; protocol: string }>) => {
    setDynamicOverrides((current) => current.map((item) => item.line === line ? { ...item, ...patch } : item));
  };
  const updateQuickProvider = (provider: string) => {
    const meta = PROXY_API_PROVIDER_META[provider];
    setQuickProvider(provider);
    if (meta?.defaultCount) setQuickCount(meta.defaultCount);
    else if (provider === '711proxy') setQuickCount((current) => Math.min(900, Math.max(1, current)));
    if (meta?.regionalOnly && quickCountry === 'GLOBAL') setQuickCountry('US');
    if (meta) setQuickProtocol(meta.defaultProtocol);
  };
  const local = proxies.data?.local?.proxies || proxies.data?.proxies || [];
  const pools = proxies.data?.dynamic?.countryPools || [];
  const apiSourceCount = pools.reduce((sum, pool) => sum + pool.sources.length, 0);
  const healthy = local.filter((proxy) => proxy.check?.status === 'healthy').length;
  const failed = local.filter((proxy) => proxy.check?.status === 'failed').length;

  return <div className="proxy-page">
    {/* The counts ride in the header instead of a full metric row: this page is
        two tall scrolling panes, and the vertical space is worth more than the
        cards were. Hints move to the tooltip to keep the strip one line. */}
    <PageHeader title="代理资源" description="本地端口独立检测，动态代理按国家合并并由 Worker 使用前检测" actions={
      <div className="proxy-summary-inline">
        <div title={`${healthy} 健康 · ${failed} 失败`}><Radio size={14} /><strong>{proxies.data?.total ?? local.length}</strong><span>本地端口</span></div>
        <div title={`${proxies.data?.dynamic?.total ?? 0} 条已拉取`}><Network size={14} /><strong>{pools.length}</strong><span>国家池</span></div>
        <div title="按代理商构建并拉取"><RefreshCw size={14} /><strong>{apiSourceCount}</strong><span>API 来源</span></div>
      </div>
    } />
    {notice && <Notice tone={notice.tone} floating onClose={() => setNotice(null)} autoDismissToken={notice}>{notice.text}</Notice>}
    <div className="proxy-split-workspace">
      <section className="proxy-pane proxy-local-pane">
        <div className="proxy-pane-header"><div><span className="pane-kicker">LOCAL</span><h2>本地端口</h2><p>固定绑定 Worker，可逐条或批量检测</p></div><div className="pane-actions"><Button icon={check.isPending ? <LoaderCircle className="spin" size={16} /> : <Gauge size={16} />} onClick={() => check.mutate(undefined)} disabled={!local.length || check.isPending}>检测全部</Button><ConfirmDialog trigger={<IconButton label="清空本地端口"><Trash2 size={16} /></IconButton>} title="清空本地端口" description="活动任务使用自身快照，不会受到影响。" danger confirmLabel="清空" onConfirm={() => clear.mutate('local')} /></div></div>
        <div className="proxy-composer">
          <div className="import-toolbar"><div className="segmented"><button className={localMode === 'append' ? 'selected' : ''} onClick={() => setLocalMode('append')}>追加</button><button className={localMode === 'replace' ? 'selected' : ''} onClick={() => setLocalMode('replace')}>替换</button></div><AppSelect className="import-protocol-select" ariaLabel="本地代理默认协议" value={localProtocol} onValueChange={setLocalProtocol} options={[{ value: 'http', label: '默认 HTTP' }, { value: 'socks5', label: '默认 SOCKS5' }]} /></div>
          <textarea value={localContent} onChange={(event) => { setLocalContent(event.target.value); setLocalPreview(null); }} placeholder={'4001\n127.0.0.1:4002\nsocks5://user:pass@127.0.0.1:4003'} />
          {localPreview && <div className="preview-result"><span><Check size={15} />有效 {localPreview.valid}</span><span><AlertTriangle size={15} />错误 {localPreview.invalid}</span><span>重复 {localPreview.duplicate}</span></div>}
          <div className="composer-actions"><Button onClick={previewLocal} disabled={!localContent.trim()}>预览</Button><Button tone="primary" icon={<Upload size={16} />} onClick={() => importMutation.mutate({ scope: 'local', content: localContent, mode: localMode, defaultProtocol: localProtocol })} disabled={!localPreview || localPreview.invalid > 0 || importMutation.isPending}>导入本地端口</Button></div>
        </div>
        <div className="proxy-pane-scroll">
          {local.length ? <div className="proxy-endpoint-list">{local.map((proxy: ProxyRecord) => <div className="proxy-endpoint-row" key={proxy.id}><div><code>{proxy.endpoint}</code><span>{proxy.protocol.toUpperCase()} · {proxy.hasCredentials ? '账号认证' : '无认证'}</span></div><StatusBadge status={proxy.check?.status || 'unknown'} /><span>{proxy.check?.latencyMs == null ? '—' : `${proxy.check.latencyMs} ms`}</span><IconButton label="检测此端口" onClick={() => check.mutate([proxy.id])} disabled={check.isPending}><Gauge size={15} /></IconButton></div>)}</div> : <EmptyState icon={<Radio size={25} />} title="没有本地端口" detail="可直接粘贴端口号，每行一条。" />}
          <Pagination label="本地代理分页" total={proxies.data?.total ?? local.length} offset={proxyOffset} busy={proxies.isFetching} onChange={setProxyOffset} />
        </div>
      </section>

      <section className="proxy-pane proxy-dynamic-pane">
        <div className="proxy-pane-header"><div><span className="pane-kicker">DYNAMIC</span><h2>国家代理池</h2><p>普通代理与代理商 API 可在同一批次粘贴</p></div><Button tone="quiet" title="按国家顺序逐个重新拉取全部 API 来源" icon={pullAll.pending ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />} onClick={() => pullAll.trigger.mutate()} disabled={pullAll.pending || pull.isPending || !apiSourceCount}><span>{pullAll.pending ? '刷新中' : '刷新全部'}</span></Button><ConfirmDialog trigger={<IconButton label="清空国家池"><Trash2 size={16} /></IconButton>} title="清空全部国家池" description="API 来源和已拉取代理都会删除，活动任务快照不受影响。" danger confirmLabel="清空" onConfirm={() => clear.mutate('dynamic')} /></div>
        <div className="proxy-composer dynamic-composer">
          <div className="proxy-quick-builder">
            <div className="quick-field quick-provider-field"><span>代理商</span><AppSelect ariaLabel="代理商" value={quickProvider} onValueChange={updateQuickProvider} options={PROXY_API_PROVIDER_OPTIONS} /></div>
            <div className="quick-field"><span>国家</span><ProxyCountrySelect value={quickCountry} onValueChange={setQuickCountry} includeGlobal={!quickProviderMeta.regionalOnly} /></div>
            <label><span>数量</span><ConfigNumberInput min={1} max={quickProviderMeta.maxCount || (quickProvider === '711proxy' ? 900 : undefined)} value={quickCount} onValueChange={setQuickCount} /></label>
            <div className="quick-field"><span>协议 · {quickProviderMeta.sessionMinutes} 分钟</span><AppSelect ariaLabel="协议" value={quickProtocol} onValueChange={setQuickProtocol} options={[{ value: 'http', label: 'HTTP' }, { value: 'socks5', label: 'SOCKS5' }]} /></div>
            <Button tone="primary" icon={quickPull.isPending ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />} onClick={() => quickPull.mutate()} disabled={quickPull.isPending || !(quickProviderMeta.regionalOnly ? /^[A-Z]{2}$/.test(quickCountry) : /^(GLOBAL|[A-Z]{2})$/.test(quickCountry))}>{quickPull.isPending ? '拉取中' : '构建并拉取'}</Button>
          </div>
          <div className="import-toolbar"><div className="segmented"><button className={dynamicMode === 'append' ? 'selected' : ''} onClick={() => setDynamicMode('append')}>追加</button><button className={dynamicMode === 'replace' ? 'selected' : ''} onClick={() => setDynamicMode('replace')}>替换</button></div><AppSelect className="import-protocol-select" ariaLabel="动态代理默认协议" value={dynamicProtocol} onValueChange={setDynamicProtocol} options={[{ value: 'http', label: '普通代理默认 HTTP' }, { value: 'socks5', label: '普通代理默认 SOCKS5' }]} /></div>
          <textarea value={dynamicContent} onChange={(event) => { setDynamicContent(event.target.value); setDynamicPreview(null); setDynamicOverrides([]); }} placeholder={'host:port:user:pass\nhttps://white.1024proxy.com/white/api?...\nhttps://api.cliproxy.io/white/api?...\nhttp://global.rotgbapi.711proxy.com:8089/gen?...'} />
          {dynamicPreview && <><div className="preview-result"><span><Check size={15} />有效 {dynamicPreview.valid}</span><span><AlertTriangle size={15} />错误 {dynamicPreview.invalid}</span><span>重复 {dynamicPreview.duplicate}</span></div><div className="dynamic-preview-list">{dynamicPreview.items.map((item: any) => { const override = dynamicOverrides.find((candidate) => candidate.line === item.line)!; const provider = PROXY_API_PROVIDER_META[item.provider]; return <div className="dynamic-preview-row" key={item.line}><span className="preview-line">{item.line}</span><div><strong>{item.kind === 'api' ? `${provider?.label || item.provider} API` : '代理'}</strong><code>{item.url}</code></div><input aria-label={`第 ${item.line} 行国家`} value={override?.countryCode || 'GLOBAL'} maxLength={6} onChange={(event) => updateOverride(item.line, { countryCode: event.target.value.toUpperCase() })} />{item.kind === 'api' && <ConfigNumberInput aria-label={`第 ${item.line} 行数量`} min={1} max={PROXY_API_PROVIDER_META[item.provider]?.maxCount || (item.provider === '711proxy' ? 900 : undefined)} value={override?.count || 1} onValueChange={(count) => updateOverride(item.line, { count })} />}<AppSelect ariaLabel={`第 ${item.line} 行协议`} value={override?.protocol || item.protocol} onValueChange={(protocol) => updateOverride(item.line, { protocol })} options={[{ value: 'http', label: 'HTTP' }, { value: 'socks5', label: 'SOCKS5' }]} /></div>; })}</div></>}
          <div className="composer-actions"><Button onClick={previewDynamic} disabled={!dynamicContent.trim()}>识别并预览</Button><Button tone="primary" icon={importMutation.isPending ? <LoaderCircle className="spin" size={16} /> : dynamicPreview?.items?.some((item: any) => item.kind === 'api') ? <RefreshCw size={16} /> : <Upload size={16} />} onClick={() => importMutation.mutate({ scope: 'dynamic', content: dynamicContent, mode: dynamicMode, defaultProtocol: dynamicProtocol, overrides: dynamicOverrides, autoPull: dynamicPreview?.items?.some((item: any) => item.kind === 'api') })} disabled={!dynamicPreview || dynamicPreview.invalid > 0 || importMutation.isPending}>{dynamicPreview?.items?.some((item: any) => item.kind === 'api') ? '导入并拉取' : '合并到国家池'}</Button></div>
        </div>
        <div className="proxy-pane-scroll country-pool-scroll">
          {pools.length ? pools.map((pool) => <div className="country-pool" key={pool.countryCode}><div className="country-pool-heading"><div><span className="country-code">{pool.countryCode === 'GLOBAL' ? '全球' : pool.countryCode}</span><div><strong>{pool.total} 条代理</strong><small>{pool.manualCount} 手工 · {pool.sources.length} API</small></div></div><ConfirmDialog trigger={<IconButton label="删除此国家池"><Trash2 size={15} /></IconButton>} title={`删除 ${pool.countryCode} 代理池`} description="该国家池的手工代理、API 来源和缓存都会删除。" danger confirmLabel="删除" onConfirm={() => removeDynamic.mutate({ countryCode: pool.countryCode })} /></div>{pool.sources.map((source) => { const provider = PROXY_API_PROVIDER_META[source.provider]; return <div className="proxy-source" key={source.id}><div className="source-meta"><div><strong>{provider?.label || source.provider} · {source.protocol.toUpperCase()}</strong><span>{source.count} 条 · 固定 {source.sessionMinutes} 分钟 · 不提前换 IP</span></div><StatusBadge status={source.lastError ? 'failed' : source.lastPulledAt ? 'healthy' : 'unknown'} /></div><code>{source.url}</code><div className="source-footer"><span>{source.lastPulledAt ? `${formatTime(source.lastPulledAt)} · ${source.cachedCount} 条` : '尚未拉取'}</span>{source.lastError && <span className="source-error">{source.lastError}</span>}<div><Button icon={pull.isPending && pull.variables === source.id ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />} onClick={() => pull.mutate(source.id)} disabled={pull.isPending}>{source.lastPulledAt ? '刷新' : '拉取'}</Button><ConfirmDialog trigger={<IconButton label="删除 API 来源"><Trash2 size={15} /></IconButton>} title="删除 API 来源" description="只删除此 URL 及其上次拉取结果。" danger confirmLabel="删除" onConfirm={() => removeDynamic.mutate({ countryCode: pool.countryCode, sourceId: source.id })} /></div></div></div>; })}{pool.manualCount > 0 && <ManualProxyEntries country={pool.countryCode} onRemove={(entryId) => removeDynamic.mutate({ countryCode: pool.countryCode, entryId })} />}</div>) : <EmptyState icon={<Network size={25} />} title="没有国家代理池" detail="未识别国家的代理会自动归入全球池。" />}
        </div>
      </section>
    </div>
  </div>;
}

// 日志分批加载历史并接收 SSE 增量；浏览器保留量与后端日志上限一致。
const MAX_LOG_RECORDS = 10000;

const SECURITY_LOG_LABELS: Record<string, string> = {
  security_reauth_started: '安全重认证开始',
  security_reauth_required: '需要安全重认证',
  security_reauth_email_boundary_captured: '安全重认证邮箱基线已建立',
  security_reauth_email_otp_sent: '安全重认证等待邮箱 OTP',
  security_reauth_email_otp_resumed: '继续等待安全重认证邮箱 OTP',
  security_reauth_email_otp_received: '收到安全重认证邮箱 OTP',
  security_reauth_email_otp_validated: '安全重认证邮箱 OTP 已验证',
  security_reauth_completed: '安全重认证完成',
  security_reauth_failed: '安全重认证失败',
  totp_setup_started: 'TOTP 设置开始',
  totp_setup_deferred: 'TOTP 设置暂缓',
  totp_setup_failed: 'TOTP 设置失败',
  totp_configured: 'TOTP 设置完成',
  password_setup_started: '密码设置开始',
  password_setup_failed: '密码设置失败',
  password_configured: '密码设置完成',
  password_set_during_registration: '注册时已直接设置密码（省下一封邮件）',
  password_during_registration_unavailable: '注册时设密码不可用，回落到事后补设',
};

function semanticLogType(record: LogRecord) {
  const type = String(record.type || '');
  if (type === 'checkpoint' && String(record.message || '').startsWith('security_reauth:')) return '安全重认证流程';
  return SECURITY_LOG_LABELS[type] || type;
}

function semanticLogMessage(record: LogRecord) {
  const type = String(record.type || '');
  const message = String(record.message || '');
  if (type === 'checkpoint' && message.startsWith('security_reauth:')) {
    const reason = message.slice('security_reauth:'.length);
    return SECURITY_LOG_LABELS[reason] || `安全重认证：${reason}`;
  }
  if (!message || message === type) return SECURITY_LOG_LABELS[type] || message || type;
  return message;
}

/**
 * Appends a batch of records, keeping the list ordered by `seq` and bounded.
 *
 * `seq` is monotonic and the server emits in order, so the batch is almost
 * always strictly newer than everything held — the fast path just appends. A
 * `logReset` record is the exception: the server has cleared the previous
 * 10,000-record history and this record starts the new visible history.
 * The general path below still covers a replay or an out-of-order arrival.
 */
function mergeLogRecords(current: LogRecord[], incoming: LogRecord[]) {
  if (!incoming.length) return current;
  const resetIndex = incoming.findIndex((record) => record.logReset === true);
  if (resetIndex >= 0) {
    current = [];
    incoming = incoming.slice(resetIndex);
  }
  const highest = current.length ? current[current.length - 1].seq : -Infinity;
  let ordered = true;
  let previous = highest;
  for (const record of incoming) {
    if (record.seq <= previous) { ordered = false; break; }
    previous = record.seq;
  }
  if (ordered) {
    const next = current.concat(incoming);
    return next.length > MAX_LOG_RECORDS ? next.slice(-MAX_LOG_RECORDS) : next;
  }
  const records = new Map(current.map((record) => [record.seq, record]));
  let changed = false;
  for (const record of incoming) {
    if (records.has(record.seq)) continue;
    records.set(record.seq, record);
    changed = true;
  }
  if (!changed) return current;
  return [...records.values()].sort((left, right) => left.seq - right.seq).slice(-MAX_LOG_RECORDS);
}

/**
 * One lowercased string per record, built once and reused for every keystroke.
 *
 * Searching used to `JSON.stringify` every record — including its whole details
 * blob — and lowercase the result, per record per keystroke. Five thousand
 * serializations for one typed character, with no debounce, synchronously
 * before the input could even repaint.
 */
const logHaystacks = new WeakMap<LogRecord, string>();

function logHaystack(record: LogRecord) {
  const cached = logHaystacks.get(record);
  if (cached !== undefined) return cached;
  const haystack = JSON.stringify(record).toLowerCase();
  logHaystacks.set(record, haystack);
  return haystack;
}

function useRunLogs(runId: string) {
  const [cursor, setCursor] = useState('');
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [logError, setLogError] = useState('');
  const currentRun = useRef(runId); currentRun.current = runId;
  const [records, setRecords] = useState<LogRecord[]>([]);
  useEffect(() => {
    if (!runId) { setRecords([]); return; }
    let cancelled = false;
    let flushTimer = 0;
    let pending: LogRecord[] = [];
    const flush = () => {
      flushTimer = 0;
      const batch = pending;
      pending = [];
      if (!cancelled && batch.length) setRecords((current) => mergeLogRecords(current, batch));
    };
    setRecords([]);
    setCursor(''); setLogError(''); setLoadingOlder(false);
    endpoints.logPage(runId).then(({ logs, cursor }) => {
      if (!cancelled) { setRecords((current) => mergeLogRecords(current, logs)); setCursor(cursor || ''); }
    }).catch(error => { if (!cancelled) setLogError(errorMessage(error)); });
    const source = new EventSource(`/api/v1/runs/${encodeURIComponent(runId)}/events?reveal=1&tail=1`);
    source.addEventListener('log', (event) => {
      try {
        pending.push(JSON.parse((event as MessageEvent).data) as LogRecord);
        if (!flushTimer) flushTimer = window.setTimeout(flush, 60);
      } catch { /* Ignore malformed SSE records and keep the stream alive. */ }
    });
    return () => {
      cancelled = true;
      if (flushTimer) window.clearTimeout(flushTimer);
      source.close();
    };
  }, [runId]);
  const loadOlder = async () => {
    if (!cursor || loadingOlder) return;
    setLoadingOlder(true); setLogError('');
    try {
      const page = await endpoints.logPage(runId, cursor);
      if (currentRun.current !== runId) return;
      setRecords(current => mergeLogRecords(current, page.logs)); setCursor(page.cursor || '');
    } catch (error) { if (currentRun.current === runId) setLogError(errorMessage(error)); }
    finally { if (currentRun.current === runId) setLoadingOlder(false); }
  };
  return { records, cursor, loadingOlder, loadOlder, logError };
}

function RunLogPanel({ runId }: { runId: string }) {
  const [sourceFilter, setSourceFilter] = useState('all');
  const [levelFilter, setLevelFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [clearedThrough, setClearedThrough] = useState(0);
  const [followTail, setFollowTail] = useState(true);
  const { records, cursor, loadingOlder, loadOlder, logError } = useRunLogs(runId);
  // The old button only filtered by `seq` on the client, so the file was
  // untouched and a refresh brought every line back. It deletes for real now;
  // the local marker still runs so the view empties without waiting for the
  // stream to catch up.
  const clearLogs = useMutation({
    mutationFn: () => endpoints.clearLogs(runId),
    onSuccess: () => setClearedThrough(Math.max(0, ...records.map((record) => record.seq))),
  });
  const visibleRecords = useMemo(() => records.filter((record) => record.seq > clearedThrough), [records, clearedThrough]);
  const needle = useMemo(() => query.trim().toLowerCase(), [query]);
  const filtered = useMemo(() => visibleRecords.filter((record) => (sourceFilter === 'all' || record.source === sourceFilter) && (levelFilter === 'all' || record.level === levelFilter) && (!needle || logHaystack(record).includes(needle))), [visibleRecords, sourceFilter, levelFilter, needle]);
  const parentRef = useRef<HTMLDivElement>(null);
  const previousCount = useRef(0);
  const virtual = useVirtualizer({ count: filtered.length, getScrollElement: () => parentRef.current, estimateSize: () => 58, getItemKey: (index) => filtered[index]?.seq ?? index, overscan: 16 });
  // Rebuilt on every render otherwise, over as many as five thousand records,
  // on a page that re-renders every 1.5 s and on every log flush.
  const sources = useMemo(() => [...new Set(visibleRecords.map((record) => record.source))], [visibleRecords]);
  const scrollTo = (edge: 'top' | 'bottom', behavior: ScrollBehavior = 'smooth') => {
    const element = parentRef.current;
    if (!element) return;
    const top = edge === 'top' ? 0 : element.scrollHeight;
    if (typeof element.scrollTo === 'function') element.scrollTo({ top, behavior });
    else element.scrollTop = top;
  };
  useEffect(() => {
    setClearedThrough(0);
    setFollowTail(true);
  }, [runId]);
  useLayoutEffect(() => {
    const before = previousCount.current;
    previousCount.current = filtered.length;
    if (!followTail || !filtered.length) return;
    const frame = requestAnimationFrame(() => {
      const element = parentRef.current;
      if (!element) return;
      scrollTo('bottom', before === 0 ? 'auto' : 'smooth');
    });
    return () => cancelAnimationFrame(frame);
  }, [filtered.length, followTail]);
  const download = () => {
    const blob = new Blob([`${filtered.map((record) => JSON.stringify(record)).join('\n')}\n`], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${runId}-logs.jsonl`; anchor.click(); URL.revokeObjectURL(url);
  };
  return <section className="workspace-band run-log-band">
    <div className="section-heading">
      <div><h2>实时运行日志</h2><p>每次加载 200 条；搜索和下载针对已加载日志</p></div>
      <div className="log-heading-actions">
        <span className="log-count">已加载 {filtered.length} 条</span>
        {cursor && !clearedThrough && <Button disabled={loadingOlder} onClick={() => { setFollowTail(false); void loadOlder(); }}>{loadingOlder ? '加载中…' : '加载更早日志'}</Button>}
        <ConfirmDialog trigger={<IconButton label="清空该任务日志" disabled={!visibleRecords.length || clearLogs.isPending}><Eraser size={16} /></IconButton>} title="清空该任务日志" description={`将从磁盘删除这个任务的全部日志（包括未加载部分），运行状态和产物不受影响。`} danger confirmLabel="确认清空" onConfirm={() => clearLogs.mutate()} />
        <IconButton label={followTail ? '关闭实时跟随' : '开启实时跟随'} aria-pressed={followTail} className={followTail ? 'icon-button-active' : ''} onClick={() => setFollowTail((current) => { const next = !current; if (next) requestAnimationFrame(() => scrollTo('bottom')); return next; })}><Radio size={16} /></IconButton>
        <IconButton label="回到日志底部" onClick={() => { setFollowTail(true); scrollTo('bottom'); }} disabled={!filtered.length}><ChevronsDown size={16} /></IconButton>
        <IconButton label="下载已加载 JSONL" onClick={download} disabled={!filtered.length}><Download size={16} /></IconButton>
      </div>
    </div>
    {logError && <Notice tone="danger">{logError}</Notice>}
    <div className="log-toolbar run-log-toolbar"><AppSelect ariaLabel="日志级别" value={levelFilter} onValueChange={setLevelFilter} options={[{ value: 'all', label: '全部级别' }, { value: 'info', label: 'Info' }, { value: 'error', label: 'Error' }]} /><AppSelect ariaLabel="日志来源" value={sourceFilter} onValueChange={setSourceFilter} options={[{ value: 'all', label: '全部来源' }, ...sources.map((source) => ({ value: source, label: source }))]} /><input aria-label="搜索日志" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索事件、阶段或 Job" /></div>
    <div className="log-view run-log-view" ref={parentRef} tabIndex={0} aria-label="运行日志列表" onWheel={(event) => { if (event.deltaY < 0) setFollowTail(false); }} onTouchStart={() => setFollowTail(false)} onPointerDown={(event) => { if (event.target === event.currentTarget) setFollowTail(false); }} onKeyDown={(event) => { if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) setFollowTail(false); }} onScroll={(event) => { const element = event.currentTarget; if (!followTail && element.scrollHeight - element.clientHeight - element.scrollTop <= 16) setFollowTail(true); }}>{filtered.length ? <div style={{ height: `${virtual.getTotalSize()}px`, position: 'relative' }}>{virtual.getVirtualItems().map((row) => { const record = filtered[row.index]; return <div className={`log-row run-log-row log-${record.level}`} key={record.seq} style={{ transform: `translateY(${row.start}px)` }}><div className="log-meta"><time>{new Date(record.at).toLocaleTimeString('zh-CN', { hour12: false })}</time><span className="log-source">{record.source}</span><span className="log-type" title={record.type}>{semanticLogType(record)}</span>{record.jobId && <small title={record.jobId}>{record.jobId}</small>}</div><span className="log-message" title={record.message}>{semanticLogMessage(record)}</span></div>; })}</div> : <EmptyState icon={<ScrollText size={24} />} title={clearedThrough ? '日志已清空' : '暂无运行日志'} detail={clearedThrough ? '磁盘上的记录已删除，新事件到达后会继续实时显示。' : '该任务产生事件后会在这里实时显示。'} />}</div>
  </section>;
}

const CPA_LIFECYCLE_LABELS: Record<string, string> = { active: '在库', planned: '计划卖出', self_use: '自用', sold: '已卖出', none: '未归类' };

const CPA_LOCKED_LABEL = '\u5df2\u9501\u5b9a';
const CPA_LOCK_BATCH_LABEL = '\u9501\u5b9a\u6279\u6b21';
const CPA_UNLOCK_BATCH_LABEL = '\u89e3\u9501\u6279\u6b21';

/** Keep delivery markers, labels and batch grouping on one source of truth. */
const ARTIFACT_DELIVERY_FIELDS = [
  ['cpaExportedAt', 'CPA'],
  ['sub2ApiExportedAt', 'sub2api'],
  ['sub2ApiPushedAt', '推送'],
  ['nvtokensCardsImportedAt', 'nvtokens JSON'],
  ['nvtokensMailboxesImportedAt', 'nvtokens 邮箱'],
  ['nvtokensCardsPooledAt', 'nvtokens 入池'],
] as const satisfies ReadonlyArray<[keyof CpaArtifact, string]>;

type ArtifactDeliveryEntry = { label: string; at: string };

function artifactDeliveryEntries(artifact: CpaArtifact): ArtifactDeliveryEntry[] {
  return ARTIFACT_DELIVERY_FIELDS.flatMap(([field, label]) => {
    const at = artifact[field];
    return at ? [{ label, at }] : [];
  });
}

/**
 * Never sent anywhere, or sent and then rewritten.
 *
 * The server stamps each marker only for the artifact version it actually
 * sent, so a regenerated CPA loses them and counts as new again — which is
 * what an operator means by "the latest ones".
 *
 * A push to the gateway counts as leaving, the same as a download: the three
 * ledgers stay separate server-side because they answer different questions,
 * but 最新 asks only whether this version has gone anywhere yet.
 */
function isUnexportedArtifact(artifact: CpaArtifact) {
  return artifact.locked !== true && ARTIFACT_DELIVERY_FIELDS.every(([field]) => !artifact[field]);
}

/** A CPA file's shelf is its login-state asset's lifecycle; unlinked files are uncategorised. */
const CPA_BUCKETS = ['active', 'planned', 'self_use', 'sold'] as const;
type CpaBucket = (typeof CPA_BUCKETS)[number] | 'none';

function cpaLifecycleBucket(artifact: CpaArtifact): CpaBucket {
  return CPA_BUCKETS.find((bucket) => bucket === artifact.lifecycle) ?? 'none';
}

/** The shelves that answer "where does this account go" on their own. */
const SETTLED_BUCKETS = new Set<CpaBucket>(['planned', 'self_use', 'sold']);

/**
 * 最新 means "still waiting to be dealt with", not merely "unexported".
 *
 * Shelving a CPA as 计划卖出, 自用 or 已卖出 settles where that account goes just
 * as an export marker does, so the file leaves the tab even when no ledger ever
 * stamped it — an account sold or kept by hand is not something new to look at.
 * `active` is the only shelf that is still an open question, which is why 在库
 * and unclassified files are the ones the tab keeps.
 */
function isFreshArtifact(artifact: CpaArtifact) {
  return artifact.locked !== true && isUnexportedArtifact(artifact) && !SETTLED_BUCKETS.has(cpaLifecycleBucket(artifact));
}

type ArtifactDeliveryGroup = {
  key: string;
  deliveryAt: string;
  locked: boolean;
  rows: Array<{ artifact: CpaArtifact; index: number }>;
};

/** The name a row answers to when it carries no file-level key. */
function artifactPairKey(item: Partial<CpaArtifactItem>) {
  return `${item.runId || ''}:${item.jobId || ''}`;
}

function artifactSelectionKey(artifact: CpaArtifactSelectionItem) {
  // The file-level key is the row's real identity; runId:jobId can collide when
  // one job's CPA exists at two paths. Fall back to the pair for safety only.
  return artifact.key || artifactPairKey(artifact);
}

type CpaArtifactsPayload = { artifacts: CpaArtifact[]; typeCounts?: Record<string, number>; lifecycleCounts?: Record<string, number> } & Partial<PageInfo>;
type CpaArtifactItem = CpaArtifactSelectionItem;

/**
 * Every name a row answers to: the file key is the real one, and the run/job
 * pair stays addressable because a server that predates the key reports rows
 * by it alone.
 */
function artifactLookupKeys(item: Partial<CpaArtifactItem>) {
  const pair = artifactPairKey(item);
  return item.key ? [item.key, pair] : [pair];
}

function patchCpaLockState(
  current: CpaArtifactsPayload | undefined,
  items: CpaArtifactItem[],
  locked: boolean,
  batchKey = '',
) {
  if (!current) return current;
  const selected = new Set(items.map(artifactSelectionKey));
  const lockedAt = new Date().toISOString();
  return {
    ...current,
    artifacts: current.artifacts.map((artifact) => {
      if (!selected.has(artifactSelectionKey(artifact))) return artifact;
      if (!locked) {
        const { locked: _locked, lockedAt: _lockedAt, lockBatchKey: _lockBatchKey, ...unlocked } = artifact;
        return unlocked;
      }
      return {
        ...artifact,
        locked: true,
        lockedAt: artifact.lockedAt || lockedAt,
        lockBatchKey: batchKey || artifact.lockBatchKey,
      };
    }),
  };
}

type NvtokensPushKind = 'cards' | 'mailboxes' | 'pool';
type NvtokensSelectionItem = CpaArtifactItem;
type NvtokensPushRequest =
  | { kind: 'cards' | 'mailboxes'; items: NvtokensSelectionItem[] }
  | { kind: 'pool'; items: NvtokensSelectionItem[]; priceYuan: number };

const NVTOKENS_PUSH_LABELS: Record<NvtokensPushKind, string> = {
  cards: 'nvtokens JSON',
  mailboxes: 'nvtokens 邮箱凭证',
  pool: 'nvtokens 入池',
};

/**
 * The three ways a sold account can go to nvtokens, as one choice.
 *
 * They used to be three buttons side by side, each with its own count and its
 * own idea of what "already sent" meant — only 入池 filtered rows it had sent
 * before, so the other two would happily push the same account twice. One
 * picker and one button, with every kind filtering against its own ledger.
 */
const NVTOKENS_KINDS: Record<NvtokensPushKind, {
  label: string;
  title: string;
  description: (count: number, skipped: number) => string;
  confirmLabel: string;
  icon: typeof Upload;
}> = {
  pool: {
    label: '入池',
    title: '推送并入 nvtokens 号池',
    description: (count, skipped) => `按设定价格把 ${count} 个账号推入 nvtokens 号池（读取登录态里的邮箱、密码和长期 2FA）。${skipped ? `另有 ${skipped} 个已入池过，跳过。` : ''}平台接收成功即记为已导出。`,
    confirmLabel: '确认入池',
    icon: Archive,
  },
  mailboxes: {
    label: '邮箱凭证',
    title: '推送邮箱----密码----2FA',
    description: (count, skipped) => `把 ${count} 个账号以 邮箱----密码----2FA 格式推送到 nvtokens。${skipped ? `另有 ${skipped} 个已推送过，跳过。` : ''}平台接收成功即记为已导出。`,
    confirmLabel: '确认推送',
    icon: KeyRound,
  },
  cards: {
    label: 'JSON',
    title: '推送 nvtokens JSON',
    description: (count, skipped) => `把 ${count} 个 CPA JSON 推送到 nvtokens 卡片库存。${skipped ? `另有 ${skipped} 个已推送过，跳过。` : ''}平台接收成功即记为已导出。`,
    confirmLabel: '确认推送',
    icon: Upload,
  },
};
const NVTOKENS_KIND_ORDER: NvtokensPushKind[] = ['pool', 'mailboxes', 'cards'];
/** The ledger stamp each kind sets: what "already sent this way" means. */
const NVTOKENS_STAMP_FIELD = {
  cards: 'nvtokensCardsImportedAt',
  mailboxes: 'nvtokensMailboxesImportedAt',
  pool: 'nvtokensCardsPooledAt',
} as const satisfies Record<NvtokensPushKind, keyof CpaArtifact>;
const NVTOKENS_KIND_KEY = 'gpt-re.history.nvtokens-kind';

function readNvtokensKind(): NvtokensPushKind {
  try {
    const stored = window.localStorage.getItem(NVTOKENS_KIND_KEY);
    return NVTOKENS_KIND_ORDER.includes(stored as NvtokensPushKind) ? stored as NvtokensPushKind : 'pool';
  } catch {
    return 'pool';
  }
}

/** Splits a selection into rows not yet sent this way, and rows already sent. */
function splitNvtokensFresh(kind: NvtokensPushKind, artifacts: CpaArtifact[]) {
  const field = NVTOKENS_STAMP_FIELD[kind];
  const fresh: CpaArtifact[] = [];
  const sent: CpaArtifact[] = [];
  for (const artifact of artifacts) (artifact[field] ? sent : fresh).push(artifact);
  return { fresh, sent };
}

function createNvtokensPushRequest(
  kind: NvtokensPushKind,
  items: NvtokensSelectionItem[],
  priceYuan: number,
): NvtokensPushRequest {
  return kind === 'pool' ? { kind, items, priceYuan } : { kind, items };
}

function pushNvtokensRequest(request: NvtokensPushRequest, selection: CpaExportSelection) {
  switch (request.kind) {
    case 'cards':
      return endpoints.pushNvtokensCards(selection);
    case 'mailboxes':
      return endpoints.pushNvtokensMailboxes(selection);
    case 'pool':
      return endpoints.pushNvtokensPool({ ...selection, priceYuan: request.priceYuan });
  }
}

const UNDELIVERED_DELIVERY_GROUP = 'undelivered';

/**
 * The card grid's geometry, mirrored from `.artifact-scroll` in the stylesheet.
 *
 * The grid is `repeat(auto-fill, minmax(240px, 1fr))`, so the browser decides
 * how many cards fit. Windowing has to know that number to chunk the list into
 * visual rows, and the only way to know it is to apply the same rule to the
 * measured width. The two must stay in step; CSS is the source of truth.
 */
const ARTIFACT_CARD_MIN_WIDTH = 240;
const ARTIFACT_GRID_GAP = 10;
/** Starting guesses only — every rendered row reports its real height back. */
const ARTIFACT_CARD_ROW_HEIGHT = 142;
const ARTIFACT_DIVIDER_ROW_HEIGHT = 48;
/**
 * Cards to lay out in flow while the scroll container has no measured height.
 *
 * That is every first commit — the ref is still null when the virtualizer
 * first runs — and it is also every environment without layout, such as the
 * test renderer. Rendering the whole list at that moment would build the
 * thousands of nodes the windowing exists to avoid, and rendering none of it
 * would leave the page blank wherever heights are never reported.
 *
 * Counted in cards rather than rows, because a row is one card on a narrow
 * panel and four on a wide one: the budget is about how many nodes one
 * unmeasured paint may build, which does not change with the column count.
 */
const UNMEASURED_ARTIFACT_CARD_BUDGET = 60;

type ArtifactVirtualRow =
  | { kind: 'divider'; key: string; group: ArtifactDeliveryGroup; collapseKey: string; collapsed: boolean }
  | { kind: 'cards'; key: string; group: ArtifactDeliveryGroup; collapsible: boolean; cards: ArtifactDeliveryGroup['rows'] };

/** The most recent delivery event for the artifact's current bytes. */
function artifactDeliveryAt(artifact: CpaArtifact) {
  return artifactDeliveryEntries(artifact)
    .map(({ at }) => at)
    .sort((left, right) => {
      const leftTime = Date.parse(left);
      const rightTime = Date.parse(right);
      return (Number.isFinite(leftTime) ? leftTime : Number.POSITIVE_INFINITY)
        - (Number.isFinite(rightTime) ? rightTime : Number.POSITIVE_INFINITY);
    })
    .at(-1) || '';
}

/** Group settled shelves by the batch timestamp that last delivered them. */
function artifactDeliveryGroups(artifacts: CpaArtifact[], enabled: boolean): ArtifactDeliveryGroup[] {
  const rows = artifacts.map((artifact, index) => ({ artifact, index }));
  if (!enabled) return [{ key: 'all', deliveryAt: '', locked: false, rows }];
  const groups = new Map<string, ArtifactDeliveryGroup>();
  for (const row of rows) {
    const deliveryAt = artifactDeliveryAt(row.artifact);
    const key = deliveryAt || UNDELIVERED_DELIVERY_GROUP;
    let group = groups.get(key);
    if (!group) {
      group = { key, deliveryAt, locked: true, rows: [] };
      groups.set(key, group);
    }
    group.rows.push(row);
    if (row.artifact.locked !== true) group.locked = false;
  }
  return [...groups.values()].sort((left, right) => {
    if (!left.deliveryAt) return right.deliveryAt ? -1 : 0;
    if (!right.deliveryAt) return 1;
    const leftTime = Date.parse(left.deliveryAt);
    const rightTime = Date.parse(right.deliveryAt);
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) return rightTime - leftTime;
    return right.deliveryAt.localeCompare(left.deliveryAt);
  });
}

// The non-terminal states a run can sit in while still holding its task slot.
const SLOT_HOLDER_LABELS: Record<string, string> = { paused: '已暂停', waiting: '等待中', running: '运行中' };

const OAUTH_RELOGIN_KEY = 'gpt-re.oauth-relogin-emails';
const CPA_DELIVERY_NOTES_KEY = 'gpt-re.cpa-delivery-notes';
const CPA_DELIVERY_NOTE_MAX_LENGTH = 80;

/**
 * What the 已卖出 → 未导出 count export hands over.
 *
 * 邮箱凭证 leads and is the default because it is what a buyer is actually
 * handed — one `email----password----2FA` line per account. CPA and sub are
 * the same accounts in the two machine formats, offered here so a batch bound
 * for a gateway no longer has to be picked row by row first.
 */
const SOLD_EXPORT_FORMATS = [
  { value: 'credentials', label: '邮箱凭证' },
  { value: 'cpa', label: 'CPA' },
  { value: 'sub2api', label: 'sub' },
  { value: 'nvpool', label: 'nv 入池' },
] as const;
type SoldExportFormat = (typeof SOLD_EXPORT_FORMATS)[number]['value'];
const SOLD_EXPORT_FORMAT_LABELS = Object.fromEntries(
  SOLD_EXPORT_FORMATS.map(({ value, label }) => [value, label]),
) as Record<SoldExportFormat, string>;
/** Which ledger each format stamps, which is what moves rows out of 未导出. */
const SOLD_EXPORT_FORMAT_HINTS: Record<SoldExportFormat, string> = {
  credentials: '导出 邮箱----密码----2FA 文本，记入 CPA 导出账本；导出后这些产物离开「未导出」',
  cpa: '导出合并的 CPA JSON，记入 CPA 导出账本；导出后这些产物离开「未导出」',
  sub2api: '导出 sub2api JSON，记入 sub2api 导出账本；导出后这些产物离开「未导出」',
  nvpool: '按设定价格推入 nvtokens 号池，记入 nvtokens 账本；推送成功后这些产物离开「未导出」',
};
const SOLD_EXPORT_FORMAT_KEY = 'gpt-re.history.sold-export-format';
/**
 * The cap every one of the three endpoints enforces server-side. Clamping the
 * input to it turns what used to surface as a 400 into a bound the operator
 * can see before pressing the button.
 */
const CPA_EXPORT_BATCH_LIMIT = 1000;

/** A standing preference: the format an operator sells in rarely changes. */
function readSoldExportFormat(): SoldExportFormat {
  try {
    const stored = window.localStorage.getItem(SOLD_EXPORT_FORMAT_KEY);
    return SOLD_EXPORT_FORMATS.some((format) => format.value === stored)
      ? stored as SoldExportFormat
      : 'credentials';
  } catch {
    return 'credentials';
  }
}

function readCpaDeliveryNotes(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(CPA_DELIVERY_NOTES_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const notes: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string' && value.trim()) notes[key] = value.slice(0, CPA_DELIVERY_NOTE_MAX_LENGTH);
    }
    return notes;
  } catch {
    return {};
  }
}

/**
 * Artifacts per push request.
 *
 * Small enough that a few hundred accounts cannot outlive one request's
 * timeout, and that the progress bar moves often enough to read as progress;
 * large enough that the per-request overhead stays negligible.
 */
/** One account a push did not send, and why. */
type PushOutcomeLine = { email: string; reason: string };
type PushTotals = { pushed: number; failed: number; skipped: number; errors: string[]; lines: PushOutcomeLine[] };
type PushOutcome = {
  label: string;
  tone: 'success' | 'warning' | 'danger';
  at: number;
  summary: string;
  lines: PushOutcomeLine[];
  errors: string[];
};

function emptyPushTotals(): PushTotals {
  return { pushed: 0, failed: 0, skipped: 0, errors: [], lines: [] };
}

/**
 * Fold a refused batch into the totals instead of aborting the whole push.
 *
 * Pushes go out in batches, and a batch the server refuses used to throw
 * straight out of the loop: 67 accounts selected, the first two batches
 * accepted, the third refused for one account without a long-lived 2FA
 * secret, and 17 accounts gone without one of them being named. The batch is
 * now recorded account by account — from the server's own per-record reasons
 * when it sent them — and the remaining batches still go.
 */
function collectBatchFailure(
  totals: PushTotals,
  batch: CpaArtifactItem[],
  error: unknown,
  emailOf: (item: Partial<CpaArtifactItem>) => string,
) {
  const reason = errorMessage(error);
  const reported = (error as { details?: { skipped?: Array<{ runId?: string; jobId?: string; key?: string; email?: string; reason?: string }> } } | null)
    ?.details?.skipped;
  totals.skipped += batch.length;
  if (Array.isArray(reported) && reported.length) {
    // Identity, not naming. A row is the same row only when its file-level key
    // matches; the run/job pair is a name a legacy server answers to and two
    // files can share one. Folding the pair into the same set would let the row
    // the server named stand in for its twin and drop the twin from the list
    // below, which is how the pair collided in the first place.
    const namedKeys = new Set<string>();
    const namedPairs = new Set<string>();
    for (const item of reported) {
      const ref = { runId: item.runId || '', jobId: item.jobId || '', key: item.key };
      if (item.key) namedKeys.add(item.key);
      namedPairs.add(artifactPairKey(ref));
      totals.lines.push({
        email: item.email || emailOf(ref),
        reason: item.reason || reason,
      });
    }
    // The server names the record it objected to; everything else in the batch
    // was refused with it. Listing only the named one would show "1 account"
    // beside a count of 25 and send the operator looking for the other 24.
    for (const item of batch) {
      const alreadyNamed = item.key ? namedKeys.has(item.key) : namedPairs.has(artifactPairKey(item));
      if (alreadyNamed) continue;
      totals.lines.push({ email: emailOf(item), reason: '同批次被一并退回' });
    }
    return;
  }
  for (const item of batch) totals.lines.push({ email: emailOf(item), reason });
}

function buildPushOutcome(label: string, requested: number, totals: PushTotals): PushOutcome {
  const parts = [`已推送 ${totals.pushed}/${requested}`];
  if (totals.failed) parts.push(`平台拒收 ${totals.failed}`);
  if (totals.skipped) parts.push(`未发出 ${totals.skipped}`);
  return {
    label,
    tone: totals.pushed === 0 ? 'danger' : (totals.failed || totals.skipped ? 'warning' : 'success'),
    at: Date.now(),
    summary: parts.join(' · '),
    lines: totals.lines,
    errors: totals.errors,
  };
}

function failedPushOutcome(label: string, error: unknown): PushOutcome {
  return { label, tone: 'danger', at: Date.now(), summary: errorMessage(error), lines: [], errors: [] };
}

/**
 * The credential export refuses the whole selection when a row is incomplete,
 * and the refusal carries the rows. Show them the same way a push does rather
 * than flashing an English count with no account in it.
 */
function exportFailureOutcome(label: string, error: unknown, emailOf?: (item: Partial<CpaArtifactItem>) => string): PushOutcome {
  const reported = (error as { details?: { missing?: Array<{ email?: string; reason?: string; runId?: string; jobId?: string; key?: string }> } } | null)
    ?.details?.missing;
  const lines = Array.isArray(reported)
    ? reported.map((item) => ({
      email: String(item.email || emailOf?.(item) || [item.runId, item.jobId].filter(Boolean).join('/') || ''),
      reason: String(item.reason || ''),
    }))
    : [];
  return {
    label,
    tone: 'danger',
    at: Date.now(),
    summary: lines.length ? `${lines.length} 个账号凭证不全，整批未导出` : errorMessage(error),
    lines,
    errors: [],
  };
}

const SUB2API_PUSH_BATCH = 25;
const NVTOKENS_PUSH_BATCH = 25;
/**
 * One export request's worth of accounts.
 *
 * An export reads every selected CPA file and every login state behind it, so a
 * thousand accounts in one request is a long silence with nothing to show and
 * one timeout away from delivering none of them. Small enough that a request
 * stays well inside its timeout and the bar moves often enough to read as
 * progress; large enough that resolving the selection and rewriting the export
 * ledger stay amortised across a batch.
 */
const CPA_EXPORT_BATCH = 100;

function cpaExportBatches(items: CpaArtifactItem[]) {
  const batches: CpaArtifactItem[][] = [];
  for (let offset = 0; offset < items.length; offset += CPA_EXPORT_BATCH) {
    batches.push(items.slice(offset, offset + CPA_EXPORT_BATCH));
  }
  return batches;
}

/** The same result line a push leaves, in an export's words. */
function buildExportOutcome(label: string, requested: number, exported: number, lines: PushOutcomeLine[]): PushOutcome {
  const parts = [`已导出 ${exported}/${requested}`];
  if (lines.length) parts.push(`未导出 ${lines.length}`);
  return {
    label,
    tone: exported === 0 ? 'danger' : (lines.length ? 'warning' : 'success'),
    at: Date.now(),
    summary: parts.join(' · '),
    lines,
    errors: [],
  };
}
const MAX_SESSION_ASSET_BATCH_SIZE = 500;

/**
 * The address list the console hands to the launch page for a direct re-login.
 *
 * `sessionStorage` rather than a query string: the payload can run to
 * thousands of characters, and it is a one-shot handoff between two pages of
 * the same tab, not a location worth sharing or reloading into.
 */
function stashReloginEmails(emails: string[]) {
  try { window.sessionStorage.setItem(OAUTH_RELOGIN_KEY, emails.join('\n')); return true; } catch { return false; }
}

function takeReloginEmails() {
  try {
    const value = window.sessionStorage.getItem(OAUTH_RELOGIN_KEY);
    if (value) window.sessionStorage.removeItem(OAUTH_RELOGIN_KEY);
    return value || '';
  } catch { return ''; }
}

/**
 * The derived statuses worth naming in the rail's one-line summary.
 *
 * Only these two, because each costs the gateway a count query. The error
 * count is not among them: it is the length of the list right below.
 */
const SUB2API_STATUS_LABELS: Array<[string, string]> = [
  ['active', '可用'],
  ['rate_limited', '限流'],
];

/**
 * The gateway's error set, beside the self-use shelf that fed it.
 *
 * Manual, not polled: it reads every account on the gateway to find the ones
 * carrying an error message, which is not something to do four times a minute
 * behind an operator's back.
 *
 * The breakdown line is the reason this is not just a count. sub2api's derived
 * statuses are not the `status` field on an account, so a gateway where
 * everything is rate-limited still reports zero errors — and a bare "0" would
 * read as a broken button rather than as the truth.
 */
function Sub2ApiErrorRail({ onNotice }: { onNotice: (notice: { tone: string; text: string } | null) => void }) {
  const navigate = useNavigate();
  const [result, setResult] = useState<Sub2ApiFailedAccounts | null>(null);
  const pull = useMutation({
    mutationFn: () => endpoints.sub2ApiFailedAccounts(),
    onSuccess: (data) => {
      setResult(data);
      onNotice(data.accounts.length
        ? { tone: 'success', text: `sub2api 有 ${data.accounts.length} 个错误账号${data.truncated ? '（账号过多，只读取了前若干页）' : ''}` }
        : { tone: 'info', text: `sub2api 当前没有错误账号（共 ${data.breakdown.total ?? 0} 个，其中限流 ${data.breakdown.rate_limited ?? 0}）` });
    },
    onError: (error) => onNotice({ tone: 'danger', text: errorMessage(error) }),
  });
  const remove = useMutation({
    mutationFn: (accountIds: number[]) => endpoints.removeSub2ApiAccounts(accountIds),
    onSuccess: (data) => {
      // The pulled list is now a list of accounts that no longer exist, so it
      // is cleared rather than left to look actionable.
      setResult(null);
      onNotice({
        tone: data.errors.length ? 'warning' : 'success',
        text: `已从 sub2api 删除 ${data.deleted} 个账号${data.errors.length ? `，${data.errors.length} 个失败（${data.errors.slice(0, 2).join('；')}）` : ''}`,
      });
    },
    onError: (error) => onNotice({ tone: 'danger', text: errorMessage(error) }),
  });

  const accounts = result?.accounts || [];
  const emails = accounts.map((account) => account.email).filter(Boolean);
  const emailText = emails.join('\n');

  return <aside className="sub2api-rail" aria-label="sub2api 错误账号">
    <div className="sub2api-rail-head">
      <strong>sub2api 错误账号</strong>
      <Button tone="quiet" icon={pull.isPending ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />} onClick={() => pull.mutate()} disabled={pull.isPending}>拉取</Button>
    </div>
    {result
      ? <p className="sub2api-rail-breakdown">{SUB2API_STATUS_LABELS
          .map(([key, label]) => `${label} ${result.breakdown[key] ?? 0}`)
          .join(' · ')} · 错误 {accounts.length} · 共 {result.breakdown.total ?? 0}</p>
      : <p className="sub2api-rail-breakdown">尚未拉取。读取网关上全部账号，找出被标记为 error 或带错误信息的那些。</p>}
    {result && (accounts.length
      ? <>
          <textarea className="sub2api-rail-emails" readOnly value={emailText} aria-label={`${emails.length} 个错误账号邮箱，每行一个`} rows={Math.min(12, Math.max(3, emails.length))} />
          <div className="sub2api-rail-actions">
            <Button tone="quiet" icon={<Copy size={14} />} onClick={() => copyText(emailText).then(
              () => onNotice({ tone: 'success', text: `已复制 ${emails.length} 个邮箱` }),
              () => onNotice({ tone: 'danger', text: '复制失败，可手动全选文本框' }),
            )}>复制全部</Button>
            <Button
              tone="primary"
              icon={<KeyRound size={14} />}
              title="把这些邮箱填进启动页的凭据框，按登录态直登 OAuth 起一次任务"
              onClick={() => {
                if (!stashReloginEmails(emails)) {
                  onNotice({ tone: 'danger', text: '无法暂存邮箱列表，请改用「复制全部」手动粘贴' });
                  return;
                }
                navigate('/');
              }}
            >去直登 OAuth</Button>
            <ConfirmDialog
              trigger={<Button tone="quiet" icon={remove.isPending ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />} disabled={remove.isPending}>从 sub2api 删除 ({accounts.length})</Button>}
              title="从 sub2api 删除账号"
              description={`将从网关永久删除这 ${accounts.length} 个账号。本地的登录态与 CPA 文件不受影响，删除后可以重新推送。`}
              danger
              confirmLabel="确认删除"
              onConfirm={() => remove.mutate(accounts.map((account) => account.id))}
            />
          </div>
          <ul className="sub2api-rail-reasons">
            {accounts.filter((account) => account.reason).slice(0, 6).map((account) => (
              <li key={account.id} title={`${account.email}\n${account.reason}`}><b>{account.email}</b><span>{account.reason}</span></li>
            ))}
          </ul>
        </>
      : <EmptyState icon={<Check size={20} />} title="没有错误账号" detail="网关上没有被标记为 error 或带错误信息的账号。" />)}
  </aside>;
}

function HistoryPage() {
  const client = useQueryClient();
  const liveRuns = useRunsQuery();
  const [runOffset, setRunOffset] = useState(0);
  const [artifactOffset, setArtifactOffset] = useState(0);
  const runs = useQuery({ queryKey: ['runs', 'history', runOffset], queryFn: () => endpoints.runsPage(runOffset), placeholderData: keepPreviousData, refetchInterval: 10000 });
  const runRows = runs.data?.runs || [];
  const artifactPollInterval = liveRuns.data?.activeRunIds?.length ? 10_000 : 30_000;
  // Opens on the unexported set: the reason to visit this page is almost always
  // "what is new since I last exported", and `all` buries that under everything
  // ever produced.
  const [lifecycleFilter, setLifecycleFilter] = useState<'all' | 'fresh' | 'planned' | 'self_use' | 'sold'>('fresh');
  const [typeFilter, setTypeFilter] = useState<'all' | 'plus' | 'oauth'>('all');
  const [removeArtifacts, setRemoveArtifacts] = useState(false);
  const [batchRemoveArtifacts, setBatchRemoveArtifacts] = useState(false);
  const [selectedRuns, setSelectedRuns] = useState<Set<string>>(() => new Set());
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [expandedDeliveryGroups, setExpandedDeliveryGroups] = useState<Set<string>>(() => new Set());
  const [soldExportCount, setSoldExportCount] = useState('1');
  // Registration country the count export draws from; '' takes every country.
  const [soldExportCountry, setSoldExportCountry] = useState('');
  const [soldExportFormat, setSoldExportFormat] = useState<SoldExportFormat>(readSoldExportFormat);
  const [deliveryNotes, setDeliveryNotes] = useState<Record<string, string>>(() => readCpaDeliveryNotes());
  const [notice, setNotice] = useState<{ tone: string; text: string } | null>(null);
  // The default view excludes locked snapshots. They are immutable audit data,
  // so fetching them on every visit only delays the actionable first paint.
  // Shelves that can display or unlock them opt in when selected.
  const includeLocked = lifecycleFilter === 'all' || lifecycleFilter === 'self_use' || lifecycleFilter === 'sold';
  useEffect(() => { setArtifactOffset(0); }, [lifecycleFilter, typeFilter]);
  const artifactQueryKey = ['cpa-artifacts', includeLocked ? 'with-locked' : 'unlocked', lifecycleFilter, typeFilter, artifactOffset] as const;
  const artifacts = useQuery<CpaArtifactsPayload>({
    queryKey: artifactQueryKey,
    queryFn: () => endpoints.cpaArtifacts({ includeLocked, offset: artifactOffset, lifecycle: lifecycleFilter, type: typeFilter }),
    placeholderData: keepPreviousData,
    staleTime: artifactPollInterval,
    refetchInterval: artifactPollInterval,
  });
  const artifactRefreshing = artifacts.isFetching && !artifacts.isPending;
  const artifactInitialLoading = artifacts.isPending && !artifacts.data;
  // Keep undelivered artifacts above anything already downloaded or pushed.
  // `isFreshArtifact` also considers the inventory shelf, which is useful for
  // the 最新 tab but must not decide the overall delivery order.
  //
  // One pass produces the sorted rows and the type counts together. They used
  // to be three walks of the same few thousand records — the store only grows,
  // and this runs again on every poll that actually changes something.
  const { rows: allArtifactRows, typeCounts: pageTypeCounts } = useMemo(() => {
    const rows = [...(artifacts.data?.artifacts || [])].sort((left, right) => {
      const deliveryOrder = Number(!isUnexportedArtifact(left)) - Number(!isUnexportedArtifact(right));
      return deliveryOrder
        || right.modifiedAt.localeCompare(left.modifiedAt)
        || String(left.fileName || '').localeCompare(String(right.fileName || ''));
    });
    let plus = 0;
    for (const artifact of rows) if (artifact.isPlus === true) plus += 1;
    return { rows, typeCounts: { all: rows.length, plus, oauth: rows.length - plus } };
  }, [artifacts.data]);
  const typeFilteredRows = useMemo(() => typeFilter === 'plus'
    ? allArtifactRows.filter((artifact) => artifact.isPlus === true)
    : typeFilter === 'oauth'
      ? allArtifactRows.filter((artifact) => artifact.isPlus !== true)
      : allArtifactRows, [allArtifactRows, typeFilter]);
  // The visible shelf and every shelf's badge count come from the same walk:
  // the tabs are a view of this filter, not a second computation over it.
  const { rows: artifactRows, counts: pageLifecycleCounts } = useMemo(() => {
    const counts = { all: typeFilteredRows.length, fresh: 0, planned: 0, self_use: 0, sold: 0 };
    const rows: CpaArtifact[] = [];
    for (const artifact of typeFilteredRows) {
      const fresh = isFreshArtifact(artifact);
      const bucket = cpaLifecycleBucket(artifact);
      if (fresh) counts.fresh += 1;
      if (bucket === 'planned' || bucket === 'self_use' || bucket === 'sold') counts[bucket] += 1;
      if (lifecycleFilter === 'all' || (lifecycleFilter === 'fresh' ? fresh : bucket === lifecycleFilter)) rows.push(artifact);
    }
    return { rows: lifecycleFilter === 'all' ? typeFilteredRows : rows, counts };
  }, [typeFilteredRows, lifecycleFilter]);
  const typeCounts = artifacts.data?.typeCounts || pageTypeCounts;
  const lifecycleCounts = artifacts.data?.lifecycleCounts || pageLifecycleCounts;
  // Scoped to the category on screen, not the whole store: standing on 计划卖出
  // and clicking this should hand over that shelf's files, not every account
  // ever produced. The rows are therefore named explicitly instead of sending
  // `unexported: true`, which the server resolves from its own ledger and no
  // page filter can narrow.
  //
  // Reads the CPA marker alone, not `isFreshArtifact`: the CPA ledger is what
  // this button writes, so a file already pushed to the gateway but never
  // downloaded as CPA is still one it has to offer.
  const unexportedRows = useMemo(() => artifactRows.filter((artifact) => !artifact.cpaExportedAt), [artifactRows]);
  const unexportedCount = unexportedRows.length;
  /** The tab this button is standing on, named the way its own label names it. */
  const lifecycleTabLabel = lifecycleFilter === 'all' ? '全部' : lifecycleFilter === 'fresh' ? '最新' : CPA_LIFECYCLE_LABELS[lifecycleFilter];
  // Rebuilt over every artifact on every render otherwise, four times a minute.
  const runsWithRetainedCpa = useMemo(
    () => new Set([...allArtifactRows.map((artifact) => artifact.runId), ...runRows.filter(run => run.hasRetainedCpa).map(run => run.runId)]),
    [allArtifactRows, runRows],
  );
  const selectedRunRows = useMemo(
    () => runRows.filter((run) => selectedRuns.has(run.runId)),
    [runRows, selectedRuns],
  );
  const selectedRunIds = selectedRunRows.map((run) => run.runId);
  const selectedRunCpaIds = selectedRunIds.filter((runId) => runsWithRetainedCpa.has(runId));
  const selectedRunsDeletable = selectedRunRows.length > 0 && selectedRunRows.every((run) => ['complete', 'partial', 'cancelled', 'failed'].includes(run.status) && !run.active);
  const allRunsSelected = runRows.length > 0 && runRows.every((run) => selectedRuns.has(run.runId));
  const latestRun = runs.data?.latestRun ?? (runOffset === 0 ? runRows[0] : undefined);
  const latestRunWithCpa = latestRun && (latestRun.hasRetainedCpa || runsWithRetainedCpa.has(latestRun.runId)) ? latestRun : undefined;
  const selectedArtifacts = useMemo(
    () => artifactRows.filter((artifact) => artifact.locked !== true && selected.has(artifactSelectionKey(artifact))),
    [artifactRows, selected],
  );
  const selectedArtifactItems = useMemo(
    () => selectedArtifacts.map(({ runId, jobId, key }) => ({ runId, jobId, key })),
    [selectedArtifacts],
  );
  const artifactByKey = useMemo(
    () => new Map(artifactRows.map((artifact) => [artifactSelectionKey(artifact), artifact])),
    [artifactRows],
  );
  const [nvtokensKind, setNvtokensKind] = useState<NvtokensPushKind>(readNvtokensKind);
  useEffect(() => {
    try { window.localStorage.setItem(NVTOKENS_KIND_KEY, nvtokensKind); } catch { /* Not remembered without storage. */ }
  }, [nvtokensKind]);
  const selectedNvtokensSplit = useMemo(
    () => splitNvtokensFresh(nvtokensKind, selectedArtifacts),
    [nvtokensKind, selectedArtifacts],
  );
  const selectedAssetIds = useMemo(
    () => [...new Set(selectedArtifacts.map((artifact) => String(artifact.assetId || '')).filter(Boolean))],
    [selectedArtifacts],
  );
  const lifecycleSelectionTooLarge = selectedAssetIds.length > MAX_SESSION_ASSET_BATCH_SIZE;
  const selectedArtifactsDeletable = selectedArtifacts.length > 0 && selectedArtifacts.every((artifact) => artifact.deletable);
  // Selectable rows, their keys and their selected count in one walk: all
  // three are read on every render, and a range brush re-renders per frame.
  const { rows: selectableArtifactRows, keys: selectableArtifactKeys } = useMemo(() => {
    const rows = artifactRows.filter((artifact) => artifact.locked !== true);
    return { rows, keys: new Set(rows.map(artifactSelectionKey)) };
  }, [artifactRows]);
  const allSelected = selectableArtifactRows.length > 0 && selectedArtifacts.length === selectableArtifactRows.length;
  const artifactKeys = useMemo(() => artifactRows.map(artifactSelectionKey), [artifactRows]);
  const deliveryGroupingEnabled = lifecycleFilter === 'self_use' || lifecycleFilter === 'sold';
  const deliveryGroups = useMemo(
    () => artifactDeliveryGroups(artifactRows, deliveryGroupingEnabled),
    [artifactRows, deliveryGroupingEnabled],
  );
  const artifactRange = useRangeSelection({ keys: artifactKeys, selected, setSelected });
  useEffect(() => {
    // Built by filtering `current`, so an unchanged size means unchanged
    // contents — there is nothing more to compare.
    setSelected((current) => {
      const next = new Set([...current].filter((key) => selectableArtifactKeys.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [selectableArtifactKeys]);
  // How many selectable rows each delivery batch currently has selected.
  // The dividers used to recount their own rows on every render, which on the
  // sold shelf means walking a batch of several hundred per frame of a drag.
  const groupSelectionCounts = useMemo(() => {
    const counts = new Map<string, { selectable: number; selected: number }>();
    for (const group of deliveryGroups) {
      let selectable = 0;
      let selectedCount = 0;
      for (const { artifact } of group.rows) {
        if (artifact.locked === true) continue;
        selectable += 1;
        if (selected.has(artifactSelectionKey(artifact))) selectedCount += 1;
      }
      counts.set(group.key, { selectable, selected: selectedCount });
    }
    return counts;
  }, [deliveryGroups, selected]);
  // The card grid is responsive, so the number of cards per visual row is a
  // measurement rather than a constant. It decides how the flat list below is
  // chunked, which is what makes a windowed grid possible at all.
  const gridRef = useRef<HTMLDivElement>(null);
  const [columns, setColumns] = useState(1);
  useLayoutEffect(() => {
    const element = gridRef.current;
    if (!element || typeof ResizeObserver !== 'function') return;
    const measure = () => {
      const width = element.clientWidth;
      if (!width) return;
      setColumns(Math.max(1, Math.floor((width + ARTIFACT_GRID_GAP) / (ARTIFACT_CARD_MIN_WIDTH + ARTIFACT_GRID_GAP))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [artifactInitialLoading, artifactRows.length > 0]);
  /**
   * The list actually handed to the virtualizer: batch dividers stay full
   * width, and the cards between them are chunked into visual rows.
   *
   * Without this the page built a card — a checkbox, three badges, two
   * buttons and a download link — for every retained CPA file, tens of
   * thousands of nodes for a store of a few thousand accounts, and then threw
   * most of them away again on the next poll. Only what is on screen is built
   * now; everything else is a measured offset.
   */
  const virtualRows = useMemo(() => {
    const list: ArtifactVirtualRow[] = [];
    for (const group of deliveryGroups) {
      const collapsible = deliveryGroupingEnabled
        && (Boolean(group.deliveryAt) || group.key === UNDELIVERED_DELIVERY_GROUP);
      const collapseKey = `${lifecycleFilter}:${group.key}`;
      const collapsed = collapsible && !expandedDeliveryGroups.has(collapseKey);
      if (collapsible) list.push({ kind: 'divider', key: `divider:${group.key}`, group, collapseKey, collapsed });
      if (collapsed) continue;
      for (let offset = 0; offset < group.rows.length; offset += columns) {
        const cards = group.rows.slice(offset, offset + columns);
        list.push({
          kind: 'cards',
          key: `cards:${group.key}:${cards[0].index}`,
          group,
          collapsible,
          cards,
        });
      }
    }
    return list;
  }, [deliveryGroups, deliveryGroupingEnabled, expandedDeliveryGroups, lifecycleFilter, columns]);
  // Switching shelf or type replaces the list outright, so the old scroll
  // offset points at nothing. Before windowing the shorter list simply ended
  // and the view snapped back; now the spacer keeps its height and the page
  // would open somewhere in the middle of a set the operator has not seen.
  useEffect(() => {
    const scroll = artifactRange.containerProps.ref.current;
    if (scroll) scroll.scrollTop = 0;
  }, [lifecycleFilter, typeFilter]);
  const artifactVirtual = useVirtualizer({
    count: virtualRows.length,
    getScrollElement: () => artifactRange.containerProps.ref.current,
    estimateSize: (index) => (virtualRows[index]?.kind === 'divider'
      ? ARTIFACT_DIVIDER_ROW_HEIGHT
      : ARTIFACT_CARD_ROW_HEIGHT),
    // Re-measure when the column count changes: the same key with a different
    // width would otherwise keep a stale row height.
    getItemKey: (index) => `${columns}:${virtualRows[index]?.key ?? index}`,
    overscan: 6,
  });
  const virtualItems = artifactVirtual.getVirtualItems();
  const measuredGrid = virtualItems.length > 0;
  const renderedArtifactRows = useMemo(() => {
    if (measuredGrid) return virtualItems.map(({ key, index, start }) => ({ key: String(key), index, start }));
    const rows: Array<{ key: string; index: number; start: number }> = [];
    let cards = 0;
    for (let index = 0; index < virtualRows.length && cards < UNMEASURED_ARTIFACT_CARD_BUDGET; index += 1) {
      const row = virtualRows[index];
      rows.push({ key: `${columns}:${row.key}`, index, start: 0 });
      if (row.kind === 'cards') cards += row.cards.length;
    }
    return rows;
  }, [measuredGrid, virtualItems, virtualRows, columns]);
  useEffect(() => {
    const valid = new Set(runRows.map((run) => run.runId));
    setSelectedRuns((current) => {
      const next = new Set([...current].filter((runId) => valid.has(runId)));
      return next.size === current.size && [...next].every((runId) => current.has(runId)) ? current : next;
    });
  }, [runs.data]);
  useEffect(() => {
    try {
      window.localStorage.setItem(CPA_DELIVERY_NOTES_KEY, JSON.stringify(deliveryNotes));
    } catch {
      // Local annotations are optional when storage is unavailable.
    }
  }, [deliveryNotes]);
  useEffect(() => {
    try {
      window.localStorage.setItem(SOLD_EXPORT_FORMAT_KEY, soldExportFormat);
    } catch {
      // The choice simply does not survive a reload when storage is unavailable.
    }
  }, [soldExportFormat]);
  const remove = useMutation({
    mutationFn: (runId: string) => endpoints.deleteRun(runId, removeArtifacts),
    onSuccess: () => {
      setNotice({ tone: 'success', text: '运行历史已删除' });
      client.invalidateQueries({ queryKey: ['runs'] });
      client.invalidateQueries({ queryKey: ['cpa-artifacts'] });
    },
    onError: (error) => setNotice({ tone: 'danger', text: errorMessage(error) }),
  });
  const exportActivityId = useRef('');
  /**
   * Run one export as a sequence of request-sized batches, behind the bar.
   *
   * Every batch stamps its own ledger entries under one shared delivery
   * timestamp, so the history page still shows the export as a single batch —
   * and whatever landed before a failing batch is handed over rather than left
   * counted as delivered with no file to show for it.
   */
  const runBatchedExport = async <Part,>(options: {
    label: string;
    items: CpaArtifactItem[];
    unexportedOnly?: boolean;
    preflight?: (selection: CpaExportSelection) => Promise<CpaCredentialPreflight>;
    send: (selection: CpaExportSelection) => Promise<Part>;
    deliver: (parts: Part[]) => void;
  }): Promise<PushOutcome> => {
    const { label, items } = options;
    const batches = cpaExportBatches(items);
    // Several batches are still one delivery, so they share one stamp; a single
    // request is one delivery on its own and keeps the server's clock.
    const deliveryAt = batches.length > 1 ? new Date().toISOString() : '';
    const selectionFor = (batch: CpaArtifactItem[]): CpaExportSelection => ({
      items: batch,
      ...(options.unexportedOnly ? { unexportedOnly: true } : {}),
      ...(deliveryAt ? { deliveryAt } : {}),
    });
    // A single batch is already all-or-nothing on its own, so it skips the
    // preflight and reads every file once.
    const preflight = batches.length > 1 ? options.preflight : undefined;
    const activityId = localActivity.begin({
      label,
      done: 0,
      total: batches.length * (preflight ? 2 : 1),
      group: CPA_PUSH_GROUP,
    });
    exportActivityId.current = activityId;
    let step = 0;
    const advance = () => localActivity.update(activityId, (step += 1));
    if (preflight) {
      // Nothing is stamped in this pass, so a selection with one incomplete
      // account still exports nothing at all — the guarantee that lets the
      // export itself be split into batches.
      const gaps: PushOutcomeLine[] = [];
      for (const batch of batches) {
        const result = await preflight(selectionFor(batch));
        for (const row of result.missing || []) {
          gaps.push({ email: row.email || artifactEmailOf(row), reason: row.reason });
        }
        advance();
      }
      if (gaps.length) {
        const summary = `${gaps.length} 个账号凭证不全，整批未导出`;
        localActivity.finish(activityId, { message: `${label}：${summary}`, tone: 'danger' });
        return { label, tone: 'danger', at: Date.now(), summary, lines: gaps, errors: [] };
      }
    }
    const parts: Part[] = [];
    const lines: PushOutcomeLine[] = [];
    let exported = 0;
    for (const batch of batches) {
      try {
        parts.push(await options.send(selectionFor(batch)));
        exported += batch.length;
      } catch (error) {
        // A refused batch stamped nothing, so its rows are still 未导出 and can
        // be sent again; the batches before it were stamped, which is why
        // `deliver` runs either way.
        const totals = emptyPushTotals();
        collectBatchFailure(totals, batch, error, artifactEmailOf);
        lines.push(...totals.lines);
      }
      advance();
    }
    options.deliver(parts);
    const outcome = buildExportOutcome(label, items.length, exported, lines);
    localActivity.finish(activityId, { message: `${label}：${outcome.summary}`, tone: outcome.tone });
    return outcome;
  };
  const exportSelected = useMutation({
    mutationFn: async ({ selection, fileTag = '' }: { selection: CpaExportSelection; fileTag?: string }) => {
      // Named after what actually landed in the file, so a selection that lost
      // rows to the already-exported guard says the smaller number.
      const cpaFileName = (count: number) => exportFileName({ label: 'CPA', count, ext: 'json', tag: fileTag });
      // Only a named row selection can be batched: `runIds` and `unexported` are
      // resolved from the server's own ledger, and splitting them here would put
      // that decision in the browser.
      if (!selection.items) {
        const accounts = await endpoints.exportCpa(selection);
        downloadJson(accounts, cpaFileName(accounts.length));
        setNotice({ tone: 'success', text: `已导出 ${accounts.length} 个 CPA` });
        return null;
      }
      return runBatchedExport<unknown[]>({
        label: '导出 CPA',
        items: selection.items,
        unexportedOnly: selection.unexportedOnly === true,
        send: (batch) => endpoints.exportCpa(batch),
        deliver: (parts) => {
          const accounts = parts.flat();
          if (accounts.length) downloadJson(accounts, cpaFileName(accounts.length));
        },
      });
    },
    onSuccess: (outcome) => {
      if (outcome) pageResults.set(CPA_PUSH_GROUP, outcome);
      client.invalidateQueries({ queryKey: ['cpa-artifacts'] });
    },
    onError: (error) => {
      localActivity.fail(exportActivityId.current, errorMessage(error));
      setNotice({ tone: 'danger', text: errorMessage(error) });
    },
    onSettled: () => client.invalidateQueries({ queryKey: ['cpa-artifacts'] }),
  });
  // Which account a selection entry is, for a report about rows the server
  // refused: the operator thinks in mailboxes, not in run/job ids. Every name
  // a row answers to is mapped, so a file-level key and a legacy run/job pair
  // both resolve to the same account.
  const artifactEmailOf = useMemo(() => {
    const emails = new Map<string, string>();
    for (const artifact of artifactRows) {
      const email = String(artifact.email || '');
      for (const key of artifactLookupKeys(artifact)) emails.set(key, email);
    }
    return (item: Partial<CpaArtifactItem>) => {
      for (const key of artifactLookupKeys(item)) {
        const email = emails.get(key);
        if (email) return email;
      }
      return '';
    };
  }, [artifactRows]);
  const exportCpaCredentials = useMutation({
    mutationFn: async ({ fileTag = '', ...selection }: CpaExportSelection & { fileTag?: string }) => {
      const label = '导出邮箱----密码----2FA';
      if (!selection.items) {
        const { blob, fileName } = await endpoints.exportCpaCredentials(selection);
        downloadBlob(blob, fileName);
        setNotice({ tone: 'success', text: `已导出 ${selection.runIds?.length || 0} 个任务的账号凭证` });
        return null;
      }
      return runBatchedExport<string>({
        label,
        items: selection.items,
        unexportedOnly: selection.unexportedOnly === true,
        preflight: endpoints.preflightCpaCredentials,
        send: (batch) => endpoints.exportCpaCredentials(batch).then(({ blob }) => blob.text()),
        deliver: (parts) => {
          // Each batch ends its own last line, so the parts concatenate into one
          // file. It is written even when a later batch failed, because the
          // ledger already counts these accounts as handed over.
          const content = parts.join('');
          const count = content.split('\n').filter((line) => line.trim()).length;
          if (content) downloadBlob(new Blob([content], { type: 'text/plain; charset=utf-8' }), exportFileName({ label: '凭证', count, ext: 'txt', tag: fileTag }));
        },
      });
    },
    onSuccess: (outcome) => {
      if (outcome) pageResults.set(CPA_PUSH_GROUP, outcome);
      client.invalidateQueries({ queryKey: ['cpa-artifacts'] });
    },
    onError: (error) => {
      localActivity.fail(exportActivityId.current, errorMessage(error));
      pageResults.set(CPA_PUSH_GROUP, exportFailureOutcome('导出邮箱----密码----2FA', error, artifactEmailOf));
    },
    onSettled: () => client.invalidateQueries({ queryKey: ['cpa-artifacts'] }),
  });
  const exportSub2Api = useMutation({
    mutationFn: ({ selection }: { selection: CpaExportSelection; fileName?: string; fileTag?: string }) => endpoints.exportSub2Api(selection),
    onSuccess: (payload, { fileName, fileTag }) => {
      // A single account keeps its own artifact name; a batch is named by its
      // type, OAuth state, size and time.
      downloadJson(payload, fileName || exportFileName({ label: 'sub2api', count: payload.accounts.length, ext: 'json', tag: fileTag }));
      setNotice({ tone: 'success', text: `已导出 ${payload.accounts.length} 个 sub2api 账号` });
      client.invalidateQueries({ queryKey: ['cpa-artifacts'] });
    },
    onError: (error) => setNotice({ tone: 'danger', text: errorMessage(error) }),
  });
  // Batch archives: one file per account in a folder, rather than one merged
  // array — what anything that reads credential files one at a time needs.
  const exportCpaArchive = useMutation({
    mutationFn: (selection: CpaExportSelection) => endpoints.exportCpaArchive(selection),
    onSuccess: ({ blob, fileName }) => {
      downloadBlob(blob, fileName);
      setNotice({ tone: 'success', text: `已按单文件打包导出 ${fileName}` });
      client.invalidateQueries({ queryKey: ['cpa-artifacts'] });
    },
    onError: (error) => setNotice({ tone: 'danger', text: errorMessage(error) }),
  });
  const exportSub2ApiArchive = useMutation({
    mutationFn: (selection: CpaExportSelection) => endpoints.exportSub2ApiArchive(selection),
    onSuccess: ({ blob, fileName }) => {
      downloadBlob(blob, fileName);
      setNotice({ tone: 'success', text: `已按单文件打包导出 ${fileName}` });
      client.invalidateQueries({ queryKey: ['cpa-artifacts'] });
    },
    onError: (error) => setNotice({ tone: 'danger', text: errorMessage(error) }),
  });
  // Push progress lives in the shared activity store rather than in this
  // component. A push outlives the page: holding the bar in component state
  // meant walking to another page and back threw away every sign that one was
  // running, and the unmount cleanup used to clear the store outright, taking
  // the top bar's view of the push down with the page.
  //
  // The bar shows only while the push is running. The gateway answers a
  // 25-account batch in 11-36ms, so a push can be created and finished inside
  // one frame, which a local timer used to paper over by holding the bar open
  // for a second: the result line below replaces the bar in the same tick and
  // stays until it is dismissed, which is a better answer than a bar the
  // operator has to catch.
  const activity = useLocalActivity();
  const pushBar = activity && activity.group === CPA_PUSH_GROUP && activity.status === 'running' ? activity : null;
  // Kept in the module store for the same reason, and for one more: the
  // floating notice is suppressed on this page precisely because this line
  // states the outcome, so losing the line lost the outcome entirely.
  const pushOutcome = usePageResult<PushOutcome>(CPA_PUSH_GROUP);
  const pushActivityId = useRef('');
  const nvtokensActivityId = useRef('');
  // Hands the selection to the local sub2api gateway rather than the browser,
  // and the gateway grades every account itself. A batch where some accounts
  // landed and some were refused is a success with a `failed` count — usually
  // an access token that expired since the CPA was written — so the result
  // reports both halves instead of only the happy one.
  //
  // Sent in batches rather than as one call, for two reasons: a few hundred
  // accounts in a single import can outlive the request timeout, and a bar
  // that moves per batch is real progress rather than an animation pretending
  // to be one. Each batch stamps its own ledger entries server-side, so an
  // interrupted push keeps everything that already landed.
  const pushSub2Api = useMutation({
    mutationFn: async (items: CpaArtifactItem[]) => {
      const label = '推送 sub2api';
      const activityId = localActivity.begin({ label, done: 0, total: items.length, group: CPA_PUSH_GROUP });
      pushActivityId.current = activityId;
      const totals = emptyPushTotals();
      let completed = 0;
      // One push is one delivery however many 25-account requests it takes:
      // without a shared stamp each request became its own history group.
      const deliveryAt = items.length > SUB2API_PUSH_BATCH ? new Date().toISOString() : '';
      for (let offset = 0; offset < items.length; offset += SUB2API_PUSH_BATCH) {
        const batch = items.slice(offset, offset + SUB2API_PUSH_BATCH);
        try {
          const result = await endpoints.pushSub2Api({ items: batch, ...(deliveryAt ? { deliveryAt } : {}) });
          totals.pushed += result.pushed;
          totals.failed += result.failed;
          totals.skipped += result.skipped;
          totals.errors.push(...result.errors);
        } catch (error) {
          collectBatchFailure(totals, batch, error, artifactEmailOf);
        }
        completed += batch.length;
        localActivity.update(activityId, Math.min(items.length, completed));
      }
      const outcome = buildPushOutcome(label, items.length, totals);
      localActivity.finish(activityId, { message: `${label}：${outcome.summary}`, tone: outcome.tone });
      return outcome;
    },
    onSuccess: (outcome) => {
      pageResults.set(CPA_PUSH_GROUP, outcome);
      client.invalidateQueries({ queryKey: ['session-assets'] });
    },
    onError: (error) => {
      localActivity.fail(pushActivityId.current, errorMessage(error));
      pageResults.set(CPA_PUSH_GROUP, failedPushOutcome('推送 sub2api', error));
    },
    // Whatever landed before a failure is already on the gateway and already
    // stamped, so the listing is re-read either way.
    onSettled: () => client.invalidateQueries({ queryKey: ['cpa-artifacts'] }),
  });
  const runNvtokensPush = async (
    kind: NvtokensPushKind,
    items: CpaArtifactItem[],
    label: string,
    push: (selection: CpaExportSelection) => Promise<NvtokensPushResult>,
  ) => {
    // Every kind checks its own ledger. Only 入池 used to, so JSON and 邮箱凭证
    // would push the same account a second time. Rows already sent this way are
    // named in the result instead of resent, and `unexportedOnly` makes the
    // server refuse them too if this page is behind.
    const field = NVTOKENS_STAMP_FIELD[kind];
    const fresh: CpaArtifactItem[] = [];
    const alreadySent: CpaArtifactItem[] = [];
    for (const item of items) {
      (artifactByKey.get(artifactSelectionKey(item))?.[field] ? alreadySent : fresh).push(item);
    }
    const totals = emptyPushTotals();
    totals.skipped += alreadySent.length;
    for (const item of alreadySent) totals.lines.push({ email: artifactEmailOf(item), reason: '已推送过，未重复推送' });
    if (!fresh.length) {
      return {
        label,
        tone: 'warning' as const,
        at: Date.now(),
        summary: `选中的 ${items.length} 个都已推送过，未重复推送`,
        lines: totals.lines,
        errors: [],
      };
    }
    const deliveryAt = new Date().toISOString();
    const activityId = localActivity.begin({ label, done: 0, total: fresh.length, group: CPA_PUSH_GROUP });
    nvtokensActivityId.current = activityId;
    for (let offset = 0; offset < fresh.length; offset += NVTOKENS_PUSH_BATCH) {
      const batch = fresh.slice(offset, offset + NVTOKENS_PUSH_BATCH);
      try {
        const result = await push({ items: batch, deliveryAt, unexportedOnly: true });
        totals.pushed += result.pushed;
        totals.failed += result.failed;
        totals.skipped += result.skipped;
        totals.errors.push(...result.errors);
        // Records the console itself held back — a missing long-lived 2FA
        // secret, a mailbox that no longer matches its login state.
        for (const skip of result.skippedDetails || []) {
          totals.lines.push({ email: skip.email || artifactEmailOf(skip), reason: skip.reason });
        }
      } catch (error) {
        collectBatchFailure(totals, batch, error, artifactEmailOf);
      }
      localActivity.update(activityId, Math.min(fresh.length, offset + batch.length));
    }
    const outcome = buildPushOutcome(label, items.length, totals);
    localActivity.finish(activityId, { message: `${label}：${outcome.summary}`, tone: outcome.tone });
    return outcome;
  };
  const [nvtokensPriceYuan, setNvtokensPriceYuan] = useState(1);
  const pushNvtokens = useMutation({
    mutationFn: (request: NvtokensPushRequest) => runNvtokensPush(
      request.kind,
      request.items,
      NVTOKENS_PUSH_LABELS[request.kind],
      (selection) => pushNvtokensRequest(request, selection),
    ),
    onSuccess: (outcome) => pageResults.set(CPA_PUSH_GROUP, outcome),
    onError: (error, request) => {
      localActivity.fail(nvtokensActivityId.current, errorMessage(error));
      pageResults.set(CPA_PUSH_GROUP, failedPushOutcome(NVTOKENS_PUSH_LABELS[request.kind], error));
    },
    onSettled: () => client.invalidateQueries({ queryKey: ['cpa-artifacts'] }),
  });
  const nvtokensBusy = pushNvtokens.isPending;
  // Reclassify moves the linked login-state asset, the single source of truth,
  // so a CPA marked sold here shows sold on the sessions page too.
  const classify = useMutation({
    mutationFn: (lifecycle: SettableSessionAssetLifecycle) => endpoints.moveSessionAssetLifecycle(selectedAssetIds, lifecycle),
    onSuccess: (result, lifecycle) => {
      setSelected(new Set());
      setNotice({ tone: 'success', text: `已把 ${result.changed.length} 个产物归类为${CPA_LIFECYCLE_LABELS[lifecycle]}` });
      client.invalidateQueries({ queryKey: ['cpa-artifacts'] });
      client.invalidateQueries({ queryKey: ['session-assets'] });
    },
    onError: (error) => setNotice({ tone: 'danger', text: errorMessage(error) }),
  });
  const lifecycleActionDisabled = !selectedAssetIds.length || lifecycleSelectionTooLarge || classify.isPending;
  const lifecycleActionTitle = lifecycleSelectionTooLarge
    ? `一次最多归类 ${MAX_SESSION_ASSET_BATCH_SIZE} 个登录态资产，当前已选 ${selectedAssetIds.length} 个，请分批操作`
    : undefined;
  const cleanup = useMutation({
    mutationFn: () => endpoints.removeCpaArtifacts(selectedArtifactItems),
    onSuccess: (result) => {
      setSelected(new Set());
      setNotice({ tone: 'success', text: `已清理 ${result.removed.length} 个 CPA 文件${result.missing.length ? `，${result.missing.length} 个文件已不存在` : ''}` });
      client.invalidateQueries({ queryKey: ['cpa-artifacts'] });
    },
    onError: (error) => setNotice({ tone: 'danger', text: errorMessage(error) }),
  });
  const lockBatch = useMutation({
    mutationFn: ({ items, batchKey }: { items: CpaArtifactItem[]; batchKey: string }) => endpoints.lockCpaBatch(items, batchKey),
    onMutate: ({ items, batchKey }) => {
      void client.cancelQueries({ queryKey: ['cpa-artifacts'] });
      const previous = client.getQueryData<CpaArtifactsPayload>(artifactQueryKey);
      client.setQueryData<CpaArtifactsPayload>(artifactQueryKey, (current) => patchCpaLockState(current, items, true, batchKey));
      return { previous };
    },
    onSuccess: (result) => {
      setSelected(new Set());
      setNotice({ tone: 'success', text: `${CPA_LOCKED_LABEL} ${result.locked.length || result.alreadyLocked.length} 个 CPA 产物批次` });
      client.invalidateQueries({ queryKey: ['cpa-artifacts'], refetchType: 'none' });
    },
    onError: (error, _variables, context) => {
      if (context?.previous) client.setQueryData(artifactQueryKey, context.previous);
      setNotice({ tone: 'danger', text: errorMessage(error) });
    },
  });
  const unlockBatch = useMutation({
    mutationFn: (items: CpaArtifactItem[]) => endpoints.unlockCpaBatch(items),
    onMutate: (items) => {
      void client.cancelQueries({ queryKey: ['cpa-artifacts'] });
      const previous = client.getQueryData<CpaArtifactsPayload>(artifactQueryKey);
      client.setQueryData<CpaArtifactsPayload>(artifactQueryKey, (current) => patchCpaLockState(current, items, false));
      return { previous };
    },
    onSuccess: (result) => {
      setSelected(new Set());
      const restored = result.restored?.length || 0;
      setNotice({ tone: 'success', text: `${CPA_UNLOCK_BATCH_LABEL} ${result.unlocked.length || result.alreadyUnlocked.length} 个 CPA 产物批次${restored ? `，${restored} 个已归档登录态已恢复到登录态列表` : ''}` });
      client.invalidateQueries({ queryKey: ['cpa-artifacts'], refetchType: 'none' });
      if (restored) client.invalidateQueries({ queryKey: ['session-assets'] });
    },
    onError: (error, _variables, context) => {
      if (context?.previous) client.setQueryData(artifactQueryKey, context.previous);
      setNotice({ tone: 'danger', text: errorMessage(error) });
    },
  });
  const removeMany = useMutation({
    mutationFn: () => endpoints.deleteRuns(selectedRunIds, batchRemoveArtifacts),
    onSuccess: (result) => {
      setSelectedRuns(new Set());
      setNotice({ tone: 'success', text: `已删除 ${result.removed.length} 条任务历史` });
      client.invalidateQueries({ queryKey: ['runs'] });
      client.invalidateQueries({ queryKey: ['cpa-artifacts'] });
    },
    onError: (error) => setNotice({ tone: 'danger', text: errorMessage(error) }),
  });
  const toggle = (artifact: CpaArtifact) => setSelected((current) => {
    if (artifact.locked === true) return current;
    const next = new Set(current);
    const key = artifactSelectionKey(artifact);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const toggleDeliveryGroup = (groupKey: string) => setExpandedDeliveryGroups((current) => {
    const next = new Set(current);
    if (next.has(groupKey)) next.delete(groupKey); else next.add(groupKey);
    return next;
  });
  const toggleDeliveryBatch = (group: ArtifactDeliveryGroup) => setSelected((current) => {
    const next = new Set(current);
    const keys = group.rows
      .filter(({ artifact }) => artifact.locked !== true)
      .map(({ artifact }) => artifactSelectionKey(artifact));
    const shouldSelect = keys.some((key) => !next.has(key));
    for (const key of keys) {
      if (shouldSelect) next.add(key); else next.delete(key);
    }
    return next;
  });
  const updateDeliveryNote = (groupKey: string, value: string) => setDeliveryNotes((current) => {
    const next = { ...current };
    const note = value.slice(0, CPA_DELIVERY_NOTE_MAX_LENGTH);
    if (note.trim()) next[groupKey] = note;
    else delete next[groupKey];
    return next;
  });
  const lockDeliveryBatch = (group: ArtifactDeliveryGroup) => {
    const items = group.rows
      .filter(({ artifact }) => artifact.locked !== true)
      .map(({ artifact }) => ({ runId: artifact.runId, jobId: artifact.jobId, key: artifact.key }));
    if (!items.length || !group.deliveryAt) return;
    lockBatch.mutate({ items, batchKey: group.key });
  };
  const unlockDeliveryBatch = (group: ArtifactDeliveryGroup) => {
    const items = group.rows
      .filter(({ artifact }) => artifact.locked === true)
      .map(({ artifact }) => ({ runId: artifact.runId, jobId: artifact.jobId, key: artifact.key }));
    if (!items.length || !group.deliveryAt) return;
    unlockBatch.mutate(items);
  };
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(selectableArtifactRows.map(artifactSelectionKey)));
  const toggleRun = (runId: string) => setSelectedRuns((current) => {
    const next = new Set(current);
    if (next.has(runId)) next.delete(runId); else next.add(runId);
    return next;
  });
  const toggleAllRuns = () => setSelectedRuns(allRunsSelected ? new Set() : new Set(runRows.map((run) => run.runId)));

  const renderDeliveryDivider = ({ group, collapsed, collapseKey }: Extract<ArtifactVirtualRow, { kind: 'divider' }>) => {
    const counts = groupSelectionCounts.get(group.key) || { selectable: 0, selected: 0 };
    const groupSelected = counts.selectable > 0 && counts.selected === counts.selectable;
    const groupPartiallySelected = counts.selected > 0 && !groupSelected;
    const groupLabel = group.deliveryAt ? formatTime(group.deliveryAt) : '未导出';
    const showCountExport = lifecycleFilter === 'sold' && group.key === UNDELIVERED_DELIVERY_GROUP && !group.locked;
    const exportCount = Number(soldExportCount);
    // The count export can be held to one registration country. Options come
    // from the unlocked rows actually on this shelf, so every choice offered
    // has stock behind it; a country that has sold out drops back to all.
    const unlockedRows = group.rows.filter(({ artifact }) => artifact.locked !== true);
    const countryCounts = new Map<string, number>();
    // '' means "every country" in the picker, so a row with no recorded
    // country gets its own token instead of colliding with it.
    const rowCountry = (artifact: CpaArtifact) => String(artifact.registrationCountry || '').toUpperCase() || UNKNOWN_REGISTRATION_COUNTRY;
    for (const { artifact } of unlockedRows) {
      const country = rowCountry(artifact);
      countryCounts.set(country, (countryCounts.get(country) || 0) + 1);
    }
    const exportCountry = countryCounts.has(soldExportCountry) ? soldExportCountry : '';
    const countryOptions = [
      { value: '', label: `全部注册国（${unlockedRows.length}）` },
      ...[...countryCounts.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .map(([country, count]) => ({
          value: country,
          label: `${registrationCountryLabel(country)}（${count}）`,
        })),
    ];
    const countryRows = exportCountry
      ? unlockedRows.filter(({ artifact }) => rowCountry(artifact) === exportCountry)
      : unlockedRows;
    // Never offer more than one request can carry: all three endpoints refuse
    // a selection above the same server-side cap, and a 400 after the operator
    // typed a number is a worse answer than a `max` they can see.
    const countExportMax = Math.min(countryRows.length, CPA_EXPORT_BATCH_LIMIT);
    const validExportCount = Number.isInteger(exportCount) && exportCount > 0 && exportCount <= countExportMax;
    // Any format leaves the form busy, not just the one that was picked.
    const countExportBusy = exportSelected.isPending || exportCpaCredentials.isPending || exportSub2Api.isPending || pushNvtokens.isPending;
    const countExportDisabled = !validExportCount || countExportBusy || artifacts.isFetching;
    const countToPool = soldExportFormat === 'nvpool';
    // The shelf is sorted newest CPA first, and the three download formats take
    // from the top. nv 入池 takes from the bottom instead: what goes to the pool
    // is the stock that has waited longest.
    const countCandidates = countryRows;
    const countryNote = exportCountry ? `注册国 ${registrationCountryLabel(exportCountry)} 的` : '';
    const countItems = validExportCount
      ? (countToPool ? countCandidates.slice(-exportCount).reverse() : countCandidates.slice(0, exportCount))
        .map(({ artifact: { runId, jobId, key } }) => ({ runId, jobId, key }))
      : [];
    return <div className={`artifact-delivery-divider${collapsed ? ' artifact-delivery-divider-collapsed' : ''}${showCountExport ? ' artifact-delivery-divider-count-export' : ''}`}>
      <label className="artifact-batch-select">
        <input
          type="checkbox"
          aria-label={`选择批次 ${groupLabel}（${group.rows.length} 个）`}
          checked={groupSelected}
          ref={(input) => { if (input) input.indeterminate = groupPartiallySelected; }}
          onChange={() => toggleDeliveryBatch(group)}
          disabled={group.locked || !counts.selectable}
        />
      </label>
      <button
        type="button"
        className="artifact-delivery-toggle"
        aria-expanded={!collapsed}
        aria-label={`${collapsed ? '展开' : '收起'}批次 ${groupLabel}`}
        onClick={() => toggleDeliveryGroup(collapseKey)}
      >
        <ChevronDown size={14} aria-hidden="true" />
        {group.deliveryAt
          ? <time dateTime={group.deliveryAt}>导出/推送于 {groupLabel} · {group.rows.length} 个</time>
          : <span className="artifact-delivery-label">未导出 · {group.rows.length} 个</span>}
      </button>
      {showCountExport && <form className="artifact-count-export" onSubmit={(event) => {
        event.preventDefault();
        // 入池 sells at a price, so it only ever goes through its confirmation;
        // pressing Enter in the count box must not skip that.
        if (countExportDisabled || countToPool) return;
        const items = countItems;
        // Three endpoints, one selection. `credentials` reads the password and
        // 2FA secret off each linked login state, so it is the only one that
        // can refuse a row the CPA listing looks happy about.
        // A country-held export says so in its file name.
        const fileTag = exportCountry ? registrationCountryFileTag(exportCountry) : '';
        if (soldExportFormat === 'credentials') exportCpaCredentials.mutate({ items, unexportedOnly: true, fileTag });
        else if (soldExportFormat === 'sub2api') exportSub2Api.mutate({ selection: { items, unexportedOnly: true }, fileTag });
        else exportSelected.mutate({ selection: { items, unexportedOnly: true }, fileTag });
      }}>
        <label>
          导出数量
          <input
            type="number"
            min={1}
            max={countExportMax}
            step={1}
            required
            value={soldExportCount}
            onChange={(event) => setSoldExportCount(event.target.value)}
            disabled={countExportBusy}
            aria-invalid={!validExportCount}
            title={countryRows.length > CPA_EXPORT_BATCH_LIMIT
              ? `请输入 1–${countExportMax} 的整数，按当前排序导出${countryNote}账号；可选共 ${countryRows.length} 个，单次最多 ${CPA_EXPORT_BATCH_LIMIT} 个`
              : `请输入 1–${countExportMax} 的整数，按当前排序导出${countryNote}账号`}
          />
        </label>
        <AppSelect
          className="artifact-count-export-country"
          ariaLabel="注册国"
          value={exportCountry}
          onValueChange={setSoldExportCountry}
          options={countryOptions}
          disabled={countExportBusy}
          searchable={countryOptions.length > 8}
        />
        <AppSelect
          className="artifact-count-export-format"
          ariaLabel="导出格式"
          value={soldExportFormat}
          onValueChange={(value) => setSoldExportFormat(value as SoldExportFormat)}
          options={SOLD_EXPORT_FORMATS.map(({ value, label }) => ({ value, label }))}
          disabled={countExportBusy}
        />
        {countToPool
          ? <ConfirmDialog
            trigger={<Button type="button" tone="quiet" icon={pushNvtokens.isPending ? <LoaderCircle className="spin" size={14} /> : <Archive size={14} />} disabled={countExportDisabled} title={SOLD_EXPORT_FORMAT_HINTS.nvpool}>按数量入池 nv</Button>}
            title="按数量推入 nvtokens 号池"
            description={`把「未导出」里库存最久的 ${countItems.length} 个${countryNote}账号以设定价格推入 nvtokens 号池（读取登录态里的邮箱、密码和长期 2FA）。平台接收成功即记为已导出。`}
            confirmLabel="确认入池"
            onConfirm={() => pushNvtokens.mutate(createNvtokensPushRequest('pool', countItems, nvtokensPriceYuan))}
          >
            <label className="dialog-number-field">
              <span>价格（元/个）</span>
              <ConfigNumberInput min={0.01} max={100000} step={0.01} value={nvtokensPriceYuan} onValueChange={setNvtokensPriceYuan} />
            </label>
          </ConfirmDialog>
          : <Button type="submit" tone="quiet" icon={<Download size={14} />} disabled={countExportDisabled} title={SOLD_EXPORT_FORMAT_HINTS[soldExportFormat]}>按数量导出{SOLD_EXPORT_FORMAT_LABELS[soldExportFormat]}</Button>}
      </form>}
      {group.deliveryAt && <input
        className="artifact-delivery-note"
        type="text"
        value={deliveryNotes[group.key] || ''}
        maxLength={CPA_DELIVERY_NOTE_MAX_LENGTH}
        placeholder="添加标注"
        aria-label={`编辑批次标注 ${groupLabel}`}
        title="编辑批次标注"
        onChange={(event) => updateDeliveryNote(group.key, event.target.value)}
        onClick={(event) => event.stopPropagation()}
      />}
      {group.locked
        ? <>
          <span className="artifact-batch-locked" title="该批次已锁定，仅供查看"><Lock size={13} aria-hidden="true" />{CPA_LOCKED_LABEL}</span>
          <ConfirmDialog
            trigger={<IconButton label={`${CPA_UNLOCK_BATCH_LABEL} ${groupLabel}`} title="解锁后恢复该批次的操作" disabled={lockBatch.isPending || unlockBatch.isPending}><Unlock size={14} /></IconButton>}
            title="解锁 CPA 批次"
            description={`解锁后，该批次的 ${group.rows.length} 个 CPA 产物将恢复可选、导出、推送、下载和删除；已归档的登录态会一并恢复到登录态列表，再次锁定后重新计满 24 小时才会归档。`}
            confirmLabel="确认解锁"
            onConfirm={() => unlockDeliveryBatch(group)}
          />
        </>
        : group.deliveryAt && <ConfirmDialog
          trigger={<IconButton label={`${CPA_LOCK_BATCH_LABEL} ${groupLabel}`} title="锁定后该批次只保留显示，不再选择、导出或推送" disabled={lockBatch.isPending || unlockBatch.isPending}><Lock size={14} /></IconButton>}
          title="锁定 CPA 批次"
          description={`锁定后，该批次的 ${group.rows.length} 个 CPA 产物只保留显示，不再选择、导出、推送、下载或删除；不会删除文件。`}
          confirmLabel="确认锁定"
          onConfirm={() => lockDeliveryBatch(group)}
        />}
    </div>;
  };

  const renderArtifactCard = (artifact: CpaArtifact, index: number, collapsible: boolean) => {
    const artifactKey = artifactSelectionKey(artifact);
    const selectedRow = selected.has(artifactKey);
    const inRange = artifactRange.isInRange(index);
    const deliveries = artifactDeliveryEntries(artifact).map(({ label }) => label);
    const exported = deliveries.length > 0;
    const pushedToNvtokens = deliveries.some((label) => label.startsWith('nvtokens '));
    const bucket = cpaLifecycleBucket(artifact);
    // A CPA belongs to a child mailbox only when it has a root of its own.
    // Under the `root` alias strategy the account *is* the mailbox, so
    // `parentEmail` equals the address — and a registration job still carries
    // the default `aliasIndex: 1`, which printed `子邮箱 #1` on accounts that
    // have no parent mailbox at all. The root decides the label, not the index,
    // and a locked batch froze its index at lock time, so this has to be judged
    // here as well as where the record is built.
    const rootEmail = artifact.parentEmail && artifact.parentEmail !== artifact.email ? artifact.parentEmail : '';
    return <div className={`artifact-card${collapsible ? ' artifact-delivery-card' : ''}${artifact.isPlus ? ' artifact-card-plus' : ''}${selectedRow ? ' artifact-card-selected' : ''}${inRange ? ' artifact-card-range' : ''}`} data-selected={selectedRow} key={artifactKey} {...artifactRange.rowProps(index)}>
      <div className="artifact-card-head">
        <input aria-label={`选择 ${artifact.fileName}`} type="checkbox" checked={selectedRow} onChange={() => toggle(artifact)} disabled={artifact.locked === true} />
        <strong className={exported ? 'artifact-name-exported' : 'artifact-name-pending'} title={exported ? `${artifact.fileName} · 已${deliveries.join('、')}` : `${artifact.fileName} · 未导出`}>{artifact.fileName}</strong>
        {bucket !== 'none' && bucket !== 'active' && <span className={`session-classification-tag session-classification-${bucket}`}>{CPA_LIFECYCLE_LABELS[bucket]}</span>}
        {artifact.sub2ApiPushedAt && <span className="session-classification-tag session-classification-pushed" title={`已推送到 sub2api · ${formatTime(artifact.sub2ApiPushedAt)}`}>已推送</span>}
        {pushedToNvtokens && <span className="session-classification-tag session-classification-pushed" title="已推送到 nvtokens">已推送 nv</span>}
      </div>
      <div className="artifact-card-body">
        {/* The address is what identifies the account this file belongs to, so
            it leads. It used to arrive masked as `C***@…`, which is the one
            thing needed to match a CPA to a mailbox. */}
        <small className="artifact-alias" title={artifact.email || artifact.jobId}>{artifact.email || artifact.jobId}</small>
        <small className="artifact-origin">
          {rootEmail ? <span title={`根邮箱 ${rootEmail}`}>根 {rootEmail}</span> : null}
          {rootEmail && artifact.aliasIndex ? <span>子邮箱 #{artifact.aliasIndex}</span> : null}
          <span title={artifact.runId}>{artifact.runId}</span>
        </small>
      </div>
      <div className="artifact-card-foot">
        <div className="artifact-meta"><StatusBadge status={artifact.runStatus} /><span>{formatBytes(artifact.size)}</span><time>{formatTime(artifact.modifiedAt)}</time></div>
        <div className="artifact-card-actions">
          {artifact.locked
            ? <IconButton label={`${CPA_LOCKED_LABEL} ${artifact.fileName}`} disabled><Lock size={16} /></IconButton>
            : <>
              <IconButton label={`下载 ${artifact.fileName} 的 sub2api`} onClick={() => exportSub2Api.mutate({ selection: { items: [{ runId: artifact.runId, jobId: artifact.jobId, key: artifact.key }] }, fileName: sub2ApiFileName(artifact.fileName) })} disabled={exportSub2Api.isPending}><FileOutput size={16} /></IconButton>
              <a className="icon-button" aria-label={`下载 ${artifact.fileName}`} href={`/api/v1/artifacts/cpa/download?key=${encodeURIComponent(artifact.key)}`}><Download size={16} /></a>
            </>}
        </div>
      </div>
    </div>;
  };

  return <div className="history-page">
    <PageHeader title="CPA 产物" description="按登录态生命周期分页管理；批次与批量操作针对当前页，任务历史可展开" actions={
      <>
        <Button
          tone="primary"
          icon={exportSelected.isPending ? <LoaderCircle className="spin" size={17} /> : <Download size={17} />}
          disabled={!unexportedCount || exportSelected.isPending}
          title={unexportedCount ? `导出「${lifecycleTabLabel}」里 ${unexportedCount} 个还没导出过的产物；导出后它们会被标记，下次不再重复` : `「${lifecycleTabLabel}」里的产物都已导出过`}
          onClick={() => exportSelected.mutate({ selection: { items: unexportedRows.map(({ runId, jobId, key }) => ({ runId, jobId, key })) } })}
        >导出本页未导出{unexportedCount ? ` (${unexportedCount})` : ''}</Button>
        <a className={`button button-default${latestRunWithCpa ? '' : ' button-disabled'}`} aria-disabled={!latestRunWithCpa} tabIndex={latestRunWithCpa ? 0 : -1} href={latestRunWithCpa ? `/api/v1/runs/${encodeURIComponent(latestRunWithCpa.runId)}/cpa` : undefined} title={latestRunWithCpa?.runId} onClick={(event) => { if (!latestRunWithCpa) event.preventDefault(); }}><Download size={17} />导出上次任务 CPA</a>
      </>
    } />
    {notice && <Notice tone={notice.tone} floating onClose={() => setNotice(null)} autoDismissToken={notice}>{notice.text}</Notice>}
    {runs.error && <Notice tone="danger">任务历史加载失败：{errorMessage(runs.error)} <Button onClick={() => runs.refetch()}>重试</Button></Notice>}
    {artifacts.error && <Notice tone="danger">CPA 列表加载失败：{errorMessage(artifacts.error)} <Button onClick={() => artifacts.refetch()}>重试</Button></Notice>}
    <details className="history-drawer">
      <summary className="history-drawer-summary">
        <span className="history-drawer-title"><ChevronRight size={15} className="history-drawer-chevron" /><History size={15} />任务历史<em>{runs.data?.total ?? runRows.length}</em></span>
        <small>不常看——需要时展开管理与删除</small>
      </summary>
      <div className="history-drawer-body" inert={runs.isPlaceholderData}>
        <div className="history-drawer-actions">
          {runRows.length > 0 && <label className="artifact-select-all"><input type="checkbox" checked={allRunsSelected} onChange={toggleAllRuns} />全选本页任务</label>}
          <IconButton label={`导出选中任务 CPA${selectedRunCpaIds.length ? ` (${selectedRunCpaIds.length})` : ''}`} onClick={() => exportSelected.mutate({ selection: { runIds: selectedRunCpaIds } })} disabled={!selectedRunCpaIds.length || exportSelected.isPending}><Download size={16} /></IconButton>
          <IconButton label={`按单文件打包导出选中任务 CPA${selectedRunCpaIds.length ? ` (${selectedRunCpaIds.length})` : ''}`} onClick={() => exportCpaArchive.mutate({ runIds: selectedRunCpaIds })} disabled={!selectedRunCpaIds.length || exportCpaArchive.isPending}><FolderDown size={16} /></IconButton>
          <ConfirmDialog trigger={<IconButton label={selectedRunRows.length && !selectedRunsDeletable ? '活动或未结束任务不能删除' : `删除选中任务历史${selectedRunIds.length ? ` (${selectedRunIds.length})` : ''}`} disabled={!selectedRunsDeletable || removeMany.isPending}><Trash2 size={16} /></IconButton>} title="批量删除任务历史" description={`将永久删除选中的 ${selectedRunIds.length} 条状态与日志记录。`} danger confirmLabel="确认删除" onConfirm={() => removeMany.mutate()}><label className="delete-option"><input type="checkbox" checked={batchRemoveArtifacts} onChange={(event) => setBatchRemoveArtifacts(event.target.checked)} />同时删除这些任务的 CPA 产物</label></ConfirmDialog>
        </div>
        <div className="history-scroll history-list">{runRows.length ? runRows.map((run) => {
          const deletable = ['complete', 'partial', 'cancelled', 'failed'].includes(run.status) && !run.active;
          return <div className="history-item" key={run.runId}><input aria-label={`选择历史 ${run.runId}`} type="checkbox" checked={selectedRuns.has(run.runId)} onChange={() => toggleRun(run.runId)} /><div className="history-main"><div><StatusBadge status={run.status} label={runStatusLabel(run.status)} /><strong>{taskKindLabel(run.taskKind || run.plan?.taskKind, run.plan)}</strong><span className="history-slot">{runTaskSlotLabel(run)}</span></div><p className="history-desc">{runTaskDescription(run) || '—'}</p><p className="history-meta"><code>{run.runId}</code><span>更新于 {formatTime(run.updatedAt)}</span><span title={phaseLabel(run.phase).raw}>{phaseLabel(run.phase).label}</span></p></div><div className="history-count"><span>登录态<strong>{run.counts?.sessionsSaved ?? run.counts?.accountsCreated ?? 0}</strong></span><span>CPA 产出<strong>{run.counts?.cpaCompleted ?? 0}</strong></span>{Boolean(run.counts?.deactivated) && <span title="运行期间被 OpenAI 关停的账号，不计入失败">封禁<strong>{run.counts?.deactivated}</strong></span>}</div><div className="history-actions"><Link className="button button-quiet" to={`/run/${run.runId}`}>详情</Link>{runsWithRetainedCpa.has(run.runId) && <a className="icon-button" aria-label={`下载 ${run.runId} 的 CPA`} href={`/api/v1/runs/${encodeURIComponent(run.runId)}/cpa`}><Download size={17} /></a>}{deletable && <ConfirmDialog trigger={<IconButton label="删除历史"><Trash2 size={17} /></IconButton>} title="删除运行历史" description="状态和日志删除后无法恢复任务。CPA 默认保留。" danger confirmLabel="确认删除" onConfirm={() => remove.mutate(run.runId)}><label className="delete-option"><input type="checkbox" checked={removeArtifacts} onChange={(event) => setRemoveArtifacts(event.target.checked)} />同时删除 CPA 产物</label></ConfirmDialog>}</div></div>;
        }) : <EmptyState icon={<History size={26} />} title="暂无历史任务" detail="完成、暂停和取消的任务都会保留在这里。" />}</div>
        <Pagination label="任务历史分页" total={runs.data?.total ?? runRows.length} offset={runOffset} busy={runs.isFetching} onChange={setRunOffset} />
      </div>
    </details>
    <section className={`workspace-band artifact-panel artifact-panel-primary${artifactRefreshing ? ' artifact-panel-refreshing' : ''}`} aria-busy={artifactInitialLoading || artifactRefreshing} inert={artifacts.isPlaceholderData}>
      <div className="artifact-filter-tabs" role="tablist" aria-label="CPA 生命周期分类">
        <button type="button" role="tab" aria-selected={lifecycleFilter === 'all'} className={lifecycleFilter === 'all' ? 'selected' : ''} onClick={() => setLifecycleFilter('all')}>全部<span>{lifecycleCounts.all}</span></button>
        <button type="button" role="tab" aria-selected={lifecycleFilter === 'fresh'} className={lifecycleFilter === 'fresh' ? 'selected' : ''} onClick={() => setLifecycleFilter('fresh')} title="还没有导出过的产物，或导出后又重新生成的；已归类为计划卖出、自用、已卖出的不再计入">最新<span>{lifecycleCounts.fresh}</span></button>
        <button type="button" role="tab" aria-selected={lifecycleFilter === 'planned'} className={lifecycleFilter === 'planned' ? 'selected' : ''} onClick={() => setLifecycleFilter('planned')}>计划卖出<span>{lifecycleCounts.planned}</span></button>
        <button type="button" role="tab" aria-selected={lifecycleFilter === 'self_use'} className={lifecycleFilter === 'self_use' ? 'selected' : ''} onClick={() => setLifecycleFilter('self_use')} title="留作自用的账号。它们仍然参与刷新、提链与优惠检测，只是不进出货池">自用<span>{lifecycleCounts.self_use}</span></button>
        <button type="button" role="tab" aria-selected={lifecycleFilter === 'sold'} className={lifecycleFilter === 'sold' ? 'selected' : ''} onClick={() => setLifecycleFilter('sold')}>已卖出<span>{lifecycleCounts.sold}</span></button>
        <div className="artifact-type-filter"><AppSelect ariaLabel="类型筛选" value={typeFilter} onValueChange={(value) => setTypeFilter(value as 'all' | 'plus' | 'oauth')} options={[{ value: 'all', label: `全部类型 · ${typeCounts.all}` }, { value: 'plus', label: `Plus · ${typeCounts.plus}` }, { value: 'oauth', label: `普通 OAuth · ${typeCounts.oauth}` }]} /></div>
      </div>
      <div className="section-heading"><div><div className="artifact-heading-title"><h2>CPA 文件</h2><span className={`artifact-refresh-indicator${artifactRefreshing ? ' is-active' : ''}`} role="status" aria-label={artifactRefreshing ? '正在刷新 CPA 文件' : undefined}>{artifactRefreshing && <LoaderCircle aria-hidden="true" size={15} />}</span></div><p>共 {artifacts.data?.total ?? artifactRows.length} 个文件 · 本页 {artifactRows.length} 个</p></div><div className="history-heading-actions artifact-action-groups">
        {artifactRows.length > 0 && <label className="artifact-select-all"><input type="checkbox" checked={allSelected} onChange={toggleAll} />全选本页{selectedArtifacts.length > 0 && !allSelected ? `（${selectedArtifacts.length}）` : ''}</label>}
        <div className="artifact-action-group" role="group" aria-label="归类">
           <Button tone="quiet" icon={<Tag size={15} />} disabled={lifecycleActionDisabled} title={lifecycleActionTitle || (selectedArtifacts.length && !selectedAssetIds.length ? '选中的产物未关联账号，无法归类' : `移回在库${selectedAssetIds.length ? ` (${selectedAssetIds.length})` : ''}`)} onClick={() => classify.mutate('active')}>在库</Button>
           <Button tone="quiet" icon={<Tag size={15} />} disabled={lifecycleActionDisabled} title={lifecycleActionTitle} onClick={() => classify.mutate('planned')}>计划卖出</Button>
           <Button tone="quiet" icon={<Tag size={15} />} disabled={lifecycleActionDisabled} title={lifecycleActionTitle || (selectedArtifacts.length && !selectedAssetIds.length ? '选中的产物未关联账号，无法归类' : `标记为自用${selectedAssetIds.length ? ` (${selectedAssetIds.length})` : ''}`)} onClick={() => classify.mutate('self_use')}>自用</Button>
           <ConfirmDialog trigger={<Button tone="quiet" icon={<Tag size={15} />} disabled={lifecycleActionDisabled} title={lifecycleActionTitle}>已卖出</Button>} title="归类为已卖出" description={`将选中的 ${selectedAssetIds.length} 个已关联账号的产物标记为已卖出，同时更新对应登录态。不会删除会话或 CPA 文件。`} confirmLabel="确认归类" onConfirm={() => classify.mutate('sold')} />
        </div>
        {lifecycleFilter === 'self_use' && <>
          <span className="artifact-action-sep" aria-hidden="true" />
          <div className="artifact-action-group" role="group" aria-label="推送">
            <ConfirmDialog
              trigger={<Button tone="primary" icon={pushSub2Api.isPending ? <LoaderCircle className="spin" size={15} /> : <Upload size={15} />} disabled={!selectedArtifacts.length || pushSub2Api.isPending}>发送到 sub2api{selectedArtifacts.length ? ` (${selectedArtifacts.length})` : ''}</Button>}
              title="发送到 sub2api"
              description={`把选中的 ${selectedArtifacts.length} 个账号导入本机 sub2api 网关（配置项 sub2api.baseUrl）。已存在的账号会更新为新令牌；AT 已过期的会被网关拒绝并单独报出。导入成功的账号会自动归类为自用。`}
              confirmLabel="确认发送"
              onConfirm={() => pushSub2Api.mutate(selectedArtifactItems)}
            />
          </div>
        </>}
        {lifecycleFilter === 'sold' && <>
          <span className="artifact-action-sep" aria-hidden="true" />
          <div className="artifact-action-group artifact-action-group-nv" role="group" aria-label="nvtokens 出货">
            <AppSelect
              className="artifact-nvtokens-kind"
              ariaLabel="nvtokens 推送方式"
              value={nvtokensKind}
              onValueChange={(value) => setNvtokensKind(value as NvtokensPushKind)}
              options={NVTOKENS_KIND_ORDER.map((kind) => ({ value: kind, label: `nv ${NVTOKENS_KINDS[kind].label}` }))}
              disabled={nvtokensBusy}
            />
            {(() => {
              const spec = NVTOKENS_KINDS[nvtokensKind];
              const Icon = spec.icon;
              const freshCount = selectedNvtokensSplit.fresh.length;
              const sentCount = selectedNvtokensSplit.sent.length;
              return <ConfirmDialog
                trigger={<Button tone="primary" icon={nvtokensBusy ? <LoaderCircle className="spin" size={15} /> : <Icon size={15} />} disabled={!freshCount || nvtokensBusy || pushSub2Api.isPending} title={selectedArtifacts.length && !freshCount ? `选中的都已用「${spec.label}」推送过` : undefined}>推送 nv{freshCount ? ` (${freshCount})` : ''}</Button>}
                title={spec.title}
                description={spec.description(freshCount, sentCount)}
                confirmLabel={spec.confirmLabel}
                onConfirm={() => pushNvtokens.mutate(createNvtokensPushRequest(nvtokensKind, selectedArtifactItems, nvtokensPriceYuan))}
              >
                {nvtokensKind === 'pool' && <label className="dialog-number-field">
                  <span>价格（元/个）</span>
                  <ConfigNumberInput min={0.01} max={100000} step={0.01} value={nvtokensPriceYuan} onValueChange={setNvtokensPriceYuan} />
                </label>}
              </ConfirmDialog>;
            })()}
          </div>
        </>}
        <span className="artifact-action-sep" aria-hidden="true" />
        <div className="artifact-action-group" role="group" aria-label="导出">
          <IconButton label={`导出选中 CPA${selectedArtifacts.length ? ` (${selectedArtifacts.length})` : ''}`} onClick={() => exportSelected.mutate({ selection: { items: selectedArtifactItems } })} disabled={!selectedArtifacts.length || exportSelected.isPending}><Download size={16} /></IconButton>
          <IconButton label={`导出选中账号：邮箱----密码----2FA${selectedArtifacts.length ? ` (${selectedArtifacts.length})` : ''}`} onClick={() => exportCpaCredentials.mutate({ items: selectedArtifactItems })} disabled={!selectedArtifacts.length || exportCpaCredentials.isPending}><KeyRound size={16} /></IconButton>
          <IconButton label={`导出选中 sub2api${selectedArtifacts.length ? ` (${selectedArtifacts.length})` : ''}`} onClick={() => exportSub2Api.mutate({ selection: { items: selectedArtifactItems } })} disabled={!selectedArtifacts.length || exportSub2Api.isPending}><FileOutput size={16} /></IconButton>
          <IconButton label={`按单文件打包导出选中 CPA${selectedArtifacts.length ? ` (${selectedArtifacts.length})` : ''}`} onClick={() => exportCpaArchive.mutate({ items: selectedArtifactItems })} disabled={!selectedArtifacts.length || exportCpaArchive.isPending}><FolderDown size={16} /></IconButton>
          <IconButton label={`按单文件打包导出选中 sub2api${selectedArtifacts.length ? ` (${selectedArtifacts.length})` : ''}`} onClick={() => exportSub2ApiArchive.mutate({ items: selectedArtifactItems })} disabled={!selectedArtifacts.length || exportSub2ApiArchive.isPending}><FolderArchive size={16} /></IconButton>
        </div>
        <span className="artifact-action-sep" aria-hidden="true" />
        <ConfirmDialog trigger={<IconButton label={selectedArtifacts.length && !selectedArtifactsDeletable ? '活动任务的 CPA 不能清理' : `清理选中 CPA${selectedArtifacts.length ? ` (${selectedArtifacts.length})` : ''}`} disabled={!selectedArtifactsDeletable || cleanup.isPending}><Trash2 size={16} /></IconButton>} title="批量清理 CPA 产物" description={`将永久删除选中的 ${selectedArtifacts.length} 个 CPA 文件，运行状态与日志会保留。`} danger confirmLabel="确认清理" onConfirm={() => cleanup.mutate()} />
      </div></div>
      {pushBar && <div className="artifact-push-progress" role="progressbar" aria-valuenow={pushBar.done} aria-valuemin={0} aria-valuemax={pushBar.total} aria-label={`${pushBar.label} 进度`}>
        <div className="artifact-push-progress-track">
          <div className="artifact-push-progress-fill" style={{ width: `${Math.max(3, Math.round((pushBar.done / Math.max(1, pushBar.total)) * 100))}%` }} />
        </div>
        <small>正在执行 {pushBar.label} <b>{pushBar.done}/{pushBar.total}</b></small>
      </div>}
      {pushOutcome && <div className={`push-result push-result-${pushOutcome.tone}`} role="status">
        <div className="push-result-head">
          {pushOutcome.tone === 'success' ? <Check size={14} aria-hidden="true" /> : <AlertTriangle size={14} aria-hidden="true" />}
          <strong>{pushOutcome.label}</strong>
          <span className="push-result-summary">{pushOutcome.summary}</span>
          <time dateTime={new Date(pushOutcome.at).toISOString()}>{formatTime(new Date(pushOutcome.at).toISOString())}</time>
          <IconButton label="清除推送结果" onClick={() => pageResults.clear(CPA_PUSH_GROUP)}><X size={13} /></IconButton>
        </div>
        {pushOutcome.errors.length > 0 && <p className="push-result-errors">{pushOutcome.errors.slice(0, 3).join('；')}</p>}
        {pushOutcome.lines.length > 0 && <details className="push-result-detail">
          <summary>没有发出的 {pushOutcome.lines.length} 个账号 · 修好后再点一次，只会补发没入池的</summary>
          <ul>{pushOutcome.lines.map((line, index) => <li key={`${line.email}-${index}`}><code>{line.email || '未知账号'}</code><span>{line.reason}</span></li>)}</ul>
        </details>}
      </div>}
      <div className="artifact-body">
      <div className={`artifact-scroll${artifactRange.dragging ? ' artifact-range-selecting' : ''}`} {...artifactRange.containerProps}>
        {artifactInitialLoading
          ? <div className="artifact-loading-state" role="status"><LoaderCircle className="spin" size={17} /><span>正在读取 CPA 文件</span></div>
          : artifactRows.length
            ? <div
                className={`artifact-virtual-body${measuredGrid ? '' : ' artifact-virtual-body-unmeasured'}`}
                ref={gridRef}
                style={measuredGrid ? { height: `${artifactVirtual.getTotalSize()}px` } : undefined}
              >
                {renderedArtifactRows.map((item) => {
                  const row = virtualRows[item.index];
                  if (!row) return null;
                  return <div
                    className={`artifact-virtual-row${row.kind === 'divider' ? ' artifact-virtual-row-divider' : ''}`}
                    key={item.key}
                    data-index={item.index}
                    ref={artifactVirtual.measureElement}
                    style={measuredGrid ? { transform: `translateY(${item.start}px)` } : undefined}
                  >
                    {row.kind === 'divider'
                      ? renderDeliveryDivider(row)
                      : <div className="artifact-grid-row" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
                          {row.cards.map(({ artifact, index }) => renderArtifactCard(artifact, index, row.collapsible))}
                        </div>}
                  </div>;
                })}
              </div>
            : lifecycleFilter === 'fresh' && lifecycleCounts.all > 0
              // The page opens on 最新, so "nothing new" must not read as
              // "nothing at all" — say which it is, and offer the way out.
              ? <EmptyState
                  icon={<Check size={26} />}
                  title="没有新产物"
                  detail={`${lifecycleCounts.all} 个保留产物都已导出过，或已归类为计划卖出、自用、已卖出。重新生成的产物会重新出现在这里。`}
                  action={<Button tone="quiet" onClick={() => setLifecycleFilter('all')}>查看全部</Button>}
                />
              : <EmptyState icon={<FileJson size={26} />} title="暂无 CPA 文件" detail="新账号完成 OAuth 最终化后，CPA 文件会显示在这里。" />}
      </div>
      {lifecycleFilter === 'self_use' && <Sub2ApiErrorRail onNotice={setNotice} />}
      </div>
    <Pagination label="CPA 文件分页" total={artifacts.data?.total ?? artifactRows.length} offset={artifactOffset} busy={artifacts.isFetching} onChange={setArtifactOffset} />
    </section>
  </div>;
}

export default function App() {
  const { path, navigate } = useRouter();
  useEffect(() => {
    if (path === '/config') {
      navigate('/', { replace: true });
      return;
    }
    const known = path === '/' || path === '/run' || /^\/run\/[^/]+$/.test(path) || ['/sessions', '/rebind', '/robots', '/chains', '/proxies', '/history'].includes(path);
    if (!known) navigate('/', { replace: true });
  }, [path, navigate]);
  let page: ReactNode = <DashboardPage />;
  if (path === '/run' || /^\/run\/[^/]+$/.test(path)) page = <RunPage />;
  else if (path === '/sessions') page = <SessionAssetsPage />;
  else if (path === '/rebind') page = <RebindPage />;
  else if (path === '/robots') page = <RobotsPage />;
  else if (path === '/chains') page = <ChainsPage />;
  else if (path === '/proxies') page = <ProxyPage />;
  else if (path === '/history') page = <HistoryPage />;
  return <AppLayout>{page}</AppLayout>;
}
