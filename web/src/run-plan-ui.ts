import type { ProxyAssignment, ProxyCatalogSnapshot } from './types';

/**
 * Mirrors `MAX_WORKER_CONCURRENCY` in `src/config-v2.js`.
 *
 * Kept as one exported constant because the ceiling used to be written out as
 * a literal in four places — the two number inputs, two clamps, and the
 * `planValid` guard — and raising it left the guard behind, which silently
 * disabled the launch buttons for every value the inputs now accepted.
 */
export const MAX_WORKER_CONCURRENCY = 20;

/**
 * Picks the country pool a fresh run should default to. A pool that already
 * holds one endpoint per worker is preferred so the plan starts out ready;
 * otherwise the largest pool wins, because a worker bound to a pool can rotate
 * through every endpoint in it, while a local proxy is its own only candidate.
 */
function defaultCountryPool(workerConcurrency: number, catalog?: ProxyCatalogSnapshot) {
  const pools = (catalog?.dynamic?.countryPools || []).filter((pool) => pool.total > 0);
  if (!pools.length) return '';
  const sufficient = pools.find((pool) => pool.total >= workerConcurrency);
  if (sufficient) return sufficient.countryCode;
  return pools.reduce((largest, pool) => (pool.total > largest.total ? pool : largest), pools[0]).countryCode;
}

export function defaultProxyAssignments(workerConcurrency: number, catalog?: ProxyCatalogSnapshot): ProxyAssignment[] {
  const assignments: ProxyAssignment[] = [];
  const local = catalog?.local?.proxies || catalog?.proxies || [];
  const pool = defaultCountryPool(workerConcurrency, catalog);
  for (let index = 0; index < workerConcurrency; index += 1) {
    const workerSlot = index + 1;
    if (pool) assignments.push({ workerSlot, kind: 'countryPool', countryCode: pool });
    else if (local[index]) assignments.push({ workerSlot, kind: 'local', localProxyId: local[index].id });
    else assignments.push({ workerSlot, kind: 'countryPool', countryCode: 'GLOBAL' });
  }
  return assignments;
}

/**
 * Upkeep on accounts that already exist — OAuth top-up, security top-up — goes
 * out through the configured local forwarder rather than a country pool. The
 * pools are a paid resource that registration needs, and a stable address is
 * what these calls actually want.
 */
export function maintenanceProxyAssignments(workerConcurrency: number): ProxyAssignment[] {
  return Array.from({ length: Math.max(1, workerConcurrency) }, (_unused, index) => ({
    workerSlot: index + 1,
    kind: 'maintenance' as const,
  }));
}

export function resizeProxyAssignments(current: ProxyAssignment[], workerConcurrency: number, catalog?: ProxyCatalogSnapshot) {
  const retained = current.filter((assignment) => assignment.workerSlot <= workerConcurrency);
  const defaults = defaultProxyAssignments(workerConcurrency, catalog);
  // A new slot copies the pool the operator already chose for the others. The
  // alphabetical default used to win here, so nudging the Worker count sideways
  // silently dragged lanes back to a country nobody picked.
  const chosenPool = retained.find((assignment) => assignment.kind === 'countryPool')?.countryCode || '';
  const allMaintenance = retained.length > 0 && retained.every((assignment) => assignment.kind === 'maintenance');
  for (let slot = 1; slot <= workerConcurrency; slot += 1) {
    if (!retained.some((assignment) => assignment.workerSlot === slot)) {
      if (allMaintenance) {
        retained.push({ workerSlot: slot, kind: 'maintenance' });
        continue;
      }
      if (chosenPool) {
        retained.push({ workerSlot: slot, kind: 'countryPool', countryCode: chosenPool });
        continue;
      }
      const fallback = defaults.find((assignment) => assignment.workerSlot === slot)!;
      const usedLocal = new Set(retained.filter((assignment) => assignment.kind === 'local').map((assignment) => assignment.localProxyId));
      if (fallback.kind === 'local' && usedLocal.has(fallback.localProxyId)) {
        retained.push({ workerSlot: slot, kind: 'countryPool', countryCode: defaultCountryPool(workerConcurrency, catalog) || 'GLOBAL' });
      } else retained.push(fallback);
    }
  }
  return retained.sort((left, right) => left.workerSlot - right.workerSlot);
}

/** Every Worker onto one country pool — the common case, one click. */
export function countryPoolAssignments(workerConcurrency: number, countryCode: string): ProxyAssignment[] {
  return Array.from({ length: Math.max(1, workerConcurrency) }, (_unused, index) => ({
    workerSlot: index + 1,
    kind: 'countryPool' as const,
    countryCode,
  }));
}

/**
 * Spreads the Workers across the pools in proportion to their size.
 *
 * Filling one pool is what makes a run rotate through the same handful of
 * exits; spreading keeps slack everywhere and limits the damage when one
 * country goes bad. The deal is Jefferson/D'Hondt — each slot goes to whichever
 * pool currently has the best capacity-per-worker ratio, `total / (taken + 1)`.
 * Simply picking the largest *remaining* count does not work: a pool of 400
 * stays the largest for the first 200 deals and quietly takes every slot.
 *
 * 20 Workers over pools of 400/200/200/100/100 deal out 8/4/4/2/2.
 */
export function balancedPoolAssignments(workerConcurrency: number, catalog?: ProxyCatalogSnapshot): ProxyAssignment[] {
  const pools = (catalog?.dynamic?.countryPools || [])
    .filter((pool) => pool.total > 0)
    .map((pool) => ({ countryCode: pool.countryCode, total: pool.total, taken: 0 }));
  if (!pools.length) return [];
  const assignments: ProxyAssignment[] = [];
  for (let slot = 1; slot <= Math.max(1, workerConcurrency); slot += 1) {
    const pool = pools.reduce((best, candidate) => (
      candidate.total / (candidate.taken + 1) > best.total / (best.taken + 1) ? candidate : best
    ), pools[0]);
    assignments.push({ workerSlot: slot, kind: 'countryPool', countryCode: pool.countryCode });
    pool.taken += 1;
  }
  return assignments;
}

export function proxyAssignmentsAreReady(assignments: ProxyAssignment[], catalog?: ProxyCatalogSnapshot) {
  if (!assignments.length || !catalog) return false;
  const localIds = new Set((catalog.local?.proxies || catalog.proxies || []).map((proxy) => proxy.id));
  const selectedLocalIds = new Set(assignments.flatMap((assignment) => assignment.kind === 'local' ? [assignment.localProxyId] : []));
  const selectedPoolCountries = new Set(assignments.flatMap((assignment) => assignment.kind === 'countryPool' ? [assignment.countryCode] : []));
  const countryClaims = new Map<string, string>();
  let countryPoolOverlap = false;
  const poolCapacity = new Map((catalog.dynamic?.countryPools || []).map((pool) => {
    const entries = (pool.entries || []).filter((entry) => !selectedLocalIds.has(entry.id));
    if (selectedPoolCountries.has(pool.countryCode)) {
      for (const entry of entries) {
        const previousCountry = countryClaims.get(entry.id);
        if (previousCountry && previousCountry !== pool.countryCode) countryPoolOverlap = true;
        countryClaims.set(entry.id, pool.countryCode);
      }
    }
    return [pool.countryCode, entries.length];
  }));
  const poolDemand = assignments.reduce((counts, assignment) => {
    if (assignment.kind === 'countryPool') counts.set(assignment.countryCode, Number(counts.get(assignment.countryCode) || 0) + 1);
    return counts;
  }, new Map<string, number>());
  const uniqueLocal = assignments.filter((assignment) => assignment.kind === 'local').map((assignment) => assignment.localProxyId);
  return !countryPoolOverlap
    && new Set(uniqueLocal).size === uniqueLocal.length
    && assignments.every((assignment) => {
      // The forwarder is configured server-side, so there is nothing in the
      // catalog to check and a maintenance lane is always ready.
      if (assignment.kind === 'maintenance') return true;
      return assignment.kind === 'local'
        ? localIds.has(assignment.localProxyId)
        : Number(poolCapacity.get(assignment.countryCode) || 0) >= Number(poolDemand.get(assignment.countryCode) || 0);
    });
}
