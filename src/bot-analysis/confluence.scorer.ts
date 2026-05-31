// Scorer de Confluencia — lectura AUTOMÁTICA del bot (Fase 5D). Función pura, testeable.
// NO es señal ni entrada: pondera qué zonas pesan más por combinar varias capas (spec §7).
// Regla anti-ruido: una zona de confluencia EXISTE solo si combina ≥2 TIPOS (OB, FVG, liquidez).
// Eso la hace selectiva por diseño. Todo parametrizable; nada de números mágicos definitivos.

import type { StrictFvg } from './fvg.detector';
import type { BotOb } from './ob.detector';
import type { BotLiquidity } from './liquidity.detector';

export type ConfluenceRating = 'LOW' | 'MEDIUM' | 'HIGH';

export interface ConfluenceParams {
  liquidityProximityPct: number; // liquidez "cercana" si está a ≤ este % del borde de la zona
  wOB: number;
  wFVG: number;
  wLiquidity: number;
  wOverlap: number; // bonus si la zona combina OB y FVG (se solapan por construcción)
  equalLiquidityBonus: number; // multiplicador si la liquidez cercana es equal highs/lows
  mediumThreshold: number;
  highThreshold: number;
  distancePenaltyPct: number; // distancia a la que el factor de cercanía llega al piso
  distanceFloor: number; // factor mínimo por distancia
  maxZones: number; // tope de zonas (anti-ruido)
}

// Defaults PROVISIONALES (🔴 a calibrar; ver spec §7).
export const DEFAULT_CONFLUENCE_PARAMS: ConfluenceParams = {
  liquidityProximityPct: 0.5,
  wOB: 30,
  wFVG: 25,
  wLiquidity: 20,
  wOverlap: 15,
  equalLiquidityBonus: 1.5,
  mediumThreshold: 45,
  highThreshold: 72,
  distancePenaltyPct: 25,
  distanceFloor: 0.6,
  maxZones: 8,
};

export interface ConfluenceZone {
  id: string;
  symbol: string;
  tf: string;
  direction: 'bullish' | 'bearish';
  priceLow: number;
  priceHigh: number;
  timeStart: number;
  score: number; // 0..~100+
  rating: ConfluenceRating;
  hasOB: boolean;
  hasFVG: boolean;
  hasLiquidity: boolean;
  scoreOB: number;
  scoreFVG: number;
  scoreLiquidity: number;
  obStrength: number; // fuerza máx. de los OB de la zona (0 si no hay)
  componentIds: string[]; // ids de OB/FVG/liquidez que la componen
  distancePct: number;
}

interface ZoneEl {
  kind: 'ob' | 'fvg';
  id: string;
  dir: 'bullish' | 'bearish';
  low: number;
  high: number;
  time: number;
  strength: number; // OB: strength; FVG: 0
}

interface Group {
  dir: 'bullish' | 'bearish';
  low: number;
  high: number;
  time: number;
  hasOB: boolean;
  hasFVG: boolean;
  obStrength: number;
  ids: string[];
}

// Fusiona elementos que se solapan en precio, separando por dirección (greedy sobre low).
function mergeByOverlap(els: ZoneEl[]): Group[] {
  const groups: Group[] = [];
  for (const dir of ['bullish', 'bearish'] as const) {
    const sorted = els.filter((e) => e.dir === dir).sort((a, b) => a.low - b.low);
    let g: Group | null = null;
    for (const e of sorted) {
      if (g && e.low <= g.high) {
        g.high = Math.max(g.high, e.high);
        g.low = Math.min(g.low, e.low);
        g.time = Math.min(g.time, e.time);
        g.hasOB = g.hasOB || e.kind === 'ob';
        g.hasFVG = g.hasFVG || e.kind === 'fvg';
        g.obStrength = Math.max(g.obStrength, e.strength);
        g.ids.push(e.id);
      } else {
        g = { dir, low: e.low, high: e.high, time: e.time, hasOB: e.kind === 'ob', hasFVG: e.kind === 'fvg', obStrength: e.strength, ids: [e.id] };
        groups.push(g);
      }
    }
  }
  return groups;
}

/**
 * Puntúa zonas de confluencia combinando OB + FVG + liquidez (todo activo). Determinista.
 * No mira velas en formación (recibe detecciones ya causales). lastClose = precio de referencia.
 */
export function scoreConfluence(
  symbol: string,
  tf: string,
  fvgs: StrictFvg[],
  obs: BotOb[],
  liqs: BotLiquidity[],
  lastClose: number,
  params: ConfluenceParams = DEFAULT_CONFLUENCE_PARAMS,
): ConfluenceZone[] {
  const p = params;
  const els: ZoneEl[] = [];
  for (const o of obs) {
    if (o.state === 'mitigated' || o.state === 'invalidated') continue;
    els.push({ kind: 'ob', id: o.id, dir: o.direction, low: o.obLow, high: o.obHigh, time: o.timeStart, strength: o.strength });
  }
  for (const f of fvgs) {
    if (f.state === 'filled') continue;
    els.push({ kind: 'fvg', id: f.id, dir: f.direction, low: f.gapLow, high: f.gapHigh, time: f.timeStart, strength: 0 });
  }

  const out: ConfluenceZone[] = [];
  for (const g of mergeByOverlap(els)) {
    // Liquidez cercana al borde de la zona.
    const nearLiqs = liqs.filter((l) => {
      const dist = l.level < g.low ? g.low - l.level : l.level > g.high ? l.level - g.high : 0;
      return dist <= (p.liquidityProximityPct / 100) * l.level;
    });
    const hasLiquidity = nearLiqs.length > 0;
    const hasEqualLiq = nearLiqs.some((l) => l.type === 'equalHigh' || l.type === 'equalLow');
    const typesCount = (g.hasOB ? 1 : 0) + (g.hasFVG ? 1 : 0) + (hasLiquidity ? 1 : 0);
    if (typesCount < 2) continue; // sin confluencia (≥2 tipos)

    const scoreOB = g.hasOB ? p.wOB : 0;
    const scoreFVG = g.hasFVG ? p.wFVG : 0;
    const scoreLiquidity = hasLiquidity ? p.wLiquidity * (hasEqualLiq ? p.equalLiquidityBonus : 1) : 0;
    const overlap = g.hasOB && g.hasFVG ? p.wOverlap : 0;

    const edgeDist = lastClose < g.low ? g.low - lastClose : lastClose > g.high ? lastClose - g.high : 0;
    const distancePct = Math.round((edgeDist / lastClose) * 10000) / 100;
    const distFactor = Math.max(p.distanceFloor, 1 - distancePct / p.distancePenaltyPct);
    const score = Math.round((scoreOB + scoreFVG + scoreLiquidity + overlap) * distFactor);
    const rating: ConfluenceRating = score >= p.highThreshold ? 'HIGH' : score >= p.mediumThreshold ? 'MEDIUM' : 'LOW';

    out.push({
      id: `conf_${symbol}_${tf}_${g.dir === 'bullish' ? 'u' : 'd'}_${Math.round(g.low * 100)}`,
      symbol, tf, direction: g.dir, priceLow: g.low, priceHigh: g.high, timeStart: g.time,
      score, rating,
      hasOB: g.hasOB, hasFVG: g.hasFVG, hasLiquidity,
      scoreOB, scoreFVG, scoreLiquidity: Math.round(scoreLiquidity),
      obStrength: g.obStrength,
      componentIds: [...g.ids, ...nearLiqs.map((l) => l.id)],
      distancePct,
    });
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, p.maxZones);
}
