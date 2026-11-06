import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { call, date, type Row, uid, orderPending } from "./client";
import {
  Feedback,
  Modal,
  OrderDetail,
  Status,
  Table,
  useAction,
} from "./Workspace";
import { RefreshCw } from "lucide-react";
import { Filters, Pagination, number } from "./Insights";
import AdminOverview from "./AdminOverview";
import AdminFinance from "./AdminFinance";
import AdminCreateUser from "./AdminCreateUser";
import AdminUserDetail from "./AdminUserDetail";
import BrandSettings from "./BrandSettings";
import AdminSiteControls from "./AdminSiteControls";
import AdminAnnouncements from "./AdminAnnouncements";
import AdminRedeemUsage from "./AdminRedeemUsage";
import AdminCodes from "./AdminCodes";
import AdminAccounts from "./AdminAccounts";
import { ResourceCost } from "./AdminCosts";
export default function AdminPlatform({ tab = "overview" }: { tab?: string }) {
  const [offset, setOffset] = useState(0),
    [filters, setFilters] = useState<Row>(() => ({
      status: new URLSearchParams(location.search).get("status") || "",
    })),
    [days, setDays] = useState(7),
    [settingTab, setSettingTab] = useState("features"),
    [userDetail, setUserDetail] = useState(""),
    [createUser, setCreateUser] = useState(false),
    [settings, setSettings] = useState<Row | null>(null),
    [detail, setDetail] = useState(""),
    [adjust, setAdjust] = useState<Row | null>(null),
    [amount, setAmount] = useState(0),
    [note, setNote] = useState(""),
    [adjustKey, setAdjustKey] = useState(uid);
  const [codesUsage, setCodesUsage] = useState(false);
  const usagePage = tab === "codes" && codesUsage;
  const a = useAction();
  const settingsPage = ["settings", "products", "announcements"].includes(tab);
  const endpoint = settingsPage
    ? "settings"
    : tab === "codes"
      ? "redeem-codes"
      : tab === "accounts" ? "account-orders" : tab;
  const params = new URLSearchParams({
    limit: "50",
    offset: String(offset),
    days: String(days),
    ...filters,
  });
  const { data, error, refetch, isFetching } = useQuery({
    enabled: !usagePage && tab !== "finance",
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
    finance: "财务报表",
    accounts: "账号交付",
    products: "服务与定价",
    announcements: "站点公告",
    users: "账户管理",
    codes: "兑换码管理",
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
                finance: "按时间与账户核对入账、消费和余额，默认排除管理员。",
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
        {tab === "codes" && <button className="p-button secondary" onClick={()=>setCodesUsage(!codesUsage)}>{codesUsage?"返回兑换码":"使用情况"}</button>}
        {tab === "users" && (
          <button className="p-button" onClick={() => setCreateUser(true)}>
            创建客户账户 +
          </button>
        )}
        {tab === "overview" && (
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
        {!settingsPage && !usagePage && tab !== "finance" && (
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

      {!usagePage && error && <div className="p-alert">{error.message}</div>}
      {tab === "overview" && data && (
        <AdminOverview data={data} onOrder={setDetail} />
      )}
      {!usagePage && ["orders", "users", "accounts", "codes", "audit"].includes(
        tab,
      ) && (
        <Filters
          value={filters}
          onChange={(v) => {
            setFilters(v);
            setOffset(0);
          }}
          mode={["orders", "accounts"].includes(tab)}
          kind={tab === "finance"}
          status={
            tab === "orders"
              ? {
                  queued: "排队中",
                  running: "执行中",
                  review: "自动恢复中",
                  completed: "全部完成",
                  partial: "部分完成",
                  failed: "未完成",
                  cancelled: "已取消",
                }
              : tab === "users"
                ? { active: "正常", disabled: "停用" }
                : tab === "codes"
                  ? {
                      available: "未使用",
                      used: "已使用",
                      disabled: "已停用",
                      expired: "已过期",
                    }
                  : undefined
          }
          placeholder={
            tab === "codes"
              ? "搜索兑换码标识、发行批次或兑换人邮箱"
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
      {tab === "finance" && <AdminFinance />}
      {tab === "accounts" && (
        <AdminAccounts
          filters={filters}
          key={JSON.stringify(filters)}
          rows={rows}
          onOrder={setDetail}
        />
      )}
      {tab === "orders" && (
        <section className="p-card p-record-card">
          <Table
            rows={rows}
            columns={[
              { title: "用户", render: (r) => r.email },
              {
                title: "订单",
                render: (r) => <code title={r.id}>{r.id.slice(0, 12)}</code>,
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
              { title: "邮箱数量 / 费用", render: r => <ResourceCost cost={r.execution_cost} kind="mail" /> },
              { title: "短信数量 / 费用", render: r => <ResourceCost cost={r.execution_cost} kind="sms" /> },
              { title: "操作", render: r => <button className="p-button secondary" onClick={() => setDetail(r.id)}>订单详情</button> },
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
      {usagePage && <AdminRedeemUsage/>}
      {tab === "codes" && !usagePage && (
        <AdminCodes
          key={JSON.stringify([offset, filters])}
          rows={rows}
          stats={data?.stats}
        />
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
                    "registration_concurrency",
                    "user_registration_concurrency",
                    "max_open_orders",
                    "attempt_limit",
                    "resource_retry_limit",
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
                  ["registration_concurrency", "注册并发数（全平台）", 1, 100],
                  [
                    "user_registration_concurrency",
                    "注册并发数（单用户）",
                    1,
                    100,
                  ],
                  ["max_open_orders", "每用户未完成订单上限", 1, 20],
                  ["attempt_limit", "启动／授权最大尝试次数（含首次）", 1, 5],
                  ["resource_retry_limit", "未交付账号最多换邮箱次数（不含首次）", 0, 10],
                  ["timeout_minutes", "单个账号总时限（含换邮箱／恢复，分钟）", 2, 120],
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
              <p className="p-muted">
                全平台与单用户上限同时生效，默认均为
                15。单用户的全部订单、仅注册与注册并 OAuth 合并计数。提交 100
                个时其余排队，每结束一个自动补位。调低并发不打断在途任务，后续按新上限调度。
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
                <div className="p-muted">
                  <b>注册地区由用户选择</b>
                  <p>新订单默认在已配置的国家池中随机分配，用户可指定注册地区。新增或删除可选地区，请在原管理台维护国家代理池。</p>
                  <p>已有订单继续使用下单时保存的模板；此处的邮箱设置只影响后续订单。</p>
                </div>
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
      {!usagePage && ["users", "orders", "accounts", "codes", "audit"].includes(
        tab,
      ) && (
        <Pagination
          offset={offset}
          total={data?.total}
          count={rows.length}
          onChange={(n) => {
            setOffset(n);
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
      <p className="p-footer-note">
        原有配置和历史账号由注册管理台维护，客户账号按订单归属独立交付。
        <a href="/" target="_blank" rel="noopener noreferrer">
          返回用户前台 ↗
        </a>
      </p>
    </>
  );
}
