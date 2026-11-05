'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { loadHar } = require('../src/har');
const { buildEnforcementToken, sentinelHash } = require('../src/sentinel-pow');

test('builds a Sentinel enforcement token satisfying the captured difficulty', () => {
  const { har } = loadHar();
  const response = JSON.parse(har.log.entries[142].response.content.text);
  const token = buildEnforcementToken(response, {
    now: () => 10,
    date: 'Mon Jul 27 2026 05:13:23 GMT+0800',
  });
  const answer = token.slice('gAAAAAB'.length).replace(/~S$/, '');
  const hash = sentinelHash(response.proofofwork.seed + answer);

  assert.match(token, /^gAAAAAB/);
  assert.equal(token.endsWith('~S'), true);
  assert.equal(hash.substring(0, response.proofofwork.difficulty.length) <= response.proofofwork.difficulty, true);
});
