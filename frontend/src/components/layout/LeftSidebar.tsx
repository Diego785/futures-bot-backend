interface Props {
  marksVisible: boolean;
  onToggleMarks: () => void;
  marksCount: number;
}

// Capas. "Mis marcas" ya es un toggle real (Slice 3A). El resto son placeholders de
// slices futuros (VideoSMC, StrictFVG, LuxAlgo, señales, journal).
const FUTURE_LAYERS = ['VideoSMC', 'StrictFVG', 'LuxAlgo (ref)', 'Señales', 'Journal'];

export function LeftSidebar({ marksVisible, onToggleMarks, marksCount }: Props) {
  return (
    <div className="panel">
      <h3 className="panel-title">Capas</h3>
      <ul className="layer-list">
        <li className="layer-item">
          <label>
            <input type="checkbox" checked={marksVisible} onChange={onToggleMarks} />{' '}
            <span>Mis marcas</span> <span className="muted">({marksCount})</span>
          </label>
        </li>
        {FUTURE_LAYERS.map((layer) => (
          <li key={layer} className="layer-item disabled">
            <input type="checkbox" disabled /> <span>{layer}</span>
          </li>
        ))}
      </ul>
      <p className="hint">Más capas en próximos slices.</p>
    </div>
  );
}
