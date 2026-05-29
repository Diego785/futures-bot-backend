import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CandleEntity } from './entities/candle.entity';
import { CandleRepository } from './candle.repository';

/**
 * Market Data (Fase 3). De momento solo persistencia de velas (entidad + repositorio).
 * Backfill REST (Commit 3), ingest WS live (Commit 4) y endpoint /api/candles (Commit 5)
 * se añaden después. Requiere que TypeORM esté cargado (DB_ENABLED=true en app.module).
 */
@Module({
  imports: [TypeOrmModule.forFeature([CandleEntity])],
  providers: [CandleRepository],
  exports: [CandleRepository],
})
export class MarketDataModule {}
