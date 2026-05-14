#!/usr/bin/env node
/**
 * Phase 2.5 OOS aggregator.
 * Reads OOS variants across 4 time windows (3 OOS + 1 IS), prints per-window comparison.
 * Identifies robust winners (variants that improve PF in ALL windows vs baseline).
 *
 * Usage: node aggregate_oos.js [outDir=.]
 */
const fs = require('fs');
const path = require('path');

const outDir = process.argv[2] || __dirname;

const WINDOWS = [
  { id: 'W1', label: '2021-06→2022-06 (Bear inicial)', kind: 'OOS' },
  { id: 'W2', label: '2022-06→2023-06 (Bear deep+accumulation)', kind: 'OOS' },
  { id: 'W3', label: '2023-06→2024-06 (Recovery+early bull)', kind: 'OOS' },
  { id: 'W4', label: '2025-05→2026-05 (Bull/sideways actual)', kind: 'IS' },
];

const VARIANTS = ['baseline', 'noASIA', 'noCONSOL', 'noASIA_noCONSOL'];

function loadOOS(window, variant) {
  // W4 uses the original (non-OOS-prefixed) files in outputs/
  if (window === 'W4') {
    const file = variant === 'baseline' ? 'baseline.json' : `${variant}.json`;
    const p = path.join(outDir, file);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  }
  const p = path.join(outDir, `oos_${window}_${variant}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function fmtPF(pf) {
  if (pf === null || pf === undefined) return 'n/a';
  if (pf === Infinity || pf === null) return '∞';
  return pf.toFixed(2);
}
function pad(s, n) { return String(s).padEnd(n); }
function padR(s, n) { return String(s).padStart(n); }

// Per-window comparison
console.log('');
console.log('===============================================================================');
console.log('  PHASE 2.5 — OUT-OF-SAMPLE VALIDATION');
console.log('===============================================================================');
console.log('');

const results = {};
for (const w of WINDOWS) {
  results[w.id] = {};
  console.log(`┌────────────────────────────────────────────────────────────────────────────┐`);
  console.log(`│ ${w.id} [${w.kind}] — ${w.label}`.padEnd(77) + '│');
  console.log(`└────────────────────────────────────────────────────────────────────────────┘`);
  console.log(pad('Variant', 26) + padR('Trades', 8) + padR('PF', 8) + padR('WR', 8) +
    padR('TotPnL', 11) + padR('AvgW', 8) + padR('AvgL', 8) + padR('MaxDD', 9) + padR('%≥1R', 8));
  console.log('-'.repeat(92));

  for (const v of VARIANTS) {
    const data = loadOOS(w.id, v);
    if (!data) {
      console.log(pad(v, 26) + padR('PENDIENTE', 60));
      continue;
    }
    const s = data.summary;
    const m = data.mfeMaeStats;
    results[w.id][v] = data;
    console.log(
      pad(v, 26) +
      padR(s.totalTrades, 8) +
      padR(fmtPF(s.profitFactor), 8) +
      padR(s.winRate.toFixed(1) + '%', 8) +
      padR('$' + s.totalPnlUsd.toFixed(2), 11) +
      padR('$' + s.avgWinUsd.toFixed(2), 8) +
      padR('$' + s.avgLossUsd.toFixed(2), 8) +
      padR('$' + s.maxDrawdownUsd.toFixed(2), 9) +
      padR(m.pctTouched1R.toFixed(1) + '%', 8),
    );
  }
  console.log('');
}

// Robust winner analysis
console.log('===============================================================================');
console.log('  ROBUST WINNER — variante que GANA AL BASELINE en TODAS las ventanas');
console.log('===============================================================================');
console.log('');

const variantsToCheck = VARIANTS.filter((v) => v !== 'baseline');
const verdict = {};
for (const v of variantsToCheck) {
  verdict[v] = { perWindow: {}, robust: true, beatsAlways: true, surviveAlways: true };
  for (const w of WINDOWS) {
    const baselineData = results[w.id]['baseline'];
    const variantData = results[w.id][v];
    if (!baselineData || !variantData) {
      verdict[v].perWindow[w.id] = 'MISSING';
      verdict[v].robust = false;
      continue;
    }
    const bPF = baselineData.summary.profitFactor;
    const vPF = variantData.summary.profitFactor;
    const beatsBaseline = vPF >= bPF;
    const survives = vPF >= 2.0; // soft threshold: PF >= 2.0 across all windows
    if (!beatsBaseline) verdict[v].beatsAlways = false;
    if (!survives) verdict[v].surviveAlways = false;
    verdict[v].perWindow[w.id] = {
      bPF, vPF,
      delta: bPF > 0 ? ((vPF - bPF) / bPF * 100).toFixed(0) + '%' : 'n/a',
      beats: beatsBaseline,
      survives,
    };
  }
}

console.log(pad('Variant', 26) + padR('W1 Δ', 12) + padR('W2 Δ', 12) + padR('W3 Δ', 12) + padR('W4 Δ', 12) + padR('Robust?', 12));
console.log('-'.repeat(86));
for (const v of variantsToCheck) {
  const row = pad(v, 26);
  let cells = '';
  for (const w of WINDOWS) {
    const r = verdict[v].perWindow[w.id];
    if (r === 'MISSING') {
      cells += padR('—', 12);
    } else {
      const sign = r.beats ? '✓' : '✗';
      const surviveSign = r.survives ? '' : '✗';
      cells += padR(`${sign}${r.delta}${surviveSign}`, 12);
    }
  }
  const robust = verdict[v].beatsAlways && verdict[v].surviveAlways ? '✅ SI' : '❌ NO';
  console.log(row + cells + padR(robust, 12));
}

console.log('');
console.log('Leyenda:');
console.log('  ✓ = variant PF >= baseline PF en ese window');
console.log('  ✗ = variant PF < baseline PF en ese window');
console.log('  ✗ después del % = PF absoluto < 2.0 (estrategia colapsa)');
console.log('  ✅ Robusto = beats baseline AND PF>=2.0 en TODOS los windows');
console.log('');

// Final recommendation
console.log('===============================================================================');
console.log('  RECOMENDACIÓN');
console.log('===============================================================================');
console.log('');
const robustWinners = variantsToCheck.filter((v) => verdict[v].beatsAlways && verdict[v].surviveAlways);
if (robustWinners.length === 0) {
  console.log('  ❌ NO hay variante robusta. La mejora del IS no se sostiene en OOS.');
  console.log('     Probable curve-fit al régimen 2025-2026.');
  console.log('');
  console.log('  Ranking de variantes por # de windows con beats baseline:');
  for (const v of variantsToCheck) {
    const wins = WINDOWS.filter((w) => verdict[v].perWindow[w.id]?.beats).length;
    console.log(`    ${v}: gana en ${wins}/${WINDOWS.length} windows`);
  }
} else {
  console.log(`  ✅ ${robustWinners.length} variante(s) robusta(s):`);
  for (const v of robustWinners) {
    console.log(`     - ${v}`);
    for (const w of WINDOWS) {
      const r = verdict[v].perWindow[w.id];
      console.log(`         ${w.id} (${w.kind}): PF ${fmtPF(r.vPF)} (vs baseline ${fmtPF(r.bPF)}, ${r.delta})`);
    }
  }
  console.log('');
  console.log('  → Próximo paso: Phase 3 — testear módulos de gestión sobre el ganador robusto');
}
console.log('');
