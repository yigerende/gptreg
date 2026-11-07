import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Dialog } from 'radix-ui';
import { endpoints } from './api';
import type { ProxyAssignment } from './types';
import { balancedPoolAssignments, countryPoolAssignments, defaultProxyAssignments, proxyAssignmentsAreReady, resizeProxyAssignments } from './run-plan-ui';
import { Button, Notice } from './components/ConsoleUi';
import { sessionProxyApi, type SessionProxySettings } from './session-proxy-api';

export function OAuthProxyDialog({ open, onOpenChange, workers, initial, busy, error, onConfirm }: {
  open: boolean; onOpenChange: (value: boolean) => void; workers: number; initial?: ProxyAssignment[];
  busy?: boolean; error?: string; onConfirm: (assignments: ProxyAssignment[]) => void;
}) {
  const catalog = useQuery({ queryKey: ['proxies'], queryFn: endpoints.proxies, enabled: open });
  const settings = useQuery({ queryKey: ['session-proxy', 'settings'], queryFn: () => sessionProxyApi<SessionProxySettings>(), enabled: open });
  const [mode, setMode] = useState('');
  const [assignments, setAssignments] = useState<ProxyAssignment[]>([]);
  useEffect(() => {
    if (!open) { setAssignments([]); setMode(''); return; }
    if (!catalog.data) return;
    setAssignments((current) => resizeProxyAssignments(current.length ? current : (initial || []).filter((p) => p.kind !== 'maintenance'), workers, catalog.data));
  }, [open, workers, catalog.data]);
  const pools = catalog.data?.dynamic?.countryPools || [];
  const sessionMode = (mode || (initial ? 'countryPool' : settings.data?.defaultMode)) === 'sessionProxy';
  const local = catalog.data?.local?.proxies || catalog.data?.proxies || [];
  const ready = sessionMode ? !!settings.data?.ready && !!settings.data?.enabled && settings.data.country_count > 0 : proxyAssignmentsAreReady(assignments, catalog.data);
  const replace = (slot: number, value: string) => setAssignments((current) => current.map((p) => p.workerSlot !== slot ? p : value.startsWith('pool:')
    ? { workerSlot: slot, kind: 'countryPool', countryCode: value.slice(5) }
    : { workerSlot: slot, kind: 'local', localProxyId: value.slice(6) }));
  return <Dialog.Root open={open} onOpenChange={(value) => { if (busy) return; if (!value) setAssignments([]); onOpenChange(value); }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content dialog-wide">
    <Dialog.Title>OAuth 代理选择</Dialog.Title><Dialog.Description>选择本次授权使用的代理模式。独立会话优先续用原账号的有效会话，到期后仍只继续原账号 OAuth。</Dialog.Description>
    {!initial && <label>代理模式<select aria-label="OAuth 代理模式" value={sessionMode ? 'sessionProxy' : 'countryPool'} disabled={busy} onChange={e => setMode(e.target.value)}><option value="countryPool">国家池 / 本地代理</option><option value="sessionProxy">独立会话代理</option></select></label>}
    {sessionMode ? <Notice>按账号分配独立会话，共享容量 {settings.data?.maxParallel || 0}；无需预先拉取代理。</Notice> : <>
    <div className="worker-proxy-bulk"><select aria-label="OAuth 全部使用同一国家池" defaultValue="" disabled={busy} onChange={(e) => { if (e.target.value) setAssignments(countryPoolAssignments(workers, e.target.value)); }}><option value="">全部同一国家池…</option>{pools.map((p) => <option key={p.countryCode} value={p.countryCode} disabled={!p.total}>{p.countryCode} · {p.total} 条</option>)}</select>
      <Button disabled={busy || !pools.some((p) => p.total > 0)} onClick={() => setAssignments(balancedPoolAssignments(workers, catalog.data))}>按容量均分</Button>
      <Button disabled={busy} onClick={() => { void catalog.refetch(); }}>刷新代理列表</Button>
    </div>
    <div className="worker-proxy-rows" style={{ maxHeight: 350, overflowY: 'auto' }}>{assignments.map((p) => <label className="worker-proxy-row" key={p.workerSlot}><strong>Worker {p.workerSlot}</strong><select aria-label={`OAuth Worker ${p.workerSlot} 代理`} disabled={busy} value={p.kind === 'countryPool' ? `pool:${p.countryCode}` : p.kind === 'local' ? `local:${p.localProxyId}` : ''} onChange={(e) => replace(p.workerSlot, e.target.value)}>
      <option value="">选择代理</option><optgroup label="国家池">{pools.map((pool) => <option key={pool.countryCode} disabled={!pool.total} value={`pool:${pool.countryCode}`}>{pool.countryCode} · {pool.total} 条</option>)}</optgroup>
      <optgroup label="固定代理">{local.map((proxy) => <option key={proxy.id} value={`local:${proxy.id}`} disabled={assignments.some((a) => a.workerSlot !== p.workerSlot && a.kind === 'local' && a.localProxyId === proxy.id)}>{proxy.endpoint || proxy.id}</option>)}</optgroup>
    </select></label>)}</div>
    </>}
    {!ready && <Notice tone="warning">{sessionMode ? '请先配置独立会话并开放注册地区。' : '代理资源不足或尚未选择，请补充代理或降低并发。'}</Notice>}
    {error && <Notice tone="danger">{error}</Notice>}
    {catalog.error && <Notice tone="danger">代理列表读取失败，请重试。</Notice>}
    <div className="dialog-actions"><Button disabled={busy} onClick={() => onOpenChange(false)}>关闭</Button><Button tone="primary" disabled={!ready || busy} onClick={() => onConfirm(sessionMode ? Array.from({ length: workers }, (_, i) => ({ workerSlot: i + 1, kind: 'sessionProxy' })) : assignments.length ? assignments : defaultProxyAssignments(workers, catalog.data))}>{busy ? '预检并启动中…' : '确认代理并继续'}</Button></div>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
