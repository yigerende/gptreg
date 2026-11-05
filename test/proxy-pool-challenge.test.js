'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { isCloudflareChallenge, probeProxy } = require('../src/proxy-pool');

function probeResponse(status, text = '') {
  return { response: { status, text, url: 'https://auth.openai.com/' } };
}

test('a Cloudflare interstitial is recognised only on a 403 body', () => {
  assert.equal(isCloudflareChallenge(403, '<title>Just a moment...</title>'), true);
  assert.equal(isCloudflareChallenge(403, 'blocked by /cdn-cgi/challenge-platform'), true);
  assert.equal(isCloudflareChallenge(403, 'plain forbidden'), false);
  assert.equal(isCloudflareChallenge(200, 'just a moment'), false);
});

test('the catalog probe keeps accepting a challenged exit as reachable', async () => {
  const result = await probeProxy({ url: 'http://127.0.0.1:4001' }, {
    executor: async () => probeResponse(403, '<title>Just a moment...</title>'),
  });
  assert.equal(result.status, 403);
});

test('an auth-facing probe rejects a challenged exit so the worker can rotate', async () => {
  await assert.rejects(
    probeProxy({ url: 'http://127.0.0.1:4001' }, {
      rejectChallenge: true,
      executor: async () => probeResponse(403, '<title>Just a moment...</title>'),
    }),
    (error) => {
      assert.equal(error.code, 'PROXY_CLOUDFLARE_CHALLENGE');
      assert.equal(error.status, 403);
      return true;
    },
  );
});

test('a plain 403 still passes the auth-facing probe', async () => {
  const result = await probeProxy({ url: 'http://127.0.0.1:4001' }, {
    rejectChallenge: true,
    executor: async () => probeResponse(403, 'forbidden'),
  });
  assert.equal(result.status, 403);
});

test('an unreachable exit fails regardless of the challenge option', async () => {
  await assert.rejects(
    probeProxy({ url: 'http://127.0.0.1:4001' }, {
      rejectChallenge: true,
      executor: async () => probeResponse(502),
    }),
    /Proxy probe failed with HTTP 502/,
  );
});
