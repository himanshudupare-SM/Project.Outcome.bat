import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useScrollLock } from '../lib/useScrollLock.js';

/* ------------------------------------------------------------ button */

export function Button({
  variant = 'default',
  size,
  loading,
  children,
  className,
  ...rest
}: {
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
  size?: 'sm';
  loading?: boolean;
} & React.ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  const classes = [
    'btn',
    variant !== 'default' ? `btn-${variant}` : '',
    size === 'sm' ? 'btn-sm' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <button {...rest} className={classes} disabled={rest.disabled || loading}>
      {loading && <span className="spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

/* ------------------------------------------------------------ field */

export function Field({
  label,
  error,
  hint,
  children,
  required,
}: {
  label: string;
  error?: string | undefined;
  hint?: string;
  children: (props: { id: string; 'aria-invalid': boolean; 'aria-describedby': string | undefined }) => ReactNode;
  required?: boolean;
}): JSX.Element {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        {label}
        {required && <span aria-hidden="true"> *</span>}
      </label>
      {children({ id, 'aria-invalid': Boolean(error), 'aria-describedby': describedBy })}
      {hint && !error && (
        <span className="field-hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
      {error && (
        <span className="field-error" id={`${id}-error`} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ states */

export function Skeleton({
  height = 16,
  width = '100%',
  count = 1,
}: {
  height?: number;
  width?: number | string;
  count?: number;
}): JSX.Element {
  return (
    <div className="stack" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="skeleton" style={{ height, width }} />
      ))}
    </div>
  );
}

export function LoadingBlock({ label = 'Loading' }: { label?: string }): JSX.Element {
  return (
    <div>
      <span className="visually-hidden" role="status">
        {label}
      </span>
      <Skeleton count={4} height={40} />
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
}): JSX.Element {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {body && <p>{body}</p>}
      {action}
    </div>
  );
}

export function ErrorState({
  title = "That didn't work",
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
}): JSX.Element {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <p>{message}</p>
      {onRetry && (
        <Button variant="default" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------ dialog */

export function Dialog({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useScrollLock();

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    // A selector list matches in document order, which would land on the header
    // close button. Try the field types in preference order instead, so opening
    // a dialog puts the caret where the work is.
    const target =
      ['input:not([disabled])', 'textarea', 'select', 'button:not([disabled])']
        .map((selector) => ref.current?.querySelector<HTMLElement>(selector) ?? null)
        .find((el) => el !== null) ?? null;
    target?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab' && ref.current) {
        // Keep focus inside the dialog.
        const focusable = [
          ...ref.current.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), input:not([disabled]), textarea, select, [tabindex]:not([tabindex="-1"])',
          ),
        ];
        if (focusable.length === 0) return;
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, [onClose]);

  return createPortal(
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="dialog-head">
          <h2>{title}</h2>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
            ✕
          </Button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer && <div className="dialog-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/* ------------------------------------------------------------ toasts */

type ToastKind = 'info' | 'success' | 'error';
interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}
interface ToastApi {
  push: (message: string, kind?: ToastKind) => void;
}

const ToastContext = createContext<ToastApi>({ push: () => undefined });

export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, kind, message }]);
    window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5200);
  }, []);
  const value = useMemo(() => ({ push }), [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="region" aria-live="polite" aria-label="Notifications">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast-${t.kind}`}>
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  return useContext(ToastContext);
}

/* ------------------------------------------------------------ misc */

export function Avatar({ name, title }: { name: string | null; title?: string }): JSX.Element {
  const initials = (name ?? '?')
    .split(' ')
    .slice(0, 2)
    .map((part) => part[0] ?? '')
    .join('');
  return (
    <span className="avatar" title={title ?? name ?? 'Unassigned'} aria-hidden="true">
      {initials || '?'}
    </span>
  );
}

export function Pill({
  tone = 'default',
  children,
}: {
  tone?: 'default' | 'good' | 'warn' | 'danger' | 'accent';
  children: ReactNode;
}): JSX.Element {
  return <span className={`pill${tone === 'default' ? '' : ` pill-${tone}`}`}>{children}</span>;
}

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  // Floor, not round: rounding reports elapsed time that has not elapsed yet
  // (30 seconds ago as "1m ago", 90 minutes ago as "2h ago").
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return '—';
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: y === new Date().getUTCFullYear() ? undefined : 'numeric',
  });
}

export function isOverdue(dueDate: string | null, statusCategory: string): boolean {
  if (!dueDate || statusCategory === 'done') return false;
  return dueDate < new Date().toISOString().slice(0, 10);
}
