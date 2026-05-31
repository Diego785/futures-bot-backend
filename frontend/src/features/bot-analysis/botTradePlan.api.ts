import { apiGet } from '../../lib/apiClient';
import type { BotPlanResponse } from './botTradePlan.types';
import type { Timeframe } from '../candles/candles.types';

/** Trade Plans candidatos del bot. mode: confirmation (default) | risk | both. Read-only. */
export function fetchBotPlans(
  symbol: string,
  tf: Timeframe,
  mode: 'confirmation' | 'risk' | 'both' = 'both',
  limit = 1000,
): Promise<BotPlanResponse> {
  const qs = new URLSearchParams({ symbol, tf, mode, limit: String(limit) }).toString();
  return apiGet<BotPlanResponse>(`/api/bot/plans?${qs}`);
}
