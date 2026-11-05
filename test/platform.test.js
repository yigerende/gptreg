"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { Database } = require("../src/platform/db");
const { Orders } = require("../src/platform/orders");
const { cipher, id, digest } = require("../src/platform/security");
const { buildPlatform } = require("../src/platform/app");
const { OrderWorker } = require("../src/platform/worker");
const connection =
  process.env.GPTREG_TEST_DATABASE_URL ||
  (fs.existsSync(".local/platform-test/connection.json")
    ? JSON.parse(fs.readFileSync(".local/platform-test/connection.json")).url
    : "");
test(
  "customer platform: auth, tenancy, transactional points, API and recovery",
  { skip: !connection },
  async (t) => {
    const db = new Database(connection),
      schema = `test_${crypto.randomBytes(8).toString("hex")}`;
    await db.query(`CREATE SCHEMA ${schema}`);
    await db.close();
    const url = new URL(connection);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const store = new Database(url.href);
    await store.initialize({
      username: "admin",
      password: "TestAdminPassword123!",
    });
    const crypt = cipher(crypto.randomBytes(32).toString("base64")),
      orders = new Orders(store, crypt),
      app = buildPlatform({
        db: store,
        orders,
        crypt,
        secrets: { internal: "test" },
        proxy: false,
      });
    await app.ready();
    const request = (method, url, body, cookie, key, extra = {}) =>
      app.inject({
        method,
        url,
        headers: {
          "x-requested-with": "gptreg",
          ...(cookie ? { cookie } : {}),
          ...(key ? { "idempotency-key": key } : {}),
          ...extra,
        },
        ...(body !== undefined ? { payload: body } : {}),
      });
    let adminCookie,
      aliceCookie,
      bobCookie,
      alice,
      bob,
      order,
      accountId,
      apiKey;
    try {
      await t.test(
        "anonymous and customer cannot access administrator endpoints or bundles",
        async () => {
          assert.equal(
            (await request("GET", "/api/admin/v1/users")).statusCode,
            401,
          );
          assert.equal(
            (await request("GET", "/api/v1/config")).statusCode,
            401,
          );
          assert.equal(
            (await request("GET", "/assets/AdminConsole-test.js")).statusCode,
            401,
          );
          const a = await request("POST", "/api/auth/login", {
            email: "admin",
            password: "TestAdminPassword123!",
          });
          assert.equal(a.statusCode, 200, a.body);
          adminCookie = a.headers["set-cookie"].split(";")[0];
          assert.match(a.headers["set-cookie"], /HttpOnly/);
          assert.match(a.headers["set-cookie"], /SameSite=Strict/);
          const reg = async (email) => {
            const r = await request("POST", "/api/auth/register", {
              email,
              name: email,
              password: "TestMemberPassword123!",
            });
            assert.equal(r.statusCode, 200, r.body);
            return r.headers["set-cookie"].split(";")[0];
          };
          aliceCookie = await reg("alice@example.test");
          bobCookie = await reg("bob@example.test");
          alice = (
            await request("GET", "/api/user/v1/me", undefined, aliceCookie)
          ).json();
          bob = (
            await request("GET", "/api/user/v1/me", undefined, bobCookie)
          ).json();
          for (const route of [
            "/admin",
            "/admin/engine",
            "/admin/engine/proxies",
            "/admin?view=engine",
            "/admin-assets/AdminEntry-test.js",
            "/admin-assets/AdminConsole-test.js",
            "/admin-assets/%41dminConsole-test.js",
            "/%61dmin-assets/AdminConsole-test.js",
            "/assets/%41dminConsole-test.js",
            "/assets/AdminEntry-test.js",
            "/api/admin/v1/settings",
            "/api/v1/health",
          ]) {
            for (const method of ["GET", "HEAD"]) {
              assert.equal(
                (await request(method, route)).statusCode,
                401,
                `${method} anonymous ${route}`,
              );
              assert.equal(
                (
                  await request(
                    method,
                    route,
                    undefined,
                    aliceCookie,
                    undefined,
                    { "x-role": "admin" },
                  )
                ).statusCode,
                403,
                `${method} member ${route}`,
              );
            }
          }
          assert.equal(
            (
              await request(
                "GET",
                "/api/admin/v1/users",
                undefined,
                aliceCookie,
              )
            ).statusCode,
            403,
          );
          assert.equal(
            (
              await request(
                "GET",
                "/assets/AdminPlatform-test.js",
                undefined,
                aliceCookie,
              )
            ).statusCode,
            403,
          );
          assert.equal(
            (
              await app.inject({
                method: "POST",
                url: "/api/auth/login",
                payload: {},
              })
            ).statusCode,
            403,
          );
          assert.equal(
            (
              await request(
                "POST",
                "/api/auth/logout",
                {},
                aliceCookie,
                undefined,
                { origin: "https://evil.invalid" },
              )
            ).statusCode,
            403,
          );
        },
      );
      await t.test(
        "brand settings are backward compatible, public and reject active content",
        async () => {
          const before = await store.settings();
          await store.query(
            "UPDATE platform_settings SET value=value-'brand' WHERE id=1",
          );
          const initial = (await request("GET", "/api/public")).json();
          assert.equal(initial.brand.english_name, "GPTREG");
          assert.equal(initial.brand.icon, undefined);
          const icon = await request("GET", initial.brand.icon_url);
          assert.equal(icon.statusCode, 200);
          assert.match(icon.headers["content-type"], /image\/svg\+xml/);
          const svg = fs.readFileSync("src/platform/assets/gptreg-icon.svg");
          const data = `data:image/svg+xml;base64,${svg.toString("base64")}`;
          const saved = await request(
            "PATCH",
            "/api/admin/v1/settings",
            {
              brand: {
                tagline: "品牌测试",
                support_url: "https://example.test/help",
                icon: data,
              },
            },
            adminCookie,
          );
          assert.equal(saved.statusCode, 200, saved.body);
          const published = (await request("GET", "/api/public")).json();
          assert.equal(published.brand.tagline, "品牌测试");
          assert.equal(published.brand.icon, undefined);
          assert.equal(
            (await request("GET", published.brand.icon_url)).statusCode,
            200,
          );
          const png =
            "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAGUlEQVR4nGMQzw39TwlmGDVg1IBRA4aLAQCsI9gQg7zMRQAAAABJRU5ErkJggg==";
          assert.equal(
            (
              await request(
                "PATCH",
                "/api/admin/v1/settings",
                { brand: { icon: png } },
                adminCookie,
              )
            ).statusCode,
            200,
          );
          assert.match(
            (await request("GET", "/favicon.ico")).headers["content-type"],
            /image\/png/,
          );
          assert.equal(
            (
              await request(
                "PATCH",
                "/api/admin/v1/settings",
                { brand: { icon: "" } },
                adminCookie,
              )
            ).statusCode,
            200,
          );
          assert.equal(
            (await request("GET", "/api/public")).json().brand.icon_url,
            initial.brand.icon_url,
          );
          for (const svg of [
            '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
            '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://example.test/a"/></svg>',
            '<svg xmlns="http://www.w3.org/2000/svg"><path fill="url(https://example.test/a)"/></svg>',
          ]) {
            assert.equal(
              (
                await request(
                  "PATCH",
                  "/api/admin/v1/settings",
                  {
                    brand: {
                      icon: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`,
                    },
                  },
                  adminCookie,
                )
              ).statusCode,
              400,
            );
          }
          assert.equal(
            (
              await request(
                "PATCH",
                "/api/admin/v1/settings",
                { brand: { support_url: "javascript:alert(1)" } },
                adminCookie,
              )
            ).statusCode,
            400,
          );
          assert.equal(
            (
              await request(
                "PATCH",
                "/api/admin/v1/settings",
                { brand: { icon: "data:image/png;base64,aW52YWxpZA==" } },
                adminCookie,
              )
            ).statusCode,
            400,
          );
          const after = await store.settings();
          assert.deepEqual(after.template, before.template);
          assert.equal(after.price_standard, before.price_standard);
          await store.query(
            "UPDATE platform_settings SET value=$1 WHERE id=1",
            [before],
          );
        },
      );
      await t.test(
        "administrator-configurable prices default to 50 and 100; adjustments are idempotent",
        async () => {
          const s = (
            await request(
              "GET",
              "/api/admin/v1/settings",
              undefined,
              adminCookie,
            )
          ).json();
          assert.equal(s.price_standard, 50);
          assert.equal(s.price_oauth, 100);
          assert.equal(s.registration_concurrency, 15);
          assert.equal(s.user_registration_concurrency, 15);
          assert.equal(s.max_quantity, 100);
          for (const key of ["registration_concurrency", "user_registration_concurrency"]) {
            for (const value of [0, 101, 1.5, "15"]) {
              assert.equal((await request("PATCH", "/api/admin/v1/settings", { [key]: value }, adminCookie)).statusCode, 400);
            }
            assert.equal((await request("PATCH", "/api/admin/v1/settings", { [key]: 10 }, adminCookie)).statusCode, 200);
            assert.equal((await store.settings())[key], 10);
            await request("PATCH", "/api/admin/v1/settings", { [key]: 15 }, adminCookie);
          }
          assert.equal(
            (
              await request(
                "PATCH",
                "/api/admin/v1/settings",
                { orders_open: true },
                adminCookie,
              )
            ).statusCode,
            200,
          );
          const responses = await Promise.all(
            Array.from({ length: 3 }, () =>
              request(
                "POST",
                `/api/admin/v1/users/${alice.id}/points`,
                { amount: 1000, note: "test" },
                adminCookie,
                "adjust-alice-001",
              ),
            ),
          );
          responses.forEach((r) => assert.equal(r.statusCode, 200, r.body));
          assert.equal(
            (
              await store.one("SELECT points FROM platform_users WHERE id=$1", [
                alice.id,
              ])
            ).points,
            1000,
          );
        },
      );
      await t.test(
        "concurrent duplicate orders reserve exactly once and reject mismatched body",
        async () => {
          const rs = await Promise.all(
            Array.from({ length: 4 }, () =>
              request(
                "POST",
                "/api/user/v1/registration-orders",
                { quantity: 3, need_oauth: false },
                aliceCookie,
                "order-alice-001",
              ),
            ),
          );
          rs.forEach((r) =>
            assert.ok([200, 202].includes(r.statusCode), r.body),
          );
          order = rs[0].json();
          assert.equal(new Set(rs.map((r) => r.json().id)).size, 1);
          assert.deepEqual(
            await store.one(
              "SELECT points,frozen FROM platform_users WHERE id=$1",
              [alice.id],
            ),
            { points: 850, frozen: 150 },
          );
          assert.equal(
            (
              await request(
                "POST",
                "/api/user/v1/registration-orders",
                { quantity: 4 },
                aliceCookie,
                "order-alice-001",
              )
            ).statusCode,
            409,
          );
          assert.equal(
            (
              await request(
                "POST",
                "/api/user/v1/registration-orders",
                { quantity: 1, plan: { proxy: "attacker" } },
                aliceCookie,
                "order-bad-001",
              )
            ).statusCode,
            400,
          );
          assert.equal(
            (
              await request(
                "POST",
                "/api/user/v1/registration-orders",
                { quantity: 1 },
                bobCookie,
                "order-bob-001",
              )
            ).statusCode,
            402,
          );
          assert.equal(
            (
              await request(
                "GET",
                `/api/user/v1/registration-orders/${order.id}`,
                undefined,
                bobCookie,
              )
            ).statusCode,
            404,
          );
        },
      );
      await t.test(
        "price snapshot, encrypted delivery and exactly-once partial settlement",
        async () => {
          await request(
            "PATCH",
            "/api/admin/v1/settings",
            { price_standard: 70 },
            adminCookie,
          );
          const items = (
            await store.query(
              "SELECT * FROM platform_items WHERE order_id=$1 ORDER BY position",
              [order.id],
            )
          ).rows;
          const credentials = {
            asset_id: id(),
            email: "delivered@example.test",
            password: "PrivateDeliveryPassword",
            totp_secret: "JBSWY3DPEHPK3PXP",
          };
          await Promise.all([
            orders.finish(items[0].id, credentials),
            orders.finish(items[0].id, credentials),
          ]);
          const account = await store.one(
            "SELECT * FROM platform_accounts WHERE item_id=$1",
            [items[0].id],
          );
          accountId = account.id;
          assert.ok(!account.credentials.includes(credentials.password));
          const result = await request(
            "GET",
            `/api/user/v1/accounts/${account.id}/credentials`,
            undefined,
            aliceCookie,
          );
          assert.equal(result.statusCode, 200);
          assert.equal(result.json().password, credentials.password);
          assert.match(result.json().totp_code, /^\d{6}$/);
          assert.equal(
            (
              await request(
                "GET",
                `/api/user/v1/accounts/${account.id}/credentials`,
                undefined,
                bobCookie,
              )
            ).statusCode,
            404,
          );
          assert.equal(
            (
              await request(
                "POST",
                "/api/user/v1/accounts/export",
                { ids: [account.id] },
                bobCookie,
              )
            ).statusCode,
            404,
          );
          await Promise.all([
            orders.cancel(alice.id, order.id),
            orders.cancel(alice.id, order.id),
          ]);
          const finished = await orders.detail(alice.id, order.id);
          assert.equal(finished.status, "partial");
          assert.equal(finished.unit_price, 50);
          assert.equal(finished.charged, 50);
          assert.equal(finished.released, 100);
          assert.deepEqual(
            await store.one(
              "SELECT points,frozen FROM platform_users WHERE id=$1",
              [alice.id],
            ),
            { points: 950, frozen: 0 },
          );
        },
      );
      await t.test(
        "reports isolate tenants, paginate filters and count settled charges once",
        async () => {
          const get = async (route, cookie = aliceCookie) => {
            const r = await request("GET", route, undefined, cookie);
            assert.equal(r.statusCode, 200, r.body);
            return r.json();
          };
          const a = await get("/api/user/v1/overview"),
            b = await get("/api/user/v1/overview", bobCookie);
          assert.equal(a.stats.spent, 50);
          assert.equal(a.stats.delivered, 1);
          assert.equal(b.stats.spent, 0);
          assert.equal(b.recent_orders.length, 0);
          assert.equal(a.daily.length, 7);
          assert.equal(
            a.daily.reduce((n, d) => n + d.charged, 0),
            50,
          );
          const filtered = await get(
            "/api/user/v1/registration-orders?status=partial&mode=standard&limit=1",
          );
          assert.equal(filtered.total, 1);
          assert.equal(filtered.items[0].id, order.id);
          assert.equal(
            (
              await get(
                "/api/user/v1/registration-orders?status=partial&limit=1&offset=1",
              )
            ).items.length,
            0,
          );
          assert.equal(
            (await get("/api/user/v1/registration-orders?q=alice", bobCookie))
              .total,
            0,
          );
          assert.equal(
            (await get("/api/user/v1/registration-orders?q=%25")).total,
            0,
          );
          assert.equal((await get("/api/user/v1/accounts")).total, 1);
          assert.equal(
            (await get("/api/user/v1/accounts", bobCookie)).total,
            0,
          );
          const overview = await get("/api/admin/v1/overview", adminCookie);
          assert.equal(overview.stats.customers, 2);
          assert.equal(overview.stats.charged, 50);
          const finance = await get(
            "/api/admin/v1/finance?kind=charge&days=7",
            adminCookie,
          );
          assert.equal(finance.stats.charged, 50);
          assert.equal(finance.total, 1);
          assert.equal(finance.items[0].kind, "charge");
          const customer = await get(
            `/api/admin/v1/users/${alice.id}`,
            adminCookie,
          );
          assert.equal(customer.stats.spent, 50);
          assert.equal(customer.user.password_hash, undefined);
          const accounts = await get("/api/admin/v1/accounts", adminCookie);
          assert.equal(accounts.items[0].credentials, undefined);
          assert.equal(accounts.items[0].owner_email, alice.email);
          for (const route of [
            "/api/admin/v1/overview",
            "/api/admin/v1/finance",
            "/api/admin/v1/accounts",
            `/api/admin/v1/users/${alice.id}`,
            "/api/admin/v1/mail/logs",
          ])
            assert.equal(
              (await request("GET", route, undefined, bobCookie)).statusCode,
              403,
            );
          assert.equal(
            (
              await request(
                "GET",
                "/api/user/v1/registration-orders?status=unknown",
                undefined,
                aliceCookie,
              )
            ).statusCode,
            400,
          );
        },
      );
      await t.test("admin delivery credentials and exports are private, complete and audited", async () => {
        const account = await store.one("SELECT * FROM platform_accounts WHERE id=$1", [accountId]);
        const value = { ...crypt.decrypt(account.credentials), password: '=secret,"quoted"', oauth: { access_token: "admin-access-test", refresh_token: "admin-refresh-test", id_token: "admin-id-test", extra: { preserved: true } } };
        await store.query("UPDATE platform_accounts SET credentials=$2,need_oauth=true WHERE id=$1", [accountId, crypt.encrypt(value)]);
        try {
          const path = `/api/admin/v1/accounts/${accountId}/credentials`;
          for (const cookie of [undefined, aliceCookie, bobCookie]) {
            const expected = cookie ? 403 : 401;
            assert.equal((await request("GET", path, undefined, cookie)).statusCode, expected);
            assert.equal((await request("POST", "/api/admin/v1/accounts/export", { ids: [accountId] }, cookie)).statusCode, expected);
          }
          assert.equal((await request("GET", path, undefined, undefined, undefined, { authorization: "Bearer gr_test", "x-role": "admin" })).statusCode, 401);
          const response = await request("GET", path, undefined, adminCookie);
          assert.equal(response.statusCode, 200);
          assert.equal(response.headers["cache-control"], "no-store");
          const revealed = response.json();
          assert.equal(revealed.password, value.password);
          assert.deepEqual(revealed.oauth, value.oauth);
          assert.equal(revealed.delivery.owner_email, alice.email);
          assert.equal(revealed.delivery.order_id, order.id);
          assert.equal(revealed.delivery.need_oauth, true);
          assert.match(revealed.totp_code, /^\d{6}$/);
          for (const format of ["json", "csv", "txt"]) {
            const r = await request("POST", "/api/admin/v1/accounts/export", { ids: [accountId, accountId], format }, adminCookie);
            assert.equal(r.statusCode, 200, r.body);
            const exported = r.json();
            assert.equal(exported.filename, `gptreg-deliveries.${format}`);
            if (format === "json") {
              const records = JSON.parse(exported.content);
              assert.equal(records.length, 1);
              assert.deepEqual(records[0].oauth, value.oauth);
              assert.equal(records[0].password, value.password);
              assert.equal(records[0].delivery.user_id, alice.id);
            } else if (format === "txt") assert.equal(exported.content, `${value.email}----${value.password}----${value.totp_secret}\n`);
            else {
              assert.ok(exported.content.includes('"\'=secret,""quoted"""'));
              assert.ok(exported.content.includes('admin-refresh-test'));
              assert.ok(exported.content.includes(alice.email));
            }
          }
          assert.equal((await request("POST", "/api/admin/v1/accounts/export", { ids: [accountId, "missing"] }, adminCookie)).statusCode, 404);
          for (const body of [{ ids: [] }, { ids: [accountId], format: "zip" }, { ids: Array(1001).fill(accountId) }, { ids: [4] }])
            assert.equal((await request("POST", "/api/admin/v1/accounts/export", body, adminCookie)).statusCode, 400);
          const audit = (await store.query("SELECT action,detail,target FROM platform_audit WHERE action LIKE 'admin.account%' ORDER BY id")).rows;
          assert.equal(audit.filter((r) => r.action === "admin.accounts.export").length, 3);
          assert.ok(audit.some((r) => r.target === accountId));
          assert.ok(!JSON.stringify(audit).includes(value.password));
          assert.ok(!JSON.stringify(audit).includes(value.oauth.refresh_token));
        } finally {
          await store.query("UPDATE platform_accounts SET credentials=$2,need_oauth=$3 WHERE id=$1", [accountId, account.credentials, account.need_oauth]);
        }
      });
      await t.test("funds account uses real balances, filtered totals, owned orders and feature access", async () => {
        const get = async (route, cookie = aliceCookie) => {
          const r = await request("GET", route, undefined, cookie);
          assert.equal(r.statusCode, 200, r.body);
          return r.json();
        };
        const wallet = await get("/api/user/v1/wallet?limit=1");
        assert.equal(wallet.points, 950);
        assert.equal(wallet.frozen, 0);
        assert.equal(wallet.items.length, 1);
        assert.deepEqual(wallet.totals, { credited: 1000, charged: 50, reserved: 150, released: 100 });
        const reserve = await get("/api/user/v1/wallet?kind=reserve");
        assert.equal(reserve.total, 1);
        assert.equal(reserve.items[0].order_id, order.id);
        assert.equal(reserve.items[0].points_after, 850);
        assert.equal(reserve.items[0].frozen_after, 150);
        assert.equal((await get(`/api/user/v1/wallet?q=${order.id}`)).total, 4);
        assert.equal((await get("/api/user/v1/wallet?q=%25")).total, 0);
        assert.equal((await get("/api/user/v1/wallet?tab=recharges")).total, 1);
        const bobWallet = await get("/api/user/v1/wallet", bobCookie);
        assert.equal(bobWallet.total, 0);
        assert.deepEqual(bobWallet.totals, { credited: 0, charged: 0, reserved: 0, released: 0 });
        for (const query of ["start=2026-02-30", "start=2026-12-01&end=2026-01-01", "kind=unknown", "tab=unknown"])
          assert.equal((await request("GET", `/api/user/v1/wallet?${query}`, undefined, aliceCookie)).statusCode, 400);
        assert.equal((await get("/api/user/v1/wallet?start=2000-01-01&end=2000-01-01")).total, 0);
        const profile = await get("/api/user/v1/profile-summary");
        assert.equal(profile.stats.orders, 1);
        assert.equal(profile.stats.spent, 50);
        const original = (await store.one("SELECT value FROM platform_settings WHERE id=1")).value;
        try {
          await store.query("UPDATE platform_settings SET value=value||$1::jsonb WHERE id=1", [{ features: { ...(original.features || {}), orders: false } }]);
          const hidden = await get("/api/user/v1/wallet?kind=reserve");
          assert.equal(hidden.items[0].order_id, undefined);
          assert.equal((await get("/api/user/v1/profile-summary")).stats.orders, undefined);
          await store.query("UPDATE platform_settings SET value=value||$1::jsonb WHERE id=1", [{ features: { ...(original.features || {}), orders: false, wallet: false } }]);
          assert.equal((await request("GET", "/api/user/v1/wallet", undefined, aliceCookie)).statusCode, 403);
          assert.deepEqual((await get("/api/user/v1/profile-summary")).stats, {});
        } finally { await store.query("UPDATE platform_settings SET value=$1 WHERE id=1", [original]); }
      });
      await t.test(
        "mail records show accepted/failed results without leaking SMTP secrets or message bodies",
        async () => {
          const nodemailer = require("nodemailer"),
            original = nodemailer.createTransport;
          const { sendMail } = require("../src/platform/mail");
          const settings = {
            ...(await store.settings()),
            smtp: {
              host: "smtp.example.test",
              port: 465,
              secure: true,
              user: "test",
              password: crypt.encrypt("SMTP_SECRET"),
              from: "test@example.test",
            },
          };
          try {
            nodemailer.createTransport = () => ({
              sendMail: async () => ({ accepted: ["receiver@example.test"] }),
              close() {},
            });
            await sendMail(
              store,
              crypt,
              settings,
              "receiver@example.test",
              "test",
              "Test",
              "PRIVATE_BODY_123456",
            );
            nodemailer.createTransport = () => ({
              sendMail: async () => {
                const e = new Error("SMTP_SECRET private server message");
                e.code = "EAUTH";
                throw e;
              },
              close() {},
            });
            await assert.rejects(
              () =>
                sendMail(
                  store,
                  crypt,
                  settings,
                  "receiver@example.test",
                  "test",
                  "Test",
                  "PRIVATE_BODY_123456",
                ),
              /邮件发送失败/,
            );
            const logs = (
              await request(
                "GET",
                "/api/admin/v1/mail/logs",
                undefined,
                adminCookie,
              )
            ).json();
            assert.equal(logs.total, 2);
            assert.equal(logs.items[0].status, "failed");
            assert.equal(logs.items[1].status, "sent");
            assert.ok(logs.items[0].detail.includes("EAUTH"));
            assert.ok(!JSON.stringify(logs).includes("SMTP_SECRET"));
            assert.ok(!JSON.stringify(logs).includes("PRIVATE_BODY"));
          } finally {
            nodemailer.createTransport = original;
          }
        },
      );
      await t.test(
        "site controls enforce feature access and keep private menus out of customer responses",
        async () => {
          const patch = async (body) =>
            request("PATCH", "/api/admin/v1/settings", body, adminCookie);
          const menu = (name, visibility) => ({
            id: name,
            label: name,
            url: `https://example.test/${name}`,
            visibility,
            enabled: true,
            open_new_tab: true,
            hide_open_button: false,
            icon: "",
          });
          const notices = [
            {
              id: "now",
              title: "Current",
              body: "Visible notice",
              enabled: true,
              starts_at: "",
              ends_at: "",
            },
            {
              id: "future",
              title: "Future secret",
              body: "Not yet",
              enabled: true,
              starts_at: "2099-01-01T00:00:00Z",
              ends_at: "",
            },
            {
              id: "expired",
              title: "Expired",
              body: "Old",
              enabled: true,
              starts_at: "",
              ends_at: "2000-01-01T00:00:00Z",
            },
          ];
          const saved = await patch({
            custom_menus: [
              menu("private-ops", "admin"),
              menu("member-help", "user"),
              menu("shared", "all"),
            ],
            announcements: notices,
          });
          assert.equal(saved.statusCode, 200, saved.body);
          const pub = (await request("GET", "/api/public")).json();
          assert.equal(pub.custom_menus, undefined);
          assert.deepEqual(
            pub.announcements.map((a) => a.id),
            ["now"],
          );
          const memberMenus = (
            await request(
              "GET",
              "/api/user/v1/navigation",
              undefined,
              aliceCookie,
            )
          ).json();
          assert.deepEqual(
            memberMenus.items.map((m) => m.id),
            ["member-help", "shared"],
          );
          assert.ok(!JSON.stringify(memberMenus).includes("private-ops"));
          const adminMenus = (
            await request(
              "GET",
              "/api/user/v1/navigation",
              undefined,
              adminCookie,
            )
          ).json();
          assert.deepEqual(
            adminMenus.items.map((m) => m.id),
            ["private-ops", "shared"],
          );
          assert.equal(
            (
              await patch({
                custom_menus: [
                  { ...menu("invalid", "all"), url: "javascript:alert(1)" },
                ],
              })
            ).statusCode,
            400,
          );
          assert.equal(
            (
              await patch({
                custom_menus: [
                  {
                    ...menu("icon", "all"),
                    icon:
                      "data:image/svg+xml;base64," +
                      Buffer.from(
                        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
                      ).toString("base64"),
                  },
                ],
              })
            ).statusCode,
            400,
          );
          const disabled = await patch({
            features: { accounts: false, docs: false },
          });
          assert.equal(disabled.statusCode, 200, disabled.body);
          assert.equal(
            (
              await request(
                "GET",
                "/api/user/v1/accounts",
                undefined,
                aliceCookie,
              )
            ).statusCode,
            403,
          );
          assert.equal(
            (
              await request(
                "GET",
                "/api/user/v1/accounts",
                undefined,
                adminCookie,
              )
            ).statusCode,
            200,
          );
          assert.equal((await request("GET", "/openapi.json")).statusCode, 403);
          assert.equal(
            (
              await patch({
                features: { accounts: true, docs: true },
                custom_menus: [],
                announcements: [],
              })
            ).statusCode,
            200,
          );
          assert.equal(
            (
              await request(
                "POST",
                "/api/admin/v1/mail/test",
                { email: "bad" },
                adminCookie,
              )
            ).statusCode,
            400,
          );
          assert.equal(
            (
              await request(
                "POST",
                "/api/admin/v1/mail/test",
                { email: "nobody@example.test" },
                adminCookie,
              )
            ).statusCode,
            503,
          );
        },
      );
      await t.test(
        "API scopes, Bearer-only access, revocation and public docs",
        async () => {
          const key = (
            await request(
              "POST",
              "/api/user/v1/keys",
              { name: "readonly", scopes: ["orders:read", "accounts:read"] },
              aliceCookie,
            )
          ).json();
          apiKey = key.key;
          const bearer = { authorization: `Bearer ${apiKey}` };
          assert.equal(
            (
              await request(
                "GET",
                "/open/v1/me",
                undefined,
                undefined,
                undefined,
                bearer,
              )
            ).statusCode,
            200,
          );
          assert.equal(
            (
              await request(
                "GET",
                `/open/v1/accounts/${accountId}/credentials`,
                undefined,
                undefined,
                undefined,
                bearer,
              )
            ).statusCode,
            403,
          );
          assert.equal(
            (
              await request(
                "POST",
                "/open/v1/registration-orders",
                { quantity: 1 },
                undefined,
                "api-order-001",
                bearer,
              )
            ).statusCode,
            403,
          );
          assert.equal(
            (await request("GET", "/open/v1/me", undefined, aliceCookie))
              .statusCode,
            401,
          );
          assert.equal(
            (
              await request(
                "GET",
                "/api/admin/v1/users",
                undefined,
                undefined,
                undefined,
                bearer,
              )
            ).statusCode,
            401,
          );
          await request(
            "DELETE",
            `/api/user/v1/keys/${key.id}`,
            undefined,
            aliceCookie,
          );
          assert.equal(
            (
              await request(
                "GET",
                "/open/v1/me",
                undefined,
                undefined,
                undefined,
                bearer,
              )
            ).statusCode,
            401,
          );
          const spec = (await request("GET", "/openapi.json")).json();
          assert.equal(spec.openapi, "3.1.0");
          assert.ok(!JSON.stringify(spec.paths).includes("/api/admin"));
        },
      );
      await t.test(
        "one redemption credits once under concurrent users",
        async () => {
          const code = (
            await request(
              "POST",
              "/api/admin/v1/redeem-codes",
              { points: 100, count: 1 },
              adminCookie,
            )
          ).json().codes[0];
          const rs = await Promise.all([
            request("POST", "/api/user/v1/redeem", { code }, aliceCookie),
            request("POST", "/api/user/v1/redeem", { code }, bobCookie),
          ]);
          assert.equal(rs.filter((r) => r.statusCode === 200).length, 1);
        },
      );
      await t.test(
        "operations can create members and bulk edit only unused redemption codes",
        async () => {
          const created = await request(
            "POST",
            "/api/admin/v1/users",
            {
              email: "created@example.test",
              name: "Created",
              password: "CreatedPassword123!",
              role: "admin",
            },
            adminCookie,
          );
          assert.equal(created.statusCode, 200, created.body);
          const user = await store.one(
            "SELECT role,points FROM platform_users WHERE id=$1",
            [created.json().id],
          );
          assert.deepEqual(user, { role: "member", points: 0 });
          const generated = (
            await request(
              "POST",
              "/api/admin/v1/redeem-codes",
              { points: 10, count: 2 },
              adminCookie,
            )
          ).json();
          assert.equal(generated.codes.length, 2);
          const list = (
            await request(
              "GET",
              "/api/admin/v1/redeem-codes",
              undefined,
              adminCookie,
            )
          ).json();
          assert.equal(list.total, 3);
          const used = list.items.find((c) => c.redeemed_by);
          assert.ok(used);
          const result = await request(
            "POST",
            "/api/admin/v1/redeem-codes/batch",
            { ids: list.items.map((c) => c.id), action: "delete" },
            adminCookie,
          );
          assert.equal(result.statusCode, 200, result.body);
          assert.equal(result.json().changed, 2);
          assert.equal(result.json().skipped, 1);
          assert.ok(
            await store.one(
              "SELECT id FROM platform_redeem_codes WHERE id=$1",
              [used.id],
            ),
          );
          const audit = (
            await request(
              "GET",
              "/api/admin/v1/audit?q=redeem.delete",
              undefined,
              adminCookie,
            )
          ).json();
          assert.equal(audit.total, 1);
          assert.equal(audit.items[0].actor_email, "admin");
        },
      );
      await t.test("redemption codes preserve encrypted originals, batches, expiry and private exports", async () => {
        const issued = (await request("POST", "/api/admin/v1/redeem-codes", { points: 25, count: 3, days: 7, batch: "expiry-check" }, adminCookie)).json();
        assert.equal(issued.codes.length, 3);
        const list = (await request("GET", "/api/admin/v1/redeem-codes?q=expiry-check", undefined, adminCookie)).json();
        assert.equal(list.total, 3);
        assert.ok(list.items.every((row) => row.copyable && row.batch === "expiry-check" && row.status === "available"));
        assert.ok(!JSON.stringify(list).includes(issued.codes[0]));
        const saved = await store.one("SELECT * FROM platform_redeem_codes WHERE id=$1", [list.items[0].id]);
        assert.ok(saved.encrypted_code.startsWith("v1."));
        assert.ok(!JSON.stringify(saved).includes(issued.codes[0]));
        const ids = list.items.map((row) => row.id);
        const copied = await request("POST", "/api/admin/v1/redeem-codes/batch", { ids, action: "copy" }, adminCookie);
        assert.deepEqual(copied.json().codes.slice().sort(), issued.codes.slice().sort());
        assert.equal((await request("POST", "/api/admin/v1/redeem-codes/batch", { ids, action: "copy" }, aliceCookie)).statusCode, 403);
        await store.query("UPDATE platform_redeem_codes SET expires_at=now()-interval '1 minute' WHERE id=$1", [ids[0]]);
        const expired = copied.json().codes[0];
        assert.equal((await request("POST", "/api/user/v1/redeem", { code: expired }, aliceCookie)).statusCode, 400);
        await request("PATCH", `/api/admin/v1/redeem-codes/${ids[1]}`, { disabled: true }, adminCookie);
        const exported = (await request("POST", "/api/admin/v1/redeem-codes/batch", { ids, action: "export" }, adminCookie)).json();
        assert.equal(exported.codes.length, 1);
        assert.equal(exported.skipped, 2);
        assert.equal((await request("GET", "/api/admin/v1/redeem-codes?q=expiry-check&status=expired", undefined, adminCookie)).json().total, 1);
        // Legacy codes remain redeemable but cannot be reconstructed from hashes.
        await store.query("UPDATE platform_redeem_codes SET encrypted_code=NULL WHERE id=$1", [ids[2]]);
        assert.equal((await request("POST", "/api/admin/v1/redeem-codes/batch", { ids: [ids[2]], action: "copy" }, adminCookie)).statusCode, 409);
        const logs = (await request("GET", "/api/admin/v1/audit?q=redeem", undefined, adminCookie)).json();
        assert.ok(issued.codes.every((code) => !JSON.stringify(logs).includes(code)));
      });
      await t.test(
        "OAuth only retries the existing account and settles at the OAuth price",
        async () => {
          const created = (
            await orders.create(
              alice,
              { quantity: 1, need_oauth: true },
              "oauth-worker-001",
              "web",
            )
          ).order;
          const states = new Map(),
            assets = new Map(),
            calls = [];
          const manager = {
            activeRuns: () => [],
            setCustomerConcurrency() {},
            setCustomerPendingRuns() {},
            isTaskSlotBusy: () => false,
            activeRun: () => null,
            load: (rid) => {
              if (!states.has(rid)) throw new Error("missing");
              return states.get(rid);
            },
            sessionAssets: () => ({ get: (key) => assets.get(key) }),
            async start(plan, { runId }) {
              calls.push(plan);
              states.set(runId, { status: "complete", jobs: [] });
              return { runId };
            },
          };
          const worker = new OrderWorker(store, orders, manager);
          await worker.cycle();
          const item = await store.one(
            "SELECT * FROM platform_items WHERE order_id=$1",
            [created.id],
          );
          assert.equal(calls[0].taskKind, "register_session");
          assert.equal(calls[0].postRegistrationOAuth, true);
          const asset = {
            id: id(),
            email: "oauth-account@example.test",
            password: "OAuthPassword",
            totpSecret: "JBSWY3DPEHPK3PXP",
            security: {
              passwordStatus: "configured",
              totpStatus: "configured",
            },
          };
          assets.set(asset.id, asset);
          states.get(item.run_id).jobs = [{ sessionAssetId: asset.id }];
          worker.credentials = (a, need) =>
            need
              ? null
              : {
                  asset_id: a.id,
                  email: a.email,
                  password: a.password,
                  totp_secret: a.totpSecret,
                };
          await worker.cycle();
          assert.equal(calls[1].taskKind, "oauth");
          assert.deepEqual(calls[1].oauthSource.assetIds, [asset.id]);
          const after = await store.one(
            "SELECT * FROM platform_items WHERE id=$1",
            [item.id],
          );
          states.get(after.run_id).jobs = [{ assetId: asset.id }];
          await worker.cycle();
          const waiting = await store.one(
            "SELECT * FROM platform_items WHERE id=$1",
            [item.id],
          );
          assert.equal(waiting.status, "oauth_pending");
          assert.equal(waiting.attempts, 1);
          await store.query(
            "UPDATE platform_items SET available_at=now() WHERE id=$1",
            [item.id],
          );
          await worker.cycle();
          assert.equal(calls[2].taskKind, "oauth");
          worker.credentials = (a) => ({
            asset_id: a.id,
            email: a.email,
            password: a.password,
            totp_secret: a.totpSecret,
            oauth: {
              refresh_token: "test-refresh",
              access_token: "test-access",
            },
          });
          const last = await store.one(
            "SELECT * FROM platform_items WHERE id=$1",
            [item.id],
          );
          states.get(last.run_id).jobs = [{ assetId: asset.id }];
          await worker.cycle();
          const final = await orders.detail(alice.id, created.id);
          assert.equal(final.status, "completed");
          assert.equal(final.charged, 100);
          assert.equal(calls.length, 3);
        },
      );
      await t.test(
        "missing checkpoint after restart enters review instead of duplicate registration",
        async () => {
          const o = (
            await orders.create(
              alice,
              { quantity: 1 },
              "recovery-worker-001",
              "web",
            )
          ).order;
          const item = await store.one(
            "SELECT * FROM platform_items WHERE order_id=$1",
            [o.id],
          );
          await store.query(
            "UPDATE platform_items SET status='running',run_id=$2,attempt_started_at=now() WHERE id=$1",
            [item.id, `customer-${id()}`],
          );
          let started = false;
          const manager = {
            load() {
              throw new Error("missing");
            },
            setCustomerConcurrency() {},
            setCustomerPendingRuns() {},
            activeRun: () => null,
            activeRuns: () => [],
            isTaskSlotBusy: () => false,
            start() {
              started = true;
            },
          };
          const w = new OrderWorker(store, orders, manager);
          await w.cycle();
          assert.equal(started, false);
          assert.equal((await orders.detail(alice.id, o.id)).status, "review");
        },
      );
      await t.test(
        "invalid email code counts survive transactions; password reset revokes sessions",
        async () => {
          await store.query(
            "INSERT INTO platform_email_codes(email,purpose,hash,expires_at) VALUES($1,'reset',$2,now()+interval '15 minutes')",
            [alice.email, digest(`${alice.email}:reset:123456`)],
          );
          assert.equal(
            (
              await request("POST", "/api/auth/reset-password", {
                email: alice.email,
                code: "000000",
                password: "NewMemberPassword123!",
              })
            ).statusCode,
            400,
          );
          assert.equal(
            (
              await store.one(
                "SELECT attempts FROM platform_email_codes WHERE email=$1 AND purpose='reset'",
                [alice.email],
              )
            ).attempts,
            1,
          );
          assert.equal(
            (
              await request("POST", "/api/auth/reset-password", {
                email: alice.email,
                code: "123456",
                password: "NewMemberPassword123!",
              })
            ).statusCode,
            200,
          );
          assert.equal(
            (await request("GET", "/api/user/v1/me", undefined, aliceCookie))
              .statusCode,
            401,
          );
        },
      );
      await t.test(
        "cancellation racing with retry or OAuth transition releases points exactly once",
        async () => {
          const o = (
            await orders.create(
              alice,
              { quantity: 1, need_oauth: true },
              "cancel-race-order-001",
              "web",
            )
          ).order;
          const item = await store.one(
            "SELECT * FROM platform_items WHERE order_id=$1",
            [o.id],
          );
          await store.query(
            "UPDATE platform_items SET status='running' WHERE id=$1",
            [item.id],
          );
          const w = new OrderWorker(store, orders, {});
          await Promise.all([
            orders.cancel(alice.id, o.id),
            w.queueNext(item, "oauth_pending", "等待授权"),
          ]);
          const final = await orders.detail(alice.id, o.id);
          assert.equal(final.status, "cancelled");
          assert.equal(final.released, 100);
          await w.queueNext(item, "queued", "过期重试");
          assert.equal((await orders.detail(alice.id, o.id)).released, 100);
        },
      );
      await t.test(
        "legacy management proxy is admin-only and forwards internal authentication",
        async () => {
          const engine = require("fastify")();
          let forwarded;
          engine.get("/api/v1/health", (r) => {
            forwarded = r.headers;
            return { ok: true };
          });
          await engine.listen({ host: "127.0.0.1", port: 0 });
          const gateway = buildPlatform({
            db: store,
            orders,
            crypt,
            secrets: { internal: "engine-secret" },
            workerUrl: `http://127.0.0.1:${engine.server.address().port}`,
          });
          try {
            const response = await gateway.inject({
              url: "/api/v1/health",
              headers: { cookie: adminCookie, "x-gptreg-actor": "spoofed" },
            });
            assert.equal(response.statusCode, 200, response.body);
            assert.equal(forwarded.authorization, "Bearer engine-secret");
            assert.notEqual(forwarded["x-gptreg-actor"], "spoofed");
            assert.equal(
              (
                await gateway.inject({
                  url: "/api/v1/health",
                  headers: { cookie: bobCookie },
                })
              ).statusCode,
              403,
            );
          } finally {
            await gateway.close();
            await engine.close();
          }
        },
      );
    } finally {
      await app.close();
      await store.close();
      const cleanup = new Database(connection);
      await cleanup.query(`DROP SCHEMA ${schema} CASCADE`);
      await cleanup.close();
    }
  },
);
