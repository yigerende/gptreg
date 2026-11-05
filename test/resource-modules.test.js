'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { derivePlusAlias, derivePlusAliases, deriveRegistrationEmails } = require('../src/email-alias');
const { MockSmsProvider } = require('../src/sms-provider');
const { XiaopingguoClient, extractVerificationCode, isRetryableMailError } = require('../src/xiaopingguo-client');

test('extracts contextual alphanumeric OTPs without accepting unrelated identifiers', () => {
  assert.equal(extractVerificationCode('Your verification code is AB12CD'), 'AB12CD');
  assert.equal(extractVerificationCode('Security code: <strong>Q7W8E9</strong>'), 'Q7W8E9');
  assert.equal(extractVerificationCode('Use 654321 to continue'), '654321');
  assert.equal(extractVerificationCode('<style>.token { color: #f5f5f5; }</style><p>Verification code: A1B2C3</p>'), 'A1B2C3');
  assert.equal(extractVerificationCode('encoded: AB12CD'), '');
  assert.equal(extractVerificationCode('Request id A1B2C3 is pending'), '');
  assert.equal(extractVerificationCode('Your verification code is ABCDEF'), '');
});

function sequenceRandomInt(values) {
  const pending = [...values];
  return (minimum, maximum) => {
    assert.equal(minimum, 0);
    const value = pending.shift();
    assert.ok(Number.isInteger(value) && value < maximum, 'test random sequence was exhausted');
    return value;
  };
}

test('derives mixed-case random plus aliases while preserving the custom tag', () => {
  assert.equal(
    derivePlusAlias('User.Name@outlook.com', 7, {
      runTag: 'Run_42',
      randomInt: sequenceRandomInt([0, 27, 2, 29]),
    }),
    'User.Name+run42AbCd@outlook.com',
  );
  assert.deepEqual(
    derivePlusAliases('base@example.test', 2, {
      runTag: 'ctf',
      randomInt: sequenceRandomInt([0, 27, 2, 29, 4, 31, 6, 33]),
    }).map((item) => item.email),
    ['base+ctfAbCd@example.test', 'base+ctfEfGh@example.test'],
  );
});

test('random plus alias generation retries case-insensitive collisions', () => {
  const aliases = derivePlusAliases('base@example.test', 2, {
    runTag: 'ctf',
    randomInt: sequenceRandomInt([
      0, 27, 2, 29,
      0, 27, 2, 29,
      4, 31, 6, 33,
    ]),
  });
  assert.deepEqual(aliases.map((item) => item.email), [
    'base+ctfAbCd@example.test',
    'base+ctfEfGh@example.test',
  ]);
});

test('root registration strategy returns the original mailbox exactly once', () => {
  assert.deepEqual(deriveRegistrationEmails('base@example.test', 6, { strategy: 'root' }), [{
    index: 1,
    parentEmail: 'base@example.test',
    email: 'base@example.test',
    strategy: 'root',
  }]);
});

test('mock SMS provider leases numbers and returns configured codes', async () => {
  const provider = new MockSmsProvider({
    numbers: ['+15550000001'],
    codes: [{ code: '123456', message: 'OpenAI code 123456' }],
  });

  const lease = await provider.acquireNumber({ service: 'openai' });
  assert.equal(lease.number, '+15550000001');
  const code = await provider.pollCode(lease);
  assert.equal(code.code, '123456');
  const released = await provider.release(lease, 'done');
  assert.equal(released.status, 'released');
});

test('xiaopingguo client sends Origin CSRF and session cookie', async () => {
  const calls = [];
  const client = new XiaopingguoClient({
    baseUrl: 'http://127.0.0.1:8000',
    mailFolderBatchSupport: false,
    fetch: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith('/api/login')) {
        return {
          status: 200,
          headers: {
            get: (name) => name.toLowerCase() === 'set-cookie' ? 'mail_session=session-unit; Path=/' : '',
          },
          text: async () => JSON.stringify({ authenticated: true, csrfToken: 'csrf-unit' }),
        };
      }
      return {
        status: 200,
        headers: { get: () => '' },
        text: async () => JSON.stringify({ code: '654321' }),
      };
    },
  });

  await client.login('password');
  const code = await client.verifyCode(12, { keyword: 'openai' });

  assert.equal(code.code, '654321');
  assert.equal(calls[1].url, 'http://127.0.0.1:8000/api/accounts/12/verify-code');
  assert.equal(calls[1].init.headers.Origin, 'http://127.0.0.1:8000');
  assert.equal(calls[1].init.headers['X-CSRF-Token'], 'csrf-unit');
  assert.equal(calls[1].init.headers.Cookie, 'mail_session=session-unit');
});

test('xiaopingguo client filters verification mail by recipient and since window', async () => {
  const client = new XiaopingguoClient({
    baseUrl: 'http://127.0.0.1:8000',
    mailFolderBatchSupport: false,
    csrfToken: 'csrf-unit',
    cookies: { mail_session: 'session-unit' },
    fetch: async () => ({
      status: 200,
      headers: { get: () => '' },
      text: async () => JSON.stringify({
        messages: [
          {
            id: 'old',
            subject: 'OpenAI verification code 111111',
            toRecipients: [{ emailAddress: { address: 'base+ctf001@example.test' } }],
            date: '2026-07-27T00:00:00.000Z',
          },
          {
            id: 'wrong-recipient',
            subject: 'OpenAI verification code 222222',
            toRecipients: [{ emailAddress: { address: 'base+ctf002@example.test' } }],
            date: '2026-07-28T00:00:01.000Z',
          },
          {
            id: 'target',
            subject: 'OpenAI verification code 333333',
            toRecipients: [{ emailAddress: { address: 'base+ctf001@example.test' } }],
            date: '2026-07-28T00:00:02.000Z',
          },
        ],
      }),
    }),
  });

  const result = await client.verifyCode(7, {
    recipient: 'base+ctf001@example.test',
    since: '2026-07-28T00:00:00.000Z',
    folders: ['inbox'],
    keyword: 'openai',
  });

  assert.equal(result.code, '333333');
  assert.equal(result.messageId, 'target');
});

test('xiaopingguo scans past alphabetic mail tokens to find a Chinese six-digit code', async () => {
  const client = new XiaopingguoClient({
    mailFolderBatchSupport: false,
    baseUrl: 'http://127.0.0.1:8000',
    csrfToken: 'csrf-unit',
    cookies: { mail_session: 'session-unit' },
    fetch: async () => ({
      status: 200,
      headers: { get: () => '' },
      text: async () => JSON.stringify({
        messages: [{
          id: 'localized-code',
          subject: '你的 ChatGPT 临时验证码',
          sender: 'OpenAI <noreply@tm.openai.com>',
          bodyPreview: '输入此临时验证码以继续：\r\n\r\n483921\r\n\r\n如果并非你本人尝试创建 ChatGPT 帐户，请忽略此电子邮件。',
          html: '<html><style>body { color: #ffffff }</style><body>输入此临时验证码以继续： <strong>483921</strong></body></html>',
          date: '2026-08-04T17:33:54.000Z',
        }],
      }),
    }),
  });

  const result = await client.findVerificationCode(11, {
    recipient: 'base+workerAbCd@example.test',
    since: '2026-08-04T17:33:00.000Z',
    folders: ['inbox'],
    keyword: 'openai',
  });

  assert.equal(result.code, '483921');
  assert.equal(result.messageId, 'localized-code');
});

test('xiaopingguo returns an inbox code when a secondary folder is unavailable', async () => {
  const client = new XiaopingguoClient({
    mailFolderBatchSupport: false,
    fetch: async (_url, init) => {
      const folder = JSON.parse(init.body).folder;
      if (folder === 'junkemail') {
        return {
          status: 503,
          headers: { get: () => '' },
          text: async () => JSON.stringify({ error: 'upstream unavailable' }),
        };
      }
      return {
        status: 200,
        headers: { get: () => '' },
        text: async () => JSON.stringify({
          messages: [{
            id: 'inbox-code',
            subject: '你的 ChatGPT 临时验证码',
            sender: 'OpenAI <noreply@tm.openai.com>',
            bodyPreview: '输入此临时验证码以继续： 615204',
            date: '2026-08-04T18:07:33.000Z',
          }],
        }),
      };
    },
  });

  const result = await client.findVerificationCode(11, {
    folders: ['inbox', 'junkemail'],
    keyword: 'openai',
    since: '2026-08-04T18:07:28.000Z',
  });

  assert.equal(result.code, '615204');
  assert.equal(result.folder, 'inbox');
});

test('xiaopingguo keeps a batch inbox code when the junk folder is temporarily unavailable', async () => {
  const client = new XiaopingguoClient({
    fetch: async () => ({
      status: 200,
      headers: { get: () => '' },
      text: async () => JSON.stringify({
        folders: {
          inbox: [{
            id: 'batch-inbox-code',
            subject: 'OpenAI verification code 615204',
            toRecipients: [{ emailAddress: { address: 'target@example.test' } }],
          }],
          junkemail: [],
        },
        errors: {
          junkemail: { status: 503, error: 'upstream unavailable' },
        },
      }),
    }),
  });

  const result = await client.findVerificationCode(11, {
    folders: ['inbox', 'junkemail'],
    recipient: 'target@example.test',
    keyword: 'openai',
  });

  assert.equal(result.code, '615204');
  assert.equal(result.folder, 'inbox');
});

test('xiaopingguo mailbox snapshots exclude baseline messages and identify the consumed message', async () => {
  let requestCount = 0;
  const client = new XiaopingguoClient({
    now: () => 0,
    mailFolderBatchSupport: false,
    fetch: async (_url, init) => {
      const folder = JSON.parse(init.body).folder;
      const snapshotRound = requestCount < 2;
      requestCount += 1;
      const messages = folder === 'inbox'
        ? [
          { id: 'baseline-inbox', subject: 'OpenAI code 111111' },
          ...(snapshotRound ? [] : [{ id: 'new-target', subject: 'OpenAI code 654321' }]),
        ]
        : [{ id: 'baseline-junk', subject: 'OpenAI code 222222' }];
      return {
        status: 200,
        headers: { get: () => '' },
        text: async () => JSON.stringify(messages),
      };
    },
  });

  const snapshot = await client.snapshotMailbox(4, { folders: ['inbox', 'junkemail'] });
  assert.deepEqual(snapshot, {
    messageIds: ['baseline-inbox', 'baseline-junk'],
    capturedAt: '1970-01-01T00:00:00.000Z',
  });

  const result = await client.findVerificationCode(4, {
    folders: ['inbox', 'junkemail'],
    keyword: 'openai',
    excludeMessageIds: new Set(snapshot.messageIds),
  });
  assert.equal(result.code, '654321');
  assert.equal(result.messageId, 'new-target');
  assert.equal(result.consumedMessageId, 'new-target');
});

test('xiaopingguo HTTP errors expose Retry-After milliseconds', async () => {
  const client = new XiaopingguoClient({
    now: () => 1000,
    fetch: async () => ({
      status: 429,
      headers: { get: (name) => name.toLowerCase() === 'retry-after' ? '2' : '' },
      text: async () => JSON.stringify({ error: 'slow down' }),
    }),
  });

  await assert.rejects(
    client.listAccounts(),
    (error) => error.status === 429 && error.retryAfterMs === 2000,
  );
});

test('xiaopingguo reads multiple folders with one refresh and shares matching in-flight reads', async () => {
  let requestCount = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const client = new XiaopingguoClient({
    now: () => 0,
    fetch: async (url, init) => {
      requestCount += 1;
      assert.equal(new URL(url).pathname, '/api/accounts/4/mail-folders');
      assert.deepEqual(JSON.parse(init.body), { folders: ['inbox', 'junkemail'], limit: 20 });
      await gate;
      return {
        status: 200,
        headers: { get: () => '' },
        text: async () => JSON.stringify({
          folders: {
            inbox: [{ id: 'new-code', subject: 'OpenAI code 654321' }],
            junkemail: [{ id: 'junk-message', subject: 'Newsletter' }],
          },
        }),
      };
    },
  });

  const snapshotPromise = client.snapshotMailbox(4, { folders: ['inbox', 'junkemail'] });
  const codePromise = client.findVerificationCode(4, {
    folders: ['inbox', 'junkemail'],
    keyword: 'openai',
  });
  release();
  const [snapshot, code] = await Promise.all([snapshotPromise, codePromise]);

  assert.equal(requestCount, 1);
  assert.deepEqual(snapshot.messageIds, ['new-code', 'junk-message']);
  assert.equal(code.code, '654321');
});

test('xiaopingguo tolerates Graph timestamps slightly before a captured message-id boundary', async () => {
  const client = new XiaopingguoClient({
    fetch: async () => ({
      status: 200,
      headers: { get: () => '' },
      text: async () => JSON.stringify({
        folders: {
          inbox: [{
            id: 'eventually-visible',
            subject: '你的 ChatGPT 临时验证码',
            sender: 'noreply@tm.openai.com',
            toRecipients: [{ emailAddress: { address: 'base+workerCHTg@example.test' } }],
            bodyPreview: '输入此临时验证码以继续： 483921',
            date: '2026-08-05T17:59:46.000Z',
          }],
          junkemail: [],
        },
      }),
    }),
  });

  const found = await client.findVerificationCode(24, {
    recipient: 'base+workerCHTg@example.test',
    since: '2026-08-05T17:59:57.878Z',
    folders: ['inbox', 'junkemail'],
    keyword: 'openai',
    excludeMessageIds: ['baseline-message'],
  });

  assert.equal(found.code, '483921');
  assert.equal(found.messageId, 'eventually-visible');
});

test('xiaopingguo remembers when the folder batch endpoint is unavailable', async () => {
  const paths = [];
  const client = new XiaopingguoClient({
    fetch: async (url, init) => {
      const pathname = new URL(url).pathname;
      paths.push(pathname);
      if (pathname.endsWith('/mail-folders')) {
        return {
          status: 404,
          headers: { get: () => '' },
          text: async () => JSON.stringify({ error: 'not found' }),
        };
      }
      const folder = JSON.parse(init.body).folder;
      return {
        status: 200,
        headers: { get: () => '' },
        text: async () => JSON.stringify(folder === 'inbox'
          ? [{ id: 'code', subject: 'OpenAI code 123456' }]
          : []),
      };
    },
  });

  await client.findVerificationCode(7, { folders: ['inbox', 'junkemail'] });
  await client.findVerificationCode(7, { folders: ['inbox', 'junkemail'] });

  assert.equal(paths.filter((path) => path.endsWith('/mail-folders')).length, 1);
  assert.equal(paths.filter((path) => path.endsWith('/mail')).length, 4);
});

test('xiaopingguo retries only refresh-busy conflicts', () => {
  assert.equal(isRetryableMailError({ status: 409, response: { error: 'account refresh busy' } }), true);
  assert.equal(isRetryableMailError({ status: 409, response: { error: 'account token invalid' } }), false);
  assert.equal(isRetryableMailError({ status: 429 }), true);
  assert.equal(isRetryableMailError({ status: 502, code: 'IMAP_AUTH_FAILED', retryable: false }), false);
  assert.equal(isRetryableMailError({
    status: 422,
    code: 'WEBMAIL_AUTH_FAILED',
    retryable: true,
    category: 'mailbox_authentication',
  }), true);
});

test('xiaopingguo polling honors Retry-After and bounded 5xx backoff', async () => {
  let now = 0;
  const waits = [];
  const responses = [
    { status: 429, retryAfter: '2', json: { error: 'rate limited' } },
    { status: 503, json: { error: 'temporary one' } },
    { status: 503, json: { error: 'temporary two' } },
    { status: 200, json: { messages: [{ id: 'fresh', subject: 'OpenAI code 987654' }] } },
  ];
  const client = new XiaopingguoClient({
    now: () => now,
    mailFolderBatchSupport: false,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
      now += milliseconds;
    },
    fetch: async () => {
      const response = responses.shift();
      return {
        status: response.status,
        headers: { get: (name) => name.toLowerCase() === 'retry-after' ? response.retryAfter || '' : '' },
        text: async () => JSON.stringify(response.json),
      };
    },
  });

  const result = await client.pollVerifyCode(4, {
    folders: ['inbox'],
    excludeMessageIds: [],
    pollIntervalMs: 100,
    timeoutMs: 5000,
    maxBackoffMs: 250,
    maxServerErrorRetries: 3,
  });
  assert.equal(result.code, '987654');
  assert.deepEqual(waits, [2000, 100, 200]);
});

test('xiaopingguo polling stops after the configured 5xx retry budget', async () => {
  let now = 0;
  let attempts = 0;
  const waits = [];
  const client = new XiaopingguoClient({
    now: () => now,
    mailFolderBatchSupport: false,
    sleep: async (milliseconds) => {
      waits.push(milliseconds);
      now += milliseconds;
    },
    fetch: async () => {
      attempts += 1;
      return {
        status: 503,
        headers: { get: () => '' },
        text: async () => JSON.stringify({ error: 'still unavailable' }),
      };
    },
  });

  await assert.rejects(
    client.pollVerifyCode(4, {
      folders: ['inbox'],
      pollIntervalMs: 100,
      timeoutMs: 5000,
      maxServerErrorRetries: 2,
    }),
    (error) => error.status === 503,
  );
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [100, 200]);
});

test('xiaopingguo reserve and release map to bound state updates', async () => {
  const bodies = [];
  const client = new XiaopingguoClient({
    fetch: async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      return {
        status: 200,
        headers: { get: () => '' },
        text: async () => JSON.stringify({ account: { id: 9 } }),
      };
    },
  });

  await client.reserveMailbox(9);
  await client.releaseMailbox(9);
  assert.deepEqual(bodies, [{ bound: true }, { bound: false }]);
});
