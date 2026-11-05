'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  classifyRegistrationBlock,
  retryDelayMs,
  rewindToStep,
  shouldFallbackToLogin,
} = require('../src/registration-policy');

function stateFor(step, status, code) {
  return {
    next: 5,
    blocked: { step, missing: [`http_${status}`] },
    events: [{ step, status, textPreview: JSON.stringify({ error: { code, message: code } }) }],
  };
}

test('classifies rejected phone numbers separately from continuity failures', () => {
  assert.equal(classifyRegistrationBlock(stateFor('phone_otp_send', 400, 'invalid_phone_number')).action, 'replace_phone');
  assert.equal(classifyRegistrationBlock(stateFor('phone_otp_send', 400, 'phone_number_in_use')).action, 'replace_phone');
  assert.equal(classifyRegistrationBlock(stateFor('phone_otp_send', 400, 'fraud_guard')).action, 'replace_phone');
  assert.equal(classifyRegistrationBlock(stateFor('create_account', 429, 'phone_recently_used')).action, 'retry_phone_continuity');
});

test('fallback login requires proof that account creation succeeded', () => {
  const state = stateFor('workspace_select', 400, 'login_request_expired');
  assert.equal(shouldFallbackToLogin(state), false);
  state.events.unshift({ step: 'create_account', status: 200, textPreview: '{}' });
  assert.equal(shouldFallbackToLogin(state), true);
  assert.equal(classifyRegistrationBlock(state).action, 'fallback_login');

  const redirected = stateFor('workspace_select', 400, 'login_request_expired');
  redirected.events.unshift({ step: 'create_account', status: 302, textPreview: '{}' });
  assert.equal(shouldFallbackToLogin(redirected), false);
});

test('classifies a login-password redirect before user registration as existing-account recovery', () => {
  const state = stateFor('user_register', 400, 'invalid_auth_step');
  state.lastContinueUrl = 'https://auth.openai.com/log-in/password';
  const result = classifyRegistrationBlock(state);
  assert.equal(result.action, 'migrate_existing_account');
  assert.equal(result.code, 'existing_account_detected');
  assert.equal(result.upstreamCode, 'invalid_auth_step');
});

test('rewinds to a named step and uses bounded continuity delays', () => {
  const state = { next: 7, complete: true, blocked: { step: 'x' } };
  rewindToStep(state, [{ name: 'sentinel' }, { name: 'create' }], 'sentinel');
  assert.equal(state.next, 0);
  assert.equal(state.complete, false);
  assert.equal(state.blocked, null);
  assert.deepEqual([1, 2, 3, 4].map((attempt) => retryDelayMs(attempt)), [2000, 5000, 10000, 10000]);
});
