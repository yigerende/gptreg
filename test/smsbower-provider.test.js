'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  SmsBowerError,
  SmsBowerProvider,
  classifySmsBowerError,
  createSmsProvider,
  normalizePhoneNumber,
  parseRetryAfterMs,
} = require('../src/sms-provider');

function response(body, status = 200, headers = {}) {
  return {
    status,
    headers: {
      get(name) {
        const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
        return key ? headers[key] : null;
      },
    },
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
  };
}

test('SMSBower preflight resolves named selectors and obtains USD prices', async () => {
  const calls = [];
  const provider = new SmsBowerProvider({
    apiKey: 'unit-key',
    baseUrl: 'https://sms.example.test/stubs/handler_api.php',
    country: { name: 'Chile' },
    service: { name: 'OpenAI' },
    maxPrice: 0.03,
    fetch: async (url) => {
      const query = new URL(url).searchParams;
      const action = query.get('action');
      calls.push({ action, query });
      if (action === 'getBalance') return response('ACCESS_BALANCE:2.75');
      if (action === 'getCountries') return response({ 151: { eng: 'Chile' } });
      if (action === 'getServicesList') return response([{ service: 'dr', name: 'OpenAI' }]);
      if (action === 'getPricesV3') return response({ status: 'success', data: [{ country: 151, service: 'dr', price: 0.02, count: 4 }] });
      throw new Error(`Unexpected action: ${action}`);
    },
  });

  const result = await provider.preflight();

  assert.equal(result.ready, true);
  assert.equal(result.balance, 2.75);
  assert.equal(result.country.id, '151');
  assert.equal(result.service.code, 'dr');
  assert.equal(result.maxPrice, 0.03);
  assert.equal(result.prices[0].price, 0.02);
  assert.equal(calls.find((call) => call.action === 'getServicesList').query.get('country'), '151');
  assert.equal(calls.find((call) => call.action === 'getPricesV3').query.get('service'), 'dr');
});

test('SMSBower preflight reads every selected country and marks prices above the shared cap', async () => {
  const calls = [];
  const provider = new SmsBowerProvider({
    apiKey: 'unit-key',
    countries: [151, 6, 43],
    service: 'dr',
    maxPrice: 0.03,
    fetch: async (url) => {
      const query = new URL(url).searchParams;
      const action = query.get('action');
      const country = query.get('country');
      calls.push({ action, country });
      if (action === 'getBalance') return response('ACCESS_BALANCE:2.75');
      if (action === 'getCountries') return response({
        151: { eng: 'Chile' },
        6: { eng: 'Indonesia' },
        43: { eng: 'Germany' },
      });
      if (action === 'getServicesList') return response([{ service: 'dr', name: 'OpenAI' }]);
      if (action === 'getPricesV3') {
        const price = { 151: 0.02, 6: 0.04, 43: 0.025 }[country];
        return response({ status: 'success', data: [{ country, service: 'dr', price, count: 4 }] });
      }
      throw new Error(`Unexpected action: ${action}`);
    },
  });

  const result = await provider.preflight();

  assert.deepEqual(result.countries.map((market) => [market.country.id, market.cheapestPrice, market.eligible]), [
    ['151', 0.02, true],
    ['6', 0.04, false],
    ['43', 0.025, true],
  ]);
  assert.deepEqual(calls.filter((call) => call.action === 'getServicesList').map((call) => call.country), ['151', '6', '43']);
  assert.deepEqual(calls.filter((call) => call.action === 'getPricesV3').map((call) => call.country), ['151', '6', '43']);
});

test('SMSBower picks a random eligible country and passes that country plus the global cap to getNumberV2', async () => {
  const calls = [];
  const provider = new SmsBowerProvider({
    apiKey: 'unit-key',
    countries: [151, 6],
    service: 'dr',
    maxPrice: 0.03,
    random: () => 0,
    fetch: async (url) => {
      const query = new URL(url).searchParams;
      const action = query.get('action');
      calls.push({ action, query });
      if (action === 'getBalance') return response('ACCESS_BALANCE:2.75');
      if (action === 'getCountries') return response({ 151: { eng: 'Chile' }, 6: { eng: 'Indonesia' } });
      if (action === 'getServicesList') return response([{ service: 'dr', name: 'OpenAI' }]);
      if (action === 'getPricesV3') return response({ status: 'success', data: [{ price: 0.02, count: 4 }] });
      if (action === 'getNumberV2') {
        assert.equal(query.get('country'), '6');
        assert.equal(query.get('maxPrice'), '0.03');
        return response({ activationId: 993, phoneNumber: '628123456789', countryCode: '6' });
      }
      throw new Error(`Unexpected action: ${action}`);
    },
  });

  await provider.preflight();
  const lease = await provider.acquireNumber({ countryId: '151', maxPrice: 0.03 });

  assert.equal(lease.country, '6');
  assert.equal(lease.countryCode, '62');
  assert.equal(calls.filter((call) => call.action === 'getNumberV2').length, 1);
});

test('SMSBower falls through to another selected country after NO_NUMBERS', async () => {
  const requestedCountries = [];
  const provider = new SmsBowerProvider({
    apiKey: 'unit-key',
    countries: [151, 6],
    service: 'dr',
    maxPrice: 0.03,
    random: () => 0,
    countryUnavailableCooldownMs: 60000,
    fetch: async (url) => {
      const query = new URL(url).searchParams;
      const action = query.get('action');
      if (action === 'getBalance') return response('ACCESS_BALANCE:2.75');
      if (action === 'getCountries') return response({ 151: { eng: 'Chile' }, 6: { eng: 'Indonesia' } });
      if (action === 'getServicesList') return response([{ service: 'dr', name: 'OpenAI' }]);
      if (action === 'getPricesV3') return response({ status: 'success', data: [{ price: 0.02, count: 4 }] });
      if (action === 'getNumberV2') {
        requestedCountries.push(query.get('country'));
        if (query.get('country') === '6') return response('NO_NUMBERS');
        return response({ activationId: 994, phoneNumber: '56912345678', countryCode: '151' });
      }
      throw new Error(`Unexpected action: ${action}`);
    },
  });

  await provider.preflight();
  const lease = await provider.acquireNumber();

  assert.deepEqual(requestedCountries, ['6', '151']);
  assert.equal(lease.country, '151');
});

test('SMSBower preflight retries transient read failures without retrying mutations', async () => {
  const attempts = new Map();
  const delays = [];
  const provider = new SmsBowerProvider({
    apiKey: 'unit-key',
    country: 151,
    service: 'dr',
    maxPrice: 0.03,
    preflightRetryDelayMs: 10,
    sleep: async (milliseconds) => delays.push(milliseconds),
    fetch: async (url) => {
      const action = new URL(url).searchParams.get('action');
      attempts.set(action, (attempts.get(action) || 0) + 1);
      if (action === 'getBalance' && attempts.get(action) < 3) throw new TypeError('fetch failed');
      if (action === 'getBalance') return response('ACCESS_BALANCE:2.75');
      if (action === 'getCountries') return response({ 151: { eng: 'Chile' } });
      if (action === 'getServicesList') return response([{ service: 'dr', name: 'OpenAI' }]);
      if (action === 'getPricesV3') return response({ 151: { dr: { 1: { count: 4, price: 0.02 } } } });
      throw new Error(`Unexpected action: ${action}`);
    },
  });

  const result = await provider.preflight();

  assert.equal(result.balance, 2.75);
  assert.equal(attempts.get('getBalance'), 3);
  assert.deepEqual(delays, [10, 20]);
  assert.equal([...attempts.keys()].some((action) => ['getNumberV2', 'setStatus'].includes(action)), false);
});

test('SMSBower requests abort after the configured network timeout', async () => {
  const provider = new SmsBowerProvider({
    apiKey: 'unit-key',
    requestTimeoutMs: 5,
    fetch: async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  });

  await assert.rejects(provider.getBalance(), (error) => {
    assert.equal(error.code, 'NETWORK_ERROR');
    assert.match(error.message, /timed out after 1000 ms/);
    return true;
  });
});

test('SMSBower flattens provider-nested getPricesV3 responses', async () => {
  const provider = new SmsBowerProvider({
    apiKey: 'unit-key',
    country: 151,
    service: 'dr',
    fetch: async () => response({
      151: {
        dr: {
          3170: { count: 4, price: 0.02, provider_id: 3170 },
          4120: { count: 2, price: 0.03, provider_id: 4120 },
        },
      },
    }),
  });

  const prices = await provider.getPrices();
  assert.deepEqual(prices.map((item) => [item.country, item.service, item.providerId, item.price]), [
    ['151', 'dr', '3170', 0.02],
    ['151', 'dr', '4120', 0.03],
  ]);
});

test('SMSBower acquires an E.164 number and runs the official status lifecycle', async () => {
  const statusQueue = ['STATUS_WAIT_CODE', 'STATUS_OK:463193', 'STATUS_OK:463193'];
  const setStatuses = [];
  const provider = createSmsProvider({
    provider: 'smsbower',
    apiKey: 'unit-key',
    baseUrl: 'https://sms.example.test/stubs/handler_api.php',
    country: 151,
    service: 'dr',
    maxPrice: 0.03,
    pollIntervalMs: 1,
    fetch: async (url) => {
      const query = new URL(url).searchParams;
      const action = query.get('action');
      if (action === 'getNumberV2') {
        assert.equal(query.get('service'), 'dr');
        assert.equal(query.get('country'), '151');
        assert.equal(query.get('maxPrice'), '0.03');
        return response({
          activationId: 991,
          phoneNumber: '56912345678',
          activationCost: '0.025',
          countryCode: '151',
          canGetAnotherSms: 'false',
          activationOperator: 'unit-mobile',
        });
      }
      if (action === 'getStatus') {
        assert.equal(query.get('id'), '991');
        return response(statusQueue.shift());
      }
      if (action === 'setStatus') {
        setStatuses.push(Number(query.get('status')));
        return response({ 1: 'ACCESS_READY', 3: 'ACCESS_RETRY_GET', 6: 'ACCESS_ACTIVATION', 8: 'ACCESS_CANCEL' }[query.get('status')]);
      }
      throw new Error(`Unexpected action: ${action}`);
    },
  });

  const lease = await provider.acquireNumber({ service: 'openai' });
  assert.equal(lease.id, '991');
  assert.equal(lease.activationId, '991');
  assert.equal(lease.number, '+56912345678');
  assert.equal(lease.country, '151');
  assert.equal(lease.countryCode, '56');
  assert.equal(lease.providerCountryCode, '151');
  assert.equal(lease.cost, 0.025);
  assert.equal(lease.canGetAnotherSms, false);

  await provider.markSmsSent(lease);
  const pollObservations = [];
  const code = await provider.pollCode(lease, {
    timeoutMs: 100,
    pollIntervalMs: 1,
    onPoll: (observation) => pollObservations.push(observation.providerStatus),
  });
  assert.equal(code.code, '463193');
  assert.deepEqual(pollObservations, ['STATUS_WAIT_CODE', 'STATUS_OK']);
  await provider.requestAnotherCode(lease);
  await provider.complete(lease);
  assert.deepEqual(setStatuses, [1, 3, 6]);

  const serialized = JSON.parse(JSON.stringify(lease));
  const resumed = new SmsBowerProvider({
    apiKey: 'unit-key',
    country: 151,
    service: 'dr',
    leases: [serialized],
    fetch: async () => response(statusQueue.shift()),
  });
  const reconciled = await resumed.reconcile(serialized);
  assert.equal(reconciled.id, '991');
  assert.equal(reconciled.status, 'code_received');
  assert.equal(reconciled.code, '463193');
});

test('SMSBower rejects and cancels a number that does not match the selected market', async () => {
  const setStatuses = [];
  const provider = new SmsBowerProvider({
    apiKey: 'unit-key',
    country: 151,
    service: 'dr',
    fetch: async (url) => {
      const query = new URL(url).searchParams;
      if (query.get('action') === 'getNumberV2') {
        return response({ activationId: 992, phoneNumber: '15551234567', countryCode: '151' });
      }
      if (query.get('action') === 'setStatus') {
        setStatuses.push(Number(query.get('status')));
        return response('ACCESS_CANCEL');
      }
      throw new Error(`Unexpected action: ${query.get('action')}`);
    },
  });

  await assert.rejects(provider.acquireNumber(), (error) => {
    assert.equal(error.code, 'INVALID_PHONE_COUNTRY_FORMAT');
    assert.equal(error.category, 'availability');
    assert.equal(error.retryable, true);
    assert.equal(error.activationId, '992');
    assert.equal(error.cleanupStatus, 'ACCESS_CANCEL');
    assert.equal(error.invalidLease.status, 'cancelled');
    assert.equal(error.invalidLease.country, '151');
    assert.equal(error.invalidLease.countryCode, '56');
    assert.equal(error.invalidLease.providerCountryCode, '151');
    return true;
  });
  assert.deepEqual(setStatuses, [8]);
});

test('SMSBower cancellation exposes EARLY_CANCEL_DENIED as retryable lifecycle state', async () => {
  const provider = new SmsBowerProvider({
    apiKey: 'unit-key',
    country: 151,
    service: 'dr',
    fetch: async () => response('EARLY_CANCEL_DENIED'),
  });

  await assert.rejects(
    provider.cancel({ id: '42', activationId: '42', number: '+56912345678' }),
    (error) => {
      assert.ok(error instanceof SmsBowerError);
      assert.equal(error.code, 'EARLY_CANCEL_DENIED');
      assert.equal(error.category, 'lifecycle');
      assert.equal(error.retryable, true);
      return true;
    },
  );
});

test('SMSBower preserves explicit refund metadata returned by cancellation', async () => {
  const provider = new SmsBowerProvider({
    apiKey: 'unit-key',
    country: 151,
    service: 'dr',
    fetch: async () => response({
      status: 'ACCESS_CANCEL',
      refundAmount: '0.025',
      refunded: true,
    }),
  });

  const cancelled = await provider.cancel({
    id: 'refund-activation',
    activationId: 'refund-activation',
    number: '+56912345678',
    cost: 0.025,
  });

  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.providerStatus, 'ACCESS_CANCEL');
  assert.equal(cancelled.refundAmount, '0.025');
  assert.equal(cancelled.refunded, true);
});

test('SMSBower classifies HTTP rate limits and parses Retry-After', async () => {
  const provider = new SmsBowerProvider({
    apiKey: 'unit-key',
    fetch: async () => response('slow down', 429, { 'Retry-After': '2' }),
  });

  await assert.rejects(provider.getBalance(), (error) => {
    assert.equal(error.status, 429);
    assert.equal(error.category, 'rate_limit');
    assert.equal(error.retryable, true);
    assert.equal(error.retryAfterMs, 2000);
    return true;
  });
  assert.equal(parseRetryAfterMs('1.5'), 1500);
  assert.equal(classifySmsBowerError('NO_NUMBERS').category, 'availability');
  assert.equal(classifySmsBowerError('NO_BALANCE').retryable, false);
  assert.equal(classifySmsBowerError('BAD_STATUS').category, 'lifecycle');
  assert.equal(classifySmsBowerError('BAD_STATUS').retryable, false);
});

test('phone normalization accepts international formatting and rejects invalid data', () => {
  assert.equal(normalizePhoneNumber('00 56 9 1234 5678'), '+56912345678');
  assert.equal(normalizePhoneNumber('09 1234 5678', '56'), '+56912345678');
  assert.equal(normalizePhoneNumber('9 1234 5678', '56'), '+56912345678');
  assert.throws(() => normalizePhoneNumber('123'), SmsBowerError);
});
