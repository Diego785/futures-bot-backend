import { computeHtfBias, biasAt, alignBias, type BiasPoint } from '../htf-bias';
import type { ObCandle } from '../../bot-analysis/ob.detector';

const oc = (openTime: number, open: number, high: number, low: number, close: number): ObCandle => ({
  openTime,
  open,
  high,
  low,
  close,
});

describe('computeHtfBias', () => {
  it('marca sesgo alcista cuando el precio rompe un swing high (BOS por cuerpo)', () => {
    // swing high en idx2 (105); idx6 cierra 107 > 105 → BOS alcista. swingLookback 2.
    const candles: ObCandle[] = [
      oc(0, 101, 104, 100, 103),
      oc(1, 103, 104, 100, 102),
      oc(2, 102, 105, 101, 104), // swing high 105
      oc(3, 103, 104, 100, 101),
      oc(4, 101, 103, 99, 100),
      oc(5, 100, 101, 96, 97),
      oc(6, 97, 108, 97, 107), // BOS alcista
    ];
    const series = computeHtfBias(candles, 2);
    expect(series).toHaveLength(1);
    expect(series[0].bias).toBe('bullish');
    expect(series[0].time).toBe(6);
  });
});

describe('biasAt', () => {
  it('devuelve el sesgo vigente al tiempo dado (causal)', () => {
    const s: BiasPoint[] = [
      { time: 10, bias: 'bullish' },
      { time: 20, bias: 'bearish' },
    ];
    expect(biasAt(s, 5)).toBe('neutral'); // antes del primer cambio
    expect(biasAt(s, 10)).toBe('bullish'); // justo en el cambio
    expect(biasAt(s, 15)).toBe('bullish'); // se mantiene
    expect(biasAt(s, 20)).toBe('bearish');
    expect(biasAt(s, 99)).toBe('bearish'); // último vigente
  });
});

describe('alignBias', () => {
  it('exige unanimidad: dirección común si todas coinciden, si no neutral', () => {
    const a: BiasPoint[] = [
      { time: 0, bias: 'bullish' },
      { time: 50, bias: 'bearish' },
    ];
    const b: BiasPoint[] = [
      { time: 0, bias: 'bullish' },
      { time: 30, bias: 'bearish' },
    ];
    const m = alignBias([a, b]);
    expect(biasAt(m, 0)).toBe('bullish'); // ambas alcistas
    expect(biasAt(m, 10)).toBe('bullish');
    expect(biasAt(m, 30)).toBe('neutral'); // a alcista, b bajista → discrepan
    expect(biasAt(m, 49)).toBe('neutral');
    expect(biasAt(m, 50)).toBe('bearish'); // ambas bajistas
  });

  it('una sola serie se devuelve tal cual', () => {
    const a: BiasPoint[] = [{ time: 5, bias: 'bullish' }];
    expect(alignBias([a])).toBe(a);
  });
});
