import { useEffect, useRef } from 'react';
import {
  createChart,
  ColorType,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type CandlestickData,
} from 'lightweight-charts';
import type { Candle } from '../../features/candles/candles.types';
import { msToUtcSeconds } from '../../lib/time';

export interface HoverOhlc {
  o: number;
  h: number;
  l: number;
  c: number;
}

interface Props {
  candles: Candle[];
  onHover?: (ohlc: HoverOhlc | null) => void;
}

/**
 * Gráfica de velas (motor: TradingView Lightweight Charts). Zoom/pan/crosshair vienen
 * nativos de la librería. El chart se crea una vez; los datos se actualizan por separado.
 * Las capas de overlay (OB/FVG/señales/marcas) se montarán sobre este chart en slices futuros.
 */
export function CandleChart({ candles, onHover }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  // Mantener el callback fresco sin re-crear el chart en cada render.
  const onHoverRef = useRef(onHover);
  onHoverRef.current = onHover;

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
      const data = param.seriesData.get(series) as CandlestickData | undefined;
      if (!data || param.time === undefined) {
        cb(null);
        return;
      }
      cb({ o: data.open, h: data.high, l: data.low, c: data.close });
    });

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    series.setData(
      candles.map((c) => ({
        time: msToUtcSeconds(c.openTime),
        open: c.o,
        high: c.h,
        low: c.l,
        close: c.c,
      })),
    );
    chartRef.current?.timeScale().fitContent();
  }, [candles]);

  return <div ref={containerRef} className="candle-chart" />;
}
