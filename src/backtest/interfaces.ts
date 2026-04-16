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
  trailMode: 'entry-pct' | 'tp-distance' | 'fixed-amount';  // trailing SL mode
  trailFixed: number;  // fixed price distance for fixed-amount mode (default 100)
  trailActivation: number;  // min price movement before trailing activates (default = trailFixed)
  pullbackLooseHtf: boolean;  // if true, allow HTF bias when EMA is directional but structure is RANGING (default false)
  pullbackMinAtrPct: number;  // minimum ATR% to create setup, 0 = disabled (default 0)
  pullbackFreshChoch: boolean;  // if true, CHoCH invalidation only fires on structure breaks newer than setup creation (default false)
  entrySlippage: number;  // dollars added to entry price (LONG) or subtracted (SHORT) to simulate MARKET fill slippage (default 0)
  trailBreakevenAt: number;  // profit $ threshold to lock SL at breakeven; 0 = disabled (default 0)
  fillRate: number;  // probability [0-1] that a signal results in a fill. 1.0 = all fill (default). 0.7 = 30% missed.
  adverseSlip: number;  // dollars of adverse selection AFTER fill (simulates queue priority loss). default 0.
  pessimisticTrail: boolean;  // if true, check SL hit BEFORE trailing update (conservative intrabar order). default false.
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
