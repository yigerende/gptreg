'use strict';

const { CookieJar } = require('tough-cookie');
const { isPlainObject } = require('./util/shared');

const LEGACY_ORIGINS = Object.freeze([
  'https://auth.openai.com/',
  'https://chatgpt.com/',
]);

function isSerializedJar(value) {
  return isPlainObject(value) && Array.isArray(value.cookies) && value.version;
}

function createCookieJar(input, options = {}) {
  if (input instanceof CookieJar) return input;
  if (isSerializedJar(input)) return CookieJar.deserializeSync(input);

  const jar = new CookieJar(undefined, {
    looseMode: true,
    allowSpecialUseDomain: true,
    rejectPublicSuffixes: false,
  });
  if (!isPlainObject(input)) return jar;

  const origins = options.legacyOrigins || LEGACY_ORIGINS;
  for (const [name, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === '') continue;
    for (const origin of origins) {
      jar.setCookieSync(`${name}=${String(value)}; Path=/`, origin, { ignoreError: true });
    }
  }
  return jar;
}

function serializeCookieJar(input) {
  return createCookieJar(input).serializeSync();
}

function cookieHeaderFor(input, url) {
  return createCookieJar(input).getCookieStringSync(String(url));
}

function cookieObjectFor(input, url) {
  const jar = createCookieJar(input);
  return Object.fromEntries(jar.getCookiesSync(String(url)).map((cookie) => [cookie.key, cookie.value]));
}

function mergeCookieObject(input, url, cookies = {}) {
  const jar = createCookieJar(input);
  for (const [name, value] of Object.entries(cookies || {})) {
    if (value === undefined || value === null || value === '') continue;
    jar.setCookieSync(`${name}=${String(value)}; Path=/`, String(url), { ignoreError: true });
  }
  return jar;
}

function headerList(headers, name) {
  if (!headers) return [];
  if (typeof headers.getSetCookie === 'function' && String(name).toLowerCase() === 'set-cookie') {
    const values = headers.getSetCookie();
    if (values.length) return values;
  }
  if (typeof headers.get === 'function') {
    const value = headers.get(name);
    return value ? [value] : [];
  }
  const target = String(name).toLowerCase();
  const values = [];
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target || value === undefined || value === null) continue;
    if (Array.isArray(value)) values.push(...value.map(String));
    else values.push(String(value));
  }
  return values;
}

function updateCookieJar(input, url, headers) {
  const jar = createCookieJar(input);
  for (const value of headerList(headers, 'set-cookie')) {
    jar.setCookieSync(value, String(url), { ignoreError: true });
  }
  return jar;
}

function cookieRecords(input) {
  const serialized = serializeCookieJar(input);
  return (serialized.cookies || []).map((cookie) => ({
    key: cookie.key,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    expires: cookie.expires,
    maxAge: cookie.maxAge,
    secure: cookie.secure === true,
    httpOnly: cookie.httpOnly === true,
    sameSite: cookie.sameSite,
    hostOnly: cookie.hostOnly === true,
    creation: cookie.creation,
    lastAccessed: cookie.lastAccessed,
  }));
}

module.exports = {
  cookieHeaderFor,
  cookieObjectFor,
  cookieRecords,
  createCookieJar,
  mergeCookieObject,
  serializeCookieJar,
  updateCookieJar,
};
