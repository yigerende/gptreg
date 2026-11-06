const { test } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), crypto = require('node:crypto');
const { costSnapshot, sumCosts, syncAttemptCosts, backfillCosts } = require('../src/platform/execution-costs');
const { Database } = require('../src/platform/db');
const { Orders } = require('../src/platform/orders');
const { buildPlatform } = require('../src/platform/app');
const { cipher, id, digest } = require('../src/platform/security');
const state = (cost = .017, rentalId = id()) => ({ taskKind: 'register_session', status: 'complete', workers: [], jobs: [], mailboxes: [{ id:rentalId, rented:true, rentalClosed:'settled', costUsd:cost }] });
test('SMSBower code delivery incurs a cost once per rental even after failure or cancellation', () => {
  const { mailRentalCost } = require('../src/mail-cost-ledger');
  const input = {...state(), runPlan:{mailProvider:'smsbower'}, status:'failed', runId:'received-failures'};
  input.mailboxes = ['refused','settle-failed','received-cancelled','unused'].map(id => ({id,rented:true,quotedPriceUsd:.017,costUsd:0,
    rentalClosed:id==='refused'?'cleanup_manual_review':id==='settle-failed'?'settlement_unknown':'cancelled'}));
  input.jobs = input.mailboxes.map(m=>({id:'j-'+m.id,mailboxId:m.id,status:'failed',error:{code:'EMAIL_OTP_TIMEOUT'}}));
  input.jobs[0].emailMessageId='received';
  input.events=[{type:'email_otp_received',jobId:'j-settle-failed'},{type:'email_otp_received',jobId:'j-settle-failed'}];
  input.mailboxes[2].mailCodeReceivedAt='2026-11-06T00:00:00Z';
  const s=costSnapshot(input);
  assert.equal(s.calculation_version,3); assert.equal(s.mail.USD.confirmed,.051);assert.equal(s.mail.USD.pending,0);
  assert.equal(s.resources.mail.failed,4);assert.equal(s.resources.mail.failed_cost.USD.confirmed,.051);
  assert.equal(s.kind_pending.mail,false); assert.equal(sumCosts([s,s]).mail.USD.confirmed,.051);
  assert.equal(mailRentalCost(input.mailboxes[3],input).confirmed,0,'another rental receiving a code does not bill this one');
  assert.equal(mailRentalCost({...input.mailboxes[0],provider:'different'},input).confirmed,0,'provider billing rules are not inferred');
  assert.equal(mailRentalCost({quotedPriceUsd:.017},{runPlan:{mailProvider:'smsbower'},jobs:[{emailMessageId:'unlinked'}]}).confirmed,0);
});
test('cost snapshots separate confirmed rental spend, uncertain quotes and currencies without credentials', () => {
  const input = state(); input.mailboxes.push({ id:'uncertain', rented:true, rentalClosed:'settlement_unknown', quotedPriceUsd:.03 });
  input.password = 'NEVER_STORE_ME';
  const snapshot = costSnapshot(input);
  assert.equal(snapshot.mail.USD.confirmed,.017); assert.equal(snapshot.mail.USD.pending,.03); assert.equal(snapshot.complete,false);
  assert.ok(!JSON.stringify(snapshot).includes('NEVER_STORE_ME'));
  const second = { ...costSnapshot(state(.02)), version:1, sms:{ CNY:{confirmed:1.5,pending:0,refunded:.2} } };
  const total = sumCosts([snapshot,second,null]);
  assert.equal(total.mail.USD.confirmed,.037); assert.equal(total.sms.CNY.confirmed,1.5); assert.equal(total.missing,1);
  assert.equal(total.pending,true);
});
test('failed mail rentals include refused cancellation costs, and successful cancellation stays free', () => {
  const input = state(); input.status = 'partial'; input.runId = 'mail-failures';
  input.mailboxes = [
    {id:'paid-failure',rented:true,rentalClosed:'settled',costUsd:.017},
    {id:'refused',rented:true,rentalClosed:'cleanup_manual_review',quotedPriceUsd:.017,costUsd:0,rentalUnresolvedUsd:0,rentalBillingUncertain:false,rentalCleanup:{action:'cancel',status:'manual_review',lastError:{code:'MAILBOX_STATE_REJECTED',message:'SECRET_RESPONSE'}}},
    {id:'cancelled',rented:true,rentalClosed:'cancelled',quotedPriceUsd:.017,costUsd:0},
    {id:'settle-review',rented:true,rentalClosed:'settlement_unknown',quotedPriceUsd:.017,costUsd:0},
  ];
  input.jobs = input.mailboxes.map(m=>({id:'j-'+m.id,mailboxId:m.id,status:'failed',error:{code:'EMAIL_OTP_TIMEOUT'},email:'SECRET_ADDRESS',password:'SECRET_PASSWORD'}));
  const snapshot = costSnapshot(input), u = snapshot.resources.mail;
  assert.equal(snapshot.version,2); assert.equal(snapshot.mail.USD.confirmed,.017); assert.equal(snapshot.mail.USD.pending,.034);
  assert.equal(u.total,4); assert.equal(u.failed,4); assert.equal(u.succeeded,0);
  assert.equal(u.cancelled,1); assert.equal(u.cancel_failed,1); assert.equal(u.review,1);
  assert.deepEqual(u.failed_cost.USD,{confirmed:.017,pending:.034,refunded:0});
  assert.deepEqual(u.reasons,[{code:'EMAIL_OTP_TIMEOUT',count:4}]);
  assert.deepEqual(snapshot.kind_pending,{mail:true,sms:false}); assert.equal(snapshot.complete,false);
  assert.ok(!JSON.stringify(snapshot).includes('SECRET_'));
});
test('SMS counts distinguish accepted, rejected paid, cancelled, cleanup failure, waiting and unknown records', () => {
  const input = state(); input.status='running'; input.runId='sms-scenarios';
  input.jobs=[{id:'j',status:'running',sms:{attempts:[
    {activationId:'ok',status:'complete',cost:.05,targetAccepted:true},
    {activationId:'paid-bad',status:'complete',cost:.06,codeReceived:true,targetAccepted:false,cleanupReason:'INVALID_PHONE_OTP'},
    {activationId:'cancel',status:'cancelled',cost:.03,cancelReason:'FRAUD_GUARD'},
    {activationId:'refund',status:'cancelled',cost:.04,refunded:true,cancelReason:'PHONE_NUMBER_IN_USE'},
    {activationId:'no-price',status:'cancelled',cancelReason:'SMS_CODE_TIMEOUT'},
  ],pendingCleanup:[{activationId:'deferred',status:'pending_cleanup',cost:.02,cleanupAction:'cancel',cleanupError:'SECRET_PROVIDER_RESPONSE',cleanupReason:'SMS_CODE_TIMEOUT'}],
  current:{activationId:'waiting',status:'waiting_code',cost:.01,phone:'SECRET_PHONE',code:'SECRET_CODE'}}}];
  const snapshot = costSnapshot(input), u=snapshot.resources.sms;
  assert.equal(u.total,7); assert.equal(u.succeeded,1); assert.equal(u.failed,5); assert.equal(u.active,1);
  assert.equal(u.cancelled,3); assert.equal(u.cancel_failed,1); assert.equal(u.price_unknown,1);
  assert.deepEqual(u.failed_cost.USD,{confirmed:.06,pending:.05,refunded:.04});
  assert.deepEqual(snapshot.sms.USD,{confirmed:.11,pending:.06,refunded:.04});
  assert.deepEqual(snapshot.kind_pending,{mail:false,sms:true});
  assert.ok(!JSON.stringify(snapshot).includes('SECRET_'));
  input.jobs[0].sms.current={...input.jobs[0].sms.attempts[0]};
  assert.equal(costSnapshot(input).resources.sms.total,6,'same current and archived activation counted once');
});
test('reconciled cancelled SMS quotes are not reintroduced as failed costs', () => {
  const { summarizeSmsCosts }=require('../src/sms-cost-ledger');
  const jobs=[{id:'j',status:'complete',sms:{attempts:[{activationId:'cancel',status:'cancelled',cost:.03,cancelReason:'FRAUD_GUARD'}]}}];
  const ledger=summarizeSmsCosts(jobs,{includeRecords:true,settledCancelledQuotesByJob:{j:.03}}).ledgers[0].ledger;
  assert.equal(ledger.unresolvedUsd,0);assert.equal(ledger.records[0].unresolvedUsd,0);assert.equal(ledger.records[0].billingUnresolved,false);
});
test('legacy quantities remain unknown, missing history retains amounts, repeated resource facts count once', () => {
  const input=state(.017,'m');input.jobs=[{id:'j',mailboxId:'m',status:'complete'}];
  const snap=costSnapshot(input), legacy={version:1,mail:{USD:{confirmed:.02,pending:0,refunded:0}},sms:{},complete:true};
  const total=sumCosts([snap,snap,legacy,null]);
  assert.equal(total.resources.mail.total,1);assert.equal(total.resources.mail.missing_attempts,2);
  assert.equal(total.resources.mail.succeeded,1);assert.equal(total.missing,1);
  assert.equal(total.mail.USD.confirmed,.037,'repeated leases do not duplicate costs');
  const unknown=costSnapshot({...state(),jobs:[{id:'legacy',status:'complete',sessionAssetId:'asset',sms:{costUsd:.05}}]});
  assert.equal(unknown.resources.sms.total,0);assert.equal(unknown.resources.sms.uncounted,1);
  assert.equal(unknown.sms.USD.confirmed,.05);
});
const connection = process.env.GPTREG_TEST_DATABASE_URL || (fs.existsSync('.local/platform-test/connection.json') ? JSON.parse(fs.readFileSync('.local/platform-test/connection.json')).url : '');
test('cost reporting: retries, durable snapshots, grouped deliveries, exports and customer privacy', {skip:!connection}, async t => {
  const setup = new Database(connection), schema = 'cost_'+crypto.randomBytes(8).toString('hex');
  await setup.query('CREATE SCHEMA '+schema);
  const url = new URL(connection); url.searchParams.set('options','-c search_path='+schema);
  const db = new Database(url.href), crypt = cipher(crypto.randomBytes(32).toString('base64')), orders = new Orders(db,crypt);
  const app = buildPlatform({db,crypt,orders,secrets:{internal:'test'},proxy:false});
  t.after(async()=>{await app.close();await db.close();await setup.query('DROP SCHEMA '+schema+' CASCADE');await setup.close();});
  await db.initialize();
  const user = await db.one("INSERT INTO platform_users(id,email,name,password_hash,points) VALUES($1,'cost@example.test','cost','unused',10000) RETURNING *",[id()]);
  const admin = await db.one("INSERT INTO platform_users(id,email,name,password_hash,role) VALUES($1,'admin-cost@example.test','admin','unused','admin') RETURNING *",[id()]);
  await db.query("UPDATE platform_settings SET value=value||'{\"orders_open\":true}'::jsonb WHERE id=1");
  for(const u of [user,admin])await db.query("INSERT INTO platform_sessions VALUES($1,$2,now()+interval '1 hour')",[digest(u.id),u.id]);
  const get = (url,u=admin) => app.inject({url,headers:u?{cookie:'gptreg_session='+u.id}:{}});
  const order = (await orders.create(user,{quantity:2},id(),'web')).order;
  const items = (await orders.detail(user.id,order.id)).items;
  for(const [n,item] of items.entries()) {
    for(let k=0;k<(n===0?2:1);k++) {
      const rid='customer-'+id();
      await db.query("INSERT INTO platform_attempts(id,item_id,run_id,stage,status) VALUES($1,$2,$3,'register','finished')",[id(),item.id,rid]);
      await syncAttemptCosts(db,{},rid,state(n===0?.017:.02));
      await syncAttemptCosts(db,{load(){throw new Error('pruned');}},rid);
    }
    await orders.finish(item.id,{asset_id:id(),email:id()+'@gmail.com',password:'test-password',totp_secret:'JBSWY3DPEHPK3PXP'});
  }
  let response = await get('/api/admin/v1/orders/'+order.id); assert.equal(response.statusCode,200,response.body);
  assert.equal(response.json().execution_cost.mail.USD.confirmed,.054);
  assert.equal(response.json().items[0].execution_cost.mail.USD.confirmed,.034);
  const group = await get('/api/admin/v1/account-orders?limit=1');assert.equal(group.statusCode,200,group.body);
  assert.equal(group.json().total,1);assert.equal(group.json().items[0].available_count,2);
  assert.equal((await get('/api/admin/v1/account-orders?q=absent')).json().total,0);
  const accounts=(await get('/api/admin/v1/accounts?order_id='+order.id)).json().items;
  const account=accounts.find(a=>a.item_id===items[0].id);
  assert.equal(account.execution_cost.mail.USD.confirmed,.034);
  const revealed=(await get('/api/admin/v1/accounts/'+account.id+'/credentials')).json();assert.equal(revealed.delivery.execution_cost.mail.USD.confirmed,.034);
  const exported=await app.inject({method:'POST',url:'/api/admin/v1/accounts/export',headers:{cookie:'gptreg_session='+admin.id,'x-requested-with':'gptreg'},payload:{ids:[account.id],format:'json'}});
  assert.equal(exported.statusCode,200,exported.body);assert.equal(JSON.parse(exported.json().content)[0].delivery.execution_cost.mail.USD.confirmed,.034);
  for(const path of ['/api/admin/v1/account-orders','/api/admin/v1/overview','/api/v1/resources/summary']) {
    assert.equal((await get(path,null)).statusCode,401);assert.equal((await get(path,user)).statusCode,403);
  }
  const overview=await get('/api/admin/v1/overview');assert.equal(overview.statusCode,200,overview.body);assert.equal(overview.json().execution_cost.mail.USD.confirmed,.054);
  for(const path of ['/api/user/v1/accounts','/api/user/v1/registration-orders/'+order.id])assert.ok(!(await get(path,user)).body.includes('execution_cost'));
  await backfillCosts(db,{load(){throw new Error('missing');}});
  assert.equal((await get('/api/admin/v1/orders/'+order.id)).json().execution_cost.mail.USD.confirmed,.054);
  const attempt=await db.one('SELECT id,run_id,cost_snapshot FROM platform_attempts ORDER BY created_at LIMIT 1');
  await db.query("UPDATE platform_attempts SET cost_snapshot=$2,cost_checked_at=now()-interval '10 minutes' WHERE id=$1",[attempt.id,{version:1,mail:{USD:{confirmed:.017,pending:0,refunded:0}},sms:{},complete:true}]);
  await backfillCosts(db,{load(runId){assert.equal(runId,attempt.run_id);return {...state(),jobs:[{id:'j',mailboxId:'m',status:'complete'}]};}});
  assert.equal((await db.one('SELECT cost_snapshot FROM platform_attempts WHERE id=$1',[attempt.id])).cost_snapshot.version,2,'completed legacy snapshots also get resource stats');
  response=await get('/api/admin/v1/orders/'+order.id);
  assert.ok(response.json().execution_cost.resources.mail.total>0);
  for(const path of ['/api/user/v1/accounts','/api/user/v1/registration-orders/'+order.id]) {
    const body=(await get(path,user)).body;assert.ok(!body.includes('resource_records'));assert.ok(!body.includes('failed_cost'));
  }
});
