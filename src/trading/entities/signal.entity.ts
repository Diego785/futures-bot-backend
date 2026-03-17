import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  OneToMany,
} from 'typeorm';
import { Order } from './order.entity';

@Entity('signals')
export class Signal {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  symbol: string;

  @Column({ type: 'varchar', length: 10 })
  action: string; // LONG | SHORT | HOLD

  @Column({ type: 'decimal', precision: 5, scale: 4 })
  confidence: number;

  @Column({ type: 'text' })
  reasoning: string;

  @Column({ type: 'decimal', precision: 18, scale: 8 })
  entryPrice: number;

  @Column({ type: 'decimal', precision: 18, scale: 8, nullable: true })
  stopLoss: number;

  @Column({ type: 'decimal', precision: 18, scale: 8, nullable: true })
  takeProfit: number;

  @Column({ type: 'decimal', precision: 18, scale: 8 })
  atr: number;

  @Column({ type: 'decimal', precision: 8, scale: 2 })
  rsi: number;

  @Column({ type: 'varchar', length: 20, default: 'PENDING' })
  status: string; // PENDING | APPROVED | REJECTED | EXECUTED

  @Column({ type: 'text', nullable: true })
  rejectionReason: string;

  @CreateDateColumn()
  createdAt: Date;

  @OneToMany(() => Order, (order) => order.signal)
  orders: Order[];
}
