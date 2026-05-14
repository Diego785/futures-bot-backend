#!/usr/bin/env node
/**
 * Phase 2 batch aggregator.
 * Reads all variant JSON outputs, prints comparative table.
 * Usage: node aggregate.js [outDir=.]
 */
const fs = require('fs');
const path = require('path');

const outDir = process.argv[2] || __dirname;

const VARIANTS = [
  { name: 'baseline', label: 'Baseline (current prod config)', file: 'baseline.json' },
  { name: 'atr020', label: 'ATR-min 0.20%', file: 'atr020.json' },
  { name: 'noASIA', label: 'Block ASIA', file: 'noASIA.json' },
  { name: 'noCONSOL', label: 'Block CONSOLIDATION', file: 'noCONSOL.json' },
  { name: 'atr020_noASIA', label: 'ATR 0.20% + no ASIA', file: 'atr020_noASIA.json' },
  { name: 'atr020_noCONSOL', label: 'ATR 0.20% + no CONSOL', file: 'atr020_noCONSOL.json' },
  { name: 'noASIA_noCONSOL', label: 'no ASIA + no CONSOL', file: 'noASIA_noCONSOL.json' },
  { name: 'atr020_noASIA_noCONSOL', label: 'ATR 0.20% + no ASIA + no CONSOL', file: 'atr020_noASIA_noCONSOL.json' },
];

function loadVariant(file) {
  const p = path.join(outDir, file);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function exitBreakdown(trades) {
  const counts = { TP: 0, SL: 0, TRAILING_SL: 0, END_OF_DATA: 0 };
  for (const t of trades) counts[t.exitReason] = (counts[t.exitReason] || 0) + 1;
  return counts;
}

function pad(s, n) { return String(s).padEnd(n); }
function padR(s, n) { return String(s).padStart(n); }
function fmtPF(pf) { return pf === null || pf === undefined ? 'n/a' : (pf === Infinity ? '∞' : pf.toFixed(2)); }
function fmtPct(p) { return p === null || p === undefined ? 'n/a' : p.toFixed(1) + '%'; }

console.log('');
console.log('===============================================================================');
console.log('  PHASE 2 BATCH COMPARATIVE — 1Y BTCUSDT 15m Pullback-OB');
console.log('===============================================================================');
console.log('');

// Header
console.log(pad('Variant', 32) + padR('Trades', 8) + padR('PF', 8) + padR('WR', 8) +
  padR('TotPnL', 10) + padR('AvgW', 8) + padR('AvgL', 8) + padR('MaxDD', 9));
console.log('-'.repeat(91));

const baseline = loadVariant('baseline.json');
if (!baseline) {
  console.error('ERROR: baseline.json missing. Run baseline first.');
  process.exit(1);
}

const rows = [];
for (const v of VARIANTS) {
  const data = loadVariant(v.file);
  if (!data) {
    console.log(pad(v.label, 32) + padR('—', 8) + padR('PENDIENTE', 60));
    continue;
  }
  const s = data.summary;
  rows.push({ ...v, data });
  console.log(
    pad(v.label.slice(0, 31), 32) +
    padR(s.totalTrades, 8) +
    padR(fmtPF(s.profitFactor), 8) +
    padR(s.winRate.toFixed(1) + '%', 8) +
    padR('$' + s.totalPnlUsd.toFixed(2), 10) +
    padR('$' + s.avgWinUsd.toFixed(2), 8) +
    padR('$' + s.avgLossUsd.toFixed(2), 8) +
    padR('$' + s.maxDrawdownUsd.toFixed(2), 9),
  );
}

console.log('');
console.log('===============================================================================');
console.log('  MFE/MAE Distribution — winners vs losers');
console.log('===============================================================================');
console.log('');
console.log(pad('Variant', 32) + padR('%≥0.5R', 9) + padR('%≥1R', 8) +
  padR('%≥1Rfee', 10) + padR('MfeRW', 8) + padR('MfeRL', 8) + padR('MaeRW', 8) + padR('MaeRL', 8));
console.log('-'.repeat(91));

for (const r of rows) {
  const m = r.data.mfeMaeStats;
  console.log(
    pad(r.label.slice(0, 31), 32) +
    padR(fmtPct(m.pctTouched0_5R), 9) +
    padR(fmtPct(m.pctTouched1R), 8) +
    padR(fmtPct(m.pctTouched1RAfterFees), 10) +
    padR(m.meanMfeR_winners.toFixed(2), 8) +
    padR(m.meanMfeR_losers.toFixed(2), 8) +
    padR(m.meanMaeR_winners.toFixed(2), 8) +
    padR(m.meanMaeR_losers.toFixed(2), 8),
  );
}

console.log('');
console.log('===============================================================================');
console.log('  Exit Reason Breakdown');
console.log('===============================================================================');
console.log('');
console.log(pad('Variant', 32) + padR('TRAIL', 8) + padR('SL', 8) + padR('TP', 8) + padR('EOD', 8));
console.log('-'.repeat(64));

for (const r of rows) {
  const exits = exitBreakdown(r.data.trades);
  const total = r.data.trades.length;
  console.log(
    pad(r.label.slice(0, 31), 32) +
    padR(`${exits.TRAILING_SL || 0} (${total > 0 ? ((exits.TRAILING_SL || 0) / total * 100).toFixed(0) : 0}%)`, 8) +
    padR(`${exits.SL || 0}`, 8) +
    padR(`${exits.TP || 0}`, 8) +
    padR(`${exits.END_OF_DATA || 0}`, 8),
  );
}

console.log('');
console.log('===============================================================================');
console.log('  Δ vs Baseline');
console.log('===============================================================================');
console.log('');
const bs = baseline.summary;
console.log(pad('Variant', 32) + padR('Δ Trades', 11) + padR('Δ PF', 10) +
  padR('Δ WR', 10) + padR('Δ PnL', 11) + padR('Δ DD', 10));
console.log('-'.repeat(84));

for (const r of rows) {
  if (r.name === 'baseline') continue;
  const s = r.data.summary;
  const dPF = s.profitFactor === Infinity || bs.profitFactor === Infinity
    ? '∞'
    : ((s.profitFactor - bs.profitFactor) / bs.profitFactor * 100).toFixed(0) + '%';
  const dTrades = ((s.totalTrades - bs.totalTrades) / bs.totalTrades * 100).toFixed(0) + '%';
  const dWR = (s.winRate - bs.winRate).toFixed(1) + 'pp';
  const dPnl = ((s.totalPnlUsd - bs.totalPnlUsd) / bs.totalPnlUsd * 100).toFixed(0) + '%';
  const dDD = ((s.maxDrawdownUsd - bs.maxDrawdownUsd) / bs.maxDrawdownUsd * 100).toFixed(0) + '%';
  console.log(
    pad(r.label.slice(0, 31), 32) +
    padR(dTrades, 11) +
    padR(dPF, 10) +
    padR(dWR, 10) +
    padR(dPnl, 11) +
    padR(dDD, 10),
  );
}

console.log('');
console.log('===============================================================================');
console.log('  Decision matrix (winners — variants that strictly improve)');
console.log('===============================================================================');
console.log('');

const winners = rows.filter((r) => {
  if (r.name === 'baseline') return false;
  const s = r.data.summary;
  return s.profitFactor >= bs.profitFactor && s.totalPnlUsd >= bs.totalPnlUsd * 0.7; // PF strict mejor, PnL no se cae más de 30%
});

console.log('Strict criterion: PF >= baseline AND PnL >= baseline*0.70');
console.log('');
if (winners.length === 0) {
  console.log('  No strict winners. Best variant by PF:');
  const sorted = [...rows].filter((r) => r.name !== 'baseline').sort((a, b) =>
    (b.data.summary.profitFactor === Infinity ? 1 : b.data.summary.profitFactor) -
    (a.data.summary.profitFactor === Infinity ? 1 : a.data.summary.profitFactor),
  );
  for (let i = 0; i < Math.min(3, sorted.length); i++) {
    const r = sorted[i];
    console.log(`  ${i + 1}. ${r.label} — PF ${fmtPF(r.data.summary.profitFactor)}, PnL $${r.data.summary.totalPnlUsd.toFixed(2)}`);
  }
} else {
  for (const r of winners) {
    console.log(`  ✓ ${r.label}`);
    console.log(`      PF ${fmtPF(r.data.summary.profitFactor)} (vs baseline ${fmtPF(bs.profitFactor)})`);
    console.log(`      PnL $${r.data.summary.totalPnlUsd.toFixed(2)} (vs baseline $${bs.totalPnlUsd.toFixed(2)})`);
    console.log(`      Trades ${r.data.summary.totalTrades} (vs baseline ${bs.totalTrades})`);
  }
}

console.log('');
