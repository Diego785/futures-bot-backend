import { apiGet } from '../../lib/apiClient';
import type { BotObResponse } from './botOb.types';
import type { Timeframe } from '../candles/candles.types';

/** Order Blocks detectados por el bot sobre las velas más recientes (read-only). */
export function fetchBotObs(symbol: string, tf: Timeframe, limit = 1000): Promise<BotObResponse> {
  const qs = new URLSearchParams({ symbol, tf, limit: String(limit) }).toString();
  return apiGet<BotObResponse>(`/api/bot/ob?${qs}`);
}
