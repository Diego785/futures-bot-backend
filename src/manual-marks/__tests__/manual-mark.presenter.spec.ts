import { toManualMarkDto } from '../manual-mark.presenter';
import type { ManualMarkEntity } from '../entities/manual-mark.entity';

const base = {
  id: 'm1',
  sourceLayer: 'MyManualMarks',
  symbol: 'BTCUSDT',
  tf: '15m',
  note: '',
  createdAt: 1748520000000,
  updatedAt: 1748520000000,
};

describe('toManualMarkDto (proyección entidad → contrato)', () => {
  it('zona OB: incluye rango y OMITE price/side/entry/rr null', () => {
    const e = {
      ...base,
      kind: 'OB',
      timeStart: 1748520000000,
      timeEnd: 1748523600000,
      priceLow: 99800,
      priceHigh: 100200,
      price: null,
      side: null,
      entry: null,
      stopLoss: null,
      takeProfit: null,
      rr: null,
    } as ManualMarkEntity;
    const dto = toManualMarkDto(e) as Record<string, unknown>;
    expect(dto.priceLow).toBe(99800);
    expect(dto.priceHigh).toBe(100200);
    expect(dto.price).toBeUndefined();
    expect(dto.side).toBeUndefined();
    expect(dto.entry).toBeUndefined();
    expect(dto.rr).toBeUndefined();
  });

  it('TradePlan: incluye side/entry/SL/TP/rr', () => {
    const e = {
      ...base,
      kind: 'TradePlan',
      timeStart: 1748520000000,
      timeEnd: 1748523600000,
      priceLow: null,
      priceHigh: null,
      price: null,
      side: 'LONG',
      entry: 100000,
      stopLoss: 99500,
      takeProfit: 101000,
      rr: 2,
    } as ManualMarkEntity;
    const dto = toManualMarkDto(e);
    expect(dto.side).toBe('LONG');
    expect(dto.entry).toBe(100000);
    expect(dto.stopLoss).toBe(99500);
    expect(dto.takeProfit).toBe(101000);
    expect(dto.rr).toBe(2);
  });
});
