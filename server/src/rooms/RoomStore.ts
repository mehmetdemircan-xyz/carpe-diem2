import {
  MAX_AVATAR_LENGTH,
  MAX_CHAT_LENGTH,
  MAX_CONCURRENT_SHARES,
  MAX_DISPLAY_NAME_LENGTH,
  MAX_PARTICIPANTS,
  MAX_STREAM_TITLE_LENGTH,
  type ConnectionQuality,
  type Participant,
  type RoomSnapshot,
  type RoomStream,
  type StreamKind,
} from '@shared/protocol';
import { config } from '../config.js';
import { generateRoomCode } from './codes.js';

export interface Room {
  code: string;
  hostId: string;
  createdAt: number;
  emptySince: number | null;
  participants: Map<string, Participant>;
  /** At most one stream on the stage at a time. */
  stream: RoomStream | null;
}

export type RoomSweepReason = 'empty' | 'expired';

/**
 * In-memory authority for every room. Deliberately not a database: rooms are
 * ephemeral by design and nothing here is worth persisting. Swapping this for
 * Redis later only requires making these methods async.
 */
export class RoomStore {
  private readonly rooms = new Map<string, Room>();
  /** socketId -> room code, so leave/disconnect is O(1). */
  private readonly membership = new Map<string, string>();

  get roomCount(): number {
    return this.rooms.size;
  }

  get participantCount(): number {
    return this.membership.size;
  }

  getRoom(code: string): Room | undefined {
    return this.rooms.get(code);
  }

  getRoomOf(socketId: string): Room | undefined {
    const code = this.membership.get(socketId);
    return code ? this.rooms.get(code) : undefined;
  }

  createRoom(
    hostSocketId: string,
    rawName: string,
    rawAvatar: unknown,
  ): { room: Room; self: Participant } {
    let code = generateRoomCode();
    // Collisions are astronomically unlikely, but a loop costs nothing.
    while (this.rooms.has(code)) code = generateRoomCode();

    const room: Room = {
      code,
      hostId: hostSocketId,
      createdAt: Date.now(),
      emptySince: null,
      participants: new Map(),
      stream: null,
    };

    const self = this.makeParticipant(hostSocketId, rawName, 'host', rawAvatar);
    room.participants.set(hostSocketId, self);
    this.rooms.set(code, room);
    this.membership.set(hostSocketId, code);

    return { room, self };
  }

  joinRoom(
    room: Room,
    socketId: string,
    rawName: string,
    rawAvatar: unknown,
  ): { ok: true; self: Participant } | { ok: false; error: 'ROOM_FULL' } {
    if (room.participants.size >= MAX_PARTICIPANTS) {
      return { ok: false, error: 'ROOM_FULL' };
    }

    const self = this.makeParticipant(socketId, rawName, 'guest', rawAvatar);
    room.participants.set(socketId, self);
    room.emptySince = null;
    this.membership.set(socketId, room.code);

    return { ok: true, self };
  }

  /**
   * Removes a participant. Returns the room they were in plus whether host
   * duties moved to somebody else, so the caller can broadcast accordingly.
   */
  leaveRoom(
    socketId: string,
  ): { room: Room; newHostId: string | null; roomIsEmpty: boolean } | null {
    const room = this.getRoomOf(socketId);
    if (!room) return null;

    room.participants.delete(socketId);
    this.membership.delete(socketId);

    let newHostId: string | null = null;
    if (room.hostId === socketId && room.participants.size > 0) {
      // Longest-tenured remaining participant inherits the room.
      const successor = [...room.participants.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
      if (successor) {
        successor.role = 'host';
        successor.canShare = true;
        room.hostId = successor.id;
        newHostId = successor.id;
      }
    }

    const roomIsEmpty = room.participants.size === 0;
    if (roomIsEmpty) {
      room.emptySince = Date.now();
    }

    return { room, newHostId, roomIsEmpty };
  }

  closeRoom(code: string): Room | undefined {
    const room = this.rooms.get(code);
    if (!room) return undefined;
    for (const id of room.participants.keys()) {
      this.membership.delete(id);
    }
    this.rooms.delete(code);
    return room;
  }

  /**
   * Rotates a room's code without disturbing anyone already inside. Useful
   * when a host suspects the old code leaked.
   */
  regenerateCode(room: Room): string {
    let next = generateRoomCode();
    while (this.rooms.has(next)) next = generateRoomCode();

    this.rooms.delete(room.code);
    room.code = next;
    this.rooms.set(next, room);
    for (const id of room.participants.keys()) {
      this.membership.set(id, next);
    }
    return next;
  }

  transferHost(room: Room, targetId: string): boolean {
    const target = room.participants.get(targetId);
    const current = room.participants.get(room.hostId);
    if (!target) return false;

    if (current) current.role = 'guest';
    target.role = 'host';
    target.canShare = true;
    room.hostId = targetId;
    return true;
  }

  /** Screen-share slots are capped so a mesh room cannot melt a laptop. */
  canStartShare(room: Room, participant: Participant): boolean {
    if (!participant.canShare) return false;
    if (participant.sharing) return true;
    const active = [...room.participants.values()].filter((p) => p.sharing).length;
    return active < MAX_CONCURRENT_SHARES;
  }

  startStream(
    room: Room,
    starterId: string,
    url: string,
    rawTitle: string | null,
    kind: StreamKind,
  ): RoomStream {
    room.stream = {
      url,
      kind,
      title: rawTitle ? sanitizeStreamTitle(rawTitle) : null,
      startedBy: starterId,
      startedAt: Date.now(),
      playing: true,
      positionSeconds: 0,
      updatedAt: Date.now(),
    };
    return room.stream;
  }

  stopStream(room: Room): void {
    room.stream = null;
  }

  /**
   * Whoever started the stream keeps control of it, and the host can always
   * take over — otherwise a stream would be stuck if its starter went quiet.
   */
  canControlStream(room: Room, socketId: string): boolean {
    if (!room.stream) return false;
    return room.stream.startedBy === socketId || room.hostId === socketId;
  }

  updateStreamPlayback(room: Room, playing: boolean, positionSeconds: number): RoomStream | null {
    if (!room.stream) return null;
    room.stream.playing = playing;
    room.stream.positionSeconds = Math.max(0, positionSeconds);
    room.stream.updatedAt = Date.now();
    return room.stream;
  }

  setQuality(socketId: string, quality: ConnectionQuality): Participant | null {
    const room = this.getRoomOf(socketId);
    const participant = room?.participants.get(socketId);
    if (!participant) return null;
    participant.quality = quality;
    return participant;
  }

  /** Rooms that should be torn down, with the reason to report to clients. */
  collectExpiredRooms(now = Date.now()): Array<{ room: Room; reason: RoomSweepReason }> {
    const expired: Array<{ room: Room; reason: RoomSweepReason }> = [];
    for (const room of this.rooms.values()) {
      if (now - room.createdAt > config.roomMaxLifetimeMs) {
        expired.push({ room, reason: 'expired' });
      } else if (room.emptySince !== null && now - room.emptySince > config.emptyRoomGraceMs) {
        expired.push({ room, reason: 'empty' });
      }
    }
    return expired;
  }

  snapshot(room: Room): RoomSnapshot {
    return {
      code: room.code,
      hostId: room.hostId,
      createdAt: room.createdAt,
      participants: [...room.participants.values()],
      maxParticipants: MAX_PARTICIPANTS,
      stream: room.stream,
    };
  }

  private makeParticipant(
    id: string,
    rawName: string,
    role: 'host' | 'guest',
    rawAvatar: unknown,
  ): Participant {
    return {
      id,
      name: sanitizeDisplayName(rawName),
      role,
      // The host can always share. Guests start as viewers, by design.
      canShare: role === 'host',
      sharing: false,
      micOn: false,
      speaking: false,
      avatar: sanitizeAvatar(rawAvatar),
      quality: 'unknown',
      joinedAt: Date.now(),
    };
  }
}

/**
 * Display names are rendered in other people's browsers. React escapes markup
 * for us, so this guards against what React will happily render anyway:
 * C0/C1 control codes, zero-width characters and bidi overrides (used to spoof
 * another participant's name), plus runaway length.
 */
const UNSAFE_CODEPOINT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00, 0x1f], // C0 controls
  [0x7f, 0x9f], // DEL + C1 controls
  [0x200b, 0x200f], // zero-width space .. right-to-left mark
  [0x202a, 0x202e], // bidi embedding / override
  [0x2066, 0x2069], // bidi isolates
  [0xfeff, 0xfeff], // zero-width no-break space
];

function stripUnsafeCharacters(input: string): string {
  let out = '';
  for (const char of input) {
    const codePoint = char.codePointAt(0) ?? 0;
    const blocked = UNSAFE_CODEPOINT_RANGES.some(([lo, hi]) => codePoint >= lo && codePoint <= hi);
    if (!blocked) out += char;
  }
  return out;
}

export function sanitizeDisplayName(raw: unknown): string {
  if (typeof raw !== 'string') return 'Guest';

  const cleaned = stripUnsafeCharacters(raw)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_DISPLAY_NAME_LENGTH);

  return cleaned.length > 0 ? cleaned : 'Guest';
}

/** A name is acceptable as long as something survives sanitizing. */
export function isValidDisplayName(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  return stripUnsafeCharacters(raw).trim().length > 0;
}

/**
 * Chat text gets the same treatment as display names, plus a longer clamp.
 * Newlines collapse to spaces: a single-line bubble cannot be used to push
 * the rest of the conversation off everyone else's screen.
 */
export function sanitizeChatText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return stripUnsafeCharacters(raw)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_CHAT_LENGTH);
}

/** Titles ride along with the stream and render in everyone's UI. */
export function sanitizeStreamTitle(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = stripUnsafeCharacters(raw)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_STREAM_TITLE_LENGTH);
  return cleaned.length > 0 ? cleaned : null;
}

/**
 * Validates an avatar data URL before it is handed to every other browser in
 * the room.
 *
 * Only raster formats are accepted. SVG is excluded deliberately: it can carry
 * script, and while an <img> will not execute it, the format buys nothing here
 * because the client re-encodes every picture to JPEG anyway.
 */
const AVATAR_PREFIX = /^data:image\/(png|jpeg|webp);base64,/;
const BASE64_BODY = /^[A-Za-z0-9+/]+={0,2}$/;

export function sanitizeAvatar(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;

  const value = raw.trim();
  if (value.length === 0 || value.length > MAX_AVATAR_LENGTH) return null;

  const match = AVATAR_PREFIX.exec(value);
  if (!match) return null;

  const body = value.slice(match[0].length);
  // A short body is not a picture; a malformed one is not base64 at all.
  if (body.length < 32 || !BASE64_BODY.test(body)) return null;

  return value;
}
