import { Entity, PrimaryColumn, Column, Index } from 'typeorm';
import { bigintToNumber } from '../../common/typeorm/bigint.transformer';

/**
 * Corrida de backtest REGISTRADA (reproducible): parámetros completos + paramsHash + comando exacto +
 * métricas + la serie de sesgo HTF congelada. La registra el CLI (`npm run backtest -- ... --register`);
 * el visor del dashboard solo la LEE. Lección de la revisión 2026-06-10: sin registro del comando, dos
 * corridas "iguales" pueden usar datasets distintos sin que nadie lo note (el caso --limit).
 */
@Index('idx_backtest_runs_createdat', ['createdAt'])
@Entity('backtest_runs')
export class BacktestRunEntity {
  @PrimaryColumn({ type: 'varchar', length: 40 })
  id: string; // bt_<epoch ms> — legible y único por registro

  @Column({ type: 'bigint', transformer: bigintToNumber })
  createdAt: number;

  @Column({ type: 'varchar', length: 20 })
  symbol: string;

  @Column({ type: 'varchar', length: 5 })
  tf: string;

  @Column({ type: 'bigint', transformer: bigintToNumber, nullable: true })
  fromTime: number | null; // openTime de la primera vela usada

  @Column({ type: 'bigint', transformer: bigintToNumber, nullable: true })
  toTime: number | null; // openTime de la última vela usada

  @Column({ type: 'int' })
  candleCount: number;

  @Column({ type: 'varchar', length: 40 })
  engineVersion: string; // git short-hash del motor al correr ('unknown' si no hay git)

  @Column({ type: 'varchar', length: 16 })
  paramsHash: string; // sha256 (12 hex) de los parámetros canónicos

  @Column({ type: 'text' })
  command: string; // comando COMPLETO reproducible (flags resueltos, sin defaults implícitos)

  @Column({ type: 'jsonb' })
  params: Record<string, unknown>; // signalConfig + simConfig + htf, resueltos

  @Column({ type: 'jsonb' })
  metrics: Record<string, unknown>; // BacktestMetrics de la corrida

  @Column({ type: 'jsonb', nullable: true })
  biasPoints: { time: number; bias: string }[] | null; // serie HTF congelada (replay del porqué causal)

  @Column({ type: 'text', default: '' })
  note: string;
}
