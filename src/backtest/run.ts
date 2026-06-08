// Motor de backtest v2 — CLI (Fase C.3). Read-only sobre las velas locales (Regla Cero: NO ejecuta).
//
// Uso (tras `npm run build`):
//   node dist/backtest/run.js --symbol BTCUSDT --tf 4h --gatillo C --tp fixedR
//   node dist/backtest/run.js --grid --symbol BTCUSDT --tfs 4h,1h,15m   (rejilla A/B/C × fixedR/liquidity)
//   node dist/backtest/run.js --info                                     (inventario de velas en la DB)
// Flags: --limit N · --from YYYY-MM-DD · --to YYYY-MM-DD · --fee 0.0005 · --slip 0 · --r 2 ·
//        --sl-buffer 0.1 · --swing 10 · --min-rr 1 · --be 0.5 · --max-wait 0

import { NestFactory } from '@nestjs/core';
import { BacktestModule } from './backtest.module';
import { CandleRepository } from '../market-data/candle.repository';
import { runBacktest, runGrid, type BacktestReport, type RunnerCandle } from './backtest.runner';
import type { SignalConfig } from './signal-source';
import type { SimConfig } from './trade-simulator';

const args = process.argv.slice(2);
const getArg = (name: string, def: string): string => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  if (a) return a.split('=').slice(1).join('=');
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--')) return args[i + 1];
  return def;
};
const hasFlag = (name: string): boolean => args.includes(`--${name}`);
const toMs = (d: string): number | undefined => (d ? new Date(d + 'T00:00:00Z').getTime() : undefined);
const fmt = (ms: number | null): string => (ms == null ? '—' : new Date(ms).toISOString().slice(0, 10));
const pf = (n: number): string => (n === Infinity ? 'inf' : n.toFixed(2));
const pct = (n: number): string => (n * 100).toFixed(1);
const signed = (n: number): string => (n >= 0 ? '+' : '') + n.toFixed(3);

async function loadCandles(
  repo: CandleRepository,
  symbol: string,
  tf: string,
  limit: number,
  from?: number,
  to?: number,
): Promise<RunnerCandle[]> {
  const rows = await repo.findCandles({ symbol, tf, limit, from, to });
  return rows
    .filter((r) => r.isClosed)
    .map((r) => ({
      openTime: r.openTime,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      closeTime: r.closeTime,
    }));
}

function printReport(r: BacktestReport): void {
  const m = r.metrics;
  console.log('');
  console.log(`=== Backtest ${r.symbol} ${r.tf} | gatillo ${r.gatillo} | TP ${r.tpRule} ===`);
  console.log(`Velas:     ${r.candles} (${fmt(r.firstTime)} → ${fmt(r.lastTime)})`);
  console.log(
    `Señales:   ${m.signals} | Trades: ${m.trades} | Canceladas: ${m.cancelled} | Expiradas: ${m.expired} | Fill-rate: ${pct(m.fillRate)}%`,
  );
  console.log(
    `Expectancy: ${signed(m.expectancyR)}R | Winrate: ${pct(m.winRate)}% | PF: ${pf(m.profitFactor)} | maxDD: ${m.maxDrawdownR.toFixed(2)}R | totalR: ${signed(m.totalR)}`,
  );
  console.log(`avgWin: ${signed(m.avgWinR)}R | avgLoss: ${signed(m.avgLossR)}R`);
  console.log(
    `Salidas:   TP ${m.exitReasons.TP} · SL ${m.exitReasons.SL} · BE ${m.exitReasons.BE} · maxHold ${m.exitReasons.maxHold} · endOfData ${m.exitReasons.endOfData}`,
  );
  console.log(
    `R dist:    ${Object.entries(m.rDistribution).map(([k, v]) => `${k}:${v}`).join(' · ')}`,
  );
}

function printGrid(reports: BacktestReport[]): void {
  const rows = [...reports].sort((a, b) => b.metrics.expectancyR - a.metrics.expectancyR);
  console.log('');
  console.log('=== Rejilla de variantes (ordenada por expectancy) ===');
  console.log('TF     GAT  TP         N     fill%   expR     WR%    PF     maxDD   totalR');
  console.log('────── ──── ────────── ───── ─────── ──────── ────── ────── ─────── ────────');
  for (const r of rows) {
    const m = r.metrics;
    console.log(
      `${r.tf.padEnd(6)} ${r.gatillo.padEnd(4)} ${r.tpRule.padEnd(10)} ${String(m.trades).padStart(5)} ${pct(m.fillRate).padStart(6)}  ${signed(m.expectancyR).padStart(7)}  ${pct(m.winRate).padStart(5)}  ${pf(m.profitFactor).padStart(5)}  ${m.maxDrawdownR.toFixed(2).padStart(6)}  ${signed(m.totalR).padStart(7)}`,
    );
  }
  console.log('');
  console.log('Nota: in-sample. NO es veredicto de autonomía (ver criterio pre-registrado, doc §7).');
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(BacktestModule, { logger: ['error', 'warn'] });
  try {
    const repo = app.get(CandleRepository);
    const symbol = getArg('symbol', 'BTCUSDT');
    const limit = parseInt(getArg('limit', '100000'), 10);
    const from = toMs(getArg('from', ''));
    const to = toMs(getArg('to', ''));

    if (hasFlag('info')) {
      const tfs = getArg('tfs', '1m,5m,15m,1h,4h,1d').split(',');
      console.log(`\nInventario de velas (${symbol}):`);
      for (const tf of tfs) {
        const c = await loadCandles(repo, symbol, tf, limit, from, to);
        if (c.length) console.log(`  ${tf.padEnd(4)} n=${String(c.length).padStart(6)}  ${fmt(c[0].openTime)} → ${fmt(c[c.length - 1].openTime)}`);
        else console.log(`  ${tf.padEnd(4)} (sin datos)`);
      }
      return;
    }

    const signalBase: Partial<SignalConfig> = {
      rMultipleTp: parseFloat(getArg('r', '2')),
      slBufferFrac: parseFloat(getArg('sl-buffer', '0.1')),
      swingLookback: parseInt(getArg('swing', '10'), 10),
      minRr: parseFloat(getArg('min-rr', '1')),
    };
    const simConfig: Partial<SimConfig> = {
      feeRatePerSide: parseFloat(getArg('fee', '0.0005')),
      slippagePerSide: parseFloat(getArg('slip', '0')),
      breakevenAtTpFraction: parseFloat(getArg('be', '0.5')),
      maxWaitFillBars: parseInt(getArg('max-wait', '0'), 10),
    };

    if (hasFlag('grid')) {
      const tfs = getArg('tfs', '4h,1h,15m').split(',').map((s) => s.trim());
      const gatillos = getArg('gatillos', 'A,B,C').split(',').map((s) => s.trim()) as SignalConfig['gatillo'][];
      const tps = getArg('tps', 'fixedR,liquidity').split(',').map((s) => s.trim()) as SignalConfig['tpRule'][];
      const all: BacktestReport[] = [];
      for (const tf of tfs) {
        const candles = await loadCandles(repo, symbol, tf, limit, from, to);
        if (candles.length === 0) {
          console.log(`(${tf}: sin velas, omitido)`);
          continue;
        }
        all.push(...runGrid(symbol, tf, candles, gatillos, tps, signalBase, simConfig));
      }
      printGrid(all);
      return;
    }

    const tf = getArg('tf', '4h');
    const candles = await loadCandles(repo, symbol, tf, limit, from, to);
    if (candles.length === 0) {
      console.log(`Sin velas para ${symbol} ${tf}. ¿Backfill pendiente?`);
      return;
    }
    const gatillo = getArg('gatillo', 'C') as SignalConfig['gatillo'];
    const tpRule = getArg('tp', 'fixedR') as SignalConfig['tpRule'];
    printReport(runBacktest(symbol, tf, candles, { ...signalBase, gatillo, tpRule }, simConfig));
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('Backtest failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
