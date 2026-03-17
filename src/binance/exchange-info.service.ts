import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { BinanceRestService } from './binance-rest.service';
import type { BinanceSymbolInfo } from '../common/interfaces/binance.interfaces';

@Injectable()
export class ExchangeInfoService implements OnModuleInit {
  private readonly logger = new Logger(ExchangeInfoService.name);
  private symbolMap = new Map<string, BinanceSymbolInfo>();

  constructor(private readonly binanceRest: BinanceRestService) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const info = await this.binanceRest.getExchangeInfo();
        this.symbolMap.clear();
        for (const symbol of info.symbols) {
          this.symbolMap.set(symbol.symbol, symbol);
        }
        this.logger.log(
          `ExchangeInfo cached: ${this.symbolMap.size} symbols loaded`,
        );
        return;
      } catch (error) {
        this.logger.warn(
          `Failed to fetch exchangeInfo (attempt ${attempt}/${maxRetries})`,
        );
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 2000 * attempt));
        } else {
          this.logger.error(
            'ExchangeInfo unavailable after retries — using defaults',
          );
        }
      }
    }
  }

  getSymbolInfo(symbol: string): BinanceSymbolInfo | undefined {
    return this.symbolMap.get(symbol);
  }

  getTickSize(symbol: string): string {
    const info = this.symbolMap.get(symbol);
    const filter = info?.filters.find((f) => f.filterType === 'PRICE_FILTER');
    return filter?.tickSize ?? '0.01';
  }

  getStepSize(symbol: string): string {
    const info = this.symbolMap.get(symbol);
    const filter = info?.filters.find((f) => f.filterType === 'LOT_SIZE');
    return filter?.stepSize ?? '0.001';
  }

  getMinNotional(symbol: string): number {
    const info = this.symbolMap.get(symbol);
    const filter = info?.filters.find(
      (f) => f.filterType === 'MIN_NOTIONAL',
    );
    return filter?.notional ? parseFloat(filter.notional) : 5;
  }

  getPricePrecision(symbol: string): number {
    return this.symbolMap.get(symbol)?.pricePrecision ?? 2;
  }

  getQuantityPrecision(symbol: string): number {
    return this.symbolMap.get(symbol)?.quantityPrecision ?? 3;
  }
}
