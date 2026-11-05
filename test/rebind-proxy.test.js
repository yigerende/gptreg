'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createRebindProxyPool } = require('../src/ui-server/rebind-proxy');

const plan = [{ workerSlot: 1, kind: 'countryPool', countryCode: 'JP' }];
const catalog = (...urls) => ({ dynamic: { countryPools: [{ countryCode: 'JP', entries: urls.map((url) => ({ url })) }] } });

test('country candidates reject challenges and transport failures before pinning a healthy node', async () => {
  const calls = [];
  const progress = [];
  const retired = [];
  const urls = ['http://challenge.test:8080', 'http://offline.test:8080', 'socks5://user:private@healthy.test:9000'];
  const pool = createRebindProxyPool(plan, catalog(...urls), {
    random: () => 0, healthCheck: { enabled: true, probeUrl: 'https://probe.example.test/auth', timeoutMs: 2345 },
    retireProxy: async ({ proxy }) => { retired.push(proxy.url); return { retired: true }; },
    executor: async (request, options) => {
      assert.equal(request.url, 'https://probe.example.test/auth');
      assert.equal(options.timeoutMs, 2345);
      calls.push(options.proxy);
      if (options.proxy === urls[0]) return { response: { status: 403, text: 'Just a moment - Cloudflare' } };
      if (options.proxy === urls[1]) throw new Error('ECONNRESET');
      return { response: { status: 404, text: 'reachable' } };
    },
  });
  assert.equal(await pool.acquire(1, (detail) => progress.push(detail)), urls[2]);
  assert.deepEqual(calls, urls);
  assert.equal(progress.find((entry) => entry.status === 'failed').code, 'PROXY_CLOUDFLARE_CHALLENGE');
  assert.deepEqual(retired, urls.slice(0, 2));
  assert.equal(await pool.acquire(1), urls[2]);
  assert.equal(calls.length, 3);
  assert.equal(pool.describe(1).countryCode, 'JP');
  assert.equal(pool.describe(1).endpoint, 'healthy.test:9000');
  assert.equal(JSON.stringify(pool.describe(1)).includes('private'), false);
  await assert.rejects(pool.acquire(2), { code: 'PROXY_POOL_BUSY' });
  pool.release(1);
  assert.equal(await pool.acquire(2), urls[2]);
  assert.equal(calls.length, 4, 'failed candidates stay retired for this batch');
});

test('workers reserve different candidates before awaiting probes, then release for later accounts', async () => {
  const pending = [];
  const calls = [];
  const urls = ['http://first.test:8080', 'http://second.test:8080'];
  const pool = createRebindProxyPool(plan, catalog(...urls), {
    random: () => 0,
    executor: (_request, options) => {
      calls.push(options.proxy);
      return new Promise((resolve) => pending.push(() => resolve({ response: { status: 200 } })));
    },
  });
  const first = pool.acquire(1);
  const second = pool.acquire(2);
  assert.deepEqual(calls, urls);
  assert.equal(new Set(calls).size, 2);
  await assert.rejects(pool.acquire(3), { code: 'PROXY_POOL_BUSY' });
  pending.splice(0).forEach((resolve) => resolve());
  assert.deepEqual(await Promise.all([first, second]), urls);
  pool.release(1);
  const third = pool.acquire(3);
  pending.splice(0).forEach((resolve) => resolve());
  assert.equal(await third, urls[0]);
});

test('maintenance is shared and respects the same automatic-check exemption as registration workers', async () => {
  const pool = createRebindProxyPool([], {}, { executor: async () => assert.fail('maintenance must skip automatic probes') });
  assert.equal(await pool.acquire(1), 'http://127.0.0.1:7890');
  assert.equal(await pool.acquire(2), 'http://127.0.0.1:7890');
  assert.equal(pool.describe(1).countryCode, '');
  assert.deepEqual(pool.capacity(20), { available: 20, ready: true });
});

test('disabled worker health checks skip probes while preserving the selected country', async () => {
  const pool = createRebindProxyPool(plan, catalog('http://node.test:8080'), {
    healthCheck: { enabled: false }, executor: async () => assert.fail('disabled health check'),
  });
  assert.equal(await pool.acquire(1), 'http://node.test:8080');
  assert.equal(pool.describe(1).countryCode, 'JP');
});

test('missing, ambiguous and undersized country pools cannot silently reuse or substitute a proxy', () => {
  assert.throws(() => createRebindProxyPool(plan, {}), /代理池为空/);
  const url = 'http://node.test:8080';
  assert.throws(() => createRebindProxyPool([...plan, { kind: 'countryPool', countryCode: 'US' }], {
    dynamic: { countryPools: [{ countryCode: 'JP', entries: [{ url }] }, { countryCode: 'US', entries: [{ url }] }] },
  }), /不同国家池/);
  const pool = createRebindProxyPool(plan, catalog(url));
  assert.deepEqual(pool.capacity(2), { available: 1, ready: false });
});
