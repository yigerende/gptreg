'use strict';

const crypto = require('node:crypto');

const { createCookieJar, serializeCookieJar } = require('./cookie-jar');
const { applyBrowserHeaders, normalizeClientProfile } = require('./client-profile');
const { authTelemetryHeaders, tracedRequest } = require('./auth-telemetry');
const { browserHeaders, ordered } = require('./browser-headers');
const { executePureHttpUrl } = require('./pure-url');

function lowerHeader(headers, name) {
  const target = String(name).toLowerCase();
  const key = Object.keys(headers || {}).find((candidate) => candidate.toLowerCase() === target);
  return key ? headers[key] : '';
}

function setHeader(headers, name, value) {
  const target = String(name).toLowerCase();
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === target);
  if (key && key !== name) delete headers[key];
  headers[name] = value;
}

/**
 * The body and its content type, settled before the headers are built.
 *
 * The header block now depends on the content type — a browser orders
 * `Content-Type` among the rest rather than appending it — so the body can no
 * longer be decided after the headers exist.
 */
function requestBody(options = {}) {
  if (options.json !== undefined) return { text: JSON.stringify(options.json), contentType: 'application/json' };
  if (options.form !== undefined) {
    return { text: new URLSearchParams(options.form).toString(), contentType: 'application/x-www-form-urlencoded' };
  }
  if (options.body !== undefined) {
    return { text: String(options.body), contentType: String(options.contentType || lowerHeader(options.headers, 'content-type') || '') };
  }
  return { text: '', contentType: '' };
}

/**
 * Whether this request would carry an `Origin` header in a browser.
 *
 * Fetch sets it for anything that is not a GET or a HEAD, and for a
 * cross-origin request of any method — a same-origin GET gets none. The
 * capture agrees without ambiguity: of its GET fetches, seventy carry no
 * `Origin` and the only five that do are cross-origin. Sending it anyway on
 * `/backend-api/me`, `/backend-api/wham/usage` and `/api/auth/session` marked
 * three requests per session as something no browser produces.
 */
function sendsOrigin(method, url, origin) {
  if (!origin) return false;
  if (!['GET', 'HEAD'].includes(String(method).toUpperCase())) return true;
  try {
    return new URL(String(url)).origin !== new URL(String(origin)).origin;
  } catch {
    return true;
  }
}

function responseJson(result) {
  try { return JSON.parse(result?.response?.text || ''); } catch { return {}; }
}

function redirectMethod(method, status) {
  if (status === 303) return 'GET';
  if ((status === 301 || status === 302) && method === 'POST') return 'GET';
  return method;
}

class UrlSession {
  constructor(options = {}) {
    this.cookieJar = createCookieJar(options.cookieJar || options.cookies);
    this.profile = normalizeClientProfile(options.clientProfile || {});
    // `firefox` derives the full block a browser sends; `minimal` keeps the
    // six headers this session has always sent. The switch exists because the
    // full block changes every request on a flow that currently works, and
    // that is worth a canary rather than a flag day.
    this.browserHeaders = options.browserHeaders === 'firefox';
    // The document the page is currently on. `Sec-Fetch-Site` is computed
    // against this rather than against the Referer header, because a script or
    // beacon fetch sends no referer and is still same-origin with its page.
    this.documentUrl = String(options.documentUrl || '');
    // Replaced by a real document load, not by the auth app's client-side
    // route changes — which is why two requests from one loaded page share it
    // in the capture and a request after a navigation does not.
    this.navigationId = crypto.randomUUID();
    this.proxy = options.proxy || '';
    this.signal = options.signal;
    this.executor = options.executor || executePureHttpUrl;
    this.events = [];
  }

  serializeCookies() {
    return serializeCookieJar(this.cookieJar);
  }

  async executeRequest(request, options = {}) {
    const result = await this.executor(request, {
      cookieJar: this.serializeCookies(),
      proxy: options.proxy ?? this.proxy,
      signal: options.signal || this.signal,
      timeoutMs: options.timeoutMs,
    });
    if (result.cookieJar) this.cookieJar = createCookieJar(result.cookieJar);
    return result;
  }

  /**
   * What the browser would have been doing when it made this request.
   *
   * `Sec-Fetch-*` describes the initiator, so it cannot be guessed per call
   * site after the fact — a caller that knows says so, and the rest are the
   * page's own fetches, which is what every request here actually is except
   * the redirect-following navigations.
   */
  static requestKind(options = {}) {
    if (options.kind) return String(options.kind);
    return /^text\/html/.test(String(options.accept || '')) ? 'navigate' : 'fetch';
  }

  async once(method, url, options = {}) {
    const body = requestBody(options);
    const request = {
      index: Number(options.index || -1),
      method: String(method || 'GET').toUpperCase(),
      url: String(url),
      headers: {},
      cookies: {},
      body: body.text,
      contentType: body.contentType,
    };
    const origin = sendsOrigin(request.method, request.url, options.origin) ? String(options.origin) : '';

    const kind = UrlSession.requestKind(options);
    if (this.browserHeaders) {
      request.headers = ordered({
        ...browserHeaders(this.profile, {
          url: request.url,
          kind,
          referer: options.referer || '',
          initiator: options.initiator || options.referer || this.documentUrl,
          origin,
          userActivated: options.userActivated === true,
          accept: options.accept || '',
          contentType: request.contentType,
        }),
        // The auth app's own front end traces its API calls. A request to them
        // without these is a request no version of that page produced.
        ...(tracedRequest(request.url, kind) ? authTelemetryHeaders(this.navigationId) : {}),
        ...(options.headers || {}),
      });
    } else {
      request.headers = { Accept: options.accept || '*/*', ...(options.headers || {}) };
      applyBrowserHeaders(request, this.profile);
      if (options.referer) setHeader(request.headers, 'Referer', options.referer);
      if (origin) setHeader(request.headers, 'Origin', origin);
      if (request.contentType) setHeader(request.headers, 'Content-Type', request.contentType);
    }

    const result = await this.executeRequest(request, options);
    if (kind === 'navigate') {
      this.documentUrl = request.url;
      this.navigationId = crypto.randomUUID();
    }
    const serverDate = String(result.response?.serverDate || result.response?.date || '').trim();
    const event = {
      method: request.method,
      url: request.url,
      status: Number(result.response?.status || 0),
      location: result.response?.location || '',
      ...(serverDate ? { serverDate } : {}),
    };
    this.events.push(event);
    return { ...result, json: responseJson(result), event };
  }

  async request(method, url, options = {}) {
    const maxRedirects = Number(options.maxRedirects ?? 12);
    let currentMethod = String(method || 'GET').toUpperCase();
    let currentUrl = String(url);
    let currentOptions = { ...options };
    const history = [];
    for (let redirects = 0; ; redirects += 1) {
      const result = await this.once(currentMethod, currentUrl, currentOptions);
      history.push(result.event);
      const status = Number(result.response?.status || 0);
      const location = result.response?.location || '';
      if (!options.follow || status < 300 || status >= 400 || !location) return { ...result, history };
      if (redirects >= maxRedirects) throw new Error(`Redirect limit exceeded at ${currentUrl}`);
      const nextUrl = new URL(location, currentUrl).toString();
      if (typeof options.stopRedirect === 'function' && options.stopRedirect(nextUrl, result)) {
        return { ...result, redirectUrl: nextUrl, history };
      }
      const nextMethod = redirectMethod(currentMethod, status);
      currentOptions = {
        ...options,
        json: nextMethod === 'GET' ? undefined : currentOptions.json,
        form: nextMethod === 'GET' ? undefined : currentOptions.form,
        body: nextMethod === 'GET' ? undefined : currentOptions.body,
        referer: currentUrl,
      };
      currentMethod = nextMethod;
      currentUrl = nextUrl;
    }
  }
}

module.exports = {
  UrlSession,
};
