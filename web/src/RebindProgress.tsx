import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { RebindActive } from './types';

const STAGES: Record<string, { percent: number; label: string; phase: number }> = {
  proxy_check: { percent: 3, label: '筛选换绑代理', phase: 0 },
  precheck: { percent: 8, label: '登录态校验', phase: 0 },
  login: { percent: 8, label: '登录态校验', phase: 0 },
  login_refresh: { percent: 18, label: '换绑前自动登录', phase: 0 },
  claim: { percent: 32, label: '领取邮箱', phase: 1 },
  change_begin: { percent: 48, label: '发起换绑', phase: 1 },
  change_reauth: { percent: 48, label: '换绑授权验证', phase: 1 },
  otp: { percent: 64, label: '读取验证码', phase: 2 },
  mailbox_retry: { percent: 32, label: '更换邮箱', phase: 1 },
  change_verify: { percent: 78, label: '确认换绑', phase: 3 },
  change_reconcile: { percent: 80, label: '核对换绑结果', phase: 3 },
  post_login_refresh: { percent: 84, label: '新邮箱登录态刷新', phase: 4 },
  verify_health: { percent: 94, label: '换绑后测活', phase: 4 },
  settle: { percent: 96, label: '保存邮箱状态', phase: 5 },
  save: { percent: 98, label: '保存账号状态', phase: 5 },
  release: { percent: 0, label: '释放邮箱', phase: -1 },
};
const PHASES = ['校验', '邮箱', '收码', '换绑', '刷新', '保存'];
const LOGIN_STEPS: Record<string, { label: string; percent: number }> = {
  nextauth_ready: { label: '建立登录会话', percent: 85 },
  identity_submitted: { label: '提交邮箱', percent: 86 },
  login_password_page: { label: '验证密码', percent: 87 },
  password_verified: { label: '密码验证通过', percent: 88 },
  mfa_required: { label: '准备双重验证', percent: 89 },
  mfa_challenge_issued: { label: '准备双重验证', percent: 89 },
  mfa_verification_pending: { label: '验证 TOTP', percent: 90 },
  mfa_validated: { label: '双重验证通过', percent: 91 },
  auth_callback_pending: { label: '获取新登录态', percent: 92 },
  auth_callback_response_received: { label: '接收新登录态', percent: 92 },
  session_verified: { label: '新登录态验证通过', percent: 93 },
};

export function stageLabel(stage: string) { return STAGES[stage]?.label || '处理中'; }
export function retryLabel(reason: string) { return reason === 'recipient_mismatch' ? '邮件收件人不匹配' : '验证码等待超时'; }

export function RebindProgress({ active, email, compact = false, collapsed = false }: { active?: RebindActive; email: string; compact?: boolean; collapsed?: boolean }) {
  const [expanded, setExpanded] = useState(!collapsed);
  const stage = active ? STAGES[active.stage] || { percent: 0, label: '处理中', phase: -1 } : null;
  const login = active?.loginStep ? LOGIN_STEPS[active.loginStep] : null;
  const reached = (active?.stagesReached || []).map((name) => STAGES[name]).filter(Boolean);
  const loginProgress = active?.stage === 'post_login_refresh' ? (active.loginStepsReached || []).map((step) => LOGIN_STEPS[step]?.percent || 0) : [];
  const percent = Math.max(active?.stage === 'post_login_refresh' && login ? login.percent : stage?.percent || 0, ...reached.map((item) => item.percent), ...loginProgress);
  const phase = Math.max(stage?.phase ?? -1, ...reached.map((item) => item.phase));
  const elapsed = active?.elapsedSeconds || 0;
  const secondsLeft = Math.max(0, Math.ceil((active?.timeoutMs || 120000) / 1000) - elapsed);
  const otp = active?.otp;
  const diagnostics = otp?.diagnostics;
  const connectionRetry = active?.connectionRetry;
  const retryWait = Math.max(0, Math.ceil((Date.parse(connectionRetry?.nextRetryAt || '') - Date.now()) / 1000) || 0);
  const showDetails = active && (!collapsed || expanded);
  return <div className={`rebind-card-progress${active ? '' : ' pending'}${compact ? ' compact' : ''}${collapsed && !expanded ? ' collapsed' : ''}`}>
    <div className="rebind-card-progress-head">
      <strong>{stage?.label || '等待处理'}</strong>
      <span>{active ? `${percent}% · 本步 ${elapsed} 秒` : '排队中'}</span>
      {collapsed && active && <button type="button" className="rebind-progress-toggle" aria-expanded={expanded} aria-label={expanded ? '收起换绑详情' : '展开换绑详情'} onClick={(event) => { event.stopPropagation(); setExpanded((value) => !value); }}>
        {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>}
    </div>
    <div className="rebind-card-progress-bar" role="progressbar" aria-label={`${email}换绑进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-valuetext={stage ? `${stage.label}，阶段进度 ${percent}%，本步 ${elapsed} 秒` : '排队中'}>
      <span style={{ width: `${percent}%` }} />
    </div>
    {showDetails && !compact && <ol className="rebind-steps" aria-label="换绑步骤">
      {PHASES.map((label, index) => <li key={label} className={index < phase ? 'done' : index === phase ? 'current' : ''} aria-current={index === phase ? 'step' : undefined}><i aria-hidden="true" />{label}</li>)}
    </ol>}
    {showDetails && <div className="rebind-progress-detail">
      {active.stage === 'proxy_check' && <span>登录和领邮箱前检测代理{active.proxyCheck?.candidateIndex ? ` · 节点 ${active.proxyCheck.candidateIndex}/${active.proxyCheck.candidateCount}` : ''}{active.proxyCheck?.message ? ` · ${active.proxyCheck.message}` : ''}</span>}
      {active.stage === 'otp' && <span>{otp?.retrying ? '邮箱接口暂时无响应，正在重试' : diagnostics?.checkedEmails ? `已匹配 ${diagnostics.checkedEmails} 封邮件，提取验证码中` : '等待目标邮箱验证码'} · 最多再等 {secondsLeft} 秒{otp ? ` · 已查询 ${otp.polls} 次` : ''}</span>}
      {active.stage === 'post_login_refresh' && <span>换绑已确认 · 使用同一代理{login ? ` · ${login.label}` : '重新登录新邮箱'}</span>}
      {active.stage === 'change_reauth' && <span>新邮箱已领取 · 换绑接口要求重新验证登录 · 验证后继续提交</span>}
      {active.stage === 'change_reauth' && login && <span>{login.label} · 保留当前邮箱与代理</span>}
      {active.stage === 'login_refresh' && login && <span>{login.label}</span>}
      {active.stage === 'verify_health' && <span>使用刷新后的登录态核对新邮箱</span>}
      {active.stage === 'change_reconcile' && <span>确认响应中断 · 正在核对账号邮箱，保留当前邮箱与代理</span>}
      {active.stage === 'mailbox_retry' && <span>{retryLabel(active.retryReason || '')} · {active.willRetry === false ? '重试次数已用完，正在登记邮箱' : '正在弃用当前邮箱并领取新地址'}</span>}
      {active.retryReason && active.stage !== 'mailbox_retry' && (active.mailboxAttempt || 1) > 1 && <span>上次{retryLabel(active.retryReason)}，已更换邮箱</span>}
      {connectionRetry?.pending ? <span>网络中断 · {retryWait > 0 ? `${retryWait} 秒后` : '即将'}在当前步骤重试（{connectionRetry.retryAttempt}/{connectionRetry.maxRetries}）· 邮箱及代理保持不变</span>
        : connectionRetry && <span>同代理连接重试 · 上次在“{stageLabel(connectionRetry.stage)}”失败（{connectionRetry.code}）</span>}
      <span className="rebind-progress-meta">{active.mailboxAttempt ? `邮箱 ${active.mailboxAttempt}/${active.maxMailboxAttempts || active.mailboxAttempt} · ` : ''}同一代理 · 第 {active.attempt} 次尝试{active.totalElapsedSeconds != null ? ` · 累计 ${active.totalElapsedSeconds} 秒` : ''}</span>
      {active.proxy && <span className="rebind-progress-meta">固定代理：{active.proxy}</span>}
      {active.rebindProxy?.countryCode && <span className="rebind-progress-meta">换绑国家池：{active.rebindProxy.countryCode}</span>}
    </div>}
  </div>;
}
