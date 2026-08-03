// Ciclo 5 — DETECTOR DE POOLS de liquidez multi-día (docs/CYCLE-5-PREREG.md §1-§2). C5.1.
//
// Regla Cero: núcleo PURO (sin Nest/DB); solo transforma velas CERRADAS en niveles de liquidez.
// No coloca, modifica ni cancela nada.
//
// Definición CONGELADA (§1): pool (nivel L) = ≥2 extremos del mismo lado (highs para short / lows
// para long) dentro de tolerancia ε del nivel, separados ≥ P velas 15m entre sí, con antigüedad del
// más viejo ≥ D días, y NO barrido desde su formación (ninguna mecha posterior superó L·(1+ε) para
// highs / perforó L·(1−ε) para lows). Nivel del pool = el extremo MÁS ALTO del cluster para highs
// (el más bajo para lows).
//
// Causalidad (NO-REPAINT-RULES): API INCREMENTAL — se alimenta vela CERRADA a vela cerrada
// (`update`) y se consulta al cierre (`activeQualifiedPools`). El estado tras la vela k es función
// EXCLUSIVA de las velas ≤ k (hay test de prefijo en __tests__). Lookahead 0 por construcción.
//
// Decisiones de implementación (donde el prereg no baja al detalle — documentadas, NO tuneables):
//   · "Extremo" = el high/low de CADA vela cerrada. El grid congelado no declara un lookback de
//     pivote para los extremos 15m; son la separación P y la antigüedad D las que garantizan que
//     dos toques sean tests DISTINTOS del nivel (exigir pivote habría metido un parámetro nuevo).
//   · Un toque se agrega al cluster de nivel MÁS CERCANO dentro de ε (nunca a varios; no hay fusión
//     cluster-cluster) y actualiza el nivel al extremo más alto (highs) / más bajo (lows).
//   · "Separados ≥ P velas": el cluster califica cuando su primer y último toque distan ≥ P velas
//     (⟹ existen 2 extremos separados ≥ P; los toques intermedios no restan).
//   · Antigüedad: se ancla al openTime de la vela del primer toque (el extremo se imprimió DURANTE
//     esa vela) y se mide contra el closeTime (?? openTime) de la última vela alimentada.

// ─── Parámetros FIJOS del prereg §2 (nada configurable fuera del grid declarado) ───
export const C5_PARAMS = {
  /** ε: tolerancia del cluster y del barrido, fracción del nivel (0.10 % de L). */
  epsilonFrac: 0.001,
  /** P: separación mínima entre extremos del pool, en velas 15m. */
  minSeparationBars: 16,
  /** D: antigüedad mínima del extremo más viejo (2 días, en ms). */
  minAgeMs: 2 * 24 * 60 * 60 * 1000,
  /** β: margen de contención del pool dentro del POI 4H (0 = contener estricto). */
  poiBetaFrac: 0,
  /** Buffer del SL: % fijo sobre L (SL = L ± buffer·L). */
  slBufferFrac: 0.0035,
  /** T: vida máxima de la límite A sin fill (10 días, en ms). */
  maxWaitFillMs: 10 * 24 * 60 * 60 * 1000,
  /** Piso fee-aware idéntico al candidato: riesgo < minStopPct·entry → intent rechazado. */
  minStopPct: 0.003,
  /** Fees del prereg §2 (Binance USDT-M futures). */
  makerFee: 0.0002,
  takerFee: 0.0005,
  /** Salida C4 congelada (no se toca): TP1 cierra 50 % en +1R → SL a BE. */
  tp1AtR: 1,
  partialFrac: 0.5,
  /** Runner de control: 2R fijo (el candidato actual). */
  runnerFixedR: 2,
  /** Estructura 4H congelada (swing 10 — el mismo lever del candidato). */
  swingLookback4h: 10,
} as const;

export interface C5PoolCandle {
  openTime: number;
  open: number;
  high: number;
  low: number;
  close: number;
  closeTime?: number;
}

// 'high' = equal highs (liquidez de venta arriba → shorts) · 'low' = equal lows (→ longs).
export type C5PoolSide = 'high' | 'low';

// Vista inmutable de un pool VIGENTE y calificado (lo que consume el motor al cierre).
export interface C5PoolView {
  side: C5PoolSide;
  level: number;
  touchCount: number;
  firstTouchIndex: number;
  firstTouchTime: number; // openTime de la vela del primer extremo (ancla de la antigüedad D)
  lastTouchIndex: number;
  lastTouchTime: number;
}

export interface C5PoolStats {
  candlesFed: number;
  qualifiedEver: number; // clusters que llegaron a calificar como pool alguna vez (sanity)
  sweptQualified: number; // pools calificados que luego fueron barridos
  activeQualified: number;
}

interface Cluster {
  side: C5PoolSide;
  level: number;
  touchCount: number;
  firstTouchIndex: number;
  firstTouchTime: number;
  lastTouchIndex: number;
  lastTouchTime: number;
  qualified: boolean;
  swept: boolean;
  readyAt: number | null; // span ≥ P ya logrado: califica cuando el reloj llegue aquí (edad D)
}

/**
 * Detector INCREMENTAL de pools multi-día. Alimentar con `update(vela cerrada)` en orden
 * ascendente; consultar `activeQualifiedPools()` en cada cierre. Parámetros fijos (C5_PARAMS).
 */
export class C5PoolDetector {
  // Clusters candidatos por lado, en orden ASCENDENTE por nivel (barridos = prefijo/sufijo).
  private readonly clusters: Record<C5PoolSide, Cluster[]> = { high: [], low: [] };
  // Pools ya CALIFICADOS y vivos (los únicos que el motor puede armar) — pocos por diseño.
  private readonly qualifiedArr: Record<C5PoolSide, Cluster[]> = { high: [], low: [] };
  // Clusters con span ≥ P esperando la edad D (promoción por paso del tiempo, sin nuevo toque).
  private pendingAge: Cluster[] = [];
  private barIndex = -1;
  private candlesFed = 0;
  private qualifiedEver = 0;
  private sweptQualified = 0;

  /** Alimenta UNA vela cerrada (orden ascendente). Actualiza toques, barridos y calificaciones. */
  update(candle: C5PoolCandle): void {
    this.barIndex++;
    this.candlesFed++;
    const t = candle.closeTime ?? candle.openTime;
    this.feed('high', candle.high, candle.openTime, t);
    this.feed('low', candle.low, candle.openTime, t);
    // Promoción por edad pura: span ya ≥ P, solo faltaba que el más viejo cumpliera D días.
    if (this.pendingAge.length > 0) {
      const keep: Cluster[] = [];
      for (const cl of this.pendingAge) {
        if (cl.swept || cl.qualified) continue;
        if (cl.readyAt != null && cl.readyAt <= t) this.promote(cl);
        else keep.push(cl);
      }
      this.pendingAge = keep;
    }
  }

  /** Pools VIGENTES y CALIFICADOS al cierre de la última vela alimentada (orden asc. por nivel). */
  activeQualifiedPools(side?: C5PoolSide): C5PoolView[] {
    const sides: C5PoolSide[] = side ? [side] : ['high', 'low'];
    const out: C5PoolView[] = [];
    for (const s of sides) {
      for (const cl of this.qualifiedArr[s]) {
        out.push({
          side: cl.side,
          level: cl.level,
          touchCount: cl.touchCount,
          firstTouchIndex: cl.firstTouchIndex,
          firstTouchTime: cl.firstTouchTime,
          lastTouchIndex: cl.lastTouchIndex,
          lastTouchTime: cl.lastTouchTime,
        });
      }
    }
    return out.sort((a, b) => a.level - b.level);
  }

  stats(): C5PoolStats {
    return {
      candlesFed: this.candlesFed,
      qualifiedEver: this.qualifiedEver,
      sweptQualified: this.sweptQualified,
      activeQualified: this.qualifiedArr.high.length + this.qualifiedArr.low.length,
    };
  }

  // ─── internos ───

  // Procesa el extremo `p` de la vela contra los clusters del lado: primero BARRIDOS (la mecha
  // superó nivel±ε), después el TOQUE (dentro de ε, al cluster más cercano) o cluster nuevo.
  private feed(side: C5PoolSide, p: number, touchTime: number, t: number): void {
    const eps = C5_PARAMS.epsilonFrac;
    const arr = this.clusters[side];
    if (side === 'high') {
      // Barrido: high > nivel·(1+ε) ⟺ nivel más abajo que p/(1+ε) → prefijo del orden ascendente.
      let n = 0;
      while (n < arr.length && arr[n].level * (1 + eps) < p) n++;
      if (n > 0) this.sweepOut(side, arr.splice(0, n));
      // Toque: |p − nivel| ≤ ε·nivel. Los supervivientes ya cumplen p ≤ nivel·(1+ε); candidatos =
      // prefijo con nivel·(1−ε) ≤ p. Se elige el de nivel MÁS CERCANO.
      let bestIdx = -1;
      for (let i = 0; i < arr.length && arr[i].level * (1 - eps) <= p; i++) {
        if (bestIdx < 0 || Math.abs(arr[i].level - p) < Math.abs(arr[bestIdx].level - p)) bestIdx = i;
      }
      if (bestIdx >= 0) this.touch(side, bestIdx, p, touchTime, t);
      else this.newCluster(side, p, touchTime);
    } else {
      // Espejo: barrido si low < nivel·(1−ε) → sufijo (niveles por encima de p/(1−ε)).
      let n = arr.length;
      while (n > 0 && arr[n - 1].level * (1 - eps) > p) n--;
      if (n < arr.length) this.sweepOut(side, arr.splice(n));
      let bestIdx = -1;
      for (let i = arr.length - 1; i >= 0 && arr[i].level * (1 + eps) >= p; i--) {
        if (bestIdx < 0 || Math.abs(arr[i].level - p) < Math.abs(arr[bestIdx].level - p)) bestIdx = i;
      }
      if (bestIdx >= 0) this.touch(side, bestIdx, p, touchTime, t);
      else this.newCluster(side, p, touchTime);
    }
  }

  private touch(side: C5PoolSide, idx: number, p: number, touchTime: number, t: number): void {
    const arr = this.clusters[side];
    const cl = arr[idx];
    cl.touchCount++;
    cl.lastTouchIndex = this.barIndex;
    cl.lastTouchTime = touchTime;
    // Nivel del pool = extremo MÁS ALTO del cluster (highs) / MÁS BAJO (lows).
    const newLevel = side === 'high' ? Math.max(cl.level, p) : Math.min(cl.level, p);
    if (newLevel !== cl.level) {
      arr.splice(idx, 1);
      cl.level = newLevel;
      this.insertSorted(arr, cl);
    }
    if (!cl.qualified) {
      const span = cl.lastTouchIndex - cl.firstTouchIndex;
      if (span >= C5_PARAMS.minSeparationBars) {
        if (t - cl.firstTouchTime >= C5_PARAMS.minAgeMs) this.promote(cl);
        else if (cl.readyAt == null) {
          cl.readyAt = cl.firstTouchTime + C5_PARAMS.minAgeMs;
          this.pendingAge.push(cl);
        }
      }
    }
  }

  private newCluster(side: C5PoolSide, p: number, touchTime: number): void {
    const cl: Cluster = {
      side,
      level: p,
      touchCount: 1,
      firstTouchIndex: this.barIndex,
      firstTouchTime: touchTime,
      lastTouchIndex: this.barIndex,
      lastTouchTime: touchTime,
      qualified: false,
      swept: false,
      readyAt: null,
    };
    this.insertSorted(this.clusters[side], cl);
  }

  private promote(cl: Cluster): void {
    cl.qualified = true;
    this.qualifiedArr[cl.side].push(cl);
    this.qualifiedEver++;
  }

  private sweepOut(side: C5PoolSide, removed: Cluster[]): void {
    for (const cl of removed) {
      cl.swept = true;
      if (cl.qualified) {
        const q = this.qualifiedArr[side];
        const i = q.indexOf(cl);
        if (i >= 0) q.splice(i, 1);
        this.sweptQualified++;
      }
    }
  }

  private insertSorted(arr: Cluster[], cl: Cluster): void {
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].level < cl.level) lo = mid + 1;
      else hi = mid;
    }
    arr.splice(lo, 0, cl);
  }
}
