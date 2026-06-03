import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
  isPlanKind,
  computeRR,
  MARK_COLORS,
  type ManualMark,
  type ManualMarkKind,
  type ManualTool,
} from '../../features/manual-marks/manualMarks.types';
import type { NewMarkInput } from '../../features/manual-marks/marks.util';
import { FVG_COLORS, type BotFvg } from '../../features/bot-analysis/botFvg.types';
import { OB_COLORS, OB_BREAKER_COLORS, isBrokenOb, breakerDirection, type BotOb } from '../../features/bot-analysis/botOb.types';
import { LIQ_COLOR, type BotLiquidity } from '../../features/bot-analysis/botLiquidity.types';
import { CONF_DIR_COLORS, type ConfluenceZone } from '../../features/bot-analysis/botConfluence.types';
import { SETUP_DIR_COLORS, type BotSetup } from '../../features/bot-analysis/botSetup.types';
import { PLAN_SIDE_COLORS, type BotTradePlan } from '../../features/bot-analysis/botTradePlan.types';
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
  // Petición de centrar la vista en una marca (desde la lista del workspace). nonce re-dispara
  // aunque sea la misma marca.
  focusRequest?: { id: string; nonce: number } | null;
  // Capas de lectura automática del bot (5A FVG, 5B OB): read-only, solo seleccionables.
  botFvgs: BotFvg[];
  botObs: BotOb[];
  botLiqs: BotLiquidity[];
  botConfluences: ConfluenceZone[];
  botSetups: BotSetup[];
  botPlans: BotTradePlan[];
  botFvgVisible: boolean;
  botObVisible: boolean;
  botLiqVisible: boolean;
  botConfVisible: boolean;
  botSetupVisible: boolean;
  botPlanConfVisible: boolean;
  botPlanRiskVisible: boolean;
  selectedBotId: string | null;
  onSelectBot: (id: string | null) => void;
}

type HandlePart = 'l' | 'r' | 't' | 'b' | 'tl' | 'tr' | 'bl' | 'br';
const HANDLES: HandlePart[] = ['l', 'r', 't', 'b', 'tl', 'tr', 'bl', 'br'];
type PlanPart = 'entry' | 'sl' | 'tp' | 'plan-body';

interface ZoneGeom { type: 'zone'; id: string; kind: ManualMarkKind; left: number; top: number; right: number; bottom: number; }
interface LevelGeom { type: 'level'; id: string; kind: ManualMarkKind; y: number; }
interface PlanGeom { type: 'plan'; id: string; side: 'LONG' | 'SHORT'; left: number; right: number; yEntry: number; ySL: number; yTP: number; }
type Geom = ZoneGeom | LevelGeom | PlanGeom;
// Geometría de una zona del bot (FVG u OB), read-only. color/label precalculados para el render.
interface BotGeom { id: string; kind: 'fvg' | 'ob' | 'liq' | 'conf' | 'setup'; left: number; right: number; top: number; bottom: number; color: string; label: string; tag?: string; }
// Plan del bot: 3 niveles (entry/sl/tp) → render tipo posición (read-only).
interface BotPlanGeom { id: string; side: 'LONG' | 'SHORT'; mode: 'confirmation' | 'risk'; left: number; right: number; yEntry: number; ySL: number; yTP: number; label: string; minRrMet: boolean; }

interface Hit { id: string; part: 'body' | 'line' | HandlePart | PlanPart }
type Drag =
  | { kind: 'move'; id: string; sx: number; sy: number; orig: Geom }
  | { kind: 'resize'; id: string; handle: HandlePart; sx: number; sy: number; orig: ZoneGeom }
  | { kind: 'plan-move'; id: string; sx: number; sy: number; orig: PlanGeom }
  | { kind: 'plan-line'; id: string; line: 'entry' | 'sl' | 'tp'; sx: number; sy: number; orig: PlanGeom }
  | { kind: 'draw-zone'; sx: number; sy: number }
  | { kind: 'draw-level' }
  | { kind: 'draw-plan'; side: 'LONG' | 'SHORT' };

const HANDLE_HIT = 9;
const LINE_HIT = 6;
const MIN_DRAW = 4;
// Plan nuevo: SL a 0.5 % de la entrada, TP a 1.0 % (R:R 2.0) y ~12 velas de ancho.
const DEFAULT_RISK_FRAC = 0.005;
const DEFAULT_PLAN_BARS = 12;

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
    case 't': case 'b': case 'line':
    case 'entry': case 'sl': case 'tp': return 'ns-resize';
    case 'tl': case 'br': return 'nwse-resize';
    case 'tr': case 'bl': return 'nesw-resize';
    default: return 'move';
  }
}

function fmtPrice(p: number | null): string {
  if (p == null) return '—';
  const abs = Math.abs(p);
  const dec = abs >= 1000 ? 1 : abs >= 1 ? 2 : 4;
  return p.toFixed(dec);
}

export function CandleChart(props: Props) {
  const { candles, viewKey, liveBar, marks, tool, selectedId, layerVisible, focusRequest } = props;
  const { botFvgs, botObs, botLiqs, botConfluences, botSetups, botPlans, botFvgVisible, botObVisible, botLiqVisible, botConfVisible, botSetupVisible, botPlanConfVisible, botPlanRiskVisible, selectedBotId } = props;
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
  const botGeomsRef = useRef<BotGeom[]>([]);
  const botPlanGeomsRef = useRef<BotPlanGeom[]>([]);
  // Sincronización de overlays con el transform del chart (Slice 3A.1-c).
  const overlayRafRef = useRef<number | null>(null); // recompute coalescente (1/frame)
  const gestureRafRef = useRef<number | null>(null); // loop RAF mientras dura un gesto
  const gestureTailRef = useRef(0); // frames restantes de "cola de inercia" tras soltar
  const wheelStopRef = useRef<number | null>(null); // debounce para terminar el gesto de wheel
  const lastSigRef = useRef<string>(''); // firma de la última geometría (diff-guard)

  const [geoms, setGeoms] = useState<Geom[]>([]);
  geomsRef.current = geoms;
  const [botGeoms, setBotGeoms] = useState<BotGeom[]>([]);
  botGeomsRef.current = botGeoms;
  const [botPlanGeoms, setBotPlanGeoms] = useState<BotPlanGeom[]>([]);
  botPlanGeomsRef.current = botPlanGeoms;
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
        continue;
      }
      if (isPlanKind(m.kind)) {
        if (m.entry == null || m.stopLoss == null || m.takeProfit == null) continue;
        const x1 = msToPx(m.timeStart ?? 0);
        const x2 = msToPx(m.timeEnd ?? m.timeStart ?? 0);
        const yE = series.priceToCoordinate(m.entry);
        const yS = series.priceToCoordinate(m.stopLoss);
        const yT = series.priceToCoordinate(m.takeProfit);
        if (x1 == null || x2 == null || yE == null || yS == null || yT == null) continue;
        out.push({ type: 'plan', id: m.id, side: m.side ?? 'LONG', left: Math.min(x1, x2), right: Math.max(x1, x2), yEntry: yE, ySL: yS, yTP: yT });
        continue;
      }
      if (m.price == null) continue;
      const y = series.priceToCoordinate(m.price);
      if (y == null) continue;
      out.push({ type: 'level', id: m.id, kind: m.kind, y });
    }
    return out;
  }

  // Geometría de los FVG del bot. Solo gaps ACTIVOS (no filled). Se proyectan hacia la derecha
  // hasta el BORDE del área de gráfico (timeScale().width(), que incluye el espacio futuro del
  // rightOffset), no hasta la última vela: un FVG sin mitigar sigue vigente hacia el futuro,
  // como un "ray" a la derecha. Esto es solo render; la detección causal no cambia.
  function computeBotGeoms(): BotGeom[] {
    const chart = chartRef.current;
    const series = seriesRef.current;
    const s = stateRef.current;
    if (!chart || !series || s.candles.length === 0) return [];
    const rightEdge = chart.timeScale().width(); // px: borde derecho de las velas (tras rightOffset)
    const out: BotGeom[] = [];
    // Proyecta una zona [priceLow, priceHigh] desde su origen hasta el borde derecho (ray).
    const pushZone = (id: string, kind: 'fvg' | 'ob' | 'liq' | 'conf' | 'setup', timeStart: number, priceLow: number, priceHigh: number, color: string, label: string, tag?: string) => {
      const x1 = msToPx(timeStart);
      if (x1 == null || x1 > rightEdge) return; // origen aún no en vista → no proyectar atrás
      const yH = series.priceToCoordinate(priceHigh);
      const yL = series.priceToCoordinate(priceLow);
      if (yH == null || yL == null) return;
      out.push({ id, kind, left: x1, right: rightEdge, top: Math.min(yH, yL), bottom: Math.max(yH, yL), color, label, tag });
    };
    if (s.botFvgVisible) {
      for (const f of s.botFvgs) {
        if (f.state === 'filled') continue; // solo gaps activos
        pushZone(f.id, 'fvg', f.timeStart, f.gapLow, f.gapHigh, FVG_COLORS[f.direction], `FVG ${f.direction === 'bullish' ? '▲' : '▼'}`);
      }
    }
    if (s.botObVisible) {
      for (const o of s.botObs) {
        if (isBrokenOb(o.state)) {
          // Breaker Block (Video 3): OB roto → POI con función INVERTIDA (compra roto → resistencia;
          // venta roto → soporte). Se dibuja con la dirección ya invertida + estilo punteado (tag).
          const inv = breakerDirection(o.direction);
          pushZone(o.id, 'ob', o.timeStart, o.obLow, o.obHigh, OB_BREAKER_COLORS[inv], `BB ${inv === 'bullish' ? '▲' : '▼'}`, 'breaker');
        } else {
          pushZone(o.id, 'ob', o.timeStart, o.obLow, o.obHigh, OB_COLORS[o.direction], `OB ${o.direction === 'bullish' ? '▲' : '▼'}`);
        }
      }
    }
    if (s.botLiqVisible) {
      for (const l of s.botLiqs) {
        const short = l.side === 'buyside' ? 'BSL' : 'SSL'; // buy-/sell-side liquidity
        const eq = l.type === 'equalHigh' || l.type === 'equalLow' ? ` ×${l.touches}` : '';
        // Nivel = línea: priceLow === priceHigh === level → top === bottom.
        pushZone(l.id, 'liq', l.timeStart, l.level, l.level, LIQ_COLOR, `${short}${eq}`);
      }
    }
    if (s.botConfVisible) {
      // Al final → se dibuja ENCIMA (marco que resalta la zona base). Color por DIRECCIÓN
      // (sesgo operativo), grosor por rating, label con LONG/SHORT ctx.
      for (const z of s.botConfluences) {
        const bias = z.direction === 'bullish' ? 'LONG' : 'SHORT';
        pushZone(z.id, 'conf', z.timeStart, z.priceLow, z.priceHigh, CONF_DIR_COLORS[z.direction], `★ ${bias} ctx ${z.score}`, z.rating);
      }
    }
    if (s.botSetupVisible) {
      for (const su of s.botSetups) {
        const bias = su.direction === 'bullish' ? 'LONG' : 'SHORT';
        // tag = estado → estilo del borde (CSS .setup-watching/mitigated/armed).
        pushZone(su.id, 'setup', su.timeStart, su.priceLow, su.priceHigh, SETUP_DIR_COLORS[su.direction], `${bias} · ${su.state}`, su.state);
      }
    }
    return out;
  }

  // Geometría de los planes del bot (3 niveles). Se proyectan a la derecha (ray).
  function computeBotPlanGeoms(): BotPlanGeom[] {
    const chart = chartRef.current;
    const series = seriesRef.current;
    const s = stateRef.current;
    if (!chart || !series || s.candles.length === 0) return [];
    const rightEdge = chart.timeScale().width();
    const out: BotPlanGeom[] = [];
    for (const p of s.botPlans) {
      const modeOn = p.mode === 'risk' ? s.botPlanRiskVisible : s.botPlanConfVisible;
      if (!modeOn && p.id !== s.selectedBotId) continue; // el seleccionado siempre se dibuja (lo eliges en la lista)
      const x1 = msToPx(p.timeStart);
      if (x1 == null || x1 > rightEdge) continue;
      const yE = series.priceToCoordinate(p.entry);
      const yS = series.priceToCoordinate(p.stopLoss);
      const yT = series.priceToCoordinate(p.takeProfit);
      if (yE == null || yS == null || yT == null) continue;
      out.push({ id: p.id, side: p.side, mode: p.mode, left: x1, right: rightEdge, yEntry: yE, ySL: yS, yTP: yT, label: `BOT ${p.mode === 'risk' ? 'RISK ' : ''}${p.side} · R:R ${p.rr}`, minRrMet: p.minRrMet });
    }
    return out;
  }

  // Firma en píxeles enteros: si no cambia, la geometría visible es idéntica.
  function geomSignature(gs: Geom[]): string {
    let s = '';
    for (const g of gs) {
      if (g.type === 'zone') s += `z${g.id}:${Math.round(g.left)},${Math.round(g.top)},${Math.round(g.right)},${Math.round(g.bottom)};`;
      else if (g.type === 'level') s += `l${g.id}:${Math.round(g.y)};`;
      else s += `p${g.id}:${Math.round(g.left)},${Math.round(g.right)},${Math.round(g.yEntry)},${Math.round(g.ySL)},${Math.round(g.yTP)};`;
    }
    return s;
  }
  function botSignature(gs: BotGeom[]): string {
    let s = '';
    for (const g of gs) s += `${g.id}:${Math.round(g.left)},${Math.round(g.top)},${Math.round(g.right)},${Math.round(g.bottom)};`;
    return s;
  }
  function planSignature(gs: BotPlanGeom[]): string {
    let s = '';
    for (const g of gs) s += `${g.id}:${Math.round(g.left)},${Math.round(g.yEntry)},${Math.round(g.ySL)},${Math.round(g.yTP)};`;
    return s;
  }
  function combinedSignature(manual: Geom[], bot: BotGeom[], plans: BotPlanGeom[]): string {
    return geomSignature(manual) + '#' + botSignature(bot) + '#' + planSignature(plans);
  }

  // Recalcula la geometría YA. Diff-guard: si en píxeles enteros nada cambió no hace
  // setState — así el loop de gesto puede correr a 60 fps sin meter renders/lag.
  function recomputeNow(): void {
    if (dragRef.current) return; // durante un drag propio, onPointerMove fija la geometría
    const next = computeGeoms();
    const nextBot = computeBotGeoms();
    const nextPlans = computeBotPlanGeoms();
    const sig = combinedSignature(next, nextBot, nextPlans);
    if (sig === lastSigRef.current) return;
    lastSigRef.current = sig;
    setGeoms(next);
    setBotGeoms(nextBot);
    setBotPlanGeoms(nextPlans);
  }
  // Coalescente: a lo sumo un recompute por frame (para eventos sueltos).
  function scheduleOverlayRecompute(): void {
    if (overlayRafRef.current != null) return;
    overlayRafRef.current = requestAnimationFrame(() => {
      overlayRafRef.current = null;
      recomputeNow();
    });
  }
  function recompute(): void { scheduleOverlayRecompute(); }

  // Recompute SÍNCRONO para cambios DISCRETOS de datos (crear/borrar/editar una marca).
  // Va por useLayoutEffect (antes del paint): la marca aparece/desaparece al instante, sin
  // depender de que un RAF/gesto posterior la refresque. Cancela el RAF coalescente pendiente
  // para no recalcular dos veces.
  function recomputeImmediate(): void {
    if (dragRef.current) return; // no pelea con un drag propio en curso
    const next = computeGeoms();
    const nextBot = computeBotGeoms();
    const nextPlans = computeBotPlanGeoms();
    const sig = combinedSignature(next, nextBot, nextPlans);
    if (sig === lastSigRef.current) return; // p.ej. cambio de selección: geometría idéntica
    if (overlayRafRef.current != null) {
      cancelAnimationFrame(overlayRafRef.current);
      overlayRafRef.current = null;
    }
    lastSigRef.current = sig;
    setGeoms(next);
    setBotGeoms(nextBot);
    setBotPlanGeoms(nextPlans);
  }

  // Loop RAF temporal para gestos del chart que NO emiten evento — sobre todo el
  // arrastre VERTICAL de la escala de precio (cambia precio→Y sin disparar
  // subscribeVisibleLogicalRangeChange; ver issue lightweight-charts #1442).
  function gestureTick(): void {
    recomputeNow();
    if (gestureTailRef.current > 0) {
      gestureTailRef.current -= 1;
      if (gestureTailRef.current === 0) {
        // Fin de la cola de inercia: para el loop y deja un recompute limpio final.
        if (gestureRafRef.current != null) cancelAnimationFrame(gestureRafRef.current);
        gestureRafRef.current = null;
        lastSigRef.current = '';
        scheduleOverlayRecompute();
        return;
      }
    }
    gestureRafRef.current = requestAnimationFrame(gestureTick);
  }
  function startGestureLoop(): void {
    gestureTailRef.current = 0; // gesto ACTIVO (pointer abajo): sin cuenta atrás
    if (gestureRafRef.current != null) return;
    gestureRafRef.current = requestAnimationFrame(gestureTick);
  }
  function endGestureLoop(): void {
    // No cortar de golpe: deja una cola (~0.6s) para seguir la INERCIA/momentum del chart (táctil),
    // donde el gráfico sigue moviéndose tras soltar el dedo. Sin esto, los overlays se "pegan".
    if (gestureRafRef.current == null) return;
    if (gestureTailRef.current === 0) gestureTailRef.current = 36;
  }

  // Hit-test de FVGs del bot (read-only): punto dentro del rect (con alto mínimo clicable).
  function hitTestBot(x: number, y: number): string | null {
    const list = botGeomsRef.current;
    for (let i = list.length - 1; i >= 0; i--) {
      const g = list[i];
      if (x < g.left || x > g.right) continue;
      if (g.kind === 'liq') {
        if (Math.abs(y - g.top) <= 5) return g.id; // línea: banda simétrica
      } else {
        const bottom = Math.max(g.bottom, g.top + 4);
        if (y >= g.top && y <= bottom) return g.id;
      }
    }
    const plans = botPlanGeomsRef.current;
    for (let i = plans.length - 1; i >= 0; i--) {
      const g = plans[i];
      if (x < g.left || x > g.right) continue;
      const top = Math.min(g.yEntry, g.ySL, g.yTP);
      const bottom = Math.max(g.yEntry, g.ySL, g.yTP);
      if (y >= top && y <= bottom) return g.id;
    }
    return null;
  }

  function hitTest(x: number, y: number): Hit | null {
    const sel = stateRef.current.selectedId;
    const list = geomsRef.current;
    // 1) Handles de la zona seleccionada (precisos, máxima prioridad).
    const selGeom = list.find((g) => g.id === sel && g.type === 'zone') as ZoneGeom | undefined;
    if (selGeom) {
      for (const h of HANDLES) {
        const c = handleCenter(selGeom.left, selGeom.top, selGeom.right, selGeom.bottom, h);
        if (Math.abs(x - c.x) <= HANDLE_HIT && Math.abs(y - c.y) <= HANDLE_HIT) return { id: selGeom.id, part: h };
      }
    }
    // 2) Líneas de cualquier plan (entry/sl/tp) dentro de su rango horizontal.
    for (let i = list.length - 1; i >= 0; i--) {
      const g = list[i];
      if (g.type !== 'plan') continue;
      if (x < g.left - LINE_HIT || x > g.right + LINE_HIT) continue;
      if (Math.abs(y - g.yEntry) <= LINE_HIT) return { id: g.id, part: 'entry' };
      if (Math.abs(y - g.ySL) <= LINE_HIT) return { id: g.id, part: 'sl' };
      if (Math.abs(y - g.yTP) <= LINE_HIT) return { id: g.id, part: 'tp' };
    }
    // 3) Cuerpo de zonas.
    for (let i = list.length - 1; i >= 0; i--) {
      const g = list[i];
      if (g.type === 'zone' && x >= g.left && x <= g.right && y >= g.top && y <= g.bottom) return { id: g.id, part: 'body' };
    }
    // 4) Cuerpo del plan (mover grupo completo).
    for (let i = list.length - 1; i >= 0; i--) {
      const g = list[i];
      if (g.type !== 'plan') continue;
      const top = Math.min(g.yEntry, g.ySL, g.yTP);
      const bottom = Math.max(g.yEntry, g.ySL, g.yTP);
      if (x >= g.left && x <= g.right && y >= top && y <= bottom) return { id: g.id, part: 'plan-body' };
    }
    // 5) Niveles (Liquidity).
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

    // ── Sincronización de overlays durante gestos del chart (Slice 3A.1-c) ──
    // pointerdown en CAPTURA: arranca el loop pase lo que pase (incl. arrastre del eje
    // de precio), aunque lightweight-charts detenga la propagación del evento.
    const onAreaPointerDown = () => startGestureLoop();
    el.addEventListener('pointerdown', onAreaPointerDown, true);
    // wheel: zoom de tiempo o de precio → loop con debounce de fin.
    const onAreaWheel = () => {
      startGestureLoop();
      if (wheelStopRef.current != null) clearTimeout(wheelStopRef.current);
      wheelStopRef.current = window.setTimeout(() => { wheelStopRef.current = null; endGestureLoop(); }, 180);
    };
    el.addEventListener('wheel', onAreaWheel, { capture: true, passive: true });
    // El gesto termina con el pointer GLOBAL (el chart puede capturar el puntero).
    const onWinPointerUp = () => endGestureLoop();
    window.addEventListener('pointerup', onWinPointerUp);
    window.addEventListener('pointercancel', onWinPointerUp);

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
      el.removeEventListener('pointerdown', onAreaPointerDown, true);
      el.removeEventListener('wheel', onAreaWheel, true);
      window.removeEventListener('pointerup', onWinPointerUp);
      window.removeEventListener('pointercancel', onWinPointerUp);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      if (overlayRafRef.current != null) cancelAnimationFrame(overlayRafRef.current);
      if (gestureRafRef.current != null) cancelAnimationFrame(gestureRafRef.current);
      if (wheelStopRef.current != null) clearTimeout(wheelStopRef.current);
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

  // ── centrar la vista en una marca (workspace) ──
  useEffect(() => {
    if (!focusRequest) return;
    const chart = chartRef.current;
    const cs = stateRef.current.candles;
    if (!chart || cs.length === 0) return;
    // Centra una marca manual o un plan del bot (al elegirlo en la lista).
    const m = stateRef.current.marks.find((x) => x.id === focusRequest.id);
    let t: number | null = null;
    if (m) {
      t = m.timeStart != null ? (m.timeEnd != null ? (m.timeStart + m.timeEnd) / 2 : m.timeStart) : null;
    } else {
      const pl = stateRef.current.botPlans.find((x) => x.id === focusRequest.id);
      if (pl) t = pl.timeStart;
    }
    if (t == null) return;
    const lastMs = cs[cs.length - 1].openTime;
    const logical = (cs.length - 1) + (t - lastMs) / tfToMs(stateRef.current.tf);
    const range = chart.timeScale().getVisibleLogicalRange();
    const span = range ? range.to - range.from : 80;
    chart.timeScale().setVisibleLogicalRange({
      from: (logical - span / 2) as Logical,
      to: (logical + span / 2) as Logical,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusRequest?.nonce]);

  // Cambios discretos de datos (marcas/visibilidad/selección/herramienta): recompute
  // SÍNCRONO antes del paint, para que crear/borrar se vea de inmediato sin un click extra.
  useLayoutEffect(() => {
    recomputeImmediate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marks, layerVisible, selectedId, tool, botFvgs, botObs, botLiqs, botConfluences, botSetups, botPlans, botFvgVisible, botObVisible, botLiqVisible, botConfVisible, botSetupVisible, botPlanConfVisible, botPlanRiskVisible, selectedBotId]);

  function setChartInteractive(on: boolean): void {
    chartRef.current?.applyOptions({ handleScroll: on, handleScale: on });
  }

  function applyDragGeom(d: Drag, x: number, y: number): Geom | null {
    if (d.kind === 'move') {
      const dx = x - d.sx, dy = y - d.sy;
      if (d.orig.type === 'zone') return { ...d.orig, left: d.orig.left + dx, right: d.orig.right + dx, top: d.orig.top + dy, bottom: d.orig.bottom + dy };
      if (d.orig.type === 'level') return { ...d.orig, y: d.orig.y + dy };
      return d.orig;
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
    if (d.kind === 'plan-move') {
      const dx = x - d.sx, dy = y - d.sy;
      return { ...d.orig, left: d.orig.left + dx, right: d.orig.right + dx, yEntry: d.orig.yEntry + dy, ySL: d.orig.ySL + dy, yTP: d.orig.yTP + dy };
    }
    if (d.kind === 'plan-line') {
      const dy = y - d.sy;
      const g: PlanGeom = { ...d.orig };
      if (d.line === 'entry') g.yEntry = d.orig.yEntry + dy;
      else if (d.line === 'sl') g.ySL = d.orig.ySL + dy;
      else g.yTP = d.orig.yTP + dy;
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
      if ((hit.part === 'entry' || hit.part === 'sl' || hit.part === 'tp') && g.type === 'plan') {
        dragRef.current = { kind: 'plan-line', id: hit.id, line: hit.part, sx: x, sy: y, orig: g };
      } else if (hit.part === 'plan-body' && g.type === 'plan') {
        dragRef.current = { kind: 'plan-move', id: hit.id, sx: x, sy: y, orig: g };
      } else if (hit.part === 'body' || hit.part === 'line') {
        dragRef.current = { kind: 'move', id: hit.id, sx: x, sy: y, orig: g };
      } else if (g.type === 'zone') {
        dragRef.current = { kind: 'resize', id: hit.id, handle: hit.part as HandlePart, sx: x, sy: y, orig: g };
      }
      return;
    }
    // FVG del bot: solo seleccionable (read-only). No captura ni arrastra; si el usuario
    // arrastra, el chart paneará normalmente. Solo en modo Select para no estorbar al dibujar.
    if (tool === 'Select' && (s.botFvgVisible || s.botObVisible || s.botLiqVisible || s.botConfVisible || s.botSetupVisible || s.botPlanConfVisible || s.botPlanRiskVisible)) {
      const botId = hitTestBot(x, y);
      if (botId) {
        s.onSelectBot(botId);
        emptyDown.current = null;
        return;
      }
    }
    if (tool !== 'Select') {
      e.preventDefault();
      hostRef.current?.setPointerCapture(e.pointerId);
      setChartInteractive(false);
      if (tool === 'OB' || tool === 'FVG') {
        dragRef.current = { kind: 'draw-zone', sx: x, sy: y };
      } else if (tool === 'Liquidity') {
        dragRef.current = { kind: 'draw-level' };
        setDraft({ left: 0, top: y - 1, width: containerRef.current?.clientWidth ?? 0, height: 2 });
      } else {
        dragRef.current = { kind: 'draw-plan', side: tool === 'Long' ? 'LONG' : 'SHORT' };
      }
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
    if (d.kind === 'draw-plan') return; // se crea al soltar (un clic)
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
      if (price != null) s.onCreateMark({ kind: 'Liquidity', symbol: s.symbol, tf: s.tf, price });
      return;
    }
    if (d.kind === 'draw-plan') {
      const entry = pxToPrice(y);
      if (entry == null) return;
      const side = d.side;
      const sl = side === 'LONG' ? entry * (1 - DEFAULT_RISK_FRAC) : entry * (1 + DEFAULT_RISK_FRAC);
      const tp = side === 'LONG' ? entry * (1 + 2 * DEFAULT_RISK_FRAC) : entry * (1 - 2 * DEFAULT_RISK_FRAC);
      const tStart = pxToMs(x);
      const tEnd = tStart + DEFAULT_PLAN_BARS * tfToMs(s.tf);
      s.onCreateMark({ kind: 'TradePlan', symbol: s.symbol, tf: s.tf, side, entry, stopLoss: sl, takeProfit: tp, timeStart: tStart, timeEnd: tEnd });
      return;
    }
    // Click sin arrastre real sobre una marca: fue selección (ya hecha en pointerdown), no
    // edición. Evita un PATCH redundante y una entrada de undo espuria por round-trip de floats.
    if ('sx' in d && Math.hypot(x - d.sx, y - d.sy) < MIN_DRAW) {
      recompute();
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
    } else if (ng && ng.type === 'plan') {
      s.onUpdateMark(d.id, {
        entry: pxToPrice(ng.yEntry) ?? undefined,
        stopLoss: pxToPrice(ng.ySL) ?? undefined,
        takeProfit: pxToPrice(ng.yTP) ?? undefined,
        timeStart: pxToMs(Math.min(ng.left, ng.right)),
        timeEnd: pxToMs(Math.max(ng.left, ng.right)),
      });
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
      <div className="bot-layer">
          {botGeoms.map((g) => {
            const selected = g.id === selectedBotId;
            if (g.kind === 'liq') {
              // Nivel = línea horizontal (border-top), no caja.
              return (
                <div
                  key={g.id}
                  className={`bot-zone liq${selected ? ' selected' : ''}`}
                  style={{ left: g.left, top: g.top, width: g.right - g.left, borderColor: g.color }}
                >
                  <span className="bot-zone-label" style={{ color: g.color }}>{g.label}</span>
                </div>
              );
            }
            const h = Math.max(3, g.bottom - g.top);
            // Confluencia = marco sin relleno (deja ver el OB/FVG debajo); el resto, caja con fondo.
            const bg = g.kind === 'conf' ? 'transparent' : g.color + (selected ? '38' : '14');
            const tagClass = g.tag ? ` ${g.kind}-${g.tag.toLowerCase()}` : '';
            const labelClass = g.kind === 'conf' ? 'conf-label' : g.kind === 'setup' ? 'setup-label' : 'bot-zone-label';
            return (
              <div
                key={g.id}
                className={`bot-zone ${g.kind}${tagClass}${selected ? ' selected' : ''}`}
                style={{ left: g.left, top: g.top, width: g.right - g.left, height: h, borderColor: g.color, background: bg }}
              >
                <span className={labelClass} style={{ color: g.color }}>{g.label}</span>
              </div>
            );
          })}
          {[...botPlanGeoms]
            .sort((a, b) => (a.id === selectedBotId ? 1 : 0) - (b.id === selectedBotId ? 1 : 0))
            .map((g) => {
              const sel = g.id === selectedBotId;
              const color = PLAN_SIDE_COLORS[g.side];
              const w = g.right - g.left;
              // Atenúa los no seleccionados y solo etiqueta el seleccionado → evita el solapamiento.
              return (
                <div key={g.id} style={{ opacity: sel ? 1 : 0.28 }}>
                  <div className="bot-plan-reward" style={{ left: g.left, top: Math.min(g.yEntry, g.yTP), width: w, height: Math.abs(g.yTP - g.yEntry) }} />
                  <div className="bot-plan-risk" style={{ left: g.left, top: Math.min(g.yEntry, g.ySL), width: w, height: Math.abs(g.ySL - g.yEntry) }} />
                  <div className="bot-plan-line tp" style={{ left: g.left, top: g.yTP, width: w }} />
                  <div className="bot-plan-line sl" style={{ left: g.left, top: g.ySL, width: w }} />
                  <div className={`bot-plan-line entry${g.mode === 'risk' ? ' risk' : ''}${sel ? ' selected' : ''}`} style={{ left: g.left, top: g.yEntry, width: w, borderColor: color }}>
                    {sel && <span className="bot-plan-label" style={{ color }}>{g.label}{g.minRrMet ? '' : ' ⚠'}</span>}
                  </div>
                </div>
              );
            })}
        </div>
      {layerVisible && (
        <div className="marks-layer">
          {geoms.map((g) => {
            const selected = g.id === selectedId;
            if (g.type === 'zone') {
              const color = MARK_COLORS[g.kind];
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
            if (g.type === 'plan') {
              const w = g.right - g.left;
              const eP = pxToPrice(g.yEntry);
              const sP = pxToPrice(g.ySL);
              const tP = pxToPrice(g.yTP);
              const rr = eP != null && sP != null && tP != null ? computeRR(eP, sP, tP) : null;
              const cw = containerRef.current?.clientWidth ?? 0;
              const rrLeft = Math.min(g.right + 6, Math.max(0, cw - 96));
              const sel = selected ? ' selected' : '';
              return (
                <Fragment key={g.id}>
                  <div className={`plan-reward${sel}`} style={{ left: g.left, top: Math.min(g.yEntry, g.yTP), width: w, height: Math.abs(g.yTP - g.yEntry) }} />
                  <div className={`plan-risk${sel}`} style={{ left: g.left, top: Math.min(g.yEntry, g.ySL), width: w, height: Math.abs(g.ySL - g.yEntry) }} />
                  <div className={`plan-line entry${sel}`} style={{ left: g.left, top: g.yEntry, width: w }}>
                    <span className="plan-tag entry">Entry {fmtPrice(eP)}</span>
                  </div>
                  <div className={`plan-line sl${sel}`} style={{ left: g.left, top: g.ySL, width: w }}>
                    <span className="plan-tag sl">SL {fmtPrice(sP)}</span>
                  </div>
                  <div className={`plan-line tp${sel}`} style={{ left: g.left, top: g.yTP, width: w }}>
                    <span className="plan-tag tp">TP {fmtPrice(tP)}</span>
                  </div>
                  <div className={`plan-rr${sel} ${g.side === 'LONG' ? 'long' : 'short'}`} style={{ left: rrLeft, top: g.yEntry }}>
                    {g.side} · R:R {rr != null ? rr.toFixed(2) : '—'}
                  </div>
                </Fragment>
              );
            }
            const color = MARK_COLORS[g.kind];
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
