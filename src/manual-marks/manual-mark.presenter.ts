import type { ManualMarkEntity } from './entities/manual-mark.entity';

// Shape del contrato hacia el front. Campos opcionales: se OMITEN cuando son null en DB,
// para que el JSON coincida con el modelo opcional del front (priceLow?, entry?, ...).
export interface ManualMarkDto {
  id: string;
  sourceLayer: string;
  kind: string;
  symbol: string;
  tf: string;
  timeStart?: number;
  timeEnd?: number;
  priceLow?: number;
  priceHigh?: number;
  price?: number;
  side?: 'LONG' | 'SHORT';
  entry?: number;
  stopLoss?: number;
  takeProfit?: number;
  rr?: number;
  note: string;
  createdAt: number;
  updatedAt: number;
}

/** Proyecta la entidad al contrato, omitiendo los campos null. Función pura. */
export function toManualMarkDto(e: ManualMarkEntity): ManualMarkDto {
  const dto: ManualMarkDto = {
    id: e.id,
    sourceLayer: e.sourceLayer,
    kind: e.kind,
    symbol: e.symbol,
    tf: e.tf,
    note: e.note ?? '',
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
  };
  if (e.timeStart != null) dto.timeStart = e.timeStart;
  if (e.timeEnd != null) dto.timeEnd = e.timeEnd;
  if (e.priceLow != null) dto.priceLow = e.priceLow;
  if (e.priceHigh != null) dto.priceHigh = e.priceHigh;
  if (e.price != null) dto.price = e.price;
  if (e.side != null) dto.side = e.side as 'LONG' | 'SHORT';
  if (e.entry != null) dto.entry = e.entry;
  if (e.stopLoss != null) dto.stopLoss = e.stopLoss;
  if (e.takeProfit != null) dto.takeProfit = e.takeProfit;
  if (e.rr != null) dto.rr = e.rr;
  return dto;
}
