import { useEffect, useRef, useState } from 'react';
import { LiveClient, type MarketStatus } from '../lib/liveClient';
import { AppShell } from '../components/layout/AppShell';
import { LeftSidebar } from '../components/layout/LeftSidebar';
import { RightInspector } from '../components/layout/RightInspector';
import { BottomPanel } from '../components/layout/BottomPanel';
import { ChartToolbar } from '../components/chart/ChartToolbar';
import { CandleChart } from '../components/chart/CandleChart';
import { MarkTools } from '../components/chart/MarkTools';
import { fetchCandles } from '../features/candles/candles.api';
import { TIMEFRAMES, type Candle, type Timeframe } from '../features/candles/candles.types';
import type { ManualMark, ManualTool } from '../features/manual-marks/manualMarks.types';
import { createMark, type NewMarkInput } from '../features/manual-marks/marks.util';

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

  // ─── Marcas manuales (Slice 3A, estado local) ───
  const [marks, setMarks] = useState<ManualMark[]>([]);
  const [tool, setTool] = useState<ManualTool>('Select');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [marksVisible, setMarksVisible] = useState(true);

  const visibleMarks = marks.filter((m) => m.symbol === symbol && m.tf === tf);
  const selectedMark = marks.find((m) => m.id === selectedId) ?? null;

  function handleCreateMark(input: NewMarkInput): void {
    const mark = createMark(input, Date.now());
    setMarks((prev) => [...prev, mark]);
    setSelectedId(mark.id);
    setTool('Select'); // tras crear, volver a selección (evita marcas accidentales)
  }
  function handleUpdateNote(id: string, note: string): void {
    setMarks((prev) =>
      prev.map((m) => (m.id === id ? { ...m, note, updatedAt: Date.now() } : m)),
    );
  }
  function handleDeleteMark(id: string): void {
    setMarks((prev) => prev.filter((m) => m.id !== id));
    setSelectedId((cur) => (cur === id ? null : cur));
  }

  // ─── Live ───
  const [liveBar, setLiveBar] = useState<Candle | null>(null);
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [marketStatus, setMarketStatus] = useState<MarketStatus>('OFFLINE');
  const liveRef = useRef<LiveClient | null>(null);
  const currentRef = useRef({ symbol, tf });
  currentRef.current = { symbol, tf };

  useEffect(() => localStorage.setItem('cockpit.symbol', symbol), [symbol]);
  useEffect(() => localStorage.setItem('cockpit.tf', tf), [tf]);

  // Conexión live única (se monta una vez). Los handlers filtran al stream actual.
  useEffect(() => {
    const client = new LiveClient();
    liveRef.current = client;
    client.connect({
      onPrice: (sym, price) => {
        if (sym === currentRef.current.symbol) setLivePrice(price);
      },
      onLiveUpdate: (c) => {
        if (c.symbol === currentRef.current.symbol && c.tf === currentRef.current.tf) setLiveBar(c);
      },
      onClosed: (c) => {
        if (c.symbol === currentRef.current.symbol && c.tf === currentRef.current.tf) setLiveBar(c);
      },
      onStatus: (s) => setMarketStatus(s),
    });
    return () => {
      client.disconnect();
      liveRef.current = null;
    };
  }, []);

  // Cambiar de stream al cambiar símbolo/timeframe (resetea la vela viva).
  useEffect(() => {
    setLiveBar(null);
    setLivePrice(null);
    liveRef.current?.setStream(symbol, tf);
  }, [symbol, tf]);

  // Carga fresca al cambiar símbolo/timeframe.
  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setError(null);
    setHover(null);
    setSelectedId(null); // la marca seleccionada puede no pertenecer a este símbolo/tf
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
        <MarkTools value={tool} onChange={setTool} />
        <CandleChart
          candles={candles}
          viewKey={viewKey}
          liveBar={liveBar}
          marks={visibleMarks}
          tool={tool}
          selectedId={selectedId}
          layerVisible={marksVisible}
          symbol={symbol}
          tf={tf}
          onHover={setHover}
          onCreateMark={handleCreateMark}
          onSelectMark={setSelectedId}
        />
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
          marketStatus={marketStatus}
          livePrice={livePrice}
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
      left={
        <LeftSidebar
          marksVisible={marksVisible}
          onToggleMarks={() => setMarksVisible((v) => !v)}
          marksCount={visibleMarks.length}
        />
      }
      center={center}
      right={
        <RightInspector
          symbol={symbol}
          tf={tf}
          loaded={candles.length}
          hover={hover}
          selectedMark={selectedMark}
          onUpdateNote={handleUpdateNote}
          onDeleteMark={handleDeleteMark}
        />
      }
      bottom={<BottomPanel />}
    />
  );
}
