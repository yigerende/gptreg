'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSmsProvider } = require('../src/sms-provider');
const { validateV2Config } = require('../src/config-v2');
const { summarizeSmsPreflight } = require('../src/preflight-resources');

function fixture(extra = {}) {
  const calls = [];
  const fetch = async (input, init) => {
    const u = new URL(input); const action = u.searchParams.get('action');
    calls.push({ u, init, action });
    if (u.pathname.startsWith('/api/v1/')) return new Response(null, { status: 204 });
    const values = { getBalance: 'ACCESS_BALANCE:12.5', getCountries: { 4: { id: 4, eng: 'Philippines' }, 6: { id: 6, eng: 'Indonesia' }, 151: { id: 151, eng: 'Chile' } }, getServicesList: { services: [{ code: 'dr', name: 'OpenAI' }] }, getPrices: { [u.searchParams.get('country')]: { dr: { cost: u.searchParams.get('country') === '4' ? 0.08 : 0.04, count: 5 } } }, getNumber: 'ACCESS_NUMBER:100:628123456789', getStatus: 'STATUS_OK:123456', setStatus: 'ACCESS_READY' };
    const v = values[action]; assert.notEqual(v, undefined, action);
    return new Response(typeof v === 'string' ? v : JSON.stringify(v));
  };
  const provider = createSmsProvider({ provider: 'hero-sms', apiKey: 'hero-test-secret', service: { code: 'dr' }, countries: [{ id: 4 }, { id: 6 }], maxPrice: 0.1, random: () => 0, fetch, ...extra });
  return { provider, calls };
}

test('Hero catalog and balance testing never buys a number; only selected countries reach acquisition', async () => {
  const { provider: p, calls } = fixture();
  const preflight = await p.preflight();
  assert.equal(preflight.balance, 12.5);
  assert.equal(preflight.provider, 'hero-sms');
  assert.equal(calls.some((c) => c.action === 'getNumber'), false);
  const lease = await p.acquireNumber({ acquisitionId: 'intent-1' });
  const purchase = calls.find((c) => c.action === 'getNumber');
  assert.equal(purchase.u.searchParams.get('country'), '6');
  assert.equal(purchase.u.searchParams.get('maxPrice'), '0.04');
  assert.equal(lease.provider, 'hero-sms'); assert.equal(lease.id, '100');
  assert.equal(lease.number, '+628123456789');
  assert.equal(lease.cost, null); // Unknown actual charge is not invented from a quote.
  assert.equal((await p.pollCode(lease, { timeoutMs: 0 })).code, '123456');
  await p.complete(lease);
  const finish = calls.at(-1);
  assert.equal(finish.u.pathname, '/api/v1/activations/100/finish');
  assert.equal(finish.init.headers.Authorization, 'ApiKey hero-test-secret');
  assert.equal(finish.u.search, '');
  assert.equal((await p.reconcileAcquisition({ id: 'intent-1' })).lease.id, '100');
});

test('Hero random country selection is not a global cheapest-country sort', async () => {
  const { provider: p, calls } = fixture({ random: () => 0.99 });
  await p.preflight();
  await p.acquireNumber();
  assert.equal(calls.find((c) => c.action === 'getNumber').u.searchParams.get('country'), '4');
  assert.equal(calls.find((c) => c.action === 'getNumber').u.searchParams.get('maxPrice'), '0.08');
});

test('Hero rejects empty selection, honors the cap and never retries an uncertain purchase', async () => {
  const empty = fixture({ countries: [] });
  await assert.rejects(empty.provider.acquireNumber(), /勾选/); assert.equal(empty.calls.length, 0);
  const capped = fixture({ maxPrice: 0.01 });
  await capped.provider.preflight();
  await assert.rejects(capped.provider.acquireNumber(), (e) => e.code === 'NO_NUMBERS');
  assert.equal(capped.calls.some((c) => c.action === 'getNumber'), false);
  const { provider: p } = fixture(); await p.preflight(); let count = 0;
  p.fetch = async () => { count++; throw new Error('timeout hero-test-secret'); };
  await assert.rejects(p.acquireNumber(), (e) => e.code === 'NETWORK_ERROR' && !e.message.includes('hero-test-secret'));
  assert.equal(count, 1); assert.equal((await p.reconcileAcquisition({ id: 'unknown' })).status, 'uncertain');
});

test('Hero lifecycle requires 204 and preserves a pending cancellation until the provider accepts it', async () => {
  const { provider: p } = fixture();
  const lease = { id: '9', status: 'leased', number: '+639123456789' };
  p.fetch = async () => new Response('EARLY_CANCEL_DENIED', { status: 400 });
  await assert.rejects(p.cancel(lease), (e) => e.code === 'EARLY_CANCEL_DENIED' && e.retryable);
  assert.equal(lease.status, 'leased');
  p.fetch = async () => new Response('not confirmation', { status: 200 });
  await assert.rejects(p.complete(lease), /未获确认/);
  p.fetch = async () => new Response(null, { status: 204 });
  assert.equal((await p.cancel(lease)).status, 'cancelled');
});

test('normalizing Hero repeatedly preserves its own key and the independent SMSBower mail key', () => {
  const raw = { aliases: { strategy: 'root' }, sms: { provider: 'hero-sms', apiKey: 'bower-secret', maxPrice: 0.05, hero: { apiKey: 'hero-secret', countries: [{ id: 6 }], maxPrice: 1 } } };
  const a = validateV2Config(raw), b = validateV2Config(a);
  assert.equal(a.sms.apiKey, 'hero-secret'); assert.equal(b.sms.apiKey, 'hero-secret');
  assert.equal(a.mail.apiKey, 'bower-secret'); assert.equal(b.mail.apiKey, 'bower-secret');
  assert.deepEqual(a.sms, b.sms);
});

test('a failed market read is not presented as zero inventory', () => {
  const r = summarizeSmsPreflight({ countries: [{ country: { id: '4' }, issue: 'BAD_KEY', prices: [], eligible: false }] }, { provider: 'hero-sms', maxPrice: 1 });
  assert.equal(r.ready, false); assert.equal(r.issue, 'BAD_KEY');
});

test('Hero only falls back within selected countries on a definitive shortage and redacts authentication failures', async () => {
  const { provider: p } = fixture({ random: () => 0.99 });
  await p.preflight(); const purchases = [];
  p.fetch = async (url) => {
    const country = new URL(url).searchParams.get('country'); purchases.push(country);
    return new Response(country === '4' ? 'NO_NUMBERS' : 'ACCESS_NUMBER:2:628123456789');
  };
  assert.equal((await p.acquireNumber()).country, '6');
  assert.deepEqual(purchases, ['4', '6']);
  p.fetch = async () => new Response('BAD_KEY:hero-test-secret', { status: 403 });
  await assert.rejects(p.getBalance(), (e) => e.category === 'authentication' && !JSON.stringify(e).includes('hero-test-secret') && !e.message.includes('hero-test-secret'));
  p.fetch = async () => new Response('<html>gateway failure</html>');
  await assert.rejects(p.getPrices({ country: 6 }), (e) => e.code === 'INVALID_PRICE_RESPONSE');
});

test('Hero body timeout keeps a purchase uncertain without issuing another purchase', async () => {
  let calls = 0;
  const { provider: p } = fixture({ requestTimeoutMs: 1000, fetch: async (_url, init) => {
    calls++;
    return { status: 200, text: () => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('body timeout'), { name: 'AbortError' })), { once: true });
    }) };
  } });
  await assert.rejects(p.request('getNumberV2', { country: 6, service: 'dr', maxPrice: 0.1 }), (e) => e.code === 'NETWORK_ERROR');
  assert.equal(calls, 1);
});
