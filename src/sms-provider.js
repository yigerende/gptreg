'use strict';

const { sleep } = require('./util/shared');
const { providerApiFetch } = require('./provider-api-egress');

const DEFAULT_SMSBOWER_BASE_URL = 'https://smsbower.page/stubs/handler_api.php';
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_PREFLIGHT_ATTEMPTS = 3;
const DEFAULT_PREFLIGHT_RETRY_DELAY_MS = 400;
const SMSBOWER_DIALING_CODE_BY_COUNTRY_ID = Object.freeze({
  1: '380',
  4: '63',
  6: '62',
  33: '57',
  43: '49',
  53: '966',
  73: '55',
  151: '56',
});
const SMSBOWER_COUNTRY_CATALOG = Object.freeze([
  Object.freeze({ id: 151, name: 'Chile', dialingCode: '56' }),
  Object.freeze({ id: 6, name: 'Indonesia', dialingCode: '62' }),
  Object.freeze({ id: 43, name: 'Germany', dialingCode: '49' }),
  Object.freeze({ id: 4, name: 'Philippines', dialingCode: '63' }),
  Object.freeze({ id: 73, name: 'Brazil', dialingCode: '55' }),
  Object.freeze({ id: 33, name: 'Colombia', dialingCode: '57' }),
  Object.freeze({ id: 1, name: 'Ukraine', dialingCode: '380' }),
  Object.freeze({ id: 53, name: 'Saudi Arabia', dialingCode: '966' }),
]);
const SMSBOWER_PHONE_PATTERN_BY_COUNTRY_ID = Object.freeze({
  151: /^\+569\d{8}$/,
});
const DEFAULT_COUNTRY_UNAVAILABLE_COOLDOWN_MS = 30000;

function parseRetryAfterMs(value, nowMs = Date.now()) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const text = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Math.max(0, Math.ceil(Number(text) * 1000));
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : null;
}

function responseHeader(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) || '';
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? headers[key] : '';
}

function parseSmsBowerPayload(text) {
  const value = String(text ?? '').replace(/^\uFEFF/, '').trim();
  if (!value) return '';
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function payloadErrorCode(payload) {
  if (typeof payload === 'string') {
    const code = payload.split(':', 1)[0].trim().toUpperCase();
    if (/^(?:BAD|ERROR|NO|WRONG|INVALID|TOO_MANY|MAX_PRICE|EARLY_CANCEL|ACCOUNT_|BANNED)/.test(code)) {
      return code;
    }
    return '';
  }
  if (!payload || typeof payload !== 'object') return '';
  const status = String(payload.status || '').toLowerCase();
  if (status !== 'error' && payload.success !== false && !payload.error) return '';
  return String(payload.code || payload.error || payload.message || 'API_ERROR')
    .split(':', 1)[0]
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_');
}

function classifySmsBowerError(code, options = {}) {
  const normalized = String(code || 'SMSBOWER_ERROR').trim().toUpperCase().replace(/[^A-Z0-9_]+/g, '_');
  const httpStatus = Number(options.httpStatus || options.status || 0);
  let category = 'provider';
  let retryable = false;

  if (httpStatus === 408 || httpStatus === 425 || httpStatus === 429 || httpStatus >= 500) {
    category = httpStatus === 429 ? 'rate_limit' : 'transient';
    retryable = true;
  } else if (['NO_NUMBERS', 'MAX_PRICE_TOO_LOW', 'INVALID_PHONE_NUMBER', 'INVALID_PHONE_COUNTRY_FORMAT'].includes(normalized)) {
    category = 'availability';
    retryable = true;
  } else if (normalized === 'EARLY_CANCEL_DENIED') {
    category = 'lifecycle';
    retryable = true;
  } else if (normalized === 'BAD_STATUS') {
    category = 'lifecycle';
  } else if (normalized.startsWith('ERROR_') || normalized === 'SQL_ERROR') {
    category = 'transient';
    retryable = true;
  } else if (normalized === 'BAD_KEY' || normalized === 'ACCOUNT_INACTIVE' || normalized === 'BANNED') {
    category = 'authentication';
  } else if (normalized === 'NO_BALANCE') {
    category = 'balance';
  } else if (normalized === 'NO_ACTIVATION' || normalized === 'WRONG_ACTIVATION_ID') {
    category = 'not_found';
  } else if (/^(?:BAD|WRONG|INVALID)_/.test(normalized)) {
    category = 'configuration';
  }

  return {
    code: normalized,
    category,
    retryable,
    retryAfterMs: options.retryAfterMs ?? null,
    httpStatus,
  };
}

class SmsBowerError extends Error {
  constructor(message, details = {}) {
    const classification = classifySmsBowerError(details.code, details);
    super(message);
    this.name = 'SmsBowerError';
    this.code = classification.code;
    this.category = classification.category;
    this.retryable = classification.retryable;
    this.retryAfterMs = classification.retryAfterMs;
    this.status = classification.httpStatus;
    this.httpStatus = classification.httpStatus;
    this.action = details.action || '';
    this.response = details.response;
  }
}

function normalizePhoneNumber(value, countryCode = '') {
  let raw = String(value ?? '').trim();
  const explicitlyInternational = raw.startsWith('+') || raw.startsWith('00');
  if (raw.startsWith('00')) raw = raw.slice(2);
  let digits = raw.replace(/\D/g, '');
  const prefix = String(countryCode ?? '').replace(/\D/g, '');
  if (prefix && !explicitlyInternational && !digits.startsWith(prefix)) {
    digits = `${prefix}${digits.replace(/^0+/, '')}`;
  }
  if (!digits || digits.length < 7 || digits.length > 15) {
    throw new SmsBowerError(`SMSBower returned an invalid phone number: ${String(value ?? '')}`, {
      code: 'INVALID_PHONE_NUMBER',
    });
  }
  return `+${digits}`;
}

function configuredDialingCode(selector, resolvedCountryId = '') {
  const explicit = selector && typeof selector === 'object'
    ? selectorValue(selector, ['dialingCode', 'dialCode', 'callingCode', 'phoneCode'])
    : undefined;
  const country = countryId(selector) || String(resolvedCountryId || '').trim();
  return String(explicit ?? SMSBOWER_DIALING_CODE_BY_COUNTRY_ID[country] ?? '').replace(/\D/g, '');
}

function validatePhoneForSmsBowerCountry(number, country) {
  const id = String(country || '').trim();
  const pattern = SMSBOWER_PHONE_PATTERN_BY_COUNTRY_ID[id];
  const dialingCode = SMSBOWER_DIALING_CODE_BY_COUNTRY_ID[id];
  if ((pattern && !pattern.test(number)) || (dialingCode && !number.startsWith(`+${dialingCode}`))) {
    throw new SmsBowerError(`SMSBower returned a phone number outside country ${id}: ${number}`, {
      code: 'INVALID_PHONE_COUNTRY_FORMAT',
      action: 'getNumberV2',
    });
  }
  return number;
}

function booleanValue(value) {
  if (typeof value === 'string') return !['', '0', 'false', 'no'].includes(value.trim().toLowerCase());
  return Boolean(value);
}

function selectorValue(value, keys) {
  if (value && typeof value === 'object') {
    for (const key of keys) {
      if (value[key] !== undefined && value[key] !== null && value[key] !== '') return value[key];
    }
    return undefined;
  }
  return value;
}

function serviceCode(value) {
  return String(selectorValue(value, ['code', 'service', 'id']) ?? '').trim();
}

function countryId(value) {
  return String(selectorValue(value, ['id', 'country', 'code']) ?? '').trim();
}

function normalizeCountrySelector(value) {
  const id = countryId(value);
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if (id) return { ...value, id };
    const name = selectorValue(value, ['name', 'title', 'eng']);
    return name ? { ...value } : null;
  }
  if (!id) return null;
  return { id };
}

function numericPrice(value) {
  const price = Number(value);
  return Number.isFinite(price) ? price : null;
}

function inventoryCount(item) {
  const count = Number(item?.count ?? item?.quantity ?? item?.available);
  return Number.isFinite(count) ? count : 0;
}

function hasInventory(item) {
  return inventoryCount(item) > 0;
}

function asCatalogArray(payload, kind) {
  let source = payload;
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    source = source.data || source[kind] || source.items || source;
  }
  if (Array.isArray(source)) return source;
  if (!source || typeof source !== 'object') return [];
  return Object.entries(source).map(([key, value]) => (
    value && typeof value === 'object'
      ? { [kind === 'services' ? 'service' : 'id']: key, ...value }
      : { [kind === 'services' ? 'service' : 'id']: key, name: String(value) }
  ));
}

function normalizeServices(payload) {
  return asCatalogArray(payload, 'services').map((item) => ({
    ...item,
    code: String(item.code ?? item.service ?? item.id ?? '').trim(),
    name: String(item.name ?? item.title ?? item.eng ?? item.label ?? '').trim(),
  })).filter((item) => item.code);
}

function normalizeCountries(payload) {
  return asCatalogArray(payload, 'countries').map((item) => ({
    ...item,
    id: String(item.id ?? item.country ?? item.code ?? '').trim(),
    name: String(item.name ?? item.eng ?? item.title ?? item.label ?? '').trim(),
  })).filter((item) => item.id);
}

function findCatalogEntry(items, selector, kind) {
  const direct = selectorValue(selector, kind === 'service' ? ['code', 'service', 'id'] : ['id', 'country', 'code']);
  const name = selectorValue(selector, ['name', 'title', 'eng']);
  const candidates = [direct, name].filter((value) => value !== undefined && value !== null && value !== '')
    .map((value) => String(value).trim().toLowerCase());
  if (candidates.length === 0) return null;
  return items.find((item) => {
    const values = kind === 'service'
      ? [item.code, item.service, item.id, item.name, item.title]
      : [item.id, item.country, item.code, item.name, item.eng, item.title, item.rus, item.chn];
    return values.some((value) => candidates.includes(String(value ?? '').trim().toLowerCase()));
  }) || null;
}

function normalizePrices(payload) {
  let source = payload;
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    source = source.data || source.prices || source.items || source;
  }
  if (Array.isArray(source)) return source;
  if (!source || typeof source !== 'object') return [];

  const prices = [];
  for (const [country, services] of Object.entries(source)) {
    if (Array.isArray(services)) {
      for (const item of services) prices.push({ country, ...item });
      continue;
    }
    if (!services || typeof services !== 'object') continue;
    for (const [service, value] of Object.entries(services)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        prices.push({ country, service, price: value });
        continue;
      }
      if (value.price !== undefined || value.cost !== undefined || value.count !== undefined) {
        prices.push({ country, service, ...value });
        continue;
      }
      for (const [providerId, offer] of Object.entries(value)) {
        if (offer && typeof offer === 'object' && !Array.isArray(offer)) {
          prices.push({ country, service, providerId, ...offer });
        }
      }
    }
  }
  return prices;
}

function leaseActivationId(lease) {
  const id = lease && typeof lease === 'object' ? (lease.activationId ?? lease.id) : lease;
  if (id === undefined || id === null || String(id).trim() === '') {
    throw new SmsBowerError('SMSBower lease is missing an activation ID', { code: 'INVALID_ACTIVATION_ID' });
  }
  return String(id).trim();
}

function serializableLease(lease) {
  if (!lease || typeof lease !== 'object') return lease;
  return JSON.parse(JSON.stringify(lease));
}

function billingFieldsFromPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return {};
  const sources = [payload, payload.data, payload.billing, payload.costs]
    .filter((source) => source && typeof source === 'object' && !Array.isArray(source));
  const fields = [
    'billingStatus', 'billing_state', 'consumed', 'charged', 'chargeConfirmed',
    'charge_confirmed', 'consumedUsd', 'consumedCost', 'chargedUsd', 'chargedCost',
    'actualCost', 'actualCostUsd', 'finalCost', 'amountCharged', 'amount_charged',
    'refunded', 'refundConfirmed', 'refund_confirmed', 'cancelRefunded',
    'cancel_refunded', 'refundedUsd', 'refundUsd', 'refundAmount', 'refund_amount',
    'refundedAmount', 'creditUsd', 'credit', 'returnedAmount', 'returned_amount',
  ];
  const result = {};
  for (const source of sources) {
    for (const field of fields) {
      if (source[field] !== undefined && source[field] !== null && source[field] !== '') {
        result[field] = source[field];
      }
    }
  }
  return result;
}

class MockSmsProvider {
  constructor(options = {}) {
    this.name = options.name || 'mock';
    this.codes = Array.isArray(options.codes) ? [...options.codes] : [];
    this.numbers = Array.isArray(options.numbers) ? [...options.numbers] : ['+10000000000'];
    this.leases = new Map();
  }

  async preflight() {
    return { provider: this.name, ready: true };
  }

  async acquireNumber(job = {}) {
    const number = this.numbers.length ? this.numbers.shift() : `+1000000${String(this.leases.size + 1).padStart(4, '0')}`;
    const lease = {
      id: `sms-${Date.now().toString(36)}-${this.leases.size + 1}`,
      provider: this.name,
      number,
      service: job.service || 'openai',
      country: job.country || '',
      acquiredAt: new Date().toISOString(),
      status: 'leased',
    };
    this.leases.set(lease.id, lease);
    return lease;
  }

  async getStatus(lease) {
    const current = this.leases.get(lease.id) || lease;
    if (current.code) return { status: 'received', providerStatus: 'STATUS_OK', code: current.code };
    return { status: 'waiting', providerStatus: 'STATUS_WAIT_CODE', code: '' };
  }

  async pollCode(lease, options = {}) {
    const timeoutMs = Number(options.timeoutMs || 0);
    const pollIntervalMs = Number(options.pollIntervalMs || 1000);
    const started = Date.now();
    while (true) {
      const next = this.codes.shift();
      if (next) {
        const code = typeof next === 'string' ? next : next.code;
        const message = typeof next === 'string' ? '' : next.message || '';
        const current = this.leases.get(lease.id) || lease;
        current.code = code;
        current.status = 'code_received';
        this.leases.set(current.id, current);
        if (typeof options.onPoll === 'function') {
          await options.onPoll({ status: 'received', providerStatus: 'STATUS_OK', hasCode: true, message });
        }
        return {
          leaseId: lease.id,
          number: lease.number,
          code,
          message,
          receivedAt: new Date().toISOString(),
        };
      }
      if (typeof options.onPoll === 'function') {
        await options.onPoll({ status: 'waiting', providerStatus: 'STATUS_WAIT_CODE', hasCode: false, message: '' });
      }
      if (!timeoutMs || Date.now() - started >= timeoutMs) {
        return null;
      }
      await sleep(pollIntervalMs);
    }
  }

  async markSmsSent(lease) {
    return this.#setLocalStatus(lease, 'sms_sent');
  }

  async requestAnotherCode(lease) {
    return this.#setLocalStatus(lease, 'retry_requested');
  }

  async complete(lease) {
    return this.#setLocalStatus(lease, 'complete');
  }

  async cancel(lease, reason = '') {
    const current = this.#setLocalStatus(lease, 'cancelled');
    current.cancelReason = reason;
    current.cancelledAt = new Date().toISOString();
    return current;
  }

  async reconcile(lease) {
    return this.leases.get(lease.id) || lease;
  }

  snapshot() {
    return [...this.leases.values()].map(serializableLease);
  }

  restoreLease(lease) {
    const copy = serializableLease(lease);
    this.leases.set(copy.id, copy);
    return copy;
  }

  async release(lease, reason = '') {
    const current = this.#setLocalStatus(lease, 'released');
    current.releaseReason = reason;
    current.releasedAt = new Date().toISOString();
    return current;
  }

  async ban(lease, reason = '') {
    const current = this.#setLocalStatus(lease, 'banned');
    current.banReason = reason;
    current.bannedAt = new Date().toISOString();
    return current;
  }

  #setLocalStatus(lease, status) {
    const current = this.leases.get(lease.id) || lease;
    current.status = status;
    this.leases.set(current.id, current);
    return current;
  }
}

class SmsBowerProvider {
  constructor(options = {}) {
    this.name = 'smsbower';
    this.baseUrl = String(options.baseUrl || DEFAULT_SMSBOWER_BASE_URL);
    // The console routes vendor API traffic through rotating local forwarders
    // (see provider-api-egress); anything else keeps the plain fetch.
    this.fetch = options.fetch || providerApiFetch() || globalThis.fetch;
    this.apiKey = options.apiKey || '';
    this.apiKeyEnv = options.apiKeyEnv || 'SMSBOWER_API_KEY';
    this.requestedService = options.service ?? '';
    this.requestedCountry = options.country ?? '';
    this.service = serviceCode(options.service);
    const configuredCountries = Array.isArray(options.countries) && options.countries.length
      ? options.countries
      : [options.country];
    this.requestedCountries = configuredCountries.map(normalizeCountrySelector).filter(Boolean);
    this.country = countryId(options.country) || this.requestedCountries[0]?.id || '';
    this.dialingCode = configuredDialingCode(options.country, this.country);
    this.lastSelectedCountry = this.country;
    this.countryMarkets = [];
    this.countryUnavailableUntil = new Map();
    this.random = typeof options.random === 'function' ? options.random : Math.random;
    const countryUnavailableCooldownMs = Number(options.countryUnavailableCooldownMs ?? DEFAULT_COUNTRY_UNAVAILABLE_COOLDOWN_MS);
    this.countryUnavailableCooldownMs = Number.isFinite(countryUnavailableCooldownMs)
      ? Math.max(0, countryUnavailableCooldownMs)
      : DEFAULT_COUNTRY_UNAVAILABLE_COOLDOWN_MS;
    this.maxPrice = options.maxPrice;
    this.operator = options.operator || '';
    this.ref = options.ref || '';
    this.phoneException = options.phoneException || '';
    this.pollIntervalMs = Number(options.pollIntervalMs || 5000);
    this.codeTimeoutMs = Number(options.codeTimeoutMs || 120000);
    const requestTimeoutMs = Number(options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS);
    const preflightAttempts = Number(options.preflightAttempts || DEFAULT_PREFLIGHT_ATTEMPTS);
    const preflightRetryDelayMs = Number(options.preflightRetryDelayMs ?? DEFAULT_PREFLIGHT_RETRY_DELAY_MS);
    this.requestTimeoutMs = Number.isFinite(requestTimeoutMs) ? Math.max(1000, requestTimeoutMs) : DEFAULT_REQUEST_TIMEOUT_MS;
    this.preflightAttempts = Number.isInteger(preflightAttempts) ? Math.max(1, preflightAttempts) : DEFAULT_PREFLIGHT_ATTEMPTS;
    this.preflightRetryDelayMs = Number.isFinite(preflightRetryDelayMs) ? Math.max(0, preflightRetryDelayMs) : DEFAULT_PREFLIGHT_RETRY_DELAY_MS;
    this.sleep = options.sleep || sleep;
    this.leases = new Map();
    this.restoreLeases(options.leases || []);
  }

  getApiKey() {
    const key = this.apiKey || process.env[this.apiKeyEnv] || '';
    if (!key) {
      throw new SmsBowerError(`SMSBower API key is missing; set ${this.apiKeyEnv}`, { code: 'BAD_KEY' });
    }
    return key;
  }

  async request(action, params = {}, options = {}) {
    if (typeof this.fetch !== 'function') {
      throw new SmsBowerError('SMSBower requires a fetch implementation', { code: 'INVALID_FETCH' });
    }
    const url = new URL(this.baseUrl);
    url.searchParams.set('api_key', this.getApiKey());
    url.searchParams.set('action', action);
    for (const [name, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(name, String(value));
    }

    let response;
    const requestTimeoutMs = Number(options.timeoutMs ?? this.requestTimeoutMs);
    const effectiveTimeoutMs = Number.isFinite(requestTimeoutMs) ? Math.max(1000, requestTimeoutMs) : this.requestTimeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effectiveTimeoutMs);
    try {
      response = await this.fetch(url.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json, text/plain;q=0.9, */*;q=0.8' },
        signal: controller.signal,
      });
    } catch (cause) {
      const reason = cause?.name === 'AbortError'
        ? `timed out after ${effectiveTimeoutMs} ms`
        : cause.message;
      const error = new SmsBowerError(`SMSBower ${action} request failed: ${reason}`, {
        code: 'NETWORK_ERROR',
        action,
      });
      error.retryable = true;
      error.category = 'transient';
      error.cause = cause;
      throw error;
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    const payload = parseSmsBowerPayload(text);
    const retryAfterMs = parseRetryAfterMs(responseHeader(response.headers, 'retry-after'));
    const status = Number(response.status || 0);
    if (status < 200 || status >= 300) {
      const code = payloadErrorCode(payload) || `HTTP_${status || 'ERROR'}`;
      throw new SmsBowerError(`SMSBower ${action} failed with HTTP ${status || 'unknown'}: ${text || code}`, {
        code,
        action,
        httpStatus: status,
        retryAfterMs,
        response: payload,
      });
    }

    const code = payloadErrorCode(payload);
    if (code) {
      throw new SmsBowerError(`SMSBower ${action} failed: ${typeof payload === 'string' ? payload : (payload.message || payload.error || code)}`, {
        code,
        action,
        retryAfterMs,
        response: payload,
      });
    }
    return payload;
  }

  async getBalance() {
    const payload = await this.request('getBalance');
    const value = typeof payload === 'string' && payload.startsWith('ACCESS_BALANCE:')
      ? payload.slice('ACCESS_BALANCE:'.length)
      : payload?.balance ?? payload?.data?.balance ?? payload;
    const balance = Number(value);
    if (!Number.isFinite(balance)) {
      throw new SmsBowerError('SMSBower getBalance returned an invalid balance', {
        code: 'INVALID_BALANCE_RESPONSE',
        action: 'getBalance',
        response: payload,
      });
    }
    return balance;
  }

  async getServicesList(options = {}) {
    const payload = await this.request('getServicesList', {
      country: options.country ?? this.country,
      lang: options.lang || 'en',
    });
    return normalizeServices(payload);
  }

  async getCountries() {
    return normalizeCountries(await this.request('getCountries'));
  }

  async getPrices(options = {}) {
    const payload = await this.request('getPricesV3', {
      country: options.country ?? this.country,
      service: options.service ?? this.service,
    });
    return normalizePrices(payload);
  }

  async retryPreflightRead(operation) {
    let lastError;
    for (let attempt = 1; attempt <= this.preflightAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (!(error instanceof SmsBowerError) || !error.retryable || attempt >= this.preflightAttempts) throw error;
        const retryAfterMs = Math.max(0, Number(error.retryAfterMs || 0));
        const backoffMs = this.preflightRetryDelayMs * (2 ** (attempt - 1));
        await this.sleep(Math.min(5000, Math.max(retryAfterMs, backoffMs)));
      }
    }
    throw lastError;
  }

  async inspectCountry(country, requestedService) {
    const id = countryId(country);
    if (!id) return { country: { id: '' }, prices: [], offers: 0, cheapestPrice: null, eligible: false, issue: 'WRONG_COUNTRY' };
    const market = {
      country: { ...country, id },
      service: null,
      prices: [],
      offers: 0,
      cheapestPrice: null,
      eligible: false,
      issue: '',
      message: '',
    };
    try {
      const services = await this.retryPreflightRead(() => this.getServicesList({ country: id }));
      const service = findCatalogEntry(services, requestedService || this.service, 'service');
      if (!service) {
        market.issue = 'BAD_SERVICE';
        market.message = `SMSBower service was not found in country ${id}: ${serviceCode(requestedService || this.service)}`;
        return market;
      }
      market.service = service;
      const prices = await this.retryPreflightRead(() => this.getPrices({ service: service.code, country: id }));
      market.prices = prices;
      const available = prices.filter(hasInventory);
      market.offers = available.length;
      const numericPrices = available.map((item) => numericPrice(item.price ?? item.cost ?? item.activationCost)).filter((value) => value !== null);
      market.cheapestPrice = numericPrices.length ? Math.min(...numericPrices) : null;
      const maxPrice = numericPrice(this.maxPrice);
      if (market.cheapestPrice === null) {
        market.issue = 'SMS_INVENTORY_EMPTY';
        market.message = `SMSBower has no ${service.code} inventory in country ${id}`;
      } else if (maxPrice !== null && market.cheapestPrice > maxPrice) {
        market.issue = 'SMS_PRICE_ABOVE_MAX';
        market.message = `SMSBower country ${id} cheapest price ${market.cheapestPrice} USD exceeds maxPrice ${maxPrice} USD`;
      } else {
        market.eligible = true;
      }
      return market;
    } catch (error) {
      market.issue = String(error?.code || 'SMS_MARKET_READ_FAILED');
      market.message = String(error?.message || 'SMSBower country market read failed');
      return market;
    }
  }

  async preflight(options = {}) {
    const balance = options.checkBalance === false
      ? null
      : await this.retryPreflightRead(() => this.getBalance());
    const countries = await this.retryPreflightRead(() => this.getCountries());
    const selectors = this.requestedCountries.length
      ? this.requestedCountries
      : [normalizeCountrySelector(this.requestedCountry || this.country)].filter(Boolean);
    if (!selectors.length) {
      throw new SmsBowerError('SMSBower country is required', { code: 'WRONG_COUNTRY', action: 'preflight' });
    }

    const markets = [];
    for (const selector of selectors) {
      const country = findCatalogEntry(countries, selector, 'country');
      if (!country) {
        markets.push({
          country: { ...selector, id: countryId(selector) },
          service: null,
          prices: [],
          offers: 0,
          cheapestPrice: null,
          eligible: false,
          issue: 'WRONG_COUNTRY',
          message: `SMSBower country was not found: ${countryId(selector)}`,
        });
        continue;
      }
      markets.push(await this.inspectCountry(country, this.requestedService || this.service));
    }

    const firstCountry = markets[0]?.country || { id: this.country };
    const firstService = markets.find((market) => market.service)?.service || {
      code: this.service,
      name: '',
    };
    this.countryMarkets = markets;
    this.country = countryId(firstCountry);
    this.lastSelectedCountry = this.country;
    this.dialingCode = configuredDialingCode(firstCountry, this.country);
    if (firstService.code) this.service = firstService.code;
    this.countryUnavailableUntil.clear();

    return {
      provider: this.name,
      ready: true,
      balance,
      currency: 'USD',
      service: firstService,
      country: firstCountry,
      countries: markets,
      maxPrice: this.maxPrice === undefined || this.maxPrice === null ? null : Number(this.maxPrice),
      prices: markets.flatMap((market) => market.prices.map((price) => ({ ...price, country: price.country ?? market.country.id, service: price.service ?? market.service?.code ?? this.service }))),
      checkedAt: new Date().toISOString(),
    };
  }

  countryCandidatesForAcquire() {
    const markets = Array.isArray(this.countryMarkets) && this.countryMarkets.length
      ? this.countryMarkets.filter((market) => market.eligible === true)
      : this.requestedCountries.map((country) => ({ country, eligible: true }));
    const unique = [];
    const seen = new Set();
    for (const market of markets) {
      const country = normalizeCountrySelector(market.country || market);
      const id = countryId(country);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      unique.push({ ...country, market });
    }
    if (!unique.length) {
      throw new SmsBowerError('SMSBower has no selected country with inventory under maxPrice', {
        code: 'NO_NUMBERS',
        action: 'getNumberV2',
      });
    }
    const now = Date.now();
    const available = unique.filter((candidate) => Number(this.countryUnavailableUntil.get(candidate.id) || 0) <= now);
    const pool = available.length ? available : unique;
    const shuffled = [...pool];
    for (let index = shuffled.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(Math.max(0, Math.min(0.999999999, Number(this.random()))) * (index + 1));
      [shuffled[index], shuffled[swap]] = [shuffled[swap], shuffled[index]];
    }
    return shuffled;
  }

  markCountryUnavailable(country) {
    if (this.countryUnavailableCooldownMs <= 0) return;
    this.countryUnavailableUntil.set(String(country), Date.now() + this.countryUnavailableCooldownMs);
  }

  async acquireNumber(job = {}) {
    const service = serviceCode(job.serviceCode ?? this.service ?? job.service);
    if (!service) throw new SmsBowerError('SMSBower service is required', { code: 'BAD_SERVICE', action: 'getNumberV2' });
    const candidates = this.countryCandidatesForAcquire();
    let lastAvailabilityError = null;
    for (const candidate of candidates) {
      try {
        const lease = await this.acquireNumberForCountry(candidate, job, service);
        this.lastSelectedCountry = lease.country;
        return lease;
      } catch (error) {
        if (error?.code !== 'NO_NUMBERS' && error?.code !== 'MAX_PRICE_TOO_LOW') throw error;
        this.markCountryUnavailable(candidate.id);
        lastAvailabilityError = error;
      }
    }
    throw lastAvailabilityError || new SmsBowerError('SMSBower has no number available in selected countries', {
      code: 'NO_NUMBERS',
      action: 'getNumberV2',
    });
  }

  async acquireNumberForCountry(candidate, job = {}, service = this.service) {
    const country = countryId(candidate);
    if (!country) throw new SmsBowerError('SMSBower country is required', { code: 'WRONG_COUNTRY', action: 'getNumberV2' });
    const payload = await this.request('getNumberV2', {
      service,
      country,
      maxPrice: job.maxPrice ?? this.maxPrice,
      operator: job.operator ?? this.operator,
      phoneException: job.phoneException ?? this.phoneException,
      ref: job.ref ?? this.ref,
    });
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new SmsBowerError('SMSBower getNumberV2 returned an invalid response', {
        code: 'INVALID_NUMBER_RESPONSE',
        action: 'getNumberV2',
        response: payload,
      });
    }

    const activationId = String(payload.activationId ?? payload.activation_id ?? payload.id ?? '').trim();
    if (!activationId) {
      throw new SmsBowerError('SMSBower getNumberV2 response is missing activationId', {
        code: 'INVALID_NUMBER_RESPONSE',
        action: 'getNumberV2',
        response: payload,
      });
    }
    const rawPhoneNumber = payload.phoneNumber ?? payload.phone_number ?? payload.number;
    const providerCountryCode = String(payload.countryCode ?? '').replace(/\D/g, '');
    const dialingCode = configuredDialingCode(candidate, country)
      || (this.requestedCountries.length <= 1 ? this.dialingCode : '')
      || configuredDialingCode(job.country ?? job.countryId, country)
      || (providerCountryCode && providerCountryCode !== country ? providerCountryCode : '');
    let number;
    try {
      number = validatePhoneForSmsBowerCountry(
        normalizePhoneNumber(rawPhoneNumber, dialingCode),
        country,
      );
    } catch (error) {
      try {
        const cleanup = await this.request('setStatus', { id: activationId, status: 8 });
        error.cleanupStatus = typeof cleanup === 'string' ? cleanup.split(':', 1)[0] : String(cleanup?.status || cleanup?.code || '');
      } catch (cleanupError) {
        error.cleanupError = cleanupError.message;
      }
      error.activationId = activationId;
      error.providerCountryCode = providerCountryCode;
      error.dialingCode = dialingCode;
      const cleanupComplete = /(?:CANCEL|NO_ACTIVATION)/i.test(String(error.cleanupStatus || ''));
      error.invalidLease = {
        id: activationId,
        activationId,
        provider: this.name,
        number: String(rawPhoneNumber ?? ''),
        service,
        country,
        countryCode: dialingCode,
        providerCountryCode,
        cost: Number.isFinite(Number(payload.activationCost ?? payload.activation_cost ?? payload.cost))
          ? Number(payload.activationCost ?? payload.activation_cost ?? payload.cost)
          : null,
        currency: 'USD',
        status: cleanupComplete ? 'cancelled' : 'pending_cleanup',
        providerStatus: error.cleanupStatus || '',
        cancelReason: error.code,
        cleanupError: error.cleanupError || '',
        cleanupAt: cleanupComplete ? '' : new Date(Date.now() + 120000).toISOString(),
      };
      throw error;
    }
    const lease = {
      id: activationId,
      activationId,
      provider: this.name,
      number,
      service,
      country,
      countryCode: dialingCode,
      providerCountryCode,
      cost: Number.isFinite(Number(payload.activationCost ?? payload.activation_cost ?? payload.cost))
        ? Number(payload.activationCost ?? payload.activation_cost ?? payload.cost)
        : null,
      currency: 'USD',
      operator: payload.activationOperator ?? payload.operator ?? '',
      canGetAnotherSms: booleanValue(payload.canGetAnotherSms ?? payload.can_get_another_sms),
      acquiredAt: payload.activationTime || payload.activation_time || new Date().toISOString(),
      status: 'leased',
      providerStatus: 'ACCESS_NUMBER',
    };
    this.leases.set(lease.id, lease);
    return lease;
  }

  async getStatus(lease) {
    const activationId = leaseActivationId(lease);
    const payload = await this.request('getStatus', { id: activationId });
    return this.#normalizeStatus(payload);
  }

  async pollCode(lease, options = {}) {
    const timeoutMs = Number(options.timeoutMs ?? this.codeTimeoutMs);
    const pollIntervalMs = Math.max(0, Number(options.pollIntervalMs ?? this.pollIntervalMs));
    const started = Date.now();
    let lastError = null;

    while (true) {
      try {
        const result = await this.getStatus(lease);
        if (typeof options.onPoll === 'function') {
          await options.onPoll({
            status: result.status,
            providerStatus: result.providerStatus,
            hasCode: result.status === 'received',
            message: result.message || '',
          });
        }
        if (result.status === 'received') {
          const current = this.#remember(lease);
          current.status = 'code_received';
          current.providerStatus = result.providerStatus;
          current.codeReceivedAt = new Date().toISOString();
          return {
            leaseId: current.id,
            number: current.number,
            code: result.code,
            message: result.message || '',
            providerStatus: result.providerStatus,
            receivedAt: current.codeReceivedAt,
          };
        }
        if (result.status === 'cancelled' || result.status === 'complete') {
          throw new SmsBowerError(`SMSBower activation ${leaseActivationId(lease)} is ${result.status}`, {
            code: result.providerStatus,
            action: 'getStatus',
            response: result.raw,
          });
        }
        lastError = null;
      } catch (error) {
        lastError = error;
        if (!(error instanceof SmsBowerError) || !error.retryable || timeoutMs <= 0) throw error;
      }

      const elapsed = Date.now() - started;
      if (timeoutMs <= 0 || elapsed >= timeoutMs) return null;
      const retryAfterMs = Number(lastError?.retryAfterMs || 0);
      await sleep(Math.min(timeoutMs - elapsed, Math.max(pollIntervalMs, retryAfterMs)));
    }
  }

  async setStatus(lease, statusCode, localStatus) {
    const activationId = leaseActivationId(lease);
    const payload = await this.request('setStatus', { id: activationId, status: statusCode });
    const current = this.#remember(lease);
    Object.assign(current, billingFieldsFromPayload(payload));
    current.status = localStatus;
    current.providerStatus = typeof payload === 'string'
      ? payload.split(':', 1)[0]
      : String(payload?.status || payload?.code || '');
    current.updatedAt = new Date().toISOString();
    return current;
  }

  async markSmsSent(lease) {
    return this.setStatus(lease, 1, 'sms_sent');
  }

  async requestAnotherCode(lease) {
    return this.setStatus(lease, 3, 'retry_requested');
  }

  async complete(lease) {
    const current = await this.setStatus(lease, 6, 'complete');
    current.completedAt = current.updatedAt;
    return current;
  }

  async cancel(lease, reason = '') {
    const current = await this.setStatus(lease, 8, 'cancelled');
    current.cancelReason = reason;
    current.cancelledAt = current.updatedAt;
    return current;
  }

  async release(lease, reason = '') {
    return this.cancel(lease, reason);
  }

  async ban(lease, reason = '') {
    return this.cancel(lease, reason);
  }

  async reconcile(lease) {
    const current = this.#remember(lease);
    let result;
    try {
      result = await this.getStatus(current);
    } catch (error) {
      if (!(error instanceof SmsBowerError) || error.category !== 'not_found') throw error;
      current.status = 'missing';
      current.providerStatus = error.code;
      current.reconciledAt = new Date().toISOString();
      return current;
    }
    current.providerStatus = result.providerStatus;
    current.reconciledAt = new Date().toISOString();
    if (result.status === 'received') {
      current.status = 'code_received';
      current.code = result.code;
      current.codeReceived = true;
      current.codeReceivedAt = current.codeReceivedAt || current.reconciledAt;
    } else if (result.status === 'cancelled') {
      current.status = 'cancelled';
    } else if (result.status === 'complete') {
      current.status = 'complete';
    } else if (!['code_received', 'complete', 'cancelled'].includes(current.status)) {
      current.status = result.status === 'waiting_retry' ? 'retry_requested' : 'waiting_code';
    }
    return current;
  }

  snapshot() {
    return [...this.leases.values()].map(serializableLease);
  }

  restoreLeases(leases) {
    const list = Array.isArray(leases) ? leases : Object.values(leases || {});
    for (const lease of list) this.restoreLease(lease);
    return this.snapshot();
  }

  restoreLease(lease) {
    const copy = serializableLease(lease);
    const id = leaseActivationId(copy);
    copy.id = id;
    copy.activationId = id;
    copy.provider = copy.provider || this.name;
    this.leases.set(id, copy);
    return copy;
  }

  #remember(lease) {
    const id = leaseActivationId(lease);
    const current = this.leases.get(id);
    if (current) return current;
    return this.restoreLease(lease);
  }

  #normalizeStatus(payload) {
    if (typeof payload === 'string') {
      const separator = payload.indexOf(':');
      const providerStatus = (separator === -1 ? payload : payload.slice(0, separator)).trim().toUpperCase();
      const value = separator === -1 ? '' : payload.slice(separator + 1).trim();
      if (providerStatus === 'STATUS_OK') {
        return { status: 'received', providerStatus, code: value, message: '', raw: payload };
      }
      const statuses = {
        STATUS_WAIT_CODE: 'waiting',
        STATUS_WAIT_RETRY: 'waiting_retry',
        STATUS_WAIT_RESEND: 'waiting_retry',
        STATUS_CANCEL: 'cancelled',
        STATUS_FINISH: 'complete',
      };
      if (statuses[providerStatus]) {
        return { status: statuses[providerStatus], providerStatus, code: '', message: value, raw: payload };
      }
    } else if (payload && typeof payload === 'object') {
      const providerStatus = String(payload.status || payload.code || '').toUpperCase();
      const code = String(payload.smsCode ?? payload.sms_code ?? payload.sms ?? payload.value ?? '').trim();
      if (providerStatus === 'STATUS_OK' || code) {
        return {
          status: 'received',
          providerStatus: providerStatus || 'STATUS_OK',
          code,
          message: payload.message || '',
          raw: payload,
          ...billingFieldsFromPayload(payload),
        };
      }
      const statuses = {
        STATUS_WAIT_CODE: 'waiting',
        STATUS_WAIT_RETRY: 'waiting_retry',
        STATUS_WAIT_RESEND: 'waiting_retry',
        STATUS_CANCEL: 'cancelled',
        ACCESS_CANCEL: 'cancelled',
        STATUS_FINISH: 'complete',
        ACCESS_ACTIVATION: 'complete',
      };
      if (statuses[providerStatus]) {
        return {
          status: statuses[providerStatus],
          providerStatus,
          code: '',
          message: payload.message || '',
          raw: payload,
          ...billingFieldsFromPayload(payload),
        };
      }
    }
    throw new SmsBowerError('SMSBower getStatus returned an unknown response', {
      code: 'INVALID_STATUS_RESPONSE',
      action: 'getStatus',
      response: payload,
    });
  }
}

function createSmsProvider(config = {}) {
  const provider = String(config.provider || config.type || 'mock').toLowerCase();
  if (provider === 'mock') return new MockSmsProvider(config);
  if (provider === 'smsbower' || provider === 'sms-bower') return new SmsBowerProvider(config);
  if (provider === 'firefox' || provider === 'firefox-fun' || provider === 'firefox.fun') {
    // Lazy-load to keep the shared phone-normalization helper free of a module
    // cycle: firefox-fun-provider imports it from this file.
    const { FirefoxFunProvider } = require('./firefox-fun-provider');
    return new FirefoxFunProvider({
      ...config,
      ...(config.firefox && typeof config.firefox === 'object' ? config.firefox : {}),
      provider,
    });
  }
  throw new Error(`Unsupported SMS provider: ${provider}`);
}

function isSmsProviderError(error) {
  return error instanceof SmsBowerError || error?.name === 'FirefoxFunError';
}

module.exports = {
  DEFAULT_SMSBOWER_BASE_URL,
  SMSBOWER_COUNTRY_CATALOG,
  MockSmsProvider,
  SmsBowerError,
  SmsBowerProvider,
  classifySmsBowerError,
  createSmsProvider,
  isSmsProviderError,
  normalizePhoneNumber,
  parseRetryAfterMs,
  sleep,
};
