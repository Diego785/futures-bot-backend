import { C5_PARAMS } from '../c5-pool-detector';
import {
  detectC5Pois,
  nearestOppositePoiEdge,
  poisVigentesAt,
  type C5Poi,
  type C5PoiCandle,
} from '../c5-poi';
import { runC5Engine, type C5Candle, type C5Combo, type C5Context } from '../c5-engine';

// Ciclo 5 — motor. Escenario base SHORT: pool de equal highs en L = 100.02 (toques en i=0 y i=200,
// separación 200 ≥ P, edad ~50 h ≥ D), POI supply 4H [99, 101] vigente, sesgo 4H bearish. El motor
// arma la variante A al cierre de i=200 (o dispara la B con la vela que barre). El "silencio"
// i=1..199 usa highs descendentes en pasos de 0.02 (cadenas cortas, span < P → jamás pool).

const M15 = 15 * 60_000;
const T0 = Date.UTC(2024, 0, 1);

const mkc = (i: number, p: { o?: number; h: number; l: number; c?: number }): C5Candle => ({
  openTime: T0 + i * M15,
  open: p.o ?? (p.h + p.l) / 2,
  high: p.h,
  low: p.l,
  close: p.c ?? (p.h + p.l) / 2,
  closeTime: T0 + (i + 1) * M15 - 1,
});
const openT = (i: number): number => T0 + i * M15;
const closeT = (i: number): number => T0 + (i + 1) * M15 - 1;

// Constantes del escenario (derivadas SOLO de C5_PARAMS — sin números mágicos duplicados).
const L = 100.02;
const SL = L * (1 + C5_PARAMS.slBufferFrac); // 100.37007
const RISK = SL - L; // 0.35007
const TP1 = L - RISK; // 99.66993
const BE = L - L * (C5_PARAMS.makerFee + C5_PARAMS.takerFee); // 99.949986
const { makerFee, takerFee } = C5_PARAMS;

// R neta de una pierna SHORT (misma fórmula del simulador) — para calcular los esperados a mano.
const shortLeg = (entry: number, exit: number, feeEntry: number, feeExit: number, risk: number): number =>
  ((exit - entry) * -1 - entry * feeEntry - exit * feeExit) / risk;

function armingCandles(): C5Candle[] {
  const out: C5Candle[] = [mkc(0, { h: 100, l: 97 })];
  for (let i = 1; i <= 199; i++) out.push(mkc(i, { h: 99 - 0.02 * i, l: 96 - 0.02 * i }));
  out.push(mkc(200, { h: L, l: 97 })); // 2º toque (|L − 100| ≤ ε·100) → pool califica en este cierre
  return out;
}

const baseCtx = (): C5Context => ({
  bias: [{ time: 0, bias: 'bearish' }],
  pois: [{ side: 'supply', low: 99, high: 101, originTime: 0, confirmedAtTime: 0, mitigatedAtTime: null }],
  trailSwings: [],
});

const run = (candles: C5Candle[], ctx: C5Context, combo: C5Combo) => runC5Engine('TEST', candles, ctx, combo);

describe('C5 engine — variante A: fill a L con pesimismo same-bar (SL primero)', () => {
  it('la vela que toca L y el SL a la vez llena a L y sale por SL (−1R completo, sin TP1)', () => {
    const candles = armingCandles();
    candles.push(mkc(201, { h: 100.5, l: 99, c: 99.5 })); // llena (high ≥ L), y high ≥ SL y low ≤ TP1
    const r = run(candles, baseCtx(), 'A-2R');
    expect(r.armed).toBe(1);
    expect(r.poolsQualified).toBeGreaterThanOrEqual(1);
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0];
    expect(t.entryPrice).toBe(L); // fill exacto en la límite
    expect(t.entryTime).toBe(openT(201));
    expect(t.exitReason).toBe('SL');
    expect(t.tp1Filled).toBe(false);
    // R neta esperada: entrada maker en L, salida taker en el SL inicial.
    const expected = shortLeg(L, SL, makerFee, takerFee, RISK);
    expect(t.rMultiple).toBeCloseTo(expected, 3);
    expect(t.rMultiple).toBeLessThan(-1); // −1R + fees
  });

  it('la límite NO llena si el precio no toca L (y espera viva)', () => {
    const candles = armingCandles();
    candles.push(mkc(201, { h: 99.9, l: 99.0 })); // no alcanza L
    const r = run(candles, baseCtx(), 'A-2R');
    expect(r.trades).toHaveLength(0);
    expect(r.cancels.map((c) => c.reason)).toEqual(['endOfData']); // seguía pendiente al cortar los datos
  });
});

describe('C5 engine — TP1 50 % @ +1R → BE (semántica simulatePartialRunner)', () => {
  it('TP1 llena, el BE rige recién la vela SIGUIENTE, y el BE cierra EN GANANCIA', () => {
    const candles = armingCandles();
    candles.push(mkc(201, { h: L, l: 99.8 })); // llena al toque exacto de L
    candles.push(mkc(202, { h: 100.0, l: 99.6 })); // TP1 (low ≤ 99.67); high 100.0 ≥ BE pero el BE NO rige aún
    candles.push(mkc(203, { h: 99.96, l: 99.7 })); // high ≥ BE (99.95) → sale el runner en BE
    const r = run(candles, baseCtx(), 'A-2R');
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0];
    expect(t.tp1Filled).toBe(true);
    expect(t.tp1Time).toBe(closeT(202));
    expect(t.movedToBE).toBe(true);
    expect(t.exitReason).toBe('BE');
    expect(t.exitTime).toBe(closeT(203)); // NO en la vela del TP1 (el BE es efectivo la siguiente)
    expect(t.barsHeld).toBe(3);
    // Combinada: 50 % TP1 (maker) + 50 % BE (taker, ≈ 0R por el buffer) → EN GANANCIA.
    const tp1Leg = shortLeg(L, TP1, makerFee, makerFee, RISK);
    const beLeg = shortLeg(L, BE, makerFee, takerFee, RISK);
    expect(t.rMultiple).toBeCloseTo(0.5 * tp1Leg + 0.5 * beLeg, 3);
    expect(t.rMultiple).toBeGreaterThan(0); // el requisito del C4: BE = cerrar EN ganancia
    // El pool seguía vigente al cierre final → el motor re-arma (regla mecánica documentada).
    expect(r.armed).toBe(2);
  });
});

describe('C5 engine — variante B: mercado al open siguiente, fee taker', () => {
  it('vela que barre L y cierra debajo → entra al OPEN de la siguiente pagando taker', () => {
    const candles = armingCandles();
    candles.push(mkc(201, { h: 100.2, l: 99.5, c: 99.9 })); // barre (high > L) y recupera (close < L)
    candles.push(mkc(202, { o: 99.8, h: 100.0, l: 99.5 })); // entrada a mercado en 99.8
    const entry = 99.8;
    const riskB = SL - entry; // SL anclado a L (L ± buffer), no al entry
    const tp1B = entry - riskB;
    const tp2B = entry - 2 * riskB;
    candles.push(mkc(203, { h: 99.6, l: 99.2 })); // TP1 (low ≤ 99.23)
    candles.push(mkc(204, { h: 99.0, l: 98.6 })); // runner al 2R (low ≤ 98.66)
    const r = run(candles, baseCtx(), 'B-2R');
    expect(r.armed).toBe(1);
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0];
    expect(t.signalBarTime).toBe(openT(201)); // la señal es la vela del sweep-reclaim
    expect(t.entryTime).toBe(openT(202));
    expect(t.entryPrice).toBe(entry); // el open, no L
    expect(t.exitReason).toBe('TP');
    // La entrada paga TAKER (0.05 %): el esperado se computa con taker — con maker daría ≈ +0.05R más.
    const tp1Leg = shortLeg(entry, tp1B, takerFee, makerFee, riskB);
    const runnerLeg = shortLeg(entry, tp2B, takerFee, makerFee, riskB);
    expect(t.rMultiple).toBeCloseTo(0.5 * tp1Leg + 0.5 * runnerLeg, 3);
  });

  it('sin reclaim (cierra más allá de L) NO hay señal B', () => {
    const candles = armingCandles();
    candles.push(mkc(201, { h: 100.2, l: 99.9, c: 100.15 })); // barre pero cierra ENCIMA de L
    candles.push(mkc(202, { h: 100.1, l: 99.8 }));
    const r = run(candles, baseCtx(), 'B-2R');
    expect(r.armed).toBe(0);
    expect(r.trades).toHaveLength(0);
  });
});

describe('C5 engine — piso fee-aware minStopPct (rechazos de la variante B)', () => {
  it('gap: el open queda tan cerca del SL que el stop es micro → rechazo minStop', () => {
    const candles = armingCandles();
    candles.push(mkc(201, { h: 100.2, l: 99.5, c: 100.0 })); // señal B (close 100.0 < L)
    candles.push(mkc(202, { o: 100.2, h: 100.25, l: 99.9 })); // riesgo = SL − 100.2 ≈ 0.17 < 0.3 % del precio
    const r = run(candles, baseCtx(), 'B-2R');
    expect(r.armed).toBe(1);
    expect(r.trades).toHaveLength(0);
    expect(r.rejects).toHaveLength(1);
    expect(r.rejects[0].reason).toBe('minStop');
  });

  it('open más allá del SL → riesgo ≤ 0 → rechazo badRisk', () => {
    const candles = armingCandles();
    candles.push(mkc(201, { h: 100.2, l: 99.5, c: 100.0 }));
    candles.push(mkc(202, { o: 100.5, h: 100.6, l: 100.0 })); // abre por encima del SL (100.37)
    const r = run(candles, baseCtx(), 'B-2R');
    expect(r.trades).toHaveLength(0);
    expect(r.rejects[0].reason).toBe('badRisk');
  });
});

describe('C5 engine — runner POI 4H opuesto (target FIJADO al fill, causal)', () => {
  const poisConDemanda = (): C5Poi[] => [
    { side: 'supply', low: 99, high: 101, originTime: 0, confirmedAtTime: 0, mitigatedAtTime: null },
    { side: 'demand', low: 97.0, high: 97.5, originTime: 0, confirmedAtTime: 0, mitigatedAtTime: null },
    // POI más cercano pero confirmado DESPUÉS del fill (i=204): NO puede usarse (causal).
    { side: 'demand', low: 98.0, high: 98.5, originTime: 0, confirmedAtTime: openT(204), mitigatedAtTime: null },
  ];

  it('usa el borde cercano del POI opuesto vigente AL FILL; uno posterior más cercano no lo cambia', () => {
    const candles = armingCandles();
    candles.push(mkc(201, { h: L, l: 99.8 })); // fill → target del runner queda fijado acá
    candles.push(mkc(202, { h: 99.9, l: 99.6 })); // TP1
    candles.push(mkc(203, { h: 99.4, l: 99.0 }));
    candles.push(mkc(204, { h: 99.2, l: 98.9 })); // acá "nace" el POI 98.5 — tarde: el target no muta
    candles.push(mkc(205, { h: 99.0, l: 98.4 })); // cruza 98.5: si el target hubiera mutado saldría acá
    candles.push(mkc(206, { h: 98.0, l: 97.4 })); // 97.5 alcanzado → TP del runner
    const ctx = { ...baseCtx(), pois: poisConDemanda() };
    const r = run(candles, ctx, 'A-POI');
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0];
    expect(t.runnerTpSource).toBe('poi');
    expect(t.runnerTp).toBe(97.5); // borde CERCANO (high) de la demanda [97, 97.5]
    expect(t.exitReason).toBe('TP');
    expect(t.exitTime).toBe(closeT(206)); // NO en i=205: el target quedó fijado al fill
    const tp1Leg = shortLeg(L, TP1, makerFee, makerFee, RISK);
    const runnerLeg = shortLeg(L, 97.5, makerFee, makerFee, RISK);
    expect(t.rMultiple).toBeCloseTo(0.5 * tp1Leg + 0.5 * runnerLeg, 3);
  });

  it('sin POI opuesto vigente → fallback pre-registrado al 2R', () => {
    const candles = armingCandles();
    candles.push(mkc(201, { h: L, l: 99.8 })); // fill (solo existe el supply del armado)
    candles.push(mkc(202, { h: 99.9, l: 99.6 })); // TP1
    candles.push(mkc(203, { h: 99.5, l: 99.31 })); // 2R (99.32) alcanzado
    const r = run(candles, baseCtx(), 'A-POI');
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].runnerTpSource).toBe('fallback2R');
    expect(r.trades[0].runnerTp).toBeCloseTo(L - 2 * RISK, 3);
    expect(r.trades[0].exitReason).toBe('TP');
  });
});

describe('C5 engine — runner TRAILING estructural 4H', () => {
  it('tras el TP1, el stop sigue al último swing 4H confirmado (solo aprieta) y sale por TRAIL', () => {
    const candles = armingCandles();
    candles.push(mkc(201, { h: L, l: 99.8 })); // fill
    candles.push(mkc(202, { h: 99.9, l: 99.6 })); // TP1 → BE efectivo desde 203
    candles.push(mkc(203, { h: 99.7, l: 99.0 })); // vive (high < BE)
    candles.push(mkc(204, { o: 99.2, h: 99.5, l: 99.1 })); // swing conocido al open → stop 99.4 → high ≥ 99.4 sale
    const ctx: C5Context = {
      ...baseCtx(),
      trailSwings: [{ kind: 'high', price: 99.4, knownAtTime: openT(204) }], // confirmado entre 203 y 204
    };
    const r = run(candles, ctx, 'A-TRAIL');
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0];
    expect(t.runnerTp).toBeNull(); // sin TP: la variante sale por estructura
    expect(t.runnerTpSource).toBe('trail');
    expect(t.exitReason).toBe('TRAIL');
    expect(t.exitTime).toBe(closeT(204));
    const tp1Leg = shortLeg(L, TP1, makerFee, makerFee, RISK);
    const trailLeg = shortLeg(L, 99.4, makerFee, takerFee, RISK); // stop = taker; salió en ganancia
    expect(t.rMultiple).toBeCloseTo(0.5 * tp1Leg + 0.5 * trailLeg, 3);
    expect(t.rMultiple).toBeGreaterThan(0.5); // TP1 + runner apretado en profit
  });

  it('guard del gap: si la vela ABRE más allá del stop trailed, la salida se registra al OPEN', () => {
    const candles = armingCandles();
    candles.push(mkc(201, { h: L, l: 99.8 }));
    candles.push(mkc(202, { h: 99.9, l: 99.6 })); // TP1
    candles.push(mkc(203, { h: 99.7, l: 99.0 }));
    candles.push(mkc(204, { o: 99.6, h: 99.8, l: 99.3 })); // abre 99.6 > stop 99.4 → stop-market al open
    const ctx: C5Context = {
      ...baseCtx(),
      trailSwings: [{ kind: 'high', price: 99.4, knownAtTime: openT(204) }],
    };
    const r = run(candles, ctx, 'A-TRAIL');
    const t = r.trades[0];
    expect(t.exitReason).toBe('TRAIL');
    const tp1Leg = shortLeg(L, TP1, makerFee, makerFee, RISK);
    const trailLeg = shortLeg(L, 99.6, makerFee, takerFee, RISK); // al OPEN (peor), no al nivel 99.4
    expect(t.rMultiple).toBeCloseTo(0.5 * tp1Leg + 0.5 * trailLeg, 3);
  });
});

describe('C5 engine — cancelaciones de la límite A', () => {
  it('el sesgo 4H voltea → la límite se retira (biasFlip)', () => {
    const candles = armingCandles();
    for (let i = 201; i <= 206; i++) candles.push(mkc(i, { h: 99.5, l: 99.0 })); // nunca llena
    const ctx: C5Context = {
      ...baseCtx(),
      bias: [
        { time: 0, bias: 'bearish' },
        { time: openT(205), bias: 'bullish' }, // voltea
      ],
    };
    const r = run(candles, ctx, 'A-2R');
    expect(r.trades).toHaveLength(0);
    expect(r.cancels[0].reason).toBe('biasFlip');
    expect(r.cancels[0].time).toBe(closeT(205));
  });

  it('T = 10 días sin fill → timeout', () => {
    const candles = armingCandles();
    for (let i = 201; i <= 1165; i++) candles.push(mkc(i, { h: 99.5 - 0.05 * (i - 200), l: 96.5 - 0.05 * (i - 200) }));
    const r = run(candles, baseCtx(), 'A-2R');
    expect(r.trades).toHaveLength(0);
    expect(r.cancels[0].reason).toBe('timeout');
    expect(r.cancels[0].time).toBe(closeT(1160)); // 960 velas 15m = 10 días exactos tras el armado
  });

  it('el POI se mitiga → la límite se retira (poiGone)', () => {
    const candles = armingCandles();
    for (let i = 201; i <= 206; i++) candles.push(mkc(i, { h: 99.5, l: 99.0 }));
    const ctx: C5Context = {
      ...baseCtx(),
      pois: [{ side: 'supply', low: 99, high: 101, originTime: 0, confirmedAtTime: 0, mitigatedAtTime: closeT(204) }],
    };
    const r = run(candles, ctx, 'A-2R');
    expect(r.trades).toHaveLength(0);
    expect(r.cancels[0].reason).toBe('poiGone');
    expect(r.cancels[0].time).toBe(closeT(204));
  });
});

describe('C5 POI 4H — detector estructural simple (BOS por cuerpo → última vela contraria)', () => {
  const H4 = 4 * 3_600_000;
  const mk4 = (i: number, o: number, h: number, l: number, c: number): C5PoiCandle => ({
    openTime: T0 + i * H4,
    open: o,
    high: h,
    low: l,
    close: c,
    closeTime: T0 + (i + 1) * H4 - 1,
  });
  const close4 = (i: number): number => T0 + (i + 1) * H4 - 1;

  function poiCandles(): C5PoiCandle[] {
    const out: C5PoiCandle[] = [];
    for (let i = 0; i <= 9; i++) out.push(mk4(i, 100 + i - 1.5, 100 + i, 100 + i - 2, 100 + i - 0.5)); // subida
    out.push(mk4(10, 112.5, 115, 112, 113.5)); // swing high 115 (confirmado en la vela 20)
    for (let i = 11; i <= 20; i++) {
      const h = 110 - (i - 11);
      out.push(mk4(i, h - 0.5, h, h - 2, h - 1.5)); // bajada (velas bajistas, todas < 115)
    }
    out.push(mk4(21, 104, 104.5, 101.5, 102)); // la vela OB (bajista) → zona [101.5, 104.5]
    out.push(mk4(22, 102.5, 108.5, 102, 108)); // alcista
    out.push(mk4(23, 108, 116.5, 107.5, 116)); // BOS por CUERPO (116 > 115) → OB de demanda
    out.push(mk4(24, 116, 118, 115.5, 117)); // rompe de nuevo el mismo swing: dedup, sin 2º OB
    out.push(mk4(25, 117, 117.5, 110, 112)); // retrocede sin mitigar (close 112 > 104.5)
    out.push(mk4(26, 111, 112, 103.5, 104)); // CIERRE dentro de la zona → mitigado
    return out;
  }

  it('detecta el OB del BOS (zona = última vela contraria) con su línea de vida causal', () => {
    const pois = detectC5Pois(poiCandles());
    expect(pois).toHaveLength(1); // el 2º cierre sobre el mismo swing no duplica
    const p = pois[0];
    expect(p.side).toBe('demand');
    expect(p.low).toBe(101.5);
    expect(p.high).toBe(104.5);
    expect(p.originTime).toBe(T0 + 21 * H4);
    expect(p.confirmedAtTime).toBe(close4(23)); // conocido al CIERRE de la vela del BOS
    expect(p.mitigatedAtTime).toBe(close4(26)); // muerto al primer cierre que alcanza la zona
  });

  it('poisVigentesAt respeta la ventana [confirmado, mitigado)', () => {
    const pois = detectC5Pois(poiCandles());
    expect(poisVigentesAt(pois, close4(22))).toHaveLength(0); // aún no confirmado
    expect(poisVigentesAt(pois, close4(23))).toHaveLength(1);
    expect(poisVigentesAt(pois, close4(25))).toHaveLength(1);
    expect(poisVigentesAt(pois, close4(26))).toHaveLength(0); // ya mitigado
  });

  it('nearestOppositePoiEdge: SHORT apunta al borde ALTO de la demanda por debajo', () => {
    const pois = detectC5Pois(poiCandles());
    expect(nearestOppositePoiEdge(pois, 'SHORT', 120, close4(23))).toBe(104.5);
    expect(nearestOppositePoiEdge(pois, 'LONG', 100, close4(23))).toBeNull(); // no hay supply
    expect(nearestOppositePoiEdge(pois, 'SHORT', 120, close4(26))).toBeNull(); // mitigado → ya no es target
  });
});
