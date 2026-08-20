/**
 * Server-side view of the wire protocol. Everything the client and server
 * agree on lives in shared/src/protocol.ts; this file only adds the pieces
 * that never leave the server process.
 */
export * from '@shared/protocol';

/** No horizontal scaling yet — a Redis adapter would populate this. */
export interface InterServerEvents {
  ping: () => void;
}

/** Per-socket state Socket.IO carries for us. */
export interface SocketData {
  roomCode?: string | undefined;
}
