"use strict";
const {fail}=require('./security');
function reportPeriod(period='day',anchor='',now=new Date()) {
 fail(['day','week','month','year'].includes(period),'统计周期须为日、周、月或年');
 const value=anchor||new Date(now.getTime()+8*3600000).toISOString().slice(0,10);
 fail(typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value),'请选择有效日期');
 const start=new Date(`${value}T00:00:00Z`);
 fail(Number.isFinite(start.getTime()) && start.toISOString().slice(0,10)===value && start.getUTCFullYear()>=1900 && start.getUTCFullYear()<=9998,'请选择有效日期');
 if(period==='week')start.setUTCDate(start.getUTCDate()-(start.getUTCDay()+6)%7);
 else if(period==='month')start.setUTCDate(1);
 else if(period==='year')start.setUTCMonth(0,1);
 const end=new Date(start);
 if(period==='year')end.setUTCFullYear(end.getUTCFullYear()+1);
 else if(period==='month')end.setUTCMonth(end.getUTCMonth()+1);
 else end.setUTCDate(end.getUTCDate()+(period==='week'?7:1));
 return {start:new Date(start.getTime()-8*3600000),end:new Date(end.getTime()-8*3600000),start_date:start.toISOString().slice(0,10),end_date:new Date(end.getTime()-86400000).toISOString().slice(0,10),timezone:'Asia/Shanghai'};
}
module.exports={reportPeriod};
