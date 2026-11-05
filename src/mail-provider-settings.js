'use strict';

const REMOTE_MAIL_PROVIDERS = new Set(['mailcom', 'fastmail']);
const DEFAULT_ALIAS_BATCH_SIZE = 9;
const DEFAULT_FASTMAIL_ALIAS_BATCH_SIZE = 1;

function defaultAliasBatchSize(provider) {
  return normalizeProvider(provider) === 'fastmail'
    ? DEFAULT_FASTMAIL_ALIAS_BATCH_SIZE
    : DEFAULT_ALIAS_BATCH_SIZE;
}

function normalizeProvider(value) {
  return String(value || '').trim().toLowerCase() === 'fastmail' ? 'fastmail' : 'mailcom';
}

function normalizeDomains(value) {
  return [...new Set((Array.isArray(value) ? value : [])
    .map((item) => String(item || '').trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean))];
}

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * Return the raw provider override and the one legacy fallback that is safe.
 * The flat fields predate the Fastmail pool and therefore belong to Mail.com.
 * Fastmail must start from its own defaults until it has an explicit provider
 * block; otherwise a config that only changed `mail.provider` leaks Mail.com's
 * batch size and domain whitelist into the Fastmail pool.
 */
function providerAliasSettingsSource(mail = {}, provider = 'mailcom') {
  const normalizedProvider = normalizeProvider(provider);
  const providerSettings = objectValue(mail.providerSettings);
  const hasOverride = Object.prototype.hasOwnProperty.call(providerSettings, normalizedProvider);
  const configured = objectValue(providerSettings[normalizedProvider]);
  const activeProvider = normalizeProvider(mail.provider);
  const legacy = normalizedProvider === 'mailcom' && activeProvider === normalizedProvider && !hasOverride
    ? {
      aliasBatchSize: mail.aliasBatchSize,
      aliasDomainMode: mail.aliasDomainMode,
      aliasDomains: mail.aliasDomains,
    }
    : {};
  return { configured, legacy, hasOverride };
}

function providerAliasSettings(mail = {}, provider = 'mailcom') {
  const { configured, legacy } = providerAliasSettingsSource(mail, provider);
  const fallbackBatchSize = defaultAliasBatchSize(provider);
  const aliasBatchSize = configured.aliasBatchSize ?? legacy.aliasBatchSize ?? fallbackBatchSize;
  const parsedBatchSize = Number(aliasBatchSize);
  const aliasDomainMode = String(configured.aliasDomainMode ?? legacy.aliasDomainMode ?? 'random').toLowerCase() === 'selected'
    ? 'selected'
    : 'random';
  return {
    aliasBatchSize: Number.isInteger(parsedBatchSize) && parsedBatchSize > 0 ? parsedBatchSize : fallbackBatchSize,
    aliasDomainMode,
    aliasDomains: normalizeDomains(configured.aliasDomains ?? legacy.aliasDomains),
  };
}

function allProviderAliasSettings(mail = {}) {
  return {
    mailcom: providerAliasSettings(mail, 'mailcom'),
    fastmail: providerAliasSettings(mail, 'fastmail'),
  };
}

function providerAliasSettingsPatch(mail = {}, provider = 'mailcom', patch = {}) {
  const normalizedProvider = normalizeProvider(provider);
  const settings = allProviderAliasSettings(mail);
  const current = settings[normalizedProvider];
  return {
    ...settings,
    [normalizedProvider]: {
      ...current,
      ...patch,
      aliasDomains: normalizeDomains(patch.aliasDomains ?? current.aliasDomains),
    },
  };
}

module.exports = {
  defaultAliasBatchSize,
  providerAliasSettings,
  providerAliasSettingsPatch,
  providerAliasSettingsSource,
};
