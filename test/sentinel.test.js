'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { loadHar } = require('../src/har');
const { buildSentinelEnvelope, extractSentinel } = require('../src/sentinel');

test('extracts Sentinel assets, request contract, and consumers', () => {
  const { har } = loadHar();
  const sentinel = extractSentinel(har, { redact: true });

  assert.equal(sentinel.version, '20260219f9f6');
  assert.equal(sentinel.assets.sdk.length, 6);
  assert.equal(sentinel.assets.frame.length, 2);
  assert.equal(sentinel.requests.length, 7);
  assert.ok(sentinel.contract.consumerHeaders.includes('openai-sentinel-token'));
  assert.ok(sentinel.contract.consumerHeaders.includes('openai-sentinel-so-token'));
  assert.ok(sentinel.requests.every((request) => request.idMatchesOaiDid));
});

test('builds the same Sentinel init envelope shape as the SDK capture', () => {
  const { har } = loadHar();
  const entry = har.log.entries[84];
  const body = JSON.parse(entry.request.postData.text);
  const did = entry.request.cookies.find((cookie) => cookie.name === 'oai-did').value;

  assert.equal(buildSentinelEnvelope({ p: body.p }, body.flow, did), entry.request.postData.text);
});

test('redacted Sentinel output does not include captured account values', () => {
  const { har } = loadHar();
  const registerBody = JSON.parse(har.log.entries[146].request.postData.text);
  const sentinel = extractSentinel(har, { redact: true });
  const serialized = JSON.stringify(sentinel);

  assert.equal(serialized.includes(registerBody.username), false);
  assert.equal(serialized.includes(registerBody.password), false);
});
