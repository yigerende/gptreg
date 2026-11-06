"use strict";
const {fail}=require('./security');
const {audit}=require('./db');
function validateRules(v){
 fail(v&&Object.keys(v).sort().join(',')==='enabled,stages'&&typeof v.enabled==='boolean'&&Array.isArray(v.stages)&&v.stages.length===3,'请配置三个奖励阶段');
 let day=0,rate=31;
 for(const s of v.stages){
  fail(s&&Object.keys(s).sort().join(',')==='rate_percent,until_days'&&Number.isInteger(s.until_days)&&s.until_days>day&&s.until_days<=365&&Number.isInteger(s.rate_percent)&&s.rate_percent>=1&&s.rate_percent<rate,'阶段天数须递增且不超过365天，比例须逐段降低且为1%～30%');
  day=s.until_days;rate=s.rate_percent;
 }
}
function registerPartners(app,db){
 async function listing(r,owner){
  const page=Number(r.query.page||1),size=20,search=owner?'':String(r.query.q||'').trim();
  fail(Number.isSafeInteger(page)&&page>=1&&page<=100000&&search.length<=100,'查询参数无效');
  const filter=` FROM platform_users u JOIN platform_users i ON i.id=u.invited_by LEFT JOIN
   (SELECT invitee_id,sum(amount)::int earned,count(*)::int orders,max(updated_at) rewarded_at FROM platform_partner_rewards GROUP BY invitee_id) r ON r.invitee_id=u.id
   WHERE ($1='' OR u.invited_by=$1) AND ($2='' OR u.email ILIKE '%'||$2||'%' OR i.email ILIKE '%'||$2||'%')`;
  const args=[owner||'',search];
  const stats=await db.one('SELECT count(*)::int invited,count(r.invitee_id)::int qualified,COALESCE(sum(r.earned),0)::float8 earned'+filter,args);
  const items=(await db.query(`SELECT u.id,CASE WHEN $1='' THEN u.email ELSE substring(u.email from 1 for 2)||'***@'||split_part(u.email,'@',2) END email,
   CASE WHEN $1='' THEN i.email ELSE NULL END inviter,u.created_at,COALESCE(r.earned,0) earned,COALESCE(r.orders,0) orders,r.rewarded_at`+filter+' ORDER BY u.created_at DESC,u.id LIMIT $3 OFFSET $4',[...args,size,(page-1)*size])).rows;
  return {items,stats,total:stats.invited,page,size,rules:(await db.settings()).invitations,...(owner?{invite_code:(await db.one('SELECT invite_code FROM platform_users WHERE id=$1',[owner])).invite_code}:{})};
 }
 app.get('/api/user/v1/partners',r=>listing(r,r.user.id));
 app.get('/api/admin/v1/invites',r=>listing(r,''));
 app.put('/api/admin/v1/invites',async r=>{
  validateRules(r.body);
  await db.tx(async q=>{
   const actor=(await q.query('SELECT role,status FROM platform_users WHERE id=$1 FOR SHARE',[r.user.id])).rows[0];
   fail(actor?.role==='admin'&&actor.status==='active','需要管理员权限',403);
   await q.query("UPDATE platform_settings SET value=jsonb_set(value,'{invitations}',$1::jsonb) WHERE id=1",[r.body]);
   await audit(q,r.user.id,'partner.rules','site',JSON.stringify(r.body));
  });return {ok:true};
 });
}
module.exports={registerPartners,validateRules};
