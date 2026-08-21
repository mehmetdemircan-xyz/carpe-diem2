import { useEffect } from 'react';

/**
 * Keeps `--app-height` equal to the height a person can actually see.
 *
 * On a phone the layout viewport does not shrink when the on-screen keyboard
 * opens, so a full-height app stays full height and the browser makes room
 * for the focused input the only way it can: by scrolling the page up. In a
 * room that means the video slides off the top the moment someone starts
 * typing a message — which defeats the point of having chat beside the film
 * rather than over it.
 *
 * `interactive-widget=resizes-content` in the viewport meta tells Chrome to
 * resize instead, and this hook covers the rest: Safari ignores that hint,
 * and every engine exposes the real number through `visualViewport`.
 *
 * `offsetTop` is subtracted because a browser that has already scrolled the
 * page reports a viewport that starts below the top of the layout; without
 * it the app would be sized correctly and still be pushed halfway up.
 */
export function useViewportHeight(): void {
  useEffect(() => {
    const root = document.documentElement;

    const apply = () => {
      const viewport = window.visualViewport;
      // The smaller of the two, never one or the other. With a keyboard up
      // the visual viewport is the smaller and is what we want; when an
      // engine reports a stale visual viewport, innerHeight is the smaller
      // and is what we want. Taking the minimum is right in both cases and
      // does not depend on trusting either number on its own.
      const visual = viewport ? viewport.height - viewport.offsetTop : Number.POSITIVE_INFINITY;
      const height = Math.min(visual, window.innerHeight);

      // Sub-pixel values here produce a hairline gap under the control bar on
      // fractional-DPR screens, which reads as a rendering bug.
      root.style.setProperty('--app-height', `${Math.round(height)}px`);
    };

    apply();
    // A rotation reports the new size a frame after the event on some
    // engines, so the first read can be the old one.
    const settle = () => window.requestAnimationFrame(apply);

    const viewport = window.visualViewport;
    viewport?.addEventListener('resize', settle);
    viewport?.addEventListener('scroll', settle);
    window.addEventListener('resize', settle);
    window.addEventListener('orientationchange', settle);

    return () => {
      viewport?.removeEventListener('resize', settle);
      viewport?.removeEventListener('scroll', settle);
      window.removeEventListener('resize', settle);
      window.removeEventListener('orientationchange', settle);
      root.style.removeProperty('--app-height');
    };
  }, []);
}
