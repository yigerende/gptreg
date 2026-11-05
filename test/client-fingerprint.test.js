'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');

const {
  CLIENT_PROFILE_SCHEMA_VERSION,
  acceptLanguageFor,
  createClientProfile,
  createFirefox153Profile,
  ensureClientProfile,
  firefoxUserAgent,
  normalizeClientProfile,
  profileFingerprint,
} = require('../src/client-profile');
const { createZonedTimeApis } = require('../src/client-time');
const { createSentinelContext } = require('../src/sentinel-runtime');

function probe(profile) {
  const { context } = createSentinelContext({ profile });
  vm.createContext(context);
  return vm.runInContext(`(() => {
    const gl = document.createElement('canvas').getContext('webgl');
    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      userAgent: navigator.userAgent,
      appVersion: navigator.appVersion,
      oscpu: navigator.oscpu,
      buildID: navigator.buildID,
      productSub: navigator.productSub,
      languages: navigator.languages.join(','),
      cores: navigator.hardwareConcurrency,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      offsetMinutes: new Date().getTimezoneOffset(),
      dateString: new Date().toString(),
      screen: screen.width + 'x' + screen.height,
      devicePixelRatio,
      inner: innerWidth + 'x' + innerHeight,
      glVendor: gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL),
      glRenderer: gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL),
      maskedGlVendor: gl.getParameter(gl.VENDOR),
      maskedGlRenderer: gl.getParameter(gl.RENDERER),
      maxTextureSize: gl.getParameter(0x0D33),
      unknownGlEnum: gl.getParameter(0x9999),
      glExtensions: typeof gl.getSupportedExtensions === 'function' ? gl.getSupportedExtensions().length : null,
      anisotropyExtension: gl.getExtension('EXT_texture_filter_anisotropic') === null ? null : 'present',
      hasOscpu: 'oscpu' in navigator,
      hasBuildId: 'buildID' in navigator,
      sharedPluginArray: navigator.plugins === navigator.mimeTypes,
      plugins: navigator.plugins.length,
      mimeTypes: navigator.mimeTypes.length,
      pdfViewerEnabled: navigator.pdfViewerEnabled,
      font: getComputedStyle(document.body).fontFamily,
      textWidth: document.createElement('canvas').getContext('2d').measureText('abcdefgh').width,
      narrowWidth: document.createElement('canvas').getContext('2d').measureText('iiiiiiii').width,
      wideWidth: document.createElement('canvas').getContext('2d').measureText('WWWWWWWW').width,
      canvas: document.createElement('canvas').toDataURL(),
    };
  })()`, context);
}

test('every profile the pool can draw agrees with itself', () => {
  // A seed sweep rather than a single sample: the pool is a product of four
  // independent draws, and an inconsistent combination is worse than the one
  // fixed profile it replaces, because it is visibly assembled.
  // Every region CLDR knows, not a hand-picked list: the table these draw
  // from is derived, so the sweep has to cover what it can actually produce.
  const countries = [];
  for (let first = 65; first <= 90; first += 1) {
    for (let second = 65; second <= 90; second += 1) countries.push(String.fromCharCode(first, second));
  }
  countries.push('');
  const seen = new Set();
  for (let index = 0; index < 400; index += 1) {
    const country = countries[index % countries.length];
    const profile = createClientProfile({ seed: `sweep-${index}@example.test`, country });
    const normalized = normalizeClientProfile(profile);

    assert.equal(normalized.schemaVersion, CLIENT_PROFILE_SCHEMA_VERSION);
    assert.equal(normalized.userAgent, firefoxUserAgent(Number(normalized.browserVersion.split('.')[0])));
    assert.equal(normalized.acceptLanguage, acceptLanguageFor(normalized.languages));
    assert.equal(normalized.language, normalized.languages[0]);
    assert.equal(normalized.viewport.outerWidth, normalized.screen.width);
    assert.ok(normalized.viewport.innerWidth < normalized.screen.width);
    assert.ok(normalized.viewport.innerHeight < normalized.screen.availHeight);
    assert.ok(normalized.screen.availHeight <= normalized.screen.height);
    assert.match(normalized.gpu.renderer, /^ANGLE \(/);
    assert.doesNotThrow(() => Intl.DateTimeFormat(undefined, { timeZone: normalized.timeZone }));
    seen.add(`${normalized.browserVersion}|${normalized.screen.width}|${normalized.hardwareConcurrency}|${normalized.gpu.renderer}`);
  }
  // …and the sweep must actually spread. A pool that always draws the same
  // machine is the problem it was built to fix.
  assert.ok(seen.size > 20, `pool produced only ${seen.size} distinct machines`);
});

test('an account keeps the machine it was registered on', () => {
  const first = createClientProfile({ seed: 'steady@example.test', country: 'US' });
  const again = createClientProfile({ seed: 'steady@example.test', country: 'US' });
  assert.equal(profileFingerprint(first), profileFingerprint(again));

  const neighbour = createClientProfile({ seed: 'other@example.test', country: 'US' });
  assert.notEqual(profileFingerprint(first), profileFingerprint(neighbour));
});

test('the exit country decides the clock and the language, and an unknown exit changes nothing', () => {
  const american = createClientProfile({ seed: 'exit@example.test', country: 'US' });
  assert.match(american.timeZone, /^America\//);
  assert.equal(american.language, 'en-US');
  assert.equal(american.acceptLanguage, 'en-US,en;q=0.5');

  const unknown = createClientProfile({ seed: 'exit@example.test', country: 'ZZ' });
  assert.equal(unknown.timeZone, 'Asia/Shanghai');
  assert.equal(unknown.language, 'zh-CN');
  // The locale the console used before there was a pool, verbatim.
  assert.equal(unknown.acceptLanguage, createFirefox153Profile().acceptLanguage);
});

test('a profile from before the pool still hashes to what its asset stored', () => {
  // Every registered account carries this hash. Adding a field to the schema-1
  // shape would change all of them at once and lock each account out of its
  // own session, so the legacy shape is frozen and new fields live in schema 2.
  const legacy = createFirefox153Profile();
  assert.equal(
    profileFingerprint(legacy),
    '6250ab3c2499e897bc131d519f33701f40dad489fcddd1fc0d4a6e32e592c074',
  );
  const state = {};
  ensureClientProfile(state, legacy);
  assert.doesNotThrow(() => ensureClientProfile(state, legacy));
});

test('the Sentinel sandbox reports the account, not the machine running the console', () => {
  const profile = createClientProfile({ seed: 'sandbox@example.test', country: 'US' });
  const reported = probe(profile);

  assert.equal(reported.userAgent, profile.userAgent);
  assert.equal(reported.timeZone, profile.timeZone);
  assert.equal(reported.languages, profile.languages.join(','));
  assert.equal(reported.cores, profile.hardwareConcurrency);
  assert.equal(reported.glVendor, profile.gpu.vendor);
  assert.equal(reported.glRenderer, profile.gpu.renderer);
  assert.equal(reported.devicePixelRatio, profile.viewport.devicePixelRatio);
  assert.equal(reported.screen, `${profile.screen.width}x${profile.screen.height}`);
  assert.equal(reported.inner, `${profile.viewport.innerWidth}x${profile.viewport.innerHeight}`);
  assert.equal(reported.oscpu, profile.oscpu);
  assert.equal(reported.buildID, profile.buildId);

  // The offset and the printed zone name have to agree with the zone itself,
  // whatever the host is set to — this suite runs on a UTC box.
  const expectedOffset = -createZonedTimeApis({ timeZone: profile.timeZone }).offsetMinutesAt(Date.now());
  assert.equal(reported.offsetMinutes, expectedOffset);
  // An American profile on a UTC host must not answer UTC's offset: that was
  // the old behaviour, and the guard that hid it refused to run at all here.
  assert.notEqual(expectedOffset, 0);
  assert.match(reported.dateString, /GMT[+-]\d{4} \(/);
});

test('an account registered before the pool presents exactly what it always did', () => {
  // A golden record of the surface as it was, because "unchanged" is a claim
  // that has to be checked rather than described. Several of these values are
  // wrong — the masked WebGL strings answer the way Chrome does, the canvas
  // decodes to a PNG header and nothing else, the text width is linear in
  // character count, and a PDF viewer is advertised with no plugins behind it.
  // They stay wrong for accounts that were registered against them: an account
  // that has signed in with this machine for months is not helped by having it
  // corrected underneath, and the change itself is the risk. The corrections
  // are in the pooled surface, for accounts registered from here on.
  const reported = probe(createFirefox153Profile());
  assert.deepEqual({
    userAgent: reported.userAgent,
    appVersion: reported.appVersion,
    productSub: reported.productSub,
    hasOscpu: reported.hasOscpu,
    hasBuildId: reported.hasBuildId,
    maskedGlVendor: reported.maskedGlVendor,
    maskedGlRenderer: reported.maskedGlRenderer,
    glVendor: reported.glVendor,
    glRenderer: reported.glRenderer,
    maxTextureSize: reported.maxTextureSize,
    unknownGlEnum: reported.unknownGlEnum,
    glExtensions: reported.glExtensions,
    anisotropyExtension: reported.anisotropyExtension,
    plugins: reported.plugins,
    mimeTypes: reported.mimeTypes,
    sharedPluginArray: reported.sharedPluginArray,
    pdfViewerEnabled: reported.pdfViewerEnabled,
    font: reported.font,
    textWidth: reported.textWidth,
    narrowWidth: reported.narrowWidth,
    wideWidth: reported.wideWidth,
    canvas: reported.canvas,
    timeZone: reported.timeZone,
    offsetMinutes: reported.offsetMinutes,
    screen: reported.screen,
    inner: reported.inner,
  }, {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0',
    appVersion: '5.0 (Windows)',
    productSub: '20100101',
    hasOscpu: false,
    hasBuildId: false,
    maskedGlVendor: 'Google Inc. (Intel)',
    maskedGlRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
    glVendor: 'Google Inc. (Intel)',
    glRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)',
    maxTextureSize: 0,
    unknownGlEnum: 0,
    glExtensions: null,
    anisotropyExtension: null,
    plugins: 0,
    mimeTypes: 0,
    sharedPluginArray: true,
    pdfViewerEnabled: true,
    font: 'Arial',
    textWidth: 58,
    narrowWidth: 58,
    wideWidth: 58,
    canvas: 'data:image/png;base64,iVBORw0KGgo=',
    timeZone: 'Asia/Shanghai',
    offsetMinutes: -480,
    screen: '1920x1080',
    inner: '1903x969',
  });
  // …and its stored fingerprint, which every registered account carries, is
  // the one thing that must never move.
  assert.equal(
    profileFingerprint(createFirefox153Profile()),
    '6250ab3c2499e897bc131d519f33701f40dad489fcddd1fc0d4a6e32e592c074',
  );
});

test('a pooled account answers the browser-level questions the way Firefox does', () => {
  // Properties of the browser rather than of the machine, so they are the same
  // for every pooled profile — and every one of them was wrong before.
  for (const seed of ['shape-one@example.test', 'shape-two@example.test']) {
    const reported = probe(createClientProfile({ seed, country: 'GB' }));
    // Firefox masks the card behind `Mozilla`; only the debug extension names
    // it. Answering with the ANGLE strings here is what Chrome does.
    assert.equal(reported.maskedGlVendor, 'Mozilla');
    assert.equal(reported.maskedGlRenderer, 'Mozilla');
    // A browser that advertises a PDF viewer has the five plugin entries the
    // HTML spec pins it to, and their two media types.
    assert.equal(reported.pdfViewerEnabled, true);
    assert.equal(reported.plugins, 5);
    assert.equal(reported.mimeTypes, 2);
    // An unstyled document computes to the default serif, not to Arial.
    assert.equal(reported.font, 'serif');
    // A parameter the context has no value for is `null`, not `0` — zero
    // described a card with no limits at all.
    assert.equal(reported.unknownGlEnum, null);
    assert.ok(reported.glExtensions > 20);
  }
});

test('a canvas produces an image, and two machines do not draw the same one', () => {
  const one = probe(createClientProfile({ seed: 'draw-one@example.test', country: 'US' }));
  const two = probe(createClientProfile({ seed: 'draw-two@example.test', country: 'US' }));
  // The old stub answered with eleven base64 characters that decode to a PNG
  // header and nothing else: a canvas that cannot exist.
  const png = Buffer.from(one.canvas.split(',')[1], 'base64');
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  assert.equal(png.subarray(12, 16).toString('ascii'), 'IHDR');
  assert.ok(png.length > 100);
  assert.notEqual(one.canvas, two.canvas);

  // Text measurement depends on the glyphs, not on how many there are.
  assert.notEqual(one.narrowWidth, one.wideWidth);
  assert.ok(one.wideWidth > one.narrowWidth * 2);
  assert.notEqual(one.wideWidth, two.wideWidth);
});

test('a bad profile is refused rather than sent', () => {
  const profile = createClientProfile({ seed: 'broken@example.test', country: 'GB' });
  assert.throws(() => normalizeClientProfile({ ...profile, userAgent: firefoxUserAgent(99) }), /does not match Firefox/);
  assert.throws(() => normalizeClientProfile({ ...profile, acceptLanguage: 'en' }), /Accept-Language does not match/);
  assert.throws(() => normalizeClientProfile({ ...profile, timeZone: 'Mars/Olympus' }), /not a known zone/);
  assert.throws(
    () => normalizeClientProfile({ ...profile, viewport: { ...profile.viewport, outerWidth: profile.screen.width + 100 } }),
    /must match the screen/,
  );
  assert.throws(
    () => normalizeClientProfile({ ...profile, gpu: { vendor: 'Apple', renderer: 'Apple M2' } }),
    /ANGLE vendor string/,
  );
});

test('the clock follows daylight saving in the zone it claims', () => {
  const { Date: NewYork } = createZonedTimeApis({ timeZone: 'America/New_York', locale: 'en-US' });
  assert.equal(new NewYork('2026-01-15T12:00:00Z').getTimezoneOffset(), 300);
  assert.equal(new NewYork('2026-07-15T12:00:00Z').getTimezoneOffset(), 240);
  // Elapsed time is still real time: only the calendar view moves.
  assert.ok(Math.abs(new NewYork().getTime() - Date.now()) < 1000);
  assert.ok(new NewYork() instanceof Date);
});

test('a country the table never listed gets its own locale, not the fallback', () => {
  // The locale table used to be twenty hand-written countries, so the
  // twenty-first fell through to Chinese: a Mexican exit announcing `zh-CN`
  // and `Asia/Shanghai`, which is worse than having no rule at all. Both
  // halves come out of CLDR now, so a new proxy country needs no code.
  const cases = [
    ['MX', 'es-MX', /^America\//],
    ['PT', 'pt-PT', /^(Europe\/Lisbon|Atlantic\/)/],
    ['VN', 'vi-VN', /^Asia\/Saigon$/],
    ['TR', 'tr-TR', /^Europe\/Istanbul$/],
    ['NG', 'en-NG', /^Africa\/Lagos$/],
    ['PL', 'pl-PL', /^Europe\/Warsaw$/],
  ];
  for (const [country, language, timeZone] of cases) {
    const profile = createClientProfile({ seed: `derived-${country}@example.test`, country });
    assert.equal(profile.language, language, country);
    assert.match(profile.timeZone, timeZone, country);
    assert.equal(profile.acceptLanguage, acceptLanguageFor(profile.languages), country);
  }
  // Only a country CLDR does not know still falls back, and it falls back to
  // what every account carried before there was a pool.
  const unknown = createClientProfile({ seed: 'unknown@example.test', country: 'ZZ' });
  assert.equal(unknown.language, 'zh-CN');
  assert.equal(unknown.timeZone, 'Asia/Shanghai');
});

test('a zone nobody lives in does not get a share of the batch', () => {
  // Drawing evenly from a country's CLDR list put nearly half of Chinese
  // accounts on Ürümqi and half of German ones in a fourteen-hundred-person
  // exclave. The weights are population shares; they only have to be closer
  // to reality than a flat draw.
  const share = (country, zone) => {
    let hits = 0;
    for (let index = 0; index < 400; index += 1) {
      if (createClientProfile({ seed: `share-${index}@example.test`, country }).timeZone === zone) hits += 1;
    }
    return hits / 400;
  };
  assert.ok(share('CN', 'Asia/Shanghai') > 0.9, 'Shanghai should carry China');
  assert.equal(share('DE', 'Europe/Busingen'), 0, 'Büsingen should carry nobody');
  assert.ok(share('US', 'America/New_York') > 0.35, 'the US should lean Eastern');
  assert.ok(share('US', 'America/Adak') === 0, 'and nobody should land on Adak');
  assert.ok(share('AR', 'America/Buenos_Aires') > 0.6, 'Argentina should lean Buenos Aires');
});

test('every country CLDR knows produces a usable profile', () => {
  // 273 regions, and a weight table that names a zone CLDR spells differently
  // fails here rather than silently never being drawn — which is how the
  // Argentine entries were caught.
  let produced = 0;
  for (let first = 65; first <= 90; first += 1) {
    for (let second = 65; second <= 90; second += 1) {
      const country = String.fromCharCode(first, second);
      const profile = createClientProfile({ seed: 'sweep@example.test', country });
      assert.doesNotThrow(() => normalizeClientProfile(profile), country);
      produced += 1;
    }
  }
  assert.equal(produced, 676);
});
