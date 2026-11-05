'use strict';

const { bodySummary, entriesOf, getHeader, parseUrl, tryParseJson } = require('./har');
const { makePureHttpUrl } = require('./pure-url');
const { makeUrlizedRequest } = require('./url-chain');
const { assertEmail, cloneJson } = require('./util/shared');

function findRequestTemplate(har, pathname) {
  const entries = entriesOf(har);
  for (const [index, entry] of entries.entries()) {
    const parsed = parseUrl(entry.request.url);
    if (parsed?.host === 'auth.openai.com' && parsed.pathname === pathname && entry.request.method === 'POST') {
      return { entry, index };
    }
  }
  throw new Error(`Missing template request: ${pathname}`);
}

function updateJsonPostBody(entry, update) {
  const cloned = cloneJson(entry);
  const body = tryParseJson(cloned.request.postData?.text || '');
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error(`Template ${cloned.request.url} does not have a JSON object body`);
  }

  const updated = update(body);
  cloned.request.postData = cloned.request.postData || {};
  cloned.request.postData.text = JSON.stringify(updated);

  const contentLength = cloned.request.headers.find((header) => header.name.toLowerCase() === 'content-length');
  if (contentLength) {
    contentLength.value = String(Buffer.byteLength(cloned.request.postData.text));
  }

  return cloned;
}

function accountStartBody(email, screenHint = 'signup') {
  assertEmail(email);
  return {
    username: {
      value: email,
      kind: 'email',
    },
    screen_hint: screenHint,
  };
}

function buildEmailFlow(har, options = {}) {
  const email = options.email;
  const screenHint = options.screenHint || 'signup';
  const redact = options.redact !== false;
  const template = findRequestTemplate(har, '/api/accounts/authorize/continue');
  const request = updateJsonPostBody(template.entry, () => accountStartBody(email, screenHint));
  const sentinelHeader = getHeader(request.request.headers, 'openai-sentinel-token');

  return {
    email: redact ? '<redacted:email>' : email,
    mode: 'offline-template',
    sourceIndex: template.index,
    target: {
      method: request.request.method,
      url: request.request.url,
      contentType: getHeader(request.request.headers, 'content-type') || request.request.postData?.mimeType || '',
      body: bodySummary(request.request.postData, { redact, includeText: true }),
      urlized: makeUrlizedRequest(request, template.index, { redact }),
      pureUrl: makePureHttpUrl(request, template.index, { redact, body: request.request.postData.text }),
    },
    requirements: {
      sentinelHeader: 'openai-sentinel-token',
      hasCapturedTemplateHeader: Boolean(sentinelHeader),
      mustRegenerateForLiveRun: true,
      cookies: ['login_session', 'oai-client-auth-session', 'oai-did', 'oai-sc', 'oaicom-stable-id'],
      nextServerSteps: [
        '/api/accounts/user/register',
        '/api/accounts/email-otp/send',
        '/api/accounts/email-otp/validate',
      ],
    },
  };
}

module.exports = {
  buildEmailFlow,
};
