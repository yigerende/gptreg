"use strict";
// Local preview uses its own database schema and does not start the engine.
const fs = require("node:fs");
const { Database } = require("../src/platform/db");
const { Orders } = require("../src/platform/orders");
const { cipher, id, passwordHash } = require("../src/platform/security");
const { buildPlatform } = require("../src/platform/app");
async function main() {
  const url = new URL(
    JSON.parse(fs.readFileSync(".local/platform-test/connection.json")).url,
  );
  const setup = new Database(url.href);
  await setup.query("CREATE SCHEMA IF NOT EXISTS portal_preview");
  await setup.close();
  url.searchParams.set("options", "-c search_path=portal_preview");
  const db = new Database(url.href);
  await db.initialize({ username: "admin", password: "PreviewAdmin123!" });
  const crypt = cipher(Buffer.alloc(32, 7).toString("base64"));
  await db.query(
    'UPDATE platform_settings SET value=value||\'{"orders_open":true,"worker_enabled":false,"announcement":"欢迎使用账号注册工作台。注册成功后自动交付，未交付部分积分退回。"}\'::jsonb WHERE id=1',
  );
  await db.query(
    "INSERT INTO platform_users(id,email,name,password_hash,points) VALUES($1,'preview@example.test','演示用户',$2,2000) ON CONFLICT(email) DO NOTHING",
    [id(), await passwordHash("PreviewMember123!")],
  );
  const app = buildPlatform({
    db,
    orders: new Orders(db, crypt),
    crypt,
    secrets: { internal: "preview" },
    proxy: false,
  });
  await app.listen({ host: "127.0.0.1", port: 18984 });
  console.log("Isolated portal preview ready on 18984; engine disabled");
  const stop = async () => {
    await app.close();
    await db.close();
    process.exit(0);
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
