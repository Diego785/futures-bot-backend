import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ExchangeModule } from '../exchange/exchange.module';
import { MarketDataModule } from '../market-data/market-data.module';
import { PaperTradeEntity } from './entities/paper-trade.entity';
import { PaperTradeRepository } from './paper-trade.repository';
import { PaperTradingService } from './paper-trading.service';
import { PaperTradingGateway } from './paper-trading.gateway';
import { PaperTradingController } from './paper-trading.controller';

/**
 * PAPER-TRADING (gate #7) — shadow READ-ONLY del candidato congelado (Regla Cero: ningún code path
 * de este módulo toca el write-API; el test de invarianza lo verifica estructuralmente).
 * Solo se carga con DB_ENABLED=true (app.module); el motor solo ARRANCA con PAPER_TRADING=true.
 */
@Module({
  imports: [TypeOrmModule.forFeature([PaperTradeEntity]), MarketDataModule, ExchangeModule],
  controllers: [PaperTradingController],
  providers: [PaperTradeRepository, PaperTradingService, PaperTradingGateway],
})
export class PaperTradingModule {}
