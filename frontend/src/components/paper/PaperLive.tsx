import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReplayChart } from '../replay/ReplayChart';
import { fetchCandles } from '../../features/candles/candles.api';
import { fetchPaperContext } from '../../features/paper/paper.api';
import { paperToSignal } from '../../features/paper/paperAdapter';
import { fetchBotSweeps } from '../../features/bot-analysis/botSweep.api';
import type { BotSweep } from '../../features/bot-analysis/botSweep.types';
import { fetchBotFvgs } from '../../features/bot-analysis/botFvg.api';
import type { BotFvg } from '../../features/bot-analysis/botFvg.types';
import { fetchBotBias } from '../../features/bot-analysis/botBias.api';
import { BIAS_LABEL, type BotBiasResponse } from '../../features/bot-analysis/botBias.types';
import type { PaperTrade } from '../../features/paper/paper.types';
import type { Candle, Timeframe } from '../../features/candles/candles.types';
import type { ReplayContextResponse } from '../../features/backtest-viewer/backtestContext.types';
import { LiveClient, type MarketStatus } from '../../lib/liveClient';
import { tfToMs } from '../../lib/time';

// El bot OPERA en 15m (gatillo) y mira 4H (sesgo). Son las únicas dos TF que ingesta el backend y
// que el candidato usa; por eso la vista solo ofrece esas dos (otras TF no son parte de su lógica).
const VIEW_TFS: Timeframe[] = ['15m' as Timeframe, '4h' as Timeframe];

interface Props {
  symbols: string[]; // los 10 del gate
  symbol: string; // controlado por el contenedor (compartido con el watchlist)
  onSymbol: (s: string) => void;
  trades: PaperTrade[];
}

const mktClass: Record<MarketStatus, string> = {
  OFFLINE: 'mkt-offline',
  LIVE: 'mkt-live',
  STALE: 'mkt-stale',
  RECONNECTING: 'mkt-reconnecting',
  DISCONNECTED: 'mkt-disconnected',
};

const liqTag = (t: string) =>
  t === 'equalHigh' ? 'EQH' : t === 'equalLow' ? 'EQL' : t === 'swingHigh' ? 'BSL' : 'SSL';

const distPct = (level: number, price: number) => {
  if (!price) return '';
  const d = ((level - price) / price) * 100;
  return `${d >= 0 ? '+' : ''}${d.toFixed(1)}%`;
};

const agoLabel = (ms: number) => {
  const min = Math.floor(ms / 60000);
  if (min < 60) return `hace ${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `hace ${h}h`;
  return `hace ${Math.floor(h / 24)}d`;
};

/**
 * Vista EN VIVO del paper: la gráfica del par EN TIEMPO REAL (la vela en formación se mueve con el
 * precio) + el análisis del bot, y el panel "¿qué mira el bot ahora?" (sesgo 4H, qué busca, liquidez
 * objetivo) que explica POR QUÉ entra o no. 🎯 Lo que OPERA: barrido (a favor del sesgo) → entrada en
 * el CE. 📐 Contexto: OB/FVG. OJO: el motor DECIDE al CIERRE de la vela 15m (no intra-vela) — la vela
 * viva es solo visual. Observable, no operable (Regla Cero).
 */
export function PaperLive({ symbols, symbol, onSymbol, trades }: Props) {
  const list = symbols.length ? symbols : ['BTCUSDT'];
  const [tf, setTf] = useState<Timeframe>(() => {
    const s = localStorage.getItem('paper.live.tf');
    return s === '4h' ? ('4h' as Timeframe) : ('15m' as Timeframe);
  });
  const [candles, setCandles] = useState<Candle[]>([]);
  const [context, setContext] = useState<ReplayContextResponse | null>(null);
  const [sweeps, setSweeps] = useState<BotSweep[]>([]);
  const [fvgs, setFvgs] = useState<BotFvg[]>([]);
  const [bias, setBias] = useState<BotBiasResponse | null>(null);
  const [livePrice, setLivePrice] = useState<number | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [market, setMarket] = useState<MarketStatus>('OFFLINE');
  const [showObs, setShowObs] = useState(true);
  const [showLiq, setShowLiq] = useState(true);
  const [showSweeps, setShowSweeps] = useState(true);
  const [showFvg, setShowFvg] = useState(false);

  const is15m = tf === '15m';
  const tfMs = tfToMs(tf);
  const liveRef = useRef<LiveClient | null>(null);
  const symRef = useRef(symbol);
  symRef.current = symbol;
  const tfRef = useRef(tf);
  tfRef.current = tf;
  const lastTickRef = useRef(0);

  useEffect(() => localStorage.setItem('paper.live.tf', tf), [tf]);

  // Re-deriva el análisis del bot (sesgo 4H siempre; contexto/barridos/FVG solo en la vista 15m).
  const refreshAnalysis = useCallback((cs: Candle[]) => {
    const sym = symRef.current;
    fetchBotBias(sym).then(setBias).catch(() => setBias(null));
    if (tfRef.current !== '15m') {
      setContext(null);
      setSweeps([]);
      setFvgs([]);
      return;
    }
    if (cs.length) {
      const from = cs[0].openTime;
      const to = cs[cs.length - 1].openTime + tfToMs('15m');
      fetchPaperContext(sym, from, to).then(setContext).catch(() => setContext(null));
    }
    fetchBotSweeps(sym, '15m' as Timeframe).then((r) => setSweeps(r.sweeps)).catch(() => setSweeps([]));
    fetchBotFvgs(sym, '15m' as Timeframe).then((r) => setFvgs(r.fvgs)).catch(() => setFvgs([]));
  }, []);

  // Carga inicial (y al cambiar símbolo o TF).
  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    setContext(null);
    setSweeps([]);
    setFvgs([]);
    setCandles([]);
    setLivePrice(null);
    fetchCandles(symbol, tf, tf === '15m' ? 400 : 300)
      .then((res) => {
        if (cancelled) return;
        setCandles(res.candles);
        setStatus('ready');
        refreshAnalysis(res.candles);
      })
      .catch(() => {
        if (!cancelled) setStatus('error');
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, tf, refreshAnalysis]);

  // Conexión live: la vela en FORMACIÓN se mueve con el precio (visual); al CIERRE el motor decide
  // y se re-deriva el análisis.
  useEffect(() => {
    const client = new LiveClient();
    liveRef.current = client;
    const applyCandle = (c: Candle): boolean => c.symbol === symRef.current && c.tf === tfRef.current;
    client.connect({
      onPrice: (sym, price) => {
        if (sym === symRef.current) setLivePrice(price);
      },
      onLiveUpdate: (c) => {
        if (!applyCandle(c)) return;
        setLivePrice(c.c);
        const t = Date.now();
        if (t - lastTickRef.current < 700) return; // throttle visual (no recalcular en cada tick)
        lastTickRef.current = t;
        setCandles((prev) => {
          if (prev.length === 0) return prev;
          const last = prev[prev.length - 1];
          if (c.openTime === last.openTime) return [...prev.slice(0, -1), c];
          if (c.openTime > last.openTime) return [...prev, c];
          return prev;
        });
      },
      onClosed: (c) => {
        if (!applyCandle(c)) return;
        setLivePrice(c.c);
        setCandles((prev) => {
          if (prev.length === 0) return prev;
          const last = prev[prev.length - 1];
          let next: Candle[];
          if (c.openTime === last.openTime) next = [...prev.slice(0, -1), c];
          else if (c.openTime > last.openTime) next = [...prev, c];
          else return prev;
          refreshAnalysis(next);
          return next;
        });
      },
      onStatus: setMarket,
    });
    client.setStream(symRef.current, tfRef.current);
    return () => {
      client.disconnect();
      liveRef.current = null;
    };
  }, [refreshAnalysis]);

  useEffect(() => {
    liveRef.current?.setStream(symbol, tf);
  }, [symbol, tf]);

  const signals = useMemo(
    () => (is15m ? trades.filter((t) => t.symbol === symbol).map(paperToSignal) : []),
    [trades, symbol, is15m],
  );
  const liveIntent = useMemo(
    () =>
      trades
        .filter((t) => t.symbol === symbol && t.state !== 'CLOSED')
        .sort((a, b) => b.signalBarTime - a.signalBarTime)[0] ?? null,
    [trades, symbol],
  );
  const focused = useMemo(() => (is15m && liveIntent ? paperToSignal(liveIntent) : null), [is15m, liveIntent]);

  // ── Panel "¿qué mira el bot ahora?" ──
  const price = livePrice ?? (candles.length ? candles[candles.length - 1].c : 0);
  const seeking: 'LONG' | 'SHORT' | null =
    bias?.bias === 'bullish' ? 'LONG' : bias?.bias === 'bearish' ? 'SHORT' : null;
  const targetLiq = useMemo(() => {
    if (!context || !seeking || price === 0) return null;
    const unswept = context.liquidity.filter((l) => l.sweptAtTime == null);
    if (seeking === 'LONG') {
      return unswept
        .filter((l) => (l.type === 'swingLow' || l.type === 'equalLow') && l.level < price)
        .sort((a, b) => b.level - a.level)[0] ?? null;
    }
    return unswept
      .filter((l) => (l.type === 'swingHigh' || l.type === 'equalHigh') && l.level > price)
      .sort((a, b) => a.level - b.level)[0] ?? null;
  }, [context, seeking, price]);
  const lastSignalTime = useMemo(() => {
    const ts = trades.filter((t) => t.symbol === symbol).map((t) => t.signalBarTime);
    return ts.length ? Math.max(...ts) : null;
  }, [trades, symbol]);
  const now = Date.now();

  return (
    <div className="pl-wrap">
      <div className="pl-header">
        <select className="pl-symsel" value={symbol} onChange={(e) => onSymbol(e.target.value)}>
          {list.map((s) => (
            <option key={s} value={s}>{s.replace('USDT', '')}</option>
          ))}
        </select>
        <span className="pl-tfsel">
          {VIEW_TFS.map((t) => (
            <button key={t} className={tf === t ? 'on' : ''} onClick={() => setTf(t)} title={t === '15m' ? 'gatillo del bot' : 'sesgo del bot'}>
              {t === '15m' ? '15m' : '4H'}
            </button>
          ))}
        </span>
        <span className={`badge mkt ${mktClass[market]}`}>{market === 'LIVE' ? '● en vivo' : market.toLowerCase()}</span>
        {livePrice != null && <span className="pl-price">{livePrice.toLocaleString('en-US')}</span>}
        {is15m && (
          <span className="pl-toggles">
            <label className="rt-toggle"><input type="checkbox" checked={showObs} onChange={() => setShowObs((v) => !v)} /> OB</label>
            <label className="rt-toggle"><input type="checkbox" checked={showLiq} onChange={() => setShowLiq((v) => !v)} /> liquidez</label>
            <label className="rt-toggle"><input type="checkbox" checked={showSweeps} onChange={() => setShowSweeps((v) => !v)} /> barridos</label>
            <label className="rt-toggle"><input type="checkbox" checked={showFvg} onChange={() => setShowFvg((v) => !v)} /> FVG</label>
          </span>
        )}
        <span className="pl-legend" title="🎯 Lo que el bot OPERA: barrido de liquidez (a favor del sesgo 4H) → entrada en el CE (entry/SL/TP). 📐 Contexto de estudio: OB, FVG. ⬤ ámbar = barrido. El motor DECIDE al cierre de la vela 15m; la vela viva es solo visual.">
          {is15m ? '🎯 entrada · ⬤ barrido · 📐 OB/FVG' : 'vista 4H = el sesgo del bot (decide en 15m)'}
        </span>
      </div>

      <div className="pl-stance">
        <span className="pls-item">
          <span className="pls-k">Sesgo 4H</span>
          <span className={`pls-bias ${bias?.bias ?? 'neutral'}`}>{bias ? BIAS_LABEL[bias.bias] : '…'}</span>
        </span>
        <span className="pls-sep">·</span>
        <span className="pls-item">
          <span className="pls-k">el bot busca</span>
          <span className={`pls-seek ${seeking === 'LONG' ? 'long' : seeking === 'SHORT' ? 'short' : 'none'}`}>
            {seeking === 'LONG' ? 'LONGs ▲' : seeking === 'SHORT' ? 'SHORTs ▼' : 'nada (sesgo neutral)'}
          </span>
        </span>
        <span className="pls-sep">·</span>
        <span className="pls-item">
          <span className="pls-k">próxima liquidez objetivo</span>
          <span className="pls-target">
            {targetLiq ? `${liqTag(targetLiq.type)} ${targetLiq.level} (${distPct(targetLiq.level, price)})` : '—'}
          </span>
        </span>
        <span className="pls-sep">·</span>
        <span className="pls-item">
          <span className="pls-k">última señal</span>
          <span className="pls-ago">{lastSignalTime ? agoLabel(now - lastSignalTime) : 'ninguna aún'}</span>
        </span>
        {liveIntent && (
          <span className={`pl-intent ${liveIntent.direction === 'LONG' ? 'long' : 'short'}`}>
            {liveIntent.state === 'FILLED' ? '● EN POSICIÓN' : '◌ ENTRADA PENDIENTE'} {liveIntent.direction === 'LONG' ? '▲' : '▼'} @ {liveIntent.entry} · SL {liveIntent.stopLoss} · TP {liveIntent.takeProfit}
          </span>
        )}
      </div>

      <div className="pl-chart">
        {status === 'loading' && <div className="state state-loading">Cargando {symbol.replace('USDT', '')} {tf}…</div>}
        {status === 'error' && <div className="state state-error">No se pudieron cargar las velas de {symbol} {tf}.</div>}
        {status === 'ready' && candles.length > 0 && (
          <ReplayChart
            candles={candles}
            cursorIdx={candles.length - 1}
            tfMs={tfMs}
            signals={signals}
            focused={focused}
            context={is15m ? context : null}
            showObs={showObs}
            showLiq={showLiq}
            sweeps={is15m && showSweeps ? sweeps : []}
            fvgs={is15m && showFvg ? fvgs : []}
            liveTail
          />
        )}
      </div>
    </div>
  );
}
