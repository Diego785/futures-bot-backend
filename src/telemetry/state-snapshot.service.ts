import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { StrategyStateSnapshot } from '../trading/entities/strategy-state-snapshot.entity';

export interface SnapshotInput {
  cycleAt: Date;
  candleCloseTime: number;
  symbol: string;
  timeframe: string;
  state: string;
  bias: string | null;
  activeZones: Array<{ type: 'OB' | 'FVG'; high: number; low: number; confluence?: boolean }>;
  waitCycles: number;
  createdAtBreakTime: number | null;
  htfContext: StrategyStateSnapshot['htfContext'];
  smcContext: StrategyStateSnapshot['smcContext'];
  indicators: StrategyStateSnapshot['indicators'];
  lastSignalAction: string | null;
  lastSignalReason: string | null;
}

/**
 * Persists the strategy's internal state at every cycle.
 * Created 2026-05-21 as part of canary validation plan.
 *
 * Use case: replay validation. To reproduce a trade that happened in live,
 * load the snapshot at cycleAt = (trade.openedAt - 1 candle), reconstruct
 * the PullbackObSignalService state from it, then replay candles forward.
 *
 * Failures during persistence are logged but do not block the cycle —
 * snapshots are observability, not correctness-critical.
 */
@Injectable()
export class StateSnapshotService {
  private readonly logger = new Logger(StateSnapshotService.name);

  constructor(
    @InjectRepository(StrategyStateSnapshot)
    private readonly repo: Repository<StrategyStateSnapshot>,
  ) {}

  async persist(input: SnapshotInput): Promise<void> {
    try {
      const entity = this.repo.create({
        cycleAt: input.cycleAt,
        candleCloseTime: String(input.candleCloseTime),
        symbol: input.symbol,
        timeframe: input.timeframe,
        state: input.state,
        bias: input.bias,
        activeZones: input.activeZones,
        waitCycles: input.waitCycles,
        createdAtBreakTime:
          input.createdAtBreakTime !== null
            ? String(input.createdAtBreakTime)
            : null,
        htfContext: input.htfContext,
        smcContext: input.smcContext,
        indicators: input.indicators,
        lastSignalAction: input.lastSignalAction,
        lastSignalReason: input.lastSignalReason
          ? input.lastSignalReason.slice(0, 255)
          : null,
      });
      await this.repo.save(entity);
    } catch (err) {
      this.logger.warn(`Failed to persist strategy state snapshot: ${err}`);
    }
  }

  /**
   * Load the latest snapshot at or before a given timestamp.
   * Used by replay framework to bootstrap PullbackObSignalService state.
   */
  async getLatestBefore(
    symbol: string,
    timeframe: string,
    beforeOrEqualTime: Date,
  ): Promise<StrategyStateSnapshot | null> {
    try {
      return await this.repo.findOne({
        where: {
          symbol,
          timeframe,
          cycleAt: LessThan(beforeOrEqualTime),
        },
        order: { cycleAt: 'DESC' },
      });
    } catch (err) {
      this.logger.warn(`Failed to load state snapshot: ${err}`);
      return null;
    }
  }

  /**
   * Returns recent snapshots for diagnostic purposes.
   */
  async getRecent(symbol: string, limit = 50): Promise<StrategyStateSnapshot[]> {
    try {
      return await this.repo.find({
        where: { symbol },
        order: { cycleAt: 'DESC' },
        take: limit,
      });
    } catch (err) {
      this.logger.warn(`Failed to list recent snapshots: ${err}`);
      return [];
    }
  }
}
