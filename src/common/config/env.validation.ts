import { z } from 'zod';

// v2 skeleton — sin DeepSeek, sin Redis, sin trading/risk/gates (eliminados con la
// demolición del v1). Las claves del exchange y la DB son opcionales en esta fase:
// el skeleton arranca para servir /api/status sin necesidad de credenciales reales.

const boolFlag = z.enum(['true', 'false']).transform((v) => v === 'true');

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().default(3300),

  // Exchange selection (required — define el adapter que se cablea)
  EXCHANGE_PROVIDER: z.enum(['binance', 'bybit']),

  // Default symbol/timeframe (default-only; market data los usará en su fase)
  DEFAULT_SYMBOL: z.string().min(1).default('BTCUSDT'),
  DEFAULT_TIMEFRAME: z.string().default('15m'),

  // ─── Market data ingest (Fase 3) ───
  // MARKET_DATA_LIVE: si 'true', el ingest se conecta al WS y persiste velas en vivo.
  // Default 'false' para que boots/tests no se conecten al exchange.
  MARKET_DATA_LIVE: z.enum(['true', 'false']).default('false'),
  MARKET_DATA_SYMBOLS: z.string().optional(), // CSV; cae a DEFAULT_SYMBOL si falta
  MARKET_DATA_TIMEFRAMES: z.string().default('15m,1h,4h,1d'), // CSV

  // ─── Paper-trading (gate #7, P.2) ───
  // PAPER_TRADING: si 'true' (y DB_ENABLED), el shadow del candidato CONGELADO registra en vivo
  // lo que HARÍA (paper_trades). READ-ONLY (Regla Cero). Universo = MARKET_DATA_SYMBOLS.
  PAPER_TRADING: z.enum(['true', 'false']).default('false'),
  // PAPER_CLOCK_START: marca el ARRANQUE OFICIAL del reloj del gate (fecha ISO o epoch ms). Las
  // señales con signalBarTime ANTERIOR son 'backfill' (histórico rehidratado = contexto, NO cuentan
  // en estadísticas); las posteriores son 'live' (el forward-test real). Sin esta var, NADA es live
  // (todo es contexto) — el deploy debe fijarla conscientemente para encender el reloj limpio.
  PAPER_CLOCK_START: z.string().optional(),

  // ─── Database (opcional en skeleton; requerida cuando DB_ENABLED=true) ───
  DB_ENABLED: boolFlag.default(false),
  DB_HOST: z.string().optional(),
  DB_PORT: z.coerce.number().int().optional(),
  DB_USER: z.string().optional(),
  DB_PASS: z.string().optional(),
  DB_NAME: z.string().optional(),

  // ─── Exchange URLs y credenciales (read-only; opcionales en skeleton) ───
  // Las credenciales sólo se necesitan para endpoints privados (journal, userTrades);
  // datos de mercado públicos no las requieren. Las URLs son constantes públicas → con default
  // (el bot funciona out-of-the-box para Binance USDT-M; se pueden sobreescribir por .env si hace falta).
  BINANCE_FUTURES_BASE_URL: z.string().url().default('https://fapi.binance.com'),
  BINANCE_FUTURES_WS_URL: z.string().default('wss://fstream.binance.com'),
  BINANCE_API_KEY: z.string().optional(),
  BINANCE_API_SECRET: z.string().optional(),
  BYBIT_BASE_URL: z.string().url().optional(),
  BYBIT_WS_PUBLIC_URL: z.string().optional(),
  BYBIT_WS_PRIVATE_URL: z.string().optional(),
  BYBIT_API_KEY: z.string().optional(),
  BYBIT_API_SECRET: z.string().optional(),
});

const envSchema = baseSchema.superRefine((data, ctx) => {
  // Si DB_ENABLED=true, los 4 campos de DB son obligatorios.
  if (data.DB_ENABLED) {
    for (const field of ['DB_HOST', 'DB_USER', 'DB_PASS', 'DB_NAME'] as const) {
      if (!data[field]) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} is required when DB_ENABLED=true`,
        });
      }
    }
  }
});

export type EnvConfig = z.infer<typeof envSchema>;

export function validate(config: Record<string, unknown>): EnvConfig {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Environment validation failed:\n${formatted}`);
  }
  return result.data;
}
