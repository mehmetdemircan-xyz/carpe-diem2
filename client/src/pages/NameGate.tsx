import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { MAX_DISPLAY_NAME_LENGTH } from '@shared/protocol';
import { useT } from '@/i18n/I18nProvider';
import { Wordmark } from '@/components/Wordmark';
import { LanguageToggle } from '@/components/LanguageToggle';
import { AvatarPicker } from '@/features/profile/AvatarPicker';

/**
 * The only thing ever asked of a user before they are in a room. It is
 * pre-filled from the last session, so a returning user presses one key.
 */
export function NameGate({
  initialName,
  initialAvatar,
  roomCode,
  busy,
  onSubmit,
  onCancel,
}: {
  initialName: string;
  initialAvatar: string | null;
  roomCode: string | null;
  busy: boolean;
  onSubmit: (name: string, avatar: string | null) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(initialName);
  const [avatar, setAvatar] = useState<string | null>(initialAvatar);
  const inputRef = useRef<HTMLInputElement>(null);
  const inputId = useId();

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const trimmed = name.trim();
      if (!trimmed) return;
      onSubmit(trimmed, avatar);
    },
    [name, avatar, onSubmit],
  );

  return (
    <div className="flex min-h-full flex-col">
      <header className="flex items-center justify-between px-5 py-5 sm:px-8">
        <Wordmark size="md" />
        <LanguageToggle />
      </header>

      <main className="flex flex-1 items-center justify-center px-5 pb-24 sm:px-8">
        <form onSubmit={submit} className="w-full max-w-sm">
          <h1 className="text-2xl font-medium tracking-tight text-chalk-50">{t('name.title')}</h1>
          <p className="mt-2 text-sm text-chalk-400">{t('name.subtitle')}</p>

          {roomCode && (
            <p className="mt-4 text-sm text-chalk-600">
              {t('created.codeLabel')}:{' '}
              <span className="font-mono text-chalk-200">{roomCode}</span>
            </p>
          )}

          <label htmlFor={inputId} className="sr-only">
            {t('name.placeholder')}
          </label>
          {/* Optional, and placed after the name so it never reads as required. */}
          <div className="mt-5">
            <AvatarPicker name={name} id="self" avatar={avatar} onChange={setAvatar} />
          </div>

          <input
            id={inputId}
            ref={inputRef}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('name.placeholder')}
            maxLength={MAX_DISPLAY_NAME_LENGTH}
            autoComplete="nickname"
            className="field mt-4"
          />

          <div className="mt-4 flex gap-2.5">
            <button type="button" onClick={onCancel} className="btn-secondary flex-1">
              {t('join.back')}
            </button>
            <button
              type="submit"
              disabled={busy || name.trim().length === 0}
              className="btn-primary flex-1"
            >
              {busy ? t('join.joining') : t('name.continue')}
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}
