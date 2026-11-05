'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { LinkOpsClient, isOfflineError } = require('../src/linkops-client');
const { LinkOpsService } = require('../src/ui-server/linkops-service');

function configService(linkops = {}) {
  return { readRaw: () => ({ linkops }) };
}

/** A fetch stub that answers one canned response, or refuses the connection. */
function fetchStub(handler) {
  return async (url, init = {}) => handler(String(url), init);
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

test('a service that is not running reads as offline rather than as an error', async () => {
  const service = new LinkOpsService({
    configService: configService({ baseUrl: 'http://127.0.0.1:8082' }),
    clientFactory: (settings) => new LinkOpsClient({
      ...settings,
      fetch: fetchStub(() => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); }),
    }),
  });
  const status = await service.status();
  assert.equal(status.online, false);
  assert.equal(status.canStart, false, 'no start command configured');
  assert.match(status.reason, /无法连接 LinkOps/);
});

test('a healthy service reports its provider catalog alongside health', async () => {
  const service = new LinkOpsService({
    configService: configService({ baseUrl: 'http://127.0.0.1:8082', startCommand: 'C:/x/start.bat' }),
    clientFactory: (settings) => new LinkOpsClient({
      ...settings,
      fetch: fetchStub((url) => {
        if (url.endsWith('/health')) return jsonResponse({ ok: true, service: 'linkops' });
        if (url.endsWith('/modules')) return jsonResponse({ modules: [{ id: 'extraction', providers: [{ id: 'paypal' }] }] });
        throw new Error(`unexpected ${url}`);
      }),
    }),
  });
  const status = await service.status();
  assert.equal(status.online, true);
  assert.equal(status.canStart, true);
  assert.equal(status.modules[0].id, 'extraction');
});

test('a rejected call is distinguished from a service that never answered', async () => {
  const client = new LinkOpsClient({
    baseUrl: 'http://127.0.0.1:8082',
    fetch: fetchStub(() => jsonResponse({ detail: '未注册的 provider: extraction/nope' }, 400)),
  });
  await assert.rejects(
    () => client.createJob({ domain: 'extraction', provider: 'nope' }),
    (error) => {
      assert.equal(isOfflineError(error), false);
      assert.equal(error.status, 400);
      assert.match(error.message, /未注册的 provider/);
      return true;
    },
  );
});

test('starting without a configured command is refused instead of guessing a path', async () => {
  const service = new LinkOpsService({ configService: configService({}) });
  await assert.rejects(() => service.start(), (error) => {
    assert.equal(error.statusCode, 400);
    assert.match(error.message, /未配置 linkops.startCommand/);
    return true;
  });
});

test('a start that leaves the service down fails loudly rather than reporting success', async () => {
  const service = new LinkOpsService({
    configService: configService({ startCommand: 'C:/x/start.bat' }),
    clientFactory: (settings) => new LinkOpsClient({
      ...settings,
      fetch: fetchStub(() => { throw new Error('connect ECONNREFUSED'); }),
    }),
    runCommand: async () => 'launched',
  });
  await assert.rejects(() => service.start(), (error) => {
    assert.equal(error.statusCode, 502);
    assert.match(error.message, /服务仍未就绪/);
    return true;
  });
});

test('a job batch is posted with the domain, provider and options the service expects', async () => {
  const seen = [];
  const service = new LinkOpsService({
    configService: configService({}),
    clientFactory: (settings) => new LinkOpsClient({
      ...settings,
      fetch: fetchStub((url, init) => {
        seen.push({ url, body: JSON.parse(init.body) });
        return jsonResponse({ ok: true, jobs: [{ id: 'job-1' }] });
      }),
    }),
  });
  const result = await service.createJob({
    domain: 'extraction',
    provider: 'paypal',
    input: { tokens: ['at-1', 'at-2'] },
    options: { checkoutCountry: 'US', billingCountry: 'US' },
  });
  assert.equal(result.jobs[0].id, 'job-1');
  assert.match(seen[0].url, /\/api\/v1\/jobs$/);
  assert.deepEqual(seen[0].body.input.tokens, ['at-1', 'at-2']);
  assert.equal(seen[0].body.options.checkoutCountry, 'US');
});

test('every engine call the console routes make exists on the guarded service', () => {
  // The routes call the service, not the client. A method added to the client
  // alone reaches production as an unhandled TypeError, which the error handler
  // reports only as "The local API could not complete the request".
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui-server', 'app.js'), 'utf8');
  const called = [...new Set([...source.matchAll(/\blinkops\.([a-zA-Z0-9_]+)\s*\(/g)].map((match) => match[1]))];
  assert.ok(called.length > 5, 'the route table should call more than a handful of engine methods');
  const missing = called.filter((name) => typeof LinkOpsService.prototype[name] !== 'function');
  assert.deepEqual(missing, [], `LinkOpsService is missing: ${missing.join(', ')}`);
});

test('a rejected engine call keeps the engine\'s own status and message', async () => {
  const service = new LinkOpsService({
    configService: configService({ baseUrl: 'http://127.0.0.1:8082' }),
    clientFactory: (settings) => new LinkOpsClient({
      ...settings,
      fetch: fetchStub(() => jsonResponse({ detail: '只有失败或中断任务可以重试' }, 409)),
    }),
  });
  // A 4xx from the engine must not be flattened into an opaque 500.
  await assert.rejects(
    () => service.batchDeleteJobs(['job-1']),
    (error) => error.statusCode === 409 && /只有失败或中断/.test(error.message),
  );
});
