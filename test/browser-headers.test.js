'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const zlib = require('node:zlib');

const { browserHeaders, fetchSite } = require('../src/browser-headers');
const { createClientProfile, createFirefox153Profile } = require('../src/client-profile');
const { decodeResponseBody } = require('../src/pure-url');
const { UrlSession } = require('../src/url-session');

function capture(sessionOptions = {}) {
  const sent = [];
  const session = new UrlSession({
    clientProfile: createFirefox153Profile(),
    executor: async (request) => {
      sent.push(request);
      return { request, response: { status: 200, url: request.url, text: '{}', headers: {} }, cookies: {} };
    },
    ...sessionOptions,
  });
  return { session, sent };
}

test('Sec-Fetch-Site is the relationship between the two URLs, not a constant', () => {
  assert.equal(fetchSite('https://auth.openai.com/log-in', ''), 'none');
  assert.equal(fetchSite('https://auth.openai.com/a', 'https://auth.openai.com/b'), 'same-origin');
  assert.equal(fetchSite('https://sentinel.openai.com/a', 'https://auth.openai.com/b'), 'same-site');
  assert.equal(fetchSite('https://auth.openai.com/a', 'https://chatgpt.com/'), 'cross-site');
});

test('a navigation carries what a navigation carries, and a fetch does not', () => {
  const profile = createClientProfile({ seed: 'headers@example.test', country: 'GB' });
  const navigation = browserHeaders(profile, {
    url: 'https://auth.openai.com/log-in',
    kind: 'navigate',
    referer: 'https://chatgpt.com/',
    userActivated: true,
  });
  assert.equal(navigation['Upgrade-Insecure-Requests'], '1');
  assert.equal(navigation['Sec-Fetch-Dest'], 'document');
  assert.equal(navigation['Sec-Fetch-Mode'], 'navigate');
  assert.equal(navigation['Sec-Fetch-Site'], 'cross-site');
  assert.equal(navigation['Sec-Fetch-User'], '?1');
  assert.equal(navigation.Priority, 'u=0, i');
  assert.match(navigation.Accept, /^text\/html/);

  // A redirect hop is not a click. The capture agrees: its redirect-driven
  // navigation carries no Sec-Fetch-User at all.
  const hop = browserHeaders(profile, { url: 'https://auth.openai.com/log-in', kind: 'navigate', referer: 'https://auth.openai.com/api/accounts/login' });
  assert.equal(hop['Sec-Fetch-User'], undefined);
  assert.equal(hop['Upgrade-Insecure-Requests'], '1');

  // A script fetch sends no referer and is still same-origin with its page.
  const script = browserHeaders(profile, {
    url: 'https://auth.openai.com/cdn-cgi/challenge-platform/scripts/jsd/main.js',
    kind: 'script',
    initiator: 'https://auth.openai.com/log-in',
  });
  assert.equal(script['Sec-Fetch-Site'], 'same-origin');
  assert.equal(script.Referer, undefined);
  assert.equal(script.Priority, undefined);

  const fetched = browserHeaders(profile, {
    url: 'https://auth.openai.com/api/accounts/user/register',
    kind: 'fetch',
    referer: 'https://auth.openai.com/create-account/password',
    origin: 'https://auth.openai.com',
    accept: 'application/json',
    contentType: 'application/json',
  });
  assert.equal(fetched['Sec-Fetch-Dest'], 'empty');
  assert.equal(fetched['Sec-Fetch-Mode'], 'cors');
  assert.equal(fetched['Sec-Fetch-Site'], 'same-origin');
  assert.equal(fetched['Upgrade-Insecure-Requests'], undefined);
  assert.equal(fetched['Sec-Fetch-User'], undefined);
  assert.equal(fetched.Priority, 'u=4');
});

test('headers come out in the browser order, and carry the account profile', () => {
  const profile = createClientProfile({ seed: 'order@example.test', country: 'US' });
  const headers = browserHeaders(profile, {
    url: 'https://auth.openai.com/api/accounts/create_account',
    kind: 'fetch',
    referer: 'https://auth.openai.com/about-you',
    origin: 'https://auth.openai.com',
    accept: 'application/json',
    contentType: 'application/json',
  });
  assert.deepEqual(Object.keys(headers), [
    'User-Agent',
    'Accept',
    'Accept-Language',
    'Accept-Encoding',
    'Referer',
    'Content-Type',
    'Origin',
    'Sec-Fetch-Dest',
    'Sec-Fetch-Mode',
    'Sec-Fetch-Site',
    'Priority',
  ]);
  assert.equal(headers['User-Agent'], profile.userAgent);
  assert.equal(headers['Accept-Language'], profile.acceptLanguage);
});

test('the capture’s devtools-only headers are not replayed', () => {
  // Every entry in the recording carries `Pragma: no-cache` and
  // `Cache-Control: no-cache` because it was taken with devtools open and the
  // cache disabled. An ordinary session sends neither, so replaying them would
  // mark every request as something other than ordinary browsing.
  const headers = browserHeaders(createFirefox153Profile(), { url: 'https://auth.openai.com/log-in', kind: 'navigate' });
  assert.equal(headers.Pragma, undefined);
  assert.equal(headers['Cache-Control'], undefined);
  assert.equal(headers.TE, undefined);
  assert.equal(headers.Connection, undefined);
});

test('the full block is opt-in, and the old block is untouched without it', async () => {
  const minimal = capture();
  await minimal.session.once('POST', 'https://auth.openai.com/api/accounts/user/register', {
    json: { email: 'a@b.test' },
    referer: 'https://auth.openai.com/create-account/password',
    origin: 'https://auth.openai.com',
    accept: 'application/json',
  });
  assert.deepEqual(Object.keys(minimal.sent[0].headers), ['Accept', 'User-Agent', 'Accept-Language', 'Referer', 'Origin', 'Content-Type']);

  const firefox = capture({ browserHeaders: 'firefox' });
  await firefox.session.once('POST', 'https://auth.openai.com/api/accounts/user/register', {
    json: { email: 'a@b.test' },
    referer: 'https://auth.openai.com/create-account/password',
    origin: 'https://auth.openai.com',
    accept: 'application/json',
  });
  const sent = firefox.sent[0];
  assert.equal(sent.headers['Accept-Encoding'], 'gzip, deflate, br, zstd');
  assert.equal(sent.headers['Sec-Fetch-Site'], 'same-origin');
  assert.equal(sent.body, '{"email":"a@b.test"}');
  assert.equal(sent.contentType, 'application/json');
});

test('a response arrives readable in every encoding the request offers', () => {
  const body = Buffer.from('{"ok":true}', 'utf8');
  const encoded = {
    gzip: zlib.gzipSync(body),
    deflate: zlib.deflateSync(body),
    br: zlib.brotliCompressSync(body),
    zstd: zlib.zstdCompressSync(body),
    identity: body,
  };
  for (const [encoding, buffer] of Object.entries(encoded)) {
    assert.equal(decodeResponseBody(buffer, encoding).toString('utf8'), '{"ok":true}', encoding);
  }
  // Raw deflate is served in the wild alongside the zlib-wrapped form.
  assert.equal(decodeResponseBody(zlib.deflateRawSync(body), 'deflate').toString('utf8'), '{"ok":true}');
  // And a body that will not decode is handed back rather than throwing, so
  // the caller's own checks produce the error instead of a zlib stack.
  assert.equal(decodeResponseBody(Buffer.from('plain'), 'gzip').toString('utf8'), 'plain');
});

test('Origin follows the fetch rule instead of whatever the call site passed', async () => {
  // Fetch sets `Origin` for anything that is not a GET or HEAD, and for a
  // cross-origin request of any method. A same-origin GET gets none — which
  // the capture states without ambiguity: seventy of its GET fetches carry no
  // Origin, and the only five that do are cross-origin.
  for (const mode of [undefined, 'firefox']) {
    const { session, sent } = capture({ browserHeaders: mode });
    await session.once('GET', 'https://chatgpt.com/backend-api/me', {
      origin: 'https://chatgpt.com', referer: 'https://chatgpt.com/', accept: 'application/json',
    });
    await session.once('POST', 'https://auth.openai.com/api/accounts/user/register', {
      origin: 'https://auth.openai.com', referer: 'https://auth.openai.com/create-account/password', json: {},
    });
    await session.once('GET', 'https://accounts.google.com/gsi/status', {
      origin: 'https://chatgpt.com', referer: 'https://chatgpt.com/',
    });
    const label = mode || 'minimal';
    assert.equal(sent[0].headers.Origin, undefined, `${label}: same-origin GET must send no Origin`);
    assert.equal(sent[1].headers.Origin, 'https://auth.openai.com', `${label}: a POST always carries one`);
    assert.equal(sent[2].headers.Origin, 'https://chatgpt.com', `${label}: a cross-origin GET carries one`);
  }
});

test('the auth app’s own API calls carry its tracing headers, and nothing else does', async () => {
  const { session, sent } = capture({ browserHeaders: 'firefox' });
  await session.once('GET', 'https://auth.openai.com/log-in', { accept: 'text/html', userActivated: true });
  await session.once('POST', 'https://auth.openai.com/api/accounts/user/register', {
    json: {}, accept: 'application/json', origin: 'https://auth.openai.com',
    referer: 'https://auth.openai.com/create-account/password',
  });
  await session.once('POST', 'https://auth.openai.com/api/accounts/create_account', {
    json: {}, accept: 'application/json', origin: 'https://auth.openai.com',
    referer: 'https://auth.openai.com/about-you',
  });
  await session.once('GET', 'https://chatgpt.com/backend-api/me', {
    accept: 'application/json', origin: 'https://chatgpt.com', referer: 'https://chatgpt.com/',
  });
  const [navigation, register, create, chatgpt] = sent;

  // A navigation is a document load, not an XHR the page's front end made.
  assert.equal(navigation.headers.traceparent, undefined);
  // …and so is anything outside the auth app.
  assert.equal(chatgpt.headers.traceparent, undefined);

  // The ids are checkable against each other, which is why they are generated
  // rather than approximated: the capture's `traceparent` carries a 64-bit
  // trace id zero-padded into its 128-bit field whose decimal value is exactly
  // `x-datadog-trace-id`, and the span id's is exactly `x-datadog-parent-id`.
  const parts = /^00-0{16}([0-9a-f]{16})-([0-9a-f]{16})-01$/.exec(register.headers.traceparent);
  assert.ok(parts, 'traceparent must carry a zero-padded 64-bit trace id');
  assert.equal(BigInt(`0x${parts[1]}`).toString(), register.headers['x-datadog-trace-id']);
  assert.equal(BigInt(`0x${parts[2]}`).toString(), register.headers['x-datadog-parent-id']);
  assert.equal(register.headers.tracestate, 'dd=s:1;o:rum');
  assert.equal(register.headers['x-datadog-origin'], 'rum');
  assert.equal(register.headers['x-datadog-sampling-priority'], '1');

  // The invocation id is per request; the navigation id survives the auth
  // app's client-side route changes, which is how the capture behaves — two
  // requests from one loaded page share it.
  assert.notEqual(register.headers['x-access-flow-invocation-id'], create.headers['x-access-flow-invocation-id']);
  assert.equal(register.headers['x-openai-document-navigation-id'], create.headers['x-openai-document-navigation-id']);

  // …and a real document load replaces it.
  await session.once('GET', 'https://auth.openai.com/api/accounts/email-otp/send', { accept: 'text/html', userActivated: true });
  await session.once('POST', 'https://auth.openai.com/api/accounts/email-otp/validate', {
    json: {}, accept: 'application/json', origin: 'https://auth.openai.com',
    referer: 'https://auth.openai.com/email-verification',
  });
  assert.notEqual(sent[5].headers['x-openai-document-navigation-id'], register.headers['x-openai-document-navigation-id']);
});

test('the whole block goes out in the order the page sends it', async () => {
  const { session, sent } = capture({ browserHeaders: 'firefox' });
  await session.once('POST', 'https://auth.openai.com/api/accounts/user/register', {
    json: {}, accept: 'application/json', origin: 'https://auth.openai.com',
    referer: 'https://auth.openai.com/create-account/password',
    headers: { 'openai-sentinel-token': '{}' },
  });
  assert.deepEqual(Object.keys(sent[0].headers), [
    'User-Agent',
    'Accept',
    'Accept-Language',
    'Accept-Encoding',
    'Referer',
    'Content-Type',
    'openai-sentinel-token',
    'x-access-flow-invocation-id',
    'x-openai-document-navigation-id',
    'traceparent',
    'tracestate',
    'x-datadog-origin',
    'x-datadog-parent-id',
    'x-datadog-sampling-priority',
    'x-datadog-trace-id',
    'Origin',
    'Sec-Fetch-Dest',
    'Sec-Fetch-Mode',
    'Sec-Fetch-Site',
    'Priority',
  ]);
});
