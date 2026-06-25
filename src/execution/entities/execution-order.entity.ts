import { Entity, PrimaryColumn, Column, Index } from 'typeorm';
import { bigintToNumber } from '../../common/typeorm/bigint.transformer';

/**
 * Registro de la EJECUCIÓN REAL (P.5.3): por cada intent `live` del candidato congelado que el bot
 * ejecuta de verdad, su ciclo de vida real (orden límite → fill → SL/TP → cierre) con precios y fees
 * reales. Grano por-intent (espeja `paper_trades` por `intentId` → join 1:1 para comparar real-vs-paper).
 *
 * `testnet` separa las órdenes de la red de pruebas de las reales (NO mezclar en estadísticas).
 * Idempotente por PK (intentId); el executor reescribe la fila en cada transición de estado.
 */
@Index('idx_execution_orders_state', ['state'])
@Index('idx_execution_orders_symbol', ['symbol'])
@Entity('execution_orders')
export class ExecutionOrderEntity {
  @PrimaryColumn({ type: 'varchar', length: 80 })
  intentId: string;

  @Column({ type: 'varchar', length: 20 })
  symbol: string;

  @Column({ type: 'varchar', length: 5 })
  direction: string;

  @Column({ type: 'bigint', transformer: bigintToNumber })
  signalBarTime: number;

  @Column({ type: 'varchar', length: 12 })
  state: string; // PENDING | FILLED | CLOSED | CANCELED

  @Column({ type: 'boolean', default: true })
  testnet: boolean;

  // ── Plan (lo que el bot decidió) ──
  @Column({ type: 'double precision' })
  entry: number; // CE (precio de la límite)

  @Column({ type: 'double precision' })
  stopLoss: number;

  @Column({ type: 'double precision' })
  takeProfit: number;

  @Column({ type: 'double precision', nullable: true })
  cancelBeyond: number | null;

  @Column({ type: 'double precision' })
  quantity: number;

  @Column({ type: 'double precision' })
  notionalUsd: number;

  @Column({ type: 'double precision' })
  riskUsd: number;

  // ── IDs de las órdenes reales (para reconciliación/cancelación) ──
  @Column({ type: 'varchar', length: 40 })
  entryClientId: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  entryOrderId: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  slClientId: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  slAlgoId: string | null;

  @Column({ type: 'varchar', length: 40, nullable: true })
  tpClientId: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  tpAlgoId: string | null;

  // ── Fills reales ──
  @Column({ type: 'bigint', transformer: bigintToNumber, nullable: true })
  entryFillTime: number | null;

  @Column({ type: 'double precision', nullable: true })
  entryFillPrice: number | null;

  @Column({ type: 'double precision', nullable: true })
  entryFeeUsd: number | null;

  @Column({ type: 'boolean', default: false })
  movedToBE: boolean;

  @Column({ type: 'bigint', transformer: bigintToNumber, nullable: true })
  exitTime: number | null;

  @Column({ type: 'double precision', nullable: true })
  exitPrice: number | null;

  @Column({ type: 'double precision', nullable: true })
  exitFeeUsd: number | null;

  @Column({ type: 'varchar', length: 10, nullable: true })
  exitReason: string | null; // TP | SL | BE | MANUAL | KILL

  @Column({ type: 'double precision', nullable: true })
  realizedR: number | null; // R neta realizada (real, neto de fees)

  @Column({ type: 'double precision', nullable: true })
  realizedUsd: number | null;

  @Column({ type: 'varchar', length: 16, nullable: true })
  cancelReason: string | null; // ranAway | killed | reconcile

  @Column({ type: 'varchar', length: 40 })
  engineVersion: string;

  @Column({ type: 'bigint', transformer: bigintToNumber })
  createdAt: number;

  @Column({ type: 'bigint', transformer: bigintToNumber })
  updatedAt: number;
}
