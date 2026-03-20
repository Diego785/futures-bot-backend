import { Injectable, Logger } from '@nestjs/common';
import type { IndicatorFeatures } from './indicators.service';
import type { SmcFeatures } from './smc.service';

export interface HybridSignalResult {
  action: 'LONG' | 'SHORT' | 'HOLD';
  confidence: number;
  reasoning: string;
  suggestedStopLoss: number | null;
  suggestedTakeProfit: number | null;
}

interface HtfContext {
  ema9: number;
  ema21: number;
  emaCrossover: string;
  emaSlope: string;
  rsi14: number;
  atr14: number;
  atrPercent: number;
  marketStructure: string;
  premiumDiscount: string;
}

@Injectable()
export class HybridSignalService {
  private readonly logger = new Logger(HybridSignalService.name);
  private readonly VOL_THRESHOLD = 0.007; // 0.7% ATR = high volatility

  private prevEmaCrossover: string | null = null;

  generateSignal(
    features: IndicatorFeatures,
    smc: SmcFeatures,
    symbol: string,
    htfContext: HtfContext | null,
    prevFeatures: IndicatorFeatures | null,
  ): HybridSignalResult {
    const isHighVol = features.atrPercent > this.VOL_THRESHOLD;

    if (isHighVol) {
      return this.emaCrossoverStrategy(features, htfContext, prevFeatures);
    } else {
      return this.breakoutStrategy(features);
    }
  }

  /**
   * TRENDING REGIME: EMA Crossover
   * Enter when EMA9 crosses EMA21 + RSI confirms + HTF agrees
   */
  private emaCrossoverStrategy(
    features: IndicatorFeatures,
    htfContext: HtfContext | null,
    prevFeatures: IndicatorFeatures | null,
  ): HybridSignalResult {
    const hold: HybridSignalResult = {
      action: 'HOLD',
      confidence: 0.30,
      reasoning: 'Alta volatilidad pero sin cruce de EMA reciente.',
      suggestedStopLoss: null,
      suggestedTakeProfit: null,
    };

    // Detect EMA crossover transition
    const prevCross = prevFeatures?.emaCrossover ?? this.prevEmaCrossover;
    const currCross = features.emaCrossover;
    this.prevEmaCrossover = currCross;

    if (!prevCross || prevCross === currCross) {
      return hold;
    }

    // New crossover detected
    const direction: 'LONG' | 'SHORT' =
      currCross === 'BULLISH' ? 'LONG' : 'SHORT';

    // RSI confirmation
    const rsiOk =
      (direction === 'LONG' &&
        features.rsi14 > 40 &&
        features.rsi14 < 75) ||
      (direction === 'SHORT' &&
        features.rsi14 < 60 &&
        features.rsi14 > 25);

    if (!rsiOk) {
      return {
        ...hold,
        reasoning: `Cruce EMA ${direction} detectado pero RSI ${features.rsi14.toFixed(0)} no confirma.`,
      };
    }

    // EMA slope confirmation
    const slopeOk =
      (direction === 'LONG' && features.emaSlope !== 'FALLING') ||
      (direction === 'SHORT' && features.emaSlope !== 'RISING');

    if (!slopeOk) {
      return {
        ...hold,
        reasoning: `Cruce EMA ${direction} pero pendiente EMA va en contra (${features.emaSlope}).`,
      };
    }

    // HTF alignment
    if (htfContext) {
      if (
        direction === 'LONG' &&
        htfContext.emaCrossover === 'BEARISH'
      ) {
        return {
          ...hold,
          reasoning: `Cruce EMA LONG en 1H pero HTF EMA es BEARISH. Contra-tendencia.`,
        };
      }
      if (
        direction === 'SHORT' &&
        htfContext.emaCrossover === 'BULLISH'
      ) {
        return {
          ...hold,
          reasoning: `Cruce EMA SHORT en 1H pero HTF EMA es BULLISH. Contra-tendencia.`,
        };
      }
    }

    // Calculate SL/TP
    const slDistance = features.atr14 * 1.5;
    const sl =
      direction === 'LONG'
        ? features.currentPrice - slDistance
        : features.currentPrice + slDistance;
    const tp =
      direction === 'LONG'
        ? features.currentPrice + slDistance * 2
        : features.currentPrice - slDistance * 2;

    const reasoning =
      `Régimen tendencia (ATR ${(features.atrPercent * 100).toFixed(2)}% > 0.7%). ` +
      `Cruce EMA ${direction}: EMA9 ${features.ema9.toFixed(0)} cruzó EMA21 ${features.ema21.toFixed(0)}. ` +
      `RSI ${features.rsi14.toFixed(0)} confirma. Slope: ${features.emaSlope}.` +
      (htfContext
        ? ` HTF: ${htfContext.emaCrossover} (alineado).`
        : '');

    this.logger.log(
      `Hybrid EMA signal: ${direction} | ATR%=${(features.atrPercent * 100).toFixed(2)} RSI=${features.rsi14.toFixed(0)}`,
    );

    return {
      action: direction,
      confidence: 0.65,
      reasoning,
      suggestedStopLoss: sl,
      suggestedTakeProfit: tp,
    };
  }

  /**
   * RANGING REGIME: Breakout
   * Enter when price breaks the 24-candle high/low range
   */
  private breakoutStrategy(
    features: IndicatorFeatures,
  ): HybridSignalResult {
    const hold: HybridSignalResult = {
      action: 'HOLD',
      confidence: 0.30,
      reasoning: 'Baja volatilidad, esperando ruptura de rango.',
      suggestedStopLoss: null,
      suggestedTakeProfit: null,
    };

    const candles = features.recentCandles;
    if (candles.length < 12) return hold;

    // Use recent candles to determine range
    const highs = candles.map((c) => c.h);
    const lows = candles.map((c) => c.l);
    const rangeHigh = Math.max(...highs);
    const rangeLow = Math.min(...lows);
    const rangeSize = (rangeHigh - rangeLow) / rangeHigh;

    // Only trade on tight range breakout (0.5% - 2%)
    if (rangeSize >= 0.02 || rangeSize <= 0.005) {
      return {
        ...hold,
        reasoning: `Rango ${(rangeSize * 100).toFixed(2)}% fuera de umbral (0.5%-2%).`,
      };
    }

    const price = features.currentPrice;
    let direction: 'LONG' | 'SHORT' | null = null;

    if (price > rangeHigh) {
      direction = 'LONG';
    } else if (price < rangeLow) {
      direction = 'SHORT';
    }

    if (!direction) {
      return {
        ...hold,
        reasoning: `Precio dentro del rango [$${rangeLow.toFixed(0)}-$${rangeHigh.toFixed(0)}]. Sin ruptura.`,
      };
    }

    // Momentum confirmation
    if (direction === 'LONG' && features.priceChange1h < 0) {
      return {
        ...hold,
        reasoning: `Ruptura alcista pero momentum 1H negativo (${features.priceChange1h.toFixed(2)}%).`,
      };
    }
    if (direction === 'SHORT' && features.priceChange1h > 0) {
      return {
        ...hold,
        reasoning: `Ruptura bajista pero momentum 1H positivo (+${features.priceChange1h.toFixed(2)}%).`,
      };
    }

    // Calculate SL/TP
    const slDistance = features.atr14 * 1.5;
    const sl =
      direction === 'LONG'
        ? features.currentPrice - slDistance
        : features.currentPrice + slDistance;
    const tp =
      direction === 'LONG'
        ? features.currentPrice + slDistance * 2
        : features.currentPrice - slDistance * 2;

    const reasoning =
      `Régimen lateral (ATR ${(features.atrPercent * 100).toFixed(2)}% < 0.7%). ` +
      `Ruptura ${direction} del rango [$${rangeLow.toFixed(0)}-$${rangeHigh.toFixed(0)}] ` +
      `(${(rangeSize * 100).toFixed(2)}%). ` +
      `Momentum 1H: ${features.priceChange1h > 0 ? '+' : ''}${features.priceChange1h.toFixed(2)}% confirma.`;

    this.logger.log(
      `Hybrid Breakout signal: ${direction} | Range=${(rangeSize * 100).toFixed(2)}% ATR%=${(features.atrPercent * 100).toFixed(2)}`,
    );

    return {
      action: direction,
      confidence: 0.60,
      reasoning,
      suggestedStopLoss: sl,
      suggestedTakeProfit: tp,
    };
  }
}
