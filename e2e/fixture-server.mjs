/**
 * Serves the HLS fixture used by the streaming tests, with the CORS headers a
 * real stream host has to send for browser playback to work at all.
 *
 * The fixture is VP9/Opus in fMP4 rather than the H.264/AAC that real HLS
 * streams use, because the open-source Chromium the tests run against ships
 * without proprietary codecs. The app itself has no such constraint — every
 * shipping browser plays H.264/AAC.
 *
 * Also exposes a couple of deliberately hostile endpoints so the tests can
 * check how the app behaves when a source misbehaves.
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const PORT = Number(process.env.FIXTURE_PORT ?? 4010);
/** Anchors the live playlist's sliding window. */
const START_TIME = Date.now();

const TYPES = {
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.m3u': 'audio/x-mpegurl',
  '.ts': 'video/mp2t',
  '.mp4': 'video/mp4',
  '.m4s': 'video/iso.segment',
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  // Every response is cross-origin friendly; the point of the fixture is to
  // exercise the happy path that a well-configured stream host provides.
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end();
    return;
  }

  // A playlist of channels, generated so it always points at this server.
  if (url.pathname === '/channels.m3u') {
    const body = [
      '#EXTM3U',
      '#EXTINF:-1 tvg-id="one" group-title="Test",Channel One',
      `http://localhost:${PORT}/hls/stream.m3u8`,
      '#EXTINF:-1 group-title="Test",Channel Two',
      `http://localhost:${PORT}/hls/stream.m3u8?ch=2`,
      '#EXTINF:-1 group-title="Other",Channel Three',
      `http://localhost:${PORT}/hls/stream.m3u8?ch=3`,
    ].join('\n');
    res.writeHead(200, { 'content-type': TYPES['.m3u'] }).end(body);
    return;
  }

  /**
   * The shape a real IPTV list has: playable entries alongside live channels
   * served as raw MPEG-TS. The picker has to refuse the second kind rather
   * than push a stream nobody can decode onto everyone's stage.
   */
  if (url.pathname === '/mixed-channels.m3u') {
    const body = [
      '#EXTM3U',
      '#EXTINF:-1 group-title="VOD",Playable Movie',
      `http://localhost:${PORT}/hls/stream.m3u8`,
      '#EXTINF:-1 group-title="Live",Raw TS Channel',
      `http://localhost:${PORT}/live/channel.ts`,
    ].join('\n');
    res.writeHead(200, { 'content-type': TYPES['.m3u'] }).end(body);
    return;
  }

  // A playlist whose entries point at private addresses — the parser must
  // drop them rather than hand them to everyone's browser.
  if (url.pathname === '/hostile.m3u') {
    const body = [
      '#EXTM3U',
      '#EXTINF:-1,Metadata',
      'http://169.254.169.254/latest/meta-data/',
      '#EXTINF:-1,Router',
      'http://192.168.1.1/admin',
      '#EXTINF:-1,Local',
      'http://127.0.0.1:3002/health',
      '#EXTINF:-1,Legit',
      `http://localhost:${PORT}/hls/stream.m3u8`,
    ].join('\n');
    res.writeHead(200, { 'content-type': TYPES['.m3u'] }).end(body);
    return;
  }

  /**
   * A genuinely live-shaped playlist: a sliding window with no
   * #EXT-X-ENDLIST, so the player reports an infinite duration and treats it
   * as a live edge rather than a seekable recording. The media sequence
   * advances with wall-clock time, which is what makes the client keep
   * refreshing the manifest the way it would against a real broadcast.
   */
  /*
   * A live channel published the way providers publish them: an extensionless
   * endpoint serving a transport stream no browser can decode, with the same
   * channel available as a playlist one extension away. This is what the
   * player's single retry is for.
   */
  if (url.pathname === '/fallback/channel') {
    res.writeHead(200, { 'content-type': TYPES['.ts'] }).end(Buffer.from([0x47, 0x40, 0x00, 0x10]));
    return;
  }

  if (url.pathname === '/live/stream.m3u8' || url.pathname === '/fallback/channel.m3u8') {
    const SEGMENT_SECONDS = 2;
    const TOTAL_SEGMENTS = 4;
    const WINDOW = 3;

    const elapsed = (Date.now() - START_TIME) / 1000;
    const newest = Math.min(TOTAL_SEGMENTS - 1, Math.floor(elapsed / SEGMENT_SECONDS));
    const first = Math.max(0, newest - WINDOW + 1);

    const lines = [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      `#EXT-X-TARGETDURATION:${SEGMENT_SECONDS}`,
      `#EXT-X-MEDIA-SEQUENCE:${first}`,
      '#EXT-X-MAP:URI="/hls/init.mp4"',
    ];
    for (let i = first; i <= newest; i += 1) {
      lines.push(`#EXTINF:${SEGMENT_SECONDS}.000000,`, `/hls/seg${i}.m4s`);
    }
    // No #EXT-X-ENDLIST: that absence is what makes this live.

    res
      .writeHead(200, { 'content-type': TYPES['.m3u8'], 'cache-control': 'no-store' })
      .end(lines.join('\n') + '\n');
    return;
  }

  // A stand-in for a platform's embed page, so the frame path can be tested
  // without reaching out to a real third-party player.
  if (url.pathname === '/embed.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(
      '<!doctype html><meta charset="utf-8"><title>Embed fixture</title>' +
        '<body style="margin:0;background:#123;color:#fff;font:16px sans-serif">' +
        '<p id="marker" style="padding:24px">embed fixture</p></body>',
    );
    return;
  }

  if (url.pathname === '/empty.m3u') {
    res.writeHead(200, { 'content-type': TYPES['.m3u'] }).end('#EXTM3U\n');
    return;
  }

  // A host that answers and says no. Panels that check the caller's
  // User-Agent or lock an account to one address behave exactly like this,
  // and the status is the only thing that distinguishes it from a dead host.
  if (url.pathname === '/refuse.m3u') {
    res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden');
    return;
  }

  // Larger than the fetcher will hold. Sent as a stream so the cap has to be
  // enforced while reading rather than from content-length.
  if (url.pathname === '/huge.m3u') {
    res.writeHead(200, { 'content-type': TYPES['.m3u'] });
    res.write('#EXTM3U\n');
    const block = `#EXTINF:-1,Filler\nhttp://localhost:${PORT}/hls/stream.m3u8\n`.repeat(1000);
    // Each block is ~56KB, so 340 of them is ~19MB — past the 16MB ceiling
    // with enough margin that the test does not depend on the exact size.
    let written = 0;
    const pump = () => {
      while (written < 340) {
        written += 1;
        if (!res.write(block)) {
          res.once('drain', pump);
          return;
        }
      }
      res.end();
    };
    pump();
    return;
  }

  // Accepts the connection and never answers, so the fetch timeout is what
  // ends it. The socket is left open deliberately.
  if (url.pathname === '/slow.m3u') {
    res.writeHead(200, { 'content-type': TYPES['.m3u'] });
    res.write('#EXTM3U\n');
    return;
  }

  // Redirects to a private address, to check the manual redirect validation.
  if (url.pathname === '/redirect-to-private.m3u') {
    res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
    return;
  }

  const safePath = normalize(url.pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(ROOT, safePath);
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403).end();
    return;
  }

  try {
    const body = await readFile(filePath);
    res
      .writeHead(200, {
        'content-type': TYPES[extname(filePath)] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
      })
      .end(body);
  } catch {
    res.writeHead(404).end();
  }
});

server.listen(PORT, () => {
  console.log(`fixture server on http://localhost:${PORT}`);
});
