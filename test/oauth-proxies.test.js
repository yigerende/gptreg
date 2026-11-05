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
