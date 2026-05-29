import { useEffect, useState } from 'react';
import { AppShell } from '../components/layout/AppShell';
import { LeftSidebar } from '../components/layout/LeftSidebar';
import { RightInspector } from '../components/layout/RightInspector';
import { BottomPanel } from '../components/layout/BottomPanel';
import { ChartToolbar } from '../components/chart/ChartToolbar';
import { CandleChart, type HoverOhlc } from '../components/chart/CandleChart';
import { fetchCandles } from '../features/candles/candles.api';
import type { Candle, Timeframe } from '../features/candles/candles.types';

type Status = 'loading' | 'error' | 'ready';

/**
 * Trading Cockpit — Slice 1: gráfica base.
 * Carga velas reales desde /api/candles y las pinta. El shell ya prevé capas, inspector
 * y paneles inferiores para los slices siguientes (OB/FVG, señales, journal, aprendizaje).
 */
export function TradingCockpit() {
  const [symbol, setSymbol] = useState('BTCUSDT');
  const [tf, setTf] = useState<Timeframe>('15m');
  const [candles, setCandles] = useState<Candle[]>([]);
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const [hover, setHover] = useState<HoverOhlc | null>(null);

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setError(null);
    fetchCandles(symbol, tf, 500)
      .then((res) => {
        if (cancelled) return;
        setCandles(res.candles);
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
    center = <CandleChart candles={candles} onHover={setHover} />;
  }

  return (
    <AppShell
      topBar={
        <ChartToolbar
          symbol={symbol}
          tf={tf}
          onSymbol={setSymbol}
          onTf={setTf}
          status={status}
          count={candles.length}
          hover={hover}
        />
      }
      left={<LeftSidebar />}
      center={center}
      right={<RightInspector symbol={symbol} tf={tf} hover={hover} />}
      bottom={<BottomPanel />}
    />
  );
}
