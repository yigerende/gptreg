"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { Database } = require("../src/platform/db");
const { Orders } = require("../src/platform/orders");
const { cipher, digest } = require("../src/platform/security");
const { buildPlatform } = require("../src/platform/app");
const { availableAccount } = require("../src/platform/account-retention");
const connection =
  process.env.GPTREG_TEST_DATABASE_URL ||
  (fs.existsSync(".local/platform-test/connection.json")
    ? JSON.parse(fs.readFileSync(".local/platform-test/connection.json")).url
    : "");

test(
  "delivery retention: 72-hour customer boundary, grouped selection and administrator preservation",
  { skip: !connection },
  async (t) => {
    const setup = new Database(connection),
      schema = `retention_${crypto.randomBytes(8).toString("hex")}`;
    await setup.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(connection);
    url.searchParams.set("options", `-c search_path=${schema}`);
    const db = new Database(url.href),
      crypt = cipher(crypto.randomBytes(32).toString("base64"));
    const orders = new Orders(db, crypt),
      app = buildPlatform({
        db,
        crypt,
        orders,
        secrets: { internal: "test" },
        proxy: false,
      });
    t.after(async () => {
      await app.close();
      await db.close();
      await setup.query(`DROP SCHEMA ${schema} CASCADE`);
      await setup.close();
    });
    await db.initialize();
    await app.ready();
    for (const who of ["alice", "bob", "admin"]) {
      await db.query(
        "INSERT INTO platform_users(id,email,name,password_hash,role) VALUES($1,$2,$1,'unused',$3)",
        [who, `${who}@example.test`, who === "admin" ? "admin" : "member"],
      );
      await db.query(
        "INSERT INTO platform_sessions(hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 day')",
        [digest(who), who],
      );
    }
    await db.query(
      "INSERT INTO platform_api_keys(id,user_id,name,hash,prefix,scopes) VALUES('key','alice','test',$1,'gr_test',$2::jsonb)",
      [
        digest("gr_" + "x".repeat(43)),
        JSON.stringify(["orders:read", "accounts:read", "credentials:read"]),
      ],
    );
    const request = (path, body, who = "alice", api = false) =>
      app.inject({
        method: body ? "POST" : "GET",
        url: path,
        headers: {
          "x-requested-with": "gptreg",
          ...(api
            ? { authorization: "Bearer gr_" + "x".repeat(43) }
            : { cookie: `gptreg_session=${who}` }),
        },
        ...(body ? { payload: body } : {}),
      });
    const get = async (path, who) => {
      const r = await request(path, undefined, who);
      assert.equal(r.statusCode, 200, r.body);
      return r.json();
    };
    const jwt =
      "e30." +
      Buffer.from(
        JSON.stringify({
          exp: 1900000000,
          "https://api.openai.com/auth": { chatgpt_account_id: "fixture" },
        }),
      ).toString("base64url") +
      ".fixture";
    const creds = {
      asset_id: "fixture",
      email: "fixture@gmail.com",
      password: "fixture-secret",
      totp_secret: "JBSWY3DPEHPK3PXP",
      access_token: "fixture-web-at",
      session_token: "fixture-full-session",
      oauth: {
        access_token: jwt,
        id_token: jwt,
        refresh_token: "fixture-refresh",
      },
    };
    async function batch(order, count, owner = "alice", oauth = true) {
      await db.query(
        `INSERT INTO platform_orders(id,user_id,quantity,need_oauth,unit_price,status,delivered,charged,source,request_key,request_hash,template,attempt_limit,timeout_minutes)
      VALUES($1,$2,$3,$4,1,'completed',$3,$3,'web',$1,$1,'{}',1,1)`,
        [order, owner, count, oauth],
      );
      await db.query(
        `INSERT INTO platform_items(id,order_id,position,status,asset_id) SELECT $1||'-'||n,$1,n,'delivered',$1||'-'||n FROM generate_series(1,$2::int) n`,
        [order, count],
      );
      await db.query(
        `INSERT INTO platform_accounts(id,user_id,order_id,item_id,asset_id,email,need_oauth,credentials,engine_sold_at)
      SELECT id,$2,order_id,id,id,id||'@gmail.com',$3,$4,now() FROM platform_items WHERE order_id=$1`,
        [order, owner, oauth, crypt.encrypt(creds)],
      );
      await db.query(
        "INSERT INTO platform_ledger(id,user_id,reference,kind,points_delta,frozen_delta,note) VALUES($1,$2,$1,'charge',0,$3,'fixture')",
        [order, owner, -count],
      );
    }
    await batch("mixed", 4);
    await batch("bulk", 1000);
    await batch("standard", 3, "alice", false);
    await batch("foreign", 1, "bob");
    await batch("expired-order", 1);
    await db.query(
      "UPDATE platform_accounts SET created_at=now()-interval '71 hours' WHERE id='mixed-2'",
    );
    await db.query(
      "UPDATE platform_accounts SET created_at=now()-interval '72 hours' WHERE id='mixed-3'",
    );
    await db.query(
      "UPDATE platform_accounts SET created_at=now()-interval '73 hours' WHERE id IN ('mixed-4','expired-order-1')",
    );
    const snapshot = (
      await db.query("SELECT * FROM platform_accounts ORDER BY id")
    ).rows;
    const ledgerBefore = (
      await db.query("SELECT * FROM platform_ledger ORDER BY id")
    ).rows;
    const orderBefore = (
      await db.query("SELECT * FROM platform_orders ORDER BY id")
    ).rows;

    await t.test(
      "database timestamp boundary includes just-before and excludes exactly-at/after 72 hours",
      async () => {
        const rows = (
          await db.query(`SELECT label,${availableAccount()} AS available FROM (VALUES
      ('fresh',now()),('before',now()-interval '72 hours'+interval '1 microsecond'),
      ('at',now()-interval '72 hours'),('after',now()-interval '73 hours')) fixture(label,created_at)`)
        ).rows;
        assert.deepEqual(
          Object.fromEntries(rows.map((r) => [r.label, r.available])),
          { fresh: true, before: true, at: false, after: false },
        );
      },
    );
    await t.test(
      "grouping, pagination, search and bounded selection expose only the user's unexpired accounts",
      async () => {
        const groups = await get("/api/user/v1/account-orders?limit=1");
        assert.equal(groups.total, 3);
        assert.equal(groups.accounts_total, 1005);
        assert.equal(groups.items.length, 1);
        const second = await get(
          "/api/user/v1/account-orders?limit=1&offset=1",
        );
        assert.notEqual(second.items[0].id, groups.items[0].id);
        const mixed = await get("/api/user/v1/account-orders?order_id=mixed");
        assert.equal(mixed.items[0].available_count, 2);
        const accounts = await get("/api/user/v1/accounts?order_id=mixed");
        assert.equal(accounts.total, 2);
        for (const row of accounts.items) {
          assert.equal(
            Date.parse(row.download_expires_at) - Date.parse(row.created_at),
            72 * 3600000,
          );
          assert.equal(row.credentials, undefined);
        }
        assert.equal(
          mixed.items[0].download_expires_at,
          accounts.items[1].download_expires_at,
        );
        const selected = await get(
          "/api/user/v1/accounts/selection?limit=99999",
        );
        assert.equal(selected.total, 1005);
        assert.equal(selected.items.length, 1000);
        assert.equal(new Set(selected.items.map((r) => r.id)).size, 1000);
        assert.ok(
          selected.items.every(
            (r) =>
              !["mixed-3", "mixed-4", "foreign-1", "expired-order-1"].includes(
                r.id,
              ),
          ),
        );
        for (const endpoint of [
          "account-orders",
          "accounts",
          "accounts/selection",
        ]) {
          const single = await get(
            `/api/user/v1/${endpoint}?q=MIXED-2%40GMAIL.COM&mode=oauth`,
          );
          assert.equal(single.total, 1);
          assert.equal(
            (await get(`/api/user/v1/${endpoint}?order_id=foreign`)).total,
            0,
          );
          assert.equal((await get(`/api/user/v1/${endpoint}?q=%25`)).total, 0);
        }
        assert.equal(
          (await get("/api/user/v1/accounts/selection?mode=standard")).items
            .length,
          3,
        );
        assert.equal(
          (await get("/api/user/v1/accounts/selection?order_id=mixed")).items
            .length,
          2,
        );
        assert.equal(
          (await request("/api/user/v1/account-orders", undefined, "missing"))
            .statusCode,
          401,
        );
      },
    );
    await t.test(
      "saved IDs cannot bypass expiry in credentials or any export format through cookie or API key",
      async () => {
        for (const api of [false, true]) {
          const prefix = api ? "/open/v1" : "/api/user/v1";
          const listed = await request(
            `${prefix}/accounts?order_id=mixed`,
            undefined,
            "alice",
            api,
          );
          assert.equal(listed.statusCode, 200, listed.body);
          assert.equal(listed.json().total, 2);
          for (const id of [
            "mixed-3",
            "mixed-4",
            "foreign-1",
            "expired-order-1",
          ]) {
            const r = await request(
              `${prefix}/accounts/${id}/credentials`,
              undefined,
              "alice",
              api,
            );
            assert.equal(r.statusCode, 404, r.body);
            assert.ok(!r.body.includes(creds.password));
          }
          const fresh = await request(
            `${prefix}/accounts/mixed-2/credentials`,
            undefined,
            "alice",
            api,
          );
          assert.equal(fresh.statusCode, 200, fresh.body);
          assert.equal(fresh.json().password, creds.password);
          assert.ok(fresh.json().download_expires_at);
          for (const format of ["txt", "csv", "json", "cpa", "sub", "email_at", "email_session"]) {
            const denied = await request(
              `${prefix}/accounts/export`,
              { ids: ["mixed-1", "mixed-3"], format },
              "alice",
              api,
            );
            assert.equal(denied.statusCode, 404, denied.body);
            assert.ok(!denied.body.includes(creds.password));
            const allowed = await request(
              `${prefix}/accounts/export`,
              { ids: ["mixed-1"], format },
              "alice",
              api,
            );
            assert.equal(allowed.statusCode, 200, allowed.body);
          }
          const tooMany = await request(
            `${prefix}/accounts/export`,
            { ids: Array.from({ length: 1001 }, () => "mixed-1") },
            "alice",
            api,
          );
          assert.equal(tooMany.statusCode, 400);
        }
      },
    );
    await t.test(
      "expiry applies immediately after delivery timestamp crosses the boundary without a cleanup worker",
      async () => {
        const original = snapshot.find((r) => r.id === "mixed-1");
        await db.query(
          "UPDATE platform_accounts SET created_at=now()-interval '72 hours' WHERE id='mixed-1'",
        );
        assert.equal(
          (await get("/api/user/v1/accounts?order_id=mixed")).total,
          1,
        );
        assert.equal(
          (await get("/api/user/v1/account-orders?order_id=mixed")).items[0]
            .available_count,
          1,
        );
        assert.equal(
          (await get("/api/user/v1/accounts/selection?order_id=mixed")).total,
          1,
        );
        assert.equal(
          (await request("/api/user/v1/accounts/mixed-1/credentials"))
            .statusCode,
          404,
        );
        await db.query(
          "UPDATE platform_accounts SET created_at=$1 WHERE id='mixed-1'",
          [original.created_at],
        );
      },
    );
    await t.test(
      "admins keep complete expired deliveries; orders, ledger, encrypted data and sold flags stay intact",
      async () => {
        assert.equal(
          (await get("/api/admin/v1/accounts", "admin")).total,
          1009,
        );
        const value = await get(
          "/api/admin/v1/accounts/mixed-4/credentials",
          "admin",
        );
        assert.equal(value.password, creds.password);
        assert.ok(value.delivery.engine_sold_at);
        for (const format of ["txt", "csv", "json", "cpa", "sub", "email_at", "email_session"])
          assert.equal(
            (
              await request(
                "/api/admin/v1/accounts/export",
                { ids: ["mixed-4"], format },
                "admin",
              )
            ).statusCode,
            200,
          );
        assert.equal(
          (await request("/api/admin/v1/accounts/mixed-4/credentials"))
            .statusCode,
          403,
        );
        assert.equal((await get("/api/user/v1/registration-orders")).total, 4);
        assert.equal(
          (await get("/api/user/v1/registration-orders/expired-order"))
            .delivered,
          1,
        );
        assert.deepEqual(
          (await db.query("SELECT * FROM platform_accounts ORDER BY id")).rows,
          snapshot,
        );
        assert.deepEqual(
          (await db.query("SELECT * FROM platform_ledger ORDER BY id")).rows,
          ledgerBefore,
        );
        assert.deepEqual(
          (await db.query("SELECT * FROM platform_orders ORDER BY id")).rows,
          orderBefore,
        );
      },
    );
    await t.test(
      "new grouping and selection endpoints respect the accounts feature gate",
      async () => {
        await db.query(
          "UPDATE platform_settings SET value=jsonb_set(value,'{features,accounts}','false') WHERE id=1",
        );
        for (const suffix of [
          "account-orders",
          "accounts/selection",
          "accounts",
        ])
          assert.equal(
            (await request(`/api/user/v1/${suffix}`)).statusCode,
            403,
          );
        assert.equal(
          (await request("/api/admin/v1/accounts", undefined, "admin"))
            .statusCode,
          200,
        );
      },
    );
  },
);
