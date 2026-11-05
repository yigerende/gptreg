'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildCloudflareJsdProbe, extractCloudflareParams } = require('../src/cloudflare-jsd');
const { loadHar } = require('../src/har');

test('extracts Cloudflare JSD params from login HTML', () => {
  const { har } = loadHar();
  const params = extractCloudflareParams(har.log.entries[3].response.content.text);

  assert.deepEqual(params, {
    r: 'a2166669ee7fb33e',
    t: 'MTc4NTEwMDMyMA==',
  });
});

test('builds a pure HTTP oneshot request from the captured JSD script', async () => {
  const { har } = loadHar();
  const params = extractCloudflareParams(har.log.entries[3].response.content.text);
  const probe = await buildCloudflareJsdProbe(har.log.entries[40].response.content.text, {
    params,
    scriptUrl: har.log.entries[40].request.url,
    pageUrl: 'https://auth.openai.com/log-in',
    nowMs: (Number(Buffer.from(params.t, 'base64').toString('utf8')) + 1) * 1000,
    waitMs: 1000,
  });

  assert.equal(probe.method, 'POST');
  assert.match(probe.url, /\/cdn-cgi\/challenge-platform\/h\/g\/jsd\/oneshot\//);
  assert.equal(probe.url.endsWith('/a2166669ee7fb33e'), true);
  assert.ok(probe.body.length > 40);
});
