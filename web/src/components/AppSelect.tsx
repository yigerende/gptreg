import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { DismissableLayer } from 'radix-ui/internal';
import { Check, ChevronDown } from 'lucide-react';

export type AppSelectOption = { value: string; label: string; disabled?: boolean };
type MenuPosition = { top?: number; bottom?: number; left: number; width: number; maxHeight: number };

// The menu is portaled to <body> so it can escape `overflow: hidden` / `transform` ancestors —
// `.dialog-content` is both, so portalling into the dialog is not an option. But that puts the menu
// outside a Radix modal dialog's layer, and the modal layer does four separate things to everything
// outside it: <body> gets `pointer-events: none`, the dismissable layer treats our pointerdown as an
// outside click, the focus scope drags focus back off the search box, and react-remove-scroll
// swallows wheel/touch scrolling. `DismissableLayer.Branch` below answers the second one; this
// boundary node answers the rest by stopping those events before they reach the document listeners.
const CONTAINED_EVENTS = ['pointerdown', 'mousedown', 'touchstart', 'click', 'focusin', 'keydown', 'wheel', 'touchmove'] as const;

function useMenuHost(open: boolean) {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open) return undefined;
    const boundary = document.createElement('div');
    boundary.setAttribute('data-app-select-portal', '');
    boundary.style.pointerEvents = 'auto';
    // React attaches its listeners to the portal container, so the container must sit *inside* the
    // boundary — otherwise stopping propagation would kill our own option clicks before React sees them.
    const container = document.createElement('div');
    container.style.pointerEvents = 'auto';
    boundary.appendChild(container);
    document.body.appendChild(boundary);
    const contain = (event: Event) => event.stopPropagation();
    CONTAINED_EVENTS.forEach((name) => boundary.addEventListener(name, contain, { passive: false }));
    setHost(container);
    return () => {
      CONTAINED_EVENTS.forEach((name) => boundary.removeEventListener(name, contain));
      boundary.remove();
      setHost(null);
    };
  }, [open]);
  return host;
}

function filterOptions(options: AppSelectOption[], query: string) {
  const normalized = query.trim().toLocaleLowerCase('zh-CN');
  if (!normalized) return options;
  return options.filter((option) => option.label.toLocaleLowerCase('zh-CN').includes(normalized) || option.value.toLocaleLowerCase('zh-CN').includes(normalized));
}

export function AppSelect({
  value,
  options,
  onValueChange,
  ariaLabel,
  searchable = false,
  minMenuWidth = 0,
  menuAlign = 'start',
  className = '',
  disabled = false,
}: {
  value: string;
  options: AppSelectOption[];
  onValueChange: (value: string) => void;
  ariaLabel: string;
  searchable?: boolean;
  minMenuWidth?: number;
  menuAlign?: 'start' | 'end';
  className?: string;
  disabled?: boolean;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<MenuPosition | null>(null);
  const host = useMenuHost(open);
  const visibleOptions = filterOptions(options, query);
  const selected = options.find((option) => option.value === value);
  const isDisabled = disabled || !options.some((option) => !option.disabled);

  const measureMenu = () => {
    const trigger = triggerRef.current;
    if (!trigger) return null;
    const rect = trigger.getBoundingClientRect();
    const viewportGap = 8;
    const triggerGap = 4;
    const preferredHeight = searchable ? 320 : 280;
    const below = window.innerHeight - rect.bottom - triggerGap - viewportGap;
    const above = rect.top - triggerGap - viewportGap;
    const placeAbove = below < Math.min(220, preferredHeight) && above > below;
    const availableHeight = Math.max(120, Math.min(preferredHeight, placeAbove ? above : below));
    const width = Math.min(Math.max(rect.width, minMenuWidth), window.innerWidth - viewportGap * 2);
    const preferredLeft = menuAlign === 'end' ? rect.right - width : rect.left;
    const left = Math.max(viewportGap, Math.min(preferredLeft, window.innerWidth - width - viewportGap));
    return placeAbove
      ? { bottom: window.innerHeight - rect.top + triggerGap, left, width, maxHeight: availableHeight }
      : { top: rect.bottom + triggerGap, left, width, maxHeight: availableHeight };
  };

  const openMenu = () => {
    if (isDisabled) return;
    const selectedIndex = options.findIndex((option) => option.value === value && !option.disabled);
    setQuery('');
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : options.findIndex((option) => !option.disabled));
    setPosition(measureMenu());
    setOpen(true);
  };

  const closeMenu = (restoreFocus = false) => {
    setOpen(false);
    setQuery('');
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus({ preventScroll: true }));
  };

  const commit = (option?: AppSelectOption) => {
    if (!option || option.disabled) return;
    onValueChange(option.value);
    closeMenu(true);
  };

  const moveActive = (direction: 1 | -1) => {
    if (!visibleOptions.length) return;
    let next = activeIndex < 0 ? (direction === 1 ? -1 : 0) : activeIndex;
    for (let attempts = 0; attempts < visibleOptions.length; attempts += 1) {
      next = (next + direction + visibleOptions.length) % visibleOptions.length;
      if (!visibleOptions[next]?.disabled) break;
    }
    setActiveIndex(next);
  };

  const handleKeyDown = (event: KeyboardEvent, fromSearch = false) => {
    if (event.key === 'Tab') { closeMenu(); return; }
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); closeMenu(true); return; }
    if (!open) {
      if (['Enter', 'ArrowDown', 'ArrowUp'].includes(event.key) || (!fromSearch && event.key === ' ')) {
        event.preventDefault();
        openMenu();
      }
      return;
    }
    if (event.key === 'ArrowDown') { event.preventDefault(); moveActive(1); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); moveActive(-1); return; }
    if (event.key === 'Home') { event.preventDefault(); setActiveIndex(visibleOptions.findIndex((option) => !option.disabled)); return; }
    if (event.key === 'End') {
      event.preventDefault();
      for (let index = visibleOptions.length - 1; index >= 0; index -= 1) {
        if (!visibleOptions[index].disabled) { setActiveIndex(index); break; }
      }
      return;
    }
    if (event.key === 'Enter' && activeIndex >= 0) { event.preventDefault(); commit(visibleOptions[activeIndex]); }
  };

  useLayoutEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const item = menuRef.current?.querySelector<HTMLElement>(`[data-option-index="${activeIndex}"]`);
      if (item && typeof item.scrollIntoView === 'function') item.scrollIntoView({ block: 'nearest' });
    });
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      closeMenu();
    };
    const handleViewportChange = (event: Event) => {
      if (event.type === 'scroll' && menuRef.current?.contains(event.target as Node)) return;
      const next = measureMenu();
      if (next) setPosition(next);
    };
    document.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('resize', handleViewportChange);
    document.addEventListener('scroll', handleViewportChange, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('resize', handleViewportChange);
      document.removeEventListener('scroll', handleViewportChange, true);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open || activeIndex < 0) return;
    const item = menuRef.current?.querySelector<HTMLElement>(`[data-option-index="${activeIndex}"]`);
    if (item && typeof item.scrollIntoView === 'function') item.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, open]);

  const menu = open && position ? <DismissableLayer.Branch asChild><div
    ref={menuRef}
    className="app-select-menu"
    data-side={position.top !== undefined ? 'bottom' : 'top'}
    style={{ top: position.top, bottom: position.bottom, left: position.left, width: position.width, maxHeight: position.maxHeight }}
  >
    {searchable && <div className="app-select-search"><input
      aria-label={`${ariaLabel}搜索`}
      value={query}
      onChange={(event) => {
        const nextQuery = event.target.value;
        const nextOptions = filterOptions(options, nextQuery);
        setQuery(nextQuery);
        setActiveIndex(nextOptions.findIndex((option) => !option.disabled));
      }}
      onKeyDown={(event) => handleKeyDown(event, true)}
      placeholder="搜索国家或代码"
      autoComplete="off"
    /></div>}
    <div
      id={listboxId}
      className="app-select-options"
      role="listbox"
      aria-label={`${ariaLabel}选项`}
      style={{ maxHeight: position.maxHeight - (searchable ? 45 : 0) }}
    >
      {visibleOptions.length ? visibleOptions.map((option, index) => <button
        id={`${listboxId}-option-${index}`}
        type="button"
        role="option"
        aria-selected={option.value === value}
        aria-disabled={option.disabled || undefined}
        className="app-select-option"
        data-active={index === activeIndex || undefined}
        data-selected={option.value === value || undefined}
        data-option-index={index}
        disabled={option.disabled}
        tabIndex={-1}
        key={option.value}
        onPointerMove={() => !option.disabled && setActiveIndex(index)}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => commit(option)}
      ><span>{option.label}</span>{option.value === value && <Check size={13} />}</button>) : <div className="app-select-empty">没有匹配项</div>}
    </div>
  </div></DismissableLayer.Branch> : null;

  return <div className={`app-select ${className}`.trim()}>
    <button
      ref={triggerRef}
      type="button"
      className="app-select-trigger"
      role="combobox"
      aria-label={ariaLabel}
      aria-haspopup="listbox"
      aria-controls={open ? listboxId : undefined}
      aria-expanded={open}
      aria-activedescendant={open && activeIndex >= 0 ? `${listboxId}-option-${activeIndex}` : undefined}
      disabled={isDisabled}
      onClick={() => open ? closeMenu() : openMenu()}
      onKeyDown={handleKeyDown}
    ><span className="app-select-value">{selected?.label || value || '请选择'}</span><ChevronDown className="app-select-chevron" size={14} /></button>
    {menu && host && createPortal(menu, host)}
  </div>;
}
