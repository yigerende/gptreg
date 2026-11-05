'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { loadHar } = require('../src/har');
const { decodePureHttpUrl } = require('../src/pure-url');
const { buildRegistrationPlan } = require('../src/registration-flow');

test('builds a pure URL registration plan for the supplied email', () => {
  const { har } = loadHar();
  const email = 'user1@example.com';
  const plan = buildRegistrationPlan(har, { email, redact: false });
  const first = decodePureHttpUrl(plan.steps[0].pureUrl);
  const firstBody = JSON.parse(first.body);

  assert.equal(plan.mode, 'pure-url-registration-plan');
  assert.equal(plan.email, email);
  assert.equal(plan.steps.length, 11);
  assert.equal(firstBody.username.value, email);
  assert.deepEqual(plan.steps[3].missing, ['email_code']);
  assert.deepEqual(plan.steps[4].missing, ['phone']);
  assert.deepEqual(plan.steps[5].missing, ['phone_code']);
});

test('redacted registration plan does not include supplied email', () => {
  const { har } = loadHar();
  const email = 'user1@example.com';
  const plan = buildRegistrationPlan(har, { email });
  const rawOauthUrl = har.log.entries[308].request.url;
  const rawOauthChallenge = new URL(rawOauthUrl).searchParams.get('login_verifier');

  assert.equal(JSON.stringify(plan).includes(email), false);
  assert.equal(JSON.stringify(plan).includes(rawOauthChallenge), false);
});

test('can emit a single registration step summary', () => {
  const { har } = loadHar();
  const plan = buildRegistrationPlan(har, {
    email: 'user1@example.com',
    step: 'email_otp_validate',
    summary: true,
  });

  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0].name, 'email_otp_validate');
  assert.deepEqual(plan.steps[0].missing, ['email_code']);
  assert.equal(Object.hasOwn(plan.steps[0], 'pureUrl'), false);
});
