import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ManualMarkEntity } from './entities/manual-mark.entity';

/**
 * Persistencia de marcas manuales. Read/write local, sin tocar el exchange ni credenciales.
 * La PK es el id (uuid generado por el cliente o el servidor), así que save() es un upsert
 * idempotente: re-enviar la misma marca (reintento de red) no duplica.
 */
@Injectable()
export class ManualMarkRepository {
  constructor(
    @InjectRepository(ManualMarkEntity)
    private readonly repo: Repository<ManualMarkEntity>,
  ) {}

  /** Marcas de (symbol, tf), en orden de creación. */
  findBySymbolTf(symbol: string, tf: string): Promise<ManualMarkEntity[]> {
    return this.repo.find({ where: { symbol, tf }, order: { createdAt: 'ASC' } });
  }

  findById(id: string): Promise<ManualMarkEntity | null> {
    return this.repo.findOne({ where: { id } });
  }

  save(mark: ManualMarkEntity): Promise<ManualMarkEntity> {
    return this.repo.save(mark);
  }

  async deleteById(id: string): Promise<boolean> {
    const res = await this.repo.delete({ id });
    return (res.affected ?? 0) > 0;
  }
}
