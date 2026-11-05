'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  FIREFOX_153_USER_AGENT,
  applyBrowserHeaders,
  createFirefox153Profile,
  ensureClientProfile,
} = require('../src/client-profile');

test('locks a runner to the Firefox 153 profile', () => {
  const state = {};
  const first = ensureClientProfile(state);
  const second = ensureClientProfile(state);

  assert.equal(first.userAgent, FIREFOX_153_USER_AGENT);
  assert.deepEqual(second, first);
  assert.ok(state.clientProfileFingerprint);
  assert.throws(
    () => ensureClientProfile({ clientProfile: { ...first, userAgent: 'Chrome' } }),
    /profile drifted at userAgent/,
  );
});

test('normalizes pure URL headers to Firefox and removes Chromium client hints', () => {
  const request = {
    headers: {
      'user-agent': 'captured-agent',
      'accept-language': 'en',
      'sec-ch-ua': 'Chromium',
      'Sec-CH-UA-Platform': 'Windows',
    },
  };

  applyBrowserHeaders(request, createFirefox153Profile());

  assert.equal(request.headers['User-Agent'], FIREFOX_153_USER_AGENT);
  assert.match(request.headers['Accept-Language'], /^zh-CN/);
  assert.equal(Object.keys(request.headers).some((name) => name.toLowerCase().startsWith('sec-ch-ua')), false);
});
