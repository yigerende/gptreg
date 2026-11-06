"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { Database } = require("../src/platform/db");
const { Orders, ledger } = require("../src/platform/orders");
const {
  cipher,
  id,
  digest,
  token,
  passwordHash,
} = require("../src/platform/security");
const { buildPlatform } = require("../src/platform/app");
const {
  defaults,
  settings,
  source,
  validateSettings,
} = require("../src/platform/risk-config");
const { scan } = require("../src/platform/risk-scan");
const { event, record } = require("../src/platform/risk-store");
const connection =
  process.env.GPTREG_TEST_DATABASE_URL ||
  (fs.existsSync(".local/platform-test/connection.json")
    ? JSON.parse(fs.readFileSync(".local/platform-test/connection.json")).url
    : "");
test("risk source only trusts explicit proxy hops and rejects unsafe settings", () => {
  const request = (peer, xff) => ({
    raw: { socket: { remoteAddress: peer } },
    headers: {
      "x-forwarded-for": xff,
      "x-real-ip": "6.6.6.6",
      "cf-connecting-ip": "7.7.7.7",
    },
  });
  assert.deepEqual(source(request("::ffff:127.0.0.1", "8.8.8.8"), []), {
    source_ip: "127.0.0.1",
    source_verified: false,
  });
  assert.deepEqual(
    source(request("10.0.0.2", "9.9.9.9, 8.8.8.8, 10.0.0.3"), ["10.0.0.0/24"]),
    { source_ip: "8.8.8.8", source_verified: true },
  );
  assert.equal(
    source(request("10.0.0.2", "8.8.8.8, invalid"), ["10.0.0.0/24"])
      .source_verified,
    false,
  );
  assert.equal(
    source(request("2001:db8::1", "2001:db8:1::2"), ["2001:db8::/64"])
      .source_ip,
    "2001:db8:1::2",
  );
  for (const trusted_proxies of [
    ["0.0.0.0/0"],
    ["::/0"],
    ["localhost"],
    ["10.0.0.1/999"],
    ["8.8.8.8/bad"],
  ])
    assert.throws(() =>
      validateSettings({ ...structuredClone(defaults), trusted_proxies }),
    );
  assert.throws(() =>
    validateSettings({ ...structuredClone(defaults), failure_percent: 101 }),
  );
});
test(
  "risk monitor: persistent limits, authorization, customer controls and business invariants",
  { skip: !connection },
  async (t) => {
    const setup = new Database(connection),
      schema = `risk_${crypto.randomBytes(8).toString("hex")}`;
    await setup.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(connection);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const db = new Database(url.href),
      crypt = cipher(crypto.randomBytes(32).toString("base64")),
      orders = new Orders(db, crypt);
    await db.initialize();
  await db.query("UPDATE platform_settings SET value=jsonb_set(value,'{login_slider_enabled}','false') WHERE id=1");
    const pass = await passwordHash("RiskTestPassword123!"),
      admin = id(),
      alice = id(),
      bob = id();
    for (const [uid, email, role] of [
      [admin, "risk-admin@example.test", "admin"],
      [alice, "risk-alice@example.test", "member"],
      [bob, "risk-bob@example.test", "member"],
    ]) {
      await db.query(
        "INSERT INTO platform_users(id,email,name,role,password_hash) VALUES($1,$2,$2,$3,$4)",
        [uid, email, role, pass],
      );
      await db.tx((q) =>
        ledger(q, uid, `initial:${uid}`, "adjust", 5000, 0, "测试初始积分"),
      );
      await db.query(
        "INSERT INTO platform_sessions(hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",
        [digest(uid), uid],
      );
    }
    const apiKey = `gr_${token()}`,
      keyId = id();
    await db.query(
      "INSERT INTO platform_api_keys(id,user_id,name,hash,prefix,scopes) VALUES($1,$2,'验收 API', $3,'gr_test',$4)",
      [
        keyId,
        alice,
        digest(apiKey),
        JSON.stringify([
          "orders:read",
          "orders:write",
          "accounts:read",
          "credentials:read",
        ]),
      ],
    );
    await db.query(
      "UPDATE platform_settings SET value=value||$1::jsonb WHERE id=1",
      [JSON.stringify({ orders_open: true, max_open_orders: 50 })],
    );
    let app = buildPlatform({
      db,
      crypt,
      orders,
      secrets: { internal: "test" },
      proxy: false,
    });
    await app.ready();
    t.after(async () => {
      await app.close();
      await db.close();
      await setup.query(`DROP SCHEMA ${schema} CASCADE`);
      await setup.close();
    });
    const req = (method, url, body, user = admin, headers = {}) =>
      app.inject({
        method,
        url,
        headers: {
          "x-requested-with": "gptreg",
          ...(user ? { cookie: `gptreg_session=${user}` } : {}),
          ...headers,
        },
        ...(body !== undefined ? { payload: body } : {}),
      });
    const ok = async (method, url, body, user = admin, headers = {}) => {
      const r = await req(method, url, body, user, headers);
      assert.ok(r.statusCode < 300, r.body);
      return r.json();
    };
    const base = "/api/admin/v1/risk";
    async function config(update) {
      const cfg = await settings(db);
      await ok("PUT", `${base}/settings`, {
        ...cfg,
        ...update,
        rules: { ...cfg.rules, ...update.rules },
      });
    }
    let order;
    await t.test(
      "admin-only APIs, CSRF and protected assets; public configuration has no risk policies",
      async () => {
        for (const path of [
          `${base}/monitor`,
          `${base}/settings`,
          `${base}/customers/${alice}`,
          "/admin/risk",
          "/admin-assets/AdminRisk-test.js",
        ]) {
          assert.equal(
            (await req("GET", path, undefined, null)).statusCode,
            401,
          );
          assert.equal(
            (await req("GET", path, undefined, alice)).statusCode,
            403,
          );
        }
        for (const [method, path, body] of [
          ["PUT", `${base}/settings`, defaults],
          ["PUT", `${base}/customers/${alice}`, { paused: true, limits: {} }],
          ["POST", `${base}/scan`, {}],
          ["POST", `${base}/events/1/resolve`, {}],
          ["POST", `${base}/limits/unknown/release`, {}],
          ["POST", `${base}/keys/${keyId}/revoke`, {}],
        ])
          assert.equal((await req(method, path, body, bob)).statusCode, 403);
        assert.equal(
          (
            await req("POST", `${base}/scan`, {}, admin, {
              origin: "https://evil.test",
            })
          ).statusCode,
          403,
        );
        assert.ok(
          !JSON.stringify(
            await ok("GET", "/api/public", undefined, null),
          ).includes("trusted_proxies"),
        );
        assert.equal(
          (await ok("GET", `${base}/settings`)).settings.rules.submit.mode,
          "observe",
        );
        assert.equal(
          (await req("GET", `${base}/monitor?start=2026-99-99`)).statusCode,
          400,
        );
        assert.equal(
          (await req("GET", `${base}/monitor?start=2026-11-05&end=2026-11-01`))
            .statusCode,
          400,
        );
      },
    );
    await t.test(
      "observation allows requests and enforcement is atomic across concurrent requests",
      async () => {
        await config({
          rules: {
            query: {
              mode: "observe",
              limit: 2,
              window_seconds: 60,
              cooldown_seconds: 60,
            },
          },
        });
        const observed = await Promise.all(
          Array.from({ length: 6 }, () =>
            req("GET", "/api/user/v1/products", undefined, alice),
          ),
        );
        assert.ok(observed.every((r) => r.statusCode === 200));
        await config({
          rules: {
            query: {
              mode: "enforce",
              limit: 3,
              window_seconds: 60,
              cooldown_seconds: 60,
            },
          },
        });
        const results = await Promise.all(
          Array.from({ length: 12 }, () =>
            req("GET", "/api/user/v1/products", undefined, alice),
          ),
        );
        assert.equal(results.filter((r) => r.statusCode === 200).length, 3);
        assert.equal(results.filter((r) => r.statusCode === 429).length, 9);
        assert.ok(
          results
            .filter((r) => r.statusCode === 429)
            .every((r) => Number(r.headers["retry-after"]) > 0),
        );
        assert.equal(
          (await req("GET", "/api/user/v1/products", undefined, bob))
            .statusCode,
          200,
        );
        const blocked = await db.one(
          "SELECT * FROM platform_risk_buckets WHERE user_id=$1 AND rule='query'",
          [alice],
        );
        await app.close();
        app = buildPlatform({
          db,
          crypt,
          orders,
          secrets: { internal: "test" },
          proxy: false,
        });
        await app.ready();
        assert.equal(
          (await req("GET", "/api/user/v1/products", undefined, alice))
            .statusCode,
          429,
        );
        await config({ enabled: false, refresh_seconds: 20 });
        assert.equal(
          (await req("GET", "/api/user/v1/products", undefined, alice))
            .statusCode,
          429,
          "disabling recording or changing refresh must not release a restriction",
        );
        await db.query(
          "UPDATE platform_risk_buckets SET blocked_until=now()-interval '1 second' WHERE id=$1",
          [blocked.id],
        );
        assert.equal(
          (await req("GET", "/api/user/v1/products", undefined, alice))
            .statusCode,
          200,
          "cooldown expiry resumes access even before original window ends",
        );
        await ok("POST", `${base}/limits/${blocked.id}/release`, {});
        assert.equal(
          (await req("GET", "/api/user/v1/products", undefined, alice))
            .statusCode,
          200,
        );
        await db.query(
          "UPDATE platform_risk_buckets SET window_until=now()-interval '2 seconds',blocked_until=now()-interval '1 second' WHERE user_id=$1",
          [alice],
        );
        assert.equal(
          (await req("GET", "/api/user/v1/products", undefined, alice))
            .statusCode,
          200,
        );
        await config({
          enabled: true,
          rules: { query: { ...defaults.rules.query } },
        });
      },
    );
    await t.test(
      "configuration revisions reject stale writes and authenticated admin recovery remains available",
      async () => {
        const cfg = await settings(db);
        await config({
          rules: {
            account: {
              mode: "enforce",
              limit: 1,
              window_seconds: 60,
              cooldown_seconds: 60,
            },
          },
        });
        assert.equal(
          (await req("PUT", `${base}/settings`, cfg)).statusCode,
          409,
        );
        await req("GET", "/api/user/v1/products", undefined, admin);
        assert.equal(
          (await req("GET", "/api/user/v1/products", undefined, admin))
            .statusCode,
          429,
        );
        assert.equal((await req("GET", `${base}/monitor`)).statusCode, 200);
        assert.equal((await req("GET", "/api/user/v1/me")).statusCode, 200);
        await config({ rules: { account: { ...defaults.rules.account } } });
      },
    );
    await t.test(
      "pause rejects new orders in the transaction, preserves old idempotent confirmation and existing orders",
      async () => {
        order = await ok(
          "POST",
          "/api/user/v1/registration-orders",
          { quantity: 3, need_oauth: false },
          alice,
          { "idempotency-key": "risk-original-order" },
        );
        const before = await db.one(
          "SELECT points,frozen FROM platform_users WHERE id=$1",
          [alice],
        );
        await ok("PUT", `${base}/customers/${alice}`, {
          paused: true,
          limits: { query: 400 },
        });
        assert.equal(
          (
            await req(
              "POST",
              "/api/user/v1/registration-orders",
              { quantity: 1 },
              alice,
              { "idempotency-key": "risk-new-order" },
            )
          ).statusCode,
          403,
        );
        assert.equal(
          (
            await ok(
              "POST",
              "/api/user/v1/registration-orders",
              { quantity: 3, need_oauth: false },
              alice,
              { "idempotency-key": "risk-original-order" },
            )
          ).id,
          order.id,
        );
        assert.equal(
          (
            await req(
              "POST",
              "/open/v1/registration-orders",
              { quantity: 1 },
              null,
              {
                authorization: `Bearer ${apiKey}`,
                "idempotency-key": "risk-new-api-order",
              },
            )
          ).statusCode,
          403,
        );
        assert.deepEqual(
          await db.one("SELECT points,frozen FROM platform_users WHERE id=$1", [
            alice,
          ]),
          before,
        );
        assert.equal(
          (
            await req(
              "GET",
              `/api/user/v1/registration-orders/${order.id}`,
              undefined,
              alice,
            )
          ).statusCode,
          200,
        );
        const item = await db.one(
          "SELECT id FROM platform_items WHERE order_id=$1 ORDER BY position LIMIT 1",
          [order.id],
        );
        await orders.finish(item.id, {
          asset_id: id(),
          email: "delivered-risk@example.test",
          password: "DO_NOT_LOG_PASSWORD",
          totp_secret: "JBSWY3DPEHPK3PXP",
        });
        const account = await db.one(
          "SELECT id FROM platform_accounts WHERE item_id=$1",
          [item.id],
        );
        assert.equal(
          (
            await req(
              "POST",
              "/api/user/v1/accounts/export",
              { ids: [account.id], format: "txt" },
              alice,
            )
          ).statusCode,
          200,
        );
        assert.equal((await req(
          "POST",
          `/api/user/v1/registration-orders/${order.id}/cancel`,
          {},
          alice,
        )).statusCode, 403);
        await db.query(
          "UPDATE platform_risk_controls SET paused_until=now()-interval '1 second' WHERE user_id=$1",
          [alice],
        );
        assert.equal(
          (
            await req(
              "POST",
              "/api/user/v1/registration-orders",
              { quantity: 1 },
              alice,
              { "idempotency-key": "risk-resumed-order" },
            )
          ).statusCode,
          202,
        );
        await ok("PUT", `${base}/customers/${alice}`, {
          paused: false,
          limits: {},
        });
      },
    );
    await t.test(
      "customer overrides and API keys share user limits, revocation takes effect",
      async () => {
        await config({
          rules: {
            query: {
              mode: "enforce",
              limit: 1,
              window_seconds: 60,
              cooldown_seconds: 60,
            },
          },
        });
        await ok("PUT", `${base}/customers/${alice}`, {
          paused: false,
          limits: { query: 2 },
        });
        assert.equal(
          (await req("GET", "/api/user/v1/products", undefined, alice))
            .statusCode,
          200,
        );
        assert.equal(
          (
            await req("GET", "/open/v1/products", undefined, null, {
              authorization: `Bearer ${apiKey}`,
            })
          ).statusCode,
          200,
        );
        assert.equal(
          (
            await req("GET", "/open/v1/products", undefined, null, {
              authorization: `Bearer ${apiKey}`,
            })
          ).statusCode,
          429,
        );
        await config({
          rules: {
            query: { ...defaults.rules.query },
            api_key: {
              mode: "enforce",
              limit: 1,
              window_seconds: 60,
              cooldown_seconds: 60,
            },
          },
        });
        await ok("PUT", `${base}/customers/${alice}`, {
          paused: false,
          limits: {},
        });
        assert.equal(
          (
            await req("GET", "/open/v1/products", undefined, null, {
              authorization: `Bearer ${apiKey}`,
            })
          ).statusCode,
          200,
        );
        assert.equal(
          (
            await req("GET", "/open/v1/products", undefined, null, {
              authorization: `Bearer ${apiKey}`,
            })
          ).statusCode,
          429,
        );
        assert.equal(
          (await req("GET", "/api/user/v1/products", undefined, alice))
            .statusCode,
          200,
        );
        await ok("POST", `${base}/keys/${keyId}/revoke`, {});
        assert.equal(
          (
            await req("GET", "/open/v1/products", undefined, null, {
              authorization: `Bearer ${apiKey}`,
            })
          ).statusCode,
          401,
        );
      },
    );
    await t.test(
      "login limits cannot be bypassed with forged IPs and credentials never appear in telemetry",
      async () => {
        await config({
          rules: {
            login: {
              mode: "enforce",
              limit: 2,
              window_seconds: 60,
              cooldown_seconds: 60,
            },
          },
          trusted_proxies: ["127.0.0.1"],
        });
        for (let n = 0; n < 3; n++)
          assert.equal(
            (
              await req(
                "POST",
                "/api/auth/login",
                {
                  email: "risk-alice@example.test",
                  password: "DO_NOT_LOG_LOGIN_SECRET",
                },
                null,
                { "x-forwarded-for": `8.8.8.${n + 1}` },
              )
            ).statusCode,
            n < 2 ? 401 : 429,
          );
        assert.equal(
          (
            await req(
              "POST",
              "/api/auth/login",
              {
                email: "risk-bob@example.test",
                password: "RiskTestPassword123!",
              },
              null,
            )
          ).statusCode,
          200,
        );
        await req(
          "POST",
          "/api/user/v1/redeem",
          { code: "DO_NOT_LOG_REDEEM_SECRET_123" },
          alice,
        );
        const m = await ok("GET", `${base}/monitor`),
          text = JSON.stringify(m);
        for (const secret of [
          "DO_NOT_LOG_LOGIN_SECRET",
          "DO_NOT_LOG_PASSWORD",
          "DO_NOT_LOG_REDEEM_SECRET",
          apiKey,
          "JBSWY3DPEHPK3PXP",
        ])
          assert.ok(!text.includes(secret));
        assert.ok(
          m.items.some((e) => e.kind === "login_failed" && e.source_verified),
        );
        const before = await db.one(
          "SELECT coalesce(sum(requests),0)::int n FROM platform_risk_traffic",
        );
        await ok("GET", `${base}/monitor`);
        await ok("GET", `${base}/settings`);
        assert.equal(
          (
            await db.one(
              "SELECT coalesce(sum(requests),0)::int n FROM platform_risk_traffic",
            )
          ).n,
          before.n,
        );
      },
    );
    await t.test(
      "scans identify real queue and financial anomalies without modifying business data; resolved episodes stay acknowledged",
      async () => {
        await config({
          queue_count: 1,
          queue_seconds: 60,
          large_adjustment: 1000,
        });
        await db.query(
          "UPDATE platform_items SET updated_at=now()-interval '5 minutes' WHERE status='queued'",
        );
        const snapshot = async () => ({
          users: (
            await db.query(
              "SELECT id,points,frozen FROM platform_users ORDER BY id",
            )
          ).rows,
          orders: (await db.query("SELECT * FROM platform_orders ORDER BY id"))
            .rows,
          ledger: (await db.query("SELECT * FROM platform_ledger ORDER BY id"))
            .rows,
          accounts: (
            await db.query("SELECT * FROM platform_accounts ORDER BY id")
          ).rows,
        });
        const before = await snapshot();
        await scan(db, true);
        assert.deepEqual(await snapshot(), before);
        assert.equal(
          (
            await db.one(
              "SELECT count(*)::int n FROM platform_risk_events WHERE kind IN ('frozen_mismatch','ledger_mismatch','settlement_mismatch')",
            )
          ).n,
          0,
        );
        const queued = await db.one(
          "SELECT * FROM platform_risk_events WHERE kind='queue_long' LIMIT 1",
        );
        assert.ok(queued);
        await ok("POST", `${base}/events/${queued.id}/resolve`, {});
        await scan(db, true);
        assert.ok(
          (
            await db.one(
              "SELECT resolved_at FROM platform_risk_events WHERE id=$1",
              [queued.id],
            )
          ).resolved_at,
        );
        await db.query(
          "UPDATE platform_users SET frozen=frozen+1 WHERE id=$1",
          [bob],
        );
        await scan(db, true);
        assert.equal(
          (
            await db.one(
              "SELECT count(*)::int n FROM platform_risk_events WHERE kind='frozen_mismatch' AND user_id=$1",
              [bob],
            )
          ).n,
          1,
        );
        await db.query(
          "UPDATE platform_users SET frozen=frozen-1 WHERE id=$1",
          [bob],
        );
        await scan(db, true);
        await db.query(
          "UPDATE platform_users SET frozen=frozen+1 WHERE id=$1",
          [bob],
        );
        await scan(db, true);
        assert.equal(
          (
            await db.one(
              "SELECT count(*)::int n FROM platform_risk_events WHERE kind='frozen_mismatch' AND user_id=$1",
              [bob],
            )
          ).n,
          2,
        );
        await db.query(
          "UPDATE platform_users SET frozen=frozen-1 WHERE id=$1",
          [bob],
        );
        const filtered = await ok(
          "GET",
          `${base}/monitor?q=risk-bob&category=finance&state=pending`,
        );
        assert.ok(
          filtered.items.length > 0 &&
            filtered.items.every(
              (e) => e.user_id === bob && e.category === "finance",
            ),
        );
      },
    );
    await t.test(
      "retention removes only old risk telemetry, compatible initialization preserves settings and data",
      async () => {
        await event(
          db,
          "server_error",
          { user_id: alice, operation: "query" },
          "expired-event",
        );
        await db.query(
          "UPDATE platform_risk_events SET last_seen=now()-interval '40 days' WHERE dedupe='expired-event'",
        );
        await record(db, {
          cfg: defaults,
          user_id: alice,
          operation: "query",
          method: "GET",
          channel: "web",
          source_ip: "",
          status: 200,
          duration_ms: 1,
        });
        await db.query(
          "UPDATE platform_risk_traffic SET minute=minute-interval '40 days'",
        );
        const ordersBefore = (
            await db.one("SELECT count(*)::int n FROM platform_orders")
          ).n,
          cfg = await settings(db);
        await scan(db, true);
        await db.initialize();
  await db.query("UPDATE platform_settings SET value=jsonb_set(value,'{login_slider_enabled}','false') WHERE id=1");
        assert.equal(
          (
            await db.one(
              "SELECT count(*)::int n FROM platform_risk_events WHERE dedupe='expired-event'",
            )
          ).n,
          0,
        );
        assert.equal(
          (
            await db.one(
              "SELECT count(*)::int n FROM platform_risk_traffic WHERE minute<now()-interval '30 days'",
            )
          ).n,
          0,
        );
        assert.equal(
          (await db.one("SELECT count(*)::int n FROM platform_orders")).n,
          ordersBefore,
        );
        assert.deepEqual(await settings(db), cfg);
      },
    );
  },
);
