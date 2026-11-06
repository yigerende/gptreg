"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const Ajv = require("ajv/dist/2020");
const { openapi } = require("../src/platform/openapi");
const { Database } = require("../src/platform/db");
const { Orders } = require("../src/platform/orders");
const { buildPlatform } = require("../src/platform/app");
const { cipher } = require("../src/platform/security");
const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
const deref = (value) =>
  value.$ref
    ? value.$ref
        .slice(2)
        .split("/")
        .reduce((s, k) => s[k], openapi)
    : value;
function conforms(schema, body) {
  const validate = ajv.compile({ ...schema, components: openapi.components });
  assert.ok(validate(body), JSON.stringify(validate.errors));
}
test("OpenAPI examples conform to schemas and cover only the nine public operations", () => {
  let count = 0;
  for (const [path, methods] of Object.entries(openapi.paths)) {
    assert.ok(path.startsWith("/open/v1/"));
    for (const op of Object.values(methods)) {
      count++;
      assert.ok(op.operationId);
      for (const response of Object.values(op.responses)) {
        const media = deref(response).content["application/json"];
        for (const example of media.examples
          ? Object.values(media.examples).map((x) => x.value)
          : [media.example])
          conforms(media.schema, example);
      }
      if (op.requestBody) {
        const media = op.requestBody.content["application/json"];
        for (const example of Object.values(media.examples))
          conforms(media.schema, example.value);
      }
    }
  }
  assert.equal(count, 9);
});
const connection =
  process.env.GPTREG_TEST_DATABASE_URL ||
  (fs.existsSync(".local/platform-test/connection.json")
    ? JSON.parse(fs.readFileSync(".local/platform-test/connection.json")).url
    : "");
test(
  "documented public API matches real responses, filtering, retry and export formats",
  { skip: !connection },
  async () => {
    const setup = new Database(connection),
      schema = `docs_${crypto.randomBytes(8).toString("hex")}`;
    await setup.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(connection);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const db = new Database(url.href),
      crypt = cipher(crypto.randomBytes(32).toString("base64")),
      orders = new Orders(db, crypt, { registrationPools: () => [{ countryCode: "JP", total: 2 }] });
    const app = buildPlatform({
      db,
      crypt,
      orders,
      secrets: { internal: "test" },
      proxy: false,
    });
    try {
      await db.initialize();
  await db.query("UPDATE platform_settings SET value=jsonb_set(value,'{login_slider_enabled}','false') WHERE id=1");
      await db.query(
        "UPDATE platform_settings SET value=value||$1::jsonb WHERE id=1",
        [JSON.stringify({ orders_open: true, worker_enabled: false })],
      );
      await app.ready();
      const registration = await app.inject({
        method: "POST",
        url: "/api/auth/register",
        headers: { "x-requested-with": "gptreg" },
        payload: {
          email: "docs@example.test",
          name: "Docs fixture",
          password: "DocsFixturePassword123!",
        },
      });
      assert.equal(registration.statusCode, 200, registration.body);
      const cookie = registration.headers["set-cookie"].split(";")[0];
      const user = await db.one(
        "UPDATE platform_users SET points=5000 WHERE email='docs@example.test' RETURNING *",
      );
      const key = await app.inject({
        method: "POST",
        url: "/api/user/v1/keys",
        headers: { cookie, "x-requested-with": "gptreg" },
        payload: {
          name: "docs contract",
          scopes: Object.keys(openapi["x-scopes"]),
        },
      });
      assert.equal(key.statusCode, 200, key.body);
      const authorization = `Bearer ${key.json().key}`;
      const seen = new Set();
      async function request(
        method,
        path,
        actualUrl = path,
        body,
        extra = {},
        status = 200,
      ) {
        const res = await app.inject({
          method,
          url: actualUrl,
          headers: { authorization, ...extra },
          ...(body === undefined ? {} : { payload: body }),
        });
        assert.equal(res.statusCode, status, res.body);
        const op = openapi.paths[path][method.toLowerCase()];
        conforms(
          deref(op.responses[status]).content["application/json"].schema,
          res.json(),
        );
        seen.add(op.operationId);
        return res.json();
      }
      const me = await request("GET", "/open/v1/me");
      assert.equal(me.points, 5000);
      const products = await request("GET", "/open/v1/products");
      assert.equal(products.products[1].unit_price, 100);
      const regions = await request("GET", "/open/v1/registration-regions");
      assert.equal(regions.default_region, "random");
      assert.deepEqual(regions.regions, [{ code: "JP", name: "日本" }]);
      const body = { quantity: 2, need_oauth: true },
        headers = { "idempotency-key": "documentation-contract-001" };
      const created = await request(
        "POST",
        "/open/v1/registration-orders",
        undefined,
        body,
        headers,
        202,
      );
      const replay = await request(
        "POST",
        "/open/v1/registration-orders",
        undefined,
        body,
        headers,
        200,
      );
      assert.equal(replay.id, created.id);
      await request(
        "POST",
        "/open/v1/registration-orders",
        undefined,
        { ...body, quantity: 1 },
        headers,
        409,
      );
      const balance = await request("GET", "/open/v1/me");
      assert.equal(balance.points, 4800);
      assert.equal(balance.frozen, 200);
      const filtered = await request(
        "GET",
        "/open/v1/registration-orders",
        "/open/v1/registration-orders?mode=oauth&status=queued&q=DOCS%40EXAMPLE.TEST&limit=1&offset=0",
      );
      assert.equal(filtered.total, 1);
      assert.equal(filtered.limit, 1);
      assert.equal(
        (
          await request(
            "GET",
            "/open/v1/registration-orders",
            "/open/v1/registration-orders?mode=standard",
          )
        ).total,
        0,
      );
      const detail = await request(
        "GET",
        "/open/v1/registration-orders/{id}",
        `/open/v1/registration-orders/${created.id}`,
      );
      assert.equal(detail.items.length, 2);
      const credentials = {
        asset_id: "docs-test-asset",
        email: "docs.delivery@gmail.com",
        password: "FICTIONAL_PASSWORD",
        totp_secret: "JBSWY3DPEHPK3PXP",
        access_token: "WEB_AT_DIFFERENT_FROM_OAUTH",
        session_token: "full-session-" + "0123456789".repeat(1600),
        oauth: {
          access_token: "FAKE_ACCESS_TOKEN",
          refresh_token: "FAKE_REFRESH_TOKEN",
          extra_metadata: "retained",
        },
      };
      const jwt = (value) =>
        Buffer.from('{"alg":"none"}').toString("base64url") +
        "." +
        Buffer.from(JSON.stringify(value)).toString("base64url") +
        ".fixture";
      credentials.oauth.access_token = jwt({
        exp: 1900000000,
        "https://api.openai.com/auth": {
          chatgpt_account_id: "contract-account",
          chatgpt_plan_type: "free",
        },
      });
      credentials.oauth.id_token = jwt({ email: credentials.email });
      // Simulate a completed delivery in the isolated schema; never contact providers.
      await orders.finish(detail.items[0].id, credentials);
      const beforeCancel = await orders.detail(user.id, created.id);
      const balanceBefore = await db.one("SELECT points,frozen FROM platform_users WHERE id=$1", [user.id]);
      for (const prefix of ["/api/user/v1", "/open/v1"]) {
        for (const orderId of [created.id, "unknown-order"]) {
          const denied = await app.inject({ method: "POST", url: `${prefix}/registration-orders/${orderId}/cancel`,
            headers: prefix === "/open/v1" ? { authorization } : { cookie, "x-requested-with": "gptreg" } });
          assert.equal(denied.statusCode, 403, denied.body);
        }
      }
      assert.deepEqual(await orders.detail(user.id, created.id), beforeCancel);
      assert.deepEqual(await db.one("SELECT points,frozen FROM platform_users WHERE id=$1", [user.id]), balanceBefore);
      const deniedAdmin = await app.inject({ method: "POST", url: `/api/admin/v1/orders/${created.id}/cancel`, headers: { cookie, "x-requested-with": "gptreg" } });
      assert.equal(deniedAdmin.statusCode, 403);
      // Only the authenticated administrator endpoint retains cancellation.
      await db.query("UPDATE platform_users SET role='admin' WHERE id=$1", [user.id]);
      const adminCancel = await app.inject({ method: "POST", url: `/api/admin/v1/orders/${created.id}/cancel`, headers: { cookie, "x-requested-with": "gptreg" } });
      assert.equal(adminCancel.statusCode, 200, adminCancel.body);
      assert.equal(adminCancel.json().released, 100);
      await db.query("UPDATE platform_users SET role='member' WHERE id=$1", [user.id]);
      const accounts = await request(
        "GET",
        "/open/v1/accounts",
        `/open/v1/accounts?order_id=${created.id}&q=DELIVERY%40GMAIL.COM&mode=oauth&limit=1&offset=0`,
      );
      assert.equal(accounts.total, 1);
      assert.equal(accounts.items.length, 1);
      assert.equal(accounts.items[0].password, undefined);
      const account = accounts.items[0];
      const secrets = await request(
        "GET",
        "/open/v1/accounts/{id}/credentials",
        `/open/v1/accounts/${account.id}/credentials`,
      );
      assert.match(secrets.totp_code, /^\d{6}$/);
      assert.equal(secrets.oauth.extra_metadata, "retained");
      assert.equal(secrets.access_token,credentials.access_token);assert.equal(secrets.session_token,credentials.session_token);
      for (const [format, field] of [["email_at","access_token"],["email_session","session_token"]]) {
        const exported=await request("POST","/open/v1/accounts/export",undefined,{ids:[account.id],format});
        assert.equal(exported.content,`${credentials.email}----${credentials[field]}\n`);
        assert.match(exported.filename,/\.txt$/);
      }
      for (const format of ["json", "csv", "txt"]) {
        const exported = await request(
          "POST",
          "/open/v1/accounts/export",
          undefined,
          { ids: [account.id, account.id], format },
        );
        assert.equal(exported.filename, `gptreg-accounts.${format}`);
        if (format === "json") {
          assert.deepEqual(JSON.parse(exported.content), [credentials]);
          assert.equal(JSON.parse(exported.content)[0].totp_code, undefined);
        }
        if (format === "csv")
          assert.ok(
            exported.content.startsWith("\uFEFFemail,password,totp_secret\r\n"),
          );
        if (format === "txt")
          assert.equal(
            exported.content,
            `${credentials.email}----${credentials.password}----${credentials.totp_secret}\n`,
          );
      }
      for (const format of ["cpa", "sub"]) {
        const exported = await request(
          "POST",
          "/open/v1/accounts/export",
          undefined,
          { ids: [account.id], format },
        );
        const value = JSON.parse(exported.content);
        if (format === "cpa") {
          assert.equal(value.type, "codex");
          assert.equal(value.access_token, credentials.oauth.access_token);
          assert.ok(!value.password);
          assert.ok(!Array.isArray(value));
        } else {
          assert.deepEqual(value.proxies, []);
          assert.equal(value.accounts.length, 1);
          assert.equal(
            value.accounts[0].credentials.chatgpt_account_id,
            "contract-account",
          );
          assert.equal(value.accounts[0].platform, "openai");
        }
        await request(
          "POST",
          "/open/v1/accounts/export",
          undefined,
          { ids: [account.id, "missing"], format },
          {},
          404,
        );
      }
      await request(
        "POST",
        "/open/v1/accounts/export",
        undefined,
        { ids: [account.id, "missing"], format: "json" },
        {},
        404,
      );
      await request(
        "GET",
        "/open/v1/registration-orders",
        "/open/v1/registration-orders?status=oauth_pending",
        undefined,
        {},
        400,
      );
      const unauthorized = await app.inject({
        method: "GET",
        url: "/open/v1/me",
        headers: { cookie },
      });
      assert.equal(unauthorized.statusCode, 401);
      assert.equal(seen.size, 9);
    } finally {
      await app.close();
      await db.close();
      await setup.query(`DROP SCHEMA ${schema} CASCADE`);
      await setup.close();
    }
  },
);
