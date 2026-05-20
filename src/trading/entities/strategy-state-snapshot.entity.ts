import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  Index,
} from 'typeorm';

/**
 * Snapshot of the strategy's internal state at the end of each cycle.
 * Used by replay validation framework to load real live state and reproduce
 * trades exactly, instead of starting backtest with fresh state-machine.
 *
 * Created 2026-05-21 as part of the canary validation plan
 * (project_canary_validation_plan_2026_05_20).
 *
 * One row per cycle. Negligible storage with 24 cycles/day in 1h timeframe.
 */
@Entity('strategy_state_snapshots')
@Index(['cycleAt'])
@Index(['symbol', 'timeframe', 'cycleAt'])
export class StrategyStateSnapshot {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'timestamptz' })
  cycleAt: Date;

  @Column({ type: 'bigint', nullable: true })
  candleCloseTime: string; // ms epoch — string because bigint in PG becomes string in JS

  @Column({ type: 'varchar', length: 20 })
  symbol: string;

  @Column({ type: 'varchar', length: 10 })
  timeframe: string;

  @Column({ type: 'varchar', length: 20 })
  state: string; // IDLE | WAITING_PULLBACK

  @Column({ type: 'varchar', length: 10, nullable: true })
  bias: string | null; // LONG | SHORT | null

  @Column({ type: 'jsonb', default: [] })
  activeZones: Array<{
    type: 'OB' | 'FVG';
    high: number;
    low: number;
    confluence?: boolean;
  }>;

  @Column({ type: 'int', default: 0 })
  waitCycles: number;

  @Column({ type: 'bigint', nullable: true })
  createdAtBreakTime: string | null;

  @Column({ type: 'jsonb', nullable: true })
  htfContext: {
    emaCrossover?: string;
    marketStructure?: string;
    marketStructure4h?: string | null;
    rsi14?: number;
    atrPercent?: number;
    premiumDiscount?: string;
  } | null;

  @Column({ type: 'jsonb', nullable: true })
  smcContext: {
    marketStructure?: string;
    premiumDiscount?: string;
    activeOrderBlocks?: number;
    activeFairValueGaps?: number;
    priceInOrderBlock?: boolean;
    priceInFVG?: boolean;
    lastStructureBreak?: string | null;
  } | null;

  @Column({ type: 'jsonb', nullable: true })
  indicators: {
    currentPrice?: number;
    ema9?: number;
    ema21?: number;
    rsi14?: number;
    atr14?: number;
    atrPercent?: number;
    emaCrossover?: string;
    emaSlope?: string;
  } | null;

  @Column({ type: 'varchar', length: 10, nullable: true })
  lastSignalAction: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  lastSignalReason: string | null;

  @CreateDateColumn()
  createdAt: Date;
}
