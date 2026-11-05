'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const test = require('node:test');

const { loadHar } = require('../src/har');
const { decodePureHttpUrl, executePureHttpUrl, makePureHttpUrl, normalizeProxyUrl, retryAfterMs } = require('../src/pure-url');
const { createProxyAllocator, parseProxyLine, parseProxyList } = require('../src/proxy-pool');

test('encodes a full executable HTTP request as a pure URL', () => {
  const { har } = loadHar();
  const entry = har.log.entries[137];
  const pureUrl = makePureHttpUrl(entry, 137, { redact: false });
  const decoded = decodePureHttpUrl(pureUrl);

  assert.equal(decoded.index, 137);
  assert.equal(decoded.method, 'POST');
  assert.equal(decoded.url, 'https://auth.openai.com/api/accounts/authorize/continue');
  assert.ok(decoded.headers['openai-sentinel-token']);
  assert.ok(decoded.cookies['oai-did']);
  assert.equal(JSON.parse(decoded.body).screen_hint, 'signup');
});

test('normalizes a bare proxy port to localhost HTTP proxy URL', () => {
  assert.equal(normalizeProxyUrl('2080').toString(), 'http://127.0.0.1:2080/');
  assert.equal(normalizeProxyUrl('127.0.0.1:2080').toString(), 'http://127.0.0.1:2080/');
  assert.equal(normalizeProxyUrl('user:pass@127.0.0.1:2080').toString(), 'http://user:pass@127.0.0.1:2080/');
});

test('parses Retry-After seconds and HTTP dates', () => {
  assert.equal(retryAfterMs('2'), 2000);
  assert.equal(retryAfterMs('Thu, 01 Jan 2026 00:00:03 GMT', Date.parse('2026-01-01T00:00:00Z')), 3000);
  assert.equal(retryAfterMs('invalid'), 0);
});

test('preserves the upstream HTTP Date for send-boundary tracking', async (t) => {
  const serverDate = 'Tue, 15 Sep 2026 03:36:49 GMT';
  const server = http.createServer((_request, response) => {
    response.setHeader('Date', serverDate);
    response.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());

  const result = await executePureHttpUrl({
    index: -1,
    method: 'GET',
    url: `http://127.0.0.1:${server.address().port}/send`,
    headers: {},
    cookies: {},
    body: '',
    contentType: '',
  });

  assert.equal(result.response.serverDate, serverDate);
});

test('an abort signal tears down a proxy CONNECT handshake immediately', async (t) => {
  const sockets = new Set();
  const proxy = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    proxy.close();
  });
  const controller = new AbortController();
  const pending = executePureHttpUrl({
    index: -1,
    method: 'GET',
    url: 'https://target.invalid/wait',
    headers: {},
    cookies: {},
    body: '',
    contentType: '',
  }, {
    proxy: `http://127.0.0.1:${proxy.address().port}`,
    timeoutMs: 5000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort('test cancellation'), 25);

  await assert.rejects(pending, (error) => error.name === 'AbortError' && error.code === 'ABORT_ERR');
});

test('an abort without a reason normalizes Node native abort errors safely', async (t) => {
  const sockets = new Set();
  const proxy = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    proxy.close();
  });

  const controller = new AbortController();
  const pending = executePureHttpUrl({
    index: -3,
    method: 'GET',
    url: 'https://target.invalid/wait',
    headers: {},
    cookies: {},
    body: '',
    contentType: '',
  }, {
    proxy: `http://127.0.0.1:${proxy.address().port}`,
    timeoutMs: 5000,
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 25);

  await assert.rejects(pending, (error) => error.name === 'AbortError' && error.code === 'ABORT_ERR');
});

test('a SOCKS5 proxy that stops responding cannot leave the request pending', async (t) => {
  const sockets = new Set();
  const proxy = net.createServer((socket) => {
    sockets.add(socket);
    socket.once('data', () => socket.write(Buffer.from([0x05, 0x00])));
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    proxy.close();
  });

  const started = Date.now();
  await assert.rejects(executePureHttpUrl({
    index: -2,
    method: 'GET',
    url: 'https://target.invalid/wait',
    headers: {},
    cookies: {},
    body: '',
    contentType: '',
  }, {
    proxy: `socks5://127.0.0.1:${proxy.address().port}`,
    timeoutMs: 100,
  }), (error) => error.code === 'ETIMEDOUT' || /timed out|closed/i.test(error.message));
  assert.ok(Date.now() - started < 1000, 'SOCKS5 timeout should settle promptly');
});

test('proxy form POSTs send a fixed Content-Length instead of implicit chunked encoding', async (t) => {
  let captured = null;
  const proxy = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      captured = { headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
      res.writeHead(204);
      res.end();
    });
  });
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  t.after(() => proxy.close());
  const body = 'intent=select&session_id=session-current';
  const result = await executePureHttpUrl({
    index: -1,
    method: 'POST',
    // A forward-proxy target exercises the request framing without needing a
    // CONNECT-capable fixture or any external network access.
    url: 'http://auth.openai.test/choose-an-account',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    cookies: {},
    body,
    contentType: 'application/x-www-form-urlencoded',
  }, { proxy: `http://127.0.0.1:${proxy.address().port}`, timeoutMs: 2000 });
  assert.equal(result.response.status, 204);
  assert.equal(captured.body, body);
  assert.equal(captured.headers['content-length'], String(Buffer.byteLength(body)));
  assert.equal(captured.headers['transfer-encoding'], undefined);
});

test('parses proxy pool text formats and allocates leases', () => {
  const entries = parseProxyList([
    '127.0.0.1:2080:alice:secret',
    'bob:pw@proxy.example:9000',
    'socks5://carol:pw@socks.example:1080',
  ].join('\n'));

  assert.equal(entries[0].url, 'http://alice:secret@127.0.0.1:2080');
  assert.equal(entries[1].url, 'http://bob:pw@proxy.example:9000');
  assert.equal(entries[2].url, 'socks5://carol:pw@socks.example:1080');

  const allocator = createProxyAllocator(entries);
  assert.equal(allocator.acquire('job-a').url, entries[0].url);
  assert.equal(allocator.acquire('job-a').url, entries[0].url);
  assert.equal(allocator.acquire('job-b').url, entries[1].url);
  assert.equal(allocator.snapshot().available, 1);
  allocator.release('job-a');
  assert.equal(allocator.acquire('job-c').url, entries[0].url);
});

test('supports default protocol for host port auth proxy entries', () => {
  assert.equal(
    parseProxyLine('127.0.0.1:1080:user:pass', { defaultProtocol: 'socks5' }).url,
    'socks5://user:pass@127.0.0.1:1080',
  );
});
