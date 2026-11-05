'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { MailcomClient } = require('../src/mailcom-client');

function jsonResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  };
}

test('Mail.com OTP requests use the remote mailbox id and one IMAP long poll', async () => {
  const requests = [];
  const client = new MailcomClient({
    baseUrl: 'http://127.0.0.1:8001/',
    adminToken: 'local-token',
    fetch: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse(200, {
        email: 'alias@example.com',
        parent: 'master@example.com',
        otp: '123456',
        messageId: '42',
        subject: 'OpenAI verification code',
      });
    },
  });

  const result = await client.findVerificationCode('mailcom:alias:1:abc', {
    maxWaitMs: 5000,
    recipient: 'alias@example.com',
    since: '2026-08-18T00:00:00.000Z',
    keyword: 'openai',
    excludeMessageIds: ['41'],
  });

  assert.equal(result.code, '123456');
  assert.equal(result.messageId, '42');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'http://127.0.0.1:8001/api/otp/fetch?provider=mailcom');
  assert.equal(requests[0].init.headers['X-Admin-Token'], 'local-token');
  const body = JSON.parse(requests[0].init.body);
  assert.deepEqual(body, {
    mailbox_id: 'mailcom:alias:1:abc',
    // The address itself travels, not only the intent to filter by one:
    // registration uses the alias while delivery lands in the root inbox.
    email: 'alias@example.com',
    max_wait: 5,
    poll_interval: 1,
    match_subjects: ['openai'],
    match_recipient: true,
    since: '2026-08-18T00:00:00.000Z',
    exclude_message_ids: ['41'],
  });
});

test('Mail.com forwards the task send time for provider-side timestamp tolerance', async () => {
  const client = new MailcomClient({
    adminToken: 'local-token',
    fetch: async (_url, init) => {
      const body = JSON.parse(init.body);
      assert.equal(body.since, '2026-08-18T00:00:00.000Z');
      return jsonResponse(200, {
        email: 'alias@example.com',
        otp: null,
      });
    },
  });

  await client.findVerificationCode('mailcom:alias:1:abc', {
    maxWaitMs: 1000,
    recipient: 'alias@example.com',
    since: '2026-08-18T00:00:00.000Z',
    excludeMessageIds: ['41'],
  });

  assert.equal(client.lastOtpDiagnostics('mailcom:alias:1:abc').sentAt, '2026-08-18T00:00:00.000Z');
});

test('Mail.com client treats an empty OTP response as a poll miss', async () => {
  const client = new MailcomClient({
    adminToken: 'local-token',
    fetch: async () => jsonResponse(200, { email: 'alias@example.com', otp: null }),
  });

  assert.equal(await client.findVerificationCode('mailcom:alias:1:abc', { maxWaitMs: 1000 }), null);
});

test('Mail.com OTP diagnostics stay keyed when workers poll different mailboxes', async () => {
  const client = new MailcomClient({
    adminToken: 'local-token',
    fetch: async (_url, init) => {
      const mailboxId = JSON.parse(init.body).mailbox_id;
      return jsonResponse(200, {
        email: `${mailboxId}@example.com`,
        otp: null,
        checked_emails: mailboxId.endsWith('one') ? 1 : 2,
      });
    },
  });

  await client.findVerificationCode('mailcom:alias:1:one', { maxWaitMs: 1000 });
  await client.findVerificationCode('mailcom:alias:1:two', { maxWaitMs: 1000 });

  assert.equal(client.lastOtpDiagnostics('mailcom:alias:1:one').checkedEmails, 1);
  assert.equal(client.lastOtpDiagnostics('mailcom:alias:1:two').checkedEmails, 2);
  assert.equal(client.lastOtpFetch.mailboxId, 'mailcom:alias:1:two');
});

test('Mail.com client preserves structured non-retryable mailbox errors', async () => {
  const client = new MailcomClient({
    adminToken: 'local-token',
    fetch: async () => jsonResponse(422, {
      detail: {
        code: 'IMAP_AUTH_FAILED',
        message: 'IMAP 登录失败: authentication failed',
        retryable: false,
        category: 'mailbox_authentication',
      },
    }),
  });

  await assert.rejects(
    client.findVerificationCode('mailcom:alias:1:abc', { maxWaitMs: 1000 }),
    (error) => {
      assert.equal(error.code, 'IMAP_AUTH_FAILED');
      assert.equal(error.category, 'mailbox_authentication');
      assert.equal(error.retryable, false);
      return true;
    },
  );
});

test('Mail.com client maps transport and remote HTTP failures to actionable statuses', async () => {
  const unavailable = new MailcomClient({
    provider: 'fastmail',
    adminToken: 'local-token',
    fetch: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:8001'); },
  });
  await assert.rejects(unavailable.checkAuth(), (error) => {
    assert.equal(error.code, 'MAIL_PROVIDER_UNAVAILABLE');
    assert.equal(error.statusCode, 503);
    assert.equal(error.public, true);
    assert.equal(error.retryable, true);
    return true;
  });

  const rejected = new MailcomClient({
    provider: 'fastmail',
    adminToken: 'local-token',
    fetch: async () => jsonResponse(401, { detail: 'invalid admin token' }),
  });
  await assert.rejects(rejected.checkAuth(), (error) => {
    assert.equal(error.status, 401);
    assert.equal(error.statusCode, 502);
    assert.equal(error.code, 'MAIL_PROVIDER_HTTP_ERROR');
    assert.equal(error.mailProvider, 'fastmail');
    assert.equal(error.publicDetails.upstreamStatus, 401);
    return true;
  });
});

test('Mail.com client carries the configured alias batch size through import and recycle', async () => {
  const requests = [];
  const client = new MailcomClient({
    adminToken: 'local-token',
    aliasBatchSize: 9,
    fetch: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse(200, {});
    },
  });

  await client.importMasters('master@example.com----password', { count: 9 });
  await client.consumeMailbox('mailcom:alias:1:abc', { note: 'finished' });

  assert.equal(requests[0].url, 'http://127.0.0.1:8001/api/masters/bulk?provider=mailcom');
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    content: 'master@example.com----password',
    count: 9,
    domain_mode: 'random',
    domains: [],
  });
  assert.equal(requests[1].url, 'http://127.0.0.1:8001/api/pool/consume?provider=mailcom');
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    id: 'mailcom:alias:1:abc',
    note: 'finished',
    alias_count: 9,
    domain_mode: 'random',
    domains: [],
  });
});

test('Mail.com client carries a selected alias domain policy', async () => {
  const requests = [];
  const client = new MailcomClient({
    adminToken: 'local-token',
    aliasDomainMode: 'selected',
    aliasDomains: ['torontomail.com', 'swissmail.com'],
    fetch: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse(200, {});
    },
  });

  await client.importMasters('master@example.com----password');
  const body = JSON.parse(requests[0].init.body);
  assert.equal(body.domain_mode, 'selected');
  assert.deepEqual(body.domains, ['torontomail.com', 'swissmail.com']);
});

test('Mail.com snapshot requests send only the mailbox id accepted by 8001', async () => {
  const requests = [];
  const client = new MailcomClient({
    adminToken: 'local-token',
    fetch: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse(200, { mailboxId: 'mailcom:alias:1:abc', messageIds: [] });
    },
  });

  await client.snapshotMailbox('mailcom:alias:1:abc', { maxResults: 100 });

  assert.deepEqual(JSON.parse(requests[0].init.body), { id: 'mailcom:alias:1:abc' });
});

test('Mail.com client records the transition from a temporary claim to registration', async () => {
  const requests = [];
  const client = new MailcomClient({
    adminToken: 'local-token',
    fetch: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse(200, { lifecycle: 'registration_in_progress' });
    },
  });

  await client.markMailboxRegistrationStarted('mailcom:alias:1:abc', { note: 'run=test' });

  assert.equal(requests[0].url, 'http://127.0.0.1:8001/api/pool/registration-started?provider=mailcom');
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    id: 'mailcom:alias:1:abc',
    note: 'run=test',
  });
});

test('Fastmail requests carry the provider selector and normalize its domain catalog', async () => {
  const requests = [];
  const client = new MailcomClient({
    provider: 'fastmail',
    adminToken: 'local-token',
    fetch: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse(200, {
        provider: 'fastmail',
        candidateDomains: ['candidate.example'],
        catalogDomains: ['usable.example'],
        selectedDomains: ['usable.example'],
        deniedDomains: ['blocked.example'],
      });
    },
  });

  const domains = await client.listAliasDomains();
  await client.reserveMailbox('fastmail:alias:1:abc');

  assert.deepEqual(domains.domains, ['usable.example']);
  assert.deepEqual(domains.availableDomains, ['usable.example']);
  assert.equal(requests[0].url, 'http://127.0.0.1:8001/api/aliases/domains?provider=fastmail');
  assert.equal(requests[1].url, 'http://127.0.0.1:8001/api/pool/reserve?provider=fastmail');
});

test('Fastmail uses its own default refill batch and rejects an aggregate response', async () => {
  const requests = [];
  const client = new MailcomClient({
    provider: 'fastmail',
    adminToken: 'local-token',
    fetch: async (url, init) => {
      requests.push({ url, init });
      return jsonResponse(200, { provider: 'fastmail', accounts: [], summary: { provider: 'fastmail' } });
    },
  });

  await client.importMasters('master@example.com----password');
  assert.equal(JSON.parse(requests[0].init.body).count, 1);

  const staleClient = new MailcomClient({
    provider: 'fastmail',
    adminToken: 'local-token',
    fetch: async () => jsonResponse(200, { provider: 'unified', accounts: [] }),
  });
  await assert.rejects(staleClient.listAccounts(), (error) => {
    assert.equal(error.code, 'PROVIDER_MISMATCH');
    assert.equal(error.retryable, false);
    return true;
  });
});
