const TERMINAL_JOB_STATUSES = new Set([
  'complete',
  'partial',
  'failed',
  'cancelled',
  'skipped',
  'failed_proxy',
  'finalize_failed',
]);

export function isTerminalJobStatus(status = '') {
  return TERMINAL_JOB_STATUSES.has(String(status || '').trim());
}

export function isSkippableJobStatus(status = '') {
  return !isTerminalJobStatus(status);
}
