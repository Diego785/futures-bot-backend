import { apiGet } from '../../lib/apiClient';
import type { BotLiqResponse } from './botLiquidity.types';
import type { Timeframe } from '../candles/candles.types';

/** Niveles de liquidez detectados por el bot sobre las velas más recientes (read-only). */
export function fetchBotLiquidity(symbol: string, tf: Timeframe, limit = 1000): Promise<BotLiqResponse> {
  const qs = new URLSearchParams({ symbol, tf, limit: String(limit) }).toString();
  return apiGet<BotLiqResponse>(`/api/bot/liquidity?${qs}`);
}
