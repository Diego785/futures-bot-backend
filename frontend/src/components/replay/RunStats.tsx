import { useMemo } from 'react';
import type {
  BacktestRunDetail,
  BacktestSignal,
} from '../../features/backtest-viewer/backtestRuns.types';

interface Props {
  run: BacktestRunDetail;
  signals: BacktestSignal[];
  equity: { time: number; cum: number; intentId: string }[];
  onPickTrade: (intentId: string) => void;
}

const W = 860;
const H = 220;
const PAD = 28;

const fmtR = (r: number) => `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`;
const pct = (n: number) => `${(n * 100).toFixed(1)} %`;
const rcls = (r: number) => (r > 0.001 ? 'r-pos' : r < -0.001 ? 'r-neg' : 'r-zero');

/**
 * ESTADÍSTICAS del run (V.4) — responde de un vistazo la única pregunta que importa
 * (PRODUCT-VISION §3.2): ¿este candidato fue rentable en este histórico? Con el desglose
 * completo: salidas, embudo, equity, por año y por dirección. Backtest ≠ garantía:
 * el veredicto real lo da el forward-test (gate #7).
 */
export function RunStats({ run, signals, equity, onPickTrade }: Props) {
  const m = run.metrics;

  const agg = useMemo(() => {
    const filled = signals.filter((s) => s.outcome === 'filled' && s.rMultiple != null);
    const byExit: Record<string, { n: number; r: number }> = {};
    const byYear: Record<string, { n: number; r: number; wins: number }> = {};
    const byDir: Record<string, { n: number; r: number; wins: number }> = { LONG: { n: 0, r: 0, wins: 0 }, SHORT: { n: 0, r: 0, wins: 0 } };
    const rejectByReason: Record<string, number> = {};
    let rejected = 0;
    let barsHeldSum = 0;
    for (const s of signals) {
      if (s.outcome === 'rejected') {
        rejected++;
        rejectByReason[s.reason ?? '?'] = (rejectByReason[s.reason ?? '?'] ?? 0) + 1;
        continue;
      }
      if (s.outcome !== 'filled' || s.rMultiple == null) continue;
      const r = s.rMultiple;
      const exit = s.exitReason ?? '?';
      byExit[exit] = byExit[exit] ?? { n: 0, r: 0 };
      byExit[exit].n++;
      byExit[exit].r += r;
      const year = s.exitTime != null ? new Date(s.exitTime).getUTCFullYear().toString() : '?';
      byYear[year] = byYear[year] ?? { n: 0, r: 0, wins: 0 };
      byYear[year].n++;
      byYear[year].r += r;
      if (r > 0) byYear[year].wins++;
      const d = byDir[s.direction];
      d.n++;
      d.r += r;
      if (r > 0) d.wins++;
      barsHeldSum += s.barsHeld ?? 0;
    }
    return {
      filledN: filled.length,
      byExit,
      byYear: Object.entries(byYear).sort(([a], [b]) => a.localeCompare(b)),
      byDir,
      rejected,
      rejectByReason,
      avgBarsHeld: filled.length ? barsHeldSum / filled.length : 0,
    };
  }, [signals]);

  const eq = useMemo(() => {
    if (equity.length === 0) return null;
    const ys = equity.map((p) => p.cum);
    const yMin = Math.min(0, ...ys);
    const yMax = Math.max(0, ...ys);
    const xTo = (i: number) => PAD + (i / Math.max(equity.length - 1, 1)) * (W - 2 * PAD);
    const yTo = (v: number) => H - PAD - ((v - yMin) / Math.max(yMax - yMin, 1e-9)) * (H - 2 * PAD);
    const d = equity.map((p, i) => `${i === 0 ? 'M' : 'L'}${xTo(i).toFixed(1)},${yTo(p.cum).toFixed(1)}`).join(' ');
    // Marcas de año en el eje X (primer trade de cada año).
    const yearTicks: { x: number; label: string }[] = [];
    let prevYear = '';
    equity.forEach((p, i) => {
      const y = new Date(p.time).getUTCFullYear().toString();
      if (y !== prevYear) {
        yearTicks.push({ x: xTo(i), label: y });
        prevYear = y;
      }
    });
    return { d, xTo, yTo, zeroY: yTo(0), yearTicks, last: equity[equity.length - 1] };
  }, [equity]);

  const exitOrder = ['TP', 'SL', 'BE', 'maxHold', 'endOfData'];
  const maxExitN = Math.max(1, ...Object.values(agg.byExit).map((e) => e.n));
  const rDist = (m.rDistribution ?? {}) as Record<string, number>;
  const rBuckets = ['<=-1R', '-1..0R', '0..1R', '1..2R', '2..3R', '>=3R'];
  const maxBucket = Math.max(1, ...rBuckets.map((b) => rDist[b] ?? 0));

  return (
    <div className="run-stats">
      {/* ── Veredicto ── */}
      <div className="rs-verdict">
        <div className="rs-question">¿Fue rentable en este histórico?</div>
        <div className={`rs-total ${rcls(m.totalR)}`}>{fmtR(m.totalR)}</div>
        <div className="rs-sub">
          {fmtR(m.expectancyR)} por trade · {m.trades} trades · {run.symbol} {run.tf} ·{' '}
          {run.fromTime ? new Date(run.fromTime).toISOString().slice(0, 10) : '—'} →{' '}
          {run.toTime ? new Date(run.toTime).toISOString().slice(0, 10) : '—'}
        </div>
        <div className="rs-warn">backtest ≠ garantía — el veredicto real lo da el forward-test en papel (gate #7)</div>
      </div>

      {/* ── Tarjetas ── */}
      <div className="rs-cards">
        <div className="rs-card"><span className="rs-k">win-rate</span><b>{pct(m.winRate)}</b><span className="rs-d">{m.wins as number} W · {m.losses as number} L · {m.breakeven as number} BE</span></div>
        <div className="rs-card"><span className="rs-k">profit factor</span><b>{m.profitFactor === null ? '∞' : Number(m.profitFactor).toFixed(2)}</b><span className="rs-d">Σwin / |Σloss|</span></div>
        <div className="rs-card"><span className="rs-k">max drawdown</span><b className="r-neg">{Number(m.maxDrawdownR).toFixed(2)}R</b><span className="rs-d">pico→valle en R</span></div>
        <div className="rs-card"><span className="rs-k">fill-rate</span><b>{pct(m.fillRate)}</b><span className="rs-d">{m.trades}/{m.signals} señales llenan</span></div>
        <div className="rs-card"><span className="rs-k">ganador medio</span><b className="r-pos">{fmtR(Number(m.avgWinR))}</b><span className="rs-d">perdedor {fmtR(Number(m.avgLossR))}</span></div>
        <div className="rs-card"><span className="rs-k">duración media</span><b>{agg.avgBarsHeld.toFixed(0)} velas</b><span className="rs-d">dentro de la posición</span></div>
      </div>

      <div className="rs-grid">
        {/* ── Salidas ── */}
        <div className="rs-block">
          <h4>Salidas (qué pasó con cada trade)</h4>
          {exitOrder.filter((e) => agg.byExit[e]).map((e) => {
            const v = agg.byExit[e];
            return (
              <div key={e} className="rs-bar-row">
                <span className="rs-bar-label">{e}</span>
                <div className="rs-bar"><div className={`rs-bar-fill exit-${e}`} style={{ width: `${(v.n / maxExitN) * 100}%` }} /></div>
                <span className="rs-bar-n">{v.n} ({pct(v.n / Math.max(m.trades, 1))})</span>
                <span className={`rs-bar-r ${rcls(v.r)}`}>{fmtR(v.r)}</span>
              </div>
            );
          })}
        </div>

        {/* ── Distribución R ── */}
        <div className="rs-block">
          <h4>Distribución de resultados (R)</h4>
          {rBuckets.map((b) => (
            <div key={b} className="rs-bar-row">
              <span className="rs-bar-label">{b}</span>
              <div className="rs-bar"><div className="rs-bar-fill dist" style={{ width: `${((rDist[b] ?? 0) / maxBucket) * 100}%` }} /></div>
              <span className="rs-bar-n">{rDist[b] ?? 0}</span>
            </div>
          ))}
        </div>

        {/* ── Embudo ── */}
        <div className="rs-block">
          <h4>Embudo (de sweep detectado a trade)</h4>
          <table className="rs-table">
            <tbody>
              <tr><td>sweeps detectados</td><td>{signals.length}</td></tr>
              <tr><td>descartados por filtros</td><td>{agg.rejected} ({Object.entries(agg.rejectByReason).map(([k, v]) => `${k} ${v}`).join(' · ')})</td></tr>
              <tr><td>señales emitidas</td><td>{m.signals}</td></tr>
              <tr><td>canceladas sin fill</td><td>{m.cancelled}</td></tr>
              <tr><td><b>trades reales (N)</b></td><td><b>{m.trades}</b></td></tr>
            </tbody>
          </table>
        </div>

        {/* ── Por dirección ── */}
        <div className="rs-block">
          <h4>Por dirección</h4>
          <table className="rs-table">
            <thead><tr><th></th><th>N</th><th>win-rate</th><th>totalR</th></tr></thead>
            <tbody>
              {(['LONG', 'SHORT'] as const).map((d) => {
                const v = agg.byDir[d];
                return (
                  <tr key={d}>
                    <td className={d === 'LONG' ? 'long' : 'short'}>{d}</td>
                    <td>{v.n}</td>
                    <td>{v.n ? pct(v.wins / v.n) : '—'}</td>
                    <td className={rcls(v.r)}>{fmtR(v.r)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Equity ── */}
      {eq && (
        <div className="rs-block rs-equity">
          <h4>Curva de equity en R (click = auditar ese trade en el replay)</h4>
          <svg
            width={W}
            height={H}
            onClick={(e) => {
              const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
              const x = e.clientX - rect.left;
              const i = Math.round(((x - PAD) / (W - 2 * PAD)) * (equity.length - 1));
              const p = equity[Math.min(Math.max(i, 0), equity.length - 1)];
              if (p) onPickTrade(p.intentId);
            }}
          >
            <line x1={PAD} y1={eq.zeroY} x2={W - PAD} y2={eq.zeroY} stroke="#232733" strokeDasharray="4 4" />
            {eq.yearTicks.map((t) => (
              <g key={t.label}>
                <line x1={t.x} y1={PAD / 2} x2={t.x} y2={H - PAD / 2} stroke="#1b1f2a" />
                <text x={t.x + 4} y={14} fill="#6b7280" fontSize={10}>{t.label}</text>
              </g>
            ))}
            <path d={eq.d} fill="none" stroke="#3b82f6" strokeWidth={1.8} />
            <text x={W - PAD} y={eq.yTo(eq.last.cum) - 6} fill={eq.last.cum >= 0 ? '#26a69a' : '#ef5350'} fontSize={12} fontWeight={800} textAnchor="end">
              {fmtR(eq.last.cum)}
            </text>
          </svg>
        </div>
      )}

      {/* ── Por año ── */}
      <div className="rs-block">
        <h4>Por año</h4>
        <table className="rs-table rs-years">
          <thead><tr><th>año</th><th>N</th><th>win-rate</th><th>totalR</th></tr></thead>
          <tbody>
            {agg.byYear.map(([year, v]) => (
              <tr key={year}>
                <td>{year}</td>
                <td>{v.n}</td>
                <td>{pct(v.wins / Math.max(v.n, 1))}</td>
                <td className={rcls(v.r)}>{fmtR(v.r)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
