import { useEffect, useState, type ReactNode } from "react";
import { registrationRegionName } from "./registrationRegion";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpRight,
  Check,
  Clock3,
  Copy,
  Gift,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  TrendingUp,
} from "lucide-react";
import { Link } from "../router";
import { call, copy, date, orderPending, type Row } from "./client";
import { Feedback, Modal, OrderDetail, Status, useAction } from "./Workspace";
import { Filters, Pagination, ledgerNames, number } from "./Insights";

const allowed = (user: Row, pub: Row, key: string) =>
  user.role === "admin" || pub.features?.[key] !== false;
const signed = (v: number) => `${v > 0 ? "+" : ""}${number(v)}`;
type Column = { title: string; render: (row: Row) => ReactNode };
function Records({
  rows,
  columns,
  loading,
}: {
  rows: Row[];
  columns: Column[];
  loading?: boolean;
}) {
  return (
    <div className="p-center-records" aria-busy={loading}>
      <table>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.title}>{c.title}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              {columns.map((c) => (
                <td key={c.title} data-label={c.title}>
                  <div>{c.render(r)}</div>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && (
        <div className="p-center-empty">
          <strong>{loading ? "正在读取记录…" : "暂无符合条件的记录"}</strong>
          <span>
            {loading ? "请稍候" : "你可以更换筛选条件，或稍后刷新查看。"}
          </span>
        </div>
      )}
    </div>
  );
}
const orderStatuses = {
  queued: "排队中",
  running: "执行中",
  review: "自动恢复中",
  completed: "全部完成",
  partial: "部分交付",
  failed: "未完成",
  cancelled: "已取消",
};
export function OrderRecords({
  profile = false,
  pub,
  user,
}: {
  profile?: boolean;
  pub: Row;
  user: Row;
}) {
  const [filters, setFilters] = useState<Row>({});
  const [offset, setOffset] = useState(0),
    [detail, setDetail] = useState("");
  const a = useAction(),
    q = useQueryClient();
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ["customer-orders", filters, offset],
    queryFn: () =>
      call(
        `/api/user/v1/registration-orders?${new URLSearchParams({ limit: "20", offset: String(offset), ...filters })}`,
      ),
    refetchInterval: (query) =>
      query.state.data?.items?.some(orderPending) ? 5000 : false,
  });
  const rows: Row[] = data?.items || [];
  const settlement = JSON.stringify(
    rows.map((r) => [r.id, r.charged, r.released, r.delivered]),
  );
  useEffect(() => {
    if (!data) return;
    void q.invalidateQueries({ queryKey: ["me"] });
    void q.invalidateQueries({ queryKey: ["profile-summary"] });
  }, [settlement, q]);
  const canWallet = allowed(user, pub, "wallet"),
    canAccounts = allowed(user, pub, "accounts");
  return (
    <>
      <section className="p-card p-record-card">
        <div className="p-records-heading">
          <div>
            {profile && <span className="p-eyebrow">YOUR ACTIVITY</span>}
            <h2>{profile ? "注册记录" : "全部订单"}</h2>
            <p>注册、授权与交付分别跟进，积分按实际交付结算。</p>
          </div>
          <button
            className="p-button secondary"
            disabled={isFetching}
            onClick={() => refetch()}
          >
            <RefreshCw size={15} />
            刷新记录
          </button>
        </div>
        {profile && (
          <div className="p-center-tabs" aria-label="订单记录状态">
            {[
              ["", "全部记录"],
              ["running", "执行中"],
              ["completed", "已完成"],
              ["review", "恢复中"],
              ["cancelled", "已取消"],
            ].map(([id, label]) => (
              <button
                key={id}
                aria-pressed={(filters.status || "") === id}
                className={(filters.status || "") === id ? "active" : ""}
                onClick={() => {
                  setFilters({ ...filters, status: id });
                  setOffset(0);
                }}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        <div className="p-center-filters">
          <Filters
            value={filters}
            onChange={(value) => {
              setFilters(value);
              setOffset(0);
            }}
            mode
            status={orderStatuses}
            placeholder="搜索完整订单编号"
          />
        </div>
        <Feedback a={a} />
        {error && (
          <p className="p-alert" role="alert">
            {error.message}
          </p>
        )}
        <Records
          rows={rows}
          loading={isFetching}
          columns={[
            {
              title: "订单 / 来源",
              render: (r) => (
                <>
                  <div className="p-record-id">
                    <code>{r.id}</code>
                    <button
                      className="p-link"
                      aria-label={`复制订单号 ${r.id}`}
                      onClick={() => a.run(() => copy(r.id), "订单号已复制")}
                    >
                      <Copy size={13} />
                    </button>
                  </div>
                  <small>
                    {r.source === "api" ? "API 接入" : "工作台提交"}
                  </small>
                </>
              ),
            },
            {
              title: "服务方案",
              render: (r) => (
                <>
                  <b>{r.need_oauth ? "注册并 OAuth" : "仅注册"}</b>
                  <small>Google Gmail · {r.quantity} 个账号</small>
                  <small>注册地区：{registrationRegionName(r.registration_region)}</small>
                </>
              ),
            },
            ...(canWallet
              ? [
                  {
                    title: "积分 / 结算",
                    render: (r: Row) => (
                      <>
                        <b>{number(r.unit_price)} 积分 / 个</b>
                        <small>
                          已扣 {number(r.charged)} · 已退 {number(r.released)}
                        </small>
                        <small>
                          待结算{" "}
                          {number(
                            Math.max(
                              0,
                              r.quantity * r.unit_price -
                                r.charged -
                                r.released,
                            ),
                          )}{" "}
                          积分
                        </small>
                      </>
                    ),
                  },
                ]
              : []),
            {
              title: "状态 / 交付",
              render: (r) => (
                <>
                  <Status value={r.status} />
                  <div className="p-center-progress">
                    <progress max={r.quantity || 1} value={r.delivered || 0} />
                    <small>
                      已交付 {r.delivered} / {r.quantity}
                    </small>
                  </div>
                  {r.cancel_requested && <small>已请求取消未执行部分</small>}
                </>
              ),
            },
            {
              title: "最近更新",
              render: (r) => (
                <>
                  <time>{date(r.updated_at)}</time>
                  <small>提交 {date(r.created_at)}</small>
                </>
              ),
            },
            {
              title: "操作",
              render: (r) => (
                <div className="p-record-actions">
                  <button className="p-link" onClick={() => setDetail(r.id)}>
                    查看详情 <ArrowUpRight size={13} />
                  </button>
                  {canAccounts && r.delivered > 0 && (
                    <Link
                      className="p-link"
                      to={`/accounts?order_id=${encodeURIComponent(r.id)}`}
                    >
                      领取账号 ↗
                    </Link>
                  )}
                </div>
              ),
            },
          ]}
        />
        <Pagination
          offset={offset}
          total={data?.total}
          count={rows.length}
          size={20}
          onChange={setOffset}
        />
      </section>
      {detail && <OrderDetail id={detail} onClose={() => setDetail("")} />}
    </>
  );
}
export function CustomerOrderCenter({ user, pub }: { user: Row; pub: Row }) {
  return (
    <>
      <div className="p-page-heading">
        <div>
          <span className="p-eyebrow">EVERY ORDER, IN ONE PLACE</span>
          <h1>订单中心</h1>
          <p>查注册、看交付、核积分，每一笔都有据可循。</p>
        </div>
        {allowed(user, pub, "register") && (
          <Link to="/register" className="p-button">
            <Plus size={17} />
            提交注册
          </Link>
        )}
      </div>
      <OrderRecords user={user} pub={pub} />
    </>
  );
}

export function FundsAccount({ user, pub }: { user: Row; pub: Row }) {
  const [tab, setTab] = useState("ledger"),
    [filters, setFilters] = useState<Row>({}),
    [offset, setOffset] = useState(0);
  const [redeem, setRedeem] = useState(""),
    [detail, setDetail] = useState("");
  const a = useAction(),
    q = useQueryClient();
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ["wallet-center", tab, filters, offset],
    queryFn: () =>
      call(
        `/api/user/v1/wallet?${new URLSearchParams({ tab, limit: "20", offset: String(offset), ...filters })}`,
      ),
  });
  const rows: Row[] = data?.items || [],
    totals = data?.totals;
  const update = (key: string, value: string) => {
    setFilters({ ...filters, [key]: value });
    setOffset(0);
  };
  const invalidDates =
    filters.start && filters.end && filters.start > filters.end;
  return (
    <>
      <div className="p-page-heading">
        <div>
          <span className="p-eyebrow">YOUR MONEY, MADE CLEAR</span>
          <h1>资金账户</h1>
          <p>余额、充值与每笔积分变动，一页看清。</p>
        </div>
        <button
          className="p-button secondary"
          disabled={isFetching}
          onClick={() => {
            void refetch();
            void q.invalidateQueries({ queryKey: ["me"] });
          }}
        >
          <RefreshCw size={15} />
          刷新账本
        </button>
      </div>
      <Feedback a={a} />
      <div className="p-funds-layout">
        <section className="p-balance-card">
          <span>账户可用金额</span>
          <strong>
            {number(data?.points ?? user.points)}
            <small>积分</small>
          </strong>
          <div>
            <span>
              <small>已预留</small>
              <b>{number(data?.frozen ?? user.frozen)} 积分</b>
            </span>
            <ShieldCheck size={34} />
          </div>
        </section>
        <section className="p-card p-redeem-card">
          <Gift size={25} />
          <h2>兑换入账</h2>
          <p>输入兑换码，积分即时到账。</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              a.run(
                () =>
                  call("/api/user/v1/redeem", "POST", { code: redeem.trim() }),
                "积分已到账",
              ).then((value) => {
                if (value) setRedeem("");
              });
            }}
          >
            <input
              required
              value={redeem}
              onChange={(e) => setRedeem(e.target.value)}
              aria-label="兑换码"
              placeholder="输入积分兑换码"
              autoComplete="off"
            />
            <button className="p-button" disabled={a.busy}>
              兑换 <ArrowUpRight size={15} />
            </button>
          </form>
        </section>
        <section className="p-card p-topup-card">
          <span className="p-eyebrow">ADD FUNDS</span>
          <h2>充值与支持</h2>
          <p>
            联系运营获取积分兑换码，或确认人工入账方式。到账后可在充值记录查询。
          </p>
          {pub.brand.support_url ? (
            <a
              className="p-button secondary"
              href={pub.brand.support_url}
              target="_blank"
              rel="noopener noreferrer"
            >
              联系充值客服 ↗
            </a>
          ) : (
            <span className="p-muted">请联系站点管理员获取兑换码。</span>
          )}
        </section>
      </div>
      <div className="p-section-heading">
        <div className="p-center-tabs">
          {[
            ["ledger", "资金流水"],
            ["recharges", "充值记录"],
          ].map(([id, label]) => (
            <button
              key={id}
              aria-pressed={tab === id}
              className={tab === id ? "active" : ""}
              onClick={() => {
                setTab(id);
                setFilters({});
                setOffset(0);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <small className="p-muted">金额单位：积分</small>
      </div>
      <section className="p-card p-record-card">
        <div className="p-records-heading">
          <div>
            <h2>{tab === "ledger" ? "资金明细" : "充值记录"}</h2>
            <p>
              {tab === "ledger"
                ? "下单预留，交付后从预留金额结算，不重复扣减可用积分。"
                : "兑换码与运营人工入账记录，与资金流水一致。"}
            </p>
          </div>
        </div>
        <div className="p-ledger-totals">
          {[
            ["充值入账", "credited"],
            ["服务扣费", "charged"],
            ["累计预留", "reserved"],
            ["解冻 / 退回", "released"],
          ].map(([label, key]) => (
            <div key={key}>
              <span>{label}</span>
              <b>
                {totals ? number(totals[key]) : "—"}
                <small>积分</small>
              </b>
            </div>
          ))}
        </div>
        <form
          className="p-funds-filters"
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            update("q", String(form.get("q") || "").trim());
          }}
        >
          <input
            key={`${tab}:${filters.q || ""}`}
            name="q"
            type="search"
            defaultValue={filters.q || ""}
            maxLength={200}
            aria-label="搜索流水"
            placeholder="订单号 / 流水编号 / 说明"
          />
          <select
            aria-label="流水类型"
            value={filters.kind || ""}
            onChange={(e) => update("kind", e.target.value)}
          >
            <option value="">全部类型</option>
            {Object.entries(ledgerNames)
              .filter(
                ([key]) =>
                  tab === "ledger" || ["redeem", "adjust"].includes(key),
              )
              .map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
          </select>
          <input
            type="date"
            aria-label="开始日期"
            value={filters.start || ""}
            max={filters.end || undefined}
            onChange={(e) => update("start", e.target.value)}
          />
          <span>至</span>
          <input
            type="date"
            aria-label="结束日期"
            min={filters.start || undefined}
            value={filters.end || ""}
            onChange={(e) => update("end", e.target.value)}
          />
          <button className="p-button secondary">查询</button>
          {Object.values(filters).some(Boolean) && (
            <button
              className="p-link"
              type="button"
              onClick={() => {
                setFilters({});
                setOffset(0);
              }}
            >
              重置
            </button>
          )}
        </form>
        {(error || invalidDates) && (
          <p className="p-alert" role="alert">
            {invalidDates ? "结束日期不能早于开始日期。" : error?.message}
          </p>
        )}
        <Records
          rows={rows}
          loading={isFetching}
          columns={[
            {
              title: "流水类型",
              render: (r) => (
                <>
                  <b>{ledgerNames[r.kind] || r.kind}</b>
                  <code className="p-record-small-id">{r.id}</code>
                </>
              ),
            },
            {
              title: "业务来源",
              render: (r) => (
                <>
                  <b>
                    {r.order_id
                      ? r.need_oauth
                        ? "注册并 OAuth"
                        : "仅注册"
                      : r.kind === "redeem"
                        ? "兑换码入账"
                        : r.kind === "adjust"
                          ? "运营人工调整"
                          : "注册服务"}
                  </b>
                  <small>{r.order_id ? "注册订单" : "账户积分"}</small>
                </>
              ),
            },
            {
              title: "可用变动",
              render: (r) => (
                <b
                  className={
                    r.points_delta > 0
                      ? "p-money-positive"
                      : r.points_delta < 0
                        ? "p-money-negative"
                        : ""
                  }
                >
                  {signed(r.points_delta)}
                </b>
              ),
            },
            {
              title: "预留变动",
              render: (r) => <b>{signed(r.frozen_delta)}</b>,
            },
            {
              title: "变动后余额",
              render: (r) =>
                r.points_after == null ? (
                  <small>历史记录未保存余额快照</small>
                ) : (
                  <>
                    <b>{number(r.points_after)} 积分</b>
                    <small>预留 {number(r.frozen_after)} 积分</small>
                  </>
                ),
            },
            {
              title: "关联记录",
              render: (r) =>
                r.order_id ? (
                  <button
                    className="p-link p-record-small-id"
                    onClick={() => setDetail(r.order_id)}
                  >
                    {r.order_id} ↗
                  </button>
                ) : (
                  <span className="p-muted">
                    {r.kind === "redeem" ? "积分兑换" : "账户变动"}
                  </span>
                ),
            },
            {
              title: "说明 / 时间",
              render: (r) => (
                <>
                  <span>{r.note}</span>
                  <small>{date(r.created_at)}</small>
                </>
              ),
            },
          ]}
        />
        <p className="p-records-note">
          汇总覆盖当前筛选下的全部记录；日期按北京时间查询。
        </p>
        <Pagination
          offset={offset}
          total={data?.total}
          count={rows.length}
          size={20}
          onChange={setOffset}
        />
      </section>
      {detail && <OrderDetail id={detail} onClose={() => setDetail("")} />}
    </>
  );
}

export function PersonalSettings({
  user,
  pub,
  onLogout,
}: {
  user: Row;
  pub: Row;
  onLogout: () => void;
}) {
  const [modal, setModal] = useState(""),
    [name, setName] = useState(user.name),
    [oldPassword, setOldPassword] = useState(""),
    [password, setPassword] = useState(""),
    [confirm, setConfirm] = useState("");
  const a = useAction();
  const { data, error } = useQuery({
    queryKey: ["profile-summary"],
    queryFn: () => call("/api/user/v1/profile-summary"),
  });
  const stats = data?.stats;
  const wallet = allowed(user, pub, "wallet"),
    orders = allowed(user, pub, "orders");
  const metrics = [
    ...(orders
      ? [
          {
            key: "orders",
            name: "注册订单",
            unit: "笔",
            icon: <Copy size={17} />,
            note: "全部注册服务记录",
          },
          {
            key: "completed",
            name: "已完成交付",
            unit: "笔",
            icon: <Check size={17} />,
            note: "全部账号交付完成的订单",
          },
          {
            key: "pending",
            name: "待完成订单",
            unit: "笔",
            icon: <Clock3 size={17} />,
            note: "排队及执行中的注册订单",
          },
        ]
      : []),
    ...(wallet
      ? [
          {
            key: "spent",
            name: "累计服务消费",
            unit: "积分",
            icon: <TrendingUp size={17} />,
            note: "按实际账号交付扣费统计",
          },
        ]
      : []),
  ];
  function open(kind: string) {
    setModal(kind);
    setName(user.name);
    setOldPassword("");
    setPassword("");
    setConfirm("");
    a.setError("");
    a.setNotice("");
  }
  function close() {
    if (a.busy) return;
    setModal("");
    setOldPassword("");
    setPassword("");
    setConfirm("");
    a.setError("");
  }
  return (
    <>
      <div className="p-page-heading">
        <div>
          <span className="p-eyebrow">YOUR ACCOUNT, AT A GLANCE</span>
          <h1>个人设置</h1>
          <p>账户、积分与注册记录集中查看，每次交付都有迹可循。</p>
        </div>
        <div className="p-inline">
          <button
            className="p-button secondary"
            onClick={() => open("password")}
          >
            <KeyRound size={16} />
            修改密码
          </button>
          <button className="p-button secondary" onClick={onLogout}>
            退出当前账号
          </button>
        </div>
      </div>
      {!modal && <Feedback a={a} />}
      {error && (
        <p className="p-alert" role="alert">
          {error.message}
        </p>
      )}
      <div className="p-personal-overview">
        <section className="p-personal-identity">
          <div className="p-personal-person">
            <span className="p-personal-avatar">{user.name.slice(0, 1)}</span>
            <div>
              <h2>{user.name}</h2>
              <div className="p-personal-email">
                <span>{user.email}</span>
                <button
                  className="p-link"
                  aria-label="复制账户邮箱"
                  onClick={() => a.run(() => copy(user.email), "邮箱已复制")}
                >
                  <Copy size={13} />
                </button>
              </div>
            </div>
            <button
              className="p-link"
              aria-label="编辑用户名"
              onClick={() => open("name")}
            >
              <Pencil size={16} />
            </button>
          </div>
          {wallet && (
            <div className="p-personal-balance">
              <span>账户可用金额</span>
              <strong>
                {number(user.points)}
                <small>积分</small>
              </strong>
              <p>
                预留金额 <b>{number(user.frozen)} 积分</b>
              </p>
            </div>
          )}
          <div className="p-personal-foot">
            <span>
              <ShieldCheck size={15} />
              {user.role === "admin" ? "管理员账户" : "客户账户"}
            </span>
            {wallet && (
              <Link to="/wallet">
                管理资金 <ArrowUpRight size={15} />
              </Link>
            )}
          </div>
          <p className="p-personal-created">注册于 {date(user.created_at)}</p>
        </section>
        <div className="p-personal-metrics">
          {metrics.map((m) => (
            <article className="p-card" key={m.key}>
              <div>
                <span>{m.name}</span>
                {m.icon}
              </div>
              <strong>
                {stats ? number(stats[m.key]) : "—"}
                <small>{m.unit}</small>
              </strong>
              <p>{m.note}</p>
            </article>
          ))}
        </div>
      </div>
      {orders && <OrderRecords profile user={user} pub={pub} />}
      {modal && (
        <Modal
          title={modal === "name" ? "编辑用户名" : "修改登录密码"}
          onClose={close}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (modal === "password" && password !== confirm) {
                a.setError("两次输入的新密码不一致。");
                return;
              }
              a.run(
                () =>
                  call(
                    "/api/user/v1/me",
                    "PATCH",
                    modal === "name"
                      ? { name: name.trim() }
                      : {
                          name: user.name,
                          old_password: oldPassword,
                          password,
                        },
                  ),
                modal === "name" ? "用户名已更新" : "密码已更新，请重新登录",
              ).then((result) => {
                if (result) {
                  setModal("");
                  setOldPassword("");
                  setPassword("");
                  setConfirm("");
                  if (result.relogin) onLogout();
                }
              });
            }}
          >
            <Feedback a={a} />
            {modal === "name" ? (
              <>
                <label>
                  账户邮箱
                  <input readOnly value={user.email} />
                </label>
                <label>
                  用户名
                  <input
                    required
                    maxLength={80}
                    autoComplete="nickname"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
              </>
            ) : (
              <>
                <p className="p-muted">
                  密码须为 10～72 位。修改后需要重新登录，原会话与 API
                  密钥将失效。
                </p>
                <label>
                  当前密码
                  <input
                    required
                    type="password"
                    autoComplete="current-password"
                    value={oldPassword}
                    onChange={(e) => setOldPassword(e.target.value)}
                  />
                </label>
                <label>
                  新密码
                  <input
                    required
                    type="password"
                    minLength={10}
                    maxLength={72}
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
                <label>
                  确认新密码
                  <input
                    required
                    type="password"
                    minLength={10}
                    maxLength={72}
                    autoComplete="new-password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                  />
                </label>
              </>
            )}
            <button className="p-button" disabled={a.busy}>
              {a.busy ? "保存中…" : "保存修改"}
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}
