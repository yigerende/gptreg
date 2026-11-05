'use strict';

const BRANCH_TERMINAL_JOB_STATUSES = Object.freeze([
  'complete',
  'partial',
  'failed',
  'cancelled',
  'skipped',
]);

const ORCHESTRATOR_V2_TERMINAL_JOB_STATUSES = Object.freeze([
  'complete',
  'skipped',
  'cancelled',
  'failed_proxy',
  'finalize_failed',
]);

const ALL_TERMINAL_JOB_STATUSES = new Set([
  ...BRANCH_TERMINAL_JOB_STATUSES,
  ...ORCHESTRATOR_V2_TERMINAL_JOB_STATUSES,
]);

function terminalJobStatusSet(kind = 'branch') {
  const values = kind === 'orchestrator-v2'
    ? ORCHESTRATOR_V2_TERMINAL_JOB_STATUSES
    : BRANCH_TERMINAL_JOB_STATUSES;
  return new Set(values);
}

function isTerminalJobStatus(status, kind = 'all') {
  const normalized = String(status || '').trim();
  if (!normalized) return false;
  if (kind === 'all') return ALL_TERMINAL_JOB_STATUSES.has(normalized);
  return terminalJobStatusSet(kind).has(normalized);
}

function isSkippableJobStatus(status, kind = 'all') {
  return !isTerminalJobStatus(status, kind);
}

function prepareJobForSkip(job) {
  if (!job || typeof job !== 'object') throw new TypeError('A job object is required');
  // A skip is a terminal decision. Clear every scheduler entry point before
  // resource cleanup so an old retry cannot requeue the job in the meantime.
  job.nextRunAt = '';
  job.retry = null;
  return job;
}

function requestJobSkip(job, { reason = 'job_skipped', requestedAt = '' } = {}) {
  prepareJobForSkip(job);
  job.skipPending = { reason, requestedAt };
  return job;
}

function markJobSkipped(job, {
  code = 'JOB_SKIPPED',
  message = 'Skipped by operator',
  updatedAt = '',
} = {}) {
  prepareJobForSkip(job);
  job.status = 'skipped';
  job.phase = 'skipped';
  job.error = { code, message };
  job.skipPending = null;
  if (updatedAt) job.updatedAt = updatedAt;
  return job;
}

module.exports = {
  isSkippableJobStatus,
  isTerminalJobStatus,
  markJobSkipped,
  prepareJobForSkip,
  requestJobSkip,
  terminalJobStatusSet,
};
