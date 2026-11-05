import { useState } from "react";
import { Copy, Download } from "lucide-react";
import { call, copy, date, download, type Row } from "./client";
import { Feedback, Modal, Table, useAction } from "./Workspace";

export default function AdminAccounts({
  rows,
  onOrder,
}: {
  rows: Row[];
  onOrder: (id: string) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [secret, setSecret] = useState<Row | null>(null);
  const a = useAction();
  const ids = selected.filter((id) => rows.some((r) => r.id === id));
  async function exported(format: string, chosen = ids) {
    const value = await a.run(
      () =>
        call("/api/admin/v1/accounts/export", "POST", { ids: chosen, format }),
      "导出已准备",
    );
    if (value) download(value.filename, value.content);
  }
  async function reveal(id: string, refresh = false) {
    const value = await a.run(
      () => call(`/api/admin/v1/accounts/${id}/credentials`),
      "",
    );
    if (value)
      setSecret((old) => (refresh && old?.delivery.id !== id ? old : value));
  }
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
            <textarea readOnly value={text} rows={3} />
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
      <section className="p-card p-record-card">
        <div className="p-records-heading">
          <div>
            <h2>全部交付账号</h2>
            <p>查看完整凭据与交付归属，支持单个下载和批量导出。</p>
          </div>
          <span className="p-count-pill">已选 {ids.length} 个</span>
        </div>
        <div className="p-export-toolbar">
          <button
            className="p-button secondary"
            disabled={!rows.length}
            onClick={() =>
              setSelected(
                ids.length === rows.length ? [] : rows.map((r) => r.id),
              )
            }
          >
            选择 / 取消本页全部
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
            导出 TXT
          </button>
        </div>
        <p className="p-records-note">
          JSON 包含完整交付资料与 OAuth；CSV 包含凭据、OAuth 和客户订单信息；TXT
          为邮箱----密码----2FA。每次最多 100 个。
        </p>
        <Table
          rows={rows}
          columns={[
            {
              title: "选择",
              render: (r) => (
                <input
                  type="checkbox"
                  aria-label={`选择 ${r.email}`}
                  checked={ids.includes(r.id)}
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
        />
      </section>
      {secret && (
        <Modal title="交付账号完整资料" onClose={() => setSecret(null)}>
          <Feedback a={a} />
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
          {credential("邮箱", secret.email)}
          {credential("密码", secret.password)}
          {credential("2FA 密钥", secret.totp_secret)}
          {credential("当前验证码", secret.totp_code)}
          <p className="p-muted">
            验证码每 30 秒变化；读取时剩余 {secret.totp_expires_in} 秒。
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
