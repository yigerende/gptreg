'use strict';

const crypto = require('node:crypto');
const vm = require('node:vm');

function extractCloudflareParams(html) {
  const match = String(html || '').match(/__CF\$cv\$params=\{r:'([^']+)',t:'([^']+)'\}/);
  return match ? { r: match[1], t: match[2] } : null;
}

function makeElement(tag) {
  return {
    tagName: String(tag || '').toUpperCase(),
    style: {},
    dataset: {},
    attributes: {},
    childNodes: [],
    parentNode: {
      replaceChild() {},
      insertBefore() {},
      removeChild() {},
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
      this[name] = String(value);
    },
    getAttribute(name) {
      return this.attributes[name] || null;
    },
    appendChild(child) {
      this.childNodes.push(child);
      child.parentNode = this;
      return child;
    },
    remove() {},
    addEventListener() {},
    removeEventListener() {},
  };
}

function cookieHeader(cookies) {
  return Object.entries(cookies || {}).map(([name, value]) => `${name}=${value}`).join('; ');
}

function dateClass(nowMs) {
  if (!nowMs) return Date;
  return class FixedDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [nowMs]));
    }

    static now() {
      return nowMs;
    }

    static parse(value) {
      return Date.parse(value);
    }

    static UTC(...args) {
      return Date.UTC(...args);
    }
  };
}

async function buildCloudflareJsdProbe(scriptText, options = {}) {
  if (!options.params?.r || !options.params?.t) {
    throw new Error('Cloudflare JSD probe requires __CF$cv$params r/t');
  }
  const captured = [];
  const scriptUrl = options.scriptUrl || 'https://auth.openai.com/cdn-cgi/challenge-platform/h/g/scripts/jsd/b0da9f4911ba/main.js?';
  const pageUrl = options.pageUrl || 'https://auth.openai.com/log-in';
  const userAgent = options.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0';
  const language = options.language || 'zh-CN';
  const languages = options.languages || ['zh-CN', 'zh', 'en-US', 'en'];
  const screen = options.screen || {};
  const DateImpl = dateClass(options.nowMs);

  class XHR {
    constructor() {
      this.headers = {};
      this.readyState = 0;
      this.status = 0;
      this.responseText = '';
    }

    open(method, url) {
      this.method = method;
      this.url = url;
    }

    setRequestHeader(name, value) {
      this.headers[name] = value;
    }

    send(body) {
      captured.push({
        method: this.method,
        url: this.url,
        headers: this.headers,
        body,
      });
      this.readyState = 4;
      this.status = 204;
      if (typeof this.onreadystatechange === 'function') this.onreadystatechange();
      if (typeof this.onload === 'function') this.onload();
    }

    abort() {}

    getResponseHeader() {
      return null;
    }
  }

  const parsedPage = new URL(pageUrl);
  const head = makeElement('head');
  const body = makeElement('body');
  const documentElement = makeElement('html');
  const currentScript = makeElement('script');
  currentScript.src = scriptUrl;
  const listeners = {};
  const addEventListener = (name, fn) => {
    (listeners[name] ||= []).push(fn);
  };

  const context = {
    XMLHttpRequest: XHR,
    Date: DateImpl,
    Math,
    JSON,
    Array,
    Object,
    Function,
    Promise,
    Error,
    TypeError,
    parseInt,
    parseFloat,
    isNaN,
    encodeURIComponent,
    decodeURIComponent,
    atob: (value) => Buffer.from(String(value), 'base64').toString('binary'),
    btoa: (value) => Buffer.from(String(value), 'binary').toString('base64'),
    crypto: {
      getRandomValues(array) {
        return crypto.webcrypto.getRandomValues(array);
      },
      randomUUID: () => crypto.randomUUID(),
      subtle: crypto.webcrypto.subtle,
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    location: {
      href: pageUrl,
      origin: parsedPage.origin,
      protocol: parsedPage.protocol,
      host: parsedPage.host,
      hostname: parsedPage.hostname,
      pathname: parsedPage.pathname,
      search: parsedPage.search,
      ancestorOrigins: [],
    },
    navigator: {
      userAgent,
      language,
      languages,
      platform: options.platform || 'Win32',
      webdriver: false,
      hardwareConcurrency: Number(options.hardwareConcurrency || 16),
      maxTouchPoints: Number(options.maxTouchPoints || 0),
      cookieEnabled: true,
      pdfViewerEnabled: true,
      plugins: [],
      mimeTypes: [],
    },
    screen: {
      width: Number(screen.width || 1920),
      height: Number(screen.height || 1080),
      availWidth: Number(screen.availWidth || 1920),
      availHeight: Number(screen.availHeight || 1040),
      colorDepth: Number(screen.colorDepth || 24),
      pixelDepth: Number(screen.pixelDepth || 24),
    },
    history: {},
    localStorage: {
      getItem() { return null; },
      setItem() {},
      removeItem() {},
    },
    sessionStorage: {
      getItem() { return null; },
      setItem() {},
      removeItem() {},
    },
    document: {
      readyState: 'complete',
      hidden: false,
      visibilityState: 'visible',
      cookie: cookieHeader(options.cookies),
      documentElement,
      head,
      body,
      currentScript,
      createElement: makeElement,
      getElementsByTagName(name) {
        const lower = String(name).toLowerCase();
        if (lower === 'script') return [currentScript];
        if (lower === 'head') return [head];
        if (lower === 'body') return [body];
        return [];
      },
      querySelector() { return null; },
      querySelectorAll() { return []; },
      addEventListener,
      removeEventListener() {},
    },
    addEventListener,
    removeEventListener() {},
    getComputedStyle() {
      return {};
    },
  };
  context.window = context;
  context.self = context;
  context.top = context;
  context.parent = context;
  context['__CF$cv$params'] = { ...options.params };

  vm.createContext(context);
  vm.runInContext(scriptText, context, { timeout: options.timeoutMs || 5000 });
  await new Promise((resolve) => setTimeout(resolve, options.waitMs || 3500));

  const request = captured.find((item) => item.method === 'POST' && String(item.url || '').includes('/jsd/oneshot/'));
  if (!request) throw new Error('Cloudflare JSD script did not emit an oneshot request');

  const url = new URL(request.url, parsedPage.origin).toString();
  return {
    index: -44,
    method: 'POST',
    url,
    headers: {
      Accept: '*/*',
      'Accept-Language': options.acceptLanguage || 'zh-CN,zh;q=0.9,en-US;q=0.6,en;q=0.5',
      Origin: parsedPage.origin,
      Referer: pageUrl,
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-origin',
      'User-Agent': userAgent,
    },
    cookies: {},
    body: request.body || '',
    contentType: 'text/plain;charset=UTF-8',
    expectStatus: 200,
    redirect: '',
  };
}

module.exports = {
  buildCloudflareJsdProbe,
  extractCloudflareParams,
};
