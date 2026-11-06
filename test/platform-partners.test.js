"use strict";
const {test}=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {Database}=require('../src/platform/db'),{cipher,id,passwordHash}=require('../src/platform/security');
const {buildPlatform}=require('../src/platform/app'),{Orders}=require('../src/platform/orders');
const url=process.env.GPTREG_TEST_DATABASE_URL;
test('partner stages, transactional grants, registration binding and login slider',{skip:!url},async t=>{
 const adminDb=new Database(url),schema='test_partners_'+crypto.randomBytes(8).toString('hex');await adminDb.query(`CREATE SCHEMA ${schema}`);
 const scoped=new URL(url);scoped.searchParams.set('options',`-c search_path=${schema}`);const db=new Database(scoped.href),crypt=cipher(crypto.randomBytes(32).toString('base64'));let app;
 try{
  await db.initialize({username:'admin@example.test',password:'TestPassword123!'});
  app=buildPlatform({db,crypt,orders:new Orders(db,crypt),secrets:{internal:'test'},proxy:false});await app.ready();
  const req=(method,url,payload,cookie='')=>app.inject({method,url,payload,headers:{'x-requested-with':'gptreg',cookie}});
  const settings=async patch=>db.query('UPDATE platform_settings SET value=value||$1::jsonb WHERE id=1',[patch]);
  const ok=r=>{assert.equal(r.statusCode,200,r.body);return r.json()};
  const credentials={email:'admin@example.test',password:'TestPassword123!'};
  let adminCookie;
  await t.test('slider required, wrong position consumed, bound, expiring, one-use and switch',async()=>{
   assert.equal((await req('POST','/api/auth/login',credentials)).statusCode,400);
   const challenge=async()=>{const r=await req('GET','/api/auth/slider');const v=ok(r),cookie=r.headers['set-cookie'].split(';')[0];const row=await db.one("UPDATE platform_slider_challenges SET created_at=now()-interval '1 second' WHERE id=$1 RETURNING target",[v.id]);return {payload:{id:v.id,x:row.target},cookie}};
   let c=await challenge();assert.equal((await req('POST','/api/auth/slider/verify',c.payload)).statusCode,400);
   const proof=ok(await req('POST','/api/auth/slider/verify',c.payload,c.cookie)).proof;
   assert.equal((await req('POST','/api/auth/login',{...credentials,slider_proof:proof})).statusCode,400);
   const login=await req('POST','/api/auth/login',{...credentials,slider_proof:proof},c.cookie);ok(login);adminCookie=login.headers['set-cookie'].split(';')[0];
   assert.equal((await req('POST','/api/auth/login',{...credentials,slider_proof:proof},c.cookie)).statusCode,400);
   c=await challenge();assert.equal((await req('POST','/api/auth/slider/verify',{...c.payload,x:0},c.cookie)).statusCode,400);assert.equal((await req('POST','/api/auth/slider/verify',c.payload,c.cookie)).statusCode,400);
   c=await challenge();const expired=ok(await req('POST','/api/auth/slider/verify',c.payload,c.cookie)).proof;await db.query("UPDATE platform_slider_challenges SET expires_at=now()-interval '1 second'");
   assert.equal((await req('POST','/api/auth/login',{...credentials,slider_proof:expired},c.cookie)).statusCode,400);
   await settings({login_slider_enabled:false});ok(await req('POST','/api/auth/login',credentials));
  });
  const hash=await passwordHash('MemberPassword123!');
  const member=async(email,inviter=null,age=0)=>{const uid=id();await db.query("INSERT INTO platform_users(id,email,name,password_hash,invited_by,created_at) VALUES($1,$2,'Partner',$3,$4,now()-$5*interval '1 day')",[uid,email,hash,inviter,age]);return uid};
  const owner=await member('inviter@example.test');
  const order=async uid=>{const oid=id();await db.query("INSERT INTO platform_orders(id,user_id,quantity,need_oauth,unit_price,source,request_key,request_hash,template,attempt_limit,timeout_minutes) VALUES($1,$2,100,false,5,'web',$1,'fixture','{}',1,20)",[oid,uid]);return oid};
  const charge=(oid,n)=>db.query('UPDATE platform_orders SET charged=$2 WHERE id=$1',[oid,n]);
  await t.test('exclusive day cutoffs and order aggregate rounding are idempotent',async()=>{
   for(const [age,want]of [[0,10],[29.99,10],[30,5],[59.99,5],[60,2],[89.99,2],[90,0],[100,0]]){
    const uid=await member(`stage${age}@example.test`,owner,age),oid=await order(uid);await charge(oid,100);await Promise.all([charge(oid,100),charge(oid,100)]);
    assert.equal((await db.one('SELECT COALESCE(sum(amount),0)::int n FROM platform_partner_rewards WHERE order_id=$1',[oid])).n,want);
   }
   const uid=await member('batch@example.test',owner),oid=await order(uid);await charge(oid,5);assert.equal((await db.one('SELECT amount FROM platform_partner_rewards WHERE order_id=$1',[oid])).amount,0);await charge(oid,10);await charge(oid,15);await charge(oid,20);assert.equal((await db.one('SELECT amount FROM platform_partner_rewards WHERE order_id=$1',[oid])).amount,2);
   const second=await order(uid);await charge(second,100);assert.equal((await db.one('SELECT count(*)::int n FROM platform_partner_rewards WHERE invitee_id=$1',[uid])).n,2);
   const balance=(await db.one('SELECT points FROM platform_users WHERE id=$1',[owner])).points;assert.equal(balance,46);assert.equal((await db.one("SELECT sum(points_delta)::int n FROM platform_ledger WHERE user_id=$1 AND kind='invite_reward'",[owner])).n,balance);
  });
  await t.test('admission snapshot, no backfill, binding, permissions and masking',async()=>{
   const uid=await member('snapshot@example.test',owner),pending=await order(uid),rules=(await db.settings()).invitations;
   ok(await req('PUT','/api/admin/v1/invites',{...rules,enabled:false},adminCookie));await charge(pending,100);assert.equal((await db.one('SELECT amount FROM platform_partner_rewards WHERE order_id=$1',[pending])).amount,10);
   const skipped=await order(uid);ok(await req('PUT','/api/admin/v1/invites',rules,adminCookie));await charge(skipped,100);assert.equal(await db.one('SELECT * FROM platform_partner_rewards WHERE order_id=$1',[skipped]),undefined);
   const code=(await db.one('SELECT invite_code FROM platform_users WHERE id=$1',[owner])).invite_code;
   const r=await req('POST','/api/auth/register',{email:'new@example.test',name:'Guest',password:'MemberPassword123!',invite:code});ok(r);const cookie=r.headers['set-cookie'].split(';')[0];assert.equal((await db.one("SELECT invited_by FROM platform_users WHERE email='new@example.test'")).invited_by,owner);
   assert.equal((await req('PUT','/api/admin/v1/invites',rules,cookie)).statusCode,403);
   assert.equal(ok(await req('GET','/api/user/v1/partners',undefined,cookie)).total,0);
   const login=await req('POST','/api/auth/login',{email:'inviter@example.test',password:'MemberPassword123!'});ok(login);const view=ok(await req('GET','/api/user/v1/partners',undefined,login.headers['set-cookie'].split(';')[0]));assert.equal(view.total,11);assert.ok(view.items.every(row=>row.email.includes('***@')&&row.inviter===null));
   const adminView=ok(await req('GET','/api/admin/v1/invites?q=new%40example.test',undefined,adminCookie));assert.equal(adminView.items[0].email,'new@example.test');assert.ok(adminView.items[0].created_at);
   assert.equal((await req('PUT','/api/admin/v1/invites',{...rules,stages:[rules.stages[0],rules.stages[0],rules.stages[2]]},adminCookie)).statusCode,400);
   await settings({features:{...(await db.settings()).features,partners:false}});assert.equal((await req('GET','/api/user/v1/partners',undefined,cookie)).statusCode,403);
  });
 }finally{await app?.close();await db.close();await adminDb.query(`DROP SCHEMA ${schema} CASCADE`);await adminDb.close()}
});
