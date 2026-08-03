// Ciclo 5 — MOTOR (docs/CYCLE-5-PREREG.md §1-§2). C5.3. Núcleo PURO (sin Nest/DB).
//
// Regla Cero: SIMULA sobre histórico; no coloca/modifica/cancela órdenes reales.
//
// Recorre las velas 15m de UN símbolo vela a vela con la estructura 4H precomputada (sesgo, POIs y
// swings — cada pieza con su tiempo de "conocido", causal) y simula el ciclo de vida completo:
// armado → fill/cancelación → TP1 50 % @+1R → SL a BE → runner (2R / POI 4H opuesto / trailing
// estructural 4H). UNA intención viva por símbolo máx. (como el candidato): pendiente O posición,
// nunca dos a la vez.
//
// Semánticas COPIADAS del simulador congelado (trade-simulator.ts — no se re-inventan):
//   · fill de la límite AL TOQUE (high ≥ L short / low ≤ L long); el fill manda intrabar (la vela
//     que llena se procesa YA como vela de posición: un knife puede llenar y pegar SL en la misma);
//   · pesimismo same-bar: SL y TP en la misma vela → SL primero (si el TP1 no llenó, −1R completo);
//   · todo movimiento de stop (BE, trailing) es efectivo la vela SIGUIENTE (jamás intrabar a favor);
//   · buffer del BE = entry·(feeEntrada + taker) → un stop en BE rinde ≈ 0R en esa pierna;
//   · R neta por pierna = ((exitFill − entryFill)·sign − entryFill·feeEntrada − exitFill·feeSalida)
//     / risk, combinada por fracción — mismo prorrateo del fee de entrada que computeRealizedRPartial;
//   · fees: entrada maker (A, límite) / taker (B, mercado) · TP1 y runner-TP límite = maker ·
//     SL/BE/trailing/endOfData = taker (stop-market). Slippage 0 (el stress es pasada posterior).
//
// ÚNICA divergencia declarada vs el simulador (mecanismo nuevo, solo stop TRAILING): si la vela
// ABRE ya más allá del stop trailed (el swing 4H confirmado quedó del lado favorable del precio),
// la salida se registra al OPEN (lo que llenaría un stop-market real), no al nivel del stop —
// salir "al nivel" fabricaría edge de la nada. SL inicial y BE conservan la paridad exacta.
//
// Decisiones de implementación (donde el prereg no baja al detalle — documentadas, no tuneables):
//   · Sesgo/armado se evalúan con el closeTime de la vela 15m ("al cierre", §1) — un cambio de
//     sesgo 4H cuyo cierre coincide con este cierre 15m ya es conocido.
//   · Si varios pools califican a la vez, se arma el de nivel MÁS CERCANO al cierre actual (la
//     primera liquidez en el camino del precio).
//   · "El POI se mitiga" (cancelación A) se generaliza a: el nivel L ya no está dentro de NINGÚN
//     POI vigente del lado correcto (si dos POIs contenían L, la muerte de uno solo no cancela).
//   · Gatillo B: el pool debe estar calificado ANTES de la vela que lo barre (snapshot pre-vela);
//     "barre" = la mecha CRUZA L (high > L short / low < L long) y el cierre vuelve al lado correcto.
//   · Runner POI: target FIJADO al fill con lo conocido al ABRIR la vela del fill (el fill ocurre
//     intrabar; su propia vela aún no cerró). Si el borde no queda MÁS ALLÁ del TP1 → 2R (misma
//     regla del simulador para el runner-pool del C4).
//   · Trailing: sigue al ÚLTIMO swing 4H confirmado (lookback 10) del lado del stop (highs para
//     short / lows para long), solo aprieta (a favor), y SOLO gestiona la pierna runner (tras el
//     TP1 el stop parte del BE; antes del TP1 rige el SL inicial — el prereg lo define como salida
//     del runner). Sin TP en esta variante.
//   · Tras cancelar/cerrar, el motor puede re-armar en el mismo cierre si las condiciones del §1
//     siguen vigentes (regla mecánica; p.ej. timeout con pool aún válido → límite nueva).

import { type Bias, type BiasPoint, computeHtfBias } from './htf-bias';
import { detectSwings } from '../bot-analysis/ob.detector';
import { C5_PARAMS, C5PoolDetector, type C5PoolCandle, type C5PoolView } from './c5-pool-detector';
import {
  detectC5Pois,
  nearestOppositePoiEdge,
  poolInsideVigentePoi,
  type C5Poi,
  type C5PoiCandle,
  type C5PoiSide,
} from './c5-poi';

// Vela 15m de ejecución (mismo shape que el detector de pools).
export type C5Candle = C5PoolCandle;

// Grid pre-declarado (§2): entrada {A, B} × runner {2R, POI-4H, trailing} — nada más.
export type C5Combo = 'A-2R' | 'A-POI' | 'A-TRAIL' | 'B-2R' | 'B-POI' | 'B-TRAIL';
export const C5_COMBOS: readonly C5Combo[] = ['A-2R', 'A-POI', 'A-TRAIL', 'B-2R', 'B-POI', 'B-TRAIL'];

export type C5Direction = 'LONG' | 'SHORT';
export type C5ExitReason = 'SL' | 'BE' | 'TP' | 'TRAIL' | 'endOfData';
export type C5CancelReason = 'biasFlip' | 'poiGone' | 'poolBroken' | 'timeout' | 'endOfData';
export type C5RejectReason = 'minStop' | 'badRisk';

// Swing 4H confirmado para el trailing: se CONOCE en el closeTime de la vela que lo confirma.
export interface C5TrailSwing {
  kind: 'high' | 'low';
  price: number;
  knownAtTime: number;
}

// Estructura 4H precomputada (cada pieza lleva su tiempo de "conocido" → el motor filtra por tiempo).
export interface C5Context {
  bias: BiasPoint[]; // computeHtfBias (congelado, swing 10)
  pois: C5Poi[]; // detectC5Pois
  trailSwings: C5TrailSwing[]; // computeC5TrailSwings (solo la variante TRAIL los usa)
}

export interface C5Trade {
  id: string;
  symbol: string;
  combo: C5Combo;
  direction: C5Direction;
  poolLevel: number; // L del pool cazado
  signalBarTime: number; // A: vela del armado · B: vela del sweep-reclaim (señal al cierre)
  entryTime: number;
  entryPrice: number; // A: L (límite) · B: open siguiente (mercado)
  exitTime: number;
  exitPrice: number; // combinado por fracción (informativo)
  exitReason: C5ExitReason; // salida del runner (o de la posición completa si el TP1 no llenó)
  stopLoss: number; // SL INICIAL (no muta con BE/trailing)
  tp1Level: number;
  runnerTp: number | null; // null = trailing (sin TP)
  runnerTpSource: 'fixed2R' | 'poi' | 'fallback2R' | 'trail';
  grossR: number;
  costR: number;
  rMultiple: number; // R NETA combinada (lo que importa)
  tp1Filled: boolean;
  tp1Time?: number;
  movedToBE: boolean;
  barsToFill: number; // velas desde la colocación hasta el fill (0 = primera vela elegible)
  barsHeld: number; // velas en posición (incluye la de salida)
}

export interface C5Cancel {
  reason: C5CancelReason;
  direction: C5Direction;
  poolLevel: number;
  armedAtTime: number;
  time: number;
}

export interface C5Reject {
  reason: C5RejectReason;
  direction: C5Direction;
  poolLevel: number;
  time: number;
}

export interface C5RunResult {
  symbol: string;
  combo: C5Combo;
  candles: number;
  firstTime: number | null;
  lastTime: number | null;
  poolsQualified: number; // pools que llegaron a calificar alguna vez (sanity del embudo)
  armed: number; // límites A colocadas / señales B disparadas
  trades: C5Trade[];
  cancels: C5Cancel[];
  rejects: C5Reject[];
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

type RunnerMode = '2R' | 'POI' | 'TRAIL';

interface Position {
  id: string;
  direction: C5Direction;
  poolLevel: number;
  signalBarTime: number;
  entryTime: number;
  entryPrice: number;
  stopLossInitial: number;
  risk: number;
  feeEntry: number;
  beBuffer: number; // en precio: entry·(feeEntry + taker) — copia del simulador (slippage 0)
  tp1Level: number;
  runnerTp: number | null;
  runnerTpSource: C5Trade['runnerTpSource'];
  sl: number; // stop VIGENTE (BE/trailing lo mueven; rige desde la vela siguiente)
  slSetBy: 'initial' | 'be' | 'trail';
  movedToBE: boolean;
  tp1Filled: boolean;
  tp1Time: number;
  tp1ExitFill: number;
  tp1NetR: number;
  tp1GrossR: number;
  barsToFill: number;
  barsHeld: number;
}

type EngineState =
  | { kind: 'idle' }
  | {
      kind: 'pendingA';
      direction: C5Direction;
      poolLevel: number;
      entry: number;
      stopLoss: number;
      armedAtTime: number;
      armedBarIndex: number;
      signalBarTime: number;
    }
  | { kind: 'enterB'; direction: C5Direction; poolLevel: number; stopLoss: number; signalBarTime: number }
  | { kind: 'open'; pos: Position };

/**
 * Corre el ciclo de vida C5 completo de UN símbolo sobre sus velas 15m CERRADAS (ascendente), con
 * la estructura 4H precomputada. Causal de punta a punta; devuelve trades + embudo (armados,
 * cancelaciones con su porqué, rechazos fee-aware) para el reporte.
 */
export function runC5Engine(symbol: string, candles: C5Candle[], ctx: C5Context, combo: C5Combo): C5RunResult {
  const isA = combo === 'A-2R' || combo === 'A-POI' || combo === 'A-TRAIL';
  const runnerMode: RunnerMode =
    combo === 'A-2R' || combo === 'B-2R' ? '2R' : combo === 'A-POI' || combo === 'B-POI' ? 'POI' : 'TRAIL';

  const detector = new C5PoolDetector();
  const trades: C5Trade[] = [];
  const cancels: C5Cancel[] = [];
  const rejects: C5Reject[] = [];
  let armed = 0;
  let state: EngineState = { kind: 'idle' };

  // Puntero de sesgo (≡ biasAt pero O(1) amortizado — el motor consulta en cada vela).
  let biasIdx = 0;
  let currentBias: Bias = 'neutral';

  // Puntero de swings 4H para el trailing: el último high/low CONOCIDO al ABRIR cada vela 15m.
  let trailIdx = 0;
  let lastTrailHigh: number | null = null;
  let lastTrailLow: number | null = null;

  // R neta de UNA pierna (fórmula del simulador / computeRealizedRPartial; slippage 0 en C5).
  const leg = (p: Position, exitLevel: number, feeExit: number) => {
    const sign = p.direction === 'LONG' ? 1 : -1;
    const netPrice = (exitLevel - p.entryPrice) * sign - p.entryPrice * p.feeEntry - exitLevel * feeExit;
    return { exitFill: exitLevel, netR: netPrice / p.risk, grossR: ((exitLevel - p.entryPrice) * sign) / p.risk };
  };

  const fillTp1 = (p: Position, t: number): void => {
    const l = leg(p, p.tp1Level, C5_PARAMS.makerFee); // TP1 = límite → maker
    p.tp1Filled = true;
    p.tp1Time = t;
    p.tp1ExitFill = l.exitFill;
    p.tp1NetR = l.netR;
    p.tp1GrossR = l.grossR;
  };

  // Cierra lo que quede vivo y registra el trade COMBINADO (suma ponderada de piernas).
  const finish = (p: Position, exitLevel: number, exitTime: number, reason: C5ExitReason, feeExit: number): void => {
    const frac = C5_PARAMS.partialFrac;
    const rest = leg(p, exitLevel, feeExit);
    const restFrac = p.tp1Filled ? 1 - frac : 1;
    const gross = (p.tp1Filled ? frac * p.tp1GrossR : 0) + restFrac * rest.grossR;
    const net = (p.tp1Filled ? frac * p.tp1NetR : 0) + restFrac * rest.netR;
    const exitPrice = (p.tp1Filled ? frac * p.tp1ExitFill : 0) + restFrac * rest.exitFill;
    trades.push({
      id: p.id,
      symbol,
      combo,
      direction: p.direction,
      poolLevel: round4(p.poolLevel),
      signalBarTime: p.signalBarTime,
      entryTime: p.entryTime,
      entryPrice: round4(p.entryPrice),
      exitTime,
      exitPrice: round4(exitPrice),
      exitReason: reason,
      stopLoss: round4(p.stopLossInitial),
      tp1Level: round4(p.tp1Level),
      runnerTp: p.runnerTp != null ? round4(p.runnerTp) : null,
      runnerTpSource: p.runnerTpSource,
      grossR: round4(gross),
      costR: round4(gross - net),
      rMultiple: round4(net),
      tp1Filled: p.tp1Filled,
      tp1Time: p.tp1Filled ? p.tp1Time : undefined,
      movedToBE: p.movedToBE,
      barsToFill: p.barsToFill,
      barsHeld: p.barsHeld,
    });
  };

  // Abre la posición (A: límite en L / B: mercado al open) y fija TP1 + runner (causal, al fill).
  const openPosition = (
    dir: C5Direction,
    poolLevel: number,
    signalBarTime: number,
    entry: number,
    stopLoss: number,
    feeEntry: number,
    barsToFill: number,
    entryCandle: C5Candle,
  ): Position => {
    const sign = dir === 'LONG' ? 1 : -1;
    const risk = (entry - stopLoss) * sign;
    const tp1Level = entry + sign * C5_PARAMS.tp1AtR * risk;
    const fixed2R = entry + sign * C5_PARAMS.runnerFixedR * risk;
    let runnerTp: number | null;
    let runnerTpSource: C5Trade['runnerTpSource'];
    if (runnerMode === '2R') {
      runnerTp = fixed2R;
      runnerTpSource = 'fixed2R';
    } else if (runnerMode === 'POI') {
      // Target FIJADO al fill: POI opuesto vigente según lo conocido al ABRIR la vela del fill.
      const edge = nearestOppositePoiEdge(ctx.pois, dir, entry, entryCandle.openTime);
      if (edge != null && (edge - tp1Level) * sign > 0) {
        runnerTp = edge;
        runnerTpSource = 'poi';
      } else {
        runnerTp = fixed2R; // sin POI opuesto (o borde ≤ TP1) → 2R, pre-registrado (§1)
        runnerTpSource = 'fallback2R';
      }
    } else {
      runnerTp = null; // trailing: sin TP — sale por el stop estructural
      runnerTpSource = 'trail';
    }
    return {
      id: `c5_${combo}_${symbol}_${signalBarTime}_${dir === 'LONG' ? 'u' : 'd'}`,
      direction: dir,
      poolLevel,
      signalBarTime,
      entryTime: entryCandle.openTime,
      entryPrice: entry,
      stopLossInitial: stopLoss,
      risk,
      feeEntry,
      beBuffer: entry * (feeEntry + C5_PARAMS.takerFee),
      tp1Level,
      runnerTp,
      runnerTpSource,
      sl: stopLoss,
      slSetBy: 'initial',
      movedToBE: false,
      tp1Filled: false,
      tp1Time: 0,
      tp1ExitFill: 0,
      tp1NetR: 0,
      tp1GrossR: 0,
      barsToFill,
      barsHeld: 0,
    };
  };

  const nearestTo = (pools: C5PoolView[], price: number): C5PoolView | null => {
    let best: C5PoolView | null = null;
    for (const pl of pools) {
      if (best == null || Math.abs(pl.level - price) < Math.abs(best.level - price)) best = pl;
    }
    return best;
  };

  const slFor = (dir: C5Direction, level: number): number =>
    dir === 'SHORT' ? level * (1 + C5_PARAMS.slBufferFrac) : level * (1 - C5_PARAMS.slBufferFrac);

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const ct = c.closeTime ?? c.openTime;
    while (biasIdx < ctx.bias.length && ctx.bias[biasIdx].time <= ct) currentBias = ctx.bias[biasIdx++].bias;
    while (trailIdx < ctx.trailSwings.length && ctx.trailSwings[trailIdx].knownAtTime <= c.openTime) {
      const s = ctx.trailSwings[trailIdx++];
      if (s.kind === 'high') lastTrailHigh = s.price;
      else lastTrailLow = s.price;
    }

    // 0) Gatillo B: snapshot de pools calificados ANTES de esta vela (el pool debe EXISTIR antes
    //    de la vela que lo barre; esta vela puede matarlo/subirle el nivel).
    let prevQualified: C5PoolView[] | null = null;
    if (!isA && state.kind === 'idle' && currentBias !== 'neutral') {
      prevQualified = detector.activeQualifiedPools(currentBias === 'bearish' ? 'high' : 'low');
    }

    // 1) Entrada B programada: mercado al OPEN de esta vela (taker). La vela se procesa YA como
    //    vela de posición (pesimismo same-bar intacto).
    if (state.kind === 'enterB') {
      const dir = state.direction;
      const sign = dir === 'LONG' ? 1 : -1;
      const entry = c.open;
      const risk = (entry - state.stopLoss) * sign;
      if (risk <= 0) {
        rejects.push({ reason: 'badRisk', direction: dir, poolLevel: state.poolLevel, time: c.openTime });
        state = { kind: 'idle' };
      } else if (risk < C5_PARAMS.minStopPct * entry) {
        // Piso fee-aware del candidato (§2): stop micro → no es trade.
        rejects.push({ reason: 'minStop', direction: dir, poolLevel: state.poolLevel, time: c.openTime });
        state = { kind: 'idle' };
      } else {
        state = {
          kind: 'open',
          pos: openPosition(dir, state.poolLevel, state.signalBarTime, entry, state.stopLoss, C5_PARAMS.takerFee, 0, c),
        };
      }
    }

    // 2) Fill de la límite A: AL TOQUE (fill a L, maker). El fill manda intrabar; la vela cae al
    //    bloque de posición abierta (un knife puede llenar y pegar SL/TP acá mismo).
    if (state.kind === 'pendingA') {
      const dir = state.direction;
      const hit = dir === 'LONG' ? c.low <= state.entry : c.high >= state.entry;
      if (hit) {
        state = {
          kind: 'open',
          pos: openPosition(
            dir,
            state.poolLevel,
            state.signalBarTime,
            state.entry,
            state.stopLoss,
            C5_PARAMS.makerFee,
            i - state.armedBarIndex - 1,
            c,
          ),
        };
      }
    }

    // 3) Posición abierta (incluida la vela del fill).
    if (state.kind === 'open') {
      const p = state.pos;
      p.barsHeld++;
      const sign = p.direction === 'LONG' ? 1 : -1;

      // Trailing estructural 4H (solo runner TRAIL, tras el TP1): el último swing confirmado
      // CONOCIDO al abrir esta vela se aplica ANTES de evaluarla — efectivo "la vela siguiente" a
      // su confirmación (jamás intrabar a favor) — y solo APRIETA el stop.
      if (runnerMode === 'TRAIL' && p.tp1Filled) {
        const cand = p.direction === 'SHORT' ? lastTrailHigh : lastTrailLow;
        if (cand != null && (p.direction === 'SHORT' ? cand < p.sl : cand > p.sl)) {
          p.sl = cand;
          p.slSetBy = 'trail';
        }
      }

      const liveStop = p.sl; // el stop vigente en ESTA vela (BE/trailing recién movidos no rigen)
      const slHit = p.direction === 'LONG' ? c.low <= liveStop : c.high >= liveStop;
      const tp1Hit = !p.tp1Filled && (p.direction === 'LONG' ? c.high >= p.tp1Level : c.low <= p.tp1Level);
      const tp2Hit = p.runnerTp != null && (p.direction === 'LONG' ? c.high >= p.runnerTp : c.low <= p.runnerTp);

      if (slHit) {
        // Pesimismo same-bar congelado: el stop manda (TP1 sin llenar → cae la posición completa).
        let exitLevel = liveStop;
        if (p.slSetBy === 'trail') {
          // Guard del trailing (divergencia declarada): si la vela ABRE más allá del stop trailed,
          // un stop-market real llena al open — no al nivel.
          exitLevel = p.direction === 'SHORT' ? Math.max(liveStop, c.open) : Math.min(liveStop, c.open);
        }
        const reason: C5ExitReason = p.slSetBy === 'trail' ? 'TRAIL' : p.movedToBE ? 'BE' : 'SL';
        finish(p, exitLevel, ct, reason, C5_PARAMS.takerFee);
        state = { kind: 'idle' };
      } else if (tp2Hit) {
        // El runner alcanza su target. Si el TP1 no había llenado, llena en el camino (está más acá).
        if (tp1Hit) fillTp1(p, ct);
        finish(p, p.runnerTp as number, ct, 'TP', C5_PARAMS.makerFee);
        state = { kind: 'idle' };
      } else if (tp1Hit) {
        fillTp1(p, ct);
        // BE del runner: efectivo desde la vela SIGUIENTE (semántica de simulatePartialRunner).
        const beLevel = p.entryPrice + sign * p.beBuffer;
        if (p.direction === 'LONG' ? beLevel > p.sl : beLevel < p.sl) {
          p.sl = beLevel;
          p.slSetBy = 'be';
          p.movedToBE = true;
        }
      }
    }

    // 4) Alimentar el detector con la vela CERRADA (los pools nuevos se conocen en este cierre).
    detector.update(c);

    // 5) Cancelaciones de la límite A — al CIERRE, si sigue pendiente (el fill ya se evaluó).
    if (state.kind === 'pendingA') {
      const dir = state.direction;
      const wantBias: Bias = dir === 'SHORT' ? 'bearish' : 'bullish';
      const obSide: C5PoiSide = dir === 'SHORT' ? 'supply' : 'demand';
      let reason: C5CancelReason | null = null;
      // (a) pool roto: cierre más allá del SL sin fill. En la práctica es inalcanzable (un cierre
      //     más allá del SL implica high ≥ L en esa vela ⇒ la límite ya llenó) — guard explícito.
      if (dir === 'SHORT' ? c.close > state.stopLoss : c.close < state.stopLoss) reason = 'poolBroken';
      // (b) el sesgo 4H voltea (deja de estar a favor).
      else if (currentBias !== wantBias) reason = 'biasFlip';
      // (c) el POI se mitiga: L ya no está dentro de ningún POI vigente del lado correcto.
      else if (!poolInsideVigentePoi(ctx.pois, obSide, state.poolLevel, ct)) reason = 'poiGone';
      // (d) T días sin fill.
      else if (ct - state.armedAtTime >= C5_PARAMS.maxWaitFillMs) reason = 'timeout';
      if (reason) {
        cancels.push({ reason, direction: dir, poolLevel: state.poolLevel, armedAtTime: state.armedAtTime, time: ct });
        state = { kind: 'idle' };
      }
    }

    // 6) Armado (A) / gatillo (B) — al cierre, con TODO lo conocido hasta este cierre.
    if (state.kind === 'idle' && currentBias !== 'neutral') {
      const dir: C5Direction = currentBias === 'bearish' ? 'SHORT' : 'LONG';
      const obSide: C5PoiSide = dir === 'SHORT' ? 'supply' : 'demand';
      if (isA) {
        // A: pool califica + POI 4H vigente contiene L (β=0) + sesgo a favor → límite virtual en L.
        const pools = detector
          .activeQualifiedPools(dir === 'SHORT' ? 'high' : 'low')
          .filter((pl) => poolInsideVigentePoi(ctx.pois, obSide, pl.level, ct));
        const pick = nearestTo(pools, c.close);
        if (pick) {
          const L = pick.level;
          // Piso fee-aware (§2). Para A es tautológico (buffer 0.35 % > 0.3 %) — guard explícito.
          if (C5_PARAMS.slBufferFrac < C5_PARAMS.minStopPct) {
            rejects.push({ reason: 'minStop', direction: dir, poolLevel: L, time: ct });
          } else {
            armed++;
            state = {
              kind: 'pendingA',
              direction: dir,
              poolLevel: L,
              entry: L,
              stopLoss: slFor(dir, L),
              armedAtTime: ct,
              armedBarIndex: i,
              signalBarTime: c.openTime,
            };
          }
        }
      } else if (prevQualified && prevQualified.length > 0) {
        // B: vela que BARRE L (la mecha cruza) y CIERRA de vuelta del lado correcto → mercado al
        // open siguiente. El pool viene del snapshot pre-vela; el POI se exige vigente a este cierre.
        const swept = prevQualified
          .filter((pl) =>
            dir === 'SHORT' ? c.high > pl.level && c.close < pl.level : c.low < pl.level && c.close > pl.level,
          )
          .filter((pl) => poolInsideVigentePoi(ctx.pois, obSide, pl.level, ct));
        const pick = nearestTo(swept, c.close);
        if (pick) {
          armed++;
          state = {
            kind: 'enterB',
            direction: dir,
            poolLevel: pick.level,
            stopLoss: slFor(dir, pick.level),
            signalBarTime: c.openTime,
          };
        }
      }
    }
  }

  // Fin de datos: la posición viva se cierra al último cierre (taker); lo pendiente muere sin fill.
  if (candles.length > 0) {
    const last = candles[candles.length - 1];
    const lastCt = last.closeTime ?? last.openTime;
    if (state.kind === 'open') {
      finish(state.pos, last.close, lastCt, 'endOfData', C5_PARAMS.takerFee);
    } else if (state.kind === 'pendingA') {
      cancels.push({
        reason: 'endOfData',
        direction: state.direction,
        poolLevel: state.poolLevel,
        armedAtTime: state.armedAtTime,
        time: lastCt,
      });
    } else if (state.kind === 'enterB') {
      cancels.push({
        reason: 'endOfData',
        direction: state.direction,
        poolLevel: state.poolLevel,
        armedAtTime: state.signalBarTime,
        time: lastCt,
      });
    }
  }

  return {
    symbol,
    combo,
    candles: candles.length,
    firstTime: candles.length ? candles[0].openTime : null,
    lastTime: candles.length ? candles[candles.length - 1].openTime : null,
    poolsQualified: detector.stats().qualifiedEver,
    armed,
    trades,
    cancels,
    rejects,
  };
}

/**
 * Swings 4H confirmados para el trailing estructural: el pivote en i se CONOCE cuando cierra la
 * vela i+lookback (misma regla de confirmación que htf-bias/ob.detector). Orden por knownAtTime.
 */
export function computeC5TrailSwings(
  candles4h: C5PoiCandle[],
  lookback: number = C5_PARAMS.swingLookback4h,
): C5TrailSwing[] {
  const swings = detectSwings(candles4h, lookback);
  const out: C5TrailSwing[] = [];
  for (const s of swings) {
    const confirm = candles4h[s.index + lookback];
    if (!confirm) continue; // detectSwings ya garantiza i < n − lookback; guard defensivo
    out.push({ kind: s.kind, price: s.price, knownAtTime: confirm.closeTime ?? confirm.openTime });
  }
  return out.sort((a, b) => a.knownAtTime - b.knownAtTime);
}

/**
 * Conveniencia para el CLI: arma el contexto 4H completo (sesgo congelado + POIs + swings del
 * trailing) desde las velas 4H CERRADAS. Puro.
 */
export function buildC5Context(candles4h: C5PoiCandle[]): C5Context {
  return {
    bias: computeHtfBias(candles4h, C5_PARAMS.swingLookback4h),
    pois: detectC5Pois(candles4h),
    trailSwings: computeC5TrailSwings(candles4h),
  };
}
