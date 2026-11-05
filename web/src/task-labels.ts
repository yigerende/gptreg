import type { RunPlan, RunSummary } from './types';

/**
 * What a task is, in words an operator can act on.
 *
 * Three separate jobs live here, and they used to be scattered or missing:
 *
 *  - **Which slot a task holds.** The server already answers this on every run
 *    (`taskSlot`), but the console re-derived it from `taskKind` in two places
 *    and could disagree with the scheduler that actually enforces it.
 *  - **What the task kind means.** `taskKindLabel` names it; `taskKindPurpose`
 *    says what it does, because "登录态刷新" tells you the words and not the
 *    consequence.
 *  - **What this particular run is doing.** A run is identified everywhere by
 *    `ui-20260910140428-zklooc`, which says only when it started. The plan
 *    behind it knows the mail channel, the account count, the alias shape, the
 *    country pools and the Worker count — `runTaskDescription` renders that as
 *    one line so a list of runs can be read rather than decoded.
 */

export type TaskSlot = 'main' | 'auxiliary' | 'customer';

const TASK_KIND_LABELS: Record<string, string> = {
  register_oauth: '旧版注册并 OAuth',
  register_session: '登录态注册',
  oauth: '凭据直登 OAuth',
  session_refresh: '登录态刷新',
};

/**
 * What each task kind actually does, for the places a label alone is not
 * enough — a launch button, a task list, the detail header.
 */
const TASK_KIND_PURPOSE: Record<string, string> = {
  register_session: '注册新账号并保存登录态资产，可选继续跑 OAuth 出 CPA',
  register_oauth: '旧版：注册后立即 OAuth，新任务不再创建',
  oauth: '对已存在的账号做 OAuth 换取 CPA，不注册新账号',
  session_refresh: '校验并修复已保存的登录态，不产出 CPA',
};

const MAIL_PROVIDER_LABELS: Record<string, string> = {
  xiaopingguo: '小苹果邮箱池',
  smsbower: 'SMSBower 租用邮箱',
  mailcom: 'Mail.com API',
  fastmail: 'Fastmail API',
};

const RUN_STATUS_LABELS: Record<string, string> = {
  running: '运行中',
  waiting: '等待中',
  paused: '已暂停',
  initialized: '准备中',
  complete: '已完成',
  partial: '部分完成',
  cancelled: '已取消',
  failed: '已失败',
};

/**
 * Every phase either scheduler can park a job or a run in.
 *
 * The console rendered these raw, so an operator watching a task saw
 * `waiting_sms_acquisition_reconcile` and had to know the codebase to read it.
 * The two orchestrators keep separate vocabularies with near-synonyms across
 * them (`waiting_sms_acquire_reconcile` vs `waiting_sms_acquisition_reconcile`,
 * `waiting_code` vs `waiting_sms_code`), so both spellings are mapped rather
 * than one being declared canonical here — that consolidation belongs in the
 * schedulers, not in a label table.
 *
 * An unmapped phase falls back to its own identifier, so a newly added wait
 * shows up as itself instead of blanking the row.
 */
const PHASE_LABELS: Record<string, string> = {
  // Ordinary progress
  normal: '正常执行',
  queued: '排队中',
  starting: '启动中',
  running: '执行中',
  initializing: '初始化',
  resuming: '恢复中',
  registration: '注册中',
  email_otp: '邮箱验证码',
  email_boundary: '邮件边界确认',
  oauth: 'OAuth 授权',
  token_exchange: '换取令牌',
  fallback_login: '回退登录',
  finalization: '收尾处理',
  pending_finalize: '等待收尾',
  complete: '已完成',
  cancelled: '已取消',
  failed: '已失败',
  failed_proxy: '代理失败',
  finalize_failed: '收尾失败',
  paused: '已暂停',
  cancel_pending: '取消中',
  skipped: '已跳过',

  // Resume checkpoints
  resuming_created_account: '恢复：账号已创建',
  resuming_email_otp: '恢复：邮箱验证码',
  resuming_mfa: '恢复：二次验证',
  resuming_oauth_protocol: '恢复：OAuth 协议',
  resuming_oauth_phone_transaction: '恢复：手机号事务',
  resuming_oauth_phone_validation: '恢复：手机号校验',
  resuming_oauth_phone_validation_manual: '恢复：手机号校验待人工',
  resuming_security: '恢复：安全设置',

  // Proxy
  waiting_proxy: '等待代理',
  waiting_proxy_pool: '等待代理池补货',
  waiting_proxy_rotation: '等待换代理',
  waiting_proxy_retry: '代理重试中',
  waiting_proxy_continuity: '等待原代理',
  waiting_proxy_abort_cleanup: '代理中止清理',
  waiting_maintenance_proxy: '等待本机转发',

  // Mail
  waiting_email: '等待邮件',
  waiting_email_baseline: '等待邮件基线',
  waiting_email_provider: '等待邮箱服务',
  waiting_email_timeout: '邮件超时',
  waiting_security_retry: '重试密码／2FA',
  waiting_security_email_retry: '等待补密码邮件重试',
  waiting_mail_rental: '等待租用邮箱',
  waiting_mail_rental_watch: '等待挂租库存',
  waiting_mailbox_cleanup: '邮箱清理中',

  // SMS
  waiting_code: '等待短信验证码',
  waiting_sms_code: '等待短信验证码',
  waiting_sms_code_timeout: '短信验证码超时',
  waiting_sms_preflight: '等待短信预检',
  waiting_sms_inventory: '等待号码库存',
  waiting_sms_inventory_retry: '号码库存重试',
  waiting_sms_balance: '短信余额不足',
  waiting_sms_market_cooldown: '短信市场冷却',
  waiting_sms_quality: '等待号码质量',
  waiting_sms_invalid_number: '号码无效待换',
  waiting_sms_missing_lease: '短信租约缺失',
  waiting_sms_completion: '等待短信结算',
  waiting_sms_cleanup: '短信清理中',
  waiting_sms_acquire_reconcile: '取号结果待核对',
  waiting_sms_acquisition_reconcile: '取号结果待核对',
  waiting_sms_effect_reconcile: '短信结果待核对',
  waiting_sms_request_reconcile: '短信请求待核对',

  // Phone challenge
  waiting_phone_confirmation: '等待手机号确认',
  waiting_phone_continuity: '等待手机号续接',
  waiting_phone_manual_review: '手机号待人工复核',
  waiting_phone_scope: '等待手机号授权范围',

  // Account and OAuth repair
  waiting_existing_account_recovery: '已存在账号恢复中',
  waiting_oauth_login_repair: 'OAuth 登录修复中',
  waiting_reconcile_create_account: '建号结果待核对',
  waiting_token_exchange: '等待换取令牌',

  // Scheduling and cleanup
  waiting_transient: '瞬时故障重试',
  waiting_retry_backoff: '退避重试中',
  waiting_error: '出错等待',
  waiting_cleanup: '清理中',
  waiting_resource_cleanup: '资源清理中',
  waiting_unassignable_job: '无 Worker 可派工',
};

export function taskKindLabel(taskKind: string = 'register_session', plan?: RunPlan | null) {
  if (taskKind === 'register_session' && plan?.postRegistrationOAuth) return '登录态注册 + OAuth';
  if (taskKind === 'oauth' && plan?.oauthSource?.loginOnly === true) return '凭据直登（仅登录）';
  if (
    taskKind === 'session_refresh'
    && (plan?.security?.setPassword === true || plan?.security?.enrollTotp === true)
  ) return '登录态 OTP/PW 修复';
  return TASK_KIND_LABELS[taskKind] || taskKind;
}

export function taskKindPurpose(taskKind: string = 'register_session', plan?: RunPlan | null) {
  if (taskKind === 'register_session' && plan?.postRegistrationOAuth === false) {
    return '只注册并保存登录态，不跑 OAuth，之后可在登录态页单独发起';
  }
  if (taskKind === 'oauth' && plan?.oauthSource?.loginOnly === true) {
    return '只登录并保存登录态，不跑 OAuth、不产出 CPA';
  }
  return TASK_KIND_PURPOSE[taskKind] || '';
}

/**
 * How a finished job ended, named for the operator.
 *
 * The orchestrator writes these as identifiers, and the jobs table used to
 * print them as-is: a row reading `session_security_partial_cpa_saved` is a
 * grep key, not a result. Anything unmapped still falls through to the raw
 * value, so a new outcome is unreadable rather than invisible.
 */
const JOB_RESULT_LABELS: Record<string, string> = {
  cpa_saved: 'CPA 已保存',
  session_and_cpa_saved: 'CPA 已保存',
  session_security_partial_cpa_saved: 'CPA 已保存（安全项待补）',
  session_security_incomplete_oauth_held: '安全项未完成，已暂停 OAuth',
  existing_account_recovered: '已有账号恢复',
  session_saved: '登录态已保存',
  session_refreshed: '登录态已刷新',
  session_security_partial: '登录态已保存（安全项待补）',
};

export function jobResultLabel(
  result?: string | null,
  error?: { code?: string; message?: string } | string | null,
) {
  const raw = String(result || '').trim();
  const current = JOB_RESULT_LABELS[raw] || raw;
  const withoutFailureLabel = (value: string) => {
    const suffix = value.match(/(?:^|[;；]\s*)失败[:：]\s*(.+)$/);
    return (suffix ? suffix[1] : value).replace(/^失败[:：]\s*/, '').trim();
  };
  if (!error) return withoutFailureLabel(current);
  const code = typeof error === 'object' ? String(error.code || '').trim() : '';
  const message = typeof error === 'object'
    ? String(error.message || '').trim()
    : String(error || '').trim();
  const reason = [code, message].filter(Boolean).join('，');
  return reason || withoutFailureLabel(current);
}

/**
 * `phase` as a person reads it, with the identifier kept for the tooltip.
 *
 * Returned as a pair rather than a string because every call site wants both:
 * the label to show, and the raw phase to put in `title` so a bug report can
 * still name the exact state.
 */
export function phaseLabel(phase?: string | null): { label: string; raw: string } {
  const raw = String(phase || '').trim();
  if (!raw) return { label: PHASE_LABELS.normal, raw: 'normal' };
  return { label: PHASE_LABELS[raw] || raw, raw };
}

export function runStatusLabel(status?: string | null) {
  const value = String(status || '').trim();
  return RUN_STATUS_LABELS[value] || value || '处理中';
}

/**
 * A run that has finished and released its task slot.
 *
 * Deliberately distinct from `isTerminalJobStatus`: a *job* can also end
 * `skipped`, `failed_proxy` or `finalize_failed`, and none of those are run
 * statuses. Sharing one set between the two would let a run status leak into
 * the job table's skip logic, or a job status quietly free a task slot.
 */
const TERMINAL_RUN_STATUSES = new Set(['complete', 'partial', 'cancelled', 'failed']);

export function isTerminalRunStatus(status?: string | null) {
  return TERMINAL_RUN_STATUSES.has(String(status || '').trim());
}

/**
 * Which slot this run occupies.
 *
 * The server's `taskSlot` is authoritative — it is what the scheduler enforces
 * capacity against. The `taskKind` fallback is only for summaries persisted
 * before that field existed.
 */
export function runTaskSlot(run: Pick<RunSummary, 'taskSlot' | 'taskKind' | 'plan'>): TaskSlot {
  if (run.taskSlot === 'auxiliary' || run.taskSlot === 'main' || run.taskSlot === 'customer') return run.taskSlot;
  const kind = run.taskKind || run.plan?.taskKind;
  return kind === 'oauth' || kind === 'session_refresh' ? 'auxiliary' : 'main';
}

export function isAuxiliaryRun(run: Pick<RunSummary, 'taskSlot' | 'taskKind' | 'plan'>) {
  return runTaskSlot(run) === 'auxiliary';
}

export const TASK_SLOT_LABELS: Record<TaskSlot, string> = {
  customer: '客户订单',
  main: '主任务',
  auxiliary: '附属任务',
};

export const TASK_SLOT_PURPOSE: Record<TaskSlot, string> = {
  customer: '客户订单自动排队，注册与 OAuth 共用运营控制台配置的并发额度。',
  main: '注册类任务。消耗邮箱、手机号和住宅代理，同一时间只允许一个。',
  auxiliary: '已有账号的 OAuth、登录态刷新等任务，可并行多个。独立 OAuth 使用所选国家池或固定代理，每个出口独占绑定。',
};

export function runTaskSlotLabel(run: Pick<RunSummary, 'taskSlot' | 'taskKind' | 'plan'>) {
  return TASK_SLOT_LABELS[runTaskSlot(run)];
}

function mailProviderLabel(provider?: string | null) {
  const value = String(provider || '').toLowerCase();
  return MAIL_PROVIDER_LABELS[value] || value || '';
}

/** The country pools a plan's Workers are assigned to, deduplicated in order. */
function planCountryPools(plan?: RunPlan | null) {
  const seen: string[] = [];
  for (const assignment of plan?.proxyAssignments || []) {
    if (assignment.kind !== 'countryPool') continue;
    const code = String(assignment.countryCode || '').toUpperCase();
    if (code && !seen.includes(code)) seen.push(code);
  }
  return seen;
}

/**
 * One line saying what this specific run is doing.
 *
 * Built from the plan, because the run id says only when it started and every
 * list in the console is otherwise a column of near-identical timestamps. The
 * parts are ordered by what an operator scans for first: how much work, from
 * which source, through which exits, at what concurrency.
 */
export function runTaskDescription(run: Pick<RunSummary, 'taskKind' | 'plan'>): string {
  const plan = run.plan;
  if (!plan) return '';
  const kind = run.taskKind || plan.taskKind || 'register_session';
  const parts: string[] = [];

  if (kind === 'oauth' || kind === 'session_refresh') {
    const source = plan.oauthSource;
    const count = source?.kind === 'session_assets'
      ? source.assetIds.length
      : (source?.kind === 'credentials' ? source.accounts.length : Number(plan.totalAccounts || plan.mailCount || 0));
    if (count) parts.push(`${count} 个账号`);
    if (source?.kind === 'credentials') parts.push('凭据直登');
    else if (source?.kind === 'session_assets') parts.push('登录态资产');
    if (kind === 'oauth' && source?.loginOnly === true) parts.push('仅登录');
  } else {
    const roots = Number(plan.mailCount || 0);
    if (roots) parts.push(`${roots} 根邮箱`);
    // The alias shape decides how many accounts a root yields, which is the
    // number an operator is actually planning around.
    if (plan.aliasStrategy === 'root') parts.push('仅原邮箱');
    else if (Number(plan.aliasCount || 0) > 0) parts.push(`每根 ${plan.aliasCount} 别名`);
    if (plan.totalAccounts) parts.push(`共 ${plan.totalAccounts} 个账号`);
    const provider = mailProviderLabel(plan.mailProvider);
    if (provider) parts.push(provider);
  }

  const pools = planCountryPools(plan);
  if (pools.length) parts.push(`${pools.join('/')} 池`);
  else if ((plan.proxyAssignments || []).some((assignment) => assignment.kind === 'maintenance')) {
    parts.push('本机转发');
  }

  if (plan.workerConcurrency) parts.push(`${plan.workerConcurrency} Worker`);
  if (plan.security?.setPassword || plan.security?.enrollTotp) {
    const bits = [plan.security.setPassword ? '密码' : '', plan.security.enrollTotp ? 'TOTP' : ''].filter(Boolean);
    parts.push(`附带${bits.join(' + ')}设置`);
  }
  return parts.join(' · ');
}

/** When a run started, formatted for a list rather than a detail page. */
export function runTaskTitle(run: Pick<RunSummary, 'taskKind' | 'plan'>) {
  return taskKindLabel(run.taskKind || run.plan?.taskKind, run.plan);
}
