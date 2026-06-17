import type { Bias } from './botBias.types';

// Resumen por símbolo (GET /api/bot/watchlist) para monitorear los 10 pares de un vistazo.
export interface WatchlistItem {
  symbol: string;
  bias: Bias; // sesgo 4H vigente
  price: number; // último cierre 15m
  target: { type: string; level: number; distPct: number } | null; // próxima liquidez a barrer
}

export interface WatchlistResponse {
  watchlist: WatchlistItem[];
}
