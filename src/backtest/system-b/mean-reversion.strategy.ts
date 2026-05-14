/**
 * SYSTEM B v2 — Mean Reversion Strategy
 *
 * Hipótesis (basada en falla de Session Breakout v1 en BTC 5m):
 *   Si los breakouts son mayoritariamente falsos (PF 0.45 en breakout v1),
 *   la lógica inversa — fade el extremo, mean reversion — debería capturar el counter-move.
 *
 * Reglas v1:
 *   1. TF: 5m
 *   2. Entry: RSI(14) cruza arriba de 75 → SHORT al close
 *             RSI(14) cruza debajo de 25 → LONG al close
 *   3. SL: a una distancia fija en ATR (default 1× ATR)
 *   4. TP: a una distancia fija en ATR (default 1.5× ATR, R:R 1.5)
 *   5. Solo en sesiones configuradas (default EU/OVERLAP/US, sin ASIA)
 *   6. Cooldown de N candles entre trades
 *   7. No re-entrar mientras RSI siga en zona extrema (espera hasta cruzar 50 antes del próximo signal)
 */
import type { Candle } from '../../common/interfaces/binance.interfaces';
import type { SessionLabel } from '../interfaces';

export interface MeanReversionSignal {
  direction: 'LONG' | 'SHORT';
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  rsiAtEntry: number;
  triggerCandleIdx: number;
}

export interface MeanReversionConfig {
  rsiLongThreshold: number;     // RSI <= X for LONG (default 25)
  rsiShortThreshold: number;    // RSI >= X for SHORT (default 75)
  rsiResetLevel: number;        // RSI must cross this back to mid before next signal (default 50)
  slAtrMult: number;            // SL distance in ATR (default 1.0)
  tpAtrMult: number;            // TP distance in ATR (default 1.5, R:R 1.5)
  cooldownBars: number;         // bars between trades (default 6 = 30min in 5m)
  sessions: SessionLabel[];     // active sessions
}

export const DEFAULT_MR_CONFIG: MeanReversionConfig = {
  rsiLongThreshold: 25,
  rsiShortThreshold: 75,
  rsiResetLevel: 50,
  slAtrMult: 1.0,
  tpAtrMult: 1.5,
  cooldownBars: 6,
  sessions: ['EU', 'OVERLAP', 'US'],
};

function getSessionId(closeTimeMs: number): SessionLabel {
  const hour = new Date(closeTimeMs).getUTCHours();
  if (hour < 7) return 'ASIA';
  if (hour < 12) return 'EU';
  if (hour < 16) return 'OVERLAP';
  return 'US';
}

export class MeanReversionDetector {
  private config: MeanReversionConfig;
  private armedLong = true;   // can fire LONG signal? (resets when RSI crosses reset level)
  private armedShort = true;  // can fire SHORT signal?
  private prevRsi: number | null = null;

  constructor(config: MeanReversionConfig = DEFAULT_MR_CONFIG) {
    this.config = config;
  }

  /**
   * Process one candle. Returns signal at this candle, or null.
   * Caller (backtest service) handles cooldown and position checks.
   */
  processCandle(
    candles: Candle[],
    i: number,
    rsi14: number,
    atr14: number,
  ): MeanReversionSignal | null {
    const candle = candles[i];

    // Track RSI crossing the reset level → re-arm signals
    if (this.prevRsi !== null) {
      // RSI crossed UP through reset level → SHORT side gets re-armed when overbought again
      if (this.prevRsi < this.config.rsiResetLevel && rsi14 >= this.config.rsiResetLevel) {
        this.armedShort = true;
      }
      // RSI crossed DOWN through reset level → LONG side gets re-armed when oversold again
      if (this.prevRsi > this.config.rsiResetLevel && rsi14 <= this.config.rsiResetLevel) {
        this.armedLong = true;
      }
    }
    this.prevRsi = rsi14;

    // Check session active
    const session = getSessionId(candle.closeTime);
    if (!this.config.sessions.includes(session)) return null;

    // Check trigger
    let direction: 'LONG' | 'SHORT' | null = null;
    if (rsi14 <= this.config.rsiLongThreshold && this.armedLong) {
      direction = 'LONG';
      this.armedLong = false; // disarm until RSI crosses reset level
    } else if (rsi14 >= this.config.rsiShortThreshold && this.armedShort) {
      direction = 'SHORT';
      this.armedShort = false;
    }

    if (!direction) return null;
    if (atr14 <= 0) return null; // safety

    const entryPrice = candle.close;
    const slDist = atr14 * this.config.slAtrMult;
    const tpDist = atr14 * this.config.tpAtrMult;

    const stopLoss = direction === 'LONG' ? entryPrice - slDist : entryPrice + slDist;
    const takeProfit = direction === 'LONG' ? entryPrice + tpDist : entryPrice - tpDist;

    return {
      direction,
      entryPrice,
      stopLoss,
      takeProfit,
      rsiAtEntry: rsi14,
      triggerCandleIdx: i,
    };
  }
}
