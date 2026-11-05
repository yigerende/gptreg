'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { SmsbowerMailClient } = require('../src/smsbower-mail-client');

/** Records every call and answers from a scripted queue keyed by endpoint. */
function stubFetch(script) {
  const calls = [];
  const fetch = async (url) => {
    const parsed = new URL(url);
    const endpoint = parsed.pathname.split('/').pop();
    calls.push({ endpoint, params: Object.fromEntries(parsed.searchParams) });
    const queue = script[endpoint];
    const body = Array.isArray(queue) ? queue.shift() : queue;
    if (body === undefined) throw new Error(`unscripted call to ${endpoint}`);
    if (typeof body === 'function') return body();
    return { status: 200, text: async () => JSON.stringify(body) };
  };
  return { fetch, calls };
}

function client(script, options = {}) {
  const { fetch, calls } = stubFetch(script);
  return {
    calls,
    // A known unit price by default: renting looks the price up when it has
    // none, and these tests are about the lifecycle, not the quote.
    mail: new SmsbowerMailClient({ apiKey: 'key-1', unitPrice: 0.1, fetch, now: () => 1770000000000, ...options }),
  };
}

test('renting yields a mailbox the orchestrator can hold like a pooled one', async () => {
  const { mail, calls } = client({ getActivation: { status: 1, mail: 'someone@gmail.com', mailId: 4 } });

  const rented = await mail.rentMailbox();
  assert.equal(rented.id, '4');
  assert.equal(rented.email, 'someone@gmail.com');
  assert.deepEqual(await mail.listAccounts(), [{ id: '4', email: 'someone@gmail.com', tokenValid: true, bound: false }]);
  assert.equal(calls[0].params.service, 'dr');
  assert.equal(calls[0].params.domain, 'gmail.com');
  assert.equal(calls[0].params.api_key, 'key-1');
});

test('an unstarted rental is cancelled at its registration-start deadline', async () => {
  let now = 1770000000000;
  const { mail, calls } = client({
    getActivation: { status: 1, mail: 'timeout@gmail.com', mailId: 41 },
    setStatus: { status: 1, message: 'Success' },
  }, { now: () => now, unstartedRentalTimeoutMs: 1000 });

  const rented = await mail.rentMailbox();
  assert.equal(rented.registrationStartDeadlineAt, new Date(now + 1000).toISOString());
  now += 1000;

  const expired = await mail.expireUnstartedMailboxes({ now });
  assert.deepEqual(expired, [{ id: '41', email: 'timeout@gmail.com', cancelled: true }]);
  assert.equal(calls.at(-1).params.status, '2');
  assert.deepEqual(await mail.listAccounts(), []);
});

test('concurrent expiry checks share one cancellation request per rental', async () => {
  let now = 1770000000000;
  let releaseStatus;
  const statusResponse = new Promise((resolve) => {
    releaseStatus = (body) => resolve({
      status: 200,
      text: async () => JSON.stringify(body),
    });
  });
  const { mail, calls } = client({
    getActivation: { status: 1, mail: 'race@gmail.com', mailId: 411 },
    setStatus: () => statusResponse,
  }, { now: () => now, unstartedRentalTimeoutMs: 1000 });

  const rented = await mail.rentMailbox();
  now += 1000;
  const first = mail.expireUnstartedMailboxes({ now });
  const second = mail.expireUnstartedMailboxes({ now });

  assert.equal(calls.filter((call) => call.endpoint === 'setStatus').length, 1);
  releaseStatus({ status: 1, message: 'Success' });
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.deepEqual(firstResult, [{ id: rented.id, email: rented.email, cancelled: true }]);
  assert.deepEqual(secondResult, firstResult);
  assert.equal(calls.filter((call) => call.endpoint === 'setStatus').length, 1);
});

test('marking registration started releases the rental timeout', async () => {
  let now = 1770000000000;
  const { mail, calls } = client({
    getActivation: { status: 1, mail: 'started@gmail.com', mailId: 42 },
    setStatus: { status: 1, message: 'Success' },
  }, { now: () => now, unstartedRentalTimeoutMs: 1000 });

  const rented = await mail.rentMailbox();
  assert.equal(mail.markMailboxRegistrationStarted(rented.id, { startedAt: new Date(now).toISOString() }), true);
  now += 1000;

  assert.deepEqual(await mail.expireUnstartedMailboxes({ now }), []);
  assert.equal(calls.some((call) => call.params.status === '2'), false);
  assert.equal((await mail.listAccounts())[0].id, '42');
});

test('an empty inventory is flagged as inventory, not as a broken request', async () => {
  const { mail } = client({ getActivation: { status: 0, error: 'No mails yet' } });
  await assert.rejects(mail.rentMailbox(), (error) => error.soldOut === true && !error.insufficientBalance);
});

test('an unpaid balance is distinguishable from an empty inventory', async () => {
  const { mail } = client({ getActivation: { status: 0, error: 'Insufficient balance' } });
  await assert.rejects(mail.rentMailbox(), (error) => error.insufficientBalance === true && !error.soldOut);
});

test('a code that has not arrived reads as null so the caller keeps polling', async () => {
  const { mail } = client({
    getActivation: { status: 1, mail: 'a@gmail.com', mailId: 7 },
    getCode: [
      { status: 0, error: 'Code has not been received yet, please try again later' },
      { status: 1, code: '123456' },
    ],
  });
  const rented = await mail.rentMailbox();

  assert.equal(await mail.findVerificationCode(rented.id), null);
  const found = await mail.findVerificationCode(rented.id);
  assert.equal(found.code, '123456');
  assert.equal(found.source, 'smsbower_mail');
});

test('the next code is armed the moment one is consumed, not when the next read comes', async () => {
  // The provider only forwards a message that arrives while the activation is
  // waiting for one. The next email lands seconds after a code is consumed, so
  // arming on the following read loses it — measured at a full 120s poll
  // timeout on a real run before anything could retry.
  const { mail, calls } = client({
    getActivation: { status: 1, mail: 'root@gmail.com', mailId: 9 },
    getCode: [{ status: 1, code: '111111' }, { status: 1, code: '222222' }],
    setStatus: [{ status: 1, message: 'Success' }, { status: 1, message: 'Success' }],
  });
  const rented = await mail.rentMailbox();

  assert.equal((await mail.findVerificationCode(rented.id)).code, '111111');
  // The arm has already happened, before anyone asked for the second code.
  assert.deepEqual(calls.map((call) => call.endpoint), ['getActivation', 'getCode', 'setStatus']);
  assert.equal(calls[2].params.status, '5');
  assert.equal(calls[2].params.id, '9');

  assert.equal((await mail.findVerificationCode(rented.id)).code, '222222');
  // And the second read does not arm again on the way in.
  assert.deepEqual(calls.map((call) => call.endpoint), ['getActivation', 'getCode', 'setStatus', 'getCode', 'setStatus']);
});

test('a failed arm does not swallow the code that was already read', async () => {
  const { mail } = client({
    getActivation: { status: 1, mail: 'root@gmail.com', mailId: 21 },
    getCode: [{ status: 1, code: '444444' }],
    setStatus: [{ status: 0, error: 'temporary' }],
  });
  const rented = await mail.rentMailbox();
  assert.equal((await mail.findVerificationCode(rented.id)).code, '444444');
});

test('reading a code never settles the rental; only the caller does', async () => {
  const { mail, calls } = client({
    getActivation: { status: 1, mail: 'b@gmail.com', mailId: 11 },
    getCode: [{ status: 1, code: '333333' }],
    // Two: one arms the next code on consume, one settles at the end.
    setStatus: [{ status: 1, message: 'Success' }, { status: 1, message: 'Success' }],
  });
  const rented = await mail.rentMailbox();
  await mail.findVerificationCode(rented.id);
  assert.equal(calls.some((call) => call.endpoint === 'setStatus' && call.params.status === '3'), false);

  assert.equal(await mail.settleMailbox(rented.id), true);
  assert.equal(calls.at(-1).params.status, '3');
  // Settling twice is a no-op rather than a second charge.
  assert.equal(await mail.settleMailbox(rented.id), false);
  // And a settled mailbox drops out of the held list.
  assert.deepEqual(await mail.listAccounts(), []);
});

test('a mailbox that produced nothing is cancelled rather than accepted', async () => {
  const { mail, calls } = client({
    getActivation: { status: 1, mail: 'c@gmail.com', mailId: 13 },
    setStatus: [{ status: 1, message: 'Success' }],
  });
  const rented = await mail.rentMailbox();
  assert.equal(await mail.cancelMailbox(rented.id), true);
  assert.equal(calls.at(-1).params.status, '2');
  await assert.rejects(mail.findVerificationCode(rented.id), /already settled/);
});

test('the boundary contract is satisfied without an inbox to read', async () => {
  const { mail } = client({ getActivation: { status: 1, mail: 'd@gmail.com', mailId: 15 } });
  const rented = await mail.rentMailbox();
  const boundary = await mail.snapshotMailbox(rented.id);
  assert.deepEqual(boundary.messageIds, []);
  assert.equal(typeof boundary.capturedAt, 'string');
});

test('price and inventory come back in the shape the preflight needs', async () => {
  const { mail } = client({
    getPriceRests: { status: 1, data: { dr: { 'gmail.com': { price: 0.12, count: 5 } } } },
  });
  assert.deepEqual(await mail.priceRests(), { service: 'dr', domain: 'gmail.com', price: 0.12, count: 5 });
});

test('an incomplete service or domain response is rejected instead of becoming zero inventory', async () => {
  const { mail } = client(
    { getPriceRests: { status: 1, data: {} } },
    { stockRetryAttempts: 1, stockRetryDelayMs: 0 },
  );
  await assert.rejects(mail.priceRests(), (error) => error.code === 'MAIL_STOCK_RESPONSE_INVALID');
});

test('a temporary incomplete stock response recovers on the next attempt', async () => {
  const { mail, calls } = client({
    getPriceRests: [
      { status: 1, data: {} },
      { status: 1, data: { dr: { 'gmail.com': { price: 0.15, count: 7 } } } },
    ],
  }, { stockRetryDelayMs: 0 });

  assert.deepEqual(await mail.priceRests(), { service: 'dr', domain: 'gmail.com', price: 0.15, count: 7 });
  assert.equal(calls.filter((call) => call.endpoint === 'getPriceRests').length, 2);
});

test('an unsuccessful stock response is rejected instead of becoming zero inventory', async () => {
  const { mail } = client(
    { getPriceRests: { status: 0, error: 'temporary catalogue failure' } },
    { stockRetryAttempts: 1, stockRetryDelayMs: 0 },
  );
  await assert.rejects(mail.priceRests(), (error) => error.code === 'MAIL_STOCK_RESPONSE_REJECTED');
});

test('a transport failure is retryable while a rejected request is not', async () => {
  const boom = new SmsbowerMailClient({ apiKey: 'k', fetch: async () => { throw new Error('ECONNRESET'); } });
  await assert.rejects(boom.priceRests(), (error) => error.retryable === true);

  const { mail } = client({ getPriceRests: () => ({ status: 400, text: async () => JSON.stringify({ error: 'Bad request' }) }) });
  await assert.rejects(mail.priceRests(), (error) => error.retryable === false && error.status === 400);
});

test('no api key fails before a request is ever made', async () => {
  const keyless = new SmsbowerMailClient({ apiKey: '', fetch: async () => { throw new Error('must not be called'); } });
  await assert.rejects(keyless.rentMailbox(), /no API key/);
});

test('a resumed process can close a persisted rental by provider mail id', async () => {
  const { mail, calls } = client({ setStatus: { status: 1, message: 'Success' } });
  const restored = mail.restoreMailbox({
    id: 34,
    email: 'resumed@gmail.com',
    quotedPriceUsd: 0.11,
  });

  assert.equal(restored.id, '34');
  assert.equal(await mail.cancelMailbox(restored.id), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].endpoint, 'setStatus');
  assert.equal(calls[0].params.id, '34');
  assert.equal(calls[0].params.status, '2');
  // The local terminal marker also makes a repeated cleanup a no-op.
  assert.equal(await mail.cancelMailbox(restored.id), false);
  assert.equal(calls.length, 1);
});

test('a resumed rental uses its persisted rentedAt when checking the start deadline', async () => {
  const rentedAt = new Date(1770000000000).toISOString();
  const { mail, calls } = client({
    setStatus: { status: 1, message: 'Success' },
  }, { unstartedRentalTimeoutMs: 1000 });
  const restored = mail.restoreMailbox({
    id: 43,
    email: 'restored-timeout@gmail.com',
    reservedAt: rentedAt,
  });

  const expired = await mail.expireUnstartedMailboxes({ now: 1770000001000 });
  assert.deepEqual(expired, [{ id: '43', email: 'restored-timeout@gmail.com', cancelled: true }]);
  assert.equal(calls[0].params.id, restored.id);
  assert.equal(calls[0].params.status, '2');
});

test('an unknown provider mailbox is idempotently cancelled once', async () => {
  const { mail, calls } = client({ setStatus: { status: 0, error: 'Unknown mailbox' } });
  const restored = mail.restoreMailbox({ id: 35, email: 'gone@gmail.com' });

  assert.equal(await mail.cancelMailbox(restored.id), true);
  assert.equal(calls.length, 1);
  assert.equal(await mail.cancelMailbox(restored.id), false);
  assert.equal(calls.length, 1);
});

test('a provider mailbox-state rejection is non-retryable for cleanup', async () => {
  const { mail, calls } = client({ setStatus: { status: 0, error: 'Bad actual activation status' } });
  const restored = mail.restoreMailbox({ id: 36, email: 'state-rejected@gmail.com' });

  await assert.rejects(mail.cancelMailbox(restored.id), (error) => (
    error.code === 'MAILBOX_STATE_REJECTED'
    && error.providerStateRejected === true
    && error.retryable === false
  ));
  assert.equal(calls.length, 1);
});

test('a generic HTTP 404 is not silently classified as a missing rental', async () => {
  const mail = new SmsbowerMailClient({
    apiKey: 'key-1',
    fetch: async () => ({ status: 404, text: async () => JSON.stringify({ error: 'Not Found' }) }),
  });

  await assert.rejects(mail.priceRests(), (error) => (
    error.status === 404 && error.mailboxGone !== true && error.retryable === false
  ));
});

test('a rental is billed only once it is settled, at the quoted unit price', async () => {
  const { mail, calls } = client({
    // No unit price known yet, so renting has to look one up first.
    getPriceRests: { status: 1, data: { dr: { 'gmail.com': { price: 0.14, count: 4 } } } },
    getActivation: [
      { status: 1, mail: 'kept@gmail.com', mailId: 31 },
      { status: 1, mail: 'dropped@gmail.com', mailId: 32 },
    ],
    setStatus: [{ status: 1, message: 'Success' }, { status: 1, message: 'Success' }],
  }, { unitPrice: 0 });

  const kept = await mail.rentMailbox();
  assert.equal(calls[0].endpoint, 'getPriceRests', 'the quote is fetched before the first rental');
  assert.equal(kept.quotedPrice, 0.14);
  // Quoted is not charged.
  assert.equal(mail.costSummary().totalUsd, 0);

  const dropped = await mail.rentMailbox();
  // The second rental reuses the cached quote rather than asking again.
  assert.equal(calls.filter((call) => call.endpoint === 'getPriceRests').length, 1);

  await mail.settleMailbox(kept.id);
  await mail.cancelMailbox(dropped.id);

  const summary = mail.costSummary();
  assert.equal(summary.rented, 2);
  assert.equal(summary.settled, 1);
  assert.equal(summary.cancelled, 1);
  // Only the settled one is paid for.
  assert.equal(summary.totalUsd, 0.14);
});

test('an unavailable quote does not block a rental, it just leaves the cost unknown', async () => {
  const { mail } = client({
    getPriceRests: () => { throw new Error('ECONNRESET'); },
    getActivation: { status: 1, mail: 'unpriced@gmail.com', mailId: 33 },
    setStatus: [{ status: 1, message: 'Success' }],
  }, { unitPrice: 0 });

  const rented = await mail.rentMailbox();
  assert.equal(rented.quotedPrice, 0);
  await mail.settleMailbox(rented.id);
  assert.equal(mail.costSummary().totalUsd, 0);
});

test('a pre-send boundary drains codes still queued from an earlier transaction', async () => {
  // Live run: registration consumed code #1, a duplicate of that mail stayed
  // queued, and the re-login read it as "the new code" one second after its
  // own send. The pre-send boundary must take it off the queue first.
  const { mail, calls } = client({
    getActivation: { status: 1, mail: 'q@gmail.com', mailId: 31 },
    getCode: [
      { status: 1, code: '111111' },
      { status: 1, code: '111111' },
      { status: 0, error: 'Code has not been received yet, please try again later' },
      { status: 1, code: '222222' },
    ],
    setStatus: [{ status: 1 }, { status: 1 }, { status: 1 }],
  });
  const rented = await mail.rentMailbox();
  assert.equal((await mail.findVerificationCode(rented.id)).code, '111111');

  const boundary = await mail.snapshotMailbox(rented.id, { drainStaleCodes: true });
  assert.deepEqual(boundary.messageIds, ['31#2']);
  assert.equal(boundary.drainedStaleCodes, 1);

  // The send happens here; the next read is the new code, not the stale one.
  assert.equal((await mail.findVerificationCode(rented.id)).code, '222222');
  assert.equal(calls.filter((call) => call.endpoint === 'getCode').length, 4);
});

test('a boundary never drains a fresh rental or one taken without the pre-send flag', async () => {
  const { mail, calls } = client({
    getActivation: { status: 1, mail: 'r@gmail.com', mailId: 32 },
    getCode: [{ status: 1, code: '333333' }],
    setStatus: [{ status: 1 }],
  });
  const rented = await mail.rentMailbox();
  // Fresh rental: the first code of a registration may already be on its way.
  await mail.snapshotMailbox(rented.id, { drainStaleCodes: true });
  assert.equal(calls.filter((call) => call.endpoint === 'getCode').length, 0);
  assert.equal((await mail.findVerificationCode(rented.id)).code, '333333');
  // After a code, a post-send snapshot (no flag) must not eat the next one.
  await mail.snapshotMailbox(rented.id);
  assert.equal(calls.filter((call) => call.endpoint === 'getCode').length, 1);
  assert.equal(mail.sequentialCodes, true);
});

test('a failed drain read leaves a usable boundary instead of failing the send', async () => {
  const { mail } = client({
    getActivation: { status: 1, mail: 's@gmail.com', mailId: 33 },
    getCode: [{ status: 1, code: '444444' }, () => { throw new Error('socket hang up'); }],
    setStatus: [{ status: 1 }],
  });
  const rented = await mail.rentMailbox();
  await mail.findVerificationCode(rented.id);
  const boundary = await mail.snapshotMailbox(rented.id, { drainStaleCodes: true });
  assert.deepEqual(boundary.messageIds, []);
  assert.match(boundary.drainError, /socket hang up/);
});
