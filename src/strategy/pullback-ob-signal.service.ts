import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IndicatorFeatures } from './indicators.service';
import type { SmcFeatures } from './smc.service';

export interface HtfBiasContext {
  emaCrossover: string;
  marketStructure: string;
}

interface PullbackSetup {
  state: 'IDLE' | 'WAITING_PULLBACK';
  bias: 'LONG' | 'SHORT';
  targetZones: Array<{ type: 'OB' | 'FVG'; high: number; low: number; confluence?: boolean }>;
  waitCycles: number;
}

export interface PullbackSignalResult {
  action: 'LONG' | 'SHORT' | 'HOLD';
  confidence: number;
  reasoning: string;
  suggestedEntryPrice: number | null;
  suggestedStopLoss: number | null;
  suggestedTakeProfit: number | null;
}

@Injectable()
export class PullbackObSignalService {
  private readonly logger = new Logger(PullbackObSignalService.name);
  private readonly setups = new Map<string, PullbackSetup>();

  private readonly MAX_WAIT_CYCLES = 12;
  private readonly SL_BUFFER_ATR = 0.3;
  private readonly RR_RATIO = 1.5;
  private readonly MAX_DISTANCE_PCT = 1.5;
  private readonly MIN_DISTANCE_PCT = 0.05;

  // Confluence filters (configurable via .env)
  private readonly filterPD: boolean;
  private readonly filterRsi: boolean;
  private readonly filterCandle: boolean;
  private readonly filterConfluence: boolean;
  private readonly filterVolume: boolean;
  private readonly rsiLongMax: number;
  private readonly rsiShortMin: number;
  private readonly volumeMultiplier: number;

  constructor(private readonly config: ConfigService) {
    this.filterPD = this.config.get<string>('PULLBACK_FILTER_PD', 'false') === 'true';
    this.filterRsi = this.config.get<string>('PULLBACK_FILTER_RSI', 'false') === 'true';
    this.filterCandle = this.config.get<string>('PULLBACK_FILTER_CANDLE', 'false') === 'true';
    this.filterConfluence = this.config.get<string>('PULLBACK_FILTER_CONFLUENCE', 'false') === 'true';
    this.filterVolume = this.config.get<string>('PULLBACK_FILTER_VOLUME', 'false') === 'true';
    this.rsiLongMax = this.config.get<number>('PULLBACK_RSI_LONG_MAX', 40);
    this.rsiShortMin = this.config.get<number>('PULLBACK_RSI_SHORT_MIN', 60);
    this.volumeMultiplier = this.config.get<number>('PULLBACK_VOL_MULT', 1.2);
  }

  generateSignal(
    features: IndicatorFeatures,
    smc: SmcFeatures,
    symbol: string,
    htfContext: HtfBiasContext | null,
  ): PullbackSignalResult {
    const hold: PullbackSignalResult = {
      action: 'HOLD',
      confidence: 0.30,
      reasoning: 'Pullback-OB: sin setup.',
      suggestedEntryPrice: null,
      suggestedStopLoss: null,
      suggestedTakeProfit: null,
    };

    const setup = this.getOrCreateSetup(symbol);
    const lastCandle =
      features.recentCandles[features.recentCandles.length - 1];
    if (!lastCandle) return hold;

    // ─── STATE: IDLE — look for new setup ───
    if (setup.state === 'IDLE') {
      if (!htfContext) return hold;

      // Skip ranging/low-volatility markets
      const atrPct = (features.atr14 / features.currentPrice) * 100;
      if (atrPct < 0.25) {
        return { ...hold, reasoning: `Volatilidad muy baja (ATR%=${atrPct.toFixed(2)}%). Esperando movimiento.` };
      }

      const htfBias = this.determineHtfBias(htfContext);
      if (!htfBias) {
        return { ...hold, reasoning: 'Sin bias HTF claro (EMA y estructura no coinciden).' };
      }

      // Filter 1: Premium/Discount bias alignment
      if (this.filterPD) {
        if (htfBias === 'LONG' && smc.premiumDiscount === 'PREMIUM') {
          return { ...hold, reasoning: `Filtro P/D: no LONG en zona PREMIUM.` };
        }
        if (htfBias === 'SHORT' && smc.premiumDiscount === 'DISCOUNT') {
          return { ...hold, reasoning: `Filtro P/D: no SHORT en zona DISCOUNT.` };
        }
      }

      // 15m structure must not contradict HTF
      const contradicts =
        (htfBias === 'LONG' && smc.marketStructure === 'BEARISH') ||
        (htfBias === 'SHORT' && smc.marketStructure === 'BULLISH');
      if (contradicts) {
        return { ...hold, reasoning: `15m ${smc.marketStructure} contradice HTF ${htfBias}.` };
      }

      // Find valid OB/FVG zones
      const zones = this.findValidZones(smc, features.currentPrice, htfBias);
      if (zones.length === 0) {
        return { ...hold, reasoning: `Bias ${htfBias} pero sin zonas OB/FVG válidas.` };
      }

      // Filter 4: Mark confluence zones (OB+FVG overlap)
      if (this.filterConfluence) {
        this.markConfluenceZones(zones);
      }

      // Setup detected
      setup.state = 'WAITING_PULLBACK';
      setup.bias = htfBias;
      setup.targetZones = zones;
      setup.waitCycles = 0;

      this.logger.log(
        `Setup ${htfBias}: ${zones.length} zonas | ${zones.map((z) => `${z.type}[${z.low.toFixed(0)}-${z.high.toFixed(0)}]`).join(', ')}`,
      );

      return {
        ...hold,
        reasoning: `Setup ${htfBias} detectado. Esperando pullback a ${zones.length} zonas.`,
      };
    }

    // ─── STATE: WAITING_PULLBACK ───
    if (setup.state === 'WAITING_PULLBACK') {
      setup.waitCycles++;

      // Invalidation 1: Timeout
      if (setup.waitCycles > this.MAX_WAIT_CYCLES) {
        this.resetSetup(symbol);
        return { ...hold, reasoning: `Setup ${setup.bias} expirado (${this.MAX_WAIT_CYCLES} ciclos).` };
      }

      // Invalidation 2: CHoCH against bias on 15m
      if (
        smc.lastStructureBreak &&
        smc.lastStructureBreak.type === 'CHoCH' &&
        ((setup.bias === 'LONG' &&
          smc.lastStructureBreak.direction === 'BEARISH') ||
          (setup.bias === 'SHORT' &&
            smc.lastStructureBreak.direction === 'BULLISH'))
      ) {
        this.resetSetup(symbol);
        return { ...hold, reasoning: `Setup cancelado: CHoCH ${smc.lastStructureBreak.direction} en contra.` };
      }

      // Invalidation 3: HTF bias flipped
      if (htfContext) {
        const currentBias = this.determineHtfBias(htfContext);
        if (currentBias !== setup.bias && currentBias !== null) {
          this.resetSetup(symbol);
          return { ...hold, reasoning: `Setup cancelado: HTF cambió a ${currentBias}.` };
        }
      }

      // Invalidation 4: Remove blown-through zones
      setup.targetZones = setup.targetZones.filter((zone) => {
        if (setup.bias === 'LONG') return lastCandle.c >= zone.low;
        return lastCandle.c <= zone.high;
      });
      if (setup.targetZones.length === 0) {
        this.resetSetup(symbol);
        return { ...hold, reasoning: 'Setup cancelado: todas las zonas mitigadas.' };
      }

      // Entry filter: EMA slope must not be against
      const slopeOk =
        (setup.bias === 'LONG' && features.emaSlope !== 'FALLING') ||
        (setup.bias === 'SHORT' && features.emaSlope !== 'RISING');

      if (!slopeOk) {
        return {
          ...hold,
          reasoning: `Esperando pullback (${setup.waitCycles}/${this.MAX_WAIT_CYCLES}) pero slope ${features.emaSlope} en contra.`,
        };
      }

      // Check entry trigger: did the last candle touch any target zone?
      for (const zone of setup.targetZones) {
        if (setup.bias === 'LONG') {
          if (lastCandle.o < zone.low) continue; // gap through zone
          if (lastCandle.l > zone.high) continue; // didn't reach zone

          const entryPrice = zone.high; // Enter at zone boundary, not current price
          const slRaw = zone.low - features.atr14 * this.SL_BUFFER_ATR;
          const minSlDist = entryPrice * 0.003;
          const slDist = Math.max(entryPrice - slRaw, minSlDist);
          const sl = entryPrice - slDist;
          const tp = entryPrice + slDist * this.RR_RATIO;

          if (lastCandle.l <= sl) continue; // SL hit in same candle

          // Confluence entry filters
          if (this.filterRsi && features.rsi14 > this.rsiLongMax) continue;
          if (this.filterCandle && !this.hasCandleConfirmation(features.recentCandles, 'LONG')) continue;
          if (this.filterVolume && features.volumeAvg20 > 0 && features.lastVolume < features.volumeAvg20 * this.volumeMultiplier) continue;
          if (this.filterConfluence && zone.confluence !== true) continue;

          this.resetSetup(symbol);
          this.logger.log(
            `ENTRY LONG at ${zone.type}${zone.confluence ? '+CONFLUENCE' : ''} [${zone.low.toFixed(0)}-${zone.high.toFixed(0)}] after ${setup.waitCycles} cycles`,
          );

          return {
            action: 'LONG',
            confidence: zone.confluence ? 0.80 : 0.70,
            reasoning:
              `Pullback LONG a ${zone.type} [${zone.low.toFixed(0)}-${zone.high.toFixed(0)}]. ` +
              `Slope: ${features.emaSlope}. ATR%: ${(features.atrPercent * 100).toFixed(2)}%. ` +
              `Waited ${setup.waitCycles} cycles.`,
            suggestedEntryPrice: entryPrice,
            suggestedStopLoss: sl,
            suggestedTakeProfit: tp,
          };
        } else {
          if (lastCandle.o > zone.high) continue;
          if (lastCandle.h < zone.low) continue;

          const entryPrice = zone.low; // Enter at zone boundary, not current price
          const slRaw = zone.high + features.atr14 * this.SL_BUFFER_ATR;
          const minSlDist = entryPrice * 0.003;
          const slDist = Math.max(slRaw - entryPrice, minSlDist);
          const sl = entryPrice + slDist;
          const tp = entryPrice - slDist * this.RR_RATIO;

          if (lastCandle.h >= sl) continue;

          // Confluence entry filters
          if (this.filterRsi && features.rsi14 < this.rsiShortMin) continue;
          if (this.filterCandle && !this.hasCandleConfirmation(features.recentCandles, 'SHORT')) continue;
          if (this.filterVolume && features.volumeAvg20 > 0 && features.lastVolume < features.volumeAvg20 * this.volumeMultiplier) continue;
          if (this.filterConfluence && zone.confluence !== true) continue;

          this.resetSetup(symbol);
          this.logger.log(
            `ENTRY SHORT at ${zone.type}${zone.confluence ? '+CONFLUENCE' : ''} [${zone.low.toFixed(0)}-${zone.high.toFixed(0)}] after ${setup.waitCycles} cycles`,
          );

          return {
            action: 'SHORT',
            confidence: zone.confluence ? 0.80 : 0.70,
            reasoning:
              `Pullback SHORT a ${zone.type} [${zone.low.toFixed(0)}-${zone.high.toFixed(0)}]. ` +
              `Slope: ${features.emaSlope}. ATR%: ${(features.atrPercent * 100).toFixed(2)}%. ` +
              `Waited ${setup.waitCycles} cycles.`,
            suggestedEntryPrice: entryPrice,
            suggestedStopLoss: sl,
            suggestedTakeProfit: tp,
          };
        }
      }

      return {
        ...hold,
        reasoning: `Esperando pullback a ${setup.targetZones.length} zonas (${setup.waitCycles}/${this.MAX_WAIT_CYCLES}).`,
      };
    }

    return hold;
  }

  private determineHtfBias(
    htf: HtfBiasContext,
  ): 'LONG' | 'SHORT' | null {
    if (
      htf.marketStructure === 'BULLISH' &&
      htf.emaCrossover === 'BULLISH'
    )
      return 'LONG';
    if (
      htf.marketStructure === 'BEARISH' &&
      htf.emaCrossover === 'BEARISH'
    )
      return 'SHORT';
    return null;
  }

  private findValidZones(
    smc: SmcFeatures,
    currentPrice: number,
    bias: 'LONG' | 'SHORT',
  ): Array<{ type: 'OB' | 'FVG'; high: number; low: number }> {
    const zones: Array<{ type: 'OB' | 'FVG'; high: number; low: number }> = [];

    // Order Blocks
    for (const ob of smc.activeOrderBlocks) {
      if (ob.mitigated) continue;
      if (bias === 'LONG' && ob.type === 'BULLISH') {
        const dist = ((currentPrice - ob.high) / currentPrice) * 100;
        if (dist > this.MIN_DISTANCE_PCT && dist < this.MAX_DISTANCE_PCT) {
          zones.push({ type: 'OB', high: ob.high, low: ob.low });
        }
      } else if (bias === 'SHORT' && ob.type === 'BEARISH') {
        const dist = ((ob.low - currentPrice) / currentPrice) * 100;
        if (dist > this.MIN_DISTANCE_PCT && dist < this.MAX_DISTANCE_PCT) {
          zones.push({ type: 'OB', high: ob.high, low: ob.low });
        }
      }
    }

    // Fair Value Gaps
    for (const fvg of smc.activeFairValueGaps) {
      if (fvg.filled) continue;
      if (bias === 'LONG' && fvg.type === 'BULLISH') {
        const dist = ((currentPrice - fvg.high) / currentPrice) * 100;
        if (dist > this.MIN_DISTANCE_PCT && dist < this.MAX_DISTANCE_PCT) {
          zones.push({ type: 'FVG', high: fvg.high, low: fvg.low });
        }
      } else if (bias === 'SHORT' && fvg.type === 'BEARISH') {
        const dist = ((fvg.low - currentPrice) / currentPrice) * 100;
        if (dist > this.MIN_DISTANCE_PCT && dist < this.MAX_DISTANCE_PCT) {
          zones.push({ type: 'FVG', high: fvg.high, low: fvg.low });
        }
      }
    }

    // Sort by distance — closest first
    zones.sort((a, b) => {
      const distA =
        bias === 'LONG' ? currentPrice - a.high : a.low - currentPrice;
      const distB =
        bias === 'LONG' ? currentPrice - b.high : b.low - currentPrice;
      return distA - distB;
    });

    return zones;
  }

  private getOrCreateSetup(symbol: string): PullbackSetup {
    if (!this.setups.has(symbol)) {
      this.setups.set(symbol, {
        state: 'IDLE',
        bias: 'LONG',
        targetZones: [],
        waitCycles: 0,
      });
    }
    return this.setups.get(symbol)!;
  }

  private resetSetup(symbol: string): void {
    this.setups.set(symbol, {
      state: 'IDLE',
      bias: 'LONG',
      targetZones: [],
      waitCycles: 0,
    });
  }

  private hasCandleConfirmation(
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

  private markConfluenceZones(
    zones: Array<{ type: 'OB' | 'FVG'; high: number; low: number; confluence?: boolean }>,
  ): void {
    for (let i = 0; i < zones.length; i++) {
      for (let j = i + 1; j < zones.length; j++) {
        if (zones[i].type === zones[j].type) continue;
        const overlap = Math.min(zones[i].high, zones[j].high) - Math.max(zones[i].low, zones[j].low);
        if (overlap > 0) {
          zones[i].confluence = true;
          zones[j].confluence = true;
        }
      }
    }
  }
}
