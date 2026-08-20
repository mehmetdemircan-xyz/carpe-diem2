import {
  MAX_CHAT_HISTORY,
  type ChatMessage,
  type Participant,
  type RoomSnapshot,
  type RoomStream,
} from '@shared/protocol';

/**
 * All room state in one reducer.
 *
 * Participants live in an array rather than a Map so that React's rendering
 * path stays plain-value comparisons, and every action returns a new array
 * only when something actually changed — an unrelated `participant:updated`
 * must not re-render the whole panel.
 */
export interface RoomState {
  status: 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'ended';
  code: string;
  selfId: string;
  hostId: string;
  participants: Participant[];
  /** peerId -> the stream carrying their screen. */
  remoteStreams: Record<string, MediaStream>;
  /** Session-local transcript. The server stores nothing. */
  messages: ChatMessage[];
  /** A URL every client plays itself; null when the stage is screen shares. */
  stream: RoomStream | null;
  /** Which sharer occupies the main stage. Null means "first available". */
  pinnedId: string | null;
  endedReason: string | null;
}

export const initialRoomState: RoomState = {
  status: 'idle',
  code: '',
  selfId: '',
  hostId: '',
  participants: [],
  remoteStreams: {},
  messages: [],
  stream: null,
  pinnedId: null,
  endedReason: null,
};

export type RoomAction =
  | { type: 'connecting' }
  | { type: 'joined'; selfId: string; snapshot: RoomSnapshot }
  | { type: 'snapshot'; snapshot: RoomSnapshot }
  | { type: 'code-changed'; code: string }
  | { type: 'participant-joined'; participant: Participant }
  | { type: 'participant-left'; id: string }
  | { type: 'participant-updated'; id: string; patch: Partial<Participant> }
  | { type: 'remote-stream'; peerId: string; stream: MediaStream }
  | { type: 'remote-stream-gone'; peerId: string }
  | { type: 'chat-message'; message: ChatMessage }
  | { type: 'stream-changed'; stream: RoomStream | null }
  | { type: 'stream-sync'; playing: boolean; positionSeconds: number; updatedAt: number }
  | { type: 'pin'; id: string | null }
  | { type: 'reconnecting' }
  | { type: 'reconnected' }
  | { type: 'ended'; reason: string }
  | { type: 'reset' };

export function roomReducer(state: RoomState, action: RoomAction): RoomState {
  switch (action.type) {
    case 'connecting':
      return { ...state, status: 'connecting', endedReason: null };

    case 'joined':
      return {
        ...state,
        status: 'connected',
        selfId: action.selfId,
        code: action.snapshot.code,
        hostId: action.snapshot.hostId,
        participants: action.snapshot.participants,
        // A late joiner picks up whatever is already on the stage.
        stream: action.snapshot.stream,
        endedReason: null,
      };

    case 'snapshot':
      return {
        ...state,
        code: action.snapshot.code,
        hostId: action.snapshot.hostId,
        participants: action.snapshot.participants,
        stream: action.snapshot.stream,
      };

    case 'code-changed':
      return { ...state, code: action.code };

    case 'participant-joined': {
      if (state.participants.some((p) => p.id === action.participant.id)) return state;
      return { ...state, participants: [...state.participants, action.participant] };
    }

    case 'participant-left': {
      if (!state.participants.some((p) => p.id === action.id)) return state;
      const remoteStreams = { ...state.remoteStreams };
      delete remoteStreams[action.id];
      return {
        ...state,
        participants: state.participants.filter((p) => p.id !== action.id),
        remoteStreams,
        pinnedId: state.pinnedId === action.id ? null : state.pinnedId,
      };
    }

    case 'participant-updated': {
      let changed = false;
      const participants = state.participants.map((participant) => {
        if (participant.id !== action.id) return participant;
        // Bail out when the patch is a no-op so React can skip the subtree.
        const isNoop = Object.entries(action.patch).every(
          ([key, value]) => participant[key as keyof Participant] === value,
        );
        if (isNoop) return participant;
        changed = true;
        return { ...participant, ...action.patch };
      });
      if (!changed) return state;

      const stoppedSharing = action.patch.sharing === false;
      return {
        ...state,
        participants,
        pinnedId: stoppedSharing && state.pinnedId === action.id ? null : state.pinnedId,
      };
    }

    case 'remote-stream': {
      if (state.remoteStreams[action.peerId] === action.stream) return state;
      return {
        ...state,
        remoteStreams: { ...state.remoteStreams, [action.peerId]: action.stream },
      };
    }

    case 'remote-stream-gone': {
      if (!(action.peerId in state.remoteStreams)) return state;
      const remoteStreams = { ...state.remoteStreams };
      delete remoteStreams[action.peerId];
      return { ...state, remoteStreams };
    }

    case 'chat-message': {
      // Socket.IO can redeliver on reconnect; ids make that idempotent.
      if (state.messages.some((message) => message.id === action.message.id)) return state;
      const next = [...state.messages, action.message];
      // Bounded so a long session cannot grow the transcript without limit.
      return {
        ...state,
        messages: next.length > MAX_CHAT_HISTORY ? next.slice(-MAX_CHAT_HISTORY) : next,
      };
    }

    case 'stream-changed':
      // Starting a stream clears a pin: the pin refers to a screen share, and
      // the stream now owns the stage.
      return { ...state, stream: action.stream, pinnedId: null };

    case 'stream-sync': {
      if (!state.stream) return state;
      // Ignore anything older than what we already applied — sync messages
      // can arrive out of order.
      if (action.updatedAt <= state.stream.updatedAt) return state;
      return {
        ...state,
        stream: {
          ...state.stream,
          playing: action.playing,
          positionSeconds: action.positionSeconds,
          updatedAt: action.updatedAt,
        },
      };
    }

    case 'pin':
      return { ...state, pinnedId: action.id };

    case 'reconnecting':
      return state.status === 'connected' ? { ...state, status: 'reconnecting' } : state;

    case 'reconnected':
      return state.status === 'reconnecting' ? { ...state, status: 'connected' } : state;

    case 'ended':
      return { ...state, status: 'ended', endedReason: action.reason };

    case 'reset':
      return initialRoomState;

    default:
      return state;
  }
}

/* -------------------------------------------------------------------------- */
/* Selectors — kept here so components never re-derive room rules themselves   */
/* -------------------------------------------------------------------------- */

export function selectSelf(state: RoomState): Participant | undefined {
  return state.participants.find((p) => p.id === state.selfId);
}

export function selectIsHost(state: RoomState): boolean {
  return state.selfId !== '' && state.hostId === state.selfId;
}

export function selectSharers(state: RoomState): Participant[] {
  return state.participants.filter((p) => p.sharing);
}

/** The participant whose screen belongs on the main stage right now. */
export function selectStageParticipant(state: RoomState): Participant | null {
  const sharers = selectSharers(state);
  if (sharers.length === 0) return null;
  if (state.pinnedId) {
    const pinned = sharers.find((p) => p.id === state.pinnedId);
    if (pinned) return pinned;
  }
  // Prefer somebody else's screen: watching your own is rarely the point.
  return sharers.find((p) => p.id !== state.selfId) ?? sharers[0] ?? null;
}

/**
 * The stream owns the stage whenever one is running, unless the viewer has
 * explicitly pinned somebody's screen share instead.
 */
export function selectStreamOnStage(state: RoomState): boolean {
  return state.stream !== null && state.pinnedId === null;
}

export function selectCanControlStream(state: RoomState): boolean {
  if (!state.stream) return false;
  return state.stream.startedBy === state.selfId || state.hostId === state.selfId;
}

export function selectOrderedParticipants(state: RoomState): Participant[] {
  return [...state.participants].sort((a, b) => {
    if (a.role !== b.role) return a.role === 'host' ? -1 : 1;
    if (a.sharing !== b.sharing) return a.sharing ? -1 : 1;
    return a.joinedAt - b.joinedAt;
  });
}
