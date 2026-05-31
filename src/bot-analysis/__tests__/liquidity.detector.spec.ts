import { detectLiquidity, type LiqCandle, type LiqParams } from '../liquidity.detector';

const P: LiqParams = {
  swingLookback: 2,
  clusterTolerancePct: 0.1,
  minTouchesForEqualLiquidity: 2,
  maxDistanceFromPricePct: null,
  showSweptLiquidity: false,
  maxLevels: 12,
};

const c = (openTime: number, high: number, low: number, close: number): LiqCandle => ({ openTime, high, low, close });

describe('detectLiquidity', () => {
  it('agrupa dos máximos ~iguales en una liquidez buyside (equalHigh, 2 toques)', () => {
    const candles = [
      c(1, 90, 85, 89), c(2, 95, 90, 94), c(3, 100, 95, 99), // pivote 100
      c(4, 95, 90, 94), c(5, 92, 88, 91), c(6, 96, 91, 95),
      c(7, 100.05, 95, 99), // pivote ~100
      c(8, 96, 91, 95), c(9, 93, 88, 92),
    ];
    const eq = detectLiquidity('BTCUSDT', '15m', candles, P).find((l) => l.type === 'equalHigh');
    expect(eq).toBeDefined();
    expect(eq!.side).toBe('buyside');
    expect(eq!.touches).toBe(2);
    expect(eq!.level).toBeCloseTo(100.025);
    expect(eq!.candleTimes).toEqual([3, 7]);
    expect(eq!.swept).toBe(false);
  });

  it('un máximo aislado es swingHigh (1 toque)', () => {
    const candles = [c(1, 90, 85, 89), c(2, 95, 90, 94), c(3, 100, 95, 99), c(4, 95, 90, 94), c(5, 92, 88, 91)];
    const sw = detectLiquidity('BTCUSDT', '15m', candles, P).find((l) => l.side === 'buyside');
    expect(sw?.type).toBe('swingHigh');
    expect(sw?.touches).toBe(1);
  });

  it('liquidez barrida se omite por defecto y aparece con showSweptLiquidity', () => {
    const candles = [
      c(1, 90, 85, 89), c(2, 95, 90, 94), c(3, 100, 95, 99), // pivote 100
      c(4, 95, 90, 94), c(5, 96, 91, 95), c(6, 105, 100, 104), // barre el 100
    ];
    const def = detectLiquidity('BTCUSDT', '15m', candles, P).find((l) => l.side === 'buyside');
    expect(def).toBeUndefined(); // barrida → filtrada por defecto
    const withSwept = detectLiquidity('BTCUSDT', '15m', candles, { ...P, showSweptLiquidity: true }).find((l) => l.side === 'buyside');
    expect(withSwept?.swept).toBe(true);
    expect(withSwept?.sweptAtTime).toBe(6);
  });

  it('agrupa dos mínimos ~iguales en una liquidez sellside (equalLow)', () => {
    const candles = [
      c(1, 60, 55, 56), c(2, 58, 52, 53), c(3, 57, 50, 51), // pivote 50
      c(4, 58, 53, 54), c(5, 60, 56, 59), c(6, 59, 54, 58),
      c(7, 57, 50.03, 51), // pivote ~50
      c(8, 58, 53, 54), c(9, 60, 55, 59),
    ];
    const eq = detectLiquidity('BTCUSDT', '15m', candles, P).find((l) => l.type === 'equalLow');
    expect(eq).toBeDefined();
    expect(eq!.side).toBe('sellside');
    expect(eq!.touches).toBe(2);
    expect(eq!.level).toBeCloseTo(50.015);
  });

  it('id determinista', () => {
    const candles = [c(1, 90, 85, 89), c(2, 95, 90, 94), c(3, 100, 95, 99), c(4, 95, 90, 94), c(5, 92, 88, 91)];
    const sw = detectLiquidity('BTCUSDT', '15m', candles, P).find((l) => l.side === 'buyside');
    expect(sw?.id).toBe('liq_BTCUSDT_15m_swingHigh_10000');
  });
});
