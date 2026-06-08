import { generateIntents } from '../signal-source';
import { detectOrderBlocks, type ObCandle } from '../../bot-analysis/ob.detector';
import { detectSweeps } from '../../bot-analysis/sweep.detector';

// Vela OHLC (openTime = índice para legibilidad).
const oc = (openTime: number, open: number, high: number, low: number, close: number): ObCandle => ({
  openTime,
  open,
  high,
  low,
  close,
});

// Serie que produce UN OB estructural alcista (swing high en idx2=105; origen bajista en idx5;
// impulso fuerte en idx6 cierra 107 > 105 = BOS). swingLookback=2.
const A_SERIES: ObCandle[] = [
  oc(0, 101, 104, 100, 103),
  oc(1, 103, 104, 100, 102),
  oc(2, 102, 105, 101, 104), // swing high 105
  oc(3, 103, 104, 100, 101),
  oc(4, 101, 103, 99, 100),
  oc(5, 100, 101, 96, 97), // origen del OB (última bajista antes del impulso)
  oc(6, 97, 108, 97, 107), // BOS alcista (cierre 107 > 105)
];

// Serie que produce UN sweep alcista (swing low en idx2=95; idx5 mecha a 90 < 95 y cierra 102 > 95).
const C_SERIES: ObCandle[] = [
  oc(0, 105, 110, 100, 105),
  oc(1, 104, 109, 101, 104),
  oc(2, 103, 108, 95, 103), // swing low 95
  oc(3, 102, 107, 101, 102),
  oc(4, 101, 106, 100, 101),
  oc(5, 101, 104, 90, 102), // sweep+reclaim (low 90 < 95, close 102 > 95)
];

const LB2 = { swingLookback: 2, slBufferFrac: 0.1, rMultipleTp: 2, minRr: 1 } as const;

describe('generateIntents — modo A (riesgo)', () => {
  it('mapea cada OB a un límite en su CE con SL en el distal + buffer', () => {
    const obs = detectOrderBlocks('BTCUSDT', '4h', A_SERIES, {
      swingLookback: 2,
      showLastBullish: 1e9,
      showLastBearish: 1e9,
    });
    expect(obs).toHaveLength(1);
    const o = obs[0];

    const intents = generateIntents('BTCUSDT', '4h', A_SERIES, { gatillo: 'A', tpRule: 'fixedR', ...LB2 });
    expect(intents).toHaveLength(1);
    const it = intents[0];

    const range = o.obHigh - o.obLow;
    const entry = (o.obLow + o.obHigh) / 2;
    const sl = o.direction === 'bullish' ? o.obLow - 0.1 * range : o.obHigh + 0.1 * range;
    const risk = Math.abs(entry - sl);

    expect(it.direction).toBe('LONG');
    expect(it.signalBarTime).toBe(o.confirmedAtTime); // causal: se conoce al BOS
    expect(it.entry).toBeCloseTo(entry, 6);
    expect(it.stopLoss).toBeCloseTo(sl, 6);
    expect(it.takeProfit).toBeCloseTo(entry + 2 * risk, 6); // fixedR 2R
    expect(it.invalidationPrice).toBeCloseTo(o.obLow, 6); // distal alcista
    expect(it.id).toBe(`A_BTCUSDT_4h_${o.originTime}`);
  });
});

describe('generateIntents — modo B (confirmación)', () => {
  it('sin madre mitigada previa, un OB suelto NO genera intent', () => {
    const intents = generateIntents('BTCUSDT', '4h', A_SERIES, { gatillo: 'B', tpRule: 'fixedR', ...LB2 });
    expect(intents).toHaveLength(0);
  });
});

describe('generateIntents — modo C (sweep + reclaim)', () => {
  it('mapea el sweep a una entrada en la reacción con SL bajo la mecha', () => {
    const sweeps = detectSweeps('BTCUSDT', '15m', C_SERIES, { swingLookback: 2 });
    expect(sweeps).toHaveLength(1);
    const s = sweeps[0];

    const intents = generateIntents('BTCUSDT', '15m', C_SERIES, { gatillo: 'C', tpRule: 'fixedR', ...LB2 });
    expect(intents).toHaveLength(1);
    const it = intents[0];

    const zoneLow = s.wickExtreme; // bullish: low de la mecha
    const zoneHigh = s.sweptLevel; // nivel barrido
    const range = zoneHigh - zoneLow;
    const entry = (zoneLow + zoneHigh) / 2;
    const sl = zoneLow - 0.1 * range; // bajo la mecha

    expect(it.direction).toBe('LONG');
    expect(it.signalBarTime).toBe(s.sweepBarTime);
    expect(it.entry).toBeCloseTo(entry, 6);
    expect(it.stopLoss).toBeCloseTo(sl, 6);
    expect(it.invalidationPrice).toBeCloseTo(zoneLow, 6);
    expect(it.id).toBe(`C_BTCUSDT_15m_${s.sweepBarTime}`);
  });

  it('TP por liquidez cae a R-fijo cuando no hay nivel válido', () => {
    const intents = generateIntents('BTCUSDT', '15m', C_SERIES, { gatillo: 'C', tpRule: 'liquidity', ...LB2 });
    expect(intents).toHaveLength(1);
    const it = intents[0];
    const risk = Math.abs(it.entry - it.stopLoss);
    expect(it.takeProfit).toBeCloseTo(it.entry + 2 * risk, 6); // fallback fixedR
  });
});
