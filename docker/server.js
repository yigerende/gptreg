"use strict";

const { initializeRuntime } = require("./runtime");
const { Database } = require("../src/platform/db");
const { loadSecrets, cipher } = require("../src/platform/security");
const { Orders } = require("../src/platform/orders");
const { buildPlatform } = require("../src/platform/app");
async function main() {
  const cwd = process.cwd(),
    { credentials } = initializeRuntime(cwd),
    secrets = loadSecrets(cwd),
    crypt = cipher(secrets.master);
  if (!process.env.DATABASE_URL)
    throw new Error(
      "DATABASE_URL is required; use docker compose or the isolated development launcher",
    );
  const db = new Database(process.env.DATABASE_URL);
  await db.initialize(credentials);
  const app = buildPlatform({
    db,
    orders: new Orders(db, crypt),
    crypt,
    secrets,
    cwd,
    workerUrl: process.env.WORKER_URL || "http://worker:3211",
  });
  app.addHook("onClose", () => db.close());
  await app.listen({
    host: process.env.LISTEN_HOST || "0.0.0.0",
    port: Number(process.env.PORT || 3210),
  });
  console.log(
    "gptreg customer portal listening; session and API authentication enabled",
  );
  const shutdown = async () => {
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
