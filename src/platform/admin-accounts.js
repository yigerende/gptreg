"use strict";
const { fail } = require("./security");
const { audit } = require("./db");
const { totpCode } = require("../chatgpt-session-runner");
const { oauthExport } = require("./account-export");

function registerAdminAccounts(app, db, crypt) {
  const select =
    "SELECT a.*,u.email AS owner_email,u.name AS owner_name FROM platform_accounts a JOIN platform_users u ON u.id=a.user_id";
  const reveal = (row) => ({
    ...crypt.decrypt(row.credentials),
    delivery: Object.fromEntries(
      [
        "id",
        "user_id",
        "owner_email",
        "owner_name",
        "order_id",
        "item_id",
        "asset_id",
        "need_oauth",
        "created_at",
        "engine_sold_at",
      ].map((key) => [key, row[key]]),
    ),
  });
  app.get("/api/admin/v1/accounts/:id/credentials", async (r) => {
    const row = await db.one(`${select} WHERE a.id=$1`, [r.params.id]);
    fail(row, "交付账号不存在", 404);
    const value = reveal(row);
    await audit(db, r.user.id, "admin.account.credentials", row.id);
    return {
      ...value,
      totp_code: totpCode(value.totp_secret),
      totp_expires_in: 30 - (Math.floor(Date.now() / 1000) % 30),
    };
  });
  app.post("/api/admin/v1/accounts/export", async (r) => {
    const { ids, format = "json" } = r.body || {};
    fail(
      Array.isArray(ids) &&
        ids.length > 0 &&
        ids.length <= 1000 &&
        ids.every(
          (v) => typeof v === "string" && v.length > 0 && v.length <= 80,
        ),
      "一次选择 1～1000 个账号",
    );
    fail(
      ["json", "txt", "csv", "cpa", "sub"].includes(format),
      "导出格式须为 txt、csv、json、cpa 或 sub",
    );
    const unique = [...new Set(ids)];
    const rows = (
      await db.query(`${select} WHERE a.id=ANY($1::text[])`, [unique])
    ).rows;
    fail(
      rows.length === unique.length,
      "部分交付账号不存在，请刷新后重试",
      404,
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    const values = unique.map((id) => reveal(byId.get(id)));
    // Record identifiers and format only, never passwords or token contents.
    await audit(
      db,
      r.user.id,
      "admin.accounts.export",
      "",
      JSON.stringify({ ids: unique, format }),
    );
    const csv = (v) => {
      let text = String(v ?? "");
      if (/^[=+\-@\t\r\n]/.test(text)) text = "'" + text;
      return '"' + text.replace(/"/g, '""') + '"';
    };
    if (["cpa", "sub"].includes(format)) return oauthExport(values, format);
    return {
      filename: `gptreg-deliveries.${format}`,
      content:
        format === "json"
          ? JSON.stringify(values, null, 2)
          : format === "txt"
            ? values
                .map((c) => `${c.email}----${c.password}----${c.totp_secret}`)
                .join("\n") + "\n"
            : "\uFEFFemail,password,totp_secret,owner_email,owner_name,user_id,order_id,account_id,asset_id,need_oauth,delivered_at,sold_at,oauth_json\r\n" +
              values
                .map((c) =>
                  [
                    c.email,
                    c.password,
                    c.totp_secret,
                    c.delivery.owner_email,
                    c.delivery.owner_name,
                    c.delivery.user_id,
                    c.delivery.order_id,
                    c.delivery.id,
                    c.asset_id,
                    c.delivery.need_oauth,
                    c.delivery.created_at,
                    c.delivery.engine_sold_at,
                    c.oauth ? JSON.stringify(c.oauth) : "",
                  ]
                    .map(csv)
                    .join(","),
                )
                .join("\r\n") +
              "\r\n",
    };
  });
}
module.exports = { registerAdminAccounts };
