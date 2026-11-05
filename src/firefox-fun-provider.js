'use strict';

const { getFirefoxFunCredentials } = require('./firefox-fun-credentials');
const { normalizePhoneNumber } = require('./sms-provider');
const { sleep } = require('./util/shared');

const DEFAULT_FIREFOX_FUN_URL = 'https://firefox.fun/yhapi.ashx';
const FIREFOX_FUN_PROJECT_ID = '1096';
const FIREFOX_FUN_PROJECT_NAME = 'OpenAI / ChatGpt';
// An empty list means "use the project's live price catalog". The provider
// must never silently turn an omitted country selection into Chile.
const DEFAULT_FIREFOX_COUNTRIES = Object.freeze([]);
const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
// Firefox.fun documents myInfo as one request per token every 60 seconds.
// Keep a small safety margin because the provider measures from its receipt
// time, not from our local cache timestamp.
const ACCOUNT_INFO_CACHE_MS = 65_000;
const ACCOUNT_INFO_FAILURE_BUFFER_MS = 1_000;

const accountInfoCache = new Map();
const accountInfoFailureCache = new Map();
const accountInfoFlights = new Map();

function serializable(value) {
  if (!value || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value));
}

function cloneProviderError(error) {
  const copy = new Error(String(error?.message || 'Firefox.fun account info request failed'));
  copy.name = error?.name || 'FirefoxFunError';
  for (const field of [
    'code',
    'category',
    'retryable',
    'replacePhone',
    'retryAfterMs',
    'status',
    'httpStatus',
    'action',
    'providerCode',
    'response',
  ]) {
    if (error?.[field] !== undefined) copy[field] = serializable(error[field]);
  }
  return copy;
}

function normalizeCountries(value, fallback = DEFAULT_FIREFOX_COUNTRIES) {
  const source = Array.isArray(value)
    ? (value.length ? value : fallback)
    : (value === undefined || value === null || value === '' ? fallback : [value]);
  const result = [];
  const seen = new Set();
  for (const item of source) {
    const code = String(
      typeof item === 'object' && item !== null
        ? (item.code ?? item.country ?? item.id)
        : item,
    ).trim().toLowerCase();
    if (!/^[a-z]{3}$/.test(code) || seen.has(code)) continue;
    seen.add(code);
    result.push({
      code,
      name: String(typeof item === 'object' && item !== null ? (item.name ?? item.title ?? '') : '').trim(),
      dialingCode: String(typeof item === 'object' && item !== null ? (item.dialingCode ?? item.dialCode ?? '') : '').replace(/\D/g, ''),
    });
  }
  return result.length ? result : fallback.map(serializable);
}

function parsePipeBody(text) {
  const value = String(text ?? '').replace(/^\uFEFF/, '').trim();
  if (!value) return { kind: 'text', value: '' };
  try {
    const json = JSON.parse(value);
    return { kind: 'json', value: json };
  } catch {
    // The provider's normal protocol is the pipe response below.
  }
  const separator = value.indexOf('|');
  if (separator === -1) return { kind: 'text', value };
  return {
    kind: 'pipe',
    ok: value.slice(0, separator) === '1',
    parts: value.slice(separator + 1).split('|'),
    raw: value,
  };
}

function classifyError(action, providerCode) {
  const code = String(providerCode || 'API_ERROR').trim().toUpperCase();
  const numeric = Number(providerCode);
  let normalized = `FIREFOX_${code.replace(/[^A-Z0-9]+/g, '_')}`;
  let category = 'provider';
  let retryable = false;
  let replacePhone = false;
  let retryAfterMs = null;

  if (action === 'login' && numeric === -7) {
    normalized = 'FIREFOX_RATE_LIMIT';
    category = 'transient';
    retryable = true;
    retryAfterMs = 60_000;
  } else if (action === 'login' && numeric === -8) {
    normalized = 'FIREFOX_ACCOUNT_DISABLED';
    category = 'authentication';
  } else if (action === 'login' && numeric === -9) {
    normalized = 'FIREFOX_AUTH_FAILED';
    category = 'authentication';
  } else if (action === 'getPhone' && numeric === -1) {
    normalized = 'NO_NUMBERS';
    category = 'availability';
    retryable = true;
  } else if (action === 'getPhone' && numeric === -8) {
    normalized = 'NO_BALANCE';
    category = 'balance';
  } else if (action === 'getPhone' && numeric === -9) {
    normalized = 'SMS_INVENTORY_BUSY';
    category = 'availability';
    retryable = true;
  } else if (action === 'getPhone' && numeric === -4) {
    normalized = 'FIREFOX_COUNTRY_INVALID';
    category = 'configuration';
  } else if (action === 'getPhone' && numeric === -5) {
    normalized = 'FIREFOX_PROJECT_NOT_APPROVED';
    category = 'configuration';
  } else if (action === 'getPhone' && numeric === -6) {
    normalized = 'FIREFOX_PROJECT_DISABLED';
    category = 'configuration';
  } else if (action === 'getPhone' && numeric === -7) {
    normalized = 'FIREFOX_ACCOUNT_DISABLED';
    category = 'authentication';
  } else if (action === 'getPhone' && numeric === -10) {
    normalized = 'FIREFOX_COUNTRY_NOT_ALLOWED';
    category = 'configuration';
  } else if (action === 'getPhoneCode' && numeric === -1) {
    normalized = 'FIREFOX_TOKEN_INVALID';
    category = 'authentication';
  } else if (action === 'getPhoneCode' && numeric === -2) {
    normalized = 'FIREFOX_PHONE_INVALID';
    category = 'not_found';
    replacePhone = true;
  } else if (action === 'getPhoneCode' && numeric === -3) {
    normalized = 'WAIT_CODE';
    category = 'transient';
    retryable = true;
    retryAfterMs = 5000;
  } else if (action === 'myInfo' && numeric === -3) {
    normalized = 'FIREFOX_RATE_LIMIT';
    category = 'transient';
    retryable = true;
    retryAfterMs = 60_000;
  } else if (action === 'getPhoneCode' && numeric === -4) {
    normalized = 'FIREFOX_PHONE_RELEASED';
    category = 'not_found';
    replacePhone = true;
  } else if (action === 'getPhoneCode' && numeric === -5) {
    normalized = 'FIREFOX_PHONE_BLACKLISTED';
    category = 'not_found';
    replacePhone = true;
  } else if (action === 'setRel' && numeric === -2) {
    normalized = 'FIREFOX_PHONE_INVALID';
    category = 'not_found';
  } else if (action === 'setRel' && numeric === -3) {
    normalized = 'FIREFOX_PHONE_RELEASED';
    category = 'not_found';
  } else if (action === 'setRel' && numeric === -4) {
    normalized = 'FIREFOX_CODE_ALREADY_RECEIVED';
    category = 'lifecycle';
  } else if (action === 'setRel' && numeric === -5) {
    normalized = 'FIREFOX_SMS_ALREADY_SENT';
    category = 'lifecycle';
  } else if (action === 'setRel' && numeric === -6) {
    normalized = 'FIREFOX_RELEASE_LIMIT_REACHED';
    category = 'lifecycle';
  } else if (action === 'setRel' && numeric > 0) {
    normalized = 'FIREFOX_RELEASE_TOO_EARLY';
    category = 'lifecycle';
    retryable = true;
    retryAfterMs = numeric * 1000;
  } else if (action === 'myInfo' && (numeric === -1 || numeric === -2)) {
    normalized = 'FIREFOX_TOKEN_INVALID';
    category = 'authentication';
  } else if (action === 'myInfo' && numeric === -3) {
    normalized = 'FIREFOX_RATE_LIMIT';
    category = 'transient';
    retryable = true;
    retryAfterMs = 60_000;
  }

  return { code: normalized, category, retryable, replacePhone, retryAfterMs };
}

class FirefoxFunError extends Error {
  constructor(message, details = {}) {
    const classification = classifyError(details.action, details.providerCode ?? details.code);
    super(message);
    this.name = 'FirefoxFunError';
    this.code = details.code || classification.code;
    this.category = details.category || classification.category;
    this.retryable = details.retryable ?? classification.retryable;
    this.replacePhone = details.replacePhone ?? classification.replacePhone;
    this.retryAfterMs = details.retryAfterMs ?? classification.retryAfterMs;
    this.status = Number(details.status || 0);
    this.httpStatus = this.status;
    this.action = details.action || '';
    this.providerCode = details.providerCode ?? '';
    this.response = details.response;
  }
}

function catalogCountry(item) {
  const code = String(item?.Country_ID ?? item?.country_id ?? item?.country ?? '').trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(code)) return null;
  const title = String(item?.Country_Title ?? item?.country_title ?? '').trim();
  const parts = title.split('/');
  const dialingCode = String(parts[0] || '').replace(/\D/g, '');
  return {
    code,
    name: String(parts[1] || parts[2] || code).trim(),
    englishName: String(parts[2] || '').trim(),
    dialingCode,
    price: Number(item?.Item_UPrice),
  };
}

function authCacheKey(provider) {
  return `${provider.baseUrl}|${provider.token}`;
}

class FirefoxFunProvider {
  constructor(options = {}) {
    const credentials = getFirefoxFunCredentials(options.env || process.env);
    this.name = 'firefox';
    this.baseUrl = DEFAULT_FIREFOX_FUN_URL;
    this.fetch = options.fetch || globalThis.fetch;
    this.token = String(options.token !== undefined ? options.token : (credentials.token || '')).trim();
    this.iid = FIREFOX_FUN_PROJECT_ID;
    this.projectName = FIREFOX_FUN_PROJECT_NAME;
    this.configuredCountries = Array.isArray(options.countries)
      ? normalizeCountries(options.countries, [])
      : normalizeCountries(options.country);
    this.countries = this.configuredCountries.map(serializable);
    const configuredMaxPrice = options.maxPrice === '' || options.maxPrice === null || options.maxPrice === undefined
      ? null
      : Number(options.maxPrice);
    // The provider treats maxPrice=0 as disabled. Keep the same meaning in
    // the normalized config so an empty UI field never becomes a $0 cap.
    this.maxPrice = Number.isFinite(configuredMaxPrice) && configuredMaxPrice > 0 ? configuredMaxPrice : null;
    this.pollIntervalMs = Number(options.pollIntervalMs || 5000);
    this.codeTimeoutMs = Number(options.codeTimeoutMs || 120000);
    this.requestTimeoutMs = Math.max(1000, Number(options.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS));
    this.service = this.iid;
    this.country = this.countries.length === 1 ? this.countries[0].code : 'cheapest';
    this.leases = new Map();
    this.catalog = new Map();
    this.priceByCountry = new Map();
  }

  get credentialsReady() {
    return Boolean(this.token);
  }

  async request(action, params = {}, options = {}) {
    if (typeof this.fetch !== 'function') throw new FirefoxFunError('Firefox.fun requires a fetch implementation', { code: 'FIREFOX_INVALID_FETCH', action });
    const url = new URL(this.baseUrl);
    url.searchParams.set('act', action);
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    let response;
    try {
      response = await this.fetch(url.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json, text/plain;q=0.9, */*;q=0.8' },
        signal: controller.signal,
      });
    } catch (cause) {
      const message = cause?.name === 'AbortError' ? `timed out after ${this.requestTimeoutMs} ms` : cause.message;
      throw new FirefoxFunError(`Firefox.fun ${action} request failed: ${message}`, {
        code: 'FIREFOX_NETWORK_ERROR',
        category: 'transient',
        retryable: true,
        action,
      });
    } finally {
      clearTimeout(timeout);
    }
    const raw = await response.text();
    const parsed = parsePipeBody(raw);
    if (response.status < 200 || response.status >= 300) {
      throw new FirefoxFunError(`Firefox.fun ${action} returned HTTP ${response.status}`, {
        code: `FIREFOX_HTTP_${response.status}`,
        category: response.status === 429 || response.status >= 500 ? 'transient' : 'provider',
        retryable: response.status === 429 || response.status >= 500,
        status: response.status,
        action,
        response: raw,
      });
    }
    if (parsed.kind === 'pipe' && !parsed.ok) {
      const providerCode = parsed.parts[0] || 'API_ERROR';
      const error = new FirefoxFunError(`Firefox.fun ${action} failed: ${providerCode}`, {
        action,
        providerCode,
        response: raw,
      });
      throw error;
    }
    return parsed;
  }

  async login() {
    if (!this.credentialsReady) {
      throw new FirefoxFunError('Firefox.fun token is not configured on the server', {
        code: 'FIREFOX_CREDENTIALS_MISSING',
        category: 'authentication',
      });
    }
    return this.token;
  }

  async authenticatedRequest(action, params = {}) {
    const token = await this.login();
    return this.request(action, { token, ...params });
  }

  async accountInfo(options = {}) {
    const key = authCacheKey(this);
    const fresh = options.fresh === true;
    const cached = fresh ? null : accountInfoCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const blocked = fresh ? null : accountInfoFailureCache.get(key);
    if (blocked && blocked.expiresAt > Date.now()) throw cloneProviderError(blocked.error);
    if (blocked) accountInfoFailureCache.delete(key);
    const running = accountInfoFlights.get(key);
    if (running) return running;
    const flight = this.authenticatedRequest('myInfo')
      .then((parsed) => {
        const parts = parsed.parts || [];
        const value = Number(parts[0]);
        if (!Number.isFinite(value)) throw new FirefoxFunError('Firefox.fun balance response is invalid', { code: 'FIREFOX_INVALID_BALANCE', action: 'myInfo', response: parsed });
        const result = { balance: value, level: parts[1] || '', points: parts[2] || '' };
        accountInfoFailureCache.delete(key);
        accountInfoCache.set(key, { value: result, expiresAt: Date.now() + ACCOUNT_INFO_CACHE_MS });
        return result;
      })
      .catch((error) => {
        const retryAfterMs = Number(error?.retryAfterMs);
        if (error?.retryable === true && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
          accountInfoFailureCache.set(key, {
            error: cloneProviderError(error),
            expiresAt: Date.now() + retryAfterMs + ACCOUNT_INFO_FAILURE_BUFFER_MS,
          });
        }
        throw error;
      })
      .finally(() => {
        if (accountInfoFlights.get(key) === flight) accountInfoFlights.delete(key);
      });
    accountInfoFlights.set(key, flight);
    return flight;
  }

  async getBalance(options = {}) {
    return (await this.accountInfo(options)).balance;
  }

  async listProjectItems() {
    const parsed = await this.request('getItem', { key: 'OpenAI' });
    const items = parsed.kind === 'json' && Array.isArray(parsed.value) ? parsed.value : [];
    return items
      .filter((item) => String(item?.Item_ID ?? item?.item_id ?? '').trim() === this.iid)
      .map(catalogCountry)
      .filter((item) => item && Number.isFinite(item.price) && item.price >= 0);
  }

  async listCountries() {
    const items = await this.listProjectItems();
    const seen = new Set();
    return items.filter((item) => {
      if (seen.has(item.code)) return false;
      seen.add(item.code);
      return true;
    }).sort((left, right) => left.name.localeCompare(right.name));
  }

  applyCatalog(items) {
    const configuredCodes = new Set(this.configuredCountries.map((country) => country.code));
    const selectedItems = configuredCodes.size
      ? items.filter((item) => configuredCodes.has(item.code))
      : items;
    const selected = new Map(selectedItems.map((item) => [item.code, item]));
    this.catalog = selected;
    this.priceByCountry = new Map([...selected].map(([code, item]) => [code, item.price]));
    const missing = this.configuredCountries.filter((country) => !selected.has(country.code));
    if (!selected.size) {
      throw new FirefoxFunError('Firefox.fun has no OpenAI price entries for the selected countries', { code: 'FIREFOX_COUNTRY_UNAVAILABLE', category: 'configuration' });
    }
    this.countries = [...selected.values()].map((item) => ({
      code: item.code,
      name: item.name,
      dialingCode: item.dialingCode,
      price: item.price,
    }));
    this.country = this.countries.length === 1 ? this.countries[0].code : 'cheapest';
    return { selected, missing };
  }

  async loadCatalog() {
    return this.applyCatalog(await this.listProjectItems());
  }

  async preflight() {
    if (!this.credentialsReady) throw new FirefoxFunError('Firefox.fun credentials are not configured on the server', { code: 'FIREFOX_CREDENTIALS_MISSING', category: 'authentication' });
    const [account, items] = await Promise.all([this.accountInfo(), this.listProjectItems()]);
    const { selected, missing } = this.applyCatalog(items);
    const prices = [...selected.values()].map((item) => ({
      country: item.code,
      price: item.price,
      count: 1,
      providerId: 'firefox',
    }));
    return {
      provider: this.name,
      ready: true,
      balance: account.balance,
      currency: 'CNY',
      service: { code: this.iid, name: this.projectName },
      country: this.countries.length === 1 ? this.countries[0] : { id: 'cheapest', name: '自动最低价' },
      countries: this.countries,
      maxPrice: this.maxPrice,
      prices,
      inventoryDeferred: true,
      message: missing.length ? `Some selected countries are not currently listed: ${missing.map((country) => country.code).join(', ')}` : 'Firefox.fun inventory is checked when each OAuth phone challenge acquires a number',
    };
  }

  chooseCountry() {
    const candidates = this.countries.filter((country) => this.priceByCountry.has(country.code));
    if (!candidates.length) return this.countries[0] || null;
    const cheapestPrice = Math.min(...candidates.map((country) => this.priceByCountry.get(country.code)));
    return candidates.find((country) => this.priceByCountry.get(country.code) === cheapestPrice) || candidates[0];
  }

  async acquireNumber() {
    // The UI preflight is optional for a conditional OAuth challenge. Load the
    // same catalog here so a direct challenge still follows the cheapest quote.
    if (!this.catalog.size && this.configuredCountries.length !== 1) {
      await this.loadCatalog();
    }
    const country = this.chooseCountry();
    if (!country) {
      throw new FirefoxFunError('Firefox.fun has no OpenAI price entries for phone acquisition', {
        code: 'FIREFOX_COUNTRY_UNAVAILABLE',
        category: 'availability',
        retryable: true,
        action: 'getPhone',
      });
    }
    const params = { iid: this.iid, country: country.code, dock: 0, otpmode: 'sms' };
    if (Number.isFinite(this.maxPrice) && this.maxPrice > 0) params.maxPrice = this.maxPrice;
    const parsed = await this.authenticatedRequest('getPhone', params);
    const parts = parsed.parts || [];
    const pkey = String(parts[0] || '').trim();
    const rawNumber = String(parts[6] || '').trim();
    const dialingCode = String(parts[3] || country.dialingCode || '').replace(/\D/g, '');
    if (!pkey || !rawNumber) throw new FirefoxFunError('Firefox.fun getPhone returned an incomplete lease', { code: 'FIREFOX_INVALID_NUMBER_RESPONSE', action: 'getPhone', response: parsed });
    let number;
    try {
      number = normalizePhoneNumber(rawNumber, dialingCode);
    } catch (error) {
      error.invalidLease = {
        id: pkey,
        activationId: pkey,
        provider: this.name,
        number: rawNumber,
        country: country.code,
        countryCode: dialingCode,
        cost: this.priceByCountry.get(country.code) ?? null,
        status: 'pending_cleanup',
        cleanupAction: 'cancel',
      };
      throw error;
    }
    const lease = {
      id: pkey,
      activationId: pkey,
      provider: this.name,
      pkey,
      number,
      service: this.iid,
      country: country.code,
      countryCode: dialingCode,
      providerCountryCode: String(parts[2] || country.code),
      cost: this.priceByCountry.get(country.code) ?? null,
      currency: 'CNY',
      acquiredAt: parts[1] || new Date().toISOString(),
      status: 'leased',
      providerStatus: 'PHONE_ACQUIRED',
    };
    this.leases.set(pkey, lease);
    return lease;
  }

  async readCode(lease) {
    try {
      const parsed = await this.authenticatedRequest('getPhoneCode', { pkey: lease.pkey || lease.id });
      const code = String(parsed.parts?.[0] || '').trim();
      if (!code) return null;
      const current = this.leases.get(lease.id) || lease;
      Object.assign(current, { code, codeReceived: true, status: 'code_received', providerStatus: 'CODE_RECEIVED', codeReceivedAt: new Date().toISOString() });
      this.leases.set(current.id, current);
      return { leaseId: current.id, number: current.number, code, message: parsed.parts?.[1] || '', providerStatus: 'CODE_RECEIVED', receivedAt: current.codeReceivedAt };
    } catch (error) {
      if (error.code === 'WAIT_CODE') return null;
      throw error;
    }
  }

  async pollCode(lease, options = {}) {
    const timeoutMs = Number(options.timeoutMs ?? this.codeTimeoutMs);
    const pollIntervalMs = Math.max(0, Number(options.pollIntervalMs ?? this.pollIntervalMs));
    const started = Date.now();
    while (true) {
      const result = await this.readCode(lease);
      if (typeof options.onPoll === 'function') {
        await options.onPoll({ status: result ? 'received' : 'waiting', providerStatus: result ? 'CODE_RECEIVED' : 'WAIT_CODE', hasCode: Boolean(result), message: '' });
      }
      if (result) return result;
      if (timeoutMs <= 0 || Date.now() - started >= timeoutMs) return null;
      await sleep(Math.min(pollIntervalMs, timeoutMs - (Date.now() - started)));
    }
  }

  remember(lease) {
    const id = String(lease?.id || lease?.pkey || '').trim();
    const current = this.leases.get(id);
    if (current) return current;
    const copy = serializable(lease);
    copy.id = id;
    copy.activationId = id;
    copy.pkey = copy.pkey || id;
    this.leases.set(id, copy);
    return copy;
  }

  async markSmsSent(lease) {
    const current = this.remember(lease);
    current.status = 'sms_sent';
    current.providerStatus = 'LOCAL_SMS_SENT';
    current.providerMarkedSent = true;
    current.providerMarkedAt = new Date().toISOString();
    return current;
  }

  async requestAnotherCode() {
    throw new FirefoxFunError('Firefox.fun does not support same-number OAuth resends', { code: 'FIREFOX_SMS_RESEND_UNSUPPORTED', replacePhone: true, category: 'lifecycle' });
  }

  async complete(lease) {
    const current = this.remember(lease);
    current.status = 'complete';
    current.providerStatus = 'LOCAL_COMPLETE_AFTER_CODE';
    current.completedAt = new Date().toISOString();
    return current;
  }

  async cancel(lease, reason = '') {
    const current = this.remember(lease);
    if (current.codeReceived || current.status === 'code_received' || current.targetAccepted) {
      current.status = 'closed_after_code';
      current.providerStatus = 'LOCAL_CLOSED_AFTER_CODE';
      current.cancelReason = reason;
      current.cancelledAt = new Date().toISOString();
      return current;
    }
    try {
      await this.authenticatedRequest('setRel', { pkey: current.pkey || current.id });
    } catch (error) {
      if (['FIREFOX_CODE_ALREADY_RECEIVED', 'FIREFOX_SMS_ALREADY_SENT', 'FIREFOX_PHONE_RELEASED', 'FIREFOX_TOKEN_INVALID'].includes(error.code)) {
        current.status = 'closed_after_provider_status';
        current.providerStatus = error.code;
        current.cancelReason = reason;
        current.cancelledAt = new Date().toISOString();
        return current;
      }
      throw error;
    }
    current.status = 'cancelled';
    current.providerStatus = 'PHONE_RELEASED';
    current.cancelReason = reason;
    current.cancelledAt = new Date().toISOString();
    return current;
  }

  async reconcile(lease) {
    const current = this.remember(lease);
    if (['complete', 'cancelled', 'closed_after_code', 'closed_after_provider_status'].includes(current.status)) return current;
    const result = await this.readCode(current);
    if (result) return this.leases.get(current.id) || { ...current, ...result, codeReceived: true };
    return { ...current, status: 'waiting_code', providerStatus: 'WAIT_CODE', reconciledAt: new Date().toISOString() };
  }

  async listCountriesForConfig() {
    return this.listCountries();
  }

  snapshot() {
    return [...this.leases.values()].map(serializable);
  }

  restoreLeases(leases) {
    for (const lease of Array.isArray(leases) ? leases : Object.values(leases || {})) this.remember(lease);
    return this.snapshot();
  }

  async release(lease, reason = '') {
    return this.cancel(lease, reason);
  }

  async ban(lease, reason = '') {
    return this.cancel(lease, reason);
  }
}

module.exports = {
  FirefoxFunProvider,
};
