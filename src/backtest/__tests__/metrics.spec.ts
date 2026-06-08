import { computeMetrics } from '../metrics';
import type { ExitReason, SimResult, SimTrade } from '../trade-simulator';

// Construye un resultado 'filled' con la R y el tiempo de entrada dados (resto irrelevante para métricas).
const filled = (
  rMultiple: number,
  entryTime: number,
  exitReason: ExitReason = rMultiple > 0 ? 'TP' : 'SL',
): SimResult => {
  const trade: SimTrade = {
    id: `f${entryTime}`,
    symbol: 'BTCUSDT',
    tf: '15m',
    direction: 'LONG',
    signalBarTime: entryTime - 1,
    entryTime,
    entryPrice: 100,
    exitTime: entryTime + 1,
    exitPrice: 100 + rMultiple,
    exitReason,
    stopLoss: 90,
    takeProfit: 120,
    grossR: rMultiple,
    costR: 0,
    rMultiple,
    barsToFill: 0,
    barsHeld: 1,
    movedToBE: false,
  };
  return { intentId: trade.id, outcome: 'filled', trade };
};

const cancelled = (id: string): SimResult => ({ intentId: id, outcome: 'cancelled', reason: 'ranAway' });
const expired = (id: string): SimResult => ({ intentId: id, outcome: 'expired', reason: 'noFill' });

describe('computeMetrics', () => {
  it('agrega expectancy, winrate, fill-rate, PF y maxDD', () => {
    const results = [
      filled(2, 1),
      filled(-1, 2),
      filled(1, 3),
      cancelled('c1'),
      expired('e1'),
    ];
    const m = computeMetrics(results);

    expect(m.signals).toBe(5);
    expect(m.trades).toBe(3);
    expect(m.cancelled).toBe(1);
    expect(m.expired).toBe(1);
    expect(m.fillRate).toBe(0.6);

    expect(m.wins).toBe(2);
    expect(m.losses).toBe(1);
    expect(m.winRate).toBe(0.6667);

    expect(m.totalR).toBe(2);
    expect(m.expectancyR).toBe(0.6667);
    expect(m.avgWinR).toBe(1.5);
    expect(m.avgLossR).toBe(-1);
    expect(m.profitFactor).toBe(3); // Σwin 3 / |Σloss| 1

    // Curva en R por orden de entrada: +2, +1, −1 → cum 2,3,2 (sin DD); aquí el orden es 1,2,3.
    // entradas: t1=+2, t2=−1, t3=+1 → cum 2,1,2 → peak 2, valle 1 → maxDD 1
    expect(m.maxDrawdownR).toBe(1);
  });

  it('profit factor = Infinity si no hay pérdidas', () => {
    const m = computeMetrics([filled(1, 1), filled(2, 2)]);
    expect(m.profitFactor).toBe(Infinity);
    expect(m.losses).toBe(0);
  });

  it('cuenta breakeven (R = 0) aparte de wins/losses', () => {
    const m = computeMetrics([filled(0, 1, 'BE'), filled(1, 2)]);
    expect(m.breakeven).toBe(1);
    expect(m.wins).toBe(1);
    expect(m.losses).toBe(0);
    expect(m.exitReasons.BE).toBe(1);
    expect(m.exitReasons.TP).toBe(1);
  });

  it('distribución de R por tramos', () => {
    const m = computeMetrics([filled(-2, 1), filled(-0.5, 2), filled(0.5, 3), filled(1.5, 4), filled(3.2, 5)]);
    expect(m.rDistribution['<=-1R']).toBe(1);
    expect(m.rDistribution['-1..0R']).toBe(1);
    expect(m.rDistribution['0..1R']).toBe(1);
    expect(m.rDistribution['1..2R']).toBe(1);
    expect(m.rDistribution['>=3R']).toBe(1);
    expect(m.rDistribution['2..3R']).toBe(0);
  });

  it('maxDD captura una racha de pérdidas en el medio', () => {
    // +1, −1, −1, +1 → cum 1,0,−1,0 → peak 1, valle −1 → maxDD 2
    const m = computeMetrics([filled(1, 1), filled(-1, 2), filled(-1, 3), filled(1, 4)]);
    expect(m.maxDrawdownR).toBe(2);
    expect(m.totalR).toBe(0);
  });

  it('sin señales → todo en cero, sin NaN', () => {
    const m = computeMetrics([]);
    expect(m.signals).toBe(0);
    expect(m.fillRate).toBe(0);
    expect(m.winRate).toBe(0);
    expect(m.expectancyR).toBe(0);
    expect(m.profitFactor).toBe(0);
    expect(m.maxDrawdownR).toBe(0);
  });
});
