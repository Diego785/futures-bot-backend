import { TradeSimulator } from '../trade-simulator';
import type { Candle } from '../../common/interfaces/binance.interfaces';
import type { TradeContextAtEntry, BacktestTrade } from '../interfaces';

/**
 * Tests Phase 1 instrumentation:
 *  - MFE/MAE tracking (intracandle_extreme convention)
 *  - MAE split before/after MFE (Opción A: relative to global MFE)
 *  - RR-touched flags (gross + after-fees-estimate)
 *  - Context-derived buckets (volatility, session, delta24h)
 *
 * Convention: barsElapsed is 1-indexed. peakBar = 0 means peak never advanced
 * past entryPrice. Peak bar is excluded from both maeBeforeMfe and maeAfterMfe
 * buckets to avoid intracandle ordering ambiguity.
 */

const COMMISSION = 0.0005; // 0.05% per side -> 0.10% RT
const NOTIONAL = 1000;

function mkCandle(low: number, high: number, closeTime = 0): Candle {
  return {
    openTime: closeTime - 900_000,
    closeTime,
    open: low,
    high,
    low,
    close: high,
    volume: 1,
    quoteVolume: 1,
    trades: 1,
    closed: true,
  } as Candle;
}

function ctx(over: Partial<TradeContextAtEntry> = {}): TradeContextAtEntry {
  return {
    delta24hAtEntry: 0,
    atrPctAtEntry: 0.30,
    htfDistancePct: 0,
    entryHourUtc: 10,
    ...over,
  };
}

function runTrade(
  direction: 'LONG' | 'SHORT',
  entryPrice: number,
  stopLoss: number,
  takeProfit: number,
  candles: Candle[],
  context: TradeContextAtEntry = ctx(),
): BacktestTrade {
  // Disable trailing for predictable peak/trough tracking on raw candle data
  const sim = new TradeSimulator(COMMISSION, NOTIONAL, false, 0.3, 'fixed-amount', 100, 100, 0, false);
  sim.openPosition(direction, entryPrice, stopLoss, takeProfit, 0, 0, 0.7, context);
  let closed: BacktestTrade | null = null;
  for (const c of candles) {
    closed = sim.processCandle(c);
    if (closed) return closed;
  }
  // If still open, force close at last candle's close
  const last = candles[candles.length - 1];
  return sim.forceClose(last.high, last.closeTime)!;
}

describe('TradeSimulator — Phase 1 instrumentation', () => {
  describe('MFE/MAE basic LONG', () => {
    it('Test 1: simple peak after entry', () => {
      // entry 100, candle 100→110, exit hit at TP 110 (intracandle high reaches it).
      // qty = floor(NOTIONAL/100 * 1000)/1000 = 10
      const trade = runTrade('LONG', 100, 95, 110, [mkCandle(100, 110)]);
      expect(trade.peakPrice).toBe(110);
      expect(trade.exitReason).toBe('TP');
      expect(trade.mfeMaxUsd).toBeCloseTo(10 * (110 - 100), 4); // qty=10 * $10 = $100
      expect(trade.mfeMaxR).toBeCloseTo((10 * 10) / (10 * 5), 4); // 100 / 50 = 2.0
      expect(trade.touched1R).toBe(true);
      expect(trade.touched2R).toBe(true);
      expect(trade.touched3R).toBe(false);
    });

    it('Test 2: MAE before MFE (down then up)', () => {
      // entry 100, candle1 95-100, candle2 100-110.
      // MAE peaks at 95 in bar 1, MFE peaks at 110 in bar 2.
      const trade = runTrade('LONG', 100, 90, 115, [
        mkCandle(95, 100),
        mkCandle(100, 110),
        mkCandle(110, 115),
      ]);
      expect(trade.peakPrice).toBe(115);
      expect(trade.troughPrice).toBe(95);
      expect(trade.timeToMaeBars).toBe(1);
      expect(trade.timeToMfeBars).toBe(3); // last bar, 1-indexed
      expect(trade.maeOccurredBeforeMfe).toBe(true);
    });

    it('Test 3: MAE after MFE (up then down)', () => {
      // entry 100, candle1 100-110 (peak), candle2 90-100 (deep retrace).
      // Peak at bar 1, deeper trough at bar 2 → MAE after MFE.
      const sim = new TradeSimulator(COMMISSION, NOTIONAL, false, 0.3, 'fixed-amount', 100, 100, 0, false);
      sim.openPosition('LONG', 100, 85, 120, 0, 0, 0.7, ctx());
      sim.processCandle(mkCandle(100, 110));
      // Force close at bar 2 with low 90 so we observe full trajectory
      const trade = sim['closeTrade'](95, 1800_000, 'END_OF_DATA');
      // Manually simulate bar 2 first by processing then closing
      // (We re-do this with explicit trajectory)
      const trade2 = runTrade('LONG', 100, 85, 120, [
        mkCandle(100, 110),
        mkCandle(90, 100), // trough at 90
        mkCandle(95, 95),
      ]);
      expect(trade2.peakPrice).toBe(110);
      expect(trade2.troughPrice).toBe(90);
      expect(trade2.timeToMfeBars).toBe(1);
      expect(trade2.timeToMaeBars).toBe(2);
      expect(trade2.maeOccurredBeforeMfe).toBe(false);
      // maeBeforeMfe: bars [1, peakBar-1] = empty (peakBar=1) → 0
      // maeAfterMfe: bars [peakBar+1, end] = bars 2-3 → max adverse = (100 - 90)*qty
      expect(trade2.maeBeforeMfeUsd).toBe(0);
      expect(trade2.maeAfterMfeUsd).toBeCloseTo(10 * (100 - 90), 4);
    });
  });

  describe('RR-touched flags', () => {
    it('Test 4: trade touching 1.5R does not flag 2R', () => {
      // entry 100, SL 90 (1R = $100), peak 115 (1.5R)
      const trade = runTrade('LONG', 100, 90, 200, [
        mkCandle(100, 115),
        mkCandle(95, 95), // close trade
      ]);
      // Note: this trade may close on END_OF_DATA at $95
      expect(trade.peakPrice).toBe(115);
      expect(trade.mfeMaxR).toBeCloseTo(1.5, 1);
      expect(trade.touched0_5R).toBe(true);
      expect(trade.touched1R).toBe(true);
      expect(trade.touched2R).toBe(false);
      expect(trade.touched3R).toBe(false);
    });
  });

  describe('SHORT inverse', () => {
    it('Test 5: SHORT entry, peak below entry', () => {
      // entry 100, candle 90-100 → MFE = (100-90)*qty
      const trade = runTrade('SHORT', 100, 110, 85, [mkCandle(90, 100)]);
      expect(trade.peakPrice).toBe(90);
      expect(trade.mfeMaxUsd).toBeCloseTo(10 * (100 - 90), 4);
    });
  });

  describe('After-fees-estimate', () => {
    it('Test 6: MFE-net-fees lower than gross MFE', () => {
      // qty=10, entry 100, peak 110.
      // Gross MFE = 100. Fees: entry 100*10*0.0005=0.5, exit 110*10*0.0005=0.55. Total fees 1.05.
      // Net MFE = 100 - 1.05 = 98.95.
      const trade = runTrade('LONG', 100, 90, 200, [mkCandle(100, 110), mkCandle(105, 105)]);
      expect(trade.mfeMaxUsd).toBeCloseTo(100, 1);
      expect(trade.entryFeeUsd).toBeCloseTo(0.5, 4);
      expect(trade.exitFeeAtPeakUsd).toBeCloseTo(0.55, 4);
      expect(trade.mfeMaxUsdAfterFeesEstimate).toBeCloseTo(100 - 0.5 - 0.55, 4);
      expect(trade.feeRateRtPct).toBeCloseTo(0.10, 4);
    });

    it('Test 7: RR flag boundary — gross 1.05R, net could fall below 1R', () => {
      // entry 100, SL 95 (1R = $50). Peak ~ 105.5 → gross 1.10R.
      // Fees ≈ $1.05, leaving net MFE ≈ $54.45 → 1.089R. Just barely 1R after fees.
      // With smaller risk, fees relative impact is bigger.
      const trade = runTrade('LONG', 100, 99, 200, [
        mkCandle(100, 100.8), // peak 100.8, $8 gross MFE on qty=10
        mkCandle(99, 99), // close
      ]);
      // 1R = qty * 1 = $10. Gross MFE = $8 → 0.8R. Should NOT touch 1R.
      expect(trade.mfeMaxR).toBeCloseTo(0.8, 1);
      expect(trade.touched1R).toBe(false);
      // Net fees ~$1, net MFE ~$7 → 0.7R, still < 1R
      expect(trade.touched1RAfterFeesEstimate).toBe(false);
    });
  });

  describe('Context buckets', () => {
    it('Test 8: volatility bucket from atrPctAtEntry', () => {
      const lowTrade = runTrade('LONG', 100, 95, 105, [mkCandle(100, 102)], ctx({ atrPctAtEntry: 0.10 }));
      expect(lowTrade.volatilityBucket).toBe('LOW');

      const medTrade = runTrade('LONG', 100, 95, 105, [mkCandle(100, 102)], ctx({ atrPctAtEntry: 0.30 }));
      expect(medTrade.volatilityBucket).toBe('MED');

      const highTrade = runTrade('LONG', 100, 95, 105, [mkCandle(100, 102)], ctx({ atrPctAtEntry: 0.50 }));
      expect(highTrade.volatilityBucket).toBe('HIGH');
    });

    it('Test 9: session label from entryHourUtc', () => {
      const asia = runTrade('LONG', 100, 95, 105, [mkCandle(100, 102)], ctx({ entryHourUtc: 3 }));
      expect(asia.sessionLabel).toBe('ASIA');

      const eu = runTrade('LONG', 100, 95, 105, [mkCandle(100, 102)], ctx({ entryHourUtc: 9 }));
      expect(eu.sessionLabel).toBe('EU');

      const overlap = runTrade('LONG', 100, 95, 105, [mkCandle(100, 102)], ctx({ entryHourUtc: 14 }));
      expect(overlap.sessionLabel).toBe('OVERLAP');

      const us = runTrade('LONG', 100, 95, 105, [mkCandle(100, 102)], ctx({ entryHourUtc: 20 }));
      expect(us.sessionLabel).toBe('US');
    });

    it('Test 10: delta24h bucket', () => {
      const cons = runTrade('LONG', 100, 95, 105, [mkCandle(100, 102)], ctx({ delta24hAtEntry: 0.5 }));
      expect(cons.delta24hBucket).toBe('CONSOLIDATION');

      const norm = runTrade('LONG', 100, 95, 105, [mkCandle(100, 102)], ctx({ delta24hAtEntry: 2.0 }));
      expect(norm.delta24hBucket).toBe('NORMAL');

      const ext = runTrade('LONG', 100, 95, 105, [mkCandle(100, 102)], ctx({ delta24hAtEntry: 4.5 }));
      expect(ext.delta24hBucket).toBe('MOMENTUM_EXTREME');

      const nullDelta = runTrade('LONG', 100, 95, 105, [mkCandle(100, 102)], ctx({ delta24hAtEntry: null }));
      expect(nullDelta.delta24hBucket).toBeNull();
    });
  });

  describe('Edge cases', () => {
    it('Test 11: peak never advances (trade closes at SL on first candle)', () => {
      // entry 100, SL 95. Candle goes 90-100 — SL hit immediately.
      const trade = runTrade('LONG', 100, 95, 110, [mkCandle(90, 100)]);
      expect(trade.exitReason).toBe('SL');
      expect(trade.peakPrice).toBe(100); // never advanced past entry
      expect(trade.timeToMfeBars).toBe(0);
      expect(trade.mfeMaxR).toBe(0);
      expect(trade.touched0_5R).toBe(false);
    });

    it('Test 12: initialStopLoss preserved separately from current stopLoss', () => {
      // Use trailing-enabled simulator. Two candles: first doesn't activate trailing,
      // second activates and moves SL but low stays above new SL (no intracandle hit).
      const sim = new TradeSimulator(COMMISSION, NOTIONAL, true, 0.3, 'fixed-amount', 50, 50, 0, false);
      sim.openPosition('LONG', 100, 95, 300, 0, 0, 0.7, ctx());
      // Candle 1: low=100, high=140. priceDiff=40 < 50 (no activation). SL stays at 95.
      sim.processCandle(mkCandle(100, 140));
      // Candle 2: low=130, high=160. priceDiff=60 >= 50. newSL = 160 - 50 = 110. low 130 > 110 (no hit).
      sim.processCandle(mkCandle(130, 160));
      const trade = sim.forceClose(155, 1800_000)!;
      expect(trade).not.toBeNull();
      expect(trade.initialStopLoss).toBe(95);
      expect(trade.stopLoss).toBeGreaterThan(95); // trailing moved it
      expect(trade.stopLoss).toBeCloseTo(110, 0);
    });
  });
});
