import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent, RefObject } from 'react';

const RANGE_LONG_PRESS_MS = 220;
const RANGE_CLICK_SUPPRESS_MS = 120;
const RANGE_CANCEL_DISTANCE_PX = 8;
const RANGE_AUTOSCROLL_STEP_PX = 14;

type RangeDrag = {
  anchorIndex: number;
  currentIndex: number;
  appliedIndex: number;
  pointerId: number;
  pointerType: string;
  startX: number;
  startY: number;
  active: boolean;
  mode: 'add' | 'remove';
  baseSelected: Set<string>;
};

export type RangeSelection = {
  /** The rows currently covered by an in-flight long-press drag, or null. */
  range: { start: number; end: number } | null;
  /** True while a long press has armed the drag; use it to freeze hover styling. */
  dragging: boolean;
  isInRange: (index: number) => boolean;
  /** Spread onto the scroll container that owns the rows. */
  containerProps: {
    ref: RefObject<HTMLDivElement | null>;
    onClickCapture: (event: ReactMouseEvent) => void;
    onContextMenu: (event: ReactMouseEvent) => void;
  };
  /** Spread onto each row; `index` must match the position in `keys`. */
  rowProps: (index: number) => {
    'data-range-index': number;
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  };
  /** Abort an in-flight drag, e.g. when the caller replaces the row set. */
  reset: () => void;
};

/**
 * Press-and-hold range selection shared by the CPA artifact list and the
 * login-state asset list. A short press still behaves like a normal click, so
 * row navigation and checkboxes keep working; holding past `longPressMs` turns
 * the pointer into a range brush that adds or removes rows depending on whether
 * the anchor row was already selected.
 */
export function useRangeSelection({
  keys,
  selected,
  setSelected,
  longPressMs = RANGE_LONG_PRESS_MS,
}: {
  keys: string[];
  selected: Set<string>;
  setSelected: (next: Set<string>) => void;
  longPressMs?: number;
}): RangeSelection {
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const keysRef = useRef<string[]>(keys);
  const selectedRef = useRef<Set<string>>(selected);
  const setSelectedRef = useRef(setSelected);
  const dragRef = useRef<RangeDrag | null>(null);
  const longPressTimerRef = useRef<number | null>(null);
  const longPressMsRef = useRef(longPressMs);
  const suppressClickRef = useRef(false);
  const suppressClickTimerRef = useRef<number | null>(null);
  const frameRef = useRef<number | null>(null);
  const pendingIndexRef = useRef<number | null>(null);
  const keySnapshotRef = useRef('');
  keysRef.current = keys;
  selectedRef.current = selected;
  setSelectedRef.current = setSelected;
  longPressMsRef.current = longPressMs;

  const clearLongPress = () => {
    if (longPressTimerRef.current !== null) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };
  const clearClickSuppression = () => {
    if (suppressClickTimerRef.current !== null) {
      window.clearTimeout(suppressClickTimerRef.current);
      suppressClickTimerRef.current = null;
    }
    suppressClickRef.current = false;
  };
  const applyRange = (drag: RangeDrag, currentIndex: number) => {
    const rowKeys = keysRef.current;
    if (!rowKeys.length || drag.anchorIndex < 0 || currentIndex < 0 || drag.anchorIndex >= rowKeys.length || currentIndex >= rowKeys.length) return;
    const start = Math.min(drag.anchorIndex, currentIndex);
    const end = Math.max(drag.anchorIndex, currentIndex);
    const next = new Set(drag.baseSelected);
    for (let index = start; index <= end; index += 1) {
      const key = rowKeys[index];
      if (drag.mode === 'add') next.add(key); else next.delete(key);
    }
    drag.currentIndex = currentIndex;
    drag.appliedIndex = currentIndex;
    setSelectedRef.current(next);
    setRange({ start, end });
  };
  const flushRange = () => {
    frameRef.current = null;
    const drag = dragRef.current;
    const index = pendingIndexRef.current;
    pendingIndexRef.current = null;
    if (!drag?.active || index === null || index === drag.appliedIndex) return;
    applyRange(drag, index);
  };
  const queueRange = (drag: RangeDrag, index: number) => {
    drag.currentIndex = index;
    pendingIndexRef.current = index;
    if (frameRef.current === null) frameRef.current = window.requestAnimationFrame(flushRange);
  };
  const indexAtPoint = (event: PointerEvent) => {
    const scroll = scrollRef.current;
    if (!scroll) return -1;
    const point = typeof document.elementFromPoint === 'function'
      ? document.elementFromPoint(event.clientX, event.clientY)
      : event.target;
    const row = point instanceof Element ? point.closest<HTMLElement>('[data-range-index]') : null;
    if (!row || !scroll.contains(row)) return -1;
    const index = Number(row.dataset.rangeIndex);
    return Number.isInteger(index) ? index : -1;
  };
  const endRange = (pointerId?: number) => {
    const drag = dragRef.current;
    if (!drag || (pointerId !== undefined && drag.pointerId !== pointerId)) return;
    clearLongPress();
    if (drag.active) {
      suppressClickRef.current = true;
      if (suppressClickTimerRef.current !== null) window.clearTimeout(suppressClickTimerRef.current);
      suppressClickTimerRef.current = window.setTimeout(() => {
        suppressClickRef.current = false;
        suppressClickTimerRef.current = null;
      }, RANGE_CLICK_SUPPRESS_MS);
    }
    dragRef.current = null;
    setRange(null);
  };
  const beginRange = (event: ReactPointerEvent<HTMLElement>, index: number) => {
    if ((event.pointerType === 'mouse' && event.button !== 0) || (event.pointerType === 'pen' && event.button !== 0)) return;
    const target = event.target as HTMLElement;
    if (target.closest('input,button,a,select,textarea,[role="button"][data-range-ignore]')) return;
    clearLongPress();
    clearClickSuppression();
    const anchorKey = keysRef.current[index] || '';
    const drag: RangeDrag = {
      anchorIndex: index,
      currentIndex: index,
      appliedIndex: -1,
      pointerId: event.pointerId,
      pointerType: event.pointerType || 'mouse',
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      mode: selectedRef.current.has(anchorKey) ? 'remove' : 'add',
      baseSelected: new Set(selectedRef.current),
    };
    dragRef.current = drag;
    event.currentTarget.setPointerCapture?.(event.pointerId);
    longPressTimerRef.current = window.setTimeout(() => {
      const current = dragRef.current;
      if (!current || current.pointerId !== drag.pointerId) return;
      current.active = true;
      applyRange(current, current.currentIndex);
    }, longPressMsRef.current);
  };

  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (!drag.active) {
        const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
        const index = indexAtPoint(event);
        if (index >= 0) drag.currentIndex = index;
        // Touch and stylus users scroll with the same gesture, so a moving
        // pointer before the hold completes must stay a scroll.
        if (drag.pointerType !== 'mouse' && drag.pointerType !== 'pen' && moved > RANGE_CANCEL_DISTANCE_PX) endRange(event.pointerId);
        return;
      }
      event.preventDefault();
      const scroll = scrollRef.current;
      if (scroll) {
        const rect = scroll.getBoundingClientRect();
        if (rect.height > 0) {
          const edge = Math.min(42, rect.height / 3);
          if (event.clientY < rect.top + edge) scroll.scrollTop = Math.max(0, scroll.scrollTop - RANGE_AUTOSCROLL_STEP_PX);
          else if (event.clientY > rect.bottom - edge) scroll.scrollTop += RANGE_AUTOSCROLL_STEP_PX;
        }
      }
      const index = indexAtPoint(event);
      if (index >= 0 && index !== drag.currentIndex) queueRange(drag, index);
    };
    const onPointerUp = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (drag && drag.pointerId === event.pointerId && drag.active) {
        const finalIndex = indexAtPoint(event);
        if (finalIndex >= 0) {
          pendingIndexRef.current = null;
          if (frameRef.current !== null) {
            window.cancelAnimationFrame(frameRef.current);
            frameRef.current = null;
          }
          applyRange(drag, finalIndex);
        } else {
          flushRange();
        }
      }
      endRange(event.pointerId);
    };
    const onPointerCancel = (event: PointerEvent) => endRange(event.pointerId);
    window.addEventListener('pointermove', onPointerMove, { passive: false });
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);
    return () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      clearLongPress();
      clearClickSuppression();
      pendingIndexRef.current = null;
      if (frameRef.current !== null) window.cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    };
  }, []);

  useEffect(() => {
    const snapshot = keys.join('\u0000');
    if (keySnapshotRef.current && keySnapshotRef.current !== snapshot) endRange();
    keySnapshotRef.current = snapshot;
  }, [keys]);

  return {
    range,
    dragging: range !== null,
    isInRange: (index: number) => Boolean(range && index >= range.start && index <= range.end),
    containerProps: {
      ref: scrollRef,
      onClickCapture: (event: ReactMouseEvent) => {
        if (!suppressClickRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        clearClickSuppression();
      },
      onContextMenu: (event: ReactMouseEvent) => {
        if (range) event.preventDefault();
      },
    },
    rowProps: (index: number) => ({
      'data-range-index': index,
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => beginRange(event, index),
    }),
    reset: () => endRange(),
  };
}
