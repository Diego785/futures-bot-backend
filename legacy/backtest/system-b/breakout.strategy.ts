/**
 * SYSTEM B — Session Breakout Strategy v1
 *
 * Idea base:
 *   1. Para cada sesión activa (EU/OVERLAP/US, no ASIA), definir un rango de N velas.
 *   2. Si una vela posterior cierra rompiendo el high del rango → LONG al close de esa vela.
 *      Si cierra rompiendo el low → SHORT.
 *   3. SL = otro lado del rango. TP = 1.5x el ancho del rango (R:R 1.5).
 *   4. Una sola entrada por sesión por dirección.
 *   5. Si la sesión termina sin ruptura → no trade.
 *   6. ATR filter opcional: skip rangos demasiado chicos relativos al ATR (ruido).
 *
 * Diseño minimalista a propósito — primero validamos si hay edge bruto antes de añadir
 * filtros, trailing, partial profits, etc. Si baseline da PF >= 1.3 con >= 3 trades/día,
 * recién entonces refinamos.
 */
import type { Candle } from '../../common/interfaces/binance.interfaces';

export type SessionId = 'EU' | 'OVERLAP' | 'US';

interface SessionRange {
  session: SessionId;
  startTime: number;       // closeTime de la primera vela del rango
  endTime: number;         // closeTime de la última vela del rango (rangeBars-th)
  high: number;
  low: number;
  width: number;           // high - low
  ruptured: boolean;       // true si ya disparó entry esta sesión
  rangeStartIdx: number;
  rangeEndIdx: number;
}

export interface BreakoutSignal {
  direction: 'LONG' | 'SHORT';
  entryPrice: number;       // close de la vela de ruptura
  stopLoss: number;         // otro lado del rango
  takeProfit: number;       // 1.5x rango (R:R 1.5)
  rangeWidth: number;
  session: SessionId;
  triggerCandleIdx: number;
}

export interface BreakoutConfig {
  rangeBars: number;        // # velas para definir el rango (ej: 12 = 1h en 5m)
  rrRatio: number;          // R:R (default 1.5)
  minRangeAtrMult: number;  // skip si width < ATR * X (default 0)
  sessions: SessionId[];    // qué sesiones operar
}

export const DEFAULT_BREAKOUT_CONFIG: BreakoutConfig = {
  rangeBars: 12,            // 1h en 5m timeframe
  rrRatio: 1.5,
  minRangeAtrMult: 0,
  sessions: ['EU', 'OVERLAP', 'US'],
};

function getSessionId(closeTimeMs: number): SessionId | 'ASIA' {
  const hour = new Date(closeTimeMs).getUTCHours();
  if (hour < 7) return 'ASIA';
  if (hour < 12) return 'EU';
  if (hour < 16) return 'OVERLAP';
  return 'US';
}

function sessionStartHour(s: SessionId | 'ASIA'): number {
  return s === 'ASIA' ? 0 : s === 'EU' ? 7 : s === 'OVERLAP' ? 12 : 16;
}

/**
 * Detect breakout signal at a given candle index.
 * Returns null if no signal, otherwise BreakoutSignal at the rupture candle.
 *
 * State machine:
 *   - For each new session start, accumulate range from rangeBars consecutive candles.
 *   - After range is defined, watch for first candle that closes outside the range.
 *   - On rupture → emit signal (caller decides if to take it given cooldown/open positions).
 *   - One signal per session per direction.
 */
export class BreakoutDetector {
  private config: BreakoutConfig;
  private currentRange: SessionRange | null = null;
  private prevSessionId: SessionId | 'ASIA' | null = null;

  constructor(config: BreakoutConfig = DEFAULT_BREAKOUT_CONFIG) {
    this.config = config;
  }

  /**
   * Process one candle. If a breakout signal fires AT this candle, return it.
   * @param candles full candle array (read-only, used for atr context if needed)
   * @param i current candle index
   * @param atr14 ATR(14) at candle i (for optional minRange filter)
   */
  processCandle(candles: Candle[], i: number, atr14: number): BreakoutSignal | null {
    const candle = candles[i];
    const sessionNow = getSessionId(candle.closeTime);

    // Detect new session start (transition from prev session to current)
    if (sessionNow !== this.prevSessionId) {
      // New session begins — start fresh range accumulation if it's a tracked session
      if (sessionNow !== 'ASIA' && this.config.sessions.includes(sessionNow as SessionId)) {
        this.currentRange = {
          session: sessionNow,
          startTime: candle.closeTime,
          endTime: candle.closeTime,
          high: candle.high,
          low: candle.low,
          width: candle.high - candle.low,
          ruptured: false,
          rangeStartIdx: i,
          rangeEndIdx: i, // will grow until rangeBars
        };
      } else {
        this.currentRange = null;
      }
      this.prevSessionId = sessionNow;
      return null;
    }

    if (!this.currentRange) return null;

    const r = this.currentRange;
    const barsInRange = i - r.rangeStartIdx + 1;

    // Phase 1: still accumulating range
    if (barsInRange <= this.config.rangeBars) {
      if (candle.high > r.high) r.high = candle.high;
      if (candle.low < r.low) r.low = candle.low;
      r.width = r.high - r.low;
      r.endTime = candle.closeTime;
      r.rangeEndIdx = i;
      return null;
    }

    // Phase 2: range defined, watch for rupture (only if not already ruptured)
    if (r.ruptured) return null;

    // Optional ATR-based minimum range filter
    if (this.config.minRangeAtrMult > 0 && atr14 > 0) {
      if (r.width < atr14 * this.config.minRangeAtrMult) {
        // Range too tight, skip rupture detection for this session
        return null;
      }
    }

    // Rupture: candle CLOSES above range high or below range low
    let direction: 'LONG' | 'SHORT' | null = null;
    if (candle.close > r.high) direction = 'LONG';
    else if (candle.close < r.low) direction = 'SHORT';

    if (!direction) return null;

    r.ruptured = true;
    const entryPrice = candle.close;
    const stopLoss = direction === 'LONG' ? r.low : r.high;
    const takeProfit =
      direction === 'LONG'
        ? entryPrice + r.width * this.config.rrRatio
        : entryPrice - r.width * this.config.rrRatio;

    return {
      direction,
      entryPrice,
      stopLoss,
      takeProfit,
      rangeWidth: r.width,
      session: r.session,
      triggerCandleIdx: i,
    };
  }
}
