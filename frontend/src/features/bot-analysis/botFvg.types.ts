// Lectura automática del bot (Fase 5A). StrictFVG: capa visual/comparativa, NO señal.
// Es la lectura PROPIA del bot (no copia las marcas del usuario); el usuario la contrasta
// con su análisis. Ver docs/VISION-V2.md ("compara, no imita").
export type FvgDirection = 'bullish' | 'bearish';
export type FvgState = 'open' | 'touched' | 'partial' | 'filled';

export interface BotFvg {
  id: string;
  symbol: string;
  tf: string;
  direction: FvgDirection;
  candle1Time: number;
  candle2Time: number;
  candle3Time: number;
  gapLow: number;
  gapHigh: number;
  timeStart: number;
  timeEnd: number;
  state: FvgState;
  fillRatio: number;
}

export interface BotFvgResponse {
  symbol: string;
  tf: string;
  count: number;
  fvgs: BotFvg[];
}

export const FVG_STATE_LABELS: Record<FvgState, string> = {
  open: 'Abierto',
  touched: 'Tocado',
  partial: 'Parcial',
  filled: 'Lleno',
};
// Color por dirección (distinto de las marcas manuales: cian/rosa).
export const FVG_COLORS: Record<FvgDirection, string> = {
  bullish: '#22d3ee',
  bearish: '#f472b6',
};
