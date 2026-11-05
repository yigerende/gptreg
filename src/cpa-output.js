'use strict';

const { decodeJwtPayload, validateTokenResponse } = require('./oauth-pkce');
const { clone, firstDefined } = require('./util/shared');

const CPA_ARTIFACT_TYPE = 'gpt-re.cpa.v1';
const RUN_MANIFEST_TYPE = 'gpt-re.run-manifest.v2';
const RUN_MANIFEST_SCHEMA_VERSION = 2;
const COCKPIT_ACCOUNT_TYPE = 'codex';
const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth';
const REDACTED = '<redacted>';

const SENSITIVE_KEYS = new Set([
  'access_token',
  'accessToken',
  'id_token',
  'idToken',
  'refresh_token',
  'refreshToken',
  'token',
  'tokens',
]);

function asString(value) {
  if (value === undefined || value === null) return '';
  return String(value);
}

function asTrimmedString(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function tokenSource(input = {}) {
  const source = firstDefined(
    input.tokens,
    input.tokenResponse,
    input.oauth?.tokens,
    input.oauth?.tokenResponse,
    {},
  );
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new TypeError('tokens must be an object');
  }
  return source;
}

function tokenValue(input, source, snake, camel) {
  return asTrimmedString(firstDefined(input[snake], input[camel], source[snake], source[camel]));
}

function normalizedTokens(input = {}) {
  const source = tokenSource(input);
  const tokens = {
    id_token: tokenValue(input, source, 'id_token', 'idToken'),
    access_token: tokenValue(input, source, 'access_token', 'accessToken'),
  };
  const refreshToken = tokenValue(input, source, 'refresh_token', 'refreshToken');
  if (refreshToken) tokens.refresh_token = refreshToken;
  validateTokenResponse(tokens);
  return {
    ...tokens,
    refresh_token: refreshToken,
  };
}

function objectClaim(payload, name) {
  const value = payload[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`JWT claim ${name} must be an object`);
  }
  return value;
}

function jwtMetadata(tokens) {
  const accessPayload = decodeJwtPayload(tokens.access_token);
  const idPayload = decodeJwtPayload(tokens.id_token);
  return {
    accessPayload,
    idPayload,
    accessAuth: objectClaim(accessPayload, OPENAI_AUTH_CLAIM),
    idAuth: objectClaim(idPayload, OPENAI_AUTH_CLAIM),
  };
}

function numericDateToIso(value, claimName) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`JWT claim ${claimName} must be a finite number`);
  }
  const milliseconds = value > 1_000_000_000_000 ? value : value * 1000;
  const date = new Date(milliseconds);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`JWT claim ${claimName} is outside the supported date range`);
  }
  return date.toISOString();
}

function consistentClaim(values, name, options = {}) {
  const claims = values.map(asTrimmedString).filter(Boolean);
  const normalized = new Set(claims.map((value) => options.caseInsensitive ? value.toLowerCase() : value));
  if (normalized.size > 1) throw new Error(`OAuth token ${name} claims do not match`);
  if (options.required && claims.length === 0) throw new Error(`OAuth tokens are missing a required ${name} claim`);
  return claims[0] || '';
}

function normalizeTimestamp(value, name) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError(`${name} must be a valid timestamp`);
    return value.toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return numericDateToIso(value, name);
  }
  if (typeof value === 'string' && value.trim()) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return new Date(timestamp).toISOString();
  }
  throw new TypeError(`${name} must be a valid timestamp`);
}

function resolveAccountId(input, metadata) {
  const claimed = consistentClaim([
    metadata.accessAuth?.chatgpt_account_id,
    metadata.accessAuth?.account_id,
    metadata.idAuth?.chatgpt_account_id,
    metadata.idAuth?.account_id,
  ], 'account ID');
  return claimed || asTrimmedString(firstDefined(
    input.account_id,
    input.accountId,
    input.chatgpt_account_id,
    input.chatgptAccountId,
    input.workspaceId,
    input.workspace_id,
    input.account?.id,
  ));
}

function resolveEmail(input, metadata) {
  const supplied = asTrimmedString(firstDefined(
    input.email,
    input.aliasEmail,
    input.account?.email,
  ));
  const claimed = consistentClaim([
    metadata.idPayload.email,
    metadata.idAuth?.email,
    metadata.accessPayload.email,
    metadata.accessAuth?.email,
  ], 'email', { caseInsensitive: true, required: true });
  if (supplied && claimed && supplied.toLowerCase() !== claimed.toLowerCase()) {
    throw new Error('CPA email does not match the OAuth token email');
  }
  return claimed || supplied;
}

function resolveExpiry(metadata) {
  if (metadata.accessPayload.exp !== undefined && metadata.accessPayload.exp !== null) {
    return numericDateToIso(metadata.accessPayload.exp, 'exp');
  }
  if (metadata.idPayload.exp !== undefined && metadata.idPayload.exp !== null) {
    return numericDateToIso(metadata.idPayload.exp, 'exp');
  }
  return '';
}

function resolveLastRefresh(input, source, options) {
  const value = firstDefined(
    input.last_refresh,
    input.lastRefresh,
    source.last_refresh,
    source.lastRefresh,
    input.token_updated_at,
    input.tokenUpdatedAt,
    input.completedAt,
    input.updatedAt,
    options.now,
    new Date(),
  );
  return normalizeTimestamp(value, 'last_refresh');
}

function buildCpaAccount(input = {}, options = {}) {
  const source = tokenSource(input);
  const tokens = normalizedTokens(input);
  const metadata = jwtMetadata(tokens);

  return {
    id_token: tokens.id_token,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    account_id: resolveAccountId(input, metadata),
    last_refresh: resolveLastRefresh(input, source, options),
    email: resolveEmail(input, metadata),
    type: COCKPIT_ACCOUNT_TYPE,
    expired: resolveExpiry(metadata),
  };
}

const buildCockpitAccount = buildCpaAccount;

function jobsFromInput(input = {}) {
  if (Array.isArray(input)) return input;
  if (Array.isArray(input.jobs)) return input.jobs;
  if (Array.isArray(input.accounts)) return input.accounts;
  if (
    input.email
    || input.tokens
    || input.tokenResponse
    || input.oauth
    || input.id_token
    || input.access_token
  ) return [input];
  return [];
}

function buildCpaArtifact(input = {}, options = {}) {
  const accounts = jobsFromInput(input).map((job) => buildCpaAccount(job, options));
  return accounts.length === 1 ? accounts[0] : accounts;
}

function statusCounts(jobs) {
  const byStatus = {};
  for (const job of jobs) {
    const status = asString(firstDefined(job.status, job.state, 'unknown'));
    byStatus[status] = (byStatus[status] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(byStatus).sort(([left], [right]) => left.localeCompare(right)));
}

function errorDetails(job) {
  const error = job.error && typeof job.error === 'object' ? job.error : {};
  const blocked = job.blocked && typeof job.blocked === 'object' ? job.blocked : {};
  const missing = Array.isArray(blocked.missing) ? blocked.missing : [];
  return {
    errorCode: asString(firstDefined(
      job.errorCode,
      job.error_code,
      error.code,
      blocked.code,
      missing[0],
    )),
    errorMessage: asString(firstDefined(
      job.errorMessage,
      job.error_message,
      error.message,
      blocked.message,
    )),
  };
}

function durationMs(job) {
  const explicit = firstDefined(job.durationMs, job.duration_ms);
  if (typeof explicit === 'number' && Number.isFinite(explicit) && explicit >= 0) return explicit;
  const started = Date.parse(firstDefined(job.startedAt, job.started_at, ''));
  const finished = Date.parse(firstDefined(job.completedAt, job.completed_at, job.updatedAt, job.updated_at, ''));
  return Number.isFinite(started) && Number.isFinite(finished) && finished >= started
    ? finished - started
    : null;
}

function manifestJob(job = {}) {
  const errors = errorDetails(job);
  return {
    jobId: asString(firstDefined(job.jobId, job.job_id, job.id)),
    status: asString(firstDefined(job.status, job.state, 'unknown')),
    phase: asString(firstDefined(job.phase, job.step)),
    email: asString(firstDefined(job.email, job.aliasEmail)),
    accountId: asString(firstDefined(
      job.accountId,
      job.account_id,
      job.workspaceId,
      job.workspace_id,
    )),
    cpaPath: asString(firstDefined(job.cpaPath, job.cpa_path)),
    ...errors,
    startedAt: asString(firstDefined(job.startedAt, job.started_at)),
    updatedAt: asString(firstDefined(job.updatedAt, job.updated_at)),
    completedAt: asString(firstDefined(job.completedAt, job.completed_at)),
    durationMs: durationMs(job),
  };
}

function hasCompleteTokens(job) {
  try {
    normalizedTokens(job);
    return true;
  } catch {
    return false;
  }
}

function buildRunManifest(input = {}, options = {}) {
  const jobs = jobsFromInput(input);
  const summaries = jobs.map(manifestJob);
  const generatedAt = normalizeTimestamp(
    firstDefined(input.generatedAt, input.generated_at, options.now, new Date()),
    'generatedAt',
  );
  return {
    type: RUN_MANIFEST_TYPE,
    schemaVersion: RUN_MANIFEST_SCHEMA_VERSION,
    runId: asString(firstDefined(input.runId, input.run_id)),
    generatedAt,
    status: asString(firstDefined(input.status, input.state, 'unknown')),
    counts: {
      total: jobs.length,
      active: jobs.filter((job) => job.status === 'complete' && hasCompleteTokens(job)).length,
      exported: summaries.filter((job) => job.cpaPath).length,
      byStatus: statusCounts(jobs),
    },
    jobs: summaries,
  };
}

function buildLegacyCpaArtifact(input = {}, options = {}) {
  const payload = buildCpaArtifact(input, options);
  const accounts = Array.isArray(payload) ? payload : [payload];
  const manifest = buildRunManifest(input, options);
  return {
    type: CPA_ARTIFACT_TYPE,
    runId: manifest.runId,
    generatedAt: manifest.generatedAt,
    counts: {
      total: accounts.length,
      active: manifest.counts.active,
      expired: accounts.filter((account) => account.expired).length,
    },
    accounts,
    jobs: manifest.jobs,
  };
}

function redactValue(value) {
  if (typeof value === 'string') return `${REDACTED}:string:${value.length}`;
  if (typeof value === 'number') return `${REDACTED}:number`;
  if (typeof value === 'boolean') return value;
  if (value === null || value === undefined) return value;
  return REDACTED;
}

function redactSensitive(value, key = '') {
  if (SENSITIVE_KEYS.has(key)) return redactValue(value);
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      redactSensitive(childValue, childKey),
    ]));
  }
  return value;
}

const redactTokens = redactSensitive;

function wantsRaw(options = {}) {
  return options.raw === true || options.redact === false;
}

function summarizeCockpitAccount(account, options = {}) {
  const cloned = clone(account);
  return wantsRaw(options) ? cloned : redactTokens(cloned);
}

function summarizeCpaArtifact(artifact, options = {}) {
  const cloned = clone(artifact);
  return wantsRaw(options) ? cloned : redactTokens(cloned);
}

module.exports = {
  buildCockpitAccount,
  buildCpaAccount,
  buildCpaArtifact,
  buildLegacyCpaArtifact,
  buildRunManifest,
  redactTokens,
  summarizeCockpitAccount,
  summarizeCpaArtifact,
};
