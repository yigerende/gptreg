"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict"),fs=require("node:fs"),crypto=require("node:crypto");
const {Database}=require("../src/platform/db"),{Orders}=require("../src/platform/orders"),{cipher,id,digest}=require("../src/platform/security"),{buildPlatform}=require("../src/platform/app");
const {costSnapshot}=require("../src/platform/execution-costs"),{supplierQuery}=require("../src/platform/suppliers");
test('supplier facts retain the actual number country and distinguish receipt from successful verification',()=>{
 const state={runId:'r',status:'failed',taskKind:'register_session',runPlan:{mailProvider:'smsbower'},workers:[],preflight:{sms:{provider:'hero-sms',countries:[{country:{id:'6',name:'Indonesia'}}]}},
  mailboxes:[{id:'mail',rented:true,quotedPriceUsd:.017,mailCodeReceivedAt:'now',rentalClosed:'cleanup_manual_review'}],
  jobs:[{id:'j',mailboxId:'mail',status:'failed',sms:{attempts:[{id:'s',provider:'hero-sms',country:'6',countryCode:'62',status:'cancelled',codeReceived:true,targetAccepted:false,cost:.03,cancelReason:'INVALID_PHONE_OTP',number:'SECRET_PHONE',code:'SECRET_CODE'}]}}]};
 const s=costSnapshot(state);assert.equal(s.supplier_version,1);
 assert.equal(s.supplier_records.mail[0].received,true);assert.equal(s.supplier_records.mail[0].outcome,'failed');
 const sms=s.supplier_records.sms[0];assert.equal(sms.provider,'hero-sms');assert.equal(sms.country,'6');assert.equal(sms.country_name,'印度尼西亚');assert.equal(sms.received,true);assert.equal(sms.outcome,'failed');
 assert.ok(!JSON.stringify(s).includes('SECRET_'));
 const cancelled=costSnapshot({...state,jobs:[],mailboxes:[{...state.mailboxes[0],rentalClosed:'cancelled'}]});
 assert.equal(cancelled.supplier_records.mail[0].outcome,'failed');
 state.mailboxes[0].rented=false;state.runPlan.mailProvider='fastmail';const pooled=costSnapshot(state);
 assert.equal(pooled.resource_records.mail.length,0);assert.equal(pooled.supplier_records.mail[0].provider,'fastmail');
 assert.equal(pooled.supplier_records.mail[0].price_unknown,true);
});
test('supplier filters reject invalid resource kinds, country input, and unbounded pages',()=>{
 assert.equal(supplierQuery({kind:'sms'}).kind,'sms');assert.equal(supplierQuery({}).include_admin,true);
 for(const q of [{kind:'invalid'},{country:'1 OR 1=1'},{provider:'https://secret'},{limit:1000},{offset:-1}])assert.throws(()=>supplierQuery(q));
});
const connection=process.env.GPTREG_TEST_DATABASE_URL||(fs.existsSync('.local/platform-test/connection.json')?JSON.parse(fs.readFileSync('.local/platform-test/connection.json')).url:'');
test('supplier report deduplicates leases, separates countries and vendors, paginates and denies members', {skip:!connection},async t=>{
 const setup=new Database(connection),schema='supplier_'+crypto.randomBytes(8).toString('hex');await setup.query('CREATE SCHEMA '+schema);
 const url=new URL(connection);url.searchParams.set('options','-c search_path='+schema);const db=new Database(url.href),crypt=cipher(crypto.randomBytes(32).toString('base64')),orders=new Orders(db,crypt),app=buildPlatform({db,crypt,orders,secrets:{internal:'test'},proxy:false});
 t.after(async()=>{await app.close();await db.close();await setup.query('DROP SCHEMA '+schema+' CASCADE');await setup.close();});await db.initialize();
  await db.query("UPDATE platform_settings SET value=jsonb_set(value,'{login_slider_enabled}','false') WHERE id=1");
 const users=[];for(const role of ['admin','member']){const u=await db.one("INSERT INTO platform_users(id,email,name,password_hash,role,points) VALUES($1,$2,'test','unused',$3,10000) RETURNING *",[id(),role+'@example.test',role]);users.push(u);await db.query("INSERT INTO platform_sessions VALUES($1,$2,now()+interval '1 hour')",[digest(u.id),u.id]);}
 await db.query("UPDATE platform_settings SET value=value||'{\"orders_open\":true}'::jsonb");
 const record=(key,provider,country,outcome,received,confirmed=.02)=>({key,provider,country,country_name:country==='6'?'印度尼西亚':'菲律宾',outcome,received,confirmed,pending:0,refunded:0,currency:'USD',counted:true});
 for(const [n,user] of users.entries()){
  const o=(await orders.create(user,{quantity:1},id(),'web')).order,item=(await orders.detail(user.id,o.id)).items[0];
  const records=n===0?[record('admin','smsbower','6','succeeded',true)]:[record('a','smsbower','6','succeeded',true),record('b','smsbower','6','failed',false,0),record('c','smsbower','6','active',null,0),record('d','hero-sms','6','failed',true),record('e','smsbower','4','succeeded',true)];
  for(let k=0;k<(n===0?1:2);k++)await db.query("INSERT INTO platform_attempts(id,item_id,run_id,stage,cost_snapshot) VALUES($1,$2,$3,'register',$4)",[id(),item.id,id(),{version:2,supplier_version:1,updated_at:new Date(Date.now()+k).toISOString(),supplier_records:{mail:[record('mail-'+n,'smsbower','','succeeded',true,.017)],sms:records}}]);
 }
 const request=(suffix='',u=users[0])=>app.inject({url:'/api/admin/v1/suppliers?kind=sms'+suffix,headers:u?{cookie:'gptreg_session='+u.id}:{}});
 const r=await request();assert.equal(r.statusCode,200,r.body);const d=r.json();assert.equal(d.total,3);assert.equal(d.summary.total,6);assert.equal(d.summary.succeeded,3);assert.equal(d.summary.failed,2);assert.equal(d.summary.success_rate,60);assert.equal(d.summary.active,1);
 const one=d.items.find(x=>x.provider==='smsbower'&&x.country==='6');assert.equal(one.total,4);assert.equal(one.success_rate,2/3*100);assert.equal(one.costs.USD.confirmed,.04);
 assert.equal((await request('&include_admin=false')).json().summary.total,5);
 assert.equal((await request('&provider=hero-sms&country=6')).json().summary.receipt_rate,100);
 const page1=(await request('&limit=1')).json(),page2=(await request('&limit=1&offset=1')).json();assert.equal(page1.items.length,1);assert.equal(page2.items.length,1);assert.notDeepEqual(page1.items[0],page2.items[0]);assert.equal(page1.summary.total,page2.summary.total);
 assert.equal((await request('&offset=100')).json().total,3);assert.equal((await request('&provider=absent')).json().summary.success_rate,null);
 assert.equal((await request('',null)).statusCode,401);assert.equal((await request('',users[1])).statusCode,403);
 for(const query of ['&country=x%27','&limit=1000','&kind=bad'])assert.equal((await request(query)).statusCode,400);
 assert.ok(!r.body.includes('password'));assert.ok(!r.body.includes('@example.test'));
});
