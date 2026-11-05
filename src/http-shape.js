'use strict';

const crypto = require('node:crypto');

/**
 * Small HTTP helpers with no opinion about where a request came from.
 *
 * These used to live in `har.js`, which meant a mail client that wanted to
 * parse a JSON body imported a module named after a capture format. That
 * import said nothing true about the file and quite a lot that was misleading:
 * grepping for HAR dependencies turned up nine modules that had none, and the
 * registration flow looked bound to a recording in places where it only wanted
 * `JSON.parse` that does not throw.
 *
 * `har.js` still re-exports every one of them, so nothing has to move in the
 * same change that makes moving possible.
 */

const REDACTED = '<redacted>';

function parseUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Reads a header out of the array-of-pairs shape, case-insensitively. */
function getHeader(headers, name) {
  return (headers || []).find((header) => header.name.toLowerCase() === name.toLowerCase())?.value || '';
}

/**
 * Where a response says to go next.
 *
 * Reads the entry shape — a request/response pair — which templates produce as
 * well as captures, so it does not belong to the capture reader any more.
 */
function responseLocation(entry) {
  return getHeader(entry?.response?.headers, 'location') || entry?.response?.redirectURL || '';
}

function headerNames(headers) {
  return [...new Set((headers || []).map((header) => header.name).filter(Boolean))].sort();
}

function cookieNames(cookies) {
  return [...new Set((cookies || []).map((cookie) => cookie.name).filter(Boolean))].sort();
}

function queryNames(url) {
  const parsed = parseUrl(url);
  return parsed ? [...parsed.searchParams.keys()] : [];
}

function redactText(text) {
  if (text === undefined || text === null) return text;
  return String(text).replace(/[A-Za-z0-9_-]{12,}(?:\.[A-Za-z0-9_-]{12,})*/g, REDACTED);
}

function redactUrl(url, options = {}) {
  if (!options.redact) return url || '';
  const parsed = parseUrl(url);
  if (!parsed) return redactText(url || '');

  for (const key of [...parsed.searchParams.keys()]) {
    parsed.searchParams.set(key, REDACTED);
  }

  if (parsed.hash) {
    parsed.hash = '#<redacted>';
  }

  return parsed.toString();
}

function redactJsonValue(value, key = '') {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item, key));
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [childKey, redactJsonValue(childValue, childKey)]));
  }
  if (typeof value === 'string') {
    if (key === 'flow') return value;
    return `${REDACTED}:string:${value.length}`;
  }
  if (typeof value === 'number') return `${REDACTED}:number`;
  if (typeof value === 'boolean') return value;
  return REDACTED;
}

function redactBody(text) {
  if (!text) return '';
  const parsed = tryParseJson(text);
  if (parsed !== null) {
    return JSON.stringify(redactJsonValue(parsed));
  }
  return `<redacted:${String(text).length}>`;
}

function base64urlEncode(text) {
  return Buffer.from(String(text), 'utf8').toString('base64url');
}

function base64urlDecode(text) {
  return Buffer.from(String(text), 'base64url').toString('utf8');
}

function sha256Short(text, length = 16) {
  return crypto.createHash('sha256').update(text || '').digest('hex').slice(0, length);
}

module.exports = {
  base64urlDecode,
  base64urlEncode,
  cookieNames,
  getHeader,
  headerNames,
  parseUrl,
  queryNames,
  redactBody,
  redactText,
  redactUrl,
  responseLocation,
  sha256Short,
  tryParseJson,
};
