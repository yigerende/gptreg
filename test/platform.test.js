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
          assert.equal(calls[0].postRegistrationOAuth, false);
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
