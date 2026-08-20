import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '@/i18n/I18nProvider';
import { useToast } from '@/components/ToastProvider';
import { CopyButton } from '@/components/CopyButton';
import { Wordmark } from '@/components/Wordmark';
import { ControlBar } from '@/features/room/ControlBar';
import { ConnectionBadge } from '@/features/room/ConnectionBadge';
import { SettingsPanel } from '@/features/room/SettingsPanel';
import { Stage } from '@/features/room/Stage';
import { ParticipantsPanel } from '@/features/participants/ParticipantsPanel';
import { ChatPanel } from '@/features/chat/ChatPanel';
import { StreamModal, type StreamModalMode } from '@/features/stream/StreamModal';
import type { StreamFailure } from '@/features/stream/StreamPlayer';
import { RemoteAudio } from '@/features/audio/RemoteAudio';
import {
  selectOrderedParticipants,
  selectSharers,
  selectStageParticipant,
  selectStreamOnStage,
} from '@/features/room/roomReducer';
import type { RoomSession } from '@/features/room/useRoomSession';
import { isLikelyMobile, isScreenShareSupported } from '@/services/webrtc/capture';
import type { AudioSettings, QualitySettings } from '@/types/media';

interface RoomPageProps {
  session: RoomSession;
  quality: QualitySettings;
  onQualityChange: (next: QualitySettings) => void;
  audio: AudioSettings;
  onAudioChange: (next: AudioSettings) => void;
  avatar: string | null;
  onAvatarChange: (avatar: string | null) => void;
  talking: boolean;
  onLeave: () => void;
}

/**
 * Composes the room. Holds only view state — which panels are open, whether
 * the speaker is muted locally. Everything with a lifetime lives in the
 * session hook.
 */
export function RoomPage({
  session,
  quality,
  onQualityChange,
  audio,
  onAudioChange,
  avatar,
  onAvatarChange,
  talking,
  onLeave,
}: RoomPageProps) {
  const t = useT();
  const toast = useToast();
  const { state } = session;

  // The two panels share the right rail, so at most one is open at a time.
  const [rail, setRail] = useState<'none' | 'participants' | 'chat'>('none');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [streamModalOpen, setStreamModalOpen] = useState(false);
  const [streamModalMode, setStreamModalMode] = useState<StreamModalMode>('direct');
  const [speakerOn, setSpeakerOn] = useState(true);
  const [unreadCount, setUnreadCount] = useState(0);

  const participantsOpen = rail === 'participants';
  const chatOpen = rail === 'chat';

  const toggleRail = useCallback((panel: 'participants' | 'chat') => {
    setRail((current) => (current === panel ? 'none' : panel));
  }, []);

  /**
   * Counts only messages that arrive while the panel is closed, and never
   * your own. Keyed on message count rather than the array so a re-render
   * cannot double-count.
   */
  const seenCountRef = useRef(state.messages.length);
  useEffect(() => {
    if (chatOpen) {
      seenCountRef.current = state.messages.length;
      setUnreadCount(0);
      return;
    }
    const fresh = state.messages
      .slice(seenCountRef.current)
      .filter((message) => message.from !== state.selfId);
    seenCountRef.current = state.messages.length;
    if (fresh.length > 0) setUnreadCount((current) => current + fresh.length);
  }, [state.messages, chatOpen, state.selfId]);

  const shareSupported = useMemo(() => isScreenShareSupported(), []);

  // Tell mobile users why the share button is disabled, once, on arrival.
  useEffect(() => {
    if (!shareSupported && isLikelyMobile()) {
      toast.push(t('room.mobileShareUnsupported'), 'info');
    }
    // Intentionally runs once per room entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shareSupported]);

  const stageParticipant = selectStageParticipant(state);
  const stageStream = stageParticipant
    ? stageParticipant.id === state.selfId
      ? session.localScreenStream
      : (state.remoteStreams[stageParticipant.id] ?? null)
    : null;

  const otherSharers = useMemo(
    () =>
      selectSharers(state)
        .filter((participant) => participant.id !== stageParticipant?.id)
        .map((participant) => ({
          participant,
          stream:
            participant.id === state.selfId
              ? session.localScreenStream
              : (state.remoteStreams[participant.id] ?? null),
        })),
    [state, stageParticipant?.id, session.localScreenStream],
  );

  const orderedParticipants = useMemo(() => selectOrderedParticipants(state), [state]);

  const streamOnStage = selectStreamOnStage(state);

  const onPickSource = useCallback((mode: StreamModalMode) => {
    setStreamModalMode(mode);
    setStreamModalOpen(true);
  }, []);

  const onStopStream = useCallback(() => {
    void session.stopStream();
  }, [session]);

  const onStreamError = useCallback(
    (failure: StreamFailure) => {
      toast.push(
        t(
          failure === 'blocked'
            ? 'error.streamBlocked'
            : failure === 'unsupported'
              ? 'error.streamUnsupported'
              : 'error.streamUnreachable',
        ),
        'error',
      );
      // Only the controller tears it down, so one failure does not clear the
      // stage for everyone when a single viewer cannot reach the source.
      if (session.canControlStream) void session.stopStream();
    },
    [toast, t, session],
  );

  const onToggleShare = useCallback(() => {
    if (session.isSharing) session.stopShare();
    else void session.startShare();
  }, [session]);

  /**
   * Watching a page together is the ordinary screen share with the picker
   * nudged toward tabs. It runs through the same permission check, the same
   * WebRTC transport, and the same stage — there is no second sharing path.
   */
  const onShareTab = useCallback(() => {
    if (session.isSharing) session.stopShare();
    void session.startShare({ preferTab: true });
  }, [session]);

  const onCopyCode = useCallback(
    (ok: boolean) => {
      toast.push(ok ? t('toast.codeCopied') : t('toast.copyFailed'), ok ? 'success' : 'error');
    },
    [toast, t],
  );

  return (
    <div className="flex h-full flex-col">
      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-ink-800 bg-ink-900 px-3 py-2.5 sm:px-4">
        <div className="flex min-w-0 items-center gap-3">
          <Wordmark size="sm" className="hidden sm:inline" />
          <CopyButton
            value={state.code}
            label={state.code}
            variant="ghost"
            onResult={onCopyCode}
            className="!px-2 !py-1.5 font-mono text-xs tracking-wide"
          />
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {state.status === 'reconnecting' && (
            <span className="mr-1 hidden text-xs text-signal-warn sm:inline">
              {t('room.reconnecting')}
            </span>
          )}
          <span className="hidden text-xs text-chalk-600 sm:inline">
            {t('room.peopleCount', { count: state.participants.length })}
          </span>
          <ConnectionBadge
            quality={session.quality}
            stats={session.stats}
            activeRungLabel={session.activeRungLabel}
          />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/*
          Stage and chat stack on phones and sit side by side from lg up. Chat
          is a sibling of the stage rather than an overlay, so opening it
          shrinks the picture instead of hiding it — that is what makes
          chatting during a film possible on a phone.
        */}
        <div className="flex min-w-0 flex-1 flex-col lg:flex-row">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <Stage
              stream={state.stream}
              streamOnStage={streamOnStage}
              canControlStream={session.canControlStream}
              onStreamPlayback={session.reportStreamPlayback}
              onStreamError={onStreamError}
              stageParticipant={stageParticipant}
              stageStream={stageStream}
              otherSharers={otherSharers}
              selfId={state.selfId}
              canShare={session.canShare}
              isHost={session.isHost}
              onPin={session.setPinned}
            />
          </div>

          <ChatPanel
            open={chatOpen}
            onClose={() => setRail('none')}
            messages={state.messages}
            participants={orderedParticipants}
            selfId={state.selfId}
            hostId={state.hostId}
            onSend={session.sendChat}
          />
        </div>

        {/* Participant management is a task, not something you do while
            watching, so it stays an overlay on small screens. */}
        <ParticipantsPanel
          open={participantsOpen}
          onClose={() => setRail('none')}
          participants={orderedParticipants}
          selfId={state.selfId}
          hostId={state.hostId}
          isHost={session.isHost}
          actions={session.hostActions}
        />
      </div>

      <ControlBar
        micOn={session.micOn}
        onToggleMic={() => session.setMicOn(!session.micOn)}
        speakerOn={speakerOn}
        onToggleSpeaker={() => setSpeakerOn((current) => !current)}
        isSharing={session.isSharing}
        canShare={session.canShare}
        shareSupported={shareSupported}
        onToggleShare={onToggleShare}
        streamActive={state.stream !== null}
        canControlStream={session.canControlStream}
        onStopStream={onStopStream}
        onPickSource={onPickSource}
        participantCount={state.participants.length}
        participantsOpen={participantsOpen}
        onToggleParticipants={() => toggleRail('participants')}
        chatOpen={chatOpen}
        unreadCount={unreadCount}
        onToggleChat={() => toggleRail('chat')}
        onOpenSettings={() => setSettingsOpen(true)}
        onLeave={onLeave}
        pushToTalk={audio.pushToTalk}
        pushToTalkKey={audio.pushToTalkKey}
        talking={talking}
      />

      <StreamModal
        open={streamModalOpen}
        mode={streamModalMode}
        onModeChange={setStreamModalMode}
        onClose={() => setStreamModalOpen(false)}
        canShare={session.canShare}
        onStart={session.startStream}
        onLoadPlaylist={session.loadPlaylist}
        onShareTab={onShareTab}
      />

      <SettingsPanel
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        quality={quality}
        onQualityChange={onQualityChange}
        audio={audio}
        onAudioChange={onAudioChange}
        avatar={avatar}
        onAvatarChange={onAvatarChange}
        selfName={session.self?.name ?? ''}
        selfId={state.selfId}
        isHost={session.isHost}
        isSharing={session.isSharing}
        onRegenerateCode={() => void session.hostActions.regenerateCode()}
        onCloseRoom={() => void session.hostActions.closeRoom()}
      />

      {/*
        Audio elements for every peer, mounted outside the stage so a peer can
        be heard whether or not their screen is the one being shown.
      */}
      {Object.entries(state.remoteStreams).map(([peerId, stream]) => (
        <RemoteAudio
          key={peerId}
          stream={stream}
          muted={!speakerOn}
          outputDeviceId={audio.speakerId}
        />
      ))}
    </div>
  );
}
