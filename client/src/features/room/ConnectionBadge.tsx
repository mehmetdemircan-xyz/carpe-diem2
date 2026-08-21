import { memo, useEffect, useRef, useState } from 'react';
import type { ConnectionQuality } from '@shared/protocol';
import { useT } from '@/i18n/I18nProvider';
import type { ConnectionStats } from '@/types/media';
import type { MessageKey } from '@/i18n/messages';

const DOT_COLOR: Record<ConnectionQuality, string> = {
  excellent: 'bg-signal-good',
  good: 'bg-signal-good',
  unstable: 'bg-signal-warn',
  poor: 'bg-signal-bad',
  unknown: 'bg-ink-600',
};

const LABEL_KEY: Record<ConnectionQuality, MessageKey> = {
  excellent: 'connection.excellent',
  good: 'connection.good',
  unstable: 'connection.unstable',
  poor: 'connection.poor',
  unknown: 'connection.unknown',
};

/**
 * Collapsed to a dot until asked. The detail behind it is diagnostic, and a
 * permanent readout of latency numbers is exactly the kind of noise this
 * interface is trying to avoid.
 */
export const ConnectionBadge = memo(function ConnectionBadge({
  quality,
  stats,
  activeRungLabel,
}: {
  quality: ConnectionQuality;
  stats: ConnectionStats;
  activeRungLabel: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapperRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={wrapperRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
        className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs text-chalk-400 transition-colors hover:bg-ink-800 hover:text-chalk-200"
      >
        <span className={`h-2 w-2 rounded-full ${DOT_COLOR[quality]}`} aria-hidden />
        <span className="hidden sm:inline">{t(LABEL_KEY[quality])}</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full z-40 mt-2 w-56 animate-slide-up rounded-lg border border-ink-800 bg-ink-850 p-3 text-xs shadow-xl shadow-black/50">
          <p className="mb-2 font-medium text-chalk-200">{t('connection.title')}</p>
          <dl className="space-y-1.5 text-chalk-400">
            <Row label={t('connection.quality')} value={t(LABEL_KEY[quality])} />
            <Row
              label={t('connection.latency')}
              value={stats.rttMs === null ? '—' : `${stats.rttMs} ms`}
            />
            <Row
              label={t('connection.packetLoss')}
              value={stats.packetLoss === null ? '—' : `${(stats.packetLoss * 100).toFixed(1)}%`}
            />
            <Row
              label={t('connection.outgoing')}
              value={
                activeRungLabel
                  ? `${activeRungLabel}${stats.outgoingKbps ? ` · ${formatKbps(stats.outgoingKbps)}` : ''}`
                  : t('connection.notSharing')
              }
            />
          </dl>
        </div>
      )}
    </div>
  );
});

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt>{label}</dt>
      <dd className="font-mono text-chalk-200">{value}</dd>
    </div>
  );
}

function formatKbps(kbps: number): string {
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`;
}
