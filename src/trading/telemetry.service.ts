import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DailyTelemetry } from './entities/daily-telemetry.entity';

export type CycleOutcome =
  | { kind: 'entry'; action: 'LONG' | 'SHORT' }
  | { kind: 'setup_created' }
  | { kind: 'blocked'; category: string };

export type SignalLifecycle =
  | 'generated'
  | 'executed'
  | 'rejected'
  | 'shadow_executed';

@Injectable()
export class TelemetryService {
  private readonly logger = new Logger(TelemetryService.name);

  constructor(
    @InjectRepository(DailyTelemetry)
    private readonly repo: Repository<DailyTelemetry>,
  ) {}

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private async getOrCreateToday(): Promise<DailyTelemetry> {
    const date = this.today();
    let row = await this.repo.findOne({ where: { date } });
    if (!row) {
      row = this.repo.create({
        date,
        totalCycles: 0,
        setupsCreated: 0,
        entriesAttempted: 0,
        signalsGenerated: 0,
        signalsExecuted: 0,
        signalsRejected: 0,
        blockedReasons: {},
        rejectionReasons: {},
        latestCycleAt: null,
      });
      await this.repo.save(row);
    }
    return row;
  }

  /**
   * Called every strategy cycle. Increments cycle counter, sets heartbeat,
   * categorizes outcome.
   */
  async recordCycle(outcome: CycleOutcome): Promise<void> {
    try {
      const row = await this.getOrCreateToday();
      row.totalCycles += 1;
      row.latestCycleAt = new Date();

      if (outcome.kind === 'entry') {
        row.entriesAttempted += 1;
      } else if (outcome.kind === 'setup_created') {
        row.setupsCreated += 1;
      } else {
        row.blockedReasons[outcome.category] =
          (row.blockedReasons[outcome.category] ?? 0) + 1;
      }

      await this.repo.save(row);
    } catch (err) {
      this.logger.error(`Failed to persist cycle telemetry: ${err}`);
    }
  }

  /**
   * Called when a signal moves through its lifecycle (generated/executed/rejected).
   * Persists rejection reason if provided.
   */
  async recordSignalLifecycle(
    stage: SignalLifecycle,
    rejectionReason?: string,
  ): Promise<void> {
    try {
      const row = await this.getOrCreateToday();
      if (stage === 'generated') row.signalsGenerated += 1;
      else if (stage === 'executed') row.signalsExecuted += 1;
      else if (stage === 'rejected') {
        row.signalsRejected += 1;
        if (rejectionReason) {
          const key = this.normalizeRejectionReason(rejectionReason);
          row.rejectionReasons[key] = (row.rejectionReasons[key] ?? 0) + 1;
        }
      }
      await this.repo.save(row);
    } catch (err) {
      this.logger.error(`Failed to persist signal lifecycle: ${err}`);
    }
  }

  /**
   * Returns latestCycleAt for heartbeat checks. Used by maintenance-cron to
   * detect bot offline / WS staleness. Returns null if table doesn't exist
   * yet (graceful degradation pre-migration).
   */
  async getLatestCycleAt(): Promise<Date | null> {
    try {
      const row = await this.repo.findOne({ where: { date: this.today() } });
      return row?.latestCycleAt ?? null;
    } catch (err) {
      this.logger.warn(`getLatestCycleAt failed (table may not exist): ${err}`);
      return null;
    }
  }

  /**
   * Reject reasons are free-form strings. Bucket them to keep cardinality low.
   */
  private normalizeRejectionReason(reason: string): string {
    const r = reason.toLowerCase();
    if (r.includes('cooldown')) return 'cooldown';
    if (r.includes('existing open trade')) return 'existing_open_trade';
    if (r.includes('existing position')) return 'existing_position_exchange';
    if (r.includes('daily loss')) return 'daily_loss_limit';
    if (r.includes('trading is disabled')) return 'trading_disabled';
    if (r.includes('min notional')) return 'below_min_notional';
    if (r.includes('invalid entry')) return 'invalid_entry_price';
    return 'other';
  }
}
