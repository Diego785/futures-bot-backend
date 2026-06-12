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

  return (
    <>
      <nav className="app-viewtabs">
        <button className={view === 'cockpit' ? 'on' : ''} onClick={() => setView('cockpit')}>
          Cockpit
        </button>
        <button className={view === 'backtests' ? 'on' : ''} onClick={() => setView('backtests')}>
          Backtests
        </button>
        <button className={view === 'paper' ? 'on' : ''} onClick={() => setView('paper')}>
          Paper
        </button>
      </nav>
      {view === 'cockpit' ? <TradingCockpit /> : view === 'backtests' ? <BacktestReplay /> : <PaperDashboard />}
    </>
  );
}
