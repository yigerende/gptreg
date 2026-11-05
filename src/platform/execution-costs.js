"use strict";
const { summarizeBranchState } = require("../branch-orchestrator");
const rounded = (n) => Math.round(Number(n || 0) * 1e6) / 1e6;
const amount = (n) => Number.isFinite(Number(n)) ? Math.max(0, Number(n)) : 0;
const bucket = (confirmed = 0, pending = 0, refunded = 0) => ({ confirmed: amount(confirmed), pending: amount(pending), refunded: amount(refunded) });

// Store amounts only: checkpoints contain passwords, provider keys and tokens.
function costSnapshot(state) {
  const s = summarizeBranchState(state), c = s.costs, b = s.billing;
  const sms = {};
  for (const [currency, value] of Object.entries(b.currencyTotals || {})) {
    sms[currency] = bucket(value.confirmedConsumed, value.unresolved, value.refunded);
  }
  if (!Object.keys(sms).length) sms[b.currency || "USD"] = bucket(b.confirmedConsumedUsd, b.unresolvedUsd, b.refundedUsd);
  return {
    version: 1,
    mail: { USD: bucket(c.mail, c.mailUnresolved) }, sms,
    complete: c.complete && b.billingComplete && !c.mailPending && !c.mailUnresolved,
    updated_at: new Date().toISOString(),
  };
}
function sumCosts(values = []) {
  const result = { mail: {}, sms: {}, attempts: values.length, missing: 0, pending: false, updated_at: null };
  for (const value of values) {
    if (!value || value.version !== 1) { result.missing++; continue; }
    result.pending ||= !value.complete;
    if (value.updated_at && (!result.updated_at || value.updated_at > result.updated_at)) result.updated_at = value.updated_at;
    for (const kind of ["mail", "sms"]) for (const [currency, valueBucket] of Object.entries(value[kind] || {})) {
      const target = result[kind][currency] ||= bucket();
      for (const key of ["confirmed", "pending", "refunded"]) target[key] = rounded(target[key] + amount(valueBucket[key]));
    }
  }
  return result;
}
async function costsBy(db, field, ids) {
  if (!["item_id", "order_id"].includes(field)) throw new Error("Invalid cost grouping");
  if (!ids.length) return new Map();
  const rows = (await db.query(`SELECT ${field === "item_id" ? "a.item_id" : "i.order_id"} AS id,a.cost_snapshot FROM platform_attempts a JOIN platform_items i ON i.id=a.item_id WHERE ${field === "item_id" ? "a.item_id" : "i.order_id"}=ANY($1::text[])`, [ids])).rows;
  const grouped = new Map(ids.map(id => [id, []]));
  for (const row of rows) grouped.get(row.id).push(row.cost_snapshot);
  return new Map([...grouped].map(([id, values]) => [id, sumCosts(values)]));
}
async function attachCosts(db, rows, field = "order_id", rowKey = "id") {
  const costs = await costsBy(db, field, rows.map(row => row[rowKey]));
  return rows.map(row => ({ ...row, execution_cost: costs.get(row[rowKey]) }));
}
async function syncAttemptCosts(db, manager, runId, state) {
  // Keep the last valid snapshot when history is unavailable; never replace it with zero.
  try {
    const value = costSnapshot(state || manager.load(runId));
    await db.query("UPDATE platform_attempts SET cost_snapshot=$2,cost_checked_at=now() WHERE run_id=$1", [runId, value]);
  } catch {
    await db.query("UPDATE platform_attempts SET cost_checked_at=now() WHERE run_id=$1", [runId]);
  }
}
async function backfillCosts(db, manager) {
  const rows = (await db.query(`SELECT a.run_id FROM platform_attempts a JOIN platform_items i ON i.id=a.item_id
    WHERE i.status NOT IN ('running','review') AND (a.cost_snapshot IS NULL OR a.cost_snapshot->>'complete'='false')
    AND (a.cost_checked_at IS NULL OR a.cost_checked_at<now()-interval '5 minutes')
    ORDER BY a.cost_checked_at NULLS FIRST,a.created_at LIMIT 20`)).rows;
  for (const row of rows) await syncAttemptCosts(db, manager, row.run_id);
}
async function periodCosts(db, days) {
  const where = "created_at>=((now() AT TIME ZONE 'Asia/Shanghai')::date-($1::int-1)) AT TIME ZONE 'Asia/Shanghai'";
  const result = sumCosts();
  const stats = await db.one(`SELECT count(*)::int AS attempts,count(*) FILTER(WHERE cost_snapshot IS NULL)::int AS missing,bool_or(cost_snapshot->>'complete'='false') AS pending,max(cost_checked_at) AS updated_at FROM platform_attempts WHERE ${where}`, [days]);
  const rows = (await db.query(`SELECT kind,currency,sum((value->>'confirmed')::numeric)::float8 AS confirmed,sum((value->>'pending')::numeric)::float8 AS pending,sum((value->>'refunded')::numeric)::float8 AS refunded FROM platform_attempts CROSS JOIN (VALUES ('mail'),('sms')) AS kinds(kind) CROSS JOIN LATERAL jsonb_each(coalesce(cost_snapshot->kind,'{}'::jsonb)) AS amounts(currency,value) WHERE ${where} GROUP BY kind,currency`, [days])).rows;
  for (const row of rows) result[row.kind][row.currency] = bucket(row.confirmed, row.pending, row.refunded);
  return { ...result, ...stats, pending: Boolean(stats.pending), days };
}
module.exports = { costSnapshot, sumCosts, costsBy, attachCosts, syncAttemptCosts, backfillCosts, periodCosts };
