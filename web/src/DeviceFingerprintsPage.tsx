import { Fragment, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronDown, Copy, Fingerprint, LoaderCircle, RefreshCw, Search } from 'lucide-react';
import { endpoints } from './api';
import { Button, EmptyState, Notice, PageHeader, copyText, errorMessage, formatTime } from './components/ConsoleUi';
import { Pagination, CONSOLE_PAGE_SIZE } from './components/Pagination';
import type { DeviceFingerprint, DeviceFingerprintFilter } from './device-fingerprint-types';
import './device-fingerprints.css';

function DeviceDetails({ item }: { item: DeviceFingerprint }) {
  const p = item.profile;
  const size = (w?: number, h?: number) => w && h ? `${w} × ${h}` : '未记录';
  const fields = [
    ['资产 ID', item.id], ['来源任务', item.sourceRunId],
    ['User-Agent', p.userAgent], ['操作系统', p.oscpu || p.platform],
    ['语言列表', p.languages.join(', ')], ['Accept-Language', p.acceptLanguage],
    ['时区', p.timeZone], ['CPU 线程', p.hardwareConcurrency],
    ['屏幕分辨率', size(p.screen.width, p.screen.height)],
    ['可用屏幕', size(p.screen.availWidth, p.screen.availHeight)],
    ['窗口内部尺寸', size(p.viewport.innerWidth, p.viewport.innerHeight)],
    ['窗口外部尺寸', size(p.viewport.outerWidth, p.viewport.outerHeight)],
    ['像素缩放比', p.viewport.devicePixelRatio], ['颜色深度', p.screen.colorDepth],
    ['GPU 厂商', p.gpu.vendor], ['GPU 渲染器', p.gpu.renderer],
    ['最大触点', p.maxTouchPoints],
    ['存储配额', p.storageQuotaBytes === null ? null : `${(p.storageQuotaBytes / 1024 ** 3).toFixed(0)} GiB`],
    ['指纹配置版本', p.schemaVersion],
  ];
  return <div className="device-detail"><h3>{item.email || item.id} 的设备配置</h3><dl>{fields.map(([label, value]) => <div key={String(label)}><dt>{label}</dt><dd>{value === null || value === undefined || value === '' ? '未记录' : value}</dd></div>)}</dl></div>;
}

export function DeviceFingerprintsPage() {
  const [draft, setDraft] = useState('');
  const [search, setSearch] = useState('');
  const [match, setMatch] = useState<DeviceFingerprintFilter>('all');
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState('');
  const [notice, setNotice] = useState<{ tone: string; text: string } | null>(null);
  const query = useQuery({
    queryKey: ['device-fingerprints', search, match, offset],
    queryFn: () => endpoints.deviceFingerprints({ q: search, match, offset, limit: CONSOLE_PAGE_SIZE }),
    placeholderData: keepPreviousData,
  });
  const data = query.data, summary = data?.summary;
  const applySearch = (value: string) => { setDraft(value); setSearch(value.trim()); setOffset(0); setExpanded(''); };
  const related = (value: string) => { setMatch('all'); applySearch(value); };
  const copy = async (value: string, name: string) => {
    try { await copyText(value); setNotice({ tone: 'success', text: `${name}已复制` }); }
    catch { setNotice({ tone: 'danger', text: '复制失败，请选择完整内容手动复制。' }); }
  };
  const identity = (value: string, label: string, count: number) => <div className="device-identity">
    <div><code>{value || '未记录'}</code>{value && <button type="button" className="device-copy" aria-label={`复制${label} ${value}`} onClick={() => void copy(value, label)}><Copy size={14} /></button>}</div>
    {count > 1 && <button type="button" className="device-duplicate" onClick={() => related(value)}>重复 · {count} 个账号</button>}
  </div>;
  return <div className="device-fingerprints-page">
    <PageHeader title="设备指纹" description="查询每个账号保存的浏览器指纹与设备 ID" actions={<Button icon={query.isFetching ? <LoaderCircle size={16} className="spin" /> : <RefreshCw size={16} />} disabled={query.isFetching} onClick={() => void query.refetch()}>刷新</Button>} />
    <div className="device-summary" aria-label="全库设备统计">
      <div className="panel"><span>账号记录</span><strong>{summary?.total ?? '—'}</strong><small>包含已卖出与归档账号</small></div>
      <div className="panel"><span>不同指纹</span><strong>{summary?.uniqueFingerprints ?? '—'}</strong><small>按已保存的完整指纹哈希统计</small></div>
      <div className="panel"><span>指纹重复账号</span><strong className={summary?.duplicateFingerprintAccounts ? 'device-warning' : ''}>{summary?.duplicateFingerprintAccounts ?? '—'}</strong><small>{summary?.duplicateFingerprintGroups ?? 0} 组相同指纹</small></div>
      <div className="panel"><span>不同设备 ID</span><strong>{summary?.uniqueDeviceIds ?? '—'}</strong><small>{summary?.duplicateDeviceAccounts ?? 0} 个账号的设备 ID 重复</small></div>
    </div>
    <p className="device-explanation">指纹与设备 ID 分别统计，设备 ID 不同不代表指纹不同。点击重复标记可查询相关账号。注册地区来自保存的代理配置，不代表已核验实际出口 IP。</p>
    {notice && <Notice tone={notice.tone} onClose={() => setNotice(null)}>{notice.text}</Notice>}
    {query.error && <Notice tone="danger">读取失败：{errorMessage(query.error)}。请点击刷新重试。</Notice>}
    {!!summary?.unreadable && <Notice tone="warning">有 {summary.unreadable} 条账号记录暂时无法读取，重复统计可能不完整。</Notice>}
    <section className="panel device-list">
      <form className="device-toolbar" onSubmit={event => { event.preventDefault(); applySearch(draft); }}>
        <label className="device-search"><Search size={17} /><input aria-label="搜索设备指纹" maxLength={256} placeholder="邮箱、指纹、设备 ID、地区或任务 ID" value={draft} onChange={event => setDraft(event.target.value)} /></label>
        <select aria-label="设备记录筛选" value={match} onChange={event => { setMatch(event.target.value as DeviceFingerprintFilter); setOffset(0); setExpanded(''); }}>
          <option value="all">全部记录</option><option value="fingerprint">仅指纹重复</option><option value="device">仅设备 ID 重复</option><option value="missing">信息缺失</option>
        </select>
        <Button type="submit" tone="primary">查询</Button>
        {(search || match !== 'all') && <Button type="button" tone="quiet" onClick={() => { setMatch('all'); applySearch(''); }}>重置</Button>}
      </form>
      <p className="device-list-note">每页 50 条，按创建时间倒序。顶部为全库统计，筛选只影响下方列表。{query.isFetching && <span role="status"> 正在加载…</span>}</p>
      <div className="device-table-scroll" aria-busy={query.isFetching} inert={query.isPlaceholderData || undefined}>
        <table className="device-table"><thead><tr><th>账号邮箱</th><th>浏览器指纹</th><th>设备 ID</th><th>注册地区 / 浏览器</th><th>创建时间</th><th>操作</th></tr></thead>
          <tbody>{data?.items.map(item => <Fragment key={item.id}>
            <tr><td><strong className="device-email">{item.email || '邮箱未记录'}</strong><span className="device-row-note">{item.archived ? '已归档' : item.lifecycle === 'sold' ? '已卖出' : '在库'}{item.status === 'corrupt' ? ' · 读取异常' : ''}</span></td>
              <td>{identity(item.fingerprint, '指纹', item.fingerprintAccounts)}</td><td>{identity(item.deviceId, '设备 ID', item.deviceAccounts)}</td>
              <td><span>{item.countryCode || '未记录'}</span><span className="device-row-note">{[item.profile.browser, item.profile.browserVersion].filter(Boolean).join(' ') || '浏览器未记录'}</span><span className="device-row-note">{item.profile.timeZone || '时区未记录'}</span></td>
              <td className="device-time">{formatTime(item.createdAt)}</td>
              <td><Button tone="quiet" aria-label={`${expanded === item.id ? '收起' : '查看'} ${item.email || item.id} 的设备详情`} aria-expanded={expanded === item.id} onClick={() => setExpanded(expanded === item.id ? '' : item.id)} icon={<ChevronDown size={14} className={expanded === item.id ? 'device-chevron-open' : ''} />}>{expanded === item.id ? '收起' : '详情'}</Button></td>
            </tr>
            {expanded === item.id && <tr><td colSpan={6}><DeviceDetails item={item} /></td></tr>}
          </Fragment>)}</tbody></table>
      </div>
      {!query.isLoading && !query.error && data?.items.length === 0 && <EmptyState icon={<Fingerprint size={24} />} title="没有匹配的账号" detail="可修改搜索条件，或等待账号资料保存后刷新。" />}
      <Pagination label="设备指纹分页" total={data?.total || 0} offset={data?.offset ?? offset} limit={CONSOLE_PAGE_SIZE} busy={query.isFetching} onChange={value => { setOffset(value); setExpanded(''); }} />
    </section>
  </div>;
}
