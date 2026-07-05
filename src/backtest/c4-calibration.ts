// Ciclo 4 — CALIBRACIÓN (CYCLE-4-PREREG §4.1): benchmark (candidato congelado) + 5 variantes del
// motor de salida parcial+runner, 10 símbolos, ventana de calibración 2022-01 → 2025-06. Elige la
// variante SOLO con estos datos; el veredicto §5 se juzga después en held-out (2025-06 → hoy).
// Read-only (Regla Cero). Uso:  node dist/backtest/c4-calibration.js [--heldout]
//   --heldout = corre la MISMA tabla sobre la ventana held-out (usar UNA vez, tras elegir variante).

import { NestFactory } from '@nestjs/core';
import { BacktestModule } from './backtest.module';
import { CandleRepository } from '../market-data/candle.repository';
import { generateIntentsDetailed, type SignalConfig } from './signal-source';
import { simulateAll, type SimCandle, type SimConfig, type TradeIntent } from './trade-simulator';
import { computeMetrics } from './metrics';
import { computeHtfBias, type BiasPoint } from './htf-bias';
import { walkForward } from './walkforward';
import type { RunnerCandle } from './backtest.runner';

const SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'XRPUSDT', 'SOLUSDT', 'BNBUSDT', 'DOGEUSDT', 'ADAUSDT', 'LINKUSDT', 'AVAXUSDT', 'DOTUSDT'];
const LIMIT = 200_000;
const CAL_END = Date.UTC(2025, 5, 1); // 2025-06-01 (exclusivo) — mismo split que C2
const HELDOUT = process.argv.includes('--heldout');
const WF = process.argv.includes('--wf'); // §5.6: walk-forward 12 ventanas 2022-2026 (historia completa)

// Candidato congelado (señal) + runner-pool para las variantes C4 (N idéntico — test de invarianza).
const SIGNAL: Partial<SignalConfig> = {
  gatillo: 'C',
  tpRule: 'fixedR',
  rMultipleTp: 2,
  slBufferFrac: 0.1,
  swingLookback: 10,
  minRr: 1,
  minStopPct: 0.003,
  cancelDistanceFrac: 3,
  poolMode: 'lastSwing',
  runnerTpLiquidity: true,
};
const SIM_BASE: Partial<SimConfig> = {
  makerFee: 0.0002,
  takerFee: 0.0005,
  slippagePerSide: 0,
  breakevenAtTpFraction: 0.5,
  maxWaitFillBars: 0,
};

interface Variant {
  name: string;
  sim: Partial<SimConfig>;
  stripPool?: boolean; // V5: el runner ignora el pool (TP2 = 2R nominal)
}
const ALL_VARIANTS: Variant[] = [
  { name: 'BENCH 2R+BE (congelado)', sim: { ...SIM_BASE } },
  { name: 'V1 tp1@1R frac30% pool', sim: { ...SIM_BASE, exitMode: 'partial-runner', tp1AtR: 1, partialFrac: 0.3 } },
  { name: 'V2 tp1@1R frac50% pool', sim: { ...SIM_BASE, exitMode: 'partial-runner', tp1AtR: 1, partialFrac: 0.5 } },
  { name: 'V3 tp1@.5R frac30% pool', sim: { ...SIM_BASE, exitMode: 'partial-runner', tp1AtR: 0.5, partialFrac: 0.3 } },
  { name: 'V4 tp1@.5R frac50% pool', sim: { ...SIM_BASE, exitMode: 'partial-runner', tp1AtR: 0.5, partialFrac: 0.5 } },
  { name: 'V5 tp1@1R frac50% TP2=2R', sim: { ...SIM_BASE, exitMode: 'partial-runner', tp1AtR: 1, partialFrac: 0.5 }, stripPool: true },
];
// HELD-OUT (§4.2): SOLO la variante elegida en calibración (V5, 2026-07-04) contra el benchmark —
// "la combinación elegida se corre UNA vez"; las demás NO se miran fuera de calibración.
const VARIANTS: Variant[] = HELDOUT ? [ALL_VARIANTS[0], ALL_VARIANTS[5]] : ALL_VARIANTS;

const signed = (n: number): string => (n >= 0 ? '+' : '') + n.toFixed(3);
const pct = (n: number): string => (n * 100).toFixed(1);

async function loadCandles(repo: CandleRepository, symbol: string, tf: string): Promise<RunnerCandle[]> {
  const rows = await repo.findCandles({ symbol, tf, limit: LIMIT });
  return rows
    .filter((r) => r.isClosed)
    .filter((r) => WF || (HELDOUT ? r.openTime >= CAL_END : r.openTime < CAL_END))
    .map((r) => ({ openTime: r.openTime, open: r.open, high: r.high, low: r.low, close: r.close, closeTime: r.closeTime }));
}

async function main(): Promise<void> {
  const app = await NestFactory.createApplicationContext(BacktestModule, { logger: ['error', 'warn'] });
  try {
    const repo = app.get(CandleRepository);

    // §5.6 — Walk-forward 12 ventanas sobre la historia COMPLETA: BENCH vs V5 (la señal de V5 es la
    // del congelado — su runner cae al TP nominal — así que la generación por ventana es idéntica).
    if (WF) {
      console.log('\n=== C4 WALK-FORWARD (12 ventanas · 2022-2026 · 10 símbolos) — BENCH vs V5 ===');
      const simV5: Partial<SimConfig> = { ...SIM_BASE, exitMode: 'partial-runner', tp1AtR: 1, partialFrac: 0.5 };
      const sigFrozen: Partial<SignalConfig> = { ...SIGNAL, runnerTpLiquidity: undefined };
      let bWins = 0;
      let bTot = 0;
      let vWins = 0;
      let vTot = 0;
      console.log('símbolo    BENCH rentables    V5 rentables     pooledR B → V5');
      for (const symbol of SYMBOLS) {
        const c15 = await loadCandles(repo, symbol, '15m');
        const c4h = await loadCandles(repo, symbol, '4h');
        if (c15.length === 0) continue;
        const bias = computeHtfBias(c4h, 10);
        const wfB = walkForward(symbol, '15m', c15, 12, sigFrozen, SIM_BASE, bias);
        const wfV = walkForward(symbol, '15m', c15, 12, sigFrozen, simV5, bias);
        bWins += wfB.profitableWindows;
        bTot += wfB.windowsCount;
        vWins += wfV.profitableWindows;
        vTot += wfV.windowsCount;
        console.log(
          `${symbol.padEnd(10)} ${String(wfB.profitableWindows).padStart(2)}/${String(wfB.windowsCount).padEnd(6)}         ${String(wfV.profitableWindows).padStart(2)}/${String(wfV.windowsCount).padEnd(6)}       ${signed(wfB.pooledExpectancyR)} → ${signed(wfV.pooledExpectancyR)}`,
        );
      }
      const bp = bTot ? bWins / bTot : 0;
      const vp = vTot ? vWins / vTot : 0;
      console.log(`\nventanas rentables: BENCH ${bWins}/${bTot} (${pct(bp)}%) · V5 ${vWins}/${vTot} (${pct(vp)}%)`);
      console.log(`criterio §5.6 (V5 ≥ BENCH − 10 pp): ${vp >= bp - 0.10 ? 'CUMPLE ✓' : 'NO CUMPLE ✗'}`);
      return;
    }

    console.log(`\n=== C4 ${HELDOUT ? 'HELD-OUT (2025-06 → hoy)' : 'CALIBRACIÓN (2022-01 → 2025-06)'} · gatillo C · htf 4h · 10 símbolos ===`);

    // Genera intents UNA vez por símbolo (idénticos para todas las variantes — N invariante).
    const bySymbol: { symbol: string; intents: TradeIntent[]; sim: SimCandle[]; signals: number }[] = [];
    for (const symbol of SYMBOLS) {
      const c15 = await loadCandles(repo, symbol, '15m');
      const c4h = await loadCandles(repo, symbol, '4h');
      if (c15.length === 0) {
        console.log(`(${symbol}: sin velas 15m en la ventana — omitido)`);
        continue;
      }
      const bias: BiasPoint[] = computeHtfBias(c4h, 10);
      const { intents } = generateIntentsDetailed(symbol, '15m', c15, SIGNAL, bias);
      bySymbol.push({
        symbol,
        intents,
        sim: c15.map((c) => ({ openTime: c.openTime, high: c.high, low: c.low, close: c.close, closeTime: c.closeTime })),
        signals: intents.length,
      });
      const withPool = intents.filter((i) => i.runnerTakeProfit != null).length;
      console.log(`  ${symbol.padEnd(9)} velas=${String(c15.length).padStart(6)} señales=${String(intents.length).padStart(4)} · runner-pool ${pct(intents.length ? withPool / intents.length : 0)}% (resto fallback 2R)`);
    }

    console.log('\nvariante                       N     expR      WR%    PF     totalR    SL%   BE%   TP%   tp1Hit%');
    console.log('────────────────────────────── ───── ───────── ────── ────── ───────── ───── ───── ───── ───────');
    const perSymbol: Record<string, string[]> = {};
    for (const s of bySymbol) perSymbol[s.symbol] = [];

    for (const v of VARIANTS) {
      let N = 0;
      let totalR = 0;
      let wins = 0;
      let sumWin = 0;
      let sumLoss = 0;
      let sl = 0;
      let be = 0;
      let tp = 0;
      let tp1 = 0;
      for (const s of bySymbol) {
        const intents = v.stripPool ? s.intents.map((i) => ({ ...i, runnerTakeProfit: undefined })) : s.intents;
        const results = simulateAll(intents, s.sim, v.sim);
        const m = computeMetrics(results);
        N += m.trades;
        totalR += m.totalR;
        wins += m.wins;
        sumWin += m.avgWinR * m.wins;
        sumLoss += m.avgLossR * m.losses;
        sl += m.exitReasons.SL;
        be += m.exitReasons.BE;
        tp += m.exitReasons.TP;
        for (const r of results) if (r.trade?.tp1Filled) tp1++;
        // Held-out (§5.3/§5.4): la matriz lleva también el maxDD por símbolo.
        perSymbol[s.symbol].push(
          HELDOUT ? `${signed(m.expectancyR)}(${m.trades})dd${m.maxDrawdownR.toFixed(1)}` : `${signed(m.expectancyR)}(${m.trades})`,
        );
      }
      const exp = N ? totalR / N : 0;
      const pf = sumLoss < 0 ? sumWin / Math.abs(sumLoss) : sumWin > 0 ? Infinity : 0;
      console.log(
        `${v.name.padEnd(30)} ${String(N).padStart(5)} ${signed(exp).padStart(8)}R ${pct(N ? wins / N : 0).padStart(5)}  ${(pf === Infinity ? 'inf' : pf.toFixed(2)).padStart(5)}  ${signed(totalR).padStart(8)}  ${pct(N ? sl / N : 0).padStart(4)}  ${pct(N ? be / N : 0).padStart(4)}  ${pct(N ? tp / N : 0).padStart(4)}  ${pct(N ? tp1 / N : 0).padStart(5)}`,
      );
    }

    console.log('\n=== Por símbolo — expectancyR(N): BENCH | V1 | V2 | V3 | V4 | V5 ===');
    for (const s of bySymbol) {
      console.log(s.symbol.replace('USDT', '').padEnd(6) + perSymbol[s.symbol].map((x) => x.padStart(14)).join(''));
    }
    console.log(
      `\nLectura: la variante C4 se elige SOLO acá (${HELDOUT ? 'NO — esta es la corrida held-out del veredicto §5' : 'calibración'}); el reemplazo del candidato se juzga en held-out según CYCLE-4-PREREG §5.`,
    );
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error('c4-calibration failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
