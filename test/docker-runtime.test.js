'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Fastify = require('fastify');
const { initializeRuntime, installAccessControl } = require('../docker/runtime');
const { validateV2Config } = require('../src/config-v2');
const { providerApiProxiesFromConfig } = require('../src/provider-api-egress');

test('container initializes empty persistent data and preserves configuration on restart', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gptreg-docker-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.copyFileSync(path.join(__dirname, '../gpt-re.config.example.json'), path.join(cwd, 'gpt-re.config.example.json'));
  const first = initializeRuntime(cwd);
  const config = JSON.parse(fs.readFileSync(first.configPath));
  assert.equal(config.sms.apiKey, '');
  assert.equal(config.mail.password, '');
  assert.equal(config.mail.adminToken, '');
  assert.deepEqual(providerApiProxiesFromConfig(config), []);
  assert.equal(validateV2Config(config, { cwd }).output.stateDir, path.join(cwd, '.runtime/state/v2'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(cwd, '.runtime/dynamic-proxy-pools.json'))).countryPools, {});
  config.mail.smsbowerBaseUrl = 'https://mail.example/api/mail';
  config.mail.apiKey = 'saved-key';
  const saved = JSON.stringify(config);
  fs.writeFileSync(first.configPath, saved);
  const second = initializeRuntime(cwd);
  assert.equal(fs.readFileSync(second.configPath, 'utf8'), saved);
  assert.deepEqual(second.credentials, first.credentials);
});

test('container restart accepts the same password lengths as platform account settings', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gptreg-password-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.copyFileSync(path.join(__dirname, '../gpt-re.config.example.json'), path.join(cwd, 'gpt-re.config.example.json'));
  initializeRuntime(cwd);
  const authFile = path.join(cwd, '.runtime/console-auth.json');
  for (const length of [10, 12, 16, 72]) {
    const credentials = { username: 'admin@example.test', password: 'a'.repeat(length) };
    fs.writeFileSync(authFile, JSON.stringify(credentials));
    assert.deepEqual(initializeRuntime(cwd).credentials, credentials);
  }
  for (const length of [9, 73]) {
    fs.writeFileSync(authFile, JSON.stringify({ username: 'admin', password: 'a'.repeat(length) }));
    assert.throws(() => initializeRuntime(cwd), /10 to 72/);
  }
});

test('container authentication covers pages, API and event streams; rejects foreign origins', async (t) => {
  const app = Fastify();
  t.after(() => app.close());
  installAccessControl(app, { username: 'admin', password: 'test-password-long-enough' });
  for (const url of ['/', '/api/v1/config', '/api/v1/runs/example/events']) app.get(url, () => ({ protected: true }));
  app.post('/api/v1/config', () => ({ saved: true }));
  const authorization = `Basic ${Buffer.from('admin:test-password-long-enough').toString('base64')}`;
  for (const url of ['/', '/api/v1/config', '/api/v1/runs/example/events']) {
    assert.equal((await app.inject({ url })).statusCode, 401);
    assert.equal((await app.inject({ url, headers: { authorization: 'Basic d3Jvbmc=' } })).statusCode, 401);
    assert.equal((await app.inject({ url, headers: { authorization } })).statusCode, 200);
  }
  assert.deepEqual((await app.inject('/healthz')).json(), { ok: true });
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/config', headers: { authorization, origin: 'http://foreign.invalid', host: 'localhost' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/config', headers: { authorization, origin: 'http://localhost', host: 'localhost' } })).statusCode, 200);
});
