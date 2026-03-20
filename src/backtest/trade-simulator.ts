import type { Candle } from '../common/interfaces/binance.interfaces';
import type { BacktestTrade } from './interfaces';

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
}

export class TradeSimulator {
  private position: OpenPosition | null = null;
  private tradeCounter = 0;
  private commissionRate: number;
  private quantity: number;
  private enableTrailing: boolean;

  constructor(commissionRate: number, notional: number, enableTrailing = true) {
    this.commissionRate = commissionRate;
    this.quantity = 0;
    this.notional = notional;
    this.enableTrailing = enableTrailing;
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
  ): void {
    this.tradeCounter++;
    this.quantity = Math.floor((this.notional / entryPrice) * 1000) / 1000;

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
    };
  }

  processCandle(candle: Candle): BacktestTrade | null {
    if (!this.position) return null;

    const pos = this.position;
    const isLong = pos.direction === 'LONG';

    // Trailing SL logic — check best price in this candle
    if (!this.enableTrailing) {
      // Skip trailing, go straight to SL/TP check
      const slHit = isLong ? candle.low <= pos.stopLoss : candle.high >= pos.stopLoss;
      const tpHit = isLong ? candle.high >= pos.takeProfit : candle.low <= pos.takeProfit;
      if (slHit) return this.closeTrade(pos.stopLoss, candle.closeTime, 'SL');
      if (tpHit) return this.closeTrade(pos.takeProfit, candle.closeTime, 'TP');
      return null;
    }

    const bestPrice = isLong ? candle.high : candle.low;
    const priceDiff = isLong
      ? bestPrice - pos.entryPrice
      : pos.entryPrice - bestPrice;
    const profitPct = (priceDiff / pos.entryPrice) * 100;

    let newSl = pos.stopLoss;

    if (profitPct >= 0.8) {
      const trailSl = isLong
        ? pos.entryPrice + priceDiff * 0.7
        : pos.entryPrice - priceDiff * 0.7;
      if (isLong ? trailSl > newSl : trailSl < newSl) {
        newSl = trailSl;
        pos.trailingPhase = 3;
      }
    } else if (profitPct >= 0.5) {
      const trailSl = isLong
        ? pos.entryPrice + priceDiff * 0.5
        : pos.entryPrice - priceDiff * 0.5;
      if (isLong ? trailSl > newSl : trailSl < newSl) {
        newSl = trailSl;
        pos.trailingPhase = Math.max(pos.trailingPhase, 2);
      }
    } else if (profitPct >= 0.3) {
      const buffer = pos.entryPrice * 0.0005;
      const beSl = isLong
        ? pos.entryPrice + buffer
        : pos.entryPrice - buffer;
      if (isLong ? beSl > newSl : beSl < newSl) {
        newSl = beSl;
        pos.trailingPhase = Math.max(pos.trailingPhase, 1);
      }
    }

    pos.stopLoss = newSl;

    // Check SL and TP hits
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
    const direction = pos.direction === 'LONG' ? 1 : -1;
    const pricePnl = (exitPrice - pos.entryPrice) * pos.quantity * direction;
    const commission =
      pos.entryPrice * pos.quantity * this.commissionRate +
      exitPrice * pos.quantity * this.commissionRate;
    const pnlUsd = pricePnl - commission;

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
    };

    this.position = null;
    return trade;
  }
}
