import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Pagination } from "./Insights";
import AdminCosts, { CostAmount } from "./AdminCosts";
import "./accounts.css";
import { Copy, Download } from "lucide-react";
import { call, copy, date, download, type Row } from "./client";
import { Feedback, Modal, Table, useAction } from "./Workspace";
import { ExportProgress, selectFilteredAccounts } from "./AccountExport";

function ExpandedAccounts({ orderId, filters, render }: { orderId: string; filters: Row; render: (rows: Row[]) => ReactNode }) {
  const [offset, setOffset] = useState(0);
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ["admin-order-accounts", orderId, filters, offset],
    queryFn: () => call(`/api/admin/v1/accounts?${new URLSearchParams({ ...filters, order_id: orderId, limit: "50", offset: String(offset) })}`),
  });
  return <div className="p-order-accounts" aria-busy={isFetching}>
    {error ? <div className="p-alert">{error.message} <button onClick={()=>refetch()}>重试</button></div> : !data ? <ExportProgress text="正在加载订单账号…" /> : <>{render(data.items)}<Pagination offset={offset} total={data.total} count={data.items.length} onChange={setOffset}/></>}
  </div>;
}

export default function AdminAccounts({
  rows,
  onOrder,
  filters = {},
}: {
  rows: Row[];
  onOrder: (id: string) => void;
  filters?: Row;
}) {
  const [expanded, setExpanded] = useState<string[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [secret, setSecret] = useState<Row | null>(null);
  const a = useAction();
  const ids = selected;
  const [exporting, setExporting] = useState("");
  async function exported(format: string, chosen = ids) {
    if (exporting) return;
    setExporting(
      `正在准备 ${chosen.length} 个账号的 ${format.toUpperCase()} 文件`,
    );
    try {
      const value = await a.run(
        () =>
          call("/api/admin/v1/accounts/export", "POST", {
            ids: chosen,
            format,
          }),
        "导出已准备",
      );
      if (value) download(value.filename, value.content, value.encoding);
    } finally {
      setExporting("");
    }
  }
  async function reveal(id: string, refresh = false) {
    const value = await a.run(
      () => call(`/api/admin/v1/accounts/${id}/credentials`),
      "",
    );
    if (value)
      setSecret((old) => (refresh && old?.delivery.id !== id ? old : value));
  }
  async function selectOrder(orderId: string) {
    if (a.busy || exporting) return;
    try {
      const result = await a.run(() => selectFilteredAccounts("/api/admin/v1/accounts", { ...filters, order_id: orderId }, setExporting), "已更新选择，每次最多 1000 个");
      if (result) setSelected(old => result.ids.some((id: string) => old.includes(id)) ? old.filter(id=>!result.ids.includes(id)) : [...new Set([...old,...result.ids])].slice(0,1000));
    } finally { setExporting(""); }
  }
  const renderAccounts = (accounts: Row[]) => (<Table
          rows={accounts}
          columns={[
            {
              title: "选择",
              render: (r) => (
                <input
                  type="checkbox"
                  aria-label={`选择 ${r.email}`}
                  checked={ids.includes(r.id)}
                  disabled={a.busy || Boolean(exporting) || (!ids.includes(r.id) && ids.length >= 1000)}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked
                        ? [...ids, r.id]
                        : ids.filter((id) => id !== r.id),
                    )
                  }
                />
              ),
            },
            { title: "交付账号", render: (r) => <b>{r.email}</b> },
            { title: "所属客户", render: (r) => r.owner_email },
            {
              title: "注册服务",
              render: (r) => (r.need_oauth ? "OAuth 授权账号" : "标准账号"),
            },
            {
              title: "关联订单",
              render: (r) => (
                <button className="p-link" onClick={() => onOrder(r.order_id)}>
                  {r.order_id.slice(0, 12)} ↗
                </button>
              ),
            },
            { title: "邮箱消耗", render: r => <CostAmount cost={r.execution_cost} kind="mail" /> },
            { title: "短信消耗", render: r => <CostAmount cost={r.execution_cost} kind="sms" /> },
            { title: "交付时间", render: (r) => date(r.created_at) },
            {
              title: "操作",
              render: (r) => (
                <div className="p-record-actions">
                  <button
                    className="p-link"
                    disabled={a.busy}
                    onClick={() => reveal(r.id)}
                  >
                    查看全部资料
                  </button>
                  <button
                    className="p-link"
                    disabled={a.busy}
                    onClick={() => exported("json", [r.id])}
                  >
                    下载 JSON
                  </button>
                </div>
              ),
            },
          ]}
        />);
  function credential(label: string, value: unknown, multiline = false) {
    const text =
      value == null
        ? ""
        : typeof value === "object"
          ? JSON.stringify(value, null, 2)
          : String(value);
    return (
      <label className="p-credential-field" key={label}>
        {label}
        <div className="p-inline">
          {multiline ? (
            <textarea readOnly value={text} rows={3} placeholder="未保存该凭据" />
          ) : (
            <input readOnly value={text} />
          )}
          <button
            className="p-button secondary"
            aria-label={`复制${label}`}
            onClick={() => a.run(() => copy(text), "已复制")}
          >
            <Copy size={15} />
          </button>
        </div>
      </label>
    );
  }
  return (
    <>
      {!secret && <Feedback a={a} />}
      {!secret && <ExportProgress text={exporting} />}
      <section className="p-card p-record-card">
        <div className="p-records-heading">
          <div>
            <h2>按订单查看交付账号</h2>
            <p>点击订单展开账号，支持整单选择、跨订单批量导出。运营后台保留完整交付记录。</p>
          </div>
          <span className="p-count-pill">已选 {ids.length} 个</span>
        </div>
        <div className="p-export-toolbar">
          <button className="p-button secondary" disabled={!ids.length || a.busy || Boolean(exporting)} onClick={() => setSelected([])}>清空选择</button>
          <button
            className="p-button secondary"
            disabled={a.busy || Boolean(exporting)}
            onClick={async () => {
              try {
                const result = await a.run(
                  () =>
                    selectFilteredAccounts(
                      "/api/admin/v1/accounts",
                      filters,
                      setExporting,
                    ),
                  "已选择当前筛选结果，最多 1000 个",
                );
                if (result) setSelected(result.ids);
              } finally {
                setExporting("");
              }
            }}
          >
            选择筛选结果（最多 1000）
          </button>
          <button
            className="p-button"
            disabled={!ids.length || a.busy}
            onClick={() => exported("json")}
          >
            <Download size={15} />
            导出完整 JSON
          </button>
          <button
            className="p-button secondary"
            disabled={!ids.length || a.busy}
            onClick={() => exported("csv")}
          >
            导出 CSV
          </button>
          <button
            className="p-button secondary"
            disabled={!ids.length || a.busy}
            onClick={() => exported("txt")}
          >
            邮箱-密码-2fa
          </button>
          <button
            className="p-button secondary"
            disabled={!ids.length || a.busy || Boolean(exporting)}
            onClick={() => exported("cpa")}
          >
            CPA
          </button>
          <button
            className="p-button secondary"
            disabled={!ids.length || a.busy || Boolean(exporting)}
            onClick={() => exported("sub")}
          >
            SUB
          </button>
          {[["email_at", "邮箱+AT"], ["email_session", "邮箱+Session"]].map(([format, label]) => <button
            key={format} className="p-button secondary" disabled={!ids.length || a.busy || Boolean(exporting)}
            onClick={() => exported(format)}>{label}</button>)}
        </div>
        <p className="p-records-note">
          JSON 包含完整交付资料与 OAuth；CSV 包含凭据、OAuth 和客户订单信息；TXT
          为邮箱----密码----2FA。每次最多 1000 个。订单费用包含失败与重试；账号明细显示该账号全部执行尝试的成本。
          邮箱+AT / 邮箱+Session 导出完整网页登录凭据，标准账号也可使用；未保存时整批提示，不跳过账号。
        </p>
        <div className="p-admin-delivery-groups">
          {rows.map(r => <article className="p-admin-delivery-order" key={r.id}>
            <div className="p-admin-delivery-heading">
              <button className="p-order-expand" aria-expanded={expanded.includes(r.id)} onClick={() => setExpanded(v => v.includes(r.id) ? v.filter(id=>id!==r.id) : [...v,r.id])}>
                <span>{expanded.includes(r.id) ? "▾" : "▸"}</span><div><b>订单 {r.id.slice(0,12)}</b><small className="p-block">{r.owner_email} · {r.need_oauth ? "含 OAuth" : "标准账号"} · {r.available_count} 个账号</small><small className="p-block">最近交付 {date(r.last_delivered_at)}</small></div>
              </button>
              <div className="p-delivery-order-cost"><small>订单邮箱消耗</small><CostAmount cost={r.execution_cost} kind="mail" /></div>
              <div className="p-delivery-order-cost"><small>订单短信消耗</small><CostAmount cost={r.execution_cost} kind="sms" /></div>
              <div className="p-record-actions"><button className="p-button secondary" disabled={a.busy || Boolean(exporting)} onClick={() => selectOrder(r.id)}>选择 / 取消本单</button><button className="p-button secondary" onClick={() => onOrder(r.id)}>订单详情</button></div>
            </div>
            {expanded.includes(r.id) && <ExpandedAccounts orderId={r.id} filters={filters} render={renderAccounts} />}
          </article>)}
          {!rows.length && <div className="p-empty">暂无交付订单</div>}
        </div>
      </section>
      {secret && (
        <Modal title="交付账号完整资料" onClose={() => setSecret(null)}>
          <Feedback a={a} />
          <ExportProgress text={exporting} />
          <div className="p-delivery-meta">
            <div>
              <small>所属客户</small>
              <b>{secret.delivery.owner_name}</b>
              <span>{secret.delivery.owner_email}</span>
            </div>
            <div>
              <small>服务模式</small>
              <b>
                {secret.delivery.need_oauth ? "OAuth 授权账号" : "标准账号"}
              </b>
              <span>
                {secret.delivery.engine_sold_at ? "已卖出" : "售出标记同步中"}
              </span>
            </div>
            <div>
              <small>交付时间</small>
              <span>{date(secret.delivery.created_at)}</span>
            </div>
            <div>
              <small>关联订单</small>
              <code>{secret.delivery.order_id}</code>
            </div>
          </div>
          <AdminCosts cost={secret.delivery.execution_cost} title="此账号执行成本" />
          {credential("邮箱", secret.email)}
          {credential("密码", secret.password)}
          {credential("2FA 密钥", secret.totp_secret)}
          {credential("当前验证码", secret.totp_code)}
          {credential("网页登录 AT", secret.access_token, true)}
          {credential("完整 Session Token", secret.session_token, true)}
          <p className="p-muted">
            验证码每 30 秒变化；读取时剩余 {secret.totp_expires_in} 秒。
            网页登录 AT 与下方 OAuth AT 独立；Session 为完整登录 Cookie Token，导出不刷新有效期。
          </p>
          <button
            className="p-button secondary"
            disabled={a.busy}
            onClick={() => reveal(secret.delivery.id, true)}
          >
            刷新验证码
          </button>
          <h3 className="p-secret-heading">OAuth 授权资料</h3>
          {secret.oauth ? (
            Object.entries(secret.oauth).map(([key, value]) =>
              credential(key, value, true),
            )
          ) : (
            <p className="p-muted">此账号的交付资料不包含 OAuth。</p>
          )}
          <details className="p-full-record">
            <summary>完整原始交付资料 / JSON</summary>
            <pre>{JSON.stringify(secret, null, 2)}</pre>
          </details>
          <div className="p-export-toolbar">
            <button
              className="p-button"
              disabled={a.busy}
              onClick={() => exported("json", [secret.delivery.id])}
            >
              下载完整资料
            </button>
            {secret.oauth && (
              <button
                className="p-button secondary"
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
    </>
  );
}
