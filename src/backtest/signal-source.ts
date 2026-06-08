// Motor de backtest v2 — GENERADOR DE SEÑALES (signal-source). Fase C.2.
//
// Regla Cero: produce INTENCIONES de trade sobre histórico para alimentar al simulador; NO ejecuta,
// NO coloca órdenes. Convierte los detectores (ya causales) en TradeIntents para cada uno de los 3
// gatillos del doc SMC-STRATEGY-MECHANICAL §4, en modo SINGLE-TF (POI y gatillo en el MISMO
// timeframe; el multi-TF HTF→LTF es refinamiento posterior, como difiere setup.detector).
//
//   A · Riesgo        → límite en el CE (50 %) de CADA OB (control / baseline = adverse selection).
//   B · Confirmación  → CE del OB que se forma DESPUÉS de que una "madre" (OB previo misma dirección,
//                       cercano) fue MITIGADA (la reacción tras el pullback = el OB interno).
//   C · Sweep+Reclaim → CE de la reacción del barrido (zona mecha↔nivel barrido); SL bajo la mecha.
//
// Causalidad: cada evento se "conoce" en su vela de confirmación → esa es la signalBarTime y el
// simulador ejecuta en la SIGUIENTE. Los niveles (OB, sweep) quedan FIJADOS en su origen. El TP por
// LIQUIDEZ usa solo niveles confirmados y NO barridos HASTA signalBarTime (cero lookahead). NO se usa
// el campo `state` de los detectores (refleja el futuro): el simulador decide si llena/cancela.

import {
  detectOrderBlocks,
  type BotOb,
  type ObCandle,
} from '../bot-analysis/ob.detector';
import { detectSweeps } from '../bot-analysis/sweep.detector';
import { detectLiquidity, DEFAULT_LIQ_PARAMS, type BotLiquidity } from '../bot-analysis/liquidity.detector';
import type { TradeDirection, TradeIntent } from './trade-simulator';

export type Gatillo = 'A' | 'B' | 'C';
export type TpRule = 'fixedR' | 'liquidity';

export interface SignalConfig {
  gatillo: Gatillo;
  tpRule: TpRule;
  rMultipleTp: number; // TP en modo fixedR (default 2R)
  slBufferFrac: number; // buffer del SL = frac × rango de la zona (default 0.1)
  cancelDistanceFrac: number; // cancelBeyond = frac × rango en la dirección adversa al fill (default 1)
  minRr: number; // descarta intents con R:R < esto (anti-degenerado, sobre todo en TP por liquidez)
  swingLookback: number; // pivotes para OB/sweep/liquidez (default 10)
  confirmProximityFrac: number; // modo B: la madre debe solapar o estar a ≤ frac×rango del OB de confirmación
}

// Defaults provisionales 🔴 (alineados con SMC-STRATEGY-MECHANICAL §5).
export const DEFAULT_SIGNAL_CONFIG: SignalConfig = {
  gatillo: 'C',
  tpRule: 'fixedR',
  rMultipleTp: 2,
  slBufferFrac: 0.1,
  cancelDistanceFrac: 1,
  minRr: 1,
  swingLookback: 10,
  confirmProximityFrac: 1,
};

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

// ─────────────────────────── TP ───────────────────────────

// Liquidez opuesta más cercana, CONFIRMADA y NO barrida a la fecha de la señal (causal).
function nearestLiquidityTp(
  direction: TradeDirection,
  entry: number,
  signalBarTime: number,
  signalIdx: number,
  liqs: BotLiquidity[],
  cfg: SignalConfig,
  idxOfTime: Map<number, number>,
): number | null {
  const wantSide = direction === 'LONG' ? 'buyside' : 'sellside';
  let best: number | null = null;
  let bestDist = Infinity;
  for (const l of liqs) {
    if (l.side !== wantSide) continue;
    // Confirmada: su último pivote ya cerró su ventana de lookback antes de la señal.
    const lastPivot = l.candleTimes[l.candleTimes.length - 1];
    const lpIdx = idxOfTime.get(lastPivot);
    if (lpIdx == null || lpIdx + cfg.swingLookback > signalIdx) continue;
    // No barrida a la fecha de la señal.
    if (l.sweptAtTime != null && l.sweptAtTime <= signalBarTime) continue;
    // Más allá del entry, en la dirección del trade.
    const beyond = direction === 'LONG' ? l.level > entry : l.level < entry;
    if (!beyond) continue;
    const dist = Math.abs(l.level - entry);
    if (dist < bestDist) {
      bestDist = dist;
      best = l.level;
    }
  }
  return best;
}

function resolveTp(
  direction: TradeDirection,
  entry: number,
  risk: number,
  signalBarTime: number,
  signalIdx: number,
  liqs: BotLiquidity[],
  cfg: SignalConfig,
  idxOfTime: Map<number, number>,
): number {
  const sign = direction === 'LONG' ? 1 : -1;
  const fixed = entry + sign * cfg.rMultipleTp * risk;
  if (cfg.tpRule === 'fixedR') return fixed;
  const liq = nearestLiquidityTp(direction, entry, signalBarTime, signalIdx, liqs, cfg, idxOfTime);
  return liq ?? fixed; // sin liquidez válida → fallback a R fijo
}

// ─────────────────────────── Intent ───────────────────────────

// Construye un intent a partir de una zona [low, high] y un lado. Entry = CE (50 %); SL = borde
// distal + buffer; invalidación = borde distal (cuerpo fuera = POI roto); cancelBeyond = se alejó.
function buildIntent(
  symbol: string,
  tf: string,
  idSuffix: string,
  direction: TradeDirection,
  signalBarTime: number,
  zoneLow: number,
  zoneHigh: number,
  liqs: BotLiquidity[],
  cfg: SignalConfig,
  idxOfTime: Map<number, number>,
): TradeIntent | null {
  const range = zoneHigh - zoneLow;
  if (range <= 0) return null;
  const signalIdx = idxOfTime.get(signalBarTime);
  if (signalIdx == null) return null;
  const sign = direction === 'LONG' ? 1 : -1;
  const entry = (zoneLow + zoneHigh) / 2; // CE
  const buffer = cfg.slBufferFrac * range;
  const stopLoss = direction === 'LONG' ? zoneLow - buffer : zoneHigh + buffer;
  const risk = Math.abs(entry - stopLoss);
  if (risk <= 0) return null;
  const takeProfit = resolveTp(direction, entry, risk, signalBarTime, signalIdx, liqs, cfg, idxOfTime);
  const rr = Math.abs(takeProfit - entry) / risk;
  if (rr < cfg.minRr) return null;
  const distal = direction === 'LONG' ? zoneLow : zoneHigh;
  return {
    id: `${cfg.gatillo}_${symbol}_${tf}_${idSuffix}`,
    symbol,
    tf,
    direction,
    signalBarTime,
    entry: round4(entry),
    stopLoss: round4(stopLoss),
    takeProfit: round4(takeProfit),
    invalidationPrice: round4(distal),
    cancelBeyond: round4(entry + sign * cfg.cancelDistanceFrac * range),
  };
}

// ─────────────────────────── Gatillos ───────────────────────────

// A · Riesgo: un límite en el CE de CADA OB (sin esperar reacción). El control del experimento.
function intentsA(
  symbol: string,
  tf: string,
  obs: BotOb[],
  liqs: BotLiquidity[],
  cfg: SignalConfig,
  idxOfTime: Map<number, number>,
): TradeIntent[] {
  const out: TradeIntent[] = [];
  for (const o of obs) {
    const direction: TradeDirection = o.direction === 'bullish' ? 'LONG' : 'SHORT';
    const it = buildIntent(symbol, tf, `${o.originTime}`, direction, o.confirmedAtTime, o.obLow, o.obHigh, liqs, cfg, idxOfTime);
    if (it) out.push(it);
  }
  return out;
}

// ¿Entró el precio en el rango de la madre entre `after` y `before` (exclusivo)? (mitigación, causal)
function mitigatedBetween(candles: ObCandle[], m: BotOb, after: number, before: number): boolean {
  for (const c of candles) {
    if (c.openTime <= after) continue;
    if (c.openTime >= before) break;
    if (c.low <= m.obHigh && c.high >= m.obLow) return true;
  }
  return false;
}

// B · Confirmación: CE del OB que se forma tras mitigarse una madre (OB previo misma dirección,
// cercano). Mecanización single-TF del "BOS interno tras mitigación" del Video 2.
function intentsB(
  symbol: string,
  tf: string,
  obs: BotOb[],
  candles: ObCandle[],
  liqs: BotLiquidity[],
  cfg: SignalConfig,
  idxOfTime: Map<number, number>,
): TradeIntent[] {
  const out: TradeIntent[] = [];
  const sorted = [...obs].sort((a, b) => a.confirmedAtTime - b.confirmedAtTime);
  for (let i = 0; i < sorted.length; i++) {
    const conf = sorted[i];
    const confRange = conf.obHigh - conf.obLow;
    let matched = false;
    for (let j = 0; j < i && !matched; j++) {
      const m = sorted[j];
      if (m.direction !== conf.direction) continue;
      if (m.confirmedAtTime >= conf.originTime) continue; // la madre debe existir antes de formarse el conf
      const overlap = m.obLow <= conf.obHigh && m.obHigh >= conf.obLow;
      const near =
        Math.min(Math.abs(m.obHigh - conf.obLow), Math.abs(m.obLow - conf.obHigh)) <= cfg.confirmProximityFrac * confRange;
      if (!(overlap || near)) continue;
      if (!mitigatedBetween(candles, m, m.confirmedAtTime, conf.originTime)) continue;
      matched = true;
    }
    if (!matched) continue;
    const direction: TradeDirection = conf.direction === 'bullish' ? 'LONG' : 'SHORT';
    const it = buildIntent(symbol, tf, `${conf.originTime}`, direction, conf.confirmedAtTime, conf.obLow, conf.obHigh, liqs, cfg, idxOfTime);
    if (it) out.push(it);
  }
  return out;
}

// C · Sweep + Reclaim: CE de la reacción (zona mecha↔nivel barrido); el SL queda bajo la mecha.
function intentsC(
  symbol: string,
  tf: string,
  candles: ObCandle[],
  liqs: BotLiquidity[],
  cfg: SignalConfig,
  idxOfTime: Map<number, number>,
): TradeIntent[] {
  const sweeps = detectSweeps(symbol, tf, candles, { swingLookback: cfg.swingLookback });
  const out: TradeIntent[] = [];
  for (const s of sweeps) {
    const direction: TradeDirection = s.direction === 'bullish' ? 'LONG' : 'SHORT';
    // Zona de la reacción: del extremo de la mecha al nivel barrido (el "descuento" del sweep).
    const zoneLow = direction === 'LONG' ? s.wickExtreme : s.sweptLevel;
    const zoneHigh = direction === 'LONG' ? s.sweptLevel : s.wickExtreme;
    const it = buildIntent(symbol, tf, `${s.sweepBarTime}`, direction, s.sweepBarTime, zoneLow, zoneHigh, liqs, cfg, idxOfTime);
    if (it) out.push(it);
  }
  return out;
}

/**
 * Genera los TradeIntents de una serie de velas CERRADAS (ascendente) para el gatillo configurado.
 * Single-TF, causal. La salida va ordenada por signalBarTime.
 */
export function generateIntents(
  symbol: string,
  tf: string,
  candles: ObCandle[],
  config: Partial<SignalConfig> = {},
): TradeIntent[] {
  const cfg: SignalConfig = { ...DEFAULT_SIGNAL_CONFIG, ...config };
  const idxOfTime = new Map<number, number>();
  candles.forEach((c, i) => idxOfTime.set(c.openTime, i));

  // Liquidez (solo si el TP la necesita): histórico completo, con barridos, sin filtros de distancia
  // ni tope → el filtro causal lo aplica nearestLiquidityTp por intent.
  const liqs: BotLiquidity[] =
    cfg.tpRule === 'liquidity'
      ? detectLiquidity(symbol, tf, candles, {
          ...DEFAULT_LIQ_PARAMS,
          swingLookback: cfg.swingLookback,
          showSweptLiquidity: true,
          maxDistanceFromPricePct: null,
          maxLevels: Number.MAX_SAFE_INTEGER,
        })
      : [];

  let intents: TradeIntent[];
  if (cfg.gatillo === 'C') {
    intents = intentsC(symbol, tf, candles, liqs, cfg, idxOfTime);
  } else {
    const obs = detectOrderBlocks(symbol, tf, candles, {
      swingLookback: cfg.swingLookback,
      showLastBullish: Number.MAX_SAFE_INTEGER,
      showLastBearish: Number.MAX_SAFE_INTEGER,
    });
    intents =
      cfg.gatillo === 'A'
        ? intentsA(symbol, tf, obs, liqs, cfg, idxOfTime)
        : intentsB(symbol, tf, obs, candles, liqs, cfg, idxOfTime);
  }
  return intents.sort((a, b) => a.signalBarTime - b.signalBarTime);
}
