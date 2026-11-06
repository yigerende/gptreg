import { type Row } from "./client";
import "./admin-resource-costs.css";
const amount = (value: unknown) => Number(value || 0).toLocaleString("en-US", { maximumFractionDigits: 6 });
export function ResourceCostSummary({ cost, kind }: { cost?: Row; kind: "mail" | "sms" }) {
  const usage = cost?.resources?.[kind];
  const entries = Object.entries(cost?.[kind] || {}) as [string, Row][];
  const incomplete = Boolean(usage?.missing_attempts || usage?.uncounted || cost?.missing);
  const pending = Boolean(cost?.kind_pending?.[kind] || usage?.price_unknown || entries.some(([, v]) => v.pending > 0));
  const refunded = entries.some(([, v]) => v.refunded > 0);
  const hasAmount = entries.some(([, v]) => v.confirmed > 0 || v.pending > 0 || v.refunded > 0);
  if (usage && !usage.total && !incomplete && !hasAmount && !pending)
    return <span className="p-muted">{cost?.attempts ? "未使用" : "未执行"}</span>;
  return <div className="p-resource-brief" aria-label={`${kind === "mail" ? "邮箱" : "短信"}消耗摘要`}>
    <div className="p-resource-brief-line">
      {usage && (usage.total > 0 || !incomplete) ? <>
        <span>{incomplete ? "已知 " : ""}<b>{usage.total}</b> 个</span>
        <span className={usage.failed ? "p-resource-brief-failed" : "p-muted"}>失败 {usage.failed}</span>
      </> : <span className="p-muted">{cost?.attempts || cost?.version ? "数量待补齐" : "未执行"}</span>}
    </div>
    <div className="p-resource-brief-line">
      {entries.length ? entries.map(([currency, v]) => <span className="p-resource-brief-amount" key={currency} title="总成本，包含失败和更换产生的费用">
        <b>{amount(v.confirmed)}</b><small>{currency}</small>
      </span>) : <span className="p-muted">暂无费用记录</span>}
      {pending && <span className="p-resource-brief-flag" title="部分资源尚无扣费结果，未计入成本；详情可查看记录">费用未返回</span>}
      {incomplete && <span className="p-resource-brief-flag" title="部分历史数量或费用记录缺失，详见订单详情">记录不全</span>}
      {refunded && <span className="p-resource-brief-refund" title="退款金额见订单详情">有退款</span>}
    </div>
  </div>;
}
export function CostAmount({ cost, kind }: { cost?: Row; kind: "mail" | "sms" }) {
  const entries = Object.entries(cost?.[kind] || {}) as [string, Row][];
  const usage = cost?.resources?.[kind];
  if (!entries.length) return <span className="p-muted">{usage && !usage.total && !usage.uncounted && !usage.missing_attempts ? "未使用" : cost?.attempts || cost?.missing ? "暂无费用记录" : "未执行"}</span>;
  const pending = cost?.kind_pending?.[kind] || entries.some(([, value]) => value.pending > 0);
  return <div className="p-cost-amount">
    {entries.map(([currency, value]) => <div key={currency}>
      <b>{amount(value.confirmed)} {currency}</b>
      {value.pending > 0 && <small>未计入的报价 {amount(value.pending)} {currency}</small>}
      {value.refunded > 0 && <small>已退 {amount(value.refunded)} {currency}</small>}
    </div>)}
    {Boolean(cost?.missing) && <small>部分执行记录缺失</small>}
    {pending && <small>部分资源尚无扣费结果</small>}
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
    <div className="p-resource-money"><small className="p-muted">总成本（含失败及更换费用）</small><CostAmount cost={cost} kind={kind} /></div>
    {usage?.failed > 0 && <div className="p-resource-failed-cost">
      <small>其中失败 / 更换成本，已计入总额</small>
      {failedCosts.length ? failedCosts.map(([currency, value]) => <div key={currency}>
        <span>{amount(value.confirmed)} {currency}</span>
        {value.pending > 0 && <span>未计入的报价 {amount(value.pending)} {currency}</span>}
        {value.refunded > 0 && <span>已退 {amount(value.refunded)} {currency}</span>}
      </div>) : <span>{unknownHistory ? "费用记录缺失" : "0"}</span>}
    </div>}
    {usage ? <>
      {usage.total > 0 || !unknownHistory ? <>
      <div className="p-resource-total">{unknownHistory ? "已知" : ""}{kind === "mail" ? "租用" : "取号"} <b>{usage.total}</b> 个{label}</div>
      <div className="p-resource-counts">
        <span>成功 {usage.succeeded}</span><span className={usage.failed ? "is-failure" : ""}>失败 {usage.failed}</span>
        {usage.active > 0 && <span>处理中 {usage.active}</span>}
        {usage.unknown > 0 && <span>结果不明 {usage.unknown}</span>}
      </div>
      </> : <span>历史数量待补齐</span>}
      {(usage.missing_attempts > 0 || usage.uncounted > 0) && <small className="p-resource-warning">历史数量不完整{usage.missing_attempts > 0 ? `（${usage.missing_attempts} 次执行待补齐）` : ""}</small>}
    </> : <small className="p-resource-warning">{cost?.attempts || cost?.version ? "历史数量待补齐" : "尚未执行"}</small>}
    {usage?.price_unknown > 0 && <small className="p-resource-warning">{usage.price_unknown} 个资源未记录价格，未计入成本</small>}
    {detailed && usage && <details className="p-resource-reasons">
      <summary>执行记录</summary>
      <div className="p-resource-cleanup">
        <span>取消成功 {usage.cancelled}</span>
        {usage.cancel_failed > 0 && <span className="is-failure">取消失败 {usage.cancel_failed}</span>}
        {usage.cleanup_pending > 0 && <span>清理中 {usage.cleanup_pending}</span>}
        {usage.review > 0 && <span>租约关闭异常 {usage.review}</span>}
      </div>
      {[{ title: "执行失败", rows: usage.reasons }, { title: "资源清理", rows: usage.cleanup_reasons }].map(group => group.rows?.length > 0 && <div key={group.title}>
        <small>{group.title}</small>
        {group.rows.map((r: Row) => <p key={r.code}>{reasons[r.code] || r.code} · {r.count} 次<code>{r.code}</code></p>)}
      </div>)}
    </details>}
  </div>;
}
export default function AdminCosts({ cost, title = "执行成本" }: { cost?: Row; title?: string }) {
  const totals: Record<string, number> = {};
  for (const kind of ["mail", "sms"]) for (const [currency, value] of Object.entries(cost?.[kind] || {}) as [string, Row][])
    totals[currency] = (totals[currency] || 0) + Number(value.confirmed || 0);
  return <section className="p-card p-cost-summary">
    <div className="p-cost-heading"><h3>{title}</h3><div aria-label="合计成本"><small>合计成本{cost?.missing > 0 ? "（已记录部分）" : ""}</small><strong>{Object.entries(totals).map(([currency, value]) => `${amount(value)} ${currency}`).join(" + ") || "暂无记录"}</strong></div></div>
    <div className="p-cost-grid"><div><small>邮箱成本</small><ResourceCost cost={cost} kind="mail" detailed /></div><div><small>短信成本</small><ResourceCost cost={cost} kind="sms" detailed /></div></div>
    <p className="p-muted p-fine">总成本包含失败和更换产生的费用；与用户支付的积分分开核算，不同币种分别统计。{cost?.missing > 0 && ` ${cost?.missing} 次执行没有保存费用记录。`}</p>
    <details className="p-resource-reasons"><summary>计费说明</summary><p className="p-muted p-fine">SMSBower 邮箱收到验证码即计费，注册失败或更换邮箱也计入成本。同一租约只计算一次。短信收到验证码或供应商确认扣费才计入；SMSBower 未收码且供应商确认取消的号码成本为 0。邮箱成功 / 失败按关联执行结果统计，短信按号码验证结果统计。</p></details>
  </section>;
}
