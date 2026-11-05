const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {test}=require('node:test');
const {Database}=require('../src/platform/db');
const {Orders}=require('../src/platform/orders');
const {cipher,id,digest,token}=require('../src/platform/security');
const {buildPlatform}=require('../src/platform/app');
const {reportPeriod}=require('../src/platform/report-period');
test('usage report calendar boundaries',()=>{
 for(const [period,anchor,start,end] of [['week','2021-01-01','2020-12-28','2021-01-03'],['month','2024-02-29','2024-02-01','2024-02-29'],['year','2024-02-29','2024-01-01','2024-12-31']]){
  const r=reportPeriod(period,anchor);assert.equal(r.start_date,start);assert.equal(r.end_date,end);assert.equal(r.start.getUTCHours(),16);
 }
 for(const date of ['2026-02-30','bad','9999-01-01'])assert.throws(()=>reportPeriod('day',date));
 assert.throws(()=>reportPeriod('hour','2026-11-05'));
});
test('usage report permissions, literal filtering, pagination and credit preservation',{skip:!process.env.GPTREG_TEST_DATABASE_URL},async()=>{
 const connection=process.env.GPTREG_TEST_DATABASE_URL;
 const schema='usage_'+crypto.randomBytes(8).toString('hex');
 const admin=new Database(connection);await admin.query('CREATE SCHEMA '+schema);
 const url=new URL(connection);url.searchParams.set('options','-c search_path='+schema);
 const db=new Database(url.href);let app;
 try{
  await db.initialize();const crypt=cipher(crypto.randomBytes(32).toString('base64'));
  app=buildPlatform({db,crypt,orders:new Orders(db,crypt),secrets:{internal:'fixture'},proxy:false});await app.ready();
  async function user(role){const uid=id(),t=token();await db.query("INSERT INTO platform_users(id,email,name,password_hash,role) VALUES($1,$2,'report','unused',$3)",[uid,uid+'@example.test',role]);await db.query("INSERT INTO platform_sessions(hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[digest(t),uid]);return {id:uid,cookie:'gptreg_session='+t};}
  const a=await user('admin'),u=await user('member');
  const get=(query='',who=a)=>app.inject({method:'GET',url:'/api/admin/v1/redeem-codes/usage'+query,headers:who?{cookie:who.cookie}:{}});
  for(const [i,stamp] of ['2026-11-04T15:59:59Z','2026-11-04T16:00:00Z','2026-11-05T15:59:59Z','2026-11-05T16:00:00Z'].entries())await db.query("INSERT INTO platform_redeem_codes(id,hash,prefix,points,batch,redeemed_by,redeemed_at) VALUES($1,$2,'GR-prefix',100,$3,$4,$5)",[id(),digest(id()),i===1?'100%_literal':'normal',u.id,stamp]);
  const r=await get('?date=2026-11-05&limit=1');assert.equal(r.statusCode,200);const data=r.json();
  assert.deepEqual(data.summary,{redemptions:2,codes:2,accounts:1,amount:200});assert.equal(data.items.length,1);
  const page=(await get('?date=2026-11-05&limit=1&offset=1')).json();assert.notEqual(page.items[0].id,data.items[0].id);assert.deepEqual(page.summary,data.summary);
  for(const [q,n] of [['%',1],['_',1],['absent',0],[u.id+'@example.test',2]]){const row=(await get('?date=2026-11-05&q='+encodeURIComponent(q))).json();assert.equal(row.total,n);}
  assert.equal((await get('',null)).statusCode,401);assert.equal((await get('',u)).statusCode,403);
  for(const q of ['?date=2026-02-30','?period=hour','?limit=101','?q='+'a'.repeat(201)])assert.equal((await get(q)).statusCode,400);
  assert.equal((await db.one('SELECT points FROM platform_users WHERE id=$1',[u.id])).points,0);
  assert.equal((await db.one('SELECT count(*)::int AS n FROM platform_ledger')).n,0);
  for(const key of ['hash','encrypted_code','password_hash'])assert.ok(!Object.hasOwn(data.items[0],key));
 }finally{if(app)await app.close();await db.close();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.close();}
});
