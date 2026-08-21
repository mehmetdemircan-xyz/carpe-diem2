/**
 * Detects whether the local microphone is picking up speech.
 *
 * Runs on your own mic rather than on incoming audio: analysing every remote
 * stream would cost an AudioContext per peer, and would go silent the moment
 * somebody muted their speakers — you still want to see who is talking then.
 * Each client reports its own state and the server relays it.
 *
 * Push-to-talk needs no special handling. Disabling a track makes it emit
 * silence, so the meter reads zero and this reports "not speaking", which is
 * exactly right.
 */

export interface VoiceActivityOptions {
  /** RMS level that starts speech. */
  onThreshold?: number;
  /** Lower level that ends it — the gap is what stops flicker on sibilants. */
  offThreshold?: number;
  /** How long the level must stay low before speech is considered over. */
  releaseMs?: number;
  sampleIntervalMs?: number;
}

const DEFAULTS: Required<VoiceActivityOptions> = {
  onThreshold: 0.022,
  offThreshold: 0.014,
  // Long enough to ride over the pauses between words, short enough that the
  // indicator does not linger after somebody stops.
  releaseMs: 320,
  sampleIntervalMs: 100,
};

export class VoiceActivityDetector {
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  /**
   * Backed by an explicit ArrayBuffer so its type is not the wider
   * ArrayBufferLike — getByteTimeDomainData will not accept a view that might
   * be over a SharedArrayBuffer.
   */
  private buffer = new Uint8Array(new ArrayBuffer(0));
  private timer: number | null = null;
  private speaking = false;
  private quietSince = 0;
  private readonly options: Required<VoiceActivityOptions>;

  constructor(
    private readonly onChange: (speaking: boolean) => void,
    options: VoiceActivityOptions = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  attach(stream: MediaStream): void {
    this.detach();

    const AudioContextCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;

    try {
      const context = new AudioContextCtor();
      const source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();

      // 1024 samples at 48kHz is ~21ms of audio: enough to be stable, small
      // enough that the copy on every tick is negligible.
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.2;
      source.connect(analyser);
      // Deliberately not connected to the destination — this only measures.

      this.context = context;
      this.source = source;
      this.analyser = analyser;
      this.buffer = new Uint8Array(new ArrayBuffer(analyser.fftSize));

      // An AudioContext created outside a gesture starts suspended. Mic
      // capture always follows a click, so this normally resolves at once.
      if (context.state === 'suspended') void context.resume().catch(() => {});

      this.timer = window.setInterval(() => this.sample(), this.options.sampleIntervalMs);
    } catch {
      // Web Audio can fail on locked-down configurations. Losing the speaking
      // indicator is not worth breaking the call over.
      this.detach();
    }
  }

  detach(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.source?.disconnect();
    this.analyser?.disconnect();
    this.source = null;
    this.analyser = null;

    // Closing releases the audio hardware thread; leaking these across
    // reconnects is a real source of creeping CPU use.
    void this.context?.close().catch(() => {});
    this.context = null;

    if (this.speaking) {
      this.speaking = false;
      this.onChange(false);
    }
  }

  private sample(): void {
    const analyser = this.analyser;
    if (!analyser) return;

    analyser.getByteTimeDomainData(this.buffer);

    // RMS of the waveform around the 128 midpoint, normalized to 0..1.
    let sumSquares = 0;
    for (let i = 0; i < this.buffer.length; i += 1) {
      const deviation = ((this.buffer[i] ?? 128) - 128) / 128;
      sumSquares += deviation * deviation;
    }
    const level = Math.sqrt(sumSquares / this.buffer.length);

    const now = Date.now();

    if (!this.speaking) {
      if (level >= this.options.onThreshold) {
        this.speaking = true;
        this.quietSince = 0;
        this.onChange(true);
      }
      return;
    }

    if (level >= this.options.offThreshold) {
      this.quietSince = 0;
      return;
    }

    if (this.quietSince === 0) {
      this.quietSince = now;
      return;
    }

    if (now - this.quietSince >= this.options.releaseMs) {
      this.speaking = false;
      this.quietSince = 0;
      this.onChange(false);
    }
  }
}
