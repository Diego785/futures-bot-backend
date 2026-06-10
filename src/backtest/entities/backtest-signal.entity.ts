import { Entity, PrimaryColumn, Column, Index } from 'typeorm';
import { bigintToNumber } from '../../common/typeorm/bigint.transformer';

// Embudo completo de la señal registrada: descartada por un filtro (rejected), emitida pero cancelada
// sin fill (cancelled), nunca llenó (expired) o llenada y resuelta (filled).
export type SignalOutcome = 'rejected' | 'cancelled' | 'expired' | 'filled';

/**
 * Una señal de una corrida registrada — el EMBUDO COMPLETO del candidato, no solo los trades:
 * el visor dibuja también el porqué-no (rejects con razón) y las canceladas, que es la mitad de la
 * auditoría visual. Campos de niveles/desenlace nullable: un reject no tiene entry/SL/TP.
 */
@Index('idx_backtest_signals_run_time', ['runId', 'signalBarTime'])
@Entity('backtest_signals')
export class BacktestSignalEntity {
  @PrimaryColumn({ type: 'varchar', length: 40 })
  runId: string;

  @PrimaryColumn({ type: 'varchar', length: 80 })
  intentId: string;

  @Column({ type: 'varchar', length: 5 })
  direction: string; // LONG | SHORT

  @Column({ type: 'bigint', transformer: bigintToNumber })
  signalBarTime: number; // openTime de la vela cuyo cierre generó (o descartó) la señal

  @Column({ type: 'varchar', length: 10 })
  outcome: SignalOutcome;

  @Column({ type: 'varchar', length: 16, nullable: true })
  reason: string | null; // reject: badZone/minStop/minRr/htfBias · cancelled/expired: ranAway/invalidated/maxWaitFill/noFill/...

  // Zona causal (sweep o OB). Presente en TODAS (rejects incluidos) — es lo que se dibuja.
  @Column({ type: 'double precision', nullable: true })
  zoneLow: number | null;

  @Column({ type: 'double precision', nullable: true })
  zoneHigh: number | null;

  // Contexto del gatillo C (null en A/B): qué liquidez se barrió.
  @Column({ type: 'double precision', nullable: true })
  sweptLevel: number | null;

  @Column({ type: 'double precision', nullable: true })
  wickExtreme: number | null;

  @Column({ type: 'bigint', transformer: bigintToNumber, nullable: true })
  sweptSwingTime: number | null;

  // Niveles del intent emitido (null en rejects).
  @Column({ type: 'double precision', nullable: true })
  entry: number | null;

  @Column({ type: 'double precision', nullable: true })
  stopLoss: number | null;

  @Column({ type: 'double precision', nullable: true })
  takeProfit: number | null;

  @Column({ type: 'double precision', nullable: true })
  invalidationPrice: number | null;

  @Column({ type: 'double precision', nullable: true })
  cancelBeyond: number | null;

  // Desenlace simulado (solo filled).
  @Column({ type: 'bigint', transformer: bigintToNumber, nullable: true })
  entryTime: number | null;

  @Column({ type: 'double precision', nullable: true })
  entryPrice: number | null;

  @Column({ type: 'bigint', transformer: bigintToNumber, nullable: true })
  exitTime: number | null;

  @Column({ type: 'double precision', nullable: true })
  exitPrice: number | null;

  @Column({ type: 'varchar', length: 10, nullable: true })
  exitReason: string | null; // SL/TP/BE/maxHold/endOfData

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
}
