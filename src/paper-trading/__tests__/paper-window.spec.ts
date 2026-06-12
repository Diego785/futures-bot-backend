import { PaperEngine, type PaperCandle } from '../paper-engine';
import { computePenetrations, toPaperTradeRow } from '../paper-row.mapper';
import { runBacktest } from '../../backtest/backtest.runner';

// Serie DETERMINISTA pseudo-aleatoria (LCG): random walk con mechas — produce sweeps reales sin
// depender de fixtures a mano. Misma semilla → misma serie → test estable.
function syntheticSeries(n: number, seed = 42): PaperCandle[] {
  let s = seed;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
  const out: PaperCandle[] = [];
  let price = 1000;
  for (let i = 0; i < n; i++) {
    const drift = (rnd() - 0.5) * 8;
    const open = price;
    const close = Math.max(price + drift, 50);
    const wickUp = rnd() * 6;
    const wickDown = rnd() * 6;
    out.push({
      openTime: i * 900_000,
      open,
      high: Math.max(open, close) + wickUp,
      low: Math.min(open, close) - wickDown,
      close,
      closeTime: (i + 1) * 900_000 - 1,
    });
    price = close;
  }
  return out;
}

const CFG = { gatillo: 'C' as const, tpRule: 'fixedR' as const, swingLookback: 5 };
const SIM = { feeRatePerSide: 0, slippagePerSide: 0 };

describe('PaperEngine — ventana segura (P.2, condición de equivalencia del gate)', () => {
  it('VENTANEADO vela a vela == backtest full-history (trades post-warmup idénticos)', () => {
    const series = syntheticSeries(800);
    const WINDOW = 200;

    const bt = runBacktest('SYN', '15m', series, CFG, SIM);
    const btById = new Map(bt.results.filter((r) => r.outcome === 'filled' && r.trade).map((r) => [r.intentId, r.trade!]));

    const engine = new PaperEngine('SYN', '15m', CFG, SIM, WINDOW);
    for (const c of series) engine.onClosedCandle(c);
    const paperById = new Map(engine.closedTrades().map((t) => [t.id, t]));

    const warmupEnd = series[WINDOW].openTime;
    let compared = 0;
    for (const [id, t] of btById) {
      if (t.signalBarTime <= warmupEnd) continue;
      compared++;
      const p = paperById.get(id);
      expect(p).toBeDefined();
      expect(p!.exitReason).toBe(t.exitReason);
      expect(p!.entryTime).toBe(t.entryTime);
      expect(p!.exitTime).toBe(t.exitTime);
      expect(p!.rMultiple).toBeCloseTo(t.rMultiple, 9);
    }
    expect(compared).toBeGreaterThan(0); // la serie produce trades reales post-warmup
    // Y el paper no INVENTA trades que el backtest no tiene (post-warmup).
    for (const [id, p] of paperById) {
      if (p.signalBarTime <= warmupEnd) continue;
      expect(btById.has(id)).toBe(true);
    }
  });

  it('procesar por LOTE == procesar vela a vela (estados finales idénticos — rehidratación)', () => {
    const series = syntheticSeries(800, 11);
    const oneByOne = new PaperEngine('SYN', '15m', CFG, SIM, 200);
    for (const c of series) oneByOne.onClosedCandle(c);
    const batched = new PaperEngine('SYN', '15m', CFG, SIM, 200);
    for (let i = 0; i < series.length; i += 500) batched.onClosedCandles(series.slice(i, i + 500));

    const a = oneByOne.closedTrades().map((t) => `${t.id}:${t.exitReason}:${t.rMultiple}`).sort();
    const b = batched.closedTrades().map((t) => `${t.id}:${t.exitReason}:${t.rMultiple}`).sort();
    expect(b).toEqual(a);
    expect(batched.openPositions().map((p) => p.id).sort()).toEqual(oneByOne.openPositions().map((p) => p.id).sort());
  });

  it('el recorte NUNCA descarta velas que una posición viva necesita (re-simulación intacta)', () => {
    const series = syntheticSeries(800, 7);
    const tiny = new PaperEngine('SYN', '15m', CFG, SIM, 50); // ventana agresiva
    const free = new PaperEngine('SYN', '15m', CFG, SIM, 0); // sin ventana (P.1 exacto)
    for (const c of series) {
      tiny.onClosedCandle(c);
      free.onClosedCandle(c);
    }
    // Las posiciones VIVAS al final deben coincidir (la ventana no rompe pendientes/abiertas largas).
    const openTiny = tiny.openPositions().map((p) => p.id).sort();
    const openFree = free.openPositions().map((p) => p.id).sort();
    expect(openTiny).toEqual(openFree);
  });
});

describe('paper-row.mapper — penetraciones (touched-vs-crossed) y filas', () => {
  const intent = {
    id: 'C_SYN_15m_100_u',
    symbol: 'SYN',
    tf: '15m',
    direction: 'LONG' as const,
    signalBarTime: 100,
    entry: 100,
    stopLoss: 97,
    takeProfit: 106,
    invalidationPrice: 98,
    cancelBeyond: 109,
    tpSource: 'fixedR' as const,
    context: { zoneLow: 98, zoneHigh: 102, sweptLevel: 102, wickExtreme: 98, sweptSwingTime: 10 },
  };
  const candles: PaperCandle[] = [
    { openTime: 200, open: 101, high: 102, low: 99.5, close: 101, closeTime: 299 }, // fill: low 99.5 < entry 100 → penetración 0.5
    { openTime: 300, open: 101, high: 106.2, low: 100.5, close: 105, closeTime: 399 }, // TP: high 106.2 > 106 → penetración 0.2
  ];
  const trade = {
    id: intent.id,
    symbol: 'SYN',
    tf: '15m',
    direction: 'LONG' as const,
    signalBarTime: 100,
    entryTime: 200,
    entryPrice: 100,
    exitTime: 399,
    exitPrice: 106,
    exitReason: 'TP' as const,
    stopLoss: 97,
    takeProfit: 106,
    grossR: 2,
    costR: 0,
    rMultiple: 2,
    barsToFill: 0,
    barsHeld: 2,
    movedToBE: false,
  };

  it('mide cuánto CRUZÓ la mecha el límite de entrada y el TP', () => {
    const pen = computePenetrations({ id: intent.id, intent, state: 'CLOSED', trade }, candles);
    expect(pen.entryPenetration).toBeCloseTo(0.5, 9);
    expect(pen.tpPenetration).toBeCloseTo(0.2, 9);
  });

  it('toPaperTradeRow: PENDING sin fill · FILLED con fill provisional · CLOSED completo', () => {
    const pending = toPaperTradeRow({ id: intent.id, intent, state: 'PENDING' }, candles, 'abc', 'hash', 5);
    expect(pending).toMatchObject({ state: 'PENDING', entry: 100, entryTime: null, rMultiple: null, sweptLevel: 102 });

    const filled = toPaperTradeRow(
      { id: intent.id, intent, state: 'FILLED', live: { ...trade, exitReason: 'endOfData' as const } },
      candles,
      'abc',
      'hash',
      5,
    );
    expect(filled).toMatchObject({ state: 'FILLED', entryTime: 200, entryPrice: 100, exitTime: null, rMultiple: null });

    const closed = toPaperTradeRow({ id: intent.id, intent, state: 'CLOSED', trade }, candles, 'abc', 'hash', 5);
    expect(closed).toMatchObject({
      state: 'CLOSED',
      exitReason: 'TP',
      rMultiple: 2,
      entryPenetration: 0.5,
      tpPenetration: 0.2,
      engineVersion: 'abc',
      paramsHash: 'hash',
    });

    const cancelled = toPaperTradeRow({ id: intent.id, intent, state: 'CLOSED', cancelReason: 'ranAway' }, candles, 'abc', 'hash', 5);
    expect(cancelled).toMatchObject({ state: 'CLOSED', cancelReason: 'ranAway', rMultiple: null, entryTime: null });
  });
});
