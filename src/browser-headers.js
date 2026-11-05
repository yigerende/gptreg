'use strict';

const { normalizeClientProfile } = require('./client-profile');

/**
 * The request header block a real Firefox sends, derived rather than replayed.
 *
 * The console used to send six headers — user agent, language, accept,
 * referer, origin, content type — while claiming to be Firefox. No browser
 * sends that set: every one of them also sends `Accept-Encoding`, the three
 * `Sec-Fetch-*` metadata headers, and `Upgrade-Insecure-Requests` on
 * navigations. Absence is as much a signal as a wrong value.
 *
 * Replaying a capture's block is not the fix either. It carries that capture's
 * own session — and that capture was taken with devtools open, so every entry
 * in it also carries `Pragma: no-cache` and `Cache-Control: no-cache`, which
 * an ordinary browsing session does not send at all. Deriving the block means
 * it follows the profile and the request instead of one recorded afternoon.
 */

/**
 * The order these go out in, which is fingerprint surface of its own.
 *
 * Firefox's own block, with the auth app's headers where that page puts them:
 * after the content type and the Sentinel envelope, before `Origin`. An object
 * built by assignment carries whatever order the code happened to use, so the
 * order is stated once here rather than implied in a dozen call sites.
 */
const FIREFOX_HEADER_ORDER = Object.freeze([
  'user-agent',
  'accept',
  'accept-language',
  'accept-encoding',
  'referer',
  'content-type',
  'openai-sentinel-token',
  'openai-sentinel-so-token',
  'x-access-flow-invocation-id',
  'x-openai-document-navigation-id',
  'traceparent',
  'tracestate',
  'x-datadog-origin',
  'x-datadog-parent-id',
  'x-datadog-sampling-priority',
  'x-datadog-trace-id',
  'origin',
  'upgrade-insecure-requests',
  'sec-fetch-dest',
  'sec-fetch-mode',
  'sec-fetch-site',
  'sec-fetch-user',
  'priority',
]);

const NAVIGATE_ACCEPT = 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8';
const ACCEPT_ENCODING = 'gzip, deflate, br, zstd';

function origin(value) {
  try {
    return new URL(String(value)).origin;
  } catch {
    return '';
  }
}

function registrableHost(value) {
  try {
    const parts = new URL(String(value)).hostname.split('.');
    return parts.slice(-2).join('.');
  } catch {
    return '';
  }
}

/**
 * The `Sec-Fetch-Site` value the browser would compute.
 *
 * It is a relationship between the initiator and the target, not a constant:
 * hard-coding `same-origin` on a request that crosses to `sentinel.openai.com`
 * states something the URLs themselves contradict.
 *
 * The initiator is the document that made the request, which is not the same
 * thing as the `Referer` header — a script fetch often sends no referer and
 * still reports `same-origin`, because the page it came from has not changed.
 * The drift report caught this against a real capture: every `cdn-cgi` script
 * in it says `same-origin` with no referer at all.
 */
function fetchSite(targetUrl, initiatorUrl) {
  if (!initiatorUrl) return 'none';
  const target = origin(targetUrl);
  const initiator = origin(initiatorUrl);
  if (!target || !initiator) return 'none';
  if (target === initiator) return 'same-origin';
  return registrableHost(targetUrl) === registrableHost(initiatorUrl) ? 'same-site' : 'cross-site';
}

function acceptFor(kind, explicit) {
  if (explicit) return explicit;
  if (kind === 'navigate' || kind === 'iframe') return NAVIGATE_ACCEPT;
  return '*/*';
}

function fetchDest(kind) {
  if (kind === 'navigate') return 'document';
  if (kind === 'iframe') return 'iframe';
  if (kind === 'script') return 'script';
  return 'empty';
}

function fetchMode(kind) {
  if (kind === 'navigate' || kind === 'iframe') return 'navigate';
  if (kind === 'script') return 'no-cors';
  return 'cors';
}

/**
 * Firefox's urgency hints: documents are the critical path, sub-resource
 * fetches sit at the default, and scripts carry none at all.
 */
function priorityFor(kind) {
  if (kind === 'navigate') return 'u=0, i';
  if (kind === 'script') return '';
  return 'u=4';
}

/**
 * Order an object's keys the way the browser emits them.
 *
 * Header order is fingerprint surface of its own, and an object built by
 * assignment carries whatever order the code happened to use.
 */
function ordered(headers) {
  const entries = Object.entries(headers).filter(([, value]) => value !== '' && value !== undefined && value !== null);
  const rank = (name) => {
    const index = FIREFOX_HEADER_ORDER.indexOf(name.toLowerCase());
    return index === -1 ? FIREFOX_HEADER_ORDER.length : index;
  };
  entries.sort((left, right) => rank(left[0]) - rank(right[0]));
  return Object.fromEntries(entries);
}

/**
 * @param {object} profile  the account's client profile.
 * @param {object} request  `url`, `kind` (navigate | fetch | script | iframe),
 *                          `referer`, `origin`, `accept`, `contentType`,
 *                          `initiator` (the document that made the request,
 *                          when it differs from the referer) and
 *                          `userActivated` for a navigation a person began.
 */
function browserHeaders(profile, request = {}) {
  const normalized = normalizeClientProfile(profile);
  const kind = String(request.kind || 'fetch');
  const referer = String(request.referer || '');
  // The referer, when there is one, names the exact document that made the
  // request; `initiator` is the fallback for the fetches that send none.
  const initiator = referer || String(request.initiator || '');

  return ordered({
    'User-Agent': normalized.userAgent,
    Accept: acceptFor(kind, request.accept),
    'Accept-Language': normalized.acceptLanguage,
    'Accept-Encoding': ACCEPT_ENCODING,
    Referer: referer,
    'Content-Type': String(request.contentType || ''),
    Origin: String(request.origin || ''),
    // Any navigation, not only a top-level one: the capture's Sentinel
    // `frame.html` iframe carries it too, which the drift report caught.
    'Upgrade-Insecure-Requests': kind === 'navigate' || kind === 'iframe' ? '1' : '',
    'Sec-Fetch-Dest': fetchDest(kind),
    'Sec-Fetch-Mode': fetchMode(kind),
    'Sec-Fetch-Site': fetchSite(request.url, initiator),
    // `?1` means a person just clicked or typed. A redirect hop and a
    // programmatic navigation carry no activation, and the capture agrees:
    // its redirect-driven `/api/accounts/authorize` navigation has no such
    // header. Claiming activation on every navigation would claim a person
    // was there for hops nobody touched.
    'Sec-Fetch-User': kind === 'navigate' && request.userActivated === true ? '?1' : '',
    Priority: priorityFor(kind),
  });
}

module.exports = {
  browserHeaders,
  // The one place header order is decided, so callers that add their own can
  // be folded back into it rather than appending.
  ordered,
  fetchSite,
};
