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

// La confluencia se dibuja como MARCO (borde grueso, sin relleno) sobre las zonas base.
// Escala blanco→gris por rating, que no colisiona con ningún color de capa.
export const CONF_COLORS: Record<ConfluenceRating, string> = {
  HIGH: '#ffffff',
  MEDIUM: '#cbd5e1',
  LOW: '#64748b',
};
