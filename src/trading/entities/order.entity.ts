import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
} from 'typeorm';
import { Signal } from './signal.entity';
import { Trade } from './trade.entity';

@Entity('orders')
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  clientOrderId: string;

  @Column({ type: 'bigint', nullable: true })
  binanceOrderId: number;

  @Column()
  symbol: string;

  @Column({ type: 'varchar', length: 4 })
  side: string; // BUY | SELL

  @Column({ type: 'varchar', length: 30 })
  type: string; // MARKET | LIMIT | STOP_MARKET | TAKE_PROFIT_MARKET

  @Column({ type: 'decimal', precision: 18, scale: 8, nullable: true })
  price: number;

  @Column({ type: 'decimal', precision: 18, scale: 8, nullable: true })
  stopPrice: number;

  @Column({ type: 'decimal', precision: 18, scale: 8 })
  quantity: number;

  @Column({ type: 'decimal', precision: 18, scale: 8, default: 0 })
  executedQty: number;

  @Column({ type: 'decimal', precision: 18, scale: 8, nullable: true })
  avgPrice: number;

  @Column({ type: 'varchar', length: 20, default: 'PENDING' })
  status: string; // PENDING | NEW | PARTIALLY_FILLED | FILLED | CANCELED | EXPIRED | REJECTED

  @Column({ type: 'varchar', length: 15, default: 'ENTRY' })
  purpose: string; // ENTRY | STOP_LOSS | TAKE_PROFIT | CLOSE

  @ManyToOne(() => Signal, (signal) => signal.orders, { nullable: true })
  signal: Signal;

  @Column({ nullable: true })
  signalId: string;

  @ManyToOne(() => Trade, (trade) => trade.orders, { nullable: true })
  trade: Trade;

  @Column({ nullable: true })
  tradeId: string;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;
}
