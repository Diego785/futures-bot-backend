import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BybitRestService } from './bybit-rest.service';
import {
  IExchangeInfoService,
  type SymbolInfo,
} from '../exchange/interfaces/exchange.interfaces';

@Injectable()
export class BybitExchangeInfoService
  extends IExchangeInfoService
  implements OnModuleInit
{
  private readonly logger = new Logger(BybitExchangeInfoService.name);
  private symbolMap = new Map<string, SymbolInfo>();

  constructor(
    private readonly rest: BybitRestService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    if (this.config.get<string>('EXCHANGE_PROVIDER') !== 'bybit') return;
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const maxRetries = 3;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const info = await this.rest.getExchangeInfo();
        this.symbolMap.clear();
        for (const s of info.symbols) {
          this.symbolMap.set(s.symbol, s);
        }
        this.logger.log(
          `Bybit ExchangeInfo cached: ${this.symbolMap.size} symbols`,
        );
        return;
      } catch {
        this.logger.warn(
          `Failed to fetch Bybit instruments-info (attempt ${attempt}/${maxRetries})`,
        );
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, 2000 * attempt));
        }
      }
    }
  }

  getSymbolInfo(symbol: string): SymbolInfo | undefined {
    return this.symbolMap.get(symbol);
  }

  getTickSize(symbol: string): string {
    return this.symbolMap.get(symbol)?.tickSize ?? '0.01';
  }

  getStepSize(symbol: string): string {
    return this.symbolMap.get(symbol)?.stepSize ?? '0.001';
  }

  getMinNotional(symbol: string): number {
    return this.symbolMap.get(symbol)?.minNotional ?? 5;
  }

  getPricePrecision(symbol: string): number {
    return this.symbolMap.get(symbol)?.pricePrecision ?? 2;
  }

  getQuantityPrecision(symbol: string): number {
    return this.symbolMap.get(symbol)?.quantityPrecision ?? 3;
  }
}
