import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { BinanceRestService } from './binance-rest.service';
import { BinanceMarketWsService } from './binance-market-ws.service';
import { BinanceUserWsService } from './binance-user-ws.service';
import { ExchangeInfoService } from './exchange-info.service';

@Module({
  imports: [HttpModule.register({ timeout: 10_000 })],
  providers: [
    BinanceRestService,
    BinanceMarketWsService,
    BinanceUserWsService,
    ExchangeInfoService,
  ],
  exports: [
    BinanceRestService,
    BinanceMarketWsService,
    BinanceUserWsService,
    ExchangeInfoService,
  ],
})
export class BinanceModule {}
