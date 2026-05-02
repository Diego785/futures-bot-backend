import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { BybitRestService } from './bybit-rest.service';
import { BybitMarketWsService } from './bybit-market-ws.service';
import { BybitUserWsService } from './bybit-user-ws.service';
import { BybitExchangeInfoService } from './bybit-exchange-info.service';

@Module({
  imports: [HttpModule.register({ timeout: 10_000 })],
  providers: [
    BybitRestService,
    BybitMarketWsService,
    BybitUserWsService,
    BybitExchangeInfoService,
  ],
  exports: [
    BybitRestService,
    BybitMarketWsService,
    BybitUserWsService,
    BybitExchangeInfoService,
  ],
})
export class BybitModule {}
