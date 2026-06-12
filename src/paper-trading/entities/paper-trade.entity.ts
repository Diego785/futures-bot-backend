import { Entity, PrimaryColumn, Column, Index } from 'typeorm';
import { bigintToNumber } from '../../common/typeorm/bigint.transformer';

/**
 * Registro MECÁNICO del paper-test (gate #7): cada señal que el candidato CONGELADO genera en vivo,
 * sin filtro humano (PAPER-TEST-SPEC §4 integridad). REGLA CERO: describe lo que el bot HARÍA;
 * jamás toca órdenes. Idempotente por PK (intentId) + único por (symbol, signalBarTime, direction).
 * Sobrevive reinicios (la rehidratación re-deriva y el upsert absorbe lo ya registrado).
 */
@Index('uq_paper_trades_sym_time_dir', ['symbol', 'signalBarTime', 'direction'], { unique: true })
@Index('idx_paper_trades_state', ['state'])
@Entity('paper_trades')
export class PaperTradeEntity {
  @PrimaryColumn({ type: 'varchar', length: 80 })
  intentId: string;

  @Column({ type: 'varchar', length: 20 })
  symbol: string;

  @Column({ type: 'varchar', length: 5 })
  tf: string;

  @Column({ type: 'varchar', length: 5 })
  direction: string;

  @Column({ type: 'bigint', transformer: bigintToNumber })
  signalBarTime: number;

  @Column({ type: 'varchar', length: 10 })
  state: string; // PENDING | FILLED | CLOSED

  @Column({ type: 'double precision' })
  entry: number;

  @Column({ type: 'double precision' })
  stopLoss: number;

  @Column({ type: 'double precision' })
  takeProfit: number;

  @Column({ type: 'varchar', length: 20, nullable: true })
  tpSource: string | null;

  @Column({ type: 'double precision', nullable: true })
  invalidationPrice: number | null;

  @Column({ type: 'double precision', nullable: true })
  cancelBeyond: number | null;

  @Column({ type: 'double precision', nullable: true })
  zoneLow: number | null;

  @Column({ type: 'double precision', nullable: true })
  zoneHigh: number | null;

  @Column({ type: 'double precision', nullable: true })
  sweptLevel: number | null;

  @Column({ type: 'double precision', nullable: true })
  wickExtreme: number | null;

  @Column({ type: 'bigint', transformer: bigintToNumber, nullable: true })
  sweptSwingTime: number | null;

  @Column({ type: 'bigint', transformer: bigintToNumber, nullable: true })
  entryTime: number | null;

  @Column({ type: 'double precision', nullable: true })
  entryPrice: number | null;

  @Column({ type: 'bigint', transformer: bigintToNumber, nullable: true })
  exitTime: number | null;

  @Column({ type: 'double precision', nullable: true })
  exitPrice: number | null;

  @Column({ type: 'varchar', length: 10, nullable: true })
  exitReason: string | null;

  @Column({ type: 'double precision', nullable: true })
  grossR: number | null;

  @Column({ type: 'double precision', nullable: true })
  costR: number | null;

  @Column({ type: 'double precision', nullable: true })
  rMultiple: number | null;

  @Column({ type: 'boolean', nullable: true })
  movedToBE: boolean | null;

  @Column({ type: 'int', nullable: true })
  barsToFill: number | null;

  @Column({ type: 'int', nullable: true })
  barsHeld: number | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  cancelReason: string | null;

  // touched-vs-crossed (gate #7): penetración de la mecha más allá del límite/TP, en precio.
  @Column({ type: 'double precision', nullable: true })
  entryPenetration: number | null;

  @Column({ type: 'double precision', nullable: true })
  tpPenetration: number | null;

  @Column({ type: 'varchar', length: 40 })
  engineVersion: string;

  @Column({ type: 'varchar', length: 16 })
  paramsHash: string;

  @Column({ type: 'bigint', transformer: bigintToNumber })
  createdAt: number;

  @Column({ type: 'bigint', transformer: bigintToNumber })
  updatedAt: number;
}
