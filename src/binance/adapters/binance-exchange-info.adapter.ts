import { Injectable } from '@nestjs/common';
import { ExchangeInfoService } from '../exchange-info.service';
import {
  IExchangeInfoService,
  type SymbolInfo,
} from '../../exchange/interfaces/exchange.interfaces';
import type { BinanceSymbolInfo } from '../../common/interfaces/binance.interfaces';

@Injectable()
export class BinanceExchangeInfoAdapter extends IExchangeInfoService {
  constructor(private readonly inner: ExchangeInfoService) {
    super();
  }

  refresh(): Promise<void> {
    return this.inner.refresh();
  }

  getSymbolInfo(symbol: string): SymbolInfo | undefined {
    const raw = this.inner.getSymbolInfo(symbol);
    if (!raw) return undefined;
    return mapSymbolInfo(raw);
  }

  getTickSize(symbol: string): string {
    return this.inner.getTickSize(symbol);
  }

  getStepSize(symbol: string): string {
    return this.inner.getStepSize(symbol);
  }

  getMinNotional(symbol: string): number {
    return this.inner.getMinNotional(symbol);
  }

  getPricePrecision(symbol: string): number {
    return this.inner.getPricePrecision(symbol);
  }

  getQuantityPrecision(symbol: string): number {
    return this.inner.getQuantityPrecision(symbol);
  }
}

function mapSymbolInfo(raw: BinanceSymbolInfo): SymbolInfo {
  const priceFilter = raw.filters.find((f) => f.filterType === 'PRICE_FILTER');
  const lotFilter = raw.filters.find((f) => f.filterType === 'LOT_SIZE');
  const notionalFilter = raw.filters.find(
    (f) => f.filterType === 'MIN_NOTIONAL',
  );
  return {
    symbol: raw.symbol,
    baseAsset: raw.baseAsset,
    quoteAsset: raw.quoteAsset,
    pricePrecision: raw.pricePrecision,
    quantityPrecision: raw.quantityPrecision,
    tickSize: priceFilter?.tickSize ?? '0.01',
    stepSize: lotFilter?.stepSize ?? '0.001',
    minNotional: notionalFilter?.notional
      ? parseFloat(notionalFilter.notional)
      : 5,
    minQty: lotFilter?.minQty ?? '0.001',
    maxQty: lotFilter?.maxQty ?? '1000',
  };
}
