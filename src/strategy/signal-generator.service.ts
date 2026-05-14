import { Injectable, Logger, Inject } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IExchangeRest } from '../exchange/interfaces/exchange.interfaces';
import { TelemetryService } from '../trading/telemetry.service';
import { IndicatorsService, type IndicatorFeatures } from './indicators.service';
import { SmcService, type SmcFeatures } from './smc.service';
import { DeepSeekService, type DeltaChanges, type HtfContext } from './deepseek.service';
import { HybridSignalService } from './hybrid-signal.service';
import { PullbackObSignalService } from './pullback-ob-signal.service';
import { PreFilterGateService, type GateResult } from './pre-filter-gate.service';
import { SignalCacheService } from './signal-cache.service';
import { deepSeekResponseSchema } from './schemas/deepseek-response.schema';
import { signalSchema, type ValidatedSignal } from './schemas/signal.schema';

export interface AnalysisSummary {
  price: number;
  ema9: number;
  ema21: number;
  emaCrossover: string;
  emaSlope: string;
  rsi: number;
  atr: number;
  atrPercent: number;
  marketStructure: string;
  premiumDiscount: string;
  orderBlocks: number;
  fairValueGaps: number;
  priceInOB: boolean;
  priceInFVG: boolean;
  lastStructureBreak: string | null;
  aiAction: string | null;
  aiConfidence: number | null;
  aiReasoning: string | null;
  timestamp: number;
  // HTF context
  htf?: {
    ema9: number;
    ema21: number;
    emaCrossover: string;
    rsi: number;
    marketStructure: string;
    premiumDiscount: string;
  } | null;
  // Delta changes
  delta?: {
    rsiDelta: number;
    priceChangePct: number;
    zoneChanged: boolean;
    structureChanged: boolean;
  } | null;
}

export interface GenerateSignalResult {
  signal: ValidatedSignal | null;
  gateResult: GateResult | null;
  cacheHit: boolean;
  analysis: AnalysisSummary | null;
}

// Store previous cycle data for delta computation
interface PreviousCycleData {
  price: number;
  rsi: number;
  atrPercent: number;
  zone: string;
  structure: string;
  lastBreakType: string | null;
  obCount: number;
  fvgCount: number;
  timestamp: number;
}

interface DailyMetrics {
  date: string;
  cycles: number;
  setupsCreated: number;
  entriesAttempted: number;
  blocked: Map<string, number>;
}

@Injectable()
export class SignalGeneratorService {
  private readonly logger = new Logger(SignalGeneratorService.name);
  private readonly gateEnabled: boolean;
  private previousCycle: PreviousCycleData | null = null;
  private cyclesSinceLastAction = 0;
  private dailyMetrics: DailyMetrics = {
    date: '',
    cycles: 0,
    setupsCreated: 0,
    entriesAttempted: 0,
    blocked: new Map(),
  };

  constructor(
    @Inject(IExchangeRest)
    private readonly exchange: IExchangeRest,
    private readonly indicators: IndicatorsService,
    private readonly smc: SmcService,
    private readonly deepseek: DeepSeekService,
    private readonly hybrid: HybridSignalService,
    private readonly pullbackOb: PullbackObSignalService,
    private readonly gate: PreFilterGateService,
    private readonly signalCache: SignalCacheService,
    private readonly config: ConfigService,
    private readonly telemetry: TelemetryService,
  ) {
    this.gateEnabled = this.config.get<boolean>('GATE_ENABLED', true);
  }

  async generateSignal(
    symbol: string,
    interval: string,
  ): Promise<GenerateSignalResult> {
    // 1. Fetch historical candles
    const candles = await this.exchange.getKlines(symbol, interval, 100);

    if (candles.length < 30) {
      this.logger.warn(`Insufficient candles for ${symbol}: ${candles.length}`);
      return { signal: null, gateResult: null, cacheHit: false, analysis: null };
    }

    // 2. Calculate technical indicators (5m)
    const features = this.indicators.computeFeatures(candles);
    this.logger.log(
      `Indicators: price=${features.currentPrice} ema9=${features.ema9.toFixed(2)} ` +
        `ema21=${features.ema21.toFixed(2)} rsi=${features.rsi14.toFixed(1)} ` +
        `atr=${features.atr14.toFixed(2)} cross=${features.emaCrossover}`,
    );

    // 3. Calculate Smart Money Concepts (5m)
    const smcFeatures = this.smc.analyze(candles);
    this.logger.log(
      `SMC: structure=${smcFeatures.marketStructure} ` +
        `zone=${smcFeatures.premiumDiscount} ` +
        `OBs=${smcFeatures.activeOrderBlocks.length} ` +
        `FVGs=${smcFeatures.activeFairValueGaps.length} ` +
        `inOB=${smcFeatures.priceInOrderBlock} inFVG=${smcFeatures.priceInFVG}`,
    );

    // 4. Compute delta changes from previous cycle
    const deltaChanges = this.computeDelta(features, smcFeatures);
    if (deltaChanges) {
      this.logger.log(
        `Delta: RSI${deltaChanges.rsiDelta > 0 ? '+' : ''}${deltaChanges.rsiDelta.toFixed(1)} ` +
          `price${deltaChanges.priceChangePct > 0 ? '+' : ''}${deltaChanges.priceChangePct.toFixed(3)}% ` +
          `zone=${deltaChanges.zoneChanged ? 'CHANGED' : 'same'} ` +
          `structure=${deltaChanges.structureChanged ? 'CHANGED' : 'same'} ` +
          `cycles_no_action=${deltaChanges.cyclesSinceLastAction}`,
      );
    }

    // 5. Fetch and compute HTF (1h) context + 4H structure tiebreaker (parallel)
    let htfContext: HtfContext | null = null;
    let htf4hStructure: string | null = null;
    try {
      const [htf1h, struct4h] = await Promise.all([
        this.computeHtfContext(symbol),
        this.computeHtf4hStructure(symbol),
      ]);
      htfContext = htf1h;
      htf4hStructure = struct4h;
      if (htfContext) {
        this.logger.log(
          `HTF(1h): structure=${htfContext.marketStructure} ` +
            `zone=${htfContext.premiumDiscount} ` +
            `rsi=${htfContext.rsi14.toFixed(1)} cross=${htfContext.emaCrossover} ` +
            `| 4H structure=${htf4hStructure ?? 'n/a'}`,
        );
      }
    } catch (err) {
      this.logger.warn('Failed to compute HTF context, continuing without it');
    }

    // Build analysis summary (available at every return point from here)
    const buildAnalysis = (
      aiAction?: string | null,
      aiConfidence?: number | null,
      aiReasoning?: string | null,
    ): AnalysisSummary => ({
      price: features.currentPrice,
      ema9: features.ema9,
      ema21: features.ema21,
      emaCrossover: features.emaCrossover,
      emaSlope: features.emaSlope,
      rsi: features.rsi14,
      atr: features.atr14,
      atrPercent: features.atrPercent,
      marketStructure: smcFeatures.marketStructure,
      premiumDiscount: smcFeatures.premiumDiscount,
      orderBlocks: smcFeatures.activeOrderBlocks.length,
      fairValueGaps: smcFeatures.activeFairValueGaps.length,
      priceInOB: smcFeatures.priceInOrderBlock,
      priceInFVG: smcFeatures.priceInFVG,
      lastStructureBreak: smcFeatures.lastStructureBreak
        ? `${smcFeatures.lastStructureBreak.type} ${smcFeatures.lastStructureBreak.direction}`
        : null,
      aiAction: aiAction ?? null,
      aiConfidence: aiConfidence ?? null,
      aiReasoning: aiReasoning ?? null,
      timestamp: Date.now(),
      htf: htfContext
        ? {
            ema9: htfContext.ema9,
            ema21: htfContext.ema21,
            emaCrossover: htfContext.emaCrossover,
            rsi: htfContext.rsi14,
            marketStructure: htfContext.marketStructure,
            premiumDiscount: htfContext.premiumDiscount,
          }
        : null,
      delta: deltaChanges
        ? {
            rsiDelta: deltaChanges.rsiDelta,
            priceChangePct: deltaChanges.priceChangePct,
            zoneChanged: deltaChanges.zoneChanged,
            structureChanged: deltaChanges.structureChanged,
          }
        : null,
    });

    // Save current cycle for next delta computation
    this.saveCycleData(features, smcFeatures);

    // 6. Pre-filter gate
    let gateResult: GateResult | null = null;
    const strategyMode = this.config.get<string>('STRATEGY_MODE', 'hybrid');
    const isPullbackMode = strategyMode === 'pullback-ob';

    if (this.gateEnabled) {
      gateResult = this.gate.evaluate(features, smcFeatures);
      this.logger.log(
        `Gate: score=${gateResult.score} passed=${gateResult.passed} reason="${gateResult.reason}"`,
      );
      // For pullback mode, skip gate blocking (state machine needs to run every cycle)
      if (!isPullbackMode && !gateResult.passed) {
        this.cyclesSinceLastAction++;
        return { signal: null, gateResult, cacheHit: false, analysis: buildAnalysis() };
      }
    }

    // 7. Signal cache check (skip for pullback mode — stateful strategy)
    if (!isPullbackMode) {
      const cacheCheck = this.signalCache.shouldSkip(features, smcFeatures);
      if (cacheCheck.skip) {
        this.logger.log(`Cache HIT: ${cacheCheck.reason}`);
        if (this.gateEnabled) this.gate.recordCacheHit();
        this.cyclesSinceLastAction++;
        return { signal: null, gateResult, cacheHit: true, analysis: buildAnalysis() };
      }
    }

    // 8. Generate signal based on strategy mode
    if (this.gateEnabled) this.gate.recordApiCall();

    let hybridResult: { action: string; confidence: number; reasoning: string; suggestedEntryPrice?: number | null; suggestedStopLoss: number | null; suggestedTakeProfit: number | null };

    if (isPullbackMode) {
      // Pullback-OB strategy (stateful, zone-based entries)
      hybridResult = this.pullbackOb.generateSignal(
        features,
        smcFeatures,
        symbol,
        htfContext
          ? {
              emaCrossover: htfContext.emaCrossover,
              marketStructure: htfContext.marketStructure,
              marketStructure4h: htf4hStructure,
            }
          : null,
      );
    } else {
      // Legacy hybrid strategy (EMA crossover + breakout)
      let prevFeatures: IndicatorFeatures | null = null;
      if (this.previousCycle) {
        prevFeatures = {
          ...features,
          emaCrossover: this.previousCycle.structure === 'BULLISH' ? 'BULLISH' : 'BEARISH',
        } as IndicatorFeatures;
      }
      hybridResult = this.hybrid.generateSignal(
        features,
        smcFeatures,
        symbol,
        htfContext,
        prevFeatures,
      );
    }

    this.logger.log(
      `${isPullbackMode ? 'Pullback' : 'Hybrid'}: action=${hybridResult.action} confidence=${hybridResult.confidence.toFixed(2)} ` +
        `reason="${hybridResult.reasoning.slice(0, 80)}..."`,
    );

    // Telemetría diaria (solo pullback mode — diagnóstico gap live vs backtest)
    if (isPullbackMode) {
      this.recordCycleMetrics(hybridResult.action, hybridResult.reasoning);
    }

    // Skip HOLD signals
    if (hybridResult.action === 'HOLD') {
      this.logger.log('Signal: HOLD — no action');
      this.signalCache.cacheHoldResult(features, smcFeatures);
      this.cyclesSinceLastAction++;
      return {
        signal: null,
        gateResult,
        cacheHit: false,
        analysis: buildAnalysis(hybridResult.action, hybridResult.confidence, hybridResult.reasoning),
      };
    }

    // Build validated signal
    const currentPrice = features.currentPrice;
    const defaultStopDistance = features.atr14 * 1.5;
    const defaultTpDistance = defaultStopDistance * 2;

    const stopLoss =
      hybridResult.suggestedStopLoss ??
      (hybridResult.action === 'LONG'
        ? currentPrice - defaultStopDistance
        : currentPrice + defaultStopDistance);

    const takeProfit =
      hybridResult.suggestedTakeProfit ??
      (hybridResult.action === 'LONG'
        ? currentPrice + defaultTpDistance
        : currentPrice - defaultTpDistance);

    const signalData = {
      symbol,
      action: hybridResult.action,
      confidence: hybridResult.confidence,
      reasoning: hybridResult.reasoning,
      entryPrice: hybridResult.suggestedEntryPrice ?? currentPrice,
      stopLoss,
      takeProfit,
      atr: features.atr14,
      rsi: features.rsi14,
      ema9: features.ema9,
      ema21: features.ema21,
      timestamp: Date.now(),
    };

    // Final validation
    const finalParsed = signalSchema.safeParse(signalData);
    if (!finalParsed.success) {
      this.logger.warn(
        `Signal validation failed: ${JSON.stringify(finalParsed.error.issues)}`,
      );
      this.cyclesSinceLastAction++;
      return { signal: null, gateResult, cacheHit: false, analysis: buildAnalysis(hybridResult.action, hybridResult.confidence, hybridResult.reasoning) };
    }

    // Action taken! Reset counter
    this.cyclesSinceLastAction = 0;
    return { signal: finalParsed.data, gateResult, cacheHit: false, analysis: buildAnalysis(hybridResult.action, hybridResult.confidence, hybridResult.reasoning) };
  }

  /**
   * Compute delta changes between current cycle and previous cycle
   */
  private computeDelta(
    features: IndicatorFeatures,
    smc: SmcFeatures,
  ): DeltaChanges | null {
    if (!this.previousCycle) return null;

    const lastBreak = smc.lastStructureBreak
      ? `${smc.lastStructureBreak.type} ${smc.lastStructureBreak.direction}`
      : null;

    return {
      rsiDelta: features.rsi14 - this.previousCycle.rsi,
      atrPercentDelta: features.atrPercent - this.previousCycle.atrPercent,
      zoneChanged: smc.premiumDiscount !== this.previousCycle.zone,
      previousZone: this.previousCycle.zone,
      structureChanged: smc.marketStructure !== this.previousCycle.structure,
      previousStructure: this.previousCycle.structure,
      newStructureBreak: lastBreak !== this.previousCycle.lastBreakType,
      obCountDelta: smc.activeOrderBlocks.length - this.previousCycle.obCount,
      fvgCountDelta: smc.activeFairValueGaps.length - this.previousCycle.fvgCount,
      priceChangePct:
        this.previousCycle.price > 0
          ? ((features.currentPrice - this.previousCycle.price) / this.previousCycle.price) * 100
          : 0,
      cyclesSinceLastAction: this.cyclesSinceLastAction,
    };
  }

  /**
   * Store current cycle data for next delta computation
   */
  private saveCycleData(features: IndicatorFeatures, smc: SmcFeatures): void {
    this.previousCycle = {
      price: features.currentPrice,
      rsi: features.rsi14,
      atrPercent: features.atrPercent,
      zone: smc.premiumDiscount,
      structure: smc.marketStructure,
      lastBreakType: smc.lastStructureBreak
        ? `${smc.lastStructureBreak.type} ${smc.lastStructureBreak.direction}`
        : null,
      obCount: smc.activeOrderBlocks.length,
      fvgCount: smc.activeFairValueGaps.length,
      timestamp: Date.now(),
    };
  }

  /**
   * Fetch 1H candles and compute indicators + SMC for higher timeframe context
   */
  private async computeHtfContext(symbol: string): Promise<HtfContext | null> {
    const candles = await this.exchange.getKlines(symbol, '1h', 100);

    if (candles.length < 30) return null;

    const features = this.indicators.computeFeatures(candles);
    const smcFeatures = this.smc.analyze(candles);

    return {
      ema9: features.ema9,
      ema21: features.ema21,
      emaCrossover: features.emaCrossover,
      emaSlope: features.emaSlope,
      rsi14: features.rsi14,
      atr14: features.atr14,
      atrPercent: features.atrPercent,
      marketStructure: smcFeatures.marketStructure,
      premiumDiscount: smcFeatures.premiumDiscount,
      lastStructureBreak: smcFeatures.lastStructureBreak
        ? `${smcFeatures.lastStructureBreak.type} ${smcFeatures.lastStructureBreak.direction}`
        : null,
    };
  }

  /**
   * Fetch 4H candles and return only marketStructure. Used as tiebreaker
   * when 1H EMA cross contradicts 1H structure (HTF_4H_TIEBREAKER_ENABLED).
   * Returns null if not enough candles or fetch fails — caller handles gracefully.
   */
  private async computeHtf4hStructure(symbol: string): Promise<string | null> {
    try {
      const candles = await this.exchange.getKlines(symbol, '4h', 100);
      if (candles.length < 30) return null;
      const smcFeatures = this.smc.analyze(candles);
      return smcFeatures.marketStructure;
    } catch {
      return null;
    }
  }

  /**
   * Telemetría diaria persistida en DB + log en memoria.
   * Cada cycle persiste en tabla daily_telemetry con heartbeat actualizado.
   * Al cambiar día UTC, log resumen del día previo (rolling counters in-memory).
   */
  private recordCycleMetrics(action: string, reasoning: string): void {
    const today = new Date().toISOString().slice(0, 10);

    if (this.dailyMetrics.date !== today) {
      if (this.dailyMetrics.date) {
        const blockedSummary = [...this.dailyMetrics.blocked.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([k, v]) => `${k}=${v}`)
          .join(', ');
        this.logger.log(
          `📊 Daily summary ${this.dailyMetrics.date}: cycles=${this.dailyMetrics.cycles} ` +
            `setups=${this.dailyMetrics.setupsCreated} entries=${this.dailyMetrics.entriesAttempted} ` +
            `| blocked: ${blockedSummary || 'none'}`,
        );
      }
      this.dailyMetrics = {
        date: today,
        cycles: 0,
        setupsCreated: 0,
        entriesAttempted: 0,
        blocked: new Map(),
      };
    }

    this.dailyMetrics.cycles++;

    if (action === 'LONG' || action === 'SHORT') {
      this.dailyMetrics.entriesAttempted++;
      this.telemetry
        .recordCycle({ kind: 'entry', action: action as 'LONG' | 'SHORT' })
        .catch(() => {});
      return;
    }

    let category: string;
    let isSetup = false;
    if (reasoning.includes('Setup') && reasoning.includes('detectado')) {
      this.dailyMetrics.setupsCreated++;
      isSetup = true;
      category = 'setup_created';
    } else if (reasoning.includes('Volatilidad muy baja')) category = 'low_volatility';
    else if (reasoning.includes('Sin bias HTF')) category = 'htf_unclear';
    else if (reasoning.includes('contradice HTF')) category = 'structure_contradicts';
    else if (reasoning.includes('sin zonas')) category = 'no_zones';
    else if (reasoning.includes('Filtro P/D')) category = 'filter_pd';
    else if (reasoning.includes('slope') && reasoning.includes('contra')) category = 'slope_against';
    else if (reasoning.includes('Esperando pullback')) category = 'waiting_pullback';
    else if (reasoning.includes('expirado')) category = 'setup_expired';
    else if (reasoning.includes('Setup cancelado')) category = 'setup_invalidated';
    else if (reasoning.includes('sin setup')) category = 'idle';
    else category = 'other';

    if (!isSetup) {
      this.dailyMetrics.blocked.set(category, (this.dailyMetrics.blocked.get(category) ?? 0) + 1);
    }

    // Persist to DB. Fire-and-forget — failures logged, don't block cycle.
    if (isSetup) {
      this.telemetry.recordCycle({ kind: 'setup_created' }).catch(() => {});
    } else {
      this.telemetry.recordCycle({ kind: 'blocked', category }).catch(() => {});
    }
  }
}
