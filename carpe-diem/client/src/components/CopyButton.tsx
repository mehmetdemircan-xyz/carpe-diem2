import { useCallback, useEffect, useRef, useState } from 'react';
import { CheckIcon, CopyIcon } from './icons';

/**
 * Clipboard write with a real fallback. navigator.clipboard is unavailable on
 * plain HTTP and inside some in-app browsers, which is exactly where people
 * paste room codes from.
 */
export async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Fall through to the legacy path.
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export function CopyButton({
  value,
  label,
  variant = 'secondary',
  onResult,
  className = '',
}: {
  value: string;
  label: string;
  variant?: 'primary' | 'secondary' | 'ghost';
  onResult?: (ok: boolean) => void;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    },
    [],
  );

  const onClick = useCallback(async () => {
    const ok = await copyText(value);
    onResult?.(ok);
    if (!ok) return;

    setCopied(true);
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => setCopied(false), 1600);
  }, [value, onResult]);

  const variantClass =
    variant === 'primary' ? 'btn-primary' : variant === 'ghost' ? 'btn-ghost' : 'btn-secondary';

  return (
    <button type="button" onClick={onClick} className={`${variantClass} ${className}`}>
      {copied ? <CheckIcon className="h-4 w-4" /> : <CopyIcon className="h-4 w-4" />}
      <span>{label}</span>
    </button>
  );
}
