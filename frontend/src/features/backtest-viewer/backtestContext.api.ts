import { apiGet } from '../../lib/apiClient';
import type { ReplayContextResponse } from './backtestContext.types';

export function fetchReplayContext(runId: string, from: number, to: number): Promise<ReplayContextResponse> {
  const qs = new URLSearchParams({ from: String(from), to: String(to) }).toString();
  return apiGet<ReplayContextResponse>(`/api/backtest/runs/${encodeURIComponent(runId)}/context?${qs}`);
}
