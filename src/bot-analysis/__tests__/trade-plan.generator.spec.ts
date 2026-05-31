import { generateTradePlans } from '../trade-plan.generator';
import type { BotSetup } from '../setup.detector';
import type { BotOb } from '../ob.detector';
import type { BotLiquidity } from '../liquidity.detector';

const setup = (
  state: BotSetup['state'],
  dir: 'bullish' | 'bearish',
  confObId: string | null,
  low = 100,
  high = 102,
): BotSetup =>
  ({ id: 's1', state, direction: dir, confirmationObId: confObId, priceLow: low, priceHigh: high, rating: 'HIGH', score: 90, timeStart: 10, armedAtTime: 20 } as unknown as BotSetup);
const ob = (id: string, low: number, high: number): BotOb => ({ id, obLow: low, obHigh: high } as unknown as BotOb);
const liq = (side: 'buyside' | 'sellside', level: number): BotLiquidity => ({ side, level } as unknown as BotLiquidity);

describe('generateTradePlans', () => {
  it('CONFIRMACIÓN: LONG desde ARMED, entry mid del OB, TP en buyside liquidity, NEAR', () => {
    const [p] = generateTradePlans('BTCUSDT', '15m', [setup('ARMED', 'bullish', 'ob1')], [ob('ob1', 100, 102)], [liq('buyside', 110)], 101, 'confirmation');
    expect(p.mode).toBe('confirmation');
    expect(p.side).toBe('LONG');
    expect(p.entry).toBe(101);
    expect(p.stopLoss).toBe(99.5);
    expect(p.takeProfit).toBe(110);
    expect(p.rr).toBeCloseTo(6);
    expect(p.operability).toBe('NEAR'); // entry == precio
  });

  it('CONFIRMACIÓN: SHORT desde ARMED, SL sobre el OB, TP en sellside liquidity', () => {
    const [p] = generateTradePlans('BTCUSDT', '15m', [setup('ARMED', 'bearish', 'ob1')], [ob('ob1', 100, 102)], [liq('sellside', 95)], 101, 'confirmation');
    expect(p.side).toBe('SHORT');
    expect(p.stopLoss).toBe(102.5);
    expect(p.takeProfit).toBe(95);
    expect(p.rr).toBeCloseTo(4);
  });

  it('en modo confirmación un setup NO ARMED no genera plan', () => {
    expect(generateTradePlans('BTCUSDT', '15m', [setup('MITIGATED', 'bullish', null)], [ob('ob1', 100, 102)], [], 101, 'confirmation')).toHaveLength(0);
  });

  it('sin liquidez opuesta → TP por R:R fallback', () => {
    const [p] = generateTradePlans('BTCUSDT', '15m', [setup('ARMED', 'bullish', 'ob1')], [ob('ob1', 100, 102)], [], 101, 'confirmation');
    expect(p.tpSource).toBe('rr_fallback');
    expect(p.takeProfit).toBe(104);
    expect(p.rr).toBeCloseTo(2);
  });

  it('operabilidad STRUCTURAL cuando el Entry está lejos del precio', () => {
    const [p] = generateTradePlans('BTCUSDT', '15m', [setup('ARMED', 'bullish', 'ob1')], [ob('ob1', 100, 102)], [liq('buyside', 110)], 130, 'confirmation');
    expect(p.operability).toBe('STRUCTURAL'); // ~22% de distancia
  });

  it('RIESGO: un setup MITIGATED genera plan desde la zona de confluencia (al toque), mode risk', () => {
    const [p] = generateTradePlans('BTCUSDT', '15m', [setup('MITIGATED', 'bullish', null)], [], [liq('buyside', 110)], 101, 'risk');
    expect(p.mode).toBe('risk');
    expect(p.side).toBe('LONG');
    expect(p.entry).toBe(101); // mid de la zona [100,102]
  });

  it('BOTH: ARMED → confirmación y WATCHING/MITIGATED → riesgo', () => {
    const setups = [setup('ARMED', 'bullish', 'ob1', 100, 102), setup('MITIGATED', 'bearish', null, 120, 122)];
    const plans = generateTradePlans('BTCUSDT', '15m', setups, [ob('ob1', 100, 102)], [liq('buyside', 110), liq('sellside', 95)], 110, 'both');
    expect(plans).toHaveLength(2);
    expect(plans.filter((p) => p.mode === 'confirmation')).toHaveLength(1);
    expect(plans.filter((p) => p.mode === 'risk')).toHaveLength(1);
  });
});
