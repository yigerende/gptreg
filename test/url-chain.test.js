'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { loadHar } = require('../src/har');
const { buildUrlChain, decodeUrlizedRequest } = require('../src/url-chain');

test('builds a reversible raw URL chain from the workspace HAR', () => {
  const { har } = loadHar();
  const chain = buildUrlChain(har, { redact: false, includeTelemetry: true, includeBodyText: true });

  assert.equal(chain.totalEntries, 314);
  assert.ok(chain.selectedEntries > 20);

  for (const entry of chain.entries) {
    const decoded = decodeUrlizedRequest(entry.urlized);
    assert.equal(decoded.index, entry.index);
    assert.equal(decoded.method, entry.method);
    assert.equal(decoded.status, entry.status);
    assert.equal(decoded.url, entry.url);
    assert.equal(decoded.body, entry.postData?.text || '');
  }
});

test('redacted URL chain preserves parameter names without raw values', () => {
  const { har } = loadHar();
  const chain = buildUrlChain(har, { redact: true });
  const first = chain.entries.find((entry) => entry.kind === 'oauth-entry');

  assert.ok(first);
  assert.ok(first.url.includes('code_challenge='));
  assert.ok(first.url.includes('%3Credacted%3E'));
  assert.deepEqual(first.queryNames.slice(0, 3), ['response_type', 'client_id', 'redirect_uri']);
});

test('redacted URL chain does not include captured account values', () => {
  const { har } = loadHar();
  const registerBody = JSON.parse(har.log.entries[146].request.postData.text);
  const chain = buildUrlChain(har, { redact: true });
  const serialized = JSON.stringify(chain);

  assert.equal(serialized.includes(registerBody.username), false);
  assert.equal(serialized.includes(registerBody.password), false);
});
