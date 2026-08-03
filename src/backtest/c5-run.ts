// Ciclo 5 — CLI (docs/CYCLE-5-PREREG.md §2-§3). C5.4. Read-only sobre la DB de velas (Regla Cero:
// NO ejecuta, NO coloca órdenes; solo lee y simula).
//
// Corre el grid PRE-DECLARADO (entrada {A, B} × runner {2R, POI-4H, trailing} = 6 combos) sobre los
// 15 símbolos del universo con TODA la historia 15m local. Parámetros fijos = C5_PARAMS (§2).
//
// Uso (tras `npm run build`):
//   node dist/backtest/c5-run.js --combo A-2R --symbol BTCUSDT
//   node dist/backtest/c5-run.js --combo all
//   node dist/backtest/c5-run.js --combo all --heldout   (calibración = 1ª mitad temporal · held-out = 2ª)
//   node dist/backtest/c5-run.js --combo all --wf        (walk-forward 12 ventanas, como C4)
//
// El benchmark del §3 (candidato congelado v2 sobre el mismo período/universo) se corre con las
// herramientas existentes (c4-calibration / run.ts) — este CLI cubre SOLO el grid C5.

import { NestFactory } from '@nestjs/core';
import { BacktestModule } from './backtest.module';
import { CandleRepository } from '../market-data/candle.repository';
import { C5_PARAMS } from './c5-pool-detector';
import {
  C5_COMBOS,
  buildC5Context,
  runC5Engine,
  type C5Candle,
  type C5Combo,
  type C5RunResult,
  type C5Trade,
} from './c5-engine';

// Universo vigente (§3): 15 símbolos.
const SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'XRPUSDT',
  'SOLUSDT',
  'BNBUSDT',
  'DOGEUSDT',
  'ADAUSDT',
  'LINKUSDT',
  'AVAXUSDT',
  'DOTUSDT',
  'LTCUSDT',
  'BCHUSDT',
  'ATOMUSDT',
  'UNIUSDT',
  'NEARUSDT',
];
const LIMIT = 500_000; // cubre de sobra toda la historia 15m local (~150k velas por símbolo)
const WF_WINDOWS = 12;

const args = process.argv.slice(2);
const getArg = (name: string, def: string): string => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  if (a) return a.split('=').slice(1).join('=');
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < args.length && !args[i + 1].startsWith('--')) return args[i + 1];
  return def;
};
const hasFlag = (n: string): boolean => args.includes(`--${n}`);
const fmt = (ms: number | null): string => (ms == null ? '—' : new Date(ms).toISOString().slice(0, 10));
const pct = (n: number): string => (n * 100).toFixed(1);
const signed = (n: number): string => (n >= 0 ? '+' : '') + n.toFixed(3);

interface C5Stats {
  n: number;
  totalR: number;
  expectancyR: number;
  winRate: number;
  slRate: number;
  maxDrawdownR: number;
  exits: Record<'SL' | 'BE' | 'TP' | 'TRAIL' | 'endOfData', number>;
}

// Métricas del grid (mismas convenciones que metrics.ts: win = R > 0; maxDD sobre la curva de
// equity en R ordenada por tiempo de ENTRADA).
function statsOf(trades: C5Trade[]): C5Stats {
  const n = trades.length;
  const exits: C5Stats['exits'] = { SL: 0, BE: 0, TP: 0, TRAIL: 0, endOfData: 0 };
  let totalR = 0;
  let wins = 0;
  for (const t of trades) {
    totalR += t.rMultiple;
    if (t.rMultiple > 0) wins++;
    exits[t.exitReason]++;
  }
  const ordered = [...trades].sort((a, b) => a.entryTime - b.entryTime);
  let cum = 0;
  let peak = 0;
  let dd = 0;
  for (const t of ordered) {
    cum += t.rMultiple;
    if (cum > peak) peak = cum;
    if (peak - cum > dd) dd = peak - cum;
  }
  return {
    n,
    totalR,
    expectancyR: n ? totalR / n : 0,
    winRate: n ? wins / n : 0,
    slRate: n ? exits.SL / n : 0,
    maxDrawdownR: dd,
    exits,
  };
}

interface SymbolData {
  symbol: string;
  c15: C5Candle[];
  c4h: C5Candle[];
}

function runOne(symbol: string, c15: C5Candle[], c4h: C5Candle[], combo: C5Combo): C5RunResult {
  return runC5Engine(symbol, c15, buildC5Context(c4h), combo);
}

function cancelSummary(results: C5RunResult[]): string {
  const acc: Record<string, number> = {};
  let rejects = 0;
  for (const r of results) {
    for (const cn of r.cancels) acc[cn.reason] = (acc[cn.reason] ?? 0) + 1;
    rejects += r.rejects.length;
  }
  const parts = Object.entries(acc).map(([k, v]) => `${k} ${v}`);
  return `${parts.length ? parts.join(' · ') : '—'}${rejects ? ` | rechazos ${rejects}` : ''}`;
}

// Tabla por símbolo + POOLED de un combo sobre un conjunto de datos (full / calibración / held-out).
function printComboTable(title: string, results: C5RunResult[]): void {
  console.log(`\n=== ${title} ===`);
  console.log('símbolo    velas   pools armados  N     totalR    expR      WR%    SL%    maxDD');
  console.log('────────── ─────── ───── ─────── ───── ───────── ───────── ────── ────── ──────');
  const all: C5Trade[] = [];
  let pools = 0;
  let armed = 0;
  for (const r of results) {
    const m = statsOf(r.trades);
    all.push(...r.trades);
    pools += r.poolsQualified;
    armed += r.armed;
    console.log(
      `${r.symbol.padEnd(10)} ${String(r.candles).padStart(7)} ${String(r.poolsQualified).padStart(5)} ${String(r.armed).padStart(7)} ${String(m.n).padStart(5)} ${signed(m.totalR).padStart(9)} ${(signed(m.expectancyR) + 'R').padStart(9)} ${pct(m.winRate).padStart(6)} ${pct(m.slRate).padStart(6)} ${m.maxDrawdownR.toFixed(2).padStart(6)}`,
    );
  }
  const p = statsOf(all);
  console.log('────────── ─────── ───── ─────── ───── ───────── ───────── ────── ────── ──────');
  console.log(
    `${'POOLED'.padEnd(10)} ${''.padStart(7)} ${String(pools).padStart(5)} ${String(armed).padStart(7)} ${String(p.n).padStart(5)} ${signed(p.totalR).padStart(9)} ${(signed(p.expectancyR) + 'R').padStart(9)} ${pct(p.winRate).padStart(6)} ${pct(p.slRate).padStart(6)} ${p.maxDrawdownR.toFixed(2).padStart(6)}`,
  );
  console.log(
    `salidas pooled: TP ${p.exits.TP} · SL ${p.exits.SL} · BE ${p.exits.BE} · TRAIL ${p.exits.TRAIL} · endOfData ${p.exits.endOfData} | cancelaciones: ${cancelSummary(results)}`,
  );
}

// Walk-forward 12 ventanas (como c4-calibration/walkforward: cortes temporales consecutivos del 15m;
// la estructura 4H se recalcula DENTRO de cada ventana — pierde ~2 días de warmup por corte, sesgo
// pequeño e igual para todas).
function printWalkForward(combo: C5Combo, data: SymbolData[]): void {
  console.log(`\n=== C5 WALK-FORWARD · combo ${combo} · ${WF_WINDOWS} ventanas ===`);
  console.log('símbolo    ventanas-rentables   N     pooledR');
  let wins = 0;
  let tot = 0;
  let allN = 0;
  let allR = 0;
  for (const d of data) {
    const n = d.c15.length;
    const size = Math.floor(n / WF_WINDOWS);
    if (size === 0) continue;
    let symWins = 0;
    let symWithTrades = 0;
    let symN = 0;
    let symR = 0;
    for (let w = 0; w < WF_WINDOWS; w++) {
      const start = w * size;
      const end = w === WF_WINDOWS - 1 ? n : (w + 1) * size;
      const slice = d.c15.slice(start, end);
      if (slice.length === 0) continue;
      const from = slice[0].openTime;
      const to = slice[slice.length - 1].openTime;
      const h4 = d.c4h.filter((x) => x.openTime >= from && x.openTime <= to);
      const res = runOne(d.symbol, slice, h4, combo);
      if (res.trades.length === 0) continue;
      symWithTrades++;
      const totalR = res.trades.reduce((s, t) => s + t.rMultiple, 0);
      if (totalR > 0) symWins++;
      symN += res.trades.length;
      symR += totalR;
    }
    wins += symWins;
    tot += symWithTrades;
    allN += symN;
    allR += symR;
    console.log(
      `${d.symbol.padEnd(10)} ${String(symWins).padStart(2)}/${String(symWithTrades).padEnd(2)} (con trades)   ${String(symN).padStart(4)}  ${signed(symN ? symR / symN : 0)}R`,
    );
  }
  console.log(
    `\nventanas rentables: ${wins}/${tot} (${pct(tot ? wins / tot : 0)}%) · N total ${allN} · pooled ${signed(allN ? allR / allN : 0)}R`,
  );
}

async function main(): Promise<void> {
  const comboArg = getArg('combo', 'all');
  const combos: C5Combo[] =
    comboArg === 'all' ? [...C5_COMBOS] : (C5_COMBOS.filter((c) => c === comboArg) as C5Combo[]);
  if (combos.length === 0) {
    console.error(`Combo desconocido: ${comboArg}. Válidos: ${C5_COMBOS.join(' | ')} | all`);
    process.exit(1);
  }
  const symbolArg = getArg('symbol', '');
  const symbols = symbolArg ? [symbolArg] : SYMBOLS;
  const HELDOUT = hasFlag('heldout');
  const WF = hasFlag('wf');

  const app = await NestFactory.createApplicationContext(BacktestModule, { logger: ['error', 'warn'] });
  try {
    const repo = app.get(CandleRepository);
    const load = async (symbol: string, tf: string): Promise<C5Candle[]> => {
      const rows = await repo.findCandles({ symbol, tf, limit: LIMIT });
      return rows
        .filter((r) => r.isClosed)
        .map((r) => ({ openTime: r.openTime, open: r.open, high: r.high, low: r.low, close: r.close, closeTime: r.closeTime }));
    };

    const pctExact = (n: number): string => String(Math.round(n * 1e6) / 1e4); // sin redondeo engañoso
    console.log(
      `\nC5_PARAMS congelados (§2): ε=${pctExact(C5_PARAMS.epsilonFrac)}% · P=${C5_PARAMS.minSeparationBars} velas · ` +
        `D=${C5_PARAMS.minAgeMs / 86_400_000}d · β=${C5_PARAMS.poiBetaFrac} · buffer=${pctExact(C5_PARAMS.slBufferFrac)}% · ` +
        `T=${C5_PARAMS.maxWaitFillMs / 86_400_000}d · minStop=${pctExact(C5_PARAMS.minStopPct)}% · ` +
        `fees ${C5_PARAMS.makerFee}/${C5_PARAMS.takerFee} · TP1 ${pct(C5_PARAMS.partialFrac)}% @ +${C5_PARAMS.tp1AtR}R → BE`,
    );

    const data: SymbolData[] = [];
    console.log('\nDatos locales (velas cerradas):');
    for (const symbol of symbols) {
      const c15 = await load(symbol, '15m');
      const c4h = await load(symbol, '4h');
      if (c15.length === 0 || c4h.length === 0) {
        console.log(`  ${symbol.padEnd(10)} sin velas 15m/4h — omitido`);
        continue;
      }
      console.log(
        `  ${symbol.padEnd(10)} 15m n=${String(c15.length).padStart(6)} (${fmt(c15[0].openTime)} → ${fmt(c15[c15.length - 1].openTime)}) · 4h n=${String(c4h.length).padStart(5)}`,
      );
      data.push({ symbol, c15, c4h });
    }
    if (data.length === 0) {
      console.log('Sin datos. ¿Backfill pendiente?');
      return;
    }

    for (const combo of combos) {
      if (WF) {
        printWalkForward(combo, data);
        continue;
      }
      if (HELDOUT) {
        // Split pre-registrado estilo C4: calibración = primera mitad TEMPORAL de cada símbolo,
        // held-out = segunda. El corte se fija en el openTime de la vela 15m del medio y se aplica
        // también a las velas 4H (la estructura de cada mitad se computa solo con SUS velas).
        const cal: C5RunResult[] = [];
        const ho: C5RunResult[] = [];
        for (const d of data) {
          const boundary = d.c15[Math.floor(d.c15.length / 2)].openTime;
          const cal15 = d.c15.filter((x) => x.openTime < boundary);
          const ho15 = d.c15.filter((x) => x.openTime >= boundary);
          const cal4h = d.c4h.filter((x) => x.openTime < boundary);
          const ho4h = d.c4h.filter((x) => x.openTime >= boundary);
          if (cal15.length && cal4h.length) cal.push(runOne(d.symbol, cal15, cal4h, combo));
          if (ho15.length && ho4h.length) ho.push(runOne(d.symbol, ho15, ho4h, combo));
        }
        printComboTable(`C5 combo ${combo} · CALIBRACIÓN (1ª mitad temporal)`, cal);
        printComboTable(`C5 combo ${combo} · HELD-OUT (2ª mitad temporal)`, ho);
        continue;
      }
      const results = data.map((d) => runOne(d.symbol, d.c15, d.c4h, combo));
      printComboTable(`C5 combo ${combo} · historia completa`, results);
    }

    console.log(
      '\nLectura: grid §2 congelado; el veredicto se juzga por §4 (piso N≥60 en held-out; reemplazo solo con TODOS los criterios C4 §5; posible COMPLEMENTO). Benchmark = candidato congelado v2 (correr aparte).',
    );
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error('c5-run failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
