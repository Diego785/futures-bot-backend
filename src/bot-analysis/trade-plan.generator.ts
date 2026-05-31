// Generador de Trade Plans candidatos del bot (Fase 5F-A/5F-B). Función pura, testeable.
// NO ejecuta, NO es orden: propuesta visual para ESTUDIAR (Regla Cero).
// Modo CONFIRMACIÓN (default): solo setups ARMED, entry en el OB de confirmación (no al toque).
// Modo RIESGO (opcional): setups WATCHING/MITIGATED, entry en la zona de confluencia (al toque,
//   sin esperar confirmación) — más agresivo, etiquetado 'risk'. byRisk NUNCA es default.
// Operabilidad: NEAR/FAR/STRUCTURAL según la distancia del Entry al precio actual (anti-ruido).
// Mismo timeframe (refinamiento 15m/5m = fase posterior). Defaults provisionales 🔴.

import type { BotSetup } from './setup.detector';
import type { BotOb } from './ob.detector';
import type { BotLiquidity } from './liquidity.detector';

export type PlanSide = 'LONG' | 'SHORT';
export type TpSource = 'liquidity' | 'rr_fallback';
export type PlanMode = 'confirmation' | 'risk';
export type PlanOperability = 'NEAR' | 'FAR' | 'STRUCTURAL';
export type PlanModeQuery = 'confirmation' | 'risk' | 'both';

export interface TradePlanParams {
  slBufferFrac: number;
  entryMode: 'ob_mid' | 'ob_proximal';
  rrFallback: number;
  minRiskReward: number;
  nearMaxPct: number; // distancia Entry↔precio ≤ esto → NEAR
  structuralMinPct: number; // > esto → STRUCTURAL (lejano, contexto HTF, no entrada inmediata)
}
export const DEFAULT_TRADE_PLAN_PARAMS: TradePlanParams = {
  slBufferFrac: 0.25,
  entryMode: 'ob_mid',
  rrFallback: 2,
  minRiskReward: 2,
  nearMaxPct: 3,
  structuralMinPct: 10,
};

export interface BotTradePlan {
  id: string;
  symbol: string;
  tf: string;
  side: PlanSide;
  mode: PlanMode;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  rr: number;
  tpSource: TpSource;
  minRrMet: boolean;
  operability: PlanOperability;
  entryDistancePct: number; // |Entry − precio actual| en %
  obLow: number; // zona base (OB de confirmación o zona de confluencia)
  obHigh: number;
  setupId: string;
  confluenceRating: BotSetup['rating'];
  score: number;
  timeStart: number;
  distancePct: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// Construye un plan a partir de una zona [low, high] y un lado. Devuelve null si el riesgo es 0.
function buildPlan(
  symbol: string, tf: string, side: PlanSide, mode: PlanMode,
  low: number, high: number, timeStart: number, s: BotSetup,
  liqs: BotLiquidity[], lastClose: number, params: TradePlanParams,
): BotTradePlan | null {
  const range = high - low;
  if (range <= 0) return null;
  const buffer = params.slBufferFrac * range;
  const entry = params.entryMode === 'ob_mid' ? (low + high) / 2 : side === 'LONG' ? high : low;

  let stopLoss: number;
  let takeProfit: number;
  let tpSource: TpSource;
  if (side === 'LONG') {
    stopLoss = low - buffer;
    const target = liqs.filter((l) => l.side === 'buyside' && l.level > entry).sort((a, b) => a.level - b.level)[0];
    if (target) { takeProfit = target.level; tpSource = 'liquidity'; }
    else { takeProfit = entry + params.rrFallback * (entry - stopLoss); tpSource = 'rr_fallback'; }
  } else {
    stopLoss = high + buffer;
    const target = liqs.filter((l) => l.side === 'sellside' && l.level < entry).sort((a, b) => b.level - a.level)[0];
    if (target) { takeProfit = target.level; tpSource = 'liquidity'; }
    else { takeProfit = entry - params.rrFallback * (stopLoss - entry); tpSource = 'rr_fallback'; }
  }

  const risk = Math.abs(entry - stopLoss);
  if (risk <= 0) return null;
  const rr = round2(Math.abs(takeProfit - entry) / risk);
  const entryDistancePct = round2((Math.abs(entry - lastClose) / lastClose) * 100);
  const operability: PlanOperability =
    entryDistancePct <= params.nearMaxPct ? 'NEAR' : entryDistancePct <= params.structuralMinPct ? 'FAR' : 'STRUCTURAL';
  const edge = lastClose < Math.min(entry, stopLoss, takeProfit) ? Math.min(entry, stopLoss, takeProfit) - lastClose
    : lastClose > Math.max(entry, stopLoss, takeProfit) ? lastClose - Math.max(entry, stopLoss, takeProfit) : 0;

  return {
    id: `plan_${mode === 'confirmation' ? 'c' : 'r'}_${symbol}_${tf}_${side === 'LONG' ? 'u' : 'd'}_${Math.round(low * 100)}`,
    symbol, tf, side, mode,
    entry: round2(entry), stopLoss: round2(stopLoss), takeProfit: round2(takeProfit), rr,
    tpSource, minRrMet: rr >= params.minRiskReward, operability, entryDistancePct,
    obLow: low, obHigh: high,
    setupId: s.id, confluenceRating: s.rating, score: s.score,
    timeStart, distancePct: round2((edge / lastClose) * 100),
  };
}

/**
 * Genera Trade Plans candidatos. mode 'confirmation' (default): solo ARMED (entry en el OB de
 * confirmación). mode 'risk': WATCHING/MITIGATED (entry en la zona de confluencia, al toque).
 * mode 'both': ambos. Cada setup produce a lo sumo un plan (ARMED→confirmación; resto→riesgo).
 */
export function generateTradePlans(
  symbol: string,
  tf: string,
  setups: BotSetup[],
  obs: BotOb[],
  liqs: BotLiquidity[],
  lastClose: number,
  mode: PlanModeQuery = 'confirmation',
  params: TradePlanParams = DEFAULT_TRADE_PLAN_PARAMS,
): BotTradePlan[] {
  const wantConf = mode !== 'risk';
  const wantRisk = mode !== 'confirmation';
  const out: BotTradePlan[] = [];
  for (const s of setups) {
    const side: PlanSide = s.direction === 'bullish' ? 'LONG' : 'SHORT';
    if (s.state === 'ARMED' && wantConf && s.confirmationObId) {
      const ob = obs.find((o) => o.id === s.confirmationObId);
      if (!ob) continue;
      const p = buildPlan(symbol, tf, side, 'confirmation', ob.obLow, ob.obHigh, s.armedAtTime ?? s.timeStart, s, liqs, lastClose, params);
      if (p) out.push(p);
    } else if ((s.state === 'WATCHING' || s.state === 'MITIGATED') && wantRisk) {
      const p = buildPlan(symbol, tf, side, 'risk', s.priceLow, s.priceHigh, s.timeStart, s, liqs, lastClose, params);
      if (p) out.push(p);
    }
  }
  return out;
}
