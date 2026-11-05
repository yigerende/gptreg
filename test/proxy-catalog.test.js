'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildProxyApiUrl,
  normalizeB2ProxyApiUrl,
  normalize711ApiUrl,
  normalizeProxyApiUrl,
  parseDynamicContent,
} = require('../src/proxy-catalog');
const { parseProxyLine } = require('../src/proxy-pool');
const { ConfigService } = require('../src/ui-server/config-service');
const { ProxyService } = require('../src/ui-server/proxy-service');
const { RunManager } = require('../src/ui-server/run-manager');

const GLOBAL_711 = 'http://global.rotgbapi.711proxy.com:8089/gen?zone=custom&ptype=1&count=1&proto=http&stype=text&split=%5Cr%5Cn&sessType=sticky&sessTime=180&sessAuto=1';
const B2PROXY_US = 'http://global.rrp.bestgo.work:8089/gen?zone=custom&ptype=1&region=US&count=600&proto=socks5&stype=txt&split=%5Cr%5Cn&sessType=sticky&sessTime=60&sessAuto=1';
const API_1024 = 'https://white.1024proxy.com/white/api?region=US&num=1&time=120&format=1&type=txt';
const API_CLI = 'https://api.cliproxy.io/white/api?region=US&num=1&time=15&format=n&type=txt';

function workspace(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-proxy-catalog-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const config = {
    schemaVersion: 2,
    mail: { count: 1 },
    aliases: { strategy: 'root', count: 1, maxAttempts: 1, plusAddressingEnabled: false },
    sms: { provider: 'mock', maxPrice: 0 },
    workers: { maxConcurrency: 1 },
    registration: { exchangeToken: true },
    proxyPool: {
      path: 'proxy-pool.txt',
      catalogPath: 'dynamic-proxy-pools.json',
      defaultProtocol: 'http',
      required: true,
      healthCheck: { enabled: true },
    },
    output: { stateDir: '.state', cpaDir: '.state/output' },
  };
  fs.writeFileSync(path.join(cwd, 'gpt-re.config.json'), `${JSON.stringify(config, null, 2)}\n`);
  fs.writeFileSync(path.join(cwd, 'proxy-pool.txt'), '# empty\n');
  return { cwd, configService: new ConfigService({ cwd }) };
}

test('711 URL normalization controls country, count, protocol, and strict 180-minute stickiness', () => {
  const normalized = normalize711ApiUrl(GLOBAL_711, { countryCode: 'us', count: 37, protocol: 'socks5' });
  const url = new URL(normalized.url);
  assert.equal(url.searchParams.get('region'), 'US');
  assert.equal(url.searchParams.get('count'), '37');
  assert.equal(url.searchParams.get('proto'), 'socks5');
  assert.equal(url.searchParams.get('stype'), 'text');
  assert.equal(url.searchParams.get('split'), '\\r\\n');
  assert.equal(url.searchParams.get('sessType'), 'sticky');
  assert.equal(url.searchParams.get('sessTime'), '180');
  assert.equal(url.searchParams.get('sessAuto'), '0');

  const global = new URL(normalize711ApiUrl(normalized.url, { countryCode: 'GLOBAL' }).url);
  assert.equal(global.searchParams.has('region'), false);

  assert.throws(
    () => normalize711ApiUrl(GLOBAL_711.replace(':8089/', ':8090/')),
    /Only 711Proxy rotating GB API URLs are supported/,
  );
  assert.throws(
    () => normalize711ApiUrl(GLOBAL_711.replace(':8089', '')),
    /Only 711Proxy rotating GB API URLs are supported/,
  );
  assert.throws(
    () => normalize711ApiUrl(GLOBAL_711, { count: 901 }),
    /711Proxy count must be an integer between 1 and 900/,
  );

  const invalidImport = parseDynamicContent(GLOBAL_711.replace(':8089/', ':8090/'));
  assert.equal(invalidImport.items.length, 0);
  assert.match(invalidImport.errors[0].message, /Only 711Proxy rotating GB API URLs are supported/);
});

test('mixed dynamic imports merge explicit regions and place unknown proxies in GLOBAL', () => {
  const parsed = parseDynamicContent([
    GLOBAL_711,
    'gateway.example:8080:user-zone-custom-region-CL-session-demo:password',
    'plain.example:8081:user:password',
  ].join('\n'));
  assert.equal(parsed.errors.length, 0);
  assert.deepEqual(parsed.items.map((item) => [item.kind, item.countryCode]), [
    ['api', 'GLOBAL'],
    ['proxy', 'CL'],
    ['proxy', 'GLOBAL'],
  ]);
});

test('B2Proxy supports every ISO country while preserving its 60-minute SOCKS5 contract', () => {
  const normalized = normalizeB2ProxyApiUrl(B2PROXY_US, { countryCode: 'jp', count: 900 });
  const url = new URL(normalized.url);
  assert.equal(normalized.provider, 'b2proxy');
  assert.equal(normalized.countryCode, 'JP');
  assert.equal(normalized.count, 900);
  assert.equal(normalized.protocol, 'socks5');
  assert.equal(normalized.sessionMinutes, 60);
  assert.equal(url.hostname, 'global.rrp.bestgo.work');
  assert.equal(url.port, '8089');
  assert.equal(url.pathname, '/gen');
  assert.equal(url.searchParams.get('region'), 'JP');
  assert.equal(url.searchParams.get('count'), '900');
  assert.equal(url.searchParams.get('proto'), 'socks5');
  assert.equal(url.searchParams.get('stype'), 'txt');
  assert.equal(url.searchParams.get('split'), '\\r\\n');
  assert.equal(url.searchParams.get('sessType'), 'sticky');
  assert.equal(url.searchParams.get('sessTime'), '60');
  assert.equal(url.searchParams.get('sessAuto'), '1');

  const built = buildProxyApiUrl('b2proxy', { countryCode: 'us' });
  assert.equal(built.url, B2PROXY_US);
  assert.equal(built.count, 600);
  assert.equal(built.protocol, 'socks5');
  assert.throws(() => normalizeB2ProxyApiUrl(B2PROXY_US, { countryCode: 'GLOBAL' }), /requires a two-letter country code/);
  assert.throws(() => normalizeB2ProxyApiUrl(B2PROXY_US, { count: 901 }), /between 1 and 900/);
  assert.deepEqual(parseDynamicContent(B2PROXY_US).items.map((item) => [item.provider, item.countryCode, item.count, item.protocol]), [
    ['b2proxy', 'US', 600, 'socks5'],
  ]);
});

test('proxy API templates keep provider-specific contracts and default to 600 entries', () => {
  assert.equal(buildProxyApiUrl('711proxy', { countryCode: 'US' }).count, 600);
  assert.equal(new URL(buildProxyApiUrl('711proxy', { countryCode: 'US' }).url).searchParams.get('count'), '600');

  const source1024 = buildProxyApiUrl('1024proxy', { countryCode: 'ca', count: 901, protocol: 'http' });
  const url1024 = new URL(source1024.url);
  assert.equal(source1024.provider, '1024proxy');
  assert.equal(source1024.sessionMinutes, 120);
  assert.equal(url1024.searchParams.get('region'), 'CA');
  assert.equal(url1024.searchParams.get('num'), '901');
  assert.equal(url1024.searchParams.get('time'), '120');
  assert.equal(url1024.searchParams.get('format'), '1');
  assert.equal(buildProxyApiUrl('1024proxy', { countryCode: 'ca', count: 1 }).protocol, 'socks5');
  assert.equal(new URL(buildProxyApiUrl('1024proxy', { countryCode: 'ca' }).url).searchParams.get('num'), '600');

  const sourceCli = normalizeProxyApiUrl(API_CLI, { countryCode: 'gb', count: 901 });
  const urlCli = new URL(sourceCli.url);
  assert.equal(sourceCli.provider, 'cliproxy');
  assert.equal(sourceCli.sessionMinutes, 15);
  assert.equal(urlCli.searchParams.get('region'), 'GB');
  assert.equal(urlCli.searchParams.get('num'), '901');
  assert.equal(urlCli.searchParams.get('time'), '15');
  assert.equal(urlCli.searchParams.get('format'), 'n');
  assert.equal(sourceCli.protocol, 'http');
  assert.equal(new URL(buildProxyApiUrl('cliproxy', { countryCode: 'gb' }).url).searchParams.get('num'), '600');

  assert.throws(() => normalizeProxyApiUrl(API_1024, { countryCode: 'GLOBAL' }), /requires a two-letter country code/);
  assert.equal(normalizeProxyApiUrl(API_CLI, { protocol: 'http' }).protocol, 'http');
  assert.equal(normalizeProxyApiUrl(API_1024, { protocol: 'socks5' }).protocol, 'socks5');
  assert.throws(() => normalizeProxyApiUrl(API_1024, { count: 0 }), /positive safe integer/);
  assert.throws(() => normalizeProxyApiUrl(API_CLI, { count: Number.MAX_SAFE_INTEGER + 1 }), /positive safe integer/);

  const parsed = parseDynamicContent(`${API_1024}\n${API_CLI}`);
  assert.equal(parsed.errors.length, 0);
  assert.deepEqual(parsed.items.map((item) => [item.provider, item.countryCode, item.sessionMinutes, item.protocol]), [
    ['1024proxy', 'US', 120, 'socks5'],
    ['cliproxy', 'US', 15, 'http'],
  ]);
});

test('local proxy parser accepts a bare port as localhost', () => {
  assert.equal(parseProxyLine('4001').url, 'http://127.0.0.1:4001');
});

test('manual 711 pulls replace one source atomically and preserve cache after a failed refresh', async (t) => {
  const { configService } = workspace(t);
  let responseText = 'proxy-a.example:1001\r\nproxy-b.example:1002\r\n';
  let fail = false;
  const service = new ProxyService(configService, {
    fetch: async () => {
      if (fail) return { ok: false, status: 503, text: async () => '' };
      return { ok: true, status: 200, text: async () => responseText };
    },
  });
  service.import({ scope: 'dynamic', mode: 'append', content: GLOBAL_711 });
  const sourceId = service.list().dynamic.countryPools[0].sources[0].id;
  await service.pull(sourceId);
  let source = service.list().dynamic.countryPools[0].sources[0];
  assert.equal(source.cachedCount, 1, 'the configured count limits retained results');
  assert.match(source.entries[0].url, /proxy-a\.example:1001/);

  responseText = 'proxy-c.example:1003\r\n';
  await service.pull(sourceId);
  source = service.list().dynamic.countryPools[0].sources[0];
  assert.match(source.entries[0].url, /proxy-c\.example:1003/);

  fail = true;
  await assert.rejects(service.pull(sourceId), /Dynamic proxy pull failed/);
  source = service.list().dynamic.countryPools[0].sources[0];
  assert.match(source.entries[0].url, /proxy-c\.example:1003/);
  assert.match(source.lastError, /HTTP 503/);
});

test('retired country-pool entries stay excluded when the source is refreshed', async (t) => {
  const { configService } = workspace(t);
  let responseText = 'dead.example:1001\nhealthy.example:1002\n';
  const service = new ProxyService(configService, {
    fetch: async () => ({ ok: true, status: 200, text: async () => responseText }),
  });
  const sourceUrl = buildProxyApiUrl('711proxy', { countryCode: 'JP', count: 2 }).url;
  service.import({ scope: 'dynamic', mode: 'append', content: sourceUrl });
  const sourceId = service.list().dynamic.countryPools[0].sources[0].id;
  await service.pull(sourceId);
  const initial = service.list().dynamic.countryPools[0].entries;
  const dead = initial.find((entry) => entry.url.includes('dead.example'));
  assert.ok(dead);

  const retired = service.retireDynamicEntry({
    countryCode: 'JP', proxyId: dead.id, proxyUrl: dead.url, reason: 'health check failed',
  });
  assert.equal(retired.retired, true);
  assert.equal(service.list().dynamic.countryPools[0].entries.some((entry) => entry.id === dead.id), false);

  responseText = 'dead.example:1001\nhealthy.example:1002\n';
  await service.pull(sourceId);
  const refreshed = service.list().dynamic.countryPools[0];
  assert.equal(refreshed.entries.some((entry) => entry.id === dead.id), false);
  assert.equal(refreshed.entries.length, 1);
});

test('a retirement during refresh is applied after the refresh write', async (t) => {
  const { configService } = workspace(t);
  let retireOnFetch = false;
  let queuedRetirement;
  const service = new ProxyService(configService, {
    fetch: async () => {
      if (retireOnFetch) queuedRetirement = service.retireDynamicEntry({
        countryCode: 'JP', proxyUrl: 'http://dead.example:1001', reason: 'probe failed during refresh',
      });
      return { ok: true, status: 200, text: async () => 'dead.example:1001\nhealthy.example:1002\n' };
    },
  });
  const sourceUrl = buildProxyApiUrl('711proxy', { countryCode: 'JP', count: 2 }).url;
  service.import({ scope: 'dynamic', mode: 'append', content: sourceUrl });
  const sourceId = service.list().dynamic.countryPools[0].sources[0].id;
  await service.pull(sourceId);

  retireOnFetch = true;
  await service.pull(sourceId);

  assert.equal(queuedRetirement.queued, true);
  const pool = service.list().dynamic.countryPools[0];
  assert.equal(pool.entries.some((entry) => entry.url.includes('dead.example')), false);
  assert.equal(service.readCatalog().countryPools.JP.retiredEntries.length, 1);
});

test('concurrent country-pool refreshes share one upstream pull', async (t) => {
  const { configService } = workspace(t);
  const sourceUrl = buildProxyApiUrl('711proxy', { countryCode: 'JP', count: 1 }).url;
  let fetchCalls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const service = new ProxyService(configService, {
    fetch: async () => {
      fetchCalls += 1;
      await gate;
      return { ok: true, status: 200, text: async () => 'jp-proxy.example:1001\n' };
    },
  });
  service.import({ scope: 'dynamic', mode: 'append', content: sourceUrl });

  const first = service.pullAll({ allowEmpty: true, countryCodes: ['JP'] });
  await new Promise((resolve) => setImmediate(resolve));
  const second = service.pullAll({ allowEmpty: true, countryCodes: ['JP'] });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(fetchCalls, 1);
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.refresh.pulled, 1);
  assert.equal(secondResult.refresh.pulled, 1);
});

test('711 quick builder uses the fixed template and immediately fills the selected country pool', async (t) => {
  const { configService } = workspace(t);
  let requestedUrl = '';
  const service = new ProxyService(configService, {
    fetch: async (url) => {
      requestedUrl = String(url);
      return { ok: true, status: 200, text: async () => 'cl-one.example:1001\r\ncl-two.example:1002\r\n' };
    },
  });

  const snapshot = await service.buildAndPull711({ countryCode: 'cl', count: 2, protocol: 'socks5' });
  const request = new URL(requestedUrl);
  assert.equal(request.hostname, 'global.rotgbapi.711proxy.com');
  assert.equal(request.port, '8089');
  assert.equal(request.searchParams.get('region'), 'CL');
  assert.equal(request.searchParams.get('count'), '2');
  assert.equal(request.searchParams.get('proto'), 'socks5');
  assert.equal(request.searchParams.get('sessTime'), '180');
  assert.equal(request.searchParams.get('sessAuto'), '0');
  assert.equal(snapshot.dynamic.countryPools[0].countryCode, 'CL');
  assert.equal(snapshot.dynamic.countryPools[0].total, 2);
  assert.equal(snapshot.dynamic.countryPools[0].entries.every((entry) => entry.protocol === 'socks5'), true);
});

test('B2Proxy quick builder uses every selected country and its provider-specific parameters', async (t) => {
  const { configService } = workspace(t);
  let requestedUrl = '';
  const service = new ProxyService(configService, {
    fetch: async (url) => {
      requestedUrl = String(url);
      return { ok: true, status: 200, text: async () => 'b2-one.example:1001\r\n' };
    },
  });

  await service.buildAndPullApi({ provider: 'b2proxy', countryCode: 'de', protocol: 'socks5' });
  assert.equal(new URL(requestedUrl).searchParams.get('count'), '600');

  const snapshot = await service.buildAndPullApi({ provider: 'b2proxy', countryCode: 'de', count: 900, protocol: 'socks5' });
  const request = new URL(requestedUrl);
  assert.equal(request.hostname, 'global.rrp.bestgo.work');
  assert.equal(request.port, '8089');
  assert.equal(request.searchParams.get('region'), 'DE');
  assert.equal(request.searchParams.get('count'), '900');
  assert.equal(request.searchParams.get('proto'), 'socks5');
  assert.equal(request.searchParams.get('stype'), 'txt');
  assert.equal(request.searchParams.get('split'), '\\r\\n');
  assert.equal(request.searchParams.get('sessType'), 'sticky');
  assert.equal(request.searchParams.get('sessTime'), '60');
  assert.equal(request.searchParams.get('sessAuto'), '1');
  assert.equal(snapshot.dynamic.countryPools[0].countryCode, 'DE');
  assert.equal(snapshot.dynamic.countryPools[0].sources[0].provider, 'b2proxy');
  assert.equal(snapshot.dynamic.countryPools[0].entries[0].protocol, 'socks5');
});

test('1024 and CLI quick builders merge into one country pool and retain provider metadata', async (t) => {
  const { configService } = workspace(t);
  const requested = [];
  const service = new ProxyService(configService, {
    fetch: async (url) => {
      const request = new URL(String(url));
      requested.push(request);
      const body = request.hostname === 'white.1024proxy.com'
        ? 'proxy-1024.example:2001\r\n'
        : 'proxy-cli.example:2002\r\n';
      return { ok: true, status: 200, text: async () => body };
    },
  });

  await service.buildAndPullApi({ provider: '1024proxy', countryCode: 'us', count: 901, protocol: 'socks5' });
  const snapshot = await service.buildAndPullApi({ provider: 'cliproxy', countryCode: 'us', count: 901, protocol: 'socks5' });
  const pool = snapshot.dynamic.countryPools[0];
  assert.equal(pool.countryCode, 'US');
  assert.equal(pool.total, 2);
  assert.deepEqual(pool.sources.map((source) => [source.provider, source.sessionMinutes, source.cachedCount]), [
    ['1024proxy', 120, 1],
    ['cliproxy', 15, 1],
  ]);
  assert.deepEqual(requested.map((url) => [url.hostname, url.searchParams.get('region'), url.searchParams.get('num')]), [
    ['white.1024proxy.com', 'US', '901'],
    ['api.cliproxy.io', 'US', '901'],
  ]);
  assert.equal(pool.entries.every((entry) => entry.protocol === 'socks5'), true);
});

test('1024 refreshes rotate the session time from 120 down to 20 and persist the cursor', async (t) => {
  const { configService } = workspace(t);
  const requested = [];
  let sequence = 0;
  const service = new ProxyService(configService, {
    fetch: async (url) => {
      requested.push(new URL(String(url)));
      sequence += 1;
      return { ok: true, status: 200, text: async () => `proxy-${sequence}.example:200${sequence}\n` };
    },
  });

  const first = await service.buildAndPullApi({ provider: '1024proxy', countryCode: 'vn', count: 1, protocol: 'http' });
  const sourceId = first.dynamic.countryPools[0].sources[0].id;
  assert.equal(requested[0].searchParams.get('time'), '120');
  assert.equal(first.dynamic.countryPools[0].sources[0].nextPullTime, 119);

  const restartedService = new ProxyService(configService, {
    fetch: async (url) => {
      requested.push(new URL(String(url)));
      sequence += 1;
      return { ok: true, status: 200, text: async () => `proxy-${sequence}.example:200${sequence}\n` };
    },
  });
  const second = await restartedService.pull(sourceId);
  assert.equal(requested[1].searchParams.get('time'), '119');
  assert.equal(second.dynamic.countryPools[0].sources[0].nextPullTime, 118);

  const catalog = restartedService.readCatalog();
  catalog.countryPools.VN.sources[0].nextPullTime = 20;
  restartedService.writeCatalog(catalog);
  const wrapped = await restartedService.pull(sourceId);
  assert.equal(requested[2].searchParams.get('time'), '20');
  assert.equal(wrapped.dynamic.countryPools[0].sources[0].nextPullTime, 120);
});

test('changing a host-only API source protocol replaces stale cached entries instead of duplicating the source', async (t) => {
  const { configService } = workspace(t);
  const service = new ProxyService(configService, {
    fetch: async () => ({ ok: true, status: 200, text: async () => 'proxy-regional.example:2001\r\n' }),
  });

  await service.buildAndPullApi({ provider: '1024proxy', countryCode: 'US', count: 1, protocol: 'http' });
  const snapshot = await service.buildAndPullApi({ provider: '1024proxy', countryCode: 'US', count: 1, protocol: 'socks5' });
  const pool = snapshot.dynamic.countryPools[0];

  assert.equal(pool.sources.length, 1);
  assert.equal(pool.sources[0].protocol, 'socks5');
  assert.equal(pool.sources[0].cachedCount, 1);
  assert.equal(pool.entries[0].protocol, 'socks5');
});

test('proxy API pulls use the configured whitelist egress proxy', async (t) => {
  const { configService } = workspace(t);
  configService.update({ config: { proxyPool: { apiRequestProxy: 'http://127.0.0.1:10808' } } });
  let executorOptions = null;
  const service = new ProxyService(configService, {
    fetch: async () => { throw new Error('direct fetch must not be used'); },
    executor: async (_request, options) => {
      executorOptions = options;
      return { response: { status: 200, text: 'proxy-via-whitelist.example:2003\r\n' } };
    },
  });
  service.import({ scope: 'dynamic', mode: 'append', content: API_1024 });
  const sourceId = service.list().dynamic.countryPools[0].sources[0].id;
  const snapshot = await service.pull(sourceId);

  assert.equal(executorOptions.proxy, 'http://127.0.0.1:10808');
  assert.equal(executorOptions.name, 'proxy_api_source_pull');
  assert.equal(snapshot.dynamic.countryPools[0].sources[0].cachedCount, 1);
});

test('run snapshots bind fixed local endpoints and country pools to Worker slots', (t) => {
  const { cwd, configService } = workspace(t);
  const service = new ProxyService(configService);
  service.import({ scope: 'local', mode: 'replace', content: '4001\n4002' });
  service.import({
    scope: 'dynamic',
    mode: 'append',
    content: 'cl-proxy-a.example:8080:user:pass\ncl-proxy-b.example:8081:user:pass',
    overrides: [
      { line: 1, countryCode: 'CL', protocol: 'http' },
      { line: 2, countryCode: 'CL', protocol: 'http' },
    ],
  });
  const resources = service.list();
  const manager = new RunManager({
    cwd,
    configService,
    proxyService: service,
    logStore: { append() {} },
  });
  const snapshot = manager.proxySnapshot({
    schemaVersion: 2,
    workerConcurrency: 2,
    proxyAssignments: [
      { workerSlot: 1, kind: 'local', localProxyId: resources.local.proxies[0].id },
      { workerSlot: 2, kind: 'countryPool', countryCode: 'CL' },
    ],
  });
  assert.equal(snapshot.entries.filter((entry) => entry.workerSlots.includes(1)).length, 1);
  assert.equal(snapshot.entries.filter((entry) => entry.workerSlots.includes(2)).length, 2);
  assert.equal(snapshot.entries.find((entry) => entry.workerSlots.includes(1)).resourceKind, 'local');
  assert.equal(snapshot.entries.filter((entry) => entry.workerSlots.includes(2)).every((entry) => entry.countryCode === 'CL'), true);

  assert.throws(() => manager.proxySnapshot({
    schemaVersion: 2,
    workerConcurrency: 3,
    proxyAssignments: [
      { workerSlot: 1, kind: 'countryPool', countryCode: 'CL' },
      { workerSlot: 2, kind: 'countryPool', countryCode: 'CL' },
      { workerSlot: 3, kind: 'countryPool', countryCode: 'CL' },
    ],
  }), /has 2 unreserved proxies for 3 Workers/);
});

test('legacy OAuth plans get a shared maintenance snapshot without a pool', (t) => {
  const { cwd, configService } = workspace(t);
  const manager = new RunManager({
    cwd,
    configService,
    proxyService: new ProxyService(configService),
    logStore: { append() {} },
  });
  const plan = {
    schemaVersion: 1,
    taskKind: 'oauth',
    workerConcurrency: 2,
    oauthSource: { kind: 'session_assets', assetIds: ['one', 'two'] },
  };

  const snapshot = manager.proxySnapshot(plan);
  assert.deepEqual(snapshot.entries, [{
    id: snapshot.entries[0].id,
    url: 'http://127.0.0.1:7890',
    protocol: 'http',
    workerSlots: [1, 2],
    resourceKind: 'maintenance',
    countryCode: '',
  }]);
  assert.deepEqual(manager.proxyEntriesForState({ taskKind: 'oauth', runPlan: plan }, configService.normalized()), snapshot.entries);
});

test('fixed local assignments reserve duplicate endpoints ahead of country pools', (t) => {
  const { cwd, configService } = workspace(t);
  const service = new ProxyService(configService);
  service.import({ scope: 'local', mode: 'replace', content: '4001' });
  service.import({
    scope: 'dynamic',
    mode: 'append',
    content: '127.0.0.1:4001\ncl-proxy.example:8080:user:pass',
    overrides: [
      { line: 1, countryCode: 'CL', protocol: 'http' },
      { line: 2, countryCode: 'CL', protocol: 'http' },
    ],
  });
  const resources = service.list();
  const localId = resources.local.proxies[0].id;
  const manager = new RunManager({
    cwd,
    configService,
    proxyService: service,
    logStore: { append() {} },
  });
  const snapshot = manager.proxySnapshot({
    schemaVersion: 2,
    workerConcurrency: 2,
    proxyAssignments: [
      { workerSlot: 1, kind: 'local', localProxyId: localId },
      { workerSlot: 2, kind: 'countryPool', countryCode: 'CL' },
    ],
  });

  assert.deepEqual(snapshot.entries.find((entry) => entry.id === localId).workerSlots, [1]);
  assert.equal(snapshot.entries.filter((entry) => entry.workerSlots.includes(2)).length, 1);
});
