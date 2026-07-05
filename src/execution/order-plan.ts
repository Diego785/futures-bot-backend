// Planificador de órdenes PURO (sin red): convierte un TradeIntent del candidato congelado en el
// bracket de órdenes (entrada LÍMITE + SL + TP), con sizing desde capital CONFIGURADO (NUNCA del
// balance — EXECUTION-SPEC §3), redondeo a tick/step y validación de notional. 100% testeable.
//
// Decisión de ejecución SL/TP (refina EXECUTION-SPEC §4): SL = STOP_MARKET, TP = TAKE_PROFIT_MARKET,
// ambos reduceOnly. Robusto (salidas GARANTIZADAS, una sola API algoOrder, menos modos de fallo) a
// cambio de que el TP pague TAKER (~0.03 % del nocional ≈ 0.06R por ganadora) vs el maker del backtest:
// discrepancia chica, conocida y CONSERVADORA (real queda ligeramente pesimista vs paper). Se contabiliza.

import { roundToStepSize, roundToTickSize } from '../common/utils/precision.util';
import type { TradeIntent } from '../backtest/trade-simulator';
import type {
  SymbolFilters,
  PlannedOrder,
  PlanResult,
  OrderLeg,
} from './execution.types';

// clientOrderId DETERMINISTA (≤36 chars) para idempotencia: mismo intent+leg → mismo id, así un
// reinicio que re-coloque la misma orden es RECHAZADO por Binance (duplicate clientOrderId) =
// salvaguarda anti-doble-fill (EXECUTION-SPEC §6). Formato: FAB_{E|S|T|P}_{base36(ts)}_{sym}_{u|d}.
export function clientOrderIdFor(
  intent: { symbol: string; signalBarTime: number; direction: string },
  leg: OrderLeg,
): string {
  const code = leg === 'ENTRY' ? 'E' : leg === 'SL' ? 'S' : leg === 'TP1' ? 'P' : 'T';
  const ts = intent.signalBarTime.toString(36);
  const sym = intent.symbol.replace('USDT', '');
  const dir = intent.direction === 'LONG' ? 'u' : 'd';
  return `FAB_${code}_${ts}_${sym}_${dir}`.slice(0, 36);
}

// Config de la pierna parcial (v2, candidato partial-runner): TP1 = LIMIT reduceOnly de partialFrac
// en entry + tp1AtR×riesgo; el runner (resto) va al TP nominal. Sin esto → bracket v1 (full).
export interface PartialPlanConfig {
  tp1AtR: number;
  partialFrac: number;
}

// Construye el bracket para un intent. Devuelve un PlanResult discriminado: ok=true con el plan, o
// ok=false con la razón (el executor lo SALTA y lo loggea — nunca coloca a ciegas).
export function planBracket(
  intent: TradeIntent,
  riskUsd: number,
  filters: SymbolFilters | undefined,
  maxNotionalUsd: number,
  partial?: PartialPlanConfig,
): PlanResult {
  if (!filters) return { ok: false, reason: 'symbolUnknown', detail: intent.symbol };

  const { entry, stopLoss, takeProfit, direction } = intent;
  if (!(entry > 0 && stopLoss > 0 && takeProfit > 0)) {
    return { ok: false, reason: 'badPrices', detail: 'precio no positivo' };
  }

  const isLong = direction === 'LONG';
  // SL y TP del lado correcto (anti-intent corrupto): LONG → SL<entry<TP · SHORT → TP<entry<SL.
  if (isLong && !(stopLoss < entry && takeProfit > entry)) {
    return { ok: false, reason: 'badPrices', detail: 'LONG: no se cumple SL<entry<TP' };
  }
  if (!isLong && !(stopLoss > entry && takeProfit < entry)) {
    return { ok: false, reason: 'badPrices', detail: 'SHORT: no se cumple TP<entry<SL' };
  }

  const stopDistance = Math.abs(entry - stopLoss);
  if (stopDistance <= 0) return { ok: false, reason: 'badPrices', detail: 'stop nulo' };

  // SIZING: qty = riesgo$ / distancia-al-stop, FLOOR al stepSize. Pérdida en SL = qty×dist = riesgo$.
  const quantity = roundToStepSize(riskUsd / stopDistance, filters.stepSize);
  const qtyNum = parseFloat(quantity);
  if (qtyNum <= 0) {
    return { ok: false, reason: 'zeroQty', detail: `qty=0 (riesgo $${riskUsd} / dist ${stopDistance})` };
  }

  const notionalUsd = qtyNum * entry;
  if (notionalUsd < filters.minNotional) {
    return { ok: false, reason: 'minNotional', detail: `$${notionalUsd.toFixed(2)} < min $${filters.minNotional}` };
  }
  if (notionalUsd > maxNotionalUsd) {
    return { ok: false, reason: 'maxNotional', detail: `$${notionalUsd.toFixed(2)} > tope $${maxNotionalUsd}` };
  }

  const entrySide = isLong ? 'BUY' : 'SELL';
  const exitSide = isLong ? 'SELL' : 'BUY';

  const entryOrder: PlannedOrder = {
    leg: 'ENTRY',
    clientOrderId: clientOrderIdFor(intent, 'ENTRY'),
    symbol: intent.symbol,
    side: entrySide,
    type: 'LIMIT',
    quantity,
    price: roundToTickSize(entry, filters.tickSize),
    reduceOnly: false,
  };
  const stopLossOrder: PlannedOrder = {
    leg: 'SL',
    clientOrderId: clientOrderIdFor(intent, 'SL'),
    symbol: intent.symbol,
    side: exitSide,
    type: 'STOP_MARKET',
    quantity,
    stopPrice: roundToTickSize(stopLoss, filters.tickSize),
    reduceOnly: true,
  };
  const takeProfitOrder: PlannedOrder = {
    leg: 'TP',
    clientOrderId: clientOrderIdFor(intent, 'TP'),
    symbol: intent.symbol,
    side: exitSide,
    type: 'TAKE_PROFIT_MARKET',
    quantity,
    stopPrice: roundToTickSize(takeProfit, filters.tickSize),
    reduceOnly: true,
  };

  // v2: pierna TP1 (LIMIT reduceOnly por cantidad). Si la fracción redondea a 0 (posición de 1 step),
  // el plan DEGRADA a full-exit (sin TP1) — el executor lo loggea; jamás una orden de qty 0.
  let takeProfitPartial: PlannedOrder | undefined;
  let runnerQuantity: string | undefined;
  if (partial) {
    const sign = isLong ? 1 : -1;
    const tp1Qty = roundToStepSize(qtyNum * partial.partialFrac, filters.stepSize);
    const tp1QtyNum = parseFloat(tp1Qty);
    const restQty = roundToStepSize(qtyNum - tp1QtyNum, filters.stepSize);
    if (tp1QtyNum > 0 && parseFloat(restQty) > 0) {
      takeProfitPartial = {
        leg: 'TP1',
        clientOrderId: clientOrderIdFor(intent, 'TP1'),
        symbol: intent.symbol,
        side: exitSide,
        type: 'LIMIT',
        quantity: tp1Qty,
        price: roundToTickSize(entry + sign * partial.tp1AtR * stopDistance, filters.tickSize),
        reduceOnly: true,
      };
      runnerQuantity = restQty;
    }
  }

  return {
    ok: true,
    plan: {
      intentId: intent.id,
      symbol: intent.symbol,
      direction,
      riskUsd,
      stopDistance,
      quantity,
      notionalUsd,
      entry: entryOrder,
      stopLoss: stopLossOrder,
      takeProfit: takeProfitOrder,
      takeProfitPartial,
      runnerQuantity,
    },
  };
}

// Nuevo SL al mover a break-even: entrada ± buffer que cubre el coste round-trip (un stop en BE rinde
// ≈ 0R, no negativo). Mismo clientOrderId que el SL original (lo reemplaza tras cancelarlo).
export function planBreakeven(
  intent: TradeIntent,
  quantity: string,
  filters: SymbolFilters,
  feeBufferFrac = 0.0008,
): PlannedOrder {
  const isLong = intent.direction === 'LONG';
  const buffer = intent.entry * feeBufferFrac;
  const bePrice = isLong ? intent.entry + buffer : intent.entry - buffer;
  return {
    leg: 'SL',
    clientOrderId: clientOrderIdFor(intent, 'SL'),
    symbol: intent.symbol,
    side: isLong ? 'SELL' : 'BUY',
    type: 'STOP_MARKET',
    quantity,
    stopPrice: roundToTickSize(bePrice, filters.tickSize),
    reduceOnly: true,
  };
}
