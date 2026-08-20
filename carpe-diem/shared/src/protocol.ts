/**
 * Wire protocol shared by the CARPE Diem. client and signaling server.
 *
 * This file is the single source of truth for every socket event. Both
 * packages compile against it, so a change here surfaces as a type error on
 * whichever side has not been updated.
 */

export const PROTOCOL_VERSION = 1;

/** Hard cap enforced by the server. Mesh topology degrades past this. */
export const MAX_PARTICIPANTS = 6;

/** Maximum simultaneous screen shares in one room. */
export const MAX_CONCURRENT_SHARES = 2;

export const MAX_DISPLAY_NAME_LENGTH = 24;

/**
 * Avatars travel inside the room snapshot as data URLs, so the cap is on the
 * encoded string. The client downscales to AVATAR_SIZE and re-encodes as JPEG
 * before sending, which lands well under this; the cap exists to stop a
 * hand-rolled client from pushing a megabyte into everyone else's memory.
 */
export const MAX_AVATAR_LENGTH = 32 * 1024;
export const AVATAR_SIZE = 96;

export const MAX_CHAT_LENGTH = 500;

/**
 * How many messages a client keeps in memory. The server keeps none: chat is
 * relayed, never stored, so a room's conversation exists only in the browsers
 * that were present for it.
 */
export const MAX_CHAT_HISTORY = 200;

/* -------------------------------------------------------------------------- */
/* Domain model                                                               */
/* -------------------------------------------------------------------------- */

export type ParticipantRole = 'host' | 'guest';

export type ConnectionQuality = 'excellent' | 'good' | 'unstable' | 'poor' | 'unknown';

export interface Participant {
  id: string;
  name: string;
  role: ParticipantRole;
  /** Server-authoritative: may this participant publish a screen track? */
  canShare: boolean;
  /** Server-authoritative: is this participant currently publishing? */
  sharing: boolean;
  /** Cosmetic state mirrored for the participants panel. */
  micOn: boolean;
  /** Voice activity, detected locally and broadcast on transitions only. */
  speaking: boolean;
  /** Optional data-URL portrait. Null means initials are drawn instead. */
  avatar: string | null;
  quality: ConnectionQuality;
  joinedAt: number;
}

export interface ChatMessage {
  id: string;
  /** Socket id of the sender, so clients can style their own messages. */
  from: string;
  /** Resolved server-side from room state — never taken from the payload. */
  name: string;
  text: string;
  at: number;
}

export const MAX_STREAM_URL_LENGTH = 2048;
export const MAX_STREAM_TITLE_LENGTH = 80;
export const MAX_PLAYLIST_ENTRIES = 2000;

/**
 * A stream playing on the room's stage.
 *
 * The URL is distributed and every client fetches the media itself, directly
 * from the source. Nothing streams through the signaling server or over
 * WebRTC — so the person who started it pays no upload cost, and the picture
 * is whatever the source serves rather than a re-encode.
 */
export type StreamKind = 'media' | 'embed';

export interface RoomStream {
  url: string;
  /**
   * `media` is played by a video element; `embed` is rendered in a sandboxed
   * iframe. An embed cannot be driven from outside its own origin, so nothing
   * tries to synchronise its playback — everyone controls their own copy.
   */
  kind: StreamKind;
  title: string | null;
  /** Socket id of whoever started it; they and the host may control it. */
  startedBy: string;
  startedAt: number;
  /** Playback state, mirrored so late joiners land at the right position. */
  playing: boolean;
  positionSeconds: number;
  /** When positionSeconds was last sampled, for drift correction. */
  updatedAt: number;
}

/** One channel from a parsed .m3u playlist. */
export interface PlaylistEntry {
  name: string;
  url: string;
  group: string | null;
}

export interface RoomSnapshot {
  code: string;
  hostId: string;
  createdAt: number;
  participants: Participant[];
  maxParticipants: number;
  stream: RoomStream | null;
}

/* -------------------------------------------------------------------------- */
/* Errors — codes only. The client owns the human-readable, localized copy.    */
/* -------------------------------------------------------------------------- */

export type ErrorCode =
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'ROOM_CLOSED'
  | 'INVALID_CODE'
  | 'INVALID_NAME'
  | 'NOT_IN_ROOM'
  | 'NOT_HOST'
  | 'NOT_ALLOWED_TO_SHARE'
  | 'SHARE_SLOTS_FULL'
  | 'EMPTY_MESSAGE'
  | 'INVALID_URL'
  | 'STREAM_ALREADY_RUNNING'
  | 'NOT_STREAM_CONTROLLER'
  | 'PLAYLIST_UNREACHABLE'
  | 'PLAYLIST_EMPTY'
  | 'TARGET_NOT_FOUND'
  | 'RATE_LIMITED'
  | 'PROTOCOL_MISMATCH'
  | 'SERVER_ERROR';

export type Ack<T> = { ok: true; data: T } | { ok: false; error: ErrorCode };

/* -------------------------------------------------------------------------- */
/* Signaling payloads                                                         */
/* -------------------------------------------------------------------------- */

export interface SessionDescriptionPayload {
  type: 'offer' | 'answer';
  sdp: string;
}

export interface IceCandidatePayload {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  usernameFragment?: string | null;
}

export type SignalBody =
  | { kind: 'description'; description: SessionDescriptionPayload }
  | { kind: 'candidate'; candidate: IceCandidatePayload };

export interface OutboundSignal {
  to: string;
  body: SignalBody;
}

export interface InboundSignal {
  from: string;
  body: SignalBody;
}

/* -------------------------------------------------------------------------- */
/* Client -> Server                                                           */
/* -------------------------------------------------------------------------- */

export interface CreateRoomRequest {
  name: string;
  avatar?: string | null;
  protocolVersion: number;
}

export interface JoinRoomRequest {
  code: string;
  name: string;
  avatar?: string | null;
  protocolVersion: number;
}

export interface JoinedPayload {
  self: Participant;
  room: RoomSnapshot;
  /** Peers this client must send an offer to. Newcomer always initiates. */
  initiateTo: string[];
  iceServers: RTCIceServerConfig[];
}

/** Mirror of RTCIceServer that is safe to send over the wire. */
export interface RTCIceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface ClientToServerEvents {
  'room:create': (req: CreateRoomRequest, ack: (res: Ack<JoinedPayload>) => void) => void;
  'room:join': (req: JoinRoomRequest, ack: (res: Ack<JoinedPayload>) => void) => void;
  'room:leave': () => void;

  signal: (payload: { to: string; body: SignalBody }) => void;

  'share:start': (ack: (res: Ack<{ sharing: true }>) => void) => void;
  'share:stop': () => void;

  'media:mic': (payload: { micOn: boolean }) => void;
  'media:speaking': (payload: { speaking: boolean }) => void;
  'media:avatar': (payload: { avatar: string | null }, ack: (res: Ack<null>) => void) => void;
  'media:quality': (payload: { quality: ConnectionQuality }) => void;

  'chat:send': (payload: { text: string }, ack: (res: Ack<null>) => void) => void;

  'stream:start': (
    payload: { url: string; title?: string; kind?: StreamKind },
    ack: (res: Ack<RoomStream>) => void,
  ) => void;
  'stream:stop': (ack: (res: Ack<null>) => void) => void;
  'stream:control': (payload: { playing: boolean; positionSeconds: number }) => void;
  /**
   * Playlists are fetched and parsed on the server. Doing it in the browser
   * would fail on CORS for most sources, and the server can enforce SSRF
   * protections that a browser fetch cannot.
   */
  'stream:load-playlist': (
    payload: { url: string },
    ack: (res: Ack<{ entries: PlaylistEntry[]; truncated: boolean }>) => void,
  ) => void;

  'host:grant-share': (payload: { targetId: string }, ack: (res: Ack<null>) => void) => void;
  'host:revoke-share': (payload: { targetId: string }, ack: (res: Ack<null>) => void) => void;
  'host:kick': (payload: { targetId: string }, ack: (res: Ack<null>) => void) => void;
  'host:transfer': (payload: { targetId: string }, ack: (res: Ack<null>) => void) => void;
  'host:stop-all-shares': (ack: (res: Ack<null>) => void) => void;
  'host:regenerate-code': (ack: (res: Ack<{ code: string }>) => void) => void;
  'host:close-room': (ack: (res: Ack<null>) => void) => void;
}

/* -------------------------------------------------------------------------- */
/* Server -> Client                                                           */
/* -------------------------------------------------------------------------- */

export type RoomEndReason = 'host_closed' | 'empty' | 'expired';

export interface ServerToClientEvents {
  'room:state': (snapshot: RoomSnapshot) => void;
  'room:code-changed': (payload: { code: string }) => void;
  'room:ended': (payload: { reason: RoomEndReason }) => void;

  'participant:joined': (participant: Participant) => void;
  'participant:left': (payload: { id: string }) => void;
  'participant:updated': (payload: { id: string } & Partial<Participant>) => void;

  signal: (payload: InboundSignal) => void;

  'chat:message': (message: ChatMessage) => void;

  /** Null means the stage went back to screen sharing. */
  'stream:changed': (stream: RoomStream | null) => void;
  'stream:sync': (payload: { playing: boolean; positionSeconds: number; updatedAt: number }) => void;

  /** Sent to a client whose share permission changed. */
  'permission:changed': (payload: { canShare: boolean; byHost: boolean }) => void;
  /** Server orders this client to tear down its outbound screen track. */
  'share:force-stop': (payload: { reason: 'host_revoked' | 'host_stopped_all' }) => void;

  'you:kicked': () => void;
  'you:promoted': () => void;

  error: (payload: { code: ErrorCode }) => void;
}
