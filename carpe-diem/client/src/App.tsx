import { useCallback, useEffect, useState } from 'react';
import type { ErrorCode } from '@shared/protocol';
import { useT } from '@/i18n/I18nProvider';
import type { MessageKey } from '@/i18n/messages';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Wordmark } from '@/components/Wordmark';
import { LandingPage, type LandingIntent } from '@/pages/LandingPage';
import { NameGate } from '@/pages/NameGate';
import { RoomCreated } from '@/pages/RoomCreated';
import { RoomPage } from '@/pages/RoomPage';
import { useRoomSession } from '@/features/room/useRoomSession';
import { usePushToTalk } from '@/features/audio/usePushToTalk';
import { usePersistentState } from '@/hooks/usePersistentState';
import { parseRoute, roomPath, useRoute } from '@/services/router';
import {
  DEFAULT_AUDIO,
  DEFAULT_QUALITY,
  type AudioSettings,
  type QualitySettings,
} from '@/types/media';

/**
 * Screens, in the order a user meets them. A tiny state machine rather than a
 * router with nested routes, because the transitions are all one-way and the
 * whole flow fits on one page.
 */
type Screen =
  | { name: 'landing' }
  | { name: 'name'; intent: LandingIntent }
  | { name: 'created'; code: string }
  | { name: 'room' }
  | { name: 'ended'; messageKey: MessageKey };

export function App() {
  const t = useT();
  const { route, navigate } = useRoute();

  const [quality, setQuality] = usePersistentState<QualitySettings>(
    'carpe.quality',
    DEFAULT_QUALITY,
    isQualitySettings,
  );
  const [audio, setAudio] = usePersistentState<AudioSettings>(
    'carpe.audio',
    DEFAULT_AUDIO,
    isAudioSettings,
  );
  const [rememberedName, setRememberedName] = usePersistentState<string>('carpe.name', '');
  // Kept locally so a returning user does not have to pick a picture again.
  const [rememberedAvatar, setRememberedAvatar] = usePersistentState<string | null>(
    'carpe.avatar',
    null,
    (value): value is string | null => value === null || typeof value === 'string',
  );

  const talking = usePushToTalk(audio.pushToTalk, audio.pushToTalkKey);
  const session = useRoomSession(quality, audio, talking);

  const [screen, setScreen] = useState<Screen>(() =>
    parseRoute(window.location.pathname).name === 'room'
      ? { name: 'name', intent: { mode: 'join', code: roomCodeFromLocation() } }
      : { name: 'landing' },
  );
  const [busy, setBusy] = useState(false);
  const [joinError, setJoinError] = useState<ErrorCode | null>(null);

  /* ---------------------------------------------------------------------- */
  /* Flow                                                                    */
  /* ---------------------------------------------------------------------- */

  const onIntent = useCallback((intent: LandingIntent) => {
    setJoinError(null);
    setScreen({ name: 'name', intent });
  }, []);

  const onSubmitName = useCallback(
    async (name: string, avatar: string | null, intent: LandingIntent) => {
      setBusy(true);
      setJoinError(null);
      setRememberedName(name);
      setRememberedAvatar(avatar);

      const result = await session.join({
        mode: intent.mode,
        code: intent.code,
        name,
        avatar,
      });
      setBusy(false);

      if (!result.ok) {
        setJoinError(result.error);
        return;
      }

      // URL and screen move together. Updating the address bar in a separate
      // effect would leave one render where the route says "home" and the
      // screen says "room", which the back-navigation guard below would read
      // as the user leaving.
      navigate(roomPath(result.code), true);
      setScreen(
        intent.mode === 'create' ? { name: 'created', code: result.code } : { name: 'room' },
      );
    },
    [session, setRememberedName, setRememberedAvatar, navigate],
  );

  // The server ended the room, or we were removed.
  useEffect(() => {
    if (session.state.status !== 'ended') return;
    const reason = session.state.endedReason;
    setScreen({
      name: 'ended',
      messageKey:
        reason === 'kicked'
          ? 'error.kicked'
          : reason === 'host_closed'
            ? 'error.roomEnded.host_closed'
            : reason === 'expired'
              ? 'error.roomEnded.expired'
              : 'error.roomEnded.empty',
    });
  }, [session.state.status, session.state.endedReason]);

  const goHome = useCallback(() => {
    session.leave();
    setScreen({ name: 'landing' });
    setJoinError(null);
    navigate('/');
  }, [session, navigate]);

  // Browser back out of a room should leave it, not strand a live connection.
  // Guarded on the room code so this only fires once the URL genuinely no
  // longer points at the room we are in.
  useEffect(() => {
    const inRoom = screen.name === 'room' || screen.name === 'created';
    if (!inRoom || !session.state.code) return;
    if (route.name === 'room' && route.code === session.state.code) return;
    goHome();
  }, [route, screen.name, session.state.code, goHome]);

  /* ---------------------------------------------------------------------- */
  /* Render                                                                  */
  /* ---------------------------------------------------------------------- */

  if (screen.name === 'ended') {
    return <Notice title={t(screen.messageKey)} actionLabel={t('error.backHome')} onAction={goHome} />;
  }

  if (screen.name === 'room') {
    return (
      <RoomPage
        session={session}
        quality={quality}
        onQualityChange={setQuality}
        audio={audio}
        onAudioChange={setAudio}
        avatar={rememberedAvatar}
        onAvatarChange={(next) => {
          setRememberedAvatar(next);
          void session.setAvatar(next);
        }}
        talking={talking}
        onLeave={goHome}
      />
    );
  }

  if (screen.name === 'created') {
    return (
      <RoomCreated
        code={screen.code || session.state.code}
        onEnter={() => setScreen({ name: 'room' })}
      />
    );
  }

  if (screen.name === 'name') {
    const intent = screen.intent;
    return (
      <>
        <NameGate
          initialName={rememberedName}
          initialAvatar={rememberedAvatar}
          roomCode={intent.mode === 'join' ? (intent.code ?? null) : null}
          busy={busy}
          onSubmit={(name, avatar) => void onSubmitName(name, avatar, intent)}
          onCancel={goHome}
        />
        {joinError && <InlineError message={t(`error.${joinError}` as MessageKey)} />}
      </>
    );
  }

  return <LandingPage onIntent={onIntent} busy={busy} />;
}

/* -------------------------------------------------------------------------- */

function roomCodeFromLocation(): string {
  const route = parseRoute(window.location.pathname);
  return route.name === 'room' ? route.code : '';
}

function Notice({
  title,
  actionLabel,
  onAction,
}: {
  title: string;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <header className="px-5 py-5 sm:px-8">
        <Wordmark size="md" />
      </header>
      <main className="flex flex-1 flex-col items-center justify-center gap-5 px-6 pb-24 text-center">
        <p className="max-w-sm text-sm text-chalk-200">{title}</p>
        <button type="button" onClick={onAction} className="btn-secondary">
          {actionLabel}
        </button>
      </main>
    </div>
  );
}

function InlineError({ message }: { message: string }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 flex justify-center px-6">
      <p
        role="alert"
        className="pointer-events-auto max-w-sm rounded-lg border border-signal-bad/40 bg-ink-850 px-4 py-2.5 text-center text-sm text-chalk-50"
      >
        {message}
      </p>
    </div>
  );
}

/* --- Validators for persisted settings ------------------------------------ */

function isQualitySettings(value: unknown): value is QualitySettings {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<QualitySettings>;
  return (
    typeof candidate.resolution === 'string' &&
    (typeof candidate.frameRate === 'number' || candidate.frameRate === 'auto') &&
    typeof candidate.adaptive === 'boolean'
  );
}

function isAudioSettings(value: unknown): value is AudioSettings {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<AudioSettings>;
  return (
    typeof candidate.pushToTalk === 'boolean' && typeof candidate.pushToTalkKey === 'string'
  );
}

export function AppWithBoundary() {
  const t = useT();
  return (
    <ErrorBoundary labels={{ title: t('error.crashed'), reload: t('error.reload') }}>
      <App />
    </ErrorBoundary>
  );
}
