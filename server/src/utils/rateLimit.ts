/**
 * Token bucket. Cheap enough to run on every signaling message, which is the
 * point: a misbehaving or hijacked client should not be able to flood the room.
 */
export class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSecond: number,
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  /** Returns false when the caller has exhausted its budget. */
  tryConsume(cost = 1): boolean {
    const now = Date.now();
    const elapsedSeconds = (now - this.lastRefill) / 1000;
    if (elapsedSeconds > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond);
      this.lastRefill = now;
    }

    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

/** The set of buckets attached to a single socket. */
export interface SocketBudget {
  signals: TokenBucket;
  actions: TokenBucket;
  joins: TokenBucket;
  chat: TokenBucket;
  presence: TokenBucket;
}

export function createSocketBudget(limits: {
  signalPerSecond: number;
  actionPerSecond: number;
  joinAttemptsPerMinute: number;
  chatPerSecond: number;
  presencePerSecond: number;
}): SocketBudget {
  return {
    // Burst capacity of 2s worth of signals covers ICE trickle storms.
    signals: new TokenBucket(limits.signalPerSecond * 2, limits.signalPerSecond),
    actions: new TokenBucket(limits.actionPerSecond, limits.actionPerSecond),
    joins: new TokenBucket(limits.joinAttemptsPerMinute, limits.joinAttemptsPerMinute / 60),
    // A burst covers pasting a few lines in a row; the refill rate is what
    // stops someone scripting a flood into everyone else's panel.
    chat: new TokenBucket(limits.chatPerSecond * 3, limits.chatPerSecond),
    // Speech toggles on and off quickly in normal conversation, so this is
    // generous; it exists to bound a client stuck in a loop.
    presence: new TokenBucket(limits.presencePerSecond * 4, limits.presencePerSecond),
  };
}
