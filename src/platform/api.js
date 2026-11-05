"use strict";
const {
  id,
  token,
  digest,
  fail,
  integer,
  passwordHash,
} = require("./security");
const { audit } = require("./db");
const { validateBrand } = require("./branding");
const { ledger } = require("./orders");
const { userView } = require("./auth");
const { totpCode } = require("../chatgpt-session-runner");
const {
  registerReports,
  listOrders,
  listAccounts,
  listLedger,
  search,
  option,
} = require("./reports");
const paging = (r) => ({
  limit: integer(Number(r.query.limit || 50), 1, 100, "limit"),
  offset: integer(Number(r.query.offset || 0), 0, 1000000, "offset"),
});
const { validateControls, visibleMenus } = require("./site-controls");
const { registerMail } = require("./mail");
const { registerAdminAccounts } = require("./admin-accounts");
const { registerRedeemCodes } = require("./redeem-codes");
const { registerCustomerCenter } = require("./customer-center");
function registerApi(app, db, orders, crypt) {
  registerMail(app, db, crypt);
  registerAdminAccounts(app, db, crypt);
  registerCustomerCenter(app, db);
  registerRedeemCodes(app, db, crypt);
  app.get("/api/user/v1/navigation", async (r) => ({
    items: visibleMenus(await db.settings(), r.user.role),
  }));
  registerReports(app, db);
  const scope = (r, s) => {
    if (r.user.scopes)
      fail(r.user.scopes.includes(s), `API Key 缺少 ${s} 权限`, 403);
  };
  for (const prefix of ["/api/user/v1", "/open/v1"]) {
    app.get(`${prefix}/products`, async () => {
      const s = await db.settings();
      return {
        orders_open: s.orders_open,
        max_quantity: s.max_quantity,
        currency: "points",
        products: [
          { need_oauth: false, unit_price: s.price_standard, name: "标准账号" },
          { need_oauth: true, unit_price: s.price_oauth, name: "OAuth 账号" },
        ],
      };
    });
    if (prefix === "/open/v1")
      app.get(`${prefix}/me`, async (r) => userView(r.user));
    app.post(`${prefix}/registration-orders`, async (r, reply) => {
      scope(r, "orders:write");
      fail(await db.limit(`orders:${r.user.id}`, 20), "下单过于频繁", 429);
      const result = await orders.create(
        r.user,
        r.body,
        r.headers["idempotency-key"],
        prefix === "/open/v1" ? "api" : "web",
      );
      reply.code(result.replayed ? 200 : 202);
      return result.order;
    });
    app.get(`${prefix}/registration-orders`, async (r) => {
      scope(r, "orders:read");
      return listOrders(db, r.user.id, r.query);
    });
    app.get(`${prefix}/registration-orders/:id`, async (r) => {
      scope(r, "orders:read");
      return orders.detail(r.user.id, r.params.id);
    });
    app.post(`${prefix}/registration-orders/:id/cancel`, async (r) => {
      scope(r, "orders:write");
      return orders.cancel(r.user.id, r.params.id);
    });
    app.get(`${prefix}/accounts`, async (r) => {
      scope(r, "accounts:read");
      return listAccounts(db, r.user.id, r.query);
    });
    app.get(`${prefix}/accounts/:id/credentials`, async (r) => {
      scope(r, "credentials:read");
      const c = await orders.reveal(r.user.id, r.params.id);
      return {
        ...c,
        totp_code: totpCode(c.totp_secret),
        totp_expires_in: 30 - (Math.floor(Date.now() / 1000) % 30),
      };
    });
    app.post(`${prefix}/accounts/export`, async (r) => {
      scope(r, "credentials:read");
      const v = r.body || {};
      fail(
        Array.isArray(v.ids) &&
          v.ids.length > 0 &&
          v.ids.length <= 100 &&
          v.ids.every((x) => typeof x === "string"),
        "一次选择 1～100 个账号",
      );
      fail(
        ["txt", "json", "csv"].includes(v.format || "txt"),
        "导出格式须为 txt、csv 或 json",
      );
      const rows = (
        await db.query(
          "SELECT * FROM platform_accounts WHERE user_id=$1 AND id=ANY($2::text[])",
          [r.user.id, [...new Set(v.ids)]],
        )
      ).rows;
      fail(
        rows.length === new Set(v.ids).size,
        "部分账号不存在或无权访问",
        404,
      );
      const values = rows.map((x) => crypt.decrypt(x.credentials));
      const csvCell = (value) => '"' + String(value).replace(/"/g, '""') + '"';
      await audit(db, r.user.id, "accounts.export", "", String(rows.length));
      return {
        filename: `gptreg-accounts.${v.format || "txt"}`,
        content:
          v.format === "json"
            ? JSON.stringify(values, null, 2)
            : v.format === "csv"
              ? "\uFEFFemail,password,totp_secret\r\n" +
                values
                  .map((c) =>
                    [c.email, c.password, c.totp_secret].map(csvCell).join(","),
                  )
                  .join("\r\n") +
                "\r\n"
              : values
                  .map((c) => `${c.email}----${c.password}----${c.totp_secret}`)
                  .join("\n") + "\n",
      };
    });
  }
  app.get("/api/user/v1/ledger", async (r) => {
    return listLedger(db, r.user.id, r.query);
  });
  app.post("/api/user/v1/redeem", async (r) => {
    fail(await db.limit(`redeem:${r.user.id}`, 10), "兑换尝试过多", 429);
    const code = String(r.body?.code || "").trim();
    fail(code.length >= 20 && code.length <= 100, "兑换码无效");
    return db.tx(async (q) => {
      await q.query("SELECT id FROM platform_users WHERE id=$1 FOR UPDATE", [
        r.user.id,
      ]);
      const c = (
        await q.query(
          "SELECT * FROM platform_redeem_codes WHERE hash=$1 FOR UPDATE",
          [digest(code)],
        )
      ).rows[0];
      fail(
        c &&
          !c.disabled &&
          !c.redeemed_by &&
          (!c.expires_at || new Date(c.expires_at).getTime() > Date.now()),
        "兑换码无效、停用、已过期或已使用",
      );
      await ledger(
        q,
        r.user.id,
        `redeem:${c.id}`,
        "redeem",
        c.points,
        0,
        "兑换码充值",
      );
      await q.query(
        "UPDATE platform_redeem_codes SET redeemed_by=$2,redeemed_at=now() WHERE id=$1",
        [c.id, r.user.id],
      );
      return { points: c.points };
    });
  });
  app.get("/api/user/v1/keys", async (r) => ({
    items: (
      await db.query(
        "SELECT id,name,prefix,scopes,revoked,created_at FROM platform_api_keys WHERE user_id=$1 ORDER BY created_at DESC",
        [r.user.id],
      )
    ).rows,
  }));
  app.post("/api/user/v1/keys", async (r) => {
    const name = String(r.body?.name || "").trim(),
      scopes = r.body?.scopes;
    fail(name.length >= 1 && name.length <= 80, "请填写密钥名称");
    fail(
      Array.isArray(scopes) &&
        scopes.length > 0 &&
        scopes.every((s) =>
          [
            "orders:read",
            "orders:write",
            "accounts:read",
            "credentials:read",
          ].includes(s),
        ),
      "请选择有效权限",
    );
    const key = `gr_${token()}`,
      keyId = id();
    await db.tx(async (q) => {
      await q.query("SELECT id FROM platform_users WHERE id=$1 FOR UPDATE", [
        r.user.id,
      ]);
      const count = (
        await q.query(
          "SELECT count(*)::int AS n FROM platform_api_keys WHERE user_id=$1 AND NOT revoked",
          [r.user.id],
        )
      ).rows[0].n;
      fail(count < 20, "最多保留 20 个有效密钥");
      await q.query(
        "INSERT INTO platform_api_keys(id,user_id,name,hash,prefix,scopes) VALUES($1,$2,$3,$4,$5,$6)",
        [
          keyId,
          r.user.id,
          name,
          digest(key),
          key.slice(0, 11),
          JSON.stringify(scopes),
        ],
      );
      await audit(q, r.user.id, "key.create", keyId);
    });
    return { id: keyId, key };
  });
  app.delete("/api/user/v1/keys/:id", async (r) => {
    await db.query(
      "UPDATE platform_api_keys SET revoked=true WHERE id=$1 AND user_id=$2",
      [r.params.id, r.user.id],
    );
    return { ok: true };
  });
  app.get("/api/admin/v1/settings", async () => {
    const s = await db.settings();
    return {
      ...s,
      smtp: {
        ...s.smtp,
        password: "",
        password_configured: Boolean(s.smtp.password),
      },
    };
  });
  app.patch("/api/admin/v1/settings", async (r) => {
    const v = r.body || {},
      allowed = [
        "site_name",
        "brand",
        "announcement",
        "announcements",
        "custom_menus",
        "features",
        "registration_open",
        "email_verify_enabled",
        "email_domains",
        "orders_open",
        "api_enabled",
        "worker_enabled",
        "price_standard",
        "price_oauth",
        "max_quantity",
        "registration_concurrency",
        "user_registration_concurrency",
        "max_open_orders",
        "attempt_limit",
        "timeout_minutes",
        "template",
        "smtp",
      ];
    fail(
      Object.keys(v).every((x) => allowed.includes(x)),
      "存在不支持的设置",
    );
    return db.tx(async (q) => {
      const old = (
          await q.query(
            "SELECT value FROM platform_settings WHERE id=1 FOR UPDATE",
          )
        ).rows[0].value,
        s = { ...old, ...v };
      s.custom_menus ??= [];
      if (s.registration_concurrency === undefined)
        s.registration_concurrency = 15;
      if (s.user_registration_concurrency === undefined)
        s.user_registration_concurrency = 15;
      s.announcements ??= [];
      validateControls(s);
      s.brand = validateBrand({ ...old.brand, ...v.brand });
      for (const k of [
        "registration_open",
        "email_verify_enabled",
        "orders_open",
        "api_enabled",
        "worker_enabled",
      ])
        fail(typeof s[k] === "boolean", `${k} 必须为布尔值`);
      for (const k of ["price_standard", "price_oauth"])
        integer(s[k], 0, 1000000, "单价");
      integer(s.max_quantity, 1, 1000, "每单上限");
      integer(s.registration_concurrency, 1, 100, "注册并发数");
      integer(s.user_registration_concurrency, 1, 100, "单用户注册并发数");
      integer(s.max_open_orders, 1, 20, "订单上限");
      integer(s.attempt_limit, 1, 5, "尝试次数");
      integer(s.timeout_minutes, 2, 120, "执行超时");
      fail(
        typeof s.site_name === "string" &&
          s.site_name.trim().length > 0 &&
          s.site_name.length <= 80,
        "站点名称长度须为 1～80",
      );
      fail(
        typeof s.announcement === "string" && s.announcement.length <= 5000,
        "公告过长",
      );
      fail(
        Array.isArray(s.email_domains) &&
          s.email_domains.length <= 100 &&
          s.email_domains.every(
            (d) => typeof d === "string" && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(d),
          ),
        "邮箱域名格式错误",
      );
      s.email_domains = s.email_domains.map((x) => x.toLowerCase());
      fail(
        s.template &&
          typeof s.template === "object" &&
          !Array.isArray(s.template),
        "注册模板格式错误",
      );
      const templateKeys = [
        "mailProvider",
        "proxyAssignments",
        "schemaVersion",
      ];
      fail(
        Object.keys(s.template).every((k) => templateKeys.includes(k)),
        "模板仅支持邮箱供应商和单个执行槽的代理分配",
      );
      if (s.template.proxyAssignments) {
        fail(
          Array.isArray(s.template.proxyAssignments) &&
            s.template.proxyAssignments.length === 1,
          "模板必须分配一个 Worker 的代理",
        );
        const p = s.template.proxyAssignments[0];
        fail(
          p.workerSlot === 1 && ["countryPool", "local"].includes(p.kind),
          "请选择国家代理池或本地代理",
        );
        fail(
          p.kind !== "countryPool" || /^(GLOBAL|[A-Z]{2})$/.test(p.countryCode),
          "国家代码不正确",
        );
        fail(
          p.kind !== "local" ||
            (typeof p.localProxyId === "string" && p.localProxyId.length > 0),
          "请选择代理",
        );
        s.template.schemaVersion = 2;
      }
      s.smtp = { ...old.smtp, ...(v.smtp || {}) };
      delete s.smtp.password_configured;
      if (v.smtp) {
        s.smtp.password = v.smtp.password
          ? crypt.encrypt(String(v.smtp.password))
          : old.smtp.password;
        integer(s.smtp.port, 1, 65535, "SMTP 端口");
        fail(typeof s.smtp.secure === "boolean", "SMTP TLS 配置错误");
        for (const k of ["host", "user", "from"])
          fail(
            typeof s.smtp[k] === "string" && s.smtp[k].length <= 254,
            "SMTP 配置格式错误",
          );
      }
      fail(
        !s.email_verify_enabled || Boolean(s.smtp.host && s.smtp.from),
        "启用邮箱验证前请配置 SMTP",
      );
      await q.query("UPDATE platform_settings SET value=$1 WHERE id=1", [s]);
      await audit(
        q,
        r.user.id,
        "settings.update",
        "",
        Object.keys(v).join(","),
      );
      return { ok: true };
    });
  });
  app.post("/api/admin/v1/users", async (r) => {
    const v = r.body || {},
      email = String(v.email || "")
        .trim()
        .toLowerCase(),
      name = String(v.name || "").trim();
    fail(
      email.length <= 254 &&
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
        name.length >= 1 &&
        name.length <= 80,
      "请填写有效邮箱和用户名",
    );
    fail(
      typeof v.password === "string" &&
        v.password.length >= 10 &&
        v.password.length <= 72,
      "密码须为 10～72 位",
    );
    fail(await db.limit(`admincreate:${r.user.id}`, 10), "创建过于频繁", 429);
    const hash = await passwordHash(v.password),
      uid = id();
    await db.tx(async (q) => {
      await q.query(
        "INSERT INTO platform_users(id,email,name,password_hash) VALUES($1,$2,$3,$4)",
        [uid, email, name, hash],
      );
      await audit(q, r.user.id, "user.create", uid, email);
    });
    return { ok: true, id: uid };
  });
  app.get("/api/admin/v1/users", async (r) => {
    const p = paging(r);
    const values = [
      search(r.query.q),
      option(r.query.status, ["active", "disabled"]),
    ];
    const where =
      "FROM platform_users u WHERE (u.email ILIKE $1 OR u.name ILIKE $1) AND ($2='' OR u.status=$2)";
    return {
      items: (
        await db.query(
          `SELECT u.id,u.email,u.name,u.role,u.status,u.points,u.frozen,u.created_at,(SELECT count(*)::int FROM platform_orders o WHERE o.user_id=u.id) AS orders,(SELECT coalesce(sum(charged),0)::float8 FROM platform_orders o WHERE o.user_id=u.id) AS spent ${where} ORDER BY u.created_at DESC,u.id DESC LIMIT $3 OFFSET $4`,
          [...values, p.limit, p.offset],
        )
      ).rows,
      total: (await db.one(`SELECT count(*)::int AS n ${where}`, values)).n,
      ...p,
    };
  });
  app.patch("/api/admin/v1/users/:id", async (r) => {
    const status = r.body?.status;
    fail(["active", "disabled"].includes(status), "状态无效");
    fail(r.params.id !== r.user.id, "不能停用当前管理员");
    await db.tx(async (q) => {
      const u = (
        await q.query("SELECT * FROM platform_users WHERE id=$1 FOR UPDATE", [
          r.params.id,
        ])
      ).rows[0];
      fail(u && u.role !== "admin", "用户不存在或不能操作管理员", 404);
      await q.query("UPDATE platform_users SET status=$2 WHERE id=$1", [
        u.id,
        status,
      ]);
      if (status === "disabled")
        await q.query("DELETE FROM platform_sessions WHERE user_id=$1", [u.id]);
      await audit(q, r.user.id, "user.status", u.id, status);
    });
    return { ok: true };
  });
  app.post("/api/admin/v1/users/:id/points", async (r) => {
    const amount = integer(r.body?.amount, -10000000, 10000000, "调整积分"),
      note = String(r.body?.note || "").trim(),
      key = r.headers["idempotency-key"];
    fail(
      amount !== 0 && note.length > 0 && note.length <= 200,
      "请填写调整原因",
    );
    fail(
      typeof key === "string" && key.length >= 8 && key.length <= 128,
      "请提供幂等键",
    );
    await db.tx(async (q) => {
      const u = (
        await q.query("SELECT * FROM platform_users WHERE id=$1 FOR UPDATE", [
          r.params.id,
        ])
      ).rows[0];
      fail(u, "用户不存在", 404);
      const previous = (
        await q.query(
          "SELECT * FROM platform_ledger WHERE user_id=$1 AND reference=$2",
          [u.id, `adjust:${key}`],
        )
      ).rows[0];
      if (previous) {
        fail(
          previous.points_delta === amount && previous.note === note,
          "幂等键已用于其他调整",
          409,
        );
        return;
      }
      fail(
        u.points + amount >= 0 && u.points + amount <= 1000000000,
        "调整后积分超出允许范围",
      );
      await ledger(q, u.id, `adjust:${key}`, "adjust", amount, 0, note);
      await audit(q, r.user.id, "points.adjust", u.id, String(amount));
    });
    return { ok: true };
  });
  app.get("/api/admin/v1/orders", async (r) => {
    return listOrders(db, null, r.query);
  });
  app.get("/api/admin/v1/orders/:id", async (r) => {
    const o = await db.one("SELECT user_id FROM platform_orders WHERE id=$1", [
      r.params.id,
    ]);
    fail(o, "订单不存在", 404);
    const detail = await orders.detail(o.user_id, r.params.id);
    const attempts = (
      await db.query(
        "SELECT a.* FROM platform_attempts a JOIN platform_items i ON i.id=a.item_id WHERE i.order_id=$1 ORDER BY a.created_at",
        [r.params.id],
      )
    ).rows;
    return { ...detail, attempts };
  });
  app.post("/api/admin/v1/orders/:id/cancel", async (r) => {
    const o = await db.one("SELECT user_id FROM platform_orders WHERE id=$1", [
      r.params.id,
    ]);
    fail(o, "订单不存在", 404);
    await audit(db, r.user.id, "admin.order.cancel", r.params.id);
    return orders.cancel(o.user_id, r.params.id);
  });
  app.get("/api/admin/v1/audit", async (r) => {
    const p = paging(r);
    const value = [search(r.query.q)];
    const from =
      "FROM platform_audit a LEFT JOIN platform_users u ON a.actor_id=u.id WHERE (a.action ILIKE $1 OR a.detail ILIKE $1 OR a.target ILIKE $1 OR u.email ILIKE $1)";
    const [items, count] = await Promise.all([
      db.query(
        `SELECT a.*,u.email AS actor_email ${from} ORDER BY a.id DESC LIMIT $2 OFFSET $3`,
        [...value, p.limit, p.offset],
      ),
      db.one(`SELECT count(*)::int AS total ${from}`, value),
    ]);
    return { items: items.rows, total: count.total, ...p };
  });
}
module.exports = { registerApi };
