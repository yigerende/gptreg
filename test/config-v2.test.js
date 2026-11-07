'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { isMailProviderEnabled, secretFromEnv, validateV2Config } = require('../src/config-v2');

const baseMailConfig = {
  schemaVersion: 2,
  aliases: { plusAddressingEnabled: true },
  sms: { maxPrice: 0.03 },
};

test('normalizes the v2 scheduler defaults and fixed SMSBower market', () => {
  const config = validateV2Config({
    schemaVersion: 2,
    aliases: { plusAddressingEnabled: true },
    sms: { maxPrice: 0.03 },
  }, { cwd: 'C:\\workspace' });

  assert.equal(config.aliases.count, 4);
  assert.equal(config.aliases.maxCount, 6);
  assert.equal(config.workers.maxConcurrency, 1);
  assert.equal(config.sms.service.code, 'dr');
  assert.equal(config.sms.country.id, 151);
  assert.deepEqual(config.sms.countries.map((country) => country.id), [151]);
  assert.equal(config.sms.maxPrice, 0.03);
  assert.equal(config.sms.replacementBudget, 4);
  assert.equal(config.mail.maxPollAttempts, 15);
  const smsbower = validateV2Config({
    schemaVersion: 2,
    mail: { provider: 'smsbower', maxPrice: 0.03 },
    aliases: { plusAddressingEnabled: true },
    sms: { maxPrice: 0.03 },
  }, { cwd: 'C:\\workspace' });
  assert.equal(smsbower.mail.maxPollAttempts, 24);
  assert.equal(config.registration.authRequestTimeoutMs, 30000);
  assert.equal(config.registration.securityRequestTimeoutMs, 30000);
  assert.equal(config.registration.prewarmSentinelSdk, true);
  assert.equal(config.proxyPool.healthCheck.timeoutMs, 8000);
  for (const dead of [
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
    assert.equal(Object.hasOwn(config.proxyPool.healthCheck, dead), false, dead);
  }
});

test('normalizes multiple SMSBower countries while keeping the legacy primary country', () => {
  const config = validateV2Config({
    schemaVersion: 2,
    aliases: { plusAddressingEnabled: true },
    sms: {
      maxPrice: 0.055,
      country: { id: 151, name: 'Chile' },
      countries: [
        { id: 151, name: 'Chile' },
        { id: 6, name: 'Indonesia' },
        { id: 151, name: 'Duplicate Chile' },
      ],
    },
  });

  assert.deepEqual(config.sms.countries.map((country) => country.id), [151, 6]);
  assert.equal(config.sms.country.id, 151);
});

test('drops retired global proxy screening settings from normalized config', () => {
  const base = { schemaVersion: 2, aliases: { plusAddressingEnabled: true }, sms: { provider: 'mock' } };
  const normalized = validateV2Config({
    ...base,
    proxyPool: {
      healthCheck: {
        probeConcurrency: 64,
        readyTarget: 40,
        readyTtlMs: 300000,
        screenConcurrency: 48,
        timeoutMs: 7000,
      },
    },
  });
  assert.deepEqual(normalized.proxyPool.healthCheck, {
    enabled: false,
    probeUrl: 'https://auth.openai.com/',
    timeoutMs: 7000,
  });
});

test('normalizes Firefox.fun as an OAuth-only cheapest-price country channel', () => {
  const config = validateV2Config({
    schemaVersion: 2,
    aliases: { plusAddressingEnabled: true },
    sms: {
      provider: 'firefox',
      maxPrice: '',
      firefox: {
        maxPrice: '',
        countryMode: 'random',
        countries: [{ code: 'USA', name: 'United States' }, { code: 'chl' }],
      },
    },
  });

  assert.equal(config.sms.provider, 'firefox');
  assert.equal(config.sms.service.code, '1096');
  assert.equal(config.sms.country.id, 'cheapest');
  assert.equal(config.sms.firefox.countryMode, 'cheapest');
  assert.equal(config.sms.maxPrice, null);
  assert.equal(Object.hasOwn(config.sms.firefox, 'apiReturn'), false);
  assert.deepEqual(config.sms.firefox.countries.map((item) => item.code), ['usa', 'chl']);
});

test('normalizes the primary auth timeout and keeps it bounded', () => {
  const config = validateV2Config({
    ...baseMailConfig,
    registration: { authRequestTimeoutMs: 45000, securityRequestTimeoutMs: 15000 },
  });

  assert.equal(config.registration.authRequestTimeoutMs, 45000);
  assert.equal(config.registration.securityRequestTimeoutMs, 15000);
  assert.throws(
    () => validateV2Config({ ...baseMailConfig, registration: { authRequestTimeoutMs: 120001 } }),
    /registration\.authRequestTimeoutMs/,
  );
});

test('root email strategy forces one direct registration without plus addressing', () => {
  const config = validateV2Config({
    schemaVersion: 2,
    aliases: { strategy: 'root', count: 6, maxAttempts: 8, plusAddressingEnabled: false },
    sms: { maxPrice: 0.03 },
  });

  assert.equal(config.aliases.strategy, 'root');
  assert.equal(config.aliases.count, 1);
  assert.equal(config.aliases.maxAttempts, 1);
  assert.equal(config.aliases.plusAddressingEnabled, false);
});

test('rejects unsafe alias and concurrency configuration before side effects', () => {
  assert.throws(
    () => validateV2Config({ aliases: {}, sms: { maxPrice: 0.03 } }),
    /plusAddressingEnabled/,
  );
  assert.throws(
    () => validateV2Config({ aliases: { plusAddressingEnabled: true }, workers: { maxConcurrency: 21 }, sms: { maxPrice: 0.03 } }),
    /workers.maxConcurrency/,
  );
  assert.throws(
    () => validateV2Config({ aliases: { plusAddressingEnabled: true, count: 7 }, sms: { maxPrice: 0.03 } }),
    /aliases.count/,
  );
  // The ceiling moved from 8 to 20; everything up to it has to still be legal.
  assert.equal(
    validateV2Config({ aliases: { plusAddressingEnabled: true }, workers: { maxConcurrency: 20 }, sms: { maxPrice: 0.03 } }).workers.maxConcurrency,
    20,
  );
  assert.throws(
    () => validateV2Config({ aliases: { plusAddressingEnabled: true }, sms: { maxPrice: 0.03 }, registration: { exchangeToken: false } }),
    /exchangeToken/,
  );
  assert.throws(
    () => validateV2Config({ aliases: { plusAddressingEnabled: true }, sms: { maxPrice: 0.101 } }),
    /must not exceed 0\.1 USD/,
  );
});

test('normalizes inline credentials without changing their values', () => {
  const config = validateV2Config({
    schemaVersion: 2,
    mail: { password: 'mail secret with spaces' },
    aliases: { plusAddressingEnabled: true },
    sms: { apiKey: 'sms-secret', maxPrice: 0.03 },
  });

  assert.equal(config.mail.password, 'mail secret with spaces');
  assert.equal(config.sms.apiKey, 'sms-secret');
  assert.throws(
    () => validateV2Config({
      mail: { password: 1234 },
      aliases: { plusAddressingEnabled: true },
      sms: { maxPrice: 0.03 },
    }),
    /mail\.password must be a string/,
  );
});

test('keeps Xiaopingguo and Mail.com endpoints and credentials independent', () => {
  const xiaopingguo = validateV2Config({
    ...baseMailConfig,
    mail: { provider: 'xiaopingguo', baseUrl: 'http://127.0.0.1:8000' },
  });
  assert.equal(xiaopingguo.mail.baseUrl, 'http://127.0.0.1:8000');
  assert.equal(xiaopingguo.mail.xiaopingguoBaseUrl, 'http://127.0.0.1:8000');
  assert.equal(xiaopingguo.mail.mailcomBaseUrl, 'http://127.0.0.1:8001');
  assert.equal(xiaopingguo.mail.adminToken, '');

  const mailcom = validateV2Config({
    ...baseMailConfig,
    mail: { provider: 'mailcom', baseUrl: 'http://127.0.0.1:8001' },
  });
  assert.equal(mailcom.mail.baseUrl, 'http://127.0.0.1:8001');
  assert.equal(mailcom.mail.xiaopingguoBaseUrl, 'http://127.0.0.1:8000');
  assert.equal(mailcom.mail.mailcomBaseUrl, 'http://127.0.0.1:8001');
  assert.equal(mailcom.mail.adminToken, 'mailcom-local-admin-change-me');
});

test('normalizes Fastmail as an independent remote pool with provider switches', () => {
  const config = validateV2Config({
    ...baseMailConfig,
    mail: {
      provider: 'fastmail',
      fastmailBaseUrl: 'http://127.0.0.1:8001',
      providerEnabled: { fastmail: false },
    },
  });

  assert.equal(config.mail.provider, 'fastmail');
  assert.equal(config.mail.baseUrl, 'http://127.0.0.1:8001');
  assert.equal(config.mail.fastmailBaseUrl, 'http://127.0.0.1:8001');
  assert.equal(config.mail.adminToken, 'mailcom-local-admin-change-me');
  assert.equal(config.mail.providerEnabled.mailcom, true);
  assert.equal(config.mail.providerEnabled.fastmail, false);
  assert.equal(isMailProviderEnabled(config, 'fastmail'), false);
  assert.equal(isMailProviderEnabled(config, 'mailcom'), true);
});

test('normalizes iCloud as an independent mailbox pool without Mail.com alias settings', () => {
  const config = validateV2Config({
    ...baseMailConfig,
    mail: {
      provider: 'icloud',
      baseUrl: 'http://legacy.example.test:8001',
      icloudBaseUrl: 'http://icloud.example.test:8001',
      aliasDomainMode: 'selected',
      aliasDomains: ['mail-only.example'],
      providerSettings: {
        mailcom: { aliasBatchSize: 9, aliasDomainMode: 'selected', aliasDomains: ['mail.example'] },
        fastmail: { aliasBatchSize: 4, aliasDomainMode: 'selected', aliasDomains: ['fast.example'] },
      },
    },
  });

  assert.equal(config.mail.provider, 'icloud');
  assert.equal(config.mail.baseUrl, 'http://icloud.example.test:8001');
  assert.equal(config.mail.icloudBaseUrl, 'http://icloud.example.test:8001');
  assert.equal(config.mail.mailcomBaseUrl, 'http://127.0.0.1:8001');
  assert.equal(config.mail.fastmailBaseUrl, 'http://127.0.0.1:8001');
  assert.deepEqual(config.mail.aliasDomains, []);
  assert.equal(config.mail.aliasDomainMode, 'random');
  assert.deepEqual(config.mail.providerSettings.mailcom.aliasDomains, ['mail.example']);
  assert.deepEqual(config.mail.providerSettings.fastmail.aliasDomains, ['fast.example']);
});

test('keeps Mail.com and Fastmail alias policies independent', () => {
  const config = validateV2Config({
    ...baseMailConfig,
    mail: {
      provider: 'mailcom',
      aliasDomainMode: 'selected',
      aliasDomains: ['legacy-mail.example'],
      providerSettings: {
        mailcom: { aliasBatchSize: 9, aliasDomainMode: 'selected', aliasDomains: ['mail.example'] },
        fastmail: { aliasBatchSize: 4, aliasDomainMode: 'selected', aliasDomains: ['fast.example'] },
      },
    },
  });

  assert.deepEqual(config.mail.providerSettings.mailcom, {
    aliasBatchSize: 9,
    aliasDomainMode: 'selected',
    aliasDomains: ['mail.example'],
  });
  assert.deepEqual(config.mail.providerSettings.fastmail, {
    aliasBatchSize: 4,
    aliasDomainMode: 'selected',
    aliasDomains: ['fast.example'],
  });
  assert.deepEqual(config.mail.aliasDomains, ['mail.example']);
});

test('does not copy a legacy Mail.com policy into the Fastmail pool', () => {
  const config = validateV2Config({
    ...baseMailConfig,
    mail: {
      provider: 'mailcom',
      aliasDomainMode: 'selected',
      aliasDomains: ['mail-only.example'],
    },
  });

  assert.deepEqual(config.mail.providerSettings.mailcom.aliasDomains, ['mail-only.example']);
  assert.deepEqual(config.mail.providerSettings.fastmail.aliasDomains, []);
  assert.equal(config.mail.providerSettings.fastmail.aliasBatchSize, 1);
  assert.equal(config.mail.providerSettings.fastmail.aliasDomainMode, 'random');
});

test('does not treat flat legacy Mail.com fields as Fastmail settings after a provider-only switch', () => {
  const config = validateV2Config({
    ...baseMailConfig,
    mail: {
      provider: 'fastmail',
      aliasBatchSize: 9,
      aliasDomainMode: 'selected',
      aliasDomains: ['torontomail.com'],
    },
  });

  assert.deepEqual(config.mail.providerSettings.fastmail, {
    aliasBatchSize: 1,
    aliasDomainMode: 'random',
    aliasDomains: [],
  });
});

test('normalizes Mail.com alias domain policy and rejects an empty selected set', () => {
  const selected = validateV2Config({
    ...baseMailConfig,
    mail: {
      provider: 'mailcom',
      aliasDomainMode: 'selected',
      aliasDomains: ['@torontomail.com', 'swissmail.com', 'torontomail.com'],
    },
  });
  assert.equal(selected.mail.aliasDomainMode, 'selected');
  assert.deepEqual(selected.mail.aliasDomains, ['torontomail.com', 'swissmail.com']);
  assert.throws(
    () => validateV2Config({ ...baseMailConfig, mail: { aliasDomainMode: 'selected', aliasDomains: [] } }),
    /mail\.aliasDomains must contain at least one domain/,
  );
});

test('repairs a legacy provider switch that left Xiaopingguo on the Mail.com port', () => {
  const config = validateV2Config({
    ...baseMailConfig,
    mail: { provider: 'xiaopingguo', baseUrl: 'http://127.0.0.1:8001', adminToken: 'mailcom-local-admin-change-me' },
  });

  assert.equal(config.mail.baseUrl, 'http://127.0.0.1:8000');
  assert.equal(config.mail.origin, 'http://127.0.0.1:8000');
  assert.equal(config.mail.adminToken, '');
});

test('resolves credentials inline first and falls back to named environment variables', () => {
  assert.equal(
    secretFromEnv({ apiKey: 'inline-secret', apiKeyEnv: 'UNIT_KEY' }, 'apiKeyEnv', { UNIT_KEY: 'environment-secret' }),
    'inline-secret',
  );
  assert.equal(secretFromEnv({ apiKeyEnv: 'UNIT_KEY' }, 'apiKeyEnv', { UNIT_KEY: 'environment-secret' }), 'environment-secret');
  assert.equal(secretFromEnv({ password: 'mail-secret', passwordEnv: 'MAIL_PASSWORD' }, 'passwordEnv', {}), 'mail-secret');
});

test('reports missing credentials without including credential values', () => {
  assert.throws(
    () => secretFromEnv({ apiKeyEnv: 'UNIT_KEY' }, 'apiKeyEnv', {}),
    (error) => {
      assert.match(error.message, /apiKey/);
      assert.match(error.message, /UNIT_KEY/);
      assert.doesNotMatch(error.message, /inline-secret|environment-secret/);
      return true;
    },
  );
  assert.throws(
    () => secretFromEnv({ passwordEnv: 'MAIL_PASSWORD' }, 'passwordEnv', {}),
    /password.*MAIL_PASSWORD/,
  );
});

test('removed browser challenge settings do not survive config normalization', () => {
  const normalized = validateV2Config({
    schemaVersion: 2,
    aliases: { plusAddressingEnabled: true },
    sms: { maxPrice: 0.03 },
    registration: {
      cloudflareStrategy: 'flaresolverr',
      flaresolverr: 'http://127.0.0.1:8191/v1',
      flaresolverrEndpoint: 'http://127.0.0.1:8191/v1',
      flaresolverrTimeoutMs: 120000,
    },
  });

  assert.equal(normalized.registration.cloudflareStrategy, undefined);
  assert.equal(normalized.registration.flaresolverr, undefined);
  assert.equal(normalized.registration.flaresolverrEndpoint, undefined);
  assert.equal(normalized.registration.flaresolverrTimeoutMs, undefined);
});

test('the sub2api gateway defaults to loopback 8080 and takes its key inline or from the env', () => {
  const defaults = validateV2Config({ ...baseMailConfig }, { cwd: 'C:\workspace' }).sub2api;
  assert.equal(defaults.baseUrl, 'http://127.0.0.1:8080');
  assert.equal(defaults.adminApiKey, '');
  assert.equal(defaults.requestTimeoutMs, 30000);

  const configured = validateV2Config({
    ...baseMailConfig,
    // A trailing slash here would produce a double slash in the import path.
    sub2api: { baseUrl: 'http://gateway.local:9000/', adminApiKeyEnv: 'UNIT_SUB2API_KEY', requestTimeoutMs: 5000 },
  }, { cwd: 'C:\workspace' }).sub2api;
  assert.equal(configured.baseUrl, 'http://gateway.local:9000');
  assert.equal(configured.requestTimeoutMs, 5000);
  assert.equal(secretFromEnv(configured, 'adminApiKeyEnv', { UNIT_SUB2API_KEY: 'from-env' }), 'from-env');
});
