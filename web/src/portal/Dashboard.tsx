import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  ArrowUpRight,
  Bell,
  Check,
  Code2,
  KeyRound,
  LockKeyhole,
  ReceiptText,
  RefreshCw,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { Link } from "../router";
import { call, date, type Row } from "./client";
import { OrderDetail, Status, Table } from "./Workspace";
import { StatCards, Trend, number, ledgerNames } from "./Insights";
import ServiceFeatures from "./ServiceFeatures";
export default function Dashboard({ user, pub }: { user: Row; pub: Row }) {
  const [detail, setDetail] = useState(""),
    q = useQueryClient();
  const { data, error, refetch, isFetching } = useQuery({
    queryKey: ["customer-overview"],
    queryFn: () => call("/api/user/v1/overview"),
    refetchInterval: (query) =>
      query.state.data?.stats?.active_orders > 0 ? 5000 : false,
  });
  const stats = data?.stats || {};
  const available = (feature: string) =>
    user.role === "admin" || pub.features?.[feature] !== false;
  useEffect(() => {
    if (data) void q.invalidateQueries({ queryKey: ["me"] });
  }, [stats.spent, stats.released, q]);
  return (
    <>
      <section className="p-hero">
        <div>
          <span className="p-eyebrow">YOUR ACCOUNT WORKSPACE</span>
          <h1>
            你好，{user.name}。<br />
            <span>Gmail 实时注册，按需交付。</span>
          </h1>
          <p>{pub.brand.tagline}</p>
          {available("register") && (
            <Link to="/register" className="p-button mint">
              开始新的注册
              <ArrowUpRight size={18} />
            </Link>
          )}
        </div>
        <div className="p-hero-art" aria-hidden="true">
          <div className="p-art-back">
            <span>ACCOUNT SERVICES</span>
            <KeyRound size={40} />
            <i />
          </div>
          <div className="p-art-front">
            <span>{pub.brand.english_name} / DELIVERY</span>
            <Check size={35} />
            <b>交付清晰，记录可查。</b>
            <div>
              <i />
              <i />
              <i />
              <i />
            </div>
          </div>
          <span className="p-art-spark">✳</span>
        </div>
      </section>
      <ServiceFeatures />
      {pub.announcement && (
        <details className="p-announcement-strip" open>
          <summary>
            <Bell size={17} />
            <b>站点公告</b>
            <span>服务动态与使用说明</span>
          </summary>
          <p>{pub.announcement}</p>
        </details>
      )}
      {(pub.announcements || []).map((a: Row) => (
        <details key={a.id} className="p-announcement-strip" open>
          <summary>
            <Bell size={17} />
            <b>{a.title}</b>
          </summary>
          <p>{a.body}</p>
        </details>
      ))}
      {error && (
        <div className="p-alert">
          {error.message}
          <button className="p-link" onClick={() => refetch()}>
            重试
          </button>
        </div>
      )}
      <StatCards
        items={[
          {
            name: "可用积分",
            value: user.points,
            unit: "积分",
            hint: available("wallet") ? (
              <Link to="/wallet">
                充值 / 兑换
                <ArrowRight size={13} />
              </Link>
            ) : (
              "按实际交付结算"
            ),
            icon: <Wallet size={18} />,
          },
          {
            name: "预留积分",
            value: user.frozen,
            unit: "积分",
            hint: "未完成订单占用，按实际交付结算",
            icon: <LockKeyhole size={18} />,
          },
          {
            name: "累计服务消费",
            value: stats.spent,
            unit: "积分",
            hint: "已交付账号的实际扣费",
            icon: <ReceiptText size={18} />,
          },
          {
            name: "已交付账号",
            value: stats.delivered,
            unit: "个",
            hint: `${number(stats.orders)} 笔订单 · ${number(stats.active_orders)} 笔处理中`,
            icon: <KeyRound size={18} />,
          },
        ]}
      />
      {available("register") && (
        <>
          <div className="p-section-heading p-spaced-heading">
            <div>
              <span className="p-eyebrow">EXPLORE SERVICES</span>
              <h2>选择适合你的注册服务</h2>
            </div>
            <Link to="/register">
              查看服务
              <ArrowUpRight size={16} />
            </Link>
          </div>
          <div className="p-service-grid">
            {[false, true].map((oauth) => (
              <Link
                key={String(oauth)}
                to={oauth ? "/register?oauth=1" : "/register"}
                className={`p-service-card ${oauth ? "premium" : ""}`}
              >
                <div>
                  <span className="p-service-number">
                    {oauth ? "02" : "01"}
                  </span>
                  <span className="p-status active">
                    {oauth ? "含 OAuth 授权" : "标准交付"}
                  </span>
                </div>
                {oauth ? <Code2 size={27} /> : <ShieldCheck size={27} />}
                <h3>{oauth ? "OAuth 授权账号" : "标准注册账号"}</h3>
                <p>
                  {oauth
                    ? "邮箱、密码、2FA，以及完整的 OAuth 授权数据。"
                    : "一次注册，完整交付邮箱、密码与 2FA 凭据。"}
                </p>
                <footer>
                  <span>
                    <b>{oauth ? pub.price_oauth : pub.price_standard}</b> 积分 /
                    个
                  </span>
                  <ArrowUpRight size={21} />
                </footer>
              </Link>
            ))}
          </div>
        </>
      )}
      <div className="p-dashboard-columns">
        <Trend daily={data?.daily} />
        <section className="p-card">
          <div className="p-section-heading">
            <div>
              <span className="p-eyebrow">QUICK ACCESS</span>
              <h2>你的服务空间</h2>
            </div>
          </div>
          {[
            [
              "/orders",
              "跟踪注册进度",
              `${number(stats.active_orders)} 笔订单正在处理`,
              ReceiptText,
            ],
            [
              "/accounts",
              "领取已交付账号",
              "查看密码、2FA 与导出资料",
              KeyRound,
            ],
            ["/keys", "通过 API 接入", "创建密钥，用程序管理订单", Code2],
          ]
            .filter(([url]) => available(String(url).slice(1)))
            .map(([url, title, text, Icon]) => {
              const I = Icon as typeof Wallet;
              return (
                <Link
                  to={String(url)}
                  className="p-attention-row"
                  key={String(url)}
                >
                  <span className="p-icon-tile">
                    <I size={20} />
                  </span>
                  <div>
                    <b>{String(title)}</b>
                    <small>{String(text)}</small>
                  </div>
                  <ArrowUpRight size={17} />
                </Link>
              );
            })}
        </section>
      </div>
      {available("orders") && (
        <>
          <div className="p-section-heading p-spaced-heading">
            <div>
              <span className="p-eyebrow">RECENT ACTIVITY</span>
              <h2>最近订单</h2>
            </div>
            <div className="p-inline">
              <button
                className="p-header-icon"
                aria-label="刷新概览"
                disabled={isFetching}
                onClick={() => {
                  void refetch();
                  void q.invalidateQueries({ queryKey: ["me"] });
                }}
              >
                <RefreshCw size={17} />
              </button>
              <Link to="/orders">
                全部订单
                <ArrowRight size={16} />
              </Link>
            </div>
          </div>
          <section className="p-card p-record-card">
            <Table
              rows={data?.recent_orders || []}
              empty="还没有注册记录，选择一个服务开始第一笔订单。"
              columns={[
                {
                  title: "订单编号",
                  render: (r) => <code>{r.id.slice(0, 12)}</code>,
                },
                {
                  title: "注册服务",
                  render: (r) =>
                    r.need_oauth ? "OAuth 授权账号" : "标准注册账号",
                },
                {
                  title: "交付进度",
                  render: (r) => `${r.delivered} / ${r.quantity}`,
                },
                { title: "状态", render: (r) => <Status value={r.status} /> },
                { title: "创建时间", render: (r) => date(r.created_at) },
                {
                  title: "操作",
                  render: (r) => (
                    <button className="p-link" onClick={() => setDetail(r.id)}>
                      查看进度 ↗
                    </button>
                  ),
                },
              ]}
            />
          </section>
        </>
      )}
      {available("wallet") && (data?.recent_ledger || []).length > 0 && (
        <section className="p-card">
          <div className="p-section-heading">
            <h2>最近积分动态</h2>
            <Link to="/wallet">查看账本 →</Link>
          </div>
          {data.recent_ledger.map((r: Row) => (
            <div className="p-ledger-line" key={r.id}>
              <div>
                <b>{ledgerNames[r.kind]}</b>
                <small>{date(r.created_at)}</small>
              </div>
              <strong>
                {r.kind === "charge"
                  ? `${r.frozen_delta} 预留积分`
                  : `${r.points_delta > 0 ? "+" : ""}${r.points_delta} 积分`}
              </strong>
            </div>
          ))}
        </section>
      )}
      {detail && <OrderDetail id={detail} onClose={() => setDetail("")} />}
    </>
  );
}
