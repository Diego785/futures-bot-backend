// Estados de Setup del bot (Fase 5E-A). Ciclo de vida de una zona de confluencia mientras el
// precio la trabaja. NO es señal ni entrada: solo WATCHING → MITIGATED → ARMED.
export type SetupState = 'WATCHING' | 'MITIGATED' | 'ARMED';
export type SetupDirection = 'bullish' | 'bearish';

export interface BotSetup {
  id: string;
  symbol: string;
  tf: string;
  direction: SetupDirection;
  state: SetupState;
  priceLow: number;
  priceHigh: number;
  timeStart: number;
  confluenceId: string;
  rating: 'LOW' | 'MEDIUM' | 'HIGH';
  score: number;
  mitigatedAtTime: number | null;
  armedAtTime: number | null;
  confirmationObId: string | null;
  distancePct: number;
}

export interface BotSetupResponse {
  symbol: string;
  tf: string;
  count: number;
  setups: BotSetup[];
}

export const SETUP_STATE_LABELS: Record<SetupState, string> = {
  WATCHING: 'En observación',
  MITIGATED: 'Mitigado',
  ARMED: 'Armado',
};

// Color por DIRECCIÓN (contexto LONG/SHORT), igual que la confluencia. El estado se ve por el
// estilo del borde (CSS .setup-watching/mitigated/armed).
export const SETUP_DIR_COLORS: Record<SetupDirection, string> = {
  bullish: '#22c55e',
  bearish: '#ef4444',
};
