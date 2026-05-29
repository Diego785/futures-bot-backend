import { toCandleRow } from '../candle.mapper';
import type { Candle } from '../../exchange/interfaces/exchange.interfaces';

const rawCandle: Candle = {
  openTime: 1748520000000,
  open: 100000.5,
  high: 100500.25,
  low: 99800.1,
  close: 100200.75,
  volume: 12.345,
  closeTime: 1748520899999,
  quoteVolume: 1234567.89,
  trades: 4321,
};

describe('toCandleRow (raw exchange Candle → fila canónica)', () => {
  it('añade symbol, tf e isClosed y preserva OHLCV/tiempos', () => {
    const row = toCandleRow('BTCUSDT', '15m', rawCandle, true);
    expect(row).toEqual({
      symbol: 'BTCUSDT',
      tf: '15m',
      openTime: 1748520000000,
      closeTime: 1748520899999,
      open: 100000.5,
      high: 100500.25,
      low: 99800.1,
      close: 100200.75,
      volume: 12.345,
      quoteVolume: 1234567.89,
      trades: 4321,
      isClosed: true,
    });
  });

  it('marca isClosed=false para velas en formación', () => {
    expect(toCandleRow('BTCUSDT', '1h', rawCandle, false).isClosed).toBe(false);
  });

  it('mapea quoteVolume/trades ausentes a null (caso Bybit)', () => {
    const partial = { ...rawCandle, quoteVolume: undefined as any, trades: undefined as any };
    const row = toCandleRow('ETHUSDT', '4h', partial, true);
    expect(row.quoteVolume).toBeNull();
    expect(row.trades).toBeNull();
  });
});
