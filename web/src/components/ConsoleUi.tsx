import { useEffect, useRef, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { Dialog, Tooltip } from 'radix-ui';

import { Link } from '../router';

// Built once. `toLocaleString` constructs a formatter on every call, and this
// runs per row per render on tables with hundreds of rows and two stamps each.
const TIMESTAMP_FORMAT = new Intl.DateTimeFormat('zh-CN', {
  hour12: false,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export function formatTime(value?: string) {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : TIMESTAMP_FORMAT.format(parsed);
}

/**
 * Formats a Unix timestamp in SECONDS.
 *
 * The external engine stamps its jobs with `time.time()` — seconds, as a float
 * — while `Date` reads a bare number as milliseconds, so passing one straight
 * to `formatTime` dates every job to January 1970.
 */
export function formatEpochSeconds(value?: number | null) {
  if (value === null || value === undefined || !Number.isFinite(Number(value)) || Number(value) <= 0) return '—';
  return TIMESTAMP_FORMAT.format(new Date(Number(value) * 1000));
}

export function downloadText(content: string, fileName: string, contentType = 'text/plain; charset=utf-8') {
  const blob = new Blob([content], { type: contentType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function copyText(value: string) {
  await navigator.clipboard.writeText(value);
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || '操作失败');
}

export function statusTone(status = '') {
  if (/complete|healthy|online|configured|success|scheduled/i.test(status)) return 'success';
  if (/failed|offline|error|cancelled|corrupt|invalid|mismatch|banned/i.test(status)) return 'danger';
  if (/waiting|paused|degraded|partial|missing|uncertain/i.test(status)) return 'warning';
  if (/running|stopping|active|checking|preflight/i.test(status)) return 'info';
  return 'neutral';
}

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <span className={`status-badge status-${statusTone(status)}`}><span className="status-dot" />{label || status || 'unknown'}</span>;
}

export function IconButton({ label, children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild><button className={`icon-button ${className}`.trim()} aria-label={label} {...props}>{children}</button></Tooltip.Trigger>
      <Tooltip.Portal><Tooltip.Content className="tooltip" sideOffset={7}>{label}<Tooltip.Arrow className="tooltip-arrow" /></Tooltip.Content></Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function IconLink({ to, label, children }: { to: string; label: string; children: ReactNode }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild><Link className="icon-button icon-link" to={to} aria-label={label}>{children}</Link></Tooltip.Trigger>
      <Tooltip.Portal><Tooltip.Content className="tooltip" sideOffset={7}>{label}<Tooltip.Arrow className="tooltip-arrow" /></Tooltip.Content></Tooltip.Portal>
    </Tooltip.Root>
  );
}

export function Button({ icon, children, tone = 'default', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { icon?: ReactNode; tone?: 'default' | 'primary' | 'danger' | 'quiet' }) {
  return <button className={`button button-${tone}`} {...props}>{icon}{children}</button>;
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return <header className="page-header"><div><h1>{title}</h1>{description && <p>{description}</p>}</div>{actions && <div className="page-actions">{actions}</div>}</header>;
}

export function EmptyState({ icon, title, detail, action }: { icon: ReactNode; title: string; detail: string; action?: ReactNode }) {
  return <div className="empty-state"><div className="empty-icon">{icon}</div><h2>{title}</h2><p>{detail}</p>{action}</div>;
}

export function Notice({ tone = 'info', children, onClose, autoDismissToken, floating = false }: { tone?: string; children: ReactNode; onClose?: () => void; autoDismissToken?: unknown; floating?: boolean }) {
  const [closing, setClosing] = useState(false);
  const closeRef = useRef(onClose);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);
  useEffect(() => {
    setClosing(false);
    if (tone !== 'success' || !closeRef.current) return undefined;
    const fadeTimer = window.setTimeout(() => setClosing(true), 2780);
    const closeTimer = window.setTimeout(() => closeRef.current?.(), 3000);
    return () => { window.clearTimeout(fadeTimer); window.clearTimeout(closeTimer); };
    // `children` is deliberately not a dependency. It is a ReactNode, so the
    // parent hands over a new one on every render — and on a page that polls
    // twice a second the cleanup cleared and re-armed both timers before the
    // 2.78 s fade could ever land, so a success notice never dismissed itself.
    // `autoDismissToken` is the caller's explicit "this is a new notice" signal.
  }, [tone, autoDismissToken]);
  return <div className={`notice notice-${tone}${floating ? ' notice-floating' : ''}${closing ? ' notice-closing' : ''}`}><span>{children}</span>{onClose && <button aria-label="关闭" onClick={onClose}><X size={16} /></button>}</div>;
}

export function ConfirmDialog({ trigger, title, description, confirmLabel = '确认', danger = false, children, onConfirm }: {
  trigger: ReactNode;
  title: string;
  description: string;
  confirmLabel?: string;
  danger?: boolean;
  children?: ReactNode;
  onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="dialog-overlay" />
        <Dialog.Content className="dialog-content">
          <Dialog.Title>{title}</Dialog.Title>
          <Dialog.Description>{description}</Dialog.Description>
          {children}
          <div className="dialog-actions">
            <Dialog.Close asChild><Button tone="quiet">返回</Button></Dialog.Close>
            <Button tone={danger ? 'danger' : 'primary'} onClick={() => { onConfirm(); setOpen(false); }}>{confirmLabel}</Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function ConfigNumberInput({ value, onValueChange, ...props }: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'onWheel'> & {
  value: unknown;
  onValueChange: (value: number) => void;
}) {
  const external = value === null || value === undefined ? '' : String(value);
  const [text, setText] = useState(external);
  const focused = useRef(false);
  const skipCommit = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const wheelState = useRef({ text, external, onValueChange, min: props.min, max: props.max, step: props.step, disabled: props.disabled, readOnly: props.readOnly });
  wheelState.current = { text, external, onValueChange, min: props.min, max: props.max, step: props.step, disabled: props.disabled, readOnly: props.readOnly };
  useEffect(() => {
    if (!focused.current) setText(external);
  }, [external]);
  const restore = () => setText(external);
  const roundedStep = (number: number, step: number) => {
    const precision = Math.min(12, Math.max(0, String(step).split('.')[1]?.length || 0));
    return Number(number.toFixed(precision));
  };
  const commit = () => {
    focused.current = false;
    if (text.trim() === '') {
      restore();
      return;
    }
    const number = Number(text);
    if (!Number.isFinite(number)) {
      restore();
      return;
    }
    const minimum = props.min === undefined ? -Infinity : Number(props.min);
    const maximum = props.max === undefined ? Infinity : Number(props.max);
    const bounded = Math.min(Number.isFinite(maximum) ? maximum : Infinity, Math.max(Number.isFinite(minimum) ? minimum : -Infinity, number));
    setText(String(bounded));
    onValueChange(bounded);
  };
  useEffect(() => {
    const element = input.current;
    if (!element) return undefined;
    const handleWheel = (event: WheelEvent) => {
      const currentState = wheelState.current;
      if (currentState.disabled || currentState.readOnly || event.deltaY === 0) return;
      event.preventDefault();
      event.stopPropagation();
      const parsedStep = Number(currentState.step);
      const step = currentState.step === 'any' || !Number.isFinite(parsedStep) || parsedStep <= 0 ? 1 : parsedStep;
      const minimum = currentState.min === undefined ? -Infinity : Number(currentState.min);
      const maximum = currentState.max === undefined ? Infinity : Number(currentState.max);
      const current = Number(currentState.text);
      const fallback = Number(currentState.external);
      const base = Number.isFinite(current) ? current : (Number.isFinite(fallback) ? fallback : 0);
      const stepped = roundedStep(base + (event.deltaY < 0 ? step : -step), step);
      const next = Math.min(Number.isFinite(maximum) ? maximum : Infinity, Math.max(Number.isFinite(minimum) ? minimum : -Infinity, stepped));
      wheelState.current.text = String(next);
      setText(String(next));
      currentState.onValueChange(next);
    };
    element.addEventListener('wheel', handleWheel, { passive: false });
    return () => element.removeEventListener('wheel', handleWheel);
  }, []);
  return <input ref={input} {...props} type="number" value={text} onFocus={() => { focused.current = true; skipCommit.current = false; }} onChange={(event) => setText(event.target.value)} onBlur={() => {
    if (skipCommit.current) {
      skipCommit.current = false;
      focused.current = false;
      return;
    }
    commit();
  }} onKeyDown={(event) => {
    if (event.key === 'Enter') event.currentTarget.blur();
    if (event.key === 'Escape') {
      skipCommit.current = true;
      restore();
      event.currentTarget.blur();
    }
  }} />;
}
