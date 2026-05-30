export type Timeframe = '15m' | '1h' | '4h' | '1d';
export const TIMEFRAMES: Timeframe[] = ['15m', '1h', '4h', '1d'];

// Vela del contrato del backend (ver docs/API-CONTRACT.md): OHLCV abreviado o/h/l/c/v.
export interface Candle {
  symbol: string;
  tf: string;
  openTime: number;
  closeTime: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  quoteVolume: number | null;
  trades: number | null;
  isClosed: boolean;
}

export interface CandlesResponse {
  symbol: string;
  tf: string;
  count: number;
  oldestOpenTime: number | null;
  newestOpenTime: number | null;
  hasMoreOlder: boolean;
  candles: Candle[];
}
