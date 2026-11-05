'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { loadHar } = require('../src/har');
const { createSentinelRuntime, sentinelSdkFromHar, validateChallengeTokens } = require('../src/sentinel-runtime');

test('uses the unmodified Sentinel SDK public API for a Firefox requirements proof', async () => {
  const { har } = loadHar();
  const sdk = sentinelSdkFromHar(har);
  const runtime = createSentinelRuntime(sdk.source, {
    sdkUrl: sdk.url,
    cookies: { 'oai-did': 'fresh-did' },
  });

  try {
    const requirements = await runtime.getRequirementsToken('oauth_create_account');
    const decoded = Buffer.from(requirements.slice(7), 'base64').toString('utf8');
    assert.match(requirements, /^gAAAAAC/);
    assert.match(decoded, /Firefox\/153\.0/);
    assert.doesNotMatch(decoded, /Chrome\//);
  } finally {
    runtime.dispose();
  }
});

test('generates independently bound Sentinel and SO tokens for create_account', async () => {
  const { har } = loadHar();
  const sdk = sentinelSdkFromHar(har);
  const request = JSON.parse(har.log.entries[295].request.postData.text);
  const challenge = JSON.parse(har.log.entries[295].response.content.text);
  const runtime = createSentinelRuntime(sdk.source, {
    sdkUrl: sdk.url,
    cookies: { 'oai-did': request.id },
    behaviorDurationMs: 0,
  });

  try {
    const generated = await runtime.getChallengeTokens(
      'oauth_create_account',
      challenge,
      request.p,
      { id: request.id, behaviorDurationMs: 0 },
    );
    const validated = validateChallengeTokens(generated, challenge, {
      id: request.id,
      flow: 'oauth_create_account',
    });

    assert.ok(validated.token.p);
    assert.ok(validated.token.t);
    assert.ok(validated.soToken.so);
    assert.equal(validated.token.c, challenge.token);
    assert.equal(validated.soToken.c, challenge.token);
    assert.equal(validated.token.id, request.id);
    assert.equal(validated.soToken.id, request.id);
  } finally {
    runtime.dispose();
  }
});

test('rejects a Sentinel SO token from another challenge', () => {
  const challenge = {
    token: 'current-challenge',
    proofofwork: { required: true },
    turnstile: { required: false },
    so: { required: true },
  };
  const token = JSON.stringify({ p: 'proof', t: '', c: challenge.token, id: 'did', flow: 'oauth_create_account' });
  const soToken = JSON.stringify({ so: 'observer', c: 'stale-challenge', id: 'did', flow: 'oauth_create_account' });

  assert.throws(
    () => validateChallengeTokens({ token, soToken }, challenge, { id: 'did', flow: 'oauth_create_account' }),
    /SO token c binding mismatch/,
  );
});

test('rejects a decoded observer VM error even when its envelope is bound', () => {
  const challenge = { token: 'challenge', so: { required: true } };
  const token = JSON.stringify({ p: '', t: '', c: 'challenge', id: 'did', flow: 'oauth_create_account' });
  const soToken = JSON.stringify({
    so: Buffer.from('0: SyntaxError: invalid observer payload').toString('base64'),
    c: 'challenge',
    id: 'did',
    flow: 'oauth_create_account',
  });

  assert.throws(
    () => validateChallengeTokens({ token, soToken }, challenge, { id: 'did', flow: 'oauth_create_account' }),
    /observer VM failed/,
  );
});
