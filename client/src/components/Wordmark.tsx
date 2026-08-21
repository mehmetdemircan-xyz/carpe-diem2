import { memo } from 'react';

/**
 * The brand lockup. "CARPE" in medium weight, "Diem." in light italic, and the
 * full stop is part of the name — it is what stops the wordmark reading like a
 * generic product noun.
 */
export const Wordmark = memo(function Wordmark({
  size = 'md',
  className = '',
}: {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  const scale =
    size === 'lg' ? 'text-4xl sm:text-5xl' : size === 'md' ? 'text-xl' : 'text-base';

  return (
    <span className={`select-none font-medium tracking-tight ${scale} ${className}`}>
      <span className="text-chalk-50">CARPE</span>{' '}
      <span className="font-light italic text-accent">Diem</span>
      <span className="text-accent">.</span>
    </span>
  );
});
