import { useMemo } from 'react';
import { formatUsd, formatPct, type CapitalConfig, type CapitalSummary } from '../../features/paper/capital';

interface Props {
  summary: CapitalSummary;
  onConfig: (patch: Partial<CapitalConfig>) => void;
}

const SPARK_W = 420;
const SPARK_H = 64;
const PAD = 5;

/**
 * Panel de CAPITAL simulado del paper-test (D.1): el $ que el candidato congelado ganaría/perdería
 * a un riesgo fijo sobre un capital base. Balance, P&L, curva de equity en $, max drawdown y P&L por
 * mes. Es una transformación FIEL del registro en R (no inventa nada). Observable, no operable.
 */
export function CapitalPanel({ summary, onConfig }: Props) {
  const { baseCapital, riskPct } = summary.config;
  const pnlClass = summary.totalPnl > 0.0001 ? 'r-pos' : summary.totalPnl < -0.0001 ? 'r-neg' : 'r-zero';

  const spark = useMemo(() => {
    const pts = summary.curve;
    if (pts.length < 2) return null;
    const ys = pts.map((p) => p.balance);
    const yMin = Math.min(...ys);
    const yMax = Math.max(...ys);
    const xTo = (i: number) => PAD + (i / (pts.length - 1)) * (SPARK_W - 2 * PAD);
    const yTo = (v: number) => SPARK_H - PAD - ((v - yMin) / Math.max(yMax - yMin, 1e-9)) * (SPARK_H - 2 * PAD);
    const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${xTo(i).toFixed(1)},${yTo(p.balance).toFixed(1)}`).join(' ');
    return { d, baseY: yTo(baseCapital) };
  }, [summary.curve, baseCapital]);

  const maxMonth = Math.max(1, ...summary.byMonth.map((m) => Math.abs(m.pnl)));

  return (
    <div className="cap-panel">
      <div className="cap-hero">
        <div className="cap-bal">
          <span className="cap-label">Balance simulado</span>
          <span className="cap-bal-val">{formatUsd(summary.balance)}</span>
        </div>
        <div className={`cap-pnl ${pnlClass}`}>
          <span className="cap-pnl-val">{formatUsd(summary.totalPnl, true)}</span>
          <span className="cap-pnl-pct">{formatPct(summary.totalPnlPct)} sobre base</span>
        </div>
      </div>

      <div className="cap-config">
        <label className="cap-field">
          Capital base
          <span className="cap-input">$
            <input
              type="number"
              min={1}
              step={50}
              value={baseCapital}
              onChange={(e) => onConfig({ baseCapital: Math.max(1, Number(e.target.value) || 0) })}
            />
          </span>
        </label>
        <label className="cap-field">
          Riesgo / operación
          <span className="cap-input">
            <input
              type="number"
              min={0.05}
              max={5}
              step={0.05}
              value={+(riskPct * 100).toFixed(2)}
              onChange={(e) => onConfig({ riskPct: Math.max(0.0005, (Number(e.target.value) || 0) / 100) })}
            />%
          </span>
        </label>
        <span className="cap-risk">= {formatUsd(summary.riskPerTrade)} por operación</span>
      </div>

      {spark ? (
        <svg className="cap-spark" width={SPARK_W} height={SPARK_H} viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} preserveAspectRatio="none">
          <line x1={PAD} y1={spark.baseY} x2={SPARK_W - PAD} y2={spark.baseY} stroke="#232733" strokeDasharray="3 3" />
          <path d={spark.d} fill="none" stroke={summary.totalPnl >= 0 ? '#26a69a' : '#ef5350'} strokeWidth={1.6} />
        </svg>
      ) : (
        <div className="cap-spark-empty">la curva de capital aparece al cerrar la primera operación</div>
      )}

      <div className="cap-stats">
        <div className="cap-stat">
          <span className="cap-s-label">máx. drawdown</span>
          <span className="cap-s-val r-neg">
            {summary.maxDrawdown > 0 ? '−' : ''}{formatUsd(summary.maxDrawdown)} · {formatPct(summary.maxDrawdownPct, false)}
          </span>
        </div>
        <div className="cap-stat">
          <span className="cap-s-label">operaciones cerradas</span>
          <span className="cap-s-val">{summary.closedCount}</span>
        </div>
        <div className="cap-stat">
          <span className="cap-s-label">abiertas (no realizadas)</span>
          <span className="cap-s-val">{summary.openCount}</span>
        </div>
      </div>

      {summary.byMonth.length > 0 && (
        <div className="cap-months">
          <span className="cap-s-label">P&amp;L por mes</span>
          <div className="cap-month-row">
            {summary.byMonth.map((m) => (
              <div key={m.month} className="cap-month" title={`${m.month}: ${formatUsd(m.pnl, true)} · ${m.n} ops`}>
                <div className="cap-month-bar-wrap">
                  <div
                    className={`cap-month-bar ${m.pnl >= 0 ? 'pos' : 'neg'}`}
                    style={{ height: `${Math.round((Math.abs(m.pnl) / maxMonth) * 26) + 2}px` }}
                  />
                </div>
                <span className="cap-month-lbl">{m.month.slice(2)}</span>
                <span className={`cap-month-val ${m.pnl >= 0 ? 'r-pos' : 'r-neg'}`}>{formatUsd(m.pnl, true)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="cap-note">
        El $ es una transformación fiel del registro en R (riesgo fijo {formatPct(riskPct, false)} del capital base por
        operación). Solo cuenta operaciones cerradas del forward-test. No es una orden ni una cuenta real — Regla Cero.
      </p>
    </div>
  );
}
