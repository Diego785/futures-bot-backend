// Estados de Setup — lectura AUTOMÁTICA del bot (Fase 5E-A). Función pura, testeable.
// NO es señal ni entrada: visualiza el CICLO DE VIDA de una zona de confluencia mientras el
// precio la trabaja. Solo 3 estados: WATCHING → MITIGATED → ARMED. NO hay TRIGGERED ni
// SignalCandidate ni Entry/SL/TP todavía (eso es 5F). ARMED solo por CONFIRMACIÓN (un OB nuevo
// en la zona), nunca "al toque" (byRisk queda documentado pero fuera del flujo; ver ENTRY-EDGE §3).
// Confirmación en el MISMO timeframe del setup (el refinamiento a 15m/5m es de 5F).

import type { ConfluenceZone } from './confluence.scorer';
import type { BotOb } from './ob.detector';

export interface SetupCandle {
  openTime: number;
  high: number;
  low: number;
  close: number;
}

export type SetupState = 'WATCHING' | 'MITIGATED' | 'ARMED';

export interface SetupParams {
  // OB de confirmación: debe solapar la zona o estar a ≤ este % del borde.
  confirmationProximityPct: number;
}
export const DEFAULT_SETUP_PARAMS: SetupParams = { confirmationProximityPct: 0.5 };

export interface BotSetup {
  id: string;
  symbol: string;
  tf: string;
  direction: 'bullish' | 'bearish'; // contexto LONG / SHORT
  state: SetupState;
  priceLow: number;
  priceHigh: number;
  timeStart: number;
  confluenceId: string;
  rating: ConfluenceZone['rating'];
  score: number;
  mitigatedAtTime: number | null;
  armedAtTime: number | null;
  confirmationObId: string | null;
  distancePct: number;
}

/**
 * Calcula el estado de cada zona de confluencia según cómo el precio la ha trabajado (causal,
 * solo con velas posteriores a la formación de la zona). Excluye setups invalidados (cierre más
 * allá del borde distal en contra). ARMED requiere un OB de confirmación (misma dirección,
 * originado TRAS la mitigación, solapado/cercano a la zona) — nunca por simple toque.
 */
export function detectSetups(
  symbol: string,
  tf: string,
  zones: ConfluenceZone[],
  obs: BotOb[],
  candles: SetupCandle[],
  lastClose: number,
  params: SetupParams = DEFAULT_SETUP_PARAMS,
): BotSetup[] {
  const out: BotSetup[] = [];
  for (const z of zones) {
    const lo = z.priceLow;
    const hi = z.priceHigh;
    const dir = z.direction;

    let mitigatedAt: number | null = null;
    let invalidated = false;
    for (const c of candles) {
      if (c.openTime <= z.timeStart) continue;
      // Invalidación: cierre más allá del borde distal en contra de la zona.
      if (dir === 'bullish' ? c.close < lo : c.close > hi) {
        invalidated = true;
        break;
      }
      // Mitigación: el rango de la vela entra en la banda de la zona.
      if (mitigatedAt == null && c.low <= hi && c.high >= lo) mitigatedAt = c.openTime;
    }
    if (invalidated) continue; // setup muerto: no se lista

    let state: SetupState = mitigatedAt == null ? 'WATCHING' : 'MITIGATED';
    let armedAtTime: number | null = null;
    let confirmationObId: string | null = null;

    if (mitigatedAt != null) {
      const proxAbs = (params.confirmationProximityPct / 100) * lastClose;
      const conf = obs.find(
        (o) =>
          o.direction === dir &&
          o.originTime > mitigatedAt! &&
          ((o.obLow <= hi && o.obHigh >= lo) || // solapa la banda
            Math.min(Math.abs(o.obHigh - lo), Math.abs(o.obLow - hi)) <= proxAbs), // o está cerca
      );
      if (conf) {
        state = 'ARMED';
        armedAtTime = conf.confirmedAtTime;
        confirmationObId = conf.id;
      }
    }

    const edgeDist = lastClose < lo ? lo - lastClose : lastClose > hi ? lastClose - hi : 0;
    out.push({
      id: `setup_${symbol}_${tf}_${dir === 'bullish' ? 'u' : 'd'}_${Math.round(lo * 100)}`,
      symbol,
      tf,
      direction: dir,
      state,
      priceLow: lo,
      priceHigh: hi,
      timeStart: z.timeStart,
      confluenceId: z.id,
      rating: z.rating,
      score: z.score,
      mitigatedAtTime: mitigatedAt,
      armedAtTime,
      confirmationObId,
      distancePct: Math.round((edgeDist / lastClose) * 10000) / 100,
    });
  }
  return out;
}
