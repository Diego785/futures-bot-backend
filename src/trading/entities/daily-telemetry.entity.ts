import {
  Entity,
  PrimaryColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('daily_telemetry')
export class DailyTelemetry {
  @PrimaryColumn({ type: 'date' })
  date: string; // YYYY-MM-DD UTC

  @Column({ type: 'int', default: 0 })
  totalCycles: number;

  @Column({ type: 'int', default: 0 })
  setupsCreated: number;

  @Column({ type: 'int', default: 0 })
  entriesAttempted: number;

  @Column({ type: 'int', default: 0 })
  signalsGenerated: number;

  @Column({ type: 'int', default: 0 })
  signalsExecuted: number;

  @Column({ type: 'int', default: 0 })
  signalsRejected: number;

  // Map of blocked-category → count. Categories defined in SignalGeneratorService:
  // low_volatility, htf_unclear, structure_contradicts, no_zones, slope_against,
  // waiting_pullback, setup_expired, setup_invalidated, filter_pd, idle, other
  @Column({ type: 'jsonb', default: {} })
  blockedReasons: Record<string, number>;

  // Map of rejection-reason → count (from RiskManagerService).
  @Column({ type: 'jsonb', default: {} })
  rejectionReasons: Record<string, number>;

  // Heartbeat: latest moment the bot processed ANY cycle. Used to detect bot offline.
  @Column({ type: 'timestamp with time zone', nullable: true })
  latestCycleAt: Date | null;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
