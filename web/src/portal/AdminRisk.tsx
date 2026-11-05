import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Settings, ShieldCheck, ArrowLeft } from "lucide-react";
import { call, date, type Row } from "./client";
import { Modal, Table } from "./Workspace";
import { Pagination } from "./Insights";
import "./AdminRisk.css";

const prefix = "/api/admin/v1/risk";
const names: Record<string, string> = {
  login: "登录尝试",
  redeem: "兑换积分",
  submit: "提交注册订单",
  query: "查询与轮询",
  export: "查看凭据与导出",
  write: "其他业务操作",
  account: "客户总请求量",
  api_key: "单个 API 密钥",
};
const operations: Record<string, string> = {
  ...names,
  login: "账户登录",
  logout: "退出登录",
  auth: "账户注册与验证",
  cancel: "取消订单",
  keys: "密钥管理",
  admin: "后台管理",
  risk: "风控管理",
  scan: "异常检查",
};
const categories: Record<string, string> = {
  login: "登录安全",
  access: "访问异常",
  limit: "频率限制",
  application: "注册订单",
  finance: "积分安全",
  admin: "管理操作",
};
const fields: [string, string, number, number][] = [
  ["retention_days", "记录保留天数", 1, 365],
  ["refresh_seconds", "监控刷新间隔（秒）", 5, 300],
  ["scan_seconds", "异常检查间隔（秒）", 10, 3600],
  ["behavior_window_seconds", "行为统计窗口（秒）", 60, 86400],
  ["login_source_accounts", "同来源尝试登录账号数", 2, 10000],
  ["duplicate_count", "幂等冲突次数告警", 1, 10000],
  ["cancel_count", "取消订单次数告警", 1, 10000],
  ["failure_min_count", "失败率最少统计账号数", 1, 10000],
  ["failure_percent", "失败比例告警（%）", 1, 100],
  ["queue_count", "单客户排队账号数告警", 1, 100000],
  ["queue_seconds", "排队超时告警（秒）", 60, 604800],
  ["processing_seconds", "执行超时告警（秒）", 60, 604800],
  ["large_adjustment", "大额积分调整告警", 1, 100000000],
];
function useDebounce(value: string) {
  const [result, setResult] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setResult(value), 300);
    return () => clearTimeout(t);
  }, [value]);
  return result;
}
function useRiskAction() {
  const q = useQueryClient(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  async function run(fn: () => Promise<unknown>, message = "操作已完成") {
    if (busy) return false;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await q.invalidateQueries({ queryKey: ["risk"] });
      setNotice(message);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, notice, run };
}
function Messages({ a }: { a: ReturnType<typeof useRiskAction> }) {
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

export default function AdminRisk() {
  const [config, setConfig] = useState(false),
    [panel, setPanel] = useState("events"),
    [q, setQ] = useState(""),
    [start, setStart] = useState(""),
    [end, setEnd] = useState(""),
    [category, setCategory] = useState(""),
    [state, setState] = useState(""),
    [offset, setOffset] = useState(0),
    [auto, setAuto] = useState(false),
    [visible, setVisible] = useState(!document.hidden),
    [customer, setCustomer] = useState<Row | null>(null),
    [confirm, setConfirm] = useState<Row | null>(null);
  const a = useRiskAction(),
    search = useDebounce(q);
  useEffect(() => {
    const f = () => setVisible(!document.hidden);
    document.addEventListener("visibilitychange", f);
    return () => document.removeEventListener("visibilitychange", f);
  }, []);
  useEffect(() => setOffset(0), [search, start, end, category, state]);
  const params = new URLSearchParams({
    q: search,
    start,
    end,
    category,
    state,
    offset: String(offset),
    limit: "50",
  });
  const monitor = useQuery({
    queryKey: ["risk", "monitor", params.toString()],
    queryFn: () => call(`${prefix}/monitor?${params}`),
    enabled: !config,
    refetchInterval: (query) =>
      auto && visible && !config
        ? (query.state.data?.refresh_seconds || 15) * 1000
        : false,
    refetchOnWindowFocus: false,
  });
  const data = monitor.data,
    summary = data?.summary || {};
  const person = (r: Row) => (
    <>
      <button
        className="risk-link"
        disabled={!r.user_id}
        onClick={() =>
          setCustomer({ id: r.user_id, label: r.account || r.email })
        }
      >
        {r.user_name || r.name || r.account || r.email || "未登录访问"}
      </button>
      {(r.user_name || r.name) && <small>{r.account || r.email}</small>}
      {r.key_id && <small>{r.key_name || "API 密钥"}</small>}
    </>
  );
  const act = (url: string, title: string, text: string) =>
    setConfirm({ url, title, text });
  if (config) return <RiskSettings onBack={() => setConfig(false)} />;
  return (
    <div className="risk-page">
      <header className="p-page-heading">
        <div>
          <span className="p-eyebrow">SECURITY / OPERATIONS</span>
          <h1>风控监控</h1>
          <p>关注异常访问、注册交付与积分变动，按客户和规则定位问题。</p>
        </div>
        <div className="risk-actions">
          <label className="risk-check">
            <input
              type="checkbox"
              checked={auto}
              onChange={(e) => setAuto(e.target.checked)}
            />
            自动更新数据
          </label>
          <button
            className="p-button secondary"
            disabled={monitor.isFetching}
            onClick={() => monitor.refetch()}
          >
            <RefreshCw size={15} />
            刷新
          </button>
          <button className="p-button" onClick={() => setConfig(true)}>
            <Settings size={15} />
            配置
          </button>
        </div>
      </header>
      <Messages a={a} />
      {monitor.error && (
        <div className="p-alert" role="alert">
          {monitor.error.message}
        </div>
      )}
      <div className="risk-banner">
        <ShieldCheck size={20} />
        <span>
          异常检查只生成告警；频率规则设为“执行限制”才会拦截。客户暂停只影响新订单，已受理订单继续执行。
        </span>
      </div>
      {data && !data.monitoring_enabled && (
        <div className="p-notice">
          风控记录与异常检查已关闭，历史记录仍可查看。已设为“执行限制”的规则继续生效。
        </div>
      )}
      <div className="risk-metrics">
        {[
          ["访问请求", summary.requests],
          ["访问拦截", summary.blocked],
          ["登录失败", summary.login_failures],
          ["待处理事件", summary.pending],
          ["当前限制", summary.restrictions],
          ["暂停下单客户", summary.paused_customers],
        ].map(([label, value]) => (
          <article className="p-card" key={String(label)}>
            <span>{label}</span>
            <strong>{Number(value || 0).toLocaleString()}</strong>
          </article>
        ))}
      </div>
      <div className="risk-filters">
        <label>
          开始日期（北京时间）
          <input
            aria-label="风控开始日期"
            type="date"
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
        <label>
          结束日期
          <input
            aria-label="风控结束日期"
            type="date"
            value={end}
            onChange={(e) => setEnd(e.target.value)}
          />
        </label>
        <label className="risk-search">
          查找客户 / 密钥 / 来源
          <input
            aria-label="风控搜索"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            maxLength={254}
            placeholder="邮箱、客户称呼、密钥名称、IP 或订单号"
          />
        </label>
      </div>
      <div className="risk-meta">
        <span>
          更新：{date(data?.generated_at)} · 异常检查：
          {Date.parse(data?.last_scan) > 0
            ? date(data?.last_scan)
            : "等待首次检查"}
        </span>
        <button
          className="p-button secondary"
          disabled={a.busy}
          onClick={() =>
            a.run(() => call(`${prefix}/scan`, "POST", {}), "异常检查已完成")
          }
        >
          立即检查
        </button>
      </div>
      <nav className="risk-tabs" aria-label="风控视图">
        {[
          ["events", "风险事件"],
          ["restrictions", "当前限制"],
          ["customers", "客户规则"],
          ["traffic", "访问统计"],
        ].map(([key, label]) => (
          <button
            key={key}
            className={panel === key ? "selected" : ""}
            onClick={() => setPanel(key)}
          >
            {label}
          </button>
        ))}
      </nav>
      {panel === "events" && (
        <section className="p-card risk-card">
          <div className="risk-actions risk-card-head">
            <select
              aria-label="事件类别"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="">全部事件类别</option>
              {Object.entries(categories).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </select>
            <select
              aria-label="处理状态"
              value={state}
              onChange={(e) => setState(e.target.value)}
            >
              <option value="">全部处理状态</option>
              <option value="pending">待处理</option>
              <option value="resolved">已处理</option>
            </select>
            <span>告警 {data?.total || 0} 条 · 重复请求按分钟合并</span>
          </div>
          <Table
            rows={data?.items || []}
            empty={
              monitor.isFetching ? "正在读取风险事件…" : "当前范围没有风险事件"
            }
            columns={[
              {
                title: "最近发生",
                render: (r) => (
                  <>
                    {date(r.last_seen)}
                    <small>{categories[r.category]}</small>
                  </>
                ),
              },
              {
                title: "事件 / 规则",
                render: (r) => (
                  <>
                    <span className={`risk-badge ${r.severity}`}>
                      {r.severity === "critical"
                        ? "高关注"
                        : r.severity === "warning"
                          ? "关注"
                          : "记录"}
                    </span>
                    {r.message}
                    <small>
                      {operations[r.operation]}
                      {r.rule ? ` · ${names[r.rule]}` : ""}
                    </small>
                    {r.target && <small className="risk-id">{r.target}</small>}
                  </>
                ),
              },
              { title: "客户 / 密钥", render: person },
              {
                title: "访问来源",
                render: (r) => (
                  <>
                    {r.source_ip || "—"}
                    {r.source_ip && (
                      <small>
                        {r.source_verified ? "已核实来源" : "来源未核实"}
                      </small>
                    )}
                  </>
                ),
              },
              {
                title: "次数 / 响应",
                render: (r) => (
                  <>
                    {r.occurrences} 次
                    <small>{r.status ? `HTTP ${r.status}` : "后台检查"}</small>
                  </>
                ),
              },
              {
                title: "处理",
                render: (r) =>
                  r.resolved_at ? (
                    <span>
                      已处理<small>{date(r.resolved_at)}</small>
                    </span>
                  ) : r.severity === "info" ? (
                    "记录"
                  ) : (
                    <button
                      className="p-button secondary"
                      disabled={a.busy}
                      onClick={() =>
                        a.run(
                          () =>
                            call(
                              `${prefix}/events/${r.id}/resolve`,
                              "POST",
                              {},
                            ),
                          "事件已标记处理",
                        )
                      }
                    >
                      标记已处理
                    </button>
                  ),
              },
            ]}
          />
          <Pagination
            offset={offset}
            total={data?.total || 0}
            count={data?.items.length || 0}
            onChange={setOffset}
          />
        </section>
      )}
      {panel === "restrictions" && (
        <section className="p-card risk-card">
          <div className="risk-card-head">
            <h2>当前访问限制</h2>
            <p>
              显示搜索匹配的前 100
              条有效限制，不受日期筛选影响；到期自动恢复，也可手动解除。
            </p>
          </div>
          <Table
            rows={data?.restrictions || []}
            columns={[
              {
                title: "客户 / 登录账号",
                render: (r) => (
                  <>
                    {r.label}
                    {r.key_name && <small>{r.key_name}</small>}
                  </>
                ),
              },
              { title: "触发规则", render: (r) => names[r.rule] },
              { title: "请求次数", render: (r) => r.hits },
              { title: "自动恢复时间", render: (r) => date(r.blocked_until) },
              {
                title: "操作",
                render: (r) => (
                  <button
                    className="p-button secondary"
                    disabled={a.busy}
                    onClick={() =>
                      act(
                        `${prefix}/limits/${r.id}/release`,
                        "解除访问限制",
                        `解除 ${r.label} 的「${names[r.rule]}」限制并重新计数。`,
                      )
                    }
                  >
                    解除限制
                  </button>
                ),
              },
            ]}
          />
        </section>
      )}
      {panel === "customers" && (
        <section className="p-card risk-card">
          <div className="risk-card-head risk-heading">
            <div>
              <h2>客户独立规则</h2>
              <p>
                显示最近配置的前 100
                位匹配客户，不受日期筛选影响。空白次数继承全局规则。
              </p>
            </div>
            <button
              className="p-button"
              onClick={() => setCustomer({ id: "", label: "" })}
            >
              配置客户
            </button>
          </div>
          <Table
            rows={data?.customers || []}
            columns={[
              { title: "客户", render: person },
              {
                title: "新订单",
                render: (r) => (
                  <span
                    className={`risk-badge ${r.currently_paused ? "warning" : "info"}`}
                  >
                    {r.currently_paused ? "已暂停" : "正常"}
                  </span>
                ),
              },
              {
                title: "恢复时间",
                render: (r) =>
                  r.paused
                    ? r.paused_until
                      ? date(r.paused_until)
                      : "手动恢复"
                    : "—",
              },
              {
                title: "覆盖次数",
                render: (r) =>
                  Object.entries(r.limits).map(([key, value]) => (
                    <small key={key}>
                      {names[key]}：{String(value)}
                    </small>
                  )),
              },
              {
                title: "操作",
                render: (r) => (
                  <button
                    className="p-button secondary"
                    onClick={() =>
                      setCustomer({ id: r.user_id, label: r.email })
                    }
                  >
                    调整 / 恢复
                  </button>
                ),
              },
            ]}
          />
        </section>
      )}
      {panel === "traffic" && (
        <section className="p-card risk-card">
          <div className="risk-card-head">
            <h2>访问统计</h2>
            <p>
              按访问量显示前 100 项。所选日期内错误 {summary.errors || 0}{" "}
              次，平均 {summary.average_ms || 0} ms。风控查询自身不计入访问量。
            </p>
          </div>
          <Table
            rows={data?.traffic || []}
            columns={[
              { title: "客户", render: person },
              {
                title: "渠道 / 密钥",
                render: (r) => (
                  <>
                    {r.channel === "api" ? "API" : "网页"}
                    <small>{r.key_name}</small>
                  </>
                ),
              },
              {
                title: "业务类型",
                render: (r) => operations[r.operation] || r.operation,
              },
              {
                title: "访问 / 错误 / 拦截",
                render: (r) => `${r.requests} / ${r.errors} / ${r.blocked}`,
              },
              { title: "平均响应", render: (r) => `${r.average_ms} ms` },
              {
                title: "操作",
                render: (r) => (
                  <div className="risk-actions">
                    {r.user_id && (
                      <button
                        className="p-button secondary"
                        onClick={() =>
                          setCustomer({ id: r.user_id, label: r.email })
                        }
                      >
                        客户规则
                      </button>
                    )}
                    {r.key_id && (
                      <button
                        className="p-button secondary"
                        disabled={a.busy}
                        onClick={() =>
                          act(
                            `${prefix}/keys/${r.key_id}/revoke`,
                            "撤销 API 密钥",
                            `撤销 ${r.key_name || "此密钥"} 后无法恢复，客户端需更换密钥。已受理订单继续执行。`,
                          )
                        }
                      >
                        撤销密钥
                      </button>
                    )}
                  </div>
                ),
              },
            ]}
          />
        </section>
      )}
      {customer && (
        <CustomerEditor initial={customer} onClose={() => setCustomer(null)} />
      )}
      {confirm && (
        <Modal
          title={confirm.title}
          onClose={() => !a.busy && setConfirm(null)}
        >
          <p className="risk-card-head">{confirm.text}</p>
          <div className="risk-card-head">
            <Messages a={a} />
            <button
              className="p-button"
              disabled={a.busy}
              onClick={async () => {
                if (await a.run(() => call(confirm.url, "POST", {})))
                  setConfirm(null);
              }}
            >
              确认操作
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function RiskSettings({ onBack }: { onBack: () => void }) {
  const { data, error, refetch } = useQuery({
    queryKey: ["risk", "settings"],
    queryFn: () => call(`${prefix}/settings`),
    refetchOnWindowFocus: false,
  });
  const [cfg, setCfg] = useState<Row | null>(null),
    [proxies, setProxies] = useState(""),
    a = useRiskAction();
  useEffect(() => {
    if (data && !cfg) {
      setCfg(structuredClone(data.settings));
      setProxies(data.settings.trusted_proxies.join("\n"));
    }
  }, [data, cfg]);
  const field = (name: string, value: unknown) =>
    setCfg((v) => ({ ...v, [name]: value }));
  return (
    <div className="risk-page">
      <header className="p-page-heading">
        <div>
          <span className="p-eyebrow">RISK SETTINGS</span>
          <h1>风控配置</h1>
          <p>规则、阈值和客户限制即时生效，不改变注册并发配置。</p>
        </div>
        <button
          className="p-button secondary"
          disabled={a.busy}
          onClick={onBack}
        >
          <ArrowLeft size={15} />
          返回监控
        </button>
      </header>
      <Messages a={a} />
      {error && <div className="p-alert">{error.message}</div>}
      {cfg && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (
              await a.run(
                () =>
                  call(`${prefix}/settings`, "PUT", {
                    ...cfg,
                    trusted_proxies: proxies
                      .split(/[\n,]+/)
                      .map((s) => s.trim())
                      .filter(Boolean),
                  }),
                "风控配置已保存",
              )
            ) {
              const fresh = await refetch();
              if (fresh.data) setCfg(structuredClone(fresh.data.settings));
            }
          }}
        >
          <fieldset disabled={a.busy} className="risk-fieldset">
            <section className="p-card risk-section">
              <h2>记录与处理模式</h2>
              <label className="risk-check">
                <input
                  type="checkbox"
                  checked={cfg.enabled}
                  onChange={(e) => field("enabled", e.target.checked)}
                />
                记录风控事件、访问统计并检查业务异常
              </label>
              <p>
                关闭记录不会关闭已经启用的执行限制。管理员仍可进入风控页面恢复访问。
              </p>
            </section>
            <section className="p-card risk-section">
              <h2>按业务配置频率</h2>
              <p>
                仅观察：记录超限行为；执行限制：返回 HTTP 429 和
                Retry-After；关闭：不统计此规则。登录按账号计数，其余按客户或
                API 密钥计数，网页与 API 共用客户额度。
              </p>
              <div className="p-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>规则</th>
                      <th>处理方式</th>
                      <th>最大次数</th>
                      <th>统计窗口（秒）</th>
                      <th>限制时长（秒）</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(names).map(([key, label]) => (
                      <tr key={key}>
                        <td>{label}</td>
                        <td>
                          <select
                            aria-label={`${label}处理方式`}
                            value={cfg.rules[key].mode}
                            onChange={(e) =>
                              field("rules", {
                                ...cfg.rules,
                                [key]: {
                                  ...cfg.rules[key],
                                  mode: e.target.value,
                                },
                              })
                            }
                          >
                            <option value="observe">仅观察</option>
                            <option value="enforce">执行限制</option>
                            <option value="off">关闭</option>
                          </select>
                        </td>
                        {[
                          ["limit", "最大次数", 100000],
                          ["window_seconds", "统计窗口", 86400],
                          ["cooldown_seconds", "限制时长", 86400],
                        ].map(([name, title, max]) => (
                          <td key={String(name)}>
                            <input
                              aria-label={`${label}${title}`}
                              type="number"
                              min={1}
                              max={Number(max)}
                              required
                              value={cfg.rules[key][name]}
                              onChange={(e) =>
                                field("rules", {
                                  ...cfg.rules,
                                  [key]: {
                                    ...cfg.rules[key],
                                    [name]: Number(e.target.value),
                                  },
                                })
                              }
                            />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
            <section className="p-card risk-section">
              <h2>告警阈值与记录周期</h2>
              <p>
                异常只提示关注，不取消订单或改动积分。失败率按交付成功及最终失败的账号数量计算。记录到期只清理风控数据，订单、账本和交付数据保持原规则。
              </p>
              <div className="risk-fields">
                {fields.map(([key, label, min, max]) => (
                  <label key={key}>
                    {label}
                    <input
                      aria-label={label}
                      type="number"
                      required
                      min={min}
                      max={max}
                      value={cfg[key]}
                      onChange={(e) => field(key, Number(e.target.value))}
                    />
                  </label>
                ))}
              </div>
              <label className="risk-check">
                <input
                  type="checkbox"
                  checked={cfg.finance_checks}
                  onChange={(e) => field("finance_checks", e.target.checked)}
                />
                检查冻结积分、订单结算与账本一致性
              </label>
            </section>
            <section className="p-card risk-section">
              <h2>来源识别</h2>
              <label>
                可信反向代理 IP / 网段（每行一项）
                <textarea
                  aria-label="可信代理地址"
                  rows={4}
                  value={proxies}
                  onChange={(e) => setProxies(e.target.value)}
                  placeholder="仅填写已核实的反向代理地址，默认留空"
                />
              </label>
              <p>
                这是站点前方的反向代理，不是注册使用的代理池。只有可信代理传来的转发链用于确认客户
                IP，未确认来源会明确标记；来源 IP
                不用于自动封禁客户，避免共用出口误伤。
              </p>
            </section>
            <div className="risk-actions risk-save">
              <button
                className="p-button secondary"
                type="button"
                onClick={() => {
                  setCfg({
                    ...structuredClone(data.defaults),
                    revision: cfg.revision,
                  });
                  setProxies(data.defaults.trusted_proxies.join("\n"));
                }}
              >
                填入推荐默认值
              </button>
              <button
                className="p-button secondary"
                type="button"
                onClick={async () => {
                  const result = await refetch();
                  if (result.data) {
                    setCfg(structuredClone(result.data.settings));
                    setProxies(result.data.settings.trusted_proxies.join("\n"));
                  }
                }}
              >
                重新加载配置
              </button>
              <button className="p-button" type="submit">
                {a.busy ? "保存中…" : "保存风控配置"}
              </button>
            </div>
            <p>
              填入默认值后需保存才会生效；修改频率规则会重置对应的计数与临时限制。
            </p>
          </fieldset>
        </form>
      )}
    </div>
  );
}
function CustomerEditor({
  initial,
  onClose,
}: {
  initial: Row;
  onClose: () => void;
}) {
  const [search, setSearch] = useState(""),
    [selected, setSelected] = useState(initial.id),
    [value, setValue] = useState<Row | null>(null),
    [until, setUntil] = useState(""),
    a = useRiskAction(),
    q = useDebounce(search);
  const users = useQuery({
    queryKey: ["risk", "users", q],
    queryFn: () =>
      call(`/api/admin/v1/users?q=${encodeURIComponent(q)}&limit=100`),
  });
  const control = useQuery({
    queryKey: ["risk", "customer", selected],
    queryFn: () => call(`${prefix}/customers/${selected}`),
    enabled: Boolean(selected),
    refetchOnWindowFocus: false,
  });
  useEffect(() => {
    setValue(null);
    setUntil("");
  }, [selected]);
  useEffect(() => {
    if (control.data) {
      setValue(structuredClone(control.data));
      const time = control.data.paused_until
        ? new Date(control.data.paused_until)
        : null;
      setUntil(
        time
          ? new Date(time.getTime() - time.getTimezoneOffset() * 60000)
              .toISOString()
              .slice(0, 16)
          : "",
      );
    }
  }, [control.data]);
  return (
    <Modal title="客户风控设置" onClose={() => !a.busy && onClose()}>
      <form
        className="risk-section"
        onSubmit={async (e) => {
          e.preventDefault();
          if (
            await a.run(
              () =>
                call(`${prefix}/customers/${selected}`, "PUT", {
                  ...value,
                  paused_until: until ? new Date(until).toISOString() : null,
                }),
              "客户规则已保存",
            )
          )
            onClose();
        }}
      >
        <Messages a={a} />
        <fieldset className="risk-fieldset" disabled={a.busy}>
          <label>
            查找客户
            <input
              aria-label="查找风控客户"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="输入邮箱或称呼，显示前 100 位匹配客户"
            />
          </label>
          <label>
            选择客户
            <select
              aria-label="选择风控客户"
              value={selected}
              onChange={(e) => setSelected(e.target.value)}
            >
              <option value="">请选择</option>
              {selected &&
                !users.data?.items.some((u: Row) => u.id === selected) && (
                  <option value={selected}>{initial.label || selected}</option>
                )}
              {users.data?.items.map((u: Row) => (
                <option key={u.id} value={u.id}>
                  {u.name} · {u.email}
                </option>
              ))}
            </select>
          </label>
          {(users.error || control.error) && (
            <div className="p-alert">
              {(users.error || control.error)?.message}
            </div>
          )}
          {value && (
            <>
              <label className="risk-check">
                <input
                  type="checkbox"
                  checked={value.paused}
                  onChange={(e) =>
                    setValue({ ...value, paused: e.target.checked })
                  }
                />
                暂停该客户提交新订单
              </label>
              <p>
                暂停不影响已受理订单执行、查询、取消、交付下载及原幂等键确认。客户仍受配置的其他频率规则约束。
              </p>
              {value.paused && (
                <label>
                  自动恢复时间（留空则手动恢复）
                  <input
                    aria-label="客户自动恢复时间"
                    type="datetime-local"
                    value={until}
                    onChange={(e) => setUntil(e.target.value)}
                  />
                </label>
              )}
              <div className="risk-fields">
                {Object.entries(names)
                  .filter(([key]) => key !== "login")
                  .map(([key, label]) => (
                    <label key={key}>
                      {label}
                      <input
                        aria-label={`客户${label}次数`}
                        type="number"
                        min={1}
                        max={100000}
                        placeholder="继承全局"
                        value={value.limits[key] ?? ""}
                        onChange={(e) => {
                          const limits = { ...value.limits };
                          if (e.target.value)
                            limits[key] = Number(e.target.value);
                          else delete limits[key];
                          setValue({ ...value, limits });
                        }}
                      />
                    </label>
                  ))}
              </div>
              <p>这里只覆盖次数，处理方式、统计窗口和限制时长跟随全局规则。</p>
              <button className="p-button" type="submit">
                {a.busy ? "保存中…" : "保存客户规则"}
              </button>
            </>
          )}
        </fieldset>
      </form>
    </Modal>
  );
}
