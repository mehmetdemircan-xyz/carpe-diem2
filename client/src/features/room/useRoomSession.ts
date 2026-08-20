import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type {
  ConnectionQuality,
  ErrorCode,
  Participant,
  PlaylistEntry,
  RoomStream,
  StreamKind,
} from '@shared/protocol';
import type { MessageKey } from '@/i18n/messages';
import { useT } from '@/i18n/I18nProvider';
import { useToast } from '@/components/ToastProvider';
import {
  createRoom,
  createSocket,
  ensureConnected,
  joinRoom,
  request,
  type AppSocket,
} from '@/services/signaling/SignalingClient';
import { PeerMesh, type MediaTransport } from '@/services/webrtc/PeerMesh';
import { captureMicrophone, captureScreen } from '@/services/webrtc/capture';
import { AdaptiveController } from '@/services/webrtc/adaptive';
import { VoiceActivityDetector } from '@/services/audio/VoiceActivityDetector';
import { AudioMixer } from '@/services/webrtc/AudioMixer';
import { StatsSampler } from '@/services/webrtc/stats';
import {
  EMPTY_STATS,
  QUALITY_LADDER,
  RESOLUTIONS,
  RESOLUTION_LABELS,
  describeRung,
  rungIndexFor,
  type AudioSettings,
  type ConnectionStats,
  type QualitySettings,
} from '@/types/media';
import {
  initialRoomState,
  roomReducer,
  selectCanControlStream,
  selectIsHost,
  selectSelf,
  type RoomState,
} from './roomReducer';

const STATS_INTERVAL_MS = 3_000;

/** Every ErrorCode has a matching message key; this makes that a type-level fact. */
function errorKey(code: ErrorCode): MessageKey {
  return `error.${code}`;
}

export interface JoinRequest {
  mode: 'create' | 'join';
  code?: string;
  name: string;
  avatar: string | null;
}

export interface StartShareOptions {
  /**
   * Nudges the browser's picker toward the tab list. Used when the person is
   * setting out to watch a web page together, where a tab is almost always
   * what they mean. It is a hint: they can still pick a window or a screen.
   */
  preferTab?: boolean;
}

export interface HostActions {
  grantShare: (targetId: string) => Promise<void>;
  revokeShare: (targetId: string) => Promise<void>;
  stopAllShares: () => Promise<void>;
  kick: (targetId: string) => Promise<void>;
  transferHost: (targetId: string) => Promise<void>;
  regenerateCode: () => Promise<void>;
  closeRoom: () => Promise<void>;
}

export interface RoomSession {
  state: RoomState;
  self: Participant | undefined;
  isHost: boolean;
  canShare: boolean;

  /**
   * Resolves with the room code so the caller can update the URL and the
   * screen in one batch. Reading it from `state` instead would see the value
   * from before the join, and the resulting mismatch is what a back-navigation
   * guard would misread as the user leaving.
   */
  join: (
    request: JoinRequest,
  ) => Promise<{ ok: true; code: string } | { ok: false; error: ErrorCode }>;
  leave: () => void;

  localScreenStream: MediaStream | null;
  isSharing: boolean;
  startShare: (options?: StartShareOptions) => Promise<void>;
  stopShare: () => void;

  micOn: boolean;
  setMicOn: (on: boolean) => void;
  micError: 'denied' | 'unavailable' | 'insecure' | null;

  stats: ConnectionStats;
  quality: ConnectionQuality;
  activeRungLabel: string;

  setPinned: (id: string | null) => void;
  setAvatar: (avatar: string | null) => Promise<void>;
  sendChat: (text: string) => Promise<boolean>;

  canControlStream: boolean;
  startStream: (url: string, title?: string, kind?: StreamKind) => Promise<boolean>;
  stopStream: () => Promise<void>;
  reportStreamPlayback: (playing: boolean, positionSeconds: number) => void;
  loadPlaylist: (
    url: string,
  ) => Promise<
    | { ok: true; entries: PlaylistEntry[]; truncated: boolean }
    | { ok: false; error: ErrorCode; detail?: string }
  >;

  hostActions: HostActions;
}

/**
 * Owns everything with a lifetime: the socket, the peer mesh, local media, and
 * the timers that drive adaptive quality. Components read from it and call
 * into it; none of them touch WebRTC directly.
 */
export function useRoomSession(
  quality: QualitySettings,
  audio: AudioSettings,
  pushToTalkActive: boolean,
): RoomSession {
  const t = useT();
  const toast = useToast();

  const [state, dispatch] = useReducer(roomReducer, initialRoomState);
  const [localScreenStream, setLocalScreenStream] = useState<MediaStream | null>(null);
  const [micOn, setMicOnState] = useState(false);
  const [micError, setMicError] = useState<'denied' | 'unavailable' | 'insecure' | null>(null);
  const [stats, setStats] = useState<ConnectionStats>(EMPTY_STATS);
  const [connectionQuality, setConnectionQuality] = useState<ConnectionQuality>('unknown');
  const [activeRungLabel, setActiveRungLabel] = useState('');

  const socketRef = useRef<AppSocket | null>(null);
  const meshRef = useRef<MediaTransport | null>(null);
  const screenStreamRef = useRef<MediaStream | null>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const samplerRef = useRef(new StatsSampler());
  const adaptiveRef = useRef<AdaptiveController | null>(null);
  /**
   * Created once and reused: an AudioContext per mic toggle would leak audio
   * threads across a long call.
   */
  const vadRef = useRef<VoiceActivityDetector | null>(null);
  /**
   * Carries microphone and captured tab audio on the single audio transceiver
   * the mesh holds. Its output track is created once and never swapped, so
   * turning tab audio on or off costs no renegotiation.
   */
  const mixerRef = useRef<AudioMixer | null>(null);
  const manualHintShownRef = useRef(false);

  // Settings are read inside long-lived callbacks and timers; refs keep those
  // callbacks stable so the mesh is never rebuilt just because a toggle moved.
  const qualityRef = useRef(quality);
  qualityRef.current = quality;
  const audioRef = useRef(audio);
  audioRef.current = audio;
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const tRef = useRef(t);
  tRef.current = t;
  const participantsRef = useRef(state.participants);
  participantsRef.current = state.participants;
  const selfIdRef = useRef(state.selfId);
  selfIdRef.current = state.selfId;

  const isHost = selectIsHost(state);
  const self = selectSelf(state);
  const canShare = self?.canShare ?? false;
  const isSharing = self?.sharing ?? false;

  /* ---------------------------------------------------------------------- */
  /* Local media teardown                                                    */
  /* ---------------------------------------------------------------------- */

  const releaseScreen = useCallback(() => {
    screenStreamRef.current?.getTracks().forEach((track) => track.stop());
    screenStreamRef.current = null;
    setLocalScreenStream(null);
    void meshRef.current?.setVideoTrack(null);

    // Tab audio dies with the capture that carried it.
    if (mixerRef.current) {
      mixerRef.current.setSource('display', null);
      const track = mixerRef.current.sourceCount > 0 ? mixerRef.current.outputTrack : null;
      void meshRef.current?.setAudioTrack(track);
    }
    samplerRef.current.reset();
    setStats(EMPTY_STATS);
    setActiveRungLabel('');
  }, []);

  const releaseMic = useCallback(() => {
    vadRef.current?.detach();
    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    micStreamRef.current = null;

    if (mixerRef.current) {
      mixerRef.current.setSource('mic', null);
      // Tab audio may still be playing, so this is not unconditionally null.
      const track = mixerRef.current.sourceCount > 0 ? mixerRef.current.outputTrack : null;
      void meshRef.current?.setAudioTrack(track);
    }
  }, []);

  /** Lazily built so a session that never turns on a mic never opens one. */
  const voiceDetector = useCallback((): VoiceActivityDetector => {
    if (!vadRef.current) {
      vadRef.current = new VoiceActivityDetector((speaking) => {
        socketRef.current?.emit('media:speaking', { speaking });
        // Applied locally too: the server's broadcast excludes the sender, so
        // your own halo would never light up otherwise.
        if (selfIdRef.current) {
          dispatch({ type: 'participant-updated', id: selfIdRef.current, patch: { speaking } });
        }
      });
    }
    return vadRef.current;
  }, []);

  /**
   * Publishes the mixed track when at least one source is live, and nothing at
   * all when none is. Sending a permanently silent track would work, but this
   * keeps a muted participant genuinely off the air.
   */
  const syncMixedAudio = useCallback(async () => {
    const mixer = mixerRef.current;
    if (!mixer) return;

    const track = mixer.sourceCount > 0 ? mixer.outputTrack : null;
    await meshRef.current?.setAudioTrack(track);
  }, []);

  const setAudioSource = useCallback(
    (kind: 'mic' | 'display', stream: MediaStream | null) => {
      if (!mixerRef.current) mixerRef.current = new AudioMixer();
      mixerRef.current.setSource(kind, stream);
      void syncMixedAudio();
    },
    [syncMixedAudio],
  );

  const teardown = useCallback(() => {
    releaseScreen();
    releaseMic();
    meshRef.current?.destroy();
    meshRef.current = null;

    const socket = socketRef.current;
    if (socket) {
      socket.removeAllListeners();
      socket.disconnect();
      socketRef.current = null;
    }
    adaptiveRef.current = null;
    vadRef.current?.detach();
    vadRef.current = null;
    mixerRef.current?.destroy();
    mixerRef.current = null;
    manualHintShownRef.current = false;
    setMicOnState(false);
  }, [releaseScreen, releaseMic]);

  // The only place teardown is guaranteed to run: leaving the page, closing
  // the tab, or unmounting the room.
  useEffect(() => teardown, [teardown]);

  /* ---------------------------------------------------------------------- */
  /* Joining                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Attaches every server-driven listener. Split out from `join` so the wiring
   * reads in one place, and so the mesh is the only thing `join` has to build.
   */
  const attachSocketListeners = useCallback(
    (socket: AppSocket, mesh: MediaTransport) => {
      socket.on('participant:joined', (participant) => {
        dispatch({ type: 'participant-joined', participant });
        // They will offer to us; we only prepare the connection.
        mesh.addPeer(participant.id, false);
        toastRef.current.push(tRef.current('toast.joined', { name: participant.name }));
      });

      socket.on('participant:left', ({ id }) => {
        mesh.removePeer(id);
        dispatch({ type: 'participant-left', id });
      });

      socket.on('participant:updated', ({ id, ...patch }) => {
        dispatch({ type: 'participant-updated', id, patch });
      });

      socket.on('room:state', (snapshot) => {
        dispatch({ type: 'snapshot', snapshot });
      });

      socket.on('room:code-changed', ({ code }) => {
        dispatch({ type: 'code-changed', code });
        window.history.replaceState({}, '', `/room/${code}`);
      });

      socket.on('signal', ({ from, body }) => {
        void mesh.acceptSignal(from, body);
      });

      socket.on('chat:message', (message) => {
        dispatch({ type: 'chat-message', message });
      });

      socket.on('stream:changed', (stream) => {
        dispatch({ type: 'stream-changed', stream });
      });

      socket.on('stream:sync', ({ playing, positionSeconds, updatedAt }) => {
        dispatch({ type: 'stream-sync', playing, positionSeconds, updatedAt });
      });

      socket.on('permission:changed', ({ canShare: allowed }) => {
        toastRef.current.push(
          allowed ? tRef.current('toast.youCanShare') : tRef.current('toast.youCannotShare'),
          allowed ? 'success' : 'warn',
        );
      });

      socket.on('share:force-stop', () => {
        releaseScreen();
        toastRef.current.push(tRef.current('toast.shareForceStopped'), 'warn');
      });

      socket.on('you:promoted', () => {
        toastRef.current.push(tRef.current('toast.youAreHost'), 'success');
      });

      socket.on('you:kicked', () => {
        dispatch({ type: 'ended', reason: 'kicked' });
      });

      socket.on('room:ended', ({ reason }) => {
        dispatch({ type: 'ended', reason });
      });

      socket.on('error', ({ code }) => {
        // Rate limiting is self-correcting; a toast would just add noise.
        if (code === 'RATE_LIMITED') return;
        toastRef.current.push(tRef.current(errorKey(code)), 'error');
      });

      socket.io.on('reconnect_attempt', () => dispatch({ type: 'reconnecting' }));
      socket.io.on('reconnect', () => {
        dispatch({ type: 'reconnected' });
        toastRef.current.push(tRef.current('toast.reconnected'), 'success');
      });
    },
    [releaseScreen],
  );

  const join = useCallback<RoomSession['join']>(
    async (req) => {
      teardown();
      dispatch({ type: 'reset' });
      dispatch({ type: 'connecting' });

      const socket = createSocket();
      socketRef.current = socket;

      const abandon = (error: ErrorCode) => {
        socket.removeAllListeners();
        socket.disconnect();
        socketRef.current = null;
        dispatch({ type: 'reset' });
        return { ok: false as const, error };
      };

      const connected = await ensureConnected(socket);
      if (!connected) return abandon('SERVER_ERROR');

      const response =
        req.mode === 'create'
          ? await createRoom(socket, req.name, req.avatar)
          : await joinRoom(socket, req.code ?? '', req.name, req.avatar);

      if (!response.ok) return abandon(response.error);

      const { self: me, room, initiateTo, iceServers } = response.data;

      const mesh = new PeerMesh(iceServers, {
        onSignal: (to, body) => socket.emit('signal', { to, body }),
        onRemoteStream: (peerId, stream) => dispatch({ type: 'remote-stream', peerId, stream }),
        onPeerStateChange: (peerId, peerState) => {
          if (peerState === 'closed' || peerState === 'failed') {
            dispatch({ type: 'remote-stream-gone', peerId });
          }
        },
        onPeerFailed: (peerId) => {
          // Read from the ref, not the join-time snapshot: by the time a peer
          // gives up, the participant list has usually moved on.
          const peer = participantsRef.current.find((p) => p.id === peerId);
          toastRef.current.push(
            tRef.current('error.peerFailed', { name: peer?.name ?? '?' }),
            'warn',
          );
        },
      });
      meshRef.current = mesh;

      dispatch({ type: 'joined', selfId: me.id, snapshot: room });

      attachSocketListeners(socket, mesh);

      // The newcomer offers to everyone already present; nobody offers back.
      for (const peerId of initiateTo) mesh.addPeer(peerId, true);

      return { ok: true, code: room.code };
    },
    [teardown, attachSocketListeners],
  );

  /* ---------------------------------------------------------------------- */
  /* Screen sharing                                                          */
  /* ---------------------------------------------------------------------- */

  const applyRung = useCallback(async (index: number, announce: 'up' | 'down' | null) => {
    const rung = QUALITY_LADDER[index];
    const track = screenStreamRef.current?.getVideoTracks()[0];
    if (!rung || !track) return;

    const size = RESOLUTIONS[rung.resolution];
    try {
      await track.applyConstraints({
        width: { max: size.width },
        height: { max: size.height },
        frameRate: { max: rung.frameRate },
      });
    } catch {
      // Some engines refuse mid-stream constraint changes. The bitrate and
      // framerate caps below still take effect, which is most of the benefit.
    }

    await meshRef.current?.applyVideoEncoding({
      maxBitrate: rung.maxBitrate,
      maxFramerate: rung.frameRate,
    });

    setActiveRungLabel(describeRung(rung));

    if (announce) {
      toastRef.current.push(
        tRef.current(announce === 'down' ? 'toast.qualityDropped' : 'toast.qualityRestored', {
          quality: describeRung(rung),
        }),
        announce === 'down' ? 'warn' : 'info',
      );
    }
  }, []);

  const startShare = useCallback(async (options: StartShareOptions = {}) => {
    const socket = socketRef.current;
    const mesh = meshRef.current;
    if (!socket || !mesh) return;

    const settings = qualityRef.current;
    const ceilingIndex = rungIndexFor(settings.resolution, settings.frameRate);
    const preferred = QUALITY_LADDER[ceilingIndex] ?? QUALITY_LADDER[1]!;

    const result = await captureScreen(
      settings.resolution,
      settings.frameRate,
      preferred,
      options.preferTab ?? false,
    );

    if (!result.ok) {
      const message =
        result.error.kind === 'denied'
          ? tRef.current('toast.shareCancelled')
          : result.error.kind === 'unsupported'
            ? tRef.current('error.screenShareUnsupported')
            : tRef.current('error.screenShareFailed');
      toastRef.current.push(message, result.error.kind === 'denied' ? 'info' : 'error');
      return;
    }

    // Ask permission only after capture succeeds, so a cancelled picker never
    // leaves the room showing us as sharing.
    const ack = await request<{ sharing: true }>(socket, 'share:start');
    if (!ack.ok) {
      result.value.stream.getTracks().forEach((track) => track.stop());
      toastRef.current.push(tRef.current(errorKey(ack.error)), 'error');
      return;
    }

    screenStreamRef.current = result.value.stream;
    setLocalScreenStream(result.value.stream);

    const videoTrack = result.value.stream.getVideoTracks()[0] ?? null;
    // "Stop sharing" in the browser's own bar ends the track, not our UI.
    if (videoTrack) {
      videoTrack.addEventListener('ended', () => stopShare(), { once: true });
    }

    await mesh.setVideoTrack(videoTrack);

    // Tab audio, when the person ticked the box in the browser's picker. It
    // joins the mix rather than replacing the microphone, so people can keep
    // talking over whatever is playing.
    if (result.value.audioTrack) {
      setAudioSource('display', result.value.stream);
      toastRef.current.push(tRef.current('toast.tabAudioOn'), 'info');
    }

    adaptiveRef.current = new AdaptiveController(ceilingIndex, ceilingIndex);
    samplerRef.current.reset();
    await applyRung(adaptiveRef.current.index, null);

    if (result.value.fellBackFrom) {
      toastRef.current.push(
        tRef.current('toast.resolutionFallback', {
          requested: RESOLUTION_LABELS[result.value.fellBackFrom],
          actual: `${result.value.actual.width}x${result.value.actual.height}`,
        }),
        'warn',
      );
    } else {
      toastRef.current.push(tRef.current('toast.shareStarted'), 'success');
    }
    // stopShare is stable; referencing it here would create a cycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyRung, setAudioSource]);

  const stopShare = useCallback(() => {
    if (!screenStreamRef.current) return;
    releaseScreen();
    adaptiveRef.current = null;
    socketRef.current?.emit('share:stop');
    toastRef.current.push(tRef.current('toast.shareStopped'));
  }, [releaseScreen]);

  /* ---------------------------------------------------------------------- */
  /* Microphone                                                              */
  /* ---------------------------------------------------------------------- */

  const setMicOn = useCallback(
    (on: boolean) => {
      setMicOnState(on);
      socketRef.current?.emit('media:mic', { micOn: on });

      if (!on) {
        releaseMic();
        return;
      }

      void (async () => {
        const result = await captureMicrophone(audioRef.current.microphoneId);
        if (!result.ok) {
          setMicError(result.error);
          setMicOnState(false);
          socketRef.current?.emit('media:mic', { micOn: false });
          const MIC_MESSAGE = {
            denied: 'toast.micDenied',
            insecure: 'toast.micInsecure',
            unavailable: 'toast.micUnavailable',
          } as const;
          toastRef.current.push(tRef.current(MIC_MESSAGE[result.error]), 'error');
          return;
        }

        setMicError(null);
        micStreamRef.current = result.stream;
        const track = result.stream.getAudioTracks()[0] ?? null;
        // Push-to-talk gates the track rather than the capture: re-acquiring
        // the device on every key press would add hundreds of ms of latency.
        if (track) track.enabled = !audioRef.current.pushToTalk;
        setAudioSource('mic', result.stream);

        // A disabled track emits silence, so push-to-talk needs no special
        // case here — the meter simply reads zero until the key is held.
        voiceDetector().attach(result.stream);
      })();
    },
    [releaseMic, voiceDetector, setAudioSource],
  );

  // Gate the live track as the PTT key goes down and up.
  useEffect(() => {
    const track = micStreamRef.current?.getAudioTracks()[0];
    if (!track) return;
    track.enabled = audio.pushToTalk ? pushToTalkActive : true;
  }, [audio.pushToTalk, pushToTalkActive, micOn]);

  // Switching input device mid-call re-acquires and swaps the track in place,
  // so peers never see a renegotiation.
  useEffect(() => {
    if (!micOn || !micStreamRef.current) return;
    let cancelled = false;

    void (async () => {
      const result = await captureMicrophone(audio.microphoneId);
      if (!result.ok || cancelled) {
        if (result.ok) result.stream.getTracks().forEach((track) => track.stop());
        return;
      }
      micStreamRef.current?.getTracks().forEach((track) => track.stop());
      micStreamRef.current = result.stream;
      const track = result.stream.getAudioTracks()[0] ?? null;
      if (track) track.enabled = audioRef.current.pushToTalk ? pushToTalkActive : true;
      setAudioSource('mic', result.stream);
      voiceDetector().attach(result.stream);
    })();

    return () => {
      cancelled = true;
    };
    // Intentionally keyed on the device only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audio.microphoneId]);

  /* ---------------------------------------------------------------------- */
  /* Stats + adaptive loop                                                   */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    if (state.status !== 'connected' && state.status !== 'reconnecting') return;

    const timer = window.setInterval(() => {
      void (async () => {
        const mesh = meshRef.current;
        if (!mesh) return;

        const reports = await mesh.getStats();
        if (reports.length === 0) return;

        const { stats: sampled, quality: verdict } = samplerRef.current.sample(reports);
        setStats(sampled);
        setConnectionQuality(verdict);
        socketRef.current?.emit('media:quality', { quality: verdict });

        // The server's broadcast deliberately excludes the sender, so apply
        // our own reading locally — otherwise your row is the only one in the
        // participants list without a quality dot.
        if (selfIdRef.current) {
          dispatch({ type: 'participant-updated', id: selfIdRef.current, patch: { quality: verdict } });
        }

        const controller = adaptiveRef.current;
        const settings = qualityRef.current;
        if (!controller || !screenStreamRef.current) return;

        if (!settings.adaptive) return;

        // The user picked a fixed rung. Respect it, but say something once so
        // a bad picture is not a mystery.
        if (settings.resolution !== 'auto') {
          if ((verdict === 'poor' || verdict === 'unstable') && !manualHintShownRef.current) {
            manualHintShownRef.current = true;
            toastRef.current.push(tRef.current('toast.qualityManualHint'), 'warn');
          }
          return;
        }

        const decision = controller.observe(verdict);
        if (decision.action === 'hold') return;
        void applyRung(decision.index, decision.action === 'step-down' ? 'down' : 'up');
      })();
    }, STATS_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [state.status, applyRung]);

  // A changed ceiling applies immediately to a share already in flight.
  useEffect(() => {
    const controller = adaptiveRef.current;
    if (!controller || !screenStreamRef.current) return;

    const ceiling = rungIndexFor(quality.resolution, quality.frameRate);
    controller.setCeiling(ceiling);
    if (quality.resolution !== 'auto') {
      controller.reset(ceiling);
      void applyRung(ceiling, null);
    }
    manualHintShownRef.current = false;
  }, [quality.resolution, quality.frameRate, applyRung]);

  /* ---------------------------------------------------------------------- */
  /* Stream playback                                                         */
  /* ---------------------------------------------------------------------- */

  const startStream = useCallback(async (url: string, title?: string, kind: StreamKind = 'media') => {
    const socket = socketRef.current;
    if (!socket) return false;

    const ack = await request<RoomStream>(socket, 'stream:start', {
      url,
      kind,
      ...(title ? { title } : {}),
    });
    if (!ack.ok) {
      toastRef.current.push(tRef.current(errorKey(ack.error)), 'error');
      return false;
    }
    toastRef.current.push(tRef.current('toast.streamStarted'), 'success');
    return true;
  }, []);

  const stopStream = useCallback(async () => {
    const socket = socketRef.current;
    if (!socket) return;

    const ack = await request<null>(socket, 'stream:stop');
    if (!ack.ok) {
      toastRef.current.push(tRef.current(errorKey(ack.error)), 'error');
      return;
    }
    toastRef.current.push(tRef.current('toast.streamStopped'));
  }, []);

  /** Fire-and-forget: a dropped sync tick is corrected by the next one. */
  const reportStreamPlayback = useCallback((playing: boolean, positionSeconds: number) => {
    socketRef.current?.emit('stream:control', { playing, positionSeconds });
  }, []);

  const loadPlaylist = useCallback(async (url: string) => {
    const socket = socketRef.current;
    if (!socket) return { ok: false as const, error: 'SERVER_ERROR' as ErrorCode };

    const ack = await request<{ entries: PlaylistEntry[]; truncated: boolean }>(
      socket,
      'stream:load-playlist',
      { url },
      // Comfortably beyond the server's own fetch timeout, so a slow host
      // produces the server's specific reason rather than a generic
      // client-side give-up that says nothing about what went wrong.
      30_000,
    );
    if (!ack.ok) return { ok: false as const, error: ack.error, detail: ack.detail };
    return { ok: true as const, entries: ack.data.entries, truncated: ack.data.truncated };
  }, []);

  /* ---------------------------------------------------------------------- */
  /* Host actions                                                            */
  /* ---------------------------------------------------------------------- */

  const hostActions = useMemo<HostActions>(() => {
    const send = async (
      event:
        | 'host:grant-share'
        | 'host:revoke-share'
        | 'host:kick'
        | 'host:transfer'
        | 'host:stop-all-shares'
        | 'host:regenerate-code'
        | 'host:close-room',
      payload?: { targetId: string },
    ) => {
      const socket = socketRef.current;
      if (!socket) return null;
      const ack = await request<unknown>(socket, event, payload);
      if (!ack.ok) {
        toastRef.current.push(tRef.current(errorKey(ack.error)), 'error');
        return null;
      }
      return ack.data;
    };

    return {
      grantShare: async (targetId) => {
        await send('host:grant-share', { targetId });
      },
      revokeShare: async (targetId) => {
        await send('host:revoke-share', { targetId });
      },
      stopAllShares: async () => {
        await send('host:stop-all-shares');
      },
      kick: async (targetId) => {
        await send('host:kick', { targetId });
      },
      transferHost: async (targetId) => {
        await send('host:transfer', { targetId });
      },
      regenerateCode: async () => {
        const data = (await send('host:regenerate-code')) as { code: string } | null;
        if (data?.code) {
          toastRef.current.push(tRef.current('toast.codeRegenerated', { code: data.code }), 'success');
        }
      },
      closeRoom: async () => {
        await send('host:close-room');
      },
    };
  }, []);

  const leave = useCallback(() => {
    socketRef.current?.emit('room:leave');
    teardown();
    dispatch({ type: 'reset' });
  }, [teardown]);

  const setPinned = useCallback((id: string | null) => dispatch({ type: 'pin', id }), []);

  /** Changing your picture mid-call updates everyone without a rejoin. */
  const setAvatar = useCallback(async (avatar: string | null) => {
    const socket = socketRef.current;
    if (!socket) return;
    const ack = await request<null>(socket, 'media:avatar', { avatar });
    if (!ack.ok) toastRef.current.push(tRef.current(errorKey(ack.error)), 'error');
  }, []);

  /**
   * Sent optimistically-free: the message only appears once the server echoes
   * it back to the room, so what you see in your own panel is exactly what
   * everyone else got.
   */
  const sendChat = useCallback(async (text: string) => {
    const socket = socketRef.current;
    const trimmed = text.trim();
    if (!socket || !trimmed) return false;

    const ack = await request<null>(socket, 'chat:send', { text: trimmed });
    if (!ack.ok) {
      if (ack.error !== 'EMPTY_MESSAGE') {
        toastRef.current.push(tRef.current(errorKey(ack.error)), 'error');
      }
      return false;
    }
    return true;
  }, []);

  return {
    state,
    self,
    isHost,
    canShare,
    join,
    leave,
    localScreenStream,
    isSharing,
    startShare,
    stopShare,
    micOn,
    setMicOn,
    micError,
    stats,
    quality: connectionQuality,
    activeRungLabel,
    setPinned,
    setAvatar,
    sendChat,
    canControlStream: selectCanControlStream(state),
    startStream,
    stopStream,
    reportStreamPlayback,
    loadPlaylist,
    hostActions,
  };
}
