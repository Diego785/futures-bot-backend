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
  detectSwings,
  computeStateTimeline,
  type BotOb,
  type ObCandle,
  type ObDirection,
  type Swing,
} from '../bot-analysis/ob.detector';
import { detectSweeps } from '../bot-analysis/sweep.detector';
import { detectStrictFvgs } from '../bot-analysis/fvg.detector';
import { detectLiquidity, DEFAULT_LIQ_PARAMS, type BotLiquidity } from '../bot-analysis/liquidity.detector';
import { biasAt, type BiasPoint } from './htf-bias';
import type { IntentContext, TpSource, TradeDirection, TradeIntent } from './trade-simulator';

// A/B/C ver Capa 4 de SMC-STRATEGY-MECHANICAL. D = Ciclo 3 (CYCLE-3-PREREG): sweep → CHoCH → FVG.
export type Gatillo = 'A' | 'B' | 'C' | 'D';
// 'fixedR' = 2R sintético (candidato congelado) · 'liquidity' = nivel de liquidez opuesto (Fase D)
// · 'structural' = Ciclo 2 (CYCLE-2-PREREG Eje 1): el target del VIDEO — el más cercano entre el
//   OB OPUESTO vigente (no invalidado a la señal) y la liquidez opuesta no barrida.
export type TpRule = 'fixedR' | 'liquidity' | 'structural';

// Target estructural derivado de un OB (causal): proximal = el borde que el precio toca primero.
export interface ObTargetInfo {
  direction: ObDirection; // bearish = oferta (target de LONGs) · bullish = demanda (target de SHORTs)
  proximal: number; // bearish → obLow · bullish → obHigh
  confirmedAtTime: number; // conocido desde aquí
  invalidatedAt: number | null; // muerto desde aquí (cuerpo cruzó el distal)
}

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
  poolMode: 'lastSwing' | 'pools'; // gatillo C: qué liquidez se barre (Ciclo 2, CYCLE-2-PREREG Eje 2)
  maxChochBars: number; // gatillo D: máx. velas tras el sweep para exigir el CHoCH (Ciclo 3, default 15)
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
  poolMode: 'lastSwing', // candidato congelado; 'pools' = Ciclo 2
  maxChochBars: 15, // Ciclo 3 (gatillo D)
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

/**
 * TP ESTRUCTURAL (Ciclo 2): el más cercano, en la dirección del trade, entre (a) el borde proximal
 * del OB OPUESTO vigente a la señal (confirmado y no invalidado — causal vía timeline) y (b) la
 * liquidez opuesta no barrida. Es el target del video: *"mi take profit está en el order block de
 * la parte alta… si sigo esperando más arriba pierdo mi entrada"*. Exportada para tests puros.
 */
export function resolveStructuralTp(
  direction: TradeDirection,
  entry: number,
  signalBarTime: number,
  signalIdx: number,
  obTargets: ObTargetInfo[],
  liqs: BotLiquidity[],
  cfg: SignalConfig,
  idxOfTime: Map<number, number>,
): { price: number; source: 'structural-ob' | 'structural-liq' } | null {
  const wantDir: ObDirection = direction === 'LONG' ? 'bearish' : 'bullish';
  let best: { price: number; source: 'structural-ob' | 'structural-liq' } | null = null;
  for (const t of obTargets) {
    if (t.direction !== wantDir) continue;
    if (t.confirmedAtTime > signalBarTime) continue; // aún no se conocía
    if (t.invalidatedAt != null && t.invalidatedAt <= signalBarTime) continue; // ya estaba muerto
    const beyond = direction === 'LONG' ? t.proximal > entry : t.proximal < entry;
    if (!beyond) continue;
    if (best == null || Math.abs(t.proximal - entry) < Math.abs(best.price - entry)) {
      best = { price: t.proximal, source: 'structural-ob' };
    }
  }
  const liq = nearestLiquidityTp(direction, entry, signalBarTime, signalIdx, liqs, cfg, idxOfTime);
  if (liq != null && (best == null || Math.abs(liq - entry) < Math.abs(best.price - entry))) {
    best = { price: liq, source: 'structural-liq' };
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
  obTargets: ObTargetInfo[],
  cfg: SignalConfig,
  idxOfTime: Map<number, number>,
): { price: number; source: TpSource } {
  const sign = direction === 'LONG' ? 1 : -1;
  const fixed = entry + sign * cfg.rMultipleTp * risk;
  if (cfg.tpRule === 'fixedR') return { price: fixed, source: 'fixedR' };
  if (cfg.tpRule === 'structural') {
    const st = resolveStructuralTp(direction, entry, signalBarTime, signalIdx, obTargets, liqs, cfg, idxOfTime);
    return st ?? { price: fixed, source: 'fallbackFixedR' }; // sin POI/liquidez vigente → 2R etiquetado
  }
  const liq = nearestLiquidityTp(direction, entry, signalBarTime, signalIdx, liqs, cfg, idxOfTime);
  return liq != null ? { price: liq, source: 'liquidity' } : { price: fixed, source: 'fallbackFixedR' };
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
  obTargets: ObTargetInfo[],
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
  const tp = resolveTp(direction, entry, risk, signalBarTime, signalIdx, liqs, obTargets, cfg, idxOfTime);
  const rr = Math.abs(tp.price - entry) / risk;
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
      takeProfit: round4(tp.price),
      invalidationPrice: round4(distal),
      cancelBeyond: round4(entry + sign * cfg.cancelDistanceFrac * range),
      tpSource: tp.source,
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
  obTargets: ObTargetInfo[],
  cfg: SignalConfig,
  idxOfTime: Map<number, number>,
): { intents: TradeIntent[]; rejects: IntentReject[] } {
  const out = { intents: [] as TradeIntent[], rejects: [] as IntentReject[] };
  for (const o of obs) {
    const direction: TradeDirection = o.direction === 'bullish' ? 'LONG' : 'SHORT';
    const res = buildIntent(symbol, tf, `${o.originTime}`, direction, o.confirmedAtTime, o.obLow, o.obHigh, liqs, obTargets, cfg, idxOfTime);
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
  obTargets: ObTargetInfo[],
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
    const res = buildIntent(symbol, tf, `${conf.originTime}`, direction, conf.confirmedAtTime, conf.obLow, conf.obHigh, liqs, obTargets, cfg, idxOfTime);
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
  obTargets: ObTargetInfo[],
  cfg: SignalConfig,
  idxOfTime: Map<number, number>,
): { intents: TradeIntent[]; rejects: IntentReject[] } {
  const sweeps = detectSweeps(symbol, tf, candles, { swingLookback: cfg.swingLookback, poolMode: cfg.poolMode });
  const out = { intents: [] as TradeIntent[], rejects: [] as IntentReject[] };
  for (const s of sweeps) {
    const direction: TradeDirection = s.direction === 'bullish' ? 'LONG' : 'SHORT';
    // Zona de la reacción: del extremo de la mecha al nivel barrido (el "descuento" del sweep).
    const zoneLow = direction === 'LONG' ? s.wickExtreme : s.sweptLevel;
    const zoneHigh = direction === 'LONG' ? s.sweptLevel : s.wickExtreme;
    // El id lleva la dirección: una misma vela puede barrer un swing high Y un swing low (dos
    // intents opuestos) y el dedup por id del paper-trading no debe colapsarlos.
    const suffix = `${s.sweepBarTime}_${direction === 'LONG' ? 'u' : 'd'}`;
    const res = buildIntent(symbol, tf, suffix, direction, s.sweepBarTime, zoneLow, zoneHigh, liqs, obTargets, cfg, idxOfTime, {
      sweptLevel: s.sweptLevel,
      wickExtreme: s.wickExtreme,
      sweptSwingTime: s.sweptSwingTime,
    });
    collect(res, out, cfg, symbol, tf, suffix, direction, s.sweepBarTime, zoneLow, zoneHigh);
  }
  return out;
}

// Último swing (high/low) CONFIRMADO en/antes de la vela `barIdx` (índice ≤ barIdx − lookback).
// `swings` viene ascendente por index. El más reciente que cumple = el "último lower high / higher
// low" del CHoCH (Video externo BOSS+CHoCH).
function lastConfirmedSwing(swings: Swing[], kind: 'high' | 'low', barIdx: number, lookback: number): Swing | null {
  let res: Swing | null = null;
  for (const s of swings) {
    if (s.kind !== kind) continue;
    if (s.index + lookback <= barIdx) res = s;
    else if (s.index > barIdx) break;
  }
  return res;
}

// D · Sweep → CHoCH → entrada FVG (Ciclo 3, CYCLE-3-PREREG). Tras el sweep, exige un CAMBIO DE
// CARÁCTER (cuerpo que cierra más allá del último swing opuesto confirmado, dentro de maxChochBars)
// y entra en el FVG del desplazamiento (entrada precisa, stop corto). Causal de punta a punta.
function intentsD(
  symbol: string,
  tf: string,
  candles: ObCandle[],
  liqs: BotLiquidity[],
  obTargets: ObTargetInfo[],
  cfg: SignalConfig,
  idxOfTime: Map<number, number>,
): { intents: TradeIntent[]; rejects: IntentReject[] } {
  const out = { intents: [] as TradeIntent[], rejects: [] as IntentReject[] };
  const lookback = cfg.swingLookback;
  const sweeps = detectSweeps(symbol, tf, candles, { swingLookback: lookback, poolMode: cfg.poolMode });
  const swings = detectSwings(candles, lookback);
  const fvgs = detectStrictFvgs(symbol, tf, candles.map((c) => ({ openTime: c.openTime, high: c.high, low: c.low })));

  for (const s of sweeps) {
    const direction: TradeDirection = s.direction === 'bullish' ? 'LONG' : 'SHORT';
    const sIdx = idxOfTime.get(s.sweepBarTime);
    if (sIdx == null) continue;

    // 1) Nivel del CHoCH = último swing OPUESTO confirmado (high para LONG, low para SHORT).
    const level = lastConfirmedSwing(swings, direction === 'LONG' ? 'high' : 'low', sIdx, lookback);
    if (!level) continue; // sin estructura previa → no es setup (no es un descarte "operable")

    // 2) CHoCH = primer cuerpo que cierra más allá del nivel dentro de la ventana.
    let chochIdx = -1;
    const lastB = Math.min(sIdx + cfg.maxChochBars, candles.length - 1);
    for (let b = sIdx + 1; b <= lastB; b++) {
      const c = candles[b];
      if (direction === 'LONG' ? c.close > level.price : c.close < level.price) {
        chochIdx = b;
        break;
      }
    }
    if (chochIdx < 0) continue; // el sweep no confirmó (sin CHoCH) → no se opera (es el filtro del C3)

    // 3) FVG del desplazamiento del CHoCH = FVG estricto de la dirección, el MÁS RECIENTE cuya 3ª
    //    vela cae en (sweep, CHoCH+lag]. El FVG del impulso del CHoCH completa ~1 vela DESPUÉS del
    //    CHoCH (su 3ª vela), por eso la ventana lo incluye. El gap se "conoce" al cierre de esa 3ª vela.
    const FVG_LAG = 2;
    const wantDir = direction === 'LONG' ? 'bullish' : 'bearish';
    let fvg: (typeof fvgs)[number] | null = null;
    let fvgC3Idx = -1;
    for (const f of fvgs) {
      if (f.direction !== wantDir) continue;
      const c3i = idxOfTime.get(f.candle3Time);
      if (c3i == null || c3i <= sIdx || c3i > chochIdx + FVG_LAG) continue;
      if (!fvg || f.candle3Time > fvg.candle3Time) {
        fvg = f;
        fvgC3Idx = c3i;
      }
    }
    if (!fvg) continue; // sin FVG en el desplazamiento → no hay entrada (el video la exige)

    // La señal se conoce cuando AMBOS están: el CHoCH y el FVG completo (lo último de los dos).
    const signalIdx = Math.max(chochIdx, fvgC3Idx);
    const signalTime = candles[signalIdx].openTime;

    // 4) Entrada en el FVG: zona = [gapLow, gapHigh] → buildIntent pone entry=CE, SL bajo/sobre el FVG.
    const suffix = `${signalTime}_${direction === 'LONG' ? 'u' : 'd'}`;
    const res = buildIntent(symbol, tf, suffix, direction, signalTime, fvg.gapLow, fvg.gapHigh, liqs, obTargets, cfg, idxOfTime, {
      sweptLevel: s.sweptLevel,
      wickExtreme: s.wickExtreme,
      sweptSwingTime: s.sweptSwingTime,
    });
    collect(res, out, cfg, symbol, tf, suffix, direction, signalTime, fvg.gapLow, fvg.gapHigh);
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

  // Liquidez (si el TP la necesita): histórico completo, con barridos, sin filtros de distancia
  // ni tope → el filtro causal lo aplica nearestLiquidityTp por intent.
  const needLiq = cfg.tpRule === 'liquidity' || cfg.tpRule === 'structural';
  const liqs: BotLiquidity[] = needLiq
    ? detectLiquidity(symbol, tf, candles, {
        ...DEFAULT_LIQ_PARAMS,
        swingLookback: cfg.swingLookback,
        showSweptLiquidity: true,
        maxDistanceFromPricePct: null,
        maxLevels: Number.MAX_SAFE_INTEGER,
      })
    : [];

  // OBs: una sola detección sirve a los gatillos A/B (zonas de entrada) y al TP estructural
  // (targets opuestos con su línea de tiempo causal). C y D NO usan OBs de entrada (sweep/FVG).
  const needObs = cfg.gatillo === 'A' || cfg.gatillo === 'B' || cfg.tpRule === 'structural';
  const obs: BotOb[] = needObs
    ? detectOrderBlocks(symbol, tf, candles, {
        swingLookback: cfg.swingLookback,
        showLastBullish: Number.MAX_SAFE_INTEGER,
        showLastBearish: Number.MAX_SAFE_INTEGER,
      })
    : [];
  const obTargets: ObTargetInfo[] =
    cfg.tpRule === 'structural'
      ? obs.map((o) => {
          const ci = idxOfTime.get(o.confirmedAtTime);
          const tl = computeStateTimeline(candles, (ci ?? candles.length) + 1, o.direction, o.obLow, o.obHigh);
          return {
            direction: o.direction,
            proximal: o.direction === 'bearish' ? o.obLow : o.obHigh,
            confirmedAtTime: o.confirmedAtTime,
            invalidatedAt: tl.invalidatedAt,
          };
        })
      : [];

  let result: { intents: TradeIntent[]; rejects: IntentReject[] };
  if (cfg.gatillo === 'C') {
    result = intentsC(symbol, tf, candles, liqs, obTargets, cfg, idxOfTime);
  } else if (cfg.gatillo === 'D') {
    result = intentsD(symbol, tf, candles, liqs, obTargets, cfg, idxOfTime);
  } else {
    result =
      cfg.gatillo === 'A'
        ? intentsA(symbol, tf, obs, liqs, obTargets, cfg, idxOfTime)
        : intentsB(symbol, tf, obs, candles, liqs, obTargets, cfg, idxOfTime);
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
