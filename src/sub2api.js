'use strict';

const { decodeJwtPayload } = require('./oauth-pkce');
const { isPlainObject } = require('./util/shared');

const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth';
const OPENAI_PROFILE_CLAIM = 'https://api.openai.com/profile';

function firstNonEmpty(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return undefined;
}

function objectClaim(payload, name) {
  const value = payload?.[name];
  return isPlainObject(value) ? value : undefined;
}

function normalizeTimestamp(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
  }
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function timestampFromUnixSeconds(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const date = new Date(value * 1000);
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}

function expiresIn(expiresAt, now) {
  if (!expiresAt) return undefined;
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) return undefined;
  return Math.max(0, Math.floor((expiresAtMs - now.getTime()) / 1000));
}

function deriveOrganizationId(idAuth, accessAuth) {
  for (const auth of [idAuth, accessAuth]) {
    if (!Array.isArray(auth?.organizations)) continue;
    const preferred = auth.organizations.find((organization) => isPlainObject(organization) && organization.is_default && organization.id);
    if (preferred?.id) return String(preferred.id);
    const first = auth.organizations.find((organization) => isPlainObject(organization) && organization.id);
    if (first?.id) return String(first.id);
  }
  return undefined;
}

function stripUnavailable(value) {
  if (Array.isArray(value)) return value.map(stripUnavailable).filter((item) => item !== undefined);
  if (isPlainObject(value)) {
    const entries = Object.entries(value)
      .map(([key, item]) => [key, stripUnavailable(item)])
      .filter(([, item]) => item !== undefined);
    return entries.length ? Object.fromEntries(entries) : undefined;
  }
  if (value === undefined || value === null || value === '') return undefined;
  return value;
}

function emailKey(email) {
  return typeof email === 'string'
    ? email.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || undefined
    : undefined;
}

function decodeCpaToken(token, field) {
  if (typeof token !== 'string' || !token.trim()) throw new TypeError(`CPA ${field} is required`);
  try {
    return decodeJwtPayload(token.trim());
  } catch (error) {
    throw new TypeError(`CPA ${field} must be a valid JWT: ${error.message}`);
  }
}

function buildSub2ApiAccount(record, options = {}) {
  if (!isPlainObject(record)) throw new TypeError('CPA account must be an object');
  const sourceType = String(record.type || 'codex').trim().toLowerCase();
  if (sourceType !== 'codex') throw new TypeError(`Unsupported CPA type: ${record.type}`);

  const accessPayload = decodeCpaToken(record.access_token, 'access_token');
  const idPayload = decodeCpaToken(record.id_token, 'id_token');
  const accessAuth = objectClaim(accessPayload, OPENAI_AUTH_CLAIM);
  const idAuth = objectClaim(idPayload, OPENAI_AUTH_CLAIM);
  const accessProfile = objectClaim(accessPayload, OPENAI_PROFILE_CLAIM);
  const now = options.now instanceof Date && Number.isFinite(options.now.getTime()) ? options.now : new Date();
  const email = firstNonEmpty(record.email, accessProfile?.email, accessPayload.email, idPayload.email);
  const expiresAt = firstNonEmpty(normalizeTimestamp(record.expired), timestampFromUnixSeconds(accessPayload.exp));
  const planType = firstNonEmpty(record.plan_type, accessAuth?.chatgpt_plan_type, idAuth?.chatgpt_plan_type);
  const accountId = firstNonEmpty(record.account_id, accessAuth?.chatgpt_account_id, idAuth?.chatgpt_account_id);
  const userId = firstNonEmpty(
    accessAuth?.chatgpt_user_id,
    idAuth?.chatgpt_user_id,
    accessAuth?.user_id,
    idAuth?.user_id,
  );
  const credentials = stripUnavailable({
    access_token: record.access_token,
    chatgpt_account_id: accountId,
    chatgpt_user_id: userId,
    email,
    expires_at: expiresAt,
    expires_in: expiresIn(expiresAt, now),
    id_token: record.id_token,
    organization_id: deriveOrganizationId(idAuth, accessAuth),
    plan_type: planType,
    refresh_token: firstNonEmpty(record.refresh_token),
  });
  if (!credentials) throw new TypeError('CPA account has no exportable credentials');

  return stripUnavailable({
    name: firstNonEmpty(email, options.sourceName, 'converted-account'),
    platform: 'openai',
    type: 'oauth',
    concurrency: 10,
    priority: 1,
    credentials,
    extra: {
      email,
      email_key: emailKey(email),
      last_refresh: normalizeTimestamp(record.last_refresh),
    },
  });
}

function flattenCpaRecords(records) {
  const flattened = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (isPlainObject(value) && Array.isArray(value.accounts)) {
      value.accounts.forEach(visit);
      return;
    }
    flattened.push(value);
  };
  visit(records);
  return flattened;
}

function buildSub2ApiDocument(records, options = {}) {
  const source = flattenCpaRecords(records);
  if (!source.length) throw new TypeError('At least one CPA account is required');
  const now = options.now instanceof Date && Number.isFinite(options.now.getTime()) ? options.now : new Date();
  return {
    exported_at: now.toISOString(),
    proxies: [],
    accounts: source.map((record) => buildSub2ApiAccount(record, { ...options, now })),
  };
}

module.exports = {
  buildSub2ApiAccount,
  buildSub2ApiDocument,
};
