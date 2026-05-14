#!/usr/bin/env node
/**
 * Triage aggregator — multi-pair × multi-strategy comparison.
 * Reads triage_*.json files and prints decision matrix.
 *
 * Decision criteria:
 *   PF < 1.3       → ARCHIVE
 *   PF 1.3 - 1.5   → MARGINAL (no archive, no OOS yet)
 *   PF >= 1.5      → PASS to OOS
 */
const fs = require('fs');
const path = require('path');

const outDir = process.argv[2] || __dirname;

const TESTS = [
  { name: 'ETH_baseline',    label: 'ETH 15m PB-OB baseline',    family: 'pullback' },
  { name: 'ETH_filtered',    label: 'ETH 15m PB-OB +filtros',    family: 'pullback' },
  { name: 'XRP_baseline',    label: 'XRP 15m PB-OB baseline',    family: 'pullback' },
  { name: 'XRP_filtered',    label: 'XRP 15m PB-OB +filtros',    family: 'pullback' },
  { name: 'SOL_baseline',    label: 'SOL 15m PB-OB baseline',    family: 'pullback' },
  { name: 'SOL_filtered',    label: 'SOL 15m PB-OB +filtros',    family: 'pullback' },
  { name: 'BTC_SB_15m',      label: 'BTC 15m Session Breakout',  family: 'breakout' },
  { name: 'ETH_SB_15m',      label: 'ETH 15m Session Breakout',  family: 'breakout' },
  { name: 'ETH_MR_5m',       label: 'ETH 5m Mean Reversion',     family: 'mean_rev' },
];

function load(name) {
  const p = path.join(outDir, `triage_${name}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function fmt(pf) {
  if (pf === null || pf === undefined) return 'n/a';
  if (pf === Infinity) return '∞';
  return pf.toFixed(2);
}
function pad(s, n) { return String(s).padEnd(n); }
function padR(s, n) { return String(s).padStart(n); }

function verdict(pf, trades) {
  if (trades < 100) return '⚠️ POCO_N';
  if (pf < 1.3) return '❌ ARCHIVE';
  if (pf < 1.5) return '🟡 MARGINAL';
  return '✅ PASS_OOS';
}

console.log('');
console.log('===============================================================================');
console.log('  TRIAGE MULTI-PAIR × MULTI-STRATEGY — 1Y');
console.log('===============================================================================');
console.log('');
console.log(pad('Test', 28) + padR('Trades', 8) + padR('PF', 8) + padR('WR', 8) +
  padR('TotPnL', 11) + padR('AvgW', 8) + padR('AvgL', 8) + padR('MaxDD', 9) + ' | Verdict');
console.log('-'.repeat(106));

const rows = [];
let totalPnLPortfolio = 0;
let totalTradesPortfolio = 0;

for (const t of TESTS) {
  const data = load(t.name);
  if (!data) {
    console.log(pad(t.label, 28) + padR('PENDIENTE', 60));
    continue;
  }
  const s = data.summary;
  const v = verdict(s.profitFactor, s.totalTrades);
  rows.push({ ...t, data, verdict: v });
  console.log(
    pad(t.label, 28) +
    padR(s.totalTrades, 8) +
    padR(fmt(s.profitFactor), 8) +
    padR(s.winRate.toFixed(1) + '%', 8) +
    padR('$' + s.totalPnlUsd.toFixed(2), 11) +
    padR('$' + s.avgWinUsd.toFixed(2), 8) +
    padR('$' + s.avgLossUsd.toFixed(2), 8) +
    padR('$' + s.maxDrawdownUsd.toFixed(2), 9) +
    ' | ' + v,
  );
  if (v === '✅ PASS_OOS' || v === '🟡 MARGINAL') {
    totalPnLPortfolio += s.totalPnlUsd;
    totalTradesPortfolio += s.totalTrades;
  }
}

console.log('');
console.log('===============================================================================');
console.log('  Trades-per-day analysis');
console.log('===============================================================================');
console.log('');

for (const r of rows) {
  const tradesPerDay = (r.data.summary.totalTrades / 365).toFixed(2);
  console.log(`  ${pad(r.label, 28)} ${padR(tradesPerDay, 8)} trades/día`);
}

console.log('');
console.log('===============================================================================');
console.log('  Portfolio multi-pair scenario (only PASS + MARGINAL)');
console.log('===============================================================================');
console.log('');
console.log(`  Combined trades/year: ${totalTradesPortfolio}`);
console.log(`  Combined trades/day:  ${(totalTradesPortfolio / 365).toFixed(2)}`);
console.log(`  Combined PnL:         $${totalPnLPortfolio.toFixed(2)}`);
console.log('');

console.log('===============================================================================');
console.log('  Recommendations per candidate');
console.log('===============================================================================');
console.log('');

const passed = rows.filter((r) => r.verdict === '✅ PASS_OOS');
const marginal = rows.filter((r) => r.verdict === '🟡 MARGINAL');
const archived = rows.filter((r) => r.verdict === '❌ ARCHIVE');

if (passed.length > 0) {
  console.log('  ✅ PASS_OOS (deploy gradual after OOS validation):');
  for (const r of passed) {
    const trades = r.data.summary.totalTrades;
    const pf = r.data.summary.profitFactor;
    console.log(`     - ${r.label}: PF ${fmt(pf)}, ${trades} trades (${(trades/365).toFixed(1)}/día)`);
  }
}
if (marginal.length > 0) {
  console.log('');
  console.log('  🟡 MARGINAL (could be improved with filters, but not yet ready for OOS):');
  for (const r of marginal) {
    const pf = r.data.summary.profitFactor;
    console.log(`     - ${r.label}: PF ${fmt(pf)} — try adding filters before discarding`);
  }
}
if (archived.length > 0) {
  console.log('');
  console.log('  ❌ ARCHIVE (no edge, do not iterate parameters without structural change):');
  for (const r of archived) {
    const pf = r.data.summary.profitFactor;
    console.log(`     - ${r.label}: PF ${fmt(pf)}`);
  }
}

console.log('');
