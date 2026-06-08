// Sesgo estructural HTF (multi-TF) para el backtest. Fase F+ (revisión de la mecanización).
//
// Doc SMC-STRATEGY-MECHANICAL Capa 1: el sesgo lo define el BOS (cierre de CUERPO sobre el último
// swing confirmado) en el TF alto. Sesgo alcista → solo demanda (LONG); bajista → solo oferta (SHORT).
// Sirve para FILTRAR los gatillos LTF: un sweep alcista en plena tendencia HTF bajista es ruido.
//
// Causal (no-repaint): el sesgo cambia solo cuando una vela HTF CIERRA rompiendo estructura; queda
// "conocido" en su closeTime. Una señal LTF en T usa el sesgo del último cierre HTF ≤ T (sin lookahead).

import { detectSwings, type Swing, type ObCandle } from '../bot-analysis/ob.detector';

export type Bias = 'bullish' | 'bearish' | 'neutral';

// Cambio de sesgo: `bias` rige a partir de `time` (closeTime de la vela HTF del BOS).
export interface BiasPoint {
  time: number;
  bias: Bias;
}

type BiasCandle = ObCandle & { closeTime?: number };

/**
 * Serie de cambios de sesgo HTF a partir de velas CERRADAS (ascendente). Mismo motor swing/BOS que
 * `ob.detector` (pivotes estrictos `swingLookback`, BOS por cierre de cuerpo). Devuelve solo los
 * puntos donde el sesgo CAMBIA (función escalón); entre ellos, el sesgo se mantiene.
 */
export function computeHtfBias(candles: BiasCandle[], swingLookback = 10): BiasPoint[] {
  const swings = detectSwings(candles, swingLookback);
  const highs = swings.filter((s) => s.kind === 'high');
  const lows = swings.filter((s) => s.kind === 'low');

  // Último swing CONFIRMADO antes de la vela b (confirmado ⟺ index ≤ b − lookback). arr asc por index.
  const lastConfirmed = (arr: Swing[], b: number): Swing | null => {
    let res: Swing | null = null;
    for (const s of arr) {
      if (s.index <= b - swingLookback) res = s;
      else break;
    }
    return res;
  };

  const out: BiasPoint[] = [];
  let bias: Bias = 'neutral';
  let prevBrokenHigh = -1;
  let prevBrokenLow = -1;

  for (let b = 0; b < candles.length; b++) {
    const c = candles[b];
    const t = c.closeTime ?? c.openTime;
    const lastHigh = lastConfirmed(highs, b);
    if (lastHigh && c.close > lastHigh.price && lastHigh.index !== prevBrokenHigh) {
      prevBrokenHigh = lastHigh.index; // BOS alcista (cierre sobre el swing high)
      if (bias !== 'bullish') {
        bias = 'bullish';
        out.push({ time: t, bias });
      }
    }
    const lastLow = lastConfirmed(lows, b);
    if (lastLow && c.close < lastLow.price && lastLow.index !== prevBrokenLow) {
      prevBrokenLow = lastLow.index; // BOS bajista (cierre bajo el swing low)
      if (bias !== 'bearish') {
        bias = 'bearish';
        out.push({ time: t, bias });
      }
    }
  }
  return out;
}

/** Sesgo vigente en `time`: el del último cambio con time ≤ el dado (causal). 'neutral' si no hay. */
export function biasAt(series: BiasPoint[], time: number): Bias {
  let res: Bias = 'neutral';
  for (const p of series) {
    if (p.time <= time) res = p.bias;
    else break; // serie ascendente por time
  }
  return res;
}
