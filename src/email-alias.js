'use strict';

const crypto = require('node:crypto');

const ALIAS_SUFFIX_LENGTH = 4;
const ALIAS_SUFFIX_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const MAX_SUFFIX_ATTEMPTS = 100;

function splitEmail(email) {
  const text = String(email || '').trim();
  const at = text.lastIndexOf('@');
  if (at <= 0 || at === text.length - 1) throw new Error(`Invalid email address: ${email}`);
  return {
    local: text.slice(0, at),
    domain: text.slice(at + 1),
  };
}

function sanitizeTag(value) {
  return String(value || 'gptre')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 24) || 'gptre';
}

function randomLetterSuffix(options = {}) {
  const randomInt = options.randomInt || crypto.randomInt;
  let suffix = '';
  for (let index = 0; index < ALIAS_SUFFIX_LENGTH; index += 1) {
    const offset = Number(randomInt(0, ALIAS_SUFFIX_ALPHABET.length));
    if (!Number.isInteger(offset) || offset < 0 || offset >= ALIAS_SUFFIX_ALPHABET.length) {
      throw new Error('Alias random source returned an invalid value');
    }
    suffix += ALIAS_SUFFIX_ALPHABET[offset];
  }
  return suffix;
}

function derivePlusAlias(email, _index, options = {}) {
  const { local, domain } = splitEmail(email);
  const runTag = sanitizeTag(options.runTag || 'gptre');
  const suffix = randomLetterSuffix(options);
  return `${local}+${runTag}${suffix}@${domain}`;
}

function derivePlusAliases(email, count, options = {}) {
  const total = Math.max(0, Number(count || 0));
  const start = Number(options.startIndex || 1);
  const used = new Set((options.excludeEmails || []).map((value) => String(value).toLowerCase()));
  const aliases = [];
  for (let offset = 0; offset < total; offset += 1) {
    let aliasEmail = '';
    for (let attempt = 0; attempt < MAX_SUFFIX_ATTEMPTS; attempt += 1) {
      const candidate = derivePlusAlias(email, start + offset, options);
      if (used.has(candidate.toLowerCase())) continue;
      aliasEmail = candidate;
      used.add(candidate.toLowerCase());
      break;
    }
    if (!aliasEmail) throw new Error('Could not generate a unique random email alias');
    aliases.push({
      index: start + offset,
      parentEmail: email,
      email: aliasEmail,
      strategy: 'plus',
    });
  }
  return aliases;
}

function deriveRegistrationEmails(email, count, options = {}) {
  const strategy = String(options.strategy || 'plus').toLowerCase();
  if (strategy === 'root') {
    splitEmail(email);
    return [{
      index: 1,
      parentEmail: email,
      email,
      strategy: 'root',
    }];
  }
  // The root address, then one plus-alias of it. This is what the pooled
  // channel's "also register a sub-address" switch turns on; a rented mailbox
  // never uses it, because its code quota cannot serve two accounts.
  if (strategy === 'root_plus') {
    const total = Math.max(1, Number(count || 1));
    splitEmail(email);
    const root = { index: 1, parentEmail: email, email, strategy: 'root' };
    if (total === 1) return [root];
    return [root, ...derivePlusAliases(email, total - 1, {
      ...options,
      startIndex: 2,
      // The root address is already taken by the first account.
      excludeEmails: [...(options.excludeEmails || []), email],
    })];
  }
  if (strategy !== 'plus') throw new Error(`Unsupported email strategy: ${strategy}`);
  return derivePlusAliases(email, count, options);
}

module.exports = {
  derivePlusAlias,
  derivePlusAliases,
  deriveRegistrationEmails,
  splitEmail,
};
