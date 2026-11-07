'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildProxyApiUrl, normalizeProxyCatalog, proxyApiSourceId } = require('../src/proxy-catalog');
const { ConfigService } = require('../src/ui-server/config-service');
const { ProxyService } = require('../src/ui-server/proxy-service');
const { lifetime } = require('../src/ui-server/iproyal-whitelist');
const ip = '192.0.2.10', token = 'test-whitelist-token';
function supplier() {
  const rows = [{ hash: 'manual', ip, port: 12321, type: 'http|https', configuration: '', note: 'existing manual' }];
  const calls = []; let next = 1;
  const response = (value, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(value) });
  const state = { rows, calls, status: 200, failAfter: Infinity, mutationCount: 0 };
  state.fetch = async (url, init = {}) => {
    const u = new URL(url), method = init.method || 'GET', body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method, body, headers: init.headers });
    if (u.hostname === 'api.ipify.org') { assert.equal(init.headers?.Authorization, undefined); return response({ ip }); }
    if (u.hostname !== 'resi-api.iproyal.com') return { ok: true, status: 200, text: async () => 'other.example:8080' };
    assert.equal(init.headers.Authorization, `Bearer ${token}`);
    assert.ok(!url.includes('generate-proxy-list'));
    assert.equal(body?.username, undefined); assert.equal(body?.password, undefined); assert.equal(body?.subuser_hash, undefined);
    if (state.status !== 200) return response({ secret: token }, state.status);
    if (u.pathname === '/v1/me') return response({ residential_user_hash: 'account' });
    if (u.pathname === '/v1/access/entry-nodes') return response([{ dns: 'proxy.iproyal.com', ports: [
      { name: 'http|https', port: 12321, alternative_ports: [11200,11201,11202] }, { name: 'socks5', port: 32325, alternative_ports: [51200] },
    ] }]);
    const root = '/v1/residential-users/account/whitelist-entries';
    if (u.pathname === root && method === 'GET') return response({ data: rows.map(r => ({...r})), meta: { last_page: 1 } });
    if (++state.mutationCount > state.failAfter) return response({ secret: token }, 429);
    if (u.pathname === root && method === 'POST') {
      assert.ok(!rows.some(r => r.ip === body.ip && r.port === body.port));
      const row = { ...body, hash: 'generated' + next++, type: body.port >= 30000 ? 'socks5' : 'http|https' }; rows.push(row); return response(row);
    }
    const row = rows.find(r => root + '/' + r.hash === u.pathname);
    assert.ok(row); assert.notEqual(row.hash, 'manual');
    if (method === 'PUT') { Object.assign(row, body); return response(row); }
    if (method === 'DELETE') { rows.splice(rows.indexOf(row), 1); return response(null); }
    throw new Error('Unexpected request');
  };
  return state;
}
function fixture(t, state = supplier()) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gptreg-whitelist-'));
  fs.writeFileSync(path.join(cwd, 'gpt-re.config.json'), JSON.stringify({ schemaVersion: 2, proxyPool: { catalogPath: 'catalog.json', path: 'proxy.txt' } }));
  const configService = new ConfigService({ cwd }), service = new ProxyService(configService, { fetch: state.fetch });
  t.after(async () => { await service.shutdown(); fs.rmSync(cwd, { recursive: true, force: true }); });
  service.iproyal.save(service.iproyal.prepare({ apiToken: token }));
  return { cwd, service, configService, state };
}
const pull = (service, extra = {}) => service.buildAndPullApi({ provider: 'iproyal', countryCode: 'JP', count: 2, sessionMinutes: 10, ...extra });

test('IPRoyal upgrades old generator URLs to whitelist API root with stable source IDs', () => {
  const old = { provider: 'iproyal', url: 'https://resi-api.iproyal.com/v1/access/generate-proxy-list', countryCode: 'JP' };
  const fresh = buildProxyApiUrl('iproyal', { countryCode: 'JP', apiBaseUrl: old.url });
  assert.equal(fresh.url, 'https://resi-api.iproyal.com/v1');
  assert.equal(proxyApiSourceId(old), proxyApiSourceId(fresh));
  assert.equal(lifetime(120), '2h'); assert.equal(lifetime(10), '10m'); assert.equal(lifetime(10080), '7d');
  assert.throws(() => buildProxyApiUrl('iproyal', { sessionMinutes: 10081 }), /1～10080/);
  assert.throws(() => buildProxyApiUrl('iproyal', { apiBaseUrl: 'http://resi-api.iproyal.com/v1' }), /HTTPS/);
  const catalog = normalizeProxyCatalog({ countryPools: { JP: { sources: [{ ...old, entries: [{ url: 'http://u:p@geo.iproyal.com:12321' }] }] } } });
  assert.equal(catalog.countryPools.JP.sources[0].entries.length, 0);
});

test('Token-only configuration is encrypted, legacy credentials are never sent or returned', async t => {
  const { service, cwd, state } = fixture(t);
  service.iproyal.save({ ...service.iproyal.read(), username: 'legacy-user', password: 'legacy-password', authMode: 'credentials' });
  assert.deepEqual(service.iproyal.snapshot(), { authMode: 'whitelist', whitelistIp: '', apiTokenConfigured: true });
  assert.throws(() => service.iproyal.prepare({ whitelistIp: 'bad' }), /IP 格式/);
  service.iproyal.save(service.iproyal.prepare({ apiToken: '' }));
  assert.equal(fs.readFileSync(service.iproyal.file, 'utf8').includes(token), false);
  await pull(service);
  assert.ok(fs.existsSync(path.join(cwd, '.runtime/iproyal-whitelist-owner.json')));
  const entries = service.readCatalog().countryPools.JP.sources[0].entries;
  assert.equal(entries.length, 2); assert.ok(entries.every(e => !e.url.includes('@')));
  const owned = state.rows.filter(r => r.hash !== 'manual');
  assert.ok(owned.every(r => /_country-jp_session-[a-f0-9]{8}_lifetime-10m/.test(r.configuration)));
  assert.notEqual(owned[0].configuration, owned[1].configuration);
  assert.equal(state.rows[0].configuration, '');
});

test('Capacity is shared by countries without copying a single endpoint into fake entries', async t => {
  const { service, state } = fixture(t);
  await pull(service, { count: 2 }); await pull(service, { countryCode: 'US', count: 200 });
  const us = service.readCatalog().countryPools.US.sources[0];
  assert.equal(us.entries.length, 1); assert.match(us.lastNotice, /目标 200 条，实际 1 条/);
  assert.equal(state.rows.length, 4);
  assert.equal(new Set(Object.values(service.readCatalog().countryPools).flatMap(p => p.sources.flatMap(s => s.entries.map(e => e.url)))).size, 3);
  await assert.rejects(pull(service, { countryCode: 'GB' }), /已被其他国家/);
});

test('Refreshing keeps occupied and cooling sessions; settings changes cannot rewrite them', async t => {
  const { service, state } = fixture(t); await pull(service);
  const entries = service.readCatalog().countryPools.JP.sources[0].entries;
  service.claims.set(entries[0].id, 'active-run'); service.usage.begin({ ...entries[0], sessionMinutes: 10 });
  service.usage.begin({ ...entries[1], sessionMinutes: 10 }); service.usage.release(entries[1].id);
  const before = JSON.stringify(state.rows); await pull(service);
  assert.equal(JSON.stringify(state.rows), before);
  await assert.rejects(pull(service, { sessionMinutes: 20 }), /正在使用或冷却/);
  assert.equal(JSON.stringify(state.rows), before); assert.equal(service.claims.get(entries[0].id), 'active-run');
});

test('Refresh reserves existing connections across supplier writes and reduces only owned idle ports', async t => {
  const { service, state } = fixture(t); await pull(service, { count: 3 });
  const base = state.fetch;
  service.fetch = async (url, init) => {
    if (init?.method === 'PUT') assert.ok(service.claims.size > 0);
    return base(url, init);
  };
  await pull(service, { count: 1, sessionMinutes: 120 });
  assert.equal(state.rows.length, 2); assert.equal(state.rows[0].hash, 'manual');
  assert.match(state.rows[1].configuration, /_lifetime-2h$/); assert.equal(service.claims.size, 0);
});

test('Supplier failure reports actual partial results and retry reuses owned ports after restart', async t => {
  const { service, state, configService } = fixture(t); state.failAfter = 1;
  await pull(service, { count: 3 });
  const first = service.readCatalog().countryPools.JP.sources[0];
  assert.equal(first.entries.length, 1); assert.match(first.lastNotice, /频繁/); assert.equal(service.claims.size, 0);
  state.failAfter = Infinity;
  const restarted = new ProxyService(configService, { fetch: state.fetch });
  await pull(restarted, { count: 3 }); assert.equal(state.rows.length, 4);
  assert.equal(restarted.readCatalog().countryPools.JP.sources[0].entries.length, 3);
  await restarted.shutdown();
});

test('Missing dashboard IP authorization performs no mutations; API/network failures do not leak secrets', async t => {
  const { service, state } = fixture(t); service.iproyal.save(service.iproyal.prepare({ whitelistIp: '192.0.2.99' }));
  await assert.rejects(pull(service), /先在 IPRoyal 后台/); assert.equal(state.mutationCount, 0);
  service.iproyal.save(service.iproyal.prepare({ whitelistIp: '' })); await pull(service);
  const before = service.readCatalog().countryPools.JP.sources[0].entries;
  state.status = 401; await assert.rejects(pull(service), /Token 无效/);
  assert.deepEqual(service.readCatalog().countryPools.JP.sources[0].entries, before);
  service.fetch = async () => { throw Error('network ' + token); };
  await assert.rejects(pull(service), /IPRoyal 连接失败/);
  assert.ok(!JSON.stringify(service.list()).includes(token));
});

test('SOCKS5 uses supplier SOCKS ports and provider saves leave other vendors intact', async t => {
  const { service } = fixture(t); await pull(service); await service.buildAndPullApi({ provider: '1024proxy', countryCode: 'US', count: 1 });
  const other = service.readCatalog().countryPools.US.sources[0];
  service.saveProviderSettings({ provider: 'iproyal', count: 1, protocol: 'socks5', sessionMinutes: 10 });
  await service.settingsRefreshFlight;
  assert.equal(service.settingsRefresh.status, 'success');
  assert.match(service.readCatalog().countryPools.JP.sources[0].entries[0].url, /^socks5:\/\/proxy\.iproyal\.com:32325/);
  assert.deepEqual(service.readCatalog().countryPools.US.sources[0], other);
});

test('An uncertain upstream update removes that endpoint from allocation until reconciliation', async t => {
  const { service, state } = fixture(t); await pull(service, { count: 1 });
  service.fetch = async (url, init) => {
    const response = await state.fetch(url, init);
    if (init?.method === 'PUT') throw Error('connection closed after supplier accepted');
    return response;
  };
  await assert.rejects(pull(service, { count: 1, sessionMinutes: 20 }), /IPRoyal 连接失败/);
  assert.equal(service.readCatalog().countryPools.JP.sources[0].entries.length, 0);
  assert.equal(service.claims.size, 0);
  service.fetch = state.fetch; await pull(service, { count: 1, sessionMinutes: 20 });
  assert.equal(service.readCatalog().countryPools.JP.sources[0].entries.length, 1);
  assert.equal(state.rows.length, 2);
});

test('All whitelist pages are read before reserving ports and unrelated IPs are left untouched', async t => {
  const { service, state } = fixture(t);
  service.fetch = async (url, init) => {
    const response = await state.fetch(url, init);
    if (url.includes('/whitelist-entries?') && url.includes('page=1&')) return { ok: true, status: 200, text: async () => JSON.stringify({ data: [{ hash: 'foreign', ip: '192.0.2.33', port: 11200, note: '' }], meta: { last_page: 2 } }) };
    return response;
  };
  await pull(service);
  assert.ok(state.calls.some(c => c.url.includes('page=2&')));
  assert.equal(state.rows[0].hash, 'manual'); assert.equal(state.rows.length, 3);
});
