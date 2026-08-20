/**
 * Mixes the microphone and captured tab audio into one outgoing track.
 *
 * The mesh deliberately holds a single audio transceiver per peer, established
 * once and never renegotiated. Sending tab audio as a second track would break
 * that and reintroduce the renegotiation churn the transport was designed to
 * avoid. Mixing keeps the m-line layout fixed: the output track is created
 * once, handed to the transport once, and only the sources feeding it change.
 *
 * Silence is not special-cased. A source that is muted — a microphone gated by
 * push-to-talk, or a tab playing nothing — simply contributes nothing to the
 * sum, which is the correct result.
 */

export type AudioSourceKind = 'mic' | 'display';

export class AudioMixer {
  private context: AudioContext | null = null;
  private destination: MediaStreamAudioDestinationNode | null = null;
  private readonly sources = new Map<AudioSourceKind, MediaStreamAudioSourceNode>();

  /**
   * The track every peer receives. Stable for the lifetime of the mixer, so
   * the transport never has to swap it.
   */
  get outputTrack(): MediaStreamTrack | null {
    return this.destination?.stream.getAudioTracks()[0] ?? null;
  }

  get sourceCount(): number {
    return this.sources.size;
  }

  /**
   * Attaches or replaces one source. Passing null removes it, which is how a
   * screen share that carried tab audio stops contributing when it ends.
   */
  setSource(kind: AudioSourceKind, stream: MediaStream | null): void {
    const existing = this.sources.get(kind);
    if (existing) {
      existing.disconnect();
      this.sources.delete(kind);
    }

    if (!stream || stream.getAudioTracks().length === 0) return;

    const context = this.ensureContext();
    if (!context || !this.destination) return;

    try {
      const node = context.createMediaStreamSource(stream);
      node.connect(this.destination);
      this.sources.set(kind, node);
    } catch {
      // A stream with no usable audio, or a locked-down Web Audio
      // implementation. Losing one source must not take the call down.
    }
  }

  /** Releases every node and the context. Safe to call more than once. */
  destroy(): void {
    for (const node of this.sources.values()) node.disconnect();
    this.sources.clear();

    this.destination?.disconnect();
    this.destination = null;

    void this.context?.close().catch(() => {});
    this.context = null;
  }

  private ensureContext(): AudioContext | null {
    if (this.context && this.destination) return this.context;

    const AudioContextCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return null;

    try {
      const context = new AudioContextCtor();
      this.destination = context.createMediaStreamDestination();
      this.context = context;

      // Capture always follows a click, so this normally resolves immediately.
      if (context.state === 'suspended') void context.resume().catch(() => {});

      return context;
    } catch {
      return null;
    }
  }
}
