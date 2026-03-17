import { Injectable } from '@nestjs/common';
import type { Candle } from '../common/interfaces/binance.interfaces';

// ─── Types ───

export interface SwingPoint {
  index: number;
  price: number;
  time: number;
  type: 'HIGH' | 'LOW';
}

export interface OrderBlock {
  type: 'BULLISH' | 'BEARISH';
  high: number;
  low: number;
  openTime: number;
  index: number;
  mitigated: boolean;
}

export interface FairValueGap {
  type: 'BULLISH' | 'BEARISH';
  high: number;
  low: number;
  midpoint: number;
  index: number;
  filled: boolean;
}

export interface StructureBreak {
  type: 'BOS' | 'CHoCH';
  direction: 'BULLISH' | 'BEARISH';
  level: number;
  index: number;
  time: number;
}

export interface LiquidityZone {
  type: 'BUYSIDE' | 'SELLSIDE';
  level: number;
  strength: number; // number of times tested
  swept: boolean;
}

export interface SmcFeatures {
  marketStructure: 'BULLISH' | 'BEARISH' | 'RANGING';
  lastStructureBreak: StructureBreak | null;
  swingHighs: SwingPoint[];
  swingLows: SwingPoint[];
  activeOrderBlocks: OrderBlock[];
  activeFairValueGaps: FairValueGap[];
  liquidityZones: LiquidityZone[];
  premiumDiscount: 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM';
  distanceToNearestOB: number | null; // percentage distance
  distanceToNearestFVG: number | null;
  priceInOrderBlock: boolean;
  priceInFVG: boolean;
}

@Injectable()
export class SmcService {
  private readonly SWING_LOOKBACK = 5;

  /**
   * Analyze candles for Smart Money Concepts
   */
  analyze(candles: Candle[]): SmcFeatures {
    if (candles.length < 20) {
      return this.emptyFeatures();
    }

    const swingHighs = this.findSwingHighs(candles);
    const swingLows = this.findSwingLows(candles);
    const structureBreaks = this.findStructureBreaks(
      candles,
      swingHighs,
      swingLows,
    );
    const marketStructure = this.determineMarketStructure(structureBreaks);
    const orderBlocks = this.findOrderBlocks(candles, swingHighs, swingLows);
    const fvgs = this.findFairValueGaps(candles);
    const liquidityZones = this.findLiquidityZones(swingHighs, swingLows, candles);
    const premiumDiscount = this.calculatePremiumDiscount(
      candles,
      swingHighs,
      swingLows,
    );

    const currentPrice = candles[candles.length - 1].close;
    const activeOBs = orderBlocks.filter((ob) => !ob.mitigated);
    const activeFVGs = fvgs.filter((fvg) => !fvg.filled);

    return {
      marketStructure,
      lastStructureBreak:
        structureBreaks.length > 0
          ? structureBreaks[structureBreaks.length - 1]
          : null,
      swingHighs: swingHighs.slice(-5),
      swingLows: swingLows.slice(-5),
      activeOrderBlocks: activeOBs.slice(-5),
      activeFairValueGaps: activeFVGs.slice(-5),
      liquidityZones: liquidityZones.slice(-5),
      premiumDiscount,
      distanceToNearestOB: this.distanceToNearest(currentPrice, activeOBs),
      distanceToNearestFVG: this.distanceToNearestFvg(currentPrice, activeFVGs),
      priceInOrderBlock: activeOBs.some(
        (ob) => currentPrice >= ob.low && currentPrice <= ob.high,
      ),
      priceInFVG: activeFVGs.some(
        (fvg) => currentPrice >= fvg.low && currentPrice <= fvg.high,
      ),
    };
  }

  /**
   * Find swing highs: a candle whose high is higher than
   * the highs of N candles before and after it
   */
  private findSwingHighs(candles: Candle[]): SwingPoint[] {
    const swings: SwingPoint[] = [];
    const lb = this.SWING_LOOKBACK;

    for (let i = lb; i < candles.length - lb; i++) {
      let isSwingHigh = true;
      for (let j = 1; j <= lb; j++) {
        if (
          candles[i].high <= candles[i - j].high ||
          candles[i].high <= candles[i + j].high
        ) {
          isSwingHigh = false;
          break;
        }
      }
      if (isSwingHigh) {
        swings.push({
          index: i,
          price: candles[i].high,
          time: candles[i].openTime,
          type: 'HIGH',
        });
      }
    }

    return swings;
  }

  /**
   * Find swing lows: a candle whose low is lower than
   * the lows of N candles before and after it
   */
  private findSwingLows(candles: Candle[]): SwingPoint[] {
    const swings: SwingPoint[] = [];
    const lb = this.SWING_LOOKBACK;

    for (let i = lb; i < candles.length - lb; i++) {
      let isSwingLow = true;
      for (let j = 1; j <= lb; j++) {
        if (
          candles[i].low >= candles[i - j].low ||
          candles[i].low >= candles[i + j].low
        ) {
          isSwingLow = false;
          break;
        }
      }
      if (isSwingLow) {
        swings.push({
          index: i,
          price: candles[i].low,
          time: candles[i].openTime,
          type: 'LOW',
        });
      }
    }

    return swings;
  }

  /**
   * Detect Break of Structure (BOS) and Change of Character (CHoCH)
   *
   * BOS: Price breaks a swing high in an uptrend (continuation)
   *      or breaks a swing low in a downtrend (continuation)
   *
   * CHoCH: Price breaks a swing high in a downtrend (reversal)
   *        or breaks a swing low in an uptrend (reversal)
   */
  private findStructureBreaks(
    candles: Candle[],
    swingHighs: SwingPoint[],
    swingLows: SwingPoint[],
  ): StructureBreak[] {
    const breaks: StructureBreak[] = [];
    let currentTrend: 'BULLISH' | 'BEARISH' | null = null;

    // Merge and sort swing points chronologically
    const allSwings = [...swingHighs, ...swingLows].sort(
      (a, b) => a.index - b.index,
    );

    let lastSwingHigh: SwingPoint | null = null;
    let lastSwingLow: SwingPoint | null = null;

    for (const swing of allSwings) {
      if (swing.type === 'HIGH') {
        if (lastSwingHigh && swing.price > lastSwingHigh.price) {
          // Higher high
          if (currentTrend === 'BEARISH') {
            // CHoCH: reversal from bearish to bullish
            breaks.push({
              type: 'CHoCH',
              direction: 'BULLISH',
              level: lastSwingHigh.price,
              index: swing.index,
              time: candles[swing.index].openTime,
            });
          } else {
            // BOS: continuation bullish
            breaks.push({
              type: 'BOS',
              direction: 'BULLISH',
              level: lastSwingHigh.price,
              index: swing.index,
              time: candles[swing.index].openTime,
            });
          }
          currentTrend = 'BULLISH';
        }
        lastSwingHigh = swing;
      } else {
        if (lastSwingLow && swing.price < lastSwingLow.price) {
          // Lower low
          if (currentTrend === 'BULLISH') {
            // CHoCH: reversal from bullish to bearish
            breaks.push({
              type: 'CHoCH',
              direction: 'BEARISH',
              level: lastSwingLow.price,
              index: swing.index,
              time: candles[swing.index].openTime,
            });
          } else {
            // BOS: continuation bearish
            breaks.push({
              type: 'BOS',
              direction: 'BEARISH',
              level: lastSwingLow.price,
              index: swing.index,
              time: candles[swing.index].openTime,
            });
          }
          currentTrend = 'BEARISH';
        }
        lastSwingLow = swing;
      }
    }

    return breaks;
  }

  /**
   * Determine overall market structure from recent structure breaks
   */
  private determineMarketStructure(
    breaks: StructureBreak[],
  ): 'BULLISH' | 'BEARISH' | 'RANGING' {
    if (breaks.length === 0) return 'RANGING';

    // Weighted voting: most recent break has double weight
    // This prevents constant RANGING when breaks alternate
    const recent = breaks.slice(-3);
    let bullishScore = 0;
    let bearishScore = 0;

    for (let i = 0; i < recent.length; i++) {
      const weight = i === recent.length - 1 ? 2 : 1; // last break = 2x weight
      if (recent[i].direction === 'BULLISH') bullishScore += weight;
      else bearishScore += weight;
    }

    if (bullishScore > bearishScore) return 'BULLISH';
    if (bearishScore > bullishScore) return 'BEARISH';
    return 'RANGING';
  }

  /**
   * Find Order Blocks
   *
   * Bullish OB: Last bearish candle before a strong bullish impulse
   *             that breaks a swing high
   *
   * Bearish OB: Last bullish candle before a strong bearish impulse
   *             that breaks a swing low
   */
  private findOrderBlocks(
    candles: Candle[],
    swingHighs: SwingPoint[],
    swingLows: SwingPoint[],
  ): OrderBlock[] {
    const orderBlocks: OrderBlock[] = [];
    const currentPrice = candles[candles.length - 1].close;

    // Bullish Order Blocks: find bearish candles before bullish impulses
    for (const sh of swingHighs) {
      // Look for a bearish candle before the swing high move
      for (let i = sh.index - 1; i >= Math.max(0, sh.index - 5); i--) {
        const c = candles[i];
        if (c.close < c.open) {
          // Bearish candle found — this is the bullish OB
          const ob: OrderBlock = {
            type: 'BULLISH',
            high: c.open, // body top
            low: c.close, // body bottom (or use c.low for wick)
            openTime: c.openTime,
            index: i,
            mitigated: currentPrice < c.close, // price went below OB
          };
          orderBlocks.push(ob);
          break;
        }
      }
    }

    // Bearish Order Blocks: find bullish candles before bearish impulses
    for (const sl of swingLows) {
      for (let i = sl.index - 1; i >= Math.max(0, sl.index - 5); i--) {
        const c = candles[i];
        if (c.close > c.open) {
          // Bullish candle found — this is the bearish OB
          const ob: OrderBlock = {
            type: 'BEARISH',
            high: c.close, // body top
            low: c.open, // body bottom
            openTime: c.openTime,
            index: i,
            mitigated: currentPrice > c.close, // price went above OB
          };
          orderBlocks.push(ob);
          break;
        }
      }
    }

    return orderBlocks.sort((a, b) => a.index - b.index);
  }

  /**
   * Find Fair Value Gaps (FVG / Imbalances)
   *
   * Bullish FVG: candle[i-1].high < candle[i+1].low
   *   → gap between candle[i-1].high and candle[i+1].low
   *   → middle candle is a strong bullish candle
   *
   * Bearish FVG: candle[i-1].low > candle[i+1].high
   *   → gap between candle[i+1].high and candle[i-1].low
   *   → middle candle is a strong bearish candle
   */
  private findFairValueGaps(candles: Candle[]): FairValueGap[] {
    const fvgs: FairValueGap[] = [];
    const currentPrice = candles[candles.length - 1].close;

    for (let i = 1; i < candles.length - 1; i++) {
      const prev = candles[i - 1];
      const curr = candles[i];
      const next = candles[i + 1];

      // Bullish FVG: gap up (price skipped a zone going up)
      if (prev.high < next.low && curr.close > curr.open) {
        const fvg: FairValueGap = {
          type: 'BULLISH',
          high: next.low,
          low: prev.high,
          midpoint: (next.low + prev.high) / 2,
          index: i,
          filled: currentPrice <= prev.high, // price came back and filled it
        };
        fvgs.push(fvg);
      }

      // Bearish FVG: gap down
      if (prev.low > next.high && curr.close < curr.open) {
        const fvg: FairValueGap = {
          type: 'BEARISH',
          high: prev.low,
          low: next.high,
          midpoint: (prev.low + next.high) / 2,
          index: i,
          filled: currentPrice >= prev.low,
        };
        fvgs.push(fvg);
      }
    }

    return fvgs;
  }

  /**
   * Identify liquidity zones: areas where stop losses likely cluster
   *
   * Buyside liquidity: above swing highs (longs' stop losses become
   *   buy orders if hit, attracting price)
   *
   * Sellside liquidity: below swing lows (shorts' stop losses)
   */
  private findLiquidityZones(
    swingHighs: SwingPoint[],
    swingLows: SwingPoint[],
    candles: Candle[],
  ): LiquidityZone[] {
    const zones: LiquidityZone[] = [];
    const currentPrice = candles[candles.length - 1].close;
    const tolerance = currentPrice * 0.001; // 0.1% for clustering

    // Group similar swing highs as buyside liquidity
    const highLevels = this.clusterLevels(
      swingHighs.map((s) => s.price),
      tolerance,
    );
    for (const level of highLevels) {
      const swept = candles.some((c) => c.high > level.price && c.close < level.price);
      zones.push({
        type: 'BUYSIDE',
        level: level.price,
        strength: level.count,
        swept,
      });
    }

    // Group similar swing lows as sellside liquidity
    const lowLevels = this.clusterLevels(
      swingLows.map((s) => s.price),
      tolerance,
    );
    for (const level of lowLevels) {
      const swept = candles.some((c) => c.low < level.price && c.close > level.price);
      zones.push({
        type: 'SELLSIDE',
        level: level.price,
        strength: level.count,
        swept,
      });
    }

    return zones;
  }

  /**
   * Calculate Premium/Discount zone
   *
   * Based on the most recent significant swing range:
   * - Premium: price is above 50% of the range (expensive, look to sell)
   * - Discount: price is below 50% of the range (cheap, look to buy)
   * - Equilibrium: price is near the 50% level
   */
  private calculatePremiumDiscount(
    candles: Candle[],
    swingHighs: SwingPoint[],
    swingLows: SwingPoint[],
  ): 'PREMIUM' | 'DISCOUNT' | 'EQUILIBRIUM' {
    if (swingHighs.length === 0 || swingLows.length === 0) {
      return 'EQUILIBRIUM';
    }

    // Use the most recent swing high and swing low
    const recentHigh = swingHighs[swingHighs.length - 1].price;
    const recentLow = swingLows[swingLows.length - 1].price;
    const range = recentHigh - recentLow;
    if (range <= 0) return 'EQUILIBRIUM';

    const currentPrice = candles[candles.length - 1].close;
    const equilibrium = recentLow + range * 0.5;
    const threshold = range * 0.1; // 10% tolerance for equilibrium zone

    if (currentPrice > equilibrium + threshold) return 'PREMIUM';
    if (currentPrice < equilibrium - threshold) return 'DISCOUNT';
    return 'EQUILIBRIUM';
  }

  // ─── Helpers ───

  private clusterLevels(
    prices: number[],
    tolerance: number,
  ): Array<{ price: number; count: number }> {
    const clusters: Array<{ price: number; count: number }> = [];

    for (const price of prices) {
      const existing = clusters.find(
        (c) => Math.abs(c.price - price) <= tolerance,
      );
      if (existing) {
        existing.price = (existing.price * existing.count + price) / (existing.count + 1);
        existing.count++;
      } else {
        clusters.push({ price, count: 1 });
      }
    }

    return clusters.sort((a, b) => b.count - a.count);
  }

  private distanceToNearest(
    price: number,
    obs: OrderBlock[],
  ): number | null {
    if (obs.length === 0) return null;

    let minDist = Infinity;
    for (const ob of obs) {
      const mid = (ob.high + ob.low) / 2;
      const dist = Math.abs((price - mid) / price) * 100;
      if (dist < minDist) minDist = dist;
    }

    return Math.round(minDist * 100) / 100;
  }

  private distanceToNearestFvg(
    price: number,
    fvgs: FairValueGap[],
  ): number | null {
    if (fvgs.length === 0) return null;

    let minDist = Infinity;
    for (const fvg of fvgs) {
      const dist = Math.abs((price - fvg.midpoint) / price) * 100;
      if (dist < minDist) minDist = dist;
    }

    return Math.round(minDist * 100) / 100;
  }

  private emptyFeatures(): SmcFeatures {
    return {
      marketStructure: 'RANGING',
      lastStructureBreak: null,
      swingHighs: [],
      swingLows: [],
      activeOrderBlocks: [],
      activeFairValueGaps: [],
      liquidityZones: [],
      premiumDiscount: 'EQUILIBRIUM',
      distanceToNearestOB: null,
      distanceToNearestFVG: null,
      priceInOrderBlock: false,
      priceInFVG: false,
    };
  }
}
