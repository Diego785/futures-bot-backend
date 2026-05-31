import { apiGet } from '../../lib/apiClient';
import type { BotConfluenceResponse } from './botConfluence.types';
import type { Timeframe } from '../candles/candles.types';

/** Zonas de confluencia ponderadas por el bot sobre las velas más recientes (read-only). */
export function fetchBotConfluence(symbol: string, tf: Timeframe, limit = 1000): Promise<BotConfluenceResponse> {
  const qs = new URLSearchParams({ symbol, tf, limit: String(limit) }).toString();
  return apiGet<BotConfluenceResponse>(`/api/bot/confluence?${qs}`);
}
