export type Period = 'day' | 'week' | 'month' | 'year';
export const periods: {key:Period;label:string}[] = [{key:'day',label:'每日'},{key:'week',label:'每周'},{key:'month',label:'每月'},{key:'year',label:'每年'}];
export const todayBeijing = () => new Date(Date.now()+8*3600000).toISOString().slice(0,10);
export const beijingTime = (value:string) => value ? new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}) : '—';
export function shiftPeriod(anchor:string,period:Period,direction:number):string {
 const d=new Date(`${anchor}T00:00:00Z`);
 if(!Number.isFinite(d.getTime()))return todayBeijing();
 if(period==='year'){d.setUTCMonth(0,1);d.setUTCFullYear(d.getUTCFullYear()+direction)}
 else if(period==='month'){d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+direction)}
 else d.setUTCDate(d.getUTCDate()+direction*(period==='week'?7:1));
 const result=d.toISOString().slice(0,10);
 return result<'1900-01-01'||result>'9998-12-31'?anchor:result;
}
