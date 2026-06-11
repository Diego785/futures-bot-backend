import { useMemo } from 'react';

interface Props {
  points: { time: number; cum: number; intentId: string }[]; // curva de equity en R (trade a trade)
  focusedIntentId: string | null;
  onPick?: (intentId: string) => void;
}

const W = 260;
const H = 64;
const PAD = 4;

/**
 * Curva de equity en R del run (estática — la "película" la da la gráfica; aquí se ve DÓNDE en la
 * curva vive el trade auditado y si el edge se acumula parejo o en rachas). Click = saltar al trade.
 */
export function EquitySparkline({ points, focusedIntentId, onPick }: Props) {
  const geom = useMemo(() => {
    if (points.length === 0) return null;
    const xs = points.map((_, i) => i);
    const ys = points.map((p) => p.cum);
    const yMin = Math.min(0, ...ys);
    const yMax = Math.max(0, ...ys);
    const xTo = (i: number) => PAD + (i / Math.max(xs.length - 1, 1)) * (W - 2 * PAD);
    const yTo = (v: number) => H - PAD - ((v - yMin) / Math.max(yMax - yMin, 1e-9)) * (H - 2 * PAD);
    const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${xTo(i).toFixed(1)},${yTo(p.cum).toFixed(1)}`).join(' ');
    return { d, xTo, yTo, zeroY: yTo(0) };
  }, [points]);

  if (!geom) return <div className="equity-spark empty">sin trades cerrados</div>;
  const fi = focusedIntentId ? points.findIndex((p) => p.intentId === focusedIntentId) : -1;
  const last = points[points.length - 1];

  return (
    <div className="equity-spark">
      <svg
        width={W}
        height={H}
        onClick={(e) => {
          if (!onPick || points.length === 0) return;
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const x = e.clientX - rect.left;
          const i = Math.round(((x - PAD) / (W - 2 * PAD)) * (points.length - 1));
          const p = points[Math.min(Math.max(i, 0), points.length - 1)];
          if (p) onPick(p.intentId);
        }}
      >
        <line x1={PAD} y1={geom.zeroY} x2={W - PAD} y2={geom.zeroY} stroke="#232733" strokeDasharray="3 3" />
        <path d={geom.d} fill="none" stroke="#3b82f6" strokeWidth={1.5} />
        {fi >= 0 && (
          <circle cx={geom.xTo(fi)} cy={geom.yTo(points[fi].cum)} r={3.5} fill="#f59e0b" stroke="#0b0c10" />
        )}
      </svg>
      <div className="equity-label">
        equity: <b>{last.cum >= 0 ? '+' : ''}{last.cum.toFixed(2)}R</b> en {points.length} trades
      </div>
    </div>
  );
}
