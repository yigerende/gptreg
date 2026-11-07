'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { ProxyUsage, preferUncooled } = require('../src/proxy-usage');
const { ProxyClaims, defaultOAuthAssignments } = require('../src/oauth-proxies');
const { createRebindProxyPool } = require('../src/ui-server/rebind-proxy');
const { stableProxyId } = require('../src/proxy-pool');

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-proxy-usage-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const file = path.join(cwd, 'proxy-usage.json');
  let clock = Date.parse('2026-11-07T00:00:00Z');
  return { file, now: () => clock, advance: ms => clock += ms, usage: new ProxyUsage(file, { now: () => clock }) };
}

test('usage write failure is classified as storage failure and preserves existing records', t => {
  const f = fixture(t), entry = { id: 'saved', sessionMinutes: 10 };
  f.usage.begin(entry);
  const previous = fs.readFileSync(f.file, 'utf8');
  f.usage.file = path.join(f.file, 'not-a-directory', 'proxy-usage.json');
  assert.throws(() => f.usage.begin({ id: 'unsaved' }), { code: 'PROXY_USAGE_STORAGE_ERROR' });
  assert.equal(f.usage.get('unsaved').inUse, false);
  assert.throws(() => f.usage.release('saved'), { code: 'PROXY_USAGE_STORAGE_ERROR' });
  assert.equal(f.usage.get('saved').inUse, true);
  assert.equal(fs.readFileSync(f.file, 'utf8'), previous);
});

test('rebind stops on usage storage failure without retiring healthy candidates', async t => {
  const f = fixture(t);
  f.usage.begin({ id: 'saved' });
  f.usage.file = path.join(f.file, 'blocked', 'proxy-usage.json');
  const registry = new Map(), retired = [], probes = [];
  const pool = createRebindProxyPool([{ workerSlot: 1, kind: 'countryPool', countryCode: 'JP' }], {
    dynamic: { countryPools: [{ countryCode: 'JP', entries: ['one', 'two'].map(name => ({ url: `http://${name}.example.test:9000` })) }] },
  }, { claims: registry, usage: f.usage, executor: async () => { probes.push(true); return { response: { status: 200 } }; }, retireProxy: async x => retired.push(x) });
  await assert.rejects(pool.acquire(1), { code: 'PROXY_USAGE_STORAGE_ERROR' });
  assert.equal(probes.length, 1);
  assert.deepEqual(retired, []);
  assert.equal(registry.size, 0);
});

test('cooldown starts at release for the full sticky duration and persists through reloading', t => {
  const f = fixture(t), entry = { id: 'proxy-a', sessionMinutes: 10, url: 'http://secret:password@example.test:9000' };
  f.usage.begin(entry); f.advance(120000);
  assert.equal(f.usage.get(entry.id).inUse, true);
  f.usage.release(entry.id);
  assert.equal(f.usage.get(entry.id).lastUsedAt, '2026-11-07T00:00:00.000Z');
  assert.equal(f.usage.get(entry.id).cooldownUntil, '2026-11-07T00:12:00.000Z');
  const reloaded = new ProxyUsage(f.file, { now: f.now });
  reloaded.recover(); assert.equal(reloaded.isCooling(entry.id), true);
  assert.equal(reloaded.get(entry.id).cooldownUntil, f.usage.get(entry.id).cooldownUntil);
  assert.ok(!fs.readFileSync(f.file, 'utf8').includes('secret'));
  f.advance(600000); assert.equal(reloaded.isCooling(entry.id), false);
  reloaded.begin(entry); f.advance(60000); reloaded.release(entry.id);
  assert.equal(reloaded.get(entry.id).cooldownUntil, '2026-11-07T00:23:00.000Z');
});

test('crash recovery releases abandoned use into cooldown; unknown stickiness records usage only', t => {
  const f = fixture(t); f.usage.begin({ id: 'sticky', sessionMinutes: 120 });
  f.usage.begin({ id: 'fixed' }); f.advance(3600000);
  const resumed = new ProxyUsage(f.file, { now: f.now }); resumed.recover();
  assert.equal(resumed.get('sticky').inUse, false);
  assert.equal(resumed.get('sticky').cooldownUntil, '2026-11-07T03:00:00.000Z');
  assert.equal(resumed.get('fixed').cooldownUntil, '');
  assert.equal(resumed.get('fixed').lastUsedAt, '2026-11-07T00:00:00.000Z');
});

test('ready connections win; all-cooling fallback never overrides another task reservation', t => {
  const f = fixture(t), registry = new Map(), entries = ['a','b','c'].map(id => ({ id, sessionMinutes: 10 }));
  for (const entry of entries.slice(0,2)) { f.usage.begin(entry); f.usage.release(entry.id); }
  const a = new ProxyClaims(registry, 'account-a', f.usage), b = new ProxyClaims(registry, 'account-b', f.usage);
  assert.deepEqual(preferUncooled(entries, f.usage).map(e => e.id), ['c']);
  a.add('c'); a.markUsed(entries[2]);
  const free = () => entries.filter(e => !registry.has(e.id));
  assert.deepEqual(preferUncooled(free(), f.usage).map(e => e.id), ['a','b']);
  b.add('a'); b.markUsed(entries[0]);
  assert.throws(() => a.add('a'), { code: 'PROXY_POOL_BUSY' });
  assert.deepEqual(preferUncooled(free(), f.usage).map(e => e.id), ['b']);
  b.delete('c'); assert.equal(registry.has('c'), true);
  b.clear(); assert.equal(registry.has('c'), true); assert.equal(f.usage.isCooling('a'), true);
  a.clear(); assert.equal(registry.size, 0); assert.equal(f.usage.isCooling('c'), true);
});

test('random region selection prefers pools with ready connections but permits all-cooling pools', t => {
  const f = fixture(t), claims = new Map();
  const catalog = { dynamic: { countryPools: ['CL','JP'].map((countryCode,i) => ({ countryCode, total: 1, entries: [{ id: String(i) }] })) } };
  f.usage.begin({ id: '0', sessionMinutes: 10 }); f.usage.release('0');
  assert.equal(defaultOAuthAssignments(1,catalog,{claims,usage:f.usage,random:()=>0})[0].countryCode,'JP');
  f.usage.begin({ id: '1', sessionMinutes: 10 }); f.usage.release('1');
  assert.deepEqual([0,.99].map(n=>defaultOAuthAssignments(1,catalog,{claims,usage:f.usage,random:()=>n})[0].countryCode),['CL','JP']);
  claims.set('0','running');
  assert.equal(defaultOAuthAssignments(1,catalog,{claims,usage:f.usage,random:()=>0})[0].countryCode,'JP');
});

test('rebind shares registration occupancy and cooling state, including simultaneous fallback probes', async t => {
  const f=fixture(t), registry=new Map();
  const entries=['one','two','three'].map(name=>({url:`http://${name}.example.test:9000`,id:stableProxyId(`http://${name}.example.test:9000`),sessionMinutes:10}));
  for(const entry of entries){f.usage.begin(entry);f.usage.release(entry.id);}
  const register=new ProxyClaims(registry,'register',f.usage);register.add(entries[0].id);
  const pending=[], calls=[];
  const pool=createRebindProxyPool([{workerSlot:1,kind:'countryPool',countryCode:'JP'}],{dynamic:{countryPools:[{countryCode:'JP',entries}]}},{
    claims:registry,usage:f.usage,random:()=>0,executor:async(_req,options)=>{calls.push(options.proxy);return new Promise(resolve=>pending.push(()=>resolve({response:{status:200}})));},
  });
  const first=pool.acquire(1), second=pool.acquire(2);
  assert.equal(new Set(calls).size,2);assert.ok(!calls.includes(entries[0].url));
  await assert.rejects(pool.acquire(3),{code:'PROXY_POOL_BUSY'});
  pending.forEach(done=>done()); await Promise.all([first,second]);
  pool.release(1);pool.release(2);
  assert.equal(registry.size,1);assert.equal(registry.has(entries[0].id),true);
  assert.equal(f.usage.isCooling(entries[1].id),true);
});
