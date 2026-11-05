'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { LogStore, MAX_LOG_RECORDS } = require('../src/ui-server/log-store');

function makeStore() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'gpt-re-log-'));
  return {
    cwd,
    store: new LogStore({ cwd, stateDir: '.state' }),
  };
}

test('clears a task log at MAX_LOG_RECORDS and keeps the triggering record', () => {
  const { cwd, store } = makeStore();
  try {
    for (let index = 0; index < MAX_LOG_RECORDS - 1; index += 1) {
      store.append('run-fifo', { message: `record-${index}` });
    }

    const triggeringRecord = store.append('run-fifo', { message: 'trigger-reset' });
    const records = store.read('run-fifo', { limit: 99999, reveal: true });
    assert.equal(records.length, 1);
    assert.equal(records[0].message, 'trigger-reset');
    assert.equal(records[0].logReset, true);
    assert.equal(triggeringRecord.seq, MAX_LOG_RECORDS);

    const filePath = store.filePath('run-fifo');
    const physicalLines = fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/);
    assert.equal(physicalLines.length, 1);
    assert.equal(fs.existsSync(`${filePath}.1`), false);

    const next = store.append('run-fifo', { message: 'after-reset' });
    assert.equal(next.seq, MAX_LOG_RECORDS + 1);
    assert.deepEqual(store.read('run-fifo', { reveal: true }).map((record) => record.message), [
      'trigger-reset',
      'after-reset',
    ]);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('continues the sequence after an automatic reset and store recreation', () => {
  const { cwd, store } = makeStore();
  try {
    for (let index = 0; index < MAX_LOG_RECORDS; index += 1) {
      store.append('run-restart', { message: `old-${index}` });
    }

    const restarted = new LogStore({ cwd, stateDir: '.state' });
    const next = restarted.append('run-restart', { message: 'after-restart' });
    assert.equal(next.seq, MAX_LOG_RECORDS + 1);
    const records = restarted.read('run-restart', { reveal: true });
    assert.deepEqual(records.map((record) => record.message), ['old-9999', 'after-restart']);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('clear preserves sequence continuity and removes legacy rotated logs', () => {
  const { cwd, store } = makeStore();
  try {
    const first = store.append('run-clear', { message: 'first' });
    store.append('run-clear', { message: 'second' });
    const legacyPath = `${store.filePath('run-clear')}.1`;
    fs.writeFileSync(legacyPath, '{"seq":999,"message":"legacy"}\n', 'utf8');

    const cleared = store.clear('run-clear');
    assert.equal(cleared.removed, 2);
    assert.equal(fs.existsSync(legacyPath), false);

    const next = store.append('run-clear', { message: 'after-clear' });
    assert.equal(first.seq, 1);
    assert.equal(next.seq, 3);
    assert.deepEqual(store.read('run-clear', { reveal: true }).map((record) => record.message), ['after-clear']);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test('the log directory is bounded by age and by total size, not only by run count', () => {
  const { cwd, store } = makeStore();
  try {
    let clock = Date.parse('2026-09-01T00:00:00.000Z');
    store.now = () => clock;
    store.maxAgeDays = 7;
    store.maxTotalBytes = 0;

    for (const runId of ['run-old', 'run-fresh']) store.append(runId, { message: 'x' });
    const directory = path.join(cwd, '.state', 'logs');
    // Age out only the stale one.
    fs.utimesSync(path.join(directory, 'run-old.jsonl'), new Date(clock - 30 * 86_400_000), new Date(clock - 30 * 86_400_000));
    const aged = store.sweep();
    assert.deepEqual(aged.removed, ['run-old']);
    assert.equal(fs.existsSync(path.join(directory, 'run-fresh.jsonl')), true);

    // Size cap: oldest first, and a run that is still live is never touched.
    store.maxAgeDays = 0;
    for (const runId of ['run-a', 'run-b', 'run-c']) {
      for (let index = 0; index < 40; index += 1) store.append(runId, { message: `${runId}-${index}` });
    }
    const total = fs.readdirSync(directory)
      .reduce((sum, name) => sum + fs.statSync(path.join(directory, name)).size, 0);
    store.maxTotalBytes = Math.floor(total / 2);
    const trimmed = store.sweep({ protect: ['run-fresh'] });
    assert.ok(trimmed.removed.length > 0);
    assert.equal(trimmed.removed.includes('run-fresh'), false, 'a protected run keeps its log');
    assert.ok(fs.readdirSync(directory)
      .reduce((sum, name) => sum + fs.statSync(path.join(directory, name)).size, 0) <= store.maxTotalBytes
      + fs.statSync(path.join(directory, 'run-fresh.jsonl')).size);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
