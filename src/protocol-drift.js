'use strict';

const { authTelemetryHeaders, tracedRequest } = require('./auth-telemetry');
const { browserHeaders } = require('./browser-headers');
const { FIREFOX_RELEASES, createClientProfile, firefoxUserAgent } = require('./client-profile');
const { entriesOf, getHeader, parseUrl } = require('./har');

/**
 * What a capture says the protocol looks like, against what the code believes.
 *
 * This is the job a HAR is actually good at. It is evidence of one session on
 * one afternoon: it ages with every deploy on the other side, it carries that
 * browser's version and that operator's devtools settings, and replaying it
 * pins every account to one recorded identity. Read as a diff instead, the
 * same file says exactly which of the code's assumptions have expired — and
 * that answer survives being wrong about the rest of it.
 *
 * Nothing here runs during a registration; it exists so a fresh capture can be
 * turned into a short list of things to change.
 */

/** Set by the transport, so never a drift signal in either direction. */
const TRANSPORT_HEADERS = new Set(['cookie', 'content-length', 'host', 'connection', 'te', 'authorization']);

/**
 * Headers whose presence is the contract and whose value is per request.
 *
 * These were ignored outright, which hid the thing worth knowing: the console
 * sent none of them at all. Comparing the values would be meaningless — they
 * are fresh ids on every request — so the report checks that each side emits
 * the header and says nothing about what is in it.
 */
const PER_REQUEST_VALUE_HEADERS = new Set([
  'traceparent',
  'tracestate',
  'x-datadog-origin',
  'x-datadog-parent-id',
  'x-datadog-sampling-priority',
  'x-datadog-trace-id',
  'x-access-flow-invocation-id',
  'x-openai-document-navigation-id',
]);

/** Sent by a capture taken with devtools open; an ordinary session sends neither. */
const DEVTOOLS_HEADERS = new Set(['pragma', 'cache-control']);

const SENTINEL_HEADERS = /^openai-sentinel-/i;

function requestKind(entry, url) {
  const dest = getHeader(entry.request?.headers, 'sec-fetch-dest');
  if (dest === 'document') return 'navigate';
  if (dest === 'iframe') return 'iframe';
  if (dest === 'script') return 'script';
  if (dest) return 'fetch';
  return /\.(?:js|mjs)$/.test(url.pathname) ? 'script' : 'fetch';
}

function capturedUserAgents(entries) {
  const agents = new Map();
  for (const entry of entries) {
    const agent = getHeader(entry.request?.headers, 'user-agent');
    if (agent) agents.set(agent, (agents.get(agent) || 0) + 1);
  }
  return [...agents.entries()].sort((left, right) => right[1] - left[1]).map(([userAgent, count]) => ({ userAgent, count }));
}

function browserDrift(entries) {
  const agents = capturedUserAgents(entries);
  const known = new Set(FIREFOX_RELEASES.map((release) => firefoxUserAgent(release.version)));
  const newest = firefoxUserAgent(FIREFOX_RELEASES[0].version);
  return {
    capturedUserAgents: agents,
    newestInPool: newest,
    // A capture newer than anything the pool can draw means every account is
    // announcing a version nobody runs any more.
    poolIsBehind: agents.length > 0 && !known.has(agents[0].userAgent),
  };
}

function headerDrift(entries, profile) {
  const byEndpoint = new Map();
  // Sub-resources carry no referer, so the page they came from has to be
  // tracked the way a browser tracks it: the last document that was navigated
  // to. Without this every script and beacon in the capture reports a
  // `Sec-Fetch-Site` difference that is the report's own blind spot.
  let documentUrl = '';
  for (const entry of entries) {
    const url = parseUrl(entry.request?.url);
    if (!url) continue;
    const kind = requestKind(entry, url);
    if (kind === 'navigate') documentUrl = entry.request.url;
    if (!/(?:^|\.)openai\.com$/.test(url.hostname)) continue;
    const key = `${entry.request.method} ${url.host}${url.pathname}`;
    if (byEndpoint.has(key)) continue;
    const captured = new Map();
    for (const header of entry.request.headers || []) {
      const name = header.name.toLowerCase();
      if (TRANSPORT_HEADERS.has(name) || SENTINEL_HEADERS.test(name)) continue;
      captured.set(name, header.value);
    }
    const produced = browserHeaders(profile, {
      url: entry.request.url,
      kind,
      referer: getHeader(entry.request.headers, 'referer'),
      initiator: documentUrl,
      origin: getHeader(entry.request.headers, 'origin'),
      accept: getHeader(entry.request.headers, 'accept'),
      contentType: getHeader(entry.request.headers, 'content-type'),
      userActivated: getHeader(entry.request.headers, 'sec-fetch-user') === '?1',
    });
    if (tracedRequest(entry.request.url, kind)) Object.assign(produced, authTelemetryHeaders('drift-report'));
    const producedNames = new Map([...Object.entries(produced)].map(([name, value]) => [name.toLowerCase(), value]));

    const missing = [...captured.keys()].filter((name) => !producedNames.has(name) && !DEVTOOLS_HEADERS.has(name));
    const extra = [...producedNames.keys()].filter((name) => !captured.has(name));
    const different = [...producedNames.entries()]
      .filter(([name, value]) => captured.has(name) && captured.get(name) !== value
        // The profile deliberately differs from the captured browser, and the
        // traced ids are fresh per request; for those the presence checks
        // above are the whole comparison.
        && !PER_REQUEST_VALUE_HEADERS.has(name)
        && !['user-agent', 'accept-language'].includes(name))
      .map(([name, value]) => ({ header: name, captured: captured.get(name), sent: value }));

    if (missing.length || extra.length || different.length) {
      byEndpoint.set(key, { kind, missingFromCode: missing, notInCapture: extra, differentValue: different });
    } else {
      byEndpoint.set(key, { kind, matches: true });
    }
  }
  return Object.fromEntries(byEndpoint);
}

function endpointDrift(entries, knownPaths) {
  const seen = new Set();
  for (const entry of entries) {
    const url = parseUrl(entry.request?.url);
    if (!url || url.host !== 'auth.openai.com' || !url.pathname.startsWith('/api/')) continue;
    seen.add(url.pathname);
  }
  const known = new Set(knownPaths);
  return {
    inCaptureOnly: [...seen].filter((path) => !known.has(path)).sort(),
    inCodeOnly: [...known].filter((path) => !seen.has(path)).sort(),
    shared: [...seen].filter((path) => known.has(path)).sort(),
  };
}

function sentinelDrift(entries) {
  const sdkUrls = new Set();
  const flows = new Set();
  for (const entry of entries) {
    const url = parseUrl(entry.request?.url);
    if (!url || url.host !== 'sentinel.openai.com') continue;
    if (/sdk\.js$/.test(url.pathname)) sdkUrls.add(url.pathname);
    if (url.pathname === '/backend-api/sentinel/req') {
      const body = entry.request?.postData?.text || '';
      const flow = /"flow"\s*:\s*"([a-z_]+)"/.exec(body)?.[1];
      if (flow) flows.add(flow);
    }
  }
  return { sdkPaths: [...sdkUrls].sort(), flows: [...flows].sort() };
}

/**
 * @param {object} har        a parsed capture.
 * @param {object} options    `knownPaths` — the auth endpoints the code drives.
 */
function buildProtocolDrift(har, options = {}) {
  const entries = entriesOf(har);
  const profile = createClientProfile({ seed: options.seed || 'protocol-drift', country: options.country || '' });
  return {
    entries: entries.length,
    browser: browserDrift(entries),
    endpoints: endpointDrift(entries, options.knownPaths || []),
    sentinel: sentinelDrift(entries),
    headers: headerDrift(entries, profile),
  };
}

module.exports = {
  buildProtocolDrift,
};
