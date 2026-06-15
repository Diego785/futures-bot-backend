import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppShell } from '../components/layout/AppShell';
import { ReplayChart } from '../components/replay/ReplayChart';
import { RunStats } from '../components/replay/RunStats';
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
type ListFilter = 'open' | 'closed' | 'cancelled' | 'all';

/**
 * PESTAÑA PAPER (P.3) — la ventana al gate #7: qué está HACIENDO el candidato congelado en vivo.
 * Registro mecánico sin filtro humano (PAPER-TEST-SPEC §4): estadísticas en vivo, historial
 * completo y cada posición sobre la gráfica con su porqué causal. REUSA la capa visual del visor
 * de backtests (misma causalidad, mismos componentes). Observable, no operable (Regla Cero).
 */
export function PaperDashboard() {
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
        // Si el cambio afecta a la posición enfocada, refrescar su ventana de velas.
        if (focusedRef.current === row.intentId) {
          const t = tradesRef.current.find((x) => x.intentId === row.intentId) ?? row;
          void loadWindow({ ...t, ...row });
        }
      },
    });
    return () => client.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Ventana de velas + contexto SMC de la posición enfocada ──
  const loadWindow = useCallback(
    async (t: PaperTrade) => {
      setWindowStatus('loading');
      try {
        const endRef = t.exitTime ?? Date.now();
        const to = endRef + POST_BARS * tfMs;
        const from = Math.max(t.signalBarTime - PRE_BARS * tfMs, to - 1499 * tfMs);
        const res = await fetchCandles(t.symbol, '15m' as Timeframe, 1500, { from, to });
        setCandles(res.candles);
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
      setFocusedId(t.intentId);
      void loadWindow(t);
    },
    [loadWindow],
  );

  // Refresco suave de la gráfica de una posición VIVA (la vela nueva aparece sin eventos).
  useEffect(() => {
    if (!focusedId) return;
    const t = setInterval(() => {
      const tr = tradesRef.current.find((x) => x.intentId === focusedRef.current);
      if (tr && tr.state !== 'CLOSED') void loadWindow(tr);
    }, 60_000);
    return () => clearInterval(t);
  }, [focusedId, loadWindow]);

  const showStats = () => {
    setFocusedId(null);
    setCandles([]);
    setContext(null);
    setWindowStatus('idle');
  };

  // ── Derivados ──
  const focused = trades.find((t) => t.intentId === focusedId) ?? null;
  const symbols = useMemo(() => ['ALL', ...new Set(trades.map((t) => t.symbol))], [trades]);

  // El backend SOLO persiste operaciones 'live' (el forward-test real); el histórico rehidratado
  // nunca se guarda. Así el historial del paper está siempre limpio: solo las nuevas operaciones.
  const liveTrades = trades; // (defensivo: ya vienen todas live del API)
  const capital = useMemo(() => computeCapital(liveTrades, capitalConfig), [liveTrades, capitalConfig]);
  const listed = useMemo(() => {
    let xs = liveTrades;
    if (symbolFilter !== 'ALL') xs = xs.filter((t) => t.symbol === symbolFilter);
    if (listFilter === 'open') xs = xs.filter((t) => t.state !== 'CLOSED');
    else if (listFilter === 'closed') xs = xs.filter((t) => t.state === 'CLOSED' && t.rMultiple != null);
    else if (listFilter === 'cancelled') xs = xs.filter((t) => t.state === 'CLOSED' && t.cancelReason != null);
    return [...xs].sort((a, b) => b.signalBarTime - a.signalBarTime);
  }, [liveTrades, listFilter, symbolFilter]);

  const metrics = useMemo(() => buildPaperMetrics(liveTrades), [liveTrades]);
  const adaptedLive = useMemo(() => liveTrades.map(paperToSignal), [liveTrades]);
  const equity = useMemo(() => equityCurve(adaptedLive), [adaptedLive]);
  const bySymbol = useMemo(() => paperBySymbol(liveTrades), [liveTrades]);
  const pseudoRun = useMemo(() => {
    const times = liveTrades.map((t) => t.signalBarTime);
    return {
      id: 'paper',
      createdAt: 0,
      symbol: symbols.length > 2 ? `${symbols.length - 1} símbolos` : (symbols[1] ?? '—'),
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
  }, [liveTrades, metrics, status, symbols]);

  // Señales del símbolo enfocado dentro de la ventana (la capa de marcadores de la gráfica).
  const chartSignals = useMemo(() => {
    if (!focused || candles.length === 0) return [];
    const from = candles[0].openTime;
    const to = candles[candles.length - 1].openTime;
    return trades
      .filter((t) => t.symbol === focused.symbol && t.signalBarTime >= from && t.signalBarTime <= to)
      .map(paperToSignal);
  }, [trades, focused, candles]);

  const fmtR = (r: number | null | undefined) => (r == null ? '—' : `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`);
  const rClass = (r: number | null) => (r == null ? '' : r > 0.05 ? 'r-pos' : r < -0.05 ? 'r-neg' : 'r-zero');
  const stateLabel = (t: PaperTrade) =>
    t.state === 'PENDING' ? 'pendiente' : t.state === 'FILLED' ? 'EN POSICIÓN' : t.cancelReason ? `✕ ${t.cancelReason}` : `${t.exitReason} ${fmtR(t.rMultiple)}`;

  // ── Render ──
  const topBar = (
    <div className="replay-topbar">
      <span className="rt-title">Paper-test (gate #7)</span>
      <span className={`pp-ws ${wsOn ? 'on' : ''}`} title="Conexión al stream /paper">{wsOn ? '● EN VIVO' : '○ sin stream'}</span>
      {status && (
        <span className="rt-meta" title={status.symbols.map((s) => `${s.symbol} ${s.paramsHash}`).join('\n')}>
          engine <code>{status.engineVersion}</code> · {status.symbols.length} símbolos ·{' '}
          {status.clockStart
            ? `reloj ▶ ${formatUtc(status.clockStart).slice(0, 10)} · ${liveTrades.length} en vivo`
            : 'reloj ⏸ sin arrancar'}
        </span>
      )}
      <button className="rt-stats-btn" onClick={showStats} title="Estadísticas en vivo del paper">📊 estadísticas</button>
      <label className="rt-toggle"><input type="checkbox" checked={showObs} onChange={() => setShowObs((v) => !v)} /> OBs</label>
      <label className="rt-toggle"><input type="checkbox" checked={showLiq} onChange={() => setShowLiq((v) => !v)} /> liquidez</label>
    </div>
  );

  const left = (
    <div className="replay-list">
      <div className="rl-header">
        <select value={listFilter} onChange={(e) => setListFilter(e.target.value as ListFilter)}>
          <option value="all">Todas ({liveTrades.length})</option>
          <option value="open">Vivas ({liveTrades.filter((t) => t.state !== 'CLOSED').length})</option>
          <option value="closed">Cerradas ({liveTrades.filter((t) => t.state === 'CLOSED' && t.rMultiple != null).length})</option>
          <option value="cancelled">Canceladas ({liveTrades.filter((t) => t.state === 'CLOSED' && t.cancelReason != null).length})</option>
        </select>
        <select value={symbolFilter} onChange={(e) => setSymbolFilter(e.target.value)}>
          {symbols.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
      </div>
      <ul>
        {listed.slice(0, 600).map((t) => (
          <li
            key={t.intentId}
            className={`rl-item ${t.intentId === focusedId ? 'selected' : ''}`}
            onClick={() => focusTrade(t)}
          >
            <span className="rl-sym">{t.symbol.replace('USDT', '')}</span>
            <span className={`rl-dir ${t.direction === 'LONG' ? 'long' : 'short'}`}>{t.direction === 'LONG' ? '▲' : '▼'}</span>
            <span className="rl-date">{formatUtc(t.signalBarTime).slice(2, 16)}</span>
            <span className={`rl-out ${t.state === 'CLOSED' && t.rMultiple != null ? rClass(t.rMultiple) : t.state === 'FILLED' ? 'pp-live' : ''}`}>
              {stateLabel(t)}
            </span>
            {t.state === 'CLOSED' && t.rMultiple != null && (
              <span className={`rl-usd ${rClass(t.rMultiple)}`}>{formatUsd(t.rMultiple * capital.riskPerTrade, true)}</span>
            )}
          </li>
        ))}
        {listed.length === 0 && (
          <li className="rl-more">sin operaciones del forward-test aún — el motor registra al cierre de cada vela 15m</li>
        )}
      </ul>
    </div>
  );

  let center: React.ReactNode;
  if (error) {
    center = (
      <div className="state state-error">
        <p>Error del paper</p>
        <code>{error}</code>
        <p className="hint">¿Backend con DB_ENABLED=true y PAPER_TRADING=true?</p>
      </div>
    );
  } else if (!focused || windowStatus === 'idle') {
    center =
      liveTrades.length === 0 ? (
        <div className="state pp-waiting">
          <div className="pp-waiting-icon">⏳</div>
          <p className="pp-waiting-title">El forward-test aún no tiene operaciones</p>
          <p className="pp-waiting-sub">
            {status?.clockStart
              ? `El reloj del gate arrancó el ${formatUtc(status.clockStart).slice(0, 16)}. Aquí aparecerán SOLO las operaciones nuevas a medida que el candidato genere señales. El pasado se audita en la pestaña Backtests.`
              : 'El reloj del gate aún no arranca (PAPER_CLOCK_START sin fijar). El historial empezará limpio en cuanto lo enciendas en el deploy.'}
          </p>
        </div>
      ) : (
        <div className="rs-scroll">
          <CapitalPanel summary={capital} onConfig={onCapitalConfig} />
          <RunStats run={pseudoRun} signals={adaptedLive} equity={equity} mode="paper" bySymbol={bySymbol}
            onPickTrade={(intentId) => {
              const t = trades.find((x) => x.intentId === intentId);
              if (t) focusTrade(t);
            }}
          />
        </div>
      );
  } else if (windowStatus === 'loading') {
    center = <div className="state state-loading">Cargando ventana de velas…</div>;
  } else if (windowStatus === 'error') {
    center = <div className="state state-error">No se pudo cargar la ventana de velas.</div>;
  } else {
    center = (
      <div className="replay-center">
        <ReplayChart
          candles={candles}
          cursorIdx={candles.length - 1} // el cursor del paper ES el presente
          tfMs={tfMs}
          signals={chartSignals}
          focused={focused ? paperToSignal(focused) : null}
          context={context}
          showObs={showObs}
          showLiq={showLiq}
        />
      </div>
    );
  }

  const right = (
    <div className="replay-inspector">
      {!focused ? (
        <p className="ri-empty">Sin posición enfocada — elige una de la lista o haz click en la equity.</p>
      ) : (
        <>
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
              <tr><td>registrado</td><td>{formatUtc(focused.createdAt)}</td></tr>
            </tbody>
          </table>
        </>
      )}
    </div>
  );

  const bottom = (
    <div className="pp-bottom">
      {status?.symbols.map((s) => (
        <span key={s.symbol} className="pp-chip" title={`paramsHash ${s.paramsHash}`}>
          {s.symbol.replace('USDT', '')} <b>{s.open}</b> vivas · {formatUtc(s.cursor).slice(11, 16)}
        </span>
      ))}
    </div>
  );

  return <AppShell topBar={topBar} left={left} center={center} right={right} bottom={bottom} leftOpen={true} rightOpen={true} bottomOpen={true} />;
}
