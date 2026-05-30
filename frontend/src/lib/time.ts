import type { UTCTimestamp } from 'lightweight-charts';

// epoch ms (modelo canónico del backend) → segundos UTC (lo que espera lightweight-charts).
export function msToUtcSeconds(ms: number): UTCTimestamp {
  return Math.floor(ms / 1000) as UTCTimestamp;
}

// epoch ms → "YYYY-MM-DD HH:mm UTC" compacto para el inspector.
export function formatUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

const TF_UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

// Duración de un timeframe en ms. Usado para mapear coordenada lógica ↔ tiempo
// (incluido el espacio futuro a la derecha de la última vela).
export function tfToMs(tf: string): number {
  const m = tf.match(/^(\d+)([mhdw])$/);
  if (!m) return 60_000;
  return Number(m[1]) * (TF_UNIT_MS[m[2]] ?? 60_000);
}
