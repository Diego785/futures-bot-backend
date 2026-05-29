// Placeholder de arquitectura (slice futuro): señal candidata emitida por el motor SMC.
// Solo se mostrará cuando un Setup llegue a TRIGGERED (ver docs/ENTRY-EDGE-SPEC.md).
export type Side = 'LONG' | 'SHORT';

export interface SignalCandidate {
  id: string;
  side: Side;
  tf: string;
  entries: { level: 'AGGRESSIVE' | 'MID' | 'CONSERVATIVE'; price: number }[];
  stopLoss: number;
  takeProfits: { kind: string; price: number; rr: number }[];
}
