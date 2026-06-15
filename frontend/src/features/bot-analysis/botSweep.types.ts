// Barridos de liquidez con reclamo — espejo de GET /api/bot/sweeps. ES el gatillo del candidato:
// la mecha barre la liquidez de un swing y el cuerpo reclama de vuelta (manipulación + reacción).
// Solo se convierte en ENTRADA si además coincide con el sesgo HTF. Read-only (Regla Cero).
export type SweepDirection = 'bullish' | 'bearish';

export interface BotSweep {
  id: string;
  symbol: string;
  tf: string;
  direction: SweepDirection; // bullish: barrió un low (reacción al alza) · bearish: barrió un high
  sweptLevel: number;
  sweptSwingTime: number;
  sweepBarTime: number; // vela que barrió + reclamó (se conoce a su cierre)
  wickExtreme: number;
  reclaimClose: number;
  penetration: number;
}

export interface BotSweepResponse {
  symbol: string;
  tf: string;
  count: number;
  sweeps: BotSweep[];
}
