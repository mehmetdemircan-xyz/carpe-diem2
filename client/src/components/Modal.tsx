import { useEffect, useRef, type ReactNode } from 'react';
import { CloseIcon } from './icons';

/**
 * Minimal dialog. Not <dialog>, because its backdrop and focus behaviour still
 * differ enough across engines to be more work than doing it directly.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  labelClose,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  labelClose: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;

    restoreFocusRef.current = document.activeElement as HTMLElement | null;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      // Trap focus: without this, tabbing walks into the room behind the modal.
      const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (!focusable?.length) return;

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;

      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    // Defer so the panel exists before we look for something to focus.
    const focusTimer = window.setTimeout(() => {
      panelRef.current?.querySelector<HTMLElement>('button, input, select')?.focus();
    }, 0);

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      window.clearTimeout(focusTimer);
      restoreFocusRef.current?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <div
        className="absolute inset-0 animate-fade-in bg-black/70"
        onClick={onClose}
        aria-hidden
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="relative flex max-h-[85vh] w-full max-w-lg animate-slide-up flex-col
                   rounded-t-2xl border border-ink-800 bg-ink-900 shadow-2xl shadow-black/60
                   sm:rounded-2xl"
      >
        <header className="flex shrink-0 items-center justify-between border-b border-ink-800 px-5 py-4">
          <h2 className="text-base font-medium text-chalk-50">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={labelClose}
            className="rounded-lg p-1.5 text-chalk-400 transition-colors hover:bg-ink-800 hover:text-chalk-50"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}
