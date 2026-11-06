"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { Database } = require("../src/platform/db");
const { Orders } = require("../src/platform/orders");
const { buildPlatform } = require("../src/platform/app");
const { cipher, digest, id } = require("../src/platform/security");
const connection = process.env.GPTREG_TEST_DATABASE_URL;

async function fixture(t) {
  const setup = new Database(connection), schema = `regions_${crypto.randomBytes(8).toString("hex")}`;
  await setup.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(connection);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const db = new Database(url.href), crypt = cipher(crypto.randomBytes(32).toString("base64"));
  const pools = [
    { countryCode: "JP", total: 2, sources: [{ url: "https://supplier.invalid/?key=PRIVATE" }], entries: [{ url: "http://user:PRIVATE@proxy.invalid" }] },
    { countryCode: "CL", total: 100 }, { countryCode: "PH", total: 0 },
    { countryCode: "GLOBAL", total: 1 }, { countryCode: "INVALID", total: 1 },
  ];
  const orders = new Orders(db, crypt, { registrationPools: () => pools });
  const app = buildPlatform({ db, crypt, orders, secrets: { internal: "test" }, proxy: false });
  t.after(async () => {
    await app.close(); await db.close();
    await setup.query(`DROP SCHEMA ${schema} CASCADE`); await setup.close();
  });
  await db.initialize();
  await db.query("UPDATE platform_settings SET value=jsonb_set(value,'{login_slider_enabled}','false') WHERE id=1");
  const settings = async patch => db.query("UPDATE platform_settings SET value=value||$1::jsonb WHERE id=1", [JSON.stringify(patch)]);
  await settings({ orders_open: true, worker_enabled: false, max_open_orders: 20,
    template: { mailProvider: "smsbower", proxyAssignments: [{ workerSlot: 1, kind: "countryPool", countryCode: "CL" }] } });
  const signup = await app.inject({ method: "POST", url: "/api/auth/register", headers: { "x-requested-with": "gptreg" },
    payload: { email: "region@example.test", name: "Regions test", password: "SyntheticPassword123!" } });
  assert.equal(signup.statusCode, 200, signup.body);
  const cookie = signup.headers["set-cookie"].split(";")[0];
  const user = await db.one("UPDATE platform_users SET points=10000 WHERE email='region@example.test' RETURNING *");
  const key = await app.inject({ method: "POST", url: "/api/user/v1/keys", headers: { cookie, "x-requested-with": "gptreg" },
    payload: { name: "Existing scope", scopes: ["orders:write"] } });
  assert.equal(key.statusCode, 200, key.body);
  const headers = { authorization: `Bearer ${key.json().key}` };
  const create = (body, requestKey = id()) => orders.create(user, body, requestKey, "api");
  const balance = () => db.one("SELECT points,frozen,(SELECT count(*)::int FROM platform_ledger) AS ledger FROM platform_users WHERE id=$1", [user.id]);
  return { app, db, orders, pools, cookie, headers, user, create, balance, settings };
}

test("region discovery shares existing auth and feature controls, exposes only country code/name", { skip: !connection }, async t => {
  const f = await fixture(t);
  const path = "/open/v1/registration-regions";
  for (const url of [path, "/api/user/v1/registration-regions"]) {
    assert.equal((await f.app.inject({ url })).statusCode, 401);
    const r = await f.app.inject({ url, headers: url === path ? f.headers : { cookie: f.cookie } });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.headers["cache-control"], "no-store");
    assert.deepEqual(r.json(), { default_region: "random", regions: [
      { code: "CL", name: "智利" }, { code: "GLOBAL", name: "全球（混合地区）" }, { code: "JP", name: "日本" },
    ] });
    assert.doesNotMatch(r.body, /PRIVATE|supplier|proxy|entries|sources|total/);
  }
  const products = await f.app.inject({ url: "/open/v1/products", headers: f.headers });
  assert.deepEqual(Object.keys(products.json()).sort(), ["currency", "max_quantity", "orders_open", "products"]);
  await f.settings({ features: { ...(await f.db.settings()).features, register: false } });
  assert.equal((await f.app.inject({ url: path, headers: f.headers })).statusCode, 403);
  await f.settings({ features: { ...(await f.db.settings()).features, register: true }, api_enabled: false });
  assert.equal((await f.app.inject({ url: path, headers: f.headers })).statusCode, 503);
  await f.settings({ api_enabled: true });
  f.pools.splice(0);
  assert.deepEqual((await f.app.inject({ url: path, headers: f.headers })).json(), { default_region: "random", regions: [] });
  f.orders.registrationPools = () => { throw new Error("PRIVATE supplier password"); };
  const error = await f.app.inject({ url: path, headers: f.headers });
  assert.equal(error.statusCode, 503);
  assert.doesNotMatch(error.body, /PRIVATE|password/);
});

test("old bodies and old idempotency records remain compatible without duplicate reservations", { skip: !connection }, async t => {
  const f = await fixture(t), body = { quantity: 2, need_oauth: false }, key = "legacy-client-key";
  const r = await f.app.inject({ method: "POST", url: "/open/v1/registration-orders", headers: { ...f.headers, "idempotency-key": key }, payload: body });
  assert.equal(r.statusCode, 202, r.body);
  const order = r.json();
  assert.equal(order.registration_region, "random");
  const stored = await f.db.one("SELECT * FROM platform_orders WHERE id=$1", [order.id]);
  assert.deepEqual(stored.template, { mailProvider: "smsbower" });
  assert.equal(stored.request_hash, digest(JSON.stringify(body)));
  const before = await f.balance();
  assert.deepEqual(before, { points: 9900, frozen: 100, ledger: 1 });
  const replay = await f.create({ ...body, registration_region: "random" }, key);
  assert.equal(replay.replayed, true);
  assert.equal(replay.order.id, order.id);
  // Simulate a pre-upgrade row: nullable migration preserves the historical plan.
  const oldTemplate = { proxyAssignments: [{ workerSlot: 1, kind: "countryPool", countryCode: "PH" }] };
  await f.db.query("UPDATE platform_orders SET registration_region=NULL,template=$2 WHERE id=$1", [order.id, oldTemplate]);
  await f.db.initialize();
  f.orders.registrationPools = () => { throw new Error("unavailable catalog"); };
  const historical = await f.create(body, key);
  assert.equal(historical.order.registration_region, null);
  assert.equal(historical.order.id, order.id);
  assert.deepEqual((await f.db.one("SELECT template FROM platform_orders WHERE id=$1", [order.id])).template, oldTemplate);
  assert.deepEqual(await f.balance(), before);
});

test("explicit region snapshots, validation and concurrent idempotency protect points", { skip: !connection }, async t => {
  const f = await fixture(t), body = { quantity: 2, need_oauth: true, registration_region: "JP" }, key = "japan-idempotency-key";
  const results = await Promise.all([f.create(body, key), f.create(body, key)]);
  assert.equal(results.filter(r => !r.replayed).length, 1);
  const order = results[0].order;
  assert.equal(order.registration_region, "JP");
  assert.deepEqual((await f.db.one("SELECT template FROM platform_orders WHERE id=$1", [order.id])).template,
    { mailProvider: "smsbower", proxyAssignments: [{ workerSlot: 1, kind: "countryPool", countryCode: "JP" }] });
  assert.equal((await f.orders.detail(f.user.id, order.id)).registration_region, "JP");
  await assert.rejects(f.create({ ...body, registration_region: "CL" }, key), e => e.statusCode === 409);
  f.pools.splice(f.pools.findIndex(p => p.countryCode === "JP"), 1);
  assert.equal((await f.create(body, key)).order.id, order.id);
  const before = await f.balance();
  for (const region of ["JP", "PH", "US", "jp", "", null, 2, {}, "random "])
    await assert.rejects(f.create({ ...body, registration_region: region }), e => e.statusCode === 400);
  await assert.rejects(f.create({ quantity: 1, proxyAssignments: [] }), e => e.statusCode === 400);
  f.orders.registrationPools = () => { throw new Error("PRIVATE"); };
  await assert.rejects(f.create(body), e => e.statusCode === 503 && !e.message.includes("PRIVATE"));
  assert.deepEqual(await f.balance(), before);
});
