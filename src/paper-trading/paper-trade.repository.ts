import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PaperTradeEntity } from './entities/paper-trade.entity';
import type { PaperTradeRow } from './paper-row.mapper';

/**
 * Persistencia del registro mecánico del paper-test. Upsert idempotente por PK (intentId):
 * la rehidratación re-deriva señales ya registradas y esto las absorbe sin duplicar.
 * REGLA CERO: escribe en NUESTRA DB, jamás en el exchange.
 */
@Injectable()
export class PaperTradeRepository {
  constructor(
    @InjectRepository(PaperTradeEntity)
    private readonly repo: Repository<PaperTradeEntity>,
  ) {}

  async upsertMany(rows: PaperTradeRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.repo.upsert(rows, {
      conflictPaths: ['intentId'],
      skipUpdateIfNoValuesChanged: true,
    });
  }

  /** Posiciones vivas (PENDING/FILLED) — el estado a reconciliar al rehidratar. */
  async findOpen(): Promise<PaperTradeEntity[]> {
    return this.repo.find({ where: [{ state: 'PENDING' }, { state: 'FILLED' }], order: { signalBarTime: 'ASC' } });
  }

  /** Historial completo (más recientes primero). */
  async findAll(limit = 1000): Promise<PaperTradeEntity[]> {
    return this.repo.find({ order: { signalBarTime: 'DESC' }, take: limit });
  }

  /** La señal viva más vieja por símbolo (límite del recorte de ventana al rehidratar). */
  async oldestOpenSignalTime(symbol: string): Promise<number | null> {
    const row = await this.repo.findOne({
      where: [
        { symbol, state: 'PENDING' },
        { symbol, state: 'FILLED' },
      ],
      order: { signalBarTime: 'ASC' },
    });
    return row ? row.signalBarTime : null;
  }
}
