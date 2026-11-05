import { Pagination } from './components/Pagination';
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, LoaderCircle, Mail, Play, Plus, Repeat, Settings2, ShieldCheck, Square, Trash2 } from 'lucide-react';

import { endpoints } from './api';
import { AppSelect } from './components/AppSelect';
import { Button, ConfigNumberInput, EmptyState, Notice, PageHeader, StatusBadge, errorMessage, formatTime } from './components/ConsoleUi';
import { useRangeSelection } from './components/useRangeSelection';
import { MAX_WORKER_CONCURRENCY, countryPoolAssignments, maintenanceProxyAssignments } from './run-plan-ui';
import { Link } from './router';
import { RebindAssetPicker } from './RebindAssetPicker';
import { RebindProgress, retryLabel, stageLabel } from './RebindProgress';
import { summarizeRebindAdd, takeRebindPending } from './rebind-handoff';
import type { RebindQueue, RebindQueueAccount, RebindResult } from './types';

const MAINTENANCE_MODE = 'maintenance';
const LOGIN_OPTIONS = [
  { value: 'auto', label: '失效时自动登录' },
  { value: 'always', label: '每次重新登录' },
  { value: 'never', label: '仅用已有登录态' },
];

function resultTone(status: string) {
  return status === 'ok' ? 'complete' : ['needs_refresh', 'needs_review', 'upsert_fail'].includes(status) ? 'partial' : 'error';
}

function resultLabel(result: RebindResult) {
  if (result.status === 'ok') return '换绑成功';
  if (result.status === 'needs_refresh' && result.stage === 'change_reauth') return '未换绑 · 授权验证失败';
  if (result.status === 'needs_refresh') return result.changeConfirmed ? '已确认换绑·需刷新登录态' : '需刷新登录态';
  if (result.status === 'upsert_fail') return result.changeConfirmed ? '已换绑·写回失败' : '状态写回失败';
  if (result.status === 'needs_review') return '结果待核对';
  if (result.changeConfirmed) return '已确认换绑·需核对';
  return `失败·${stageLabel(result.stage)}`;
}

export function RebindPage() {
  const client = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [provider, setProvider] = useState('');
  const [concurrency, setConcurrency] = useState(3);
  const [proxyMode, setProxyMode] = useState(MAINTENANCE_MODE);
  const [loginMode, setLoginMode] = useState('auto');
  const [proxyRetries, setProxyRetries] = useState(2);
  const [otpRetries, setOtpRetries] = useState(1);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [notice, setNotice] = useState<{ tone: string; text: string } | null>(null);

  const providers = useQuery({ queryKey: ['rebind-providers'], queryFn: endpoints.rebindProviders });
  const proxies = useQuery({ queryKey: ['proxies'], queryFn: endpoints.proxies });
  const [resultOffset, setResultOffset] = useState(0);
  const status = useQuery({
    queryKey: ['rebind-status', resultOffset], queryFn: () => endpoints.rebindStatusPage(resultOffset),
    refetchInterval: (query) => query.state.data?.running || query.state.data?.starting ? 1500 : 8000,
  });
  const [offset, setOffset] = useState(0);
  const queue = useQuery({ queryKey: ['rebind-queue', offset], queryFn: () => endpoints.rebindQueuePage(offset) });
  const accounts = useMemo(() => queue.data?.accounts || [], [queue.data]);
  const ids = useMemo(() => accounts.map((asset) => asset.id), [accounts]);
  const selectedIds = ids.filter((id) => selected.has(id));
  const running = status.data?.running === true;
  const preparing = status.data?.starting === true;
  const stopping = running && status.data?.stopRequested === true;
  const effectiveConcurrency = Math.max(1, Math.min(concurrency, (queue.data?.total ?? accounts.length) || 1));
  const proxyAssignments = proxyMode === MAINTENANCE_MODE ? maintenanceProxyAssignments(effectiveConcurrency) : countryPoolAssignments(effectiveConcurrency, proxyMode);
  const rangeSelection = useRangeSelection({ keys: ids, selected, setSelected });

  useEffect(() => {
    setSelected((current) => {
      const next = new Set(ids.filter((id) => current.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [ids]);
  useEffect(() => {
    if (!provider) setProvider(providers.data?.providers.find((item) => item.configured)?.id || '');
  }, [providers.data, provider]);

  // Completion also invalidates a queue cached while this page was closed.
  useEffect(() => {
    if (!status.data?.startedAt) return;
    void client.invalidateQueries({ queryKey: ['rebind-queue'] });
    if (!running) {
      void client.invalidateQueries({ queryKey: ['session-assets'] });
      void client.invalidateQueries({ queryKey: ['rebind-picker'] });
    }
  }, [client, status.data?.startedAt, status.data?.done, running]);

  useEffect(() => {
    const snapshot = status.data;
    if (!snapshot?.running) return;
    setProvider(snapshot.provider);
    setConcurrency(snapshot.workerConcurrency);
    setLoginMode(snapshot.autoRefresh === false ? 'never' : snapshot.alwaysFreshLogin ? 'always' : 'auto');
    setProxyRetries(snapshot.proxyRetries ?? 2);
    setOtpRetries(snapshot.otpRetries ?? 1);
    const assignment = snapshot.proxyAssignments?.[0];
    if (assignment) setProxyMode(assignment.kind === 'countryPool' ? assignment.countryCode : MAINTENANCE_MODE);
  }, [status.data?.startedAt, running]);

  const applyQueue = async (next: RebindQueue) => {
    await client.cancelQueries({ queryKey: ['rebind-queue'] });
    client.setQueryData(['rebind-queue'], next);
  };
  const onError = (error: unknown) => setNotice({ tone: 'error', text: errorMessage(error) });
  const add = useMutation({
    mutationFn: endpoints.rebindQueueAdd,
    onSuccess: async (result) => { await applyQueue(result); setNotice(summarizeRebindAdd(result)); },
    onError,
  });
  const remove = useMutation({
    mutationFn: (assetIds: string[] | null) => assetIds === null ? endpoints.rebindQueueClear() : endpoints.rebindQueueRemove(assetIds),
    onSuccess: applyQueue,
    onError,
  });
  const addPending = add.mutate;
  useEffect(() => {
    const pending = takeRebindPending();
    if (pending.length) addPending(pending.map((asset) => asset.id));
  }, [addPending]);

  const start = useMutation({
    mutationFn: async (requestedIds: string[] | null) => {
      const assetIds = requestedIds || (await endpoints.rebindQueueIds()).ids;
      const workerConcurrency = Math.max(1, Math.min(concurrency, assetIds.length));
      const assignments = proxyMode === MAINTENANCE_MODE ? maintenanceProxyAssignments(workerConcurrency) : countryPoolAssignments(workerConcurrency, proxyMode);
      return endpoints.startRebind({ assetIds, provider, workerConcurrency, proxyAssignments: assignments, autoRefresh: loginMode !== 'never', alwaysFreshLogin: loginMode === 'always', proxyRetries, otpRetries });
    },
    onSuccess: async (result) => {
      setNotice({ tone: 'success', text: `已启动 ${result.total} 个账号，${result.workerConcurrency} 并发` });
      await client.invalidateQueries({ queryKey: ['rebind-status'] });
    },
    onError,
  });
  const stop = useMutation({
    mutationFn: endpoints.stopRebind,
    onSuccess: async () => {
      setNotice({ tone: 'info', text: '已请求停止领取后续账号，当前账号处理结束后停止。' });
      await client.invalidateQueries({ queryKey: ['rebind-status'] });
    },
    onError,
  });
  const check = useMutation({
    mutationFn: () => endpoints.rebindPreflight({ provider, workerConcurrency: effectiveConcurrency, count: queue.data?.total ?? accounts.length, proxyAssignments, probe: true }),
    onSuccess: (snapshot) => {
      const probe = snapshot.proxy.probe;
      const failure = probe?.results.find((item) => item.status !== 'healthy');
      setNotice(!probe?.total
        ? { tone: 'warning', text: '没有可预检的代理，请检查代理池。' }
        : { tone: probe.failed ? (probe.healthy ? 'warning' : 'error') : 'success', text: `代理抽检可用 ${probe.healthy}/${probe.total}${failure ? ` · ${failure.message || '部分代理连接失败'}` : ''} · 启动时按 Worker 检测设置筛选实际节点` });
    },
    onError,
  });

  const locked = running || preparing || start.isPending;
  const queueBusy = add.isPending || remove.isPending;
  const dataError = [status, queue, providers, proxies].find((query) => query.isError);
  const loading = [status, queue, providers, proxies].some((query) => query.isPending);
  const providerOptions = (providers.data?.providers || []).map((item) => ({ value: item.id, label: `${item.label}${item.configured ? '' : '（未配置）'}`, disabled: !item.configured }));
  const pools = proxies.data?.dynamic?.countryPools || [];
  const proxyOptions = [
    { value: MAINTENANCE_MODE, label: '维护代理' },
    ...pools.filter((pool) => pool.total > 0).map((pool) => ({ value: pool.countryCode, label: `${pool.countryCode} · ${pool.total} 条` })),
  ];
  const providerLabel = (value: string) => providers.data?.providers.find((item) => item.id === value)?.label || value || '未选择接口';
  const disabledReasonFor = (targets: RebindQueueAccount[]) => {
    if (loading) return '正在加载配置与队列…';
    if (dataError) return '数据加载失败，请重试';
    if (queueBusy) return '正在更新队列…';
    if (!targets.length) return '加入 iCloud 账号后即可启动';
    if (!providers.data?.providers.some((item) => item.id === provider && item.configured)) return '请选择已配置的邮箱接口';
    if (proxyMode !== MAINTENANCE_MODE && !pools.some((pool) => pool.countryCode === proxyMode && pool.total > 0)) return '所选代理池暂无可用代理';
    const unusable = targets.filter((asset) => !asset.hasAccessToken && (loginMode === 'never' || !asset.canRefresh)).length;
    if (unusable) return `${unusable} 个账号缺少可用登录态，请刷新或移出队列`;
    const missingCredentials = loginMode === 'always' ? targets.filter((asset) => !asset.canRefresh).length : 0;
    return missingCredentials ? `${missingCredentials} 个账号缺少密码或 TOTP，无法每次重新登录` : '';
  };
  const startDisabledReason = disabledReasonFor(accounts);
  const runningIds = useMemo(() => new Set(status.data?.assetIds || ids), [status.data?.assetIds, ids]);
  const latestResults = useMemo(() => status.data?.resultsPage ? status.data.results : [...(status.data?.results || [])].reverse(), [status.data]);
  const resultByAsset = useMemo(() => new Map((status.data?.results || []).map((result) => [result.assetId, result])), [status.data?.results]);
  const activeByAsset = useMemo(() => new Map((status.data?.active || []).map((item) => [item.assetId, item])), [status.data?.active]);
  const liveActiveResults = useMemo(() => (status.data?.active || [])
    .filter((item) => Boolean(item.newEmail) && !resultByAsset.has(item.assetId)), [resultByAsset, status.data?.active]);
  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  return <div className="rebind-page">
    <PageHeader title="换绑" description="换绑后使用同一代理刷新登录态，测活通过后完成。" actions={
      running
        ? <Button tone="danger" icon={stopping || stop.isPending ? <LoaderCircle className="spin" size={16} /> : <Square size={16} />} onClick={() => stop.mutate()} disabled={stopping || stop.isPending}>{stopping ? '正在停止…' : '停止任务'}</Button>
        : <Button tone="primary" icon={locked ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />} onClick={() => start.mutate(null)} disabled={locked || Boolean(startDisabledReason) || check.isPending} title={startDisabledReason || '处理队列中的全部账号'}>{locked ? '准备中…' : '启动全部'}</Button>
    } />
    {notice && <Notice tone={notice.tone} floating onClose={() => setNotice(null)} autoDismissToken={notice}>{notice.text}</Notice>}
    {dataError && <Notice tone="error">加载失败：{errorMessage(dataError.error)} <Button tone="quiet" onClick={() => { for (const query of [status, queue, providers, proxies]) if (query.isError) void query.refetch(); }}>重试</Button></Notice>}

    <section className="rebind-configbar" aria-label="换绑配置">
      <div className="rebind-config-main">
        <div className="rebind-field"><span>新邮箱接口</span><AppSelect ariaLabel="换绑目标邮箱接口" value={provider} onValueChange={setProvider} options={providerOptions} disabled={locked || check.isPending} /></div>
        <div className="rebind-field"><span>代理</span><AppSelect ariaLabel="代理池配置" value={proxyMode} onValueChange={setProxyMode} options={proxyOptions} disabled={locked || check.isPending} /></div>
        <label className="rebind-field"><span>并发</span><ConfigNumberInput aria-label="换绑并发" min={1} max={MAX_WORKER_CONCURRENCY} value={concurrency} onValueChange={setConcurrency} disabled={locked || check.isPending} /></label>
        <Button tone="quiet" icon={check.isPending ? <LoaderCircle className="spin" size={15} /> : <ShieldCheck size={15} />} onClick={() => check.mutate()} disabled={locked || loading || check.isPending}>检测代理</Button>
        <Link className="button button-default rebind-proxy-button" to="/proxies"><Settings2 size={15} />管理代理</Link>
      </div>
      <details className="rebind-advanced">
        <summary>高级设置 <span>{LOGIN_OPTIONS.find((option) => option.value === loginMode)?.label} · 换邮箱 {otpRetries} 次 · 同代理重试 {proxyRetries} 次</span></summary>
        <div className="rebind-config-main">
          <div className="rebind-field"><span>换绑前登录策略</span><AppSelect ariaLabel="登录策略" value={loginMode} onValueChange={setLoginMode} options={LOGIN_OPTIONS} disabled={locked} /></div>
          <label className="rebind-field"><span>同代理连接重试</span><ConfigNumberInput aria-label="同代理连接重试次数" min={0} max={5} value={proxyRetries} onValueChange={setProxyRetries} disabled={locked} /></label>
          <label className="rebind-field"><span>收码异常换邮箱</span><ConfigNumberInput aria-label="收码异常更换邮箱次数" min={0} max={5} value={otpRetries} onValueChange={setOtpRetries} disabled={locked} /></label>
          <span className="rebind-hint">国家池在登录前筛选代理，通过后全程固定同一节点。收件人不匹配或超时即换邮箱。换绑后自动登录需已保存密码和 TOTP。</span>
        </div>
      </details>
      {!locked && <p className="rebind-config-hint">{startDisabledReason || `可在账号卡片上单个启动，或启动全部 ${accounts.length} 个账号（${effectiveConcurrency} 并发）。`}</p>}
    </section>

    {status.data?.error && <Notice tone="error">换绑任务异常：{status.data.error}</Notice>}
    {status.data?.historyWarning && <Notice tone="warning">{status.data.historyWarning}</Notice>}

    <div className="rebind-body">
      <section className="rebind-panel" aria-label="待处理账号">
        <header className="rebind-panel-head">
          <div><h2>待处理 <span className="rebind-count" aria-label={`${accounts.length} 个账号`}>{accounts.length}</span></h2><small>iCloud · 首次入库满 24h</small></div>
          <Button tone="quiet" icon={<Plus size={15} />} onClick={() => setPickerOpen(true)} disabled={locked || queueBusy || queue.isPending}>加入账号</Button>
        </header>
        <div className="rebind-selbar">
          <label><input type="checkbox" aria-label="全选待处理账号" checked={ids.length > 0 && selectedIds.length === ids.length} disabled={locked || queueBusy || !ids.length} onChange={() => setSelected(selectedIds.length === ids.length ? new Set() : new Set(ids))} />{selectedIds.length ? `已选 ${selectedIds.length}` : '全选本页'}</label>
          <div className="rebind-selbar-actions">
            <Button tone="quiet" icon={<Trash2 size={14} />} onClick={() => remove.mutate(selectedIds)} disabled={!selectedIds.length || locked || queueBusy}>移除</Button>
            <button type="button" className="rebind-link-btn" onClick={() => remove.mutate(null)} disabled={!ids.length || locked || queueBusy}>清空</button>
          </div>
        </div>
        <div className={`rebind-cards${rangeSelection.dragging ? ' rebind-range-selecting' : ''}`} {...rangeSelection.containerProps} aria-busy={queue.isFetching || queueBusy}>
          {queue.isPending ? <div className="loading-line">正在读取队列…</div> : accounts.length ? accounts.map((asset, index) => {
            const result = resultByAsset.get(asset.id);
            const active = activeByAsset.get(asset.id);
            const picked = selected.has(asset.id);
            const singleDisabledReason = disabledReasonFor([asset]);
            const startingThis = start.isPending && start.variables?.includes(asset.id);
            const scheduled = running && runningIds.has(asset.id);
            return <div key={asset.id} className={`rebind-card${picked ? ' selected' : ''}${rangeSelection.isInRange(index) ? ' in-range' : ''}`}>
              <div className="rebind-card-select" role="checkbox" aria-label={asset.email} aria-checked={picked} aria-disabled={locked || queueBusy} tabIndex={locked || queueBusy ? -1 : 0}
                {...(!locked && !queueBusy ? rangeSelection.rowProps(index) : {})}
                onClick={() => { if (!locked && !queueBusy) toggle(asset.id); }}
                onKeyDown={(event) => { if (!locked && !queueBusy && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); toggle(asset.id); } }}>
                <div className="rebind-card-heading"><span className="rebind-check" aria-hidden="true">{picked ? '✓' : ''}</span><strong>{asset.email}</strong>
                  <StatusBadge status={active ? 'running' : result ? resultTone(result.status) : asset.hasAccessToken ? 'pending' : 'missing'} label={active ? stageLabel(active.stage) : result ? resultLabel(result) : asset.hasAccessToken ? '待处理' : asset.canRefresh && loginMode !== 'never' ? '需自动登录' : '需刷新登录态'} />
                </div>
                <small className="rebind-hint">入库 {formatTime(asset.createdAt)}{asset.planType && asset.planType !== 'unknown' ? ` · ${asset.planType}` : ''}</small>
              </div>
              {(active || (scheduled && !result)) && <RebindProgress active={active} email={asset.email} collapsed />}
              {result?.error && <div className="rebind-card-error">{result.error}</div>}
              <div className="rebind-card-actions">
                {running && !scheduled && <span className="rebind-hint">未加入本次任务</span>}
                <Button tone="quiet" aria-label={`启动 ${asset.email}`} icon={active || startingThis ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />} title={singleDisabledReason || '仅处理这个账号'} disabled={locked || Boolean(singleDisabledReason) || check.isPending} onClick={() => start.mutate([asset.id])}>{active ? '处理中' : startingThis ? '启动中…' : '启动'}</Button>
              </div>
            </div>;
          }) : <EmptyState icon={<KeyRound size={24} />} title={queue.isError ? '队列读取失败' : '暂无待处理账号'} detail={queue.isError ? '请重试加载队列。' : '点击右上角「加入账号」，浏览选择或粘贴邮箱。'} />}
        </div>
        <Pagination label="换绑队列分页" total={queue.data?.total ?? accounts.length} offset={offset} busy={queue.isFetching || locked} onChange={setOffset} />
      </section>

      <section className="rebind-panel" aria-label="换绑结果">
        <header className="rebind-panel-head"><div><h2>换绑结果</h2><small>{liveActiveResults.length ? `正在处理 ${liveActiveResults.length} 条${latestResults.length ? ` · 最近 ${latestResults.length} 条` : ''}` : latestResults.length ? `本页 ${latestResults.length} 条 · 最新在前` : '新邮箱在执行时领取'}</small></div><span className="rebind-provider-chip"><Mail size={14} />{providerLabel(status.data?.total ? status.data.provider : provider)}</span></header>
        <div className="rebind-result-stats" role="group" aria-label="换绑结果统计">
          <span>总计 <strong>{status.data?.total ?? 0}</strong></span>
          <span className="ok">成功 <strong>{status.data?.ok ?? 0}</strong></span>
          <span className="fail">失败 <strong>{status.data?.fail ?? 0}</strong></span>
          <span>未完成 <strong>{Math.max(0, (status.data?.total ?? 0) - (status.data?.done ?? 0))}</strong></span>
        </div>
        <div className="rebind-results">
          {status.data?.startedAt && <div className="rebind-result-note">{running ? '本次任务' : '最近完成任务'} · {formatTime(status.data.startedAt)}</div>}
          {liveActiveResults.map((active) => {
            return <div key={`active-${active.assetId}`} className="rebind-result-row rebind-result-live">
              <div className="rebind-result-heading"><StatusBadge status="running" label="进行中" /><span className="rebind-hint">{active.stage === 'post_login_refresh' ? '换绑已确认，正在恢复登录态' : '正在处理'}</span></div>
              <div className="rebind-result-emails"><span className="from">{active.email}</span><Repeat size={13} /><span className="to">{active.newEmail}</span></div>
              <RebindProgress active={active} email={active.newEmail || active.email} compact collapsed />
            </div>;
          })}
          {latestResults.length ? latestResults.map((result, index) => <div key={`${result.assetId}-${result.at}-${index}`} className={`rebind-result-row ${resultTone(result.status)}`}>
            <div className="rebind-result-heading"><StatusBadge status={resultTone(result.status)} label={resultLabel(result)} /><time className="rebind-hint">{formatTime(result.at)}</time></div>
            <div className="rebind-result-emails"><span className="from">{result.previousEmail || result.assetId}</span><Repeat size={13} /><span className="to">{result.newEmail || '未领取新邮箱'}</span></div>
            {result.postRefreshed && <div className="rebind-result-note">已使用原代理刷新登录态{result.status === 'ok' ? ' · 测活通过 · 已保存' : ''}</div>}
            {result.proxy && <div className="rebind-result-note">固定代理：{result.proxy}</div>}
            {result.rebindProxy?.endpoint && <div className="rebind-result-note">换绑国家 / IP：{result.rebindProxy.countryCode || '未记录国家'} · {result.rebindProxy.endpoint}</div>}
            {Boolean(result.mailboxRetries?.length) && <div className="rebind-result-note">{[...new Set(result.mailboxRetries!.map((retry) => retryLabel(retry.reason)))].join('、')} · 共尝试 {result.mailboxAttempts} 个邮箱</div>}
            {result.stage === 'change_reauth' && <div className="rebind-result-note">领取邮箱后，提交换绑时要求重新登录；授权验证未通过，尚未确认换绑。</div>}
            {result.failure && <div className="rebind-result-note">失败步骤：{stageLabel(result.stage)} / {result.failure.step} · {result.failure.code}{result.failure.httpStatus ? ` · HTTP ${result.failure.httpStatus}` : ''}</div>}
            {Boolean(result.attemptErrors?.length) && <details className="rebind-result-note"><summary>同代理连接重试 {result.attemptErrors!.length} 次</summary>{result.attemptErrors!.map((attempt) => <div key={attempt.attempt}>第 {attempt.attempt} 次 · {stageLabel(attempt.stage)} · {attempt.code}：{attempt.error}</div>)}</details>}
            {result.error && <div className="rebind-card-error">{result.error}</div>}
            {result.warning && <div className="rebind-result-warning">{result.warning}</div>}
          </div>) : null}
          {!liveActiveResults.length && !latestResults.length && <EmptyState icon={<Mail size={24} />} title={running ? '正在处理…' : '暂无换绑结果'} detail={running ? '账号处理完成后将在此显示。' : '选择邮箱接口，加入账号后启动。'} />}
        </div>
        <Pagination label="换绑结果分页" total={status.data?.resultsPage?.total ?? latestResults.length} offset={resultOffset} busy={status.isFetching} onChange={setResultOffset} />
      </section>
    </div>
    {pickerOpen && !locked && <RebindAssetPicker queuedIds={ids} onClose={() => setPickerOpen(false)} onAdd={add.mutateAsync} />}
  </div>;
}
