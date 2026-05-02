import { Module, type Provider } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BinanceModule } from '../binance/binance.module';
import { BinanceExchangeAdapter } from '../binance/adapters/binance-exchange.adapter';
import { BinanceMarketDataAdapter } from '../binance/adapters/binance-market-data.adapter';
import { BinanceUserDataAdapter } from '../binance/adapters/binance-user-data.adapter';
import { BinanceExchangeInfoAdapter } from '../binance/adapters/binance-exchange-info.adapter';
import { BybitModule } from '../bybit/bybit.module';
import { BybitRestService } from '../bybit/bybit-rest.service';
import { BybitMarketWsService } from '../bybit/bybit-market-ws.service';
import { BybitUserWsService } from '../bybit/bybit-user-ws.service';
import { BybitExchangeInfoService } from '../bybit/bybit-exchange-info.service';
import {
  IExchangeRest,
  IMarketDataPort,
  IUserDataPort,
  IExchangeInfoService,
  type ExchangeProvider,
} from './interfaces/exchange.interfaces';

/**
 * Exchange module — single source of truth for which exchange the bot talks
 * to at runtime. Resolution is driven by EXCHANGE_PROVIDER env var.
 *
 *   EXCHANGE_PROVIDER=binance  → Binance adapters
 *   EXCHANGE_PROVIDER=bybit    → Bybit services (already implement the ports)
 *
 * If the env var is missing, we throw at module init. Falling silently to a
 * default could re-trigger the soft-ban loop the bot is recovering from.
 */
function pickProvider(config: ConfigService): ExchangeProvider {
  const raw = config.get<string>('EXCHANGE_PROVIDER');
  if (!raw) {
    throw new Error(
      'EXCHANGE_PROVIDER env var is required. Set to "binance" or "bybit".',
    );
  }
  const normalized = raw.toLowerCase().trim();
  if (normalized !== 'binance' && normalized !== 'bybit') {
    throw new Error(
      `EXCHANGE_PROVIDER must be "binance" or "bybit", got "${raw}".`,
    );
  }
  return normalized;
}

const exchangeRestProvider: Provider = {
  provide: IExchangeRest,
  useFactory: (
    config: ConfigService,
    binance: BinanceExchangeAdapter,
    bybit: BybitRestService,
  ): IExchangeRest => {
    return pickProvider(config) === 'binance' ? binance : bybit;
  },
  inject: [ConfigService, BinanceExchangeAdapter, BybitRestService],
};

const marketDataProvider: Provider = {
  provide: IMarketDataPort,
  useFactory: (
    config: ConfigService,
    binance: BinanceMarketDataAdapter,
    bybit: BybitMarketWsService,
  ): IMarketDataPort => {
    return pickProvider(config) === 'binance' ? binance : bybit;
  },
  inject: [ConfigService, BinanceMarketDataAdapter, BybitMarketWsService],
};

const userDataProvider: Provider = {
  provide: IUserDataPort,
  useFactory: (
    config: ConfigService,
    binance: BinanceUserDataAdapter,
    bybit: BybitUserWsService,
  ): IUserDataPort => {
    return pickProvider(config) === 'binance' ? binance : bybit;
  },
  inject: [ConfigService, BinanceUserDataAdapter, BybitUserWsService],
};

const exchangeInfoProvider: Provider = {
  provide: IExchangeInfoService,
  useFactory: (
    config: ConfigService,
    binance: BinanceExchangeInfoAdapter,
    bybit: BybitExchangeInfoService,
  ): IExchangeInfoService => {
    return pickProvider(config) === 'binance' ? binance : bybit;
  },
  inject: [ConfigService, BinanceExchangeInfoAdapter, BybitExchangeInfoService],
};

@Module({
  imports: [ConfigModule, BinanceModule, BybitModule],
  providers: [
    exchangeRestProvider,
    marketDataProvider,
    userDataProvider,
    exchangeInfoProvider,
  ],
  exports: [
    IExchangeRest,
    IMarketDataPort,
    IUserDataPort,
    IExchangeInfoService,
  ],
})
export class ExchangeModule {}
