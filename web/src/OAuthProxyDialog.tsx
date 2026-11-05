import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Dialog } from 'radix-ui';
import { endpoints } from './api';
import type { ProxyAssignment } from './types';
import { balancedPoolAssignments, countryPoolAssignments, defaultProxyAssignments, proxyAssignmentsAreReady, resizeProxyAssignments } from './run-plan-ui';
import { Button, Notice } from './components/ConsoleUi';

export function OAuthProxyDialog({ open, onOpenChange, workers, initial, busy, error, onConfirm }: {
  open: boolean; onOpenChange: (value: boolean) => void; workers: number; initial?: ProxyAssignment[];
  busy?: boolean; error?: string; onConfirm: (assignments: ProxyAssignment[]) => void;
}) {
  const catalog = useQuery({ queryKey: ['proxies'], queryFn: endpoints.proxies, enabled: open });
  const [assignments, setAssignments] = useState<ProxyAssignment[]>([]);
  useEffect(() => {
    if (!open) { setAssignments([]); return; }
    if (!catalog.data) return;
    setAssignments((current) => resizeProxyAssignments(current.length ? current : (initial || []).filter((p) => p.kind !== 'maintenance'), workers, catalog.data));
  }, [open, workers, catalog.data]);
  const pools = catalog.data?.dynamic?.countryPools || [];
  const local = catalog.data?.local?.proxies || catalog.data?.proxies || [];
  const ready = proxyAssignmentsAreReady(assignments, catalog.data);
  const replace = (slot: number, value: string) => setAssignments((current) => current.map((p) => p.workerSlot !== slot ? p : value.startsWith('pool:')
    ? { workerSlot: slot, kind: 'countryPool', countryCode: value.slice(5) }
    : { workerSlot: slot, kind: 'local', localProxyId: value.slice(6) }));
  return <Dialog.Root open={open} onOpenChange={(value) => { if (busy) return; if (!value) setAssignments([]); onOpenChange(value); }}><Dialog.Portal><Dialog.Overlay className="dialog-overlay" /><Dialog.Content className="dialog-content dialog-wide">
    <Dialog.Title>OAuth 代理选择</Dialog.Title><Dialog.Description>与注册使用同一代理资源池及检测规则。每个 Worker 绑定所选代理，正常授权过程中保持出口。更换代理将重新登录未完成账号，已完成账号不会重跑；有未处理短信租约时请先清理。</Dialog.Description>
    <div className="worker-proxy-bulk"><select aria-label="OAuth 全部使用同一国家池" defaultValue="" disabled={busy} onChange={(e) => { if (e.target.value) setAssignments(countryPoolAssignments(workers, e.target.value)); }}><option value="">全部同一国家池…</option>{pools.map((p) => <option key={p.countryCode} value={p.countryCode} disabled={!p.total}>{p.countryCode} · {p.total} 条</option>)}</select>
      <Button disabled={busy || !pools.some((p) => p.total > 0)} onClick={() => setAssignments(balancedPoolAssignments(workers, catalog.data))}>按容量均分</Button>
      <Button disabled={busy} onClick={() => { void catalog.refetch(); }}>刷新代理列表</Button>
    </div>
    <div className="worker-proxy-rows" style={{ maxHeight: 350, overflowY: 'auto' }}>{assignments.map((p) => <label className="worker-proxy-row" key={p.workerSlot}><strong>Worker {p.workerSlot}</strong><select aria-label={`OAuth Worker ${p.workerSlot} 代理`} disabled={busy} value={p.kind === 'countryPool' ? `pool:${p.countryCode}` : p.kind === 'local' ? `local:${p.localProxyId}` : ''} onChange={(e) => replace(p.workerSlot, e.target.value)}>
      <option value="">选择代理</option><optgroup label="国家池">{pools.map((pool) => <option key={pool.countryCode} disabled={!pool.total} value={`pool:${pool.countryCode}`}>{pool.countryCode} · {pool.total} 条</option>)}</optgroup>
      <optgroup label="固定代理">{local.map((proxy) => <option key={proxy.id} value={`local:${proxy.id}`} disabled={assignments.some((a) => a.workerSlot !== p.workerSlot && a.kind === 'local' && a.localProxyId === proxy.id)}>{proxy.endpoint || proxy.id}</option>)}</optgroup>
    </select></label>)}</div>
    {!ready && <Notice tone="warning">代理资源不足或尚未选择，请补充代理或降低并发。</Notice>}
    {error && <Notice tone="danger">{error}</Notice>}
    {catalog.error && <Notice tone="danger">代理列表读取失败，请重试。</Notice>}
    <div className="dialog-actions"><Button disabled={busy} onClick={() => onOpenChange(false)}>关闭</Button><Button tone="primary" disabled={!ready || busy} onClick={() => onConfirm(assignments.length ? assignments : defaultProxyAssignments(workers, catalog.data))}>{busy ? '预检并启动中…' : '确认代理并继续'}</Button></div>
  </Dialog.Content></Dialog.Portal></Dialog.Root>;
}
