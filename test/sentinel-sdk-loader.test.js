'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createFirefox153Profile } = require('../src/client-profile');
const {
  clearSentinelSdkCache,
  extractVersionedSdkUrl,
  loadSentinelSdk,
} = require('../src/sentinel-sdk-loader');

test('live SDK loading works without a capture and reports real bootstrap failures', async (t) => {
  clearSentinelSdkCache();
  t.after(clearSentinelSdkCache);
  const empty = { source: '', url: '' };
  const state = () => ({ clientProfile: createFirefox153Profile(), cookies: {} });
  let calls = 0;
  const source = 'globalThis.SentinelSDK = { init() {}, token() {} };';
  const loaded = await loadSentinelSdk(empty, state(), { cacheTtlMs: 0, executor: async () => {
    calls++;
    return { response: { status: 200, text: source } };
  } });
  assert.equal(loaded.origin, 'live');
  assert.equal(loaded.source, source);
  assert.equal(calls, 1);
  await assert.rejects(loadSentinelSdk(empty, state(), { executor: async () => { throw new Error('ECONNRESET'); } }), /ECONNRESET/);
  await assert.rejects(loadSentinelSdk(empty, state(), { executor: async () => ({ response: { status: 200, text: '<html>no sdk</html>' } }) }), /did not provide a versioned SDK URL/);
  await assert.rejects(loadSentinelSdk(empty, state(), { live: false }), /requires a live executor/);
});

test('loads and caches the live SDK through the Firefox pure URL executor', async () => {
  clearSentinelSdkCache();
  const versionedUrl = 'https://sentinel.openai.com/sentinel/unit-version/sdk.js';
  const harSdk = { url: 'https://sentinel.openai.com/sentinel/har/sdk.js', source: 'globalThis.SentinelSDK = { har: true };' };
  const state = { clientProfile: createFirefox153Profile(), cookies: { 'oai-did': 'did' } };
  const requests = [];
  const executor = async (request) => {
    requests.push(request);
    const text = request.url.endsWith('/backend-api/sentinel/sdk.js')
      ? `const sdk = '${versionedUrl}';`
      : 'globalThis.SentinelSDK = { init() {}, token() {} };';
    return {
      request,
      response: { status: 200, text, url: request.url },
      cookies: state.cookies,
    };
  };

  const first = await loadSentinelSdk(harSdk, state, { executor, cacheTtlMs: 60000 });
  const second = await loadSentinelSdk(harSdk, state, { executor, cacheTtlMs: 60000 });

  assert.equal(first.url, versionedUrl);
  assert.equal(first.origin, 'live');
  assert.equal(second.source, first.source);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => /Firefox\/153\.0/.test(request.headers['User-Agent'])));
  assert.ok(requests.every((request) => !Object.keys(request.headers).some((name) => name.toLowerCase().startsWith('sec-ch-ua'))));
  assert.equal(state.sentinelSdk.profileFingerprint.length, 64);

  const resumedState = JSON.parse(JSON.stringify(state));
  const resumed = await loadSentinelSdk(harSdk, resumedState, { executor, cacheTtlMs: 60000 });
  assert.equal(resumed.url, versionedUrl);
  assert.equal(resumed.origin, 'live-resume');
  assert.equal(requests.length, 3);
  assert.equal(requests[2].url, versionedUrl);
});

test('coalesces concurrent live SDK loads for the same Firefox profile', async () => {
  clearSentinelSdkCache();
  const versionedUrl = 'https://sentinel.openai.com/sentinel/concurrent/sdk.js';
  const harSdk = { url: 'https://sentinel.openai.com/sentinel/har/sdk.js', source: 'globalThis.SentinelSDK = { har: true };' };
  const makeState = () => ({ clientProfile: createFirefox153Profile(), cookies: { 'oai-did': 'did' } });
  const requests = [];
  const executor = async (request) => {
    requests.push(request.url);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const text = request.url.endsWith('/backend-api/sentinel/sdk.js')
      ? `const sdk = '${versionedUrl}';`
      : 'globalThis.SentinelSDK = { init() {}, token() {} };';
    return {
      request,
      response: { status: 200, text, url: request.url },
      cookies: { 'oai-did': 'did' },
    };
  };

  const [first, second] = await Promise.all([
    loadSentinelSdk(harSdk, makeState(), { executor, cacheTtlMs: 60000 }),
    loadSentinelSdk(harSdk, makeState(), { executor, cacheTtlMs: 60000 }),
  ]);

  assert.equal(first.origin, 'live');
  assert.equal(second.origin, 'live');
  assert.equal(first.source, second.source);
  assert.equal(requests.length, 2);
});

test('keeps concurrent SDK loads on different proxies isolated', async () => {
  clearSentinelSdkCache();
  const versionedUrl = 'https://sentinel.openai.com/sentinel/proxy-isolated/sdk.js';
  const harSdk = { url: 'https://sentinel.openai.com/sentinel/har/sdk.js', source: 'globalThis.SentinelSDK = { har: true };' };
  const requests = [];
  const executor = async (request, _step, state) => {
    requests.push({ url: request.url, proxy: state.proxy });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const text = request.url.endsWith('/backend-api/sentinel/sdk.js')
      ? `const sdk = '${versionedUrl}';`
      : 'globalThis.SentinelSDK = { init() {}, token() {} };';
    return {
      request,
      response: { status: 200, text, url: request.url },
      cookies: state.cookies,
    };
  };
  const makeState = (proxy) => ({
    clientProfile: createFirefox153Profile(),
    cookies: { 'oai-did': `${proxy}-did` },
    proxy,
  });

  const [first, second] = await Promise.all([
    loadSentinelSdk(harSdk, makeState('proxy-a'), { executor, proxy: 'proxy-a', cacheTtlMs: 60000 }),
    loadSentinelSdk(harSdk, makeState('proxy-b'), { executor, proxy: 'proxy-b', cacheTtlMs: 60000 }),
  ]);

  assert.equal(first.origin, 'live');
  assert.equal(second.origin, 'live');
  assert.equal(first.source, second.source);
  assert.equal(requests.length, 4);
  assert.deepEqual(new Set(requests.map((request) => request.proxy)), new Set(['proxy-a', 'proxy-b']));
});

test('preserves the auth device cookie when SDK responses are scoped to sentinel.openai.com', async () => {
  clearSentinelSdkCache();
  const versionedUrl = 'https://sentinel.openai.com/sentinel/scoped/sdk.js';
  const harSdk = { url: 'https://sentinel.openai.com/sentinel/har/sdk.js', source: 'globalThis.SentinelSDK = { har: true };' };
  const state = {
    clientProfile: createFirefox153Profile(),
    oaiDid: 'locked-auth-did',
    cookies: { 'oai-did': 'locked-auth-did', 'oai-sc': '0current-challenge' },
  };
  const executor = async (request) => ({
    request,
    response: {
      status: 200,
      text: request.url.endsWith('/backend-api/sentinel/sdk.js')
        ? `const sdk = '${versionedUrl}';`
        : 'globalThis.SentinelSDK = { init() {}, token() {} };',
      url: request.url,
    },
    // UrlSession returns cookies scoped to the SDK host. It may be empty or
    // expose a host-local device cookie, but neither may replace the
    // auth.openai.com cookie view used by Sentinel.
    cookies: {
      'oai-did': 'foreign-sentinel-did',
      'sentinel-session': 'sdk-session',
    },
  });

  await loadSentinelSdk(harSdk, state, { executor, proxy: 'proxy-scoped', cacheTtlMs: 60000 });

  assert.equal(state.cookies['oai-did'], 'locked-auth-did');
  assert.equal(state.cookies['oai-sc'], '0current-challenge');
  assert.equal(state.cookies['sentinel-session'], 'sdk-session');
});

test('does not share device cookies between tasks that coalesce an SDK load', async () => {
  clearSentinelSdkCache();
  const versionedUrl = 'https://sentinel.openai.com/sentinel/coalesced/sdk.js';
  const harSdk = { url: 'https://sentinel.openai.com/sentinel/har/sdk.js', source: 'globalThis.SentinelSDK = { har: true };' };
  const makeState = (did) => ({
    clientProfile: createFirefox153Profile(),
    cookies: { 'oai-did': did, 'oai-sc': `${did}-sc` },
  });
  const firstState = makeState('task-a-did');
  const secondState = makeState('task-b-did');
  const requests = [];
  const executor = async (request, _step, state) => {
    requests.push({ url: request.url, did: state.cookies['oai-did'] });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const text = request.url.endsWith('/backend-api/sentinel/sdk.js')
      ? `const sdk = '${versionedUrl}';`
      : 'globalThis.SentinelSDK = { init() {}, token() {} };';
    return {
      request,
      response: { status: 200, text, url: request.url },
      cookies: { 'oai-did': 'foreign-sdk-did' },
    };
  };

  await Promise.all([
    loadSentinelSdk(harSdk, firstState, { executor, proxy: 'shared-proxy', cacheTtlMs: 60000 }),
    loadSentinelSdk(harSdk, secondState, { executor, proxy: 'shared-proxy', cacheTtlMs: 60000 }),
  ]);

  assert.equal(requests.length, 2);
  assert.equal(firstState.cookies['oai-did'], 'task-a-did');
  assert.equal(secondState.cookies['oai-did'], 'task-b-did');
  assert.equal(firstState.cookies['oai-sc'], 'task-a-did-sc');
  assert.equal(secondState.cookies['oai-sc'], 'task-b-did-sc');
});

test('extracts a versioned Sentinel SDK URL without accepting another host', () => {
  const expected = 'https://sentinel.openai.com/sentinel/abc/sdk.js';
  assert.equal(extractVersionedSdkUrl(`load('${expected}')`), expected);
  assert.equal(extractVersionedSdkUrl("load('https://example.test/sentinel/abc/sdk.js')"), '');
});
