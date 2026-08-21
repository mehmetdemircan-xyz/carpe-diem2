/**
 * Protocol-level tests against the signaling server, with no browser involved.
 *
 * These are the checks that matter for security: they speak the wire protocol
 * directly, so every UI guard is bypassed. If the server is only as safe as
 * `if (isHost)` in React, these fail.
 *
 * Run with: node e2e/server-authority.mjs   (signaling server must be up)
 */
import { io } from 'socket.io-client';

const URL = process.env.SIGNALING_URL ?? 'http://localhost:3001';
/** A second server started with ALLOW_PRIVATE_STREAM_HOSTS=1, for stream tests. */
const PERMISSIVE_URL = process.env.PERMISSIVE_SIGNALING_URL ?? '';
const FIXTURE = process.env.FIXTURE_URL ?? 'http://localhost:4010';
const PROTOCOL_VERSION = 1;

let failures = 0;
let total = 0;

function check(name, passed, detail = '') {
  total += 1;
  if (!passed) failures += 1;
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

function connect(target = URL) {
  return new Promise((resolve, reject) => {
    const socket = io(target, { transports: ['websocket'], reconnection: false, timeout: 5000 });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

function ask(socket, event, payload, timeout = 5000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: 'TIMEOUT' }), timeout);
    const done = (response) => {
      clearTimeout(timer);
      resolve(response ?? { ok: false, error: 'NO_RESPONSE' });
    };
    if (payload === undefined) socket.emit(event, done);
    else socket.emit(event, payload, done);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits for an event whose payload satisfies a predicate, ignoring earlier
 * ones. Needed where a preceding action emits the same event: stopping a
 * stream broadcasts `stream:changed` with null, and a plain `once` would
 * capture that instead of the change being tested.
 */
const onceWhere = (socket, event, predicate, timeout = 4000) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      resolve(null);
    }, timeout);
    const handler = (payload) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });

const once = (socket, event, timeout = 4000) =>
  new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeout);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload ?? true);
    });
  });

async function main() {
  const host = await connect();
  const guest = await connect();
  const outsider = await connect();

  try {
    /* ------------------------------------------------------ Room creation */
    console.log('\nRoom lifecycle');
    const created = await ask(host, 'room:create', { name: 'Host', protocolVersion: PROTOCOL_VERSION });
    check('room:create succeeds', created.ok === true, created.error ?? '');
    const code = created.data.room.code;
    check('code has the documented shape', /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code), code);
    check('creator is host', created.data.self.role === 'host');
    check('host may share by default', created.data.self.canShare === true);
    check('ICE servers are provided', Array.isArray(created.data.iceServers) && created.data.iceServers.length > 0);

    /* --------------------------------------------------------- Validation */
    console.log('\nInput validation');
    const badVersion = await ask(outsider, 'room:join', { code, name: 'X', protocolVersion: 999 });
    check('rejects protocol mismatch', badVersion.error === 'PROTOCOL_MISMATCH', badVersion.error);

    const badCode = await ask(outsider, 'room:join', { code: 'nope', name: 'X', protocolVersion: PROTOCOL_VERSION });
    check('rejects malformed code', badCode.error === 'INVALID_CODE', badCode.error);

    const missingRoom = await ask(outsider, 'room:join', { code: 'ZZZZ-9999', name: 'X', protocolVersion: PROTOCOL_VERSION });
    check('rejects unknown room', missingRoom.error === 'ROOM_NOT_FOUND', missingRoom.error);

    const blankName = await ask(outsider, 'room:join', { code, name: '   ', protocolVersion: PROTOCOL_VERSION });
    check('rejects blank name', blankName.error === 'INVALID_NAME', blankName.error);

    /* -------------------------------------------------------- Guest joins */
    console.log('\nJoining');
    const lowercase = code.toLowerCase().replace('-', '');
    const joined = await ask(guest, 'room:join', {
      code: lowercase,
      name: 'Guest',
      protocolVersion: PROTOCOL_VERSION,
    });
    check('accepts lowercase, dashless code', joined.ok === true, joined.error ?? lowercase);
    check('guest starts as viewer', joined.data.self.canShare === false);
    check('newcomer is told who to offer to', joined.data.initiateTo.includes(created.data.self.id));

    /* ------------------------------------------------ Server-side authority */
    console.log('\nHost authority (the UI is bypassed entirely here)');
    const forgedClose = await ask(guest, 'host:close-room');
    check('guest cannot close the room', forgedClose.error === 'NOT_HOST', forgedClose.error);

    const forgedKick = await ask(guest, 'host:kick', { targetId: created.data.self.id });
    check('guest cannot kick the host', forgedKick.error === 'NOT_HOST', forgedKick.error);

    const forgedGrant = await ask(guest, 'host:grant-share', { targetId: joined.data.self.id });
    check('guest cannot grant themselves permission', forgedGrant.error === 'NOT_HOST', forgedGrant.error);

    const forgedRegen = await ask(guest, 'host:regenerate-code');
    check('guest cannot rotate the room code', forgedRegen.error === 'NOT_HOST', forgedRegen.error);

    /* ------------------------------------------------------- Share gating */
    console.log('\nScreen share permission');
    const unauthorizedShare = await ask(guest, 'share:start');
    check(
      'guest cannot start sharing without permission',
      unauthorizedShare.error === 'NOT_ALLOWED_TO_SHARE',
      unauthorizedShare.error,
    );

    const permissionEvent = once(guest, 'permission:changed');
    const grant = await ask(host, 'host:grant-share', { targetId: joined.data.self.id });
    check('host can grant permission', grant.ok === true, grant.error ?? '');
    check('granted client is notified', (await permissionEvent)?.canShare === true);

    const authorizedShare = await ask(guest, 'share:start');
    check('guest can share once permitted', authorizedShare.ok === true, authorizedShare.error ?? '');

    const forceStop = once(guest, 'share:force-stop');
    const revoke = await ask(host, 'host:revoke-share', { targetId: joined.data.self.id });
    check('host can revoke permission', revoke.ok === true, revoke.error ?? '');
    check('revoking stops an in-flight share', (await forceStop) !== null);

    const afterRevoke = await ask(guest, 'share:start');
    check(
      'guest cannot share after revocation',
      afterRevoke.error === 'NOT_ALLOWED_TO_SHARE',
      afterRevoke.error,
    );

    const selfRevoke = await ask(host, 'host:revoke-share', { targetId: created.data.self.id });
    check('host cannot lock themselves out', selfRevoke.ok === false, selfRevoke.error);

    /* ---------------------------------------------------------------- Chat */
    console.log('\nChat');
    const delivered = once(host, 'chat:message');
    const sent = await ask(guest, 'chat:send', { text: '  merhaba   dunya  ' });
    check('chat:send is accepted', sent.ok === true, sent.error ?? '');

    const received = await delivered;
    check('message reaches the other participant', received !== null);
    check('whitespace is collapsed', received?.text === 'merhaba dunya', received?.text);
    check('sender name comes from room state', received?.name === 'Guest', received?.name);
    check('message carries a sender id', received?.from === joined.data.self.id);

    const spoofed = await ask(guest, 'chat:send', { text: 'x', name: 'Host', from: 'someone-else' });
    check('extra payload fields are ignored', spoofed.ok === true);

    const emptyMessage = await ask(guest, 'chat:send', { text: '     ' });
    check('blank messages are rejected', emptyMessage.error === 'EMPTY_MESSAGE', emptyMessage.error);

    // U+202E (bidi override) and U+200B (zero-width space) are the usual way
    // to make a message render as somebody else's text.
    const BIDI_OVERRIDE = String.fromCharCode(0x202e);
    const ZERO_WIDTH = String.fromCharCode(0x200b);
    const controlChars = once(host, 'chat:message');
    await ask(guest, 'chat:send', { text: `safe${BIDI_OVERRIDE}flipped${ZERO_WIDTH}text` });
    const cleaned = await controlChars;
    const hasInvisible = [...(cleaned?.text ?? '')].some((ch) => {
      const cp = ch.codePointAt(0);
      return (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) || cp < 0x20;
    });
    // Requiring a delivered message keeps this from passing on a dropped one.
    check(
      'control and bidi characters are stripped',
      typeof cleaned?.text === 'string' && cleaned.text.length > 0 && hasInvisible === false,
      cleaned?.text,
    );

    const longMessage = once(host, 'chat:message');
    await ask(guest, 'chat:send', { text: 'a'.repeat(2000) });
    const clamped = await longMessage;
    const clampedLength = clamped?.text?.length ?? 0;
    check(
      'over-long messages are clamped',
      clampedLength > 0 && clampedLength <= 500,
      String(clampedLength),
    );

    // Burst past the token bucket; some sends must be refused.
    const burst = await Promise.all(
      Array.from({ length: 25 }, (_, i) => ask(guest, 'chat:send', { text: `flood ${i}` })),
    );
    const refused = burst.filter((response) => response.error === 'RATE_LIMITED').length;
    check('chat flooding is rate limited', refused > 0, `${refused}/25 refused`);

    /* -------------------------------------------------------------- Stream */
    console.log('\nStream URL guards (strict server)');

    await ask(host, 'host:grant-share', { targetId: joined.data.self.id });

    const rejects = [
      ['javascript: scheme', 'javascript:alert(1)'],
      ['data: scheme', 'data:text/html,<script>alert(1)</script>'],
      ['file: scheme', 'file:///etc/passwd'],
      ['loopback host', 'http://127.0.0.1:3002/health'],
      ['localhost by name', 'http://localhost:3002/health'],
      ['private range', 'http://192.168.1.1/admin'],
      ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
      ['IPv6 loopback', 'http://[::1]:3002/health'],
      ['IPv4-mapped IPv6', 'http://[::ffff:127.0.0.1]/x.m3u8'],
      ['.local suffix', 'http://nas.local/stream.m3u8'],
      ['not a URL', 'just some text'],
    ];
    for (const [label, url] of rejects) {
      // Paced so the action budget, not the guard, is what these measure.
      await sleep(120);
      const response = await ask(guest, 'stream:start', { url });
      check(`rejects ${label}`, response.error === 'INVALID_URL', `${response.error} — ${url}`);
    }

    await sleep(300);
    const ssrfDirect = await ask(guest, 'stream:load-playlist', {
      url: 'http://169.254.169.254/latest/meta-data/',
    });
    check(
      'the server refuses to fetch a private address',
      ssrfDirect.error === 'INVALID_URL',
      ssrfDirect.error,
    );

    await sleep(300);
    await ask(host, 'host:revoke-share', { targetId: joined.data.self.id });
    const noPermission = await ask(guest, 'stream:start', {
      url: 'https://example.com/stream.m3u8',
    });
    check(
      'a viewer cannot put a stream on the stage',
      noPermission.error === 'NOT_ALLOWED_TO_SHARE',
      noPermission.error,
    );

    /* ------------------------------------------------- Avatars and speaking */
    console.log('\nAvatars and speaking');

    // A 1x1 JPEG, base64. Small but structurally a real data URL.
    const TINY_JPEG =
      'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';

    const avatarSet = once(host, 'participant:updated');
    const setAvatar = await ask(guest, 'media:avatar', { avatar: TINY_JPEG });
    check('a valid avatar is accepted', setAvatar.ok === true, setAvatar.error ?? '');
    check('the avatar reaches the room', (await avatarSet)?.avatar === TINY_JPEG);

    /**
     * Everything below is refused. The handler acks ok and clears the picture
     * rather than erroring, so the ack alone proves nothing — each case checks
     * the value the room actually received.
     */
    const refusedAvatars = [
      // SVG can carry script. Excluded even though an <img> would not run it,
      // because the client re-encodes to JPEG and never needs the format.
      ['SVG', 'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+'],
      ['a remote URL', 'https://example.com/a.png'],
      ['a javascript: URL', 'javascript:alert(1)'],
      ['an oversized image', `data:image/png;base64,${'A'.repeat(40000)}`],
      ['a malformed body', 'data:image/png;base64,not valid base64 !!!'],
    ];

    for (const [label, value] of refusedAvatars) {
      // Re-establish a good avatar first, so "cleared" is a real change.
      await ask(guest, 'media:avatar', { avatar: TINY_JPEG });
      await sleep(120);

      const cleared = once(host, 'participant:updated');
      await ask(guest, 'media:avatar', { avatar: value });
      const payload = await cleared;
      check(`${label} is refused and the avatar cleared`, payload?.avatar === null, String(payload?.avatar).slice(0, 40));
      await sleep(120);
    }

    // Speaking is only believed while the microphone is actually on.
    let sawSpeaking = null;
    host.on('participant:updated', (payload) => {
      if (payload.id === joined.data.self.id && 'speaking' in payload) sawSpeaking = payload.speaking;
    });

    guest.emit('media:speaking', { speaking: true });
    await sleep(400);
    check('speaking is ignored while the mic is off', sawSpeaking !== true, String(sawSpeaking));

    guest.emit('media:mic', { micOn: true });
    await sleep(250);
    guest.emit('media:speaking', { speaking: true });
    await sleep(400);
    check('speaking is broadcast once the mic is on', sawSpeaking === true, String(sawSpeaking));

    // Muting must clear the halo rather than leave it lit.
    sawSpeaking = null;
    guest.emit('media:mic', { micOn: false });
    await sleep(400);
    check('muting clears the speaking state', sawSpeaking === false, String(sawSpeaking));

    /* ------------------------------------------------- Signal containment */
    console.log('\nSignal relay containment');
    const other = await connect();
    const otherRoom = await ask(other, 'room:create', { name: 'Elsewhere', protocolVersion: PROTOCOL_VERSION });

    let leaked = false;
    other.on('signal', () => {
      leaked = true;
    });

    // A client in room A addresses a socket in room B directly.
    guest.emit('signal', {
      to: otherRoom.data.self.id,
      body: { kind: 'description', description: { type: 'offer', sdp: 'v=0\r\n' } },
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    check('signals cannot cross room boundaries', leaked === false);

    let chatLeaked = false;
    other.on('chat:message', () => {
      chatLeaked = true;
    });
    // The flood test above drained the chat bucket; let it refill so this
    // send genuinely goes out, otherwise the check passes for the wrong reason.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const contained = await ask(guest, 'chat:send', { text: 'should not escape this room' });
    await new Promise((resolve) => setTimeout(resolve, 600));
    check('chat containment probe was actually sent', contained.ok === true, contained.error ?? '');
    check('chat cannot cross room boundaries', chatLeaked === false);

    let selfLeak = false;
    guest.on('signal', () => {
      selfLeak = true;
    });
    guest.emit('signal', { to: joined.data.self.id, body: { kind: 'candidate', candidate: { candidate: 'x' } } });
    await new Promise((resolve) => setTimeout(resolve, 500));
    check('malformed candidate payloads are dropped', selfLeak === false);

    other.disconnect();

    /* ---------------------------------------------------- Host succession */
    console.log('\nHost succession');
    const promoted = once(guest, 'you:promoted');
    const stateAfterLeave = once(guest, 'room:state');
    host.disconnect();

    check('remaining participant is promoted', (await promoted) !== null);
    const snapshot = await stateAfterLeave;
    check('promoted client becomes the room host', snapshot?.hostId === joined.data.self.id);

    const nowHostCan = await ask(guest, 'host:regenerate-code');
    check('new host holds real authority', nowHostCan.ok === true, nowHostCan.error ?? '');
    check(
      'rotated code differs from the original',
      nowHostCan.ok && nowHostCan.data.code !== code,
      nowHostCan.ok ? nowHostCan.data.code : '',
    );

    const oldCodeJoin = await ask(outsider, 'room:join', {
      code,
      name: 'Late',
      protocolVersion: PROTOCOL_VERSION,
    });
    check('the old code stops working', oldCodeJoin.error === 'ROOM_NOT_FOUND', oldCodeJoin.error);

    /* --------------------------------- Stream happy path (permissive server) */
    // The fixture stream lives on localhost, which the strict server rightly
    // refuses. A second server started with ALLOW_PRIVATE_STREAM_HOSTS=1 is
    // where the working paths are exercised.
    if (PERMISSIVE_URL) {
      console.log('\nStream playback and playlists (permissive server)');
      await runPermissiveStreamChecks();
    } else {
      console.log('\nStream playback and playlists — skipped (PERMISSIVE_SIGNALING_URL unset)');
    }

  } finally {
    for (const socket of [host, guest, outsider]) socket.disconnect();
  }
}

async function runPermissiveStreamChecks() {
  const owner = await connect(PERMISSIVE_URL);
  const viewer = await connect(PERMISSIVE_URL);

  try {
    const created = await ask(owner, 'room:create', {
      name: 'Owner',
      protocolVersion: PROTOCOL_VERSION,
    });
    const joined = await ask(viewer, 'room:join', {
      code: created.data.room.code,
      name: 'Viewer',
      protocolVersion: PROTOCOL_VERSION,
    });

    const changed = once(viewer, 'stream:changed');
    const started = await ask(owner, 'stream:start', {
      url: `${FIXTURE}/hls/stream.m3u8`,
      title: 'Test channel',
    });
    check('host can start a stream', started.ok === true, started.error ?? '');
    check('everyone is told about it', (await changed)?.url?.includes('stream.m3u8') === true);
    check('title is carried through', started.ok && started.data.title === 'Test channel');
    check('an unspecified kind defaults to media', started.ok && started.data.kind === 'media');

    // Embeds take the same path and the same URL guard; only the rendering
    // differs, so the server treats the kind as a label and nothing more.
    await ask(owner, 'stream:stop');
    const embedChanged = onceWhere(viewer, 'stream:changed', (payload) => payload !== null);
    const embed = await ask(owner, 'stream:start', {
      url: `${FIXTURE}/embed.html`,
      kind: 'embed',
      title: 'Embed fixture',
    });
    check('an embed can be put on the stage', embed.ok === true, embed.error ?? '');
    check('the embed kind is carried through', (await embedChanged)?.kind === 'embed');

    const embedSync = once(viewer, 'stream:sync', 1200);
    owner.emit('stream:control', { playing: true, positionSeconds: 12 });
    check('embeds broadcast no playback sync', (await embedSync) === null);

    const badEmbed = await ask(owner, 'stream:start', {
      url: 'javascript:alert(1)',
      kind: 'embed',
    });
    check('embeds get the same URL guard', badEmbed.error === 'INVALID_URL', badEmbed.error);

    const unknownKind = await ask(owner, 'stream:start', {
      url: `${FIXTURE}/hls/stream.m3u8`,
      kind: 'something-else',
    });
    check(
      'an unknown kind falls back to media rather than passing through',
      unknownKind.ok === false || unknownKind.data?.kind === 'media',
      unknownKind.ok ? unknownKind.data.kind : unknownKind.error,
    );
    await ask(owner, 'stream:stop');

    const restarted = await ask(owner, 'stream:start', {
      url: `${FIXTURE}/hls/stream.m3u8`,
      title: 'Test channel',
    });
    check('media playback resumes after the embed', restarted.ok === true, restarted.error ?? '');

    const hijack = await ask(viewer, 'stream:start', { url: `${FIXTURE}/hls/stream.m3u8` });
    check(
      'a viewer cannot replace a running stream',
      hijack.error === 'NOT_ALLOWED_TO_SHARE',
      hijack.error,
    );

    await ask(owner, 'host:grant-share', { targetId: joined.data.self.id });
    const hijackWithPermission = await ask(viewer, 'stream:start', {
      url: `${FIXTURE}/hls/stream.m3u8`,
    });
    check(
      'even a permitted guest cannot take over a running stream',
      hijackWithPermission.error === 'STREAM_ALREADY_RUNNING',
      hijackWithPermission.error,
    );

    const stopByViewer = await ask(viewer, 'stream:stop');
    check(
      'a non-controller cannot stop it',
      stopByViewer.error === 'NOT_STREAM_CONTROLLER',
      stopByViewer.error,
    );

    const latecomer = await connect(PERMISSIVE_URL);
    const lateJoin = await ask(latecomer, 'room:join', {
      code: created.data.room.code,
      name: 'Late',
      protocolVersion: PROTOCOL_VERSION,
    });
    check(
      'a late joiner receives the running stream',
      lateJoin.ok && lateJoin.data.room.stream?.url?.includes('stream.m3u8') === true,
    );

    // Followers get the controller's position, so a late joiner starts in step.
    const synced = once(viewer, 'stream:sync');
    owner.emit('stream:control', { playing: true, positionSeconds: 42 });
    const syncPayload = await synced;
    check('playback position is synced to followers', syncPayload?.positionSeconds === 42);

    latecomer.disconnect();

    const stopped = await ask(owner, 'stream:stop');
    check('the controller can stop it', stopped.ok === true, stopped.error ?? '');

    const playlist = await ask(owner, 'stream:load-playlist', { url: `${FIXTURE}/channels.m3u` });
    check('playlist is fetched and parsed', playlist.ok === true, playlist.error ?? '');
    check('channels are extracted', playlist.ok && playlist.data.entries.length === 3);
    check(
      'channel names and groups survive',
      playlist.ok &&
        playlist.data.entries[0].name === 'Channel One' &&
        playlist.data.entries[0].group === 'Test',
      playlist.ok ? playlist.data.entries[0].name : '',
    );

    const manifest = await ask(owner, 'stream:load-playlist', { url: `${FIXTURE}/hls/stream.m3u8` });
    check(
      'an HLS manifest is not mistaken for a channel list',
      manifest.error === 'PLAYLIST_NOT_A_LIST',
      manifest.error,
    );

    const emptyPlaylist = await ask(owner, 'stream:load-playlist', { url: `${FIXTURE}/empty.m3u` });
    check('an empty playlist is reported', emptyPlaylist.error === 'PLAYLIST_EMPTY', emptyPlaylist.error);

    /*
     * Every way a playlist host can let you down has to arrive as its own
     * code. Collapsing them into one "could not be read" is what sends
     * someone checking their internet connection when the host actually
     * answered with 403.
     */
    // Each fetch costs three action tokens, so these are spaced out to let
    // the bucket refill. Bunching them tests the rate limiter, not the
    // failure codes.
    await sleep(1000);
    const refused = await ask(owner, 'stream:load-playlist', { url: `${FIXTURE}/refuse.m3u` });
    check(
      'a host that refuses is reported as refused',
      refused.error === 'PLAYLIST_REFUSED',
      refused.error,
    );
    check(
      'the upstream status travels with it',
      refused.error === 'PLAYLIST_REFUSED' && refused.detail === '403',
      String(refused.detail),
    );

    await sleep(1000);
    const huge = await ask(owner, 'stream:load-playlist', { url: `${FIXTURE}/huge.m3u` }, 40_000);
    check(
      'a playlist past the size ceiling is reported as too large',
      huge.error === 'PLAYLIST_TOO_LARGE',
      huge.error,
    );

    await sleep(1000);
    const stalled = await ask(owner, 'stream:load-playlist', { url: `${FIXTURE}/slow.m3u` }, 40_000);
    check(
      'a host that never answers is reported as a timeout',
      stalled.error === 'PLAYLIST_TIMEOUT',
      stalled.error,
    );

    await sleep(1000);
    const dead = await ask(owner, 'stream:load-playlist', {
      url: 'http://carpe-diem-nonexistent-host.invalid/list.m3u',
    });
    check(
      'a host that does not resolve is reported as unreachable',
      dead.error === 'PLAYLIST_UNREACHABLE',
      dead.error,
    );
  } finally {
    owner.disconnect();
    viewer.disconnect();
  }
}

main()
  .then(() => {
    console.log(`\n${total - failures}/${total} checks passed`);
    process.exit(failures > 0 ? 1 : 0);
  })
  .catch((error) => {
    console.error('\nRun failed:', error);
    process.exit(1);
  });
