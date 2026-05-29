import { toCandleDto } from '../candle.presenter';
import type { CandleEntity } from '../entities/candle.entity';

const row = {
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
} as CandleEntity;

describe('toCandleDto (proyección entidad → contrato)', () => {
  it('mapea open/high/low/close/volume → o/h/l/c/v', () => {
    expect(toCandleDto(row)).toEqual({
      symbol: 'BTCUSDT',
      tf: '15m',
      openTime: 1748520000000,
      closeTime: 1748520899999,
      o: 100000.5,
      h: 100500.25,
      l: 99800.1,
      c: 100200.75,
      v: 12.345,
      quoteVolume: 1234567.89,
      trades: 4321,
      isClosed: true,
    });
  });

  it('NO expone open/high/low/close/volume crudos', () => {
    const dto = toCandleDto(row) as Record<string, unknown>;
    expect(dto.open).toBeUndefined();
    expect(dto.high).toBeUndefined();
    expect(dto.low).toBeUndefined();
    expect(dto.close).toBeUndefined();
    expect(dto.volume).toBeUndefined();
  });
});
