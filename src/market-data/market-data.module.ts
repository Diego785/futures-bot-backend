import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExchangeModule } from '../exchange/exchange.module';
import { CandleEntity } from './entities/candle.entity';
import { CandleRepository } from './candle.repository';
import { BackfillService } from './backfill.service';

/**
 * Market Data (Fase 3). Persistencia de velas (entidad + repositorio) + backfill REST.
 * Ingest WS live (Commit 4) y endpoint /api/candles (Commit 5) se añaden después.
 * Requiere TypeORM cargado (DB_ENABLED=true en app.module).
 */
@Module({
  imports: [TypeOrmModule.forFeature([CandleEntity]), ExchangeModule],
  providers: [CandleRepository, BackfillService],
  exports: [CandleRepository, BackfillService],
})
export class MarketDataModule {}
