export interface BacktestConfig {
  symbol: string;
  timeframe: string;
  days: number;
  mode: 'gate-only' | 'deepseek' | 'ema-crossover' | 'bollinger' | 'breakout' | 'hybrid';
  gateEntryThreshold: number;
  initialBalance: number;
  maxLeverage: number;
  commissionRate: number;
  cooldownCandles: number;
  slAtrMultiplier: number;   // default 2
  slMinPercent: number;      // default 0.005 (0.5%)
  rrRatio: number;           // default 1.5
  enableTrailing: boolean;   // default true
  requireOBFVG: boolean;     // default false
}

export interface BacktestTrade {
  id: number;
  direction: 'LONG' | 'SHORT';
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  stopLoss: number;
  takeProfit: number;
  exitReason: 'SL' | 'TP' | 'TRAILING_SL' | 'END_OF_DATA';
  pnlUsd: number;
  gateScore: number;
  confidence?: number;
  trailingPhase: number;
}

export interface BacktestReport {
  config: BacktestConfig;
  summary: {
    totalCandles: number;
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    totalPnlUsd: number;
    avgWinUsd: number;
    avgLossUsd: number;
    profitFactor: number;
    maxDrawdownUsd: number;
    gatePassRate: number;
  };
  equityCurve: number[];
  trades: BacktestTrade[];
}
