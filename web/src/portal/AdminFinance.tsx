import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Download, RefreshCw, Wallet, CheckCircle2, LockKeyhole, Coins, Mail, MessageSquare } from "lucide-react";
import { call, date, download, type Row } from "./client";
import { Table, Feedback, useAction } from "./Workspace";
import { StatCards, Pagination, number, ledgerNames } from "./Insights";
import AdminCosts, { CostAmount } from "./AdminCosts";
function initialRange() {
  const end = new Date(Date.now()+8*3600000).toISOString().slice(0,10);
  return { start:new Date(Date.parse(end)-29*86400000).toISOString().slice(0,10),end,period:"day",include_admin:"false",q:"" };
}
export default function AdminFinance() {
  const [filter,setFilter]=useState(initialRange),[draft,setDraft]=useState(initialRange);
  const [offset,setOffset]=useState(0),[view,setView]=useState("users"),[kind,setKind]=useState("");
  const a=useAction();
  const params=new URLSearchParams({...filter,limit:"50",offset:String(offset),kind});
  const {data,error,isFetching,refetch}=useQuery({queryKey:["admin-finance",filter,offset,kind],queryFn:()=>call(`/api/admin/v1/finance?${params}`)});
  const select=(change:Row)=>{setDraft(s=>({...s,...change}));setFilter(s=>({...s,...change}));setOffset(0);};
  const max=Math.max(1,...(data?.trend||[]).flatMap((t:Row)=>[Number(t.credited),Number(t.spent)]));
  const rows=data?.[view]||[];
  async function exportReport() {
    const response=await fetch(`/api/admin/v1/finance/export?${new URLSearchParams(filter)}`,{credentials:"same-origin"});
    if(!response.ok){const e=await response.json();throw new Error(e.error||"导出失败");}
    // Fetch decodes and removes the transport BOM; restore it for Excel.
    download(`财务报表-${filter.start}-${filter.end}.csv`,"\uFEFF"+(await response.text()).replace(/^\uFEFF/,""));
    return true;
  }
  return <>
    <form className="p-filter-bar p-finance-filters" onSubmit={e=>{e.preventDefault();setFilter({...draft});setOffset(0);}}>
      <div className="p-segment">{Object.entries({day:"每日",week:"每周",month:"每月",year:"每年"}).map(([k,n])=><button type="button" className={filter.period===k?"selected":""} key={k} onClick={()=>select({period:k})}>{n}</button>)}</div>
      <label>开始日期<input type="date" required aria-label="开始日期" value={draft.start} onChange={e=>setDraft({...draft,start:e.target.value})}/></label>
      <label>结束日期<input type="date" required aria-label="结束日期" min={draft.start} value={draft.end} onChange={e=>setDraft({...draft,end:e.target.value})}/></label>
      <label className="p-finance-checkbox"><input type="checkbox" checked={filter.include_admin==="true"} onChange={e=>select({include_admin:String(e.target.checked)})}/>包含管理员</label>
      <input aria-label="搜索账户" placeholder="客户邮箱或称呼" maxLength={200} value={draft.q} onChange={e=>setDraft({...draft,q:e.target.value})}/>
      <button className="p-button secondary" disabled={isFetching}>查询</button>
      <button type="button" className="p-button secondary" disabled={isFetching} onClick={()=>refetch()}><RefreshCw size={15} className={isFetching?"p-spin":""}/>刷新</button>
      <button type="button" className="p-button secondary" disabled={a.busy||!data||isFetching} onClick={()=>a.run(exportReport,"财务报表已导出")}><Download size={15}/>{a.busy?"正在导出…":"导出报表"}</button>
    </form>
    <Feedback a={a}/>
    {error&&<div className="p-alert">{error.message}</div>}
    {!data&&isFetching&&<p role="status" className="p-muted">正在加载财务报表…</p>}
    {data&&<>
      <StatCards className="p-finance-metrics" items={[
        {name:"区间充值入账",value:data.totals.credited,unit:"积分",hint:"已成功兑换入账",icon:<Wallet size={18}/>},
        {name:"区间服务消费",value:data.totals.spent,unit:"积分",hint:"成功交付的实际扣费",icon:<CheckCircle2 size={18}/>},
        {name:"当前可用余额",value:data.current.balance,unit:"积分",hint:"所选账户实时余额",icon:<Coins size={18}/>},
        {name:"当前冻结积分",value:data.current.frozen,unit:"积分",hint:"尚未结算的订单预留",icon:<LockKeyhole size={18}/>},
        {name:"邮箱消耗",value:0,unit:"",hint:"区间发起任务 · 含失败与重试",icon:<Mail size={18}/>,valueContent:<div className="p-cost-metric-value"><CostAmount cost={data.execution_cost} kind="mail"/></div>},
        {name:"短信消耗",value:0,unit:"",hint:"区间发起任务 · 含失败与重试",icon:<MessageSquare size={18}/>,valueContent:<div className="p-cost-metric-value"><CostAmount cost={data.execution_cost} kind="sms"/></div>},
      ]}/>
      <section className="p-card p-finance-trend">
        <div className="p-section-heading"><div><span className="p-eyebrow">FUNDS MOVEMENT</span><h2>资金变动趋势</h2></div><div className="p-finance-legend"><span>● 充值</span><span>● 消费</span></div></div>
        <div className="p-finance-chart" role="img" aria-label="所选日期区间充值与消费趋势，按北京时间统计">
          {(data.trend||[]).map((t:Row)=><div className="p-finance-bar" key={t.period} title={`${t.period}：充值 ${number(t.credited)} 积分，消费 ${number(t.spent)} 积分`}>
            <div><i style={{height:`${Math.max(t.credited?2:0,Number(t.credited)/max*150)}px`}}/><i style={{height:`${Math.max(t.spent?2:0,Number(t.spent)/max*150)}px`}}/></div><small>{filter.period==="year"?t.period.slice(0,4):t.period.slice(5)}</small>
          </div>)}
          {!data.trend?.length&&<p className="p-muted">所选期间暂无资金流水</p>}
        </div>
        <p className="p-muted p-fine">{data.start} 至 {data.end} · 北京时间 · {data.include_admin?"包含管理员":"默认排除管理员"}。区间人工调整 {number(data.totals.adjusted)} 积分；未交付退回 {number(data.totals.released)} 积分。预留及退回不计入服务消费，实时余额不等同于区间利润。</p>
      </section>
      <AdminCosts cost={data.execution_cost} title="区间发起任务的邮箱与短信成本"/>
      <div className="p-section-heading p-spaced-heading"><div><span className="p-eyebrow">CUSTOMER FINANCES</span><h2>{view==="users"?"每位客户的资金明细":"积分流水明细"}</h2></div><div className="p-segment">
        <button className={view==="users"?"selected":""} onClick={()=>{setView("users");setOffset(0);}}>客户明细</button>
        <button className={view==="items"?"selected":""} onClick={()=>{setView("items");setOffset(0);}}>积分流水</button>
      </div></div>
      {view==="items"&&<select aria-label="筛选流水类型" value={kind} onChange={e=>{setKind(e.target.value);setOffset(0);}}><option value="">全部流水类型</option>{Object.entries(ledgerNames).map(([k,n])=><option key={k} value={k}>{n}</option>)}</select>}
      <section className="p-card p-record-card"><Table rows={rows} columns={view==="users"?[
        {title:"账户",render:r=><><b>{r.email}</b><small className="p-block">{r.name}{r.role==="admin"?" · 管理员":""}</small></>},
        ...[["区间充值","credited"],["区间消费","spent"],["人工调整","adjusted"],["未交付退回","released"],["当前可用","balance"],["当前冻结","frozen"],["区间订单","orders"]].map(([title,key])=>({title,render:(r:Row)=>number(r[key])})),
        {title:"邮箱消耗",render:r=><CostAmount cost={r.execution_cost} kind="mail"/>},
        {title:"短信消耗",render:r=><CostAmount cost={r.execution_cost} kind="sms"/>},
      ]:[
        {title:"客户",render:r=><><b>{r.email}</b><small className="p-block">{r.name}</small></>},
        {title:"账务类型",render:r=>ledgerNames[r.kind]||r.kind},
        {title:"可用积分变动",render:r=>number(r.points_delta)},
        {title:"冻结积分变动",render:r=>number(r.frozen_delta)},
        {title:"说明",render:r=>r.note},{title:"发生时间",render:r=>date(r.created_at)},
      ]}/></section>
      <Pagination offset={offset} total={view==="users"?data.users_total:data.total} count={rows.length} onChange={setOffset}/>
      <p className="p-muted p-fine">积分按本平台原始单位显示。邮箱、短信成本保留供应商币种，包含失败及重试，不与积分直接相减。数据更新于 {date(data.generated_at)}。</p>
    </>}
  </>;
}
