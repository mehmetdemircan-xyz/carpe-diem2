/**
 * Decides what a pasted URL is, so the app can route it to the right feature.
 *
 * This is a pure string check. It never fetches the URL, never reads a page's
 * markup, and never tries to discover a media address hidden inside one. A
 * page is treated as a page: the only thing offered for it is the browser's
 * own tab-sharing flow, which the person doing the sharing explicitly picks.
 */

export type UrlKind = 'media' | 'page' | 'unplayable' | 'invalid';

export interface ClassifiedUrl {
  kind: UrlKind;
  /** Normalized form, present when the URL parsed at all. */
  url: string;
}

/**
 * Extensions a browser can play directly, either natively or through hls.js.
 * `.m3u` is here because it opens the channel picker rather than a player.
 */
const MEDIA_EXTENSIONS =
  /\.(m3u8|m3u|mpd|mp4|m4v|m4s|webm|ogv|ogg|mov|mkv|mp3|m4a|aac|flac|wav)$/i;

/**
 * Paths that are conventionally manifests even without an extension. Kept
 * deliberately short: guessing wrong only costs a hint, and the player's own
 * error is the real feedback.
 */
const MEDIA_PATH_HINTS = /\/(manifest|playlist|master|index)\.(m3u8|mpd)$/i;

/**
 * Raw MPEG transport streams. No browser can play one from a `<video>` — the
 * container has no index and Media Source Extensions is never handed it
 * outside of an HLS playlist. Saying so up front is far kinder than letting
 * the element fail with a generic "format not supported", which is what used
 * to happen: these addresses are common on IPTV panels, where the endpoint
 * without an extension serves exactly this.
 */
const RAW_TRANSPORT_STREAM = /\.(ts|mts|m2ts|tsv)(\?|#|$)/i;

export function classifyUrl(raw: string): ClassifiedUrl {
  const trimmed = raw.trim();
  if (!trimmed) return { kind: 'invalid', url: '' };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { kind: 'invalid', url: trimmed };
  }

  // Only http(s) is ever acted on. javascript: and data: are ways to run code,
  // not ways to watch something, and this value reaches window.open().
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { kind: 'invalid', url: trimmed };
  }

  const path = parsed.pathname;
  if (RAW_TRANSPORT_STREAM.test(path)) {
    return { kind: 'unplayable', url: parsed.toString() };
  }
  if (MEDIA_EXTENSIONS.test(path) || MEDIA_PATH_HINTS.test(path)) {
    return { kind: 'media', url: parsed.toString() };
  }

  return { kind: 'page', url: parsed.toString() };
}

/**
 * A page served over https may not load an http subresource — the browser
 * blocks it before any script runs, so the player never even reports an
 * error. Worth catching early, because the address itself looks perfectly
 * fine and there is nothing in the failure to point at the scheme.
 */
export function isMixedContent(url: string): boolean {
  if (typeof window === 'undefined' || window.location.protocol !== 'https:') return false;
  try {
    return new URL(url).protocol === 'http:';
  } catch {
    return false;
  }
}

/** Host shown in the UI so people can see what they are about to open. */
export function displayHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}
