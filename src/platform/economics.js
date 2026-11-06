"use strict";
const RATES = Object.freeze({ usd_cny:6.7, points_per_cny:10 });
const round = n => Math.round((Number(n) + Number.EPSILON) * 1e6) / 1e6;
function economics(points, cost, stats = {}) {
  const converted={mail:0,sms:0}, unsupported=[];
  let pending=false;
  for(const kind of ["mail","sms"]) for(const [currency,value] of Object.entries(cost?.[kind] || {})) {
    const rate=currency==='USD'?RATES.usd_cny:currency==='CNY'?1:null;
    if(rate===null && Number(value.confirmed)>0) unsupported.push(currency);
    else if(rate!==null) converted[kind]+=Number(value.confirmed || 0)*rate;
    pending ||= Number(value.pending)>0;
  }
  const revenue=Number(points || 0)/RATES.points_per_cny,total=round(converted.mail+converted.sms),profit=round(revenue-total);
  return {rates:RATES,revenue_points:Number(points || 0),revenue_cny:round(revenue),mail_cny:round(converted.mail),sms_cny:round(converted.sms),
    cost_cny:total,profit_cny:profit,margin_percent:revenue?round(profit/revenue*100):null,
    missing_attempts:Number(cost?.missing || 0),unsupported_currencies:[...new Set(unsupported)],
    complete:!cost?.missing && !cost?.pending && !pending && !unsupported.length,
    orders:Number(stats.orders || 0),delivered:Number(stats.delivered || 0),open_orders:Number(stats.open_orders || 0)};
}
module.exports={RATES,economics};
