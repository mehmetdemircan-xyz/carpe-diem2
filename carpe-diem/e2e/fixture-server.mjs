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
