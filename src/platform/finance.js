"use strict";
const { fail, integer } = require("./security");
const { sumCosts, costAmountRows } = require("./execution-costs");
const DAY = 86400000;
function financeQuery(query = {}) {
  const today = new Date(Date.now() + 8*3600000).toISOString().slice(0,10);
  const days = integer(Number(query.days || 30), 1, 3660, "统计天数");
  const start = query.start || new Date(Date.parse(today)-(days-1)*DAY).toISOString().slice(0,10);
  const end = query.end || today;
  for (const d of [start,end]) fail(typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d)
    && Number.isFinite(Date.parse(d)) && new Date(d).toISOString().slice(0,10) === d, "统计日期格式无效");
  fail(Date.parse(end)>=Date.parse(start) && Date.parse(end)-Date.parse(start)<=3660*DAY, "统计日期范围无效");
  const period=query.period || "day";
  fail(["day","week","month","year"].includes(period), "统计周期无效");
  fail(query.include_admin === undefined || ["true","false"].includes(query.include_admin), "管理员筛选无效");
  const q=String(query.q || "").trim(); fail(q.length<=200,"搜索内容过长");
  const kind=query.kind || ""; fail(["","reserve","release","charge","redeem","adjust"].includes(kind),"流水类型无效");
  return {start,end,period,include_admin:query.include_admin === "true",q,kind,
    limit:integer(Number(query.limit || 50),1,100,"limit"),offset:integer(Number(query.offset||0),0,1000000,"offset")};
}
const TOTALS = `coalesce(sum(l.points_delta) FILTER(WHERE l.kind='redeem'),0)::float8 AS credited,
  coalesce(sum(-l.frozen_delta) FILTER(WHERE l.kind='charge'),0)::float8 AS spent,
  coalesce(sum(l.points_delta) FILTER(WHERE l.kind='adjust'),0)::float8 AS adjusted,
  coalesce(sum(l.points_delta) FILTER(WHERE l.kind='release'),0)::float8 AS released`;
const TIME = "l.created_at>=($1::date AT TIME ZONE 'Asia/Shanghai') AND l.created_at<(($2::date+1) AT TIME ZONE 'Asia/Shanghai')";
const USERS = "($3::boolean OR u.role<>'admin') AND (u.email ILIKE $4 OR u.name ILIKE $4)";
async function financeData(db, query = {}, exporting = false) {
  const f=financeQuery(query), values=[f.start,f.end,f.include_admin,`%${f.q.replace(/[\\%_]/g,"\\$&")}%`];
  return db.tx(async q => {
    await q.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await q.query("SET LOCAL statement_timeout='15s'");
    const totals=(await q.query(`SELECT ${TOTALS},count(*)::int AS entries FROM platform_ledger l JOIN platform_users u ON u.id=l.user_id WHERE ${TIME} AND ${USERS}`,values)).rows[0];
    const current=(await q.query(`SELECT coalesce(sum(u.points),0)::float8 AS balance,coalesce(sum(u.frozen),0)::float8 AS frozen,count(*)::int AS users
      FROM platform_users u WHERE ($1::boolean OR u.role<>'admin') AND (u.email ILIKE $2 OR u.name ILIKE $2)`,values.slice(2))).rows[0];
    const trend=(await q.query(`SELECT to_char(date_trunc($5,l.created_at AT TIME ZONE 'Asia/Shanghai'),'YYYY-MM-DD') AS period,${TOTALS}
      FROM platform_ledger l JOIN platform_users u ON u.id=l.user_id WHERE ${TIME} AND ${USERS} GROUP BY 1 ORDER BY 1`,[...values,f.period])).rows;
    if (exporting) fail(current.users<=10000,"导出最多 10000 位客户，请缩小账户筛选范围");
    const users=(await q.query(`WITH money AS (SELECT l.user_id,${TOTALS} FROM platform_ledger l WHERE ${TIME} GROUP BY l.user_id),
      orders AS (SELECT user_id,count(*)::int AS orders FROM platform_orders l WHERE ${TIME} GROUP BY user_id)
      SELECT u.id,u.email,u.name,u.role,u.points AS balance,u.frozen,coalesce(m.credited,0) AS credited,
      coalesce(m.spent,0) AS spent,coalesce(m.adjusted,0) AS adjusted,coalesce(m.released,0) AS released,coalesce(o.orders,0) AS orders
      FROM platform_users u LEFT JOIN money m ON m.user_id=u.id LEFT JOIN orders o ON o.user_id=u.id
      WHERE ${USERS} ORDER BY credited DESC,u.email,u.id LIMIT $5 OFFSET $6`,[...values,exporting?10000:f.limit,exporting?0:f.offset])).rows;
    const costsWhere=TIME.replaceAll("l.","a.")+" AND "+USERS;
    const costStats=(await q.query(`SELECT count(*)::int AS attempts,count(*) FILTER(WHERE a.cost_snapshot IS NULL)::int AS missing,
      bool_or(a.cost_snapshot->>'complete'='false') AS pending,max(a.cost_checked_at) AS updated_at
      FROM platform_attempts a JOIN platform_items i ON i.id=a.item_id JOIN platform_orders o ON o.id=i.order_id JOIN platform_users u ON u.id=o.user_id WHERE ${costsWhere}`,values)).rows[0];
    const execution_cost={...sumCosts(),...costStats,pending:Boolean(costStats.pending)};
    const amounts=await costAmountRows(q,`SELECT a.cost_snapshot FROM platform_attempts a
      JOIN platform_items i ON i.id=a.item_id JOIN platform_orders o ON o.id=i.order_id
      JOIN platform_users u ON u.id=o.user_id WHERE ${costsWhere}`,values);
    for(const {kind,currency,...amount} of amounts) execution_cost[kind][currency]=amount;
    const userCosts=new Map(users.map(u=>[u.id,[]]));
    const costRows=(await q.query(`SELECT o.user_id,a.cost_snapshot FROM platform_attempts a JOIN platform_items i ON i.id=a.item_id
      JOIN platform_orders o ON o.id=i.order_id WHERE ${TIME.replaceAll("l.","a.")} AND o.user_id=ANY($3::text[])`,[f.start,f.end,users.map(u=>u.id)])).rows;
    for(const row of costRows)userCosts.get(row.user_id).push(row.cost_snapshot);
    for(const user of users)user.execution_cost=sumCosts(userCosts.get(user.id));
    const ledgerWhere=`FROM platform_ledger l JOIN platform_users u ON u.id=l.user_id WHERE ${TIME} AND ${USERS} AND ($5='' OR l.kind=$5)`;
    const total=(await q.query(`SELECT count(*)::int AS n ${ledgerWhere}`,[...values,f.kind])).rows[0].n;
    const items=exporting?[]:(await q.query(`SELECT l.id,l.kind,l.points_delta,l.frozen_delta,l.note,l.created_at,u.email,u.name ${ledgerWhere}
      ORDER BY l.created_at DESC,l.id DESC LIMIT $6 OFFSET $7`,[...values,f.kind,f.limit,f.offset])).rows;
    return {...f,timezone:"Asia/Shanghai",generated_at:new Date().toISOString(),totals,current,trend,users,users_total:current.users,
      execution_cost,items,total,stats:{charged:totals.spent,redeemed:totals.credited,adjusted:totals.adjusted,released:totals.released},
      daily:trend.map(t=>({...t,day:t.period,charged:t.spent}))};
  });
}
function financeCsv(data) {
  const cell = v => { let s=String(v??""); if (/^[=+\-@\t\r\n]/.test(s))s="'"+s; return '"'+s.replaceAll('"','""')+'"'; };
  const cost=(u,kind)=>Object.entries(u.execution_cost[kind]).map(([c,v])=>`${c}: 总成本 ${v.confirmed}; 未计入的报价 ${v.pending}; 已退 ${v.refunded}`).join(" | ");
  const rows=[["账户","称呼","区间充值积分","区间消费积分","人工调整积分","未交付退回积分","当前可用积分","当前冻结积分","区间订单","邮箱消耗","短信消耗","缺失费用记录","开始日期","结束日期"]];
  for(const u of data.users)rows.push([u.email,u.name,u.credited,u.spent,u.adjusted,u.released,u.balance,u.frozen,u.orders,cost(u,"mail"),cost(u,"sms"),u.execution_cost.missing,data.start,data.end]);
  return "\ufeff"+rows.map(row=>row.map(cell).join(",")).join("\r\n");
}
function registerFinance(app,db) {
  app.get("/api/admin/v1/finance",r=>financeData(db,r.query));
  app.get("/api/admin/v1/finance/export",async(r,reply)=>reply.type("text/csv; charset=utf-8")
    .header("Content-Disposition",'attachment; filename="gptreg-finance.csv"').send(financeCsv(await financeData(db,r.query,true))));
}
module.exports={financeQuery,financeData,financeCsv,registerFinance};
