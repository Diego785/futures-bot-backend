import { Entity, PrimaryColumn, Column, Index } from 'typeorm';

// bigint en Postgres vuelve como string en TypeORM (para no perder precisión).
// openTime/closeTime son epoch ms (~1.7e12), muy por debajo de Number.MAX_SAFE_INTEGER,
// así que los convertimos a number al leer para respetar el modelo canónico (API-CONTRACT).
const bigintToNumber = {
  to: (v?: number): number | undefined => v,
  from: (v?: string | null): number | null | undefined =>
    v == null ? (v as null | undefined) : Number(v),
};

/**
 * Modelo canónico de vela persistido (ver docs/API-CONTRACT.md).
 * PK compuesta (symbol, tf, openTime) — el upsert idempotente depende de ella.
 * Índice (symbol, tf, closeTime) para consultas por rango temporal.
 */
@Index('idx_candles_symbol_tf_closetime', ['symbol', 'tf', 'closeTime'])
@Entity('candles')
export class CandleEntity {
  @PrimaryColumn({ type: 'varchar', length: 20 })
  symbol: string;

  @PrimaryColumn({ type: 'varchar', length: 5 })
  tf: string;

  @PrimaryColumn({ type: 'bigint', transformer: bigintToNumber })
  openTime: number; // epoch ms UTC

  @Column({ type: 'bigint', transformer: bigintToNumber })
  closeTime: number; // epoch ms UTC — la causalidad se ancla aquí

  @Column({ type: 'double precision' })
  open: number;

  @Column({ type: 'double precision' })
  high: number;

  @Column({ type: 'double precision' })
  low: number;

  @Column({ type: 'double precision' })
  close: number;

  @Column({ type: 'double precision' })
  volume: number;

  @Column({ type: 'double precision', nullable: true })
  quoteVolume: number | null;

  @Column({ type: 'int', nullable: true })
  trades: number | null;

  @Column({ type: 'boolean', default: true })
  isClosed: boolean;
}
