// Generador de Trade Plans candidatos del bot (Fase 5F-A). Función pura, testeable.
// NO ejecuta, NO es orden: propuesta visual para ESTUDIAR (Regla Cero). Solo desde setups ARMED.
// Entrada por CONFIRMACIÓN (no al toque): se ancla en el OB que armó el setup. Mismo timeframe
// (refinamiento 15m/5m = fase posterior). Defaults provisionales 🔴; SL/TP a calibrar (ENTRY-EDGE §8/§9).

import type { BotSetup } from './setup.detector';
import type { BotOb } from './ob.detector';
import type { BotLiquidity } from './liquidity.detector';

export type PlanSide = 'LONG' | 'SHORT';
export type TpSource = 'liquidity' | 'rr_fallback';

export interface TradePlanParams {
  slBufferFrac: number; // buffer del SL = fracción del rango del OB de confirmación
  entryMode: 'ob_mid' | 'ob_proximal'; // conservador = mid del OB (no al toque)
  rrFallback: number; // R:R objetivo si NO hay liquidez opuesta como TP
  minRiskReward: number; // umbral para minRrMet
}
export const DEFAULT_TRADE_PLAN_PARAMS: TradePlanParams = {
  slBufferFrac: 0.25,
  entryMode: 'ob_mid',
  rrFallback: 2,
  minRiskReward: 2,
};

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
  obLow: number; // OB de confirmación (contexto de dibujo)
  obHigh: number;
  setupId: string;
  confluenceRating: BotSetup['rating'];
  score: number;
  timeStart: number;
  distancePct: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Genera un Trade Plan candidato por cada setup ARMED (con OB de confirmación). LONG/SHORT según
 * el contexto del setup. Entry = mid del OB; SL por fuera del OB (buffer); TP = liquidez opuesta
 * más cercana en la dirección del beneficio (fallback a R:R objetivo si no hay). R:R calculado.
 */
export function generateTradePlans(
  symbol: string,
  tf: string,
  setups: BotSetup[],
  obs: BotOb[],
  liqs: BotLiquidity[],
  lastClose: number,
  params: TradePlanParams = DEFAULT_TRADE_PLAN_PARAMS,
): BotTradePlan[] {
  const out: BotTradePlan[] = [];
  for (const s of setups) {
    if (s.state !== 'ARMED' || !s.confirmationObId) continue;
    const ob = obs.find((o) => o.id === s.confirmationObId);
    if (!ob) continue;

    const side: PlanSide = s.direction === 'bullish' ? 'LONG' : 'SHORT';
    const range = ob.obHigh - ob.obLow;
    if (range <= 0) continue;
    const buffer = params.slBufferFrac * range;
    const entry = params.entryMode === 'ob_mid' ? (ob.obLow + ob.obHigh) / 2 : side === 'LONG' ? ob.obHigh : ob.obLow;

    let stopLoss: number;
    let takeProfit: number;
    let tpSource: TpSource;
    if (side === 'LONG') {
      stopLoss = ob.obLow - buffer; // por debajo del OB
      const target = liqs
        .filter((l) => l.side === 'buyside' && l.level > entry)
        .sort((a, b) => a.level - b.level)[0]; // buyside más cercana arriba
      if (target) {
        takeProfit = target.level;
        tpSource = 'liquidity';
      } else {
        takeProfit = entry + params.rrFallback * (entry - stopLoss);
        tpSource = 'rr_fallback';
      }
    } else {
      stopLoss = ob.obHigh + buffer; // por encima del OB
      const target = liqs
        .filter((l) => l.side === 'sellside' && l.level < entry)
        .sort((a, b) => b.level - a.level)[0]; // sellside más cercana abajo
      if (target) {
        takeProfit = target.level;
        tpSource = 'liquidity';
      } else {
        takeProfit = entry - params.rrFallback * (stopLoss - entry);
        tpSource = 'rr_fallback';
      }
    }

    const risk = Math.abs(entry - stopLoss);
    const reward = Math.abs(takeProfit - entry);
    if (risk <= 0) continue;
    const rr = round2(reward / risk);
    const edgeDist = lastClose < Math.min(entry, stopLoss, takeProfit) ? Math.min(entry, stopLoss, takeProfit) - lastClose
      : lastClose > Math.max(entry, stopLoss, takeProfit) ? lastClose - Math.max(entry, stopLoss, takeProfit) : 0;

    out.push({
      id: `plan_${symbol}_${tf}_${side === 'LONG' ? 'u' : 'd'}_${Math.round(ob.obLow * 100)}`,
      symbol, tf, side,
      entry: round2(entry), stopLoss: round2(stopLoss), takeProfit: round2(takeProfit), rr,
      tpSource, minRrMet: rr >= params.minRiskReward,
      obLow: ob.obLow, obHigh: ob.obHigh,
      setupId: s.id, confluenceRating: s.rating, score: s.score,
      timeStart: s.armedAtTime ?? s.timeStart,
      distancePct: Math.round((edgeDist / lastClose) * 10000) / 100,
    });
  }
  return out;
}
