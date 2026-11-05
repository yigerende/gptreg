'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildApp } = require('../src/ui-server/app');
const { pageRows, artifactPage } = require('../src/ui-server/pagination');

test('engine lists send disjoint pages and keep full internal snapshots', async (t) => {
  const rows = Array.from({ length: 123 }, (_, i) => ({ id: `id-${i}`, runId: `run-${i}`, status: i === 100 ? 'running' : 'complete', key: `key-${i}`, modifiedAt: String(1000 - i), lifecycle: i % 2 ? 'sold' : 'active', isPlus: i % 3 === 0 }));
  const robot = { id: 'robot', runs: rows.map(row => ({ id: row.id, startedAt: row.modifiedAt })) };
  const app = buildApp({
    runManager: { async shutdown() {}, get: () => ({ jobs: rows.map((row, i) => ({ ...row, error: i === 122 ? { message: 'recoverable' } : undefined })), workers: [{ currentJobId: 'id-121' }], counts: { total: 123 } }), list: () => rows, activeRunIds: () => ['run-100'], cpaArtifactsJson: () => JSON.stringify({ artifacts: rows }) },
    robotService: { start() {}, async shutdown() {}, snapshot: () => ({ robots: [robot] }) },
    chainService: { snapshot: () => ({ records: rows }) },
    rebindService: { getQueue: () => ({ accounts: rows }), state: { results: rows }, status: () => ({ results: rows.slice(-20) }) },
    linkops: { jobs: async () => ({ jobs: rows.map((row, i) => ({ ...row, provider: i % 2 ? 'paypal' : 'upi', status: i % 2 ? 'completed' : 'running' })) }) },
    proxyService: { list: () => ({ proxies: rows, local: { proxies: rows }, dynamic: { countryPools: [{ countryCode: 'JP', entries: rows.map(row => ({ ...row, sourceId: 'manual' })) }] } }) },
    logStore: { sweep() {}, read: () => rows.map((row, seq) => ({ seq: seq + 1, message: row.id })) },
  });
  t.after(() => app.close());
  for (const [path, key] of [['runs?compact=1&paged=1', 'runs'], ['artifacts/cpa?paged=1', 'artifacts'], ['chains?paged=1', 'records'], ['rebind/queue?paged=1', 'accounts'], ['robots/runs?', 'items'], ['proxies?paged=1', 'proxies'], ['proxies/pools/JP/entries?', 'items']]) {
    const first = await app.inject(`/api/v1/${path}&limit=50&offset=0`);
    const second = await app.inject(`/api/v1/${path}&limit=50&offset=50`);
    assert.equal(first.statusCode, 200, first.body);
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(first.json().total, 123, path);
    assert.equal(first.json()[key].length, 50, path);
    assert.equal(second.json()[key].length, 50, path);
    assert.notDeepEqual(first.json()[key], second.json()[key], path);
    const last = (await app.inject(`/api/v1/${path}&limit=50&offset=9999`)).json();
    assert.equal(last.offset, 100, path);
    assert.equal(last[key].length, 23, path);
    for (const query of ['limit=201', 'limit=-1', 'offset=NaN', 'offset=1.5']) assert.equal((await app.inject(`/api/v1/${path}&${query}`)).statusCode, 400, path);
  }
  const detail = (await app.inject('/api/v1/runs/run-1?paged=1&offset=50&limit=50')).json();
  assert.equal(detail.jobsPage.items.length, 50);
  assert.equal(detail.jobsPage.total, 123);
  assert.deepEqual(detail.jobs.map(job => job.id), ['id-121', 'id-122']);
  assert.equal(detail.counts.total, 123);
  const results = (await app.inject('/api/v1/rebind/status?paged=1&offset=50&limit=50')).json();
  assert.equal(results.resultsPage.total, 123); assert.equal(results.results.length, 50);
  const external = (await app.inject('/api/v1/linkops/jobs?paged=1&filter=done&offset=50&limit=50')).json();
  assert.equal(external.total, 61); assert.equal(external.jobs.length, 11);
  assert.equal(external.counts.live, 62); assert.equal(external.recentLimit, 200);
  const live = (await app.inject('/api/v1/runs?compact=1&view=live')).json();
  assert.equal(live.total, 123);
  assert.deepEqual(live.runs.map(row => row.runId), ['run-0', 'run-1', 'run-2', 'run-3', 'run-100']);
  const compact = (await app.inject('/api/v1/proxies?compact=1')).json();
  assert.equal(compact.dynamic.countryPools[0].entries.length, 0);
  assert.deepEqual(compact.dynamic.countryPools[0].entryIds, rows.map(row => row.id));
  assert.equal((await app.inject('/api/v1/proxies')).json().dynamic.countryPools[0].entries.length, 123);
  assert.equal((await app.inject('/api/v1/robots?compact=1')).json().robots[0].runs.length, 0);
  assert.equal(robot.runs.length, 123);
  const logs = (await app.inject('/api/v1/runs/run-1/logs?paged=1&limit=50')).json();
  const older = (await app.inject(`/api/v1/runs/run-1/logs?paged=1&limit=50&before=${logs.cursor}`)).json();
  assert.equal(logs.logs.length, 50);
  assert.equal(older.logs.length, 50);
  assert.ok(older.logs.at(-1).seq < logs.logs[0].seq);
});

test('CPA filtering and counts precede pagination; deletion returns the last valid page', () => {
  const rows = Array.from({ length: 151 }, (_, i) => ({ key: String(i), modifiedAt: String(1000 - i), lifecycle: i % 2 ? 'sold' : 'active', isPlus: i % 3 === 0 }));
  const first = artifactPage(rows, { lifecycle: 'sold', limit: 20 });
  const second = artifactPage(rows, { lifecycle: 'sold', limit: 20, offset: 20 });
  assert.equal(first.total, 75);
  assert.equal(first.lifecycleCounts.fresh, 76);
  assert.equal(first.typeCounts.plus, 51);
  assert.ok(second.artifacts.every(row => row.lifecycle === 'sold' && !first.artifacts.some(prior => prior.key === row.key)));
  assert.equal(pageRows([], { offset: 100 }).offset, 0);
  assert.throws(() => artifactPage(rows, { type: 'unknown' }), /Invalid/);
});
