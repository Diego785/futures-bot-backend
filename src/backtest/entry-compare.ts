// Compara la ENTRADA del candidato (gatillo C) en 3 modos para ver cuál tiene edge REAL y robusto:
//   1. CE-límite (toque)     = el candidato congelado (frágil: depende de fills de roce).
//   2. CE-límite (cross 10%) = la límite solo llena si el precio CRUZA el CE 10% del riesgo (real pesimista).
//   3. CONFIRMACIÓN (mercado)= entrada a MERCADO en el reclaim (fill GARANTIZADO, paga taker). Robusta a fill.
// Si la confirmación tiene edge positivo → es la candidata robusta para real. Read-only (Regla Cero).
//   node dist/backtest/entry-compare.js

import { NestFactory } from '@nestjs/core';
import { BacktestModule } from './backtest.module';
import { CandleRepository } from '../market-data/candle.repository';
import { runBacktest, type RunnerCandle } from './backtest.runner';
import { computeHtfBias, type BiasPoint } from './htf-bias';
import type { SignalConfig } from './signal-source';
import type { SimConfig } from './trade-simulator';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'SOLUSDT', 'BNBUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT', 'AVAXUSDT', 'DOTUSDT'];
const LIMIT = 200000;

const signalBase: Partial<SignalConfig> = {
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

const variants: { name: string; signal: Partial<SignalConfig>; sim: Partial<SimConfig> }[] = [
  { name: 'CE-límite (toque)', signal: { ...signalBase, entryMode: 'ce' }, sim: { ...simBase } },
  { name: 'CE-límite (cross 10%)', signal: { ...signalBase, entryMode: 'ce' }, sim: { ...simBase, fillStrictFrac: 0.1 } },
  { name: 'CONFIRMACIÓN (mercado)', signal: { ...signalBase, entryMode: 'confirm' }, sim: { ...simBase, entryAtMarket: true } },
];

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
      if (c15.length === 0) continue;
      data.push({ symbol, c15, bias: computeHtfBias(c4h, 10) });
    }

    console.log('\n=== ENTRADA: CE-límite vs CONFIRMACIÓN a mercado (gatillo C · 2R · cancel3 · swing10 · htf4h) ===\n');
    console.log('variante                  N       fill%   expR       WR%     PF      totalR');
    console.log('───────────────────────── ─────── ─────── ────────── ─────── ─────── ──────────');

    const perSymbol: Record<string, string[]> = {};
    for (const s of data) perSymbol[s.symbol] = [];
    for (const v of variants) {
      let N = 0;
      let totalR = 0;
      let wins = 0;
      let sumWin = 0;
      let sumLoss = 0;
      let signals = 0;
      for (const s of data) {
        const m = runBacktest(s.symbol, '15m', s.c15, v.signal, v.sim, s.bias).metrics;
        N += m.trades;
        totalR += m.totalR;
        wins += m.wins;
        sumWin += m.avgWinR * m.wins;
        sumLoss += m.avgLossR * m.losses;
        signals += m.signals;
        perSymbol[s.symbol].push(`${signed(m.expectancyR)}(${m.trades})`);
      }
      const exp = N ? totalR / N : 0;
      const pf = sumLoss < 0 ? sumWin / Math.abs(sumLoss) : sumWin > 0 ? Infinity : 0;
      console.log(
        `${v.name.padEnd(25)} ${String(N).padStart(7)} ${pct(signals ? N / signals : 0).padStart(6)}  ${signed(exp).padStart(9)}  ${pct(N ? wins / N : 0).padStart(6)}  ${(pf === Infinity ? 'inf' : pf.toFixed(2)).padStart(6)}  ${signed(totalR).padStart(9)}`,
      );
    }

    console.log('\n=== Por símbolo (expectancyR(N): CE-toque | CE-cross10% | CONFIRMACIÓN) ===');
    for (const s of data) {
      console.log(s.symbol.replace('USDT', '').padEnd(7) + '  ' + perSymbol[s.symbol].map((x) => x.padStart(16)).join(''));
    }

    console.log('\nLectura: la CONFIRMACIÓN tiene fill GARANTIZADO (inmune al estrés de fill). Si su expectancy');
    console.log('es positiva y comparable, es la entrada ROBUSTA para real. Si es ~0/negativa, el peor precio');
    console.log('de entrar a mercado se come el edge → la estrategia no funciona con una entrada robusta.');
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error('entry-compare failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
