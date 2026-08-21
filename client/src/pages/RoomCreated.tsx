import { useT } from '@/i18n/I18nProvider';
import { useToast } from '@/components/ToastProvider';
import { CopyButton } from '@/components/CopyButton';
import { Wordmark } from '@/components/Wordmark';
import { roomUrl } from '@/services/router';

/**
 * Shown once, right after a room is created. Its only job is to get the code
 * out of the app and into a chat window, so the code itself is the largest
 * thing on screen and both copy targets are one press away.
 */
export function RoomCreated({ code, onEnter }: { code: string; onEnter: () => void }) {
  const t = useT();
  const toast = useToast();

  const onCopyResult = (ok: boolean, message: string) => {
    toast.push(ok ? message : t('toast.copyFailed'), ok ? 'success' : 'error');
  };

  return (
    <div className="flex min-h-full flex-col">
      <header className="px-5 py-5 sm:px-8">
        <Wordmark size="md" />
      </header>

      <main className="flex flex-1 items-center justify-center px-5 pb-24 sm:px-8">
        <div className="w-full max-w-sm">
          <h1 className="text-2xl font-medium tracking-tight text-chalk-50">
            {t('created.title')}
          </h1>

          <div className="mt-6 rounded-xl border border-ink-800 bg-ink-900 p-5">
            <p className="text-xs uppercase tracking-wide text-chalk-600">
              {t('created.codeLabel')}
            </p>
            {/* Selectable so a user can grab it manually if the clipboard API
                is blocked, which happens on plain HTTP origins. */}
            <p className="mt-2 select-all font-mono text-3xl tracking-[0.15em] text-chalk-50">
              {code}
            </p>
          </div>

          <div className="mt-3 flex gap-2.5">
            <CopyButton
              value={code}
              label={t('created.copyCode')}
              className="flex-1"
              onResult={(ok) => onCopyResult(ok, t('toast.codeCopied'))}
            />
            <CopyButton
              value={roomUrl(code)}
              label={t('created.copyLink')}
              className="flex-1"
              onResult={(ok) => onCopyResult(ok, t('toast.linkCopied'))}
            />
          </div>

          <button type="button" onClick={onEnter} className="btn-primary mt-3 w-full">
            {t('created.enter')}
          </button>

          <p className="mt-4 text-center text-xs text-chalk-600">{t('created.hint')}</p>
        </div>
      </main>
    </div>
  );
}
