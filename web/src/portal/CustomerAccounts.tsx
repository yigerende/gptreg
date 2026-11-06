import { Fragment, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronRight,
  Clock3,
  Copy,
  Download,
  RefreshCw,
} from "lucide-react";
import { Link } from "../router";
import { ApiError, call, copy, download, type Row } from "./client";
import { Modal } from "./Workspace";
import { Filters, Pagination } from "./Insights";
import { ExportProgress } from "./AccountExport";
import AccountDevice from "./AccountDevice";
import TokenCredentials from "./TokenCredentials";
import {
  isAvailable,
  mergeSelection,
  MAX_ACCOUNT_SELECTION,
  type AccountChoice,
} from "./accountSelection";
import "./accounts.css";

const prefix = "/api/user/v1";
const beijing = (value: string) =>
  new Date(value).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
function Expiry({ value, now }: { value: string; now: number }) {
  const minutes = Math.max(0, Math.ceil((Date.parse(value) - now) / 60000));
  const remaining =
    minutes >= 1440
      ? `${Math.floor(minutes / 1440)} 天 ${Math.floor((minutes % 1440) / 60)} 小时`
      : minutes >= 60
        ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分钟`
        : `${minutes} 分钟`;
  return (
    <div className={`p-account-expiry ${minutes <= 1440 ? "soon" : ""}`}>
      <time dateTime={value}>{beijing(value)}</time>
      <small>
        {minutes
          ? `剩余 ${remaining}${minutes <= 1440 ? " · 请尽快导出" : ""}`
          : "已到期，资料已移除"}
      </small>
    </div>
  );
}
function Checkbox({
  label,
  checked,
  partial = false,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  partial?: boolean;
  disabled?: boolean;
  onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = partial && !checked;
  }, [partial, checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={onChange}
    />
  );
}
type AccountTableProps = {
  rows: Row[];
  selected: AccountChoice[];
  now: number;
  busy: boolean;
  toggle: (rows: Row[]) => void;
  reveal: (row: Row) => void;
  device: (row: Row) => void;
};
function AccountTable({
  rows,
  selected,
  now,
  busy,
  toggle,
  reveal,
  device,
}: AccountTableProps) {
  const ids = new Set(selected.map((r) => r.id));
  const visible = rows.filter((r) => isAvailable(r as AccountChoice, now));
  const checked = visible.length > 0 && visible.every((r) => ids.has(r.id));
  return (
    <div className="p-account-table-wrap">
      <table className="p-account-table">
        <thead>
          <tr>
            <th>
              <Checkbox
                label="选择本页全部账号"
                checked={checked}
                partial={visible.some((r) => ids.has(r.id))}
                disabled={busy || !visible.length}
                onChange={() => toggle(visible)}
              />
            </th>
            <th>账号邮箱</th>
            <th>模式</th>
            <th>交付时间（北京时间）</th>
            <th>删除时间（北京时间）</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((r) => (
            <tr key={r.id}>
              <td data-label="选择">
                <Checkbox
                  label={`选择 ${r.email}`}
                  checked={ids.has(r.id)}
                  disabled={
                    busy ||
                    (!ids.has(r.id) && selected.length >= MAX_ACCOUNT_SELECTION)
                  }
                  onChange={() => toggle([r])}
                />
              </td>
              <td data-label="账号邮箱">
                <b>{r.email}</b>
                <small className="p-account-order-ref">订单 {r.order_id}</small>
              </td>
              <td data-label="模式">
                <span className="p-account-mode">
                  {r.need_oauth ? "含 OAuth" : "标准账号"}
                </span>
              </td>
              <td data-label="交付时间">
                <time>{beijing(r.created_at)}</time>
              </td>
              <td data-label="删除时间">
                <Expiry value={r.download_expires_at} now={now} />
              </td>
              <td data-label="操作">
                <div className="p-account-actions">
                <button
                  className="p-button secondary"
                  disabled={busy}
                  onClick={() => reveal(r)}
                >
                  查看凭据
                </button>
                <button className="p-button secondary" disabled={busy} onClick={() => device(r)}>查看设备指纹</button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!visible.length && <div className="p-empty">暂无可领取账号</div>}
    </div>
  );
}
function OrderAccounts({
  orderId,
  filters,
  userId,
  ...props
}: Omit<AccountTableProps, "rows"> & {
  orderId: string;
  filters: Row;
  userId: string;
}) {
  const [offset, setOffset] = useState(0);
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: [
      "customer-accounts",
      userId,
      "expanded",
      orderId,
      filters,
      offset,
    ],
    queryFn: () =>
      call(
        `${prefix}/accounts?${new URLSearchParams({ ...filters, order_id: orderId, offset: String(offset), limit: "50" })}`,
      ),
  });
  useEffect(() => {
    if (data && offset && offset >= data.total) setOffset(0);
  }, [data, offset]);
  return (
    <div className="p-order-accounts" aria-busy={isFetching}>
      {error ? (
        <div className="p-alert">
          {error.message}{" "}
          <button className="p-link" onClick={() => refetch()}>
            重试
          </button>
        </div>
      ) : !data ? (
        <ExportProgress text="正在加载该订单的账号…" />
      ) : (
        <>
          <AccountTable rows={data.items} {...props} />
          <Pagination
            offset={offset}
            total={data.total}
            count={data.items.length}
            onChange={setOffset}
          />
        </>
      )}
    </div>
  );
}

export default function CustomerAccounts({ userId }: { userId: string }) {
  const q = useQueryClient();
  const [view, setView] = useState<"orders" | "accounts">("orders");
  const [filters, setFilters] = useState<Row>(() => {
    const order = new URLSearchParams(location.search).get("order_id");
    return order ? { order_id: order } : {};
  });
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [selected, setSelected] = useState<AccountChoice[]>([]);
  const [secret, setSecret] = useState<Row | null>(null);
  const [device, setDevice] = useState<Row | null>(null);
  const secretRequest = useRef(0);
  const [busy, setBusy] = useState("");
  const lock = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const clockOffset = useRef(0);
  const [now, setNow] = useState(Date.now());
  const lastExpiry = useRef(0);
  const {
    data,
    error: loadError,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: ["customer-accounts", userId, view, filters, offset],
    queryFn: async () => {
      const value = await call(
        `${prefix}/${view === "orders" ? "account-orders" : "accounts"}?${new URLSearchParams({ ...filters, offset: String(offset), limit: view === "orders" ? "20" : "50" })}`,
      );
      if (value.server_time)
        clockOffset.current = Date.parse(value.server_time) - Date.now();
      return value;
    },
  });
  const currentTime = () => Date.now() + clockOffset.current;
  const refresh = () =>
    q.invalidateQueries({ queryKey: ["customer-accounts", userId] });
  // Update only the countdown locally. Network refresh happens at an actual expiry or user action.
  useEffect(() => {
    const tick = () => setNow(Date.now() + clockOffset.current);
    tick();
    const timer = window.setInterval(tick, 30000);
    window.addEventListener("focus", tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", tick);
    };
  }, []);
  useEffect(() => {
    if (data && offset && offset >= data.total) setOffset(0);
    setNow(currentTime());
  }, [data, offset]);
  const deadlines = [
    data?.next_expires_at,
    secret?.download_expires_at,
    device?.download_expires_at,
    ...selected.map((r) => r.download_expires_at),
  ]
    .filter(Boolean)
    .map((s) => Date.parse(s))
    .filter((n) => Number.isFinite(n));
  const nextExpiry = deadlines.length ? Math.min(...deadlines) : 0;
  useEffect(() => {
    if (!nextExpiry || lastExpiry.current >= nextExpiry) return;
    const timer = window.setTimeout(
      () => {
        lastExpiry.current = nextExpiry;
        setNow(Date.now() + clockOffset.current);
        void q.invalidateQueries({ queryKey: ["customer-accounts", userId] });
      },
      Math.max(0, nextExpiry - (Date.now() + clockOffset.current)) + 30,
    );
    return () => window.clearTimeout(timer);
  }, [nextExpiry, q, userId]);
  useEffect(() => {
    setSelected((current) => {
      const valid = current.filter((r) => isAvailable(r, now));
      return valid.length === current.length ? current : valid;
    });
    setSecret((current) =>
      current && !isAvailable(current as AccountChoice, now) ? null : current,
    );
    setDevice(current => current && !isAvailable(current as AccountChoice, now) ? null : current);
  }, [now]);
  async function run(text: string, action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(text);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
      if (e instanceof ApiError && e.status === 404) {
        setSelected([]);
        setSecret(null);
        void refresh();
      }
    } finally {
      lock.current = false;
      setBusy("");
    }
  }
  function toggle(rows: Row[]) {
    if (lock.current) return;
    const valid = rows.filter((r) =>
      isAvailable(r as AccountChoice, currentTime()),
    ) as AccountChoice[];
    const ids = new Set(valid.map((r) => r.id));
    if (valid.every((r) => selected.some((s) => s.id === r.id)))
      setSelected(selected.filter((r) => !ids.has(r.id)));
    else {
      const result = mergeSelection(selected, valid, currentTime());
      setSelected(result.items);
      setNotice(
        result.limited ? "已达到 1000 条上限，请先导出或取消部分选择。" : "",
      );
    }
  }
  function selectAll(order?: Row) {
    const orderSelected = order
      ? selected.filter((r) => r.order_id === order.order_id).length
      : 0;
    if (order && orderSelected >= order.available_count) {
      setSelected(selected.filter((r) => r.order_id !== order.order_id));
      return;
    }
    void run(
      order ? "正在选择该订单的账号…" : "正在选择账号（最多 1000 条）…",
      async () => {
        const result = await call(
          `${prefix}/accounts/selection?${new URLSearchParams({ ...filters, ...(order ? { order_id: order.order_id } : {}) })}`,
        );
        const next = mergeSelection(
          order ? selected : [],
          result.items,
          currentTime(),
        );
        setSelected(next.items);
        setNotice(
          next.limited || result.total > 1000
            ? "最多选择 1000 条，已保留可容纳的账号；其余账号未选中。"
            : `已选择 ${next.items.length} 个账号，可跨订单批量导出。`,
        );
      },
    );
  }
  function reveal(row: Row) {
    void run("正在读取账号凭据…", async () => {
      const request = ++secretRequest.current;
      const value = await call(`${prefix}/accounts/${row.id}/credentials`);
      if (request !== secretRequest.current) return;
      if (isAvailable(value, currentTime()))
        setSecret({ ...value, id: row.id });
      else {
        setSecret(null);
        setNotice("该账号领取资料已到期。请刷新列表查看其他账号。");
        void refresh();
      }
    });
  }
  function exported(format: string) {
    void run(
      `正在生成 ${selected.length} 个账号的 ${format.toUpperCase()} 文件，请稍候…`,
      async () => {
        const valid = selected.filter((r) => isAvailable(r, currentTime()));
        if (valid.length !== selected.length) {
          setSelected(valid);
          throw new Error(
            "部分已选账号刚刚到期，已移除，请确认剩余账号后重新导出。",
          );
        }
        if (!valid.length) throw new Error("请先选择账号");
        const result = await call(`${prefix}/accounts/export`, "POST", {
          ids: valid.map((r) => r.id),
          format,
        });
        download(result.filename, result.content, result.encoding);
        setNotice(
          `已生成 ${valid.length} 个账号的文件，请确认下载并妥善保存。`,
        );
      },
    );
  }
  const rows: Row[] = data?.items || [];
  const validSecret =
    secret && isAvailable(secret as AccountChoice, now) ? secret : null;
  const tableProps = { selected, now, busy: Boolean(busy), toggle, reveal, device: setDevice };
  return (
    <div className="p-customer-accounts">
      <div className="p-page-heading">
        <div>
          <span className="p-eyebrow">ACCOUNT DELIVERY</span>
          <h1>我的账号</h1>
          <p>按注册订单领取账号，统一选择、批量下载。</p>
        </div>
        <div className="p-inline">
          <button
            className="p-button secondary"
            disabled={isFetching || Boolean(busy)}
            onClick={() => {
              void refresh();
            }}
          >
            <RefreshCw size={15} />
            刷新账号
          </button>
          <Link to="/orders" className="p-button secondary">
            订单中心 ↗
          </Link>
        </div>
      </div>
      <section className="p-retention-banner" aria-label="账号资料保留规则">
        <Clock3 size={25} />
        <div>
          <strong>账号资料仅保留 3 天，请及时下载</strong>
          <p>
            从每个账号交付成功起算 72 小时，到期自动从“我的账号”移除，网页和 API
            均无法再查看或导出。已下载的文件不受影响，订单记录仍可查询。
          </p>
          <span>
            删除时间以北京时间显示 · 同一订单的账号分别计时 ·
            售后记录由运营后台保留
          </span>
        </div>
        <b>
          72<small>小时领取期</small>
        </b>
      </section>
      {error && (
        <div className="p-alert" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="p-notice" role="status">
          {notice}
        </div>
      )}
      {loadError && (
        <div className="p-alert" role="alert">
          {loadError.message}{" "}
          <button className="p-link" onClick={() => refetch()}>
            重试
          </button>
        </div>
      )}
      <section className="p-card p-account-deliveries">
        <div className="p-records-heading">
          <div>
            <h2>可领取资料</h2>
            <p>
              {view === "orders"
                ? `${data?.total ?? "—"} 笔订单 · ${data?.accounts_total ?? "—"} 个账号`
                : `${data?.total ?? "—"} 个账号`}{" "}
              · 仅显示未到期资料
            </p>
          </div>
          <div className="p-segment" aria-label="账号展示方式">
            {(
              [
                ["orders", "按订单"],
                ["accounts", "按账号"],
              ] as const
            ).map(([key, name]) => (
              <button
                key={key}
                aria-pressed={view === key}
                className={view === key ? "selected" : ""}
                onClick={() => {
                  setView(key);
                  setOffset(0);
                }}
              >
                {name}
              </button>
            ))}
          </div>
        </div>
        <div className="p-center-filters">
          <fieldset
            className="p-account-filter-fields"
            disabled={Boolean(busy)}
          >
            <Filters
              value={filters}
              mode
              placeholder="搜索邮箱或订单编号"
              onChange={(v) => {
                setFilters(v);
                setOffset(0);
                setExpanded([]);
                setSelected([]);
              }}
            />
          </fieldset>
          {filters.order_id && (
            <p className="p-account-filter">
              当前订单：<code>{filters.order_id}</code>
              <button
                className="p-link"
                disabled={Boolean(busy)}
                onClick={() => {
                  setFilters({});
                  setOffset(0);
                  setSelected([]);
                }}
              >
                查看全部订单
              </button>
            </p>
          )}
        </div>
        <div className="p-account-selection">
          <div className="p-inline">
            <strong>
              已选择 <b>{selected.length}</b> / 1000
            </strong>
            <button
              className="p-button secondary"
              disabled={Boolean(busy) || !rows.length}
              onClick={() => selectAll()}
            >
              {Object.values(filters).some(Boolean)
                ? "全选筛选结果"
                : "全选全部账号"}
              （最多 1000）
            </button>
            <button
              className="p-link"
              disabled={Boolean(busy) || !selected.length}
              onClick={() => setSelected([])}
            >
              清空选择
            </button>
          </div>
          <div className="p-inline">
            {[
              ["txt", "邮箱-密码-2fa"],
              ["email_at", "邮箱+AT"],
              ["email_session", "邮箱+Session"],
              ["csv", "导出 CSV"],
              ["cpa", "CPA"],
              ["sub", "SUB"],
            ].map(([format, label]) => (
              <button
                key={format}
                className={`p-button ${["cpa", "sub"].includes(format) ? "" : "secondary"}`}
                disabled={!selected.length || Boolean(busy)}
                onClick={() => exported(format)}
              >
                <Download size={15} />
                {label}
              </button>
            ))}
          </div>
        </div>
        <p className="p-records-note">
          选择跨页保留，所有选择合计最多 1000 条；更改筛选会清空选择。CPA
          每号一个 JSON，多号打包 ZIP；SUB 多号合并一个 JSON，两者均需含 OAuth。
          邮箱+AT / 邮箱+Session 为网页登录态，标准账号也可导出；每行邮箱----完整凭据，未保存时会明确提示。
        </p>
        <ExportProgress text={busy} />
        {!data && isFetching ? (
          <div className="p-empty">正在加载交付记录…</div>
        ) : view === "accounts" ? (
          <AccountTable rows={rows} {...tableProps} />
        ) : (
          <>
            <div className="p-account-table-wrap">
              <table className="p-account-table p-account-groups">
                <thead>
                  <tr>
                    <th>选择</th>
                    <th>注册订单</th>
                    <th>模式</th>
                    <th>可领取账号</th>
                    <th>最早删除时间（北京时间）</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const count = selected.filter(
                      (r) => r.order_id === row.order_id,
                    ).length;
                    const open = expanded.includes(row.order_id);
                    return (
                      <Fragment key={row.order_id}>
                        <tr className={open ? "expanded" : ""}>
                          <td data-label="选择">
                            <Checkbox
                              label={`全选订单 ${row.order_id}`}
                              checked={count >= row.available_count}
                              partial={count > 0}
                              disabled={Boolean(busy)}
                              onChange={() => selectAll(row)}
                            />
                          </td>
                          <td data-label="注册订单">
                            <button
                              className="p-order-expand"
                              aria-expanded={open}
                              aria-label={`${open ? "收起" : "展开"}订单 ${row.order_id}`}
                              onClick={() =>
                                setExpanded(
                                  open
                                    ? expanded.filter(
                                        (id) => id !== row.order_id,
                                      )
                                    : [...expanded, row.order_id],
                                )
                              }
                            >
                              {open ? (
                                <ChevronDown size={17} />
                              ) : (
                                <ChevronRight size={17} />
                              )}
                              <span>
                                <code>{row.order_id}</code>
                                <small>
                                  最近交付 {beijing(row.last_delivered_at)}
                                </small>
                              </span>
                            </button>
                          </td>
                          <td data-label="模式">
                            <span className="p-account-mode">
                              {row.need_oauth ? "含 OAuth" : "标准账号"}
                            </span>
                          </td>
                          <td data-label="可领取账号">
                            <b>{row.available_count} 个</b>
                            <small>已选 {count} 个</small>
                          </td>
                          <td data-label="最早删除时间">
                            <Expiry value={row.download_expires_at} now={now} />
                          </td>
                          <td data-label="操作">
                            <button
                              className="p-link"
                              disabled={Boolean(busy)}
                              onClick={() => selectAll(row)}
                            >
                              {count >= row.available_count
                                ? "取消此单"
                                : "全选此单"}
                            </button>
                          </td>
                        </tr>
                        {open && (
                          <tr className="p-account-detail-row">
                            <td colSpan={6}>
                              <OrderAccounts
                                orderId={row.order_id}
                                filters={filters}
                                userId={userId}
                                {...tableProps}
                              />
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!rows.length && (
              <div className="p-center-empty">
                <strong>暂无可领取的账号资料</strong>
                <span>
                  资料交付 72 小时后自动移除。历史订单可在订单中心查询。
                </span>
              </div>
            )}
          </>
        )}
        <Pagination
          offset={offset}
          total={data?.total}
          count={rows.length}
          size={view === "orders" ? 20 : 50}
          onChange={setOffset}
        />
      </section>
      {validSecret && (
        <Modal
          title="账号凭据"
          onClose={() => {
            secretRequest.current++;
            setSecret(null);
          }}
        >
          <div className="p-notice">
            请在以下时间前保存资料：
            <Expiry value={validSecret.download_expires_at} now={now} />
          </div>
          {[
            ["邮箱", validSecret.email],
            ["密码", validSecret.password],
            ["2FA 密钥", validSecret.totp_secret],
            ["当前验证码", validSecret.totp_code],
          ].map(([label, value]) => (
            <label key={label}>
              {label}
              <div className="p-inline">
                <input aria-label={label} readOnly value={value || ""} />
                <button
                  aria-label={`复制${label}`}
                  className="p-button secondary"
                  disabled={Boolean(busy) || !value}
                  onClick={() => {
                    if (
                      isAvailable(validSecret as AccountChoice, currentTime())
                    )
                      void run("正在复制…", async () => {
                        await copy(value);
                        setNotice("已复制");
                      });
                  }}
                >
                  <Copy size={15} />
                </button>
              </div>
            </label>
          ))}
          <p className="p-muted">
            验证码每 30 秒变化。读取时剩余 {validSecret.totp_expires_in} 秒。
          </p>
          <div className="p-inline">
            <button
              className="p-button secondary"
              disabled={Boolean(busy)}
              onClick={() => reveal(validSecret)}
            >
              刷新验证码
            </button>
            {validSecret.oauth && (
              <button
                className="p-button"
                disabled={Boolean(busy)}
                onClick={() => {
                  if (isAvailable(validSecret as AccountChoice, currentTime()))
                    download(
                      `${validSecret.email}-oauth.json`,
                      JSON.stringify(validSecret.oauth, null, 2),
                    );
                }}
              >
                下载 OAuth JSON
              </button>
            )}
          </div>
          <TokenCredentials value={validSecret} busy={Boolean(busy)} onCopy={value => {
            if (isAvailable(validSecret as AccountChoice, currentTime()))
              void run("正在复制…", async () => { await copy(value); setNotice("已复制"); });
          }} />
          {validSecret.oauth && <details className="p-full-record"><summary>完整 OAuth 资料</summary><pre>{JSON.stringify(validSecret.oauth, null, 2)}</pre></details>}
        </Modal>
      )}
      {device && isAvailable(device as AccountChoice, now) && <AccountDevice key={`${userId}-${device.id}`} account={device} onClose={() => setDevice(null)} />}
    </div>
  );
}
