import type { RTCIceServerConfig, SignalBody } from '@shared/protocol';

/**
 * Full-mesh WebRTC transport.
 *
 * Each participant holds one RTCPeerConnection per other participant. That is
 * fine up to roughly six people and needs no media server; past that an SFU is
 * required, which is why every consumer talks to the `MediaTransport`
 * interface below rather than to this class directly. Swapping in an SFU means
 * writing one more implementation, not touching the UI.
 *
 * Two design choices keep this stable:
 *
 * 1. Transceivers are created up front (one audio, one video) and never added
 *    or removed. Starting and stopping a screen share is `replaceTrack`, which
 *    needs no renegotiation at all. Renegotiation storms are the single
 *    biggest source of flakiness in mesh WebRTC, and this sidesteps them.
 *
 * 2. Only the newcomer sends offers, and only to people already in the room.
 *    Glare is therefore impossible and no polite/impolite tie-breaking is
 *    needed.
 */

export interface PeerSnapshot {
  id: string;
  state: RTCPeerConnectionState;
  stream: MediaStream | null;
}

export interface MediaTransportEvents {
  /** A remote stream became available or was replaced. */
  onRemoteStream: (peerId: string, stream: MediaStream) => void;
  onPeerStateChange: (peerId: string, state: RTCPeerConnectionState) => void;
  /** Emit a signal to be relayed by the server. */
  onSignal: (to: string, body: SignalBody) => void;
  onPeerFailed: (peerId: string) => void;
}

export interface MediaTransport {
  addPeer(peerId: string, initiate: boolean): void;
  removePeer(peerId: string): void;
  acceptSignal(from: string, body: SignalBody): Promise<void>;
  setVideoTrack(track: MediaStreamTrack | null): Promise<void>;
  setAudioTrack(track: MediaStreamTrack | null): Promise<void>;
  applyVideoEncoding(params: { maxBitrate: number; maxFramerate: number }): Promise<void>;
  getStats(): Promise<RTCStatsReport[]>;
  peerIds(): string[];
  destroy(): void;
}

interface PeerEntry {
  id: string;
  pc: RTCPeerConnection;
  remoteStream: MediaStream;
  videoSender: RTCRtpSender | null;
  audioSender: RTCRtpSender | null;
  /** Candidates that arrived before the remote description was set. */
  pendingCandidates: RTCIceCandidateInit[];
  makingOffer: boolean;
  restartAttempts: number;
  restartTimer: number | null;
}

const MAX_ICE_RESTARTS = 2;

export class PeerMesh implements MediaTransport {
  private readonly peers = new Map<string, PeerEntry>();
  private videoTrack: MediaStreamTrack | null = null;
  private audioTrack: MediaStreamTrack | null = null;
  private encoding = { maxBitrate: 2_500_000, maxFramerate: 30 };
  private destroyed = false;

  constructor(
    private readonly iceServers: RTCIceServerConfig[],
    private readonly events: MediaTransportEvents,
  ) {}

  peerIds(): string[] {
    return [...this.peers.keys()];
  }

  addPeer(peerId: string, initiate: boolean): void {
    if (this.destroyed || this.peers.has(peerId)) return;

    const pc = new RTCPeerConnection({
      iceServers: this.iceServers as RTCIceServer[],
      // Pooling shaves a little off first-connect latency.
      iceCandidatePoolSize: 2,
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
    });

    const entry: PeerEntry = {
      id: peerId,
      pc,
      remoteStream: new MediaStream(),
      videoSender: null,
      audioSender: null,
      pendingCandidates: [],
      makingOffer: false,
      restartAttempts: 0,
      restartTimer: null,
    };

    // Only the offerer creates transceivers.
    //
    // Per JSEP, a transceiver created by addTransceiver is NOT a candidate for
    // matching against an incoming remote offer — only ones implied by
    // addTrack are. An answerer that pre-creates them therefore ends up with
    // two dead sendrecv transceivers plus a fresh recvonly pair built from the
    // offer, and media only ever flows one way. The answerer adopts the
    // offer's transceivers in acceptDescription instead.
    if (initiate) {
      entry.audioSender = pc.addTransceiver('audio', { direction: 'sendrecv' }).sender;
      entry.videoSender = pc.addTransceiver('video', { direction: 'sendrecv' }).sender;
    }

    pc.onicecandidate = (event) => {
      if (!event.candidate) return;
      this.events.onSignal(peerId, {
        kind: 'candidate',
        candidate: {
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
          usernameFragment: event.candidate.usernameFragment,
        },
      });
    };

    pc.ontrack = (event) => {
      // Reuse one MediaStream per peer so the <video> element's srcObject is
      // set once. Reassigning srcObject mid-call causes a visible flash.
      const [track] = event.streams.length ? event.streams[0]!.getTracks() : [event.track];
      if (!track) return;

      for (const existing of entry.remoteStream.getTracks()) {
        if (existing.kind === track.kind && existing.id !== track.id) {
          entry.remoteStream.removeTrack(existing);
        }
      }
      if (!entry.remoteStream.getTrackById(track.id)) {
        entry.remoteStream.addTrack(track);
      }
      this.events.onRemoteStream(peerId, entry.remoteStream);
    };

    pc.onconnectionstatechange = () => {
      this.events.onPeerStateChange(peerId, pc.connectionState);
      if (pc.connectionState === 'failed') {
        this.attemptIceRestart(entry);
      } else if (pc.connectionState === 'connected') {
        entry.restartAttempts = 0;
      }
    };

    this.peers.set(peerId, entry);

    void this.applyTracksTo(entry);

    if (initiate) {
      void this.negotiate(entry);
    }
  }

  removePeer(peerId: string): void {
    const entry = this.peers.get(peerId);
    if (!entry) return;
    this.teardown(entry);
    this.peers.delete(peerId);
  }

  async acceptSignal(from: string, body: SignalBody): Promise<void> {
    const entry = this.peers.get(from);
    if (!entry || this.destroyed) return;

    try {
      if (body.kind === 'description') {
        await this.acceptDescription(entry, body.description);
      } else {
        await this.acceptCandidate(entry, body.candidate);
      }
    } catch (error) {
      // A failed signal exchange is recoverable via ICE restart; it should
      // never take down the room.
      console.warn('[carpe] signal handling failed', error);
    }
  }

  async setVideoTrack(track: MediaStreamTrack | null): Promise<void> {
    this.videoTrack = track;
    await Promise.all(
      [...this.peers.values()].map(async (entry) => {
        if (!entry.videoSender) return;
        await entry.videoSender.replaceTrack(track);
        if (track) await this.applyEncodingTo(entry);
      }),
    );
  }

  async setAudioTrack(track: MediaStreamTrack | null): Promise<void> {
    this.audioTrack = track;
    await Promise.all(
      [...this.peers.values()].map((entry) => entry.audioSender?.replaceTrack(track)),
    );
  }

  async applyVideoEncoding(params: { maxBitrate: number; maxFramerate: number }): Promise<void> {
    this.encoding = params;
    await Promise.all([...this.peers.values()].map((entry) => this.applyEncodingTo(entry)));
  }

  async getStats(): Promise<RTCStatsReport[]> {
    const reports = await Promise.all(
      [...this.peers.values()].map((entry) =>
        entry.pc.getStats().catch(() => null),
      ),
    );
    return reports.filter((report): report is RTCStatsReport => report !== null);
  }

  destroy(): void {
    this.destroyed = true;
    for (const entry of this.peers.values()) {
      this.teardown(entry);
    }
    this.peers.clear();
    this.videoTrack = null;
    this.audioTrack = null;
  }

  /* ---------------------------------------------------------------------- */
  /* Internals                                                              */
  /* ---------------------------------------------------------------------- */

  private async applyTracksTo(entry: PeerEntry): Promise<void> {
    if (this.videoTrack && entry.videoSender) {
      await entry.videoSender.replaceTrack(this.videoTrack).catch(() => {});
      await this.applyEncodingTo(entry);
    }
    if (this.audioTrack && entry.audioSender) {
      await entry.audioSender.replaceTrack(this.audioTrack).catch(() => {});
    }
  }

  private async applyEncodingTo(entry: PeerEntry): Promise<void> {
    const sender = entry.videoSender;
    if (!sender) return;

    try {
      const params = sender.getParameters();
      // Firefox returns an empty array before the first negotiation completes.
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      const first = params.encodings[0];
      if (!first) return;

      first.maxBitrate = this.encoding.maxBitrate;
      first.maxFramerate = this.encoding.maxFramerate;
      // Screen text must stay legible; never let the encoder trade resolution
      // for motion smoothness.
      params.degradationPreference = 'maintain-resolution';

      await sender.setParameters(params);
    } catch {
      // Older engines reject some fields. The share still works, just without
      // an explicit ceiling.
    }
  }

  private async negotiate(entry: PeerEntry): Promise<void> {
    if (this.destroyed) return;
    try {
      entry.makingOffer = true;
      const offer = await entry.pc.createOffer();
      if (entry.pc.signalingState !== 'stable') return;
      await entry.pc.setLocalDescription(offer);

      const description = entry.pc.localDescription;
      if (!description?.sdp) return;

      this.events.onSignal(entry.id, {
        kind: 'description',
        description: { type: description.type as 'offer', sdp: description.sdp },
      });
    } catch (error) {
      console.warn('[carpe] negotiation failed', error);
    } finally {
      entry.makingOffer = false;
    }
  }

  private async acceptDescription(
    entry: PeerEntry,
    description: { type: 'offer' | 'answer'; sdp: string },
  ): Promise<void> {
    const { pc } = entry;

    // Guard against glare even though the initiation rule should prevent it:
    // a reconnecting peer could theoretically offer while we are offering.
    const offerCollision =
      description.type === 'offer' && (entry.makingOffer || pc.signalingState !== 'stable');
    if (offerCollision) {
      // We are the impolite side (we initiated), so ignore their offer.
      if (entry.makingOffer) return;
      await pc.setLocalDescription({ type: 'rollback' });
    }

    await pc.setRemoteDescription(description);

    // Candidates buffered while the remote description was missing.
    for (const candidate of entry.pendingCandidates.splice(0)) {
      await pc.addIceCandidate(candidate).catch(() => {});
    }

    if (description.type === 'offer') {
      // Widen and bind before answering, so the SDP we send back advertises
      // sendrecv and this side can publish later with a bare replaceTrack.
      this.adoptTransceivers(entry);
      await this.applyTracksTo(entry);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      const local = pc.localDescription;
      if (!local?.sdp) return;

      this.events.onSignal(entry.id, {
        kind: 'description',
        description: { type: 'answer', sdp: local.sdp },
      });
    }
  }

  /**
   * Claims the transceivers that setRemoteDescription created for us.
   *
   * They arrive as `recvonly` — the browser assumes we only want to receive
   * because we have not offered anything. Left that way, the answer pins the
   * m-line to one direction for the life of the connection and this peer can
   * never share its screen without a full renegotiation.
   */
  private adoptTransceivers(entry: PeerEntry): void {
    for (const transceiver of entry.pc.getTransceivers()) {
      const kind = transceiver.receiver.track?.kind ?? transceiver.sender.track?.kind;
      if (kind !== 'audio' && kind !== 'video') continue;

      if (transceiver.direction === 'recvonly' || transceiver.direction === 'inactive') {
        transceiver.direction = 'sendrecv';
      }

      if (kind === 'audio' && !entry.audioSender) entry.audioSender = transceiver.sender;
      if (kind === 'video' && !entry.videoSender) entry.videoSender = transceiver.sender;
    }
  }

  private async acceptCandidate(
    entry: PeerEntry,
    candidate: { candidate: string; sdpMid: string | null; sdpMLineIndex: number | null },
  ): Promise<void> {
    const init: RTCIceCandidateInit = {
      candidate: candidate.candidate,
      sdpMid: candidate.sdpMid,
      sdpMLineIndex: candidate.sdpMLineIndex,
    };

    if (!entry.pc.remoteDescription) {
      entry.pendingCandidates.push(init);
      return;
    }
    await entry.pc.addIceCandidate(init).catch(() => {});
  }

  /**
   * A failed connection usually means the network path changed (wifi to
   * cellular, VPN toggled). An ICE restart re-gathers candidates without
   * rebuilding the peer connection, so tracks survive.
   */
  private attemptIceRestart(entry: PeerEntry): void {
    if (this.destroyed) return;
    if (entry.restartAttempts >= MAX_ICE_RESTARTS) {
      this.events.onPeerFailed(entry.id);
      return;
    }

    entry.restartAttempts += 1;
    const delay = 500 * entry.restartAttempts;

    if (entry.restartTimer !== null) window.clearTimeout(entry.restartTimer);
    entry.restartTimer = window.setTimeout(() => {
      entry.restartTimer = null;
      if (this.destroyed || entry.pc.connectionState === 'connected') return;

      void (async () => {
        try {
          const offer = await entry.pc.createOffer({ iceRestart: true });
          await entry.pc.setLocalDescription(offer);
          const local = entry.pc.localDescription;
          if (!local?.sdp) return;
          this.events.onSignal(entry.id, {
            kind: 'description',
            description: { type: 'offer', sdp: local.sdp },
          });
        } catch {
          this.events.onPeerFailed(entry.id);
        }
      })();
    }, delay);
  }

  private teardown(entry: PeerEntry): void {
    if (entry.restartTimer !== null) window.clearTimeout(entry.restartTimer);

    entry.pc.onicecandidate = null;
    entry.pc.ontrack = null;
    entry.pc.onconnectionstatechange = null;

    // Senders hold references to our local tracks; stopping the *receivers'*
    // tracks is what actually frees the decode pipeline for this peer.
    for (const receiver of entry.pc.getReceivers()) {
      receiver.track?.stop();
    }
    for (const transceiver of entry.pc.getTransceivers()) {
      try {
        transceiver.stop();
      } catch {
        // Not supported everywhere; closing the connection covers it.
      }
    }

    entry.remoteStream.getTracks().forEach((track) => entry.remoteStream.removeTrack(track));
    entry.pc.close();
  }
}
