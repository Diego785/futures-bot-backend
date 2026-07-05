// P.2 — mapeo PURO de una PaperPosition a la fila persistible + instrumentación touched-vs-crossed.
// Sin TypeORM ni efectos (testeable offline). REGLA CERO: esto solo describe lo que el candidato
// HARÍA; nada aquí toca órdenes.

import type { PaperCandle, PaperPosition, PaperState } from './paper-engine';

export interface PaperTradeRow {
  intentId: string; // PK — ya incluye símbolo/tf/vela/dirección
  symbol: string;
  tf: string;
  direction: string;
  signalBarTime: number;
  state: PaperState; // PENDING | FILLED | CLOSED (CANCELLED se modela como CLOSED+cancelReason)
  phase: 'backfill' | 'live'; // histórico rehidratado vs forward-test real (gate #7)
  entry: number;
  stopLoss: number;
  takeProfit: number;
  tpSource: string | null;
  invalidationPrice: number | null;
  cancelBeyond: number | null;
  zoneLow: number | null;
  zoneHigh: number | null;
  sweptLevel: number | null;
  wickExtreme: number | null;
  sweptSwingTime: number | null;
  entryTime: number | null;
  entryPrice: number | null;
  exitTime: number | null;
  exitPrice: number | null;
  exitReason: string | null;
  grossR: number | null;
  costR: number | null;
  rMultiple: number | null;
  movedToBE: boolean | null;
  barsToFill: number | null;
  barsHeld: number | null;
  cancelReason: string | null;
  // Instrumentación del gate #7 (PAPER-TEST-SPEC §4): ¿el precio CRUZÓ el nivel o solo lo tocó?
  // Se guarda la PENETRACIÓN en precio (≥0); con ella se recalcula la expectancy bajo cualquier
  // regla estricta ("fill exige ≥ k ticks") al cierre del gate.
  entryPenetration: number | null; // cuánto pasó la mecha MÁS ALLÁ del límite en la vela del fill
  tpPenetration: number | null; // ídem más allá del TP en la vela de salida (solo exitReason TP)
  // v2 (Ciclo 4): piernas del motor partial-runner. null en filas del candidato v1 (modo full).
  tp1Filled: boolean | null; // el parcial llenó (BE con tp1Filled = trade EN GANANCIA)
  tp1Time: number | null;
  tp1ExitPrice: number | null;
  runnerTp: number | null; // TP2 efectivo del runner
  engineVersion: string;
  paramsHash: string;
  createdAt: number;
  updatedAt: number;
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** Penetraciones de fill/TP a partir de las velas conocidas (puro; null si no aplica/no está la vela). */
export function computePenetrations(
  p: PaperPosition,
  candles: PaperCandle[],
): { entryPenetration: number | null; tpPenetration: number | null } {
  const t = p.trade ?? p.live; // FILLED ya tiene fill (provisional); CLOSED el definitivo
  if (!t) return { entryPenetration: null, tpPenetration: null };
  const long = t.direction === 'LONG';
  const entryBar = candles.find((c) => c.openTime === t.entryTime);
  const entryPenetration = entryBar
    ? round4(Math.max(long ? p.intent.entry - entryBar.low : entryBar.high - p.intent.entry, 0))
    : null;
  let tpPenetration: number | null = null;
  if (t.exitReason === 'TP') {
    // exitTime es el closeTime de la vela de salida → localizarla por rango [open, close].
    const exitBar = candles.find((c) => c.openTime <= t.exitTime && (c.closeTime ?? c.openTime) >= t.exitTime);
    tpPenetration = exitBar
      ? round4(Math.max(long ? exitBar.high - p.intent.takeProfit : p.intent.takeProfit - exitBar.low, 0))
      : null;
  }
  return { entryPenetration, tpPenetration };
}

/**
 * Convierte el estado actual de una posición del engine a su fila persistible (upsert idempotente).
 * `clockStart` (epoch ms) decide la fase: señal anterior = 'backfill' (contexto), posterior = 'live'
 * (cuenta en el gate). Default 0 = todo 'live' (para tests); el servicio pasa MAX si el reloj no arrancó.
 */
export function toPaperTradeRow(
  p: PaperPosition,
  candles: PaperCandle[],
  engineVersion: string,
  paramsHash: string,
  now: number,
  clockStart = 0,
): PaperTradeRow {
  const it = p.intent;
  // CLOSED usa el trade definitivo; FILLED usa el provisional (fill real, sin salida aún).
  const closed = p.state === 'CLOSED' ? (p.trade ?? null) : null;
  const fillInfo = closed ?? (p.state === 'FILLED' ? (p.live ?? null) : null);
  const t = {
    entryTime: fillInfo?.entryTime ?? null,
    entryPrice: fillInfo?.entryPrice ?? null,
    exitTime: closed?.exitTime ?? null,
    exitPrice: closed?.exitPrice ?? null,
    exitReason: closed?.exitReason ?? null,
    grossR: closed?.grossR ?? null,
    costR: closed?.costR ?? null,
    rMultiple: closed?.rMultiple ?? null,
    movedToBE: (closed ?? fillInfo)?.movedToBE ?? null,
    barsToFill: fillInfo?.barsToFill ?? null,
    barsHeld: closed?.barsHeld ?? null,
  };
  const pen = computePenetrations(p, candles);
  return {
    intentId: it.id,
    symbol: it.symbol,
    tf: it.tf,
    direction: it.direction,
    signalBarTime: it.signalBarTime,
    state: p.state,
    phase: it.signalBarTime >= clockStart ? 'live' : 'backfill',
    entry: it.entry,
    stopLoss: it.stopLoss,
    takeProfit: it.takeProfit,
    tpSource: it.tpSource ?? null,
    invalidationPrice: it.invalidationPrice ?? null,
    cancelBeyond: it.cancelBeyond ?? null,
    zoneLow: it.context?.zoneLow ?? null,
    zoneHigh: it.context?.zoneHigh ?? null,
    sweptLevel: it.context?.sweptLevel ?? null,
    wickExtreme: it.context?.wickExtreme ?? null,
    sweptSwingTime: it.context?.sweptSwingTime ?? null,
    entryTime: t.entryTime,
    entryPrice: t.entryPrice,
    exitTime: t.exitTime,
    exitPrice: t.exitPrice,
    exitReason: t.exitReason,
    grossR: t.grossR,
    costR: t.costR,
    rMultiple: t.rMultiple,
    movedToBE: t.movedToBE,
    barsToFill: t.barsToFill,
    barsHeld: t.barsHeld,
    cancelReason: p.cancelReason ?? null,
    tp1Filled: (closed ?? fillInfo)?.tp1Filled ?? null,
    tp1Time: (closed ?? fillInfo)?.tp1Time ?? null,
    tp1ExitPrice: (closed ?? fillInfo)?.tp1ExitPrice ?? null,
    runnerTp: (closed ?? fillInfo)?.runnerTp ?? null,
    ...pen,
    engineVersion,
    paramsHash,
    createdAt: now,
    updatedAt: now,
  };
}
