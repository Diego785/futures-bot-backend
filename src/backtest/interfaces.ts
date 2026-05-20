export interface BacktestConfig {
  symbol: string;
  timeframe: string;
  days: number;
  mode: 'gate-only' | 'deepseek' | 'ema-crossover' | 'bollinger' | 'breakout' | 'hybrid' | 'pullback-ob' | 'session-breakout' | 'mean-reversion';
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
  pullbackHtf4hTiebreaker: boolean;  // if true, when 1H EMA and structure contradict, use 4H structure as tiebreaker (default false)
  pullbackHtf4hTiebreakerSoft: boolean;  // if true (and tiebreaker enabled), also allow soft bias when 4H is RANGING (default false)
  pullbackHtfFlipTolerant: boolean;  // if true, don't invalidate setup on HTF flip if structure still aligns with bias (default false)
  pullbackSlopeSoft: boolean;  // if true, skip slope-against filter at entry trigger (default false)
  // FASE 1 — realistic LIMIT order simulation (added 2026-05-18). Matches live execution.service.ts behavior.
  iocFallbackEnabled?: boolean;  // default true (matches live default)
  iocFallbackMaxSlipUsd?: number;  // default 50 (matches live default)
  entrySlippage: number;  // dollars added to entry price (LONG) or subtracted (SHORT) to simulate MARKET fill slippage (default 0)
  trailBreakevenAt: number;  // profit $ threshold to lock SL at breakeven; 0 = disabled (default 0)
  fillRate: number;  // probability [0-1] that a signal results in a fill. 1.0 = all fill (default). 0.7 = 30% missed.
  adverseSlip: number;  // dollars of adverse selection AFTER fill (simulates queue priority loss). default 0.
  pessimisticTrail: boolean;  // if true, check SL hit BEFORE trailing update (conservative intrabar order). default false.
  // Phase 2 — context filters (apply BEFORE openPosition, affect cooldown/sequencing)
  blockSessions: SessionLabel[];           // sessions to block entries in (default [])
  blockDelta24hBuckets: Delta24hBucket[];  // delta24h buckets to block (default [])
  // System B — Session Breakout strategy
  sbRangeBars: number;        // # bars to define session range (default 12 = 1h on 5m)
  sbRrRatio: number;          // R:R for session-breakout (default 1.5)
  sbMinRangeAtrMult: number;  // min range width as ATR multiple (0 = disabled)
  sbSessions: SessionLabel[]; // sessions to operate on (default ['EU','OVERLAP','US'])
  // System B v2 — Mean Reversion
  mrRsiLong: number;          // RSI <= for LONG (default 25)
  mrRsiShort: number;         // RSI >= for SHORT (default 75)
  mrRsiReset: number;         // RSI must cross this before re-arm (default 50)
  mrSlAtrMult: number;        // SL distance in ATR multiples (default 1.0)
  mrTpAtrMult: number;        // TP distance in ATR multiples (default 1.5)
  mrCooldownBars: number;     // cooldown between trades (default 6)
  mrSessions: SessionLabel[]; // active sessions (default EU, OVERLAP, US)
  // Economic BE — when true, BE buffer covers round-trip fees + safety margin (vs flat 0.05%)
  economicBe: boolean;        // default false (legacy 0.05% buffer)
  economicBeSafetyPct: number; // additional safety on top of 2x commission, default 0.02 = 0.02%
}

// Phase 1 instrumentation — observabilidad para v2 strategic redesign.
// MFE/MAE, RR-touched, contexto al entry, fees estimadas (round-trip approx).
// NO es exact net of execution: fees son aproximación (no incluye funding ni maker/taker mix real).
// MAE split before/after MFE usa Opción A simple: relativo al MFE GLOBAL del trade.
// MFE/MAE computation mode: intracandle_extreme (usa candle.high/low — métrica de potencial, no de ejecutabilidad garantizada).

export type VolatilityBucket = 'LOW' | 'MED' | 'HIGH';
export type Delta24hBucket = 'CONSOLIDATION' | 'NORMAL' | 'MOMENTUM_EXTREME';
export type SessionLabel = 'ASIA' | 'EU' | 'OVERLAP' | 'US';

export interface TradeContextAtEntry {
  delta24hAtEntry: number | null;          // null si dataset edge (< lookback bars disponibles)
  atrPctAtEntry: number;                   // (atr14 / entryPrice) * 100
  htfDistancePct: number | null; // % distancia entryPrice vs EMA21 del HTF (1H). null si HTF features no disponibles. Proxy de "qué tan extendido del HTF trend".
  entryHourUtc: number;                    // 0-23
}

export interface BucketStats {
  count: number;
  wins: number;
  losses: number;
  pf: number;             // profit factor; Infinity si no hay losses, 0 si no hay wins
  wr: number;             // win rate %
  avgWinUsd: number;
  avgLossUsd: number;     // valor positivo
  totalPnlUsd: number;
  meanMfeR: number;
  pctTouched1R: number;   // % de trades del bucket que tocaron 1R (gross)
}

export interface BacktestMetadata {
  mfeComputationMode: 'intracandle_extreme';
  maeAfterMfeDefinition: 'global_mfe_relative';
  feeMetricsKind: 'estimated_round_trip';
  feeRateRoundTripPct: number;            // commissionRate * 2 * 100
  delta24hLookbackBars: number;
  volatilityBucketThresholds: { lowMax: number; medMax: number };
  delta24hBucketThresholds: { consolidationMax: number; momentumExtremeMin: number };
  sessionUtcRanges: Record<SessionLabel, [number, number]>;
  generatedAt: string;
  backtestVersion: string;
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

  // ───── Phase 1: bloque MFE/MAE ─────
  mfeMaxUsd: number;
  maeMaxUsd: number;                  // valor positivo
  mfeMaxR: number;
  maeMaxR: number;
  peakPrice: number;
  troughPrice: number;
  initialStopLoss: number;            // SL al abrir, no muta
  initialRiskUsd: number;             // qty * |entryPrice - initialSL|
  timeToMfeBars: number;
  timeToMaeBars: number;
  timeToCloseBars: number;
  maeOccurredBeforeMfe: boolean;      // timeToMaeBars < timeToMfeBars

  // ───── Phase 1: MAE split (Opción A simple) ─────
  // maeBeforeMfeUsd: max adverse en bars [0, peakBar-1]
  // maeAfterMfeUsd:  max adverse en bars [peakBar+1, end]
  // El peak bar se EXCLUYE de ambos (intracandle ordering desconocido).
  maeBeforeMfeUsd: number;
  maeAfterMfeUsd: number;
  maeBeforeMfeR: number;
  maeAfterMfeR: number;

  // ───── Phase 1: RR-touched flags brutas ─────
  touched0_5R: boolean;
  touched1R: boolean;
  touched2R: boolean;
  touched3R: boolean;

  // ───── Phase 1: fees estimadas (round-trip approx) ─────
  feeRateRtPct: number;                       // commissionRate * 2 * 100
  entryFeeUsd: number;
  exitFeeAtPeakUsd: number;                   // hipotético: si exit fuera al peak
  mfeMaxUsdAfterFeesEstimate: number;         // mfeMaxUsd - entryFee - exitFeeAtPeak
  mfeMaxRAfterFeesEstimate: number;
  touched0_5RAfterFeesEstimate: boolean;
  touched1RAfterFeesEstimate: boolean;
  touched2RAfterFeesEstimate: boolean;
  touched3RAfterFeesEstimate: boolean;

  // ───── Phase 1: contexto al entry ─────
  delta24hAtEntry: number | null;
  atrPctAtEntry: number;
  volatilityBucket: VolatilityBucket;
  htfDistancePct: number | null;
  entryHourUtc: number;
  sessionLabel: SessionLabel;
  delta24hBucket: Delta24hBucket | null;      // null si delta24hAtEntry es null
}

export interface MfeMaeStats {
  pctTouched0_5R: number;
  pctTouched1R: number;
  pctTouched2R: number;
  pctTouched3R: number;
  pctTouched0_5RAfterFees: number;
  pctTouched1RAfterFees: number;
  pctTouched2RAfterFees: number;
  pctTouched3RAfterFees: number;
  meanMfeR_winners: number;
  meanMfeR_losers: number;
  meanMaeR_winners: number;
  meanMaeR_losers: number;
  meanMfeR_AfterFees_winners: number;
  meanMfeR_AfterFees_losers: number;
}

export interface BucketAnalysis {
  delta24h: Record<Delta24hBucket, BucketStats>;
  volatility: Record<VolatilityBucket, BucketStats>;
  session: Record<SessionLabel, BucketStats>;
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

  // ───── Phase 1: agregados nuevos ─────
  mfeMaeStats: MfeMaeStats;
  bucketAnalysis: BucketAnalysis;
  metadata: BacktestMetadata;
}
