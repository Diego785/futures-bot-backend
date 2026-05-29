// Placeholder de arquitectura (slice futuro): entrada del journal (datos del broker +
// anotaciones del usuario), base del aprendizaje. Aún sin implementación.
export interface JournalEntry {
  id: string;
  symbol: string;
  side: 'LONG' | 'SHORT';
  entryPrice: number;
  exitPrice?: number;
  pnl?: number;
  followedRules?: boolean;
  notes?: string;
}
