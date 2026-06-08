// Motor de backtest v2 — WALK-FORWARD (robustez temporal). Fase E.
//
// Regla Cero: solo simula sobre histórico. Mide si una variante es ROBUSTA en el tiempo, no si tuvo
// suerte en una ventana. Parte el histórico en N ventanas consecutivas y corre la MISMA variante
// (parámetros fijos) en cada una → criterio de autonomía #5 (≥70 % de ventanas rentables) y #1 (N).
//
// Honestidad: cada ventana es un corte independiente, así que pierde un poco de warmup al inicio
// (los detectores necesitan lookback) y trunca a endOfData los trades abiertos al final. Ese sesgo
// es PEQUEÑO y AFECTA A TODAS LAS VENTANAS POR IGUAL (no inclina el resultado). El walk-forward con
// re-optimización por ventana (tuning dentro de cada IS) es un paso posterior; aquí medimos la
// estabilidad de una variante YA fijada.

import { runBacktest, type RunnerCandle } from './backtest.runner';
import type { SignalConfig } from './signal-source';
import type { SimConfig } from './trade-simulator';
import type { BiasPoint } from './htf-bias';

export interface WfWindow {
  index: number;
  fromTime: number | null;
  toTime: number | null;
  candles: number;
  trades: number;
  expectancyR: number;
  winRate: number;
  profitFactor: number;
  maxDrawdownR: number;
  totalR: number;
}

export interface WalkForwardResult {
  tf: string;
  gatillo: SignalConfig['gatillo'];
  tpRule: SignalConfig['tpRule'];
  windows: WfWindow[];
  windowsCount: number; // ventanas CON al menos un trade (las que cuentan para estabilidad)
  profitableWindows: number;
  pctProfitable: number;
  totalTrades: number;
  meanExpectancyR: number; // media de la expectancy por ventana (con trades)
  medianExpectancyR: number;
  pooledExpectancyR: number; // sobre TODOS los trades juntos (ΣtotalR / ΣN)
  worstExpectancyR: number;
  stdExpectancyR: number;
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const v = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  return Math.sqrt(v);
}

/**
 * Corre una variante FIJA sobre `nWindows` cortes temporales consecutivos del histórico y agrega
 * su estabilidad. Una variante robusta es rentable en la mayoría de las ventanas, no solo en total.
 */
export function walkForward(
  symbol: string,
  tf: string,
  candles: RunnerCandle[],
  nWindows: number,
  signalConfig: Partial<SignalConfig> = {},
  simConfig: Partial<SimConfig> = {},
  htfBias: BiasPoint[] = [],
): WalkForwardResult {
  const n = candles.length;
  const k = Math.max(1, Math.floor(nWindows));
  const size = Math.floor(n / k);
  const windows: WfWindow[] = [];

  for (let i = 0; i < k; i++) {
    const start = i * size;
    const end = i === k - 1 ? n : (i + 1) * size; // la última toma el resto
    const slice = candles.slice(start, end);
    const r = runBacktest(symbol, tf, slice, signalConfig, simConfig, htfBias);
    const m = r.metrics;
    windows.push({
      index: i,
      fromTime: r.firstTime,
      toTime: r.lastTime,
      candles: slice.length,
      trades: m.trades,
      expectancyR: m.expectancyR,
      winRate: m.winRate,
      profitFactor: m.profitFactor,
      maxDrawdownR: m.maxDrawdownR,
      totalR: m.totalR,
    });
  }

  const withTrades = windows.filter((w) => w.trades > 0);
  const exps = withTrades.map((w) => w.expectancyR);
  const totalTrades = windows.reduce((a, w) => a + w.trades, 0);
  const sumTotalR = windows.reduce((a, w) => a + w.totalR, 0);
  const profitableWindows = withTrades.filter((w) => w.expectancyR > 0).length;

  return {
    tf,
    gatillo: signalConfig.gatillo ?? 'C',
    tpRule: signalConfig.tpRule ?? 'fixedR',
    windows,
    windowsCount: withTrades.length,
    profitableWindows,
    pctProfitable: withTrades.length ? round4(profitableWindows / withTrades.length) : 0,
    totalTrades,
    meanExpectancyR: exps.length ? round4(exps.reduce((a, b) => a + b, 0) / exps.length) : 0,
    medianExpectancyR: round4(median(exps)),
    pooledExpectancyR: totalTrades ? round4(sumTotalR / totalTrades) : 0,
    worstExpectancyR: exps.length ? round4(Math.min(...exps)) : 0,
    stdExpectancyR: round4(std(exps)),
  };
}
