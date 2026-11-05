'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { MailcomClient } = require('../src/mailcom-client');
const { XiaopingguoClient } = require('../src/xiaopingguo-client');
const { createRebindMailChannel, pollOtp } = require('../src/rebind-mail-channel');

const mailbox = (id) => ({ id, email: `${id}@example.test`, status: 'available' });

test('concurrent claims share one pool read and reserve different mailboxes without warmup', async () => {
  let reads = 0;
  const reserved = [];
  const rows = Array.from({ length: 20 }, (_, i) => mailbox(String(i)));
  const channel = createRebindMailChannel('fastmail', {
    listAccounts: async () => { reads++; return rows; },
    reserveMailbox: async (id) => { reserved.push(id); },
    ensurePool: async () => assert.fail('a ready pool needs no warmup'),
  });
  const claimed = await Promise.all(rows.map(() => channel.claim()));
  assert.equal(reads, 1);
  assert.equal(new Set(claimed.map((row) => row.mailboxId)).size, 20);
  assert.equal(new Set(reserved).size, 20);
});

test('an empty pool is refilled once and used addresses are never recycled within a batch', async () => {
  let fills = 0;
  const channel = createRebindMailChannel('mailcom', {
    listAccounts: async () => fills ? [mailbox('one')] : [],
    reserveMailbox: async () => {},
    ensurePool: async () => { fills++; },
  });
  const claimed = await Promise.all([channel.claim(), channel.claim(), channel.claim()]);
  assert.equal(fills, 1);
  assert.deepEqual(claimed.map((row) => row?.mailboxId || null), ['one', null, null]);
});

test('reservation conflicts skip that address and other reservation failures stop allocation', async () => {
  const channel = createRebindMailChannel('mailcom', {
    listAccounts: async () => [mailbox('taken'), mailbox('free'), mailbox('offline')],
    reserveMailbox: async (id) => {
      if (id === 'taken') throw Object.assign(new Error('taken'), { status: 409 });
      if (id === 'offline') throw new Error('reserve unavailable');
    },
  });
  assert.equal((await channel.claim()).mailboxId, 'free');
  await assert.rejects(channel.claim(), /reserve unavailable/);
});

test('xiaopingguo logs in once and reserves each account before the next claim', async () => {
  const events = [];
  let index = 0;
  const channel = createRebindMailChannel('xiaopingguo', {
    login: async () => { events.push('login'); },
    randomUnbound: async () => { events.push('read'); return mailbox(String(++index)); },
    reserveMailbox: async () => { events.push('reserve'); },
  }, { password: 'test-only' });
  await Promise.all([channel.claim(), channel.claim()]);
  assert.deepEqual(events, ['login', 'read', 'reserve', 'read', 'reserve']);
});

test('mail request timeout aborts a response body that never finishes', { timeout: 2000 }, async (t) => {
  const server = http.createServer((_request, response) => { response.writeHead(200); response.write('{'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const client = new MailcomClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, adminToken: 'fixture', provider: 'fastmail' });
  const channel = createRebindMailChannel('fastmail', client, { requestTimeoutMs: 50 });
  await assert.rejects(channel.claim(), /abort|timeout/i);
});

test('OTP long polling is not followed by a second full wait', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  let calls = 0;
  const code = await pollOtp(async () => {
    if (++calls === 1) { t.mock.timers.tick(4000); return null; }
    return '123456';
  }, { timeoutMs: 12000, pollIntervalMs: 4000 });
  assert.equal(code, '123456');
  assert.equal(Date.now(), 4000);
});

test('recipient mismatch ends polling immediately with progress and per-mailbox diagnostics', async () => {
  let reads = 0;
  const progress = [];
  const client = {
    findVerificationCode: async () => { reads++; return null; },
    lastOtpDiagnostics: (id) => ({ mailboxId: id, listed: 3, checkedEmails: 0, siblings: { count: 2 } }),
  };
  const channel = createRebindMailChannel('fastmail', client);
  const result = await channel.readOtp('box', { recipient: 'target@example.test', timeoutMs: 120000, pollIntervalMs: 4000, onPoll: (item) => progress.push(item) });
  assert.equal(reads, 1);
  assert.equal(result.reason, 'recipient_mismatch');
  assert.equal(result.diagnostics.siblingCount, 2);
  assert.equal(progress[0].polls, 1);
});

test('a retryable provider error at the deadline becomes a mailbox timeout', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const channel = createRebindMailChannel('fastmail', {
    findVerificationCode: async () => { t.mock.timers.tick(120000); throw Object.assign(new Error('temporary outage'), { retryable: true }); },
  });
  const result = await channel.readOtp('box', { timeoutMs: 120000, pollIntervalMs: 4000 });
  assert.equal(result.reason, 'otp_timeout');
});

test('diagnostics from a different mailbox cannot trigger a replacement', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const channel = createRebindMailChannel('fastmail', {
    findVerificationCode: async () => { t.mock.timers.tick(100); return null; },
    lastOtpFetchByMailbox: new Map(),
    lastOtpFetch: { mailboxId: 'other', listed: 4, checkedEmails: 0 },
  });
  const result = await channel.readOtp('box', { timeoutMs: 100, pollIntervalMs: 100 });
  assert.equal(result.reason, 'otp_timeout');
  assert.equal(result.diagnostics, null);
});

test('OTP deadline interrupts a hanging HTTP read before the provider request deadline', { timeout: 2000 }, async (t) => {
  const server = http.createServer((_request, response) => { response.writeHead(200); response.write('{'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const client = new MailcomClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, adminToken: 'fixture', provider: 'fastmail' });
  const channel = createRebindMailChannel('fastmail', client, { requestTimeoutMs: 10000 });
  const result = await channel.readOtp('box', { timeoutMs: 30, pollIntervalMs: 5 });
  assert.equal(result.reason, 'otp_timeout');
});

test('fatal mailbox errors remain failures instead of silently replacing the mailbox', async () => {
  const channel = createRebindMailChannel('fastmail', {
    findVerificationCode: async () => { throw Object.assign(new Error('not authorized'), { status: 401 }); },
  });
  await assert.rejects(channel.readOtp('box', { timeoutMs: 100 }), /not authorized/);
});

test('xiaopingguo exposes recipient mismatches without counting old mail as a new delivery', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-09-16T08:00:00Z') });
  const client = new XiaopingguoClient();
  let receivedAt = new Date(Date.now()).toISOString();
  client.listMailFolders = async () => {
    t.mock.timers.tick(100);
    return { folders: { inbox: [{ id: 'message', to: 'other@example.test', subject: 'Verification code 123456', date: receivedAt }], junkemail: [] }, errors: [] };
  };
  const channel = createRebindMailChannel('xiaopingguo', client);
  const options = { recipient: 'target@example.test', since: new Date(Date.now()).toISOString(), timeoutMs: 100, pollIntervalMs: 100 };
  assert.equal((await channel.readOtp('box', options)).reason, 'recipient_mismatch');
  receivedAt = '2020-01-01T00:00:00Z';
  const result = await channel.readOtp('box', options);
  assert.equal(result.reason, 'otp_timeout');
  assert.equal(result.diagnostics.listed, 0);
});

test('mail rejected by the time filter does not trigger an immediate recipient replacement', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  let polls = 0;
  const channel = createRebindMailChannel('fastmail', {
    findVerificationCode: async () => {
      t.mock.timers.tick(100);
      return ++polls === 2 ? { code: '123456' } : null;
    },
    lastOtpDiagnostics: () => ({ listed: 3, checkedEmails: 0, found: polls === 2, dropped: { since: 3, recipient: 0 } }),
  });
  const result = await channel.readOtp('box', { timeoutMs: 300, pollIntervalMs: 100 });
  assert.equal(polls, 2);
  assert.equal(result.code, '123456');
});
