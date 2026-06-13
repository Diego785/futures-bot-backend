import { useEffect, useState } from 'react';
import { TradingCockpit } from './TradingCockpit';
import { BacktestReplay } from './BacktestReplay';
import { PaperDashboard } from './PaperDashboard';

type View = 'cockpit' | 'backtests' | 'paper';

/** Raíz: Cockpit (gráfica en vivo + marcado) | Backtests (replay causal) | Paper (gate #7 en vivo). */
export function App() {
  const [view, setView] = useState<View>(() => {
    const saved = localStorage.getItem('app.view');
    return saved === 'backtests' || saved === 'paper' ? saved : 'cockpit';
  });
  useEffect(() => localStorage.setItem('app.view', view), [view]);

  const tabs: { id: View; label: string; sub: string }[] = [
    { id: 'cockpit', label: 'Cockpit', sub: 'marcar en vivo' },
    { id: 'backtests', label: 'Backtests', sub: 'auditar histórico' },
    { id: 'paper', label: 'Paper', sub: 'gate #7 en vivo' },
  ];
  return (
    <>
      <nav className="app-viewtabs">
        {tabs.map((t) => (
          <button key={t.id} className={view === t.id ? 'on' : ''} onClick={() => setView(t.id)}>
            <span className="vt-label">{t.label}</span>
            <span className="vt-sub">{t.sub}</span>
          </button>
        ))}
      </nav>
      {view === 'cockpit' ? <TradingCockpit /> : view === 'backtests' ? <BacktestReplay /> : <PaperDashboard />}
    </>
  );
}
