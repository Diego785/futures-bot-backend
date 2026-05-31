import { generateTradePlans } from '../trade-plan.generator';
import type { BotSetup } from '../setup.detector';
import type { BotOb } from '../ob.detector';
import type { BotLiquidity } from '../liquidity.detector';

const setup = (state: BotSetup['state'], dir: 'bullish' | 'bearish', confObId: string | null): BotSetup =>
  ({ id: 's1', state, direction: dir, confirmationObId: confObId, rating: 'HIGH', score: 90, timeStart: 10, armedAtTime: 20 } as unknown as BotSetup);
const ob = (id: string, low: number, high: number): BotOb => ({ id, obLow: low, obHigh: high } as unknown as BotOb);
const liq = (side: 'buyside' | 'sellside', level: number): BotLiquidity => ({ side, level } as unknown as BotLiquidity);

describe('generateTradePlans', () => {
  it('LONG desde setup ARMED: entry mid del OB, SL bajo el OB, TP en buyside liquidity', () => {
    const [p] = generateTradePlans('BTCUSDT', '15m', [setup('ARMED', 'bullish', 'ob1')], [ob('ob1', 100, 102)], [liq('buyside', 110)], 105);
    expect(p.side).toBe('LONG');
    expect(p.entry).toBe(101); // mid de [100,102]
    expect(p.stopLoss).toBe(99.5); // 100 − 0.25*2
    expect(p.takeProfit).toBe(110); // buyside liquidity
    expect(p.tpSource).toBe('liquidity');
    expect(p.rr).toBeCloseTo(6); // 9 / 1.5
    expect(p.minRrMet).toBe(true);
  });

  it('SHORT desde setup ARMED: SL sobre el OB, TP en sellside liquidity', () => {
    const [p] = generateTradePlans('BTCUSDT', '15m', [setup('ARMED', 'bearish', 'ob1')], [ob('ob1', 100, 102)], [liq('sellside', 95)], 98);
    expect(p.side).toBe('SHORT');
    expect(p.entry).toBe(101);
    expect(p.stopLoss).toBe(102.5); // 102 + 0.5
    expect(p.takeProfit).toBe(95);
    expect(p.rr).toBeCloseTo(4); // 6 / 1.5
  });

  it('un setup que NO está ARMED no genera plan', () => {
    expect(generateTradePlans('BTCUSDT', '15m', [setup('MITIGATED', 'bullish', null)], [ob('ob1', 100, 102)], [], 105)).toHaveLength(0);
  });

  it('sin liquidez opuesta → TP por R:R fallback', () => {
    const [p] = generateTradePlans('BTCUSDT', '15m', [setup('ARMED', 'bullish', 'ob1')], [ob('ob1', 100, 102)], [], 105);
    expect(p.tpSource).toBe('rr_fallback');
    expect(p.takeProfit).toBe(104); // 101 + 2*(101−99.5)
    expect(p.rr).toBeCloseTo(2);
  });

  it('si no se encuentra el OB de confirmación, no genera plan', () => {
    expect(generateTradePlans('BTCUSDT', '15m', [setup('ARMED', 'bullish', 'nope')], [], [], 105)).toHaveLength(0);
  });
});
