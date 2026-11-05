'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { summarizeSmsPreflight } = require('../src/preflight-resources');

const MARKET = { provider: 'smsbower', ready: true, prices: [{ price: 0.047, count: 101 }, { price: 0.054, count: 2098 }] };

test('the balance has to cover every Worker holding a number at once', () => {
  // The provider debits at purchase and only credits back once a cancel
  // settles, so the fleet's peak holding is the real constraint. Checking one
  // number let six Workers start on a balance good for four.
  const six = summarizeSmsPreflight({ ...MARKET, balance: 0.233 }, { maxPrice: 0.055 }, { required: true, concurrency: 6 });
  assert.equal(six.ready, false);
  assert.equal(six.issue, 'SMS_BALANCE_LOW');
  assert.equal(six.requiredBalance, 0.33);
  assert.equal(six.shortfall, 0.097);
  assert.match(six.message, /SMS 余额/);
  assert.match(six.message, /0\.233/);
  assert.match(six.message, /0\.33/);

  // The same balance is fine for a single Worker, which is what the old rule
  // was really testing.
  const one = summarizeSmsPreflight({ ...MARKET, balance: 0.233 }, { maxPrice: 0.055 }, { required: true, concurrency: 1 });
  assert.equal(one.ready, true);
  assert.equal(one.requiredBalance, 0.055);
  assert.equal(one.shortfall, 0);
});

test('a single-Worker shortfall still says so, and no concurrency means one', () => {
  const summary = summarizeSmsPreflight({ ...MARKET, balance: 0.01 }, { maxPrice: 0.055 }, { required: true });
  assert.equal(summary.concurrency, 1);
  assert.equal(summary.ready, false);
  assert.equal(summary.shortfall, 0.045);
  assert.match(summary.message, /SMS 余额/);
});

test('an unknown balance stays non-blocking, while an uncapped market uses its live quote', () => {
  assert.equal(summarizeSmsPreflight({ ...MARKET, balance: null }, { maxPrice: 0.055 }, { concurrency: 20 }).ready, true);
  const uncapped = summarizeSmsPreflight({ ...MARKET, balance: 0.001 }, {}, { concurrency: 20 });
  assert.equal(uncapped.ready, false);
  assert.equal(uncapped.balanceBasis, 'cheapestPrice');
  assert.equal(Object.hasOwn(uncapped, 'estimatedCost'), false);
  assert.equal(uncapped.requiredBalance, 0.94);
  assert.equal(uncapped.shortfall, 0.939);
});

test('inventory problems still outrank the balance in the reported issue', () => {
  const summary = summarizeSmsPreflight({ provider: 'smsbower', ready: true, prices: [], balance: 0.001 }, { maxPrice: 0.055 }, { concurrency: 6 });
  assert.equal(summary.issue, 'SMS_INVENTORY_EMPTY');
});

test('multi-country SMS markets expose only countries inside the global price cap', () => {
  const summary = summarizeSmsPreflight({
    provider: 'smsbower',
    ready: true,
    balance: 1,
    service: { code: 'dr' },
    countries: [
      {
        country: { id: 151, name: 'Chile' },
        service: { code: 'dr' },
        prices: [{ price: 0.02, count: 4 }],
        eligible: true,
      },
      {
        country: { id: 6, name: 'Indonesia' },
        service: { code: 'dr' },
        prices: [{ price: 0.04, count: 7 }],
        eligible: false,
        issue: 'SMS_PRICE_ABOVE_MAX',
      },
    ],
  }, { provider: 'smsbower', maxPrice: 0.03 }, { concurrency: 2 });

  assert.equal(summary.ready, true);
  assert.deepEqual(summary.availableCountries, ['151']);
  assert.equal(summary.countries.find((country) => country.id === '6').eligible, false);
  assert.equal(summary.countries.find((country) => country.id === '6').cheapestPrice, 0.04);
  assert.equal(summary.offers, 2);
  assert.deepEqual(summary.lowestOffers.map((offer) => offer.country), ['151', '6']);
});

test('Firefox.fun keeps a configured CNY cap as a budget without rejecting a higher public quote', () => {
  const summary = summarizeSmsPreflight({
    provider: 'firefox',
    ready: true,
    currency: 'CNY',
    prices: [{ price: 0.3, count: 1 }],
    balance: 0.56,
  }, { provider: 'firefox', maxPrice: 0.28 }, { required: true, concurrency: 2 });

  assert.equal(summary.currency, 'CNY');
  assert.equal(summary.ready, true);
  assert.equal(summary.issue, '');
  assert.equal(summary.cheapestPrice, 0.3);
  assert.equal(summary.requiredBalance, 0.56);
});
