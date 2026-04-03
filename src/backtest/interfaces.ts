export interface BacktestConfig {
  symbol: string;
  timeframe: string;
  days: number;
  mode: 'gate-only' | 'deepseek' | 'ema-crossover' | 'bollinger' | 'breakout' | 'hybrid' | 'pullback-ob';
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
  // Pullback-OB mode params
  pullbackMaxWaitCandles: number;   // default 12 (3h on 15m)
  pullbackSlBuffer: number;        // ATR multiplier for SL buffer beyond zone (default 0.3)
  pullbackZoneType: 'ob' | 'fvg' | 'both';  // default 'both'
  pullbackMaxDistance: number;     // max % distance to consider zone (default 1.5)
  pullbackMinDistance: number;     // min % distance — skip if too close (default 0.05)
  trailingBreakevenPct: number;   // profit % to trigger breakeven SL (default 0.3)
  startDate?: string;            // YYYY-MM-DD — override days with date range
  endDate?: string;              // YYYY-MM-DD — override days with date range
  // Confluence filters (all default false)
  filterPremiumDiscount: boolean;
  filterRsiExtreme: boolean;
  filterCandlePattern: boolean;
  filterZoneConfluence: boolean;
  filterVolumeConfirm: boolean;
  rsiLongMax: number;            // default 40
  rsiShortMin: number;           // default 60
  volumeMultiplier: number;      // default 1.2
  trailMode: 'entry-pct' | 'tp-distance';  // trailing SL mode
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
  zoneType?: 'OB' | 'FVG';
  waitCandles?: number;
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
