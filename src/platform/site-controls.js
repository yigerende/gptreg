"use strict";
const { fail } = require("./security");
const { validateIcon } = require("./branding");
const features = {
  home: true,
  register: true,
  orders: true,
  accounts: true,
  wallet: true,
  keys: true,
  docs: true,
};
function validateControls(s) {
  s.features = { ...features, ...s.features };
  fail(
    Object.keys(s.features).every(
      (k) => Object.hasOwn(features, k) && typeof s.features[k] === "boolean",
    ),
    "功能开关格式错误",
  );
  fail(
    Array.isArray(s.custom_menus) && s.custom_menus.length <= 30,
    "最多配置 30 个菜单",
  );
  const ids = new Set();
  s.custom_menus = s.custom_menus.map((m) => {
    fail(
      m && /^[a-zA-Z0-9-]{1,80}$/.test(m.id) && !ids.has(m.id),
      "菜单标识无效或重复",
    );
    ids.add(m.id);
    fail(
      typeof m.label === "string" &&
        m.label.trim().length > 0 &&
        m.label.length <= 60,
      "请填写菜单名称",
    );
    let u;
    try {
      u = new URL(m.url);
    } catch {}
    fail(
      typeof m.url === "string" &&
        m.url.length <= 2048 &&
        u &&
        ["http:", "https:"].includes(u.protocol) &&
        !u.username &&
        !u.password,
      "菜单须为有效的 HTTP/HTTPS 地址",
    );
    fail(["user", "admin", "all"].includes(m.visibility), "菜单可见角色无效");
    for (const k of ["enabled", "open_new_tab", "hide_open_button"])
      fail(typeof m[k] === "boolean", "菜单开关无效");
    return {
      id: m.id,
      label: m.label.trim(),
      url: u.href,
      visibility: m.visibility,
      enabled: m.enabled,
      open_new_tab: m.open_new_tab,
      hide_open_button: m.hide_open_button,
      icon: validateIcon(m.icon || ""),
    };
  });
  fail(
    Array.isArray(s.announcements) && s.announcements.length <= 50,
    "最多配置 50 条公告",
  );
  const noticeIds = new Set();
  s.announcements = s.announcements.map((a) => {
    fail(
      a && /^[a-zA-Z0-9-]{1,80}$/.test(a.id) && !noticeIds.has(a.id),
      "公告标识无效或重复",
    );
    noticeIds.add(a.id);
    fail(
      typeof a.title === "string" &&
        a.title.trim().length > 0 &&
        a.title.length <= 120 &&
        typeof a.body === "string" &&
        a.body.length <= 5000,
      "公告标题或内容无效",
    );
    fail(typeof a.enabled === "boolean", "公告状态无效");
    for (const k of ["starts_at", "ends_at"])
      fail(
        !a[k] ||
          (typeof a[k] === "string" && Number.isFinite(Date.parse(a[k]))),
        "公告时间无效",
      );
    fail(
      !a.starts_at ||
        !a.ends_at ||
        Date.parse(a.starts_at) < Date.parse(a.ends_at),
      "下线时间须晚于上线时间",
    );
    return {
      id: a.id,
      title: a.title.trim(),
      body: a.body,
      enabled: a.enabled,
      starts_at: a.starts_at || "",
      ends_at: a.ends_at || "",
    };
  });
}
function activeAnnouncements(s, now = Date.now()) {
  return (s.announcements || [])
    .filter(
      (a) =>
        a.enabled &&
        (!a.starts_at || Date.parse(a.starts_at) <= now) &&
        (!a.ends_at || Date.parse(a.ends_at) > now),
    )
    .map(({ id, title, body }) => ({ id, title, body }));
}
function visibleMenus(s, role) {
  return (s.custom_menus || []).filter(
    (m) =>
      m.enabled &&
      (m.visibility === "all" ||
        m.visibility === (role === "admin" ? "admin" : "user")),
  );
}
function requestFeature(path, method) {
  if (path === "/docs" || path === "/openapi.json") return "docs";
  const p = path.replace(/^\/(api\/user|open)\/v1/, "");
  if (p === "/overview") return "home";
  if (p === "/products" || p === "/registration-regions" || (p === "/registration-orders" && method === "POST"))
    return "register";
  if (p.startsWith("/registration-orders")) return "orders";
  if (p.startsWith("/accounts") || p === "/account-orders") return "accounts";
  if (["/ledger", "/redeem", "/wallet"].includes(p)) return "wallet";
  if (p.startsWith("/keys")) return "keys";
  return null;
}
module.exports = {
  features,
  validateControls,
  activeAnnouncements,
  visibleMenus,
  requestFeature,
};
