'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isIP } = require('node:net');
const { cipher, loadSecrets } = require('../platform/security');
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
      authMode: 'whitelist', whitelistIp: value.whitelistIp || '',
      apiTokenConfigured: Boolean(value.apiToken),
    };
  }

  prepare(patch = {}) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new HttpError(400, 'IPRoyal 配置格式无效');
    const value = { ...this.read() };
    for (const key of ['apiToken', 'whitelistIp']) {
      if (patch[key] === undefined) continue;
      if (typeof patch[key] !== 'string' || patch[key].length > 4096 || /[\r\n\u0000]/.test(patch[key])) throw new HttpError(400, 'IPRoyal 配置包含无效字段');
      // Secret inputs stay blank after saving. Blank means retain the saved secret.
      if (key === 'apiToken' && !patch[key].trim()) continue;
      value[key] = patch[key].trim();
    }
    value.authMode = 'whitelist';
    if (!value.apiToken || /\s/.test(value.apiToken)) throw new HttpError(400, '请填写 IPRoyal API Token（不含 Bearer 前缀）');
    if (value.whitelistIp && !isIP(value.whitelistIp)) throw new HttpError(400, '白名单 IP 格式无效');
    return value;
  }

  save(value) {
    atomicWriteText(this.file, JSON.stringify({ encrypted: this.crypt().encrypt(value) }) + '\n');
    fs.chmodSync(this.file, 0o600);
  }

}

function iproyalHttpError(status) {
  const detail = status === 401 ? 'API Token 无效或已过期' : status === 403 ? '账户没有访问权限'
    : status === 422 || status === 400 ? '白名单配置被拒绝，请检查端口容量、国家和粘性时间'
      : status === 429 ? '请求过于频繁，请稍后重试' : '供应商请求失败';
  return `IPRoyal ${detail}（HTTP ${status}）`;
}

module.exports = { IPRoyalCredentials, IPRoyalError, iproyalHttpError };
