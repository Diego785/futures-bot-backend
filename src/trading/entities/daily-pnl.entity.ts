import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  UpdateDateColumn,
} from 'typeorm';

@Entity('daily_pnl')
export class DailyPnl {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'date', unique: true })
  date: string; // YYYY-MM-DD

  @Column({ type: 'decimal', precision: 18, scale: 8, default: 0 })
  realizedPnl: number;

  @Column({ type: 'int', default: 0 })
  tradesCount: number;

  @Column({ type: 'int', default: 0 })
  winsCount: number;

  @Column({ type: 'int', default: 0 })
  lossesCount: number;

  @UpdateDateColumn()
  updatedAt: Date;
}
