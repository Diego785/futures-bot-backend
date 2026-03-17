import { z } from 'zod';

export const deepSeekResponseSchema = z.object({
  action: z.enum(['LONG', 'SHORT', 'HOLD']),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().min(1).max(1000),
  suggestedStopLoss: z.number().positive().nullish(),
  suggestedTakeProfit: z.number().positive().nullish(),
});

export type DeepSeekResponse = z.infer<typeof deepSeekResponseSchema>;
