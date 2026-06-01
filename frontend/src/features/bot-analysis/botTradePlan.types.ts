// Trade Plan candidato del bot (Fase 5F-A). Posible Long/Short con Entry/SL/TP/R:R, SOLO desde
// setups ARMED. NO ejecuta, NO es orden: propuesta visual para estudiar (Regla Cero).
export type PlanSide = 'LONG' | 'SHORT';
export type TpSource = 'liquidity' | 'rr_fallback';
export type PlanMode = 'confirmation' | 'risk';
export type PlanOperability = 'NEAR' | 'FAR' | 'STRUCTURAL';

export interface BotTradePlan {
  id: string;
  symbol: string;
  tf: string;
  side: PlanSide;
  mode: PlanMode;
  // Solo 'risk' (capa de estudio): true si la zona madre ya fue mitigada/trabajada (el toque ya
  // ocurrió → histórica, no operable inmediata); false = aún viva; null en confirmación.
  riskWorked: boolean | null;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  rr: number;
  tpSource: TpSource;
  minRrMet: boolean;
  operability: PlanOperability;
  entryDistancePct: number;
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
  mode: string;
  count: number;
  confirmationCount: number;
  riskCount: number;
  plans: BotTradePlan[];
}

// Color por lado (verde LONG / rojo SHORT). Entry/SL/TP usan azul/rojo/verde como la herramienta manual.
export const PLAN_SIDE_COLORS: Record<PlanSide, string> = { LONG: '#22c55e', SHORT: '#ef4444' };
export const OPERABILITY_LABELS: Record<PlanOperability, string> = {
  NEAR: 'Cercano',
  FAR: 'Lejano',
  STRUCTURAL: 'Estructural',
};
export const OPERABILITY_COLORS: Record<PlanOperability, string> = {
  NEAR: '#22c55e',
  FAR: '#fbbf24',
  STRUCTURAL: '#94a3b8',
};
