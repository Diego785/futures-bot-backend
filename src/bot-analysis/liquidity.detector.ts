// Detector de Liquidez — lectura AUTOMÁTICA del bot (Fase 5C). Función pura, testeable.
// NO es señal ni entrada: capa visual/comparativa. Spec §6.
// Prioriza CALIDAD sobre cantidad: equal highs/lows (fuertes) + swings sueltos selectivos,
// por defecto SOLO no barridos, con tope de niveles. Parámetros, no números mágicos.

export interface LiqCandle {
  openTime: number;
  high: number;
  low: number;
  close: number;
}

export type LiqType = 'equalHigh' | 'equalLow' | 'swingHigh' | 'swingLow';
export type LiqSide = 'buyside' | 'sellside'; // highs = liquidez arriba (buyside); lows = abajo (sellside)

export interface LiqParams {
  swingLookback: number; // velas a cada lado para confirmar un pivote
  clusterTolerancePct: number; // % para considerar dos pivotes "iguales"
  minTouchesForEqualLiquidity: number; // toques mínimos para equalHigh/equalLow
  maxDistanceFromPricePct: number | null; // filtra niveles lejanos al precio actual (null = sin filtro)
  showSweptLiquidity: boolean; // incluir niveles ya barridos
  maxLevels: number; // tope de niveles devueltos (anti-ruido)
}

// Defaults PROVISIONALES (🔴 a calibrar; ver spec §6).
export const DEFAULT_LIQ_PARAMS: LiqParams = {
  swingLookback: 8,
  clusterTolerancePct: 0.1,
  minTouchesForEqualLiquidity: 2,
  maxDistanceFromPricePct: null,
  showSweptLiquidity: false,
  maxLevels: 12,
};

export interface BotLiquidity {
  id: string;
  symbol: string;
  tf: string;
  type: LiqType;
  side: LiqSide;
  level: number;
  candleTimes: number[]; // pivotes que la forman
  touches: number;
  swept: boolean;
  sweptAtTime: number | null;
  distancePct: number; // |nivel − precio actual| en %
  timeStart: number; // pivote más antiguo (origen del nivel para el render)
}

interface Pivot {
  index: number;
  price: number;
  time: number;
}

// Pivote estricto: extremo local mayor/menor que TODOS los vecinos en ±lookback.
function findPivots(candles: LiqCandle[], lookback: number, kind: 'high' | 'low'): Pivot[] {
  const out: Pivot[] = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const v = kind === 'high' ? candles[i].high : candles[i].low;
    let isPivot = true;
    for (let j = i - lookback; j <= i + lookback && isPivot; j++) {
      if (j === i) continue;
      const w = kind === 'high' ? candles[j].high : candles[j].low;
      if (kind === 'high' ? w >= v : w <= v) isPivot = false;
    }
    if (isPivot) out.push({ index: i, price: v, time: candles[i].openTime });
  }
  return out;
}

// Agrupa pivotes por cercanía de precio (clusters dentro de tolerancePct).
function cluster(pivots: Pivot[], tolerancePct: number): Pivot[][] {
  const sorted = [...pivots].sort((a, b) => a.price - b.price);
  const groups: Pivot[][] = [];
  for (const p of sorted) {
    const g = groups[groups.length - 1];
    const anchor = g ? g[0].price : null;
    if (anchor != null && (Math.abs(p.price - anchor) / anchor) * 100 <= tolerancePct) {
      g.push(p);
    } else {
      groups.push([p]);
    }
  }
  return groups;
}

/**
 * Detecta niveles de liquidez de una serie de velas CERRADAS (orden ascendente). El barrido
 * se evalúa solo con velas posteriores al pivote más reciente del nivel (causal, sin lookahead).
 */
export function detectLiquidity(
  symbol: string,
  tf: string,
  candles: LiqCandle[],
  params: LiqParams = DEFAULT_LIQ_PARAMS,
): BotLiquidity[] {
  const { swingLookback, clusterTolerancePct, minTouchesForEqualLiquidity, maxDistanceFromPricePct, showSweptLiquidity, maxLevels } = params;
  const n = candles.length;
  if (n < swingLookback * 2 + 1) return [];
  const lastClose = candles[n - 1].close;
  const out: BotLiquidity[] = [];

  const build = (group: Pivot[], side: LiqSide): BotLiquidity => {
    const prices = group.map((p) => p.price);
    const level = prices.reduce((a, b) => a + b, 0) / prices.length;
    const times = group.map((p) => p.time).sort((a, b) => a - b);
    const lastPivotTime = times[times.length - 1];
    const touches = group.length;
    const isEqual = touches >= minTouchesForEqualLiquidity;
    const type: LiqType = side === 'buyside' ? (isEqual ? 'equalHigh' : 'swingHigh') : isEqual ? 'equalLow' : 'swingLow';

    // Barrido: ¿alguna vela posterior al último pivote superó el nivel?
    let swept = false;
    let sweptAtTime: number | null = null;
    for (let j = 0; j < n; j++) {
      if (candles[j].openTime <= lastPivotTime) continue;
      const broke = side === 'buyside' ? candles[j].high > level : candles[j].low < level;
      if (broke) { swept = true; sweptAtTime = candles[j].openTime; break; }
    }
    return {
      id: `liq_${symbol}_${tf}_${type}_${Math.round(level * 100)}`,
      symbol, tf, type, side, level, candleTimes: times, touches, swept, sweptAtTime,
      distancePct: Math.round((Math.abs(level - lastClose) / lastClose) * 10000) / 100,
      timeStart: times[0],
    };
  };

  for (const g of cluster(findPivots(candles, swingLookback, 'high'), clusterTolerancePct)) out.push(build(g, 'buyside'));
  for (const g of cluster(findPivots(candles, swingLookback, 'low'), clusterTolerancePct)) out.push(build(g, 'sellside'));

  let levels = out;
  if (!showSweptLiquidity) levels = levels.filter((l) => !l.swept);
  if (maxDistanceFromPricePct != null) levels = levels.filter((l) => l.distancePct <= maxDistanceFromPricePct);

  // Calidad: equal antes que swing; más toques; más cercano al precio. Luego tope (anti-ruido).
  const rank = (l: BotLiquidity) => (l.type === 'equalHigh' || l.type === 'equalLow' ? 0 : 1);
  levels.sort((a, b) => rank(a) - rank(b) || b.touches - a.touches || a.distancePct - b.distancePct);
  return levels.slice(0, maxLevels);
}
