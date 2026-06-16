import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppShell } from '../components/layout/AppShell';
import { ReplayChart } from '../components/replay/ReplayChart';
import { ReplayControls } from '../components/replay/ReplayControls';
import { RunStats } from '../components/replay/RunStats';
import { PaperLive } from '../components/paper/PaperLive';
import { fetchPaperStatus, fetchPaperTrades, fetchPaperContext } from '../features/paper/paper.api';
import type { PaperStatus, PaperTrade } from '../features/paper/paper.types';
import { buildPaperMetrics, paperBySymbol, paperToSignal } from '../features/paper/paperAdapter';
import { CapitalPanel } from '../components/paper/CapitalPanel';
import { computeCapital, DEFAULT_CAPITAL_CONFIG, formatUsd, type CapitalConfig } from '../features/paper/capital';
import { equityCurve, type BacktestRunDetail } from '../features/backtest-viewer/backtestRuns.types';
import type { ReplayContextResponse } from '../features/backtest-viewer/backtestContext.types';
import { fetchCandles } from '../features/candles/candles.api';
import type { Candle, Timeframe } from '../features/candles/candles.types';
import { PaperClient } from '../lib/paperClient';
import { formatUtc, tfToMs } from '../lib/time';

const PRE_BARS = 300;
const POST_BARS = 100;
const CURSOR_BACK = 30; // el replay arranca N velas antes de la señal (como el visor)
const GATE_TARGET = 50; // N de operaciones cerradas para la evaluación del gate (#7)
type ListFilter = 'open' | 'closed' | 'cancelled' | 'all';
type PaperView = 'resumen' | 'envivo' | 'historial';

/**
 * PESTAÑA PAPER (gate #7) — la ventana al forward-test. Tres sub-vistas:
 *  · Resumen   → ¿vamos rentables? capital simulado en $ + estadísticas (SIEMPRE visible).
 *  · En vivo   → la gráfica del par en tiempo real con el análisis y las entradas del bot.
 *  · Historial → tabla de cada operación; clic = replay vela a vela con su porqué causal.
 * Registro mecánico sin filtro humano. Observable, no operable (Regla Cero).
 */
export function PaperDashboard() {
  const [view, setView] = useState<PaperView>(() => {
    const s = localStorage.getItem('paper.view');
    return s === 'envivo' || s === 'historial' ? s : 'resumen';
  });
  useEffect(() => localStorage.setItem('paper.view', view), [view]);

  const [status, setStatus] = useState<PaperStatus | null>(null);
  const [trades, setTrades] = useState<PaperTrade[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [wsOn, setWsOn] = useState(false);
  const [listFilter, setListFilter] = useState<ListFilter>('all');
  const [symbolFilter, setSymbolFilter] = useState('ALL');
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [context, setContext] = useState<ReplayContextResponse | null>(null);
  const [windowStatus, setWindowStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [showObs, setShowObs] = useState(true);
  const [showLiq, setShowLiq] = useState(true);
  const [cursorIdx, setCursorIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4);
  const [capitalConfig, setCapitalConfig] = useState<CapitalConfig>(() => {
    try {
      const s = localStorage.getItem('paper.capital');
      if (s) return { ...DEFAULT_CAPITAL_CONFIG, ...(JSON.parse(s) as Partial<CapitalConfig>) };
    } catch {
      /* default */
    }
    return DEFAULT_CAPITAL_CONFIG;
  });
  const onCapitalConfig = useCallback((patch: Partial<CapitalConfig>) => {
    setCapitalConfig((c) => {
      const next = { ...c, ...patch };
      try {
        localStorage.setItem('paper.capital', JSON.stringify(next));
      } catch {
        /* sin persistencia */
      }
      return next;
    });
  }, []);

  const tfMs = tfToMs('15m');
  const tradesRef = useRef(trades);
  tradesRef.current = trades;
  const focusedRef = useRef(focusedId);
  focusedRef.current = focusedId;

  const upsertTrade = useCallback((row: PaperTrade) => {
    setTrades((prev) => {
      const i = prev.findIndex((t) => t.intentId === row.intentId);
      if (i < 0) return [row, ...prev];
      const next = [...prev];
      next[i] = row;
      return next;
    });
  }, []);

  // ── Carga inicial + WS en vivo ──
  useEffect(() => {
    fetchPaperStatus().then(setStatus).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    fetchPaperTrades()
      .then((res) => setTrades(res.trades))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));

    const client = new PaperClient();
    client.connect({
      onConnected: setWsOn,
      onPosition: (row) => {
        upsertTrade(row);
        if (focusedRef.current === row.intentId) {
          const t = tradesRef.current.find((x) => x.intentId === row.intentId) ?? row;
          void loadWindow({ ...t, ...row });
        }
      },
    });
    return () => client.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Ventana de velas + contexto SMC de la operación enfocada (Historial) ──
  const loadWindow = useCallback(
    async (t: PaperTrade) => {
      setWindowStatus('loading');
      setPlaying(false);
      try {
        const endRef = t.exitTime ?? Date.now();
        const to = endRef + POST_BARS * tfMs;
        const from = Math.max(t.signalBarTime - PRE_BARS * tfMs, to - 1499 * tfMs);
        const res = await fetchCandles(t.symbol, '15m' as Timeframe, 1500, { from, to });
        setCandles(res.candles);
        // El replay arranca unas velas ANTES de la señal (para ver formarse el barrido).
        const sigIdx = res.candles.findIndex((c) => c.openTime >= t.signalBarTime);
        setCursorIdx(Math.max((sigIdx < 0 ? res.candles.length - 1 : sigIdx) - CURSOR_BACK, 0));
        setWindowStatus('ready');
        fetchPaperContext(t.symbol, from, Math.min(to, Date.now()))
          .then(setContext)
          .catch(() => setContext(null));
      } catch {
        setWindowStatus('error');
      }
    },
    [tfMs],
  );

  const focusTrade = useCallback(
    (t: PaperTrade) => {
      setView('historial');
      setFocusedId(t.intentId);
      void loadWindow(t);
    },
    [loadWindow],
  );

  const backToList = () => {
    setFocusedId(null);
    setPlaying(false);
    setCandles([]);
    setContext(null);
    setWindowStatus('idle');
  };

  // Refresco suave de la gráfica de una posición VIVA enfocada.
  useEffect(() => {
    if (!focusedId) return;
    const t = setInterval(() => {
      const tr = tradesRef.current.find((x) => x.intentId === focusedRef.current);
      if (tr && tr.state !== 'CLOSED') void loadWindow(tr);
    }, 60_000);
    return () => clearInterval(t);
  }, [focusedId, loadWindow]);

  // ── Play del replay: avanza por velas cerradas a `speed` velas/s ──
  const maxIdx = Math.max(candles.length - 1, 0);
  useEffect(() => {
    if (!playing) return;
    const t = setInterval(() => {
      setCursorIdx((c) => {
        if (c >= maxIdx) {
          setPlaying(false);
          return c;
        }
        return c + 1;
      });
    }, 1000 / speed);
    return () => clearInterval(t);
  }, [playing, speed, maxIdx]);

  // ── Derivados ──
  const focused = trades.find((t) => t.intentId === focusedId) ?? null;
  const liveSymbols = useMemo(() => status?.symbols.map((s) => s.symbol) ?? [], [status]);
  const symbols = useMemo(() => ['ALL', ...new Set(trades.map((t) => t.symbol))], [trades]);
  const liveTrades = trades; // el backend solo persiste 'live' → historial siempre limpio

  const listed = useMemo(() => {
    let xs = liveTrades;
    if (symbolFilter !== 'ALL') xs = xs.filter((t) => t.symbol === symbolFilter);
    if (listFilter === 'open') xs = xs.filter((t) => t.state !== 'CLOSED');
    else if (listFilter === 'closed') xs = xs.filter((t) => t.state === 'CLOSED' && t.rMultiple != null);
    else if (listFilter === 'cancelled') xs = xs.filter((t) => t.state === 'CLOSED' && t.cancelReason != null);
    return [...xs].sort((a, b) => b.signalBarTime - a.signalBarTime);
  }, [liveTrades, listFilter, symbolFilter]);

  const metrics = useMemo(() => buildPaperMetrics(liveTrades), [liveTrades]);
  const capital = useMemo(() => computeCapital(liveTrades, capitalConfig), [liveTrades, capitalConfig]);
  const adaptedLive = useMemo(() => liveTrades.map(paperToSignal), [liveTrades]);
  const equity = useMemo(() => equityCurve(adaptedLive), [adaptedLive]);
  const bySymbol = useMemo(() => paperBySymbol(liveTrades), [liveTrades]);
  const pseudoRun = useMemo(() => {
    const times = liveTrades.map((t) => t.signalBarTime);
    return {
      id: 'paper',
      createdAt: 0,
      symbol: liveSymbols.length > 1 ? `${liveSymbols.length} símbolos` : (liveSymbols[0] ?? '—'),
      tf: '15m',
      fromTime: times.length ? Math.min(...times) : null,
      toTime: times.length ? Math.max(...times) : null,
      candleCount: 0,
      engineVersion: status?.engineVersion ?? '—',
      paramsHash: '',
      command: '',
      params: {},
      metrics,
      note: '',
      biasPoints: null,
    } as BacktestRunDetail;
  }, [liveTrades, metrics, status, liveSymbols]);

  // Señales del símbolo enfocado dentro de la ventana (Historial).
  const chartSignals = useMemo(() => {
    if (!focused || candles.length === 0) return [];
    const from = candles[0].openTime;
    const to = candles[candles.length - 1].openTime;
    return trades
      .filter((t) => t.symbol === focused.symbol && t.signalBarTime >= from && t.signalBarTime <= to)
      .map(paperToSignal);
  }, [trades, focused, candles]);

  const fmtR = (r: number | null | undefined) => (r == null ? '—' : `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`);
  const rClass = (r: number | null | undefined) => (r == null ? '' : r > 0.05 ? 'r-pos' : r < -0.05 ? 'r-neg' : 'r-zero');
  // Resultado legible de una operación (para la tabla y el chip de estado).
  const outcomeText = (t: PaperTrade) =>
    t.state === 'PENDING'
      ? 'pendiente'
      : t.state === 'FILLED'
        ? 'EN POSICIÓN'
        : t.cancelReason
          ? `✕ ${t.cancelReason}`
          : (t.exitReason ?? '—');

  // ── Barra superior: estado del gate + sub-pestañas ──
  const subtabs: { id: PaperView; label: string; sub: string }[] = [
    { id: 'resumen', label: 'Resumen', sub: '¿vamos rentables?' },
    { id: 'envivo', label: 'En vivo', sub: 'gráfica + análisis' },
    { id: 'historial', label: 'Historial', sub: `${liveTrades.length} operaciones` },
  ];
  const topBarContent = (
    <>
      <div className="pp-subtabs">
        {subtabs.map((t) => (
          <button key={t.id} className={view === t.id ? 'on' : ''} onClick={() => setView(t.id)}>
            <span className="pp-st-label">{t.label}</span>
            <span className="pp-st-sub">{t.sub}</span>
          </button>
        ))}
      </div>
      <span className={`pp-ws ${wsOn ? 'on' : ''}`} title="Conexión al stream /paper">
        {wsOn ? '● EN VIVO' : '○ sin stream'}
      </span>
      {status && (
        <span className="rt-meta" title={status.symbols.map((s) => `${s.symbol} ${s.paramsHash}`).join('\n')}>
          engine <code>{status.engineVersion}</code> ·{' '}
          {status.clockStart ? `reloj ▶ ${formatUtc(status.clockStart).slice(0, 10)}` : 'reloj ⏸'}
        </span>
      )}
    </>
  );
  const topBar = <div className="pp-topbar">{topBarContent}</div>;

  // ── Banner del gate (Resumen) ──
  const gateBanner = (
    <div className="pp-gate">
      <div className="pp-gate-row">
        <span className="pp-gate-title">Gate #7 · forward-test en vivo (Regla Cero — no opera)</span>
        <span className="pp-gate-clock">
          {status?.clockStart ? `reloj ▶ ${formatUtc(status.clockStart).slice(0, 16)} UTC` : 'reloj ⏸ sin arrancar'}
        </span>
      </div>
      <div className="pp-gate-prog">
        <div className="pp-gate-bar">
          <div className="pp-gate-fill" style={{ width: `${Math.min(100, (metrics.trades / GATE_TARGET) * 100)}%` }} />
        </div>
        <span className="pp-gate-n">
          <b>{metrics.trades}</b>/{GATE_TARGET} operaciones cerradas hacia la evaluación
        </span>
      </div>
      {metrics.trades < GATE_TARGET && (
        <p className="pp-gate-note">
          {metrics.trades === 0
            ? 'Aún sin operaciones cerradas. El candidato genera señales al cierre de cada vela 15m y son poco frecuentes; las primeras tardan días.'
            : `Con ${metrics.trades} operaciones el resultado es RUIDO, no veredicto: la banda de incertidumbre es enorme a esta N. El gate se evalúa a N≥${GATE_TARGET} (paridad sim↔live + no-colapso). Hasta entonces, esto NO confirma rentabilidad.`}
        </p>
      )}
    </div>
  );

  const bottomChips = (
    <div className="pp-bottom">
      {status?.symbols.map((s) => (
        <span key={s.symbol} className="pp-chip" title={`paramsHash ${s.paramsHash}`}>
          {s.symbol.replace('USDT', '')} <b>{s.open}</b> vivas · {formatUtc(s.cursor).slice(11, 16)}
        </span>
      ))}
    </div>
  );

  // ── Inspector de la operación enfocada (Historial, derecha) ──
  const histInspector = focused && (
    <div className="replay-inspector">
      <button className="ph-back" onClick={backToList}>← volver al historial</button>
      <div className="ri-head">
        <b className={focused.direction === 'LONG' ? 'long' : 'short'}>{focused.direction}</b>
        <span className="ri-phase">{focused.state}</span>
        <span className="ri-out">{focused.symbol}</span>
      </div>

      <div className="ri-levels">
        {focused.state === 'CLOSED' && focused.rMultiple != null ? (
          <>
            <div className="ri-flow">
              <div>
                <span className="lv-label">ENTRADA</span>
                <span className="lv-price">{focused.entryPrice}</span>
                <span className="lv-sub">límite {focused.entry}</span>
              </div>
              <span className="lv-arrow">→</span>
              <div>
                <span className="lv-label">SALIDA ({focused.exitReason})</span>
                <span className="lv-price">{focused.exitPrice}</span>
                <span className="lv-sub">{focused.exitTime != null ? formatUtc(focused.exitTime).slice(2, 16) : ''}</span>
              </div>
            </div>
            <div className={`ri-rnet ${rClass(focused.rMultiple)}`}>{fmtR(focused.rMultiple)}</div>
            <div className={`ri-usd ${rClass(focused.rMultiple)}`}>
              {formatUsd(focused.rMultiple * capital.riskPerTrade, true)}
              <span className="ri-usd-sub"> · riesgo {formatUsd(capital.riskPerTrade)}/op</span>
            </div>
            <div className="ri-rbreak">bruto {fmtR(focused.grossR)} · comisiones+slip −{(focused.costR ?? 0).toFixed(2)}R</div>
          </>
        ) : (
          <div className="ri-flow">
            <div>
              <span className="lv-label">{focused.state === 'FILLED' ? 'EN POSICIÓN desde' : 'LÍMITE programado'}</span>
              <span className="lv-price">{focused.state === 'FILLED' ? focused.entryPrice : focused.entry}</span>
              <span className="lv-sub">{focused.state === 'FILLED' && focused.entryTime ? formatUtc(focused.entryTime).slice(2, 16) : focused.cancelReason ?? ''}</span>
            </div>
          </div>
        )}
        <div className="ri-grid">
          <div><span className="lv-label">SL</span><span className="lv-val sl">{focused.stopLoss}</span></div>
          <div><span className="lv-label">TP{focused.tpSource ? ` (${focused.tpSource})` : ''}</span><span className="lv-val tp">{focused.takeProfit}</span></div>
          <div><span className="lv-label">riesgo</span><span className="lv-val">{Math.abs(focused.entry - focused.stopLoss).toFixed(4)}</span></div>
          <div><span className="lv-label">BE</span><span className="lv-val">{focused.movedToBE ? 'armado' : 'no'}</span></div>
        </div>
      </div>

      <h4>Porqué causal</h4>
      <table className="ri-table">
        <tbody>
          <tr><td>señal (cierre de vela)</td><td>{formatUtc(focused.signalBarTime)}</td></tr>
          {focused.sweptSwingTime != null && <tr><td>swing barrido (origen)</td><td>{formatUtc(focused.sweptSwingTime)}</td></tr>}
          {focused.sweptLevel != null && <tr><td>liquidez barrida</td><td>{focused.sweptLevel}</td></tr>}
          <tr><td>zona de reacción</td><td>{focused.zoneLow} ↔ {focused.zoneHigh}</td></tr>
          {focused.cancelBeyond != null && <tr><td>cancelBeyond</td><td>{focused.cancelBeyond}</td></tr>}
        </tbody>
      </table>

      <h4>Ejecución (touched-vs-crossed)</h4>
      <table className="ri-table">
        <tbody>
          <tr><td>penetración del fill</td><td>{focused.entryPenetration != null ? `cruzó +${focused.entryPenetration}` : '—'}</td></tr>
          <tr><td>penetración del TP</td><td>{focused.tpPenetration != null ? `cruzó +${focused.tpPenetration}` : '—'}</td></tr>
          <tr><td>velas hasta fill / dentro</td><td>{focused.barsToFill ?? '—'} / {focused.barsHeld ?? '—'}</td></tr>
        </tbody>
      </table>

      <h4>Trazabilidad</h4>
      <table className="ri-table">
        <tbody>
          <tr><td>paramsHash</td><td><code>{focused.paramsHash}</code></td></tr>
          <tr><td>engine</td><td><code>{focused.engineVersion}</code></td></tr>
        </tbody>
      </table>
    </div>
  );

  // ── ERROR ──
  if (error) {
    return (
      <AppShell
        topBar={topBar}
        left={null}
        center={
          <div className="state state-error">
            <p>Error del paper</p>
            <code>{error}</code>
            <p className="hint">¿Backend con DB_ENABLED=true y PAPER_TRADING=true?</p>
          </div>
        }
        right={null}
        bottom={bottomChips}
        leftOpen={false}
        rightOpen={false}
        bottomOpen={true}
      />
    );
  }

  // ── RESUMEN ──
  if (view === 'resumen') {
    return (
      <AppShell
        topBar={topBar}
        left={null}
        center={
          <div className="rs-scroll">
            <div className="pp-resumen">
              {gateBanner}
              <CapitalPanel summary={capital} onConfig={onCapitalConfig} />
              <RunStats
                run={pseudoRun}
                signals={adaptedLive}
                equity={equity}
                mode="paper"
                bySymbol={bySymbol}
                onPickTrade={(intentId) => {
                  const t = trades.find((x) => x.intentId === intentId);
                  if (t) focusTrade(t);
                }}
              />
            </div>
          </div>
        }
        right={null}
        bottom={bottomChips}
        leftOpen={false}
        rightOpen={false}
        bottomOpen={true}
      />
    );
  }

  // ── EN VIVO ──
  if (view === 'envivo') {
    return (
      <AppShell
        topBar={topBar}
        left={null}
        center={<PaperLive symbols={liveSymbols} trades={trades} />}
        right={null}
        bottom={bottomChips}
        leftOpen={false}
        rightOpen={false}
        bottomOpen={true}
      />
    );
  }

  // ── HISTORIAL ──
  // Sin operación enfocada: TABLA ancha y legible (sin scroll horizontal).
  if (!focused) {
    const histTable = (
      <div className="ph-wrap">
        <div className="ph-filters">
          <select value={listFilter} onChange={(e) => setListFilter(e.target.value as ListFilter)}>
            <option value="all">Todas ({liveTrades.length})</option>
            <option value="closed">Cerradas ({liveTrades.filter((t) => t.state === 'CLOSED' && t.rMultiple != null).length})</option>
            <option value="open">Vivas ({liveTrades.filter((t) => t.state !== 'CLOSED').length})</option>
            <option value="cancelled">Canceladas ({liveTrades.filter((t) => t.state === 'CLOSED' && t.cancelReason != null).length})</option>
          </select>
          <select value={symbolFilter} onChange={(e) => setSymbolFilter(e.target.value)}>
            {symbols.map((s) => (
              <option key={s} value={s}>{s === 'ALL' ? 'Todos los pares' : s.replace('USDT', '')}</option>
            ))}
          </select>
          <span className="ph-count">{listed.length} operaciones · clic para el replay</span>
        </div>
        {listed.length === 0 ? (
          <div className="state pp-waiting">
            <div className="pp-waiting-icon">📜</div>
            <p className="pp-waiting-title">Sin operaciones todavía</p>
            <p className="pp-waiting-sub">Cuando el candidato genere su primera señal, aparecerá aquí. El resumen y el capital están en la pestaña Resumen.</p>
          </div>
        ) : (
          <div className="ph-tablewrap">
            <table className="ph-table">
              <thead>
                <tr>
                  <th>Par</th>
                  <th>Dir</th>
                  <th>Fecha (UTC)</th>
                  <th>Resultado</th>
                  <th className="ph-num">R</th>
                  <th className="ph-num">$</th>
                </tr>
              </thead>
              <tbody>
                {listed.slice(0, 600).map((t) => {
                  const closed = t.state === 'CLOSED' && t.rMultiple != null;
                  const cancelled = t.state === 'CLOSED' && t.cancelReason != null;
                  return (
                    <tr key={t.intentId} onClick={() => focusTrade(t)}>
                      <td className="ph-sym">{t.symbol.replace('USDT', '')}</td>
                      <td className={t.direction === 'LONG' ? 'long' : 'short'}>{t.direction === 'LONG' ? '▲ LONG' : '▼ SHORT'}</td>
                      <td className="ph-date">{formatUtc(t.signalBarTime).slice(0, 16).replace('T', ' ')}</td>
                      <td className={`ph-out ${closed ? rClass(t.rMultiple) : t.state === 'FILLED' ? 'pp-live' : cancelled ? 'r-zero' : ''}`}>{outcomeText(t)}</td>
                      <td className={`ph-num ${rClass(t.rMultiple)}`}>{closed ? fmtR(t.rMultiple) : '—'}</td>
                      <td className={`ph-num ${rClass(t.rMultiple)}`}>{closed ? formatUsd((t.rMultiple as number) * capital.riskPerTrade, true) : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    );
    return (
      <AppShell
        topBar={topBar}
        left={null}
        center={histTable}
        right={null}
        bottom={bottomChips}
        leftOpen={false}
        rightOpen={false}
        bottomOpen={true}
      />
    );
  }

  // Operación enfocada: REPLAY vela a vela (gráfica + controles) + inspector.
  const cursorTime = candles.length > 0 ? candles[Math.min(cursorIdx, maxIdx)].openTime : null;
  const replayBias = focused.direction === 'LONG' ? 'bullish' : 'bearish';
  let histCenter: React.ReactNode;
  if (windowStatus === 'loading') {
    histCenter = <div className="state state-loading">Cargando ventana de velas…</div>;
  } else if (windowStatus === 'error') {
    histCenter = <div className="state state-error">No se pudo cargar la ventana de velas.</div>;
  } else {
    histCenter = (
      <div className="replay-center">
        <ReplayChart
          candles={candles}
          cursorIdx={cursorIdx}
          tfMs={tfMs}
          signals={chartSignals}
          focused={paperToSignal(focused)}
          context={context}
          showObs={showObs}
          showLiq={showLiq}
        />
      </div>
    );
  }

  return (
    <AppShell
      topBar={
        <div className="pp-topbar">
          {topBarContent}
          <label className="rt-toggle"><input type="checkbox" checked={showObs} onChange={() => setShowObs((v) => !v)} /> OBs</label>
          <label className="rt-toggle"><input type="checkbox" checked={showLiq} onChange={() => setShowLiq((v) => !v)} /> liquidez</label>
        </div>
      }
      left={null}
      center={histCenter}
      right={histInspector}
      bottom={
        <div className="replay-bottom">
          <ReplayControls
            cursorIdx={cursorIdx}
            maxIdx={maxIdx}
            cursorTime={cursorTime}
            playing={playing}
            speed={speed}
            bias={replayBias}
            onSeek={(i) => setCursorIdx(i)}
            onStep={(d) => setCursorIdx((c) => Math.min(Math.max(c + d, 0), maxIdx))}
            onPlayPause={() => setPlaying((p) => !p)}
            onSpeed={setSpeed}
          />
        </div>
      }
      leftOpen={false}
      rightOpen={true}
      bottomOpen={true}
    />
  );
}
