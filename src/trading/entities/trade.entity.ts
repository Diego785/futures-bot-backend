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
  status: string; // OPEN | CLOSED_TP | CLOSED_SL | CLOSED_MANUAL | CLOSED_KILL_SWITCH

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
}
