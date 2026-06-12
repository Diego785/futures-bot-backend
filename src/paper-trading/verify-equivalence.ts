// P.2 — VERIFICACIÓN DE EQUIVALENCIA ventana-vs-historial-completo (condición del gate #7).
// Corre el PaperEngine VENTANEADO vela a vela (como en vivo) contra runBacktest full-history sobre
// AÑOS de datos reales y compara los trades 1:1. READ-ONLY (Regla Cero): solo lee velas de la DB.
//
// Uso (tras `npm run build`):
//   node dist/paper-trading/verify-equivalence.js --symbol BTCUSDT [--limit 200000]
//
// Criterio: todo trade del backtest cuya señal nace DESPUÉS del warmup de la ventana debe existir
// en el paper con el MISMO desenlace (fill, salida, R). Divergencia = bug del cableado → se arregla
// antes de encender el reloj.

import { NestFactory } from '@nestjs/core';
import { BacktestModule } from '../backtest/backtest.module';
import { CandleRepository } from '../market-data/candle.repository';
import { computeHtfBias } from '../backtest/htf-bias';
import { runBacktest, type RunnerCandle } from '../backtest/backtest.runner';
import { PaperEngine } from './paper-engine';
import { FROZEN_SIGNAL, FROZEN_SIM, PAPER_HTF, PAPER_TF, PAPER_WINDOW_BARS } from './frozen-candidate';

const args = process.argv.slice(2);
const getArg = (name: string, def: string): string => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  if (a) return a.split('=').slice(1).join('=');
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--')) return args[i + 1];
  return def;
};

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(BacktestModule, { logger: ['error', 'warn'] });
  try {
    const repo = app.get(CandleRepository);
    const symbol = getArg('symbol', 'BTCUSDT');
    const limit = parseInt(getArg('limit', '200000'), 10);

    const rows = await repo.findCandles({ symbol, tf: PAPER_TF, limit });
    const candles: RunnerCandle[] = rows
      .filter((r) => r.isClosed)
      .map((r) => ({ openTime: r.openTime, open: r.open, high: r.high, low: r.low, close: r.close, closeTime: r.closeTime }));
    const h4 = await repo.findCandles({ symbol, tf: PAPER_HTF, limit });
    const bias = computeHtfBias(
      h4.filter((r) => r.isClosed).map((r) => ({ openTime: r.openTime, open: r.open, high: r.high, low: r.low, close: r.close, closeTime: r.closeTime })),
      FROZEN_SIGNAL.swingLookback,
    );
    console.log(`${symbol}: ${candles.length} velas ${PAPER_TF} · ventana=${PAPER_WINDOW_BARS} · bias ${bias.length} cambios`);

    // 1) Referencia: backtest full-history (el candidato congelado tal cual).
    const bt = runBacktest(symbol, PAPER_TF, candles, FROZEN_SIGNAL, FROZEN_SIM, bias);
    const btTrades = new Map(
      bt.results.filter((r) => r.outcome === 'filled' && r.trade).map((r) => [r.intentId, r.trade!]),
    );

    // 2) Paper: engine VENTANEADO alimentado vela a vela (exactamente como en vivo).
    const engine = new PaperEngine(symbol, PAPER_TF, FROZEN_SIGNAL, FROZEN_SIM, PAPER_WINDOW_BARS);
    for (const c of candles) engine.onClosedCandle(c, bias);
    const paperTrades = new Map(engine.closedTrades().map((t) => [t.id, t]));

    // 3) Comparación 1:1 sobre las señales post-warmup (la ventana inicial no tiene historia previa
    //    en el paper real: allí la rehidratación parte igual de velas persistidas → mismo contrato).
    const warmupEnd = candles[Math.min(PAPER_WINDOW_BARS, candles.length - 1)].openTime;
    let compared = 0;
    let mismatches = 0;
    for (const [id, t] of btTrades) {
      if (t.signalBarTime <= warmupEnd) continue;
      compared++;
      const p = paperTrades.get(id);
      if (!p) {
        mismatches++;
        console.log(`✗ FALTA en paper: ${id} (${t.exitReason} ${t.rMultiple}R)`);
        continue;
      }
      const same =
        p.entryTime === t.entryTime &&
        p.exitTime === t.exitTime &&
        p.exitReason === t.exitReason &&
        Math.abs(p.rMultiple - t.rMultiple) < 1e-9;
      if (!same) {
        mismatches++;
        console.log(`✗ DIVERGE ${id}: bt=${t.exitReason}@${t.exitTime} ${t.rMultiple}R · paper=${p.exitReason}@${p.exitTime} ${p.rMultiple}R`);
      }
    }
    // Señales del paper que el backtest no tiene (post-warmup) — también es divergencia.
    for (const [id, p] of paperTrades) {
      if (p.signalBarTime <= warmupEnd) continue;
      if (!btTrades.has(id)) {
        mismatches++;
        console.log(`✗ SOBRA en paper: ${id} (${p.exitReason} ${p.rMultiple}R)`);
      }
    }

    console.log('');
    console.log(`Trades comparados (post-warmup): ${compared} · divergencias: ${mismatches}`);
    console.log(mismatches === 0 ? '✓ EQUIVALENCIA EXACTA ventana-vs-full — condición del gate CUMPLIDA' : '✗ HAY DIVERGENCIAS — arreglar antes de encender el reloj');
    if (mismatches > 0) process.exitCode = 1;
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('verify-equivalence failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
