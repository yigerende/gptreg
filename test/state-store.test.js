'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  StateLockError,
  StateVersionError,
  acquireStateLock,
  configFingerprint,
  loadV2State,
  sanitizeConfigForFingerprint,
  saveV2State,
  saveV2StateWithRetry,
  validateV2State,
} = require('../src/state-store');

function makeState(runId, status = 'running') {
  return {
    schemaVersion: 2,
    mode: 'gpt-re-orchestrator-v2',
    runId,
    status,
    configFingerprint: '0'.repeat(64),
    phase: 'normal',
    mailboxes: [],
    jobs: [],
    workers: [],
    proxyLeases: {},
    proxyHealth: {},
    proxyCandidates: [],
    finalizationQueue: [],
    smsMarkets: {},
    events: [],
  };
}

function temporaryDirectory(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-state-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('v2 state saves atomically and recovers the previous checkpoint from .bak', (t) => {
  const directory = temporaryDirectory(t);
  const filePath = path.join(directory, 'orchestrator-run.json');
  const first = makeState('run-atomic', 'initialized');
  const second = makeState('run-atomic', 'running');

  assert.equal(saveV2State(filePath, first), filePath);
  assert.deepEqual(loadV2State(filePath), first);
  saveV2State(filePath, second);
  assert.deepEqual(loadV2State(filePath), second);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${filePath}.bak`, 'utf8')), first);
  assert.equal(fs.readdirSync(directory).some((name) => name.endsWith('.tmp')), false);

  fs.writeFileSync(filePath, '{truncated');
  const recoveries = [];
  assert.deepEqual(loadV2State(filePath, { onRecovery: (event) => recoveries.push(event) }), first);
  assert.equal(recoveries.length, 1);
  assert.equal(recoveries[0].backupPath, `${filePath}.bak`);
});

test('state save retries transient Windows sharing errors before failing', async () => {
  let attempts = 0;
  let waits = 0;
  const result = await saveV2StateWithRetry('run.json', { runId: 'retry' }, {
    delaysMs: [0, 0],
    wait: async () => { waits += 1; },
    save: async () => {
      attempts += 1;
      if (attempts < 3) throw Object.assign(new Error('file is busy'), { code: 'EBUSY' });
      return 'run.json';
    },
  });

  assert.equal(result, 'run.json');
  assert.equal(attempts, 3);
  assert.equal(waits, 2);
});

test('state saves for one file are serialized while different files remain independent', async () => {
  let active = 0;
  let maximumActive = 0;
  const save = async (_filePath, state) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return state.runId;
  };

  const [first, second, other] = await Promise.all([
    saveV2StateWithRetry('same-run.json', { runId: 'first' }, { save, delaysMs: [] }),
    saveV2StateWithRetry('same-run.json', { runId: 'second' }, { save, delaysMs: [] }),
    saveV2StateWithRetry('other-run.json', { runId: 'other' }, { save, delaysMs: [] }),
  ]);

  assert.deepEqual([first, second, other], ['first', 'second', 'other']);
  assert.equal(maximumActive, 2, 'different state files may save concurrently');
});

test('large checkpoint persistence lets main-thread timers run before the save completes', async (t) => {
  const directory = temporaryDirectory(t);
  const filePath = path.join(directory, 'large.json');
  const state = makeState('large-responsive');
  state.jobs = [{ id: 'large-job', payload: 'x'.repeat(8 * 1024 * 1024) }];
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 1);
  try {
    await saveV2StateWithRetry(filePath, state);
    assert.ok(ticks > 0, 'saving a checkpoint must not block timers until it completes');
    assert.equal(loadV2State(filePath).jobs[0].payload.length, state.jobs[0].payload.length);
  } finally {
    clearInterval(timer);
  }
});

test('background checkpoints preserve ordering, backups and version guards', async (t) => {
  const directory = temporaryDirectory(t);
  const filePath = path.join(directory, 'background.json');
  const first = makeState('background', 'running');
  const second = makeState('background', 'paused');
  await Promise.all([
    saveV2StateWithRetry(filePath, first),
    saveV2StateWithRetry(filePath, second),
  ]);
  assert.deepEqual(loadV2State(filePath), second);
  assert.deepEqual(JSON.parse(fs.readFileSync(`${filePath}.bak`, 'utf8')), first);

  const legacyPath = path.join(directory, 'legacy-background.json');
  const legacy = JSON.stringify({ schemaVersion: 1, runId: 'legacy' });
  fs.writeFileSync(legacyPath, legacy);
  await assert.rejects(saveV2StateWithRetry(legacyPath, first), StateVersionError);
  assert.equal(fs.readFileSync(legacyPath, 'utf8'), legacy);
  await saveV2StateWithRetry(filePath, makeState('background', 'cancelled'));
  assert.equal(loadV2State(filePath).status, 'cancelled');
});

test('legacy state is rejected read-only on load and save', (t) => {
  const directory = temporaryDirectory(t);
  const filePath = path.join(directory, 'legacy.json');
  const legacyText = `${JSON.stringify({ mode: 'gpt-re-orchestrator', runId: 'old-run' })}\n`;
  fs.writeFileSync(filePath, legacyText);

  assert.throws(() => loadV2State(filePath), StateVersionError);
  assert.throws(() => saveV2State(filePath, makeState('replacement')), StateVersionError);
  assert.equal(fs.readFileSync(filePath, 'utf8'), legacyText);
  assert.equal(fs.existsSync(`${filePath}.bak`), false);
});

test('missing state preserves ENOENT so callers can initialize a new run', (t) => {
  const directory = temporaryDirectory(t);
  assert.throws(
    () => loadV2State(path.join(directory, 'missing.json')),
    (error) => error.code === 'ENOENT',
  );
});

test('v2 schema validates required envelope fields and collection types', () => {
  assert.throws(
    () => validateV2State({ schemaVersion: 2, runId: '', jobs: {} }),
    /runId must be a non-empty string;.*jobs must be an array/,
  );
  assert.throws(
    () => validateV2State({ schemaVersion: 1, runId: 'legacy' }),
    StateVersionError,
  );
  assert.equal(validateV2State(makeState('valid')).runId, 'valid');
});

test('older v2 state hydrates optional scheduler fields without mutating the input', (t) => {
  const directory = temporaryDirectory(t);
  const filePath = path.join(directory, 'older-v2.json');
  const state = makeState('older-v2');
  for (const key of ['phase', 'workers', 'proxyHealth', 'proxyCandidates', 'finalizationQueue']) {
    delete state[key];
  }

  const validated = validateV2State(state);
  assert.deepEqual(
    {
      phase: validated.phase,
      workers: validated.workers,
      proxyHealth: validated.proxyHealth,
      proxyCandidates: validated.proxyCandidates,
      finalizationQueue: validated.finalizationQueue,
    },
    {
      phase: 'normal',
      workers: [],
      proxyHealth: {},
      proxyCandidates: [],
      finalizationQueue: [],
    },
  );
  assert.equal(Object.hasOwn(state, 'phase'), false);

  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`);
  const loaded = loadV2State(filePath);
  assert.equal(loaded.phase, 'normal');
  assert.deepEqual(loaded.workers, []);
  assert.deepEqual(loaded.proxyHealth, {});
  assert.deepEqual(loaded.proxyCandidates, []);
  assert.deepEqual(loaded.finalizationQueue, []);

  saveV2State(filePath, state);
  const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  assert.equal(stored.phase, 'normal');
  assert.deepEqual(stored.workers, []);
  assert.deepEqual(stored.proxyHealth, {});
  assert.deepEqual(stored.proxyCandidates, []);
  assert.deepEqual(stored.finalizationQueue, []);
  assert.deepEqual(loadV2State(filePath), stored);
});

test('v2 schema rejects invalid optional scheduler field types', () => {
  const state = makeState('invalid-optional-fields');
  state.phase = '';
  state.workers = {};
  state.proxyHealth = [];
  state.proxyCandidates = {};
  state.finalizationQueue = null;

  assert.throws(
    () => validateV2State(state),
    /phase must be a non-empty string when present; workers must be an array when present; proxyCandidates must be an array when present; finalizationQueue must be an array when present; proxyHealth must be an object when present/,
  );
});

test('exclusive state locks expose owner metadata and require explicit release', (t) => {
  const directory = temporaryDirectory(t);
  const statePath = path.join(directory, 'run.json');
  const first = acquireStateLock(statePath, { runId: 'run-lock' });
  t.after(() => first.release());

  const stored = JSON.parse(fs.readFileSync(`${statePath}.lock`, 'utf8'));
  assert.equal(stored.runId, 'run-lock');
  assert.equal(stored.pid, process.pid);
  assert.equal(stored.token, first.metadata.token);
  assert.throws(() => acquireStateLock(statePath), StateLockError);
  assert.equal(first.release(), true);
  assert.equal(first.release(), false);

  const second = acquireStateLock(statePath);
  assert.equal(second.release(), true);
});

test('config fingerprint is stable while obvious secret values are excluded', () => {
  const first = {
    mail: { baseUrl: 'http://localhost:8000', password: 'one', passwordEnv: 'MAIL_PASSWORD' },
    sms: { apiKey: 'key-one', apiKeyEnv: 'SMS_KEY', country: 151 },
    registration: { accessToken: 'access-one', tokenTimeoutMs: 60000 },
    proxy: 'http://user-one:pass-one@127.0.0.1:8080/',
  };
  const second = {
    ...first,
    mail: { ...first.mail, password: 'two' },
    sms: { ...first.sms, apiKey: 'key-two' },
    registration: { ...first.registration, accessToken: 'access-two' },
    proxy: 'http://user-two:pass-two@127.0.0.1:8080/',
  };

  assert.equal(configFingerprint(first), configFingerprint(second));
  assert.equal(
    configFingerprint({ ...first, registration: { ...first.registration, securityRequestTimeoutMs: 30000 } }),
    configFingerprint({ ...first, registration: { ...first.registration, securityRequestTimeoutMs: 15000 } }),
  );
  assert.equal(
    configFingerprint({ ...first, registration: { ...first.registration, authRequestTimeoutMs: 30000 } }),
    configFingerprint({ ...first, registration: { ...first.registration, authRequestTimeoutMs: 15000 } }),
  );
  assert.notEqual(
    configFingerprint(first),
    configFingerprint({ ...first, sms: { ...first.sms, country: 152 } }),
  );
  const sanitized = sanitizeConfigForFingerprint(first);
  assert.equal(sanitized.mail.password, '<secret>');
  assert.equal(sanitized.mail.passwordEnv, 'MAIL_PASSWORD');
  assert.equal(sanitized.sms.apiKeyEnv, 'SMS_KEY');
  assert.doesNotMatch(JSON.stringify(sanitized), /one|pass-one|key-one|access-one/);
});

test('chain extractor settings never change the run fingerprint or leak into it', () => {
  // Regression: the PayPal-link extractor shares gpt-re.config.json but is not
  // part of a registration/oauth run. Adding or editing its block must not
  // invalidate an existing checkpoint, or resume fails with
  // "Current config does not match this run".
  const base = {
    mail: { baseUrl: 'http://localhost:8000' },
    sms: { country: 151 },
    registration: { name: 'child' },
  };
  const withChain = { ...base, chain: { country: 'GB', timeoutMs: 180000, concurrency: 1, applyCheckoutUpdate: true } };
  const editedChain = { ...base, chain: { country: 'JP', timeoutMs: 900000, concurrency: 8, applyCheckoutUpdate: false } };
  assert.equal(configFingerprint(base), configFingerprint(withChain));
  assert.equal(configFingerprint(withChain), configFingerprint(editedChain));
  assert.equal(sanitizeConfigForFingerprint(withChain).chain, undefined);
});

test('selected mail alias domains are runtime tuning and do not invalidate a checkpoint fingerprint', () => {
  const first = {
    mail: {
      provider: 'mailcom',
      aliasDomainMode: 'selected',
      aliasDomains: ['geologist.com', 'keromail.com'],
    },
    registration: { name: 'child' },
  };
  const second = {
    ...first,
    mail: {
      ...first.mail,
      aliasDomainMode: 'random',
      aliasDomains: ['minister.com'],
    },
  };
  assert.equal(configFingerprint(first), configFingerprint(second));
  assert.equal(sanitizeConfigForFingerprint(first).mail.aliasDomainMode, undefined);
  assert.equal(sanitizeConfigForFingerprint(first).mail.aliasDomains, undefined);
});
