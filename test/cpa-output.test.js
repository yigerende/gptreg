'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildCockpitAccount,
  buildCpaArtifact,
  buildRunManifest,
  redactTokens,
  summarizeCockpitAccount,
  summarizeCpaArtifact,
} = require('../src/cpa-output');

const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth';

function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.${Buffer.from('sig').toString('base64url')}`;
}

function tokens(options = {}) {
  return {
    id_token: jwt({
      email: options.email || 'jwt@example.com',
      exp: options.idExp ?? 1_750_000_000,
      [OPENAI_AUTH_CLAIM]: {
        chatgpt_account_id: options.accountId || 'account-from-jwt',
      },
    }),
    access_token: jwt({
      exp: options.accessExp ?? 1_800_000_000,
    }),
    ...(options.withoutRefresh ? {} : { refresh_token: 'refresh-secret' }),
  };
}

test('maps a completed job to the exact Cockpit 1.3.14 flat CPA record', () => {
  const sourceTokens = tokens({ email: 'alias@example.com' });
  const account = buildCockpitAccount({
    workspaceId: 'workspace-unit',
    email: 'alias@example.com',
    tokens: sourceTokens,
    lastRefresh: '2026-07-27T10:00:00.000Z',
  });

  assert.deepEqual(Object.keys(account), [
    'id_token',
    'access_token',
    'refresh_token',
    'account_id',
    'last_refresh',
    'email',
    'type',
    'expired',
  ]);
  assert.deepEqual(account, {
    id_token: sourceTokens.id_token,
    access_token: sourceTokens.access_token,
    refresh_token: 'refresh-secret',
    account_id: 'account-from-jwt',
    last_refresh: '2026-07-27T10:00:00.000Z',
    email: 'alias@example.com',
    type: 'codex',
    expired: new Date(1_800_000_000 * 1000).toISOString(),
  });
});

test('derives account, email, and expiry from JWT claims with ID-token expiry fallback', () => {
  const sourceTokens = tokens({
    accountId: 'account-from-jwt',
    email: 'claim@example.com',
    idExp: 1_750_000_000,
    accessExp: null,
    withoutRefresh: true,
  });
  sourceTokens.access_token = jwt({ scope: 'openid' });

  const account = buildCockpitAccount({
    tokens: sourceTokens,
    completedAt: '2026-07-27T10:01:02Z',
  });

  assert.equal(account.account_id, 'account-from-jwt');
  assert.equal(account.email, 'claim@example.com');
  assert.equal(account.refresh_token, '');
  assert.equal(account.expired, new Date(1_750_000_000 * 1000).toISOString());
  assert.equal(account.last_refresh, '2026-07-27T10:01:02.000Z');
});

test('rejects incomplete tokens, malformed JWTs, and invalid exp claims', () => {
  assert.throws(
    () => buildCockpitAccount({ tokens: { id_token: jwt({}) } }),
    /access_token/,
  );
  assert.throws(
    () => buildCockpitAccount({
      tokens: { id_token: jwt({}), access_token: 'not-a-jwt' },
      completedAt: '2026-07-27T10:00:00Z',
    }),
    /three-segment/,
  );
  assert.throws(
    () => buildCockpitAccount({
      tokens: { id_token: jwt({ email: 'claim@example.com' }), access_token: jwt({ exp: 'tomorrow' }) },
      completedAt: '2026-07-27T10:00:00Z',
    }),
    /finite number/,
  );
  assert.throws(
    () => buildCockpitAccount({
      email: 'other@example.com',
      tokens: tokens({ email: 'claim@example.com' }),
      completedAt: '2026-07-27T10:00:00Z',
    }),
    /does not match/,
  );
  assert.throws(
    () => buildCockpitAccount({
      email: 'supplied@example.com',
      tokens: { id_token: jwt({ exp: 1_750_000_000 }), access_token: jwt({ exp: 1_800_000_000 }) },
      completedAt: '2026-07-27T10:00:00Z',
    }),
    /missing a required email claim/,
  );
  assert.throws(
    () => buildCockpitAccount({
      tokens: {
        id_token: jwt({ email: 'one@example.com' }),
        access_token: jwt({ email: 'two@example.com' }),
      },
      completedAt: '2026-07-27T10:00:00Z',
    }),
    /email claims do not match/,
  );
  assert.throws(
    () => buildCockpitAccount({
      tokens: {
        id_token: jwt({
          email: 'one@example.com',
          [OPENAI_AUTH_CLAIM]: { chatgpt_account_id: 'account-one' },
        }),
        access_token: jwt({
          email: 'one@example.com',
          [OPENAI_AUTH_CLAIM]: { chatgpt_account_id: 'account-two' },
        }),
      },
      completedAt: '2026-07-27T10:00:00Z',
    }),
    /account ID claims do not match/,
  );
});

test('builds one flat CPA object or an array of flat objects without a wrapper', () => {
  const jobs = [
    {
      jobId: 'job-1',
      email: 'one@example.com',
      tokens: tokens({ accountId: 'workspace-1', email: 'one@example.com' }),
      completedAt: '2026-07-27T10:00:00Z',
    },
    {
      jobId: 'job-2',
      email: 'two@example.com',
      tokens: tokens({ accountId: 'workspace-2', email: 'two@example.com' }),
      completedAt: '2026-07-27T10:05:00Z',
    },
  ];

  const single = buildCpaArtifact({ jobs: [jobs[0]] });
  const many = buildCpaArtifact({ jobs });

  assert.equal(Array.isArray(single), false);
  assert.equal(single.account_id, 'workspace-1');
  assert.equal(Object.hasOwn(single, 'accounts'), false);
  assert.equal(Array.isArray(many), true);
  assert.deepEqual(many.map((account) => account.account_id), ['workspace-1', 'workspace-2']);
});

test('builds a token-free run manifest separate from CPA output', () => {
  const sourceTokens = tokens({ accountId: 'workspace-1' });
  const manifest = buildRunManifest({
    runId: 'run-unit',
    status: 'blocked',
    generatedAt: '2026-07-27T10:05:00Z',
    jobs: [
      {
        id: 'job-1',
        status: 'complete',
        phase: 'complete',
        email: 'one@example.com',
        workspaceId: 'workspace-1',
        tokens: sourceTokens,
        cpaPath: 'output/run-unit/accounts/job-1.json',
        startedAt: '2026-07-27T10:00:00Z',
        completedAt: '2026-07-27T10:00:03Z',
      },
      {
        id: 'job-2',
        status: 'blocked',
        phase: 'oauth_token_exchange',
        email: 'two@example.com',
        blocked: { code: 'token_missing', message: 'No token response' },
        startedAt: '2026-07-27T10:00:00Z',
        updatedAt: '2026-07-27T10:00:05Z',
      },
    ],
  });

  assert.equal(manifest.type, 'gpt-re.run-manifest.v2');
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.runId, 'run-unit');
  assert.deepEqual(manifest.counts, {
    total: 2,
    active: 1,
    exported: 1,
    byStatus: { blocked: 1, complete: 1 },
  });
  assert.equal(manifest.jobs[0].durationMs, 3000);
  assert.equal(manifest.jobs[1].errorCode, 'token_missing');
  assert.equal(manifest.jobs[1].errorMessage, 'No token response');
  assert.equal(JSON.stringify(manifest).includes(sourceTokens.access_token), false);
  assert.equal(JSON.stringify(manifest).includes(sourceTokens.refresh_token), false);
});

test('token redaction handles flat CPA objects, arrays, and nested state', () => {
  const sourceTokens = tokens({ email: 'alias@example.com' });
  const account = buildCockpitAccount({
    email: 'alias@example.com',
    tokens: sourceTokens,
    lastRefresh: '2026-07-27T10:00:00Z',
  });
  const summary = summarizeCpaArtifact([account]);
  const raw = summarizeCpaArtifact(account, { raw: true });
  const accountSummary = summarizeCockpitAccount(account);
  const nested = redactTokens({ oauth: { tokens: sourceTokens }, status: 'complete' });

  assert.equal(JSON.stringify(summary).includes(sourceTokens.access_token), false);
  assert.equal(summary[0].access_token, `<redacted>:string:${sourceTokens.access_token.length}`);
  assert.equal(summary[0].refresh_token, '<redacted>:string:14');
  assert.equal(raw.access_token, sourceTokens.access_token);
  assert.equal(accountSummary.id_token, `<redacted>:string:${sourceTokens.id_token.length}`);
  assert.equal(nested.oauth.tokens, '<redacted>');
  assert.equal(nested.status, 'complete');
});
