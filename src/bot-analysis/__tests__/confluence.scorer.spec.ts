import { scoreConfluence } from '../confluence.scorer';
import type { BotOb } from '../ob.detector';
import type { StrictFvg } from '../fvg.detector';
import type { BotLiquidity } from '../liquidity.detector';

const ob = (id: string, dir: 'bullish' | 'bearish', low: number, high: number, strength = 2): BotOb =>
  ({ id, direction: dir, obLow: low, obHigh: high, timeStart: 10, state: 'untouched', strength } as unknown as BotOb);
const fvg = (id: string, dir: 'bullish' | 'bearish', low: number, high: number): StrictFvg =>
  ({ id, direction: dir, gapLow: low, gapHigh: high, timeStart: 11, state: 'open' } as unknown as StrictFvg);
const liq = (id: string, level: number, type: BotLiquidity['type']): BotLiquidity =>
  ({ id, level, type, side: 'buyside' } as unknown as BotLiquidity);

describe('scoreConfluence', () => {
  it('OB + FVG solapados + liquidez equal cercana → HIGH con 3 componentes', () => {
    const zones = scoreConfluence(
      'BTCUSDT', '15m',
      [fvg('f1', 'bullish', 99.5, 100.5)],
      [ob('o1', 'bullish', 99, 101)],
      [liq('l1', 101.2, 'equalHigh')],
      100, // precio dentro de la zona
    );
    expect(zones).toHaveLength(1);
    expect(zones[0].hasOB && zones[0].hasFVG && zones[0].hasLiquidity).toBe(true);
    expect(zones[0].rating).toBe('HIGH');
    expect(zones[0].id).toBe('conf_BTCUSDT_15m_u_9900');
  });

  it('OB + FVG solapados sin liquidez → MEDIUM (2 tipos)', () => {
    const zones = scoreConfluence('BTCUSDT', '15m', [fvg('f1', 'bullish', 99.5, 100.5)], [ob('o1', 'bullish', 99, 101)], [], 100);
    expect(zones).toHaveLength(1);
    expect(zones[0].rating).toBe('MEDIUM');
    expect(zones[0].hasLiquidity).toBe(false);
  });

  it('OB solo (sin FVG ni liquidez) → no es confluencia (se descarta)', () => {
    expect(scoreConfluence('BTCUSDT', '15m', [], [ob('o1', 'bullish', 99, 101)], [], 100)).toHaveLength(0);
  });

  it('OB y FVG de direcciones opuestas no se fusionan → sin confluencia', () => {
    const zones = scoreConfluence('BTCUSDT', '15m', [fvg('f1', 'bearish', 99.5, 100.5)], [ob('o1', 'bullish', 99, 101)], [], 100);
    expect(zones).toHaveLength(0);
  });

  it('OB + liquidez pero lejos del precio → LOW (penalización por distancia)', () => {
    const zones = scoreConfluence('BTCUSDT', '15m', [], [ob('o1', 'bullish', 99, 101, 1.5)], [liq('l1', 99, 'equalLow')], 130);
    expect(zones).toHaveLength(1);
    expect(zones[0].hasOB && zones[0].hasLiquidity).toBe(true);
    expect(zones[0].rating).toBe('LOW');
  });
});
