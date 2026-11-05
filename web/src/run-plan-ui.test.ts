import { describe, expect, it } from 'vitest';

import { defaultProxyAssignments, proxyAssignmentsAreReady, resizeProxyAssignments } from './run-plan-ui';
import type { ProxyCatalogSnapshot } from './types';

function catalog(options: { locals?: number; pools?: Array<[string, number]> } = {}): ProxyCatalogSnapshot {
  const proxies = Array.from({ length: options.locals ?? 0 }, (_unused, index) => ({
    id: `proxy-local-${index + 1}`,
    endpoint: `http://127.0.0.1:${4001 + index}`,
    protocol: 'http',
    host: '127.0.0.1',
    port: String(4001 + index),
    hasCredentials: false,
    check: null,
  }));
  const countryPools = (options.pools || []).map(([countryCode, total]) => ({
    countryCode,
    total,
    protocols: { socks5: total },
    entries: [],
    manualCount: 0,
    sources: [],
  }));
  return {
    total: proxies.length + countryPools.reduce((sum, pool) => sum + pool.total, 0),
    local: { total: proxies.length, errors: [], proxies },
    dynamic: { total: countryPools.reduce((sum, pool) => sum + pool.total, 0), countryPools },
    errors: [],
    proxies: [],
  } as ProxyCatalogSnapshot;
}

describe('defaultProxyAssignments', () => {
  it('defaults every worker to a country pool even when local proxies exist', () => {
    // A local proxy is its own only candidate, so a dead one strands the worker;
    // a pooled worker can rotate through the whole country pool instead.
    expect(defaultProxyAssignments(2, catalog({ locals: 2, pools: [['JP', 100]] }))).toEqual([
      { workerSlot: 1, kind: 'countryPool', countryCode: 'JP' },
      { workerSlot: 2, kind: 'countryPool', countryCode: 'JP' },
    ]);
  });

  it('prefers a pool that can already cover every worker', () => {
    const assignments = defaultProxyAssignments(3, catalog({ pools: [['JP', 2], ['MX', 40]] }));
    expect(assignments.map((assignment) => assignment.kind === 'countryPool' && assignment.countryCode)).toEqual(['MX', 'MX', 'MX']);
  });

  it('falls back to the largest pool when none covers the worker count', () => {
    const assignments = defaultProxyAssignments(9, catalog({ pools: [['JP', 3], ['MX', 5]] }));
    expect(assignments.every((assignment) => assignment.kind === 'countryPool' && assignment.countryCode === 'MX')).toBe(true);
  });

  it('still uses local proxies when no pool has any endpoint', () => {
    expect(defaultProxyAssignments(2, catalog({ locals: 2, pools: [['JP', 0]] }))).toEqual([
      { workerSlot: 1, kind: 'local', localProxyId: 'proxy-local-1' },
      { workerSlot: 2, kind: 'local', localProxyId: 'proxy-local-2' },
    ]);
  });

  it('keeps existing choices and only fills new worker slots', () => {
    const current = [{ workerSlot: 1, kind: 'local' as const, localProxyId: 'proxy-local-1' }];
    expect(resizeProxyAssignments(current, 2, catalog({ locals: 2, pools: [['JP', 100]] }))).toEqual([
      { workerSlot: 1, kind: 'local', localProxyId: 'proxy-local-1' },
      { workerSlot: 2, kind: 'countryPool', countryCode: 'JP' },
    ]);
  });
});

describe('resizeProxyAssignments', () => {
  it('uses compact cached identities without treating an unloaded page as an empty pool', () => {
    const compact = catalog({ locals: 1, pools: [['PH', 500], ['JP', 500]] });
    compact.dynamic.countryPools[0].entryIds = ['ph-1', 'ph-2', 'proxy-local-1'];
    compact.dynamic.countryPools[1].entryIds = ['jp-1'];
    const lanes = (count: number) => Array.from({length:count}, (_,i) => ({workerSlot:i+1,kind:'countryPool' as const,countryCode:'PH'}));
    expect(proxyAssignmentsAreReady(lanes(3),compact)).toBe(true);
    expect(proxyAssignmentsAreReady(lanes(4),compact)).toBe(false);
    expect(proxyAssignmentsAreReady([...lanes(2),{workerSlot:3,kind:'local',localProxyId:'proxy-local-1'}],compact)).toBe(true);
    expect(proxyAssignmentsAreReady([...lanes(3),{workerSlot:4,kind:'local',localProxyId:'proxy-local-1'}],compact)).toBe(false);
    const mixed = [...lanes(1),{workerSlot:2,kind:'countryPool' as const,countryCode:'JP'}];
    expect(proxyAssignmentsAreReady(mixed,compact)).toBe(true);
    compact.dynamic.countryPools[1].entryIds=['ph-1'];
    expect(proxyAssignmentsAreReady(mixed,compact)).toBe(false);
    compact.dynamic.countryPools[0].entryIds=[];
    expect(proxyAssignmentsAreReady(lanes(1),compact)).toBe(false);
  });

  const resizeCatalog = {
    local: { proxies: [] },
    dynamic: { countryPools: [
      { countryCode: 'BR', total: 5, entries: [] },
      { countryCode: 'JP', total: 5, entries: [] },
    ] },
  } as any;

  it('gives a new Worker the pool the operator already chose', () => {
    // The alphabetical default used to win here, so nudging the Worker count
    // dragged lanes back to a country nobody picked.
    const chosen = [
      { workerSlot: 1, kind: 'countryPool', countryCode: 'JP' },
      { workerSlot: 2, kind: 'countryPool', countryCode: 'JP' },
    ] as any;
    expect(resizeProxyAssignments(chosen, 3, resizeCatalog)).toEqual([
      { workerSlot: 1, kind: 'countryPool', countryCode: 'JP' },
      { workerSlot: 2, kind: 'countryPool', countryCode: 'JP' },
      { workerSlot: 3, kind: 'countryPool', countryCode: 'JP' },
    ]);
  });

  it('keeps a maintenance lane set on the forwarder', () => {
    const lanes = [{ workerSlot: 1, kind: 'maintenance' }] as any;
    expect(resizeProxyAssignments(lanes, 2, resizeCatalog)).toEqual([
      { workerSlot: 1, kind: 'maintenance' },
      { workerSlot: 2, kind: 'maintenance' },
    ]);
  });

  it('falls back to the default pool when nothing was chosen yet', () => {
    expect(resizeProxyAssignments([], 1, resizeCatalog)).toEqual([
      { workerSlot: 1, kind: 'countryPool', countryCode: 'BR' },
    ]);
  });

  it('grades a country pool ready only when it can cover every Worker', () => {
    // Readiness counts the pool's actual endpoints, not its advertised `total`:
    // a pool that reports 2 but has not cached an endpoint yet cannot bind a
    // Worker. The helper above leaves `entries` empty, so build them here.
    const withEntries = (countryCode: string, count: number) => {
      const base = catalog({ pools: [[countryCode, count]] });
      return {
        ...base,
        dynamic: {
          ...base.dynamic,
          countryPools: base.dynamic.countryPools.map((pool) => ({
            ...pool,
            entries: Array.from({ length: count }, (_unused, index) => ({
              id: `${countryCode}-${index + 1}`,
              url: `http://${countryCode}-${index + 1}.example:8080`,
              protocol: 'http',
              countryCode,
              sourceId: 'manual',
            })),
          })),
        },
      } as ProxyCatalogSnapshot;
    };
    const lanes = (count: number) => Array.from({ length: count }, (_unused, index) => ({
      workerSlot: index + 1,
      kind: 'countryPool' as const,
      countryCode: 'JP',
    }));
    expect(proxyAssignmentsAreReady(lanes(2), withEntries('JP', 2))).toBe(true);
    expect(proxyAssignmentsAreReady(lanes(3), withEntries('JP', 2))).toBe(false);
    // An advertised total with nothing cached is not ready.
    expect(proxyAssignmentsAreReady(lanes(1), catalog({ pools: [['JP', 5]] }))).toBe(false);
    // Maintenance is one local forwarder shared by every Worker, so it has no
    // catalog to check and is always ready.
    expect(proxyAssignmentsAreReady([{ workerSlot: 1, kind: 'maintenance' }], catalog())).toBe(true);
  });

});
