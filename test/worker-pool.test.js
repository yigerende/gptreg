'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { runWorkerPool } = require('../src/worker-pool');

test('worker pool keeps jobs from the same parent mailbox serial', async () => {
  const jobs = [
    { id: 'a1', parentAccountId: 'mail-a', status: 'pending' },
    { id: 'a2', parentAccountId: 'mail-a', status: 'pending' },
    { id: 'b1', parentAccountId: 'mail-b', status: 'pending' },
  ];
  const activeByParent = new Map();
  let maxActive = 0;
  const order = [];

  await runWorkerPool(jobs, async (job) => {
    const active = activeByParent.get(job.parentAccountId) || 0;
    assert.equal(active, 0);
    activeByParent.set(job.parentAccountId, active + 1);
    maxActive += 1;
    order.push(`start:${job.id}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
    order.push(`finish:${job.id}`);
    activeByParent.set(job.parentAccountId, 0);
  }, { maxConcurrency: 2 });

  assert.equal(maxActive, 3);
  assert.ok(order.indexOf('finish:a1') < order.indexOf('start:a2'));
});
