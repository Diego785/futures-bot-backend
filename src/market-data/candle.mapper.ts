import type { Candle } from '../exchange/interfaces/exchange.interfaces';

// Forma plana de una fila de vela canónica (lista para upsert). Coincide con CandleEntity
// pero sin acoplar el mapper a TypeORM, para poder testearlo puro (sin DB).
export interface CandleRow {
  symbol: string;
  tf: string;
  openTime: number;
  closeTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  quoteVolume: number | null;
  trades: number | null;
  isClosed: boolean;
}

/**
 * Convierte una Candle cruda del exchange (sin symbol/tf) al modelo canónico persistible,
 * añadiendo symbol, tf e isClosed. Función pura — sin efectos, testeable sin DB.
 */
export function toCandleRow(
  symbol: string,
  tf: string,
  candle: Candle,
  isClosed: boolean,
): CandleRow {
  return {
    symbol,
    tf,
    openTime: candle.openTime,
    closeTime: candle.closeTime,
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    quoteVolume: candle.quoteVolume ?? null,
    trades: candle.trades ?? null,
    isClosed,
  };
}
