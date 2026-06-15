import { apiGet } from '../../lib/apiClient';
import type { BotSweepResponse } from './botSweep.types';
import type { Timeframe } from '../candles/candles.types';

/** Barridos de liquidez (sweep+reclaim) detectados por el bot sobre las velas recientes (read-only). */
export function fetchBotSweeps(symbol: string, tf: Timeframe, limit = 600): Promise<BotSweepResponse> {
  const qs = new URLSearchParams({ symbol, tf, limit: String(limit) }).toString();
  return apiGet<BotSweepResponse>(`/api/bot/sweeps?${qs}`);
}
