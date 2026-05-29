import { Injectable, OnModuleDestroy } from '@nestjs/common';
import type { Observable } from 'rxjs';
import { BinanceMarketWsService } from '../binance-market-ws.service';
import {
  IMarketDataPort,
  type ExchangeProvider,
  type CandleEvent,
  type CandleSubscription,
  type PriceTickEvent,
} from '../../exchange/interfaces/exchange.interfaces';

/**
 * Binance adapter implementing the neutral IMarketDataPort.
 * Delegates to BinanceMarketWsService whose subjects already emit
 * shapes compatible with CandleEvent / PriceTickEvent.
 */
@Injectable()
export class BinanceMarketDataAdapter
  extends IMarketDataPort
  implements OnModuleDestroy
{
  readonly provider: ExchangeProvider = 'binance';
  readonly onCandleClose$: Observable<CandleEvent>;
  readonly onPrice$: Observable<PriceTickEvent>;

  constructor(private readonly inner: BinanceMarketWsService) {
    super();
    this.onCandleClose$ = inner.onCandleClose$;
    this.onPrice$ = inner.onPrice$;
  }

  subscribe(symbol: string, interval: string): void {
    this.inner.subscribe(symbol, interval);
  }

  unsubscribe(symbol?: string, interval?: string): void {
    this.inner.unsubscribe(symbol, interval);
  }

  getSubscriptions(): CandleSubscription[] {
    return this.inner.getSubscriptions();
  }

  onModuleDestroy(): void {
    this.inner.unsubscribe();
  }
}
