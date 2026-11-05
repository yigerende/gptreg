'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildSub2ApiAccount, buildSub2ApiDocument } = require('../src/sub2api');

const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth';
const OPENAI_PROFILE_CLAIM = 'https://api.openai.com/profile';

function jwt(payload) {
  const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.${Buffer.from('sig').toString('base64url')}`;
}

function cpaRecord(options = {}) {
  const email = options.email || 'codex@example.test';
  return {
    type: 'codex',
    access_token: jwt({
      exp: options.exp || 1_900_000_000,
      [OPENAI_PROFILE_CLAIM]: { email },
      [OPENAI_AUTH_CLAIM]: {
        chatgpt_account_id: options.accountId || 'account-codex',
        chatgpt_user_id: options.userId || 'user-codex',
        chatgpt_plan_type: 'plus',
        organizations: [
          { id: 'org-secondary', is_default: false },
          { id: 'org-primary', is_default: true },
        ],
      },
    }),
    id_token: jwt({ email }),
    refresh_token: 'refresh-codex',
    account_id: options.accountId || 'account-codex',
    email,
    expired: new Date((options.exp || 1_900_000_000) * 1000).toISOString(),
    last_refresh: '2026-08-07T12:00:00.000Z',
  };
}

test('converts a Codex CPA account to the sub2api OpenAI OAuth schema', () => {
  const now = new Date('2026-08-07T12:30:00.000Z');
  const source = cpaRecord();
  const account = buildSub2ApiAccount(source, { now });

  assert.deepEqual(account, {
    name: 'codex@example.test',
    platform: 'openai',
    type: 'oauth',
    concurrency: 10,
    priority: 1,
    credentials: {
      access_token: source.access_token,
      chatgpt_account_id: 'account-codex',
      chatgpt_user_id: 'user-codex',
      email: 'codex@example.test',
      expires_at: source.expired,
      expires_in: Math.floor((Date.parse(source.expired) - now.getTime()) / 1000),
      id_token: source.id_token,
      organization_id: 'org-primary',
      plan_type: 'plus',
      refresh_token: 'refresh-codex',
    },
    extra: {
      email: 'codex@example.test',
      email_key: 'codex_example_test',
      last_refresh: '2026-08-07T12:00:00.000Z',
    },
  });
});

test('merges multiple Codex CPA accounts into one sub2api document', () => {
  const now = new Date('2026-08-07T12:30:00.000Z');
  const document = buildSub2ApiDocument([
    cpaRecord({ email: 'one@example.test', accountId: 'account-one' }),
    cpaRecord({ email: 'two@example.test', accountId: 'account-two' }),
  ], { now });

  assert.equal(document.exported_at, now.toISOString());
  assert.deepEqual(document.proxies, []);
  assert.deepEqual(document.accounts.map((account) => account.name), ['one@example.test', 'two@example.test']);
  assert.deepEqual(document.accounts.map((account) => account.credentials.chatgpt_account_id), ['account-one', 'account-two']);
});

test('rejects unsupported or incomplete CPA records without exposing token values', () => {
  assert.throws(
    () => buildSub2ApiAccount({ type: 'claude', access_token: 'secret-access', id_token: 'secret-id' }),
    /Unsupported CPA type: claude/,
  );
  assert.throws(
    () => buildSub2ApiAccount({ type: 'codex', access_token: 'secret-access', id_token: 'secret-id' }),
    (error) => /access_token must be a valid JWT/.test(error.message) && !error.message.includes('secret-access'),
  );
});
