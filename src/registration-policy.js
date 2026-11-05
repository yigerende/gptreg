'use strict';

const { tryParseJson } = require('./http-shape');

const TRANSIENT_HTTP_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
// Kept in step with the same set in branch-orchestrator.js, which sees these
// codes uppercased. `phone_max_usage_exceeded` / `phone_recently_used` are the
// recycled-number cases: the number is spent, not the attempt.
const REPLACE_PHONE_CODES = new Set([
  'invalid_phone_number',
  'phone_number_in_use',
  'phone_max_usage_exceeded',
  'phone_recently_used',
  'fraud_guard',
]);

function lastEvent(state = {}) {
  const events = state.events || [];
  return events[events.length - 1] || null;
}

function eventPayload(event = {}) {
  return tryParseJson(event.textPreview || '') || {};
}

function responseError(state = {}) {
  const event = lastEvent(state);
  const payload = eventPayload(event);
  const error = payload.error && typeof payload.error === 'object' ? payload.error : payload;
  return {
    event,
    status: Number(event?.status || 0),
    step: event?.step || state.blocked?.step || '',
    code: String(error?.code || payload?.code || ''),
    message: String(error?.message || payload?.message || ''),
    payload,
  };
}

function accountWasCreated(state = {}) {
  return (state.events || []).some((event) => event.step === 'create_account' && event.status === 200);
}

function shouldFallbackToLogin(state = {}) {
  const error = responseError(state);
  return accountWasCreated(state)
    && error.step === 'workspace_select'
    && error.code === 'login_request_expired';
}

function shouldMigrateExistingAccount(state = {}) {
  const error = responseError(state);
  return error.step === 'user_register'
    && error.code.toLowerCase() === 'invalid_auth_step'
    && /\/log-in\/password/i.test(String(state.lastContinueUrl || ''));
}

function classifyRegistrationBlock(state = {}) {
  const missing = state.blocked?.missing || [];
  if (missing.includes('emailCode')) return { action: 'wait_email', ...responseError(state) };
  if (missing.includes('phone')) return { action: 'acquire_phone', ...responseError(state) };
  if (missing.includes('phoneCode')) return { action: 'wait_sms_code', ...responseError(state) };
  if (missing.includes('workspace_id_from_previous_response')) {
    return { action: 'missing_workspace', ...responseError(state) };
  }
  if (missing.includes('dry_run')) return { action: 'dry_run', ...responseError(state) };

  const error = responseError(state);
  if (error.step === 'phone_otp_send' && REPLACE_PHONE_CODES.has(error.code)) {
    return { action: 'replace_phone', ...error };
  }
  if (error.step === 'create_account' && error.code === 'phone_recently_used') {
    return { action: 'retry_phone_continuity', ...error };
  }
  if (shouldMigrateExistingAccount(state)) {
    return {
      ...error,
      action: 'migrate_existing_account',
      upstreamCode: error.code,
      code: 'existing_account_detected',
      message: 'The email is already on the login path; resume with the dynamic existing-account flow',
    };
  }
  if (shouldFallbackToLogin(state)) return { action: 'fallback_login', ...error };
  if (error.step === 'create_account' && (error.status === 429 || /limit|creation/i.test(error.code))) {
    return { action: 'retry_account_create', ...error };
  }
  if (TRANSIENT_HTTP_STATUSES.has(error.status)) return { action: 'retry_transient', ...error };
  if (error.status >= 400) return { action: 'block_http', ...error };
  return { action: 'unhandled', ...error, missing };
}

function retryDelayMs(attempt, schedule = [2000, 5000, 10000]) {
  const index = Math.max(0, Math.min(Number(attempt || 1) - 1, schedule.length - 1));
  return Number(schedule[index]);
}

function stepIndex(steps, name) {
  const index = (steps || []).findIndex((step) => step.name === name);
  if (index < 0) throw new Error(`Unknown runner step: ${name}`);
  return index;
}

function rewindToStep(state, steps, name) {
  state.next = stepIndex(steps, name);
  state.complete = false;
  state.blocked = null;
  return state;
}

module.exports = {
  classifyRegistrationBlock,
  lastEvent,
  retryDelayMs,
  rewindToStep,
  shouldFallbackToLogin,
};
