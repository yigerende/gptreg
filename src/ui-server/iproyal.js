'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { cipher, loadSecrets } = require('../platform/security');
const { parseProxyLine, stableProxyId } = require('../proxy-pool');
const { atomicWriteText, HttpError } = require('./utils');

class IPRoyalError extends Error {}

class IPRoyalCredentials {
  constructor(cwd) { this.cwd = cwd; this.file = path.join(cwd, '.runtime', 'iproyal-credentials.json'); }

  crypt() { return cipher(loadSecrets(this.cwd).master); }

  read() {
    let text;
    try { text = fs.readFileSync(this.file, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
    try { return this.crypt().decrypt(JSON.parse(text).encrypted); }
    catch { throw new HttpError(500, 'IPRoyal 凭据无法读取，请检查主密钥和配置文件'); }
  }

  snapshot() {
    const value = this.read();
    return {
      authMode: value.authMode || 'credentials', username: value.username || '', subuserHash: value.subuserHash || '',
      apiTokenConfigured: Boolean(value.apiToken), passwordConfigured: Boolean(value.password),
    };
  }

  prepare(patch = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new HttpError(400, 'IPRoyal 配置格式无效');
    const value = { ...this.read() };
    for (const key of ['apiToken', 'username', 'password', 'subuserHash', 'authMode']) {
      if (patch[key] === undefined) continue;
      if (typeof patch[key] !== 'string' || patch[key].length > 4096 || /[\r\n\u0000]/.test(patch[key])) throw new HttpError(400, 'IPRoyal 配置包含无效字段');
      // Secret inputs stay blank after saving. Blank means retain the saved secret.
      if ((key === 'apiToken' || key === 'password') && !patch[key].trim()) continue;
      value[key] = key === 'password' ? patch[key] : patch[key].trim();
    }
    value.authMode ||= 'credentials';
    if (!['credentials', 'subuser'].includes(value.authMode)) throw new HttpError(400, '请选择 IPRoyal 代理认证方式');
    if (!value.apiToken || /\s/.test(value.apiToken)) throw new HttpError(400, '请填写 IPRoyal API Token（不含 Bearer 前缀）');
    if (value.authMode === 'subuser') {
      if (!value.subuserHash || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.subuserHash)) throw new HttpError(400, '请填写有效的 IPRoyal 子用户 ID');
    } else if (!value.username || !value.password) throw new HttpError(400, '请填写 IPRoyal 代理账号和代理密码');
    return value;
  }

  save(value) {
    atomicWriteText(this.file, JSON.stringify({ encrypted: this.crypt().encrypt(value) }) + '\n');
    fs.chmodSync(this.file, 0o600);
  }

  request(source) {
    const value = this.prepare();
    return {
      method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', Authorization: `Bearer ${value.apiToken}` },
      body: JSON.stringify({
        format: '{hostname}:{port}:{username}:{password}', hostname: 'geo.iproyal.com',
        port: source.protocol === 'socks5' ? 'socks5' : 'http|https', rotation: 'sticky',
        location: source.countryCode === 'GLOBAL' ? '' : `_country-${source.countryCode.toLowerCase()}`,
        proxy_count: source.count, lifetime: `${source.sessionMinutes}m`,
        ...(value.authMode === 'subuser' ? { subuser_hash: value.subuserHash } : { username: value.username, password: value.password }),
      }),
    };
  }
}

function parseIPRoyalResponse(content, protocol) {
  let rows;
  try { rows = JSON.parse(content); } catch { throw new IPRoyalError('IPRoyal 返回了无效的 JSON 代理列表'); }
  if (!Array.isArray(rows)) throw new IPRoyalError('IPRoyal 未返回代理列表，请检查 API 配置和供应商状态');
  const entries = [], errors = [], seen = new Set();
  rows.forEach((row, index) => {
    // Parse the requested format ourselves: passwords can contain ':' or '#'.
    const parts = typeof row === 'string' && row.match(/^(\[[^\]]+\]|[^:]+):(\d+):([^:]+):(.+)$/);
    try {
      if (!parts || /[\s/?#@]/.test(parts[1]) || /[\r\n]/.test(row) || Number(parts[2]) < 1 || Number(parts[2]) > 65535) throw new Error('invalid');
      const entry = parseProxyLine(`${protocol}://${encodeURIComponent(parts[3])}:${encodeURIComponent(parts[4])}@${parts[1]}:${parts[2]}`);
      if (seen.has(entry.url)) return;
      seen.add(entry.url);
      entries.push({ ...entry, id: stableProxyId(entry.url) });
    } catch { errors.push({ line: index + 1, message: 'IPRoyal 返回的代理格式或端口无效' }); }
  });
  return { entries, errors };
}

function iproyalHttpError(status) {
  const detail = status === 401 ? 'API Token 无效或已过期' : status === 403 ? '账户没有访问权限'
    : status === 422 || status === 400 ? '请求参数被拒绝，请检查代理认证、国家、数量和粘性时间'
      : status === 429 ? '请求过于频繁，请稍后重试' : '供应商请求失败';
  return `IPRoyal ${detail}（HTTP ${status}）`;
}

module.exports = { IPRoyalCredentials, IPRoyalError, parseIPRoyalResponse, iproyalHttpError };
