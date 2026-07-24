// Vista "Real" (P.5.4): cómo va el bot CON PLATA REAL — resumen (balance/P&L del test) + historial de
// execution_orders, cada fila COMPARADA con lo que el paper registró para el MISMO intent (la medición
// fill-real-vs-papel en pantalla). Los endpoints exigen x-exec-token → se pide una vez y queda en
// localStorage. Solo LECTURA (el kill-switch se maneja por curl, a propósito).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiGetExec } from '../../lib/apiClient';
import { formatUsd } from '../../features/paper/capital';
import type { PaperTrade } from '../../features/paper/paper.types';

interface ExecTrade {
  intentId: string;
  symbol: string;
  direction: string;
  signalBarTime: number;
  state: string; // PENDING | FILLED | CLOSED | CANCELED
  testnet: boolean;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  quantity: number;
  notionalUsd: number;
  riskUsd: number;
  entryFillPrice: number | null;
  entryFillTime: number | null;
  movedToBE: boolean;
  tp1Filled: boolean;
  tp1FillPrice: number | null;
  exitTime: number | null;
  exitPrice: number | null;
  exitReason: string | null;
  realizedR: number | null;
  realizedUsd: number | null;
  cancelReason: string | null;
}

interface ExecStatus {
  enabled: boolean;
  testnet: boolean;
  riskUsd: number;
  testCapitalUsd?: number;
  walletUsd?: number | null;
  engineVersion: string;
  risk: {
    activeSlots: number;
    dailyLossR: number;
    cumulativeLossR: number;
    realizedR: number;
    killed: boolean;
    killReason: string | null;
  };
  positions: { intentId: string; symbol: string; direction: string; state: string; tp1Filled?: boolean }[];
}

const fmtR = (r: number | null | undefined): string =>
  r == null ? '—' : `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`;
const rClass = (r: number | null | undefined): string => (r == null ? '' : r > 0.02 ? 'long' : r < -0.02 ? 'short' : '');
const fmtDate = (ms: number): string => new Date(ms).toISOString().slice(2, 16).replace('T', ' ');

export function RealExec({ paperTrades }: { paperTrades: PaperTrade[] }) {
  const [token, setToken] = useState(() => localStorage.getItem('exec.token') ?? '');
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<ExecStatus | null>(null);
  const [trades, setTrades] = useState<ExecTrade[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const [st, tr] = await Promise.all([
        apiGetExec<ExecStatus>('/api/exec/status', token),
        apiGetExec<{ trades: ExecTrade[] }>('/api/exec/trades?limit=500', token),
      ]);
      setStatus(st);
      setTrades(tr.trades);
      setError(null);
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      setError(m.includes('401') ? 'Token inválido — revisalo y volvé a guardarlo.' : m);
    }
  }, [token]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 30_000);
    return () => clearInterval(t);
  }, [refresh]);

  const paperById = useMemo(() => new Map(paperTrades.map((p) => [p.intentId, p])), [paperTrades]);

  // Solo el entorno REAL cuenta acá (las filas de testnet del pasado no ensucian el test).
  const real = useMemo(() => trades.filter((t) => !t.testnet), [trades]);
  const closed = useMemo(() => real.filter((t) => t.state === 'CLOSED' && t.realizedR != null), [real]);
  const summary = useMemo(() => {
    const pnlUsd = closed.reduce((s, t) => s + (t.realizedUsd ?? 0), 0);
    const totalR = closed.reduce((s, t) => s + (t.realizedR ?? 0), 0);
    const wins = closed.filter((t) => (t.realizedR ?? 0) > 0.02).length;
    const fills = real.filter((t) => t.entryFillTime != null).length;
    const placed = real.filter((t) => t.state !== 'CANCELED' || t.cancelReason === 'ranAway').length;
    return { pnlUsd, totalR, n: closed.length, wins, fills, placed };
  }, [closed, real]);

  // El capital del test viene del server (EXECUTION_TEST_CAPITAL) — el sizing real usa ESE número, no la billetera.
  const baseCapital = status?.testCapitalUsd ?? 100;

  if (!token) {
    return (
      <div className="pp-waiting">
        <div className="pp-waiting-icon">🔐</div>
        <p className="pp-waiting-title">Vista Real — hace falta tu token</p>
        <p className="pp-waiting-sub">
          Los datos de la ejecución REAL están protegidos con el <code>EXEC_API_TOKEN</code> del server. Pegalo acá
          (queda guardado solo en este navegador).
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            type="password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="x-exec-token"
            style={{ minWidth: 280 }}
          />
          <button
            className="on"
            onClick={() => {
              localStorage.setItem('exec.token', draft.trim());
              setToken(draft.trim());
            }}
          >
            Guardar
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, height: '100%', overflowY: 'auto' }}>
      {status?.risk.killed && (
        <div style={{ background: 'var(--down)', color: '#fff', padding: '8px 14px', borderRadius: 8, fontWeight: 700 }}>
          ⛔ KILL-SWITCH ACTIVO: {status.risk.killReason ?? 'manual'} — el bot no abre operaciones.
        </div>
      )}
      {error && (
        <div style={{ color: 'var(--down)', padding: '4px 2px' }}>
          {error}{' '}
          <button onClick={() => { localStorage.removeItem('exec.token'); setToken(''); }}>cambiar token</button>
        </div>
      )}

      {/* ── Resumen REAL ── */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
        {[
          {
            k: 'BILLETERA REAL',
            v: status?.walletUsd != null ? formatUsd(status.walletUsd) : '…',
            sub: 'Binance Futures (en vivo)',
          },
          {
            k: 'CAPITAL DEL TEST',
            v: formatUsd(baseCapital + summary.pnlUsd),
            sub: `base ${formatUsd(baseCapital)} + P&L · riesgo ${formatUsd(status?.riskUsd ?? 0.5)}/op (fijo, no usa la billetera)`,
          },
          { k: 'P&L REAL', v: `${summary.pnlUsd >= 0 ? '+' : ''}${formatUsd(summary.pnlUsd)}`.replace('+$−', '−$'), sub: `${fmtR(summary.totalR)} · ${summary.n} cerradas`, cls: rClass(summary.pnlUsd) },
          { k: 'GANADAS', v: summary.n ? `${summary.wins}/${summary.n}` : '—', sub: summary.n ? `${((summary.wins / summary.n) * 100).toFixed(0)}% WR` : 'sin cerradas' },
          { k: 'FILLS', v: `${summary.fills}`, sub: `de ${summary.placed} límites (objetivo: 20-30)` },
          { k: 'RIESGO HOY', v: fmtR(-(status?.risk.dailyLossR ?? 0)), sub: `corte a −3R · acum −${(status?.risk.cumulativeLossR ?? 0).toFixed(1)}R (breaker −10R)` },
        ].map((b) => (
          <div key={b.k} style={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 16px', minWidth: 150 }}>
            <div className="lv-label">{b.k}</div>
            <div className={b.cls ?? ''} style={{ fontSize: 22, fontWeight: 800 }}>{b.v}</div>
            <div className="lv-label">{b.sub}</div>
          </div>
        ))}
      </div>

      {/* ── Posiciones vivas ── */}
      {status && status.positions.filter((p) => p.state === 'PENDING' || p.state === 'FILLED').length > 0 && (
        <div style={{ color: 'var(--muted)', fontSize: 13 }}>
          En curso:{' '}
          {status.positions
            .filter((p) => p.state === 'PENDING' || p.state === 'FILLED')
            .map((p) => `${p.symbol} ${p.direction} (${p.state === 'PENDING' ? 'límite esperando' : p.tp1Filled ? 'TP1 ✓ asegurado' : 'en posición'})`)
            .join(' · ')}
        </div>
      )}

      {/* ── Historial REAL vs paper ── */}
      {real.length === 0 ? (
        <div className="pp-waiting" style={{ flex: 1 }}>
          <div className="pp-waiting-icon">⏳</div>
          <p className="pp-waiting-title">Sin operaciones reales todavía</p>
          <p className="pp-waiting-sub">
            El bot espera su señal (15 símbolos). Cuando llegue, acá vas a ver cada operación
            real al lado de lo que el paper registró para la MISMA señal — la medición del test.
          </p>
        </div>
      ) : (
        <div className="ph-tablewrap">
          <table className="ph-table">
            <thead>
              <tr>
                <th>Fecha (UTC)</th><th>Par</th><th>Dir</th><th>Estado</th>
                <th className="ph-num">Entrada</th><th className="ph-num">Fill real</th>
                <th>TP1</th><th className="ph-num">R real</th><th className="ph-num">$ real</th>
                <th className="ph-num">R paper</th><th className="ph-num">Δ</th>
              </tr>
            </thead>
            <tbody>
              {real.map((t) => {
                const paper = paperById.get(t.intentId);
                const delta = t.realizedR != null && paper?.rMultiple != null ? t.realizedR - paper.rMultiple : null;
                const estado =
                  t.state === 'CLOSED' ? (t.exitReason ?? 'CLOSED')
                  : t.state === 'CANCELED' ? (t.cancelReason === 'ranAway' ? '✕ ranAway' : 'cancelada')
                  : t.state === 'FILLED' ? (t.tp1Filled ? 'TP1 ✓ · corre' : 'en posición')
                  : 'límite…';
                return (
                  <tr key={t.intentId}>
                    <td className="ph-date">{fmtDate(t.signalBarTime)}</td>
                    <td className="ph-sym">{t.symbol.replace('USDT', '')}</td>
                    <td className={t.direction === 'LONG' ? 'long' : 'short'}>{t.direction === 'LONG' ? '▲' : '▼'} {t.direction}</td>
                    <td className={`ph-out ${rClass(t.realizedR)}`}>{estado}</td>
                    <td className="ph-num">{t.entry}</td>
                    <td className="ph-num">{t.entryFillPrice ?? '—'}</td>
                    <td>{t.tp1Filled ? '✓' : t.state === 'CLOSED' && t.entryFillPrice != null ? '—' : ''}</td>
                    <td className={`ph-num ${rClass(t.realizedR)}`}>{fmtR(t.realizedR)}</td>
                    <td className={`ph-num ${rClass(t.realizedR)}`}>{t.realizedUsd != null ? formatUsd(t.realizedUsd, true) : '—'}</td>
                    <td className={`ph-num ${rClass(paper?.rMultiple)}`}>{fmtR(paper?.rMultiple)}</td>
                    <td className={`ph-num ${delta != null && Math.abs(delta) > 0.1 ? 'short' : ''}`}>{delta != null ? fmtR(delta) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="lv-label" style={{ paddingBottom: 8 }}>
        Δ = R real − R paper para el MISMO intent (la brecha fill/slippage que este test mide). Actualiza cada 30 s.
      </div>
    </div>
  );
}
