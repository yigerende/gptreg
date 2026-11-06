"use strict";
const crypto=require('node:crypto');
const {token,digest,fail}=require('./security');
const binding=r=>String(r.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('login_slider='))?.slice(13)||'';
function registerSlider(app,db,secure){
 const limit=async r=>fail(await db.limit('slider:'+(r.risk?.source_ip||r.raw.socket.remoteAddress),90),'验证请求过多，请稍后重试',429);
 app.get('/api/auth/slider',async(r,reply)=>{
  await limit(r);if(!(await db.settings()).login_slider_enabled)return {enabled:false};
  const browser=binding(r)||token(),id=token(),x=crypto.randomInt(90,261);
  await db.query('DELETE FROM platform_slider_challenges WHERE expires_at<now()');
  await db.query("INSERT INTO platform_slider_challenges(id,binding,target,expires_at) VALUES($1,$2,$3,now()+interval '2 minutes')",[id,digest(browser),x]);
  reply.header('Set-Cookie',`login_slider=${browser}; Path=/; HttpOnly; SameSite=Strict; Max-Age=600${secure(r)?'; Secure':''}`);
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="90"><rect width="320" height="90" rx="10" fill="#edf5f2"/><path d="M0 68 Q80 0 160 66 T320 40" fill="none" stroke="#bdd7ce" stroke-width="12"/><rect x="${x}" y="25" width="36" height="40" rx="7" fill="#315f50" stroke="#174a3b" stroke-dasharray="4 3"/></svg>`;
  return {enabled:true,id,image:'data:image/svg+xml;base64,'+Buffer.from(svg).toString('base64')};
 });
 app.post('/api/auth/slider/verify',async r=>{
  await limit(r);const {id,x}=r.body||{};
  fail(typeof id==='string'&&id.length<=80&&Number.isFinite(x)&&x>=0&&x<=284,'请重新完成滑动验证');
  const row=await db.one('DELETE FROM platform_slider_challenges WHERE id=$1 AND binding=$2 AND proof_hash IS NULL RETURNING target,created_at,expires_at',[id,digest(binding(r))]);
  fail(row&&row.expires_at>new Date()&&Date.now()-row.created_at.getTime()>=300&&Math.abs(x-row.target)<=5,'滑动位置不正确或验证已过期，请重试');
  const proof=token();await db.query("INSERT INTO platform_slider_challenges(id,binding,target,proof_hash,expires_at) VALUES($1,$2,0,$3,now()+interval '1 minute')",[id,digest(binding(r)),digest(proof)]);
  return {proof,expires_in:60};
 });
 return {consumeSlider:async(r,proof)=>{
  if(!(await db.settings()).login_slider_enabled)return;
  fail(typeof proof==='string'&&proof.length>0&&proof.length<=128,'请先完成滑动验证');
  fail((await db.query('DELETE FROM platform_slider_challenges WHERE binding=$1 AND proof_hash=$2 AND expires_at>now()',[digest(binding(r)),digest(proof)])).rowCount===1,'滑动验证已失效，请重新验证');
 }};
}
module.exports={registerSlider};
