import { useState } from "react";
import { Copy, Download, Plus, Ticket } from "lucide-react";
import { call, copy, date, download, type Row } from "./client";
import { Feedback, Modal, Table, useAction } from "./Workspace";
import { number } from "./Insights";

export default function AdminCodes({
  rows,
  stats,
}: {
  rows: Row[];
  stats?: Row;
}) {
  const a = useAction();
  const [selected, setSelected] = useState<string[]>([]);
  const [issuing, setIssuing] = useState(false);
  const [generated, setGenerated] = useState<Row | null>(null);
  const [confirm, setConfirm] = useState("");
  const [points, setPoints] = useState(100),
    [count, setCount] = useState(1),
    [days, setDays] = useState(365),
    [batch, setBatch] = useState("");
  const ids = selected.filter((id) => rows.some((row) => row.id === id));
  async function retrieve(action: "copy" | "export", chosen = ids) {
    await a
      .run(async () => {
        const result = await call("/api/admin/v1/redeem-codes/batch", "POST", {
          ids: chosen,
          action,
        });
        if (action === "copy") await copy(result.codes.join("\n"));
        else download("gptreg-redeem-codes.txt", result.codes.join("\r\n"));
        if (result.skipped)
          return {
            notice: `已处理 ${result.codes.length} 条，跳过 ${result.skipped} 条不可用或未保存原文的记录。`,
          };
        return {
          notice: `已${action === "copy" ? "复制" : "导出"} ${result.codes.length} 个兑换码，每行一个。`,
        };
      }, "")
      .then((result) => {
        if (result) setNotice(result.notice);
      });
  }
  const [notice, setNotice] = useState("");
  const labels: Row = {
    available: "未使用",
    used: "已使用",
    disabled: "已停用",
    expired: "已过期",
  };
  const operationLabels: Row = {
    enable: "启用",
    disable: "停用",
    delete: "删除",
  };
  return (
    <>
      <div className="p-stats p-code-stats">
        {[
          ["累计发行", stats?.issued],
          ["可用兑换码", stats?.available],
          ["已兑换数量", stats?.used],
          ["已兑换积分", stats?.redeemed_points],
        ].map(([label, value]) => (
          <div key={String(label)}>
            <small>{label}</small>
            <b>{number(Number(value || 0))}</b>
          </div>
        ))}
      </div>
      <section className="p-card p-record-card">
        <div className="p-records-heading">
          <div>
            <h2>
              <Ticket size={20} /> 兑换码管理
            </h2>
            <p>按批次发行，跟踪兑换去向。兑换成功后积分才进入客户账户。</p>
          </div>
          <button
            className="p-button"
            onClick={() => {
              setIssuing(true);
              setNotice("");
            }}
          >
            <Plus size={16} />
            发行兑换码
          </button>
        </div>
        <div className="p-code-tools">
          <span className="p-muted">已选 {ids.length} 条</span>
          <button
            className="p-button secondary"
            disabled={!ids.length || a.busy}
            onClick={() => retrieve("copy")}
          >
            <Copy size={15} />
            批量复制
          </button>
          <button
            className="p-button secondary"
            disabled={!ids.length || a.busy}
            onClick={() => retrieve("export")}
          >
            <Download size={15} />
            导出 TXT
          </button>
          {Object.entries(operationLabels).map(([action, label]) => (
            <button
              key={action}
              className={`p-button secondary ${action === "delete" ? "danger" : ""}`}
              disabled={!ids.length || a.busy}
              onClick={() => setConfirm(action)}
            >
              批量{label}
            </button>
          ))}
        </div>
        {!issuing && !generated && !confirm && (
          <div className="p-code-feedback">
            <Feedback a={a} />
            {notice && (
              <p role="status" className="p-notice">
                {notice}
              </p>
            )}
          </div>
        )}
        <Table
          rows={rows}
          columns={[
            {
              title: (
                <input
                  type="checkbox"
                  aria-label="选择本页兑换码"
                  checked={rows.length > 0 && ids.length === rows.length}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked ? rows.map((row) => row.id) : [],
                    )
                  }
                />
              ),
              render: (row) => (
                <input
                  type="checkbox"
                  aria-label={`选择兑换码 ${row.prefix}`}
                  checked={ids.includes(row.id)}
                  onChange={(e) =>
                    setSelected(
                      e.target.checked
                        ? [...ids, row.id]
                        : ids.filter((id) => id !== row.id),
                    )
                  }
                />
              ),
            },
            {
              title: "兑换码标识",
              render: (row) => (
                <>
                  <code>{row.prefix}…</code>
                  {!row.copyable && (
                    <small className="p-block p-muted">
                      历史码 · 未保存原文
                    </small>
                  )}
                </>
              ),
            },
            {
              title: "面值",
              render: (row) => <b>{number(row.points)} 积分</b>,
            },
            {
              title: "发行批次",
              render: (row) => (
                <>
                  <span>{row.batch || "历史批次"}</span>
                  <small className="p-block p-muted">
                    {date(row.created_at)}
                  </small>
                </>
              ),
            },
            {
              title: "状态",
              render: (row) => (
                <span
                  className={`p-status ${row.status === "available" ? "active" : row.status === "used" ? "completed" : "cancelled"}`}
                >
                  {labels[row.status]}
                </span>
              ),
            },
            {
              title: "兑换账户",
              render: (row) => (
                <>
                  {row.redeemed_email || "—"}
                  {row.redeemed_at && (
                    <small className="p-block p-muted">
                      {date(row.redeemed_at)}
                    </small>
                  )}
                </>
              ),
            },
            {
              title: "到期时间",
              render: (row) =>
                row.expires_at ? date(row.expires_at) : "长期有效",
            },
            {
              title: "操作",
              render: (row) => (
                <button
                  className="p-link"
                  disabled={a.busy || !row.copyable}
                  onClick={() => retrieve("copy", [row.id])}
                >
                  <Copy size={14} />
                  复制
                </button>
              ),
            },
          ]}
        />
        <p className="p-code-footnote">
          TXT
          导出仅包含有效、未使用的兑换码；已兑换记录保留，批量停用与删除会自动跳过。
        </p>
      </section>
      {issuing && (
        <Modal
          title="发行兑换码"
          onClose={() => {
            if (!a.busy) setIssuing(false);
          }}
        >
          <Feedback a={a} />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              a.run(
                () =>
                  call("/api/admin/v1/redeem-codes", "POST", {
                    points,
                    count,
                    days,
                    batch,
                  }),
                "兑换码已生成",
              ).then((result) => {
                if (result) {
                  setGenerated(result);
                  setIssuing(false);
                  setNotice("");
                }
              });
            }}
          >
            <div className="p-form-grid">
              <label>
                发行数量
                <input
                  type="number"
                  min={1}
                  max={100}
                  required
                  value={count}
                  onChange={(e) => setCount(Number(e.target.value))}
                />
              </label>
              <label>
                每个面值（积分）
                <input
                  type="number"
                  min={1}
                  max={1000000}
                  required
                  value={points}
                  onChange={(e) => setPoints(Number(e.target.value))}
                />
              </label>
              <label>
                有效天数
                <input
                  type="number"
                  min={1}
                  max={3660}
                  required
                  value={days}
                  onChange={(e) => setDays(Number(e.target.value))}
                />
              </label>
              <label>
                发行批次
                <input
                  maxLength={80}
                  placeholder="留空自动生成批次编号"
                  value={batch}
                  onChange={(e) => setBatch(e.target.value)}
                />
              </label>
            </div>
            <p className="p-notice">
              本次发行 {count} 个，共 {number(count * points)}{" "}
              积分。生成后可直接点击复制，也可下载 TXT 保存。
            </p>
            <button className="p-button" disabled={a.busy}>
              生成兑换码
            </button>
          </form>
        </Modal>
      )}
      {generated && (
        <Modal title="兑换码已生成" onClose={() => setGenerated(null)}>
          <Feedback a={a} />
          <p className="p-muted">
            批次 {generated.batch} · 共 {generated.codes.length}{" "}
            个，点击兑换码即可复制。
          </p>
          <div className="p-inline">
            <button
              className="p-button"
              onClick={() =>
                a.run(
                  () => copy(generated.codes.join("\n")),
                  "已复制全部兑换码",
                )
              }
            >
              <Copy size={15} />
              复制全部
            </button>
            <button
              className="p-button secondary"
              onClick={() =>
                download(
                  "gptreg-redeem-codes.txt",
                  generated.codes.join("\r\n"),
                )
              }
            >
              <Download size={15} />
              下载 TXT
            </button>
          </div>
          <div className="p-generated-codes">
            {generated.codes.map((code: string, index: number) => (
              <button
                key={code}
                className="p-code-copy"
                title="点击复制兑换码"
                aria-label={`复制第 ${index + 1} 个兑换码`}
                onClick={() => a.run(() => copy(code), "兑换码已复制")}
              >
                <span>{index + 1}</span>
                <code>{code}</code>
                <Copy size={15} />
              </button>
            ))}
          </div>
        </Modal>
      )}
      {confirm && (
        <Modal
          title={`批量${operationLabels[confirm]}兑换码`}
          onClose={() => {
            if (!a.busy) setConfirm("");
          }}
        >
          <Feedback a={a} />
          <p>
            将{operationLabels[confirm]}所选 {ids.length}{" "}
            条记录中的未使用兑换码，已使用记录会保留。
            {confirm === "delete" ? "删除后无法恢复。" : ""}
          </p>
          <button
            className="p-button"
            disabled={a.busy}
            onClick={() =>
              a
                .run(() =>
                  call("/api/admin/v1/redeem-codes/batch", "POST", {
                    ids,
                    action: confirm,
                  }),
                )
                .then((result) => {
                  if (result) {
                    setNotice(
                      `已${operationLabels[confirm]} ${result.changed} 条，跳过 ${result.skipped} 条已使用或不存在的记录。`,
                    );
                    setSelected([]);
                    setConfirm("");
                  }
                })
            }
          >
            确认{operationLabels[confirm]}
          </button>
        </Modal>
      )}
    </>
  );
}
