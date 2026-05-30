import { useEffect, useRef, useState } from 'react';
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type LogicalRange,
  type Logical,
} from 'lightweight-charts';
import type { Candle, Timeframe } from '../../features/candles/candles.types';
import {
  isZoneKind,
  MARK_COLORS,
  type ManualMark,
  type ManualTool,
} from '../../features/manual-marks/manualMarks.types';
import type { NewMarkInput } from '../../features/manual-marks/marks.util';
import { msToUtcSeconds } from '../../lib/time';

interface Props {
  candles: Candle[];
  viewKey: string;
  liveBar?: Candle | null;
  marks: ManualMark[]; // ya filtradas a (symbol, tf) por el padre
  tool: ManualTool;
  selectedId: string | null;
  layerVisible: boolean;
  symbol: string;
  tf: Timeframe;
  onHover?: (candle: Candle | null) => void;
  onCreateMark: (input: NewMarkInput) => void;
  onSelectMark: (id: string | null) => void;
}

interface ZoneRect {
  id: string;
  kind: ManualMark['kind'];
  left: number;
  top: number;
  width: number;
  height: number;
  selected: boolean;
}

export function CandleChart(props: Props) {
  const { candles, viewKey, liveBar, marks, tool, layerVisible } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const priceLinesRef = useRef<Map<string, IPriceLine>>(new Map());
  const bySecond = useRef<Map<number, Candle>>(new Map());
  const prevViewKey = useRef('');
  const prevLen = useRef(0);

  // Props frescas para callbacks imperativos (subscripciones creadas una sola vez).
  const stateRef = useRef(props);
  stateRef.current = props;

  const [zoneRects, setZoneRects] = useState<ZoneRect[]>([]);
  const [draft, setDraft] = useState<{ x1: number; y1: number; x2: number; y2: number } | null>(null);
  const drawing = useRef(false);

  // ── recomputar posiciones de zonas (OB/FVG) en píxeles ──
  function recomputeZones(): void {
    const chart = chartRef.current;
    const series = seriesRef.current;
    const s = stateRef.current;
    if (!chart || !series || !s.layerVisible) {
      setZoneRects([]);
      return;
    }
    const ts = chart.timeScale();
    const rects: ZoneRect[] = [];
    for (const m of s.marks) {
      if (!isZoneKind(m.kind) || m.timeStart == null || m.priceHigh == null) continue;
      const x1 = ts.timeToCoordinate(msToUtcSeconds(m.timeStart));
      const x2 = ts.timeToCoordinate(msToUtcSeconds(m.timeEnd ?? m.timeStart));
      const y1 = series.priceToCoordinate(m.priceHigh);
      const y2 = series.priceToCoordinate(m.priceLow ?? m.priceHigh);
      if (x1 == null || x2 == null || y1 == null || y2 == null) continue;
      rects.push({
        id: m.id,
        kind: m.kind,
        left: Math.min(x1, x2),
        top: Math.min(y1, y2),
        width: Math.max(2, Math.abs(x2 - x1)),
        height: Math.max(2, Math.abs(y2 - y1)),
        selected: m.id === s.selectedId,
      });
    }
    setZoneRects(rects);
  }

  // ── sincronizar líneas de precio (Liquidity/Entry/SL/TP) ──
  function syncPriceLines(): void {
    const series = seriesRef.current;
    if (!series) return;
    const s = stateRef.current;
    for (const line of priceLinesRef.current.values()) series.removePriceLine(line);
    priceLinesRef.current.clear();
    if (!s.layerVisible) return;
    for (const m of s.marks) {
      if (isZoneKind(m.kind) || m.price == null) continue;
      const selected = m.id === s.selectedId;
      const line = series.createPriceLine({
        price: m.price,
        color: MARK_COLORS[m.kind],
        lineWidth: selected ? 2 : 1,
        lineStyle: m.kind === 'Entry' ? LineStyle.Solid : LineStyle.Dashed,
        axisLabelVisible: true,
        title: m.kind + (m.note ? ` · ${m.note}` : ''),
      });
      priceLinesRef.current.set(m.id, line);
    }
  }

  // ── init del chart (una vez) ──
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#0e0f14' }, textColor: '#c7ccd6' },
      grid: { vertLines: { color: '#1b1e27' }, horzLines: { color: '#1b1e27' } },
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
      const cb = stateRef.current.onHover;
      if (!cb) return;
      if (param.time === undefined) return cb(null);
      cb(bySecond.current.get(param.time as number) ?? null);
    });

    const ro = new ResizeObserver(() => recomputeZones());
    ro.observe(el);
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => recomputeZones());

    return () => {
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      priceLinesRef.current.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── datos históricos (setData + fit/preserve) ──
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
    if (isFresh) chart.timeScale().fitContent();
    else if (range && added > 0)
      chart.timeScale().setVisibleLogicalRange({
        from: (range.from + added) as Logical,
        to: (range.to + added) as Logical,
      });
    prevViewKey.current = viewKey;
    prevLen.current = candles.length;
    recomputeZones();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, viewKey]);

  // ── vela viva (update incremental) ──
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !liveBar || prevLen.current === 0) return;
    const t = msToUtcSeconds(liveBar.openTime);
    series.update({ time: t, open: liveBar.o, high: liveBar.h, low: liveBar.l, close: liveBar.c });
    bySecond.current.set(t as number, liveBar);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveBar]);

  // ── marcas (re-sincronizar líneas + zonas) ──
  useEffect(() => {
    syncPriceLines();
    recomputeZones();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marks, layerVisible, props.selectedId]);

  // ── dibujo: helpers de coordenadas ──
  function localXY(e: React.PointerEvent): { x: number; y: number } {
    const rect = containerRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
  function xToMs(x: number): number {
    const t = chartRef.current?.timeScale().coordinateToTime(x);
    if (t != null) return Number(t) * 1000;
    const cs = stateRef.current.candles;
    return cs.length ? cs[cs.length - 1].openTime : 0;
  }
  function yToPrice(y: number): number | null {
    return seriesRef.current?.coordinateToPrice(y) ?? null;
  }

  function onPointerDown(e: React.PointerEvent): void {
    if (tool === 'Select') return;
    if (isZoneKind(tool)) {
      const { x, y } = localXY(e);
      drawing.current = true;
      setDraft({ x1: x, y1: y, x2: x, y2: y });
      (e.target as Element).setPointerCapture?.(e.pointerId);
    }
  }
  function onPointerMove(e: React.PointerEvent): void {
    if (!drawing.current || !draft) return;
    const { x, y } = localXY(e);
    setDraft((d) => (d ? { ...d, x2: x, y2: y } : d));
  }
  function onPointerUp(e: React.PointerEvent): void {
    const s = stateRef.current;
    const t = s.tool;
    if (t === 'Select') return;
    const { y } = localXY(e);

    if (isZoneKind(t)) {
      drawing.current = false;
      const d = draft;
      setDraft(null);
      if (!d) return;
      const ph = yToPrice(d.y1);
      const pl = yToPrice(d.y2);
      if (ph == null || pl == null) return;
      if (Math.abs(d.x2 - d.x1) < 4 && Math.abs(d.y2 - d.y1) < 4) return; // demasiado pequeño
      s.onCreateMark({
        kind: t,
        symbol: s.symbol,
        tf: s.tf,
        timeStart: xToMs(d.x1),
        timeEnd: xToMs(d.x2),
        priceHigh: ph,
        priceLow: pl,
      });
    } else {
      // nivel: crear al precio del click
      const price = yToPrice(y);
      if (price == null) return;
      s.onCreateMark({ kind: t, symbol: s.symbol, tf: s.tf, price });
    }
  }

  const overlayActive = tool !== 'Select';

  return (
    <div className="chart-host">
      <div ref={containerRef} className="candle-chart" />

      {/* zonas OB/FVG */}
      {layerVisible &&
        zoneRects.map((z) => (
          <div
            key={z.id}
            className={`zone-mark${z.selected ? ' selected' : ''}`}
            style={{
              left: z.left,
              top: z.top,
              width: z.width,
              height: z.height,
              borderColor: MARK_COLORS[z.kind],
              background: MARK_COLORS[z.kind] + (z.selected ? '33' : '1f'),
              pointerEvents: tool === 'Select' ? 'auto' : 'none',
            }}
            onClick={() => props.onSelectMark(z.id)}
          />
        ))}

      {/* preview de dibujo */}
      {draft && (
        <div
          className="draw-draft"
          style={{
            left: Math.min(draft.x1, draft.x2),
            top: Math.min(draft.y1, draft.y2),
            width: Math.abs(draft.x2 - draft.x1),
            height: Math.abs(draft.y2 - draft.y1),
          }}
        />
      )}

      {/* capa de captura para dibujar (solo activa con herramienta != Select) */}
      <div
        className="draw-overlay"
        style={{ pointerEvents: overlayActive ? 'auto' : 'none', cursor: overlayActive ? 'crosshair' : 'default' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
    </div>
  );
}
