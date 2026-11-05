"use strict";
const { BlockList, isIP } = require("node:net");
const { fail, integer } = require("./security");
const ruleNames = {
  login: "登录尝试",
  redeem: "兑换积分",
  submit: "提交注册订单",
  query: "查询与轮询",
  export: "查看凭据与导出",
  write: "其他业务操作",
  account: "客户总请求量",
  api_key: "单个 API 密钥",
};
const policy = (mode, limit, window_seconds = 60, cooldown_seconds = 60) => ({
  mode,
  limit,
  window_seconds,
  cooldown_seconds,
});
const defaults = {
  enabled: true,
  rules: {
    login: policy("enforce", 10, 900, 900),
    redeem: policy("enforce", 10),
    submit: policy("observe", 20),
    query: policy("observe", 300),
    export: policy("observe", 30),
    write: policy("observe", 60),
    account: policy("observe", 600),
    api_key: policy("observe", 120),
  },
  retention_days: 30,
  refresh_seconds: 15,
  scan_seconds: 60,
  behavior_window_seconds: 900,
  login_source_accounts: 10,
  duplicate_count: 10,
  cancel_count: 10,
  failure_min_count: 5,
  failure_percent: 50,
  queue_count: 100,
  queue_seconds: 600,
  processing_seconds: 1200,
  large_adjustment: 10000,
  finance_checks: true,
  trusted_proxies: [],
};
const ranges = {
  retention_days: [1, 365],
  refresh_seconds: [5, 300],
  scan_seconds: [10, 3600],
  behavior_window_seconds: [60, 86400],
  login_source_accounts: [2, 10000],
  duplicate_count: [1, 10000],
  cancel_count: [1, 10000],
  failure_min_count: [1, 10000],
  failure_percent: [1, 100],
  queue_count: [1, 100000],
  queue_seconds: [60, 604800],
  processing_seconds: [60, 604800],
  large_adjustment: [1, 100000000],
};
function normalizeIP(value) {
  let ip = String(value || "")
    .trim()
    .toLowerCase();
  if (ip.startsWith("::ffff:") && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
  return isIP(ip) ? ip : "";
}
function proxyList(values) {
  fail(Array.isArray(values) && values.length <= 64, "可信代理最多 64 项");
  const block = new BlockList();
  for (const value of values) {
    fail(typeof value === "string" && value.length <= 64, "可信代理地址无效");
    const parts = value.trim().split("/"),
      ip = normalizeIP(parts[0]),
      family = isIP(ip);
    fail(family && parts.length <= 2, "可信代理须为 IP 或明确网段");
    if (parts.length === 2) {
      fail(/^\d+$/.test(parts[1]), "可信代理网段无效");
      const prefix = integer(
        Number(parts[1]),
        1,
        family === 4 ? 32 : 128,
        "可信代理网段",
      );
      block.addSubnet(ip, prefix, family === 4 ? "ipv4" : "ipv6");
    } else block.addAddress(ip, family === 4 ? "ipv4" : "ipv6");
  }
  return block;
}
function source(r, proxies) {
  const peer = normalizeIP(
    r.raw?.socket?.remoteAddress || r.socket?.remoteAddress,
  );
  const trusted = proxyList(proxies);
  const check = (ip) =>
    ip && trusted.check(ip, isIP(ip) === 4 ? "ipv4" : "ipv6");
  const unknown = { source_ip: peer, source_verified: false };
  if (!check(peer)) return unknown;
  const raw = r.headers["x-forwarded-for"];
  if (typeof raw !== "string" || raw.length > 2048) return unknown;
  const chain = raw.split(",");
  if (chain.length > 32) return unknown;
  for (const entry of chain.reverse()) {
    const ip = normalizeIP(entry);
    if (!ip) return unknown;
    if (!check(ip)) return { source_ip: ip, source_verified: true };
  }
  return unknown;
}
function trustedPeer(r, proxies) {
  const peer = normalizeIP(r.raw?.socket?.remoteAddress || r.socket?.remoteAddress);
  return Boolean(peer && proxyList(proxies).check(peer, isIP(peer) === 4 ? "ipv4" : "ipv6"));
}
function validateSettings(v) {
  fail(v && typeof v === "object" && !Array.isArray(v), "风控配置无效");
  fail(
    typeof v.enabled === "boolean" && typeof v.finance_checks === "boolean",
    "风控开关无效",
  );
  const result = {
    enabled: v.enabled,
    finance_checks: v.finance_checks,
    rules: {},
    trusted_proxies: v.trusted_proxies,
  };
  for (const [name, [min, max]] of Object.entries(ranges))
    result[name] = integer(v[name], min, max, name);
  fail(
    v.rules && Object.keys(v.rules).length === Object.keys(ruleNames).length,
    "请完整配置全部风控规则",
  );
  for (const name of Object.keys(ruleNames)) {
    const p = v.rules[name];
    fail(
      p && ["off", "observe", "enforce"].includes(p.mode),
      "规则处理方式无效",
    );
    result.rules[name] = {
      mode: p.mode,
      limit: integer(p.limit, 1, 100000, "规则次数"),
      window_seconds: integer(p.window_seconds, 1, 86400, "统计窗口"),
      cooldown_seconds: integer(p.cooldown_seconds, 1, 86400, "限制时长"),
    };
  }
  proxyList(v.trusted_proxies);
  result.trusted_proxies = v.trusted_proxies.map((x) => x.trim());
  return result;
}
async function settings(db) {
  const row = (
    await db.query(
      "SELECT value,revision FROM platform_risk_settings WHERE id=1",
    )
  ).rows[0];
  return {
    ...structuredClone(defaults),
    ...row.value,
    rules: { ...structuredClone(defaults.rules), ...row.value.rules },
    revision: row.revision,
  };
}
module.exports = {
  defaults,
  ruleNames,
  ranges,
  settings,
  validateSettings,
  normalizeIP,
  source,
  trustedPeer,
};
