// Detector StrictFVG — lectura AUTOMÁTICA del bot (Fase 5A). Función pura, testeable sin DB.
// NO es señal: es una capa visual/comparativa. El motor SMC y las entradas vienen después.
//
// FVG clásico de 3 velas (imbalance estricto):
//  - alcista: high(c1) < low(c3)  → gap [high(c1), low(c3)]  (precio "saltó" hacia arriba)
//  - bajista: low(c1)  > high(c3) → gap [high(c3), low(c1)]  (precio "saltó" hacia abajo)
// Causalidad (sin repaint): un FVG queda definido por 3 velas CERRADAS y nunca cambia; su
// estado de mitigación solo evoluciona con velas posteriores (hacia adelante).

export interface FvgCandle {
  openTime: number; // epoch ms UTC
  high: number;
  low: number;
}

export type FvgDirection = 'bullish' | 'bearish';
// open: el precio no volvió al gap · touched: entró <50% · partial: 50–100% · filled: lo cerró.
export type FvgState = 'open' | 'touched' | 'partial' | 'filled';

export interface StrictFvg {
  id: string;
  symbol: string;
  tf: string;
  direction: FvgDirection;
  candle1Time: number;
  candle2Time: number;
  candle3Time: number;
  gapLow: number;
  gapHigh: number;
  timeStart: number; // = candle1Time
  timeEnd: number; // = candle3Time
  state: FvgState;
  fillRatio: number; // 0..1 (cuánto se mitigó); >=1 = lleno
}

function stateFromRatio(r: number): FvgState {
  if (r <= 0) return 'open';
  if (r < 0.5) return 'touched';
  if (r < 1) return 'partial';
  return 'filled';
}

/**
 * Detecta los StrictFVG de una serie de velas CERRADAS, en orden openTime ascendente.
 * El estado de mitigación se calcula solo con velas posteriores al gap (causal).
 */
export function detectStrictFvgs(symbol: string, tf: string, candles: FvgCandle[]): StrictFvg[] {
  const out: StrictFvg[] = [];
  for (let i = 0; i + 2 < candles.length; i++) {
    const c1 = candles[i];
    const c2 = candles[i + 1];
    const c3 = candles[i + 2];

    let direction: FvgDirection | null = null;
    let gapLow = 0;
    let gapHigh = 0;
    if (c1.high < c3.low) {
      direction = 'bullish';
      gapLow = c1.high;
      gapHigh = c3.low;
    } else if (c1.low > c3.high) {
      direction = 'bearish';
      gapLow = c3.high;
      gapHigh = c1.low;
    }
    if (!direction) continue;

    const size = gapHigh - gapLow; // > 0 por la condición estricta
    let ratio = 0;
    for (let j = i + 3; j < candles.length; j++) {
      const r =
        direction === 'bullish'
          ? (gapHigh - candles[j].low) / size // el precio baja al gap
          : (candles[j].high - gapLow) / size; // el precio sube al gap
      if (r > ratio) ratio = r;
      if (ratio >= 1) break;
    }

    out.push({
      id: `fvg_${symbol}_${tf}_${c1.openTime}_${direction === 'bullish' ? 'u' : 'd'}`,
      symbol,
      tf,
      direction,
      candle1Time: c1.openTime,
      candle2Time: c2.openTime,
      candle3Time: c3.openTime,
      gapLow,
      gapHigh,
      timeStart: c1.openTime,
      timeEnd: c3.openTime,
      state: stateFromRatio(ratio),
      fillRatio: Math.round(Math.max(0, ratio) * 1000) / 1000,
    });
  }
  return out;
}
