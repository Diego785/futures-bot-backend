import {
  simulateTrade,
  simulateAll,
  type SimCandle,
  type TradeIntent,
} from '../trade-simulator';

// Helper de vela de ejecución (open no se usa). openTime = índice para legibilidad.
const c = (openTime: number, high: number, low: number, close: number): SimCandle => ({
  openTime,
  high,
  low,
  close,
});

// Intent LONG base: entry 100, SL 90 (risk = 10), TP 120 (2R nominal). Señal en la vela 0.
const longBase: TradeIntent = {
  id: 't1',
  symbol: 'BTCUSDT',
  tf: '15m',
  direction: 'LONG',
  signalBarTime: 0,
  entry: 100,
  stopLoss: 90,
  takeProfit: 120,
};

// Sin costes para los tests de lógica pura (los costes se prueban aparte).
const NO_COST = { feeRatePerSide: 0, slippagePerSide: 0 };

describe('simulateTrade — salidas básicas (LONG, sin costes)', () => {
  it('TP: llena y alcanza el objetivo → +2R', () => {
    const candles = [
      c(1, 101, 99, 100), // llena (low ≤ 100)
      c(2, 125, 100, 120), // TP (high ≥ 120)
    ];
    const r = simulateTrade(longBase, candles, NO_COST);
    expect(r.outcome).toBe('filled');
    expect(r.trade?.exitReason).toBe('TP');
    expect(r.trade?.rMultiple).toBe(2);
    expect(r.trade?.barsToFill).toBe(0);
    expect(r.trade?.barsHeld).toBe(2);
  });

  it('SL: llena y se va en contra → −1R', () => {
    const candles = [
      c(1, 100, 100, 95), // llena
      c(2, 96, 88, 89), // SL (low ≤ 90)
    ];
    const r = simulateTrade(longBase, candles, NO_COST);
    expect(r.outcome).toBe('filled');
    expect(r.trade?.exitReason).toBe('SL');
    expect(r.trade?.rMultiple).toBe(-1);
  });

  it('SL y TP en la misma vela → pesimista: SL (−1R)', () => {
    const intent = { ...longBase, takeProfit: 110 };
    const candles = [
      c(1, 100, 100, 100), // llena
      c(2, 115, 85, 100), // toca TP(110) y SL(90) → SL
    ];
    const r = simulateTrade(intent, candles, NO_COST);
    expect(r.trade?.exitReason).toBe('SL');
    expect(r.trade?.rMultiple).toBe(-1);
  });

  it('SL y TP en la misma vela con pessimisticSameBar=false → TP (+1R)', () => {
    const intent = { ...longBase, takeProfit: 110 };
    const candles = [c(1, 100, 100, 100), c(2, 115, 85, 100)];
    const r = simulateTrade(intent, candles, { ...NO_COST, pessimisticSameBar: false });
    expect(r.trade?.exitReason).toBe('TP');
    expect(r.trade?.rMultiple).toBe(1);
  });

  it('knife: llena y pega el SL en la MISMA vela → −1R (barsHeld 1)', () => {
    const intent = { ...longBase, stopLoss: 95 }; // risk 5
    const candles = [
      c(1, 101, 90, 96), // low 90 llena (≤100) y también ≤ SL 95 → SL mismo bar
    ];
    const r = simulateTrade(intent, candles, NO_COST);
    expect(r.trade?.exitReason).toBe('SL');
    expect(r.trade?.rMultiple).toBe(-1);
    expect(r.trade?.barsToFill).toBe(0);
    expect(r.trade?.barsHeld).toBe(1);
  });
});

describe('simulateTrade — break-even', () => {
  it('alcanza 50 % del recorrido y revierte a entrada → BE ≈ 0R', () => {
    const candles = [
      c(1, 100, 100, 100), // llena
      c(2, 112, 101, 110), // favorable 112 → progreso 0.6 ≥ 0.5 → BE arma SL=entrada (vela siguiente)
      c(3, 105, 99, 100), // low 99 ≤ SL(100) → sale en BE
    ];
    const r = simulateTrade(longBase, candles, NO_COST);
    expect(r.trade?.exitReason).toBe('BE');
    expect(r.trade?.movedToBE).toBe(true);
    expect(r.trade?.rMultiple).toBe(0);
  });

  it('el BE no surte efecto en la MISMA vela que lo arma (causal)', () => {
    // La vela que arma el BE no debe poder salir en BE por su propio low: el SL nuevo rige la SIGUIENTE.
    const candles = [
      c(1, 100, 100, 100), // llena
      c(2, 112, 95, 110), // arma BE; su low 95 NO debe ejecutar el nuevo SL(100) este mismo bar
      c(3, 130, 121, 125), // TP (high ≥ 120) al bar siguiente
    ];
    const r = simulateTrade(longBase, candles, NO_COST);
    expect(r.trade?.exitReason).toBe('TP');
    expect(r.trade?.rMultiple).toBe(2);
  });
});

describe('simulateTrade — costes', () => {
  it('fees taker recortan la R por debajo del nominal', () => {
    const candles = [c(1, 101, 99, 100), c(2, 125, 100, 120)];
    const r = simulateTrade(longBase, candles, { feeRatePerSide: 0.0005, slippagePerSide: 0 });
    // netPrice = (120−100) − (100+120)*0.0005 = 20 − 0.11 = 19.89 → 1.989R
    expect(r.trade?.grossR).toBe(2);
    expect(r.trade?.rMultiple).toBe(1.989);
    expect(r.trade?.costR).toBe(0.011);
  });

  it('slippage adverso entra peor y sale peor', () => {
    const candles = [c(1, 101, 99, 100), c(2, 125, 100, 120)];
    const r = simulateTrade(longBase, candles, { feeRatePerSide: 0, slippagePerSide: 1 });
    // entryFill 101, exitFill 119 → (119−101)/10 = 1.8R
    expect(r.trade?.entryPrice).toBe(101);
    expect(r.trade?.exitPrice).toBe(119);
    expect(r.trade?.rMultiple).toBe(1.8);
  });
});

describe('simulateTrade — fees maker/taker', () => {
  it('TP paga maker en ambos lados (entrada límite + salida límite)', () => {
    const candles = [c(1, 101, 99, 100), c(2, 125, 100, 120)];
    const r = simulateTrade(longBase, candles, { makerFee: 0.0002, takerFee: 0.0005, slippagePerSide: 0 });
    // netPrice = (120−100) − 100*0.0002 − 120*0.0002 = 20 − 0.044 = 19.956 → 1.9956R
    expect(r.trade?.exitReason).toBe('TP');
    expect(r.trade?.rMultiple).toBe(1.9956);
  });

  it('SL paga maker en la entrada y taker en la salida (stop-market)', () => {
    const candles = [c(1, 100, 100, 95), c(2, 96, 88, 89)];
    const r = simulateTrade(longBase, candles, { makerFee: 0.0002, takerFee: 0.0005, slippagePerSide: 0 });
    // netPrice = (90−100) − 100*0.0002 − 90*0.0005 = −10 − 0.065 = −10.065 → −1.0065R
    expect(r.trade?.exitReason).toBe('SL');
    expect(r.trade?.rMultiple).toBe(-1.0065);
  });
});

describe('simulateTrade — SHORT', () => {
  it('TP en short → +2R', () => {
    const shortBase: TradeIntent = {
      ...longBase,
      id: 's1',
      direction: 'SHORT',
      entry: 100,
      stopLoss: 110, // risk 10
      takeProfit: 80,
    };
    const candles = [
      c(1, 101, 99, 100), // high 101 ≥ 100 → llena
      c(2, 100, 75, 80), // low 75 ≤ 80 → TP
    ];
    const r = simulateTrade(shortBase, candles, NO_COST);
    expect(r.trade?.exitReason).toBe('TP');
    expect(r.trade?.rMultiple).toBe(2);
  });
});

describe('simulateTrade — cancelaciones (no es trade)', () => {
  it('ranAway: el precio se aleja sin llenar → cancelled', () => {
    const intent = { ...longBase, cancelBeyond: 105 };
    const candles = [
      c(1, 106, 101, 104), // no llena (low 101 > 100) y high 106 ≥ 105 → se fue
    ];
    const r = simulateTrade(intent, candles, NO_COST);
    expect(r.outcome).toBe('cancelled');
    expect(r.reason).toBe('ranAway');
    expect(r.trade).toBeUndefined();
  });

  it('maxWaitFill: expira antes de poder llenar → cancelled', () => {
    const intent = { ...longBase };
    const candles = [
      c(1, 102, 101, 101), // offset 0, no llena
      c(2, 102, 101, 101), // offset 1, no llena
      c(3, 102, 99, 100), // offset 2 ≥ maxWaitFillBars(2) → cancela antes de intentar fill
    ];
    const r = simulateTrade(intent, candles, { ...NO_COST, maxWaitFillBars: 2 });
    expect(r.outcome).toBe('cancelled');
    expect(r.reason).toBe('maxWaitFill');
  });

  it('badRisk: entry == SL → cancelled', () => {
    const intent = { ...longBase, stopLoss: 100 };
    const r = simulateTrade(intent, [c(1, 101, 99, 100)], NO_COST);
    expect(r.outcome).toBe('cancelled');
    expect(r.reason).toBe('badRisk');
  });
});

describe('simulateTrade — bordes de datos y causalidad', () => {
  it('nunca llena dentro de los datos → expired (noFill)', () => {
    const candles = [c(1, 105, 101, 103), c(2, 106, 102, 104)];
    const r = simulateTrade(longBase, candles, NO_COST);
    expect(r.outcome).toBe('expired');
    expect(r.reason).toBe('noFill');
  });

  it('llena pero no cierra → endOfData al último cierre', () => {
    const intent = { ...longBase, takeProfit: 200 };
    const candles = [
      c(1, 100, 100, 100), // llena
      c(2, 105, 98, 102), // sin SL/TP
    ];
    const r = simulateTrade(intent, candles, NO_COST);
    expect(r.trade?.exitReason).toBe('endOfData');
    expect(r.trade?.rMultiple).toBe(0.2); // (102−100)/10
  });

  it('causalidad: ignora la propia vela de señal (lookahead = 0)', () => {
    // La vela 0 (= signalBarTime) llenaría y daría TP, pero NO debe usarse.
    const candles = [
      c(0, 200, 50, 100), // vela de la señal: se ignora
      c(1, 105, 101, 103), // posteriores nunca bajan al entry 100 (low 101 > 100) → no llena
    ];
    const r = simulateTrade(longBase, candles, NO_COST);
    expect(r.outcome).toBe('expired');
    expect(r.reason).toBe('noFill');
  });
});

describe('simulateAll', () => {
  it('simula cada intent de forma independiente', () => {
    const candles = [c(1, 101, 99, 100), c(2, 125, 100, 120)];
    const intents: TradeIntent[] = [longBase, { ...longBase, id: 't2' }];
    const rs = simulateAll(intents, candles, NO_COST);
    expect(rs).toHaveLength(2);
    expect(rs.every((r) => r.outcome === 'filled' && r.trade?.rMultiple === 2)).toBe(true);
    expect(rs.map((r) => r.intentId)).toEqual(['t1', 't2']);
  });
});
