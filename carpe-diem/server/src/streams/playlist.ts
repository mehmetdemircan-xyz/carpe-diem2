import { MAX_PLAYLIST_ENTRIES, type PlaylistEntry } from '@shared/protocol';
import { assertPublicHost, validateStreamUrl } from './urlGuard.js';

const MAX_PLAYLIST_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_REDIRECTS = 3;

export type PlaylistResult =
  | { ok: true; entries: PlaylistEntry[]; truncated: boolean }
  | { ok: false; reason: 'invalid-url' | 'unreachable' | 'empty' };

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

  const body = await fetchTextSafely(validated.url);
  if (body === null) return { ok: false, reason: 'unreachable' };

  const entries = parsePlaylist(body, validated.url);
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
async function fetchTextSafely(startUrl: string): Promise<string | null> {
  let current = startUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const validated = validateStreamUrl(current);
    if (!validated.ok) return null;

    const parsed = new URL(validated.url);
    if (!(await assertPublicHost(parsed.hostname))) return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(validated.url, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { accept: 'audio/x-mpegurl, application/vnd.apple.mpegurl, text/plain, */*' },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) return null;
        current = new URL(location, validated.url).toString();
        continue;
      }

      if (!response.ok || !response.body) return null;

      // Declared length is a hint, not a guarantee, so the stream is also
      // capped as it arrives.
      const declared = Number(response.headers.get('content-length') ?? '0');
      if (declared > MAX_PLAYLIST_BYTES) return null;

      return await readCapped(response.body);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  return null;
}

async function readCapped(body: ReadableStream<Uint8Array>): Promise<string | null> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > MAX_PLAYLIST_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  }

  return Buffer.concat(chunks).toString('utf8');
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
