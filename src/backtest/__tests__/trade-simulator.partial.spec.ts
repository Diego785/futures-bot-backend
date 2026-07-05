import { simulateTrade, type SimCandle, type SimConfig, type TradeIntent } from '../trade-simulator';

// Ciclo 4 (CYCLE-4-PREREG §2) — motor de salida PARCIAL + RUNNER. Mismas convenciones que el spec
// base: entry 100, SL 90 (riesgo 10), TP nominal 120 (2R). TP1 (tp1AtR=1) = 110. Pool runner = 130 (3R).

const c = (openTime: number, high: number, low: number, close: number): SimCandle => ({
  openTime,
  high,
  low,
  close,
});

const longBase: TradeIntent = {
  id: 'p1',
  symbol: 'BTCUSDT',
  tf: '15m',
  direction: 'LONG',
  signalBarTime: 0,
  entry: 100,
  stopLoss: 90,
  takeProfit: 120,
  runnerTakeProfit: 130,
};

const P: Partial<SimConfig> = {
  feeRatePerSide: 0,
  slippagePerSide: 0,
  exitMode: 'partial-runner',
  tp1AtR: 1,
  partialFrac: 0.5,
};

describe('partial-runner — regresión: el modo full queda intacto', () => {
  it("exitMode 'full' ≡ exitMode ausente (mismo resultado)", () => {
    const candles = [c(1, 101, 99, 100), c(2, 125, 100, 120)];
    const a = simulateTrade(longBase, candles, { feeRatePerSide: 0, slippagePerSide: 0 });
    const b = simulateTrade(longBase, candles, { feeRatePerSide: 0, slippagePerSide: 0, exitMode: 'full' });
    expect(b).toEqual(a);
    expect(a.trade?.rMultiple).toBe(2); // y el runnerTakeProfit del intent NO afecta el modo full
    expect(a.trade?.tp1Filled).toBeUndefined();
  });
});

describe('partial-runner — piernas (LONG, sin costes)', () => {
  it('TP1 → runner a TP2 (pool): R = frac·1R + (1−frac)·3R', () => {
    const candles = [
      c(1, 101, 99, 100), // llena
      c(2, 111, 100, 108), // TP1 (high ≥ 110)
      c(3, 131, 107, 128), // TP2 (high ≥ 130)
    ];
    const r = simulateTrade(longBase, candles, P);
    expect(r.trade?.tp1Filled).toBe(true);
    expect(r.trade?.exitReason).toBe('TP');
    expect(r.trade?.runnerExitReason).toBe('TP');
    expect(r.trade?.rMultiple).toBeCloseTo(0.5 * 1 + 0.5 * 3, 6); // 2.0
    expect(r.trade?.movedToBE).toBe(true);
    expect(r.trade?.runnerTp).toBe(130);
  });

  it('TP1 → runner a BE: el trade CIERRA EN GANANCIA (+frac·1R), no en 0', () => {
    const candles = [
      c(1, 101, 99, 100), // llena
      c(2, 111, 99.5, 108), // TP1; low 99.5 no toca el SL original (90) y el BE aún NO rige
      c(3, 105, 99.9, 101), // low ≤ BE (100, sin costes) → runner sale en BE
    ];
    const r = simulateTrade(longBase, candles, P);
    expect(r.trade?.tp1Filled).toBe(true);
    expect(r.trade?.exitReason).toBe('BE');
    expect(r.trade?.rMultiple).toBeCloseTo(0.5, 6); // el parcial ya está en el bolsillo
    expect(r.trade?.rMultiple).toBeGreaterThan(0); // ← el requisito del usuario
  });

  it('el BE rige recién la vela SIGUIENTE al TP1 (en la vela del TP1 manda el SL original)', () => {
    const candles = [
      c(1, 101, 99, 100), // llena (low 99 > 90: no toca SL)
      c(2, 111, 95, 108), // TP1 y low 95: NO es BE (el BE no rige aún) ni SL (95 > 90) → sigue viva
      c(3, 108, 99, 100), // low ≤ 100 → BE del runner
    ];
    const r = simulateTrade(longBase, candles, P);
    expect(r.trade?.exitReason).toBe('BE');
    expect(r.trade?.rMultiple).toBeCloseTo(0.5, 6);
    expect(r.trade?.barsHeld).toBe(3);
  });

  it('SL antes del TP1 → pérdida COMPLETA −1R (sin parcial)', () => {
    const candles = [
      c(1, 101, 99, 100), // llena
      c(2, 105, 89, 92), // SL (low ≤ 90) sin haber tocado 110
    ];
    const r = simulateTrade(longBase, candles, P);
    expect(r.trade?.tp1Filled).toBe(false);
    expect(r.trade?.exitReason).toBe('SL');
    expect(r.trade?.rMultiple).toBe(-1);
    expect(r.trade?.runnerExitReason).toBeUndefined();
  });

  it('TP1 y SL en la MISMA vela → pesimista: SL primero, −1R completo (el TP1 no se acredita)', () => {
    const candles = [
      c(1, 101, 99, 100), // llena
      c(2, 112, 89, 95), // toca 110 y 90 en la misma vela
    ];
    const r = simulateTrade(longBase, candles, P);
    expect(r.trade?.exitReason).toBe('SL');
    expect(r.trade?.tp1Filled).toBe(false);
    expect(r.trade?.rMultiple).toBe(-1);
  });

  it('vela gigante alcanza TP1 y TP2 juntos (sin SL): ambas piernas salen', () => {
    const candles = [
      c(1, 101, 99, 100), // llena
      c(2, 132, 100, 128), // cruza 110 y 130
    ];
    const r = simulateTrade(longBase, candles, P);
    expect(r.trade?.tp1Filled).toBe(true);
    expect(r.trade?.exitReason).toBe('TP');
    expect(r.trade?.rMultiple).toBeCloseTo(2.0, 6);
    expect(r.trade?.barsHeld).toBe(2); // vela del fill + la vela gigante de salida
  });

  it('fallback del TP2: sin pool (o pool ≤ TP1) el runner usa el TP nominal (2R)', () => {
    const sinPool = { ...longBase, runnerTakeProfit: undefined };
    const poolCerca = { ...longBase, runnerTakeProfit: 105 }; // ≤ TP1 (110) → fallback
    const candles = [
      c(1, 101, 99, 100), // llena
      c(2, 111, 100, 108), // TP1
      c(3, 121, 107, 119), // high ≥ 120 (TP nominal)
    ];
    for (const intent of [sinPool, poolCerca]) {
      const r = simulateTrade(intent, candles, P);
      expect(r.trade?.runnerTp).toBe(120);
      expect(r.trade?.exitReason).toBe('TP');
      expect(r.trade?.rMultiple).toBeCloseTo(0.5 * 1 + 0.5 * 2, 6); // 1.5
    }
  });

  it('partialFrac 0.3: pondera 30/70', () => {
    const candles = [c(1, 101, 99, 100), c(2, 111, 100, 108), c(3, 131, 107, 128)];
    const r = simulateTrade(longBase, candles, { ...P, partialFrac: 0.3 });
    expect(r.trade?.rMultiple).toBeCloseTo(0.3 * 1 + 0.7 * 3, 6); // 2.4
  });

  it('tp1AtR 0.5: el parcial dispara en +0.5R (105)', () => {
    const candles = [
      c(1, 101, 99, 100), // llena
      c(2, 106, 100, 104), // TP1 en 105
      c(3, 104, 99.8, 101), // BE del runner
    ];
    const r = simulateTrade(longBase, candles, { ...P, tp1AtR: 0.5 });
    expect(r.trade?.tp1Filled).toBe(true);
    expect(r.trade?.rMultiple).toBeCloseTo(0.5 * 0.5, 6); // +0.25R asegurado
  });

  it('endOfData con TP1 lleno: el runner cierra al último close', () => {
    const candles = [
      c(1, 101, 99, 100), // llena
      c(2, 111, 100, 108), // TP1
      c(3, 109, 104, 105), // sigue viva → fin de datos en close 105 (+0.5R la pierna runner)
    ];
    const r = simulateTrade(longBase, candles, P);
    expect(r.trade?.exitReason).toBe('endOfData');
    expect(r.trade?.rMultiple).toBeCloseTo(0.5 * 1 + 0.5 * 0.5, 6); // 0.75
  });

  it('la fase de fill sigue intacta: ranAway antes del fill cancela', () => {
    const intent = { ...longBase, cancelBeyond: 115 };
    const candles = [c(1, 116, 101, 114)]; // nunca llena (low > 100) y el precio se va
    const r = simulateTrade(intent, candles, P);
    expect(r.outcome).toBe('cancelled');
    expect(r.reason).toBe('ranAway');
  });
});

describe('partial-runner — SHORT espejo y fees por pierna', () => {
  it('SHORT: TP1 (+1R) → runner al pool (+3.5R)', () => {
    const shortIntent: TradeIntent = {
      ...longBase,
      id: 'p2',
      direction: 'SHORT',
      entry: 100,
      stopLoss: 110, // riesgo 10
      takeProfit: 80, // 2R nominal
      runnerTakeProfit: 65, // 3.5R
    };
    const candles = [
      c(1, 101, 99, 100), // llena (high ≥ 100)
      c(2, 100, 89, 92), // TP1 en 90 (low ≤ 90)
      c(3, 93, 64, 70), // TP2 en 65
    ];
    const r = simulateTrade(shortIntent, candles, P);
    expect(r.trade?.tp1Filled).toBe(true);
    expect(r.trade?.rMultiple).toBeCloseTo(0.5 * 1 + 0.5 * 3.5, 6); // 2.25
  });

  it('fees maker/taker por pierna: TP1 maker + runner BE taker ⇒ neto ≈ +frac·1R − costes, y > 0', () => {
    const cfg: Partial<SimConfig> = {
      ...P,
      feeRatePerSide: 0.0005,
      makerFee: 0.0002,
      takerFee: 0.0005,
    };
    // BE buffer = entry·(maker+taker) = 100·0.0007 = 0.07 → BE en 100.07
    const candles = [
      c(1, 101, 99, 100), // llena
      c(2, 111, 100.2, 108), // TP1 (110, maker)
      c(3, 108, 100.0, 101), // low ≤ 100.07 → runner BE (taker) ≈ 0R
    ];
    const r = simulateTrade(longBase, candles, cfg);
    // pierna TP1: (110−100 − 100·0.0002 − 110·0.0002)/10 = (10 − 0.02 − 0.022)/10 = 0.9958
    // pierna BE: (100.07−100 − 100·0.0002 − 100.07·0.0005)/10 ≈ (0.07 − 0.02 − 0.050035)/10 ≈ −0.0000035
    expect(r.trade?.rMultiple).toBeCloseTo(0.5 * 0.9958, 3);
    expect(r.trade?.rMultiple).toBeGreaterThan(0); // BE = cerrar EN GANANCIA (el parcial paga los costes)
  });
});
