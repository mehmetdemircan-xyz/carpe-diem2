/**
 * Quality model for outgoing screen shares.
 *
 * A "rung" is one step on the ladder the adaptive controller walks up and
 * down. Ordering matters: index 0 is the cheapest rung, and the controller
 * only ever moves one step at a time so a brief hiccup cannot dump a 4K share
 * to 720p in one go.
 */

export type ResolutionPreset = 'auto' | '720p' | '1080p' | '1440p' | '2160p';
export type FrameRatePreset = 'auto' | 30 | 60;

export interface Resolution {
  width: number;
  height: number;
}

export const RESOLUTIONS: Record<Exclude<ResolutionPreset, 'auto'>, Resolution> = {
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '1440p': { width: 2560, height: 1440 },
  '2160p': { width: 3840, height: 2160 },
};

export const RESOLUTION_LABELS: Record<ResolutionPreset, string> = {
  auto: 'Auto',
  '720p': '720p',
  '1080p': '1080p',
  '1440p': '1440p',
  '2160p': '4K',
};

/** Highest first — used when falling back from an unsupported request. */
export const RESOLUTION_ORDER: Array<Exclude<ResolutionPreset, 'auto'>> = [
  '2160p',
  '1440p',
  '1080p',
  '720p',
];

export interface QualityRung {
  resolution: Exclude<ResolutionPreset, 'auto'>;
  frameRate: 30 | 60;
  /**
   * Target bitrate in bits per second. Screen content is mostly static, so
   * these sit well below what the same resolution would need for camera video.
   */
  maxBitrate: number;
}

/** Cheapest to most expensive. The adaptive controller indexes into this. */
export const QUALITY_LADDER: QualityRung[] = [
  { resolution: '720p', frameRate: 30, maxBitrate: 1_200_000 },
  { resolution: '1080p', frameRate: 30, maxBitrate: 2_500_000 },
  { resolution: '1440p', frameRate: 30, maxBitrate: 5_000_000 },
  { resolution: '2160p', frameRate: 30, maxBitrate: 10_000_000 },
  { resolution: '2160p', frameRate: 60, maxBitrate: 16_000_000 },
];

export function rungIndexFor(resolution: ResolutionPreset, frameRate: FrameRatePreset): number {
  if (resolution === 'auto') return defaultRungIndex();

  const fps = frameRate === 'auto' ? 30 : frameRate;
  // Exact match first, then the closest rung at that resolution.
  const exact = QUALITY_LADDER.findIndex(
    (rung) => rung.resolution === resolution && rung.frameRate === fps,
  );
  if (exact !== -1) return exact;

  const sameResolution = QUALITY_LADDER.findIndex((rung) => rung.resolution === resolution);
  return sameResolution !== -1 ? sameResolution : defaultRungIndex();
}

/** 1080p30 is the safe default: it looks sharp and survives most uplinks. */
export function defaultRungIndex(): number {
  return 1;
}

export function describeRung(rung: QualityRung): string {
  return `${RESOLUTION_LABELS[rung.resolution]} ${rung.frameRate}fps`;
}

export interface QualitySettings {
  resolution: ResolutionPreset;
  frameRate: FrameRatePreset;
  adaptive: boolean;
}

export const DEFAULT_QUALITY: QualitySettings = {
  resolution: 'auto',
  frameRate: 'auto',
  adaptive: true,
};

export interface AudioSettings {
  microphoneId: string | null;
  speakerId: string | null;
  pushToTalk: boolean;
  pushToTalkKey: string;
}

export const DEFAULT_AUDIO: AudioSettings = {
  microphoneId: null,
  speakerId: null,
  pushToTalk: false,
  pushToTalkKey: 'Space',
};

export interface ConnectionStats {
  /** Round-trip time in milliseconds, or null before the first sample. */
  rttMs: number | null;
  /** Fraction lost, 0..1. */
  packetLoss: number | null;
  outgoingKbps: number | null;
}

export const EMPTY_STATS: ConnectionStats = {
  rttMs: null,
  packetLoss: null,
  outgoingKbps: null,
};
