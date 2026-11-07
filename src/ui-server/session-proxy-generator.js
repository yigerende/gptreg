'use strict';
const { fault } = require('../platform/session-proxy-config');
const { executePureHttpUrl } = require('../pure-url');
const API = 'https://resi-api.iproyal.com/v1';
function invalid() { return fault('SESSION_PROXY_GENERATION_FAILED', 'IPRoyal 返回的会话格式、地区或协议不符合配置', 502); }
function parseGeneratedProxy(value, config, country) {
  if (typeof value !== 'string') throw invalid();
  const parts = /^([^:]+):(\d+):([^:]+):(.+)$/.exec(value);
  if (!parts) throw invalid();
  const [, host, port, username, password] = parts;
  const options = Object.fromEntries([...password.matchAll(/_(country|session|lifetime)-([^_]+)/g)].map(m => [m[1], m[2]]));
  const duration = /^(\d+)([smhd])$/.exec(options.lifetime || '');
  const seconds = duration ? Number(duration[1]) * { s: 1, m: 60, h: 3600, d: 86400 }[duration[2]] : 0;
  if (host !== 'geo.iproyal.com' || Number(port) !== (config.protocol === 'socks5' ? 32325 : 12321)
    || options.country?.toUpperCase() !== country || !/^[a-zA-Z0-9]{8}$/.test(options.session || '')
    || seconds !== config.lifetimeMinutes * 60 || /[\r\n\0]/.test(value)) throw invalid();
  const endpoint = `${config.protocol}://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
  return { endpoint, sessionId: options.session };
}
class SessionProxyGenerator {
  constructor({ fetch: request = globalThis.fetch, executor = executePureHttpUrl } = {}) { this.fetch = request; this.executor = executor; }
  async api(config, path, body, signal) {
    const controller = AbortSignal.timeout(30000);
    try {
      const response = await this.fetch(API + path, { method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { Authorization: `Bearer ${config.apiToken}`, Accept: 'application/json', 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: signal ? AbortSignal.any([signal, controller]) : controller });
      if (!response.ok) throw fault('SESSION_PROXY_GENERATION_FAILED', `IPRoyal 请求失败（HTTP ${response.status}）`, 502);
      const text = await response.text();
      if (text.length > 8 * 1024 * 1024) throw invalid();
      return JSON.parse(text);
    } catch (error) {
      if (error.code === 'SESSION_PROXY_GENERATION_FAILED') throw error;
      throw fault('SESSION_PROXY_GENERATION_FAILED', 'IPRoyal 请求超时、网络异常或响应无法读取', 502);
    }
  }
  async countries(config, signal) {
    const result = await this.api(config, '/access/countries', null, signal);
    const rows = result.countries || result.data?.countries;
    if (!Array.isArray(rows)) throw invalid();
    const names = new Intl.DisplayNames(['zh-CN'], { type: 'region' });
    return rows.filter(r => /^[a-zA-Z]{2}$/.test(r.code)).map(r => {
      const code = r.code.toUpperCase(); return { code, name: names.of(code) || r.name || code };
    });
  }
  async generate(config, country, signal) {
    const minutes = config.lifetimeMinutes;
    const body = { format: '{hostname}:{port}:{username}:{password}', hostname: 'geo.iproyal.com',
      port: config.protocol === 'socks5' ? 'socks5' : 'http|https', rotation: 'sticky', location: `_country-${country.toLowerCase()}`,
      proxy_count: 1, lifetime: minutes % 60 === 0 ? `${minutes / 60}h` : `${minutes}m`,
      ...(config.authType === 'subuser' ? { subuser_hash: config.subuserHash } : { username: config.username, password: config.password }) };
    const data = await this.api(config, '/access/generate-proxy-list', body, signal);
    if (!Array.isArray(data) || data.length !== 1) throw invalid();
    return parseGeneratedProxy(data[0], config, country);
  }
  async probe(endpoint, signal) {
    const started = Date.now();
    try {
      const response = await this.executor({ method: 'GET', url: 'https://api.ipify.org?format=json', headers: { Accept: 'application/json' }, body: '', cookies: {} },
        { proxy: endpoint, timeoutMs: 15000, signal, name: 'session_proxy_probe' });
      const r = response.response || response;
      const data = typeof r.text === 'string' ? JSON.parse(r.text) : r.body;
      if (r.status !== 200 || !require('node:net').isIP(data?.ip)) throw invalid();
      return { exitIp: data.ip, latencyMs: Date.now() - started, checkedAt: new Date().toISOString(), status: 'healthy' };
    } catch { throw fault('SESSION_PROXY_PROBE_FAILED', '代理连通测试失败，请检查账号、协议和供应商状态', 502); }
  }
}
module.exports = { SessionProxyGenerator, parseGeneratedProxy };
