import { useState, useEffect, lazy, Suspense, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Check, Copy, Download, Plus } from "lucide-react";
import {
  call,
  copy,
  date,
  download,
  statusNames,
  orderPending,
  type Row,
} from "./client";
import { Link } from "../router";
import { Filters, Pagination, ledgerNames } from "./Insights";
import ServiceFeatures from "./ServiceFeatures";
import { useOrderSubmission } from "./orderSubmission";
const AdminOrderActions = lazy(() => import("./AdminOrderActions"));
export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div className="p-modal-backdrop" onClick={onClose}>
      <section
        className="p-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <header>
          <h2>{title}</h2>
          <button className="p-button secondary" onClick={onClose}>
            关闭
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}
export function Status({ value }: { value: string }) {
  return (
    <span className={`p-status ${value}`}>{statusNames[value] || value}</span>
  );
}
export function Table({
  columns,
  rows,
  empty = "暂无记录",
}: {
  columns: { title: string; render: (r: Row) => ReactNode }[];
  rows: Row[];
  empty?: string;
}) {
  return (
    <div className="p-table-wrap">
      <table>
        <thead>
          <tr>
            {columns.map((c, i) => (
              <th key={i}>{c.title}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id || i}>
              {columns.map((c, j) => (
                <td key={j}>{c.render(r)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <div className="p-empty">{empty}</div>}
    </div>
  );
}
export function useAction() {
  const q = useQueryClient(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  async function run(fn: () => Promise<any>, success = "操作成功") {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await fn();
      setNotice(success);
      await q.invalidateQueries();
      return result;
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return { run, busy, error, notice, setError, setNotice };
}
export function Feedback({ a }: { a: ReturnType<typeof useAction> }) {
  return (
    <>
      {a.error && (
        <div className="p-alert" role="alert">
          {a.error}
        </div>
      )}
      {a.notice && (
        <div className="p-notice" role="status">
          {a.notice}
        </div>
      )}
    </>
  );
}
export function OrderDetail({
  id,
  admin = false,
  onClose,
}: {
  id: string;
  admin?: boolean;
  onClose: () => void;
}) {
  const prefix = admin
    ? "/api/admin/v1/orders"
    : "/api/user/v1/registration-orders";
  const q = useQueryClient();
  const { data, error, refetch } = useQuery({
    queryKey: ["order-detail", id, admin],
    queryFn: () => call(`${prefix}/${id}`),
    refetchInterval: (query) => (orderPending(query.state.data) ? 5000 : false),
  });
  useEffect(() => {
    if (data && !admin) void q.invalidateQueries({ queryKey: ["me"] });
  }, [data?.charged, data?.released, data?.delivered, admin, q]);
  const a = useAction();
  return (
    <Modal title="订单详情" onClose={onClose}>
      <button className="p-button secondary" onClick={() => refetch()}>
        刷新订单
      </button>
      <Feedback a={a} />
      {error && <div className="p-alert">{error.message}</div>}
      {data ? (
        <>
          <code className="p-order-id">{id}</code>
          <div className="p-detail-summary">
            <Status value={data.status} />
            <span>{data.need_oauth ? "需要 OAuth" : "不需要 OAuth"}</span>
            <span>
              已交付 {data.delivered} / {data.quantity}
            </span>
          </div>
          <div className="p-delivery-progress">
            <span>
              交付进度{" "}
              <b>
                {data.delivered} / {data.quantity}
              </b>
            </span>
            <progress max={data.quantity || 1} value={data.delivered || 0} />
          </div>
          <div className="p-stats compact">
            <div>
              <small>单价</small>
              <b>{data.unit_price} 积分</b>
            </div>
            <div>
              <small>已扣除</small>
              <b>{data.charged} 积分</b>
            </div>
            <div>
              <small>已退回</small>
              <b>{data.released} 积分</b>
            </div>
          </div>
          <Table
            rows={data.items}
            columns={[
              { title: "序号", render: (r) => r.position },
              { title: "状态", render: (r) => <Status value={r.status} /> },
              { title: "进度", render: (r) => r.message || "等待执行" },
              { title: "更新时间", render: (r) => date(r.updated_at) },
            ]}
          />
          {admin && (
            <Suspense fallback={null}>
              <AdminOrderActions data={data} />
            </Suspense>
          )}
          {["queued", "running", "review"].includes(data.status) && (
            <button
              className="p-button secondary"
              disabled={a.busy || data.cancel_requested}
              onClick={() =>
                a.run(
                  () => call(`${prefix}/${id}/cancel`, "POST", {}),
                  "已请求取消未执行部分",
                )
              }
            >
              {data.cancel_requested ? "已请求取消" : "取消未执行部分"}
            </button>
          )}
        </>
      ) : (
        <p>加载中…</p>
      )}
    </Modal>
  );
}
export default function Workspace({
  page,
  user,
  pub,
  onLogout,
}: {
  page: string;
  user: Row;
  pub: Row;
  onLogout: () => void;
}) {
  const a = useAction(),
    [detail, setDetail] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [secret, setSecret] = useState<Row | null>(null),
    [keyText, setKeyText] = useState(""),
    [redeem, setRedeem] = useState(""),
    [name, setName] = useState(user.name),
    [pw, setPw] = useState(""),
    [oldPw, setOldPw] = useState(""),
    [keyName, setKeyName] = useState(""),
    [scopes, setScopes] = useState([
      "orders:read",
      "orders:write",
      "accounts:read",
      "credentials:read",
    ]),
    [offset, setOffset] = useState(0),
    [filters, setFilters] = useState<Row>({});
  useEffect(() => {
    setOffset(0);
    setSelected([]);
  }, [page]);
  const listPath =
    page === "accounts"
      ? "/accounts"
      : page === "wallet"
        ? "/ledger"
        : page === "keys"
          ? "/keys"
          : "/registration-orders";
  const q = useQueryClient();
  const submission = useOrderSubmission(
    user.id,
    new URLSearchParams(location.search).get("oauth") === "1",
    (id) => {
      setDetail(id);
      void q.invalidateQueries({ queryKey: ["me"] });
      void q.invalidateQueries({ queryKey: ["workspace-list"] });
      void q.invalidateQueries({ queryKey: ["public"] });
    },
  );
  const { quantity, setQuantity, oauth, setOauth } = submission;
  const { data, error, refetch, isFetching } = useQuery({
    queryKey: ["workspace-list", page, offset, filters],
    queryFn: () =>
      call(
        `/api/user/v1${listPath}?${new URLSearchParams({ limit: "50", offset: String(offset), ...filters })}`,
      ),
    enabled: !["profile", "register"].includes(page),
    refetchInterval: (query) =>
      page === "orders" && query.state.data?.items?.some(orderPending)
        ? 5000
        : false,
  });
  const settlement =
    page === "orders" && data
      ? JSON.stringify(
          data.items.map((r: Row) => [
            r.id,
            r.charged,
            r.released,
            r.delivered,
          ]),
        )
      : "";
  useEffect(() => {
    if (settlement) void q.invalidateQueries({ queryKey: ["me"] });
  }, [settlement, q]);
  const rows: Row[] = data?.items || [],
    price = oauth ? pub.price_oauth : pub.price_standard;
  async function exported(format: string) {
    const r = await a.run(
      () =>
        call("/api/user/v1/accounts/export", "POST", { ids: selected, format }),
      "导出已准备",
    );
    if (r) download(r.filename, r.content);
  }
  const orderTable = (
    <Table
      rows={rows}
      columns={[
        {
          title: "订单",
          render: (r) => (
            <button className="p-link" onClick={() => setDetail(r.id)}>
              {r.id.slice(0, 8)} <ArrowUpRight size={13} />
            </button>
          ),
        },
        {
          title: "模式",
          render: (r) => (r.need_oauth ? "含 OAuth" : "标准账号"),
        },
        {
          title: "进度",
          render: (r) => (
            <span className="p-progress-line">
              <i>
                <span
                  style={{
                    width: `${r.quantity ? (r.delivered / r.quantity) * 100 : 0}%`,
                  }}
                />
              </i>
              {r.delivered} / {r.quantity}
            </span>
          ),
        },
        { title: "状态", render: (r) => <Status value={r.status} /> },
        {
          title: "扣除 / 退回",
          render: (r) => `${r.charged} / ${r.released} 积分`,
        },
        { title: "提交时间", render: (r) => date(r.created_at) },
      ]}
    />
  );
  return (
    <>
      <Feedback a={a} />
      {!["profile", "register"].includes(page) && (
        <div className="p-refresh-row">
          <button
            className="p-button secondary"
            disabled={isFetching}
            onClick={() => {
              void refetch();
              void q.invalidateQueries({ queryKey: ["me"] });
            }}
          >
            刷新数据
          </button>
        </div>
      )}
      {error && <div className="p-alert">{error.message}</div>}
      {page === "register" && (
        <>
          {submission.error && (
            <div className="p-alert" role="alert">
              {submission.error}
            </div>
          )}
          {submission.notice && (
            <div className="p-notice" role="status">
              {submission.notice}
            </div>
          )}
          {submission.pending && (
            <div className="p-notice">
              有一笔提交尚未确认，已保留原数量与模式；刷新页面后也可继续确认。
              <Link to="/orders">查看我的订单</Link>
            </div>
          )}
          <div className="p-page-heading">
            <div>
              <span className="p-eyebrow">ACCOUNT REGISTRATION</span>
              <h1>开始一笔新注册</h1>
              <p>选择服务、填写数量，实时跟踪注册与交付。</p>
            </div>
            <Link to="/orders" className="p-button secondary">
              我的订单 ↗
            </Link>
          </div>
          <ServiceFeatures compact />
          <div className="p-registration-layout">
            <section className="p-card p-order-card">
              <div className="p-registration-steps">
                <span className="active">01 选择服务</span>
                <span>02 设置数量</span>
                <span>03 提交注册</span>
              </div>
              <h2>你需要哪种交付？</h2>
              <p className="p-muted">
                两种服务均包含邮箱、密码和 2FA，可按需增加 OAuth 授权数据。
              </p>
              <div className="p-mode-grid">
                {[false, true].map((o) => (
                  <button
                    key={String(o)}
                    className={`p-mode ${oauth === o ? "selected" : ""}`}
                    disabled={submission.busy || submission.pending}
                    onClick={() => {
                      setOauth(o);
                    }}
                  >
                    <div>
                      <b>{o ? "需要 OAuth" : "不需要 OAuth"}</b>
                      {oauth === o && <Check size={18} />}
                    </div>
                    <p>
                      {o ? "账号凭据 + OAuth 授权数据" : "邮箱 + 密码 + 2FA"}
                    </p>
                    <strong>
                      {o ? pub.price_oauth : pub.price_standard}
                      <small> 积分 / 个</small>
                    </strong>
                  </button>
                ))}
              </div>
              <div className="p-order-bottom">
                <label>
                  注册数量
                  <input
                    type="number"
                    min={1}
                    max={pub.max_quantity}
                    value={quantity}
                    disabled={submission.busy || submission.pending}
                    onChange={(e) => {
                      setQuantity(Number(e.target.value));
                    }}
                  />
                </label>
                <div>
                  <small>本次预留积分</small>
                  <strong>
                    {Number.isFinite(quantity) ? quantity * price : 0}
                    <em> 积分</em>
                  </strong>
                </div>
                <button
                  className="p-button"
                  disabled={
                    submission.busy ||
                    (!submission.pending &&
                      (!pub.orders_open ||
                        quantity < 1 ||
                        quantity > pub.max_quantity ||
                        !Number.isInteger(quantity) ||
                        quantity * price > user.points))
                  }
                  onClick={submission.submit}
                >
                  {submission.busy
                    ? "正在确认…"
                    : submission.pending
                      ? "确认上次提交"
                      : !pub.orders_open
                        ? "暂未开放下单"
                        : quantity * price > user.points
                          ? "可用积分不足"
                          : "提交注册"}
                  <ArrowUpRight size={17} />
                </button>
              </div>

              <p className="p-muted p-fine">
                每单最多 {pub.max_quantity} 个。提交后预留积分，按实际交付结算。
              </p>
            </section>
            <aside className="p-card p-quote-card">
              <span className="p-eyebrow">ORDER SUMMARY</span>
              <h2>本次服务清单</h2>
              <div className="p-ledger-line">
                <span>服务模式</span>
                <b>{oauth ? "包含 OAuth" : "标准账号"}</b>
              </div>
              <div className="p-ledger-line">
                <span>注册数量</span>
                <b>{quantity || 0} 个</b>
              </div>
              <div className="p-ledger-line">
                <span>单个价格</span>
                <b>{price} 积分</b>
              </div>
              <div className="p-quote-total">
                <span>本次预留</span>
                <strong>
                  {quantity * price || 0}
                  <small>积分</small>
                </strong>
              </div>
              <p className="p-muted">
                当前可用 {user.points.toLocaleString()} 积分{" "}
                <Link to="/wallet">去充值 →</Link>
              </p>
              <ul>
                <li>
                  <Check size={15} />
                  Gmail 邮箱与账号密码
                </li>
                <li>
                  <Check size={15} />
                  2FA 密钥与动态验证码
                </li>
                {oauth && (
                  <li>
                    <Check size={15} />
                    OAuth 授权数据导出
                  </li>
                )}
                <li>
                  <Check size={15} />
                  未交付部分退回积分
                </li>
              </ul>
              <div className="p-inline-help">
                提交后到订单中心查看进度，交付完成后在“我的账号”领取资料。
              </div>
            </aside>
          </div>
        </>
      )}
      {page === "orders" && (
        <>
          <div className="p-page-heading">
            <div>
              <h1>我的订单</h1>
              <p>跟踪每笔注册，查看交付进度与积分结算。</p>
            </div>
            <Link to="/register" className="p-button">
              新建注册 ↗
            </Link>
          </div>
          <Filters
            value={filters}
            onChange={(v) => {
              setFilters(v);
              setOffset(0);
            }}
            mode
            status={{
              queued: "排队中",
              running: "执行中",
              review: "待核实",
              completed: "全部完成",
              partial: "部分完成",
              failed: "未完成",
              cancelled: "已取消",
            }}
            placeholder="搜索订单编号"
          />
          <section className="p-card p-record-card">{orderTable}</section>
        </>
      )}
      {page === "accounts" && (
        <>
          <div className="p-page-heading">
            <div>
              <h1>我的账号</h1>
              <p>每个账号都与你的订单关联，凭据仅对你可见。</p>
            </div>
            <div className="p-inline">
              <button
                className="p-button secondary"
                disabled={!selected.length || a.busy}
                onClick={() => exported("txt")}
              >
                <Download size={16} />
                导出 TXT
              </button>
              <button
                className="p-button secondary"
                disabled={!selected.length || a.busy}
                onClick={() => exported("csv")}
              >
                导出 CSV
              </button>
              <button
                className="p-button"
                disabled={!selected.length || a.busy}
                onClick={() => exported("json")}
              >
                导出 JSON / OAuth
              </button>
            </div>
          </div>
          <Filters
            value={filters}
            onChange={(v) => {
              setFilters(v);
              setOffset(0);
              setSelected([]);
            }}
            mode
            placeholder="搜索邮箱或订单编号"
          />
          <section className="p-card">
            <Table
              rows={rows}
              columns={[
                {
                  title: "选择",
                  render: (r) => (
                    <input
                      type="checkbox"
                      aria-label={`选择 ${r.email}`}
                      checked={selected.includes(r.id)}
                      onChange={(e) =>
                        setSelected(
                          e.target.checked
                            ? [...selected, r.id]
                            : selected.filter((x) => x !== r.id),
                        )
                      }
                    />
                  ),
                },
                { title: "邮箱", render: (r) => r.email },
                {
                  title: "模式",
                  render: (r) => (r.need_oauth ? "含 OAuth" : "标准账号"),
                },
                { title: "交付时间", render: (r) => date(r.created_at) },
                {
                  title: "操作",
                  render: (r) => (
                    <button
                      className="p-link"
                      onClick={async () => {
                        const v = await a.run(
                          () =>
                            call(`/api/user/v1/accounts/${r.id}/credentials`),
                          "",
                        );
                        if (v) setSecret({ ...v, id: r.id });
                      }}
                    >
                      查看凭据
                    </button>
                  ),
                },
              ]}
            />
            <button
              className="p-link"
              onClick={() =>
                setSelected(
                  selected.length === rows.length ? [] : rows.map((r) => r.id),
                )
              }
            >
              选择 / 取消本页全部
            </button>
          </section>
        </>
      )}
      {page === "wallet" && (
        <>
          <div className="p-page-heading">
            <div>
              <h1>积分钱包</h1>
              <p>下单预留、成功扣费，每一笔积分都有记录。</p>
            </div>
            {pub.brand.support_url && (
              <a
                className="p-button secondary"
                href={pub.brand.support_url}
                target="_blank"
                rel="noopener noreferrer"
              >
                联系充值客服 ↗
              </a>
            )}
          </div>
          <div className="p-stats">
            <div>
              <small>可用积分</small>
              <strong>{user.points}</strong>
            </div>
            <div>
              <small>预留积分</small>
              <strong>{user.frozen}</strong>
            </div>
          </div>
          <form
            className="p-card"
            onSubmit={(e) => {
              e.preventDefault();
              a.run(
                () => call("/api/user/v1/redeem", "POST", { code: redeem }),
                "积分已到账",
              ).then((r) => r && setRedeem(""));
            }}
          >
            <h2>兑换积分</h2>
            <div className="p-inline">
              <input
                required
                value={redeem}
                onChange={(e) => setRedeem(e.target.value)}
                placeholder="输入积分兑换码"
                autoComplete="off"
              />
              <button className="p-button" disabled={a.busy}>
                立即兑换
              </button>
            </div>
            <p className="p-muted p-fine">
              需要充值请联系站点管理员获取兑换码。
            </p>
          </form>
          <section className="p-card">
            <h2>积分流水</h2>
            <Filters
              value={filters}
              onChange={(v) => {
                setFilters(v);
                setOffset(0);
              }}
              kind
              placeholder="搜索流水说明"
            />
            <Table
              rows={rows}
              columns={[
                {
                  title: "类型",
                  render: (r) => ledgerNames[r.kind] || r.kind,
                },
                {
                  title: "可用变动",
                  render: (r) =>
                    `${r.points_delta > 0 ? "+" : ""}${r.points_delta}`,
                },
                {
                  title: "预留变动",
                  render: (r) =>
                    `${r.frozen_delta > 0 ? "+" : ""}${r.frozen_delta}`,
                },
                { title: "说明", render: (r) => r.note },
                { title: "时间", render: (r) => date(r.created_at) },
              ]}
            />
          </section>
        </>
      )}
      {page === "keys" && (
        <>
          <div className="p-page-heading">
            <div>
              <h1>API 管理</h1>
              <p>为自己的程序创建密钥，按需授予权限。</p>
            </div>
            <Link className="p-button secondary" to="/docs">
              查看 API 文档
            </Link>
          </div>
          <form
            className="p-card"
            onSubmit={(e) => {
              e.preventDefault();
              a.run(
                () =>
                  call("/api/user/v1/keys", "POST", { name: keyName, scopes }),
                "密钥已创建",
              ).then((r) => {
                if (r) {
                  setKeyText(r.key);
                  setKeyName("");
                }
              });
            }}
          >
            <h2>创建 API Key</h2>
            <label>
              密钥名称
              <input
                required
                maxLength={80}
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
                placeholder="例如：我的网站"
              />
            </label>
            <div className="p-checks">
              {Object.entries({
                "orders:read": "查看订单",
                "orders:write": "创建和取消订单",
                "accounts:read": "查看账号列表",
                "credentials:read": "读取及导出凭据",
              }).map(([k, v]) => (
                <label key={k}>
                  <input
                    type="checkbox"
                    checked={scopes.includes(k)}
                    onChange={(e) =>
                      setScopes(
                        e.target.checked
                          ? [...scopes, k]
                          : scopes.filter((x) => x !== k),
                      )
                    }
                  />
                  {v}
                </label>
              ))}
            </div>
            <button className="p-button" disabled={a.busy || !scopes.length}>
              <Plus size={16} />
              创建密钥
            </button>
          </form>
          <section className="p-card">
            <Table
              rows={rows}
              columns={[
                { title: "名称", render: (r) => r.name },
                { title: "密钥前缀", render: (r) => <code>{r.prefix}…</code> },
                { title: "权限", render: (r) => r.scopes.join(" · ") },
                {
                  title: "状态",
                  render: (r) => (r.revoked ? "已撤销" : "有效"),
                },
                {
                  title: "操作",
                  render: (r) =>
                    !r.revoked && (
                      <button
                        className="p-link danger"
                        disabled={a.busy}
                        onClick={() =>
                          a.run(() =>
                            call(`/api/user/v1/keys/${r.id}`, "DELETE"),
                          )
                        }
                      >
                        撤销
                      </button>
                    ),
                },
              ]}
            />
          </section>
        </>
      )}
      {page === "profile" && (
        <>
          <div className="p-page-heading">
            <div>
              <h1>个人设置</h1>
              <p>管理你的账户资料与登录密码。</p>
            </div>
          </div>
          <div className="p-profile-layout">
            <section className="p-card p-profile-summary">
              <span className="p-profile-avatar">{user.name.slice(0, 1)}</span>
              <h2>{user.name}</h2>
              <p className="p-muted">{user.email}</p>
              <span className="p-status active">
                {user.role === "admin" ? "管理员账户" : "普通用户账户"}
              </span>
              <div className="p-ledger-line">
                <span>可用积分</span>
                <b>{user.points.toLocaleString()}</b>
              </div>
              <div className="p-ledger-line">
                <span>预留积分</span>
                <b>{user.frozen.toLocaleString()}</b>
              </div>
              <div className="p-ledger-line">
                <span>注册时间</span>
                <small>{date(user.created_at)}</small>
              </div>
              <button className="p-button secondary" onClick={onLogout}>
                退出当前账户
              </button>
            </section>
            <form
              className="p-card"
              onSubmit={(e) => {
                e.preventDefault();
                a.run(
                  () =>
                    call("/api/user/v1/me", "PATCH", {
                      name,
                      password: pw,
                      old_password: oldPw,
                    }),
                  "资料已保存",
                ).then((r) => {
                  if (r?.relogin) onLogout();
                });
              }}
            >
              <h2>账户资料</h2>
              <p className="p-muted">管理显示名称及登录信息。</p>
              <label>
                登录账号
                <input value={user.email} disabled />
              </label>
              <label>
                用户名
                <input
                  required
                  maxLength={80}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <div className="p-profile-security">
                <h2>密码与安全</h2>
                <p className="p-muted">
                  修改密码需要验证原密码。保存后原登录会话和 API 密钥会失效。
                </p>
              </div>
              <label>
                原密码
                <input
                  type="password"
                  autoComplete="current-password"
                  value={oldPw}
                  onChange={(e) => setOldPw(e.target.value)}
                />
              </label>
              <label>
                新密码
                <input
                  type="password"
                  minLength={10}
                  maxLength={72}
                  autoComplete="new-password"
                  value={pw}
                  onChange={(e) => setPw(e.target.value)}
                  placeholder="留空表示保持原密码"
                />
              </label>
              <button className="p-button" disabled={a.busy}>
                保存设置
              </button>
            </form>
          </div>
        </>
      )}
      {["orders", "accounts", "wallet"].includes(page) && (
        <Pagination
          offset={offset}
          total={data?.total}
          count={rows.length}
          onChange={(n) => {
            setOffset(n);
            setSelected([]);
          }}
        />
      )}
      {detail && <OrderDetail id={detail} onClose={() => setDetail("")} />}
      {secret && (
        <Modal title="账号凭据" onClose={() => setSecret(null)}>
          {[
            ["邮箱", secret.email],
            ["密码", secret.password],
            ["2FA 密钥", secret.totp_secret],
            ["当前验证码", secret.totp_code],
          ].map(([label, value]) => (
            <label key={label}>
              {label}
              <div className="p-inline">
                <input readOnly value={value} />
                <button
                  className="p-button secondary"
                  onClick={() => a.run(() => copy(value), "已复制")}
                >
                  <Copy size={15} />
                </button>
              </div>
            </label>
          ))}
          <p className="p-muted">
            验证码每 30 秒变化。读取时剩余 {secret.totp_expires_in} 秒。
          </p>
          <div className="p-inline">
            <button
              className="p-button secondary"
              onClick={async () => {
                const v = await a.run(
                  () => call(`/api/user/v1/accounts/${secret.id}/credentials`),
                  "验证码已刷新",
                );
                if (v) setSecret({ ...v, id: secret.id });
              }}
            >
              刷新验证码
            </button>
            {secret.oauth && (
              <button
                className="p-button"
                onClick={() =>
                  download(
                    `${secret.email}-oauth.json`,
                    JSON.stringify(secret.oauth, null, 2),
                  )
                }
              >
                下载 OAuth JSON
              </button>
            )}
          </div>
        </Modal>
      )}
      {keyText && (
        <Modal title="API Key 创建成功" onClose={() => setKeyText("")}>
          <p>完整密钥仅显示一次，请立即保存。</p>
          <pre>{keyText}</pre>
          <button
            className="p-button"
            onClick={() => a.run(() => copy(keyText), "已复制密钥")}
          >
            复制密钥
          </button>
        </Modal>
      )}
    </>
  );
}
