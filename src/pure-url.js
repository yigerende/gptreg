'use strict';

const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const zlib = require('node:zlib');

const { base64urlDecode, base64urlEncode, getHeader, redactBody, redactUrl, responseLocation } = require('./http-shape');
const {
  cookieHeaderFor,
  cookieObjectFor,
  mergeCookieObject,
  serializeCookieJar,
  updateCookieJar,
} = require('./cookie-jar');
const { deleteHeader } = require('./util/shared');

const HOP_BY_HOP_HEADERS = new Set([
  'accept-encoding',
  'connection',
  'content-length',
  'host',
  'priority',
  'te',
]);

function headerObject(headers, options = {}) {
  const redact = options.redact !== false;
  const out = {};
  for (const header of headers || []) {
    const name = header.name;
    const lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (redact && (lower === 'cookie' || lower.startsWith('openai-sentinel-'))) {
      out[name] = '<redacted>';
    } else {
      out[name] = header.value;
    }
  }
  return out;
}

function cookieObject(cookies, options = {}) {
  const redact = options.redact !== false;
  return Object.fromEntries((cookies || []).map((cookie) => [cookie.name, redact ? '<redacted>' : cookie.value]));
}

function makePureHttpUrl(entry, index, options = {}) {
  const redact = options.redact !== false;
  const body = options.body !== undefined ? options.body : entry.request.postData?.text || '';
  const payload = {
    index,
    method: entry.request.method,
    url: redactUrl(entry.request.url, { redact }),
    headers: headerObject(entry.request.headers, { redact }),
    cookies: cookieObject(entry.request.cookies, { redact }),
    body: redact ? redactBody(body) : body,
    contentType: getHeader(entry.request.headers, 'content-type') || entry.request.postData?.mimeType || '',
    expectStatus: entry.response.status,
    redirect: redactUrl(responseLocation(entry), { redact }),
  };
  const url = new URL(`gpt-re+http://request/${index}`);
  url.searchParams.set('r', base64urlEncode(JSON.stringify(payload)));
  return url.toString();
}

function decodePureHttpUrl(value) {
  const parsed = new URL(value);
  if (parsed.protocol !== 'gpt-re+http:') {
    throw new Error(`Unsupported pure HTTP URL protocol: ${parsed.protocol}`);
  }
  const raw = parsed.searchParams.get('r');
  if (!raw) throw new Error('Missing pure HTTP request payload');
  return JSON.parse(base64urlDecode(raw));
}

function renderCookieHeader(cookies) {
  return Object.entries(cookies || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function parseSetCookieHeader(value) {
  const first = String(value || '').split(';', 1)[0];
  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  return { name: first.slice(0, eq), value: first.slice(eq + 1) };
}

function updateCookiesFromResponse(cookies, response) {
  const next = { ...(cookies || {}) };
  const setCookies = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [];
  const fallback = response.headers.get('set-cookie');
  for (const setCookie of setCookies.length ? setCookies : (fallback ? [fallback] : [])) {
    const parsed = parseSetCookieHeader(setCookie);
    if (parsed) next[parsed.name] = parsed.value;
  }
  return next;
}

function normalizeProxyUrl(value) {
  if (!value) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return new URL(`http://127.0.0.1:${text}`);
  if (/^[^:/?#]+:\d+$/.test(text)) return new URL(`http://${text}`);
  if (/^[^:@/?#]+:[^@/?#]+@[^:/?#]+:\d+$/.test(text)) return new URL(`http://${text}`);
  return new URL(text.includes('://') ? text : `http://${text}`);
}

function proxyAuthHeader(proxy) {
  if (!proxy?.username) return '';
  const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password || '')}`;
  return `Basic ${Buffer.from(credentials).toString('base64')}`;
}

function headerValue(headers, name) {
  const lower = name.toLowerCase();
  const values = [];
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() !== lower) continue;
    if (Array.isArray(value)) values.push(...value);
    else if (value !== undefined) values.push(String(value));
  }
  return values.join(', ');
}

function headerList(headers, name) {
  const lower = name.toLowerCase();
  const values = [];
  for (const [key, value] of Object.entries(headers || {})) {
    if (key.toLowerCase() !== lower) continue;
    if (Array.isArray(value)) values.push(...value.map(String));
    else if (value !== undefined) values.push(String(value));
  }
  return values;
}

function updateCookiesFromHeaderObject(cookies, headers) {
  const next = { ...(cookies || {}) };
  for (const setCookie of headerList(headers, 'set-cookie')) {
    const parsed = parseSetCookieHeader(setCookie);
    if (parsed) next[parsed.name] = parsed.value;
  }
  return next;
}

function retryAfterMs(value, nowMs = Date.now()) {
  if (value === undefined || value === null || value === '') return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1000));
  const at = Date.parse(String(value));
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : 0;
}

function targetPort(url) {
  if (url.port) return Number(url.port);
  return url.protocol === 'https:' ? 443 : 80;
}

function abortError(signal) {
  const reason = signal?.reason;
  // Node 24 uses a DOMException for abort() without an explicit reason. Its
  // `name` property is read-only, so normalize into a fresh Error instead of
  // mutating the signal's reason object.
  const error = new Error(
    reason instanceof Error
      ? reason.message
      : reason
        ? `Request aborted: ${reason}`
        : 'Request aborted',
  );
  error.name = 'AbortError';
  const reasonCode = reason && typeof reason.code === 'string' ? reason.code.trim() : '';
  error.code = reasonCode || 'ABORT_ERR';
  return error;
}

function connectTcp(hostname, port, timeoutMs, onSocket) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: hostname, port });
    if (typeof onSocket === 'function') onSocket(socket);
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      socket.removeListener('connect', onConnect);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onError = (error) => fail(error);
    const onClose = () => fail(new Error(`Proxy socket closed before connect: ${hostname}:${port}`));
    const onConnect = () => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.setTimeout(0);
      resolve(socket);
    };
    timer = setTimeout(() => fail(new Error(`Proxy socket timed out: ${hostname}:${port}`)), Math.max(1, timeoutMs));
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.once('connect', onConnect);
  });
}

function httpConnect(proxy, target, timeoutMs, onSocket) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: proxy.hostname, port: targetPort(proxy) });
    if (typeof onSocket === 'function') onSocket(socket);
    const chunks = [];
    let total = 0;
    let settled = false;
    let timer = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
      socket.removeListener('connect', onConnect);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onError = (error) => fail(error);
    const onClose = () => fail(new Error(`HTTP proxy closed before CONNECT response: ${proxy.host}`));
    const onConnect = () => {
      const targetHost = `${target.hostname}:${targetPort(target)}`;
      const headers = [
        `CONNECT ${targetHost} HTTP/1.1`,
        `Host: ${targetHost}`,
        'Proxy-Connection: keep-alive',
      ];
      const auth = proxyAuthHeader(proxy);
      if (auth) headers.push(`Proxy-Authorization: ${auth}`);
      headers.push('', '');
      socket.write(headers.join('\r\n'));
    };

    const onData = (chunk) => {
      chunks.push(chunk);
      total += chunk.length;
      const buffer = Buffer.concat(chunks, total);
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) return;

      const head = buffer.subarray(0, end).toString('latin1');
      const status = Number(head.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/)?.[1] || 0);
      if (status < 200 || status >= 300) {
        fail(new Error(`HTTP proxy CONNECT failed with ${status || 'unknown status'}`));
        return;
      }

      if (settled) return;
      settled = true;
      cleanup();
      socket.setTimeout(0);
      const rest = buffer.subarray(end + 4);
      if (rest.length) socket.unshift(rest);
      resolve(socket);
    };

    timer = setTimeout(() => fail(new Error(`HTTP proxy CONNECT timed out: ${proxy.host}`)), Math.max(1, timeoutMs));
    socket.once('error', onError);
    socket.once('close', onClose);
    socket.once('connect', onConnect);
    socket.on('data', onData);
  });
}

function createSocketReader(socket) {
  const state = {
    buffer: Buffer.alloc(0),
    closed: false,
    waiters: [],
  };

  const fail = (error) => {
    if (state.closed) return;
    state.closed = true;
    const reason = error || new Error('Proxy socket closed during handshake');
    for (const waiter of state.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(reason);
    }
  };

  const drain = () => {
    while (state.waiters.length && state.buffer.length >= state.waiters[0].length) {
      const waiter = state.waiters.shift();
      clearTimeout(waiter.timer);
      const value = state.buffer.subarray(0, waiter.length);
      state.buffer = state.buffer.subarray(waiter.length);
      waiter.resolve(value);
    }
  };

  const onData = (chunk) => {
    if (state.closed) return;
    state.buffer = Buffer.concat([state.buffer, chunk]);
    if (state.buffer.length > 1024 * 1024) {
      fail(new Error('Proxy handshake response exceeded the buffer limit'));
      socket.destroy();
      return;
    }
    drain();
  };

  socket.on('data', onData);
  socket.once('error', fail);
  socket.once('close', () => fail());

  return {
    read(length, timeoutMs) {
      if (state.closed) return Promise.reject(new Error('Proxy socket is closed'));
      return new Promise((resolve, reject) => {
        state.waiters.push({
          length,
          resolve,
          reject,
          timer: setTimeout(() => {
            const index = state.waiters.findIndex((item) => item.resolve === resolve);
            if (index >= 0) state.waiters.splice(index, 1);
            const error = new Error(`Proxy handshake timed out after ${timeoutMs} ms`);
            error.code = 'ETIMEDOUT';
            reject(error);
            socket.destroy();
          }, Math.max(1, timeoutMs)),
        });
        drain();
      });
    },
    detach() {
      socket.removeListener('data', onData);
      socket.removeListener('error', fail);
      for (const waiter of state.waiters.splice(0)) clearTimeout(waiter.timer);
      if (state.buffer.length) socket.unshift(state.buffer);
      state.buffer = Buffer.alloc(0);
    },
  };
}

async function socks5Connect(proxy, target, timeoutMs, onSocket) {
  const socket = await connectTcp(proxy.hostname, targetPort(proxy), timeoutMs, onSocket);
  const reader = createSocketReader(socket);
  try {
    const hasAuth = Boolean(proxy.username);
    socket.write(Buffer.from(hasAuth ? [0x05, 0x02, 0x00, 0x02] : [0x05, 0x01, 0x00]));
    const hello = await reader.read(2, timeoutMs);
    if (hello[0] !== 0x05) throw new Error('Invalid SOCKS5 proxy greeting');
    if (hello[1] === 0x02) {
      const username = Buffer.from(decodeURIComponent(proxy.username || ''), 'utf8');
      const password = Buffer.from(decodeURIComponent(proxy.password || ''), 'utf8');
      if (username.length > 255 || password.length > 255) throw new Error('SOCKS5 proxy credentials are too long');
      socket.write(Buffer.concat([Buffer.from([0x01, username.length]), username, Buffer.from([password.length]), password]));
      const auth = await reader.read(2, timeoutMs);
      if (auth[0] !== 0x01 || auth[1] !== 0x00) throw new Error('SOCKS5 proxy authentication failed');
    } else if (hello[1] !== 0x00) {
      throw new Error('SOCKS5 proxy does not allow supported authentication');
    }

    const host = Buffer.from(target.hostname, 'utf8');
    if (host.length > 255) throw new Error(`SOCKS5 target hostname too long: ${target.hostname}`);
    const port = Buffer.alloc(2);
    port.writeUInt16BE(targetPort(target));
    socket.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, host.length]), host, port]));
    const first = await reader.read(4, timeoutMs);
    if (first[1] !== 0x00) throw new Error(`SOCKS5 connect failed with code 0x${first[1].toString(16)}`);

    const addressLength = first[3] === 0x01 ? 4 : first[3] === 0x04 ? 16 : (await reader.read(1, timeoutMs))[0];
    await reader.read(addressLength + 2, timeoutMs);
    reader.detach();
    return socket;
  } catch (error) {
    reader.detach();
    socket.destroy();
    throw error;
  }
}

async function socketThroughProxy(proxy, target, timeoutMs, onSocket) {
  if (proxy.protocol === 'socks5:' || proxy.protocol === 'socks:') {
    return socks5Connect(proxy, target, timeoutMs, onSocket);
  }
  if (proxy.protocol !== 'http:') {
    throw new Error(`Unsupported proxy protocol: ${proxy.protocol}`);
  }
  return httpConnect(proxy, target, timeoutMs, onSocket);
}

async function proxiedConnection(proxy, target, timeoutMs, onSocket) {
  const socket = await socketThroughProxy(proxy, target, timeoutMs, onSocket);
  if (target.protocol !== 'https:') return socket;

  return new Promise((resolve, reject) => {
    const secure = tls.connect({
      socket,
      servername: target.hostname,
    });
    if (typeof onSocket === 'function') onSocket(secure);
    const fail = (error) => {
      secure.destroy();
      reject(error);
    };
    secure.setTimeout(timeoutMs, () => fail(new Error(`Proxy TLS handshake timed out: ${target.host}`)));
    secure.once('error', fail);
    secure.once('secureConnect', () => {
      secure.removeListener('error', fail);
      secure.setTimeout(0);
      resolve(secure);
    });
  });
}

/**
 * Undo whatever encoding the response arrived in.
 *
 * The console used to send no `Accept-Encoding` at all, which is both a tell —
 * every real browser advertises one — and the reason nothing here had to
 * decode. Once a request claims to accept `br` or `zstd` the server takes it
 * up on the offer, and a body read straight off the socket is binary noise.
 *
 * A body that will not decode is returned as-is rather than throwing: the
 * caller's own status and shape checks give a better error than a zlib stack.
 */
function decodeResponseBody(buffer, encoding) {
  const applied = String(encoding || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
    .reverse();
  let decoded = buffer;
  for (const step of applied) {
    try {
      if (step === 'gzip' || step === 'x-gzip') decoded = zlib.gunzipSync(decoded);
      else if (step === 'deflate') decoded = zlib.inflateSync(decoded);
      else if (step === 'br') decoded = zlib.brotliDecompressSync(decoded);
      else if (step === 'zstd' && typeof zlib.zstdDecompressSync === 'function') decoded = zlib.zstdDecompressSync(decoded);
      else if (step !== 'identity') return buffer;
    } catch {
      // `deflate` is served both raw and zlib-wrapped in the wild; try the
      // other reading before giving up on the body entirely.
      if (step === 'deflate') {
        try {
          decoded = zlib.inflateRawSync(decoded);
          continue;
        } catch { /* fall through to the undecoded body */ }
      }
      return buffer;
    }
  }
  return decoded;
}

function collectResponse(res, requestUrl) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let settled = false;
    const cleanup = () => {
      res.removeListener('data', onData);
      res.removeListener('error', onError);
      res.removeListener('end', onEnd);
      res.removeListener('close', onClose);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onData = (chunk) => chunks.push(chunk);
    const onError = (error) => finish(reject, error);
    const onClose = () => finish(reject, new Error(`HTTP response closed before completion: ${requestUrl}`));
    const onEnd = () => {
      const result = {
        status: res.statusCode || 0,
        url: requestUrl,
        headers: res.headers,
        text: decodeResponseBody(Buffer.concat(chunks), res.headers?.['content-encoding']).toString('utf8'),
      };
      finish(resolve, result);
      res.destroy();
    };
    res.on('data', onData);
    res.once('error', onError);
    res.once('end', onEnd);
    res.once('close', onClose);
  });
}

async function requestViaProxy(request, headers, options = {}) {
  const proxy = normalizeProxyUrl(options.proxy);
  const target = new URL(request.url);
  const timeoutMs = options.timeoutMs || 60000;
  const signal = options.signal;

  return new Promise((resolve, reject) => {
    let activeRequest = null;
    let activeSocket = null;
    let settled = false;
    let requestTimer = null;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      if (requestTimer) clearTimeout(requestTimer);
      signal?.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => {
      const error = abortError(signal);
      activeRequest?.destroy(error);
      activeSocket?.destroy(error);
      finish(reject, error);
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    requestTimer = setTimeout(() => {
      const error = new Error(`Proxy request timed out after ${timeoutMs} ms: ${request.url}`);
      activeRequest?.destroy();
      activeSocket?.destroy();
      finish(reject, error);
    }, Math.max(1, timeoutMs));

    const isHttps = target.protocol === 'https:';
    const isSocks = proxy.protocol === 'socks5:' || proxy.protocol === 'socks:';
    const useForwardProxy = !isHttps && !isSocks;
    const transport = isHttps ? https : http;
    const path = useForwardProxy ? target.toString() : `${target.pathname}${target.search}`;
    const reqHeaders = { ...headers };
    if (!headerValue(reqHeaders, 'host')) reqHeaders.Host = target.host;
    if (!headerValue(reqHeaders, 'connection')) reqHeaders.Connection = 'close';
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD' && Boolean(request.body);
    if (hasBody && !headerValue(reqHeaders, 'content-length') && !headerValue(reqHeaders, 'transfer-encoding')) {
      reqHeaders['Content-Length'] = String(Buffer.byteLength(request.body));
    }
    if (useForwardProxy) {
      const auth = proxyAuthHeader(proxy);
      if (auth && !headerValue(reqHeaders, 'proxy-authorization')) {
        reqHeaders['Proxy-Authorization'] = auth;
      }
    }

    const start = async () => {
      try {
        const socket = useForwardProxy
          ? null
          : await proxiedConnection(proxy, target, timeoutMs, (nextSocket) => {
            activeSocket = nextSocket;
            if (signal?.aborted) nextSocket.destroy(abortError(signal));
          });
        if (signal?.aborted) throw abortError(signal);
        const reqOptions = {
          method: request.method,
          host: useForwardProxy ? proxy.hostname : target.hostname,
          port: useForwardProxy ? targetPort(proxy) : targetPort(target),
          path,
          headers: reqHeaders,
          timeout: timeoutMs,
        };

        if (socket) {
          reqOptions.createConnection = () => socket;
        }

        const req = transport.request(reqOptions, async (res) => {
          try {
            finish(resolve, await collectResponse(res, request.url));
          } catch (error) {
            finish(reject, error);
          }
        });
        activeRequest = req;
        req.once('timeout', () => {
          const error = new Error(`Request timed out: ${request.url}`);
          req.destroy();
          finish(reject, error);
        });
        req.once('error', (error) => finish(reject, error));
        if (hasBody) req.write(request.body);
        req.end();
      } catch (error) {
        finish(reject, error);
      }
    };

    start();
  });
}

async function executePureHttpUrl(value, options = {}) {
  const request = typeof value === 'string' ? decodePureHttpUrl(value) : value;
  const stateCookies = options.cookies || {};
  const headers = { ...request.headers };
  const scopedJar = options.cookieJar
    ? mergeCookieObject(options.cookieJar, request.url, request.cookies)
    : null;
  const cookieHeader = scopedJar
    ? cookieHeaderFor(scopedJar, request.url)
    : renderCookieHeader({ ...request.cookies, ...stateCookies });
  deleteHeader(headers, 'cookie');
  if (cookieHeader) headers.Cookie = cookieHeader;
  if (request.contentType && !Object.keys(headers).some((name) => name.toLowerCase() === 'content-type')) {
    headers['content-type'] = request.contentType;
  }

  if (options.proxy) {
    const response = await requestViaProxy(request, headers, options);
    const nextJar = scopedJar ? updateCookieJar(scopedJar, request.url, response.headers) : null;
    return {
      request,
      response: {
        status: response.status,
        url: response.url,
        location: headerValue(response.headers, 'location'),
        contentType: headerValue(response.headers, 'content-type'),
        serverDate: headerValue(response.headers, 'date'),
        retryAfterMs: retryAfterMs(headerValue(response.headers, 'retry-after')),
        text: response.text,
      },
      cookies: nextJar
        ? cookieObjectFor(nextJar, request.url)
        : updateCookiesFromHeaderObject({ ...request.cookies, ...stateCookies }, response.headers),
      cookieJar: nextJar ? serializeCookieJar(nextJar) : undefined,
    };
  }

  const response = await fetch(request.url, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    redirect: options.redirect || 'manual',
    signal: options.signal,
  });
  const text = await response.text();
  const nextJar = scopedJar ? updateCookieJar(scopedJar, request.url, response.headers) : null;

  return {
    request,
    response: {
      status: response.status,
      url: response.url,
      location: response.headers.get('location') || '',
      contentType: response.headers.get('content-type') || '',
      serverDate: response.headers.get('date') || '',
      retryAfterMs: retryAfterMs(response.headers.get('retry-after')),
      text,
    },
    cookies: nextJar
      ? cookieObjectFor(nextJar, request.url)
      : updateCookiesFromResponse({ ...request.cookies, ...stateCookies }, response),
    cookieJar: nextJar ? serializeCookieJar(nextJar) : undefined,
  };
}

module.exports = {
  decodePureHttpUrl,
  // Exported so the encodings a request advertises can be tested against the
  // bodies they produce, without standing up a server for each one.
  decodeResponseBody,
  executePureHttpUrl,
  makePureHttpUrl,
  normalizeProxyUrl,
  retryAfterMs,
};
