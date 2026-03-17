import { z } from 'zod';

export const signalSchema = z.object({
  symbol: z.string(),
  action: z.enum(['LONG', 'SHORT']),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  entryPrice: z.number().positive(),
  stopLoss: z.number().positive(),
  takeProfit: z.number().positive(),
  atr: z.number().positive(),
  rsi: z.number(),
  ema9: z.number(),
  ema21: z.number(),
  timestamp: z.number(),
});

export type ValidatedSignal = z.infer<typeof signalSchema>;
