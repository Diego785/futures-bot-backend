import type {
  BacktestConfig,
  BacktestTrade,
  BacktestReport,
  MfeMaeStats,
  BucketAnalysis,
  BucketStats,
  BacktestMetadata,
  Delta24hBucket,
  VolatilityBucket,
  SessionLabel,
} from './interfaces';

const BACKTEST_VERSION = '1.0-phase1-instrumentation';

function computeBucketStats(trades: BacktestTrade[]): BucketStats {
  const wins = trades.filter((t) => t.pnlUsd > 0);
  const losses = trades.filter((t) => t.pnlUsd <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.pnlUsd, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlUsd, 0));
  const totalPnl = trades.reduce((s, t) => s + t.pnlUsd, 0);
  const meanMfeR = trades.length > 0
    ? trades.reduce((s, t) => s + t.mfeMaxR, 0) / trades.length
    : 0;
  const touched1RCount = trades.filter((t) => t.touched1R).length;

  return {
    count: trades.length,
    wins: wins.length,
    losses: losses.length,
    pf: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    wr: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
    avgWinUsd: wins.length > 0 ? grossProfit / wins.length : 0,
    avgLossUsd: losses.length > 0 ? grossLoss / losses.length : 0,
    totalPnlUsd: totalPnl,
    meanMfeR,
    pctTouched1R: trades.length > 0 ? (touched1RCount / trades.length) * 100 : 0,
  };
}

function computeMfeMaeStats(trades: BacktestTrade[]): MfeMaeStats {
  const n = trades.length;
  if (n === 0) {
    return {
      pctTouched0_5R: 0, pctTouched1R: 0, pctTouched2R: 0, pctTouched3R: 0,
      pctTouched0_5RAfterFees: 0, pctTouched1RAfterFees: 0,
      pctTouched2RAfterFees: 0, pctTouched3RAfterFees: 0,
      meanMfeR_winners: 0, meanMfeR_losers: 0,
      meanMaeR_winners: 0, meanMaeR_losers: 0,
      meanMfeR_AfterFees_winners: 0, meanMfeR_AfterFees_losers: 0,
    };
  }
  const wins = trades.filter((t) => t.pnlUsd > 0);
  const losses = trades.filter((t) => t.pnlUsd <= 0);
  const meanFn = (arr: BacktestTrade[], key: keyof BacktestTrade): number => {
    if (arr.length === 0) return 0;
    const sum = arr.reduce((s, t) => s + (t[key] as number), 0);
    return sum / arr.length;
  };

  return {
    pctTouched0_5R: (trades.filter((t) => t.touched0_5R).length / n) * 100,
    pctTouched1R: (trades.filter((t) => t.touched1R).length / n) * 100,
    pctTouched2R: (trades.filter((t) => t.touched2R).length / n) * 100,
    pctTouched3R: (trades.filter((t) => t.touched3R).length / n) * 100,
    pctTouched0_5RAfterFees: (trades.filter((t) => t.touched0_5RAfterFeesEstimate).length / n) * 100,
    pctTouched1RAfterFees: (trades.filter((t) => t.touched1RAfterFeesEstimate).length / n) * 100,
    pctTouched2RAfterFees: (trades.filter((t) => t.touched2RAfterFeesEstimate).length / n) * 100,
    pctTouched3RAfterFees: (trades.filter((t) => t.touched3RAfterFeesEstimate).length / n) * 100,
    meanMfeR_winners: meanFn(wins, 'mfeMaxR'),
    meanMfeR_losers: meanFn(losses, 'mfeMaxR'),
    meanMaeR_winners: meanFn(wins, 'maeMaxR'),
    meanMaeR_losers: meanFn(losses, 'maeMaxR'),
    meanMfeR_AfterFees_winners: meanFn(wins, 'mfeMaxRAfterFeesEstimate'),
    meanMfeR_AfterFees_losers: meanFn(losses, 'mfeMaxRAfterFeesEstimate'),
  };
}

function computeBucketAnalysis(trades: BacktestTrade[]): BucketAnalysis {
  const bucketBy = <K extends string>(
    keys: readonly K[],
    extractor: (t: BacktestTrade) => K | null,
  ): Record<K, BucketStats> => {
    const result = {} as Record<K, BucketStats>;
    for (const k of keys) {
      result[k] = computeBucketStats(trades.filter((t) => extractor(t) === k));
    }
    return result;
  };

  const delta24hKeys: Delta24hBucket[] = ['CONSOLIDATION', 'NORMAL', 'MOMENTUM_EXTREME'];
  const volKeys: VolatilityBucket[] = ['LOW', 'MED', 'HIGH'];
  const sessionKeys: SessionLabel[] = ['ASIA', 'EU', 'OVERLAP', 'US'];

  return {
    delta24h: bucketBy(delta24hKeys, (t) => t.delta24hBucket),
    volatility: bucketBy(volKeys, (t) => t.volatilityBucket),
    session: bucketBy(sessionKeys, (t) => t.sessionLabel),
  };
}

function buildMetadata(config: BacktestConfig): BacktestMetadata {
  const tfMinutes: Record<string, number> = { '1m': 1, '5m': 5, '15m': 15, '1h': 60 };
  const minutes = tfMinutes[config.timeframe] || 15;
  return {
    mfeComputationMode: 'intracandle_extreme',
    maeAfterMfeDefinition: 'global_mfe_relative',
    feeMetricsKind: 'estimated_round_trip',
    feeRateRoundTripPct: config.commissionRate * 2 * 100,
    delta24hLookbackBars: Math.floor((24 * 60) / minutes),
    volatilityBucketThresholds: { lowMax: 0.20, medMax: 0.40 },
    delta24hBucketThresholds: { consolidationMax: 1.0, momentumExtremeMin: 3.0 },
    sessionUtcRanges: {
      ASIA: [0, 7],
      EU: [7, 12],
      OVERLAP: [12, 16],
      US: [16, 24],
    },
    generatedAt: new Date().toISOString(),
    backtestVersion: BACKTEST_VERSION,
  };
}

export function generateReport(
  config: BacktestConfig,
  trades: BacktestTrade[],
  totalCandles: number,
  gatePassCount: number,
): BacktestReport {
  const wins = trades.filter((t) => t.pnlUsd > 0);
  const losses = trades.filter((t) => t.pnlUsd <= 0);
  const totalPnl = trades.reduce((sum, t) => sum + t.pnlUsd, 0);
  const grossProfit = wins.reduce((sum, t) => sum + t.pnlUsd, 0);
  const grossLoss = Math.abs(losses.reduce((sum, t) => sum + t.pnlUsd, 0));

  // Equity curve
  let balance = config.initialBalance;
  const equityCurve: number[] = [balance];
  for (const t of trades) {
    balance += t.pnlUsd;
    equityCurve.push(balance);
  }

  // Max drawdown
  let peak = config.initialBalance;
  let maxDrawdown = 0;
  for (const eq of equityCurve) {
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  return {
    config,
    summary: {
      totalCandles,
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: trades.length > 0 ? (wins.length / trades.length) * 100 : 0,
      totalPnlUsd: totalPnl,
      avgWinUsd: wins.length > 0 ? grossProfit / wins.length : 0,
      avgLossUsd: losses.length > 0 ? grossLoss / losses.length : 0,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
      maxDrawdownUsd: maxDrawdown,
      gatePassRate: totalCandles > 0 ? (gatePassCount / totalCandles) * 100 : 0,
    },
    equityCurve,
    trades,
    mfeMaeStats: computeMfeMaeStats(trades),
    bucketAnalysis: computeBucketAnalysis(trades),
    metadata: buildMetadata(config),
  };
}

export function printReport(report: BacktestReport): void {
  const s = report.summary;
  const c = report.config;

  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log(`║   BACKTEST REPORT — ${c.symbol} ${c.timeframe}`.padEnd(43) + '║');
  console.log(`║   ${c.days} days (${s.totalCandles} candles) | Mode: ${c.mode}`.padEnd(43) + '║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║ Trades:       ${s.totalTrades} (${s.wins}W / ${s.losses}L)`.padEnd(43) + '║');
  console.log(`║ Win Rate:     ${s.winRate.toFixed(1)}%`.padEnd(43) + '║');
  console.log(`║ Total PnL:    ${s.totalPnlUsd >= 0 ? '+' : ''}$${s.totalPnlUsd.toFixed(2)}`.padEnd(43) + '║');
  console.log(`║ Avg Win:      +$${s.avgWinUsd.toFixed(2)}`.padEnd(43) + '║');
  console.log(`║ Avg Loss:     -$${s.avgLossUsd.toFixed(2)}`.padEnd(43) + '║');
  console.log(`║ Profit Factor: ${s.profitFactor === Infinity ? '∞' : s.profitFactor.toFixed(2)}`.padEnd(43) + '║');
  console.log(`║ Max Drawdown: -$${s.maxDrawdownUsd.toFixed(2)}`.padEnd(43) + '║');
  console.log(`║ Gate Pass:    ${s.gatePassRate.toFixed(1)}%`.padEnd(43) + '║');
  console.log('╚══════════════════════════════════════════╝');

  // ───── Phase 1: MFE/MAE distribution ─────
  const m = report.mfeMaeStats;
  console.log('');
  console.log('=== MFE/MAE Distribution ===');
  console.log(`Trades:                    ${s.totalTrades}`);
  console.log(`% touched 0.5R (gross):    ${m.pctTouched0_5R.toFixed(1)}%`);
  console.log(`% touched 1R   (gross):    ${m.pctTouched1R.toFixed(1)}%`);
  console.log(`% touched 2R   (gross):    ${m.pctTouched2R.toFixed(1)}%`);
  console.log(`% touched 3R   (gross):    ${m.pctTouched3R.toFixed(1)}%`);
  console.log(`% touched 1R   (net fees): ${m.pctTouched1RAfterFees.toFixed(1)}%`);
  console.log(`Mean MFE-R (winners):      ${m.meanMfeR_winners.toFixed(2)}`);
  console.log(`Mean MFE-R (losers):       ${m.meanMfeR_losers.toFixed(2)}  ← si > 0, parciales pueden ayudar`);
  console.log(`Mean MAE-R (winners):      ${m.meanMaeR_winners.toFixed(2)}`);
  console.log(`Mean MAE-R (losers):       ${m.meanMaeR_losers.toFixed(2)}`);

  // ───── Phase 1: Bucket analysis ─────
  const formatBucket = (name: string, b: BucketStats): void => {
    const pf = b.pf === Infinity ? '∞' : b.pf.toFixed(2);
    console.log(
      `${name.padEnd(20)} ${String(b.count).padStart(6)}  ${pf.padStart(6)}  ${b.wr.toFixed(1).padStart(5)}%  ` +
      `+$${b.avgWinUsd.toFixed(2).padStart(7)}  -$${b.avgLossUsd.toFixed(2).padStart(7)}  ` +
      `${b.meanMfeR.toFixed(2).padStart(5)}  ${b.pctTouched1R.toFixed(1).padStart(5)}%`,
    );
  };

  console.log('');
  console.log('=== Bucket: Δ24h (hipótesis agotamiento) ===');
  console.log('Bucket               Trades    PF      WR     AvgWin     AvgLoss    MeanMfeR  Touch1R%');
  formatBucket('CONSOLIDATION', report.bucketAnalysis.delta24h.CONSOLIDATION);
  formatBucket('NORMAL', report.bucketAnalysis.delta24h.NORMAL);
  formatBucket('MOMENTUM_EXTREME', report.bucketAnalysis.delta24h.MOMENTUM_EXTREME);

  console.log('');
  console.log('=== Bucket: Volatility (ATR%) ===');
  console.log('Bucket               Trades    PF      WR     AvgWin     AvgLoss    MeanMfeR  Touch1R%');
  formatBucket('LOW (<0.20%)', report.bucketAnalysis.volatility.LOW);
  formatBucket('MED (0.20-0.40%)', report.bucketAnalysis.volatility.MED);
  formatBucket('HIGH (>0.40%)', report.bucketAnalysis.volatility.HIGH);

  console.log('');
  console.log('=== Bucket: Session (UTC) ===');
  console.log('Bucket               Trades    PF      WR     AvgWin     AvgLoss    MeanMfeR  Touch1R%');
  formatBucket('ASIA (0-7)', report.bucketAnalysis.session.ASIA);
  formatBucket('EU (7-12)', report.bucketAnalysis.session.EU);
  formatBucket('OVERLAP (12-16)', report.bucketAnalysis.session.OVERLAP);
  formatBucket('US (16-24)', report.bucketAnalysis.session.US);

  console.log('');
  console.log('=== Metadata ===');
  console.log(`MFE mode:           ${report.metadata.mfeComputationMode}`);
  console.log(`MAE-after-MFE def:  ${report.metadata.maeAfterMfeDefinition}`);
  console.log(`Fee metrics:        ${report.metadata.feeMetricsKind} @ ${report.metadata.feeRateRoundTripPct.toFixed(3)}% RT`);
  console.log(`Δ24h lookback:      ${report.metadata.delta24hLookbackBars} bars`);
  console.log(`Backtest version:   ${report.metadata.backtestVersion}`);
  console.log('');

  if (report.trades.length > 0 && report.trades.length <= 50) {
    console.log('TRADES:');
    console.log('#  | Dir   | Entry      | Exit       | Exit By    | PnL      | MFE-R | MAE-R | Δ24h | Bucket');
    console.log('---|-------|------------|------------|------------|----------|-------|-------|------|------');
    for (const t of report.trades) {
      const dir = t.direction.padEnd(5);
      const entry = t.entryPrice.toFixed(2).padStart(10);
      const exit = t.exitPrice.toFixed(2).padStart(10);
      const reason = t.exitReason.padEnd(10);
      const pnl = `${t.pnlUsd >= 0 ? '+' : ''}${t.pnlUsd.toFixed(2)}`.padStart(8);
      const mfe = t.mfeMaxR.toFixed(2).padStart(5);
      const mae = t.maeMaxR.toFixed(2).padStart(5);
      const d24 = (t.delta24hAtEntry === null ? 'n/a' : t.delta24hAtEntry.toFixed(1)).padStart(5);
      const bucket = (t.delta24hBucket || '?').slice(0, 6);
      console.log(`${String(t.id).padStart(2)} | ${dir} | ${entry} | ${exit} | ${reason} | ${pnl} | ${mfe} | ${mae} | ${d24} | ${bucket}`);
    }
  } else if (report.trades.length > 50) {
    console.log(`(${report.trades.length} trades — truncated. Use --export-trades-csv for full list)`);
  }

  console.log('');
}
