'use strict';

function defaultOAuthAssignments(count, catalog = {}, { random = Math.random, claims } = {}) {
  const pools = (catalog.dynamic?.countryPools || []).filter((p) => p.total > 0);
  const available = (p) => claims && Array.isArray(p.entries)
    ? p.entries.filter((entry) => !claims.has(entry.id)).length : p.total;
  // Each customer account starts a one-Worker task. Choose a country uniformly,
  // not by catalog order or pool size; busy pools yield to pools with free exits.
  const ready = pools.filter((p) => available(p) >= count);
  const largest = pools.reduce((best, p) => Math.max(best, available(p)), 0);
  const candidates = ready.length ? ready : pools.filter((p) => available(p) === largest);
  const sample = candidates.length > 1 ? Number(random()) : 0;
  const index = Math.floor(Math.max(0, Math.min(Number.isFinite(sample) ? sample : 0, 0.999999999999)) * candidates.length);
  const pool = candidates[index];
  const local = catalog.local?.proxies || catalog.proxies || [];
  return Array.from({ length: count }, (_, i) => pool
    ? { workerSlot: i + 1, kind: 'countryPool', countryCode: pool.countryCode }
    : local[i] ? { workerSlot: i + 1, kind: 'local', localProxyId: local[i].id }
      : { workerSlot: i + 1, kind: 'countryPool', countryCode: 'GLOBAL' });
}

function assertOAuthProxySelection(plan) {
  if (plan.taskKind !== 'oauth') return;
  if (!plan.proxyAssignments?.length || plan.proxyAssignments.some((p) => !['local', 'countryPool'].includes(p.kind))) {
    const error = new Error('请为独立 OAuth 选择国家池或固定代理；旧本机转发任务需要重新选择代理');
    error.code = 'OAUTH_PROXY_SELECTION_REQUIRED';
    throw error;
  }
}

// Set-compatible leases with ownership. A task can release only its own
// claims, while both registration and OAuth see the other task's busy exits.
class ProxyClaims {
  constructor(registry, owner) { this.registry = registry; this.owner = owner; }
  get size() { return this.registry.size; }
  has(id) { return this.registry.has(id); }
  add(id) {
    const owner = this.registry.get(id);
    if (owner && owner !== this.owner) throw Object.assign(new Error('代理正被其他任务占用'), { code: 'PROXY_POOL_BUSY' });
    this.registry.set(id, this.owner); return this;
  }
  delete(id) { return this.registry.get(id) === this.owner && this.registry.delete(id); }
  clear() { for (const [id, owner] of this.registry) if (owner === this.owner) this.registry.delete(id); }
}

module.exports = { defaultOAuthAssignments, assertOAuthProxySelection, ProxyClaims };
