import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { MAX_STREAM_URL_LENGTH } from '@shared/protocol';
import { config } from '../config.js';

/**
 * Validation for stream URLs.
 *
 * Two distinct threats, and they need different answers:
 *
 * 1. A URL sent to `stream:start` is loaded by *every other participant's
 *    browser*. A malicious one could point at someone's router admin page or
 *    a private intranet host. `validateStreamUrl` is what stops that.
 *
 * 2. A URL sent to `stream:load-playlist` is fetched by *the server*. That is
 *    a textbook SSRF sink, so `assertPublicHost` resolves DNS and checks the
 *    resulting addresses rather than trusting the hostname, and redirects are
 *    followed manually with the same check applied at every hop.
 */

export type UrlRejection = 'scheme' | 'length' | 'malformed' | 'private-host';

export function validateStreamUrl(
  raw: unknown,
  /** Overridden only by tests; production reads the server config. */
  allowPrivate = config.allowPrivateStreamHosts,
): { ok: true; url: string } | { ok: false; reason: UrlRejection } {
  if (typeof raw !== 'string') return { ok: false, reason: 'malformed' };

  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_STREAM_URL_LENGTH) {
    return { ok: false, reason: 'length' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  // Anything but http(s) is a way to run something in another participant's
  // browser rather than play media in it.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, reason: 'scheme' };
  }

  // Literal private addresses are rejected up front. Hostnames that *resolve*
  // to private addresses are only checkable asynchronously, which is done in
  // assertPublicHost for the URLs the server itself fetches.
  //
  // The scheme check above is never relaxed — javascript: and data: are ways
  // to run code in another participant's browser, not ways to reach a LAN.
  if (!allowPrivate && isPrivateHostname(parsed.hostname)) {
    return { ok: false, reason: 'private-host' };
  }

  return { ok: true, url: parsed.toString() };
}

const PRIVATE_HOSTNAMES = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost']);

export function isPrivateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (PRIVATE_HOSTNAMES.has(host)) return true;
  // .local and .internal are the conventional intranet suffixes.
  if (host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) {
    return true;
  }

  if (isIP(host) !== 0) return isPrivateAddress(host);
  return false;
}

export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);

  if (version === 4) {
    const octets = address.split('.').map(Number);
    const [a = 0, b = 0] = octets;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
    if (a >= 224) return true; // multicast and reserved
    return false;
  }

  if (version === 6) {
    const host = address.toLowerCase();

    // An IPv4 target smuggled inside a v6 literal. Note that `new URL()`
    // normalizes ::ffff:127.0.0.1 to ::ffff:7f00:1, so matching only the
    // dotted form would miss every URL-derived address.
    const mapped = mappedIPv4(host);
    if (mapped) return isPrivateAddress(mapped);

    // Everything routable on the public internet today lives in 2000::/3.
    // Allow-listing that is far more robust than trying to enumerate the
    // reserved ranges (::1, fe80::/10, fc00::/7, 64:ff9b::/96, and so on).
    const firstGroup = host.startsWith('::') ? 0 : Number.parseInt(host.split(':')[0] ?? '', 16);
    if (!Number.isFinite(firstGroup)) return true;
    return firstGroup < 0x2000 || firstGroup > 0x3fff;
  }

  return true;
}

/** Extracts the IPv4 address from a v4-mapped IPv6 literal, in either form. */
function mappedIPv4(host: string): string | null {
  const dotted = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(host);
  if (dotted?.[1]) return dotted[1];

  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (hex?.[1] && hex[2]) {
    const high = Number.parseInt(hex[1], 16);
    const low = Number.parseInt(hex[2], 16);
    return [(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff].join('.');
  }

  return null;
}

/**
 * Resolves the hostname and rejects it if any address is private. Checking
 * the resolved addresses rather than the name is what defeats a DNS record
 * pointed at 169.254.169.254.
 */
export type HostVerdict = 'ok' | 'private' | 'unresolved';

/**
 * Distinguishes "this points inside the network" from "this name does not
 * exist". Both are refusals, but only the first is a security decision — the
 * second is an ordinary broken address, and telling someone their link was
 * rejected as unsafe when it is merely misspelled sends them the wrong way.
 */
export async function checkPublicHost(
  hostname: string,
  allowPrivate = config.allowPrivateStreamHosts,
): Promise<HostVerdict> {
  if (allowPrivate) return 'ok';
  if (isPrivateHostname(hostname)) return 'private';

  const host = hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) !== 0) return isPrivateAddress(host) ? 'private' : 'ok';

  try {
    const records = await lookup(host, { all: true });
    if (records.length === 0) return 'unresolved';
    return records.every((record) => !isPrivateAddress(record.address)) ? 'ok' : 'private';
  } catch {
    return 'unresolved';
  }
}

export async function assertPublicHost(
  hostname: string,
  allowPrivate = config.allowPrivateStreamHosts,
): Promise<boolean> {
  return (await checkPublicHost(hostname, allowPrivate)) === 'ok';
}
