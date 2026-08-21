import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Tracks whether the push-to-talk key is currently held.
 *
 * Uses KeyboardEvent.code rather than .key so the binding survives layout
 * switches — a Turkish Q keyboard and a US layout both report "KeyT" for the
 * same physical key.
 */
export interface PushToTalkState {
  talking: boolean;
  /** For a hold-to-talk control, which is the only way in on a touchscreen. */
  press: () => void;
  release: () => void;
}

export function usePushToTalk(enabled: boolean, keyCode: string): PushToTalkState {
  const [talking, setTalking] = useState(false);
  const heldRef = useRef(false);

  useEffect(() => {
    if (!enabled) {
      heldRef.current = false;
      setTalking(false);
      return;
    }

    const isTypingTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      return (
        target.isContentEditable ||
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT'
      );
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== keyCode || event.repeat) return;
      // Never swallow the key while someone is typing their name or a code.
      if (isTypingTarget(event.target)) return;

      // Space would otherwise scroll the page out from under the video.
      if (keyCode === 'Space') event.preventDefault();

      if (!heldRef.current) {
        heldRef.current = true;
        setTalking(true);
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== keyCode) return;
      if (heldRef.current) {
        heldRef.current = false;
        setTalking(false);
      }
    };

    /**
     * Without these, alt-tabbing while holding the key leaves the mic hot —
     * the keyup lands in another window and never reaches us.
     */
    const release = () => {
      if (heldRef.current) {
        heldRef.current = false;
        setTalking(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', release);
    document.addEventListener('visibilitychange', release);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', release);
      document.removeEventListener('visibilitychange', release);
      release();
    };
  }, [enabled, keyCode]);

  /**
   * A phone has no key to hold, so the same state has to be reachable by
   * touch. These go through the same ref the keyboard uses, which is what
   * keeps a pointer release from cancelling a key that is still held.
   */
  const press = useCallback(() => {
    if (heldRef.current) return;
    heldRef.current = true;
    setTalking(true);
  }, []);

  const release = useCallback(() => {
    if (!heldRef.current) return;
    heldRef.current = false;
    setTalking(false);
  }, []);

  return { talking, press, release };
}

/** Human-readable label for a KeyboardEvent.code. */
export function formatKeyCode(code: string): string {
  if (code === 'Space') return 'Space';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`;
  if (code.startsWith('Arrow')) return code.slice(5);
  if (code === 'ControlLeft' || code === 'ControlRight') return 'Ctrl';
  if (code === 'ShiftLeft' || code === 'ShiftRight') return 'Shift';
  if (code === 'AltLeft' || code === 'AltRight') return 'Alt';
  return code;
}
