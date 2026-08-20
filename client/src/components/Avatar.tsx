import { memo } from 'react';

/**
 * Six hues spread around the wheel, all at a lightness that keeps white text
 * readable on them. Picked by hashing the id rather than the name, so a
 * participant's colour does not jump when they are renamed.
 */
const PALETTE = ['#4f7ce8', '#3fa88a', '#c07b3a', '#8a63c9', '#c05a7a', '#3d8fb0'];

function hashToIndex(seed: string, length: number): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % length;
}

/** First letters of the first two words, which is what reads at 32px. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  if (words.length === 1) return (words[0] ?? '').slice(0, 2).toLocaleUpperCase();
  return `${(words[0] ?? '').charAt(0)}${(words[1] ?? '').charAt(0)}`.toLocaleUpperCase();
}

const SIZES = {
  sm: 'h-7 w-7 text-[0.6rem]',
  md: 'h-9 w-9 text-xs',
  lg: 'h-16 w-16 text-lg',
} as const;

export const Avatar = memo(function Avatar({
  name,
  id,
  avatar,
  size = 'md',
  speaking = false,
  dimWhenQuiet = false,
  className = '',
}: {
  name: string;
  id: string;
  avatar: string | null;
  size?: keyof typeof SIZES;
  /**
   * Draws the active ring. It is a ring (a box-shadow) on this element rather
   * than a border or an inner overlay: a border would change the layout every
   * time somebody spoke, and an inner overlay gets clipped away by the
   * overflow-hidden that keeps the picture circular.
   */
  speaking?: boolean;
  /** Fades everyone who is not speaking, so the talker stands out. */
  dimWhenQuiet?: boolean;
  className?: string;
}) {
  const background = PALETTE[hashToIndex(id || name, PALETTE.length)];

  return (
    <span
      className={`relative inline-flex shrink-0 items-center justify-center overflow-hidden
                  rounded-full font-medium text-white transition-opacity
                  ${SIZES[size]}
                  ${dimWhenQuiet && !speaking ? 'opacity-45' : 'opacity-100'}
                  ${speaking ? 'ring-2 ring-signal-good' : ''}
                  ${className}`}
      style={{ backgroundColor: avatar ? undefined : background }}
      title={name}
    >
      {avatar ? (
        <img src={avatar} alt="" className="h-full w-full object-cover" draggable={false} />
      ) : (
        <span aria-hidden>{initialsOf(name)}</span>
      )}

    </span>
  );
});

export { PALETTE as AVATAR_PALETTE };
