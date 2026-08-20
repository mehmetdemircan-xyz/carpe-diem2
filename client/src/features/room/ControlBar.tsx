import { memo, type ReactNode } from 'react';
import { useT } from '@/i18n/I18nProvider';
import {
  ChatIcon,
  LeaveIcon,
  MicOffIcon,
  MicOnIcon,
  PeopleIcon,
  ScreenIcon,
  ScreenOffIcon,
  SettingsIcon,
  SpeakerOffIcon,
  SpeakerOnIcon,
  StreamIcon,
  StreamOffIcon,
} from '@/components/icons';
import { formatKeyCode } from '@/features/audio/usePushToTalk';
import { MenuButton, type MenuItem } from '@/components/MenuButton';

interface ControlBarProps {
  micOn: boolean;
  onToggleMic: () => void;
  speakerOn: boolean;
  onToggleSpeaker: () => void;

  isSharing: boolean;
  canShare: boolean;
  shareSupported: boolean;
  onToggleShare: () => void;

  streamActive: boolean;
  canControlStream: boolean;
  /** Stops whatever is on the stage. Only shown while something is running. */
  onStopStream: () => void;
  /** Opens the picker for one of the ways to put something on the stage. */
  onPickSource: (mode: 'direct' | 'playlist' | 'embed' | 'page') => void;

  participantCount: number;
  participantsOpen: boolean;
  onToggleParticipants: () => void;

  chatOpen: boolean;
  unreadCount: number;
  onToggleChat: () => void;

  onOpenSettings: () => void;
  onLeave: () => void;

  pushToTalk: boolean;
  pushToTalkKey: string;
  talking: boolean;
  onTalkPress: () => void;
  onTalkRelease: () => void;
}

/**
 * The one bar that is always visible. Share is the primary action and is the
 * only control that reads as a button with a label — everything else is an
 * icon, because the share button is what a first-time user is looking for.
 */
export const ControlBar = memo(function ControlBar({
  micOn,
  onToggleMic,
  speakerOn,
  onToggleSpeaker,
  isSharing,
  canShare,
  shareSupported,
  onToggleShare,
  streamActive,
  canControlStream,
  onStopStream,
  onPickSource,
  participantCount,
  participantsOpen,
  onToggleParticipants,
  chatOpen,
  unreadCount,
  onToggleChat,
  onOpenSettings,
  onLeave,
  pushToTalk,
  pushToTalkKey,
  talking,
  onTalkPress,
  onTalkRelease,
}: ControlBarProps) {
  const t = useT();
  const shareDisabled = !canShare || !shareSupported;

  const sourceItems: MenuItem[] = [
    {
      id: 'direct',
      label: t('stream.mode.direct'),
      hint: t('stream.menu.directHint'),
      onSelect: () => onPickSource('direct'),
    },
    {
      id: 'playlist',
      label: t('stream.mode.playlist'),
      hint: t('stream.menu.playlistHint'),
      onSelect: () => onPickSource('playlist'),
    },
    {
      id: 'embed',
      label: t('stream.mode.embed'),
      hint: t('stream.menu.embedHint'),
      onSelect: () => onPickSource('embed'),
    },
    {
      id: 'page',
      label: t('stream.mode.page'),
      hint: t('stream.menu.pageHint'),
      onSelect: () => onPickSource('page'),
    },
  ];

  return (
    <div className="control-surface relative shrink-0 border-t">
      {pushToTalk && (
        // Also a button, not just an indicator: a phone has no key to hold,
        // and without this push-to-talk is simply unusable there. Pointer
        // events cover touch and mouse alike, and the release handlers include
        // leave and cancel so a finger sliding off does not leave the mic hot.
        <button
          type="button"
          aria-label={t('room.pttHold')}
          aria-pressed={talking}
          onPointerDown={(event) => {
            event.preventDefault();
            onTalkPress();
          }}
          onPointerUp={onTalkRelease}
          onPointerLeave={onTalkRelease}
          onPointerCancel={onTalkRelease}
          onContextMenu={(event) => event.preventDefault()}
          className={`absolute -top-8 left-1/2 -translate-x-1/2 touch-none select-none rounded-md px-2.5 py-1 text-xs transition-colors ${
            talking ? 'bg-accent text-ink-950' : 'bg-ink-850 text-chalk-600'
          }`}
        >
          {talking ? t('room.pttActive') : t('room.pttHint', { key: formatKeyCode(pushToTalkKey) })}
        </button>
      )}

      <div className="mx-auto flex max-w-5xl items-center gap-1.5 px-3 py-3 sm:gap-2 sm:px-4">
        <IconControl
          label={micOn ? t('room.micOn') : t('room.micOff')}
          active={micOn}
          onClick={onToggleMic}
        >
          {micOn ? <MicOnIcon /> : <MicOffIcon />}
        </IconControl>

        <IconControl
          label={speakerOn ? t('room.speakerOn') : t('room.speakerOff')}
          active={speakerOn}
          onClick={onToggleSpeaker}
        >
          {speakerOn ? <SpeakerOnIcon /> : <SpeakerOffIcon />}
        </IconControl>

        <div className="flex flex-1 items-center justify-center gap-1.5 sm:gap-2">
          <button
            type="button"
            onClick={onToggleShare}
            disabled={shareDisabled}
            title={
              shareDisabled && !shareSupported
                ? t('error.screenShareUnsupported')
                : shareDisabled
                  ? t('error.NOT_ALLOWED_TO_SHARE')
                  : undefined
            }
            className={isSharing ? 'btn-danger px-4' : 'btn-primary px-4'}
          >
            {isSharing ? (
              <ScreenOffIcon className="h-4 w-4" />
            ) : (
              <ScreenIcon className="h-4 w-4" />
            )}
            <span className="hidden sm:inline">
              {isSharing ? t('room.stopShare') : t('room.share')}
            </span>
          </button>

          {/* Putting something on the stage is the same privilege as sharing a
              screen, so these sit beside it and are gated the same way. */}
          {streamActive ? (
            <IconControl
              label={t('stream.stop')}
              active
              disabled={!canControlStream}
              onClick={onStopStream}
            >
              <StreamOffIcon />
            </IconControl>
          ) : (
            <MenuButton label={t('stream.more')} items={sourceItems} disabled={!canShare}>
              <StreamIcon />
            </MenuButton>
          )}
        </div>

        <IconControl
          label={t('chat.open')}
          active={chatOpen}
          onClick={onToggleChat}
          badge={unreadCount}
          badgeTone="accent"
        >
          <ChatIcon />
        </IconControl>

        <IconControl
          label={t('room.participants')}
          active={participantsOpen}
          onClick={onToggleParticipants}
          badge={participantCount}
        >
          <PeopleIcon />
        </IconControl>

        <IconControl label={t('room.settings')} onClick={onOpenSettings}>
          <SettingsIcon />
        </IconControl>

        <IconControl label={t('room.leaveRoom')} tone="danger" onClick={onLeave}>
          <LeaveIcon />
        </IconControl>
      </div>
    </div>
  );
});

function IconControl({
  label,
  children,
  onClick,
  active = false,
  tone = 'default',
  badge,
  badgeTone = 'neutral',
  disabled = false,
}: {
  label: string;
  children: ReactNode;
  onClick: () => void;
  active?: boolean;
  tone?: 'default' | 'danger';
  badge?: number;
  /** Accent marks a badge that wants attention; neutral is just a count. */
  badgeTone?: 'neutral' | 'accent';
  disabled?: boolean;
}) {
  const toneClass =
    tone === 'danger'
      ? 'text-chalk-400 hover:bg-signal-bad/15 hover:text-signal-bad'
      : active
        ? 'bg-ink-750 text-chalk-50'
        : 'text-chalk-400 hover:bg-ink-800 hover:text-chalk-50';

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      aria-pressed={tone === 'default' ? active : undefined}
      className={`relative rounded-lg p-2.5 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${toneClass}`}
    >
      {children}
      {badge !== undefined && badge > 0 && (
        <span
          className={`absolute -right-0.5 -top-0.5 min-w-[1.05rem] rounded-full px-1 text-[0.65rem] font-medium leading-[1.05rem] ${
            badgeTone === 'accent' ? 'bg-accent text-ink-950' : 'bg-ink-700 text-chalk-200'
          }`}
        >
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  );
}
