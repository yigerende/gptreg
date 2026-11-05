'use strict';

function priceValue(item) {
  const value = item?.price ?? item?.cost ?? item?.activationCost;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function offerHasInventory(item) {
  const value = item?.count ?? item?.quantity ?? item?.available;
  if (value === undefined || value === null || value === '') return false;
  const count = Number(value);
  return Number.isFinite(count) && count > 0;
}

function currencyFor(config = {}, result = {}) {
  const provider = String(result.provider || config.provider || '').toLowerCase();
  return String(result.currency || (provider === 'firefox' ? 'CNY' : 'USD')).toUpperCase();
}

function summarizeOffer(item) {
  const providerId = item?.providerId ?? item?.provider_id ?? item?.operator ?? item?.provider ?? '';
  return {
    price: priceValue(item),
    count: Number(item?.count ?? item?.quantity ?? item?.available),
    providerId: providerId === undefined || providerId === null ? '' : String(providerId),
  };
}

function summarizeCountryMarket(market = {}, maxPrice = NaN) {
  const prices = Array.isArray(market.prices) ? market.prices : [];
  const availableOffers = prices.filter(offerHasInventory);
  const numericPrices = availableOffers.map(priceValue).filter((value) => value !== null);
  const cheapestPrice = numericPrices.length ? Math.min(...numericPrices) : null;
  const lowestOffers = availableOffers
    .map(summarizeOffer)
    .filter((offer) => offer.price !== null)
    .sort((left, right) => left.price - right.price || right.count - left.count || left.providerId.localeCompare(right.providerId))
    .slice(0, 3);
  const eligible = market.eligible === true
    || (market.eligible !== false && cheapestPrice !== null && (!Number.isFinite(maxPrice) || cheapestPrice <= maxPrice));
  const country = market.country || { id: market.id || '' };
  return {
    id: String(country.id ?? country.country ?? country.code ?? '').trim(),
    name: String(country.name ?? country.eng ?? country.title ?? '').trim(),
    country,
    service: market.service || null,
    cheapestPrice,
    offers: availableOffers.length,
    lowestOffers,
    eligible,
    issue: String(market.issue || (eligible ? '' : (cheapestPrice === null ? 'SMS_INVENTORY_EMPTY' : 'SMS_PRICE_ABOVE_MAX'))),
    message: String(market.message || ''),
  };
}

function skippedSmsPreflight(config, reason = 'SMS is checked only if the task reaches a phone challenge') {
  return {
    provider: config.provider,
    ready: true,
    checked: false,
    required: false,
    conditional: true,
    balance: null,
    currency: currencyFor(config),
    service: config.service,
    country: config.country,
    maxPrice: config.maxPrice,
    concurrency: null,
    requiredBalance: null,
    availableConcurrency: null,
    shortfall: 0,
    balanceBasis: 'none',
    cheapestPrice: null,
    offers: 0,
    lowestOffers: [],
    countries: [],
    availableCountries: [],
    issue: '',
    message: reason,
  };
}

function failedSmsPreflight(config, error, options = {}) {
  return {
    provider: config.provider,
    ready: false,
    checked: true,
    required: options.required !== false,
    conditional: options.required === false,
    balance: null,
    currency: currencyFor(config),
    service: config.service,
    country: config.country,
    maxPrice: config.maxPrice,
    concurrency: null,
    requiredBalance: null,
    availableConcurrency: null,
    shortfall: 0,
    balanceBasis: 'none',
    cheapestPrice: null,
    offers: 0,
    lowestOffers: [],
    countries: [],
    availableCountries: [],
    issue: String(error?.code || 'SMS_PREFLIGHT_FAILED'),
    message: String(error?.message || 'SMS preflight failed'),
  };
}

function summarizeSmsPreflight(result = {}, config = {}, options = {}) {
  const required = options.required !== false;
  const provider = String(result.provider || config.provider || '');
  const currency = currencyFor(config, result);
  const maxPrice = config.maxPrice === null || config.maxPrice === undefined || config.maxPrice === ''
    ? NaN
    : Number(config.maxPrice);
  const rawMarkets = Array.isArray(result.countries) && result.countries.length
    ? result.countries
    : [{ country: result.country || config.country, service: result.service || config.service, prices: result.prices || [] }];
  const countryMarkets = rawMarkets.map((market) => summarizeCountryMarket(market, provider === 'firefox' ? NaN : maxPrice));
  const prices = countryMarkets.map((market) => market.cheapestPrice).filter((value) => value !== null);
  const cheapestPrice = prices.length ? Math.min(...prices) : null;
  const includeOfferCountry = countryMarkets.length > 1;
  const lowestOffers = countryMarkets.flatMap((market) => market.lowestOffers.map((offer) => ({
    ...offer,
    ...(includeOfferCountry ? { country: market.id } : {}),
  })))
    .sort((left, right) => left.price - right.price || right.count - left.count || left.providerId.localeCompare(right.providerId))
    .slice(0, 3);
  const eligibleCountries = countryMarkets.filter((market) => market.eligible);
  const balance = result.balance === undefined || result.balance === null ? null : Number(result.balance);
  const mock = provider === 'mock';
  // Firefox.fun sends maxPrice to getPhone and may match a private offer. Its
  // public catalog price is informational and must not fail this check.
  const publicQuoteBound = provider !== 'firefox';
  const inventoryReady = mock || (eligibleCountries.length > 0 && (!publicQuoteBound || !Number.isFinite(maxPrice) || eligibleCountries.some((market) => market.cheapestPrice <= maxPrice)));
  const concurrency = Math.max(1, Math.trunc(Number(options.concurrency)) || 1);
  // A configured cap is the conservative reservation budget. When the cap is
  // blank, the live lowest quote is the only usable basis for the balance check.
  const budgetUnitPrice = Number.isFinite(maxPrice) ? maxPrice : cheapestPrice;
  const balanceBasis = Number.isFinite(maxPrice) ? 'maxPrice' : (cheapestPrice === null ? 'none' : 'cheapestPrice');
  const pricingLabel = balanceBasis === 'maxPrice' ? '上限单价' : '当前最低价';
  const requiredBalance = budgetUnitPrice === null ? null : Number((budgetUnitPrice * concurrency).toFixed(6));
  const balanceReady = balance === null || requiredBalance === null || balance >= requiredBalance;
  const shortfall = balanceReady || balance === null || requiredBalance === null
    ? 0
    : Number((requiredBalance - balance).toFixed(6));
  let issue = '';
  let message = '';
  const readFailure = countryMarkets.find((market) => market.issue && !['SMS_INVENTORY_EMPTY', 'SMS_PRICE_ABOVE_MAX'].includes(market.issue));
  if (result.ready === false) {
    issue = 'SMS_PROVIDER_NOT_READY';
    message = 'SMS provider reported that it is not ready';
  } else if (!mock && !eligibleCountries.length && readFailure) {
    issue = readFailure.issue;
    message = '短信报价查询失败，请检查密钥、服务项目和服务器网络';
  } else if (!mock && !countryMarkets.some((market) => market.offers > 0)) {
    issue = 'SMS_INVENTORY_EMPTY';
    message = 'No priced SMS inventory with a positive count is available';
  } else if (!mock && publicQuoteBound && Number.isFinite(maxPrice) && eligibleCountries.length === 0) {
    issue = 'SMS_PRICE_ABOVE_MAX';
    message = countryMarkets.length > 1
      ? `All selected SMS countries are above maxPrice ${maxPrice} ${currency}`
      : `SMS cheapest price ${cheapestPrice} ${currency} exceeds maxPrice ${maxPrice} ${currency}`;
  } else if (!balanceReady) {
    issue = 'SMS_BALANCE_LOW';
    message = concurrency > 1
      ? `SMS 余额 ${balance} ${currency}；${concurrency} 个 Worker 按${pricingLabel} ${budgetUnitPrice} ${currency} 同时购号需要 ${requiredBalance} ${currency}，还差 ${shortfall} ${currency}`
      : `SMS 余额 ${balance} ${currency}；单个号码按${pricingLabel} ${budgetUnitPrice} ${currency}，还差 ${shortfall} ${currency}`;
  }
  return {
    provider,
    ready: result.ready !== false && inventoryReady && balanceReady,
    checked: true,
    required,
    conditional: !required,
    balance,
    currency,
    service: result.service || config.service,
    country: result.country || config.country,
    countries: countryMarkets,
    availableCountries: eligibleCountries.map((market) => market.id),
    maxPrice: Number.isFinite(maxPrice) ? maxPrice : null,
    // What the fleet needs held at once, and how far short it is. Surfaced so
    // the console can say the number rather than only that it is too low.
    concurrency,
    requiredBalance,
    availableConcurrency: balance !== null && budgetUnitPrice > 0
      ? Math.floor((balance + Number.EPSILON) / budgetUnitPrice)
      : null,
    shortfall,
    balanceBasis,
    cheapestPrice,
    offers: countryMarkets.reduce((total, market) => total + market.offers, 0),
    lowestOffers,
    issue,
    message,
  };
}

module.exports = {
  failedSmsPreflight,
  skippedSmsPreflight,
  summarizeSmsPreflight,
};
