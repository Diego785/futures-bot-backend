import type { Timeframe } from '../candles/candles.types';

// Marcas manuales del usuario sobre las velas. OB/FVG = zonas; Liquidity = nivel;
// TradePlan = plan de trade agrupado (Entry+SL+TP, tipo posición de TradingView).
// NO son señales del bot ni un objetivo a imitar: son un dataset de COMPARACIÓN y
// validación. El bot hará su propia lectura SMC (misma estrategia) y el usuario compara
// la suya contra la del bot para aprender y debatir (ver docs/VISION-V2.md).
export type ManualMarkKind = 'OB' | 'FVG' | 'Liquidity' | 'TradePlan';

// Herramienta activa. Long/Short crean un TradePlan con su side.
export type ManualTool = 'Select' | 'OB' | 'FVG' | 'Liquidity' | 'Long' | 'Short';

// Estado de revisión manual (Slice 3C). El usuario clasifica su propio análisis.
export type ReviewStatus = 'DRAFT' | 'REVIEWED' | 'VALID' | 'INVALID' | 'DOUBTFUL';

export interface ManualMark {
  id: string;
  sourceLayer: 'MyManualMarks';
  kind: ManualMarkKind;
  symbol: string;
  tf: Timeframe;
  // Zonas (OB/FVG): rango temporal (epoch ms UTC) + rango de precio.
  timeStart?: number;
  timeEnd?: number;
  priceLow?: number;
  priceHigh?: number;
  // Nivel (Liquidity): un precio.
  price?: number;
  // TradePlan: entrada/stop/target + lado. timeStart/timeEnd definen su extensión horizontal.
  side?: 'LONG' | 'SHORT';
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  note?: string;
  // Revisión / estudio (Slice 3C).
  status?: ReviewStatus;
  context?: string;
  reason?: string;
  doubt?: string;
  outcome?: string;
  createdAt: number;
  updatedAt: number;
}

export const ZONE_KINDS: ManualMarkKind[] = ['OB', 'FVG'];

export function isZoneKind(kind: ManualMarkKind): boolean {
  return kind === 'OB' || kind === 'FVG';
}
export function isPlanKind(kind: ManualMarkKind): boolean {
  return kind === 'TradePlan';
}

export const MARK_COLORS: Record<ManualMarkKind, string> = {
  OB: '#3b82f6',
  FVG: '#a855f7',
  Liquidity: '#eab308',
  TradePlan: '#60a5fa',
};
export const RISK_COLOR = '#ef5350';
export const REWARD_COLOR = '#22c55e';

/** R:R = |TP − Entry| / |Entry − SL|. null si el riesgo es 0. */
export function computeRR(entry: number, stopLoss: number, takeProfit: number): number | null {
  const risk = Math.abs(entry - stopLoss);
  if (risk === 0) return null;
  return Math.abs(takeProfit - entry) / risk;
}

export const REVIEW_STATUSES: ReviewStatus[] = ['DRAFT', 'REVIEWED', 'VALID', 'INVALID', 'DOUBTFUL'];
export const STATUS_LABELS: Record<ReviewStatus, string> = {
  DRAFT: 'Borrador',
  REVIEWED: 'Revisado',
  VALID: 'Válido',
  INVALID: 'Inválido',
  DOUBTFUL: 'Dudoso',
};
export const STATUS_COLORS: Record<ReviewStatus, string> = {
  DRAFT: '#94a3b8',
  REVIEWED: '#60a5fa',
  VALID: '#22c55e',
  INVALID: '#ef5350',
  DOUBTFUL: '#eab308',
};
