import { useEffect, useMemo, useState } from 'react';
import { fetchWatchlist } from '../../features/bot-analysis/botWatchlist.api';
import type { WatchlistItem } from '../../features/bot-analysis/botWatchlist.types';
import type { PaperTrade } from '../../features/paper/paper.types';

interface Props {
  symbols: string[];
  selected: string;
  onSelect: (s: string) => void;
  trades: PaperTrade[];
}

const biasArrow = (b: string) => (b === 'bullish' ? '▲' : b === 'bearish' ? '▼' : '—');
const tag = (t: string) => (t === 'equalHigh' ? 'EQH' : t === 'equalLow' ? 'EQL' : t === 'swingHigh' ? 'BSL' : 'SSL');
const agoShort = (ms: number) => {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h` : `${Math.floor(h / 24)}d`;
};

/**
 * Watchlist de los 10 pares: el estado de cada uno de un vistazo (sesgo 4H, qué busca, distancia a la
 * próxima liquidez objetivo, y si tiene una entrada viva) → saber DÓNDE mirar. Clic = cargarlo en la
 * gráfica. Ordena primero los que tienen posición viva, luego por cercanía al objetivo.
 */
export function PaperWatchlist({ symbols, selected, onSelect, trades }: Props) {
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (symbols.length === 0) return;
    let cancelled = false;
    const load = () => {
      fetchWatchlist(symbols)
        .then((r) => {
          if (!cancelled) {
            setItems(r.watchlist);
            setLoading(false);
          }
        })
        .catch(() => {
          if (!cancelled) setLoading(false);
        });
    };
    load();
    const t = setInterval(load, 60_000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [symbols]);

  // Estado por símbolo desde las operaciones en vivo: posición viva + antigüedad de la última señal.
  const bySym = useMemo(() => {
    const m = new Map<string, { live: PaperTrade | null; lastSignal: number | null }>();
    for (const t of trades) {
      const e = m.get(t.symbol) ?? { live: null, lastSignal: null };
      if (t.state !== 'CLOSED') e.live = t;
      if (e.lastSignal == null || t.signalBarTime > e.lastSignal) e.lastSignal = t.signalBarTime;
      m.set(t.symbol, e);
    }
    return m;
  }, [trades]);

  const ordered = useMemo(() => {
    const byName = new Map(items.map((it) => [it.symbol, it]));
    const full = symbols.map(
      (s) => byName.get(s) ?? ({ symbol: s, bias: 'neutral', price: 0, target: null } as WatchlistItem),
    );
    return full.sort((a, b) => {
      const la = bySym.get(a.symbol)?.live ? 0 : 1;
      const lb = bySym.get(b.symbol)?.live ? 0 : 1;
      if (la !== lb) return la - lb;
      const da = a.target ? Math.abs(a.target.distPct) : 9999;
      const db = b.target ? Math.abs(b.target.distPct) : 9999;
      return da - db;
    });
  }, [items, symbols, bySym]);

  const now = Date.now();
  return (
    <div className="pw-wrap">
      <div className="pw-title">Watchlist {loading && <span className="pw-load">…</span>}</div>
      <ul className="pw-list">
        {ordered.map((it) => {
          const st = bySym.get(it.symbol);
          const live = st?.live ?? null;
          return (
            <li
              key={it.symbol}
              className={`pw-item ${it.symbol === selected ? 'sel' : ''} ${live ? 'has-live' : ''}`}
              onClick={() => onSelect(it.symbol)}
            >
              <div className="pw-row1">
                <span className="pw-sym">{it.symbol.replace('USDT', '')}</span>
                <span className={`pw-bias ${it.bias}`} title={`sesgo 4H ${it.bias}`}>{biasArrow(it.bias)}</span>
                {live ? (
                  <span className={`pw-live ${live.direction === 'LONG' ? 'long' : 'short'}`}>
                    {live.state === 'FILLED' ? '● pos' : '◌ pend'}
                  </span>
                ) : (
                  <span className={`pw-seek ${it.bias === 'bullish' ? 'long' : it.bias === 'bearish' ? 'short' : ''}`}>
                    {it.bias === 'bullish' ? 'LONG' : it.bias === 'bearish' ? 'SHORT' : '—'}
                  </span>
                )}
              </div>
              <div className="pw-row2">
                <span className="pw-target" title="próxima liquidez objetivo (distancia)">
                  {it.target ? `${tag(it.target.type)} ${it.target.distPct >= 0 ? '+' : ''}${it.target.distPct}%` : 'sin objetivo'}
                </span>
                <span className="pw-ago" title="última señal">{st?.lastSignal ? agoShort(now - st.lastSignal) : '—'}</span>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
