import { apiGet } from '../../lib/apiClient';
import type { CandlesResponse, Timeframe } from './candles.types';

export function fetchCandles(
  symbol: string,
  tf: Timeframe,
  limit = 500,
  opts?: { before?: number; from?: number; to?: number },
): Promise<CandlesResponse> {
  const params: Record<string, string> = { symbol, tf, limit: String(limit) };
  if (opts?.before !== undefined) params.before = String(opts.before);
  if (opts?.from !== undefined) params.from = String(opts.from);
  if (opts?.to !== undefined) params.to = String(opts.to);
  const qs = new URLSearchParams(params).toString();
  return apiGet<CandlesResponse>(`/api/candles?${qs}`);
}
