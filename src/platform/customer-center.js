"use strict";
const { fail } = require("./security");
const { page, search, option } = require("./reports");

function dateBound(value) {
  if (!value) return null;
  fail(
    typeof value === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(value) &&
      value.slice(0, 4) !== "0000" &&
      Number.isFinite(Date.parse(value)) &&
      new Date(value).toISOString().slice(0, 10) === value,
    "日期格式不正确",
  );
  return value;
}
function registerCustomerCenter(app, db) {
  app.get("/api/user/v1/profile-summary", async (r) => {
    const settings = await db.settings();
    const enabled = (key) =>
      r.user.role === "admin" || settings.features[key] !== false;
    const stats = await db.one(
      "SELECT count(*)::int AS orders,count(*) FILTER(WHERE status='completed')::int AS completed,count(*) FILTER(WHERE status IN ('queued','running'))::int AS pending,count(*) FILTER(WHERE status='review')::int AS review,coalesce(sum(charged),0)::float8 AS spent FROM platform_orders WHERE user_id=$1",
      [r.user.id],
    );
    return {
      stats: {
        ...(enabled("orders")
          ? {
              orders: stats.orders,
              completed: stats.completed,
              pending: stats.pending,
              review: stats.review,
            }
          : {}),
        ...(enabled("wallet") ? { spent: stats.spent } : {}),
      },
    };
  });
  app.get("/api/user/v1/wallet", async (r) => {
    const p = page(r.query);
    const kind = option(r.query.kind, [
      "reserve",
      "release",
      "charge",
      "redeem",
      "adjust",
    ]);
    const tab = option(r.query.tab, ["ledger", "recharges"]);
    const start = dateBound(r.query.start),
      end = dateBound(r.query.end);
    fail(!start || !end || start <= end, "结束日期不能早于开始日期");
    const settings = await db.settings(),
      showOrders =
        r.user.role === "admin" || settings.features.orders !== false;
    const values = [r.user.id, search(r.query.q), kind, tab, start, end];
    const from = `FROM platform_ledger l
      LEFT JOIN platform_items i ON l.kind IN ('charge','release') AND i.id=split_part(l.reference,':',2)
      LEFT JOIN platform_orders o ON o.user_id=l.user_id AND o.id=CASE WHEN l.kind='reserve' THEN split_part(l.reference,':',2) ELSE i.order_id END
      WHERE l.user_id=$1 AND (l.note ILIKE $2 OR l.id ILIKE $2 ${showOrders ? "OR o.id ILIKE $2" : ""})
      AND ($3='' OR l.kind=$3) AND ($4<>'recharges' OR l.kind='redeem' OR (l.kind='adjust' AND l.points_delta>0))
      AND ($5::date IS NULL OR l.created_at>=($5::date::timestamp AT TIME ZONE 'Asia/Shanghai'))
      AND ($6::date IS NULL OR l.created_at<(($6::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai'))`;
    return db.tx(async (q) => {
      await q.query(
        "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
      );
      const account = await q.query(
        "SELECT points,frozen FROM platform_users WHERE id=$1",
        [r.user.id],
      );
      const rows = await q.query(
        `SELECT l.id,l.kind,l.note,l.points_delta,l.frozen_delta,l.points_after,l.frozen_after,l.created_at${showOrders ? ",o.id AS order_id,o.need_oauth" : ""} ${from} ORDER BY l.created_at DESC,l.id DESC LIMIT $7 OFFSET $8`,
        [...values, p.limit, p.offset],
      );
      const summary = await q.query(
        `SELECT count(*)::int AS total,coalesce(sum(l.points_delta) FILTER(WHERE l.kind='redeem' OR (l.kind='adjust' AND l.points_delta>0)),0)::float8 AS credited,coalesce(sum(-l.frozen_delta) FILTER(WHERE l.kind='charge'),0)::float8 AS charged,coalesce(sum(l.frozen_delta) FILTER(WHERE l.kind='reserve'),0)::float8 AS reserved,coalesce(sum(l.points_delta) FILTER(WHERE l.kind='release'),0)::float8 AS released ${from}`,
        values,
      );
      const { total, ...totals } = summary.rows[0];
      return { ...account.rows[0], items: rows.rows, total, totals, ...p };
    });
  });
}
module.exports = { registerCustomerCenter };
