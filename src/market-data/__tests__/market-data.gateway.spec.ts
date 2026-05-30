import { roomFor, symbolRoom, computeStatus } from '../market-data.gateway';
import { rawToCandleDto } from '../candle.presenter';
import type { Candle } from '../../exchange/interfaces/exchange.interfaces';

describe('gateway rooms', () => {
  it('room por (symbol, tf) y por símbolo', () => {
    expect(roomFor('BTCUSDT', '15m')).toBe('c:BTCUSDT:15m');
    expect(symbolRoom('BTCUSDT')).toBe('p:BTCUSDT');
  });
});

describe('computeStatus', () => {
  const STALE = 30_000;
  it('OFFLINE cuando no hay live', () => {
    expect(computeStatus(false, Date.now(), Date.now(), STALE)).toBe('OFFLINE');
  });
  it('STALE cuando live pero sin datos aún', () => {
    expect(computeStatus(true, null, 1_000_000, STALE)).toBe('STALE');
  });
  it('LIVE cuando el último dato es reciente', () => {
    expect(computeStatus(true, 1_000_000, 1_010_000, STALE)).toBe('LIVE');
  });
  it('STALE cuando el último dato es viejo', () => {
    expect(computeStatus(true, 1_000_000, 1_000_000 + STALE + 1, STALE)).toBe('STALE');
  });
});

describe('rawToCandleDto', () => {
  const raw: Candle = {
    openTime: 1748520000000,
    open: 100,
    high: 110,
    low: 95,
    close: 105,
    volume: 12.3,
    closeTime: 1748520899999,
    quoteVolume: 999,
    trades: 42,
  };
  it('proyecta open/high/low/close → o/h/l/c y añade symbol/tf/isClosed', () => {
    expect(rawToCandleDto('BTCUSDT', '15m', raw, false)).toEqual({
      symbol: 'BTCUSDT',
      tf: '15m',
      openTime: 1748520000000,
      closeTime: 1748520899999,
      o: 100,
      h: 110,
      l: 95,
      c: 105,
      v: 12.3,
      quoteVolume: 999,
      trades: 42,
      isClosed: false,
    });
  });
});
