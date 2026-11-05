"use strict";
const { fail, integer } = require("./security");
const { publicOrder } = require("./orders");

const page = (query) => ({
  limit: integer(Number(query.limit || 50), 1, 100, "limit"),
  offset: integer(Number(query.offset || 0), 0, 1000000, "offset"),
});
const search = (value) => {
  fail(
    value === undefined || (typeof value === "string" && value.length <= 200),
    "搜索内容过长",
  );
  return `%${String(value || "")
    .trim()
    .replace(/[\\%_]/g, "\\$&")}%`;
};
function option(value, choices) {
  const v = String(value || "");
  fail(!v || choices.includes(v), "筛选条件不正确");
  return v;
}
async function listOrders(db, owner, query) {
  const p = page(query),
    values = [
      owner,
      search(query.q),
      option(query.status, [
        "queued",
        "running",
        "review",
        "completed",
        "partial",
        "failed",
        "cancelled",
      ]),
      option(query.mode, ["standard", "oauth"]),
    ];
  const where =
    "FROM platform_orders o JOIN platform_users u ON u.id=o.user_id WHERE ($1::text IS NULL OR o.user_id=$1) AND (o.id ILIKE $2 OR u.email ILIKE $2) AND ($3='' OR o.status=$3) AND ($4='' OR o.need_oauth=($4='oauth'))";
  const [rows, count] = await Promise.all([
    db.query(
      `SELECT o.*,u.email ${where} ORDER BY o.created_at DESC,o.id DESC LIMIT $5 OFFSET $6`,
      [...values, p.limit, p.offset],
    ),
    db.one(`SELECT count(*)::int AS total ${where}`, values),
  ]);
  return {
    items: rows.rows.map((o) => ({
      ...publicOrder(o),
      ...(owner ? {} : { user_id: o.user_id, email: o.email }),
    })),
    total: count.total,
    ...p,
  };
}
async function listAccounts(db, owner, query) {
  const p = page(query),
    values = [
      owner,
      search(query.q),
      option(query.mode, ["standard", "oauth"]),
      query.order_id || null,
    ];
  const where =
    "FROM platform_accounts a JOIN platform_users u ON u.id=a.user_id WHERE ($1::text IS NULL OR a.user_id=$1) AND (a.email ILIKE $2 OR a.order_id ILIKE $2) AND ($3='' OR a.need_oauth=($3='oauth')) AND ($4::text IS NULL OR a.order_id=$4)";
  const [rows, count] = await Promise.all([
    db.query(
      `SELECT a.id,a.email,a.order_id,a.need_oauth,a.created_at${owner ? "" : ",u.email AS owner_email"} ${where} ORDER BY a.created_at DESC,a.id DESC LIMIT $5 OFFSET $6`,
      [...values, p.limit, p.offset],
    ),
    db.one(`SELECT count(*)::int AS total ${where}`, values),
  ]);
  return { items: rows.rows, total: count.total, ...p };
}
async function listLedger(db, owner, query) {
  const p = page(query),
    values = [
      owner,
      search(query.q),
      option(query.kind, ["reserve", "release", "charge", "redeem", "adjust"]),
      query.days ? integer(Number(query.days), 1, 90, "统计天数") : null,
    ];
  const where =
    "FROM platform_ledger l JOIN platform_users u ON u.id=l.user_id WHERE ($1::text IS NULL OR l.user_id=$1) AND (l.note ILIKE $2 OR u.email ILIKE $2) AND ($3='' OR l.kind=$3) AND ($4::int IS NULL OR l.created_at>=((now() AT TIME ZONE 'Asia/Shanghai')::date-($4-1)) AT TIME ZONE 'Asia/Shanghai')";
  const [rows, count] = await Promise.all([
    db.query(
      `SELECT l.id,l.kind,l.points_delta,l.frozen_delta,l.note,l.created_at${owner ? "" : ",u.email,u.name"} ${where} ORDER BY l.created_at DESC,l.id DESC LIMIT $5 OFFSET $6`,
      [...values, p.limit, p.offset],
    ),
    db.one(`SELECT count(*)::int AS total ${where}`, values),
  ]);
  return { items: rows.rows, total: count.total, ...p };
}
async function trend(db, owner, days) {
  return (
    await db.query(
      `WITH dates AS (
    SELECT generate_series((now() AT TIME ZONE 'Asia/Shanghai')::date-($2::int-1),(now() AT TIME ZONE 'Asia/Shanghai')::date,interval '1 day')::date AS day
  ), orders AS (
    SELECT (created_at AT TIME ZONE 'Asia/Shanghai')::date AS day,count(*)::int AS orders
    FROM platform_orders WHERE ($1::text IS NULL OR user_id=$1) AND created_at>=((now() AT TIME ZONE 'Asia/Shanghai')::date-($2-1)) AT TIME ZONE 'Asia/Shanghai' GROUP BY 1
  ), charges AS (
    SELECT (created_at AT TIME ZONE 'Asia/Shanghai')::date AS day,sum(-frozen_delta)::bigint AS charged
    FROM platform_ledger WHERE kind='charge' AND ($1::text IS NULL OR user_id=$1) AND created_at>=((now() AT TIME ZONE 'Asia/Shanghai')::date-($2-1)) AT TIME ZONE 'Asia/Shanghai' GROUP BY 1
  ) SELECT to_char(d.day,'YYYY-MM-DD') AS day,coalesce(o.orders,0)::int AS orders,coalesce(c.charged,0)::float8 AS charged FROM dates d LEFT JOIN orders o USING(day) LEFT JOIN charges c USING(day) ORDER BY d.day`,
      [owner, days],
    )
  ).rows;
}
function registerReports(app, db) {
  app.get("/api/user/v1/overview", async (r) => {
    const [stats, recent, ledger, daily] = await Promise.all([
      db.one(
        "SELECT count(*)::int AS orders,count(*) FILTER(WHERE status IN ('queued','running','review'))::int AS active_orders,coalesce(sum(delivered),0)::int AS delivered,coalesce(sum(charged),0)::float8 AS spent,coalesce(sum(released),0)::float8 AS released FROM platform_orders WHERE user_id=$1",
        [r.user.id],
      ),
      listOrders(db, r.user.id, { limit: 5 }),
      listLedger(db, r.user.id, { limit: 4 }),
      trend(db, r.user.id, 7),
    ]);
    return {
      stats,
      recent_orders: recent.items,
      recent_ledger: ledger.items,
      daily,
    };
  });
  app.get("/api/admin/v1/overview", async (r) => {
    const days = integer(Number(r.query.days || 7), 1, 90, "统计天数");
    const [users, orders, recent, daily, worker, settings] = await Promise.all([
      db.one(
        "SELECT count(*) FILTER(WHERE role='member')::int AS customers,count(*) FILTER(WHERE role='member' AND status='active')::int AS active_customers,coalesce(sum(points) FILTER(WHERE role='member'),0)::float8 AS balance,coalesce(sum(frozen) FILTER(WHERE role='member'),0)::float8 AS frozen FROM platform_users",
      ),
      db.one(
        "SELECT count(*)::int AS orders,count(*) FILTER(WHERE status='queued')::int AS queued,count(*) FILTER(WHERE status='running')::int AS running,count(*) FILTER(WHERE status='review')::int AS review,count(*) FILTER(WHERE status='completed')::int AS completed,coalesce(sum(delivered),0)::int AS delivered,coalesce(sum(charged),0)::float8 AS charged,coalesce(sum(released),0)::float8 AS released,count(*) FILTER(WHERE created_at>=(now() AT TIME ZONE 'Asia/Shanghai')::date AT TIME ZONE 'Asia/Shanghai')::int AS today_orders FROM platform_orders",
      ),
      listOrders(db, null, { limit: 6 }),
      trend(db, null, days),
      db.one("SELECT * FROM platform_worker WHERE id=1"),
      db.settings(),
    ]);
    return {
      stats: { ...users, ...orders },
      recent_orders: recent.items,
      daily,
      worker,
      operations: {
        orders_open: settings.orders_open,
        worker_enabled: settings.worker_enabled,
        api_enabled: settings.api_enabled,
        price_standard: settings.price_standard,
        price_oauth: settings.price_oauth,
        max_quantity: settings.max_quantity,
      },
      days,
    };
  });
  app.get("/api/admin/v1/finance", async (r) => {
    const days = integer(Number(r.query.days || 30), 1, 90, "统计天数");
    const [stats, entries, daily] = await Promise.all([
      db.one(
        "SELECT coalesce(sum(-frozen_delta) FILTER(WHERE kind='charge'),0)::float8 AS charged,coalesce(sum(points_delta) FILTER(WHERE kind='redeem'),0)::float8 AS redeemed,coalesce(sum(points_delta) FILTER(WHERE kind='adjust'),0)::float8 AS adjusted,coalesce(sum(points_delta) FILTER(WHERE kind='release'),0)::float8 AS released FROM platform_ledger WHERE created_at>=((now() AT TIME ZONE 'Asia/Shanghai')::date-($1::int-1)) AT TIME ZONE 'Asia/Shanghai'",
        [days],
      ),
      listLedger(db, null, { ...r.query, days }),
      trend(db, null, days),
    ]);
    return { stats, ...entries, daily, days };
  });
  app.get("/api/admin/v1/accounts", (r) => listAccounts(db, null, r.query));
  app.get("/api/admin/v1/users/:id", async (r) => {
    const user = await db.one(
      "SELECT id,email,name,role,status,points,frozen,created_at FROM platform_users WHERE id=$1",
      [r.params.id],
    );
    fail(user, "账户不存在", 404);
    const [orders, ledger, stats] = await Promise.all([
      listOrders(db, user.id, { limit: 8 }),
      listLedger(db, user.id, { limit: 8 }),
      db.one(
        "SELECT count(*)::int AS orders,coalesce(sum(charged),0)::float8 AS spent,coalesce(sum(delivered),0)::int AS delivered FROM platform_orders WHERE user_id=$1",
        [user.id],
      ),
    ]);
    return { user, stats, orders: orders.items, ledger: ledger.items };
  });
}
module.exports = {
  registerReports,
  listOrders,
  listAccounts,
  listLedger,
  page,
  search,
  option,
};
