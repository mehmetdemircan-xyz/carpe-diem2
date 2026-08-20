import { memo, useEffect, useRef } from 'react';

/**
 * Binds a MediaStream to a <video> element.
 *
 * srcObject is assigned imperatively and only when the stream identity
 * actually changes: setting it on every render restarts decoding and produces
 * a visible black flash.
 */
export const VideoSurface = memo(function VideoSurface({
  stream,
  muted,
  mirrored = false,
  className = '',
  objectFit = 'contain',
}: {
  stream: MediaStream | null;
  muted: boolean;
  mirrored?: boolean;
  className?: string;
  objectFit?: 'contain' | 'cover';
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const boundStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    const element = videoRef.current;
    if (!element) return;

    if (boundStreamRef.current !== stream) {
      element.srcObject = stream;
      boundStreamRef.current = stream;
    }

    if (!stream) return;

    // Autoplay can still be refused (background tab, strict policy). Retrying
    // on the next user gesture is handled by the browser; log and move on.
    const attempt = element.play();
    if (attempt && typeof attempt.catch === 'function') {
      attempt.catch(() => {});
    }
  }, [stream]);

  // Release the decoder when this surface goes away, rather than waiting for
  // GC. With several peers this is the difference between a steady and a
  // creeping memory profile.
  useEffect(() => {
    const element = videoRef.current;
    return () => {
      if (element) {
        element.srcObject = null;
      }
      boundStreamRef.current = null;
    };
  }, []);

  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      muted={muted}
      className={`h-full w-full ${objectFit === 'cover' ? 'object-cover' : 'object-contain'} ${
        mirrored ? '-scale-x-100' : ''
      } ${className}`}
    />
  );
});
