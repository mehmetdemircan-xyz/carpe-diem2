import { memo, useMemo } from 'react';
import type { Participant } from '@shared/protocol';
import { useT } from '@/i18n/I18nProvider';
import { Avatar } from '@/components/Avatar';

const MAX_VISIBLE = 5;

/**
 * The row of faces in the chat header.
 *
 * It answers "who is talking right now" without anyone having to open the
 * participants panel — which matters most on a phone, where the panel would
 * cover what you are watching.
 *
 * Everyone is always shown, dimmed, rather than only the current speakers.
 * A list that appears and disappears would shift the header on every syllable;
 * a stable row that brightens does not.
 */
export const SpeakerStrip = memo(function SpeakerStrip({
  participants,
  selfId,
}: {
  participants: Participant[];
  selfId: string;
}) {
  const t = useT();

  // Speakers first so the person talking is never the one hidden behind "+2".
  const ordered = useMemo(() => {
    return [...participants].sort((a, b) => {
      if (a.speaking !== b.speaking) return a.speaking ? -1 : 1;
      return a.joinedAt - b.joinedAt;
    });
  }, [participants]);

  if (ordered.length === 0) return null;

  const visible = ordered.slice(0, MAX_VISIBLE);
  const overflow = ordered.length - visible.length;
  const talking = ordered.filter((participant) => participant.speaking);

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <div className="flex items-center gap-1">
        {visible.map((participant) => (
          <Avatar
            key={participant.id}
            id={participant.id}
            // Always the real name: it drives the initials fallback, and
            // substituting "You" here would render your own face as "YO".
            name={participant.name}
            avatar={participant.avatar}
            size="sm"
            speaking={participant.speaking}
            dimWhenQuiet
          />
        ))}
        {overflow > 0 && (
          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink-800 text-[0.6rem] font-medium text-chalk-400">
            +{overflow}
          </span>
        )}
      </div>

      {/*
        Announced for screen readers, which get nothing useful from a row of
        dimmed pictures. Kept polite so it never interrupts.
      */}
      <span className="sr-only" aria-live="polite">
        {talking.length > 0
          ? t('chat.speakingNow', {
              names: talking
                .map((participant) =>
                  participant.id === selfId ? t('common.you') : participant.name,
                )
                .join(', '),
            })
          : ''}
      </span>
    </div>
  );
});
