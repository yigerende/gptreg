'use strict';

const HERO_URL = 'https://hero-sms.com/stubs/handler_api.php';
const PROVIDERS = ['smsbower', 'firefox', 'hero-sms'];

function normalizeHero(input = {}, strict = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Hero-SMS 配置格式无效');
  let url;
  try { url = new URL(input.baseUrl || HERO_URL); } catch { throw new Error('Hero-SMS 接口地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Hero-SMS 接口地址不能包含密钥或查询参数');
  const service = String(input.service?.code ?? input.service ?? 'dr').trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(service)) throw new Error('Hero-SMS 服务代码无效');
  const maxPrice = Number(input.maxPrice ?? 1);
  if (!Number.isFinite(maxPrice) || maxPrice <= 0) throw new Error('Hero-SMS 最高单价必须大于0');
  const countries = (Array.isArray(input.countries) ? input.countries : []).map((c) => {
    const id = String(c?.id ?? c).trim();
    if (!/^\d+$/.test(id)) throw new Error('Hero-SMS 国家ID无效');
    return { id, ...(c && typeof c === 'object' ? { name: String(c.name || ''), dialingCode: String(c.dialingCode || '') } : {}) };
  }).filter((c, i, a) => a.findIndex((v) => v.id === c.id) === i);
  if (strict && !countries.length) throw new Error('请至少勾选一个 Hero-SMS 国家');
  const codeTimeoutMs = Number(input.codeTimeoutMs ?? 120000);
  if (!Number.isInteger(codeTimeoutMs) || codeTimeoutMs < 1000 || codeTimeoutMs > 3600000) throw new Error('验证码等待时间必须为1～3600秒');
  return { ...input, baseUrl: url.toString(), apiKey: String(input.apiKey || '').trim(), apiKeyEnv: 'HERO_SMS_API_KEY', service: { code: service }, countries, country: countries[0] || {}, maxPrice, codeTimeoutMs };
}

function effectiveSmsConfig(raw = {}, provider = raw.provider || 'smsbower') {
  if (provider === 'hero-sms') return { ...raw, ...normalizeHero(raw.hero), provider, hero: normalizeHero(raw.hero) };
  if (provider === 'firefox') return { ...raw, ...(raw.firefox || {}), provider, firefox: raw.firefox || {} };
  return { ...raw, ...(raw.smsbower || {}), provider, baseUrl: raw.smsbower?.baseUrl || raw.baseUrl || 'https://smsbower.page/stubs/handler_api.php' };
}

function smsFailure(error) {
  const code = String(error?.code || '');
  const status = Number(error?.httpStatus || error?.status || 0);
  if (['BAD_KEY', 'ACCOUNT_INACTIVE', 'BANNED', 'FIREFOX_TOKEN_INVALID', 'FIREFOX_CREDENTIALS_MISSING'].includes(code) || [401, 403].includes(status)) return { code: 'AUTH_FAILED', message: '密钥无效、未配置或账号权限不足' };
  if (error?.name === 'AbortError' || /timeout|timed out/i.test(error?.message || '')) return { code: 'TIMEOUT', message: '短信接口请求超时，请检查服务器网络' };
  if (code === 'NO_BALANCE') return { code, message: '短信平台余额不足' };
  if (status === 429) return { code: 'RATE_LIMIT', message: '短信平台请求限流，请稍后重试' };
  if (['NO_NUMBERS', 'SMS_INVENTORY_EMPTY'].includes(code)) return { code: 'NO_STOCK', message: '所选国家当前暂无库存' };
  if (code === 'MAX_PRICE_TOO_LOW') return { code, message: '当前报价超过最高单价' };
  return { code: 'CONNECTION_FAILED', message: '短信接口查询失败，请检查接口地址、服务项目和服务器网络' };
}

module.exports = { PROVIDERS, HERO_URL, normalizeHero, effectiveSmsConfig, smsFailure };
