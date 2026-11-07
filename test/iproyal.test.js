'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildProxyApiUrl, normalizeProxyCatalog, proxyApiSourceId } = require('../src/proxy-catalog');
const { ConfigService } = require('../src/ui-server/config-service');
const { ProxyService } = require('../src/ui-server/proxy-service');
const { parseIPRoyalResponse } = require('../src/ui-server/iproyal');

const token = 'test-iproyal-token-only', password = 'test:p@ss#word';
const auth = { apiToken: token, authMode: 'credentials', username: 'proxy@example.test', password };
function fixture(t, options = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gptreg-iproyal-'));
  fs.writeFileSync(path.join(cwd, 'gpt-re.config.json'), JSON.stringify({ schemaVersion: 2, proxyPool: { catalogPath: 'catalog.json', path: 'proxy.txt' } }));
  const configService = new ConfigService({ cwd });
  const service = new ProxyService(configService, options);
  t.after(async () => { await service.shutdown(); fs.rmSync(cwd, { recursive: true, force: true }); });
  return { cwd, service, configService };
}
function supplierRows(count = 2) {
  return JSON.stringify(Array.from({ length: count }, (_, i) => `geo.iproyal.com:12321:proxy@example.test:${password}_session-demo000${i}_lifetime-120m`));
}
const response = (text = supplierRows()) => ({ ok: true, status: 200, text: async () => text });

test('IPRoyal uses separate country sources and validates HTTPS and its seven-day lifetime', () => {
  const us = buildProxyApiUrl('iproyal', { countryCode: 'US', count: 200 });
  const jp = buildProxyApiUrl('iproyal', { countryCode: 'JP', count: 100, sessionMinutes: 10080, protocol: 'socks5' });
  assert.equal(us.url, 'https://resi-api.iproyal.com/v1/access/generate-proxy-list');
  assert.equal(us.sessionMinutes, 120);
  assert.equal(jp.sessionMinutes, 10080);
  assert.notEqual(proxyApiSourceId(us), proxyApiSourceId(jp));
  assert.equal(buildProxyApiUrl('iproyal').countryCode, 'GLOBAL');
  assert.throws(() => buildProxyApiUrl('iproyal', { sessionMinutes: 10081 }), /1～10080/);
  assert.throws(() => buildProxyApiUrl('iproyal', { apiBaseUrl: us.url.replace('https:', 'http:') }), /HTTPS/);
  assert.throws(() => buildProxyApiUrl('iproyal', { apiBaseUrl: us.url + '?token=bad' }), /API 地址/);
});

test('IPRoyal JSON parser preserves special credential characters and rejects malformed endpoints', () => {
  const rows = JSON.parse(supplierRows());
  const parsed = parseIPRoyalResponse(JSON.stringify([...rows, rows[0], 'geo.iproyal.com:0:u:p', 'bad', null]), 'socks5');
  assert.equal(parsed.entries.length, 2);
  assert.equal(parsed.errors.length, 3);
  assert.equal(parsed.entries[0].password, password + '_session-demo0000_lifetime-120m');
  assert.equal(parsed.entries[0].username, 'proxy@example.test');
  assert.equal(parsed.entries[0].protocol, 'socks5');
  assert.notEqual(parsed.entries[0].id, parsed.entries[1].id);
  assert.throws(() => parseIPRoyalResponse('{"error":"secret upstream body"}', 'http'), /未返回代理列表/);
  assert.throws(() => parseIPRoyalResponse('not json', 'http'), /无效的 JSON/);
});

test('IPRoyal credentials persist encrypted, POST pulls use saved auth and every save refreshes only its countries', async t => {
  const requests = [];
  const fetch = async (url, init) => { requests.push({ url, ...init }); return response(url.includes('iproyal') ? supplierRows() : 'other.example:8080'); };
  const { cwd, service, configService } = fixture(t, { fetch });
  service.saveProviderSettings({ provider: 'iproyal', count: 2, protocol: 'http', sessionMinutes: 120, iproyal: auth });
  await service.settingsRefreshFlight;
  assert.equal(requests.length, 0);
  const disk = fs.readFileSync(path.join(cwd, '.runtime/iproyal-credentials.json'), 'utf8');
  assert.ok(!disk.includes(token) && !disk.includes(password));
  for (const countryCode of ['US', 'JP']) await service.buildAndPullApi({ provider: 'iproyal', countryCode });
  assert.equal(service.list().dynamic.total, 4);
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].headers.Authorization, `Bearer ${token}`);
  assert.equal(new URL(requests[0].url).search, '');
  assert.deepEqual(JSON.parse(requests[0].body), {
    format: '{hostname}:{port}:{username}:{password}', hostname: 'geo.iproyal.com', port: 'http|https', rotation: 'sticky',
    location: '_country-us', proxy_count: 2, lifetime: '120m', username: auth.username, password,
  });
  await service.buildAndPullApi({ provider: '1024proxy', countryCode: 'US', count: 1 });
  const other = service.readCatalog().countryPools.US.sources.find(s => s.provider === '1024proxy');
  const restarted = new ProxyService(configService, { fetch });
  const saved = restarted.list().dynamic.providerSettings.iproyal.iproyal;
  assert.deepEqual(saved, { authMode: 'credentials', username: auth.username, subuserHash: '', apiTokenConfigured: true, passwordConfigured: true });
  requests.length = 0;
  restarted.saveProviderSettings({ provider: 'iproyal', count: 1, protocol: 'socks5', sessionMinutes: 10, iproyal: { apiToken: '', password: '' } });
  await restarted.settingsRefreshFlight;
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.map(r => JSON.parse(r.body).location).sort(), ['_country-jp', '_country-us']);
  assert.ok(requests.every(r => JSON.parse(r.body).password === password && JSON.parse(r.body).lifetime === '10m' && JSON.parse(r.body).port === 'socks5'));
  const catalog = restarted.readCatalog();
  assert.deepEqual(catalog.countryPools.US.sources.find(s => s.provider === '1024proxy'), other);
  assert.equal(catalog.countryPools.JP.sources.length, 1);
  assert.equal(catalog.countryPools.JP.sources[0].entries.length, 1);
  assert.equal(catalog.countryPools.JP.sources[0].entries[0].protocol, 'socks5');
  assert.equal(normalizeProxyCatalog(catalog).countryPools.JP.sources[0].sessionMinutes, 10);
  const inventory = JSON.stringify(restarted.inventory.list());
  assert.ok(!inventory.includes(password) && !inventory.includes(encodeURIComponent(password)) && !inventory.includes(token));
  await restarted.shutdown();
});

test('IPRoyal subuser auth works without proxy credentials and uses the configured API request proxy', async t => {
  let captured;
  const { service, configService } = fixture(t, { executor: async (request, options) => { captured = { request, options }; return { response: { status: 200, text: supplierRows(1) } }; }, fetch: () => { throw new Error('unexpected direct request'); } });
  const config = configService.readRaw(); config.proxyPool.apiRequestProxy = 'http://egress.example:8080';
  fs.writeFileSync(configService.filePath, JSON.stringify(config));
  await service.buildAndPullApi({ provider: 'iproyal', countryCode: 'GLOBAL', count: 1, protocol: 'http', sessionMinutes: 20, iproyal: { apiToken: token, authMode: 'subuser', subuserHash: '01JVRVH56YYVG2RZDFA123ABCD' } });
  assert.equal(captured.options.proxy, 'http://egress.example:8080');
  assert.equal(captured.request.method, 'POST');
  const body = JSON.parse(captured.request.body);
  assert.equal(body.subuser_hash, '01JVRVH56YYVG2RZDFA123ABCD');
  assert.equal(body.location, '');
  assert.equal(body.lifetime, '20m');
  assert.equal(body.username, undefined);
  assert.equal(body.password, undefined);
  assert.equal(service.iproyal.snapshot().passwordConfigured, false);
});

test('IPRoyal validation and supplier failures retain cached entries without disclosing token or response bodies', async t => {
  let mode = 'ok';
  const { service, configService } = fixture(t, { fetch: async () => {
    if (mode === 'network') throw new Error('IPRoyal network failed: ' + token + password);
    return mode === 'ok' ? response() : { ok: false, status: 401, text: async () => token + password };
  } });
  await assert.rejects(service.buildAndPullApi({ provider: 'iproyal', countryCode: 'US' }), /API Token/);
  assert.equal(fs.existsSync(configService.proxyCatalogPath()), false);
  await service.buildAndPullApi({ provider: 'iproyal', countryCode: 'US', count: 2, iproyal: auth });
  const source = service.readCatalog().countryPools.US.sources[0], before = fs.readFileSync(service.iproyal.file, 'utf8');
  assert.throws(() => service.saveProviderSettings({ provider: 'iproyal', count: 1, protocol: 'http', sessionMinutes: 10, iproyal: { authMode: 'subuser', subuserHash: '' } }), /子用户 ID/);
  assert.equal(fs.readFileSync(service.iproyal.file, 'utf8'), before);
  mode = '401';
  await assert.rejects(service.pull(source.id), /Token 无效或已过期/);
  assert.deepEqual(service.readCatalog().countryPools.US.sources[0].entries, source.entries);
  mode = 'network';
  await assert.rejects(service.pull(source.id), /IPRoyal 连接失败/);
  assert.equal(service.readCatalog().countryPools.US.sources[0].lastError, 'IPRoyal 连接失败，请检查 API 地址、网络或供应商状态');
});
