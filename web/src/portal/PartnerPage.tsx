import {useEffect,useState} from 'react';
import {useQueryClient} from '@tanstack/react-query';
import {call,copy,date,type Row} from './client';
import {Table} from './Workspace';
import './partners.css';
export default function PartnerPage({admin=false}:{admin?:boolean}){
 const query=useQueryClient();
 const [data,setData]=useState<Row>({items:[],stats:{}}),[rules,setRules]=useState<Row|null>(null),[page,setPage]=useState(1),[search,setSearch]=useState(''),[busy,setBusy]=useState(false),[saving,setSaving]=useState(false),[error,setError]=useState(''),[message,setMessage]=useState('');
 const path=admin?'/api/admin/v1/invites':'/api/user/v1/partners';
 async function load(initial=false){setBusy(true);setError('');try{const v=await call(`${path}?page=${page}&q=${encodeURIComponent(search)}`);setData(v);if(initial)setRules(structuredClone(v.rules))}catch(e){setError((e as Error).message)}finally{setBusy(false)}}
 useEffect(()=>{void load(true)},[page,admin]);
 async function save(e:React.FormEvent){e.preventDefault();setSaving(true);setError('');try{await call(path,'PUT',rules);setMessage('规则已保存，仅影响新建订单');await load(true);await query.invalidateQueries({queryKey:['public']});await query.invalidateQueries({queryKey:['me']})}catch(e){setError((e as Error).message)}finally{setSaving(false)}}
 function field(i:number,key:string,value:number){setRules(r=>({...r,stages:r!.stages.map((s:Row,n:number)=>n===i?{...s,[key]:value}:s)}))}
 const link=location.origin+'/?invite='+encodeURIComponent(data.invite_code||'');
 return <div className="p-partners"><header className="p-card"><span className="p-eyebrow">PARTNERS / REWARDS</span><h1>{admin?'邀请管理':'伙伴计划'}</h1><p>邀请伙伴，获得可用于平台消费的积分。</p></header>
 {error&&<p className="p-alert" role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
 {admin&&rules&&<form className="p-card" onSubmit={save}><h2>伙伴奖励规则</h2><label className="p-inline"><input type="checkbox" checked={rules.enabled} onChange={e=>setRules({...rules,enabled:e.target.checked})}/>开放邀请奖励</label><div className="p-partner-stages">{rules.stages.map((s:Row,i:number)=><div key={i}><h3>第 {i+1} 阶段</h3><label>截止天数<input type="number" min={1} max={365} required value={s.until_days} onChange={e=>field(i,'until_days',Number(e.target.value))}/></label><label>奖励比例（%）<input type="number" min={1} max={30} required value={s.rate_percent} onChange={e=>field(i,'rate_percent',Number(e.target.value))}/></label></div>)}</div><p>天数递增，比例逐段降低；新订单按伙伴注册时长锁定规则，已有订单及奖励保留。</p><button className="p-button" disabled={saving}>{saving?'保存中…':'保存规则'}</button></form>}
 {!admin&&<section className="p-card"><h2>{data.rules?.enabled?'邀请伙伴，阶段内持续奖励':'伙伴奖励暂未开放'}</h2><div className="p-partner-link"><input readOnly value={link} aria-label="邀请链接"/><button className="p-button" onClick={async()=>{try{await copy(link);setMessage('邀请链接已复制')}catch{setError('复制失败，请手动复制')}}}>复制邀请链接</button></div></section>}
 <section className="p-card"><h2>奖励规则</h2>{data.rules?.stages?.map((s:Row,i:number)=><p key={i}>从伙伴注册起满 {i===0?0:data.rules.stages[i-1].until_days} 天至未满 {s.until_days} 天，按实际消费返 {s.rate_percent}%。</p>)}{data.rules?.stages?.length&&<p>满 {data.rules.stages[2].until_days} 天后的新订单不再返积分。</p>}<p>仅直接邀请参与；通过邀请链接注册或注册时填写邀请标识绑定关系。阶段内每笔成功交付且已扣费的订单均参与，失败或未扣费部分不奖励。每个订单累计已交付消费计算奖励，向下取整到整数积分，后续交付补齐差额；积分用于平台消费，不支持提现。历史订单不补发。</p></section>
 <section className="p-partner-stats">{[['invited','邀请伙伴','位'],['qualified','获奖伙伴','位'],['earned','累计奖励','积分']].map(([k,n,u])=><div className="p-card" key={k}>{n}<strong>{data.stats[k]||0} <small>{u}</small></strong></div>)}</section>
 <form className="p-partner-tools" onSubmit={e=>{e.preventDefault();if(page!==1)setPage(1);else void load()}}>{admin&&<input value={search} onChange={e=>setSearch(e.target.value)} maxLength={100} placeholder="邀请人或被邀请人邮箱" aria-label="搜索邀请关系"/>}<button className="p-button secondary" disabled={busy}>{admin?'搜索':'刷新'}</button></form>
 <section className="p-card"><Table rows={data.items} columns={[...(admin?[{title:'邀请人',render:(r:Row)=>r.inviter}]:[]),{title:'伙伴邮箱',render:r=>r.email},{title:'注册时间',render:r=>date(r.created_at)},{title:'参与订单',render:r=>r.orders},{title:'累计奖励',render:r=>`${r.earned} 积分`},{title:'最近结算',render:r=>r.rewarded_at?date(r.rewarded_at):'—'}]}/></section>
 <div className="p-partner-tools"><span>共 {data.total||0} 位 · 第 {page} 页</span><button className="p-button secondary" disabled={busy||page===1} onClick={()=>setPage(page-1)}>上一页</button><button className="p-button secondary" disabled={busy||page*20>=data.total} onClick={()=>setPage(page+1)}>下一页</button></div></div>;
}
