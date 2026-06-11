import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { BacktestRunEntity } from './entities/backtest-run.entity';
import { BacktestSignalEntity } from './entities/backtest-signal.entity';
import type { BacktestRunRow, BacktestSignalRow } from './register.mapper';

/**
 * Persistencia de corridas registradas. La ESCRIBE solo el CLI (`--register`); el visor del
 * dashboard la LEE. Regla Cero intacta: esto escribe en NUESTRA DB, jamás toca el exchange.
 */
@Injectable()
export class BacktestRunRepository {
  constructor(
    @InjectRepository(BacktestRunEntity)
    private readonly runs: Repository<BacktestRunEntity>,
    @InjectRepository(BacktestSignalEntity)
    private readonly signals: Repository<BacktestSignalEntity>,
  ) {}

  /** Inserta la corrida y TODAS sus señales en una transacción (en lotes, por el límite de
   *  parámetros de Postgres). Si algo falla no queda una corrida a medias. */
  async saveRun(run: BacktestRunRow, signalRows: BacktestSignalRow[]): Promise<void> {
    await this.runs.manager.transaction(async (em) => {
      // Cast: QueryDeepPartialEntity no acepta jsonb tipado como Record<string, unknown> (limitación
      // de tipos de TypeORM, no de datos). La fila coincide 1:1 con la entity.
      await em.getRepository(BacktestRunEntity).insert(run as QueryDeepPartialEntity<BacktestRunEntity>);
      const repo = em.getRepository(BacktestSignalEntity);
      for (let i = 0; i < signalRows.length; i += 500) {
        await repo.insert(signalRows.slice(i, i + 500));
      }
    });
  }

  /** Corridas registradas, más recientes primero. Sin `biasPoints` (pesado e innecesario en lista). */
  async listRuns(limit = 100): Promise<Partial<BacktestRunEntity>[]> {
    return this.runs.find({
      select: {
        id: true,
        createdAt: true,
        symbol: true,
        tf: true,
        fromTime: true,
        toTime: true,
        candleCount: true,
        engineVersion: true,
        paramsHash: true,
        command: true,
        params: true,
        metrics: true,
        note: true,
      },
      order: { createdAt: 'DESC' },
      take: limit,
    });
  }

  async getRun(id: string): Promise<BacktestRunEntity | null> {
    return this.runs.findOneBy({ id });
  }

  /** Señales de una corrida en orden temporal (el replay las consume tal cual). */
  async getSignals(runId: string): Promise<BacktestSignalEntity[]> {
    return this.signals.find({ where: { runId }, order: { signalBarTime: 'ASC' } });
  }
}
