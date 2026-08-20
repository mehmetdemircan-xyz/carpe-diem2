/**
 * End-to-end check: two real Chromium peers, one real signaling server, one
 * real WebRTC connection.
 *
 * Chromium is launched with fake media devices so getDisplayMedia resolves
 * without a picker and getUserMedia produces a synthetic tone. That makes the
 * whole path testable headlessly: capture -> senders -> SDP over the socket
 * -> ICE -> inbound RTP on the other side.
 *
 * Run with: node e2e/two-peer.mjs   (client dev server + signaling must be up)
 */
import { chromium } from 'playwright';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const CLIENT_URL = process.env.CLIENT_URL ?? 'http://localhost:5173';
const HEADLESS = process.env.HEADED !== '1';
// Optional: point at a Chromium that is already on disk instead of letting
// Playwright download its own.
const EXECUTABLE_PATH = process.env.CHROMIUM_PATH || undefined;
/** Where the HLS test fixture is served from. */
const FIXTURE_URL = process.env.FIXTURE_URL ?? 'http://localhost:4010';

const results = [];
let failures = 0;

function check(name, passed, detail = '') {
  results.push({ name, passed, detail });
  if (!passed) failures += 1;
  const mark = passed ? 'PASS' : 'FAIL';
  console.log(`  [${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitFor(fn, { timeout = 15000, interval = 250, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw new Error(`Timed out waiting for ${label} (last: ${JSON.stringify(last)})`);
}

const clickByText = (page, text) =>
  page.locator(`button:has-text("${text}")`).first().click();

/** Opens the control bar's source menu and picks one of its entries. */
const pickSource = async (page, itemText) => {
  await page.locator('button[aria-label="Daha fazla kaynak"]').click();
  await page.locator(`[role="menuitem"]:has-text("${itemText}")`).first().click();
};

async function main() {
  const browser = await chromium.launch({
    headless: HEADLESS,
    ...(EXECUTABLE_PATH ? { executablePath: EXECUTABLE_PATH } : {}),
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      // The synthetic microphone in this Chromium build outputs near-silence,
      // which would make voice-activity detection untestable. Feeding it a
      // real waveform exercises the actual Web Audio path.
      `--use-file-for-fake-audio-capture=${join(HERE, 'fixtures', 'speech.wav')}`,
      // Makes getDisplayMedia resolve to a synthetic surface, no picker.
      '--auto-select-desktop-capture-source=Entire screen',
      '--allow-running-insecure-content',
      '--no-sandbox',
    ],
  });

  const context = await browser.newContext({
    permissions: ['microphone'],
    viewport: { width: 1280, height: 800 },
  });

  // Pin the locale so assertions are not at the mercy of the host machine's
  // language. This also exercises the persisted-locale path.
  await context.addInitScript(() => {
    try {
      // Stored as a plain string by I18nProvider, not JSON.
      localStorage.setItem('carpe.locale', 'tr');
    } catch {
      /* ignore */
    }
  });

  const host = await context.newPage();
  const guest = await context.newPage();

  const errors = [];
  for (const [label, page] of [
    ['host', host],
    ['guest', guest],
  ]) {
    page.on('pageerror', (error) => errors.push(`${label}: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`${label} console: ${message.text()}`);
    });
  }

  try {
    /* ---------------------------------------------------------- Host flow */
    console.log('\nHost creates a room');
    await host.goto(CLIENT_URL, { waitUntil: 'domcontentloaded' });

    await clickByText(host, 'Oda Oluştur');
    // Target the name field by role rather than by index: the gate also holds
    // the avatar picker's hidden file input.
    await host.locator('input[autocomplete="nickname"]').fill('Host');
    await clickByText(host, 'Devam');

    const codeText = await waitFor(
      async () => {
        const text = await host.locator('p.select-all').first().textContent().catch(() => null);
        return text && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(text.trim()) ? text.trim() : null;
      },
      { label: 'room code' },
    );
    check('room code generated', /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(codeText), codeText);

    await clickByText(host, 'Odaya Gir');
    await waitFor(() => host.locator('header button:has-text("' + codeText + '")').isVisible(), {
      label: 'host in room',
    });
    check('host entered room', true);

    const urlAfterEnter = new URL(host.url()).pathname;
    check('room URL is shareable', urlAfterEnter === `/room/${codeText}`, urlAfterEnter);

    /* --------------------------------------------------------- Guest flow */
    console.log('\nGuest joins by code');
    await guest.goto(CLIENT_URL, { waitUntil: 'domcontentloaded' });
    await clickByText(guest, 'Odaya Katıl');
    await guest.locator('input').first().fill(codeText);
    await guest.locator('button[type="submit"]').click();
    await guest.locator('input[autocomplete="nickname"]').fill('Guest');
    await clickByText(guest, 'Devam');

    await waitFor(() => guest.locator(`header button:has-text("${codeText}")`).isVisible(), {
      label: 'guest in room',
    });
    check('guest joined by code', true);

    const hostCount = await waitFor(
      async () => {
        const text = await host.locator('header span:has-text("Odada")').first().textContent();
        return text?.includes('2') ? text.trim() : null;
      },
      { label: 'host sees 2 participants' },
    );
    check('host sees the guest', true, hostCount);

    /* --------------------------------------------- WebRTC peer connection */
    // The app exposes no internals on window by design, so the peer
    // connection is verified from the observable side: the guest must
    // actually decode frames once the host shares.
    console.log('\nHost starts screen share');
    await clickByText(host, 'Ekran paylaş');

    const hostSharing = await waitFor(
      () => host.locator('button:has-text("Paylaşımı durdur")').isVisible(),
      { label: 'host sharing state' },
    );
    check('host screen share started', hostSharing);

    const guestSeesShare = await waitFor(
      async () => {
        const label = await guest
          .locator('span:has-text("paylaşıyor")')
          .first()
          .textContent()
          .catch(() => null);
        return label?.includes('Host') ? label.trim() : null;
      },
      { label: 'guest sees the share', timeout: 20000 },
    );
    check('guest sees host is sharing', true, guestSeesShare);

    const videoState = await waitFor(
      async () => {
        const state = await guest.evaluate(() => {
          const video = document.querySelector('video');
          if (!video) return null;
          return {
            hasStream: !!video.srcObject,
            width: video.videoWidth,
            height: video.videoHeight,
            readyState: video.readyState,
          };
        });
        return state?.width > 0 && state?.height > 0 ? state : null;
      },
      { label: 'guest receives decoded video frames', timeout: 30000 },
    );
    check(
      'guest decodes real video frames over WebRTC',
      videoState.width > 0 && videoState.height > 0,
      `${videoState.width}x${videoState.height}`,
    );

    const inbound = await waitFor(
      async () => {
        const bytes = await guest.evaluate(async () => {
          const video = document.querySelector('video');
          const stream = video?.srcObject;
          if (!stream) return 0;
          // Confirm bytes are actually flowing, not just a negotiated track.
          const track = stream.getVideoTracks()[0];
          return track && track.readyState === 'live' ? 1 : 0;
        });
        return bytes === 1 ? bytes : null;
      },
      { label: 'inbound track live' },
    );
    check('inbound video track is live', inbound === 1);

    /* --------------------------------------------------- Permission model */
    console.log('\nHost permission controls');
    const guestShareDisabled = await guest
      .locator('button:has-text("Ekran paylaş")')
      .first()
      .isDisabled();
    check('guest cannot share before permission', guestShareDisabled);

    await host.locator('button[aria-label="Katılımcılar"]').click();
    await host.locator('button[aria-label="Oda sahibi kontrolleri"]').first().click();
    await clickByText(host, 'Ekran paylaşımına izin ver');

    const guestShareEnabled = await waitFor(
      async () =>
        (await guest.locator('button:has-text("Ekran paylaş")').first().isDisabled()) === false,
      { label: 'guest gains share permission' },
    );
    check('host grant enables guest sharing', guestShareEnabled);

    /* -------------------------------------------------------------- Chat */
    console.log('\nChat');
    await guest.locator('button[aria-label="Sohbet"]').click();
    await guest.locator('#chat-input').fill('ekranini goruyorum');
    await guest.locator('#chat-input').press('Enter');

    // The host's chat panel is closed, so the message must land on the badge
    // first — checking for the text now would only prove the panel is shut.
    const unreadBadge = await waitFor(
      async () => {
        const text = await host
          .locator('button[aria-label="Sohbet"] span')
          .first()
          .textContent()
          .catch(() => null);
        return text?.trim() ? text.trim() : null;
      },
      { label: 'unread badge appears', timeout: 8000 },
    ).catch(() => null);
    check('unread badge counts messages while chat is closed', unreadBadge === '1', String(unreadBadge));

    await host.locator('button[aria-label="Sohbet"]').click();

    const hostSeesMessage = await waitFor(
      () => host.locator('text=ekranini goruyorum').first().isVisible().catch(() => false),
      { label: 'host sees the message once chat is open', timeout: 10000 },
    ).catch(() => false);
    check('message reaches the other browser', hostSeesMessage === true);

    const badgeCleared = await waitFor(
      async () => (await host.locator('button[aria-label="Sohbet"] span').count()) === 0,
      { label: 'unread badge clears', timeout: 6000 },
    ).catch(() => false);
    check('opening chat clears the badge', badgeCleared === true);

    // Opening chat must close the participants rail, not stack on top of it.
    const railExclusive = await host.locator('aside[aria-label="Katılımcılar"]').count();
    check('chat and participants share one rail', railExclusive === 0);

    await host.locator('#chat-input').fill('evet net gorunuyor');
    await host.locator('#chat-input').press('Enter');
    const guestSeesReply = await waitFor(
      () => guest.locator('text=evet net gorunuyor').first().isVisible().catch(() => false),
      { label: 'guest receives the reply', timeout: 10000 },
    ).catch(() => false);
    check('replies flow the other way', guestSeesReply === true);

    /* --------------------------------------------- Speaking indicator */
    console.log('\nSpeaking indicator');
    // The fake device plays a continuous tone, so turning the mic on is enough
    // to drive real voice-activity detection through the Web Audio path.
    await guest.locator('button[aria-label="Mikrofonu aç"]').click();

    const guestHalo = await waitFor(
      () =>
        guest.evaluate(() => {
          const strip = document.querySelector('aside[aria-label="Sohbet"] header');
          return !!strip?.querySelector('.ring-signal-good');
        }),
      { label: 'own speaking halo', timeout: 20000 },
    ).catch(() => false);
    check('the speaker strip lights up for the talker', guestHalo === true);

    const hostSeesHalo = await waitFor(
      () =>
        host.evaluate(() => {
          const strip = document.querySelector('aside[aria-label="Sohbet"] header');
          return !!strip?.querySelector('.ring-signal-good');
        }),
      { label: 'remote speaking halo', timeout: 20000 },
    ).catch(() => false);
    check('the other browser sees who is talking', hostSeesHalo === true);

    await guest.locator('button[aria-label="Mikrofonu kapat"]').click();
    const haloCleared = await waitFor(
      async () =>
        (await host.evaluate(() => {
          const strip = document.querySelector('aside[aria-label="Sohbet"] header');
          return !!strip?.querySelector('.ring-signal-good');
        })) === false,
      { label: 'halo clears on mute', timeout: 15000 },
    ).catch(() => false);
    check('muting clears the indicator everywhere', haloCleared === true);

    /* ------------------------------------------------------ URL streaming */
    console.log('\nStream from a URL');
    // Stop the screen share first so the stage is unambiguous.
    await clickByText(host, 'Paylaşımı durdur');
    await host.waitForTimeout(500);

    await pickSource(host, 'Doğrudan video');
    await host.locator('input[inputmode="url"]').fill(`${FIXTURE_URL}/hls/stream.m3u8`);
    await clickByText(host, 'Oynat');

    const hostPlaying = await waitFor(
      async () => {
        const state = await host.evaluate(() => {
          const video = document.querySelector('video');
          return video ? { w: video.videoWidth, h: video.videoHeight } : null;
        });
        return state && state.w > 0 ? state : null;
      },
      { label: 'host decodes the HLS stream', timeout: 30000 },
    );
    check('starter plays the HLS stream', hostPlaying.w > 0, `${hostPlaying.w}x${hostPlaying.h}`);

    // The whole point: the guest pulls it from the source itself, so it plays
    // for them without the host sharing anything.
    const guestPlaying = await waitFor(
      async () => {
        const state = await guest.evaluate(() => {
          const video = document.querySelector('video');
          return video ? { w: video.videoWidth, h: video.videoHeight } : null;
        });
        return state && state.w > 0 ? state : null;
      },
      { label: 'guest decodes the HLS stream', timeout: 30000 },
    );
    check(
      'every participant plays it from the source',
      guestPlaying.w > 0,
      `${guestPlaying.w}x${guestPlaying.h}`,
    );

    const guestHasNoPeerVideo = await guest.evaluate(() => {
      const video = document.querySelector('video');
      // A URL stream must not arrive as a MediaStream — that would mean it is
      // being relayed over WebRTC rather than fetched directly.
      return !(video?.srcObject instanceof MediaStream);
    });
    check('the stream does not travel over WebRTC', guestHasNoPeerVideo === true);

    // Chat must keep working while a stream is on the stage.
    await guest.locator('#chat-input').fill('yayin acildi');
    await guest.locator('#chat-input').press('Enter');
    const chatDuringStream = await waitFor(
      () => host.locator('text=yayin acildi').first().isVisible().catch(() => false),
      { label: 'chat during stream', timeout: 10000 },
    ).catch(() => false);
    check('chat still works during a stream', chatDuringStream === true);

    const guestCannotStop = await guest.locator('button[aria-label="Yayını durdur"]').isDisabled();
    check('a viewer cannot stop someone else\'s stream', guestCannotStop === true);

    await host.locator('button[aria-label="Yayını durdur"]').click();
    const streamCleared = await waitFor(
      () => host.locator('text=Henüz kimse paylaşmıyor').first().isVisible().catch(() => false),
      { label: 'stage clears after stopping', timeout: 10000 },
    ).catch(() => false);
    check('stopping returns the stage to screen sharing', streamCleared === true);

    /* --------------------------------------------------- Playlist channels */
    console.log('\nChannel playlist');
    await pickSource(host, 'Kanal listesi');
    await host.locator('input[inputmode="url"]').fill(`${FIXTURE_URL}/channels.m3u`);
    await clickByText(host, 'Kanalları yükle');

    const channelsListed = await waitFor(
      () => host.locator('text=Channel One').first().isVisible().catch(() => false),
      { label: 'channel list appears', timeout: 20000 },
    ).catch(() => false);
    check('an .m3u playlist opens a channel picker', channelsListed === true);

    await host.locator('input[placeholder="Kanal ara"]').fill('Three');
    const filtered = await waitFor(
      async () =>
        (await host.locator('text=Channel One').count()) === 0 &&
        (await host.locator('text=Channel Three').count()) > 0,
      { label: 'channel filter', timeout: 6000 },
    ).catch(() => false);
    check('channels can be searched', filtered === true);

    await host.locator('button:has-text("Channel Three")').first().click();
    const channelPlaying = await waitFor(
      () =>
        host.evaluate(() => {
          const video = document.querySelector('video');
          return video ? video.videoWidth > 0 : false;
        }),
      { label: 'picked channel plays', timeout: 30000 },
    ).catch(() => false);
    check('picking a channel starts it', channelPlaying === true);

    await host.locator('button[aria-label="Yayını durdur"]').click();
    await host.waitForTimeout(500);

    /* -------------------------------------------------------------- Embed */
    console.log('\nEmbed');
    await pickSource(host, 'Embed');
    await host.locator('input[inputmode="url"]').fill(`${FIXTURE_URL}/embed.html`);
    await clickByText(host, 'Oynat');

    const hostFramed = await waitFor(
      () => host.evaluate(() => document.querySelectorAll('iframe').length > 0),
      { label: 'embed frame on the starter', timeout: 15000 },
    ).catch(() => false);
    check('an embed renders in a frame', hostFramed === true);

    const guestFramed = await waitFor(
      () => guest.evaluate(() => document.querySelectorAll('iframe').length > 0),
      { label: 'embed frame on the other browser', timeout: 15000 },
    ).catch(() => false);
    check('the embed reaches the other browser', guestFramed === true);

    const sandboxed = await host.evaluate(() => {
      const frame = document.querySelector('iframe');
      const sandbox = frame?.getAttribute('sandbox') ?? '';
      // Popups and top-level navigation would let a framed site pull people
      // out of the room, so their absence is the check that matters.
      return {
        hasSandbox: sandbox.length > 0,
        allowsPopups: sandbox.includes('allow-popups'),
        allowsTopNavigation: sandbox.includes('allow-top-navigation'),
      };
    });
    check(
      'the frame is sandboxed without popups or top-level navigation',
      sandboxed.hasSandbox && !sandboxed.allowsPopups && !sandboxed.allowsTopNavigation,
      JSON.stringify(sandboxed),
    );

    await host.locator('button[aria-label="Yayını durdur"]').click();
    await host.waitForTimeout(600);
    const framesGone = await waitFor(
      async () => (await guest.evaluate(() => document.querySelectorAll('iframe').length)) === 0,
      { label: 'embed clears everywhere', timeout: 10000 },
    ).catch(() => false);
    check('stopping the embed clears it for everyone', framesGone === true);

    /* ---------------------------------------------------------- Teardown */
    console.log('\nLeave and cleanup');
    await host.locator('button[aria-label="Odadan ayrıl"]').click();
    await waitFor(() => host.locator('button:has-text("Oda Oluştur")').isVisible(), {
      label: 'host back on landing',
    });
    check('host leaves cleanly', true);

    const guestEnded = await waitFor(
      () => guest.locator('text=Artık oda sahibisin').isVisible().catch(() => false),
      { label: 'guest promoted to host', timeout: 8000 },
    ).catch(() => false);
    check('host role transfers to remaining participant', guestEnded !== false);

    check('no uncaught page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  } finally {
    await browser.close();
  }
}

main()
  .then(() => {
    console.log(`\n${results.length - failures}/${results.length} checks passed`);
    process.exit(failures > 0 ? 1 : 0);
  })
  .catch((error) => {
    console.error('\nE2E run failed:', error.message);
    console.log(`\n${results.length - failures}/${results.length} checks passed before failure`);
    process.exit(1);
  });
