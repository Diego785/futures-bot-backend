import type { ManualMark, ManualMarkKind } from './manualMarks.types';
import { isZoneKind, isPlanKind } from './manualMarks.types';
import type { Timeframe } from '../candles/candles.types';

export interface NewMarkInput {
  kind: ManualMarkKind;
  symbol: string;
  tf: Timeframe;
  // zona (OB/FVG)
  timeStart?: number;
  timeEnd?: number;
  priceLow?: number;
  priceHigh?: number;
  // nivel (Liquidity)
  price?: number;
  // plan (TradePlan)
  side?: 'LONG' | 'SHORT';
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
}

// uuid: id estable y único entre sesiones/dispositivos, válido como PK en el backend
// (^[A-Za-z0-9_-]{1,64}$). crypto.randomUUID está disponible en contexto seguro (localhost).
export function makeId(): string {
  return crypto.randomUUID();
}

/** Crea una ManualMark desde la entrada de dibujo. Normaliza low/high de las zonas. */
export function createMark(input: NewMarkInput, now: number): ManualMark {
  const base: ManualMark = {
    id: makeId(),
    sourceLayer: 'MyManualMarks',
    kind: input.kind,
    symbol: input.symbol,
    tf: input.tf,
    note: '',
    createdAt: now,
    updatedAt: now,
  };
  if (isZoneKind(input.kind)) {
    const lo = Math.min(input.priceLow ?? 0, input.priceHigh ?? 0);
    const hi = Math.max(input.priceLow ?? 0, input.priceHigh ?? 0);
    const t1 = Math.min(input.timeStart ?? 0, input.timeEnd ?? 0);
    const t2 = Math.max(input.timeStart ?? 0, input.timeEnd ?? 0);
    return { ...base, priceLow: lo, priceHigh: hi, timeStart: t1, timeEnd: t2 };
  }
  if (isPlanKind(input.kind)) {
    return {
      ...base,
      side: input.side,
      entry: input.entry,
      stopLoss: input.stopLoss,
      takeProfit: input.takeProfit,
      timeStart: input.timeStart,
      timeEnd: input.timeEnd,
    };
  }
  return { ...base, price: input.price };
}
