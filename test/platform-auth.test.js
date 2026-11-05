"use strict";
const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {Database}=require('../src/platform/db');
const {cipher,passwordHash}=require('../src/platform/security');
const messages=[];
require('../src/platform/mail').sendMail=async(...v)=>messages.push({email:v[3],code:v[6].match(/\d{6}/)[0]});
const {buildPlatform}=require('../src/platform/app');
const {Orders}=require('../src/platform/orders');
const url=process.env.GPTREG_TEST_DATABASE_URL;
test('authentication credential races, mail eligibility and trusted proxy boundaries',{skip:!url},async(t)=>{
 const admin=new Database(url),schema='test_auth_'+crypto.randomBytes(8).toString('hex');
 await admin.query(`CREATE SCHEMA ${schema}`);
 const scoped=new URL(url);scoped.searchParams.set('options',`-c search_path=${schema}`);
 const db=new Database(scoped.href),crypt=cipher(crypto.randomBytes(32).toString('base64'));
 let app;
 try {
  await db.initialize({username:'admin@example.test',password:'OriginalPassword123!'});
  app=buildPlatform({db,crypt,orders:new Orders(db,crypt),secrets:{internal:'test'},proxy:false,publicOrigin:''});await app.ready();
  const req=(method,url,payload,cookie,extra={})=>app.inject({method,url,payload,...extra,headers:{'x-requested-with':'gptreg',...(cookie?{cookie}:{}),...extra.headers}});
  const settings=async(p)=>db.query('UPDATE platform_settings SET value=$1 WHERE id=1',[{...await db.settings(),...p}]);
  const login=async(password)=>{const r=await req('POST','/api/auth/login',{email:'admin@example.test',password});assert.equal(r.statusCode,200,r.body);return r.headers['set-cookie'].split(';')[0]};
  const send=async(email='admin@example.test',purpose='reset')=>{const r=await req('POST','/api/auth/email-code',{email,purpose});assert.equal(r.statusCode,200,r.body);return messages.at(-1).code};
  await settings({email_verify_enabled:true,smtp:{host:'fixture.invalid',from:'sender@example.test'}});
  await t.test('a verified old password cannot create a session after reset',async()=>{
   const tx=db.tx.bind(db);let armed=true;
   const hash=await passwordHash('ChangedPassword123!');
   db.tx=async(fn)=>{
    if(armed&&fn.toString().includes('verified.password_hash')){
     armed=false;await tx(async(q)=>{await q.query('UPDATE platform_users SET password_hash=$1',[hash]);await q.query('DELETE FROM platform_sessions')});
    }
    return tx(fn);
   };
   try {assert.equal((await req('POST','/api/auth/login',{email:'admin@example.test',password:'OriginalPassword123!'})).statusCode,401)} finally{db.tx=tx}
   assert.equal((await db.one('SELECT count(*)::int AS n FROM platform_sessions')).n,0);
  });
  await t.test('old reset code is invalid after profile password change',async()=>{
   const cookie=await login('ChangedPassword123!'),code=await send();
   assert.equal((await req('PATCH','/api/user/v1/me',{name:'test',old_password:'ChangedPassword123!',password:'ProfilePassword123!'},cookie)).statusCode,200);
   assert.equal((await req('POST','/api/auth/reset-password',{email:'admin@example.test',code,password:'StalePassword123!'})).statusCode,400);
   assert.equal((await req('GET','/api/user/v1/me',undefined,cookie)).statusCode,401);
  });
  await t.test('in-flight profile cannot overwrite a completed reset',async()=>{
   await db.query('DELETE FROM platform_email_codes');
   const cookie=await login('ProfilePassword123!'),code=await send();
   const tx=db.tx.bind(db);let hit,release,armed=true;
   const boundary=new Promise(r=>hit=r),gate=new Promise(r=>release=r);
   db.tx=async(fn)=>{if(armed&&fn.toString().includes('const validSession')){armed=false;hit();await gate}return tx(fn)};
   const pending=Promise.resolve(req('PATCH','/api/user/v1/me',{name:'test',old_password:'ProfilePassword123!',password:'StaleProfile123!'},cookie));
   try {
    await boundary;
    assert.equal((await req('POST','/api/auth/reset-password',{email:'admin@example.test',code,password:'ResetPassword123!'})).statusCode,200);
   }finally{release();db.tx=tx}
   assert.equal((await pending).statusCode,401);
   await login('ResetPassword123!');
  });
  await t.test('registration and first session commit atomically',async()=>{
   await settings({email_verify_enabled:false});
   const tx=db.tx.bind(db);let armed=true;
   db.tx=(fn)=>tx(async(q)=>fn({query:(sql,args)=>{
    if(armed&&sql.startsWith('INSERT INTO platform_sessions')){armed=false;const e=new Error('fixture');e.statusCode=503;throw e}
    return q.query(sql,args);
   }}));
   try {assert.equal((await req('POST','/api/auth/register',{email:'atomic@example.test',name:'test',password:'RegisterPassword123!'})).statusCode,503)}finally{db.tx=tx}
   assert.equal((await db.one('SELECT count(*)::int AS n FROM platform_users WHERE email=$1',['atomic@example.test'])).n,0);
   assert.equal((await req('POST','/api/auth/register',{email:'atomic@example.test',name:'test',password:'RegisterPassword123!'})).statusCode,200);
  });
  await t.test('send-code enforces verification switch, domains and existing accounts',async()=>{
   await db.query('DELETE FROM platform_rate_limits');let before=messages.length;
   assert.equal((await req('POST','/api/auth/email-code',{email:'new@example.test',purpose:'register'})).statusCode,403);
   await settings({email_verify_enabled:true,email_domains:['allowed.test']});
   assert.equal((await req('POST','/api/auth/email-code',{email:'new@example.test',purpose:'register'})).statusCode,400);
   await settings({email_domains:[]});
   assert.equal((await req('POST','/api/auth/email-code',{email:'admin@example.test',purpose:'register'})).statusCode,200);
   assert.equal(messages.length,before);
   await db.query('DELETE FROM platform_email_codes');
   await send('new@example.test','register');assert.equal(messages.length,before+1);
   const stored=await db.one('SELECT * FROM platform_email_codes WHERE email=$1',['new@example.test']);
   assert.equal(stored.delivered,true);assert.notEqual(stored.hash,messages.at(-1).code);assert(stored.challenge_id);
   await db.query("INSERT INTO platform_rate_limits(key,hits,expires_at) VALUES($1,20,now()+interval '1 day')",['email-day-recipient:'+require('../src/platform/security').digest('daily@example.test')]);
   assert.equal((await req('POST','/api/auth/email-code',{email:'daily@example.test',purpose:'register'})).statusCode,429);
  });
  await t.test('trusted proxy clients have independent limits and secure cookies; forged headers do not',async()=>{
   await db.query('DELETE FROM platform_rate_limits');
   await db.query("UPDATE platform_risk_settings SET value=jsonb_set(value,'{trusted_proxies}',$1::jsonb)",[JSON.stringify(['172.30.0.1'])]);
   for(let i=0;i<6;i++)assert.equal((await req('POST','/api/auth/email-code',{email:`proxy${i}@example.test`,purpose:'reset'},null,{remoteAddress:'172.30.0.1',headers:{'x-forwarded-for':`198.51.100.${i+1}`}})).statusCode,200);
   await db.query('DELETE FROM platform_risk_buckets');
   const secure=await req('POST','/api/auth/login',{email:'admin@example.test',password:'ResetPassword123!'},null,{remoteAddress:'172.30.0.1',headers:{'x-forwarded-for':'198.51.100.99','x-forwarded-proto':'https'}});
   assert.equal(secure.statusCode,200);assert.match(secure.headers['set-cookie'],/; Secure/);
   const forged=await req('POST','/api/auth/login',{email:'admin@example.test',password:'ResetPassword123!'},null,{remoteAddress:'198.51.100.100',headers:{'x-forwarded-for':'198.51.100.99','x-forwarded-proto':'https'}});
   assert.equal(forged.statusCode,200);assert.doesNotMatch(forged.headers['set-cookie'],/; Secure/);
   await db.query('DELETE FROM platform_rate_limits');
   const statuses=[];
   for(let i=0;i<6;i++)statuses.push((await req('POST','/api/auth/email-code',{email:`forged${i}@example.test`,purpose:'reset'},null,{remoteAddress:'198.51.100.100',headers:{'x-forwarded-for':`198.51.100.${i+1}`}})).statusCode);
   assert.deepEqual(statuses,[200,200,200,200,200,429]);
  });
 }finally {if(app)await app.close();await db.close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.close()}
});
