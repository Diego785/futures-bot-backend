import { planBackfillPage } from '../backfill.service';
import type { Candle } from '../../exchange/interfaces/exchange.interfaces';

// Helper para fabricar velas con openTime/closeTime controlados.
function candle(openTime: number, closeTime: number): Candle {
  return {
    openTime,
    open: 1,
    high: 2,
    low: 0.5,
    close: 1.5,
    volume: 10,
    closeTime,
    quoteVolume: 100,
    trades: 5,
  };
}

const NOW = 1_000_000;

describe('planBackfillPage (paginador puro de backfill)', () => {
  it('página vacía → sin filas, sin siguiente cursor', () => {
    expect(planBackfillPage('BTCUSDT', '15m', [], NOW, 1500, 0)).toEqual({
      rows: [],
      nextCursor: null,
    });
  });

  it('filtra la vela en formación (closeTime >= now)', () => {
    const klines = [
      candle(100, 200), // cerrada
      candle(300, 400), // cerrada
      candle(900, NOW + 5000), // en formación → se descarta
    ];
    const { rows } = planBackfillPage('BTCUSDT', '15m', klines, NOW, 1500, 0);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.isClosed)).toBe(true);
    expect(rows.map((r) => r.openTime)).toEqual([100, 300]);
  });

  it('página parcial (length < pageLimit) → última página, nextCursor null', () => {
    const klines = [candle(100, 200), candle(300, 400)];
    const { nextCursor } = planBackfillPage('BTCUSDT', '1h', klines, NOW, 1500, 0);
    expect(nextCursor).toBeNull();
  });

  it('página llena (length == pageLimit) → nextCursor = last.openTime + 1', () => {
    const klines = [candle(100, 200), candle(300, 400)];
    const { nextCursor } = planBackfillPage('BTCUSDT', '1h', klines, NOW, 2, 0);
    expect(nextCursor).toBe(301);
  });

  it('guard anti-bucle: si el cursor no avanzaría, nextCursor null', () => {
    const klines = [candle(100, 200), candle(300, 400)];
    // pageLimit=2 (llena) pero cursor ya está en 500 > last.openTime+1=301
    const { nextCursor } = planBackfillPage('BTCUSDT', '1h', klines, NOW, 2, 500);
    expect(nextCursor).toBeNull();
  });
});
