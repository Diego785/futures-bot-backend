#!/usr/bin/env node
/**
 * BE Economic A/B aggregator.
 * Compares legacy BE buffer (0.05%) vs economic BE buffer (fees + safety).
 */
const fs = require('fs');
const path = require('path');

const outDir = process.argv[2] || __dirname;

const PAIRS = [
  { name: 'BTC', label: 'BTC filtered (ASIA+CONSOL)' },
  { name: 'SOL', label: 'SOL baseline' },
  { name: 'ETH', label: 'ETH baseline' },
  { name: 'XRP', label: 'XRP baseline' },
];

function load(pair, variant) {
  const p = path.join(outDir, `be_${pair}_${variant}.json`);
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

console.log('');
console.log('===============================================================================');
console.log('  BE ECONÓMICO — A/B comparison (legacy vs economic buffer)');
console.log('  Legacy buffer:    entry × 0.05%');
console.log('  Economic buffer:  entry × (2×commissionRate + 0.02% safety) ≈ 0.12%');
console.log('===============================================================================');
console.log('');

let aggLegacyPnl = 0, aggEconomicPnl = 0;
let aggLegacyTrades = 0, aggEconomicTrades = 0;

for (const p of PAIRS) {
  const legacy = load(p.name, 'legacy');
  const economic = load(p.name, 'economic');
  if (!legacy || !economic) {
    console.log(`${pad(p.label, 30)} — falta data (${legacy?'OK':'MISS'} legacy / ${economic?'OK':'MISS'} economic)`);
    continue;
  }
  const sl = legacy.summary, se = economic.summary;
  aggLegacyPnl += sl.totalPnlUsd; aggEconomicPnl += se.totalPnlUsd;
  aggLegacyTrades += sl.totalTrades; aggEconomicTrades += se.totalTrades;

  console.log(`┌─ ${p.label}`);
  console.log(`│  Metric          ${padR('LEGACY', 14)} ${padR('ECONOMIC', 14)} ${padR('Δ', 12)}`);
  console.log(`│  Trades          ${padR(sl.totalTrades, 14)} ${padR(se.totalTrades, 14)} ${padR(se.totalTrades - sl.totalTrades, 12)}`);
  console.log(`│  WR              ${padR(sl.winRate.toFixed(1)+'%', 14)} ${padR(se.winRate.toFixed(1)+'%', 14)} ${padR((se.winRate - sl.winRate).toFixed(1)+'pp', 12)}`);
  console.log(`│  PF              ${padR(fmt(sl.profitFactor), 14)} ${padR(fmt(se.profitFactor), 14)} ${padR(((se.profitFactor - sl.profitFactor)/sl.profitFactor*100).toFixed(0)+'%', 12)}`);
  console.log(`│  TotPnL          ${padR('$'+sl.totalPnlUsd.toFixed(2), 14)} ${padR('$'+se.totalPnlUsd.toFixed(2), 14)} ${padR('$'+(se.totalPnlUsd - sl.totalPnlUsd).toFixed(2), 12)}`);
  console.log(`│  AvgWin          ${padR('$'+sl.avgWinUsd.toFixed(2), 14)} ${padR('$'+se.avgWinUsd.toFixed(2), 14)} ${padR('$'+(se.avgWinUsd - sl.avgWinUsd).toFixed(2), 12)}`);
  console.log(`│  AvgLoss         ${padR('$'+sl.avgLossUsd.toFixed(2), 14)} ${padR('$'+se.avgLossUsd.toFixed(2), 14)} ${padR('$'+(se.avgLossUsd - sl.avgLossUsd).toFixed(2), 12)}`);
  console.log(`│  MaxDD           ${padR('$'+sl.maxDrawdownUsd.toFixed(2), 14)} ${padR('$'+se.maxDrawdownUsd.toFixed(2), 14)} ${padR('$'+(se.maxDrawdownUsd - sl.maxDrawdownUsd).toFixed(2), 12)}`);
  console.log(`└─`);
  console.log('');
}

console.log('===============================================================================');
console.log('  PORTFOLIO TOTAL — 4 pairs combined');
console.log('===============================================================================');
console.log('');
console.log(`  Legacy   PnL: $${aggLegacyPnl.toFixed(2)}    (${aggLegacyTrades} trades)`);
console.log(`  Economic PnL: $${aggEconomicPnl.toFixed(2)}    (${aggEconomicTrades} trades)`);
console.log(`  Δ:            $${(aggEconomicPnl - aggLegacyPnl).toFixed(2)}    (${(aggEconomicPnl > aggLegacyPnl ? '+' : '')}${(((aggEconomicPnl - aggLegacyPnl)/Math.abs(aggLegacyPnl))*100).toFixed(1)}%)`);
console.log('');

if (aggEconomicPnl > aggLegacyPnl) {
  console.log('  ✅ BE económico mejora el PnL portfolio. Recomendado para deploy.');
} else {
  console.log('  ❌ BE económico NO mejora portfolio. Revisar parámetros.');
}
console.log('');
