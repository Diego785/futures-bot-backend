// Análisis de REALISMO DE FILL (sim↔real). Corre el candidato CONGELADO exigiendo que el precio
// CRUCE el CE por X×risk (no solo lo TOQUE) para llenar la límite. Muestra cuánto del +216R depende
// de fills "de roce" — el riesgo #1 de que la cuenta real rinda menos que el paper. Read-only (Regla
// Cero: NO ejecuta nada). Uso (tras npm run build):  node dist/backtest/fill-stress.js

import { NestFactory } from '@nestjs/core';
import { BacktestModule } from './backtest.module';
import { CandleRepository } from '../market-data/candle.repository';
import { runBacktest, type RunnerCandle } from './backtest.runner';
import { computeHtfBias, type BiasPoint } from './htf-bias';
import type { SignalConfig } from './signal-source';
import type { SimConfig } from './trade-simulator';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'SOLUSDT', 'BNBUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT', 'AVAXUSDT', 'DOTUSDT'];
const STRICT = [0, 0.05, 0.1, 0.25, 0.5]; // fracción de risk que el precio debe CRUZAR más allá del CE
const LIMIT = 200000;

// Candidato congelado (mismos params que las corridas canónicas).
const signalCfg: Partial<SignalConfig> = {
  gatillo: 'C',
  tpRule: 'fixedR',
  rMultipleTp: 2,
  slBufferFrac: 0.1,
  swingLookback: 10,
  minRr: 1,
  minStopPct: 0.003,
  cancelDistanceFrac: 3,
  poolMode: 'lastSwing',
};
const simBase: Partial<SimConfig> = {
  makerFee: 0.0002,
  takerFee: 0.0005,
  slippagePerSide: 0,
  breakevenAtTpFraction: 0.5,
  maxWaitFillBars: 0,
};

const signed = (n: number): string => (n >= 0 ? '+' : '') + n.toFixed(3);
const pct = (n: number): string => (n * 100).toFixed(1);

async function loadCandles(repo: CandleRepository, symbol: string, tf: string): Promise<RunnerCandle[]> {
  const rows = await repo.findCandles({ symbol, tf, limit: LIMIT });
  return rows
    .filter((r) => r.isClosed)
    .map((r) => ({ openTime: r.openTime, open: r.open, high: r.high, low: r.low, close: r.close, closeTime: r.closeTime }));
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(BacktestModule, { logger: ['error', 'warn'] });
  try {
    const repo = app.get(CandleRepository);
    const data: { symbol: string; c15: RunnerCandle[]; bias: BiasPoint[] }[] = [];
    for (const symbol of SYMBOLS) {
      const c15 = await loadCandles(repo, symbol, '15m');
      const c4h = await loadCandles(repo, symbol, '4h');
      if (c15.length === 0) {
        console.log(`(${symbol}: sin velas 15m, omitido)`);
        continue;
      }
      data.push({ symbol, c15, bias: computeHtfBias(c4h, 10) });
    }

    console.log('\n=== ANÁLISIS DE REALISMO DE FILL — candidato congelado (C · 2R · cancel3 · swing10 · htf4h) ===');
    console.log('fillStrict = el precio debe CRUZAR el CE por X×risk para llenar (0 = toque = candidato actual)\n');
    console.log('strict   N       fill%   expR       WR%     totalR     Δexp vs toque');
    console.log('──────── ─────── ─────── ────────── ─────── ────────── ──────────────');

    const perSymbol: Record<string, string[]> = {};
    for (const s of data) perSymbol[s.symbol] = [];
    let baseExp = 0;
    for (const f of STRICT) {
      let N = 0;
      let totalR = 0;
      let wins = 0;
      let signals = 0;
      for (const s of data) {
        const m = runBacktest(s.symbol, '15m', s.c15, signalCfg, { ...simBase, fillStrictFrac: f }, s.bias).metrics;
        N += m.trades;
        totalR += m.totalR;
        wins += m.wins;
        signals += m.signals;
        perSymbol[s.symbol].push(`${signed(m.expectancyR)}(${m.trades})`);
      }
      const exp = N ? totalR / N : 0;
      if (f === 0) baseExp = exp;
      console.log(
        `${f.toFixed(2).padEnd(8)} ${String(N).padStart(7)} ${pct(signals ? N / signals : 0).padStart(6)}  ${signed(exp).padStart(9)}  ${pct(N ? wins / N : 0).padStart(6)}  ${signed(totalR).padStart(9)}  ${signed(exp - baseExp).padStart(9)}`,
      );
    }

    console.log('\n=== Por símbolo (expectancyR(N) a cada nivel de fillStrict) ===');
    console.log('símbolo   ' + STRICT.map((f) => `s${f}`.padStart(14)).join(''));
    for (const s of data) {
      console.log(s.symbol.replace('USDT', '').padEnd(9) + ' ' + perSymbol[s.symbol].map((x) => x.padStart(14)).join(''));
    }

    console.log('\nLectura:');
    console.log('  · Si la expectancy AGUANTA al subir fillStrict → el edge NO depende de fills de roce (sólido para real).');
    console.log('  · Si CAE fuerte → muchas ganadoras eran límites apenas tocadas que en real podrían no llenar (real < paper).');
    console.log('  · fillStrict 0.1–0.25 ≈ exigir que la mecha cruce 10–25% del riesgo más allá del CE (realista para una límite).');
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error('fill-stress failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
