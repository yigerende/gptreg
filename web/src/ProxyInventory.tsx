import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, RefreshCw, Search, Activity } from 'lucide-react';
import { endpoints } from './api';
import { AppSelect } from './components/AppSelect';
import { Button, Notice } from './components/ConsoleUi';
import { Pagination } from './components/Pagination';
import './proxy-inventory.css';

export type ProxyInventoryRow = {
  id: string; scope: string; countryCode: string; provider: string; providerLabel: string;
  sourceId: string; protocol: string; endpoint: string; host: string; port: string;
  pulledAt: string; sessionMinutes: number | null;
  check: null | { status: string; checkedAt: string; httpStatus: number; latencyMs: number | null; exitIp?: string; message?: string };
};
export type ProxyTest = { id: string; status: string; total: number; done: number; succeeded: number; failed: number; startedAt: string; finishedAt: string };
export type ProxyInventoryPage = {
  items: ProxyInventoryRow[]; total: number; offset: number; limit: number;
  countries: string[]; providers: { value: string; label: string }[];
  summary: { total: number; matched: number; healthy: number; failed: number; unknown: number };
  test: ProxyTest | null;
};
const initial = { scope: 'country', country: 'all', provider: 'all', protocol: 'all', status: 'all', sort: 'country', q: '' };
const time = (value?: string) => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—';

export default function ProxyInventory() {
  const client = useQueryClient();
  const [filters, setFilters] = useState(initial), [search, setSearch] = useState(''), [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<Set<string>>(new Set()), [error, setError] = useState('');
  const list = useQuery({ queryKey: ['proxies', 'inventory', filters, offset], queryFn: () => endpoints.proxyInventory({ ...filters, offset: String(offset), limit: '50' }), refetchInterval: query => query.state.data?.test?.status === 'running' ? 1000 : false });
  const test = useMutation({
    mutationFn: (body: { ids?: string[]; all?: boolean }) => endpoints.testProxyInventory({ ...body, filters }),
    onSuccess: result => {
      setError('');
      client.setQueryData(['proxies', 'inventory', filters, offset], (data: ProxyInventoryPage | undefined) => data ? { ...data, test: result } : data);
      void client.invalidateQueries({ queryKey: ['proxies', 'inventory'] });
    },
    onError: e => setError((e as Error).message),
  });
  const rows = list.data?.items || [], job = list.data?.test, busy = test.isPending || job?.status === 'running';
  const update = (key: keyof typeof initial, value: string) => { setFilters(f => ({ ...f, [key]: value })); setOffset(0); setSelected(new Set()); };
  const toggle = (ids: string[], checked: boolean) => setSelected(old => { const next = new Set(old); for (const id of ids) { if (checked && next.size < 1000) next.add(id); else if (!checked) next.delete(id); } return next; });
  const ids = [...new Set(rows.map(row => row.id))];
  return <section className="workspace-band proxy-inventory">
    <div className="section-heading"><div><h2>全部代理列表</h2><p>查看当前缓存的代理，按条件分页查询。检测出口 IP 与连通性，不会发起账号注册。</p></div><Button icon={<RefreshCw size={15} />} disabled={list.isFetching} onClick={() => { void list.refetch(); }}>刷新列表</Button></div>
    <form className="proxy-inventory-filters" onSubmit={e => { e.preventDefault(); update('q', search); }}>
      <AppSelect ariaLabel="代理范围" value={filters.scope} onValueChange={v => update('scope', v)} options={[{ value: 'country', label: '国家代理池' }, { value: 'local', label: '本地端口' }, { value: 'all', label: '全部代理' }]} />
      <AppSelect ariaLabel="筛选国家" value={filters.country} onValueChange={v => update('country', v)} options={[{ value: 'all', label: '全部国家' }, ...(list.data?.countries || []).map(value => ({ value, label: value === 'GLOBAL' ? '全球' : value }))]} />
      <AppSelect ariaLabel="筛选厂商" value={filters.provider} onValueChange={v => update('provider', v)} options={[{ value: 'all', label: '全部厂商' }, ...(list.data?.providers || [])]} />
      <AppSelect ariaLabel="筛选协议" value={filters.protocol} onValueChange={v => update('protocol', v)} options={[{ value: 'all', label: '全部协议' }, { value: 'http', label: 'HTTP' }, { value: 'https', label: 'HTTPS' }, { value: 'socks5', label: 'SOCKS5' }]} />
      <AppSelect ariaLabel="筛选检测结果" value={filters.status} onValueChange={v => update('status', v)} options={[{ value: 'all', label: '全部检测结果' }, { value: 'unknown', label: '未检测' }, { value: 'healthy', label: '连接成功' }, { value: 'failed', label: '连接失败' }]} />
      <AppSelect ariaLabel="代理排序" value={filters.sort} onValueChange={v => update('sort', v)} options={[{ value: 'country', label: '按国家排序' }, { value: 'latency', label: '延迟从低到高' }, { value: 'checked', label: '最近检测优先' }, { value: 'pulled', label: '最近拉取优先' }]} />
      <input aria-label="搜索代理" placeholder="搜索地址、端口、出口 IP 或厂商" value={search} onChange={e => setSearch(e.target.value)} maxLength={200} />
      <Button type="submit" icon={<Search size={15} />}>查询</Button>
    </form>
    {(error || list.error) && <Notice tone="danger">{error || (list.error as Error).message}</Notice>}
    <div className="proxy-inventory-tools">
      <span>匹配 <b>{list.data?.total || 0}</b> 条 · 成功 {list.data?.summary?.healthy || 0} · 失败 {list.data?.summary?.failed || 0} · 未检测 {list.data?.summary?.unknown || 0}</span>
      <div><span>已选 {selected.size} / 1000</span><Button disabled={!selected.size || busy} onClick={() => test.mutate({ ids: [...selected] })}>测试已选</Button><Button disabled={!list.data?.total || list.data.total > 1000 || busy || list.isFetching} onClick={() => test.mutate({ all: true })}>测试筛选结果</Button><Button disabled={!selected.size} onClick={() => setSelected(new Set())}>清除选择</Button></div>
    </div>
    {job && <div className="proxy-inventory-progress" role="status"><span>{busy && <LoaderCircle size={16} className="spin" />}{job.status === 'running' ? '正在测试' : '测试完成'} {job.done}/{job.total} · 成功 {job.succeeded} · 失败 {job.failed}</span><progress aria-label="代理测试进度" value={job.done} max={job.total || 1} /></div>}
    <div className="proxy-inventory-table"><table><thead><tr><th><input type="checkbox" aria-label="选择本页代理" checked={!!ids.length && ids.every(id => selected.has(id))} onChange={e => toggle(ids, e.target.checked)} /></th><th>代理地址</th><th>国家 / 厂商</th><th>协议 / 粘性</th><th>出口 IP</th><th>检测结果 / 延迟</th><th>拉取 / 检测时间</th><th>操作</th></tr></thead><tbody>
      {rows.map(row => <tr key={`${row.scope}:${row.countryCode}:${row.sourceId}:${row.id}`}><td><input type="checkbox" aria-label={`选择 ${row.endpoint}`} checked={selected.has(row.id)} disabled={!selected.has(row.id) && selected.size >= 1000} onChange={e => toggle([row.id], e.target.checked)} /></td><td><code>{row.endpoint}</code></td><td>{row.countryCode === 'GLOBAL' ? '全球' : row.countryCode || '本地'}<small>{row.providerLabel}</small></td><td>{row.protocol.toUpperCase()}<small>{row.sessionMinutes ? `${row.sessionMinutes} 分钟` : '—'}</small></td><td><code>{row.check?.exitIp || '—'}</code></td><td><span className={`proxy-check-${row.check?.status || 'unknown'}`}>{row.check?.status === 'healthy' ? '连接成功' : row.check?.status === 'failed' ? '连接失败' : '未检测'}</span><small>{row.check?.latencyMs != null ? `${row.check.latencyMs} ms` : row.check?.message || '点击测试获取实时出口'}</small></td><td>{time(row.pulledAt)}<small>{time(row.check?.checkedAt)}</small></td><td><Button disabled={busy} icon={<Activity size={14} />} onClick={() => test.mutate({ ids: [row.id] })}>测试</Button></td></tr>)}
      {!rows.length && <tr><td colSpan={8}>{list.isLoading ? '正在加载代理…' : '没有符合条件的代理'}</td></tr>}
    </tbody></table></div>
    <Pagination label="全部代理分页" total={list.data?.total || 0} offset={offset} busy={list.isFetching} onChange={setOffset} />
    <p className="proxy-inventory-hint">每次最多测试 1000 条，4 条并行。检测会消耗少量代理流量；结果仅代表检测时刻，服务重启后清空。粘性到期后出口 IP 可能变化；连接成功不代表目标网站一定接受该 IP。</p>
  </section>;
}
