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
   * Lectura paginada de velas por (symbol, tf), ordenadas por openTime ascendente.
   * Filtros opcionales: rango [from, to] y cursor (openTime exclusivo) para paginar.
   */
  async findCandles(params: {
    symbol: string;
    tf: string;
    from?: number;
    to?: number;
    cursor?: number;
    limit: number;
  }): Promise<CandleEntity[]> {
    const { symbol, tf, from, to, cursor, limit } = params;
    const qb = this.repo
      .createQueryBuilder('c')
      .where('c.symbol = :symbol', { symbol })
      .andWhere('c.tf = :tf', { tf });
    if (from !== undefined) qb.andWhere('c.openTime >= :from', { from });
    if (to !== undefined) qb.andWhere('c.openTime <= :to', { to });
    if (cursor !== undefined) qb.andWhere('c.openTime > :cursor', { cursor });
    return qb.orderBy('c.openTime', 'ASC').limit(limit).getMany();
  }
}
