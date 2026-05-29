import { apiGet } from '../../lib/apiClient';
import type { CandlesResponse, Timeframe } from './candles.types';

export function fetchCandles(
  symbol: string,
  tf: Timeframe,
  limit = 500,
): Promise<CandlesResponse> {
  const qs = new URLSearchParams({ symbol, tf, limit: String(limit) }).toString();
  return apiGet<CandlesResponse>(`/api/candles?${qs}`);
}
