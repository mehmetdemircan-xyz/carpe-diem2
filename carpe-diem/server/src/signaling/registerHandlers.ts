import { randomUUID } from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import {
  PROTOCOL_VERSION,
  type Ack,
  type ChatMessage,
  type ClientToServerEvents,
  type ConnectionQuality,
  type ErrorCode,
  type InterServerEvents,
  type JoinedPayload,
  type Participant,
  type PlaylistEntry,
  type RoomStream,
  type ServerToClientEvents,
  type SignalBody,
  type SocketData,
} from '../types.js';
import { loadPlaylist } from '../streams/playlist.js';
import { validateStreamUrl } from '../streams/urlGuard.js';
import { config, iceServers } from '../config.js';
import { normalizeRoomCode } from '../rooms/codes.js';
import {
  isValidDisplayName,
  sanitizeAvatar,
  sanitizeChatText,
  type Room,
  type RoomStore,
} from '../rooms/RoomStore.js';
import { createSocketBudget } from '../utils/rateLimit.js';

type IO = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

const fail = (error: ErrorCode): Ack<never> => ({ ok: false, error });
const succeed = <T>(data: T): Ack<T> => ({ ok: true, data });

/** Socket.IO will happily hand us a non-function if a client misbehaves. */
function safeAck<T>(ack: unknown): (res: Ack<T>) => void {
  return typeof ack === 'function' ? (ack as (res: Ack<T>) => void) : () => {};
}

function isSignalBody(body: unknown): body is SignalBody {
  if (typeof body !== 'object' || body === null) return false;
  const candidate = body as { kind?: unknown; description?: unknown; candidate?: unknown };

  if (candidate.kind === 'description') {
    const description = candidate.description as { type?: unknown; sdp?: unknown } | undefined;
    return (
      !!description &&
      (description.type === 'offer' || description.type === 'answer') &&
      typeof description.sdp === 'string' &&
      description.sdp.length < 100_000
    );
  }

  if (candidate.kind === 'candidate') {
    const ice = candidate.candidate as
      | { candidate?: unknown; sdpMid?: unknown; sdpMLineIndex?: unknown }
      | undefined;
    if (!ice || typeof ice.candidate !== 'string' || ice.candidate.length >= 4_000) return false;

    // RFC 8829: a candidate carries at least one of sdpMid / sdpMLineIndex.
    // Without either, no browser can apply it, so relaying is pure waste.
    const hasMid = typeof ice.sdpMid === 'string';
    const hasIndex = typeof ice.sdpMLineIndex === 'number';
    return hasMid || hasIndex;
  }

  return false;
}

export function registerHandlers(io: IO, socket: AppSocket, store: RoomStore): void {
  const budget = createSocketBudget(config.rateLimit);

  /* ---------------------------------------------------------------------- */
  /* Helpers scoped to this connection                                       */
  /* ---------------------------------------------------------------------- */

  /**
   * The single choke point for every privileged action. Nothing downstream
   * trusts a client-supplied role — authority is always re-derived from the
   * room the socket is actually in.
   */
  function requireHost(): { room: Room } | { error: ErrorCode } {
    const room = store.getRoomOf(socket.id);
    if (!room) return { error: 'NOT_IN_ROOM' };
    if (room.hostId !== socket.id) return { error: 'NOT_HOST' };
    return { room };
  }

  function broadcastUpdate(room: Room, id: string, patch: Record<string, unknown>): void {
    io.to(room.code).emit('participant:updated', { id, ...patch });
  }

  function stopShareFor(room: Room, participantId: string, reason: 'host_revoked' | 'host_stopped_all'): void {
    const participant = room.participants.get(participantId);
    if (!participant?.sharing) return;
    participant.sharing = false;
    broadcastUpdate(room, participantId, { sharing: false });
    io.to(participantId).emit('share:force-stop', { reason });
  }

  function admit(room: Room, self: Participant): JoinedPayload {
    void socket.join(room.code);
    socket.data.roomCode = room.code;

    // The newcomer offers to everyone already present. One-directional
    // initiation removes glare entirely — no polite/impolite tie-breaking.
    const initiateTo = [...room.participants.keys()].filter((id) => id !== socket.id);

    socket.to(room.code).emit('participant:joined', self);

    return {
      self,
      room: store.snapshot(room),
      initiateTo,
      iceServers: iceServers(),
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Room lifecycle                                                          */
  /* ---------------------------------------------------------------------- */

  socket.on('room:create', (req, rawAck) => {
    const ack = safeAck<JoinedPayload>(rawAck);

    if (!budget.joins.tryConsume()) return ack(fail('RATE_LIMITED'));
    if (req?.protocolVersion !== PROTOCOL_VERSION) return ack(fail('PROTOCOL_MISMATCH'));
    if (!isValidDisplayName(req?.name)) return ack(fail('INVALID_NAME'));
    if (store.getRoomOf(socket.id)) return ack(fail('SERVER_ERROR'));

    const { room, self } = store.createRoom(socket.id, req.name, req.avatar);
    ack(succeed(admit(room, self)));
  });

  socket.on('room:join', (req, rawAck) => {
    const ack = safeAck<JoinedPayload>(rawAck);

    if (!budget.joins.tryConsume()) return ack(fail('RATE_LIMITED'));
    if (req?.protocolVersion !== PROTOCOL_VERSION) return ack(fail('PROTOCOL_MISMATCH'));

    const code = normalizeRoomCode(req?.code);
    if (!code) return ack(fail('INVALID_CODE'));
    if (!isValidDisplayName(req?.name)) return ack(fail('INVALID_NAME'));
    if (store.getRoomOf(socket.id)) return ack(fail('SERVER_ERROR'));

    const room = store.getRoom(code);
    if (!room) return ack(fail('ROOM_NOT_FOUND'));

    const result = store.joinRoom(room, socket.id, req.name, req.avatar);
    if (!result.ok) return ack(fail(result.error));

    ack(succeed(admit(room, result.self)));
  });

  socket.on('room:leave', () => {
    handleDeparture();
  });

  /* ---------------------------------------------------------------------- */
  /* WebRTC signaling relay                                                  */
  /* ---------------------------------------------------------------------- */

  socket.on('signal', (payload) => {
    if (!budget.signals.tryConsume()) {
      socket.emit('error', { code: 'RATE_LIMITED' });
      return;
    }

    const room = store.getRoomOf(socket.id);
    if (!room) return;

    const to = payload?.to;
    // Relay only between two sockets that are provably in the same room. This
    // is what stops a client from probing or injecting SDP into other rooms.
    if (typeof to !== 'string' || !room.participants.has(to)) return;
    if (!isSignalBody(payload?.body)) return;

    io.to(to).emit('signal', { from: socket.id, body: payload.body });
  });

  /* ---------------------------------------------------------------------- */
  /* Screen sharing                                                          */
  /* ---------------------------------------------------------------------- */

  socket.on('share:start', (rawAck) => {
    const ack = safeAck<{ sharing: true }>(rawAck);
    if (!budget.actions.tryConsume()) return ack(fail('RATE_LIMITED'));

    const room = store.getRoomOf(socket.id);
    const self = room?.participants.get(socket.id);
    if (!room || !self) return ack(fail('NOT_IN_ROOM'));

    // The client also hides the button, but this is the check that counts.
    if (!self.canShare) return ack(fail('NOT_ALLOWED_TO_SHARE'));
    if (!store.canStartShare(room, self)) return ack(fail('SHARE_SLOTS_FULL'));

    self.sharing = true;
    broadcastUpdate(room, socket.id, { sharing: true });
    ack(succeed({ sharing: true as const }));
  });

  socket.on('share:stop', () => {
    if (!budget.actions.tryConsume()) return;
    const room = store.getRoomOf(socket.id);
    const self = room?.participants.get(socket.id);
    if (!room || !self || !self.sharing) return;

    self.sharing = false;
    broadcastUpdate(room, socket.id, { sharing: false });
  });

  /* ---------------------------------------------------------------------- */
  /* Stream playback                                                         */
  /* ---------------------------------------------------------------------- */

  socket.on('stream:start', (payload, rawAck) => {
    const ack = safeAck<RoomStream>(rawAck);
    if (!budget.actions.tryConsume()) return ack(fail('RATE_LIMITED'));

    const room = store.getRoomOf(socket.id);
    const self = room?.participants.get(socket.id);
    if (!room || !self) return ack(fail('NOT_IN_ROOM'));

    // Putting something on everyone's stage is the same privilege as sharing
    // a screen, so it reuses the same permission rather than inventing a
    // second one a host would have to manage separately.
    if (!self.canShare) return ack(fail('NOT_ALLOWED_TO_SHARE'));

    // Replacing someone else's stream would be a way to hijack the stage.
    if (room.stream && !store.canControlStream(room, socket.id)) {
      return ack(fail('STREAM_ALREADY_RUNNING'));
    }

    // This URL is loaded by every other participant's browser, so it is
    // checked before it is broadcast, not after.
    const validated = validateStreamUrl(payload?.url);
    if (!validated.ok) return ack(fail('INVALID_URL'));

    // The only two shapes the stage knows. Anything else is treated as media,
    // which fails visibly in the player rather than silently doing something
    // unexpected.
    const kind = payload?.kind === 'embed' ? 'embed' : 'media';
    const stream = store.startStream(room, socket.id, validated.url, payload?.title ?? null, kind);
    io.to(room.code).emit('stream:changed', stream);
    ack(succeed(stream));
  });

  socket.on('stream:stop', (rawAck) => {
    const ack = safeAck<null>(rawAck);
    if (!budget.actions.tryConsume()) return ack(fail('RATE_LIMITED'));

    const room = store.getRoomOf(socket.id);
    if (!room) return ack(fail('NOT_IN_ROOM'));
    if (!room.stream) return ack(succeed(null));
    if (!store.canControlStream(room, socket.id)) return ack(fail('NOT_STREAM_CONTROLLER'));

    store.stopStream(room);
    io.to(room.code).emit('stream:changed', null);
    ack(succeed(null));
  });

  socket.on('stream:control', (payload) => {
    // Embeds have no controllable timeline from outside their origin, so a
    // position for one is meaningless and is dropped rather than broadcast.
    // Not counted against the action budget: this fires on a timer to keep
    // followers in sync and carries no authority of its own.
    const room = store.getRoomOf(socket.id);
    if (!room?.stream || room.stream.kind === 'embed') return;
    if (!store.canControlStream(room, socket.id)) return;

    const position = Number(payload?.positionSeconds);
    if (!Number.isFinite(position)) return;

    const updated = store.updateStreamPlayback(room, Boolean(payload?.playing), position);
    if (!updated) return;

    socket.to(room.code).emit('stream:sync', {
      playing: updated.playing,
      positionSeconds: updated.positionSeconds,
      updatedAt: updated.updatedAt,
    });
  });

  socket.on('stream:load-playlist', (payload, rawAck) => {
    const ack = safeAck<{ entries: PlaylistEntry[]; truncated: boolean }>(rawAck);
    // Each call makes the server perform an outbound fetch, so it is charged
    // against the action budget.
    if (!budget.actions.tryConsume(3)) return ack(fail('RATE_LIMITED'));

    const room = store.getRoomOf(socket.id);
    const self = room?.participants.get(socket.id);
    if (!room || !self) return ack(fail('NOT_IN_ROOM'));
    if (!self.canShare) return ack(fail('NOT_ALLOWED_TO_SHARE'));

    void loadPlaylist(payload?.url).then((result) => {
      if (!result.ok) {
        ack(
          fail(
            result.reason === 'invalid-url'
              ? 'INVALID_URL'
              : result.reason === 'empty'
                ? 'PLAYLIST_EMPTY'
                : 'PLAYLIST_UNREACHABLE',
          ),
        );
        return;
      }
      ack(succeed({ entries: result.entries, truncated: result.truncated }));
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Presence state                                                          */
  /* ---------------------------------------------------------------------- */

  socket.on('media:mic', (payload) => {
    if (!budget.actions.tryConsume()) return;
    const room = store.getRoomOf(socket.id);
    const self = room?.participants.get(socket.id);
    if (!room || !self) return;

    const micOn = Boolean(payload?.micOn);
    if (self.micOn === micOn) return;
    self.micOn = micOn;

    // A muted participant cannot keep a stale "speaking" halo lit.
    if (!micOn && self.speaking) {
      self.speaking = false;
      broadcastUpdate(room, socket.id, { micOn, speaking: false });
      return;
    }
    broadcastUpdate(room, socket.id, { micOn });
  });

  /* ---------------------------------------------------------------------- */
  /* Chat                                                                    */
  /* ---------------------------------------------------------------------- */

  socket.on('chat:send', (payload, rawAck) => {
    const ack = safeAck<null>(rawAck);
    if (!budget.chat.tryConsume()) return ack(fail('RATE_LIMITED'));

    const room = store.getRoomOf(socket.id);
    const self = room?.participants.get(socket.id);
    if (!room || !self) return ack(fail('NOT_IN_ROOM'));

    const text = sanitizeChatText(payload?.text);
    if (!text) return ack(fail('EMPTY_MESSAGE'));

    // Nothing is stored. The message is relayed to whoever is in the room at
    // this instant and then forgotten, which is why a late joiner sees no
    // history — the server never had any to give.
    const message: ChatMessage = {
      id: randomUUID(),
      from: socket.id,
      // Resolved from room state, never from the payload: otherwise anyone
      // could post under another participant's name.
      name: self.name,
      text,
      at: Date.now(),
    };

    io.to(room.code).emit('chat:message', message);
    ack(succeed(null));
  });

  socket.on('media:speaking', (payload) => {
    // Charged against a dedicated bucket rather than `actions`: this fires on
    // every start and stop of speech, which is frequent but carries no
    // authority and must not eat the budget that host controls rely on.
    if (!budget.presence.tryConsume()) return;

    const room = store.getRoomOf(socket.id);
    const self = room?.participants.get(socket.id);
    if (!room || !self) return;

    // A muted microphone cannot be speaking, whatever the client claims.
    const speaking = Boolean(payload?.speaking) && self.micOn;
    if (self.speaking === speaking) return;

    self.speaking = speaking;
    // Only others need this; the speaker already knows.
    socket.to(room.code).emit('participant:updated', { id: socket.id, speaking });
  });

  socket.on('media:avatar', (payload, rawAck) => {
    const ack = safeAck<null>(rawAck);
    if (!budget.actions.tryConsume()) return ack(fail('RATE_LIMITED'));

    const room = store.getRoomOf(socket.id);
    const self = room?.participants.get(socket.id);
    if (!room || !self) return ack(fail('NOT_IN_ROOM'));

    // Null clears it; anything that fails validation is treated as clearing
    // rather than as an error, so a stale picture never sticks around.
    const avatar = payload?.avatar === null ? null : sanitizeAvatar(payload?.avatar);
    self.avatar = avatar;
    broadcastUpdate(room, socket.id, { avatar });
    ack(succeed(null));
  });

  socket.on('media:quality', (payload) => {
    // Deliberately not rate-limited through `actions`: this fires on a timer
    // and dropping it would leave stale indicators. It carries no authority.
    const allowed: ConnectionQuality[] = ['excellent', 'good', 'unstable', 'poor', 'unknown'];
    const quality = payload?.quality;
    if (!allowed.includes(quality)) return;

    const participant = store.setQuality(socket.id, quality);
    const room = store.getRoomOf(socket.id);
    if (participant && room) {
      socket.to(room.code).emit('participant:updated', { id: socket.id, quality });
    }
  });

  /* ---------------------------------------------------------------------- */
  /* Host controls                                                           */
  /* ---------------------------------------------------------------------- */

  socket.on('host:grant-share', (payload, rawAck) => {
    const ack = safeAck<null>(rawAck);
    if (!budget.actions.tryConsume()) return ack(fail('RATE_LIMITED'));

    const guard = requireHost();
    if ('error' in guard) return ack(fail(guard.error));

    const target = guard.room.participants.get(payload?.targetId ?? '');
    if (!target) return ack(fail('TARGET_NOT_FOUND'));

    target.canShare = true;
    broadcastUpdate(guard.room, target.id, { canShare: true });
    io.to(target.id).emit('permission:changed', { canShare: true, byHost: true });
    ack(succeed(null));
  });

  socket.on('host:revoke-share', (payload, rawAck) => {
    const ack = safeAck<null>(rawAck);
    if (!budget.actions.tryConsume()) return ack(fail('RATE_LIMITED'));

    const guard = requireHost();
    if ('error' in guard) return ack(fail(guard.error));

    const target = guard.room.participants.get(payload?.targetId ?? '');
    if (!target) return ack(fail('TARGET_NOT_FOUND'));
    // A host revoking their own permission would lock the room's controls.
    if (target.id === guard.room.hostId) return ack(fail('NOT_ALLOWED_TO_SHARE'));

    target.canShare = false;
    stopShareFor(guard.room, target.id, 'host_revoked');
    broadcastUpdate(guard.room, target.id, { canShare: false });
    io.to(target.id).emit('permission:changed', { canShare: false, byHost: true });
    ack(succeed(null));
  });

  socket.on('host:stop-all-shares', (rawAck) => {
    const ack = safeAck<null>(rawAck);
    if (!budget.actions.tryConsume()) return ack(fail('RATE_LIMITED'));

    const guard = requireHost();
    if ('error' in guard) return ack(fail(guard.error));

    for (const participant of guard.room.participants.values()) {
      if (participant.sharing) {
        stopShareFor(guard.room, participant.id, 'host_stopped_all');
      }
    }
    ack(succeed(null));
  });

  socket.on('host:kick', (payload, rawAck) => {
    const ack = safeAck<null>(rawAck);
    if (!budget.actions.tryConsume()) return ack(fail('RATE_LIMITED'));

    const guard = requireHost();
    if ('error' in guard) return ack(fail(guard.error));

    const targetId = payload?.targetId ?? '';
    if (targetId === socket.id) return ack(fail('TARGET_NOT_FOUND'));
    if (!guard.room.participants.has(targetId)) return ack(fail('TARGET_NOT_FOUND'));

    io.to(targetId).emit('you:kicked');

    const removal = store.leaveRoom(targetId);
    if (removal) {
      io.to(removal.room.code).emit('participant:left', { id: targetId });
    }
    // Force the socket out of the room channel so it stops receiving signals
    // even if the client ignores `you:kicked`.
    io.sockets.sockets.get(targetId)?.leave(guard.room.code);
    ack(succeed(null));
  });

  socket.on('host:transfer', (payload, rawAck) => {
    const ack = safeAck<null>(rawAck);
    if (!budget.actions.tryConsume()) return ack(fail('RATE_LIMITED'));

    const guard = requireHost();
    if ('error' in guard) return ack(fail(guard.error));

    const targetId = payload?.targetId ?? '';
    if (targetId === socket.id) return ack(fail('TARGET_NOT_FOUND'));
    if (!store.transferHost(guard.room, targetId)) return ack(fail('TARGET_NOT_FOUND'));

    io.to(guard.room.code).emit('room:state', store.snapshot(guard.room));
    io.to(targetId).emit('you:promoted');
    ack(succeed(null));
  });

  socket.on('host:regenerate-code', (rawAck) => {
    const ack = safeAck<{ code: string }>(rawAck);
    if (!budget.actions.tryConsume()) return ack(fail('RATE_LIMITED'));

    const guard = requireHost();
    if ('error' in guard) return ack(fail(guard.error));

    const previousCode = guard.room.code;
    const nextCode = store.regenerateCode(guard.room);

    // Move every socket to the new channel so relaying keeps working.
    for (const id of guard.room.participants.keys()) {
      const member = io.sockets.sockets.get(id);
      if (!member) continue;
      void member.leave(previousCode);
      void member.join(nextCode);
      member.data.roomCode = nextCode;
    }

    io.to(nextCode).emit('room:code-changed', { code: nextCode });
    ack(succeed({ code: nextCode }));
  });

  socket.on('host:close-room', (rawAck) => {
    const ack = safeAck<null>(rawAck);
    if (!budget.actions.tryConsume()) return ack(fail('RATE_LIMITED'));

    const guard = requireHost();
    if ('error' in guard) return ack(fail(guard.error));

    const code = guard.room.code;
    io.to(code).emit('room:ended', { reason: 'host_closed' });
    store.closeRoom(code);
    for (const member of io.sockets.adapter.rooms.get(code) ?? []) {
      io.sockets.sockets.get(member)?.leave(code);
    }
    ack(succeed(null));
  });

  /* ---------------------------------------------------------------------- */
  /* Teardown                                                                */
  /* ---------------------------------------------------------------------- */

  function handleDeparture(): void {
    const result = store.leaveRoom(socket.id);
    if (!result) return;

    const { room, newHostId } = result;
    void socket.leave(room.code);
    socket.data.roomCode = undefined;

    io.to(room.code).emit('participant:left', { id: socket.id });

    if (newHostId) {
      io.to(room.code).emit('room:state', store.snapshot(room));
      io.to(newHostId).emit('you:promoted');
    }
  }

  socket.on('disconnect', handleDeparture);
}
