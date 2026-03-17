import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import type { IndicatorFeatures } from './indicators.service';
import type { SmcFeatures } from './smc.service';

export interface DeltaChanges {
  rsiDelta: number;
  atrPercentDelta: number;
  zoneChanged: boolean;
  previousZone: string | null;
  structureChanged: boolean;
  previousStructure: string | null;
  newStructureBreak: boolean;
  obCountDelta: number;
  fvgCountDelta: number;
  priceChangePct: number;
  cyclesSinceLastAction: number;
}

export interface HtfContext {
  ema9: number;
  ema21: number;
  emaCrossover: string;
  emaSlope: string;
  rsi14: number;
  atr14: number;
  atrPercent: number;
  marketStructure: string;
  premiumDiscount: string;
  lastStructureBreak: string | null;
}

const SYSTEM_PROMPT = `You are a quantitative trading analyst for BTCUSDT Futures (15m timeframe) using Smart Money Concepts + technical indicators.

You receive: 15m indicators, SMC analysis, 1H context, and delta changes since last cycle.

## Core Strategy (focus on these 3 confluences):
1. **Market Structure** — Is there a clear BOS or CHoCH? Direction must be unambiguous.
2. **Order Block / FVG proximity** — Is price near (<=0.3%) a relevant OB or FVG? The closer, the better.
3. **1H Directional Bias** — Does the higher timeframe agree? (see HTF Alignment rules below)

## Entry Rules:
- **LONG**: BULLISH structure (BOS/CHoCH) + price near BULLISH OB or FVG (distance <= 0.3%)
- **SHORT**: BEARISH structure (BOS/CHoCH) + price near BEARISH OB or FVG (distance <= 0.3%)
- **CRITICAL — Anti-whipsaw**: Do NOT enter against a strong move. If priceChange1h is positive, prefer LONG. If negative, prefer SHORT. Do NOT flip direction unless structure clearly reversed with a CHoCH + pullback to OB/FVG.
- After a CHoCH, WAIT for a pullback to an OB or FVG before entering — do NOT chase the break.

## Indicator Filters:
- RSI > 75: avoid LONG | RSI < 25: avoid SHORT
- RSI 40-60 is neutral — NOT a reason to avoid entry
- EMA crossover confirms trend; emaSlope confirms momentum
- SL distance: MINIMUM 2x ATR. Never place SL closer than 0.5% from entry price.
- Tight SLs get hunted by normal market wicks — ALWAYS leave breathing room for 15m candle noise.
- TP at least 1.5x SL distance (R:R >= 1.5)

## Distance thresholds:
- distanceToNearestOB/FVG: <= 0.1% = AT zone (strong), <= 0.3% = NEAR (moderate), > 0.5% = FAR (ignore)

## Momentum (priceChange1h = cumulative 1h change):
- > 0.5%: meaningful momentum, bias in that direction
- > 1.5%: strong momentum, look for continuation after pullback
- < 0.3%: low momentum, require stronger SMC confluence for entry

## HTF Alignment (CRITICAL — prevents counter-trend losses):
- If 1H trend is clearly directional (EMA9 > EMA21 + slope UP = BULLISH, or EMA9 < EMA21 + slope DOWN = BEARISH):
  - Trading WITH the 1H trend: normal confidence, no penalty
  - Trading AGAINST the 1H trend: REDUCE confidence by 0.20-0.30 (this is a MAJOR penalty)
  - A counter-trend trade needs exceptional 15m confluence (CHoCH + price AT OB/FVG zone + RSI extreme) to overcome this penalty and reach 0.55
  - Example: If 1H is BULLISH, a 15m SHORT with 2 confluences = max 0.50 confidence (0.70 base - 0.20 HTF penalty) = HOLD
- If 1H is RANGING or NEUTRAL: 15m signals are sufficient on their own, no penalty

## Confidence calibration:
- 0.0-0.3: No setup, conflicting signals
- 0.3-0.45: Weak, missing confluences
- 0.45-0.55: Borderline — 1 confluence only
- 0.55-0.70: Good — 2+ confluences aligned — ACTIONABLE
- 0.70-0.85: Strong — full alignment with HTF
- 0.85-1.0: Perfect storm, rare
DO NOT default to 0.4. Calibrate based on actual confluence count.

## Response format (strict JSON):
{ "action": "LONG" | "SHORT" | "HOLD", "confidence": 0.0-1.0, "reasoning": "brief (<150 words)", "suggestedStopLoss": price|null, "suggestedTakeProfit": price|null }

Rules:
- Only suggest LONG/SHORT if confidence >= 0.55
- For HOLD, set SL/TP to null
- IMPORTANT: Prefer HOLD over a low-quality entry. Bad trades cost more than missed trades.
- Write "reasoning" field in Spanish (es-ES).`;

@Injectable()
export class DeepSeekService {
  private readonly logger = new Logger(DeepSeekService.name);
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly config: ConfigService,
  ) {
    this.baseUrl = this.config.getOrThrow<string>('DEEPSEEK_BASE_URL');
    this.apiKey = this.config.getOrThrow<string>('DEEPSEEK_API_KEY');
  }

  async getSignal(
    indicators: IndicatorFeatures,
    smcFeatures: SmcFeatures,
    symbol: string,
    htfContext?: HtfContext | null,
    deltaChanges?: DeltaChanges | null,
  ): Promise<Record<string, unknown>> {
    const payload: Record<string, unknown> = {
      symbol,
      timestamp: new Date().toISOString(),
      technicalIndicators_5m: {
        currentPrice: indicators.currentPrice,
        ema9: indicators.ema9,
        ema21: indicators.ema21,
        emaCrossover: indicators.emaCrossover,
        emaSlope: indicators.emaSlope,
        rsi14: indicators.rsi14,
        atr14: indicators.atr14,
        atrPercent: (indicators.atrPercent * 100).toFixed(3) + '%',
        priceChange1h: `${indicators.priceChange1h > 0 ? '+' : ''}${indicators.priceChange1h.toFixed(3)}%`,
        recentCandles: indicators.recentCandles,
      },
      smartMoneyConcepts_5m: {
        marketStructure: smcFeatures.marketStructure,
        lastStructureBreak: smcFeatures.lastStructureBreak,
        premiumDiscount: smcFeatures.premiumDiscount,
        activeOrderBlocks: smcFeatures.activeOrderBlocks.map((ob) => ({
          type: ob.type,
          zone: `${ob.low} - ${ob.high}`,
          mitigated: ob.mitigated,
        })),
        activeFairValueGaps: smcFeatures.activeFairValueGaps.map((fvg) => ({
          type: fvg.type,
          zone: `${fvg.low} - ${fvg.high}`,
          midpoint: fvg.midpoint,
          filled: fvg.filled,
        })),
        liquidityZones: smcFeatures.liquidityZones.map((lz) => ({
          type: lz.type,
          level: lz.level,
          strength: lz.strength,
          swept: lz.swept,
        })),
        priceInOrderBlock: smcFeatures.priceInOrderBlock,
        priceInFVG: smcFeatures.priceInFVG,
        distanceToNearestOB: smcFeatures.distanceToNearestOB,
        distanceToNearestFVG: smcFeatures.distanceToNearestFVG,
      },
    };

    if (htfContext) {
      payload.higherTimeframe_1h = htfContext;
    }

    if (deltaChanges) {
      payload.deltaChanges = {
        rsiDelta: `${deltaChanges.rsiDelta > 0 ? '+' : ''}${deltaChanges.rsiDelta.toFixed(1)}`,
        atrPercentDelta: `${deltaChanges.atrPercentDelta > 0 ? '+' : ''}${(deltaChanges.atrPercentDelta * 100).toFixed(3)}%`,
        priceChangePct: `${deltaChanges.priceChangePct > 0 ? '+' : ''}${deltaChanges.priceChangePct.toFixed(3)}%`,
        zoneChanged: deltaChanges.zoneChanged
          ? `YES: ${deltaChanges.previousZone} → ${smcFeatures.premiumDiscount}`
          : 'NO',
        structureChanged: deltaChanges.structureChanged
          ? `YES: ${deltaChanges.previousStructure} → ${smcFeatures.marketStructure}`
          : 'NO',
        newStructureBreak: deltaChanges.newStructureBreak,
        obCountDelta: deltaChanges.obCountDelta,
        fvgCountDelta: deltaChanges.fvgCountDelta,
        cyclesSinceLastAction: deltaChanges.cyclesSinceLastAction,
      };
    }

    const userMessage = JSON.stringify(payload, null, 2);

    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${this.baseUrl}/chat/completions`,
          {
            model: 'deepseek-chat',
            messages: [
              { role: 'system', content: SYSTEM_PROMPT },
              { role: 'user', content: userMessage },
            ],
            temperature: 0.4,
            response_format: { type: 'json_object' },
            max_tokens: 500,
          },
          {
            headers: {
              Authorization: `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: 30_000,
          },
        ),
      );

      const content = response.data.choices?.[0]?.message?.content;
      if (!content) {
        this.logger.warn('DeepSeek returned empty content');
        return { action: 'HOLD', confidence: 0, reasoning: 'Empty response' };
      }

      return JSON.parse(content) as Record<string, unknown>;
    } catch (error) {
      this.logger.error('DeepSeek API call failed', error);
      return {
        action: 'HOLD',
        confidence: 0,
        reasoning: 'API call failed',
      };
    }
  }
}
