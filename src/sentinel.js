'use strict';

const {
  bodySummary,
  cookieNames,
  entriesOf,
  headerNames,
  parseUrl,
  queryNames,
  redactUrl,
  sha256Short,
  summarizeValue,
  tryParseJson,
} = require('./har');
const { makeUrlizedRequest } = require('./url-chain');

function decodeCookieValue(value) {
  if (value === undefined || value === null) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function buildSentinelEnvelope(fields, flow, id) {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error('Sentinel fields must be an object');
  }
  if (!fields.p && !fields.so) {
    throw new Error('Sentinel envelope requires p or so');
  }
  if (!flow) {
    throw new Error('Sentinel envelope requires flow');
  }
  if (!id) {
    throw new Error('Sentinel envelope requires id/oai-did');
  }

  const envelope = { ...fields };
  envelope.id = decodeCookieValue(id);
  envelope.flow = flow;
  return JSON.stringify(envelope);
}

function extractVersionFromUrl(url) {
  const parsed = parseUrl(url);
  const match = parsed?.pathname.match(/\/sentinel\/([^/]+)\/sdk\.js$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function extractVersionFromBootstrap(text) {
  const match = String(text || '').match(/https:\/\/sentinel\.openai\.com\/sentinel\/([^/]+)\/sdk\.js/);
  return match ? decodeURIComponent(match[1]) : null;
}

function buildSentinelUrls(options = {}) {
  const origin = options.origin || 'https://sentinel.openai.com';
  const version = options.version || '';
  return {
    bootstrapSdk: `${origin}/backend-api/sentinel/sdk.js`,
    versionedSdk: version ? `${origin}/sentinel/${encodeURIComponent(version)}/sdk.js` : null,
    frame: `${origin}/backend-api/sentinel/frame.html${version ? `?sv=${encodeURIComponent(version)}` : ''}`,
    request: `${origin}/backend-api/sentinel/req`,
  };
}

function base64Probe(value) {
  if (!value || typeof value !== 'string') return null;
  try {
    const decoded = Buffer.from(value, 'base64url');
    return {
      encodedLength: value.length,
      decodedBytes: decoded.length,
      firstHex: decoded.subarray(0, 16).toString('hex'),
      sha256: sha256Short(decoded),
      looksJson: /^[\[{]/.test(decoded.toString('utf8', 0, 1)),
    };
  } catch (error) {
    return {
      encodedLength: value.length,
      error: error.message,
    };
  }
}

function valueOrShape(value, redact) {
  if (!redact) return value;
  if (typeof value === 'string') return `<redacted:string:${value.length}>`;
  return value;
}

function sentinelRequest(entry, index, options = {}) {
  const redact = options.redact !== false;
  const body = tryParseJson(entry.request.postData?.text || '') || {};
  const response = tryParseJson(entry.response.content?.text || '') || {};
  const didCookie = (entry.request.cookies || []).find((cookie) => cookie.name === 'oai-did')?.value;

  return {
    index,
    startedDateTime: entry.startedDateTime,
    method: entry.request.method,
    status: entry.response.status,
    url: redactUrl(entry.request.url, { redact }),
    requestHeaderNames: headerNames(entry.request.headers),
    requestCookieNames: cookieNames(entry.request.cookies),
    responseCookieNames: cookieNames(entry.response.cookies),
    bodyKeys: Object.keys(body),
    flow: valueOrShape(body.flow, redact),
    idMatchesOaiDid: Boolean(body.id && didCookie && body.id === decodeCookieValue(didCookie)),
    id: valueOrShape(body.id, redact),
    p: base64Probe(body.p),
    postData: bodySummary(entry.request.postData, { redact, includeText: options.includeBodyText }),
    responseShape: summarizeValue(response, 0, { redact }),
    urlized: makeUrlizedRequest(entry, index, { redact }),
  };
}

function sentinelAsset(entry, index) {
  const url = entry.request.url;
  const text = entry.response.content?.text || '';
  const version = extractVersionFromUrl(url) || extractVersionFromBootstrap(text);
  return {
    index,
    startedDateTime: entry.startedDateTime,
    status: entry.response.status,
    url,
    version,
    responseMime: entry.response.content?.mimeType || '',
    responseTextLength: text.length,
    sha256: sha256Short(text),
  };
}

function sentinelFrame(entry, index, options = {}) {
  const redact = options.redact !== false;
  return {
    index,
    startedDateTime: entry.startedDateTime,
    status: entry.response.status,
    url: redactUrl(entry.request.url, { redact }),
    queryNames: queryNames(entry.request.url),
    requestCookieNames: cookieNames(entry.request.cookies),
    responseCookieNames: cookieNames(entry.response.cookies),
  };
}

function consumerRequest(entry, index, options = {}) {
  const redact = options.redact !== false;
  const names = headerNames(entry.request.headers).filter((name) => /^openai-sentinel-/i.test(name));
  if (names.length === 0) return null;
  const parsed = parseUrl(entry.request.url);
  return {
    index,
    startedDateTime: entry.startedDateTime,
    method: entry.request.method,
    status: entry.response.status,
    path: parsed ? parsed.pathname : '',
    url: redactUrl(entry.request.url, { redact }),
    sentinelHeaders: names,
    requestCookieNames: cookieNames(entry.request.cookies),
    postData: bodySummary(entry.request.postData, { redact }),
  };
}

function extractSentinel(har, options = {}) {
  const entries = entriesOf(har);
  const sdkEntries = [];
  const frameEntries = [];
  const reqEntries = [];
  const consumers = [];

  for (const [index, entry] of entries.entries()) {
    const parsed = parseUrl(entry.request.url);
    const host = parsed?.host || '';
    const pathname = parsed?.pathname || '';

    if (host === 'sentinel.openai.com' && pathname.endsWith('/sdk.js')) {
      sdkEntries.push(sentinelAsset(entry, index));
    }

    if (host === 'sentinel.openai.com' && pathname === '/backend-api/sentinel/frame.html') {
      frameEntries.push(sentinelFrame(entry, index, options));
    }

    if (host === 'sentinel.openai.com' && pathname === '/backend-api/sentinel/req') {
      reqEntries.push(sentinelRequest(entry, index, options));
    }

    const consumer = consumerRequest(entry, index, options);
    if (consumer) consumers.push(consumer);
  }

  const version =
    sdkEntries.find((entry) => entry.version)?.version ||
    frameEntries.map((frame) => parseUrl(frame.url)?.searchParams.get('sv')).find(Boolean) ||
    null;

  return {
    version,
    urls: buildSentinelUrls({ version }),
    assets: {
      sdk: sdkEntries,
      frame: frameEntries,
    },
    requests: reqEntries,
    consumers,
    contract: {
      sdkFunctions: ['init(flow)', 'token(flow)', 'sessionObserverToken(flow)', 'timing()'],
      requestEndpoint: '/backend-api/sentinel/req',
      requestContentType: 'text/plain;charset=UTF-8',
      envelope: {
        init: ['p', 'id', 'flow'],
        token: ['p', 't', 'c', 'id', 'flow'],
        sessionObserver: ['so', 'c', 'id', 'flow'],
      },
      idSource: 'decodeURIComponent(cookie["oai-did"])',
      responseKeys: ['persona', 'token', 'expire_after', 'expire_at', 'turnstile', 'proofofwork', 'so'],
      responseCookie: 'oai-sc',
      consumerHeaders: [...new Set(consumers.flatMap((item) => item.sentinelHeaders))].sort(),
    },
  };
}

module.exports = {
  buildSentinelEnvelope,
  decodeCookieValue,
  extractSentinel,
};
