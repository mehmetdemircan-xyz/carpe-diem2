import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * useState that survives a reload. Every access is guarded: Safari in private
 * mode throws on localStorage, and a corrupt value should fall back to the
 * default rather than crash the app on boot.
 */
export function usePersistentState<T>(
  key: string,
  fallback: T,
  validate?: (value: unknown) => value is T,
): [T, (next: T | ((current: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      const parsed: unknown = JSON.parse(raw);
      if (validate) return validate(parsed) ? parsed : fallback;
      return parsed as T;
    } catch {
      return fallback;
    }
  });

  const keyRef = useRef(key);
  keyRef.current = key;

  useEffect(() => {
    try {
      localStorage.setItem(keyRef.current, JSON.stringify(value));
    } catch {
      // Storage full or blocked — the session still works, it just forgets.
    }
  }, [value]);

  const update = useCallback((next: T | ((current: T) => T)) => {
    setValue((current) => (typeof next === 'function' ? (next as (c: T) => T)(current) : next));
  }, []);

  return [value, update];
}
