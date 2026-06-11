// Detector de Order Blocks — lectura AUTOMÁTICA del bot. Función pura, testeable.
// ESENCIA (revisado 2026-06-02, ver SMC-SPEC-VIDEO-1 §3): el OB se ancla a la ESTRUCTURA
// (swing/BOS), no al impulso aislado. "Primero la estructura, después el OB"; la FUERZA confirma.
//   obMode 'structural' (DEFAULT): el OB nace cuando el precio ROMPE un swing previo (BOS) en el
//     sentido de la estructura; es la ÚLTIMA vela contraria del origen, con mechas; confirmado por
//     fuerza (si no hay fuerza = "equipara" → se descarta). Se muestran POCOS (showLast por lado).
//   obMode 'impulse' (opcional, lente anterior): última vela contraria antes de un impulso fuerte.
// Solo velas CERRADAS, causal (sin lookahead/repaint). Parámetros, no números mágicos. 🔴 a calibrar.

export interface ObCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type ObDirection = 'bullish' | 'bearish';
// untouched: precio no volvió · touched: entró · mitigated: alcanzó el extremo distal ·
// invalidated: cerró más allá del distal (la zona falló → candidata a Breaker Block, ver Video 3).
export type ObState = 'untouched' | 'touched' | 'mitigated' | 'invalidated';
export type ObMode = 'structural' | 'impulse';

export interface ObParams {
  averageWindow: number; // velas para la media reciente de referencia (fuerza)
  strengthRangeMultiplier: number; // rango del impulso ≥ N× media
  strengthBodyMultiplier: number; // cuerpo del impulso ≥ N× media
  closeNearExtremeThreshold: number; // 0..1, cierre cerca del extremo (solo modo impulse)
  swingLookback: number; // velas a cada lado para detectar un swing/pivote (= "Swing Lookback")
  obMode?: ObMode; // structural (default) | impulse
  showLastBullish?: number; // structural: nº de OB alcistas recientes a devolver
  showLastBearish?: number; // structural: nº de OB bajistas recientes a devolver
  useCandleBody?: boolean; // rango por CUERPO en vez de mechas ("Use Candle Body" de LuxAlgo)
  maxLegBars?: number; // structural: máx. velas hacia atrás para hallar la vela OB del origen
}

// Defaults PROVISIONALES (🔴 a calibrar). Calibrados a "Order Blocks & Breaker Blocks [LuxAlgo]".
export const DEFAULT_OB_PARAMS: ObParams = {
  averageWindow: 20,
  strengthRangeMultiplier: 1.5,
  strengthBodyMultiplier: 1.5,
  closeNearExtremeThreshold: 0.55,
  swingLookback: 10, // = "Swing Lookback" de LuxAlgo
  obMode: 'structural',
  showLastBullish: 3, // = "Show Last Bullish OB"
  showLastBearish: 3, // = "Show Last Bearish OB"
  useCandleBody: false,
  maxLegBars: 10,
};

export interface BotOb {
  id: string;
  symbol: string;
  tf: string;
  direction: ObDirection;
  originTime: number; // vela origen del OB
  confirmedAtTime: number; // vela que lo confirma (impulso / ruptura de estructura)
  obLow: number;
  obHigh: number;
  strength: number; // fuerza del impulso / media reciente
  brokeStructure: boolean; // el movimiento rompió la estructura (swing). En structural: siempre true.
  leftImbalance: boolean; // dejó un gap de 3 velas (OB, impulso, siguiente)
  state: ObState;
  timeStart: number; // = originTime
  timeEnd: number; // = confirmedAtTime (el front lo proyecta a la derecha)
}

const round2 = (n: number) => Math.round(n * 100) / 100;
function avg(values: number[]): number {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

// Rango de la zona: mechas completas o cuerpo (LuxAlgo "Use Candle Body").
function zoneBounds(o: ObCandle, useBody: boolean): [number, number] {
  return useBody ? [Math.min(o.open, o.close), Math.max(o.open, o.close)] : [o.low, o.high];
}

// LÍNEA DE TIEMPO del estado de un OB (causal): cuándo ocurrió cada transición. Cada timestamp es
// el openTime de la vela cuya acción la produjo (se CONOCE al cierre de esa vela). El visor del
// replay la usa para mostrar el OB en su estado correcto en cada instante SIN duplicar esta lógica.
export interface ObStateTimeline {
  touchedAt: number | null; // primera vela que entra en la zona
  mitigatedAt: number | null; // primera vela que alcanza el extremo distal
  invalidatedAt: number | null; // primera vela cuyo CUERPO cierra más allá del distal (y ahí se detiene)
}

export function computeStateTimeline(
  candles: ObCandle[],
  startIdx: number,
  direction: ObDirection,
  obLow: number,
  obHigh: number,
): ObStateTimeline {
  let touchedAt: number | null = null;
  let mitigatedAt: number | null = null;
  for (let j = startIdx; j < candles.length; j++) {
    const c = candles[j];
    if (direction === 'bullish') {
      if (touchedAt == null && c.low < obHigh) touchedAt = c.openTime;
      if (mitigatedAt == null && c.low <= obLow) mitigatedAt = c.openTime;
      if (c.close < obLow) return { touchedAt, mitigatedAt, invalidatedAt: c.openTime };
    } else {
      if (touchedAt == null && c.high > obLow) touchedAt = c.openTime;
      if (mitigatedAt == null && c.high >= obHigh) mitigatedAt = c.openTime;
      if (c.close > obHigh) return { touchedAt, mitigatedAt, invalidatedAt: c.openTime };
    }
  }
  return { touchedAt, mitigatedAt, invalidatedAt: null };
}

// Estado de mitigación (causal): solo velas desde startIdx en adelante. Deriva del timeline para
// que detector y visor compartan UNA sola definición de las transiciones.
function computeState(candles: ObCandle[], startIdx: number, direction: ObDirection, obLow: number, obHigh: number): ObState {
  const t = computeStateTimeline(candles, startIdx, direction, obLow, obHigh);
  if (t.invalidatedAt != null) return 'invalidated';
  return t.mitigatedAt != null ? 'mitigated' : t.touchedAt != null ? 'touched' : 'untouched';
}

// ───────────────────────── Modo IMPULSE (lente anterior) ─────────────────────────
function detectByImpulse(symbol: string, tf: string, candles: ObCandle[], p: ObParams): BotOb[] {
  const { averageWindow, strengthRangeMultiplier, strengthBodyMultiplier, closeNearExtremeThreshold, swingLookback } = p;
  const useBody = p.useCandleBody ?? false;
  const n = candles.length;
  const out: BotOb[] = [];
  for (let i = averageWindow; i + 1 < n; i++) {
    const ob = candles[i];
    const imp = candles[i + 1];
    const obBull = ob.close > ob.open;
    const obBear = ob.close < ob.open;
    if (!obBull && !obBear) continue;

    const win = candles.slice(i - averageWindow + 1, i + 1);
    const avgRange = avg(win.map((c) => c.high - c.low));
    const avgBody = avg(win.map((c) => Math.abs(c.close - c.open)));
    const impRange = imp.high - imp.low;
    const impBody = Math.abs(imp.close - imp.open);
    const strongRange = avgRange > 0 && impRange >= strengthRangeMultiplier * avgRange;
    const strongBody = avgBody > 0 && impBody >= strengthBodyMultiplier * avgBody;

    let direction: ObDirection | null = null;
    if (obBear && imp.close > imp.open && imp.close > ob.high) {
      const closeNear = impRange > 0 && (imp.close - imp.low) / impRange >= closeNearExtremeThreshold;
      if ((strongRange || strongBody) && closeNear) direction = 'bullish';
    } else if (obBull && imp.close < imp.open && imp.close < ob.low) {
      const closeNear = impRange > 0 && (imp.high - imp.close) / impRange >= closeNearExtremeThreshold;
      if ((strongRange || strongBody) && closeNear) direction = 'bearish';
    }
    if (!direction) continue;

    const [obLow, obHigh] = zoneBounds(ob, useBody);
    const swingFrom = Math.max(0, i - swingLookback);
    const priorHighs = candles.slice(swingFrom, i).map((c) => c.high);
    const priorLows = candles.slice(swingFrom, i).map((c) => c.low);
    const brokeStructure =
      direction === 'bullish'
        ? priorHighs.length > 0 && imp.close > Math.max(...priorHighs)
        : priorLows.length > 0 && imp.close < Math.min(...priorLows);
    const next = candles[i + 2];
    const leftImbalance = next != null && (direction === 'bullish' ? ob.high < next.low : ob.low > next.high);

    out.push({
      id: `ob_${symbol}_${tf}_${ob.openTime}_${direction === 'bullish' ? 'u' : 'd'}`,
      symbol,
      tf,
      direction,
      originTime: ob.openTime,
      confirmedAtTime: imp.openTime,
      obLow,
      obHigh,
      strength: avgRange > 0 ? round2(impRange / avgRange) : 0,
      brokeStructure,
      leftImbalance,
      state: computeState(candles, i + 2, direction, obLow, obHigh),
      timeStart: ob.openTime,
      timeEnd: imp.openTime,
    });
  }
  return out;
}

// ───────────────────────── Modo STRUCTURAL (swing-first, default) ─────────────────────────
export interface Swing {
  index: number;
  price: number;
  kind: 'high' | 'low';
}

// Pivotes: high[i] es el máximo ESTRICTO de [i-lookback, i+lookback] (low análogo). Causal: el
// pivote en i se "conoce" en i+lookback (se exige al usarlo, no aquí). Exportado: lo reutiliza
// sweep.detector (barrido de liquidez sobre swings).
export function detectSwings(candles: ObCandle[], lookback: number): Swing[] {
  const out: Swing[] = [];
  const n = candles.length;
  for (let i = lookback; i < n - lookback; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - lookback; j <= i + lookback; j++) {
      if (j === i) continue;
      if (candles[j].high >= candles[i].high) isHigh = false;
      if (candles[j].low <= candles[i].low) isLow = false;
    }
    if (isHigh) out.push({ index: i, price: candles[i].high, kind: 'high' });
    if (isLow) out.push({ index: i, price: candles[i].low, kind: 'low' });
  }
  return out;
}

// Construye el OB estructural: última vela contraria antes de la ruptura, confirmada por fuerza.
function buildStructuralOb(
  symbol: string,
  tf: string,
  candles: ObCandle[],
  breakIdx: number,
  direction: ObDirection,
  p: ObParams,
): BotOb | null {
  const useBody = p.useCandleBody ?? false;
  const maxLegBars = p.maxLegBars ?? 10;
  const wantBearishOb = direction === 'bullish'; // OB alcista = última vela bajista del origen
  const from = Math.max(0, breakIdx - maxLegBars);
  let obIdx = -1;
  for (let j = breakIdx - 1; j >= from; j--) {
    const isBear = candles[j].close < candles[j].open;
    const isBull = candles[j].close > candles[j].open;
    if (wantBearishOb ? isBear : isBull) {
      obIdx = j;
      break;
    }
  }
  if (obIdx < 0) return null;

  // Fuerza de la pierna (obIdx+1 .. breakIdx): al menos una vela de impulso. Si no, "equipara" → descartar.
  const winStart = Math.max(0, obIdx - p.averageWindow + 1);
  const win = candles.slice(winStart, obIdx + 1);
  const avgRange = avg(win.map((c) => c.high - c.low));
  const avgBody = avg(win.map((c) => Math.abs(c.close - c.open)));
  let maxRange = 0;
  let maxBody = 0;
  for (let j = obIdx + 1; j <= breakIdx; j++) {
    maxRange = Math.max(maxRange, candles[j].high - candles[j].low);
    maxBody = Math.max(maxBody, Math.abs(candles[j].close - candles[j].open));
  }
  const strongRange = avgRange > 0 && maxRange >= p.strengthRangeMultiplier * avgRange;
  const strongBody = avgBody > 0 && maxBody >= p.strengthBodyMultiplier * avgBody;
  if (!(strongRange || strongBody)) return null; // sin fuerza → equiparada → no es OB

  const o = candles[obIdx];
  const [obLow, obHigh] = zoneBounds(o, useBody);
  const next = candles[obIdx + 1];
  const leftImbalance = next != null && (direction === 'bullish' ? o.high < next.low : o.low > next.high);
  return {
    id: `ob_${symbol}_${tf}_${o.openTime}_${direction === 'bullish' ? 'u' : 'd'}`,
    symbol,
    tf,
    direction,
    originTime: o.openTime,
    confirmedAtTime: candles[breakIdx].openTime,
    obLow,
    obHigh,
    strength: avgRange > 0 ? round2(maxRange / avgRange) : 0,
    brokeStructure: true,
    leftImbalance,
    state: computeState(candles, breakIdx + 1, direction, obLow, obHigh),
    timeStart: o.openTime,
    timeEnd: candles[breakIdx].openTime,
  };
}

function detectByStructure(symbol: string, tf: string, candles: ObCandle[], p: ObParams): BotOb[] {
  const lookback = p.swingLookback;
  const swings = detectSwings(candles, lookback);
  const highs = swings.filter((s) => s.kind === 'high');
  const lows = swings.filter((s) => s.kind === 'low');
  const out: BotOb[] = [];
  let prevBrokenHigh = -1;
  let prevBrokenLow = -1;

  // Último swing CONFIRMADO antes de la vela b (confirmado ⟺ index ≤ b - lookback).
  const lastConfirmed = (arr: Swing[], b: number): Swing | null => {
    let res: Swing | null = null;
    for (const s of arr) {
      if (s.index <= b - lookback) res = s;
      else break; // arr está en orden de index ascendente
    }
    return res;
  };

  for (let b = 0; b < candles.length; b++) {
    const c = candles[b];
    const lastHigh = lastConfirmed(highs, b);
    if (lastHigh && c.close > lastHigh.price && lastHigh.index !== prevBrokenHigh) {
      prevBrokenHigh = lastHigh.index; // BOS alcista (nuevo) → OB de demanda
      const ob = buildStructuralOb(symbol, tf, candles, b, 'bullish', p);
      if (ob) out.push(ob);
    }
    const lastLow = lastConfirmed(lows, b);
    if (lastLow && c.close < lastLow.price && lastLow.index !== prevBrokenLow) {
      prevBrokenLow = lastLow.index; // BOS bajista (nuevo) → OB de oferta
      const ob = buildStructuralOb(symbol, tf, candles, b, 'bearish', p);
      if (ob) out.push(ob);
    }
  }
  return applyShowLast(out, p);
}

// Pocos y recientes: dedup por id + los N más recientes por lado (= "gráfico limpio" del Video 1).
function applyShowLast(obs: BotOb[], p: ObParams): BotOb[] {
  const byId = new Map<string, BotOb>();
  for (const o of obs) {
    const ex = byId.get(o.id);
    if (!ex || o.confirmedAtTime > ex.confirmedAtTime) byId.set(o.id, o);
  }
  const uniq = [...byId.values()];
  const recent = (dir: ObDirection, n: number) =>
    uniq.filter((o) => o.direction === dir).sort((a, b) => b.confirmedAtTime - a.confirmedAtTime).slice(0, n);
  return [...recent('bullish', p.showLastBullish ?? 3), ...recent('bearish', p.showLastBearish ?? 3)].sort(
    (a, b) => a.timeStart - b.timeStart,
  );
}

/**
 * Detecta Order Blocks de una serie de velas CERRADAS (orden openTime ascendente). Causal, sin
 * repaint. `obMode` decide el motor: 'structural' (swing/BOS, default) | 'impulse' (lente anterior).
 */
export function detectOrderBlocks(
  symbol: string,
  tf: string,
  candles: ObCandle[],
  params: Partial<ObParams> = {},
): BotOb[] {
  const p: ObParams = { ...DEFAULT_OB_PARAMS, ...params };
  return p.obMode === 'impulse' ? detectByImpulse(symbol, tf, candles, p) : detectByStructure(symbol, tf, candles, p);
}
