'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { FirefoxFunProvider } = require('../src/firefox-fun-provider');
const { createSmsProvider } = require('../src/sms-provider');

function response(body, status = 200) {
  return {
    status,
    headers: { get: () => null },
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
  };
}

test('Firefox.fun selects the configured lowest-price country and omits a blank price cap', async () => {
  const calls = [];
  const codeResponses = ['0|-3', '1|463193|OpenAI code'];
  const provider = new FirefoxFunProvider({
    token: 'unit-token',
    countries: [{ code: 'usa' }, { code: 'chl' }],
    maxPrice: '',
    pollIntervalMs: 0,
    fetch: async (url) => {
      const query = new URL(url).searchParams;
      calls.push(query);
      switch (query.get('act')) {
        case 'myInfo': return response('1|2.5000|normal|0');
        case 'getItem': return response([
          { Item_ID: '1096', Item_Name: 'OpenAI / ChatGpt', Item_UPrice: '0.65', Country_ID: 'usa', Country_Title: '+1/美国/usa' },
          { Item_ID: '1096', Item_Name: 'OpenAI / ChatGpt', Item_UPrice: '1.00', Country_ID: 'chl', Country_Title: '+56/智利/chile' },
        ]);
        case 'getPhone': return response('1|phone-key|2026-08-22 20:00:00|usa|1|New York|1|15551234567|');
        case 'getPhoneCode': return response(codeResponses.shift());
        case 'setRel': return response('1|');
        default: throw new Error(`Unexpected action ${query.get('act')}`);
      }
    },
  });

  const preflight = await provider.preflight();
  assert.equal(preflight.service.code, '1096');
  assert.equal(preflight.country.id, 'cheapest');
  assert.equal(preflight.currency, 'CNY');
  assert.equal(preflight.maxPrice, null);
  assert.equal(Object.hasOwn(provider, 'apiReturn'), false);

  const lease = await provider.acquireNumber();
  assert.equal(lease.country, 'usa');
  assert.equal(lease.currency, 'CNY');
  assert.equal(lease.number, '+15551234567');
  assert.equal(lease.pkey, 'phone-key');
  const getPhone = calls.find((query) => query.get('act') === 'getPhone');
  assert.equal(calls.some((query) => query.get('act') === 'login'), false);
  assert.equal(getPhone.get('iid'), '1096');
  assert.equal(getPhone.get('country'), 'usa');
  assert.equal(getPhone.get('dock'), '0');
  assert.equal(getPhone.get('otpmode'), 'sms');
  assert.equal(getPhone.has('maxPrice'), false);

  const code = await provider.pollCode(lease, { timeoutMs: 100, pollIntervalMs: 0 });
  assert.equal(code.code, '463193');
  await provider.complete(lease);
  assert.equal(calls.some((query) => query.get('act') === 'setAgain'), false);
});

test('Firefox.fun releases a number when no code arrives and never retries the same number', async () => {
  const actions = [];
  const provider = new FirefoxFunProvider({
    token: 'unit-token',
    countries: [{ code: 'chl' }],
    fetch: async (url) => {
      const query = new URL(url).searchParams;
      actions.push(query.get('act'));
      if (query.get('act') === 'getPhone') return response('1|phone-key|time|chl|56|Santiago|1|56912345678|');
      if (query.get('act') === 'getPhoneCode') return response('0|-3');
      if (query.get('act') === 'setRel') return response('1|');
      throw new Error(`Unexpected action ${query.get('act')}`);
    },
  });
  const lease = await provider.acquireNumber();
  const code = await provider.pollCode(lease, { timeoutMs: 0 });
  assert.equal(code, null);
  await provider.cancel(lease, 'oauth_code_timeout');
  assert.deepEqual(actions, ['getPhone', 'getPhoneCode', 'setRel']);
  await assert.rejects(provider.requestAnotherCode(lease), (error) => {
    assert.equal(error.code, 'FIREFOX_SMS_RESEND_UNSUPPORTED');
    assert.equal(error.replacePhone, true);
    return true;
  });
});

test('Firefox.fun never falls back to password login when its token is missing', async () => {
  let requestCount = 0;
  const provider = new FirefoxFunProvider({
    token: '',
    apiName: 'legacy-api-name',
    password: 'legacy-password',
    fetch: async () => {
      requestCount += 1;
      return response('1|unexpected');
    },
  });

  assert.equal(provider.credentialsReady, false);
  await assert.rejects(provider.accountInfo(), (error) => {
    assert.equal(error.code, 'FIREFOX_CREDENTIALS_MISSING');
    return true;
  });
  assert.equal(requestCount, 0);
});

test('Firefox.fun cools down a rate-limited balance read and shares concurrent calls', async () => {
  let myInfoCalls = 0;
  const provider = new FirefoxFunProvider({
    token: 'unit-token-rate-limit-cache',
    fetch: async (url) => {
      const query = new URL(url).searchParams;
      assert.equal(query.get('act'), 'myInfo');
      myInfoCalls += 1;
      return response('0|-3');
    },
  });

  const results = await Promise.allSettled([
    provider.accountInfo(),
    provider.accountInfo(),
  ]);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 2);
  assert.equal(myInfoCalls, 1, 'concurrent balance reads must be single-flight');

  await assert.rejects(provider.accountInfo(), (error) => {
    assert.equal(error.code, 'FIREFOX_RATE_LIMIT');
    assert.equal(error.retryAfterMs, 60_000);
    return true;
  });
  assert.equal(myInfoCalls, 1, 'the cooldown must suppress another provider request');
});

test('createSmsProvider constructs the Firefox.fun provider from its nested settings', () => {
  const provider = createSmsProvider({
    provider: 'firefox',
    firefox: {
      maxPrice: '',
      countries: [{ code: 'usa' }, { code: 'chl' }],
    },
  });
  assert.equal(provider.name, 'firefox');
  assert.equal(provider.service, '1096');
  assert.equal(provider.maxPrice, null);
  assert.equal(Object.hasOwn(provider, 'apiReturn'), false);
  assert.equal(provider.countries.length, 2);
});
