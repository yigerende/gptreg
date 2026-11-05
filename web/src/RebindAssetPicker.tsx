import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { Dialog } from 'radix-ui';
import { ClipboardList, KeyRound, LoaderCircle, Lock, Plus, Search, X } from 'lucide-react';

import { endpoints } from './api';
import { Button, EmptyState, IconButton, errorMessage, formatTime } from './components/ConsoleUi';
import { REGISTRATION_LOCK_MS, eligibleInLabel, rebindEligible, summarizeRebindAdd } from './rebind-handoff';
import type { RebindQueueAddResult, SessionAssetListRow } from './types';

const PAGE_SIZE = 100;
const pickerQuery = (query: string, cursor: string) => ({
  queryKey: ['rebind-picker', 'createdAtAsc', query, cursor],
  queryFn: () => endpoints.sessionAssets({ facets: ['mailProvider:icloud'], q: query, cursor, limit: PAGE_SIZE, sort: 'createdAtAsc' }),
  staleTime: 30000,
});

export function RebindAssetPicker({ queuedIds, onClose, onAdd }: {
  queuedIds: string[];
  onClose: () => void;
  onAdd: (ids: string[]) => Promise<RebindQueueAddResult>;
}) {
  const client = useQueryClient();
  const [tab, setTab] = useState<'paste' | 'browse'>('browse');
  const [emailsText, setEmailsText] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState('');
  const [picked, setPicked] = useState<Map<string, SessionAssetListRow>>(() => new Map());
  const [report, setReport] = useState<{ tone: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const searchInput = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const returnFocus = useRef(document.activeElement);
  const [, tick] = useState(0);
  const now = Date.now();
  const queued = useMemo(() => new Set(queuedIds), [queuedIds]);

  useEffect(() => {
    if (search.trim() === query) return;
    const timer = window.setTimeout(() => { setQuery(search.trim()); setCursor(''); }, 250);
    return () => window.clearTimeout(timer);
  }, [search, query]);

  const browse = useQuery({
    ...pickerQuery(query, cursor),
    enabled: tab === 'browse',
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
  });
  const changingPage = browse.isPlaceholderData || search.trim() !== query;
  const rows = browse.data?.assets || [];
  useEffect(() => {
    if (tab === 'browse' && !browse.isPlaceholderData && browse.data?.cursor) {
      void client.prefetchQuery(pickerQuery(query, browse.data.cursor));
    }
  }, [client, tab, query, browse.isPlaceholderData, browse.data]);
  useLayoutEffect(() => {
    if (!browse.isPlaceholderData && list.current) list.current.scrollTop = 0;
  }, [browse.isPlaceholderData, browse.data?.offset]);
  // Update the countdown once a minute, or exactly when the next lock expires.
  useEffect(() => {
    if (tab !== 'browse') return;
    const waits = rows.map((asset) => Date.parse(asset.createdAt || '') + REGISTRATION_LOCK_MS - now).filter((ms) => ms > 0);
    const timer = window.setTimeout(() => tick((value) => value + 1), Math.min(60000, ...waits) + 1);
    return () => window.clearTimeout(timer);
  }, [tab, browse.data, now]);

  const available = (asset: SessionAssetListRow) => !queued.has(asset.id) && rebindEligible(asset.createdAt, now);
  const selectable = rows.filter(available);
  const pickedEligible = [...picked.values()].filter(available);
  const allPageSelected = selectable.length > 0 && selectable.every((asset) => picked.has(asset.id));
  const parsedEmails = useMemo(() => [...new Set(emailsText.split(/[\s,;，；]+/).map((line) => line.trim().toLowerCase()).filter((line) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(line)))], [emailsText]);

  const toggle = (asset: SessionAssetListRow) => setPicked((current) => {
    const next = new Map(current);
    if (next.has(asset.id)) next.delete(asset.id); else next.set(asset.id, asset);
    return next;
  });
  const togglePage = () => setPicked((current) => {
    const next = new Map(current);
    for (const asset of selectable) { if (allPageSelected) next.delete(asset.id); else next.set(asset.id, asset); }
    return next;
  });
  const submit = async () => {
    setBusy(true);
    setReport(null);
    try {
      const resolved = tab === 'paste' ? await endpoints.resolveSessionAssetEmails(parsedEmails) : null;
      const ids = resolved ? resolved.matched.map((item) => item.assetId) : pickedEligible.map((asset) => asset.id);
      const result = ids.length ? await onAdd(ids) : { accounts: [], added: 0, blocked: [] };
      const unmatched = resolved?.unmatched.length || 0;
      if (result.added > 0 && !result.blocked.length && !unmatched) { onClose(); return; }
      setReport(summarizeRebindAdd(result, unmatched));
      // Keep rejected selections/input visible so a partial result can be corrected.
      const remaining = new Set(result.blocked.map((item) => item.id));
      if (tab === 'browse') setPicked((current) => new Map([...current].filter(([id]) => remaining.has(id))));
    } catch (error) {
      setReport({ tone: 'error', text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  return <Dialog.Root open onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="rebind-modal-backdrop" />
      <Dialog.Content className="rebind-modal"
        onOpenAutoFocus={(event) => { event.preventDefault(); searchInput.current?.focus(); }}
        onCloseAutoFocus={(event) => { event.preventDefault(); if (returnFocus.current instanceof HTMLElement) returnFocus.current.focus(); }}
        onEscapeKeyDown={(event) => { if (busy) event.preventDefault(); }} onInteractOutside={(event) => { if (busy) event.preventDefault(); }}>
        <header className="rebind-modal-head">
          <Dialog.Title>加入 iCloud 账号</Dialog.Title>
          <IconButton label="关闭账号选择" onClick={onClose} disabled={busy}><X size={18} /></IconButton>
        </header>
        <Dialog.Description className="rebind-modal-description">注册满 24 小时可加入，按首次入库时间计算。</Dialog.Description>
        <div className="rebind-tabs" role="tablist" aria-label="添加方式">
          <button type="button" role="tab" aria-selected={tab === 'browse'} className={`rebind-tab${tab === 'browse' ? ' active' : ''}`} onClick={() => setTab('browse')} disabled={busy}><Search size={15} />浏览资产</button>
          <button type="button" role="tab" aria-selected={tab === 'paste'} className={`rebind-tab${tab === 'paste' ? ' active' : ''}`} onClick={() => setTab('paste')} disabled={busy}><ClipboardList size={15} />粘贴邮箱</button>
        </div>
        <div className="rebind-modal-body">
          {tab === 'paste'
            ? <textarea className="rebind-textarea" aria-label="批量粘贴邮箱" placeholder={'每行一个邮箱，也支持逗号或空格分隔\nalice@icloud.com\nbob@me.com'} value={emailsText} onChange={(event) => setEmailsText(event.target.value)} disabled={busy} />
            : <>
              <input ref={searchInput} className="rebind-search" aria-label="搜索 iCloud 登录态" placeholder="搜索邮箱、账号 ID" value={search} onChange={(event) => setSearch(event.target.value)} disabled={busy} />
              <div className="rebind-picker-toolbar">
                <label><input type="checkbox" aria-label="全选本页可用账号" checked={allPageSelected} disabled={busy || !selectable.length || changingPage} onChange={togglePage} />全选本页可用</label>
                <span>解锁早的在前 · 共 {browse.data?.total ?? 0} 个</span>
              </div>
              <div className="rebind-list-frame">
                {browse.isPlaceholderData && <span className="rebind-page-loading">正在换页…</span>}
                <div ref={list} className="rebind-modal-list" aria-label="可添加账号" aria-busy={browse.isFetching}>
                  {browse.isPending ? <div className="loading-line"><LoaderCircle className="spin" size={16} />读取账号…</div>
                    : browse.isError ? <EmptyState icon={<KeyRound size={22} />} title="账号加载失败" detail={errorMessage(browse.error)} action={<Button onClick={() => browse.refetch()}>重试</Button>} />
                      : rows.length ? rows.map((asset) => {
                        const reason = queued.has(asset.id) ? '已在队列' : eligibleInLabel(asset.createdAt, now);
                        return <label key={asset.id} className={`rebind-pick-row${picked.has(asset.id) ? ' picked' : ''}${reason ? ' locked' : ''}`}>
                          <input type="checkbox" aria-label={`选择 ${asset.email}`} checked={picked.has(asset.id)} disabled={busy || Boolean(reason) || changingPage} onChange={() => toggle(asset)} />
                          <span className="rebind-pick-main"><strong>{asset.email}</strong><small>{asset.createdAt ? `入库 ${formatTime(asset.createdAt)}` : '入库时间未知'}</small></span>
                          {reason ? <span className="rebind-lock-tag"><Lock size={12} />{reason}</span> : <span className="rebind-hint">{asset.hasAccessToken ? '可加入' : asset.hasPassword && asset.hasTotp ? '需自动登录' : '需刷新登录态'}</span>}
                        </label>;
                      }) : <EmptyState icon={<KeyRound size={22} />} title="没有匹配的 iCloud 账号" detail="可调整搜索，或前往登录态资产页导入。" />}
                </div>
              </div>
              <div className="rebind-picker-toolbar">
                <Button tone="quiet" disabled={busy || !cursor || changingPage || browse.isPending} onClick={() => setCursor(Number(cursor) > PAGE_SIZE ? String(Number(cursor) - PAGE_SIZE) : '')}>上一页</Button>
                <span>第 {Math.floor((browse.data?.offset ?? Number(cursor || 0)) / PAGE_SIZE) + 1} / {Math.max(1, Math.ceil((browse.data?.total || 0) / PAGE_SIZE))} 页</span>
                <Button tone="quiet" disabled={busy || !browse.data?.cursor || changingPage || browse.isPending} onClick={() => setCursor(browse.data!.cursor)}>下一页</Button>
              </div>
            </>}
          {report && <div role="status" className={`rebind-report rebind-report-${report.tone}`}>{report.text}</div>}
          <div className="rebind-modal-foot">
            <span className="rebind-hint">{tab === 'paste' ? `已识别 ${parsedEmails.length} 个邮箱` : `已选 ${pickedEligible.length} 个（跨页保留）`}</span>
            <Button tone="primary" icon={busy ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />} disabled={busy || !(tab === 'paste' ? parsedEmails.length : pickedEligible.length)} onClick={submit}>加入队列</Button>
          </div>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
