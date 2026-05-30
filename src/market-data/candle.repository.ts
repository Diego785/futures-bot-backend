import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CandleEntity } from './entities/candle.entity';
import type { CandleRow } from './candle.mapper';

/**
 * Acceso de persistencia a velas. El upsert es idempotente por la PK
 * (symbol, tf, openTime): el ingest live nunca duplica una vela ya guardada por
 * el backfill, y un reconnect que re-emita la última vela es no-op (ver Fase 3/4).
 */
@Injectable()
export class CandleRepository {
  constructor(
    @InjectRepository(CandleEntity)
    private readonly repo: Repository<CandleEntity>,
  ) {}

  /** Upsert idempotente por (symbol, tf, openTime). Inserta o actualiza, nunca duplica. */
  async upsertMany(rows: CandleRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.repo.upsert(rows, {
      conflictPaths: ['symbol', 'tf', 'openTime'],
      skipUpdateIfNoValuesChanged: true,
    });
  }

  /** Cuántas velas hay para (symbol, tf). Útil para validación/diagnóstico. */
  async count(symbol: string, tf: string): Promise<number> {
    return this.repo.countBy({ symbol, tf });
  }

  /** openTime de la última vela persistida de (symbol, tf), o null si no hay ninguna.
   *  Punto de partida de la reconciliación al reconectar. */
  async findLastOpenTime(symbol: string, tf: string): Promise<number | null> {
    const row = await this.repo.findOne({
      where: { symbol, tf },
      order: { openTime: 'DESC' },
    });
    return row ? row.openTime : null;
  }

  /**
   * Lectura paginada de velas por (symbol, tf), siempre devueltas en orden openTime ascendente.
   *
   * Modos:
   *  - Rango explícito (from/to/cursor): ascendente desde el inicio del rango. Para consultas
   *    puntuales y paginación hacia adelante.
   *  - Por defecto (sin rango): las `limit` velas MÁS RECIENTES (lo que una gráfica quiere ver
   *    al abrir).
   *  - `before`: las `limit` velas más recientes ANTERIORES a `before` (cargar más historial
   *    hacia atrás). El front pasa before = openTime de su vela más antigua cargada.
   */
  async findCandles(params: {
    symbol: string;
    tf: string;
    from?: number;
    to?: number;
    cursor?: number;
    before?: number;
    limit: number;
  }): Promise<CandleEntity[]> {
    const { symbol, tf, from, to, cursor, before, limit } = params;
    const qb = this.repo
      .createQueryBuilder('c')
      .where('c.symbol = :symbol', { symbol })
      .andWhere('c.tf = :tf', { tf });

    // Rango explícito → ascendente.
    if (from !== undefined || to !== undefined || cursor !== undefined) {
      if (from !== undefined) qb.andWhere('c.openTime >= :from', { from });
      if (to !== undefined) qb.andWhere('c.openTime <= :to', { to });
      if (cursor !== undefined) qb.andWhere('c.openTime > :cursor', { cursor });
      return qb.orderBy('c.openTime', 'ASC').limit(limit).getMany();
    }

    // Más recientes (o más recientes antes de `before`): DESC + limit, reordenadas a ASC.
    if (before !== undefined) qb.andWhere('c.openTime < :before', { before });
    const rows = await qb.orderBy('c.openTime', 'DESC').limit(limit).getMany();
    return rows.reverse();
  }
}
