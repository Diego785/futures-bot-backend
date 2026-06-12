// Tipos de la pestaña PAPER (P.3) — espejo del API read-only /api/paper/*.
// El paper es el candidato CONGELADO operando en sombra (Regla Cero: jamás coloca órdenes).

export type PaperState = 'PENDING' | 'FILLED' | 'CLOSED';

export interface PaperTrade {
  intentId: string;
  symbol: string;
  tf: string;
  direction: 'LONG' | 'SHORT';
  signalBarTime: number;
  state: PaperState;
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
  entryPenetration: number | null; // touched-vs-crossed: cuánto cruzó la mecha el límite
  tpPenetration: number | null;
  engineVersion: string;
  paramsHash: string;
  createdAt: number;
  updatedAt: number;
}

export interface PaperStatusSymbol {
  symbol: string;
  cursor: number;
  open: number;
  paramsHash: string;
}

export interface PaperStatus {
  enabled: boolean;
  engineVersion: string;
  symbols: PaperStatusSymbol[];
}

export interface PaperTradesResponse {
  count: number;
  trades: PaperTrade[];
}
