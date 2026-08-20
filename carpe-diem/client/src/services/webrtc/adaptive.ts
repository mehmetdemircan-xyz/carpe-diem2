import type { ConnectionQuality } from '@shared/protocol';
import { QUALITY_LADDER, type QualityRung } from '@/types/media';

export type AdaptiveDecision =
  | { action: 'hold' }
  | { action: 'step-down'; rung: QualityRung; index: number }
  | { action: 'step-up'; rung: QualityRung; index: number };

/**
 * Decides when to move along the quality ladder.
 *
 * Hysteresis is the whole point: dropping quality is cheap and should happen
 * quickly, while raising it is expensive (a bitrate spike can re-trigger the
 * congestion that just cleared), so recovery needs a long, unbroken run of
 * good samples. Asymmetric thresholds are what stop the ladder oscillating.
 */
export class AdaptiveController {
  private badStreak = 0;
  private goodStreak = 0;
  private currentIndex: number;

  constructor(
    startIndex: number,
    /** The user's chosen ceiling; auto-quality never exceeds it. */
    private ceilingIndex: number,
    private readonly downAfterBadSamples = 2,
    private readonly upAfterGoodSamples = 6,
  ) {
    this.currentIndex = Math.min(startIndex, ceilingIndex);
  }

  get index(): number {
    return this.currentIndex;
  }

  get rung(): QualityRung {
    return QUALITY_LADDER[this.currentIndex] ?? QUALITY_LADDER[0]!;
  }

  setCeiling(ceilingIndex: number): void {
    this.ceilingIndex = ceilingIndex;
    if (this.currentIndex > ceilingIndex) {
      this.currentIndex = ceilingIndex;
    }
  }

  /** Force the ladder to a rung, e.g. when the user picks one by hand. */
  reset(index: number): void {
    this.currentIndex = Math.max(0, Math.min(index, this.ceilingIndex));
    this.badStreak = 0;
    this.goodStreak = 0;
  }

  observe(quality: ConnectionQuality): AdaptiveDecision {
    if (quality === 'unknown') return { action: 'hold' };

    const isBad = quality === 'poor' || quality === 'unstable';
    // 'good' is neither: it neither justifies dropping nor proves headroom.
    const isGreat = quality === 'excellent';

    if (isBad) {
      this.goodStreak = 0;
      // Poor counts double so a genuinely broken link drops after one sample.
      this.badStreak += quality === 'poor' ? 2 : 1;
    } else if (isGreat) {
      this.badStreak = 0;
      this.goodStreak += 1;
    } else {
      this.badStreak = Math.max(0, this.badStreak - 1);
      this.goodStreak = 0;
    }

    if (this.badStreak >= this.downAfterBadSamples && this.currentIndex > 0) {
      this.currentIndex -= 1;
      this.badStreak = 0;
      this.goodStreak = 0;
      return { action: 'step-down', rung: this.rung, index: this.currentIndex };
    }

    if (this.goodStreak >= this.upAfterGoodSamples && this.currentIndex < this.ceilingIndex) {
      this.currentIndex += 1;
      this.goodStreak = 0;
      return { action: 'step-up', rung: this.rung, index: this.currentIndex };
    }

    return { action: 'hold' };
  }
}
