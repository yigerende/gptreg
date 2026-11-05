"use strict";
const { initializeRuntime } = require("./runtime");
const { Database, audit } = require("../src/platform/db");
const { loadSecrets, cipher, fail } = require("../src/platform/security");
const { Orders } = require("../src/platform/orders");
const { OrderWorker } = require("../src/platform/worker");
const { buildApp } = require("../src/ui-server/app");
const { ConfigService } = require("../src/ui-server/config-service");
const {
  configureProviderApiEgress,
  providerApiProxiesFromConfig,
} = require("../src/provider-api-egress");
async function main() {
  const cwd = process.cwd(),
    { configPath, credentials } = initializeRuntime(cwd),
    secrets = loadSecrets(cwd),
    crypt = cipher(secrets.master);
  process.env.GPTREG_RUNTIME_MASTER_KEY = secrets.master;
  const configService = new ConfigService({ cwd, configPath });
  configureProviderApiEgress({
    resolveProxies: () => providerApiProxiesFromConfig(configService.readRaw()),
  });
  const db = new Database(process.env.DATABASE_URL);
  await db.initialize(credentials);
  const queueLock = await db.pool.connect();
  fail(
    (await queueLock.query("SELECT pg_try_advisory_lock(8963002) AS locked"))
      .rows[0].locked,
    "Another registration worker owns the queue",
    503,
  );
  const app = buildApp({ cwd, configPath, deferBootMaintenance: true });
  app.addHook("onRequest", async (r, reply) => {
    if (r.url === "/healthz" && r.method === "GET") return;
    if (r.headers.authorization !== `Bearer ${secrets.internal}`)
      return reply
        .code(401)
        .send({ error: "Internal authentication required" });
  });
  const orders = new Orders(db, crypt),
    queue = new OrderWorker(db, orders, app.services.runManager);
  app.get("/healthz", async () => ({ ok: !queue.closed }));
  app.post("/api/v1/platform/items/:id/resolve", async (r) => {
    const item = await db.one(
      "SELECT * FROM platform_items WHERE id=$1 AND status='review'",
      [r.params.id],
    );
    fail(item, "待核实子任务不存在", 404);
    fail(
      !app.services.runManager.activeRun(item.run_id),
      "任务仍在执行，不能人工结算",
      409,
    );
    const action = r.body?.action;
    fail(["resume", "fail"].includes(action), "操作无效");
    if (action === "resume") {
      await app.services.runManager.resume(item.run_id);
      await db.query(
        "UPDATE platform_items SET status='running',attempt_started_at=now(),message='管理员已恢复执行' WHERE id=$1",
        [item.id],
      );
    } else {
      let state;
      try {
        state = app.services.runManager.load(item.run_id);
      } catch {}
      if (
        state &&
        !["complete", "partial", "cancelled", "failed"].includes(state.status)
      ) {
        await app.services.runManager.cancel(
          item.run_id,
          "Administrator resolved customer order",
        );
        state = app.services.runManager.load(item.run_id);
        fail(
          ["complete", "partial", "cancelled", "failed"].includes(state.status),
          "资源清理尚未完成，请稍后核实",
          409,
        );
      }
      await orders.finish(item.id, null, "管理员核实为未交付，预留积分已退回");
    }
    await audit(
      db,
      String(r.headers["x-gptreg-actor"] || ""),
      `item.${action}`,
      item.id,
    );
    return { ok: true };
  });
  await queue.start(queueLock);
  await app.listen({
    host: process.env.LISTEN_HOST || "0.0.0.0",
    port: Number(process.env.WORKER_PORT || 3211),
  });
  const shutdown = async () => {
    queue.closed = true;
    clearInterval(queue.timer);
    await queue.pending;
    await app.close();
    await queue.close();
    await db.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  console.log("gptreg internal engine and durable order queue ready");
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
