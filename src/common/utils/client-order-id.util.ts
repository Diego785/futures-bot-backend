// Format: FAB_{prefix}_{signalId}_{side}_{base36ts}
// FAB = Futures AI Bot
// Max length: 36 chars (Binance limit)
export function generateClientOrderId(
  prefix: 'ENTRY' | 'SL' | 'TP' | 'CLOSE',
  signalId: string,
  side: 'BUY' | 'SELL',
): string {
  const ts = Date.now().toString(36);
  const shortId = signalId.replace(/-/g, '').slice(0, 8);
  return `FAB_${prefix}_${shortId}_${side}_${ts}`.slice(0, 36);
}
