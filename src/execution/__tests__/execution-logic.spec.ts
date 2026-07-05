import {
  reachedCancelBeyond,
  breakevenTriggerLevel,
  reachedBreakeven,
  computeRealizedR,
  computeRealizedRPartial,
  estimateFeesUsd,
} from '../execution-logic';
import type { TradeIntent } from '../../backtest/trade-simulator';

function intent(over: Partial<TradeIntent> = {}): TradeIntent {
  return {
    id: 'x',
    symbol: 'ETHUSDT',
    tf: '15m',
    direction: 'LONG',
    signalBarTime: 1,
    entry: 100,
    stopLoss: 99,
    takeProfit: 102, // 2R
    cancelBeyond: 103,
    ...over,
  };
}

describe('execution-logic · reachedCancelBeyond', () => {
  it('LONG: dispara si el high cruza el cancelBeyond (precio corrió hacia arriba)', () => {
    expect(reachedCancelBeyond(intent(), 103, 101)).toBe(true);
    expect(reachedCancelBeyond(intent(), 102.9, 100)).toBe(false);
  });

  it('SHORT: dispara si el low cruza el cancelBeyond (hacia abajo)', () => {
    const s = intent({ direction: 'SHORT', entry: 100, stopLoss: 101, takeProfit: 98, cancelBeyond: 97 });
    expect(reachedCancelBeyond(s, 100, 97)).toBe(true);
    expect(reachedCancelBeyond(s, 100, 97.1)).toBe(false);
  });

  it('sin cancelBeyond → nunca dispara', () => {
    expect(reachedCancelBeyond(intent({ cancelBeyond: undefined }), 999, 0)).toBe(false);
  });
});

describe('execution-logic · break-even', () => {
  it('nivel de BE = entrada + frac·(TP − entrada)', () => {
    expect(breakevenTriggerLevel(intent(), 0.5)).toBeCloseTo(101, 6); // 100 + 0.5·2
    const s = intent({ direction: 'SHORT', entry: 100, takeProfit: 96 });
    expect(breakevenTriggerLevel(s, 0.5)).toBeCloseTo(98, 6); // 100 + 0.5·(−4)
  });

  it('LONG: dispara cuando el high alcanza el nivel', () => {
    expect(reachedBreakeven(intent(), 101, 100, 0.5)).toBe(true);
    expect(reachedBreakeven(intent(), 100.9, 100, 0.5)).toBe(false);
  });

  it('SHORT: dispara cuando el low alcanza el nivel', () => {
    const s = intent({ direction: 'SHORT', entry: 100, stopLoss: 101, takeProfit: 96 });
    expect(reachedBreakeven(s, 100, 98, 0.5)).toBe(true);
    expect(reachedBreakeven(s, 100, 98.1, 0.5)).toBe(false);
  });
});

describe('execution-logic · computeRealizedR', () => {
  it('LONG ganador a TP (fill en CE, sin fees) ≈ 2R', () => {
    // entrada 100, SL 99 → riesgo 1; salida 102 → (102−100)/1 = 2R
    expect(computeRealizedR(intent(), 100, 102, 0, 1)).toBeCloseTo(2, 6);
  });

  it('LONG perdedor a SL (fill en CE) ≈ −1R', () => {
    expect(computeRealizedR(intent(), 100, 99, 0, 1)).toBeCloseTo(-1, 6);
  });

  it('SHORT ganador a TP ≈ 2R', () => {
    const s = intent({ direction: 'SHORT', entry: 100, stopLoss: 101, takeProfit: 98 });
    // riesgo 1; salida 98 → (100−98)/1 = 2R
    expect(computeRealizedR(s, 100, 98, 0, 1)).toBeCloseTo(2, 6);
  });

  it('fill mejor que el CE aumenta la R (entrada más barata)', () => {
    // fill 99.5 (por debajo del CE 100), TP 102 → (102−99.5)/1 = 2.5R
    expect(computeRealizedR(intent(), 99.5, 102, 0, 1)).toBeCloseTo(2.5, 6);
  });

  it('las fees restan R (en unidades del riesgo en USD)', () => {
    // riesgo USD = qty·|entry−SL| = 1·1 = 1. fee $0.1 → feeR 0.1. grossR 2 → neto 1.9
    expect(computeRealizedR(intent(), 100, 102, 0.1, 1)).toBeCloseTo(1.9, 6);
  });

  it('riesgo o qty no positivos → 0 (defensivo)', () => {
    expect(computeRealizedR(intent({ stopLoss: 100 }), 100, 102, 0, 1)).toBe(0);
    expect(computeRealizedR(intent(), 100, 102, 0, 0)).toBe(0);
  });
});

describe('execution-logic · estimateFeesUsd', () => {
  it('entrada maker + salida taker sobre el nocional por lado', () => {
    // 100·1·0.0002 + 102·1·0.0005 = 0.02 + 0.051 = 0.071
    expect(estimateFeesUsd(100, 102, 1, 0.0002, 0.0005)).toBeCloseTo(0.071, 6);
  });
});

describe('execution-logic · computeRealizedRPartial (v2)', () => {
  // intent(): entry 100, SL 99 → riesgo 1. Sin fees para la lógica pura.
  it('TP1 a +1R (50%) + runner a +2R (50%) ≈ 1.5R', () => {
    const legs = [
      { price: 101, qty: 0.5, feeUsd: 0 },
      { price: 102, qty: 0.5, feeUsd: 0 },
    ];
    expect(computeRealizedRPartial(intent(), 100, legs, 0)).toBeCloseTo(1.5, 6);
  });

  it('TP1 (50%) + runner en BE ≈ +0.5R — el trade cierra EN GANANCIA', () => {
    const legs = [
      { price: 101, qty: 0.5, feeUsd: 0 },
      { price: 100, qty: 0.5, feeUsd: 0 },
    ];
    const r = computeRealizedRPartial(intent(), 100, legs, 0);
    expect(r).toBeCloseTo(0.5, 6);
    expect(r).toBeGreaterThan(0);
  });

  it('SL antes del TP1 (una sola pierna completa) = −1R', () => {
    expect(computeRealizedRPartial(intent(), 100, [{ price: 99, qty: 1, feeUsd: 0 }], 0)).toBeCloseTo(-1, 6);
  });

  it('SHORT espejo: TP1 −1R abajo + runner −2R abajo ≈ 1.5R', () => {
    const s = intent({ direction: 'SHORT', entry: 100, stopLoss: 101, takeProfit: 98 });
    const legs = [
      { price: 99, qty: 0.5, feeUsd: 0 },
      { price: 98, qty: 0.5, feeUsd: 0 },
    ];
    expect(computeRealizedRPartial(s, 100, legs, 0)).toBeCloseTo(1.5, 6);
  });

  it('las fees (entrada + por pierna) restan sobre el riesgo total en USD', () => {
    // riesgo total USD = 1·1 = 1. gross = 1.5. fees = 0.1 entrada + 0.05+0.05 salidas = 0.2 → 1.3R
    const legs = [
      { price: 101, qty: 0.5, feeUsd: 0.05 },
      { price: 102, qty: 0.5, feeUsd: 0.05 },
    ];
    expect(computeRealizedRPartial(intent(), 100, legs, 0.1)).toBeCloseTo(1.3, 6);
  });

  it('fill de entrada mejor que el CE aumenta la R (denominador = riesgo PLANEADO)', () => {
    // entrada real 99.5: gross = (101−99.5)·0.5 + (102−99.5)·0.5 = 0.75 + 1.25 = 2.0 → 2R
    const legs = [
      { price: 101, qty: 0.5, feeUsd: 0 },
      { price: 102, qty: 0.5, feeUsd: 0 },
    ];
    expect(computeRealizedRPartial(intent(), 99.5, legs, 0)).toBeCloseTo(2.0, 6);
  });

  it('qty asimétrica pondera bien (30/70)', () => {
    const legs = [
      { price: 101, qty: 0.3, feeUsd: 0 },
      { price: 102, qty: 0.7, feeUsd: 0 },
    ];
    // gross = 1·0.3 + 2·0.7 = 1.7 / (1·1) = 1.7R
    expect(computeRealizedRPartial(intent(), 100, legs, 0)).toBeCloseTo(1.7, 6);
  });

  it('defensivo: sin piernas o riesgo nulo → 0', () => {
    expect(computeRealizedRPartial(intent(), 100, [], 0)).toBe(0);
    expect(computeRealizedRPartial(intent({ stopLoss: 100 }), 100, [{ price: 101, qty: 1, feeUsd: 0 }], 0)).toBe(0);
  });
});
