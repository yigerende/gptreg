'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ProxyInventory } = require('../src/ui-server/proxy-inventory');
const { parseProxyLine, stableProxyId } = require('../src/proxy-pool');
function fixture(count = 125) {
  const entries = Array.from({ length: count }, (_, i) => { const entry = parseProxyLine(`http://user:private-password@proxy${i}.example.test:8000`); return { ...entry, id: stableProxyId(entry.url), countryCode: 'US', sourceId: 's1' }; });
  const service = { checks: new Map(), parsed: () => ({ entries: [] }), catalogSnapshot: () => ({ countryPools: { US: { countryCode: 'US', manualEntries: [], sources: [{ id: 's1', provider: '711proxy', sessionMinutes: 10, lastPulledAt: '2026-11-07T00:00:00Z', entries }] } } }), executor: async () => ({ response: { status: 200, text: '{"ip":"203.0.113.1"}' } }) };
  return { service, inventory: new ProxyInventory(service), entries };
}
test('inventory filters all cached proxies before paging and never returns credentials', () => {
  const { inventory } = fixture();
  const first = inventory.list({ limit: 50 }), next = inventory.list({ offset: 50, limit: 50 });
  assert.equal(first.total,125);assert.equal(first.items.length,50);assert.equal(next.offset,50);
  assert.equal(new Set([...first.items,...next.items].map(r=>r.id)).size,100);
  assert.ok(!JSON.stringify(first).includes('private-password'));
  assert.equal(inventory.list({q:'proxy124.'}).total,1);
  assert.equal(inventory.list({country:'JP'}).total,0);
  assert.equal(inventory.list({provider:'711proxy',protocol:'http',status:'unknown'}).total,125);
});
test('batch testing observes concurrency, real outcomes, progress and errors without secret leaks', async () => {
  const {service,inventory}=fixture(12);let active=0,peak=0,calls=0,release;
  const gate=new Promise(r=>release=r);
  service.executor=async (_req,options)=>{const index=calls++;active++;peak=Math.max(peak,active);await gate;active--;assert.equal(options.timeoutMs,15000);if(index===0)throw new Error('private-password');return {response:{status:200,text:JSON.stringify({ip:'203.0.113.1'})}}};
  const job=inventory.start({all:true,filters:{country:'US'}});assert.equal(job.status,'running');
  assert.throws(()=>inventory.start({all:true}),/正在进行/);release();await inventory.flight;
  const final=inventory.status();assert.equal(peak,4);assert.equal(final.done,12);assert.equal(final.failed,1);assert.equal(final.succeeded,11);
  assert.equal(inventory.list({status:'failed'}).total,1);assert.equal(inventory.list({q:'203.0.113.1'}).total,11);
  assert.ok(!JSON.stringify(inventory.list()).includes('private-password'));
});
test('empty selections, removed proxies and oversized batches never trigger network calls', () => {
  const {inventory}=fixture(1001);
  assert.throws(()=>inventory.start({ids:[]}),/请选择/);
  assert.throws(()=>inventory.start({ids:['missing']}),/移除/);
  assert.throws(()=>inventory.start({all:true}),/1000/);
  assert.equal(inventory.status(),null);
});

test('usage dates are sorted before pagination and occupancy overrides cooling filters', () => {
  const {service,inventory,entries}=fixture(5);
  const blank={lastUsedAt:'',releasedAt:'',cooldownUntil:'',inUse:false,cooling:false};
  const usage=new Map([
    [entries[4].id,{...blank,lastUsedAt:'2026-11-07T01:00:00.000Z',cooldownUntil:'2026-11-07T01:10:00.000Z',cooling:true}],
    [entries[2].id,{...blank,lastUsedAt:'2026-11-07T02:00:00.000Z',cooldownUntil:'2026-11-07T02:10:00.000Z',cooling:true}],
  ]);
  service.usage={get:id=>usage.get(id)||blank}; service.claims=new Map([[entries[2].id,'active-run']]);
  const first=inventory.list({limit:1}),second=inventory.list({limit:1,offset:1});
  assert.equal(first.items[0].id,entries[2].id);assert.equal(first.items[0].inUse,true);
  assert.equal(second.items[0].id,entries[4].id);
  assert.equal(inventory.list({usage:'cooling'}).total,1);
  assert.equal(inventory.list({usage:'in_use'}).total,1);
  assert.equal(inventory.list({usage:'available'}).total,3);
  assert.equal(first.summary.cooling,1);assert.equal(first.summary.inUse,1);
});
