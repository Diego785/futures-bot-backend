import { NestFactory } from '@nestjs/core';
import { BacktestModule } from './backtest.module';
import { BacktestService } from './backtest.service';
import type { BacktestConfig } from './interfaces';

async function main() {
  const args = process.argv.slice(2);
  const getArg = (name: string, def: string): string => {
    const arg = args.find((a) => a.startsWith(`--${name}=`));
    return arg ? arg.split('=')[1] : def;
  };
  const hasFlag = (name: string): boolean => args.includes(`--${name}`);

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
    commissionRate: 0.0005, // 0.05% per side
    cooldownCandles: Math.ceil(30 / minutes), // 30 min cooldown
    slAtrMultiplier: parseFloat(getArg('sl-atr', '2')),
    slMinPercent: parseFloat(getArg('sl-pct', '0.005')),
    rrRatio: parseFloat(getArg('rr', '1.5')),
    enableTrailing: getArg('no-trailing', '') === '' ? true : false,
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

  await app.close();
}

main().catch((err) => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
