import { PaperEngine, type PaperCandle } from '../paper-engine';
import { runBacktest } from '../../backtest/backtest.runner';

const oc = (openTime: number, open: number, high: number, low: number, close: number): PaperCandle => ({
  openTime,
  open,
  high,
  low,
  close,
});

// Sweep alcista (swing low 95 en idx2; idx5 barre a 90 y reclama) + retroceso que llena el CE (92.5)
// y alcanza el TP fixedR (98.5). El mismo escenario del backtest.
const SERIES: PaperCandle[] = [
  oc(0, 105, 110, 100, 105),
  oc(1, 104, 109, 101, 104),
  oc(2, 103, 108, 95, 103),
  oc(3, 102, 107, 101, 102),
  oc(4, 101, 106, 100, 101),
  oc(5, 101, 104, 90, 102), // sweep → intent (entry 92.5, SL 89.5, TP 98.5)
  oc(6, 102, 95, 92, 94), // llena el límite (low 92 ≤ 92.5)
  oc(7, 94, 99, 93, 98), // TP (high 99 ≥ 98.5)
];

const CFG = { gatillo: 'C' as const, tpRule: 'fixedR' as const, swingLookback: 2 };
const NO_COST = { feeRatePerSide: 0, slippagePerSide: 0 };

describe('PaperEngine — invarianza con el backtest', () => {
  it('alimentado vela a vela reproduce EXACTO los trades del backtest', () => {
    const engine = new PaperEngine('BTCUSDT', '15m', CFG, NO_COST);
    for (const c of SERIES) engine.onClosedCandle(c);

    const bt = runBacktest('BTCUSDT', '15m', SERIES, CFG, NO_COST);
    const closed = engine.closedTrades();
    expect(closed).toHaveLength(bt.metrics.trades);
    expect(closed.map((t) => t.rMultiple)).toEqual([2]);
    expect(closed[0].exitReason).toBe('TP');
  });
});

describe('PaperEngine — ciclo de vida de una paper-position', () => {
  it('PENDING → FILLED → CLOSED a medida que llegan las velas', () => {
    const engine = new PaperEngine('BTCUSDT', '15m', CFG, NO_COST);

    // Hasta la vela de señal (idx5): la posición existe pero aún no hay vela adelante → PENDING.
    for (const c of SERIES.slice(0, 6)) engine.onClosedCandle(c); // c0..c5
    expect(engine.openPositions()).toHaveLength(1);
    expect(engine.openPositions()[0].state).toBe('PENDING');

    // Vela idx6: llena el límite pero no toca TP/SL → FILLED (dentro de la posición).
    engine.onClosedCandle(SERIES[6]);
    expect(engine.openPositions()).toHaveLength(1);
    expect(engine.openPositions()[0].state).toBe('FILLED');
    expect(engine.closedTrades()).toHaveLength(0);

    // Vela idx7: alcanza el TP → CLOSED con +2R.
    engine.onClosedCandle(SERIES[7]);
    expect(engine.openPositions()).toHaveLength(0);
    const closed = engine.closedTrades();
    expect(closed).toHaveLength(1);
    expect(closed[0].rMultiple).toBe(2);
    expect(closed[0].exitReason).toBe('TP');
  });

  it('no duplica posiciones aunque se reprocese el buffer cada vela', () => {
    const engine = new PaperEngine('BTCUSDT', '15m', CFG, NO_COST);
    for (const c of SERIES) engine.onClosedCandle(c);
    expect(engine.allPositions()).toHaveLength(1); // un solo sweep → una sola posición
  });
});
