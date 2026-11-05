import { useSyncExternalStore } from 'react';

/**
 * Keys for the two browser-owned jobs that report their own progress.
 *
 * One string names three things at once: the activity group the top bar reads,
 * the page whose result line restates it, and the slot that result is kept in
 * once the page it belongs to has been navigated away from.
 */
export const CPA_PUSH_GROUP = 'cpa-push';
export const SESSION_CHECK_GROUP = 'session-check';

export type LocalActivity = {
  id?: string;
  label: string;
  done: number;
  total: number;
  status?: 'running' | 'complete' | 'error';
  message?: string;
  tone?: 'success' | 'warning' | 'danger' | 'info';
  group?: string;
  /** When the work ended, for surfaces that outlive the top bar's own item. */
  finishedAt?: number;
};

/** How long a finished item stays in the top bar before it clears itself. */
const COMPLETION_RETENTION_MS = 6000;
/**
 * A failure is held longer than a success, and then still clears.
 *
 * It used to be held forever: `finish` scheduled a clear and `fail` did not,
 * so a failed check left a dead progress box in the top bar until someone
 * happened to close the notice it had also raised.
 */
const FAILURE_RETENTION_MS = 20_000;
let sequence = 0;
let clearTimer: ReturnType<typeof setTimeout> | undefined;

function emit() {
  localActivity.listeners.forEach((listener) => listener());
}

/**
 * Publish a terminal state and schedule its own clear.
 *
 * Both outcomes go through here so neither can forget the timer: the top bar
 * is a live strip, and an item that never leaves it stops being live.
 */
function settle(next: LocalActivity, retentionMs: number) {
  clearScheduled();
  localActivity.value = { ...next, finishedAt: Date.now() };
  emit();
  clearTimer = setTimeout(() => {
    if (localActivity.value?.id === next.id) localActivity.set(null);
  }, retentionMs);
}

function clearScheduled() {
  if (clearTimer) {
    clearTimeout(clearTimer);
    clearTimer = undefined;
  }
}

export const localActivity = {
  value: null as LocalActivity | null,
  listeners: new Set<() => void>(),
  set(next: LocalActivity | null) {
    clearScheduled();
    localActivity.value = next;
    emit();
  },
  begin(input: Pick<LocalActivity, 'label' | 'done' | 'total'> & { group?: string }) {
    const id = `local-${Date.now()}-${++sequence}`;
    localActivity.set({ ...input, id, status: 'running' });
    return id;
  },
  update(id: string, done: number) {
    const current = localActivity.value;
    if (!current || current.id !== id || current.status === 'complete' || current.status === 'error') return;
    localActivity.set({ ...current, done: Math.min(current.total, Math.max(0, done)), status: 'running' });
  },
  finish(id: string, result: { message: string; tone?: LocalActivity['tone'] }) {
    const current = localActivity.value;
    if (!current || current.id !== id) return;
    settle({
      ...current,
      done: current.total,
      status: 'complete',
      message: result.message,
      tone: result.tone || 'success',
    }, COMPLETION_RETENTION_MS);
  },
  fail(id: string, message: string) {
    const current = localActivity.value;
    if (!current || current.id !== id) return;
    settle({
      ...current,
      status: 'error',
      message: `${current.label}失败：${message}`,
      tone: 'danger',
    }, FAILURE_RETENTION_MS);
  },
  dismiss(id?: string) {
    if (!id || localActivity.value?.id === id) localActivity.set(null);
  },
  subscribe(listener: () => void) {
    localActivity.listeners.add(listener);
    return () => { localActivity.listeners.delete(listener); };
  },
};

/**
 * The last result of a browser-owned job, kept past the page that started it.
 *
 * A page that states its own outcome is taken off the floating notice, so its
 * strip is the only place that outcome appears. Holding it in component state
 * meant walking to another page and back threw it away: the push finished, the
 * strip was gone, and the notice that would have said so had been suppressed
 * for that very page. This store is module-level for the same reason
 * `localActivity` is — it outlives the component that wrote it.
 */
const results = new Map<string, { value: unknown; at: number }>();
const resultListeners = new Set<() => void>();

export const pageResults = {
  get(key: string) {
    return results.get(key) || null;
  },
  set(key: string, value: unknown) {
    results.set(key, { value, at: Date.now() });
    resultListeners.forEach((listener) => listener());
  },
  clear(key: string) {
    if (!results.delete(key)) return;
    resultListeners.forEach((listener) => listener());
  },
  subscribe(listener: () => void) {
    resultListeners.add(listener);
    return () => { resultListeners.delete(listener); };
  },
};

/**
 * Work this console is doing itself, for the top bar and for the page that
 * started it.
 *
 * The activity strip is otherwise fed entirely by the server's robot poll.
 * Browser-owned work such as a CPA push or a session-asset check has no robot
 * to poll, so it publishes through this external store instead of threading a
 * provider between the writer page and the top bar.
 */
export function useLocalActivity() {
  return useSyncExternalStore(localActivity.subscribe, () => localActivity.value, () => null);
}

/** A page's own last result, read back after the page has been left and reopened. */
export function usePageResult<T>(key: string) {
  const entry = useSyncExternalStore(pageResults.subscribe, () => pageResults.get(key), () => null);
  return (entry ? entry.value : null) as T | null;
}
