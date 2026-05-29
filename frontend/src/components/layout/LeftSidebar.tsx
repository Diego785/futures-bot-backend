// Panel de capas. En slices futuros estas capas se podrán activar/desactivar
// (ver docs/API-CONTRACT.md y ENTRY-EDGE-SPEC.md). Por ahora son placeholders.
const LAYERS = ['Mis marcas', 'VideoSMC', 'StrictFVG', 'LuxAlgo (ref)', 'Señales', 'Journal'];

export function LeftSidebar() {
  return (
    <div className="panel">
      <h3 className="panel-title">Capas</h3>
      <ul className="layer-list">
        {LAYERS.map((layer) => (
          <li key={layer} className="layer-item disabled">
            <input type="checkbox" disabled /> <span>{layer}</span>
          </li>
        ))}
      </ul>
      <p className="hint">Próximos slices</p>
    </div>
  );
}
