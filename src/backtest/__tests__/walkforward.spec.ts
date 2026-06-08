import { walkForward } from '../walkforward';
import { runBacktest, type RunnerCandle } from '../backtest.runner';

const oc = (openTime: number, open: number, high: number, low: number, close: number): RunnerCandle => ({
  openTime,
  open,
  high,
  low,
  close,
});

// Mismo escenario del runner: sweep alcista que llena y toca TP (+2R sin costes).
const SERIES: RunnerCandle[] = [
  oc(0, 105, 110, 100, 105),
  oc(1, 104, 109, 101, 104),
  oc(2, 103, 108, 95, 103),
  oc(3, 102, 107, 101, 102),
  oc(4, 101, 106, 100, 101),
  oc(5, 101, 104, 90, 102),
  oc(6, 102, 95, 92, 94),
  oc(7, 94, 99, 93, 98),
];

const CFG = { gatillo: 'C' as const, tpRule: 'fixedR' as const, swingLookback: 2 };
const NO_COST = { feeRatePerSide: 0, slippagePerSide: 0 };

describe('walkForward', () => {
  it('nWindows=1 reproduce el backtest completo', () => {
    const wf = walkForward('BTCUSDT', '15m', SERIES, 1, CFG, NO_COST);
    const single = runBacktest('BTCUSDT', '15m', SERIES, CFG, NO_COST);
    expect(wf.windows).toHaveLength(1);
    expect(wf.totalTrades).toBe(single.metrics.trades);
    expect(wf.pooledExpectancyR).toBe(single.metrics.expectancyR);
    expect(wf.profitableWindows).toBe(1);
    expect(wf.pctProfitable).toBe(1);
  });

  it('parte el histórico en N ventanas consecutivas', () => {
    const wf = walkForward('BTCUSDT', '15m', SERIES, 2, CFG, NO_COST);
    expect(wf.windows).toHaveLength(2);
    expect(wf.windows[0].candles + wf.windows[1].candles).toBe(SERIES.length);
    // al partir, el sweep (swing idx2 + barrido idx5) queda roto entre ventanas → sin trades
    expect(wf.totalTrades).toBe(0);
    expect(wf.windowsCount).toBe(0);
  });

  it('agrega % de ventanas rentables y pooled expectancy sin NaN', () => {
    const wf = walkForward('BTCUSDT', '15m', SERIES, 3, CFG, NO_COST);
    expect(wf.windows).toHaveLength(3);
    expect(Number.isFinite(wf.pctProfitable)).toBe(true);
    expect(Number.isFinite(wf.pooledExpectancyR)).toBe(true);
    expect(Number.isFinite(wf.meanExpectancyR)).toBe(true);
  });
});
