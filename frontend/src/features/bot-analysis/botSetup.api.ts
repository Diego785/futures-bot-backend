import { apiGet } from '../../lib/apiClient';
import type { BotSetupResponse } from './botSetup.types';
import type { Timeframe } from '../candles/candles.types';

/** Estados de setup (WATCHING/MITIGATED/ARMED) sobre las zonas de confluencia (read-only). */
export function fetchBotSetups(symbol: string, tf: Timeframe, limit = 1000): Promise<BotSetupResponse> {
  const qs = new URLSearchParams({ symbol, tf, limit: String(limit) }).toString();
  return apiGet<BotSetupResponse>(`/api/bot/setups?${qs}`);
}
