import { useEffect, useState } from 'react';
import { AppShell } from '../components/layout/AppShell';
import { LeftSidebar } from '../components/layout/LeftSidebar';
import { RightInspector } from '../components/layout/RightInspector';
import { BottomPanel } from '../components/layout/BottomPanel';
import { ChartToolbar } from '../components/chart/ChartToolbar';
import { CandleChart } from '../components/chart/CandleChart';
import { fetchCandles } from '../features/candles/candles.api';
import { TIMEFRAMES, type Candle, type Timeframe } from '../features/candles/candles.types';

type Status = 'loading' | 'error' | 'ready';
const PAGE = 500;

function initialTf(): Timeframe {
  const saved = localStorage.getItem('cockpit.tf');
  return (TIMEFRAMES as string[]).includes(saved ?? '') ? (saved as Timeframe) : '15m';
}

/**
 * Trading Cockpit — Slice 2A: gráfica profesional.
 * Velas más recientes al abrir + "cargar más historial" hacia atrás, inspector con OHLCV,
 * paneles colapsables / focus, y persistencia de símbolo/tf. Sin OB/FVG ni señales aún.
 */
export function TradingCockpit() {
  const [symbol, setSymbol] = useState(() => localStorage.getItem('cockpit.symbol') ?? 'BTCUSDT');
  const [tf, setTf] = useState<Timeframe>(initialTf);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<Candle | null>(null);
  const [hasMoreOlder, setHasMoreOlder] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [panels, setPanels] = useState({ left: true, right: true, bottom: true });

  useEffect(() => localStorage.setItem('cockpit.symbol', symbol), [symbol]);
  useEffect(() => localStorage.setItem('cockpit.tf', tf), [tf]);

  // Carga fresca al cambiar símbolo/timeframe.
  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setError(null);
    setHover(null);
    fetchCandles(symbol, tf, PAGE)
      .then((res) => {
        if (cancelled) return;
        setCandles(res.candles);
        setHasMoreOlder(res.hasMoreOlder);
        setStatus('ready');
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, tf]);

  async function loadOlder() {
    if (loadingMore || !hasMoreOlder || candles.length === 0) return;
    setLoadingMore(true);
    try {
      const before = candles[0].openTime;
      const res = await fetchCandles(symbol, tf, PAGE, { before });
      if (res.candles.length > 0) {
        setCandles((prev) => [...res.candles, ...prev]);
      }
      setHasMoreOlder(res.hasMoreOlder);
    } catch {
      // silencioso: si falla, el botón sigue disponible para reintentar
    } finally {
      setLoadingMore(false);
    }
  }

  const viewKey = `${symbol}:${tf}`;

  let center: React.ReactNode;
  if (status === 'error') {
    center = (
      <div className="state state-error">
        <p>Error al cargar velas</p>
        <code>{error}</code>
        <p className="hint">¿Backend arriba con DB_ENABLED=true y datos de {symbol} {tf}?</p>
      </div>
    );
  } else if (status === 'loading') {
    center = <div className="state state-loading">Cargando velas…</div>;
  } else if (candles.length === 0) {
    center = <div className="state">Sin velas para {symbol} {tf}.</div>;
  } else {
    center = (
      <div className="chart-wrap">
        {hasMoreOlder && (
          <button className="load-older" onClick={loadOlder} disabled={loadingMore}>
            {loadingMore ? 'Cargando…' : '◄ Cargar más historial'}
          </button>
        )}
        <CandleChart candles={candles} viewKey={viewKey} onHover={setHover} />
      </div>
    );
  }

  return (
    <AppShell
      leftOpen={panels.left}
      rightOpen={panels.right}
      bottomOpen={panels.bottom}
      topBar={
        <ChartToolbar
          symbol={symbol}
          tf={tf}
          onSymbol={setSymbol}
          onTf={setTf}
          status={status}
          count={candles.length}
          hover={hover}
          leftOpen={panels.left}
          rightOpen={panels.right}
          bottomOpen={panels.bottom}
          onToggleLeft={() => setPanels((p) => ({ ...p, left: !p.left }))}
          onToggleRight={() => setPanels((p) => ({ ...p, right: !p.right }))}
          onToggleBottom={() => setPanels((p) => ({ ...p, bottom: !p.bottom }))}
          onFocus={() =>
            setPanels((p) => {
              const anyOpen = p.left || p.right || p.bottom;
              return { left: !anyOpen, right: !anyOpen, bottom: !anyOpen };
            })
          }
        />
      }
      left={<LeftSidebar />}
      center={center}
      right={<RightInspector symbol={symbol} tf={tf} loaded={candles.length} hover={hover} />}
      bottom={<BottomPanel />}
    />
  );
}
