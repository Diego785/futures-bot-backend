import { of } from 'rxjs';
import { BinanceRestService } from '../binance-rest.service';

// ConfigService stub: get() lenient, getOrThrow() lanza si falta.
function cfg(env: Record<string, string | undefined> = {}) {
  const base: Record<string, string | undefined> = {
    EXCHANGE_PROVIDER: 'binance',
    BINANCE_FUTURES_BASE_URL: 'https://fapi.binance.com',
    ...env,
  };
  return {
    get: (k: string, d?: unknown) => base[k] ?? d,
    getOrThrow: (k: string) => {
      const v = base[k];
      if (v == null) throw new Error(`${k} required`);
      return v;
    },
  } as any;
}

// HttpService stub que devuelve un observable con la respuesta dada.
function http(data: unknown) {
  return { request: () => of({ data, headers: {} }) } as any;
}

describe('BinanceRestService — market data público sin credenciales', () => {
  it('arranca sin API keys (solo público) y no lanza', async () => {
    const svc = new BinanceRestService(http({ serverTime: 123 }), cfg({}));
    await expect(svc.onModuleInit()).resolves.toBeUndefined();
  });

  it('getKlines (público) funciona sin credenciales', async () => {
    const rawKline = [1, '1', '2', '0.5', '1.5', '10', 2, '100', 5, '0', '0', '0'];
    const svc = new BinanceRestService(http([rawKline]), cfg({}));
    await svc.onModuleInit();
    const klines = await svc.getKlines('BTCUSDT', '15m', 1);
    expect(klines).toHaveLength(1);
  });

  it('endpoint privado lanza error claro sin credenciales', async () => {
    const svc = new BinanceRestService(http({}), cfg({}));
    await svc.onModuleInit();
    await expect(svc.getUserTrades('BTCUSDT')).rejects.toThrow(/credentials|BINANCE_API/i);
  });

  it('con credenciales read-only, el endpoint privado firma y responde', async () => {
    const svc = new BinanceRestService(
      http([]),
      cfg({ BINANCE_API_KEY: 'k', BINANCE_API_SECRET: 's' }),
    );
    await svc.onModuleInit();
    await expect(svc.getUserTrades('BTCUSDT')).resolves.toEqual([]);
  });
});
