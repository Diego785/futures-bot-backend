// Trade Plan candidato del bot (Fase 5F-A). Posible Long/Short con Entry/SL/TP/R:R, SOLO desde
// setups ARMED. NO ejecuta, NO es orden: propuesta visual para estudiar (Regla Cero).
export type PlanSide = 'LONG' | 'SHORT';
export type TpSource = 'liquidity' | 'rr_fallback';

export interface BotTradePlan {
  id: string;
  symbol: string;
  tf: string;
  side: PlanSide;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  rr: number;
  tpSource: TpSource;
  minRrMet: boolean;
  obLow: number;
  obHigh: number;
  setupId: string;
  confluenceRating: 'LOW' | 'MEDIUM' | 'HIGH';
  score: number;
  timeStart: number;
  distancePct: number;
}

export interface BotPlanResponse {
  symbol: string;
  tf: string;
  count: number;
  plans: BotTradePlan[];
}

// Color por lado (verde LONG / rojo SHORT). Entry/SL/TP usan azul/rojo/verde como la herramienta manual.
export const PLAN_SIDE_COLORS: Record<PlanSide, string> = { LONG: '#22c55e', SHORT: '#ef4444' };
