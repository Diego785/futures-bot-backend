// Detector de Order Blocks — lectura AUTOMÁTICA del bot (Fase 5B). Función pura, testeable.
// NO es señal: capa visual/comparativa. Sigue la spec §3 (SMC-SPEC-VIDEO-1.md):
//   OB = última vela de color CONTRARIO inmediatamente previa a un Impulse válido (§1).
//   Rango = [low, high] completo (con mechas). Impulse es REQUISITO; romper estructura es
//   factor de CALIDAD, no requisito. Se emite al confirmar el impulso (originTime/confirmedAt),
//   solo con velas CERRADAS (sin repaint). Parámetros, no números mágicos.

export interface ObCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type ObDirection = 'bullish' | 'bearish';
// untouched: precio no volvió · touched: entró · mitigated: alcanzó el extremo distal ·
// invalidated: cerró más allá del distal (la zona falló).
export type ObState = 'untouched' | 'touched' | 'mitigated' | 'invalidated';

export interface ObParams {
  averageWindow: number; // velas para la media reciente de referencia
  strengthRangeMultiplier: number; // rango del impulso ≥ N× media
  strengthBodyMultiplier: number; // cuerpo del impulso ≥ N× media
  closeNearExtremeThreshold: number; // 0..1, cierre cerca del extremo en la dirección
  swingLookback: number; // ventana para evaluar ruptura de estructura (calidad)
}

// Defaults PROVISIONALES (🔴 a calibrar con casos reales; ver spec §1).
export const DEFAULT_OB_PARAMS: ObParams = {
  averageWindow: 20,
  strengthRangeMultiplier: 1.5,
  strengthBodyMultiplier: 1.5,
  closeNearExtremeThreshold: 0.55,
  swingLookback: 10,
};

export interface BotOb {
  id: string;
  symbol: string;
  tf: string;
  direction: ObDirection;
  originTime: number; // vela origen del OB
  confirmedAtTime: number; // vela de impulso que lo confirma
  obLow: number;
  obHigh: number;
  strength: number; // rango del impulso / media reciente (medida de fuerza)
  brokeStructure: boolean; // calidad: el impulso rompió el swing previo
  leftImbalance: boolean; // calidad: dejó un gap de 3 velas (OB, impulso, siguiente)
  state: ObState;
  timeStart: number; // = originTime
  timeEnd: number; // = confirmedAtTime (el front lo proyecta a la derecha)
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Detecta Order Blocks de una serie de velas CERRADAS, en orden openTime ascendente.
 * Estado de mitigación calculado solo con velas POSTERIORES al impulso (causal, sin lookahead).
 */
export function detectOrderBlocks(
  symbol: string,
  tf: string,
  candles: ObCandle[],
  params: ObParams = DEFAULT_OB_PARAMS,
): BotOb[] {
  const { averageWindow, strengthRangeMultiplier, strengthBodyMultiplier, closeNearExtremeThreshold, swingLookback } = params;
  const n = candles.length;
  const out: BotOb[] = [];

  for (let i = averageWindow; i + 1 < n; i++) {
    const ob = candles[i];
    const imp = candles[i + 1];
    const obBull = ob.close > ob.open;
    const obBear = ob.close < ob.open;
    if (!obBull && !obBear) continue; // doji: sin color de vela contraria claro

    // Media reciente (rango/cuerpo) sobre la ventana previa al impulso.
    const windowCandles = candles.slice(i - averageWindow + 1, i + 1);
    const avgRange = avg(windowCandles.map((c) => c.high - c.low));
    const avgBody = avg(windowCandles.map((c) => Math.abs(c.close - c.open)));
    const impRange = imp.high - imp.low;
    const impBody = Math.abs(imp.close - imp.open);
    const strongRange = avgRange > 0 && impRange >= strengthRangeMultiplier * avgRange;
    const strongBody = avgBody > 0 && impBody >= strengthBodyMultiplier * avgBody;

    let direction: ObDirection | null = null;
    if (obBear && imp.close > imp.open && imp.close > ob.high) {
      // OB alcista: última vela bajista antes de un impulso alcista que rompe su máximo.
      const closeNear = impRange > 0 && (imp.close - imp.low) / impRange >= closeNearExtremeThreshold;
      if ((strongRange || strongBody) && closeNear) direction = 'bullish';
    } else if (obBull && imp.close < imp.open && imp.close < ob.low) {
      // OB bajista: última vela alcista antes de un impulso bajista que rompe su mínimo.
      const closeNear = impRange > 0 && (imp.high - imp.close) / impRange >= closeNearExtremeThreshold;
      if ((strongRange || strongBody) && closeNear) direction = 'bearish';
    }
    if (!direction) continue;

    const obLow = ob.low;
    const obHigh = ob.high;

    // Calidad: ruptura de estructura (no requisito).
    const swingFrom = Math.max(0, i - swingLookback);
    const priorHighs = candles.slice(swingFrom, i).map((c) => c.high);
    const priorLows = candles.slice(swingFrom, i).map((c) => c.low);
    const brokeStructure =
      direction === 'bullish'
        ? priorHighs.length > 0 && imp.close > Math.max(...priorHighs)
        : priorLows.length > 0 && imp.close < Math.min(...priorLows);

    // Calidad: ¿dejó imbalance de 3 velas (OB, impulso, siguiente)?
    const next = candles[i + 2];
    const leftImbalance =
      next != null && (direction === 'bullish' ? ob.high < next.low : ob.low > next.high);

    // Mitigación (causal): velas posteriores al impulso.
    let touched = false;
    let mitigated = false;
    let invalidated = false;
    for (let j = i + 2; j < n; j++) {
      const c = candles[j];
      if (direction === 'bullish') {
        if (c.low < obHigh) touched = true;
        if (c.low <= obLow) mitigated = true;
        if (c.close < obLow) { invalidated = true; break; }
      } else {
        if (c.high > obLow) touched = true;
        if (c.high >= obHigh) mitigated = true;
        if (c.close > obHigh) { invalidated = true; break; }
      }
    }
    const state: ObState = invalidated ? 'invalidated' : mitigated ? 'mitigated' : touched ? 'touched' : 'untouched';

    out.push({
      id: `ob_${symbol}_${tf}_${ob.openTime}_${direction === 'bullish' ? 'u' : 'd'}`,
      symbol,
      tf,
      direction,
      originTime: ob.openTime,
      confirmedAtTime: imp.openTime,
      obLow,
      obHigh,
      strength: avgRange > 0 ? Math.round((impRange / avgRange) * 100) / 100 : 0,
      brokeStructure,
      leftImbalance,
      state,
      timeStart: ob.openTime,
      timeEnd: imp.openTime,
    });
  }
  return out;
}
