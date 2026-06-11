// Tipos del VISOR DE BACKTESTS (V.2) — espejo del API read-only /api/backtest/runs[/:id]
// + helpers CAUSALES puros del replay: en el instante del cursor solo se muestra lo que el motor
// sabía entonces (NO-REPAINT-RULES aplicado al visor).

export type SignalOutcome = 'rejected' | 'cancelled' | 'expired' | 'filled';

export interface BacktestRunMetrics {
  signals: number;
  trades: number;
  cancelled: number;
  expired: number;
  fillRate: number;
  winRate: number;
  expectancyR: number;
  totalR: number;
  profitFactor: number;
  maxDrawdownR: number;
  exitReasons?: Record<string, number>;
  [k: string]: unknown;
}

export interface BacktestRunSummary {
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
  metrics: BacktestRunMetrics;
  note: string;
}

export interface BiasPoint {
  time: number;
  bias: string; // bullish | bearish | neutral
}

export interface BacktestRunDetail extends BacktestRunSummary {
  biasPoints: BiasPoint[] | null;
}

export interface BacktestSignal {
  runId: string;
  intentId: string;
  direction: 'LONG' | 'SHORT';
  signalBarTime: number;
  outcome: SignalOutcome;
  reason: string | null;
  endTime: number | null; // cancelled/expired: cuándo murió la pendiente
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
  exitReason: string | null; // SL | TP | BE | maxHold | endOfData
  grossR: number | null;
  costR: number | null;
  rMultiple: number | null;
  movedToBE: boolean | null;
  barsToFill: number | null;
  barsHeld: number | null;
}

export interface RunsResponse {
  count: number;
  runs: BacktestRunSummary[];
}

export interface RunDetailResponse {
  run: BacktestRunDetail;
  count: number;
  signals: BacktestSignal[];
}

// ───────────────────────────── Causalidad del replay ─────────────────────────────

// Fase de una señal cuando el replay está parado en la vela CERRADA de openTime `cursorOpen`.
// 'future' = aún no se conoce (no se dibuja NADA de ella) · 'rejected' = descartada (evento puntual)
// · 'pending' = límite vivo esperando fill · 'open' = posición dentro · 'closed' = resuelta con R
// · 'dead' = la pendiente murió (cancelada/expirada).
export type SignalPhase = 'future' | 'rejected' | 'pending' | 'open' | 'closed' | 'dead';

export function signalPhaseAt(s: BacktestSignal, cursorOpen: number, tfMs: number): SignalPhase {
  if (cursorOpen < s.signalBarTime) return 'future'; // la vela de la señal aún no cerró
  if (s.outcome === 'rejected') return 'rejected';
  const cursorClose = cursorOpen + tfMs - 1;
  if (s.outcome === 'filled') {
    if (s.exitTime != null && cursorClose >= s.exitTime) return 'closed';
    if (s.entryTime != null && cursorOpen >= s.entryTime) return 'open';
    return 'pending';
  }
  if (s.endTime != null && cursorClose >= s.endTime) return 'dead';
  return 'pending';
}

/** Sesgo HTF vigente al cierre de la vela del cursor (igual contrato que biasAt del backend). */
export function biasAtTime(points: BiasPoint[] | null, cursorClose: number): string {
  if (!points || points.length === 0) return 'neutral';
  let res = 'neutral';
  for (const p of points) {
    if (p.time <= cursorClose) res = p.bias;
    else break;
  }
  return res;
}

/** Curva de equity en R del run (solo trades llenados y resueltos), por tiempo de salida. */
export function equityCurve(signals: BacktestSignal[]): { time: number; cum: number; intentId: string }[] {
  const closed = signals
    .filter((s) => s.outcome === 'filled' && s.exitTime != null && s.rMultiple != null)
    .sort((a, b) => (a.exitTime as number) - (b.exitTime as number));
  let cum = 0;
  return closed.map((s) => {
    cum += s.rMultiple as number;
    return { time: s.exitTime as number, cum: Math.round(cum * 1e4) / 1e4, intentId: s.intentId };
  });
}

// Colores compartidos del replay (alineados con theme.css: --up/--down/--accent).
export const REPLAY_COLORS = {
  long: '#26a69a',
  short: '#ef5350',
  entry: '#3b82f6',
  sl: '#ef5350',
  tp: '#26a69a',
  swept: '#f59e0b',
  cancel: '#6b7280',
  be: '#9ca3af',
} as const;

export function exitColor(exitReason: string | null): string {
  if (exitReason === 'TP') return REPLAY_COLORS.tp;
  if (exitReason === 'SL') return REPLAY_COLORS.sl;
  return REPLAY_COLORS.be; // BE / maxHold / endOfData
}

// Etiquetas de las ASUNCIONES del simulador que el auditor debe tener presentes al ver un trade.
// (Decisiones de modelado documentadas en trade-simulator.ts — el replay las hace visibles.)
export function simAssumptions(s: BacktestSignal): string[] {
  const out: string[] = [];
  if (s.outcome === 'filled') {
    out.push('Fill por TOQUE del límite (sin cola de órdenes) — asunción optimista del sim');
    if (s.movedToBE) out.push('BE armado al 50 % del recorrido (surte efecto en la vela SIGUIENTE)');
    if (s.exitReason === 'BE') out.push('Salida en break-even (≈0R: el buffer cubre los costes)');
    if (s.exitReason === 'TP') out.push('TP llena por toque exacto (maker) — asunción optimista del sim');
    if (s.barsToFill === 0) out.push('Llenó en la primera vela elegible tras la señal');
    if (s.exitTime != null && s.entryTime != null && s.exitTime - s.entryTime < 0) out.push('');
  }
  if (s.outcome === 'cancelled' && s.reason === 'ranAway')
    out.push('Cancelada: el precio se alejó más de cancelDist × rango sin llenar ("ni ganaste ni perdiste")');
  if (s.outcome === 'cancelled' && s.reason === 'invalidated')
    out.push('Cancelada: un CUERPO cerró más allá del borde distal (zona invalidada)');
  return out.filter(Boolean);
}
