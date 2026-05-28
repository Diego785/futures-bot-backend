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

  // ─── Database (opcional en skeleton; requerida cuando DB_ENABLED=true) ───
  DB_ENABLED: boolFlag.default(false),
  DB_HOST: z.string().optional(),
  DB_PORT: z.coerce.number().int().optional(),
  DB_USER: z.string().optional(),
  DB_PASS: z.string().optional(),
  DB_NAME: z.string().optional(),

  // ─── Exchange URLs y credenciales (read-only; opcionales en skeleton) ───
  // Las credenciales sólo se necesitan para endpoints privados (journal, userTrades);
  // datos de mercado públicos no las requieren.
  BINANCE_FUTURES_BASE_URL: z.string().url().optional(),
  BINANCE_FUTURES_WS_URL: z.string().optional(),
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
