import { useState, useEffect, lazy, Suspense, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Check, Plus } from "lucide-react";
import {
  call,
  copy,
  date,
  statusNames,
  orderPending,
  type Row,
} from "./client";
import { Link } from "../router";
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
  columns: { title: ReactNode; render: (r: Row) => ReactNode }[];
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
            <span>
              执行中{" "}
              {
                data.items.filter((item: any) => item.status === "running")
                  .length
              }
            </span>
            <span>
              排队中{" "}
              {
                data.items.filter((item: any) =>
                  ["queued", "oauth_pending"].includes(item.status),
                ).length
              }
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
}: {
  page: string;
  user: Row;
  pub: Row;
}) {
  const a = useAction(),
    [detail, setDetail] = useState(""),
    [keyText, setKeyText] = useState(""),
    [keyName, setKeyName] = useState(""),
    [scopes, setScopes] = useState([
      "orders:read",
      "orders:write",
      "accounts:read",
      "credentials:read",
    ]);
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
    queryKey: ["workspace-list", page],
    queryFn: () => call("/api/user/v1/keys"),
    enabled: page !== "register",
  });
  const rows: Row[] = data?.items || [],
    price = oauth ? pub.price_oauth : pub.price_standard;
  return (
    <>
      <Feedback a={a} />
      {page !== "register" && (
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
              <Link to="/orders">查看订单中心</Link>
            </div>
          )}
          <div className="p-page-heading">
            <div>
              <span className="p-eyebrow">ACCOUNT REGISTRATION</span>
              <h1>开始一笔新注册</h1>
              <p>选择服务、填写数量，实时跟踪注册与交付。</p>
            </div>
            <Link to="/orders" className="p-button secondary">
              订单中心 ↗
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
      {detail && <OrderDetail id={detail} onClose={() => setDetail("")} />}
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
