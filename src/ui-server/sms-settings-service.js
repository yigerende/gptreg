'use strict';

const { createSmsProvider } = require('../sms-provider');
const { PROVIDERS, normalizeHero, effectiveSmsConfig, smsFailure } = require('../sms-settings');
const { getFirefoxFunCredentials } = require('../firefox-fun-credentials');
const { summarizeSmsPreflight } = require('../preflight-resources');
const { HttpError } = require('./utils');

class SmsSettingsService {
  constructor(configService, options = {}) { this.configService = configService; this.fetch = options.fetch; }
  check(provider) { if (!PROVIDERS.includes(provider)) throw new HttpError(400, '不支持的短信厂商'); }
  saved(provider) {
    this.check(provider);
    const raw = this.configService.readRaw().sms || {};
    const value = effectiveSmsConfig(raw, provider);
    if (provider === 'firefox') value.apiKey = raw.firefox?.token || getFirefoxFunCredentials().token;
    return value;
  }
  read(provider) {
    const v = this.saved(provider);
    return {
      provider, active: (this.configService.readRaw().sms?.provider || 'smsbower') === provider,
      baseUrl: v.baseUrl || '', service: provider === 'firefox' ? '1096' : String(v.service?.code || v.service || 'dr'),
      countries: provider === 'firefox' ? v.firefox?.countries || [] : v.countries || [],
      maxPrice: v.maxPrice ?? null, codeTimeoutMs: v.codeTimeoutMs || 120000,
      apiKeyConfigured: Boolean(v.apiKey || (v.apiKeyEnv && process.env[v.apiKeyEnv])), currency: provider === 'firefox' ? 'CNY' : 'USD',
    };
  }
  settings(provider, input = {}, saving = false) {
    this.check(provider);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, '短信配置格式无效');
    if (input.apiKey !== undefined && (typeof input.apiKey !== 'string' || input.apiKey.length > 4096)) throw new HttpError(400, 'API Key 格式无效');
    const saved = this.saved(provider);
    const draft = { ...this.read(provider), ...Object.fromEntries(['baseUrl', 'service', 'countries', 'maxPrice', 'codeTimeoutMs'].filter((k) => Object.hasOwn(input, k)).map((k) => [k, input[k]])) };
    const key = String(input.apiKey || '').trim() || saved.apiKey || (saved.apiKeyEnv && process.env[saved.apiKeyEnv]) || '';
    let value;
    try {
      if (provider === 'hero-sms') value = normalizeHero({ ...draft, apiKey: key }, saving);
      else if (provider === 'firefox') {
        value = { ...draft, baseUrl: 'https://firefox.fun/yhapi.ashx', token: key, iid: '1096', countryMode: 'cheapest' };
        if (value.maxPrice !== '' && value.maxPrice != null && (!Number.isFinite(Number(value.maxPrice)) || Number(value.maxPrice) < 0)) throw new Error('最高单价格式无效');
      } else {
        const u = new URL(draft.baseUrl);
        if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error('接口地址不能包含密钥或查询参数');
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(String(draft.service))) throw new Error('服务代码无效');
        if (!(Number(draft.maxPrice) > 0) || Number(draft.maxPrice) > 0.1) throw new Error('SMSBower 最高单价必须大于0且不超过0.1 USD');
        if (!Array.isArray(draft.countries) || (saving && !draft.countries.length)) throw new Error('请至少勾选一个国家');
        value = { ...draft, apiKey: key, service: { code: draft.service }, country: draft.countries[0] || {} };
      }
      if (!Number.isInteger(Number(value.codeTimeoutMs)) || Number(value.codeTimeoutMs) < 1000 || Number(value.codeTimeoutMs) > 3600000) throw new Error('验证码等待时间必须为1～3600秒');
    } catch (error) { throw new HttpError(400, error.message); }
    return { ...value, provider, fetch: this.fetch, preflightAttempts: 1, requestTimeoutMs: 10000 };
  }
  save(provider, input) {
    if (input.activate !== undefined && typeof input.activate !== 'boolean') throw new HttpError(400, '切换厂商参数无效');
    const v = this.settings(provider, input, true);
    const publicFields = Object.fromEntries(['baseUrl', 'service', 'countries', 'country', 'maxPrice', 'codeTimeoutMs'].map((k) => [k, v[k]]).filter(([, x]) => x !== undefined));
    const key = String(input.apiKey || '').trim();
    const sms = input.activate === false ? {} : { provider };
    if (provider === 'hero-sms') sms.hero = publicFields;
    else if (provider === 'firefox') sms.firefox = publicFields;
    else Object.assign(sms, publicFields);
    return this.configService.update({ config: { sms }, secretPatch: key ? { [provider === 'hero-sms' ? 'heroSmsApiKey' : provider === 'firefox' ? 'firefoxToken' : 'smsApiKey']: key } : {} });
  }
  async countries(provider, input = {}) {
    const client = createSmsProvider(this.settings(provider, input));
    try {
      const countries = provider === 'firefox' ? await client.listCountriesForConfig() : await client.getCountries();
      if (!countries.length) throw new Error('Empty country catalog');
      return { ok: true, provider, countries, message: `已刷新 ${countries.length} 个国家，原有勾选保持不变。` };
    } catch (error) { return { ok: false, provider, ...smsFailure(error) }; }
  }
  async quotes(provider, input = {}) {
    const config = this.settings(provider, input);
    const selectors = config.countries;
    const firefox = provider === 'firefox';
    const validId = firefox ? /^[a-z]{3}$/ : /^\d+$/;
    if (!Array.isArray(selectors) || !selectors.length || selectors.length > (firefox ? 500 : 8)
      || selectors.some(c => !validId.test(String(firefox ? c?.code : c?.id))))
      throw new HttpError(400, firefox ? '请选择1～500个有效国家查询报价' : '每批请选择1～8个有效国家查询报价');
    const client = createSmsProvider(config);
    let market;
    if (firefox) {
      // The public catalog has prices but no live inventory. Never fabricate stock.
      let catalog = [], issue = '';
      try { catalog = await client.listCountriesForConfig(); }
      catch (error) { issue = smsFailure(error).code; }
      const byCode = new Map(catalog.map(c => [c.code, c]));
      market = { countries: selectors.map(country => {
        const entry = byCode.get(country.code);
        return { id: country.code, country, cheapestPrice: entry?.price ?? null, inventory: null, affordableInventory: null,
          publicQuote: true, issue: issue || (entry ? '' : 'SMS_INVENTORY_EMPTY') };
      }) };
    } else {
      const rows = new Array(selectors.length);
      let next = 0;
      // Bound both per-request work and supplier concurrency. The UI sends batches.
      await Promise.all(Array.from({ length: Math.min(4, selectors.length) }, async () => {
        while (next < selectors.length) {
          const index = next++, country = { id: String(selectors[index].id) };
          let prices = [], issue = '';
          try {
            prices = (await client.getPrices({ country: country.id, service: client.service }))
              .filter(p => (p.country == null || String(p.country) === country.id) && (p.service == null || String(p.service) === client.service));
          } catch (error) { issue = smsFailure(error).code; }
          rows[index] = { country, prices, issue };
        }
      }));
      market = summarizeSmsPreflight({ countries: rows }, config);
    }
    for (const row of market.countries) row.message = row.issue ? '请检查国家报价或接口配置' : '';
    const failed = market.countries.some(c => c.issue && !['SMS_PRICE_ABOVE_MAX', 'SMS_INVENTORY_EMPTY'].includes(c.issue));
    return { ok: true, provider, currency: firefox ? 'CNY' : 'USD', market, message: failed ? '部分报价查询失败，请重试' : '已查询国家报价' };
  }
  async test(provider, input = {}) {
    const config = this.settings(provider, input);
    // Pass only this provider's settings: nested copies from another provider
    // must not override a draft key or the selected countries.
    const client = createSmsProvider(config);
    const started = Date.now();
    try {
      const balance = await client.getBalance({ fresh: true });
      const countries = provider === 'firefox' ? await client.listCountriesForConfig() : await client.getCountries();
      let market = null;
      let marketError = null;
      if (input.skipQuotes !== true && (config.countries?.length || provider === 'firefox')) {
        try { market = provider === 'firefox'
          ? (await this.quotes(provider, { ...input, countries: config.countries?.length ? config.countries : countries })).market
          : summarizeSmsPreflight(await client.preflight({ checkBalance: false }), config); }
        catch (error) { marketError = smsFailure(error); }
      }
      if (market) {
        for (const country of market.countries || []) country.message = country.issue ? '请检查国家报价或接口配置' : '';
      }
      return { ok: true, message: '连接成功；测试不会购买号码', provider, balance, currency: provider === 'firefox' ? 'CNY' : 'USD', countries, market, marketError, latencyMs: Date.now() - started };
    } catch (error) { return { ok: false, provider, ...smsFailure(error), latencyMs: Date.now() - started }; }
  }
}

module.exports = { SmsSettingsService };
