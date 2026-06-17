import { apiGet } from '../../lib/apiClient';
import type { WatchlistResponse } from './botWatchlist.types';

/** Resumen (sesgo + precio + liquidez objetivo) de varios símbolos de un vistazo (read-only). */
export function fetchWatchlist(symbols: string[]): Promise<WatchlistResponse> {
  const qs = new URLSearchParams({ symbols: symbols.join(',') }).toString();
  return apiGet<WatchlistResponse>(`/api/bot/watchlist?${qs}`);
}
