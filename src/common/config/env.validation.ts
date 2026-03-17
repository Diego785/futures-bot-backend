import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  PORT: z.coerce.number().int().default(3300),

  // Binance
  BINANCE_FUTURES_BASE_URL: z.string().url(),
  BINANCE_FUTURES_WS_URL: z.string(),
  BINANCE_API_KEY: z.string().min(1),
  BINANCE_API_SECRET: z.string().min(1),

  // DeepSeek
  DEEPSEEK_API_KEY: z.string().min(1),
  DEEPSEEK_BASE_URL: z.string().url(),

  // Postgres
  DB_HOST: z.string().min(1),
  DB_PORT: z.coerce.number().int().default(5432),
  DB_USER: z.string().min(1),
  DB_PASS: z.string().min(1),
  DB_NAME: z.string().min(1),

  // Redis
  REDIS_HOST: z.string().min(1),
  REDIS_PORT: z.coerce.number().int().default(6379),

  // Trading safety
  TRADING_ENABLED: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true'),
  DEFAULT_SYMBOL: z.string().min(1).default('BTCUSDT'),
  DEFAULT_TIMEFRAME: z.string().default('5m'),
  MAX_DAILY_LOSS_USDT: z.coerce.number().positive(),
  MAX_POSITION_NOTIONAL_USDT: z.coerce.number().positive(),
  MAX_LEVERAGE: z.coerce.number().int().positive().max(125),

  // Pre-filter gate
  GATE_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
  GATE_MIN_SCORE: z.coerce.number().int().min(0).max(100).default(30),
  GATE_MIN_ATR_PERCENT: z.coerce.number().min(0).default(0.0015),
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
