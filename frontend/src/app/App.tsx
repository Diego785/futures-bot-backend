import { useEffect, useState } from 'react';
import { TradingCockpit } from './TradingCockpit';
import { BacktestReplay } from './BacktestReplay';

type View = 'cockpit' | 'backtests';

/** Raíz de la app: Cockpit (gráfica en vivo + marcado) | Visor de backtests (replay causal). */
export function App() {
  const [view, setView] = useState<View>(() =>
    localStorage.getItem('app.view') === 'backtests' ? 'backtests' : 'cockpit',
  );
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
      </nav>
      {view === 'cockpit' ? <TradingCockpit /> : <BacktestReplay />}
    </>
  );
}
