import DataProtectionNotice from "./DataProtectionNotice";
import AdminResourceBoard from "./AdminResourceBoard";
import AdminCosts from "./AdminCosts";
import {
  Activity,
  ArrowUpRight,
  CircleAlert,
  KeyRound,
  LockKeyhole,
  Users,
  Wallet,
  Timer,
  CheckCircle2,
} from "lucide-react";
import { Link } from "../router";
import { type Row, date } from "./client";
import { Status, Table } from "./Workspace";
import { StatCards, Trend, number } from "./Insights";
export default function AdminOverview({
  data,
  onOrder,
}: {
  data: Row;
  onOrder: (id: string) => void;
}) {
  const stats = data.stats || {},
    operations = data.operations || {};
  const online =
    data.worker &&
    Date.now() - new Date(data.worker.heartbeat).getTime() < 90000;
  return (
    <>
      <DataProtectionNotice/>
      <AdminResourceBoard />
      <AdminCosts cost={data.execution_cost} title={`最近 ${data.days || 7} 天发起任务的执行成本`} />
      <div
        className={`p-ops-banner ${!online || !operations.orders_open ? "warn" : ""}`}
      >
        <span className="p-dot" />
        <b>{online ? "执行器在线" : "执行器暂未就绪"}</b>
        <span>
          {operations.orders_open ? "客户订单开放受理" : "新订单受理已关闭"} ·{" "}
          {operations.worker_enabled ? "队列正常领取" : "队列领取已暂停"}
        </span>
        <small>最近心跳 {date(data.worker?.heartbeat)}</small>
      </div>
      <StatCards
        items={[
          {
            name: "客户账户",
            value: stats.customers,
            unit: "位",
            hint: `${number(stats.active_customers)} 个正常账户`,
            icon: <Users size={18} />,
          },
          {
            name: "客户可用积分",
            value: stats.balance,
            unit: "积分",
            hint: "客户账户汇总，不含管理员",
            icon: <Wallet size={18} />,
          },
          {
            name: "客户预留积分",
            value: stats.frozen,
            unit: "积分",
            hint: "受理中的订单预留",
            icon: <LockKeyhole size={18} />,
          },
          {
            name: "全部注册订单",
            value: stats.orders,
            unit: "笔",
            hint: `今日新增 ${number(stats.today_orders)} 笔`,
            icon: <Activity size={18} />,
          },
        ]}
      />
      <div className="p-ops-summary">
        <section className="p-card">
          <div className="p-section-heading">
            <div>
              <span className="p-eyebrow">ACTION CENTER</span>
              <h2>现在需要关注</h2>
            </div>
          </div>
          <Link to="/admin/orders?status=review" className="p-attention-row">
            <span className="p-icon-tile amber">
              <CircleAlert size={21} />
            </span>
            <div>
              <b>待人工核实</b>
              <small>核对原任务结果，再决定恢复或退款</small>
            </div>
            <strong>{number(stats.review)}</strong>
            <ArrowUpRight size={17} />
          </Link>
          <Link to="/admin/orders?status=queued" className="p-attention-row">
            <span className="p-icon-tile blue">
              <Timer size={21} />
            </span>
            <div>
              <b>排队中的订单</b>
              <small>按轮次领取，依次处理客户注册</small>
            </div>
            <strong>{number(stats.queued)}</strong>
            <ArrowUpRight size={17} />
          </Link>
          <Link to="/admin/accounts" className="p-attention-row">
            <span className="p-icon-tile">
              <KeyRound size={21} />
            </span>
            <div>
              <b>已交付账号</b>
              <small>与客户、订单一一关联</small>
            </div>
            <strong>{number(stats.delivered)}</strong>
            <ArrowUpRight size={17} />
          </Link>
        </section>
        <section className="p-card p-queue-panel">
          <span className="p-eyebrow">QUEUE STATUS</span>
          <h2>注册服务调度</h2>
          <div className="p-queue-ring">
            <strong>{number(stats.running)}</strong>
            <span>执行中订单</span>
          </div>
          <div className="p-queue-details">
            <span>
              单次执行<b>1 个账号</b>
            </span>
            <span>
              标准 / OAuth
              <b>
                {operations.price_standard} / {operations.price_oauth}
              </b>
            </span>
            <span>
              队列状态<b>{operations.worker_enabled ? "允许领取" : "已暂停"}</b>
            </span>
          </div>
          {data.worker?.error && (
            <div className="p-alert">{data.worker.error}</div>
          )}
          <Link to="/admin/products" className="p-queue-settings">
            管理价格与接单规则 →
          </Link>
        </section>
      </div>
      <div className="p-dashboard-columns">
        <Trend daily={data.daily} />
        <section className="p-card">
          <div className="p-section-heading">
            <div>
              <span className="p-eyebrow">DELIVERY & SETTLEMENT</span>
              <h2>交付与结算概览</h2>
            </div>
            <CheckCircle2 size={22} color="#7aa78e" />
          </div>
          <div className="p-settlement-summary">
            <div>
              <small>累计实际扣费</small>
              <strong>
                {number(stats.charged)}
                <em>积分</em>
              </strong>
            </div>
            <div>
              <small>未交付退回</small>
              <strong>
                {number(stats.released)}
                <em>积分</em>
              </strong>
            </div>
          </div>
          <div className="p-ledger-line">
            <span>全部完成订单</span>
            <b>{number(stats.completed)} 笔</b>
          </div>
          <div className="p-ledger-line">
            <span>订单完成率</span>
            <b>
              {stats.orders
                ? Math.round((stats.completed / stats.orders) * 100)
                : 0}
              %
            </b>
          </div>
          <p className="p-muted p-fine">
            积分仅在完整交付后扣除，失败及取消的未交付部分释放预留。
          </p>
          <Link className="p-link" to="/admin/finance">
            查看财务报表 →
          </Link>
        </section>
      </div>
      <div className="p-section-heading p-spaced-heading">
        <div>
          <span className="p-eyebrow">RECENT ORDERS</span>
          <h2>最新客户订单</h2>
        </div>
        <Link to="/admin/orders">
          进入订单监控
          <ArrowUpRight size={16} />
        </Link>
      </div>
      <section className="p-card p-record-card">
        <Table
          rows={data.recent_orders || []}
          columns={[
            {
              title: "客户 / 订单",
              render: (r) => (
                <>
                  <b>{r.email}</b>
                  <small className="p-block">{r.id.slice(0, 12)}</small>
                </>
              ),
            },
            {
              title: "注册服务",
              render: (r) => (r.need_oauth ? "OAuth 授权账号" : "标准账号"),
            },
            { title: "交付", render: (r) => `${r.delivered} / ${r.quantity}` },
            { title: "状态", render: (r) => <Status value={r.status} /> },
            { title: "时间", render: (r) => date(r.created_at) },
            {
              title: "操作",
              render: (r) => (
                <button className="p-link" onClick={() => onOrder(r.id)}>
                  查看详情
                </button>
              ),
            },
          ]}
        />
      </section>
    </>
  );
}
