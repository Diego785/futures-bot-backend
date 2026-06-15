// Sesgo HTF (4H) del candidato — espejo de GET /api/bot/bias. El bot solo busca LONGs con sesgo
// alcista y SHORTs con bajista; un barrido contra el sesgo HTF es ruido (no dispara). Read-only.
export type Bias = 'bullish' | 'bearish' | 'neutral';

export interface BotBiasResponse {
  symbol: string;
  tf: string;
  bias: Bias;
  changedAt: number | null; // closeTime del último BOS que fijó el sesgo
  points: { time: number; bias: Bias }[];
}

export const BIAS_LABEL: Record<Bias, string> = {
  bullish: 'alcista ▲',
  bearish: 'bajista ▼',
  neutral: 'neutral —',
};
