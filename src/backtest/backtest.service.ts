import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { IndicatorsService } from '../strategy/indicators.service';
import { SmcService } from '../strategy/smc.service';
import { PreFilterGateService } from '../strategy/pre-filter-gate.service';
import {
  parseKline,
  type Candle,
  type BinanceKlineRaw,
} from '../common/interfaces/binance.interfaces';
import { TradeSimulator } from './trade-simulator';
import { generateReport, printReport } from './report-generator';
import type { BacktestConfig, BacktestTrade, BacktestReport } from './interfaces';

@Injectable()
export class BacktestService {
  private readonly logger = new Logger(BacktestService.name);

  constructor(
    private readonly httpService: HttpService,
    private readonly indicators: IndicatorsService,
    private readonly smc: SmcService,
    private readonly gate: PreFilterGateService,
  ) {}

  async run(config: BacktestConfig): Promise<BacktestReport> {
    this.logger.log(
      `Starting backtest: ${config.symbol} ${config.timeframe} ${config.days}d mode=${config.mode}`,
    );

    // 1. Download candles
    const candles = await this.downloadKlines(
      config.symbol,
      config.timeframe,
      config.days,
    );
    this.logger.log(`Downloaded ${candles.length} candles`);

    // 2. Download 1H candles for HTF context
    const htfCandles = await this.downloadKlines(
      config.symbol,
      '1h',
      config.days,
    );
    this.logger.log(`Downloaded ${htfCandles.length} HTF (1H) candles`);

    // 3. Run simulation
    const trades: BacktestTrade[] = [];
    const simulator = new TradeSimulator(
      config.commissionRate,
      config.initialBalance * config.maxLeverage * 0.9,
      config.enableTrailing,
      config.trailingBreakevenPct ?? 0.3,
    );

    const warmup = 100;
    let gatePassCount = 0;
    let cooldownUntil = 0;

    // Pullback-OB state machine
    let pbState: 'NO_SETUP' | 'WAITING_PULLBACK' = 'NO_SETUP';
    let pbBias: 'LONG' | 'SHORT' = 'LONG';
    let pbTargetZones: Array<{ type: 'OB' | 'FVG'; high: number; low: number }> = [];
    let pbWaitStart = 0;

    for (let i = warmup; i < candles.length; i++) {
      const candle = candles[i];

      // Check open position first
      if (simulator.hasPosition) {
        const closed = simulator.processCandle(candle);
        if (closed) {
          trades.push(closed);
          cooldownUntil = i + config.cooldownCandles;
        }
        continue; // Don't open new position while one is open
      }

      // Cooldown check
      if (i < cooldownUntil) continue;

      // Compute indicators on last 100 candles
      const slice = candles.slice(Math.max(0, i - 99), i + 1);
      const features = this.indicators.computeFeatures(slice);
      const smcFeatures = this.smc.analyze(slice);

      // Gate evaluation
      const gateResult = this.gate.evaluate(features, smcFeatures);
      if (gateResult.passed) gatePassCount++;

      // Decide entry based on mode
      let shouldEnter = false;
      let direction: 'LONG' | 'SHORT' = 'LONG';
      let confidence: number | undefined;

      if (config.mode === 'gate-only') {
        if (
          gateResult.passed &&
          gateResult.score >= config.gateEntryThreshold &&
          smcFeatures.marketStructure !== 'RANGING'
        ) {
          shouldEnter = true;
          direction = smcFeatures.marketStructure === 'BULLISH' ? 'LONG' : 'SHORT';

          // Check HTF alignment — don't enter against clear HTF trend
          const htfSlice = this.getHtfSlice(htfCandles, candle.closeTime);
          if (htfSlice.length >= 21) {
            const htfFeatures = this.indicators.computeFeatures(htfSlice);
            const htfSmc = this.smc.analyze(htfSlice);

            // If HTF structure AND EMA agree on opposite direction, skip
            const htfBullish =
              htfSmc.marketStructure === 'BULLISH' &&
              htfFeatures.emaCrossover === 'BULLISH';
            const htfBearish =
              htfSmc.marketStructure === 'BEARISH' &&
              htfFeatures.emaCrossover === 'BEARISH';

            if (direction === 'SHORT' && htfBullish) shouldEnter = false;
            if (direction === 'LONG' && htfBearish) shouldEnter = false;
          }

          // Momentum filter — don't enter against strong 1h momentum
          if (shouldEnter) {
            if (
              direction === 'SHORT' &&
              features.priceChange1h > 0.5
            )
              shouldEnter = false;
            if (
              direction === 'LONG' &&
              features.priceChange1h < -0.5
            )
              shouldEnter = false;
          }

          // OB/FVG proximity filter (optional, controlled by config)
          if (shouldEnter && config.requireOBFVG) {
            const inZone = smcFeatures.priceInOrderBlock || smcFeatures.priceInFVG;
            const nearZone =
              (smcFeatures.distanceToNearestOB !== null && smcFeatures.distanceToNearestOB <= 0.003) ||
              (smcFeatures.distanceToNearestFVG !== null && smcFeatures.distanceToNearestFVG <= 0.003);
            if (!inZone && !nearZone) shouldEnter = false;
          }
        }
      }
      if (config.mode === 'ema-crossover') {
        // EMA Crossover strategy — no SMC, no gate, no AI
        // Enter when EMA9 crosses EMA21 + RSI confirms + HTF agrees
        const prevSlice = candles.slice(Math.max(0, i - 100), i);
        if (prevSlice.length < 21) continue;
        const prevFeatures = this.indicators.computeFeatures(prevSlice);

        // Detect crossover: previous EMA state vs current
        const prevCross = prevFeatures.emaCrossover;
        const currCross = features.emaCrossover;

        // Only enter on NEW crossover (transition)
        if (prevCross !== currCross) {
          direction = currCross === 'BULLISH' ? 'LONG' : 'SHORT';

          // RSI filter — confirm direction
          const rsiOk =
            (direction === 'LONG' && features.rsi14 > 40 && features.rsi14 < 70) ||
            (direction === 'SHORT' && features.rsi14 < 60 && features.rsi14 > 30);

          // EMA slope must confirm
          const slopeOk =
            (direction === 'LONG' && features.emaSlope !== 'FALLING') ||
            (direction === 'SHORT' && features.emaSlope !== 'RISING');

          // HTF trend filter
          let htfOk = true;
          const htfSlice = this.getHtfSlice(htfCandles, candle.closeTime);
          if (htfSlice.length >= 21) {
            const htfFeatures = this.indicators.computeFeatures(htfSlice);
            // Don't enter against HTF EMA direction
            if (direction === 'LONG' && htfFeatures.emaCrossover === 'BEARISH') htfOk = false;
            if (direction === 'SHORT' && htfFeatures.emaCrossover === 'BULLISH') htfOk = false;
          }

          shouldEnter = rsiOk && slopeOk && htfOk;
        }
      }

      if (config.mode === 'hybrid') {
        // HYBRID: Detect market regime and use the right strategy
        // High volatility (ATR% > 0.4%) = trending → use EMA crossover
        // Low volatility (ATR% < 0.4%) = ranging → use Breakout on range break

        const isHighVol = features.atrPercent > 0.007;

        if (isHighVol) {
          // TRENDING REGIME → EMA Crossover with trend
          const prevSlice = candles.slice(Math.max(0, i - 100), i);
          if (prevSlice.length >= 21) {
            const prevFeatures = this.indicators.computeFeatures(prevSlice);
            const prevCross = prevFeatures.emaCrossover;
            const currCross = features.emaCrossover;

            if (prevCross !== currCross) {
              direction = currCross === 'BULLISH' ? 'LONG' : 'SHORT';

              // RSI + slope confirm
              const rsiOk =
                (direction === 'LONG' && features.rsi14 > 40 && features.rsi14 < 75) ||
                (direction === 'SHORT' && features.rsi14 < 60 && features.rsi14 > 25);
              const slopeOk =
                (direction === 'LONG' && features.emaSlope !== 'FALLING') ||
                (direction === 'SHORT' && features.emaSlope !== 'RISING');

              // HTF alignment
              let htfOk = true;
              const htfSlice = this.getHtfSlice(htfCandles, candle.closeTime);
              if (htfSlice.length >= 21) {
                const htfFeatures = this.indicators.computeFeatures(htfSlice);
                if (direction === 'LONG' && htfFeatures.emaCrossover === 'BEARISH') htfOk = false;
                if (direction === 'SHORT' && htfFeatures.emaCrossover === 'BULLISH') htfOk = false;
              }

              shouldEnter = rsiOk && slopeOk && htfOk;
            }
          }
        } else {
          // RANGING REGIME → Breakout strategy
          const lookback = candles.slice(Math.max(0, i - 24), i);
          if (lookback.length >= 20) {
            const rangeHigh = Math.max(...lookback.map((c) => c.high));
            const rangeLow = Math.min(...lookback.map((c) => c.low));
            const rangeSize = (rangeHigh - rangeLow) / rangeHigh;

            if (rangeSize < 0.02 && rangeSize > 0.005) {
              if (candle.close > rangeHigh) {
                direction = 'LONG';
                shouldEnter = true;
              } else if (candle.close < rangeLow) {
                direction = 'SHORT';
                shouldEnter = true;
              }
            }

            // Momentum confirm
            if (shouldEnter) {
              if (direction === 'LONG' && features.priceChange1h < 0) shouldEnter = false;
              if (direction === 'SHORT' && features.priceChange1h > 0) shouldEnter = false;
            }

          }
        }
      }

      if (config.mode === 'bollinger') {
        // Bollinger Bands Mean Reversion
        const closes = candles.slice(Math.max(0, i - 19), i + 1).map((c) => c.close);
        if (closes.length >= 20) {
          const sma = closes.reduce((a, b) => a + b, 0) / closes.length;
          const variance =
            closes.reduce((sum, c) => sum + Math.pow(c - sma, 2), 0) / closes.length;
          const stdDev = Math.sqrt(variance);
          const upperBand = sma + 2 * stdDev;
          const lowerBand = sma - 2 * stdDev;

          // Only trade in low volatility (ranging market)
          const bandWidth = (upperBand - lowerBand) / sma;

          if (bandWidth < 0.03) {
            // Narrow bands = ranging
            if (candle.close <= lowerBand) {
              shouldEnter = true;
              direction = 'LONG';
            } else if (candle.close >= upperBand) {
              shouldEnter = true;
              direction = 'SHORT';
            }
          }

          // RSI confirmation
          if (shouldEnter) {
            if (direction === 'LONG' && features.rsi14 > 60) shouldEnter = false;
            if (direction === 'SHORT' && features.rsi14 < 40) shouldEnter = false;
          }
        }
      }

      if (config.mode === 'breakout') {
        // Breakout + Retest strategy
        // Find the high and low of the last 24 candles (24h on 1h)
        const lookback = candles.slice(Math.max(0, i - 24), i);
        if (lookback.length >= 20) {
          const rangeHigh = Math.max(...lookback.map((c) => c.high));
          const rangeLow = Math.min(...lookback.map((c) => c.low));
          const rangeSize = (rangeHigh - rangeLow) / rangeHigh;

          // Only trigger on breakout of a tight range (<2%)
          if (rangeSize < 0.02 && rangeSize > 0.005) {
            if (candle.close > rangeHigh) {
              shouldEnter = true;
              direction = 'LONG';
            } else if (candle.close < rangeLow) {
              shouldEnter = true;
              direction = 'SHORT';
            }
          }

          // Momentum confirmation
          if (shouldEnter) {
            if (direction === 'LONG' && features.priceChange1h < 0) shouldEnter = false;
            if (direction === 'SHORT' && features.priceChange1h > 0) shouldEnter = false;
          }
        }
      }

      if (config.mode === 'pullback-ob') {
        // PULLBACK TO OB/FVG STRATEGY — State Machine
        const htfSlice = this.getHtfSlice(htfCandles, candle.closeTime);

        if (pbState === 'NO_SETUP') {
          // Step 1: Detect HTF bias (1H EMA + structure must agree)
          if (htfSlice.length >= 21) {
            const htfFeatures = this.indicators.computeFeatures(htfSlice);
            const htfSmc = this.smc.analyze(htfSlice);

            let htfBias: 'LONG' | 'SHORT' | null = null;
            if (htfSmc.marketStructure === 'BULLISH' && htfFeatures.emaCrossover === 'BULLISH') {
              htfBias = 'LONG';
            } else if (htfSmc.marketStructure === 'BEARISH' && htfFeatures.emaCrossover === 'BEARISH') {
              htfBias = 'SHORT';
            }

            if (htfBias) {
              // Step 2: 15m structure must not contradict
              const contradicts =
                (htfBias === 'LONG' && smcFeatures.marketStructure === 'BEARISH') ||
                (htfBias === 'SHORT' && smcFeatures.marketStructure === 'BULLISH');

              if (!contradicts) {
                // Step 3: Find valid zones below (LONG) or above (SHORT) current price
                const zones: Array<{ type: 'OB' | 'FVG'; high: number; low: number }> = [];
                const price = features.currentPrice;

                if (config.pullbackZoneType !== 'fvg') {
                  for (const ob of smcFeatures.activeOrderBlocks) {
                    if (ob.mitigated) continue;
                    if (htfBias === 'LONG' && ob.type === 'BULLISH') {
                      const dist = ((price - ob.high) / price) * 100;
                      if (dist > config.pullbackMinDistance && dist < config.pullbackMaxDistance) {
                        zones.push({ type: 'OB', high: ob.high, low: ob.low });
                      }
                    } else if (htfBias === 'SHORT' && ob.type === 'BEARISH') {
                      const dist = ((ob.low - price) / price) * 100;
                      if (dist > config.pullbackMinDistance && dist < config.pullbackMaxDistance) {
                        zones.push({ type: 'OB', high: ob.high, low: ob.low });
                      }
                    }
                  }
                }

                if (config.pullbackZoneType !== 'ob') {
                  for (const fvg of smcFeatures.activeFairValueGaps) {
                    if (fvg.filled) continue;
                    if (htfBias === 'LONG' && fvg.type === 'BULLISH') {
                      const dist = ((price - fvg.high) / price) * 100;
                      if (dist > config.pullbackMinDistance && dist < config.pullbackMaxDistance) {
                        zones.push({ type: 'FVG', high: fvg.high, low: fvg.low });
                      }
                    } else if (htfBias === 'SHORT' && fvg.type === 'BEARISH') {
                      const dist = ((fvg.low - price) / price) * 100;
                      if (dist > config.pullbackMinDistance && dist < config.pullbackMaxDistance) {
                        zones.push({ type: 'FVG', high: fvg.high, low: fvg.low });
                      }
                    }
                  }
                }

                if (zones.length > 0) {
                  // Sort by distance — closest first
                  zones.sort((a, b) => {
                    const distA = htfBias === 'LONG'
                      ? price - a.high
                      : a.low - price;
                    const distB = htfBias === 'LONG'
                      ? price - b.high
                      : b.low - price;
                    return distA - distB;
                  });

                  pbState = 'WAITING_PULLBACK';
                  pbBias = htfBias;
                  pbTargetZones = zones;
                  pbWaitStart = i;
                }
              }
            }
          }
        }

        if (pbState === 'WAITING_PULLBACK') {
          // Check invalidation FIRST

          // 1. Timeout
          if (i - pbWaitStart > config.pullbackMaxWaitCandles) {
            pbState = 'NO_SETUP';
          }
          // 2. CHoCH against bias on 15m
          else if (
            smcFeatures.lastStructureBreak &&
            smcFeatures.lastStructureBreak.type === 'CHoCH' &&
            ((pbBias === 'LONG' && smcFeatures.lastStructureBreak.direction === 'BEARISH') ||
             (pbBias === 'SHORT' && smcFeatures.lastStructureBreak.direction === 'BULLISH'))
          ) {
            pbState = 'NO_SETUP';
          }
          // 3. HTF bias flipped
          else {
            const htfF = htfSlice.length >= 21 ? this.indicators.computeFeatures(htfSlice) : null;
            const htfS = htfSlice.length >= 21 ? this.smc.analyze(htfSlice) : null;
            if (htfF && htfS) {
              const stillBullish = htfS.marketStructure === 'BULLISH' && htfF.emaCrossover === 'BULLISH';
              const stillBearish = htfS.marketStructure === 'BEARISH' && htfF.emaCrossover === 'BEARISH';
              if ((pbBias === 'LONG' && !stillBullish) || (pbBias === 'SHORT' && !stillBearish)) {
                pbState = 'NO_SETUP';
              }
            }
          }

          // 4. Remove mitigated zones
          if (pbState === 'WAITING_PULLBACK') {
            pbTargetZones = pbTargetZones.filter((zone) => {
              if (pbBias === 'LONG') return candle.close >= zone.low; // not blown through
              return candle.close <= zone.high;
            });
            if (pbTargetZones.length === 0) pbState = 'NO_SETUP';
          }

          // Check entry trigger (with additional filters)
          if (pbState === 'WAITING_PULLBACK') {
            // Filter: EMA slope — don't enter against strong downward/upward momentum
            const slopeOk =
              (pbBias === 'LONG' && features.emaSlope !== 'FALLING') ||
              (pbBias === 'SHORT' && features.emaSlope !== 'RISING');

            if (slopeOk) {
            for (const zone of pbTargetZones) {
              let entryPrice: number;
              let sl: number;

              if (pbBias === 'LONG') {
                // Price must have been above zone at candle open (not gap-through)
                if (candle.open < zone.low) continue;
                // Price must have reached the zone
                if (candle.low > zone.high) continue;

                entryPrice = zone.high;
                const slRaw = zone.low - features.atr14 * config.pullbackSlBuffer;
                const slDist = Math.max(entryPrice - slRaw, entryPrice * config.slMinPercent);
                sl = entryPrice - slDist;

                // Don't enter if SL would be hit same candle
                if (candle.low <= sl) continue;

                const tp = entryPrice + slDist * config.rrRatio;
                simulator.openPosition('LONG', entryPrice, sl, tp, candle.closeTime, 0, 0.65);
              } else {
                if (candle.open > zone.high) continue;
                if (candle.high < zone.low) continue;

                entryPrice = zone.low;
                const slRaw = zone.high + features.atr14 * config.pullbackSlBuffer;
                const slDist = Math.max(slRaw - entryPrice, entryPrice * config.slMinPercent);
                sl = entryPrice + slDist;

                if (candle.high >= sl) continue;

                const tp = entryPrice - slDist * config.rrRatio;
                simulator.openPosition('SHORT', entryPrice, sl, tp, candle.closeTime, 0, 0.65);
              }

              // Position opened — reset state
              pbState = 'NO_SETUP';
              pbTargetZones = [];
              break;
            }
            } // end pdOk && rsiOk && slopeOk
          }
        }
      }

      if (shouldEnter) {
        const entryPrice = candle.close;

        // Calculate SL/TP with minimum enforcement
        const minSlAtr = features.atr14 * config.slAtrMultiplier;
        const minSlPct = entryPrice * config.slMinPercent;
        const slDistance = Math.max(minSlAtr, minSlPct);

        const sl =
          direction === 'LONG'
            ? entryPrice - slDistance
            : entryPrice + slDistance;
        const tp =
          direction === 'LONG'
            ? entryPrice + slDistance * config.rrRatio
            : entryPrice - slDistance * config.rrRatio;

        simulator.openPosition(
          direction,
          entryPrice,
          sl,
          tp,
          candle.closeTime,
          gateResult.score,
          confidence,
        );
      }
    }

    // Close any remaining position
    if (simulator.hasPosition) {
      const lastCandle = candles[candles.length - 1];
      const closed = simulator.forceClose(
        lastCandle.close,
        lastCandle.closeTime,
      );
      if (closed) trades.push(closed);
    }

    // 4. Generate report
    const report = generateReport(
      config,
      trades,
      candles.length - warmup,
      gatePassCount,
    );
    printReport(report);

    return report;
  }

  private getHtfSlice(htfCandles: Candle[], beforeTime: number): Candle[] {
    const filtered = htfCandles.filter((c) => c.closeTime <= beforeTime);
    return filtered.slice(-100);
  }

  private async downloadKlines(
    symbol: string,
    interval: string,
    days: number,
  ): Promise<Candle[]> {
    const intervalMs: Record<string, number> = {
      '1m': 60_000,
      '5m': 300_000,
      '15m': 900_000,
      '1h': 3_600_000,
    };

    const ms = intervalMs[interval] || 900_000;
    const totalCandles = Math.ceil((days * 24 * 60 * 60 * 1000) / ms);
    const allCandles: Candle[] = [];
    let endTime = Date.now();

    while (allCandles.length < totalCandles) {
      const limit = Math.min(1500, totalCandles - allCandles.length);
      const url =
        `https://fapi.binance.com/fapi/v1/klines` +
        `?symbol=${symbol}&interval=${interval}&endTime=${endTime}&limit=${limit}`;

      try {
        const response = await firstValueFrom(
          this.httpService.get<BinanceKlineRaw[]>(url),
        );

        if (!response.data || response.data.length === 0) break;

        const candles = response.data.map(parseKline);
        allCandles.unshift(...candles);

        // Move endTime to before the earliest candle
        endTime = candles[0].openTime - 1;

        this.logger.log(
          `Downloaded ${allCandles.length}/${totalCandles} candles`,
        );
      } catch (err) {
        this.logger.error(`Failed to download klines: ${err}`);
        break;
      }

      // Small delay to avoid rate limits
      await new Promise((r) => setTimeout(r, 200));
    }

    // Sort by time
    allCandles.sort((a, b) => a.openTime - b.openTime);

    return allCandles;
  }
}
