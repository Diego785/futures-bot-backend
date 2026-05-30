import type { ManualMark, ManualMarkKind } from './manualMarks.types';
import { isZoneKind } from './manualMarks.types';
import type { Timeframe } from '../candles/candles.types';

export interface NewMarkInput {
  kind: ManualMarkKind;
  symbol: string;
  tf: Timeframe;
  // zona
  timeStart?: number;
  timeEnd?: number;
  priceLow?: number;
  priceHigh?: number;
  // nivel
  price?: number;
  side?: 'LONG' | 'SHORT';
}

let seq = 0;

export function makeId(now: number): string {
  seq += 1;
  return `m${now.toString(36)}_${seq.toString(36)}`;
}

/** Crea una ManualMark desde la entrada de dibujo. Normaliza low/high de las zonas. */
export function createMark(input: NewMarkInput, now: number): ManualMark {
  const base: ManualMark = {
    id: makeId(now),
    sourceLayer: 'MyManualMarks',
    kind: input.kind,
    symbol: input.symbol,
    tf: input.tf,
    side: input.side,
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
  return { ...base, price: input.price };
}
