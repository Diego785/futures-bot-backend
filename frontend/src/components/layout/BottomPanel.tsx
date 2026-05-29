// Panel inferior: journal, setups, señales, replay, métricas (slices futuros).
const TABS = ['Journal', 'Setups', 'Señales', 'Replay', 'Métricas'];

export function BottomPanel() {
  return (
    <div className="bottom">
      <nav className="tabs">
        {TABS.map((t) => (
          <span key={t} className="tab">
            {t}
          </span>
        ))}
      </nav>
      <p className="hint">Paneles inferiores: próximos slices.</p>
    </div>
  );
}
