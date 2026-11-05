'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const { RobotService } = require('../src/ui-server/robot-service');
const { proxyRecoveryWaitDetails } = require('../src/ui-server/run-manager');
const { ChainStore } = require('../src/chain-store');
const { SessionAssetStore } = require('../src/session-asset-store');

function temporaryWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-robots-'));
}

async function eventually(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(predicate(), true, 'condition did not become true');
}

function makeService(cwd, runManager, calls, options = {}) {
  return new RobotService({
    cwd,
    statePath: path.join(cwd, 'robots.json'),
    runManager,
    proxyService: { pullAll: async () => { calls.push('refresh'); return { refresh: { requested: 3, succeeded: 3, failed: 0, pulled: 30 } }; } },
    definitions: [{
      id: 'test-robot',
      name: 'Test robot',
      description: 'test',
      intervalMs: 60_000,
      defaultEnabled: false,
      handler: 'proxy.refresh_all',
      commands: [{ id: 'run_now', label: 'Run now' }],
    }],
    autostart: false,
    busyPollMs: 10,
    ...options,
  });
}

test('a maintenance-only run is not delegated to the proxy refresh robot', () => {
  const details = proxyRecoveryWaitDetails({
    taskKind: 'oauth',
    phase: 'waiting_proxy_rotation',
    plan: { proxyAssignments: [{ workerSlot: 1, kind: 'maintenance' }] },
    jobs: [{
      phase: 'waiting_proxy_rotation',
      proxyTransportRecovery: { attempted: true, pending: true },
      error: { code: 'ECONNRESET', message: 'local forwarder reset' },
    }],
  });
  assert.equal(details, null);
});

test('an ordinary proxy challenge stays inside the run instead of triggering a full refresh', () => {
  const details = proxyRecoveryWaitDetails({
    taskKind: 'register_session',
    phase: 'waiting_proxy_rotation',
    jobs: [{
      phase: 'waiting_proxy_rotation',
      proxyTransportRecovery: { attempted: false, pending: false },
      error: { code: 'CLOUDFLARE_CHALLENGE', message: 'Cloudflare challenge' },
    }],
  });
  assert.equal(details, null);
});

test('a busy proxy pool does not trigger a refresh while another worker holds its exits', () => {
  const details = proxyRecoveryWaitDetails({
    taskKind: 'register_session',
    phase: 'waiting_proxy_pool',
    jobs: [{
      phase: 'waiting_proxy_pool',
      error: { code: 'PROXY_POOL_BUSY', message: 'All proxy candidates are currently in use' },
    }],
  });
  assert.equal(details, null);
});

test('an exhausted proxy pool still triggers refresh when another lane is merely busy', () => {
  const details = proxyRecoveryWaitDetails({
    taskKind: 'register_session',
    phase: 'waiting_proxy_pool',
    jobs: [
      { phase: 'waiting_proxy_pool', error: { code: 'PROXY_POOL_BUSY', message: 'one lane is waiting' } },
      { phase: 'waiting_proxy_pool', error: { code: 'PROXY_POOL_EXHAUSTED', message: 'No proxy candidate' } },
    ],
  });
  assert.equal(details?.reason, 'proxy_pool');
  assert.equal(details?.code, 'PROXY_POOL_EXHAUSTED');
});

test('robot command runs the registered handler and stores a compact result', async () => {
  const cwd = temporaryWorkspace();
  const calls = [];
  const service = makeService(cwd, { active: null, starting: false, unresolved: () => [] }, calls);
  try {
    const accepted = service.command('test-robot', 'run_now');
    assert.equal(accepted.status, 'running');
    await eventually(() => calls.length === 1 && service.list().robots[0].lastRun?.status === 'success');
    const robot = service.list().robots[0];
    assert.equal(robot.lastRun.status, 'success');
    assert.equal(robot.runs[0].result.pulled, 30);
    assert.equal(robot.runs[0].result.requested, 3);
    assert.equal(robot.runs[0].error, '');
  } finally {
    await service.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('robot trims persisted history to the latest 60 entries during load', async () => {
  const cwd = temporaryWorkspace();
  const history = Array.from({ length: 65 }, (_, index) => ({
    id: `old-run-${index}`,
    status: 'success',
    startedAt: new Date(index + 1).toISOString(),
  }));
  fs.writeFileSync(path.join(cwd, 'robots.json'), JSON.stringify({
    schemaVersion: 1,
    robots: {
      'test-robot': {
        enabled: false,
        intervalMs: 60_000,
        history,
      },
    },
  }));
  const service = makeService(cwd, { active: null, starting: false, unresolved: () => [] }, []);
  try {
    const robot = service.list().robots[0];
    assert.equal(robot.runs.length, 60);
    assert.equal(robot.runs[0].id, 'old-run-0');

    const persisted = JSON.parse(fs.readFileSync(path.join(cwd, 'robots.json'), 'utf8'));
    assert.equal(persisted.robots['test-robot'].history.length, 60);
    assert.equal(persisted.robots['test-robot'].history.at(-1).id, 'old-run-59');
  } finally {
    await service.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('robot removes the oldest entry when the 61st run completes', async () => {
  const cwd = temporaryWorkspace();
  const service = makeService(cwd, { active: null, starting: false, unresolved: () => [] }, []);
  try {
    service.getState('test-robot').history = Array.from({ length: 60 }, (_, index) => ({
      id: `old-run-${index}`,
      status: 'success',
      startedAt: new Date(index + 1).toISOString(),
    }));

    await service.runRobotOnce('test-robot', 'run_now');

    const robot = service.list().robots[0];
    assert.equal(robot.runs.length, 60);
    assert.match(robot.runs[0].id, /^robot-test-robot-/);
    assert.equal(robot.runs.at(-1).id, 'old-run-58');
    assert.equal(robot.runs.some((entry) => entry.id === 'old-run-59'), false);

    const persisted = JSON.parse(fs.readFileSync(path.join(cwd, 'robots.json'), 'utf8'));
    assert.equal(persisted.robots['test-robot'].history.length, 60);
    assert.equal(persisted.robots['test-robot'].history.some((entry) => entry.id === 'old-run-59'), false);
  } finally {
    await service.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('robot recovery also persists a bounded history after an interrupted run', async () => {
  const cwd = temporaryWorkspace();
  const history = Array.from({ length: 60 }, (_, index) => ({
    id: `old-run-${index}`,
    status: 'success',
    startedAt: new Date(index + 1).toISOString(),
  }));
  fs.writeFileSync(path.join(cwd, 'robots.json'), JSON.stringify({
    schemaVersion: 1,
    robots: {
      'test-robot': {
        enabled: false,
        intervalMs: 60_000,
        lastRun: {
          id: 'interrupted-run',
          status: 'running',
          startedAt: new Date(61).toISOString(),
          finishedAt: null,
        },
        history,
      },
    },
  }));
  const service = makeService(cwd, { active: null, starting: false, unresolved: () => [] }, []);
  try {
    const robot = service.list().robots[0];
    assert.equal(robot.runs.length, 60);
    assert.equal(robot.runs[0].id, 'interrupted-run');
    assert.equal(robot.runs.some((entry) => entry.id === 'old-run-59'), false);
    assert.equal(robot.lastRun.status, 'interrupted');

    const persisted = JSON.parse(fs.readFileSync(path.join(cwd, 'robots.json'), 'utf8'));
    assert.equal(persisted.robots['test-robot'].history.length, 60);
    assert.equal(persisted.robots['test-robot'].lastRun.status, 'interrupted');
  } finally {
    await service.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('robot settings are reflected immediately and run history can be cleared', async () => {
  const cwd = temporaryWorkspace();
  const calls = [];
  const runManager = { active: null, starting: false, unresolved: () => [] };
  const service = makeService(cwd, runManager, calls);
  try {
    const updated = service.patchRobot('test-robot', { intervalMs: 120_000, config: { batchSize: 8, workerConcurrency: 4, countryCode: 'DE' } });
    assert.equal(updated.intervalMs, 120_000);
    assert.deepEqual(updated.config, { batchSize: 8, workerConcurrency: 4, countryCode: 'DE' });

    service.command('test-robot', 'run_now');
    await eventually(() => service.list().robots[0].lastRun?.status === 'success');
    const cleared = service.clearAllRuns();
    assert.equal(cleared.removed, 1);
    assert.equal(cleared.robots[0].runs.length, 0);
    assert.equal(cleared.robots[0].lastRun, null);
  } finally {
    await service.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('proxy refresh robot refreshes and resumes a run waiting on proxy capacity', async () => {
  const cwd = temporaryWorkspace();
  const runManager = new EventEmitter();
  let refreshes = 0;
  let resumed = null;
  let unresolved = [{
    runId: 'run-proxy-wait',
    status: 'waiting',
    phase: 'waiting_proxy_pool',
    jobs: [{ phase: 'waiting_proxy', error: { code: 'proxy_pool_exhausted', message: 'No proxy is available' } }],
  }];
  runManager.active = null;
  runManager.starting = false;
  runManager.unresolved = () => unresolved;
  runManager.resume = async (runId, options) => {
    resumed = { runId, options };
    unresolved = [];
    return { runId, status: 'initialized' };
  };
  const service = new RobotService({
    cwd,
    statePath: path.join(cwd, 'robots.json'),
    runManager,
    proxyService: {
      pullAll: async () => {
        refreshes += 1;
        return { refresh: { requested: 1, succeeded: 1, failed: 0, pulled: 20 } };
      },
    },
    autostart: false,
  });
  try {
    runManager.emit('runWaiting', {
      runId: 'run-proxy-wait',
      status: 'waiting',
      proxyRecovery: true,
      reason: 'proxy_pool',
      code: 'proxy_pool_exhausted',
    });
    await eventually(() => refreshes === 1 && Boolean(resumed));
    assert.deepEqual(resumed, { runId: 'run-proxy-wait', options: { refreshProxySnapshot: true } });
    assert.equal(service.list().robots.find((robot) => robot.id === 'proxy-refresh')?.lastRun?.reason, 'task_recovery');
  } finally {
    await service.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('proxy refresh notifies an active run without changing its leases', async () => {
  const cwd = temporaryWorkspace();
  const updates = [];
  const runManager = {
    active: null,
    starting: false,
    unresolved: () => [],
    refreshActiveProxySnapshots: async (details) => {
      updates.push(details);
      return { updated: [{ runId: 'active-registration', entryCount: 4, boundWorkerCount: 2 }], skipped: [], failed: [] };
    },
  };
  const service = new RobotService({
    cwd,
    statePath: path.join(cwd, 'robots.json'),
    runManager,
    proxyService: {
      pullAll: async () => ({ refresh: { requested: 1, succeeded: 1, failed: 0, pulled: 20 } }),
    },
    autostart: false,
  });
  try {
    const result = await service.refreshAllProxies({
      reason: 'manual_refresh',
      payload: { countryCodes: ['us'] },
    });
    assert.deepEqual(updates, [{ countryCodes: ['US'], reason: 'manual_refresh' }]);
    assert.deepEqual(result.activeRunRefresh.updated, [{ runId: 'active-registration', entryCount: 4, boundWorkerCount: 2 }]);
  } finally {
    await service.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('proxy refresh robot refreshes and resumes a run waiting on one network recovery', async () => {
  const cwd = temporaryWorkspace();
  const runManager = new EventEmitter();
  let refreshes = 0;
  let resumed = null;
  let unresolved = [{
    runId: 'run-network-wait',
    status: 'waiting',
    phase: 'waiting_proxy_rotation',
    jobs: [{
      phase: 'waiting_proxy_rotation',
      proxyTransportRecovery: { attempted: true, pending: true },
      error: { code: 'CHATGPT_SESSION_TIMEOUT', message: 'Proxy request timed out' },
    }],
  }];
  runManager.active = null;
  runManager.starting = false;
  runManager.unresolved = () => unresolved;
  runManager.resume = async (runId, options) => {
    resumed = { runId, options };
    unresolved = [];
    return { runId, status: 'initialized' };
  };
  const service = new RobotService({
    cwd,
    statePath: path.join(cwd, 'robots.json'),
    runManager,
    proxyService: {
      pullAll: async () => {
        refreshes += 1;
        return { refresh: { requested: 1, succeeded: 1, failed: 0, pulled: 20 } };
      },
    },
    autostart: false,
  });
  try {
    runManager.emit('runWaiting', {
      runId: 'run-network-wait',
      status: 'waiting',
      proxyRecovery: true,
      reason: 'network_transport',
      code: 'CHATGPT_SESSION_TIMEOUT',
    });
    await eventually(() => refreshes === 1 && Boolean(resumed));
    assert.deepEqual(resumed, { runId: 'run-network-wait', options: { refreshProxySnapshot: true } });
  } finally {
    await service.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('proxy refresh robot still consumes the one recovery when refresh itself fails', async () => {
  const cwd = temporaryWorkspace();
  const runManager = new EventEmitter();
  let resumed = null;
  let unresolved = [{
    runId: 'run-refresh-failed',
    status: 'waiting',
    phase: 'waiting_proxy_rotation',
    jobs: [{ proxyTransportRecovery: { attempted: true, pending: true } }],
  }];
  runManager.active = null;
  runManager.starting = false;
  runManager.unresolved = () => unresolved;
  runManager.resume = async (runId, options) => {
    resumed = { runId, options };
    unresolved = [];
    return { runId, status: 'initialized' };
  };
  const service = new RobotService({
    cwd,
    statePath: path.join(cwd, 'robots.json'),
    runManager,
    proxyService: {
      pullAll: async () => { throw new Error('proxy refresh transport failed'); },
    },
    autostart: false,
  });
  try {
    runManager.emit('runWaiting', {
      runId: 'run-refresh-failed',
      status: 'waiting',
      proxyRecovery: true,
      reason: 'network_transport',
    });
    await eventually(() => Boolean(resumed));
    assert.deepEqual(resumed, { runId: 'run-refresh-failed', options: { refreshProxySnapshot: true } });
    await eventually(() => service.list().robots.find((robot) => robot.id === 'proxy-refresh')?.lastRun?.result?.recovery?.refreshFailed === true);
  } finally {
    await service.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('proxy recovery targets its waiting run and queues behind another main task', async () => {
  const cwd = temporaryWorkspace();
  const runManager = new EventEmitter();
  let busy = true;
  let refreshes = 0;
  let resumed = null;
  let unresolved = [
    {
      runId: 'run-proxy-target',
      status: 'waiting',
      phase: 'waiting_proxy_rotation',
      jobs: [{ phase: 'waiting_proxy_rotation', proxyTransportRecovery: { attempted: true, pending: true } }],
    },
    { runId: 'run-other-main', status: 'running' },
  ];
  runManager.active = { state: { runId: 'run-other-main' } };
  runManager.starting = false;
  runManager.unresolved = () => unresolved;
  runManager.resume = async (runId, options) => {
    if (busy) throw Object.assign(new Error('A registration task is already active or starting'), { status: 409 });
    resumed = { runId, options };
    unresolved = [];
    return { runId, status: 'initialized' };
  };
  const service = new RobotService({
    cwd,
    statePath: path.join(cwd, 'robots.json'),
    runManager,
    proxyService: {
      pullAll: async () => {
        refreshes += 1;
        return { refresh: { requested: 1, succeeded: 1, failed: 0, pulled: 20 } };
      },
    },
    autostart: false,
  });
  try {
    runManager.emit('runWaiting', {
      runId: 'run-proxy-target',
      status: 'waiting',
      proxyRecovery: true,
      reason: 'network_transport',
    });
    await eventually(() => refreshes === 1 && service.getState('proxy-refresh').lastRun?.result?.recovery?.queued === true);
    assert.equal(resumed, null);

    busy = false;
    runManager.active = null;
    unresolved = [unresolved[0]];
    runManager.emit('runFinished', { runId: 'run-other-main', status: 'complete' });
    await eventually(() => Boolean(resumed));
    assert.deepEqual(resumed, { runId: 'run-proxy-target', options: { refreshProxySnapshot: true } });
  } finally {
    await service.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('robot service discovers a persisted proxy recovery wait after restart', async () => {
  const cwd = temporaryWorkspace();
  const runManager = new EventEmitter();
  let unresolved = [{
    runId: 'persisted-proxy-wait',
    status: 'waiting',
    phase: 'waiting_proxy_rotation',
    jobs: [{ proxyTransportRecovery: { attempted: true, pending: true } }],
  }];
  let refreshes = 0;
  let resumed = null;
  runManager.active = null;
  runManager.starting = false;
  runManager.unresolved = () => unresolved;
  runManager.resume = async (runId, options) => {
    resumed = { runId, options };
    unresolved = [];
    return { runId, status: 'initialized' };
  };
  const service = new RobotService({
    cwd,
    statePath: path.join(cwd, 'robots.json'),
    runManager,
    proxyService: {
      pullAll: async () => {
        refreshes += 1;
        return { refresh: { requested: 1, succeeded: 1, failed: 0, pulled: 20 } };
      },
    },
    autostart: true,
  });
  try {
    // buildApp calls start once more after construction; recovery must stay one-shot.
    service.start();
    await eventually(() => refreshes === 1 && Boolean(resumed));
    assert.deepEqual(resumed, {
      runId: 'persisted-proxy-wait',
      options: { refreshProxySnapshot: true },
    });
    assert.equal(service.getState('proxy-refresh').lastRun.reason, 'task_recovery');
  } finally {
    await service.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('proxy refresh command runs immediately while the task is paused', async () => {
  const cwd = temporaryWorkspace();
  const runManager = new EventEmitter();
  const calls = [];
  runManager.active = null;
  runManager.starting = false;
  runManager.unresolved = () => [{ runId: 'paused-task', status: 'paused' }];
  const service = new RobotService({
    cwd,
    statePath: path.join(cwd, 'robots.json'),
    runManager,
    proxyService: {
      pullAll: async () => {
        calls.push('refresh');
        return { refresh: { requested: 1, succeeded: 1, failed: 0, pulled: 20 } };
      },
    },
    autostart: false,
  });
  try {
    const accepted = service.command('proxy-refresh', 'run_now');
    assert.equal(accepted.status, 'running');
    assert.equal(accepted.pendingRun, false);
    await eventually(() => calls.length === 1 && service.list().robots.find((robot) => robot.id === 'proxy-refresh')?.lastRun?.status === 'success');
  } finally {
    await service.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('proxy refresh resumes a paused run only when its proxy pool is exhausted', async () => {
  const cwd = temporaryWorkspace();
  const runManager = new EventEmitter();
  let unresolved = [{
    runId: 'paused-proxy-exhausted',
    status: 'paused',
    phase: 'paused',
    jobs: [{
      status: 'waiting',
      phase: 'waiting_proxy_pool',
      error: { code: 'PROXY_POOL_EXHAUSTED', message: 'No proxy candidate' },
    }],
  }];
  let resumed = null;
  runManager.active = null;
  runManager.starting = false;
  runManager.unresolved = () => unresolved;
  runManager.resume = async (runId, options) => {
    resumed = { runId, options };
    unresolved = [];
    return { runId, status: 'initialized' };
  };
  const service = new RobotService({
    cwd,
    statePath: path.join(cwd, 'robots.json'),
    runManager,
    proxyService: {
      pullAll: async () => ({ refresh: { requested: 1, succeeded: 1, failed: 0, pulled: 20 } }),
    },
    autostart: false,
  });
  try {
    service.command('proxy-refresh', 'run_now');
    await eventually(() => Boolean(resumed));
    assert.deepEqual(resumed, {
      runId: 'paused-proxy-exhausted',
      options: { refreshProxySnapshot: true },
    });
  } finally {
    await service.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('robot queues while a task is unresolved and wakes on its terminal event', async () => {
  const cwd = temporaryWorkspace();
  const calls = [];
  const runManager = new EventEmitter();
  let unresolved = [{ runId: 'run-busy', status: 'waiting' }];
  runManager.active = null;
  runManager.starting = false;
  runManager.unresolved = () => unresolved;
  const service = makeService(cwd, runManager, calls);
  try {
    const accepted = service.startRobot('test-robot');
    assert.equal(accepted.status, 'waiting');
    assert.equal(accepted.pendingRun, true);
    assert.equal(calls.length, 0);

    unresolved = [];
    runManager.emit('runFinished', { runId: 'run-busy', status: 'complete' });
    await eventually(() => calls.length === 1 && service.list().robots[0].status === 'success');
    assert.equal(service.list().robots[0].status, 'success');
  } finally {
    await service.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('robot preserves and merges payment refresh targets while waiting', async () => {
  const cwd = temporaryWorkspace();
  const calls = [];
  const runManager = new EventEmitter();
  let unresolved = [{ runId: 'run-busy', status: 'running' }];
  runManager.active = null;
  runManager.starting = false;
  runManager.unresolved = () => unresolved;
  const service = new RobotService({
    cwd,
    statePath: path.join(cwd, 'robots.json'),
    runManager,
    definitions: [{
      id: 'test-robot',
      name: 'Test robot',
      description: 'test',
      intervalMs: 60_000,
      defaultEnabled: false,
      handler: 'test.payload',
      commands: [{ id: 'run_now', label: 'Run now' }],
    }],
    handlers: {
      'test.payload': async (context) => {
        calls.push(context.payload);
        return { requested: context.payload.assetIds.length };
      },
    },
    autostart: false,
    busyPollMs: 10,
  });
  try {
    service.startRobot('test-robot');
    service.requestRun('test-robot', 'payment_success', {
      commandId: 'payment_success',
      payload: { assetIds: ['asset-one-0001'] },
    });
    service.requestRun('test-robot', 'payment_success', {
      commandId: 'payment_success',
      payload: { assetIds: ['asset-two-0002'] },
    });
    assert.equal(service.getState('test-robot').pendingRun, true);

    unresolved = [];
    runManager.emit('runFinished', { runId: 'run-busy', status: 'complete' });
    await eventually(() => calls.length === 1 && service.getState('test-robot').lastRun?.status === 'success');
    assert.deepEqual(calls, [{ assetIds: ['asset-one-0001', 'asset-two-0002'] }]);
  } finally {
    await service.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('robot settings survive a restart without persisting transient waiting state', async () => {
  const cwd = temporaryWorkspace();
  const calls = [];
  const runManager = { active: null, starting: false, unresolved: () => [] };
  const first = makeService(cwd, runManager, calls);
  first.startRobot('test-robot');
  await eventually(() => calls.length === 1);
  first.stopRobot('test-robot');
  await first.shutdown();

  const second = makeService(cwd, runManager, calls);
  try {
    const robot = second.list().robots[0];
    assert.equal(robot.enabled, false);
    assert.equal(robot.status, 'idle');
    assert.equal(robot.pendingRun, false);
    assert.equal(robot.runs.length, 1);
  } finally {
    await second.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('registration state migrates current and legacy fields to a clean explicit template', async () => {
  const cwd = temporaryWorkspace();
  const statePath = path.join(cwd, 'robots.json');
  fs.writeFileSync(statePath, JSON.stringify({
    schemaVersion: 1,
    robots: {
      'mailcom-register': {
        enabled: false,
        config: {
          mailInterface: 'current',
          batchSize: 4,
          workerConcurrency: 2,
          countryCode: 'us',
        },
      },
    },
  }));
  const service = new RobotService({
    cwd,
    statePath,
    configService: { normalized: () => ({ mail: { provider: 'fastmail' } }) },
    runManager: { active: null, starting: false, unresolved: () => [], isBusy: () => false },
    proxyService: { pullAll: async () => ({ refresh: { requested: 0, succeeded: 0, failed: 0, pulled: 0 } }) },
    autostart: false,
  });
  try {
    const robot = service.list().robots.find((entry) => entry.id === 'mailcom-register');
    // A flat single-template config becomes the first entry of the template
    // set, keeping every setting it already had.
    const [template] = robot.config.templates;
    assert.equal(robot.config.templates.length, 1);
    assert.equal(robot.config.activeTemplateId, template.templateId);
    assert.equal(template.mailInterface, 'fastmail');
    assert.equal(template.rootEmailCount, 4);
    assert.equal(template.workerCount, 2);
    assert.equal(Object.hasOwn(template, 'batchSize'), false);
    assert.equal(Object.hasOwn(template, 'workerConcurrency'), false);
    assert.throws(
      () => service.patchRobot('mailcom-register', { config: { mailInterface: 'current' } }),
      /mailInterface must be one of xiaopingguo, smsbower, mailcom, fastmail/,
    );
    const persisted = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(persisted.robots['mailcom-register'].config.templates[0].mailInterface, 'fastmail');
    assert.equal(JSON.stringify(persisted).includes('current'), false);
  } finally {
    await service.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('mail.com registration robot builds a root-only GB batch and waits for the run to finish', async () => {
  const cwd = temporaryWorkspace();
  const startedPlans = [];
  const runManager = new EventEmitter();
  let finalSummary = null;
  runManager.active = null;
  runManager.starting = false;
  runManager.unresolved = () => [];
  runManager.isBusy = () => false;
  runManager.preflight = async () => ({
    ready: true,
    mail: { ready: true, selected: 20, requested: 20 },
    proxy: { ready: true, required: true, requiredCount: 20, available: 20 },
  });
  runManager.start = async (plan) => {
    startedPlans.push(plan);
    const runId = 'run-mailcom-robot';
    setTimeout(() => {
      finalSummary = { runId, status: 'complete', counts: { sessionsSaved: plan.mailCount } };
      runManager.emit('runFinished', { runId, status: 'complete' });
    }, 0);
    runManager.get = () => finalSummary || { runId, status: 'initialized' };
    return { runId, status: 'initialized' };
  };
  const service = new RobotService({
    cwd,
    statePath: path.join(cwd, 'robots.json'),
    runManager,
    proxyService: {
      pullAll: async () => ({ refresh: { requested: 1, succeeded: 1, failed: 0, pulled: 20 } }),
      list: () => ({ dynamic: { countryPools: [{ countryCode: 'GB', total: 20, entries: Array.from({ length: 20 }, (_, index) => ({ id: `gb-${index}` })) }] } }),
    },
    autostart: false,
    busyPollMs: 10,
  });
  try {
    const accepted = service.command('mailcom-register', 'run_now');
    assert.equal(accepted.status, 'running');
    await eventually(() => startedPlans.length === 1 && service.list().robots.find((robot) => robot.id === 'mailcom-register')?.lastRun?.status === 'success');
    assert.deepEqual(startedPlans[0], {
      schemaVersion: 3,
      taskKind: 'register_session',
      mailProvider: 'mailcom',
      mailCount: 20,
      workerConcurrency: 20,
      aliasStrategy: 'root',
      aliasEnabled: false,
      postRegistrationOAuth: false,
      security: { setPassword: true, enrollTotp: true },
      aliasRunTag: 'mailcom-robot',
      proxyAssignments: Array.from({ length: 20 }, (_, index) => ({ workerSlot: index + 1, kind: 'countryPool', countryCode: 'GB' })),
    });
  } finally {
    await service.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('registration robot snapshots the selected Fastmail pool instead of defaulting to Mail.com', async () => {
  const cwd = temporaryWorkspace();
  const startedPlans = [];
  const runManager = new EventEmitter();
  let finalSummary = null;
  runManager.active = null;
  runManager.starting = false;
  runManager.unresolved = () => [];
  runManager.isBusy = () => false;
  runManager.preflight = async () => ({
    ready: true,
    mail: { ready: true, selected: 20, requested: 20 },
    proxy: { ready: true, required: true, requiredCount: 20, available: 20 },
  });
  runManager.start = async (plan) => {
    startedPlans.push(plan);
    const runId = 'run-fastmail-robot';
    setTimeout(() => {
      finalSummary = { runId, status: 'complete', counts: { sessionsSaved: plan.mailCount } };
      runManager.emit('runFinished', { runId, status: 'complete' });
    }, 0);
    runManager.get = () => finalSummary || { runId, status: 'initialized' };
    return { runId, status: 'initialized' };
  };
  const service = new RobotService({
    cwd,
    statePath: path.join(cwd, 'robots.json'),
    configService: { normalized: () => ({ mail: { provider: 'fastmail' } }) },
    runManager,
    proxyService: {
      pullAll: async () => ({ refresh: { requested: 1, succeeded: 1, failed: 0, pulled: 20 } }),
      list: () => ({ dynamic: { countryPools: [{ countryCode: 'GB', total: 20, entries: Array.from({ length: 20 }, (_, index) => ({ id: `gb-${index}` })) }] } }),
    },
    autostart: false,
    busyPollMs: 10,
  });
  try {
    service.patchRobot('mailcom-register', { config: { mailInterface: 'fastmail' } });
    service.command('mailcom-register', 'run_now');
    await eventually(() => startedPlans.length === 1 && service.list().robots.find((robot) => robot.id === 'mailcom-register')?.lastRun?.status === 'success');
    assert.equal(startedPlans[0].mailProvider, 'fastmail');
    assert.equal(startedPlans[0].aliasRunTag, 'fastmail-robot');
  } finally {
    await service.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('mail.com registration robot refreshes proxies once before starting the batch', async () => {
  const cwd = temporaryWorkspace();
  const events = [];
  const runManager = new EventEmitter();
  let finalSummary = null;
  runManager.active = null;
  runManager.starting = false;
  runManager.unresolved = () => [];
  runManager.isBusy = () => false;
  runManager.preflight = async () => ({
    ready: true,
    mail: { ready: true, selected: 20, requested: 20 },
    proxy: { ready: true, required: true, requiredCount: 20, available: 20 },
  });
  runManager.start = async (plan) => {
    events.push('start');
    const runId = 'run-mailcom-pre-refresh';
    setTimeout(() => {
      finalSummary = { runId, status: 'complete', counts: { sessionsSaved: plan.mailCount } };
      runManager.emit('runFinished', { runId, status: 'complete' });
    }, 0);
    runManager.get = () => finalSummary || { runId, status: 'initialized' };
    return { runId, status: 'initialized' };
  };
  const service = new RobotService({
    cwd,
    statePath: path.join(cwd, 'robots.json'),
    runManager,
    proxyService: {
      pullAll: async () => {
        events.push('refresh');
        return { refresh: { requested: 1, succeeded: 1, failed: 0, pulled: 20 } };
      },
      list: () => ({ dynamic: { countryPools: [{ countryCode: 'GB', total: 20 }] } }),
    },
    autostart: false,
    busyPollMs: 10,
  });
  try {
    service.command('mailcom-register', 'run_now');
    await eventually(() => events.includes('start') && service.list().robots.find((robot) => robot.id === 'mailcom-register')?.lastRun?.status === 'success');
    assert.deepEqual(events.slice(0, 2), ['refresh', 'start']);
    assert.equal(service.list().robots.find((robot) => robot.id === 'proxy-refresh')?.lastRun?.reason, 'mailcom_prestart');
  } finally {
    await service.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('stopping registration waits for the current task and skips later iterations', async () => {
  const cwd = temporaryWorkspace();
  const startedPlans = [];
  let cancelledTasks = 0;
  const runManager = new EventEmitter();
  let finalSummary = null;
  runManager.active = null;
  runManager.starting = false;
  runManager.unresolved = () => [];
  runManager.isBusy = () => false;
  runManager.cancel = async () => { cancelledTasks += 1; };
  runManager.preflight = async () => ({
    ready: true,
    mail: { ready: true, selected: 1, requested: 1 },
    proxy: { ready: true, required: true, requiredCount: 1, available: 1 },
  });
  runManager.start = async (plan) => {
    startedPlans.push(plan);
    const runId = 'run-registration-stop-after-current';
    runManager.get = () => finalSummary || { runId, status: 'initialized' };
    return { runId, status: 'initialized' };
  };
  const service = new RobotService({
    cwd,
    statePath: path.join(cwd, 'robots.json'),
    runManager,
    proxyService: {
      pullAll: async () => ({ refresh: { requested: 1, succeeded: 1, failed: 0, pulled: 1 } }),
      list: () => ({ dynamic: { countryPools: [{ countryCode: 'GB', total: 1 }] } }),
    },
    autostart: false,
    busyPollMs: 5,
  });
  try {
    service.patchRobot('mailcom-register', {
      config: { rootEmailCount: 1, workerCount: 1, countryCode: 'GB', iterations: 2 },
    });
    service.command('mailcom-register', 'run_now');
    await eventually(() => startedPlans.length === 1);
    const stopped = service.stopRobot('mailcom-register');
    assert.equal(stopped.enabled, false);
    assert.equal(stopped.status, 'stopping');
    finalSummary = {
      runId: 'run-registration-stop-after-current',
      status: 'complete',
      counts: { sessionsSaved: 1 },
    };
    runManager.emit('runFinished', { runId: finalSummary.runId, status: finalSummary.status });
    await eventually(() => service.getState('mailcom-register').status === 'idle');
    const robot = service.getState('mailcom-register');
    assert.equal(startedPlans.length, 1);
    assert.equal(cancelledTasks, 0);
    assert.equal(robot.lastRun.status, 'cancelled');
    assert.equal(robot.lastRun.result.completedIterations, 1);
    assert.equal(robot.stopping, false);
  } finally {
    await service.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('registration template refreshes between iterations and stops after the configured count', async () => {
  const cwd = temporaryWorkspace();
  const events = [];
  const delays = [];
  const refreshRequests = [];
  const summaries = new Map();
  const countdowns = [];
  const runManager = new EventEmitter();
  let sequence = 0;
  runManager.active = null;
  runManager.starting = false;
  runManager.unresolved = () => [];
  runManager.isBusy = () => false;
  runManager.preflight = async () => ({
    ready: true,
    mail: { ready: true, selected: 2, requested: 2 },
    proxy: { ready: true, required: true, requiredCount: 2, available: 2 },
  });
  runManager.start = async (plan) => {
    const runId = `run-iteration-${++sequence}`;
    events.push(`start-${plan.mailCount}`);
    summaries.set(runId, { runId, status: 'complete', counts: { sessionsSaved: plan.mailCount } });
    setTimeout(() => runManager.emit('runFinished', { runId, status: 'complete' }), 0);
    return { runId, status: 'initialized' };
  };
  runManager.get = (runId) => summaries.get(runId) || { runId, status: 'initialized' };
  const service = new RobotService({
    cwd,
    statePath: path.join(cwd, 'robots.json'),
    runManager,
    proxyService: {
      pullAll: async (options) => {
        events.push('refresh');
        refreshRequests.push(options);
        return { refresh: { requested: 1, succeeded: 1, failed: 0, pulled: 2 } };
      },
      list: () => ({ dynamic: { countryPools: [{ countryCode: 'GB', total: 2 }] } }),
    },
    autostart: false,
    busyPollMs: 5,
  });
  service.on('updated', (snapshot) => {
    const progress = snapshot.robots.find((entry) => entry.id === 'mailcom-register')?.progress;
    if (progress?.mode === 'countdown') countdowns.push(progress);
  });
  service.waitForDelay = async (ms) => { delays.push(ms); };
  try {
    service.patchRobot('mailcom-register', {
      intervalMs: 120_000,
      config: { rootEmailCount: 2, workerCount: 2, countryCode: 'GB', proxyDistribution: 'single', iterations: 2 },
    });
    service.command('mailcom-register', 'run_now');
    await eventually(() => service.getState('mailcom-register').lastRun?.status === 'success');
    assert.deepEqual(events, ['refresh', 'start-2', 'refresh', 'start-2']);
    assert.deepEqual(delays, [120_000]);
    assert.deepEqual(refreshRequests.map((request) => request.countryCodes), [['GB'], ['GB']]);
    assert.equal(countdowns.length, 1);
    assert.equal(countdowns[0].label, '下一轮开始');
    assert.equal(countdowns[0].done, 120_000);
    assert.equal(countdowns[0].total, 120_000);
    assert.ok(Date.parse(countdowns[0].endsAt) > Date.parse(countdowns[0].startedAt));
    assert.equal(service.getState('mailcom-register').lastRun.result.iterations, 2);
    assert.equal(service.getState('mailcom-register').lastRun.result.completedIterations, 2);
    assert.equal(service.getState('mailcom-register').enabled, false);
    assert.equal(service.getState('mailcom-register').nextRunAt, 0);
    assert.equal(service.getState('mailcom-register').status, 'idle');
  } finally {
    await service.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('registration continues after a partial iteration', async () => {
  const cwd = temporaryWorkspace();
  const events = [];
  const summaries = new Map();
  const runManager = new EventEmitter();
  let sequence = 0;
  runManager.active = null;
  runManager.starting = false;
  runManager.unresolved = () => [];
  runManager.isBusy = () => false;
  runManager.preflight = async () => ({
    ready: true,
    mail: { ready: true, selected: 2, requested: 2 },
    proxy: { ready: true, required: true, requiredCount: 2, available: 2 },
  });
  runManager.start = async (plan) => {
    const runId = `run-partial-iteration-${++sequence}`;
    events.push(`start-${sequence}`);
    summaries.set(runId, {
      runId,
      status: 'partial',
      counts: { sessionsSaved: 1 },
    });
    setTimeout(() => runManager.emit('runFinished', { runId, status: 'partial' }), 0);
    return { runId, status: 'initialized' };
  };
  runManager.get = (runId) => summaries.get(runId) || { runId, status: 'initialized' };
  const service = new RobotService({
    cwd,
    statePath: path.join(cwd, 'robots.json'),
    runManager,
    proxyService: {
      pullAll: async () => {
        events.push('refresh');
        return { refresh: { requested: 1, succeeded: 1, failed: 0, pulled: 2 } };
      },
      list: () => ({ dynamic: { countryPools: [{ countryCode: 'GB', total: 2 }] } }),
    },
    autostart: false,
    busyPollMs: 5,
  });
  service.waitForDelay = async () => {};
  try {
    service.patchRobot('mailcom-register', {
      intervalMs: 120_000,
      config: { rootEmailCount: 2, workerCount: 2, countryCode: 'GB', proxyDistribution: 'single', iterations: 3 },
    });
    service.command('mailcom-register', 'run_now');
    await eventually(() => service.getState('mailcom-register').lastRun?.status === 'partial');
    const robot = service.getState('mailcom-register');
    assert.deepEqual(events, ['refresh', 'start-1', 'refresh', 'start-2', 'refresh', 'start-3']);
    assert.equal(robot.lastRun.result.iterations, 3);
    assert.equal(robot.lastRun.result.completedIterations, 3);
    assert.equal(robot.lastRun.result.refreshes, 3);
    assert.equal(robot.lastRun.result.status, 'partial');
    assert.equal(robot.enabled, false);
    assert.equal(robot.status, 'idle');
  } finally {
    await service.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('registration does not start when the mandatory proxy refresh fails', async () => {
  const cwd = temporaryWorkspace();
  const runManager = new EventEmitter();
  let starts = 0;
  runManager.active = null;
  runManager.starting = false;
  runManager.unresolved = () => [];
  runManager.isBusy = () => false;
  runManager.preflight = async () => ({ ready: true, mail: { ready: true, selected: 1 }, proxy: { ready: true } });
  runManager.start = async () => { starts += 1; return { runId: 'should-not-start' }; };
  const service = new RobotService({
    cwd,
    statePath: path.join(cwd, 'robots.json'),
    runManager,
    proxyService: {
      pullAll: async () => ({ refresh: { requested: 1, succeeded: 0, failed: 1, pulled: 0 } }),
      list: () => ({ dynamic: { countryPools: [{ countryCode: 'GB', total: 1 }] } }),
    },
    autostart: false,
  });
  try {
    service.patchRobot('mailcom-register', { config: { rootEmailCount: 1, workerCount: 1, countryCode: 'GB' } });
    service.command('mailcom-register', 'run_now');
    await eventually(() => service.getState('mailcom-register').lastRun?.status === 'failed');
    assert.equal(starts, 0);
  } finally {
    await service.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('registration does not start on a partial proxy refresh', async () => {
  const cwd = temporaryWorkspace();
  const runManager = new EventEmitter();
  let starts = 0;
  runManager.active = null;
  runManager.starting = false;
  runManager.unresolved = () => [];
  runManager.isBusy = () => false;
  runManager.preflight = async () => ({ ready: true, mail: { ready: true, selected: 1 }, proxy: { ready: true } });
  runManager.start = async () => { starts += 1; return { runId: 'should-not-start' }; };
  const service = new RobotService({
    cwd,
    statePath: path.join(cwd, 'robots.json'),
    runManager,
    proxyService: {
      pullAll: async () => ({ refresh: { requested: 2, succeeded: 1, failed: 1, pulled: 1 } }),
      list: () => ({ dynamic: { countryPools: [{ countryCode: 'GB', total: 1 }] } }),
    },
    autostart: false,
  });
  try {
    service.patchRobot('mailcom-register', { config: { rootEmailCount: 1, workerCount: 1, countryCode: 'GB' } });
    service.command('mailcom-register', 'run_now');
    await eventually(() => service.getState('mailcom-register').lastRun?.status === 'failed');
    const result = service.getState('mailcom-register').lastRun.result;
    assert.equal(starts, 0);
    assert.equal(result.iterations, 1);
    assert.equal(result.completedIterations, 0);
    assert.equal(result.refreshes, 1);
    assert.match(result.reason, /partial/);
  } finally {
    await service.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('mail.com registration robot can be stopped while waiting for mailbox capacity', async () => {
  const cwd = temporaryWorkspace();
  const runManager = new EventEmitter();
  let starts = 0;
  runManager.active = null;
  runManager.starting = false;
  runManager.unresolved = () => [];
  runManager.isBusy = () => false;
  runManager.preflight = async () => ({
    ready: false,
    mail: { ready: false, selected: 0, requested: 20 },
    proxy: { ready: true, required: true, requiredCount: 20, available: 20 },
  });
  runManager.start = async () => { starts += 1; return { runId: 'never' }; };
  const service = new RobotService({
    cwd,
    statePath: path.join(cwd, 'robots.json'),
    runManager,
    proxyService: {
      pullAll: async () => ({ refresh: { requested: 1, succeeded: 1, failed: 0, pulled: 20 } }),
      list: () => ({ dynamic: { countryPools: [{ countryCode: 'GB', total: 20 }] } }),
    },
    autostart: false,
  });
  try {
    service.command('mailcom-register', 'run_now');
    await eventually(() => service.list().robots.find((robot) => robot.id === 'mailcom-register')?.status === 'waiting');
    service.stopRobot('mailcom-register');
    await eventually(() => service.list().robots.find((robot) => robot.id === 'mailcom-register')?.lastRun?.status === 'cancelled');
    assert.equal(starts, 0);
  } finally {
    await service.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('a proxy shortage is topped up from inside the capacity wait, breaking the two-robot deadlock', async () => {
  const cwd = temporaryWorkspace();
  const runManager = new EventEmitter();
  runManager.active = null;
  runManager.starting = false;
  runManager.unresolved = () => [];
  runManager.isBusy = () => false;
  let started = 0;
  runManager.start = async () => { started += 1; return { runId: 'run-topup' }; };
  runManager.get = () => ({ runId: 'run-topup', status: 'complete', counts: { sessionsSaved: 20 } });
  runManager.preflight = async () => ({ mail: { selected: 20, ready: true }, proxy: { ready: true } });

  // The country pool starts empty and only a proxy refresh fills it. The old
  // code refreshed once before the wait, then polled forever; the scheduled
  // proxy-refresh robot could not fire because this robot held `running`.
  let poolTotal = 0;
  let refreshes = 0;
  const service = new RobotService({
    cwd,
    statePath: path.join(cwd, 'robots.json'),
    runManager,
    proxyService: {
      pullAll: async () => { refreshes += 1; poolTotal = 20; return { refresh: { requested: 1, succeeded: 1, failed: 0, pulled: 20 } }; },
      list: () => ({ dynamic: { countryPools: [{ countryCode: 'GB', total: poolTotal }] } }),
    },
    autostart: false,
  });
  // Keep the poll instant so the test does not wait real seconds.
  service.waitForDelay = async () => {};
  try {
    service.command('mailcom-register', 'run_now');
    await eventually(
      () => service.list().robots.find((robot) => robot.id === 'mailcom-register')?.lastRun?.status === 'success',
      3000,
    );
    // It filled the pool itself and then launched — no deadlock, no manual restart.
    assert.ok(refreshes >= 1, 'the robot should have refreshed proxies during the wait');
    assert.equal(started, 1);
  } finally {
    await service.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('a persistent resource shortage gives up the cycle instead of holding the pipeline forever', async () => {
  const cwd = temporaryWorkspace();
  const runManager = new EventEmitter();
  runManager.active = null;
  runManager.starting = false;
  runManager.unresolved = () => [];
  runManager.isBusy = () => false;
  let started = 0;
  runManager.start = async () => { started += 1; return { runId: 'never' }; };
  // mail.com can never satisfy the batch — the 409 exhaustion shape.
  runManager.preflight = async () => ({ mail: { selected: 0, ready: false }, proxy: { ready: true } });

  // A clock the test advances past the 15-minute give-up budget.
  let clock = 1_000_000;
  const service = new RobotService({
    cwd,
    statePath: path.join(cwd, 'robots.json'),
    runManager,
    now: () => clock,
    proxyService: {
      pullAll: async () => ({ refresh: { requested: 1, succeeded: 1, failed: 0, pulled: 20 } }),
      list: () => ({ dynamic: { countryPools: [{ countryCode: 'GB', total: 20 }] } }),
    },
    autostart: false,
  });
  // Each poll advances the clock 5 minutes, so the shortage budget lapses in a
  // few iterations without any real waiting.
  service.waitForDelay = async () => { clock += 5 * 60 * 1000; };
  try {
    service.command('mailcom-register', 'run_now');
    await eventually(
      () => service.list().robots.find((robot) => robot.id === 'mailcom-register')?.lastRun?.status === 'skipped',
      3000,
    );
    const robot = service.list().robots.find((entry) => entry.id === 'mailcom-register');
    assert.equal(robot.lastRun.status, 'skipped');
    assert.equal(started, 0, 'it must not start a run it cannot staff');
    // Crucially it let go of `running`/`waiting`, so the sibling proxy-refresh
    // robot is no longer locked out and the next interval can try again.
    assert.notEqual(robot.status, 'running');
    assert.notEqual(robot.status, 'waiting');
  } finally {
    await service.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('all rejected selected domains end the cycle even when the mailbox pool is also short', async () => {
  const cwd = temporaryWorkspace();
  const runManager = new EventEmitter();
  let started = 0;
  runManager.active = null;
  runManager.starting = false;
  runManager.unresolved = () => [];
  runManager.isBusy = () => false;
  runManager.preflight = async () => ({
    ready: false,
    mail: {
      ready: false,
      selected: 0,
      requested: 20,
      domainReady: false,
      aliasDomains: {
        catalogAvailable: true,
        unavailable: ['keromail.com'],
      },
    },
    proxy: { ready: true, required: true, requiredCount: 20, available: 20 },
  });
  runManager.start = async () => { started += 1; return { runId: 'never' }; };
  const service = new RobotService({
    cwd,
    statePath: path.join(cwd, 'robots.json'),
    runManager,
    proxyService: {
      pullAll: async () => ({ refresh: { requested: 1, succeeded: 1, failed: 0, pulled: 20 } }),
      list: () => ({ dynamic: { countryPools: [{ countryCode: 'GB', total: 20 }] } }),
    },
    autostart: false,
  });
  try {
    service.command('mailcom-register', 'run_now');
    await eventually(() => service.list().robots.find((robot) => robot.id === 'mailcom-register')?.lastRun?.status === 'skipped');
    const robot = service.list().robots.find((entry) => entry.id === 'mailcom-register');
    assert.equal(started, 0);
    assert.match(robot.lastRun.result.reason, /keromail\.com/);
    assert.notEqual(robot.status, 'waiting');
  } finally {
    await service.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('a run killed mid-flight is settled on load instead of reporting running forever', async () => {
  // A hard kill (restart while a batch is in flight) never reaches execute()'s
  // finally, so the persisted lastRun keeps status:'running' with no finishedAt.
  // Restored verbatim, the robot then reports "running" for good while doing
  // nothing at all — indistinguishable from broken.
  const cwd = temporaryWorkspace();
  fs.writeFileSync(path.join(cwd, 'robots.json'), JSON.stringify({
    schemaVersion: 1,
    robots: {
      'mailcom-register': {
        enabled: true,
        intervalMs: 300000,
        config: { batchSize: 20, workerConcurrency: 20, countryCode: 'US' },
        nextRunAt: null,
        lastRun: {
          id: 'robot-mailcom-register-killed',
          command: 'interval',
          reason: 'interval',
          status: 'running',
          startedAt: '2026-08-19T12:15:00.000Z',
          finishedAt: null,
          durationMs: 0,
          result: null,
          error: '',
        },
        history: [{ id: 'robot-mailcom-register-killed', status: 'running', finishedAt: null }],
      },
    },
  }));
  const runManager = { active: null, starting: false, unresolved: () => [], isBusy: () => false };
  const service = new RobotService({
    cwd,
    statePath: path.join(cwd, 'robots.json'),
    runManager,
    proxyService: { pullAll: async () => ({ refresh: { requested: 1, succeeded: 1, failed: 0, pulled: 20 } }) },
    autostart: false,
  });
  try {
    const robot = service.list().robots.find((entry) => entry.id === 'mailcom-register');
    // Due, not running.
    assert.notEqual(robot.status, 'running');
    assert.equal(robot.lastRun.status, 'interrupted');
    assert.ok(robot.lastRun.finishedAt, 'the killed run must be closed out');
    // The history entry is corrected too, not left as a second phantom.
    assert.equal(robot.runs.filter((entry) => entry.status === 'running').length, 0);
    // It is scheduled to go again rather than waiting out a full interval.
    assert.ok(robot.nextRunAt, 'an interrupted robot should be due');
  } finally {
    await service.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('the maintenance robot reports both of its counters', async () => {
  // The run record is an allow-list projection, so a counter that is not named
  // in it is dropped without a word. A run that archived 4081 accounts was
  // recorded as `{ok: true, deletedBanned: 0}` — a robot that looked like it
  // had done nothing at all.
  const cwd = temporaryWorkspace();
  const service = new RobotService({
    cwd,
    statePath: path.join(cwd, 'robots.json'),
    runManager: {
      active: null,
      starting: false,
      unresolved: () => [],
      isBusy: () => false,
      archiveSettledAssets: () => ({ candidates: 7, archived: 7, skipped: 0 }),
      sessionAssets: () => ({ list: () => [], remove: () => ({ removed: [] }) }),
    },
    proxyService: { pullAll: async () => ({ refresh: { requested: 0, succeeded: 0, failed: 0, pulled: 0 } }) },
    autostart: false,
  });
  try {
    const run = await service.runRobotOnce('account-maintenance', 'run_now');
    assert.equal(run.status, 'success');
    assert.equal(run.result.archivedSettled, 7);
    assert.equal(run.result.deletedBanned, 0);
  } finally {
    await service.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('the maintenance robot keeps only its live switches, and they persist', async () => {
  const cwd = temporaryWorkspace();
  const runManager = { active: null, starting: false, unresolved: () => [], isBusy: () => false };
  const options = {
    cwd,
    statePath: path.join(cwd, 'robots.json'),
    runManager,
    proxyService: { pullAll: async () => ({ refresh: { requested: 0, succeeded: 0, failed: 0, pulled: 0 } }) },
    autostart: false,
  };
  const first = new RobotService(options);
  try {
    const id = 'account-maintenance';
    assert.deepEqual(Object.keys(first.getState(id).config), ['deleteBannedAssets', 'archiveSettledAssets']);
    assert.equal(first.getState(id).config.deleteBannedAssets, true);
    assert.equal(first.getState(id).config.archiveSettledAssets, true);
    // The four retired rules are dropped rather than stored, so a robots.json
    // written by an older build cannot resurrect them.
    const updated = first.patchRobot(id, {
      config: {
        deleteBannedAssets: false,
        deleteChainAuthFailures: true,
        refreshPaidAssets: true,
        autoExtractRegistered: true,
        deleteMailcomNoValueGroups: true,
      },
    });
    assert.deepEqual(Object.keys(updated.config), ['deleteBannedAssets', 'archiveSettledAssets']);
    assert.equal(updated.config.deleteBannedAssets, false);
  } finally {
    await first.shutdown();
  }
  const second = new RobotService(options);
  try {
    assert.equal(second.getState('account-maintenance').config.deleteBannedAssets, false);
    assert.equal(second.getState('account-maintenance').config.archiveSettledAssets, true);
    assert.deepEqual(Object.keys(second.getState('account-maintenance').config), ['deleteBannedAssets', 'archiveSettledAssets']);
  } finally {
    await second.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('the pre-rename deleteBannedAfterRefresh key is read once and not written back', async () => {
  const cwd = temporaryWorkspace();
  const statePath = path.join(cwd, 'robots.json');
  fs.writeFileSync(statePath, JSON.stringify({
    schemaVersion: 1,
    robots: { 'account-maintenance': { enabled: true, config: { deleteBannedAfterRefresh: false } } },
  }));
  const service = new RobotService({
    cwd,
    statePath,
    runManager: { active: null, starting: false, unresolved: () => [], isBusy: () => false },
    proxyService: { pullAll: async () => ({ refresh: { requested: 0, succeeded: 0, failed: 0, pulled: 0 } }) },
    autostart: false,
  });
  try {
    const config = service.getState('account-maintenance').config;
    assert.equal(config.deleteBannedAssets, false);
    assert.equal(Object.hasOwn(config, 'deleteBannedAfterRefresh'), false);
  } finally {
    await service.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('the maintenance robot clears deactivated assets from every inventory pool', async () => {
  const cwd = temporaryWorkspace();
  const deactivated = { status: 'banned', code: 'ACCOUNT_DEACTIVATED', operation: 'session_refresh' };
  const assets = [
    { id: 'asset-banned-0001', health: { ...deactivated } },
    { id: 'asset-manual-0002', health: { status: 'banned', code: 'ACCOUNT_DEACTIVATED', operation: 'probe' } },
    // An operator reserved this one for sale before OpenAI closed it. It can
    // never be sold now, so it must not stay parked in the planned pool.
    { id: 'asset-planned-0003', lifecycle: 'planned', health: { ...deactivated } },
    // The sale record remains sold for reporting, but cleanup must remove it.
    { id: 'asset-sold-0004', lifecycle: 'sold', health: { ...deactivated } },
    { id: 'asset-live-0005', lifecycle: 'planned' },
  ];
  const removedAssets = [];
  const assetStore = {
    list: () => assets,
    remove: (ids) => {
      removedAssets.push(...ids);
      for (const id of ids) {
        const index = assets.findIndex((asset) => asset.id === id);
        if (index >= 0) assets.splice(index, 1);
      }
      return { removed: ids, missing: [] };
    },
  };
  const runManager = {
    active: null,
    starting: false,
    unresolved: () => [],
    isBusy: () => false,
    sessionAssets: () => assetStore,
    sessionAssetIdsInUse: () => new Set(),
  };
  const service = new RobotService({
    cwd,
    statePath: path.join(cwd, 'robots.json'),
    runManager,
    proxyService: { pullAll: async () => ({ refresh: { requested: 0, succeeded: 0, failed: 0, pulled: 0 } }) },
    autostart: false,
  });
  try {
    service.command('account-maintenance', 'run_now');
    await eventually(() => service.getState('account-maintenance').lastRun?.status === 'success');
    assert.deepEqual(removedAssets.sort(), ['asset-banned-0001', 'asset-manual-0002', 'asset-planned-0003', 'asset-sold-0004']);
    assert.deepEqual(assets.map((asset) => asset.id).sort(), ['asset-live-0005']);
    assert.equal(service.getState('account-maintenance').lastRun.result.deletedBanned, 4);
  } finally {
    await service.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('the maintenance robot reports nothing to do without touching a healthy store', async () => {
  const cwd = temporaryWorkspace();
  const assets = [{ id: 'asset-live-0001' }, { id: 'asset-sold-0002', lifecycle: 'sold' }];
  let removeCalls = 0;
  const assetStore = { list: () => assets, remove: () => { removeCalls += 1; return { removed: [], missing: [] }; } };
  const service = new RobotService({
    cwd,
    statePath: path.join(cwd, 'robots.json'),
    runManager: {
      active: null,
      starting: false,
      unresolved: () => [],
      isBusy: () => false,
      sessionAssets: () => assetStore,
      sessionAssetIdsInUse: () => new Set(),
    },
    proxyService: { pullAll: async () => ({ refresh: { requested: 0, succeeded: 0, failed: 0, pulled: 0 } }) },
    autostart: false,
  });
  try {
    service.command('account-maintenance', 'run_now');
    await eventually(() => service.getState('account-maintenance').lastRun?.status === 'success');
    assert.equal(service.getState('account-maintenance').lastRun.result.deletedBanned, 0);
    assert.equal(removeCalls, 0);
    assert.deepEqual(assets.map((asset) => asset.id), ['asset-live-0001', 'asset-sold-0002']);
  } finally {
    await service.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('a full proxy refresh runs hosts in parallel, reports progress, and grades an outage as failed', async () => {
  const cwd = temporaryWorkspace();
  const calls = [];
  let inFlight = 0;
  let peakInFlight = 0;
  const progress = [];
  const proxyService = {
    // Two hosts, three sources: the two hosts must overlap, the two sources on
    // one host must not.
    pullAll: async ({ onProgress, signal }) => {
      const sources = [
        { host: 'a.example', code: 'US' },
        { host: 'a.example', code: 'GB' },
        { host: 'b.example', code: 'JP' },
      ];
      const byHost = new Map();
      for (const source of sources) byHost.set(source.host, [...(byHost.get(source.host) || []), source]);
      let done = 0;
      const results = (await Promise.all([...byHost.values()].map(async (bucket) => {
        const bucketResults = [];
        for (const source of bucket) {
          inFlight += 1;
          peakInFlight = Math.max(peakInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 15));
          inFlight -= 1;
          calls.push(source.code);
          done += 1;
          onProgress?.({ done, total: sources.length, label: source.code });
          bucketResults.push({ ok: false, countryCode: source.code, sourceId: source.host, pulled: 0, error: 'boom' });
        }
        return bucketResults;
      }))).flat();
      void signal;
      return { refresh: { requested: results.length, succeeded: 0, failed: results.length, pulled: 0, results } };
    },
  };
  const service = new RobotService({
    cwd,
    statePath: path.join(cwd, 'robots.json'),
    proxyService,
    definitions: [{
      id: 'proxy-refresh',
      name: 'Proxy refresh',
      description: 'test',
      intervalMs: 600_000,
      defaultEnabled: false,
      handler: 'proxy.refresh_all',
      executionMode: 'background',
      commands: [{ id: 'run_now', label: 'Run now' }],
    }],
  });
  service.on('updated', (snapshot) => {
    const robot = snapshot.robots.find((entry) => entry.id === 'proxy-refresh');
    if (robot?.progress) progress.push(`${robot.progress.done}/${robot.progress.total}`);
  });
  try {
    service.command('proxy-refresh', 'run_now');
    await eventually(() => service.getState('proxy-refresh').lastRun?.finishedAt, 4000);
    const run = service.getState('proxy-refresh').lastRun;

    // Every source down is an outage, not a partial success.
    assert.equal(run.status, 'failed');
    // The per-source reasons survive into the run record.
    assert.equal(run.result.sources.length, 3);
    assert.equal(run.result.sources[0].error, 'boom');
    // Hosts overlapped; the two sources sharing a host did not.
    assert.equal(peakInFlight, 2);
    assert.ok(progress.includes('3/3'), `progress was ${progress.join(',')}`);
    // Progress is live-only and does not outlive the run.
    assert.equal(service.publicRobot('proxy-refresh').progress, null);
  } finally {
    await service.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('clearing a robot history also clears the task logs that history points at', async () => {
  const cwd = temporaryWorkspace();
  const removedLogs = [];
  const service = new RobotService({
    cwd,
    statePath: path.join(cwd, 'robots.json'),
    proxyService: { pullAll: async () => ({ refresh: { requested: 1, succeeded: 1, failed: 0, pulled: 1 } }) },
    logStore: { remove: (runId) => { removedLogs.push(runId); return true; } },
    runManager: { activeRun: () => null },
    definitions: [{
      id: 'proxy-refresh',
      name: 'Proxy refresh',
      description: 'test',
      intervalMs: 600_000,
      defaultEnabled: false,
      handler: 'proxy.refresh_all',
      executionMode: 'background',
      commands: [{ id: 'run_now', label: 'Run now' }],
    }],
  });
  try {
    const state = service.getState('proxy-refresh');
    // A robot only stores a one-line summary; the bytes live in the task's log.
    state.history = [{ id: 'r1', status: 'success', result: { runId: 'ui-task-1' } }];
    state.lastRun = { id: 'r1', status: 'success', result: { runId: 'ui-task-1' } };

    const cleared = service.clearRuns('proxy-refresh');
    assert.equal(cleared.removed, 1);
    assert.equal(cleared.logsRemoved, 1);
    assert.deepEqual(removedLogs, ['ui-task-1']);
  } finally {
    await service.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('registration schedule starts the named template and refuses when the slot is taken', async () => {
  const cwd = temporaryWorkspace();
  const statePath = path.join(cwd, 'robots.json');
  let busy = false;
  const service = new RobotService({
    cwd,
    statePath,
    configService: { normalized: () => ({ mail: { provider: 'smsbower' } }) },
    runManager: { active: null, starting: false, unresolved: () => [], isBusy: () => busy },
    proxyService: { pullAll: async () => ({ refresh: { requested: 0, succeeded: 0, failed: 0, pulled: 0 } }) },
    autostart: false,
  });
  try {
    service.patchRobot('mailcom-register', {
      config: {
        activeTemplateId: 'night',
        templates: [
          { templateId: 'day', name: '白天', mailInterface: 'mailcom', rootEmailCount: 4, workerCount: 2 },
          {
            templateId: 'night',
            name: '夜间挂租',
            mailInterface: 'smsbower',
            mailRentalWatch: true,
            rootEmailCount: 4,
            workerCount: 2,
            schedule: { enabled: true, times: ['03:00'] },
          },
        ],
      },
    });

    const scheduled = service.publicRobot('mailcom-register').schedule;
    assert.equal(scheduled.next.templateId, 'night');
    assert.equal(scheduled.next.name, '夜间挂租');
    // Only the scheduled template is listed; the other has no times.
    assert.deepEqual(scheduled.upcoming.map((entry) => entry.templateId), ['night']);

    const requests = [];
    service.requestRun = (id, reason, options) => { requests.push({ id, reason, options }); return {}; };

    // A task holding the main slot turns the start away rather than queuing it.
    busy = true;
    service.fireRegistrationSchedule({ templateId: 'night', name: '夜间挂租', at: service.now() });
    assert.equal(requests.length, 0);
    let last = service.publicRobot('mailcom-register').schedule.last;
    assert.equal(last.outcome, 'skipped');
    assert.equal(last.templateName, '夜间挂租');
    assert.match(last.reason, /主任务位/);

    // The refusal survives a restart, because nobody was watching when it
    // happened.
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).robots['mailcom-register'].lastSchedule.outcome, 'skipped');

    busy = false;
    service.fireRegistrationSchedule({ templateId: 'night', name: '夜间挂租', at: service.now() });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].reason, 'schedule');
    assert.equal(requests[0].options.payload.templateId, 'night');
    last = service.publicRobot('mailcom-register').schedule.last;
    assert.equal(last.outcome, 'started');

    // A fire whose moment has long passed is dropped instead of starting a
    // round for a time nobody is waiting on any more.
    service.fireRegistrationSchedule({ templateId: 'night', name: '夜间挂租', at: service.now() - 60 * 60 * 1000 });
    assert.equal(requests.length, 1);
    assert.equal(service.publicRobot('mailcom-register').schedule.last.outcome, 'missed');
  } finally {
    await service.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('a hang-rental round starts on an empty shelf, and an ordinary one still waits for its addresses', async () => {
  const cwd = temporaryWorkspace();
  const startedPlans = [];
  const runManager = new EventEmitter();
  let finalSummary = null;
  runManager.active = null;
  runManager.starting = false;
  runManager.unresolved = () => [];
  runManager.isBusy = () => false;
  // Nothing in stock at this instant. `mail.ready` is still true because
  // preflight judges a rental-watch plan by provider and price, not by count.
  runManager.preflight = async () => ({
    ready: true,
    mail: { ready: true, selected: 0, requested: 60 },
    proxy: { ready: true, required: true, requiredCount: 2, available: 2 },
  });
  runManager.start = async (plan) => {
    startedPlans.push(plan);
    const runId = 'run-partial-stock';
    setTimeout(() => {
      finalSummary = { runId, status: 'complete', counts: { sessionsSaved: 8 } };
      runManager.emit('runFinished', { runId, status: 'complete' });
    }, 0);
    runManager.get = () => finalSummary || { runId, status: 'initialized' };
    return { runId, status: 'initialized' };
  };
  const service = new RobotService({
    cwd,
    statePath: path.join(cwd, 'robots.json'),
    runManager,
    configService: { normalized: () => ({ mail: { provider: 'smsbower' } }) },
    proxyService: {
      pullAll: async () => ({ refresh: { requested: 1, succeeded: 1, failed: 0, pulled: 20 } }),
      list: () => ({ dynamic: { countryPools: [{ countryCode: 'ZA', total: 20, entries: Array.from({ length: 20 }, (_, index) => ({ id: `za-${index}` })) }] } }),
    },
    autostart: false,
    busyPollMs: 10,
    capacityMaxWaitMs: 50,
    capacityPollMs: 10,
  });
  try {
    // 挂租 accumulates its target by polling and the provider restocks in
    // batches, so an empty shelf right now is no reason to refuse the round;
    // the run does the waiting, not the launch gate.
    service.patchRobot('mailcom-register', {
      config: {
        activeTemplateId: 'rental',
        templates: [{
          templateId: 'rental',
          name: '挂租',
          mailInterface: 'smsbower',
          mailRentalWatch: true,
          mailRentalTarget: 60,
          rootEmailCount: 20,
          workerCount: 2,
          proxyMode: 'countryPool',
          proxyDistribution: 'single',
          countryCode: 'ZA',
        }],
      },
    });
    service.command('mailcom-register', 'run_now');
    await eventually(() => startedPlans.length === 1);
    assert.equal(startedPlans[0].mailRentalWatch, true);
    assert.equal(startedPlans[0].mailCount, 60);
    await eventually(() => service.getState('mailcom-register').running === false);

    // The same shortfall on an ordinary rental is still a shortfall: nothing
    // accumulates later, so the round is refused and says which interface.
    service.patchRobot('mailcom-register', {
      config: {
        activeTemplateId: 'rental',
        templates: [{
          templateId: 'rental',
          name: '普通',
          mailInterface: 'smsbower',
          mailRentalWatch: false,
          rootEmailCount: 60,
          workerCount: 2,
          proxyMode: 'countryPool',
          proxyDistribution: 'single',
          countryCode: 'ZA',
        }],
      },
    });
    service.command('mailcom-register', 'run_now');
    await eventually(() => service.getState('mailcom-register').lastRun?.status === 'skipped');
    assert.equal(startedPlans.length, 1);
    assert.match(service.getState('mailcom-register').lastRun.result.reason, /SMSBower 可用地址长时间不足（0\/60）/);
  } finally {
    await service.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('two templates due in the same minute start one and refuse the rest out loud', async () => {
  const cwd = temporaryWorkspace();
  const statePath = path.join(cwd, 'robots.json');
  const service = new RobotService({
    cwd,
    statePath,
    configService: { normalized: () => ({ mail: { provider: 'smsbower' } }) },
    runManager: { active: null, starting: false, unresolved: () => [], isBusy: () => false },
    proxyService: { pullAll: async () => ({ refresh: { requested: 0, succeeded: 0, failed: 0, pulled: 0 } }) },
    autostart: false,
  });
  try {
    service.patchRobot('mailcom-register', {
      config: {
        activeTemplateId: 'early',
        templates: [
          { templateId: 'early', name: '早班', mailInterface: 'mailcom', rootEmailCount: 4, workerCount: 2, schedule: { enabled: true, times: ['03:00'] } },
          { templateId: 'late', name: '晚班', mailInterface: 'smsbower', mailRentalWatch: true, rootEmailCount: 4, workerCount: 2, schedule: { enabled: true, times: ['03:00'] } },
        ],
      },
    });
    // Both templates fire at the same clock time, so both are listed.
    const upcoming = service.publicRobot('mailcom-register').schedule.upcoming;
    assert.deepEqual(upcoming.map((entry) => entry.templateId).sort(), ['early', 'late']);

    const requests = [];
    // Mirrors what `execute` does synchronously, which is what makes the
    // second template of the pair see a busy robot.
    service.requestRun = (id, reason, options) => {
      requests.push({ id, reason, options });
      service.getState(id).running = true;
      return {};
    };

    const at = service.now();
    service.fireRegistrationSchedule([
      { templateId: 'early', name: '早班', at },
      { templateId: 'late', name: '晚班', at },
    ]);

    // One round starts; the other is refused rather than dropped silently,
    // and the refusal is what the operator is left looking at.
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.payload.templateId, 'early');
    const last = service.publicRobot('mailcom-register').schedule.last;
    assert.equal(last.templateId, 'late');
    assert.equal(last.outcome, 'skipped');
    assert.match(last.reason, /仍在运行/);
  } finally {
    await service.shutdown();
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('registration robot compiles the template a scheduled run names', () => {
  const cwd = temporaryWorkspace();
  const service = new RobotService({
    cwd,
    statePath: path.join(cwd, 'robots.json'),
    configService: { normalized: () => ({ mail: { provider: 'smsbower' } }) },
    runManager: { active: null, starting: false, unresolved: () => [], isBusy: () => false },
    proxyService: { pullAll: async () => ({ refresh: {} }), list: () => ({ dynamic: { countryPools: [] } }) },
    autostart: false,
  });
  try {
    service.patchRobot('mailcom-register', {
      config: {
        activeTemplateId: 'day',
        templates: [
          { templateId: 'day', name: '白天', mailInterface: 'mailcom', rootEmailCount: 6, workerCount: 3 },
          { templateId: 'night', name: '夜间挂租', mailInterface: 'smsbower', mailRentalWatch: true, mailRentalTarget: 80, rootEmailCount: 6, workerCount: 3 },
        ],
      },
    });
    const state = service.getState('mailcom-register');
    assert.equal(service.registrationSettings(state.config, '').templateId, 'day');
    assert.equal(service.registrationSettings(state.config, 'night').mailRentalWatch, true);
    assert.throws(() => service.registrationSettings(state.config, 'nope'), /Registration template not found/);
    const { plan } = service.registrationPlan(state.config, null, 'night');
    assert.equal(plan.mailProvider, 'smsbower');
    assert.equal(plan.mailRentalWatch, true);
    assert.equal(plan.mailCount, 80);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
