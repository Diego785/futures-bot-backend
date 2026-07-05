// Decisiones PURAS del loop de ejecución (sin red/estado): cuándo cancelar la límite (cancelBeyond),
// cuándo mover a break-even, y la R real realizada de una posición. Testeable; el ExecutionService las
// usa para decidir y luego ACTÚA (coloca/cancela órdenes) vía OrderExecutorService.

import type { TradeIntent } from '../backtest/trade-simulator';

// ¿La vela CERRADA alcanzó el cancelBeyond? = el precio se ALEJÓ del pullback sin llenar la límite.
// LONG: la entrada espera un retroceso hacia ABAJO; si corre hacia ARRIBA (high ≥ cancelBeyond) → fuera.
// SHORT: espejo (low ≤ cancelBeyond). Causal: se evalúa al cierre de la vela (como el backtest).
export function reachedCancelBeyond(intent: TradeIntent, high: number, low: number): boolean {
  if (intent.cancelBeyond == null) return false;
  return intent.direction === 'LONG' ? high >= intent.cancelBeyond : low <= intent.cancelBeyond;
}

// Nivel del recorrido entrada→TP donde se mueve el SL a break-even (beFraction, default 0.5). Vale para
// ambas direcciones por el signo de (TP − entry): LONG sube, SHORT baja.
export function breakevenTriggerLevel(intent: TradeIntent, beFraction: number): number {
  return intent.entry + beFraction * (intent.takeProfit - intent.entry);
}

// ¿La vela CERRADA alcanzó el nivel de BE? LONG: high ≥ nivel · SHORT: low ≤ nivel.
export function reachedBreakeven(
  intent: TradeIntent,
  high: number,
  low: number,
  beFraction: number,
): boolean {
  const level = breakevenTriggerLevel(intent, beFraction);
  return intent.direction === 'LONG' ? high >= level : low <= level;
}

// R neta realizada de la posición REAL, en la MISMA escala que el paper/backtest: el denominador es el
// riesgo PLANEADO |entry − SL| (no el del fill real) → real y paper comparan en las mismas unidades de R.
// grossR = (salida − entrada)·signo / riesgo · ; feeR = fees$ / (riesgo en USD) = fees$ / (qty·riesgo).
export function computeRealizedR(
  intent: TradeIntent,
  entryFill: number,
  exitFill: number,
  feeUsdTotal: number,
  quantity: number,
): number {
  const risk = Math.abs(intent.entry - intent.stopLoss);
  if (risk <= 0 || quantity <= 0) return 0;
  const sign = intent.direction === 'LONG' ? 1 : -1;
  const grossR = (sign * (exitFill - entryFill)) / risk;
  const feeR = feeUsdTotal / (quantity * risk);
  return grossR - feeR;
}

// Coste estimado en USD del round-trip por las tarifas (entrada maker, salida taker market-on-trigger).
// Determinista desde el schedule de fees (matchea el modelo del backtest). nocional ≈ precio·qty por lado.
export function estimateFeesUsd(
  entryFill: number,
  exitFill: number,
  quantity: number,
  makerFee: number,
  takerFee: number,
): number {
  return entryFill * quantity * makerFee + exitFill * quantity * takerFee;
}

// ─── v2 (candidato partial-runner): R combinada de una posición que salió en VARIAS piernas ───

export interface ExitLeg {
  price: number; // fill real de la pierna
  qty: number; // cantidad de la pierna
  feeUsd: number; // fee de ESA salida (maker si límite TP1, taker si stop/TP-market)
}

// R neta combinada en la MISMA escala que el paper: denominador = riesgo PLANEADO total
// (totalQty × |entry − SL|). grossUsd = Σ signo·(exit − entrada)·qty − fees (entrada + salidas).
export function computeRealizedRPartial(
  intent: TradeIntent,
  entryFill: number,
  legs: ExitLeg[],
  entryFeeUsd: number,
): number {
  const risk = Math.abs(intent.entry - intent.stopLoss);
  const totalQty = legs.reduce((s, l) => s + l.qty, 0);
  if (risk <= 0 || totalQty <= 0) return 0;
  const sign = intent.direction === 'LONG' ? 1 : -1;
  const grossUsd = legs.reduce((s, l) => s + sign * (l.price - entryFill) * l.qty, 0);
  const feesUsd = entryFeeUsd + legs.reduce((s, l) => s + l.feeUsd, 0);
  return (grossUsd - feesUsd) / (totalQty * risk);
}
