import { planBracket, planBreakeven, clientOrderIdFor } from '../order-plan';
import type { TradeIntent } from '../../backtest/trade-simulator';
import type { SymbolFilters } from '../execution.types';

const F: SymbolFilters = { tickSize: '0.01', stepSize: '0.001', minNotional: 5 };

function intent(over: Partial<TradeIntent> = {}): TradeIntent {
  return {
    id: 'C_ETHUSDT_15m_1782253800000_u',
    symbol: 'ETHUSDT',
    tf: '15m',
    direction: 'LONG',
    signalBarTime: 1782253800000,
    entry: 100,
    stopLoss: 99.6,
    takeProfit: 100.8,
    ...over,
  };
}

describe('order-plan · planBracket', () => {
  it('LONG: qty = riesgo/dist (floor al step), lados y tipos correctos', () => {
    const r = planBracket(intent(), 0.5, F, 400);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // dist ≈0.4, riesgo 0.5 → ≈1.25; FLOOR al step (≤1 step bajo el ideal por el float = conservador)
    expect(parseFloat(r.plan.quantity)).toBeCloseTo(1.25, 2);
    expect(r.plan.notionalUsd).toBeGreaterThan(124);
    expect(r.plan.notionalUsd).toBeLessThanOrEqual(125.01);
    expect(r.plan.entry).toMatchObject({ side: 'BUY', type: 'LIMIT', price: '100.00', reduceOnly: false });
    expect(r.plan.stopLoss).toMatchObject({ side: 'SELL', type: 'STOP_MARKET', stopPrice: '99.60', reduceOnly: true });
    expect(r.plan.takeProfit).toMatchObject({ side: 'SELL', type: 'TAKE_PROFIT_MARKET', stopPrice: '100.80', reduceOnly: true });
  });

  it('SHORT: lados invertidos', () => {
    const r = planBracket(intent({ direction: 'SHORT', entry: 100, stopLoss: 100.4, takeProfit: 99.2 }), 0.5, F, 400);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.entry.side).toBe('SELL');
    expect(r.plan.stopLoss.side).toBe('BUY');
    expect(r.plan.takeProfit.side).toBe('BUY');
    expect(parseFloat(r.plan.quantity)).toBeCloseTo(1.25, 2);
  });

  it('el riesgo escala la cantidad linealmente', () => {
    const r = planBracket(intent(), 1.0, F, 400);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(parseFloat(r.plan.quantity)).toBeCloseTo(2.5, 2);
  });

  it('redondea el precio al tickSize y la qty hace FLOOR al stepSize', () => {
    const coarse: SymbolFilters = { tickSize: '0.5', stepSize: '0.01', minNotional: 5 };
    const r = planBracket(intent({ entry: 100.37, stopLoss: 99.91, takeProfit: 101.29 }), 0.5, coarse, 4000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.entry.price).toBe('100.5'); // 100.37 → tick 0.5 (1 decimal)
    expect(parseFloat(r.plan.quantity)).toBeGreaterThan(0); // qty > 0 tras FLOOR al step
  });

  describe('rechazos (el executor SALTA, no coloca a ciegas)', () => {
    it('minNotional: nocional por debajo del mínimo', () => {
      const r = planBracket(intent(), 0.5, { ...F, minNotional: 200 }, 400);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('minNotional');
    });

    it('maxNotional: nocional sobre el tope duro', () => {
      const r = planBracket(intent(), 0.5, F, 50); // notional 125 > 50
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('maxNotional');
    });

    it('zeroQty: la qty hace floor a 0', () => {
      const r = planBracket(intent({ stopLoss: 0.0001 }), 0.5, { ...F, stepSize: '1' }, 400);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('zeroQty');
    });

    it('badPrices: LONG con SL por encima de la entrada', () => {
      const r = planBracket(intent({ stopLoss: 101 }), 0.5, F, 400);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('badPrices');
    });

    it('badPrices: SHORT con TP por encima de la entrada', () => {
      const r = planBracket(intent({ direction: 'SHORT', entry: 100, stopLoss: 100.4, takeProfit: 101 }), 0.5, F, 400);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('badPrices');
    });

    it('symbolUnknown: sin filtros', () => {
      const r = planBracket(intent(), 0.5, undefined, 400);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toBe('symbolUnknown');
    });
  });
});

describe('order-plan · clientOrderId', () => {
  it('determinista, ≤36 chars, distinto por leg', () => {
    const i = intent();
    const e = clientOrderIdFor(i, 'ENTRY');
    const s = clientOrderIdFor(i, 'SL');
    const t = clientOrderIdFor(i, 'TP');
    expect(e).toBe(clientOrderIdFor(i, 'ENTRY')); // mismo input → mismo id (idempotencia)
    expect(new Set([e, s, t]).size).toBe(3); // distintos por leg
    for (const id of [e, s, t]) {
      expect(id.length).toBeLessThanOrEqual(36);
      expect(id).toMatch(/^[A-Za-z0-9_]+$/);
    }
  });

  it('el plan usa los ids deterministas', () => {
    const r = planBracket(intent(), 0.5, F, 400);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.entry.clientOrderId).toBe(clientOrderIdFor(intent(), 'ENTRY'));
    expect(r.plan.stopLoss.clientOrderId).toBe(clientOrderIdFor(intent(), 'SL'));
  });
});

describe('order-plan · pierna TP1 (v2 partial-runner)', () => {
  const PARTIAL = { tp1AtR: 1, partialFrac: 0.5 };

  it('LONG: TP1 = LIMIT reduceOnly de la mitad en entry + 1R, y runnerQuantity = el resto', () => {
    const r = planBracket(intent(), 0.5, F, 400, PARTIAL);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const tp1 = r.plan.takeProfitPartial;
    expect(tp1).toBeDefined();
    expect(tp1).toMatchObject({ leg: 'TP1', side: 'SELL', type: 'LIMIT', reduceOnly: true });
    // riesgo = |100 − 99.6| ≈ 0.4 → TP1 ≈ 100.4 (al tick)
    expect(parseFloat(tp1?.price as string)).toBeCloseTo(100.4, 1);
    const qty1 = parseFloat(tp1?.quantity as string);
    const rest = parseFloat(r.plan.runnerQuantity as string);
    expect(qty1).toBeGreaterThan(0);
    expect(rest).toBeGreaterThan(0);
    expect(qty1 + rest).toBeCloseTo(parseFloat(r.plan.quantity), 6);
    expect(tp1?.clientOrderId).not.toBe(r.plan.takeProfit.clientOrderId); // legs con id propio
  });

  it('SHORT: TP1 por debajo de la entrada, BUY reduceOnly', () => {
    const r = planBracket(
      intent({ direction: 'SHORT', entry: 100, stopLoss: 100.4, takeProfit: 99.2 }),
      0.5,
      F,
      400,
      PARTIAL,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.takeProfitPartial?.side).toBe('BUY');
    expect(parseFloat(r.plan.takeProfitPartial?.price as string)).toBeCloseTo(99.6, 1);
  });

  it('posición de 1 step: la fracción redondea a 0 → DEGRADA a full (sin TP1), nunca qty 0', () => {
    // qty total = 1.25 → floor a step '1' = 1; 50% de 1 → floor 0 → sin pierna parcial
    const r = planBracket(intent({ entry: 100, stopLoss: 99.6, takeProfit: 100.8 }), 0.5, { ...F, stepSize: '1', minNotional: 5 }, 400, PARTIAL);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(parseFloat(r.plan.quantity)).toBe(1);
    expect(r.plan.takeProfitPartial).toBeUndefined();
    expect(r.plan.runnerQuantity).toBeUndefined();
  });

  it('sin config parcial → bracket v1 idéntico (sin TP1)', () => {
    const r = planBracket(intent(), 0.5, F, 400);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.takeProfitPartial).toBeUndefined();
  });
});

describe('order-plan · planBreakeven', () => {
  it('LONG: BE por encima de la entrada, SELL stop reduceOnly', () => {
    const be = planBreakeven(intent(), '1.250', F);
    expect(be).toMatchObject({ side: 'SELL', type: 'STOP_MARKET', reduceOnly: true });
    expect(parseFloat(be.stopPrice as string)).toBeGreaterThan(100);
  });

  it('SHORT: BE por debajo de la entrada, BUY stop', () => {
    const be = planBreakeven(intent({ direction: 'SHORT', entry: 100, stopLoss: 100.4, takeProfit: 99.2 }), '1.250', F);
    expect(be.side).toBe('BUY');
    expect(parseFloat(be.stopPrice as string)).toBeLessThan(100);
  });
});
