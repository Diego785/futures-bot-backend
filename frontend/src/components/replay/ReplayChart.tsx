import { useEffect, useMemo, useRef } from 'react';
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type Logical,
  type SeriesMarker,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Candle } from '../../features/candles/candles.types';
import {
  signalPhaseAt,
  exitColor,
  REPLAY_COLORS,
  type BacktestSignal,
} from '../../features/backtest-viewer/backtestRuns.types';
import type { ReplayContextResponse } from '../../features/backtest-viewer/backtestContext.types';
import type { BotSweep } from '../../features/bot-analysis/botSweep.types';
import type { BotFvg } from '../../features/bot-analysis/botFvg.types';
import { msToUtcSeconds } from '../../lib/time';

interface Props {
  candles: Candle[]; // ventana completa cargada (ascendente)
  cursorIdx: number; // índice de la ÚLTIMA vela visible (vela cerrada donde está parado el replay)
  tfMs: number;
  signals: BacktestSignal[]; // señales a dibujar (el padre decide cuáles; la fase causal se evalúa aquí)
  focused: BacktestSignal | null; // señal bajo auditoría (lleva niveles y marcadores extra)
  context: ReplayContextResponse | null; // contexto SMC re-derivado (OBs + liquidez) con tiempos causales
  showObs: boolean;
  showLiq: boolean;
  sweeps?: BotSweep[]; // barridos de liquidez (gatillo del bot) — opcional (vista En vivo)
  fvgs?: BotFvg[]; // Fair Value Gaps — opcional (vista En vivo)
  liveTail?: boolean; // En vivo: la última vela se actualiza en tiempo real sin resetear el zoom
}

const MAX_OBS = 12; // anti-ruido: OBs visibles más recientes
const MAX_LIQ = 8; // niveles de liquidez más cercanos al precio del cursor
const SWEPT_LINGER_BARS = 10; // una liquidez barrida se sigue viendo N velas (para VER el barrido)

// Modelo de un item del overlay: QUÉ dibujar (datos), sin posición. La posición la fija el rAF.
interface OvItem {
  id: string;
  cls: string;
  kind: 'box' | 'line';
  tstart: number; // tiempo del borde izquierdo
  tend: number; // tiempo del borde derecho
  ptop?: number; // box: precio del borde superior
  pbottom?: number; // box: precio del borde inferior
  price?: number; // line: precio del nivel
  label?: string;
  labelCls?: string;
}

/**
 * Gráfica del REPLAY — read-only y CAUSAL: solo se dibujan las velas hasta el cursor y los objetos
 * que el motor ya conocía en ese instante. El overlay SMC (OB/BSL/SSL/FVG/zona) son divs HTML cuya
 * POSICIÓN se recalcula IMPERATIVAMENTE en un requestAnimationFrame (leyendo las coordenadas vivas
 * del chart) → siguen al gráfico en cualquier pan/zoom/escala, sin depender del re-render de React.
 */
export function ReplayChart({ candles, cursorIdx, tfMs, signals, focused, context, showObs, showLiq, sweeps = [], fvgs = [], liveTail = false }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const prevIdxRef = useRef(-1);
  const prevCandlesRef = useRef<Candle[] | null>(null);
  // Geometría causal vigente (para la proyección del overlay en el rAF, fuera del render de React).
  const geomRef = useRef({ first: 0, cursorOpen: 0, cursorClose: 0, tfMs });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const chart = createChart(host, {
      layout: { background: { type: ColorType.Solid, color: '#0b0c10' }, textColor: '#c7ccd6' },
      grid: { vertLines: { color: '#161922' }, horzLines: { color: '#161922' } },
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: { timeVisible: true, secondsVisible: false, rightOffset: 8, shiftVisibleRangeOnNewBar: true },
      autoSize: true,
    });
    const series = chart.addCandlestickSeries({
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderUpColor: '#26a69a',
      borderDownColor: '#ef5350',
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
    });
    chartRef.current = chart;
    seriesRef.current = series;

    // ── Posicionamiento IMPERATIVO del overlay, cada frame mientras el chart está visible ──
    // Lee las coordenadas VIVAS (logicalToCoordinate / priceToCoordinate) y mueve los divs por DOM.
    // Garantiza que OB/BSL/SSL/FVG sigan al gráfico en cualquier pan/zoom/escala (el rAF se pausa
    // solo cuando la pestaña está oculta). No re-renderiza React: solo toca style de ~12 nodos.
    let raf = 0;
    const position = () => {
      raf = requestAnimationFrame(position);
      const ch = chartRef.current;
      const se = seriesRef.current;
      const ho = hostRef.current;
      const ov = overlayRef.current;
      if (!ch || !se || !ho || !ov) return;
      const g = geomRef.current;
      if (!g.first) return;
      let paneRight = 0;
      let paneBottom = 0;
      try {
        paneRight = ch.priceScale('right').width();
        paneBottom = ch.timeScale().height();
      } catch {
        /* chart sin layout aún */
      }
      ov.style.right = `${paneRight}px`;
      ov.style.bottom = `${paneBottom}px`;
      const hostW = ho.clientWidth;
      const paneHeight = Math.max(ho.clientHeight - paneBottom, 0);
      const tscale = ch.timeScale();
      const xOf = (t: number): number | null => {
        const c = tscale.logicalToCoordinate((((Math.min(t, g.cursorOpen) - g.first) / g.tfMs) as unknown) as Logical);
        return c == null ? null : c;
      };
      const yOf = (price: number): number | null => {
        const c = se.priceToCoordinate(price);
        if (c != null) return c;
        return price > g.cursorClose ? -20 : paneHeight + 20;
      };
      const kids = ov.children;
      for (let i = 0; i < kids.length; i++) {
        const el = kids[i] as HTMLElement;
        const ds = el.dataset;
        const left = xOf(Number(ds.tstart));
        const right = xOf(Number(ds.tend));
        if (left == null || right == null || right < 0 || left > hostW) {
          el.style.display = 'none';
          continue;
        }
        if (ds.kind === 'box') {
          const top = yOf(Number(ds.ptop));
          const bottom = yOf(Number(ds.pbottom));
          if (top == null || bottom == null) {
            el.style.display = 'none';
            continue;
          }
          const w = Math.max(right - left, 2);
          el.style.display = 'block';
          el.style.left = `${left}px`;
          el.style.top = `${top}px`;
          el.style.width = `${w}px`;
          el.style.height = `${Math.max(bottom - top, 2)}px`;
          const lbl = el.firstElementChild as HTMLElement | null;
          if (lbl) lbl.style.display = w > 44 ? '' : 'none';
        } else {
          const y = yOf(Number(ds.price));
          if (y == null || y < 0 || y > paneHeight) {
            el.style.display = 'none';
            continue;
          }
          el.style.display = 'block';
          el.style.left = `${left}px`;
          el.style.top = `${y}px`;
          el.style.width = `${Math.max(right - left, 8)}px`;
        }
      }
    };
    raf = requestAnimationFrame(position);

    return () => {
      cancelAnimationFrame(raf);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      priceLinesRef.current = [];
    };
  }, []);

  const toBar = (c: Candle) => ({
    time: msToUtcSeconds(c.openTime),
    open: c.o,
    high: c.h,
    low: c.l,
    close: c.c,
  });

  // ── Velas hasta el cursor (avance incremental con update; salto/retroceso con setData) ──
  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart || candles.length === 0) return;
    const idx = Math.min(Math.max(cursorIdx, 0), candles.length - 1);
    const prev = prevCandlesRef.current;
    const newWindow = prev !== candles;
    const sameStart = prev != null && prev.length > 0 && prev[0].openTime === candles[0].openTime;
    if (!newWindow && idx === prevIdxRef.current + 1) {
      series.update(toBar(candles[idx]));
    } else if (newWindow && liveTail && sameStart) {
      // Cola VIVA (vista En vivo): el inicio de la ventana NO cambió → solo cambió/creció el final.
      for (let i = Math.max(prevIdxRef.current, 0); i <= idx; i++) series.update(toBar(candles[i]));
    } else {
      series.setData(candles.slice(0, idx + 1).map(toBar));
      if (newWindow) {
        chart.timeScale().resetTimeScale();
        chart.timeScale().scrollToRealTime();
      }
    }
    prevCandlesRef.current = candles;
    prevIdxRef.current = idx;
  }, [candles, cursorIdx, liveTail]);

  // ── Geometría causal vigente (para el rAF del overlay) ──
  useEffect(() => {
    if (candles.length === 0) {
      geomRef.current = { first: 0, cursorOpen: 0, cursorClose: 0, tfMs };
      return;
    }
    const idx = Math.min(Math.max(cursorIdx, 0), candles.length - 1);
    geomRef.current = { first: candles[0].openTime, cursorOpen: candles[idx].openTime, cursorClose: candles[idx].c, tfMs };
  }, [candles, cursorIdx, tfMs]);

  // ── Marcadores y niveles CAUSALES según el cursor ──
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || candles.length === 0) return;
    const idx = Math.min(Math.max(cursorIdx, 0), candles.length - 1);
    const cursorOpen = candles[idx].openTime;

    const markers: SeriesMarker<UTCTimestamp>[] = [];
    for (const s of signals) {
      const phase = signalPhaseAt(s, cursorOpen, tfMs);
      if (phase === 'future') continue;
      const isFocused = focused != null && focused.intentId === s.intentId;
      const long = s.direction === 'LONG';

      if (phase === 'rejected') {
        markers.push({
          time: msToUtcSeconds(s.signalBarTime),
          position: long ? 'belowBar' : 'aboveBar',
          shape: 'circle',
          color: '#4b5563',
          text: isFocused ? `descartada: ${s.reason ?? ''}` : undefined,
          size: isFocused ? 2 : 1,
        });
        continue;
      }

      markers.push({
        time: msToUtcSeconds(s.signalBarTime),
        position: long ? 'belowBar' : 'aboveBar',
        shape: long ? 'arrowUp' : 'arrowDown',
        color: long ? REPLAY_COLORS.long : REPLAY_COLORS.short,
        text: isFocused ? `SEÑAL ${s.direction}` : undefined,
        size: isFocused ? 2 : 1,
      });

      if (isFocused && (phase === 'open' || phase === 'closed') && s.entryTime != null) {
        markers.push({
          time: msToUtcSeconds(s.entryTime),
          position: 'inBar',
          shape: 'circle',
          color: REPLAY_COLORS.entry,
          text: 'FILL',
          size: 1,
        });
      }
      if (isFocused && phase === 'closed' && s.exitTime != null) {
        const exitBarOpen = s.exitTime - tfMs + 1; // exitTime = closeTime de la vela de salida
        const r = s.rMultiple ?? 0;
        markers.push({
          time: msToUtcSeconds(Math.max(exitBarOpen, s.entryTime ?? exitBarOpen)),
          position: 'inBar',
          shape: 'square',
          color: exitColor(s.exitReason),
          text: `${s.exitReason} ${r >= 0 ? '+' : ''}${r.toFixed(2)}R`,
          size: 2,
        });
      }
      if (isFocused && phase === 'dead' && s.endTime != null) {
        markers.push({
          time: msToUtcSeconds(s.endTime - tfMs + 1),
          position: 'inBar',
          shape: 'circle',
          color: REPLAY_COLORS.cancel,
          text: `cancelada: ${s.reason ?? ''}`,
          size: 1,
        });
      }
    }
    // Barridos de liquidez (gatillo del bot): marcador ámbar en la vela del barrido (los recientes).
    for (const sw of sweeps.filter((s) => s.sweepBarTime <= cursorOpen).slice(-12)) {
      markers.push({
        time: msToUtcSeconds(sw.sweepBarTime),
        position: sw.direction === 'bullish' ? 'belowBar' : 'aboveBar',
        shape: 'circle',
        color: '#d6a23b',
        size: 1,
      });
    }
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    series.setMarkers(markers);

    for (const pl of priceLinesRef.current) series.removePriceLine(pl);
    priceLinesRef.current = [];
    if (focused) {
      const phase = signalPhaseAt(focused, cursorOpen, tfMs);
      if (phase !== 'future') {
        const add = (price: number | null, color: string, title: string, dashed = false) => {
          if (price == null) return;
          priceLinesRef.current.push(
            series.createPriceLine({
              price,
              color,
              lineWidth: 1,
              lineStyle: dashed ? LineStyle.Dashed : LineStyle.Solid,
              axisLabelVisible: true,
              title,
            }),
          );
        };
        if (phase === 'rejected') {
          add(focused.zoneHigh, '#4b5563', 'zona (descartada)', true);
          add(focused.zoneLow, '#4b5563', 'zona (descartada)', true);
          add(focused.sweptLevel, REPLAY_COLORS.swept, 'liquidez barrida', true);
        } else {
          add(focused.entry, REPLAY_COLORS.entry, 'entry (límite CE)');
          add(focused.stopLoss, REPLAY_COLORS.sl, 'SL inicial');
          add(focused.takeProfit, REPLAY_COLORS.tp, focused.tpSource ? `TP ${focused.tpSource}` : 'TP');
          add(focused.sweptLevel, REPLAY_COLORS.swept, 'liquidez barrida', true);
          if (phase === 'pending') add(focused.cancelBeyond, REPLAY_COLORS.cancel, 'cancelBeyond', true);
        }
      }
    }
  }, [candles, cursorIdx, tfMs, signals, focused, sweeps]);

  // ── Modelo del overlay (qué dibujar): cambia con los datos/cursor, NO con el pan/zoom ──
  const overlayItems = useMemo<OvItem[]>(() => {
    if (candles.length === 0) return [];
    const idx = Math.min(Math.max(cursorIdx, 0), candles.length - 1);
    const cursorOpen = candles[idx].openTime;
    const cursorClose = candles[idx].c;
    const items: OvItem[] = [];

    if (showObs && context) {
      const visibles = context.obs
        .filter((o) => o.confirmedAtTime <= cursorOpen && (o.invalidatedAt == null || cursorOpen < o.invalidatedAt))
        .sort((a, b) => b.confirmedAtTime - a.confirmedAtTime)
        .slice(0, MAX_OBS);
      for (const o of visibles) {
        const mitigated = o.mitigatedAt != null && cursorOpen >= o.mitigatedAt;
        const bull = o.direction === 'bullish';
        items.push({
          id: o.id,
          kind: 'box',
          cls: `rx-ob ${bull ? 'bull' : 'bear'} ${mitigated ? 'mitigated' : ''}`,
          tstart: o.originTime,
          tend: cursorOpen + tfMs,
          ptop: o.obHigh,
          pbottom: o.obLow,
          label: `OB ${bull ? '▲' : '▼'}`,
          labelCls: 'rx-ob-label',
        });
      }
    }

    if (showLiq && context) {
      const visibles = context.liquidity
        .filter(
          (l) =>
            l.visibleFromTime != null &&
            l.visibleFromTime <= cursorOpen &&
            (l.sweptAtTime == null || cursorOpen <= l.sweptAtTime + SWEPT_LINGER_BARS * tfMs),
        )
        .sort((a, b) => Math.abs(a.level - cursorClose) - Math.abs(b.level - cursorClose))
        .slice(0, MAX_LIQ);
      for (const l of visibles) {
        const swept = l.sweptAtTime != null && cursorOpen >= l.sweptAtTime;
        const tag = l.type === 'equalHigh' ? 'EQH' : l.type === 'equalLow' ? 'EQL' : l.type === 'swingHigh' ? 'BSL' : 'SSL';
        items.push({
          id: l.id,
          kind: 'line',
          cls: `rx-liq ${swept ? 'swept' : ''}`,
          tstart: l.timeStart,
          tend: l.sweptAtTime != null ? Math.min(l.sweptAtTime, cursorOpen) : cursorOpen + tfMs,
          price: l.level,
          label: `${tag}${swept ? ' ✕' : ''}`,
          labelCls: 'rx-liq-label',
        });
      }
    }

    if (fvgs.length) {
      const visibles = fvgs
        .filter((f) => f.state !== 'filled' && f.timeStart <= cursorOpen)
        .sort((a, b) => b.timeStart - a.timeStart)
        .slice(0, 8);
      for (const f of visibles) {
        items.push({
          id: f.id,
          kind: 'box',
          cls: `rx-fvg ${f.direction === 'bullish' ? 'bull' : 'bear'}`,
          tstart: f.timeStart,
          tend: cursorOpen + tfMs,
          ptop: f.gapHigh,
          pbottom: f.gapLow,
          label: 'FVG',
          labelCls: 'rx-fvg-label',
        });
      }
    }

    if (focused && focused.zoneLow != null && focused.zoneHigh != null) {
      const phase = signalPhaseAt(focused, cursorOpen, tfMs);
      if (phase !== 'future') {
        const endT = focused.exitTime ?? focused.endTime ?? cursorOpen + tfMs;
        items.push({
          id: 'focus-zone',
          kind: 'box',
          cls: `rx-zone ${focused.direction === 'LONG' ? 'bull' : 'bear'} ${phase === 'rejected' ? 'rejected' : ''}`,
          tstart: focused.signalBarTime,
          tend: Math.min(endT, cursorOpen + tfMs),
          ptop: focused.zoneHigh,
          pbottom: focused.zoneLow,
        });
      }
    }

    return items;
  }, [candles, cursorIdx, tfMs, context, fvgs, focused, showObs, showLiq]);

  return (
    <div className="replay-chart-wrap">
      <div className="replay-chart" ref={hostRef} />
      <div className="replay-overlay" ref={overlayRef}>
        {overlayItems.map((it) => (
          <div
            key={it.id}
            className={it.cls}
            data-kind={it.kind}
            data-tstart={it.tstart}
            data-tend={it.tend}
            data-ptop={it.ptop}
            data-pbottom={it.pbottom}
            data-price={it.price}
            style={{ display: 'none' }}
          >
            {it.label && <span className={it.labelCls}>{it.label}</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
