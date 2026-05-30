import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExchangeModule } from '../exchange/exchange.module';
import { CandleEntity } from './entities/candle.entity';
import { CandleRepository } from './candle.repository';
import { BackfillService } from './backfill.service';
import { CandleIngestService } from './candle-ingest.service';
import { MarketDataController } from './market-data.controller';
import { MarketDataGateway } from './market-data.gateway';

/**
 * Market Data (Fase 3). Persistencia de velas (entidad + repositorio) + backfill REST +
 * ingest WS live con reconciliación al reconectar. Endpoint /api/candles (Commit 5) después.
 * Requiere TypeORM cargado (DB_ENABLED=true en app.module). El ingest live solo se conecta
 * al exchange si MARKET_DATA_LIVE=true.
 */
@Module({
  imports: [TypeOrmModule.forFeature([CandleEntity]), ExchangeModule],
  controllers: [MarketDataController],
  providers: [CandleRepository, BackfillService, CandleIngestService, MarketDataGateway],
  exports: [CandleRepository, BackfillService, CandleIngestService],
})
export class MarketDataModule {}
