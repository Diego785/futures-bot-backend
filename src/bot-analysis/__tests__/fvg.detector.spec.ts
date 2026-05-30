import { detectStrictFvgs, type FvgCandle } from '../fvg.detector';

// Helper: vela por (openTime, high, low).
const c = (openTime: number, high: number, low: number): FvgCandle => ({ openTime, high, low });

describe('detectStrictFvgs', () => {
  it('detecta un FVG alcista (high c1 < low c3) con el gap correcto', () => {
    const candles = [c(1, 100, 90), c(2, 130, 115), c(3, 140, 120)];
    const [fvg] = detectStrictFvgs('BTCUSDT', '15m', candles);
    expect(fvg.direction).toBe('bullish');
    expect(fvg.gapLow).toBe(100); // high(c1)
    expect(fvg.gapHigh).toBe(120); // low(c3)
    expect(fvg.candle1Time).toBe(1);
    expect(fvg.candle3Time).toBe(3);
    expect(fvg.state).toBe('open'); // no hay velas posteriores
  });

  it('detecta un FVG bajista (low c1 > high c3)', () => {
    const candles = [c(1, 140, 120), c(2, 115, 100), c(3, 110, 90)];
    const [fvg] = detectStrictFvgs('BTCUSDT', '15m', candles);
    expect(fvg.direction).toBe('bearish');
    expect(fvg.gapLow).toBe(110); // high(c3)
    expect(fvg.gapHigh).toBe(120); // low(c1)
  });

  it('NO detecta FVG cuando c1 y c3 se solapan', () => {
    const candles = [c(1, 100, 90), c(2, 105, 95), c(3, 102, 92)];
    expect(detectStrictFvgs('BTCUSDT', '15m', candles)).toHaveLength(0);
  });

  it('marca filled cuando una vela posterior cruza todo el gap alcista', () => {
    // gap alcista [100,120]; luego una vela baja por debajo de 100 -> filled
    const candles = [c(1, 100, 90), c(2, 130, 115), c(3, 140, 120), c(4, 125, 95)];
    const [fvg] = detectStrictFvgs('BTCUSDT', '15m', candles);
    expect(fvg.state).toBe('filled');
    expect(fvg.fillRatio).toBeGreaterThanOrEqual(1);
  });

  it('marca partial cuando el precio entra al gap a medias', () => {
    // gap alcista [100,120] (tamaño 20); vela posterior con low=108 -> ratio (120-108)/20=0.6
    const candles = [c(1, 100, 90), c(2, 130, 115), c(3, 140, 120), c(4, 125, 108)];
    const [fvg] = detectStrictFvgs('BTCUSDT', '15m', candles);
    expect(fvg.state).toBe('partial');
    expect(fvg.fillRatio).toBeCloseTo(0.6);
  });

  it('el id es determinista (mismo input -> mismo id)', () => {
    const candles = [c(1000, 100, 90), c(2000, 130, 115), c(3000, 140, 120)];
    const a = detectStrictFvgs('BTCUSDT', '15m', candles)[0].id;
    const b = detectStrictFvgs('BTCUSDT', '15m', candles)[0].id;
    expect(a).toBe(b);
    expect(a).toBe('fvg_BTCUSDT_15m_1000_u');
  });
});
