'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { buildCloudflareJsdProbe, extractCloudflareParams } = require('./cloudflare-jsd');
const {
  applyBrowserHeaders,
  createFirefox153Profile,
  ensureClientProfile,
  normalizeClientProfile,
  profileFingerprint,
} = require('./client-profile');
const { entriesOf } = require('./har');
const { getHeader, parseUrl, redactUrl, tryParseJson } = require('./http-shape');
const { decodePureHttpUrl, executePureHttpUrl, makePureHttpUrl } = require('./pure-url');
const { buildRegistrationPlan } = require('./registration-flow');
const { browserHeaders } = require('./browser-headers');
const { templateEntry } = require('./protocol-templates');
const { decodeCookieValue } = require('./sentinel');
const { buildEnforcementToken } = require('./sentinel-pow');
const { createSentinelRuntime, sentinelSdkFromHar } = require('./sentinel-runtime');
const { loadSentinelSdk } = require('./sentinel-sdk-loader');
const { createOAuthSession, redactOAuthSession, validateOAuthCallback } = require('./oauth-pkce');
const { cloneJson, deleteHeader } = require('./util/shared');

// Every Sentinel step, declared once. The step arrays below compose these, and
// runSentinelFlow() looks one up by flow when a caller needs a single refresh
// outside a full run — so a flow's HAR template and consumer live in one place.
const SENTINEL_FLOW_STEPS = Object.freeze({
  authorize_continue: { name: 'sentinel_authorize_continue', type: 'sentinel', index: 128, flow: 'authorize_continue', consumerIndex: 137 },
  username_password_create: { name: 'sentinel_username_password_create', type: 'sentinel', index: 142, flow: 'username_password_create', consumerIndex: 146 },
  oauth_create_account: { name: 'sentinel_oauth_create_account', type: 'sentinel', index: 295, flow: 'oauth_create_account', consumerIndex: 299 },
  email_otp_validate: { name: 'sentinel_email_otp_validate', type: 'sentinel', index: 128, flow: 'email_otp_validate', defaultConsumer: true },
  password_verify: { name: 'sentinel_password_verify', type: 'sentinel', index: 128, flow: 'password_verify', defaultConsumer: true },
  password_reset: { name: 'sentinel_password_reset', type: 'sentinel', index: 128, flow: 'password_reset', defaultConsumer: true },
});

function sentinelStep(flow, extra = {}) {
  return Object.freeze({ ...SENTINEL_FLOW_STEPS[flow], ...extra });
}

// The OAuth bootstrap both flows replay before any account work begins.
const BOOTSTRAP_STEPS = Object.freeze([
  { name: 'bootstrap_oauth_authorize', type: 'template', index: 0 },
  { name: 'bootstrap_oauth_auth', type: 'template', index: 1, urlFrom: 'lastLocation' },
  { name: 'bootstrap_accounts_login', type: 'template', index: 2, urlFrom: 'lastLocation' },
  { name: 'bootstrap_log_in_page', type: 'template', index: 3, urlFrom: 'lastLocation' },
  { name: 'cloudflare_jsd', type: 'cloudflareJsd' },
  sentinelStep('authorize_continue'),
].map(Object.freeze));

// The consent / workspace / callback tail both flows share once the session
// holds an account. `sentinel_consent_oauth_create_account` mints no headers —
// it only refreshes the `oai-sc` cookie the consent page expects.
const CONSENT_STEPS = Object.freeze([
  { name: 'consent_data', type: 'template', index: 302, urlFrom: 'lastContinueUrl', urlTransform: 'remix_data' },
  { name: 'sentinel_consent_oauth_create_account', type: 'sentinel', index: 304, flow: 'oauth_create_account' },
  { name: 'workspace_select', type: 'registration', planStep: 'workspace_select', needs: ['workspaceId'] },
  { name: 'oauth_auth_login_verifier', type: 'registration', planStep: 'oauth_auth_login_verifier', urlFrom: 'lastContinueUrl' },
  { name: 'oauth_consent', type: 'registration', planStep: 'oauth_consent', urlFrom: 'lastLocation' },
  { name: 'oauth_auth_consent_verifier', type: 'registration', planStep: 'oauth_auth_consent_verifier', urlFrom: 'lastLocation' },
].map(Object.freeze));

const RUN_STEPS = Object.freeze([
  ...BOOTSTRAP_STEPS,
  { name: 'authorize_continue', type: 'registration', planStep: 'authorize_continue', sentinelFlow: 'authorize_continue' },
  sentinelStep('username_password_create'),
  { name: 'user_register', type: 'registration', planStep: 'user_register', sentinelFlow: 'username_password_create' },
  { name: 'email_otp_send', type: 'registration', planStep: 'email_otp_send' },
  // `email-otp/validate` became a Sentinel consumer after the July capture: the
  // September HAR sends both `openai-sentinel-token` and `openai-sentinel-so-token`
  // on it, and the SDK pre-registers the `email_otp_validate` flow on page load.
  // The challenge only lives for `expire_after` (540s), so this step carries the
  // same `needs` as the validate below it — the runner then blocks here until the
  // code has arrived and mints the challenge immediately before spending it,
  // instead of minting it and then waiting out the mailbox.
  sentinelStep('email_otp_validate', { needs: ['emailCode'] }),
  { name: 'email_otp_validate', type: 'registration', planStep: 'email_otp_validate', needs: ['emailCode'], sentinelFlow: 'email_otp_validate' },
  { name: 'phone_otp_send', type: 'registration', planStep: 'phone_otp_send', needs: ['phone'] },
  { name: 'phone_otp_validate', type: 'registration', planStep: 'phone_otp_validate', needs: ['phoneCode'] },
  sentinelStep('oauth_create_account'),
  { name: 'create_account', type: 'registration', planStep: 'create_account', sentinelFlow: 'oauth_create_account' },
  ...CONSENT_STEPS,
].map(Object.freeze));

const LOGIN_STEPS = Object.freeze([
  ...BOOTSTRAP_STEPS,
  { name: 'login_authorize_continue', type: 'loginAuthorizeContinue', sentinelFlow: 'authorize_continue' },
  sentinelStep('password_verify'),
  { name: 'password_verify', type: 'passwordVerify', needs: ['password'], sentinelFlow: 'password_verify' },
  ...CONSENT_STEPS,
].map(Object.freeze));

// `state.next` is a plain index into RUN_STEPS, so inserting a step renumbers
// every state already persisted on disk. Bump this whenever RUN_STEPS gains or
// loses a step and teach migrateRegistrationState how to move the old index.
const STEP_PLAN_VERSION = 2;
const SENTINEL_EMAIL_OTP_STEP = RUN_STEPS.findIndex((step) => step.name === 'sentinel_email_otp_validate');

function statePathForEmail(email, options = {}) {
  if (options.statePath) return path.resolve(options.statePath);
  if (!email) throw new Error('registration-run requires --email or --state');
  const digest = crypto.createHash('sha256').update(String(email)).digest('hex').slice(0, 12);
  return path.resolve(options.cwd || process.cwd(), '.gpt-re-state', `registration-${digest}.json`);
}

function loginStatePathForEmail(email, options = {}) {
  if (options.statePath) return path.resolve(options.statePath);
  if (!email) throw new Error('oauth-login-run requires --email or --state');
  const digest = crypto.createHash('sha256').update(String(email)).digest('hex').slice(0, 12);
  return path.resolve(options.cwd || process.cwd(), '.gpt-re-state', `oauth-login-${digest}.json`);
}

/**
 * Moves a state written before STEP_PLAN_VERSION onto the current RUN_STEPS
 * numbering. v1 had no `sentinel_email_otp_validate`, so every step after the
 * insertion point shifted down by one. A state parked exactly on the old
 * `email_otp_validate` needs no move: that index now holds the Sentinel step,
 * which blocks on the same `emailCode` and runs immediately before it.
 * Login states use LOGIN_STEPS, which did not change, so they are left alone.
 */
function migrateRegistrationState(state) {
  if (!state || typeof state !== 'object') return state;
  if (state.mode !== 'pure-url-registration-runner') return state;
  if (Number(state.stepPlanVersion || 1) >= STEP_PLAN_VERSION) return state;
  if (Number(state.next || 0) > SENTINEL_EMAIL_OTP_STEP) state.next = Number(state.next) + 1;
  state.stepPlanVersion = STEP_PLAN_VERSION;
  return state;
}

function loadRegistrationState(filePath) {
  return migrateRegistrationState(JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8')));
}

function saveRegistrationState(filePath, state) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(state, null, 2)}\n`);
}

function makeInitialRegistrationState(har, options = {}) {
  const oauth = options.oauth || createOAuthSession(options.oauthOptions || {});
  const clientProfile = normalizeClientProfile(options.clientProfile || {});
  const plan = buildRegistrationPlan(har, {
    email: options.email,
    password: options.password,
    redact: false,
  });

  return {
    mode: 'pure-url-registration-runner',
    stepPlanVersion: STEP_PLAN_VERSION,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    email: options.email,
    password: plan.generatedPassword,
    next: 0,
    cookies: {},
    clientProfile,
    clientProfileFingerprint: profileFingerprint(clientProfile),
    clientIdentity: null,
    sentinelHeaders: {},
    inputs: {
      emailCode: options.emailCode || '',
      phone: options.phone || '',
      phoneCode: options.phoneCode || '',
      workspaceId: options.workspaceId || '',
      channel: options.channel || 'sms',
      name: options.name || 'ctf',
      birthdate: options.birthdate || '2001-01-01',
    },
    lastContinueUrl: '',
    lastLocation: '',
    oauthCode: '',
    oauth,
    cloudflare: {},
    events: [],
  };
}

function makeInitialLoginState(_har, options = {}) {
  if (!options.email) throw new Error('oauth-login-run requires --email');
  const oauth = options.oauth || createOAuthSession(options.oauthOptions || {});
  const clientProfile = normalizeClientProfile(options.clientProfile || {});

  return {
    mode: 'pure-url-oauth-login-runner',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    email: options.email,
    password: options.password || '',
    next: 0,
    cookies: {},
    clientProfile,
    clientProfileFingerprint: profileFingerprint(clientProfile),
    clientIdentity: null,
    sentinelHeaders: {},
    inputs: {
      workspaceId: options.workspaceId || '',
    },
    lastContinueUrl: '',
    lastLocation: '',
    oauthCode: '',
    oauth,
    cloudflare: {},
    events: [],
  };
}

function applyInputOptions(state, options = {}) {
  state.inputs = state.inputs || {};
  const pairs = [
    ['emailCode', options.emailCode],
    ['phone', options.phone],
    ['phoneCode', options.phoneCode],
    ['workspaceId', options.workspaceId],
    ['channel', options.channel],
    ['name', options.name],
    ['birthdate', options.birthdate],
  ];
  for (const [key, value] of pairs) {
    if (value !== undefined && value !== null && value !== '') state.inputs[key] = value;
  }
  if (options.password) state.password = options.password;
  if (options.email) state.email = options.email;
  state.updatedAt = new Date().toISOString();
}

function findEntry(har, index) {
  const entry = entriesOf(har)[index];
  if (!entry) throw new Error(`Missing HAR entry at index ${index}`);
  return cloneJson(entry);
}

function setHeader(headers, name, value) {
  deleteHeader(headers, name);
  headers[name] = value;
}

function currentDid(state) {
  // ChatGPT session checkpoints persist the raw oai-did separately from the
  // derived cookie map.  Falling back to it keeps a security-only recovery
  // from losing the device identity before the next Sentinel request rebuilds
  // the cookie view.
  return decodeCookieValue(state.cookies?.['oai-did'] || state.oaiDid || '');
}

function patchSentinelRequestBody(request, step, state) {
  const body = tryParseJson(request.body) || {};
  if (step.flow) body.flow = step.flow;
  const did = currentDid(state);
  if (did) body.id = did;
  request.body = JSON.stringify(body);
}

/**
 * The request a step makes: from its declared template, or from a recording.
 *
 * The templates are the flow's own description of what it sends. A recording
 * is only opened when an operator asks for one, so a fresh capture can be
 * replayed against them.
 */
function stepEntry(har, step, state = {}, options = {}) {
  if (options.useHarTemplates) return findEntry(har, step.index);
  return templateEntry(step.template || step.name, { profile: state.clientProfile });
}

function makeRequestFromEntry(entry, index, urlOverride = '') {
  if (urlOverride) entry.request.url = urlOverride;
  const request = decodePureHttpUrl(makePureHttpUrl(entry, index, { redact: false }));
  request.cookies = {};
  deleteHeader(request.headers, 'cookie');
  return request;
}

/** Stable identifiers for the two templates the login flow owns. */
const TEMPLATE_INDEXES = Object.freeze({ login_authorize_continue: -801, password_verify: -802 });

function requestFromTemplate(name, index, options = {}) {
  return makeRequestFromEntry(templateEntry(name, { profile: options.profile, url: options.url }), index);
}

function deriveRemixDataUrl(pageUrl, templateUrl) {
  const page = parseUrl(pageUrl);
  if (!page) return pageUrl || '';
  const template = parseUrl(templateUrl);
  if (!page.pathname.endsWith('.data')) page.pathname = `${page.pathname}.data`;
  for (const [key, value] of template?.searchParams || []) {
    page.searchParams.set(key, value);
  }
  return page.toString();
}

function deriveStepUrl(step, state, templateUrl = '') {
  const source = step.urlFrom ? state[step.urlFrom] : '';
  if (!source) return '';
  if (step.urlTransform === 'remix_data') return deriveRemixDataUrl(source, templateUrl);
  return source;
}

function dynamicSentinelEnabled(options = {}) {
  return options.dynamicSentinel !== false;
}

function sentinelPageUrl(har, state, step = {}, options = {}) {
  const consumer = step.consumerIndex === undefined ? null : entriesOf(har)[step.consumerIndex];
  const captured = getHeader(consumer?.request?.headers || [], 'referer');
  const candidates = options.useHarTemplates === false
    ? [state.continueUrl, state.lastContinueUrl, state.lastLocation]
    : [captured, state.lastContinueUrl, state.lastLocation];
  return candidates.find((value) => parseUrl(value)?.host === 'auth.openai.com') || 'https://auth.openai.com/log-in';
}

function sentinelDocumentReferrer(step = {}) {
  if (step.flow === 'authorize_continue') return 'https://chatgpt.com/';
  if (step.flow === 'username_password_create') return 'https://auth.openai.com/email-verification';
  if (step.flow === 'password_verify') return 'https://auth.openai.com/log-in';
  return 'https://auth.openai.com/email-verification';
}

function sentinelRuntimeOptions(har, state, step = {}, options = {}) {
  const profile = ensureClientProfile(state, options.clientProfile);
  return {
    sdkUrl: options.sentinelSdkUrl,
    cookies: state.cookies,
    profile,
    pageUrl: sentinelPageUrl(har, state, step, options),
    referrer: sentinelDocumentReferrer(step),
    behaviorDurationMs: options.sentinelBehaviorDurationMs,
  };
}

async function makeSentinelRuntime(har, state, step = {}, options = {}) {
  if (options.sentinelRuntime) return options.sentinelRuntime;
  const runtimeStep = step.flow && SENTINEL_FLOW_STEPS[step.flow]
    ? SENTINEL_FLOW_STEPS[step.flow]
    : step;
  const harSdk = sentinelSdkFromHar(har, { optional: options.useHarTemplates === false });
  const sdk = await loadSentinelSdk(harSdk, state, {
    executor: options.sentinelExecutor,
    proxy: options.proxy,
    source: options.sentinelSdkSource,
    url: options.sentinelSdkUrl,
    live: options.liveSentinelSdk !== false,
    cacheTtlMs: options.sentinelSdkCacheTtlMs,
    allowHarFallback: options.allowHarSentinelSdkFallback !== false,
    pin: !options.dryRun,
  });
  return createSentinelRuntime(sdk.source, {
    ...sentinelRuntimeOptions(har, state, runtimeStep, options),
    sdkUrl: options.sentinelSdkUrl || sdk.url,
  });
}

function disposeSentinelRuntime(runtime, options = {}) {
  if (!options.sentinelRuntime && typeof runtime?.dispose === 'function') runtime.dispose();
}

function hashBinding(value) {
  return value ? crypto.createHash('sha256').update(String(value)).digest('hex') : '';
}

function sentinelIdentityFor(state, proxy = '', clientProfile) {
  const profile = ensureClientProfile(state, clientProfile);
  const current = {
    profile: profileFingerprint(profile),
    did: currentDid(state),
    proxy: hashBinding(proxy || ''),
  };
  if (!current.did) {
    const error = new Error('Sentinel requires the current Firefox session oai-did cookie');
    error.code = 'SENTINEL_DEVICE_ID_MISSING';
    throw error;
  }
  return current;
}

function assertSentinelContinuity(state, options = {}) {
  const current = sentinelIdentityFor(state, options.proxy || '', options.clientProfile);
  const previous = state.clientIdentity;
  if (previous) {
    for (const key of ['profile', 'did', 'proxy']) {
      if (String(previous[key] || '') !== String(current[key] || '')) {
        const error = new Error(`Firefox client identity changed within the same runner at ${key}`);
        error.code = key === 'proxy'
          ? 'SENTINEL_PROXY_IDENTITY_CHANGED'
          : 'SENTINEL_CLIENT_IDENTITY_CHANGED';
        error.identityField = key;
        // A proxy change can be recovered at the verified-security boundary;
        // a device or browser-profile change must remain a hard failure.
        error.retryable = key === 'proxy';
        error.category = key === 'proxy' ? 'transient' : 'identity';
        throw error;
      }
    }
  } else {
    state.clientIdentity = current;
  }
  return current;
}

/**
 * Rebind only the proxy component of a verified Sentinel identity.
 *
 * A worker may have to rotate a dead proxy while retrying optional security
 * setup after the account session is already verified.  Reusing the old
 * Sentinel envelopes in that situation is invalid; the caller must explicitly
 * invoke this boundary helper before requesting fresh proofs.
 */
function rebindSentinelProxy(state, proxy = '', options = {}) {
  const current = sentinelIdentityFor(state, proxy, options.clientProfile);
  const previous = state.clientIdentity ? { ...state.clientIdentity } : null;
  if (previous) {
    for (const key of ['profile', 'did']) {
      if (String(previous[key] || '') !== String(current[key] || '')) {
        const error = new Error(`Firefox client identity changed within the same runner at ${key}`);
        error.code = 'SENTINEL_CLIENT_IDENTITY_CHANGED';
        error.identityField = key;
        error.retryable = false;
        error.category = 'identity';
        throw error;
      }
    }
  }

  const changed = !previous || String(previous.proxy || '') !== String(current.proxy || '');
  state.clientIdentity = current;
  if (changed && options.clearProofs !== false) {
    // Proofs and consumer envelopes are bound to the old proxy/device pair.
    state.sentinelHeaders = {};
    state.sentinelRequestProofs = {};
  }
  return { changed, previous, current };
}

async function patchDynamicSentinelRequest(har, request, step, state, options = {}) {
  if (!dynamicSentinelEnabled(options)) return;
  assertSentinelContinuity(state, options);
  const runtime = options.sentinelRuntime || await makeSentinelRuntime(har, state, step, options);
  try {
    const proof = await runtime.getRequirementsToken(step.flow);
    const body = tryParseJson(request.body) || {};
    body.p = proof;
    request.body = JSON.stringify(body);
    state.sentinelRequestProofs = state.sentinelRequestProofs || {};
    state.sentinelRequestProofs[step.flow] = proof;
  } finally {
    if (!options.sentinelRuntime) disposeSentinelRuntime(runtime, options);
  }
}

function registrationOptionsFromState(state, stepName) {
  const inputs = state.inputs || {};
  return {
    email: state.email,
    password: state.password,
    emailCode: inputs.emailCode,
    phone: inputs.phone,
    phoneCode: inputs.phoneCode,
    channel: inputs.channel,
    name: inputs.name,
    birthdate: inputs.birthdate,
    workspaceId: inputs.workspaceId,
    step: stepName,
    redact: false,
  };
}

function makeRegistrationRequest(har, step, state, options = {}) {
  const plan = buildRegistrationPlan(har, {
    ...registrationOptionsFromState(state, step.planStep),
    useHarTemplates: options.useHarTemplates === true,
    clientProfile: state.clientProfile,
  });
  if (plan.steps.length !== 1) throw new Error(`Expected one plan step for ${step.planStep}`);
  const request = decodePureHttpUrl(plan.steps[0].pureUrl);
  request.cookies = {};
  deleteHeader(request.headers, 'cookie');

  if (step.urlFrom && state[step.urlFrom]) {
    request.url = state[step.urlFrom];
  }

  if (step.sentinelFlow) {
    applySentinelHeaders(request, step, state);
  } else {
    deleteHeader(request.headers, 'openai-sentinel-token');
    deleteHeader(request.headers, 'openai-sentinel-so-token');
  }

  return request;
}

function applySentinelHeaders(request, step, state) {
  const headers = state.sentinelHeaders?.[step.sentinelFlow];
  if (!headers) throw new Error(`Missing Sentinel headers for flow ${step.sentinelFlow}`);
  deleteHeader(request.headers, 'openai-sentinel-token');
  deleteHeader(request.headers, 'openai-sentinel-so-token');
  for (const [name, value] of Object.entries(headers)) setHeader(request.headers, name, value);
}

/**
 * A JSON POST the login flow makes, from its own template.
 *
 * These used to borrow the registration entries' header blocks — index 137 for
 * the authorize continue, 146 for the password verify — and then overwrite the
 * method, URL, referer and content type, which left the two requests
 * describing themselves as pages they were never sent from. They are their own
 * templates now, with the sign-in pages they actually come from.
 */
function makeJsonPostRequest(name, state, options = {}) {
  const template = TEMPLATE_INDEXES[name];
  const request = requestFromTemplate(name, template, { profile: state.clientProfile, url: options.url });
  request.body = JSON.stringify(options.body || {});
  request.contentType = 'application/json';
  deleteHeader(request.headers, 'openai-sentinel-token');
  deleteHeader(request.headers, 'openai-sentinel-so-token');
  return request;
}

function makeLoginAuthorizeContinueRequest(har, step, state) {
  const request = makeJsonPostRequest('login_authorize_continue', state, {
    body: { username: { value: state.email, kind: 'email' } },
  });
  applySentinelHeaders(request, step, state);
  return request;
}

function makePasswordVerifyRequest(har, step, state) {
  const request = makeJsonPostRequest('password_verify', state, {
    body: { password: state.password || '' },
  });
  applySentinelHeaders(request, step, state);
  return request;
}

function makeSentinelConsumerHeaders(har, consumerIndex, sentinelResponse, options = {}) {
  if (!sentinelResponse || typeof sentinelResponse !== 'object') {
    throw new Error('Sentinel response must be an object');
  }
  if (!sentinelResponse.token) {
    throw new Error('Sentinel response is missing token');
  }

  const consumer = entriesOf(har)[consumerIndex];
  if (!consumer) throw new Error(`Missing Sentinel consumer at index ${consumerIndex}`);
  const id = options.id ? decodeCookieValue(options.id) : '';
  const proof = options.computeProof ? buildEnforcementToken(sentinelResponse, options.proofOptions) : null;
  const out = {};

  for (const header of consumer.request.headers || []) {
    if (!/^openai-sentinel-/i.test(header.name)) continue;
    const envelope = JSON.parse(header.value);
    if (proof && Object.hasOwn(envelope, 'p')) envelope.p = proof;
    if (Object.hasOwn(envelope, 'c')) envelope.c = sentinelResponse.token;
    if (id && Object.hasOwn(envelope, 'id')) envelope.id = id;
    out[header.name] = JSON.stringify(envelope);
  }

  return out;
}

function makeDefaultSentinelConsumerHeaders(sentinelResponse, options = {}) {
  if (!sentinelResponse?.token) throw new Error('Sentinel response is missing token');
  const id = options.id ? decodeCookieValue(options.id) : '';
  const proof = options.computeProof ? buildEnforcementToken(sentinelResponse, options.proofOptions) : null;
  const envelope = {
    p: proof || '',
    t: sentinelResponse.turnstile || '',
    c: sentinelResponse.token,
    id,
    flow: options.flow,
  };
  return { 'openai-sentinel-token': JSON.stringify(envelope) };
}

/**
 * Consumer headers for a Sentinel-protected request.
 *
 * The live SDK mints the whole envelope, so the result no longer depends on the
 * captured HAR at all — the same builder serves steps that have a consumer
 * sample in the capture and steps that do not. The SO token rides along only
 * when the challenge asked for one.
 */
async function makeDynamicSentinelHeaders(sentinelResponse, options = {}) {
  if (!sentinelResponse?.token) throw new Error('Sentinel response is missing token');
  if (!options.runtime) throw new Error('Dynamic Sentinel consumer headers require a runtime');
  const generated = await options.runtime.getChallengeTokens(options.flow, sentinelResponse, options.requestProof, {
    id: options.id ? decodeCookieValue(options.id) : '',
    behaviorDurationMs: options.behaviorDurationMs,
  });
  const headers = { 'openai-sentinel-token': generated.token };
  if (sentinelResponse.so?.required) headers['openai-sentinel-so-token'] = generated.soToken;
  return headers;
}

/**
 * The offline counterpart, used by `--static_sentinel` and by tests that do not
 * want to boot the SDK sandbox. It never produces an SO token: do not rely on
 * it against live endpoints that answer `so.required`.
 *
 * The consumer sample in a recording only supplies the envelope's key set, and
 * `makeDefaultSentinelConsumerHeaders` knows that shape already — so a run
 * built from the live templates mints the same envelope without opening a
 * capture, instead of failing on a missing entry.
 */
function makeStaticSentinelHeaders(har, step, sentinelResponse, options = {}) {
  const sample = step.consumerIndex === undefined || options.useHarTemplates === false
    ? null
    : entriesOf(har)[step.consumerIndex];
  return sample
    ? makeSentinelConsumerHeaders(har, step.consumerIndex, sentinelResponse, { id: options.id, computeProof: true })
    : makeDefaultSentinelConsumerHeaders(sentinelResponse, { flow: step.flow, id: options.id, computeProof: true });
}

/**
 * Runs `use` against a Sentinel runtime: the caller's when it owns one (so a
 * whole step shares a single sandbox and identity), otherwise a private one
 * that is disposed on the way out.
 */
async function withSentinelRuntime(har, state, step, options, use) {
  if (options.sentinelRuntime) return use(options.sentinelRuntime);
  const runtime = await makeSentinelRuntime(har, state, step, options);
  try {
    return await use(runtime);
  } finally {
    disposeSentinelRuntime(runtime, options);
  }
}

function missingForStep(step, state) {
  const inputs = state.inputs || {};
  const missing = [];
  for (const key of step.needs || []) {
    const value = key === 'password' ? state.password : inputs[key];
    if (!value) missing.push(key === 'workspaceId' ? 'workspace_id_from_previous_response' : key);
  }
  if (step.urlFrom && !state[step.urlFrom]) missing.push(step.urlFrom);
  if (step.type === 'cloudflareJsd' && !state.cloudflare?.params) missing.push('cloudflare_params_from_login_page');
  return missing;
}

function stepRequest(har, step, state, options = {}) {
  if (step.type === 'template') {
    const entry = stepEntry(har, step, state, options);
    const urlOverride = step.name === 'bootstrap_oauth_authorize'
      ? state.oauth?.authorizeUrl || ''
      : deriveStepUrl(step, state, entry.request?.url || '');
    return makeRequestFromEntry(entry, step.index, urlOverride);
  }
  if (step.type === 'sentinel') {
    // One builder for the Sentinel POST either way: the live one is the
    // contract, the recorded one exists only to be compared against it.
    const request = options.useHarTemplates
      ? makeRequestFromEntry(findEntry(har, step.index), step.index)
      : makeLiveSentinelRequest(step, state);
    patchSentinelRequestBody(request, step, state);
    return request;
  }
  if (step.type === 'registration') {
    return makeRegistrationRequest(har, step, state, options);
  }
  if (step.type === 'loginAuthorizeContinue') {
    return makeLoginAuthorizeContinueRequest(har, step, state);
  }
  if (step.type === 'passwordVerify') {
    return makePasswordVerifyRequest(har, step, state);
  }
  throw new Error(`Unsupported registration runner step type: ${step.type}`);
}

function tryParseResponseJson(result) {
  return tryParseJson(result.response?.text || '') || {};
}

function baseBrowserHeaders(profile, referer = 'https://auth.openai.com/log-in') {
  const normalized = profile || createFirefox153Profile();
  return {
    'User-Agent': normalized.userAgent,
    Accept: '*/*',
    'Accept-Language': normalized.acceptLanguage,
    Referer: referer,
  };
}

async function runCloudflareJsdStep(state, options = {}) {
  const profile = ensureClientProfile(state, options.clientProfile);
  const synthetic = {
    index: -44,
    method: 'POST',
    url: 'https://auth.openai.com/cdn-cgi/challenge-platform/h/g/jsd/oneshot',
    headers: baseBrowserHeaders(profile),
    cookies: {},
    body: '',
    contentType: 'text/plain;charset=UTF-8',
  };
  if (options.executor) return options.executor(synthetic, { name: 'cloudflare_jsd', type: 'cloudflareJsd' }, state);

  const first = await executePureHttpUrl({
    index: -42,
    method: 'GET',
    url: 'https://auth.openai.com/cdn-cgi/challenge-platform/scripts/jsd/main.js',
    headers: baseBrowserHeaders(profile),
    cookies: {},
    body: '',
    contentType: '',
  }, { cookies: state.cookies, proxy: options.proxy });
  state.cookies = first.cookies;

  const scriptUrl = first.response.location.startsWith('/')
    ? `https://auth.openai.com${first.response.location}`
    : first.response.location;
  if (!scriptUrl) throw new Error('Cloudflare JSD redirect did not provide script URL');

  const second = await executePureHttpUrl({
    index: -43,
    method: 'GET',
    url: scriptUrl,
    headers: baseBrowserHeaders(profile),
    cookies: {},
    body: '',
    contentType: '',
  }, { cookies: state.cookies, proxy: options.proxy });
  state.cookies = second.cookies;

  const probeRequest = await buildCloudflareJsdProbe(second.response.text, {
    params: state.cloudflare.params,
    scriptUrl,
    cookies: state.cookies,
    userAgent: profile.userAgent,
    language: profile.language,
    languages: profile.languages,
    acceptLanguage: profile.acceptLanguage,
    platform: profile.platform,
    hardwareConcurrency: profile.hardwareConcurrency,
    maxTouchPoints: profile.maxTouchPoints,
    screen: profile.screen,
  });
  applyBrowserHeaders(probeRequest, profile);
  state.cloudflare.scriptUrl = scriptUrl;
  state.cloudflare.oneshotUrl = probeRequest.url;

  return executePureHttpUrl(probeRequest, { cookies: state.cookies, proxy: options.proxy });
}

function extractWorkspaceId(json) {
  const workspaces = json?.['oai-client-auth-session']?.workspaces;
  if (Array.isArray(workspaces) && workspaces[0]?.id) return workspaces[0].id;
  return '';
}

function extractOAuthCode(location) {
  const parsed = parseUrl(location);
  return parsed?.searchParams.get('code') || '';
}

async function applyStepResult(har, step, state, result, options = {}) {
  state.cookies = result.cookies || state.cookies || {};
  const json = tryParseResponseJson(result);
  const continueUrl = typeof json.continue_url === 'string' ? json.continue_url : '';
  const location = result.response?.location || '';

  if (continueUrl) state.lastContinueUrl = continueUrl;
  if (location) state.lastLocation = location;

  if (step.name === 'bootstrap_log_in_page') {
    const params = extractCloudflareParams(result.response.text);
    if (params) {
      state.cloudflare = state.cloudflare || {};
      state.cloudflare.params = params;
    }
  }

  const workspaceId = extractWorkspaceId(json);
  if (workspaceId && !state.inputs.workspaceId) state.inputs.workspaceId = workspaceId;

  const isSuccessfulOAuthCallback = step.name === 'oauth_auth_consent_verifier'
    && Number(result.response?.status || 0) >= 200
    && Number(result.response?.status || 0) < 400;
  const code = extractOAuthCode(location);
  if (isSuccessfulOAuthCallback) {
    state.oauthCode = '';
    const callback = validateOAuthCallback(state.oauth, location);
    state.oauthCode = callback.code;
    state.oauth = {
      ...(state.oauth || {}),
      code: callback.code,
      callback,
      callbackUrl: location,
      completedAt: new Date().toISOString(),
    };
  } else if (code) {
    const callback = validateOAuthCallback(state.oauth, location);
    state.oauthCode = callback.code;
    state.oauth = {
      ...(state.oauth || {}),
      code: callback.code,
      callback,
      callbackUrl: location,
      completedAt: new Date().toISOString(),
    };
  }

  if (step.type === 'sentinel') {
    state.sentinelHeaders = state.sentinelHeaders || {};
    if (json.token) state.cookies['oai-sc'] = `0${json.token}`;
    // A Sentinel step either mints headers for a following request or only
    // refreshes the `oai-sc` cookie (the consent re-registration does the latter).
    if (step.consumerIndex !== undefined || step.defaultConsumer) {
      const id = currentDid(state);
      state.sentinelHeaders[step.flow] = dynamicSentinelEnabled(options)
        ? await withSentinelRuntime(har, state, step, options, (runtime) => makeDynamicSentinelHeaders(json, {
          flow: step.flow,
          id,
          requestProof: state.sentinelRequestProofs?.[step.flow],
          runtime,
          behaviorDurationMs: options.sentinelBehaviorDurationMs,
        }))
        : makeStaticSentinelHeaders(har, step, json, { id, useHarTemplates: options.useHarTemplates });
    }
  }

  state.events.push({
    step: step.name,
    status: result.response.status,
    url: result.request.url,
    location,
    retryAfterMs: Number(result.response?.retryAfterMs || 0),
    responseJsonKeys: Object.keys(json),
    textPreview: result.response.text.slice(0, 300),
    textLength: result.response.text.length,
  });
}

async function runStepsFlow(har, state, steps, options = {}) {
  applyInputOptions(state, options);
  const clientProfile = ensureClientProfile(state, options.clientProfile);
  const executor = options.executor || ((request) => executePureHttpUrl(request, {
    cookies: state.cookies,
    proxy: options.proxy,
  }));
  const executionOptions = {
    ...options,
    sentinelExecutor: options.sentinelExecutor || executor,
    liveSentinelSdk: options.dryRun ? false : options.liveSentinelSdk,
  };
  state.blocked = null;

  while (state.next < steps.length) {
    const step = steps[state.next];
    if (step.type === 'cloudflareJsd' && !options.cloudflareJsd) {
      state.next += 1;
      continue;
    }
    const missing = missingForStep(step, state);
    if (missing.length) {
      state.blocked = { step: step.name, missing };
      break;
    }

    const request = step.type === 'cloudflareJsd' ? null : stepRequest(har, step, state, executionOptions);
    if (request) applyBrowserHeaders(request, clientProfile);
    const ownsSentinelRuntime = request
      && step.type === 'sentinel'
      && dynamicSentinelEnabled(executionOptions)
      && !executionOptions.sentinelRuntime;
    const sentinelRuntime = ownsSentinelRuntime
      ? await makeSentinelRuntime(har, state, step, executionOptions)
      : executionOptions.sentinelRuntime;
    const stepOptions = sentinelRuntime
      ? { ...executionOptions, sentinelRuntime }
      : executionOptions;

    try {
      if (request && step.type === 'sentinel') {
        if (typeof sentinelRuntime?.setPageContext === 'function') {
          sentinelRuntime.setPageContext({
            pageUrl: sentinelPageUrl(har, state, step),
            referrer: sentinelDocumentReferrer(step),
          });
        }
        await patchDynamicSentinelRequest(har, request, step, state, stepOptions);
      }
      if (options.dryRun) {
        state.blocked = {
          step: step.name,
          missing: ['dry_run'],
          pureUrl: request ? makeDryRunPureUrl(request) : '',
        };
        break;
      }

      state.effectSequence = Number(state.effectSequence || 0) + 1;
      state.inFlight = {
        id: `${state.mode}:${state.next}:${state.effectSequence}`,
        step: step.name,
        index: state.next,
        startedAt: new Date().toISOString(),
        request: request ? { method: request.method, url: request.url } : null,
      };
      if (options.onStepIntent) await options.onStepIntent(state, step, state.inFlight);

      const result = step.type === 'cloudflareJsd'
        ? await runCloudflareJsdStep(state, { ...options, executor: options.executor })
        : await executor(request, step, state);
      await applyStepResult(har, step, state, result, stepOptions);
      if (result.response.status >= 400) {
        state.blocked = { step: step.name, missing: [`http_${result.response.status}`] };
      } else {
        state.next += 1;
      }
      state.lastEffect = {
        id: state.inFlight.id,
        step: step.name,
        finishedAt: new Date().toISOString(),
        status: result.response.status,
      };
      state.inFlight = null;
      if (options.onStepResult) await options.onStepResult(state, step, result);
      if (state.blocked) break;
      if (options.once) break;
    } finally {
      if (ownsSentinelRuntime) disposeSentinelRuntime(sentinelRuntime, executionOptions);
    }
  }

  state.updatedAt = new Date().toISOString();
  if (state.next >= steps.length && !state.blocked) state.complete = true;
  return state;
}

async function runSentinelFlow(har, state, flow, options = {}) {
  const template = SENTINEL_FLOW_STEPS[flow];
  if (!template) throw new Error(`Unsupported Sentinel flow: ${flow}`);
  const step = { ...template };
  const clientProfile = ensureClientProfile(state, options.clientProfile);
  const executor = options.executor || ((request) => executePureHttpUrl(request, {
    cookies: state.cookies,
    proxy: options.proxy,
  }));
  const executionOptions = {
    ...options,
    sentinelExecutor: options.sentinelExecutor || executor,
    liveSentinelSdk: options.liveSentinelSdk,
  };
  const ownsSentinelRuntime = dynamicSentinelEnabled(executionOptions) && !executionOptions.sentinelRuntime;
  const sentinelRuntime = ownsSentinelRuntime
    ? await makeSentinelRuntime(har, state, step, executionOptions)
    : executionOptions.sentinelRuntime;
  const stepOptions = sentinelRuntime
    ? { ...executionOptions, sentinelRuntime }
    : executionOptions;
  try {
    const request = stepRequest(har, step, state, executionOptions);
    applyBrowserHeaders(request, clientProfile);
    if (typeof sentinelRuntime?.setPageContext === 'function') {
      sentinelRuntime.setPageContext({
        pageUrl: sentinelPageUrl(har, state, step, executionOptions),
        referrer: sentinelDocumentReferrer(step),
      });
    }
    await patchDynamicSentinelRequest(har, request, step, state, stepOptions);
    const result = await executor(request, step, state);
    await applyStepResult(har, step, state, result, stepOptions);
    if (Number(result.response?.status || 0) >= 400) {
      const error = new Error(`Sentinel ${flow} failed with HTTP ${result.response.status}`);
      error.code = 'SENTINEL_FLOW_FAILED';
      error.status = result.response.status;
      throw error;
    }
    return {
      headers: { ...(state.sentinelHeaders?.[flow] || {}) },
      response: result,
    };
  } finally {
    if (ownsSentinelRuntime) disposeSentinelRuntime(sentinelRuntime, executionOptions);
  }
}

function makeLiveSentinelRequest(step, state) {
  const base = 'https://sentinel.openai.com';
  const frame = new URL('/backend-api/sentinel/frame.html', base);
  const version = parseUrl(state.sentinelSdk?.url)?.pathname.match(/^\/sentinel\/([^/]+)\/sdk\.js$/)?.[1];
  if (version) frame.searchParams.set('sv', version);
  return {
    index: step.index,
    method: 'POST',
    url: `${base}/backend-api/sentinel/req`,
    // Built by the same header builder as every other request, so the Sentinel
    // POST carries the account's own browser rather than a hand-written subset
    // that has to be topped up afterwards.
    headers: browserHeaders(state.clientProfile || {}, {
      url: `${base}/backend-api/sentinel/req`,
      kind: 'fetch',
      referer: frame.toString(),
      origin: base,
      accept: '*/*',
      contentType: 'text/plain;charset=UTF-8',
    }),
    cookies: {},
    body: JSON.stringify({ p: '', id: currentDid(state), flow: step.flow }),
    contentType: 'text/plain;charset=UTF-8',
  };
}

async function runRegistrationFlow(har, state, options = {}) {
  return runStepsFlow(har, state, RUN_STEPS, options);
}

async function runLoginFlow(har, state, options = {}) {
  return runStepsFlow(har, state, LOGIN_STEPS, options);
}

function makeDryRunPureUrl(request) {
  const url = new URL(`gpt-re+http://request/${request.index}`);
  const payload = Buffer.from(JSON.stringify(request), 'utf8').toString('base64url');
  url.searchParams.set('r', payload);
  return url.toString();
}

function stepName(state, steps = RUN_STEPS) {
  return steps[state.next]?.name || null;
}

function hostPath(value) {
  const parsed = parseUrl(value);
  return parsed ? `${parsed.host}${parsed.pathname}` : value || '';
}

function summarizeRegistrationState(state, options = {}) {
  const redact = options.redact !== false;
  const steps = options.steps || RUN_STEPS;
  return {
    mode: state.mode,
    email: redact ? '<redacted:email>' : state.email,
    password: redact ? '<redacted:password>' : state.password,
    nextStep: stepName(state, steps),
    complete: Boolean(state.complete),
    blocked: state.blocked
      ? {
        step: state.blocked.step,
        missing: state.blocked.missing,
        pureUrl: redact ? undefined : state.blocked.pureUrl,
      }
      : null,
    cookieNames: Object.keys(state.cookies || {}).sort(),
    clientProfile: state.clientProfile
      ? {
        browser: state.clientProfile.browser,
        version: state.clientProfile.browserVersion,
        userAgent: state.clientProfile.userAgent,
        fingerprint: state.clientProfileFingerprint,
        identityLocked: Boolean(state.clientIdentity),
      }
      : null,
    sentinelSdk: state.sentinelSdk
      ? {
        url: state.sentinelSdk.url,
        sha256: state.sentinelSdk.sha256,
        origin: state.sentinelSdk.origin,
        error: state.sentinelSdk.error || '',
      }
      : null,
    sentinelFlows: Object.keys(state.sentinelHeaders || {}).sort(),
    workspaceId: state.inputs?.workspaceId ? (redact ? '<redacted:workspace_id>' : state.inputs.workspaceId) : '',
    oauthCode: state.oauthCode ? (redact ? '<redacted:oauth_code>' : state.oauthCode) : '',
    oauth: state.oauth ? redactOAuthSession(state.oauth, { redact }) : null,
    events: (state.events || []).map((event) => ({
      step: event.step,
      status: event.status,
      url: redact ? hostPath(event.url) : event.url,
      location: redact ? redactUrl(event.location, { redact }) : event.location,
      responseJsonKeys: event.responseJsonKeys,
      textPreview: redact && event.textPreview ? '<redacted:text_preview>' : event.textPreview,
      textLength: event.textLength,
    })),
  };
}

module.exports = {
  LOGIN_STEPS,
  RUN_STEPS,
  // Exported so a test can build every step's request without standing up a
  // run — the point being that none of them needs a capture any more.
  stepRequest,
  STEP_PLAN_VERSION,
  migrateRegistrationState,
  loginStatePathForEmail,
  loadRegistrationState,
  makeInitialLoginState,
  makeInitialRegistrationState,
  makeSentinelRuntime,
  makeSentinelConsumerHeaders,
  rebindSentinelProxy,
  runLoginFlow,
  runRegistrationFlow,
  runSentinelFlow,
  saveRegistrationState,
  statePathForEmail,
  summarizeRegistrationState,
  disposeSentinelRuntime,
};
