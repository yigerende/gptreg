'use strict';

const crypto = require('node:crypto');

/**
 * Helpers that were copy-pasted across `src/`, folded into one place.
 *
 * Only bodies that were identical, or provably equivalent, moved here. Names
 * that merely coincide stay local: `nowIso` has four signatures, the `setHeader`
 * variants differ in whether an existing key keeps its position (header order
 * is part of the client fingerprint), and `state-store`'s `isPlainObject` also
 * rejects class instances.
 *
 * Quirks are kept on purpose: `firstDefined` treats `''` as absent, `cloneJson`
 * throws on `undefined` where `clone` passes it through, and the two string
 * readers disagree about `0`. Pick by contract, not by name.
 */

/** @throws on `undefined` — every current caller passes a defined value. */
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/** `cloneJson` that lets `undefined` through, for optional fields. */
function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

/** First value that is neither nullish nor the empty string. */
function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

/** A trimmed string; only `null` and `undefined` become `''`. */
function text(value) {
  return String(value ?? '').trim();
}

/** Like `text`, but every falsy value — `0` and `false` included — becomes `''`. */
function truthyText(value) {
  return String(value || '').trim();
}

/** Keeps a job's normal result while making a persisted failure actionable. */
function jobResultText(job = {}) {
  const current = String(job?.result || '').trim();
  const error = job?.error;
  if (!error) return current;
  const code = typeof error === 'object' ? String(error.code || '').trim() : '';
  const message = typeof error === 'object'
    ? String(error.message || '').trim()
    : String(error || '').trim();
  const reason = [code, message].filter(Boolean).join('，');
  if (!reason) return current;
  const failure = `失败：${reason}`;
  if (!current) return failure;
  return current.includes(failure) ? current : `${current}；${failure}`;
}

/** Non-null and not an array. Class instances pass; see `state-store` for the strict check. */
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** A short stable id: the first `length` hex characters of a SHA-256. */
function hashId(value, length = 12) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

/** Removes every case variant of a header from a plain headers object. */
function deleteHeader(headers, name) {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) delete headers[key];
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertEmail(email) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ''))) {
    throw new Error(`Invalid email: ${email || '<empty>'}`);
  }
}

/** The verdict shape shared by the health probe and the trial check. */
function classified(status, code, message, extra = {}) {
  return { status, code, message, ...extra };
}

module.exports = {
  assertEmail,
  classified,
  clone,
  cloneJson,
  deleteHeader,
  firstDefined,
  hashId,
  isPlainObject,
  jobResultText,
  sleep,
  text,
  truthyText,
};
