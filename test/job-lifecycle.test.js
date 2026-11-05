'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isSkippableJobStatus,
  isTerminalJobStatus,
  markJobSkipped,
  prepareJobForSkip,
  requestJobSkip,
  terminalJobStatusSet,
} = require('../src/job-lifecycle');

test('job lifecycle exposes task-family terminal status sets without conflating recoverable partial states', () => {
  const branch = terminalJobStatusSet('branch');
  const orchestrator = terminalJobStatusSet('orchestrator-v2');

  assert.equal(branch.has('partial'), true);
  assert.equal(orchestrator.has('partial'), false);
  assert.equal(orchestrator.has('failed_proxy'), true);
  assert.equal(isTerminalJobStatus('skipped', 'branch'), true);
  assert.equal(isTerminalJobStatus('waiting', 'orchestrator-v2'), false);
  assert.equal(isSkippableJobStatus('complete', 'branch'), false);
  assert.equal(isSkippableJobStatus('runnable', 'orchestrator-v2'), true);
});

test('requesting a skip clears stale scheduler work before cleanup', () => {
  const job = {
    status: 'waiting',
    phase: 'waiting_transient',
    nextRunAt: '2026-08-19T00:00:00.000Z',
    retry: { phase: 'waiting_transient', attempts: 3 },
  };

  requestJobSkip(job, { reason: 'EMAIL_OTP_TIMEOUT', requestedAt: '2026-08-19T00:01:00.000Z' });

  assert.equal(job.nextRunAt, '');
  assert.equal(job.retry, null);
  assert.deepEqual(job.skipPending, {
    reason: 'EMAIL_OTP_TIMEOUT',
    requestedAt: '2026-08-19T00:01:00.000Z',
  });
});

test('marking a job skipped is idempotent for scheduler fields and clears pending intent', () => {
  const job = {
    status: 'waiting',
    phase: 'waiting_sms_cleanup',
    nextRunAt: '2026-08-19T00:00:00.000Z',
    retry: { attempts: 1 },
    skipPending: { reason: 'operator_skip', requestedAt: '2026-08-19T00:01:00.000Z' },
  };

  markJobSkipped(job, {
    code: 'JOB_SKIPPED',
    message: 'operator_skip',
    updatedAt: '2026-08-19T00:02:00.000Z',
  });
  prepareJobForSkip(job);

  assert.equal(job.status, 'skipped');
  assert.equal(job.phase, 'skipped');
  assert.deepEqual(job.error, { code: 'JOB_SKIPPED', message: 'operator_skip' });
  assert.equal(job.skipPending, null);
  assert.equal(job.nextRunAt, '');
  assert.equal(job.retry, null);
  assert.equal(job.updatedAt, '2026-08-19T00:02:00.000Z');
});
