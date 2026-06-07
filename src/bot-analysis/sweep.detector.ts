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

export interface SweepParams {
  swingLookback: number; // velas a cada lado para el pivote cuya liquidez se barre (= OB structural)
}
export const DEFAULT_SWEEP_PARAMS: SweepParams = { swingLookback: 10 };

export interface SweepEvent {
  id: string;
  symbol: string;
  tf: string;
  // bullish: barrió un swing LOW (mecha por debajo) y reclamó (cierre por encima) → reacción al ALZA.
  // bearish: barrió un swing HIGH (mecha por encima) y reclamó (cierre por debajo) → reacción a la BAJA.
  direction: SweepDirection;
  sweptLevel: number; // precio del swing barrido (la liquidez tomada)
  sweptSwingTime: number; // openTime de la vela del swing barrido
  sweepBarTime: number; // openTime de la vela que barrió + reclamó (la señal se conoce a su CIERRE)
  wickExtreme: number; // low (bullish) / high (bearish) de la vela del sweep → referencia para el SL
  reclaimClose: number; // cierre de la vela del sweep
  penetration: number; // cuánto penetró la mecha más allá del nivel (>0)
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Detecta sweeps de liquidez con reclamo sobre swings previos. Causal (sin lookahead/repaint).
 * Considera el swing CONFIRMADO más reciente por lado (la liquidez más cercana) y lo barre una vez.
 */
export function detectSweeps(
  symbol: string,
  tf: string,
  candles: ObCandle[],
  params: Partial<SweepParams> = {},
): SweepEvent[] {
  const p: SweepParams = { ...DEFAULT_SWEEP_PARAMS, ...params };
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
