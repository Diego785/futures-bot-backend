import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReplayChart } from '../replay/ReplayChart';
import { fetchCandles } from '../../features/candles/candles.api';
import { fetchPaperContext } from '../../features/paper/paper.api';
import { paperToSignal } from '../../features/paper/paperAdapter';
import type { PaperTrade } from '../../features/paper/paper.types';
import type { Candle, Timeframe } from '../../features/candles/candles.types';
import type { ReplayContextResponse } from '../../features/backtest-viewer/backtestContext.types';
import { LiveClient, type MarketStatus } from '../../lib/liveClient';
import { tfToMs } from '../../lib/time';

const TF = '15m' as Timeframe;
const WINDOW = 400;

interface Props {
  symbols: string[]; // los 10 del status del gate
  trades: PaperTrade[]; // todas las operaciones (se filtran por símbolo)
}

const mktClass: Record<MarketStatus, string> = {
  OFFLINE: 'mkt-offline',
  LIVE: 'mkt-live',
  STALE: 'mkt-stale',
  RECONNECTING: 'mkt-reconnecting',
  DISCONNECTED: 'mkt-disconnected',
};

/**
 * Vista EN VIVO del paper (D.2 v1): la gráfica del par seleccionado en tiempo real con el análisis
 * que el bot ya conoce (OB + liquidez del contexto causal) y las ENTRADAS del candidato (barrido →
 * entrada en el CE, con SL/TP) dibujadas cuando se arman. La gráfica avanza al CIERRE de cada vela
 * 15m (es cuando el motor decide). Observable, no operable (Regla Cero).
 */
export function PaperLive({ symbols, trades }: Props) {
  const list = symbols.length ? symbols : ['BTCUSDT'];
  const [symbol, setSymbol] = useState(() => {
    const s = localStorage.getItem('paper.live.symbol');
    return s && list.includes(s) ? s : list[0];
  });
  const [candles, setCandles] = useState<Candle[]>([]);
  const [context, setContext] = useState<ReplayContextResponse | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [market, setMarket] = useState<MarketStatus>('OFFLINE');
  const [showObs, setShowObs] = useState(true);
  const [showLiq, setShowLiq] = useState(true);
  const tfMs = tfToMs(TF);
  const liveRef = useRef<LiveClient | null>(null);
  const symRef = useRef(symbol);
  symRef.current = symbol;

  useEffect(() => localStorage.setItem('paper.live.symbol', symbol), [symbol]);

  const loadContext = useCallback(
    (cs: Candle[]) => {
      if (cs.length === 0) return;
      const from = cs[0].openTime;
      const to = cs[cs.length - 1].openTime + tfMs;
      fetchPaperContext(symRef.current, from, to)
        .then(setContext)
        .catch(() => setContext(null));
    },
    [tfMs],
  );

  // Carga inicial (y al cambiar de símbolo): histórico reciente + contexto SMC.
  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setContext(null);
    setCandles([]);
    fetchCandles(symbol, TF, WINDOW)
      .then((res) => {
        if (cancelled) return;
        setCandles(res.candles);
        setStatus('ready');
        loadContext(res.candles);
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, loadContext]);

  // Conexión live (una vez): la gráfica avanza al CIERRE de cada vela 15m.
  useEffect(() => {
    const client = new LiveClient();
    liveRef.current = client;
    client.connect({
      onPrice: () => {},
      onLiveUpdate: () => {},
      onClosed: (c) => {
        if (c.symbol !== symRef.current || c.tf !== TF) return;
        setCandles((prev) => {
          if (prev.length === 0) return prev;
          const last = prev[prev.length - 1];
          let next: Candle[];
          if (c.openTime === last.openTime) next = [...prev.slice(0, -1), c];
          else if (c.openTime > last.openTime) next = [...prev, c].slice(-WINDOW);
          else return prev;
          loadContext(next);
          return next;
        });
      },
      onStatus: setMarket,
    });
    client.setStream(symRef.current, TF);
    return () => {
      client.disconnect();
      liveRef.current = null;
    };
  }, [loadContext]);

  // Cambiar el stream live al cambiar de símbolo.
  useEffect(() => {
    liveRef.current?.setStream(symbol, TF);
  }, [symbol]);

  const signals = useMemo(() => trades.filter((t) => t.symbol === symbol).map(paperToSignal), [trades, symbol]);
  const liveIntent = useMemo(
    () =>
      trades
        .filter((t) => t.symbol === symbol && t.state !== 'CLOSED')
        .sort((a, b) => b.signalBarTime - a.signalBarTime)[0] ?? null,
    [trades, symbol],
  );
  const focused = useMemo(() => (liveIntent ? paperToSignal(liveIntent) : null), [liveIntent]);

  return (
    <div className="pl-wrap">
      <div className="pl-header">
        <select className="pl-symsel" value={symbol} onChange={(e) => setSymbol(e.target.value)}>
          {list.map((s) => (
            <option key={s} value={s}>
              {s.replace('USDT', '')}
            </option>
          ))}
        </select>
        <span className="pl-tf">15m</span>
        <span className={`badge mkt ${mktClass[market]}`}>{market === 'LIVE' ? '● en vivo' : market.toLowerCase()}</span>
        <label className="rt-toggle">
          <input type="checkbox" checked={showObs} onChange={() => setShowObs((v) => !v)} /> OB
        </label>
        <label className="rt-toggle">
          <input type="checkbox" checked={showLiq} onChange={() => setShowLiq((v) => !v)} /> liquidez
        </label>
        {liveIntent ? (
          <span className={`pl-intent ${liveIntent.direction === 'LONG' ? 'long' : 'short'}`}>
            {liveIntent.state === 'FILLED' ? '● EN POSICIÓN' : '◌ ENTRADA PENDIENTE'} {liveIntent.direction === 'LONG' ? '▲ LONG' : '▼ SHORT'} @ {liveIntent.entry} · SL {liveIntent.stopLoss} · TP {liveIntent.takeProfit}
          </span>
        ) : (
          <span className="pl-noentry">sin entrada activa — el bot vigila barridos de liquidez</span>
        )}
        <span className="pl-legend" title="🎯 Lo que el bot OPERA: barrido de liquidez → entrada en el CE (líneas entry/SL/TP). 📐 Contexto de estudio (no dispara): OB y liquidez. El motor decide al cierre de la vela 15m.">
          🎯 entrada del bot · 📐 contexto OB/liquidez
        </span>
      </div>
      <div className="pl-chart">
        {status === 'loading' && <div className="state state-loading">Cargando {symbol.replace('USDT', '')}…</div>}
        {status === 'error' && <div className="state state-error">No se pudieron cargar las velas de {symbol}.</div>}
        {status === 'ready' && candles.length > 0 && (
          <ReplayChart
            candles={candles}
            cursorIdx={candles.length - 1}
            tfMs={tfMs}
            signals={signals}
            focused={focused}
            context={context}
            showObs={showObs}
            showLiq={showLiq}
          />
        )}
      </div>
    </div>
  );
}
