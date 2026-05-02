import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { BinanceRestService } from './binance-rest.service';
import { BinanceMarketWsService } from './binance-market-ws.service';
import { BinanceUserWsService } from './binance-user-ws.service';
import { ExchangeInfoService } from './exchange-info.service';
import { BinanceExchangeAdapter } from './adapters/binance-exchange.adapter';
import { BinanceMarketDataAdapter } from './adapters/binance-market-data.adapter';
import { BinanceUserDataAdapter } from './adapters/binance-user-data.adapter';
import { BinanceExchangeInfoAdapter } from './adapters/binance-exchange-info.adapter';

@Module({
  imports: [HttpModule.register({ timeout: 10_000 })],
  providers: [
    // Low-level Binance clients (kept for adapters and any direct consumers
    // that haven't been refactored yet)
    BinanceRestService,
    BinanceMarketWsService,
    BinanceUserWsService,
    ExchangeInfoService,
    // Neutral-interface adapters (preferred dependency point going forward)
    BinanceExchangeAdapter,
    BinanceMarketDataAdapter,
    BinanceUserDataAdapter,
    BinanceExchangeInfoAdapter,
  ],
  exports: [
    BinanceRestService,
    BinanceMarketWsService,
    BinanceUserWsService,
    ExchangeInfoService,
    BinanceExchangeAdapter,
    BinanceMarketDataAdapter,
    BinanceUserDataAdapter,
    BinanceExchangeInfoAdapter,
  ],
})
export class BinanceModule {}
