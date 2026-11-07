'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  cookieHeaderFor,
  createCookieJar,
  serializeCookieJar,
  updateCookieJar,
} = require('../src/cookie-jar');
const {
  SessionAssetStore,
  sessionAssetMailProviderEvidence,
} = require('../src/session-asset-store');
const { OAUTH_FAILURE_COOLDOWN_MS } = require('../src/session-asset-grouping');

test('registration metadata is immutable and default paginated order ignores later refreshes', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gptreg-registration-order-'));
  let clock = Date.parse('2026-11-07T01:00:00Z');
  const store = new SessionAssetStore({ cwd, stateDir: 'state', now: () => clock });
  t.after(() => { store.close(); fs.rmSync(cwd, { recursive: true, force: true }); });
  const old = store.upsert({ email: 'old@example.test', registeredAt: '2026-11-06T01:00:00Z', sourceProxy: { url: 'socks5://user:secret@entry.test:9000', exitIp: '203.0.113.7' } });
  const recent = store.upsert({ email: 'new@example.test', registeredAt: '2026-11-07T00:00:00Z', sourceProxy: { url: 'http://new.test:8080', exitIp: '203.0.113.8' } });
  clock += 3600000;
  store.upsert({ id: old.id, email: old.email, sourceKind: 'session_refresh', accessToken: 'fresh-at' });
  store.upsert({ id: old.id, email: old.email, registeredAt: new Date(clock).toISOString(), sourceProxy: { url: 'http://maintenance.test', exitIp: '192.0.2.1' } });
  const first = store.query({ limit: 1 }), second = store.query({ limit: 1, cursor: '1' });
  assert.equal(first.assets[0].id, recent.id); assert.equal(second.assets[0].id, old.id);
  assert.equal(second.assets[0].registeredAt, '2026-11-06T01:00:00Z');
  assert.equal(second.assets[0].sourceProxy.exitIp, '203.0.113.7');
  assert.equal(JSON.stringify(second).includes('secret'), false);
  assert.equal(store.detail(old.id).registrationProxyUrl, 'socks5://user:secret@entry.test:9000');
  assert.notEqual(store.detail(old.id).updatedAt, old.updatedAt);
});

test('scoped cookie jars preserve domain, path, and host isolation', () => {
  let jar = createCookieJar();
  jar = updateCookieJar(jar, 'https://auth.openai.com/log-in', {
    'set-cookie': [
      'auth-only=one; Path=/log-in; Secure; HttpOnly; SameSite=Lax',
      'shared=two; Domain=.openai.com; Path=/; Secure',
    ],
  });

  assert.match(cookieHeaderFor(jar, 'https://auth.openai.com/log-in/password'), /auth-only=one/);
  assert.doesNotMatch(cookieHeaderFor(jar, 'https://auth.openai.com/oauth/authorize'), /auth-only=one/);
  assert.match(cookieHeaderFor(jar, 'https://api.openai.com/v1/me'), /shared=two/);
  assert.equal(cookieHeaderFor(jar, 'https://chatgpt.com/'), '');
  assert.match(JSON.stringify(serializeCookieJar(jar)), /"httpOnly":true/);
});

test('session asset store upserts identity, exports secrets, and overwrites canonical CPA', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-assets-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const store = new SessionAssetStore({ cwd, stateDir: '.state', cpaDir: '.state/output' });
  t.after(() => store.close());

  const first = store.upsert({
    email: 'Person+One@example.test',
    accountId: 'account-1',
    accessToken: 'access-one',
    sessionToken: 'session-one',
    password: 'password-one',
    totpSecret: 'totp-one',
    cookies: { 'oai-did': 'device-one' },
    planType: 'Free',
    security: {
      setPassword: true,
      passwordStatus: 'failed',
      passwordTransaction: { step: 'otp_sent', password: 'must-not-leak' },
      failures: [{ feature: 'password', code: 'PASSWORD_SETUP_FAILED', message: 'contains secret context' }],
    },
  });
  const updated = store.upsert({
    email: 'person+one@example.test',
    accountId: 'account-1',
    accessToken: 'access-two',
    status: 'valid',
  });

  assert.equal(updated.id, first.id);
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0].hasAccessToken, true);
  assert.equal(store.list()[0].health, null);
  assert.equal(store.list()[0].oauth.successful, false);
  assert.equal(JSON.stringify(store.list()).includes('must-not-leak'), false);
  assert.deepEqual(store.list()[0].security.failures, [{ feature: 'password', code: 'PASSWORD_SETUP_FAILED' }]);
  assert.equal(store.get(first.id).accessToken, 'access-two');
  store.update(first.id, { health: { status: 'healthy', code: 'AT_VALID', checkedAt: '2026-08-06T00:00:00.000Z' } });
  assert.equal(store.list()[0].health.status, 'healthy');
  assert.equal(store.export([first.id], { kind: 'at', format: 'raw' }).content, 'access-two\n');
  assert.equal(
    store.export([first.id], { kind: 'credentials' }).content,
    'person+one@example.test----password-one----totp-one\n',
  );

  const one = store.replaceCpa(first.id, { access_token: 'cpa-one' }, { runId: 'run-one', jobId: 'job-one' });
  const two = store.replaceCpa(first.id, { access_token: 'cpa-two' }, { runId: 'run-two', jobId: 'job-two' });
  assert.equal(one.cpa.revision, 1);
  assert.equal(two.cpa.revision, 2);
  assert.equal(two.cpa.completionStatus, 'complete');
  assert.equal(path.basename(two.filePath), 'person+one@example.test-cpa.json');
  assert.deepEqual(JSON.parse(fs.readFileSync(two.filePath, 'utf8')), { access_token: 'cpa-two' });
  assert.equal(store.get(first.id).cpa.runId, 'run-two');
  assert.deepEqual(store.list()[0].oauth, {
    successful: true,
    successCount: 2,
    lastSucceededAt: two.cpa.updatedAt,
    lastRunId: 'run-two',
    lastJobId: 'job-two',
  });
  store.update(first.id, { cpa: null });
  assert.equal(store.list()[0].oauth.successful, true);
  assert.equal(store.list()[0].oauth.successCount, 2);
  store.update(first.id, { cpa: two.cpa });

  const removed = store.remove([first.id], { cascadeCpa: true });
  assert.deepEqual(removed.removed, [first.id]);
  assert.equal(fs.existsSync(two.filePath), false);
});

test('OAuth failure cooldown persists, expires dynamically, and can be forced clear', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-assets-oauth-cooldown-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  let clock = Date.parse('2026-09-13T00:00:00.000Z');
  const store = new SessionAssetStore({ cwd, stateDir: '.state', cpaDir: '.state/output', now: () => clock });
  t.after(() => store.close());
  const asset = store.upsert({ email: 'oauth-cooldown@example.test', status: 'valid' });

  const applied = store.setOAuthCooldown(asset.id, {
    failureCount: 21,
    sourceRunId: 'run-cooldown',
    sourceJobId: 'job-cooldown',
  });
  assert.equal(applied.changed, true);
  assert.equal(applied.cooldown.active, true);
  assert.equal(applied.cooldown.failureCount, 21);
  assert.equal(Date.parse(applied.cooldown.until), clock + OAUTH_FAILURE_COOLDOWN_MS);
  assert.equal(JSON.parse(fs.readFileSync(store.filePath(asset.id), 'utf8')).oauthCooldown.failureCount, 21);
  assert.deepEqual(store.query({ lifecycle: 'all', facets: ['oauthCooldown'], limit: 10 }).assets.map((item) => item.id), [asset.id]);

  // A successful OAuth/CPA write is a stronger resolution than the temporary
  // lock and must make the account immediately eligible again.
  store.replaceCpa(asset.id, { access_token: 'cooldown-cleared-cpa' }, { runId: 'success-run', jobId: 'success-job' });
  assert.equal(store.get(asset.id).oauthCooldown, null);
  store.setOAuthCooldown(asset.id, { failureCount: 21 });

  clock += OAUTH_FAILURE_COOLDOWN_MS + 1;
  assert.equal(store.list()[0].oauthCooldown.active, false);
  assert.equal(store.query({ lifecycle: 'all', facets: ['oauthCooldown'], limit: 10 }).total, 0);

  // Invalid counters must never become NaN in the durable record.
  const reapplied = store.setOAuthCooldown(asset.id, { failureCount: 'not-a-number' });
  assert.equal(reapplied.cooldown.failureCount, 0);
  const cleared = store.clearOAuthCooldown(asset.id);
  assert.equal(cleared.changed, true);
  assert.equal(store.get(asset.id).oauthCooldown, null);
  assert.equal(store.clearOAuthCooldown(asset.id).changed, false);
});

test('session assets retain and infer their mailbox provider', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-asset-provider-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const store = new SessionAssetStore({ cwd, stateDir: '.state', cpaDir: '.state/output' });
  t.after(() => store.close());

  const fastmail = store.upsert({
    email: 'fast-alias@fastmail.example',
    parentMailboxId: 'fastmail:alias:1:one',
  });
  assert.equal(store.get(fastmail.id).mailProvider, 'fastmail');
  assert.equal(JSON.parse(fs.readFileSync(store.filePath(fastmail.id), 'utf8')).mailProvider, 'fastmail');
  assert.equal(store.list()[0].mailProvider, 'fastmail');

  const icloud = store.upsert({
    email: 'icloud-login@icloud.example',
    parentMailboxId: 'icloud:mailbox:one',
    sourceKind: 'register_session',
  });
  assert.equal(icloud.mailProvider, 'icloud');
  assert.equal(store.get(icloud.id).mailProvider, 'icloud');
  assert.equal(JSON.parse(fs.readFileSync(store.filePath(icloud.id), 'utf8')).mailProvider, 'icloud');
  assert.equal(sessionAssetMailProviderEvidence({
    email: 'icloud-source@example.test',
    sourceKind: 'icloud_register_session',
  }).provider, 'icloud');

  const mailApi = {
    email: 'legacy-mailapi@legacy.example',
    parentMailboxId: 'legacy:alias:1:two',
    sourceKind: 'mailapi_session',
  };
  assert.equal(sessionAssetMailProviderEvidence(mailApi).provider, 'mailcom');
  assert.equal(sessionAssetMailProviderEvidence({
    email: 'legacy-rental@gmail.com',
    parentMailboxId: '12345',
  }).provider, 'smsbower');
  assert.equal(sessionAssetMailProviderEvidence({
    email: 'legacy-local@outlook.com',
    parentMailboxId: '67890',
  }).provider, 'xiaopingguo');
});

test('archiving takes a settled account out of the listing without losing it', (t) => {
  // 8064 assets took 90.8s to index cold on 2026-09-25, and 4637 of them were
  // already sold — finished business that still cost a stat and a read on
  // every rebuild. Archiving is a rename, so the account is still there.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-archive-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const store = new SessionAssetStore({ cwd, stateDir: '.state', cpaDir: '.state/output' });
  t.after(() => store.close());

  const sold = store.upsert({ email: 'sold@example.test', accountId: 'account-sold', accessToken: 'token-sold' });
  const kept = store.upsert({ email: 'kept@example.test', accountId: 'account-kept', accessToken: 'token-kept' });
  // A backup beside the file is part of the record, not a stray: leaving it
  // behind would let a later read resurrect a stale copy into the listing.
  const backup = `${store.filePath(sold.id)}.bak`;
  fs.writeFileSync(backup, fs.readFileSync(store.filePath(sold.id)));
  assert.equal(store.entries().length, 2);

  const archived = store.relocate([sold.id]);
  assert.deepEqual(archived.moved, [sold.id]);
  assert.deepEqual(archived.skipped, []);

  // Out of the listing...
  assert.deepEqual(store.entries().map((row) => row.id), [kept.id]);
  assert.equal(store.archivedFiles().length, 1);
  assert.equal(fs.existsSync(backup), false, 'the backup travels with its asset');
  // ...but not out of reach: a CPA page that links to this id still opens it.
  assert.equal(store.get(sold.id).email, 'sold@example.test');
  assert.equal(store.filePath(sold.id).includes(`${path.sep}archive${path.sep}`), true);

  // Asking twice is not an error, and neither is asking for an id that is
  // already where it was asked to go.
  assert.deepEqual(store.relocate([sold.id]).skipped, [{ id: sold.id, reason: 'not_listed' }]);
  assert.deepEqual(store.relocate([kept.id], { restore: true }).skipped, [{ id: kept.id, reason: 'not_archived' }]);

  // And the whole thing is one move back.
  assert.deepEqual(store.relocate([sold.id], { restore: true }).moved, [sold.id]);
  assert.equal(store.entries().length, 2);
  assert.equal(store.archivedFiles().length, 0);
  assert.equal(store.get(sold.id).accountId, 'account-sold');
});

test('settled means sold and locked long enough, judged on both records', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-settled-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const store = new SessionAssetStore({ cwd, stateDir: '.state', cpaDir: '.state/output' });
  t.after(() => store.close());

  const old = store.upsert({ email: 'old@example.test', accountId: 'a1', accessToken: 't1' });
  const fresh = store.upsert({ email: 'fresh@example.test', accountId: 'a2', accessToken: 't2' });
  const unlocked = store.upsert({ email: 'unlocked@example.test', accountId: 'a3', accessToken: 't3' });
  const active = store.upsert({ email: 'active@example.test', accountId: 'a4', accessToken: 't4' });
  for (const id of [old.id, fresh.id, unlocked.id]) store.markLifecycle([id], 'sold');

  const hour = 3_600_000;
  fs.writeFileSync(path.join(cwd, '.state', 'cpa-locked-batches.json'), JSON.stringify({
    schemaVersion: 1,
    entries: {
      'session-assets/old@example.test-cpa.json': { lockedAt: new Date(Date.now() - 30 * hour).toISOString() },
      'session-assets/fresh@example.test-cpa.json': { lockedAt: new Date(Date.now() - 2 * hour).toISOString() },
      // Sold and long locked, but never marked sold on the asset itself.
      'session-assets/active@example.test-cpa.json': { lockedAt: new Date(Date.now() - 30 * hour).toISOString() },
    },
  }));

  // Sold + locked over the window. Not the recent lock, not the unlocked sale,
  // not the long-locked account that is still in the listing as active.
  assert.deepEqual(store.settledSoldIds(), [old.id]);
  // The window is the operator's to widen.
  assert.deepEqual(store.settledSoldIds({ hours: 48 }).length, 0);
  assert.deepEqual(store.settledSoldIds({ hours: 1 }).sort(), [old.id, fresh.id].sort());
  // An account a task is holding stays put however settled it looks.
  assert.deepEqual(store.settledSoldIds({ skip: new Set([old.id]) }), []);
  assert.equal([unlocked.id, active.id].length, 2);
});

test('an archived CPA stays in the history it was locked to preserve', (t) => {
  // Archiving takes the cost out of the login-state listing, which is where it
  // was. The CPA page is the record of what was sold — a batch is locked
  // precisely so it stays readable — so it keeps showing them, from the
  // snapshot rather than from the files.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-archive-cpa-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const store = new SessionAssetStore({ cwd, stateDir: '.state', cpaDir: '.state/output' });
  t.after(() => store.close());

  const sold = store.upsert({ email: 'sold@example.test', accountId: 'account-sold', accessToken: 'token-sold' });
  store.replaceCpa(sold.id, { email: 'sold@example.test', access_token: 'cpa-access' }, { runId: 'run-1', jobId: 'job-1' });
  store.upsert({ email: 'kept@example.test', accountId: 'account-kept', accessToken: 'token-kept' });
  const before = store.cpaEntries();
  assert.equal(before.length, 2);

  store.relocate([sold.id]);
  // Out of the login-state listing...
  assert.deepEqual(store.entries().map((row) => row.email ?? null), [null]);
  assert.equal(store.entries().length, 1);
  // ...still in the CPA history, with its artifact intact.
  const after = store.cpaEntries();
  assert.equal(after.length, 2);
  const archived = after.find((entry) => entry.id === sold.id);
  assert.equal(archived.email, 'sold@example.test');
  assert.equal(archived.cpa.runId, 'run-1');

  // A fresh store reads the snapshot rather than the archived files.
  const reopened = new SessionAssetStore({ cwd, stateDir: '.state', cpaDir: '.state/output' });
  t.after(() => reopened.close());
  assert.equal(reopened.cpaEntries().length, 2);

  // Restoring must not leave the account listed twice.
  store.relocate([sold.id], { restore: true });
  assert.equal(store.cpaEntries().length, 2);
  assert.equal(store.archivedFiles().length, 0);
});

test('an archived address is still a used address', (t) => {
  // `knownEmails` is the only thing standing between a recycled mailbox and a
  // second registration of an address that already has an account. Archiving
  // takes the file out of the listing, so the address has to be remembered
  // some other way or a sold account becomes registerable again.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-archive-emails-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const store = new SessionAssetStore({ cwd, stateDir: '.state', cpaDir: '.state/output' });
  t.after(() => store.close());

  const sold = store.upsert({
    email: 'Sold+Alias@example.test',
    parentEmail: 'Sold@example.test',
    accountId: 'account-sold',
    accessToken: 'token-sold',
  });
  store.upsert({ email: 'kept@example.test', accountId: 'account-kept', accessToken: 'token-kept' });
  assert.equal(store.knownEmails().has('sold+alias@example.test'), true);

  store.relocate([sold.id]);
  // Both the address and the root it came from survive the move: a root that
  // produced an alias has itself been spent.
  assert.equal(store.knownEmails().has('sold+alias@example.test'), true);
  assert.equal(store.knownEmails().has('sold@example.test'), true);
  assert.equal(store.knownEmails().has('kept@example.test'), true);

  // A second store on the same directory reads the roster rather than the
  // archived files, which is what keeps the answer cheap.
  const reopened = new SessionAssetStore({ cwd, stateDir: '.state', cpaDir: '.state/output' });
  t.after(() => reopened.close());
  assert.equal(reopened.knownEmails().has('sold+alias@example.test'), true);

  // A roster that disagrees with the archive is rebuilt rather than trusted:
  // files can be moved by hand.
  fs.writeFileSync(reopened.archivedIndexPath(), JSON.stringify({ assets: 99, emails: [], cpa: [] }));
  const rebuilt = new SessionAssetStore({ cwd, stateDir: '.state', cpaDir: '.state/output' });
  t.after(() => rebuilt.close());
  assert.equal(rebuilt.knownEmails().has('sold+alias@example.test'), true);

  // Restoring gives the address back to the listing and empties the snapshot.
  store.relocate([sold.id], { restore: true });
  assert.equal(store.archivedIndex().emails.size, 0);
  assert.equal(store.knownEmails().has('sold+alias@example.test'), true);
});

test('asset removal validates every target before deleting any file', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-assets-remove-plan-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const store = new SessionAssetStore({ cwd, stateDir: '.state', cpaDir: '.state/output' });
  t.after(() => store.close());
  const first = store.upsert({ email: 'first-remove@example.test' });
  const second = store.upsert({ email: 'second-remove@example.test', cpa: { path: '../outside-cpa.json' } });

  assert.throws(() => store.remove([first.id, second.id], { cascadeCpa: true }), /Path must stay inside/);
  assert.equal(store.get(first.id).id, first.id);
  assert.equal(store.get(second.id).id, second.id);
});

test('session asset sale classifications support planned inventory and sold upgrades', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-asset-classification-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const store = new SessionAssetStore({ cwd, stateDir: '.state', cpaDir: '.state/output' });
  t.after(() => store.close());
  const asset = store.upsert({ email: 'planned-sale@example.test', status: 'valid' });

  assert.equal(store.get(asset.id).classification, 'active');
  assert.equal(store.get(asset.id).lifecycle, 'active');
  assert.deepEqual(store.markLifecycle([asset.id], 'planned'), {
    requested: 1,
    lifecycle: 'planned',
    classification: 'planned',
    changed: [asset.id],
    missing: [],
  });
  assert.equal(store.get(asset.id).classification, 'planned');
  assert.equal(store.get(asset.id).lifecycle, 'planned');

  // The normal action upgrades a planned asset in place; it does not create a
  // second record or alter the login-state payload.
  assert.deepEqual(store.markLifecycle([asset.id], 'sold'), {
    requested: 1,
    lifecycle: 'sold',
    classification: 'sold',
    changed: [asset.id],
    missing: [],
  });
  assert.equal(store.get(asset.id).classification, 'sold');
  assert.throws(() => store.markLifecycle([asset.id], 'reserved'), /Unsupported session asset lifecycle/);
  // `banned` is discovered by a probe, never chosen by an operator.
  assert.throws(() => store.markLifecycle([asset.id], 'banned'), /Unsupported session asset lifecycle/);

  // A deactivation must not quietly undo a recorded sale: the health verdict is
  // still written, but the account stays in the pool the operator put it in.
  store.update(asset.id, { health: { status: 'banned', code: 'ACCOUNT_DEACTIVATED' } });
  assert.equal(store.get(asset.id).lifecycle, 'sold');
  assert.equal(store.list().find((row) => row.id === asset.id).nextAction, 'none');

  // Returning a wrongly flagged account to the pool clears the verdict with it,
  // so the next read does not re-derive `banned` from the stale health record.
  const active = store.upsert({ email: 'wrongly-flagged@example.test', accessToken: 'token' });
  store.update(active.id, { health: { status: 'banned', code: 'ACCOUNT_DEACTIVATED' } });
  assert.equal(store.get(active.id).lifecycle, 'banned');
  assert.deepEqual(store.markLifecycle([active.id], 'active').changed, [active.id]);
  assert.equal(store.get(active.id).lifecycle, 'active');
  assert.equal(store.get(active.id).health, null);

  // The pre-lifecycle entry point still works for callers that predate the axis.
  assert.equal(store.markClassification([active.id], 'planned').lifecycle, 'planned');

  // A classification-only patch must not be shadowed by the old lifecycle
  // copied from the record. The legacy and current spellings still move one
  // inventory pool together.
  const patchable = store.upsert({ email: 'classification-patch@example.test' });
  store.update(patchable.id, { classification: 'sold' });
  assert.equal(store.get(patchable.id).classification, 'sold');
  assert.equal(store.get(patchable.id).lifecycle, 'sold');
  store.upsert({ id: patchable.id, email: patchable.email, classification: 'planned' });
  assert.equal(store.get(patchable.id).classification, 'planned');
  assert.equal(store.get(patchable.id).lifecycle, 'planned');
});

test('session asset store reconciles a post-submit password MFA checkpoint on read', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-password-mfa-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const store = new SessionAssetStore({ cwd, stateDir: '.state', cpaDir: '.state/output' });
  t.after(() => store.close());
  const asset = store.upsert({
    email: 'password-mfa-migration@example.test',
    password: 'Gpt-migration-password!8a',
    status: 'partial',
    lastError: { code: 'SECURITY_PARTIAL', message: 'Optional security setup was only partially completed' },
    security: {
      setPassword: true,
      enrollTotp: true,
      passwordStatus: 'failed',
      totpStatus: 'configured',
      passwordTransaction: {
        step: 'password_submitted',
        nextUrl: 'https://auth.openai.com/mfa-challenge/fixture',
      },
      failures: [{ feature: 'password', code: 'PASSWORD_CONFIRMATION_MFA_REQUIRED' }],
    },
  });

  const migrated = store.get(asset.id);
  assert.equal(migrated.status, 'valid');
  assert.equal(migrated.lastError, null);
  assert.equal(migrated.security.passwordStatus, 'configured');
  assert.equal(migrated.security.passwordTransaction.step, 'complete');
  assert.equal(migrated.security.passwordTransaction.confirmationMfaRequired, true);
  assert.deepEqual(migrated.security.failures, []);
  assert.equal(store.list()[0].security.confirmationMfaRequired, true);
  assert.equal(JSON.parse(fs.readFileSync(store.filePath(asset.id), 'utf8')).status, 'valid');
});

test('a reconciled password MFA checkpoint is not rewritten on every later read', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-password-mfa-stable-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  let clock = 1_000;
  const store = new SessionAssetStore({ cwd, stateDir: '.state', cpaDir: '.state/output', now: () => clock });
  t.after(() => store.close());
  const asset = store.upsert({
    email: 'password-mfa-stable@example.test',
    password: 'Gpt-migration-password!8a',
    status: 'partial',
    security: {
      setPassword: true,
      enrollTotp: true,
      passwordStatus: 'failed',
      totpStatus: 'configured',
      passwordTransaction: { step: 'password_submitted', nextUrl: 'https://auth.openai.com/mfa-challenge/fixture' },
      failures: [{ feature: 'password', code: 'PASSWORD_CONFIRMATION_MFA_REQUIRED' }],
    },
  });

  clock = 2_000;
  const migrated = store.get(asset.id);
  assert.equal(migrated.security.passwordTransaction.step, 'complete');
  const migratedAt = migrated.updatedAt;
  const migratedBytes = fs.readFileSync(store.filePath(asset.id), 'utf8');

  // A settled asset must survive repeated polling untouched: the console lists
  // every asset every few seconds, and a non-idempotent migration would bump
  // `updatedAt` and rewrite the file on each of those reads.
  for (const tick of [3_000, 4_000, 5_000]) {
    clock = tick;
    assert.equal(store.get(asset.id).updatedAt, migratedAt);
    assert.equal(store.list().find((item) => item.id === asset.id).updatedAt, migratedAt);
  }
  assert.equal(fs.readFileSync(store.filePath(asset.id), 'utf8'), migratedBytes);
});

test('session asset store migrates an MFA enrollment re-auth requirement into a resumable checkpoint', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-totp-reauth-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const store = new SessionAssetStore({ cwd, stateDir: '.state', cpaDir: '.state/output' });
  t.after(() => store.close());
  const asset = store.upsert({
    email: 'totp-reauth-migration@example.test',
    password: 'Gpt-existing-password!8a',
    status: 'partial',
    security: {
      setPassword: true,
      enrollTotp: true,
      passwordStatus: 'configured',
      totpStatus: 'failed',
      failures: [{
        feature: 'totp',
        code: 'MFA_ENROLL_FAILED',
        message: 'mfa_enroll failed with HTTP 401: User must re-authenticate to enroll/disable a factor',
      }],
    },
  });

  const migrated = store.get(asset.id);
  assert.equal(migrated.status, 'partial');
  assert.equal(migrated.security.totpStatus, 'retry_pending');
  assert.equal(migrated.security.securityReauth.status, 'required');
  assert.equal(migrated.security.securityReauth.reason, 'MFA_ENROLL_REAUTH_REQUIRED');
  assert.equal(migrated.security.securityReauth.lastError.code, 'SECURITY_REAUTH_REQUIRED');
  assert.deepEqual(store.list()[0].security.securityReauthStatus, 'required');
  assert.equal(store.list()[0].lastError.code, 'SECURITY_REAUTH_REQUIRED');
});

test('the detail view carries the derived flags the console reads, not just the raw record', (t) => {
  // Regression: the list came from `assetSummary` and the inspector came from
  // the raw record, which has `password` but no `hasPassword`. Every shared
  // status helper reads the boolean, so the inspector reported "待补密码" for
  // accounts whose password was configured — on every single one of them.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-detail-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const store = new SessionAssetStore({ cwd, stateDir: '.state', cpaDir: '.state/output' });
  t.after(() => store.close());
  const asset = store.upsert({
    email: 'detail@example.test',
    parentMailboxId: 'fastmail:alias:1:detail',
    accountId: 'account-detail',
    accessToken: 'at-detail',
    sessionToken: 'st-detail',
    password: 'password-detail',
    totpSecret: 'JBSWY3DPEHPK3PXP',
    security: { passwordStatus: 'configured', totpStatus: 'configured' },
    sourceProxy: { id: 'proxy-1', url: 'socks5://user:secret@1.2.3.4:9000', countryCode: 'JP', protocol: 'socks5' },
  });

  const detail = store.detail(asset.id);
  const summary = store.list()[0];

  // The two views must agree about what the account has.
  assert.equal(detail.mailProvider, 'fastmail');
  assert.equal(summary.mailProvider, 'fastmail');
  for (const flag of ['hasAccessToken', 'hasSessionToken', 'hasPassword', 'hasTotp']) {
    assert.equal(detail[flag], true, `detail.${flag}`);
    assert.equal(summary[flag], true, `summary.${flag}`);
  }
  // The credentials panel still gets what it exists to show.
  assert.equal(detail.password, 'password-detail');
  assert.equal(detail.totpSecret, 'JBSWY3DPEHPK3PXP');
  // And the registration exit is normalized the same way the list normalizes it.
  assert.equal(detail.sourceProxy.endpoint, '1.2.3.4:9000');
  assert.equal(detail.sourceProxy.countryCode, 'JP');
  assert.equal(JSON.stringify(detail.sourceProxy).includes('secret'), false);
});

test('registration and rebind exit records stay separate across refresh and all public projections', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-exit-provenance-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const store = new SessionAssetStore({ cwd, stateDir: '.state' });
  t.after(() => store.close());
  const original = { url: 'http://user:original-private@192.0.2.1:8080', countryCode: 'US' };
  const rebound = { url: 'http://user:rebind-private@192.0.2.2:9000', countryCode: 'JP' };
  const asset = store.upsert({ email: 'moved@example.test', sourceProxy: original, rebindProxy: rebound });
  store.update(asset.id, { accessToken: 'refreshed-token', status: 'valid' });
  assert.deepEqual(store.get(asset.id).sourceProxy, original);
  assert.deepEqual(store.get(asset.id).rebindProxy, rebound);
  for (const projected of [store.detail(asset.id), store.list()[0], store.query().assets[0]]) {
    assert.equal(projected.sourceProxy.countryCode, 'US');
    assert.equal(projected.sourceProxy.endpoint, '192.0.2.1:8080');
    assert.equal(projected.rebindProxy.countryCode, 'JP');
    assert.equal(projected.rebindProxy.endpoint, '192.0.2.2:9000');
    assert.ok(projected.facets.includes('exitCountry:US'));
    assert.equal(projected.facets.includes('exitCountry:JP'), false);
    assert.equal(JSON.stringify(projected.rebindProxy).includes('private'), false);
  }
  const legacy = store.upsert({ email: 'legacy@example.test', sourceProxy: original, rebind: { reboundAt: '2026-09-16T00:00:00Z' } });
  assert.equal(store.detail(legacy.id).rebindProxy, null);
});

test('asset detail preserves raw security checkpoints beside the compact summary', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-detail-security-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const store = new SessionAssetStore({ cwd, stateDir: '.state', cpaDir: '.state/output' });
  t.after(() => store.close());
  const asset = store.upsert({
    email: 'detail-security@example.test',
    security: {
      passwordStatus: 'failed',
      passwordTransaction: { step: 'otp_sent', password: 'transaction-secret', nextUrl: 'https://auth.example.test/continue' },
      securityReauth: { status: 'required', emailOtp: { status: 'waiting' } },
      failures: [{ feature: 'password', code: 'PASSWORD_SETUP_FAILED', message: 'full failure context' }],
    },
  });

  const detail = store.detail(asset.id);
  assert.equal(detail.security.passwordTransaction.password, 'transaction-secret');
  assert.equal(detail.security.securityReauth.emailOtp.status, 'waiting');
  assert.equal(detail.security.failures[0].message, 'full failure context');
  assert.equal(detail.securitySummary.passwordTransactionStep, 'otp_sent');
  assert.equal(detail.securitySummary.securityReauthStatus, 'required');
  assert.deepEqual(detail.securitySummary.failures, [{ feature: 'password', code: 'PASSWORD_SETUP_FAILED' }]);
});

test('fallback asset cache invalidates when the backup file changes', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-asset-backup-cache-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const store = new SessionAssetStore({ cwd, stateDir: '.state', cpaDir: '.state/output' });
  t.after(() => store.close());
  const first = store.upsert({ email: 'backup-first@example.test' });
  store.upsert({ id: first.id, email: 'backup-primary@example.test' });
  const file = store.filePath(first.id);
  const backup = `${file}.bak`;
  fs.writeFileSync(file, '{ broken primary\n', 'utf8');

  assert.equal(store.get(first.id).email, 'backup-first@example.test');
  const changedBackup = JSON.parse(fs.readFileSync(backup, 'utf8'));
  changedBackup.email = 'backup-updated@example.test';
  fs.writeFileSync(backup, `${JSON.stringify(changedBackup, null, 2)}\n`, 'utf8');

  assert.equal(store.get(first.id).email, 'backup-updated@example.test');
});

test('the list, filtered query, and select-all index expose the same corrupt asset', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-corrupt-asset-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const store = new SessionAssetStore({ cwd, stateDir: '.state', cpaDir: '.state/output' });
  t.after(() => store.close());
  const id = 'corrupt-asset-001';
  fs.mkdirSync(path.dirname(store.filePath(id)), { recursive: true });
  fs.writeFileSync(store.filePath(id), '{ not json\n', 'utf8');

  const listed = store.list();
  const queried = store.query({ lifecycle: 'all', limit: 10 });
  const ids = store.matchedIds({ lifecycle: 'all' });

  assert.deepEqual(listed.map((asset) => asset.id), [id]);
  assert.deepEqual(queried.assets.map((asset) => asset.id), [id]);
  assert.deepEqual(ids, { ids: [id], total: 1 });
  assert.equal(queried.assets[0].status, 'corrupt');
  assert.equal(queried.assets[0].nextAction, 'none');
});

test('nullable asset patches clear retained optional state', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-nullable-asset-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const store = new SessionAssetStore({ cwd, stateDir: '.state', cpaDir: '.state/output' });
  t.after(() => store.close());
  const asset = store.upsert({
    email: 'nullable@example.test',
    sourceProxy: { id: 'proxy-1', endpoint: '1.2.3.4:8080' },
    security: { passwordStatus: 'configured' },
    health: { status: 'healthy', code: 'AT_VALID' },
    trial: { status: 'none' },
    oauth: { successful: true, successCount: 1 },
  });

  store.update(asset.id, {
    sourceProxy: null,
    security: null,
    health: null,
    trial: null,
    oauth: null,
  });
  const cleared = store.get(asset.id);
  assert.equal(cleared.sourceProxy, null);
  assert.equal(cleared.security, null);
  assert.equal(cleared.health, null);
  assert.equal(cleared.trial, null);
  assert.equal(cleared.oauth, null);
  assert.equal(store.list()[0].security.passwordStatus, '');
  assert.deepEqual(store.list()[0].security.failures, []);
  assert.equal(store.detail(asset.id).security, null);
  assert.equal(store.detail(asset.id).securitySummary.passwordStatus, '');
  assert.deepEqual(store.detail(asset.id).securitySummary.failures, []);
});

test('the asset index folds one changed file in instead of rebuilding the store', (t) => {
  // A run rewrites assets continuously and the console polls this list every
  // few seconds. Dropping the whole snapshot on each write made every poll
  // re-stat the store — two calls per asset — to learn what one file changed.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-index-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const store = new SessionAssetStore({ cwd, stateDir: '.state', cpaDir: '.state/output' });
  t.after(() => store.close());
  const write = (email, updatedAt) => store.upsert({ email, parentEmail: email, status: 'valid', updatedAt });

  const older = write('older@example.test', '2026-01-01T00:00:00.000Z');
  const newer = write('newer@example.test', '2026-01-02T00:00:00.000Z');
  store.indexSnapshot = null;
  store.dirtyIndexPaths.clear();
  assert.deepEqual(store.entries().map((entry) => entry.id), [newer.id, older.id]);

  const originalFiles = store.files.bind(store);
  let scans = 0;
  store.files = () => { scans += 1; return originalFiles(); };

  // Added: patched in, and in the right place.
  const newest = write('newest@example.test', '2026-01-03T00:00:00.000Z');
  assert.deepEqual(store.entries().map((entry) => entry.id), [newest.id, newer.id, older.id]);
  assert.equal(scans, 0, 'saving a new account must not rebuild the whole index');

  // Updated: the row moves rather than being rebuilt around.
  store.upsert({ id: older.id, email: 'older@example.test', parentEmail: 'older@example.test', status: 'valid', updatedAt: '2026-01-04T00:00:00.000Z' });
  assert.deepEqual(store.entries().map((entry) => entry.id), [older.id, newest.id, newer.id]);
  assert.equal(scans, 0, 'updating one account must not rebuild the whole index');

  // Deleted between the event and the read: dropped, not thrown.
  fs.rmSync(store.filePath(newer.id), { force: true });
  fs.rmSync(`${store.filePath(newer.id)}.bak`, { force: true });
  store.dirtyIndexPaths.add(store.filePath(newer.id));
  assert.deepEqual(store.entries().map((entry) => entry.id), [older.id, newest.id]);

  // Past the patch budget, re-reading the directory once beats patching each
  // file, and the result has to be the same either way.
  store.maxIndexPatch = 1;
  store.dirtyIndexPaths.add(store.filePath(older.id));
  store.dirtyIndexPaths.add(store.filePath(newest.id));
  const patched = store.entries().map((entry) => entry.id);
  const rebuilt = new SessionAssetStore({ cwd, stateDir: '.state', cpaDir: '.state/output' });
  t.after(() => rebuilt.close());
  assert.deepEqual(patched, rebuilt.entries().map((entry) => entry.id));
});

test('identity lookup reads only indexed candidates and still requires exact matches', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-identity-index-'));
  const store = new SessionAssetStore({ cwd, stateDir: '.state' });
  t.after(() => { store.close(); fs.rmSync(cwd, { recursive: true, force: true }); });
  const existing = store.upsert({ email: 'exact@example.test', accountId: 'Account-123' });
  store.upsert({ email: 'prefixexact@example.test', accountId: 'Account-1234' });
  for (let i = 0; i < 30; i += 1) store.upsert({ email: `unrelated-${i}@example.test` });
  store.entries();
  const originalRead = store.readAssetForListing.bind(store);
  let reads = 0;
  store.readAssetForListing = (file) => { reads += 1; return originalRead(file); };
  assert.equal(store.findIdentity({ email: 'new@example.test' }), null);
  assert.equal(reads, 0, 'a new address must not read any unrelated assets');
  assert.equal(store.findIdentity({ email: ' EXACT@EXAMPLE.TEST ' }).id, existing.id);
  assert.ok(reads <= 2, 'substring candidates must be checked without reading the whole store');
  reads = 0;
  assert.equal(store.findIdentity({ accountId: 'Account-123' }).id, existing.id);
  assert.ok(reads <= 2);
  assert.equal(store.findIdentity({ accountId: 'Account-12' }), null);
  assert.equal(store.findIdentity({ accountId: 'account-123' }), null);
});

test('a restart reuses the written index instead of reading every asset back', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-index-cache-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const open = () => {
    const store = new SessionAssetStore({ cwd, stateDir: '.state', cpaDir: '.state/output' });
    t.after(() => store.close());
    return store;
  };

  const first = open();
  const a = first.upsert({ email: 'a@example.test', parentEmail: 'a@example.test', status: 'valid', updatedAt: '2026-01-01T00:00:00.000Z' });
  const b = first.upsert({ email: 'b@example.test', parentEmail: 'b@example.test', status: 'valid', updatedAt: '2026-01-02T00:00:00.000Z' });
  first.indexSnapshot = null;
  first.indexCacheLoaded = false;
  const before = first.entries().map((entry) => entry.id);
  assert.deepEqual(before, [b.id, a.id]);

  // A second store is a restart: same files, cache on disk, nothing read back.
  const restarted = open();
  assert.deepEqual(restarted.entries().map((entry) => entry.id), before);
  assert.equal(restarted.indexReusedFromCache, 2);

  // A file that changed under a stopped console is caught by its signature,
  // not trusted from the cache.
  const edited = open();
  edited.upsert({ id: a.id, email: 'a@example.test', parentEmail: 'a@example.test', status: 'valid', updatedAt: '2026-01-03T00:00:00.000Z' });
  const moved = open();
  assert.deepEqual(moved.entries().map((entry) => entry.id), [a.id, b.id]);
  assert.equal(moved.indexReusedFromCache, 1);

  // A cache written by another version is ignored rather than trusted.
  const cachePath = path.join(cwd, '.state', 'session-assets.index.json');
  fs.writeFileSync(cachePath, JSON.stringify({ version: 0, entries: [] }));
  const ignored = open();
  assert.deepEqual(ignored.entries().map((entry) => entry.id), [a.id, b.id]);
  assert.equal(ignored.indexReusedFromCache, 0);
});

test('moving accounts patches the archive snapshot instead of re-reading the archive', (t) => {
  // Unlocking a 388-account batch rebuilt the snapshot from ~7500 archived
  // files and froze the console for over two minutes.
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-archive-patch-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const store = new SessionAssetStore({ cwd, stateDir: '.state', cpaDir: '.state/output' });
  t.after(() => store.close());

  const accounts = ['a', 'b', 'c'].map((name) => store.upsert({
    email: `${name}@example.test`, accountId: `account-${name}`, accessToken: `token-${name}`,
  }));
  // The first archive has no snapshot yet; a rebuild there is expected.
  store.relocate(accounts.map((account) => account.id));
  assert.equal(store.archivedIndex().cpa.length, 3);

  const rebuild = store.rewriteArchivedIndex;
  store.rewriteArchivedIndex = () => { throw new Error('the archive must not be re-read for a move'); };
  t.after(() => { store.rewriteArchivedIndex = rebuild; });

  store.relocate([accounts[0].id], { restore: true });
  let index = store.archivedIndex();
  assert.deepEqual(index.cpa.map((entry) => entry.id).sort(), [accounts[1].id, accounts[2].id].sort());
  assert.equal(index.emails.has('a@example.test'), false);
  assert.equal(index.emails.has('b@example.test'), true);

  // And the other direction adds just the moved account.
  store.relocate([accounts[0].id]);
  index = store.archivedIndex();
  assert.equal(index.cpa.length, 3);
  assert.equal(index.emails.has('a@example.test'), true);

  // A fresh store trusts the patched snapshot (its count matches the files).
  const reopened = new SessionAssetStore({ cwd, stateDir: '.state', cpaDir: '.state/output' });
  t.after(() => reopened.close());
  reopened.rewriteArchivedIndex = () => { throw new Error('the patched snapshot should be trusted'); };
  assert.equal(reopened.archivedIndex().cpa.length, 3);
});
