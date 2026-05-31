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
