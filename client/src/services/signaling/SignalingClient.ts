import { io, type Socket } from 'socket.io-client';
import {
  PROTOCOL_VERSION,
  type Ack,
  type ClientToServerEvents,
  type JoinedPayload,
  type ServerToClientEvents,
} from '@shared/protocol';

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/**
 * Resolves the signaling endpoint. In development the Vite dev server and the
 * signaling server are on different ports, so the URL is explicit. In
 * production the default is same-origin, which keeps deployment to one host
 * and avoids a CORS configuration step.
 */
export function signalingUrl(): string {
  const configured = import.meta.env.VITE_SIGNALING_URL;
  if (configured) return configured;
  return import.meta.env.DEV ? 'http://localhost:3001' : window.location.origin;
}

export function createSocket(): AppSocket {
  return io(signalingUrl(), {
    transports: ['websocket', 'polling'],
    // Rooms are ephemeral; a stale session should never be resumed silently.
    autoConnect: false,
    reconnection: true,
    reconnectionAttempts: 8,
    reconnectionDelay: 400,
    reconnectionDelayMax: 4_000,
    timeout: 8_000,
  });
}

/**
 * Promise wrapper over Socket.IO's callback-style acks, with a timeout so a
 * dropped connection surfaces as an error instead of a spinner that never
 * resolves.
 */
export function request<T>(
  socket: AppSocket,
  event: keyof ClientToServerEvents,
  payload?: unknown,
  timeoutMs = 10_000,
): Promise<Ack<T>> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: Ack<T>) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(result);
    };

    const timer = window.setTimeout(() => finish({ ok: false, error: 'SERVER_ERROR' }), timeoutMs);

    const args: unknown[] = payload === undefined ? [] : [payload];
    // Socket.IO passes the ack as the final argument regardless of arity.
    (socket.emit as (event: string, ...args: unknown[]) => void)(event, ...args, (res: Ack<T>) =>
      finish(res ?? { ok: false, error: 'SERVER_ERROR' }),
    );
  });
}

export function createRoom(
  socket: AppSocket,
  name: string,
  avatar: string | null,
): Promise<Ack<JoinedPayload>> {
  return request<JoinedPayload>(socket, 'room:create', {
    name,
    avatar,
    protocolVersion: PROTOCOL_VERSION,
  });
}

export function joinRoom(
  socket: AppSocket,
  code: string,
  name: string,
  avatar: string | null,
): Promise<Ack<JoinedPayload>> {
  return request<JoinedPayload>(socket, 'room:join', {
    code,
    name,
    avatar,
    protocolVersion: PROTOCOL_VERSION,
  });
}

/** Waits for the socket to be connected, or reports a friendly failure. */
export function ensureConnected(socket: AppSocket, timeoutMs = 8_000): Promise<boolean> {
  if (socket.connected) return Promise.resolve(true);

  return new Promise((resolve) => {
    let settled = false;
    const cleanup = () => {
      window.clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('connect_error', onError);
    };
    const onConnect = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(true);
    };
    const onError = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(false);
    };
    const timer = window.setTimeout(onError, timeoutMs);

    socket.once('connect', onConnect);
    socket.once('connect_error', onError);
    socket.connect();
  });
}
