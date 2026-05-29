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
}
