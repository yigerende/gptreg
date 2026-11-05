import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Dialog, Switch } from 'radix-ui';
import { Bot, CheckCircle2, CircleAlert, Clock3, ExternalLink, FileJson, ListChecks, LoaderCircle, Pause, Play, RefreshCw, Save, Settings2, TimerReset, Trash2, XCircle, Zap } from 'lucide-react';

import { endpoints } from './api';
import { Button, ConfigNumberInput, ConfirmDialog, EmptyState, IconButton, Notice, PageHeader, StatusBadge, errorMessage, formatTime, statusTone } from './components/ConsoleUi';
import { AppSelect } from './components/AppSelect';
import { jobResultLabel } from './task-labels';
import type { RegistrationRobotConfig, RegistrationSchedule, RegistrationTemplate, RobotRecord, RobotRun, RobotSnapshot } from './types';
import { Link } from './router';

const MAX_VISIBLE_ROBOT_RUNS = 60;
type RobotCountryPool = { countryCode: string; total: number };
const REGISTRATION_MAIL_OPTIONS = [
  { value: 'xiaopingguo', label: 'Xiaopingguo' },
  { value: 'smsbower', label: 'SMSBower' },
  { value: 'mailcom', label: 'Mail.com' },
  { value: 'fastmail', label: 'Fastmail' },
  { value: 'icloud', label: 'iCloud' },
];
/** Matches MAX_TEMPLATES in registration-template.js. */
const MAX_REGISTRATION_TEMPLATES = 12;

function intervalLabel(intervalMs: number) {
  const minutes = Math.max(1, Math.round(Number(intervalMs || 0) / 60_000));
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

function statusLabel(status: string) {
  if (status === 'stopping') return '停止中';
  return ({
    running: '执行中',
    waiting: '等待任务',
    scheduled: '已启用',
    success: '已完成',
    partial: '部分完成',
    failed: '失败',
    cancelled: '已取消',
    idle: '已停止',
  } as Record<string, string>)[status] || status || '未知';
}

function runReasonLabel(reason: string) {
  return ({ interval: '周期', start: '启动', run_now: '手动', task_recovery: '任务恢复' } as Record<string, string>)[reason] || reason || '命令';
}

function robotTaskKindLabel(taskKind: string | undefined) {
  return ({
    register_session: '注册并保存登录态',
    register_oauth: '注册后 OAuth',
    oauth: '凭据 OAuth',
    session_refresh: '登录态刷新',
  } as Record<string, string>)[String(taskKind || '')] || taskKind || '任务';
}

function runResultLabel(run: RobotRun) {
  if (run.status === 'running') return '正在处理';
  if (run.error) return run.error;
  const result = run.result;
  if (result?.iterations !== undefined || result?.refreshes !== undefined) {
    const rounds = result.iterations !== undefined
      ? `${result.completedIterations || 0}/${result.iterations} 轮`
      : '';
    const refreshes = result.refreshes !== undefined ? `刷新 ${result.refreshes} 次` : '';
    const scope = result.countryCode || (result.proxyMode === 'local'
      ? '本地代理'
      : (result.proxyDistribution === 'capacity' ? '按容量均分' : '代理'));
    const summary = [`注册 ${result.succeeded || 0}/${result.requested || 0}`, rounds, refreshes, scope].filter(Boolean).join(' · ');
    return result.reason ? `${summary} · ${result.reason}` : summary;
  }
  if (result?.reason) return result.reason;
  if (result?.skipped === 'no_sources') return '没有可刷新的 API 来源';
  if (result?.deletedBanned !== undefined || result?.archivedSettled !== undefined) {
    const parts = [
      result.deletedBanned ? `清空封禁组 ${result.deletedBanned}` : '',
      result.archivedSettled ? `归档已结算 ${result.archivedSettled}` : '',
    ].filter(Boolean);
    return parts.length ? parts.join(' · ') : '没有需要清理或归档的账号';
  }
  if (result?.runId && Number.isFinite(Number(result.requested))) {
    return `注册 ${result.succeeded || 0}/${result.requested} · ${result.countryCode || '国家池'}`;
  }
  if (result && Number.isFinite(Number(result.pulled))) {
    return `${result.pulled || 0} 条代理 · ${result.succeeded || 0}/${result.requested || 0} 来源成功`;
  }
  return run.status === 'success' ? '命令已完成' : '部分来源未完成';
}

export function durationLabel(durationMs: number | undefined) {
  const seconds = Math.max(0, Math.round(Number(durationMs || 0) / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

type RobotSummaryItem = { label: string; value: string; detail: string };

function robotRunSummaryItems(run: RobotRun): RobotSummaryItem[] {
  const result = run.result;
  if (!result) return [];
  if (result.deletedBanned !== undefined || result.archivedSettled !== undefined) {
    return [
      { label: '封禁组清理', value: String(result.deletedBanned || 0), detail: '已注销/封禁分类' },
      { label: '归档已结算', value: String(result.archivedSettled || 0), detail: '已卖出且锁定满 24 小时' },
    ];
  }
  if (result.iterations !== undefined || result.refreshes !== undefined) {
    return [
      { label: '注册结果', value: `${result.succeeded || 0}/${result.requested || 0}`, detail: `${result.completedIterations || 0}/${result.iterations || 0} 轮` },
      { label: '代理刷新', value: String(result.refreshes || 0), detail: result.proxyDistribution === 'capacity' ? '按容量均分 · 每轮执行前' : '每轮执行前' },
    ];
  }
  if (result.runId && Number.isFinite(Number(result.requested))) {
    return [{ label: '处理结果', value: `${result.succeeded || 0}/${result.requested}`, detail: result.countryCode || '国家池' }];
  }
  if (Number.isFinite(Number(result.pulled))) {
    return [{ label: '代理来源', value: `${result.succeeded || 0}/${result.requested || 0}`, detail: `拉取 ${result.pulled || 0} 条` }];
  }
  return [];
}

function robotConfigSummary(robot: RobotRecord) {
  if (robot.id === 'proxy-refresh') {
    return `刷新间隔 ${intervalLabel(robot.intervalMs)}`;
  }
  if (!robot.configurable) return '';
  const config = robot.config || {};
  if (robot.id === 'account-maintenance') {
    const on = config.deleteBannedAssets !== undefined
      ? config.deleteBannedAssets !== false
      : config.deleteBannedAfterRefresh !== false;
    return `${on ? '清空封禁组' : '规则已关闭'} · 间隔 ${intervalLabel(robot.intervalMs)}`;
  }
  if (robot.id === 'mailcom-register') {
    // The active template is what 立即注册一批 uses, so it is what the row
    // summarises; the rest are named in the count beside it.
    const { templates, activeTemplateId } = registrationTemplates(robot);
    const active = templates.find((template) => template.templateId === activeTemplateId) || templates[0];
    const scheduled = templates.filter((template) => template.schedule.enabled && template.schedule.times.length).length;
    return [
      templates.length > 1 ? `${templates.length} 个模板 · 当前「${active.name}」` : active.name,
      active.mailInterface,
      active.mailRentalWatch ? `挂租 ${active.mailRentalTarget}` : `根邮箱 ${active.rootEmailCount}`,
      `${active.workerCount} Worker`,
      active.postRegistrationOAuth ? '注册后 OAuth' : '仅注册',
      active.proxyMode === 'local'
        ? `本地代理${active.localProxyId ? ` ${active.localProxyId}` : ''}`
        : (active.proxyDistribution === 'capacity' ? '按容量均分' : active.countryCode),
      `${active.iterations} 轮`,
      scheduled ? `${scheduled} 个模板已定时` : '',
      `执行间隔 ${intervalLabel(robot.intervalMs)}`,
    ].filter(Boolean).join(' · ');
  }
  const parts = [
    config.rootEmailCount !== undefined ? `根邮箱 ${config.rootEmailCount}` : '',
    config.workerCount !== undefined ? `${config.workerCount} Worker` : '',
    config.mailInterface ? String(config.mailInterface) : '',
    config.proxyMode === 'local'
      ? `本地代理${config.localProxyId ? ` ${String(config.localProxyId)}` : ''}`
      : (config.proxyDistribution === 'capacity'
        ? '按容量均分'
        : (config.countryCode ? String(config.countryCode) : '')),
    config.iterations !== undefined ? `${config.iterations} 轮` : '',
    `间隔 ${intervalLabel(robot.intervalMs)}`,
  ].filter(Boolean);
  return parts.join(' · ');
}

function ProxyRefreshRobotConfigDialog({ robot, onNotice }: { robot: RobotRecord; onNotice: (notice: { tone: string; text: string }) => void }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [intervalMinutes, setIntervalMinutes] = useState(Math.max(1, Math.round(Number(robot.intervalMs || 600_000) / 60_000)));
  const save = useMutation({
    mutationFn: () => endpoints.updateRobot(robot.id, {
      intervalMs: Math.min(10_080, Math.max(1, Number(intervalMinutes || 1))) * 60_000,
    }),
    onSuccess: async (updated) => {
      client.setQueryData<RobotSnapshot>(['robots'], (current) => current
        ? { ...current, robots: current.robots.map((item) => item.id === updated.id ? updated : item) }
        : current);
      await client.invalidateQueries({ queryKey: ['robots'] });
      setOpen(false);
      onNotice({ tone: 'success', text: '代理刷新间隔已保存' });
    },
    onError: (error) => onNotice({ tone: 'danger', text: errorMessage(error) }),
  });
  const openEditor = () => {
    setIntervalMinutes(Math.max(1, Math.round(Number(robot.intervalMs || 600_000) / 60_000)));
    setOpen(true);
  };
  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Trigger asChild>
      <IconButton label="配置代理刷新机器人" onClick={openEditor} disabled={save.isPending}><Settings2 size={16} /></IconButton>
    </Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="dialog-content robot-config-dialog">
        <Dialog.Title>代理刷新机器人</Dialog.Title>
        <Dialog.Description>设置代理池自动刷新的相邻运行间隔，保存后立即应用到后续调度。</Dialog.Description>
        <label className="robot-maintenance-interval"><span>刷新间隔（分钟）</span><ConfigNumberInput min={1} max={10_080} step={1} value={intervalMinutes} onValueChange={setIntervalMinutes} /></label>
        <div className="robot-config-note"><span>最短 1 分钟</span><span>最长 7 天</span><span>启用中会重新计算下次运行时间</span></div>
        <div className="dialog-actions">
          <Button tone="quiet" onClick={() => setOpen(false)}>取消</Button>
          <Button tone="primary" icon={save.isPending ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />} onClick={() => save.mutate()} disabled={save.isPending}>保存配置</Button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

function MaintenanceRobotConfigDialog({ robot, onNotice }: { robot: RobotRecord; onNotice: (notice: { tone: string; text: string }) => void }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const config = robot.config || {};
  // `deleteBannedAfterRefresh` is the pre-rename key; a robots.json written by
  // an older build still carries the operator's choice under it.
  const maintenanceDraft = (source: Record<string, unknown>, intervalMs: number) => ({
    deleteBannedAssets: source.deleteBannedAssets !== undefined
      ? source.deleteBannedAssets !== false
      : source.deleteBannedAfterRefresh !== false,
    archiveSettledAssets: source.archiveSettledAssets !== false,
    intervalMinutes: Math.max(1, Math.round(Number(intervalMs || 60_000) / 60_000)),
  });
  const [draft, setDraft] = useState(() => maintenanceDraft(config, Number(robot.intervalMs)));
  const save = useMutation({
    mutationFn: () => endpoints.updateRobot(robot.id, {
      intervalMs: Math.max(1, Number(draft.intervalMinutes || 1)) * 60_000,
      config: {
        deleteBannedAssets: draft.deleteBannedAssets,
        archiveSettledAssets: draft.archiveSettledAssets,
      },
    }),
    onSuccess: async (updated) => {
      client.setQueryData<RobotSnapshot>(['robots'], (current) => current
        ? { ...current, robots: current.robots.map((item) => item.id === updated.id ? updated : item) }
        : current);
      await client.invalidateQueries({ queryKey: ['robots'] });
      setOpen(false);
      onNotice({ tone: 'success', text: '清洗规则已保存' });
    },
    onError: (error) => onNotice({ tone: 'danger', text: errorMessage(error) }),
  });
  const openEditor = () => {
    setDraft(maintenanceDraft(config, Number(robot.intervalMs)));
    setOpen(true);
  };
  // Two jobs, and the difference between them is the whole point: one deletes,
  // one moves. Each says which, so an operator is never guessing whether a
  // switch is about to throw an account away.
  const rules = [
    {
      key: 'deleteBannedAssets',
      label: '清空已注销/封禁组',
      tone: '删除',
      detail: '删除登录态页面「已注销」分类中的资产，连同 CPA 产物。计划卖出与自用的账号一旦探测到注销也会归入该分类；已售出的账号保留销售记录，不会被清除。',
    },
    {
      key: 'archiveSettledAssets',
      label: '归档已结算登录态',
      tone: '移动',
      detail: '把「已卖出」且 CPA 批次锁定满 24 小时的登录态移出列表，刷新更快。文件不删：历史与产物页照常显示，邮箱仍算已用过，需要时可整体还原。',
    },
  ] as const;
  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Trigger asChild>
      <IconButton label="配置清洗机器人" onClick={openEditor} disabled={save.isPending}><Settings2 size={16} /></IconButton>
    </Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="dialog-content robot-config-dialog">
        <Dialog.Title>清洗机器人</Dialog.Title>
        <Dialog.Description>每轮按下面的规则清理一次登录态资产。</Dialog.Description>
        <div className="robot-maintenance-rules">
          {rules.map((rule) => <label className="robot-maintenance-rule" key={rule.key}>
            <div>
              <strong>{rule.label}<em className={`robot-rule-tone robot-rule-tone-${rule.key === 'deleteBannedAssets' ? 'danger' : 'safe'}`}>{rule.tone}</em></strong>
              <small>{rule.detail}</small>
            </div>
            <Switch.Root
              className="switch-root"
              aria-label={rule.label}
              checked={draft[rule.key]}
              onCheckedChange={(value) => setDraft((current) => ({ ...current, [rule.key]: value }))}
            ><Switch.Thumb className="switch-thumb" /></Switch.Root>
          </label>)}
        </div>
        <div className="robot-config-grid">
          <label><span>轮询间隔（分钟）</span><ConfigNumberInput min={1} max={10_080} step={1} value={draft.intervalMinutes} onValueChange={(value) => setDraft((current) => ({ ...current, intervalMinutes: value }))} /></label>
        </div>
        <div className="dialog-actions">
          <Button tone="quiet" onClick={() => setOpen(false)}>取消</Button>
          <Button tone="primary" icon={save.isPending ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />} onClick={() => save.mutate()} disabled={save.isPending}>保存规则</Button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

const WEEKDAY_LABELS = ['日', '一', '二', '三', '四', '五', '六'];
const DEFAULT_TEMPLATE_DRAFT: RegistrationTemplate = {
  templateId: 'mail-v1',
  name: '默认模板',
  mailInterface: 'mailcom',
  rootEmailCount: 20,
  workerCount: 20,
  proxyMode: 'countryPool',
  proxyDistribution: 'capacity',
  localProxyId: '',
  countryCode: 'GB',
  iterations: 1,
  onIterationFailure: 'stop',
  refreshBeforeEachIteration: true,
  postRegistrationOAuth: false,
  mailRentalWatch: false,
  mailRentalTarget: 200,
  mailRentalBatchSize: 20,
  mailRentalPollIntervalMs: 20_000,
  schedule: { enabled: false, times: [], weekdays: [] },
};

/** The stored config, or the single-template shape it migrated from. */
function registrationTemplates(robot: RobotRecord): RegistrationRobotConfig {
  const config = (robot.config || {}) as Partial<RegistrationRobotConfig> & Partial<RegistrationTemplate>;
  const templates = Array.isArray(config.templates) && config.templates.length
    ? config.templates
    : [config as Partial<RegistrationTemplate>];
  const normalized = templates.map((template, index) => ({
    ...DEFAULT_TEMPLATE_DRAFT,
    ...template,
    templateId: String(template?.templateId || `template-${index + 1}`),
    name: String(template?.name || `模板 ${index + 1}`),
    schedule: {
      enabled: template?.schedule?.enabled === true,
      times: Array.isArray(template?.schedule?.times) ? [...template.schedule.times] : [],
      weekdays: Array.isArray(template?.schedule?.weekdays) ? [...template.schedule.weekdays] : [],
    },
  })) as RegistrationTemplate[];
  const activeTemplateId = normalized.some((template) => template.templateId === config.activeTemplateId)
    ? String(config.activeTemplateId)
    : normalized[0].templateId;
  return { templates: normalized, activeTemplateId };
}

function scheduleSummary(schedule: RegistrationSchedule) {
  if (!schedule.enabled || !schedule.times.length) return '未启用定时';
  const days = schedule.weekdays.length
    ? schedule.weekdays.map((day) => `周${WEEKDAY_LABELS[day]}`).join('、')
    : '每天';
  return `${days} ${schedule.times.join('、')}`;
}

/**
 * One template's clock schedule.
 *
 * Times are added one at a time and shown as removable chips rather than typed
 * into a free-text field: the times are the schedule, and a list that can only
 * hold real ones cannot be saved half-parsed.
 *
 * The times stay editable whether or not the switch is on. Hiding them behind
 * it forced an operator to arm an empty schedule before they could fill it in,
 * and an armed schedule with no time does nothing anyway — the normalizer
 * disables it server-side. So the switch says whether it fires; the list says
 * when.
 */
function TemplateScheduleEditor({ schedule, onChange }: {
  schedule: RegistrationSchedule;
  onChange: (next: RegistrationSchedule) => void;
}) {
  const [time, setTime] = useState('09:00');
  const addTime = () => {
    if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(time) || schedule.times.includes(time)) return;
    onChange({ ...schedule, times: [...schedule.times, time].sort() });
  };
  const armed = schedule.enabled && schedule.times.length > 0;
  return <div className={`robot-schedule-editor${armed ? '' : ' robot-schedule-editor-off'}`}>
    <label className="robot-schedule-toggle">
      <Switch.Root className="switch-root" checked={schedule.enabled} onCheckedChange={(checked) => onChange({ ...schedule, enabled: checked === true })}>
        <Switch.Thumb className="switch-thumb" />
      </Switch.Root>
      <span>定时启动</span>
      <small>{armed
        ? '到点按本模板起一轮，机器人停用也照常触发；有任务占用主任务位时跳过并提示'
        : (schedule.enabled ? '还没有时刻，加一个才会启动' : '关闭中，下面的时刻保存后不会自动启动')}</small>
    </label>
    <>
      <div className="robot-schedule-times">
        <input type="time" aria-label="新增启动时刻" value={time} onChange={(event) => setTime(event.target.value)} />
        <Button tone="quiet" onClick={addTime} disabled={schedule.times.includes(time) || schedule.times.length >= 12}>添加时刻</Button>
        {schedule.times.length
          ? <div className="robot-schedule-chips">{schedule.times.map((entry) => <button
            type="button"
            key={entry}
            className="robot-schedule-chip"
            aria-label={`移除 ${entry}`}
            onClick={() => onChange({ ...schedule, times: schedule.times.filter((candidate) => candidate !== entry) })}
          >{entry}<XCircle size={11} aria-hidden="true" /></button>)}</div>
          : null}
      </div>
      <div className="robot-schedule-weekdays" role="group" aria-label="星期筛选">
        <span>星期</span>
        {WEEKDAY_LABELS.map((label, day) => {
          const selected = schedule.weekdays.includes(day);
          return <button
            type="button"
            key={label}
            aria-pressed={selected}
            className={selected ? 'selected' : ''}
            onClick={() => onChange({
              ...schedule,
              weekdays: selected
                ? schedule.weekdays.filter((candidate) => candidate !== day)
                : [...schedule.weekdays, day].sort((left, right) => left - right),
            })}
          >{label}</button>;
        })}
        <small>{schedule.weekdays.length ? '' : '不选则每天都跑'}</small>
      </div>
    </>
  </div>;
}

function RegistrationRobotConfigDialog({ robot, countryPools, localProxies, onNotice }: { robot: RobotRecord; countryPools: RobotCountryPool[]; localProxies: Array<{ id: string; endpoint: string }>; onNotice: (notice: { tone: string; text: string }) => void }) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<RegistrationRobotConfig>(() => registrationTemplates(robot));
  const [editingId, setEditingId] = useState('');
  const [intervalMinutes, setIntervalMinutes] = useState(10);
  const editing = draft.templates.find((template) => template.templateId === editingId) || draft.templates[0];
  const patchEditing = (patch: Partial<RegistrationTemplate>) => setDraft((current) => ({
    ...current,
    templates: current.templates.map((template) => template.templateId === editing.templateId
      ? { ...template, ...patch }
      : template),
  }));
  const save = useMutation({
    mutationFn: () => endpoints.updateRobot(robot.id, {
      intervalMs: Math.max(1, Number(intervalMinutes || 1)) * 60_000,
      config: draft,
    }),
    onSuccess: async (updated) => {
      client.setQueryData<RobotSnapshot>(['robots'], (current) => current
        ? { ...current, robots: current.robots.map((item) => item.id === updated.id ? updated : item) }
        : current);
      await client.invalidateQueries({ queryKey: ['robots'] });
      setOpen(false);
      onNotice({ tone: 'success', text: '机器人配置已保存' });
    },
    onError: (error) => onNotice({ tone: 'danger', text: errorMessage(error) }),
  });
  const openEditor = () => {
    const next = registrationTemplates(robot);
    setDraft(next);
    setEditingId(next.activeTemplateId);
    setIntervalMinutes(Math.max(1, Math.round(Number(robot.intervalMs || 600_000) / 60_000)));
    setOpen(true);
  };
  const addTemplate = () => setDraft((current) => {
    if (current.templates.length >= MAX_REGISTRATION_TEMPLATES) return current;
    const source = current.templates.find((template) => template.templateId === editing.templateId) || current.templates[0];
    let id = `${source.templateId}-copy`;
    let suffix = 2;
    while (current.templates.some((template) => template.templateId === id)) {
      id = `${source.templateId}-${suffix}`;
      suffix += 1;
    }
    // Copied from the one on screen rather than from defaults: a second
    // template is almost always a variation of the first.
    const created = { ...source, templateId: id, name: `${source.name} 副本`, schedule: { ...source.schedule, enabled: false } };
    setEditingId(id);
    return { ...current, templates: [...current.templates, created] };
  });
  const removeTemplate = (templateId: string) => setDraft((current) => {
    if (current.templates.length <= 1) return current;
    const templates = current.templates.filter((template) => template.templateId !== templateId);
    const activeTemplateId = templates.some((template) => template.templateId === current.activeTemplateId)
      ? current.activeTemplateId
      : templates[0].templateId;
    setEditingId((currentId) => (currentId === templateId ? activeTemplateId : currentId));
    return { templates, activeTemplateId };
  });
  const normalizedCountryPools = countryPools
    .map((pool) => ({ countryCode: String(pool.countryCode || '').trim().toUpperCase(), total: Math.max(0, Number(pool.total || 0)) }))
    .filter((pool) => pool.countryCode);
  const poolByCountry = new Map(normalizedCountryPools.map((pool) => [pool.countryCode, pool]));
  const countryOptions = [...new Set([...normalizedCountryPools.map((pool) => pool.countryCode), String(editing.countryCode || 'GB').trim().toUpperCase()])].filter(Boolean).sort();
  const countryPoolOptions = countryOptions.map((country) => ({
    value: country,
    label: `${country} · ${poolByCountry.get(country)?.total || 0} 条`,
  }));
  const capacityPools = normalizedCountryPools.filter((pool) => pool.total > 0).sort((left, right) => right.total - left.total || left.countryCode.localeCompare(right.countryCode));
  const totalPoolCapacity = capacityPools.reduce((sum, pool) => sum + pool.total, 0);
  const localProxyOptions = [...new Map([
    ...localProxies.map((proxy) => [proxy.id, proxy] as const),
    ...(editing.localProxyId ? [[editing.localProxyId, { id: editing.localProxyId, endpoint: editing.localProxyId }] as const] : []),
  ]).values()];
  const rentalInterface = editing.mailInterface === 'smsbower';
  const rentalWatch = rentalInterface && editing.mailRentalWatch;
  // Mirrors the server rule: Workers cannot outnumber the mailboxes the round
  // will actually have, which is the broker's target under 挂租.
  const mailboxBudget = (template: RegistrationTemplate) => (template.mailInterface === 'smsbower' && template.mailRentalWatch
    ? Number(template.mailRentalTarget)
    : Number(template.rootEmailCount));
  const invalid = draft.templates.some((template) => Number(template.workerCount) > mailboxBudget(template)
    || (template.proxyMode === 'local' && (!String(template.localProxyId || '').trim() || Number(template.workerCount) !== 1)));
  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Trigger asChild>
      <IconButton label="配置机器人" onClick={openEditor} disabled={save.isPending}><Settings2 size={16} /></IconButton>
    </Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="dialog-overlay" />
      <Dialog.Content className="dialog-content robot-config-dialog">
        <Dialog.Title>注册机器人配置</Dialog.Title>
        <Dialog.Description>每个模板是一套完整的注册设置，可以单独定时启动；「立即注册一批」用当前模板。</Dialog.Description>
        <div className="robot-template-bar" role="tablist" aria-label="注册模板">
          {draft.templates.map((template) => <button
            type="button"
            role="tab"
            key={template.templateId}
            aria-selected={template.templateId === editing.templateId}
            className={template.templateId === editing.templateId ? 'selected' : ''}
            onClick={() => setEditingId(template.templateId)}
          >
            {template.name}
            {template.templateId === draft.activeTemplateId && <em title="「立即注册一批」和机器人的周期轮转都用这个模板；各模板的定时启动仍按各自的设置">当前</em>}
            {template.schedule.enabled && template.schedule.times.length > 0 && <TimerReset size={11} aria-label="已设定时" />}
          </button>)}
          <Button tone="quiet" onClick={addTemplate} disabled={draft.templates.length >= MAX_REGISTRATION_TEMPLATES}>新增模板</Button>
        </div>
        <div className="robot-template-head">
          <label className="robot-template-name"><span>模板名称</span><input type="text" maxLength={40} value={editing.name} onChange={(event) => patchEditing({ name: event.target.value })} /></label>
          <Button
            tone="quiet"
            onClick={() => setDraft((current) => ({ ...current, activeTemplateId: editing.templateId }))}
            disabled={draft.activeTemplateId === editing.templateId}
          >设为当前</Button>
          <ConfirmDialog
            trigger={<IconButton label="删除模板" disabled={draft.templates.length <= 1}><Trash2 size={15} /></IconButton>}
            title="删除模板"
            description={`将删除模板「${editing.name}」及其定时设置。`}
            danger
            confirmLabel="确认删除"
            onConfirm={() => removeTemplate(editing.templateId)}
          />
        </div>
        <div className="robot-config-grid">
          <label><span>邮箱接口</span><AppSelect ariaLabel="邮箱接口" value={editing.mailInterface} onValueChange={(value) => patchEditing({ mailInterface: value, ...(value === 'smsbower' ? {} : { mailRentalWatch: false }) })} options={REGISTRATION_MAIL_OPTIONS} /></label>
          {!rentalWatch && <label><span>根邮箱数</span><ConfigNumberInput min={1} max={100} step={1} value={editing.rootEmailCount} onValueChange={(value) => patchEditing({ rootEmailCount: value })} /></label>}
          <label><span>Worker 数</span><ConfigNumberInput min={1} max={20} step={1} value={editing.workerCount} onValueChange={(value) => patchEditing({ workerCount: value })} /></label>
          <label><span>代理模式</span><AppSelect ariaLabel="代理模式" value={editing.proxyMode} onValueChange={(value) => patchEditing({ proxyMode: value, ...(value === 'local' ? { workerCount: 1 } : {}) })} options={[{ value: 'countryPool', label: '国家池' }, { value: 'local', label: '本地代理' }]} /></label>
          {editing.proxyMode === 'countryPool' && <label><span>代理分配</span><AppSelect ariaLabel="代理分配" value={editing.proxyDistribution} onValueChange={(value) => patchEditing({ proxyDistribution: value })} options={[{ value: 'capacity', label: '按容量均分' }, { value: 'single', label: '固定单一国家池' }]} /></label>}
          {editing.proxyMode === 'countryPool' && editing.proxyDistribution === 'capacity' && <div className="robot-config-capacity" aria-live="polite"><span>代理池容量</span><div className="robot-config-capacity-summary"><div><strong>{capacityPools.length} 池 · {totalPoolCapacity} 条</strong></div><div className="robot-config-capacity-list">{capacityPools.length ? capacityPools.map((pool) => <span key={pool.countryCode}><b>{pool.countryCode}</b><em>{pool.total}</em></span>) : <small>暂无可用国家池</small>}</div>{totalPoolCapacity < Number(editing.workerCount) && <small className="robot-config-capacity-warning">可用容量 {totalPoolCapacity} / {editing.workerCount}</small>}</div></div>}
          {editing.proxyMode === 'countryPool' && editing.proxyDistribution === 'single' && <label><span>国家池</span><AppSelect ariaLabel="国家池" value={editing.countryCode} onValueChange={(value) => patchEditing({ countryCode: value })} options={countryPoolOptions} /></label>}
          {editing.proxyMode === 'local' && <label><span>本地代理</span><AppSelect ariaLabel="本地代理" value={editing.localProxyId} onValueChange={(value) => patchEditing({ localProxyId: value })} options={[{ value: '', label: '选择本地代理' }, ...localProxyOptions.map((proxy) => ({ value: proxy.id, label: proxy.endpoint || proxy.id }))]} disabled={!localProxyOptions.length} /></label>}
          <label><span>执行次数</span><ConfigNumberInput min={1} max={100} step={1} value={editing.iterations} onValueChange={(value) => patchEditing({ iterations: value })} /></label>
          <label><span>执行间隔（分钟）</span><ConfigNumberInput min={1} max={10_080} step={1} value={intervalMinutes} onValueChange={setIntervalMinutes} /></label>
        </div>
        {/* The same choice the launch page offers as two buttons, as a switch
            here: a scheduled round has no one standing over it to pick one.
            First of the switched blocks because it decides what a round
            produces, before how its mailboxes are obtained or when it runs. */}
        <div className="robot-toggle-block">
          <label className="robot-schedule-toggle">
            <Switch.Root className="switch-root" checked={editing.postRegistrationOAuth === true} onCheckedChange={(checked) => patchEditing({ postRegistrationOAuth: checked === true })}>
              <Switch.Thumb className="switch-thumb" />
            </Switch.Root>
            <span>注册后 OAuth</span>
            <small>每轮在同一个任务里注册完接着授权，直接产出 CPA；关闭则只保存登录态，之后再单独发 OAuth 任务。开启后每轮都要消耗号码，起跑前会检查短信余额</small>
          </label>
        </div>
        {/* Only SMSBower rents mailboxes, so the unified broker only appears
            there — and switching the interface away clears it rather than
            leaving a setting that silently does nothing. */}
        {rentalInterface && <div className="robot-rental-block">
          <label className="robot-schedule-toggle">
            <Switch.Root className="switch-root" checked={editing.mailRentalWatch} onCheckedChange={(checked) => patchEditing({ mailRentalWatch: checked === true })}>
              <Switch.Thumb className="switch-thumb" />
            </Switch.Root>
            <span>挂租模式</span>
            <small>统一 Broker 轮询库存、批量领取，再分配给 Worker；起跑时没库存也照常开始，连续 20 分钟领不到才收工。关闭则按根邮箱数按需租用，库存不够不开跑</small>
          </label>
          {rentalWatch && <div className="robot-config-grid">
            <label><span>挂租总量</span><ConfigNumberInput min={1} max={10_000} step={1} value={editing.mailRentalTarget} onValueChange={(value) => patchEditing({ mailRentalTarget: value })} /><small>本轮要领取的邮箱总数，取代根邮箱数</small></label>
            <label><span>单批领取</span><ConfigNumberInput min={1} max={20} step={1} value={editing.mailRentalBatchSize} onValueChange={(value) => patchEditing({ mailRentalBatchSize: value })} /></label>
            <label><span>库存轮询（秒）</span><ConfigNumberInput min={1} max={3600} step={1} value={Math.round(editing.mailRentalPollIntervalMs / 1000)} onValueChange={(value) => patchEditing({ mailRentalPollIntervalMs: value * 1000 })} /></label>
          </div>}
        </div>}
        <TemplateScheduleEditor schedule={editing.schedule} onChange={(schedule) => patchEditing({ schedule })} />
        <div className="robot-config-note"><span>每轮开始前自动刷新代理</span><span>达到次数后自动停止</span><span>{scheduleSummary(editing.schedule)}</span></div>
        <div className="dialog-actions">
          <Button tone="quiet" onClick={() => setOpen(false)}>取消</Button>
          <Button tone="primary" icon={save.isPending ? <LoaderCircle className="spin" size={15} /> : <Save size={15} />} onClick={() => save.mutate()} disabled={save.isPending || invalid}>保存配置</Button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}


function RobotRow({ robot, taskBusy, countryPools, localProxies, onNotice }: { robot: RobotRecord; taskBusy: boolean; countryPools: RobotCountryPool[]; localProxies: Array<{ id: string; endpoint: string }>; onNotice: (notice: { tone: string; text: string }) => void }) {
  const client = useQueryClient();
  const [working, setWorking] = useState('');
  const action = useMutation({
    mutationFn: async ({ kind, command }: { kind: 'start' | 'stop' | 'command'; command?: string }) => {
      const workingKey = kind === 'command' ? `command:${command}` : kind;
      setWorking(workingKey);
      if (kind === 'start') return endpoints.startRobot(robot.id);
      if (kind === 'stop') return endpoints.stopRobot(robot.id);
      return endpoints.robotCommand(robot.id, command || 'run_now');
    },
    onSuccess: (_result, variables) => {
      client.invalidateQueries({ queryKey: ['robots'] });
      onNotice({
        tone: 'success',
        text: variables.kind === 'stop' ? `${robot.name} 已停止` : (taskBusy ? `${robot.name} 已排队，当前任务结束后执行` : `${robot.name} 已接受命令`),
      });
    },
    onError: (error) => onNotice({ tone: 'danger', text: errorMessage(error) }),
    onSettled: () => setWorking(''),
  });
  const busy = action.isPending;
  const currentStatus = robot.status;
  const configSummary = robotConfigSummary(robot);
  const schedule = robot.schedule;
  const skipped = schedule?.last && schedule.last.outcome !== 'started' ? schedule.last : null;
  return <article className={`robot-row robot-row-${statusTone(currentStatus)}`}>
    <div className="robot-mark" aria-hidden="true"><Bot size={22} /></div>
    <div className="robot-main">
      <div className="robot-title"><h2>{robot.name}</h2><StatusBadge status={currentStatus} label={statusLabel(currentStatus)} /></div>
      <p>{robot.description}</p>
      {configSummary && <div className="robot-config-summary"><Settings2 size={12} /><span title={configSummary}>{configSummary}</span></div>}
      {robot.pendingRun && <div className="robot-waiting"><Clock3 size={13} />等待当前任务结束{taskBusy && robot.lastRun?.reason === 'interval' ? '' : '后执行'}</div>}
      {!robot.pendingRun && robot.waitingDetail && <div className="robot-waiting"><Clock3 size={13} />{robot.waitingDetail}</div>}
      {/* The soonest start on the row; the rest of the queue is one hover away
          rather than another line of chrome on every robot. */}
      {schedule?.next?.at && <div
        className="robot-schedule-next"
        title={(schedule.upcoming || [])
          .filter((entry) => entry.at)
          .slice(0, 6)
          .map((entry) => `${formatTime(entry.at as string)} · ${entry.name}`)
          .join('\n')}
      ><TimerReset size={13} />{formatTime(schedule.next.at)} 按「{schedule.next.name}」启动{(schedule.upcoming || []).length > 1 ? `，共 ${schedule.upcoming.length} 个待启动` : ''}</div>}
      {/* A refused start happened while nobody was looking, so it stays on the
          row until the next scheduled start replaces it. */}
      {skipped && <div className="robot-schedule-warning" role="status"><CircleAlert size={13} />{formatTime(skipped.scheduledAt)}「{skipped.templateName}」未启动：{skipped.reason}</div>}
    </div>
    <div className="robot-facts">
      <div><span>周期</span><strong>{intervalLabel(robot.intervalMs)}</strong></div>
      <div><span>下次运行</span><strong>{robot.nextRunAt ? formatTime(robot.nextRunAt) : '—'}</strong></div>
      <div><span>最近结果</span><strong>{robot.lastRun ? runResultLabel(robot.lastRun) : '尚未执行'}</strong></div>
    </div>
    <div className="robot-actions">
      {robot.id === 'proxy-refresh' && <ProxyRefreshRobotConfigDialog robot={robot} onNotice={onNotice} />}
      {robot.id === 'mailcom-register' && robot.configurable && <RegistrationRobotConfigDialog robot={robot} countryPools={countryPools} localProxies={localProxies} onNotice={onNotice} />}
      {robot.id === 'account-maintenance' && robot.configurable && <MaintenanceRobotConfigDialog robot={robot} onNotice={onNotice} />}
      <IconButton
        label={robot.enabled ? '停止机器人' : '启动机器人'}
        className={robot.enabled ? 'icon-button-active' : ''}
        disabled={busy}
        onClick={() => action.mutate({ kind: robot.enabled ? 'stop' : 'start' })}
      >
        {working === 'start' ? <LoaderCircle className="spin" size={16} /> : (robot.enabled ? <Pause size={16} /> : <Play size={16} />)}
      </IconButton>
      {robot.commands.map((command) => <Button
        key={command.id}
        tone="primary"
        icon={working === `command:${command.id}` ? <LoaderCircle className="spin" size={15} /> : <Zap size={15} />}
        disabled={busy || currentStatus === 'running'}
        onClick={() => action.mutate({ kind: 'command', command: command.id })}
      >
        {command.label}
      </Button>)}
    </div>
  </article>;
}

function RobotRunDetailsDialog({
  selection,
  onOpenChange,
}: {
  selection: { robot: RobotRecord; run: RobotRun } | null;
  onOpenChange: (selection: { robot: RobotRecord; run: RobotRun } | null) => void;
}) {
  const run = selection?.run;
  const detailRunId = String(run?.result?.runId || '');
  const detail = useQuery({
    queryKey: ['robot-run-details', detailRunId],
    queryFn: () => endpoints.run(detailRunId),
    enabled: Boolean(detailRunId),
    staleTime: 10_000,
  });
  const jobRows = detail.data?.jobs || [];
  const normalizedJobStatus = (job: { status?: string }) => String(job.status || '').toLowerCase();
  const completedJobs = jobRows.filter((job) => normalizedJobStatus(job) === 'complete').length;
  const partialJobs = jobRows.filter((job) => normalizedJobStatus(job) === 'partial').length;
  const skippedJobs = jobRows.filter((job) => normalizedJobStatus(job) === 'skipped').length;
  const failedJobs = jobRows.filter((job) => normalizedJobStatus(job) === 'failed').length;
  const activeJobs = jobRows.filter((job) => !['complete', 'partial', 'skipped', 'failed', 'cancelled', 'failed_proxy', 'finalize_failed'].includes(normalizedJobStatus(job))).length;
  const jobOutcomes = jobRows.filter((job) => ['partial', 'skipped', 'failed'].includes(normalizedJobStatus(job)));
  const resultText = run?.error ? `执行失败：${run.error}` : (run ? runResultLabel(run) : '');
  const summaryItems = run ? robotRunSummaryItems(run) : [];
  return <Dialog.Root open={Boolean(selection)} onOpenChange={(open) => { if (!open) onOpenChange(null); }}>
    <Dialog.Portal>
      {selection && run && <>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content robot-run-details-dialog">
          <div className="robot-run-details-header">
            <div className="robot-run-details-kicker"><Bot size={15} /><span>{selection.robot.name}</span><StatusBadge status={run.status} label={statusLabel(run.status)} /></div>
            <Dialog.Title>机器人运行详情</Dialog.Title>
            <Dialog.Description>{runReasonLabel(run.reason)}触发 · {run.finishedAt ? '本轮已结束' : '本轮正在执行'} · 结果按规则汇总</Dialog.Description>
          </div>
          <div className="robot-run-details-result">
            <div><small>本轮结论</small><StatusBadge status={run.status} label={statusLabel(run.status)} /></div>
            <strong>{resultText}</strong>
          </div>
          {summaryItems.length > 0 && <div className="robot-run-details-summary">
            {summaryItems.map((item) => <div key={item.label}><small>{item.label}</small><strong>{item.value}</strong><span>{item.detail}</span></div>)}
          </div>}
          <div className="robot-run-details-meta">
            <div><small>触发方式</small><strong>{runReasonLabel(run.reason)}</strong></div>
            <div><small>开始时间</small><strong>{formatTime(run.startedAt)}</strong></div>
            <div><small>结束时间</small><strong>{run.finishedAt ? formatTime(run.finishedAt) : '执行中'}</strong></div>
            <div><small>耗时</small><strong>{run.finishedAt ? durationLabel(run.durationMs) : '执行中'}</strong></div>
          </div>
          {detailRunId && <div className="robot-run-linked-task">
            <div><small>关联任务</small><strong>{detail.data ? robotTaskKindLabel(detail.data.taskKind || detail.data.plan?.taskKind) : '任务详情'}</strong><span>{detailRunId}</span></div>
            <Link className="button button-quiet" to={`/run/${detailRunId}`}><ExternalLink size={14} />打开任务详情</Link>
          </div>}
          {detailRunId && <div className="robot-run-job-details">
            <div className="robot-run-job-details-head"><div><strong>账号处理</strong><small>只展示需要关注的账号，不显示底层原始记录</small></div><ListChecks size={16} /></div>
            {detail.isLoading && <div className="robot-run-job-details-state"><LoaderCircle className="spin" size={15} />正在读取账号结果</div>}
            {detail.isError && <div className="robot-run-job-details-state is-error"><CircleAlert size={15} />账号明细暂时无法读取，本轮摘要仍可查看</div>}
            {!detail.isLoading && !detail.isError && <>
              <div className="robot-run-job-summary">
                <span><CheckCircle2 size={14} /><small>完成</small><strong>{completedJobs}</strong></span>
                <span><CheckCircle2 size={14} /><small>部分完成</small><strong>{partialJobs}</strong></span>
                <span><CircleAlert size={14} /><small>跳过</small><strong>{skippedJobs}</strong></span>
                <span><XCircle size={14} /><small>失败</small><strong>{failedJobs}</strong></span>
              </div>
              {jobOutcomes.length ? <div className="robot-run-job-list">
                {jobOutcomes.map((job) => <div className="robot-run-job-row" key={job.id}>
                  <div><strong>{job.email}</strong><StatusBadge status={job.status} label={statusLabel(job.status)} /></div>
                  <p className={job.error || ['failed', 'finalize_failed'].includes(String(job.status || '').toLowerCase()) ? 'job-result-failure' : undefined}>{jobResultLabel(job.result, job.error) || job.phase || '没有附加原因'}</p>
                </div>)}
              </div> : <div className="robot-run-job-details-state">{activeJobs ? `还有 ${activeJobs} 个账号正在处理中` : '没有需要额外关注的账号'}</div>}
            </>}
          </div>}
          {!detailRunId && <div className="robot-run-details-empty"><CheckCircle2 size={16} /><div><strong>本轮为规则处理</strong><span>没有单独启动底层任务，清理和自动提链结果以上方摘要为准。</span></div></div>}
          <div className="dialog-actions">
            <Dialog.Close asChild><Button tone="quiet">关闭</Button></Dialog.Close>
          </div>
        </Dialog.Content>
      </>}
    </Dialog.Portal>
  </Dialog.Root>;
}

function RobotHistory({ robots, onNotice }: { robots: RobotRecord[]; onNotice: (notice: { tone: string; text: string }) => void }) {
  const client = useQueryClient();
  const [selectedRun, setSelectedRun] = useState<{ robot: RobotRecord; run: RobotRun } | null>(null);
  const clear = useMutation({
    mutationFn: endpoints.clearRobotRuns,
    onSuccess: async (result) => {
      client.setQueryData<RobotSnapshot>(['robots'], (current) => current
        ? { ...current, robots: result.robots }
        : current);
      await client.invalidateQueries({ queryKey: ['robots'] });
      onNotice({ tone: 'success', text: result.removed ? `已清空 ${result.removed} 条运行日志` : '运行日志已是空的' });
    },
    onError: (error) => onNotice({ tone: 'danger', text: errorMessage(error) }),
  });
  const runs = robots
    .flatMap((robot) => {
      const history = Array.isArray(robot.runs) ? robot.runs : [];
      const liveRun = robot.lastRun && !history.some((run) => run.id === robot.lastRun?.id)
        ? [robot.lastRun]
        : [];
      return [...liveRun, ...history].map((run) => ({ robot, run }));
    })
    .sort((left, right) => {
      const leftTime = Date.parse(left.run.startedAt);
      const rightTime = Date.parse(right.run.startedAt);
      return (Number.isFinite(rightTime) ? rightTime : 0) - (Number.isFinite(leftTime) ? leftTime : 0);
    })
    .slice(0, MAX_VISIBLE_ROBOT_RUNS);
  const totalRuns = robots.reduce((total, robot) => {
    const history = Array.isArray(robot.runs) ? robot.runs : [];
    const hasUnlistedLiveRun = Boolean(robot.lastRun && !history.some((run) => run.id === robot.lastRun?.id));
    return total + history.length + (hasUnlistedLiveRun ? 1 : 0);
  }, 0);
  return <>
  <section className="workspace-band robot-history-panel">
    <div className="section-heading"><div><h2>运行日志</h2><p>{runs.length ? `最近 ${runs.length} 条` : '暂无记录'}</p></div><div className="robot-history-heading-actions"><ConfirmDialog trigger={<IconButton label="清空运行日志" disabled={!totalRuns || clear.isPending}><Trash2 size={16} /></IconButton>} title="清空运行日志" description={`将清空所有机器人的 ${totalRuns} 条运行记录，同时重置最近结果；不会停止正在运行的任务。`} danger confirmLabel="清空" onConfirm={() => clear.mutate()} /><TimerReset size={17} className="robot-history-icon" /></div></div>
    {runs.length ? <div className="robot-history-scroll">
      <div className="robot-history-head"><span>时间</span><span>机器人 / 结果</span><span>耗时</span><span aria-hidden="true" /></div>
      {runs.map(({ robot, run }) => <div className="robot-history-row" key={`${robot.id}:${run.id}`}>
        <time>{formatTime(run.startedAt)}</time>
        <div className="robot-history-result"><strong>{robot.name}</strong><div><StatusBadge status={run.status} label={statusLabel(run.status)} /><small title={`${runReasonLabel(run.reason)} · ${runResultLabel(run)}`}>{runReasonLabel(run.reason)} · {runResultLabel(run)}</small></div></div>
        <span>{run.finishedAt ? durationLabel(run.durationMs) : '执行中'}</span>
        <div className="robot-history-action"><IconButton label="查看运行详情" onClick={() => setSelectedRun({ robot, run })}><FileJson size={15} /></IconButton></div>
      </div>)}
    </div> : <EmptyState icon={<TimerReset size={24} />} title="暂无运行日志" detail="执行一次命令后，结果会保留在这里。" />}
  </section>
  <RobotRunDetailsDialog selection={selectedRun} onOpenChange={setSelectedRun} />
  </>;
}

export function RobotsPage() {
  const robots = useQuery({ queryKey: ['robots'], queryFn: endpoints.robots, refetchInterval: 2500 });
  const proxyCatalog = useQuery({ queryKey: ['proxies'], queryFn: endpoints.proxies, staleTime: 5000 });
  const [notice, setNotice] = useState<{ tone: string; text: string } | null>(null);
  const robotRows = robots.data?.robots || [];
  const enabledCount = useMemo(() => robotRows.filter((robot) => robot.enabled).length, [robotRows]);
  const runningCount = useMemo(() => robotRows.filter((robot) => robot.status === 'running').length, [robotRows]);
  const waitingCount = useMemo(() => robotRows.filter((robot) => robot.pendingRun).length, [robotRows]);
  const countryPools = useMemo(() => (proxyCatalog.data?.dynamic?.countryPools || []).map((pool) => ({ countryCode: pool.countryCode, total: pool.total })), [proxyCatalog.data]);
  const localProxies = useMemo(() => (proxyCatalog.data?.local?.proxies || []).map((proxy) => ({ id: proxy.id, endpoint: proxy.endpoint })), [proxyCatalog.data]);
  return <div className="robots-page">
    <PageHeader
      title="机器人"
      description="自动化程序与命令"
      actions={<IconButton label="刷新机器人状态" onClick={() => robots.refetch()} disabled={robots.isFetching}><RefreshCw className={robots.isFetching ? 'spin' : ''} size={17} /></IconButton>}
    />
    {notice && <Notice tone={notice.tone} floating onClose={() => setNotice(null)} autoDismissToken={notice}>{notice.text}</Notice>}
    <div className="robots-content-grid">
      <main className="robots-primary">
        <section className={`robot-activity-band${robots.data?.taskBusy ? ' is-busy' : ''}`}>
          <div className="robot-activity-main"><span className="robot-activity-dot" /><div><strong>{robots.data?.taskBusy ? '当前任务进行中' : '当前没有进行中的任务'}</strong>{robots.data?.activeRunId && <Link to={`/run/${robots.data.activeRunId}`}>查看任务</Link>}</div></div>
          <div className="robot-activity-stats"><span><small>已启用</small><strong>{enabledCount}</strong></span><span><small>执行中</small><strong>{runningCount}</strong></span><span><small>等待中</small><strong>{waitingCount}</strong></span></div>
        </section>
        <section className="workspace-band robot-list-panel">
          <div className="section-heading"><div><h2>机器人列表</h2><p>周期、状态与命令</p></div><Bot size={18} className="robot-list-icon" /></div>
          {robots.isLoading ? <div className="loading-line"><LoaderCircle className="spin" size={17} />正在读取机器人状态</div> : robotRows.length ? robotRows.map((robot) => <RobotRow key={robot.id} robot={robot} countryPools={countryPools} localProxies={localProxies} taskBusy={Boolean(robots.data?.taskBusy)} onNotice={setNotice} />) : <EmptyState icon={<Bot size={25} />} title="暂无机器人" detail="机器人定义加载后会显示在这里。" />}
        </section>
      </main>
      <aside className="robots-history-column">
        <RobotHistory robots={robotRows} onNotice={setNotice} />
      </aside>
    </div>
  </div>;
}
