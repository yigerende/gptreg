import { date, type Row } from "./client";
import { Status, Table } from "./Workspace";

export default function AdminQuarantinedAccounts({ data }: { data: Row }) {
  const attempts = new Map<string, Row>((data.attempts || []).map((r: Row) => [r.run_id, r]));
  const items = new Map<string, Row>((data.items || []).map((r: Row) => [r.id, r]));
  const rows = (data.quarantined_assets || []).map((r: Row) => {
    const item = items.get(attempts.get(r.run_id)?.item_id);
    const replaced = r.reason === "资源重试已结束，旧账号禁止自动交付";
    const ended = r.reason === "原执行已结束，迟到结果禁止交付";
    return {
      ...r,
      item,
      replaced,
      explanation: replaced ? "更换邮箱后，旧账号停止交付"
        : ended ? "原任务已结束，遗留结果停止交付"
        : "历史账号结果已隔离，停止交付",
    };
  });
  if (!rows.length) return null;
  const replaced = rows.filter((r: Row) => r.replaced).length;
  const other = rows.length - replaced;
  return (
    <div className="p-inline-help p-quarantine-notice">
      <p>
        {replaced > 0 && <>更换邮箱后，{replaced} 个旧账号已隔离。</>}
        {other > 0 && <>{other} 个历史账号结果已停止交付。</>}
        {data.status === "completed" && <>本订单已全部交付。</>}
      </p>
      <p className="p-fine">这些旧结果不会重复扣费或交付；已记录的邮箱、短信费用仍包含在本订单成本中。</p>
      <details className="p-order-resource-details">
        <summary>查看旧账号处理记录（{rows.length}）</summary>
        <Table rows={rows} columns={[
          { title: "账号序号", render: r => r.item?.position ?? "—" },
          { title: "处理原因", render: r => r.explanation },
          { title: "当前账号任务", render: r => r.item ? <Status value={r.item.status} /> : "暂无记录" },
          { title: "处理时间", render: r => date(r.created_at) },
          { title: "原执行", render: r => <a href={`/admin/engine/run/${encodeURIComponent(r.run_id)}`} target="_blank" rel="noopener noreferrer">查看原任务</a> },
        ]} />
      </details>
    </div>
  );
}
