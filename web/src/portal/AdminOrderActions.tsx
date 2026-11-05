import { call, type Row } from "./client";
import { useAction, Feedback, Table } from "./Workspace";
export default function AdminOrderActions({ data }: { data: Row }) {
  const a = useAction();
  return (
    <>
      <Feedback a={a} />
      {data.items
        .filter((r: Row) => r.status === "review")
        .map((r: Row) => (
          <div className="p-card" key={r.id}>
            <b>第 {r.position} 个账号待核实</b>
            <p className="p-muted">
              先检查下方内部执行记录，再选择恢复或确认未交付。
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
                    "已恢复执行",
                  )
                }
              >
                恢复原任务
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
                      "已结束并退回积分",
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
            待核实任务可在原管理台检查和恢复；确认完成或取消后，订单会同步结果。
          </p>
        </details>
      )}
    </>
  );
}
