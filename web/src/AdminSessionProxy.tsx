import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LoaderCircle, RefreshCw, Save } from 'lucide-react';
import { Button, Notice, PageHeader, formatTime, ConfirmDialog } from './components/ConsoleUi';
import { Pagination } from './components/Pagination';
import { AppSelect } from './components/AppSelect';
import { Link } from './router';
import { sessionProxyApi as api, useSessionProxySettings, type SessionProxySettings, type SessionRegion, type SessionPage, type SessionRow } from './session-proxy-api';
import './session-proxy.css';
const modes = [{ value: 'local', label: '本地代理' }, { value: 'countryPool', label: '国家代理池' }, { value: 'sessionProxy', label: '独立会话代理' }];
const states: Record<string, string> = { reserved: '预留中', active: '使用中', stopping: '停止中', ended: '已结束', expired: '已过期', failed: '失败' };

export function ProxyWorkspace({ children }: { children: ReactNode }) {
  const query = useSessionProxySettings(), client = useQueryClient();
  const [chosenTab, setTab] = useState(''), [selected, setSelected] = useState('');
  const tab = chosenTab || query.data?.defaultMode || 'countryPool';
  const save = useMutation({ mutationFn: () => api<SessionProxySettings>('', 'PUT', { expected_revision: query.data?.revision, defaultMode: selected || query.data?.defaultMode }),
    onSuccess: value => { client.setQueryData(['session-proxy', 'settings'], value); setSelected(''); setTab(''); void client.invalidateQueries({ queryKey: ['session-proxy'] }); } });
  return <div className={`session-workspace proxy-mode-${tab}`}>
    <section className="workspace-band session-mode-bar"><div><strong>新任务默认代理模式</strong><p>只影响新任务。切换下方配置标签不会启用该模式。</p></div>
      <AppSelect ariaLabel="新任务默认代理模式" value={selected || query.data?.defaultMode || 'countryPool'} options={modes} onValueChange={setSelected} disabled={!query.data || save.isPending} />
      <Button icon={save.isPending ? <LoaderCircle className="spin" size={16} /> : <Save size={16} />} onClick={() => save.mutate()} disabled={!query.data || save.isPending}>保存模式</Button>
      <Link to="/proxies/regions">注册地区</Link><Link to="/proxies/sessions">会话记录</Link>
    </section>
    {save.isSuccess && <Notice tone="success">默认模式已保存，已接受的任务保持原模式。</Notice>}
    {(query.error || save.error) && <Notice tone="danger">{(save.error || query.error)?.message}</Notice>}
    <div className="segmented session-tabs" role="tablist" aria-label="代理配置">{modes.map(m => <button key={m.value} role="tab" aria-selected={tab === m.value} className={tab === m.value ? 'selected' : ''} onClick={() => setTab(m.value)}>{m.label}</button>)}</div>
    {tab === 'sessionProxy' ? <SessionProxyConfigPage /> : children}
  </div>;
}

function SessionProxyConfigPage() {
  const query = useSessionProxySettings(), client = useQueryClient();
  const [draft, setDraft] = useState<Partial<SessionProxySettings> & { apiToken?: string; username?: string; password?: string; subuserHash?: string; clear?: string[] }>();
  const [draftRevision, setDraftRevision] = useState<number>();
  const [country, setCountry] = useState('JP'), [result, setResult] = useState<Record<string, string>>({});
  useEffect(() => { if (!draft && query.data) { setDraftRevision(query.data.revision); setDraft({ authType: query.data.authType, protocol: query.data.protocol, lifetimeMinutes: query.data.lifetimeMinutes, renewalCountry: query.data.renewalCountry, maxParallel: query.data.maxParallel, enabled: query.data.enabled, ipDedup: query.data.ipDedup }); } }, [draft, query.data]);
  const action = useMutation({ mutationFn: async (name: string) => {
    if (name === 'save') return api<SessionProxySettings>('', 'PUT', { ...draft, expected_revision: draftRevision });
    if (name === 'revoke' || name === 'restore') return api<SessionProxySettings>('', 'PUT', { expected_revision: query.data?.revision, revoked: name === 'revoke' });
    return api<Record<string, unknown>>('/' + name, 'POST', name === 'test-country' ? { country } : {});
  }, onSuccess: (value, name) => {
    if (name === 'save') { client.setQueryData(['session-proxy', 'settings'], value); setDraft(undefined); }
    const resultValue = value as unknown as Record<string, unknown>;
    setResult(old => ({ ...old, [name]: name === 'test-country' ? `${String(resultValue.country)} · 出口 ${String(resultValue.exitIp)} · ${String(resultValue.latencyMs)} ms` : String('message' in value ? value.message : name === 'save' ? '配置已保存' : name === 'revoke' ? '已紧急停用全部历史版本' : '已解除紧急停用') }));
    void client.invalidateQueries({ queryKey: ['session-proxy'] });
  } });
  if (!query.data || !draft) return <Notice>{query.error?.message || '正在读取独立会话配置…'}</Notice>;
  const cfg = query.data, busy = action.isPending;
  const patch = (key: string, value: unknown) => setDraft(d => ({ ...d, [key]: value }));
  const secret = (key: 'apiToken' | 'username' | 'password' | 'subuserHash', label: string, filled: boolean) => <label><span>{label}</span><input type={key === 'username' ? 'text' : 'password'} autoComplete="new-password" value={draft[key] || ''} onChange={e => patch(key, e.target.value)} placeholder={filled ? '已配置，留空保留原值' : '请输入'} disabled={busy || draft.clear?.includes(key)} />{filled && <Button disabled={busy} onClick={() => patch('clear', draft.clear?.includes(key) ? draft.clear.filter(k => k !== key) : [...draft.clear || [], key])}>{draft.clear?.includes(key) ? '已标记清除，点击撤销' : `清除已保存的${label}`}</Button>}</label>;
  return <section className="workspace-band session-config">
    <PageHeader title="独立会话代理" description="IPRoyal 账号认证模式。执行到具体账号时生成会话，连续注册与 OAuth 共用；不占白名单端口。" />
    <p>配置版本：{cfg.activeVersion?.slice(0, 12) || '未保存'} · 秘密字段不会回显，留空保存保留原值。</p>
    <div className="session-stats"><span>就绪状态<strong>{cfg.revoked ? '已紧急停用' : cfg.ready ? '配置就绪' : '待配置'}</strong></span><span>总额度<strong>{cfg.maxParallel}</strong></span><span>预留 / 使用 / 停止中<strong>{cfg.counts.reserved || 0} / {cfg.counts.active || 0} / {cfg.counts.stopping || 0}</strong></span><span>可新增<strong>{cfg.available}</strong></span></div>
    {cfg.occupied > cfg.maxParallel && <Notice>上限已降低，正在等待现有任务完成。</Notice>}
    {draftRevision !== cfg.revision && <Notice tone="warning">配置或地区已更新。请重新载入后编辑，避免覆盖其他修改。<Button onClick={() => setDraft(undefined)}>重新载入配置</Button></Notice>}
    {cfg.last_error && <Notice tone="danger">最近检查：{cfg.last_error}</Notice>}
    <div className="session-form">
      {secret('apiToken', 'IPRoyal API Token', cfg.token_configured)}
      <label><span>认证方式</span><AppSelect ariaLabel="独立会话认证方式" value={draft.authType || 'credentials'} options={[{ value: 'credentials', label: '代理账号密码' }, { value: 'subuser', label: 'Subuser hash' }]} onValueChange={v => patch('authType', v)} /></label>
      {draft.authType === 'subuser' ? secret('subuserHash', 'Subuser hash', cfg.subuser_configured) : <>{secret('username', '代理账号', cfg.username_configured)}{secret('password', '代理密码', cfg.password_configured)}</>}
      <label><span>协议</span><AppSelect ariaLabel="独立会话协议" value={draft.protocol || 'http'} options={[{ value: 'http', label: 'HTTP' }, { value: 'socks5', label: 'SOCKS5' }]} onValueChange={v => patch('protocol', v)} /></label>
      <label><span>会话粘性（分钟）</span><input type="number" min="1" max="10080" value={draft.lifetimeMinutes ?? 120} onChange={e => patch('lifetimeMinutes', Number(e.target.value))} /><small>默认 120 分钟，修改只影响新任务。</small></label>
      <label><span>独立会话总并发</span><input type="number" min="1" max="100" value={draft.maxParallel ?? 20} onChange={e => patch('maxParallel', Number(e.target.value))} /><small>用户订单、原注册台、OAuth 和测试共用。</small></label>
      <label><span>补 OAuth 默认国家</span><input maxLength={2} value={draft.renewalCountry || ''} placeholder="留空按任务地区选择" onChange={e => patch('renewalCountry', e.target.value.toUpperCase())} /></label>
      <label className="session-check"><input type="checkbox" checked={!!draft.enabled} onChange={e => patch('enabled', e.target.checked)} /><span>允许接受新任务</span></label>
      <label className="session-check"><input type="checkbox" checked={!!draft.ipDedup} onChange={e => patch('ipDedup', e.target.checked)} /><span>检测活跃会话出口重复并重试</span></label>
    </div>
    <Notice>独立会话不保证出口 IP 永不重复或永不变化。出口去重仅检查检测时正在使用的出口。</Notice>
    <div className="session-actions"><Button tone="primary" disabled={busy} onClick={() => action.mutate('save')}>{busy && action.variables === 'save' ? '保存中…' : '保存配置'}</Button><Button disabled={busy || !cfg.token_configured || cfg.revoked} onClick={() => action.mutate('test')}>测试 API</Button><Button disabled={busy || !cfg.token_configured || cfg.revoked} onClick={() => action.mutate('sync')}>同步国家</Button><input aria-label="测试国家代码" maxLength={2} value={country} onChange={e => setCountry(e.target.value.toUpperCase())} /><Button disabled={busy || !cfg.ready} onClick={() => action.mutate('test-country')}>测试指定国家</Button>{busy && <LoaderCircle className="spin" size={18} />}</div>
    {action.error && <Notice tone="danger">{action.error.message}</Notice>}
    {Object.entries(result).map(([key, value]) => <Notice key={key} tone="success">{({ save: '保存', test: 'API 测试', sync: '国家同步', 'test-country': '国家测试', revoke: '紧急停用', restore: '恢复' } as Record<string, string>)[key]}：{value}</Notice>)}
    <div className="session-danger"><p>关闭“接受新任务”让在途继续；紧急停用会阻止所有历史配置继续使用。</p><ConfirmDialog trigger={<Button tone={cfg.revoked ? 'default' : 'danger'} disabled={busy}>{cfg.revoked ? '解除紧急停用' : '紧急停用凭据'}</Button>} title={cfg.revoked ? '解除紧急停用' : '紧急停用全部会话'} description={cfg.revoked ? '解除后不会自动复活已结束的任务。' : '将停止新请求并收尾正在执行的任务。'} confirmLabel="执行" onConfirm={() => action.mutate(cfg.revoked ? 'restore' : 'revoke')} /></div>
  </section>;
}

export function SessionProxyRegions() {
  const settings = useSessionProxySettings();
  const client = useQueryClient(), [search, setSearch] = useState(''), [deleted, setDeleted] = useState(false), [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string[]>([]), [editing, setEditing] = useState<SessionRegion>();
  const [selectionRevision, setSelectionRevision] = useState<number>();
  const clearSelection = () => { setSelected([]); setSelectionRevision(undefined); };
  const selectAll = useMutation({ mutationFn: () => api<{ codes: string[]; revision: number }>('/regions/selection?' + new URLSearchParams({ search })),
    onSuccess: value => { setSelected(value.codes); setSelectionRevision(value.revision); } });
  const query = useQuery({ queryKey: ['session-proxy', 'regions', search, deleted, offset], queryFn: () => api<SessionPage<SessionRegion>>('/regions?' + new URLSearchParams({ search, deleted: deleted ? '1' : '0', offset: String(offset), limit: '25' })) });
  const action = useMutation({ mutationFn: ({ path, method, body }: { path: string; method: string; body?: unknown }) => api(path, method, { ...(body as object || {}), expected_revision: path === '/regions/batch' ? selectionRevision : settings.data?.revision }),
    onSuccess: () => { setEditing(undefined); clearSelection(); void client.invalidateQueries({ queryKey: ['session-proxy'] }); } });
  const edit = (r: SessionRegion, patch: Partial<SessionRegion>) => action.mutate({ path: '/regions/' + r.code, method: 'PATCH', body: patch });
  return <section className="workspace-band session-directory"><PageHeader title="注册地区" description="独立会话模式的国家目录；停用和删除只影响新任务，已接受订单保留原地区。" actions={<Link to="/proxies">返回代理配置</Link>} />
    <div className="session-actions"><input aria-label="搜索注册地区" placeholder="搜索国家代码 / 名称" value={search} disabled={selectAll.isPending} onChange={e => { setSearch(e.target.value); setOffset(0); clearSelection(); }} /><label><input type="checkbox" checked={deleted} disabled={selectAll.isPending} onChange={e => { setDeleted(e.target.checked); setOffset(0); clearSelection(); }} />显示已删除</label><Button disabled={action.isPending} onClick={() => action.mutate({ path: '/sync', method: 'POST' })}>同步国家</Button><Button disabled={action.isPending || selectAll.isPending} onClick={() => selectAll.mutate()}>{selectAll.isPending ? <><LoaderCircle className="spin" size={15} />选择中…</> : search ? '选择全部搜索结果' : '一键选择全部'}</Button><Button disabled={!selected.length || action.isPending || selectAll.isPending} onClick={clearSelection}>清空选择</Button><span>已选择 {selected.length} 个地区（跨页）</span>{[true, false].map(enabled => <Button key={String(enabled)} disabled={!selected.length || action.isPending || selectAll.isPending} onClick={() => action.mutate({ path: '/regions/batch', method: 'POST', body: { codes: selected, enabled } })}>{enabled ? '批量启用' : '批量停用'}</Button>)}</div>
    {(action.error || query.error || selectAll.error) && <Notice tone="danger">{(action.error || query.error || selectAll.error)?.message}</Notice>}
    {query.isFetching && <span role="status">正在加载地区…</span>}
    <div className="session-table-scroll"><table className="session-table"><thead><tr><th>选择</th><th>国家码</th><th>名称</th><th>供应商</th><th>排序</th><th>状态</th><th>操作</th></tr></thead><tbody>{query.data?.items.map(row => <tr key={row.code}>
      <td><input type="checkbox" aria-label={`选择 ${row.code}`} checked={selected.includes(row.code)} disabled={row.suppressed || action.isPending || selectAll.isPending} onChange={e => { setSelectionRevision(old => old ?? settings.data?.revision); setSelected(old => e.target.checked ? [...old, row.code] : old.filter(x => x !== row.code)); }} /></td><td><code>{row.code}</code></td>
      <td>{editing?.code === row.code ? <input aria-label="地区名称" value={editing.name} onChange={e => setEditing({ ...editing, name: e.target.value })} /> : row.name}</td><td>IPRoyal</td>
      <td>{editing?.code === row.code ? <input aria-label="地区排序" type="number" value={editing.sort} onChange={e => setEditing({ ...editing, sort: Number(e.target.value) })} /> : row.sort}</td><td>{row.suppressed ? '已删除' : row.enabled ? '已开放' : '已停用'}</td>
      <td><div className="session-actions">{editing?.code === row.code ? <><Button disabled={action.isPending} onClick={() => edit(row, { name: editing.name, sort: editing.sort })}>保存</Button><Button onClick={() => setEditing(undefined)}>取消</Button></> : <Button onClick={() => setEditing(row)}>编辑</Button>}
        <Button disabled={action.isPending} onClick={() => edit(row, row.suppressed ? { suppressed: false } : { enabled: !row.enabled })}>{row.suppressed ? '恢复' : row.enabled ? '停用' : '启用'}</Button>
        {!row.suppressed && <ConfirmDialog trigger={<Button tone="danger" disabled={action.isPending}>删除</Button>} title={`删除注册地区 ${row.code}`} description="不会删除旧订单的地区，也不会在下次同步时自动恢复。" confirmLabel="删除" onConfirm={() => action.mutate({ path: '/regions/' + row.code, method: 'DELETE' })} />}</div></td>
    </tr>)}</tbody></table>{query.data?.total === 0 && <p>暂无地区。先保存 API Token，然后同步国家。</p>}</div>
    <Pagination label="注册地区分页" total={query.data?.total || 0} offset={offset} limit={25} busy={query.isFetching} onChange={setOffset} />
  </section>;
}

export function SessionProxySessions({ orderId = '' }: { orderId?: string }) {
  const settings = useQuery({ queryKey: ['session-proxy', 'settings'], queryFn: () => api<SessionProxySettings>(), refetchInterval: 10000 });
  const [filters, setFilters] = useState({ search: '', country: '', source: '', status: '', from: '', to: '', session_key: '' }), [offset, setOffset] = useState(0), [expanded, setExpanded] = useState('');
  const query = useQuery({ queryKey: ['session-proxy', 'sessions', filters, orderId, offset], queryFn: () => api<SessionPage<SessionRow>>('/sessions?' + new URLSearchParams({ ...filters, from: filters.from ? new Date(filters.from).toISOString() : '', to: filters.to ? new Date(filters.to).toISOString() : '', order: orderId, offset: String(offset), limit: '25' })), refetchInterval: 10000 });
  const change = (key: keyof typeof filters, value: string) => { setFilters(old => ({ ...old, [key]: value })); setOffset(0); };
  const remaining = (time: string) => time ? `${Math.max(0, Math.ceil((Date.parse(time) - Date.now()) / 60000))} 分钟` : '—';
  return <section className="workspace-band session-directory"><PageHeader title="独立代理会话" description="预留、使用和停止中均占用容量；会话粘性到期后，执行仍需完成收尾。" actions={<Button icon={<RefreshCw size={15} />} onClick={() => void query.refetch()} disabled={query.isFetching}>刷新</Button>} />
    {settings.data && <div className="session-stats"><span>总上限<strong>{settings.data.maxParallel}</strong></span><span>预留 / 使用 / 停止中<strong>{settings.data.counts.reserved || 0} / {settings.data.counts.active || 0} / {settings.data.counts.stopping || 0}</strong></span><span>可新增<strong>{settings.data.available}</strong></span><span>{settings.data.occupied > settings.data.maxParallel ? '等待现有任务完成' : '按账号分配容量'}</span></div>}
    {filters.session_key && <Notice>当前显示同一会话的全部占用区间。<Button onClick={() => change('session_key', '')}>返回全部会话</Button></Notice>}
    <div className="session-actions"><input aria-label="搜索代理会话" placeholder="订单 / 任务 / 账号邮箱 / 出口 IP" value={filters.search} onChange={e => change('search', e.target.value)} /><input aria-label="筛选会话国家" placeholder="国家代码" maxLength={2} value={filters.country} onChange={e => change('country', e.target.value.toUpperCase())} />
      <AppSelect ariaLabel="会话来源" value={filters.source || 'all'} onValueChange={v => change('source', v === 'all' ? '' : v)} options={[{ value: 'all', label: '所有来源' }, { value: 'order', label: '用户订单' }, { value: 'engine', label: '原注册台' }, { value: 'test', label: '连通测试' }]} />
      <AppSelect ariaLabel="会话状态" value={filters.status || 'all'} onValueChange={v => change('status', v === 'all' ? '' : v)} options={[{ value: 'all', label: '所有状态' }, ...Object.entries(states).map(([value, label]) => ({ value, label }))]} />
      <label>开始<input aria-label="开始时间" type="datetime-local" value={filters.from} onChange={e => change('from', e.target.value)} /></label><label>结束<input aria-label="结束时间" type="datetime-local" value={filters.to} onChange={e => change('to', e.target.value)} /></label>
    </div>
    {query.error && <Notice tone="danger">{query.error.message}</Notice>}
    <div className="session-table-scroll"><table className="session-table"><thead><tr><th>订单 / 任务</th><th>地区 / 协议</th><th>出口 IP</th><th>会话</th><th>状态</th><th>到期 / 剩余</th><th>详情</th></tr></thead><tbody>{query.data?.items.map(row => <tr key={row.id}>
      <td><span title={row.order_id || row.task_item_id}>{(row.order_id || row.task_item_id).slice(0, 12)}</span><small>第 {row.attempt_seq} 次尝试 · {row.source === 'order' ? '用户订单' : row.source === 'test' ? '测试' : '原注册台'}</small></td><td>{row.country}<small>IPRoyal · {row.protocol.toUpperCase()}</small></td><td><code>{row.detect_result.exitIp || (row.status === 'reserved' ? '待分配' : '未记录')}</code>{row.detect_result.checkedAt && <small title="出口 IP 检测时间">{formatTime(row.detect_result.checkedAt)}</small>}</td><td><code>{row.session || '等待生成'}</code></td><td>{states[row.status] || row.status}</td><td>{formatTime(row.expires_at)}<small>{remaining(row.expires_at)}</small></td>
      <td><Button onClick={() => setExpanded(expanded === row.id ? '' : row.id)}>{expanded === row.id ? '收起' : '查看详情'}</Button>{row.intervals > 1 && <Button onClick={() => change('session_key', row.session_key)}>同会话 {row.intervals} 次占用</Button>}{expanded === row.id && <dl className="session-detail"><dt>订单</dt><dd>{row.order_id || '—'}</dd><dt>运行任务</dt><dd>{row.run_id || '—'}</dd><dt>发起用户</dt><dd>{row.initiated_by || '—'}</dd><dt>逻辑任务</dt><dd>{row.task_item_id}</dd><dt>账号资产</dt><dd>{row.final_account_id || '—'}</dd><dt>预留时间</dt><dd>{formatTime(row.created_at)}</dd><dt>分配时间</dt><dd>{formatTime(row.activated_at)}</dd><dt>结束时间</dt><dd>{formatTime(row.ended_at)}</dd><dt>检测</dt><dd>{row.detect_result.exitIp || '未检测'} {row.detect_result.latencyMs != null ? `${row.detect_result.latencyMs} ms` : ''}</dd><dt>最近错误</dt><dd>{row.last_error || '无'}</dd></dl>}</td>
    </tr>)}</tbody></table>{query.data?.total === 0 && <p>暂无符合条件的会话记录。</p>}</div>
    <Pagination label="会话记录分页" total={query.data?.total || 0} offset={offset} limit={25} busy={query.isFetching} onChange={setOffset} />
  </section>;
}
