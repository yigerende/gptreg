'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  NvtokensClient,
  NvtokensError,
  normalizeBaseUrl,
  summarizeNvtokensResponse,
} = require('../src/nvtokens-client');

function fakeResponse(payload, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) { return headers[String(name).toLowerCase()] || ''; },
    },
    async json() { return payload; },
  };
}

test('nvtokens client posts all three payloads with the member API key', async () => {
  const calls = [];
  const client = new NvtokensClient({
    baseUrl: 'https://nvtokens.com/api/inventory/cards/import/schema',
    apiKey: 'member-key',
    fetch: async (url, init) => {
      calls.push({ url, init });
      return fakeResponse({ ok: true, accepted: 1, total: 1 });
    },
  });

  await client.importCards({ data: [{ email: 'card@example.test' }] });
  await client.importMailboxes({ text: 'mailbox@example.test----password----totp-secret' });
  await client.poolCards({
    data: [{ email: 'pool@example.test' }],
    price_yuan: 2.5,
    inventory_tokens: [{ email: 'pool@example.test', password: 'password', two_factor_secret: 'totp-secret' }],
  });

  assert.deepEqual(calls.map(({ url }) => url), [
    'https://nvtokens.com/api/inventory/cards/import',
    'https://nvtokens.com/api/inventory/mailboxes/import',
    'https://nvtokens.com/api/inventory/cards/pool',
  ]);
  for (const { init } of calls) {
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.Accept, 'application/json');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.equal(init.headers['x-api-key'], 'member-key');
  }
  assert.deepEqual(JSON.parse(calls[0].init.body), { data: [{ email: 'card@example.test' }] });
  assert.deepEqual(JSON.parse(calls[1].init.body), { text: 'mailbox@example.test----password----totp-secret' });
  assert.deepEqual(JSON.parse(calls[2].init.body), {
    data: [{ email: 'pool@example.test' }],
    price_yuan: 2.5,
    inventory_tokens: [{ email: 'pool@example.test', password: 'password', two_factor_secret: 'totp-secret' }],
  });
});

test('nvtokens client preserves upstream HTTP errors without exposing the key', async () => {
  const client = new NvtokensClient({
    baseUrl: 'https://nvtokens.test',
    apiKey: 'member-key',
    fetch: async () => fakeResponse({ error: 'invalid inventory payload' }, 422),
  });

  await assert.rejects(
    client.importCards({ data: [] }),
    (error) => {
      assert.ok(error instanceof NvtokensError);
      assert.equal(error.status, 422);
      assert.equal(error.code, 'NVTOKENS_REJECTED');
      assert.equal(error.message, 'invalid inventory payload');
      assert.doesNotMatch(error.message, /member-key/);
      return true;
    },
  );
});

test('nvtokens client keeps structured rejection details and request ids', async () => {
  const client = new NvtokensClient({
    baseUrl: 'https://nvtokens.test',
    apiKey: 'member-key',
    fetch: async () => fakeResponse(
      { error: { detail: '账号已在号池' } },
      403,
      { 'x-request-id': 'request-fixture-403' },
    ),
  });

  await assert.rejects(
    client.poolCards({ data: [] }),
    (error) => error instanceof NvtokensError
      && error.status === 403
      && error.message === '账号已在号池'
      && error.requestId === 'request-fixture-403',
  );
});

test('nvtokens client turns an abort into a timeout error', async () => {
  const client = new NvtokensClient({
    baseUrl: 'https://nvtokens.test',
    apiKey: 'member-key',
    requestTimeoutMs: 10,
    fetch: async (_url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      }, { once: true });
    }),
  });

  await assert.rejects(
    client.poolCards({ data: [] }),
    (error) => error instanceof NvtokensError
      && error.code === 'NVTOKENS_OFFLINE'
      && /10ms/.test(error.message),
  );
});

test('nvtokens response summaries handle nested counts and partial failures', () => {
  assert.deepEqual(summarizeNvtokensResponse({ data: { accepted_count: 2, failed_count: 1 } }, 3), {
    ok: true,
    total: 3,
    accepted: 2,
    failed: 1,
    skipped: 0,
    errors: [],
    warnings: [],
  });
  assert.equal(normalizeBaseUrl('https://nvtokens.com/api/inventory/cards/pool/'), 'https://nvtokens.com');
});

test('nvtokens response summaries understand the live card rejection shape', () => {
  assert.deepEqual(summarizeNvtokensResponse({
    accepted: [],
    rejected: [{ reason: 'Codex authorization failed: HTTP 401' }],
    summary: { accepted: 0, rejected: 1 },
  }, 1), {
    ok: true,
    total: 1,
    accepted: 0,
    failed: 1,
    skipped: 0,
    errors: ['Codex authorization failed: HTTP 401'],
    warnings: [],
  });
});

test('nvtokens response summaries understand unmatched mailbox credentials', () => {
  assert.deepEqual(summarizeNvtokensResponse({
    total: 1,
    parsed: 1,
    matched: 0,
    updated: 0,
    unchanged: 0,
    returned_to_personal_inventory: 0,
    unmatched: 1,
    invalid: 0,
    duplicates: 0,
    unmatched_details: [{ reason: 'No matching inventory account' }],
  }, 1), {
    ok: true,
    total: 1,
    accepted: 0,
    failed: 1,
    skipped: 0,
    errors: ['No matching inventory account'],
    warnings: [],
  });
});

test('nvtokens HTTP errors can use a JSON request id when the header is absent', async () => {
  const client = new NvtokensClient({
    baseUrl: 'https://nvtokens.test',
    apiKey: 'member-key',
    fetch: async () => ({
      ok: false,
      status: 422,
      statusText: 'Unprocessable Entity',
      headers: { get() { return ''; } },
      async text() { return JSON.stringify({ error: 'invalid pool payload', request_id: 'body-request-id' }); },
    }),
  });

  await assert.rejects(
    client.poolCards({ data: [] }),
    (error) => error instanceof NvtokensError
      && error.status === 422
      && error.message === 'invalid pool payload'
      && error.requestId === 'body-request-id',
  );
});
