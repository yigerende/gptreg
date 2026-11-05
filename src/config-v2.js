'use strict';
const { normalizeRetryPolicy } = require('./execution-settings');

const path = require('node:path');

const { SUPPORTED_COUNTRIES } = require('./chain-countries');
const { defaultAliasBatchSize, providerAliasSettingsSource } = require('./mail-provider-settings');

const CONFIG_SCHEMA_VERSION = 2;
const MAX_MAIL_COUNT = 1000;
const DEFAULT_SMSBOWER_URL = 'https://smsbower.page/stubs/handler_api.php';
const DEFAULT_FIREFOX_FUN_URL = 'https://firefox.fun/yhapi.ashx';
const FIREFOX_FUN_PROJECT_ID = '1096';
const FIREFOX_FUN_PROJECT_NAME = 'OpenAI / ChatGpt';
const DEFAULT_XIAOPINGGUO_BASE_URL = 'http://127.0.0.1:8000';
const DEFAULT_LINKOPS_BASE_URL = 'http://127.0.0.1:8082';
const DEFAULT_SUB2API_BASE_URL = 'http://127.0.0.1:8080';
const DEFAULT_NVTOKENS_BASE_URL = 'https://nvtokens.com';
const DEFAULT_MAILCOM_BASE_URL = 'http://127.0.0.1:8001';
const DEFAULT_ICLOUD_BASE_URL = 'http://127.0.0.1:8001';
const DEFAULT_MAILCOM_ADMIN_TOKEN = 'mailcom-local-admin-change-me';
const DEFAULT_WORKER_CONCURRENCY = 1;
// Raised from 8 once the country pools were large enough to feed it. This is a
// validation ceiling, not a recommendation: the real limits are how many
// unbound mailboxes a run can claim and how many SMS activations the provider
// will hand out at once.
const MAX_WORKER_CONCURRENCY = 20;
const DEFAULT_ALIAS_COUNT = 4;
const MAX_ALIAS_COUNT = 6;
const MAX_ALIAS_ATTEMPTS = MAX_ALIAS_COUNT + 2;
const DEFAULT_REPLACEMENT_BUDGET = 20;
const MAX_REPLACEMENT_BUDGET = 30;
const MAX_SMSBOWER_PRICE_USD = 0.1;
const DEFAULT_AUTH_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_SECURITY_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_MAIL_MAX_POLL_ATTEMPTS = 15;
const SMSBOWER_MAIL_MAX_POLL_ATTEMPTS = 24;
// Per HTTP hop inside an extraction. Deliberately an order of magnitude below
// the run budget above.

function asPositiveInteger(value, fallback, name, max = Number.MAX_SAFE_INTEGER) {
  const number = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}`);
  }
  return number;
}

function defaultMailMaxPollAttempts(provider) {
  return String(provider || '').trim().toLowerCase() === 'smsbower'
    ? SMSBOWER_MAIL_MAX_POLL_ATTEMPTS
    : DEFAULT_MAIL_MAX_POLL_ATTEMPTS;
}

function asNonNegativeNumber(value, fallback, name) {
  const number = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${name} must be a non-negative number`);
  return number;
}

function asOptionalNonNegativeNumber(value, name) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${name} must be a non-negative number or blank`);
  // Firefox.fun documents zero as "do not enable the price limit".
  return number > 0 ? number : null;
}

function normalizeFirefoxCountries(value) {
  if (value === undefined || value === null || value === '') return [];
  if (!Array.isArray(value)) throw new Error('sms.firefox.countries must be an array');
  const seen = new Set();
  const result = [];
  for (const item of value) {
    const source = item && typeof item === 'object' && !Array.isArray(item) ? item : { code: item };
    const code = String(source.code ?? source.country ?? source.id ?? '').trim().toLowerCase();
    if (!/^[a-z]{3}$/.test(code)) throw new Error(`sms.firefox.countries contains an invalid country code: ${code || '<empty>'}`);
    if (seen.has(code)) continue;
    seen.add(code);
    result.push({
      code,
      name: String(source.name ?? source.title ?? '').trim(),
      dialingCode: String(source.dialingCode ?? source.dialCode ?? '').replace(/\D/g, ''),
    });
  }
  return result;
}

function requiredString(value, name) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function optionalSecret(value, name) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new Error(`${name} must be a string`);
  return value.trim() ? value : '';
}

function normalizeSelector(value, name, idKey = 'id') {
  if (typeof value === 'string' || typeof value === 'number') {
    const text = String(value).trim();
    if (!text) throw new Error(`${name} is required`);
    return { code: text };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must provide a name, code, or ${idKey}`);
  }
  const normalized = {};
  if (value.name) normalized.name = String(value.name).trim();
  if (value.code !== undefined && value.code !== null && value.code !== '') normalized.code = String(value.code).trim();
  if (value[idKey] !== undefined && value[idKey] !== null && value[idKey] !== '') {
    const parsed = Number(value[idKey]);
    normalized[idKey] = Number.isFinite(parsed) ? parsed : String(value[idKey]).trim();
  }
  if (!normalized.name && !normalized.code && normalized[idKey] === undefined) {
    throw new Error(`${name} must provide a name, code, or ${idKey}`);
  }
  return normalized;
}

function normalizeSelectorList(value, fallback, name, idKey = 'id') {
  const source = value === undefined || value === null ? fallback : value;
  if (!Array.isArray(source) || source.length === 0) {
    throw new Error(`${name} must contain at least one country`);
  }
  const seen = new Set();
  const result = [];
  for (const item of source) {
    const normalized = normalizeSelector(item, name, idKey);
    const key = String(normalized[idKey] ?? normalized.code ?? normalized.name ?? '').trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  if (!result.length) throw new Error(`${name} must contain at least one country`);
  return result;
}

function asBoundedInteger(value, fallback, name, min, max) {
  const number = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return number;
}

// `root` registers only the address itself; `root_plus` adds exactly one
// `+alias` of it and is what the pooled channel's alias switch selects. Plain
// `plus` (aliases only, no root) is retained for stored configs but no task
// produces it any more.
const ALIAS_STRATEGIES = ['plus', 'root', 'root_plus'];
const PLUS_ALIAS_STRATEGIES = ['plus', 'root_plus'];
const MAIL_PROVIDERS = ['xiaopingguo', 'smsbower', 'mailcom', 'fastmail', 'icloud'];
const REMOTE_MAIL_PROVIDERS = ['mailcom', 'fastmail'];
const REMOTE_MAILBOX_PROVIDERS = [...REMOTE_MAIL_PROVIDERS, 'icloud'];
const API_MAIL_PROVIDERS = [...REMOTE_MAILBOX_PROVIDERS];
const SMSBOWER_MAIL_DOMAIN = 'gmail.com';

function normalizeMailProviderEnabled(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return Object.fromEntries(MAIL_PROVIDERS.map((provider) => {
    if (input[provider] !== undefined && typeof input[provider] !== 'boolean') {
      throw new Error(`mail.providerEnabled.${provider} must be a boolean`);
    }
    return [provider, input[provider] !== false];
  }));
}

function isMailProviderEnabled(configOrMail, provider) {
  const mail = configOrMail?.mail && typeof configOrMail.mail === 'object'
    ? configOrMail.mail
    : (configOrMail || {});
  const selected = String(provider || mail.provider || '').trim().toLowerCase();
  if (!MAIL_PROVIDERS.includes(selected)) return false;
  return mail.providerEnabled?.[selected] !== false;
}

function validateV2Config(input = {}, options = {}) {
  if (Number(input.schemaVersion || CONFIG_SCHEMA_VERSION) !== CONFIG_SCHEMA_VERSION) {
    throw new Error(`Unsupported config schemaVersion: ${input.schemaVersion}`);
  }

  const mail = input.mail || {};
  const aliases = input.aliases || {};
  const sms = input.sms || {};
  const workers = input.workers || {};
  const registration = input.registration || {};
  const output = input.output || {};
  const proxyPool = input.proxyPool || {};
  const chain = input.chain || {};
  const linkops = input.linkops || {};
  const sub2api = input.sub2api || {};
  const nvtokens = input.nvtokens === undefined ? {} : input.nvtokens;
  if (!nvtokens || typeof nvtokens !== 'object' || Array.isArray(nvtokens)) {
    throw new Error('nvtokens must be an object');
  }
  if (registration.exchangeToken === false) {
    throw new Error('registration.exchangeToken must be true for the v2 CPA workflow');
  }

  const aliasStrategy = String(aliases.strategy || 'plus').toLowerCase();
  if (!ALIAS_STRATEGIES.includes(aliasStrategy)) throw new Error(`aliases.strategy must be one of ${ALIAS_STRATEGIES.join(', ')}`);
  const aliasCount = aliasStrategy === 'root'
    ? 1
    : asPositiveInteger(aliases.count, DEFAULT_ALIAS_COUNT, 'aliases.count', MAX_ALIAS_COUNT);
  const aliasMaxAttempts = aliasStrategy === 'root'
    ? 1
    : asPositiveInteger(
      aliases.maxAttempts,
      aliasCount + 2,
      'aliases.maxAttempts',
      MAX_ALIAS_ATTEMPTS,
    );
  if (aliasMaxAttempts < aliasCount) throw new Error('aliases.maxAttempts must be at least aliases.count');
  if (PLUS_ALIAS_STRATEGIES.includes(aliasStrategy) && aliases.plusAddressingEnabled !== true) {
    throw new Error('aliases.plusAddressingEnabled must be true before Plus aliases can be generated');
  }

  // Two mail channels with very different models: a durable pool that can be
  // read whenever, and rented mailboxes that close after the run. A rental is
  // only safe when registration finishes password and TOTP setup, because that
  // removes the account's later need for email; OAuth may be optional.
  const mailProvider = String(mail.provider || 'xiaopingguo').toLowerCase();
  if (!MAIL_PROVIDERS.includes(mailProvider)) throw new Error(`Unsupported mail provider: ${mailProvider}`);
  const rawProviderSettings = mail.providerSettings;
  if (rawProviderSettings !== undefined && (!rawProviderSettings || typeof rawProviderSettings !== 'object' || Array.isArray(rawProviderSettings))) {
    throw new Error('mail.providerSettings must be an object');
  }
  const providerAliasSettings = {};
  for (const provider of REMOTE_MAIL_PROVIDERS) {
    const raw = rawProviderSettings?.[provider];
    if (raw !== undefined && (!raw || typeof raw !== 'object' || Array.isArray(raw))) {
      throw new Error(`mail.providerSettings.${provider} must be an object`);
    }
    const source = providerAliasSettingsSource(mail, provider);
    const settingPrefix = source.hasOverride ? `mail.providerSettings.${provider}` : 'mail';
    const aliasBatchSize = asPositiveInteger(
      source.configured.aliasBatchSize ?? source.legacy.aliasBatchSize,
      defaultAliasBatchSize(provider),
      `${settingPrefix}.aliasBatchSize`,
      100,
    );
    const aliasDomainMode = String(
      source.configured.aliasDomainMode ?? source.legacy.aliasDomainMode ?? 'random',
    ).toLowerCase() === 'selected' ? 'selected' : 'random';
    const aliasDomainList = [...new Set(
      (Array.isArray(source.configured.aliasDomains ?? source.legacy.aliasDomains)
        ? (source.configured.aliasDomains ?? source.legacy.aliasDomains)
        : [])
        .map((value) => String(value || '').trim().toLowerCase().replace(/^@/, ''))
        .filter(Boolean),
    )];
    if (aliasDomainMode === 'selected' && !aliasDomainList.length) {
      throw new Error(`${settingPrefix}.aliasDomains must contain at least one domain when ${settingPrefix}.aliasDomainMode is "selected"`);
    }
    providerAliasSettings[provider] = { aliasBatchSize, aliasDomainMode, aliasDomains: aliasDomainList };
  }
  const activeAliasSettings = providerAliasSettings[mailProvider] || {
    aliasBatchSize: mailProvider === 'icloud' ? 1 : defaultAliasBatchSize(mailProvider),
    aliasDomainMode: 'random',
    aliasDomains: [],
  };
  const mailMaxPrice = asNonNegativeNumber(mail.maxPrice, mailProvider === 'smsbower' ? undefined : 0, 'mail.maxPrice');
  if (mailProvider === 'smsbower' && mailMaxPrice <= 0) throw new Error('mail.maxPrice must be greater than zero for the SMSBower mail channel');
  const mailDomain = String(mail.domain || SMSBOWER_MAIL_DOMAIN).toLowerCase();
  if (mailProvider === 'smsbower' && mailDomain !== SMSBOWER_MAIL_DOMAIN) {
    // Only Gmail routes `+tag` back to the rented inbox, and the alias is half
    // the point of a rental.
    throw new Error(`mail.domain must be ${SMSBOWER_MAIL_DOMAIN} for the SMSBower mail channel`);
  }
  // Keep the two local mail services independent. `mail.baseUrl` predates the
  // Mail.com channel and remains as the active-provider compatibility field;
  // provider-specific values are the source of truth when present.
  const legacyMailBaseUrl = String(mail.baseUrl || '').replace(/\/+$/, '');
  const xiaopingguoBaseUrl = String(
    mail.xiaopingguoBaseUrl
      || (mailProvider === 'xiaopingguo' && legacyMailBaseUrl !== DEFAULT_MAILCOM_BASE_URL ? legacyMailBaseUrl : '')
      || DEFAULT_XIAOPINGGUO_BASE_URL,
  ).replace(/\/+$/, '');
  const mailcomBaseUrl = String(
    mail.mailcomBaseUrl
      || (mailProvider === 'mailcom' && legacyMailBaseUrl !== DEFAULT_XIAOPINGGUO_BASE_URL ? legacyMailBaseUrl : '')
      || DEFAULT_MAILCOM_BASE_URL,
  ).replace(/\/+$/, '');
  const fastmailBaseUrl = String(
    mail.fastmailBaseUrl
      || (mailProvider === 'fastmail' && legacyMailBaseUrl !== DEFAULT_XIAOPINGGUO_BASE_URL ? legacyMailBaseUrl : '')
      || mailcomBaseUrl,
  ).replace(/\/+$/, '');
  const icloudBaseUrl = String(
    mail.icloudBaseUrl
      || (mailProvider === 'icloud' && legacyMailBaseUrl !== DEFAULT_XIAOPINGGUO_BASE_URL ? legacyMailBaseUrl : '')
      || DEFAULT_ICLOUD_BASE_URL,
  ).replace(/\/+$/, '');
  const mailBaseUrl = mailProvider === 'mailcom'
    ? mailcomBaseUrl
    : (mailProvider === 'fastmail'
      ? fastmailBaseUrl
      : (mailProvider === 'icloud' ? icloudBaseUrl : xiaopingguoBaseUrl));
  const legacyMailOrigin = String(mail.origin || '').replace(/\/+$/, '');
  const xiaopingguoOrigin = String(
    mail.xiaopingguoOrigin
      || (legacyMailOrigin !== DEFAULT_MAILCOM_BASE_URL ? legacyMailOrigin : '')
      || xiaopingguoBaseUrl,
  ).replace(/\/+$/, '');

  const requestedProvider = String(sms.provider || 'smsbower').toLowerCase();
  const provider = requestedProvider === 'firefox-fun' || requestedProvider === 'firefox.fun'
    ? 'firefox'
    : requestedProvider;
  if (!['smsbower', 'firefox', 'hero-sms', 'mock'].includes(provider)) throw new Error(`Unsupported SMS provider: ${provider}`);
  const bower = sms.smsbower || sms;
  const hero = (sms.hero || provider === 'hero-sms') ? require('./sms-settings').normalizeHero(sms.hero) : null;
  const smsBowerMaxPrice = asNonNegativeNumber(bower.maxPrice, provider === 'smsbower' ? undefined : 0, 'sms.maxPrice');
  if (provider === 'smsbower' && smsBowerMaxPrice <= 0) throw new Error('sms.maxPrice must be greater than zero for SMSBower');
  if (provider === 'smsbower' && smsBowerMaxPrice > MAX_SMSBOWER_PRICE_USD) {
    throw new Error(`sms.maxPrice must not exceed ${MAX_SMSBOWER_PRICE_USD} USD for SMSBower`);
  }
  const rawFirefox = sms.firefox;
  if (rawFirefox !== undefined && (!rawFirefox || typeof rawFirefox !== 'object' || Array.isArray(rawFirefox))) {
    throw new Error('sms.firefox must be an object');
  }
  const firefox = rawFirefox || {};
  const requestedFirefoxCountryMode = String(firefox.countryMode || 'cheapest').trim().toLowerCase();
  // `random` was the old persisted value. Accept it for migration, but make
  // every normalized config use the price-driven selector.
  if (!['random', 'cheapest'].includes(requestedFirefoxCountryMode)) {
    throw new Error('sms.firefox.countryMode must be "cheapest"');
  }
  const firefoxCountryMode = 'cheapest';
  const firefoxMaxPrice = asOptionalNonNegativeNumber(firefox.maxPrice, 'sms.firefox.maxPrice');
  const firefoxCountries = normalizeFirefoxCountries(firefox.countries);
  const firefoxBaseUrl = DEFAULT_FIREFOX_FUN_URL;
  const firefoxSettings = { ...firefox };
  for (const key of ['apiName', 'password', 'apiReturn']) {
    delete firefoxSettings[key];
  }
  const activeMaxPrice = provider === 'firefox' ? firefoxMaxPrice : smsBowerMaxPrice;
  const activeBaseUrl = provider === 'firefox'
    ? firefoxBaseUrl
    : String(sms.baseUrl || DEFAULT_SMSBOWER_URL).replace(/\/+$/, '');
  const legacySmsCountry = sms.country || { id: 151, name: 'Chile' };
  const smsCountries = provider === 'smsbower'
    ? normalizeSelectorList(sms.countries, [legacySmsCountry], 'sms.countries')
    : [];
  const primarySmsCountry = provider === 'smsbower'
    ? smsCountries[0]
    : legacySmsCountry;

  const stateDir = path.resolve(options.cwd || process.cwd(), output.stateDir || '.gpt-re-state/v2');
  const cpaDir = path.resolve(options.cwd || process.cwd(), output.cpaDir || path.join(stateDir, 'output'));
  const proxySelection = String(proxyPool.selection || 'random').toLowerCase();
  if (proxySelection !== 'random') throw new Error('proxyPool.selection must be "random"');
  const chainCountry = String(chain.country || 'GB').toUpperCase();
  if (!SUPPORTED_COUNTRIES.includes(chainCountry)) {
    throw new Error(`chain.country must be one of ${SUPPORTED_COUNTRIES.join(', ')}`);
  }
  const registrationSettings = { ...registration };
  for (const key of [
    'cloudflareStrategy',
    'flaresolverr',
    'flaresolverrEndpoint',
    'flaresolverrSession',
    'flaresolverrTimeoutMs',
    'flaresolverrUrl',
    'keepFlaresolverrSession',
  ]) {
    delete registrationSettings[key];
  }
  const healthCheck = { ...(proxyPool.healthCheck || {}) };
  // The current path probes only when a Worker binds an exit. Do not carry
  // the removed global screener's settings into normalized config or state
  // fingerprints.
  for (const key of [
    'concurrency',
    'maxProbeAttempts',
    'probeConcurrency',
    'readyTarget',
    'readyTtlMs',
    'retryCooldownMs',
    'retryTimeoutMs',
    'screenConcurrency',
    'trustWindowMs',
  ]) {
    delete healthCheck[key];
  }
  const normalized = {
    ...input,
    schemaVersion: CONFIG_SCHEMA_VERSION,
    retryPolicy: normalizeRetryPolicy(input.retryPolicy),
    mail: {
      ...mail,
      provider: mailProvider,
      baseUrl: mailBaseUrl,
      xiaopingguoBaseUrl,
      mailcomBaseUrl,
      fastmailBaseUrl,
      icloudBaseUrl,
      smsbowerBaseUrl: String(mail.smsbowerBaseUrl || 'https://smsbower.page/api/mail').trim().replace(/\/+$/, ''),
      xiaopingguoOrigin,
      origin: xiaopingguoOrigin,
      password: optionalSecret(mail.password, 'mail.password'),
      passwordEnv: mail.passwordEnv || 'XIAOPINGGUO_PASSWORD',
      adminToken: API_MAIL_PROVIDERS.includes(mailProvider)
        ? (optionalSecret(mail.adminToken, 'mail.adminToken') || DEFAULT_MAILCOM_ADMIN_TOKEN)
        : '',
      adminTokenEnv: mail.adminTokenEnv || 'MAILCOM_ADMIN_TOKEN',
      providerEnabled: normalizeMailProviderEnabled(mail.providerEnabled),
      // Keep the old active-provider fields in normalized output for callers
      // that have not migrated yet. New code reads the provider-specific map.
      aliasBatchSize: activeAliasSettings.aliasBatchSize,
      aliasDomainMode: activeAliasSettings.aliasDomainMode,
      aliasDomains: activeAliasSettings.aliasDomains,
      providerSettings: providerAliasSettings,
      count: asPositiveInteger(mail.count, 1, 'mail.count', MAX_MAIL_COUNT),
      folders: Array.isArray(mail.folders) && mail.folders.length ? [...mail.folders] : ['inbox', 'junkemail'],
      keyword: mail.keyword || 'openai',
      maxResults: asPositiveInteger(mail.maxResults, 100, 'mail.maxResults', 100),
      timeoutMs: asPositiveInteger(mail.timeoutMs, 120000, 'mail.timeoutMs', 3600000),
      pollIntervalMs: asPositiveInteger(mail.pollIntervalMs, 5000, 'mail.pollIntervalMs', 60000),
      // A hard stop on polling, independent of the clock. An address the
      // provider is not delivering to will never answer, and the wall-clock
      // budget alone kept a Worker pinned to it for the full window and then
      // handed it back for four more retries.
      maxPollAttempts: asPositiveInteger(
        mail.maxPollAttempts,
        defaultMailMaxPollAttempts(mailProvider),
        'mail.maxPollAttempts',
        200,
      ),
      // Rental channel only. The API key falls back to the SMS one because it
      // is the same SMSBower account and the same key.
      service: String(mail.service || 'dr').trim(),
      domain: mailDomain,
      maxPrice: mailMaxPrice,
      apiKey: optionalSecret(mail.apiKey, 'mail.apiKey') || optionalSecret(bower.apiKey, 'sms.apiKey'),
      apiKeyEnv: mail.apiKeyEnv || 'SMSBOWER_API_KEY',
    },
    aliases: {
      strategy: aliasStrategy,
      count: aliasCount,
      maxCount: MAX_ALIAS_COUNT,
      maxAttempts: aliasMaxAttempts,
      runTag: aliases.runTag || 'gptre',
      plusAddressingEnabled: PLUS_ALIAS_STRATEGIES.includes(aliasStrategy),
    },
    sms: {
      ...sms,
      provider,
      baseUrl: activeBaseUrl,
      apiKey: provider === 'firefox' ? '' : optionalSecret(sms.apiKey, 'sms.apiKey'),
      apiKeyEnv: sms.apiKeyEnv || 'SMSBOWER_API_KEY',
      service: provider === 'firefox'
        ? { code: FIREFOX_FUN_PROJECT_ID, name: FIREFOX_FUN_PROJECT_NAME }
        : (provider === 'mock' ? (sms.service || { code: 'mock' }) : normalizeSelector(sms.service || { code: 'dr' }, 'sms.service')),
      country: provider === 'firefox'
        ? { id: 'cheapest', name: '自动最低价' }
        : (provider === 'mock' ? legacySmsCountry : primarySmsCountry),
      countries: provider === 'smsbower' ? smsCountries : [],
      maxPrice: activeMaxPrice,
      firefox: {
        ...firefoxSettings,
        baseUrl: firefoxBaseUrl,
        iid: FIREFOX_FUN_PROJECT_ID,
        projectName: FIREFOX_FUN_PROJECT_NAME,
        countryMode: firefoxCountryMode,
        countries: firefoxCountries,
        maxPrice: firefoxMaxPrice,
      },
      sendRetryLimit: asBoundedInteger(sms.sendRetryLimit, 1, 'sms.sendRetryLimit', 0, 3),
      replacementBudget: asBoundedInteger(
        sms.replacementBudget,
        DEFAULT_REPLACEMENT_BUDGET,
        'sms.replacementBudget',
        0,
        MAX_REPLACEMENT_BUDGET,
      ),
      pollIntervalMs: asPositiveInteger(sms.pollIntervalMs, 5000, 'sms.pollIntervalMs', 60000),
      codeTimeoutMs: asPositiveInteger(sms.codeTimeoutMs, 120000, 'sms.codeTimeoutMs', 3600000),
      oauthCodeTimeoutMs: asPositiveInteger(sms.oauthCodeTimeoutMs, 60000, 'sms.oauthCodeTimeoutMs', 300000),
      inventoryWaitMs: asPositiveInteger(sms.inventoryWaitMs, 600000, 'sms.inventoryWaitMs', 86400000),
      fraudGuardThreshold: asPositiveInteger(sms.fraudGuardThreshold, 5, 'sms.fraudGuardThreshold', 20),
      fraudGuardCooldownMs: asPositiveInteger(sms.fraudGuardCooldownMs, 900000, 'sms.fraudGuardCooldownMs', 86400000),
      maxPendingCancellations: asPositiveInteger(sms.maxPendingCancellations, 2, 'sms.maxPendingCancellations', 10),
    },
    workers: {
      maxConcurrency: asPositiveInteger(
        workers.maxConcurrency,
        DEFAULT_WORKER_CONCURRENCY,
        'workers.maxConcurrency',
        MAX_WORKER_CONCURRENCY,
      ),
      lockMode: 'parent_mailbox',
      proxyAssignments: Array.isArray(workers.proxyAssignments)
        ? workers.proxyAssignments.map((assignment) => ({ ...assignment }))
        : [],
    },
    registration: {
      ...registrationSettings,
      exchangeToken: true,
      dynamicSentinel: registration.dynamicSentinel !== false,
      prewarmSentinelSdk: registration.prewarmSentinelSdk !== false,
      // Where a run's request templates come from. A HAR is evidence of the
      // protocol at the moment it was captured, not the protocol itself: it
      // ages with every OpenAI deploy, it pins one browser's header block, and
      // it replays that capture's own trace ids on every account. `live`
      // builds each request from the templates declared in code and the
      // account's own client profile; `capture` replays a recording and exists
      // for diffing a fresh capture against what the code believes.
      protocolTemplates: registration.protocolTemplates === 'capture' ? 'capture' : 'live',
      // Draw each new account's browser from the profile pool instead of
      // giving every account the one profile lifted from the capture. Set
      // false to put new registrations back on that single profile; accounts
      // already registered keep whichever machine they were given either way.
      clientProfilePool: registration.clientProfilePool !== false,
      // `firefox` sends the full header block a browser sends — Accept-Encoding,
      // the three Sec-Fetch-* headers, Upgrade-Insecure-Requests, Priority, in
      // the browser's own order. `minimal` is the six-header set the console
      // has always sent. It changes every request on a flow that works today,
      // so it stays opt-in until a small batch has confirmed the acceptance
      // rate holds.
      browserHeaders: registration.browserHeaders === 'firefox' ? 'firefox' : 'minimal',
      name: registration.name || 'ctf',
      birthdate: registration.birthdate || '2001-01-01',
      oauthSessionTtlMs: asPositiveInteger(registration.oauthSessionTtlMs, 300000, 'registration.oauthSessionTtlMs', 3600000),
      // A dead registration exit must not hold a Worker for the generic
      // 60-second pure-HTTP fallback. Security requests have their own bound
      // below because they are optional follow-up work.
      authRequestTimeoutMs: asPositiveInteger(
        registration.authRequestTimeoutMs,
        DEFAULT_AUTH_REQUEST_TIMEOUT_MS,
        'registration.authRequestTimeoutMs',
        120000,
      ),
      // Optional password/TOTP setup must not hold a worker for the generic
      // 60-second transport timeout used by the primary auth flow.
      securityRequestTimeoutMs: asPositiveInteger(
        registration.securityRequestTimeoutMs,
        DEFAULT_SECURITY_REQUEST_TIMEOUT_MS,
        'registration.securityRequestTimeoutMs',
        120000,
      ),
      maxRuntimeMs: asPositiveInteger(registration.maxRuntimeMs, 900000, 'registration.maxRuntimeMs', 86400000),
    },
    proxyPool: {
      ...proxyPool,
      catalogPath: proxyPool.catalogPath || 'dynamic-proxy-pools.json',
      apiRequestProxy: String(proxyPool.apiRequestProxy || '').trim(),
      // The stable local forwarder used for upkeep on an account that already
      // exists — AT probes, OAuth top-up, security top-up. Registration traffic
      // never uses it. A full URL rather than a port so the host and scheme can
      // move too.
      maintenanceProxy: String(proxyPool.maintenanceProxy || 'http://127.0.0.1:7890').trim(),
      selection: 'random',
      required: Boolean(proxyPool.required),
      maxRotationsBeforeBootstrap: asPositiveInteger(
        proxyPool.maxRotationsBeforeBootstrap ?? proxyPool.maxRotations,
        2,
        'proxyPool.maxRotationsBeforeBootstrap',
        20,
      ),
      healthCheck: {
        enabled: Boolean(proxyPool.required) || Boolean(healthCheck.enabled),
        probeUrl: healthCheck.probeUrl || 'https://auth.openai.com/',
        timeoutMs: asPositiveInteger(healthCheck.timeoutMs, 8000, 'proxyPool.healthCheck.timeoutMs', 120000),
      },
    },
    output: {
      ...output,
      stateDir,
      cpaDir,
    },
    // Console defaults for the payment-link extractor. The per-submit form can
    // override country and concurrency; the timeout is the whole-run budget and
    // is deliberately not something a single submission can raise.
    // Timeouts, transport, impersonation and concurrency left with the
    // in-process engine: the external service owns how a run is executed. What
    // remains is routing (which checkout country an unmapped registration
    // country falls back to, plus the per-country table) and payment.
    chain: {
      country: chainCountry,
      countryRules: chain.countryRules,
      // How many times a failed extraction is re-dispatched onto the next proxy
      // in its pool before the row is called failed. Only failures a different
      // exit could fix are rotated (see isProxyFailure); an account or
      // configuration failure ends the row on its first attempt. Every
      // extraction provider rotates the proxy on retry, but the engine only
      // does so when asked, so without this a dead exit ends the run.
      // 0 disables it.
      autoRetry: asBoundedInteger(chain.autoRetry, 3, 'chain.autoRetry', 0, 10),
      // Engine calls kept in flight by one dispatch. The engine queues
      // internally (8 jobs at a time), so this only governs how fast that queue
      // is filled, not how many browsers run at once.
      dispatchConcurrency: asBoundedInteger(chain.dispatchConcurrency, 4, 'chain.dispatchConcurrency', 1, 16),
      // Whether an extracted link rolls straight into the payment engine, and
      // the number it signs with. Only PayPal has a payment stage today.
      payment: {
        autoContinue: chain.payment?.autoContinue === true,
        phone: String(chain.payment?.phone || '').trim(),
        country: String(chain.payment?.country || 'US').trim().toUpperCase(),
      },
    },
    // The external LinkOps workbench that owns extraction and PayPal payment
    // since those engines left this repo. Only the address and how to start it
    // live here; job options are provider-side.
    linkops: {
      baseUrl: String(linkops.baseUrl || DEFAULT_LINKOPS_BASE_URL).trim().replace(/\/+$/, ''),
      // Absolute path to the service's `start.bat`. Empty disables the console's
      // start button rather than guessing a location.
      startCommand: String(linkops.startCommand || '').trim(),
      requestTimeoutMs: asBoundedInteger(linkops.requestTimeoutMs, 20000, 'linkops.requestTimeoutMs', 1000, 120000),
    },
    // The local sub2api gateway that self-use accounts are pushed to. Its
    // import endpoint authenticates with an admin API key, so that key is a
    // secret and follows the same rule as the other credentials here:
    // `adminApiKeyEnv` names an environment variable, `adminApiKey` inlines it.
    sub2api: {
      baseUrl: String(sub2api.baseUrl || DEFAULT_SUB2API_BASE_URL).trim().replace(/\/+$/, ''),
      adminApiKey: optionalSecret(sub2api.adminApiKey, 'sub2api.adminApiKey'),
      adminApiKeyEnv: String(sub2api.adminApiKeyEnv || '').trim(),
      requestTimeoutMs: asBoundedInteger(sub2api.requestTimeoutMs, 30000, 'sub2api.requestTimeoutMs', 1000, 120000),
      // Which gateway group a pushed account joins.
      //
      // Not optional in practice. sub2api only auto-files an import when a
      // group is named exactly `<platform>-default` (`admin_account.go`), so a
      // gateway whose group is called anything else — `openai`, say — leaves
      // every pushed account ungrouped and unschedulable until someone moves
      // them by hand. Naming the group here is what makes the push land
      // somewhere usable.
      //
      // `groupName` is resolved against the gateway on each push, so it
      // survives a gateway rebuild that renumbers ids; `groupIds` skips the
      // lookup when the ids are known and stable. Ids win when both are set.
      groupName: String(sub2api.groupName || '').trim(),
      groupIds: (Array.isArray(sub2api.groupIds) ? sub2api.groupIds : [])
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0),
    },
    // The member inventory API is only used by the CPA page. Its credential
    // stays server-side and may be supplied inline or through apiKeyEnv.
    nvtokens: {
      ...nvtokens,
      baseUrl: String(nvtokens.baseUrl || DEFAULT_NVTOKENS_BASE_URL).trim().replace(/\/+$/, ''),
      apiKey: optionalSecret(nvtokens.apiKey, 'nvtokens.apiKey'),
      apiKeyEnv: String(nvtokens.apiKeyEnv || 'NVTOKENS_API_KEY').trim(),
      requestTimeoutMs: asBoundedInteger(nvtokens.requestTimeoutMs, 30000, 'nvtokens.requestTimeoutMs', 1000, 120000),
      defaultPriceYuan: asOptionalNonNegativeNumber(nvtokens.defaultPriceYuan, 'nvtokens.defaultPriceYuan'),
      warrantyChannelId: String(nvtokens.warrantyChannelId || '').trim(),
      warrantyName: String(nvtokens.warrantyName || '').trim(),
      destination: String(nvtokens.destination || 'normal').trim() || 'normal',
      fallbackPoolEnabled: nvtokens.fallbackPoolEnabled === true,
      fallbackPoolMultiplier: asOptionalNonNegativeNumber(nvtokens.fallbackPoolMultiplier, 'nvtokens.fallbackPoolMultiplier'),
      team5xWarranty: nvtokens.team5xWarranty && typeof nvtokens.team5xWarranty === 'object'
        ? { ...nvtokens.team5xWarranty }
        : null,
    },
  };

  requiredString(normalized.mail.baseUrl, 'mail.baseUrl');
  if (hero) normalized.sms.hero = hero;
  if (provider === 'hero-sms') {
    // Preserve SMSBower's own settings when normalization runs again (resume,
    // validation and preflight all normalize). Hero's key never becomes a mail key.
    normalized.sms.smsbower = sms.smsbower || Object.fromEntries(['baseUrl', 'apiKey', 'apiKeyEnv', 'service', 'country', 'countries', 'maxPrice'].map((k) => [k, sms[k]]));
    Object.assign(normalized.sms, hero, { provider: 'hero-sms', hero });
  }
  return normalized;
}

function secretFromEnv(config, name, env = process.env) {
  const inlineName = String(name).endsWith('Env') ? String(name).slice(0, -3) : '';
  const inlineValue = inlineName ? optionalSecret(config?.[inlineName], inlineName) : '';
  if (inlineValue) return inlineValue;

  const envName = String(config?.[name] || '').trim();
  const envValue = envName ? env?.[envName] : undefined;
  if (typeof envValue === 'string' && envValue.trim()) return envValue;

  const inlineHint = inlineName || 'inline secret';
  const envHint = envName ? `environment variable ${envName}` : name;
  throw new Error(`Required secret is not configured: set ${inlineHint} or ${envHint}`);
}

module.exports = {
  REMOTE_MAIL_PROVIDERS,
  REMOTE_MAILBOX_PROVIDERS,
  DEFAULT_FIREFOX_FUN_URL,
  MAX_MAIL_COUNT,
  MAX_WORKER_CONCURRENCY,
  defaultMailMaxPollAttempts,
  isMailProviderEnabled,
  secretFromEnv,
  validateV2Config,
};
