// Registro de corridas (V.1) — mapeo PURO de los resultados del runner a filas persistibles.
// Sin TypeORM ni efectos: testeable offline. Las filas coinciden 1:1 con las entities.
//
// Por qué existe: la revisión 2026-06-10 encontró que dos corridas "iguales" usaron datasets
// distintos sin que nadie lo notara (el caso --limit). El registro guarda params RESUELTOS,
// paramsHash y el comando completo → toda corrida documentada es regenerable y comparable.

import { createHash } from 'crypto';
import type { IntentReject } from './signal-source';
import type { SimResult, TradeIntent } from './trade-simulator';
import type { SignalOutcome } from './entities/backtest-signal.entity';

export interface BacktestRunRow {
  id: string;
  createdAt: number;
  symbol: string;
  tf: string;
  fromTime: number | null;
  toTime: number | null;
  candleCount: number;
  engineVersion: string;
  paramsHash: string;
  command: string;
  params: Record<string, unknown>;
  metrics: Record<string, unknown>;
  biasPoints: { time: number; bias: string }[] | null;
  note: string;
}

export interface BacktestSignalRow {
  runId: string;
  intentId: string;
  direction: string;
  signalBarTime: number;
  outcome: SignalOutcome;
  reason: string | null;
  endTime: number | null;
  zoneLow: number | null;
  zoneHigh: number | null;
  sweptLevel: number | null;
  wickExtreme: number | null;
  sweptSwingTime: number | null;
  entry: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  invalidationPrice: number | null;
  cancelBeyond: number | null;
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
}

/** Hash corto (12 hex) de los parámetros CANÓNICOS de la corrida. El llamador construye el objeto
 *  con orden de claves FIJO (literal) — JSON.stringify respeta el orden de inserción. */
export function makeParamsHash(params: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(params)).digest('hex').slice(0, 12);
}

const EMPTY_LEVELS = {
  entry: null,
  stopLoss: null,
  takeProfit: null,
  invalidationPrice: null,
  cancelBeyond: null,
} as const;

const EMPTY_TRADE = {
  entryTime: null,
  entryPrice: null,
  exitTime: null,
  exitPrice: null,
  exitReason: null,
  grossR: null,
  costR: null,
  rMultiple: null,
  movedToBE: null,
  barsToFill: null,
  barsHeld: null,
} as const;

/**
 * Convierte el embudo del runner (intents emitidos + sus desenlaces simulados + candidatas
 * descartadas) en filas de `backtest_signals`. El visor dibuja TODO el embudo: el porqué-no
 * (rejected con razón) es la mitad de la auditoría visual.
 */
export function buildSignalRows(
  runId: string,
  intents: TradeIntent[],
  rejects: IntentReject[],
  results: SimResult[],
): BacktestSignalRow[] {
  const resultById = new Map(results.map((r) => [r.intentId, r]));
  const rows: BacktestSignalRow[] = [];

  for (const it of intents) {
    const base = {
      runId,
      intentId: it.id,
      direction: it.direction,
      signalBarTime: it.signalBarTime,
      zoneLow: it.context?.zoneLow ?? null,
      zoneHigh: it.context?.zoneHigh ?? null,
      sweptLevel: it.context?.sweptLevel ?? null,
      wickExtreme: it.context?.wickExtreme ?? null,
      sweptSwingTime: it.context?.sweptSwingTime ?? null,
      entry: it.entry,
      stopLoss: it.stopLoss,
      takeProfit: it.takeProfit,
      invalidationPrice: it.invalidationPrice ?? null,
      cancelBeyond: it.cancelBeyond ?? null,
    };
    const res = resultById.get(it.id);
    if (res?.outcome === 'filled' && res.trade) {
      const t = res.trade;
      rows.push({
        ...base,
        outcome: 'filled',
        reason: null,
        endTime: null,
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
      });
    } else {
      rows.push({
        ...base,
        ...EMPTY_TRADE,
        outcome: res?.outcome === 'cancelled' ? 'cancelled' : 'expired',
        reason: res?.reason ?? null,
        endTime: res?.endTime ?? null,
      });
    }
  }

  for (const rj of rejects) {
    rows.push({
      runId,
      intentId: rj.id,
      direction: rj.direction,
      signalBarTime: rj.signalBarTime,
      outcome: 'rejected',
      reason: rj.reason,
      endTime: null,
      zoneLow: rj.zoneLow,
      zoneHigh: rj.zoneHigh,
      sweptLevel: null,
      wickExtreme: null,
      sweptSwingTime: null,
      ...EMPTY_LEVELS,
      ...EMPTY_TRADE,
    });
  }

  return rows.sort((a, b) => a.signalBarTime - b.signalBarTime);
}
