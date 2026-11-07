'use strict';
const { SessionProxyConfig, one, fault } = require('./session-proxy-config');
const { SessionProxyAllocator } = require('./session-proxy-allocator');
const { SessionProxyRuntime } = require('./session-proxy-runtime');
const { createHash } = require('node:crypto');
async function createSessionProxy(db, crypt, kind, options = {}) {
  const config = new SessionProxyConfig(db, crypt), allocator = new SessionProxyAllocator(config, options);
  const controller = new AbortController();
  const runtimes = new Set();
  const lock = await db.pool.connect();
  const key = -BigInt('0x' + createHash('sha256').update(allocator.processId).digest('hex').slice(0, 15));
  const instance = await one(db, 'INSERT INTO session_proxy_instances(id,kind,lock_key) VALUES($1,$2,$3) RETURNING *', [allocator.processId, kind, key.toString()]);
  const lockKey = row => (BigInt(row.lock_key) + 9000000n).toString();
  await lock.query('SELECT pg_advisory_lock($1::bigint)', [lockKey(instance)]);
  lock.on('error', () => controller.abort(fault('SESSION_PROXY_EXPIRED', '执行器连接失效，已停止代理请求')));
  let recovery;
  const recover = () => {
    if (recovery || controller.signal.aborted) return recovery;
    recovery = db.tx(async q => {
      await config.control(q, true); await allocator.recoverReserved(q);
      const stale = (await q.query('SELECT * FROM session_proxy_instances WHERE id<>$1', [allocator.processId])).rows;
      for (const old of stale) {
        const free = await one(q, 'SELECT pg_try_advisory_xact_lock($1::bigint) AS free', [lockKey(old)]);
        if (!free.free) continue;
        await q.query("UPDATE session_proxy_bindings SET status='stopping',lease_until=now()+interval '70 seconds' WHERE process_instance_id=$1 AND status='active'", [old.id]);
        const ended = (await q.query("UPDATE session_proxy_bindings SET status='expired',ended_at=now() WHERE process_instance_id=$1 AND status='stopping' AND lease_until<now() RETURNING id", [old.id])).rows;
        for (const b of ended) await q.query('DELETE FROM session_proxy_exit_claims WHERE binding_id=$1', [b.id]);
        await q.query("DELETE FROM platform_account_execution_claims WHERE process_instance_id=$1 AND lease_until<now()-interval '70 seconds' AND NOT EXISTS(SELECT 1 FROM session_proxy_bindings WHERE process_instance_id=$1 AND status IN ('active','stopping'))", [old.id]);
      }
    }).then(async () => {
      for (const runtime of runtimes) if (runtime.closed) { await runtime.close(); runtimes.delete(runtime); }
    }).finally(() => { recovery = null; });
    return recovery;
  };
  await recover();
  const timer = setInterval(() => recover().catch(error => console.error('[session-proxy] recovery failed', error.code || 'DATABASE_ERROR')), 5000); timer.unref();
  return { config, allocator, signal: controller.signal, recover,
    runtime: (state) => {
      if (state.runPlan?.proxyPolicy?.mode !== 'sessionProxy') return undefined;
      const runtime = new SessionProxyRuntime(allocator, state, controller.signal); runtimes.add(runtime); return runtime;
    },
    async preparePlan(input, catalog, { frozen = false } = {}) {
      if (input.taskKind === 'session_refresh') return input;
      if (input.proxyMode === 'countryPool' && !input.proxyPolicy && !input.proxyAssignments?.some(p => p.kind === 'sessionProxy')) return input;
      if (frozen && !input.proxyPolicy && input.proxyMode !== 'local') return input;
      const settings = await db.settings();
      const mode = input.proxyMode || (input.proxyPolicy || input.proxyAssignments?.some(p => p.kind === 'sessionProxy') ? 'sessionProxy' : settings.default_proxy_mode) || 'legacy';
      if (!['local', 'countryPool', 'sessionProxy', 'legacy'].includes(mode)) throw fault('SESSION_PROXY_CONFIG_INVALID', '代理模式无效', 400);
      if (mode === 'sessionProxy') {
        const policy = frozen && input.proxyPolicy ? input.proxyPolicy : await config.policy(input.registrationRegion || 'random');
        const control = await config.control();
        if (control.revoked) throw fault('SESSION_PROXY_REVOKED', '独立会话凭据已紧急停用', 503);
        const count = input.workerConcurrency || 1;
        return { ...input, proxyMode: mode, proxyPolicy: policy,
          proxyAssignments: Array.from({ length: count }, (_, i) => ({ workerSlot: i + 1, kind: 'sessionProxy' })) };
      }
      const { proxyPolicy, sessionProxyItem, ...legacy } = input;
      if (mode === 'local') {
        const local = catalog.local?.proxies || [];
        const count = input.workerConcurrency || 1;
        if (local.length < count) throw fault('LOCAL_PROXY_NOT_FOUND', '本地代理数量不足');
        return { ...legacy, proxyMode: mode, proxyAssignments: Array.from({ length: count }, (_, i) => ({ workerSlot: i + 1, kind: 'local', localProxyId: local[i].id })) };
      }
      if (legacy.proxyAssignments?.some(p => p.kind === 'sessionProxy')) throw fault('SESSION_PROXY_CONFIG_INVALID', '代理模式和分配不一致');
      return legacy;
    },
    async close() {
      clearInterval(timer); controller.abort();
      try {
        if (recovery) await recovery;
        await Promise.allSettled([...runtimes].map(runtime => runtime.close()));
        await db.query('UPDATE session_proxy_instances SET stopped_at=now() WHERE id=$1', [allocator.processId]);
      } finally {
        try { await lock.query('SELECT pg_advisory_unlock($1::bigint)', [lockKey(instance)]); }
        finally { lock.release(); }
      }
    } };
}
module.exports = { createSessionProxy };
