'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RotatingProxyEgress, providerApiProxiesFromConfig } = require('../src/provider-api-egress');

const A = 'http://127.0.0.1:10808';
const B = 'http://127.0.0.1:7890';

function egressWith(behaviour, options = {}) {
  const calls = [];
  const switches = [];
  const egress = new RotatingProxyEgress({
    proxies: [A, B],
    failoverAfter: 2,
    onSwitch: (event) => switches.push(event),
    executor: async (request, opts) => {
      calls.push(opts.proxy);
      return behaviour(opts.proxy, calls.length, request);
    },
    ...options,
  });
  return { egress, calls, switches };
}

const ok = (text = '{"status":1}') => ({ response: { status: 200, text, contentType: 'application/json' } });
const timeout = (proxy) => { throw new Error(`Proxy request timed out after 10000 ms: via ${proxy}`); };

test('the vendor API stays on one forwarder while it answers', async () => {
  const { egress, calls } = egressWith(() => ok());
  for (let i = 0; i < 5; i += 1) {
    const response = await egress.fetch('https://smsbower.page/api/mail/getCode?mailId=1');
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 1 });
  }
  assert.deepEqual(calls, [A, A, A, A, A]);
});

test('two timeouts in a row move traffic to the other forwarder, and it keeps rotating', async () => {
  // 10808 throttled, then 7890 throttled too, then 10808 recovered.
  const plan = [A, A, B, B, A];
  const { egress, calls, switches } = egressWith((proxy, n) => {
    if (n <= 4) timeout(proxy);
    return ok();
  });
  for (let i = 0; i < 4; i += 1) {
    await assert.rejects(egress.fetch('https://smsbower.page/stubs/handler_api.php?action=getStatus'), /timed out/);
  }
  const response = await egress.fetch('https://smsbower.page/stubs/handler_api.php?action=getStatus');
  assert.equal(response.status, 200);
  assert.deepEqual(calls, plan);
  assert.deepEqual(switches.map(({ from, to }) => `${from}>${to}`), [`${A}>${B}`, `${B}>${A}`]);
  // A timeout is never retried here: the vendor may have acted on it.
  assert.equal(calls.length, 5);
});

test('a single timeout between successes does not switch', async () => {
  const outcomes = [true, false, true, false, true];
  const { egress, calls, switches } = egressWith((proxy, n) => (outcomes[n - 1] ? ok() : timeout(proxy)));
  for (const good of outcomes) {
    if (good) await egress.fetch('https://smsbower.page/x');
    else await assert.rejects(egress.fetch('https://smsbower.page/x'));
  }
  assert.deepEqual(calls, [A, A, A, A, A]);
  assert.equal(switches.length, 0);
});

test('a forwarder that refuses the connection is skipped and the same request retried on the other', async () => {
  const { egress, calls, switches } = egressWith((proxy) => {
    if (proxy === A) throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:10808'), { code: 'ECONNREFUSED' });
    return ok('ACCESS_BALANCE:1.5');
  });
  const response = await egress.fetch('https://smsbower.page/stubs/handler_api.php?action=getBalance');
  assert.equal(await response.text(), 'ACCESS_BALANCE:1.5');
  assert.deepEqual(calls, [A, B]);
  assert.equal(switches.length, 1);
  // And it stays on the working one afterwards.
  await egress.fetch('https://smsbower.page/x');
  assert.deepEqual(calls, [A, B, B]);
});

test('an HTTP error status is an answer from the vendor, not a forwarder failure', async () => {
  const { egress, calls, switches } = egressWith(() => ({ response: { status: 503, text: 'busy', retryAfterMs: 2000 } }));
  for (let i = 0; i < 3; i += 1) {
    const response = await egress.fetch('https://smsbower.page/x');
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('retry-after'), '2');
  }
  assert.deepEqual(calls, [A, A, A]);
  assert.equal(switches.length, 0);
});

test('with no forwarders configured the plain fetch is used', async () => {
  let direct = 0;
  const egress = new RotatingProxyEgress({
    proxies: [],
    directFetch: async () => { direct += 1; return { status: 200, text: async () => 'ok' }; },
    executor: async () => { throw new Error('must not proxy'); },
  });
  await egress.fetch('https://smsbower.page/x');
  assert.equal(direct, 1);
});

test('the default rotation is 10808 then 7890, and an explicit list wins', () => {
  assert.deepEqual(providerApiProxiesFromConfig({}), [A, B]);
  assert.deepEqual(providerApiProxiesFromConfig({ proxyPool: { apiRequestProxy: A, maintenanceProxy: B } }), [A, B]);
  assert.deepEqual(providerApiProxiesFromConfig({ proxyPool: { apiRequestProxy: A, maintenanceProxy: A } }), [A, B]);
  assert.deepEqual(providerApiProxiesFromConfig({ proxyPool: { providerApiProxies: [B] } }), [B]);
  assert.deepEqual(providerApiProxiesFromConfig({ proxyPool: { providerApiProxies: [] } }), []);
});
