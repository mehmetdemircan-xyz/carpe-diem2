import { memo, useCallback, useState } from 'react';
import type { ConnectionQuality, Participant } from '@shared/protocol';
import { useT } from '@/i18n/I18nProvider';
import { ChevronDownIcon, CloseIcon, CrownIcon, ScreenIcon } from '@/components/icons';
import { Avatar } from '@/components/Avatar';
import type { HostActions } from '@/features/room/useRoomSession';

const QUALITY_DOT: Record<ConnectionQuality, string> = {
  excellent: 'bg-signal-good',
  good: 'bg-signal-good',
  unstable: 'bg-signal-warn',
  poor: 'bg-signal-bad',
  unknown: 'bg-ink-600',
};

interface PanelProps {
  open: boolean;
  onClose: () => void;
  participants: Participant[];
  selfId: string;
  hostId: string;
  isHost: boolean;
  actions: HostActions;
}

/**
 * Slides in over the stage on mobile and docks beside it on desktop. Host
 * controls are collapsed behind a per-row disclosure so a viewer's list stays
 * a list, and a host is never one stray tap from removing someone.
 */
export const ParticipantsPanel = memo(function ParticipantsPanel({
  open,
  onClose,
  participants,
  selfId,
  hostId,
  isHost,
  actions,
}: PanelProps) {
  const t = useT();

  if (!open) return null;

  return (
    <>
      {/* Backdrop exists only below lg, where the panel overlays the stage. */}
      <div
        className="fixed inset-0 z-30 bg-black/50 lg:hidden"
        onClick={onClose}
        aria-hidden
      />
      <aside
        className="fixed inset-y-0 right-0 z-40 flex w-[min(20rem,88vw)] animate-slide-in-right
                   flex-col border-l border-ink-800 bg-ink-900
                   lg:static lg:z-auto lg:w-72 lg:animate-none lg:shrink-0"
        aria-label={t('participants.title')}
      >
        <header className="flex shrink-0 items-center justify-between border-b border-ink-800 px-4 py-3.5">
          <h2 className="text-sm font-medium text-chalk-50">
            {t('participants.title')}
            <span className="ml-2 text-chalk-600">{participants.length}</span>
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="rounded-lg p-1.5 text-chalk-400 transition-colors hover:bg-ink-800 hover:text-chalk-50 lg:hidden"
          >
            <CloseIcon className="h-4 w-4" />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <ul className="space-y-0.5">
            {participants.map((participant) => (
              <ParticipantRow
                key={participant.id}
                participant={participant}
                isSelf={participant.id === selfId}
                isTargetHost={participant.id === hostId}
                viewerIsHost={isHost}
                actions={actions}
              />
            ))}
          </ul>
        </div>

        {isHost && participants.some((p) => p.sharing) && (
          <footer className="shrink-0 border-t border-ink-800 p-3">
            <button
              type="button"
              onClick={() => void actions.stopAllShares()}
              className="btn-secondary w-full text-xs"
            >
              {t('participants.stopAll')}
            </button>
          </footer>
        )}
      </aside>
    </>
  );
});

const ParticipantRow = memo(function ParticipantRow({
  participant,
  isSelf,
  isTargetHost,
  viewerIsHost,
  actions,
}: {
  participant: Participant;
  isSelf: boolean;
  isTargetHost: boolean;
  viewerIsHost: boolean;
  actions: HostActions;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);

  // Only a host sees controls, and never against themselves.
  const canManage = viewerIsHost && !isSelf;

  const confirmThen = useCallback((message: string, run: () => void) => {
    if (window.confirm(message)) run();
  }, []);

  const statusLabel = participant.sharing
    ? t('participants.sharing')
    : isTargetHost
      ? t('participants.host')
      : participant.canShare
        ? t('participants.canShare')
        : t('participants.viewer');

  return (
    <li className="rounded-lg">
      <div
        className={`flex items-center gap-2.5 rounded-lg px-2.5 py-2 ${
          canManage ? 'transition-colors hover:bg-ink-850' : ''
        }`}
      >
        <div className="relative shrink-0">
          <Avatar
            id={participant.id}
            name={participant.name}
            avatar={participant.avatar}
            size="md"
            speaking={participant.speaking}
          />
          {/* Connection quality rides on the avatar rather than taking its
              own column, which keeps the row readable at panel width. */}
          <span
            className={`absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full border-2 border-ink-900 ${QUALITY_DOT[participant.quality]}`}
            aria-hidden
          />
        </div>

        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 truncate text-sm text-chalk-50">
            <span className="truncate">{participant.name}</span>
            {isTargetHost && <CrownIcon className="h-3.5 w-3.5 shrink-0 text-accent" />}
            {isSelf && (
              <span className="shrink-0 text-xs text-chalk-600">({t('common.you')})</span>
            )}
          </p>
          <p className="flex items-center gap-1 text-xs text-chalk-600">
            {participant.sharing && <ScreenIcon className="h-3 w-3 text-accent" />}
            <span className={participant.sharing ? 'text-accent' : ''}>{statusLabel}</span>
          </p>
        </div>

        {canManage && (
          <button
            type="button"
            onClick={() => setExpanded((current) => !current)}
            aria-expanded={expanded}
            aria-label={t('participants.hostTools')}
            className="shrink-0 rounded-md p-1 text-chalk-600 transition-colors hover:text-chalk-200"
          >
            <ChevronDownIcon
              className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180' : ''}`}
            />
          </button>
        )}
      </div>

      {canManage && expanded && (
        <div className="mb-1 ml-2 mr-1 space-y-0.5 border-l border-ink-800 pl-3">
          {participant.canShare ? (
            <RowAction
              label={t('participants.revoke')}
              onClick={() => void actions.revokeShare(participant.id)}
            />
          ) : (
            <RowAction
              label={t('participants.grant')}
              onClick={() => void actions.grantShare(participant.id)}
            />
          )}

          <RowAction
            label={t('participants.makeHost')}
            onClick={() =>
              confirmThen(t('participants.confirmHost', { name: participant.name }), () =>
                void actions.transferHost(participant.id),
              )
            }
          />

          <RowAction
            label={t('participants.kick')}
            tone="danger"
            onClick={() =>
              confirmThen(t('participants.confirmKick', { name: participant.name }), () =>
                void actions.kick(participant.id),
              )
            }
          />
        </div>
      )}
    </li>
  );
});

function RowAction({
  label,
  onClick,
  tone = 'default',
}: {
  label: string;
  onClick: () => void;
  tone?: 'default' | 'danger';
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full rounded-md px-2.5 py-1.5 text-left text-xs transition-colors ${
        tone === 'danger'
          ? 'text-signal-bad hover:bg-signal-bad/10'
          : 'text-chalk-200 hover:bg-ink-800'
      }`}
    >
      {label}
    </button>
  );
}
