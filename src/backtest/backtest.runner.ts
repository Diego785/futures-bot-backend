// Motor de backtest v2 — ORQUESTADOR (runner puro). Fase C.3.
//
// Regla Cero: encadena señales → simulación → métricas sobre histórico. NO toca el exchange ni
// coloca órdenes. Función pura (sin DB, sin Nest) → testeable. La carga de velas y el CLI viven en
// run.ts; aquí solo la tubería candles → BacktestReport.

import { generateIntentsDetailed, type IntentReject, type SignalConfig } from './signal-source';
import { simulateAll, type SimCandle, type SimConfig, type SimResult, type TradeIntent } from './trade-simulator';
import { computeMetrics, type BacktestMetrics } from './metrics';
import type { BiasPoint } from './htf-bias';
import type { ObCandle } from '../bot-analysis/ob.detector';

// Vela del backtest: OHLC (para los detectores) + closeTime opcional (para anclar las salidas).
export type RunnerCandle = ObCandle & { closeTime?: number };

export interface BacktestReport {
  symbol: string;
  tf: string;
  gatillo: SignalConfig['gatillo'];
  tpRule: SignalConfig['tpRule'];
  candles: number;
  firstTime: number | null;
  lastTime: number | null;
  signals: number;
  metrics: BacktestMetrics;
  // Embudo completo para el registro/visor (el walk-forward y la rejilla los ignoran):
  intents: TradeIntent[]; // señales emitidas (1:1 con results)
  rejects: IntentReject[]; // candidatas descartadas con su razón (el porqué-no)
  results: SimResult[]; // desenlace simulado de cada intent
}

/**
 * Corre un backtest completo sobre `candles` (ascendente, cerradas) para una configuración de señal
 * y de simulación. Causal de punta a punta (la causalidad la garantizan signal-source y el simulador).
 */
export function runBacktest(
  symbol: string,
  tf: string,
  candles: RunnerCandle[],
  signalConfig: Partial<SignalConfig> = {},
  simConfig: Partial<SimConfig> = {},
  htfBias: BiasPoint[] = [],
): BacktestReport {
  const { intents, rejects } = generateIntentsDetailed(symbol, tf, candles, signalConfig, htfBias);
  const simCandles: SimCandle[] = candles.map((c) => ({
    openTime: c.openTime,
    high: c.high,
    low: c.low,
    close: c.close,
    closeTime: c.closeTime,
  }));
  const results = simulateAll(intents, simCandles, simConfig);
  const metrics = computeMetrics(results);
  return {
    symbol,
    tf,
    gatillo: signalConfig.gatillo ?? 'C',
    tpRule: signalConfig.tpRule ?? 'fixedR',
    candles: candles.length,
    firstTime: candles.length ? candles[0].openTime : null,
    lastTime: candles.length ? candles[candles.length - 1].openTime : null,
    signals: intents.length,
    metrics,
    intents,
    rejects,
    results,
  };
}

/**
 * Rejilla de variantes sobre el MISMO set de velas: gatillos × reglas de TP (ejes 1 y 3 del doc §6).
 * El eje 2 (TF) lo recorre el CLI cargando cada timeframe. Devuelve un reporte por celda.
 */
export function runGrid(
  symbol: string,
  tf: string,
  candles: RunnerCandle[],
  gatillos: SignalConfig['gatillo'][],
  tpRules: SignalConfig['tpRule'][],
  signalBase: Partial<SignalConfig> = {},
  simConfig: Partial<SimConfig> = {},
  htfBias: BiasPoint[] = [],
): BacktestReport[] {
  const out: BacktestReport[] = [];
  for (const gatillo of gatillos) {
    for (const tpRule of tpRules) {
      out.push(runBacktest(symbol, tf, candles, { ...signalBase, gatillo, tpRule }, simConfig, htfBias));
    }
  }
  return out;
}
