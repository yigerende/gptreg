'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { IcloudClient } = require('../src/icloud-client');

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  };
}

test('iCloud imports mailbox endpoints through its own provider route', async () => {
  const requests = [];
  const client = new IcloudClient({
    baseUrl: 'http://127.0.0.1:8001/',
    adminToken: 'local-token',
    fetch: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse(200, { provider: 'icloud', added: 1, duplicates: [] });
    },
  });

  await client.addMaster(
    'icloud@example.test',
    'https://api.wdmail.top/m?f=html&e=icloud@example.test:example-password',
  );

  assert.equal(requests[0].url, 'http://127.0.0.1:8001/api/masters?provider=icloud');
  assert.equal(requests[0].init.headers['X-Admin-Token'], 'local-token');
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    email: 'icloud@example.test',
    password: 'https://api.wdmail.top/m?f=html&e=icloud@example.test:example-password',
    count: 1,
  });
});

test('iCloud OTP polling keeps the mailbox filter and does not use alias APIs', async () => {
  const requests = [];
  const client = new IcloudClient({
    adminToken: 'local-token',
    fetch: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse(200, {
        provider: 'icloud',
        email: 'icloud@example.test',
        otp: '654321',
        messageId: 'wd-1',
        source: 'wdmail_http',
      });
    },
  });

  const result = await client.findVerificationCode('icloud:mailbox:one', {
    maxWaitMs: 60000,
    recipient: 'icloud@example.test',
    keyword: 'openai',
    since: '2026-09-15T00:00:00.000Z',
  });

  assert.equal(result.code, '654321');
  assert.equal(requests[0].url, 'http://127.0.0.1:8001/api/otp/fetch?provider=icloud');
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    mailbox_id: 'icloud:mailbox:one',
    max_wait: 15,
    poll_interval: 3,
    match_subjects: ['openai'],
    match_recipient: true,
    email: 'icloud@example.test',
    since: '2026-09-15T00:00:00.000Z',
    exclude_message_ids: [],
  });
  assert.deepEqual(await client.listAliasDomains(), {
    provider: 'icloud',
    mode: 'random',
    domains: [],
    availableDomains: [],
    selectedDomains: [],
    deniedDomains: [],
  });
});

test('iCloud retries once with a bounded clock-skew fallback when the candidate predates since', async () => {
  const requests = [];
  const client = new IcloudClient({
    adminToken: 'local-token',
    fetch: async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      const result = requests.length === 1
        ? {
          provider: 'icloud',
          email: 'icloud@example.test',
          otp: null,
          receivedAt: '2026-09-15T00:00:05.000Z',
          checked_emails: 1,
          listed: 1,
          source: 'wdmail_http',
        }
        : {
          provider: 'icloud',
          email: 'icloud@example.test',
          otp: '123456',
          messageId: 'wd-skewed-1',
          receivedAt: '2026-09-15T00:00:05.000Z',
          checked_emails: 1,
          listed: 1,
          source: 'wdmail_http',
        };
      return jsonResponse(200, result);
    },
  });

  const result = await client.findVerificationCode('icloud:mailbox:one', {
    maxWaitMs: 3000,
    recipient: 'icloud@example.test',
    keyword: 'openai',
    since: '2026-09-15T00:00:20.000Z',
    excludeMessageIds: ['old-message'],
  });

  assert.equal(result.code, '123456');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.since, '2026-09-15T00:00:20.000Z');
  assert.equal(requests[1].body.since, '2026-09-15T00:00:04.000Z');
  assert.deepEqual(requests[1].body.exclude_message_ids, ['old-message']);
  assert.equal(requests[1].body.email, 'icloud@example.test');
  assert.deepEqual(client.lastOtpDiagnostics('icloud:mailbox:one').clockSkewFallback, {
    attempted: true,
    used: true,
    originalSince: '2026-09-15T00:00:20.000Z',
    fallbackSince: '2026-09-15T00:00:04.000Z',
    receivedAt: '2026-09-15T00:00:05.000Z',
    skewSeconds: 15,
  });
});

test('iCloud does not widen the mail boundary beyond the clock-skew tolerance', async () => {
  const requests = [];
  const client = new IcloudClient({
    adminToken: 'local-token',
    fetch: async (url, init) => {
      requests.push({ url, init, body: JSON.parse(init.body) });
      return jsonResponse(200, {
        provider: 'icloud',
        email: 'icloud@example.test',
        otp: null,
        receivedAt: '2026-09-14T23:58:00.000Z',
        checked_emails: 1,
        listed: 1,
        source: 'wdmail_http',
      });
    },
  });

  const result = await client.findVerificationCode('icloud:mailbox:one', {
    maxWaitMs: 3000,
    recipient: 'icloud@example.test',
    since: '2026-09-15T00:00:00.000Z',
  });

  assert.equal(result, null);
  assert.equal(requests.length, 1);
  assert.equal(client.lastOtpDiagnostics('icloud:mailbox:one').clockSkewFallback.attempted, false);
});

test('iCloud rejects a response from another provider pool', async () => {
  const client = new IcloudClient({
    adminToken: 'local-token',
    fetch: async () => jsonResponse(200, { provider: 'fastmail', accounts: [] }),
  });

  await assert.rejects(
    client.listAccounts(),
    (error) => {
      assert.equal(error.code, 'PROVIDER_MISMATCH');
      assert.equal(error.mailProvider, 'icloud');
      return true;
    },
  );
});

test('iCloud carries the upstream Retry-After delay to the registration retry path', async () => {
  const client = new IcloudClient({
    adminToken: 'local-token',
    fetch: async () => jsonResponse(429, {
      detail: {
        code: 'ICLOUD_MAIL_TRANSPORT_ERROR',
        message: 'WDMail returned HTTP 429',
        retryable: true,
        retryAfterMs: 2000,
      },
    }),
  });

  await assert.rejects(
    client.listAccounts(),
    (error) => {
      assert.equal(error.retryAfterMs, 2000);
      assert.equal(error.publicDetails.retryAfterMs, 2000);
      return true;
    },
  );
});

test('an iCloud +alias reads its code from the root inbox by the root address', async () => {
  // 8001 resolves the inbox by root address and rejects any other recipient
  // ("recipient does not match mailbox"); mail to the alias lands in the root.
  const requests = [];
  const client = new IcloudClient({
    adminToken: 'local-token',
    fetch: async (url, init) => {
      requests.push(JSON.parse(init.body));
      return jsonResponse(200, { provider: 'icloud', email: 'apple@icloud.com', otp: '112233', messageId: 'wd-2' });
    },
  });
  const result = await client.findVerificationCode('icloud:mailbox:apple', {
    recipient: 'Apple+workerXqTb@iCloud.com',
    since: '2026-10-13T12:30:00.000Z',
  });
  assert.equal(result.code, '112233');
  assert.equal(requests[0].email, 'apple@icloud.com');
  assert.equal(requests[0].mailbox_id, 'icloud:mailbox:apple');
  assert.equal(requests[0].since, '2026-10-13T12:30:00.000Z');
  // Diagnostics still name the alias the code was for.
  assert.equal(client.lastOtpDiagnostics('icloud:mailbox:apple').recipient, 'Apple+workerXqTb@iCloud.com');
});
