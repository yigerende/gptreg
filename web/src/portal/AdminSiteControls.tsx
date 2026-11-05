import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowUp,
  ArrowDown,
  Plus,
  Trash2,
  Globe2,
  Mail,
  ShieldCheck,
  SlidersHorizontal,
  RefreshCw,
} from "lucide-react";
import { call, date, uid, type Row } from "./client";
import { Feedback, Table, useAction } from "./Workspace";
import { Pagination } from "./Insights";
export const featureLabels: Row = {
  home: ["工作台", "客户概览、服务介绍与快捷入口"],
  register: ["注册服务", "选择模式与数量，创建注册订单"],
  orders: ["订单中心", "查询订单进度和详情"],
  accounts: ["账号交付", "查看、领取和导出已交付的账号凭据"],
  wallet: ["资金账户", "查询积分、账本及兑换充值"],
  keys: ["开发接入", "创建 API Key 并通过 API 调用服务"],
  docs: ["接口文档", "查看 API 文档与 OpenAPI 定义"],
};
export default function AdminSiteControls({
  tab,
  settings: s,
  field,
}: {
  tab: string;
  settings: Row;
  field: (key: string, value: any) => void;
}) {
  const title: Row = {
    features: "功能开关",
    security: "安全与认证",
    mail: "邮件设置",
    custom_menus: "自定义菜单",
  };
  const icons: Row = {
    features: SlidersHorizontal,
    security: ShieldCheck,
    mail: Mail,
    custom_menus: Globe2,
  };
  const Icon = icons[tab] || SlidersHorizontal;
  function toggle(key: string, label: string, description: string) {
    return (
      <label className="p-control-row" key={key}>
        <span>
          <b>{label}</b>
          <small>{description}</small>
        </span>
        <input
          className="p-toggle"
          type="checkbox"
          aria-label={label}
          checked={s[key]}
          onChange={(e) => field(key, e.target.checked)}
        />
      </label>
    );
  }
  const menus: Row[] = s.custom_menus || [];
  const updateMenu = (i: number, change: Row) =>
    field(
      "custom_menus",
      menus.map((m, n) => (n === i ? { ...m, ...change } : m)),
    );
  function move(i: number, step: number) {
    const next = [...menus];
    [next[i], next[i + step]] = [next[i + step], next[i]];
    field("custom_menus", next);
  }
  const [fileError, setFileError] = useState("");
  async function iconUpload(i: number, file?: File) {
    if (!file) return;
    setFileError("");
    if (file.type !== "image/svg+xml" || file.size > 20480) {
      setFileError("请选择 20 KB 以内的静态 SVG。");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => updateMenu(i, { icon: String(reader.result) });
    reader.onerror = () => setFileError("图标读取失败");
    reader.readAsDataURL(file);
  }
  return (
    <section className="p-card p-controls">
      <div className="p-control-heading">
        <Icon size={24} />
        <div>
          <h2>{title[tab]}</h2>
          <p className="p-muted">
            {tab === "features"
              ? "选择用户可以使用的服务，保存后立即生效。"
              : tab === "security"
                ? "管理自主注册与邮箱身份验证。"
                : tab === "mail"
                  ? "连接邮件服务，用于注册验证码和找回密码。"
                  : "扩展工作台侧栏，按角色展示并自由调整顺序。"}
          </p>
        </div>
      </div>
      {tab === "features" && (
        <>
          <div className="p-inline-help">
            关闭功能后用户菜单隐藏，对应接口也会拒绝访问。管理员权限不受影响，已受理任务继续完成。
          </div>
          <div className="p-feature-grid">
            {Object.entries(featureLabels).map(
              ([key, [label, description]]) => (
                <label className="p-control-row" key={key}>
                  <span>
                    <b>{label}</b>
                    <small>{description}</small>
                  </span>
                  <input
                    className="p-toggle"
                    type="checkbox"
                    aria-label={label}
                    checked={s.features?.[key] !== false}
                    onChange={(e) =>
                      field("features", {
                        ...s.features,
                        [key]: e.target.checked,
                      })
                    }
                  />
                </label>
              ),
            )}
          </div>
          <h3>接单与开放策略</h3>
          {toggle(
            "orders_open",
            "开放新订单",
            "关闭后暂停新订单受理，已有订单继续执行。",
          )}
          {toggle(
            "worker_enabled",
            "允许队列领取任务",
            "关闭后暂停领取后续任务，当前任务继续执行。",
          )}
          {toggle(
            "api_enabled",
            "开放外部 API",
            "关闭后所有 API Key 暂停调用，网页服务不受影响。",
          )}
        </>
      )}
      {tab === "security" && (
        <>
          {toggle(
            "registration_open",
            "开放用户注册",
            "允许访客创建自己的用户账户。",
          )}
          {toggle(
            "email_verify_enabled",
            "注册需要邮箱验证码",
            "开启前请保存邮件配置并确认能够正常发信。",
          )}
          <label>
            邮箱域名白名单
            <textarea
              rows={6}
              value={s.email_domains.join("\n")}
              onChange={(e) =>
                field(
                  "email_domains",
                  e.target.value.split(/[\s,，]+/).filter(Boolean),
                )
              }
              placeholder={"qq.com\ngmail.com"}
            />
            <small className="p-muted">
              留空允许所有邮箱，支持换行、逗号或空格分隔。仅限制新用户注册。
            </small>
          </label>
          <div className="p-inline-help">
            登录密码为 10～72
            位。已登录用户可在个人设置中修改密码；配置邮件服务后支持找回密码。
          </div>
        </>
      )}
      {tab === "custom_menus" && (
        <>
          {fileError && <div className="p-alert">{fileError}</div>}
          {!menus.length && (
            <div className="p-empty">
              还没有自定义菜单，添加帮助中心、充值入口或其他服务页面。
            </div>
          )}
          {menus.map((m, i) => (
            <article className="p-menu-editor-card" key={m.id}>
              <div className="p-section-heading">
                <b>
                  菜单 {i + 1}
                  {m.label && ` · ${m.label}`}
                </b>
                <div className="p-inline">
                  <button
                    className="p-header-icon"
                    type="button"
                    aria-label={`上移菜单 ${i + 1}`}
                    disabled={i === 0}
                    onClick={() => move(i, -1)}
                  >
                    <ArrowUp size={17} />
                  </button>
                  <button
                    className="p-header-icon"
                    type="button"
                    aria-label={`下移菜单 ${i + 1}`}
                    disabled={i === menus.length - 1}
                    onClick={() => move(i, 1)}
                  >
                    <ArrowDown size={17} />
                  </button>
                  <button
                    className="p-header-icon danger"
                    type="button"
                    aria-label={`删除菜单 ${i + 1}`}
                    onClick={() =>
                      field(
                        "custom_menus",
                        menus.filter((_, n) => n !== i),
                      )
                    }
                  >
                    <Trash2 size={17} />
                  </button>
                </div>
              </div>
              <div className="p-form-grid">
                <label>
                  菜单名称
                  <input
                    required
                    maxLength={60}
                    value={m.label}
                    onChange={(e) => updateMenu(i, { label: e.target.value })}
                  />
                </label>
                <label>
                  可见角色
                  <select
                    value={m.visibility}
                    onChange={(e) =>
                      updateMenu(i, { visibility: e.target.value })
                    }
                  >
                    <option value="user">普通用户</option>
                    <option value="admin">管理员</option>
                    <option value="all">所有登录用户</option>
                  </select>
                </label>
              </div>
              <label>
                页面 URL
                <input
                  type="url"
                  required
                  maxLength={2048}
                  value={m.url}
                  placeholder="https://example.com/help"
                  onChange={(e) => updateMenu(i, { url: e.target.value })}
                />
              </label>
              <div className="p-checks">
                {[
                  ["enabled", "启用菜单"],
                  ["open_new_tab", "新窗口打开"],
                  ...(!m.open_new_tab
                    ? [["hide_open_button", "隐藏页面中的新窗口按钮"]]
                    : []),
                ].map(([key, label]) => (
                  <label key={key}>
                    <input
                      type="checkbox"
                      checked={m[key]}
                      onChange={(e) =>
                        updateMenu(i, { [key]: e.target.checked })
                      }
                    />
                    {label}
                  </label>
                ))}
              </div>
              <div className="p-menu-icon">
                <span>
                  {m.icon ? (
                    <img src={m.icon} alt="菜单图标预览" />
                  ) : (
                    <Globe2 size={23} />
                  )}
                </span>
                <label>
                  SVG 图标
                  <input
                    type="file"
                    accept="image/svg+xml"
                    onChange={(e) => {
                      void iconUpload(i, e.target.files?.[0]);
                      e.target.value = "";
                    }}
                  />
                </label>
                {m.icon && (
                  <button
                    className="p-link"
                    type="button"
                    onClick={() => updateMenu(i, { icon: "" })}
                  >
                    清除图标
                  </button>
                )}
              </div>
            </article>
          ))}
          <button
            type="button"
            className="p-button secondary"
            disabled={menus.length >= 30}
            onClick={() =>
              field("custom_menus", [
                ...menus,
                {
                  id: uid(),
                  label: "",
                  url: "",
                  visibility: "user",
                  icon: "",
                  enabled: true,
                  open_new_tab: true,
                  hide_open_button: false,
                },
              ])
            }
          >
            <Plus size={16} />
            添加菜单
          </button>
          <p className="p-muted p-fine">
            最多 30
            个，按列表顺序展示。站内打开需目标网站允许嵌入，否则请选择新窗口打开。
          </p>
        </>
      )}
      {tab === "mail" && (
        <>
          <div className="p-form-grid">
            {[
              ["host", "SMTP 主机", "text"],
              ["port", "端口", "number"],
              ["user", "SMTP 用户名", "text"],
              ["password", "SMTP 授权码 / 密码", "password"],
              ["from", "发件人邮箱", "email"],
            ].map(([key, label, type]) => (
              <label key={key}>
                {label}
                <input
                  type={type}
                  value={s.smtp[key] || ""}
                  autoComplete={key === "password" ? "new-password" : "off"}
                  placeholder={
                    key === "password" && s.smtp.password_configured
                      ? "已配置，留空保留原授权码"
                      : ""
                  }
                  onChange={(e) =>
                    field("smtp", {
                      ...s.smtp,
                      [key]:
                        key === "port"
                          ? Number(e.target.value)
                          : e.target.value,
                    })
                  }
                />
              </label>
            ))}
            <label>
              连接加密
              <select
                value={s.smtp.secure ? "ssl" : "starttls"}
                onChange={(e) =>
                  field("smtp", { ...s.smtp, secure: e.target.value === "ssl" })
                }
              >
                <option value="ssl">SSL/TLS（通常 465）</option>
                <option value="starttls">STARTTLS（通常 587）</option>
              </select>
            </label>
          </div>
          <p className="p-muted">
            授权码加密保存，不回显原值。修改后请先保存，再测试发送。
          </p>
          <MailTools ready={Boolean(s.smtp.host && s.smtp.from)} />
        </>
      )}
    </section>
  );
}
function MailTools({ ready }: { ready: boolean }) {
  const [email, setEmail] = useState(""),
    [offset, setOffset] = useState(0),
    a = useAction();
  const { data, error, refetch, isFetching } = useQuery({
    queryKey: ["mail-logs", offset],
    queryFn: () => call(`/api/admin/v1/mail/logs?offset=${offset}`),
  });
  return (
    <>
      <div className="p-mail-tools">
        <h3>测试发送</h3>
        <p className="p-muted">使用已保存配置发送一封测试邮件。</p>
        <div className="p-inline">
          <input
            type="email"
            aria-label="测试收件邮箱"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="你的收件邮箱"
          />
          <button
            type="button"
            className="p-button secondary"
            disabled={a.busy || !ready || !email}
            onClick={() =>
              a.run(
                () => call("/api/admin/v1/mail/test", "POST", { email }),
                "邮件服务器已接受测试邮件",
              )
            }
          >
            {a.busy ? "发送中…" : "发送测试邮件"}
          </button>
        </div>
        <Feedback a={a} />
      </div>
      <div className="p-mail-tools">
        <div className="p-section-heading">
          <h3>发送记录</h3>
          <button
            type="button"
            className="p-header-icon"
            aria-label="刷新发送记录"
            disabled={isFetching}
            onClick={() => refetch()}
          >
            <RefreshCw size={17} />
          </button>
        </div>
        <p className="p-muted p-fine">
          保留最近 90
          天记录，不保存验证码或邮件正文。已发送表示邮件服务器已接受。
        </p>
        {error && <div className="p-alert">{error.message}</div>}
        <Table
          rows={data?.items || []}
          columns={[
            { title: "时间", render: (r) => date(r.created_at) },
            { title: "收件邮箱", render: (r) => r.recipient },
            {
              title: "用途",
              render: (r) =>
                (
                  ({
                    test: "测试邮件",
                    register: "注册验证",
                    reset: "找回密码",
                  }) as Row
                )[r.purpose],
            },
            {
              title: "状态",
              render: (r) =>
                (
                  ({
                    sent: "已发送",
                    failed: "发送失败",
                    pending: "发送中",
                  }) as Row
                )[r.status],
            },
            { title: "说明", render: (r) => r.detail },
          ]}
        />
        <Pagination
          offset={offset}
          total={data?.total}
          count={data?.items?.length || 0}
          onChange={setOffset}
        />
      </div>
    </>
  );
}
