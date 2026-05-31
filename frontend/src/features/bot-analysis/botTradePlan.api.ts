import { apiGet } from '../../lib/apiClient';
import type { BotPlanResponse } from './botTradePlan.types';
import type { Timeframe } from '../candles/candles.types';

/** Trade Plans candidatos del bot (desde setups ARMED). Read-only — sugerencia, no orden. */
export function fetchBotPlans(symbol: string, tf: Timeframe, limit = 1000): Promise<BotPlanResponse> {
  const qs = new URLSearchParams({ symbol, tf, limit: String(limit) }).toString();
  return apiGet<BotPlanResponse>(`/api/bot/plans?${qs}`);
}
