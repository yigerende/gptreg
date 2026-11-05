'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { loadHar } = require('../src/har');
const { buildEmailFlow } = require('../src/email-flow');
const { decodeUrlizedRequest } = require('../src/url-chain');

test('builds authorize/continue request body for a supplied email', () => {
  const { har } = loadHar();
  const email = 'user1@example.com';
  const flow = buildEmailFlow(har, { email, redact: false });
  const decoded = decodeUrlizedRequest(flow.target.urlized);
  const body = JSON.parse(decoded.body);

  assert.equal(flow.sourceIndex, 137);
  assert.equal(decoded.method, 'POST');
  assert.equal(decoded.url, 'https://auth.openai.com/api/accounts/authorize/continue');
  assert.equal(body.username.value, email);
  assert.equal(body.username.kind, 'email');
  assert.equal(body.screen_hint, 'signup');
  assert.equal(flow.requirements.mustRegenerateForLiveRun, true);
});

test('redacts supplied email by default', () => {
  const { har } = loadHar();
  const email = 'user1@example.com';
  const flow = buildEmailFlow(har, { email });

  assert.equal(JSON.stringify(flow).includes(email), false);
});
