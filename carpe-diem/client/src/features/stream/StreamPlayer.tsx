import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { RoomStream } from '@shared/protocol';
import { useT } from '@/i18n/I18nProvider';
import { SpeakerOffIcon, SpeakerOnIcon } from '@/components/icons';

export type StreamFailure = 'unreachable' | 'blocked' | 'unsupported';

interface StreamPlayerProps {
  stream: RoomStream;
  /** Controllers drive playback; everyone else follows the synced position. */
  isController: boolean;
  onPlaybackChange: (playing: boolean, positionSeconds: number) => void;
  onError: (failure: StreamFailure) => void;
}

/** Drift beyond this and a follower is nudged back to the shared position. */
const MAX_DRIFT_SECONDS = 4;
const SYNC_BROADCAST_MS = 4_000;

function looksLikeHls(url: string): boolean {
  try {
    return /\.m3u8(\?|#|$)/i.test(new URL(url).pathname + new URL(url).search);
  } catch {
    return /\.m3u8/i.test(url);
  }
}

function hasNativeHls(video: HTMLVideoElement): boolean {
  return (
    video.canPlayType('application/vnd.apple.mpegurl') !== '' ||
    video.canPlayType('application/x-mpegURL') !== ''
  );
}

/**
 * Plays a stream URL that every client loads independently from the source.
 *
 * Safari and iOS play HLS natively; everywhere else needs Media Source
 * Extensions, which hls.js provides. It is imported dynamically so the ~150KB
 * only downloads for someone who actually starts a stream — the landing page
 * and an ordinary screen-sharing session never pay for it.
 */
export const StreamPlayer = memo(function StreamPlayer({
  stream,
  isController,
  onPlaybackChange,
  onError,
}: StreamPlayerProps) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [muted, setMuted] = useState(true);
  const [ready, setReady] = useState(false);
  const [isLive, setIsLive] = useState(false);

  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onPlaybackChangeRef = useRef(onPlaybackChange);
  onPlaybackChangeRef.current = onPlaybackChange;

  /* ---------------------------------------------------------------------- */
  /* Attach the source                                                       */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    let disposed = false;
    let destroyHls: (() => void) | null = null;

    setReady(false);
    setIsLive(false);

    const attach = async () => {
      if (!looksLikeHls(stream.url) || hasNativeHls(video)) {
        // Progressive files and Safari's native HLS both just take a src.
        video.src = stream.url;
        return;
      }

      let HlsModule: typeof import('hls.js').default;
      try {
        HlsModule = (await import('hls.js')).default;
      } catch {
        onErrorRef.current('unsupported');
        return;
      }
      if (disposed) return;

      if (!HlsModule.isSupported()) {
        onErrorRef.current('unsupported');
        return;
      }

      const hls = new HlsModule({
        // Keep the buffer modest: a shared watch session cares more about
        // everyone sitting near the same position than about deep buffering.
        maxBufferLength: 20,
        backBufferLength: 30,
        enableWorker: true,
        lowLatencyMode: false,
      });

      hls.on(HlsModule.Events.ERROR, (_event, data) => {
        // Stream failures are otherwise invisible to whoever has to debug a
        // source that will not play; the detail never reaches the UI.
        console.warn('[carpe] hls error', data.type, data.details, data.fatal);
        if (!data.fatal) return;
        if (data.type === HlsModule.ErrorTypes.NETWORK_ERROR) {
          // A cross-origin refusal surfaces as a network error with no status,
          // which is the single most common way this feature fails.
          onErrorRef.current(data.response?.code ? 'unreachable' : 'blocked');
        } else {
          onErrorRef.current('unreachable');
        }
        hls.destroy();
      });

      hls.on(HlsModule.Events.MANIFEST_PARSED, () => {
        if (!disposed) setReady(true);
      });

      hls.loadSource(stream.url);
      hls.attachMedia(video);
      destroyHls = () => hls.destroy();
    };

    void attach();

    return () => {
      disposed = true;
      destroyHls?.();
      video.removeAttribute('src');
      video.load();
    };
  }, [stream.url]);

  /* ---------------------------------------------------------------------- */
  /* Playback readiness and errors from the element itself                   */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onLoaded = () => {
      setReady(true);
      // Infinite duration means a live edge, where seeking to sync is wrong.
      setIsLive(!Number.isFinite(video.duration));
    };
    const onNativeError = () => {
      console.warn('[carpe] media element error', video.error?.code, video.error?.message);
      onErrorRef.current('unreachable');
    };

    video.addEventListener('loadedmetadata', onLoaded);
    video.addEventListener('error', onNativeError);
    return () => {
      video.removeEventListener('loadedmetadata', onLoaded);
      video.removeEventListener('error', onNativeError);
    };
  }, [stream.url]);

  /* ---------------------------------------------------------------------- */
  /* Controller: broadcast position                                          */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !isController || !ready) return;

    const report = () => onPlaybackChangeRef.current(!video.paused, video.currentTime);

    const timer = window.setInterval(report, SYNC_BROADCAST_MS);
    video.addEventListener('play', report);
    video.addEventListener('pause', report);
    video.addEventListener('seeked', report);

    return () => {
      window.clearInterval(timer);
      video.removeEventListener('play', report);
      video.removeEventListener('pause', report);
      video.removeEventListener('seeked', report);
    };
  }, [isController, ready]);

  /* ---------------------------------------------------------------------- */
  /* Follower: track the shared position                                     */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    const video = videoRef.current;
    if (!video || isController || !ready) return;

    // Live streams have no meaningful shared timeline — everyone is already
    // at the live edge, and seeking would only cause stalls.
    if (isLive) {
      if (stream.playing && video.paused) void video.play().catch(() => {});
      if (!stream.playing && !video.paused) video.pause();
      return;
    }

    // Account for the time the sync message spent in flight.
    const elapsed = stream.playing ? (Date.now() - stream.updatedAt) / 1000 : 0;
    const target = stream.positionSeconds + elapsed;

    if (Math.abs(video.currentTime - target) > MAX_DRIFT_SECONDS) {
      video.currentTime = target;
    }
    if (stream.playing && video.paused) void video.play().catch(() => {});
    if (!stream.playing && !video.paused) video.pause();
  }, [isController, ready, isLive, stream.playing, stream.positionSeconds, stream.updatedAt]);

  const toggleMuted = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const next = !video.muted;
    video.muted = next;
    setMuted(next);
    // Autoplay policies only permit muted playback until a gesture; this is
    // that gesture, so a stream that was blocked can start now.
    if (!next && video.paused) void video.play().catch(() => {});
  }, []);

  return (
    <div className="relative flex h-full w-full flex-col bg-black">
      <video
        ref={videoRef}
        className="h-full w-full object-contain"
        playsInline
        autoPlay
        muted={muted}
        // Only the controller gets a scrubber; followers are kept in sync and
        // would just fight it.
        controls={isController}
      />

      {!ready && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <p className="rounded-md bg-black/60 px-3 py-1.5 text-xs text-chalk-200">
            {t('stream.loading')}
          </p>
        </div>
      )}

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-3 sm:p-4">
        <span className="truncate rounded-md bg-black/55 px-2.5 py-1 text-xs font-medium text-chalk-50 backdrop-blur-sm">
          {stream.title ?? t('stream.badge')}
          {isLive && <span className="ml-2 text-signal-bad">{t('stream.live')}</span>}
        </span>

        <button
          type="button"
          onClick={toggleMuted}
          aria-label={muted ? t('room.speakerOff') : t('room.speakerOn')}
          className="pointer-events-auto rounded-md bg-black/55 p-2 text-chalk-200 backdrop-blur-sm transition-colors hover:text-chalk-50"
        >
          {muted ? <SpeakerOffIcon className="h-4 w-4" /> : <SpeakerOnIcon className="h-4 w-4" />}
        </button>
      </div>

      {muted && ready && (
        <button
          type="button"
          onClick={toggleMuted}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-ink-950"
        >
          {t('stream.unmute')}
        </button>
      )}
    </div>
  );
});
