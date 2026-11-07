'use strict';
const { isIP } = require('node:net');

async function recordExitIp(allocator, bindingId, observation) {
  if (!isIP(String(observation?.exitIp || ''))) return false;
  const value = { exitIp: observation.exitIp, checkedAt: observation.exitIpCheckedAt || '', source: 'registration', status: 'healthy' };
  await allocator.db.query(`UPDATE session_proxy_bindings SET detect_result=detect_result||$2::jsonb
    WHERE id=$1 AND COALESCE(detect_result->>'exitIp','')=''`, [bindingId, JSON.stringify(value)]);
  return true;
}

// Read only recorded observations: never re-probe expired historical sessions.
// Scan bounded pages, including attempts that failed before creating an asset.
async function backfillExitIps(allocator, manager, after = 0) {
  const rows = (await allocator.db.query(`SELECT id,run_id FROM session_proxy_bindings
    WHERE id>$1 AND run_id<>'' AND COALESCE(detect_result->>'exitIp','')='' ORDER BY id LIMIT 50`, [after])).rows;
  const states = new Map();
  for (const row of rows) {
    try {
      if (!states.has(row.run_id)) states.set(row.run_id, manager.load(row.run_id));
      const state = states.get(row.run_id);
      if (state.runId !== row.run_id) continue;
      const observation = state.jobs?.map(j => j.registrationProxy).find(p => p?.resourceKind === 'sessionProxy' && String(p.bindingId) === String(row.id));
      await recordExitIp(allocator, row.id, observation);
    } catch { /* A running checkpoint or deleted historical file can be retried. */ }
  }
  return rows.at(-1)?.id || 0;
}
module.exports = { recordExitIp, backfillExitIps };
