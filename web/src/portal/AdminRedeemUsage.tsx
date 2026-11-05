import {useState} from 'react';
import {useQuery} from '@tanstack/react-query';
import {call,type Row} from './client';
import {number} from './Insights';
import {type Period,periods,todayBeijing,shiftPeriod,beijingTime} from './report-period';
import './redeem-usage.css';
export default function AdminRedeemUsage(){
 const [period,setPeriod]=useState<Period>('day'),[anchor,setAnchor]=useState(todayBeijing),[search,setSearch]=useState(''),[query,setQuery]=useState(''),[offset,setOffset]=useState(0);
 const params=new URLSearchParams({period,date:anchor,q:query,offset:String(offset),limit:'50'});
 const {data,error,isFetching,refetch}=useQuery({queryKey:['admin-redeem-usage',period,anchor,query,offset],queryFn:()=>{if(!anchor)throw Error('请选择统计日期');return call(`/api/admin/v1/redeem-codes/usage?${params}`)},retry:false});
 const changeDate=(date:string)=>{setAnchor(date);setOffset(0)};
 return <section className="usage-report" aria-busy={isFetching}>
  <div className="usage-heading"><div><h2>兑换码使用情况</h2><p>按实际兑换时间查看入账明细与统计</p></div><button className="usage-btn" disabled={isFetching} onClick={()=>refetch()}>刷新统计</button></div>
  <div className="usage-controls"><div className="usage-segments" role="group" aria-label="统计周期">{periods.map(p=><button key={p.key} aria-pressed={period===p.key} onClick={()=>{setPeriod(p.key);setOffset(0)}}>{p.label}</button>)}</div>
   <label className="usage-date">统计日期<input aria-label="统计日期" type="date" min="1900-01-01" max="9998-12-31" value={anchor} onChange={e=>changeDate(e.target.value)}/></label>
   <div className="usage-nav"><button className="usage-btn" onClick={()=>changeDate(shiftPeriod(anchor,period,-1))}>上一期</button><button className="usage-btn" onClick={()=>anchor===todayBeijing()?refetch():changeDate(todayBeijing())}>本期</button><button className="usage-btn" onClick={()=>changeDate(shiftPeriod(anchor,period,1))}>下一期</button></div>
   <form className="usage-search" onSubmit={e=>{e.preventDefault();if(query===search.trim()&&offset===0)refetch();setQuery(search.trim());setOffset(0)}}><input type="search" maxLength={200} aria-label="搜索兑换使用记录" placeholder="搜索码标识、备注 / 批次、兑换人" value={search} onChange={e=>setSearch(e.target.value)}/><button className="usage-btn">查询</button>{(search||query)&&<button type="button" className="usage-btn" onClick={()=>{setSearch('');setQuery('');setOffset(0)}}>清空</button>}</form>
  </div>
  {error&&<div className="usage-error" role="alert">{error.message} <button className="usage-btn" onClick={()=>refetch()}>重试</button></div>}
  {isFetching&&<div className="usage-loading" role="status">正在加载使用情况…</div>}
  {data&&<><div className="usage-caption"><strong>{data.start_date} 至 {data.end_date}</strong><span>北京时间 · 每周从周一开始 · 汇总覆盖全部筛选结果</span></div>
  <div className="usage-metrics">{[['redemptions','兑换次数'],['codes','已使用兑换码'],['accounts','使用人数'],['amount','入账积分']].map(([k,v])=><article key={k}><span>{v}</span><strong>{number(data.summary[k])}</strong></article>)}</div>
  <div className="usage-table-wrap"><table className="usage-table"><thead><tr><th>兑换时间（北京）</th><th>兑换码标识</th><th>兑换账户</th><th>入账积分</th><th>备注 / 批次</th></tr></thead><tbody>{data.items.map((r:Row)=><tr key={r.id}><td>{beijingTime(r.redeemed_at)}</td><td>{r.prefix}</td><td>{r.email||'已删除账户'}<small>{r.name}</small></td><td>{number(r.amount)}</td><td>{r.note||'—'}</td></tr>)}{!data.items.length&&<tr><td colSpan={5} className="usage-empty">所选期间没有符合条件的兑换记录</td></tr>}</tbody></table></div>
  <div className="usage-pagination"><span>共 {data.total} 条 · 第 {Math.floor(offset/50)+1} 页</span><div className="usage-nav"><button className="usage-btn" disabled={!offset} onClick={()=>setOffset(offset-50)}>上一页</button><button className="usage-btn" disabled={offset+50>=data.total} onClick={()=>setOffset(offset+50)}>下一页</button></div></div>
  <p className="usage-muted">按实际兑换入账统计，保留历史记录；完整兑换码不在此页面展示。</p></>}
 </section>;
}
