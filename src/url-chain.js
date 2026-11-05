'use strict';

const {
  base64urlDecode,
  base64urlEncode,
  bodySummary,
  cookieNames,
  entriesOf,
  getHeader,
  headerNames,
  hostCounts,
  parseUrl,
  queryNames,
  redactBody,
  redactUrl,
  responseLocation,
} = require('./har');

const TELEMETRY_PATHS = new Set(['/awe/api/v2/rum', '/ces/v1/rgstr']);

function classifyEntry(entry) {
  const parsed = parseUrl(entry.request?.url);
  if (!parsed) return null;

  const host = parsed.host;
  const pathname = parsed.pathname;

  if (host === 'localhost:1455' && pathname === '/auth/callback') return 'oauth-callback';
  if (host === 'auth.openai.com' && pathname.startsWith('/oauth/')) return 'oauth-entry';
  if (host === 'auth.openai.com' && pathname.startsWith('/api/oauth/')) return 'oauth-api';
  if (host === 'auth.openai.com' && pathname.startsWith('/api/accounts/')) return 'account-api';
  if (host === 'auth.openai.com' && /^\/(log-in|email-verification|phone-verification|create-account)/.test(pathname)) return 'auth-page';
  if (host === 'sentinel.openai.com' && pathname.includes('/sentinel/')) return 'sentinel';
  if (host === 'sentinel.openai.com' && pathname.startsWith('/backend-api/sentinel/')) return 'sentinel';
  if (host === 'chatgpt.com' && pathname === '/ces/v1/rgstr') return 'telemetry';
  if (host === 'auth.openai.com' && pathname === '/awe/api/v2/rum') return 'telemetry';

  return null;
}

function isAuthChainEntry(entry, options = {}) {
  const kind = classifyEntry(entry);
  if (!kind) return false;
  if (kind === 'telemetry') return Boolean(options.includeTelemetry);
  return true;
}

function makeUrlizedRequest(entry, index, options = {}) {
  const redact = options.redact !== false;
  const urlized = new URL(`gpt-re+har://request/${index}`);
  const requestUrl = redactUrl(entry.request.url, { redact });
  const redirect = redactUrl(responseLocation(entry), { redact });
  const contentType = getHeader(entry.request.headers, 'content-type') || entry.request.postData?.mimeType || '';
  const body = entry.request.postData?.text || '';

  urlized.searchParams.set('method', entry.request.method);
  urlized.searchParams.set('status', String(entry.response.status));
  urlized.searchParams.set('url', base64urlEncode(requestUrl));

  if (redirect) {
    urlized.searchParams.set('redirect', base64urlEncode(redirect));
  }

  if (contentType) {
    urlized.searchParams.set('content_type', contentType);
  }

  if (body) {
    urlized.searchParams.set('body', base64urlEncode(redact ? redactBody(body) : body));
  }

  return urlized.toString();
}

function decodeUrlizedRequest(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'gpt-re+har:') {
    throw new Error(`Unsupported urlized request protocol: ${parsed.protocol}`);
  }

  const index = Number(parsed.pathname.replace(/^\//, ''));
  const body = parsed.searchParams.get('body');
  const redirect = parsed.searchParams.get('redirect');

  return {
    index,
    method: parsed.searchParams.get('method') || 'GET',
    status: Number(parsed.searchParams.get('status') || 0),
    url: base64urlDecode(parsed.searchParams.get('url') || ''),
    redirect: redirect ? base64urlDecode(redirect) : '',
    contentType: parsed.searchParams.get('content_type') || '',
    body: body ? base64urlDecode(body) : '',
  };
}

function chainEntry(entry, index, options = {}) {
  const redact = options.redact !== false;
  const kind = classifyEntry(entry) || 'other';
  return {
    index,
    kind,
    startedDateTime: entry.startedDateTime,
    method: entry.request.method,
    status: entry.response.status,
    url: redactUrl(entry.request.url, { redact }),
    redirect: redactUrl(responseLocation(entry), { redact }),
    queryNames: queryNames(entry.request.url),
    requestHeaderNames: headerNames(entry.request.headers),
    requestCookieNames: cookieNames(entry.request.cookies),
    responseCookieNames: cookieNames(entry.response.cookies),
    postData: bodySummary(entry.request.postData, { redact, includeText: options.includeBodyText }),
    urlized: makeUrlizedRequest(entry, index, { redact }),
  };
}

function buildUrlChain(har, options = {}) {
  const entries = entriesOf(har);
  const selected = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => (options.includeAll ? true : isAuthChainEntry(entry, options)));

  return {
    totalEntries: entries.length,
    selectedEntries: selected.length,
    hostCounts: hostCounts(entries),
    includeTelemetry: Boolean(options.includeTelemetry),
    entries: selected.map(({ entry, index }) => chainEntry(entry, index, options)),
  };
}

function buildSummary(har) {
  const entries = entriesOf(har);
  const methods = {};
  const statuses = {};

  for (const entry of entries) {
    methods[entry.request.method] = (methods[entry.request.method] || 0) + 1;
    statuses[entry.response.status] = (statuses[entry.response.status] || 0) + 1;
  }

  const significantKinds = {};
  for (const entry of entries) {
    const kind = classifyEntry(entry);
    if (kind && !TELEMETRY_PATHS.has(parseUrl(entry.request.url)?.pathname)) {
      significantKinds[kind] = (significantKinds[kind] || 0) + 1;
    }
  }

  return {
    totalEntries: entries.length,
    methods,
    statuses,
    hostCounts: hostCounts(entries),
    significantKinds,
  };
}

module.exports = {
  buildSummary,
  buildUrlChain,
  decodeUrlizedRequest,
  makeUrlizedRequest,
};
