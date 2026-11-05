"use strict";
const { test } = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  path = require("node:path"),
  os = require("node:os"),
  crypto = require("node:crypto");
const { Database } = require("../src/platform/db"),
  { Orders } = require("../src/platform/orders"),
  { OrderWorker } = require("../src/platform/worker"),
  { cipher, id } = require("../src/platform/security");
const { executionFailure } = require("../src/platform/execution-failure");
const { RunManager } = require("../src/ui-server/run-manager"),
  { validateV2Config } = require("../src/config-v2");
const { buildPlatform } = require("../src/platform/app");
const connection =
  process.env.GPTREG_TEST_DATABASE_URL ||
  (fs.existsSync(".local/platform-test/connection.json")
    ? JSON.parse(fs.readFileSync(".local/platform-test/connection.json")).url
    : "");
function engine() {
  const config = validateV2Config({
    aliases: { strategy: "root" },
    mail: { provider: "smsbower", apiKey: "FAKE_MAIL", maxPrice: 0.02 },
    sms: {
      provider: "hero-sms",
      apiKey: "FAKE_BOWER",
      maxPrice: 0.05,
      hero: { apiKey: "FAKE_HERO", countries: [{ id: 6 }], maxPrice: 0.2 },
    },
    workers: { maxConcurrency: 1 },
    proxyPool: { required: false, healthCheck: { enabled: false } },
  });
  const catalog = {
    local: { proxies: [{ id: "fixed", url: "http://127.0.0.1:19999" }] },
    dynamic: {
      countryPools: [
        {
          countryCode: "PH",
          total: 2,
          entries: [
            { id: "p1", url: "http://127.0.0.1:19998" },
            { id: "p2", url: "http://127.0.0.1:19997" },
          ],
        },
      ],
    },
  };
  return {
    config: () => structuredClone(config),
    proxyService: { list: () => catalog },
    bindSessionAssetMailProvider: (p) => p,
  };
}
async function fixture(t) {
  const setup = new Database(connection),
    schema = `flow_${crypto.randomBytes(8).toString("hex")}`;
  await setup.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(connection);
  url.searchParams.set("options", `-c search_path=${schema}`);
  const db = new Database(url.href),
    crypt = cipher(crypto.randomBytes(32).toString("base64")),
    orders = new Orders(db, crypt);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gptreg-flow-"));
  const app = buildPlatform({
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
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  await db.initialize();
  await db.query(
    "UPDATE platform_settings SET value=value||$1::jsonb WHERE id=1",
    [JSON.stringify({ orders_open: true, worker_enabled: true })],
  );
  const user = await db.one(
    "INSERT INTO platform_users(id,email,name,password_hash,points) VALUES($1,'flow@example.test','flow','unused',10000) RETURNING *",
    [id()],
  );
  const calls = [],
    states = new Map(),
    assets = new Map(),
    marks = [];
  const store = {
    get: (key) => assets.get(key),
    markLifecycle: (ids, status) => {
      for (const k of ids) {
        if (!assets.has(k)) return { missing: [k] };
        assets.get(k).lifecycle = status;
        marks.push(k);
      }
      return { missing: [] };
    },
  };
  const manager = {
    ...engine(),
    activeRuns: () => [],
    isTaskSlotBusy: () => false,
    activeRun: () => null,
    sessionAssets: () => store,
    cpaFile: () => path.join(tmp, "cpa.json"),
    load: (rid) => {
      if (!states.has(rid)) throw new Error("missing");
      return states.get(rid);
    },
    async start(input, { runId }) {
      const { plan, config } = RunManager.prototype.runConfiguration.call(
        this,
        input,
      );
      const snapshot = RunManager.prototype.proxySnapshot.call(this, plan);
      calls.push({ plan, config, snapshot, runId });
      states.set(runId, { status: "complete", runPlan: plan, jobs: [] });
    },
  };
  const worker = new OrderWorker(db, orders, manager);
  const create = async (oauth = false) =>
    (await orders.create(user, { quantity: 1, need_oauth: oauth }, id(), "web"))
      .order;
  const item = async (order) =>
    db.one("SELECT * FROM platform_items WHERE order_id=$1", [order.id]);
  function asset(oauth = false) {
    const a = {
      id: id(),
      email: `${id()}@gmail.com`,
      password: "FAKE_PASSWORD",
      totpSecret: "JBSWY3DPEHPK3PXP",
      security: { passwordStatus: "configured", totpStatus: "configured" },
    };
    if (oauth) {
      a.cpa = { path: "cpa.json" };
      fs.writeFileSync(
        path.join(tmp, "cpa.json"),
        JSON.stringify({
          access_token: "FAKE_ACCESS",
          refresh_token: "FAKE_REFRESH",
        }),
      );
    }
    assets.set(a.id, a);
    return a;
  }
  return {
    db,
    orders,
    user,
    app,
    manager,
    worker,
    calls,
    states,
    assets,
    marks,
    store,
    create,
    item,
    asset,
  };
}
test("modern registration and OAuth share automatic proxies; explicit selections and legacy plans stay intact", () => {
  const manager = engine();
  for (const kind of ["register_session", "register_oauth", "oauth"]) {
    const input = {
      schemaVersion: 2,
      taskKind: kind,
      mailCount: 1,
      workerConcurrency: 1,
      security: { setPassword: true, enrollTotp: true },
      ...(kind === "oauth"
        ? { oauthSource: { kind: "session_assets", assetIds: ["existing"] } }
        : {}),
    };
    const { plan, config } = RunManager.prototype.runConfiguration.call(
      manager,
      input,
    );
    assert.equal(plan.proxyAssignments[0].countryCode, "PH");
    assert.equal(config.sms.provider, "hero-sms");
    assert.equal(config.mail.apiKey, "FAKE_MAIL");
    assert.equal(
      RunManager.prototype.proxySnapshot.call(manager, plan).entries.length,
      2,
    );
    const selected = RunManager.prototype.runConfiguration.call(manager, {
      ...input,
      proxyAssignments: [
        { workerSlot: 1, kind: "local", localProxyId: "fixed" },
      ],
    }).plan;
    assert.equal(
      RunManager.prototype.proxySnapshot.call(manager, selected).entries[0].id,
      "fixed",
    );
  }
  const legacy = RunManager.prototype.runConfiguration.call(manager, {
    taskKind: "register_session",
    schemaVersion: 1,
  }).plan;
  assert.deepEqual(legacy.proxyAssignments, []);
});
for (const oauth of [false, true])
  test(
    `customer ${oauth ? "OAuth" : "standard"} order uses the launch-button mode and delivers exactly once`,
    { skip: !connection },
    async (t) => {
      const f = await fixture(t),
        o = await f.create(oauth);
      await f.worker.cycle();
      assert.equal(f.calls[0].plan.taskKind, "register_session");
      assert.equal(f.calls[0].plan.postRegistrationOAuth, oauth);
      assert.equal(f.calls[0].plan.proxyAssignments[0].countryCode, "PH");
      assert.deepEqual(f.calls[0].plan.security, {
        setPassword: true,
        enrollTotp: true,
      });
      const i = await f.item(o),
        a = f.asset(oauth);
      f.states.get(i.run_id).jobs = [{ sessionAssetId: a.id }];
      await f.worker.cycle();
      await f.worker.cycle();
      const done = await f.orders.detail(f.user.id, o.id);
      assert.equal(done.status, "completed");
      assert.equal(done.charged, oauth ? 100 : 50);
      assert.equal(f.calls.length, 1);
      assert.deepEqual(f.marks, [a.id]);
      const saved = await f.db.one(
        "SELECT * FROM platform_accounts WHERE order_id=$1",
        [o.id],
      );
      assert.ok(saved.engine_sold_at);
      const credentials = await f.orders.reveal(f.user.id, saved.id);
      assert.equal(Boolean(credentials.oauth), oauth);
    },
  );
test(
  "incomplete combined OAuth only retries the original asset and keeps reserved points until delivery",
  { skip: !connection },
  async (t) => {
    const f = await fixture(t),
      o = await f.create(true);
    await f.worker.cycle();
    const first = await f.item(o),
      a = f.asset();
    f.states.get(first.run_id).jobs = [
      {
        sessionAssetId: a.id,
        error: { code: "NO_NUMBERS", message: "secret must not leak" },
      },
    ];
    await f.worker.cycle();
    assert.equal(f.calls.length, 2);
    assert.equal(f.calls[1].plan.taskKind, "oauth");
    assert.deepEqual(f.calls[1].plan.oauthSource.assetIds, [a.id]);
    assert.equal(f.marks.length, 0);
    let account = await f.db.one(
      "SELECT points,frozen FROM platform_users WHERE id=$1",
      [f.user.id],
    );
    assert.equal(account.frozen, 100);
    const second = await f.item(o);
    f.states.get(second.run_id).jobs = [{ assetId: a.id }];
    await f.worker.cycle();
    assert.equal((await f.item(o)).status, "oauth_pending");
    await f.db.query(
      "UPDATE platform_items SET available_at=now() WHERE id=$1",
      [second.id],
    );
    await f.worker.cycle();
    assert.equal(
      f.calls.filter((x) => x.plan.taskKind === "register_session").length,
      1,
    );
    const successful = f.asset(true);
    a.cpa = successful.cpa;
    const last = await f.item(o);
    f.states.get(last.run_id).jobs = [{ assetId: a.id }];
    await f.worker.cycle();
    assert.equal((await f.orders.detail(f.user.id, o.id)).charged, 100);
    assert.deepEqual(f.marks, [a.id]);
  },
);
test(
  "sold marking survives a failure and restart without repeating charge or marking a cancelled item",
  { skip: !connection },
  async (t) => {
    const f = await fixture(t),
      o = await f.create();
    await f.worker.cycle();
    const i = await f.item(o),
      a = f.asset();
    f.states.get(i.run_id).jobs = [{ sessionAssetId: a.id }];
    const mark = f.store.markLifecycle;
    f.store.markLifecycle = () => {
      throw new Error("disk temporarily unavailable");
    };
    await f.worker.cycle();
    assert.equal((await f.orders.detail(f.user.id, o.id)).status, "completed");
    assert.equal(
      (
        await f.db.one(
          "SELECT engine_sold_at FROM platform_accounts WHERE order_id=$1",
          [o.id],
        )
      ).engine_sold_at,
      null,
    );
    f.store.markLifecycle = mark;
    await f.db.query("UPDATE platform_accounts SET engine_sold_retry_at=now()");
    await new OrderWorker(f.db, f.orders, f.manager).cycle();
    assert.deepEqual(f.marks, [a.id]);
    assert.equal((await f.orders.detail(f.user.id, o.id)).charged, 50);
    const cancelled = await f.create(true);
    await f.orders.cancel(f.user.id, cancelled.id);
    await f.worker.cycle();
    assert.deepEqual(f.marks, [a.id]);
  },
);
test(
  "startup diagnostics are persisted for admins, sanitized and absent from customer details",
  { skip: !connection },
  async (t) => {
    const f = await fixture(t),
      o = await f.create(true);
    f.manager.start = async () => {
      throw Object.assign(new Error("https://secret.example/?apiKey=HIDDEN"), {
        details: {
          sms: {
            required: true,
            ready: false,
            issue: "BAD_KEY",
            apiKey: "HIDDEN",
          },
        },
      });
    };
    await f.worker.cycle();
    let i = await f.item(o);
    assert.match(i.message, /密钥无效/);
    const attempt = await f.db.one(
      "SELECT * FROM platform_attempts WHERE item_id=$1",
      [i.id],
    );
    assert.equal(attempt.error_code, "BAD_KEY");
    assert.equal(JSON.stringify(attempt).includes("HIDDEN"), false);
    const detail = await f.orders.detail(f.user.id, o.id);
    assert.equal(detail.attempts, undefined);
    assert.equal(detail.items[0].error_code, undefined);
    await f.db.query(
      "UPDATE platform_items SET available_at=now() WHERE id=$1",
      [i.id],
    );
    await f.worker.cycle();
    assert.equal((await f.orders.detail(f.user.id, o.id)).released, 100);
    assert.deepEqual(
      executionFailure({ code: "UNTRUSTED_SECRET_CODE", message: "HIDDEN" }),
      {
        code: "PREFLIGHT_FAILED",
        category: "configuration",
        detail: "启动预检失败，请检查原注册台配置",
        wait: false,
        delay: 30,
      },
    );
  },
);
test(
  "temporary capacity waits do not exhaust execution attempts and stop at the wait deadline",
  { skip: !connection },
  async (t) => {
    const f = await fixture(t),
      o = await f.create();
    f.manager.start = async () => {
      throw Object.assign(new Error("busy"), {
        details: { code: "MAIN_TASK_CAPACITY" },
      });
    };
    await f.worker.cycle();
    const i = await f.item(o);
    assert.equal(i.status, "queued");
    assert.equal(i.attempts, 0);
    assert.equal(
      (
        await f.db.one(
          "SELECT status FROM platform_attempts WHERE item_id=$1",
          [i.id],
        )
      ).status,
      "finished",
    );
    await f.db.query(
      "UPDATE platform_attempts SET created_at=now()-interval '1 day'",
    );
    await f.db.query(
      "UPDATE platform_items SET available_at=now() WHERE id=$1",
      [i.id],
    );
    await f.worker.cycle();
    assert.equal((await f.orders.detail(f.user.id, o.id)).status, "failed");
    assert.equal((await f.orders.detail(f.user.id, o.id)).released, 50);
  },
);
