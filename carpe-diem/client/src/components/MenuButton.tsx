import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';

export interface MenuItem {
  id: string;
  label: string;
  hint?: string;
  icon?: ReactNode;
  disabled?: boolean;
  onSelect: () => void;
}

/**
 * A small popover menu anchored to an icon button.
 *
 * Built here rather than pulled in, for the same reason as the rest of the
 * chrome: it is forty lines, and the alternative ships a headless-UI package
 * to the landing page for one control that appears in one place.
 */
export function MenuButton({
  label,
  items,
  children,
  disabled = false,
  align = 'end',
}: {
  label: string;
  items: MenuItem[];
  children: ReactNode;
  disabled?: boolean;
  align?: 'start' | 'end';
}) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const select = useCallback((item: MenuItem) => {
    if (item.disabled) return;
    setOpen(false);
    item.onSelect();
  }, []);

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        disabled={disabled}
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        className={`relative rounded-lg p-2.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
          open ? 'bg-ink-750 text-chalk-50' : 'text-chalk-400 hover:bg-ink-800 hover:text-chalk-50'
        }`}
      >
        {children}
      </button>

      {open && (
        <div
          id={menuId}
          role="menu"
          // Opens upward: this lives in the bottom control bar.
          className={`absolute bottom-full z-50 mb-2 w-64 animate-slide-up rounded-lg border
                      border-ink-800 bg-ink-850 p-1 shadow-xl shadow-black/50
                      ${align === 'end' ? 'right-0' : 'left-0'}`}
        >
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => select(item)}
              className="flex w-full items-start gap-3 rounded-md px-3 py-2 text-left transition-colors
                         hover:bg-ink-800 disabled:cursor-not-allowed disabled:opacity-40
                         disabled:hover:bg-transparent"
            >
              {item.icon && <span className="mt-0.5 shrink-0 text-chalk-400">{item.icon}</span>}
              <span className="min-w-0">
                <span className="block text-sm text-chalk-50">{item.label}</span>
                {item.hint && (
                  <span className="mt-0.5 block text-xs leading-snug text-chalk-600">
                    {item.hint}
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
