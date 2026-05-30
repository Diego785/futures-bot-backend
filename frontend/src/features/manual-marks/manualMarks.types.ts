import type { Timeframe } from '../candles/candles.types';

// Marcas manuales del usuario sobre las velas. Serán el golden dataset para que el motor
// SMC aprenda el criterio del usuario. OB/FVG son ZONAS (rango tiempo+precio);
// Liquidity/Entry/SL/TP son NIVELES (un precio). NO son señales del bot.
export type ManualMarkKind = 'OB' | 'FVG' | 'Liquidity' | 'Entry' | 'SL' | 'TP';

// Herramienta activa en la toolbar de dibujo.
export type ManualTool = 'Select' | ManualMarkKind;

export interface ManualMark {
  id: string;
  sourceLayer: 'MyManualMarks';
  kind: ManualMarkKind;
  symbol: string;
  tf: Timeframe;
  // Zonas (OB/FVG): rango temporal (epoch ms UTC) + rango de precio.
  timeStart?: number;
  timeEnd?: number;
  priceLow?: number;
  priceHigh?: number;
  // Niveles (Liquidity/Entry/SL/TP): un solo precio.
  price?: number;
  side?: 'LONG' | 'SHORT';
  note?: string;
  createdAt: number;
  updatedAt: number;
}

export const ZONE_KINDS: ManualMarkKind[] = ['OB', 'FVG'];
export const LEVEL_KINDS: ManualMarkKind[] = ['Liquidity', 'Entry', 'SL', 'TP'];

export function isZoneKind(kind: ManualMarkKind): boolean {
  return kind === 'OB' || kind === 'FVG';
}

// Colores por tipo (también usados en la gráfica).
export const MARK_COLORS: Record<ManualMarkKind, string> = {
  OB: '#3b82f6',
  FVG: '#a855f7',
  Liquidity: '#eab308',
  Entry: '#26a69a',
  SL: '#ef5350',
  TP: '#22c55e',
};
