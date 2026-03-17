import { Injectable, Logger } from '@nestjs/common';
import type { IndicatorFeatures } from './indicators.service';
import type { SmcFeatures } from './smc.service';

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

@Injectable()
export class SignalCacheService {
  private readonly logger = new Logger(SignalCacheService.name);
  private readonly cache = new Map<string, number>(); // key -> timestamp

  shouldSkip(
    features: IndicatorFeatures,
    smc: SmcFeatures,
  ): { skip: boolean; reason: string } {
    this.cleanup();
    const key = this.computeKey(features, smc);
    const entry = this.cache.get(key);

    if (entry && Date.now() - entry < CACHE_TTL_MS) {
      return {
        skip: true,
        reason: 'Conditions unchanged since last HOLD (cache hit)',
      };
    }

    return { skip: false, reason: '' };
  }

  cacheHoldResult(
    features: IndicatorFeatures,
    smc: SmcFeatures,
  ): void {
    const key = this.computeKey(features, smc);
    this.cache.set(key, Date.now());
    this.logger.debug(`Cached HOLD result, cache size: ${this.cache.size}`);
  }

  private computeKey(
    features: IndicatorFeatures,
    smc: SmcFeatures,
  ): string {
    // Rounding to reduce cache misses for minor changes:
    // - RSI rounded to nearest 5 — RSI 33→35, RSI 47→45
    // - ATR% rounded to 1 decimal in percent — 0.0026→0.003, 0.0031→0.003
    // - Removed slope (too volatile) — only structure + crossover for trend
    // - Kept zone, inOB, inFVG as these are meaningful changes
    const rounded = {
      rsi: Math.round(features.rsi14 / 5) * 5,
      atrPct: Math.round(features.atrPercent * 1000) / 1000,
      structure: smc.marketStructure,
      zone: smc.premiumDiscount,
      inOB: smc.priceInOrderBlock,
      inFVG: smc.priceInFVG,
      crossover: features.emaCrossover,
    };
    return JSON.stringify(rounded);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, ts] of this.cache) {
      if (now - ts >= CACHE_TTL_MS) {
        this.cache.delete(key);
      }
    }
  }
}
