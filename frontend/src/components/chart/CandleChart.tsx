import { useEffect, useRef } from 'react';
import {
  createChart,
  ColorType,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type LogicalRange,
  type Logical,
} from 'lightweight-charts';
import type { Candle } from '../../features/candles/candles.types';
import { msToUtcSeconds } from '../../lib/time';

interface Props {
  candles: Candle[];
  // Cambia con (symbol, tf): si cambió → fitContent; si no y crecieron las velas → prepend
  // (preservar la vista desplazando el rango lógico por las velas añadidas a la izquierda).
  viewKey: string;
  onHover?: (candle: Candle | null) => void;
}

export function CandleChart({ candles, viewKey, onHover }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;
  const bySecond = useRef<Map<number, Candle>>(new Map());
  const prevViewKey = useRef<string>('');
  const prevLen = useRef(0);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#0e0f14' },
        textColor: '#c7ccd6',
      },
      grid: {
        vertLines: { color: '#1b1e27' },
        horzLines: { color: '#1b1e27' },
      },
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#2a2e3a' },
      rightPriceScale: { borderColor: '#2a2e3a' },
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

    chart.subscribeCrosshairMove((param) => {
      const cb = onHoverRef.current;
      if (!cb) return;
      if (param.time === undefined) {
        cb(null);
        return;
      }
      cb(bySecond.current.get(param.time as number) ?? null);
    });

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;

    const map = new Map<number, Candle>();
    const data = candles.map((c) => {
      const t = msToUtcSeconds(c.openTime);
      map.set(t as number, c);
      return { time: t, open: c.o, high: c.h, low: c.l, close: c.c };
    });
    bySecond.current = map;

    const isFresh = viewKey !== prevViewKey.current;
    const added = candles.length - prevLen.current;
    let range: LogicalRange | null = null;
    if (!isFresh && added > 0) range = chart.timeScale().getVisibleLogicalRange();

    series.setData(data);

    if (isFresh) {
      chart.timeScale().fitContent();
    } else if (range && added > 0) {
      // Se añadieron `added` velas al inicio → desplazar el rango visible para no saltar.
      chart.timeScale().setVisibleLogicalRange({
        from: (range.from + added) as Logical,
        to: (range.to + added) as Logical,
      });
    }

    prevViewKey.current = viewKey;
    prevLen.current = candles.length;
  }, [candles, viewKey]);

  return <div ref={containerRef} className="candle-chart" />;
}
