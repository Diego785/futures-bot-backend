import { RiskGuard, evaluateOpen, dayKeyOf } from '../risk-guard';
import type { BracketPlan, RiskLimits, RiskState } from '../execution.types';

const LIMITS: RiskLimits = {
  maxConcurrentPositions: 3,
  maxNotionalPerOrderUsd: 400,
  maxMarginUsedUsd: 80,
  maxDailyLossR: 3,
  circuitBreakerLossR: 10,
  leverage: 5,
  symbols: ['ETHUSDT', 'BTCUSDT'],
  priceSanityFrac: 0.05,
};

// Día UTC fijo para los tests (Date.UTC es puro). notional 125 → margen 125/5 = 25.
const DAY_A = Date.UTC(2026, 5, 25, 10, 0, 0); // 2026-06-25
const DAY_B = Date.UTC(2026, 5, 26, 10, 0, 0); // 2026-06-26
const MARKET = 1618;

function plan(over: Partial<BracketPlan> = {}): BracketPlan {
  const order = (leg: 'ENTRY' | 'SL' | 'TP', price: string) => ({
    leg,
    clientOrderId: `c_${leg}`,
    symbol: 'ETHUSDT',
    side: 'BUY' as const,
    type: 'LIMIT' as const,
    quantity: '0.077',
    price,
    reduceOnly: false,
  });
  return {
    intentId: 'C_ETHUSDT_15m_1_u',
    symbol: 'ETHUSDT',
    direction: 'LONG',
    riskUsd: 0.5,
    stopDistance: 6.5,
    quantity: '0.077',
    notionalUsd: 125,
    entry: order('ENTRY', '1610'),
    stopLoss: order('SL', '1603.5'),
    takeProfit: order('TP', '1623'),
    ...over,
  };
}

function freshState(over: Partial<RiskState> = {}): RiskState {
  return {
    activeSlots: 0,
    marginUsedUsd: 0,
    dailyLossR: 0,
    cumulativeLossR: 0,
    realizedR: 0,
    dayKey: dayKeyOf(DAY_A),
    killed: false,
    killReason: null,
    ...over,
  };
}

describe('risk-guard · evaluateOpen (puro)', () => {
  it('permite cuando todo está dentro de los topes', () => {
    expect(evaluateOpen(plan(), MARKET, freshState(), LIMITS)).toEqual({ allow: true });
  });

  it('deniega si el kill-switch está activo', () => {
    const d = evaluateOpen(plan(), MARKET, freshState({ killed: true, killReason: 'manual' }), LIMITS);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain('kill-switch');
  });

  it('deniega símbolo fuera de whitelist', () => {
    const d = evaluateOpen(plan({ symbol: 'PEPEUSDT' }), MARKET, freshState(), LIMITS);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain('whitelist');
  });

  it('deniega al alcanzar el máximo de posiciones concurrentes', () => {
    const d = evaluateOpen(plan(), MARKET, freshState({ activeSlots: 3 }), LIMITS);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain('máx posiciones');
  });

  it('deniega si el nocional supera el tope por orden', () => {
    const d = evaluateOpen(plan({ notionalUsd: 401 }), MARKET, freshState(), LIMITS);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain('nocional');
  });

  it('deniega si el margen comprometido superaría el tope', () => {
    // margen usado 70 + nuevo 25 = 95 > 80
    const d = evaluateOpen(plan(), MARKET, freshState({ marginUsedUsd: 70 }), LIMITS);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain('margen');
  });

  it('deniega si la pérdida diaria alcanzó el corte', () => {
    const d = evaluateOpen(plan(), MARKET, freshState({ dailyLossR: 3 }), LIMITS);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain('pérdida diaria');
  });

  it('deniega si la entrada está demasiado lejos del mercado (sanity de precio)', () => {
    // entrada 1610 vs mercado 1800 → ~10.5% > 5%
    const d = evaluateOpen(plan(), 1800, freshState(), LIMITS);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain('del mercado');
  });

  it('no aplica el sanity de precio si no hay precio de mercado (0)', () => {
    expect(evaluateOpen(plan(), 0, freshState(), LIMITS)).toEqual({ allow: true });
  });
});

describe('risk-guard · RiskGuard (estado)', () => {
  it('tryReserve RESERVA slot+margen al permitir, y NO al denegar', () => {
    const g = new RiskGuard(LIMITS, DAY_A);
    expect(g.tryReserve(plan(), MARKET, DAY_A).allow).toBe(true);
    let s = g.snapshot();
    expect(s.activeSlots).toBe(1);
    expect(s.marginUsedUsd).toBeCloseTo(25, 6);

    // fuera de whitelist → denegada, sin reservar
    expect(g.tryReserve(plan({ symbol: 'PEPEUSDT' }), MARKET, DAY_A).allow).toBe(false);
    s = g.snapshot();
    expect(s.activeSlots).toBe(1);
    expect(s.marginUsedUsd).toBeCloseTo(25, 6);
  });

  it('release libera slot+margen sin tocar P&L', () => {
    const g = new RiskGuard(LIMITS, DAY_A);
    const p = plan();
    g.tryReserve(p, MARKET, DAY_A);
    g.release(p);
    const s = g.snapshot();
    expect(s.activeSlots).toBe(0);
    expect(s.marginUsedUsd).toBeCloseTo(0, 6);
    expect(s.realizedR).toBe(0);
  });

  it('máximo de posiciones: la 4ª simultánea se deniega', () => {
    const g = new RiskGuard(LIMITS, DAY_A);
    expect(g.tryReserve(plan({ intentId: 'a' }), MARKET, DAY_A).allow).toBe(true);
    expect(g.tryReserve(plan({ intentId: 'b' }), MARKET, DAY_A).allow).toBe(true);
    expect(g.tryReserve(plan({ intentId: 'c' }), MARKET, DAY_A).allow).toBe(true);
    const d = g.tryReserve(plan({ intentId: 'd' }), MARKET, DAY_A);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain('máx posiciones');
  });

  it('settle con ganancia: libera y suma R, sin pérdida', () => {
    const g = new RiskGuard(LIMITS, DAY_A);
    const p = plan();
    g.tryReserve(p, MARKET, DAY_A);
    g.settle(p, 1.87, DAY_A);
    const s = g.snapshot();
    expect(s.activeSlots).toBe(0);
    expect(s.realizedR).toBeCloseTo(1.87, 6);
    expect(s.dailyLossR).toBe(0);
    expect(s.cumulativeLossR).toBe(0);
  });

  it('settle con pérdida: suma a pérdida diaria y acumulada', () => {
    const g = new RiskGuard(LIMITS, DAY_A);
    const p = plan();
    g.tryReserve(p, MARKET, DAY_A);
    g.settle(p, -1.14, DAY_A);
    const s = g.snapshot();
    expect(s.dailyLossR).toBeCloseTo(1.14, 6);
    expect(s.cumulativeLossR).toBeCloseTo(1.14, 6);
    expect(s.realizedR).toBeCloseTo(-1.14, 6);
  });

  it('corte diario: tras perder ≥3R en el día, bloquea nuevas aperturas', () => {
    const g = new RiskGuard(LIMITS, DAY_A);
    for (const id of ['a', 'b', 'c']) {
      const p = plan({ intentId: id });
      g.tryReserve(p, MARKET, DAY_A);
      g.settle(p, -1.1, DAY_A); // 3 × −1.1 = −3.3R
    }
    const d = g.tryReserve(plan({ intentId: 'x' }), MARKET, DAY_A);
    expect(d.allow).toBe(false);
    if (!d.allow) expect(d.reason).toContain('pérdida diaria');
  });

  it('el corte diario se auto-levanta al cambiar de día UTC', () => {
    const g = new RiskGuard(LIMITS, DAY_A);
    const p = plan();
    g.tryReserve(p, MARKET, DAY_A);
    g.settle(p, -3.3, DAY_A); // supera el corte diario
    expect(g.tryReserve(plan({ intentId: 'x' }), MARKET, DAY_A).allow).toBe(false);
    // día siguiente → pérdida diaria reseteada → permite (la acumulada 3.3 < 10, no hay circuit breaker)
    expect(g.tryReserve(plan({ intentId: 'y' }), MARKET, DAY_B).allow).toBe(true);
    expect(g.snapshot().dailyLossR).toBe(0);
    expect(g.snapshot().cumulativeLossR).toBeCloseTo(3.3, 6);
  });

  it('circuit breaker: la pérdida acumulada ≥10R activa el kill permanente', () => {
    const g = new RiskGuard(LIMITS, DAY_A);
    // Acumula pérdidas a lo largo de varios días (para no toparse con el corte diario)
    let day = DAY_A;
    for (let i = 0; i < 10; i++) {
      const p = plan({ intentId: `i${i}` });
      g.tryReserve(p, MARKET, day);
      g.settle(p, -1.1, day);
      day += 86_400_000; // +1 día
    }
    expect(g.isKilled()).toBe(true);
    expect(g.snapshot().killReason).toContain('circuit breaker');
    // killed bloquea aunque sea un día nuevo
    expect(g.tryReserve(plan({ intentId: 'z' }), MARKET, day).allow).toBe(false);
  });

  it('breaker NETO: 11R brutos de pérdidas con ganancias que compensan NO mata (bug del fill ~15)', () => {
    const g = new RiskGuard(LIMITS, DAY_A);
    let day = DAY_A;
    // 10 pérdidas −1.1 (bruto 11R) intercaladas con 9 ganancias +1.38 → neto ≈ +1.42R
    for (let i = 0; i < 10; i++) {
      const p = plan({ intentId: `l${i}` });
      g.tryReserve(p, MARKET, day);
      g.settle(p, -1.1, day);
      if (i < 9) {
        const w = plan({ intentId: `w${i}` });
        g.tryReserve(w, MARKET, day);
        g.settle(w, 1.38, day);
      }
      day += 86_400_000; // día nuevo (el corte diario no interfiere)
    }
    expect(g.snapshot().cumulativeLossR).toBeCloseTo(11, 6); // la bruta se sigue observando
    expect(g.isKilled()).toBe(false); // pero NO mata: la neta es positiva
    expect(g.tryReserve(plan({ intentId: 'z' }), MARKET, day).allow).toBe(true);
  });

  it('restore: bruta ≥10R pero neta positiva → NO arranca killed', () => {
    const g = new RiskGuard(LIMITS, DAY_B);
    const rows: { r: number; time: number }[] = [];
    for (let i = 0; i < 10; i++) {
      rows.push({ r: -1.1, time: DAY_A + i });
      rows.push({ r: 1.38, time: DAY_A + i });
    }
    g.restoreFromHistory(rows, DAY_B);
    expect(g.snapshot().cumulativeLossR).toBeCloseTo(11, 6);
    expect(g.isKilled()).toBe(false);
  });

  it('kill/unkill manual', () => {
    const g = new RiskGuard(LIMITS, DAY_A);
    g.kill('manual');
    expect(g.isKilled()).toBe(true);
    expect(g.tryReserve(plan(), MARKET, DAY_A).allow).toBe(false);
    g.unkill();
    expect(g.isKilled()).toBe(false);
    expect(g.tryReserve(plan(), MARKET, DAY_A).allow).toBe(true);
  });
});

describe('risk-guard · restoreFromHistory (reinicios no borran la contabilidad)', () => {
  it('re-siembra realized/diaria/acumulada desde cierres persistidos', () => {
    const g = new RiskGuard(LIMITS, DAY_B);
    g.restoreFromHistory(
      [
        { r: 1.5, time: DAY_A }, // ganancia de ayer: solo realized
        { r: -1.2, time: DAY_A }, // pérdida de AYER: acumulada, no diaria
        { r: -1.1, time: DAY_B }, // pérdida de HOY: acumulada + diaria
      ],
      DAY_B,
    );
    const s = g.snapshot();
    expect(s.realizedR).toBeCloseTo(-0.8, 6);
    expect(s.cumulativeLossR).toBeCloseTo(2.3, 6);
    expect(s.dailyLossR).toBeCloseTo(1.1, 6);
    expect(s.killed).toBe(false);
  });

  it('si el historial ya cruzó el circuit breaker → arranca KILLED', () => {
    const g = new RiskGuard(LIMITS, DAY_B);
    const losses = Array.from({ length: 10 }, (_, i) => ({ r: -1.1, time: DAY_A + i }));
    g.restoreFromHistory(losses, DAY_B);
    expect(g.isKilled()).toBe(true);
    expect(g.snapshot().killReason).toContain('restaurado');
    expect(g.tryReserve(plan(), MARKET, DAY_B).allow).toBe(false);
  });
});

describe('risk-guard · dayKeyOf', () => {
  it('da YYYY-MM-DD UTC', () => {
    expect(dayKeyOf(DAY_A)).toBe('2026-06-25');
    expect(dayKeyOf(DAY_B)).toBe('2026-06-26');
  });
});
