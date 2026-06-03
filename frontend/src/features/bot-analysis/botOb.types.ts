// Order Blocks del bot (Fase 5B). Capa visual/comparativa, NO señal. Lectura propia del bot.
export type ObDirection = 'bullish' | 'bearish';
export type ObState = 'untouched' | 'touched' | 'mitigated' | 'invalidated';

export interface BotOb {
  id: string;
  symbol: string;
  tf: string;
  direction: ObDirection;
  originTime: number;
  confirmedAtTime: number;
  obLow: number;
  obHigh: number;
  strength: number;
  brokeStructure: boolean;
  leftImbalance: boolean;
  state: ObState;
  timeStart: number;
  timeEnd: number;
}

export interface BotObResponse {
  symbol: string;
  tf: string;
  count: number;
  obs: BotOb[];
}

// Colores del OB del bot: distintos de las marcas (azul/púrpura) y del FVG (cian/rosa).
export const OB_COLORS: Record<ObDirection, string> = {
  bullish: '#34d399',
  bearish: '#fb923c',
};
export const OB_STATE_LABELS: Record<ObState, string> = {
  untouched: 'Intacto',
  touched: 'Tocado',
  mitigated: 'Mitigado',
  invalidated: 'Invalidado',
};

// Un OB roto (mitigated/invalidated) es un Breaker Block (Video 3): POI con función INVERTIDA.
export function isBrokenOb(state: ObState): boolean {
  return state === 'mitigated' || state === 'invalidated';
}
// Dirección invertida del breaker: un OB de COMPRA roto pasa a ser resistencia (bajista) y viceversa.
export function breakerDirection(d: ObDirection): ObDirection {
  return d === 'bullish' ? 'bearish' : 'bullish';
}
// Colores del Breaker Block, indexados por su función YA invertida (soporte alcista / resistencia bajista).
export const OB_BREAKER_COLORS: Record<ObDirection, string> = {
  bullish: '#22c55e', // ahora actúa como soporte
  bearish: '#ef4444', // ahora actúa como resistencia
};
