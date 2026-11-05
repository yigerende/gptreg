import { call, type Row } from "./client";
import { useAction, Feedback, Table } from "./Workspace";
import AdminCosts, { CostAmount } from "./AdminCosts";
export default function AdminOrderActions({ data }: { data: Row }) {
  const a = useAction();
  return (
    <>
      <Feedback a={a} />
      {data.cleanup_runs?.some((r: Row) => !r.finished_at) && <p className="p-inline-help">供应商资源正在后台清理，客户结算不受影响；失败会自动退避重试。</p>}
      {data.quarantined_assets?.length > 0 && <div className="p-alert">有 {data.quarantined_assets.length} 个迟到或归属异常的账号结果已隔离，不会再次扣费或交付。</div>}
      <AdminCosts cost={data.execution_cost} title="本订单执行成本" />
      <Table rows={data.items} columns={[
        { title: "账号序号", render: r => r.position },
        { title: "邮箱消耗", render: r => <CostAmount cost={r.execution_cost} kind="mail" /> },
        { title: "短信消耗", render: r => <CostAmount cost={r.execution_cost} kind="sms" /> },
      ]} />
      {data.items
        .filter((r: Row) => r.status === "review" || (r.status === "running" && r.recovery_attempts > 0))
        .map((r: Row) => (
          <div className="p-card" key={r.id}>
            <b>第 {r.position} 个账号自动恢复中</b>
            <p className="p-muted">
              系统会在执行时限内自动恢复，无法交付则自动退款。以下操作仅用于管理员提前干预。
            </p>
            <div className="p-inline">
              <button
                className="p-button secondary"
                disabled={a.busy}
                onClick={() =>
                  a.run(
                    () =>
                      call(`/api/v1/platform/items/${r.id}/resolve`, "POST", {
                        action: "resume",
                      }),
                    "已处理恢复请求，状态已同步",
                  )
                }
              >
                立即尝试恢复
              </button>
              <button
                className="p-button secondary"
                disabled={a.busy}
                onClick={() => {
                  if (
                    window.confirm("确认此账号未交付，并退回该账号预留积分？")
                  )
                    a.run(
                      () =>
                        call(`/api/v1/platform/items/${r.id}/resolve`, "POST", {
                          action: "fail",
                        }),
                      "操作已处理，结算结果已同步",
                    );
                }}
              >
                确认未交付并退款
              </button>
            </div>
          </div>
        ))}
      {data.attempts?.length > 0 && (
        <details>
          <summary>内部执行记录</summary>
          <Table
            rows={data.attempts}
            columns={[
              {
                title: "执行任务",
                render: (r) => (
                  <a
                    target="_blank"
                    rel="noopener noreferrer"
                    href={`/admin/engine/run/${r.run_id}`}
                  >
                    {r.run_id}
                  </a>
                ),
              },
              {
                title: "阶段",
                render: (r) => (r.stage === "oauth" ? "OAuth 授权" : "注册"),
              },
              { title: "状态", render: (r) => r.status },
              {
                title: "失败原因",
                render: (r) =>
                  r.error_code ? (
                    <>
                      <code>{r.error_code}</code>
                      <p className="p-muted">{r.error_detail}</p>
                    </>
                  ) : (
                    "—"
                  ),
              },
            ]}
          />
          <p className="p-muted">
            恢复次数和总执行时限均有上限；退款后禁止再次扣费或交付，资源清理由系统独立重试。
          </p>
        </details>
      )}
    </>
  );
}
