import type { UTCTimestamp } from 'lightweight-charts';

// epoch ms (modelo canónico del backend) → segundos UTC (lo que espera lightweight-charts).
export function msToUtcSeconds(ms: number): UTCTimestamp {
  return Math.floor(ms / 1000) as UTCTimestamp;
}
