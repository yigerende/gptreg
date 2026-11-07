'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { probeRegistrationExit, exitIp, registrationTime, proxyAddress } = require('../src/registration-network');

test('registration IP observation uses the actual leased proxy without cookies or direct fallback', async () => {
  const proxy = { url: 'socks5://fixture:password@entry.example:9000' };
  const result = await probeRegistrationExit(proxy, { now: () => '2026-11-07T00:00:00Z', executor: async (request, options) => {
    assert.equal(options.proxy, proxy.url);
    assert.equal(request.url, 'https://api.ipify.org?format=json');
    assert.deepEqual(request.cookies, {});
    assert.equal(options.cookieJar, undefined);
    assert.equal(options.timeoutMs, 8000);
    return { response: { status: 200, text: '{"ip":"203.0.113.20"}' } };
  } });
  assert.deepEqual(result, { exitIp: '203.0.113.20', exitIpCheckedAt: '2026-11-07T00:00:00Z', exitIpStatus: 'recorded' });
  assert.equal(proxyAddress(proxy), 'socks5://entry.example:9000');
});

test('bad/failed IP observations remain missing and never fall back to the proxy host', async () => {
  for (const response of [{ status: 502, text: '{"ip":"203.0.113.2"}' }, { status: 200, text: '{}' }, { status: 200, text: '{"ip":"entry.example"}' }, { status: 200, text: 'HTML' }]) {
    const result = await probeRegistrationExit({ url: 'http://192.0.2.1:8080' }, { executor: async () => ({ response }) });
    assert.equal(result.exitIp, ''); assert.equal(result.exitIpStatus, 'failed');
  }
  let calls = 0;
  const result = await probeRegistrationExit({ url: 'http://secret@entry.test:80' }, { executor: async () => { calls++; throw Error('secret'); } });
  assert.equal(calls, 1); assert.equal(result.exitIp, ''); assert.ok(!JSON.stringify(result).includes('secret'));
  assert.equal(exitIp('2001:0db8:0000::1'), '2001:db8::1');
  assert.equal(exitIp('192.0.2.1:8080'), '');
  assert.equal(registrationTime({ createdAt: 'original', updatedAt: 'later', sourceProxy: { endpoint: 'entry.test' } }), 'original');
  assert.equal(registrationTime({ createdAt: 'import-time', sourceKind: 'import' }), '');
});
