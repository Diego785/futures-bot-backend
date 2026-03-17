import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import { signQuery } from '../common/utils/hmac.util';
import { BINANCE_API } from '../common/constants/binance.constants';
import type {
  BinanceExchangeInfoResponse,
  BinanceKlineRaw,
  BinanceOrderResponse,
  BinanceAlgoOrderResponse,
  BinancePositionRisk,
  BinanceAccountBalance,
  BinanceUserTrade,
} from '../common/interfaces/binance.interfaces';

@Injectable()
export class BinanceRestService implements OnModuleInit {
  private readonly logger = new Logger(BinanceRestService.name);
  private apiKey: string;
  private apiSecret: string;
  private baseUrl: string;
  private usedWeight = 0;
  private timeOffset = 0;

  constructor(
    private readonly httpService: HttpService,
    private readonly config: ConfigService,
  ) {}

  async onModuleInit() {
    this.apiKey = this.config.getOrThrow<string>('BINANCE_API_KEY');
    this.apiSecret = this.config.getOrThrow<string>('BINANCE_API_SECRET');
    this.baseUrl = this.config.getOrThrow<string>('BINANCE_FUTURES_BASE_URL');
    await this.syncTime();
  }

  private async syncTime(): Promise<void> {
    try {
      const before = Date.now();
      const serverTime = await this.getServerTime();
      const latency = Math.floor((Date.now() - before) / 2);
      this.timeOffset = serverTime - Date.now() + latency;
      this.logger.log(`Time synced: offset=${this.timeOffset}ms latency=${latency}ms`);
    } catch (err) {
      this.logger.warn('Failed to sync time with Binance, using local time');
    }
  }

  // ─── Public endpoints (no signature) ───

  async getServerTime(): Promise<number> {
    const data = await this.publicRequest<{ serverTime: number }>(
      'GET',
      BINANCE_API.SERVER_TIME,
    );
    return data.serverTime;
  }

  async getExchangeInfo(): Promise<BinanceExchangeInfoResponse> {
    return this.publicRequest('GET', BINANCE_API.EXCHANGE_INFO);
  }

  async getKlines(
    symbol: string,
    interval: string,
    limit = 100,
  ): Promise<BinanceKlineRaw[]> {
    return this.publicRequest('GET', BINANCE_API.KLINES, {
      symbol,
      interval,
      limit: limit.toString(),
    });
  }

  // ─── Signed endpoints ───

  async placeOrder(
    params: Record<string, string>,
  ): Promise<BinanceOrderResponse> {
    return this.signedRequest('POST', BINANCE_API.ORDER, params);
  }

  async cancelOrder(
    symbol: string,
    origClientOrderId: string,
  ): Promise<BinanceOrderResponse> {
    return this.signedRequest('DELETE', BINANCE_API.ORDER, {
      symbol,
      origClientOrderId,
    });
  }

  async cancelAllOpenOrders(symbol: string): Promise<void> {
    await this.signedRequest('DELETE', BINANCE_API.ALL_OPEN_ORDERS, {
      symbol,
    });
  }

  // ─── Algo Order API (STOP_MARKET, TAKE_PROFIT_MARKET — migrated Dec 2025) ───

  async placeAlgoOrder(
    params: Record<string, string>,
  ): Promise<BinanceAlgoOrderResponse> {
    return this.signedRequest('POST', BINANCE_API.ALGO_ORDER, {
      algoType: 'CONDITIONAL',
      ...params,
    });
  }

  async cancelAlgoOrder(algoId: number): Promise<void> {
    await this.signedRequest('DELETE', BINANCE_API.ALGO_ORDER, {
      algoId: algoId.toString(),
    });
  }

  async getOpenAlgoOrders(symbol: string): Promise<BinanceAlgoOrderResponse[]> {
    return this.signedRequest('GET', BINANCE_API.ALGO_OPEN_ORDERS, {
      symbol,
    });
  }

  async cancelAllAlgoOrders(symbol: string): Promise<void> {
    try {
      const openAlgos = await this.getOpenAlgoOrders(symbol);
      for (const algo of openAlgos) {
        try {
          await this.cancelAlgoOrder(algo.algoId);
        } catch {
          // best-effort
        }
      }
    } catch {
      // no open algo orders
    }
  }

  async getUserTrades(
    symbol: string,
    limit = 50,
  ): Promise<BinanceUserTrade[]> {
    return this.signedRequest('GET', BINANCE_API.USER_TRADES, {
      symbol,
      limit: limit.toString(),
    });
  }

  async getPositionRisk(
    symbol?: string,
  ): Promise<BinancePositionRisk[]> {
    const params: Record<string, string> = {};
    if (symbol) params.symbol = symbol;
    return this.signedRequest('GET', BINANCE_API.POSITION_RISK, params);
  }

  async getAccountBalance(): Promise<BinanceAccountBalance[]> {
    return this.signedRequest('GET', BINANCE_API.ACCOUNT_BALANCE, {});
  }

  async changeLeverage(
    symbol: string,
    leverage: number,
  ): Promise<void> {
    await this.signedRequest('POST', BINANCE_API.CHANGE_LEVERAGE, {
      symbol,
      leverage: leverage.toString(),
    });
  }

  // ─── ListenKey (API key header only, no signature) ───

  async createListenKey(): Promise<string> {
    const data = await this.apiKeyRequest<{ listenKey: string }>(
      'POST',
      BINANCE_API.LISTEN_KEY,
    );
    return data.listenKey;
  }

  async keepaliveListenKey(): Promise<void> {
    await this.apiKeyRequest('PUT', BINANCE_API.LISTEN_KEY);
  }

  async deleteListenKey(): Promise<void> {
    await this.apiKeyRequest('DELETE', BINANCE_API.LISTEN_KEY);
  }

  // ─── Rate limit info ───

  getUsedWeight(): number {
    return this.usedWeight;
  }

  // ─── Private helpers ───

  private async signedRequest<T>(
    method: string,
    path: string,
    params: Record<string, string> = {},
  ): Promise<T> {
    const timestamp = (Date.now() + this.timeOffset).toString();
    const allParams = { ...params, timestamp, recvWindow: '5000' };

    const queryString = new URLSearchParams(
      Object.entries(allParams).map(([k, v]) => [k, v]),
    ).toString();

    const signature = signQuery(queryString, this.apiSecret);
    const url = `${this.baseUrl}${path}?${queryString}&signature=${signature}`;

    const response = await firstValueFrom(
      this.httpService.request<T>({
        method,
        url,
        headers: { 'X-MBX-APIKEY': this.apiKey },
      }),
    );

    this.trackRateLimit(response.headers);
    return response.data;
  }

  private async publicRequest<T>(
    method: string,
    path: string,
    params?: Record<string, string>,
  ): Promise<T> {
    const queryString = params
      ? '?' + new URLSearchParams(params).toString()
      : '';
    const url = `${this.baseUrl}${path}${queryString}`;

    const response = await firstValueFrom(
      this.httpService.request<T>({ method, url }),
    );

    this.trackRateLimit(response.headers);
    return response.data;
  }

  private async apiKeyRequest<T>(
    method: string,
    path: string,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await firstValueFrom(
      this.httpService.request<T>({
        method,
        url,
        headers: { 'X-MBX-APIKEY': this.apiKey },
      }),
    );
    return response.data;
  }

  private trackRateLimit(headers: Record<string, any>): void {
    const weight =
      headers['x-mbx-used-weight-1m'] || headers['X-MBX-USED-WEIGHT-1M'];
    if (weight) {
      this.usedWeight = parseInt(weight, 10);
      if (this.usedWeight > 1000) {
        this.logger.warn(
          `Binance rate limit warning: ${this.usedWeight}/1200 weight used`,
        );
      }
    }
  }
}
