import { call, date, type Row } from "./client";
import { useAction, Feedback, Table, Status } from "./Workspace";
import AdminCosts, { ResourceCost } from "./AdminCosts";
import AdminQuarantinedAccounts from "./AdminQuarantinedAccounts";
export default function AdminOrderActions({ data }: { data: Row }) {
  const a = useAction();
  return (
    <>
      <Feedback a={a} />
      {data.cleanup_runs?.some((r: Row) => !r.finished_at) && <p className="p-inline-help">供应商资源正在后台清理，客户结算不受影响；失败会自动退避重试。</p>}
      <AdminQuarantinedAccounts data={data} />
      <AdminCosts cost={data.execution_cost} title="本订单执行成本" />
      <details className="p-order-resource-details" open>
      <summary>逐账号资源消耗与失败情况</summary>
      <Table rows={data.items} columns={[
        { title: "账号序号", render: r => r.position },
        { title: "交付状态", render: r => <Status value={r.status} /> },
        { title: "执行次数", render: r => r.execution_cost?.attempts || 0 },
        { title: "邮箱数量 / 费用", render: r => <ResourceCost cost={r.execution_cost} kind="mail" detailed /> },
        { title: "短信数量 / 费用", render: r => <ResourceCost cost={r.execution_cost} kind="sms" detailed /> },
      ]} />
      <p className="p-muted p-fine">同一账号使用多个邮箱表示曾更换资源；数量按已记录的不同租约统计。可在下方内部执行记录查看每次执行的费用和错误。</p>
      </details>
      {data.cleanup_runs?.length > 0 && <details className="p-order-resource-details">
        <summary>资源清理记录（{data.cleanup_runs.length}）</summary>
        <Table rows={data.cleanup_runs} columns={[
          { title: "执行任务", render: r => <code>{r.run_id}</code> },
          { title: "清理状态", render: r => r.finished_at ? "已完成" : r.last_error ? "失败待重试" : "等待处理" },
          { title: "尝试次数", render: r => r.attempts },
          { title: "下次处理 / 完成时间", render: r => date(r.finished_at || r.next_attempt_at) },
          { title: "最近错误", render: r => r.last_error || "—" },
        ]} />
      </details>}
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
        <details className="p-order-resource-details">
          <summary>内部执行记录</summary>
          <Table
            rows={data.attempts}
            columns={[
              { title: "账号序号", render: r => data.items.find((item: Row) => item.id === r.item_id)?.position || "—" },
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
              { title: "邮箱数量 / 费用", render: r => <ResourceCost cost={r.cost_snapshot || { attempts: 1 }} kind="mail" detailed /> },
              { title: "短信数量 / 费用", render: r => <ResourceCost cost={r.cost_snapshot || { attempts: 1 }} kind="sms" detailed /> },
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
