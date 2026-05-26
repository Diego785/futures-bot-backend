import type { Candle } from '../common/interfaces/binance.interfaces';
import type {
  BacktestTrade,
  TradeContextAtEntry,
  VolatilityBucket,
  Delta24hBucket,
  SessionLabel,
} from './interfaces';

interface OpenPosition {
  id: number;
  direction: 'LONG' | 'SHORT';
  entryTime: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  quantity: number;
  gateScore: number;
  confidence?: number;
  trailingPhase: number;

  // Phase 1: tracking MFE/MAE
  initialStopLoss: number;
  initialRiskUsd: number;
  peakPrice: number;
  troughPrice: number;
  timeToMfeBars: number;          // 0 = peak nunca actualizado (queda en entryPrice)
  timeToMaeBars: number;
  barsElapsed: number;            // 1-indexed: 1 = primer candle procesado tras entry
  candleHistory: Array<{ low: number; high: number }>;
  contextAtEntry: TradeContextAtEntry;
}

const DEFAULT_CONTEXT: TradeContextAtEntry = {
  delta24hAtEntry: null,
  atrPctAtEntry: 0,
  htfDistancePct: null,
  entryHourUtc: 0,
};

export class TradeSimulator {
  private position: OpenPosition | null = null;
  private tradeCounter = 0;
  private commissionRate: number;
  private quantity: number;
  private enableTrailing: boolean;
  private breakevenPct: number;
  private trailMode: 'entry-pct' | 'tp-distance' | 'fixed-amount';
  private trailFixed: number;
  private trailActivation: number;
  private trailBreakevenAt: number;
  private pessimisticTrail: boolean;
  private economicBe: boolean;
  private economicBeSafetyPct: number;

  constructor(
    commissionRate: number,
    notional: number,
    enableTrailing = true,
    breakevenPct = 0.3,
    trailMode: 'entry-pct' | 'tp-distance' | 'fixed-amount' = 'entry-pct',
    trailFixed = 100,
    trailActivation?: number,
    trailBreakevenAt = 0,
    pessimisticTrail = false,
    economicBe = false,
    economicBeSafetyPct = 0.02,
  ) {
    this.commissionRate = commissionRate;
    this.quantity = 0;
    this.notional = notional;
    this.enableTrailing = enableTrailing;
    this.breakevenPct = breakevenPct;
    this.trailMode = trailMode;
    this.trailFixed = trailFixed;
    this.trailActivation = trailActivation ?? trailFixed;
    this.trailBreakevenAt = trailBreakevenAt;
    this.pessimisticTrail = pessimisticTrail;
    this.economicBe = economicBe;
    this.economicBeSafetyPct = economicBeSafetyPct;
  }

  /**
   * BE buffer (price units, applied above/below entry).
   * Legacy: flat 0.05% of entry price.
   * Economic: covers round-trip taker fees (2 * commissionRate) + safety margin.
   * Example: entry $80,000, commissionRate 0.0005 (taker), safety 0.02%:
   *   Legacy:   $40
   *   Economic: $80,000 * (0.001 + 0.0002) = $96
   */
  private beBuffer(entryPrice: number): number {
    if (!this.economicBe) {
      return entryPrice * 0.0005;
    }
    return entryPrice * (this.commissionRate * 2 + this.economicBeSafetyPct / 100);
  }

  private notional: number;

  get hasPosition(): boolean {
    return this.position !== null;
  }

  openPosition(
    direction: 'LONG' | 'SHORT',
    entryPrice: number,
    stopLoss: number,
    takeProfit: number,
    entryTime: number,
    gateScore: number,
    confidence?: number,
    context?: TradeContextAtEntry,
  ): void {
    this.tradeCounter++;
    // FIX 2026-05-19 (sizing): match live behavior — Bybit min step is 0.001 BTC,
    // and bot bumps up if calculated qty < min_step. So qty floor is 0.001.
    // This makes backtest sizing match production: notional ~= $77 with BTC @ 77k.
    this.quantity = Math.max(
      0.001,
      Math.floor((this.notional / entryPrice) * 1000) / 1000,
    );
    const initialRiskUsd = this.quantity * Math.abs(entryPrice - stopLoss);

    this.position = {
      id: this.tradeCounter,
      direction,
      entryTime,
      entryPrice,
      stopLoss,
      takeProfit,
      quantity: this.quantity,
      gateScore,
      confidence,
      trailingPhase: 0,

      // Phase 1 instrumentation
      initialStopLoss: stopLoss,
      initialRiskUsd,
      peakPrice: entryPrice,
      troughPrice: entryPrice,
      timeToMfeBars: 0,
      timeToMaeBars: 0,
      barsElapsed: 0,
      candleHistory: [],
      contextAtEntry: context ?? DEFAULT_CONTEXT,
    };
  }

  processCandle(candle: Candle): BacktestTrade | null {
    if (!this.position) return null;

    const pos = this.position;
    const isLong = pos.direction === 'LONG';

    // ───── Phase 1: tracking MFE/MAE/history ─────
    // Run BEFORE any close-trade short-circuit so the closing candle's range
    // is included in candleHistory and peak/trough tracking.
    pos.barsElapsed += 1;
    pos.candleHistory.push({ low: candle.low, high: candle.high });

    const candleFavorablePrice = isLong ? candle.high : candle.low;
    const isNewPeak = isLong
      ? candleFavorablePrice > pos.peakPrice
      : candleFavorablePrice < pos.peakPrice;
    if (isNewPeak) {
      pos.peakPrice = candleFavorablePrice;
      pos.timeToMfeBars = pos.barsElapsed;
    }

    const candleAdversePrice = isLong ? candle.low : candle.high;
    const isNewTrough = isLong
      ? candleAdversePrice < pos.troughPrice
      : candleAdversePrice > pos.troughPrice;
    if (isNewTrough) {
      pos.troughPrice = candleAdversePrice;
      pos.timeToMaeBars = pos.barsElapsed;
    }
    // ───── fin tracking ─────

    // PESSIMISTIC MODE: check if worstPrice hits CURRENT SL BEFORE any trailing update.
    // This assumes adverse intrabar order (low before high for LONG, high before low for SHORT).
    if (this.pessimisticTrail) {
      const worstPrice = isLong ? candle.low : candle.high;
      const slHitBefore = isLong ? worstPrice <= pos.stopLoss : worstPrice >= pos.stopLoss;
      if (slHitBefore) {
        return this.closeTrade(pos.stopLoss, candle.closeTime, pos.trailingPhase > 0 ? 'TRAILING_SL' : 'SL');
      }
      const tpHitBefore = isLong ? candle.high >= pos.takeProfit : candle.low <= pos.takeProfit;
      if (tpHitBefore) {
        return this.closeTrade(pos.takeProfit, candle.closeTime, 'TP');
      }
    }

    // Trailing logic uses bestPrice (peak intrabar) — approximates live cron that
    // sees prices throughout the minute (not just close). When cron moves SL up,
    // Bybit conditional SL fires instantly if price retrace touches it.
    //
    // NOTE 2026-05-24: previous attempt used candle.close as bestPrice. Empirically
    // BROKE the motor on aggregate (PF 4.11 → 0.14) because it lost the cumulative
    // peak-trailing behavior. Reverted to high/low which empirically matches live
    // PF 4.11 better. Single-trade replay (22/05) still matches live to ±$0.01.
    const bestPrice = isLong ? candle.high : candle.low;
    const priceDiff = isLong
      ? bestPrice - pos.entryPrice
      : pos.entryPrice - bestPrice;

    let newSl = pos.stopLoss;

    // BREAKEVEN LOCK — independent of trailing.
    if (this.trailBreakevenAt > 0 && priceDiff >= this.trailBreakevenAt) {
      const buffer = this.beBuffer(pos.entryPrice);
      const beSl = isLong
        ? pos.entryPrice + buffer
        : pos.entryPrice - buffer;
      if (isLong ? beSl > newSl : beSl < newSl) {
        newSl = beSl;
        pos.trailingPhase = Math.max(pos.trailingPhase, 1);
      }
    }

    // Only run trailing logic if enableTrailing (BE lock above runs regardless)
    if (!this.enableTrailing) {
      pos.stopLoss = newSl;
      const slHit = isLong ? candle.low <= pos.stopLoss : candle.high >= pos.stopLoss;
      const tpHit = isLong ? candle.high >= pos.takeProfit : candle.low <= pos.takeProfit;
      if (slHit) return this.closeTrade(pos.stopLoss, candle.closeTime, pos.trailingPhase > 0 ? 'TRAILING_SL' : 'SL');
      if (tpHit) return this.closeTrade(pos.takeProfit, candle.closeTime, 'TP');
      return null;
    }

    if (this.trailMode === 'tp-distance') {
      // TP-distance mode: trail based on % of distance to TP
      const tpDistance = Math.abs(pos.takeProfit - pos.entryPrice);
      if (tpDistance > 0 && priceDiff > 0) {
        const profitRatio = priceDiff / tpDistance; // 0.0 to 1.0+

        if (profitRatio >= 0.75) {
          const trailSl = isLong
            ? pos.entryPrice + priceDiff * 0.6
            : pos.entryPrice - priceDiff * 0.6;
          if (isLong ? trailSl > newSl : trailSl < newSl) {
            newSl = trailSl;
            pos.trailingPhase = 3;
          }
        } else if (profitRatio >= 0.50) {
          const trailSl = isLong
            ? pos.entryPrice + priceDiff * 0.4
            : pos.entryPrice - priceDiff * 0.4;
          if (isLong ? trailSl > newSl : trailSl < newSl) {
            newSl = trailSl;
            pos.trailingPhase = Math.max(pos.trailingPhase, 2);
          }
        } else if (profitRatio >= 0.25) {
          // Breakeven: SL moves to entry + tiny buffer
          const buffer = this.beBuffer(pos.entryPrice);
          const beSl = isLong
            ? pos.entryPrice + buffer
            : pos.entryPrice - buffer;
          if (isLong ? beSl > newSl : beSl < newSl) {
            newSl = beSl;
            pos.trailingPhase = Math.max(pos.trailingPhase, 1);
          }
        }
      }
    } else if (this.trailMode === 'fixed-amount') {
      // Fixed-amount mode: trail when priceDiff >= activation threshold
      if (priceDiff >= this.trailActivation) {
        // SL trails behind price by trailFixed amount
        const trailSl = isLong
          ? bestPrice - this.trailFixed
          : bestPrice + this.trailFixed;
        if (isLong ? trailSl > newSl : trailSl < newSl) {
          newSl = trailSl;
          pos.trailingPhase = Math.max(pos.trailingPhase, 1);
        }
      }
    } else {
      // Entry-pct mode (original): trail based on % of entry price
      const profitPct = (priceDiff / pos.entryPrice) * 100;
      const bePct = this.breakevenPct;
      const trailPct2 = bePct + 0.2;
      const trailPct3 = bePct + 0.5;

      if (profitPct >= trailPct3) {
        const trailSl = isLong
          ? pos.entryPrice + priceDiff * 0.7
          : pos.entryPrice - priceDiff * 0.7;
        if (isLong ? trailSl > newSl : trailSl < newSl) {
          newSl = trailSl;
          pos.trailingPhase = 3;
        }
      } else if (profitPct >= trailPct2) {
        const trailSl = isLong
          ? pos.entryPrice + priceDiff * 0.5
          : pos.entryPrice - priceDiff * 0.5;
        if (isLong ? trailSl > newSl : trailSl < newSl) {
          newSl = trailSl;
          pos.trailingPhase = Math.max(pos.trailingPhase, 2);
        }
      } else if (profitPct >= bePct) {
        const buffer = this.beBuffer(pos.entryPrice);
        const beSl = isLong
          ? pos.entryPrice + buffer
          : pos.entryPrice - buffer;
        if (isLong ? beSl > newSl : beSl < newSl) {
          newSl = beSl;
          pos.trailingPhase = Math.max(pos.trailingPhase, 1);
        }
      }
    }

    pos.stopLoss = newSl;

    // Check SL and TP hits AFTER trailing update.
    // Modeling assumption: when cron moves SL up at peak, Bybit's conditional SL
    // becomes active intra-bar. If price retraces to the new SL in the same bar,
    // it triggers an exit. This is empirically more accurate than the alternative
    // (defer new SL to next bar), which broke PF aggregate from 4.11 to 0.14.
    const worstPrice = isLong ? candle.low : candle.high;
    const slHit = isLong ? worstPrice <= pos.stopLoss : worstPrice >= pos.stopLoss;
    const tpHit = isLong ? candle.high >= pos.takeProfit : candle.low <= pos.takeProfit;

    // If both could hit in same candle, assume worst case (SL)
    if (slHit) {
      return this.closeTrade(pos.stopLoss, candle.closeTime, slHit && pos.trailingPhase > 0 ? 'TRAILING_SL' : 'SL');
    }

    if (tpHit) {
      return this.closeTrade(pos.takeProfit, candle.closeTime, 'TP');
    }

    return null;
  }

  forceClose(price: number, time: number): BacktestTrade | null {
    if (!this.position) return null;
    return this.closeTrade(price, time, 'END_OF_DATA');
  }

  private closeTrade(
    exitPrice: number,
    exitTime: number,
    exitReason: BacktestTrade['exitReason'],
  ): BacktestTrade {
    const pos = this.position!;
    const isLong = pos.direction === 'LONG';
    const direction = isLong ? 1 : -1;
    const pricePnl = (exitPrice - pos.entryPrice) * pos.quantity * direction;
    const commission =
      pos.entryPrice * pos.quantity * this.commissionRate +
      exitPrice * pos.quantity * this.commissionRate;
    const pnlUsd = pricePnl - commission;

    // ───── Phase 1: cálculos finales MFE/MAE ─────
    const mfeMaxUsd = isLong
      ? pos.quantity * (pos.peakPrice - pos.entryPrice)
      : pos.quantity * (pos.entryPrice - pos.peakPrice);
    const maeMaxUsd = isLong
      ? pos.quantity * (pos.entryPrice - pos.troughPrice)
      : pos.quantity * (pos.troughPrice - pos.entryPrice);

    const safeRisk = pos.initialRiskUsd > 0 ? pos.initialRiskUsd : 1; // evitar div/0
    const mfeMaxR = pos.initialRiskUsd > 0 ? mfeMaxUsd / safeRisk : 0;
    const maeMaxR = pos.initialRiskUsd > 0 ? maeMaxUsd / safeRisk : 0;

    // Split MAE before/after MFE — Opción A simple (relativo al MFE GLOBAL).
    // Regla: peak bar se EXCLUYE de ambos buckets (intracandle order desconocido).
    // candleHistory[b] corresponde a barsElapsed = b+1.
    // peakBar = pos.timeToMfeBars (1-indexed). 0 = peak nunca avanzó (queda en entryPrice).
    const peakBar = pos.timeToMfeBars;
    let maeBeforeMfeUsd = 0;
    let maeAfterMfeUsd = 0;
    for (let b = 0; b < pos.candleHistory.length; b++) {
      const barIdx1 = b + 1; // bar number 1-indexed for comparison with peakBar
      if (barIdx1 === peakBar) continue;
      const bar = pos.candleHistory[b];
      const adversePrice = isLong ? bar.low : bar.high;
      const adverseRaw = isLong
        ? Math.max(0, pos.entryPrice - adversePrice)
        : Math.max(0, adversePrice - pos.entryPrice);
      const adverseUsd = adverseRaw * pos.quantity;
      if (barIdx1 < peakBar) {
        if (adverseUsd > maeBeforeMfeUsd) maeBeforeMfeUsd = adverseUsd;
      } else {
        if (adverseUsd > maeAfterMfeUsd) maeAfterMfeUsd = adverseUsd;
      }
    }
    const maeBeforeMfeR = pos.initialRiskUsd > 0 ? maeBeforeMfeUsd / safeRisk : 0;
    const maeAfterMfeR = pos.initialRiskUsd > 0 ? maeAfterMfeUsd / safeRisk : 0;

    // RR-touched gross
    const touched0_5R = mfeMaxR >= 0.5;
    const touched1R = mfeMaxR >= 1.0;
    const touched2R = mfeMaxR >= 2.0;
    const touched3R = mfeMaxR >= 3.0;

    // Fees estimadas (round-trip approximation — NO incluye funding ni maker/taker mix real)
    const feeRateRtPct = this.commissionRate * 2 * 100;
    const entryFeeUsd = pos.entryPrice * pos.quantity * this.commissionRate;
    const exitFeeAtPeakUsd = pos.peakPrice * pos.quantity * this.commissionRate;
    const mfeMaxUsdAfterFeesEstimate = mfeMaxUsd - entryFeeUsd - exitFeeAtPeakUsd;
    const mfeMaxRAfterFeesEstimate = pos.initialRiskUsd > 0
      ? mfeMaxUsdAfterFeesEstimate / safeRisk
      : 0;

    const touched0_5RAfterFeesEstimate = mfeMaxRAfterFeesEstimate >= 0.5;
    const touched1RAfterFeesEstimate = mfeMaxRAfterFeesEstimate >= 1.0;
    const touched2RAfterFeesEstimate = mfeMaxRAfterFeesEstimate >= 2.0;
    const touched3RAfterFeesEstimate = mfeMaxRAfterFeesEstimate >= 3.0;

    // Contexto al entry → buckets
    const ctx = pos.contextAtEntry;
    const volatilityBucket: VolatilityBucket =
      ctx.atrPctAtEntry < 0.20 ? 'LOW' :
      ctx.atrPctAtEntry < 0.40 ? 'MED' : 'HIGH';
    const sessionLabel: SessionLabel =
      ctx.entryHourUtc < 7  ? 'ASIA' :
      ctx.entryHourUtc < 12 ? 'EU' :
      ctx.entryHourUtc < 16 ? 'OVERLAP' : 'US';
    const delta24hBucket: Delta24hBucket | null = ctx.delta24hAtEntry === null
      ? null
      : Math.abs(ctx.delta24hAtEntry) < 1.0 ? 'CONSOLIDATION'
      : Math.abs(ctx.delta24hAtEntry) < 3.0 ? 'NORMAL'
      : 'MOMENTUM_EXTREME';
    // ───── fin Phase 1 ─────

    const trade: BacktestTrade = {
      id: pos.id,
      direction: pos.direction,
      entryTime: pos.entryTime,
      entryPrice: pos.entryPrice,
      exitTime,
      exitPrice,
      stopLoss: pos.stopLoss,
      takeProfit: pos.takeProfit,
      exitReason,
      pnlUsd,
      gateScore: pos.gateScore,
      confidence: pos.confidence,
      trailingPhase: pos.trailingPhase,

      // Phase 1: MFE/MAE block
      mfeMaxUsd,
      maeMaxUsd,
      mfeMaxR,
      maeMaxR,
      peakPrice: pos.peakPrice,
      troughPrice: pos.troughPrice,
      initialStopLoss: pos.initialStopLoss,
      initialRiskUsd: pos.initialRiskUsd,
      timeToMfeBars: pos.timeToMfeBars,
      timeToMaeBars: pos.timeToMaeBars,
      timeToCloseBars: pos.barsElapsed,
      maeOccurredBeforeMfe: pos.timeToMaeBars > 0 && pos.timeToMfeBars > 0
        ? pos.timeToMaeBars < pos.timeToMfeBars
        : false,

      // Phase 1: MAE split
      maeBeforeMfeUsd,
      maeAfterMfeUsd,
      maeBeforeMfeR,
      maeAfterMfeR,

      // Phase 1: RR-touched gross
      touched0_5R,
      touched1R,
      touched2R,
      touched3R,

      // Phase 1: fees estimadas
      feeRateRtPct,
      entryFeeUsd,
      exitFeeAtPeakUsd,
      mfeMaxUsdAfterFeesEstimate,
      mfeMaxRAfterFeesEstimate,
      touched0_5RAfterFeesEstimate,
      touched1RAfterFeesEstimate,
      touched2RAfterFeesEstimate,
      touched3RAfterFeesEstimate,

      // Phase 1: contexto al entry
      delta24hAtEntry: ctx.delta24hAtEntry,
      atrPctAtEntry: ctx.atrPctAtEntry,
      volatilityBucket,
      htfDistancePct: ctx.htfDistancePct,
      entryHourUtc: ctx.entryHourUtc,
      sessionLabel,
      delta24hBucket,
    };

    this.position = null;
    return trade;
  }
}
