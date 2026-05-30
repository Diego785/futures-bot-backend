// Placeholder de arquitectura (slice futuro): entrada del journal (datos del broker +
// anotaciones del usuario), base de la comparación y validación de lecturas (el bot no
// copia las entradas del usuario). Aún sin implementación.
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
