import { type Row } from "./client";
export function CostAmount({ cost, kind }: { cost?: Row; kind: "mail" | "sms" }) {
  const entries = Object.entries(cost?.[kind] || {}) as [string, Row][];
  if (!entries.length) return <span className="p-muted">{cost?.attempts ? "暂无记录" : "未执行"}</span>;
  return <div className="p-cost-amount">
    {entries.map(([currency, value]) => <div key={currency}>
      <b>{Number(value.confirmed || 0).toLocaleString("en-US", { maximumFractionDigits: 6 })} {currency}</b>
      {value.pending > 0 && <small>待核对 {Number(value.pending).toLocaleString("en-US", { maximumFractionDigits: 6 })} {currency}</small>}
      {value.refunded > 0 && <small>已退 {Number(value.refunded).toLocaleString("en-US", { maximumFractionDigits: 6 })} {currency}</small>}
    </div>)}
    {Boolean(cost?.missing) && <small>部分执行记录缺失</small>}
    {cost?.pending && <small>费用尚未全部结算</small>}
  </div>;
}
export default function AdminCosts({ cost, title = "执行成本" }: { cost?: Row; title?: string }) {
  return <section className="p-card p-cost-summary">
    <h3>{title}</h3>
    <div className="p-cost-grid"><div><small>邮箱消耗</small><CostAmount cost={cost} kind="mail" /></div><div><small>短信消耗</small><CostAmount cost={cost} kind="sms" /></div></div>
    <p className="p-muted p-fine">仅统计已记录的供应商消耗，包含失败和重试。待核对金额单列，不同币种不相加；与向用户收取的积分分开核算。{cost?.missing > 0 && ` ${cost?.missing} 次执行暂无费用记录。`}</p>
  </section>;
}
