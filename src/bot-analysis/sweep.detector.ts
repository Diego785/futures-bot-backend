// Detector de SWEEP + RECLAIM (barrido de liquidez con reclamo) — gatillo de mayor edge (modo C de
// SMC-STRATEGY-MECHANICAL.md). Función PURA, causal; pensada para el motor de backtest (Fase C).
//
// Idea (Video 3): el precio BARRE la liquidez bajo un mínimo (o sobre un máximo) con una MECHA —
// toma los stops — pero el CUERPO cierra de vuelta DENTRO del nivel (reclaim). Eso NO es ruptura
// (si el cuerpo cerrara FUERA sería un BOS); es manipulación + reacción → señal en la dirección del
// reclaim. Es el antídoto del "adverse selection": no entra al toque, espera a que el barrido ocurra.
//
// Causal/no-repaint: solo velas CERRADAS; el swing se "conoce" lookback velas después; el sweep se
// confirma AL CIERRE de la vela que barre y reclama. Cada swing se barre UNA vez (liquidez ya tomada).

import { detectSwings, type Swing, type ObCandle } from './ob.detector';

export type SweepDirection = 'bullish' | 'bearish';

// 'lastSwing' (default, candidato congelado): se barre solo el ÚLTIMO swing confirmado por lado.
// 'pools' (Ciclo 2, CYCLE-2-PREREG §3 Eje 2): se barren POOLS vigentes — equal highs/lows
// (clusters de ≥2 pivotes dentro de tolerancia) + TODOS los swings confirmados no barridos.
export type SweepPoolMode = 'lastSwing' | 'pools';

export interface SweepParams {
  swingLookback: number; // velas a cada lado para el pivote cuya liquidez se barre (= OB structural)
  poolMode?: SweepPoolMode; // default 'lastSwing' (comportamiento del candidato congelado)
  clusterTolerancePct?: number; // 'pools': % para considerar dos pivotes "iguales" (equal highs/lows)
}
export const DEFAULT_SWEEP_PARAMS: SweepParams = {
  swingLookback: 10,
  poolMode: 'lastSwing',
  clusterTolerancePct: 0.1, // fijado por CYCLE-2-PREREG (no es perilla del barrido de combos)
};

export interface SweepEvent {
  id: string;
  symbol: string;
  tf: string;
  // bullish: barrió un swing LOW (mecha por debajo) y reclamó (cierre por encima) → reacción al ALZA.
  // bearish: barrió un swing HIGH (mecha por encima) y reclamó (cierre por debajo) → reacción a la BAJA.
  direction: SweepDirection;
  sweptLevel: number; // precio del swing/pool barrido (la liquidez tomada)
  sweptSwingTime: number; // openTime de la vela del swing barrido (en pools: el ÚLTIMO pivote del pool)
  sweepBarTime: number; // openTime de la vela que barrió + reclamó (la señal se conoce a su CIERRE)
  wickExtreme: number; // low (bullish) / high (bearish) de la vela del sweep → referencia para el SL
  reclaimClose: number; // cierre de la vela del sweep
  penetration: number; // cuánto penetró la mecha más allá del nivel (>0)
  poolType?: 'equal' | 'swing'; // solo modo 'pools': equal highs/lows (≥2 toques) o swing suelto
  touches?: number; // solo modo 'pools': pivotes que formaron el pool
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Detecta sweeps de liquidez con reclamo. Causal (sin lookahead/repaint). Dos modos:
 * 'lastSwing' (default, candidato congelado): solo el swing confirmado más reciente por lado.
 * 'pools' (Ciclo 2): pools vigentes — equal highs/lows + todos los swings no barridos.
 */
export function detectSweeps(
  symbol: string,
  tf: string,
  candles: ObCandle[],
  params: Partial<SweepParams> = {},
): SweepEvent[] {
  const p: SweepParams = { ...DEFAULT_SWEEP_PARAMS, ...params };
  return p.poolMode === 'pools'
    ? detectByPools(symbol, tf, candles, p)
    : detectByLastSwing(symbol, tf, candles, p);
}

// ───────────────────── modo 'lastSwing' (candidato congelado, sin cambios) ─────────────────────
function detectByLastSwing(
  symbol: string,
  tf: string,
  candles: ObCandle[],
  p: SweepParams,
): SweepEvent[] {
  const lookback = p.swingLookback;
  const swings = detectSwings(candles, lookback);
  const lows = swings.filter((s) => s.kind === 'low');
  const highs = swings.filter((s) => s.kind === 'high');
  const out: SweepEvent[] = [];
  let prevSweptLow = -1;
  let prevSweptHigh = -1;

  // Último swing CONFIRMADO antes de la vela b (confirmado ⟺ index ≤ b - lookback). arr asc por index.
  const lastConfirmed = (arr: Swing[], b: number): Swing | null => {
    let res: Swing | null = null;
    for (const s of arr) {
      if (s.index <= b - lookback) res = s;
      else break;
    }
    return res;
  };

  for (let b = 0; b < candles.length; b++) {
    const c = candles[b];

    // Sweep alcista: la mecha perfora el swing low (c.low < nivel) pero el cuerpo reclama (c.close > nivel).
    const lastLow = lastConfirmed(lows, b);
    if (lastLow && lastLow.index !== prevSweptLow && c.low < lastLow.price && c.close > lastLow.price) {
      prevSweptLow = lastLow.index;
      out.push({
        id: `sweep_${symbol}_${tf}_${c.openTime}_u`,
        symbol,
        tf,
        direction: 'bullish',
        sweptLevel: lastLow.price,
        sweptSwingTime: candles[lastLow.index].openTime,
        sweepBarTime: c.openTime,
        wickExtreme: c.low,
        reclaimClose: c.close,
        penetration: round2(lastLow.price - c.low),
      });
    }

    // Sweep bajista: la mecha perfora el swing high (c.high > nivel) pero el cuerpo reclama (c.close < nivel).
    const lastHigh = lastConfirmed(highs, b);
    if (lastHigh && lastHigh.index !== prevSweptHigh && c.high > lastHigh.price && c.close < lastHigh.price) {
      prevSweptHigh = lastHigh.index;
      out.push({
        id: `sweep_${symbol}_${tf}_${c.openTime}_d`,
        symbol,
        tf,
        direction: 'bearish',
        sweptLevel: lastHigh.price,
        sweptSwingTime: candles[lastHigh.index].openTime,
        sweepBarTime: c.openTime,
        wickExtreme: c.high,
        reclaimClose: c.close,
        penetration: round2(c.high - lastHigh.price),
      });
    }
  }
  return out;
}

// ───────────────────── modo 'pools' (Ciclo 2 — CYCLE-2-PREREG §3 Eje 2) ─────────────────────

// Pool de liquidez VIVO: nivel igualado (equal, ≥2 pivotes dentro de tolerancia) o swing suelto.
interface LiquidityPool {
  level: number; // extremo del cluster (low: el mínimo · high: el máximo)
  touches: number;
  lastPivotTime: number; // openTime del último pivote que lo formó (el porqué causal)
}

/**
 * Barre POOLS vigentes, no solo el último swing. Causal: un pivote solo existe para el detector
 * desde su vela de confirmación (index + lookback); por la definición estricta del pivote, la vela
 * que lo confirma no puede cruzar su nivel (sin lookahead). Reglas fijadas pre-corrida:
 *  - El pool MUERE cuando una mecha cruza su nivel (la liquidez fue tomada), reclame o no.
 *  - Señal solo si además el CUERPO cerró de vuelta (reclaim).
 *  - Si una vela barre y reclama VARIOS pools del mismo lado, se emite UNO: el MÁS PROFUNDO.
 */
function detectByPools(
  symbol: string,
  tf: string,
  candles: ObCandle[],
  p: SweepParams,
): SweepEvent[] {
  const lookback = p.swingLookback;
  const tol = (p.clusterTolerancePct ?? 0.1) / 100;
  const swings = detectSwings(candles, lookback);

  // Pivotes agrupados por su vela de CONFIRMACIÓN (solo ahí entran al universo de pools).
  const byConfirmIdx = new Map<number, Swing[]>();
  for (const s of swings) {
    const ci = s.index + lookback;
    const arr = byConfirmIdx.get(ci);
    if (arr) arr.push(s);
    else byConfirmIdx.set(ci, [s]);
  }

  const lows: LiquidityPool[] = []; // pools VIVOS (los muertos se remueven — perf en históricos largos)
  const highs: LiquidityPool[] = [];
  const out: SweepEvent[] = [];
  const removeAt = (arr: LiquidityPool[], i: number) => {
    arr[i] = arr[arr.length - 1];
    arr.pop();
  };

  for (let b = 0; b < candles.length; b++) {
    // 1) Integrar pivotes que se CONFIRMAN en esta vela: merge al pool más cercano dentro de
    //    tolerancia (equal highs/lows) o pool nuevo (swing suelto).
    const confirmed = byConfirmIdx.get(b);
    if (confirmed) {
      for (const s of confirmed) {
        const arr = s.kind === 'low' ? lows : highs;
        let best = -1;
        let bestDist = Infinity;
        for (let i = 0; i < arr.length; i++) {
          const dist = Math.abs(arr[i].level - s.price) / arr[i].level;
          if (dist <= tol && dist < bestDist) {
            best = i;
            bestDist = dist;
          }
        }
        if (best >= 0) {
          const pool = arr[best];
          pool.level = s.kind === 'low' ? Math.min(pool.level, s.price) : Math.max(pool.level, s.price);
          pool.touches++;
          pool.lastPivotTime = candles[s.index].openTime;
        } else {
          arr.push({ level: s.price, touches: 1, lastPivotTime: candles[s.index].openTime });
        }
      }
    }

    // 2) Barridas de esta vela. Cruce de mecha = pool muerto; reclaim = candidato a señal;
    //    entre los reclamados del mismo lado gana el MÁS PROFUNDO.
    const c = candles[b];
    let sweptLow: LiquidityPool | null = null;
    for (let i = lows.length - 1; i >= 0; i--) {
      const pool = lows[i];
      if (c.low < pool.level) {
        removeAt(lows, i);
        if (c.close > pool.level && (sweptLow == null || pool.level < sweptLow.level)) sweptLow = pool;
      }
    }
    let sweptHigh: LiquidityPool | null = null;
    for (let i = highs.length - 1; i >= 0; i--) {
      const pool = highs[i];
      if (c.high > pool.level) {
        removeAt(highs, i);
        if (c.close < pool.level && (sweptHigh == null || pool.level > sweptHigh.level)) sweptHigh = pool;
      }
    }

    if (sweptLow) {
      out.push({
        id: `sweep_${symbol}_${tf}_${c.openTime}_u`,
        symbol,
        tf,
        direction: 'bullish',
        sweptLevel: sweptLow.level,
        sweptSwingTime: sweptLow.lastPivotTime,
        sweepBarTime: c.openTime,
        wickExtreme: c.low,
        reclaimClose: c.close,
        penetration: round2(sweptLow.level - c.low),
        poolType: sweptLow.touches >= 2 ? 'equal' : 'swing',
        touches: sweptLow.touches,
      });
    }
    if (sweptHigh) {
      out.push({
        id: `sweep_${symbol}_${tf}_${c.openTime}_d`,
        symbol,
        tf,
        direction: 'bearish',
        sweptLevel: sweptHigh.level,
        sweptSwingTime: sweptHigh.lastPivotTime,
        sweepBarTime: c.openTime,
        wickExtreme: c.high,
        reclaimClose: c.close,
        penetration: round2(c.high - sweptHigh.level),
        poolType: sweptHigh.touches >= 2 ? 'equal' : 'swing',
        touches: sweptHigh.touches,
      });
    }
  }
  return out;
}
