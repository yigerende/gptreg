'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { SessionAssetStore, sessionAssetMailProviderEvidence } = require('../src/session-asset-store');
const { assetNextAction } = require('../src/session-asset-grouping');
const { RunManager } = require('../src/ui-server/run-manager');

function fixture(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'rebound-recovery-'));
  const store = new SessionAssetStore({ cwd, stateDir: '.state' });
  t.after(() => { store.close(); fs.rmSync(cwd, { recursive: true, force: true }); });
  return store;
}

function legacy(overrides = {}) {
  return {
    email: 'moved@example.test', mailProvider: 'mailcom',
    parentEmail: 'original@icloud.com', parentMailboxId: 'icloud:mailbox:old',
    sourceKind: 'icloud_register_session', sourceRunId: 'old-registration',
    accessToken: 'old-access-token', sessionToken: 'old-session-cookie',
    password: 'unchanged-password', totpSecret: 'UNCHANGEDTOTP',
    status: 'valid', health: { status: 'uncertain', code: 'LOGIN_STATE_INVALID', checkedAt: '2026-09-15T20:26:00Z' },
    rebind: { previousEmail: 'original@icloud.com', previousProvider: 'icloud', provider: 'mailcom', mailboxId: 'mailcom:alias:1:new', reboundAt: '2026-09-15T20:26:00Z', runId: 'old-rebind' },
    ...overrides,
  };
}

test('a confirmed legacy rebind repairs its mailbox and unlocks the normal refresh provider check', (t) => {
  const store = fixture(t);
  const saved = store.upsert(legacy());
  const file = store.filePath(saved.id);
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(sessionAssetMailProviderEvidence(saved).source, 'conflict');

  const repaired = store.get(saved.id);
  assert.equal(repaired.mailProvider, 'mailcom');
  assert.equal(repaired.parentEmail, repaired.email);
  assert.equal(repaired.parentMailboxId, saved.rebind.mailboxId);
  assert.equal(repaired.sourceKind, saved.sourceKind);
  assert.equal(repaired.sourceRunId, saved.sourceRunId);
  assert.deepEqual(repaired.rebind, saved.rebind);
  assert.equal(repaired.createdAt, saved.createdAt);
  assert.equal(repaired.updatedAt, saved.updatedAt);
  for (const key of ['password', 'totpSecret', 'accessToken', 'sessionToken']) assert.equal(repaired[key], saved[key]);
  assert.equal(repaired.status, 'invalid');
  assert.equal(repaired.health.status, 'invalid');
  assert.equal(assetNextAction(repaired), 'refresh');
  assert.equal(sessionAssetMailProviderEvidence(repaired).provider, 'mailcom');
  assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), before);

  const manager = Object.create(RunManager.prototype);
  manager.sessionAssets = () => store;
  const plan = manager.bindSessionAssetMailProvider({
    taskKind: 'session_refresh', oauthSource: { kind: 'session_assets', assetIds: [saved.id] },
    proxyAssignments: [{ workerSlot: 1, kind: 'maintenance' }],
  });
  assert.equal(plan.mailProvider, 'mailcom');
  assert.deepEqual(plan.proxyAssignments, [{ workerSlot: 1, kind: 'maintenance' }]);
  const results = store.query({ facets: ['rebound'], queue: 'refresh' });
  assert.deepEqual(results.assets.map(asset => asset.id), [saved.id]);
  assert.ok(results.assets[0].facets.includes('mailProvider:mailcom'));

  const after = fs.readFileSync(file, 'utf8');
  store.close();
  store.readCache.clear();
  store.get(saved.id);
  assert.equal(fs.readFileSync(file, 'utf8'), after);
  assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), before);
});

test('uncertain and contradictory rebind records retain their protection', (t) => {
  const base = legacy();
  for (const change of [
    { verificationUncertain: true },
    { newEmail: 'someone-else@example.test' },
    { mailboxId: 'fastmail:alias:wrong' },
    { reboundAt: '' },
    { previousEmail: base.email },
  ]) {
    const store = fixture(t);
    const record = { ...base, rebind: { ...base.rebind, ...change } };
    const saved = store.upsert(record);
    const reloaded = store.get(saved.id);
    assert.equal(reloaded.parentMailboxId, record.parentMailboxId);
    assert.equal(reloaded.parentEmail, record.parentEmail);
    assert.equal(sessionAssetMailProviderEvidence(reloaded).source, 'conflict');
  }
});

test('backup recovery can read a legacy rebind without replacing its only valid backup', (t) => {
  const store = fixture(t);
  const saved = store.upsert(legacy());
  const file = store.filePath(saved.id);
  const backup = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(`${file}.bak`, backup);
  fs.writeFileSync(file, 'broken-json');
  const recovered = store.get(saved.id);
  assert.equal(recovered.parentMailboxId, saved.rebind.mailboxId);
  assert.equal(fs.readFileSync(`${file}.bak`, 'utf8'), backup);
  assert.equal(fs.readFileSync(file, 'utf8'), 'broken-json');
});

test('refresh-pending rebinds are queued for refresh until a new session is verified', () => {
  const asset = legacy({ health: { status: 'uncertain', code: 'REBIND_SESSION_REFRESH_PENDING' } });
  assert.equal(assetNextAction(asset), 'refresh');
  assert.equal(assetNextAction({ ...asset, health: { status: 'healthy', code: 'AT_VALID' } }), 'oauth');
});
