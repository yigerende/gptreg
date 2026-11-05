'use strict';

/**
 * How a registration country becomes one external extraction job.
 *
 * The engine takes three independent country axes, and conflating them is the
 * easy mistake — they are validated against three different tables:
 *
 *   checkoutCountry    which proxy pool the checkout exit is drawn from
 *                      (`PROXY_REGIONS`, 78 source regions)
 *   billingCountry     the billing profile: currency, locale, timezone
 *                      (`BILLING_COUNTRIES`, 16 profiles)
 *   updateProxyCountry the proxy pool for the update hop, required whenever
 *                      `applyCheckoutUpdate` is on (`PROXY_REGIONS`)
 *
 * PayPal takes all three. The single-country providers pin their own pool
 * country and pass it as `country`, which the engine uses for both the pool and
 * the profile — but they still need an update region unless the update hop is
 * explicitly turned off, because the binding runs before the provider expands.
 */

/** Registration country -> extraction provider. Anything unlisted is PayPal. */
const PROVIDER_BY_COUNTRY = Object.freeze({
  IN: 'upi',
  VN: 'momo',
  ID: 'gopay',
});

const DEFAULT_PROVIDER = 'paypal';

/** Proxy source regions the engine can draw a pool from. */
const PROXY_REGIONS = Object.freeze([
  'US', 'CA', 'MX', 'BR', 'AR', 'CL', 'CO', 'PE', 'UY', 'PY', 'BO', 'EC', 'PA', 'CR', 'GT', 'DO',
  'GB', 'IE', 'FR', 'DE', 'NL', 'BE', 'ES', 'PT', 'IT', 'CH', 'AT', 'SE', 'NO', 'DK', 'FI', 'PL',
  'CZ', 'RO', 'UA', 'TR', 'GR', 'HU', 'BG', 'HR', 'RS', 'SK', 'SI', 'LT', 'LV', 'EE', 'LU', 'IS',
  'IL', 'AE', 'SA', 'BH', 'QA', 'KW', 'OM', 'JO', 'IN', 'PK', 'BD', 'LK', 'KZ', 'ID', 'TH', 'VN',
  'PH', 'MY', 'SG', 'HK', 'TW', 'JP', 'KR', 'AU', 'NZ', 'ZA', 'EG', 'MA', 'NG', 'KE',
]);

/** Billing profiles the checkout accepts — currency, locale and timezone. */
const BILLING_COUNTRIES = Object.freeze([
  'GB', 'US', 'BR', 'DE', 'TH', 'BA', 'PH', 'ID', 'IN', 'NL', 'AE', 'DK', 'JP', 'ES', 'FI', 'FR',
]);

const EXTRACTION_PROVIDERS = Object.freeze({
  paypal: Object.freeze({ id: 'paypal', label: 'PayPal', fixedCountry: '', needsUpdate: true, updateCountry: '', payment: 'paypal' }),
  // UPI's update hop is the promotion pool. The engine's own comments still
  // describe it as a Vietnam exit and its error text still says "VN 促销代理池",
  // but it never validates the country — it uses whatever pool it is handed —
  // and the operator runs this hop out of India.
  upi: Object.freeze({ id: 'upi', label: 'UPI', fixedCountry: 'IN', needsUpdate: true, updateCountry: 'IN', payment: '' }),
  gopay: Object.freeze({ id: 'gopay', label: 'GoPay', fixedCountry: 'ID', needsUpdate: true, updateCountry: 'ID', payment: '' }),
  // MoMo derives every hop from one VN seed; the update pool is not part of it.
  momo: Object.freeze({ id: 'momo', label: 'MoMo', fixedCountry: 'VN', needsUpdate: false, updateCountry: '', payment: '' }),
});

function normalizedCode(value) {
  return String(value == null ? '' : value).trim().toUpperCase();
}

/**
 * The engine's own pool identifier.
 *
 * `ProxyPoolService.resolve` refuses a job whose options do not name the pool
 * it is allowed to draw from — an empty id is rejected before the pool is even
 * looked up, which is why a freshly stocked pool does not help. The id is
 * derived rather than fetched because it is a pure function of the triple, and
 * the engine cross-checks it against the pool it finds for that triple, so a
 * drifted id fails loudly instead of silently borrowing another country's
 * exits.
 */
function proxyPoolId(provider, country, role = 'checkout') {
  const id = `${String(provider || '').trim().toLowerCase()}-${normalizedCode(country).toLowerCase()}`;
  return role === 'update' ? `${id}-update` : id;
}

function providerForCountry(sourceCountryCode) {
  return PROVIDER_BY_COUNTRY[normalizedCode(sourceCountryCode)] || DEFAULT_PROVIDER;
}

function providerDescriptor(providerId) {
  return EXTRACTION_PROVIDERS[String(providerId || '').trim().toLowerCase()] || null;
}

/** The payment provider that continues from this extraction, if any. */
function paymentProviderFor(providerId) {
  return providerDescriptor(providerId)?.payment || '';
}

/**
 * One routing rule, normalized. Legacy field names are still read: the table
 * was written as `country` / `checkoutPool` / `updatePool` before these axes
 * had honest names, and those files are still on disk.
 */
function normalizeRoute(rule = {}) {
  return {
    billingCountry: normalizedCode(rule.billingCountry ?? rule.country),
    checkoutCountry: normalizedCode(rule.checkoutCountry ?? rule.checkoutPool),
    updateCountry: normalizedCode(rule.updateCountry ?? rule.updatePool),
    applyCheckoutUpdate: rule.applyCheckoutUpdate !== false,
  };
}

/**
 * The dispatch options one row needs, or the reason it cannot be dispatched.
 *
 * Refusals are returned rather than thrown so a single misrouted row cannot
 * fail a whole batch.
 */
function dispatchOptionsFor(providerId, rule = {}) {
  const descriptor = providerDescriptor(providerId);
  if (!descriptor) return { error: `未知的提链 provider：${providerId}` };
  const route = normalizeRoute(rule);
  const applyUpdate = descriptor.needsUpdate && route.applyCheckoutUpdate;

  if (descriptor.fixedCountry) {
    // Both pools are the provider's own. The routing table is written for the
    // PayPal bucket, so its regions are deliberately NOT inherited here — an
    // Indian row must not draw UPI's promotion hop from PayPal's US pool.
    const options = {
      country: descriptor.fixedCountry,
      proxyPoolId: proxyPoolId(descriptor.id, descriptor.fixedCountry, 'checkout'),
      applyCheckoutUpdate: applyUpdate,
    };
    if (applyUpdate) {
      const updateCountry = descriptor.updateCountry || descriptor.fixedCountry;
      options.updateProxyCountry = updateCountry;
      options.updateProxyPoolId = proxyPoolId(descriptor.id, updateCountry, 'update');
    }
    return { options, checkoutCountry: descriptor.fixedCountry, billingCountry: descriptor.fixedCountry };
  }

  const { checkoutCountry, billingCountry } = route;
  if (!checkoutCountry) return { error: 'PayPal 路由未配置 Checkout 代理区域' };
  if (!PROXY_REGIONS.includes(checkoutCountry)) {
    return { error: `Checkout 代理区域 ${checkoutCountry} 不是可用的代理源区域` };
  }
  if (!billingCountry) return { error: 'PayPal 路由未配置账单国家' };
  if (!BILLING_COUNTRIES.includes(billingCountry)) {
    return { error: `账单国家 ${billingCountry} 没有对应的账单档案（${BILLING_COUNTRIES.join(' ')}）` };
  }
  const options = {
    checkoutCountry,
    billingCountry,
    proxyPoolId: proxyPoolId(descriptor.id, checkoutCountry, 'checkout'),
    applyCheckoutUpdate: applyUpdate,
  };
  if (applyUpdate) {
    const updateCountry = route.updateCountry || checkoutCountry;
    if (!PROXY_REGIONS.includes(updateCountry)) {
      return { error: `Update 代理区域 ${updateCountry} 不是可用的代理源区域` };
    }
    options.updateProxyCountry = updateCountry;
    options.updateProxyPoolId = proxyPoolId(descriptor.id, updateCountry, 'update');
  }
  return { options, checkoutCountry, billingCountry };
}

/**
 * Every proxy pool the current routing will actually draw from.
 *
 * A pool only exists as a (provider, country, role) triple the engine can
 * resolve, and most triples are nonsense — MoMo has no update pool, UPI's
 * update hop is Vietnamese, GoPay is Indonesian only. Deriving the list from
 * the routing table means the console offers the pools that matter instead of
 * a combination builder that can produce `momo/US/update`.
 */
function requiredProxyPools(rules = {}) {
  const pools = new Map();
  const add = (provider, country, role) => {
    const code = normalizedCode(country);
    if (!provider || !code) return;
    pools.set(`${provider}:${code}:${role}`, { provider, country: code, role, id: proxyPoolId(provider, code, role) });
  };

  for (const descriptor of Object.values(EXTRACTION_PROVIDERS)) {
    if (!descriptor.fixedCountry) continue;
    add(descriptor.id, descriptor.fixedCountry, 'checkout');
    if (descriptor.needsUpdate) add(descriptor.id, descriptor.updateCountry || descriptor.fixedCountry, 'update');
  }
  // PayPal is the only provider whose regions come from the table, so it is the
  // only one that can grow a pool the operator has to keep stocked.
  for (const rule of Object.values(rules || {})) {
    const route = normalizeRoute(rule);
    add('paypal', route.checkoutCountry, 'checkout');
    if (route.applyCheckoutUpdate) add('paypal', route.updateCountry || route.checkoutCountry, 'update');
  }
  return [...pools.values()];
}

module.exports = {
  BILLING_COUNTRIES,
  PROXY_REGIONS,
  dispatchOptionsFor,
  normalizeRoute,
  paymentProviderFor,
  providerDescriptor,
  providerForCountry,
  proxyPoolId,
  requiredProxyPools,
};
