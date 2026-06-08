import { runBacktest, runGrid, type RunnerCandle } from '../backtest.runner';

const oc = (openTime: number, open: number, high: number, low: number, close: number): RunnerCandle => ({
  openTime,
  open,
  high,
  low,
  close,
});

// Sweep alcista (swing low 95 en idx2; idx5 barre a 90 y reclama a 102) + retroceso que llena el CE
// (92.5) y alcanza el TP fixedR (98.5). Tubería completa señal → simulación → métricas.
const SERIES: RunnerCandle[] = [
  oc(0, 105, 110, 100, 105),
  oc(1, 104, 109, 101, 104),
  oc(2, 103, 108, 95, 103), // swing low 95
  oc(3, 102, 107, 101, 102),
  oc(4, 101, 106, 100, 101),
  oc(5, 101, 104, 90, 102), // sweep + reclaim → intent: entry 92.5, SL 89.5, TP 98.5
  oc(6, 102, 95, 92, 94), // retrocede y llena el límite (low 92 ≤ 92.5)
  oc(7, 94, 99, 93, 98), // alcanza el TP (high 99 ≥ 98.5)
];

describe('runBacktest — tubería end-to-end', () => {
  it('un sweep que llena y toca TP → 1 trade ganador (+2R sin costes)', () => {
    const r = runBacktest('BTCUSDT', '15m', SERIES, { gatillo: 'C', tpRule: 'fixedR', swingLookback: 2 }, { feeRatePerSide: 0, slippagePerSide: 0 });
    expect(r.signals).toBe(1);
    expect(r.metrics.trades).toBe(1);
    expect(r.metrics.wins).toBe(1);
    expect(r.metrics.expectancyR).toBe(2);
    expect(r.metrics.exitReasons.TP).toBe(1);
    expect(r.metrics.fillRate).toBe(1);
  });

  it('los costes recortan la expectancy por debajo del nominal', () => {
    const r = runBacktest('BTCUSDT', '15m', SERIES, { gatillo: 'C', tpRule: 'fixedR', swingLookback: 2 }, { feeRatePerSide: 0.0005, slippagePerSide: 0 });
    expect(r.metrics.expectancyR).toBeLessThan(2);
    expect(r.metrics.expectancyR).toBeGreaterThan(1.9);
  });
});

describe('runGrid', () => {
  it('produce una celda por combinación gatillo × TP', () => {
    const reports = runGrid('BTCUSDT', '15m', SERIES, ['A', 'B', 'C'], ['fixedR', 'liquidity'], { swingLookback: 2 });
    expect(reports).toHaveLength(6);
    expect(reports.every((r) => r.tf === '15m')).toBe(true);
    const cells = reports.map((r) => `${r.gatillo}-${r.tpRule}`);
    expect(cells).toContain('C-fixedR');
    expect(cells).toContain('A-liquidity');
  });
});
