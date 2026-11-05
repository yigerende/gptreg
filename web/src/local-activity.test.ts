import { afterEach, describe, expect, it, vi } from 'vitest';

import { localActivity, pageResults } from './local-activity';

afterEach(() => {
  localActivity.set(null);
  pageResults.clear('demo');
  vi.useRealTimers();
});

describe('local activity lifecycle', () => {
  it('ignores stale progress and completion from a replaced task', () => {
    vi.useFakeTimers();
    const first = localActivity.begin({ label: 'first', done: 0, total: 2 });
    const second = localActivity.begin({ label: 'second', done: 0, total: 3 });

    localActivity.update(first, 2);
    localActivity.finish(first, { message: 'first done' });
    expect(localActivity.value).toMatchObject({ id: second, status: 'running', done: 0, total: 3 });

    localActivity.update(second, 2);
    localActivity.finish(second, { message: 'second done' });
    expect(localActivity.value).toMatchObject({ id: second, status: 'complete', done: 3, message: 'second done' });

    vi.advanceTimersByTime(6000);
    expect(localActivity.value).toBeNull();
  });
});

describe('page results', () => {
  it('keeps the last result under its key and tells subscribers when it changes', () => {
    const seen: Array<unknown> = [];
    const stop = pageResults.subscribe(() => seen.push(pageResults.get('demo')?.value ?? null));

    expect(pageResults.get('demo')).toBeNull();
    pageResults.set('demo', { summary: 'first' });
    pageResults.set('demo', { summary: 'second' });
    // The reference is stable between writes, which is what lets
    // `useSyncExternalStore` read it without re-rendering on every poll.
    expect(pageResults.get('demo')).toBe(pageResults.get('demo'));
    expect(pageResults.get('demo')?.value).toEqual({ summary: 'second' });

    pageResults.clear('demo');
    expect(pageResults.get('demo')).toBeNull();
    // Clearing a key that holds nothing is not a change, so it wakes nobody.
    pageResults.clear('demo');
    expect(seen).toEqual([{ summary: 'first' }, { summary: 'second' }, null]);

    stop();
    pageResults.set('demo', { summary: 'after' });
    expect(seen).toHaveLength(3);
  });
});
