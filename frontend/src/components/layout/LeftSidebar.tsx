import {
  isPlanKind,
  isZoneKind,
  computeRR,
  MARK_COLORS,
  STATUS_COLORS,
  STATUS_LABELS,
  type ManualMark,
  type ManualMarkKind,
} from '../../features/manual-marks/manualMarks.types';
import { formatPrice } from '../../lib/price-format';

export type TypeFilter = 'ALL' | ManualMarkKind;

interface Props {
  marksVisible: boolean;
  onToggleMarks: () => void;
  marks: ManualMark[];
  selectedId: string | null;
  onSelectMark: (id: string) => void;
  typeFilter: TypeFilter;
  onTypeFilter: (f: TypeFilter) => void;
}

const FILTERS: { key: TypeFilter; label: string }[] = [
  { key: 'ALL', label: 'Todas' },
  { key: 'OB', label: 'OB' },
  { key: 'FVG', label: 'FVG' },
  { key: 'Liquidity', label: 'Liq' },
  { key: 'TradePlan', label: 'Plan' },
];

function markLabel(m: ManualMark): string {
  if (isPlanKind(m.kind)) {
    const rr =
      m.entry != null && m.stopLoss != null && m.takeProfit != null
        ? computeRR(m.entry, m.stopLoss, m.takeProfit)
        : null;
    return `${m.side ?? '—'} · R:R ${rr != null ? rr.toFixed(1) : '—'}`;
  }
  if (isZoneKind(m.kind)) {
    return `${m.kind} ${formatPrice(m.priceHigh ?? 0)}–${formatPrice(m.priceLow ?? 0)}`;
  }
  return `Liq ${formatPrice(m.price ?? 0)}`;
}

export function LeftSidebar({
  marksVisible,
  onToggleMarks,
  marks,
  selectedId,
  onSelectMark,
  typeFilter,
  onTypeFilter,
}: Props) {
  const counts = { OB: 0, FVG: 0, Liquidity: 0, TradePlan: 0 } as Record<ManualMarkKind, number>;
  for (const m of marks) counts[m.kind] += 1;

  const filtered = (typeFilter === 'ALL' ? marks : marks.filter((m) => m.kind === typeFilter))
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt);

  return (
    <div className="panel">
      <h3 className="panel-title">
        Workspace
        <label className="layer-toggle" title="Mostrar/ocultar la capa de marcas">
          <input type="checkbox" checked={marksVisible} onChange={onToggleMarks} /> capa
        </label>
      </h3>

      <div className="ws-summary">
        <span>OB {counts.OB}</span>
        <span>FVG {counts.FVG}</span>
        <span>Liq {counts.Liquidity}</span>
        <span>Plan {counts.TradePlan}</span>
        <span className="muted">Total {marks.length}</span>
      </div>

      <div className="ws-filters">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className={`ws-filter${typeFilter === f.key ? ' active' : ''}`}
            onClick={() => onTypeFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="hint">Sin marcas{typeFilter !== 'ALL' ? ' de este tipo' : ''}. Dibuja sobre la gráfica.</p>
      ) : (
        <ul className="marks-list">
          {filtered.map((m) => (
            <li
              key={m.id}
              className={`mark-row${m.id === selectedId ? ' selected' : ''}`}
              onClick={() => onSelectMark(m.id)}
              title={m.reason || markLabel(m)}
            >
              <span className="mark-dot" style={{ background: MARK_COLORS[m.kind] }} />
              <span className="mark-row-label">{markLabel(m)}</span>
              <span className="mark-status" style={{ color: STATUS_COLORS[m.status ?? 'DRAFT'] }}>
                {STATUS_LABELS[m.status ?? 'DRAFT']}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
