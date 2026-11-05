'use strict';

const crypto = require('node:crypto');
const { cloneJson, deleteHeader } = require('./util/shared');

const FIREFOX_153_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0';
const FIREFOX_ACCEPT_LANGUAGE = 'zh-CN,zh;q=0.9,zh-TW;q=0.8,zh-HK;q=0.7,en-US;q=0.6,en;q=0.5';

const CLIENT_PROFILE_SCHEMA_VERSION = 2;

/**
 * Firefox reports every 64-bit Windows the same way — Windows 11 still says
 * `Windows NT 10.0` — so there is exactly one Windows string to produce and
 * nothing here to vary. Inventing variation would be the inconsistency, not
 * the realism.
 */
const WINDOWS = Object.freeze({
  uaPlatform: 'Windows NT 10.0; Win64; x64',
  platform: 'Win32',
  oscpu: 'Windows NT 10.0; Win64; x64',
  appVersion: '5.0 (Windows)',
});

/** Frozen for privacy in every Firefox since 64; it is not a build stamp. */
const FIREFOX_BUILD_ID = '20181001000000';
const GECKO_TRAIL = '20100101';
const PRODUCT_SUB = '20100101';

/**
 * Release-channel Firefox, newest first.
 *
 * `rv` tracks the release version again — the operator's own September capture
 * shows `rv:156.0` with `Firefox/156.0` — so both are derived from one number
 * rather than stored twice and left free to drift apart. The weights are a
 * lag curve, not a uniform draw: most people are on the newest release and a
 * long tail is a few versions behind, which is also why a pool pinned to one
 * version reads as a fleet rather than as people.
 */
const FIREFOX_RELEASES = Object.freeze([
  Object.freeze({ version: 156, weight: 6 }),
  Object.freeze({ version: 155, weight: 3 }),
  Object.freeze({ version: 154, weight: 2 }),
  Object.freeze({ version: 153, weight: 1 }),
]);

/**
 * Screens as Firefox reports them: CSS pixels, already divided by the Windows
 * display scale, with `devicePixelRatio` carrying the scale. A 1920×1080 panel
 * at 125% is 1536×864 with a ratio of 1.25 — pairing the two is what keeps a
 * profile from claiming a resolution no real display produces.
 *
 * `availHeight` is the work area left by the taskbar; `availWidth` equals the
 * full width because a Windows taskbar is horizontal by default.
 */
const SCREENS = Object.freeze([
  Object.freeze({ width: 1920, height: 1080, availHeight: 1040, devicePixelRatio: 1, weight: 6 }),
  Object.freeze({ width: 1536, height: 864, availHeight: 824, devicePixelRatio: 1.25, weight: 5 }),
  Object.freeze({ width: 1366, height: 768, availHeight: 728, devicePixelRatio: 1, weight: 3 }),
  Object.freeze({ width: 2560, height: 1440, availHeight: 1400, devicePixelRatio: 1, weight: 2 }),
  Object.freeze({ width: 1280, height: 720, availHeight: 680, devicePixelRatio: 1.5, weight: 2 }),
  Object.freeze({ width: 1707, height: 960, availHeight: 920, devicePixelRatio: 1.5, weight: 1 }),
]);

/**
 * Window chrome, in CSS pixels, measured off the captured session: a
 * 1920×1080 screen with a 1040 work area reported `innerWidth` 1903 and
 * `innerHeight` 969. Both deltas are CSS-pixel constants — Windows scales the
 * scrollbar and the toolbars with the display, so they do not move with the
 * device pixel ratio.
 */
const SCROLLBAR_WIDTH = 17;
const BROWSER_CHROME_HEIGHT = 71;

/**
 * GPU and core count together, because they correlate in the wild: a 24-thread
 * workstation does not usually render through integrated Intel graphics. Both
 * reach the Sentinel sandbox — `hardwareConcurrency` on `navigator`, the
 * renderer through `WEBGL_debug_renderer_info` — so a pair that cannot exist
 * is a pair that can be noticed.
 *
 * Firefox on Windows renders through ANGLE, so the unmasked strings carry
 * ANGLE's own `Google Inc. (<vendor>)` form.
 */
const DEVICES = Object.freeze([
  Object.freeze({
    gpuVendor: 'Google Inc. (Intel)',
    gpuRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
    cores: Object.freeze([4, 8, 12, 16]),
    weight: 5,
  }),
  Object.freeze({
    gpuVendor: 'Google Inc. (Intel)',
    gpuRenderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
    cores: Object.freeze([8, 12, 16]),
    weight: 4,
  }),
  Object.freeze({
    gpuVendor: 'Google Inc. (NVIDIA)',
    gpuRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    cores: Object.freeze([12, 16, 20, 24]),
    weight: 3,
  }),
  Object.freeze({
    gpuVendor: 'Google Inc. (NVIDIA)',
    gpuRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    cores: Object.freeze([6, 8, 12]),
    weight: 2,
  }),
  Object.freeze({
    gpuVendor: 'Google Inc. (AMD)',
    gpuRenderer: 'ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
    cores: Object.freeze([8, 12, 16]),
    weight: 2,
  }),
]);

/**
 * What a browser in a given country looks like.
 *
 * The exit decides this, not the machine running the console: an American IP
 * whose browser reports `Asia/Shanghai` and `zh-CN` has contradicted itself
 * before it has done anything.
 *
 * This was a hand-written table of twenty countries, which meant the
 * twenty-first silently fell back to Chinese — a Mexican exit announcing
 * `zh-CN` and `Asia/Shanghai`, which is worse than having no rule at all.
 * Both halves come out of the platform's own CLDR data instead: `maximize()`
 * names the language a region most likely speaks, and `Intl.Locale.timeZones`
 * lists every IANA zone the region uses. That covers 273 regions rather than
 * twenty, and a new proxy country needs no code.
 */

/**
 * Where the derived language list is not the whole story.
 *
 * `maximize()` gives one language, and these are the places where a second is
 * common enough that a browser reporting only the first looks thin — or, for
 * India, where the likeliest language of the population is not the likeliest
 * language of someone signing up for this.
 */
const LANGUAGE_OVERRIDES = Object.freeze({
  CA: Object.freeze(['en-CA', 'en', 'fr-CA', 'fr']),
  SG: Object.freeze(['en-SG', 'en', 'zh-CN', 'zh']),
  IN: Object.freeze(['en-IN', 'en', 'hi-IN', 'hi']),
  CN: Object.freeze(['zh-CN', 'zh', 'zh-TW', 'zh-HK', 'en-US', 'en']),
});

/**
 * Roughly where a country's people are, for the countries that span zones.
 *
 * CLDR lists a region's zones alphabetically, so drawing from it uniformly
 * puts eight percent of Argentine accounts in La Rioja and three percent of
 * American ones on an Aleutian island. These are population shares, rounded;
 * they only have to be closer to reality than a flat draw. A country that is
 * not here uses its full CLDR list, which for 231 of the 273 regions is a
 * single zone anyway.
 *
 * Every zone named here is checked against CLDR's list for that country at
 * startup, so a zone that gets renamed or misspelled fails loudly instead of
 * quietly never being drawn.
 */
const ZONE_WEIGHTS = Object.freeze({
  US: Object.freeze({ 'America/New_York': 47, 'America/Chicago': 29, 'America/Los_Angeles': 16, 'America/Denver': 6, 'America/Phoenix': 2 }),
  CA: Object.freeze({ 'America/Toronto': 62, 'America/Vancouver': 14, 'America/Edmonton': 12, 'America/Halifax': 7, 'America/Winnipeg': 4, 'America/St_Johns': 1 }),
  AU: Object.freeze({ 'Australia/Sydney': 32, 'Australia/Melbourne': 26, 'Australia/Brisbane': 20, 'Australia/Perth': 11, 'Australia/Adelaide': 7, 'Australia/Hobart': 3, 'Australia/Darwin': 1 }),
  BR: Object.freeze({ 'America/Sao_Paulo': 75, 'America/Fortaleza': 8, 'America/Recife': 5, 'America/Manaus': 4, 'America/Bahia': 4, 'America/Belem': 4 }),
  RU: Object.freeze({ 'Europe/Moscow': 62, 'Asia/Yekaterinburg': 10, 'Asia/Novosibirsk': 7, 'Asia/Krasnoyarsk': 6, 'Europe/Samara': 5, 'Asia/Vladivostok': 4, 'Asia/Omsk': 3, 'Asia/Irkutsk': 3 }),
  MX: Object.freeze({ 'America/Mexico_City': 75, 'America/Tijuana': 6, 'America/Monterrey': 6, 'America/Merida': 4, 'America/Cancun': 3, 'America/Chihuahua': 3, 'America/Mazatlan': 3 }),
  ID: Object.freeze({ 'Asia/Jakarta': 80, 'Asia/Makassar': 12, 'Asia/Pontianak': 5, 'Asia/Jayapura': 3 }),
  CL: Object.freeze({ 'America/Santiago': 93, 'America/Punta_Arenas': 5, 'America/Coyhaique': 2 }),
  PT: Object.freeze({ 'Europe/Lisbon': 95, 'Atlantic/Madeira': 3, 'Atlantic/Azores': 2 }),
  ES: Object.freeze({ 'Europe/Madrid': 96, 'Atlantic/Canary': 4 }),
  NZ: Object.freeze({ 'Pacific/Auckland': 99, 'Pacific/Chatham': 1 }),
  // CLDR keeps Argentina's biggest cities on the older, shorter spellings and
  // only the provinces under `America/Argentina/`. The check below is what
  // caught that; the names are not guessable from the pattern.
  AR: Object.freeze({ 'America/Buenos_Aires': 75, 'America/Cordoba': 10, 'America/Mendoza': 5, 'America/Argentina/Salta': 4, 'America/Argentina/Tucuman': 3, 'America/Jujuy': 2, 'America/Argentina/San_Juan': 1 }),
  KZ: Object.freeze({ 'Asia/Almaty': 65, 'Asia/Aqtobe': 10, 'Asia/Qostanay': 6, 'Asia/Atyrau': 6, 'Asia/Aqtau': 5, 'Asia/Oral': 4, 'Asia/Qyzylorda': 4 }),
  // Ürümqi is a real Chinese zone and about one person in seventy lives on it;
  // an even draw would have put nearly half of them there, on an offset a
  // Chinese exit almost never reports.
  CN: Object.freeze({ 'Asia/Shanghai': 98, 'Asia/Urumqi': 2 }),
  // Büsingen is a German exclave of fourteen hundred people. It is the other
  // half of Germany's CLDR list.
  DE: Object.freeze({ 'Europe/Berlin': 100 }),
  UA: Object.freeze({ 'Europe/Kiev': 95, 'Europe/Simferopol': 5 }),
  MY: Object.freeze({ 'Asia/Kuala_Lumpur': 80, 'Asia/Kuching': 20 }),
  EC: Object.freeze({ 'America/Guayaquil': 99, 'Pacific/Galapagos': 1 }),
  UZ: Object.freeze({ 'Asia/Tashkent': 85, 'Asia/Samarkand': 15 }),
  MN: Object.freeze({ 'Asia/Ulaanbaatar': 90, 'Asia/Hovd': 10 }),
  CY: Object.freeze({ 'Asia/Nicosia': 97, 'Asia/Famagusta': 3 }),
  CD: Object.freeze({ 'Africa/Kinshasa': 70, 'Africa/Lubumbashi': 30 }),
  PG: Object.freeze({ 'Pacific/Port_Moresby': 98, 'Pacific/Bougainville': 2 }),
  PS: Object.freeze({ 'Asia/Gaza': 55, 'Asia/Hebron': 45 }),
  GL: Object.freeze({ 'America/Godthab': 90, 'America/Thule': 5, 'America/Scoresbysund': 3, 'America/Danmarkshavn': 2 }),
  PH: Object.freeze({ 'Asia/Manila': 100 }),
});

/**
 * Where a profile lands when nothing says which exit it is for.
 *
 * This is the locale every account carried before there was a pool, so an
 * unknown exit changes nothing rather than silently moving an account to a
 * different clock.
 */
const DEFAULT_LOCALE_COUNTRY = 'CN';

function regionOf(country) {
  const code = String(country || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return '';
  try {
    const locale = new Intl.Locale(`und-${code}`);
    return locale.timeZones?.length ? code : '';
  } catch {
    return '';
  }
}

function derivedLanguages(country) {
  if (LANGUAGE_OVERRIDES[country]) return [...LANGUAGE_OVERRIDES[country]];
  const language = new Intl.Locale(`und-${country}`).maximize().language;
  const primary = `${language}-${country}`;
  // A non-English browser keeps English behind its own language, the way a
  // real one configured outside the anglosphere does.
  return language === 'en' ? [primary, 'en'] : [primary, language, 'en-US', 'en'];
}

function weightedZones(country) {
  const available = new Intl.Locale(`und-${country}`).timeZones || [];
  const weights = ZONE_WEIGHTS[country];
  if (!weights) return available.map((zone) => ({ zone, weight: 1 }));
  const entries = Object.entries(weights).map(([zone, weight]) => ({ zone, weight }));
  const unknown = entries.filter((entry) => !available.includes(entry.zone)).map((entry) => entry.zone);
  if (unknown.length) throw new Error(`Zone weights for ${country} name zones CLDR does not list: ${unknown.join(', ')}`);
  return entries;
}

/** One country's browser settings, derived once and reused. */
const localeCache = new Map();

function localeFor(country) {
  const region = regionOf(country) || DEFAULT_LOCALE_COUNTRY;
  if (!localeCache.has(region)) {
    localeCache.set(region, { languages: derivedLanguages(region), zones: weightedZones(region) });
  }
  return localeCache.get(region);
}

/** Firefox's quota is a share of free disk, so it differs per machine. */
const STORAGE_QUOTAS = Object.freeze([
  Object.freeze({ bytes: 274877906944, weight: 4 }),
  Object.freeze({ bytes: 137438953472, weight: 3 }),
  Object.freeze({ bytes: 549755813888, weight: 2 }),
  Object.freeze({ bytes: 68719476736, weight: 2 }),
  Object.freeze({ bytes: 1099511627776, weight: 1 }),
]);

function firefoxUserAgent(version) {
  return `Mozilla/5.0 (${WINDOWS.uaPlatform}; rv:${version}.0) Gecko/${GECKO_TRAIL} Firefox/${version}.0`;
}

/**
 * Firefox's own Accept-Language shape: the first language carries no `q`, the
 * last carries `q=0.5`, and each step back adds a tenth. Two entries give
 * `en-US,en;q=0.5`; the six-entry Chinese list gives exactly the header in the
 * captured session. Deriving it means `navigator.languages` and the header can
 * never disagree — they are the same list.
 */
function acceptLanguageFor(languages) {
  const list = languages.map(String);
  return list
    .map((language, index) => {
      if (index === 0) return language;
      const quality = Math.min(0.9, 0.5 + (list.length - 1 - index) / 10);
      return `${language};q=${quality.toFixed(1).replace(/0$/, '')}`;
    })
    .join(',');
}

function seededBytes(seed, label) {
  return crypto.createHash('sha256').update(`${String(seed)}\u0000${String(label)}`).digest();
}

function seededIndex(seed, label, total) {
  if (total <= 0) return 0;
  return seededBytes(seed, label).readUInt32BE(0) % total;
}

/**
 * A weighted draw that is a pure function of the seed.
 *
 * The seed is the account, so an account that restarts — a new exit, an
 * expired email code, a rebind months later — rebuilds the same machine
 * instead of appearing to have bought a new one.
 */
function weightedPick(seed, label, table) {
  const total = table.reduce((sum, item) => sum + item.weight, 0);
  let cursor = seededIndex(seed, label, total);
  for (const item of table) {
    if (cursor < item.weight) return item;
    cursor -= item.weight;
  }
  return table[table.length - 1];
}

function viewportFor(screen) {
  return {
    innerWidth: screen.width - SCROLLBAR_WIDTH,
    innerHeight: screen.availHeight - BROWSER_CHROME_HEIGHT,
    outerWidth: screen.width,
    outerHeight: screen.height,
    devicePixelRatio: screen.devicePixelRatio,
  };
}

/**
 * One coherent machine, drawn from the pool by seed.
 *
 * Every field that reaches the wire or the Sentinel sandbox is derived here
 * from the same few draws, so nothing downstream has to remember to keep two
 * values in step: the user agent comes from the version, the header from the
 * language list, the viewport from the screen, the renderer from the device.
 */
function createClientProfile(options = {}) {
  const seed = String(options.seed || crypto.randomUUID());
  const locale = localeFor(options.country);
  const release = weightedPick(seed, 'firefox-release', FIREFOX_RELEASES);
  const screen = weightedPick(seed, 'screen', SCREENS);
  const device = weightedPick(seed, 'device', DEVICES);
  const quota = weightedPick(seed, 'storage-quota', STORAGE_QUOTAS);
  const languages = [...locale.languages];
  const timeZone = weightedPick(seed, 'time-zone', locale.zones).zone;
  const hardwareConcurrency = device.cores[seededIndex(seed, 'cores', device.cores.length)];

  return {
    schemaVersion: CLIENT_PROFILE_SCHEMA_VERSION,
    browser: 'firefox',
    browserVersion: `${release.version}.0`,
    userAgent: firefoxUserAgent(release.version),
    platform: WINDOWS.platform,
    vendor: '',
    product: 'Gecko',
    productSub: PRODUCT_SUB,
    appVersion: WINDOWS.appVersion,
    oscpu: WINDOWS.oscpu,
    buildId: FIREFOX_BUILD_ID,
    language: languages[0],
    languages,
    acceptLanguage: acceptLanguageFor(languages),
    timeZone,
    hardwareConcurrency,
    maxTouchPoints: 0,
    screen: {
      width: screen.width,
      height: screen.height,
      availWidth: screen.width,
      availHeight: screen.availHeight,
      colorDepth: 24,
      pixelDepth: 24,
    },
    viewport: viewportFor(screen),
    gpu: { vendor: device.gpuVendor, renderer: device.gpuRenderer },
    storageQuotaBytes: quota.bytes,
  };
}

function createFirefox153Profile(overrides = {}) {
  const screen = overrides.screen || {};
  const viewport = overrides.viewport || {};
  return {
    schemaVersion: 1,
    browser: 'firefox',
    browserVersion: '153.0',
    userAgent: FIREFOX_153_USER_AGENT,
    platform: 'Win32',
    vendor: '',
    product: 'Gecko',
    language: 'zh-CN',
    languages: ['zh-CN', 'zh', 'zh-TW', 'zh-HK', 'en-US', 'en'],
    acceptLanguage: FIREFOX_ACCEPT_LANGUAGE,
    timeZone: 'Asia/Shanghai',
    hardwareConcurrency: 16,
    maxTouchPoints: 0,
    screen: {
      width: Number(screen.width || 1920),
      height: Number(screen.height || 1080),
      availWidth: Number(screen.availWidth || screen.width || 1920),
      availHeight: Number(screen.availHeight || 1040),
      colorDepth: 24,
      pixelDepth: 24,
    },
    viewport: {
      innerWidth: Number(viewport.innerWidth || 1903),
      innerHeight: Number(viewport.innerHeight || 969),
      outerWidth: Number(viewport.outerWidth || screen.width || 1920),
      outerHeight: Number(viewport.outerHeight || screen.height || 1080),
      devicePixelRatio: 1,
    },
  };
}

function assertPositiveNumbers(profile) {
  for (const [name, number] of [
    ...Object.entries(profile.screen).map(([key, number]) => [`screen.${key}`, number]),
    ...Object.entries(profile.viewport).map(([key, number]) => [`viewport.${key}`, number]),
  ]) {
    if (!Number.isFinite(number) || number <= 0) throw new Error(`Firefox client profile ${name} must be positive`);
  }
  if (profile.viewport.innerWidth > profile.viewport.outerWidth || profile.viewport.innerHeight > profile.viewport.outerHeight) {
    throw new Error('Firefox client profile viewport cannot exceed its outer window');
  }
}

/**
 * The profile every account carried before the pool existed.
 *
 * Its normalized shape is frozen on purpose: an account's stored
 * `clientProfileFingerprint` is a hash of this object, and adding a field here
 * would change every hash on disk and lock every existing account out of its
 * own session. New fields belong to schema 2.
 */
function normalizeLegacyProfile(value = {}) {
  const profile = createFirefox153Profile(value);
  const immutable = [
    ['schemaVersion', value.schemaVersion, profile.schemaVersion],
    ['browser', value.browser, profile.browser],
    ['browserVersion', value.browserVersion, profile.browserVersion],
    ['userAgent', value.userAgent, profile.userAgent],
    ['platform', value.platform, profile.platform],
    ['vendor', value.vendor, profile.vendor],
    ['product', value.product, profile.product],
  ];
  for (const [name, actual, expected] of immutable) {
    if (actual !== undefined && actual !== expected) {
      throw new Error(`Firefox client profile drifted at ${name}`);
    }
  }

  if (Array.isArray(value.languages) && value.languages.length) {
    profile.languages = value.languages.map(String);
  }
  if (value.language !== undefined) profile.language = String(value.language);
  if (value.acceptLanguage !== undefined) profile.acceptLanguage = String(value.acceptLanguage);
  if (value.timeZone !== undefined) profile.timeZone = String(value.timeZone);
  if (value.hardwareConcurrency !== undefined) profile.hardwareConcurrency = Number(value.hardwareConcurrency);
  if (value.maxTouchPoints !== undefined) profile.maxTouchPoints = Number(value.maxTouchPoints);

  if (!profile.languages.includes(profile.language)) {
    throw new Error('Firefox client profile languages must include its primary language');
  }
  if (!Number.isInteger(profile.hardwareConcurrency) || profile.hardwareConcurrency < 1) {
    throw new Error('Firefox client profile hardwareConcurrency must be a positive integer');
  }
  if (!Number.isInteger(profile.maxTouchPoints) || profile.maxTouchPoints < 0) {
    throw new Error('Firefox client profile maxTouchPoints must be a non-negative integer');
  }
  assertPositiveNumbers(profile);
  return profile;
}

function knownTimeZone(value) {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check a pooled profile against itself.
 *
 * Every rule here is a pair of fields a fingerprinter can compare: the user
 * agent against the version it claims, the Accept-Language header against the
 * language list the page will read, the window against the screen it sits on,
 * the renderer against the platform it renders on. A profile that fails one of
 * these is worse than the single fixed profile it replaced, because it is
 * visibly assembled.
 */
function normalizePooledProfile(value = {}) {
  const profile = cloneJson(value);
  profile.schemaVersion = CLIENT_PROFILE_SCHEMA_VERSION;

  const version = String(profile.browserVersion || '');
  const release = /^(\d+)\.0$/.exec(version);
  if (profile.browser !== 'firefox') throw new Error(`Client profile browser must be firefox, got ${profile.browser}`);
  if (!release) throw new Error(`Client profile browserVersion must look like "156.0", got ${version}`);
  if (profile.userAgent !== firefoxUserAgent(Number(release[1]))) {
    throw new Error(`Client profile user agent does not match Firefox ${version}`);
  }
  if (profile.platform !== WINDOWS.platform) throw new Error(`Client profile platform must be ${WINDOWS.platform}`);
  if (profile.oscpu !== WINDOWS.oscpu) throw new Error(`Client profile oscpu must be ${WINDOWS.oscpu}`);
  if (profile.appVersion !== WINDOWS.appVersion) throw new Error(`Client profile appVersion must be ${WINDOWS.appVersion}`);
  if (profile.vendor !== '') throw new Error('Client profile vendor must be empty on Firefox');
  if (profile.product !== 'Gecko') throw new Error('Client profile product must be Gecko');
  if (profile.productSub !== PRODUCT_SUB) throw new Error(`Client profile productSub must be ${PRODUCT_SUB} on Firefox`);
  if (profile.buildId !== FIREFOX_BUILD_ID) throw new Error(`Client profile buildId must be ${FIREFOX_BUILD_ID} on Firefox`);

  const languages = Array.isArray(profile.languages) ? profile.languages.map(String) : [];
  if (!languages.length) throw new Error('Client profile needs at least one language');
  if (profile.language !== languages[0]) throw new Error('Client profile language must be the first of its languages');
  if (profile.acceptLanguage !== acceptLanguageFor(languages)) {
    throw new Error('Client profile Accept-Language does not match its language list');
  }
  profile.languages = languages;

  if (!knownTimeZone(profile.timeZone)) throw new Error(`Client profile time zone is not a known zone: ${profile.timeZone}`);

  if (!Number.isInteger(profile.hardwareConcurrency) || profile.hardwareConcurrency < 1) {
    throw new Error('Client profile hardwareConcurrency must be a positive integer');
  }
  if (!Number.isInteger(profile.maxTouchPoints) || profile.maxTouchPoints < 0) {
    throw new Error('Client profile maxTouchPoints must be a non-negative integer');
  }
  if (!Number.isInteger(profile.storageQuotaBytes) || profile.storageQuotaBytes <= 0) {
    throw new Error('Client profile storageQuotaBytes must be a positive integer');
  }

  assertPositiveNumbers(profile);
  const { screen, viewport } = profile;
  if (screen.availWidth !== screen.width) throw new Error('Client profile availWidth must equal its screen width');
  if (screen.availHeight > screen.height) throw new Error('Client profile work area cannot exceed its screen');
  if (viewport.outerWidth !== screen.width || viewport.outerHeight !== screen.height) {
    throw new Error('Client profile window must match the screen it is maximized on');
  }
  if (viewport.innerWidth !== screen.width - SCROLLBAR_WIDTH) {
    throw new Error('Client profile viewport width must leave room for exactly one scrollbar');
  }
  if (viewport.innerHeight !== screen.availHeight - BROWSER_CHROME_HEIGHT) {
    throw new Error('Client profile viewport height must leave room for the browser chrome');
  }
  if (!(viewport.devicePixelRatio > 0)) throw new Error('Client profile devicePixelRatio must be positive');

  const gpu = profile.gpu || {};
  if (!/^Google Inc\. \(/.test(String(gpu.vendor || ''))) {
    throw new Error('Client profile GPU vendor must be an ANGLE vendor string');
  }
  if (!/^ANGLE \(/.test(String(gpu.renderer || ''))) {
    throw new Error('Client profile GPU renderer must be an ANGLE renderer string');
  }
  profile.gpu = { vendor: String(gpu.vendor), renderer: String(gpu.renderer) };
  return profile;
}

/** Legacy profiles keep their old shape; pooled ones are checked against theirs. */
function normalizeClientProfile(value = {}) {
  return Number(value?.schemaVersion || 1) >= CLIENT_PROFILE_SCHEMA_VERSION
    ? normalizePooledProfile(value)
    : normalizeLegacyProfile(value);
}

function profileFingerprint(profile) {
  const normalized = normalizeClientProfile(profile);
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

function ensureClientProfile(state, supplied) {
  const existing = state.clientProfile;
  const normalized = normalizeClientProfile(existing || supplied || {});
  const fingerprint = profileFingerprint(normalized);
  if (state.clientProfileFingerprint && state.clientProfileFingerprint !== fingerprint) {
    throw new Error('Firefox client profile fingerprint changed within the same runner');
  }
  state.clientProfile = cloneJson(normalized);
  state.clientProfileFingerprint = fingerprint;
  return state.clientProfile;
}

function setHeader(headers, name, value) {
  const match = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
  if (match && match !== name) delete headers[match];
  headers[name] = value;
}

function applyBrowserHeaders(request, profile) {
  const normalized = normalizeClientProfile(profile);
  request.headers = request.headers || {};
  setHeader(request.headers, 'User-Agent', normalized.userAgent);
  setHeader(request.headers, 'Accept-Language', normalized.acceptLanguage);
  deleteHeader(request.headers, 'sec-ch-ua');
  deleteHeader(request.headers, 'sec-ch-ua-mobile');
  deleteHeader(request.headers, 'sec-ch-ua-platform');
  return request;
}

module.exports = {
  CLIENT_PROFILE_SCHEMA_VERSION,
  FIREFOX_153_USER_AGENT,
  FIREFOX_RELEASES,
  acceptLanguageFor,
  applyBrowserHeaders,
  createClientProfile,
  createFirefox153Profile,
  ensureClientProfile,
  firefoxUserAgent,
  normalizeClientProfile,
  profileFingerprint,
};
