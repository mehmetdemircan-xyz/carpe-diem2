import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from 'cors';
import express from 'express';
import { Server } from 'socket.io';
import { config, warnAboutProductionGaps } from './config.js';
import { RoomStore } from './rooms/RoomStore.js';
import { registerHandlers } from './signaling/registerHandlers.js';
import type {
  ClientToServerEvents,
  InterServerEvents,
  ServerToClientEvents,
  SocketData,
} from './types.js';

const log = (message: string, extra?: unknown) => {
  const line = `[carpe] ${new Date().toISOString()} ${message}`;
  if (extra === undefined) console.log(line);
  else console.log(line, extra);
};

const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: config.corsOrigins, credentials: false }));

const store = new RoomStore();

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    uptimeSeconds: Math.round(process.uptime()),
    rooms: store.roomCount,
    participants: store.participantCount,
  });
});

/**
 * Serve the built client from this same process when it is present.
 *
 * This is what lets `npm run build && npm start` deploy as one host: the
 * client defaults its signaling URL to the page's own origin, so a
 * single-origin deployment needs no CORS configuration at all.
 */
const clientDist = resolve(dirname(fileURLToPath(import.meta.url)), '../../client/dist');
if (existsSync(clientDist)) {
  app.use(
    express.static(clientDist, {
      // Hashed asset filenames can be cached hard; index.html must not be, or
      // a deploy leaves clients on a stale bundle.
      setHeaders: (res, path) => {
        if (path.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
        else res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      },
    }),
  );

  // SPA fallback so /room/ABCD-2345 is served by the app rather than 404ing.
  app.get(/^\/(?!socket\.io|health).*/, (_req, res) => {
    res.sendFile(join(clientDist, 'index.html'));
  });

  log(`serving client bundle from ${clientDist}`);
}

const httpServer = createServer(app);

const io = new Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>(
  httpServer,
  {
    cors: { origin: config.corsOrigins, methods: ['GET', 'POST'] },
    // Screen-share SDP is large; the default 1MB is plenty, but cap it
    // explicitly so a client cannot buffer arbitrary data on the server.
    maxHttpBufferSize: 512 * 1024,
    pingInterval: 20_000,
    pingTimeout: 25_000,
  },
);

io.on('connection', (socket) => {
  registerHandlers(io, socket, store);
});

/**
 * Rooms are only ever removed here. Doing it on a timer rather than on the
 * last disconnect gives someone who reloaded the page a grace period to come
 * back to a room that is still theirs.
 */
const sweeper = setInterval(() => {
  for (const { room, reason } of store.collectExpiredRooms()) {
    if (room.participants.size > 0) {
      io.to(room.code).emit('room:ended', { reason });
      for (const id of room.participants.keys()) {
        io.sockets.sockets.get(id)?.leave(room.code);
      }
    }
    store.closeRoom(room.code);
    log(`swept room ${room.code} (${reason})`);
  }
}, config.sweepIntervalMs);
sweeper.unref();

httpServer.listen(config.port, () => {
  log(`signaling server listening on :${config.port} (${config.nodeEnv})`);
  log(`accepting browser origins: ${config.corsOrigins.join(', ')}`);
  warnAboutProductionGaps((message) => log(`WARNING ${message}`));
});

function shutdown(signal: string): void {
  log(`${signal} received, shutting down`);
  clearInterval(sweeper);
  io.close(() => {
    httpServer.close(() => process.exit(0));
  });
  // Do not let a stuck socket hold the process open forever.
  setTimeout(() => process.exit(0), 5_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  log('unhandled rejection', reason);
});
