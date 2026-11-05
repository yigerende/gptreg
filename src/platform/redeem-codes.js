"use strict";
const { id, token, digest, fail, integer } = require("./security");
const { audit } = require("./db");
const { search, option } = require("./reports");
const {reportPeriod}=require('./report-period');

// Bound only redemption-code transactions; registration/order timeouts stay intact.
async function redeemTransaction(db, work) {
  try {
    return await db.tx(async (q) => {
      await q.query("SET LOCAL lock_timeout='3s'");
      await q.query("SET LOCAL statement_timeout='10s'");
      return work(q);
    });
  } catch (error) {
    if (["55P03", "57014", "40P01"].includes(error.code)) {
      fail(false, "兑换码操作繁忙，请稍后重试", 503);
    }
    throw error;
  }
}

function registerRedeemCodes(app, db, crypt) {
  app.get('/api/admin/v1/redeem-codes/usage',async(r)=>{
    const period=reportPeriod(r.query.period||'day',r.query.date||'');
    const limit=integer(Number(r.query.limit||50),1,100,'limit');
    const offset=integer(Number(r.query.offset||0),0,1000000,'offset');
    const values=[period.start,period.end,search(r.query.q)];
    const where=`FROM platform_redeem_codes c LEFT JOIN platform_users u ON u.id=c.redeemed_by WHERE c.redeemed_at >= $1 AND c.redeemed_at < $2 AND c.redeemed_by IS NOT NULL AND (c.prefix ILIKE $3 OR c.batch ILIKE $3 OR u.email ILIKE $3 OR u.name ILIKE $3)`;
    return db.tx(async(q)=>{
      await q.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      await q.query("SET LOCAL statement_timeout='10s'");
      const summary=(await q.query(`SELECT count(*)::int AS redemptions,count(DISTINCT c.id)::int AS codes,count(DISTINCT c.redeemed_by)::int AS accounts,COALESCE(sum(c.points),0)::float8 AS amount ${where}`,values)).rows[0];
      const items=(await q.query(`SELECT c.id,c.id AS code_id,c.prefix,c.redeemed_by AS user_id,u.email,u.name,c.batch AS note,c.points AS amount,c.redeemed_at ${where} ORDER BY c.redeemed_at DESC,c.id DESC LIMIT $4 OFFSET $5`,[...values,limit,offset])).rows;
      return {items,summary,total:summary.redemptions,limit,offset,start_date:period.start_date,end_date:period.end_date,timezone:period.timezone};
    });
  });
  app.get("/api/admin/v1/redeem-codes", async (r) => {
    const limit = integer(Number(r.query.limit || 50), 1, 100, "limit");
    const offset = integer(Number(r.query.offset || 0), 0, 1000000, "offset");
    const values = [
      search(r.query.q),
      option(r.query.status, ["used", "available", "disabled", "expired"]),
    ];
    const source = `FROM (SELECT c.*, CASE WHEN redeemed_by IS NOT NULL THEN 'used' WHEN disabled THEN 'disabled' WHEN expires_at<=now() THEN 'expired' ELSE 'available' END AS status FROM platform_redeem_codes c) c LEFT JOIN platform_users u ON u.id=c.redeemed_by`;
    const where = `${source} WHERE (c.prefix ILIKE $1 OR c.batch ILIKE $1 OR u.email ILIKE $1) AND ($2='' OR c.status=$2)`;
    const [items, count, stats] = await Promise.all([
      db.query(
        `SELECT c.id,c.prefix,c.points,c.batch,c.status,c.redeemed_by,c.disabled,c.created_at,c.redeemed_at,c.expires_at,(c.encrypted_code IS NOT NULL) AS copyable,u.email AS redeemed_email ${where} ORDER BY c.created_at DESC,c.id DESC LIMIT $3 OFFSET $4`,
        [...values, limit, offset],
      ),
      db.one(`SELECT count(*)::int AS total ${where}`, values),
      db.one(
        `SELECT count(*)::int AS issued,count(*) FILTER(WHERE c.status='available')::int AS available,count(*) FILTER(WHERE c.status='used')::int AS used,coalesce(sum(c.points) FILTER(WHERE c.status='used'),0)::float8 AS redeemed_points ${source}`,
      ),
    ]);
    return { items: items.rows, total: count.total, stats, limit, offset };
  });
  app.post("/api/admin/v1/redeem-codes", async (r) => {
    const points = integer(r.body?.points, 1, 1000000, "积分");
    const count = integer(r.body?.count, 1, 100, "数量");
    const days =
      r.body?.days == null ? null : integer(r.body.days, 1, 3660, "有效天数");
    const batch = String(
      r.body?.batch ||
        `GR-${new Date().toISOString().slice(0, 10)}-${id().slice(0, 8)}`,
    ).trim();
    fail(batch.length > 0 && batch.length <= 80, "批次名称须为 1～80 字");
    const codes = [];
    await redeemTransaction(db, async (q) => {
      for (let i = 0; i < count; i++) {
        const code = `GR-${token()}`;
        await q.query(
          "INSERT INTO platform_redeem_codes(id,hash,prefix,points,encrypted_code,batch,expires_at) VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $7::int IS NULL THEN NULL ELSE now()+$7*interval '1 day' END)",
          [
            id(),
            digest(code),
            code.slice(0, 10),
            points,
            crypt.encrypt(code),
            batch,
            days,
          ],
        );
        codes.push(code);
      }
      await audit(q, r.user.id, "redeem.create", "", `${count}×${points}`);
    });
    return { codes, batch };
  });
  app.post("/api/admin/v1/redeem-codes/batch", async (r) => {
    const input = r.body?.ids,
      action = r.body?.action;
    fail(
      Array.isArray(input) &&
        input.length > 0 &&
        input.length <= 100 &&
        input.every((x) => typeof x === "string" && x.length <= 80),
      "请选择 1～100 条记录",
    );
    const ids = [...new Set(input)];
    fail(
      ["copy", "export", "enable", "disable", "delete"].includes(action),
      "批量操作无效",
    );
    return redeemTransaction(db, async (q) => {
      if (["copy", "export"].includes(action)) {
        const rows = (
          await q.query(
            "SELECT * FROM platform_redeem_codes WHERE id=ANY($1::text[]) FOR SHARE",
            [ids],
          )
        ).rows;
        const selected = ids
          .map((key) => rows.find((row) => row.id === key))
          .filter(
            (row) =>
              row?.encrypted_code &&
              (action === "copy" ||
                (!row.disabled &&
                  !row.redeemed_by &&
                  (!row.expires_at ||
                    new Date(row.expires_at).getTime() > Date.now()))),
          );
        const codes = selected.map((row) => crypt.decrypt(row.encrypted_code));
        fail(
          codes.length,
          "所选兑换码无可导出的完整内容；历史兑换码未保存原文，导出仅含有效未使用的码",
          409,
        );
        await audit(
          q,
          r.user.id,
          `redeem.${action}`,
          "",
          `${codes.length} 条记录`,
        );
        return { codes, skipped: ids.length - codes.length };
      }
      const result =
        action === "delete"
          ? await q.query(
              "DELETE FROM platform_redeem_codes WHERE id=ANY($1::text[]) AND redeemed_by IS NULL RETURNING id",
              [ids],
            )
          : await q.query(
              "UPDATE platform_redeem_codes SET disabled=$2 WHERE id=ANY($1::text[]) AND redeemed_by IS NULL RETURNING id",
              [ids, action === "disable"],
            );
      await audit(
        q,
        r.user.id,
        `redeem.${action}`,
        "",
        `${result.rowCount} 条记录`,
      );
      return {
        ok: true,
        changed: result.rowCount,
        skipped: ids.length - result.rowCount,
      };
    });
  });
  app.patch("/api/admin/v1/redeem-codes/:id", async (r) => {
    fail(typeof r.body?.disabled === "boolean", "状态格式错误");
    await redeemTransaction(db, async (q) => {
      const result = await q.query(
        "UPDATE platform_redeem_codes SET disabled=$2 WHERE id=$1 AND redeemed_by IS NULL RETURNING id",
        [r.params.id, r.body.disabled],
      );
      fail(result.rowCount, "兑换码不存在或已使用", 409);
      await audit(
        q,
        r.user.id,
        r.body.disabled ? "redeem.disable" : "redeem.enable",
        r.params.id,
      );
    });
    return { ok: true };
  });
}
module.exports = { registerRedeemCodes, redeemTransaction };
