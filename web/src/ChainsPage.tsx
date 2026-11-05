import { Pagination } from './components/Pagination';
/**
 * 提链控制台 — the shell that replaced the in-process extraction workbench.
 *
 * Execution lives in the external LinkOps service; what stays here is what
 * gpt-re owns: the account ledger, token import, and the routing that decides
 * which provider a registration country dispatches to. Extraction and payment
 * are separate tabs because they are separate decisions — a link is worth
 * having on its own, and only PayPal continues into a payment today.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Dialog, Switch } from 'radix-ui';
import {
  Ban,
  Check,
  ChevronRight,
  Copy,
  CreditCard,
  ExternalLink,
  KeyRound,
  Link2,
  LoaderCircle,
  Network,
  Play,
  RefreshCw,
  Route,
  RotateCcw,
  Send,
  ServerCog,
  Stethoscope,
  Trash2,
  Upload,
  X,
} from 'lucide-react';

import { endpoints } from './api';
import { AppSelect } from './components/AppSelect';
import { Button, ConfirmDialog, EmptyState, IconButton, Notice, PageHeader, StatusBadge, errorMessage, formatEpochSeconds, formatTime } from './components/ConsoleUi';
import { useRangeSelection } from './components/useRangeSelection';
import type { ChainPaymentSettings, ChainRecord, ChainSnapshot, LinkOpsJob, LinkOpsProxyPool } from './types';

const LIVE_JOB_STATUSES = new Set(['queued', 'running', 'awaiting_input']);
type JobFilter = 'all' | 'live' | 'done' | 'bad';
const JOB_FILTERS: Array<{ id: JobFilter; label: string }> = [
  { id: 'all', label: '全部' },
  { id: 'live', label: '进行中' },
  { id: 'bad', label: '失败' },
  { id: 'done', label: '已完成' },
];

/** Registration country -> provider, mirroring `src/chain-routing.js`. */
const PROVIDER_BY_COUNTRY: Record<string, string> = { IN: 'upi', VN: 'momo', ID: 'gopay' };
const PROVIDER_LABELS: Record<string, string> = { paypal: 'PayPal', upi: 'UPI', momo: 'MoMo', gopay: 'GoPay' };
/** Only PayPal has a payment stage today. */
const PAYABLE_PROVIDERS = new Set(['paypal']);


/**
 * The single-country providers pin their own pool country; the update hop is
 * theirs too, so nothing is inherited from the PayPal routing table. Kept in
 * step with `EXTRACTION_PROVIDERS` in src/chain-routing.js, which is what the
 * dispatch actually sends.
 */
const PROVIDER_FIXED_COUNTRY: Record<string, string> = { upi: 'IN', momo: 'VN', gopay: 'ID' };
const PROVIDER_UPDATE_COUNTRY: Record<string, string> = { upi: 'IN', gopay: 'ID' };

function providerFor(record: ChainRecord) {
  // An explicit choice at import wins, then what a past dispatch actually used,
  // then the registration country.
  return record.routeProvider || record.linkopsProvider || PROVIDER_BY_COUNTRY[(record.sourceCountryCode || '').toUpperCase()] || 'paypal';
}

type Route = { billingCountry?: string; checkoutCountry?: string; updateCountry?: string; applyCheckoutUpdate?: boolean };

/**
 * Where a row would actually dispatch, on all three axes.
 *
 * The engine validates each against a different table — the checkout region
 * picks the proxy pool, the billing country picks the currency profile — so the
 * console shows them apart rather than implying one country decides both.
 */
function routeFor(record: ChainRecord, rules: Record<string, Route>) {
  const provider = providerFor(record);
  const fixed = PROVIDER_FIXED_COUNTRY[provider];
  if (fixed) {
    return { provider, checkoutCountry: fixed, billingCountry: fixed, updateCountry: PROVIDER_UPDATE_COUNTRY[provider] || '' };
  }
  const source = (record.sourceCountryCode || '').toUpperCase();
  const rule = rules[record.routeKey || ''] || rules[source] || rules.default || {};
  return {
    provider,
    checkoutCountry: String(rule.checkoutCountry || '').toUpperCase(),
    billingCountry: String(rule.billingCountry || '').toUpperCase(),
    updateCountry: String(rule.updateCountry || rule.checkoutCountry || '').toUpperCase(),
  };
}

/** One engine batch: same provider, same option set. */
type LedgerBatch = {
  key: string;
  provider: string;
  checkoutCountry: string;
  billingCountry: string;
  updateCountry: string;
  label: string;
  hint: string;
  blocked: boolean;
  rows: ChainRecord[];
};

/**
 * A provider and the batches under it.
 *
 * The single-country providers only ever have one batch, so they render flat.
 * PayPal is the only one that fans out, and it fans out *inside* its own group
 * rather than across several top-level ones — the operator thinks "PayPal",
 * then "which country", not the other way round.
 */
type LedgerGroup = {
  key: string;
  label: string;
  rows: ChainRecord[];
  batches: LedgerBatch[];
  blocked: boolean;
};

const PAYMENT_GROUPS: Array<{ key: string; label: string; hint: string; match: (row: ChainRecord) => boolean }> = [
  { key: 'ready', label: '待发起', hint: '已有链接，尚未交给支付引擎', match: (row) => !row.paymentJobId && row.paymentStatus !== 'success' && row.paymentStatus !== 'failed' },
  { key: 'running', label: '进行中', hint: '支付作业执行中，可能在等验证码', match: (row) => Boolean(row.paymentJobId) && row.paymentStatus === 'pending' },
  { key: 'success', label: '已支付', hint: '', match: (row) => row.paymentStatus === 'success' },
  { key: 'failed', label: '失败', hint: '可重新发起', match: (row) => row.paymentStatus === 'failed' },
];

function jobTone(status: string) {
  if (status === 'completed') return 'complete';
  if (status === 'failed' || status === 'interrupted') return 'failed';
  if (status === 'cancelled') return 'idle';
  if (status === 'awaiting_input') return 'waiting';
  return 'running';
}

const SEEN_KEY = 'gpt-re-chain-seen-rows';

/**
 * Which rows the operator has already looked at, per batch.
 *
 * Batches are collapsed by default, so a count alone cannot say whether
 * anything happened since the last look. Stored per browser: it is a reading
 * aid, not shared state.
 */
function loadSeen(): Record<string, string[]> {
  try {
    const stored = JSON.parse(window.localStorage.getItem(SEEN_KEY) || '{}');
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return {};
    const clean: Record<string, string[]> = {};
    for (const [key, value] of Object.entries(stored)) {
      if (Array.isArray(value)) clean[key] = value.filter((id): id is string => typeof id === 'string');
    }
    return clean;
  } catch {
    return {};
  }
}

function saveSeen(seen: Record<string, string[]>) {
  try { window.localStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch { /* Private mode; the badge just resets on reload. */ }
}

const poolKey = (provider: string, country: string, role: string) => ['linkops-proxy-pool', provider, country, role];

/**
 * Reads the engine's pool payload.
 *
 * The engine names the size `count` and already reports `expired`; the TTL is
 * re-checked here too so a pool that ages out between polls stops claiming to
 * be stocked, since a dispatch against an expired pool is refused outright.
 */
function readPool(payload?: LinkOpsProxyPool | null) {
  const pool = payload?.pool;
  const expiresAt = Number(pool?.expires_at || 0);
  return {
    count: Number(pool?.count || 0),
    fetchedAt: Number(pool?.fetched_at || 0),
    expiresAt,
    expired: Boolean(pool?.expired) || (expiresAt > 0 && Date.now() / 1000 >= expiresAt),
  };
}

/**
 * Whether the engine pool this batch will draw from actually has anything.
 *
 * Shown on the batch header because an empty pool is the most common reason a
 * dispatch is refused, and it is worth knowing before selecting fifty rows.
 */
function ProxyPoolChip({ provider, country, role, online, onNotice }: {
  provider: string;
  country: string;
  role: 'checkout' | 'update';
  online: boolean;
  onNotice: (notice: { tone: string; text: string }) => void;
}) {
  const client = useQueryClient();
  const pool = useQuery({
    queryKey: poolKey(provider, country, role),
    queryFn: () => endpoints.linkopsProxyPool(provider, country, role),
    enabled: online && Boolean(provider && country),
    retry: false,
    staleTime: 30_000,
  });
  const refresh = useMutation({
    mutationFn: () => endpoints.refreshLinkopsProxyPool(provider, country, role),
    // The refresh response carries the new pool, so seed the cache with it
    // rather than waiting on a round trip that `staleTime` may serve stale.
    onSuccess: (result) => {
      client.setQueryData(poolKey(provider, country, role), result);
      onNotice({ tone: 'success', text: `${provider}/${country}/${role} 代理池已重新拉取` });
    },
    onError: (error) => onNotice({ tone: 'danger', text: errorMessage(error) }),
  });

  if (!online) return null;
  const { count: total, expired } = readPool(pool.data);
  const state = pool.isLoading ? 'loading' : pool.isError ? 'error' : (total > 0 && !expired) ? 'ok' : 'empty';
  const name = role === 'checkout' ? 'Checkout' : 'Update';
  const label = refresh.isPending ? `${name}…`
    : state === 'loading' ? `${name}…`
      : state === 'error' ? `${name} ?` : expired ? `${name} 过期` : `${name} ${total}`;
  // The status itself is the refresh control: an expired or empty pool is read
  // and re-stocked in the same place. It sits inside a <summary>, so the click
  // has to be stopped from toggling the group it is reporting on.
  return <button
    type="button"
    className={`chain-pool-chip chain-pool-${state}`}
    title={state === 'error' ? errorMessage(pool.error) : `${provider} / ${country} / ${role}，点击重新拉取`}
    aria-label={`${label}，点击重新拉取 ${provider}/${country}/${role} 代理池`}
    disabled={refresh.isPending}
    onClick={(event) => {
      event.preventDefault();
      event.stopPropagation();
      refresh.mutate();
    }}
  >
    {refresh.isPending ? <LoaderCircle className="spin" size={12} /> : <Network size={12} />}{label}
    <RefreshCw className="chain-pool-chip-hint" size={11} />
  </button>;
}

/** One pool's live state, with the actions that keep it stocked. */
function ProxyPoolRow({ pool, onNotice }: {
  pool: { provider: string; country: string; role: string };
  onNotice: (notice: { tone: string; text: string }) => void;
}) {
  const { provider, country, role } = pool;
  const client = useQueryClient();
  const state = useQuery({
    queryKey: poolKey(provider, country, role),
    queryFn: () => endpoints.linkopsProxyPool(provider, country, role),
    retry: false,
    staleTime: 15_000,
  });
  const act = useMutation({
    mutationFn: (action: 'refresh' | 'preflight' | 'clear') => (action === 'refresh'
      ? endpoints.refreshLinkopsProxyPool(provider, country, role)
      : action === 'preflight'
        ? endpoints.preflightLinkopsProxyPool(provider, country, role)
        : endpoints.clearLinkopsProxyPool(provider, country, role)),
    onSuccess: async (result, action) => {
      onNotice({ tone: 'success', text: `${provider}/${country}/${role} ${action === 'refresh' ? '已重新拉取' : action === 'preflight' ? '预检完成' : '已清空'}` });
      if (action === 'refresh') client.setQueryData(poolKey(provider, country, role), result as unknown as LinkOpsProxyPool);
      else if (action === 'clear') client.setQueryData(poolKey(provider, country, role), { ok: true, pool: null } as LinkOpsProxyPool);
      // Preflight leaves the pool changed (a dead proxy is dropped), and a
      // seeded cache still deserves confirmation from the engine.
      await client.invalidateQueries({ queryKey: poolKey(provider, country, role) });
    },
    onError: (error) => onNotice({ tone: 'danger', text: errorMessage(error) }),
  });

  const { count: total, fetchedAt, expired } = readPool(state.data);
  const bad = !state.isLoading && (state.isError || expired || total === 0);

  return <tr className={bad ? 'proxy-pool-row-bad' : ''}>
    <td><strong>{PROVIDER_LABELS[provider] || provider}</strong></td>
    <td className="mono">{country}</td>
    <td><span className={`proxy-role-tag proxy-role-${role}`}>{role === 'checkout' ? 'Checkout' : 'Update'}</span></td>
    <td className="proxy-pool-count">
      {state.isLoading ? <LoaderCircle className="spin" size={13} />
        : state.isError ? <span className="negative" title={errorMessage(state.error)}>读不到</span>
          : expired ? <span className="negative">已过期</span>
            : <strong className={total > 0 ? '' : 'negative'}>{total}</strong>}
    </td>
    <td><time>{fetchedAt ? formatTime(new Date(fetchedAt * 1000).toISOString()) : '—'}</time></td>
    <td className="proxy-pool-actions">
      <IconButton label={`重新拉取 ${provider}/${country}/${role}`} disabled={act.isPending} onClick={() => act.mutate('refresh')}>
        {act.isPending ? <LoaderCircle className="spin" size={14} /> : <RefreshCw size={14} />}
      </IconButton>
      <IconButton label="预检一条" disabled={act.isPending || !total} onClick={() => act.mutate('preflight')}><Stethoscope size={14} /></IconButton>
      <ConfirmDialog
        trigger={<IconButton label="清空" disabled={act.isPending || !total}><Trash2 size={14} /></IconButton>}
        title="清空代理池"
        description={`将清空 ${provider} / ${country} / ${role}，下次派发前需要重新拉取。`}
        danger
        confirmLabel="确认清空"
        onConfirm={() => act.mutate('clear')}
      />
    </td>
  </tr>;
}

/**
 * The pools this configuration actually draws from.
 *
 * Derived from the routing table rather than offered as a provider × country ×
 * role picker: most of those combinations do not exist — MoMo has no update
 * pool, UPI promotes through Vietnam, GoPay is Indonesian only — and a builder
 * that can produce `momo/US/update` invites stocking a pool nothing will read.
 */
function ProxyPoolDialog({ pools, onNotice }: {
  pools: Array<{ provider: string; country: string; role: string }>;
  onNotice: (notice: { tone: string; text: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const ordered = useMemo(() => [...pools].sort((left, right) => left.provider.localeCompare(right.provider)
    || left.country.localeCompare(right.country)
    || left.role.localeCompare(right.role)), [pools]);

  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Trigger asChild><Button icon={<Network size={16} />}>代理池</Button></Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="dialog-content proxy-pool-dialog">
        <div className="dialog-head">
          <div>
            <Dialog.Title>代理池</Dialog.Title>
            <Dialog.Description>
              当前路由会用到的池，共 {ordered.length} 个。池子由引擎从它自己的上游源拉取（一次最多 100 条，缓存 2 小时），这里可以查看、重拉、预检或清空。
            </Dialog.Description>
          </div>
          <Dialog.Close asChild><IconButton label="关闭"><X size={16} /></IconButton></Dialog.Close>
        </div>
        <div className="proxy-pool-scroll">
          {ordered.length ? <table className="proxy-pool-table">
            <thead><tr><th>Provider</th><th>国家</th><th>角色</th><th>可用</th><th>拉取时间</th><th aria-label="操作" /></tr></thead>
            <tbody>{ordered.map((pool) => <ProxyPoolRow key={`${pool.provider}:${pool.country}:${pool.role}`} pool={pool} onNotice={onNotice} />)}</tbody>
          </table> : <div className="credential-empty">路由表还没有配置出任何需要的代理池</div>}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

/**
 * The PayPal routing table.
 *
 * Only PayPal has a country decision — the other providers pin their own — so
 * this table is PayPal's alone, and it is named that way rather than reading
 * like a global setting. It lives in gpt-re's config, never in the engine: at
 * dispatch the chosen row is resolved into the option values one job carries,
 * so an edit takes effect on the next dispatch with nothing to push or sync.
 */
function RouteRulesDialog({ snapshot, onNotice }: {
  snapshot: ChainSnapshot | undefined;
  onNotice: (notice: { tone: string; text: string }) => void;
}) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  type DraftRule = { code: string; billingCountry: string; checkoutCountry: string; updateCountry: string; applyCheckoutUpdate: boolean };
  const [draft, setDraft] = useState<DraftRule[]>([]);
  const [newCode, setNewCode] = useState('');

  const proxyRegions = snapshot?.proxyRegions || [];
  const billingCountries = snapshot?.billingCountries || [];

  // Seeded on open so an edit in progress is never overwritten by a poll.
  const seed = () => setDraft(Object.entries(snapshot?.countryRules || {}).map(([code, rule]) => ({
    code,
    billingCountry: rule.billingCountry || '',
    checkoutCountry: rule.checkoutCountry || '',
    updateCountry: rule.updateCountry || '',
    applyCheckoutUpdate: rule.applyCheckoutUpdate !== false,
  })).sort((left, right) => (left.code === 'default' ? -1 : right.code === 'default' ? 1 : left.code.localeCompare(right.code))));

  const save = useMutation({
    mutationFn: () => endpoints.saveChainRules(Object.fromEntries(draft.map(({ code, ...rule }) => [code, rule])) as never),
    onSuccess: () => {
      onNotice({ tone: 'success', text: '路由表已保存' });
      client.invalidateQueries({ queryKey: ['chains'] });
      setOpen(false);
    },
    onError: (error) => onNotice({ tone: 'danger', text: errorMessage(error) }),
  });

  const patch = (code: string, next: Partial<DraftRule>) => setDraft((current) => current.map((row) => (row.code === code ? { ...row, ...next } : row)));

  return <Dialog.Root open={open} onOpenChange={(next) => { setOpen(next); if (next) seed(); }}>
    <Dialog.Trigger asChild><Button icon={<Route size={16} />}>PayPal 路由表</Button></Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="dialog-content route-rules-dialog">
        <div className="dialog-head">
          <div>
            <Dialog.Title>PayPal 路由表</Dialog.Title>
            <Dialog.Description>
              注册国 → 代理出口 / 账单档案 / Update 出口。仅用于 PayPal：IN 走 UPI、VN 走 MoMo、ID 走 GoPay，各自固定国家，不看此表。
              此表存在 gpt-re，派发时才把选中的这一行折算成参数随作业发给引擎，无需同步。
            </Dialog.Description>
          </div>
          <Dialog.Close asChild><IconButton label="关闭"><X size={16} /></IconButton></Dialog.Close>
        </div>
        <div className="route-rules-scroll">
          <table className="route-rules-table">
            <thead><tr><th>注册国</th><th>代理出口</th><th>账单档案</th><th>Update 出口</th><th>Update</th><th aria-label="删除" /></tr></thead>
            <tbody>
              {draft.map((row) => <tr key={row.code}>
                <td><strong>{row.code === 'default' ? '默认' : row.code}</strong></td>
                <td><AppSelect searchable ariaLabel={`${row.code} 代理出口`} value={row.checkoutCountry} onValueChange={(value) => patch(row.code, {
                  checkoutCountry: value,
                  // They are the same country in almost every rule, so keep them
                  // in step unless the operator has deliberately split them.
                  ...(row.updateCountry === row.checkoutCountry || !row.updateCountry ? { updateCountry: value } : {}),
                })} options={proxyRegions.map((code) => ({ value: code, label: code }))} /></td>
                <td><AppSelect searchable ariaLabel={`${row.code} 账单档案`} value={row.billingCountry} onValueChange={(value) => patch(row.code, { billingCountry: value })} options={billingCountries.map((code) => ({ value: code, label: code }))} /></td>
                <td><AppSelect searchable ariaLabel={`${row.code} Update 出口`} value={row.updateCountry || row.checkoutCountry} onValueChange={(value) => patch(row.code, { updateCountry: value })} options={proxyRegions.map((code) => ({ value: code, label: code }))} /></td>
                <td><Switch.Root className="switch-root" checked={row.applyCheckoutUpdate !== false} onCheckedChange={(checked) => patch(row.code, { applyCheckoutUpdate: checked })}><Switch.Thumb className="switch-thumb" /></Switch.Root></td>
                <td>{row.code !== 'default' && <IconButton label={`删除 ${row.code}`} onClick={() => setDraft((current) => current.filter((item) => item.code !== row.code))}><Trash2 size={14} /></IconButton>}</td>
              </tr>)}
            </tbody>
          </table>
        </div>
        <div className="route-rules-add">
          <input
            aria-label="新增注册国"
            placeholder="注册国代码，如 BR"
            maxLength={2}
            value={newCode}
            onChange={(event) => setNewCode(event.target.value.toUpperCase().replace(/[^A-Z]/g, ''))}
          />
          <Button
            disabled={newCode.length !== 2 || draft.some((row) => row.code === newCode)}
            onClick={() => {
              const base = draft.find((row) => row.code === 'default');
              // The ordinary case is "go out as the country you registered in",
              // so a new row routes through itself; the fallback only covers a
              // country the engine has no exit or no billing profile for.
              setDraft((current) => [...current, {
                code: newCode,
                billingCountry: billingCountries.includes(newCode) ? newCode : (base?.billingCountry || 'US'),
                checkoutCountry: proxyRegions.includes(newCode) ? newCode : (base?.checkoutCountry || ''),
                updateCountry: proxyRegions.includes(newCode) ? newCode : (base?.updateCountry || ''),
                applyCheckoutUpdate: base?.applyCheckoutUpdate !== false,
              }]);
              setNewCode('');
            }}
          >新增</Button>
        </div>
        <div className="dialog-actions">
          <Dialog.Close asChild><Button>取消</Button></Dialog.Close>
          <Button tone="primary" icon={save.isPending ? <LoaderCircle className="spin" size={15} /> : undefined} disabled={save.isPending} onClick={() => save.mutate()}>保存</Button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

async function writeClipboard(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {
    // Fall through: clipboard API unavailable or denied.
  }
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  document.body.removeChild(area);
  if (!ok) throw new Error('clipboard unavailable');
}

/** A row-level copy button: the value is resolved on click, so a token is never held in the snapshot. */
function CopyButton({ label, icon, text }: { label: string; icon: ReactNode; text: () => string | Promise<string> }) {
  const [state, setState] = useState<'idle' | 'busy' | 'copied' | 'failed'>('idle');
  async function copy() {
    setState('busy');
    try {
      const value = await text();
      if (!value) throw new Error('empty');
      await writeClipboard(value);
      setState('copied');
    } catch {
      setState('failed');
    }
    window.setTimeout(() => setState('idle'), 1600);
  }
  const title = state === 'copied' ? `已复制${label}` : state === 'failed' ? `复制${label}失败` : `复制${label}`;
  return <IconButton
    label={title}
    className={state === 'copied' ? 'chain-copy-done' : state === 'failed' ? 'chain-copy-failed' : ''}
    disabled={state === 'busy'}
    onClick={(event) => { event.stopPropagation(); void copy(); }}
  >{state === 'busy' ? <LoaderCircle className="spin" size={15} /> : state === 'copied' ? <Check size={15} /> : icon}</IconButton>;
}

/** Whether an extracted link continues into payment, and the number it signs with. */
function PaymentSettingsDialog({ billingCountries, onNotice }: {
  billingCountries: string[];
  onNotice: (notice: { tone: string; text: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ChainPaymentSettings>({ autoContinue: false, phone: '', country: 'US' });

  const settings = useQuery({ queryKey: ['chain-payment-settings'], queryFn: endpoints.chainPaymentSettings, enabled: open, retry: false });
  useEffect(() => { if (settings.data) setDraft(settings.data); }, [settings.data]);

  const save = useMutation({
    mutationFn: () => endpoints.saveChainPaymentSettings(draft),
    onSuccess: () => { onNotice({ tone: 'success', text: '支付设置已保存' }); setOpen(false); },
    onError: (error) => onNotice({ tone: 'danger', text: errorMessage(error) }),
  });

  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Trigger asChild><Button icon={<CreditCard size={16} />}>支付设置</Button></Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="dialog-content payment-settings-dialog">
        <div className="dialog-head">
          <div>
            <Dialog.Title>支付设置</Dialog.Title>
            <Dialog.Description>提链成功后是否自动交给支付引擎。只有 PayPal 有支付环节。</Dialog.Description>
          </div>
          <Dialog.Close asChild><IconButton label="关闭"><X size={16} /></IconButton></Dialog.Close>
        </div>
        <label className="payment-settings-row">
          <span><strong>提链后自动顺延支付</strong><small>成功拿到链接就直接发起支付，无需再手动选一次</small></span>
          <Switch.Root className="switch-root" checked={draft.autoContinue} onCheckedChange={(checked) => setDraft((current) => ({ ...current, autoContinue: checked }))}><Switch.Thumb className="switch-thumb" /></Switch.Root>
        </label>
        <div className="payment-settings-grid">
          <label><span>支付手机号</span><input aria-label="支付手机号" placeholder="+1..." value={draft.phone} onChange={(event) => setDraft((current) => ({ ...current, phone: event.target.value }))} /></label>
          <label><span>支付国家</span><AppSelect searchable ariaLabel="支付国家" value={draft.country} onValueChange={(value) => setDraft((current) => ({ ...current, country: value }))} options={billingCountries.map((code) => ({ value: code, label: code }))} /></label>
        </div>
        <p className="payment-settings-note">单个账号可在支付页覆盖手机号；开启自动顺延必须先填这里的默认号码。</p>
        <div className="dialog-actions">
          <Dialog.Close asChild><Button>取消</Button></Dialog.Close>
          <Button tone="primary" icon={save.isPending ? <LoaderCircle className="spin" size={15} /> : undefined} disabled={save.isPending} onClick={() => save.mutate()}>保存</Button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

export function ChainsPage() {
  const client = useQueryClient();
  const [tab, setTab] = useState<'extraction' | 'payment'>('extraction');
  const [notice, setNotice] = useState<{ tone: string; text: string } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [jobFilter, setJobFilter] = useState<JobFilter>('all');
  const [jobProvider, setJobProvider] = useState('all');
  const [importText, setImportText] = useState('');
  // Imported tokens carry no registration of ours, so there is no country to
  // route by; the operator picks the route and PayPal is the common one.
  const [importProvider, setImportProvider] = useState('paypal');
  const [importRouteKey, setImportRouteKey] = useState('default');
  const [otpById, setOtpById] = useState<Record<string, string>>({});
  // Collapsed by default: the point of grouping is that an operator scans the
  // headers, not four hundred rows.
  const [openKeys, setOpenKeys] = useState<Set<string>>(() => new Set());
  const [seenRows, setSeenRows] = useState<Record<string, string[]>>(loadSeen);

  const status = useQuery({ queryKey: ['linkops-status'], queryFn: endpoints.linkopsStatus, refetchInterval: 10000, retry: false });
  const online = status.data?.online === true;

  const [recordOffset, setRecordOffset] = useState(0);
  useEffect(() => { setRecordOffset(0); setSelected(new Set()); }, [tab]);
  const snapshot = useQuery({ queryKey: ['chains', tab, recordOffset], queryFn: () => endpoints.chainsPage(recordOffset, tab), refetchInterval: 5000 });
  const records: ChainRecord[] = useMemo(() => snapshot.data?.records || [], [snapshot.data]);
  /**
   * Which account each engine job belongs to.
   *
   * The engine only knows a masked token, so a job card can say nothing about
   * whose account it is running — but the ledger holds the job id it was given,
   * which is the join.
   */
  const rowByJobId = useMemo(() => {
    const index = new Map<string, ChainRecord>();
    for (const record of records) {
      if (record.linkopsJobId) index.set(record.linkopsJobId, record);
      if (record.paymentJobId) index.set(record.paymentJobId, record);
    }
    return index;
  }, [records]);
  const extractionRows = records;
  const paymentRows = useMemo(
    () => records.filter((row) => row.status === 'success' && PAYABLE_PROVIDERS.has(providerFor(row))),
    [records],
  );
  const rows = tab === 'extraction' ? extractionRows : paymentRows;
  const rules = (snapshot.data?.countryRules || {}) as Record<string, Route>;

  /**
   * The ledger, cut the way dispatch actually batches it.
   *
   * One extraction group is exactly one engine job batch — same provider, same
   * target country — so what the operator selects and what the engine receives
   * are the same unit. Payment has no country decision, so it groups by the
   * only attribute that moves: where the payment got to.
   */
  const groups: LedgerGroup[] = useMemo(() => {
    if (tab === 'payment') {
      return PAYMENT_GROUPS
        .map(({ key, label, hint, match }) => {
          const rows = paymentRows.filter(match);
          return {
            key,
            label,
            rows,
            blocked: false,
            batches: [{
              key, provider: 'paypal', checkoutCountry: '', billingCountry: '', updateCountry: '',
              label, hint, blocked: false, rows,
            }],
          };
        })
        .filter((group) => group.rows.length > 0);
    }
    const proxyRegions = snapshot.data?.proxyRegions || [];
    const billingCountries = snapshot.data?.billingCountries || [];
    const byProvider = new Map<string, LedgerGroup>();
    const byBatch = new Map<string, LedgerBatch>();
    for (const row of extractionRows) {
      const route = routeFor(row, rules);
      const { provider, checkoutCountry, billingCountry, updateCountry } = route;
      if (!byProvider.has(provider)) {
        byProvider.set(provider, { key: provider, label: PROVIDER_LABELS[provider] || provider, rows: [], batches: [], blocked: false });
      }
      const group = byProvider.get(provider);
      group?.rows.push(row);

      const batchKey = `${provider}:${checkoutCountry}:${billingCountry}`;
      if (!byBatch.has(batchKey)) {
        const fixed = Boolean(PROVIDER_FIXED_COUNTRY[provider]);
        const badCheckout = !fixed && (!checkoutCountry || (proxyRegions.length > 0 && !proxyRegions.includes(checkoutCountry)));
        const badBilling = !fixed && (!billingCountry || (billingCountries.length > 0 && !billingCountries.includes(billingCountry)));
        const batch: LedgerBatch = {
          key: batchKey,
          provider,
          checkoutCountry,
          billingCountry,
          updateCountry,
          // Inside a provider the name only needs to say which batch this is.
          label: fixed
            ? checkoutCountry
            : `出口 ${checkoutCountry || '未配置'} · 账单 ${billingCountry || '未配置'}`,
          hint: badCheckout
            ? `出口 ${checkoutCountry || '未配置'} 不是可用的代理源区域`
            : badBilling
              ? `账单 ${billingCountry || '未配置'} 没有对应的账单档案`
              : '',
          blocked: badCheckout || badBilling,
          rows: [],
        };
        byBatch.set(batchKey, batch);
        group?.batches.push(batch);
      }
      byBatch.get(batchKey)?.rows.push(row);
    }
    for (const group of byProvider.values()) {
      group.blocked = group.batches.length > 0 && group.batches.every((batch) => batch.blocked);
      // Blocked batches last: they need attention but must not bury the workable ones.
      group.batches.sort((left, right) => Number(left.blocked) - Number(right.blocked)
        || right.rows.length - left.rows.length
        || left.key.localeCompare(right.key));
    }
    return [...byProvider.values()].sort((left, right) => Number(left.blocked) - Number(right.blocked)
      || right.rows.length - left.rows.length
      || left.key.localeCompare(right.key));
  }, [tab, extractionRows, paymentRows, rules, snapshot.data?.proxyRegions, snapshot.data?.billingCountries]);

  const [jobOffset, setJobOffset] = useState(0);
  useEffect(() => { setJobOffset(0); }, [tab, jobFilter, jobProvider]);
  const jobs = useQuery({
    queryKey: ['linkops-jobs', tab, jobFilter, jobProvider, jobOffset],
    queryFn: () => endpoints.linkopsJobsPage(jobOffset, tab, jobFilter, jobProvider),
    enabled: online,
    retry: false,
    refetchInterval: (query) => ((query.state.data?.jobs || []).some((job) => LIVE_JOB_STATUSES.has(job.status)) ? 2000 : 8000),
  });
  const allJobs: LinkOpsJob[] = useMemo(() => jobs.data?.jobs || [], [jobs.data]);
  /**
   * Jobs arrive as one undifferentiated stream, which is unreadable once a few
   * hundred have accumulated: the two things an operator looks for are what is
   * still moving and what went wrong, and both are buried by the completed.
   */
  const pageJobCounts = useMemo(() => {
    const counts: Record<JobFilter, number> = { all: allJobs.length, live: 0, done: 0, bad: 0 };
    for (const job of allJobs) {
      if (LIVE_JOB_STATUSES.has(job.status)) counts.live += 1;
      else if (job.status === 'completed') counts.done += 1;
      else counts.bad += 1;
    }
    return counts;
  }, [allJobs]);
  const jobRows = useMemo(() => allJobs.filter((job) => {
    if (jobProvider !== 'all' && job.provider !== jobProvider) return false;
    if (jobFilter === 'live') return LIVE_JOB_STATUSES.has(job.status);
    if (jobFilter === 'done') return job.status === 'completed';
    if (jobFilter === 'bad') return !LIVE_JOB_STATUSES.has(job.status) && job.status !== 'completed';
    return true;
  }), [allJobs, jobFilter, jobProvider]);
  const jobCounts = jobs.data?.counts || pageJobCounts;
  const jobProviders = useMemo(() => jobs.data?.providers || [...new Set(allJobs.map((job) => job.provider))].sort(), [allJobs, jobs.data?.providers]);
  /** The engine refuses to delete a running job, so only finished ones count. */
  const clearableJobIds = useMemo(
    () => jobRows.filter((job) => !LIVE_JOB_STATUSES.has(job.status)).map((job) => job.id),
    [jobRows],
  );

  const providers = useMemo(
    () => (status.data?.modules || []).flatMap((module) => module.providers.map((provider) => ({ ...provider, domain: module.id }))),
    [status.data?.modules],
  );

  const selectedIds = useMemo(() => rows.filter((row) => selected.has(row.id)).map((row) => row.id), [rows, selected]);
  const allSelected = rows.length > 0 && rows.every((row) => selected.has(row.id));
  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(rows.map((row) => row.id)));

  const setOpen = (key: string, open: boolean) => setOpenKeys((current) => {
    const next = new Set(current);
    if (open) next.add(key); else next.delete(key);
    return next;
  });

  /**
   * The rows the ledger is actually showing, in the order they are painted.
   *
   * Press-and-hold brushing works on positions, so a collapsed group must drop
   * out of the sequence entirely: otherwise dragging across two open groups
   * would silently sweep in whatever is folded away between them.
   */
  const visibleIds = useMemo(() => {
    const ids: string[] = [];
    for (const group of groups) {
      if (!openKeys.has(group.key)) continue;
      const nested = group.batches.length > 1;
      for (const batch of group.batches) {
        if (nested && !openKeys.has(batch.key)) continue;
        for (const row of batch.rows) ids.push(row.id);
      }
    }
    return ids;
  }, [groups, openKeys]);
  const rangeIndex = useMemo(() => new Map(visibleIds.map((id, index) => [id, index])), [visibleIds]);
  const range = useRangeSelection({ keys: visibleIds, selected, setSelected });

  /** Revealing a batch's table is what marks its rows read, clearing its `+n`. */
  const markRead = (key: string, rows: ChainRecord[]) => setSeenRows((current) => {
    const merged = new Set([...(current[key] || []), ...rows.map((row) => row.id)]);
    const next = { ...current, [key]: [...merged] };
    saveSeen(next);
    return next;
  });

  /**
   * A batch seen for the first time starts fully read.
   *
   * Otherwise every existing row counts as new the first time this browser (or
   * a restarted one with no stored state) opens the page, and the badge reports
   * the whole ledger as an arrival. `+n` should only ever mean "arrived since
   * you last looked", so the baseline is taken silently on first sight.
   */
  useEffect(() => {
    const unseen = groups.flatMap((group) => group.batches).filter((batch) => !seenRows[batch.key]);
    if (!unseen.length) return;
    setSeenRows((current) => {
      const next = { ...current };
      for (const batch of unseen) next[batch.key] = batch.rows.map((row) => row.id);
      saveSeen(next);
      return next;
    });
  }, [groups, seenRows]);

  const refreshLedger = () => {
    client.invalidateQueries({ queryKey: ['chains'] });
    setSelected(new Set());
  };
  const refreshAll = () => {
    client.invalidateQueries({ queryKey: ['linkops-status'] });
    client.invalidateQueries({ queryKey: ['linkops-jobs'] });
    refreshLedger();
  };

  const startService = useMutation({
    mutationFn: (_options: { openAfter?: boolean } = {}) => endpoints.startLinkops(),
    onSuccess: (result, options) => {
      setNotice({ tone: 'success', text: 'LinkOps 服务已启动并通过健康检查' });
      // "Open the workbench" on a stopped service means start it, then open it;
      // a link to a dead port is not what that button promises.
      if (options?.openAfter) window.open(result.status?.baseUrl || status.data?.baseUrl || 'http://127.0.0.1:8082', '_blank', 'noopener');
      refreshAll();
    },
    onError: (error) => setNotice({ tone: 'danger', text: errorMessage(error) }),
  });

  const importTokens = useMutation({
    mutationFn: () => endpoints.importChainTokens({
      content: importText,
      provider: importProvider,
      ...(importProvider === 'paypal' ? { routeKey: importRouteKey } : {}),
    }),
    onSuccess: (result) => {
      setImportText('');
      setNotice({ tone: 'success', text: `已导入 ${result.imported} 条，拒绝 ${result.rejected.length} 条（共 ${result.requested} 条）` });
      refreshLedger();
    },
    onError: (error) => setNotice({ tone: 'danger', text: errorMessage(error) }),
  });

  const probe = useMutation({
    mutationFn: () => endpoints.probeChainTokens(selectedIds),
    onSuccess: (result) => { setNotice({ tone: 'success', text: `抽检 ${result.checked} 条：存活 ${result.alive}，失效 ${result.dead}` }); refreshLedger(); },
    onError: (error) => setNotice({ tone: 'danger', text: errorMessage(error) }),
  });

  const remove = useMutation({
    mutationFn: () => endpoints.removeChains(selectedIds),
    onSuccess: (result) => { setNotice({ tone: 'success', text: `已删除 ${result.removed.length} 条台账记录` }); refreshLedger(); },
    onError: (error) => setNotice({ tone: 'danger', text: errorMessage(error) }),
  });

  const describeDispatch = (verb: string) => (result: { accepted: string[]; skipped: Array<{ id: string; email?: string; reason: string }> }) => {
    const skipped = result.skipped || [];
    setNotice({
      tone: skipped.length ? 'warning' : 'success',
      text: skipped.length
        ? `已${verb} ${result.accepted.length} 个；${skipped.length} 个未${verb}：${skipped.slice(0, 3).map((item) => `${item.email || item.id}（${item.reason}）`).join('；')}${skipped.length > 3 ? ' …' : ''}`
        : `已${verb} ${result.accepted.length} 个账号`,
    });
    refreshAll();
  };

  const dispatch = useMutation({
    mutationFn: () => endpoints.extractChains({ ids: selectedIds }),
    onSuccess: describeDispatch('派发'),
    onError: (error) => setNotice({ tone: 'danger', text: errorMessage(error) }),
  });

  const pay = useMutation({
    mutationFn: () => endpoints.payExtractedChains(selectedIds),
    onSuccess: describeDispatch('发起支付'),
    onError: (error) => setNotice({ tone: 'danger', text: errorMessage(error) }),
  });

  /** One row, straight from its own line — the common case is not a batch. */
  const dispatchOne = useMutation({
    mutationFn: (id: string) => (tab === 'extraction' ? endpoints.extractChains({ ids: [id] }) : endpoints.payExtractedChains([id])),
    onSuccess: (result) => {
      const [skip] = result.skipped || [];
      setNotice(skip
        ? { tone: 'warning', text: `未${tab === 'extraction' ? '派发' : '发起'}：${skip.reason}` }
        : { tone: 'success', text: tab === 'extraction' ? '已派发' : '已发起支付' });
      refreshAll();
    },
    onError: (error) => setNotice({ tone: 'danger', text: errorMessage(error) }),
  });

  /**
   * Re-pull every pool the current ledger will actually draw from.
   *
   * Pools expire after two hours and a dispatch against a stale one is refused
   * outright, so the useful unit is "everything this page needs", not one chip
   * at a time. Each pool is reported on its own: one region failing upstream
   * should not read as the whole refresh failing.
   */
  const refreshAllPools = useMutation({
    mutationFn: async () => {
      const wanted = new Map<string, { provider: string; country: string; role: 'checkout' | 'update' }>();
      for (const group of groups) {
        for (const batch of group.batches) {
          if (batch.blocked || !batch.checkoutCountry) continue;
          wanted.set(`${batch.provider}:${batch.checkoutCountry}:checkout`, { provider: batch.provider, country: batch.checkoutCountry, role: 'checkout' });
          if (batch.provider !== 'momo' && batch.updateCountry) {
            wanted.set(`${batch.provider}:${batch.updateCountry}:update`, { provider: batch.provider, country: batch.updateCountry, role: 'update' });
          }
        }
      }
      const targets = [...wanted.values()];
      if (!targets.length) throw new Error('当前没有需要刷新的代理池');
      const failed: string[] = [];
      // Sequential on purpose: each one is an upstream fetch on the engine, and
      // firing eight at once is how a source starts refusing them.
      for (const target of targets) {
        try {
          await endpoints.refreshLinkopsProxyPool(target.provider, target.country, target.role);
        } catch (error) {
          failed.push(`${target.provider}/${target.country}/${target.role}（${errorMessage(error)}）`);
        }
      }
      return { total: targets.length, failed };
    },
    onSuccess: ({ total, failed }) => {
      setNotice(failed.length
        ? { tone: 'warning', text: `${total - failed.length}/${total} 个代理池已刷新；失败：${failed.slice(0, 2).join('；')}${failed.length > 2 ? ' …' : ''}` }
        : { tone: 'success', text: `${total} 个代理池已全部重新拉取` });
      client.invalidateQueries({ queryKey: ['linkops-proxy-pool'] });
    },
    onError: (error) => setNotice({ tone: 'danger', text: errorMessage(error) }),
  });

  const clearJobs = useMutation({
    mutationFn: (ids: string[]) => endpoints.batchDeleteLinkopsJobs(ids),
    onSuccess: (result) => {
      const blocked = (result.blocked || []).length;
      setNotice(blocked
        ? { tone: 'warning', text: `已清除 ${(result.deleted || []).length} 个作业；${blocked} 个仍在进行中，未清除` }
        : { tone: 'success', text: `已清除 ${(result.deleted || []).length} 个作业` });
      client.invalidateQueries({ queryKey: ['linkops-jobs'] });
    },
    onError: (error) => setNotice({ tone: 'danger', text: errorMessage(error) }),
  });

  const deleteJob = useMutation({
    mutationFn: (id: string) => endpoints.deleteLinkopsJob(id),
    onSuccess: () => {
      setNotice({ tone: 'success', text: '作业已删除' });
      client.invalidateQueries({ queryKey: ['linkops-jobs'] });
    },
    onError: (error) => setNotice({ tone: 'danger', text: errorMessage(error) }),
  });

  const jobAction = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'cancel' | 'retry' }) => (action === 'cancel'
      ? endpoints.cancelLinkopsJob(id)
      : endpoints.retryLinkopsJob(id)),
    onSuccess: (_result, variables) => {
      setNotice({ tone: 'success', text: variables.action === 'cancel' ? '已请求取消作业' : '已重试作业' });
      client.invalidateQueries({ queryKey: ['linkops-jobs'] });
    },
    onError: (error) => setNotice({ tone: 'danger', text: errorMessage(error) }),
  });

  const submitOtp = useMutation({
    mutationFn: ({ id, value }: { id: string; value: string }) => endpoints.submitLinkopsInput(id, value),
    onSuccess: (_result, variables) => {
      setOtpById((current) => ({ ...current, [variables.id]: '' }));
      setNotice({ tone: 'success', text: '已提交' });
      client.invalidateQueries({ queryKey: ['linkops-jobs'] });
    },
    onError: (error) => setNotice({ tone: 'danger', text: errorMessage(error) }),
  });

  return <div className="chains-page">
    <PageHeader
      title="提链控制台"
      description="账号台账与路由留在这里；提链与支付由外部 LinkOps 服务执行"
      actions={<>
        <RouteRulesDialog snapshot={snapshot.data} onNotice={setNotice} />
        <PaymentSettingsDialog billingCountries={snapshot.data?.billingCountries || []} onNotice={setNotice} />
        <ProxyPoolDialog pools={snapshot.data?.proxyPools || []} onNotice={setNotice} />
        {online
          ? <a className="button button-default" href={status.data?.baseUrl || 'http://127.0.0.1:8082'} target="_blank" rel="noreferrer"><ExternalLink size={16} />打开工作台</a>
          : <Button
            icon={startService.isPending ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}
            disabled={!status.data?.canStart || startService.isPending}
            title={status.data?.canStart ? '先运行 start.bat 启动服务，就绪后再打开工作台' : '未配置 linkops.startCommand，无法从这里启动'}
            onClick={() => startService.mutate({ openAfter: true })}
          >{startService.isPending ? '启动中' : '启动并打开'}</Button>}
        <IconButton label="刷新" onClick={refreshAll} disabled={snapshot.isFetching || status.isFetching}>
          {snapshot.isFetching || status.isFetching ? <LoaderCircle className="spin" size={17} /> : <RefreshCw size={17} />}
        </IconButton>
      </>}
    />
    {notice && <Notice tone={notice.tone} floating onClose={() => setNotice(null)} autoDismissToken={notice}>{notice.text}</Notice>}

    <section className="workspace-band chain-engine-band">
      <div className="chain-engine-body">
        <div className={`chain-engine-status${online ? ' online' : ''}`}>
          <ServerCog size={18} />
          <div>
            <strong>{status.isLoading ? '正在检测…' : online ? '外部引擎运行中' : '外部引擎未运行'}</strong>
            <small>{status.data?.baseUrl || '—'}{!online && status.data?.reason ? ` · ${status.data.reason}` : ''}</small>
          </div>
        </div>
        <div className="chain-engine-providers">
          {online && providers.length
            ? providers.map((provider) => (
              <span className="chain-provider-chip" key={`${provider.domain}/${provider.id}`} title={provider.description}>
                <em>{provider.domain}</em>{provider.name}
              </span>
            ))
            : <span className="chain-engine-hint">{online ? '未报告可用 provider' : '启动后显示可用 provider'}</span>}
        </div>
        <div className="chain-engine-actions">
          {online && <Button
            icon={refreshAllPools.isPending ? <LoaderCircle className="spin" size={16} /> : <Network size={16} />}
            disabled={refreshAllPools.isPending}
            title="让引擎重新从上游拉取本页会用到的每个代理池"
            onClick={() => refreshAllPools.mutate()}
          >{refreshAllPools.isPending ? '刷新中' : '刷新代理池'}</Button>}
          {!online && <Button
            tone="primary"
            icon={startService.isPending ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}
            disabled={!status.data?.canStart || startService.isPending}
            title={status.data?.canStart ? '运行已配置的 start.bat 并等待健康检查' : '未配置 linkops.startCommand'}
            onClick={() => startService.mutate({})}
          >{startService.isPending ? '启动中' : '启动服务'}</Button>}
        </div>
      </div>
    </section>

    <div className="chain-workspace">
      <section className="workspace-band chain-ledger-band">
        <div className="artifact-filter-tabs" role="tablist" aria-label="阶段">
          <button type="button" role="tab" aria-selected={tab === 'extraction'} className={tab === 'extraction' ? 'selected' : ''} onClick={() => { setTab('extraction'); setSelected(new Set()); }}>
            <Link2 size={13} />提链<span>{extractionRows.length}</span>
          </button>
          <button type="button" role="tab" aria-selected={tab === 'payment'} className={tab === 'payment' ? 'selected' : ''} onClick={() => { setTab('payment'); setSelected(new Set()); }}>
            <CreditCard size={13} />支付<span>{paymentRows.length}</span>
          </button>
        </div>
        <div className="section-heading">
          <div><h2>{tab === 'extraction' ? '提链台账' : '待支付链接'}</h2><p>{rows.length} 条{selectedIds.length ? ` · 已选 ${selectedIds.length}` : ''}</p></div>
          <div className="chain-ledger-actions">
            {rows.length > 0 && <label className="artifact-select-all"><input type="checkbox" checked={allSelected} onChange={toggleAll} />全选</label>}
            {tab === 'extraction' ? <>
              <Button
                tone="primary"
                icon={dispatch.isPending ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}
                disabled={!online || !selectedIds.length || dispatch.isPending}
                title={online ? '按注册国家路由到对应 provider' : '外部引擎未运行'}
                onClick={() => dispatch.mutate()}
              >{dispatch.isPending ? '派发中' : `派发提链${selectedIds.length ? ` (${selectedIds.length})` : ''}`}</Button>
              <IconButton label={`AT 抽检${selectedIds.length ? ` (${selectedIds.length})` : ''}`} onClick={() => probe.mutate()} disabled={!selectedIds.length || probe.isPending}>
                {probe.isPending ? <LoaderCircle className="spin" size={16} /> : <Stethoscope size={16} />}
              </IconButton>
              <ConfirmDialog
                trigger={<IconButton label={`删除选中${selectedIds.length ? ` (${selectedIds.length})` : ''}`} disabled={!selectedIds.length || remove.isPending}><Trash2 size={16} /></IconButton>}
                title="删除台账记录"
                description={`将删除选中的 ${selectedIds.length} 条提链台账记录。登录态资产不受影响。`}
                danger
                confirmLabel="确认删除"
                onConfirm={() => remove.mutate()}
              />
            </> : <Button
              tone="primary"
              icon={pay.isPending ? <LoaderCircle className="spin" size={15} /> : <CreditCard size={15} />}
              disabled={!online || !selectedIds.length || pay.isPending}
              title={online ? '把选中链接交给支付引擎' : '外部引擎未运行'}
              onClick={() => pay.mutate()}
            >{pay.isPending ? '发起中' : `发起支付${selectedIds.length ? ` (${selectedIds.length})` : ''}`}</Button>}
          </div>
        </div>
        <div className="chain-ledger-inner">
          {tab === 'extraction' && <details className="chain-import-drawer">
            <summary className="chain-import-summary">
              <span><ChevronRight size={14} className="chain-import-chevron" /><Upload size={14} />令牌导入</span>
              <small>每行一条 access token</small>
            </summary>
            <div className="chain-import-body">
              <textarea className="chain-import-input" aria-label="访问令牌" spellCheck={false} placeholder={'每行一条 access token'} value={importText} onChange={(event) => setImportText(event.target.value)} />
              <div className="chain-import-route">
                <label>
                  <span>提链方式</span>
                  <AppSelect
                    ariaLabel="提链方式"
                    value={importProvider}
                    onValueChange={setImportProvider}
                    options={Object.entries(PROVIDER_LABELS).map(([id, label]) => ({ value: id, label }))}
                  />
                </label>
                {/* Only PayPal has a choice left to make; the others pin their own. */}
                {importProvider === 'paypal' && <label>
                  <span>PayPal 路线</span>
                  <AppSelect
                    ariaLabel="PayPal 路线"
                    value={importRouteKey}
                    onValueChange={setImportRouteKey}
                    options={Object.entries(rules).map(([key, rule]) => ({
                      value: key,
                      label: `${key === 'default' ? '默认' : key} · 出口 ${rule.checkoutCountry || '?'} · 账单 ${rule.billingCountry || '?'}`,
                    }))}
                  />
                </label>}
                <Button tone="primary" icon={importTokens.isPending ? <LoaderCircle className="spin" size={16} /> : <Upload size={16} />} disabled={!importText.trim() || importTokens.isPending} onClick={() => importTokens.mutate()}>{importTokens.isPending ? '导入中' : '导入'}</Button>
              </div>
            </div>
          </details>}
          <div className={`chain-ledger-scroll${range.dragging ? ' chain-range-selecting' : ''}`} {...range.containerProps}>
            {groups.length ? groups.map((group) => {
              const groupIds = group.rows.map((row) => row.id);
              const allInGroup = groupIds.length > 0 && groupIds.every((id) => selected.has(id));
              const isOpen = openKeys.has(group.key);
              // One batch means the country adds nothing to the header, so the
              // second level is skipped rather than nested for show.
              const nested = group.batches.length > 1;
              const freshOf = (batch: LedgerBatch) => {
                const seen = seenRows[batch.key];
                // No baseline yet means this batch is being seeded this render;
                // reporting its rows as new would flag the whole ledger once.
                if (!seen) return 0;
                if (!nested ? isOpen : openKeys.has(batch.key)) return 0;
                const known = new Set(seen);
                return batch.rows.filter((row) => !known.has(row.id)).length;
              };
              const groupFresh = group.batches.reduce((total, batch) => total + freshOf(batch), 0);
              return <details
                className={`chain-group${group.blocked ? ' chain-group-blocked' : ''}`}
                key={group.key}
                open={isOpen}
                onToggle={(event) => {
                  const open = event.currentTarget.open;
                  setOpen(group.key, open);
                  // A flat group reveals its table directly, so opening it is
                  // when its rows are actually seen.
                  if (open && !nested) markRead(group.batches[0].key, group.batches[0].rows);
                }}
              >
                <summary className="chain-group-head">
                  <span className="chain-group-title">
                    <ChevronRight size={13} className="chain-group-chevron" />
                    <strong>{group.label}</strong>
                    <em>{group.rows.length}</em>
                    {groupFresh > 0 && <b className="chain-group-new" title={`${groupFresh} 条自上次查看后新增`}>+{groupFresh}</b>}
                    {nested && <small className="chain-group-batches">{group.batches.length} 个批次</small>}
                  </span>
                  <span className="chain-group-meta">
                    {tab === 'extraction' && !nested && !group.batches[0]?.blocked && <>
                      <ProxyPoolChip provider={group.batches[0].provider} country={group.batches[0].checkoutCountry} role="checkout" online={online} onNotice={setNotice} />
                      {group.batches[0].provider !== 'momo' && group.batches[0].updateCountry
                        && <ProxyPoolChip provider={group.batches[0].provider} country={group.batches[0].updateCountry} role="update" online={online} onNotice={setNotice} />}
                    </>}
                    {!nested && group.batches[0]?.hint && <small>{group.batches[0].hint}</small>}
                    <label className="artifact-select-all" onClick={(event) => event.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`选择 ${group.label} 全部`}
                        checked={allInGroup}
                        onChange={() => setSelected((current) => {
                          const next = new Set(current);
                          if (allInGroup) groupIds.forEach((id) => next.delete(id));
                          else groupIds.forEach((id) => next.add(id));
                          return next;
                        })}
                      />本组
                    </label>
                  </span>
                </summary>
                {group.batches.map((batch) => {
                  const batchOpen = !nested || openKeys.has(batch.key);
                  const batchFresh = freshOf(batch);
                  const table = <table className="chain-table">
                    {/* Fixed columns: every batch renders its own table, and
                        without them each one sizes itself, so the dispatch
                        button lands at a different x on every group. */}
                    <colgroup>
                      <col className="chain-col-pick" /><col /><col className="chain-col-country" />
                      <col className="chain-col-status" /><col className="chain-col-time" /><col className="chain-col-actions" />
                    </colgroup>
                    <thead><tr>
                      <th aria-label="选择" /><th>邮箱</th><th>注册国</th>
                      {tab === 'extraction' ? <th>提链</th> : <th>支付</th>}
                      <th>更新时间</th><th aria-label="操作" />
                    </tr></thead>
                    <tbody>
                      {batch.rows.map((row) => {
                        const index = rangeIndex.get(row.id) ?? -1;
                        return <tr
                          key={row.id}
                          className={`${selected.has(row.id) ? 'chain-row-selected' : ''}${range.isInRange(index) ? ' chain-row-range' : ''}`}
                          {...range.rowProps(index)}
                        >
                          <td><input aria-label={`选择 ${row.email}`} type="checkbox" checked={selected.has(row.id)} onChange={() => toggle(row.id)} /></td>
                          <td className="chain-email">
                            <strong>{row.email}</strong>
                            {/* A failed row's account id is the least useful
                                thing to show; the reason it failed is what the
                                operator is looking at the row for. */}
                            {row.status === 'failed' && row.lastError?.message
                              ? <small className="chain-email-error" title={`${row.lastError.message}（${row.accountId || row.id}）`}>{row.lastError.message}</small>
                              : <small title={row.accountId || row.id}>{row.accountId || row.id}</small>}
                          </td>
                          <td className="mono">{row.sourceCountryCode || '—'}</td>
                          <td className="chain-status-cell">
                            {tab === 'extraction' ? <StatusBadge status={row.status} /> : <StatusBadge status={row.paymentStatus} />}
                            {/* A row that is quietly on its second exit looks
                                identical to a first attempt without this. */}
                            {tab === 'extraction' && (row.linkopsRetryCount || 0) > 0
                              && <small title="已自动更换代理重试的次数">换代理 ×{row.linkopsRetryCount}</small>}
                          </td>
                          <td><time>{formatTime(row.updatedAt)}</time></td>
                          <td className="chain-row-actions">
                            {/* The link slot is always occupied so the dispatch
                                button sits in the same column on every row. */}
                            <CopyButton label=" AT" icon={<KeyRound size={15} />} text={() => endpoints.chainToken(row.id).then((result) => result.token)} />
                            {row.result?.paypalUrl
                              ? <CopyButton label="链接" icon={<Copy size={15} />} text={() => row.result?.paypalUrl || ''} />
                              : <span className="chain-row-slot" aria-hidden="true" />}
                            {row.result?.paypalUrl
                              ? <a className="icon-button" href={row.result.paypalUrl} target="_blank" rel="noreferrer" aria-label="打开提取到的链接"><Link2 size={15} /></a>
                              : <span className="chain-row-slot" aria-hidden="true" />}
                            <IconButton
                              label={tab === 'extraction' ? `派发 ${row.email}` : `发起支付 ${row.email}`}
                              disabled={!online || batch.blocked || dispatchOne.isPending}
                              onClick={() => dispatchOne.mutate(row.id)}
                            >{dispatchOne.isPending && dispatchOne.variables === row.id
                              ? <LoaderCircle className="spin" size={15} />
                              : tab === 'extraction' ? <Send size={15} /> : <CreditCard size={15} />}</IconButton>
                          </td>
                        </tr>;
                      })}
                    </tbody>
                  </table>;
                  if (!nested) return <div className="chain-batch" key={batch.key}>{table}</div>;
                  return <details
                    className={`chain-batch${batch.blocked ? ' chain-batch-blocked' : ''}`}
                    key={batch.key}
                    open={batchOpen}
                    onToggle={(event) => {
                      const open = event.currentTarget.open;
                      setOpen(batch.key, open);
                      if (open) markRead(batch.key, batch.rows);
                    }}
                  >
                    <summary className="chain-batch-head">
                      <span className="chain-batch-title">
                        <ChevronRight size={12} className="chain-batch-chevron" />
                        <strong>{batch.label}</strong>
                        <em>{batch.rows.length}</em>
                        {batchFresh > 0 && <b className="chain-group-new" title={`${batchFresh} 条自上次查看后新增`}>+{batchFresh}</b>}
                      </span>
                      <span className="chain-batch-meta">
                        {tab === 'extraction' && !batch.blocked && <>
                          <ProxyPoolChip provider={batch.provider} country={batch.checkoutCountry} role="checkout" online={online} onNotice={setNotice} />
                          {batch.provider !== 'momo' && batch.updateCountry
                            && <ProxyPoolChip provider={batch.provider} country={batch.updateCountry} role="update" online={online} onNotice={setNotice} />}
                        </>}
                        {batch.hint && <small>{batch.hint}</small>}
                        <label className="artifact-select-all" onClick={(event) => event.stopPropagation()}>
                          <input
                            type="checkbox"
                            aria-label={`选择 ${batch.label} 全部`}
                            checked={batch.rows.length > 0 && batch.rows.every((row) => selected.has(row.id))}
                            onChange={() => setSelected((current) => {
                              const next = new Set(current);
                              const all = batch.rows.every((row) => next.has(row.id));
                              batch.rows.forEach((row) => (all ? next.delete(row.id) : next.add(row.id)));
                              return next;
                            })}
                          />本批
                        </label>
                      </span>
                    </summary>
                    {table}
                  </details>;
                })}
              </details>;
            }) : <EmptyState
              icon={tab === 'extraction' ? <Link2 size={26} /> : <CreditCard size={26} />}
              title={tab === 'extraction' ? '台账为空' : '暂无待支付链接'}
              detail={tab === 'extraction' ? '导入访问令牌后，账号会出现在这里。' : '提链成功且 provider 支持支付的账号会出现在这里。'}
            />}
          </div>
        </div>
      <Pagination label="提链账号分页" total={snapshot.data?.total ?? rows.length} offset={recordOffset} busy={snapshot.isFetching} onChange={setRecordOffset} />
      </section>

      <section className="workspace-band chain-jobs-band">
        {jobs.error && <Notice tone="danger">{errorMessage(jobs.error)} <Button onClick={() => jobs.refetch()}>重试</Button></Notice>}
        <div className="section-heading">
          <div>
            <h2>{tab === 'extraction' ? '提链作业' : '支付作业'}</h2>
            <p>{online ? `共 ${jobs.data?.total ?? allJobs.length} 个作业 · 外部引擎最近 ${jobs.data?.recentLimit || 200} 条内分页` : '服务未运行'}</p>
          </div>
          {online && allJobs.length > 0 && <div className="section-actions">
            <ConfirmDialog
              trigger={<Button icon={clearJobs.isPending ? <LoaderCircle className="spin" size={16} /> : <Trash2 size={16} />} disabled={!clearableJobIds.length || clearJobs.isPending}>{`清除本页已结束${clearableJobIds.length ? ` (${clearableJobIds.length})` : ''}`}</Button>}
              title="清除本页已结束的作业"
              description={`将从引擎删除当前页筛选下已结束的 ${clearableJobIds.length} 个作业记录。进行中的作业不受影响，提链台账也不受影响。`}
              danger
              confirmLabel="确认清除"
              onConfirm={() => clearJobs.mutate(clearableJobIds)}
            />
          </div>}
        </div>
        {online && <div className="chain-job-filters">
          <div className="chain-job-tabs" role="group" aria-label="作业状态筛选">
            {JOB_FILTERS.map(({ id, label }) => <button
              key={id}
              type="button"
              className={jobFilter === id ? 'selected' : ''}
              onClick={() => setJobFilter(id)}
            >{label}<em>{jobCounts[id]}</em></button>)}
          </div>
          {/* Only worth showing once more than one engine provider is in play. */}
          {jobProviders.length > 1 && <AppSelect
            ariaLabel="作业 provider 筛选"
            value={jobProvider}
            onValueChange={setJobProvider}
            options={[{ value: 'all', label: '全部 provider' }, ...jobProviders.map((id) => ({ value: id, label: PROVIDER_LABELS[id] || id }))]}
          />}
        </div>}
        <div className="chain-jobs-scroll">
          {!online
            ? <EmptyState icon={<ServerCog size={24} />} title="服务未运行" detail="启动外部引擎后，这里会实时显示作业。" />
            : jobRows.length
              ? jobRows.map((job) => <div className="chain-job-card" key={job.id}>
                <div className="chain-job-head">
                  <StatusBadge status={jobTone(job.status)} label={job.status} />
                  <strong title={job.id}>{PROVIDER_LABELS[job.provider] || job.provider}</strong>
                  <time title={`创建于 ${formatEpochSeconds(job.created_at)}`}>{formatEpochSeconds(job.updated_at)}</time>
                </div>
                <div className="chain-job-owner" title={rowByJobId.get(job.id)?.email || job.id}>
                  {rowByJobId.get(job.id)?.email
                    || <em>{/* A job the ledger has no row for: deleted, or made outside this console. */}未关联台账</em>}
                </div>
                <div className="chain-job-stage">
                  <span>{job.stage_label || job.stage || '—'}</span>
                  <i className="chain-job-bar"><b style={{ width: `${Math.max(0, Math.min(100, job.progress))}%` }} /></i>
                </div>
                {job.error && <p className="chain-job-error" title={job.error}>{job.error}</p>}
                {job.awaiting_input && <div className="chain-job-input">
                  <input
                    aria-label={job.awaiting_input.prompt || '等待输入'}
                    placeholder={job.awaiting_input.prompt || '验证码或新手机号'}
                    value={otpById[job.id] || ''}
                    onChange={(event) => setOtpById((current) => ({ ...current, [job.id]: event.target.value }))}
                  />
                  <Button tone="primary" disabled={!(otpById[job.id] || '').trim() || submitOtp.isPending} onClick={() => submitOtp.mutate({ id: job.id, value: otpById[job.id] || '' })}>提交</Button>
                </div>}
                <div className="chain-job-actions">
                  {LIVE_JOB_STATUSES.has(job.status) && <IconButton label="取消作业" onClick={() => jobAction.mutate({ id: job.id, action: 'cancel' })} disabled={jobAction.isPending}><Ban size={15} /></IconButton>}
                  {job.can_retry && <IconButton label="重试作业" onClick={() => jobAction.mutate({ id: job.id, action: 'retry' })} disabled={jobAction.isPending}><RotateCcw size={15} /></IconButton>}
                  {!LIVE_JOB_STATUSES.has(job.status) && <IconButton label="删除该作业记录" onClick={() => deleteJob.mutate(job.id)} disabled={deleteJob.isPending}><Trash2 size={15} /></IconButton>}
                </div>
              </div>)
              : allJobs.length
                ? <EmptyState icon={<Link2 size={24} />} title="没有符合筛选的作业" detail="换一个状态或 provider 再看。" />
                : <EmptyState icon={<Link2 size={24} />} title="暂无作业" detail={tab === 'extraction' ? '派发提链后，作业会显示在这里。' : '发起支付后，作业会显示在这里。'} />}
        </div>
        {online && <Pagination label="外部作业分页" total={jobs.data?.total ?? allJobs.length} offset={jobOffset} busy={jobs.isFetching} onChange={setJobOffset} />}
      </section>
    </div>
  </div>;
}
