import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { ConfigService } from '@nestjs/config';
import { IndicatorsService } from '../strategy/indicators.service';
import { SmcService } from '../strategy/smc.service';
import { PreFilterGateService } from '../strategy/pre-filter-gate.service';
import { PullbackObSignalService, type HtfBiasContext } from '../strategy/pullback-ob-signal.service';
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

  /**
   * Refactor radical 2026-05-19: factory to create a fresh PullbackObSignalService
   * instance per backtest run, with config from backtest options (not live ConfigService).
   * Guarantees same signal generation as live, eliminates state machine duplication.
   */
  private createPullbackService(config: BacktestConfig): PullbackObSignalService {
    // Build a mock ConfigService that returns backtest-specific values
    const overrides: Record<string, unknown> = {
      PULLBACK_FILTER_PD: String(config.filterPremiumDiscount),
      PULLBACK_FILTER_RSI: String(config.filterRsiExtreme),
      PULLBACK_FILTER_CANDLE: String(config.filterCandlePattern),
      PULLBACK_FILTER_CONFLUENCE: String(config.filterZoneConfluence),
      PULLBACK_FILTER_VOLUME: String(config.filterVolumeConfirm),
      PULLBACK_RSI_LONG_MAX: config.rsiLongMax,
      PULLBACK_RSI_SHORT_MIN: config.rsiShortMin,
      PULLBACK_VOL_MULT: config.volumeMultiplier,
      HTF_4H_TIEBREAKER_ENABLED: String(config.pullbackHtf4hTiebreaker),
      HTF_4H_TIEBREAKER_SOFT_ENABLED: String(config.pullbackHtf4hTiebreakerSoft),
      PULLBACK_HTF_FLIP_TOLERANT: String(config.pullbackHtfFlipTolerant),
      PULLBACK_SLOPE_SOFT: String(config.pullbackSlopeSoft),
      PULLBACK_MAX_WAIT_CYCLES: config.pullbackMaxWaitCandles,
      PULLBACK_MIN_ATR_PCT: config.pullbackMinAtrPct,
    };
    const mockConfig = {
      get<T>(key: string, defaultValue?: T): T {
        return (overrides[key] ?? defaultValue) as T;
      },
    } as ConfigService;
    return new PullbackObSignalService(mockConfig);
  }

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

    // 2. Download 1H candles for HTF context.
    // Optimization (2026-05-24): if timeframe is already 1h, reuse — same data,
    // saves 1 API call and avoids Bybit rate limit when running short replays.
    let htfCandles: Candle[];
    if (config.timeframe === '1h') {
      htfCandles = candles;
      this.logger.log(`Reusing ${candles.length} primary candles as HTF (1H) — same timeframe`);
    } else {
      await new Promise((r) => setTimeout(r, 1500)); // pause to avoid rate-limit
      htfCandles = await this.downloadKlines(
        config.symbol,
        '1h',
        config.days,
        config.startDate,
        config.endDate,
      );
      this.logger.log(`Downloaded ${htfCandles.length} HTF (1H) candles`);
    }

    // 2a. Download 4H candles for HTF 4H tiebreaker (only if enabled — saves bandwidth)
    let htf4hCandles: Candle[] = [];
    if (config.pullbackHtf4hTiebreaker) {
      await new Promise((r) => setTimeout(r, 1500));
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
      await new Promise((r) => setTimeout(r, 1500));
      intrabarCandles = await this.downloadKlines(
        config.symbol,
        '1m',
        config.days,
        config.startDate,
        config.endDate,
      );
      this.logger.log(`Downloaded ${intrabarCandles.length} intrabar (1m) candles`);
    }

    // 2c. REFACTOR RADICAL (2026-05-19): create fresh PullbackObSignalService instance.
    // Eliminates state machine duplication — uses EXACT live code for signal generation.
    // Only fill simulation remains backtest-specific (LIMIT/IOC, slippage, etc).
    const pullbackOb = this.createPullbackService(config);
    this.logger.log('PullbackObSignalService instance created for backtest (live code path)');

    // 2d. #3 REPLAY FRAMEWORK (2026-05-23): load state from live bot snapshot.
    // When replayFromSnapshotFile is set, restore the state machine to match the
    // live bot at a specific cycle, then replay forward to validate that the
    // backtest engine reproduces the live bot's decisions.
    let replayStartTime: number | null = null;
    if (config.replayFromSnapshotFile) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const fs = require('fs') as typeof import('fs');
        const raw = fs.readFileSync(config.replayFromSnapshotFile, 'utf-8');
        const snap = JSON.parse(raw) as {
          cycleAt: string;
          symbol: string;
          timeframe?: string;
          state: 'IDLE' | 'WAITING_PULLBACK';
          bias: 'LONG' | 'SHORT';
          activeZones: Array<{
            type: 'OB' | 'FVG';
            high: number;
            low: number;
            confluence?: boolean;
          }>;
          waitCycles: number;
          createdAtBreakTime: number | null;
        };
        if (snap.symbol !== config.symbol) {
          this.logger.warn(
            `[REPLAY] Snapshot symbol ${snap.symbol} != config ${config.symbol}. Skipping replay restore.`,
          );
        } else {
          pullbackOb.restoreFromSnapshot(config.symbol, {
            state: snap.state,
            bias: snap.bias,
            activeZones: snap.activeZones,
            waitCycles: snap.waitCycles,
            createdAtBreakTime: snap.createdAtBreakTime,
          });
          replayStartTime = new Date(snap.cycleAt).getTime();
          this.logger.log(
            `[REPLAY] State restored from snapshot at ${snap.cycleAt}. ` +
              `Processing candles strictly AFTER this time.`,
          );
        }
      } catch (err) {
        this.logger.error(`[REPLAY] Failed to load snapshot: ${err}`);
        throw err;
      }
    }

    // 3. Run simulation
    const trades: BacktestTrade[] = [];
    // FIX 2026-05-19 (sizing): match live MAX_POSITION_NOTIONAL_USDT=50 (with auto-bump
    // to 0.001 BTC min step). Old behavior used $450 notional → qty=0.0058 → 5.8x more fees
    // → all trades artificially perdedores. Real live qty is 0.001 with ~$77 actual notional.
    const liveMatchedNotional = 50; // matches live MAX_POSITION_NOTIONAL_USDT env var
    const simulator = new TradeSimulator(
      config.commissionRate,
      liveMatchedNotional,
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

    // Warmup: indicators (ATR, EMA, RSI) need ~50 candles of history before reliable.
    // In #3 REPLAY mode, the state machine is pre-loaded — we still need indicator
    // warmup but can shrink it to the minimum (50) if dataset is small.
    const warmup = replayStartTime !== null
      ? Math.min(50, Math.floor(candles.length / 2))
      : 100;
    this.logger.log(`Warmup: ${warmup} candles (replay mode: ${replayStartTime !== null})`);
    let gatePassCount = 0;
    let cooldownUntil = 0;

    // FASE 1.2 — Métricas lifecycle separadas (added 2026-05-18 reconciliación live/backtest)
    let ordersPlaced = 0;        // LIMIT orders attempted
    let ordersFilled = 0;        // Fills successful (limit or IOC)
    let ordersExpired = 0;       // Both LIMIT and IOC failed
    let iocFills = 0;            // Filled via IOC fallback (vs LIMIT direct)
    let ghostTradesPrevented = 0; // Trades that old buggy engine would have opened

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

      // #3 REPLAY MODE: skip candles AT OR BEFORE the snapshot's cycleAt.
      // The snapshot represents state AT that cycle; we need to start fresh
      // from the NEXT cycle to avoid double-processing the candle that already
      // shaped the loaded state.
      if (replayStartTime !== null && candle.closeTime <= replayStartTime) {
        continue;
      }

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
        // REFACTOR RADICAL (2026-05-19): use live PullbackObSignalService directly.
        // Eliminates state machine duplication. State managed internally by the service.

        // Build HTF context (1h + 4h) — same way live signal-generator does it
        const htfSlice = this.getHtfSlice(htfCandles, candle.closeTime);
        let htfContext: HtfBiasContext | null = null;
        if (htfSlice.length >= 21) {
          const htfFeatures = this.indicators.computeFeatures(htfSlice);
          const htfSmc = this.smc.analyze(htfSlice);
          let struct4h: string | null = null;
          if (config.pullbackHtf4hTiebreaker && htf4hCandles.length > 0) {
            const htf4hSlice = this.getHtfSlice(htf4hCandles, candle.closeTime);
            if (htf4hSlice.length >= 21) {
              struct4h = this.smc.analyze(htf4hSlice).marketStructure;
            }
          }
          htfContext = {
            emaCrossover: htfFeatures.emaCrossover,
            marketStructure: htfSmc.marketStructure,
            marketStructure4h: struct4h,
          };
        }

        // Call LIVE service — same code path as production
        const result = pullbackOb.generateSignal(
          features,
          smcFeatures,
          config.symbol,
          htfContext,
        );

        // No actionable signal — continue to next cycle
        if (result.action !== 'LONG' && result.action !== 'SHORT') {
          continue;
        }

        const isLong = result.action === 'LONG';
        const signalEntry = result.suggestedEntryPrice!;
        let sl = result.suggestedStopLoss!;
        const tpInitial = result.suggestedTakeProfit!;

        // Pre-order block filters (matches live risk-manager.evaluateSignal BEFORE order)
        const tradeCtx = this.buildTradeContext(candles, htfCandles, i, features, config);
        if (this.shouldBlockEntry(tradeCtx, config)) continue;

        // Cooldown check (matches live RiskManager.checkCooldown)
        if (i < cooldownUntil) continue;

        // ─── FILL SIMULATION ───
        const limitWaitMs = 180_000;
        const iocEnabled = config.iocFallbackEnabled !== false;
        const iocMaxSlipUsd = config.iocFallbackMaxSlipUsd ?? 50;

        ordersPlaced++;
        const fillWindowEnd = candle.closeTime + limitWaitMs;
        const fillSubCandles = this.getIntrabarSlice(intrabarCandles, candle.closeTime, fillWindowEnd);

        let actualEntryPrice: number | null = null;
        let fillTime: number | null = null;
        let filledViaIoc = false;

        if (config.marketEntry) {
          // MARKET ENTRY MODE (2026-05-24): fill immediately at signal-trigger price
          // + taker slippage. Bypasses LIMIT adverse selection. ALWAYS fills.
          // The signal fired because this candle touched the zone, so the trigger
          // price is the zone boundary (signalEntry). MARKET fills at boundary +
          // slippage (worse for us = realistic taker execution).
          const slip = config.marketEntrySlippageUsd ?? 5;
          actualEntryPrice = isLong ? signalEntry + slip : signalEntry - slip;
          fillTime = candle.closeTime;
        } else {
          // Phase 1: LIMIT GTC — fills only if price reaches limitPrice
          for (const sub of fillSubCandles) {
            if (isLong) {
              if (sub.open <= signalEntry) {
                actualEntryPrice = sub.open;
                fillTime = sub.closeTime;
                break;
              } else if (sub.low <= signalEntry) {
                actualEntryPrice = signalEntry;
                fillTime = sub.closeTime;
                break;
              }
            } else {
              if (sub.open >= signalEntry) {
                actualEntryPrice = sub.open;
                fillTime = sub.closeTime;
                break;
              } else if (sub.high >= signalEntry) {
                actualEntryPrice = signalEntry;
                fillTime = sub.closeTime;
                break;
              }
            }
          }

          // Phase 2: IOC fallback (if enabled)
          if (actualEntryPrice === null && iocEnabled && fillSubCandles.length > 0) {
            const lastSub = fillSubCandles[fillSubCandles.length - 1];
            const marketPrice = lastSub.close;
            const slipCapPrice = isLong ? signalEntry + iocMaxSlipUsd : signalEntry - iocMaxSlipUsd;
            if (isLong && marketPrice <= slipCapPrice) {
              actualEntryPrice = marketPrice;
              fillTime = lastSub.closeTime;
              filledViaIoc = true;
            } else if (!isLong && marketPrice >= slipCapPrice) {
              actualEntryPrice = marketPrice;
              fillTime = lastSub.closeTime;
              filledViaIoc = true;
            }
          }
        }

        if (actualEntryPrice === null) {
          ordersExpired++;
          ghostTradesPrevented++;
          continue;
        }

        ordersFilled++;
        if (filledViaIoc) iocFills++;

        // Apply slippage
        const entryPrice = isLong
          ? actualEntryPrice + (config.entrySlippage || 0) + (config.adverseSlip || 0)
          : actualEntryPrice - (config.entrySlippage || 0) - (config.adverseSlip || 0);

        // Recalc SL/TP from actual fill if drift > $50 (matches live)
        const slDist = Math.abs(signalEntry - sl);
        if (Math.abs(entryPrice - signalEntry) > 50) {
          sl = isLong ? entryPrice - slDist : entryPrice + slDist;
        }
        const tp = isLong ? entryPrice + slDist * config.rrRatio : entryPrice - slDist * config.rrRatio;

        simulator.openPosition(
          isLong ? 'LONG' : 'SHORT',
          entryPrice,
          sl,
          tp,
          fillTime ?? candle.closeTime,
          0,
          result.confidence,
          tradeCtx,
        );
        cooldownUntil = i + config.cooldownCandles;
        continue;
      }

      // OLD INLINE PULLBACK-OB STATE MACHINE — DELETED in refactor 2026-05-19
      // (replaced by direct call to PullbackObSignalService above)
      /* DELETED_REFACTOR_2026_05_19_START
      if (false) {
          // Step 1: Detect HTF bias — uses determineHtfBiasBT to match live exactly.
          // Consolidated 2026-05-15 (was inline duplication of live logic, now single source).
          if (htfSlice.length >= 21) {
            const htfFeatures = this.indicators.computeFeatures(htfSlice);
            const htfSmc = this.smc.analyze(htfSlice);

            // 4H structure if tiebreaker enabled
            let struct4h: string | null = null;
            if (config.pullbackHtf4hTiebreaker && htf4hCandles.length > 0) {
              const htf4hSliceCreate = this.getHtfSlice(htf4hCandles, candle.closeTime);
              if (htf4hSliceCreate.length >= 21) {
                struct4h = this.smc.analyze(htf4hSliceCreate).marketStructure;
              }
            }

            let htfBias = this.determineHtfBiasBT(
              htfFeatures.emaCrossover,
              htfSmc.marketStructure,
              struct4h,
              config,
            );

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
                  // BUG #1 FIX (2026-05-19): Don't evaluate entry trigger in the same cycle
                  // where setup was created. Live behavior: setup_created → action=HOLD → next cycle.
                  // Use a flag to skip trigger evaluation below for this cycle only.
                  setupJustCreated = true;
                }
              }
            }
          }
        }

        if (pbState === 'WAITING_PULLBACK' && !setupJustCreated) {
          // Check invalidation FIRST

          // 1. Timeout
          if (i - pbWaitStart > config.pullbackMaxWaitCandles) {
            pbState = 'NO_SETUP';
          }
          // 2. CHoCH against bias on 15m — FRESH check ALWAYS ON (matches live behavior).
          // Live (PullbackObSignalService) always checks `time !== createdAtBreakTime`.
          // Without this, backtest invalidates more aggressively than live → understates capture.
          // Reconciled 2026-05-15 (was gated by pullbackFreshChoch flag, now hardcoded).
          else if (
            smcFeatures.lastStructureBreak &&
            smcFeatures.lastStructureBreak.type === 'CHoCH' &&
            smcFeatures.lastStructureBreak.time !== pbCreatedAtBreakTime &&
            ((pbBias === 'LONG' && smcFeatures.lastStructureBreak.direction === 'BEARISH') ||
             (pbBias === 'SHORT' && smcFeatures.lastStructureBreak.direction === 'BULLISH'))
          ) {
            pbState = 'NO_SETUP';
          }
          // 3. HTF bias flipped — matches live PullbackObSignalService.generateSignal
          // Live uses determineHtfBias() which includes 4H tiebreaker for both creation
          // AND invalidation. Reconciled 2026-05-15 (was checking stillBullish/Bearish
          // directly without 4H consideration, mismatched live).
          else {
            const htfF = htfSlice.length >= 21 ? this.indicators.computeFeatures(htfSlice) : null;
            const htfS = htfSlice.length >= 21 ? this.smc.analyze(htfSlice) : null;
            if (htfF && htfS) {
              // Compute current 4H structure if tiebreaker enabled
              let struct4h: string | null = null;
              if (config.pullbackHtf4hTiebreaker && htf4hCandles.length > 0) {
                const htf4hSliceInv = this.getHtfSlice(htf4hCandles, candle.closeTime);
                if (htf4hSliceInv.length >= 21) {
                  struct4h = this.smc.analyze(htf4hSliceInv).marketStructure;
                }
              }
              const currentBias = this.determineHtfBiasBT(
                htfF.emaCrossover,
                htfS.marketStructure,
                struct4h,
                config,
              );
              if (currentBias !== pbBias && currentBias !== null) {
                let shouldInvalidate = true;
                if (config.pullbackHtfFlipTolerant) {
                  // Live logic: keep setup if structure doesn't actively contradict bias
                  const structureStillAligned =
                    (pbBias === 'LONG' && htfS.marketStructure !== 'BEARISH') ||
                    (pbBias === 'SHORT' && htfS.marketStructure !== 'BULLISH');
                  if (structureStillAligned) shouldInvalidate = false;
                }
                if (shouldInvalidate) {
                  pbState = 'NO_SETUP';
                }
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
            // PULLBACK_SLOPE_SOFT=true: skip slope filter entirely (forced slopeOk=true)
            const slopeOk = config.pullbackSlopeSoft ? true :
              (pbBias === 'LONG' && features.emaSlope !== 'FALLING') ||
              (pbBias === 'SHORT' && features.emaSlope !== 'RISING');

            if (slopeOk) {
            for (const zone of pbTargetZones) {
              let signalEntry: number;
              let slDist: number;
              let sl: number;
              const isLong = pbBias === 'LONG';

              if (isLong) {
                if (candle.open < zone.low) continue;
                if (candle.low > zone.high) continue;

                signalEntry = zone.high;
                const slRaw = zone.low - features.atr14 * config.pullbackSlBuffer;
                slDist = Math.max(signalEntry - slRaw, signalEntry * config.slMinPercent);
                sl = signalEntry - slDist;

                if (config.filterRsiExtreme && features.rsi14 > config.rsiLongMax) continue;
                if (config.filterCandlePattern && !hasCandleConfirm(features.recentCandles, 'LONG')) continue;
                if (config.filterVolumeConfirm && features.volumeAvg20 > 0 && features.lastVolume < features.volumeAvg20 * config.volumeMultiplier) continue;
                if (config.filterZoneConfluence && !(zone as any).confluence) continue;
              } else {
                if (candle.open > zone.high) continue;
                if (candle.high < zone.low) continue;

                signalEntry = zone.low;
                const slRaw = zone.high + features.atr14 * config.pullbackSlBuffer;
                slDist = Math.max(slRaw - signalEntry, signalEntry * config.slMinPercent);
                sl = signalEntry + slDist;

                if (config.filterRsiExtreme && features.rsi14 < config.rsiShortMin) continue;
                if (config.filterCandlePattern && !hasCandleConfirm(features.recentCandles, 'SHORT')) continue;
                if (config.filterVolumeConfirm && features.volumeAvg20 > 0 && features.lastVolume < features.volumeAvg20 * config.volumeMultiplier) continue;
                if (config.filterZoneConfluence && !(zone as any).confluence) continue;
              }

              // ─── REALISTIC FILL SIMULATION v2 (2026-05-18, audit feedback) ───
              // Signal detected at close of candle N. Lifecycle in correct order:
              //   1. preOrderBlock filters (BEFORE placing order — matches live risk-manager)
              //   2. LIMIT GTC 180s at signalEntry
              //   3. IOC fallback ±$50 if LIMIT expires
              //   4. If neither fills → no trade, ghost prevented

              // FIX #1: pre-order filters BEFORE counting orderPlaced (matches live secuencia)
              const tradeCtx = this.buildTradeContext(candles, htfCandles, i, features, config);
              if (this.shouldBlockEntry(tradeCtx, config)) continue;

              // FIX #2: Read LIMIT TTL & IOC cap from env (matches live behavior dynamically)
              const limitWaitMs = 180_000; // matches LIMIT_WAIT_MS hardcoded in execution.service.ts:167
              const iocEnabled = config.iocFallbackEnabled !== false;
              const iocMaxSlipUsd = config.iocFallbackMaxSlipUsd ?? 50;

              ordersPlaced++;
              const fillWindowEnd = candle.closeTime + limitWaitMs;
              const fillSubCandles = this.getIntrabarSlice(intrabarCandles, candle.closeTime, fillWindowEnd);

              let actualEntryPrice: number | null = null;
              let fillTime: number | null = null;
              let filledViaIoc = false;

              // Phase 1: LIMIT GTC — fills only if price reaches limitPrice
              for (const sub of fillSubCandles) {
                if (isLong) {
                  if (sub.open <= signalEntry) {
                    actualEntryPrice = sub.open;
                    fillTime = sub.closeTime;
                    break;
                  } else if (sub.low <= signalEntry) {
                    actualEntryPrice = signalEntry;
                    fillTime = sub.closeTime;
                    break;
                  }
                } else {
                  if (sub.open >= signalEntry) {
                    actualEntryPrice = sub.open;
                    fillTime = sub.closeTime;
                    break;
                  } else if (sub.high >= signalEntry) {
                    actualEntryPrice = signalEntry;
                    fillTime = sub.closeTime;
                    break;
                  }
                }
              }

              // Phase 2: IOC fallback (only if enabled, matches live)
              if (actualEntryPrice === null && iocEnabled && fillSubCandles.length > 0) {
                const lastSub = fillSubCandles[fillSubCandles.length - 1];
                const marketPrice = lastSub.close;
                const slipCapPrice = isLong ? signalEntry + iocMaxSlipUsd : signalEntry - iocMaxSlipUsd;

                if (isLong && marketPrice <= slipCapPrice) {
                  actualEntryPrice = marketPrice;
                  fillTime = lastSub.closeTime;
                  filledViaIoc = true;
                } else if (!isLong && marketPrice >= slipCapPrice) {
                  actualEntryPrice = marketPrice;
                  fillTime = lastSub.closeTime;
                  filledViaIoc = true;
                }
              }

              if (actualEntryPrice === null) {
                ordersExpired++;
                ghostTradesPrevented++;
                continue;
              }

              ordersFilled++;
              if (filledViaIoc) iocFills++;

              const entryPrice = isLong
                ? actualEntryPrice + (config.entrySlippage || 0) + (config.adverseSlip || 0)
                : actualEntryPrice - (config.entrySlippage || 0) - (config.adverseSlip || 0);

              // Recalc SL/TP from actual fill if drift > $50 (matches live execution.service.ts:325+)
              if (Math.abs(entryPrice - signalEntry) > 50) {
                sl = isLong ? entryPrice - slDist : entryPrice + slDist;
              }
              const tp = isLong ? entryPrice + slDist * config.rrRatio : entryPrice - slDist * config.rrRatio;

              simulator.openPosition(
                isLong ? 'LONG' : 'SHORT',
                entryPrice,
                sl,
                tp,
                fillTime ?? candle.closeTime,
                0,
                (zone as any).confluence ? 0.80 : 0.65,
                tradeCtx,
              );

              pbState = 'NO_SETUP';
              pbTargetZones = [];
              break;
            }
            } // end pdOk && rsiOk && slopeOk
          }
        }
      }
      DELETED_REFACTOR_2026_05_19_END */

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

    // FASE 1.2 — Log lifecycle metrics for backtest/live parity diagnosis
    const fillRate = ordersPlaced > 0 ? (ordersFilled / ordersPlaced) * 100 : 0;
    this.logger.log(
      `📊 LIFECYCLE METRICS:\n` +
        `  Orders Placed:           ${ordersPlaced}\n` +
        `  Orders Filled (success): ${ordersFilled}\n` +
        `  Orders Expired (abort):  ${ordersExpired}\n` +
        `  Fill Rate:               ${fillRate.toFixed(1)}%\n` +
        `  IOC fallback fills:      ${iocFills}\n` +
        `  Ghost trades prevented:  ${ghostTradesPrevented}\n` +
        `  Real trades (closed):    ${trades.length}`,
    );

    return report;
  }

  private getHtfSlice(htfCandles: Candle[], beforeTime: number): Candle[] {
    const filtered = htfCandles.filter((c) => c.closeTime <= beforeTime);
    return filtered.slice(-100);
  }

  /**
   * Replica funcionalmente PullbackObSignalService.determineHtfBias del live.
   * Crítico para reconciliar el "Diferencia #2: HTF flip via determineHtfBias"
   * identificada en code review 2026-05-15. Usa misma lógica que producción
   * para creation Y invalidation del setup.
   */
  private determineHtfBiasBT(
    emaCross: string,
    structure: string,
    structure4h: string | null,
    config: BacktestConfig,
  ): 'LONG' | 'SHORT' | null {
    // Strong bias
    if (emaCross === 'BULLISH' && structure === 'BULLISH') return 'LONG';
    if (emaCross === 'BEARISH' && structure === 'BEARISH') return 'SHORT';

    // Loose mode: EMA directional + structure RANGING
    if (config.pullbackLooseHtf) {
      if (emaCross === 'BULLISH' && structure === 'RANGING') return 'LONG';
      if (emaCross === 'BEARISH' && structure === 'RANGING') return 'SHORT';
    }

    // 4H tiebreaker
    if (config.pullbackHtf4hTiebreaker && structure4h) {
      // Strict: 4H confirms EMA direction
      if (emaCross === 'BULLISH' && structure === 'BEARISH' && structure4h === 'BULLISH') return 'LONG';
      if (emaCross === 'BEARISH' && structure === 'BULLISH' && structure4h === 'BEARISH') return 'SHORT';
      // SOFT: 4H is RANGING
      if (config.pullbackHtf4hTiebreakerSoft) {
        if (emaCross === 'BULLISH' && structure === 'BEARISH' && structure4h === 'RANGING') return 'LONG';
        if (emaCross === 'BEARISH' && structure === 'BULLISH' && structure4h === 'RANGING') return 'SHORT';
      }
    }

    return null;
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
          // Rate-limit (10006) — backoff and retry once before giving up.
          if (response.data.retCode === 10006) {
            this.logger.warn(
              `Bybit rate-limit (10006). Sleeping 5s and retrying once...`,
            );
            await new Promise((r) => setTimeout(r, 5000));
            const retry = await firstValueFrom(
              this.httpService.get<{
                retCode: number;
                retMsg: string;
                result: { list: string[][] };
              }>(url),
            );
            if (retry.data.retCode !== 0) {
              this.logger.error(
                `Bybit retry failed ${retry.data.retCode}: ${retry.data.retMsg}`,
              );
              break;
            }
            response.data = retry.data;
          } else {
            this.logger.error(
              `Bybit API error ${response.data.retCode}: ${response.data.retMsg}`,
            );
            break;
          }
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
