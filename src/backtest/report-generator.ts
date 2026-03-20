import type { BacktestConfig, BacktestTrade, BacktestReport } from './interfaces';

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

  if (report.trades.length > 0) {
    console.log('');
    console.log('TRADES:');
    console.log('#  | Dir   | Entry      | Exit       | Exit By    | PnL      | Trail');
    console.log('---|-------|------------|------------|------------|----------|------');
    for (const t of report.trades) {
      const dir = t.direction.padEnd(5);
      const entry = t.entryPrice.toFixed(2).padStart(10);
      const exit = t.exitPrice.toFixed(2).padStart(10);
      const reason = t.exitReason.padEnd(10);
      const pnl = `${t.pnlUsd >= 0 ? '+' : ''}${t.pnlUsd.toFixed(2)}`.padStart(8);
      const trail = `P${t.trailingPhase}`;
      const date = new Date(t.entryTime).toISOString().slice(5, 16).replace('T', ' ');
      console.log(`${String(t.id).padStart(2)} | ${dir} | ${entry} | ${exit} | ${reason} | ${pnl} | ${trail}  ${date}`);
    }
  }

  console.log('');
}
