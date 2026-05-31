// Liquidez del bot (Fase 5C). Capa visual/comparativa, NO señal. Lectura propia del bot.
export type LiqType = 'equalHigh' | 'equalLow' | 'swingHigh' | 'swingLow';
export type LiqSide = 'buyside' | 'sellside';

export interface BotLiquidity {
  id: string;
  symbol: string;
  tf: string;
  type: LiqType;
  side: LiqSide;
  level: number;
  candleTimes: number[];
  touches: number;
  swept: boolean;
  sweptAtTime: number | null;
  distancePct: number;
  timeStart: number;
}

export interface BotLiqResponse {
  symbol: string;
  tf: string;
  count: number;
  levels: BotLiquidity[];
}

export const LIQ_TYPE_LABELS: Record<LiqType, string> = {
  equalHigh: 'Equal highs',
  equalLow: 'Equal lows',
  swingHigh: 'Swing high',
  swingLow: 'Swing low',
};

// Color único (oro): la liquidez se dibuja como LÍNEA (no caja), distinta de FVG/OB y de
// las marcas. El lado (buyside/sellside) se distingue por etiqueta y posición, no por color.
export const LIQ_COLOR = '#fbbf24';
