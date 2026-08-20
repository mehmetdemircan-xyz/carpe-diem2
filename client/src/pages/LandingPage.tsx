import { useCallback, useId, useRef, useState } from 'react';
import { useT } from '@/i18n/I18nProvider';
import { LanguageToggle } from '@/components/LanguageToggle';
import { Wordmark } from '@/components/Wordmark';

type Mode = 'idle' | 'join';

export interface LandingIntent {
  mode: 'create' | 'join';
  code?: string;
}

/**
 * Deliberately one screen with two buttons. Anything else here is a decision
 * the first-time user has to make before they know what the product does.
 */
export function LandingPage({
  onIntent,
  busy,
}: {
  onIntent: (intent: LandingIntent) => void;
  busy: boolean;
}) {
  const t = useT();
  const [mode, setMode] = useState<Mode>('idle');
  const [code, setCode] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const codeInputId = useId();

  const openJoin = useCallback(() => {
    setMode('join');
    // Focus lands after paint so the caret is in the field on desktop and the
    // keyboard opens on mobile.
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  /**
   * Formats as the user types so a pasted "carp8f42" becomes "CARP-8F42"
   * without them thinking about it.
   */
  const onCodeChange = useCallback((raw: string) => {
    const stripped = raw
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 8);
    setCode(stripped.length > 4 ? `${stripped.slice(0, 4)}-${stripped.slice(4)}` : stripped);
  }, []);

  const submitJoin = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const trimmed = code.trim();
      if (trimmed.replace('-', '').length !== 8) return;
      onIntent({ mode: 'join', code: trimmed });
    },
    [code, onIntent],
  );

  return (
    <div className="flex min-h-full flex-col">
      <header className="flex items-center justify-between px-5 py-5 sm:px-8">
        <Wordmark size="md" />
        <LanguageToggle />
      </header>

      <main className="flex flex-1 flex-col items-center justify-center px-5 pb-20 pt-6 sm:px-8">
        <div className="w-full max-w-md text-center">
          <h1 className="text-4xl font-medium leading-[1.1] tracking-tight text-chalk-50 sm:text-5xl">
            {t('app.tagline')}
          </h1>
          <p className="mx-auto mt-4 max-w-sm text-[0.95rem] leading-relaxed text-chalk-400">
            {t('landing.subtitle')}
          </p>

          {mode === 'idle' ? (
            <div className="mt-9 flex flex-col gap-2.5 sm:flex-row sm:justify-center">
              <button
                type="button"
                onClick={() => onIntent({ mode: 'create' })}
                disabled={busy}
                className="btn-primary sm:min-w-[9.5rem]"
              >
                {busy ? t('landing.creating') : t('landing.createRoom')}
              </button>
              <button
                type="button"
                onClick={openJoin}
                disabled={busy}
                className="btn-secondary sm:min-w-[9.5rem]"
              >
                {t('landing.joinRoom')}
              </button>
            </div>
          ) : (
            <form onSubmit={submitJoin} className="mt-9 animate-slide-up text-left">
              <label
                htmlFor={codeInputId}
                className="mb-2 block text-center text-sm font-medium text-chalk-200"
              >
                {t('join.title')}
              </label>
              <input
                id={codeInputId}
                ref={inputRef}
                value={code}
                onChange={(event) => onCodeChange(event.target.value)}
                placeholder={t('join.codePlaceholder')}
                inputMode="text"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                maxLength={9}
                aria-describedby={`${codeInputId}-hint`}
                className="field text-center font-mono text-2xl tracking-[0.2em]"
              />
              <p id={`${codeInputId}-hint`} className="mt-2 text-center text-xs text-chalk-600">
                {t('join.hint')}
              </p>
              <div className="mt-4 flex gap-2.5">
                <button
                  type="button"
                  onClick={() => setMode('idle')}
                  className="btn-secondary flex-1"
                >
                  {t('join.back')}
                </button>
                <button
                  type="submit"
                  disabled={busy || code.replace('-', '').length !== 8}
                  className="btn-primary flex-1"
                >
                  {busy ? t('join.joining') : t('join.submit')}
                </button>
              </div>
            </form>
          )}

          <p className="mt-8 text-sm text-chalk-600">{t('landing.noAccount')}</p>
        </div>
      </main>

      <footer className="px-5 pb-8 sm:px-8">
        <ul className="mx-auto flex max-w-md flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-chalk-600">
          <li>{t('landing.feature.fast')}</li>
          <li aria-hidden className="text-ink-700">
            ·
          </li>
          <li>{t('landing.feature.private')}</li>
          <li aria-hidden className="text-ink-700">
            ·
          </li>
          <li>{t('landing.feature.noAccount')}</li>
          <li aria-hidden className="text-ink-700">
            ·
          </li>
          <li>{t('landing.feature.quality')}</li>
        </ul>
      </footer>
    </div>
  );
}
