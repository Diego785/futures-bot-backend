import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ExecutionOrderEntity } from './entities/execution-order.entity';

export type ExecutionOrderRow = Partial<ExecutionOrderEntity> & { intentId: string };

/**
 * Persistencia de la ejecución real (P.5.3). Upsert idempotente por PK (intentId): el executor
 * reescribe la fila en cada transición (PENDING → FILLED → CLOSED/CANCELED). Sobrevive reinicios →
 * base de la reconciliación. NUESTRA DB; las órdenes reales van al exchange por OrderExecutorService.
 */
@Injectable()
export class ExecutionOrderRepository {
  constructor(
    @InjectRepository(ExecutionOrderEntity)
    private readonly repo: Repository<ExecutionOrderEntity>,
  ) {}

  async upsert(row: ExecutionOrderRow): Promise<void> {
    await this.repo.upsert(row, {
      conflictPaths: ['intentId'],
      skipUpdateIfNoValuesChanged: true,
    });
  }

  /** Intents vivos (límite resting o posición abierta) — lo que se reconcilia al arrancar. */
  findOpen(): Promise<ExecutionOrderEntity[]> {
    return this.repo.find({
      where: [{ state: 'PENDING' }, { state: 'FILLED' }],
      order: { signalBarTime: 'ASC' },
    });
  }

  findByIntentId(intentId: string): Promise<ExecutionOrderEntity | null> {
    return this.repo.findOne({ where: { intentId } });
  }

  /** Cierres con R realizada del MISMO entorno (testnet/real) — re-siembra el risk-guard tras reinicio. */
  findClosedRealized(testnet: boolean): Promise<ExecutionOrderEntity[]> {
    return this.repo.find({ where: { state: 'CLOSED', testnet }, order: { exitTime: 'ASC' } });
  }

  findAll(limit = 1000): Promise<ExecutionOrderEntity[]> {
    return this.repo.find({ order: { signalBarTime: 'DESC' }, take: limit });
  }
}
