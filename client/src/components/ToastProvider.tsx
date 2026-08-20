import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type ToastTone = 'info' | 'success' | 'warn' | 'error';

export interface Toast {
  id: number;
  message: string;
  tone: ToastTone;
}

interface ToastApi {
  push: (message: string, tone?: ToastTone) => void;
  dismiss: (id: number) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const DURATIONS: Record<ToastTone, number> = {
  info: 3200,
  success: 3000,
  warn: 4500,
  error: 5200,
};

const MAX_VISIBLE = 4;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
    const timer = timers.current.get(id);
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const push = useCallback(
    (message: string, tone: ToastTone = 'info') => {
      const id = nextId.current++;
      setToasts((current) => {
        // Identical back-to-back messages are noise, not information.
        if (current[current.length - 1]?.message === message) return current;
        return [...current, { id, message, tone }].slice(-MAX_VISIBLE);
      });

      const timer = window.setTimeout(() => dismiss(id), DURATIONS[tone]);
      timers.current.set(id, timer);
    },
    [dismiss],
  );

  // Clearing timers on unmount matters here: this provider wraps the whole
  // app, so a leaked timer would outlive every route change.
  useEffect(() => {
    const pending = timers.current;
    return () => {
      pending.forEach((timer) => window.clearTimeout(timer));
      pending.clear();
    };
  }, []);

  const api = useMemo<ToastApi>(() => ({ push, dismiss }), [push, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <ToastViewport toasts={toasts} onDismiss={dismiss} />
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used inside ToastProvider');
  return context;
}

const TONE_STYLES: Record<ToastTone, string> = {
  info: 'border-ink-700 text-chalk-50',
  success: 'border-signal-good/40 text-chalk-50',
  warn: 'border-signal-warn/40 text-chalk-50',
  error: 'border-signal-bad/40 text-chalk-50',
};

const TONE_MARK: Record<ToastTone, string> = {
  info: 'bg-accent',
  success: 'bg-signal-good',
  warn: 'bg-signal-warn',
  error: 'bg-signal-bad',
};

const ToastViewport = memo(function ToastViewport({
  toasts,
  onDismiss,
}: {
  toasts: Toast[];
  onDismiss: (id: number) => void;
}) {
  if (toasts.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:items-end sm:p-6"
      // Screen-reader users get the same notifications, announced politely so
      // they do not interrupt whatever is being read.
      role="status"
      aria-live="polite"
    >
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={`pointer-events-auto flex w-full max-w-sm animate-slide-up items-center gap-3 rounded-lg border bg-ink-850 py-3 pl-3 pr-4 text-sm shadow-lg shadow-black/40 ${TONE_STYLES[toast.tone]}`}
        >
          <span className={`h-8 w-1 shrink-0 rounded-full ${TONE_MARK[toast.tone]}`} aria-hidden />
          <span className="flex-1 leading-snug">{toast.message}</span>
          <button
            type="button"
            onClick={() => onDismiss(toast.id)}
            className="shrink-0 rounded p-1 text-chalk-400 transition-colors hover:text-chalk-50"
            aria-label="Dismiss"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      ))}
    </div>
  );
});
