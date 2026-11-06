import { type Row } from "./client";
import "./admin-resource-costs.css";
const amount = (value: unknown) => Number(value || 0).toLocaleString("en-US", { maximumFractionDigits: 6 });
export function CostAmount({ cost, kind }: { cost?: Row; kind: "mail" | "sms" }) {
  const entries = Object.entries(cost?.[kind] || {}) as [string, Row][];
  const usage = cost?.resources?.[kind];
  if (!entries.length) return <span className="p-muted">{usage && !usage.total && !usage.uncounted && !usage.missing_attempts ? "未使用" : cost?.attempts || cost?.missing ? "暂无费用记录" : "未执行"}</span>;
  const pending = cost?.kind_pending?.[kind] || entries.some(([, value]) => value.pending > 0);
  return <div className="p-cost-amount">
    {entries.map(([currency, value]) => <div key={currency}>
      <b>{amount(value.confirmed)} {currency}</b>
      {value.pending > 0 && <small>待核对 {amount(value.pending)} {currency}</small>}
      {value.refunded > 0 && <small>已退 {amount(value.refunded)} {currency}</small>}
    </div>)}
    {Boolean(cost?.missing) && <small>部分执行记录缺失</small>}
    {pending && <small>费用尚未全部结算</small>}
  </div>;
}

const reasons: Record<string, string> = {
  EMAIL_OTP_TIMEOUT: "邮箱验证码超时", WRONG_EMAIL_OTP_CODE: "邮箱验证码校验失败",
  MAILBOX_STATE_REJECTED: "供应商拒绝关闭租约", MAILBOX_GONE: "租约已不存在",
  CHATGPT_HOME_FAILED: "注册入口请求失败", CHATGPT_SIGNIN_FAILED: "注册登录请求失败",
  UNSUPPORTED_COUNTRY_REGION_TERRITORY: "地区不可用", SENTINEL_PROXY_IDENTITY_CHANGED: "代理身份发生变化",
  PHONE_NUMBER_IN_USE: "号码已被使用", PHONE_RECENTLY_USED: "号码近期被使用", PHONE_MAX_USAGE_EXCEEDED: "号码使用次数超限",
  FRAUD_GUARD: "号码被风控拒绝", INVALID_PHONE_NUMBER: "号码无效", SMS_CODE_TIMEOUT: "短信验证码超时",
  INVALID_PHONE_OTP: "短信验证码校验失败", INVALID_INPUT: "验证码或输入被拒绝", PROXY_RESTART: "代理变更后重试",
  MFA_TOTP_SECRET_REQUIRED: "2FA 未完成", EXECUTION_INCOMPLETE: "关联执行未完成", VERIFICATION_INCOMPLETE: "短信验证未完成",
  SMS_CANCEL_FAILED: "短信取消失败，待清理", UNKNOWN: "原因未记录",
};
export function ResourceCost({ cost, kind, detailed = false }: { cost?: Row; kind: "mail" | "sms"; detailed?: boolean }) {
  const usage = cost?.resources?.[kind];
  const label = kind === "mail" ? "邮箱" : "短信号码";
  const unknownHistory = usage && (usage.missing_attempts > 0 || usage.uncounted > 0);
  const failedCosts = Object.entries(usage?.failed_cost || {}) as [string, Row][];
  return <div className="p-resource-cost" aria-label={`${label}数量与费用`}>
    {usage ? <>
      {usage.total > 0 || !unknownHistory ? <>
      <div className="p-resource-total">{unknownHistory ? "已知" : ""}{kind === "mail" ? "租用" : "取号"} <b>{usage.total}</b> 个{label}</div>
      <div className="p-resource-counts">
        <span>成功 {usage.succeeded}</span><span className={usage.failed ? "is-failure" : ""}>失败 {usage.failed}</span>
        {usage.active > 0 && <span>处理中 {usage.active}</span>}
        {usage.unknown > 0 && <span>结果不明 {usage.unknown}</span>}
      </div>
      <div className="p-resource-cleanup">
        <span>取消成功 {usage.cancelled}</span>
        {usage.cancel_failed > 0 && <span className="is-failure">取消失败 {usage.cancel_failed}</span>}
        {usage.cleanup_pending > 0 && <span>清理中 {usage.cleanup_pending}</span>}
        {usage.review > 0 && <span className="is-failure">需人工核对 {usage.review}</span>}
      </div>
      </> : <span>历史数量待补齐</span>}
      {(usage.missing_attempts > 0 || usage.uncounted > 0) && <small className="p-resource-warning">历史数量不完整{usage.missing_attempts > 0 ? `（${usage.missing_attempts} 次执行待补齐）` : ""}</small>}
    </> : <small className="p-resource-warning">{cost?.attempts || cost?.version ? "历史数量待补齐" : "尚未执行"}</small>}
    <div className="p-resource-money"><small className="p-muted">已确认消耗</small><CostAmount cost={cost} kind={kind} /></div>
    {usage?.price_unknown > 0 && <small className="p-resource-warning">{usage.price_unknown} 个资源未记录价格，费用待核对</small>}
    {usage?.failed > 0 && <div className="p-resource-failed-cost">
      <small>其中失败资源费用（已含在总额）</small>
      {failedCosts.map(([currency, value]) => <div key={currency}>
        <span>已确认 {amount(value.confirmed)} {currency}</span>
        {value.pending > 0 && <span>待核对 {amount(value.pending)} {currency}</span>}
        {value.refunded > 0 && <span>已退 {amount(value.refunded)} {currency}</span>}
      </div>)}
    </div>}
    {detailed && (usage?.reasons?.length > 0 || usage?.cleanup_reasons?.length > 0) && <details className="p-resource-reasons">
      <summary>失败 / 清理原因</summary>
      {[{ title: "执行失败", rows: usage.reasons }, { title: "资源清理", rows: usage.cleanup_reasons }].map(group => group.rows?.length > 0 && <div key={group.title}>
        <small>{group.title}</small>
        {group.rows.map((r: Row) => <p key={r.code}>{reasons[r.code] || r.code} · {r.count} 次<code>{r.code}</code></p>)}
      </div>)}
    </details>}
  </div>;
}
export default function AdminCosts({ cost, title = "执行成本" }: { cost?: Row; title?: string }) {
  return <section className="p-card p-cost-summary">
    <h3>{title}</h3>
    <div className="p-cost-grid"><div><small>邮箱消耗</small><ResourceCost cost={cost} kind="mail" detailed /></div><div><small>短信消耗</small><ResourceCost cost={cost} kind="sms" detailed /></div></div>
    <p className="p-muted p-fine">仅统计已记录的供应商消耗，包含失败和重试。待核对金额单列，不同币种不相加；与向用户收取的积分分开核算。{cost?.missing > 0 && ` ${cost?.missing} 次执行暂无费用记录。`}</p>
    <p className="p-muted p-fine">邮箱成功 / 失败按关联执行的最终结果统计，短信按号码验证结果统计；失败不代表供应商故障，也不等于已扣费。取消成功不等于已确认退款；尚无账单依据的金额保留待核对。历史明细缺失时，已知数量仅代表有记录的部分。</p>
  </section>;
}
