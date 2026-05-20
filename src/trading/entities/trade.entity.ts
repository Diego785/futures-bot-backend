import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  OneToMany,
} from 'typeorm';
import { Signal } from './signal.entity';
import { Order } from './order.entity';

@Entity('trades')
export class Trade {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  symbol: string;

  @Column({ type: 'varchar', length: 5 })
  direction: string; // LONG | SHORT

  @Column({ type: 'decimal', precision: 18, scale: 8 })
  entryPrice: number;

  @Column({ type: 'decimal', precision: 18, scale: 8, nullable: true })
  exitPrice: number;

  @Column({ type: 'decimal', precision: 18, scale: 8 })
  quantity: number;

  @Column({ type: 'decimal', precision: 18, scale: 8, nullable: true })
  realizedPnl: number;

  @Column({ type: 'decimal', precision: 18, scale: 8, nullable: true })
  commission: number;

  @Column({ type: 'varchar', length: 25, default: 'OPEN' })
  status: string; // OPEN | CLOSED_TP | CLOSED_SL | CLOSED_MANUAL | CLOSED_KILL_SWITCH | CLOSED_ORPHAN

  @Column({ type: 'decimal', precision: 18, scale: 8, nullable: true })
  stopLoss: number;

  @Column({ type: 'decimal', precision: 18, scale: 8, nullable: true })
  takeProfit: number;

  @ManyToOne(() => Signal, { nullable: true })
  signal: Signal;

  @Column({ nullable: true })
  signalId: string;

  @OneToMany(() => Order, (order) => order.trade)
  orders: Order[];

  @CreateDateColumn()
  openedAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  closedAt: Date;

  // ─── Bybit-sourced PnL reconciliation (2026-05-20) ───
  // Source of truth columns. The bot's realizedPnl above has known bugs (reports
  // gross instead of net, wrong sign for commissions in some paths). These
  // columns are populated from Bybit fills/income API directly. Use these for
  // dashboards, metrics, and any optimization decision. Old realizedPnl kept
  // for backwards compat and diff tracking (pnlDiffFromDb).

  @Column({ type: 'decimal', precision: 18, scale: 8, nullable: true })
  bybitRealizedPnl: number; // gross PnL from Bybit (positive=win, negative=loss)

  @Column({ type: 'decimal', precision: 18, scale: 8, nullable: true })
  bybitFees: number; // total fees entry+exit, as absolute positive

  @Column({ type: 'decimal', precision: 18, scale: 8, default: 0 })
  bybitFunding: number; // funding fee from Bybit (zero in most short trades)

  @Column({ type: 'decimal', precision: 18, scale: 8, nullable: true })
  bybitNetPnl: number; // bybitRealizedPnl - bybitFees + bybitFunding (true PnL)

  @Column({ type: 'varchar', length: 30, nullable: true })
  pnlSource: string; // 'BYBIT_FILLS' | 'BYBIT_INCOME' | 'ESTIMATED'

  @Column({ type: 'decimal', precision: 18, scale: 8, nullable: true })
  pnlDiffFromDb: number; // bybitNetPnl - realizedPnl (signal of bug, target zero)

  @Column({ type: 'timestamptz', nullable: true })
  pnlReconciledAt: Date;
}
