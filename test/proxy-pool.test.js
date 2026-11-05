'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createProxyAllocator,
  createProxyHealthState,
  isProxyUsable,
  markProxyFailure,
  markProxySuccess,
  normalizeProxyUrl,
  parseProxyList,
  probeProxy,
  stableProxyId,
} = require('../src/proxy-pool');

test('proxy health records success and permanently excludes failures', () => {
  const [proxy, other] = parseProxyList('127.0.0.1:2080\n127.0.0.1:2081');
  let health = createProxyHealthState([proxy, other]);

  health = markProxySuccess(health, proxy, { latencyMs: 15, at: '2026-07-28T00:00:00.000Z' });
  assert.equal(health[proxy.id].status, 'healthy');
  assert.equal(health[proxy.id].consecutiveFailures, 0);
  assert.equal(health[proxy.id].latencyMs, 15);
  assert.equal(health[other.id].status, 'unknown');

  health = markProxyFailure(health, proxy, {
    reason: 'ECONNRESET',
    at: '2026-07-28T00:00:01.000Z',
    maxConsecutiveFailures: 1,
    cooldownMs: 60000,
  });
  assert.equal(health[proxy.id].status, 'failed');
  assert.equal(health[proxy.id].consecutiveFailures, 1);
  assert.equal(isProxyUsable(health[proxy.id], { nowMs: Date.parse('2026-07-28T00:00:10.000Z') }), false);
  assert.equal(isProxyUsable(health[proxy.id], { nowMs: Date.parse('2027-07-28T00:00:10.000Z') }), false);
  assert.equal(Object.hasOwn(health[proxy.id], 'url'), false);
});

test('allocator rotates away from unhealthy proxies', () => {
  const proxies = parseProxyList('127.0.0.1:2080\n127.0.0.1:2081');
  let health = createProxyHealthState(proxies);
  health = markProxyFailure(health, proxies[0], {
    reason: 'timeout',
    maxConsecutiveFailures: 1,
    cooldownMs: 60000,
  });
  const allocator = createProxyAllocator(proxies);
  const proxy = allocator.acquire('job-1', {
    isUsable: (entry) => isProxyUsable(health[entry.id]),
  });

  assert.equal(proxy.id, proxies[1].id);
});

test('proxy IDs are stable across normalized spelling and list order', () => {
  const first = parseProxyList('HTTP://PROXY.EXAMPLE:8080/\nproxy.example:8081');
  const second = parseProxyList('proxy.example:8081\nhttp://proxy.example:8080');

  assert.equal(normalizeProxyUrl('HTTP://PROXY.EXAMPLE:8080/'), 'http://proxy.example:8080');
  assert.equal(first[0].id, stableProxyId(first[0].url));
  assert.equal(first[0].id, second[1].id);
  assert.equal(first[1].id, second[0].id);
});

test('allocator uses injected randomness without replacement and keeps checks exclusive', () => {
  const proxies = parseProxyList('127.0.0.1:2080\n127.0.0.1:2081\n127.0.0.1:2082');
  const samples = [0.99, 0];
  const allocator = createProxyAllocator(proxies, {}, { random: () => samples.shift() ?? 0 });

  const first = allocator.acquire('job-a');
  const second = allocator.acquire('job-b');
  assert.equal(first.id, proxies[2].id);
  assert.equal(second.id, proxies[0].id);
  assert.notEqual(first.id, second.id);

  const checking = allocator.beginCheck('probe-1');
  assert.equal(checking.id, proxies[1].id);
  assert.equal(allocator.health[checking.id].status, 'checking');
  assert.equal(allocator.acquire('job-c'), null);
  allocator.cancelCheck(checking);
  assert.equal(allocator.health[checking.id].status, 'unknown');
  const checkedAgain = allocator.beginCheck('probe-2');
  assert.equal(checkedAgain.id, checking.id);
  allocator.completeCheck(checkedAgain, true, { latencyMs: 5 });
  assert.equal(allocator.acquire('job-c').id, checkedAgain.id);
  assert.equal(allocator.snapshot().counts.leased, 3);
});

test('release makes a healthy proxy reusable and rotate excludes the current proxy', () => {
  const proxies = parseProxyList('127.0.0.1:2080\n127.0.0.1:2081');
  const allocator = createProxyAllocator(proxies, {}, { order: proxies.map((proxy) => proxy.id) });

  assert.equal(allocator.acquire('job-a').id, proxies[0].id);
  const replacement = allocator.rotate('job-a');
  assert.equal(replacement.id, proxies[1].id);
  assert.equal(allocator.health[proxies[0].id].status, 'failed');
  allocator.release('job-a');
  assert.equal(allocator.health[proxies[1].id].status, 'healthy');
  assert.equal(allocator.acquire('job-b').id, proxies[1].id);
});

test('proxy probe uses injectable executor and reports latency', async () => {
  const [proxy] = parseProxyList('127.0.0.1:2080');
  const result = await probeProxy(proxy, {
    probeUrl: 'https://example.test/health',
    executor: async (request, context) => {
      assert.equal(request.url, 'https://example.test/health');
      assert.equal(context.proxy, proxy.url);
      return {
        response: {
          status: 204,
          url: request.url,
          text: '',
        },
      };
    },
  });

  assert.equal(result.status, 204);
  assert.equal(typeof result.latencyMs, 'number');
});

test('proxy probe accepts every HTTP response below 500 and rejects 5xx', async () => {
  const [proxy] = parseProxyList('127.0.0.1:2080');
  const accepted = await probeProxy(proxy, {
    executor: async () => ({ response: { status: 499, url: 'https://example.test/' } }),
  });
  assert.equal(accepted.status, 499);
  await assert.rejects(
    probeProxy(proxy, { executor: async () => ({ response: { status: 500 } }) }),
    /HTTP 500/,
  );
});
