'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { RunManager } = require('../src/ui-server/run-manager');
const { ConfigService } = require('../src/ui-server/config-service');
const { makeInitialBranchState } = require('../src/branch-orchestrator');
const { normalizeRunPlan, applyRunPlan } = require('../src/run-plan');
const { validateV2Config } = require('../src/config-v2');
const { saveV2State, loadV2State, configFingerprint } = require('../src/state-store');

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-oauth-proxy-'));
  const raw = { aliases: { strategy: 'root' }, mail: { provider: 'xiaopingguo', apiKey: 'mail' }, sms: { provider: 'hero-sms', apiKey: 'bower', maxPrice: 0.05, hero: { apiKey: 'original-hero', countries: [{ id: 6 }], maxPrice: 0.2 } }, workers: { maxConcurrency: 1 }, proxyPool: { healthCheck: { enabled: false } }, output: { stateDir: '.state' } };
  const file = path.join(cwd, 'gpt-re.config.json'); fs.writeFileSync(file, JSON.stringify(raw));
  const catalog = { local: { proxies: [{ id: 'fixed', url: 'http://127.0.0.1:4001' }] }, dynamic: { countryPools: [{ countryCode: 'US', total: 1, entries: [{ id: 'pool', url: 'http://127.0.0.1:4002' }] }] } };
  const manager = new RunManager({ cwd, configService: new ConfigService({ cwd }), proxyService: { list: () => catalog }, logStore: { append() {} } });
  manager.preparedPreflight = async () => ({ snapshot: { ready: true } });
  let launched;
  manager.launch = (state, stateFile, config) => { launched = { state, config }; };
  t.after(async () => { await manager.shutdown(); fs.rmSync(cwd, { recursive: true, force: true }); });
  const input = { schemaVersion: 3, taskKind: 'oauth', workerConcurrency: 1, oauthSource: { kind: 'credentials', accounts: [{ email: 'oauth@example.test', password: 'example-password', totpSecret: 'JBSWY3DPEHPK3PXP' }] } };
  function saved(legacy = false, sms = {}) {
    const plan = normalizeRunPlan({ ...input, proxyAssignments: [{ workerSlot: 1, ...(legacy ? { kind: 'maintenance' } : { kind: 'countryPool', countryCode: 'US' }) }] }, manager.config());
    const config = validateV2Config(applyRunPlan(manager.config(), plan), { cwd });
    const state = makeInitialBranchState(config, plan, { runId: 'test-oauth' });
    state.smsConfig = structuredClone(config.sms); state.status = 'paused';
    state.jobs = [{ id: 'pending', taskKind: 'oauth', status: 'paused', email: 'oauth@example.test', oauthState: { step: 'old-session' }, sms: { current: null, attempts: [], ...sms } }, { id: 'done', status: 'complete', oauthState: { step: 'completed' }, sms: { current: null } }];
    state.proxyResourceSnapshot = { entries: [{ id: 'old', url: 'http://127.0.0.1:7890' }] };
    const stateFile = path.join(config.output.stateDir, 'run-test-oauth.json'); saveV2State(stateFile, state);
    return { state, stateFile, config };
  }
  return { manager, input, saved, raw, file, launched: () => launched };
}

test('RunManager OAuth defaults use available pools, preserve explicit fixed assignments, and reject maintenance', (t) => {
  const { manager, input } = fixture(t);
  assert.equal(manager.runConfiguration(input).plan.proxyAssignments[0].countryCode, 'US');
  const selected = [{ workerSlot: 1, kind: 'local', localProxyId: 'fixed' }];
  const { plan } = manager.runConfiguration({ ...input, proxyAssignments: selected });
  assert.deepEqual(plan.proxyAssignments, selected);
  assert.equal(manager.proxySnapshot(plan).entries[0].resourceKind, 'local');
  assert.throws(() => manager.runConfiguration({ ...input, proxyAssignments: [{ workerSlot: 1, kind: 'maintenance' }] }), /重新选择/);
  assert.throws(() => manager.runConfiguration({ ...input, workerConcurrency: 10000000 }), /数量无效/);
});

test('legacy OAuth must choose a proxy; migration resets only unfinished auth and retains completed jobs', async (t) => {
  const f = fixture(t); const { stateFile } = f.saved(true);
  await assert.rejects(f.manager.resume('test-oauth'), /重新选择/);
  await f.manager.resume('test-oauth', { proxyAssignments: [{ workerSlot: 1, kind: 'local', localProxyId: 'fixed' }] });
  const resumed = loadV2State(stateFile);
  assert.equal(resumed.proxyResourceSnapshot.entries[0].id, 'fixed');
  assert.equal(resumed.jobs[0].oauthState, null);
  assert.equal(resumed.jobs[1].status, 'complete');
  assert.deepEqual(resumed.jobs[1].oauthState, { step: 'completed' });
  assert.equal(f.launched().config.workers.proxyAssignments[0].kind, 'local');
});

test('an active SMS lease blocks proxy replacement but checkpoint continuation keeps it and the original provider/key', async (t) => {
  const f = fixture(t); const { state, config } = f.saved(false, { current: { id: 'lease', provider: 'hero-sms', number: '+628123456789', status: 'waiting_code' } });
  f.raw.sms.provider = 'smsbower'; f.raw.sms.hero.apiKey = 'changed-hero';
  fs.writeFileSync(f.file, JSON.stringify(f.raw));
  assert.equal(f.manager.configForState(state).sms.apiKey, 'original-hero');
  assert.equal(configFingerprint(f.manager.configForState(state)), configFingerprint(config));
  await assert.rejects(f.manager.resume('test-oauth', { proxyAssignments: [{ workerSlot: 1, kind: 'local', localProxyId: 'fixed' }] }), /短信激活/);
  await f.manager.resume('test-oauth');
  assert.equal(f.launched().state.jobs[0].sms.current.id, 'lease');
  assert.equal(f.launched().config.sms.provider, 'hero-sms');
  assert.equal(f.launched().config.sms.apiKey, 'original-hero');
});

test('SMS configuration snapshots are encrypted and never exposed by run summaries', (t) => {
  const f = fixture(t); const old = process.env.GPTREG_RUNTIME_MASTER_KEY;
  process.env.GPTREG_RUNTIME_MASTER_KEY = crypto.randomBytes(32).toString('base64');
  t.after(() => { if (old === undefined) delete process.env.GPTREG_RUNTIME_MASTER_KEY; else process.env.GPTREG_RUNTIME_MASTER_KEY = old; });
  const { stateFile } = f.saved();
  assert.equal(fs.readFileSync(stateFile, 'utf8').includes('original-hero'), false);
  const state = loadV2State(stateFile); assert.equal(state.smsConfig.hero.apiKey, 'original-hero');
  assert.equal(JSON.stringify(f.manager.summary(state)).includes('original-hero'), false);
});
