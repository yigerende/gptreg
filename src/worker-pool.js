'use strict';

function runnableStatus(status) {
  return !status || status === 'pending' || status === 'queued' || status === 'blocked' || status === 'registration' || status === 'fallback_login' || status === 'callback';
}

function defaultLockKey(job) {
  return job.parentAccountId || job.parentEmail || job.id;
}

async function runWorkerPool(jobs, handler, options = {}) {
  const maxConcurrency = Math.max(1, Number(options.maxConcurrency || 1));
  const lockKeyForJob = options.lockKeyForJob || defaultLockKey;
  const pending = (jobs || []).filter((job) => runnableStatus(job.status));
  const activeLocks = new Set();
  const active = new Set();
  const results = [];
  const errors = [];

  function takeNext() {
    const index = pending.findIndex((job) => !activeLocks.has(lockKeyForJob(job)));
    if (index === -1) return null;
    const [job] = pending.splice(index, 1);
    return job;
  }

  async function runOne(job) {
    const lockKey = lockKeyForJob(job);
    activeLocks.add(lockKey);
    job.worker = {
      id: options.workerId || 'local',
      lockKey,
      startedAt: new Date().toISOString(),
    };
    try {
      const result = await handler(job);
      job.worker.finishedAt = new Date().toISOString();
      results.push({ job, result });
      if (options.onJobDone) await options.onJobDone(job, result);
    } catch (error) {
      job.worker.finishedAt = new Date().toISOString();
      job.worker.error = error.message;
      errors.push({ job, error });
      if (options.onJobError) await options.onJobError(job, error);
    } finally {
      activeLocks.delete(lockKey);
    }
  }

  return new Promise((resolve) => {
    function pump() {
      while (active.size < maxConcurrency) {
        const job = takeNext();
        if (!job) break;
        const promise = runOne(job).finally(() => {
          active.delete(promise);
          pump();
        });
        active.add(promise);
      }
      if (pending.length === 0 && active.size === 0) {
        resolve({ results, errors });
      }
    }
    pump();
  });
}

module.exports = {
  defaultLockKey,
  runWorkerPool,
};
