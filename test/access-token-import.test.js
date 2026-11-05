'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { parseAccessTokenInput } = require('../src/access-token-import');

const jwt = (tag) => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ sub: tag })).toString('base64url')}.c2ln`;

test('accepts the shapes the console itself exports', () => {
  const { entries, rejected } = parseAccessTokenInput([
    `person@example.test----${jwt('a')}`,
    jwt('b'),
  ].join('\n'));

  assert.deepEqual(rejected, []);
  assert.deepEqual(entries.map((entry) => entry.email), ['person@example.test', '']);
  assert.equal(entries[0].accessToken, jwt('a'));
});

test('tolerates the separators a hand-kept list tends to grow', () => {
  const { entries, rejected } = parseAccessTokenInput([
    `one@example.test,${jwt('c')}`,
    `two@example.test\t${jwt('d')}`,
    `three@example.test|${jwt('e')}`,
    `${jwt('f')} four@example.test`,
    `five@example.test----Bearer ${jwt('g')}`,
    `Bearer ${jwt('h')}`,
  ].join('\n'));

  assert.deepEqual(rejected, []);
  assert.deepEqual(entries.map((entry) => entry.email), [
    'one@example.test', 'two@example.test', 'three@example.test', 'four@example.test', 'five@example.test', '',
  ]);
  // The Bearer prefix never survives into the stored token.
  assert.equal(entries.every((entry) => /^eyJ/.test(entry.accessToken)), true);
});

test('every line is accounted for, as an entry or as a reason', () => {
  const { entries, rejected } = parseAccessTokenInput([
    '# a comment',
    '',
    '   ',
    '// another comment',
    jwt('i'),
    'this is not a token',
    jwt('i'),
  ].join('\n'));

  assert.equal(entries.length, 1);
  assert.deepEqual(rejected.map((row) => [row.line, row.code]), [[6, 'TOKEN_MALFORMED'], [7, 'TOKEN_DUPLICATE']]);
});

test('an email is normalized so the same account cannot arrive twice in two cases', () => {
  const { entries } = parseAccessTokenInput(`Person@Example.TEST----${jwt('j')}`);
  assert.equal(entries[0].email, 'person@example.test');
});

test('empty input yields nothing rather than throwing', () => {
  assert.deepEqual(parseAccessTokenInput(''), { entries: [], rejected: [] });
  assert.deepEqual(parseAccessTokenInput(undefined), { entries: [], rejected: [] });
});
