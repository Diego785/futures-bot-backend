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
  hasOB = true,
  obZoneLow: number | null = low,
  obZoneHigh: number | null = high,
): BotSetup =>
  ({ id: 's1', state, direction: dir, confirmationObId: confObId, priceLow: low, priceHigh: high, hasOB, obZoneLow, obZoneHigh, rating: 'HIGH', score: 90, timeStart: 10, mitigatedAtTime: state === 'WATCHING' ? null : 15, armedAtTime: 20 } as unknown as BotSetup);
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

  it('RIESGO: un setup MITIGATED con OB genera plan desde la zona madre OB (al toque), mode risk', () => {
    // Confluencia [100,102] pero la sub-zona OB es [100,101] → entry = mid del OB, no de la confluencia.
    const [p] = generateTradePlans('BTCUSDT', '15m', [setup('MITIGATED', 'bullish', null, 100, 102, true, 100, 101)], [], [liq('buyside', 110)], 101, 'risk');
    expect(p.mode).toBe('risk');
    expect(p.side).toBe('LONG');
    expect(p.entry).toBe(100.5); // mid del OB [100,101], NO 101 (mid de la confluencia completa)
    expect(p.riskWorked).toBe(true); // MITIGATED → zona ya trabajada (estudio histórico)
  });

  it('RIESGO: un setup MITIGATED SIN OB no genera plan (no es entrada SMC válida)', () => {
    const plans = generateTradePlans('BTCUSDT', '15m', [setup('MITIGATED', 'bullish', null, 100, 102, false, null, null)], [], [liq('buyside', 110)], 101, 'risk');
    expect(plans).toHaveLength(0);
  });

  it('RIESGO: un setup ARMED con OB también genera plan de riesgo (estudio), riskWorked=true', () => {
    const [p] = generateTradePlans('BTCUSDT', '15m', [setup('ARMED', 'bullish', 'ob1', 100, 102, true, 100, 101)], [ob('ob1', 100, 102)], [liq('buyside', 110)], 101, 'risk');
    expect(p.mode).toBe('risk');
    expect(p.entry).toBe(100.5); // mid del OB madre [100,101]
    expect(p.riskWorked).toBe(true); // ARMED → toque ya ocurrió
  });

  it('RIESGO: un setup WATCHING con OB da riesgo "vivo" (riskWorked=false)', () => {
    const [p] = generateTradePlans('BTCUSDT', '15m', [setup('WATCHING', 'bullish', null, 100, 102, true, 100, 101)], [], [liq('buyside', 110)], 101, 'risk');
    expect(p.mode).toBe('risk');
    expect(p.riskWorked).toBe(false); // aún no mitigada → entrada por riesgo aún futura
  });

  it('BOTH: un setup ARMED con OB genera AMBOS (confirmación + riesgo), no excluyente', () => {
    // ARMED: OB de confirmación [100,102] (entry 101) y zona madre OB [100,101] (entry 100.5) → distintos.
    const setups = [setup('ARMED', 'bullish', 'ob1', 100, 102, true, 100, 101), setup('MITIGATED', 'bearish', null, 120, 122)];
    const plans = generateTradePlans('BTCUSDT', '15m', setups, [ob('ob1', 100, 102)], [liq('buyside', 110), liq('sellside', 95)], 110, 'both');
    expect(plans).toHaveLength(3); // ARMED→conf+risk (distintos), MITIGATED→risk
    expect(plans.filter((p) => p.mode === 'confirmation')).toHaveLength(1);
    expect(plans.filter((p) => p.mode === 'risk')).toHaveLength(2);
    expect(plans.filter((p) => p.mode === 'risk').every((p) => p.riskWorked === true)).toBe(true);
  });

  it('dedup: un riesgo idéntico (entry/SL/TP) a una confirmación se omite (mismo trade)', () => {
    // OB de confirmación [100,102] y zona madre OB [100,102] coinciden → conf y risk darían el mismo
    // plan exacto → el riesgo redundante se omite (queda solo la confirmación).
    const plans = generateTradePlans('BTCUSDT', '15m', [setup('ARMED', 'bullish', 'ob1', 100, 102, true, 100, 102)], [ob('ob1', 100, 102)], [liq('buyside', 110)], 101, 'both');
    expect(plans.filter((p) => p.mode === 'confirmation')).toHaveLength(1);
    expect(plans.filter((p) => p.mode === 'risk')).toHaveLength(0);
  });
});
