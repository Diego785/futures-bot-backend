import { useEffect, useRef, useState } from 'react';
import {
  createChart,
  ColorType,
  CrosshairMode,
  type IChartApi,
  type ISeriesApi,
  type LogicalRange,
  type Logical,
} from 'lightweight-charts';
import type { Candle, Timeframe } from '../../features/candles/candles.types';
import {
  isZoneKind,
  MARK_COLORS,
  type ManualMark,
  type ManualMarkKind,
  type ManualTool,
} from '../../features/manual-marks/manualMarks.types';
import type { NewMarkInput } from '../../features/manual-marks/marks.util';
import { msToUtcSeconds, tfToMs } from '../../lib/time';

interface Props {
  candles: Candle[];
  viewKey: string;
  liveBar?: Candle | null;
  marks: ManualMark[];
  tool: ManualTool;
  selectedId: string | null;
  layerVisible: boolean;
  symbol: string;
  tf: Timeframe;
  onHover?: (candle: Candle | null) => void;
  onCreateMark: (input: NewMarkInput) => void;
  onSelectMark: (id: string | null) => void;
  onUpdateMark: (id: string, patch: Partial<ManualMark>) => void;
  onDeleteMark: (id: string) => void;
}

type HandlePart = 'l' | 'r' | 't' | 'b' | 'tl' | 'tr' | 'bl' | 'br';
const HANDLES: HandlePart[] = ['l', 'r', 't', 'b', 'tl', 'tr', 'bl', 'br'];

interface ZoneGeom { type: 'zone'; id: string; kind: ManualMarkKind; left: number; top: number; right: number; bottom: number; }
interface LevelGeom { type: 'level'; id: string; kind: ManualMarkKind; y: number; }
type Geom = ZoneGeom | LevelGeom;

interface Hit { id: string; part: 'body' | 'line' | HandlePart }
type Drag =
  | { kind: 'move'; id: string; sx: number; sy: number; orig: Geom }
  | { kind: 'resize'; id: string; handle: HandlePart; sx: number; sy: number; orig: ZoneGeom }
  | { kind: 'draw-zone'; sx: number; sy: number }
  | { kind: 'draw-level' };

const HANDLE_HIT = 9;
const LINE_HIT = 6;
const MIN_DRAW = 4;

function handleCenter(left: number, top: number, right: number, bottom: number, h: HandlePart): { x: number; y: number } {
  const mx = (left + right) / 2;
  const my = (top + bottom) / 2;
  switch (h) {
    case 'l': return { x: left, y: my };
    case 'r': return { x: right, y: my };
    case 't': return { x: mx, y: top };
    case 'b': return { x: mx, y: bottom };
    case 'tl': return { x: left, y: top };
    case 'tr': return { x: right, y: top };
    case 'bl': return { x: left, y: bottom };
    case 'br': return { x: right, y: bottom };
  }
}

function cursorFor(part: Hit['part']): string {
  switch (part) {
    case 'l': case 'r': return 'ew-resize';
    case 't': case 'b': case 'line': return 'ns-resize';
    case 'tl': case 'br': return 'nwse-resize';
    case 'tr': case 'bl': return 'nesw-resize';
    default: return 'move';
  }
}

export function CandleChart(props: Props) {
  const { candles, viewKey, liveBar, marks, tool, selectedId, layerVisible } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const bySecond = useRef<Map<number, Candle>>(new Map());
  const prevViewKey = useRef('');
  const prevLen = useRef(0);

  const stateRef = useRef(props);
  stateRef.current = props;
  const spaceHeld = useRef(false);
  const dragRef = useRef<Drag | null>(null);
  const emptyDown = useRef<{ x: number; y: number } | null>(null);
  const geomsRef = useRef<Geom[]>([]);

  const [geoms, setGeoms] = useState<Geom[]>([]);
  geomsRef.current = geoms;
  const [draft, setDraft] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
  const [hoverPart, setHoverPart] = useState<Hit['part'] | null>(null);

  function pxToPrice(y: number): number | null {
    return seriesRef.current?.coordinateToPrice(y) ?? null;
  }
  // Mapeo tiempo↔coordenada vía índice LÓGICO: cubre el espacio futuro a la derecha
  // (donde no hay vela y coordinateToTime devolvería null) sin clamp a la última vela.
  function pxToMs(x: number): number {
    const ts = chartRef.current?.timeScale();
    const cs = stateRef.current.candles;
    if (!ts || cs.length === 0) return 0;
    const lg = ts.coordinateToLogical(x);
    const lastMs = cs[cs.length - 1].openTime;
    if (lg == null) return lastMs;
    return Math.round(lastMs + (Number(lg) - (cs.length - 1)) * tfToMs(stateRef.current.tf));
  }
  function msToPx(ms: number): number | null {
    const ts = chartRef.current?.timeScale();
    const cs = stateRef.current.candles;
    if (!ts || cs.length === 0) return null;
    const lastMs = cs[cs.length - 1].openTime;
    const logical = ((cs.length - 1) + (ms - lastMs) / tfToMs(stateRef.current.tf)) as Logical;
    return ts.logicalToCoordinate(logical);
  }
  function localXY(e: React.PointerEvent): { x: number; y: number } {
    const r = containerRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function computeGeoms(): Geom[] {
    const chart = chartRef.current;
    const series = seriesRef.current;
    const s = stateRef.current;
    if (!chart || !series || !s.layerVisible) return [];
    const out: Geom[] = [];
    for (const m of s.marks) {
      if (isZoneKind(m.kind)) {
        if (m.timeStart == null || m.priceHigh == null) continue;
        const x1 = msToPx(m.timeStart);
        const x2 = msToPx(m.timeEnd ?? m.timeStart);
        const yH = series.priceToCoordinate(m.priceHigh);
        const yL = series.priceToCoordinate(m.priceLow ?? m.priceHigh);
        if (x1 == null || x2 == null || yH == null || yL == null) continue;
        out.push({ type: 'zone', id: m.id, kind: m.kind, left: Math.min(x1, x2), right: Math.max(x1, x2), top: Math.min(yH, yL), bottom: Math.max(yH, yL) });
      } else {
        if (m.price == null) continue;
        const y = series.priceToCoordinate(m.price);
        if (y == null) continue;
        out.push({ type: 'level', id: m.id, kind: m.kind, y });
      }
    }
    return out;
  }
  function recompute(): void {
    if (dragRef.current) return;
    setGeoms(computeGeoms());
  }

  function hitTest(x: number, y: number): Hit | null {
    const sel = stateRef.current.selectedId;
    const list = geomsRef.current;
    const selGeom = list.find((g) => g.id === sel && g.type === 'zone') as ZoneGeom | undefined;
    if (selGeom) {
      for (const h of HANDLES) {
        const c = handleCenter(selGeom.left, selGeom.top, selGeom.right, selGeom.bottom, h);
        if (Math.abs(x - c.x) <= HANDLE_HIT && Math.abs(y - c.y) <= HANDLE_HIT) return { id: selGeom.id, part: h };
      }
    }
    for (let i = list.length - 1; i >= 0; i--) {
      const g = list[i];
      if (g.type === 'zone' && x >= g.left && x <= g.right && y >= g.top && y <= g.bottom) return { id: g.id, part: 'body' };
    }
    for (let i = list.length - 1; i >= 0; i--) {
      const g = list[i];
      if (g.type === 'level' && Math.abs(y - g.y) <= LINE_HIT) return { id: g.id, part: 'line' };
    }
    return null;
  }

  // ── init ──
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: '#0e0f14' }, textColor: '#c7ccd6' },
      grid: { vertLines: { color: '#1b1e27' }, horzLines: { color: '#1b1e27' } },
      crosshair: { mode: CrosshairMode.Normal },
      // rightOffset deja espacio vacío a la derecha para proyectar zonas/posiciones al futuro.
      timeScale: { timeVisible: true, secondsVisible: false, borderColor: '#2a2e3a', rightOffset: 12 },
      rightPriceScale: { borderColor: '#2a2e3a' },
    });
    const series = chart.addCandlestickSeries({
      upColor: '#26a69a', downColor: '#ef5350', borderUpColor: '#26a69a',
      borderDownColor: '#ef5350', wickUpColor: '#26a69a', wickDownColor: '#ef5350',
    });
    chartRef.current = chart;
    seriesRef.current = series;
    chart.subscribeCrosshairMove((param) => {
      const cb = stateRef.current.onHover;
      if (!cb) return;
      cb(param.time === undefined ? null : bySecond.current.get(param.time as number) ?? null);
    });
    const ro = new ResizeObserver(() => recompute());
    ro.observe(el);
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => recompute());

    const onKey = (e: KeyboardEvent) => {
      const s = stateRef.current;
      if (e.key === ' ') {
        spaceHeld.current = true;
      } else if (e.key === 'Escape') {
        dragRef.current = null;
        setDraft(null);
        s.onSelectMark(null);
        recompute();
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        const tag = (document.activeElement?.tagName ?? '').toLowerCase();
        if (tag === 'input' || tag === 'textarea') return;
        if (s.selectedId) s.onDeleteMark(s.selectedId);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => { if (e.key === ' ') spaceHeld.current = false; };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);

    return () => {
      ro.disconnect();
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── datos históricos ──
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
      chart.timeScale().setVisibleLogicalRange({ from: (range.from + added) as Logical, to: (range.to + added) as Logical });
    prevViewKey.current = viewKey;
    prevLen.current = candles.length;
    recompute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candles, viewKey]);

  // ── vela viva ──
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !liveBar || prevLen.current === 0) return;
    const t = msToUtcSeconds(liveBar.openTime);
    series.update({ time: t, open: liveBar.o, high: liveBar.h, low: liveBar.l, close: liveBar.c });
    bySecond.current.set(t as number, liveBar);
    recompute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveBar]);

  useEffect(() => {
    recompute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marks, layerVisible, selectedId]);

  function setChartInteractive(on: boolean): void {
    chartRef.current?.applyOptions({ handleScroll: on, handleScale: on });
  }

  function applyDragGeom(d: Drag, x: number, y: number): Geom | null {
    if (d.kind === 'move') {
      const dx = x - d.sx, dy = y - d.sy;
      if (d.orig.type === 'zone') return { ...d.orig, left: d.orig.left + dx, right: d.orig.right + dx, top: d.orig.top + dy, bottom: d.orig.bottom + dy };
      return { ...d.orig, y: d.orig.y + dy };
    }
    if (d.kind === 'resize') {
      const dx = x - d.sx, dy = y - d.sy;
      const g: ZoneGeom = { ...d.orig };
      if (d.handle.includes('l')) g.left = d.orig.left + dx;
      if (d.handle.includes('r')) g.right = d.orig.right + dx;
      if (d.handle.includes('t')) g.top = d.orig.top + dy;
      if (d.handle.includes('b')) g.bottom = d.orig.bottom + dy;
      return g;
    }
    return null;
  }

  function onPointerDown(e: React.PointerEvent): void {
    if (e.button !== 0) return;
    const s = stateRef.current;
    const { x, y } = localXY(e);
    emptyDown.current = null;
    if (spaceHeld.current) return; // pan con Space

    const hit = hitTest(x, y);
    if (hit) {
      e.preventDefault();
      hostRef.current?.setPointerCapture(e.pointerId);
      setChartInteractive(false);
      s.onSelectMark(hit.id);
      const g = geomsRef.current.find((gg) => gg.id === hit.id);
      if (!g) return;
      if (hit.part === 'body' || hit.part === 'line') dragRef.current = { kind: 'move', id: hit.id, sx: x, sy: y, orig: g };
      else if (g.type === 'zone') dragRef.current = { kind: 'resize', id: hit.id, handle: hit.part, sx: x, sy: y, orig: g };
      return;
    }
    if (tool !== 'Select') {
      e.preventDefault();
      hostRef.current?.setPointerCapture(e.pointerId);
      setChartInteractive(false);
      dragRef.current = isZoneKind(tool) ? { kind: 'draw-zone', sx: x, sy: y } : { kind: 'draw-level' };
      if (dragRef.current.kind === 'draw-level') setDraft({ left: 0, top: y - 1, width: containerRef.current?.clientWidth ?? 0, height: 2 });
      return;
    }
    emptyDown.current = { x, y }; // Select sobre vacío: posible deselección
  }

  function onPointerMove(e: React.PointerEvent): void {
    const d = dragRef.current;
    const { x, y } = localXY(e);
    if (!d) {
      const hit = hitTest(x, y);
      setHoverPart(hit ? hit.part : null);
      return;
    }
    if (d.kind === 'draw-zone') {
      setDraft({ left: Math.min(d.sx, x), top: Math.min(d.sy, y), width: Math.abs(x - d.sx), height: Math.abs(y - d.sy) });
      return;
    }
    if (d.kind === 'draw-level') {
      setDraft({ left: 0, top: y - 1, width: containerRef.current?.clientWidth ?? 0, height: 2 });
      return;
    }
    const ng = applyDragGeom(d, x, y);
    if (ng) setGeoms((prev) => prev.map((g) => (g.id === d.id ? ng : g)));
  }

  function onPointerUp(e: React.PointerEvent): void {
    const d = dragRef.current;
    const s = stateRef.current;
    const { x, y } = localXY(e);
    hostRef.current?.releasePointerCapture?.(e.pointerId);

    if (!d) {
      if (tool === 'Select' && emptyDown.current) {
        const dist = Math.hypot(x - emptyDown.current.x, y - emptyDown.current.y);
        if (dist < MIN_DRAW) s.onSelectMark(null);
      }
      emptyDown.current = null;
      return;
    }
    dragRef.current = null;
    setChartInteractive(true);

    if (d.kind === 'draw-zone') {
      setDraft(null);
      if (Math.abs(x - d.sx) < MIN_DRAW && Math.abs(y - d.sy) < MIN_DRAW) return;
      const ph = pxToPrice(Math.min(d.sy, y));
      const pl = pxToPrice(Math.max(d.sy, y));
      if (ph == null || pl == null) return;
      s.onCreateMark({ kind: tool as ManualMarkKind, symbol: s.symbol, tf: s.tf, timeStart: pxToMs(Math.min(d.sx, x)), timeEnd: pxToMs(Math.max(d.sx, x)), priceHigh: ph, priceLow: pl });
      return;
    }
    if (d.kind === 'draw-level') {
      setDraft(null);
      const price = pxToPrice(y);
      if (price != null) s.onCreateMark({ kind: tool as ManualMarkKind, symbol: s.symbol, tf: s.tf, price });
      return;
    }
    const ng = applyDragGeom(d, x, y);
    if (ng && ng.type === 'zone') {
      s.onUpdateMark(d.id, {
        timeStart: pxToMs(Math.min(ng.left, ng.right)),
        timeEnd: pxToMs(Math.max(ng.left, ng.right)),
        priceHigh: pxToPrice(Math.min(ng.top, ng.bottom)) ?? undefined,
        priceLow: pxToPrice(Math.max(ng.top, ng.bottom)) ?? undefined,
      });
    } else if (ng && ng.type === 'level') {
      const price = pxToPrice(ng.y);
      if (price != null) s.onUpdateMark(d.id, { price });
    }
    recompute();
  }

  const overlayCursor = tool !== 'Select' ? 'crosshair' : hoverPart ? cursorFor(hoverPart) : 'default';

  return (
    <div
      ref={hostRef}
      className="chart-host"
      style={{ cursor: overlayCursor }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div ref={containerRef} className="candle-chart" />
      {layerVisible && (
        <div className="marks-layer">
          {geoms.map((g) => {
            const color = MARK_COLORS[g.kind];
            const selected = g.id === selectedId;
            if (g.type === 'zone') {
              const w = g.right - g.left;
              const h = g.bottom - g.top;
              return (
                <div key={g.id} className={`zone-mark${selected ? ' selected' : ''}`} style={{ left: g.left, top: g.top, width: w, height: h, borderColor: color, background: color + (selected ? '33' : '1f') }}>
                  <span className="mark-label" style={{ color }}>{g.kind}</span>
                  {g.kind === 'FVG' && <div className="fvg-mid" style={{ borderColor: color }} />}
                  {selected && HANDLES.map((hp) => {
                    const c = handleCenter(0, 0, w, h, hp);
                    return <span key={hp} className="zone-handle" style={{ left: c.x, top: c.y, borderColor: color }} />;
                  })}
                </div>
              );
            }
            return (
              <div key={g.id} className={`level-line${selected ? ' selected' : ''}`} style={{ top: g.y, borderColor: color }}>
                <span className="mark-label level" style={{ color, background: color + '22' }}>{g.kind}</span>
              </div>
            );
          })}
        </div>
      )}
      {draft && <div className="draw-draft" style={{ left: draft.left, top: draft.top, width: draft.width, height: draft.height }} />}
    </div>
  );
}
