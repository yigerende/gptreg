'use strict';

const { text } = require('./util/shared');

/**
 * Parsing for pasted access tokens.
 *
 * Accepts what the console itself exports — `email----token` and one bare token
 * per line — so a batch can round-trip without reformatting. Kept pure and
 * separate from the import flow: deciding what a line means is worth testing on
 * its own, and it must never depend on network or disk.
 */

// ChatGPT access tokens are JWTs. The shape check is deliberately loose (three
// dot-separated base64url segments) rather than a decode: a token this module
// rejects can never be tried, so a false negative is worse than passing a dud
// through to the probe, which will reject it authoritatively.
const TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_.-]+$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// `----` is the console's own export separator; the rest are what a spreadsheet
// or a hand-kept list tends to produce.
const SEPARATORS = ['----', '\t', '|', ',', ';', ':::', ' '];

/** Splits a line into its first field and the remainder, on the first separator hit. */
function splitFields(line) {
  for (const separator of SEPARATORS) {
    const index = line.indexOf(separator);
    if (index > 0) return [line.slice(0, index).trim(), line.slice(index + separator.length).trim()];
  }
  return [line, ''];
}

/**
 * Turns pasted text into token entries.
 *
 * Returns `{ entries, rejected }`. Every input line lands in exactly one of
 * them, so the console can account for all of it rather than silently dropping
 * what it did not understand.
 */
function parseAccessTokenInput(content) {
  const entries = [];
  const rejected = [];
  const seen = new Map();
  const lines = String(content || '').split(/\r?\n/);

  lines.forEach((raw, index) => {
    // The `Bearer ` prefix has to go before the split, or the space separator
    // turns it into the first field and swallows the token.
    const line = text(raw).replace(/^﻿/, '').replace(/(^|[\s,|])Bearer\s+/i, '$1');
    if (!line || line.startsWith('#') || line.startsWith('//')) return;

    const [first, rest] = splitFields(line);
    let email = '';
    let token = line;
    if (rest) {
      if (EMAIL_PATTERN.test(first)) {
        email = first.toLowerCase();
        token = rest;
      } else if (EMAIL_PATTERN.test(rest)) {
        // Tolerate the reverse order rather than calling a usable line invalid.
        email = rest.toLowerCase();
        token = first;
      } else {
        token = first;
      }
    }

    // Stripped again after the split: a `Bearer ` sitting after a separator
    // (`mail----Bearer eyJ...`) is only visible once the fields are apart.
    token = token.replace(/^Bearer\s+/i, '').trim();

    if (!TOKEN_PATTERN.test(token)) {
      rejected.push({ line: index + 1, input: line.slice(0, 60), code: 'TOKEN_MALFORMED', reason: '不是有效的 access token' });
      return;
    }
    const previous = seen.get(token);
    if (previous !== undefined) {
      rejected.push({ line: index + 1, input: email || `第 ${previous} 行`, code: 'TOKEN_DUPLICATE', reason: '与前面重复' });
      return;
    }
    seen.set(token, index + 1);
    entries.push({ line: index + 1, email, accessToken: token });
  });

  return { entries, rejected };
}

module.exports = { parseAccessTokenInput };
