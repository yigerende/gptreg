import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { call, copy, date, type Row, uid } from "./client";
import {
  Feedback,
  Modal,
  OrderDetail,
  Status,
  Table,
  useAction,
} from "./Workspace";
import { Link } from "../router";
export default function AdminPlatform() {
  const [tab, setTab] = useState("overview"),
    [offset, setOffset] = useState(0),
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
  const { data, error } = useQuery({
    queryKey: ["admin", tab, offset],
    queryFn: () =>
      call(
        `/api/admin/v1/${tab === "codes" ? "redeem-codes" : tab}?limit=50&offset=${offset}`,
      ),
    refetchInterval: tab === "overview" || tab === "orders" ? 5000 : false,
  });
  useEffect(() => {
    if (tab === "settings" && data) setSettings(structuredClone(data));
  }, [data, tab]);
  function field(key: string, value: any) {
    setSettings((s) => ({ ...s, [key]: value }));
  }
  const rows = data?.items || [];
  const tabs: Row = {
    overview: "运营概览",
    orders: "客户订单",
    users: "用户与积分",
    codes: "积分兑换码",
    settings: "站点设置",
    audit: "操作审计",
  };
  return (
    <>
      <div className="p-page-heading">
        <div>
          <span className="p-eyebrow">ADMINISTRATION</span>
          <h1>平台管理</h1>
          <p>管理客户、积分、订单和开放策略。</p>
        </div>
        <a className="p-button secondary" href="/admin/engine">
          进入原注册管理台 ↗
        </a>
      </div>
      <div className="p-admin-tabs">
        {Object.entries(tabs).map(([k, v]) => (
          <button
            key={k}
            className={tab === k ? "selected" : ""}
            onClick={() => {
              setTab(k);
              setOffset(0);
            }}
          >
            {v}
          </button>
        ))}
      </div>
      <Feedback a={a} />
      {error && <div className="p-alert">{error.message}</div>}
      {tab === "overview" && data && (
        <>
          <div className="p-stats">
            <div>
              <small>平台用户</small>
              <strong>{data.users}</strong>
            </div>
            <div>
              <small>客户订单</small>
              <strong>{data.orders}</strong>
            </div>
            <div>
              <small>已交付账号</small>
              <strong>{data.accounts}</strong>
            </div>
          </div>
          <div className="p-card">
            <h2>执行器状态</h2>
            <p>
              {data.worker &&
              Date.now() - new Date(data.worker.heartbeat).getTime() < 90000
                ? "执行器在线"
                : "执行器离线或正在启动"}
            </p>
            <p className="p-muted">最近心跳：{date(data.worker?.heartbeat)}</p>
            {data.worker?.error && (
              <div className="p-alert">{data.worker.error}</div>
            )}
            <p>
              资源配置在原管理台维护；用户下单使用本站点设置中的注册模板。关闭接单只阻止新订单，关闭队列领取会让当前任务完成后暂停。
            </p>
            <button className="p-button" onClick={() => setTab("settings")}>
              配置价格与接单规则
            </button>
          </div>
        </>
      )}
      {tab === "orders" && (
        <section className="p-card">
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
        <section className="p-card">
          <Table
            rows={rows}
            columns={[
              {
                title: "用户",
                render: (r) => (
                  <>
                    <b>{r.name}</b>
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
            <Table
              rows={rows}
              columns={[
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
      {tab === "settings" && settings && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const s = structuredClone(settings);
            delete s.smtp.password_configured;
            a.run(
              () => call("/api/admin/v1/settings", "PATCH", s),
              "站点设置已保存",
            );
          }}
        >
          <section className="p-card">
            <h2>站点与开放策略</h2>
            <div className="p-form-grid">
              <label>
                站点名称
                <input
                  required
                  maxLength={80}
                  value={settings.site_name}
                  onChange={(e) => field("site_name", e.target.value)}
                />
              </label>
              <label>
                允许注册的邮箱域名
                <input
                  value={settings.email_domains.join(", ")}
                  onChange={(e) =>
                    field(
                      "email_domains",
                      e.target.value
                        .split(",")
                        .map((x) => x.trim())
                        .filter(Boolean),
                    )
                  }
                  placeholder="留空不限制，多个域名用逗号分隔"
                />
              </label>
            </div>
            <label>
              站点公告
              <textarea
                maxLength={5000}
                value={settings.announcement}
                onChange={(e) => field("announcement", e.target.value)}
              />
            </label>
            <div className="p-checks">
              {Object.entries({
                registration_open: "开放用户注册",
                email_verify_enabled: "注册需要邮箱验证码",
                orders_open: "开放新订单",
                api_enabled: "开放外部 API",
                worker_enabled: "允许队列领取任务",
              }).map(([k, v]) => (
                <label key={k}>
                  <input
                    type="checkbox"
                    checked={settings[k]}
                    onChange={(e) => field(k, e.target.checked)}
                  />
                  {v}
                </label>
              ))}
            </div>
          </section>
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
                    onChange={(e) => field(String(key), Number(e.target.value))}
                  />
                </label>
              ))}
            </div>
            <p className="p-muted">
              下单锁定单价。改价只影响后续新订单；失败与取消的未交付部分退回预留积分。
            </p>
          </section>
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
                              ? { mailProvider: settings.template.mailProvider }
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
          <section className="p-card">
            <h2>邮件服务 SMTP</h2>
            <p className="p-muted">用于邮箱验证码与找回密码，保存后生效。</p>
            <div className="p-form-grid">
              {[
                ["host", "SMTP 主机", "text"],
                ["port", "端口", "number"],
                ["user", "SMTP 用户名", "text"],
                ["password", "SMTP 密码", "password"],
                ["from", "发件人邮箱", "email"],
              ].map(([k, label, type]) => (
                <label key={k}>
                  {label}
                  <input
                    type={type}
                    value={settings.smtp[k] || ""}
                    placeholder={
                      k === "password" && settings.smtp.password_configured
                        ? "已配置，留空保持原值"
                        : ""
                    }
                    autoComplete={k === "password" ? "new-password" : "off"}
                    onChange={(e) =>
                      field("smtp", {
                        ...settings.smtp,
                        [k]:
                          k === "port"
                            ? Number(e.target.value)
                            : e.target.value,
                      })
                    }
                  />
                </label>
              ))}
            </div>
            <label className="p-check">
              <input
                type="checkbox"
                checked={settings.smtp.secure}
                onChange={(e) =>
                  field("smtp", { ...settings.smtp, secure: e.target.checked })
                }
              />
              使用隐式 TLS（通常端口 465；587 使用 STARTTLS）
            </label>
          </section>
          <div className="p-save-bar">
            <button className="p-button" disabled={a.busy}>
              {a.busy ? "保存中…" : "保存全部设置"}
            </button>
          </div>
        </form>
      )}
      {tab === "audit" && (
        <section className="p-card">
          <Table
            rows={rows}
            columns={[
              { title: "操作", render: (r) => r.action },
              { title: "执行用户", render: (r) => r.actor_id || "系统" },
              { title: "目标", render: (r) => r.target || "—" },
              { title: "说明", render: (r) => r.detail || "—" },
              { title: "时间", render: (r) => date(r.created_at) },
            ]}
          />
        </section>
      )}
      {["users", "orders", "codes", "audit"].includes(tab) && (
        <div className="p-pagination">
          <button
            className="p-button secondary"
            disabled={!offset}
            onClick={() => setOffset(Math.max(0, offset - 50))}
          >
            上一页
          </button>
          <span>第 {offset / 50 + 1} 页</span>
          <button
            className="p-button secondary"
            disabled={rows.length < 50}
            onClick={() => setOffset(offset + 50)}
          >
            下一页
          </button>
        </div>
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
