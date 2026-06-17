import { useEffect, useRef, useState } from 'react';
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

/**
 * Gráfica del REPLAY — read-only y CAUSAL: solo se dibujan las velas hasta el cursor y los objetos
 * que el motor ya conocía en ese instante (señal al cierre de su vela; OB desde su BOS; liquidez
 * desde la confirmación de su pivote). Nada se pinta hacia atrás: si un detector tuviera lookahead,
 * AQUÍ se vería.
 */
export function ReplayChart({ candles, cursorIdx, tfMs, signals, focused, context, showObs, showLiq, sweeps = [], fvgs = [], liveTail = false }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const prevIdxRef = useRef(-1);
  const prevCandlesRef = useRef<Candle[] | null>(null);
  // Precios de referencia (constantes por ventana) para detectar cambios de la escala VERTICAL.
  const refPricesRef = useRef<[number, number] | null>(null);
  // El overlay se re-proyecta ante CUALQUIER cambio de viewport: pan, zoom horizontal, zoom del eje
  // de precio, autoescala y resize. Como la escala de precio no emite eventos en v4, un loop rAF
  // compara una FIRMA del viewport y solo re-renderiza cuando cambió (en reposo no hace nada).
  const [viewNonce, setViewNonce] = useState(0);

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

    // El overlay (OB/BSL/SSL/FVG) son divs HTML que hay que RE-PROYECTAR cada vez que el chart se mueve
    // (pan horizontal, pan del eje de precio, zoom, autoescala). Lightweight-charts NO emite evento para
    // la escala de precio, así que en vez de adivinar con una "firma" del viewport —frágil: en ciertos
    // pan/zoom no cambiaba y el overlay se quedaba ESTÁTICO— re-proyectamos en CADA frame mientras el
    // chart está montado/visible. Coste mínimo: solo recalcula ~12 divs; React no toca el DOM si las
    // posiciones no cambiaron; y `requestAnimationFrame` se pausa solo cuando la pestaña está oculta.
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      setViewNonce((n) => (n + 1) & 0xffff); // cambia siempre → fuerza el re-render que re-proyecta el overlay
    };
    raf = requestAnimationFrame(tick);

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
      // Cola VIVA (vista En vivo): el inicio de la ventana NO cambió → solo cambió/creció el final
      // (vela en formación o cierre). Actualiza por el final con series.update SIN resetear el
      // timescale → se ve el movimiento en tiempo real y se preserva el zoom/pan del usuario.
      for (let i = Math.max(prevIdxRef.current, 0); i <= idx; i++) series.update(toBar(candles[i]));
    } else {
      series.setData(candles.slice(0, idx + 1).map(toBar));
      if (newWindow) {
        chart.timeScale().resetTimeScale();
        chart.timeScale().scrollToRealTime();
      }
    }
    // Referencias verticales de la firma del viewport (constantes por ventana).
    refPricesRef.current = [candles[0].l, candles[0].h];
    prevCandlesRef.current = candles;
    prevIdxRef.current = idx;
  }, [candles, cursorIdx, liveTail]);

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

  // ── Overlay de CONTEXTO SMC (rectángulos/niveles), proyectado al viewport actual ──
  const chart = chartRef.current;
  const series = seriesRef.current;
  let overlay: React.ReactNode = null;
  void viewNonce; // el nonce solo fuerza el re-render en pan/zoom/resize
  let paneRight = 0;
  let paneBottom = 0;
  if (chart && series && candles.length > 0) {
    const idx = Math.min(Math.max(cursorIdx, 0), candles.length - 1);
    const cursorOpen = candles[idx].openTime;
    const cursorClose = candles[idx].c;
    const first = candles[0].openTime;
    const host = hostRef.current;
    // El overlay se recorta al PANE de velas (sin invadir el eje de precio ni el de tiempo).
    try {
      paneRight = chart.priceScale('right').width();
      paneBottom = chart.timeScale().height();
    } catch {
      /* chart aún sin layout: 0 */
    }
    const paneHeight = Math.max((host?.clientHeight ?? 0) - paneBottom, 0);

    const xOf = (t: number): number | null => {
      const logical = (Math.min(t, cursorOpen) - first) / tfMs;
      const coord = chart.timeScale().logicalToCoordinate(logical as Logical);
      return coord == null ? null : coord;
    };
    const yOf = (price: number): number | null => {
      const c = series.priceToCoordinate(price);
      if (c != null) return c;
      return price > cursorClose ? -20 : paneHeight + 20; // fuera del rango visible: clamp recortado
    };

    const items: React.ReactNode[] = [];

    if (showObs && context) {
      const visibles = context.obs
        .filter((o) => o.confirmedAtTime <= cursorOpen && (o.invalidatedAt == null || cursorOpen < o.invalidatedAt))
        .sort((a, b) => b.confirmedAtTime - a.confirmedAtTime)
        .slice(0, MAX_OBS);
      for (const o of visibles) {
        const left = xOf(o.originTime);
        const right = xOf(cursorOpen + tfMs); // proyección viva hasta el cursor
        const top = yOf(o.obHigh);
        const bottom = yOf(o.obLow);
        if (left == null || right == null || top == null || bottom == null) continue;
        if (right < 0 || left > (host?.clientWidth ?? 0)) continue;
        const mitigated = o.mitigatedAt != null && cursorOpen >= o.mitigatedAt;
        const bull = o.direction === 'bullish';
        items.push(
          <div
            key={o.id}
            className={`rx-ob ${bull ? 'bull' : 'bear'} ${mitigated ? 'mitigated' : ''}`}
            style={{ left, top, width: Math.max(right - left, 2), height: Math.max(bottom - top, 2) }}
          >
            {right - left > 46 && <span className="rx-ob-label">OB {bull ? '▲' : '▼'}</span>}
          </div>,
        );
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
        const left = xOf(l.timeStart);
        const right = xOf(l.sweptAtTime != null ? Math.min(l.sweptAtTime, cursorOpen) : cursorOpen + tfMs);
        const y = yOf(l.level);
        if (left == null || right == null || y == null || y < 0 || y > paneHeight) continue;
        const swept = l.sweptAtTime != null && cursorOpen >= l.sweptAtTime;
        // Etiquetas de liquidez SMC: EQH/EQL (equal highs/lows) · BSL/SSL (buy/sell-side liquidity en
        // swings). NO usar "SL" suelto: se confunde con Stop-Loss.
        const tag = l.type === 'equalHigh' ? 'EQH' : l.type === 'equalLow' ? 'EQL' : l.type === 'swingHigh' ? 'BSL' : 'SSL';
        items.push(
          <div
            key={l.id}
            className={`rx-liq ${swept ? 'swept' : ''}`}
            style={{ left, top: y, width: Math.max(right - left, 8) }}
          >
            <span className="rx-liq-label">{tag}{swept ? ' ✕' : ''}</span>
          </div>,
        );
      }
    }

    // FVG (Fair Value Gaps) sin llenar — contexto de estudio (no es el gatillo). Cian/rosa.
    if (fvgs.length) {
      const visibles = fvgs
        .filter((f) => f.state !== 'filled' && f.timeStart <= cursorOpen)
        .sort((a, b) => b.timeStart - a.timeStart)
        .slice(0, 8);
      for (const f of visibles) {
        const left = xOf(f.timeStart);
        const right = xOf(cursorOpen + tfMs);
        const top = yOf(f.gapHigh);
        const bottom = yOf(f.gapLow);
        if (left == null || right == null || top == null || bottom == null) continue;
        if (right < 0 || left > (host?.clientWidth ?? 0)) continue;
        items.push(
          <div
            key={f.id}
            className={`rx-fvg ${f.direction === 'bullish' ? 'bull' : 'bear'}`}
            style={{ left, top, width: Math.max(right - left, 2), height: Math.max(bottom - top, 2) }}
          >
            {right - left > 40 && <span className="rx-fvg-label">FVG</span>}
          </div>,
        );
      }
    }

    // Banda de la zona del sweep de la señal enfocada (de la vela del sweep hasta su resolución).
    if (focused && focused.zoneLow != null && focused.zoneHigh != null) {
      const phase = signalPhaseAt(focused, cursorOpen, tfMs);
      if (phase !== 'future') {
        const endT = focused.exitTime ?? focused.endTime ?? cursorOpen + tfMs;
        const left = xOf(focused.signalBarTime);
        const right = xOf(Math.min(endT, cursorOpen + tfMs));
        const top = yOf(focused.zoneHigh);
        const bottom = yOf(focused.zoneLow);
        if (left != null && right != null && top != null && bottom != null) {
          items.push(
            <div
              key="focus-zone"
              className={`rx-zone ${focused.direction === 'LONG' ? 'bull' : 'bear'} ${phase === 'rejected' ? 'rejected' : ''}`}
              style={{ left, top, width: Math.max(right - left, 2), height: Math.max(bottom - top, 2) }}
            />,
          );
        }
      }
    }

    overlay = (
      <div className="replay-overlay" style={{ right: paneRight, bottom: paneBottom }}>
        {items}
      </div>
    );
  }

  return (
    <div className="replay-chart-wrap">
      <div className="replay-chart" ref={hostRef} />
      {overlay}
    </div>
  );
}
