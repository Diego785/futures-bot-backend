import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { firstValueFrom } from 'rxjs';
import * as crypto from 'crypto';
import {
  IExchangeRest,
  OrderSide,
  PositionSide,
  OrderType,
  OrderStatus,
  ConditionalStatus,
  TimeInForce,
  IncomeType,
  type Candle,
  type ExchangeProvider,
  type PlaceOrderRequest,
  type ConditionalOrderRequest,
  type IncomeFilter,
  type OrderResult,
  type ConditionalResult,
  type Position,
  type Balance,
  type UserTrade,
  type IncomeEntry,
  type ExchangeInfo,
  type SymbolInfo,
} from '../exchange/interfaces/exchange.interfaces';

interface BybitResponse<T> {
  retCode: number;
  retMsg: string;
  result: T;
  time?: number;
}

interface BybitKlineRow {
  // Bybit V5 returns rows as string arrays:
  // [startTime, open, high, low, close, volume, turnover]
  0: string;
  1: string;
  2: string;
  3: string;
  4: string;
  5: string;
  6: string;
}

@Injectable()
export class BybitRestService extends IExchangeRest implements OnModuleInit {
  private readonly logger = new Logger(BybitRestService.name);
  readonly provider: ExchangeProvider = 'bybit';

  private apiKey!: string;
  private apiSecret!: string;
  private baseUrl!: string;
  private recvWindow = '5000';
  private timeOffset = 0;

  constructor(
    private readonly httpService: HttpService,
    private readonly config: ConfigService,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    if (this.config.get<string>('EXCHANGE_PROVIDER') !== 'bybit') {
      // Bybit not selected — skip init to avoid demanding env vars that
      // aren't configured. The factory in ExchangeModule won't resolve to us.
      return;
    }
    this.apiKey = this.config.getOrThrow<string>('BYBIT_API_KEY');
    this.apiSecret = this.config.getOrThrow<string>('BYBIT_API_SECRET');
    this.baseUrl = this.config.get<string>('BYBIT_BASE_URL', 'https://api.bybit.com');
    await this.syncTime();
  }

  private async syncTime(): Promise<void> {
    try {
      const before = Date.now();
      const serverTime = await this.getServerTime();
      const latency = Math.floor((Date.now() - before) / 2);
      this.timeOffset = serverTime - Date.now() + latency;
      this.logger.log(`Time synced: offset=${this.timeOffset}ms latency=${latency}ms`);
    } catch {
      this.logger.warn('Failed to sync time with Bybit, using local time');
    }
  }

  // ─── Time / public ──────────────────────────────────────────────────────

  async getServerTime(): Promise<number> {
    const data = await this.publicRequest<{ timeSecond: string; timeNano: string }>(
      'GET',
      '/v5/market/time',
    );
    return parseInt(data.timeSecond, 10) * 1000;
  }

  async getExchangeInfo(): Promise<ExchangeInfo> {
    const data = await this.publicRequest<{ list: any[] }>(
      'GET',
      '/v5/market/instruments-info',
      { category: 'linear' },
    );
    const symbols: SymbolInfo[] = (data.list ?? []).map((s) => ({
      symbol: s.symbol,
      baseAsset: s.baseCoin,
      quoteAsset: s.quoteCoin,
      pricePrecision: getPrecisionFromTick(s.priceFilter?.tickSize ?? '0.01'),
      quantityPrecision: getPrecisionFromTick(s.lotSizeFilter?.qtyStep ?? '0.001'),
      tickSize: s.priceFilter?.tickSize ?? '0.01',
      stepSize: s.lotSizeFilter?.qtyStep ?? '0.001',
      minNotional: parseFloat(s.lotSizeFilter?.minNotionalValue ?? '5'),
      minQty: s.lotSizeFilter?.minOrderQty ?? '0.001',
      maxQty: s.lotSizeFilter?.maxOrderQty ?? '1000',
    }));
    return { symbols, serverTime: Date.now() };
  }

  async getKlines(
    symbol: string,
    interval: string,
    limit = 100,
    startTime?: number,
    endTime?: number,
  ): Promise<Candle[]> {
    const bybitInterval = mapInterval(interval);
    const params: Record<string, string> = {
      category: 'linear',
      symbol,
      interval: bybitInterval,
      limit: limit.toString(),
    };
    if (startTime !== undefined) params.start = startTime.toString();
    if (endTime !== undefined) params.end = endTime.toString();

    const data = await this.publicRequest<{ list: string[][] }>(
      'GET',
      '/v5/market/kline',
      params,
    );
    // Bybit returns klines DESCENDING (newest first). Reverse to ascending
    // so it matches Binance and downstream indicators expect old→new.
    const list = [...(data.list ?? [])].reverse();
    return list.map(parseBybitKline);
  }

  // ─── Orders ─────────────────────────────────────────────────────────────

  async placeOrder(req: PlaceOrderRequest): Promise<OrderResult> {
    const body: Record<string, any> = {
      category: 'linear',
      symbol: req.symbol,
      side: capitalize(req.side), // BUY → Buy, SELL → Sell
      orderType: req.type === OrderType.LIMIT ? 'Limit' : 'Market',
      qty: req.quantity,
      positionIdx: 0, // one-way mode
    };
    if (req.type === OrderType.LIMIT) {
      if (req.price) body.price = req.price;
      body.timeInForce = mapTimeInForce(req.timeInForce ?? TimeInForce.GTC);
    }
    if (req.reduceOnly) body.reduceOnly = true;
    if (req.clientOrderId) body.orderLinkId = req.clientOrderId;

    const result = await this.signedRequest<{ orderId: string; orderLinkId: string }>(
      'POST',
      '/v5/order/create',
      body,
    );

    // Bybit's create response is minimal — we synthesize an OrderResult that
    // matches the shape Binance returns. Status will be confirmed later via WS
    // or order history; for now mark as NEW (or assume FILLED for MARKET).
    return {
      orderId: result.orderId,
      clientOrderId: result.orderLinkId,
      symbol: req.symbol,
      side: req.side,
      positionSide: PositionSide.BOTH,
      type: req.type,
      status: req.type === OrderType.MARKET ? OrderStatus.FILLED : OrderStatus.NEW,
      price: req.price ?? '0',
      origQty: req.quantity,
      executedQty: req.type === OrderType.MARKET ? req.quantity : '0',
      avgPrice: '0',
      timeInForce: req.timeInForce ?? TimeInForce.GTC,
      updateTime: Date.now(),
    };
  }

  async cancelOrder(symbol: string, clientOrderId: string): Promise<void> {
    await this.signedRequest('POST', '/v5/order/cancel', {
      category: 'linear',
      symbol,
      orderLinkId: clientOrderId,
    });
  }

  async cancelAllOpenOrders(symbol: string): Promise<void> {
    await this.signedRequest('POST', '/v5/order/cancel-all', {
      category: 'linear',
      symbol,
      // orderFilter: 'Order' would skip conditional. Leaving default cancels both.
      orderFilter: 'Order',
    });
  }

  // ─── Conditionals (SL/TP) — Bybit uses triggerPrice on regular order ───

  placeStopLoss(req: ConditionalOrderRequest): Promise<ConditionalResult> {
    return this.placeConditional(req, 'STOP_LOSS');
  }

  placeTakeProfit(req: ConditionalOrderRequest): Promise<ConditionalResult> {
    return this.placeConditional(req, 'TAKE_PROFIT');
  }

  private async placeConditional(
    req: ConditionalOrderRequest,
    purpose: 'STOP_LOSS' | 'TAKE_PROFIT',
  ): Promise<ConditionalResult> {
    // Bybit V5 conditional logic:
    //   side=Sell on a LONG position closes it; side=Buy on a SHORT closes it.
    //   triggerDirection: 1 = Rising (price >= triggerPrice), 2 = Falling (price <= triggerPrice)
    //
    //   LONG SL  → side=Sell, trigger when price FALLS to X    → triggerDirection=2
    //   LONG TP  → side=Sell, trigger when price RISES to X    → triggerDirection=1
    //   SHORT SL → side=Buy,  trigger when price RISES to X    → triggerDirection=1
    //   SHORT TP → side=Buy,  trigger when price FALLS to X    → triggerDirection=2
    const isCloseOfLong = req.side === OrderSide.SELL;
    const isStopLoss = purpose === 'STOP_LOSS';
    const triggerDirection = isCloseOfLong
      ? isStopLoss
        ? 2
        : 1
      : isStopLoss
        ? 1
        : 2;

    const body: Record<string, any> = {
      category: 'linear',
      symbol: req.symbol,
      side: capitalize(req.side),
      orderType: 'Market',
      qty: req.quantity,
      triggerPrice: req.triggerPrice,
      triggerBy: 'LastPrice',
      triggerDirection,
      reduceOnly: req.reduceOnly !== false,
      positionIdx: 0,
    };
    if (req.clientOrderId) body.orderLinkId = req.clientOrderId;

    const result = await this.signedRequest<{ orderId: string; orderLinkId: string }>(
      'POST',
      '/v5/order/create',
      body,
    );

    return {
      conditionalId: result.orderId,
      clientOrderId: result.orderLinkId,
      symbol: req.symbol,
      side: req.side,
      positionSide: PositionSide.BOTH,
      orderType:
        purpose === 'STOP_LOSS'
          ? OrderType.STOP_MARKET
          : OrderType.TAKE_PROFIT_MARKET,
      triggerPrice: req.triggerPrice,
      quantity: req.quantity,
      status: ConditionalStatus.NEW,
      reduceOnly: req.reduceOnly !== false,
      createTime: Date.now(),
    };
  }

  async cancelConditional(symbol: string, conditionalId: string): Promise<void> {
    await this.signedRequest('POST', '/v5/order/cancel', {
      category: 'linear',
      symbol,
      orderId: conditionalId,
    });
  }

  async getOpenConditionals(symbol: string): Promise<ConditionalResult[]> {
    const data = await this.signedRequest<{ list: any[] }>(
      'GET',
      '/v5/order/realtime',
      { category: 'linear', symbol, orderFilter: 'StopOrder' },
    );
    return (data.list ?? []).map(
      (o): ConditionalResult => ({
        conditionalId: o.orderId,
        clientOrderId: o.orderLinkId ?? '',
        symbol: o.symbol,
        side: o.side?.toUpperCase() === 'BUY' ? OrderSide.BUY : OrderSide.SELL,
        positionSide: PositionSide.BOTH,
        orderType:
          o.stopOrderType === 'TakeProfit'
            ? OrderType.TAKE_PROFIT_MARKET
            : OrderType.STOP_MARKET,
        triggerPrice: o.triggerPrice ?? '0',
        quantity: o.qty ?? '0',
        status: mapBybitConditionalStatus(o.orderStatus),
        reduceOnly: !!o.reduceOnly,
        createTime: parseInt(o.createdTime ?? '0', 10),
      }),
    );
  }

  async cancelAllConditionals(symbol: string): Promise<void> {
    await this.signedRequest('POST', '/v5/order/cancel-all', {
      category: 'linear',
      symbol,
      orderFilter: 'StopOrder',
    });
  }

  // ─── Account ────────────────────────────────────────────────────────────

  async getBalance(asset: string): Promise<Balance | null> {
    const data = await this.signedRequest<{ list: any[] }>(
      'GET',
      '/v5/account/wallet-balance',
      { accountType: 'UNIFIED', coin: asset },
    );
    const account = data.list?.[0];
    if (!account) return null;
    const coin = account.coin?.find((c: any) => c.coin === asset);
    if (!coin) return null;
    // Bybit V5 returns "" (empty string) instead of "0" for fresh wallets,
    // and `??` only catches null/undefined. Normalize through numericString().
    const walletBalance = numericString(coin.walletBalance);
    const equity = numericString(coin.equity, walletBalance);
    return {
      asset,
      balance: walletBalance,
      availableBalance: numericString(coin.availableToWithdraw, walletBalance),
      crossWalletBalance: equity,
      crossUnrealizedPnl: numericString(coin.unrealisedPnl),
      updateTime: Date.now(),
    };
  }

  async getPositions(symbol?: string): Promise<Position[]> {
    const params: Record<string, string> = { category: 'linear' };
    if (symbol) params.symbol = symbol;
    else params.settleCoin = 'USDT';

    const data = await this.signedRequest<{ list: any[] }>(
      'GET',
      '/v5/position/list',
      params,
    );
    return (data.list ?? []).map(
      (p): Position => ({
        symbol: p.symbol,
        positionSide: mapBybitSide(p.side),
        // Bybit returns size unsigned — sign it based on side for parity with Binance.
        positionAmt: signedSize(p.size ?? '0', p.side),
        entryPrice: p.avgPrice ?? '0',
        markPrice: p.markPrice ?? '0',
        unrealizedPnl: p.unrealisedPnl ?? '0',
        liquidationPrice: p.liqPrice ?? '0',
        notional: p.positionValue ?? '0',
        initialMargin: p.positionIM ?? '0',
        maintMargin: p.positionMM ?? '0',
        leverage: p.leverage ?? '1',
        updateTime: parseInt(p.updatedTime ?? '0', 10),
      }),
    );
  }

  async changeLeverage(symbol: string, leverage: number): Promise<void> {
    try {
      await this.signedRequest('POST', '/v5/position/set-leverage', {
        category: 'linear',
        symbol,
        buyLeverage: leverage.toString(),
        sellLeverage: leverage.toString(),
      });
    } catch (err: any) {
      // Bybit returns retCode 110043 ("leverage not modified") if the leverage
      // is already what we asked for. Treat as success.
      const code = err?.response?.data?.retCode;
      if (code === 110043) return;
      throw err;
    }
  }

  // ─── History / fees ─────────────────────────────────────────────────────

  async getUserTrades(symbol: string, limit = 50): Promise<UserTrade[]> {
    const data = await this.signedRequest<{ list: any[] }>(
      'GET',
      '/v5/execution/list',
      { category: 'linear', symbol, limit: limit.toString() },
    );
    return (data.list ?? []).map(
      (e): UserTrade => ({
        tradeId: e.execId,
        orderId: e.orderId,
        symbol: e.symbol,
        side: e.side?.toUpperCase() === 'BUY' ? OrderSide.BUY : OrderSide.SELL,
        price: e.execPrice ?? '0',
        qty: e.execQty ?? '0',
        realizedPnl: e.closedPnl ?? '0',
        quoteQty: e.execValue ?? '0',
        commission: e.execFee ?? '0',
        commissionAsset: e.feeCurrency ?? 'USDT',
        time: parseInt(e.execTime ?? '0', 10),
        isMaker: e.isMaker === true || e.isMaker === 'true',
      }),
    );
  }

  async getIncome(filter: IncomeFilter): Promise<IncomeEntry[]> {
    const params: Record<string, string> = {
      accountType: 'UNIFIED',
      category: 'linear',
      symbol: filter.symbol,
      startTime: filter.startTime.toString(),
      limit: (filter.limit ?? 100).toString(),
    };
    if (filter.endTime) params.endTime = filter.endTime.toString();

    const data = await this.signedRequest<{ list: any[] }>(
      'GET',
      '/v5/account/transaction-log',
      params,
    );

    return (data.list ?? [])
      .map((entry): IncomeEntry => {
        const incomeType = mapBybitIncomeType(entry.type);
        return {
          incomeType,
          income: entry.change ?? '0',
          asset: entry.currency ?? 'USDT',
          time: parseInt(entry.transactionTime ?? '0', 10),
          symbol: entry.symbol ?? filter.symbol,
          tradeId: entry.tradeId,
        };
      })
      .filter((e) => !filter.incomeType || e.incomeType === filter.incomeType);
  }

  // ─── Diagnostics ────────────────────────────────────────────────────────

  getUsedWeight(): number {
    // Bybit doesn't expose a single weight counter via headers like Binance.
    // Returning 0 is acceptable — dashboard's "rateLimit" widget will read 0.
    return 0;
  }

  // ─── Private helpers ────────────────────────────────────────────────────

  private async publicRequest<T>(
    method: string,
    path: string,
    params: Record<string, string> = {},
  ): Promise<T> {
    const queryString = Object.keys(params).length
      ? '?' + new URLSearchParams(params).toString()
      : '';
    const url = `${this.baseUrl}${path}${queryString}`;
    const response = await firstValueFrom(
      this.httpService.request<BybitResponse<T>>({ method, url }),
    );
    return this.unwrap(response.data);
  }

  private async signedRequest<T>(
    method: string,
    path: string,
    params: Record<string, any> = {},
  ): Promise<T> {
    const timestamp = (Date.now() + this.timeOffset).toString();

    let signaturePayload: string;
    let url = `${this.baseUrl}${path}`;
    let body: string | undefined;

    if (method === 'GET' || method === 'DELETE') {
      const queryString = new URLSearchParams(
        Object.entries(params).map(([k, v]) => [k, String(v)]),
      ).toString();
      signaturePayload = `${timestamp}${this.apiKey}${this.recvWindow}${queryString}`;
      if (queryString) url += `?${queryString}`;
    } else {
      body = JSON.stringify(params);
      signaturePayload = `${timestamp}${this.apiKey}${this.recvWindow}${body}`;
    }

    const signature = crypto
      .createHmac('sha256', this.apiSecret)
      .update(signaturePayload)
      .digest('hex');

    const headers: Record<string, string> = {
      'X-BAPI-API-KEY': this.apiKey,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-SIGN': signature,
      'X-BAPI-RECV-WINDOW': this.recvWindow,
      'Content-Type': 'application/json',
    };

    const response = await firstValueFrom(
      this.httpService.request<BybitResponse<T>>({ method, url, data: body, headers }),
    );
    return this.unwrap(response.data);
  }

  private unwrap<T>(resp: BybitResponse<T>): T {
    if (resp.retCode !== 0) {
      const err: any = new Error(`Bybit API error ${resp.retCode}: ${resp.retMsg}`);
      err.response = { data: resp };
      throw err;
    }
    return resp.result;
  }
}

// ─── Mapping helpers ────────────────────────────────────────────────────────

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function mapTimeInForce(t: TimeInForce): string {
  switch (t) {
    case TimeInForce.GTC:
      return 'GTC';
    case TimeInForce.IOC:
      return 'IOC';
    case TimeInForce.FOK:
      return 'FOK';
    case TimeInForce.GTX:
      return 'PostOnly';
    default:
      return 'GTC';
  }
}

// Binance interval (e.g. '15m', '1h', '4h', '1d') → Bybit interval ('15', '60', '240', 'D')
function mapInterval(interval: string): string {
  const m = interval.match(/^(\d+)([mhdw])$/);
  if (!m) return interval;
  const n = m[1];
  const unit = m[2];
  switch (unit) {
    case 'm':
      return n;
    case 'h':
      return (parseInt(n, 10) * 60).toString();
    case 'd':
      return 'D';
    case 'w':
      return 'W';
    default:
      return interval;
  }
}

function parseBybitKline(row: string[]): Candle {
  // [startTime, open, high, low, close, volume, turnover]
  const openTime = parseInt(row[0], 10);
  return {
    openTime,
    open: parseFloat(row[1]),
    high: parseFloat(row[2]),
    low: parseFloat(row[3]),
    close: parseFloat(row[4]),
    volume: parseFloat(row[5]),
    closeTime: openTime, // Bybit doesn't return closeTime; downstream code uses openTime mainly
    quoteVolume: parseFloat(row[6] ?? '0'),
    trades: 0,
  };
}

function mapBybitSide(side: string): PositionSide {
  if (side === 'Buy') return PositionSide.LONG;
  if (side === 'Sell') return PositionSide.SHORT;
  return PositionSide.BOTH;
}

function signedSize(size: string, side: string): string {
  const n = parseFloat(size);
  if (!Number.isFinite(n) || n === 0) return '0';
  return side === 'Sell' ? (-n).toString() : n.toString();
}

function mapBybitConditionalStatus(s: string): ConditionalStatus {
  switch (s) {
    case 'New':
    case 'Untriggered':
      return ConditionalStatus.NEW;
    case 'Triggered':
      return ConditionalStatus.TRIGGERED;
    case 'Filled':
      return ConditionalStatus.FINISHED;
    case 'Cancelled':
    case 'Deactivated':
      return ConditionalStatus.CANCELED;
    case 'Rejected':
      return ConditionalStatus.REJECTED;
    default:
      return ConditionalStatus.NEW;
  }
}

function mapBybitIncomeType(t: string): IncomeType {
  switch (t) {
    case 'TRADE':
    case 'SETTLEMENT':
      return IncomeType.REALIZED_PNL;
    case 'FEE':
      return IncomeType.COMMISSION;
    case 'FUNDING':
      return IncomeType.FUNDING_FEE;
    case 'TRANSFER_IN':
    case 'TRANSFER_OUT':
      return IncomeType.TRANSFER;
    default:
      return IncomeType.OTHER;
  }
}

function getPrecisionFromTick(tick: string): number {
  const dot = tick.indexOf('.');
  if (dot === -1) return 0;
  return tick.length - dot - 1;
}

/**
 * Normalize Bybit's mixed responses (real numeric string, "", undefined, null)
 * to a parseable numeric string. Empty string and non-finite values fall back
 * to `fallback`, which itself defaults to '0'.
 */
function numericString(value: unknown, fallback: string = '0'): string {
  if (value === null || value === undefined) return fallback;
  const s = String(value).trim();
  if (s === '') return fallback;
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return fallback;
  return s;
}
