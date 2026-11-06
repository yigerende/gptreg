"use strict";
const {financeQuery}=require("./finance");
const {fail}=require("./security");
const {PROVIDERS}=require("./supplier-facts");
const {economics}=require("./economics");
function supplierQuery(query={}) {
  const f=financeQuery({...query,kind:undefined,include_admin:query.include_admin ?? "true"});
  const kind=query.kind || "mail";
  fail(["mail","sms"].includes(kind),"资源类型无效");
  for(const name of ["provider","country"]) fail(query[name]===undefined || typeof query[name]==="string" && /^[a-zA-Z0-9_.-]{0,40}$/.test(query[name]),"供应商或国家筛选无效");
  return {...f,kind,provider:query.provider || "",country:kind==="sms"?query.country || "":""};
}
const statsSql=`count(*)::int AS total,count(*) FILTER(WHERE r->>'outcome'='succeeded')::int AS succeeded,
  count(*) FILTER(WHERE r->>'outcome'='failed')::int AS failed,count(*) FILTER(WHERE r->>'outcome'='active')::int AS active,
  count(*) FILTER(WHERE r->>'outcome' NOT IN ('succeeded','failed','active'))::int AS unknown,
  count(*) FILTER(WHERE r->>'received'='true')::int AS received,
  count(*) FILTER(WHERE r->>'outcome' IN ('succeeded','failed') AND r->>'received' IN ('true','false'))::int AS receipt_known,
  count(*) FILTER(WHERE r->>'outcome' IN ('succeeded','failed') AND r->>'received'='true')::int AS receipt_success,
  count(*) FILTER(WHERE r->>'price_unknown'='true')::int AS price_unknown`;
function rates(row) {
  const ended=row.succeeded+row.failed;
  return {...row,success_rate:ended?row.succeeded/ended*100:null,receipt_rate:row.receipt_known?row.receipt_success/row.receipt_known*100:null};
}
async function supplierData(db,query={}) {
  const f=supplierQuery(query);
  const values=[f.start,f.end,f.include_admin,f.kind,f.provider,f.country];
  return db.tx(async q=>{
    await q.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");await q.query("SET LOCAL statement_timeout='15s'");
    const cte=`WITH attempts AS (SELECT a.cost_snapshot FROM platform_attempts a JOIN platform_items i ON i.id=a.item_id JOIN platform_orders o ON o.id=i.order_id JOIN platform_users u ON u.id=o.user_id
      WHERE a.created_at>=($1::date AT TIME ZONE 'Asia/Shanghai') AND a.created_at<(($2::date+1) AT TIME ZONE 'Asia/Shanghai') AND ($3::boolean OR u.role<>'admin')),
      raw AS (SELECT r,coalesce(cost_snapshot->>'updated_at','') AS updated FROM attempts CROSS JOIN LATERAL jsonb_array_elements(coalesce(cost_snapshot->'supplier_records'->$4,cost_snapshot->'resource_records'->$4,'[]'::jsonb)) AS resource(r)),
      distinct_resources AS (SELECT DISTINCT ON (r->>'key') r FROM raw ORDER BY r->>'key',updated DESC),
      all_records AS (SELECT r,coalesce(nullif(r->>'provider',''),'unknown') AS provider,CASE WHEN $4='sms' THEN coalesce(nullif(r->>'country',''),'unknown') ELSE '' END AS country FROM distinct_resources WHERE r->>'counted'='true'),
      selected AS (SELECT * FROM all_records WHERE ($5='' OR provider=$5) AND ($6='' OR country=$6))`;
    const summary=rates((await q.query(`${cte} SELECT ${statsSql} FROM selected`,values)).rows[0]);
    const groups=(await q.query(`${cte} SELECT provider,country,max(r->>'country_name') AS country_name,${statsSql},count(*) OVER()::int AS groups_total
      FROM selected GROUP BY provider,country ORDER BY total DESC,provider,country LIMIT $7 OFFSET $8`,[...values,f.limit,f.offset])).rows;
    const costs=(await q.query(`${cte} SELECT provider,country,r->>'currency' AS currency,
      coalesce(sum((r->>'confirmed')::numeric),0)::float8 AS confirmed,coalesce(sum((r->>'pending')::numeric),0)::float8 AS pending,
      coalesce(sum((r->>'confirmed')::numeric) FILTER(WHERE r->>'outcome'='failed'),0)::float8 AS failed_cost
      FROM selected GROUP BY provider,country,r->>'currency'`,values)).rows;
    const options=(await q.query(`${cte} SELECT provider,country,max(r->>'country_name') AS country_name FROM all_records GROUP BY provider,country ORDER BY provider,country`,values)).rows;
    const coverage=(await q.query(`${cte} SELECT count(*)::int AS attempts,count(*) FILTER(WHERE cost_snapshot IS NULL OR cost_snapshot->'supplier_records'->$4 IS NULL)::int AS incomplete_attempts FROM attempts`,values)).rows[0];
    const amountsFor=(rows)=>Object.fromEntries(rows.map(c=>[c.currency,{confirmed:c.confirmed,pending:c.pending,refunded:0,failed_cost:c.failed_cost}]));
    const totalAmounts={};for(const c of costs){const t=totalAmounts[c.currency] ||= {confirmed:0,pending:0,refunded:0,failed_cost:0};for(const k of ['confirmed','pending','failed_cost'])t[k]=Number((t[k]+c[k]).toFixed(6));}
    const totalCost=economics(0,{[f.kind]:totalAmounts});
    return {...f,generated_at:new Date().toISOString(),timezone:"Asia/Shanghai",coverage,
      summary:{...summary,costs:totalAmounts,cost_cny:totalCost.cost_cny},
      items:groups.map(g=>{const amounts=amountsFor(costs.filter(c=>c.provider===g.provider && c.country===g.country));return {...rates(g),provider_name:PROVIDERS[g.provider]||g.provider,country_name:g.country_name || (g.country==='unknown'?'未记录国家':`国家 ${g.country}`),costs:amounts,cost_cny:economics(0,{[f.kind]:amounts}).cost_cny};}),
      total:groups[0]?.groups_total || costs.reduce((s,c)=>s.add(c.provider+'|'+c.country),new Set()).size,
      providers:[...new Set(options.map(o=>o.provider))].map(id=>({id,name:PROVIDERS[id]||id})),
      countries:options.filter(o=>o.country && (!f.provider || o.provider===f.provider)).map(o=>({id:o.country,name:o.country_name || (o.country==='unknown'?'未记录国家':`国家 ${o.country}`)})).filter((c,i,arr)=>arr.findIndex(x=>x.id===c.id)===i)};
  });
}
function registerSuppliers(app,db){app.get("/api/admin/v1/suppliers",r=>supplierData(db,r.query));}
module.exports={supplierQuery,supplierData,registerSuppliers};
