import { useCallback, useEffect, useRef, useState } from 'react';
import { LiveClient, type MarketStatus } from '../lib/liveClient';
import { AppShell } from '../components/layout/AppShell';
import { LeftSidebar, type TypeFilter } from '../components/layout/LeftSidebar';
import { RightInspector } from '../components/layout/RightInspector';
import { BottomPanel } from '../components/layout/BottomPanel';
import { ChartToolbar } from '../components/chart/ChartToolbar';
import { CandleChart } from '../components/chart/CandleChart';
import { MarkTools } from '../components/chart/MarkTools';
import { fetchCandles } from '../features/candles/candles.api';
import { TIMEFRAMES, type Candle, type Timeframe } from '../features/candles/candles.types';
import type { ManualMark, ManualTool } from '../features/manual-marks/manualMarks.types';
import { createMark, marksDiffer, type NewMarkInput } from '../features/manual-marks/marks.util';
import { useMarkHistory } from '../features/manual-marks/useMarkHistory';
import {
  fetchMarks,
  createMarkRemote,
  patchMarkRemote,
  deleteMarkRemote,
} from '../features/manual-marks/marks.api';
import { fetchBotFvgs } from '../features/bot-analysis/botFvg.api';
import type { BotFvg } from '../features/bot-analysis/botFvg.types';

type Status = 'loading' | 'error' | 'ready';
const PAGE = 500;

function initialTf(): Timeframe {
  const saved = localStorage.getItem('cockpit.tf');
  return (TIMEFRAMES as string[]).includes(saved ?? '') ? (saved as Timeframe) : '15m';
}

/**
 * Trading Cockpit. Gráfica profesional + marcas manuales (OB/FVG/Liquidity/TradePlan) con
 * historial undo/redo (Slice 3A.1-e) y persistencia en DB (Slice 3B). Sin motor SMC ni señales.
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

  // ─── Marcas manuales: estado con historial undo/redo (Slice 3A.1-e) ───
  const { marks, selectedId, commit, select, replace, reset, undo, redo } = useMarkHistory();
  const [tool, setTool] = useState<ManualTool>('Select');
  const [marksVisible, setMarksVisible] = useState(true);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('ALL');
  // Petición de centrar la gráfica en una marca (al hacer click en la lista del workspace).
  const [focusReq, setFocusReq] = useState<{ id: string; nonce: number } | null>(null);

  // ─── Lectura automática del bot: StrictFVG (Fase 5A) ───
  const [botFvgs, setBotFvgs] = useState<BotFvg[]>([]);
  const [botVisible, setBotVisible] = useState(true);
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const selectedBotFvg = botFvgs.find((f) => f.id === selectedBotId) ?? null;

  // Selección mutuamente excluyente: marca manual XOR FVG del bot.
  function handleSelectMark(id: string | null): void {
    select(id);
    if (id) setSelectedBotId(null);
  }
  function handleSelectBot(id: string | null): void {
    setSelectedBotId(id);
    if (id) select(null);
  }
  function handleSelectFromList(id: string): void {
    handleSelectMark(id);
    setFocusReq((p) => ({ id, nonce: (p?.nonce ?? 0) + 1 }));
  }

  // ─── Persistencia (Slice 3B) ───
  // El estado local (historial) es la verdad para render; la API es efecto colateral. PATCH con
  // debounce por id: coalesce ediciones y da tiempo a que el POST de creación aterrice antes del
  // primer PATCH. Si la API falla (DB off / backend caído) se mantiene local.
  const marksRef = useRef(marks);
  marksRef.current = marks;
  const patchTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  function schedulePatch(id: string): void {
    const timers = patchTimers.current;
    const existing = timers.get(id);
    if (existing) clearTimeout(existing);
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        const m = marksRef.current.find((x) => x.id === id);
        if (m) patchMarkRemote(m).catch((e) => console.warn('PATCH marca falló (se mantiene local):', e));
      }, 500),
    );
  }
  function cancelPatch(id: string): void {
    const t = patchTimers.current.get(id);
    if (t) {
      clearTimeout(t);
      patchTimers.current.delete(id);
    }
  }
  const cancelAllPatches = useCallback(() => {
    patchTimers.current.forEach((t) => clearTimeout(t));
    patchTimers.current.clear();
  }, []);

  // Reconciliación de persistencia tras undo/redo: el diff before→after se traduce a POST
  // (reaparece), DELETE (desaparece) o PATCH (cambió), para que la DB quede igual que la pantalla.
  const reconcile = useCallback((before: ManualMark[], after: ManualMark[]) => {
    const beforeById = new Map(before.map((m) => [m.id, m]));
    const afterById = new Map(after.map((m) => [m.id, m]));
    for (const m of after) {
      const prev = beforeById.get(m.id);
      if (!prev) createMarkRemote(m).catch((e) => console.warn('undo/redo POST falló:', e));
      else if (marksDiffer(prev, m)) patchMarkRemote(m).catch((e) => console.warn('undo/redo PATCH falló:', e));
    }
    for (const m of before) {
      if (!afterById.has(m.id)) deleteMarkRemote(m.id).catch((e) => console.warn('undo/redo DELETE falló:', e));
    }
  }, []);

  const visibleMarks = marks.filter((m) => m.symbol === symbol && m.tf === tf);
  const selectedMark = marks.find((m) => m.id === selectedId) ?? null;

  function handleCreateMark(input: NewMarkInput): void {
    const mark = createMark(input, Date.now());
    commit((prev) => [...prev, mark], () => mark.id);
    setTool('Select'); // tras crear, volver a selección (evita marcas accidentales)
    createMarkRemote(mark).catch((e) => console.warn('POST marca falló (se mantiene local):', e));
  }
  function handleUpdateMeta(id: string, patch: Partial<ManualMark>): void {
    // Metadatos de revisión (estado/notas): sin historial (el textarea ya tiene undo nativo de
    // texto; el estado es un toggle de estudio). Persiste con debounce.
    replace((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch, updatedAt: Date.now() } : m)));
    schedulePatch(id);
  }
  function handleUpdateMark(id: string, patch: Partial<ManualMark>): void {
    const cur = marksRef.current.find((m) => m.id === id);
    if (cur && !marksDiffer(cur, { ...cur, ...patch })) return; // drag sin cambio real: nada
    commit((prev) => prev.map((m) => (m.id === id ? { ...m, ...patch, updatedAt: Date.now() } : m)));
    schedulePatch(id);
  }
  function handleDeleteMark(id: string): void {
    cancelPatch(id);
    commit(
      (prev) => prev.filter((m) => m.id !== id),
      (sel) => (sel === id ? null : sel),
    );
    deleteMarkRemote(id).catch((e) => console.warn('DELETE marca falló:', e));
  }

  // Undo/redo: transición de historial + reconciliación de DB. Cancela PATCH pendientes para
  // que el debounce no pise la reconciliación.
  const doUndo = useCallback(() => {
    cancelAllPatches();
    const t = undo();
    if (t) reconcile(t.before, t.after);
  }, [undo, reconcile, cancelAllPatches]);
  const doRedo = useCallback(() => {
    cancelAllPatches();
    const t = redo();
    if (t) reconcile(t.before, t.after);
  }, [redo, reconcile, cancelAllPatches]);

  // Ctrl+Z deshace, Ctrl+Shift+Z / Ctrl+Y rehace. NO interceptar si el foco está en un
  // input/textarea (la nota usa el undo nativo del texto).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const tag = (document.activeElement?.tagName ?? '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) {
        e.preventDefault();
        doUndo();
      } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
        e.preventDefault();
        doRedo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [doUndo, doRedo]);

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

  // Carga fresca de velas al cambiar símbolo/timeframe.
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

  // Cargar marcas persistidas al cambiar símbolo/tf. Limpia la vista al instante (reset) y
  // repuebla con lo de DB; reset limpia el historial (no se deshace a través de un cambio de tf).
  // Si falla (DB off / backend caído) queda vista limpia, sin romper el cockpit.
  useEffect(() => {
    let cancelled = false;
    reset([], null);
    fetchMarks(symbol, tf)
      .then((res) => {
        if (!cancelled) reset(res.marks, null);
      })
      .catch(() => {
        /* sin persistencia: vista sin marcas */
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, tf, reset]);

  // Cargar los FVGs del bot al cambiar símbolo/tf (lectura read-only del backend).
  useEffect(() => {
    let cancelled = false;
    setSelectedBotId(null);
    fetchBotFvgs(symbol, tf)
      .then((res) => {
        if (!cancelled) setBotFvgs(res.fvgs);
      })
      .catch(() => {
        if (!cancelled) setBotFvgs([]);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, tf]);

  // Limpia los timers de PATCH pendientes al desmontar.
  useEffect(() => {
    const timers = patchTimers.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
    };
  }, []);

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
          onSelectMark={handleSelectMark}
          onUpdateMark={handleUpdateMark}
          onDeleteMark={handleDeleteMark}
          focusRequest={focusReq}
          botFvgs={botFvgs}
          botLayerVisible={botVisible}
          selectedBotId={selectedBotId}
          onSelectBot={handleSelectBot}
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
          marks={visibleMarks}
          selectedId={selectedId}
          onSelectMark={handleSelectFromList}
          typeFilter={typeFilter}
          onTypeFilter={setTypeFilter}
          botVisible={botVisible}
          onToggleBot={() => setBotVisible((v) => !v)}
          botFvgCount={botFvgs.filter((f) => f.state !== 'filled').length}
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
          selectedBotFvg={selectedBotFvg}
          onUpdateMeta={handleUpdateMeta}
          onDeleteMark={handleDeleteMark}
        />
      }
      bottom={<BottomPanel />}
    />
  );
}
