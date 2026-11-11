import { createContext, useCallback, useContext, useEffect, useId, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';

export function cx(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(' ');
}

const VARIANT = { primary: 'btn-primary', secondary: 'btn-secondary', danger: 'btn-danger', ghost: 'btn-ghost' } as const;

export function Button({ variant = 'secondary', size, className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; size?: 'sm' }) {
  return <button type="button" {...p} className={cx('btn', VARIANT[variant], size === 'sm' && 'btn-sm', className)} />;
}

const BADGE: Record<string, string> = {
  green: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300',
  blue: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300',
  red: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300',
  gray: 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300',
  brand: 'bg-brand-100 text-brand-700 dark:bg-brand-700/30 dark:text-brand-100',
};
export function Badge({ tone = 'gray', children, ...rest }: { tone?: keyof typeof BADGE; children: ReactNode; 'data-testid'?: string }) {
  return <span {...rest} className={cx('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', BADGE[tone])}>{children}</span>;
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-2 p-6 text-sm text-slate-500">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600" aria-hidden />
      {label}...
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-slate-300 p-8 text-center text-sm text-slate-500 dark:border-slate-700">{children}</div>;
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return <div role="alert" className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-300">{msg}</div>;
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <h1 className="text-xl font-semibold">{title}</h1>
      {children}
    </div>
  );
}

export function Progress({ value, label, tone = 'brand' }: { value: number; label: string; tone?: 'brand' | 'blue' }) {
  const pct = Math.round(Math.min(1, Math.max(0, value || 0)) * 100);
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-2 w-full overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800">
      <div className={cx('h-full rounded-full transition-all', tone === 'blue' ? 'bg-sky-500' : 'bg-brand-600')} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** Labelled form control wrapper; children receive the generated id via render prop. */
export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="label">{label}</label>
      {children(id)}
      {hint && <p className="hint">{hint}</p>}
    </div>
  );
}

export function Check({ label, checked, onChange, disabled }: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="flex items-center gap-2">
      <input id={id} type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500" />
      <label htmlFor={id} className="text-sm">{label}</label>
    </div>
  );
}

/** Two-step inline confirmation (no window.confirm). */
export function ConfirmButton({ label, confirmLabel = 'Confirm', onConfirm, disabled, size = 'sm', description }: { label: string; confirmLabel?: string; onConfirm: () => void; disabled?: boolean; size?: 'sm'; description?: string }) {
  const [asking, setAsking] = useState(false);
  if (!asking) return <Button size={size} variant="ghost" disabled={disabled} onClick={() => setAsking(true)}>{label}</Button>;
  return (
    <span className="inline-flex flex-wrap items-center gap-1" role="group" aria-label={`Confirm ${label}`}>
      {description && <span data-testid="confirm-description" className="basis-full text-xs text-slate-600 dark:text-slate-300">{description}</span>}
      <Button size={size} variant="danger" onClick={() => { setAsking(false); onConfirm(); }}>{confirmLabel}</Button>
      <Button size={size} variant="ghost" onClick={() => setAsking(false)}>Keep</Button>
    </span>
  );
}

// ---- toasts ----
interface Toast { id: number; kind: 'ok' | 'error'; text: string }
const ToastCtx = createContext<(kind: Toast['kind'], text: string) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
  }, []);
  useEffect(() => {
    if (!toasts.length) return;
    const t = setTimeout(() => setToasts((l) => l.slice(1)), 5000);
    return () => clearTimeout(t);
  }, [toasts]);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex max-w-sm flex-col gap-2" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} role={t.kind === 'error' ? 'alert' : 'status'} className={cx('pointer-events-auto rounded-md px-3 py-2 text-sm shadow-lg', t.kind === 'error' ? 'bg-red-600 text-white' : 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900')}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
