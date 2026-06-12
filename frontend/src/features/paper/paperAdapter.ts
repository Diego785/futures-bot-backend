// Adaptador PAPER → shapes del visor: convierte las filas del paper al BacktestSignal que
// ReplayChart/equity ya saben dibujar, y agrega las métricas estilo RunStats. Así la pestaña
// Paper REUSA la capa visual auditada del replay (misma causalidad, mismos componentes).

import type { BacktestSignal, BacktestRunMetrics } from '../backtest-viewer/backtestRuns.types';
import type { PaperTrade } from './paper.types';

/** Fila del paper → señal estilo backtest (para la gráfica y la equity). */
export function paperToSignal(t: PaperTrade): BacktestSignal {
  const isCancelled = t.state === 'CLOSED' && t.cancelReason != null;
  const isFilled = (t.state === 'CLOSED' && t.rMultiple != null) || t.state === 'FILLED';
  return {
    runId: 'paper',
    intentId: t.intentId,
    direction: t.direction,
    signalBarTime: t.signalBarTime,
    outcome: isFilled ? 'filled' : 'cancelled', // PENDING viva: 'cancelled' sin endTime ⇒ fase 'pending'
    reason: t.cancelReason,
    endTime: isCancelled ? t.updatedAt : null, // aprox.: cuándo se registró la cancelación
    zoneLow: t.zoneLow,
    zoneHigh: t.zoneHigh,
    sweptLevel: t.sweptLevel,
    wickExtreme: t.wickExtreme,
    sweptSwingTime: t.sweptSwingTime,
    entry: t.entry,
    stopLoss: t.stopLoss,
    takeProfit: t.takeProfit,
    tpSource: t.tpSource,
    invalidationPrice: t.invalidationPrice,
    cancelBeyond: t.cancelBeyond,
    entryTime: t.entryTime,
    entryPrice: t.entryPrice,
    exitTime: t.state === 'CLOSED' ? t.exitTime : null,
    exitPrice: t.state === 'CLOSED' ? t.exitPrice : null,
    exitReason: t.state === 'CLOSED' ? t.exitReason : null,
    grossR: t.grossR,
    costR: t.costR,
    rMultiple: t.state === 'CLOSED' ? t.rMultiple : null,
    movedToBE: t.movedToBE,
    barsToFill: t.barsToFill,
    barsHeld: t.barsHeld,
  };
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** Métricas en vivo del paper (mismas fórmulas que el motor de métricas del backtest). */
export function buildPaperMetrics(trades: PaperTrade[]): BacktestRunMetrics {
  const closedFilled = trades.filter((t) => t.state === 'CLOSED' && t.rMultiple != null);
  const cancelled = trades.filter((t) => t.state === 'CLOSED' && t.cancelReason != null).length;
  const liveFilled = trades.filter((t) => t.state === 'FILLED').length;

  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  let sumWin = 0;
  let sumLoss = 0;
  const exitReasons: Record<string, number> = { TP: 0, SL: 0, BE: 0, maxHold: 0, endOfData: 0 };
  const rDistribution: Record<string, number> = { '<=-1R': 0, '-1..0R': 0, '0..1R': 0, '1..2R': 0, '2..3R': 0, '>=3R': 0 };
  for (const t of closedFilled) {
    const r = t.rMultiple as number;
    if (r > 0) {
      wins++;
      sumWin += r;
    } else if (r < 0) {
      losses++;
      sumLoss += r;
    } else breakeven++;
    if (t.exitReason) exitReasons[t.exitReason] = (exitReasons[t.exitReason] ?? 0) + 1;
    const b = r <= -1 ? '<=-1R' : r < 0 ? '-1..0R' : r < 1 ? '0..1R' : r < 2 ? '1..2R' : r < 3 ? '2..3R' : '>=3R';
    rDistribution[b]++;
  }
  const totalR = sumWin + sumLoss;
  const n = closedFilled.length;

  const ordered = [...closedFilled].sort((a, b) => (a.entryTime ?? 0) - (b.entryTime ?? 0));
  let cum = 0;
  let peak = 0;
  let maxDD = 0;
  for (const t of ordered) {
    cum += t.rMultiple as number;
    if (cum > peak) peak = cum;
    if (peak - cum > maxDD) maxDD = peak - cum;
  }

  return {
    signals: trades.length,
    trades: n,
    cancelled,
    expired: 0,
    fillRate: trades.length ? round4((n + liveFilled) / trades.length) : 0,
    winRate: n ? round4(wins / n) : 0,
    expectancyR: n ? round4(totalR / n) : 0,
    totalR: round4(totalR),
    profitFactor: sumLoss < 0 ? round4(sumWin / Math.abs(sumLoss)) : sumWin > 0 ? Infinity : 0,
    maxDrawdownR: round4(maxDD),
    wins,
    losses,
    breakeven,
    avgWinR: wins ? round4(sumWin / wins) : 0,
    avgLossR: losses ? round4(sumLoss / losses) : 0,
    exitReasons,
    rDistribution,
  };
}

/** Resumen por símbolo (RunStats lo muestra como bloque extra en modo paper). */
export function paperBySymbol(trades: PaperTrade[]): { symbol: string; n: number; r: number; wins: number }[] {
  const by = new Map<string, { symbol: string; n: number; r: number; wins: number }>();
  for (const t of trades) {
    if (t.state !== 'CLOSED' || t.rMultiple == null) continue;
    const e = by.get(t.symbol) ?? { symbol: t.symbol, n: 0, r: 0, wins: 0 };
    e.n++;
    e.r += t.rMultiple;
    if (t.rMultiple > 0) e.wins++;
    by.set(t.symbol, e);
  }
  return [...by.values()].sort((a, b) => b.r - a.r);
}
