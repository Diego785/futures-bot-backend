import { apiGet } from '../../lib/apiClient';
import type { RunDetailResponse, RunsResponse } from './backtestRuns.types';

export function fetchBacktestRuns(): Promise<RunsResponse> {
  return apiGet<RunsResponse>('/api/backtest/runs');
}

export function fetchBacktestRun(id: string): Promise<RunDetailResponse> {
  return apiGet<RunDetailResponse>(`/api/backtest/runs/${encodeURIComponent(id)}`);
}
