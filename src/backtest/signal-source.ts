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
import { biasAt, type BiasPoint } from './htf-bias';
import type { IntentContext, TradeDirection, TradeIntent } from './trade-simulator';

export type Gatillo = 'A' | 'B' | 'C';
export type TpRule = 'fixedR' | 'liquidity';

// Señal candidata DESCARTADA y su porqué (para el visor/auditoría: el "porqué NO entró" importa tanto
// como el porqué sí). 'badZone' = zona/riesgo degenerado · 'minStop' = stop micro (fee-aware) ·
// 'minRr' = R:R bajo el mínimo · 'htfBias' = contra la estructura HTF.
export type RejectReason = 'badZone' | 'minStop' | 'minRr' | 'htfBias';
export interface IntentReject {
  id: string;
  direction: TradeDirection;
  signalBarTime: number;
  zoneLow: number;
  zoneHigh: number;
  reason: RejectReason;
}

export interface SignalConfig {
  gatillo: Gatillo;
  tpRule: TpRule;
  rMultipleTp: number; // TP en modo fixedR (default 2R)
  slBufferFrac: number; // buffer del SL = frac × rango de la zona (default 0.1)
  cancelDistanceFrac: number; // cancelBeyond = frac × rango en la dirección adversa al fill (default 1)
  minRr: number; // descarta intents con R:R < esto (anti-degenerado, sobre todo en TP por liquidez)
  minStopPct: number; // FEE-AWARE: descarta stops micro (riesgo < minStopPct×entry) donde el fee domina
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
  minStopPct: 0, // 0 = sin filtro (el CLI pone un default fee-aware ~0.003)
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

const makeId = (cfg: SignalConfig, symbol: string, tf: string, idSuffix: string): string =>
  `${cfg.gatillo}_${symbol}_${tf}_${idSuffix}`;

type BuildResult = { intent?: TradeIntent; rejectReason?: Exclude<RejectReason, 'htfBias'> };

// Construye un intent a partir de una zona [low, high] y un lado. Entry = CE (50 %); SL = borde
// distal + buffer; invalidación = borde distal (cuerpo fuera = POI roto); cancelBeyond = se alejó.
// Si la candidata no pasa un filtro, devuelve la RAZÓN (el visor registra el porqué-no).
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
  extraContext: Partial<IntentContext> = {},
): BuildResult {
  const range = zoneHigh - zoneLow;
  if (range <= 0) return { rejectReason: 'badZone' };
  const signalIdx = idxOfTime.get(signalBarTime);
  if (signalIdx == null) return { rejectReason: 'badZone' };
  const sign = direction === 'LONG' ? 1 : -1;
  const entry = (zoneLow + zoneHigh) / 2; // CE
  const buffer = cfg.slBufferFrac * range;
  const stopLoss = direction === 'LONG' ? zoneLow - buffer : zoneHigh + buffer;
  const risk = Math.abs(entry - stopLoss);
  if (risk <= 0) return { rejectReason: 'badZone' };
  // Filtro fee-aware: descarta stops micro donde el fee domina la R. Para que el coste round-trip
  // ≤ ~25 % del riesgo con fee 0.05 %/lado, minStopPct ≳ 8×fee ≈ 0.4 %.
  if (cfg.minStopPct > 0 && risk < cfg.minStopPct * entry) return { rejectReason: 'minStop' };
  const takeProfit = resolveTp(direction, entry, risk, signalBarTime, signalIdx, liqs, cfg, idxOfTime);
  const rr = Math.abs(takeProfit - entry) / risk;
  if (rr < cfg.minRr) return { rejectReason: 'minRr' };
  const distal = direction === 'LONG' ? zoneLow : zoneHigh;
  return {
    intent: {
      id: makeId(cfg, symbol, tf, idSuffix),
      symbol,
      tf,
      direction,
      signalBarTime,
      entry: round4(entry),
      stopLoss: round4(stopLoss),
      takeProfit: round4(takeProfit),
      invalidationPrice: round4(distal),
      cancelBeyond: round4(entry + sign * cfg.cancelDistanceFrac * range),
      context: { zoneLow: round4(zoneLow), zoneHigh: round4(zoneHigh), ...extraContext },
    },
  };
}

// Acumula el resultado de buildIntent en intents o rejects (con el mismo id que habría llevado).
function collect(
  res: BuildResult,
  out: { intents: TradeIntent[]; rejects: IntentReject[] },
  cfg: SignalConfig,
  symbol: string,
  tf: string,
  idSuffix: string,
  direction: TradeDirection,
  signalBarTime: number,
  zoneLow: number,
  zoneHigh: number,
): void {
  if (res.intent) out.intents.push(res.intent);
  else if (res.rejectReason) {
    out.rejects.push({
      id: makeId(cfg, symbol, tf, idSuffix),
      direction,
      signalBarTime,
      zoneLow: round4(zoneLow),
      zoneHigh: round4(zoneHigh),
      reason: res.rejectReason,
    });
  }
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
): { intents: TradeIntent[]; rejects: IntentReject[] } {
  const out = { intents: [] as TradeIntent[], rejects: [] as IntentReject[] };
  for (const o of obs) {
    const direction: TradeDirection = o.direction === 'bullish' ? 'LONG' : 'SHORT';
    const res = buildIntent(symbol, tf, `${o.originTime}`, direction, o.confirmedAtTime, o.obLow, o.obHigh, liqs, cfg, idxOfTime);
    collect(res, out, cfg, symbol, tf, `${o.originTime}`, direction, o.confirmedAtTime, o.obLow, o.obHigh);
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
): { intents: TradeIntent[]; rejects: IntentReject[] } {
  const out = { intents: [] as TradeIntent[], rejects: [] as IntentReject[] };
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
    const res = buildIntent(symbol, tf, `${conf.originTime}`, direction, conf.confirmedAtTime, conf.obLow, conf.obHigh, liqs, cfg, idxOfTime);
    collect(res, out, cfg, symbol, tf, `${conf.originTime}`, direction, conf.confirmedAtTime, conf.obLow, conf.obHigh);
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
): { intents: TradeIntent[]; rejects: IntentReject[] } {
  const sweeps = detectSweeps(symbol, tf, candles, { swingLookback: cfg.swingLookback });
  const out = { intents: [] as TradeIntent[], rejects: [] as IntentReject[] };
  for (const s of sweeps) {
    const direction: TradeDirection = s.direction === 'bullish' ? 'LONG' : 'SHORT';
    // Zona de la reacción: del extremo de la mecha al nivel barrido (el "descuento" del sweep).
    const zoneLow = direction === 'LONG' ? s.wickExtreme : s.sweptLevel;
    const zoneHigh = direction === 'LONG' ? s.sweptLevel : s.wickExtreme;
    // El id lleva la dirección: una misma vela puede barrer un swing high Y un swing low (dos
    // intents opuestos) y el dedup por id del paper-trading no debe colapsarlos.
    const suffix = `${s.sweepBarTime}_${direction === 'LONG' ? 'u' : 'd'}`;
    const res = buildIntent(symbol, tf, suffix, direction, s.sweepBarTime, zoneLow, zoneHigh, liqs, cfg, idxOfTime, {
      sweptLevel: s.sweptLevel,
      wickExtreme: s.wickExtreme,
      sweptSwingTime: s.sweptSwingTime,
    });
    collect(res, out, cfg, symbol, tf, suffix, direction, s.sweepBarTime, zoneLow, zoneHigh);
  }
  return out;
}

/**
 * Versión DETALLADA: además de los intents emitidos devuelve las candidatas DESCARTADAS con su razón
 * (badZone/minStop/minRr/htfBias). El visor las registra para auditar el porqué-no de cada sweep.
 * Misma causalidad y mismos intents que generateIntents (que delega aquí).
 */
export function generateIntentsDetailed(
  symbol: string,
  tf: string,
  candles: ObCandle[],
  config: Partial<SignalConfig> = {},
  htfBias: BiasPoint[] = [],
): { intents: TradeIntent[]; rejects: IntentReject[] } {
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

  let result: { intents: TradeIntent[]; rejects: IntentReject[] };
  if (cfg.gatillo === 'C') {
    result = intentsC(symbol, tf, candles, liqs, cfg, idxOfTime);
  } else {
    const obs = detectOrderBlocks(symbol, tf, candles, {
      swingLookback: cfg.swingLookback,
      showLastBullish: Number.MAX_SAFE_INTEGER,
      showLastBearish: Number.MAX_SAFE_INTEGER,
    });
    result =
      cfg.gatillo === 'A'
        ? intentsA(symbol, tf, obs, liqs, cfg, idxOfTime)
        : intentsB(symbol, tf, obs, candles, liqs, cfg, idxOfTime);
  }

  // Filtro de sesgo HTF (multi-TF, Capa 1): solo gatillos A FAVOR de la estructura del TF alto.
  // Un sweep alcista (LONG) requiere sesgo HTF alcista; bajista (SHORT), bajista. Neutral → fuera.
  let intents = result.intents;
  const rejects = result.rejects;
  if (htfBias.length > 0) {
    const pass: TradeIntent[] = [];
    for (const it of intents) {
      const bias = biasAt(htfBias, it.signalBarTime);
      const aligned = it.direction === 'LONG' ? bias === 'bullish' : bias === 'bearish';
      if (aligned) pass.push(it);
      else {
        rejects.push({
          id: it.id,
          direction: it.direction,
          signalBarTime: it.signalBarTime,
          zoneLow: it.context?.zoneLow ?? 0,
          zoneHigh: it.context?.zoneHigh ?? 0,
          reason: 'htfBias',
        });
      }
    }
    intents = pass;
  }

  return {
    intents: intents.sort((a, b) => a.signalBarTime - b.signalBarTime),
    rejects: rejects.sort((a, b) => a.signalBarTime - b.signalBarTime),
  };
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
  htfBias: BiasPoint[] = [],
): TradeIntent[] {
  return generateIntentsDetailed(symbol, tf, candles, config, htfBias).intents;
}
