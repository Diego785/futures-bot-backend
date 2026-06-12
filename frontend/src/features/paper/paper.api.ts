import { apiGet } from '../../lib/apiClient';
import type { ReplayContextResponse } from '../backtest-viewer/backtestContext.types';
import type { PaperStatus, PaperTradesResponse } from './paper.types';

export function fetchPaperStatus(): Promise<PaperStatus> {
  return apiGet<PaperStatus>('/api/paper/status');
}

export function fetchPaperTrades(limit = 2000): Promise<PaperTradesResponse> {
  return apiGet<PaperTradesResponse>(`/api/paper/trades?limit=${limit}`);
}

export function fetchPaperContext(symbol: string, from: number, to: number): Promise<ReplayContextResponse> {
  const qs = new URLSearchParams({ symbol, from: String(from), to: String(to) }).toString();
  return apiGet<ReplayContextResponse>(`/api/paper/context?${qs}`);
}
