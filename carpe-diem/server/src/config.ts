import type { RTCIceServerConfig } from '@shared/protocol';

function int(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export const config = {
  port: int(process.env.PORT, 3001),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  get isProduction(): boolean {
    return this.nodeEnv === 'production';
  },

  /**
   * Allowed browser origins. In development we accept the Vite dev server.
   * In production this must be set explicitly — a wildcard would let any page
   * on the internet drive rooms on this server.
   */
  corsOrigins: list(process.env.CORS_ORIGINS).length
    ? list(process.env.CORS_ORIGINS)
    : ['http://localhost:5173', 'http://127.0.0.1:5173'],

  /**
   * Allows stream URLs that point at private or loopback addresses.
   *
   * Off by default, because a stream URL is loaded by every participant's
   * browser and the playlist fetcher runs on the server — both are ways to
   * reach an internal network. Turn it on only when the room is meant to play
   * from a media server on the same LAN (Jellyfin, Plex, a local restream)
   * and everyone in the room is already trusted on that network.
   */
  allowPrivateStreamHosts: process.env.ALLOW_PRIVATE_STREAM_HOSTS === '1',

  /** Rooms with nobody in them are swept after this long. */
  emptyRoomGraceMs: int(process.env.EMPTY_ROOM_GRACE_MS, 60_000),
  /** Absolute room lifetime, regardless of activity. */
  roomMaxLifetimeMs: int(process.env.ROOM_MAX_LIFETIME_MS, 12 * 60 * 60 * 1000),
  sweepIntervalMs: 30_000,

  /** Per-socket signaling budget. Generous for ICE, tight enough to matter. */
  rateLimit: {
    signalPerSecond: int(process.env.RATE_SIGNAL_PER_SEC, 120),
    actionPerSecond: int(process.env.RATE_ACTION_PER_SEC, 15),
    joinAttemptsPerMinute: int(process.env.RATE_JOIN_PER_MIN, 30),
    chatPerSecond: int(process.env.RATE_CHAT_PER_SEC, 3),
    presencePerSecond: int(process.env.RATE_PRESENCE_PER_SEC, 8),
  },
} as const;

/**
 * STUN gets peers connected on most home networks. TURN is required in
 * production for symmetric NATs and restrictive corporate firewalls — set
 * TURN_URL / TURN_USERNAME / TURN_CREDENTIAL to enable it.
 */
export function iceServers(): RTCIceServerConfig[] {
  const servers: RTCIceServerConfig[] = [
    {
      urls: list(process.env.STUN_URLS).length
        ? list(process.env.STUN_URLS)
        : ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'],
    },
  ];

  const turnUrl = process.env.TURN_URL;
  if (turnUrl) {
    servers.push({
      urls: list(turnUrl),
      username: process.env.TURN_USERNAME ?? '',
      credential: process.env.TURN_CREDENTIAL ?? '',
    });
  }

  return servers;
}

export function warnAboutProductionGaps(log: (message: string) => void): void {
  if (!config.isProduction) return;
  if (!process.env.CORS_ORIGINS) {
    log('CORS_ORIGINS is not set — falling back to localhost only. Set it to your site origin.');
  }
  if (!process.env.TURN_URL) {
    log('TURN_URL is not set — peers behind symmetric NAT or strict firewalls will fail to connect.');
  }
  if (config.allowPrivateStreamHosts) {
    log(
      'ALLOW_PRIVATE_STREAM_HOSTS is on — stream URLs may point at internal addresses. ' +
        'Only do this on a trusted network.',
    );
  }
}
