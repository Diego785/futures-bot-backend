#!/usr/bin/env node
/**
 * OOS Portfolio aggregator — multi-pair × multi-window with monthly correlation analysis.
 *
 * Decision rules:
 *   PF >= 1.3 in 2/3 windows  → VIVO (alive)
 *   PF >= 1.5 in 2/3 windows  → FUERTE (strong)
 *   PF <  1.3 in 2/3 windows  → ARCHIVE
 *
 * Plus monthly PnL breakdown per pair to assess portfolio diversification.
 */
const fs = require('fs');
const path = require('path');

const outDir = process.argv[2] || __dirname;

const WINDOWS = [
  { id: 'W1', label: '2021-06 → 2022-06 (Bear inicial)' },
  { id: 'W2', label: '2022-06 → 2023-06 (Bear deep + accum)' },
  { id: 'W3', label: '2023-06 → 2024-06 (Recovery + bull)' },
];

const VARIANTS = [
  { name: 'BTC_filtered', label: 'BTC filtered' },
  { name: 'ETH_baseline', label: 'ETH baseline' },
  { name: 'XRP_baseline', label: 'XRP baseline' },
  { name: 'SOL_baseline', label: 'SOL baseline' },
];

function load(window, variant) {
  const p = path.join(outDir, `oos_pf_${window}_${variant}.json`);
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
console.log('  OOS PORTFOLIO VALIDATION — 4 candidates × 3 windows');
console.log('===============================================================================');
console.log('');

// Per-window comparison
const results = {};
for (const w of WINDOWS) {
  results[w.id] = {};
  console.log(`┌────────────────────────────────────────────────────────────────────────────┐`);
  console.log(`│ ${w.id} — ${w.label}`.padEnd(77) + '│');
  console.log(`└────────────────────────────────────────────────────────────────────────────┘`);
  console.log(pad('Variant', 20) + padR('Trades', 8) + padR('PF', 8) + padR('WR', 8) +
    padR('TotPnL', 11) + padR('AvgW', 8) + padR('AvgL', 8) + padR('MaxDD', 9));
  console.log('-'.repeat(86));

  for (const v of VARIANTS) {
    const data = load(w.id, v.name);
    if (!data) {
      console.log(pad(v.label, 20) + padR('PENDIENTE', 60));
      continue;
    }
    results[w.id][v.name] = data;
    const s = data.summary;
    console.log(
      pad(v.label, 20) +
      padR(s.totalTrades, 8) +
      padR(fmt(s.profitFactor), 8) +
      padR(s.winRate.toFixed(1) + '%', 8) +
      padR('$' + s.totalPnlUsd.toFixed(2), 11) +
      padR('$' + s.avgWinUsd.toFixed(2), 8) +
      padR('$' + s.avgLossUsd.toFixed(2), 8) +
      padR('$' + s.maxDrawdownUsd.toFixed(2), 9),
    );
  }
  console.log('');
}

// Robustness analysis
console.log('===============================================================================');
console.log('  ROBUSTNESS — variantes que sobreviven en N de 3 ventanas');
console.log('===============================================================================');
console.log('');
console.log(pad('Variant', 20) + padR('W1 PF', 9) + padR('W2 PF', 9) + padR('W3 PF', 9) +
  padR('≥1.3', 8) + padR('≥1.5', 8) + ' Verdict');
console.log('-'.repeat(86));

const verdicts = {};
for (const v of VARIANTS) {
  const pfs = WINDOWS.map((w) => results[w.id][v.name]?.summary?.profitFactor);
  const valid = pfs.filter((p) => p !== undefined && p !== null);
  if (valid.length < WINDOWS.length) {
    console.log(pad(v.label, 20) + 'data incompleta');
    continue;
  }
  const win13 = pfs.filter((p) => p !== Infinity && p >= 1.3).length + pfs.filter((p) => p === Infinity).length;
  const win15 = pfs.filter((p) => p !== Infinity && p >= 1.5).length + pfs.filter((p) => p === Infinity).length;

  let verdict;
  if (win13 >= 2 && win15 >= 2) verdict = '✅ FUERTE';
  else if (win13 >= 2) verdict = '🟢 VIVO';
  else verdict = '❌ ARCHIVE';

  verdicts[v.name] = { win13, win15, verdict, pfs };
  console.log(
    pad(v.label, 20) +
    padR(fmt(pfs[0]), 9) +
    padR(fmt(pfs[1]), 9) +
    padR(fmt(pfs[2]), 9) +
    padR(`${win13}/3`, 8) +
    padR(`${win15}/3`, 8) +
    ' ' + verdict,
  );
}

// Monthly correlation analysis (only for surviving variants)
console.log('');
console.log('===============================================================================');
console.log('  MONTHLY PnL CORRELATION — ¿se diversifica o caen juntos?');
console.log('===============================================================================');
console.log('');

const survivors = VARIANTS.filter((v) => verdicts[v.name] && verdicts[v.name].verdict !== '❌ ARCHIVE');
if (survivors.length === 0) {
  console.log('  No survivors. No correlation analysis needed.');
} else {
  // For each surviving variant, build monthly PnL across all 3 windows combined
  const monthlyByVariant = {};
  const allMonthsSet = new Set();

  for (const v of survivors) {
    monthlyByVariant[v.name] = {};
    for (const w of WINDOWS) {
      const data = results[w.id][v.name];
      if (!data) continue;
      for (const t of data.trades) {
        const d = new Date(t.exitTime);
        const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        allMonthsSet.add(key);
        monthlyByVariant[v.name][key] = (monthlyByVariant[v.name][key] || 0) + t.pnlUsd;
      }
    }
  }

  const allMonths = Array.from(allMonthsSet).sort();

  // Print monthly table
  console.log(pad('Month', 10) + survivors.map((v) => padR(v.label.slice(0, 14), 15)).join('') + padR('PORTFOLIO', 12) + ' Δ Sign');
  console.log('-'.repeat(10 + 15 * survivors.length + 12 + 8));

  let monthsAllNegative = 0;
  let monthsAllPositive = 0;
  let monthsMixed = 0;
  for (const m of allMonths) {
    let row = pad(m, 10);
    let portfolioPnl = 0;
    let signs = [];
    for (const v of survivors) {
      const p = monthlyByVariant[v.name][m] || 0;
      portfolioPnl += p;
      signs.push(p > 0 ? '+' : p < 0 ? '-' : '0');
      const cell = p === 0 ? '—' : (p >= 0 ? '+' : '') + '$' + p.toFixed(1);
      row += padR(cell, 15);
    }
    row += padR((portfolioPnl >= 0 ? '+' : '') + '$' + portfolioPnl.toFixed(2), 12);
    const allNeg = signs.every((s) => s === '-');
    const allPos = signs.every((s) => s === '+');
    const flag = allNeg ? ' ⚠️ all-loss' : allPos ? ' ✓ all-win' : ' mixed';
    if (allNeg) monthsAllNegative++;
    else if (allPos) monthsAllPositive++;
    else monthsMixed++;
    row += flag;
    console.log(row);
  }

  console.log('');
  console.log(`  Months all-negative (concentrado-pérdida): ${monthsAllNegative} (${(monthsAllNegative / allMonths.length * 100).toFixed(0)}%)`);
  console.log(`  Months all-positive (concentrado-ganancia): ${monthsAllPositive} (${(monthsAllPositive / allMonths.length * 100).toFixed(0)}%)`);
  console.log(`  Months mixed (diversificación real):       ${monthsMixed} (${(monthsMixed / allMonths.length * 100).toFixed(0)}%)`);
  console.log('');
  console.log('  Lectura:');
  if (monthsAllNegative / allMonths.length > 0.3) {
    console.log('  ⚠️ Demasiados meses all-negative — los pares NO diversifican lo suficiente.');
    console.log('     Riesgo: drawdowns concentrados, posición simultánea no reduce variance.');
  } else if (monthsMixed / allMonths.length >= 0.5) {
    console.log('  ✓ Buena diversificación — distintos pares ganan/pierden en distintos meses.');
    console.log('     Portfolio multi-pair sí reduce variance vs single-pair.');
  } else {
    console.log('  Diversificación parcial — vigilar evolución, no concluyente.');
  }
}

// Final recommendation
console.log('');
console.log('===============================================================================');
console.log('  PORTFOLIO RECOMENDADO');
console.log('===============================================================================');
console.log('');

const strong = VARIANTS.filter((v) => verdicts[v.name]?.verdict === '✅ FUERTE');
const alive = VARIANTS.filter((v) => verdicts[v.name]?.verdict === '🟢 VIVO');
const archive = VARIANTS.filter((v) => verdicts[v.name]?.verdict === '❌ ARCHIVE');

if (strong.length === 0 && alive.length === 0) {
  console.log('  ❌ Ninguna variante sobrevive OOS. La hipótesis multi-pair NO se sostiene.');
  console.log('     Probable curve-fit al período actual. Volver a Sistema A baseline only.');
} else {
  console.log(`  ✅ FUERTE (PF >= 1.5 en 2/3 ventanas): ${strong.length}`);
  for (const v of strong) console.log(`     - ${v.label}`);
  console.log('');
  console.log(`  🟢 VIVO (PF >= 1.3 en 2/3 ventanas): ${alive.length}`);
  for (const v of alive) console.log(`     - ${v.label}`);
  console.log('');
  console.log(`  ❌ ARCHIVE: ${archive.length}`);
  for (const v of archive) console.log(`     - ${v.label}`);
  console.log('');

  // Aggregate PnL of survivors across all 3 windows
  let combinedPnl = 0;
  let combinedTrades = 0;
  for (const v of [...strong, ...alive]) {
    for (const w of WINDOWS) {
      const d = results[w.id][v.name];
      if (d) {
        combinedPnl += d.summary.totalPnlUsd;
        combinedTrades += d.summary.totalTrades;
      }
    }
  }
  console.log(`  Portfolio combinado de survivors (3Y total):`);
  console.log(`    Total PnL:    $${combinedPnl.toFixed(2)}`);
  console.log(`    Total trades: ${combinedTrades}`);
  console.log(`    Trades/día:   ${(combinedTrades / (365 * 3)).toFixed(2)}`);
}
console.log('');
