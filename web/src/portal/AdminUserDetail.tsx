import { useQuery } from "@tanstack/react-query";
import { call, date } from "./client";
import { Modal, Table, Status } from "./Workspace";
import { number, ledgerNames } from "./Insights";
export default function AdminUserDetail({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const { data, error } = useQuery({
    queryKey: ["admin-user", id],
    queryFn: () => call(`/api/admin/v1/users/${id}`),
  });
  return (
    <Modal title="客户账户详情" onClose={onClose}>
      {error && <div className="p-alert">{error.message}</div>}
      {!data ? (
        <p>正在读取账户记录…</p>
      ) : (
        <>
          <div className="p-user-summary">
            <span className="p-user-chip">{data.user.name.slice(0, 1)}</span>
            <div>
              <h3>{data.user.name}</h3>
              <p>{data.user.email}</p>
            </div>
            <Status value={data.user.status} />
          </div>
          <div className="p-stats compact">
            <div>
              <small>可用积分</small>
              <b>{number(data.user.points)}</b>
            </div>
            <div>
              <small>预留积分</small>
              <b>{number(data.user.frozen)}</b>
            </div>
            <div>
              <small>累计消费</small>
              <b>{number(data.stats.spent)}</b>
            </div>
          </div>
          <p className="p-muted">
            注册于 {date(data.user.created_at)} · {data.stats.orders} 笔订单 ·{" "}
            {data.stats.delivered} 个账号交付
          </p>
          <h3>最近订单</h3>
          <Table
            rows={data.orders}
            columns={[
              {
                title: "订单",
                render: (r) => <code>{r.id.slice(0, 12)}</code>,
              },
              {
                title: "模式",
                render: (r) => (r.need_oauth ? "OAuth" : "标准"),
              },
              { title: "交付", render: (r) => `${r.delivered}/${r.quantity}` },
              { title: "状态", render: (r) => <Status value={r.status} /> },
              { title: "扣费", render: (r) => r.charged },
            ]}
          />
          <h3 className="p-spaced-heading">最近积分记录</h3>
          <Table
            rows={data.ledger}
            columns={[
              { title: "类型", render: (r) => ledgerNames[r.kind] },
              {
                title: "可用 / 预留变动",
                render: (r) => `${r.points_delta} / ${r.frozen_delta}`,
              },
              { title: "说明", render: (r) => r.note },
              { title: "时间", render: (r) => date(r.created_at) },
            ]}
          />
        </>
      )}
    </Modal>
  );
}
