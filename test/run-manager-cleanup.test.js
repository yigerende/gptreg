'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { makeInitialBranchState } = require('../src/branch-orchestrator');
const { applyRunPlan, normalizeRunPlan } = require('../src/run-plan');
const { ConfigService } = require('../src/ui-server/config-service');
const { RunManager } = require('../src/ui-server/run-manager');
const { loadV2State, saveV2State } = require('../src/state-store');

function temporaryWorkspace() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-cleanup-'));
  fs.writeFileSync(path.join(cwd, 'gpt-re.config.json'), `${JSON.stringify({
    schemaVersion: 2,
    mail: { provider: 'smsbower', apiKey: 'mail-secret', apiKeyEnv: 'SMSBOWER_API_KEY', service: 'go', domain: 'gmail.com', maxPrice: 0.2, count: 1 },
    aliases: { strategy: 'plus', count: 1, maxAttempts: 1, runTag: 'test', plusAddressingEnabled: true },
    sms: { provider: 'mock', apiKey: 'sms-secret', service: { code: 'mock' }, country: { id: 151 }, maxPrice: 0, replacementBudget: 1 },
    workers: { maxConcurrency: 1 },
    registration: { exchangeToken: true, dynamicSentinel: false },
    proxyPool: { path: 'proxy-pool.txt', defaultProtocol: 'http', required: false, healthCheck: { enabled: false } },
    output: { stateDir: '.state', cpaDir: '.state/output' },
  }, null, 2)}\n`);
  fs.writeFileSync(path.join(cwd, 'proxy-pool.txt'), '# empty\n');
  return cwd;
}

async function eventually(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(predicate(), true, 'condition did not become true');
}

test('a paused ordinary rental above 200 can be cancelled without losing completed accounts', async (t) => {
  const cwd = temporaryWorkspace();
  const configService = new ConfigService({ cwd });
  const config = configService.normalized();
  const plan = normalizeRunPlan({
    taskKind: 'register_session', mailProvider: 'smsbower', mailCount: 271, workerConcurrency: 1,
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'cancel-large-rental' });
  state.status = 'paused';
  state.phase = 'paused';
  state.jobs = [{
    id: 'already-completed', status: 'complete', phase: 'complete', stateCompacted: true,
    sessionAssetId: 'saved-account',
    sessionState: { step: 'verified', clientProfile: { padding: 'x'.repeat(4000) } },
    sms: { current: null, attempts: [] },
  }];
  const stateFile = path.join(cwd, '.state', `run-${state.runId}.json`);
  saveV2State(stateFile, state);
  const manager = new RunManager({ cwd, configService, logStore: { append() {} } });
  t.after(async () => {
    await manager.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  assert.equal(manager.configForState(state).mail.count, 271);
  assert.doesNotThrow(() => makeInitialBranchState(applyRunPlan(config, plan), plan));
  const result = await manager.cancel(state.runId);
  assert.equal(result.status, 'cancelled');
  const saved = loadV2State(stateFile);
  assert.equal(saved.jobs[0].status, 'complete');
  assert.equal(saved.jobs[0].sessionAssetId, 'saved-account');
  assert.equal(saved.jobs[0].sessionState.clientProfile, undefined);
});

test('capacity checks avoid job summaries and use the current active state', async (t) => {
  const cwd = temporaryWorkspace();
  const configService = new ConfigService({ cwd });
  const config = configService.normalized();
  const state = makeInitialBranchState(config, normalizeRunPlan({ mailCount: 1 }, config), { runId: 'capacity-lightweight' });
  state.status = 'paused';
  const stateFile = path.join(cwd, '.state', `run-${state.runId}.json`);
  saveV2State(stateFile, state);
  const manager = new RunManager({ cwd, configService, logStore: { append() {} } });
  t.after(async () => { manager.active = null; await manager.shutdown(); fs.rmSync(cwd, { recursive: true, force: true }); });
  manager.summary = () => { throw new Error('capacity must not summarize jobs or read account assets'); };
  assert.equal(manager.taskCapacitySnapshot().main.available, 0);
  assert.equal(manager.unresolved()[0].status, 'paused');
  manager.active = { stateFile, state: { ...state, status: 'running' } };
  assert.equal(manager.cachedState(stateFile), manager.active.state);
  assert.equal(manager.unresolved()[0].status, 'running');
  assert.equal(manager.taskCapacitySnapshot().main.holders[0].active, true);
  let retentionScans = 0;
  manager.cpaArtifactRecords = () => { retentionScans += 1; return []; };
  assert.deepEqual(manager.pruneRetainedHistory(), { runsRemoved: 0, artifactsRemoved: 0 });
  assert.equal(retentionScans, 0, 'retention must not scan assets while a task is running');
  manager.active = null;
  state.status = 'cancelled';
  saveV2State(stateFile, state);
  assert.equal(manager.taskCapacitySnapshot().main.available, 1);
});

test('RunManager retries persisted resource cleanup waits after startup', async () => {
  const cwd = temporaryWorkspace();
  const configService = new ConfigService({ cwd });
  const config = configService.normalized();
  const plan = normalizeRunPlan({
    taskKind: 'register_session',
    mailCount: 1,
    workerConcurrency: 1,
    aliasStrategy: 'root',
    mailProvider: 'smsbower',
  }, config);
  const state = makeInitialBranchState(config, plan, { runId: 'cleanup-retry-on-boot' });
  state.status = 'waiting';
  state.phase = 'waiting_mailbox_cleanup';
  state.mailboxes = [{
    id: 'mail-pending',
    email: 'pending@gmail.com',
    rootEmail: 'pending@gmail.com',
    rented: true,
    rentalClosed: '',
    rentalCleanup: {
      action: 'cancel',
      status: 'pending',
      attempts: 1,
      nextAttemptAt: new Date(Date.now() - 1000).toISOString(),
    },
  }];
  const stateFile = path.join(cwd, '.state', `run-${state.runId}.json`);
  saveV2State(stateFile, state);

  const manager = new RunManager({
    cwd,
    configService,
    logStore: { append() {} },
  });
  let resumed = null;
  manager.resume = async (runId, options) => {
    resumed = { runId, options };
    return { runId, status: 'initialized' };
  };
  try {
    await eventually(() => Boolean(resumed));
    assert.deepEqual(resumed, {
      runId: state.runId,
      options: { cleanupRetry: true },
    });
  } finally {
    await manager.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
