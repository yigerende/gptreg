import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { call, copy, date, type Row, uid, orderPending } from "./client";
import {
  Feedback,
  Modal,
  OrderDetail,
  Status,
  Table,
  useAction,
} from "./Workspace";
import { Link } from "../router";
import { RefreshCw } from "lucide-react";
import { Filters, Pagination, number } from "./Insights";
import AdminOverview, { AdminFinance } from "./AdminOverview";
import AdminCreateUser from "./AdminCreateUser";
import AdminUserDetail from "./AdminUserDetail";
import BrandSettings from "./BrandSettings";
import AdminSiteControls from "./AdminSiteControls";
import AdminAnnouncements from "./AdminAnnouncements";
export default function AdminPlatform({ tab = "overview" }: { tab?: string }) {
  const [offset, setOffset] = useState(0),
    [filters, setFilters] = useState<Row>(() => ({
      status: new URLSearchParams(location.search).get("status") || "",
    })),
    [days, setDays] = useState(7),
    [settingTab, setSettingTab] = useState("features"),
    [userDetail, setUserDetail] = useState(""),
    [createUser, setCreateUser] = useState(false),
    [selectedCodes, setSelectedCodes] = useState<string[]>([]),
    [settings, setSettings] = useState<Row | null>(null),
    [detail, setDetail] = useState(""),
    [adjust, setAdjust] = useState<Row | null>(null),
    [amount, setAmount] = useState(0),
    [note, setNote] = useState(""),
    [adjustKey, setAdjustKey] = useState(uid),
    [count, setCount] = useState(1),
    [points, setPoints] = useState(100),
    [codes, setCodes] = useState<string[]>([]);
  const a = useAction();
  const settingsPage = ["settings", "products", "announcements"].includes(tab);
  const endpoint = settingsPage
    ? "settings"
    : tab === "codes"
      ? "redeem-codes"
      : tab;
  const params = new URLSearchParams({
    limit: "50",
    offset: String(offset),
    days: String(days),
    ...filters,
  });
  const { data, error, refetch, isFetching } = useQuery({
    queryKey: ["admin", tab, offset, filters, days],
    queryFn: () => call(`/api/admin/v1/${endpoint}?${params}`),
    refetchInterval: (query) =>
      tab === "orders" && query.state.data?.items?.some(orderPending)
        ? 5000
        : false,
    refetchOnReconnect: !settingsPage,
  });
  useEffect(() => {
    if (settingsPage && data) setSettings(structuredClone(data));
  }, [data, tab]);
  function field(key: string, value: any) {
    setSettings((s) => ({ ...s, [key]: value }));
  }
  const rows = data?.items || [];
  const tabs: Row = {
    overview: "运营概览",
    orders: "订单监控",
    finance: "积分报表",
    accounts: "账号交付",
    products: "服务与定价",
    announcements: "站点公告",
    users: "账户管理",
    codes: "积分兑换码",
    settings: "站点设置",
    audit: "操作审计",
  };
  return (
    <>
      <div className="p-page-heading">
        <div>
          <span className="p-eyebrow">OPERATIONS / {tab.toUpperCase()}</span>
          <h1>{tabs[tab] || "运营控制台"}</h1>
          <p>
            {
              {
                overview: "掌握客户、交付与积分流转，让每一笔业务都有据可查。",
                orders: "查看全部客户订单，跟踪执行进度与异常处理。",
                users: "管理客户状态、查询业务记录与调整账户积分。",
                finance: "从预留到结算，每一笔积分都有完整记录。",
                accounts: "查询已交付账号及其客户和订单归属。",
                products: "设置两种注册服务的单价、限额及执行模板。",
                codes: "发行积分兑换码，跟踪使用与停用状态。",
                announcements: "向客户同步服务动态和使用说明。",
                audit: "追溯账户、积分和配置的管理操作。",
                settings: "塑造你的品牌，管理服务约定与平台基础配置。",
              }[tab]
            }
          </p>
        </div>
      </div>
      <div className="p-admin-toolbar">
        {tab === "users" && (
          <button className="p-button" onClick={() => setCreateUser(true)}>
            创建客户账户 +
          </button>
        )}
        {["overview", "finance"].includes(tab) && (
          <select
            aria-label="统计时段"
            value={days}
            onChange={(e) => {
              setDays(Number(e.target.value));
              setOffset(0);
            }}
          >
            <option value={7}>最近 7 天</option>
            <option value={30}>最近 30 天</option>
            <option value={90}>最近 90 天</option>
          </select>
        )}
        {!settingsPage && (
          <button
            className="p-button secondary"
            disabled={isFetching}
            onClick={() => refetch()}
          >
            <RefreshCw size={15} />
            刷新数据
          </button>
        )}
      </div>
      <Feedback a={a} />

      {error && <div className="p-alert">{error.message}</div>}
      {tab === "overview" && data && (
        <AdminOverview data={data} onOrder={setDetail} />
      )}
      {["orders", "users", "accounts", "finance", "codes", "audit"].includes(
        tab,
      ) && (
        <Filters
          value={filters}
          onChange={(v) => {
            setFilters(v);
            setOffset(0);
            setSelectedCodes([]);
          }}
          mode={["orders", "accounts"].includes(tab)}
          kind={tab === "finance"}
          status={
            tab === "orders"
              ? {
                  queued: "排队中",
                  running: "执行中",
                  review: "待核实",
                  completed: "全部完成",
                  partial: "部分完成",
                  failed: "未完成",
                  cancelled: "已取消",
                }
              : tab === "users"
                ? { active: "正常", disabled: "停用" }
                : tab === "codes"
                  ? { available: "未使用", used: "已使用", disabled: "已停用" }
                  : undefined
          }
          placeholder={
            tab === "codes"
              ? "搜索兑换码前缀或兑换人邮箱"
              : tab === "audit"
                ? "搜索操作、说明或操作者邮箱"
                : tab === "users"
                  ? "搜索账户邮箱或用户名"
                  : tab === "finance"
                    ? "搜索客户邮箱或账本说明"
                    : "搜索订单编号或邮箱"
          }
        />
      )}
      {tab === "finance" && data && <AdminFinance data={data} />}
      {tab === "accounts" && (
        <section className="p-card p-record-card">
          <Table
            rows={rows}
            columns={[
              { title: "交付账号", render: (r) => <b>{r.email}</b> },
              { title: "所属客户", render: (r) => r.owner_email },
              {
                title: "注册服务",
                render: (r) => (r.need_oauth ? "OAuth 授权账号" : "标准账号"),
              },
              {
                title: "关联订单",
                render: (r) => (
                  <button
                    className="p-link"
                    onClick={() => setDetail(r.order_id)}
                  >
                    {r.order_id.slice(0, 12)} ↗
                  </button>
                ),
              },
              { title: "交付时间", render: (r) => date(r.created_at) },
            ]}
          />
        </section>
      )}
      {tab === "orders" && (
        <section className="p-card p-record-card">
          <Table
            rows={rows}
            columns={[
              { title: "用户", render: (r) => r.email },
              {
                title: "订单",
                render: (r) => (
                  <button className="p-link" onClick={() => setDetail(r.id)}>
                    {r.id.slice(0, 8)} ↗
                  </button>
                ),
              },
              {
                title: "模式",
                render: (r) => (r.need_oauth ? "含 OAuth" : "标准账号"),
              },
              { title: "交付", render: (r) => `${r.delivered}/${r.quantity}` },
              { title: "状态", render: (r) => <Status value={r.status} /> },
              {
                title: "单价 / 扣费",
                render: (r) => `${r.unit_price} / ${r.charged}`,
              },
              { title: "时间", render: (r) => date(r.created_at) },
            ]}
          />
        </section>
      )}
      {tab === "users" && (
        <section className="p-card p-record-card">
          <Table
            rows={rows}
            columns={[
              {
                title: "用户",
                render: (r) => (
                  <>
                    <button
                      className="p-link"
                      onClick={() => setUserDetail(r.id)}
                    >
                      <b>{r.name}</b>
                    </button>
                    <small className="p-block">{r.email}</small>
                  </>
                ),
              },
              {
                title: "角色",
                render: (r) => (r.role === "admin" ? "管理员" : "用户"),
              },
              {
                title: "可用 / 预留积分",
                render: (r) => `${r.points} / ${r.frozen}`,
              },
              {
                title: "订单 / 消费",
                render: (r) => `${r.orders} 笔 / ${number(r.spent)} 积分`,
              },
              { title: "状态", render: (r) => <Status value={r.status} /> },
              {
                title: "操作",
                render: (r) => (
                  <div className="p-inline">
                    <button
                      className="p-link"
                      onClick={() => {
                        setAdjust(r);
                        setAmount(0);
                        setNote("");
                        setAdjustKey(uid());
                      }}
                    >
                      调整积分
                    </button>
                    {r.role !== "admin" && (
                      <button
                        className="p-link danger"
                        disabled={a.busy}
                        onClick={() =>
                          a.run(() =>
                            call(`/api/admin/v1/users/${r.id}`, "PATCH", {
                              status:
                                r.status === "active" ? "disabled" : "active",
                            }),
                          )
                        }
                      >
                        {r.status === "active" ? "停用" : "启用"}
                      </button>
                    )}
                  </div>
                ),
              },
            ]}
          />
        </section>
      )}
      {tab === "codes" && (
        <>
          <form
            className="p-card"
            onSubmit={(e) => {
              e.preventDefault();
              a.run(
                () =>
                  call("/api/admin/v1/redeem-codes", "POST", { points, count }),
                "兑换码已生成，请立即保存",
              ).then((r) => r && setCodes(r.codes));
            }}
          >
            <h2>生成积分兑换码</h2>
            <div className="p-form-grid">
              <label>
                每个兑换码积分
                <input
                  type="number"
                  required
                  min={1}
                  max={1000000}
                  value={points}
                  onChange={(e) => setPoints(Number(e.target.value))}
                />
              </label>
              <label>
                生成数量
                <input
                  type="number"
                  required
                  min={1}
                  max={100}
                  value={count}
                  onChange={(e) => setCount(Number(e.target.value))}
                />
              </label>
            </div>
            <button className="p-button" disabled={a.busy}>
              生成兑换码
            </button>
          </form>
          <section className="p-card">
            <div className="p-section-heading">
              <button
                className="p-link"
                onClick={() =>
                  setSelectedCodes(
                    selectedCodes.length
                      ? []
                      : rows
                          .filter((r: Row) => !r.redeemed_by)
                          .map((r: Row) => r.id),
                  )
                }
              >
                选择 / 取消本页未使用兑换码
              </button>
              <span className="p-muted p-fine">
                已选 {selectedCodes.length} 条
              </span>
            </div>
            <div className="p-inline">
              {[
                ["enable", "批量启用"],
                ["disable", "批量停用"],
                ["delete", "删除未使用"],
              ].map(([action, label]) => (
                <button
                  className="p-button secondary"
                  key={action}
                  disabled={!selectedCodes.length || a.busy}
                  onClick={() => {
                    if (
                      action !== "delete" ||
                      window.confirm("删除所选未使用兑换码？已兑换记录将保留。")
                    )
                      void a
                        .run(
                          () =>
                            call("/api/admin/v1/redeem-codes/batch", "POST", {
                              ids: selectedCodes,
                              action,
                            }),
                          "批量操作完成",
                        )
                        .then((r) => r && setSelectedCodes([]));
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            <Table
              rows={rows}
              columns={[
                {
                  title: "选择",
                  render: (r) => (
                    <input
                      type="checkbox"
                      aria-label={`选择兑换码 ${r.prefix}`}
                      disabled={Boolean(r.redeemed_by)}
                      checked={selectedCodes.includes(r.id)}
                      onChange={(e) =>
                        setSelectedCodes(
                          e.target.checked
                            ? [...selectedCodes, r.id]
                            : selectedCodes.filter((x) => x !== r.id),
                        )
                      }
                    />
                  ),
                },
                { title: "兑换人", render: (r) => r.redeemed_email || "—" },
                { title: "前缀", render: (r) => <code>{r.prefix}…</code> },
                { title: "积分", render: (r) => r.points },
                {
                  title: "状态",
                  render: (r) =>
                    r.redeemed_by ? "已使用" : r.disabled ? "已停用" : "未使用",
                },
                { title: "创建时间", render: (r) => date(r.created_at) },
                {
                  title: "操作",
                  render: (r) =>
                    !r.redeemed_by && (
                      <button
                        className="p-link"
                        disabled={a.busy}
                        onClick={() =>
                          a.run(() =>
                            call(
                              `/api/admin/v1/redeem-codes/${r.id}`,
                              "PATCH",
                              { disabled: !r.disabled },
                            ),
                          )
                        }
                      >
                        {r.disabled ? "启用" : "停用"}
                      </button>
                    ),
                },
              ]}
            />
          </section>
        </>
      )}
      {settingsPage && settings && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const fields =
              tab === "products"
                ? [
                    "price_standard",
                    "price_oauth",
                    "max_quantity",
                    "max_open_orders",
                    "attempt_limit",
                    "timeout_minutes",
                    "template",
                  ]
                : tab === "announcements"
                  ? ["announcement", "announcements"]
                  : (
                      {
                        features: [
                          "features",
                          "orders_open",
                          "worker_enabled",
                          "api_enabled",
                        ],
                        security: [
                          "registration_open",
                          "email_verify_enabled",
                          "email_domains",
                        ],
                        mail: ["smtp"],
                        custom_menus: ["custom_menus"],
                        brand: ["site_name", "brand"],
                      } as Record<string, string[]>
                    )[settingTab];
            const s = Object.fromEntries(
              fields.map((k) => [k, structuredClone(settings[k])]),
            );
            if (s.smtp) delete s.smtp.password_configured;
            a.run(
              () => call("/api/admin/v1/settings", "PATCH", s),
              "站点设置已保存",
            );
          }}
        >
          {tab === "settings" && (
            <div className="p-setting-tabs">
              {Object.entries({
                features: "功能开关",
                security: "安全与认证",
                mail: "邮件设置",
                custom_menus: "自定义菜单",
                brand: "品牌与服务",
              }).map(([k, v]) => (
                <button
                  type="button"
                  key={k}
                  className={settingTab === k ? "selected" : ""}
                  onClick={() => setSettingTab(k)}
                >
                  {v}
                </button>
              ))}
            </div>
          )}
          {tab === "settings" &&
            (settingTab === "brand" ? (
              <BrandSettings settings={settings} field={field} />
            ) : (
              <AdminSiteControls
                key={settingTab}
                tab={settingTab}
                settings={settings}
                field={field}
              />
            ))}
          {tab === "announcements" && (
            <AdminAnnouncements settings={settings} field={field} />
          )}
          {tab === "products" && (
            <section className="p-card">
              <h2>积分价格与限额</h2>
              <div className="p-form-grid">
                {[
                  ["price_standard", "不带 OAuth / 个", 0, 1000000],
                  ["price_oauth", "含 OAuth / 个", 0, 1000000],
                  ["max_quantity", "每单最大数量", 1, 1000],
                  ["max_open_orders", "每用户未完成订单上限", 1, 20],
                  ["attempt_limit", "每阶段最大尝试次数", 1, 5],
                  ["timeout_minutes", "每次执行时限（分钟）", 2, 120],
                ].map(([key, label, min, max]) => (
                  <label key={String(key)}>
                    {label}
                    <input
                      type="number"
                      required
                      min={Number(min)}
                      max={Number(max)}
                      value={settings[String(key)]}
                      onChange={(e) =>
                        field(String(key), Number(e.target.value))
                      }
                    />
                  </label>
                ))}
              </div>
              <p className="p-muted">
                下单锁定单价。改价只影响后续新订单；失败与取消的未交付部分退回预留积分。
              </p>
            </section>
          )}
          {tab === "products" && (
            <section className="p-card">
              <h2>客户订单注册模板</h2>
              <p className="p-muted">
                邮箱 API
                Key、库存和代理池在原管理台维护。订单每次调度一个账号，多用户按轮次排队。
              </p>
              <div className="p-form-grid">
                <label>
                  邮箱供应商
                  <select
                    value={settings.template.mailProvider || ""}
                    onChange={(e) => {
                      const t = { ...settings.template };
                      if (e.target.value) t.mailProvider = e.target.value;
                      else delete t.mailProvider;
                      field("template", t);
                    }}
                  >
                    <option value="">使用注册引擎当前默认</option>
                    <option value="smsbower">SMSBower Gmail</option>
                    <option value="xiaopingguo">小苹果</option>
                    <option value="mailcom">Mail.com</option>
                    <option value="fastmail">Fastmail</option>
                    <option value="icloud">iCloud</option>
                  </select>
                </label>
                <label>
                  代理来源
                  <select
                    value={settings.template.proxyAssignments?.[0]?.kind || ""}
                    onChange={(e) => {
                      const kind = e.target.value;
                      field(
                        "template",
                        kind
                          ? {
                              ...settings.template,
                              schemaVersion: 2,
                              proxyAssignments: [
                                {
                                  workerSlot: 1,
                                  kind,
                                  ...(kind === "countryPool"
                                    ? { countryCode: "US" }
                                    : { localProxyId: "" }),
                                },
                              ],
                            }
                          : {
                              ...(settings.template.mailProvider
                                ? {
                                    mailProvider:
                                      settings.template.mailProvider,
                                  }
                                : {}),
                            },
                      );
                    }}
                  >
                    <option value="">使用引擎本地代理池</option>
                    <option value="countryPool">国家动态代理池</option>
                    <option value="local">指定本地代理</option>
                  </select>
                </label>
                {settings.template.proxyAssignments?.[0]?.kind ===
                  "countryPool" && (
                  <label>
                    国家代码
                    <input
                      required
                      pattern="GLOBAL|[A-Z]{2}"
                      value={settings.template.proxyAssignments[0].countryCode}
                      onChange={(e) =>
                        field("template", {
                          ...settings.template,
                          proxyAssignments: [
                            {
                              workerSlot: 1,
                              kind: "countryPool",
                              countryCode: e.target.value.toUpperCase(),
                            },
                          ],
                        })
                      }
                      placeholder="US、PH 或 GLOBAL"
                    />
                  </label>
                )}
                {settings.template.proxyAssignments?.[0]?.kind === "local" && (
                  <label>
                    本地代理 ID
                    <input
                      required
                      value={settings.template.proxyAssignments[0].localProxyId}
                      onChange={(e) =>
                        field("template", {
                          ...settings.template,
                          proxyAssignments: [
                            {
                              workerSlot: 1,
                              kind: "local",
                              localProxyId: e.target.value,
                            },
                          ],
                        })
                      }
                    />
                  </label>
                )}
              </div>
              <a href="/admin/engine/proxies" className="p-link">
                管理代理资源 ↗
              </a>
            </section>
          )}
          <div className="p-save-bar">
            <button className="p-button" disabled={a.busy}>
              {a.busy ? "保存中…" : "保存配置"}
            </button>
          </div>
        </form>
      )}
      {tab === "audit" && (
        <section className="p-card p-record-card">
          <Table
            rows={rows}
            columns={[
              { title: "操作", render: (r) => r.action },
              {
                title: "执行用户",
                render: (r) => r.actor_email || r.actor_id || "系统",
              },
              { title: "目标", render: (r) => r.target || "—" },
              { title: "说明", render: (r) => r.detail || "—" },
              { title: "时间", render: (r) => date(r.created_at) },
            ]}
          />
        </section>
      )}
      {["users", "orders", "accounts", "finance", "codes", "audit"].includes(
        tab,
      ) && (
        <Pagination
          offset={offset}
          total={data?.total}
          count={rows.length}
          onChange={(n) => {
            setOffset(n);
            setSelectedCodes([]);
          }}
        />
      )}
      {createUser && <AdminCreateUser onClose={() => setCreateUser(false)} />}
      {userDetail && (
        <AdminUserDetail id={userDetail} onClose={() => setUserDetail("")} />
      )}
      {detail && (
        <OrderDetail id={detail} admin onClose={() => setDetail("")} />
      )}
      {adjust && (
        <Modal
          title={`调整积分 · ${adjust.email}`}
          onClose={() => setAdjust(null)}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              a.run(
                () =>
                  call(
                    `/api/admin/v1/users/${adjust.id}/points`,
                    "POST",
                    { amount, note },
                    adjustKey,
                  ),
                "积分已调整",
              ).then((r) => r && setAdjust(null));
            }}
          >
            <p>
              当前可用 {adjust.points} 积分，预留 {adjust.frozen} 积分。
            </p>
            <label>
              调整数量（正数加款，负数扣减）
              <input
                type="number"
                required
                value={amount}
                onChange={(e) => {
                  setAmount(Number(e.target.value));
                  setAdjustKey(uid());
                }}
              />
            </label>
            <label>
              调整原因
              <input
                required
                maxLength={200}
                value={note}
                onChange={(e) => {
                  setNote(e.target.value);
                  setAdjustKey(uid());
                }}
              />
            </label>
            <button className="p-button" disabled={a.busy || !amount}>
              确认调整
            </button>
          </form>
        </Modal>
      )}
      {codes.length > 0 && (
        <Modal title="积分兑换码" onClose={() => setCodes([])}>
          <p>完整兑换码仅显示本次，请立即保存。</p>
          <pre>{codes.join("\n")}</pre>
          <button
            className="p-button"
            onClick={() =>
              a.run(() => copy(codes.join("\n")), "已复制全部兑换码")
            }
          >
            复制全部
          </button>
        </Modal>
      )}
      <p className="p-footer-note">
        原有配置和历史账号由注册管理台维护，客户账号按订单归属独立交付。
        <Link to="/">返回用户前台</Link>
      </p>
    </>
  );
}
