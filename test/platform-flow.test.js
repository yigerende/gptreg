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
test('proxy usage storage errors retain an explicit configuration diagnosis without leaking paths', () => {
  const failure = executionFailure({ code: 'PROXY_USAGE_STORAGE_ERROR', message: '/private/runtime/path' });
  assert.equal(failure.code, 'PROXY_USAGE_STORAGE_ERROR');
  assert.equal(failure.category, 'configuration');
  assert.equal(failure.wait, false);
  assert.match(failure.detail, /运行数据目录/);
  assert.equal(JSON.stringify(failure).includes('/private'), false);
});
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

test('incomplete mailbox is replaced after cleanup, retired assets cannot deliver and deadline stays fixed', { skip: !connection }, async t => {
  const f=await fixture(t),o=await f.create(); await f.worker.cycle();
  const old=await f.item(o),a=f.asset();
  a.security.passwordStatus='failed'; a.security.totpStatus='failed';
  f.states.get(old.run_id).status='partial';
  f.states.get(old.run_id).jobs=[{sessionAssetId:a.id,sessionState:{step:'verified',security:{failures:[{feature:'password',code:'EMAIL_OTP_TIMEOUT'}]}}}];
  await f.worker.cycle();
  let i=await f.item(o);
  assert.equal(i.status,'queued'); assert.equal(i.run_id,null); assert.equal(i.resource_replacements,1);
  assert.equal(+i.execution_started_at,+old.execution_started_at);
  assert.equal((await f.orders.detail(f.user.id,o.id)).released,0);
  await f.db.query("UPDATE platform_items SET available_at=now() WHERE id=$1",[i.id]);
  await f.worker.cycle(); assert.equal(f.calls.length,1,'new execution waits for old resource cleanup');
  await require('../src/platform/order-recovery').cleanupRuns(f.worker);
  await f.worker.cycle(); i=await f.item(o);
  assert.equal(f.calls.length,2); assert.notEqual(i.run_id,old.run_id);
  assert.equal(await f.orders.finish(i.id,f.worker.credentials(f.asset(),false),undefined,old.run_id),null,'late old execution is fenced');
  const fresh=f.asset(); f.states.get(i.run_id).jobs=[{sessionAssetId:fresh.id}];
  await f.worker.cycle(); assert.equal((await f.item(o)).status,'delivered');
  await f.db.query('UPDATE platform_run_cleanup SET finished_at=NULL,next_attempt_at=now() WHERE run_id=$1',[old.run_id]);
  await require('../src/platform/order-recovery').cleanupRuns(f.worker);
  assert.equal((await f.db.one('SELECT count(*)::int AS n FROM platform_quarantined_assets WHERE asset_id=$1',[fresh.id])).n,0);
  assert.equal((await f.db.one('SELECT count(*)::int AS n FROM platform_quarantined_assets WHERE asset_id=$1',[a.id])).n,1);
  assert.equal((await f.orders.detail(f.user.id,o.id)).charged,50);
});

test('mailbox replacement count survives worker restart and ends with one refund at its configured limit', { skip: !connection }, async t => {
  const f=await fixture(t),o=await f.create(); await f.worker.cycle();
  for(let n=0;n<3;n++) {
    const i=await f.item(o);
    f.states.get(i.run_id).jobs=[{status:'skipped',sessionState:{step:'email_otp_sent'},error:{code:'EMAIL_OTP_TIMEOUT'}}];
    const worker=new OrderWorker(f.db,f.orders,f.manager);
    await worker.cycle();
    if(n<2) {
      assert.equal((await f.item(o)).resource_replacements,n+1);
      await require('../src/platform/order-recovery').cleanupRuns(worker);
      await f.db.query('UPDATE platform_items SET available_at=now()');
      await worker.cycle();
    }
  }
  assert.equal(f.calls.length,3); assert.equal((await f.item(o)).status,'failed');
  assert.equal((await f.orders.detail(f.user.id,o.id)).released,50);
  assert.equal((await f.db.one("SELECT count(*)::int AS n FROM platform_ledger WHERE kind='release'")).n,1);
});
test('preflight waits without checkpoints do not block later mailbox replacement cleanup', { skip: !connection }, async t => {
  const f = await fixture(t), o = await f.create();
  const start = f.manager.start;
  f.manager.start = async () => { throw Object.assign(new Error('busy'), { code: 'MAIN_TASK_CAPACITY' }); };
  await f.worker.cycle();
  const preflight = await f.item(o);
  assert.equal(f.states.has(preflight.run_id), false);
  f.manager.start = start;
  await f.db.query('UPDATE platform_items SET available_at=now() WHERE id=$1', [preflight.id]);
  await f.worker.cycle();
  const old = await f.item(o);
  f.states.get(old.run_id).jobs = [{ error: { code: 'EMAIL_OTP_TIMEOUT' }, sessionState: { step: 'email_otp_sent' } }];
  await f.worker.cycle();
  assert.equal((await f.item(o)).resource_replacements, 1);
  assert.equal((await f.db.one('SELECT count(*)::int AS n FROM platform_run_cleanup WHERE run_id=$1', [preflight.run_id])).n, 0);
  await require('../src/platform/order-recovery').cleanupRuns(f.worker);
  await f.db.query('UPDATE platform_items SET available_at=now() WHERE id=$1', [old.id]);
  await f.worker.cycle();
  assert.equal(f.calls.length, 2);
  assert.notEqual((await f.item(o)).run_id, old.run_id);
});

test('stalled retired resource cleanup cannot keep customer points frozen past the original deadline', { skip: !connection }, async t => {
  const f = await fixture(t), o = await f.create();
  await f.worker.cycle();
  const old = await f.item(o);
  f.states.get(old.run_id).jobs = [{ error: { code: 'EMAIL_OTP_TIMEOUT' } }];
  await f.worker.cycle();
  assert.equal((await f.item(o)).status, 'queued');
  await f.db.query("UPDATE platform_items SET execution_started_at=now()-interval '1 day' WHERE id=$1", [old.id]);
  await f.worker.cycle();
  await f.worker.cycle();
  assert.equal((await f.item(o)).status, 'failed');
  assert.equal(f.calls.length, 1);
  assert.equal((await f.orders.detail(f.user.id, o.id)).released, 50);
  assert.equal((await f.db.one("SELECT count(*)::int AS n FROM platform_ledger WHERE kind='release'")).n, 1);
  assert.equal((await f.db.one('SELECT count(*)::int AS n FROM platform_run_cleanup WHERE finished_at IS NULL')).n, 1);
});

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
  await db.query("UPDATE platform_settings SET value=jsonb_set(value,'{login_slider_enabled}','false') WHERE id=1");
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
    setCustomerPendingRuns() {},
    setCustomerConcurrency(value) {
      this.customerCapacity = value;
    },
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
function holdExecutions(f) {
  const live = new Map(),
    original = f.manager.start.bind(f.manager);
  f.manager.activeRun = (runId) => live.get(runId) || null;
  f.manager.activeRuns = () => [...live.values()];
  f.manager.start = async (plan, options) => {
    assert.equal(options.customerExecution, true);
    assert.ok(options.customerUserId);
    await original(plan, options);
    const state = f.states.get(options.runId);
    state.status = "running";
    live.set(options.runId, { state, owner: options.customerUserId });
  };
  function finish(runId, oauth = false) {
    const state = f.states.get(runId),
      asset = f.asset(oauth);
    state.jobs = [{ sessionAssetId: asset.id }];
    state.status = "complete";
    live.delete(runId);
  }
  return { live, finish };
}

test("refund races, stale review and legacy overwritten status never re-charge or re-open a settled item", { skip: !connection }, async t => {
  const f = await fixture(t), o = await f.create();
  await f.worker.cycle();
  const i = await f.item(o), a = f.asset();
  await Promise.all([f.orders.finish(i.id, null), f.worker.review(i, "stale observation")]);
  assert.equal((await f.item(o)).status, "failed");
  // Reproduce the production legacy corruption: release exists but status was overwritten.
  await f.db.query("UPDATE platform_items SET status='review' WHERE id=$1", [i.id]);
  f.states.get(i.run_id).jobs = [{ sessionAssetId: a.id }];
  await f.worker.cycle();
  const receipt = await f.worker.resolve(i.id, "fail");
  assert.equal(receipt.refunded, true);
  assert.equal((await f.item(o)).status, "failed");
  assert.equal((await f.orders.detail(f.user.id, o.id)).released, 50);
  await f.orders.finish(i.id, f.worker.credentials(a, false));
  assert.equal((await f.db.one("SELECT count(*)::int AS n FROM platform_accounts")).n, 0);
  assert.equal((await f.db.one("SELECT count(*)::int AS n FROM platform_ledger WHERE kind='release'")).n, 1);
  assert.equal((await f.db.one("SELECT frozen FROM platform_users WHERE id=$1", [f.user.id])).frozen, 0);
  await require("../src/platform/order-recovery").cleanupRuns(f.worker);
  assert.equal((await f.db.one("SELECT count(*)::int AS n FROM platform_quarantined_assets")).n, 1);
});

test("waiting jobs recover the original run with durable bounded attempts and refund automatically", { skip: !connection }, async t => {
  const f = await fixture(t), o = await f.create();
  await f.worker.cycle();
  const i = await f.item(o), state = f.states.get(i.run_id), resumed = [];
  state.status = "waiting";
  state.jobs = [{ targetTouchedAt: new Date().toISOString(), error: { code: "SENTINEL_PROXY_IDENTITY_CHANGED" } }];
  f.manager.resume = async runId => { resumed.push(runId); };
  await f.worker.cycle();
  assert.equal((await f.item(o)).recovery_attempts, 1);
  const restarted = new OrderWorker(f.db, f.orders, f.manager);
  for (let n=0;n<3;n++) {
    await f.db.query("UPDATE platform_items SET available_at=now()");
    await restarted.cycle();
  }
  assert.deepEqual(resumed, [i.run_id,i.run_id]);
  assert.equal(f.calls.length, 1);
  assert.equal((await f.item(o)).status, "failed");
  assert.equal((await f.orders.detail(f.user.id,o.id)).released, 50);
});

test("a missing checkpoint or unresponsive engine reaches the absolute deadline and later assets cannot deliver", { skip: !connection }, async t => {
  const f = await fixture(t), o = await f.create();
  const {live} = holdExecutions(f);
  await f.worker.cycle();
  const i = await f.item(o);
  await f.db.query("UPDATE platform_items SET execution_started_at=now()-interval '1 day',attempt_started_at=now() WHERE id=$1", [i.id]);
  await f.worker.cycle();
  assert.equal((await f.item(o)).status, "failed");
  assert.equal(live.size, 1, "refund does not pretend the external execution disappeared");
  const a = f.asset();
  const late = await f.orders.finish(i.id, f.worker.credentials(a,false));
  assert.equal(late.refunded, true);
  assert.equal((await f.orders.detail(f.user.id,o.id)).charged, 0);
});

test("complete credentials deliver despite stopped cleanup wait and cleanup failures do not block another order", { skip: !connection }, async t => {
  const f = await fixture(t), first = await f.create();
  await f.worker.cycle();
  const i = await f.item(first), a=f.asset(), state=f.states.get(i.run_id);
  state.status="waiting"; state.phase="waiting_resource_cleanup"; state.jobs=[{sessionAssetId:a.id}];
  f.manager.cancel=async()=>{throw new Error("provider unavailable");};
  await f.worker.cycle();
  assert.equal((await f.item(first)).status,"delivered");
  await require("../src/platform/order-recovery").cleanupRuns(f.worker);
  assert.equal((await f.db.one("SELECT attempts FROM platform_run_cleanup WHERE run_id=$1",[i.run_id])).attempts,1);
  const second=await f.create(); await f.worker.cycle();
  assert.equal((await f.item(second)).status,"running");
});

test("email timeout before account creation retries safely while uncertain creation only restores the original run", { skip: !connection }, async t => {
  const f=await fixture(t),o=await f.create(); await f.worker.cycle();
  let i=await f.item(o);
  f.states.get(i.run_id).jobs=[{targetTouchedAt:new Date().toISOString(),sessionState:{step:'email_otp_sent'},error:{code:'EMAIL_OTP_TIMEOUT'}}];
  await f.worker.cycle();
  assert.equal((await f.item(o)).status,'queued');
  assert.match((await f.item(o)).message,/邮箱验证码等待超时/);
  await require("../src/platform/order-recovery").cleanupRuns(f.worker);
  await f.db.query("UPDATE platform_items SET available_at=now()"); await f.worker.cycle();
  i=await f.item(o); let resumed=0;
  f.states.get(i.run_id).jobs=[{sessionState:{createAccountAttempt:{status:'uncertain'}}}];
  f.manager.resume=async()=>{resumed++};
  await f.worker.cycle();
  assert.equal(resumed,1); assert.equal(f.calls.length,2);
});
test(
  "100 customer accounts execute 15 at a time, refill one slot and settle once across restart",
  { skip: !connection },
  async (t) => {
    const f = await fixture(t),
      { live, finish } = holdExecutions(f);
    const order = (
      await f.orders.create(f.user, { quantity: 100 }, id(), "web")
    ).order;
    await f.worker.cycle();
    assert.equal(live.size, 15);
    assert.equal(
      (
        await f.db.one(
          "SELECT count(*)::int AS n FROM platform_items WHERE status='queued'",
        )
      ).n,
      85,
    );
    await f.worker.cycle();
    assert.equal(f.calls.length, 15);
    finish([...live.keys()][0]);
    await f.worker.cycle();
    assert.equal(live.size, 15);
    assert.equal(f.calls.length, 16);
    assert.equal((await f.orders.detail(f.user.id, order.id)).delivered, 1);
    const restarted = new OrderWorker(f.db, f.orders, f.manager);
    while (live.size) {
      for (const runId of [...live.keys()]) finish(runId);
      await restarted.cycle();
      assert.ok(live.size <= 15);
    }
    await restarted.cycle();
    const done = await f.orders.detail(f.user.id, order.id);
    assert.equal(done.delivered, 100);
    assert.equal(done.charged, 5000);
    assert.equal(f.calls.length, 100);
    assert.equal(new Set(f.calls.map((call) => call.runId)).size, 100);
    assert.equal(
      (
        await f.db.one(
          "SELECT count(*)::int AS n FROM platform_ledger WHERE kind='charge'",
        )
      ).n,
      100,
    );
  },
);
test(
  "global and per-user limits span orders and OAuth, drain on reduction and honor pause/cancel",
  { skip: !connection },
  async (t) => {
    const f = await fixture(t),
      { live, finish } = holdExecutions(f);
    const set = (value) =>
      f.db.query("UPDATE platform_settings SET value=value||$1::jsonb", [
        JSON.stringify(value),
      ]);
    await set({
      registration_concurrency: 3,
      user_registration_concurrency: 2,
    });
    const other = await f.db.one(
      "INSERT INTO platform_users(id,email,name,password_hash,points) VALUES($1,'other@example.test','other','unused',10000) RETURNING *",
      [id()],
    );
    const first = (await f.orders.create(f.user, { quantity: 10 }, id(), "web"))
      .order;
    const oauth = await f.create(true);
    const existing = f.asset(false),
      oauthItem = await f.item(oauth);
    await f.db.query(
      "UPDATE platform_items SET status='oauth_pending',asset_id=$2 WHERE id=$1",
      [oauthItem.id, existing.id],
    );
    const second = (await f.orders.create(other, { quantity: 10 }, id(), "api"))
      .order;
    await f.worker.cycle();
    assert.equal(live.size, 3);
    assert.equal(
      [...live.values()].filter((run) => run.owner === f.user.id).length,
      2,
    );
    assert.equal(
      f.calls.filter((call) => call.plan.taskKind === "oauth").length,
      1,
    );
    await set({
      registration_concurrency: 1,
      user_registration_concurrency: 1,
    });
    await f.worker.cycle();
    assert.equal(f.calls.length, 3); // existing work is not interrupted
    const firstUserRuns = [...live].filter(
      ([, run]) => run.owner === f.user.id,
    );
    for (const [runId, run] of firstUserRuns)
      finish(runId, run.state.runPlan.taskKind === "oauth");
    await f.worker.cycle();
    assert.equal(live.size, 1);
    assert.equal(f.calls.length, 3);
    await set({
      registration_concurrency: 5,
      user_registration_concurrency: 1,
    });
    await f.worker.cycle();
    assert.equal(live.size, 2); // only two users, even though five global slots exist
    await set({ worker_enabled: false });
    for (const runId of [...live.keys()]) finish(runId);
    await f.worker.cycle();
    assert.equal(live.size, 0);
    await f.orders.cancel(f.user.id, first.id);
    await f.orders.cancel(other.id, second.id);
    await set({ worker_enabled: true });
    await f.worker.cycle();
    assert.equal(live.size, 0);
  },
);
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

for (const oauth of [false, true]) test(
  `explicit customer country survives ${oauth ? "combined and supplemental OAuth" : "standard registration"} execution`,
  { skip: !connection }, async (t) => {
    const f = await fixture(t);
    const catalog = f.manager.proxyService.list();
    catalog.dynamic.countryPools.push({ countryCode: "JP", total: 1, entries: [{ id: "japan", url: "http://127.0.0.1:19996" }] });
    f.orders.registrationPools = () => catalog.dynamic.countryPools;
    const o = (await f.orders.create(f.user, { quantity: 1, need_oauth: oauth, registration_region: "JP" }, id(), "web")).order;
    await f.worker.cycle();
    assert.equal(f.calls[0].plan.proxyAssignments[0].countryCode, "JP");
    assert.equal(f.calls[0].plan.postRegistrationOAuth, oauth);
    assert.equal(f.calls[0].snapshot.entries[0].id, "japan");
    if (oauth) {
      const i = await f.item(o), a = f.asset();
      f.states.get(i.run_id).jobs = [{ sessionAssetId: a.id, error: { code: "NO_NUMBERS" } }];
      await f.worker.cycle();
      assert.equal(f.calls[1].plan.taskKind, "oauth");
      assert.deepEqual(f.calls[1].plan.oauthSource.assetIds, [a.id]);
      assert.equal(f.calls[1].plan.proxyAssignments[0].countryCode, "JP");
    }
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
