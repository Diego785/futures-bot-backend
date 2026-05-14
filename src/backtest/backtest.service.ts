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
import type {
  BacktestConfig,
  BacktestTrade,
  BacktestReport,
  TradeContextAtEntry,
  SessionLabel,
  Delta24hBucket,
} from './interfaces';
import { BreakoutDetector } from './system-b/breakout.strategy';
import { MeanReversionDetector } from './system-b/mean-reversion.strategy';

function hasCandleConfirm(
  recentCandles: Array<{ o: number; h: number; l: number; c: number; v: number }>,
  bias: 'LONG' | 'SHORT',
): boolean {
  if (recentCandles.length < 2) return false;
  const curr = recentCandles[recentCandles.length - 1];
  const prev = recentCandles[recentCandles.length - 2];
  const body = Math.abs(curr.c - curr.o);
  const fullRange = curr.h - curr.l;
  if (fullRange === 0) return false;

  if (bias === 'LONG') {
    const lowerWick = Math.min(curr.o, curr.c) - curr.l;
    const isPinBar = lowerWick / fullRange > 0.6 && body / fullRange < 0.3;
    const isEngulfing = curr.c > curr.o && prev.c < prev.o && curr.c > prev.o && curr.o < prev.c;
    return isPinBar || isEngulfing;
  } else {
    const upperWick = curr.h - Math.max(curr.o, curr.c);
    const isPinBar = upperWick / fullRange > 0.6 && body / fullRange < 0.3;
    const isEngulfing = curr.c < curr.o && prev.c > prev.o && curr.o > prev.c && curr.c < prev.o;
    return isPinBar || isEngulfing;
  }
}

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
      config.startDate,
      config.endDate,
    );
    this.logger.log(`Downloaded ${candles.length} candles`);

    // 2. Download 1H candles for HTF context
    const htfCandles = await this.downloadKlines(
      config.symbol,
      '1h',
      config.days,
      config.startDate,
      config.endDate,
    );
    this.logger.log(`Downloaded ${htfCandles.length} HTF (1H) candles`);

    // 2a. Download 4H candles for HTF 4H tiebreaker (only if enabled — saves bandwidth)
    let htf4hCandles: Candle[] = [];
    if (config.pullbackHtf4hTiebreaker) {
      htf4hCandles = await this.downloadKlines(
        config.symbol,
        '4h',
        config.days,
        config.startDate,
        config.endDate,
      );
      this.logger.log(`Downloaded ${htf4hCandles.length} HTF (4H) candles for tiebreaker`);
    }

    // 2b. Download 1m candles for intrabar trailing resolution (if not pessimistic-only mode)
    let intrabarCandles: Candle[] = [];
    if (!config.pessimisticTrail) {
      // Only download 1m if we're NOT using pessimistic shortcut (which doesn't need them)
      // When pessimisticTrail is false and we have 1m data, use it for realistic trailing
      intrabarCandles = await this.downloadKlines(
        config.symbol,
        '1m',
        config.days,
        config.startDate,
        config.endDate,
      );
      this.logger.log(`Downloaded ${intrabarCandles.length} intrabar (1m) candles`);
    }

    // 3. Run simulation
    const trades: BacktestTrade[] = [];
    const simulator = new TradeSimulator(
      config.commissionRate,
      config.initialBalance * config.maxLeverage * 0.9,
      config.enableTrailing,
      config.trailingBreakevenPct ?? 0.3,
      config.trailMode ?? 'entry-pct',
      config.trailFixed ?? 100,
      config.trailActivation ?? config.trailFixed ?? 100,
      config.trailBreakevenAt ?? 0,
      config.pessimisticTrail ?? false,
      config.economicBe ?? false,
      config.economicBeSafetyPct ?? 0.02,
    );

    const warmup = 100;
    let gatePassCount = 0;
    let cooldownUntil = 0;

    // Pullback-OB state machine
    let pbState: 'NO_SETUP' | 'WAITING_PULLBACK' = 'NO_SETUP';
    let pbBias: 'LONG' | 'SHORT' = 'LONG';
    let pbTargetZones: Array<{ type: 'OB' | 'FVG'; high: number; low: number }> = [];
    let pbWaitStart = 0;
    let pbCreatedAtBreakTime: number | null = null;

    // System B — Session Breakout detector (stateful across candles)
    const breakoutDetector = config.mode === 'session-breakout'
      ? new BreakoutDetector({
          rangeBars: config.sbRangeBars,
          rrRatio: config.sbRrRatio,
          minRangeAtrMult: config.sbMinRangeAtrMult,
          sessions: (config.sbSessions.filter((s) => s !== 'ASIA') as ('EU' | 'OVERLAP' | 'US')[]),
        })
      : null;

    // System B v2 — Mean Reversion detector
    const meanReversionDetector = config.mode === 'mean-reversion'
      ? new MeanReversionDetector({
          rsiLongThreshold: config.mrRsiLong,
          rsiShortThreshold: config.mrRsiShort,
          rsiResetLevel: config.mrRsiReset,
          slAtrMult: config.mrSlAtrMult,
          tpAtrMult: config.mrTpAtrMult,
          cooldownBars: config.mrCooldownBars,
          sessions: config.mrSessions,
        })
      : null;

    for (let i = warmup; i < candles.length; i++) {
      const candle = candles[i];

      // Check open position first
      if (simulator.hasPosition) {
        let closed: BacktestTrade | null = null;

        if (intrabarCandles.length > 0) {
          // Use 1m sub-candles for realistic intrabar trailing resolution.
          // Process each 1m candle in chronological order within this 15m window.
          const prevClose = i > 0 ? candles[i - 1].closeTime : candle.closeTime - 900_000;
          const subCandles = this.getIntrabarSlice(intrabarCandles, prevClose, candle.closeTime);
          for (const sub of subCandles) {
            closed = simulator.processCandle(sub);
            if (closed) break;
          }
          // If no sub-candles matched (data gap), fall back to 15m candle
          if (!closed && subCandles.length === 0) {
            closed = simulator.processCandle(candle);
          }
        } else {
          // No intrabar data — use 15m candle directly (with pessimistic flag if set)
          closed = simulator.processCandle(candle);
        }

        if (closed) {
          trades.push(closed);
          cooldownUntil = i + config.cooldownCandles;
        }
        continue;
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

        // Optional low-volatility filter (disabled by default — set --min-atr-pct=0.15 to enable)
        if (config.pullbackMinAtrPct > 0) {
          const atrPct = (features.atr14 / features.currentPrice) * 100;
          if (atrPct < config.pullbackMinAtrPct) {
            // Skip this candle — too low volatility
            if (simulator.hasPosition) {
              const trade = simulator.processCandle(candle);
              if (trade) trades.push(trade);
            }
            continue;
          }
        }

        if (pbState === 'NO_SETUP') {
          // Step 1: Detect HTF bias
          if (htfSlice.length >= 21) {
            const htfFeatures = this.indicators.computeFeatures(htfSlice);
            const htfSmc = this.smc.analyze(htfSlice);

            let htfBias: 'LONG' | 'SHORT' | null = null;
            if (htfSmc.marketStructure === 'BULLISH' && htfFeatures.emaCrossover === 'BULLISH') {
              htfBias = 'LONG';
            } else if (htfSmc.marketStructure === 'BEARISH' && htfFeatures.emaCrossover === 'BEARISH') {
              htfBias = 'SHORT';
            } else if (config.pullbackLooseHtf) {
              // Loose mode: EMA directional while structure is RANGING → soft bias.
              // EMAs react faster than swing highs/lows, so use EMA direction when structure lags.
              if (htfFeatures.emaCrossover === 'BULLISH' && htfSmc.marketStructure === 'RANGING') {
                htfBias = 'LONG';
              } else if (htfFeatures.emaCrossover === 'BEARISH' && htfSmc.marketStructure === 'RANGING') {
                htfBias = 'SHORT';
              }
            }

            // HTF 4H tiebreaker: when 1H EMA and structure CONTRADICT (still null),
            // use 4H structure as higher-authority arbiter. Only activates when explicitly enabled.
            if (htfBias === null && config.pullbackHtf4hTiebreaker && htf4hCandles.length > 0) {
              const htf4hSlice = this.getHtfSlice(htf4hCandles, candle.closeTime);
              if (htf4hSlice.length >= 21) {
                const htf4hSmc = this.smc.analyze(htf4hSlice);
                if (htfFeatures.emaCrossover === 'BULLISH' && htfSmc.marketStructure === 'BEARISH' && htf4hSmc.marketStructure === 'BULLISH') {
                  htfBias = 'LONG';
                } else if (htfFeatures.emaCrossover === 'BEARISH' && htfSmc.marketStructure === 'BULLISH' && htf4hSmc.marketStructure === 'BEARISH') {
                  htfBias = 'SHORT';
                }
              }
            }

            // Filter P/D: skip if LONG in PREMIUM or SHORT in DISCOUNT
            if (htfBias && config.filterPremiumDiscount) {
              if (htfBias === 'LONG' && smcFeatures.premiumDiscount === 'PREMIUM') htfBias = null;
              if (htfBias === 'SHORT' && smcFeatures.premiumDiscount === 'DISCOUNT') htfBias = null;
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

                  // Mark confluence zones (OB+FVG overlap)
                  if (config.filterZoneConfluence) {
                    for (let zi = 0; zi < zones.length; zi++) {
                      for (let zj = zi + 1; zj < zones.length; zj++) {
                        if (zones[zi].type === zones[zj].type) continue;
                        const overlap = Math.min(zones[zi].high, zones[zj].high) - Math.max(zones[zi].low, zones[zj].low);
                        if (overlap > 0) {
                          (zones[zi] as any).confluence = true;
                          (zones[zj] as any).confluence = true;
                        }
                      }
                    }
                  }

                  pbState = 'WAITING_PULLBACK';
                  pbBias = htfBias;
                  pbTargetZones = zones;
                  pbWaitStart = i;
                  pbCreatedAtBreakTime = smcFeatures.lastStructureBreak?.time ?? null;
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
          // With --fresh-choch flag: only cancel if the CHoCH is NEWER than the one
          // that existed at setup creation (avoids whipsaw on sticky lastStructureBreak).
          else if (
            smcFeatures.lastStructureBreak &&
            smcFeatures.lastStructureBreak.type === 'CHoCH' &&
            ((pbBias === 'LONG' && smcFeatures.lastStructureBreak.direction === 'BEARISH') ||
             (pbBias === 'SHORT' && smcFeatures.lastStructureBreak.direction === 'BULLISH')) &&
            (!config.pullbackFreshChoch || smcFeatures.lastStructureBreak.time !== pbCreatedAtBreakTime)
          ) {
            pbState = 'NO_SETUP';
          }
          // 3. HTF bias flipped
          else {
            const htfF = htfSlice.length >= 21 ? this.indicators.computeFeatures(htfSlice) : null;
            const htfS = htfSlice.length >= 21 ? this.smc.analyze(htfSlice) : null;
            if (htfF && htfS) {
              let stillBullish = htfS.marketStructure === 'BULLISH' && htfF.emaCrossover === 'BULLISH';
              let stillBearish = htfS.marketStructure === 'BEARISH' && htfF.emaCrossover === 'BEARISH';
              if (config.pullbackLooseHtf) {
                // In loose mode, keep bias if EMA still agrees with bias and structure is RANGING
                if (!stillBullish && htfF.emaCrossover === 'BULLISH' && htfS.marketStructure === 'RANGING') {
                  stillBullish = true;
                }
                if (!stillBearish && htfF.emaCrossover === 'BEARISH' && htfS.marketStructure === 'RANGING') {
                  stillBearish = true;
                }
              }
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

                const signalEntry = zone.high;
                const slRaw = zone.low - features.atr14 * config.pullbackSlBuffer;
                const slDist = Math.max(signalEntry - slRaw, signalEntry * config.slMinPercent);
                // Apply entry slippage (LONG pays MORE than signal when filled via MARKET)
                entryPrice = signalEntry + (config.entrySlippage || 0) + (config.adverseSlip || 0);
                sl = entryPrice - slDist;

                // Don't enter if SL would be hit same candle
                if (candle.low <= sl) continue;

                // Confluence entry filters
                if (config.filterRsiExtreme && features.rsi14 > config.rsiLongMax) continue;
                if (config.filterCandlePattern && !hasCandleConfirm(features.recentCandles, 'LONG')) continue;
                if (config.filterVolumeConfirm && features.volumeAvg20 > 0 && features.lastVolume < features.volumeAvg20 * config.volumeMultiplier) continue;
                if (config.filterZoneConfluence && !(zone as any).confluence) continue;

                const tp = entryPrice + slDist * config.rrRatio;
                const longCtx = this.buildTradeContext(candles, htfCandles, i, features, config);
                if (this.shouldBlockEntry(longCtx, config)) continue;
                simulator.openPosition(
                  'LONG',
                  entryPrice,
                  sl,
                  tp,
                  candle.closeTime,
                  0,
                  (zone as any).confluence ? 0.80 : 0.65,
                  longCtx,
                );
              } else {
                if (candle.open > zone.high) continue;
                if (candle.high < zone.low) continue;

                const signalEntry = zone.low;
                const slRaw = zone.high + features.atr14 * config.pullbackSlBuffer;
                const slDist = Math.max(slRaw - signalEntry, signalEntry * config.slMinPercent);
                // Apply entry slippage (SHORT receives LESS than signal when filled via MARKET)
                entryPrice = signalEntry - (config.entrySlippage || 0) - (config.adverseSlip || 0);
                sl = entryPrice + slDist;

                if (candle.high >= sl) continue;

                // Confluence entry filters
                if (config.filterRsiExtreme && features.rsi14 < config.rsiShortMin) continue;
                if (config.filterCandlePattern && !hasCandleConfirm(features.recentCandles, 'SHORT')) continue;
                if (config.filterVolumeConfirm && features.volumeAvg20 > 0 && features.lastVolume < features.volumeAvg20 * config.volumeMultiplier) continue;
                if (config.filterZoneConfluence && !(zone as any).confluence) continue;

                const tp = entryPrice - slDist * config.rrRatio;
                const shortCtx = this.buildTradeContext(candles, htfCandles, i, features, config);
                if (this.shouldBlockEntry(shortCtx, config)) continue;
                simulator.openPosition(
                  'SHORT',
                  entryPrice,
                  sl,
                  tp,
                  candle.closeTime,
                  0,
                  (zone as any).confluence ? 0.80 : 0.65,
                  shortCtx,
                );
              }

              // Simulate fill probability — deterministic hash from candle time for reproducibility
              if (config.fillRate < 1.0) {
                const hash = ((candle.closeTime * 2654435761) >>> 0) / 4294967296; // 0-1 deterministic
                if (hash >= config.fillRate) {
                  continue; // missed fill — LIMIT didn't execute, skip this zone
                }
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

        const gateOnlyCtx = this.buildTradeContext(candles, htfCandles, i, features, config);
        if (this.shouldBlockEntry(gateOnlyCtx, config)) continue;
        simulator.openPosition(
          direction,
          entryPrice,
          sl,
          tp,
          candle.closeTime,
          gateResult.score,
          confidence,
          gateOnlyCtx,
        );
      }

      // ───── System B — Session Breakout ─────
      if (config.mode === 'session-breakout' && breakoutDetector) {
        const signal = breakoutDetector.processCandle(candles, i, features.atr14);
        if (signal && !simulator.hasPosition && i >= cooldownUntil) {
          const slHitNow =
            signal.direction === 'LONG'
              ? candle.low <= signal.stopLoss
              : candle.high >= signal.stopLoss;
          if (!slHitNow) {
            const sbCtx = this.buildTradeContext(candles, htfCandles, i, features, config);
            if (!this.shouldBlockEntry(sbCtx, config)) {
              simulator.openPosition(
                signal.direction,
                signal.entryPrice,
                signal.stopLoss,
                signal.takeProfit,
                candle.closeTime,
                0,
                0.7,
                sbCtx,
              );
            }
          }
        }
      }

      // ───── System B v2 — Mean Reversion ─────
      if (config.mode === 'mean-reversion' && meanReversionDetector) {
        const signal = meanReversionDetector.processCandle(
          candles,
          i,
          features.rsi14,
          features.atr14,
        );
        if (signal && !simulator.hasPosition && i >= cooldownUntil) {
          const slHitNow =
            signal.direction === 'LONG'
              ? candle.low <= signal.stopLoss
              : candle.high >= signal.stopLoss;
          if (!slHitNow) {
            const mrCtx = this.buildTradeContext(candles, htfCandles, i, features, config);
            if (!this.shouldBlockEntry(mrCtx, config)) {
              simulator.openPosition(
                signal.direction,
                signal.entryPrice,
                signal.stopLoss,
                signal.takeProfit,
                candle.closeTime,
                0,
                0.7,
                mrCtx,
              );
              cooldownUntil = i + config.mrCooldownBars;
            }
          }
        }
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

  /**
   * Build context-at-entry for Phase 1 instrumentation.
   * Captures Δ24h, ATR%, HTF distance, hour-of-day. Used to bucket trades.
   * Computed at entry time (i = candle index) — must be called BEFORE openPosition.
   */
  private buildTradeContext(
    candles: Candle[],
    htfCandles: Candle[],
    i: number,
    features: { atr14: number },
    config: BacktestConfig,
  ): TradeContextAtEntry {
    // Δ24h lookback: 24h en bars del timeframe actual.
    const tfMinutes: Record<string, number> = { '1m': 1, '5m': 5, '15m': 15, '1h': 60 };
    const minutes = tfMinutes[config.timeframe] || 15;
    const lookbackBars = Math.floor((24 * 60) / minutes);
    const lookbackIdx = i - lookbackBars;
    let delta24hAtEntry: number | null = null;
    if (lookbackIdx >= 0) {
      const priceThen = candles[lookbackIdx].close;
      const priceNow = candles[i].close;
      if (priceThen > 0) {
        delta24hAtEntry = ((priceNow - priceThen) / priceThen) * 100;
      }
    }

    const entryPrice = candles[i].close;
    const atrPctAtEntry = entryPrice > 0 ? (features.atr14 / entryPrice) * 100 : 0;

    // HTF distance vs EMA21 del 1H. proxy de "extensión sobre HTF trend".
    let htfDistancePct: number | null = null;
    const htfSlice = this.getHtfSlice(htfCandles, candles[i].closeTime);
    if (htfSlice.length >= 21) {
      const htfFeat = this.indicators.computeFeatures(htfSlice);
      if (htfFeat.ema21 > 0) {
        htfDistancePct = ((entryPrice - htfFeat.ema21) / htfFeat.ema21) * 100;
      }
    }

    const entryHourUtc = new Date(candles[i].closeTime).getUTCHours();

    return {
      delta24hAtEntry,
      atrPctAtEntry,
      htfDistancePct,
      entryHourUtc,
    };
  }

  /**
   * Phase 2 — context filters. Blocks entry if context matches a configured filter.
   * Applied BEFORE openPosition so cooldown/sequencing is honest (different from post-hoc analysis).
   * Returns true if entry should be SKIPPED.
   */
  private shouldBlockEntry(context: TradeContextAtEntry, config: BacktestConfig): boolean {
    if (config.blockSessions.length > 0) {
      const session: SessionLabel =
        context.entryHourUtc < 7  ? 'ASIA' :
        context.entryHourUtc < 12 ? 'EU' :
        context.entryHourUtc < 16 ? 'OVERLAP' : 'US';
      if (config.blockSessions.includes(session)) return true;
    }
    if (config.blockDelta24hBuckets.length > 0 && context.delta24hAtEntry !== null) {
      const abs = Math.abs(context.delta24hAtEntry);
      const bucket: Delta24hBucket =
        abs < 1.0 ? 'CONSOLIDATION' :
        abs < 3.0 ? 'NORMAL' : 'MOMENTUM_EXTREME';
      if (config.blockDelta24hBuckets.includes(bucket)) return true;
    }
    return false;
  }

  private getIntrabarSlice(intrabarCandles: Candle[], afterTime: number, beforeOrEqualTime: number): Candle[] {
    return intrabarCandles.filter((c) => c.closeTime > afterTime && c.closeTime <= beforeOrEqualTime);
  }

  private async downloadKlines(
    symbol: string,
    interval: string,
    days: number,
    startDate?: string,
    endDate?: string,
  ): Promise<Candle[]> {
    const provider = resolveBacktestProvider();
    const intervalMs: Record<string, number> = {
      '1m': 60_000,
      '5m': 300_000,
      '15m': 900_000,
      '1h': 3_600_000,
    };

    const ms = intervalMs[interval] || 900_000;

    let endTimeMs = Date.now();
    let totalCandles: number;
    if (startDate && endDate) {
      const startMs = new Date(startDate + 'T00:00:00Z').getTime();
      endTimeMs = new Date(endDate + 'T23:59:59Z').getTime();
      totalCandles = Math.ceil((endTimeMs - startMs) / ms);
    } else {
      totalCandles = Math.ceil((days * 24 * 60 * 60 * 1000) / ms);
    }

    this.logger.log(
      `Downloading ${totalCandles} ${interval} candles for ${symbol} from ${provider}`,
    );

    if (provider === 'bybit') {
      return this.downloadKlinesBybit(symbol, interval, totalCandles, endTimeMs, ms);
    }
    return this.downloadKlinesBinance(symbol, interval, totalCandles, endTimeMs);
  }

  private async downloadKlinesBinance(
    symbol: string,
    interval: string,
    totalCandles: number,
    endTimeMs: number,
  ): Promise<Candle[]> {
    const allCandles: Candle[] = [];
    let endTime = endTimeMs;

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
        endTime = candles[0].openTime - 1;
        this.logger.log(
          `Downloaded ${allCandles.length}/${totalCandles} candles (Binance)`,
        );
      } catch (err) {
        this.logger.error(`Failed to download Binance klines: ${err}`);
        break;
      }

      await new Promise((r) => setTimeout(r, 500));
    }

    allCandles.sort((a, b) => a.openTime - b.openTime);
    return allCandles;
  }

  private async downloadKlinesBybit(
    symbol: string,
    interval: string,
    totalCandles: number,
    endTimeMs: number,
    intervalMsValue: number,
  ): Promise<Candle[]> {
    const bybitInterval = mapBybitInterval(interval);
    const allCandles: Candle[] = [];
    let endTime = endTimeMs;

    while (allCandles.length < totalCandles) {
      const limit = Math.min(1000, totalCandles - allCandles.length); // Bybit max=1000
      const url =
        `https://api.bybit.com/v5/market/kline` +
        `?category=linear&symbol=${symbol}&interval=${bybitInterval}` +
        `&end=${endTime}&limit=${limit}`;

      try {
        const response = await firstValueFrom(
          this.httpService.get<{
            retCode: number;
            retMsg: string;
            result: { list: string[][] };
          }>(url),
        );
        if (response.data.retCode !== 0) {
          this.logger.error(
            `Bybit API error ${response.data.retCode}: ${response.data.retMsg}`,
          );
          break;
        }
        const list = response.data.result?.list ?? [];
        if (list.length === 0) break;
        // Bybit returns DESC (newest first); reverse for ASC.
        const candles = list
          .slice()
          .reverse()
          .map(
            (row): Candle => {
              const openTime = parseInt(row[0], 10);
              return {
                openTime,
                open: parseFloat(row[1]),
                high: parseFloat(row[2]),
                low: parseFloat(row[3]),
                close: parseFloat(row[4]),
                volume: parseFloat(row[5]),
                closeTime: openTime + intervalMsValue - 1,
                quoteVolume: parseFloat(row[6] ?? '0'),
                trades: 0,
              };
            },
          );
        allCandles.unshift(...candles);
        endTime = candles[0].openTime - 1;
        this.logger.log(
          `Downloaded ${allCandles.length}/${totalCandles} candles (Bybit)`,
        );
      } catch (err) {
        this.logger.error(`Failed to download Bybit klines: ${err}`);
        break;
      }

      await new Promise((r) => setTimeout(r, 200)); // Bybit allows higher rate
    }

    allCandles.sort((a, b) => a.openTime - b.openTime);
    return allCandles;
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function resolveBacktestProvider(): 'binance' | 'bybit' {
  // CLI override: --exchange=binance|bybit
  const cliArg = process.argv.find((a) => a.startsWith('--exchange='));
  const fromCli = cliArg ? cliArg.split('=')[1].toLowerCase() : '';
  if (fromCli === 'binance' || fromCli === 'bybit') return fromCli;
  // Else fall back to env var; default 'binance' to preserve historical
  // backtest behavior when run from a setup that has only Binance configured.
  const env = (process.env.EXCHANGE_PROVIDER ?? 'binance').toLowerCase();
  return env === 'bybit' ? 'bybit' : 'binance';
}

function mapBybitInterval(interval: string): string {
  const m = interval.match(/^(\d+)([mhdw])$/);
  if (!m) return interval;
  const n = m[1];
  const unit = m[2];
  switch (unit) {
    case 'm':
      return n;
    case 'h':
      return (parseInt(n, 10) * 60).toString();
    case 'd':
      return 'D';
    case 'w':
      return 'W';
    default:
      return interval;
  }
}
