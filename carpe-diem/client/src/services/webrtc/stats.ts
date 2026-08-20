import type { ConnectionQuality } from '@shared/protocol';
import type { ConnectionStats } from '@/types/media';

interface Sample {
  packetsSent: number;
  packetsLost: number;
  bytesSent: number;
  timestamp: number;
}

/**
 * Turns raw getStats() reports into the three numbers the UI shows, and a
 * single quality verdict the adaptive controller acts on.
 *
 * Deltas are computed against the previous sample rather than using
 * cumulative totals: a call that started badly and recovered should read as
 * good now, not be dragged down by its own history.
 */
export class StatsSampler {
  private previous: Sample | null = null;

  sample(reports: RTCStatsReport[]): { stats: ConnectionStats; quality: ConnectionQuality } {
    let rttMs: number | null = null;
    let packetsSent = 0;
    let packetsLost = 0;
    let bytesSent = 0;
    let timestamp = 0;
    let sawOutbound = false;

    for (const report of reports) {
      report.forEach((entry) => {
        const stat = entry as Record<string, unknown> & { type?: string };

        if (stat.type === 'candidate-pair' && stat['state'] === 'succeeded') {
          const rtt = stat['currentRoundTripTime'];
          if (typeof rtt === 'number') {
            const asMs = rtt * 1000;
            // Across a mesh, the worst link is what the user perceives.
            rttMs = rttMs === null ? asMs : Math.max(rttMs, asMs);
          }
        }

        if (stat.type === 'outbound-rtp' && stat['kind'] === 'video') {
          sawOutbound = true;
          packetsSent += numberOf(stat['packetsSent']);
          bytesSent += numberOf(stat['bytesSent']);
          timestamp = Math.max(timestamp, numberOf(stat['timestamp']));
        }

        if (stat.type === 'remote-inbound-rtp' && stat['kind'] === 'video') {
          packetsLost += numberOf(stat['packetsLost']);
          const rtt = stat['roundTripTime'];
          if (typeof rtt === 'number' && rttMs === null) rttMs = rtt * 1000;
        }
      });
    }

    let packetLoss: number | null = null;
    let outgoingKbps: number | null = null;

    if (sawOutbound && timestamp > 0) {
      const current: Sample = { packetsSent, packetsLost, bytesSent, timestamp };

      if (this.previous && timestamp > this.previous.timestamp) {
        const sentDelta = packetsSent - this.previous.packetsSent;
        const lostDelta = Math.max(0, packetsLost - this.previous.packetsLost);
        const elapsedSeconds = (timestamp - this.previous.timestamp) / 1000;

        if (sentDelta > 0) {
          packetLoss = Math.min(1, lostDelta / (sentDelta + lostDelta));
        }
        if (elapsedSeconds > 0) {
          outgoingKbps = Math.round(((bytesSent - this.previous.bytesSent) * 8) / elapsedSeconds / 1000);
        }
      }

      this.previous = current;
    }

    return {
      stats: { rttMs: rttMs === null ? null : Math.round(rttMs), packetLoss, outgoingKbps },
      quality: classify(rttMs, packetLoss),
    };
  }

  reset(): void {
    this.previous = null;
  }
}

function numberOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Thresholds tuned for screen sharing specifically. Text stays readable
 * through latency that would ruin a game, but tears badly under packet loss,
 * so loss is weighted more heavily than RTT.
 */
export function classify(rttMs: number | null, packetLoss: number | null): ConnectionQuality {
  if (rttMs === null && packetLoss === null) return 'unknown';

  const rtt = rttMs ?? 0;
  const loss = packetLoss ?? 0;

  if (loss > 0.08 || rtt > 400) return 'poor';
  if (loss > 0.03 || rtt > 200) return 'unstable';
  if (loss > 0.01 || rtt > 90) return 'good';
  return 'excellent';
}
