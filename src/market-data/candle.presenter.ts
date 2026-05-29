import type { CandleEntity } from './entities/candle.entity';

// Shape del contrato hacia el front (API-CONTRACT): OHLCV abreviado o/h/l/c/v.
export interface CandleDto {
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

/**
 * Proyecta la entidad interna (open/high/low/close/volume) al shape del contrato (o/h/l/c/v).
 * Frontera deliberada: el front nunca recibe open/high/low/close. Función pura.
 */
export function toCandleDto(row: CandleEntity): CandleDto {
  return {
    symbol: row.symbol,
    tf: row.tf,
    openTime: row.openTime,
    closeTime: row.closeTime,
    o: row.open,
    h: row.high,
    l: row.low,
    c: row.close,
    v: row.volume,
    quoteVolume: row.quoteVolume,
    trades: row.trades,
    isClosed: row.isClosed,
  };
}
