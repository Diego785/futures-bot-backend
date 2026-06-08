// Motor de backtest v2 — MÉTRICAS (núcleo puro). Fase C.1.
//
// Agrega los resultados del simulador en las métricas que decidirán el edge (doc §6): expectancy en
// R (neta), winrate, FILL-RATE (el trade-off central de V2: esperar confirmación llena menos pero
// mejor), profit factor, max drawdown en R y nº de trades (muestra). NO solo PF: el v1 murió de
// mirar solo el PF in-sample.

import type { ExitReason, SimResult, SimTrade } from './trade-simulator';

export interface BacktestMetrics {
  signals: number; // intents totales (denominador del fill-rate)
  trades: number; // llenados (la muestra real, N)
  cancelled: number; // pendientes canceladas (ranAway / invalidated / maxWaitFill)
  expired: number; // nunca llenaron (noFill / noData)
  fillRate: number; // trades / signals
  wins: number;
  losses: number;
  breakeven: number; // R exactamente 0 (típicamente stops en BE)
  winRate: number; // wins / trades
  expectancyR: number; // R NETA media por trade — la métrica estrella
  totalR: number; // suma de R neta
  avgWinR: number;
  avgLossR: number; // negativo
  profitFactor: number; // Σwin / |Σloss| (Infinity si no hay pérdidas y sí ganancias)
  maxDrawdownR: number; // peor caída pico→valle de la curva de equity en R (ordenada por entrada)
  rDistribution: Record<string, number>; // histograma de R por tramos
  exitReasons: Record<ExitReason, number>; // SL / TP / BE / maxHold / endOfData
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

const R_BUCKETS = ['<=-1R', '-1..0R', '0..1R', '1..2R', '2..3R', '>=3R'] as const;
const EXIT_REASONS: ExitReason[] = ['SL', 'TP', 'BE', 'maxHold', 'endOfData'];

function bucketOf(r: number): (typeof R_BUCKETS)[number] {
  if (r <= -1) return '<=-1R';
  if (r < 0) return '-1..0R';
  if (r < 1) return '0..1R';
  if (r < 2) return '1..2R';
  if (r < 3) return '2..3R';
  return '>=3R';
}

/**
 * Calcula las métricas agregadas de un conjunto de resultados del simulador. maxDrawdownR se mide
 * sobre la curva de equity en R ordenada por tiempo de ENTRADA (la secuencia en que ocurrieron).
 */
export function computeMetrics(results: SimResult[]): BacktestMetrics {
  const signals = results.length;
  const trades: SimTrade[] = results
    .filter((r) => r.outcome === 'filled' && r.trade)
    .map((r) => r.trade as SimTrade);
  const cancelled = results.filter((r) => r.outcome === 'cancelled').length;
  const expired = results.filter((r) => r.outcome === 'expired').length;
  const n = trades.length;

  const rDistribution: Record<string, number> = Object.fromEntries(R_BUCKETS.map((k) => [k, 0]));
  const exitReasons: Record<ExitReason, number> = Object.fromEntries(
    EXIT_REASONS.map((k) => [k, 0]),
  ) as Record<ExitReason, number>;

  let sumWin = 0;
  let sumLoss = 0; // acumula negativos
  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  for (const t of trades) {
    const r = t.rMultiple;
    if (r > 0) {
      wins++;
      sumWin += r;
    } else if (r < 0) {
      losses++;
      sumLoss += r;
    } else {
      breakeven++;
    }
    rDistribution[bucketOf(r)]++;
    exitReasons[t.exitReason]++;
  }
  const totalR = sumWin + sumLoss;

  // Curva de equity en R por orden de entrada → max drawdown.
  const ordered = [...trades].sort((a, b) => a.entryTime - b.entryTime);
  let cum = 0;
  let peak = 0;
  let maxDrawdownR = 0;
  for (const t of ordered) {
    cum += t.rMultiple;
    if (cum > peak) peak = cum;
    const dd = peak - cum;
    if (dd > maxDrawdownR) maxDrawdownR = dd;
  }

  const profitFactor = sumLoss < 0 ? round4(sumWin / Math.abs(sumLoss)) : sumWin > 0 ? Infinity : 0;

  return {
    signals,
    trades: n,
    cancelled,
    expired,
    fillRate: signals ? round4(n / signals) : 0,
    wins,
    losses,
    breakeven,
    winRate: n ? round4(wins / n) : 0,
    expectancyR: n ? round4(totalR / n) : 0,
    totalR: round4(totalR),
    avgWinR: wins ? round4(sumWin / wins) : 0,
    avgLossR: losses ? round4(sumLoss / losses) : 0,
    profitFactor,
    maxDrawdownR: round4(maxDrawdownR),
    rDistribution,
    exitReasons,
  };
}
