'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { defaultOAuthAssignments, assertOAuthProxySelection, ProxyClaims } = require('../src/oauth-proxies');
test('OAuth defaults match registration capacity preference and honor explicit fixed/pool selections', () => {
  const catalog = { dynamic: { countryPools: [{ countryCode: 'PH', total: 2 }, { countryCode: 'US', total: 5 }] } };
  const selected = defaultOAuthAssignments(3, catalog); assert.ok(selected.every((p) => p.countryCode === 'US'));
  assert.doesNotThrow(() => assertOAuthProxySelection({ taskKind: 'oauth', proxyAssignments: selected }));
  assert.throws(() => assertOAuthProxySelection({ taskKind: 'oauth', proxyAssignments: [{ kind: 'maintenance' }] }), /重新选择/);
  assert.doesNotThrow(() => assertOAuthProxySelection({ taskKind: 'register_session' }));
});
test('parallel registration/OAuth cannot claim or release the other task’s proxy', () => {
  const registry = new Map(); const register = new ProxyClaims(registry, 'reg'), oauth = new ProxyClaims(registry, 'oauth');
  register.add('proxy-1'); assert.equal(oauth.has('proxy-1'), true);
  assert.throws(() => oauth.add('proxy-1'), (e) => e.code === 'PROXY_POOL_BUSY');
  oauth.delete('proxy-1'); assert.equal(register.has('proxy-1'), true);
  oauth.add('proxy-2'); oauth.clear(); assert.equal(register.has('proxy-1'), true); assert.equal(registry.size, 1);
  register.clear(); assert.equal(registry.size, 0);
});

test('random country selection is uniform across eligible countries, including GLOBAL', () => {
  const pools = ['CL', 'JP', 'GLOBAL'].map((countryCode, n) => ({ countryCode, total: 10 ** n }));
  pools.unshift({ countryCode: 'PH', total: 0 });
  const catalog = { dynamic: { countryPools: pools } };
  assert.deepEqual([0, .34, .99].map(random => defaultOAuthAssignments(1, catalog, { random: () => random })[0].countryCode), ['CL', 'JP', 'GLOBAL']);
});

test('default selection skips busy pools while preserving claims and non-direct fallback', () => {
  const claims = new Map([['cl', 'other-run']]);
  const catalog = { dynamic: { countryPools: [
    { countryCode: 'CL', total: 1, entries: [{ id: 'cl' }] },
    { countryCode: 'JP', total: 1, entries: [{ id: 'jp' }] },
  ] }, local: { proxies: [{ id: 'fixed' }] } };
  assert.equal(defaultOAuthAssignments(1, catalog, { claims, random: () => 0 })[0].countryCode, 'JP');
  claims.set('jp', 'another-run');
  assert.equal(defaultOAuthAssignments(1, catalog, { claims })[0].kind, 'countryPool');
  assert.equal(claims.size, 2);
  assert.deepEqual(defaultOAuthAssignments(1, { local: catalog.local }), [{ workerSlot: 1, kind: 'local', localProxyId: 'fixed' }]);
  assert.equal(defaultOAuthAssignments(1, {})[0].countryCode, 'GLOBAL');
});
