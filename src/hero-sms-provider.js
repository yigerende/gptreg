'use strict';

const { SmsBowerProvider, SmsBowerError, parseRetryAfterMs } = require('./sms-provider');

const DEFAULT_HERO_SMS_URL = 'https://hero-sms.com/stubs/handler_api.php';

// Hero-SMS uses the SMS-Activate protocol for catalog/purchase/polling. Lifecycle
// writes use the v1 API already used by Space; only HTTP 204 confirms settlement.
class HeroSmsProvider extends SmsBowerProvider {
  constructor(options = {}) {
    super({ ...options, baseUrl: options.baseUrl || DEFAULT_HERO_SMS_URL, apiKeyEnv: options.apiKeyEnv || 'HERO_SMS_API_KEY' });
    this.name = 'hero-sms';
    const transport = this.fetch;
    // Buffer under the request's abort signal: a response whose headers arrived
    // but whose body stalled is still an uncertain purchase, never a retry.
    this.fetch = async (url, init) => {
      const response = await transport(url, { ...init, redirect: 'error' });
      const body = await response.text();
      return { status: response.status, headers: response.headers, text: async () => body };
    };
    if (!this.requestedCountries.length) this.country = '';
  }

  getApiKey() {
    const key = String(this.apiKey || process.env[this.apiKeyEnv] || '').trim();
    if (!key) throw new SmsBowerError('Hero-SMS API Key 未配置', { code: 'BAD_KEY' });
    return key;
  }

  async request(action, params = {}, options = {}) {
    try {
      if (action === 'setStatus' && [6, 8].includes(Number(params.status))) {
        const lease = await this.lifecycle({ id: params.id }, Number(params.status) === 6);
        return lease.providerStatus;
      }
      // Do not retry a purchase through a second endpoint after a timeout.
      const result = await super.request(action === 'getNumberV2' ? 'getNumber' : action, params, options);
      if (action === 'getNumberV2' && typeof result === 'string') {
        const match = /^ACCESS_NUMBER:([^:]+):([^:]+)$/.exec(result);
        if (!match) throw new SmsBowerError('Hero-SMS 取号响应缺少激活ID或号码', { code: 'INVALID_NUMBER_RESPONSE' });
        return { activationId: match[1], phoneNumber: match[2] };
      }
      return result;
    } catch (error) {
      // Handler errors may echo the entire query, including api_key.
      const key = this.apiKey || process.env[this.apiKeyEnv] || '';
      let message = String(error.message || 'Hero-SMS 请求失败').replaceAll('SMSBower', 'Hero-SMS');
      if (key) message = message.replaceAll(key, '[redacted]').replaceAll(encodeURIComponent(key), '[redacted]');
      error.message = message.replace(/(api_key=)[^&\s]+/gi, '$1[redacted]');
      delete error.response;
      delete error.cause;
      throw error;
    }
  }

  async getPrices(options = {}) {
    const country = String(options.country ?? this.country);
    const service = String(options.service ?? this.service);
    const payload = await this.request('getPrices', { country, service });
    const source = payload?.data || payload;
    if (!source || typeof source !== 'object') throw new SmsBowerError('Hero-SMS 报价响应格式无效', { code: 'INVALID_PRICE_RESPONSE' });
    if (Array.isArray(source)) return source.filter((p) => String(p.country ?? country) === country && String(p.service ?? service) === service);
    const offer = source?.[country]?.[service];
    if (!offer || typeof offer !== 'object') return [];
    if (offer.cost !== undefined || offer.price !== undefined) return [{ country, service, ...offer }];
    return Object.entries(offer).filter(([, p]) => p && typeof p === 'object')
      .map(([providerId, p]) => ({ country, service, providerId, ...p }));
  }

  async getCountries() {
    const countries = await super.getCountries();
    if (!countries.length || countries.some((c) => !/^\d+$/.test(c.id))) throw new SmsBowerError('Hero-SMS 国家目录响应格式无效', { code: 'INVALID_COUNTRIES_RESPONSE' });
    return countries;
  }

  async preflight(options = {}) {
    if (!this.requestedCountries.length) throw new SmsBowerError('请至少勾选一个 Hero-SMS 国家', { code: 'WRONG_COUNTRY' });
    return super.preflight(options);
  }

  async acquireNumber(job = {}) {
    if (!this.requestedCountries.length) throw new SmsBowerError('请至少勾选一个 Hero-SMS 国家', { code: 'WRONG_COUNTRY' });
    if (!this.countryMarkets.length) await this.preflight();
    return super.acquireNumber(job);
  }

  async acquireNumberForCountry(candidate, job = {}, service = this.service) {
    const cap = Math.min(Number(job.maxPrice ?? this.maxPrice), Number(this.maxPrice));
    const cheapest = candidate.market?.cheapestPrice;
    if (!(cap > 0) || cheapest == null || !(cheapest >= 0) || cheapest > cap) {
      throw new SmsBowerError('Hero-SMS 所选国家没有预算内的报价', { code: 'MAX_PRICE_TOO_LOW' });
    }
    // Randomize countries first (the shared selector), then bound the purchase
    // to that country's cheapest available quote. Never raise the user's cap.
    const lease = await super.acquireNumberForCountry(candidate, { ...job, maxPrice: Math.min(cap, cheapest) }, service);
    lease.quotedCost = cheapest;
    lease.acquisitionId = job.acquisitionId || '';
    return lease;
  }

  async lifecycle(lease, finish) {
    const id = String(lease.activationId || lease.id || '');
    if (!id) throw new SmsBowerError('Hero-SMS 激活ID缺失', { code: 'INVALID_ACTIVATION_ID' });
    const url = new URL(this.baseUrl);
    url.pathname = `/api/v1/activations/${encodeURIComponent(id)}${finish ? '/finish' : ''}`;
    url.search = ''; url.hash = '';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await this.fetch(url.toString(), {
        method: finish ? 'POST' : 'DELETE', redirect: 'error',
        headers: { Authorization: `ApiKey ${this.getApiKey()}`, Accept: 'application/json' }, signal: controller.signal,
      });
      if (response.status !== 204) {
        const text = await response.text();
        const code = /EARLY_CANCEL_DENIED/i.test(text) ? 'EARLY_CANCEL_DENIED'
          : [401, 403].includes(response.status) ? 'BAD_KEY' : `HTTP_${response.status}`;
        throw new SmsBowerError(`Hero-SMS ${finish ? '完成' : '取消'}未获确认（HTTP ${response.status}）`, {
          code, httpStatus: response.status, retryAfterMs: parseRetryAfterMs(response.headers?.get?.('retry-after')),
        });
      }
      const current = this.leases.get(id) || this.restoreLease(lease);
      Object.assign(current, { status: finish ? 'complete' : 'cancelled', providerStatus: finish ? 'ACCESS_ACTIVATION' : 'ACCESS_CANCEL', updatedAt: new Date().toISOString() });
      return current;
    } catch (error) {
      if (error instanceof SmsBowerError) throw error;
      const failure = new SmsBowerError('Hero-SMS 生命周期请求超时或连接失败，需核实原激活状态', { code: 'NETWORK_ERROR' });
      failure.category = 'transient'; failure.retryable = true;
      throw failure;
    } finally { clearTimeout(timer); }
  }

  async complete(lease) { return this.lifecycle(lease, true); }
  async cancel(lease, reason = '') { const current = await this.lifecycle(lease, false); current.cancelReason = reason; return current; }

  async reconcileAcquisition(intent) {
    const lease = [...this.leases.values()].find((l) => l.acquisitionId === intent.id);
    // There is no documented idempotency key on getNumber. Never attribute a
    // different concurrent purchase to this intent or buy again speculatively.
    return lease ? { status: 'acquired', lease } : { status: 'uncertain' };
  }
}

module.exports = { HeroSmsProvider, DEFAULT_HERO_SMS_URL };
