import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IndicatorFeatures } from './indicators.service';
import type { SmcFeatures } from './smc.service';

export interface GateBreakdown {
  volatility: number;
  smcConfluence: number;
  trendAlignment: number;
  rsiMomentum: number;
}

export interface GateResult {
  passed: boolean;
  score: number;
  reason: string;
  breakdown: GateBreakdown;
  timestamp: number;
}

export interface GateStats {
  totalCycles: number;
  passed: number;
  skipped: number;
  apiCalls: number;
  cacheHits: number;
  passRate: number;
  lastResult: GateResult | null;
}

@Injectable()
export class PreFilterGateService {
  private readonly logger = new Logger(PreFilterGateService.name);
  private readonly minScore: number;
  private readonly minAtrPercent: number;

  private stats: GateStats = {
    totalCycles: 0,
    passed: 0,
    skipped: 0,
    apiCalls: 0,
    cacheHits: 0,
    passRate: 0,
    lastResult: null,
  };
  private statsDate: string = '';

  constructor(private readonly config: ConfigService) {
    this.minScore = this.config.get<number>('GATE_MIN_SCORE', 30);
    this.minAtrPercent = this.config.get<number>('GATE_MIN_ATR_PERCENT', 0.0015);
  }

  evaluate(
    features: IndicatorFeatures,
    smc: SmcFeatures,
  ): GateResult {
    this.resetStatsIfNewDay();

    const reasons: string[] = [];

    // 1. Volatility (0-20) — atrPercent is a ratio, e.g. 0.003 = 0.3%
    let volatility = 0;
    if (features.atrPercent < this.minAtrPercent) {
      reasons.push('Low volatility');
    } else if (features.atrPercent < 0.0025) {
      volatility = 10;
    } else if (features.atrPercent < 0.005) {
      volatility = 15;
    } else {
      volatility = 20;
    }

    // 2. SMC Confluence (0-40)
    let smcConfluence = 0;
    if (smc.priceInOrderBlock) {
      smcConfluence += 15;
      reasons.push('Price in OB');
    }
    if (smc.priceInFVG) {
      smcConfluence += 10;
      reasons.push('Price in FVG');
    }
    if (smc.lastStructureBreak) {
      smcConfluence += 10;
      reasons.push(`${smc.lastStructureBreak.type} ${smc.lastStructureBreak.direction}`);
    }
    if (smc.premiumDiscount !== 'EQUILIBRIUM') {
      smcConfluence += 5;
    }
    if (smc.activeOrderBlocks.length >= 2) {
      smcConfluence += 5;
    }
    if (smc.activeFairValueGaps.length >= 2) {
      smcConfluence += 5;
    }
    smcConfluence = Math.min(smcConfluence, 40);

    // 3. Trend Alignment (0-20)
    let trendAlignment = 0;
    const structureMatchesEma =
      (smc.marketStructure === 'BULLISH' && features.emaCrossover === 'BULLISH') ||
      (smc.marketStructure === 'BEARISH' && features.emaCrossover === 'BEARISH');

    if (features.emaSlope === 'FLAT' && smc.marketStructure === 'RANGING') {
      reasons.push('Flat + Ranging');
    } else {
      if (structureMatchesEma) trendAlignment += 15;
      if (features.emaSlope !== 'FLAT') trendAlignment += 5;
    }

    // 4. RSI Momentum (0-20)
    let rsiMomentum = 0;
    const rsi = features.rsi14;
    if (rsi < 30 || rsi > 70) {
      rsiMomentum = 20;
    } else if (rsi < 40 || rsi > 60) {
      rsiMomentum = 10;
    } else {
      // RSI 40-60: neutral RSI is valid for entries — give partial score
      // Higher score if in OB/FVG or if volatility is good
      if (smc.priceInOrderBlock || smc.priceInFVG) {
        rsiMomentum = 10;
      } else if (volatility >= 15) {
        rsiMomentum = 5; // good volatility + neutral RSI = room to run
      }
    }

    const score = volatility + smcConfluence + trendAlignment + rsiMomentum;
    // Hard requirement: minimum volatility needed to avoid wasting API calls
    const passed = volatility > 0 && score >= this.minScore;
    const reason = passed
      ? reasons.length > 0
        ? reasons.join(' + ')
        : 'Sufficient score'
      : reasons.length > 0
        ? reasons.join(' + ')
        : 'No confluences';

    const result: GateResult = {
      passed,
      score,
      reason,
      breakdown: { volatility, smcConfluence, trendAlignment, rsiMomentum },
      timestamp: Date.now(),
    };

    // Update stats
    this.stats.totalCycles++;
    if (passed) {
      this.stats.passed++;
    } else {
      this.stats.skipped++;
    }
    this.stats.passRate =
      this.stats.totalCycles > 0
        ? this.stats.passed / this.stats.totalCycles
        : 0;
    this.stats.lastResult = result;

    return result;
  }

  recordApiCall(): void {
    this.stats.apiCalls++;
  }

  recordCacheHit(): void {
    this.stats.cacheHits++;
  }

  getStats(): GateStats {
    this.resetStatsIfNewDay();
    return { ...this.stats };
  }

  private resetStatsIfNewDay(): void {
    const today = new Date().toISOString().split('T')[0];
    if (this.statsDate !== today) {
      this.statsDate = today;
      this.stats = {
        totalCycles: 0,
        passed: 0,
        skipped: 0,
        apiCalls: 0,
        cacheHits: 0,
        passRate: 0,
        lastResult: null,
      };
    }
  }
}
