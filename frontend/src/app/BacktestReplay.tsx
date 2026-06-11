import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppShell } from '../components/layout/AppShell';
import { ReplayChart } from '../components/replay/ReplayChart';
import { ReplayControls } from '../components/replay/ReplayControls';
import { EquitySparkline } from '../components/replay/EquitySparkline';
import { fetchBacktestRuns, fetchBacktestRun } from '../features/backtest-viewer/backtestRuns.api';
import { fetchReplayContext } from '../features/backtest-viewer/backtestContext.api';
import type { ReplayContextResponse } from '../features/backtest-viewer/backtestContext.types';
import {
  biasAtTime,
  equityCurve,
  signalPhaseAt,
  simAssumptions,
  type BacktestRunDetail,
  type BacktestRunSummary,
  type BacktestSignal,
} from '../features/backtest-viewer/backtestRuns.types';
import { fetchCandles } from '../features/candles/candles.api';
import type { Candle, Timeframe } from '../features/candles/candles.types';
import { formatUtc, tfToMs } from '../lib/time';

const PRE_BARS = 300; // contexto antes de la señal (los detectores "ven" esta historia)
const POST_BARS = 100; // cola tras la salida
const CURSOR_BACK = 30; // el replay arranca N velas antes de la señal

type ListFilter = 'filled' | 'cancelled' | 'rejected' | 'all';
type Verdict = 'valida' | 'dudosa' | 'error';
interface VerdictEntry {
  verdict: Verdict;
  note: string;
}

const verdictKey = (runId: string) => `bt-verdicts:${runId}`;

function loadVerdicts(runId: string): Record<string, VerdictEntry> {
  try {
    return JSON.parse(localStorage.getItem(verdictKey(runId)) ?? '{}') as Record<string, VerdictEntry>;
  } catch {
    return {};
  }
}

/**
 * VISOR DE BACKTESTS (V.2) — replay causal de una corrida registrada, trade a trade.
 * Flujo de auditoría: elegir corrida → elegir señal → ver la película (velas cerradas, cursor)
 * → veredicto del usuario (válida/dudosa/error + nota, en localStorage por corrida).
 */
export function BacktestReplay() {
  const [runs, setRuns] = useState<BacktestRunSummary[]>([]);
  const [runsError, setRunsError] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<BacktestRunDetail | null>(null);
  const [signals, setSignals] = useState<BacktestSignal[]>([]);
  const [listFilter, setListFilter] = useState<ListFilter>('filled');
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [windowStatus, setWindowStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [cursorIdx, setCursorIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(4);
  const [showCancelled, setShowCancelled] = useState(true);
  const [showRejected, setShowRejected] = useState(false);
  const [showObs, setShowObs] = useState(true);
  const [showLiq, setShowLiq] = useState(true);
  const [exitFilter, setExitFilter] = useState<'all' | 'TP' | 'SL' | 'BE'>('all');
  const [context, setContext] = useState<ReplayContextResponse | null>(null);
  const [verdicts, setVerdicts] = useState<Record<string, VerdictEntry>>({});

  // ── Corridas registradas ──
  useEffect(() => {
    fetchBacktestRuns()
      .then((res) => {
        setRuns(res.runs);
        if (res.runs.length > 0) setRunId((cur) => cur ?? res.runs[0].id);
      })
      .catch((e: unknown) => setRunsError(e instanceof Error ? e.message : String(e)));
  }, []);

  // ── Detalle de la corrida (señales + bias congelado) ──
  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    setRun(null);
    setSignals([]);
    setFocusedId(null);
    setCandles([]);
    setWindowStatus('idle');
    setPlaying(false);
    setVerdicts(loadVerdicts(runId));
    fetchBacktestRun(runId)
      .then((res) => {
        if (cancelled) return;
        setRun(res.run);
        setSignals(res.signals);
      })
      .catch((e: unknown) => {
        if (!cancelled) setRunsError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [runId]);

  const tfMs = run ? tfToMs(run.tf) : tfToMs('15m');
  const focused = useMemo(
    () => signals.find((s) => s.intentId === focusedId) ?? null,
    [signals, focusedId],
  );

  // ── Lista filtrada (la navegación de la auditoría) ──
  const listed = useMemo(() => {
    let byFilter = listFilter === 'all' ? signals : signals.filter((s) => s.outcome === listFilter);
    if (listFilter === 'filled' && exitFilter !== 'all') {
      byFilter = byFilter.filter((s) => s.exitReason === exitFilter);
    }
    return byFilter; // ya viene ordenada por signalBarTime
  }, [signals, listFilter, exitFilter]);

  // Embudo de la corrida (los conteos que explican POR QUÉ hay las señales que hay).
  const funnel = useMemo(() => {
    const byReason: Record<string, number> = {};
    let rejected = 0;
    for (const s of signals) {
      if (s.outcome === 'rejected') {
        rejected++;
        byReason[s.reason ?? '?'] = (byReason[s.reason ?? '?'] ?? 0) + 1;
      }
    }
    return { rejected, byReason };
  }, [signals]);

  // ── Ventana de velas alrededor de la señal enfocada ──
  const focusSignal = useCallback(
    (s: BacktestSignal) => {
      if (!run) return;
      setFocusedId(s.intentId);
      setPlaying(false);
      setWindowStatus('loading');
      const endRef = s.exitTime ?? s.endTime ?? s.signalBarTime;
      const to = endRef + POST_BARS * tfMs;
      // El API limita a 1500 velas por petición: si el trade vivió mucho (p.ej. cancelada lejana),
      // se recorta el contexto PREVIO antes que el desenlace (la salida siempre debe verse).
      const from = Math.max(s.signalBarTime - PRE_BARS * tfMs, to - 1499 * tfMs);
      fetchCandles(run.symbol, run.tf as Timeframe, 1500, { from, to })
        .then((res) => {
          setCandles(res.candles);
          const sigIdx = res.candles.findIndex((c) => c.openTime >= s.signalBarTime);
          setCursorIdx(Math.max((sigIdx < 0 ? res.candles.length - 1 : sigIdx) - CURSOR_BACK, 0));
          setWindowStatus('ready');
        })
        .catch(() => setWindowStatus('error'));
      // Contexto SMC causal de la ventana (OBs + liquidez): no bloquea el replay si falla.
      setContext(null);
      fetchReplayContext(run.id, from, to)
        .then(setContext)
        .catch(() => setContext(null));
    },
    [run, tfMs],
  );

  // prev/next sobre la lista filtrada.
  const focusedListIdx = listed.findIndex((s) => s.intentId === focusedId);
  const focusNeighbor = (delta: number) => {
    const i = focusedListIdx < 0 ? 0 : focusedListIdx + delta;
    if (i >= 0 && i < listed.length) focusSignal(listed[i]);
  };

  // ── Play: avanza por velas cerradas a `speed` velas/s ──
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

  // ── Señales visibles en el chart (dentro de la ventana; la enfocada siempre) ──
  const windowFrom = candles.length > 0 ? candles[0].openTime : 0;
  const windowTo = candles.length > 0 ? candles[candles.length - 1].openTime : 0;
  const chartSignals = useMemo(() => {
    if (candles.length === 0) return [];
    return signals.filter((s) => {
      if (s.intentId === focusedId) return true;
      if (s.signalBarTime < windowFrom || s.signalBarTime > windowTo) return false;
      if (s.outcome === 'filled') return true;
      if (s.outcome === 'cancelled' || s.outcome === 'expired') return showCancelled;
      return showRejected;
    });
  }, [signals, candles.length, windowFrom, windowTo, focusedId, showCancelled, showRejected]);

  const cursorOpen = candles.length > 0 ? candles[Math.min(cursorIdx, maxIdx)].openTime : null;
  const bias = run && cursorOpen != null ? biasAtTime(run.biasPoints, cursorOpen + tfMs - 1) : 'neutral';
  const phase = focused && cursorOpen != null ? signalPhaseAt(focused, cursorOpen, tfMs) : null;
  const equity = useMemo(() => equityCurve(signals), [signals]);

  // ── Veredicto del auditor (localStorage por corrida) ──
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const setVerdict = (v: Verdict) => {
    if (!runId || !focused) return;
    const next = {
      ...verdicts,
      [focused.intentId]: { verdict: v, note: noteRef.current?.value ?? '' },
    };
    setVerdicts(next);
    localStorage.setItem(verdictKey(runId), JSON.stringify(next));
  };
  const audited = Object.keys(verdicts).length;
  const focusedVerdict = focused ? verdicts[focused.intentId] : undefined;

  // ── Render ──
  const fmtR = (r: number | null | undefined) =>
    r == null ? '—' : `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`;

  const topBar = (
    <div className="replay-topbar">
      <span className="rt-title">Visor de backtests</span>
      <select className="rt-run" value={runId ?? ''} onChange={(e) => setRunId(e.target.value)}>
        {runs.map((r) => (
          <option key={r.id} value={r.id}>
            {r.symbol} {r.tf} · {fmtR(r.metrics.expectancyR)} · N={r.metrics.trades} · {r.id}
          </option>
        ))}
      </select>
      {run && (
        <span className="rt-meta" title={run.command}>
          paramsHash <code>{run.paramsHash}</code> · engine <code>{run.engineVersion}</code> · {run.candleCount} velas (
          {run.fromTime ? formatUtc(run.fromTime).slice(0, 10) : '—'} → {run.toTime ? formatUtc(run.toTime).slice(0, 10) : '—'})
        </span>
      )}
      {run && (
        <span
          className="rt-funnel"
          title={`El EMBUDO de la corrida: de cada sweep detectado a trade real.\nDescartes: ${Object.entries(funnel.byReason)
            .map(([k, v]) => `${k} ${v}`)
            .join(' · ')}`}
        >
          {run.metrics.signals} señales → {run.metrics.trades} trades · {run.metrics.cancelled} cancel ·{' '}
          {funnel.rejected} descartes
        </span>
      )}
      <label className="rt-toggle" title="Order Blocks re-derivados causalmente (contexto)">
        <input type="checkbox" checked={showObs} onChange={() => setShowObs((v) => !v)} /> OBs
      </label>
      <label className="rt-toggle" title="Niveles de liquidez (equal highs/lows y swings) con su barrido">
        <input type="checkbox" checked={showLiq} onChange={() => setShowLiq((v) => !v)} /> liquidez
      </label>
      <label className="rt-toggle">
        <input type="checkbox" checked={showCancelled} onChange={() => setShowCancelled((v) => !v)} /> canceladas
      </label>
      <label className="rt-toggle" title="Sweeps descartados por los filtros (minStop/htfBias/minRr) en la ventana visible">
        <input type="checkbox" checked={showRejected} onChange={() => setShowRejected((v) => !v)} /> descartes
      </label>
    </div>
  );

  const LIST_CAP = 600;
  const rClass = (r: number | null) => (r == null ? '' : r > 0.05 ? 'r-pos' : r < -0.05 ? 'r-neg' : 'r-zero');
  const left = (
    <div className="replay-list">
      <div className="rl-header">
        <select value={listFilter} onChange={(e) => setListFilter(e.target.value as ListFilter)}>
          <option value="filled">Trades ({signals.filter((s) => s.outcome === 'filled').length})</option>
          <option value="cancelled">Canceladas ({signals.filter((s) => s.outcome === 'cancelled').length})</option>
          <option value="rejected">Descartadas ({signals.filter((s) => s.outcome === 'rejected').length})</option>
          <option value="all">Todas ({signals.length})</option>
        </select>
        <span className="rl-audited" title="Señales con veredicto del auditor">✓ {audited}</span>
      </div>
      {listFilter === 'filled' && (
        <div className="rl-exitfilter">
          {(['all', 'TP', 'SL', 'BE'] as const).map((f) => (
            <button key={f} className={exitFilter === f ? 'on' : ''} onClick={() => setExitFilter(f)}>
              {f === 'all' ? 'todas' : f}
              {f !== 'all' && ` (${signals.filter((s) => s.outcome === 'filled' && s.exitReason === f).length})`}
            </button>
          ))}
        </div>
      )}
      <ul>
        {listed.slice(0, LIST_CAP).map((s, i) => {
          const v = verdicts[s.intentId];
          return (
            <li
              key={s.intentId}
              className={`rl-item ${s.intentId === focusedId ? 'selected' : ''}`}
              onClick={() => focusSignal(s)}
            >
              <span className="rl-idx">{i + 1}</span>
              <span className={`rl-dir ${s.direction === 'LONG' ? 'long' : 'short'}`}>{s.direction === 'LONG' ? '▲' : '▼'}</span>
              <span className="rl-date">{formatUtc(s.signalBarTime).slice(2, 16)}</span>
              <span className={`rl-out ${s.outcome === 'filled' ? rClass(s.rMultiple) : ''}`}>
                {s.outcome === 'filled' ? `${s.exitReason} ${fmtR(s.rMultiple)}` : s.outcome === 'rejected' ? `✕ ${s.reason}` : `${s.outcome}`}
              </span>
              {v && <span className={`rl-verdict v-${v.verdict}`}>{v.verdict === 'valida' ? '✓' : v.verdict === 'dudosa' ? '?' : '✗'}</span>}
            </li>
          );
        })}
        {listed.length > LIST_CAP && <li className="rl-more">… {listed.length - LIST_CAP} más (afina el filtro)</li>}
      </ul>
    </div>
  );

  let center: React.ReactNode;
  if (runsError) {
    center = (
      <div className="state state-error">
        <p>Error del visor</p>
        <code>{runsError}</code>
        <p className="hint">¿Backend con DB_ENABLED=true y corridas registradas? (npm run backtest -- … --register)</p>
      </div>
    );
  } else if (!run) {
    center = <div className="state state-loading">Cargando corridas…</div>;
  } else if (windowStatus === 'idle') {
    center = <div className="state">Elige una señal de la lista para reproducirla sobre la gráfica.</div>;
  } else if (windowStatus === 'loading') {
    center = <div className="state state-loading">Cargando ventana de velas…</div>;
  } else if (windowStatus === 'error') {
    center = <div className="state state-error">No se pudo cargar la ventana de velas.</div>;
  } else {
    center = (
      <div className="replay-center">
        <ReplayChart
          candles={candles}
          cursorIdx={cursorIdx}
          tfMs={tfMs}
          signals={chartSignals}
          focused={focused}
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
        <p className="ri-empty">Sin señal enfocada.</p>
      ) : (
        <>
          <div className="ri-head">
            <b className={focused.direction === 'LONG' ? 'long' : 'short'}>{focused.direction}</b>
            <span className="ri-phase">{phase ?? '—'}</span>
            <span className="ri-out">{focused.outcome}{focused.reason ? ` (${focused.reason})` : ''}</span>
          </div>
          <div className="ri-nav">
            <button onClick={() => focusNeighbor(-1)} disabled={focusedListIdx <= 0}>‹ anterior</button>
            <button onClick={() => focusNeighbor(1)} disabled={focusedListIdx < 0 || focusedListIdx >= listed.length - 1}>siguiente ›</button>
          </div>

          {/* ── LO IMPORTANTE, de un vistazo: niveles + resultado con su desglose ── */}
          <div className="ri-levels">
            {focused.outcome === 'filled' ? (
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
                <div className="ri-rbreak">
                  bruto {fmtR(focused.grossR)} · comisiones+slip −{(focused.costR ?? 0).toFixed(2)}R
                </div>
              </>
            ) : (
              <div className="ri-flow">
                <div>
                  <span className="lv-label">{focused.outcome === 'rejected' ? 'DESCARTADA' : 'SIN FILL'}</span>
                  <span className="lv-price">{focused.entry ?? '—'}</span>
                  <span className="lv-sub">{focused.reason}</span>
                </div>
              </div>
            )}
            <div className="ri-grid">
              <div><span className="lv-label">SL</span><span className="lv-val sl">{focused.stopLoss ?? '—'}</span></div>
              <div><span className="lv-label">TP (2R)</span><span className="lv-val tp">{focused.takeProfit ?? '—'}</span></div>
              <div><span className="lv-label">riesgo</span><span className="lv-val">{focused.entry != null && focused.stopLoss != null ? Math.abs(focused.entry - focused.stopLoss).toFixed(2) : '—'}</span></div>
              <div><span className="lv-label">BE</span><span className="lv-val">{focused.movedToBE ? 'armado' : 'no'}</span></div>
            </div>
          </div>

          <h4>Porqué causal</h4>
          <table className="ri-table">
            <tbody>
              <tr><td>señal (cierre de vela)</td><td>{formatUtc(focused.signalBarTime)}</td></tr>
              {focused.sweptSwingTime != null && <tr><td>swing barrido (origen)</td><td>{formatUtc(focused.sweptSwingTime)}</td></tr>}
              {focused.sweptLevel != null && <tr><td>liquidez barrida</td><td>{focused.sweptLevel}</td></tr>}
              {focused.wickExtreme != null && <tr><td>extremo de la mecha</td><td>{focused.wickExtreme}</td></tr>}
              <tr><td>zona de reacción</td><td>{focused.zoneLow} ↔ {focused.zoneHigh}</td></tr>
              {focused.entry != null && <tr><td>entry (límite CE)</td><td>{focused.entry}</td></tr>}
              {focused.stopLoss != null && <tr><td>SL inicial</td><td>{focused.stopLoss}</td></tr>}
              {focused.takeProfit != null && <tr><td>TP (2R)</td><td>{focused.takeProfit}</td></tr>}
              {focused.cancelBeyond != null && <tr><td>cancelBeyond</td><td>{focused.cancelBeyond}</td></tr>}
            </tbody>
          </table>
          {focused.outcome === 'filled' && (
            <>
              <h4>Desenlace simulado</h4>
              <table className="ri-table">
                <tbody>
                  <tr><td>fill</td><td>{focused.entryTime != null ? formatUtc(focused.entryTime) : '—'} @ {focused.entryPrice}</td></tr>
                  <tr><td>salida</td><td>{focused.exitTime != null ? formatUtc(focused.exitTime) : '—'} @ {focused.exitPrice}</td></tr>
                  <tr><td>resultado</td><td><b>{focused.exitReason} {fmtR(focused.rMultiple)}</b> (bruto {fmtR(focused.grossR)}, coste {fmtR(focused.costR)})</td></tr>
                  <tr><td>velas hasta fill / dentro</td><td>{focused.barsToFill} / {focused.barsHeld}</td></tr>
                  <tr><td>BE armado</td><td>{focused.movedToBE ? 'sí (50 % del recorrido)' : 'no'}</td></tr>
                </tbody>
              </table>
            </>
          )}
          {simAssumptions(focused).length > 0 && (
            <>
              <h4>Asunciones del simulador</h4>
              <ul className="ri-assumptions">
                {simAssumptions(focused).map((a) => (
                  <li key={a}>{a}</li>
                ))}
              </ul>
            </>
          )}
          <h4>Veredicto del auditor</h4>
          <div className="ri-verdict">
            <button className={`v-btn v-valida ${focusedVerdict?.verdict === 'valida' ? 'on' : ''}`} onClick={() => setVerdict('valida')}>✓ válida</button>
            <button className={`v-btn v-dudosa ${focusedVerdict?.verdict === 'dudosa' ? 'on' : ''}`} onClick={() => setVerdict('dudosa')}>? dudosa</button>
            <button className={`v-btn v-error ${focusedVerdict?.verdict === 'error' ? 'on' : ''}`} onClick={() => setVerdict('error')}>✗ error</button>
          </div>
          <textarea
            ref={noteRef}
            key={focused.intentId}
            className="ri-note"
            placeholder="Nota del auditor (se guarda con el veredicto)…"
            defaultValue={focusedVerdict?.note ?? ''}
          />
        </>
      )}
    </div>
  );

  const bottom = (
    <div className="replay-bottom">
      <ReplayControls
        cursorIdx={cursorIdx}
        maxIdx={maxIdx}
        cursorTime={cursorOpen}
        playing={playing}
        speed={speed}
        bias={bias}
        onSeek={(i) => setCursorIdx(i)}
        onStep={(d) => setCursorIdx((c) => Math.min(Math.max(c + d, 0), maxIdx))}
        onPlayPause={() => setPlaying((p) => !p)}
        onSpeed={setSpeed}
      />
      <EquitySparkline
        points={equity}
        focusedIntentId={focusedId}
        onPick={(intentId) => {
          const s = signals.find((x) => x.intentId === intentId);
          if (s) focusSignal(s);
        }}
      />
    </div>
  );

  return (
    <AppShell
      topBar={topBar}
      left={left}
      center={center}
      right={right}
      bottom={bottom}
      leftOpen={true}
      rightOpen={true}
      bottomOpen={true}
    />
  );
}
