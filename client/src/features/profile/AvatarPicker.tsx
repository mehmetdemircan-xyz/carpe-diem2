import { memo, useCallback, useRef, useState } from 'react';
import { useT } from '@/i18n/I18nProvider';
import { Avatar } from '@/components/Avatar';
import { CloseIcon } from '@/components/icons';
import { fileToAvatarDataUrl } from './avatarImage';

/**
 * Optional by design — the room works fine on initials, and nobody should
 * have to find a photo before they can join.
 */
export const AvatarPicker = memo(function AvatarPicker({
  name,
  id,
  avatar,
  onChange,
  size = 'lg',
}: {
  name: string;
  id: string;
  avatar: string | null;
  onChange: (avatar: string | null) => void;
  size?: 'md' | 'lg';
}) {
  const t = useT();
  const inputRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onPick = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Reset immediately so picking the same file twice still fires.
      event.target.value = '';
      if (!file) return;

      setBusy(true);
      setError(null);
      const result = await fileToAvatarDataUrl(file);
      setBusy(false);

      if (!result.ok) {
        setError(
          result.error === 'not-an-image'
            ? t('profile.notAnImage')
            : result.error === 'too-large'
              ? t('profile.tooLarge')
              : t('profile.decodeFailed'),
        );
        return;
      }
      onChange(result.dataUrl);
    },
    [onChange, t],
  );

  return (
    <div className="flex items-center gap-3">
      <div className="relative">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          aria-label={t('profile.choosePhoto')}
          className="rounded-full ring-offset-2 ring-offset-ink-950 transition-opacity hover:opacity-80 disabled:opacity-50"
        >
          <Avatar name={name || '?'} id={id} avatar={avatar} size={size} />
        </button>

        {avatar && (
          <button
            type="button"
            onClick={() => onChange(null)}
            aria-label={t('profile.removePhoto')}
            className="absolute -right-1 -top-1 rounded-full border border-ink-700 bg-ink-850 p-1
                       text-chalk-400 transition-colors hover:text-chalk-50"
          >
            <CloseIcon className="h-3 w-3" />
          </button>
        )}
      </div>

      <div className="min-w-0">
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="btn-secondary !px-3 !py-1.5 text-xs"
        >
          {busy ? t('profile.working') : avatar ? t('profile.changePhoto') : t('profile.addPhoto')}
        </button>
        <p className="mt-1 text-xs text-chalk-600">
          {error ?? t('profile.optional')}
        </p>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif,image/heic"
        onChange={(event) => void onPick(event)}
        className="hidden"
      />
    </div>
  );
});
