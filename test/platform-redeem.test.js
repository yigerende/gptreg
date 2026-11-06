const assert=require('node:assert/strict'),fs=require('node:fs'),crypto=require('node:crypto');
const {Database}=require('../src/platform/db');
const {Orders}=require('../src/platform/orders');
const {cipher,id,digest,token}=require('../src/platform/security');
const {buildPlatform}=require('../src/platform/app');
const connection=process.env.GPTREG_TEST_DATABASE_URL ||
 (fs.existsSync('.local/platform-test/connection.json')
  ? JSON.parse(fs.readFileSync('.local/platform-test/connection.json','utf8')).url
  : '');
const schema='redeem_audit_'+crypto.randomBytes(8).toString('hex');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const {test}=require('node:test');
test('redemption management, rollback, concurrent disable and bounded waits',{skip:!connection},async()=>{
 const admin=new Database(connection);await admin.query('CREATE SCHEMA '+schema);
 const url=new URL(connection);url.searchParams.set('options','-c search_path='+schema);
 const db=new Database(url.href),results={};let app;
 try{
  await db.initialize();
  await db.query("UPDATE platform_settings SET value=jsonb_set(value,'{login_slider_enabled}','false') WHERE id=1");const crypt=cipher(crypto.randomBytes(32).toString('base64'));
  app=buildPlatform({db,crypt,orders:new Orders(db,crypt),secrets:{internal:'fixture'},proxy:false});await app.ready();
  async function user(role='member'){
   const uid=id(),t=token();await db.query("INSERT INTO platform_users(id,email,name,password_hash,role) VALUES($1,$2,'fixture','unused',$3)",[uid,uid+'@example.test',role]);
   await db.query("INSERT INTO platform_sessions(hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[digest(t),uid]);return {id:uid,cookie:'gptreg_session='+t};
  }
  const a=await user('admin'),u=await user(),v=await user();
  const req=(method,url,body,who=a)=>app.inject({method,url,payload:body,headers:{'x-requested-with':'gptreg',cookie:who.cookie}});
  async function issue(){const r=await req('POST','/api/admin/v1/redeem-codes',{count:1,points:100});assert.equal(r.statusCode,200);const code=r.json().codes[0];const row=await db.one('SELECT id FROM platform_redeem_codes WHERE hash=$1',[digest(code)]);return {code,id:row.id};}
  let c=await issue();const concurrent=await Promise.all(Array.from({length:8},(_,i)=>req('POST','/api/user/v1/redeem',{code:c.code},i%2?u:v)));
  assert.equal(concurrent.filter(r=>r.statusCode===200).length,1);
  assert.equal((await db.one('SELECT count(*)::int AS n FROM platform_ledger WHERE reference=$1',['redeem:'+c.id])).n,1);
  results.concurrent_single_use='8 requests, one credit and ledger entry';
  const used=c.id;
  for(const action of ['disable','delete']){
   c=await issue();assert.equal((await req('POST','/api/admin/v1/redeem-codes/batch',{ids:[c.id],action})).statusCode,200);
   assert.equal((await req('POST','/api/user/v1/redeem',{code:c.code},u)).statusCode,400);
  }
  results.unavailable_codes='disabled/deleted rejected';
  let auditBefore=(await db.one('SELECT count(*)::int AS n FROM platform_audit')).n;
  const missing=await req('PATCH','/api/admin/v1/redeem-codes/not-existent',{disabled:true});
  const usedReply=await req('PATCH','/api/admin/v1/redeem-codes/'+used,{disabled:true});
  c=await issue();auditBefore=(await db.one('SELECT count(*)::int AS n FROM platform_audit')).n;
  const real=await req('PATCH','/api/admin/v1/redeem-codes/'+c.id,{disabled:true});
  results.single_code_management={missing_response:missing.statusCode,used_response:usedReply.statusCode,valid_response:real.statusCode,audit_entries_added:(await db.one('SELECT count(*)::int AS n FROM platform_audit')).n-auditBefore};
  assert.equal(missing.statusCode,409);assert.equal(usedReply.statusCode,409);assert.equal(results.single_code_management.audit_entries_added,1);
  c=await issue();
  const exported=await req('POST','/api/admin/v1/redeem-codes/batch',{ids:[c.id],action:'export'});
  assert.equal(exported.statusCode,200);assert.equal(exported.json().codes[0],c.code);
  await db.query("UPDATE platform_redeem_codes SET expires_at=now()-interval '1 minute' WHERE id=$1",[c.id]);
  const expiredUser=await user();
  assert.equal((await req('POST','/api/user/v1/redeem',{code:c.code},expiredUser)).statusCode,400);
  const expiredList=await req('GET','/api/admin/v1/redeem-codes?status=expired');
  assert.ok(expiredList.json().items.some(row=>row.id===c.id&&row.status==='expired'));
  assert.equal((await req('POST','/api/admin/v1/redeem-codes/batch',{ids:[c.id],action:'export'})).statusCode,409);
  assert.equal((await req('POST','/api/admin/v1/redeem-codes/batch',{ids:[c.id],action:'copy'})).json().codes[0],c.code);
  results.new_management='encrypted retrieval, expiry rejection/filtering, explicit export/copy semantics verified';
  // Force a ledger failure and verify all mutations roll back.
  const w=await user();c=await issue();
  await db.query("CREATE FUNCTION audit_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit fixture'; END $$");
  await db.query('CREATE TRIGGER audit_fail BEFORE INSERT ON platform_ledger FOR EACH ROW EXECUTE FUNCTION audit_fail()');
  const failed=await req('POST','/api/user/v1/redeem',{code:c.code},w);assert.equal(failed.statusCode,500);
  assert.equal((await db.one('SELECT redeemed_by FROM platform_redeem_codes WHERE id=$1',[c.id])).redeemed_by,null);
  assert.equal((await db.one('SELECT points FROM platform_users WHERE id=$1',[w.id])).points,0);
  await db.query('DROP TRIGGER audit_fail ON platform_ledger');await db.query('DROP FUNCTION audit_fail()');
  assert.equal((await req('POST','/api/user/v1/redeem',{code:c.code},w)).statusCode,200);
  results.rollback='code, balance and ledger roll back together';
  const race=await user();c=await issue();const lock=await db.pool.connect();let pending;
  try{
   await lock.query('BEGIN');await lock.query('SELECT id FROM platform_users WHERE id=$1 FOR UPDATE',[race.id]);
   pending=Promise.resolve(req('POST','/api/user/v1/redeem',{code:c.code},race));
   let blocked=false;
   for(let i=0;i<200;i++){
    const state=await db.one("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id,status FROM platform_users%'");
    if(state.n){blocked=true;break;}await delay(20);
   }
   assert.ok(blocked);
   await lock.query("UPDATE platform_users SET status='disabled' WHERE id=$1",[race.id]);await lock.query('DELETE FROM platform_sessions WHERE user_id=$1',[race.id]);await lock.query('COMMIT');
   const r=await pending;const state=await db.one('SELECT status,points FROM platform_users WHERE id=$1',[race.id]);
   results.disable_during_redemption={response:r.statusCode,...state};assert.equal(r.statusCode,403);assert.equal(state.points,0);assert.equal((await db.one('SELECT redeemed_by FROM platform_redeem_codes WHERE id=$1',[c.id])).redeemed_by,null);
  }finally{await lock.query('ROLLBACK');lock.release();}
  const timeoutUser=await user();c=await issue();const held=await db.pool.connect();
  try {
   await held.query('BEGIN');await held.query('SELECT id FROM platform_users WHERE id=$1 FOR UPDATE',[timeoutUser.id]);
   const timed=await req('POST','/api/user/v1/redeem',{code:c.code},timeoutUser);
   assert.equal(timed.statusCode,503);
   assert.equal((await db.one('SELECT redeemed_by FROM platform_redeem_codes WHERE id=$1',[c.id])).redeemed_by,null);
   assert.equal((await db.one('SELECT points FROM platform_users WHERE id=$1',[timeoutUser.id])).points,0);
   await held.query('ROLLBACK');
   assert.equal((await req('POST','/api/user/v1/redeem',{code:c.code},timeoutUser)).statusCode,200);
   assert.equal((await req('POST','/api/user/v1/redeem',{code:c.code},timeoutUser)).statusCode,400);
   assert.equal((await db.one('SELECT count(*)::int AS n FROM platform_ledger WHERE reference=$1',['redeem:'+c.id])).n,1);
  } finally {await held.query('ROLLBACK');held.release();}
  const reset=await user();const rs=[];for(let i=0;i<11;i++)rs.push((await req('POST','/api/user/v1/redeem',{code:'invalid-fixture-code-long'},reset)).statusCode);assert.equal(rs.at(-1),429);results.rate_limit='11th request rejected';
  assert.equal((await req('POST','/api/admin/v1/redeem-codes',{count:1,points:100},u)).statusCode,403);results.permissions='member cannot generate codes';
  const fields=(await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name='platform_redeem_codes'",[schema])).rows.map(r=>r.column_name);
  results.storage={fields,full_code_retrieval:fields.includes('encrypted_code'),expiry:fields.includes('expires_at')};
  assert.ok(results.storage.full_code_retrieval && results.storage.expiry);
 }finally{if(app)await app.close();await db.close();await admin.query('DROP SCHEMA '+schema+' CASCADE');await admin.close();}
});
