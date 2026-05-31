import {
  OPERABILITY_COLORS,
  OPERABILITY_LABELS,
  PLAN_SIDE_COLORS,
  type BotTradePlan,
} from '../../features/bot-analysis/botTradePlan.types';
import { formatPrice } from '../../lib/price-format';

interface Props {
  plans: BotTradePlan[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  confCount: number;
  riskCount: number;
}

/**
 * Panel inferior: lista de Trade Plans candidatos del bot (5F-B). Click en una fila → selecciona
 * y centra el plan en la gráfica. Ordenada por cercanía del Entry al precio. Sugerencias, no órdenes.
 */
export function BottomPanel({ plans, selectedId, onSelect, confCount, riskCount }: Props) {
  const sorted = [...plans].sort((a, b) => a.entryDistancePct - b.entryDistancePct);
  return (
    <div className="bottom">
      <div className="plans-header">
        <b>Planes del bot</b>
        <span className="muted">Confirmación: {confCount} · Riesgo: {riskCount} · Total: {plans.length}</span>
      </div>
      {plans.length === 0 ? (
        <p className="hint">Sin planes candidatos. Aparecen cuando hay un setup ARMED (o si activas “Riesgo”).</p>
      ) : (
        <div className="plans-table">
          <div className="plans-row head">
            <span>Lado</span><span>Modo</span><span>Entry</span><span>SL</span><span>TP</span><span>R:R</span><span>Dist.</span><span>Estado</span>
          </div>
          {sorted.map((p) => (
            <div
              key={p.id}
              className={`plans-row${p.id === selectedId ? ' selected' : ''}`}
              onClick={() => onSelect(p.id)}
            >
              <span style={{ color: PLAN_SIDE_COLORS[p.side], fontWeight: 700 }}>{p.side}</span>
              <span>{p.mode === 'risk' ? 'Riesgo' : 'Conf.'}</span>
              <span>{formatPrice(p.entry)}</span>
              <span>{formatPrice(p.stopLoss)}</span>
              <span>{formatPrice(p.takeProfit)}</span>
              <span>{p.rr}{p.minRrMet ? '' : ' ⚠'}</span>
              <span>{p.entryDistancePct}%</span>
              <span style={{ color: OPERABILITY_COLORS[p.operability] }}>{OPERABILITY_LABELS[p.operability]}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
