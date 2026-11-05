'use strict';

const crypto = require('node:crypto');
const vm = require('node:vm');
const { performance: nodePerformance } = require('node:perf_hooks');

const { normalizeClientProfile } = require('./client-profile');
const { createZonedTimeApis } = require('./client-time');
const { createDeviceSurface } = require('./browser-surface');
const { entriesOf } = require('./har');
const { parseUrl } = require('./http-shape');

function cookieHeader(cookies) {
  return Object.entries(cookies || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function createTimerRegistry() {
  const timeouts = new Set();
  const intervals = new Set();

  function setRegisteredTimeout(callback, delay, ...args) {
    let handle;
    handle = setTimeout(() => {
      timeouts.delete(handle);
      callback(...args);
    }, delay);
    timeouts.add(handle);
    return handle;
  }

  function clearRegisteredTimeout(handle) {
    timeouts.delete(handle);
    clearTimeout(handle);
  }

  function setRegisteredInterval(callback, delay, ...args) {
    const handle = setInterval(callback, delay, ...args);
    intervals.add(handle);
    return handle;
  }

  function clearRegisteredInterval(handle) {
    intervals.delete(handle);
    clearInterval(handle);
  }

  function dispose() {
    for (const handle of timeouts) clearTimeout(handle);
    for (const handle of intervals) clearInterval(handle);
    timeouts.clear();
    intervals.clear();
  }

  return {
    clearInterval: clearRegisteredInterval,
    clearTimeout: clearRegisteredTimeout,
    dispose,
    setInterval: setRegisteredInterval,
    setTimeout: setRegisteredTimeout,
  };
}

function createEventHub(now) {
  const listeners = new Map();

  function add(type, callback) {
    if (typeof callback !== 'function') return;
    const bucket = listeners.get(type) || [];
    bucket.push(callback);
    listeners.set(type, bucket);
  }

  function remove(type, callback) {
    const bucket = listeners.get(type) || [];
    listeners.set(type, bucket.filter((candidate) => candidate !== callback));
  }

  async function dispatch(target, type, init = {}) {
    const event = {
      type,
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      timeStamp: now(),
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopImmediatePropagation() {},
      stopPropagation() {},
      ...init,
    };
    for (const callback of [...(listeners.get(type) || [])]) {
      await callback.call(target, event);
    }
    return !event.defaultPrevented;
  }

  return { add, dispatch, remove };
}

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [String(key), String(value)]));
  return {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.has(String(key)) ? values.get(String(key)) : null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(String(key));
    },
    setItem(key, value) {
      values.set(String(key), String(value));
    },
  };
}

function sentinelSdkFromHar(har, options = {}) {
  const match = entriesOf(har).find((entry) => {
    const parsed = parseUrl(entry.request?.url);
    return parsed?.host === 'sentinel.openai.com' && /^\/sentinel\/[^/]+\/sdk\.js$/.test(parsed.pathname);
  });
  if (!match?.response?.content?.text) {
    if (options.optional) return { source: '', url: '' };
    throw new Error('Unable to locate versioned Sentinel SDK in HAR');
  }
  return {
    source: match.response.content.text,
    url: match.request.url,
  };
}

function createElement(tagName, rect) {
  const listeners = new Map();
  const element = {
    tagName: String(tagName || '').toUpperCase(),
    style: {},
    dataset: {},
    attributes: {},
    childNodes: [],
    parentNode: null,
    src: '',
    width: 300,
    height: 150,
    innerText: '',
    textContent: '',
    addEventListener(type, callback) {
      const bucket = listeners.get(type) || [];
      bucket.push(callback);
      listeners.set(type, bucket);
    },
    removeEventListener(type, callback) {
      const bucket = listeners.get(type) || [];
      listeners.set(type, bucket.filter((candidate) => candidate !== callback));
    },
    dispatchLocal(type) {
      for (const callback of [...(listeners.get(type) || [])]) callback.call(element, { type, target: element });
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
      this[name] = String(value);
    },
    getAttribute(name) {
      return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;
    },
    appendChild(child) {
      this.childNodes.push(child);
      child.parentNode = this;
      return child;
    },
    removeChild(child) {
      this.childNodes = this.childNodes.filter((candidate) => candidate !== child);
      child.parentNode = null;
      return child;
    },
    insertBefore(child) {
      return this.appendChild(child);
    },
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    },
    getBoundingClientRect() {
      return {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        top: rect.y,
        left: rect.x,
        right: rect.x + rect.width,
        bottom: rect.y + rect.height,
        toJSON() {
          return { x: this.x, y: this.y, width: this.width, height: this.height };
        },
      };
    },
  };
  return element;
}

function makeCanvasElement(rect, surface) {
  const canvas = createElement('canvas', rect);
  canvas.getContext = (kind) => {
    if (kind === '2d') {
      return {
        canvas,
        fillRect() {},
        clearRect() {},
        fillText() {},
        // Per glyph, not per character count: a linear width is the one thing
        // no real font produces, and it made `iiii` and `WWWW` measure alike.
        measureText: (value) => ({ width: surface.measureText(value) }),
        getImageData: () => ({ data: new Uint8ClampedArray(4) }),
      };
    }
    if (!['webgl', 'webgl2', 'experimental-webgl'].includes(kind)) return null;
    const { webgl } = surface;
    return {
      ...webgl.enums,
      ...(webgl.getSupportedExtensions ? { getSupportedExtensions: webgl.getSupportedExtensions } : {}),
      getExtension: (name) => webgl.getExtension(name),
      getParameter: (parameter) => webgl.getParameter(parameter),
    };
  };
  canvas.toDataURL = () => surface.canvasDataUrl();
  return canvas;
}

/**
 * `navigator.plugins`, which the HTML spec pins to the five PDF viewer entries
 * and their two media types for any browser that can display a PDF.
 */
function makePluginArray(plugins) {
  const array = plugins.map((plugin) => {
    const entry = { ...plugin, length: plugin.mimeTypes.length };
    plugin.mimeTypes.forEach((mime, index) => { entry[index] = mime; });
    entry.item = (index) => plugin.mimeTypes[index] || null;
    entry.namedItem = (name) => plugin.mimeTypes.find((mime) => mime.type === name) || null;
    return entry;
  });
  array.item = (index) => array[index] || null;
  array.namedItem = (name) => array.find((plugin) => plugin.name === name) || null;
  array.refresh = () => {};
  return array;
}

function makeMimeTypeArray(plugins) {
  const seen = new Map();
  for (const plugin of plugins) {
    for (const mime of plugin.mimeTypes) if (!seen.has(mime.type)) seen.set(mime.type, mime);
  }
  const array = [...seen.values()];
  array.item = (index) => array[index] || null;
  array.namedItem = (name) => seen.get(name) || null;
  return array;
}

function createSentinelContext(options = {}) {
  const profile = normalizeClientProfile(options.profile || {});
  const surface = createDeviceSurface(profile);
  // The sandbox gets the account's clock, not the console host's. It used to
  // get the host's and refuse to start unless the two agreed, which made the
  // one field an exit IP can be checked against a property of whichever
  // machine happened to run the console.
  const zoned = createZonedTimeApis({ timeZone: profile.timeZone, locale: profile.language });
  const timers = createTimerRegistry();
  const startedAt = Number(options.timeOrigin || Date.now() - nodePerformance.now());
  const now = () => nodePerformance.now();
  const events = createEventHub(now);
  const bridge = {
    challenge: null,
    proof: '',
    requestProof: '',
  };
  const sdkUrl = options.sdkUrl || 'https://sentinel.openai.com/sentinel/20260810913b/sdk.js';
  const pageUrl = options.pageUrl || 'https://auth.openai.com/log-in';
  const parsedPage = new URL(pageUrl);
  const rect = {
    x: Number(options.rect?.x || 8),
    y: Number(options.rect?.y || 8),
    width: Number(options.rect?.width || profile.viewport.innerWidth - 16),
    height: Number(options.rect?.height || 24),
  };
  let context;

  function iframeElement() {
    const iframe = createElement('iframe', rect);
    const contentWindow = {
      postMessage(message, origin) {
        bridge.proof = String(message?.p || bridge.proof || '');
        const result = bridge.challenge
          ? { cachedChatReq: bridge.challenge, cachedProof: bridge.requestProof || bridge.proof }
          : null;
        timers.setTimeout(() => {
          events.dispatch(context.window, 'message', {
            source: contentWindow,
            origin: origin || 'https://sentinel.openai.com',
            data: { type: 'response', requestId: message?.requestId, result },
          }).catch(() => {});
        }, 0);
      },
    };
    iframe.contentWindow = contentWindow;
    return iframe;
  }

  function elementFactory(tagName) {
    if (String(tagName).toLowerCase() === 'iframe') return iframeElement();
    if (String(tagName).toLowerCase() === 'canvas') return makeCanvasElement(rect, surface);
    return createElement(tagName, rect);
  }

  const currentScript = elementFactory('script');
  currentScript.src = sdkUrl;
  const documentElement = elementFactory('html');
  documentElement.getAttribute = (name) => (name === 'data-build' ? null : null);
  const body = elementFactory('body');
  const originalAppend = body.appendChild.bind(body);
  body.appendChild = (child) => {
    const appended = originalAppend(child);
    if (child.tagName === 'IFRAME') timers.setTimeout(() => child.dispatchLocal('load'), 0);
    return appended;
  };
  const head = elementFactory('head');
  const plugins = makePluginArray(surface.plugins);
  // One array served as both lists for accounts registered before the pool,
  // and their machine does not change underneath them.
  const mimeTypes = surface.sharesPluginArray ? plugins : makeMimeTypeArray(surface.plugins);

  context = {
    console: options.console || { log() {}, warn() {}, error() {} },
    Buffer,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    crypto: crypto.webcrypto,
    Date: zoned.Date,
    Intl: zoned.Intl,
    performance: {
      now,
      timeOrigin: startedAt,
      memory: undefined,
    },
    Math,
    JSON,
    Array,
    Object,
    Reflect,
    Function,
    Promise,
    Error,
    TypeError,
    SyntaxError,
    ReferenceError,
    Number,
    String,
    Boolean,
    Symbol,
    RegExp,
    Map,
    Set,
    WeakMap,
    WeakSet,
    Uint8Array,
    Uint8ClampedArray,
    Int8Array,
    Uint16Array,
    Int16Array,
    Uint32Array,
    Int32Array,
    Float32Array,
    Float64Array,
    encodeURIComponent,
    decodeURIComponent,
    escape,
    unescape,
    parseInt,
    parseFloat,
    isFinite,
    isNaN,
    atob: (value) => Buffer.from(String(value), 'base64').toString('binary'),
    btoa: (value) => Buffer.from(String(value), 'binary').toString('base64'),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    setInterval: timers.setInterval,
    clearInterval: timers.clearInterval,
    queueMicrotask,
    requestAnimationFrame: (callback) => timers.setTimeout(() => callback(now()), 16),
    cancelAnimationFrame: timers.clearTimeout,
    requestIdleCallback: (callback) => timers.setTimeout(() => callback({ timeRemaining: () => 1, didTimeout: false }), 1),
    cancelIdleCallback: timers.clearTimeout,
    fetch: options.fetch || (async () => ({ ok: true, json: async () => ({}) })),
    location: {
      href: pageUrl,
      origin: parsedPage.origin,
      protocol: parsedPage.protocol,
      host: parsedPage.host,
      hostname: parsedPage.hostname,
      pathname: parsedPage.pathname,
      search: parsedPage.search,
      hash: parsedPage.hash,
      ancestorOrigins: [],
      toString() {
        return this.href;
      },
    },
    navigator: {
      userAgent: profile.userAgent,
      userAgentData: undefined,
      appVersion: surface.appVersion,
      // Absent, not empty, on a surface that never defined them.
      ...(surface.oscpu ? { oscpu: surface.oscpu } : {}),
      ...(surface.buildId ? { buildID: surface.buildId } : {}),
      platform: profile.platform,
      vendor: profile.vendor,
      product: profile.product,
      productSub: surface.productSub,
      language: profile.language,
      languages: [...profile.languages],
      hardwareConcurrency: profile.hardwareConcurrency,
      deviceMemory: undefined,
      maxTouchPoints: profile.maxTouchPoints,
      cookieEnabled: true,
      onLine: true,
      webdriver: false,
      plugins,
      mimeTypes,
      pdfViewerEnabled: true,
      permissions: { query: async () => ({ state: 'prompt' }) },
      storage: { estimate: async () => ({ quota: surface.storageQuotaBytes, usage: 0 }) },
    },
    document: null,
    screen: {
      ...profile.screen,
      availLeft: 0,
      availTop: 0,
      orientation: { type: 'landscape-primary', angle: 0 },
    },
    innerWidth: profile.viewport.innerWidth,
    innerHeight: profile.viewport.innerHeight,
    outerWidth: profile.viewport.outerWidth,
    outerHeight: profile.viewport.outerHeight,
    devicePixelRatio: profile.viewport.devicePixelRatio,
    scrollX: 0,
    scrollY: 0,
    history: { length: surface.historyLength, state: null, pushState() {}, replaceState() {}, back() {}, forward() {}, go() {} },
    localStorage: createStorage({ 'oai/language': profile.language }),
    sessionStorage: createStorage(),
    CSS: { supports: () => true },
    matchMedia: (media) => ({ matches: false, media, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }),
    getComputedStyle: () => ({ getPropertyValue: () => '', display: 'block', ...surface.computedStyle }),
    addEventListener: events.add,
    removeEventListener: events.remove,
    dispatchEvent: (event) => events.dispatch(context.window, event.type, event),
    postMessage() {},
    Image: function Image() {
      return elementFactory('img');
    },
    Audio: function Audio() {},
    HTMLElement: function HTMLElement() {},
    HTMLCanvasElement: function HTMLCanvasElement() {},
    WebGLRenderingContext: function WebGLRenderingContext() {},
    Notification: { permission: 'default' },
    InstallTrigger: {},
  };
  context.document = {
    currentScript,
    documentElement,
    body,
    head,
    scripts: [currentScript],
    createElement: elementFactory,
    createElementNS: (_namespace, tagName) => elementFactory(tagName),
    getElementsByTagName: (name) => (name === 'script' ? [currentScript] : name === 'body' ? [body] : name === 'head' ? [head] : []),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener: events.add,
    removeEventListener: events.remove,
    dispatchEvent: (event) => events.dispatch(context.document, event.type, event),
    cookie: cookieHeader(options.cookies),
    visibilityState: 'visible',
    hidden: false,
    readyState: 'complete',
    referrer: options.referrer || '',
    URL: pageUrl,
    location: context.location,
  };
  context.window = context;
  context.self = context;
  context.top = context;
  context.parent = context;
  context.globalThis = context;
  return { bridge, context, events, profile, timers };
}

function decodedVmError(value) {
  const token = String(value || '');
  if (!token) return '';
  let decoded = '';
  try {
    decoded = Buffer.from(token, 'base64').toString('utf8');
  } catch {
    return '';
  }
  return /^\d+:\s*(?:Error|TypeError|SyntaxError|ReferenceError):/.test(decoded) ? decoded.slice(0, 300) : '';
}

function parseEnvelope(value, name) {
  try {
    const parsed = JSON.parse(String(value || ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('non-object');
    return parsed;
  } catch (error) {
    throw new Error(`${name} is not a JSON object: ${error.message}`);
  }
}

function validateBinding(envelope, expected, name) {
  for (const key of ['c', 'id', 'flow']) {
    if (String(envelope[key] || '') !== String(expected[key] || '')) {
      throw new Error(`${name} ${key} binding mismatch`);
    }
  }
}

function validateChallengeTokens(result, challenge, options = {}) {
  const expected = {
    c: String(challenge?.token || ''),
    id: String(options.id || ''),
    flow: String(options.flow || ''),
  };
  if (!expected.c || !expected.id || !expected.flow) {
    throw new Error('Sentinel token validation requires challenge token, device id, and flow');
  }

  const token = parseEnvelope(result.token, 'Sentinel token');
  validateBinding(token, expected, 'Sentinel token');
  if (challenge?.proofofwork?.required && !String(token.p || '')) {
    throw new Error('Sentinel token is missing its enforcement proof');
  }
  if (challenge?.turnstile?.required) {
    if (!String(token.t || '')) throw new Error('Sentinel token is missing its turnstile proof');
    const vmError = decodedVmError(token.t);
    if (vmError) throw new Error(`Sentinel turnstile VM failed: ${vmError}`);
  }

  let soToken = null;
  if (challenge?.so?.required) {
    soToken = parseEnvelope(result.soToken, 'Sentinel SO token');
    validateBinding(soToken, expected, 'Sentinel SO token');
    if (!String(soToken.so || '')) throw new Error('Sentinel SO token is missing its observer proof');
    const vmError = decodedVmError(soToken.so);
    if (vmError) throw new Error(`Sentinel observer VM failed: ${vmError}`);
  }
  return { soToken, token };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout(promise, timeoutMs, label) {
  let handle;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        handle = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(handle);
  }
}

async function dispatchObserverActivity(runtime, durationMs) {
  const { context, events } = runtime;
  const started = Date.now();
  let x = 280;
  let y = 210;
  for (let index = 0; index < 12; index += 1) {
    const dx = crypto.randomInt(4, 16);
    const dy = crypto.randomInt(-3, 10);
    x += dx;
    y += dy;
    await delay(crypto.randomInt(35, 75));
    const coordinates = { clientX: x, clientY: y, screenX: x, screenY: y, movementX: dx, movementY: dy, buttons: 0 };
    await events.dispatch(context.window, 'pointermove', coordinates);
    await events.dispatch(context.window, 'mousemove', coordinates);
  }
  await events.dispatch(context.window, 'click', { clientX: x, clientY: y, screenX: x, screenY: y, button: 0, buttons: 0 });
  for (let index = 0; index < 3; index += 1) {
    context.scrollY += crypto.randomInt(35, 100);
    await events.dispatch(context.window, 'scroll', { scrollX: 0, scrollY: context.scrollY });
    await delay(crypto.randomInt(40, 90));
  }
  await events.dispatch(context.window, 'wheel', { deltaX: 0, deltaY: 96, clientX: x, clientY: y });
  for (const key of ['Tab', 'a', 'Backspace']) {
    await events.dispatch(context.window, 'keydown', {
      key,
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      repeat: false,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    });
    await delay(40);
  }
  const remaining = Math.max(0, Number(durationMs || 0) - (Date.now() - started));
  if (remaining) await delay(remaining);
}

function createSentinelRuntime(sdkSource, options = {}) {
  const source = String(sdkSource || '');
  if (!source.trim()) throw new Error('Sentinel SDK source is empty');
  const runtime = createSentinelContext(options);
  const { bridge, context, timers } = runtime;
  vm.createContext(context);
  vm.runInContext(source, context, { timeout: Number(options.compileTimeoutMs || 10000) });

  const sdk = context.SentinelSDK;
  if (!sdk || typeof sdk.init !== 'function' || typeof sdk.token !== 'function') {
    timers.dispose();
    throw new Error('Sentinel SDK public API is unavailable');
  }

  return {
    profile: runtime.profile,

    setCookies(cookies) {
      context.document.cookie = cookieHeader(cookies);
    },

    setPageContext(page = {}) {
      const nextUrl = String(page.pageUrl || context.location.href || 'https://auth.openai.com/log-in');
      const parsed = new URL(nextUrl);
      context.location.href = nextUrl;
      context.location.origin = parsed.origin;
      context.location.protocol = parsed.protocol;
      context.location.host = parsed.host;
      context.location.hostname = parsed.hostname;
      context.location.pathname = parsed.pathname;
      context.location.search = parsed.search;
      context.location.hash = parsed.hash;
      context.document.URL = nextUrl;
      context.document.location = context.location;
      context.document.referrer = String(page.referrer || '');
    },

    async getRequirementsToken(flow) {
      if (!flow) throw new Error('Sentinel requirements proof requires a flow');
      bridge.challenge = null;
      bridge.proof = '';
      bridge.requestProof = '';
      await withTimeout(Promise.resolve(sdk.init(flow)), Number(options.operationTimeoutMs || 15000), 'SentinelSDK.init');
      if (!bridge.proof) throw new Error('SentinelSDK.init returned no requirements proof');
      return bridge.proof;
    },

    async getChallengeTokens(flow, challenge, requestProof, tokenOptions = {}) {
      const id = String(tokenOptions.id || '');
      if (!flow || !id || !requestProof) {
        throw new Error('Sentinel challenge token requires flow, device id, and matching requirements proof');
      }
      bridge.challenge = challenge;
      bridge.proof = '';
      bridge.requestProof = requestProof;
      const token = await withTimeout(Promise.resolve(sdk.token(flow)), Number(options.operationTimeoutMs || 15000), 'SentinelSDK.token');
      let soToken = '';
      if (challenge?.so?.required) {
        if (typeof sdk.sessionObserverToken !== 'function') {
          throw new Error('Sentinel SDK does not expose sessionObserverToken for a required SO challenge');
        }
        await dispatchObserverActivity(runtime, Number(tokenOptions.behaviorDurationMs ?? options.behaviorDurationMs ?? 4200));
        soToken = await withTimeout(
          Promise.resolve(sdk.sessionObserverToken(flow)),
          Number(options.operationTimeoutMs || 15000),
          'SentinelSDK.sessionObserverToken',
        );
      }
      const result = { token, soToken };
      validateChallengeTokens(result, challenge, { flow, id });
      return result;
    },

    dispose() {
      timers.dispose();
    },
  };
}

module.exports = {
  // Exported so the fingerprint the sandbox presents can be asserted directly,
  // rather than only through whatever a live SDK happens to read from it.
  createSentinelContext,
  createSentinelRuntime,
  sentinelSdkFromHar,
  validateChallengeTokens,
};
