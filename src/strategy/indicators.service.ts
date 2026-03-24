import { Injectable } from '@nestjs/common';
import type { Candle } from '../common/interfaces/binance.interfaces';

export interface IndicatorFeatures {
  currentPrice: number;
  ema9: number;
  ema21: number;
  emaCrossover: 'BULLISH' | 'BEARISH';
  emaSlope: 'RISING' | 'FALLING' | 'FLAT';
  rsi14: number;
  atr14: number;
  atrPercent: number;
  priceChange1h: number; // cumulative % change over last 12 candles (1h on 5m TF)
  bbUpper: number;       // Bollinger Band upper (SMA20 + 2*stdDev)
  bbMiddle: number;      // Bollinger Band middle (SMA20)
  bbLower: number;       // Bollinger Band lower (SMA20 - 2*stdDev)
  bbWidth: number;       // Relative width: (upper - lower) / middle
  recentCandles: Array<{
    o: number;
    h: number;
    l: number;
    c: number;
    v: number;
  }>;
}

@Injectable()
export class IndicatorsService {
  /**
   * EMA: Exponential Moving Average
   * multiplier = 2 / (period + 1)
   * EMA[0] = SMA of first `period` closes
   * EMA[i] = (close[i] - EMA[i-1]) * multiplier + EMA[i-1]
   */
  calculateEMA(candles: Candle[], period: number): number[] {
    const closes = candles.map((c) => c.close);
    if (closes.length < period) return [];

    const k = 2 / (period + 1);
    const ema: number[] = [];

    // SMA seed
    let sum = 0;
    for (let i = 0; i < period; i++) sum += closes[i];
    ema.push(sum / period);

    for (let i = period; i < closes.length; i++) {
      ema.push(closes[i] * k + ema[ema.length - 1] * (1 - k));
    }

    return ema;
  }

  /**
   * RSI: Relative Strength Index (Wilder's smoothing)
   * Returns array starting from index `period`
   */
  calculateRSI(candles: Candle[], period = 14): number[] {
    const closes = candles.map((c) => c.close);
    if (closes.length < period + 1) return [];

    const gains: number[] = [];
    const losses: number[] = [];

    for (let i = 1; i < closes.length; i++) {
      const change = closes[i] - closes[i - 1];
      gains.push(change > 0 ? change : 0);
      losses.push(change < 0 ? -change : 0);
    }

    let avgGain = 0;
    let avgLoss = 0;
    for (let i = 0; i < period; i++) {
      avgGain += gains[i];
      avgLoss += losses[i];
    }
    avgGain /= period;
    avgLoss /= period;

    const rsi: number[] = [];
    rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));

    for (let i = period; i < gains.length; i++) {
      avgGain = (avgGain * (period - 1) + gains[i]) / period;
      avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
      rsi.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
    }

    return rsi;
  }

  /**
   * ATR: Average True Range (Wilder's smoothing)
   * TR = max(high - low, |high - prevClose|, |low - prevClose|)
   */
  calculateATR(candles: Candle[], period = 14): number[] {
    if (candles.length < period + 1) return [];

    const tr: number[] = [];
    for (let i = 1; i < candles.length; i++) {
      const high = candles[i].high;
      const low = candles[i].low;
      const prevClose = candles[i - 1].close;
      tr.push(
        Math.max(
          high - low,
          Math.abs(high - prevClose),
          Math.abs(low - prevClose),
        ),
      );
    }

    let atrVal = 0;
    for (let i = 0; i < period; i++) atrVal += tr[i];
    atrVal /= period;

    const atr: number[] = [atrVal];

    for (let i = period; i < tr.length; i++) {
      atrVal = (atrVal * (period - 1) + tr[i]) / period;
      atr.push(atrVal);
    }

    return atr;
  }

  /**
   * Bollinger Bands: SMA(period) ± multiplier * stdDev
   */
  calculateBollingerBands(
    candles: Candle[],
    period = 20,
    multiplier = 2,
  ): { upper: number; middle: number; lower: number } {
    const closes = candles.slice(-period).map((c) => c.close);
    if (closes.length < period) {
      const last = candles[candles.length - 1]?.close ?? 0;
      return { upper: last, middle: last, lower: last };
    }

    const sma = closes.reduce((a, b) => a + b, 0) / period;
    const variance =
      closes.reduce((sum, c) => sum + Math.pow(c - sma, 2), 0) / period;
    const stdDev = Math.sqrt(variance);

    return {
      upper: sma + multiplier * stdDev,
      middle: sma,
      lower: sma - multiplier * stdDev,
    };
  }

  computeFeatures(candles: Candle[]): IndicatorFeatures {
    const ema9 = this.calculateEMA(candles, 9);
    const ema21 = this.calculateEMA(candles, 21);
    const rsi14 = this.calculateRSI(candles, 14);
    const atr14 = this.calculateATR(candles, 14);

    const latestClose = candles[candles.length - 1].close;
    const currentEma9 = ema9[ema9.length - 1] ?? latestClose;
    const currentEma21 = ema21[ema21.length - 1] ?? latestClose;
    const prevEma9 = ema9[ema9.length - 2] ?? currentEma9;
    const currentAtr = atr14[atr14.length - 1] ?? 0;

    // EMA slope: compare last two EMA9 values
    const slopeDiff = currentEma9 - prevEma9;
    const slopeThreshold = currentAtr * 0.05;
    let emaSlope: 'RISING' | 'FALLING' | 'FLAT' = 'FLAT';
    if (slopeDiff > slopeThreshold) emaSlope = 'RISING';
    else if (slopeDiff < -slopeThreshold) emaSlope = 'FALLING';

    // Cumulative price change over last 12 candles (1h on 5m TF)
    const lookback = Math.min(12, candles.length);
    const price12ago = candles[candles.length - lookback].close;
    const priceChange1h =
      latestClose > 0
        ? ((latestClose - price12ago) / price12ago) * 100
        : 0;

    const bb = this.calculateBollingerBands(candles);

    return {
      currentPrice: latestClose,
      ema9: currentEma9,
      ema21: currentEma21,
      emaCrossover: currentEma9 > currentEma21 ? 'BULLISH' : 'BEARISH',
      emaSlope,
      rsi14: rsi14[rsi14.length - 1] ?? 50,
      atr14: currentAtr,
      atrPercent: latestClose > 0 ? currentAtr / latestClose : 0,
      priceChange1h,
      bbUpper: bb.upper,
      bbMiddle: bb.middle,
      bbLower: bb.lower,
      bbWidth: bb.middle > 0 ? (bb.upper - bb.lower) / bb.middle : 0,
      recentCandles: candles.slice(-12).map((c) => ({
        o: c.open,
        h: c.high,
        l: c.low,
        c: c.close,
        v: c.volume,
      })),
    };
  }
}
