import { memo, useCallback, useEffect, useId, useMemo, useState } from 'react';
import type { ErrorCode, PlaylistEntry, StreamKind } from '@shared/protocol';
import { MAX_STREAM_URL_LENGTH } from '@shared/protocol';
import { useT } from '@/i18n/I18nProvider';
import { Modal } from '@/components/Modal';
import { ScreenIcon } from '@/components/icons';
import { isLikelyMobile, isScreenShareSupported } from '@/services/webrtc/capture';
import type { MessageKey } from '@/i18n/messages';
import { classifyUrl, displayHost, isMixedContent, type UrlKind } from './urlKind';

/** What the person chose from the menu. Each one is a different destination. */
export type StreamModalMode = 'direct' | 'playlist' | 'embed' | 'page';

interface StreamModalProps {
  open: boolean;
  mode: StreamModalMode;
  onModeChange: (mode: StreamModalMode) => void;
  onClose: () => void;
  canShare: boolean;
  onStart: (url: string, title: string | undefined, kind: StreamKind) => Promise<boolean>;
  onLoadPlaylist: (
    url: string,
  ) => Promise<
    | { ok: true; entries: PlaylistEntry[]; truncated: boolean }
    | { ok: false; error: ErrorCode; detail?: string }
  >;
  /** Starts the browser's own capture picker, biased toward the tab list. */
  onShareTab: () => void;
}

const TITLE_KEY: Record<StreamModalMode, MessageKey> = {
  direct: 'stream.mode.direct',
  playlist: 'stream.mode.playlist',
  embed: 'stream.mode.embed',
  page: 'stream.mode.page',
};

const PLACEHOLDER: Record<StreamModalMode, string> = {
  direct: 'https://example.com/stream.m3u8',
  playlist: 'https://example.com/channels.m3u',
  embed: 'https://www.youtube.com/embed/VIDEO_ID',
  page: 'https://example.com/some-video-page',
};

/**
 * One field, four destinations, chosen from the control bar's menu.
 *
 * The important distinction is between the first three, which distribute a URL
 * that every client loads from its source, and the last, which distributes
 * nothing at all — it hands off to the browser's own tab capture. No mode
 * fetches a page, reads its markup, or looks for a media address inside it.
 */
export const StreamModal = memo(function StreamModal({
  open,
  mode,
  onModeChange,
  onClose,
  canShare,
  onStart,
  onLoadPlaylist,
  onShareTab,
}: StreamModalProps) {
  const t = useT();
  const inputId = useId();

  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  /** A status code or limit from the server, shown beside the message. */
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const [entries, setEntries] = useState<PlaylistEntry[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [filter, setFilter] = useState('');

  const shareSupported = useMemo(() => isScreenShareSupported(), []);
  const classified = useMemo(() => classifyUrl(url), [url]);
  const mixedContent = useMemo(
    () => classified.kind !== 'invalid' && isMixedContent(classified.url),
    [classified],
  );

  const reset = useCallback(() => {
    setUrl('');
    setError(null);
    setErrorDetail(null);
    setEntries(null);
    setFilter('');
    setTruncated(false);
  }, []);

  // A fresh field for each visit; a leftover address from last time is a
  // paste-over hazard, not a convenience.
  useEffect(() => {
    if (open) reset();
  }, [open, mode, reset]);

  const close = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  /* ------------------------------------------------------------------ */
  /* Direct media, playlists and embeds                                  */
  /* ------------------------------------------------------------------ */

  const submit = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      const trimmed = url.trim();
      if (!trimmed || busy) return;

      if (classified.kind === 'invalid') {
        setError('stream.invalidUrl');
        return;
      }

      // Both of these are certainties, not guesses: the browser refuses one
      // and cannot decode the other. Attempting them anyway would only
      // replace a precise explanation with a generic playback failure.
      if (classified.kind === 'unplayable' && mode !== 'playlist') {
        setError('stream.rawTransportStream');
        return;
      }
      if (mixedContent && mode !== 'playlist') {
        setError('stream.mixedContent');
        return;
      }

      setBusy(true);
      setError(null);
      setErrorDetail(null);

      if (mode === 'playlist') {
        const result = await onLoadPlaylist(trimmed);
        setBusy(false);
        if (!result.ok) {
          setError(`error.${result.error}` as MessageKey);
          setErrorDetail(result.detail ?? null);
          return;
        }
        setEntries(result.entries);
        setTruncated(result.truncated);
        return;
      }

      const started = await onStart(trimmed, undefined, mode === 'embed' ? 'embed' : 'media');
      setBusy(false);
      if (started) close();
    },
    [url, busy, classified.kind, mixedContent, mode, onLoadPlaylist, onStart, close],
  );

  const pick = useCallback(
    async (entry: PlaylistEntry) => {
      // A list is often entirely http while the room is on https. Saying so
      // once, on the channel that was clicked, beats a silent dead player.
      if (isMixedContent(entry.url)) {
        setError('stream.mixedContent');
        setErrorDetail(null);
        return;
      }

      // The same certainty the URL field applies, applied here too. Channel
      // lists routinely mix playable VOD entries with raw MPEG-TS live ones,
      // and without this the dead one is pushed to everybody's stage before
      // anyone finds out it cannot decode.
      if (classifyUrl(entry.url).kind === 'unplayable') {
        setError('stream.rawTransportStream');
        setErrorDetail(null);
        return;
      }

      setBusy(true);
      const started = await onStart(entry.url, entry.name, 'media');
      setBusy(false);
      if (started) close();
    },
    [onStart, close],
  );

  /* ------------------------------------------------------------------ */
  /* Page: open it, then share that tab                                  */
  /* ------------------------------------------------------------------ */

  const openAndShare = useCallback(() => {
    if (classified.kind === 'invalid') {
      setError('stream.invalidUrl');
      return;
    }

    // classifyUrl has already established this is http(s); nothing else ever
    // reaches window.open.
    window.open(classified.url, '_blank', 'noopener,noreferrer');

    // Close first so the browser's picker is not competing with a modal.
    close();
    onShareTab();
  }, [classified, close, onShareTab]);

  const visible = useMemo(() => {
    if (!entries) return [];
    const needle = filter.trim().toLocaleLowerCase();
    const matched = needle
      ? entries.filter(
          (entry) =>
            entry.name.toLocaleLowerCase().includes(needle) ||
            entry.group?.toLocaleLowerCase().includes(needle),
        )
      : entries;
    return matched.slice(0, 300);
  }, [entries, filter]);

  /* ------------------------------------------------------------------ */

  if (entries !== null) {
    return (
      <Modal
        open={open}
        onClose={close}
        title={t('stream.mode.playlist')}
        labelClose={t('common.close')}
      >
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-chalk-400">
              {t('stream.channelCount', { count: entries.length })}
            </p>
            <button type="button" onClick={reset} className="btn-ghost !px-2 !py-1 text-xs">
              {t('stream.back')}
            </button>
          </div>

          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t('stream.filter')}
            className="field text-sm"
            autoComplete="off"
          />

          {truncated && <p className="text-xs text-chalk-600">{t('stream.truncated')}</p>}

          {error && (
            <p role="alert" className="text-sm text-signal-bad">
              {t(error)}
            </p>
          )}

          <ul className="max-h-80 space-y-0.5 overflow-y-auto">
            {visible.map((entry) => (
              <li key={`${entry.url}-${entry.name}`}>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void pick(entry)}
                  className="w-full rounded-lg px-3 py-2 text-left transition-colors hover:bg-ink-850 disabled:opacity-50"
                >
                  <span className="block truncate text-sm text-chalk-50">{entry.name}</span>
                  {entry.group && (
                    <span className="block truncate text-xs text-chalk-600">{entry.group}</span>
                  )}
                </button>
              </li>
            ))}
            {visible.length === 0 && (
              <li className="px-3 py-6 text-center text-sm text-chalk-600">
                {t('stream.noMatches')}
              </li>
            )}
          </ul>
        </div>
      </Modal>
    );
  }

  const isPageMode = mode === 'page';

  return (
    <Modal open={open} onClose={close} title={t(TITLE_KEY[mode])} labelClose={t('common.close')}>
      <form onSubmit={submit} className="space-y-4">
        <div className="flex flex-wrap gap-1 rounded-lg border border-ink-800 bg-ink-850 p-1">
          {(['direct', 'playlist', 'embed', 'page'] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onModeChange(option)}
              aria-pressed={mode === option}
              className={`flex-1 rounded-md px-2 py-1.5 text-xs font-medium transition-colors ${
                mode === option ? 'bg-ink-700 text-chalk-50' : 'text-chalk-600 hover:text-chalk-200'
              }`}
            >
              {t(TITLE_KEY[option])}
            </button>
          ))}
        </div>

        <div>
          <label htmlFor={inputId} className="mb-1.5 block text-sm text-chalk-400">
            {t(isPageMode ? 'stream.pageUrlLabel' : 'stream.urlLabel')}
          </label>
          <input
            id={inputId}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder={PLACEHOLDER[mode]}
            maxLength={MAX_STREAM_URL_LENGTH}
            autoComplete="off"
            spellCheck={false}
            inputMode="url"
            className="field text-sm"
          />
          <UrlVerdict
            mode={mode}
            kind={url.trim() ? classified.kind : null}
            mixedContent={mixedContent}
          />
        </div>

        {isPageMode ? (
          <>
            <div className="rounded-lg border border-ink-800 bg-ink-850 p-3">
              <p className="text-sm text-chalk-200">{t('stream.pageExplain')}</p>
              <p className="mt-2 text-xs leading-relaxed text-chalk-600">{t('stream.pageSteps')}</p>
              {classified.kind !== 'invalid' && url.trim() && (
                <p className="mt-2 truncate font-mono text-xs text-chalk-400">
                  {displayHost(classified.url)}
                </p>
              )}
            </div>

            {!shareSupported && (
              <p role="alert" className="text-sm text-signal-warn">
                {isLikelyMobile() ? t('room.mobileShareUnsupported') : t('stream.shareUnsupported')}
              </p>
            )}
            {shareSupported && !canShare && (
              <p role="alert" className="text-sm text-signal-warn">
                {t('stream.needPermission')}
              </p>
            )}
            {error && (
              <p role="alert" className="text-sm text-signal-bad">
                {t(error)}
              </p>
            )}

            <div className="flex gap-2.5">
              <button type="button" onClick={close} className="btn-secondary flex-1">
                {t('common.cancel')}
              </button>
              <button
                type="button"
                onClick={openAndShare}
                disabled={!shareSupported || !canShare || url.trim().length === 0}
                className="btn-primary flex-1"
              >
                <ScreenIcon className="h-4 w-4" />
                <span>{t('stream.openAndShare')}</span>
              </button>
            </div>

            <p className="border-t border-ink-800 pt-3 text-xs leading-relaxed text-chalk-600">
              {t('stream.tabAudioHint')}
            </p>
          </>
        ) : (
          <>
            <p className="text-xs leading-relaxed text-chalk-600">
              {t(
                mode === 'embed'
                  ? 'stream.embedHint'
                  : mode === 'playlist'
                    ? 'stream.playlistHint'
                    : 'stream.urlHint',
              )}
            </p>

            {error && (
              <div role="alert" className="text-sm text-signal-bad">
                <p>{t(error)}</p>
                {/* The upstream status, when there is one. Kept separate and
                    quiet: it is a clue for whoever is fixing the link, not
                    the sentence anyone needs to read first. */}
                {errorDetail && (
                  <p className="mt-1 font-mono text-xs text-chalk-600">
                    {t(
                      error === 'error.PLAYLIST_TOO_LARGE'
                        ? 'error.limitDetail'
                        : 'error.upstreamStatus',
                      { status: errorDetail },
                    )}
                  </p>
                )}
              </div>
            )}

            <div className="flex gap-2.5">
              <button type="button" onClick={close} className="btn-secondary flex-1">
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={busy || url.trim().length === 0}
                className="btn-primary flex-1"
              >
                {busy
                  ? t('stream.working')
                  : t(mode === 'playlist' ? 'stream.loadChannels' : 'stream.start')}
              </button>
            </div>

            <p className="border-t border-ink-800 pt-3 text-xs leading-relaxed text-chalk-600">
              {t(mode === 'embed' ? 'stream.embedNote' : 'stream.corsNote')}
            </p>
          </>
        )}
      </form>
    </Modal>
  );
});

/**
 * Says what the pasted address looks like before anything is attempted, and
 * points out the common mismatch: a page address in a mode that needs a file.
 */
function UrlVerdict({
  mode,
  kind,
  mixedContent,
}: {
  mode: StreamModalMode;
  kind: UrlKind | null;
  mixedContent: boolean;
}) {
  const t = useT();
  if (kind === null) return null;

  if (kind === 'invalid') {
    return <p className="mt-2 text-xs text-signal-warn">{t('stream.invalidUrl')}</p>;
  }

  // Checked before anything else about the address, because the browser will
  // refuse it whatever else is right about it.
  if (mixedContent && mode !== 'page') {
    return <p className="mt-2 text-xs text-signal-bad">{t('stream.mixedContent')}</p>;
  }

  if (kind === 'unplayable') {
    return <p className="mt-2 text-xs text-signal-warn">{t('stream.rawTransportStream')}</p>;
  }

  if ((mode === 'direct' || mode === 'playlist') && kind === 'page') {
    return <p className="mt-2 text-xs text-signal-warn">{t('stream.pageInDirectMode')}</p>;
  }

  if (mode === 'page' && kind === 'media') {
    return <p className="mt-2 text-xs text-chalk-600">{t('stream.mediaInPageMode')}</p>;
  }

  return (
    <p className="mt-2 text-xs text-chalk-600">
      {t(kind === 'media' ? 'stream.mediaDetected' : 'stream.pageDetected')}
    </p>
  );
}
