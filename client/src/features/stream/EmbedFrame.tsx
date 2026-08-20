import { memo, useEffect, useState } from 'react';
import type { RoomStream } from '@shared/protocol';
import { useT } from '@/i18n/I18nProvider';
import { displayHost } from './urlKind';

/**
 * Renders a platform's own embed address in a sandboxed frame.
 *
 * Every client loads it directly from the platform, exactly like the HLS path —
 * nothing is proxied and nothing is extracted. The address is the one the
 * platform publishes for embedding, and a site that does not want to be framed
 * says so with X-Frame-Options or a frame-ancestors policy. That refusal is
 * respected: the frame simply stays empty and the hint below explains why.
 *
 * The sandbox is deliberately narrow. Scripts and the frame's own origin are
 * allowed because no player works without them; popups, downloads, top-level
 * navigation and form submission are not, so a frame cannot navigate the room
 * out from under anyone.
 */
const SANDBOX = 'allow-scripts allow-same-origin allow-presentation';
const ALLOW = 'autoplay; encrypted-media; picture-in-picture; fullscreen; clipboard-write';

export const EmbedFrame = memo(function EmbedFrame({ stream }: { stream: RoomStream }) {
  const t = useT();
  const [showBlockedHint, setShowBlockedHint] = useState(false);

  // A frame refused by the remote site fires no error event that is readable
  // from here, so the hint appears on a timer instead of pretending to detect
  // it. It sits under the frame rather than over it, so a working embed is
  // never covered by a warning about a problem it does not have.
  useEffect(() => {
    setShowBlockedHint(false);
    const timer = window.setTimeout(() => setShowBlockedHint(true), 6_000);
    return () => window.clearTimeout(timer);
  }, [stream.url]);

  return (
    <div className="relative flex h-full w-full flex-col bg-black">
      <iframe
        // Remounts on URL change rather than reusing a frame that may hold
        // another site's paused player.
        key={stream.url}
        src={stream.url}
        title={stream.title ?? t('stream.embedBadge')}
        className="h-full w-full border-0"
        sandbox={SANDBOX}
        allow={ALLOW}
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
        loading="eager"
      />

      <div className="pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between gap-2 p-3 sm:p-4">
        <span className="truncate rounded-md bg-black/60 px-2.5 py-1 text-xs font-medium text-chalk-50 backdrop-blur-sm">
          {stream.title ?? t('stream.embedBadge')}
          <span className="ml-2 font-mono text-chalk-400">{displayHost(stream.url)}</span>
        </span>
      </div>

      {showBlockedHint && (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 p-3 sm:p-4">
          <p className="mx-auto max-w-md rounded-lg bg-black/70 px-3 py-2 text-center text-xs leading-relaxed text-chalk-300 backdrop-blur-sm">
            {t('stream.embedBlockedHint')}
          </p>
        </div>
      )}
    </div>
  );
});
