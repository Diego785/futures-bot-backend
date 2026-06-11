// Motor de backtest v2 — CLI (Fase C.3). Read-only sobre las velas locales (Regla Cero: NO ejecuta).
//
// Uso (tras `npm run build`):
//   node dist/backtest/run.js --symbol BTCUSDT --tf 4h --gatillo C --tp fixedR
//   node dist/backtest/run.js --grid --symbol BTCUSDT --tfs 4h,1h,15m   (rejilla A/B/C × fixedR/liquidity)
//   node dist/backtest/run.js --info                                     (inventario de velas en la DB)
// Flags: --limit N · --from YYYY-MM-DD · --to YYYY-MM-DD · --fee 0.0005 · --slip 0 · --r 2 ·
//        --sl-buffer 0.1 · --swing 10 · --min-rr 1 · --be 0.5 · --max-wait 0
// Registro (visor): añadir --register [--note "..."] a un single-run → persiste la corrida COMPLETA
// (params resueltos + paramsHash + comando reproducible + embudo de señales) en backtest_runs/
// backtest_signals para el replay del dashboard. Requiere `npm run migration:run` previo.

import { execSync } from 'child_process';
import { NestFactory } from '@nestjs/core';
import { BacktestModule } from './backtest.module';
import { CandleRepository } from '../market-data/candle.repository';
import { BacktestRunRepository } from './backtest-run.repository';
import { buildSignalRows, makeParamsHash } from './register.mapper';
import { runBacktest, runGrid, type BacktestReport, type RunnerCandle } from './backtest.runner';
import { walkForward, type WalkForwardResult } from './walkforward';
import { computeHtfBias, alignBias, type BiasPoint } from './htf-bias';
import { DEFAULT_SIGNAL_CONFIG, type SignalConfig } from './signal-source';
import { DEFAULT_SIM_CONFIG, type SimConfig } from './trade-simulator';

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

function printWalkForward(wf: WalkForwardResult): void {
  console.log('');
  console.log(`=== Walk-forward ${wf.tf} | gatillo ${wf.gatillo} | TP ${wf.tpRule} | ${wf.windows.length} ventanas ===`);
  console.log('win  desde        hasta         N      expR     WR%    PF     maxDD');
  console.log('──── ──────────── ────────────  ─────  ───────  ─────  ─────  ──────');
  for (const w of wf.windows) {
    console.log(
      `${String(w.index).padEnd(4)} ${fmt(w.fromTime).padEnd(12)} ${fmt(w.toTime).padEnd(12)}  ${String(w.trades).padStart(5)}  ${signed(w.expectancyR).padStart(7)}  ${pct(w.winRate).padStart(5)}  ${pf(w.profitFactor).padStart(5)}  ${w.maxDrawdownR.toFixed(2).padStart(6)}`,
    );
  }
  console.log('────');
  console.log(`Ventanas con trades: ${wf.windowsCount} | rentables: ${wf.profitableWindows} (${pct(wf.pctProfitable)}%)`);
  console.log(
    `N total: ${wf.totalTrades} | expectancy pooled: ${signed(wf.pooledExpectancyR)}R | mediana ventana: ${signed(wf.medianExpectancyR)}R`,
  );
  console.log(`peor ventana: ${signed(wf.worstExpectancyR)}R | desviación entre ventanas: ${wf.stdExpectancyR.toFixed(3)}R`);
  console.log('');
  console.log('Criterio autonomía (§7): #5 ≥70 % de ventanas rentables · #1 N≥100. NO es veredicto (in-sample).');
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(BacktestModule, { logger: ['error', 'warn'] });
  try {
    const repo = app.get(CandleRepository);
    const symbol = getArg('symbol', 'BTCUSDT');
    const limit = parseInt(getArg('limit', '100000'), 10);
    const fromArg = getArg('from', '');
    const toArg = getArg('to', '');
    const from = toMs(fromArg);
    const to = toMs(toArg);

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
      minStopPct: parseFloat(getArg('min-stop-pct', '0.003')), // fee-aware: salta stops micro (<0.3%)
      cancelDistanceFrac: parseFloat(getArg('cancel-dist', '1')),
    };
    // Costes: por defecto maker/taker realista (entrada límite maker, SL taker). --fee fuerza tarifa única.
    const feeArg = getArg('fee', '');
    const simConfig: Partial<SimConfig> = {
      ...(feeArg !== ''
        ? { feeRatePerSide: parseFloat(feeArg) }
        : { makerFee: parseFloat(getArg('maker', '0.0002')), takerFee: parseFloat(getArg('taker', '0.0005')) }),
      slippagePerSide: parseFloat(getArg('slip', '0')),
      breakevenAtTpFraction: parseFloat(getArg('be', '0.5')),
      maxWaitFillBars: parseInt(getArg('max-wait', '0'), 10),
    };

    // Sesgo HTF (multi-TF): --htf <tf> filtra gatillos a favor de ese TF. --htf2 <tf> añade un segundo
    // TF y exige UNANIMIDAD (sesgo más estricto, p.ej. --htf 4h --htf2 1d). Historia HTF completa.
    const htfTf = getArg('htf', '');
    const htfTf2 = getArg('htf2', '');
    let htfBias: BiasPoint[] = [];
    if (htfTf) {
      const sw = parseInt(getArg('swing', '10'), 10);
      const b1 = computeHtfBias(await loadCandles(repo, symbol, htfTf, limit), sw);
      if (htfTf2) {
        const b2 = computeHtfBias(await loadCandles(repo, symbol, htfTf2, limit), sw);
        htfBias = alignBias([b1, b2]);
        console.log(`Sesgo HTF ${htfTf}+${htfTf2} alineados: ${htfBias.length} cambios de estructura`);
      } else {
        htfBias = b1;
        console.log(`Sesgo HTF ${htfTf}: ${htfBias.length} cambios de estructura`);
      }
    }

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
        all.push(...runGrid(symbol, tf, candles, gatillos, tps, signalBase, simConfig, htfBias));
      }
      printGrid(all);
      return;
    }

    if (hasFlag('wf')) {
      const tf = getArg('tf', '15m');
      const candles = await loadCandles(repo, symbol, tf, limit, from, to);
      if (candles.length === 0) {
        console.log(`Sin velas para ${symbol} ${tf}.`);
        return;
      }
      const windows = parseInt(getArg('windows', '6'), 10);
      const gatillo = getArg('gatillo', 'C') as SignalConfig['gatillo'];
      const tpRule = getArg('tp', 'fixedR') as SignalConfig['tpRule'];
      printWalkForward(walkForward(symbol, tf, candles, windows, { ...signalBase, gatillo, tpRule }, simConfig, htfBias));
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
    const report = runBacktest(symbol, tf, candles, { ...signalBase, gatillo, tpRule }, simConfig, htfBias);
    printReport(report);

    // --register: persiste la corrida COMPLETA (reproducible) para el visor. Solo single-run.
    if (hasFlag('register')) {
      // Params RESUELTOS (defaults incluidos): lo que la corrida USÓ de verdad, no lo que se tipeó.
      // Lección de la revisión 2026-06-10: un default implícito (--limit) cambió el dataset sin que
      // nadie lo notara. El orden de claves es fijo (literal) → paramsHash estable y comparable.
      const signalFull = { ...DEFAULT_SIGNAL_CONFIG, ...signalBase, gatillo, tpRule };
      const simFull = { ...DEFAULT_SIM_CONFIG, ...simConfig };
      const params: Record<string, unknown> = {
        symbol,
        tf,
        signal: signalFull,
        sim: simFull,
        htf: htfTf || null,
        htf2: htfTf2 || null,
      };
      const createdAt = Date.now();
      const runId = `bt_${createdAt}`;
      let engineVersion = 'unknown';
      try {
        engineVersion = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
          .toString()
          .trim();
      } catch {
        /* sin git (p. ej. deploy sin .git) → 'unknown' */
      }
      const cmd = [
        'npm run backtest --',
        `--symbol ${symbol}`,
        `--tf ${tf}`,
        `--gatillo ${gatillo}`,
        `--tp ${tpRule}`,
        `--r ${signalFull.rMultipleTp}`,
        `--sl-buffer ${signalFull.slBufferFrac}`,
        `--swing ${signalFull.swingLookback}`,
        `--min-rr ${signalFull.minRr}`,
        `--min-stop-pct ${signalFull.minStopPct}`,
        `--cancel-dist ${signalFull.cancelDistanceFrac}`,
        feeArg !== ''
          ? `--fee ${simFull.feeRatePerSide}`
          : `--maker ${simFull.makerFee} --taker ${simFull.takerFee}`,
        `--slip ${simFull.slippagePerSide}`,
        `--be ${simFull.breakevenAtTpFraction}`,
        `--max-wait ${simFull.maxWaitFillBars}`,
        `--limit ${limit}`,
        ...(fromArg ? [`--from ${fromArg}`] : []),
        ...(toArg ? [`--to ${toArg}`] : []),
        ...(htfTf ? [`--htf ${htfTf}`] : []),
        ...(htfTf2 ? [`--htf2 ${htfTf2}`] : []),
        '--register',
      ].join(' ');

      const signalRows = buildSignalRows(runId, report.intents, report.rejects, report.results);
      await app.get(BacktestRunRepository).saveRun(
        {
          id: runId,
          createdAt,
          symbol,
          tf,
          fromTime: report.firstTime,
          toTime: report.lastTime,
          candleCount: report.candles,
          engineVersion,
          paramsHash: makeParamsHash(params),
          command: cmd,
          params,
          metrics: report.metrics as unknown as Record<string, unknown>,
          biasPoints: htfBias.length > 0 ? htfBias : null,
          note: getArg('note', ''),
        },
        signalRows,
      );
      console.log('');
      console.log(`✓ Corrida registrada: ${runId} (engine ${engineVersion}, paramsHash ${makeParamsHash(params)})`);
      console.log(
        `  Señales persistidas: ${signalRows.length} (${report.metrics.trades} trades · ${report.metrics.cancelled} canceladas · ${report.metrics.expired} expiradas · ${report.rejects.length} descartadas)`,
      );
      console.log(`  Comando: ${cmd}`);
    }
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('Backtest failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
