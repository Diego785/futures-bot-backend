import { useEffect, useRef } from 'react';
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
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
import { msToUtcSeconds } from '../../lib/time';

interface Props {
  candles: Candle[]; // ventana completa cargada (ascendente)
  cursorIdx: number; // índice de la ÚLTIMA vela visible (vela cerrada donde está parado el replay)
  tfMs: number;
  signals: BacktestSignal[]; // señales a dibujar (el padre decide cuáles; la fase causal se evalúa aquí)
  focused: BacktestSignal | null; // señal bajo auditoría (lleva niveles y marcadores extra)
}

/**
 * Gráfica del REPLAY (V.2) — read-only y CAUSAL: solo se dibujan las velas hasta el cursor y los
 * eventos que el motor ya conocía en ese instante (señal al cierre de su vela; fill/salida cuando
 * ocurren). Nada se pinta hacia atrás: si un detector tuviera lookahead, AQUÍ se vería.
 */
export function ReplayChart({ candles, cursorIdx, tfMs, signals, focused }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const prevIdxRef = useRef(-1);
  const prevCandlesRef = useRef<Candle[] | null>(null);

  // ── Chart una sola vez ──
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
    return () => {
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
    const newWindow = prevCandlesRef.current !== candles;
    if (!newWindow && idx === prevIdxRef.current + 1) {
      series.update(toBar(candles[idx]));
    } else {
      series.setData(candles.slice(0, idx + 1).map(toBar));
      if (newWindow) {
        chart.timeScale().resetTimeScale();
        chart.timeScale().scrollToRealTime();
      }
    }
    prevCandlesRef.current = candles;
    prevIdxRef.current = idx;
  }, [candles, cursorIdx]);

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

      // Señal conocida (al cierre de su vela): flecha direccional. Color por estado final una vez
      // que el cursor ya lo vio; antes, color de dirección (el replay no adelanta el desenlace).
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
    markers.sort((a, b) => (a.time as number) - (b.time as number));
    series.setMarkers(markers);

    // Niveles de la señal ENFOCADA (auditoría): entry/SL/TP + nivel barrido + cancelBeyond.
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
          add(focused.takeProfit, REPLAY_COLORS.tp, 'TP 2R');
          add(focused.sweptLevel, REPLAY_COLORS.swept, 'liquidez barrida', true);
          if (phase === 'pending') add(focused.cancelBeyond, REPLAY_COLORS.cancel, 'cancelBeyond', true);
        }
      }
    }
  }, [candles, cursorIdx, tfMs, signals, focused]);

  return <div className="replay-chart" ref={hostRef} />;
}
