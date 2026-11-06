import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Mail, MessageSquare, RefreshCw } from "lucide-react";
import { call, date, type Row } from "./client";
import { Table } from "./Workspace";
import { Pagination } from "./Insights";
import "./admin-performance.css";
const initial=()=>{const end=new Date(Date.now()+8*3600000).toISOString().slice(0,10);return {start:new Date(Date.parse(end)-29*86400000).toISOString().slice(0,10),end,include_admin:"true",provider:"",country:""};};
const percent=(n:unknown)=>n==null?"—":`${Number(n).toFixed(1)}%`;
const money=(n:unknown)=>`¥${Number(n || 0).toLocaleString("zh-CN",{minimumFractionDigits:2,maximumFractionDigits:4})}`;
function Rate({row}:{row:Row}) {return <div className="p-supplier-rate"><strong>{percent(row.success_rate)}</strong><div className="p-success-track" aria-label={`成功率 ${percent(row.success_rate)}`}><i style={{width:`${row.success_rate || 0}%`}}/></div><small>{row.succeeded} 成功 / {row.succeeded+row.failed} 已结束</small></div>;}
export default function AdminSuppliers(){
  const [kind,setKind]=useState("mail"),[filter,setFilter]=useState(initial),[draft,setDraft]=useState(initial),[offset,setOffset]=useState(0);
  const {data,error,isFetching,refetch}=useQuery({queryKey:["admin-suppliers",kind,filter,offset],queryFn:()=>call(`/api/admin/v1/suppliers?${new URLSearchParams({...filter,kind,offset:String(offset),limit:"25"})}`)});
  const switchKind=(v:string)=>{setKind(v);setOffset(0);setFilter(s=>({...s,provider:"",country:""}));setDraft(s=>({...s,provider:"",country:""}));};
  const metric=kind==="mail"?"注册完成率":"短信验证成功率",s=data?.summary;
  return <div className="p-supplier-page">
    <div className="p-page-heading"><div><span className="p-eyebrow">OPERATIONS / SUPPLIERS</span><h1>供应商统计</h1><p>邮箱看厂商，短信看厂商与号码国家。成功率、失败数量和成本一起看。</p></div></div>
    <div className="p-supplier-tabs" role="tablist" aria-label="资源类型"><button role="tab" aria-selected={kind==="mail"} onClick={()=>switchKind("mail")}><Mail size={18}/><span>邮箱厂商<small>每个厂商的注册完成情况</small></span></button><button role="tab" aria-selected={kind==="sms"} onClick={()=>switchKind("sms")}><MessageSquare size={18}/><span>短信厂商与国家<small>每个国家的号码验证表现</small></span></button></div>
    <form className="p-filter-bar" onSubmit={e=>{e.preventDefault();setFilter({...draft});setOffset(0);}}>
      <label>开始日期<input type="date" required aria-label="开始日期" value={draft.start} onChange={e=>setDraft({...draft,start:e.target.value})}/></label>
      <label>结束日期<input type="date" required aria-label="结束日期" min={draft.start} value={draft.end} onChange={e=>setDraft({...draft,end:e.target.value})}/></label>
      <select aria-label="供应商" value={draft.provider} onChange={e=>setDraft({...draft,provider:e.target.value,country:""})}><option value="">全部厂商</option>{data?.providers.map((p:Row)=><option key={p.id} value={p.id}>{p.name}</option>)}</select>
      {kind==="sms"&&<select aria-label="短信国家" value={draft.country} onChange={e=>setDraft({...draft,country:e.target.value})}><option value="">全部号码国家</option>{data?.countries.map((c:Row)=><option key={c.id} value={c.id}>{c.name}</option>)}</select>}
      <label className="p-finance-checkbox"><input type="checkbox" checked={draft.include_admin==="true"} onChange={e=>setDraft({...draft,include_admin:String(e.target.checked)})}/>包含管理员订单</label>
      <button className="p-button secondary" disabled={isFetching}>查询</button><button type="button" className="p-button secondary" disabled={isFetching} onClick={()=>refetch()}><RefreshCw size={15} className={isFetching?"p-spin":""}/>刷新</button>
    </form>
    {error&&<div role="alert" className="p-alert">{error.message}</div>}{!data&&isFetching&&<p role="status">正在加载供应商统计…</p>}
    {data&&<>
      <div className="p-performance-metrics"><article className="is-featured"><span>{metric}</span><strong>{percent(s.success_rate)}</strong><small>成功 {s.succeeded} / 已结束 {s.succeeded+s.failed}</small></article><article><span>使用总数</span><strong>{s.total}<em>个</em></strong><small>处理中 {s.active} · 结果未记录 {s.unknown}</small></article><article><span>失败数量</span><strong>{s.failed}<em>个</em></strong><small>含更换及取消的资源</small></article><article><span>已记录成本</span><strong>{money(s.cost_cny)}</strong><small>邮箱和短信独立统计 · 含失败费用</small></article></div>
      <p className="p-supplier-rule"><b>{metric} = 成功数 ÷（成功数 + 失败数）</b>。处理中与结果未知不进入分母；收码率另按有收码记录的已结束资源计算。</p>
      {data.coverage.incomplete_attempts>0&&<p className="p-notice">{data.coverage.incomplete_attempts} 次历史执行缺少完整厂商或收码信息，无法识别的项目显示“未记录”，不猜测国家或成功率。</p>}
      {(s.price_unknown>0 || Object.values(s.costs).some(v=>Number((v as Row).pending)>0))&&<p className="p-notice">部分资源尚无价格或扣费结果，未计入成本；下方保留已知报价。</p>}
      <section className="p-card p-record-card"><Table rows={data.items} columns={[
        {title:"厂商",render:r=><b>{r.provider_name}</b>},...(kind==="sms"?[{title:"号码国家",render:(r:Row)=><><b>{r.country_name}</b><small className="p-block">厂商国家代码 {r.country}</small></>}]:[]),
        {title:metric,render:r=><Rate row={r}/>},
        {title:"成功 / 失败",render:r=><div className="p-supplier-counts"><span>成功 <b>{r.succeeded}</b></span><span className={r.failed?"is-failure":""}>失败 <b>{r.failed}</b></span><small>共 {r.total} · 处理中 {r.active} · 未知 {r.unknown}</small></div>},
        {title:"收码率",render:r=><><b>{percent(r.receipt_rate)}</b><small className="p-block">{r.receipt_success} / {r.receipt_known} 已记录</small></>},
        {title:"总成本 / 失败成本",render:r=><><b>{money(r.cost_cny)}</b>{Object.entries(r.costs).map(([c,v])=><small className="p-block" key={c}>{Number((v as Row).confirmed).toFixed(4)} {c} · 其中失败 {Number((v as Row).failed_cost).toFixed(4)} {c}{(v as Row).pending>0&&<span className="p-block">未计入报价 {Number((v as Row).pending).toFixed(4)} {c}</span>}</small>)}{r.price_unknown>0&&<small className="p-block">{r.price_unknown} 个未记录价格</small>}</>},
      ]}/></section>
      <Pagination offset={offset} total={data.total} count={data.items.length} onChange={setOffset}/>
      <p className="p-muted p-fine">按执行发起日期（北京时间）统计平台订单，包含重试，同一租约或号码只算一次。{kind==="sms"?"国家为短信号码所属国家，不是注册代理地区。":"邮箱成功代表关联注册任务完成，失败不一定由邮箱厂商造成。"} 1 USD = 6.7 元。更新时间 {date(data.generated_at)}。</p>
    </>}
  </div>;
}
