"use strict";
const { fail } = require("./security");
const { audit } = require("./db");
const { defaults, ruleNames, settings, source } = require("./risk-config");
const {
  consume,
  record,
  saveSettings,
  customer,
  saveCustomer,
} = require("./risk-store");
const { monitor } = require("./risk-reports");
const { scan } = require("./risk-scan");
function operation(path, method) {
  if (path.startsWith("/api/admin/v1/risk/")) return "risk";
  if (path.startsWith("/api/admin/")) return "admin";
  if (path === "/api/auth/login") return "login";
  if (path === "/api/auth/logout") return "logout";
  if (path.startsWith("/api/auth/")) return "auth";
  if (path.endsWith("/registration-orders") && method === "POST")
    return "submit";
  if (/\/registration-orders\/[^/]+\/cancel$/.test(path)) return "cancel";
  if (path.endsWith("/redeem")) return "redeem";
  if (
    path.endsWith("/accounts/export") ||
    /\/accounts\/[^/]+\/credentials$/.test(path)
  )
    return "export";
  if (/\/keys(?:\/|$)/.test(path)) return "keys";
  return method === "GET" ? "query" : "write";
}
function registerRisk(app, db) {
  app.addHook("onRequest", async (r) => {
    let path;
    try {
      path = decodeURIComponent(new URL(r.url, "http://local").pathname);
    } catch {
      fail(false, "请求路径无效", 400);
    }
    if (!/^\/(?:api\/(?:auth|user|admin)\/|open\/v1\/)/.test(path)) return;
    const cfg = await settings(db);
    r.risk = {
      cfg,
      path,
      method: r.method,
      operation: operation(path, r.method),
      channel: path.startsWith("/open/") ? "api" : "web",
      started: performance.now(),
      ...source(r, cfg.trusted_proxies),
    };
  });
  app.addHook("preHandler", async (r, reply) => {
    const m = r.risk;
    if (!m) return;
    let login;
    if (m.operation === "login") {
      const raw = String(r.body?.email || "")
        .trim()
        .toLowerCase();
      login =
        raw.length <= 254 &&
        (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ||
          /^[a-z0-9_.-]{1,80}$/.test(raw))
          ? raw
          : "无效登录账号";
      m.account = login;
    } else {
      if (!r.user || m.operation === "logout") return;
      m.user_id = r.user.id;
      m.key_id = r.user.key_id || "";
      m.account = r.user.email;
      // Authenticated administrators can always reach recovery controls and the console.
      if (
        r.user.role === "admin" &&
        (m.path.startsWith("/api/admin/") ||
          ["/api/user/v1/me", "/api/user/v1/navigation"].includes(m.path))
      )
        return;
    }
    const decisions = await consume(db, m, r.user, login);
    for (const d of decisions) {
      if (d.blocked) {
        m.kind = "rate_blocked";
        m.rule = d.rule;
        reply.header("Retry-After", String(d.retry_seconds));
        fail(false, `访问过于频繁，请 ${d.retry_seconds} 秒后重试`, 429);
      }
      m.observed = d.rule;
    }
  });
  app.addHook("onError", async (r, _reply, e) => {
    if (r.risk && e.riskKind) r.risk.kind = e.riskKind;
  });
  app.addHook("onResponse", async (r, reply) => {
    const m = r.risk;
    if (!m) return;
    if (r.user) {
      m.user_id = r.user.id;
      m.key_id = r.user.key_id || "";
      m.account = r.user.email;
    }
    m.status = reply.statusCode;
    m.duration_ms = Math.max(0, Math.round(performance.now() - m.started));
    try {
      await record(db, m);
    } catch {
      console.error("Risk telemetry unavailable");
    }
  });
  let timer, pending;
  const run = () => {
    if (!pending)
      pending = scan(db)
        .catch(() => console.error("Risk scan unavailable"))
        .finally(() => {
          pending = null;
        });
  };
  app.addHook("onReady", async () => {
    timer = setInterval(run, 5000);
    timer.unref();
  });
  app.addHook("onClose", async () => {
    clearInterval(timer);
    if (pending) await pending;
  });
  const prefix = "/api/admin/v1/risk";
  // These routes also have the platform's session, admin-role and CSRF checks.
  app.get(`${prefix}/settings`, async () => ({
    settings: await settings(db),
    defaults,
    rule_names: ruleNames,
  }));
  app.put(`${prefix}/settings`, async (r) => {
    await saveSettings(db, r.user.id, r.body);
    return { ok: true };
  });
  app.get(`${prefix}/monitor`, async (r) => monitor(db, r.query));
  app.post(`${prefix}/scan`, async () => {
    await scan(db, true);
    return { ok: true };
  });
  app.get(`${prefix}/customers/:id`, async (r) => customer(db, r.params.id));
  app.put(`${prefix}/customers/:id`, async (r) => {
    await saveCustomer(db, r.user.id, r.params.id, r.body);
    return { ok: true };
  });
  app.post(`${prefix}/events/:id/resolve`, async (r) => {
    fail(/^\d{1,18}$/.test(r.params.id), "事件编号无效");
    await db.tx(async (q) => {
      const row = await q.query(
        "UPDATE platform_risk_events SET resolved_at=coalesce(resolved_at,now()),resolved_by=coalesce(resolved_by,$2) WHERE id=$1 RETURNING id",
        [r.params.id, r.user.id],
      );
      fail(row.rowCount, "事件不存在", 404);
      await audit(q, r.user.id, "risk.resolve", r.params.id);
    });
    return { ok: true };
  });
  app.post(`${prefix}/limits/:id/release`, async (r) => {
    await db.tx(async (q) => {
      fail(
        (
          await q.query(
            "DELETE FROM platform_risk_buckets WHERE id=$1 RETURNING id",
            [r.params.id],
          )
        ).rowCount,
        "限制已解除或不存在",
        404,
      );
      await audit(q, r.user.id, "risk.release", r.params.id);
    });
    return { ok: true };
  });
  app.post(`${prefix}/keys/:id/revoke`, async (r) => {
    await db.tx(async (q) => {
      fail(
        (
          await q.query(
            "UPDATE platform_api_keys SET revoked=true WHERE id=$1 RETURNING id",
            [r.params.id],
          )
        ).rowCount,
        "密钥不存在",
        404,
      );
      await audit(q, r.user.id, "risk.key_revoke", r.params.id);
    });
    return { ok: true };
  });
}
module.exports = { registerRisk, operation };
