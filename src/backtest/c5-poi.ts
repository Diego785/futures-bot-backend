// Ciclo 5 — POI 4H (docs/CYCLE-5-PREREG.md §1). C5.2. Núcleo PURO (sin Nest/DB).
//
// Order block ESTRUCTURAL 4H causal, con la definición SIMPLE del prereg (deliberadamente más
// simple que ob.detector — sin filtro de fuerza, que el prereg no declara; acá el OB es CONTEXTO
// que califica pools, no zona de entrada):
//   · swing 4H (lookback 10) roto por CUERPO (cierre más allá del último swing confirmado) = BOS;
//   · la última vela CONTRARIA antes del impulso que rompe = OB (zona [low, high], con mechas);
//   · vigente hasta ser mitigado por CIERRE 4H dentro de la zona.
//
// Causalidad (NO-REPAINT-RULES): el OB se CONOCE en el closeTime (?? openTime) de la vela 4H del
// BOS; muere en el closeTime del primer cierre 4H que alcanza la zona. Un consumidor 15m en t solo
// puede usar POIs con confirmedAtTime ≤ t y (sin mitigar o mitigatedAtTime > t) — `poisVigentesAt`.
//
// Decisiones de implementación (documentadas, no tuneables):
//   · "Mitigado por cierre dentro de la zona" se implementa como cierre que ALCANZA la zona o la
//     atraviesa (demand: close ≤ high · supply: close ≥ low). La lectura literal (low ≤ close ≤
//     high) dejaría vigente para siempre un OB que un cierre atravesó de un salto sin cerrar
//     dentro — una zona claramente rota no puede seguir calificando pools.
//   · La vela contraria del origen se busca hacia atrás SIN tope (la primera contraria antes del
//     impulso); un tope habría metido un parámetro fuera del grid congelado del §2.
//   · Mismo dedup que el detector estructural del repo: cada swing roto produce UN solo OB.

import { detectSwings, type ObCandle, type Swing } from '../bot-analysis/ob.detector';
import { C5_PARAMS } from './c5-pool-detector';

export type C5PoiCandle = ObCandle & { closeTime?: number };

// demand = OB alcista (contexto de LONGs) · supply = OB bajista (contexto de SHORTs).
export type C5PoiSide = 'demand' | 'supply';

export interface C5Poi {
  side: C5PoiSide;
  low: number;
  high: number;
  originTime: number; // openTime de la vela OB (dónde nació visualmente)
  confirmedAtTime: number; // CONOCIDO desde aquí: closeTime (?? openTime) de la vela 4H del BOS
  mitigatedAtTime: number | null; // MUERTO desde aquí: closeTime del primer cierre 4H que alcanza la zona
}

/**
 * Detecta los OB estructurales 4H de una serie de velas CERRADAS (ascendente). Causal: cada OB
 * lleva su ventana de vida [confirmedAtTime, mitigatedAtTime) — el consumidor filtra por tiempo.
 */
export function detectC5Pois(
  candles: C5PoiCandle[],
  swingLookback: number = C5_PARAMS.swingLookback4h,
): C5Poi[] {
  const swings = detectSwings(candles, swingLookback);
  const highs = swings.filter((s) => s.kind === 'high');
  const lows = swings.filter((s) => s.kind === 'low');

  // Último swing CONFIRMADO antes de la vela b (confirmado ⟺ index ≤ b − lookback). arr asc.
  const lastConfirmed = (arr: Swing[], b: number): Swing | null => {
    let res: Swing | null = null;
    for (const s of arr) {
      if (s.index <= b - swingLookback) res = s;
      else break;
    }
    return res;
  };

  const out: C5Poi[] = [];
  let prevBrokenHigh = -1;
  let prevBrokenLow = -1;
  for (let b = 0; b < candles.length; b++) {
    const c = candles[b];
    const lastHigh = lastConfirmed(highs, b);
    if (lastHigh && c.close > lastHigh.price && lastHigh.index !== prevBrokenHigh) {
      prevBrokenHigh = lastHigh.index; // BOS alcista → OB de demanda
      const poi = buildPoi(candles, b, 'demand');
      if (poi) out.push(poi);
    }
    const lastLow = lastConfirmed(lows, b);
    if (lastLow && c.close < lastLow.price && lastLow.index !== prevBrokenLow) {
      prevBrokenLow = lastLow.index; // BOS bajista → OB de oferta
      const poi = buildPoi(candles, b, 'supply');
      if (poi) out.push(poi);
    }
  }
  return out;
}

// Construye el OB del BOS en breakIdx: última vela contraria hacia atrás + línea de vida causal.
function buildPoi(candles: C5PoiCandle[], breakIdx: number, side: C5PoiSide): C5Poi | null {
  // demand (BOS alcista) → última vela BAJISTA del origen; supply (BOS bajista) → última ALCISTA.
  const wantBearish = side === 'demand';
  let obIdx = -1;
  for (let j = breakIdx - 1; j >= 0; j--) {
    const isBear = candles[j].close < candles[j].open;
    const isBull = candles[j].close > candles[j].open;
    if (wantBearish ? isBear : isBull) {
      obIdx = j;
      break;
    }
  }
  if (obIdx < 0) return null;
  const o = candles[obIdx];
  const confirm = candles[breakIdx];

  // Mitigación: primer cierre 4H POSTERIOR al BOS que alcanza la zona (o la atraviesa).
  let mitigatedAtTime: number | null = null;
  for (let j = breakIdx + 1; j < candles.length; j++) {
    const cl = candles[j].close;
    const hit = side === 'demand' ? cl <= o.high : cl >= o.low;
    if (hit) {
      mitigatedAtTime = candles[j].closeTime ?? candles[j].openTime;
      break;
    }
  }

  return {
    side,
    low: o.low,
    high: o.high,
    originTime: o.openTime,
    confirmedAtTime: confirm.closeTime ?? confirm.openTime,
    mitigatedAtTime,
  };
}

/** POIs vigentes en `t` (causal): confirmados en/antes de t y aún no mitigados en t. */
export function poisVigentesAt(pois: C5Poi[], t: number): C5Poi[] {
  return pois.filter((p) => p.confirmedAtTime <= t && (p.mitigatedAtTime == null || p.mitigatedAtTime > t));
}

/**
 * ¿El nivel L de un pool está DENTRO de algún POI vigente del lado correcto en `t`?
 * β = 0 (prereg §2): contener estricto — low ≤ L ≤ high (el margen queda escrito por trazabilidad).
 */
export function poolInsideVigentePoi(pois: C5Poi[], side: C5PoiSide, level: number, t: number): boolean {
  const beta = C5_PARAMS.poiBetaFrac * level;
  for (const p of pois) {
    if (p.side !== side) continue;
    if (p.confirmedAtTime > t) continue;
    if (p.mitigatedAtTime != null && p.mitigatedAtTime <= t) continue;
    if (level >= p.low - beta && level <= p.high + beta) return true;
  }
  return false;
}

/**
 * Borde CERCANO del POI 4H OPUESTO más cercano VIGENTE en `t`, más allá de `fromPrice` en la
 * dirección del trade (runner variante ii del prereg §1). SHORT → demanda debajo (borde = high);
 * LONG → oferta arriba (borde = low). null si no existe (el motor cae al 2R, pre-registrado).
 */
export function nearestOppositePoiEdge(
  pois: C5Poi[],
  direction: 'LONG' | 'SHORT',
  fromPrice: number,
  t: number,
): number | null {
  const wantSide: C5PoiSide = direction === 'LONG' ? 'supply' : 'demand';
  let best: number | null = null;
  for (const p of pois) {
    if (p.side !== wantSide) continue;
    if (p.confirmedAtTime > t) continue;
    if (p.mitigatedAtTime != null && p.mitigatedAtTime <= t) continue;
    const edge = direction === 'LONG' ? p.low : p.high; // el borde que el precio toca primero
    const beyond = direction === 'LONG' ? edge > fromPrice : edge < fromPrice;
    if (!beyond) continue;
    if (best == null || Math.abs(edge - fromPrice) < Math.abs(best - fromPrice)) best = edge;
  }
  return best;
}
