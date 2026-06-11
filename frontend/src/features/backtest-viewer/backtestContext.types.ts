// Contexto SMC de una ventana del replay (V.3) — re-derivado por el backend con tiempos causales:
// el frontend solo dibuja lo que el cursor ya "conoce" (transición ≤ vela del cursor).

export interface ObContext {
  id: string;
  direction: 'bullish' | 'bearish';
  originTime: number; // vela origen (donde nace visualmente)
  confirmedAtTime: number; // cuándo el motor pudo conocerlo (BOS) → visible desde aquí
  obLow: number;
  obHigh: number;
  touchedAt: number | null;
  mitigatedAt: number | null;
  invalidatedAt: number | null; // tras esto, el OB desaparece del replay
}

export interface LiquidityContext {
  id: string;
  type: 'equalHigh' | 'equalLow' | 'swingHigh' | 'swingLow';
  side: 'buyside' | 'sellside';
  level: number;
  timeStart: number; // pivote más antiguo del nivel
  lastPivotTime: number;
  visibleFromTime: number | null; // cuándo quedó CONFIRMADO el último pivote (lookback después)
  sweptAtTime: number | null; // cuándo se barrió (la liquidez se consume)
}

export interface ReplayContextResponse {
  runId: string;
  symbol: string;
  tf: string;
  from: number;
  to: number;
  obs: ObContext[];
  liquidity: LiquidityContext[];
}
