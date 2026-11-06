'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildApp } = require('../src/ui-server/app');

function fixture(t, options = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-sms-settings-'));
  const file = path.join(cwd, 'gpt-re.config.json');
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '../gpt-re.config.example.json'), 'utf8'));
  config.sms.apiKey = 'original-bower'; config.mail.apiKey = 'original-mail';
  fs.writeFileSync(file, JSON.stringify(config));
  const calls = [];
  const app = buildApp({ cwd, deferBootMaintenance: true, smsSettingsFetch: async (url) => {
    const u = new URL(url); calls.push(u);
    const values = { getBalance: 'ACCESS_BALANCE:12', getCountries: { 6: { id: 6, eng: 'Indonesia' } }, getServicesList: { services: [{ code: 'dr', name: 'OpenAI' }] }, getPrices: { 6: { dr: { cost: 0.04, count: 10 } } } };
    const v = values[u.searchParams.get('action')]; assert.notEqual(v, undefined, 'only read operations are allowed');
    return new Response(typeof v === 'string' ? v : JSON.stringify(v));
  }, ...options });
  t.after(async () => { await app.close(); fs.rmSync(cwd, { recursive: true, force: true }); });
  return { app, file, calls };
}
test('unsaved Hero test uses the draft key, fetches countries and prices, and does not save or purchase', async (t) => {
  const { app, file, calls } = fixture(t); const before = fs.readFileSync(file, 'utf8');
  const res = await app.inject({ method: 'POST', url: '/api/v1/sms/settings/hero-sms/test', payload: { apiKey: 'draft-hero', countries: [{ id: 6 }], maxPrice: 0.2 } });
  assert.equal(res.statusCode, 200, res.body); assert.equal(res.json().ok, true, res.body);
  assert.equal(res.json().market.cheapestPrice, 0.04);
  assert.ok(calls.every((u) => u.searchParams.get('api_key') === 'draft-hero'));
  assert.equal(res.body.includes('draft-hero'), false); assert.equal(fs.readFileSync(file, 'utf8'), before);
});
test('save/switch/blank-key preserve provider isolation and do not return secrets', async (t) => {
  const { app, file } = fixture(t);
  const put = (payload) => app.inject({ method: 'PUT', url: '/api/v1/sms/settings/hero-sms', payload });
  let res = await put({ apiKey: 'saved-hero', countries: [{ id: 6 }], maxPrice: 0.3 });
  assert.equal(res.statusCode, 200, res.body); assert.equal(res.body.includes('saved-hero'), false);
  res = await put({ apiKey: '' }); assert.equal(res.statusCode, 200, res.body);
  const cfg = JSON.parse(fs.readFileSync(file));
  assert.equal(cfg.sms.hero.apiKey, 'saved-hero'); assert.equal(cfg.sms.apiKey, 'original-bower'); assert.equal(cfg.mail.apiKey, 'original-mail');
  assert.equal(cfg.sms.provider, 'hero-sms');
  const view = await app.inject('/api/v1/sms/settings/hero-sms');
  assert.equal(view.json().apiKeyConfigured, true); assert.equal(view.body.includes('saved-hero'), false);
  const full = await app.inject('/api/v1/config'); assert.equal(full.body.includes('saved-hero'), false);
  assert.equal((await put({ countries: [] })).statusCode, 400);
});

test('querying inactive SMSBower while Hero is active never borrows the Hero key', async (t) => {
  let observed;
  const { app, file } = fixture(t, { smsMarketReader: async (config) => { observed = config; return { ready: false }; } });
  const raw = JSON.parse(fs.readFileSync(file));
  raw.sms.apiKey = ''; raw.sms.provider = 'hero-sms';
  raw.sms.hero = { apiKey: 'only-hero-key', countries: [{ id: 6 }], maxPrice: 1 };
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.equal((await app.inject('/api/v1/sms/market?provider=smsbower')).statusCode, 200);
  assert.equal(observed.apiKey, '');
  assert.equal(observed.apiKeyEnv, 'SMSBOWER_API_KEY');
});

test('SMSBower refresh loads live countries and quoted inventory without saving or purchasing', async t => {
  const calls = [];
  const { app, file } = fixture(t, { smsSettingsFetch: async url => {
    const u = new URL(url); calls.push(u);
    const action = u.searchParams.get('action');
    assert.equal(u.searchParams.get('api_key'), 'draft-bower');
    if (action === 'getCountries') return new Response(JSON.stringify({ 1003: { id: 1003, eng: 'Bermuda', chn: '百慕大' } }));
    assert.equal(action, 'getPricesV3');
    assert.equal(u.searchParams.get('country'), '1003');
    assert.equal(u.searchParams.get('service'), 'dr');
    return new Response(JSON.stringify({ 1003: { dr: { 1: { price: .03, count: 5 }, 2: { price: .07, count: 9 }, 3: { price: .01, count: 0 } } } }));
  } });
  const before = fs.readFileSync(file, 'utf8');
  const payload = { apiKey: 'draft-bower', countries: [], service: 'dr', maxPrice: .055 };
  let r = await app.inject({ method: 'POST', url: '/api/v1/sms/settings/smsbower/countries', payload });
  assert.equal(r.statusCode, 200); assert.deepEqual(r.json().countries.map(c => c.id), ['1003']);
  assert.deepEqual(calls.map(u => u.searchParams.get('action')), ['getCountries']);
  r = await app.inject({ method: 'POST', url: '/api/v1/sms/settings/smsbower/quotes', payload: { ...payload, countries: [{ id: '1003' }] } });
  assert.equal(r.statusCode, 200); const quote = r.json().market.countries[0];
  assert.equal(quote.cheapestPrice, .03); assert.equal(quote.inventory, 14); assert.equal(quote.affordableInventory, 5);
  assert.deepEqual(calls.map(u => u.searchParams.get('action')), ['getCountries', 'getPricesV3']);
  assert.equal(r.body.includes('draft-bower'), false); assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.equal((await app.inject({ method: 'POST', url: '/api/v1/sms/settings/smsbower/quotes', payload })).statusCode, 400);
});

test('SMSBower catalog failures preserve an error and failed quotes never show zero inventory', async t => {
  const { app } = fixture(t, { smsSettingsFetch: async () => new Response('BAD_KEY') });
  const payload = { apiKey: 'draft-bower', countries: [{ id: '6' }], maxPrice: .055 };
  const list = (await app.inject({ method: 'POST', url: '/api/v1/sms/settings/smsbower/countries', payload })).json();
  assert.equal(list.ok, false); assert.equal(list.countries, undefined); assert.equal(list.code, 'AUTH_FAILED');
  const quote = (await app.inject({ method: 'POST', url: '/api/v1/sms/settings/smsbower/quotes', payload })).json().market.countries[0];
  assert.equal(quote.issue, 'AUTH_FAILED'); assert.equal(quote.inventory, null); assert.equal(quote.affordableInventory, null);
});
