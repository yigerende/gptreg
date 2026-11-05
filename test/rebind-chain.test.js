'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { rebindAccount } = require('../src/rebind-chain');

function happy(overrides = {}) {
  let probes = 0;
  return {
    asset: { id: 'test', email: 'old@icloud.com', accessToken: 'fake' },
    claimEmail: async () => ({ email: 'new@example.test', mailboxId: 'box' }),
    readOtp: async () => '123456',
    login: async () => ({ accessToken: 'fresh' }),
    timeouts: { retryMs: 0 },
    executor: async (request) => ({ response: { status: 200, text: JSON.stringify(request.url.endsWith('/me') ? { email: ++probes === 1 ? 'old@icloud.com' : 'new@example.test' } : {}) } }),
    ...overrides,
  };
}

test('a valid login state is reused before confirmation, then refreshed on the new email and same proxy', async () => {
  const stages = [];
  let requests = 0;
  const logins = [];
  const params = happy({ proxy: 'http://test-proxy:8080', onStage: (stage) => stages.push(stage), login: async ({ email, reason }) => {
    logins.push({ email, reason });
    assert.equal(stages.at(-1), 'post_login_refresh');
    return { accessToken: 'fresh', session: { user: { email } } };
  } });
  const executor = params.executor;
  params.executor = (request, options) => {
    requests++;
    assert.equal(options.proxy, 'http://test-proxy:8080');
    assert.equal(request.headers.Authorization, requests === 4 ? 'Bearer fresh' : 'Bearer fake');
    return executor(request);
  };
  const result = await rebindAccount(params);
  assert.equal(result.status, 'ok');
  assert.equal(result.accessToken, 'fresh');
  assert.equal(result.postRefreshed, true);
  assert.deepEqual(logins, [{ email: 'new@example.test', reason: 'after_rebind' }]);
  assert.equal(requests, 4);
  assert.deepEqual(stages, ['login', 'claim', 'change_begin', 'otp', 'change_verify', 'post_login_refresh', 'verify_health']);
});

test('a general HTTP 403 is not treated as an expired token or retried through login', async () => {
  let logins = 0;
  const params = happy({ login: async () => { logins++; return { accessToken: 'fresh' }; } });
  const executor = params.executor;
  params.executor = (request) => request.url.endsWith('/begin')
    ? { response: { status: 403, text: '<html>Forbidden</html>' } } : executor(request);
  const result = await rebindAccount(params);
  assert.equal(logins, 0);
  assert.equal(result.code, 'CHANGE_EMAIL_FORBIDDEN');
  assert.equal(result.proxyRetryable, false);
  assert.equal(result.status, 'error');
});

test('a refreshed login is returned for persistence even if change-begin is rejected', async () => {
  let logins = 0;
  const params = happy({ login: async () => { logins++; return { accessToken: 'fresh' }; } });
  const executor = params.executor;
  params.executor = (request) => {
    if (request.headers.Authorization === 'Bearer fake') return { response: { status: 401, text: '{}' } };
    if (request.url.endsWith('/begin')) return { response: { status: 403, text: '{}' } };
    return executor(request);
  };
  const result = await rebindAccount(params);
  assert.equal(logins, 1);
  assert.equal(result.status, 'error');
  assert.equal(result.refreshed, true);
  assert.equal(result.accessToken, 'fresh');
});

test('an unresolved confirmation response keeps the mailbox reserved and prevents replay', async () => {
  const params = happy({ releaseEmail: async () => assert.fail('uncertain binding must not be released') });
  const executor = params.executor;
  params.executor = (request) => {
    if (request.url.endsWith('/verify')) throw new Error('ECONNRESET');
    if (request.url.endsWith('/me')) return { response: { status: 200, text: '{"email":"old@icloud.com"}' } };
    return executor(request);
  };
  const result = await rebindAccount(params);
  assert.equal(result.status, 'needs_review');
  assert.equal(result.verificationUncertain, true);
  assert.equal(result.proxyRetryable, false);
});

test('mailbox outages do not trigger account proxy rotation', async () => {
  const result = await rebindAccount(happy({ claimEmail: async () => { throw new Error('mail provider timeout'); } }));
  assert.equal(result.stage, 'claim');
  assert.equal(result.proxyRetryable, false);
});

test('bookkeeping overlaps the final probe and its failure is visible before completion', { timeout: 1000 }, async () => {
  let finishBookkeeping;
  let probedAfterChange = false;
  const params = happy({ consumeEmail: () => new Promise((_, reject) => { finishBookkeeping = () => reject(new Error('pool offline')); }) });
  const executor = params.executor;
  let probes = 0;
  params.executor = (request) => {
    if (request.url.endsWith('/me') && ++probes === 2) probedAfterChange = true;
    return executor(request);
  };
  let completed = false;
  const pending = rebindAccount(params).then((result) => { completed = true; return result; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(probedAfterChange, true);
  assert.equal(completed, false);
  finishBookkeeping();
  const result = await pending;
  assert.equal(result.status, 'ok');
  assert.match(result.warning, /pool offline/);
});

for (const consumeFails of [false, true]) {
  test(`confirmed binding is never released on a failed health probe (consume fails: ${consumeFails})`, async () => {
    let probes = 0;
    let consumed = 0;
    let released = 0;
    const result = await rebindAccount({
      asset: { id: 'test', email: 'old@icloud.com', accessToken: 'fake' },
      timeouts: { retryMs: 0 },
      newProvider: 'fastmail',
      claimEmail: async () => ({ email: 'new@example.test', mailboxId: 'box' }),
      readOtp: async () => '123456',
      login: async () => ({ accessToken: 'fresh' }),
      consumeEmail: async () => { consumed += 1; if (consumeFails) throw new Error('pool unavailable'); },
      releaseEmail: async () => { released += 1; },
      executor: async (request) => {
        if (request.url.endsWith('/me')) {
          probes += 1;
          if (probes > 1) throw new Error('ECONNRESET');
          return { response: { status: 200, text: JSON.stringify({ email: 'old@icloud.com' }) } };
        }
        return { response: { status: 200, text: '{}' } };
      },
    });
    assert.equal(result.status, 'error');
    assert.equal(result.stage, 'verify_health');
    assert.equal(result.changeConfirmed, true);
    assert.equal(result.proxyRetryable, false);
    assert.equal(consumed, 1);
    assert.equal(released, 0);
  });
}

test('OTP timeout before confirmation consumes the unused mailbox', async () => {
  let released = 0;
  let consumed = 0;
  const result = await rebindAccount({
    asset: { id: 'test', email: 'old@icloud.com', accessToken: 'fake' },
    claimEmail: async () => ({ email: 'new@example.test', mailboxId: 'box' }),
    readOtp: async () => '',
    consumeEmail: async () => { consumed += 1; },
    releaseEmail: async () => { released += 1; },
    executor: async (request) => ({ response: { status: 200, text: request.url.endsWith('/me') ? JSON.stringify({ email: 'old@icloud.com' }) : '{}' } }),
  });
  assert.equal(result.code, 'NO_OTP');
  assert.equal(result.changeConfirmed, false);
  assert.equal(released, 0);
  assert.equal(consumed, 2);
});

test('OTP timeout consumes the mailbox and retries once with a fresh address', async () => {
  let claims = 0;
  const consumed = [];
  let probes = 0;
  const result = await rebindAccount({
    asset: { id: 'test', email: 'old@icloud.com', accessToken: 'fake' },
    login: async () => ({ accessToken: 'fresh' }),
    claimEmail: async () => {
      claims += 1;
      return { email: `new-${claims}@example.test`, mailboxId: `box-${claims}` };
    },
    readOtp: async (_mailboxId) => claims === 1 ? '' : '123456',
    consumeEmail: async (mailboxId, options) => consumed.push({ mailboxId, email: options.email, reason: options.reason }),
    releaseEmail: async () => assert.fail('an OTP timeout must consume, not release, the mailbox'),
    executor: async (request) => ({ response: { status: 200, text: request.url.endsWith('/me') ? JSON.stringify({ email: ++probes === 1 ? 'old@icloud.com' : 'new-2@example.test' }) : '{}' } }),
  });
  assert.equal(result.status, 'ok');
  assert.equal(claims, 2);
  assert.deepEqual(consumed, [
    { mailboxId: 'box-1', email: 'new-1@example.test', reason: 'otp_timeout' },
    { mailboxId: 'box-2', email: 'new-2@example.test', reason: undefined },
  ]);
});

test('OTP timeout explains a recipient filter mismatch from the mail interface', async () => {
  const result = await rebindAccount({
    asset: { id: 'test', email: 'old@icloud.com', accessToken: 'fake' },
    claimEmail: async () => ({ email: 'new@example.test', mailboxId: 'box' }),
    readOtp: async () => ({ code: '', diagnostics: { recipient: 'new@example.test', listed: 2, checkedEmails: 0, found: false, siblingCount: 0 } }),
    consumeEmail: async () => {},
    executor: async (request) => ({ response: { status: 200, text: request.url.endsWith('/me') ? JSON.stringify({ email: 'old@icloud.com' }) : '{}' } }),
    otpRetries: 0,
  });
  assert.match(result.error, /没有匹配到领取地址/);
  assert.deepEqual(result.otpDiagnostics, { recipient: 'new@example.test', checkedEmails: 0, listed: 2, found: false, siblingCount: 0 });
});

test('refreshing a stale token before the change does not suppress the post-change login', async () => {
  const emails = [];
  const params = happy({ login: async ({ email }) => { emails.push(email); return { accessToken: `fresh-${emails.length}` }; } });
  const executor = params.executor;
  params.executor = (request) => request.headers.Authorization === 'Bearer fake'
    ? { response: { status: 401, text: '{}' } } : executor(request);
  const result = await rebindAccount(params);
  assert.equal(result.status, 'ok');
  assert.deepEqual(emails, ['old@icloud.com', 'new@example.test']);
  assert.equal(result.accessToken, 'fresh-2');
});

for (const unavailable of [false, true]) {
  test(`exhausted post-change login retains the committed binding without replay or release (missing login: ${unavailable})`, async () => {
    let consumed = 0;
    const result = await rebindAccount(happy({
      login: unavailable ? undefined : async () => { throw new Error('ECONNRESET'); },
      releaseEmail: async () => assert.fail('committed mailbox must stay reserved'),
      consumeEmail: async () => { consumed++; },
    }));
    assert.equal(result.status, 'needs_refresh');
    assert.equal(result.stage, 'post_login_refresh');
    assert.equal(result.changeConfirmed, true);
    assert.equal(result.postRefreshed, false);
    assert.equal(result.proxyRetryable, false);
    assert.equal(result.newEmail, 'new@example.test');
    assert.equal(consumed, 1);
  });
}

test('an unverified identity cannot mark the rebound account healthy', async () => {
  const params = happy();
  const executor = params.executor;
  params.executor = (request) => request.headers.Authorization === 'Bearer fresh'
    ? { response: { status: 200, text: '{}' } } : executor(request);
  const result = await rebindAccount(params);
  assert.equal(result.code, 'EMAIL_NOT_MOVED');
  assert.equal(result.changeConfirmed, true);
  assert.equal(result.postRefreshed, true);
});

for (const reason of ['recipient_mismatch', 'otp_timeout']) {
  test(`${reason} abandons the first mailbox and verifies only the second one`, async () => {
    let claims = 0;
    const consumed = [];
    const verified = [];
    const result = await rebindAccount(happy({
      claimEmail: async () => ({ email: `new-${++claims}@example.test`, mailboxId: `box-${claims}` }),
      readOtp: async () => {
        if (claims === 2) return '123456';
        if (reason === 'otp_timeout') throw new Error('mail request timeout');
        return { code: '', diagnostics: { listed: 1, checkedEmails: 0, siblingCount: 2 } };
      },
      consumeEmail: async (id, options) => consumed.push({ id, reason: options.reason }),
      releaseEmail: async () => assert.fail('an abandoned mailbox must not be reused'),
      executor: async (request) => {
        if (request.url.endsWith('/verify')) verified.push(JSON.parse(request.body).email);
        return { response: { status: 200, text: JSON.stringify(request.url.endsWith('/me') ? { email: claims ? 'new-2@example.test' : 'old@icloud.com' } : {}) } };
      },
    }));
    assert.equal(result.status, 'ok');
    assert.equal(result.mailboxAttempts, 2);
    assert.equal(result.mailboxRetries[0].reason, reason);
    assert.deepEqual(consumed, [{ id: 'box-1', reason }, { id: 'box-2', reason: undefined }]);
    assert.deepEqual(verified, ['new-2@example.test']);
    assert.equal(result.otpDiagnostics, undefined);
  });
}

test('an overall account deadline abandons the current mailbox and stops instead of releasing it', { timeout: 1000 }, async () => {
  const { setTimeout: sleep } = require('node:timers/promises');
  let consumed = 0;
  const result = await rebindAccount(happy({
    timeouts: { accountMs: 30 },
    readOtp: (_id, { signal }) => sleep(5000, '', { signal }),
    consumeEmail: async () => { consumed++; },
    releaseEmail: async () => assert.fail('a timed-out mailbox must not go back to the pool'),
  }));
  assert.equal(result.code, 'ACCOUNT_TIMEOUT');
  assert.equal(result.mailboxAttempts, 1);
  assert.equal(consumed, 1);
});

test('pre-change login retries in place and stops when its budget is exhausted', async () => {
  const result = await rebindAccount(happy({ alwaysFreshLogin: true, login: async () => { throw new Error('ETIMEDOUT'); } }));
  assert.equal(result.stage, 'login_refresh');
  assert.equal(result.changeConfirmed, false);
  assert.equal(result.proxyRetryable, false);
  assert.equal(result.attemptErrors.length, 2);
});

test('a change-begin rejection reauthenticates in place and keeps the claimed email and proxy', async () => {
  const stages = [];
  const logins = [];
  let claims = 0;
  let begins = 0;
  const proxy = 'http://same.test:8080';
  const params = happy({
    proxy, onStage: (stage, detail) => stages.push({ stage, detail }),
    claimEmail: async () => { claims++; return { email: 'new@example.test', mailboxId: 'box' }; },
    login: async ({ reason, email }) => { logins.push({ reason, email }); return { accessToken: 'fresh' }; },
  });
  const executor = params.executor;
  params.executor = (request, options) => {
    assert.equal(options.proxy, proxy);
    if (request.url.endsWith('/begin') && ++begins === 1) {
      return { response: { status: 401, text: '{"error":{"code":"login_required"}}' } };
    }
    return executor(request);
  };
  const result = await rebindAccount(params);
  assert.equal(result.status, 'ok');
  assert.equal(claims, 1);
  assert.equal(begins, 2);
  assert.deepEqual(stages.map((entry) => entry.stage), ['login', 'claim', 'change_begin', 'change_reauth', 'change_begin', 'otp', 'change_verify', 'post_login_refresh', 'verify_health']);
  assert.deepEqual(stages[3].detail, { refreshReason: 'change_begin_rejected', resumeStage: 'change_begin' });
  assert.deepEqual(logins, [{ reason: 'change_begin_rejected', email: 'old@icloud.com' }, { reason: 'after_rebind', email: 'new@example.test' }]);
});

test('failed change reauthentication retains the original error code, request step and HTTP status', async () => {
  let releases = 0;
  const params = happy({
    login: async ({ onProgress }) => {
      onProgress({ step: 'mfa_validated' });
      throw Object.assign(new Error('chatgpt_me failed with HTTP 401: token_revoked'), { code: 'TOKEN_REVOKED', step: 'chatgpt_me', status: 401 });
    },
    releaseEmail: async () => { releases++; },
    readOtp: async () => assert.fail('no code was sent'),
  });
  const executor = params.executor;
  params.executor = (request) => request.url.endsWith('/begin')
    ? { response: { status: 403, text: '{"error":{"code":"reauth_required"}}' } } : executor(request);
  const result = await rebindAccount(params);
  assert.equal(result.stage, 'change_reauth');
  assert.equal(result.code, 'AT_REFRESH_FAILED');
  assert.equal(result.changeConfirmed, false);
  assert.equal(result.proxyRetryable, false);
  assert.equal(releases, 1);
  assert.deepEqual(result.failure, { code: 'TOKEN_REVOKED', step: 'chatgpt_me', httpStatus: 401, refreshReason: 'change_begin_rejected', resumeStage: 'change_begin' });
});

test('a transport failure during change reauthentication stops after bounded operation retries', async () => {
  const params = happy({ login: async () => { throw Object.assign(new Error('connection interrupted'), { code: 'ECONNRESET', retryable: true }); } });
  const executor = params.executor;
  params.executor = (request) => request.url.endsWith('/begin')
    ? { response: { status: 401, text: '{}' } } : executor(request);
  const result = await rebindAccount(params);
  assert.equal(result.stage, 'change_reauth');
  assert.equal(result.proxyRetryable, false);
  assert.equal(result.attemptErrors.length, 2);
  assert.equal(result.failure.code, 'ECONNRESET');
});

for (const failureAt of ['login', 'change_begin', 'change_reauth', 'post_login_refresh', 'verify_health']) {
  test(`network recovery at ${failureAt} continues with one mailbox and one confirmed change`, async () => {
    const counts = { claims: 0, begins: 0, verifies: 0, consumes: 0, logins: 0, probes: 0 };
    let failed = false;
    let begun = false;
    let confirmed = false;
    const progress = [];
    const fault = () => { failed = true; throw Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }); };
    const result = await rebindAccount(happy({
      proxy: 'http://sticky.test:8080',
      claimEmail: async () => { counts.claims++; return { mailboxId: 'box', email: 'new@example.test' }; },
      consumeEmail: async () => { counts.consumes++; },
      releaseEmail: async () => assert.fail('a recovered request must keep the claimed mailbox'),
      onProgress: (event) => { if (event.connectionRetry) progress.push(event.connectionRetry); },
      login: async ({ email, reason }) => {
        counts.logins++;
        if (!failed && ((failureAt === 'post_login_refresh' && reason === 'after_rebind')
          || (failureAt === 'change_reauth' && reason === 'change_begin_rejected'))) fault();
        return { accessToken: `fresh-${email}` };
      },
      executor: async (request, options) => {
        assert.equal(options.proxy, 'http://sticky.test:8080');
        if (request.url.endsWith('/me')) {
          counts.probes++;
          if (!failed && ((failureAt === 'login' && !confirmed) || (failureAt === 'verify_health' && confirmed))) fault();
          return { response: { status: 200, text: JSON.stringify({ email: confirmed ? 'new@example.test' : 'old@icloud.com' }) } };
        }
        if (request.url.endsWith('/begin')) {
          counts.begins++;
          if (!failed && failureAt === 'change_begin') fault();
          if (!begun && failureAt === 'change_reauth') {
            begun = true;
            return { response: { status: 401, text: '{}' } };
          }
        }
        if (request.url.endsWith('/verify')) { counts.verifies++; confirmed = true; }
        return { response: { status: 200, text: '{}' } };
      },
    }));
    assert.equal(result.status, 'ok', result.error);
    assert.equal(counts.claims, 1);
    assert.equal(counts.verifies, 1);
    assert.equal(counts.consumes, 1);
    assert.equal(result.attempts, 2);
    assert.equal(result.attemptErrors[0].stage, failureAt);
    assert.deepEqual(progress.map((item) => item.pending), [true, false]);
    if (failureAt === 'verify_health') assert.equal(counts.logins, 1);
    if (failureAt === 'post_login_refresh') assert.equal(counts.begins, 1);
  });
}

test('a lost confirmation response is reconciled without replaying the commit', async () => {
  let confirms = 0;
  let consumes = 0;
  let changed = false;
  const result = await rebindAccount(happy({
    consumeEmail: async () => { consumes++; },
    releaseEmail: async () => assert.fail('the confirmed address must not be released'),
    executor: async (request) => {
      if (request.url.endsWith('/verify')) {
        confirms++;
        changed = true;
        throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
      }
      return { response: { status: 200, text: JSON.stringify(request.url.endsWith('/me') ? { email: changed ? 'new@example.test' : 'old@icloud.com' } : {}) } };
    },
  }));
  assert.equal(result.status, 'ok', result.error);
  assert.equal(result.changeConfirmed, true);
  assert.equal(result.postRefreshed, true);
  assert.equal(confirms, 1);
  assert.equal(consumes, 1);
});

test('each operation has its own retry limit and a zero setting disables retries', async () => {
  for (const limit of [0, 2]) {
    let logins = 0;
    const result = await rebindAccount(happy({
      proxyRetries: limit,
      login: async () => { logins++; throw Object.assign(new Error('bad TLS stream'), { code: 'ERR_SSL_PACKET_LENGTH_TOO_LONG' }); },
    }));
    assert.equal(logins, limit + 1);
    assert.equal(result.changeConfirmed, true);
    assert.equal(result.attemptErrors.length, limit);
    assert.equal(result.failure.code, 'ERR_SSL_PACKET_LENGTH_TOO_LONG');
    assert.equal(result.proxyRetryable, false);
  }
});
