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
  const sessionProxy = await require('../src/platform/session-proxy-service').createSessionProxy(db, crypt, 'worker');
  const orders = new Orders(db, crypt);
  let queue;
  const app = buildApp({ cwd, configPath, deferBootMaintenance: true, sessionProxy,
    onRunCancel: runId => queue.cancelEngineRun(runId) });
  app.addHook("onRequest", async (r, reply) => {
    if (r.url === "/healthz" && r.method === "GET") return;
    if (r.headers.authorization !== `Bearer ${secrets.internal}`)
      return reply
        .code(401)
        .send({ error: "Internal authentication required" });
  });
  queue = new OrderWorker(db, orders, app.services.runManager);
  app.get("/healthz", async () => ({ ok: !queue.closed }));
  app.post("/api/v1/platform/items/:id/resolve", async (r) => {
    const action = r.body?.action;
    const result = await queue.resolve(r.params.id, action);
    await audit(
      db,
      String(r.headers["x-gptreg-actor"] || ""),
      `item.${action}`,
      r.params.id,
    );
    return result;
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
    await sessionProxy.close();
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
