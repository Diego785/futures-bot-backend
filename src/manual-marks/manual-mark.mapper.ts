// Lógica pura de marcas — sin TypeORM ni DB, testeable en aislamiento.

export type ManualMarkKind = 'OB' | 'FVG' | 'Liquidity' | 'TradePlan';

/**
 * R:R = |TP − Entry| / |Entry − SL|. Solo aplica a TradePlan con los tres precios
 * presentes; null si no aplica o el riesgo es 0. Se calcula en el servidor (no se confía
 * en el cliente) para que el valor persistido sea siempre coherente con entry/SL/TP.
 */
export function computeRr(
  kind: ManualMarkKind | string,
  entry: number | null,
  stopLoss: number | null,
  takeProfit: number | null,
): number | null {
  if (kind !== 'TradePlan' || entry == null || stopLoss == null || takeProfit == null) {
    return null;
  }
  const risk = Math.abs(entry - stopLoss);
  if (risk === 0) return null;
  return Math.abs(takeProfit - entry) / risk;
}
