import { computeRr } from '../manual-mark.mapper';

describe('computeRr (R:R del TradePlan)', () => {
  it('LONG: SL a −1R, TP a +2R → 2.0', () => {
    expect(computeRr('TradePlan', 100, 99, 102)).toBeCloseTo(2);
  });

  it('SHORT: SL a +1R, TP a −2R → 2.0', () => {
    expect(computeRr('TradePlan', 100, 101, 98)).toBeCloseTo(2);
  });

  it('riesgo 0 (entry == SL) → null', () => {
    expect(computeRr('TradePlan', 100, 100, 102)).toBeNull();
  });

  it('no es TradePlan → null (las zonas/niveles no tienen R:R)', () => {
    expect(computeRr('OB', 100, 99, 102)).toBeNull();
    expect(computeRr('Liquidity', 100, 99, 102)).toBeNull();
  });

  it('falta algún precio → null', () => {
    expect(computeRr('TradePlan', 100, null, 102)).toBeNull();
    expect(computeRr('TradePlan', null, 99, 102)).toBeNull();
    expect(computeRr('TradePlan', 100, 99, null)).toBeNull();
  });
});
