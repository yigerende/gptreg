"use strict";
const test = require("node:test"),
  assert = require("node:assert/strict"),
  zlib = require("node:zlib");
const { oauthExport, tokenExport } = require("../src/platform/account-export");
const jwt = (value) =>
  Buffer.from('{"alg":"none"}').toString("base64url") +
  "." +
  Buffer.from(JSON.stringify(value)).toString("base64url") +
  ".fixture";
function account(index) {
  const email = `fixture-${index}@gmail.com`;
  return {
    email,
    password: "secret-not-for-oauth",
    totp_secret: "JBSWY3DPEHPK3PXP",
    oauth: {
      type: "codex",
      email,
      access_token: jwt({
        exp: 1900000000,
        "https://api.openai.com/auth": {
          chatgpt_account_id: `account-${index}`,
          chatgpt_plan_type: "free",
        },
      }),
      id_token: jwt({ email }),
      refresh_token: `fake-refresh-${index}`,
    },
  };
}
function unzip(result) {
  const data = Buffer.from(result.content, "base64"),
    files = [];
  let offset = 0;
  while (data.readUInt32LE(offset) === 0x04034b50) {
    const method = data.readUInt16LE(offset + 8),
      checksum = data.readUInt32LE(offset + 14),
      size = data.readUInt32LE(offset + 18),
      nameLength = data.readUInt16LE(offset + 26),
      extra = data.readUInt16LE(offset + 28);
    const name = data
      .subarray(offset + 30, offset + 30 + nameLength)
      .toString();
    offset += 30 + nameLength + extra;
    const packed = data.subarray(offset, offset + size),
      raw = method === 8 ? zlib.inflateRawSync(packed) : packed;
    assert.equal(zlib.crc32(raw), checksum);
    files.push({ name, value: JSON.parse(raw) });
    offset += size;
  }
  assert.equal(data.readUInt32LE(offset), 0x02014b50);
  return files;
}

test("web token exports preserve complete sessions, support standard accounts and reject missing tokens without OAuth substitution", () => {
  const full = 'full-session-'+'abcdef012345'.repeat(1500);
  const values = Array.from({length:1000},(_,i)=>({email:`test-${i}@example.test`,access_token:`web-at-${i}`,session_token:i===0?full:`session-${i}`}));
  for(const [format,field] of [["email_at","access_token"],["email_session","session_token"]]) {
    const exported=tokenExport(values,format);const lines=exported.content.trimEnd().split('\n');
    assert.equal(lines.length,1000);assert.equal(lines[0],`${values[0].email}----${values[0][field]}`);
    assert.throws(()=>tokenExport([...values,{email:'missing@example.test',oauth:{access_token:'OAUTH_MUST_NOT_SUBSTITUTE'}}],format),e=>e.statusCode===409&&!e.message.includes('OAUTH_MUST_NOT_SUBSTITUTE'));
  }
});

test("delivery token backfill matches asset ownership, preserves existing encrypted fields and never changes billing", async t => {
  const fs=require('node:fs'),crypto=require('node:crypto');
  const connection=process.env.GPTREG_TEST_DATABASE_URL || (fs.existsSync('.local/platform-test/connection.json')?JSON.parse(fs.readFileSync('.local/platform-test/connection.json')).url:'');
  if(!connection){t.skip('isolated database unavailable');return;}
  const {Database}=require('../src/platform/db'),{Orders}=require('../src/platform/orders'),{cipher,id}=require('../src/platform/security');
  const {OrderWorker}=require('../src/platform/worker'),{backfillAccountTokens}=require('../src/platform/account-tokens');
  const setup=new Database(connection),schema='tokens_'+crypto.randomBytes(8).toString('hex');await setup.query('CREATE SCHEMA '+schema);
  const url=new URL(connection);url.searchParams.set('options','-c search_path='+schema);
  const db=new Database(url.href),crypt=cipher(crypto.randomBytes(32).toString('base64')),orders=new Orders(db,crypt);
  t.after(async()=>{await db.close();await setup.query('DROP SCHEMA '+schema+' CASCADE');await setup.close();});
  await db.initialize();
  const user=await db.one("INSERT INTO platform_users(id,email,name,password_hash,points) VALUES($1,'token@example.test','test','unused',10000) RETURNING *",[id()]);
  await db.query("UPDATE platform_settings SET value=value||'{\"orders_open\":true}'::jsonb WHERE id=1");
  const order=(await orders.create(user,{quantity:3},id(),'web')).order,items=(await orders.detail(user.id,order.id)).items;
  const assets=new Map();
  for(const [i,item] of items.entries()) {
    const creds={asset_id:'asset-'+i,email:`token-${i}@gmail.com`,password:'keep-password',totp_secret:'JBSWY3DPEHPK3PXP',...(i===0?{access_token:'keep-existing-at'}:{})};
    await orders.finish(item.id,creds);
    assets.set(creds.asset_id,{id:creds.asset_id,email:i===1?'wrong-owner@gmail.com':creds.email,accessToken:'web-at-'+i,sessionToken:'FULL_SESSION_'+'x'.repeat(18000),password:creds.password,totpSecret:creds.totp_secret,security:{passwordStatus:'configured',totpStatus:'configured'},clientProfileFingerprint:'fingerprint-'+i,oaiDid:'device-'+i,sourceProxy:{countryCode:'PH',url:'http://proxy-secret@example.test'},clientProfile:{browser:'firefox',userAgent:'fixture UA',password:'profile-secret',hardwareConcurrency:8,screen:{width:1920,height:1080}}});
  }
  const manager={sessionAssets:()=>({get:assetId=>{if(assetId==='asset-2')throw new Error('pruned');return assets.get(assetId);}})};
  const before=await db.one('SELECT count(*)::int AS n FROM platform_ledger');
  assert.deepEqual(await backfillAccountTokens(db,crypt,manager),{checked:3,updated:1});
  const rows=(await db.query('SELECT * FROM platform_accounts ORDER BY email')).rows;
  const revealed=crypt.decrypt(rows[0].credentials);assert.equal(revealed.access_token,'keep-existing-at');assert.equal(revealed.session_token.length,18013);
  assert.equal(revealed.password,'keep-password');assert.ok(!rows[0].credentials.includes('FULL_SESSION_'));
  assert.equal(revealed.device_fingerprint.fingerprint,'fingerprint-0');
  assert.equal(revealed.device_fingerprint.profile.hardwareConcurrency,8);
  assert.ok(!JSON.stringify(revealed.device_fingerprint).includes('secret'));
  for(const row of rows.slice(1)){assert.equal(crypt.decrypt(row.credentials).session_token,undefined);assert.equal(row.login_tokens_synced_at,null);}
  assert.deepEqual(await backfillAccountTokens(db,crypt,manager),{checked:0,updated:0});
  assert.deepEqual(await db.one('SELECT count(*)::int AS n FROM platform_ledger'),before);
  const worker=new OrderWorker(db,orders,manager),newCredentials=worker.credentials(assets.get('asset-0'),false);
  assert.equal(newCredentials.access_token,'web-at-0');assert.equal(newCredentials.session_token,assets.get('asset-0').sessionToken);assert.equal(newCredentials.oauth,undefined);
  assert.deepEqual(newCredentials.device_fingerprint,revealed.device_fingerprint);
  const {buildPlatform}=require('../src/platform/app'),{digest}=require('../src/platform/security');
  const app=buildPlatform({db,orders,crypt,secrets:{internal:'test'},proxy:false});t.after(()=>app.close());
  const other=await db.one("INSERT INTO platform_users(id,email,name,password_hash,role) VALUES($1,'other@example.test','Other','unused','member') RETURNING *",[id()]);
  const admin=await db.one("INSERT INTO platform_users(id,email,name,password_hash,role) VALUES($1,'admin@example.test','Admin','unused','admin') RETURNING *",[id()]);
  for(const u of [user,other,admin]) await db.query("INSERT INTO platform_sessions(hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')",[digest(u.id),u.id]);
  const get=(u,adminRoute=false,accountId=rows[0].id)=>app.inject({url:`/api/${adminRoute?'admin':'user'}/v1/accounts/${accountId}/device-fingerprint`,headers:u?{cookie:`gptreg_session=${u.id}`}:{}});
  assert.equal((await get(null)).statusCode,401);
  assert.equal((await get(other)).statusCode,404);
  assert.equal((await get(user,true)).statusCode,403);
  const own=await get(user);assert.equal(own.statusCode,200,own.body);
  assert.equal(own.json().device_fingerprint.deviceId,'device-0');assert.ok(own.json().download_expires_at);
  for(const secret of ['keep-password','FULL_SESSION','proxy-secret','profile-secret','web-at','other@example'])assert.ok(!own.body.includes(secret));
  assert.equal((await get(user,false,rows[1].id)).json().device_fingerprint,null);
  await db.query("UPDATE platform_accounts SET created_at=now()-interval '73 hours' WHERE id=$1",[rows[0].id]);
  assert.equal((await get(user)).statusCode,404);
  assert.equal((await get(admin,true)).json().device_fingerprint.fingerprint,'fingerprint-0');
});
test("CPA single JSON and 1000-account ZIP contain isolated importer objects without portal secrets", () => {
  const one = oauthExport([account(0)], "cpa");
  assert.match(one.filename, /\.json$/);
  assert.deepEqual(JSON.parse(one.content), account(0).oauth);
  const result = oauthExport(
    Array.from({ length: 1000 }, (_, i) => account(i)),
    "cpa",
  );
  assert.equal(result.encoding, "base64");
  assert.match(result.filename, /1000\.zip$/);
  const entries = unzip(result);
  assert.equal(entries.length, 1000);
  assert.equal(new Set(entries.map((x) => x.name)).size, 1000);
  for (const [i, entry] of entries.entries()) {
    assert.deepEqual(entry.value, account(i).oauth);
    assert.ok(!entry.name.includes("/"));
  }
  const duplicates = unzip(oauthExport([account(0), account(0)], "cpa"));
  assert.notEqual(duplicates[0].name, duplicates[1].name);
});
test("SUB merges 1000 accounts into the local sub2api import schema and rejects unusable selections", () => {
  const result = oauthExport(
      Array.from({ length: 1000 }, (_, i) => account(i)),
      "sub",
    ),
    document = JSON.parse(result.content);
  assert.match(result.filename, /\.json$/);
  assert.deepEqual(document.proxies, []);
  assert.equal(document.accounts.length, 1000);
  for (const [i, row] of document.accounts.entries()) {
    assert.equal(row.platform, "openai");
    assert.equal(row.type, "oauth");
    assert.equal(row.credentials.chatgpt_account_id, `account-${i}`);
    assert.equal(row.credentials.refresh_token, `fake-refresh-${i}`);
    assert.ok(!row.credentials.password);
  }
  for (const format of ["cpa", "sub"])
    assert.throws(
      () =>
        oauthExport([account(0), { email: "standard@example.test" }], format),
      (e) => e.statusCode === 400,
    );
  assert.throws(
    () =>
      oauthExport(
        [
          {
            ...account(0),
            oauth: { access_token: "bad", refresh_token: "redacted" },
          },
        ],
        "sub",
      ),
    (e) => e.statusCode === 409 && !e.message.includes("redacted"),
  );
});
