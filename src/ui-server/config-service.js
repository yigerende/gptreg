'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { DEFAULT_FIREFOX_FUN_URL, validateV2Config } = require('../config-v2');
const { getFirefoxFunCredentials } = require('../firefox-fun-credentials');
const { atomicWriteText, HttpError, mergeObjects, resolveInside } = require('./utils');
const { clone } = require('../util/shared');

function validated(input, cwd) {
  try {
    const normalized = validateV2Config(input, { cwd });
    resolveInside(cwd, normalized.output.stateDir);
    resolveInside(cwd, normalized.output.cpaDir);
    if (input.proxyPool?.path) resolveInside(cwd, input.proxyPool.path);
    if (input.proxyPool?.catalogPath) resolveInside(cwd, input.proxyPool.catalogPath);
    return normalized;
  } catch (error) {
    throw new HttpError(400, error.message);
  }
}

function withoutSecrets(input) {
  const config = clone(input || {});
  if (config.mail) {
    delete config.mail.password;
    delete config.mail.adminToken;
    delete config.mail.apiKey;
  }
  if (config.sub2api) {
    // The gateway's admin API key is a credential like any other here, so it
    // never reaches the browser and cannot be round-tripped back in. There is
    // no console field for it: set `sub2api.adminApiKeyEnv`, or edit the file.
    // Stripping it on the write path is safe because `update` merges onto the
    // current config, so a hand-edited key survives a console save.
    delete config.sub2api.adminApiKey;
  }
  if (config.nvtokens) {
    // The member inventory key is used only by server-side push routes.
    delete config.nvtokens.apiKey;
  }
  if (config.sms) {
    delete config.sms.apiKey;
    if (config.sms.firefox && typeof config.sms.firefox === 'object') {
      delete config.sms.firefox.token;
      delete config.sms.firefox.apiName;
      delete config.sms.firefox.password;
      delete config.sms.firefox.apiReturn;
    }
  }
  if (config.workers && typeof config.workers === 'object') {
    delete config.workers.auxiliaryTaskCapacity;
  }
  return config;
}

class ConfigService {
  constructor(options = {}) {
    this.cwd = path.resolve(options.cwd || process.cwd());
    this.filePath = resolveInside(this.cwd, options.configPath || 'gpt-re.config.json');
    // Keyed by the file's own mtime and size, so an edit from anywhere — this
    // process, an editor, another tool — invalidates it on the next stat.
    this.rawCache = null;
    this.normalizedCache = null;
  }

  /**
   * The config file's current text, re-read only when it actually changed.
   *
   * This is one of the hottest reads in the process and almost none of it was
   * needed: every log line resolved the log directory through here twice, the
   * run list resolved the asset store once per job, and a single proxy listing
   * came through three times for three different paths. A stat is a fraction of
   * an open/read/close, and the parse below still hands every caller its own
   * object, so nothing can mutate another caller's config.
   */
  readText() {
    let stats;
    try {
      stats = fs.statSync(this.filePath);
    } catch {
      this.rawCache = null;
      return fs.readFileSync(this.filePath, 'utf8');
    }
    const cached = this.rawCache;
    if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached.text;
    const text = fs.readFileSync(this.filePath, 'utf8');
    this.rawCache = { mtimeMs: stats.mtimeMs, size: stats.size, text };
    return text;
  }

  readRaw() {
    return JSON.parse(this.readText());
  }

  snapshot(input = this.readRaw()) {
    const firefoxCredentials = getFirefoxFunCredentials();
    const adminTokenEnv = String(input.mail?.adminTokenEnv || 'MAILCOM_ADMIN_TOKEN').trim();
    const nvtokensApiKeyEnv = String(input.nvtokens?.apiKeyEnv || 'NVTOKENS_API_KEY').trim();
    return {
      path: path.relative(this.cwd, this.filePath) || path.basename(this.filePath),
      config: withoutSecrets(input),
      secrets: {
        mailPasswordConfigured: Boolean(input.mail?.password),
        mailcomAdminTokenConfigured: Boolean(String(input.mail?.adminToken || '').trim())
          || Boolean(adminTokenEnv && process.env[adminTokenEnv]),
        smsApiKeyConfigured: Boolean(input.sms?.apiKey),
        nvtokensApiKeyConfigured: Boolean(String(input.nvtokens?.apiKey || '').trim())
          || Boolean(nvtokensApiKeyEnv && process.env[nvtokensApiKeyEnv]),
        firefoxCredentialsConfigured: Boolean(firefoxCredentials.token),
      },
    };
  }

  validate(input) {
    const current = this.readRaw();
    const candidate = mergeObjects(current, withoutSecrets(input));
    const normalized = validated(candidate, this.cwd);
    return {
      valid: true,
      normalized: withoutSecrets(normalized),
      secrets: this.snapshot(current).secrets,
    };
  }

  update(payload = {}) {
    const current = this.readRaw();
    const next = mergeObjects(current, withoutSecrets(payload.config || {}));
    const secretPatch = payload.secretPatch || {};
    next.mail = next.mail || {};
    next.sms = next.sms || {};
    next.nvtokens = next.nvtokens || {};
    if (Object.hasOwn(secretPatch, 'mailApiKey')) next.mail.apiKey = String(secretPatch.mailApiKey || '');
    if (Object.hasOwn(secretPatch, 'mailPassword')) next.mail.password = String(secretPatch.mailPassword || '');
    if (Object.hasOwn(secretPatch, 'mailcomAdminToken')) next.mail.adminToken = String(secretPatch.mailcomAdminToken || '');
    if (Object.hasOwn(secretPatch, 'smsApiKey')) next.sms.apiKey = String(secretPatch.smsApiKey || '');
    if (Object.hasOwn(secretPatch, 'nvtokensApiKey')) next.nvtokens.apiKey = String(secretPatch.nvtokensApiKey || '');
    for (const secret of payload.clearSecrets || []) {
      if (secret === 'mailApiKey') delete next.mail.apiKey;
      if (secret === 'mailPassword') delete next.mail.password;
      if (secret === 'mailcomAdminToken') delete next.mail.adminToken;
      if (secret === 'smsApiKey') delete next.sms.apiKey;
      if (secret === 'nvtokensApiKey') delete next.nvtokens.apiKey;
    }
    if (next.sms?.firefox && typeof next.sms.firefox === 'object') {
      next.sms.firefox.baseUrl = DEFAULT_FIREFOX_FUN_URL;
      delete next.sms.firefox.apiReturn;
    }
    if (next.workers && typeof next.workers === 'object') {
      delete next.workers.auxiliaryTaskCapacity;
    }
    validated(next, this.cwd);
    atomicWriteText(this.filePath, `${JSON.stringify(next, null, 2)}\n`);
    this.rawCache = null;
    this.normalizedCache = null;
    return this.snapshot(next);
  }

  /**
   * The validated config. `validateV2Config` is a full schema pass and callers
   * treat this as free — the probe and trial-check routes each run it per
   * request — so the result is cached against the same mtime key and handed out
   * as a copy, which is much cheaper than revalidating.
   */
  normalized() {
    const text = this.readText();
    if (this.normalizedCache?.text === text) return clone(this.normalizedCache.value);
    const value = validated(JSON.parse(text), this.cwd);
    this.normalizedCache = { text, value };
    return clone(value);
  }

  proxyFilePath() {
    const config = this.readRaw();
    return resolveInside(this.cwd, config.proxyPool?.path || 'proxy-pool.txt');
  }

  proxyCatalogPath() {
    const config = this.readRaw();
    return resolveInside(this.cwd, config.proxyPool?.catalogPath || 'dynamic-proxy-pools.json');
  }
}

module.exports = { ConfigService, withoutSecrets };
