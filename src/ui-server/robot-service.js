'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { atomicWriteText, HttpError, resolveInside, scrubString } = require('./utils');
const { proxyRecoveryWaitDetails } = require('./run-manager');
const { assetLifecycle, isDeactivated } = require('../session-asset-grouping');
const { clone } = require('../util/shared');
const {
  DEFAULT_REGISTRATION_TEMPLATE,
  MAIL_INTERFACES,
  REGISTRATION_TEMPLATE_FIELDS,
  compileRegistrationPlan,
  nextScheduleFireAt,
  normalizeRegistrationRobotConfig,
  registrationTemplate,
  migrateRegistrationRobotConfig,
} = require('../registration-template');

const ROBOT_SCHEMA_VERSION = 1;
const DEFAULT_INTERVAL_MS = 10 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;
const MAX_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_HISTORY = 60;
const MAX_ROBOT_BATCH_SIZE = 100;
// A run that reports every item would otherwise push one update per item to
// every open console; the final update of a run always goes out regardless.
const PROGRESS_EMIT_MIN_INTERVAL_MS = 400;
// How long a pending run may sit behind a busy pipeline before it is dropped
// back onto the schedule. See `watchBusy`.
const ROBOT_PENDING_MAX_WAIT_MS = 30 * 60_000;
const ROBOT_CAPACITY_POLL_MS = 10 * 1000;
// 资源短缺（代理/邮箱不够）连续等待这么久就放弃本轮，让机器人交回 running 标记、
// 排定下一次 interval 再试。只对"短缺"计时，不对"有别的任务在跑"计时——排在真实
// 任务后面是正常排队，不该被判超时。这是保证机器人永远不会一直占着 running 卡死的关键。
const ROBOT_CAPACITY_MAX_WAIT_MS = 15 * 60 * 1000;
// 在等待中主动补代理的最小间隔，避免持续短缺时把上游 API 打爆。
const ROBOT_CAPACITY_REFRESH_MIN_INTERVAL_MS = 60 * 1000;
const TERMINAL_RUN_STATUSES = new Set(['complete', 'partial', 'cancelled', 'failed']);
const REGISTRATION_MAIL_PROVIDERS = new Set(MAIL_INTERFACES);
const PROXY_REFRESH_ROBOT_ID = 'proxy-refresh';
const ACCOUNT_MAINTENANCE_ROBOT_ID = 'account-maintenance';
const REGISTRATION_ROBOT_ID = 'mailcom-register';
const DEFAULT_ACCOUNT_MAINTENANCE_CONFIG = Object.freeze({
  deleteBannedAssets: true,
  archiveSettledAssets: true,
});
const ACCOUNT_MAINTENANCE_CONFIG_FIELDS = Object.freeze([
  { key: 'deleteBannedAssets', label: '清空已注销/封禁组', type: 'boolean' },
  { key: 'archiveSettledAssets', label: '归档已结算登录态', type: 'boolean' },
]);
const DEFAULT_REGISTRATION_CONFIG = Object.freeze(
  normalizeRegistrationRobotConfig({ ...DEFAULT_REGISTRATION_TEMPLATE }),
);
/**
 * How long a scheduled start may be late before it is dropped.
 *
 * A timer that fires after the machine slept, or after the service was down,
 * would otherwise start a registration round for a time that has long passed.
 * Inside this window the start is still what the operator asked for.
 */
const SCHEDULE_LATE_TOLERANCE_MS = 5 * 60 * 1000;

const DEFAULT_ROBOT_DEFINITIONS = Object.freeze([
  {
    id: 'proxy-refresh',
    name: '代理刷新',
    description: '按周期刷新全部国家池 API 来源',
    intervalMs: DEFAULT_INTERVAL_MS,
    defaultEnabled: true,
    executionMode: 'background',
    handler: 'proxy.refresh_all',
    commands: [{ id: 'run_now', label: '立即刷新' }],
  },
  {
    id: ACCOUNT_MAINTENANCE_ROBOT_ID,
    name: '清洗机器人',
    description: '清理已注销/封禁的登录态资产',
    intervalMs: MIN_INTERVAL_MS,
    defaultEnabled: false,
    executionMode: 'background',
    handler: 'account.maintenance',
    configDefaults: DEFAULT_ACCOUNT_MAINTENANCE_CONFIG,
    normalizeConfig: normalizeAccountMaintenanceConfig,
    configFields: ACCOUNT_MAINTENANCE_CONFIG_FIELDS,
    commands: [{ id: 'run_now', label: '立即执行' }],
  },
  {
    id: REGISTRATION_ROBOT_ID,
    name: '注册机器人',
    description: '按模板执行注册，每轮开始前强制刷新代理',
    intervalMs: DEFAULT_INTERVAL_MS,
    oneShot: true,
    defaultEnabled: false,
    executionMode: 'exclusive',
    handler: 'registration.run',
    configDefaults: DEFAULT_REGISTRATION_CONFIG,
    normalizeConfig: normalizeRegistrationRobotConfig,
    configFields: REGISTRATION_TEMPLATE_FIELDS,
    commands: [{ id: 'run_now', label: '立即注册一批' }],
  },
]);

/** The mail interface an operator picked, named the way the picker names it. */
const MAIL_INTERFACE_LABELS = Object.freeze({
  xiaopingguo: 'Xiaopingguo',
  smsbower: 'SMSBower',
  mailcom: 'Mail.com',
  fastmail: 'Fastmail',
  icloud: 'iCloud',
});

function mailInterfaceLabel(provider) {
  const id = String(provider || '').trim().toLowerCase();
  return MAIL_INTERFACE_LABELS[id] || id || '邮箱接口';
}

function asTimestamp(value) {
  if (value === null || value === undefined || value === '') return 0;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeInterval(value, fallback = DEFAULT_INTERVAL_MS) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.trunc(parsed)));
}

function boundedHistory(value) {
  return (Array.isArray(value) ? value : [])
    .filter((entry) => entry && typeof entry === 'object')
    .slice(0, MAX_HISTORY)
    .map(clone);
}

function normalizeAccountMaintenanceConfig(value = {}, options = {}) {
  const strict = options.strict === true;
  const input = value && typeof value === 'object' ? value : {};
  const result = {};
  for (const [key, fallback] of Object.entries(DEFAULT_ACCOUNT_MAINTENANCE_CONFIG)) {
    // Read-migrate the pre-rename key so a robots.json written by an older
    // build keeps its operator choice. Nothing writes it back any more; keys
    // outside DEFAULT_ACCOUNT_MAINTENANCE_CONFIG are dropped on the next save,
    // which is also how the four retired maintenance rules age out.
    const supplied = key === 'deleteBannedAssets' && input[key] === undefined
      ? input.deleteBannedAfterRefresh
      : input[key];
    if (supplied === undefined) {
      result[key] = fallback;
      continue;
    }
    if (typeof supplied !== 'boolean') {
      if (strict) throw new HttpError(400, `Robot config ${key} must be a boolean`);
      result[key] = fallback;
      continue;
    }
    result[key] = supplied;
  }
  return result;
}

function normalizeDefinitionConfig(definition, value, strict = false) {
  if (typeof definition.normalizeConfig === 'function') {
    return clone(definition.normalizeConfig(value, { strict }));
  }
  return value && typeof value === 'object' ? clone(value) : {};
}

function iso(value) {
  const timestamp = asTimestamp(value);
  return timestamp > 0 ? new Date(timestamp).toISOString() : null;
}

function safeRobotId(value) {
  const id = String(value || '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(id)) throw new HttpError(400, 'Invalid robot id');
  return id;
}

function summarizedResult(result) {
  const refresh = result?.refresh;
  if (!refresh || typeof refresh !== 'object') {
    return {
      ok: result?.ok !== false,
      ...(result?.status ? { status: String(result.status) } : {}),
      ...(result?.runId ? { runId: String(result.runId) } : {}),
      ...(Number.isFinite(Number(result?.requested)) ? { requested: Number(result.requested) } : {}),
      ...(Number.isFinite(Number(result?.succeeded)) ? { succeeded: Number(result.succeeded) } : {}),
      ...(Number.isFinite(Number(result?.failed)) ? { failed: Number(result.failed) } : {}),
      ...(Number.isFinite(Number(result?.iterations)) ? { iterations: Number(result.iterations) } : {}),
      ...(Number.isFinite(Number(result?.completedIterations)) ? { completedIterations: Number(result.completedIterations) } : {}),
      ...(Number.isFinite(Number(result?.refreshes)) ? { refreshes: Number(result.refreshes) } : {}),
      ...(result?.provider ? { provider: String(result.provider) } : {}),
      ...(result?.proxyMode ? { proxyMode: String(result.proxyMode) } : {}),
      ...(result?.proxyDistribution ? { proxyDistribution: String(result.proxyDistribution) } : {}),
      ...(result?.countryCode ? { countryCode: String(result.countryCode) } : {}),
      ...(result?.reason ? { reason: scrubString(result.reason) } : {}),
      // The maintenance robot has no `refresh` block, so its counters are
      // projected here. This is an allow-list: a counter that is not named
      // here is dropped without a word, which is how `deletedBanned` was once
      // lost, and how `archivedSettled` reported a run that moved 4081
      // accounts as `{ok: true, deletedBanned: 0}` — a robot that looked like
      // it had done nothing. Add the key here when adding a counter.
      ...(Number.isFinite(Number(result?.deletedBanned)) ? { deletedBanned: Number(result.deletedBanned) } : {}),
      ...(Number.isFinite(Number(result?.archivedSettled)) ? { archivedSettled: Number(result.archivedSettled) } : {}),
    };
  }
  const recovery = result?.recovery && typeof result.recovery === 'object'
    ? {
      runId: String(result.recovery.runId || ''),
      resumed: result.recovery.resumed === true,
      ...(result.recovery.queued ? { queued: true } : {}),
      ...(result.recovery.skipped ? { skipped: true } : {}),
      ...(result.recovery.refreshFailed ? { refreshFailed: true } : {}),
      ...(result.recovery.status ? { status: String(result.recovery.status) } : {}),
    }
    : null;
  return {
    requested: Number(refresh.requested || 0),
    succeeded: Number(refresh.succeeded || 0),
    failed: Number(refresh.failed || 0),
    pulled: Number(refresh.pulled || 0),
    skipped: String(refresh.skipped || ''),
    // The per-source verdicts used to be dropped here, leaving a run record
    // that said `failed: 8` and gave no way to find out why. Only the fields
    // an operator reads are kept, and only for sources that have something to
    // report.
    ...(Array.isArray(refresh.results) && refresh.results.length ? {
      sources: refresh.results
        .filter((entry) => entry && (entry.ok !== true || entry.skippedLines))
        .slice(0, 40)
        .map((entry) => ({
          countryCode: String(entry.countryCode || ''),
          ok: entry.ok === true,
          pulled: Number(entry.pulled || 0),
          ...(entry.skippedLines ? { skippedLines: Number(entry.skippedLines) } : {}),
          ...(entry.error ? { error: scrubString(entry.error) } : {}),
        })),
    } : {}),
    ...(recovery ? { recovery } : {}),
  };
}

function resultStatus(result) {
  const explicit = String(result?.status || '').toLowerCase();
  if (explicit === 'complete' || explicit === 'success') return 'success';
  if (explicit === 'partial') return 'partial';
  if (explicit === 'failed') return 'failed';
  if (explicit === 'cancelled' || explicit === 'canceled') return 'cancelled';
  if (explicit === 'skipped') return 'skipped';
  const failed = Number(result?.refresh?.failed || 0);
  return failed > 0 ? 'partial' : 'success';
}

/**
 * Grade a full proxy refresh.
 *
 * Only the proxy robot uses this. The generic rule above says "any failure is
 * partial", which for a refresh meant every source being down still reported
 * 部分来源未完成 — a green-ish verdict on an outage that pulled nothing. Other
 * robots carry a `refresh` block incidentally, so this is applied by the
 * handler rather than inferred from the shape.
 */
function proxyRefreshStatus(refresh = {}) {
  if (refresh.cancelled === true) return 'cancelled';
  // "No sources configured" is not work done well.
  if (String(refresh.skipped || '')) return 'skipped';
  const requested = Number(refresh.requested || 0);
  const failed = Number(refresh.failed || 0);
  if (!requested) return 'skipped';
  if (failed >= requested) return 'failed';
  return failed > 0 ? 'partial' : 'success';
}

function terminalStatus(value, fallback = 'failed') {
  const status = String(value || '').toLowerCase();
  return TERMINAL_RUN_STATUSES.has(status) ? status : fallback;
}

function isBannedAsset(asset = {}) {
  // `sold` deliberately preserves the sale shelf after deactivation, but the
  // cleanup robot must still remove the unusable credential.
  return assetLifecycle(asset) === 'banned' || isDeactivated(asset);
}

class RobotService extends EventEmitter {
  constructor(options = {}) {
    super();
    this.cwd = path.resolve(options.cwd || process.cwd());
    this.configService = options.configService;
    this.proxyService = options.proxyService;
    this.runManager = options.runManager;
    this.chainService = options.chainService;
    // Optional: clearing a robot's history also clears the task logs it caused.
    this.logStore = options.logStore || null;
    this.now = options.now || Date.now;
    this.busyPollMs = Math.max(250, Number(options.busyPollMs || 1000));
    // How long a round waits for a resource shortage to clear before giving
    // up. A constant in production; an option so a test does not have to sit
    // through fifteen real minutes to prove the give-up happens.
    this.capacityMaxWaitMs = Math.max(0, Number(options.capacityMaxWaitMs ?? ROBOT_CAPACITY_MAX_WAIT_MS));
    this.capacityPollMs = Math.max(1, Number(options.capacityPollMs ?? ROBOT_CAPACITY_POLL_MS));
    // The registration robot's clock schedule, which runs whether or not the
    // robot is "enabled": it is one-shot, so idle is its resting state.
    this.registrationScheduleTimer = null;
    this.definitions = new Map(
      (Array.isArray(options.definitions) ? options.definitions : DEFAULT_ROBOT_DEFINITIONS)
        .map((definition) => [safeRobotId(definition.id), {
          id: safeRobotId(definition.id),
          name: String(definition.name || definition.id),
          description: String(definition.description || ''),
           intervalMs: normalizeInterval(definition.intervalMs),
           oneShot: definition.oneShot === true,
           defaultEnabled: definition.defaultEnabled !== false,
           executionMode: definition.executionMode === 'background' ? 'background' : 'exclusive',
           handler: String(definition.handler || definition.id),
          configDefaults: clone(definition.configDefaults || {}),
          normalizeConfig: definition.normalizeConfig,
          configFields: clone(definition.configFields || []),
          commands: Array.isArray(definition.commands)
            ? definition.commands.map((command) => ({
              id: String(command.id || '').trim(),
              label: String(command.label || command.id || '').trim(),
            })).filter((command) => command.id)
            : [{ id: 'run_now', label: '立即执行' }],
        }]),
    );
    this.handlers = new Map(Object.entries(options.handlers || {}));
    if (!this.handlers.has('proxy.refresh_all')) {
      this.handlers.set('proxy.refresh_all', (context) => this.refreshAllProxies(context));
    }
    if (!this.handlers.has('registration.run')) {
      this.handlers.set('registration.run', (context) => this.runRegistration(context));
    }
    if (!this.handlers.has('account.maintenance')) {
      this.handlers.set('account.maintenance', (context) => this.runAccountMaintenance(context));
    }
    this.states = new Map();
    this.timers = new Map();
    this.busyWatchers = new Map();
    this.inFlight = new Map();
    this.proxyRecoveryQueue = new Set();
    this.controllers = new Map();
    // Last time a progress update was emitted, per robot. See `setProgress`.
    this.progressEmittedAt = new Map();
    // Shared in-flight full refresh; see `pullAllProxiesShared`.
    this.proxyRefreshFlight = null;
    this.proxyRefreshFlightCountries = null;
    // When the last full refresh succeeded, so repeat triggers can reuse it.
    this.proxyRefreshedAt = 0;
    this.closed = false;
    this.statePath = options.statePath
      ? resolveInside(this.cwd, options.statePath)
      : this.defaultStatePath();
    this.load();
    this.runFinishedListener = () => this.wakeWaitingRobots();
    this.runWaitingListener = (event) => this.handleRunWaiting(event);
    if (typeof this.runManager?.on === 'function') {
      this.runManager.on('runFinished', this.runFinishedListener);
      this.runManager.on('runWaiting', this.runWaitingListener);
    }
    if (options.autostart !== false) this.start();
  }

  defaultStatePath() {
    const configured = this.configService?.readRaw?.().output?.stateDir || '.gpt-re-state/v2';
    return resolveInside(this.cwd, path.join(configured, 'robots.json'));
  }

  emptyState(definition, persisted = {}) {
    const intervalMs = normalizeInterval(persisted.intervalMs, definition.intervalMs);
    const enabled = persisted.enabled === undefined ? definition.defaultEnabled : persisted.enabled === true;
    let history = boundedHistory(persisted.history);
    const lastRun = persisted.lastRun && typeof persisted.lastRun === 'object' ? clone(persisted.lastRun) : null;
    const config = this.normalizeRobotConfig(definition, persisted.config || definition.configDefaults || {}, false, { migrateLegacy: true });
    const recoveringInterruptedRun = lastRun?.status === 'running' && !lastRun.finishedAt;
    if (recoveringInterruptedRun) {
      // The process was killed mid-run, so `execute`'s finally never closed this
      // record out. Left as-is it stays `running` forever, and because the live
      // flags are all false the robot then reports "running" permanently while
      // doing nothing — it looks broken when it is merely due. Settle it here.
      lastRun.status = 'interrupted';
      lastRun.finishedAt = new Date(this.now()).toISOString();
      lastRun.error = lastRun.error || '进程在这一轮运行中被终止（多半是重启），该轮结果未知';
      const index = history.findIndex((entry) => entry.id === lastRun.id);
      if (index >= 0) history[index] = clone(lastRun);
      else history.unshift(clone(lastRun));
      history = boundedHistory(history);
    }
    const nextRunAt = enabled
      ? (recoveringInterruptedRun ? this.now() : (asTimestamp(persisted.nextRunAt) || this.now() + intervalMs))
      : 0;
    // An interrupted run is finished business: the robot is due, not running.
    const lastStatus = recoveringInterruptedRun ? 'scheduled' : String(lastRun?.status || '');
    return {
      id: definition.id,
      enabled,
      intervalMs,
      status: enabled ? (lastStatus || 'scheduled') : 'idle',
      pendingRun: false,
      pendingReason: '',
      pendingCommand: '',
      pendingPayload: {},
      running: false,
      waiting: false,
      waitingReason: '',
      waitingDetail: '',
      stopping: false,
      // Live only, like `running` and `waiting`: a progress reading from a run
      // that is no longer happening is worse than no reading at all.
      progress: null,
      nextRunAt,
      lastRun,
      history,
      lastError: String(lastRun?.error || ''),
      config,
      // What the last scheduled start did — began a round, or was turned away
      // because something else held the task slot. Persisted, because the
      // whole point of a skip is that nobody was watching when it happened.
      lastSchedule: definition.id === REGISTRATION_ROBOT_ID
        && persisted.lastSchedule && typeof persisted.lastSchedule === 'object'
        ? clone(persisted.lastSchedule)
        : null,
    };
  }

  registrationConfiguredProvider() {
    try {
      const provider = String(this.configService?.normalized?.()?.mail?.provider || '').trim().toLowerCase();
      if (REGISTRATION_MAIL_PROVIDERS.has(provider)) return provider;
    } catch {
      // A malformed global config must not prevent the robot state from loading.
    }
    return DEFAULT_REGISTRATION_TEMPLATE.mailInterface;
  }

  normalizeRobotConfig(definition, value, strict = false, options = {}) {
    const input = definition.id === REGISTRATION_ROBOT_ID && options.migrateLegacy === true
      ? migrateRegistrationRobotConfig(value, this.registrationConfiguredProvider())
      : value;
    return normalizeDefinitionConfig(definition, input, strict);
  }

  load() {
    let persisted = {};
    let shouldPersist = false;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      persisted = parsed?.robots && typeof parsed.robots === 'object' ? parsed.robots : {};
      shouldPersist = Object.values(persisted).some((robot) => (
        (Array.isArray(robot?.history) && robot.history.length > MAX_HISTORY)
        || (robot?.lastRun?.status === 'running' && !robot.lastRun.finishedAt)
      ));
    } catch (error) {
      if (error.code !== 'ENOENT') persisted = {};
    }
    for (const definition of this.definitions.values()) {
      const persistedRobot = persisted[definition.id] || {};
      const state = this.emptyState(definition, persistedRobot);
      this.states.set(definition.id, state);
      if (Object.hasOwn(persistedRobot, 'config') && JSON.stringify(persistedRobot.config) !== JSON.stringify(state.config)) {
        shouldPersist = true;
      }
    }
    if (shouldPersist) this.persist();
  }

  start() {
    if (this.closed) return;
    for (const state of this.states.values()) {
      if (state.enabled) this.schedule(state.id);
    }
    this.armRegistrationSchedule();
    const recoveryRunId = this.proxyRecoveryWaitRunId();
    const proxyRobot = this.states.get(PROXY_REFRESH_ROBOT_ID);
    if (recoveryRunId && proxyRobot?.enabled && !proxyRobot.running && !proxyRobot.pendingRun && !this.inFlight.has(PROXY_REFRESH_ROBOT_ID)) {
      this.requestRun(PROXY_REFRESH_ROBOT_ID, 'task_recovery', {
        force: true,
        commandId: 'run_now',
        resumeRunId: recoveryRunId,
        payload: { resumeRunId: recoveryRunId, waitReason: 'proxy_pool' },
      });
    }
  }

  async shutdown() {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.controllers.values()) {
      if (!controller.signal.aborted) controller.abort('shutdown');
    }
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const timer of this.busyWatchers.values()) clearTimeout(timer);
    if (this.registrationScheduleTimer) clearTimeout(this.registrationScheduleTimer);
    this.registrationScheduleTimer = null;
    this.timers.clear();
    this.busyWatchers.clear();
    if (typeof this.runManager?.off === 'function') {
      this.runManager.off('runFinished', this.runFinishedListener);
      this.runManager.off('runWaiting', this.runWaitingListener);
    }
    await Promise.allSettled([...this.inFlight.values()]);
  }

  persist() {
    const robots = {};
    for (const state of this.states.values()) {
      robots[state.id] = {
        enabled: state.enabled,
        intervalMs: state.intervalMs,
        config: state.config,
        nextRunAt: state.nextRunAt || null,
        lastRun: state.lastRun,
        history: state.history.slice(0, MAX_HISTORY),
      };
      if (state.id === REGISTRATION_ROBOT_ID && state.lastSchedule) {
        robots[state.id].lastSchedule = clone(state.lastSchedule);
      }
    }
    try {
      atomicWriteText(this.statePath, `${JSON.stringify({ schemaVersion: ROBOT_SCHEMA_VERSION, robots }, null, 2)}\n`);
    } catch {
      // A transient state-file lock must not stop a refresh robot. The live
      // state remains authoritative and the next mutation retries persistence.
    }
  }

  emitUpdate() {
    this.emit('updated', this.snapshot());
  }

  isBusy(taskKind = '') {
    const slot = taskKind && typeof this.runManager?.taskSlot === 'function'
      ? this.runManager.taskSlot({ taskKind })
      : '';
    if (slot && typeof this.runManager?.isTaskSlotBusy === 'function') {
      try { return this.runManager.isTaskSlotBusy(slot); } catch { return true; }
    }
    if (typeof this.runManager?.isBusy === 'function') {
      try { return this.runManager.isBusy(); } catch { return true; }
    }
    if (this.runManager?.starting || this.runManager?.active) return true;
    try { return Array.isArray(this.runManager?.unresolved?.()) && this.runManager.unresolved().length > 0; } catch { return true; }
  }

  isBackgroundRobot(id) {
    return this.definitions.get(String(id || ''))?.executionMode === 'background';
  }

  isOccupied(excludeRobotId = '', taskKind = '') {
    const effectiveTaskKind = taskKind || (excludeRobotId === REGISTRATION_ROBOT_ID ? 'register_session' : '');
    return this.isBusy(effectiveTaskKind) || [...this.states.values()].some((state) => (
      state.id !== excludeRobotId
      && state.running
      && !this.isBackgroundRobot(state.id)
    ));
  }

  isRobotBlockedByTask(id, options = {}) {
    return !this.isBackgroundRobot(id)
      && this.isOccupied(id)
      && options.canRecoverWaitingTask !== true
      && !this.canRefreshWhileTaskPaused(id);
  }

  pendingRunOptions(state) {
    const reason = state.pendingReason || 'interval';
    return {
      force: reason === 'run_now' || reason === 'start',
      commandId: state.pendingCommand || reason,
      payload: clone(state.pendingPayload || {}),
    };
  }

  canRefreshWhileTaskPaused(id) {
    if (String(id || '') !== PROXY_REFRESH_ROBOT_ID) return false;
    if (this.runManager?.active || this.runManager?.starting) return false;
    if ([...this.states.values()].some((state) => state.id !== id && state.running)) return false;
    try {
      const unresolved = this.runManager?.unresolved?.();
      return Array.isArray(unresolved)
        && unresolved.length > 0
        && unresolved.every((run) => String(run?.status || '') === 'paused');
    } catch {
      return false;
    }
  }

  proxyRecoveryWaitRunId() {
    try {
      const unresolved = this.runManager?.unresolved?.();
      if (!Array.isArray(unresolved)) return '';
      const matches = unresolved.filter((summary) => (
        ['waiting', 'paused'].includes(String(summary?.status || '').toLowerCase())
        && Boolean(proxyRecoveryWaitDetails(summary))
      ));
      return String(matches[0]?.runId || '').trim();
    } catch {
      return '';
    }
  }

  canRefreshWaitingRun(runId) {
    const targetId = String(runId || '').trim();
    if (!targetId) return false;
    try {
      const unresolved = this.runManager?.unresolved?.();
      if (!Array.isArray(unresolved)) return false;
      const summary = unresolved.find((candidate) => String(candidate?.runId || '') === targetId);
      return String(summary?.runId || '') === targetId
        && ['waiting', 'paused'].includes(String(summary?.status || '').toLowerCase())
        && Boolean(proxyRecoveryWaitDetails(summary));
    } catch {
      return false;
    }
  }

  isRunResumeBlocked(error) {
    const status = Number(error?.status || error?.statusCode || 0);
    const code = String(error?.code || error?.details?.code || '').toUpperCase();
    return status === 409
      && (['MAIN_TASK_CAPACITY', 'AUXILIARY_TASK_CAPACITY'].includes(code)
        || /active|starting|capacity|slot|busy/i.test(String(error?.message || '')));
  }

  queueProxyRecovery(runId) {
    const id = String(runId || '').trim();
    if (id) this.proxyRecoveryQueue.add(id);
  }

  async resumeProxyWaitingRun(runId, refreshed, options = {}) {
    const targetId = String(runId || '').trim();
    if (!targetId) return refreshed;
    if (!this.canRefreshWaitingRun(targetId)) {
      return { ...refreshed, recovery: { runId: targetId, resumed: false, skipped: true } };
    }
    try {
      const resumed = await this.runManager.resume(targetId, { refreshProxySnapshot: true });
      return {
        ...refreshed,
        recovery: {
          runId: targetId,
          resumed: true,
          status: String(resumed?.status || 'running'),
          ...(options.refreshFailed ? { refreshFailed: true } : {}),
        },
      };
    } catch (error) {
      if (!this.isRunResumeBlocked(error)) throw error;
      // A different main-slot run is allowed to finish. The proxy robot has
      // already done its useful work; retry the targeted resume on that run's
      // completion instead of holding the whole registration batch hostage.
      this.queueProxyRecovery(targetId);
      return {
        ...refreshed,
        recovery: {
          runId: targetId,
          resumed: false,
          queued: true,
          status: 'waiting',
          ...(options.refreshFailed ? { refreshFailed: true } : {}),
        },
      };
    }
  }

  handleRunWaiting(event = {}) {
    if (this.closed || event.proxyRecovery !== true) return;
    const runId = String(event.runId || '').trim();
    const state = this.states.get(PROXY_REFRESH_ROBOT_ID);
    if (!runId || !state?.enabled || state.running || !this.canRefreshWaitingRun(runId)) return;
    this.clearBusyWatcher(state.id);
    this.requestRun(state.id, 'task_recovery', {
      force: true,
      commandId: 'run_now',
      resumeRunId: runId,
      payload: {
        resumeRunId: runId,
        waitReason: String(event.reason || 'proxy_pool'),
      },
    });
  }

  snapshot() {
    return {
      schemaVersion: ROBOT_SCHEMA_VERSION,
      taskBusy: this.isBusy(),
      activeRunId: typeof this.runManager?.primaryActiveRunId === 'function' ? this.runManager.primaryActiveRunId() : (this.runManager?.active?.state?.runId || ''),
      activeRunIds: typeof this.runManager?.activeRunIds === 'function' ? this.runManager.activeRunIds() : [],
      taskCapacity: typeof this.runManager?.taskCapacitySnapshot === 'function' ? this.runManager.taskCapacitySnapshot() : null,
      robots: [...this.states.keys()].map((id) => this.publicRobot(id)),
    };
  }

  publicRobot(id) {
    const state = this.getState(id);
    const definition = this.definitions.get(state.id);
    return {
      id: state.id,
      name: definition.name,
      description: definition.description,
      config: clone(state.config),
      ...(state.id === REGISTRATION_ROBOT_ID ? {
        schedule: {
          next: (() => {
            const next = this.nextRegistrationSchedule();
            return next ? { templateId: next.templateId, name: next.name, at: iso(next.at) } : null;
          })(),
          upcoming: this.registrationScheduleEntries()
            .slice(0, 4)
            .map((entry) => ({ templateId: entry.templateId, name: entry.name, at: iso(entry.at) })),
          last: clone(state.lastSchedule),
        },
      } : {}),
      configurable: definition.configFields.length > 0,
      configFields: clone(definition.configFields),
      enabled: state.enabled,
      intervalMs: state.intervalMs,
       status: state.stopping && state.running
         ? 'stopping'
         : (state.waiting ? 'waiting' : (state.running ? 'running' : (state.pendingRun ? 'waiting' : state.status))),
       stopping: state.stopping === true,
      pendingRun: state.pendingRun,
      waitingReason: state.waitingReason,
      waitingDetail: state.waitingDetail,
      progress: state.running && state.progress ? clone(state.progress) : null,
      nextRunAt: state.enabled && state.nextRunAt ? iso(state.nextRunAt) : null,
      lastError: state.lastError,
      lastRun: clone(state.lastRun),
      runs: clone(state.history),
      commands: clone(definition.commands),
    };
  }

  getState(id) {
    const safeId = safeRobotId(id);
    const state = this.states.get(safeId);
    if (!state) throw new HttpError(404, `Robot not found: ${safeId}`);
    return state;
  }

  getDefinition(id) {
    const safeId = safeRobotId(id);
    const definition = this.definitions.get(safeId);
    if (!definition) throw new HttpError(404, `Robot not found: ${safeId}`);
    return definition;
  }

  list() {
    return this.snapshot();
  }

  runs(id) {
    const state = this.getState(id);
    return { robotId: state.id, runs: clone(state.history) };
  }

  clearRuns(id) {
    const state = this.getState(id);
    const result = this.clearStateHistory(state);
    if (result.changed) {
      this.persist();
      this.emitUpdate();
    }
    return {
      robotId: state.id,
      removed: result.removed,
      logsRemoved: result.logsRemoved,
      robot: this.publicRobot(state.id),
    };
  }

  clearAllRuns() {
    let removed = 0;
    let logsRemoved = 0;
    let changed = false;
    for (const state of this.states.values()) {
      const result = this.clearStateHistory(state);
      removed += result.removed;
      logsRemoved += result.logsRemoved;
      changed = changed || result.changed;
    }
    if (changed) {
      this.persist();
      this.emitUpdate();
    }
    return {
      removed,
      logsRemoved,
      robots: [...this.states.keys()].map((id) => this.publicRobot(id)),
    };
  }

  /**
   * Every task run this robot's history points at.
   *
   * A robot that does real work launches an ordinary task, and that task's
   * events go to the log store under its own run id. The robot only keeps a
   * one-line summary, so clearing history freed a few kilobytes of
   * `robots.json` and left the megabytes of JSONL it had caused untouched —
   * which is not what "清空运行日志" reads as.
   */
  runIdsFor(state) {
    const ids = new Set();
    for (const entry of [state.lastRun, ...(state.history || [])]) {
      const runId = String(entry?.result?.runId || '').trim();
      if (runId) ids.add(runId);
      const recoveryId = String(entry?.result?.recovery?.runId || '').trim();
      if (recoveryId) ids.add(recoveryId);
    }
    return [...ids];
  }

  clearStateHistory(state) {
    const removed = state.history.length;
    const changed = removed > 0 || Boolean(state.lastRun || state.lastError);
    // Collected before the history is dropped, and only for runs that have
    // finished: a live task keeps its log.
    const logRunIds = this.runIdsFor(state)
      .filter((runId) => !this.runManager?.activeRun?.(runId));
    let logsRemoved = 0;
    for (const runId of logRunIds) {
      try {
        if (this.logStore?.remove?.(runId)) logsRemoved += 1;
      } catch { /* A log that will not delete must not block clearing history. */ }
    }
    state.history = [];
    state.lastRun = null;
    state.lastError = '';
    if (!state.running && !state.waiting && !state.pendingRun) {
      state.status = state.enabled ? 'scheduled' : 'idle';
    }
    return { removed, changed: changed || logsRemoved > 0, logsRemoved };
  }

  startRobot(id) {
    const state = this.getState(id);
    state.enabled = true;
    state.stopping = false;
    state.nextRunAt = this.now();
    state.status = 'scheduled';
    this.persist();
    this.emitUpdate();
    this.requestRun(state.id, 'start', { force: true, commandId: 'start' });
    return this.publicRobot(state.id);
  }

  stopRobot(id) {
    const state = this.getState(id);
    state.enabled = false;
    state.nextRunAt = 0;
    state.pendingRun = false;
    state.pendingReason = '';
    state.pendingCommand = '';
    state.pendingPayload = {};
    this.clearTimer(state.id);
    this.clearBusyWatcher(state.id);
    const controller = this.controllers.get(state.id);
    if (controller && !controller.signal.aborted) controller.abort('stop');
    state.stopping = state.running;
    if (!state.running) state.status = 'idle';
    else state.status = 'stopping';
    this.persist();
    this.emitUpdate();
    return this.publicRobot(state.id);
  }

  patchRobot(id, payload = {}) {
    const state = this.getState(id);
    const definition = this.getDefinition(state.id);
    const nextConfig = Object.hasOwn(payload, 'config')
      ? this.normalizeRobotConfig(definition, payload.config, true)
      : state.config;
    if (Object.hasOwn(payload, 'intervalMs')) {
      const requested = Number(payload.intervalMs);
      if (!Number.isFinite(requested) || requested < MIN_INTERVAL_MS || requested > MAX_INTERVAL_MS) {
        throw new HttpError(400, `Robot interval must be between ${MIN_INTERVAL_MS} and ${MAX_INTERVAL_MS} ms`);
      }
      state.intervalMs = normalizeInterval(requested);
      if (state.enabled) state.nextRunAt = this.now() + state.intervalMs;
    }
    state.config = nextConfig;
    // Saved times are the schedule, so the timer is re-armed from them here
    // rather than only at startup.
    if (state.id === REGISTRATION_ROBOT_ID) this.armRegistrationSchedule();
    if (Object.hasOwn(payload, 'enabled')) {
      return payload.enabled === true ? this.startRobot(state.id) : this.stopRobot(state.id);
    }
    if (state.enabled) this.schedule(state.id);
    this.persist();
    this.emitUpdate();
    return this.publicRobot(state.id);
  }

  command(id, command, payload = {}) {
    const state = this.getState(id);
    const definition = this.getDefinition(state.id);
    const commandId = String(command || '').trim();
    if (!definition.commands.some((entry) => entry.id === commandId)) {
      throw new HttpError(400, `Robot command is not supported: ${commandId || 'empty'}`);
    }
    if (commandId === 'run_now') return this.requestRun(state.id, 'run_now', { force: true, payload, commandId });
    return this.requestRun(state.id, commandId, { force: true, payload, commandId });
  }

  requestRun(id, reason, options = {}) {
    const state = this.getState(id);
    if (this.closed) throw new HttpError(409, 'Robot service is shutting down');
    const force = options.force === true;
    const resumeRunId = String(options.resumeRunId || '').trim();
    const canRecoverWaitingTask = resumeRunId && this.canRefreshWaitingRun(resumeRunId);
    if (!force && !state.enabled) return this.publicRobot(state.id);
    const blockedByTask = this.isRobotBlockedByTask(state.id, { canRecoverWaitingTask });
    if (state.running || blockedByTask) {
      state.pendingRun = true;
      state.pendingReason = String(reason || 'interval');
      state.pendingCommand = String(options.commandId || reason || 'interval');
      const nextPayload = options.payload && typeof options.payload === 'object' ? clone(options.payload) : {};
      const previousPayload = state.pendingPayload && typeof state.pendingPayload === 'object' ? state.pendingPayload : {};
      state.pendingPayload = { ...previousPayload, ...nextPayload };
      if (Array.isArray(previousPayload.assetIds) || Array.isArray(nextPayload.assetIds)) {
        state.pendingPayload.assetIds = [...new Set([
          ...(Array.isArray(previousPayload.assetIds) ? previousPayload.assetIds : []),
          ...(Array.isArray(nextPayload.assetIds) ? nextPayload.assetIds : []),
        ].map((value) => String(value || '').trim()).filter(Boolean))].slice(0, MAX_ROBOT_BATCH_SIZE);
      }
      state.nextRunAt = 0;
      state.status = 'waiting';
      this.clearTimer(state.id);
      this.watchBusy(state.id);
      this.persist();
      this.emitUpdate();
      return this.publicRobot(state.id);
    }
    this.execute(state.id, reason, options.payload || {}, options.commandId || reason || 'interval');
    return this.publicRobot(state.id);
  }

  resolveHandler(definition) {
    const handler = this.handlers.get(definition.handler);
    if (typeof handler !== 'function') throw new Error(`Robot handler is not registered: ${definition.handler}`);
    return handler;
  }

  async refreshAllProxies(context = {}) {
    if (!this.proxyService || typeof this.proxyService.pullAll !== 'function') {
      throw new Error('Proxy refresh service is unavailable');
    }
    const explicitResumeRunId = String(context.payload?.resumeRunId || '').trim();
    const resumeRunId = explicitResumeRunId || this.proxyRecoveryWaitRunId();
    const countryCodes = [...new Set((Array.isArray(context.payload?.countryCodes)
      ? context.payload.countryCodes
      : context.payload?.countryCode
        ? [context.payload.countryCode]
        : [])
      .map((countryCode) => String(countryCode || '').trim().toUpperCase())
      .filter((countryCode) => countryCode && countryCode !== 'GLOBAL'))];
    let refreshed;
    try {
      refreshed = await this.pullAllProxiesShared({
        allowEmpty: true,
        ...(countryCodes.length ? { countryCodes } : {}),
        // Without this a stop request, and server shutdown, both sit through
        // the remaining sources' full timeouts.
        signal: context.signal,
        onProgress: (progress) => context.reportProgress?.({
          done: progress.done,
          total: progress.total,
          label: progress.label ? `${progress.label} ${progress.done}/${progress.total}` : `${progress.done}/${progress.total}`,
        }),
      });
    } catch (error) {
      // A refresh request can fail for the same network reason that parked the
      // task. Resume the one guarded continuation anyway; if the route is still
      // unusable, the branch skips the account instead of staying parked.
      if (!resumeRunId || !this.canRefreshWaitingRun(resumeRunId)) throw error;
      return this.resumeProxyWaitingRun(resumeRunId, {
        refresh: { requested: 0, succeeded: 0, failed: 1, pulled: 0 },
      }, { refreshFailed: true });
    }
    const graded = { ...refreshed, status: proxyRefreshStatus(refreshed.refresh || {}) };
    if (graded.status === 'success' || graded.status === 'partial') {
      this.proxyRefreshedAt = this.now();
      if (typeof this.runManager?.refreshActiveProxySnapshots === 'function') {
        try {
          graded.activeRunRefresh = await this.runManager.refreshActiveProxySnapshots({
            countryCodes,
            reason: String(context.reason || context.command || 'proxy_robot_refresh'),
          });
        } catch (error) {
          graded.activeRunRefresh = {
            updated: [],
            skipped: [],
            failed: [{ code: String(error?.code || 'ACTIVE_RUN_PROXY_REFRESH_FAILED'), message: String(error?.message || error) }],
          };
        }
      }
    }
    if (!resumeRunId) return graded;
    return this.resumeProxyWaitingRun(resumeRunId, graded);
  }

  /**
   * A proxy refresh that piggybacks on one already running.
   *
   * `RunManager` deduplicates its own refreshes, but the robot did not take
   * part: if a task-driven refresh, or a click on the proxies page, was in
   * flight, `pullAll` threw a 409 and the whole robot run failed — with no
   * retry until the next interval ten minutes later. Sharing the in-flight
   * promise turns that collision into a wait.
   */
  async pullAllProxiesShared(options = {}) {
    const requestedCountries = new Set((Array.isArray(options.countryCodes) ? options.countryCodes : [])
      .map((countryCode) => String(countryCode || '').trim().toUpperCase())
      .filter(Boolean));
    for (;;) {
      if (this.proxyRefreshFlight) {
        const activeCountries = this.proxyRefreshFlightCountries;
        const coversRequest = requestedCountries.size
          ? (!activeCountries || [...requestedCountries].every((countryCode) => activeCountries.has(countryCode)))
          : !activeCountries;
        if (coversRequest) return this.proxyRefreshFlight;
        try { await this.proxyRefreshFlight; } catch { /* The requested scope still needs its own refresh. */ }
        continue;
      }
      const flight = (async () => this.proxyService.pullAll(options))();
      this.proxyRefreshFlight = flight;
      this.proxyRefreshFlightCountries = requestedCountries.size ? requestedCountries : null;
      try {
        return await flight;
      } finally {
        if (this.proxyRefreshFlight === flight) {
          this.proxyRefreshFlight = null;
          this.proxyRefreshFlightCountries = null;
        }
      }
    }
  }

  setWaiting(id, reason, detail = '') {
    const state = this.getState(id);
    const nextReason = String(reason || 'waiting');
    const nextDetail = String(detail || '');
    if (state.waiting && state.waitingReason === nextReason && state.waitingDetail === nextDetail) return;
    state.waiting = true;
    state.waitingReason = nextReason;
    state.waitingDetail = nextDetail;
    state.status = 'waiting';
    this.persist();
    this.emitUpdate();
  }

  /**
   * Report how far into a run a robot is.
   *
   * Nothing else in the service exposes progress: while a run is in flight
   * `lastRun.result` is null, `durationMs` is 0 and `nextRunAt` is 0, so a
   * console can only say "running" and show a spinner. Handlers that know their
   * own shape — the proxy refresh knows it has N sources — call this.
   *
   * Emission is throttled because a fast handler could otherwise push an
   * update per item into every open console; the last update of a run is
   * always emitted so the bar never freezes short of the end.
   */
  setProgress(id, progress) {
    const state = this.states.get(safeRobotId(id));
    if (!state || !state.running) return;
    const total = Math.max(0, Number(progress?.total || 0));
    const done = Math.min(total || Number.MAX_SAFE_INTEGER, Math.max(0, Number(progress?.done || 0)));
    const next = {
      done,
      total,
      label: String(progress?.label || '').slice(0, 120),
      updatedAt: new Date(this.now()).toISOString(),
    };
    const complete = total > 0 && done >= total;
    const since = this.now() - Number(this.progressEmittedAt.get(state.id) || 0);
    state.progress = next;
    if (!complete && since < PROGRESS_EMIT_MIN_INTERVAL_MS) return;
    this.progressEmittedAt.set(state.id, this.now());
    this.emitUpdate();
  }

  setCountdown(id, durationMs, label = '下一轮开始') {
    const state = this.states.get(safeRobotId(id));
    if (!state || !state.running) return;
    const startedAtMs = this.now();
    const total = Math.max(1, Math.trunc(Number(durationMs) || 0));
    state.progress = {
      done: total,
      total,
      label: String(label || '下一轮开始').slice(0, 120),
      mode: 'countdown',
      startedAt: new Date(startedAtMs).toISOString(),
      endsAt: new Date(startedAtMs + total).toISOString(),
      updatedAt: new Date(startedAtMs).toISOString(),
    };
    this.progressEmittedAt.set(state.id, startedAtMs);
    this.emitUpdate();
  }

  clearProgress(id) {
    const state = this.states.get(safeRobotId(id));
    if (!state || !state.running || !state.progress) return;
    state.progress = null;
    this.emitUpdate();
  }

  clearWaiting(id) {
    const state = this.getState(id);
    if (!state.waiting && !state.waitingReason && !state.waitingDetail) return;
    state.waiting = false;
    state.waitingReason = '';
    state.waitingDetail = '';
    // `setWaiting` moved `status` to 'waiting'; clearing the flags without
    // moving it back left the raw state claiming to wait for something it had
    // stopped waiting for. It was invisible only because `publicRobot` prefers
    // `running` while a run is in flight.
    if (state.status === 'waiting') state.status = state.running ? 'running' : (state.enabled ? 'scheduled' : 'idle');
    this.persist();
    this.emitUpdate();
  }

  waitForDelay(ms, signal) {
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = () => {
        cleanup();
        const error = new Error('Robot wait was cancelled');
        error.code = 'ROBOT_WAIT_CANCELLED';
        reject(error);
      };
      timer = setTimeout(() => { cleanup(); resolve(); }, Math.max(0, Number(ms) || 0));
      timer.unref?.();
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  async waitForRobotCapacity(context, plan) {
    const requiredByCountry = new Map();
    for (const assignment of plan.proxyAssignments.filter((candidate) => candidate?.kind === 'countryPool')) {
      const countryCode = String(assignment.countryCode || '').trim().toUpperCase();
      if (countryCode) requiredByCountry.set(countryCode, Number(requiredByCountry.get(countryCode) || 0) + 1);
    }
    const proxyShortages = () => [...requiredByCountry.entries()]
      .map(([countryCode, required]) => {
        const pool = this.proxyService?.list?.()?.dynamic?.countryPools?.find((candidate) => candidate.countryCode === countryCode);
        const available = Number(pool?.total || pool?.entries?.length || 0);
        return { countryCode, required, available };
      })
      .filter((entry) => entry.available < entry.required);
    // Timer for the *shortage* streak only. Reset whenever another run holds the
    // pipeline (legitimate queuing) or capacity is met.
    let shortageStart = 0;
    let lastProxyRefreshAt = 0;
    const beginShortage = () => { if (!shortageStart) shortageStart = this.now(); };
    const overBudget = () => shortageStart && (this.now() - shortageStart) > this.capacityMaxWaitMs;

    while (true) {
      if (context.signal?.aborted) return { ready: false, aborted: true };

      // Another run (a user task or the sibling robot) holds the pipeline. That
      // is normal queuing, not a stall, so wait for it as long as it takes and
      // do not let it count toward the give-up budget.
      if (this.isOccupied(context.robotId, 'register_session')) {
        shortageStart = 0;
        this.setWaiting(context.robotId, 'task', '等待当前任务或其他机器人释放资源');
        await this.waitForDelay(this.capacityPollMs, context.signal);
        continue;
      }

      const shortages = proxyShortages();
      if (shortages.length) {
        beginShortage();
        const detail = shortages.map((entry) => `${entry.countryCode} ${entry.available}/${entry.required}`).join('，');
        if (overBudget()) return { ready: false, reason: `国家池代理长时间不足（${detail}），本轮跳过` };
        this.setWaiting(context.robotId, 'proxy_capacity', `国家池代理 ${detail}`);
        // The scheduled proxy-refresh robot cannot fire while this robot holds
        // `running`, so pull proxies here instead of waiting for a refresh that
        // will never arrive. This is what breaks the two-robot deadlock.
        lastProxyRefreshAt = await this.topUpProxiesDuringWait(
          context,
          lastProxyRefreshAt,
          shortages.map((entry) => entry.countryCode),
        );
        await this.waitForDelay(this.capacityPollMs, context.signal);
        continue;
      }

      try {
        const preflight = await this.runManager.preflight(plan, { forceRefresh: true });
        const mail = preflight?.mail || {};
        const selected = Number(mail.selected || 0);
        const label = mailInterfaceLabel(plan.mailProvider);
        // Current stock does not gate a 挂租 round at all.
        //
        // The broker's whole job is to keep polling and accumulate its target
        // over the life of the round, and the provider restocks in batches, so
        // an empty shelf at this instant says nothing about the next twenty
        // minutes. Preflight already takes this view — `mailReady` for a
        // rental-watch plan checks the provider and the price, not the count —
        // and this was the one place still second-guessing it: a target of 60
        // against a stock of 8 was refused outright, while the same round an
        // hour earlier, started against a stock of 68, went on to rent all 60
        // over the following 54 minutes.
        //
        // The waiting moved into the run, where it is bounded by the broker's
        // own starvation timeout instead of by a launch gate.
        //
        // A permanent selected-domain rejection is more specific than a
        // simultaneous mailbox shortfall; let the domain policy branch below
        // settle it instead of parking the robot on mail_capacity.
        if (plan.mailRentalWatch !== true && selected < plan.mailCount && mail.domainReady !== false) {
          beginShortage();
          if (overBudget()) return { ready: false, reason: `${label} 可用地址长时间不足（${selected}/${plan.mailCount}），本轮跳过` };
          this.setWaiting(context.robotId, 'mail_capacity', `${label} 可用地址 ${selected}/${plan.mailCount}`);
          await this.waitForDelay(this.capacityPollMs, context.signal);
          continue;
        }
        if (mail.domainReady === false) {
          const aliasDomains = mail.aliasDomains || {};
          if (aliasDomains.catalogAvailable === true) {
            const unavailable = Array.isArray(aliasDomains.unavailable) ? aliasDomains.unavailable : [];
            const detail = `${label} 指定域名均不可用：${unavailable.join(', ') || '未提供可用域名'}`;
            this.setWaiting(context.robotId, 'mail_domain_policy', detail);
            return { ready: false, reason: detail };
          }
          beginShortage();
          const detail = aliasDomains.error || `${label} 指定域名目录暂时无法确认`;
          if (overBudget()) return { ready: false, reason: scrubString(detail) };
          this.setWaiting(context.robotId, 'mail_domain_catalog', scrubString(detail));
          await this.waitForDelay(this.capacityPollMs, context.signal);
          continue;
        }
        if (mail.ready !== true) {
          beginShortage();
          if (overBudget()) return { ready: false, reason: `${label} 资源长时间不可用，本轮跳过` };
          this.setWaiting(context.robotId, 'mail_capacity', `${label} 资源未就绪（${selected}/${plan.mailCount}）`);
          await this.waitForDelay(this.capacityPollMs, context.signal);
          continue;
        }
        if (preflight?.proxy?.ready !== true) {
          beginShortage();
          if (overBudget()) return { ready: false, reason: `国家池代理长时间未满足 ${plan.workerConcurrency} 个 Worker，本轮跳过` };
          this.setWaiting(context.robotId, 'proxy_capacity', `国家池代理未满足 ${plan.workerConcurrency} 个 Worker`);
          lastProxyRefreshAt = await this.topUpProxiesDuringWait(context, lastProxyRefreshAt, [...requiredByCountry.keys()]);
          await this.waitForDelay(this.capacityPollMs, context.signal);
          continue;
        }
        return { ready: true };
      } catch (error) {
        if (!this.isRetryableRobotCapacityError(error)) throw error;
        beginShortage();
        if (overBudget()) return { ready: false, reason: scrubString(error?.message || 'mail.com 资源长时间不可用，本轮跳过') };
        this.setWaiting(context.robotId, 'mail_service', scrubString(error?.message || '等待 mail.com 资源恢复'));
        await this.waitForDelay(this.capacityPollMs, context.signal);
      }
    }
  }

  // Refresh proxies from inside a capacity wait, throttled. runRobotOnce runs
  // the proxy-refresh robot directly, bypassing the occupancy guard that would
  // otherwise keep it parked behind this robot. Best effort: a dead proxy
  // source must not crash the waiter — the give-up budget ends the wait if the
  // shortage persists. Returns the new "last refreshed" timestamp.
  async topUpProxiesDuringWait(context, lastRefreshAt, countryCodes = []) {
    const now = this.now();
    if (now - Number(lastRefreshAt || 0) < ROBOT_CAPACITY_REFRESH_MIN_INTERVAL_MS) return lastRefreshAt;
    // A refresh that just succeeded — for any reason, including one this loop
    // triggered a moment ago — is still the freshest view of the pools. A
    // stalled capacity wait used to fire a full eight-source refresh every
    // minute for fifteen minutes.
    if (now - Number(this.proxyRefreshedAt || 0) < ROBOT_CAPACITY_REFRESH_MIN_INTERVAL_MS) return now;
    try {
      await this.runRobotOnce(PROXY_REFRESH_ROBOT_ID, 'capacity_topup', {
        triggeredBy: context.robotId,
        ...(countryCodes.length ? { countryCodes } : {}),
      }, 'run_now', { signal: context.signal });
    } catch {
      // swallowed on purpose; see method comment
    }
    return now;
  }

  isRetryableRobotCapacityError(error) {
    const code = String(error?.code || error?.details?.code || '').toUpperCase();
    const status = Number(error?.status || error?.statusCode || 0);
    if (['NO_ELIGIBLE_MAILBOX', 'COUNTRY_PROXY_POOL_EMPTY', 'COUNTRY_PROXY_POOL_CAPACITY'].includes(code)) return true;
    if (error?.retryable === true || [408, 409, 429].includes(status) || status >= 500) return true;
    return /already active|not ready|no eligible|mailbox.*(short|enough|stock)|country pool/i.test(String(error?.message || ''));
  }

  async waitForRunTerminal(runId, signal, options = {}) {
    if (!runId || typeof this.runManager?.on !== 'function') return { runId, status: 'complete' };
    const continueCurrentTask = options.continueCurrentTask === true;
    return new Promise((resolve) => {
      let settled = false;
      let timer;
      const finish = (summary) => {
        if (settled) return;
        settled = true;
        if (timer) clearInterval(timer);
        this.runManager.off?.('runFinished', onFinished);
        signal?.removeEventListener('abort', onAbort);
        resolve(summary || { runId, status: 'complete' });
      };
      const check = () => {
        if (typeof this.runManager.get !== 'function') return;
        try {
          const summary = this.runManager.get(runId);
          if (TERMINAL_RUN_STATUSES.has(String(summary?.status || ''))) finish(summary);
        } catch { /* The state file may not be visible until the first checkpoint. */ }
      };
      const onFinished = (event) => {
        if (String(event?.runId || '') !== String(runId)) return;
        check();
        if (!settled && TERMINAL_RUN_STATUSES.has(String(event?.status || ''))) finish(event);
      };
      const onAbort = () => {
        // A robot stop only cancels the robot's future scheduling. Once a task
        // has a run id, keep waiting for its own terminal state so resource
        // cleanup and billing can finish normally. Shutdown is different: the
        // service is going away and there is no safe reason to keep waiting.
        if (!continueCurrentTask || signal?.reason === 'shutdown') {
          finish({ runId, status: 'cancelled', shutdown: signal?.reason === 'shutdown' });
        }
      };
      if (signal?.aborted && (!continueCurrentTask || signal.reason === 'shutdown')) {
        finish({ runId, status: 'cancelled', shutdown: signal.reason === 'shutdown' });
        return;
      }
      this.runManager.on('runFinished', onFinished);
      timer = setInterval(check, 500);
      timer.unref?.();
      signal?.addEventListener('abort', onAbort, { once: true });
      check();
    });
  }

  maintenanceAssetStore() {
    return typeof this.runManager?.sessionAssets === 'function'
      ? this.runManager.sessionAssets()
      : null;
  }

  maintenanceChainRecords() {
    if (typeof this.chainService?.snapshot !== 'function') return [];
    return this.chainService.snapshot()?.records || [];
  }

  inFlightAssetIds() {
    try {
      // Robot maintenance has a narrower policy than manual deletion. Keep
      // the fallback for older/custom RunManager implementations.
      const getter = typeof this.runManager?.sessionAssetIdsInFlight === 'function'
        ? this.runManager.sessionAssetIdsInFlight.bind(this.runManager)
        : this.runManager?.sessionAssetIdsInUse?.bind(this.runManager);
      const value = getter?.();
      return new Set(value instanceof Set ? [...value] : Array.isArray(value) ? value : []);
    } catch {
      return new Set();
    }
  }










  deleteBannedAssets() {
    const store = this.maintenanceAssetStore();
    if (!store || typeof store.remove !== 'function') return 0;
    const records = this.maintenanceChainRecords();
    const activeChainIds = new Set(records.filter((record) => record.running).map((record) => String(record.assetId || record.id)));
    const inUse = this.inFlightAssetIds();
    const ids = (store.list?.() || [])
      .filter(isBannedAsset)
      .map((asset) => String(asset.id || ''))
      .filter((id) => id && !inUse.has(id) && !activeChainIds.has(id));
    if (!ids.length) return 0;
    const removed = store.remove(ids, { cascadeCpa: true });
    return removed.removed?.length || 0;
  }



  async runAccountMaintenance(context) {
    const state = this.getState(context.robotId);
    const config = normalizeAccountMaintenanceConfig(state.config, { strict: false });
    const result = { deletedBanned: 0, archivedSettled: 0 };
    if (config.deleteBannedAssets) result.deletedBanned = this.deleteBannedAssets();
    // Sold, locked and a day old: out of the listing, still in the CPA history
    // and still a used address. A rename, so a wrong call costs one move back.
    if (config.archiveSettledAssets && typeof this.runManager?.archiveSettledAssets === 'function') {
      result.archivedSettled = this.runManager.archiveSettledAssets().archived;
    }
    return result;
  }

  async runRobotOnce(id, reason, payload = {}, commandId = 'run_now', options = {}) {
    const signal = options.signal;
    const state = this.getState(id);
    const existing = this.inFlight.get(state.id);
    if (existing) {
      await this.awaitWithSignal(existing, signal);
      const shared = clone(state.lastRun);
      // Riding along on someone else's run does not make its outcome better.
      // Without this, `mailcom_prestart` treated a failed refresh as a success
      // and started a batch on a stale proxy pool.
      if (shared?.status === 'failed') {
        throw new Error(shared.error || `${state.name || state.id} failed`);
      }
      return shared;
    }
    if (state.running) {
      throw new Error(`Robot ${state.id} is running without a tracked operation`);
    }

    // A robot handler can depend on another robot. Run that dependency directly
    // so the parent robot does not make it wait on its own occupancy guard.
    this.clearTimer(state.id);
    this.clearBusyWatcher(state.id);
    const promise = this.execute(state.id, reason, payload, commandId);
    await this.awaitWithSignal(promise, signal);
    const lastRun = clone(state.lastRun);
    if (lastRun?.status === 'failed') {
      throw new Error(lastRun.error || `${state.name || state.id} failed`);
    }
    return lastRun;
  }

  async awaitWithSignal(operation, signal) {
    if (!signal) return operation;
    if (signal.aborted) {
      const error = new Error('Robot wait was cancelled');
      error.code = 'ROBOT_WAIT_CANCELLED';
      throw error;
    }
    let onAbort;
    const aborted = new Promise((resolve, reject) => {
      onAbort = () => {
        const error = new Error('Robot wait was cancelled');
        error.code = 'ROBOT_WAIT_CANCELLED';
        reject(error);
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      return await Promise.race([operation, aborted]);
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  registrationProvider(interfaceId = DEFAULT_REGISTRATION_TEMPLATE.mailInterface) {
    const requested = String(interfaceId || '').trim().toLowerCase();
    if (!REGISTRATION_MAIL_PROVIDERS.has(requested)) {
      throw new HttpError(409, `Unsupported registration mail interface: ${requested || 'empty'}`);
    }
    return requested;
  }

  registrationPlan(config, proxyCatalog = null, templateId = '') {
    const settings = this.registrationSettings(config, templateId);
    const provider = this.registrationProvider(settings.mailInterface);
    return { settings, plan: compileRegistrationPlan(settings, provider, proxyCatalog) };
  }

  /** One template out of the robot's set: the named one, or the active one. */
  registrationSettings(config, templateId = '') {
    const normalized = this.normalizeRobotConfig(this.getDefinition(REGISTRATION_ROBOT_ID), config, true);
    const wanted = String(templateId || '').trim();
    if (wanted && !normalized.templates.some((template) => template.templateId === wanted)) {
      throw new HttpError(404, `Registration template not found: ${wanted}`);
    }
    return registrationTemplate(normalized, wanted);
  }

  async runRegistration(context) {
    const state = this.getState(context.robotId);
    // A scheduled start names the template it is for; 立即注册 uses the active
    // one. Either way the round runs one template from start to finish, so a
    // config edit mid-round cannot change what is already running.
    const settings = this.registrationSettings(state.config, context.payload?.templateId);
    const provider = this.registrationProvider(settings.mailInterface);
    const iterationResults = [];
    let refreshes = 0;
    let lastPlan = null;
    const refreshCountryCodes = settings.proxyMode === 'countryPool'
      && settings.proxyDistribution !== 'capacity'
      && settings.countryCode !== 'GLOBAL'
      ? [settings.countryCode]
      : [];
    const summarize = (status, reason = '') => ({
      status,
      ...(reason ? { reason: scrubString(reason) } : {}),
      runId: iterationResults[iterationResults.length - 1]?.runId || '',
      templateId: settings.templateId,
      templateName: settings.name,
      provider,
      mailRentalWatch: settings.mailRentalWatch === true,
      proxyMode: settings.proxyMode,
      proxyDistribution: settings.proxyDistribution,
      requested: iterationResults.reduce((sum, result) => sum + result.requested, 0),
      succeeded: iterationResults.reduce((sum, result) => sum + result.succeeded, 0),
      failed: iterationResults.reduce((sum, result) => sum + result.failed, 0),
      countryCode: [...new Set((lastPlan?.proxyAssignments || [])
        .filter((assignment) => assignment?.kind === 'countryPool')
        .map((assignment) => String(assignment.countryCode || '').trim().toUpperCase())
        .filter((countryCode) => countryCode && countryCode !== 'GLOBAL'))].length === 1
        ? lastPlan.proxyAssignments.find((assignment) => assignment?.kind === 'countryPool')?.countryCode || ''
        : '',
      iterations: settings.iterations,
      completedIterations: iterationResults.length,
      refreshes,
    });
    try {
      for (let iteration = 1; iteration <= settings.iterations; iteration += 1) {
        if (iteration > 1) {
          const intervalMinutes = Math.max(1, Math.round(Number(state.intervalMs || DEFAULT_INTERVAL_MS) / 60_000));
          this.setWaiting(context.robotId, 'iteration_interval', `等待下一轮执行，间隔 ${intervalMinutes} 分钟`);
          context.reportCountdown?.(state.intervalMs, '下一轮开始');
          try {
            await this.waitForDelay(state.intervalMs, context.signal);
          } finally {
            context.clearProgress?.();
          }
          this.clearWaiting(context.robotId);
        }
        // Every iteration must obtain a fresh proxy view before preflight or
        // mailbox acquisition. This is the registration lifecycle boundary.
        refreshes += 1;
        let refresh;
        try {
          refresh = await this.runRobotOnce(PROXY_REFRESH_ROBOT_ID, 'mailcom_prestart', {
            triggeredBy: context.robotId,
            iteration,
            templateId: settings.templateId,
            ...(refreshCountryCodes.length ? { countryCodes: refreshCountryCodes } : {}),
          }, 'run_now', { signal: context.signal });
        } catch (error) {
          return summarize('failed', error?.message || `Proxy refresh failed before registration iteration ${iteration}`);
        }
        if (context.signal?.aborted) {
          return summarize('cancelled', 'robot_stopped_before_start');
        }
        if (refresh?.status !== 'success') {
          return summarize('failed', `Proxy refresh ${refresh?.status || 'failed'} before registration iteration ${iteration}`);
        }

        lastPlan = compileRegistrationPlan(settings, provider, this.proxyService?.list?.());
        let started;
        while (true) {
          const gate = await this.waitForRobotCapacity(context, lastPlan);
          if (!gate.ready) {
            this.clearWaiting(context.robotId);
            if (gate.aborted || context.signal?.aborted) {
              return summarize('cancelled', 'robot_stopped_before_start');
            }
            return summarize('skipped', gate.reason || 'capacity_wait_timeout');
          }
          try {
            started = await this.runManager.start(lastPlan);
            break;
          } catch (error) {
            if (!this.isRetryableRobotCapacityError(error)) throw error;
            this.setWaiting(context.robotId, 'task', 'Registration resources are busy; waiting to retry');
            await this.waitForDelay(this.capacityPollMs, context.signal);
          }
        }

        this.clearWaiting(context.robotId);
        const finished = await this.waitForRunTerminal(started?.runId, context.signal, { continueCurrentTask: true });
        const result = {
          iteration,
          runId: started?.runId || finished?.runId || '',
          status: terminalStatus(finished?.status),
          requested: lastPlan.mailCount,
          succeeded: Number(finished?.counts?.sessionsSaved ?? finished?.counts?.accountsCreated ?? 0),
        };
        result.failed = Math.max(0, result.requested - result.succeeded);
        iterationResults.push(result);
        if ((state.stopping === true || context.signal?.reason === 'stop') && iteration < settings.iterations) {
          return summarize('cancelled', 'robot_stopped_after_current_task');
        }
        // A partial registration round is still useful work. Keep moving to
        // the next configured iteration; only a failed or cancelled round
        // follows the stop/continue policy.
        if (['cancelled', 'failed'].includes(result.status) && settings.onIterationFailure === 'stop') break;
      }

      const failed = iterationResults.filter((result) => result.status === 'failed').length;
      const partial = iterationResults.filter((result) => result.status === 'partial').length;
      const cancelled = iterationResults.some((result) => result.status === 'cancelled');
      return summarize(cancelled ? 'cancelled' : (failed > 0 ? 'failed' : (partial > 0 ? 'partial' : 'complete')));
    } catch (error) {
      if (error?.code === 'ROBOT_WAIT_CANCELLED') return summarize('cancelled', 'robot_stopped_before_start');
      throw error;
    }
  }

  mailcomRegistrationPlan(config, provider = '', templateId = '') {
    const settings = this.registrationSettings(config, templateId);
    const mailProvider = String(provider || this.registrationProvider(settings.mailInterface)).trim().toLowerCase();
    return compileRegistrationPlan(settings, mailProvider);
  }

  async runMailcomRegistration(context) {
    return this.runRegistration(context);
  }

  execute(id, reason, payload, commandId = '') {
    const state = this.getState(id);
    const definition = this.getDefinition(id);
    state.running = true;
    state.stopping = false;
    state.pendingRun = false;
    state.pendingReason = '';
    state.pendingCommand = '';
    state.pendingPayload = {};
    state.waiting = false;
    state.waitingReason = '';
    state.waitingDetail = '';
    state.progress = null;
    state.nextRunAt = 0;
    state.status = 'running';
    state.lastError = '';
    const run = {
      id: `robot-${state.id}-${this.now()}-${crypto.randomBytes(3).toString('hex')}`,
      command: String(commandId || definition.handler),
      reason: String(reason || 'interval'),
      status: 'running',
      startedAt: new Date(this.now()).toISOString(),
      finishedAt: null,
      durationMs: 0,
      result: null,
      error: '',
    };
    state.lastRun = run;
    const controller = new AbortController();
    this.controllers.set(state.id, controller);
    this.persist();
    this.emitUpdate();
    const promise = (async () => {
      try {
        const result = await this.resolveHandler(definition)({
          robotId: state.id,
          command: String(commandId || definition.handler),
          handler: definition.handler,
          reason,
          payload,
          signal: controller.signal,
          reportWaiting: (waitReason, detail) => this.setWaiting(state.id, waitReason, detail),
          reportProgress: (progress) => this.setProgress(state.id, progress),
          reportCountdown: (durationMs, label) => this.setCountdown(state.id, durationMs, label),
          clearProgress: () => this.clearProgress(state.id),
        });
        run.status = resultStatus(result);
        run.result = summarizedResult(result);
        state.status = run.status;
      } catch (error) {
        run.status = 'failed';
        run.error = scrubString(error?.message || String(error));
        state.lastError = run.error;
        state.status = 'failed';
      } finally {
        run.finishedAt = new Date(this.now()).toISOString();
        run.durationMs = Math.max(0, asTimestamp(run.finishedAt) - asTimestamp(run.startedAt));
        state.running = false;
        state.stopping = false;
        state.waiting = false;
        state.waitingReason = '';
        state.waitingDetail = '';
        state.progress = null;
        state.history = boundedHistory([run, ...state.history.filter((entry) => entry.id !== run.id)]);
        const pending = state.pendingRun;
        const pendingReason = state.pendingReason || 'interval';
        const pendingCommand = state.pendingCommand || pendingReason;
        const pendingPayload = clone(state.pendingPayload || {});
        state.pendingRun = false;
        state.pendingReason = '';
        state.pendingCommand = '';
        state.pendingPayload = {};
        const oneShot = definition.oneShot === true;
        const shouldRunPending = pending && (oneShot
          ? ['run_now', 'start'].includes(pendingReason)
          : (state.enabled || pendingReason === 'run_now' || pendingReason === 'start'));
        if (oneShot) {
          state.enabled = false;
          state.nextRunAt = 0;
          state.status = 'idle';
          this.clearTimer(state.id);
        } else if (shouldRunPending) {
          state.nextRunAt = 0;
          state.status = 'scheduled';
        } else if (state.enabled) {
          state.nextRunAt = this.now() + state.intervalMs;
          this.schedule(state.id);
        } else {
          state.nextRunAt = 0;
          state.status = 'idle';
        }
        if (state.id === REGISTRATION_ROBOT_ID) this.armRegistrationSchedule();
        this.persist();
        this.emitUpdate();
        if (this.controllers.get(state.id) === controller) this.controllers.delete(state.id);
        if (shouldRunPending) {
          this.requestRun(state.id, pendingReason, {
            force: true,
            commandId: pendingCommand,
            payload: pendingPayload,
          });
        }
      }
    })();
    this.inFlight.set(state.id, promise);
    promise.then(() => {
      if (this.inFlight.get(state.id) === promise) this.inFlight.delete(state.id);
    }, () => {
      if (this.inFlight.get(state.id) === promise) this.inFlight.delete(state.id);
    });
    return promise;
  }

  clearTimer(id) {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }

  schedule(id) {
    const state = this.getState(id);
    this.clearTimer(id);
    if (this.closed || !state.enabled || state.running || state.pendingRun) return;
    const delay = Math.max(0, Number(state.nextRunAt || this.now()) - this.now());
    const timer = setTimeout(() => {
      this.timers.delete(id);
      this.requestRun(id, 'interval', { commandId: 'interval' });
    }, delay);
    timer.unref?.();
    this.timers.set(id, timer);
  }

  /**
   * Every template that starts on its own, with the moment it next fires.
   *
   * Read fresh from the config each time rather than cached: a template's
   * times are edited from the console, and the only schedule that matters is
   * the one saved right now.
   */
  registrationScheduleEntries(fromMs = this.now()) {
    const state = this.states.get(REGISTRATION_ROBOT_ID);
    if (!state) return [];
    let config;
    try {
      config = normalizeRegistrationRobotConfig(state.config);
    } catch {
      return [];
    }
    return config.templates
      .map((template) => ({
        templateId: template.templateId,
        name: template.name,
        schedule: template.schedule,
        at: nextScheduleFireAt(template.schedule, fromMs),
      }))
      .filter((entry) => entry.at !== null)
      .sort((left, right) => left.at - right.at);
  }

  /** The soonest scheduled start across every template, or null. */
  nextRegistrationSchedule(fromMs = this.now()) {
    return this.registrationScheduleEntries(fromMs)[0] || null;
  }

  /**
   * Arm one timer for the soonest scheduled start.
   *
   * One timer rather than one per template: only the earliest matters, and it
   * re-arms after every fire, every config change and every finished run.
   */
  armRegistrationSchedule() {
    if (this.registrationScheduleTimer) {
      clearTimeout(this.registrationScheduleTimer);
      this.registrationScheduleTimer = null;
    }
    if (this.closed) return;
    const entries = this.registrationScheduleEntries();
    if (!entries.length) return;
    // Every template due at the same moment, not just the first. Only one can
    // start — registration takes the main slot — but the others have to be
    // refused out loud rather than disappear: re-arming from `now` would put
    // them in the past and they would never be looked at again.
    const due = entries.filter((entry) => entry.at === entries[0].at);
    const delay = Math.max(0, entries[0].at - this.now());
    const timer = setTimeout(() => {
      this.registrationScheduleTimer = null;
      this.fireRegistrationSchedule(due);
    }, delay);
    timer.unref?.();
    this.registrationScheduleTimer = timer;
  }

  /**
   * A scheduled start coming due.
   *
   * Registration takes the main task slot, so it cannot share the machine with
   * a running task or another exclusive robot. When something else holds it the
   * start is refused outright rather than queued: the operator asked for a
   * round at this time, and one that begins an hour later, behind work they
   * were already running, is not what they asked for. The refusal is recorded
   * and shown on the robot instead.
   */
  fireRegistrationSchedule(due) {
    const state = this.states.get(REGISTRATION_ROBOT_ID);
    if (!state || this.closed) return;
    for (const entry of Array.isArray(due) ? due : [due]) this.startScheduledTemplate(state, entry);
    this.persist();
    this.emitUpdate();
    this.armRegistrationSchedule();
  }

  /**
   * One template's scheduled start.
   *
   * Registration takes the main task slot, so it cannot share the machine with
   * a running task or another exclusive robot. When something else holds it the
   * start is refused outright rather than queued: the operator asked for a
   * round at this time, and one that begins an hour later, behind work they
   * were already running, is not what they asked for. The refusal is recorded
   * and shown on the robot instead.
   *
   * When two templates come due in the same minute the first one to start
   * makes the robot busy, so the rest take the branch above and the refusal is
   * what stays in `lastSchedule` — which is the right thing to leave on screen,
   * since a start is visible as a running task anyway.
   */
  startScheduledTemplate(state, entry) {
    const at = Number(entry?.at || 0);
    const late = this.now() - at;
    const record = {
      templateId: String(entry?.templateId || ''),
      templateName: String(entry?.name || ''),
      scheduledAt: iso(at) || '',
      firedAt: new Date(this.now()).toISOString(),
    };
    if (late > SCHEDULE_LATE_TOLERANCE_MS) {
      state.lastSchedule = { ...record, outcome: 'missed', reason: '错过计划时间（服务当时未运行或机器休眠），本次不再补跑' };
    } else if (state.running || this.inFlight.has(REGISTRATION_ROBOT_ID)) {
      state.lastSchedule = { ...record, outcome: 'skipped', reason: '注册机器人上一轮仍在运行，本次计划未启动' };
    } else if (this.isOccupied(REGISTRATION_ROBOT_ID, 'register_session')) {
      state.lastSchedule = { ...record, outcome: 'skipped', reason: '有任务或其他机器人正在占用主任务位，本次计划未启动' };
    } else {
      state.lastSchedule = { ...record, outcome: 'started', reason: '' };
      try {
        this.requestRun(REGISTRATION_ROBOT_ID, 'schedule', {
          force: true,
          commandId: 'run_now',
          payload: { templateId: record.templateId },
        });
      } catch (error) {
        state.lastSchedule = { ...record, outcome: 'skipped', reason: scrubString(error?.message || String(error)) };
      }
    }
  }

  clearBusyWatcher(id) {
    const timer = this.busyWatchers.get(id);
    if (timer) clearTimeout(timer);
    this.busyWatchers.delete(id);
  }

  wakeQueuedProxyRecovery() {
    const state = this.states.get(PROXY_REFRESH_ROBOT_ID);
    if (!state || state.running || state.pendingRun || !this.proxyRecoveryQueue.size) return;
    for (const runId of [...this.proxyRecoveryQueue]) {
      if (!this.canRefreshWaitingRun(runId)) {
        this.proxyRecoveryQueue.delete(runId);
        continue;
      }
      this.proxyRecoveryQueue.delete(runId);
      this.requestRun(PROXY_REFRESH_ROBOT_ID, 'task_recovery', {
        force: true,
        commandId: 'run_now',
        resumeRunId: runId,
        payload: { resumeRunId: runId, waitReason: 'proxy_pool' },
      });
      // One run can be resumed per refresh, so the rest stay queued — but they
      // are woken by the run that is about to start finishing, not left until
      // some unrelated task happens to complete.
      return;
    }
  }

  watchBusy(id, since = 0) {
    if (this.closed || this.busyWatchers.has(id)) return;
    const startedAt = since || this.now();
    const check = () => {
      this.busyWatchers.delete(id);
      const state = this.getState(id);
      if (this.closed || !state.pendingRun) return;
      const blockedByTask = this.isRobotBlockedByTask(state.id);
      if (state.running || blockedByTask) {
        // A watcher that re-arms forever polls `runManager.unresolved()` once a
        // second for the life of the process. Past the ceiling the pending run
        // is dropped and the robot goes back on its schedule, where the next
        // interval will pick it up.
        if (this.now() - startedAt > ROBOT_PENDING_MAX_WAIT_MS) {
          state.pendingRun = false;
          state.pendingReason = '';
          state.pendingCommand = '';
          state.pendingPayload = {};
          state.status = state.enabled ? 'scheduled' : 'idle';
          state.nextRunAt = state.enabled ? this.now() + state.intervalMs : 0;
          this.persist();
          this.emitUpdate();
          this.schedule(id);
          return;
        }
        this.watchBusy(id, startedAt);
        return;
      }
      const reason = state.pendingReason || 'interval';
      this.requestRun(id, reason, this.pendingRunOptions(state));
    };
    const timer = setTimeout(check, this.busyPollMs);
    timer.unref?.();
    this.busyWatchers.set(id, timer);
  }

  wakeWaitingRobots() {
    this.wakeQueuedProxyRecovery();
    for (const state of this.states.values()) {
      const blockedByTask = this.isRobotBlockedByTask(state.id);
      if (!state.pendingRun || state.running || blockedByTask) continue;
      const reason = state.pendingReason || 'interval';
      this.clearBusyWatcher(state.id);
      this.requestRun(state.id, reason, this.pendingRunOptions(state));
    }
  }
}

module.exports = {
  RobotService,
};
