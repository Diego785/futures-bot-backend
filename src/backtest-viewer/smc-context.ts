// Contexto SMC causal para el replay/paper (compartido): OBs con su LÍNEA DE TIEMPO de estados y
// niveles de liquidez con su barrido, re-derivados de velas CERRADAS. Función PURA (recibe las
// velas ya cargadas) — la usan el visor de backtests y la pestaña Paper. Read-only (Regla Cero).

import { detectOrderBlocks, computeStateTimeline, type ObCandle } from '../bot-analysis/ob.detector';
import { detectLiquidity, DEFAULT_LIQ_PARAMS } from '../bot-analysis/liquidity.detector';

export interface SmcContextOb {
  id: string;
  direction: 'bullish' | 'bearish';
  originTime: number;
  confirmedAtTime: number;
  obLow: number;
  obHigh: number;
  touchedAt: number | null;
  mitigatedAt: number | null;
  invalidatedAt: number | null;
}

export interface SmcContextLiquidity {
  id: string;
  type: string;
  side: 'buyside' | 'sellside';
  level: number;
  timeStart: number;
  lastPivotTime: number;
  visibleFromTime: number | null;
  sweptAtTime: number | null;
}

export interface SmcContext {
  obs: SmcContextOb[];
  liquidity: SmcContextLiquidity[];
}

/**
 * Deriva el contexto SMC visible en [from, to] desde velas cerradas (con warmup previo incluido
 * en `closed`). Cada objeto lleva sus tiempos causales: el frontend solo dibuja lo conocido en
 * el cursor.
 */
export function buildSmcContext(
  symbol: string,
  tf: string,
  closed: ObCandle[],
  swingLookback: number,
  from: number,
  to: number,
): SmcContext {
  const idxOfTime = new Map<number, number>();
  closed.forEach((c, i) => idxOfTime.set(c.openTime, i));

  const obs = detectOrderBlocks(symbol, tf, closed, {
    swingLookback,
    showLastBullish: Number.MAX_SAFE_INTEGER,
    showLastBearish: Number.MAX_SAFE_INTEGER,
  })
    .filter((o) => o.confirmedAtTime <= to)
    .map((o) => {
      const ci = idxOfTime.get(o.confirmedAtTime);
      const tl = computeStateTimeline(closed, (ci ?? closed.length) + 1, o.direction, o.obLow, o.obHigh);
      return {
        id: o.id,
        direction: o.direction,
        originTime: o.originTime,
        confirmedAtTime: o.confirmedAtTime,
        obLow: o.obLow,
        obHigh: o.obHigh,
        ...tl,
      };
    })
    .filter((o) => o.invalidatedAt == null || o.invalidatedAt >= from);

  const liquidity = detectLiquidity(symbol, tf, closed, {
    ...DEFAULT_LIQ_PARAMS,
    swingLookback,
    showSweptLiquidity: true,
    maxDistanceFromPricePct: null,
    maxLevels: Number.MAX_SAFE_INTEGER,
  })
    .map((l) => {
      const lastPivotTime = l.candleTimes[l.candleTimes.length - 1];
      const li = idxOfTime.get(lastPivotTime);
      const confIdx = li != null ? li + swingLookback : -1;
      const visibleFromTime = confIdx >= 0 && confIdx < closed.length ? closed[confIdx].openTime : null;
      return {
        id: l.id,
        type: l.type,
        side: l.side,
        level: l.level,
        timeStart: l.timeStart,
        lastPivotTime,
        visibleFromTime,
        sweptAtTime: l.sweptAtTime,
      };
    })
    .filter(
      (l) =>
        l.visibleFromTime != null &&
        l.visibleFromTime <= to &&
        (l.sweptAtTime == null || l.sweptAtTime >= from),
    );

  return { obs, liquidity };
}
