'use strict';

const { createProxyAllocator, parseProxyList, probeProxy } = require('../proxy-pool');
const { executePureHttpUrl } = require('../pure-url');
const { sourceProxySummary } = require('../session-asset-store');
const { HttpError, sanitizeValue } = require('./utils');

const DEFAULT_MAINTENANCE_PROXY = 'http://127.0.0.1:7890';

/** Select and check candidates before any account traffic, then lease one for the whole account. */
function createRebindProxyPool(assignments, catalog, options = {}) {
  const plans = Array.isArray(assignments) && assignments.length ? assignments : [{ workerSlot: 1, kind: 'maintenance' }];
  const local = new Map((catalog?.local?.proxies || catalog?.proxies || []).map((entry) => [String(entry.id), entry]));
  const countries = new Map((catalog?.dynamic?.countryPools || []).map((pool) => [pool.countryCode, pool.entries || []]));
  const entries = new Map();
  const groups = plans.map((plan) => {
    let candidates;
    if (plan.kind === 'maintenance') candidates = [{ url: options.maintenanceProxy || DEFAULT_MAINTENANCE_PROXY }];
    else if (plan.kind === 'local') candidates = [local.get(String(plan.localProxyId))].filter(Boolean);
    else if (plan.kind === 'countryPool') candidates = countries.get(plan.countryCode) || [];
    else throw new HttpError(400, '无效的换绑代理配置');
    if (!candidates.length) throw new HttpError(400, '所选代理不存在或国家代理池为空，请重新选择代理');
    const urls = new Set();
    for (const candidate of candidates) {
      const parsed = parseProxyList(String(candidate.url || candidate.endpoint || ''))[0];
      if (!parsed) throw new HttpError(400, '所选代理地址无效');
      const entry = {
        ...parsed,
        id: candidate.id || parsed.id,
        sourceId: candidate.sourceId || '',
        resourceKind: plan.kind,
        countryCode: plan.kind === 'countryPool' ? String(plan.countryCode).toUpperCase() : '',
      };
      const previous = entries.get(entry.url);
      if (previous && (previous.countryCode !== entry.countryCode || previous.resourceKind !== entry.resourceKind)) {
        throw new HttpError(400, '同一代理不能同时属于不同国家池或代理类型');
      }
      entries.set(entry.url, entry);
      urls.add(entry.url);
    }
    return { ...plan, urls };
  });
  const allocator = createProxyAllocator([...entries.values()].filter((entry) => entry.resourceKind !== 'maintenance'));
  const bound = new Map();
  const health = options.healthCheck || {};
  const groupFor = (slot) => groups.find((group) => Number(group.workerSlot) === Number(slot)) || groups[0];
  return {
    endpoints: () => [...entries.keys()],
    entry: (url) => entries.get(String(url || '')) || null,
    capacity(workerConcurrency) {
      const demand = new Map();
      let available = 0;
      for (let slot = 1; slot <= workerConcurrency; slot++) {
        const group = groupFor(slot);
        if (group.kind === 'maintenance') { available++; continue; }
        const key = group.kind === 'countryPool' ? `country:${group.countryCode}` : [...group.urls][0];
        const count = (demand.get(key) || 0) + 1;
        demand.set(key, count);
        if (count <= group.urls.size) available++;
      }
      return { available, ready: available >= workerConcurrency };
    },
    describe: (slot) => sourceProxySummary(bound.get(String(slot))),
    release(slot) {
      bound.delete(String(slot));
      allocator.release(String(slot));
    },
    async acquire(slot, onCheck = () => {}) {
      const key = String(slot);
      if (bound.has(key)) return bound.get(key).url;
      const group = groupFor(slot);
      if (group.kind === 'maintenance') {
        const entry = entries.get([...group.urls][0]);
        bound.set(key, entry);
        onCheck({ status: 'skipped', reason: 'shared_maintenance_forwarder', proxy: sourceProxySummary(entry) });
        return entry.url;
      }
      let checked = 0;
      let lastError;
      for (;;) {
        if (options.shouldStop?.()) throw Object.assign(new Error('代理筛选已停止，尚未开始账号流程'), { code: 'TASK_INTERRUPTED' });
        // Reservation happens synchronously before the probe so concurrent workers cannot reuse this candidate.
        const entry = allocator.acquireRandom(key, { isUsable: (candidate) => group.urls.has(candidate.url), random: options.random || Math.random });
        if (!entry) {
          const busy = allocator.pool.some((candidate) => group.urls.has(candidate.url) && allocator.health[candidate.id]?.status === 'leased');
          const code = busy ? 'PROXY_POOL_BUSY' : 'HEALTHY_PROXY_REQUIRED';
          throw Object.assign(new Error(busy ? '可用代理正被其他换绑账号占用，请降低并发或补充代理' : `所选代理池没有通过检测的节点${lastError ? `：${lastError.message}` : ''}`), { code });
        }
        checked += 1;
        const detail = { proxy: sourceProxySummary(entry), candidateIndex: checked, candidateCount: group.urls.size };
        onCheck({ ...detail, status: 'checking' });
        try {
          if (health.enabled !== false) {
            await probeProxy(entry, {
              probeUrl: health.probeUrl || 'https://auth.openai.com/', timeoutMs: health.timeoutMs || 15000,
              executor: options.executor || executePureHttpUrl, rejectChallenge: true,
            });
          }
          bound.set(key, entry);
          onCheck({ ...detail, status: health.enabled === false ? 'skipped' : 'healthy', reason: health.enabled === false ? 'health_check_disabled' : '' });
          return entry.url;
        } catch (error) {
          lastError = sanitizeValue({ code: String(error.code || 'PROXY_PROBE_FAILED'), message: String(error.message || '').slice(0, 180) }, { redactPii: false });
          allocator.fail(entry, lastError.message);
          let retired = false;
          if (entry.resourceKind === 'countryPool' && typeof options.retireProxy === 'function') {
            try {
              const outcome = await options.retireProxy({ proxy: entry, reason: lastError.message, code: lastError.code });
              retired = outcome?.retired !== false;
            } catch { /* The in-run allocator still retires the candidate. */ }
          }
          onCheck({ ...detail, status: 'failed', retired, ...lastError });
        }
      }
    },
  };
}

module.exports = { createRebindProxyPool };
