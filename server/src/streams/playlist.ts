import { MAX_PLAYLIST_ENTRIES, type PlaylistEntry } from '@shared/protocol';
import { config } from '../config.js';
import { checkPublicHost, validateStreamUrl } from './urlGuard.js';

const MAX_REDIRECTS = 3;

/**
 * Why a playlist could not be read. These are deliberately distinct: "the
 * host answered 403" and "the host never answered" send someone looking in
 * completely different places, and collapsing both into "unreachable" wastes
 * their time.
 */
export type PlaylistFailure =
  | { reason: 'invalid-url' }
  /** The host answered, with a status that was not a playlist. */
  | { reason: 'refused'; status: number }
  | { reason: 'timeout' }
  | { reason: 'too-large' }
  /** DNS, TLS or connection failure — nothing answered at all. */
  | { reason: 'unreachable' }
  /** Parsed fine, but it is an HLS manifest rather than a channel list. */
  | { reason: 'not-a-list' }
  | { reason: 'empty' };

export type PlaylistResult =
  | { ok: true; entries: PlaylistEntry[]; truncated: boolean }
  | ({ ok: false } & PlaylistFailure);

/**
 * Fetches an .m3u playlist server-side and returns its channels.
 *
 * This runs on the server for two reasons: most playlist hosts send no CORS
 * headers, so a browser fetch would simply fail; and the server can enforce
 * SSRF protections that a browser cannot be asked to enforce on its own.
 */
export async function loadPlaylist(rawUrl: unknown): Promise<PlaylistResult> {
  const validated = validateStreamUrl(rawUrl);
  if (!validated.ok) return { ok: false, reason: 'invalid-url' };

  const fetched = await fetchTextSafely(validated.url);
  if (!fetched.ok) return { ok: false, ...fetched.failure };

  if (isHlsManifest(fetched.body)) return { ok: false, reason: 'not-a-list' };

  const entries = parsePlaylist(fetched.body, validated.url);
  if (entries.length === 0) return { ok: false, reason: 'empty' };

  return {
    ok: true,
    entries: entries.slice(0, MAX_PLAYLIST_ENTRIES),
    truncated: entries.length > MAX_PLAYLIST_ENTRIES,
  };
}

/**
 * Follows redirects by hand so every hop is re-validated. `redirect: 'follow'`
 * would let a public URL bounce to 169.254.169.254 without us ever seeing it.
 */
async function fetchTextSafely(
  startUrl: string,
): Promise<{ ok: true; body: string } | { ok: false; failure: PlaylistFailure }> {
  let current = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const validated = validateStreamUrl(current);
    if (!validated.ok) return { ok: false, failure: { reason: 'invalid-url' } };

    const parsed = new URL(validated.url);
    const verdict = await checkPublicHost(parsed.hostname);
    if (verdict === 'private') return { ok: false, failure: { reason: 'invalid-url' } };
    if (verdict === 'unresolved') return { ok: false, failure: { reason: 'unreachable' } };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.playlistFetchTimeoutMs);

    try {
      const response = await fetch(validated.url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: 'audio/x-mpegurl, application/vnd.apple.mpegurl, text/plain, */*' },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          return { ok: false, failure: { reason: 'refused', status: response.status } };
        }
        current = new URL(location, validated.url).toString();
        continue;
      }

      // A status is the single most useful thing to pass back: 401/403
      // usually means the credentials or the caller were rejected, 404 a
      // wrong path, 5xx a host that is simply unwell.
      if (!response.ok || !response.body) {
        return { ok: false, failure: { reason: 'refused', status: response.status } };
      }

      // Declared length is a hint, not a guarantee, so the stream is also
      // capped as it arrives.
      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > config.maxPlaylistBytes) {
        return { ok: false, failure: { reason: 'too-large' } };
      }

      const read = await readCapped(response.body);
      return read.ok ? { ok: true, body: read.text } : read;
    } catch (error) {
      // An aborted fetch is the timeout firing; anything else never connected.
      const aborted = error instanceof Error && error.name === 'AbortError';
      return { ok: false, failure: { reason: aborted ? 'timeout' : 'unreachable' } };
    } finally {
      clearTimeout(timer);
    }
  }

  // Ran out of redirect hops.
  return { ok: false, failure: { reason: 'unreachable' } };
}

/**
 * Reads the body with a hard ceiling, distinguishing "this list is bigger
 * than we will hold" from "the connection died mid-read" — they mean
 * different things to whoever is trying to make a link work.
 */
async function readCapped(
  body: ReadableStream<Uint8Array>,
): Promise<{ ok: true; text: string } | { ok: false; failure: PlaylistFailure }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > config.maxPlaylistBytes) {
        await reader.cancel();
        return { ok: false, failure: { reason: 'too-large' } };
      }
      chunks.push(value);
    }
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return { ok: false, failure: { reason: aborted ? 'timeout' : 'unreachable' } };
  }

  return { ok: true, text: Buffer.concat(chunks).toString('utf8') };
}

/**
 * Parses extended M3U. Handles the two shapes people actually paste: an IPTV
 * playlist of many channels, and a bare list of URLs with no metadata.
 *
 * An HLS *manifest* (one that contains #EXTM3U plus #EXT-X-* tags) is not a
 * channel list and is deliberately not treated as one — the caller plays that
 * URL directly instead.
 */
export function parsePlaylist(body: string, baseUrl: string): PlaylistEntry[] {
  if (isHlsManifest(body)) return [];

  const entries: PlaylistEntry[] = [];
  let pendingName: string | null = null;
  let pendingGroup: string | null = null;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    if (line.startsWith('#EXTINF:')) {
      pendingName = extractDisplayName(line);
      pendingGroup = extractAttribute(line, 'group-title');
      continue;
    }

    if (line.startsWith('#')) continue;

    let resolved: string;
    try {
      resolved = new URL(line, baseUrl).toString();
    } catch {
      pendingName = null;
      continue;
    }

    const validated = validateStreamUrl(resolved);
    if (validated.ok) {
      entries.push({
        name: pendingName || fallbackName(resolved),
        url: validated.url,
        group: pendingGroup,
      });
    }

    pendingName = null;
    pendingGroup = null;
  }

  return entries;
}

function isHlsManifest(body: string): boolean {
  return /^#EXT-X-(STREAM-INF|TARGETDURATION|VERSION|MEDIA-SEQUENCE|PLAYLIST-TYPE)/m.test(body);
}

/** The channel name in #EXTINF is whatever follows the last comma. */
function extractDisplayName(line: string): string | null {
  const commaIndex = line.lastIndexOf(',');
  if (commaIndex === -1) return null;
  const name = line.slice(commaIndex + 1).trim();
  return name.length > 0 ? name.slice(0, 120) : null;
}

function extractAttribute(line: string, attribute: string): string | null {
  const match = new RegExp(`${attribute}="([^"]*)"`, 'i').exec(line);
  return match?.[1]?.trim() || null;
}

function fallbackName(url: string): string {
  try {
    const { pathname, hostname } = new URL(url);
    const last = pathname.split('/').filter(Boolean).pop();
    return last || hostname;
  } catch {
    return 'Stream';
  }
}
