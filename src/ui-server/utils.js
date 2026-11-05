'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { clone, isPlainObject } = require('../util/shared');

const SECRET_KEY = /(?:password|passphrase|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|authorization|cookie|pkce|codeVerifier|tokens?)/i;

class HttpError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

function mergeObjects(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return clone(patch);
  const out = { ...clone(base) };
  for (const [key, value] of Object.entries(patch)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) {
      throw new HttpError(400, 'Unsafe configuration key');
    }
    out[key] = isPlainObject(value) && isPlainObject(out[key])
      ? mergeObjects(out[key], value)
      : clone(value);
  }
  return out;
}

function resolveInside(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, candidate);
  const relative = path.relative(resolvedRoot, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new HttpError(400, 'Path must stay inside the workspace');
  }
  return resolved;
}

function atomicWriteText(filePath, content) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temporary, resolved);
  } catch (error) {
    if (!['EEXIST', 'EPERM', 'ENOTEMPTY', 'EACCES'].includes(error.code) || !fs.existsSync(resolved)) throw error;
    const displaced = `${resolved}.${process.pid}.replaced`;
    if (fs.existsSync(displaced)) fs.unlinkSync(displaced);
    fs.renameSync(resolved, displaced);
    try {
      fs.renameSync(temporary, resolved);
      fs.unlinkSync(displaced);
    } catch (replaceError) {
      if (!fs.existsSync(resolved) && fs.existsSync(displaced)) fs.renameSync(displaced, resolved);
      throw replaceError;
    }
  }
  try { fs.chmodSync(resolved, 0o600); } catch { /* Windows ACLs are managed by the host. */ }
  return resolved;
}

function maskEmail(value) {
  return String(value).replace(/([A-Z0-9._%+-])[^@\s]*(@[A-Z0-9.-]+\.[A-Z]{2,})/gi, '$1***$2');
}

function maskPhone(value) {
  return String(value).replace(/\+?\d[\d\s()-]{6,}\d/g, (phone) => {
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 7) return phone;
    return `${phone.trim().startsWith('+') ? '+' : ''}${digits.slice(0, 3)}****${digits.slice(-2)}`;
  });
}

function scrubString(value, options = {}) {
  let text = String(value)
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, '$1<redacted>@')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b/g, '<redacted:token>');
  if (options.redactPii !== false) {
    text = maskPhone(maskEmail(text));
  }
  return text;
}

function sanitizeValue(value, options = {}, key = '') {
  if (SECRET_KEY.test(key)) return '<redacted>';
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, options));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [
      childKey,
      sanitizeValue(child, options, childKey),
    ]));
  }
  if (typeof value === 'string') {
    if (/^(?:at|timestamp|[A-Za-z][A-Za-z0-9]*At|runId|workerId|jobId)$/.test(key)) return value;
    return scrubString(value, options);
  }
  return value;
}

function safeRunId(value) {
  const text = String(value || '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{2,79}$/i.test(text)) throw new HttpError(400, 'Invalid run id');
  return text;
}

/**
 * Runs `mapper` over `values` with at most `limit` in flight, preserving order.
 *
 * Shared rather than re-implemented per service: the pattern shows up wherever
 * this console fans a batch out to something slower than itself.
 */
async function mapLimit(values, limit, mapper) {
  const output = new Array(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, values.length)) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await mapper(values[index], index);
    }
  });
  await Promise.all(workers);
  return output;
}

module.exports = {
  HttpError,
  atomicWriteText,
  mapLimit,
  maskEmail,
  mergeObjects,
  resolveInside,
  safeRunId,
  sanitizeValue,
  scrubString,
};
