// Confluencia del bot (Fase 5D). Pondera zonas combinando OB+FVG+liquidez. NO es señal.
export type ConfluenceRating = 'LOW' | 'MEDIUM' | 'HIGH';

export interface ConfluenceZone {
  id: string;
  symbol: string;
  tf: string;
  direction: 'bullish' | 'bearish';
  priceLow: number;
  priceHigh: number;
  timeStart: number;
  score: number;
  rating: ConfluenceRating;
  hasOB: boolean;
  hasFVG: boolean;
  hasLiquidity: boolean;
  scoreOB: number;
  scoreFVG: number;
  scoreLiquidity: number;
  obStrength: number;
  componentIds: string[];
  distancePct: number;
}

export interface BotConfluenceResponse {
  symbol: string;
  tf: string;
  count: number;
  zones: ConfluenceZone[];
}

// Color por DIRECCIÓN = sesgo operativo (long=verde, short=rojo). El rating se expresa por
// grosor/intensidad del marco, no por color (ver CSS .conf-high/medium/low).
export const CONF_DIR_COLORS: Record<'bullish' | 'bearish', string> = {
  bullish: '#22c55e',
  bearish: '#ef4444',
};
