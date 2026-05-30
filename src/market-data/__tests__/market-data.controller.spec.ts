import { MarketDataController } from '../market-data.controller';
import type { CandleRepository } from '../candle.repository';
import type { GetCandlesQueryDto } from '../dto/get-candles-query.dto';

function rowAt(openTime: number) {
  return {
    symbol: 'BTCUSDT',
    tf: '15m',
    openTime,
    closeTime: openTime + 899999,
    open: 1,
    high: 2,
    low: 0.5,
    close: 1.5,
    volume: 10,
    quoteVolume: 100,
    trades: 5,
    isClosed: true,
  };
}

describe('MarketDataController.getCandles', () => {
  it('proyecta a o/h/l/c/v y marca hasMoreOlder + oldest/newest cuando la página está llena', async () => {
    const rows = [rowAt(100), rowAt(300)];
    const repo = { findCandles: jest.fn().mockResolvedValue(rows) } as unknown as CandleRepository;
    const ctrl = new MarketDataController(repo);

    const res = await ctrl.getCandles({ symbol: 'BTCUSDT', tf: '15m', limit: 2 } as GetCandlesQueryDto);

    expect(res.count).toBe(2);
    expect(res.candles[0].o).toBe(1);
    expect((res.candles[0] as Record<string, unknown>).open).toBeUndefined();
    expect(res.hasMoreOlder).toBe(true); // página llena → hay más historial hacia atrás
    expect(res.oldestOpenTime).toBe(100);
    expect(res.newestOpenTime).toBe(300);
    expect(repo.findCandles).toHaveBeenCalledWith({
      symbol: 'BTCUSDT',
      tf: '15m',
      from: undefined,
      to: undefined,
      cursor: undefined,
      before: undefined,
      limit: 2,
    });
  });

  it('hasMoreOlder=false cuando la página no está llena', async () => {
    const repo = { findCandles: jest.fn().mockResolvedValue([rowAt(100)]) } as unknown as CandleRepository;
    const ctrl = new MarketDataController(repo);
    const res = await ctrl.getCandles({ symbol: 'BTCUSDT', tf: '1h', limit: 100 } as GetCandlesQueryDto);
    expect(res.hasMoreOlder).toBe(false);
    expect(res.count).toBe(1);
    expect(res.oldestOpenTime).toBe(100);
  });

  it('pasa `before` al repositorio para cargar historial hacia atrás', async () => {
    const repo = { findCandles: jest.fn().mockResolvedValue([]) } as unknown as CandleRepository;
    const ctrl = new MarketDataController(repo);
    await ctrl.getCandles({ symbol: 'BTCUSDT', tf: '15m', limit: 500, before: 12345 } as GetCandlesQueryDto);
    expect(repo.findCandles).toHaveBeenCalledWith(
      expect.objectContaining({ before: 12345, limit: 500 }),
    );
  });
});
