const { test } = require('node:test');
const assert = require('node:assert/strict'), fs = require('node:fs'), crypto = require('node:crypto');
const { costSnapshot, sumCosts, syncAttemptCosts, backfillCosts } = require('../src/platform/execution-costs');
const { Database } = require('../src/platform/db');
const { Orders } = require('../src/platform/orders');
const { buildPlatform } = require('../src/platform/app');
const { cipher, id, digest } = require('../src/platform/security');
const state = (cost = .017) => ({ taskKind: 'register_session', status: 'complete', workers: [], jobs: [], mailboxes: [{ id:'m', rented:true, rentalClosed:'settled', costUsd:cost }] });
test('cost snapshots separate confirmed rental spend, uncertain quotes and currencies without credentials', () => {
  const input = state(); input.mailboxes.push({ id:'uncertain', rented:true, rentalClosed:'settlement_unknown', quotedPriceUsd:.03 });
  input.password = 'NEVER_STORE_ME';
  const snapshot = costSnapshot(input);
  assert.equal(snapshot.mail.USD.confirmed,.017); assert.equal(snapshot.mail.USD.pending,.03); assert.equal(snapshot.complete,false);
  assert.ok(!JSON.stringify(snapshot).includes('NEVER_STORE_ME'));
  const second = { ...costSnapshot(state(.02)), sms:{ CNY:{confirmed:1.5,pending:0,refunded:.2} } };
  const total = sumCosts([snapshot,second,null]);
  assert.equal(total.mail.USD.confirmed,.037); assert.equal(total.sms.CNY.confirmed,1.5); assert.equal(total.missing,1);
  assert.equal(total.pending,true);
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
});
