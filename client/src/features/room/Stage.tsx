import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { Participant, RoomStream } from '@shared/protocol';
import { useT } from '@/i18n/I18nProvider';
import { CollapseIcon, ExpandIcon, PinIcon, ScreenIcon } from '@/components/icons';
import { VideoSurface } from '@/features/screen-share/VideoSurface';
import { StreamPlayer, type StreamFailure } from '@/features/stream/StreamPlayer';
import { EmbedFrame } from '@/features/stream/EmbedFrame';

interface StageProps {
  /** When set and not overridden by a pin, the stream owns the stage. */
  stream: RoomStream | null;
  streamOnStage: boolean;
  canControlStream: boolean;
  onStreamPlayback: (playing: boolean, positionSeconds: number) => void;
  onStreamError: (failure: StreamFailure) => void;

  stageParticipant: Participant | null;
  stageStream: MediaStream | null;
  /** Other people sharing at the same time, offered as thumbnails. */
  otherSharers: Array<{ participant: Participant; stream: MediaStream | null }>;
  selfId: string;
  canShare: boolean;
  isHost: boolean;
  onPin: (id: string) => void;
}

/**
 * The main viewing area. Everything else in the room is chrome around this,
 * so it gets the full remaining height and a true black backdrop — letterbox
 * bars should disappear into the bezel rather than draw a grey frame.
 */
export const Stage = memo(function Stage({
  stream,
  streamOnStage,
  canControlStream,
  onStreamPlayback,
  onStreamError,
  stageParticipant,
  stageStream,
  otherSharers,
  selfId,
  canShare,
  isHost,
  onPin,
}: StageProps) {
  const t = useT();
  const containerRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    const element = containerRef.current;
    if (!element) return;

    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => {});
    } else {
      // Safari on iPhone has no element fullscreen; failing silently leaves
      // the inline player, which still works.
      void element.requestFullscreen?.().catch(() => {});
    }
  }, []);

  const showingSelf = stageParticipant?.id === selfId;

  return (
    <div ref={containerRef} className="relative flex min-h-0 flex-1 flex-col bg-black">
      {stream && streamOnStage ? (
        // An embed is a frame the platform controls; media is ours to play.
        stream.kind === 'embed' ? (
          <EmbedFrame stream={stream} />
        ) : (
          <StreamPlayer
            stream={stream}
            isController={canControlStream}
            onPlaybackChange={onStreamPlayback}
            onError={onStreamError}
          />
        )
      ) : stageParticipant && stageStream ? (
        <>
          <VideoSurface
            stream={stageStream}
            // Never play your own captured audio back at yourself.
            muted={showingSelf}
            objectFit="contain"
          />

          <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between p-3 sm:p-4">
            <span className="rounded-md bg-black/55 px-2.5 py-1 text-xs font-medium text-chalk-50 backdrop-blur-sm">
              {showingSelf
                ? t('room.sharingBy', { name: t('common.you') })
                : t('room.sharingBy', { name: stageParticipant.name })}
            </span>

            <button
              type="button"
              onClick={toggleFullscreen}
              aria-label={isFullscreen ? t('room.exitFullscreen') : t('room.fullscreen')}
              className="pointer-events-auto rounded-md bg-black/55 p-2 text-chalk-200 backdrop-blur-sm transition-colors hover:text-chalk-50"
            >
              {isFullscreen ? (
                <CollapseIcon className="h-4 w-4" />
              ) : (
                <ExpandIcon className="h-4 w-4" />
              )}
            </button>
          </div>
        </>
      ) : (
        <EmptyStage canShare={canShare} isHost={isHost} />
      )}

      {otherSharers.length > 0 && (
        <div className="absolute bottom-3 left-3 flex gap-2 sm:bottom-4 sm:left-4">
          {otherSharers.map(({ participant, stream }) => (
            <button
              key={participant.id}
              type="button"
              onClick={() => onPin(participant.id)}
              title={t('room.pin')}
              className="group relative h-16 w-28 overflow-hidden rounded-lg border border-ink-700
                         bg-ink-900 transition-colors hover:border-accent sm:h-20 sm:w-36"
            >
              {stream ? (
                <VideoSurface stream={stream} muted objectFit="cover" />
              ) : (
                <span className="flex h-full items-center justify-center text-chalk-600">
                  <ScreenIcon className="h-5 w-5" />
                </span>
              )}
              <span className="absolute inset-x-0 bottom-0 truncate bg-black/65 px-1.5 py-0.5 text-left text-[0.65rem] text-chalk-200">
                {participant.id === selfId ? t('common.you') : participant.name}
              </span>
              <span className="absolute right-1 top-1 rounded bg-black/60 p-1 text-chalk-200 opacity-0 transition-opacity group-hover:opacity-100">
                <PinIcon className="h-3 w-3" />
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
});

const EmptyStage = memo(function EmptyStage({
  canShare,
  isHost,
}: {
  canShare: boolean;
  isHost: boolean;
}) {
  const t = useT();

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-ink-800 bg-ink-900 text-chalk-600">
        <ScreenIcon className="h-6 w-6" />
      </span>
      <p className="mt-4 text-sm font-medium text-chalk-200">{t('room.emptyStage')}</p>
      <p className="mt-1 max-w-xs text-sm text-chalk-600">
        {canShare || isHost ? t('room.emptyStageHost') : t('room.emptyStageViewer')}
      </p>
    </div>
  );
});
