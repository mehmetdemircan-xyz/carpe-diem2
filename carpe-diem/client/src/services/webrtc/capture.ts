import {
  QUALITY_LADDER,
  RESOLUTIONS,
  RESOLUTION_ORDER,
  type FrameRatePreset,
  type QualityRung,
  type ResolutionPreset,
} from '@/types/media';

export type CaptureFailure =
  | { kind: 'denied' }
  | { kind: 'unsupported' }
  | { kind: 'failed'; cause: string };

export interface CaptureSuccess {
  stream: MediaStream;
  /**
   * Present only when the person ticked "share tab audio" in the browser's own
   * picker. There is no way to request it on their behalf, and no attempt is
   * made to obtain audio any other way.
   */
  audioTrack: MediaStreamTrack | null;
  /** What the browser actually gave us, which may be below what was asked. */
  actual: { width: number; height: number; frameRate: number };
  /** Set when the granted capture is materially below the request. */
  fellBackFrom: ResolutionPreset | null;
}

export type CaptureResult = { ok: true; value: CaptureSuccess } | { ok: false; error: CaptureFailure };

export function isScreenShareSupported(): boolean {
  return typeof navigator.mediaDevices?.getDisplayMedia === 'function';
}

/**
 * Screen capture on mobile is either absent or silently broken in most
 * engines. Detecting it up front lets the UI explain instead of failing.
 */
export function isLikelyMobile(): boolean {
  if (typeof navigator === 'undefined') return false;
  const uaData = (navigator as Navigator & { userAgentData?: { mobile?: boolean } }).userAgentData;
  if (typeof uaData?.mobile === 'boolean') return uaData.mobile;
  return /Android|iPhone|iPad|iPod|Mobile|Silk/i.test(navigator.userAgent);
}

function buildConstraints(
  rung: QualityRung,
  frameRate: FrameRatePreset,
  preferTab: boolean,
): DisplayMediaStreamOptions {
  const size = RESOLUTIONS[rung.resolution];
  const fps = frameRate === 'auto' ? rung.frameRate : frameRate;

  const video: MediaTrackConstraints & Record<string, unknown> = {
    // `ideal` rather than `exact`: a monitor smaller than the request should
    // still share, just at its own size, instead of throwing OverconstrainedError.
    width: { ideal: size.width, max: size.width },
    height: { ideal: size.height, max: size.height },
    frameRate: { ideal: fps, max: fps },
  };

  if (preferTab) {
    // Hints, never constraints. They reorder the browser's own picker toward
    // tabs; the person still chooses what to share, and can pick a window or
    // a whole screen instead. Unsupported engines ignore them.
    video.displaySurface = 'browser';
  }

  return {
    video,
    // Tab audio, but only if the person ticks the box in the picker. Nothing
    // here can turn it on for them.
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    // Lets Chrome offer a "switch tab" control mid-share, which is what you
    // want when the point is watching something together.
    surfaceSwitching: 'include',
    // Keep this app's own tab out of the list — sharing it would just show a
    // recursive picture of the room.
    selfBrowserSurface: 'exclude',
  } as DisplayMediaStreamOptions;
}

/**
 * Requests a display capture, stepping down the resolution ladder when the
 * browser or device refuses. Returns what was actually granted so the caller
 * can tell the user their 4K request became 1440p.
 */
export async function captureScreen(
  resolution: ResolutionPreset,
  frameRate: FrameRatePreset,
  preferredRung: QualityRung,
  /** Nudges the picker toward the tab list when watching a page together. */
  preferTab = false,
): Promise<CaptureResult> {
  if (!isScreenShareSupported()) {
    return { ok: false, error: { kind: 'unsupported' } };
  }

  const requested = resolution === 'auto' ? preferredRung.resolution : resolution;
  const startIndex = RESOLUTION_ORDER.indexOf(requested);
  const attempts = startIndex === -1 ? [requested] : RESOLUTION_ORDER.slice(startIndex);

  let lastCause = 'unknown';

  for (const attempt of attempts) {
    const rung: QualityRung =
      QUALITY_LADDER.find(
        (candidate) =>
          candidate.resolution === attempt &&
          candidate.frameRate === (frameRate === 'auto' ? preferredRung.frameRate : frameRate),
      ) ??
      QUALITY_LADDER.find((candidate) => candidate.resolution === attempt) ??
      preferredRung;

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia(
        buildConstraints(rung, frameRate, preferTab),
      );
      const track = stream.getVideoTracks()[0];
      if (!track) {
        stream.getTracks().forEach((t) => t.stop());
        lastCause = 'no-video-track';
        continue;
      }

      const settings = track.getSettings();
      const actual = {
        width: settings.width ?? RESOLUTIONS[attempt].width,
        height: settings.height ?? RESOLUTIONS[attempt].height,
        frameRate: Math.round(settings.frameRate ?? rung.frameRate),
      };

      return {
        ok: true,
        value: {
          stream,
          audioTrack: stream.getAudioTracks()[0] ?? null,
          actual,
          // Only report a fallback when the ladder actually stepped down. A
          // small monitor giving us 1080p for a 1080p request is not a fallback.
          fellBackFrom: attempt !== requested ? requested : null,
        },
      };
    } catch (error) {
      const name = error instanceof DOMException ? error.name : 'Error';

      // The user pressed Cancel. Never retry — that would re-prompt them.
      if (name === 'NotAllowedError' || name === 'AbortError') {
        return { ok: false, error: { kind: 'denied' } };
      }
      // No capture device at all, or the engine has no implementation.
      if (name === 'NotFoundError' || name === 'NotSupportedError') {
        return { ok: false, error: { kind: 'unsupported' } };
      }
      // OverconstrainedError / NotReadableError: worth trying a lower rung.
      lastCause = name;
    }
  }

  return { ok: false, error: { kind: 'failed', cause: lastCause } };
}

/** Microphone capture with the processing chain that suits voice chat. */
export async function captureMicrophone(
  deviceId: string | null,
): Promise<{ ok: true; stream: MediaStream } | { ok: false; error: 'denied' | 'unavailable' }> {
  if (typeof navigator.mediaDevices?.getUserMedia !== 'function') {
    return { ok: false, error: 'unavailable' };
  }

  const audio: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
  if (deviceId) audio.deviceId = { ideal: deviceId };

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio, video: false });
    return { ok: true, stream };
  } catch (error) {
    const name = error instanceof DOMException ? error.name : 'Error';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return { ok: false, error: 'denied' };
    }
    return { ok: false, error: 'unavailable' };
  }
}

/**
 * Best-effort read on whether the GPU is doing the compositing. There is no
 * API for "is my encoder hardware accelerated", so this reports the closest
 * observable proxy and the UI labels it as such.
 */
export function detectHardwareAcceleration(): boolean | null {
  try {
    const canvas = document.createElement('canvas');
    const gl =
      canvas.getContext('webgl2') ??
      (canvas.getContext('webgl') as WebGLRenderingContext | null);
    if (!gl) return false;

    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    if (!debugInfo) return true; // WebGL works; renderer string is just hidden.

    const renderer = String(gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) ?? '');
    // SwiftShader / llvmpipe mean the GPU path is unavailable entirely.
    return !/swiftshader|llvmpipe|software/i.test(renderer);
  } catch {
    return null;
  }
}
