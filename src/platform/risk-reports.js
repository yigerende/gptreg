"use strict";
const { fail, integer } = require("./security");
const { settings } = require("./risk-config");
function filters(query) {
  const text = String(query.q || "").trim();
  fail(text.length <= 254, "搜索内容过长");
  const values = [`%${text.replace(/[\\%_]/g, "\\$&")}%`];
  const start = query.start,
    end = query.end;
  for (const value of [start, end])
    if (value) {
      const stamp = Date.parse(`${value}T00:00:00Z`);
      fail(
        /^\d{4}-\d{2}-\d{2}$/.test(value) &&
          Number.isFinite(stamp) &&
          new Date(stamp).toISOString().slice(0, 10) === value,
        "日期格式无效",
      );
    }
  fail(!start || !end || start <= end, "结束日期不得早于开始日期");
  values.push(
    start ? `${start}T00:00:00+08:00` : null,
    end ? `${end}T00:00:00+08:00` : null,
  );
  return values;
}
async function monitor(db, query) {
  const params = filters(query),
    cfg = await settings(db);
  const offset = integer(Number(query.offset || 0), 0, 1000000, "offset"),
    limit = integer(Number(query.limit || 50), 1, 100, "limit");
  const category = String(query.category || ""),
    state = String(query.state || "");
  fail(
    [
      "",
      "login",
      "access",
      "limit",
      "application",
      "finance",
      "admin",
    ].includes(category),
    "事件类别无效",
  );
  fail(["", "pending", "resolved"].includes(state), "事件状态无效");
  const search = `(u.email ILIKE $1 OR u.name ILIKE $1 OR k.name ILIKE $1 OR e.source_ip ILIKE $1 OR e.account ILIKE $1 OR e.target ILIKE $1)`;
  const eventFrom = `FROM platform_risk_events e LEFT JOIN platform_users u ON u.id=e.user_id LEFT JOIN platform_api_keys k ON k.id=e.key_id WHERE ${search}
    AND ($2::timestamptz IS NULL OR e.last_seen>=$2) AND ($3::timestamptz IS NULL OR e.last_seen<$3::timestamptz+interval '1 day')
    AND ($4='' OR e.category=$4) AND ($5='' OR ($5='pending' AND e.resolved_at IS NULL AND e.severity<>'info') OR ($5='resolved' AND e.resolved_at IS NOT NULL))`;
  const ep = [...params, category, state];
  const items = (
    await db.query(
      `SELECT e.*,u.name AS user_name,k.name AS key_name ${eventFrom} ORDER BY e.last_seen DESC,e.id DESC LIMIT $6 OFFSET $7`,
      [...ep, limit, offset],
    )
  ).rows;
  const totals = await db.one(
    `SELECT count(*)::int AS total,count(*) FILTER(WHERE resolved_at IS NULL AND severity<>'info')::int AS pending,
    coalesce(sum(occurrences) FILTER(WHERE kind='login_failed'),0)::float8 AS login_failures ${eventFrom}`,
    ep,
  );
  const trafficFrom = `FROM platform_risk_traffic t LEFT JOIN platform_users u ON u.id=t.user_id LEFT JOIN platform_api_keys k ON k.id=t.key_id
    WHERE (u.email ILIKE $1 OR u.name ILIKE $1 OR k.name ILIKE $1 OR t.source_ip ILIKE $1)
    AND ($2::timestamptz IS NULL OR t.minute>=$2) AND ($3::timestamptz IS NULL OR t.minute<$3::timestamptz+interval '1 day')`;
  const traffic = (
    await db.query(
      `SELECT t.user_id,t.key_id,u.email,u.name AS user_name,k.name AS key_name,t.operation,t.channel,
    sum(requests)::float8 AS requests,sum(errors)::float8 AS errors,sum(blocked)::float8 AS blocked,round(sum(duration_ms)/greatest(sum(requests),1))::float8 AS average_ms
    ${trafficFrom} GROUP BY t.user_id,t.key_id,u.email,u.name,k.name,t.operation,t.channel ORDER BY requests DESC LIMIT 100`,
      params,
    )
  ).rows;
  const summary = await db.one(
    `SELECT coalesce(sum(requests),0)::float8 AS requests,coalesce(sum(errors),0)::float8 AS errors,
    coalesce(sum(blocked),0)::float8 AS blocked,coalesce(round(sum(duration_ms)/greatest(sum(requests),1)),0)::float8 AS average_ms ${trafficFrom}`,
    params,
  );
  const restrictions = (
    await db.query(
      `SELECT b.*,u.email,u.name AS user_name,k.name AS key_name FROM platform_risk_buckets b
    LEFT JOIN platform_users u ON u.id=b.user_id LEFT JOIN platform_api_keys k ON k.id=b.key_id WHERE blocked_until>now()
    AND (b.label ILIKE $1 OR u.name ILIKE $1 OR k.name ILIKE $1) ORDER BY blocked_until DESC LIMIT 100`,
      [params[0]],
    )
  ).rows;
  const customers = (
    await db.query(
      `SELECT c.*,u.email,u.name,(paused AND (paused_until IS NULL OR paused_until>now())) AS currently_paused
    FROM platform_risk_controls c JOIN platform_users u ON u.id=c.user_id WHERE (u.email ILIKE $1 OR u.name ILIKE $1) ORDER BY c.updated_at DESC LIMIT 100`,
      [params[0]],
    )
  ).rows;
  const current = await db.one(
    `SELECT
    (SELECT count(*)::int FROM platform_risk_buckets b LEFT JOIN platform_users u ON u.id=b.user_id LEFT JOIN platform_api_keys k ON k.id=b.key_id WHERE blocked_until>now() AND (b.label ILIKE $1 OR u.name ILIKE $1 OR k.name ILIKE $1)) AS restrictions,
    (SELECT count(*)::int FROM platform_risk_controls c JOIN platform_users u ON u.id=c.user_id WHERE paused AND (paused_until IS NULL OR paused_until>now()) AND (u.email ILIKE $1 OR u.name ILIKE $1)) AS paused_customers`,
    [params[0]],
  );
  return {
    items,
    total: totals.total,
    summary: { ...summary, ...totals, ...current },
    traffic,
    restrictions,
    customers,
    generated_at: new Date(),
    last_scan: (
      await db.one("SELECT last_scan FROM platform_risk_scan WHERE id=1")
    ).last_scan,
    refresh_seconds: cfg.refresh_seconds,
    monitoring_enabled: cfg.enabled,
  };
}
module.exports = { monitor };
