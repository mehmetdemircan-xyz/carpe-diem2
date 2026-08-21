import { memo, useEffect, useRef } from 'react';

/**
 * One hidden <audio> per peer.
 *
 * Voice is deliberately not routed through the <video> element that shows a
 * screen: a peer can be talking without sharing, and muting the speaker must
 * not mute the tab's own captured audio.
 */
export const RemoteAudio = memo(function RemoteAudio({
  stream,
  muted,
  outputDeviceId,
}: {
  stream: MediaStream;
  muted: boolean;
  outputDeviceId: string | null;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const boundStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    const element = audioRef.current;
    if (!element) return;

    if (boundStreamRef.current !== stream) {
      element.srcObject = stream;
      boundStreamRef.current = stream;
    }
    element.play().catch(() => {});
  }, [stream]);

  // Output device selection only exists in Chromium. Elsewhere the call is
  // absent and audio stays on the system default, which is the right fallback.
  useEffect(() => {
    const element = audioRef.current;
    if (!element || !outputDeviceId) return;
    // Typed as required by lib.dom, but genuinely absent outside Chromium.
    if (typeof element.setSinkId !== 'function') return;
    element.setSinkId(outputDeviceId).catch(() => {});
  }, [outputDeviceId]);

  useEffect(() => {
    const element = audioRef.current;
    return () => {
      if (element) element.srcObject = null;
      boundStreamRef.current = null;
    };
  }, []);

  return <audio ref={audioRef} autoPlay playsInline muted={muted} className="hidden" />;
});
