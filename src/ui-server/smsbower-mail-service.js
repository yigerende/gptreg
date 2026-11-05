'use strict';

const { SmsbowerMailClient, DEFAULT_BASE_URL } = require('../smsbower-mail-client');
const { secretFromEnv } = require('../config-v2');
const { HttpError } = require('./utils');
const { createSmsProvider } = require('../sms-provider');

class SmsbowerMailService {
  constructor(configService, options = {}) {
    this.configService = configService;
    this.fetch = options.fetch;
    this.statusCache = null;
  }

  savedKey() {
    try { return secretFromEnv(this.configService.normalized().mail, 'apiKeyEnv'); } catch { return ''; }
  }

  read() {
    const mail = this.configService.readRaw().mail || {};
    return {
      baseUrl: mail.smsbowerBaseUrl || DEFAULT_BASE_URL,
      service: mail.service || 'dr',
      domain: 'gmail.com',
      maxPrice: Number(mail.maxPrice || 0),
      apiKeyConfigured: Boolean(this.savedKey()),
      dedicatedApiKey: Boolean(String(mail.apiKey || '').trim()),
    };
  }

  settings(input, { saving = false } = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, '请填写邮箱接口配置');
    const current = this.read();
    const value = { ...current, ...input };
    let endpoint;
    try { endpoint = new URL(value.baseUrl); } catch { throw new HttpError(400, '请输入完整的邮箱 API 地址'); }
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new HttpError(400, '邮箱 API 地址仅支持 HTTP / HTTPS，不能包含密钥或查询参数');
    }
    const service = String(value.service || '').trim();
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(service)) throw new HttpError(400, '请填写有效的邮箱服务代码，例如 dr');
    const maxPrice = Number(value.maxPrice);
    if (!Number.isFinite(maxPrice) || maxPrice < 0 || maxPrice > 5 || (saving && maxPrice === 0)) {
      throw new HttpError(400, '邮箱单价上限必须大于 0 且不超过 5 USD');
    }
    if (value.apiKey !== undefined && (typeof value.apiKey !== 'string' || value.apiKey.length > 4096)) {
      throw new HttpError(400, 'API Key 格式无效');
    }
    const enteredKey = String(value.apiKey || '').trim();
    return { baseUrl: endpoint.toString().replace(/\/+$/, ''), service, maxPrice, enteredKey, apiKey: enteredKey || this.savedKey() };
  }

  save(input) {
    const value = this.settings(input, { saving: true });
    this.configService.update({
      config: { mail: { smsbowerBaseUrl: value.baseUrl, service: value.service, maxPrice: value.maxPrice } },
      secretPatch: value.enteredKey ? { mailApiKey: value.enteredKey } : {},
    });
    return this.read();
  }

  async status() {
    const value = this.settings({});
    const key = JSON.stringify([value.baseUrl, value.apiKey, value.service, value.maxPrice]);
    if (this.statusCache?.key === key && this.statusCache.until > Date.now()) return this.statusCache.promise;
    const promise = (async () => {
      const result = { provider: 'smsbower', currency: 'USD', balance: null, stock: null, unitPrice: null, checkedAt: new Date().toISOString() };
      if (!value.apiKey) return { ...result, message: '邮箱 API Key 未配置' };
      const client = new SmsbowerMailClient({ ...value, domain: 'gmail.com', fetch: this.fetch, stockRetryAttempts: 1, requestTimeoutMs: 10000 });
      // SMSBower mail and SMS share the account balance API. Use the MAIL key,
      // including when SMS is configured with a different provider/account.
      const balanceClient = createSmsProvider({ provider: 'smsbower', apiKey: value.apiKey,
        baseUrl: new URL('/stubs/handler_api.php', value.baseUrl).href, fetch: this.fetch, requestTimeoutMs: 10000 });
      const [stock, balance] = await Promise.allSettled([client.priceRests(), balanceClient.getBalance()]);
      if (stock.status === 'fulfilled') { result.stock = stock.value.count; result.unitPrice = stock.value.price; }
      if (balance.status === 'fulfilled') result.balance = balance.value;
      return { ...result, stockError: stock.status === 'rejected', balanceError: balance.status === 'rejected',
        message: stock.status === 'rejected' || balance.status === 'rejected' ? '部分数据读取失败，请检查邮箱接口配置后刷新' : 'SMSBower 邮箱账户 · USD' };
    })();
    this.statusCache = { key, promise, until: Date.now() + 65000 };
    try { return await promise; } catch (error) { this.statusCache = null; throw error; }
  }

  async test(input) {
    const value = this.settings(input);
    if (!value.apiKey) throw new HttpError(400, '请填写邮箱 API Key，或先配置 SMSBower 平台密钥');
    const started = Date.now();
    const client = new SmsbowerMailClient({
      ...value, domain: 'gmail.com', fetch: this.fetch,
      stockRetryAttempts: 1, requestTimeoutMs: 10_000,
    });
    try {
      // Only reads stock/price. Never creates or settles a mailbox activation.
      const stock = await client.priceRests();
      return {
        ok: true, message: '连接成功', ...stock,
        withinBudget: value.maxPrice > 0 && stock.price <= value.maxPrice,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      // Provider bodies and transport errors can echo api_key. Return only
      // classified diagnostics, never the raw request, response, or secret.
      const status = Number(error.status || 0);
      const authFailed = [401, 403].includes(status) || /no access|unauthor|api.?key|auth|token/i.test([error.message, error.response?.message, error.response?.error].join(' '));
      const timeout = error.code === 'MAIL_PROVIDER_TIMEOUT' || error.name === 'AbortError';
      const rejected = /^MAIL_STOCK_RESPONSE_/.test(String(error.code || ''));
      return {
        ok: false,
        code: authFailed ? 'AUTH_FAILED' : timeout ? 'TIMEOUT' : rejected ? 'STOCK_UNAVAILABLE' : 'CONNECTION_FAILED',
        message: authFailed ? '接口拒绝访问，请检查 API Key 和账号权限'
          : timeout ? '请求超时，请检查接口地址和本机代理'
            : rejected ? '接口未返回所选服务的 Gmail 库存，请检查服务代码或稍后重试'
              : `连接失败${status ? `（HTTP ${status}）` : ''}，请检查邮箱 API 地址和代理设置`,
        httpStatus: status, latencyMs: Date.now() - started,
      };
    }
  }
}

module.exports = { SmsbowerMailService };
