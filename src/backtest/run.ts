import { NestFactory } from '@nestjs/core';
import { BacktestModule } from './backtest.module';
import { BacktestService } from './backtest.service';
import type {
  BacktestConfig,
  SessionLabel,
  Delta24hBucket,
} from './interfaces';

async function main() {
  const args = process.argv.slice(2);
  const getArg = (name: string, def: string): string => {
    const arg = args.find((a) => a.startsWith(`--${name}=`));
    return arg ? arg.split('=')[1] : def;
  };
  const hasFlag = (name: string): boolean => args.includes(`--${name}`);

  const validSessions: readonly SessionLabel[] = ['ASIA', 'EU', 'OVERLAP', 'US'];
  const validDelta24h: readonly Delta24hBucket[] = ['CONSOLIDATION', 'NORMAL', 'MOMENTUM_EXTREME'];

  const parseSessionList = (raw: string): SessionLabel[] => {
    if (!raw) return [];
    return raw.split(',').map((s) => s.trim().toUpperCase()).filter((s): s is SessionLabel =>
      (validSessions as readonly string[]).includes(s),
    );
  };
  const parseDelta24hList = (raw: string): Delta24hBucket[] => {
    if (!raw) return [];
    return raw.split(',').map((s) => s.trim().toUpperCase()).filter((s): s is Delta24hBucket =>
      (validDelta24h as readonly string[]).includes(s),
    );
  };

  const timeframe = getArg('timeframe', '15m');
  const tfMinutes: Record<string, number> = {
    '1m': 1,
    '5m': 5,
    '15m': 15,
    '1h': 60,
  };
  const minutes = tfMinutes[timeframe] || 15;

  const config: BacktestConfig = {
    symbol: getArg('symbol', 'BTCUSDT'),
    timeframe,
    days: parseInt(getArg('days', '30'), 10),
    mode: getArg('mode', 'gate-only') as BacktestConfig['mode'],
    gateEntryThreshold: parseInt(getArg('gate-threshold', '60'), 10),
    initialBalance: parseFloat(getArg('balance', '100')),
    maxLeverage: parseInt(getArg('leverage', '5'), 10),
    commissionRate: parseFloat(getArg('commission', '0.00055')), // 0.055% per side = Bybit taker real (was 0.0005, 10bp optimistic)
    cooldownCandles: Math.ceil(30 / minutes), // 30 min cooldown
    slAtrMultiplier: parseFloat(getArg('sl-atr', '2')),
    slMinPercent: parseFloat(getArg('sl-pct', '0.005')),
    rrRatio: parseFloat(getArg('rr', '1.5')),
    enableTrailing: !hasFlag('no-trailing'),
    requireOBFVG: getArg('require-obfvg', '') !== '',
    pullbackMaxWaitCandles: parseInt(getArg('max-wait', '12'), 10),
    pullbackSlBuffer: parseFloat(getArg('ob-sl-buffer', '0.3')),
    pullbackZoneType: getArg('zone-type', 'both') as 'ob' | 'fvg' | 'both',
    pullbackMaxDistance: parseFloat(getArg('max-distance', '1.5')),
    pullbackMinDistance: parseFloat(getArg('min-distance', '0.05')),
    trailingBreakevenPct: parseFloat(getArg('be-pct', '0.3')),
    startDate: getArg('start-date', '') || undefined,
    endDate: getArg('end-date', '') || undefined,
    filterPremiumDiscount: hasFlag('filter-pd'),
    filterRsiExtreme: hasFlag('filter-rsi'),
    filterCandlePattern: hasFlag('filter-candle'),
    filterZoneConfluence: hasFlag('filter-confluence'),
    filterVolumeConfirm: hasFlag('filter-volume'),
    rsiLongMax: parseFloat(getArg('rsi-long-max', '40')),
    rsiShortMin: parseFloat(getArg('rsi-short-min', '60')),
    volumeMultiplier: parseFloat(getArg('vol-mult', '1.2')),
    trailMode: (getArg('trail-mode', 'entry-pct') as 'entry-pct' | 'tp-distance' | 'fixed-amount'),
    trailFixed: parseFloat(getArg('trail-fixed', '100')),
    trailActivation: parseFloat(getArg('trail-activation', getArg('trail-fixed', '100'))),
    pullbackLooseHtf: hasFlag('loose-htf'),
    pullbackMinAtrPct: parseFloat(getArg('min-atr-pct', '0')),
    pullbackFreshChoch: hasFlag('fresh-choch'),
    pullbackHtf4hTiebreaker: hasFlag('htf-4h-tiebreaker'),
    pullbackHtf4hTiebreakerSoft: hasFlag('htf-4h-tiebreaker-soft'),
    pullbackHtfFlipTolerant: hasFlag('htf-flip-tolerant'),
    pullbackSlopeSoft: hasFlag('slope-soft'),
    entrySlippage: parseFloat(getArg('entry-slippage', '0')),
    trailBreakevenAt: parseFloat(getArg('trail-breakeven-at', '0')),
    fillRate: parseFloat(getArg('fill-rate', '1.0')),
    adverseSlip: parseFloat(getArg('adverse-slip', '0')),
    pessimisticTrail: hasFlag('pessimistic-trail'),
    blockSessions: parseSessionList(getArg('block-session', '')),
    blockDelta24hBuckets: parseDelta24hList(getArg('block-delta24h-bucket', '')),
    // System B — Session Breakout
    sbRangeBars: parseInt(getArg('sb-range-bars', '12'), 10),
    sbRrRatio: parseFloat(getArg('sb-rr', '1.5')),
    sbMinRangeAtrMult: parseFloat(getArg('sb-min-range-atr', '0')),
    sbSessions: parseSessionList(getArg('sb-sessions', 'EU,OVERLAP,US')),
    // System B v2 — Mean Reversion
    mrRsiLong: parseFloat(getArg('mr-rsi-long', '25')),
    mrRsiShort: parseFloat(getArg('mr-rsi-short', '75')),
    mrRsiReset: parseFloat(getArg('mr-rsi-reset', '50')),
    mrSlAtrMult: parseFloat(getArg('mr-sl-atr', '1.0')),
    mrTpAtrMult: parseFloat(getArg('mr-tp-atr', '1.5')),
    mrCooldownBars: parseInt(getArg('mr-cooldown-bars', '6'), 10),
    mrSessions: parseSessionList(getArg('mr-sessions', 'EU,OVERLAP,US')),
    economicBe: hasFlag('economic-be'),
    economicBeSafetyPct: parseFloat(getArg('economic-be-safety-pct', '0.02')),
  };

  console.log('');
  console.log('Starting backtest with config:');
  console.log(`  Symbol:     ${config.symbol}`);
  console.log(`  Timeframe:  ${config.timeframe}`);
  if (config.startDate && config.endDate) {
    console.log(`  Period:     ${config.startDate} → ${config.endDate}`);
  } else {
    console.log(`  Days:       ${config.days}`);
  }
  console.log(`  Mode:       ${config.mode}`);
  console.log(`  Gate Entry: >= ${config.gateEntryThreshold}`);
  console.log(`  Balance:    $${config.initialBalance}`);
  console.log(`  Leverage:   ${config.maxLeverage}x`);
  console.log(`  Cooldown:   ${config.cooldownCandles} candles`);
  console.log('');

  const app = await NestFactory.createApplicationContext(BacktestModule, {
    logger: ['error', 'warn', 'log'],
  });

  const service = app.get(BacktestService);
  const report = await service.run(config);

  // Save report to file if requested
  const outputFile = getArg('output', '');
  if (outputFile) {
    const fs = await import('fs');
    fs.writeFileSync(outputFile, JSON.stringify(report, null, 2));
    console.log(`Report saved to ${outputFile}`);
  }

  // Phase 1: export per-trade CSV for ad-hoc sub-analysis
  const tradesCsv = getArg('export-trades-csv', '');
  if (tradesCsv) {
    const fs = await import('fs');
    if (report.trades.length === 0) {
      fs.writeFileSync(tradesCsv, '(no trades)\n');
      console.log(`No trades to export — wrote placeholder to ${tradesCsv}`);
    } else {
      const headers = Object.keys(report.trades[0]);
      const escapeCsv = (v: unknown): string => {
        if (v === null || v === undefined) return '';
        if (typeof v === 'string') return `"${v.replace(/"/g, '""')}"`;
        if (typeof v === 'boolean') return v ? '1' : '0';
        if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
        return String(v);
      };
      const rows = report.trades.map((t) =>
        headers.map((h) => escapeCsv((t as unknown as Record<string, unknown>)[h])).join(','),
      );
      fs.writeFileSync(tradesCsv, [headers.join(','), ...rows].join('\n'));
      console.log(`Trades CSV exported to ${tradesCsv} (${report.trades.length} rows × ${headers.length} cols)`);
    }
  }

  await app.close();
}

main().catch((err) => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
