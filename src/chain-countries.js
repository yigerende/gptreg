'use strict';

/**
 * The billing profiles the checkout accepts — currency, locale and timezone.
 *
 * `config-v2` validates `chain.country` against this, and it is the same table
 * the external engine checks `billingCountry` against. It is deliberately NOT
 * the proxy region list: a checkout exit can be drawn from far more countries
 * than there are billing profiles, and conflating the two is what makes a run
 * bill in the wrong currency. `chain-routing` owns both tables; this module
 * just re-exports the billing one under the name the config layer已经在用.
 */
const { BILLING_COUNTRIES } = require('./chain-routing');

const SUPPORTED_COUNTRIES = BILLING_COUNTRIES;

function normalizedCountry(value, fallback = 'GB') {
  const country = String(value == null ? '' : value).trim().toUpperCase();
  if (!country) return fallback;
  if (!SUPPORTED_COUNTRIES.includes(country)) {
    throw Object.assign(new Error(`Unsupported chain country: ${country}`), { code: 'CHAIN_COUNTRY_UNSUPPORTED' });
  }
  return country;
}

module.exports = { SUPPORTED_COUNTRIES, normalizedCountry };
