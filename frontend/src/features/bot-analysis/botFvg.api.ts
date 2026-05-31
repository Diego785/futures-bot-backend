import { apiGet } from '../../lib/apiClient';
import type { BotFvgResponse } from './botFvg.types';
import type { Timeframe } from '../candles/candles.types';

/** FVGs detectados por el bot sobre las velas más recientes (read-only). */
export function fetchBotFvgs(symbol: string, tf: Timeframe, limit = 1000): Promise<BotFvgResponse> {
  const qs = new URLSearchParams({ symbol, tf, limit: String(limit) }).toString();
  return apiGet<BotFvgResponse>(`/api/bot/fvg?${qs}`);
}
