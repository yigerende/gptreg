'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildProtocolDrift } = require('../src/protocol-drift');
const { FIREFOX_RELEASES, firefoxUserAgent } = require('../src/client-profile');

const NEWEST = firefoxUserAgent(FIREFOX_RELEASES[0].version);

function entry(method, url, headers, postData) {
  return {
    request: {
      method,
      url,
      headers: Object.entries(headers).map(([name, value]) => ({ name, value })),
      ...(postData ? { postData: { text: postData } } : {}),
    },
    response: { status: 200 },
  };
}

function capture(entries) {
  return { log: { entries } };
}

test('a capture newer than the pool is reported as the pool being behind', () => {
  const stale = buildProtocolDrift(capture([
    entry('GET', 'https://auth.openai.com/log-in', { 'User-Agent': firefoxUserAgent(999), 'Sec-Fetch-Dest': 'document' }),
  ]));
  assert.equal(stale.browser.poolIsBehind, true);
  assert.equal(stale.browser.newestInPool, NEWEST);

  const current = buildProtocolDrift(capture([
    entry('GET', 'https://auth.openai.com/log-in', { 'User-Agent': NEWEST, 'Sec-Fetch-Dest': 'document' }),
  ]));
  assert.equal(current.browser.poolIsBehind, false);
});

test('endpoints split into what only the capture has, what only the code drives, and the overlap', () => {
  const report = buildProtocolDrift(
    capture([
      entry('POST', 'https://auth.openai.com/api/accounts/user/register', { 'User-Agent': NEWEST }),
      entry('GET', 'https://auth.openai.com/api/accounts/brand-new-step', { 'User-Agent': NEWEST }),
    ]),
    { knownPaths: ['/api/accounts/user/register', '/api/accounts/consent'] },
  );
  assert.deepEqual(report.endpoints.inCaptureOnly, ['/api/accounts/brand-new-step']);
  assert.deepEqual(report.endpoints.inCodeOnly, ['/api/accounts/consent']);
  assert.deepEqual(report.endpoints.shared, ['/api/accounts/user/register']);
});

test('a request the code would send exactly is reported as matching', () => {
  // The shape a real create_account carries. The traced ids are fresh on every
  // request, so the report checks that both sides emit those headers and says
  // nothing about their values — but a missing one is still drift, which is
  // how it caught that the console used to send none of them at all.
  const report = buildProtocolDrift(capture([
    entry('POST', 'https://auth.openai.com/api/accounts/create_account', {
      'User-Agent': NEWEST,
      Accept: 'application/json',
      'Accept-Language': 'zh-CN,zh;q=0.9,zh-TW;q=0.8,zh-HK;q=0.7,en-US;q=0.6,en;q=0.5',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      Referer: 'https://auth.openai.com/about-you',
      'content-type': 'application/json',
      Origin: 'https://auth.openai.com',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      Priority: 'u=4',
      Pragma: 'no-cache',
      'Cache-Control': 'no-cache',
      Cookie: 'oai-did=x',
      'x-access-flow-invocation-id': '677e3ff3-a156-4896-b72b-0fcbfb2221aa',
      'x-openai-document-navigation-id': '9273b48d-8760-4f9d-a117-81e9b52adf5a',
      traceparent: '00-0000000000000000304474ebd1ada273-04e4d227f3b53162-01',
      tracestate: 'dd=s:1;o:rum',
      'x-datadog-origin': 'rum',
      'x-datadog-parent-id': '352637739876036962',
      'x-datadog-sampling-priority': '1',
      'x-datadog-trace-id': '3478033368420819571',
      'openai-sentinel-token': '{}',
    }),
  ]));
  assert.deepEqual(report.headers['POST auth.openai.com/api/accounts/create_account'], { kind: 'fetch', matches: true });
});

test('a header the code stopped sending is reported, not silently dropped', () => {
  const report = buildProtocolDrift(capture([
    entry('POST', 'https://auth.openai.com/api/accounts/user/register', {
      'User-Agent': NEWEST,
      Accept: 'application/json',
      'Accept-Encoding': 'gzip, deflate, br, zstd',
      Referer: 'https://auth.openai.com/create-account/password',
      'content-type': 'application/json',
      Origin: 'https://auth.openai.com',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      Priority: 'u=4',
      'x-openai-brand-new-header': 'something the code has never heard of',
    }),
  ]));
  const drift = report.headers['POST auth.openai.com/api/accounts/user/register'];
  assert.deepEqual(drift.missingFromCode, ['x-openai-brand-new-header']);
});

test('the Sentinel surface is reported from the capture', () => {
  const report = buildProtocolDrift(capture([
    entry('GET', 'https://sentinel.openai.com/sentinel/20260810913b/sdk.js', { 'User-Agent': NEWEST }),
    entry('GET', 'https://sentinel.openai.com/backend-api/sentinel/sdk.js', { 'User-Agent': NEWEST }),
    entry('POST', 'https://sentinel.openai.com/backend-api/sentinel/req', { 'User-Agent': NEWEST }, '{"p":"","id":"x","flow":"oauth_create_account"}'),
    entry('POST', 'https://sentinel.openai.com/backend-api/sentinel/req', { 'User-Agent': NEWEST }, '{"p":"","id":"x","flow":"email_otp_validate"}'),
  ]));
  assert.deepEqual(report.sentinel.sdkPaths, ['/backend-api/sentinel/sdk.js', '/sentinel/20260810913b/sdk.js']);
  assert.deepEqual(report.sentinel.flows, ['email_otp_validate', 'oauth_create_account']);
});
