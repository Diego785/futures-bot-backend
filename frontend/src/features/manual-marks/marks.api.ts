import { apiGet, apiSend } from '../../lib/apiClient';
import type { ManualMark } from './manualMarks.types';
import type { Timeframe } from '../candles/candles.types';

interface MarksResponse {
  symbol: string;
  tf: string;
  count: number;
  marks: ManualMark[];
}

// Campos que el backend acepta al CREAR (forbidNonWhitelisted). sourceLayer/createdAt/
// updatedAt/rr los fija el servidor. JSON.stringify omite los undefined automáticamente.
function createPayload(m: ManualMark) {
  return {
    id: m.id,
    kind: m.kind,
    symbol: m.symbol,
    tf: m.tf,
    timeStart: m.timeStart,
    timeEnd: m.timeEnd,
    priceLow: m.priceLow,
    priceHigh: m.priceHigh,
    price: m.price,
    side: m.side,
    entry: m.entry,
    stopLoss: m.stopLoss,
    takeProfit: m.takeProfit,
    note: m.note ?? '',
    status: m.status,
    context: m.context,
    reason: m.reason,
    doubt: m.doubt,
    outcome: m.outcome,
  };
}

// Campos editables vía PATCH (kind/symbol/tf de una marca no cambian).
const PATCH_FIELDS = [
  'timeStart', 'timeEnd', 'priceLow', 'priceHigh', 'price',
  'side', 'entry', 'stopLoss', 'takeProfit', 'note',
  'status', 'context', 'reason', 'doubt', 'outcome',
] as const;

function patchPayload(m: ManualMark): Record<string, unknown> {
  const rec = m as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of PATCH_FIELDS) {
    const v = rec[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

export function fetchMarks(symbol: string, tf: Timeframe): Promise<MarksResponse> {
  const qs = new URLSearchParams({ symbol, tf }).toString();
  return apiGet<MarksResponse>(`/api/manual-marks?${qs}`);
}

export function createMarkRemote(m: ManualMark): Promise<ManualMark> {
  return apiSend<ManualMark>('POST', '/api/manual-marks', createPayload(m));
}

export function patchMarkRemote(m: ManualMark): Promise<ManualMark> {
  return apiSend<ManualMark>('PATCH', `/api/manual-marks/${encodeURIComponent(m.id)}`, patchPayload(m));
}

export function deleteMarkRemote(id: string): Promise<void> {
  return apiSend<void>('DELETE', `/api/manual-marks/${encodeURIComponent(id)}`);
}
