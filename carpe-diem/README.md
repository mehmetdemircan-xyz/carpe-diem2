# CARPE Diem.

Screen sharing, simplified. Create a room, share the code, share your screen. No accounts, no sign-up, nothing to install.

Real WebRTC screen sharing with low-latency voice, text chat, URL-based stream playback, a server-enforced host permission model, adaptive quality up to 4K, and a Turkish/English interface.

---

## Quick start

```bash
npm install
npm run dev
```

Open <http://localhost:5173>. The signaling server runs on `:3001`, the client on `:5173`.

To try it with two people, open the room link in a second browser window (or send the code to a friend on your network).

### Production

```bash
npm run build
npm start
```

The server serves the built client from the same origin, so `http://localhost:3001` gives you the whole app — no CORS setup, no second host.

> **Screen sharing requires a secure context.** Browsers only expose `getDisplayMedia` on `https://` or `localhost`. If you deploy this, put it behind TLS or the share button will not work.

---

## What actually works

Nothing here is a mock. Every control does what it says.

| Feature | Notes |
| --- | --- |
| Room creation & join by code | CSPRNG codes, ~8.5 × 10¹¹ keyspace, unambiguous alphabet |
| Real WebRTC screen sharing | `getDisplayMedia`, full screen / window / tab |
| Low-latency voice | Echo cancellation, noise suppression, per-peer audio elements |
| Text chat | Relayed, never stored; sits below the video so you can watch and type at once |
| Who's speaking | Voice activity detected locally, shown as a lit ring in the chat header |
| Optional profile picture | Downscaled in the browser to a 96px JPEG; initials otherwise |
| Play a stream from a URL | .m3u8 (HLS) direct, or an .m3u playlist with a channel picker |
| Embed a platform player | The platform's own embed address, in a sandboxed frame |
| Watch a web page together | Opens the page, then shares that browser tab over WebRTC |
| Tab audio | Mixed with the microphone onto the existing audio transceiver |
| Push-to-talk | Custom key binding, survives alt-tab |
| Resolution: 720p / 1080p / 1440p / 4K | With automatic fallback when the device refuses |
| Frame rate: 30 / 60 FPS | Also falls back |
| Adaptive quality | `getStats`-driven ladder with hysteresis |
| Host permission model | Grant, revoke, force-stop, kick, transfer, close, rotate code |
| Connection indicator | Latency, packet loss, live outgoing bitrate |
| Host succession | Longest-tenured participant inherits the room |
| Turkish / English | Switchable anywhere, remembered |
| Device selection | Mic input, and speaker output where the browser supports it |

---

## Architecture

```
client (React + TS + Vite + Tailwind)
   |
   |  Socket.IO — signaling only, never media
   v
server (Node + TS + Socket.IO)         <-- the authority
   |
   |  SDP + ICE relayed between peers in the same room
   v
WebRTC full mesh — media flows peer to peer, never through the server
```

### Full mesh, and why

Each participant holds one `RTCPeerConnection` per other participant. No media server, no per-stream cost, minimum latency. That works well up to about six people, which is the cap the server enforces (`MAX_PARTICIPANTS` in `shared/src/protocol.ts`).

Past that you want an SFU. Every consumer talks to the `MediaTransport` interface in `client/src/services/webrtc/PeerMesh.ts` rather than to the mesh directly, so adding one means writing a second implementation of that interface — no UI changes.

### Two decisions worth knowing about

**Transceivers are created once and never renegotiated.** One audio and one video transceiver are established at connect time, and starting or stopping a screen share is a `replaceTrack` call. Renegotiation storms are the biggest source of flakiness in mesh WebRTC, and this removes them entirely.

There is a subtlety that will bite anyone who touches this code: per JSEP, a transceiver created by `addTransceiver` is **not** eligible for matching against an incoming remote offer — only ones implied by `addTrack` are. An answerer that pre-creates transceivers therefore ends up with two dead ones plus a fresh `recvonly` pair built from the offer, and media only ever flows one way. So only the offerer creates transceivers; the answerer adopts the offer's and widens them to `sendrecv` before answering. See `adoptTransceivers`.

**Only the newcomer sends offers.** A joining client is told exactly who to offer to; nobody offers back. Glare is therefore impossible and no polite/impolite tie-breaking is needed. Rollback handling is still present as a safety net for reconnects.

### Knowing who is talking

Voice activity is measured on your own microphone with an `AnalyserNode` and broadcast on transitions only — a boolean when speech starts and another when it stops, not a stream of levels. The alternative, analysing every incoming stream, would cost an AudioContext per peer and would go silent the moment somebody muted their speakers, which is exactly when you still want to know who is talking.

Thresholds are asymmetric on purpose: speech starts at a higher level than it ends at, and ending also needs the level to stay low for about a third of a second. Without that gap the indicator flickers on every sibilant. Push-to-talk needs no special handling at all — a disabled track emits silence, so the meter reads zero and reports "not speaking", which is the truth.

### Four ways onto the stage

The control bar's source menu offers four routes, and the difference between them is what actually travels:

| Route | What is distributed | What each client does |
| --- | --- | --- |
| Direct video | The `.m3u8` / `.mp4` address | Plays it from the source |
| Channel list | The `.m3u` address | Server parses it; picking a channel plays that address |
| Embed | The platform's embed address | Renders it in a sandboxed iframe |
| Share a web page | **Nothing** | The sharer's tab goes over WebRTC like any screen share |

Only the last one carries pixels. The first three hand out an address and let every browser fetch it itself.

**No route reads a page.** Nothing fetches a web page's markup, hunts for a media address inside it, or proxies media through this server. A pasted page address is classified as a page (`features/stream/urlKind.ts`, a pure string check) and the only thing offered for it is the browser's own capture picker — which the person answering it chooses from, and can decline.

**Embeds are framed, not driven.** A cross-origin frame cannot be controlled from outside its origin, so embed playback is deliberately not synchronised: everyone plays and pauses their own copy, and the server drops any position sent for an embed. The frame's sandbox allows scripts and its own origin because no player works without them, and withholds popups, downloads, form submission and top-level navigation so a framed site cannot pull anyone out of the room. A site that refuses to be framed stays blank; that refusal is respected rather than worked around.

**Tab audio reaches everyone.** `getDisplayMedia` is asked for audio, and when the person ticks "share tab audio" in the picker that track is mixed with their microphone through a Web Audio graph and sent on the existing audio transceiver. Mixing rather than adding a second track is what keeps the m-line layout fixed — see `services/webrtc/AudioMixer.ts`.

### Streaming a URL

Someone with sharing permission can put an `.m3u8` (HLS) stream on the stage. The URL is distributed to the room and **every client fetches the media itself, directly from the source** — nothing streams through the signaling server or over WebRTC. That means the person who started it spends no upload bandwidth, the picture is whatever the source serves rather than a re-encode, and a room of six costs the same as a room of one.

Paste an `.m3u` playlist instead and you get a searchable channel picker. Playlists are fetched and parsed **on the server**, because most playlist hosts send no CORS headers and a browser fetch would simply fail.

Playback position is synced from whoever started it, so a late joiner lands in roughly the right place. Live streams skip that — everyone is already at the live edge and seeking would only cause stalls.

Two limits worth knowing before you rely on this:

- **The source must allow cross-origin playback.** Outside Safari, HLS needs Media Source Extensions, which means the stream host has to send CORS headers. Many public links do not, and there is no way around that from the browser. The app says so plainly rather than failing silently. Proxying the media through your own server would fix it, but that is a different product with real bandwidth and legal implications, so it is deliberately not built in.
- **Private and loopback addresses are rejected by default.** A stream URL is loaded by everyone's browser and the playlist fetcher runs on the server, so both are ways to reach an internal network. Set `ALLOW_PRIVATE_STREAM_HOSTS=1` only if you are streaming from a media server on your own LAN and everyone in the room is already trusted there.

---

## Security

The room code is the only credential, so the server treats every client as untrusted.

- **Host authority is verified server-side, on every action.** `requireHost()` re-derives the role from the room the socket is actually in. A client that patches out its own UI checks and emits `host:close-room` directly gets `NOT_HOST`. There is a test for exactly this.
- **Sharing permission is server state.** `share:start` is rejected unless the server has recorded that this participant may share. Hiding the button is a convenience, not the control.
- **Signal relay is room-scoped.** A signal is forwarded only when sender and recipient are provably in the same room, which stops cross-room probing and SDP injection.
- **Codes are CSPRNG-generated** from `crypto.randomInt`, over an alphabet with no ambiguous characters, and joins are rate-limited — brute-forcing a live room is not viable.
- **Rate limits** on signals, actions, and join attempts, per socket.
- **Display names and chat text are sanitized** of control codes, zero-width characters, and bidi overrides, which are the practical ways to spoof another participant's name.
- **Avatars are validated before they reach anyone.** Only `data:image/(png|jpeg|webp)` with a well-formed base64 body and a 32KB ceiling. SVG is refused even though an `<img>` would not run its script, because the client re-encodes every picture to JPEG and the format buys nothing. Anything refused clears the picture rather than leaving a stale one.
- **Speaking state is not taken on trust.** The server drops a `speaking: true` from anyone whose microphone it has not been told is on, and clears the flag when they mute, so nobody can leave a permanent halo lit on their own name.
- **Chat is relayed, never stored.** The server holds no transcript, so a room's conversation exists only in the browsers that were present for it — which also means a late joiner sees no history. That is the tradeoff, and it is the deliberate one: storing history would mean the operator holds everyone's messages. The sender's name is resolved from room state, never from the payload, so nobody can post under someone else's name.
- **Hosts cannot revoke their own permission**, which would otherwise lock the room's controls.
- **Stream URLs are validated before they are broadcast.** Only `http(s)`; no `javascript:`, `data:` or `file:`. Private, loopback, link-local, carrier-NAT and cloud-metadata addresses are refused, including IPv4 smuggled inside an IPv6 literal — `new URL()` normalizes `::ffff:127.0.0.1` to `::ffff:7f00:1`, so IPv6 is checked by allow-listing the globally routable `2000::/3` rather than by enumerating reserved ranges.
- **The playlist fetcher is SSRF-hardened.** It resolves DNS and checks the resulting addresses rather than trusting the hostname, follows redirects manually so every hop is re-validated, caps the response size, and times out.

### Before you deploy

Two environment variables matter, and the server warns at boot if either is missing in production:

- `CORS_ORIGINS` — your site's origin. Not needed for a single-origin deploy. Never `*`.
- `TURN_URL` / `TURN_USERNAME` / `TURN_CREDENTIAL` — **you need a TURN server in production.** STUN alone fails for symmetric NAT and most corporate firewalls, and those users will simply never connect. Run [coturn](https://github.com/coturn/coturn) or use a hosted provider.

See `server/.env.example`.

---

## Testing

Two suites, both against a running server. Neither uses mocks.

```bash
npm run dev            # app, in one terminal
npm run fixtures       # HLS test stream, in another

npm run test:server    # protocol-level, no browser
npm run test:e2e       # two real Chromium peers, real WebRTC
```

The streaming tests need two signaling servers: a strict one (which is where every URL guard is verified) and a permissive one started with `ALLOW_PRIVATE_STREAM_HOSTS=1` (which is where playback against the localhost fixture is verified):

```bash
SIGNALING_URL=http://localhost:3002 \
PERMISSIVE_SIGNALING_URL=http://localhost:3003 \
  npm run test:server
```

`test:server` speaks the wire protocol directly, so every UI guard is bypassed — this is what proves the permission model is real. 87 checks, including every URL guard, the SSRF protections, avatar validation, and that embeds get the same guard as media.

`test:e2e` drives two browsers through create → join → share → grant → chat → speak → stream → leave with fake media devices. It asserts the guest **decodes actual video frames** over the peer connection, that the speaking indicator lights up in *both* browsers from real audio, that a URL stream plays in both *without* travelling over WebRTC, and that an embed renders sandboxed in both. 35 checks. It found the transceiver bug described above.

Two fixtures exist because of what this Chromium build lacks, not because of anything in the app:

- The HLS stream is VP9/Opus rather than the H.264/AAC real streams use — the open-source build ships without proprietary codecs.
- `e2e/fixtures/speech.wav` is fed in with `--use-file-for-fake-audio-capture`, because the synthetic microphone in this build outputs near-silence and there would be no voice activity to detect.

If Playwright's bundled Chromium is not available, point at one you have:

```bash
CHROMIUM_PATH=/path/to/chrome npm run test:e2e
```

---

## Project layout

```
shared/src/protocol.ts        Wire protocol — single source of truth for both sides

server/src/
  config.ts                   Env, ICE servers, production warnings
  streams/urlGuard.ts         Stream URL validation and SSRF protection
  streams/playlist.ts         Server-side .m3u fetch and parse
  rooms/codes.ts              Code generation and normalization
  rooms/RoomStore.ts          Room state, roles, succession
  signaling/registerHandlers.ts   Every socket event; all authority checks
  utils/rateLimit.ts          Token buckets

client/src/
  services/webrtc/
    PeerMesh.ts               MediaTransport implementation (swap for an SFU here)
    capture.ts                getDisplayMedia/getUserMedia with fallback ladders
    adaptive.ts               Quality ladder with hysteresis
    stats.ts                  getStats -> latency, loss, verdict
  services/signaling/         Socket.IO wrapper with typed acks
  features/room/              Session hook, reducer, stage, controls, settings
  features/participants/      Participants panel and host controls
  features/chat/              Chat panel
  features/stream/            HLS player (lazy hls.js), embed frame, channel picker,
                              and the pure URL classifier
  services/webrtc/AudioMixer.ts   Microphone + tab audio on one transceiver
  features/profile/           Avatar picker and browser-side image downscale
  services/audio/             Voice activity detection
  features/audio/             Push-to-talk, remote audio elements
  features/screen-share/      Video surface
  i18n/                       TR/EN catalogues, typed against each other
  pages/                      Landing, name gate, room-created, room
```

### Notes for anyone extending this

- The i18n catalogues are typed against each other: a missing Turkish translation is a compile error, not a raw key in the UI.
- Room state lives in one reducer with bail-out comparisons, so an unrelated participant update does not re-render the panel.
- `useRoomSession` owns everything with a lifetime — socket, mesh, media, timers. Components never touch WebRTC.
- Runtime dependencies are React, Socket.IO and hls.js. The icons, router, toasts and modal are all local, which is why the main bundle gzips to about 31 KB. hls.js is roughly six times that on its own and is dynamically imported, so it only downloads for someone who actually plays a stream.
- Chat is a sibling of the stage, not an overlay. On a phone it takes a slice of the height and the video shrinks above it, because covering what you are watching in order to talk about it defeats the point.

---

## Known limits

- **Six participants.** Mesh connection count grows quadratically. The cap is deliberate; an SFU is the answer above it.
- **Two simultaneous screen shares.** Also deliberate — more will melt a laptop in a mesh.
- **Mobile cannot share a screen.** No mobile browser implements `getDisplayMedia` usefully. The app detects this and says so instead of failing silently; watching and talking work fine.
- **Rooms are in-memory.** A server restart drops them. Swapping `RoomStore` for Redis is the path to multiple server instances.
- **"Hardware acceleration" in settings is a proxy.** There is no API for "is my encoder hardware accelerated"; it reports whether the GPU path is available at all.
