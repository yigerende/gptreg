'use strict';

const crypto = require('node:crypto');

const { bodySummary, entriesOf } = require('./har');
const { parseUrl, redactUrl, tryParseJson } = require('./http-shape');
const { templateEntry, templateFor, templateUrl } = require('./protocol-templates');
const { makePureHttpUrl } = require('./pure-url');
const { assertEmail, cloneJson } = require('./util/shared');

const REGISTRATION_STEPS = [
  { name: 'authorize_continue', index: 137, path: '/api/accounts/authorize/continue' },
  { name: 'user_register', index: 146, path: '/api/accounts/user/register' },
  { name: 'email_otp_send', index: 150, path: '/api/accounts/email-otp/send' },
  { name: 'email_otp_validate', index: 258, path: '/api/accounts/email-otp/validate', needs: 'email_code' },
  { name: 'phone_otp_send', index: 279, path: '/api/accounts/add-phone/send', needs: 'phone' },
  { name: 'phone_otp_validate', index: 287, path: '/api/accounts/phone-otp/validate', needs: 'phone_code' },
  { name: 'create_account', index: 299, path: '/api/accounts/create_account' },
  { name: 'workspace_select', index: 305, path: '/api/accounts/workspace/select', needs: 'workspace_id' },
  { name: 'oauth_auth_login_verifier', index: 308, path: '/api/oauth/oauth2/auth' },
  { name: 'oauth_consent', index: 309, path: '/api/accounts/consent' },
  { name: 'oauth_auth_consent_verifier', index: 310, path: '/api/oauth/oauth2/auth' },
];

function generatedPassword() {
  return `Ctf-${crypto.randomBytes(6).toString('base64url')}!9`;
}

/**
 * The request a step makes, built from the declared template.
 *
 * `path` stays on the step as the contract this module is written against, and
 * is checked against the template rather than trusted: the two live in
 * different files and a rename in one of them should stop the flow here rather
 * than send a request somewhere unintended.
 */
function templateEntryForStep(step, options) {
  const template = templateFor(step.name);
  const url = parseUrl(templateUrl(template));
  if (url?.pathname !== step.path) {
    throw new Error(`Registration step ${step.name} expects ${step.path}, its template targets ${url?.pathname}`);
  }
  return templateEntry(step.name, { profile: options.clientProfile });
}

/**
 * The same step, taken from a recording instead.
 *
 * Only `protocolTemplates: capture` reaches this, and only so a fresh capture
 * can be replayed against the templates above. The index is a hint and the
 * path is the contract, because indices move whenever the flow gains a
 * request.
 */
function capturedEntryForStep(har, step) {
  const entries = entriesOf(har);
  const entry = entries[step.index];
  const parsed = parseUrl(entry?.request?.url);
  if (entry && parsed?.pathname === step.path) return cloneJson(entry);

  const fallback = entries.find((candidate) => {
    const url = parseUrl(candidate.request?.url);
    return url?.host === 'auth.openai.com' && url.pathname === step.path;
  });
  if (!fallback) throw new Error(`Missing registration step template: ${step.name}`);
  return cloneJson(fallback);
}

function findEntry(har, step, options = {}) {
  return options.useHarTemplates ? capturedEntryForStep(har, step) : templateEntryForStep(step, options);
}

function setJsonBody(entry, body) {
  entry.request.postData = entry.request.postData || {};
  entry.request.postData.text = JSON.stringify(body);
  entry.request.postData.mimeType = entry.request.postData.mimeType || 'application/json';
  const contentType = entry.request.headers.find((header) => header.name.toLowerCase() === 'content-type');
  if (contentType) contentType.value = 'application/json';
}

function bodyForStep(name, current, options) {
  if (name === 'authorize_continue') {
    return { username: { value: options.email, kind: 'email' }, screen_hint: 'signup' };
  }
  if (name === 'user_register') {
    return { password: options.password, username: options.email };
  }
  if (name === 'email_otp_validate') {
    return { code: options.emailCode || '<email_code>' };
  }
  if (name === 'phone_otp_send') {
    return { phone_number: options.phone || '<phone>', channel: options.channel || current.channel || 'sms' };
  }
  if (name === 'phone_otp_validate') {
    return { code: options.phoneCode || '<phone_code>' };
  }
  if (name === 'create_account') {
    return { name: options.name || 'ctf', birthdate: options.birthdate || '2001-01-01' };
  }
  if (name === 'workspace_select') {
    return { workspace_id: options.workspaceId || current.workspace_id || '<workspace_id>' };
  }
  return current;
}

function buildRegistrationPlan(har, options = {}) {
  assertEmail(options.email);
  const normalized = {
    ...options,
    password: options.password || generatedPassword(),
  };
  const redact = options.redact !== false;

  const selectedStep = options.step || null;
  const steps = REGISTRATION_STEPS.filter((step) => !selectedStep || step.name === selectedStep).map((step) => {
    const entry = findEntry(har, step, options);
    const current = tryParseJson(entry.request.postData?.text || '') || {};
    const body = bodyForStep(step.name, current, normalized);
    if (entry.request.method !== 'GET') setJsonBody(entry, body);
    const missing = [];
    if (step.needs === 'email_code' && !options.emailCode) missing.push('email_code');
    if (step.needs === 'phone' && !options.phone) missing.push('phone');
    if (step.needs === 'phone_code' && !options.phoneCode) missing.push('phone_code');
    if (step.needs === 'workspace_id' && !options.workspaceId) missing.push('workspace_id_from_previous_response');

    return {
      name: step.name,
      sourceIndex: step.index,
      method: entry.request.method,
      url: redactUrl(entry.request.url, { redact }),
      missing,
      body: entry.request.method === 'GET' ? null : bodySummary(entry.request.postData, { redact, includeText: true }),
      pureUrl: makePureHttpUrl(entry, step.index, { redact, body: entry.request.postData?.text || '' }),
    };
  });

  return {
    mode: 'pure-url-registration-plan',
    email: redact ? '<redacted:email>' : normalized.email,
    generatedPassword: redact ? '<redacted:password>' : normalized.password,
    executable: steps.every((step) => step.missing.length === 0),
    steps: options.summary
      ? steps.map((step) => ({
        name: step.name,
        sourceIndex: step.sourceIndex,
        method: step.method,
        url: step.url,
        missing: step.missing,
      }))
      : steps,
  };
}

module.exports = {
  // The auth endpoints this flow drives, so the drift report can say which
  // ones a fresh capture has gained or lost without duplicating the list.
  REGISTRATION_STEP_PATHS: [...new Set(REGISTRATION_STEPS.map((step) => step.path))],
  buildRegistrationPlan,
};
