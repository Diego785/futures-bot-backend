import { Entity, PrimaryColumn, Column, Index } from 'typeorm';

// bigint en Postgres vuelve como string en TypeORM (precisión). epoch ms (~1.7e12) está
// muy por debajo de Number.MAX_SAFE_INTEGER, así que lo convertimos a number al leer.
const bigintToNumber = {
  to: (v?: number | null): number | null | undefined => v,
  from: (v?: string | null): number | null | undefined =>
    v == null ? (v as null | undefined) : Number(v),
};

/**
 * Marca manual del usuario sobre las velas (capa MyManualMarks). NO es una señal del bot
 * ni un objetivo a imitar: es un dato de COMPARACIÓN y validación (ver docs/VISION-V2.md).
 * - OB / FVG: zona (timeStart/timeEnd + priceLow/priceHigh).
 * - Liquidity: nivel (price).
 * - TradePlan: posición (side + entry/stopLoss/takeProfit; rr derivado).
 * Todo anclado a tiempo (epoch ms UTC) y precio, nunca a píxeles.
 */
@Index('idx_manual_marks_symbol_tf', ['symbol', 'tf'])
@Entity('manual_marks')
export class ManualMarkEntity {
  @PrimaryColumn({ type: 'varchar', length: 64 })
  id: string;

  @Column({ type: 'varchar', length: 32, default: 'MyManualMarks' })
  sourceLayer: string;

  @Column({ type: 'varchar', length: 16 })
  kind: string; // OB | FVG | Liquidity | TradePlan

  @Column({ type: 'varchar', length: 20 })
  symbol: string;

  @Column({ type: 'varchar', length: 5 })
  tf: string;

  @Column({ type: 'bigint', nullable: true, transformer: bigintToNumber })
  timeStart: number | null; // epoch ms UTC

  @Column({ type: 'bigint', nullable: true, transformer: bigintToNumber })
  timeEnd: number | null; // epoch ms UTC

  @Column({ type: 'double precision', nullable: true })
  priceLow: number | null;

  @Column({ type: 'double precision', nullable: true })
  priceHigh: number | null;

  @Column({ type: 'double precision', nullable: true })
  price: number | null;

  @Column({ type: 'varchar', length: 5, nullable: true })
  side: string | null; // LONG | SHORT

  @Column({ type: 'double precision', nullable: true })
  entry: number | null;

  @Column({ type: 'double precision', nullable: true })
  stopLoss: number | null;

  @Column({ type: 'double precision', nullable: true })
  takeProfit: number | null;

  @Column({ type: 'double precision', nullable: true })
  rr: number | null; // derivado en el servidor para TradePlan

  @Column({ type: 'text', default: '' })
  note: string;

  @Column({ type: 'bigint', transformer: bigintToNumber })
  createdAt: number; // epoch ms UTC

  @Column({ type: 'bigint', transformer: bigintToNumber })
  updatedAt: number; // epoch ms UTC
}
