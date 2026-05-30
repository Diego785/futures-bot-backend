import type { UTCTimestamp } from 'lightweight-charts';

// epoch ms (modelo canónico del backend) → segundos UTC (lo que espera lightweight-charts).
export function msToUtcSeconds(ms: number): UTCTimestamp {
  return Math.floor(ms / 1000) as UTCTimestamp;
}

// epoch ms → "YYYY-MM-DD HH:mm UTC" compacto para el inspector.
export function formatUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}
