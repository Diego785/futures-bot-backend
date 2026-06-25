import { Injectable } from '@nestjs/common';
import { BinanceRestService } from '../binance-rest.service';
import type {
  BinanceOrderResponse,
  BinanceAlgoOrderResponse,
  BinancePositionRisk,
  BinanceAccountBalance,
  BinanceUserTrade,
  BinanceExchangeInfoResponse,
  BinanceKlineRaw,
} from '../../common/interfaces/binance.interfaces';
import { parseKline } from '../../common/interfaces/binance.interfaces';
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
} from '../../exchange/interfaces/exchange.interfaces';

@Injectable()
export class BinanceExchangeAdapter extends IExchangeRest {
  readonly provider: ExchangeProvider = 'binance';

  constructor(private readonly rest: BinanceRestService) {
    super();
  }

  // ─── Time / public ──────────────────────────────────────────────────────

  getServerTime(): Promise<number> {
    return this.rest.getServerTime();
  }

  async getExchangeInfo(): Promise<ExchangeInfo> {
    const raw = await this.rest.getExchangeInfo();
    return mapExchangeInfo(raw);
  }

  async getKlines(
    symbol: string,
    interval: string,
    limit = 100,
    startTime?: number,
    endTime?: number,
  ): Promise<Candle[]> {
    const raws = await this.rest.getKlines(
      symbol,
      interval,
      limit,
      startTime,
      endTime,
    );
    return raws.map(parseKline);
  }

  // ─── Orders ─────────────────────────────────────────────────────────────

  async placeOrder(req: PlaceOrderRequest): Promise<OrderResult> {
    const params: Record<string, string> = {
      symbol: req.symbol,
      side: req.side,
      type: req.type,
      quantity: req.quantity,
    };
    if (req.positionSide) params.positionSide = req.positionSide;
    if (req.type === OrderType.LIMIT) {
      if (req.price) params.price = req.price;
      params.timeInForce = req.timeInForce ?? TimeInForce.GTC;
    }
    if (req.reduceOnly !== undefined) {
      params.reduceOnly = req.reduceOnly ? 'true' : 'false';
    }
    if (req.clientOrderId) params.newClientOrderId = req.clientOrderId;

    const raw = await this.rest.placeOrder(params);
    return mapOrderResult(raw);
  }

  async cancelOrder(symbol: string, clientOrderId: string): Promise<void> {
    await this.rest.cancelOrder(symbol, clientOrderId);
  }

  async cancelAllOpenOrders(symbol: string): Promise<void> {
    await this.rest.cancelAllOpenOrders(symbol);
  }

  // ─── Conditionals (SL/TP) — Binance uses /algoOrder ────────────────────

  placeStopLoss(req: ConditionalOrderRequest): Promise<ConditionalResult> {
    return this.placeConditional(req, 'STOP_MARKET');
  }

  placeTakeProfit(req: ConditionalOrderRequest): Promise<ConditionalResult> {
    return this.placeConditional(req, 'TAKE_PROFIT_MARKET');
  }

  // STOP_MARKET / TAKE_PROFIT_MARKET migraron (Binance, 2025-12-09) a la Algo Order API: van por POST
  // /fapi/v1/algoOrder con algoType=CONDITIONAL. El endpoint estándar /fapi/v1/order los RECHAZA (-4120).
  // Params CORRECTOS del algo (≠ del endpoint viejo): `type` (NO orderType) · `triggerPrice` (NO stopPrice)
  // · `clientAlgoId` (NO newClientOrderId). Se listan/cancelan vía /fapi/v1/openAlgoOrders + algoId.
  private async placeConditional(
    req: ConditionalOrderRequest,
    orderType: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET',
  ): Promise<ConditionalResult> {
    const params: Record<string, string> = {
      symbol: req.symbol,
      side: req.side,
      type: orderType,
      triggerPrice: req.triggerPrice,
      workingType: 'CONTRACT_PRICE',
    };
    // closePosition cierra TODA la posición al disparar (sin quantity): bracket OCO robusto — evita el
    // rechazo por suma de reduceOnly y auto-cancela la hermana al cerrar.
    if (req.closePosition) {
      params.closePosition = 'true';
    } else {
      params.quantity = req.quantity;
      if (req.reduceOnly !== undefined) {
        params.reduceOnly = req.reduceOnly ? 'true' : 'false';
      }
    }
    if (req.positionSide) params.positionSide = req.positionSide;
    if (req.clientOrderId) params.clientAlgoId = req.clientOrderId;

    const raw = await this.rest.placeAlgoOrder(params);
    return mapConditionalResult(raw);
  }

  async cancelConditional(_symbol: string, conditionalId: string): Promise<void> {
    await this.rest.cancelAlgoOrder(parseInt(conditionalId, 10));
  }

  async getOpenConditionals(symbol: string): Promise<ConditionalResult[]> {
    const raws = await this.rest.getOpenAlgoOrders(symbol);
    return raws.map(mapConditionalResult);
  }

  async cancelAllConditionals(symbol: string): Promise<void> {
    await this.rest.cancelAllAlgoOrders(symbol);
  }

  // ─── Account ────────────────────────────────────────────────────────────

  async getBalance(asset: string): Promise<Balance | null> {
    const balances = await this.rest.getAccountBalance();
    const found = balances.find((b) => b.asset === asset);
    if (!found) return null;
    return mapBalance(found);
  }

  async getPositions(symbol?: string): Promise<Position[]> {
    const raws = await this.rest.getPositionRisk(symbol);
    return raws.map(mapPosition);
  }

  async changeLeverage(symbol: string, leverage: number): Promise<void> {
    await this.rest.changeLeverage(symbol, leverage);
  }

  // ─── History / fees ─────────────────────────────────────────────────────

  async getUserTrades(symbol: string, limit = 50): Promise<UserTrade[]> {
    const raws = await this.rest.getUserTrades(symbol, limit);
    return raws.map(mapUserTrade);
  }

  async getIncome(filter: IncomeFilter): Promise<IncomeEntry[]> {
    const raws = await this.rest.getIncome(
      filter.symbol,
      filter.startTime,
      filter.endTime,
      filter.limit ?? 100,
    );
    return raws
      .filter(
        (r) =>
          !filter.incomeType ||
          mapIncomeType(r.incomeType) === filter.incomeType,
      )
      .map(
        (r): IncomeEntry => ({
          incomeType: mapIncomeType(r.incomeType),
          income: r.income,
          asset: r.asset,
          time: r.time,
          symbol: filter.symbol,
        }),
      );
  }

  // ─── Diagnostics ────────────────────────────────────────────────────────

  getUsedWeight(): number {
    return this.rest.getUsedWeight();
  }
}

// ─── Mapping helpers (Binance → neutral) ───────────────────────────────────

function mapOrderResult(raw: BinanceOrderResponse): OrderResult {
  return {
    orderId: String(raw.orderId),
    clientOrderId: raw.clientOrderId,
    symbol: raw.symbol,
    side: raw.side as OrderSide,
    positionSide: mapPositionSide(raw.positionSide),
    type: mapOrderType(raw.type),
    status: mapOrderStatus(raw.status),
    price: raw.price,
    origQty: raw.origQty,
    executedQty: raw.executedQty,
    avgPrice: raw.avgPrice,
    timeInForce: raw.timeInForce,
    updateTime: raw.updateTime,
  };
}

function mapConditionalResult(raw: BinanceAlgoOrderResponse): ConditionalResult {
  return {
    conditionalId: String(raw.algoId),
    clientOrderId: raw.clientAlgoId,
    symbol: raw.symbol,
    side: raw.side as OrderSide,
    positionSide: mapPositionSide(raw.positionSide ?? 'BOTH'),
    orderType:
      raw.orderType === 'TAKE_PROFIT_MARKET'
        ? OrderType.TAKE_PROFIT_MARKET
        : OrderType.STOP_MARKET,
    triggerPrice: raw.triggerPrice,
    quantity: raw.quantity ?? '0',
    status: mapConditionalStatus(raw.algoStatus),
    reduceOnly: false, // el raw no lo refleja; la decisión del caller se preserva
    createTime: raw.createTime,
  };
}

function mapPosition(raw: BinancePositionRisk): Position {
  return {
    symbol: raw.symbol,
    positionSide: mapPositionSide(raw.positionSide),
    positionAmt: raw.positionAmt,
    entryPrice: raw.entryPrice,
    markPrice: raw.markPrice,
    unrealizedPnl: raw.unRealizedProfit,
    liquidationPrice: raw.liquidationPrice,
    notional: raw.notional,
    initialMargin: raw.initialMargin,
    maintMargin: raw.maintMargin,
    leverage: raw.leverage,
    updateTime: raw.updateTime,
  };
}

function mapBalance(raw: BinanceAccountBalance): Balance {
  return {
    asset: raw.asset,
    balance: raw.balance,
    availableBalance: raw.availableBalance,
    crossWalletBalance: raw.crossWalletBalance,
    crossUnrealizedPnl: raw.crossUnPnl,
    updateTime: raw.updateTime,
  };
}

function mapUserTrade(raw: BinanceUserTrade): UserTrade {
  return {
    tradeId: String(raw.id),
    orderId: String(raw.orderId),
    symbol: raw.symbol,
    side: raw.side as OrderSide,
    price: raw.price,
    qty: raw.qty,
    realizedPnl: raw.realizedPnl,
    quoteQty: raw.quoteQty,
    commission: raw.commission,
    commissionAsset: raw.commissionAsset,
    time: raw.time,
    isMaker: raw.maker,
  };
}

function mapExchangeInfo(raw: BinanceExchangeInfoResponse): ExchangeInfo {
  return {
    symbols: raw.symbols.map((s) => {
      const priceFilter = s.filters.find((f) => f.filterType === 'PRICE_FILTER');
      const lotFilter = s.filters.find((f) => f.filterType === 'LOT_SIZE');
      const notionalFilter = s.filters.find(
        (f) => f.filterType === 'MIN_NOTIONAL',
      );
      return {
        symbol: s.symbol,
        baseAsset: s.baseAsset,
        quoteAsset: s.quoteAsset,
        pricePrecision: s.pricePrecision,
        quantityPrecision: s.quantityPrecision,
        tickSize: priceFilter?.tickSize ?? '0.01',
        stepSize: lotFilter?.stepSize ?? '0.001',
        minNotional: notionalFilter?.notional
          ? parseFloat(notionalFilter.notional)
          : 5,
        minQty: lotFilter?.minQty ?? '0.001',
        maxQty: lotFilter?.maxQty ?? '1000',
      };
    }),
    serverTime: Date.now(),
  };
}

function mapPositionSide(s: string): PositionSide {
  switch (s) {
    case 'LONG':
      return PositionSide.LONG;
    case 'SHORT':
      return PositionSide.SHORT;
    default:
      return PositionSide.BOTH;
  }
}

function mapOrderType(t: string): OrderType {
  switch (t) {
    case 'LIMIT':
      return OrderType.LIMIT;
    case 'MARKET':
      return OrderType.MARKET;
    case 'STOP_MARKET':
      return OrderType.STOP_MARKET;
    case 'TAKE_PROFIT_MARKET':
      return OrderType.TAKE_PROFIT_MARKET;
    default:
      return OrderType.MARKET;
  }
}

function mapOrderStatus(s: string): OrderStatus {
  switch (s) {
    case 'NEW':
      return OrderStatus.NEW;
    case 'PARTIALLY_FILLED':
      return OrderStatus.PARTIALLY_FILLED;
    case 'FILLED':
      return OrderStatus.FILLED;
    case 'CANCELED':
      return OrderStatus.CANCELED;
    case 'EXPIRED':
      return OrderStatus.EXPIRED;
    case 'REJECTED':
      return OrderStatus.REJECTED;
    default:
      return OrderStatus.NEW;
  }
}

function mapConditionalStatus(s: string): ConditionalStatus {
  switch (s) {
    case 'NEW':
      return ConditionalStatus.NEW;
    case 'TRIGGERING':
      return ConditionalStatus.TRIGGERING;
    case 'TRIGGERED':
      return ConditionalStatus.TRIGGERED;
    case 'FINISHED':
      return ConditionalStatus.FINISHED;
    case 'CANCELED':
      return ConditionalStatus.CANCELED;
    case 'EXPIRED':
      return ConditionalStatus.EXPIRED;
    case 'REJECTED':
      return ConditionalStatus.REJECTED;
    default:
      return ConditionalStatus.NEW;
  }
}

function mapIncomeType(s: string): IncomeType {
  switch (s) {
    case 'REALIZED_PNL':
      return IncomeType.REALIZED_PNL;
    case 'COMMISSION':
      return IncomeType.COMMISSION;
    case 'FUNDING_FEE':
      return IncomeType.FUNDING_FEE;
    case 'TRANSFER':
      return IncomeType.TRANSFER;
    default:
      return IncomeType.OTHER;
  }
}
