import { apiGet } from '../../lib/apiClient';
import type { BotBiasResponse } from './botBias.types';

/** Sesgo HTF (4H) vigente del candidato sobre las velas más recientes (read-only). */
export function fetchBotBias(symbol: string, tf = '4h', limit = 600): Promise<BotBiasResponse> {
  const qs = new URLSearchParams({ symbol, tf, limit: String(limit) }).toString();
  return apiGet<BotBiasResponse>(`/api/bot/bias?${qs}`);
}
